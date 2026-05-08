param(
  [ValidateSet("collector", "public")]
  [string]$Mode = "collector",
  [switch]$FullRefresh,
  [int]$GiveawayPages = 5,
  [int]$DelayMs = 505,
  [string]$Browser = "chrome",
  [int]$TimeoutMinutes = 20,
  [switch]$SkipPush
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$nodePath = "C:\Program Files\nodejs"
if (Test-Path $nodePath) {
  $env:Path = "$nodePath;$env:Path"
}

$groupUrl = "https://www.steamgifts.com/group/7Ypot/akatsukigamessteamgifts"
$adminUrl = "http://127.0.0.1:4173/admin.html"
$syncEndpoint = "http://127.0.0.1:4173/api/steamgifts-sync"
$startedServer = $null

function Get-BrowserPath {
  param([string]$Name)

  $normalized = [string]$Name
  $normalized = $normalized.Trim().ToLowerInvariant()
  $candidates = switch ($normalized) {
    "chrome" {
      @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
      )
    }
    "msedge" {
      @(
        "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
      )
    }
    default { @() }
  }

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return $null
}

function Open-BrowserUrls {
  param(
    [string]$Name,
    [string[]]$Urls
  )

  $browserPath = Get-BrowserPath $Name
  if ($browserPath) {
    Start-Process -FilePath $browserPath -ArgumentList $Urls | Out-Null
    return
  }

  foreach ($url in $Urls) {
    Start-Process $url | Out-Null
  }
}

function Test-LocalServer {
  try {
    Invoke-RestMethod -Uri $syncEndpoint -Method Get -TimeoutSec 5 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Wait-LocalServer {
  param([int]$TimeoutSeconds = 60)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalServer) {
      return
    }
    Start-Sleep -Seconds 1
  }

  throw "Timed out waiting for the local server at $syncEndpoint."
}

function Start-LocalServerIfNeeded {
  if (Test-LocalServer) {
    return $null
  }

  $python = Get-Command python -ErrorAction Stop
  $serverProcess = Start-Process -FilePath $python.Source -ArgumentList @("server.py") -WorkingDirectory $repoRoot -PassThru
  Wait-LocalServer
  return $serverProcess
}

function Get-SyncMarker {
  try {
    $payload = Invoke-RestMethod -Uri $syncEndpoint -Method Get -TimeoutSec 10
    $memberCount = if ($payload.PSObject.Properties.Name -contains "members" -and $payload.members) { @($payload.members).Count } else { 0 }
    $giveawayCount = if ($payload.PSObject.Properties.Name -contains "giveaways" -and $payload.giveaways) { @($payload.giveaways).Count } else { 0 }
    return [pscustomobject]@{
      Source = [string]$payload.source
      SavedAt = [string]$payload.savedAt
      SyncedAt = [string]$payload.syncedAt
      Members = [int]$memberCount
      Giveaways = [int]$giveawayCount
    }
  } catch {
    return [pscustomobject]@{
      Source = ""
      SavedAt = ""
      SyncedAt = ""
      Members = 0
      Giveaways = 0
    }
  }
}

function Wait-ForFreshCollectorSync {
  param(
    [object]$Baseline,
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $current = Get-SyncMarker
    $hasNewSave = $current.SavedAt -and $current.SavedAt -ne $Baseline.SavedAt
    $hasNewSync = $current.SyncedAt -and $current.SyncedAt -ne $Baseline.SyncedAt
    if ($current.Source -eq "akatsuki-steamgifts-sync" -and ($hasNewSave -or $hasNewSync)) {
      return $current
    }
    Start-Sleep -Seconds 2
  }

  throw "Timed out waiting for a fresh SteamGifts sync from the collector."
}

function Publish-ChangedData {
  param([switch]$SkipPushChanges)

  if ($SkipPushChanges) {
    Write-Host "Refresh completed locally. Skipping git commit/push."
    return
  }

  git add data
  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host "No snapshot changes to publish."
    return
  }

  git commit -m "Publish snapshot update" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  git push origin HEAD
  Write-Host "Snapshot published. GitHub Pages will redeploy automatically."
}

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python is required."
}

try {
  if ($Mode -eq "public") {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      throw "Node.js is required for public mode. Install Node.js first."
    }

    if (-not (Test-Path "node_modules\playwright")) {
      npm install
    }

    Write-Host "Opening SteamGifts in $Browser. If Cloudflare asks, complete the human verification in the browser."
    node scripts/steamgifts-public-sync.mjs --browser-channel $Browser --headless false --member-pages 1 --giveaway-pages $GiveawayPages --delay-ms $DelayMs

    python server.py --merge-sync-file data/steamgifts-sync.public.json
  } else {
    $startedServer = Start-LocalServerIfNeeded
    $baseline = Get-SyncMarker

    Write-Host "Opening admin tools and the SteamGifts group in $Browser."
    Write-Host "Run the userscript or bookmarklet from the logged-in SteamGifts tab. This command will continue automatically after the sync is saved."
    Open-BrowserUrls -Name $Browser -Urls @($adminUrl, $groupUrl)

    $freshSync = Wait-ForFreshCollectorSync -Baseline $baseline -TimeoutSeconds ($TimeoutMinutes * 60)
    Write-Host "Fresh SteamGifts sync received: $($freshSync.Members) member(s), $($freshSync.Giveaways) giveaway(s)."
  }

  if ($FullRefresh) {
    python server.py --refresh-steam-progress --full-refresh
  } else {
    python server.py --refresh-steam-progress
  }

  if (Test-Path "data/steamgifts-sync.public.json") {
    Remove-Item "data/steamgifts-sync.public.json" -Force
  }

  Publish-ChangedData -SkipPushChanges:$SkipPush
} finally {
  if ($startedServer -and -not $startedServer.HasExited) {
    Stop-Process -Id $startedServer.Id
  }
}
