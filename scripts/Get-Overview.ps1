param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/stats/overview"

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    Write-Host ""
    return
}

$row = if ($r -is [array]) { $r[0] } else { $r }
$o = $row.overview

if (-not $o) {
    Write-Host "`n  (no data)" -ForegroundColor DarkGray
    Write-Host ""
    return
}

Write-Host "`n  === Project overview ===" -ForegroundColor Cyan
Write-Host "`n  Database:" -ForegroundColor Yellow
Write-Host "    Size:        $([math]::Round($o.database.size_bytes / 1048576, 2)) MB"
Write-Host "    Connections: $($o.database.connections) / $($o.database.max_connections)"
Write-Host "    Version:     $($o.database.pg_version)"

Write-Host "`n  Auth:" -ForegroundColor Yellow
Write-Host "    Users:       $($o.auth.total_users)  (confirmed: $($o.auth.confirmed), banned: $($o.auth.banned))"
Write-Host "    Signups 24h: $($o.auth.signups_24h)"
Write-Host "    Active 24h:  $($o.auth.active_24h)"

Write-Host "`n  Storage:" -ForegroundColor Yellow
Write-Host "    Buckets:  $($o.storage.buckets)"
Write-Host "    Objects:  $($o.storage.objects)"
Write-Host "    Size:     $([math]::Round($o.storage.bytes / 1048576, 2)) MB"

Write-Host "`n  Schema:" -ForegroundColor Yellow
Write-Host "    Tables:     $($o.schema_counts.public_tables) (public)"
Write-Host "    Policies:   $($o.schema_counts.public_policies)"
Write-Host "    Functions:  $($o.schema_counts.public_functions)"
Write-Host "    Triggers:   $($o.schema_counts.triggers)"
Write-Host "    Extensions: $($o.schema_counts.extensions)"
Write-Host ""
