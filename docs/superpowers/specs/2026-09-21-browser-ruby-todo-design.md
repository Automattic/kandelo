# browser-ruby-todo: a Sinatra + SQLite example server VFS image

Status: Design approved (brainstorming). Next: implementation plan.
Date: 2026-09-21.

## Why

Kandelo can already boot Ruby 4.0.5 in the guest, but it has no demo that
shows a real Ruby web application running as a server the way a visitor
would expect — a long-lived HTTP server they can click through. The
project also has no example of a Ruby web framework or a database-backed
Ruby app on the platform.

The original request was a "Ruby on Rails example server." A feasibility
spike (recorded in `.context/rails-spike/FINDINGS.md`) established that
stock Rails cannot run today without substantial new platform work: the
Ruby build excludes `openssl` and `bigdecimal`, and Rails' dependency
tree pulls the native C-extension gem `nokogiri` (libxml2), which has no
pure-Ruby fallback and no cross-compile pipeline on Kandelo yet. That is
weeks of work, gated on OpenSSL-on-wasm and a native-gem pipeline.

This design delivers the achievable, honest first step: a believable,
database-backed Ruby web app built on **Sinatra** (a pure-Ruby
microframework) with **SQLite** persistence. It is explicitly **not**
labeled Rails. It proves the Ruby-web-server story now, and it lands a
reusable platform capability along the way — the first native gem
(`sqlite3`) baked into the Ruby build — which is the pattern the eventual
Rails native-gem pipeline (nokogiri) will follow.

Who it affects: users browsing the demo gallery (a new, clickable Ruby
app), and platform work downstream (a proven native-gem-as-static-ext
path, and a working Ruby+SQLite runtime).

## What changed (scope)

1. **Ruby package** gains the `sqlite3` gem as a built-in static
   extension, so `require "sqlite3"` works in the guest. This is the
   first native gem on Kandelo.
2. **A new VFS product** `browser-ruby-todo` composes the shell base
   image + the SQLite-enabled Ruby + a vendored Sinatra todo app, boots
   it under dinit on port 8080, and seeds an SQLite database.
3. **Demo registration** adds the demo to the browser gallery with the
   existing server-demo readiness plumbing (dinit + service-worker HTTP
   bridge), presented honestly as "Ruby + Sinatra + SQLite."

Nothing changes in the host runtime or kernel: the demo reuses the same
server plumbing as `browser-nginx-php` and `browser-wordpress`.

## Non-goals

- Rails, ActiveRecord, or any Rails component.
- OpenSSL, TLS/https, or `bigdecimal` in the Ruby build (tracked
  separately as the leverage path toward Rails).
- Durable or private persistence. The SQLite DB lives on the ephemeral
  browser VFS; state is per-session by design.
- A general Ruby dev/tinkering environment (the future "dev box" goal);
  this image is a running example app, though it does not preclude that.

## Feasibility already established (spike evidence)

From `.context/rails-spike/FINDINGS.md`:

- Guest Ruby 4.0.5 loads `socket`, `erb`, `json`, `net/http`, `psych`,
  `securerandom`, etc.; RubyGems + Bundler 4.0.10 are present. `openssl`,
  `bigdecimal`, `fiddle`, `readline` are absent (not built).
- The socket/server path works on the guest (TCP bind OK; connected
  socketpair round-trip OK), so a pure-Ruby HTTP server is viable.
- Ruby extensions are statically linked into `ruby.wasm`
  (`--disable-shared --with-static-linked-ext`, `ENABLE_SHARED=no`);
  there is no runtime `.so` loading. Native gems must be baked in at
  build time.
- The `sqlite3` gem (2.9.6) ext compiles clean against Ruby 4.0 with the
  standard extconf defines (esp. `HAVE_RB_INTEGER_PACK`) — zero source
  patches. `libsqlite3.a` and `sqlite3.h` already build for wasm32 via
  the `sqlite` package (amalgamation 3.49.1).

## Architecture

A single long-lived Ruby process serves HTTP on `0.0.0.0:8080`,
supervised by dinit. The browser projects that port to the web-preview
iframe through the existing service-worker HTTP bridge. Request flow:

```
browser fetch
  -> service worker
  -> main thread bridge
  -> guest listening socket :8080
  -> Sinatra route (app.rb)
  -> sqlite3 gem (in-process) -> /srv/todo/db.sqlite3
  -> ERB-rendered HTML
  -> back out through the bridge to the iframe
```

This mirrors `browser-nginx-php` and `browser-wordpress` exactly at the
plumbing layer; only the served process differs.

## Components

Each unit has one purpose, a defined interface, and known dependencies.

### 1. SQLite-enabled Ruby (`packages/registry/ruby/`)

- **What it does:** provides `require "sqlite3"` in the guest.
- **How:** add the `sqlite3` gem's C ext to Ruby's static-ext link.
  Compile the gem ext sources plus SQLite (reuse the `sqlite` package's
  `libsqlite3.a`, or compile the amalgamation) into a static archive;
  register `Init_sqlite3` in `STATIC_EXTINITS`/`STATIC_EXTOBJS` and
  relink (`build-ruby.sh:1170-1197` pattern); vendor the gem's
  `lib/sqlite3*.rb` into the installed runtime. Pin the extconf-derived
  defines rather than running the gem's network-fetching extconf.
- **Depends on:** the `sqlite` package (`libsqlite3.a`, `sqlite3.h`),
  the SDK toolchain.
- **Interface:** `SQLite3::Database.new(path)` and friends.
- **Decision:** bake into the shared `ruby` package (benefits any future
  Ruby demo), not a demo-specific variant.
- **ABI note:** this changes the `ruby` program artifact. Follow the
  package build/publish path; if any ABI-adjacent contract is touched,
  honor the ABI bump + snapshot rules. (Adding a statically linked ext
  is expected not to change the kernel ABI, but this is verified, not
  assumed, per `docs/agent-guidance/abi.md`.)

### 2. Sinatra todo app + vendored gems (new builder)

- **What it does:** the example application.
- **App:** `app.rb` (Sinatra), ERB views (`views/*.erb`), a small CSS.
  Routes: `GET /` (list), `POST /todos` (add), `POST /todos/:id/toggle`
  (done), `POST /todos/:id/delete`. Server-rendered HTML, form posts —
  no client JS framework required.
- **Data:** SQLite DB at `/srv/todo/db.sqlite3`, schema
  `todos(id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER
  NOT NULL DEFAULT 0, created_at TEXT)`, seeded with a few example
  items at boot if empty.
- **Vendored gems (all pure Ruby):** sinatra, rack, rackup, tilt,
  mustermann, rack-protection, ruby2_keywords — staged onto the guest
  load path (e.g. `/srv/todo/vendor/**` with `$LOAD_PATH`/RUBYLIB, or a
  bundler `--path` layout). Exact vendoring mechanism decided in the
  plan; requirement is that `require "sinatra"` works offline in-guest.
- **Depends on:** SQLite-enabled Ruby (component 1).

### 3. dinit service (`todo`)

- **What it does:** starts and supervises the app.
- **How:** `addDinitInit` with a `todo` service running
  `ruby /srv/todo/app.rb` (cwd `/srv/todo`), bound `0.0.0.0:8080`, with a
  logfile. Boot argv: `["/sbin/dinit","--container","-p",
  "/tmp/dinitctl","todo"]`.

### 4. Product manifest (`images/vfs/products/browser-ruby-todo.toml`)

- Composes `browser-main-shell` (embedded) + the `ruby` package
  (runtime) + `dinit` + the `kernel-wasm` toolchain; declares the
  builder, mounts (`/` from built-image, `/tmp` scratch 1777), boot argv
  + env, and node/browser evidence smoke-test names.

### 5. Builder (`images/vfs/scripts/build-ruby-todo-vfs-image.{sh,ts}`)

- Loads the shell base FS, writes the ruby binary/runtime, the app tree
  and vendored gems, seeds the DB (or seeds on first boot in-app),
  installs the dinit service, writes `/etc/kandelo/demo.json` via
  `writeKandeloDemoConfig` with `webPresentation()` and honesty copy,
  and saves the image. Models `build-wp-vfs-image.ts`.

### 6. Demo registration (browser app)

- `live-setup.ts`: new `LiveVfsImage`/product id `browser-ruby-todo`, a
  `VFS_SOURCES` entry, and a `LIVE_DEMO_SPECS["ruby-todo"]` with
  `network: true`, `init.web = { requiredPorts: [8080],
  requiredServices: ["todo"] }`.
- `dinit-boot-status.ts`: add `"ruby-todo": ["todo"]` to
  `REQUIRED_DINIT_SERVICES`.
- `presets.ts`: optional URL-composable preset.
- Gallery title/summary: "Ruby + Sinatra + SQLite" — never "Rails".

## Error handling

- **Boot failure surfaces truthfully:** if the app fails to start, dinit
  reports the `todo` service as failed and the UI shows it via
  `DinitBootStatusTracker`; the readiness gate does not mark the web
  surface ready. No synthesized success.
- **App-level errors:** Sinatra returns real 4xx/5xx; the demo does not
  mask them.
- **SQL safety:** all queries use bound parameters (`db.execute(sql,
  params)`), never string interpolation.
- **Persistence honesty:** UI copy states the DB is per-session and
  resets on reload; no claim of durable/private storage.

## Testing (proof-first; ordered as plan checkpoints)

1. **sqlite3-relink checkpoint (highest remaining risk):** rebuild
   `ruby.wasm` with the ext; run a guest query (`:memory:` create /
   insert / select) via the centralized test host. Green before app
   work.
2. **Sinatra-boots checkpoint:** vendor Sinatra + deps; `require
   "sinatra"` and serve one route on the guest. Verifies no dependency
   needs `openssl` at load. **Fallback:** if a dep requires `openssl` at
   load, switch the framework to **Roda** (rack-only), same design
   otherwise.
3. **App smoke (Node host):** dinit brings `todo` up, port 8080 answers,
   add/toggle/delete round-trip through real HTTP.
4. **Browser E2E:** `./run.sh browser`, load the demo, click the todo
   flow; confirm the web preview and dinit status.
5. **Package/ABI checks:** `scripts/check-abi-version.sh` and the
   relevant conformance considerations for the Ruby build change, per
   the ABI and validation contracts.

Validation claims will be scoped to exactly what was run (Node vs.
browser), per the validation contract.

## Risks & fallbacks

- **Sinatra dep needs openssl at load** -> fall back to Roda. (Cheap to
  detect at checkpoint 2.)
- **sqlite3 static relink friction** -> fall back to Path 2 (shell out to
  the `sqlite3` CLI via `Process.spawn`) or in-memory state, without
  changing the app's shape. (Compile risk already retired.)
- **Ruby artifact size growth** from the baked-in ext -> acceptable;
  measure and note. If undesirable, revisit demo-specific variant.

## Naming

- Product / image id: `browser-ruby-todo`.
- Demo id: `ruby-todo` (gallery), user-facing "Ruby + Sinatra + SQLite".
- dinit service: `todo`.
