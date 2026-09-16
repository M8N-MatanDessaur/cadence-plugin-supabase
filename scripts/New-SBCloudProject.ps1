<#
.SYNOPSIS
    Creates a new Supabase project in an organization (it bills the organization; the server answers with a token first, repeat with -ConfirmToken). Then add it here with Add-SBProject.
.EXAMPLE
    ./scripts/New-SBCloudProject.ps1 -OrganizationId <id> -Name 'my app' -Region us-east-1 -DbPassword '<strong>'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OrganizationId,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Region,
    [Parameter(Mandatory)][string]$DbPassword,
    [string]$ConfirmToken = ''
)
$ErrorActionPreference = 'Stop'
$CadenceApi = if ($env:CADENCE_API) { $env:CADENCE_API } else { 'http://127.0.0.1:3800' }
$headers = @{}
if ($env:CADENCE_TOKEN) { $headers['x-cadence-token'] = $env:CADENCE_TOKEN }
# -Project names one of the configured Supabase projects; blank means the active one (or the one whose repository the shell is on).
$projQ = if ($PSBoundParameters.ContainsKey('Project') -and $Project) { "project=$([uri]::EscapeDataString($Project))" } elseif ($env:CADENCE_ACTIVE_REPO_PATH) { "repo=$([uri]::EscapeDataString($env:CADENCE_ACTIVE_REPO_PATH))" } else { '' }
function With-Project($path) { if (-not $projQ) { return $path }; if ($path.Contains('?')) { "$path&$projQ" } else { "$path?$projQ" } }
function Get-Api($path) { Invoke-RestMethod -Uri "$CadenceApi$(With-Project $path)" -Headers $headers -TimeoutSec 300 }
function Get-Text($path) { (Invoke-WebRequest -UseBasicParsing -Uri "$CadenceApi$(With-Project $path)" -Headers $headers -TimeoutSec 300).Content }
function Send-Api($method, $path, $payload) { $args = @{ Uri = "$CadenceApi$(With-Project $path)"; Method = $method; Headers = $headers; TimeoutSec = 300 }; if ($null -ne $payload) { $args.ContentType = 'application/json; charset=utf-8'; $args.Body = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $payload -Depth 20)) }; Invoke-RestMethod @args }
function Post-Api($path, $payload) { Send-Api 'POST' $path $payload }
function Esc($s) { [uri]::EscapeDataString([string]$s) }
# -InputObject, not the pipeline: Windows PowerShell 5.1 wraps a piped JSON array in a {value, Count} object, and an empty one prints nothing.
function Out-Json($o, $d = 12) { ConvertTo-Json -InputObject $o -Depth $d }
# [string] strips the PSPath/PSDrive note properties Get-Content attaches; ConvertTo-Json would otherwise walk the provider graph and hang.
function Read-Text($file) { if (-not (Test-Path $file)) { throw "File not found: $file" }; [string](Get-Content $file -Raw -Encoding UTF8) }
function Read-JsonFile($file) { if (-not (Test-Path $file)) { throw "File not found: $file" }; ConvertFrom-Json -InputObject (Get-Content $file -Raw -Encoding UTF8) }
# A route that needs a confirmation answers 200 with confirmRequired and a token when asked softly (?soft=1); this prints it and stops unless -Confirm was passed.
function Fail-IfError($r) { if ($r -and $r.error -and -not $r.rows) { $m = if ($r.error -is [string]) { $r.error } else { ConvertTo-Json -InputObject $r.error -Compress }; throw "Supabase: $m" }; if ($r -and $r.message -and $r.code -and -not $r.id) { throw "Supabase: $($r.message) ($($r.code))" }; $r }
function Show-Confirm($r) { Write-Host ''; Write-Host "  Confirmation needed: $($r.warning)" -ForegroundColor Yellow; if ($r.destructive) { foreach ($d in $r.destructive) { Write-Host "    - $($d.kind): $($d.statement)" -ForegroundColor DarkYellow } }; Write-Host "  Run the same command again with -ConfirmToken $($r.token)   (valid 10 minutes)" -ForegroundColor Cyan; Write-Host '' }
$r = Post-Api "/api/plugins/supabase/mgmt/projects?$(if ($ConfirmToken) { "confirm=$(Esc $ConfirmToken)" } else { 'soft=1' })" @{ organization_id = $OrganizationId; name = $Name; region = $Region; db_pass = $DbPassword }
if ($r.confirmRequired) { Show-Confirm $r; return }
Fail-IfError $r | Out-Null
[pscustomobject]@{ ok = [bool]$r.id; ref = $r.id; name = $r.name; region = $r.region; status = $r.status } | ConvertTo-Json
