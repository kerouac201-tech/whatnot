@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 LTS，然后重新启动。官网：nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo 首次运行，正在下载程序依赖，请稍候……
  call npm ci --no-fund
  if errorlevel 1 goto failed
)
if not exist dist\index.html (
  call npm run build
  if errorlevel 1 goto failed
)
echo 启动后，请在这台电脑浏览器地址栏输入 127.0.0.1:3000
echo 关闭此窗口会停止程序。你的账目保存在 data 文件夹中。
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo 启动失败，请保留以上错误信息，参考「本机预览.md」。
pause
exit /b 1
