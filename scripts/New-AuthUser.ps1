param(
    [Parameter(Mandatory = $true)][string]$Email,
    [string]$Password,
    [switch]$SkipConfirm,
    [hashtable]$UserMetadata,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$payload = @{
    email = $Email
    email_confirm = -not $SkipConfirm
}
if ($Password) { $payload.password = $Password }
if ($UserMetadata) { $payload.user_metadata = $UserMetadata }

$body = $payload | ConvertTo-Json -Depth 4
$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/auth/users" -Method POST -ContentType "application/json" -Body $body

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} elseif ($r.id) {
    Write-Host "`n  Created user:" -ForegroundColor Green
    Write-Host "    id:    $($r.id)" -ForegroundColor White
    Write-Host "    email: $($r.email)" -ForegroundColor White
} else {
    $r | ConvertTo-Json -Depth 4 | Write-Host
}
Write-Host ""
