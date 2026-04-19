param(
    [switch]$ShowValues,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/secrets"

if ($r.error) { Write-Host "`n  Error: $($r.error)" -ForegroundColor Red; return }

Write-Host "`n  === Function Secrets ===" -ForegroundColor Cyan
if (-not $r -or $r.Count -eq 0) { Write-Host "  (none)" -ForegroundColor DarkGray; Write-Host ""; return }

foreach ($s in $r) {
    $val = if ($ShowValues -and $s.value) { $s.value } else { "***" }
    Write-Host "  $($s.name) = $val" -ForegroundColor White
}
Write-Host ""
