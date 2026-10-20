#!/usr/bin/env pwsh
# Publish a release of dsh-workflow-runner to npm.
#
#   pwsh -File scripts/publish-release.ps1                 # token from the clipboard
#   pwsh -File scripts/publish-release.ps1 -Token npm_xxx   # token given explicitly
#   pwsh -File scripts/publish-release.ps1 -TokenFile path  # token read from a file
#   pwsh -File scripts/publish-release.ps1 -DryRun         # build the tarball, upload nothing
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
Write-Host '    If the account has 2FA on, npm will open your browser to authorize' -ForegroundColor DarkGray
Write-Host '    this publish. Touch the security key there. Do NOT type a recovery' -ForegroundColor DarkGray
Write-Host '    code into any OTP prompt - that puts the account on a 72-hour hold.' -ForegroundColor DarkGray
Push-Location $repoRoot
try {
  $ErrorActionPreference = 'Continue'
  # --auth-type=web makes npm open the browser for the security key. The
  # account's second factor is webauthn, and npm no longer supports
  # authenticator apps, so a TOTP code is not an option here.
  & npm publish --access public --auth-type=web 2>&1 | Tee-Object -Variable publishOut
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
} finally {
  Pop-Location
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
    Write-Host '  If npm asks for a code anyway, that prompt wants a RECOVERY' -ForegroundColor Yellow
    Write-Host '  CODE - do not use one to get past a publish. That is what puts' -ForegroundColor Yellow
    Write-Host '  the account into the 72-hour hold above.' -ForegroundColor Yellow
    exit $code
  }
  Write-Host ''
  Write-Err 'npm publish failed. See the output above.'
  exit $code
}

# ————————————————————————— 6. verify —————————————————————————

Write-Step 'Verifying the published version'
$pkg = Invoke-RestMethod -Uri "https://registry.npmjs.org/$pkgName" -TimeoutSec 30
$latest = $pkg.'dist-tags'.latest
Write-Ok "registry latest: $latest"
Write-Ok "versions: $($pkg.versions.PSObject.Properties.Name -join ', ')"
if ($latest -ne $localVersion) {
  Write-Err "The published latest ($latest) does not match package.json ($localVersion)."
  exit 1
}
Write-Step 'Published.'
