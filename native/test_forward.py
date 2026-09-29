# tabgate-forward.py の入力検証を確認する（ssh は実行しない）。 python3 native/test_forward.py
import json
import os
import struct
import subprocess
import sys
import tempfile

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tabgate-forward.py")


def call(msg, home):
    data = json.dumps(msg).encode()
    r = subprocess.run([sys.executable, HOST], input=struct.pack("<I", len(data)) + data, capture_output=True, env={**os.environ, "HOME": home})
    return json.loads(r.stdout[4:])


with tempfile.TemporaryDirectory() as home:
    os.makedirs(f"{home}/.config/tabgate")
    with open(f"{home}/.config/tabgate/forward-hosts", "w") as f:
        f.write("# comment\nokhost\n")
    assert call({"op": "list"}, home)["result"]["hosts"] == ["okhost"]
    assert not call({"op": "open", "host": "evil", "port": 5173}, home)["ok"], "許可リスト外のホスト"
    assert not call({"op": "open", "host": "-oProxyCommand=touch /tmp/x", "port": 5173}, home)["ok"], "オプション差し込み"
    assert not call({"op": "open", "host": "okhost", "port": 22}, home)["ok"], "1024 未満のポート"
    assert not call({"op": "open", "host": "okhost", "port": "5173"}, home)["ok"], "文字列のポート"
    assert not call({"op": "open", "host": "okhost", "port": True}, home)["ok"], "bool のポート"
    assert not call({"op": "rm", "host": "okhost", "port": 5173}, home)["ok"], "未知の op"
print("ok")
