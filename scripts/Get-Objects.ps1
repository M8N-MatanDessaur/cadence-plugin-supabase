param(
    [Parameter(Mandatory = $true)][string]$Bucket,
    [string]$Prefix = "",
    [int]$Limit = 100,
    [int]$Offset = 0,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$body = @{
    prefix = $Prefix
    limit = $Limit
    offset = $Offset
    sortBy = @{ column = "name"; order = "asc" }
} | ConvertTo-Json -Depth 4

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/storage/list/$([uri]::EscapeDataString($Bucket))" `
    -Method POST -ContentType "application/json" -Body $body

if ($r.error) { Write-Host "`n  Error: $($r.error)" -ForegroundColor Red; return }

Write-Host "`n  === Objects in '$Bucket' $(if ($Prefix) { "/$Prefix" }) ===" -ForegroundColor Cyan
if (-not $r -or $r.Count -eq 0) { Write-Host "  (empty)" -ForegroundColor DarkGray; Write-Host ""; return }

$fmt = "  {0,-50} {1,12} {2,-22}"
Write-Host ($fmt -f "Name", "Size", "Updated") -ForegroundColor DarkGray
foreach ($o in $r) {
    $size = if ($o.metadata.size) { "$([math]::Round($o.metadata.size / 1KB, 1)) KB" } else { "-" }
    $upd = if ($o.updated_at) { ([datetime]$o.updated_at).ToString("yyyy-MM-dd HH:mm") } else { "" }
    Write-Host ($fmt -f $o.name, $size, $upd) -ForegroundColor White
}
Write-Host ""
