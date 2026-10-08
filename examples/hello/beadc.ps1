# -- beadc -----------------------------------------------------------------------------------------
# beadc, Bead's builder, run from its image: the folder that holds beadc.yaml, the nearest upward or
# else this one, its physical path mounted at /work, the run kept in the same place under it, under
# an init that passes a signal on, with no network, no terminal, a read-only root and every
# capability dropped, the files written as the caller. beadc.sh does the same with the arguments as
# the shell hands them; where a shell cannot, docs/support.md says so. Exit: beadc's own, 0, 1 or 2;
# 130 or 143 after an interrupt or a termination; 3 when the engine cannot run it, or a PowerShell
# older than 7.6 runs this.
#
#   ./beadc.ps1 generate --check
#   $env:BEADC_IMAGE = 'ghcr.io/francisdesjardins/beadc@sha256:...'; ./beadc.ps1 check
#   $env:BEADC_ENGINE = 'podman'; ./beadc.ps1 version

# ! PowerShell 7.6 and later, checked first. The whole script stays in the syntax Windows
# PowerShell 5.1 parses, no ternary, no ?? and no &&, since 5.1 parses it whole before it runs a
# line: refused here, as it drops an empty argument, a quote and a path's space from a native
# command's arguments
if ($PSVersionTable.PSVersion.Major -lt 7 -or ($PSVersionTable.PSVersion.Major -eq 7 -and $PSVersionTable.PSVersion.Minor -lt 6)) {
  [Console]::Error.Write("beadc: run beadc.ps1 with PowerShell 7.6 or later, pwsh, not $($PSVersionTable.PSVersion): or run beadc.sh`n")
  exit 3
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandArgumentPassing = 'Standard'
$PSNativeCommandUseErrorActionPreference = $false

$image = 'ghcr.io/francisdesjardins/beadc:0.2.0'
if ($env:BEADC_IMAGE) {
  $image = $env:BEADC_IMAGE
}
$engine = 'docker'
if ($env:BEADC_ENGINE) {
  $engine = $env:BEADC_ENGINE
}

# ! a line feed alone, as beadc.sh writes it: WriteLine ends a line with CRLF on Windows
function Exit-Environment([string] $reason) {
  [Console]::Error.Write("beadc: $reason`n")
  exit 3
}

# the host, in the words both wrappers use: windows, macos or linux
$hostOs = 'linux'
if ($IsWindows) {
  $hostOs = 'windows'
} elseif ($IsMacOS) {
  $hostOs = 'macos'
}

if (-not (Get-Command $engine -CommandType Application -ErrorAction Ignore)) {
  Exit-Environment "no $engine on the path: install Docker, or name another engine by BEADC_ENGINE"
}

# which engine it is, by what it reports, whatever its name: Podman behind Docker's name too
# ! compared case for case, as beadc.sh compares it: Podman writes its name in lower case
$reported = "$(& $engine --version 2> $null)"
$podman = $reported.StartsWith('podman version ', [System.StringComparison]::Ordinal)

# the engine's OS and whether it runs rootless, in one call; it fails when the engine is stopped
$format = '{{.OSType}} {{range .SecurityOptions}}{{if eq . "name=rootless"}}true{{end}}{{end}}'
if ($podman) {
  $format = '{{.Host.OS}} {{.Host.Security.Rootless}}'
}
$info = & $engine info --format $format 2> $null
if ($LASTEXITCODE -ne 0) {
  Exit-Environment "$engine does not answer: start it, then run beadc again"
}
$info = "$info"
if ($info.StartsWith('windows', [System.StringComparison]::Ordinal)) {
  Exit-Environment "$engine runs Windows containers: switch it to Linux containers"
}

# who writes the files: the caller. A rootless engine maps its root to the caller, Podman by
# keep-id; Docker Desktop on Windows maps every user to the caller, so the image's own runs there
# ! @( ) around the if: a branch of one element would come out a string, and @user would splat its
# characters
$rootless = $info.Substring($info.IndexOf(' ') + 1) -ceq 'true'
$user = @(if ($rootless -and $podman) {
    '--userns=keep-id'
  } elseif ($rootless) {
    '--user', '0:0'
  } elseif ($hostOs -eq 'windows') {
    '--user', '65532:65532'
  } else {
    '--user', "$(id -u):$(id -g)"
  })

# ! PowerShell reads a backslash as a separator on every platform, and cannot stand in a folder whose
# name holds one: it starts elsewhere
if (-not $IsWindows -and [System.IO.Directory]::GetCurrentDirectory().Contains('\')) {
  Exit-Environment 'PowerShell cannot run in a folder whose path holds a backslash: run beadc.sh'
}

# ! the physical path, asked of the system, as beadc.sh asks it: a link or a junction on the way
# resolved, whatever the session's location says. On Linux and macOS, pwd -P, which PowerShell runs
# in its location, so the kernel answers. Windows keeps a junction in a process's folder: there,
# each part of the path is looked at from the drive's root, and the walk starts again over a link's
# target until no part is a link, at most 40 times, as the kernel's ELOOP bounds it
if ($IsWindows) {
  $here = (Get-Location).ProviderPath
  $turns = 0
  $linked = $true
  while ($linked) {
    $linked = $false
    $prefix = [System.IO.Path]::GetPathRoot($here)
    $parts = $here.Substring($prefix.Length).Split([char[]] @('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)
    for ($index = 0; $index -lt $parts.Length; $index++) {
      $prefix = Join-Path $prefix $parts[$index]
      $item = Get-Item -LiteralPath $prefix -Force
      if ($item.LinkTarget) {
        $rest = [string]::Join('\', $parts, $index + 1, $parts.Length - $index - 1)
        $here = "$($item.ResolvedTarget)"
        if ($rest) {
          $here = Join-Path $here $rest
        }
        $linked = $true
        break
      }
    }
    $turns++
    if ($linked -and $turns -gt 40) {
      Exit-Environment "too many links in $((Get-Location).ProviderPath)"
    }
  }
} else {
  $here = "$(& /bin/pwd -P)"
}

# the root: the nearest folder upward that holds beadc.yaml, else this one
$root = $here
while (-not (Test-Path -LiteralPath (Join-Path $root 'beadc.yaml') -PathType Leaf) -and (Split-Path $root -Parent)) {
  $root = Split-Path $root -Parent
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'beadc.yaml') -PathType Leaf)) {
  $root = $here
}
$relative = $here.Substring($root.TrimEnd('\', '/').Length)
# ! a backslash is a separator on Windows alone: a Linux folder may hold one in its name
if ($IsWindows) {
  $relative = $relative.Replace('\', '/')
}

# ! no --tty: a terminal ends each line with CRLF and merges stderr into stdout. The engine writes
# UTF-8, which a session decodes by the console's code page: read it as UTF-8 for the run alone,
# and give the process its own back, the exit taken once it is
$code = 3
$encoding = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  & $engine run --rm --init --network none --read-only --tmpfs /tmp --cap-drop ALL `
    --security-opt no-new-privileges --security-opt label=disable @user `
    --mount "type=bind,`"source=$root`",target=/work" --workdir "/work$relative" `
    $image @args
  $code = $LASTEXITCODE
} finally {
  [Console]::OutputEncoding = $encoding
}

# the engine's own failures, the image it could not pull among them
if ($code -in 125, 126, 127) {
  Exit-Environment "$engine could not run $image (exit $code)"
}

exit $code
