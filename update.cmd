@echo off
rem ============================================================
rem  dsh-workflow-runner maintainer one-click update
rem  usage: update.cmd [profile] ["commit message"]
rem  default profile: desktop
rem  behavior: git commit + push, then copy sources into the
rem  installed dsh profile via WSL (since dsh itself runs in WSL).
rem  NOTE: lib/ changes need `dsh web` restart afterwards;
rem        public/-only changes just need Ctrl+F5 in the browser.
rem ============================================================
setlocal
cd /d "%~dp0"

set PROFILE=%~1
if "%PROFILE%"=="" set PROFILE=desktop
set MSG=%~2
if "%MSG%"=="" set MSG=update

git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "%MSG%"
) else (
  echo Nothing new to commit.
)

git push --quiet 2>nul
if errorlevel 1 (
  echo push failed directly, retrying via proxy 127.0.0.1:7897 ...
  git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push
)

echo Copying sources into the installed dsh profile (%PROFILE%) ...
wsl.exe -e /bin/bash -lic "PROFILE=%PROFILE%; D=/home/ggbond/.dsh/profiles/$PROFILE/node_modules/dsh-workflow-runner; S=/mnt/d/ZcodeStorage/.zcode/workspace/default/dsh-workflow-runner; mkdir -p $D; cp -a $S/lib $S/public $S/samples $S/package.json $S/cordis.patch.yml $S/README.md $S/README.zh-CN.md $D/ && echo copied"

echo.
echo Done. Restart dsh web if you changed lib/ ; Ctrl+F5 is enough for public/-only edits.
pause
