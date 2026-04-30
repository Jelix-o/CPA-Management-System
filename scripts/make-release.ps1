param(
  [string]$OutputDir = "dist"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ReleaseName = "cpamc-sidecar-manager"
$DistPath = Join-Path $Root $OutputDir
$ZipPath = Join-Path $DistPath "$ReleaseName.zip"
$StageRoot = Join-Path $DistPath ".staging"
$StagePath = Join-Path $StageRoot $ReleaseName

New-Item -ItemType Directory -Path $DistPath -Force | Out-Null
if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}
if (Test-Path -LiteralPath $StageRoot) {
  Remove-Item -LiteralPath $StageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $StagePath -Force | Out-Null

$items = @(
  "server.js",
  "package.json",
  ".env.example",
  ".deployignore",
  "README.md",
  "DEPLOY_UBUNTU.md",
  "public",
  "deploy",
  "scripts"
)

foreach ($item in $items) {
  $source = Join-Path $Root $item
  $target = Join-Path $StagePath $item
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  }
}

Compress-Archive -Path (Join-Path $StagePath "*") -DestinationPath $ZipPath -Force
Remove-Item -LiteralPath $StageRoot -Recurse -Force
Write-Host "Release package created: $ZipPath"
