param(
    [Parameter(Mandatory = $true)][string]$Table,
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Schema = "public",
    [ValidateSet("ALL", "SELECT", "INSERT", "UPDATE", "DELETE")]
    [string]$Command = "ALL",
    [string[]]$Roles = @("authenticated"),
    [string]$Using,
    [string]$Check,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$body = @{
    schema = $Schema
    table = $Table
    name = $Name
    command = $Command
    roles = $Roles
    using = $Using
    check = $Check
} | ConvertTo-Json

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/policies" -Method POST -ContentType "application/json" -Body $body

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  Created policy '$Name' on $Schema.$Table ($Command)" -ForegroundColor Green
}
Write-Host ""
