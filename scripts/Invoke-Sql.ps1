param(
    [Parameter(Mandatory = $true)][string]$Query,
    [switch]$ReadOnly,
    [switch]$Force,
    [string]$ConfirmToken,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$endpoint = if ($ReadOnly) { "/api/plugins/supabase/sql/select" } else { "/api/plugins/supabase/sql" }
$url = "$ApiBase$endpoint"
if ($ConfirmToken) { $url += "?confirm=$ConfirmToken" }

$body = @{
    query = $Query
    readOnly = [bool]$ReadOnly
    force = [bool]$Force
} | ConvertTo-Json -Depth 4

try {
    $r = Invoke-RestMethod $url -Method POST -ContentType "application/json" -Body $body
    if ($r.confirmRequired) {
        Write-Host "`n  Destructive SQL detected." -ForegroundColor Yellow
        foreach ($d in $r.destructive) {
            Write-Host "    - $($d.kind): $($d.statement.Substring(0, [Math]::Min(80, $d.statement.Length)))..." -ForegroundColor DarkYellow
        }
        Write-Host "  Retry with -ConfirmToken $($r.token)  (valid for 10 min)" -ForegroundColor Cyan
        Write-Host "  Or: -Force to skip the gate." -ForegroundColor DarkGray
        Write-Host ""
        return
    }
    if ($r.error) {
        Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    } else {
        if ($r -is [array]) {
            Write-Host "`n  Rows: $($r.Count)" -ForegroundColor Green
            $r | Format-Table -AutoSize | Out-String | Write-Host
        } else {
            $r | ConvertTo-Json -Depth 6 | Write-Host
        }
    }
} catch {
    $msg = $_.Exception.Message
    if ($_.ErrorDetails.Message) {
        try {
            $d = $_.ErrorDetails.Message | ConvertFrom-Json
            if ($d.confirmRequired) {
                Write-Host "`n  Destructive SQL detected." -ForegroundColor Yellow
                foreach ($x in $d.destructive) {
                    Write-Host "    - $($x.kind): $($x.statement)" -ForegroundColor DarkYellow
                }
                Write-Host "  Retry with -ConfirmToken $($d.token)" -ForegroundColor Cyan
                Write-Host ""
                return
            }
            $msg = $d.error ? $d.error : $msg
        } catch {}
    }
    Write-Host "`n  Error: $msg" -ForegroundColor Red
}
Write-Host ""
