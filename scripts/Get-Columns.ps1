param(
    [Parameter(Mandatory = $true)][string]$Table,
    [string]$Schema = "public",
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/tables/$([uri]::EscapeDataString($Schema))/$([uri]::EscapeDataString($Table))"

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    return
}

Write-Host "`n  === Columns of $Schema.$Table ===" -ForegroundColor Cyan
Write-Host ""
$fmt = "  {0,-26} {1,-26} {2,-6} {3,-30}"
Write-Host ($fmt -f "Name", "Type", "PK", "Default") -ForegroundColor DarkGray
foreach ($c in $r) {
    $pk = if ($c.is_primary_key) { "yes" } else { "" }
    $def = if ($c.default_value) { $c.default_value } else { "" }
    Write-Host ($fmt -f $c.name, $c.type, $pk, $def) -ForegroundColor White
}
Write-Host ""
