param(
    [string]$Schemas = "public",
    [string]$OutFile,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/types/typescript?schemas=$([uri]::EscapeDataString($Schemas))"

if ($r -is [hashtable] -and $r.error) { Write-Host "`n  Error: $($r.error)" -ForegroundColor Red; return }

$types = if ($r.types) { $r.types } elseif ($r -is [string]) { $r } else { ($r | ConvertTo-Json -Depth 10) }

if ($OutFile) {
    $types | Out-File -FilePath $OutFile -Encoding UTF8
    Write-Host "`n  Wrote TypeScript types to $OutFile" -ForegroundColor Green
    Write-Host "  Size: $((Get-Item $OutFile).Length) bytes" -ForegroundColor DarkGray
} else {
    Write-Host "`n  === Generated TypeScript Types ===" -ForegroundColor Cyan
    Write-Host $types
}
Write-Host ""
