param(
    [string]$Name,
    [string]$Value,
    [string]$JsonFile,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

if ($JsonFile) {
    if (-not (Test-Path $JsonFile)) { Write-Host "`n  File not found: $JsonFile`n" -ForegroundColor Red; return }
    $body = Get-Content $JsonFile -Raw -Encoding UTF8
} else {
    if (-not $Name -or -not $Value) {
        Write-Host "`n  Provide -Name and -Value, or -JsonFile with [{name, value}, ...]" -ForegroundColor Yellow
        return
    }
    if ($Name -like "SUPABASE_*") {
        Write-Host "`n  Secret names starting with 'SUPABASE_' are reserved and will be rejected." -ForegroundColor Red
        return
    }
    $body = @(@{ name = $Name; value = $Value }) | ConvertTo-Json -Depth 4
    if ($body -notmatch "^\[") { $body = "[$body]" }
}

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/secrets" -Method POST -ContentType "application/json" -Body $body

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  Secret(s) saved." -ForegroundColor Green
}
Write-Host ""
