param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/mgmt/addons"

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    Write-Host ""
    return
}

Write-Host "`n  === Billing addons ===" -ForegroundColor Cyan
if ($r.selected_addons) {
    Write-Host "`n  Currently selected:" -ForegroundColor Yellow
    foreach ($a in $r.selected_addons) {
        Write-Host "    $($a.type) - $($a.variant.identifier) ($($a.variant.name))" -ForegroundColor White
    }
}

if ($r.available_addons) {
    Write-Host "`n  Available:" -ForegroundColor Yellow
    foreach ($a in $r.available_addons) {
        Write-Host "    $($a.type) - $($a.name)" -ForegroundColor Gray
    }
}
Write-Host ""
