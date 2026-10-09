# WordPress through RoadRunner (local integration profile)

This profile starts the existing WordPress SQLite VFS and its nginx/PHP-FPM
services, then starts the real Kandelo Go RoadRunner server in the same VFS.
Its PHP CLI worker forwards RoadRunner requests to nginx on the guest's
loopback port 38080, preserving WordPress's FPM request lifecycle. The public
HTTP port is owned by RoadRunner. This is a Go/RoadRunner integration test,
not direct WordPress execution inside a RoadRunner PHP worker, a browser
gallery profile, or a source-only RoadRunner package.

From the repository root, with the adjacent Go fork available:

```sh
scripts/dev-shell.sh bash tests/go/roadrunner/build.sh
KANDELO_CACHE_GC_AUTO=0 ./run.sh build wp-vfs
scripts/dev-shell.sh bash -c 'node --import tsx packages/registry/wordpress/demo/serve-roadrunner.ts 3000'
```

The server prints its URL only after a WordPress page has passed through
RoadRunner. The local port is configurable as the final argument; port 38080
is reserved for the existing nginx backend. This profile stages the locally
built RoadRunner fixture at boot and does not change the published WordPress
VFS image. The URL is local to the machine running the command and remains
available only while that process is running. The PHP worker is a protocol
bridge, not the Composer RoadRunner SDK; replacing nginx/PHP-FPM with direct
WordPress worker execution still needs request-lifecycle integration.
