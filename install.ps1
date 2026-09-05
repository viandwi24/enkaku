# Enkaku installer for native Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/viandwi24/enkaku/main/install.ps1 | iex
#
# Downloads the self-contained enkaku.exe for this machine from the latest
# GitHub release, verifies it against the release's SHA256SUMS.txt, installs it
# into %USERPROFILE%\.enkaku\bin, and puts that directory on the user PATH.
#
# install.sh is the same tool for Linux, macOS and Git Bash. This file exists
# because native PowerShell and cmd have no `sh` to pipe into, so the shell
# one-liner cannot run there at all.
#
# `irm | iex` cannot pass parameters, so options are read from the environment:
#
#   $env:ENKAKU_VERSION      = 'v0.1.30'    # a specific release, not the latest
#   $env:ENKAKU_INSTALL_DIR  = 'C:\enkaku'  # somewhere other than ~\.enkaku\bin
#   $env:ENKAKU_NO_MODIFY_PATH = '1'        # leave PATH alone
#   $env:ENKAKU_REPO         = 'you/fork'
#
# Saved to a file, the same options are also plain parameters:
#   .\install.ps1 -Version v0.1.30 -Dir C:\enkaku -NoModifyPath

param(
  [string] $Version,
  [string] $Dir,
  [switch] $NoModifyPath
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 still defaults to TLS 1.0 against some endpoints, which
# GitHub refuses outright. Harmless on PowerShell 7+, where this is already the
# default.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$repo = if ($env:ENKAKU_REPO) { $env:ENKAKU_REPO } else { 'viandwi24/enkaku' }
if (-not $Version -and $env:ENKAKU_VERSION) { $Version = $env:ENKAKU_VERSION }
if (-not $Dir -and $env:ENKAKU_INSTALL_DIR) { $Dir = $env:ENKAKU_INSTALL_DIR }
if (-not $NoModifyPath -and $env:ENKAKU_NO_MODIFY_PATH) { $NoModifyPath = $true }
if (-not $Dir) { $Dir = Join-Path $env:USERPROFILE '.enkaku\bin' }

# A tag goes straight into a URL below. Reject anything that is not plausibly a
# tag rather than letting it build a surprising one.
if ($Version -and $Version -notmatch '^[A-Za-z0-9._-]+$') {
  throw "'$Version' is not a valid release tag."
}

# ---- Which build ------------------------------------------------------------
# The release matrix (.github/workflows/release.yml) builds windows-x64 only.
# Windows on ARM runs x64 binaries under emulation, so that is what an arm64
# machine gets -- said out loud rather than silently.
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq 'ARM64') {
  Write-Host 'Windows on ARM detected -- installing the x64 build, which runs under emulation.'
} elseif ($arch -ne 'AMD64') {
  throw "Unsupported architecture '$arch'. The release only builds windows-x64."
}
$target = 'windows-x64'

# ---- Which version ----------------------------------------------------------
# Only the tag is read from the API; the asset URL is constructed from the
# naming convention in scripts/build-release.sh, exactly as install.sh and
# scripts/enkaku-update.sh do it.
if (-not $Version) {
  Write-Host "Looking up the latest $repo release..."
  try {
    $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" `
      -Headers @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'enkaku-installer' }
  } catch {
    throw "Could not reach the GitHub API. Check the network, or set `$env:ENKAKU_VERSION to skip the lookup. ($_)"
  }
  $Version = $latest.tag_name
}
if (-not $Version) { throw 'Could not determine the latest version.' }

Write-Host "  release: $Version"
Write-Host "  target:  $target"
Write-Host "  into:    $Dir"

# ---- Download, verify, install ----------------------------------------------
$asset = "enkaku-$Version-$target.zip"
$base  = "https://github.com/$repo/releases/download/$Version"
$work  = Join-Path ([IO.Path]::GetTempPath()) ("enkaku-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
  Write-Host "Downloading $asset..."
  # Invoke-WebRequest's progress bar makes a large download dramatically slower
  # in Windows PowerShell 5.1; it is restored in the finally block below.
  $prevProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri "$base/$asset" -OutFile (Join-Path $work $asset) -UseBasicParsing
  } catch {
    throw "Could not download $base/$asset -- check that $Version published a build for $target. ($_)"
  } finally {
    $ProgressPreference = $prevProgress
  }

  # The release publishes SHA256SUMS.txt over the whole artifact set. Verified
  # when it is available, and SKIPPED LOUDLY rather than silently when it is
  # not -- an unverified install that looks identical to a verified one is how a
  # bad mirror goes unnoticed.
  $sums = $null
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri "$base/SHA256SUMS.txt" -OutFile (Join-Path $work 'SHA256SUMS.txt') -UseBasicParsing
    $sums = Get-Content (Join-Path $work 'SHA256SUMS.txt')
  } catch {
    Write-Warning "SHA256SUMS.txt is not published for $Version -- continuing without verification."
  } finally {
    $ProgressPreference = $prevProgress
  }

  if ($sums) {
    # Lines are "<hash>  <name>" or "<hash> *<name>" (binary mode).
    $line = $sums | Where-Object { $_ -match ('\s\*?' + [Regex]::Escape($asset) + '\s*$') } | Select-Object -First 1
    if (-not $line) {
      Write-Warning "$asset is not listed in SHA256SUMS.txt -- continuing without verification."
    } else {
      $expected = ($line -split '\s+')[0]
      $actual = (Get-FileHash -Path (Join-Path $work $asset) -Algorithm SHA256).Hash
      if ($actual -ine $expected) {
        throw "Checksum mismatch for $asset.`n  expected $expected`n  actual   $actual`nRefusing to install."
      }
      Write-Host 'Checksum verified.'
    }
  }

  Write-Host 'Extracting...'
  $x = Join-Path $work 'x'
  Expand-Archive -Path (Join-Path $work $asset) -DestinationPath $x -Force
  $exe = Join-Path $x 'enkaku.exe'
  if (-not (Test-Path $exe)) { throw "'enkaku.exe' not found inside $asset." }

  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  $binary = Join-Path $Dir 'enkaku.exe'

  # Windows refuses to overwrite or delete a RUNNING executable, but it does
  # allow renaming one -- the running process keeps its own open image. So the
  # old binary is moved aside rather than replaced in place, which also leaves
  # a rollback. Same reasoning as the mv/ETXTBSY dance in install.sh.
  if (Test-Path $binary) {
    $bak = "$binary.bak"
    if (Test-Path $bak) { Remove-Item $bak -Force -ErrorAction SilentlyContinue }
    try {
      Move-Item -Path $binary -Destination $bak -Force
      Write-Host "Previous binary kept at $bak"
    } catch {
      throw "Could not replace $binary -- it may be running. Stop the core and re-run. ($_)"
    }
  }
  Move-Item -Path $exe -Destination $binary -Force

  # The updater ships beside the binary rather than inside it: "the core will not
  # start" is exactly when you reach for it. Best-effort -- a failure here does
  # not fail the install. It needs a POSIX shell (Git Bash) to run.
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$repo/$Version/scripts/enkaku-update.sh" `
      -OutFile (Join-Path $Dir 'enkaku-update.sh') -UseBasicParsing
  } catch {
    try {
      Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$repo/main/scripts/enkaku-update.sh" `
        -OutFile (Join-Path $Dir 'enkaku-update.sh') -UseBasicParsing
    } catch {}
  } finally {
    $ProgressPreference = $prevProgress
  }

  Write-Host "Installed $binary ($Version)"

  # ---- PATH -----------------------------------------------------------------
  # The USER PATH, never the machine one: no elevation, and nothing that can
  # damage another account. Read through the registry-backed User scope rather
  # than $env:Path, which is the merged machine+user value -- appending that
  # back would copy every machine entry into the user's own PATH.
  $onPath = $false
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath) {
    $onPath = ($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $Dir.TrimEnd('\') }).Count -gt 0
  }

  if ($NoModifyPath) {
    Write-Host "Left PATH alone. Add it yourself: $Dir"
  } elseif ($onPath) {
    Write-Host "$Dir is already on your PATH."
  } else {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $Dir } else { "$userPath;$Dir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = "$env:Path;$Dir"
    Write-Host "Added $Dir to your user PATH."
  }

  Write-Host ''
  if ($NoModifyPath -and -not $onPath) {
    Write-Host 'Run it by full path:'
    Write-Host "  $binary"
  } else {
    Write-Host 'Open a new terminal, then run:'
    Write-Host '  enkaku'
  }
  Write-Host ''
  Write-Host 'Studio is then at http://localhost:7700 -- the first run downloads adb,'
  Write-Host 'scrcpy-server and the inspector APKs and verifies them (usually under a minute).'
  Write-Host "Full install guide: https://github.com/$repo/blob/main/docs/guide/install.md"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
