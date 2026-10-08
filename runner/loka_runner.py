#!/usr/bin/env python3
"""loka runner。ジョブを rootless Podman の箱で走らせる、ホスト側の小さな窓口。

専用ユーザー(lokarun)で動き、Unix ソケットだけで話す。world のコンテナには
Docker のソケットを渡さず、できるのは次の五つだけ:

  POST /jobs?minutes=&network=   body=tar   project を受け取って走らせる -> {id}
  GET  /jobs/<id>                            状態
  GET  /jobs/<id>/log?since=N                出力のつづき(バイト)
  GET  /jobs/<id>/result                     走ったあとの directory(tar)
  POST /jobs/<id>/stop                       止める
  DELETE /jobs/<id>                          片づける

ジョブの箱にはネットワークを付けない。network=registries のときだけ、許可リストつきの
プロキシ(proxy.sock)を箱の中へ繋ぐ。許可した行き先以外へは、出る道そのものが無い。
標準ライブラリだけ(Python 3.9 以上)。
"""
import asyncio
import http.server
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import tarfile
import threading
import time
from urllib.parse import parse_qs, urlparse

RUN_DIR = os.environ.get("LOKA_RUNNER_RUN", "/run/loka-runner")
DATA_DIR = os.environ.get("LOKA_RUNNER_DATA", os.path.expanduser("~/jobs"))
IMAGE = os.environ.get("LOKA_RUNNER_IMAGE", "loka-job")
PODMAN = os.environ.get("LOKA_PODMAN", "podman")
API_GID = int(os.environ.get("LOKA_RUNNER_GID", "-1"))
MAX_RUNNING = 2
MEMORY_GB = {"1g": 1, "2g": 2}   # ジョブごとに選べる。走っている合計は MAX_MEMORY_GB まで
MAX_MEMORY_GB = 3
MAX_TAR = 256 * 1024 * 1024
LOG_MAX = 8 * 1024 * 1024
MAX_MINUTES = 240
JOB_ID = re.compile(r"\A\d{8}-\d{6}-[0-9a-f]{4}\Z")

# 依存を取りに行ってよい先(registries のときだけ、プロキシ越しに)
ALLOWED_SUFFIXES = (
    "npmjs.org",                                  # npm
    "pypi.org", "pythonhosted.org",               # PyPI
    "github.com", "githubusercontent.com",        # GitHub
    "julialang.org", "julialang.net",             # Julia (pkg.julialang.org → storage.julialang.net …)
    "jsr.io",                                     # JSR (jsr.io, npm.jsr.io)
)


def host_allowed(host):
    host = host.lower().rstrip(".")
    return any(host == s or host.endswith("." + s) for s in ALLOWED_SUFFIXES)


def safe_name(name):
    parts = name.split("/")
    return not (name.startswith("/") or "\0" in name or any(p == ".." for p in parts))


def safe_extract(tar_path, dest, max_bytes=MAX_TAR):
    """通常のファイルと directory だけを、dest の下へ。symlink・device などは断る。"""
    total = 0
    with tarfile.open(tar_path) as tf:
        members = tf.getmembers()
        for m in members:
            if not safe_name(m.name):
                raise ValueError("道の形が不正: %r" % m.name)
            if not (m.isreg() or m.isdir()):
                raise ValueError("通常のファイルと directory だけ: %r" % m.name)
            total += m.size
            if total > max_bytes:
                raise ValueError("大きすぎる")
        for m in members:
            m.uid = m.gid = 0
            m.uname = m.gname = ""
            m.mode = (m.mode | 0o700) if m.isdir() else (m.mode | 0o600)
            tf.extract(m, dest)


def pack(work, out_path, max_bytes=MAX_TAR):
    """走ったあとの directory を tar に。通常のファイルと directory だけ。"""
    total = 0

    def keep(info):
        nonlocal total
        if not (info.isreg() or info.isdir()):
            return None
        if info.name.split("/")[0:2] == [".", ".loka-tmp"]:
            return None
        total += info.size
        if total > max_bytes:
            raise ValueError("結果が大きすぎる")
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        return info

    with tarfile.open(out_path, "w") as tf:
        tf.add(work, arcname=".", filter=keep)


def cpu_limit_available():
    """ユーザーの cgroup に cpu コントローラーが渡されているか(install.sh が渡す)。"""
    uid = os.getuid()
    try:
        path = "/sys/fs/cgroup/user.slice/user-%d.slice/user@%d.service/cgroup.controllers" % (uid, uid)
        with open(path) as f:
            return "cpu" in f.read().split()
    except OSError:
        return False


def podman_command(job_id, work, network, proxy_sock, cmd, memory="1g", cpus=None):
    # 渡されていなければ --cpus は付けられない。かわりに優先度を下げて、本番の邪魔をしない。
    args = ["nice", "-n", "10", PODMAN, "run", "--rm", "--name", "loka-" + job_id,
        "--network", "none", "--userns=keep-id", "--cap-drop=all",
        "--security-opt", "no-new-privileges",
        "--memory", memory, "--memory-swap", memory, "--pids-limit", "512",
        "--read-only", "--tmpfs", "/tmp:rw,size=256m,mode=1777",
        "-v", work + ":/work:Z", "-w", "/work",
        "-e", "HOME=/work", "-e", "LANG=C.UTF-8", "-e", "CI=1", "-e", "NO_COLOR=1", "-e", "TERM=dumb",
        "-e", "TMPDIR=/tmp", "-e", "npm_config_cache=/tmp/npm", "-e", "PIP_CACHE_DIR=/tmp/pip",
        "-e", "XDG_CACHE_HOME=/tmp/cache", "-e", "JULIA_DEPOT_PATH=/work/.julia", "-e", "DENO_DIR=/work/.deno",
    ]
    if cpus:
        args += ["--cpus", cpus]
    if network == "registries":
        # SELinux は、container_t から runner(unconfined_service_t)のソケットへの接続を許さない。
        # このときだけ、箱の SELinux ラベル付けを外す。ほかの防御(userns・capability 全部落とす・
        # no-new-privileges・seccomp・読み取り専用の根・cgroup 上限)はそのまま。
        args += ["--security-opt", "label=disable", "-v", proxy_sock + ":/run/proxy.sock"]
    return args + [IMAGE, cmd]


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


class Jobs:
    def __init__(self, data_dir, proxy_sock):
        self.dir = data_dir
        self.proxy_sock = proxy_sock
        self.lock = threading.Lock()
        os.makedirs(self.dir, exist_ok=True)
        os.chmod(self.dir, 0o700)
        # 再起動の前に走っていたものは、行方が分からない
        for jid in os.listdir(self.dir):
            meta = self.meta(jid)
            if meta and meta.get("state") == "running":
                meta.update(state="lost", finished_at=now_iso())
                self.save(jid, meta)

    def path(self, jid, *more):
        if not JOB_ID.match(jid):
            raise KeyError(jid)
        return os.path.join(self.dir, jid, *more)

    def meta(self, jid):
        try:
            with open(self.path(jid, "meta.json"), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, KeyError, ValueError):
            return None

    def save(self, jid, meta):
        tmp = self.path(jid, "meta.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)
        os.replace(tmp, self.path(jid, "meta.json"))

    def running(self):
        return [j for j in os.listdir(self.dir) if (self.meta(j) or {}).get("state") == "running"]

    def start(self, body_path, cmd, minutes, network, memory="1g"):
        with self.lock:
            running = self.running()
            if len(running) >= MAX_RUNNING:
                raise RuntimeError("走っているジョブが%dつある" % MAX_RUNNING)
            used = sum(MEMORY_GB.get((self.meta(j) or {}).get("memory"), 1) for j in running)
            if used + MEMORY_GB[memory] > MAX_MEMORY_GB:
                raise RuntimeError("メモリの合計が%dGBを超える。終わるのを待つか、memory を小さく。" % MAX_MEMORY_GB)
            jid = time.strftime("%Y%m%d-%H%M%S-") + os.urandom(2).hex()
            os.makedirs(self.path(jid, "work"))
            meta = {"id": jid, "state": "running", "cmd": cmd, "network": network,
                    "minutes": minutes, "memory": memory, "started_at": now_iso()}
            self.save(jid, meta)
        try:
            os.replace(body_path, self.path(jid, "in.tar"))
            safe_extract(self.path(jid, "in.tar"), self.path(jid, "work"))
            os.remove(self.path(jid, "in.tar"))
        except Exception as e:
            meta.update(state="failed", error=str(e), finished_at=now_iso())
            self.save(jid, meta)
            raise
        threading.Thread(target=self.supervise, args=(jid, cmd, minutes, network, memory), daemon=True).start()
        return jid

    def supervise(self, jid, cmd, minutes, network, memory="1g"):
        meta = self.meta(jid)
        started = time.monotonic()
        argv = podman_command(jid, self.path(jid, "work"), network, self.proxy_sock, cmd, memory=memory,
                              cpus="1" if cpu_limit_available() else None)
        timed_out = False
        written = 0
        try:
            proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT)
        except OSError as e:
            meta.update(state="failed", error="起動できない: %s" % e, finished_at=now_iso())
            self.save(jid, meta)
            return

        def kill():
            subprocess.run([PODMAN, "kill", "loka-" + jid], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)

        timer = threading.Timer(minutes * 60, lambda: (meta.__setitem__("_timeout", True), kill()))
        timer.start()
        with open(self.path(jid, "out.log"), "ab", buffering=0) as log:
            while True:
                chunk = proc.stdout.read1(16 * 1024)
                if not chunk:
                    break
                room = LOG_MAX - written
                if room > 0:
                    log.write(chunk[:room])
                    written += min(len(chunk), room)
                    if written >= LOG_MAX:
                        log.write("\n…(出力が多いので、ここから先は残さない)\n".encode())
        rc = proc.wait()
        timer.cancel()
        timed_out = bool(meta.pop("_timeout", False))
        stopped = os.path.exists(self.path(jid, "stop"))
        state = "stopped" if stopped else "timed_out" if timed_out else "done" if rc == 0 else "failed"
        try:
            pack(self.path(jid, "work"), self.path(jid, "result.tar"))
        except Exception as e:  # 結果が大きすぎるなど
            state, meta["error"] = "failed", "結果をまとめられない: %s" % e
        meta.update(state=state, exit_status=rc, took=round(time.monotonic() - started, 1),
                    finished_at=now_iso())
        self.save(jid, meta)

    def stop(self, jid):
        meta = self.meta(jid)
        if not meta:
            raise KeyError(jid)
        if meta["state"] != "running":
            return {"id": jid, "stopped": False}
        open(self.path(jid, "stop"), "w").close()
        subprocess.run([PODMAN, "kill", "loka-" + jid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"id": jid, "stopped": True}

    def delete(self, jid):
        meta = self.meta(jid)
        if not meta:
            raise KeyError(jid)
        if meta["state"] == "running":
            raise RuntimeError("走っている")
        shutil.rmtree(self.path(jid), ignore_errors=True)

    def gc(self, max_age=24 * 3600):
        for jid in os.listdir(self.dir):
            meta = self.meta(jid)
            if meta and meta["state"] != "running" and time.time() - os.path.getmtime(self.path(jid)) > max_age:
                shutil.rmtree(self.path(jid), ignore_errors=True)


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def make_handler(jobs):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def address_string(self):
            return "unix"

        def log_message(self, fmt, *args):
            sys.stderr.write("api %s\n" % (fmt % args))

        def reply(self, code, obj=None, raw=None, ctype="application/json"):
            body = raw if raw is not None else json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def route(self):
            u = urlparse(self.path)
            return [p for p in u.path.split("/") if p], parse_qs(u.query)

        def do_POST(self):
            parts, q = self.route()
            try:
                if parts == ["jobs"]:
                    n = int(self.headers.get("Content-Length", "0"))
                    if n <= 0 or n > MAX_TAR:
                        return self.reply(400, {"error": "body(tar)の大きさが不正"})
                    tmp = os.path.join(jobs.dir, "upload-%s.tar" % os.urandom(4).hex())
                    with open(tmp, "wb") as f:
                        left = n
                        while left:
                            buf = self.rfile.read(min(left, 1 << 20))
                            if not buf:
                                break
                            f.write(buf)
                            left -= len(buf)
                    cmd = q.get("cmd", [""])[0]
                    minutes = int(q.get("minutes", ["30"])[0])
                    network = q.get("network", ["none"])[0]
                    memory = q.get("memory", ["1g"])[0]
                    if not cmd or len(cmd) > 16 * 1024 or not 1 <= minutes <= MAX_MINUTES \
                            or network not in ("none", "registries") or memory not in MEMORY_GB:
                        os.remove(tmp)
                        return self.reply(400, {"error": "cmd / minutes / network / memory が不正"})
                    try:
                        return self.reply(200, {"id": jobs.start(tmp, cmd, minutes, network, memory)})
                    finally:
                        if os.path.exists(tmp):
                            os.remove(tmp)
                if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "stop":
                    return self.reply(200, jobs.stop(parts[1]))
                return self.reply(404, {"error": "not found"})
            except KeyError:
                return self.reply(404, {"error": "そのジョブは無い"})
            except (RuntimeError, ValueError) as e:
                return self.reply(409, {"error": str(e)})

        def do_GET(self):
            parts, q = self.route()
            try:
                if len(parts) == 2 and parts[0] == "jobs":
                    meta = jobs.meta(parts[1])
                    if not meta:
                        raise KeyError
                    size = os.path.getsize(jobs.path(parts[1], "out.log")) if os.path.exists(jobs.path(parts[1], "out.log")) else 0
                    return self.reply(200, dict(meta, log_bytes=size))
                if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "log":
                    since = int(q.get("since", ["0"])[0])
                    p = jobs.path(parts[1], "out.log")
                    data = b""
                    if os.path.exists(p):
                        with open(p, "rb") as f:
                            f.seek(since)
                            data = f.read(1 << 20)
                    return self.reply(200, raw=data, ctype="application/octet-stream")
                if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "result":
                    meta = jobs.meta(parts[1])
                    p = jobs.path(parts[1], "result.tar")
                    if not meta or meta["state"] == "running" or not os.path.exists(p):
                        return self.reply(409, {"error": "まだ結果が無い"})
                    self.send_response(200)
                    self.send_header("Content-Type", "application/x-tar")
                    self.send_header("Content-Length", str(os.path.getsize(p)))
                    self.end_headers()
                    with open(p, "rb") as f:
                        shutil.copyfileobj(f, self.wfile)
                    return
                if parts == ["jobs"]:
                    return self.reply(200, {"jobs": [jobs.meta(j) for j in sorted(os.listdir(jobs.dir)) if JOB_ID.match(j)]})
                return self.reply(404, {"error": "not found"})
            except KeyError:
                return self.reply(404, {"error": "そのジョブは無い"})

        def do_DELETE(self):
            parts, _ = self.route()
            try:
                if len(parts) == 2 and parts[0] == "jobs":
                    jobs.delete(parts[1])
                    return self.reply(200, {"deleted": True})
                return self.reply(404, {"error": "not found"})
            except KeyError:
                return self.reply(404, {"error": "そのジョブは無い"})
            except RuntimeError as e:
                return self.reply(409, {"error": str(e)})

    return Handler


# ── 許可リストつきプロキシ(HTTPS の CONNECT だけ) ─────────────────────────

async def _pipe(reader, writer):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), timeout=300)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def handle_proxy(reader, writer):
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=15)
        line = head.split(b"\r\n", 1)[0].decode("latin-1")
        method, target, _ = line.split(" ", 2)
        if method != "CONNECT":
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        host, _, port = target.rpartition(":")
        if port != "443" or not host_allowed(host):
            sys.stderr.write("proxy deny %s\n" % target)
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        loop = asyncio.get_running_loop()
        infos = await loop.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        addrs = [i[4][0] for i in infos]
        if not addrs or not all(ipaddress.ip_address(a).is_global for a in addrs):
            sys.stderr.write("proxy deny (non-global) %s\n" % target)
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        up_r, up_w = await asyncio.wait_for(asyncio.open_connection(addrs[0], 443), timeout=15)
        writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await writer.drain()
        await asyncio.gather(_pipe(reader, up_w), _pipe(up_r, writer))
    except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError,
            ValueError, OSError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


def run_proxy(path):
    async def main():
        if os.path.exists(path):
            os.remove(path)
        server = await asyncio.start_unix_server(handle_proxy, path=path)
        os.chmod(path, 0o600)
        async with server:
            await server.serve_forever()
    asyncio.run(main())


def main():
    os.makedirs(RUN_DIR, exist_ok=True)
    proxy_sock = os.path.join(RUN_DIR, "proxy.sock")
    api_sock = os.path.join(RUN_DIR, "api.sock")
    jobs = Jobs(DATA_DIR, proxy_sock)
    threading.Thread(target=run_proxy, args=(proxy_sock,), daemon=True).start()
    if os.path.exists(api_sock):
        os.remove(api_sock)
    server = UnixHTTPServer(api_sock, make_handler(jobs))
    os.chmod(api_sock, 0o660)
    if API_GID >= 0:
        os.chown(api_sock, -1, API_GID)
        os.chown(RUN_DIR, -1, API_GID)
        os.chmod(RUN_DIR, 0o750)

    def tick():
        while True:
            time.sleep(3600)
            jobs.gc()
    threading.Thread(target=tick, daemon=True).start()

    def on_term(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, on_term)
    sys.stderr.write("loka-runner: %s\n" % api_sock)
    server.serve_forever()


if __name__ == "__main__":
    main()
