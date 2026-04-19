param(
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$h = Invoke-RestMethod "$ApiBase/api/plugins/supabase/health"

if ($h.error) {
    Write-Host "`n  Error: $($h.error)" -ForegroundColor Red
    return
}

Write-Host "`n  === Supabase Health ===" -ForegroundColor Cyan
Write-Host "  Project: $($h.project.name) ($($h.project.projectRef))" -ForegroundColor White
Write-Host "  URL:     $($h.project.url)" -ForegroundColor DarkGray

if ($h.database) {
    Write-Host "`n  Database:       $($h.database.database)" -ForegroundColor White
    Write-Host "  Postgres:       $($h.database.pg_version)" -ForegroundColor DarkGray
    Write-Host "  User schemas:   $($h.database.user_schemas)" -ForegroundColor White
    Write-Host "  Tables:         $($h.database.table_count)" -ForegroundColor Green
}
Write-Host ""
