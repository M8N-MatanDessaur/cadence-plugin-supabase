param(
    [string[]]$Services,
    [string]$Confirm,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$payload = @{}
if ($Services) { $payload.services = $Services }

$uri = "$ApiBase/api/plugins/supabase/mgmt/project/restart-services"
if ($Confirm) { $uri = "$uri?confirm=$Confirm" }

try {
    $r = Invoke-RestMethod $uri -Method POST -ContentType "application/json" -Body ($payload | ConvertTo-Json)
} catch {
    $resp = $_.Exception.Response
    if ($resp -and $resp.StatusCode.value__ -eq 409) {
        $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() | ConvertFrom-Json
        Write-Host "`n  Confirmation required: $($body.warning)" -ForegroundColor Yellow
        Write-Host "  Re-run with -Confirm $($body.token)" -ForegroundColor Cyan
        Write-Host ""
        return
    }
    throw
}

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  Services restarted." -ForegroundColor Green
}
Write-Host ""
