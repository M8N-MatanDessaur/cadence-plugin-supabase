param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$body = @{ name = $Name } | ConvertTo-Json

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/projects/active" -Method POST `
    -ContentType "application/json" -Body $body

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} elseif ($r.ok) {
    Write-Host "`n  Switched to project: $($r.activeProject)" -ForegroundColor Green
}
Write-Host ""
