param(
    [switch]$Util,
    [switch]$Autoscale,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$path = "/mgmt/disk"
if ($Util) { $path = "/mgmt/disk/util" }
elseif ($Autoscale) { $path = "/mgmt/disk/autoscale" }

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase$path"

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    Write-Host ""
    return
}

Write-Host "`n  === Disk ($(if ($Util) {'util'} elseif ($Autoscale) {'autoscale'} else {'config'})) ===" -ForegroundColor Cyan
$r | ConvertTo-Json -Depth 10 | Write-Host
Write-Host ""
