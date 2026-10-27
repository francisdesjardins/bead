#!/usr/bin/env bash
# -- beadc -----------------------------------------------------------------------------------------
# beadc, Bead's builder, run from its image: the folder that holds beadc.yaml, the nearest upward or
# else this one, its physical path mounted at /work, the run kept in the same place under it, under
# an init that passes a signal on, with no network, no terminal, a read-only root and every
# capability dropped, the files written as the caller. --against-ref <ref>, the wrappers' own, pipes
# the project's git archive at that ref into the run, read by beadc as --against -. beadc.ps1 does
# the same with the arguments as the shell hands them; where a shell cannot, docs/support.md says so.
# Exit: beadc's own, 0, 1 or 2; 130 or 143 after an interrupt or a termination; 2 or 3 on
# --against-ref, refused or without git; 3 when the engine cannot run it, or sh runs this.
#
#   ./beadc.sh generate --check
#   ./beadc.sh breaking --against-ref v0.3.0
#   BEADC_IMAGE=ghcr.io/francisdesjardins/beadc@sha256:... ./beadc.sh check
#   BEADC_ENGINE=podman ./beadc.sh version

# ! POSIX sh up to the check, so that sh reads its refusal; bash 3.2 and later after it, macOS's
# being 3.2: no associative array, no ${x,,}, no mapfile, and an empty array expanded by
# ${a[@]+"${a[@]}"} under set -u
if [ -z "${BASH_VERSION:-}" ]; then
  echo "beadc: run beadc.sh with bash, not sh: ./beadc.sh or bash beadc.sh" >&2
  exit 3
fi

set -euo pipefail

image="${BEADC_IMAGE:-ghcr.io/francisdesjardins/beadc:0.8.0}"
engine="${BEADC_ENGINE:-docker}"

# ! a line feed alone, as beadc.ps1 writes it
environment() {
  printf 'beadc: %s\n' "$1" >&2
  exit 3
}

refuse() {
  printf 'beadc: %s\n' "$1" >&2
  exit 2
}

# --against-ref <ref> or --against-ref=<ref>, taken out of the arguments, up to a bare --; every
# other argument passes as it is given. --against - given by hand, an archive on standard input
ref=
refs=0
against=false
archive=false
passed=()
rest=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      rest=("$@")
      break
      ;;
    --against-ref)
      if [ "$#" -lt 2 ]; then
        refuse '--against-ref needs a ref: --against-ref <ref>'
      fi
      ref="$2"
      refs=$((refs + 1))
      shift
      ;;
    --against-ref=*)
      ref="${1#--against-ref=}"
      refs=$((refs + 1))
      ;;
    # ! pwsh -File splits a -name:value token at its colon, a session passes it whole: one form
    # refused here, where the wrapper sees it whole
    --against-ref:*)
      refuse '--against-ref:<ref> is not read: write --against-ref <ref> or --against-ref=<ref>'
      ;;
    --against)
      against=true
      if [ "$#" -ge 2 ] && [ "$2" = - ]; then
        archive=true
      fi
      passed+=("$1")
      ;;
    --against=*)
      against=true
      if [ "$1" = --against=- ]; then
        archive=true
      fi
      passed+=("$1")
      ;;
    *)
      passed+=("$1")
      ;;
  esac
  shift
done

if [ "$refs" -gt 1 ]; then
  refuse '--against-ref names one ref, once'
fi
if [ "$refs" -eq 1 ] && [ "$against" = true ]; then
  refuse '--against-ref and --against both name the earlier: give one'
fi
if [ "$refs" -eq 1 ] && [ -z "$ref" ]; then
  refuse '--against-ref needs a ref: --against-ref <ref>'
fi

# ! a terminal is no archive: the engine would pass the keyboard on, and beadc wait for its end
if [ "$archive" = true ] && [ -t 0 ]; then
  refuse '--against - reads an archive on standard input, not a terminal: pipe one in, or name a ref by --against-ref'
fi

# the arguments beadc is given: --against - after them, and before a bare -- where there is one
interactive=()
if [ "$refs" -eq 1 ]; then
  passed+=(--against -)
fi
if [ "$refs" -eq 1 ] || [ "$archive" = true ]; then
  interactive=(-i)
fi
set -- ${passed[@]+"${passed[@]}"} ${rest[@]+"${rest[@]}"}

# the host, in the words both wrappers use: windows, macos or linux
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) host=windows ;;
  Darwin) host=macos ;;
  *) host=linux ;;
esac

# ! Git Bash rewrites an argument or a variable that starts with / into a Windows path: /work stays
# /work, and the engine is handed what it was given
if [ "$host" = windows ]; then
  export MSYS_NO_PATHCONV=1
fi

# ! the physical path, asked of the system, as beadc.ps1 asks it: a link or a junction on the way
# resolved, whatever the shell's logical path says. Git Bash's pwd -P keeps a junction; realpath
# of the logical path does not
if [ "$host" = windows ]; then
  here="$(realpath "$PWD")"
else
  here="$(pwd -P)"
fi

# the root: the nearest folder upward that holds beadc.yaml, else this one
root="$here"
while [ ! -f "$root/beadc.yaml" ] && [ "$root" != / ]; do
  root="$(dirname "$root")"
done
if [ ! -f "$root/beadc.yaml" ]; then
  root="$here"
fi
relative="${here#"$root"}"
if [ "$root" = / ]; then
  relative="$here"
fi

if [ "$host" = windows ]; then
  source="$(cygpath -w "$root")"
else
  source="$root"
fi

# * the ref, checked on the host before the engine is asked anything: a work tree, a commit, and
# the project's folder in it, since git archive run from a folder its ref lacks fails
if [ "$refs" -eq 1 ]; then
  if ! command -v git > /dev/null 2>&1; then
    environment '--against-ref needs git on the path'
  fi
  if [ "$(git -C "$source" rev-parse --is-inside-work-tree 2> /dev/null || true)" != true ]; then
    refuse "--against-ref needs a git work tree: the project's folder is in none"
  fi
  # ! a ref that starts with - would be read by git as an option
  case "$ref" in
    -*) refuse "$ref names no commit" ;;
  esac
  if ! git -C "$source" rev-parse --verify --quiet "$ref^{commit}" > /dev/null 2>&1; then
    refuse "$ref names no commit"
  fi
  prefix="$(git -C "$source" rev-parse --show-prefix)"
  if ! git -C "$source" cat-file -e "$ref:$prefix" > /dev/null 2>&1; then
    refuse "$ref holds no ${prefix%/}"
  fi
fi

if ! command -v "$engine" > /dev/null 2>&1; then
  environment "no $engine on the path: install Docker, or name another engine by BEADC_ENGINE"
fi

# which engine it is, by what it reports, whatever its name: Podman behind Docker's name too
# ! compared case for case, as beadc.ps1 compares it: Podman writes its name in lower case
podman=false
case "$("$engine" --version 2> /dev/null || true)" in
  "podman version "*) podman=true ;;
esac

# the engine's OS and whether it runs rootless, in one call; it fails when the engine is stopped
if [ "$podman" = true ]; then
  format='{{.Host.OS}} {{.Host.Security.Rootless}}'
else
  format='{{.OSType}} {{range .SecurityOptions}}{{if eq . "name=rootless"}}true{{end}}{{end}}'
fi

if ! info="$("$engine" info --format "$format" 2> /dev/null)"; then
  environment "$engine does not answer: start it, then run beadc again"
fi

case "$info" in
  windows*) environment "$engine runs Windows containers: switch it to Linux containers" ;;
esac

# who writes the files: the caller. A rootless engine maps its root to the caller, Podman by
# keep-id; Docker Desktop on Windows maps every user to the caller, so the image's own runs there
rootless="${info#* }"
if [ "$rootless" = true ] && [ "$podman" = true ]; then
  user=(--userns=keep-id)
elif [ "$rootless" = true ]; then
  user=(--user 0:0)
elif [ "$host" = windows ]; then
  user=(--user 65532:65532)
else
  user=(--user "$(id -u):$(id -g)")
fi

# ! no --tty: a terminal ends each line with CRLF and merges stderr into stdout. -i where an archive
# comes on standard input
run=("$engine" run --rm --init ${interactive[@]+"${interactive[@]}"} --network none --read-only
  --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --security-opt label=disable
  "${user[@]}" --mount "type=bind,\"source=$source\",target=/work" --workdir "/work$relative"
  "$image" "$@")

# * the archive piped as git writes it, extracted under the project's .beadc/ where a beadc.yaml is
# read, else in the image's /tmp; the exit the engine's, git's ended by a pipe the engine closed. A git archive that fails midway leaves beadc a
# truncated archive, which it refuses
set +e
if [ "$refs" -eq 1 ]; then
  git -C "$source" archive --format=tar "$ref" | "${run[@]}"
  code="${PIPESTATUS[1]}"
else
  "${run[@]}"
  code=$?
fi
set -e

# the engine's own failures, the image it could not pull among them
case "$code" in
  125 | 126 | 127) environment "$engine could not run $image (exit $code)" ;;
esac

exit "$code"
