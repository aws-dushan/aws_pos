# Installs the One POS Device Service on a till (run in an elevated PowerShell on the till).
#   1. Publish:  dotnet publish src/OnePos.DeviceService -c Release -r win-x64 --self-contained -o publish/device
#   2. Copy publish/device to the till, e.g. C:\Program Files\OnePos\DeviceService
#   3. Run this script there:  .\install-device-service.ps1 -Path "C:\Program Files\OnePos\DeviceService" -WebOrigin "https://pos.example.com"
param(
  [string]$Path = "C:\Program Files\OnePos\DeviceService",
  [string]$WebOrigin = "http://localhost:3100"
)
$exe = Join-Path $Path "OnePos.DeviceService.exe"
if (-not (Test-Path $exe)) { throw "OnePos.DeviceService.exe not found in $Path" }
# The web app's address may use the service (more can be added in %ProgramData%\OnePos\device.json).
$settings = Join-Path $env:ProgramData "OnePos\device.json"
if (-not (Test-Path $settings)) {
  New-Item -ItemType Directory -Force (Split-Path $settings) | Out-Null
  @{ allowedOrigins = @($WebOrigin); paperWidth = 80; drawerOnCash = $true } | ConvertTo-Json | Set-Content -Encoding utf8 $settings
}
sc.exe create OnePosDevice binPath= "`"$exe`"" start= auto DisplayName= "One POS Device Service" | Out-Null
sc.exe description OnePosDevice "Receipt printer, cash drawer and pole display for One POS by AWS Distribution" | Out-Null
sc.exe failure OnePosDevice reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null
Start-Service OnePosDevice
Write-Host "One POS Device Service installed and running on http://127.0.0.1:5199"
