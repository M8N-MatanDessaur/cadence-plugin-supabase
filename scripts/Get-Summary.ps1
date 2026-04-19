param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$s = Invoke-RestMethod "$ApiBase/api/plugins/supabase/summary"

if ($s.error) {
    Write-Host "`n  Error: $($s.error)" -ForegroundColor Red
    return
}

Write-Host "`n  === Supabase Project Summary ===" -ForegroundColor Cyan
Write-Host "  Project: $($s.project.name)" -ForegroundColor White
Write-Host ""

if ($s.summary) {
    $u = $s.summary
    Write-Host "  public.tables:       $($u.public_tables)" -ForegroundColor White
    Write-Host "  public.policies:     $($u.public_policies)" -ForegroundColor White
    Write-Host "  public.mat views:    $($u.public_matviews)" -ForegroundColor White
    Write-Host "  public.functions:    $($u.public_functions)" -ForegroundColor White
    Write-Host "  triggers:            $($u.triggers)" -ForegroundColor White
    Write-Host "  extensions:          $($u.extensions)" -ForegroundColor White
    Write-Host "  auth.users:          $($u.auth_users)" -ForegroundColor Green
    Write-Host "  storage.buckets:     $($u.buckets)" -ForegroundColor Green
    Write-Host "  storage.objects:     $($u.storage_objects)" -ForegroundColor Green
}
Write-Host ""
