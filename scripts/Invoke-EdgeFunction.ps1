param(
    [Parameter(Mandatory = $true)][string]$Slug,
    [string]$Body = "{}",
    [string]$JsonFile,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

if ($JsonFile) {
    if (-not (Test-Path $JsonFile)) { Write-Host "`n  File not found: $JsonFile`n" -ForegroundColor Red; return }
    $Body = Get-Content $JsonFile -Raw -Encoding UTF8
}

try {
    $r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/edge/invoke/$([uri]::EscapeDataString($Slug))" `
        -Method POST -ContentType "application/json" -Body $Body
    Write-Host "`n  Invoked '$Slug':" -ForegroundColor Green
    $r | ConvertTo-Json -Depth 6 | Write-Host
} catch {
    Write-Host "`n  Error: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message -ForegroundColor DarkGray }
}
Write-Host ""
