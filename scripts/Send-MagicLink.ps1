param(
    [Parameter(Mandatory = $true)][string]$Email,
    [ValidateSet("magiclink", "recovery", "invite", "signup", "email_change_current", "email_change_new")]
    [string]$Type = "magiclink",
    [string]$RedirectTo,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$payload = @{ type = $Type; email = $Email }
if ($RedirectTo) { $payload.options = @{ redirect_to = $RedirectTo } }

$body = $payload | ConvertTo-Json -Depth 4
$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/auth/generate-link" -Method POST -ContentType "application/json" -Body $body

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  $Type link generated for $Email" -ForegroundColor Green
    if ($r.properties.action_link) {
        Write-Host "  Link: $($r.properties.action_link)" -ForegroundColor Cyan
    } elseif ($r.action_link) {
        Write-Host "  Link: $($r.action_link)" -ForegroundColor Cyan
    }
    Write-Host "  (Email was NOT sent. Copy this link to the user.)" -ForegroundColor DarkGray
}
Write-Host ""
