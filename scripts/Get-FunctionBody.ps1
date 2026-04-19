param(
    [Parameter(Mandatory = $true)][string]$Slug,
    [string]$OutFile,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/edge/functions/$Slug/body"

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    Write-Host ""
    return
}

$body = if ($r -is [string]) { $r } elseif ($r.body) { $r.body } else { ($r | ConvertTo-Json -Depth 10) }

if ($OutFile) {
    [System.IO.File]::WriteAllText($OutFile, $body)
    Write-Host "`n  Wrote function body to $OutFile" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host $body
    Write-Host ""
}
