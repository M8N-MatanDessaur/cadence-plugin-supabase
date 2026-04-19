param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/schemas"
if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    return
}

Write-Host "`n  === Schemas ===" -ForegroundColor Cyan
foreach ($s in $r) { Write-Host "  $($s.name)" -ForegroundColor White }
Write-Host ""
