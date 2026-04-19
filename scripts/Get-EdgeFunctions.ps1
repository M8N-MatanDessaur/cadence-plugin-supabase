param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/edge/functions"

if ($r.error) { Write-Host "`n  Error: $($r.error)" -ForegroundColor Red; return }

Write-Host "`n  === Edge Functions ===" -ForegroundColor Cyan
if (-not $r -or $r.Count -eq 0) { Write-Host "  (none deployed)" -ForegroundColor DarkGray; Write-Host ""; return }

$fmt = "  {0,-28} {1,-12} {2,-10} {3}"
Write-Host ($fmt -f "Slug", "Status", "Verify JWT", "Updated") -ForegroundColor DarkGray
foreach ($f in $r) {
    $upd = if ($f.updated_at) { ([datetimeoffset]::FromUnixTimeMilliseconds($f.updated_at)).ToString("yyyy-MM-dd") } else { "-" }
    $vjwt = if ($f.verify_jwt) { "yes" } else { "no" }
    Write-Host ($fmt -f $f.slug, $f.status, $vjwt, $upd) -ForegroundColor White
}
Write-Host ""
