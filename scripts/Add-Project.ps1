param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$ProjectRef,
    [string]$ServiceRoleKey,
    [string]$AnonKey,
    [string]$Url,
    [string]$RepoPath,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$payload = @{
    name = $Name
    projectRef = $ProjectRef
    serviceRoleKey = $ServiceRoleKey
    anonKey = $AnonKey
    url = if ($Url) { $Url } else { "https://$ProjectRef.supabase.co" }
    repoPath = $RepoPath
} | ConvertTo-Json

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/projects" -Method POST `
    -ContentType "application/json" -Body $payload

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  Added project: $Name" -ForegroundColor Green
}
Write-Host ""
