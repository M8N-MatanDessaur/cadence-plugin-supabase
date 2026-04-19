param(
    [Parameter(Mandatory = $true)][string]$AddonType,
    [Parameter(Mandatory = $true)][string]$AddonVariant,
    [string]$Confirm,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$payload = @{
    addon_type = $AddonType
    addon_variant = $AddonVariant
} | ConvertTo-Json

$uri = "$ApiBase/api/plugins/supabase/mgmt/addons"
if ($Confirm) { $uri = "$uri?confirm=$Confirm" }

try {
    $r = Invoke-RestMethod $uri -Method PATCH -ContentType "application/json" -Body $payload
} catch {
    $resp = $_.Exception.Response
    if ($resp -and $resp.StatusCode.value__ -eq 409) {
        $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() | ConvertFrom-Json
        Write-Host "`n  Confirmation required: $($body.warning)" -ForegroundColor Yellow
        Write-Host "  Type: $($body.addon_type), Variant: $($body.addon_variant)" -ForegroundColor Gray
        Write-Host "  Re-run with -Confirm $($body.token)" -ForegroundColor Cyan
        Write-Host ""
        return
    }
    throw
}

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  Addon applied: $AddonType / $AddonVariant" -ForegroundColor Green
}
Write-Host ""
