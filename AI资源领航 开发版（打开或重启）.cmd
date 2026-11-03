@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0" || exit /b 1
set "ELECTRON_RUN_AS_NODE="
where node.exe >nul 2>nul
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto missing_node
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||a===22&&b>=13?0:1)"
if errorlevel 1 goto missing_node
if not exist "node_modules\electron\dist\electron.exe" goto missing_dependencies
if not exist "node_modules\esbuild\package.json" goto missing_dependencies
echo 正在准备最新源码。若此开发版已运行，将保存并重启。
echo 正式版不受影响；此入口不生成安装包。
echo 源码目录：%CD%
call npm.cmd start
if errorlevel 1 goto launch_failed
popd
exit /b 0

:missing_node
echo 需要系统 Node.js 22.13.0 或更高版本及 npm，请安装后重新打开此入口。
goto failed

:missing_dependencies
echo 开发依赖不完整，请在以下目录打开终端并运行 npm.cmd ci，再重新打开此入口。
echo %CD%
goto failed

:launch_failed
echo 源码启动失败，请查看上方错误。若源码准备失败，正在运行的开发版不会被重启。

:failed
pause
popd
exit /b 1
