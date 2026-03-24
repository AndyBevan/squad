param(
  [string]$ParentDir = "",
  [string]$Prefix = "squad_test_",
  [string]$Model = "gpt-5.4-mini",
  [switch]$SkipBuild,
  [switch]$SkipLink
)

$ErrorActionPreference = "Stop"

function Get-NextTestDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$NamePrefix
  )

  if (-not (Test-Path $Root)) {
    New-Item -ItemType Directory -Path $Root | Out-Null
  }

  $existing = Get-ChildItem -Path $Root -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "^$([regex]::Escape($NamePrefix))(\d{3})$" } |
    ForEach-Object { [int]$_.Name.Substring($NamePrefix.Length) }

  $next = if ($existing.Count -gt 0) {
    (($existing | Measure-Object -Maximum).Maximum + 1)
  } else {
    1
  }

  return Join-Path $Root ($NamePrefix + $next.ToString('000'))
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($ParentDir)) {
  $ParentDir = Split-Path $repoRoot -Parent
}

$sdkImportPath = "file:///" + (($repoRoot -replace '\\', '/') + '/packages/squad-sdk/dist/client/index.js')
$testDir = Get-NextTestDirectory -Root $ParentDir -NamePrefix $Prefix

Write-Host "Repo root: $repoRoot"
Write-Host "Test dir:  $testDir"

Push-Location $repoRoot
try {
  if (-not $SkipBuild) {
    Write-Host "Installing and building local packages..."
    npm install | Out-Host
    npm run build -w packages/squad-sdk | Out-Host
    npm run build -w packages/squad-cli | Out-Host
  }

  if (-not $SkipLink) {
    Write-Host "Linking local squad CLI..."
    Push-Location (Join-Path $repoRoot "packages\squad-cli")
    try {
      npm link | Out-Host
    } finally {
      Pop-Location
    }
  }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Path $testDir -Force | Out-Null
Set-Location $testDir

git init | Out-Host

Write-Host "Running squad init via linked local CLI..."
squad init | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "squad init failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path (Join-Path $testDir ".squad"))) {
  throw "Expected .squad to be created in $testDir"
}

Write-Host "Running Codex-backed SquadClient smoke test..."

$smokeScript = @"
import { SquadClient } from '${sdkImportPath}';

const client = new SquadClient({
  agentSdk: 'codex',
  cwd: process.cwd(),
  model: '${Model}',
});

await client.connect();
const session = await client.createSession();
const result = await session.sendAndWait({ prompt: 'Reply with exactly ok' });
console.log(JSON.stringify(result));
await session.close();
await client.disconnect();
"@

$smokeScript | node --input-type=module - | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "Codex smoke test failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Smoke test complete."
Write-Host "Created repo: $testDir"
