#!/data/data/com.termux/files/usr/bin/bash
# Bluebird PG 旧手机一键部署脚本（Termux）
# 用法：pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/bluebird0212/pg-executor/main/termux.sh | bash
#
# 说明：
#   - 不使用 proot-distro 的 OCI 镜像（Docker Hub 在国内经常连不上）
#   - 直接下载清华 TUNA 的 Ubuntu Base 24.04 arm64 rootfs，手动 proot 启动
#   - 所有镜像/软件源均使用国内可访问的地址
set -u

REPO="https://github.com/bluebird0212/pg-executor.git"
UBUNTU_DIR="$HOME/ubuntu"
ROOTFS_URL="https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cdimage/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.3-base-arm64.tar.gz"
PIP_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"

say() { echo -e "\n\033[1;36m[Bluebird PG]\033[0m $*"; }

say "1/8 安装 Termux 基础依赖"
pkg update -y >/dev/null 2>&1
pkg install -y proot tar curl git >/dev/null 2>&1 || {
  echo "Termux 依赖安装失败，请检查网络后重试。"
  exit 1
}

if [ ! -x "$UBUNTU_DIR/bin/bash" ]; then
  say "2/8 下载 Ubuntu Base 24.04（约 27MB）"
  mkdir -p "$UBUNTU_DIR"
  curl -fL --retry 3 -o "$HOME/ubuntu-base.tar.gz" "$ROOTFS_URL" || {
    echo "下载失败，请检查网络。"
    exit 1
  }

  say "3/8 解压 rootfs（会打印一些 Cannot hard link 提示，可忽略）"
  tar --hard-dereference -xzf "$HOME/ubuntu-base.tar.gz" -C "$UBUNTU_DIR" 2>/dev/null
  rm -f "$HOME/ubuntu-base.tar.gz"
else
  say "2/8 已存在 Ubuntu rootfs，跳过下载"
  say "3/8 跳过解压"
fi

say "4/8 配置国内 apt 源与 DNS"
mkdir -p "$UBUNTU_DIR/etc/apt/sources.list.d"
cat > "$UBUNTU_DIR/etc/apt/sources.list" <<'EOF'
deb http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports/ noble main restricted universe multiverse
deb http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports/ noble-updates main restricted universe multiverse
deb http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports/ noble-backports main restricted universe multiverse
deb http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports/ noble-security main restricted universe multiverse
EOF
rm -f "$UBUNTU_DIR/etc/apt/sources.list.d/ubuntu.sources"
cat > "$UBUNTU_DIR/etc/resolv.conf" <<'EOF'
nameserver 223.5.5.5
nameserver 8.8.8.8
EOF

say "5/8 安装 Python 运行环境（首次较慢，请耐心等待）"
cat > "$HOME/ubuntu-setup.sh" <<'EOF'
set -e
export DEBIAN_FRONTEND=noninteractive
apt -o APT::Sandbox::User=root -o Acquire::ForceIPv4=true update
apt -o APT::Sandbox::User=root -o Acquire::ForceIPv4=true install -y \
  python3 python3-venv python3-pip git ca-certificates
EOF

proot --link2symlink -0 -r "$UBUNTU_DIR" -b /dev -b /proc -b /sys -b /data/local/tmp:/hosttmp -b "$HOME:/root" -w /root \
  /usr/bin/env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TERM=xterm LANG=C.UTF-8 \
  /bin/bash /hosttmp/ubuntu-setup.sh || {
  echo "Ubuntu 内 apt 安装失败，请检查网络后重试。"
  exit 1
}

say "6/8 获取 Bluebird PG 源码"
proot --link2symlink -0 -r "$UBUNTU_DIR" -b /dev -b /proc -b /sys -b /data/local/tmp:/hosttmp -b "$HOME:/root" -w /root \
  /usr/bin/env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TERM=xterm LANG=C.UTF-8 \
  /bin/bash -c "[ -d /root/pg-executor/.git ] && cd /root/pg-executor && git pull --ff-only || git clone --depth 1 $REPO /root/pg-executor"

say "7/8 安装 Python 依赖"
cat > "$HOME/ubuntu-pip.sh" <<EOF
set -e
cd /root/pg-executor
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --upgrade pip -i $PIP_INDEX
.venv/bin/pip install -r requirements.txt -i $PIP_INDEX
.venv/bin/python -c 'import fastapi, uvicorn, aistudio_api; print("DEPS_READY")'
EOF

proot --link2symlink -0 -r "$UBUNTU_DIR" -b /dev -b /proc -b /sys -b /data/local/tmp:/hosttmp -b "$HOME:/root" -w /root \
  /usr/bin/env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TERM=xterm LANG=C.UTF-8 \
  /bin/bash /hosttmp/ubuntu-pip.sh || {
  echo "Python 依赖安装失败，请检查网络后重试。"
  exit 1
}

say "8/8 写入启动脚本并启动服务"
cat > "$HOME/ubuntu-server.sh" <<'EOF'
#!/bin/bash
cd /root/pg-executor || exit 1
export PG_HOST=0.0.0.0
export PG_PORT=8090
exec ./.venv/bin/python server.py
EOF

cat > "$HOME/start-pg.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# 用法：bash ~/start-pg.sh          启动（已在运行则直接提示）
#       bash ~/start-pg.sh restart  强制重启
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:$PATH
export LD_LIBRARY_PATH=$PREFIX/lib
cd "$HOME" || exit 1

get_ip() {
  local ip
  ip=$(getprop dhcp.wlan0.ipaddress 2>/dev/null)
  [ -z "$ip" ] && ip=$(/system/bin/ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -n1)
  [ -z "$ip" ] && ip=$(ifconfig wlan0 2>/dev/null | sed -n 's/.*inet addr:\([0-9.]*\).*/\1/p' | head -n1)
  echo "${ip:-手机局域网IP}"
}

running() {
  curl -fsS -m 3 http://127.0.0.1:8090/api/status >/dev/null 2>&1
}

if [ "${1:-}" != "restart" ] && running; then
  echo "Bluebird PG 已经在运行了"
  echo "手机地址: http://$(get_ip):8090"
  echo "（想强制重启就执行：bash ~/start-pg.sh restart）"
  exit 0
fi

if [ "${1:-}" = "restart" ]; then
  echo "正在停止旧服务..."
  pkill -9 -f pg-executor 2>/dev/null
  pkill -9 -f "server.py" 2>/dev/null
  sleep 1
fi

nohup setsid proot --link2symlink -0 -r "$HOME/ubuntu" \
  -b /dev -b /proc -b /sys -b /data/local/tmp:/hosttmp -b "$HOME:/root" -w /root \
  /usr/bin/env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TERM=xterm LANG=C.UTF-8 \
  /bin/bash /root/ubuntu-server.sh \
  > "$HOME/server.log" 2>&1 < /dev/null &

sleep 6
echo "----------------------------------------"
if running; then
  echo "Bluebird PG 已启动"
  echo "手机地址: http://$(get_ip):8090"
else
  echo "启动似乎失败了，最近日志："
  tail -n 20 "$HOME/server.log"
fi
echo "----------------------------------------"
EOF

cat > "$HOME/stop-pg.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
export HOME=/data/data/com.termux/files/home
export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:$PATH
export LD_LIBRARY_PATH=$PREFIX/lib
pkill -9 -f pg-executor 2>/dev/null
pkill -9 -f "server.py" 2>/dev/null
sleep 1
if curl -fsS -m 2 http://127.0.0.1:8090/api/status >/dev/null 2>&1; then
  echo "服务仍在运行，可能需要在 Termux 里手动结束。"
else
  echo "Bluebird PG 已停止。"
fi
EOF

chmod +x "$HOME/start-pg.sh" "$HOME/stop-pg.sh"
bash "$HOME/start-pg.sh"

cat <<'EOF'

提示：
  - 手机重启后，打开 Termux 执行  bash ~/start-pg.sh  即可重新启动。
  - 建议在系统设置里关闭 Termux 的电池优化，并让手机保持充电。
  - 主力设备的 Bluebird PG 面板地址填上面显示的 http://手机IP:8090 。
  - 不要把 8090 端口映射到公网。
EOF
