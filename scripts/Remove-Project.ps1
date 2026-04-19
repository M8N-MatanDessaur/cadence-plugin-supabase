param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/projects/$([uri]::EscapeDataString($Name))" -Method DELETE

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  Removed project: $Name" -ForegroundColor Yellow
    if ($r.activeProject) {
        Write-Host "  Active project is now: $($r.activeProject)" -ForegroundColor DarkGray
    }
}
Write-Host ""
