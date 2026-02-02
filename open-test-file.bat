@echo off
setlocal EnableDelayedExpansion
set ROOT=%~dp0
set FILE=%ROOT%test-mcp-file.js

rem Prefer explicit VS Code command if provided.
if defined VS_CODE_CMD (
  set "CODE_CMD=%VS_CODE_CMD%"
) else (
  rem Prefer VS Code from PATH (avoid Cursor).
  for /f "delims=" %%A in ('where.exe code.cmd 2^>nul ^| findstr /I /C:"Microsoft VS Code"') do (
    set "CODE_CMD=%%A"
    goto code_found
  )
  rem Try common VS Code install locations (code.cmd).
  set "CODE_CMD=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"
  if not exist "!CODE_CMD!" set "CODE_CMD=%ProgramFiles%\Microsoft VS Code\bin\code.cmd"
  if not exist "!CODE_CMD!" set "CODE_CMD=!ProgramFiles(x86)!\Microsoft VS Code\bin\code.cmd"
  if not exist "!CODE_CMD!" set "CODE_CMD=code"
)
 
:code_found

echo Opening VS Code (extension dev host)...
start "" "D:\Microsoft VS Code\bin\code.cmd" --new-window --extensionDevelopmentPath "%ROOT%" "%ROOT%"
if errorlevel 1 (
  echo Failed to launch VS Code or open file.
  echo If this opened Cursor, set VS_CODE_CMD to your VS Code code.cmd path.
  exit /b 1
)

echo Opening test file in VS Code...
start "" "D:\Microsoft VS Code\bin\code.cmd" -g "%FILE%"
if errorlevel 1 (
  echo Failed to open test file.
  exit /b 1
)

:call_mcp
echo Calling MCP server...
node "%ROOT%mcp-client-test.js" "%FILE%"
if errorlevel 1 (
  echo MCP call failed.
  echo Make sure the VS Code extension is running (F5) and MCP port 7310 is open.
  exit /b 1
)

exit /b 0
