$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "未找到 Node.js，请先安装 Node.js 22.5 或更高版本。" -ForegroundColor Red
  exit 1
}

$url = "http://127.0.0.1:3210"
Write-Host "正在启动 B站收藏夹标签统计..." -ForegroundColor Cyan

try {
  $existing = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1
  if ($existing.ok) {
    Start-Process $url
    Write-Host "服务已运行：$url" -ForegroundColor Green
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
      Start-Process $url
      Write-Host "已启动：$url" -ForegroundColor Green
      exit 0
    }
  } catch {
    # Keep waiting until the local service is ready.
  }
}

Write-Host "服务启动超时，请确认 3210 端口没有被占用。" -ForegroundColor Red
exit 1
