param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/storage/buckets"

if ($r.error) { Write-Host "`n  Error: $($r.error)" -ForegroundColor Red; return }

Write-Host "`n  === Storage Buckets ===" -ForegroundColor Cyan
if (-not $r -or $r.Count -eq 0) { Write-Host "  (none)" -ForegroundColor DarkGray; Write-Host ""; return }

$fmt = "  {0,-32} {1,-8} {2,-15} {3}"
Write-Host ($fmt -f "Name", "Public", "Size Limit", "MIME Types") -ForegroundColor DarkGray
foreach ($b in $r) {
    $pub = if ($b.public) { "yes" } else { "no" }
    $size = if ($b.file_size_limit) { "$([math]::Round($b.file_size_limit / 1MB, 2)) MB" } else { "-" }
    $mimes = if ($b.allowed_mime_types) { ($b.allowed_mime_types -join ",") } else { "*" }
    Write-Host ($fmt -f $b.name, $pub, $size, $mimes) -ForegroundColor White
}
Write-Host ""
