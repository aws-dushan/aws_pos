# Builds a One POS Device Service release (REQ HW-01): the service and tray as self-contained programs, the MSI installer, and
# publishes it to the One POS server's releases folder with latest.json { version, file, sha256 }. Every till's Device Service
# with auto-update on picks it up within 6 hours (or at once with "Check for updates" on the Devices screen or the tray).
#   .\tools\release-device-service.ps1 -Version 1.2.0 -WebOrigin https://pos.example.com
#   .\tools\release-device-service.ps1 -Version 1.2.0 -WebOrigin https://pos.example.com -Releases \\server\onepos\data\releases\device-service
# -WebOrigin: the One POS address the tills open. It's built into the installer, so on a till a double-click is enough.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$WebOrigin = "",
  [string]$Releases = (Join-Path $PSScriptRoot "..\data\releases\device-service")
)
$ErrorActionPreference = "Stop"
$WebOrigin = $WebOrigin.Trim().TrimEnd('/')
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$out = Join-Path $root "out\device-service\$Version"
$common = @("-c", "Release", "-r", "win-x64", "--self-contained", "-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true", "-p:Version=$Version")

dotnet publish (Join-Path $root "src\OnePos.DeviceService") @common -o (Join-Path $out "service")
if ($LASTEXITCODE) { throw "Publishing the service failed." }
dotnet publish (Join-Path $root "src\OnePos.DeviceTray") @common -o (Join-Path $out "tray")
if ($LASTEXITCODE) { throw "Publishing the tray failed." }
# A fresh installer build every time (a stale obj folder can skip making the MSI).
Remove-Item -Recurse -Force (Join-Path $root "installer\DeviceService\obj"), (Join-Path $root "installer\DeviceService\bin") -ErrorAction SilentlyContinue
dotnet build (Join-Path $root "installer\DeviceService") -c Release "-p:Version=$Version" "-p:ServiceDir=$out\service" "-p:TrayDir=$out\tray" "-p:DefaultWebOrigin=$($WebOrigin.TrimEnd('/'))" -o (Join-Path $out "msi")
if ($LASTEXITCODE) { throw "Building the installer failed." }

$msi = Join-Path $out "msi\OnePos.DeviceService-$Version.msi"
New-Item -ItemType Directory -Force $Releases | Out-Null
Copy-Item $msi $Releases -Force
$sha = (Get-FileHash $msi -Algorithm SHA256).Hash
@{ version = $Version; file = "OnePos.DeviceService-$Version.msi"; sha256 = $sha } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Releases "latest.json")
Write-Host "Released One POS Device Service $Version ($sha) to $Releases"
if ($WebOrigin) { Write-Host "Built for ${WebOrigin}: on a till, download it from Devices and double-click." }
else { Write-Host "No web address built in: tills install it with  msiexec /i <file> WEBORIGIN=https://<One POS address>" }
