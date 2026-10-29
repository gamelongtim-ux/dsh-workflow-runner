#!/usr/bin/env pwsh
# Publish a release of dsh-workflow-runner to npm.
#
#   pwsh -File scripts/publish-release.ps1                 # token from the clipboard
#   pwsh -File scripts/publish-release.ps1 -Token npm_xxx   # token given explicitly
#   pwsh -File scripts/publish-release.ps1 -TokenFile path  # token read from a file
#   pwsh -File scripts/publish-release.ps1 -DryRun         # build the tarball, upload nothing
#
# PREREQUISITE: npm 12 next to the repo.
#
#   npm install --no-save npm@12
#
#   The account's second factor is a SECURITY KEY, and npm's only web-2FA
#   flow starts when it reads `authUrl` and `doneUrl` out of the 401's BODY:
#
#     if (err.code === "EOTP" && err.body?.authUrl && err.body?.doneUrl) { … }
#
#   npm 11 does not read them; npm 12 does. The registry puts the URL in the
#   `npm-notice` HEADER instead, so the publish goes through
#   scripts/publish-with-webauth.mjs -- a local proxy that moves the URL
#   into the body where npm looks for it.
#
#   Without this, npm falls through to the classic "Enter OTP:" prompt,
#   and on an account with no authenticator app that prompt wants a
#   RECOVERY CODE. Typing one there is what puts the account into the
#   72-hour read-only hold.
#
#   The flow also needs a real terminal: `otplease` starts with
#
#     if (!process.stdin.isTTY || !process.stdout.isTTY) { throw err }
#
#   so a publish from a pipe cannot open the browser at all.
#
# Why a script instead of three shell commands: every failure mode below has
# bitten this project at least once.
#
#   - `npm config set <registry-scoped auth token>` writes to $HOME/.npmrc,
#     and in WSL on this machine $HOME is the literal string "C:UsersGGBOND",
#     so the token lands in the wrong place. This script always targets
#     %USERPROFILE%\.npmrc.
#   - `Set-Content -Encoding UTF8` under PowerShell 5.1 writes a BOM and npm
#     then cannot read the token. [System.IO.File]::WriteAllText does not.
#   - The token in the npmrc may be expired or revoked. npm answers that with
#     401 on /user and /-/whoami, and with a misleading 404 on the publish PUT
#     ("could not be found or you do not have permission"). This script checks
#     the auth FIRST, so a dead token is reported as a dead token.
#   - The account's second factor is a SECURITY KEY (webauthn). npm's web
#     auth flow only runs in an interactive terminal (npm/lib/utils/auth.js:10
#     bails out when stdin or stdout is not a TTY), so run this from a real
#     terminal: npm opens the browser, you touch the key, and npm finishes the
#     publish itself.
#
#   !!! NEVER put a 2FA RECOVERY CODE into an --otp prompt. !!!
#   Using one is a "security-sensitive action": npm puts the account into a
#   72-hour read-only state that blocks publishing, token management, package
#   visibility and org/team changes. It lifts on its own, and each new
#   recovery code restarts the clock. While the account is in that state a
#   publish fails AFTER the 2FA step with:
#       403 Forbidden - PUT ... - Your account has been temporarily suspended
#       due to a recent security-sensitive action.
#   Nothing is half-published; confirm with `npm view dsh-workflow-runner version`.
#
#   - `npm publish` runs the `prepare` script, which builds the vendored
#     engine. A build failure aborts the publish after the tarball is made.
#
# This script does NOT bump the version. `npm version` commits and tags before
# publishing, so a failed publish would leave an orphan version and an orphan
# tag if the script bumped again. Bump, commit and tag by hand, then run this.

[CmdletBinding()]
param(
  # The npm token. Omit to take whatever is in the clipboard.
  [string] $Token,
  # A file holding the token (one line). Useful when the token is in a
  # password manager and the clipboard is not safe to use.
  [string] $TokenFile,
  # Route npm through this proxy, e.g. http://127.0.0.1:7897
  [string] $Proxy = '',
  # Build the tarball and report, but upload nothing.
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$npmrc = Join-Path $env:USERPROFILE '.npmrc'
$pkgName = 'dsh-workflow-runner'

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "    $text" -ForegroundColor Red }

# ————————————————————————— 1. the token —————————————————————————

# A token already in the npmrc is the normal case, and it means the script
# needs no input at all. Only reach for the clipboard / file / argument when
# there is no usable token there yet.
function Test-ExistingToken {
  if (-not (Test-Path $npmrc)) { return $null }
  $existing = (Get-Content -LiteralPath $npmrc -Raw |
    Select-String -Pattern '_authToken=(.+)' |
    ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() })
  if ([string]::IsNullOrWhiteSpace($existing)) { return $null }
  $ErrorActionPreference = 'Continue'
  $out = (& npm whoami 2>&1 | Out-String).Trim()
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($code -ne 0) { return $null }
  return [pscustomobject]@{ Token = $existing; Who = $out }
}

Write-Step 'Resolving the npm token'
$have = Test-ExistingToken
if ($have -ne $null -and [string]::IsNullOrWhiteSpace($Token) -and [string]::IsNullOrWhiteSpace($TokenFile)) {
  Write-Ok "the npmrc already holds a token that works ($($have.Who))"
  $Token = $have.Token
} elseif ([string]::IsNullOrWhiteSpace($Token)) {
  if (-not [string]::IsNullOrWhiteSpace($TokenFile)) {
    $Token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
    Write-Ok "read from $TokenFile"
  } else {
    try {
      $Token = (Get-Clipboard -Raw).Trim()
    } catch {
      $Token = ''
    }
    if ([string]::IsNullOrWhiteSpace($Token)) {
      Write-Warn2 'No token in the clipboard and none given. Paste the token, then press Enter.'
      $Token = (Read-Host 'npm token').Trim()
    } else {
      Write-Ok 'read from the clipboard'
    }
  }
}

if ([string]::IsNullOrWhiteSpace($Token)) {
  throw 'No npm token.'
}
if ($Token -notmatch '^npm_') {
  throw "That does not look like an npm token (expected it to start with npm_)."
}
Write-Ok ("token looks like an npm token (" + $Token.Length + ' chars)')

# ————————————————————————— 2. write the npmrc —————————————————————————

Write-Step "Writing $npmrc"
# No BOM: npm would not read the token out of a BOM-prefixed npmrc.
[System.IO.File]::WriteAllText($npmrc, "//registry.npmjs.org/:_authToken=$Token`n")
Write-Ok 'written (UTF-8, no BOM)'

# ————————————————————————— 3. check the auth —————————————————————————

if ($Proxy -ne '') {
  $env:HTTP_PROXY = $Proxy
  $env:HTTPS_PROXY = $Proxy
  $env:http_proxy = $Proxy
  $env:https_proxy = $Proxy
  Write-Ok "using proxy $Proxy"
}

Write-Step 'Checking the token against the registry'
Push-Location $repoRoot
try {
  # npm writes its error to stderr; under PowerShell 5.1 that surfaces as a
  $ErrorActionPreference = 'Continue'
  $whoami = (& npm whoami 2>&1 | Out-String).Trim()
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
} finally {
  Pop-Location
}
if ($code -ne 0) {
  Write-Err 'The registry rejected the token.'
  Write-Host ''
  Write-Host '  npm said:' -ForegroundColor Yellow
  ($whoami -split "`n" | Where-Object { $_ -match 'npm error|E\d{3}' } | ForEach-Object {
    Write-Host "    $($_.Trim())" -ForegroundColor Yellow
  })
  Write-Host ''
  Write-Host '  A 401 here means the token is expired, revoked, or was created' -ForegroundColor Yellow
  Write-Host '  without the Read & write permission on this package.' -ForegroundColor Yellow
  Write-Host '  npmjs.com -> Access Tokens -> create one with Read & write,' -ForegroundColor Yellow
  Write-Host '  then copy it to the clipboard and run this script again.' -ForegroundColor Yellow
  exit 1
}
Write-Ok "authenticated as: $whoami"

# ————————————————————————— 4. has this version already shipped? —————————————————————————

$localVersion = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
Write-Step "Checking the registry for $localVersion"
$ErrorActionPreference = 'Continue'
$published = (& npm view $pkgName versions --json 2>$null | Out-String).Trim()
$ErrorActionPreference = 'Stop'
if ($published -match [regex]::Escape($localVersion)) {
  Write-Err "$localVersion is already on the registry. Publishing it again would fail."
  Write-Host '  Bump the version in package.json, commit, and tag BEFORE running this.' -ForegroundColor Yellow
  exit 1
}
Write-Ok "$localVersion is not published yet"

# ————————————————————————— 5. publish —————————————————————————

if ($DryRun) {
  Write-Step 'Dry run: building the tarball, uploading nothing'
  Push-Location $repoRoot
  try {
    $ErrorActionPreference = 'Continue'
    & npm publish --dry-run --access public
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
  } finally {
    Pop-Location
  }
  exit $code
}

Write-Step 'Publishing'

# The account's second factor is a SECURITY KEY, so the only way through is
# npm's web-2FA flow. Three things have to line up for it to start:
#
#   1. npm must READ the auth URL out of the 401. npm 11 does not; npm 12
#      does. The registry puts the URL in the `npm-notice` HEADER, and the
#      wrapper moves it into the body where npm looks for it.
#   2. stdin AND stdout must be a TTY. `otplease` starts with
#        if (!process.stdin.isTTY || !process.stdout.isTTY) { throw err }
#      so without a terminal npm rethrows the 401 instead of opening the
#      browser.
#   3. npm must be pointed at a registry it has credentials FOR -- and a
#      local proxy is a different registry, so it needs the token again.
#
# A plain `npm publish` therefore lands on the classic "Enter OTP:"
# prompt, and on an account with no authenticator app that prompt wants a
# RECOVERY CODE -- which is what puts the account into the 72-hour hold.
#
# So the publish goes through the wrapper, which handles all three.
$npm12 = Join-Path $repoRoot 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $npm12)) {
  Write-Warn2 'npm 12 is not installed next to the repo.'
  Write-Host '    It is what reads the auth URL out of the 401, so the web-2FA' -ForegroundColor Yellow
  Write-Host '    flow can start. Install it with:' -ForegroundColor Yellow
  Write-Host '      npm install --no-save npm@12' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}
Write-Ok 'npm 12 is present (the web-2FA flow needs it)'

Write-Host '    npm will open your browser to authorize this publish.' -ForegroundColor DarkGray
Write-Host '    Touch the security key there. Do NOT type a recovery code' -ForegroundColor DarkGray
Write-Host '    into any OTP prompt - that puts the account on a 72-hour hold.' -ForegroundColor DarkGray
Write-Host '' -ForegroundColor DarkGray
Push-Location $repoRoot
try {
  $ErrorActionPreference = 'Continue'
  # The output goes STRAIGHT to the console -- no pipe, no redirection.
  #
  # This is not a style choice. npm's web-2FA flow starts only when npm's
  # own stdout is a TTY:
  #
  #   if (!process.stdin.isTTY || !process.stdout.isTTY) { throw err }
  #
  # A pipe breaks that (Tee-Object), and so does PowerShell's `*>` — both
  # make the child's stdout a FILE or a PIPE instead of the console. The
  # child has to inherit the terminal untouched.
  #
  # The output is therefore NOT captured. The failure analysis below reads
  # npm's own log file instead, which npm writes anyway.
  & node (Join-Path $PSScriptRoot 'publish-with-webauth.mjs')
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
} finally {
  Pop-Location
}

# npm's own log of this run, for the failure analysis below.
#
# npm writes one log per command, and the publish's is the newest one that
# mentions this package -- not simply the newest, which could belong to
# something else that ran in between.
$publishOut = @()
$logDir = Join-Path $env:LOCALAPPDATA 'npm-cache\_logs'
$npmLog = Get-ChildItem $logDir -Filter '*.log' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Where-Object { Select-String -Path $_.FullName -Pattern $pkgName -Quiet -ErrorAction SilentlyContinue } |
  Select-Object -First 1
if ($npmLog -ne $null) {
  $publishOut = @(Get-Content $npmLog.FullName -ErrorAction SilentlyContinue)
}

if ($code -ne 0) {
  $text = ($publishOut | Out-String)
  if ($text -match 'temporarily suspended') {
    Write-Host ''
    Write-Err 'The account is in npm''s 72-hour read-only state.'
    Write-Host '  It is triggered by a "security-sensitive action" - in practice,' -ForegroundColor Yellow
    Write-Host '  a 2FA RECOVERY CODE used where an OTP was expected.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  What to do: WAIT. The hold lifts on its own, and each new' -ForegroundColor Yellow
    Write-Host '  recovery code restarts the clock - so do not try to "fix" it' -ForegroundColor Yellow
    Write-Host '  with another one.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Nothing is half-published. Confirm with:' -ForegroundColor Yellow
    Write-Host "    npm view $pkgName version" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  To appeal instead: https://support.npmjs.com/ - quote the 403 and' -ForegroundColor Yellow
    Write-Host '  the account name.' -ForegroundColor Yellow
    exit $code
  }
  if ($text -match 'one-time pass|EOTP') {
    Write-Host ''
    Write-Err 'npm wanted a one-time password and did not get one.'
    Write-Host '  The account''s second factor is a SECURITY KEY, so the code npm' -ForegroundColor Yellow
    Write-Host '  wants is not a 6-digit OTP: run this from a real terminal so npm' -ForegroundColor Yellow
    Write-Host '  can open the browser, and touch the key there.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  If npm still asks for a code, its web flow did not start. Two' -ForegroundColor Yellow
    Write-Host '  reasons, both fixable:' -ForegroundColor Yellow
    Write-Host '    - npm 11 does not read the auth URL out of the 401 body. Install' -ForegroundColor Yellow
    Write-Host '      npm 12 next to the repo:  npm install --no-save npm@12' -ForegroundColor Yellow
    Write-Host '    - the flow needs a TTY on stdin AND stdout, so it cannot run' -ForegroundColor Yellow
    Write-Host '      from a pipe or a tool. Run it in PowerShell or cmd.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  If npm asks for a code ANYWAY, that prompt wants a RECOVERY CODE' -ForegroundColor Yellow
    Write-Host '  - do not use one to get past a publish. That is what puts the' -ForegroundColor Yellow
    Write-Host '  account into the 72-hour hold above.' -ForegroundColor Yellow
    exit $code
  }
  Write-Host ''
  Write-Err 'npm publish failed. See the output above.'
  exit $code
}

# ————————————————————————— 6. verify —————————————————————————

Write-Step 'Verifying the published version'

# The registry is eventually consistent, and it is consistent in PIECES:
#
#   - the packument (the version list) is CDN-cached and can lag by
#     minutes;
#   - the version document (/<pkg>/<version>) appears first;
#   - the tarball appears last -- it took about four minutes for it.
#
# So the check that means something is the TARBALL, and the packument is
# only a hint. Checking `npm view <pkg> versions` right after a publish
# says "not published" for a version that is already there, and reading
# that as a failure sends you looking for a problem that is not there.
$tarballUrl = "https://registry.npmjs.org/$pkgName/-/$pkgName-$localVersion.tgz"
$published = $false
for ($attempt = 1; $attempt -le 15; $attempt++) {
  try {
    $head = Invoke-WebRequest -Uri $tarballUrl -Method Head -TimeoutSec 20 -UseBasicParsing
    if ($head.StatusCode -eq 200) { $published = $true; break }
  } catch {
    # 404 while the registry copies the tarball around.
  }
  if ($attempt -lt 15) {
    Write-Host "    the tarball is not served yet (attempt $attempt/15) — the registry copies it around" -ForegroundColor DarkGray
    Start-Sleep -Seconds 20
  }
}

if (-not $published) {
  Write-Err "the published tarball is not served yet: $tarballUrl"
  Write-Host '  The version document is usually there even when the tarball is' -ForegroundColor Yellow
  Write-Host '  not. The registry takes a few minutes to copy it around. Check:' -ForegroundColor Yellow
  Write-Host "    curl -I $tarballUrl" -ForegroundColor DarkGray
  exit 1
}
Write-Ok "the tarball is served: $tarballUrl"

$pkg = Invoke-RestMethod -Uri "https://registry.npmjs.org/$pkgName" -TimeoutSec 30
$latest = $pkg.'dist-tags'.latest
Write-Ok "registry latest: $latest"
Write-Ok "versions: $($pkg.versions.PSObject.Properties.Name -join ', ')"
if ($latest -ne $localVersion) {
  Write-Warn2 "the packument's latest is $latest, not $localVersion."
  Write-Host '  The packument is CDN-cached and can lag; the tarball above is' -ForegroundColor Yellow
  Write-Host '  the authoritative answer.' -ForegroundColor Yellow
}
Write-Step 'Published.'
