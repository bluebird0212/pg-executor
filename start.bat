@echo off
setlocal
cd /d "%~dp0"
title PG Bridge

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 没有找到 Python。请先安装 Python 3.11 或更高版本：
  echo https://www.python.org/downloads/
  echo 安装时记得勾选 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/3] 首次运行，正在创建虚拟环境...
  python -m venv .venv
  if errorlevel 1 goto :fail
  echo [2/3] 正在安装依赖，第一次会比较慢...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto :fail
  echo [3/3] 安装完成。
)

echo.
echo PG Bridge 启动中...
echo 控制台地址: http://127.0.0.1:8090
echo 客户端地址: http://127.0.0.1:8090/v1beta
echo 关闭这个窗口即可停止服务。
echo.
".venv\Scripts\python.exe" server.py
pause
exit /b 0

:fail
echo.
echo [错误] 依赖安装失败。请检查网络后重新运行。
echo 国内网络可以尝试先执行：
echo   .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
echo.
pause
exit /b 1
