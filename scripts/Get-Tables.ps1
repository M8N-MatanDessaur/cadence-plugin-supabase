param(
    [string]$Schema = "public",
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/tables?schema=$([uri]::EscapeDataString($Schema))"

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    return
}

Write-Host "`n  === Tables in schema '$Schema' ===" -ForegroundColor Cyan
Write-Host ""

if (-not $r -or $r.Count -eq 0) {
    Write-Host "  (no tables)" -ForegroundColor DarkGray
    Write-Host ""
    return
}

$fmt = "  {0,-36} {1,-18} {2,10} {3,12}"
Write-Host ($fmt -f "Name", "Kind", "Columns", "~ Rows") -ForegroundColor DarkGray
foreach ($t in $r) {
    Write-Host ($fmt -f $t.name, $t.kind, $t.column_count, $t.approx_rows) -ForegroundColor White
}
Write-Host ""
