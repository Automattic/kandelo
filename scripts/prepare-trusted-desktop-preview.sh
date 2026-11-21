#!/usr/bin/env bash
# Validate the normal partial shell; never manufacture a second preview image.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
: "${KANDELO_DEV_SHELL_TOOL_PATH:?Run through scripts/dev-shell.sh}"
export PATH="$KANDELO_DEV_SHELL_TOOL_PATH"
case "${1:-partial}" in partial|canonical) ;; *) echo "Usage: prepare-trusted-desktop-preview.sh [partial|canonical]" >&2; exit 2 ;; esac
node --experimental-wasm-exnref --import tsx --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { KandeloImageFs } from './images/vfs/lib/kandelo-image-fs.ts';
import { SHARED_DESKTOP_PARTIAL_COMMAND } from './images/vfs/scripts/shared-desktop-package-contract.ts';
const help = 'Build the SDK package and ordinary image packages in a normal partial shell first: ' + SHARED_DESKTOP_PARTIAL_COMMAND;
let manifest;
try { manifest = JSON.parse(readFileSync('local-binaries/partial/partial.json', 'utf8')); }
catch (error) { throw Error(help, { cause: error }); }
if (manifest.schema !== 1 || manifest.image !== 'shell' || manifest.file !== 'shell-partial.vfs.zst') throw Error(help);
const bytes = readFileSync(resolve('local-binaries/partial', manifest.file));
if (bytes.length !== manifest.bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw Error('Partial shell differs from its build manifest');
const metadata = KandeloImageFs.readImageMetadata(bytes);
if (metadata?.trustedMemoryGroup?.schema !== 1 || metadata.trustedMemoryGroup.package !== 'shared-desktop-programs') throw Error(help);
console.log('Using the normal partial shell with package-owned lazy SDK artifacts');
JS
