# Installs handbook-orchestrator on Windows, inside WSL, where it runs:
#   irm https://github.com/AhmetErenLapanta/TeamHandbook/releases/download/handbook-orchestrator-latest/install.ps1 | iex
#
# It checks that WSL has a Linux distribution, then runs the release's install.sh inside it, which
# checks the archive against SHA256SUMS, and SHA256SUMS against the release signature when cosign
# is installed in WSL, before writing anything. Nothing is installed on Windows itself, and no
# administrator rights are asked for. HANDBOOK_ORCHESTRATOR_VERSION,
# HANDBOOK_ORCHESTRATOR_RELEASE_BASE_URL and HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE are passed on
# to install.sh.
$ErrorActionPreference = "Stop"

function Say([string]$line) { Write-Host "handbook-orchestrator: $line" }

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  Say "it runs inside WSL; install WSL with: wsl --install, restart, then run this again"
  exit 1
}
# wsl.exe writes its own list in UTF-16, so the NUL bytes are taken out before it is read.
$distributions = (& wsl.exe --list --quiet) -replace "`0", "" | Where-Object { $_.Trim() -ne "" }
if (-not $distributions) {
  Say "WSL has no Linux distribution yet; add one with: wsl --install -d Ubuntu, then run this again"
  exit 1
}

# install.sh comes from the release that names the newest version, or from the mirror, which holds every file.
$mirror = if ($env:HANDBOOK_ORCHESTRATOR_RELEASE_BASE_URL) { $env:HANDBOOK_ORCHESTRATOR_RELEASE_BASE_URL.TrimEnd("/") } else { "" }
# The address goes into a shell command inside WSL, so it is held to the characters an address needs.
if ($mirror -and $mirror -notmatch '^https://[A-Za-z0-9.:/_~%-]+$' -and $mirror -notmatch '^http://(127\.0\.0\.1|localhost)(:\d+)?(/[A-Za-z0-9./_~%-]*)?$') {
  Say "the release address has to be https (plain http only on this machine): $mirror"
  exit 1
}
$from = if ($mirror) { $mirror } else { "https://github.com/AhmetErenLapanta/TeamHandbook/releases/download/handbook-orchestrator-latest" }
$requireSignature = if ($env:HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE -eq "1") { "1" } else { "" }
$version = if ($env:HANDBOOK_ORCHESTRATOR_VERSION) { $env:HANDBOOK_ORCHESTRATOR_VERSION } else { "" }
if ($version -and $version -notmatch '^[0-9A-Za-z.+-]+$') {
  Say "$version is not a version"
  exit 1
}

$command = "curl -fsSL --proto '=https,http' '$from/install.sh' | HANDBOOK_ORCHESTRATOR_RELEASE_BASE_URL='$mirror' HANDBOOK_ORCHESTRATOR_VERSION='$version' HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE='$requireSignature' sh"
& wsl.exe -e sh -c $command
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Say "start it with: wsl -e sh -lc handbook-orchestrator (and open the address it prints in your browser)"
