param(
    [switch]$InstalledOnly,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/extensions"
if ($r.error) { Write-Host "`n  Error: $($r.error)" -ForegroundColor Red; return }

Write-Host "`n  === Postgres Extensions ===" -ForegroundColor Cyan
$fmt = "  {0,-26} {1,-10} {2,-14} {3}"
Write-Host ($fmt -f "Name", "Installed", "Version", "Description") -ForegroundColor DarkGray
foreach ($e in $r) {
    if ($InstalledOnly -and -not $e.installed) { continue }
    $inst = if ($e.installed) { "yes" } else { "-" }
    $ver = if ($e.version) { $e.version } else { "-" }
    $desc = if ($e.description) { $e.description.Substring(0, [Math]::Min(60, $e.description.Length)) } else { "" }
    Write-Host ($fmt -f $e.name, $inst, $ver, $desc) -ForegroundColor White
}
Write-Host ""
