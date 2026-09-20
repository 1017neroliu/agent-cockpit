#!/usr/bin/env bash
# agent-cockpit 安装器
# 用法: ./install.sh [--uninstall]
set -u
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

if [ "${1:-}" = "--uninstall" ]; then
    rm -f "$HOME/.local/bin/agent-cockpit"
    bash "$SRC_DIR/bin/agent-cockpit" stop 2>/dev/null
    echo "✅ agent-cockpit 已卸载"
    exit 0
fi

[ "$OS" = "Linux" ] || [ "$OS" = "Darwin" ] || { echo "❌ Windows 暂不支持,请手动运行 server/server.js"; exit 1; }

# 完整安装到 ~/.agent-cockpit(启动器固定指向这里,避免 ~/.local/bin 副本路径错乱)
rm -rf "$HOME/.agent-cockpit"
mkdir -p "$HOME/.agent-cockpit"
cp -r "$SRC_DIR/bin" "$SRC_DIR/server" "$SRC_DIR/web" "$HOME/.agent-cockpit/"

mkdir -p "$HOME/.local/bin"
cp "$SRC_DIR/bin/agent-cockpit" "$HOME/.local/bin/agent-cockpit"
chmod +x "$HOME/.local/bin/agent-cockpit"
case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "⚠️  ~/.local/bin 不在 PATH 里" ;;
esac
echo "✅ 安装完成!运行: agent-cockpit"
