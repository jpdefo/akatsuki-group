param(
  [switch]$FullRefresh,
  [int]$GiveawayPages = 5,
  [int]$DelayMs = 505,
  [string]$Browser = "chrome",
  [switch]$SkipPush
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$nodePath = "C:\Program Files\nodejs"
if (Test-Path $nodePath) {
  $env:Path = "$nodePath;$env:Path"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required. Install Node.js first."
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python is required."
}

if (-not (Test-Path "node_modules\playwright")) {
  npm install
}

Write-Host "Opening SteamGifts in $Browser. If Cloudflare asks, complete the human verification in the browser."
node scripts/steamgifts-public-sync.mjs --browser-channel $Browser --headless false --member-pages 1 --giveaway-pages $GiveawayPages --delay-ms $DelayMs

python server.py --merge-sync-file data/steamgifts-sync.public.json
if ($FullRefresh) {
  python server.py --refresh-steam-progress --full-refresh
} else {
  python server.py --refresh-steam-progress
}

if (Test-Path "data/steamgifts-sync.public.json") {
  Remove-Item "data/steamgifts-sync.public.json" -Force
}

if ($SkipPush) {
  Write-Host "Refresh completed locally. Skipping git commit/push."
  exit 0
}

git add data
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host "No snapshot changes to publish."
  exit 0
}

git commit -m "Publish snapshot update" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push origin HEAD

Write-Host "Snapshot published. GitHub Pages will redeploy automatically."
