param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$JsonFile,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

if (-not (Test-Path $JsonFile)) { Write-Host "`n  File not found: $JsonFile`n" -ForegroundColor Red; return }

$sql = Get-Content $JsonFile -Raw -Encoding UTF8
$body = @{ name = $Name; query = $sql } | ConvertTo-Json

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/migrations" -Method POST -ContentType "application/json" -Body $body

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  Migration '$Name' applied." -ForegroundColor Green
}
Write-Host ""
