import http.client, io, json, os, socket, sys, tarfile, tempfile, threading, time, unittest
sys.path.insert(0, os.path.dirname(__file__))
os.environ["LOKA_PODMAN"] = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_podman.py")
import loka_runner as r


def make_tar(files, extra=()):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name, data in files.items():
            info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o644
            tf.addfile(info, io.BytesIO(data))
        for info in extra:
            tf.addfile(info)
    return buf.getvalue()


class UnixConn(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost"); self.path = path
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX); self.sock.connect(self.path)


class PureTest(unittest.TestCase):
    def test_host_allowlist(self):
        for h in ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "github.com", "codeload.github.com",
                  "objects.githubusercontent.com", "pkg.julialang.org", "storage.julialang.net", "julialang-s3.julialang.org", "jsr.io", "npm.jsr.io"]:
            self.assertTrue(r.host_allowed(h), h)
        for h in ["evil.com", "github.com.evil.com", "notgithub.com", "pypi.org.evil.io", "localhost", "169.254.169.254"]:
            self.assertFalse(r.host_allowed(h), h)

    def test_extract_refuses_unsafe_members(self):
        with tempfile.TemporaryDirectory() as d:
            bad = tarfile.TarInfo("link"); bad.type = tarfile.SYMTYPE; bad.linkname = "/etc/passwd"
            for name, tar in {"symlink": make_tar({}, [bad]), "dotdot": make_tar({"../x": b"1"}), "abs": make_tar({"/x": b"1"})}.items():
                p = os.path.join(d, name + ".tar"); open(p, "wb").write(tar)
                with self.assertRaises(ValueError, msg=name):
                    r.safe_extract(p, os.path.join(d, "out"))
            self.assertFalse(os.path.exists(os.path.join(d, "x")))

    def test_pack_leaves_out_links_and_tmp(self):
        with tempfile.TemporaryDirectory() as d:
            w = os.path.join(d, "w"); os.makedirs(os.path.join(w, ".loka-tmp"))
            open(os.path.join(w, "a.txt"), "w").write("a"); os.symlink("/etc/passwd", os.path.join(w, "l"))
            open(os.path.join(w, ".loka-tmp", "t"), "w").write("t")
            r.pack(w, os.path.join(d, "o.tar"))
            names = tarfile.open(os.path.join(d, "o.tar")).getnames()
            self.assertIn("./a.txt", names); self.assertNotIn("./l", names)
            self.assertFalse(any(".loka-tmp" in n for n in names))

    def test_podman_command_has_no_network_and_proxy_only_when_asked(self):
        none = r.podman_command("x", "/w", "none", "/p.sock", "true")
        self.assertIn("none", none[none.index("--network") + 1]); self.assertNotIn("/p.sock:/run/proxy.sock", none); self.assertNotIn("label=disable", none)
        reg = r.podman_command("x", "/w", "registries", "/p.sock", "true")
        self.assertIn("/p.sock:/run/proxy.sock", reg); self.assertIn("label=disable", reg); self.assertEqual(reg[reg.index("--network") + 1], "none")


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="lr", dir="/tmp")
        os.environ["FAKE_PODMAN_DIR"] = cls.tmp
        cls.jobs = r.Jobs(os.path.join(cls.tmp, "jobs"), os.path.join(cls.tmp, "proxy.sock"))
        cls.api = os.path.join(cls.tmp, "api.sock")
        cls.srv = r.UnixHTTPServer(cls.api, r.make_handler(cls.jobs))
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        threading.Thread(target=r.run_proxy, args=(cls.jobs.proxy_sock,), daemon=True).start()
        time.sleep(0.5)

    def call(self, method, path, body=None):
        c = UnixConn(self.api); c.request(method, path, body=body); resp = c.getresponse()
        out = (resp.status, resp.read()); c.close()
        return out

    def wait(self, jid):
        for _ in range(100):
            st, b = self.call("GET", "/jobs/" + jid); m = json.loads(b)
            if m["state"] != "running": return m
            time.sleep(0.1)
        self.fail("終わらない")

    def test_run_collect_result_and_delete(self):
        st, b = self.call("POST", "/jobs?minutes=1&network=none&cmd=" + "echo%20hi%3B%20cat%20a.txt%20%3E%20b.txt", make_tar({"a.txt": b"A"}))
        self.assertEqual(st, 200, b); jid = json.loads(b)["id"]
        m = self.wait(jid); self.assertEqual(m["state"], "done"); self.assertEqual(m["exit_status"], 0)
        self.assertEqual(self.call("GET", "/jobs/%s/log?since=0" % jid)[1], b"hi\n")
        self.assertEqual(self.call("GET", "/jobs/%s/log?since=1" % jid)[1], b"i\n")
        st, tar = self.call("GET", "/jobs/%s/result" % jid)
        tf = tarfile.open(fileobj=io.BytesIO(tar)); self.assertEqual(tf.extractfile("./b.txt").read(), b"A")
        self.assertEqual(self.call("DELETE", "/jobs/" + jid)[0], 200)
        self.assertEqual(self.call("GET", "/jobs/" + jid)[0], 404)

    def test_failed_and_stopped(self):
        jid = json.loads(self.call("POST", "/jobs?cmd=exit%203", make_tar({}))[1])["id"]
        m = self.wait(jid); self.assertEqual((m["state"], m["exit_status"]), ("failed", 3))
        jid = json.loads(self.call("POST", "/jobs?cmd=sleep%2060", make_tar({}))[1])["id"]
        time.sleep(0.5); self.assertTrue(json.loads(self.call("POST", "/jobs/%s/stop" % jid)[1])["stopped"])
        self.assertEqual(self.wait(jid)["state"], "stopped")

    def test_bad_requests(self):
        self.assertEqual(self.call("POST", "/jobs?cmd=true&minutes=999", make_tar({}))[0], 400)
        self.assertEqual(self.call("POST", "/jobs?cmd=true&network=open", make_tar({}))[0], 400)
        self.assertEqual(self.call("POST", "/jobs?cmd=true", make_tar({"../x": b"1"}))[0], 409)
        self.assertEqual(self.call("GET", "/jobs/..%2Fetc")[0], 404)

    def test_memory_choice_and_total_cap(self):
        self.assertEqual(self.call("POST", "/jobs?cmd=true&memory=64g", make_tar({}))[0], 400)
        a = json.loads(self.call("POST", "/jobs?cmd=sleep%2030&memory=2g", make_tar({}))[1])["id"]
        self.assertEqual(self.call("POST", "/jobs?cmd=sleep%2030&memory=2g", make_tar({}))[0], 409)  # 2+2 > 3
        b = json.loads(self.call("POST", "/jobs?cmd=sleep%2030&memory=1g", make_tar({}))[1])["id"]  # 2+1 = 3
        for j in (a, b):
            self.call("POST", "/jobs/%s/stop" % j); self.wait(j)

    def test_proxy_denies_unlisted_hosts_and_ports(self):
        for target in ["evil.example:443", "github.com:80", "127.0.0.1:443"]:
            s = socket.socket(socket.AF_UNIX); s.connect(self.jobs.proxy_sock)
            s.sendall(("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n" % (target, target)).encode())
            self.assertIn(b"403", s.recv(100), target); s.close()


if __name__ == "__main__":
    unittest.main()
