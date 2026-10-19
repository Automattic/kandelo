# Spacefast signalling

This is the TypeScript implementation of `../piplet.php`'s HTTP protocol,
for Kandelo's existing Spacefast Functions deployment. It carries opaque
`kandelo1:` offers and answers; guest traffic still travels over WebRTC.
It adds no STUN or TURN service and changes no guest networking semantics.

The combined packager in `apps/spacefast-cors-proxy/build-site.mjs` emits
`functions/signalling.mjs`, claiming exactly `/signalling`. The filename
cannot start with `_`: Spacefast excludes those files from its route table.
The PHP file remains the portable implementation and the development default.

## Build and deployment

For account setup and the complete publish sequence, see the
[Spacefast deployment quickstart](../../spacefast-cors-proxy/README.md#combined-kandelo-site).
For an existing Space, the commands are:

```sh
KANDELO_SPACE_URL='https://YOUR-KANDELO.space.fast'
./run.sh build-browser --base / --out .context/kandelo-spacefast-static \
  --cors-proxy '/cors-proxy?url=' --signalling-url /signalling
scripts/dev-shell.sh node apps/spacefast-cors-proxy/build-site.mjs \
  .context/kandelo-spacefast-static --allow-referer "$KANDELO_SPACE_URL"
# Replace BUNDLE_DIR with the final directory printed by the packager.
sf publish "BUNDLE_DIR" --prebuilt --space "$KANDELO_SPACE_URL" --wait
```

Spacefast supplies the database; tables are created on first use.
No account credentials, database connection string, test
fixtures, or repository files belong in that upload. Existing Space access
settings remain an independent admission layer: a private Space requires
both peers to have access. Same-origin browser requests carry their normal
Spacefast visitor cookies, which never become part of an SDP code or host key.
The signalling endpoint does not use the CORS proxy's request counter.

## Storage and concurrency

Spacefast's `env.DB` is a MySQL broker with a D1-shaped interface. Its batch
API is not assumed to provide a transaction spanning worker relay calls.
The first request creates `kandelo_signalling_v1` if necessary; ordinary
requests query the existing table without schema/seed round trips.

One row stores the bounded payload, an expiry index without connect codes,
and a random revision. Reads select only the addressed session or room.
Mutations read that entry and the expiry index, prune expired entries, then
compute a delta and perform one conditional SQL update. Spacefast limits a
broker operation to 64 KiB including framing. Large deltas are uploaded in
16 KiB chunks to a temporary row, and the final update reads them directly
inside MySQL. The pending upload cannot be seen by session readers; a partial
or unacknowledged upload leaves committed state intact. Chunks carry sequence
numbers. The final commit checks a five-minute staging lease; cleanup runs
afterwards and subsequent large requests sweep abandoned expired uploads.
Only changed fields are uploaded, so answering a join does not resend every
offer already in its room. MySQL checks the revision, the target's
expiry boundary, and the resulting payload's 8 MiB ceiling before replacing
any state. Unrelated codes stay in the database. After a revision conflict,
the request re-reads, rechecks host ownership, and reapplies the operation.
Eight unsuccessful attempts return 503 with `Retry-After: 1`.

This preserves single-answer semantics, host ownership, 256 named sessions,
256 rooms, and eight waiting joins per room across concurrent worker
instances. Sessions last 600 seconds, rooms 60 seconds since the host last
checked in, and joins 120 seconds from creation, including answered/refused
joins as in PHP. All expiry uses the database clock. The committed-state limit counts the
serialized SQL JSON payload, so database JSON formatting can make the byte
ceiling slightly more conservative than PHP's encoding.

There is no isolate-local session map or lock. Missing, failing, or malformed
broker responses return a generic 503, with no SQL/SDP parameters in logs.
An uncertain network failure is not automatically retried as a new mutation.
The host key is SHA-256 hashed and never stored in plaintext. Hosting access
is separate from the existing token/name-based signalling authorization.

## Verification

Build app-scoped SQL/PHP test tools, then run inside the canonical shell:

```sh
nix build --impure --no-link --print-out-paths \
  -f apps/signalling/spacefast/test/tools.nix > .context/signalling-tools.path
scripts/dev-shell.sh env \
  KANDELO_SIGNALLING_TEST_TOOLS="$(cat .context/signalling-tools.path)" \
  npm --prefix apps/signalling/spacefast test
```

Tests start disposable MariaDB instances on local Unix sockets, with no
network listener. They execute the production SQL and compare a shared HTTP
scenario against a disposable copy of the actual PHP piplet. They cover
sessions and rooms, byte/UTF-8 validation, host keys, expiry, full stores,
concurrent answers/joins, initialization recovery, contention and malformed
broker replies. The runner enforces 100% lines, branches and functions for
the handler and store. The tools are declared in the app's Nix file rather
than installed globally or added to the main development shell.

Local tests do not establish Spacefast's capacity or internet ICE
reachability. Live checks must verify the database binding and actual
browser session creation/joining. Spacefast can independently return an
HTML 429 during request bursts; successful matching tests are not evidence
that this hosting throttle has been resolved.

### Live verification

On 2026-10-17, private Spacefast v9 stored eight waiting
entries carrying maximum-size 65,536-byte codes, refused the ninth/tenth
with the protocol's 503, enforced the host key, and closed the room. These
entries were submitted sequentially to separate capacity correctness from
the platform's burst throttle. Concurrent named answers had exactly one
winner. The first implementation exceeded the broker's 64 KiB operation
limit; the chunked implementation passed the same live size check.

Two fresh Chromium contexts using the deployed Kandelo UI created and joined
a room, displayed both computers, transferred actual guest Netcat TCP data
from `10.89.0.2` to `10.89.0.1`, and closed the room. Desktop and 390px mobile
captures had no page errors, HTTP errors or horizontal overflow. The same
browser scenario passed against the PHP reference with the production
static build. These tests use the established same-computer loopback ICE
fixture and a microphone permission grant to expose candidates, without
requesting capture. They do not establish internet/NAT reachability or
Firefox/WebKit peer networking. Earlier default-candidate attempts exposed
the existing no-route/no-TURN boundary; no guest runtime code was changed.
