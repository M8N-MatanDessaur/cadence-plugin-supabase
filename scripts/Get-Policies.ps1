param(
    [string]$Schema = "public",
    [string]$Table,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$u = "$ApiBase/api/plugins/supabase/policies?schema=$([uri]::EscapeDataString($Schema))"
if ($Table) { $u += "&table=$([uri]::EscapeDataString($Table))" }
$r = Invoke-RestMethod $u

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    return
}

Write-Host "`n  === RLS Policies in $Schema$(if ($Table) { "." + $Table }) ===" -ForegroundColor Cyan
if (-not $r -or $r.Count -eq 0) { Write-Host "  (none)" -ForegroundColor DarkGray; Write-Host ""; return }

foreach ($p in $r) {
    Write-Host "`n  $($p.table).$($p.name)" -ForegroundColor Green
    Write-Host "    command: $($p.command)  roles: $($p.roles -join ',')" -ForegroundColor DarkGray
    if ($p.using_expression) { Write-Host "    using:   $($p.using_expression)" -ForegroundColor White }
    if ($p.check_expression) { Write-Host "    check:   $($p.check_expression)" -ForegroundColor White }
}
Write-Host ""
