#!/usr/bin/env python3
"""tabgate の native messaging host: ブラウザの PC から SSH 先への `ssh -L` ポート転送を開閉する。

拡張機能から {"op": "open"|"close"|"list", "host": str, "port": int} を 1 通受け取り、1 通返して終わる。
転送できるのは ~/.config/tabgate/forward-hosts に書かれたホストだけ。転送は 127.0.0.1 にだけ開く。
"""
import json
import os
import re
import struct
import subprocess
import sys
import tempfile

CONF = os.path.expanduser("~/.config/tabgate/forward-hosts")
SSH_OPTS = ["-f", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30"]
# 自分が張った転送だけを ps から見つけるための形
MINE = re.compile(r"^\s*(\d+)\s+ssh " + re.escape(" ".join(SSH_OPTS)) + r" -L 127\.0\.0\.1:(\d+):localhost:\d+ (\S+)$")


def allowed_hosts():
    if not os.path.exists(CONF):
        return []
    with open(CONF) as f:
        return [l.strip() for l in f if l.strip() and not l.lstrip().startswith("#")]


def forwards():
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    return [{"pid": int(m[1]), "port": int(m[2]), "host": m[3]} for m in map(MINE.match, out.splitlines()) if m]


def handle(msg):
    op = msg.get("op")
    if op == "list":
        return {"hosts": allowed_hosts(), "forwards": forwards()}
    host, port = msg.get("host"), msg.get("port")
    if host not in allowed_hosts():
        raise ValueError(f"host {host!r} は {CONF} に書かれていません（許可されたホスト: {allowed_hosts()}）")
    if not isinstance(port, int) or isinstance(port, bool) or not 1024 <= port <= 65535:
        raise ValueError("port は 1024〜65535 の整数にしてください")
    mine = [f for f in forwards() if f["host"] == host and f["port"] == port]
    url = f"http://localhost:{port}"
    if op == "close":
        for f in mine:
            os.kill(f["pid"], 15)
        return {"closed": len(mine)}
    if op == "open":
        if mine:
            return {"url": url, "already_open": True}
        # ssh -f は転送が張れてから裏に回る。裏の ssh が stderr を握り続けるので pipe ではなく一時ファイルで受ける
        with tempfile.TemporaryFile() as err:
            r = subprocess.run(["ssh", *SSH_OPTS, "-L", f"127.0.0.1:{port}:localhost:{port}", host],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err, timeout=30)
            if r.returncode:
                err.seek(0)
                raise RuntimeError(err.read().decode(errors="replace").strip() or f"ssh exited with {r.returncode}")
        return {"url": url}
    raise ValueError(f"unknown op {op!r}")


def main():
    n = struct.unpack("<I", sys.stdin.buffer.read(4))[0]
    msg = json.loads(sys.stdin.buffer.read(n))
    try:
        res = {"ok": True, "result": handle(msg)}
    except Exception as e:  # エラーは拡張機能経由でエージェントに返す
        res = {"ok": False, "error": str(e)}
    data = json.dumps(res).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
