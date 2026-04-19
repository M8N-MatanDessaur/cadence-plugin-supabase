param(
    [int]$Days = 7,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/usage/daily?days=$Days"

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    Write-Host ""
    return
}

Write-Host "`n  === Daily usage (last $Days days) ===" -ForegroundColor Cyan
$r | Format-Table day, new_users, active_users, new_sessions -AutoSize | Out-String | Write-Host
Write-Host ""
