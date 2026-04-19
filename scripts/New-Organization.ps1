param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$payload = @{ name = $Name } | ConvertTo-Json

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/mgmt/organizations" `
    -Method POST -ContentType "application/json" -Body $payload

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  Created organization '$Name' (slug: $($r.slug), id: $($r.id))" -ForegroundColor Green
}
Write-Host ""
