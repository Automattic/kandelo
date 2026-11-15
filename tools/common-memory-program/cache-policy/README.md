# OPcache seeding and invalidation experiments

These fixtures reuse the pinned application-impact image, FPM artifacts,
matching kernel and bundled host profile. They do not change an existing
preview, package, kernel, ABI or default policy. Ordinary/native raw labels
mean untranslated WebAssembly in the same engine, not machine-native PHP.

Run every command through `scripts/dev-shell.sh` with the matching source-only
projection selected. Outputs must be new directories. The historical fixtures
are named explicitly in `run-node.mjs` and `browser.spec.ts`; inspect or replace
those pinned paths when reproducing on another machine. Missing inputs fail.

- `seed-probe.ts IMAGE_FIXTURE PROFILE KERNEL OUTPUT`: FILE training, empty
  shared control, seeded shared restore, edits visible to both workers and
  rejection of a seed with an older source timestamp. Logs prove actual load.
- `train-wordpress.ts FIXTURE PROFILE KERNEL OUTPUT BACKEND [ARM]`: derive a
  binary-safe persistent cache through FPM, with normalized source timestamps.
  `ARM` is `vm-shared` or `native-file`; settings match the intended consumer.
  Entries whose source differs from the shipping image are excluded, including
  the training machine's generated secrets.
- `wordpress-probe.ts FIXTURE PROFILE KERNEL OUTPUT BACKEND FILE_CACHE LOG ARM
  MODE`: one fresh Node parent; FILE_CACHE is `on`/`off`, LOG is `0`/`1`, MODE
  is `timing`/`resource`. Diagnostic logging never enters the latency screen.
- `run-node.mjs PROFILE KERNEL OUTPUT`: serial, opposing timing orders plus
  separate resource runs. All children retain timestamps at frequency zero.
  One resource sample per case and two timing parents are descriptive only.
- `browser.spec.ts`: seed restore and real seeded-core edits on SQLite/MariaDB
  in all three engines, with logs and memory-boundary checks. Set
  `KANDELO_OPCACHE_SEED_PREFIX=PREFIX` to select `PREFIX-sqlite` and
  `PREFIX-mariadb` fixture directories. No browser timing claim.
- `watcher-probe.ts SEEDED_IMAGE FIXTURE PROFILE KERNEL OUTPUT [VALIDATION]`: a controlled
  request waits for observer-driven invalidation inside the actual FPM pool.
  Proves same-mtime closed edits/replacements and reproduces stale code during
  a held writable descriptor and through an outside hard link. This is a
  capability screen, **not** a general replacement for timestamp validation.
  `VALIDATION` defaults to `0`; `1` checks the existing policy as a control.
- `analyze.py RESULTS OUTPUT`: replay the completed 24-parent Node comparison;
  refuses failed/incomplete rows and preserves each page and order.

For the browser fixture, use the app's Playwright CLI and shared silent fixture:

```sh
scripts/dev-shell.sh env KANDELO_COMMON_MEMORY_ARTIFACTS=ABSOLUTE_NEW_OUTPUT \
  node apps/browser-demos/node_modules/playwright/cli.js test \
  --config tools/common-memory-program/cache-policy/playwright.config.ts
```

These programs require the same explicit `WASM_POSIX_RESOLUTION_POLICY` and
`WASM_POSIX_SOURCE_ONLY_BINARY_ROOT` selection as the impact fixture. Node
machines use `offlineEgressLink` so guest listeners are not published on host
ports; requests still use Kandelo's real guest networking. Images and seeds
must match the executable, source paths/mtimes and effective PHP configuration.
PHP can compile configuration-dependent values into persistent scripts.

Startup records include image initialization, FPM installation/configuration
and service-to-homepage time. They exclude network image transfer, host file
reads and module import time. Image compressed size is recorded separately.
Do not call service-only latency total startup, or FILE logical lengths RAM.

## Interactive seeded demo

`build-demo.ts FILTERED_FIXTURE OUTPUT` installs the matching FPM into a new
image, enables its second-level FILE cache alongside shared OPcache, and keeps
timestamp validation enabled at frequency zero. It uses the normal image
writer and explicit prototype-v2 artifact policy. It requires the filtered
fixture's generated-secrets exclusion and records the image/FPM/seed hashes.

Serve that image on a new local port with the existing WordPress preview:

```sh
scripts/dev-shell.sh node --import tsx/esm \
  tools/common-memory-program/cache-policy/build-demo.ts FILTERED_FIXTURE NEW_OUTPUT
scripts/dev-shell.sh env WASM_POSIX_SOURCE_ONLY_BINARY_ROOT=MATCHING_PROJECTION \
  node tools/common-memory-program/wordpress/serve.mjs \
  PROFILE NEW_OUTPUT/wordpress.vfs.zst UNUSED_PORT MATCHING_KERNEL
```

Use each backend's own seed for its demo. The image-owned profiles and normal
app/service-worker flow remain intact. `/kandelo-seed-info.php` reports effective
OPcache configuration inside FPM. `demo.spec.ts` checks homepage, shared cache,
both workers, timestamps, admin login and the memory boundary through the real
UI. Select the two preview origins with `KANDELO_SEEDED_SQLITE_URL` and
`KANDELO_SEEDED_MARIADB_URL`, and use `demo.config.ts` with the app's Playwright
CLI. These demos do not enable the experimental watcher-only policy.
