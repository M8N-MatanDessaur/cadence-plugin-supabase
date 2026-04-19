param(
    [string]$Sql = "select timestamp, event_message from postgres_logs order by timestamp desc limit 50",
    [string]$Start,
    [string]$End,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$payload = @{ sql = $Sql }
if ($Start) { $payload.iso_timestamp_start = $Start }
if ($End) { $payload.iso_timestamp_end = $End }
$body = $payload | ConvertTo-Json

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/logs" -Method POST -ContentType "application/json" -Body $body

if ($r.error) { Write-Host "`n  Error: $($r.error)" -ForegroundColor Red; return }

Write-Host "`n  === Log Results ===" -ForegroundColor Cyan
$result = if ($r.result) { $r.result } else { $r }
foreach ($row in $result) {
    $ts = $row.timestamp
    $msg = $row.event_message
    Write-Host "  [$ts] $msg" -ForegroundColor White
}
Write-Host ""
