# WordPress Development Demo Handoff

Date: 2026-05-20
Branch: `wordpress-development-environment-with-git-setup-a`

## Goal

Add a Kandelo UI gallery demo for a WordPress development environment:

- shallow-cloned `WordPress/wordpress-develop` at image build time
- MariaDB with `wordpress` and `wordpress_tests`
- PHP/PHPUnit available from the terminal
- Node.js and npm available from the terminal
- WordPress npm dependencies installable
- WordPress development scripts runnable

## Current State

The demo boots and the terminal pane works. The visible Firefox terminal path was tested with:

```sh
npm install; echo UI_NPM_INSTALL_EXIT:$?
npm run build; echo UI_BUILD_EXIT:$?
```

Observed in the headed Firefox terminal:

- `UI_NPM_INSTALL_EXIT:0`
- `UI_BUILD_EXIT:0`

The demo URL used for local testing was:

```text
http://127.0.0.1:5199/pages/kandelo/?demo=wordpress-development
```

The dev server was running on `127.0.0.1:5199`.

## Important Implementation Details

- The WordPress dev VFS builder lives in:
  - `examples/browser/scripts/build-wordpress-dev-vfs-image.ts`
  - `examples/browser/scripts/build-wordpress-dev-vfs-image.sh`
- The Kandelo gallery wiring lives mostly in:
  - `examples/browser/pages/kandelo/fixtures.ts`
  - `examples/browser/pages/kandelo/kernel-host/live-setup.ts`
- The image now bakes `node_modules` into `/work/wordpress-develop`.
  This avoids Firefox spending many minutes inflating npm tarballs in-browser and avoids the previous `TAR_ENTRY_ERROR` / `zlib: out of memory` path.
- The WordPress dev VFS max size is 3 GiB.
  This was needed because the image starts around 1.3 GiB raw after adding `node_modules`, and `npm run build` writes a large `build/` tree.
- The npm wrapper intercepts `npm run build` and `npm run build:dev` and invokes `/usr/local/lib/kandelo/grunt-cli-runner.js` directly.
  This bypasses QuickJS npm run-script child-process buffering issues seen in Firefox.

## Known Remaining Problem

This is not end-to-end complete.

Even though `npm install` and `npm run build` can exit successfully, reloading the demo page can still show WordPress's warning:

```text
You are running WordPress without JavaScript and CSS files. These need to be built.
```

There are also task-load errors printed during `npm run build`, including optional or partially unsupported Grunt tasks. The build runner currently tolerates some of these so the main build can proceed:

- `jshint.js` task load error
- `qunit.js` / Puppeteer module error
- `watch.js` task load error
- `jsdoc-plugin.js` / `cross-spawn` module error
- `patch_wordpress.js` task load error
- `gutenberg:copy` reports `TypeError: not a function`

The remaining issue is likely not simply npm exit status anymore. The next agent should verify which built assets WordPress expects after reload and where the server is looking for them.

## Likely Next Investigation

Start with the mismatch between WordPress's served document root and the generated build output:

- nginx/PHP currently serve `/work/wordpress-develop/src`
- `npm run build` writes WordPress build output under `/work/wordpress-develop/build`

That may mean the web preview keeps serving the unbuilt source tree after a successful build. Possible fixes to evaluate:

- serve `/work/wordpress-develop/build` after a successful build
- change the demo to recommend/run `npm run build:dev` if that populates assets in the source tree expected by the dev server
- update nginx/FPM routing or symlinks so WordPress resolves the generated JS/CSS files
- fix or intentionally skip the remaining Grunt task errors only after confirming whether they affect the assets WordPress says are missing

## Useful Commands

Rebuild the WordPress development VFS:

```sh
bash examples/browser/scripts/build-wordpress-dev-vfs-image.sh
cp examples/browser/public/wordpress-dev.vfs.zst local-binaries/programs/wasm32/wordpress-dev.vfs.zst
```

Run the Kandelo gallery dev server:

```sh
npm --prefix examples/browser run dev -- --host 127.0.0.1 --port 5199
```

Open the demo:

```text
http://127.0.0.1:5199/pages/kandelo/?demo=wordpress-development&fresh=1
```

Inside the demo terminal:

```sh
npm install
npm run build
phpunit tests/phpunit/tests/formatting/wpAutop.php
```

For lower-level build debugging, bypass npm and run:

```sh
node /usr/local/lib/kandelo/grunt-cli-runner.js build --stack
```
