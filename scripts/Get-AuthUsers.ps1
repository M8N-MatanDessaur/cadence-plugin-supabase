param(
    [int]$Page = 1,
    [int]$PerPage = 50,
    [string]$ApiBase = "http://127.0.0.1:3800"
)

$r = Invoke-RestMethod "$ApiBase/api/plugins/supabase/auth/users?page=$Page&per_page=$PerPage"

if ($r.error) {
    Write-Host "`n  Error: $($r.error)" -ForegroundColor Red
    return
}

$users = if ($r.users) { $r.users } else { $r }

Write-Host "`n  === Auth Users (page $Page) ===" -ForegroundColor Cyan
Write-Host "  Total: $(if ($r.total) { $r.total } else { $users.Count })" -ForegroundColor DarkGray
Write-Host ""

$fmt = "  {0,-38} {1,-36} {2,-20}"
Write-Host ($fmt -f "ID", "Email", "Created") -ForegroundColor DarkGray
foreach ($u in $users) {
    $created = if ($u.created_at) { ([datetime]$u.created_at).ToString("yyyy-MM-dd") } else { "" }
    Write-Host ($fmt -f $u.id, $u.email, $created) -ForegroundColor White
}
Write-Host ""
