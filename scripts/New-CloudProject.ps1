param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$OrganizationId,
    [Parameter(Mandatory = $true)][string]$DbPass,
    [Parameter(Mandatory = $true)][string]$Region,
    [string]$Plan = "free",
    [string]$DesiredInstanceSize,
    [string]$Confirm,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$payload = @{
    name = $Name
    organization_id = $OrganizationId
    db_pass = $DbPass
    region = $Region
    plan = $Plan
}
if ($DesiredInstanceSize) { $payload.desired_instance_size = $DesiredInstanceSize }

$uri = "$ApiBase/api/plugins/supabase/mgmt/projects"
if ($Confirm) { $uri = "$uri?confirm=$Confirm" }

try {
    $r = Invoke-RestMethod $uri -Method POST -ContentType "application/json" -Body ($payload | ConvertTo-Json)
} catch {
    $resp = $_.Exception.Response
    if ($resp -and $resp.StatusCode.value__ -eq 409) {
        $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() | ConvertFrom-Json
        Write-Host ""
        Write-Host "  Confirmation required:" -ForegroundColor Yellow
        Write-Host "  $($body.warning)" -ForegroundColor Yellow
        Write-Host "  Name:   $($body.name)" -ForegroundColor Gray
        Write-Host "  Org:    $($body.organization_id)" -ForegroundColor Gray
        Write-Host "  Region: $($body.region)" -ForegroundColor Gray
        Write-Host "  Plan:   $($body.plan)" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  Re-run with -Confirm $($body.token)" -ForegroundColor Cyan
        Write-Host ""
        return
    }
    throw
}

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
} else {
    Write-Host "`n  Created project '$Name' (ref: $($r.id -or $r.ref))" -ForegroundColor Green
    Write-Host "  Status: $($r.status)" -ForegroundColor Gray
    Write-Host "  Add it to Cadence via Add-Project -Name '$Name' -ProjectRef '$($r.id -or $r.ref)' ..." -ForegroundColor Gray
}
Write-Host ""
