#!/usr/bin/env pwsh
# Publish a release of dsh-workflow-runner to npm.
#
#   pwsh -File scripts/publish-release.ps1                 # token from the clipboard
#   pwsh -File scripts/publish-release.ps1 -Token npm_xxx   # token given explicitly
#   pwsh -File scripts/publish-release.ps1 -TokenFile path  # token read from a file
#
# Why a script instead of three shell commands: every failure mode below has
# bitten this project at least once.
#
#   - `npm config set //registry.npmjs.org/:_authToken ...` writes to $HOME/.npmrc.
#     In WSL on this machine $HOME is broken (it is the literal string
#     "C:UsersGGBOND"), so the token lands in the wrong place — or nowhere.
#     This script always targets the Windows profile: $env:USERPROFILE\.npmrc.
#   - `Set-Content -Encoding UTF8` under PowerShell 5.1 writes a BOM, and npm
#     then fails to read the auth token. [System.IO.File]::WriteAllText does
#     not add one.
#   - The token in the npmrc may be expired or revoked. npm answers that with
#     401 on /user and /-/whoami, and with a misleading 404 on the publish PUT
#     ("could not be found or you do not have permission"). This script checks
#     the auth FIRST, so a dead token is reported as a dead token.
#   - The account may have 2FA on. npm's web-auth flow only runs in an
#     interactive terminal (npm/lib/utils/auth.js:10 bails out when stdin or
#     stdout is not a TTY), so run this script from a real terminal, not from
#     a redirected shell: npm then opens the browser, waits for the
#     authorization, and finishes the publish itself.
#     If the account uses a SECURITY KEY (webauthn), that ceremony has to
#     happen in a real browser: the in-app Electron browser cannot reach the
#     OS credential provider, and the get() call ends in NotAllowedError.
#     npm's own flow handles this - it opens your default browser, you touch
#     the key, and npm finishes the publish.
#   - `npm publish` runs the `prepare` script, which builds the vendored
#     engine. A build failure aborts the publish after the tarball is made.
#
# The registry is reachable directly; pass -Proxy to route through a local
# Clash instance.

[CmdletBinding()]
param(
  # The npm token. Omit to take whatever is in the clipboard.
  [string] $Token,
  # A file holding the token (one line). Useful when the token is in a
  # password manager and the clipboard is not safe to use.
  [string] $TokenFile,
  # Route npm through this proxy, e.g. http://127.0.0.1:7897
  [string] $Proxy = '',
  # Stop after writing the npmrc and checking the auth.
  [switch] $CheckOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$npmrc = Join-Path $env:USERPROFILE '.npmrc'

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

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
  # npm writes its error to stderr; under PowerShell 5.1 that surfaces as a  # NativeCommandError record, so collect it instead of letting it escape.
  $ErrorActionPreference = 'Continue'
  $whoami = (& npm whoami 2>&1 | Out-String).Trim()
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
} finally {
  Pop-Location
}
if ($code -ne 0) {
  Write-Warn2 'The registry rejected the token.'
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

if ($CheckOnly) {
  Write-Step 'CheckOnly: stopping before the publish'
  exit 0
}

# ————————————————————————— 4. publish —————————————————————————

Write-Step 'Publishing'
if ([Environment]::UserInteractive) {
  Write-Host '    If the account has 2FA on, npm will open your browser to authorize' -ForegroundColor DarkGray
  Write-Host '    this publish (or print a URL to open). That step needs you.' -ForegroundColor DarkGray
}
Push-Location $repoRoot
try {
  $ErrorActionPreference = 'Continue'
  & npm publish --access public
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
} finally {
  Pop-Location
}
if ($code -ne 0) {
  Write-Warn2 'npm publish failed.'
  exit $code
}

# ————————————————————————— 5. verify —————————————————————————

Write-Step 'Verifying the published version'
$pkg = Invoke-RestMethod -Uri 'https://registry.npmjs.org/dsh-workflow-runner' -TimeoutSec 30
$latest = $pkg.'dist-tags'.latest
Write-Ok "registry latest: $latest"
Write-Ok "versions: $($pkg.versions.PSObject.Properties.Name -join ', ')"
if ($latest -ne (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version) {
  Write-Warn2 'The published latest does not match package.json. Check the output above.'
  exit 1
}
Write-Step 'Published.'
