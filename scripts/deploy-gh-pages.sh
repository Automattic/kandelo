#!/usr/bin/env bash
# Deploy browser demos to GitHub Pages.
#
# Usage:
#   bash scripts/deploy-gh-pages.sh [repo-name]
#
# Builds the Vite project with the correct base path, then pushes the
# dist/ contents to the gh-pages branch using a temporary worktree.
set -euo pipefail

REPO_NAME="${1:-wasm-posix-kernel}"
CORS_PROXY="${VITE_CORS_PROXY_URL:-https://wordpress-playground-cors-proxy.net/?}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BROWSER_DIR="$ROOT_DIR/examples/browser"

echo "=== Building browser demos for /${REPO_NAME}/ ==="
echo "    CORS proxy: ${CORS_PROXY}"

cd "$BROWSER_DIR"
npm install --no-save
VITE_BASE="/${REPO_NAME}/" VITE_CORS_PROXY_URL="${CORS_PROXY}" npx vite build

echo ""
echo "=== Build complete: $BROWSER_DIR/dist/ ==="
echo ""

# Verify critical files
if [ ! -f dist/service-worker.js ]; then
  echo "ERROR: dist/service-worker.js not found"
  exit 1
fi
if ! grep -q "service-worker.js" dist/index.html; then
  echo "ERROR: COI script tag not found in dist/index.html"
  exit 1
fi
echo "Verification passed."
echo ""

# Deploy to gh-pages branch
echo "=== Deploying to gh-pages branch ==="
cd "$ROOT_DIR"

DEPLOY_DIR=$(mktemp -d)
cp -r "$BROWSER_DIR/dist/." "$DEPLOY_DIR/"

# Add .nojekyll to prevent GitHub Pages from processing with Jekyll
touch "$DEPLOY_DIR/.nojekyll"

# Use git worktree to push to gh-pages
WORKTREE_DIR="$ROOT_DIR/.worktrees/gh-pages-deploy"

# Clean up any previous deploy worktree
if [ -d "$WORKTREE_DIR" ]; then
  git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || true
fi

# Create orphan gh-pages branch if it doesn't exist
if git show-ref --verify --quiet refs/heads/gh-pages; then
  git worktree add "$WORKTREE_DIR" gh-pages
else
  git worktree add --orphan "$WORKTREE_DIR" gh-pages
fi

# Replace contents with the build output
cd "$WORKTREE_DIR"
git rm -rf . 2>/dev/null || true
cp -r "$DEPLOY_DIR/." .
git add -A
git commit -m "Deploy browser demos to GitHub Pages"

echo ""
echo "=== gh-pages branch updated ==="
echo "Push with:  git push origin gh-pages"
echo "Site URL:   https://$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | tr '/' '\n' | head -1).github.io/${REPO_NAME}/"

# Clean up
cd "$ROOT_DIR"
git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || true
rm -rf "$DEPLOY_DIR"
