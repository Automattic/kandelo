# Signalling piplet

`piplet.php` carries opaque Kandelo offer and answer codes between two browsers. Copy it to a PHP 8.3+ server; the deployed file stores its own sessions, so the server must be able to replace it. The server does not interpret connection purpose or carry machine traffic. See the comments in `piplet.php` for request limits and deployment details.

The browser app enables the session-name flow with `?signalling=<http(s)-URL>` or `VITE_SIGNALLING_URL`. Without a server URL, users exchange connect codes manually. The migration consumer uses the generic purpose-checked connection API in `web-libs/kandelo-session`.

## Validation tools

`tools.nix` declares PHP and Composer from the repository's locked Nix package input. This app-scoped closure keeps signalling test dependencies separate from the package-build toolchain. Provision and run the server tests from the repository root:

```bash
scripts/dev-shell.sh bash -c '
  set -e
  "$KANDELO_NIX_BIN" build --impure --expr "import ./apps/signalling/tools.nix {}" --out-link .context/signalling-tools
  export PATH="$PWD/.context/signalling-tools/bin:$PATH"
  cd apps/signalling
  composer install --no-interaction
  composer test
'
```

The Pest suite serves throwaway copies over real HTTP. `composer.lock` and `vendor/` remain local test artifacts. The browser session-name spec likewise starts its own throwaway server on a free port and requires PHP on the declared tools path; it fails if that server cannot start. Run it after provisioning the browser artifacts through the normal package build path:

```bash
scripts/dev-shell.sh bash -c '
  set -e
  export PATH="$PWD/.context/signalling-tools/bin:$PATH"
  export KANDELO_PLAYWRIGHT_PORT=5520
  export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
  export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
  cd apps/browser-demos
  npx playwright test test/kandelo-network-session.spec.ts --project=chromium --workers=1
'
```
