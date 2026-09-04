<#
.SYNOPSIS
  Diagnose why an OpenLore agent cannot reach a shared `openlore serve` daemon on Windows.

.DESCRIPTION
  Run this on the machine where agents fail, and again on a machine where they work, then
  compare. It answers one question the CI job cannot: does THIS host let a spawned daemon
  outlive the agent that started it, and if not, what is stopping it.

  Three things are measured:

    1. Job Object membership and its limit flags. Windows only kills children on parent exit
       through a Job Object. libuv deliberately does not set CREATE_BREAKAWAY_FROM_JOB, so
       `detached: true` cannot escape one. If this host puts the agent in a job with
       KILL_ON_JOB_CLOSE, no amount of detaching helps and the daemon must be created out of
       band instead.

    2. Whether the daemon actually survives. A real `openlore mcp --daemon` session spawns it
       through the product's own code path; that session then exits, and THIS process — a
       different one — probes the daemon afterwards. That is exactly what a second agent does.

    3. The context needed to read the result: the host process chain, versions, the descriptor,
       whether the port is still listening, and the daemon's own serve.log.

  Read-only apart from the daemon it starts, which it stops again unless -KeepDaemon is passed.

.PARAMETER Directory
  Repository to diagnose. Defaults to the current directory.

.PARAMETER KeepDaemon
  Leave the daemon running at the end instead of stopping it.

.EXAMPLE
  pwsh -File scripts/diagnose-windows-daemon.ps1

.EXAMPLE
  pwsh -File scripts/diagnose-windows-daemon.ps1 -Directory C:\src\my-repo
#>

[CmdletBinding()]
param(
  [string]$Directory = (Get-Location).Path,
  [switch]$KeepDaemon
)

$ErrorActionPreference = 'Stop'
# A native command writing to stderr must not abort the run; failures are reported, not thrown.
$PSNativeCommandUseErrorActionPreference = $false

if ($env:OS -ne 'Windows_NT') {
  Write-Error 'This diagnostic is Windows-only: the question it answers (Job Object kill-on-close) does not exist elsewhere.'
  exit 2
}

$findings = [System.Collections.Generic.List[string]]::new()
function Add-Finding([string]$text) { $findings.Add($text) | Out-Null }
function Section([string]$title) { Write-Host ''; Write-Host "== $title" -ForegroundColor Cyan }
function Say([string]$label, $value) { Write-Host ("  {0,-26} {1}" -f $label, $value) }

# ---------------------------------------------------------------------------
# 1. Environment and host chain
# ---------------------------------------------------------------------------
Section 'Environment'
Say 'OS build' (Get-CimInstance Win32_OperatingSystem).BuildNumber
Say 'PowerShell' $PSVersionTable.PSVersion.ToString()
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'node is not on PATH. Open a shell where `node --version` works, then re-run.'
  exit 2
}
Say 'node' (& node --version)
Say 'directory' $Directory

$globalRoot = (& npm root -g)
$cliEntry = Join-Path $globalRoot 'openlore/dist/cli/index.js'
if (-not (Test-Path $cliEntry)) {
  Write-Error "openlore is not installed globally (looked for $cliEntry). Install it, then re-run."
  exit 2
}
Say 'openlore entry' $cliEntry
Say 'openlore version' (& node $cliEntry --version)

# The host chain names what is actually supervising the agent — an IDE, a terminal, a service
# wrapper. A Job Object almost always comes from one of these, not from Windows itself.
Section 'Host process chain'
$chain = @()
$walkId = $PID
for ($i = 0; $i -lt 8 -and $walkId; $i++) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $walkId" -ErrorAction SilentlyContinue
  if (-not $proc) { break }
  $chain += "$($proc.Name) ($($proc.ProcessId))"
  $walkId = $proc.ParentProcessId
  if ($walkId -eq 0) { break }
}
Say 'chain' ($chain -join '  <-  ')

# ---------------------------------------------------------------------------
# 2. Job Object membership and limit flags
# ---------------------------------------------------------------------------
Section 'Job Object'

Add-Type -Namespace OpenLoreDiag -Name Win32 -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);

[DllImport("kernel32.dll")]
public static extern IntPtr GetCurrentProcess();
'@

$inJob = $false
$queried = [OpenLoreDiag.Win32]::IsProcessInJob([OpenLoreDiag.Win32]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob)
if (-not $queried) {
  Say 'membership' 'could not be determined (IsProcessInJob failed)'
  Add-Finding 'Job Object membership is unknown; treat the survival result below as the only evidence.'
} elseif (-not $inJob) {
  Say 'membership' 'not in a Job Object'
} else {
  Say 'membership' 'IN a Job Object'
  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64; LimitFlags is a DWORD at
  # offset 16 (after two LARGE_INTEGERs). A NULL job handle queries the calling process's job.
  $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(144)
  try {
    $ok = [OpenLoreDiag.Win32]::QueryInformationJobObject([IntPtr]::Zero, 9, $buffer, 144, [IntPtr]::Zero)
    if ($ok) {
      $flags = [System.Runtime.InteropServices.Marshal]::ReadInt32($buffer, 16)
      Say 'limit flags' ('0x{0:X8}' -f $flags)
      $killOnClose = ($flags -band 0x2000) -ne 0
      $breakawayOk = ($flags -band 0x0800) -ne 0
      $silentBreakaway = ($flags -band 0x1000) -ne 0
      Say 'KILL_ON_JOB_CLOSE' $killOnClose
      Say 'BREAKAWAY_OK' $breakawayOk
      Say 'SILENT_BREAKAWAY_OK' $silentBreakaway
      if ($killOnClose -and -not ($breakawayOk -or $silentBreakaway)) {
        Add-Finding 'This host kills the whole job on close and forbids breakaway. `detached: true` cannot save the daemon here (libuv never sets CREATE_BREAKAWAY_FROM_JOB) — the daemon has to be created out of band, e.g. through WMI Win32_Process.Create.'
      } elseif ($killOnClose) {
        Add-Finding 'This host kills the job on close but PERMITS breakaway, so a daemon created with CREATE_BREAKAWAY_FROM_JOB would survive. Plain `detached: true` still would not.'
      } else {
        Add-Finding 'In a Job Object, but without KILL_ON_JOB_CLOSE — job membership alone should not kill the daemon.'
      }
    } else {
      Say 'limit flags' 'query failed'
    }
  } finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
}

# ---------------------------------------------------------------------------
# 3. Survival test through the product's own spawn path
# ---------------------------------------------------------------------------
Section 'Daemon survival'

$openloreDir = Join-Path $Directory '.openlore'
$descriptorPath = Join-Path $openloreDir 'serve.json'
$logPath = Join-Path $openloreDir 'serve.log'

if (-not (Test-Path (Join-Path $openloreDir 'analysis'))) {
  Say 'analysis' 'absent — tool calls will return errors, but the spawn is still exercised'
}

& node $cliEntry serve --stop --directory $Directory *> $null
Remove-Item $descriptorPath, $logPath -ErrorAction SilentlyContinue

# The daemon must be spawned by a process that then EXITS, so hold stdin open until the
# session has answered; the MCP server closes on stdin EOF without draining in-flight calls.
function Invoke-McpSession {
  param(
    [string[]]$ExtraArgs = @(),
    [string[]]$Requests,
    [int[]]$ExpectIds,
    [int]$TimeoutSec = 240
  )
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = 'node'
  foreach ($a in @($script:cliEntry) + $ExtraArgs) { $psi.ArgumentList.Add($a) }
  # `mcp` has no --directory flag (commander rejects unknown options, which would kill the
  # server before it spawns anything); it takes the repo from the working directory and from
  # each tool call's own `directory` argument.
  $psi.WorkingDirectory = $script:Directory
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.UseShellExecute = $false
  $proc = [System.Diagnostics.Process]::Start($psi)
  foreach ($r in $Requests) { $proc.StandardInput.WriteLine($r) }
  $proc.StandardInput.Flush()

  $seen = @{}
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ($true) {
    $remaining = [int](($deadline - (Get-Date)).TotalMilliseconds)
    if ($remaining -le 0) { break }
    $read = $proc.StandardOutput.ReadLineAsync()
    if (-not $read.Wait($remaining)) { break }
    $line = $read.Result
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    try { $obj = $line | ConvertFrom-Json } catch { continue }
    if ($null -ne $obj.id) { $seen[[int]$obj.id] = $obj }
    if (@($ExpectIds | Where-Object { -not $seen.ContainsKey($_) }).Count -eq 0) { break }
  }
  $proc.StandardInput.Close()
  if (-not $proc.WaitForExit(60000)) { $proc.Kill() }
  return $seen
}

$init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"openlore-windows-diagnostic","version":"1.0.0"}}}'
$ready = '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
# Built through ConvertTo-Json so the Windows path's backslashes are escaped correctly.
$call = @{
  jsonrpc = '2.0'
  id      = 3
  method  = 'tools/call'
  params  = @{
    name      = 'orient'
    arguments = @{ task = 'windows daemon diagnostic'; directory = $Directory }
  }
} | ConvertTo-Json -Depth 6 -Compress

$responses = Invoke-McpSession -ExtraArgs @('mcp', '--preset', 'full', '--daemon') `
               -Requests @($init, $ready, $call) -ExpectIds @(1, 3)
Say 'spawning session' ($(if ($responses.ContainsKey(1)) { 'answered and exited' } else { 'never answered — see stderr above' }))

if (-not (Test-Path $descriptorPath)) {
  Say 'descriptor' 'NOT written'
  Add-Finding 'The daemon never announced itself. It died before writing .openlore/serve.json, or was never launched — read serve.log below.'
} else {
  $desc = Get-Content $descriptorPath -Raw | ConvertFrom-Json
  $base = "http://$($desc.host):$($desc.port)"
  Say 'descriptor' "$base (pid $($desc.pid))"

  $alive = $null -ne (Get-Process -Id $desc.pid -ErrorAction SilentlyContinue)
  Say 'daemon process alive' $alive

  # Get-NetTCPConnection is absent on some trimmed Windows images; its absence is not a finding.
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $listening = $null -ne (Get-NetTCPConnection -LocalPort $desc.port -State Listen -ErrorAction SilentlyContinue)
    Say 'port listening' $listening
  } else {
    Say 'port listening' 'not checked (Get-NetTCPConnection unavailable)'
  }

  $headers = @{}
  if ($desc.token) { $headers['x-openlore-token'] = $desc.token }
  $healthy = $false
  try {
    $health = Invoke-RestMethod -Uri "$base/health" -Headers $headers -TimeoutSec 30
    $healthy = [bool]$health.ok
    Say 'health' ($(if ($healthy) { 'ok' } else { 'responded, not ok' }))
  } catch {
    Say 'health' "unreachable — $($_.Exception.Message)"
  }

  if ($healthy) {
    Add-Finding 'The daemon OUTLIVED the session that spawned it. Agent-to-daemon connection works on this host.'
  } elseif ($alive) {
    Add-Finding 'The daemon process is alive but not serving health. This is not a lifetime problem — suspect a firewall or a local security product blocking the loopback listener.'
  } else {
    Add-Finding 'The daemon was spawned, announced itself, and then DIED with the session that started it. That is the failure this diagnostic exists to catch; pair it with the Job Object result above.'
  }
}

Section 'serve.log (daemon output)'
if (Test-Path $logPath) { Get-Content $logPath -Tail 40 } else { Write-Host '  (no serve.log — the daemon produced no output)' }

Section 'Findings'
if ($findings.Count -eq 0) { Write-Host '  (none)' } else { $findings | ForEach-Object { Write-Host "  - $_" } }

if (-not $KeepDaemon) {
  & node $cliEntry serve --stop --directory $Directory *> $null
}
