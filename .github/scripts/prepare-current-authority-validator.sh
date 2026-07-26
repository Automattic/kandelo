#!/usr/bin/env bash
# Build the trusted package-source validator and the complete Cargo cache that
# its later offline reads require. The caller must keep this state private to
# one independent trust phase.
set -euo pipefail

STATE_DIR=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    *)
      echo "prepare-current-authority-validator: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$STATE_DIR" ] || [ "$STATE_DIR" = / ] ||
   [[ "$STATE_DIR" != /* ]] || [ -e "$STATE_DIR" ] ||
   [ -L "$STATE_DIR" ]; then
  echo "prepare-current-authority-validator: a new absolute state directory is required" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTHORITY_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
AUTHORITY_MANIFEST="$AUTHORITY_ROOT/Cargo.toml"
if [ ! -f "$AUTHORITY_MANIFEST" ] || [ -L "$AUTHORITY_MANIFEST" ] ||
   [ ! -f "$AUTHORITY_ROOT/Cargo.lock" ] ||
   [ -L "$AUTHORITY_ROOT/Cargo.lock" ]; then
  echo "prepare-current-authority-validator: current authority lacks a regular Cargo workspace and lockfile" >&2
  exit 2
fi

# mkdir is deliberately create-once: a trust phase cannot inherit a cache or
# validator path prepared by an earlier phase.
mkdir -m 0700 "$STATE_DIR"
cleanup() {
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

CARGO_HOME_DIR="$STATE_DIR/cargo-home"
TARGET_DIR="$STATE_DIR/target"
install -d -m 0700 "$CARGO_HOME_DIR" "$TARGET_DIR"

(
  cd "$AUTHORITY_ROOT"
  export CARGO_HOME="$CARGO_HOME_DIR"

  # WHY: inert source metadata must remain offline, yet it can name any
  # checksum-bound crate in the current authority lockfile even when building
  # xtask does not need that crate. Populate a fresh cache from only the
  # authority manifest/configuration before building the authority validator;
  # no producer manifest, lockfile, working directory, or tooling is consulted.
  cargo fetch --locked --manifest-path "$AUTHORITY_MANIFEST"

  host_target="$(rustc -vV | awk '/^host/ {print $2}')"
  if ! [[ "$host_target" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "prepare-current-authority-validator: rustc did not report a valid host target" >&2
    exit 1
  fi
  cargo build --locked --release -p xtask \
    --manifest-path "$AUTHORITY_MANIFEST" \
    --target "$host_target" \
    --target-dir "$TARGET_DIR"

  authority_xtask="$TARGET_DIR/$host_target/release/xtask"
  if [ ! -f "$authority_xtask" ] || [ -L "$authority_xtask" ] ||
     [ ! -x "$authority_xtask" ]; then
    echo "prepare-current-authority-validator: Cargo did not build a regular executable xtask" >&2
    exit 1
  fi
  printf '%s\n' "$CARGO_HOME_DIR" >"$STATE_DIR/cargo-home-path"
  printf '%s\n' "$authority_xtask" >"$STATE_DIR/xtask-path"
  chmod 0600 "$STATE_DIR/cargo-home-path" "$STATE_DIR/xtask-path"
)

trap - EXIT
echo "prepare-current-authority-validator: prepared isolated current-authority state"
