#!/usr/bin/env python3
"""テスト用の podman のふり。run は -v X:/work の X で sh -c を走らせ、kill は止める。"""
import os, signal, subprocess, sys
a = sys.argv[1:]
d = os.environ["FAKE_PODMAN_DIR"]
if a[0] == "run":
    name = a[a.index("--name") + 1]
    work = next(x.split(":/work")[0] for x in a if x.endswith(":/work:Z"))
    open(os.path.join(d, name + ".pid"), "w").write(str(os.getpid()))
    os.chdir(work)
    os.execvp("sh", ["sh", "-c", a[-1]])
elif a[0] == "kill":
    try:
        os.kill(int(open(os.path.join(d, a[1] + ".pid")).read()), signal.SIGTERM)
    except (OSError, ValueError):
        pass
