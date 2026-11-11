#!/bin/sh
# Installs handbook-orchestrator for this user, no sudo and no Node needed:
#   curl -fsSL https://github.com/AhmetErenLapanta/TeamHandbook/releases/download/handbook-orchestrator-latest/install.sh | sh
#
# It downloads this platform's archive and SHA256SUMS from the release, checks SHA256SUMS against
# the release workflow's signature when cosign is installed, refuses an archive whose checksum does
# not match before writing anything, unpacks it into ~/.handbook-orchestrator/versions/<version>,
# points ~/.handbook-orchestrator/current at it and links ~/.local/bin/handbook-orchestrator. It
# reaches the release address and nothing else.
#
#   HANDBOOK_ORCHESTRATOR_VERSION            a version to install instead of the latest
#   HANDBOOK_ORCHESTRATOR_RELEASE_BASE_URL   a mirror holding manifest.json, SHA256SUMS, its signature and the archives
#   HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE  1 to refuse a release whose signature cosign has not checked
#   HANDBOOK_ORCHESTRATOR_HOME               instead of ~/.handbook-orchestrator
#   HANDBOOK_ORCHESTRATOR_BIN_DIR            instead of ~/.local/bin
set -eu

REPOSITORY=https://github.com/AhmetErenLapanta/TeamHandbook
version=${HANDBOOK_ORCHESTRATOR_VERSION:-}
mirror=${HANDBOOK_ORCHESTRATOR_RELEASE_BASE_URL:-}
mirror=${mirror%/}
require_signature=${HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE:-}
# The repository's releases/latest names whichever of its releases came last, the plugin's
# included, so the newest orchestrator is named by a release of its own whose tag never moves,
# and each version's files come from that version's release. A mirror holds everything in one
# directory.
latest="$REPOSITORY/releases/download/handbook-orchestrator-latest"
release_of() {
  if [ -n "$mirror" ]; then echo "$mirror"; else echo "$REPOSITORY/releases/download/handbook-orchestrator-v$1"; fi
}
# The archive and its checksum come from the same address, so plain http would let anyone on the
# way change both together: https only, and plain http for a mirror on this machine alone.
base=${mirror:-$REPOSITORY}
case "$base" in
  https://*) proto='=https' ;;
  http://127.0.0.1:* | http://127.0.0.1/* | http://localhost:* | http://localhost/* | http://\[::1\]:*) proto='=http' ;;
  *)
    printf 'handbook-orchestrator: the release address has to be https (plain http only on this machine): %s\n' "$base" >&2
    exit 1
    ;;
esac
home=${HANDBOOK_ORCHESTRATOR_HOME:-$HOME/.handbook-orchestrator}
bin_dir=${HANDBOOK_ORCHESTRATOR_BIN_DIR:-$HOME/.local/bin}

say() { printf 'handbook-orchestrator: %s\n' "$*"; }
die() {
  printf 'handbook-orchestrator: %s\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "$(uname -s) is not a system it installs on; on Windows, run this inside WSL" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "$(uname -m) is not a processor it has a build for" ;;
esac
if [ "$os" = linux ] && { ldd --version 2>&1 | grep -qi musl; }; then
  die "this Linux uses musl (Alpine and the like); the build needs glibc"
fi
platform="$os-$arch"

command -v curl >/dev/null 2>&1 || die "it needs curl"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "it needs sha256sum or shasum to check the download"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

get() {
  curl -fsSL --proto "$proto" --proto-redir "$proto" --retry 2 -o "$work/$2" "$1/$2"
}
fetch() {
  get "$1" "$2" || die "$3"
}

if [ -z "$version" ]; then
  from=${mirror:-$latest}
  fetch "$from" manifest.json "could not read manifest.json at $from"
  schema=$(grep -o '"schema": *[0-9]*' "$work/manifest.json" | head -n 1 | sed 's/[^0-9]//g')
  [ -z "$schema" ] || [ "$schema" = 1 ] || die "manifest.json at $from is of a newer shape than this script reads; get the newest install.sh from the same place"
  version=$(grep -o '"version": *"[^"]*"' "$work/manifest.json" | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
  [ -n "$version" ] || die "manifest.json at $from names no version"
fi
case "$version" in *[!0-9A-Za-z.+-]*) die "$version is not a version" ;; esac
base=$(release_of "$version")

archive="handbook-orchestrator-$version-$platform.tar.gz"
fetch "$base" SHA256SUMS "could not read SHA256SUMS at $base"

# The signature names the workflow run that built this version's tag, so a SHA256SUMS signed for
# another version, or by anything else, is refused along with every archive it lists.
if command -v cosign >/dev/null 2>&1; then
  if get "$base" SHA256SUMS.sigstore.json; then
    checked=$(cosign verify-blob --bundle "$work/SHA256SUMS.sigstore.json" \
      --certificate-identity "$REPOSITORY/.github/workflows/orchestrator-release.yml@refs/tags/handbook-orchestrator-v$version" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "$work/SHA256SUMS" 2>&1) || {
      last=$(printf '%s\n' "$checked" | tail -n 1)
      die "SHA256SUMS at $base is not signed by the release workflow for $version; nothing was installed${last:+ (cosign: $last)}"
    }
    say "SHA256SUMS is signed by the release workflow for $version"
  elif [ -n "$mirror" ] && [ "$require_signature" != 1 ]; then
    say "the mirror holds no SHA256SUMS.sigstore.json, so the signature was not checked; the checksums were"
  else
    die "could not read SHA256SUMS.sigstore.json at $base; nothing was installed"
  fi
elif [ "$require_signature" = 1 ]; then
  die "HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE is 1 and cosign is not installed to check the signature"
else
  say "cosign is not installed, so the release signature was not checked; the checksums were"
fi

expected=$(grep "  $archive\$" "$work/SHA256SUMS" | cut -d' ' -f1)
[ -n "$expected" ] || die "release $version has no build for $platform; npx teamhandbook-orchestrator@latest runs on any system with Node 22.16 or newer"
fetch "$base" "$archive" "could not download $archive from $base"
actual=$(sha256 "$work/$archive")
[ "$actual" = "$expected" ] || die "$archive does not match its checksum in SHA256SUMS; nothing was installed"

dest="$home/versions/$version"
mkdir -p "$home/versions"
if [ -f "$dest/.install-complete" ]; then
  say "$version is installed already"
else
  # Unpacked and checked beside its place, then moved in whole: a cut-off install leaves nothing current.
  staging="$home/versions/.staging-$$"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$work/$archive" -C "$staging"
  unpacked="$staging/handbook-orchestrator-$version-$platform"
  said=$("$unpacked/handbook-orchestrator" --version 2>/dev/null || true)
  [ "$said" = "teamhandbook-orchestrator $version" ] || {
    rm -rf "$staging"
    die "the unpacked executable does not run here (it said: ${said:-nothing}); nothing was installed"
  }
  touch "$unpacked/.install-complete"
  rm -rf "$dest"
  mv "$unpacked" "$dest"
  rm -rf "$staging"
fi

# current is swapped in one rename, so a running service never sees it missing.
rm -f "$home/current.next"
ln -s "versions/$version" "$home/current.next"
if mv --version 2>/dev/null | grep -q GNU; then
  mv -fT "$home/current.next" "$home/current"
else
  mv -fh "$home/current.next" "$home/current"
fi

mkdir -p "$bin_dir"
ln -sfn "$home/current/handbook-orchestrator" "$bin_dir/handbook-orchestrator"
say "installed $version; start it with: handbook-orchestrator"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) say "$bin_dir is not on your PATH; add it, for instance: echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.profile" ;;
esac
