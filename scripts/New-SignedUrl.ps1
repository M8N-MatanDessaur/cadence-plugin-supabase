param(
    [Parameter(Mandatory = $true)][string]$Bucket,
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$ExpiresIn = 3600,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$body = @{ expiresIn = $ExpiresIn } | ConvertTo-Json
$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/storage/sign/$([uri]::EscapeDataString($Bucket))/$Path" `
    -Method POST -ContentType "application/json" -Body $body

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  Signed URL (valid for $ExpiresIn seconds):" -ForegroundColor Green
    Write-Host "  $($r.signedURL ? $r.signedURL : $r.signed_url)" -ForegroundColor Cyan
}
Write-Host ""
