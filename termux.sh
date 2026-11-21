#!/data/data/com.termux/files/usr/bin/bash
# Bluebird PG 旧手机服务器一键脚本（Termux + Ubuntu proot）
# 用法：在 Termux 里执行
#   curl -fsSL https://raw.githubusercontent.com/bluebird0212/pg-executor/main/termux.sh | bash
set -e

echo "== Bluebird PG 旧手机服务器 =="
echo "首次运行会安装 Ubuntu 和 Python 依赖，需要几百 MB 空间。"
echo

pkg install -y proot-distro curl

# 让 Termux 在后台保持运行
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
  trap 'termux-wake-unlock >/dev/null 2>&1 || true' EXIT
fi

proot-distro install ubuntu >/dev/null 2>&1 || true

proot-distro login ubuntu -- bash -lc '
set -e
if [ ! -x /root/pg-executor/.venv/bin/python ]; then
  echo "[1/3] 安装系统依赖..."
  apt update
  apt install -y python3 python3-venv python3-pip git ca-certificates
  echo "[2/3] 下载 Bluebird PG..."
  rm -rf /root/pg-executor
  git clone https://github.com/bluebird0212/pg-executor.git /root/pg-executor
  cd /root/pg-executor
  echo "[3/3] 安装 Python 依赖..."
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi
cd /root/pg-executor
echo
echo "服务已启动：http://0.0.0.0:8090"
echo "在另一台设备的 Bluebird PG 面板里填 http://这台手机的局域网IP:8090"
echo "不要关闭 Termux；按 Ctrl+C 停止。"
echo
exec env PG_HOST=0.0.0.0 .venv/bin/python server.py
'
