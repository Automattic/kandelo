# RoadRunner PHP worker integration probe

This focused probe builds a minimal RoadRunner v2025.1.6 server from the
pinned source commit `207b2b4ba75f2529ecccf801b3d8dd7038f22732` with
the adjacent `kandelo-dev/go` fork. The custom entrypoint registers the real
RoadRunner server, HTTP, and logging plugins. It does not build RoadRunner's
all-plugin CLI. A local `tcplisten` adapter uses Go's `net.Listen` for TCP;
the configured pipe relay never calls it. It rejects non-TCP listener
schemes rather than claiming their unavailable options work.

From the Kandelo repository root, after building the kernel and the
source-only `php` package:

```sh
KANDELO_CACHE_GC_AUTO=0 scripts/dev-shell.sh bash -c 'cargo xtask bootstrap php'
scripts/dev-shell.sh bash tests/go/roadrunner/build.sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/roadrunner/run.ts'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_ROADRUNNER_TESTS=1 npx playwright test test/go-roadrunner.spec.ts --project chromium'
```

The test starts RoadRunner through C `posix_spawn`, then RoadRunner starts
the resolved PHP CLI program as a worker with pipes. The PHP fixture speaks
the minimal Goridge control and HTTP response protocol directly. A C client
sends one local HTTP request and checks the PHP response. The test checks
ABI-contract digests and that no host diagnostics occur. It is not a test of
the Composer PHP SDK, production RoadRunner configuration, or full Go/POSIX
conformance. The `server.user` setting remains unsupported: the Go fork
returns `ENOSYS` for requested child credentials.
