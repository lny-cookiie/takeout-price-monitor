@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\@midscene\android" (
  echo 请先在此目录运行 npm ci 安装依赖。
  pause
  exit /b 1
)
call npm.cmd run build
if errorlevel 1 (
  pause
  exit /b 1
)
echo 工作台地址：http://127.0.0.1:4318
echo 关闭此窗口会停止服务。
node --env-file-if-exists=.env dist/main.js
pause
