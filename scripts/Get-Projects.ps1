param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/projects"

Write-Host "`n  === Supabase Projects ===" -ForegroundColor Cyan
Write-Host "  Management token: $(if ($r.managementTokenSet) { 'set' } else { 'NOT set' })" -ForegroundColor $(if ($r.managementTokenSet) { 'Green' } else { 'Red' })
Write-Host "  Active project:   $($r.activeProject)" -ForegroundColor Yellow
Write-Host ""

if (-not $r.projects -or $r.projects.Count -eq 0) {
    Write-Host "  No projects configured. Open the Supabase settings tab to add one." -ForegroundColor DarkGray
    Write-Host ""
    return
}

foreach ($p in $r.projects) {
    $marker = if ($p.name -eq $r.activeProject) { "*" } else { " " }
    $color = if ($p.name -eq $r.activeProject) { "Green" } else { "White" }
    Write-Host "  $marker $($p.name)" -ForegroundColor $color -NoNewline
    Write-Host "  ($($p.projectRef))" -ForegroundColor DarkGray
    if ($p.url) { Write-Host "     $($p.url)" -ForegroundColor DarkGray }
}
Write-Host ""
