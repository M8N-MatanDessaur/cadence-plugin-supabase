param(
    [Parameter(Mandatory = $true)][string]$Table,
    [string]$Schema = "public",
    [switch]$Disable,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$op = if ($Disable) { "disable" } else { "enable" }
$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/rls/$op/$([uri]::EscapeDataString($Schema))/$([uri]::EscapeDataString($Table))" -Method POST

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  RLS $op`d on $Schema.$Table" -ForegroundColor Green
}
Write-Host ""
