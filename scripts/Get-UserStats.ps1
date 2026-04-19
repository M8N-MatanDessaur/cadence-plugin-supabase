param(
    [ValidateSet("summary","growth","providers","mfa","sessions")]
    [string]$Kind = "summary",
    [int]$Days = 30,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$path = switch ($Kind) {
    "summary"   { "/stats/auth/summary" }
    "growth"    { "/stats/auth/growth?days=$Days" }
    "providers" { "/stats/auth/providers" }
    "mfa"       { "/stats/auth/mfa" }
    "sessions"  { "/stats/auth/sessions" }
}

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase$path"

Write-Host "`n  === Auth stats: $Kind ===" -ForegroundColor Cyan

if ($r.error) {
    Write-Host "  Error: $($r.error)" -ForegroundColor Red
    Write-Host ""
    return
}

if (-not $r -or $r.Count -eq 0) {
    Write-Host "  (no rows)" -ForegroundColor DarkGray
    Write-Host ""
    return
}

$r | Format-Table -AutoSize | Out-String | Write-Host
Write-Host ""
