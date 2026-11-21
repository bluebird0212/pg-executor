#!/usr/bin/env bash
# 手机 Termux / Linux / macOS 启动脚本（Bluebird PG）
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "[1/3] 创建虚拟环境..."
  python -m venv .venv
  echo "[2/3] 安装依赖..."
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
  echo "[3/3] 安装完成。"
fi

echo "控制台: http://127.0.0.1:8090"
.venv/bin/python server.py
