@echo off
rem Ad Astra - start a local web server and open the site in the browser.
cd /d "%~dp0"
set PORT=8000

rem Build the launch-data snapshot (same as GitHub Actions does). Optional: without Node,
rem or if the API is unavailable, the page calls the launch API directly instead.
where node >nul 2>nul
if %errorlevel%==0 (
  echo Fetching latest launch data...
  node scripts\fetch-data.mjs || echo Could not refresh launch data, continuing anyway.
) else (
  echo Node.js not found - skipping the launch-data snapshot.
)

where python >nul 2>nul
if %errorlevel%==0 (
  set PY=python
) else (
  where py >nul 2>nul || (
    echo Python was not found. Install it from https://www.python.org/downloads/
    pause
    exit /b 1
  )
  set PY=py
)

echo.
echo Ad Astra is running at http://localhost:%PORT%
echo Close this window (or press Ctrl+C) to stop it.
start "" "http://localhost:%PORT%"
%PY% -m http.server %PORT%
