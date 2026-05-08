param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Refresh-SessionPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $segments = foreach ($pathValue in @($machinePath, $userPath)) {
    if ($pathValue) {
      $pathValue -split ";"
    }
  }
  $segments = $segments | Where-Object { $_ }
  $env:Path = ($segments | Select-Object -Unique) -join ";"
}

function Test-CommandVersion {
  param(
    [string]$CommandName,
    [string[]]$Arguments = @("--version")
  )

  try {
    $null = & $CommandName @Arguments 2>$null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Test-PythonAvailable {
  return (Test-CommandVersion -CommandName "python") -or (Test-CommandVersion -CommandName "py" -Arguments @("-3", "--version"))
}

function Get-BrowserPath {
  $candidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  return $null
}

function Ensure-WingetAvailable {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    return
  }

  throw "winget is required for automatic setup. Install App Installer from Microsoft first, or install the prerequisites manually."
}

function Ensure-WingetPackage {
  param(
    [string]$PackageId,
    [string]$DisplayName,
    [scriptblock]$InstalledCheck,
    [switch]$RefreshPathAfterInstall,
    [string]$Scope
  )

  if (& $InstalledCheck) {
    Write-Host "$DisplayName already installed."
    return
  }

  Ensure-WingetAvailable
  $arguments = @(
    "install",
    "--exact",
    "--id", $PackageId,
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--disable-interactivity"
  )
  if ($Scope) {
    $arguments += @("--scope", $Scope)
  }

  if ($DryRun) {
    Write-Host "[dry-run] winget $($arguments -join ' ')"
    return
  } else {
    Write-Host "Installing $DisplayName..."
    & winget @arguments
  }

  if ($RefreshPathAfterInstall) {
    Refresh-SessionPath
  }

  if (& $InstalledCheck) {
    return
  }

  $exitCode = $LASTEXITCODE
  $scopeLabel = if ($Scope) { " (scope: $Scope)" } else { "" }
  throw "winget failed while installing $DisplayName from $PackageId$scopeLabel. Exit code: $exitCode"
}

function Ensure-PythonInstalled {
  if (Test-PythonAvailable) {
    Write-Host "Python 3 already installed."
    return
  }

  $pythonPackages = @(
    "Python.Python.3.13",
    "Python.Python.3.12",
    "Python.Python.3.11"
  )

  foreach ($packageId in $pythonPackages) {
    try {
      Ensure-WingetPackage -PackageId $packageId -DisplayName "Python 3" -InstalledCheck {
        Test-PythonAvailable
      } -RefreshPathAfterInstall -Scope "user"
      return
    } catch {
      Write-Warning $_.Exception.Message
    }
  }

  throw "Could not install Python 3 automatically. Install Python manually from https://www.python.org/downloads/windows/ and rerun setup-publish.cmd."
}

function Invoke-Checked {
  param(
    [string]$Label,
    [scriptblock]$Action
  )

  if ($DryRun) {
    Write-Host "[dry-run] $Label"
    return
  }

  Write-Host $Label
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed."
  }
}

Write-Host "Preparing this machine for publish-snapshot.cmd..."

Ensure-PythonInstalled

Ensure-WingetPackage -PackageId "OpenJS.NodeJS.LTS" -DisplayName "Node.js LTS" -InstalledCheck {
  Test-CommandVersion -CommandName "node"
} -RefreshPathAfterInstall

if (Get-BrowserPath) {
  Write-Host "Supported browser already installed."
} else {
  Ensure-WingetPackage -PackageId "Google.Chrome" -DisplayName "Google Chrome" -InstalledCheck {
    [bool](Get-BrowserPath)
  }
}

if (-not (Test-Path (Join-Path $repoRoot "package.json"))) {
  Write-Host "No package.json found; skipping npm install."
} elseif (Test-CommandVersion -CommandName "npm") {
  Invoke-Checked -Label "Installing npm dependencies..." -Action { npm install }
} else {
  throw "npm is not available after setup. Reopen the terminal and run setup-publish.cmd again."
}

if ($DryRun) {
  Write-Host "Dry run complete."
  return
}

Write-Host "Setup complete."
Write-Host "Next: run publish-snapshot.cmd"
