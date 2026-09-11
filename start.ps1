$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 22.5 or newer is required." -ForegroundColor Red
  exit 1
}

$url = "http://127.0.0.1:3210"
Write-Host "Starting Bilibili favorite tag analyzer..." -ForegroundColor Cyan

try {
  $existing = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1
  if ($existing.ok) {
    Start-Process -FilePath "explorer.exe" -ArgumentList $url
    Write-Host "Service is already running: $url" -ForegroundColor Green
    exit 0
  }
} catch {
  # No existing service, continue with startup.
}

Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $projectRoot -WindowStyle Hidden

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 250
  try {
    $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1
    if ($health.ok) {
      Start-Process -FilePath "explorer.exe" -ArgumentList $url
      Write-Host "Started: $url" -ForegroundColor Green
      exit 0
    }
  } catch {
    # Keep waiting until the local service is ready.
  }
}

Write-Host "Startup timed out. Check whether port 3210 is already in use." -ForegroundColor Red
exit 1
