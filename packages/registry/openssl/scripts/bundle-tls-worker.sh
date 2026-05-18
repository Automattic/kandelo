#!/bin/bash
# Bundle the TLS worker TypeScript code into a single CJS file
# that can be loaded by new Worker(code, { eval: true }).
set -euo pipefail

cd "$(dirname "$0")/.."
npx esbuild src/tls-worker.ts \
    --bundle \
    --format=cjs \
    --platform=node \
    --target=node20 \
    --outfile=src/tls-worker-bundle.js
echo "Bundled tls-worker -> src/tls-worker-bundle.js"
