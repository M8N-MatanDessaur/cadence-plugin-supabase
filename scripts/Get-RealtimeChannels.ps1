param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/realtime/channels"

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    Write-Host ""
    return
}

Write-Host "`n  === Realtime channels ===" -ForegroundColor Cyan
if (-not $r -or ($r.data -and $r.data.Count -eq 0)) {
    Write-Host "  (none active)" -ForegroundColor DarkGray
    Write-Host ""
    return
}
$channels = if ($r.data) { $r.data } else { $r }
foreach ($c in $channels) {
    Write-Host "  $($c.name)  (connected: $($c.connected_at -or '-'))" -ForegroundColor White
}
Write-Host ""
