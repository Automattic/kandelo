# WordPress with virtualized PHP-FPM

This local experiment derives an unpublished image from the normal
`wordpress-family-vfs` product. Both image-owned profiles remain available:
`wordpress-sqlite` and `wordpress-mariadb`. Only PHP-FPM is virtualized;
the kernel, shells, nginx and MariaDB use their ordinary addressing paths.
The FPM pool has two workers and a 32 MiB shared OPcache, with the file cache
disabled. Timestamp validation is enabled with `opcache.revalidate_freq=0`.
Ordinary PHP retains its file-cache-only guard.

## Source-integrated prototype

The normal source resolver now has explicit `php-common-memory` and
`wordpress-common-memory` recipes. Both are excluded from default products.
Use this path for new builds; the older hand-composed fixture below is retained
as historical evidence:

Current builds use PHP revision 3 and the format-2 execution-stop contract.
Use a matching new host profile and kernel; earlier artifacts are refused.
The [integration guide](../../../docs/experimental-common-memory.md) records
the current supported boundaries and acceptance gaps. In particular, the
earlier successful WordPress screens below do not resolve the intermittent
repeated-boot stall or establish the new stop checks' performance.

```sh
scripts/dev-shell.sh ./run.sh prepare-browser
scripts/dev-shell.sh env WASM_POSIX_RESOLUTION_POLICY=source-only-v1 bash -c '
  host_target="$(rustc -vV | sed -n "s/^host: //p")"
  cargo run --locked -p xtask --target "$host_target" -- build-deps resolve \
    wordpress-common-memory --arch wasm32 --binaries-dir "$PWD/binaries"
'
scripts/dev-shell.sh node host/build-common-memory.mjs .scratch/fresh-common-memory-profile
```

The ordinary preparation publishes the matching lazy-binary projection and
kernel. The explicit resolver command then builds the excluded experimental
recipe and prints its artifact directory; select `wordpress-common-memory.vfs.zst`
inside that directory. `./run.sh build` does not register this experimental
target, so use the explicit registry resolver above.

Select the resulting image and the matching newly built kernel explicitly:

```sh
scripts/dev-shell.sh node tools/common-memory-program/wordpress/serve.mjs PROFILE IMAGE.vfs.zst 5632 KERNEL.wasm
```

Use an unused port for a new preview and keep existing profiles, images and
published binary projections frozen while their previews are running.

The kernel must contain the optional process-model and clock eligibility
exports. This server selects that kernel even for Vite's `?url` import; it
does not overwrite another preview's selected kernel. Its app module graph
remains normal, while disposable workers use the opt-in profile.

The preview also needs a published SourceOnly binary projection matching the
base image's lazy-asset hashes. An older projection can serve a same-sized
`coreutils.wasm` with different bytes; the guest correctly rejects it with
`EIO`. Build the normal projection with `./run.sh prepare-browser`, or select
an already validated matching projection explicitly:

```sh
scripts/dev-shell.sh env WASM_POSIX_SOURCE_ONLY_BINARY_ROOT=ABSOLUTE_BINARY_ROOT \
  node tools/common-memory-program/wordpress/serve.mjs PROFILE IMAGE.vfs.zst 5632 KERNEL.wasm
```

A resolver mirror without a published projection authority is insufficient.
Keep the image's integrity checks enabled; changing the preview's binary root
does not authorize mixing arbitrary image and executable versions.

The November 13 source-integrated profile and normal PHP revision 2 pass
homepage/shared-cache checks on Node, and both backend homepages, shared-cache
checks and admin login on Chromium, Firefox and WebKit. The image in this
screen was composed by the new recipe's builder against a retained normal
base; full fresh dependency resolution is a separate build gate. A separate
source-edit fixture loads WordPress, warms a PHP file in OPcache, crosses a
real mtime second, edits it through worker-owned VFS mutation and checks both
FPM workers return the new value. Both backends pass on all four hosts without
explicit cache invalidation. The first browser run loaded an older kernel due
to the query-alias error; its failure and the corrected rerun are retained.
These are correctness screens, not latency measurements or release acceptance.

```sh
scripts/dev-shell.sh node --import tsx/esm tools/common-memory-program/wordpress/check-node.ts PROFILE IMAGE.vfs.zst OUTPUT KERNEL.wasm
scripts/dev-shell.sh env KANDELO_COMMON_MEMORY_PROFILE=PROFILE KANDELO_COMMON_MEMORY_IMAGE=IMAGE.vfs.zst KANDELO_COMMON_MEMORY_KERNEL=KERNEL.wasm KANDELO_COMMON_MEMORY_ARTIFACTS=FRESH_OUTPUT node apps/browser-demos/node_modules/playwright/cli.js test --config tools/common-memory-program/wordpress/freshness.config.ts
```

## Historical first image

Build the base through the resolver, then compose the experimental copy:

```sh
scripts/dev-shell.sh ./run.sh build wordpress-family-vfs
scripts/dev-shell.sh node --import tsx/esm tools/common-memory-program/wordpress/build-image.ts local-binaries/source-only-v1/programs/wasm32/wordpress-family-vfs.vfs.zst .scratch/common-memory-program-outlined-1/php-fpm-vm.wasm .scratch/common-memory-wordpress-1/wordpress.vfs.zst
```

The outlined FPM artifact and host profile come from the parent
[prototype build](../README.md). The image composer checks the full
materialized Wasm inventory against the ordinary ABI/fork policy, explicitly
admitting the VM marker at `/usr/sbin/php-fpm` only. It checks the layout and
records the base, original FPM and transformed FPM hashes in the image and
an adjacent JSON receipt. The normal Rust image writer produces the image.

Start the local app server from the repository root:

```sh
scripts/dev-shell.sh node tools/common-memory-program/wordpress/serve.mjs .scratch/common-memory-platform-18 .scratch/common-memory-wordpress-1/wordpress.vfs.zst 5630
```

It prints both URLs. The normal app, browser-storage ownership checks,
image composer, service worker and main-thread `BrowserKernel` stay in one
module graph. Only its kernel-worker and process-worker URL imports select
the compiled experimental bundles. Bundling a second copy of the main-thread
host would duplicate opaque lease registries and correctly refuse the app's
existing computer lease; no lease check is relaxed here. Vite loads its
configuration through its normal loader, preserving the self-contained
functions serialized into the service worker.

Browser composition now caps an image's `pm.max_children` request at the host
profile's pre-fork limit. It preserves this image's two-worker request on a
desktop host, rather than expanding it to six and exhausting the prototype's
physical group. The focused resource-selection/composer-client selection
passes 79 tests, including smaller image requests, host caps and invalid or
ambiguous configurations.

Use the usual WordPress demo login: `admin` / `password`. The image-owned
`/common-memory-status.php` endpoint reports actual worker PIDs and OPcache
counters, cache configuration and memory usage. The experiment retains the
prototype's trusted memory32, one Worker per process, 512 MiB physical group
and the original monotonic allocator limits. The source-integrated profile
above adds exact-generation retirement and reuse. Neither is a deployment.

Validate the same image on Node and the running browser server:

```sh
scripts/dev-shell.sh node --import tsx/esm tools/common-memory-program/wordpress/check-node.ts .scratch/common-memory-platform-18 .scratch/common-memory-wordpress-1/wordpress.vfs.zst .scratch/fresh-wordpress-node-check
scripts/dev-shell.sh env KANDELO_COMMON_MEMORY_ARTIFACTS=.scratch/fresh-wordpress-browser-check KANDELO_WORDPRESS_BASE_URL=http://127.0.0.1:5630 node apps/browser-demos/node_modules/playwright/cli.js test --config tools/common-memory-program/wordpress/playwright.config.ts --max-failures=1
```

The browser suite uses the app's Playwright installation and quiet persistent
context fixture. It checks both homepages, both FPM PIDs, shared OPcache with
cached WordPress scripts, and an actual wp-admin login on each engine.
Screenshots go under the workspace's `.context/` directory.

Both variants pass those checks on Chromium, Firefox and WebKit. The same
image also passes homepage/shared-cache checks and teardown on Node. The
first WebKit login run was interrupted by a development reload; its clean
two-case rerun passes with live reload disabled. Firefox logs an intercepted
empty-resource service-worker error in each passing case; the homepage,
cache checks, admin login and uncaught-page-error assertions all pass.
Raw results, the image and provenance are retained in
`.context/common-memory-wordpress-20261111/`. These are application smoke
checks, without a WordPress performance or production-readiness claim.
