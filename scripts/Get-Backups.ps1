param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/backups"

if ($r.error) { Write-Host "`n  Error: $($r.error)" -ForegroundColor Red; return }

Write-Host "`n  === Backups & PITR ===" -ForegroundColor Cyan
$backups = if ($r.backups) { $r.backups } else { $r }

if ($r.region) { Write-Host "  Region: $($r.region)" -ForegroundColor DarkGray }
if ($r.pitr_enabled) { Write-Host "  PITR: enabled" -ForegroundColor Green }
else { Write-Host "  PITR: disabled" -ForegroundColor DarkGray }

Write-Host ""
if (-not $backups -or $backups.Count -eq 0) { Write-Host "  (no backups listed)" -ForegroundColor DarkGray; Write-Host ""; return }
foreach ($b in $backups) {
    $when = if ($b.inserted_at) { $b.inserted_at } elseif ($b.created_at) { $b.created_at } else { "-" }
    Write-Host "  $when  status=$($b.status)  type=$($b.type)" -ForegroundColor White
}
Write-Host ""
