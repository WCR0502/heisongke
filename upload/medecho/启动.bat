@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title MedEcho - Demo Server

echo.
echo   ============================================
echo     MedEcho / 同频 - 本地演示服务
echo   ============================================
echo.

set "NODE_CMD="
where node >nul 2>nul
if not errorlevel 1 set "NODE_CMD=node"

if not defined NODE_CMD (
  where nodejs >nul 2>nul
  if not errorlevel 1 set "NODE_CMD=nodejs"
)

if not defined NODE_CMD (
  echo   [!] 没有找到 Node.js
  echo.
  echo   1. 到 https://nodejs.org 下载安装 Node.js 18 或更高版本
  echo   2. 装完重新双击本文件
  echo.
  echo   只想看看界面的话，也可以直接双击 index.html
  echo   ^(离线预览：没有高德地图，也没有 AI 追问^)
  echo.
  pause
  exit /b 1
)

set "OPEN=1"
"%NODE_CMD%" server.js
set "CODE=%errorlevel%"

echo.
if "%CODE%"=="0" (
  echo   服务已结束。若上面写着「已经在运行」，说明它本来就开着，浏览器会直接打开。
) else (
  echo   启动失败，退出码 %CODE%。请把上面的提示截图反馈。
)
echo.
echo   提示：浏览器没自动打开时，复制上面那行 http://localhost:端口 到浏览器即可。
echo.
echo   按任意键关闭窗口。
pause >nul
