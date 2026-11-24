$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location -LiteralPath $repoRoot

$localRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot '.firebase-local'))
if (-not $localRoot.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar)) { throw 'Unsafe local tools path.' }
New-Item -ItemType Directory -Force -Path $localRoot | Out-Null
$configRoot = Join-Path $localRoot 'config'
New-Item -ItemType Directory -Force -Path $configRoot | Out-Null
$env:XDG_CONFIG_HOME = $configRoot
$env:LOCAL_EMULATOR_ONLY = 'true'
$env:GCLOUD_PROJECT = 'demo-tigray-wallet'
$env:GOOGLE_CLOUD_PROJECT = 'demo-tigray-wallet'
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
$env:FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
Remove-Item Env:FIREBASE_SERVICE_ACCOUNT_JSON -ErrorAction SilentlyContinue
Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS -ErrorAction SilentlyContinue

$java = Get-Command java.exe -ErrorAction SilentlyContinue
if (-not $java) {
  $java = Get-ChildItem -LiteralPath (Join-Path $localRoot 'java') -Filter java.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $java) {
  Write-Host 'Java was not found. Downloading an isolated Eclipse Temurin JRE into .firebase-local ...'
  $zip = Join-Path $localRoot 'temurin-jre.zip'
  & curl.exe -L --fail --retry 3 -C - -o $zip 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse'
  if ($LASTEXITCODE -ne 0) { throw 'Temurin JRE download failed. Run the command again to resume it.' }
  $javaRoot = Join-Path $localRoot 'java'
  if (Test-Path -LiteralPath $javaRoot) { Remove-Item -LiteralPath $javaRoot -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $javaRoot -Force
  $java = Get-ChildItem -LiteralPath $javaRoot -Filter java.exe -File -Recurse | Select-Object -First 1
}
if (-not $java) { throw 'Java runtime could not be prepared.' }
$javaPath = if ($java.Path) { $java.Path } else { $java.FullName }
$env:JAVA_HOME = [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($javaPath))
$env:Path = (Join-Path $env:JAVA_HOME 'bin') + [IO.Path]::PathSeparator + $env:Path

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\firebase-tools\lib\bin\firebase.js'))) {
  Write-Host 'Installing pinned npm dependencies...'
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
}
& node.exe tools/local/start.cjs
exit $LASTEXITCODE
