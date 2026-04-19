param(
    [ValidateSet("overview","tables","indexes","unused-indexes","slow-queries","long-running","blocking","locks","cache-hit","vacuum","replication-slots","roles","bucket-sizes")]
    [string]$Kind = "overview",
    [int]$Limit = 50,
    [int]$MinMinutes = 5,
    [string]$Schema,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$path = switch ($Kind) {
    "overview"          { "/stats/db" }
    "tables"            { if ($Schema) { "/stats/tables?schema=$Schema" } else { "/stats/tables" } }
    "indexes"           { "/stats/indexes" }
    "unused-indexes"    { "/stats/unused-indexes" }
    "slow-queries"      { "/stats/slow-queries?limit=$Limit" }
    "long-running"      { "/stats/long-running?minMinutes=$MinMinutes" }
    "blocking"          { "/stats/blocking" }
    "locks"             { "/stats/locks" }
    "cache-hit"         { "/stats/cache-hit" }
    "vacuum"            { "/stats/vacuum" }
    "replication-slots" { "/stats/replication-slots" }
    "roles"             { "/stats/roles" }
    "bucket-sizes"      { "/stats/bucket-sizes" }
}

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase$path"

Write-Host "`n  === DB stats: $Kind ===" -ForegroundColor Cyan

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
