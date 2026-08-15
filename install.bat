@echo off
rem WorktreeProof V4 - one-click installer (Windows)
rem Installs plugins, commands, skills, and MCP wiring for ANY agentic app.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install from https://nodejs.org and rerun.
  pause
  exit /b 1
)
echo Installing WorktreeProof V4...
node install.mjs
if errorlevel 1 (
  echo Installation failed. See output above.
  pause
  exit /b 1
)
echo.
echo Done. Restart OpenCode Desktop, then run /goal to start.
pause
