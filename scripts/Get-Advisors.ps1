param(
    [ValidateSet("security", "performance", "both")]
    [string]$Kind = "both",
    [string]$ApiBase = "http://127.0.0.1:3800"
)

function Show-Set($title, $data) {
    Write-Host "`n  === $title ===" -ForegroundColor Cyan
    if ($data.error) { Write-Host "  Error: $($data.error)" -ForegroundColor Red; return }
    $lints = if ($data.lints) { $data.lints } else { $data }
    if (-not $lints -or $lints.Count -eq 0) { Write-Host "  (all clear)" -ForegroundColor Green; return }
    foreach ($l in $lints) {
        $color = switch ($l.level) { "ERROR" { "Red" } "WARN" { "Yellow" } default { "DarkGray" } }
        Write-Host "  [$($l.level)] $($l.title)" -ForegroundColor $color
        if ($l.description) { Write-Host "    $($l.description)" -ForegroundColor DarkGray }
        if ($l.detail) { Write-Host "    $($l.detail)" -ForegroundColor DarkGray }
    }
}

if ($Kind -eq "security" -or $Kind -eq "both") {
    $s = Invoke-RestMethod "$ApiBase/api/plugins/supabase/advisors/security"
    Show-Set "Security Advisors" $s
}
if ($Kind -eq "performance" -or $Kind -eq "both") {
    $p = Invoke-RestMethod "$ApiBase/api/plugins/supabase/advisors/performance"
    Show-Set "Performance Advisors" $p
}
Write-Host ""
