#!/usr/bin/env bash
# Prepare a separate trusted preview from a normally built ordinary image.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
: "${KANDELO_DEV_SHELL_TOOL_PATH:?Run through scripts/dev-shell.sh}"
export PATH="$KANDELO_DEV_SHELL_TOOL_PATH"
export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$REPO_ROOT/local-binaries/source-only-v1"
export WASM_POSIX_BINARY_RESOLVER_REPO_ROOT="$REPO_ROOT"

case "${1:-canonical}" in
  canonical)
    ordinary="$(node --import tsx --input-type=module -e '
      import { resolveBinary } from "./host/src/binary-resolver.ts";
      process.stdout.write(resolveBinary("programs/wasm32/shell.vfs.zst"));
    ')"
    ;;
  partial)
    ordinary="$(node --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { resolve } from "node:path";
      import { createHash } from "node:crypto";
      const manifest = JSON.parse(readFileSync("local-binaries/partial/partial.json", "utf8"));
      if (manifest.schema !== 1 || manifest.image !== "shell" || manifest.file !== "shell-partial.vfs.zst")
        throw Error("Trusted desktop preview requires a partial shell image");
      const file = resolve("local-binaries/partial", manifest.file);
      const bytes = readFileSync(file);
      if (bytes.length !== manifest.bytes || createHash("sha256").update(bytes).digest("hex") !== manifest.sha256)
        throw Error("Partial shell differs from its build manifest");
      process.stdout.write(file);
    ')"
    ;;
  *) echo "Usage: prepare-trusted-desktop-preview.sh [canonical|partial]" >&2; exit 2 ;;
esac

node --experimental-wasm-exnref --import tsx \
  images/vfs/scripts/prepare-shared-desktop-image.ts "$ordinary" \
  "$REPO_ROOT/local-binaries/trusted-desktop-preview/desktop.vfs.zst" --login-session
