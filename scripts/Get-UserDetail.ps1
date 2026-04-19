param(
    [Parameter(Mandatory = $true)][string]$UserId,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/auth/users/$UserId/detail"

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    Write-Host ""
    return
}

$row = if ($r -is [array]) { $r[0] } else { $r }

Write-Host "`n  === User $UserId ===" -ForegroundColor Cyan
if ($row.user) {
    Write-Host "`n  Core:" -ForegroundColor Yellow
    $row.user | ConvertTo-Json -Depth 10 | Write-Host
}
Write-Host "`n  Identities ($($row.identities.Count)):" -ForegroundColor Yellow
$row.identities | Format-Table provider, email, last_sign_in_at, created_at -AutoSize | Out-String | Write-Host

Write-Host "  Sessions ($($row.sessions.Count)):" -ForegroundColor Yellow
$row.sessions | Format-Table id, created_at, refreshed_at, not_after, ip, user_agent -AutoSize | Out-String | Write-Host

Write-Host "  MFA factors ($($row.mfa_factors.Count)):" -ForegroundColor Yellow
$row.mfa_factors | Format-Table factor_type, status, friendly_name, created_at -AutoSize | Out-String | Write-Host

Write-Host "  Audit events: $($row.audit_events)" -ForegroundColor Yellow
Write-Host ""
