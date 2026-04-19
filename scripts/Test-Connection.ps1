param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/test"

Write-Host "`n  === Supabase Connection Test ===" -ForegroundColor Cyan

if ($r.managementToken) {
    $ok = $r.managementToken.ok
    $color = if ($ok) { "Green" } else { "Red" }
    Write-Host "  Management API: $(if ($ok) { 'OK' } else { 'FAIL' })  (HTTP $($r.managementToken.status))" -ForegroundColor $color
} else {
    Write-Host "  Management API: no PAT configured" -ForegroundColor Yellow
}

if ($r.project) {
    $ok = $r.project.ok
    $color = if ($ok) { "Green" } else { "Red" }
    Write-Host "  Project '$($r.project.name)' REST: $(if ($ok) { 'OK' } else { 'FAIL' })  (HTTP $($r.project.status))" -ForegroundColor $color
} else {
    Write-Host "  Project: not configured" -ForegroundColor Yellow
}
Write-Host ""
