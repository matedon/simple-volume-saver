param(
  [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$sharedDir = Join-Path $repoRoot 'shared/common'
$distRoot = Join-Path $repoRoot 'dist'

$targets = @(
  [PSCustomObject]@{
    Name = 'chrome'
    SourceDir = Join-Path $repoRoot 'simple-volume-saver__chrome'
    ManifestPath = Join-Path $repoRoot 'simple-volume-saver__chrome/manifest.json'
    OutDir = Join-Path $distRoot 'chrome'
  },
  [PSCustomObject]@{
    Name = 'firefox'
    SourceDir = Join-Path $repoRoot 'simple-volume-saver__firefox'
    ManifestPath = Join-Path $repoRoot 'simple-volume-saver__firefox/manifest.json'
    OutDir = Join-Path $distRoot 'firefox'
  }
)

if (!(Test-Path -LiteralPath $sharedDir)) {
  throw "Shared directory not found: $sharedDir"
}

if (!(Test-Path -LiteralPath $distRoot)) {
  New-Item -ItemType Directory -Path $distRoot | Out-Null
}

foreach ($target in $targets) {
  if (!(Test-Path -LiteralPath $target.ManifestPath)) {
    throw "Manifest not found for $($target.Name): $($target.ManifestPath)"
  }

  if (Test-Path -LiteralPath $target.OutDir) {
    Remove-Item -LiteralPath $target.OutDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $target.OutDir | Out-Null

  Copy-Item -Path (Join-Path $sharedDir '*') -Destination $target.OutDir -Recurse -Force
  Copy-Item -LiteralPath $target.ManifestPath -Destination (Join-Path $target.OutDir 'manifest.json') -Force
}

if (!$SkipZip) {
  foreach ($target in $targets) {
    $manifest = Get-Content -Raw -LiteralPath $target.ManifestPath | ConvertFrom-Json
    $version = $manifest.version
    $zipPath = Join-Path $distRoot ("tab-sound-mixer-500-v$version-$($target.Name).zip")

    if (Test-Path -LiteralPath $zipPath) {
      Remove-Item -LiteralPath $zipPath -Force
    }

    Compress-Archive -Path (Join-Path $target.OutDir '*') -DestinationPath $zipPath -Force
  }
}

Write-Host 'Dist build completed.'
