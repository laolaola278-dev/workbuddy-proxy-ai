@echo off
setlocal
cd /d "%~dp0"

echo Starting WorkBuddy Cline Proxy...
echo   Project: %CD%
echo.

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH.
  echo Install Node.js 18+ or run this from a shell where npm is available.
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr /R /C:":8964 .*LISTENING" >nul 2>nul
if not errorlevel 1 goto :port_busy
goto :port_ok
:port_busy
echo [WARN] Port 8964 is already in use.
echo The proxy may already be running. Close the existing process first.
echo.
pause
exit /b 0
:port_ok

if exist ".env" goto :env_ok
echo [WARN] .env file not found.
echo Custom models from %%USERPROFILE%%\.workbuddy\models.json are used when present.
echo Set UPSTREAM_BASE_URL only if you also want a fallback upstream.
echo.
:env_ok

if defined MODEL_ROUTES_PATH goto :routes_ok
if exist "%USERPROFILE%\.workbuddy\models.json" set "MODEL_ROUTES_PATH=%USERPROFILE%\.workbuddy\models.json"
:routes_ok
if defined MODEL_ROUTES_PATH (
  echo Using model routes: %MODEL_ROUTES_PATH%
  echo.
)

echo Proxy will listen on:
echo   http://127.0.0.1:8964
echo Keep this service local. Do not bind to 0.0.0.0 or expose it publicly.
echo.
echo Endpoints:
echo   GET  http://127.0.0.1:8964/health
echo   GET  http://127.0.0.1:8964/v1/models
echo   POST http://127.0.0.1:8964/v1/chat/completions
echo   POST http://127.0.0.1:8964/v1/messages
echo.

npm.cmd start
set EXIT_CODE=%ERRORLEVEL%

echo.
echo Proxy exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%