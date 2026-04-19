param(
    [string]$Schema = "public",
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/triggers?schema=$([uri]::EscapeDataString($Schema))"
if ($r.error) { Write-Host "`n  Error: $($r.error)" -ForegroundColor Red; return }

Write-Host "`n  === Triggers in '$Schema' ===" -ForegroundColor Cyan
if (-not $r -or $r.Count -eq 0) { Write-Host "  (none)" -ForegroundColor DarkGray; Write-Host ""; return }

foreach ($t in $r) {
    Write-Host "`n  $($t.table).$($t.name)" -ForegroundColor Green
    Write-Host "    $($t.definition)" -ForegroundColor DarkGray
}
Write-Host ""
