# -- beadc -----------------------------------------------------------------------------------------
# beadc, Bead's builder, run from its image: the folder that holds beadc.yaml, the nearest upward or
# else this one, its physical path mounted at /work, the run kept in the same place under it, under
# an init that passes a signal on, with no network, no terminal, a read-only root and every
# capability dropped, the files written as the caller. --against-ref <ref>, the wrappers' own, pipes
# the project's git archive at that ref into the run, read by beadc as --against -. beadc.sh does
# the same with the arguments as the shell hands them; where a shell cannot, docs/support.md says so.
# Exit: beadc's own, 0, 1 or 2; 130 or 143 after an interrupt or a termination; 2 or 3 on
# --against-ref, refused or without git; 3 when the engine cannot run it, or a PowerShell older than
# 7.6 runs this.
#
#   ./beadc.ps1 generate --check
#   ./beadc.ps1 breaking --against-ref v0.3.0
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

$image = 'ghcr.io/francisdesjardins/beadc:0.3.0'
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

function Exit-Refusal([string] $reason) {
  [Console]::Error.Write("beadc: $reason`n")
  exit 2
}

# --against-ref <ref> or --against-ref=<ref>, taken out of the arguments, up to a bare --; every
# other argument passes as it is given. --against - given by hand, an archive on standard input
$ref = ''
$refs = 0
$against = $false
$archive = $false
$passed = @()
$trailing = @()
for ($index = 0; $index -lt $args.Count; $index++) {
  $token = "$($args[$index])"
  if ($token -ceq '--') {
    $trailing = @($args[$index..($args.Count - 1)])
    break
  }
  if ($token -ceq '--against-ref') {
    if ($index + 1 -ge $args.Count) {
      Exit-Refusal '--against-ref needs a ref: --against-ref <ref>'
    }
    $index++
    $ref = "$($args[$index])"
    $refs++
  } elseif ($token.StartsWith('--against-ref=', [System.StringComparison]::Ordinal)) {
    $ref = $token.Substring('--against-ref='.Length)
    $refs++
  } elseif ($token.StartsWith('--against-ref:', [System.StringComparison]::Ordinal)) {
    # ! pwsh -File splits a -name:value token at its colon, a session passes it whole: one form
    # refused here, where the wrapper sees it whole
    Exit-Refusal '--against-ref:<ref> is not read: write --against-ref <ref> or --against-ref=<ref>'
  } else {
    if ($token -ceq '--against') {
      $against = $true
      if ($index + 1 -lt $args.Count -and "$($args[$index + 1])" -ceq '-') {
        $archive = $true
      }
    } elseif ($token.StartsWith('--against=', [System.StringComparison]::Ordinal)) {
      $against = $true
      if ($token -ceq '--against=-') {
        $archive = $true
      }
    }
    $passed += , $args[$index]
  }
}

if ($refs -gt 1) {
  Exit-Refusal '--against-ref names one ref, once'
}
if ($refs -eq 1 -and $against) {
  Exit-Refusal '--against-ref and --against both name the earlier: give one'
}
if ($refs -eq 1 -and -not $ref) {
  Exit-Refusal '--against-ref needs a ref: --against-ref <ref>'
}

# ! in a session, what is piped to a script reaches it as PowerShell's objects, never the engine's
# standard input; a terminal is no archive: the engine would pass the keyboard on, and beadc wait
# for its end
if ($archive -and $MyInvocation.ExpectingInput) {
  Exit-Refusal 'in a session, an archive piped to beadc.ps1 reaches it as text: name a ref by --against-ref, or pipe the archive to pwsh -File'
}
if ($archive -and -not [Console]::IsInputRedirected) {
  Exit-Refusal '--against - reads an archive on standard input, not a terminal: pipe one in, or name a ref by --against-ref'
}

# the arguments beadc is given: --against - after them, and before a bare -- where there is one
$interactive = @()
$tail = @()
if ($refs -eq 1) {
  $tail = @('--against', '-')
}
if ($refs -eq 1 -or $archive) {
  $interactive = @('-i')
}

# the host, in the words both wrappers use: windows, macos or linux
$hostOs = 'linux'
if ($IsWindows) {
  $hostOs = 'windows'
} elseif ($IsMacOS) {
  $hostOs = 'macos'
}

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

# * the ref, checked on the host before the engine is asked anything: a work tree, a commit, and
# the project's folder in it, since git archive run from a folder its ref lacks fails
$git = $null
if ($refs -eq 1) {
  $git = Get-Command git -CommandType Application -ErrorAction Ignore | Select-Object -First 1
  if (-not $git) {
    Exit-Environment '--against-ref needs git on the path'
  }
  $inside = "$(& $git.Source -C $root rev-parse --is-inside-work-tree 2> $null)"
  if ($LASTEXITCODE -ne 0 -or $inside -cne 'true') {
    Exit-Refusal "--against-ref needs a git work tree: the project's folder is in none"
  }
  # ! a ref that starts with - would be read by git as an option
  if ($ref.StartsWith('-', [System.StringComparison]::Ordinal)) {
    Exit-Refusal "$ref names no commit"
  }
  $null = & $git.Source -C $root rev-parse --verify --quiet "$($ref)^{commit}" 2> $null
  if ($LASTEXITCODE -ne 0) {
    Exit-Refusal "$ref names no commit"
  }
  $folder = "$(& $git.Source -C $root rev-parse --show-prefix)"
  $null = & $git.Source -C $root cat-file -e "$($ref):$folder" 2> $null
  if ($LASTEXITCODE -ne 0) {
    Exit-Refusal "$ref holds no $($folder.TrimEnd('/'))"
  }
}

$found = Get-Command $engine -CommandType Application -ErrorAction Ignore | Select-Object -First 1
if (-not $found) {
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

# ! no --tty: a terminal ends each line with CRLF and merges stderr into stdout. -i where an archive
# comes on standard input
$run = @('run', '--rm', '--init') + $interactive
$run += '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL'
$run += '--security-opt', 'no-new-privileges', '--security-opt', 'label=disable'
$run += $user
$run += '--mount', "type=bind,`"source=$root`",target=/work", '--workdir', "/work$relative", $image
$run += $passed + $tail + $trailing

# The engine writes UTF-8, which a session decodes by the console's code page: read it as UTF-8 for
# the run alone, and give the process its own back, the exit taken once it is
$code = 3
$encoding = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  if ($refs -eq 1) {
    # * the archive piped as git writes it, into the image's /tmp and nowhere on the host, the
    # engine's output its own, as beadc.sh pipes it
    # ! by two processes of .NET's, not PowerShell's pipe, which drops the engine's exit when the
    # engine closes its standard input early, as beadc refusing its arguments or an engine that
    # cannot run the image do. A git archive that fails midway leaves beadc a truncated archive,
    # which it refuses
    $archiving = [System.Diagnostics.ProcessStartInfo]::new($git.Source)
    foreach ($argument in @('-C', $root, 'archive', '--format=tar', $ref)) {
      $archiving.ArgumentList.Add($argument)
    }
    $archiving.UseShellExecute = $false
    $archiving.RedirectStandardOutput = $true
    $running = [System.Diagnostics.ProcessStartInfo]::new($found.Source)
    foreach ($argument in $run) {
      $running.ArgumentList.Add("$argument")
    }
    $running.UseShellExecute = $false
    $running.RedirectStandardInput = $true
    $archiver = [System.Diagnostics.Process]::Start($archiving)
    $runner = $null
    try {
      $runner = [System.Diagnostics.Process]::Start($running)
      try {
        $archiver.StandardOutput.BaseStream.CopyTo($runner.StandardInput.BaseStream)
        $runner.StandardInput.Close()
      } catch [System.IO.IOException] {
        # the engine closed its standard input: git's rest read to its end, as a pipe would end it
        $archiver.StandardOutput.BaseStream.CopyTo([System.IO.Stream]::Null)
      }
      $runner.WaitForExit()
      $code = $runner.ExitCode
    } finally {
      if (-not $archiver.HasExited) {
        $archiver.Kill()
      }
      $archiver.WaitForExit()
      $archiver.Dispose()
      if ($runner) {
        $runner.Dispose()
      }
    }
  } else {
    & $engine @run
    $code = $LASTEXITCODE
  }
} finally {
  [Console]::OutputEncoding = $encoding
}

# the engine's own failures, the image it could not pull among them
if ($code -in 125, 126, 127) {
  Exit-Environment "$engine could not run $image (exit $code)"
}

exit $code
