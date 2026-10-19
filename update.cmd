@echo off
rem ============================================================
rem  dsh-workflow-runner maintainer one-click update + publish
rem
rem  usage:
rem    update.cmd                                  -> commit + push + cp into dsh (no version bump, no npm publish)
rem    update.cmd  [profile]  "msg"                -> same as above
rem    update.cmd  [profile]  "msg"  patch         -> commit + npm version patch + git push --follow-tags + npm publish + cp
rem    update.cmd  [profile]  "msg"  minor         -> npm version minor instead
rem    update.cmd  [profile]  "msg"  major         -> npm version major instead
rem
rem  default profile: desktop
rem  default bump:    none  (no npm publish)
rem
rem  bumps imply publish:
rem    "patch" / "minor" / "major" -> run `npm version` -> git push the new tag -> `npm publish --access public`
rem
rem  proxy: Clash on 127.0.0.1:7897 is applied to git. npm respects the same
rem  proxy via HTTP_PROXY / HTTPS_PROXY env vars (set below) so `npm publish`
rem  to registry.npmjs.org works the same way.
rem
rem  NOTE: lib/ changes need a dsh web restart afterwards;
rem        public/-only changes just need Ctrl+F5 in the browser.
rem ============================================================
setlocal

set PROFILE=%~1
if "%PROFILE%"=="" set PROFILE=desktop

set MSG=%~2
if "%MSG%"=="" set MSG=update

set BUMP=%~3
if "%BUMP%"=="" set BUMP=none

set PROXY=http://127.0.0.1:7897

rem Always apply proxy to npm + git. (git is set globally; npm needs env vars.)
set HTTP_PROXY=%PROXY%
set HTTPS_PROXY=%PROXY%
set http_proxy=%PROXY%
set https_proxy=%PROXY%

cd /d "%~dp0"

echo === dsh-workflow-runner update.cmd ===
echo   profile: %PROFILE%
echo   msg:     %MSG%
echo   bump:    %BUMP%
echo.

rem ---------- 0. Build the vendored ZCode engine ----------
rem The plugin now vendors zai-org/ZCode's @zcode/dynamic-workflow and runs it
rem in-process. Its dist/ is a build artifact (gitignored), so it MUST be built
rem before the sources are copied into the profile, otherwise the plugin fails
rem to import at startup.
echo [0/6] building vendored @zcode/dynamic-workflow ...
call npm run build
if errorlevel 1 (
  echo build failed - aborting before copying
  exit /b 1
)

rem ---------- 1. Stage and commit ----------
git add -A
git diff --cached --quiet
if errorlevel 1 (
  echo [1/6] committing working-tree changes
  git -c user.email="2411909134@qq.com" -c user.name="lookaren" commit -m "%MSG%"
) else (
  echo [1/6] no working-tree changes to commit
)

rem ---------- 2. Optional: npm version bump ----------
if /I not "%BUMP%"=="none" (
  if /I "%BUMP%"=="patch" goto :doversion
  if /I "%BUMP%"=="minor" goto :doversion
  if /I "%BUMP%"=="major" goto :doversion
  echo [2/6] unknown bump mode "%BUMP%" ^(expected: none ^| patch ^| minor ^| major^) — aborting
  exit /b 2
)
:doversion
if /I "%BUMP%"=="none" goto :skipversion
echo [2/6] npm version %BUMP% ...
call npm version %BUMP% -m "v%%s: %MSG%"
if errorlevel 1 (
  echo [2/6] npm version failed
  exit /b 1
)
:skipversion

rem ---------- 3. Push to GitHub ----------
echo [3/6] pushing to GitHub ...
git push --follow-tags --quiet 2>nul
if errorlevel 1 (
  echo [3/6] push failed directly, retrying via proxy 127.0.0.1:7897 ...
  git -c http.proxy=%PROXY% -c https.proxy=%PROXY% push --follow-tags
  if errorlevel 1 (
    echo [3/6] push failed even with proxy - aborting before publish
    exit /b 1
  )
)

rem ---------- 4. Optional: npm publish ----------
if /I "%BUMP%"=="none" goto :skippublish
echo [4/6] npm publish ...
call npm publish --access public
if errorlevel 1 (
  echo [4/6] npm publish failed - git tag was pushed but the tarball did NOT land on npmjs.org
  echo         re-run `npm publish --access public` once the auth/registry issue is fixed.
  exit /b 1
)
:skippublish

rem ---------- 5. Copy sources into the installed dsh profile ----------
rem packages/ carries the vendored engine (dist/ is the built artifact).
rem node_modules/typescript is copied too: the engine imports "typescript" at
rem runtime (39 of its dist files do), and a file: copy install has no pnpm to
rem resolve it. typescript has zero dependencies of its own, so copying the one
rem package is enough.
echo [5/6] copying sources into the installed dsh profile ^(%PROFILE%) ...
wsl.exe -e /bin/bash -lic "PROFILE=%PROFILE%; D=/home/ggbond/.dsh/profiles/$PROFILE/node_modules/dsh-workflow-runner; S=/mnt/d/ZcodeStorage/.zcode/workspace/default/dsh-workflow-runner; mkdir -p $D $D/node_modules; cp -a $S/lib $S/public $S/samples $S/packages $S/package.json $S/cordis.patch.yml $S/README.md $S/README.zh-CN.md $D/ && cp -a $S/node_modules/typescript $D/node_modules/ && echo copied"

echo.
echo Done. Restart dsh web if you changed lib/ ; Ctrl+F5 is enough for public/-only edits.
if not "%BUMP%"=="none" echo The new version is now on npm ^+ GitHub.
pause
