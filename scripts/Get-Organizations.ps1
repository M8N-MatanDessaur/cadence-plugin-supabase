param(
    [string]$Slug,
    [switch]$Members,
    [switch]$Projects,
    [switch]$Entitlements,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

if (-not $Slug) {
    $r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/mgmt/organizations"
    Write-Host "`n  === Organizations ===" -ForegroundColor Cyan
    if (-not $r -or $r.Count -eq 0) {
        Write-Host "  (none)" -ForegroundColor DarkGray
    } else {
        foreach ($o in $r) {
            Write-Host "  $($o.name)" -ForegroundColor White -NoNewline
            Write-Host "  (slug: $($o.slug), id: $($o.id))" -ForegroundColor DarkGray
        }
    }
    Write-Host ""
    return
}

$base = "$ApiBase/api/plugins/supabase/mgmt/organizations/$Slug"

if ($Members) {
    $r = Invoke-RestMethod "$base/members"
    Write-Host "`n  === Members of $Slug ===" -ForegroundColor Cyan
    foreach ($m in $r) {
        Write-Host "  $($m.email) - $($m.role_name -or $m.role)" -ForegroundColor White
    }
    Write-Host ""
    return
}

if ($Projects) {
    $r = Invoke-RestMethod "$base/projects"
    Write-Host "`n  === Projects in $Slug ===" -ForegroundColor Cyan
    foreach ($p in $r) {
        Write-Host "  $($p.name) ($($p.id -or $p.ref))" -ForegroundColor White
        if ($p.region) { Write-Host "     region: $($p.region)" -ForegroundColor DarkGray }
        if ($p.status) { Write-Host "     status: $($p.status)" -ForegroundColor DarkGray }
    }
    Write-Host ""
    return
}

if ($Entitlements) {
    $r = Invoke-RestMethod "$base/entitlements"
    Write-Host "`n  === Entitlements for $Slug ===" -ForegroundColor Cyan
    $r | ConvertTo-Json -Depth 10 | Write-Host
    Write-Host ""
    return
}

$r = Invoke-RestMethod $base
Write-Host "`n  === $Slug ===" -ForegroundColor Cyan
$r | ConvertTo-Json -Depth 10 | Write-Host
Write-Host ""
