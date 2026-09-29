#!/bin/sh
# tabgate のポート転送用 native messaging host を Chrome（macOS）に登録する。
# 使い方: ./install.sh <拡張機能 ID>   （ID は chrome://extensions の tabgate に表示される）
set -eu
ID=${1:?usage: install.sh <extension id>}
DIR=$(cd "$(dirname "$0")" && pwd)
HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

chmod +x "$DIR/tabgate-forward.py"
mkdir -p "$HOSTS_DIR" "$HOME/.config/tabgate"
cat > "$HOSTS_DIR/com.tabgate.forward.json" <<EOF
{
  "name": "com.tabgate.forward",
  "description": "tabgate: SSH port forwarding",
  "path": "$DIR/tabgate-forward.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
EOF
[ -f "$HOME/.config/tabgate/forward-hosts" ] ||
  printf '# tabgate がポート転送してよい SSH ホスト（~/.ssh/config の名前を 1 行に 1 つ）\n' > "$HOME/.config/tabgate/forward-hosts"
echo "登録しました。転送を許可するホストを ~/.config/tabgate/forward-hosts に書いてください。"
