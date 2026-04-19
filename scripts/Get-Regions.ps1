param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/mgmt/regions"

Write-Host "`n  === Available regions ===" -ForegroundColor Cyan
if (-not $r -or $r.Count -eq 0) {
    Write-Host "  (none returned)" -ForegroundColor DarkGray
} else {
    foreach ($reg in $r) {
        $code = if ($reg.region) { $reg.region } else { $reg }
        $name = if ($reg.name) { $reg.name } else { "" }
        Write-Host "  $code" -ForegroundColor White -NoNewline
        if ($name) { Write-Host "  - $name" -ForegroundColor DarkGray } else { Write-Host "" }
    }
}
Write-Host ""
