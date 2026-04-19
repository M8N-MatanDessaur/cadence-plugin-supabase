param(
    [string]$Services = "db,auth,rest,realtime,storage,functions",
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/mgmt/project/health?services=$Services"

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    Write-Host ""
    return
}

Write-Host "`n  === Project service health ===" -ForegroundColor Cyan
foreach ($svc in $r) {
    $ok = $svc.status -eq "ACTIVE_HEALTHY" -or $svc.healthy -eq $true
    $color = if ($ok) { "Green" } else { "Red" }
    Write-Host "  $($svc.name -or $svc.service): $($svc.status -or $svc.healthy)" -ForegroundColor $color
}
Write-Host ""
