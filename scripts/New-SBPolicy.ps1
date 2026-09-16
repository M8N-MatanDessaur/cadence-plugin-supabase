<#
.SYNOPSIS
    Creates a row level security policy: command (SELECT, INSERT, UPDATE, DELETE, ALL), roles, a USING expression and a WITH CHECK expression.
.EXAMPLE
    ./scripts/New-SBPolicy.ps1 -Table profiles -Name 'Users read their own row' -Command SELECT -Roles authenticated -Using 'auth.uid() = id'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Table,
    [Parameter(Mandatory)][string]$Name,
    [ValidateSet('SELECT','INSERT','UPDATE','DELETE','ALL')][string]$Command = 'ALL',
    [string[]]$Roles = @('authenticated'),
    [string]$Using = '',
    [string]$Check = '',
    [string]$Schema = 'public',
    [string]$Project = ''
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
$payload = @{ schema = $Schema; table = $Table; name = $Name; command = $Command; roles = $Roles }
if ($Using) { $payload.using = $Using }
if ($Check) { $payload.check = $Check }
$r = Fail-IfError (Post-Api "/api/plugins/supabase/policies" $payload)
[pscustomobject]@{ ok = $true; policy = $Name; table = "$Schema.$Table"; command = $Command; roles = $Roles } | ConvertTo-Json
