# Upstream Node core survey

This harness measures upstream Node core compatibility for Kandelo. It stages
files from the package-pinned Node archive and runs the original suite
configuration, discovery, assertions, fixtures, and expected-status rules.
It stays outside package and product build scripts.

## Prepare and run

Pass the pinned `node-core-source` archive to `prepare.py`. It verifies the
package digest and records the archive, fixture, selection, and individual
source hashes. Each selection names exact upstream selectors, source files,
and extra fixture paths. Suite definitions, status files, and common helpers
come from the original archive. WPT selections include the wrapper's status
file, the upstream harness, and the complete fixture subtree the wrapper
discovers. The original runner still executes the exact selected groups.

```sh
scripts/dev-shell.sh python3 scripts/node-core-survey/prepare.py \
  /absolute/path/to/node-v26.13.0.tar.gz \
  scripts/node-core-survey/initial-shard.json .scratch/node-initial-prepared
./run.sh partial shell node-browser-bundle python-browser-bundle
scripts/dev-shell.sh node_modules/.bin/tsx scripts/node-core-survey/node-host.ts \
  .scratch/node-initial-guest .scratch/node-initial-prepared
```

The guest runs the ordinary installed `/usr/bin/node` symlink and CPython.
The runner and test files live under `/tmp` in the test machine. The installed
Python runs Node's `tools/test.py`, including its PTY helper when applicable.
The Node host captures the image, kernel, lazy asset hashes, actual guest
profile, process generations, cleanup, and upstream outcomes. The built-in
owned command facility contains the runner and its descendants. Each launch
has up to 120 seconds including cleanup and runs once.

For the native side, extract the prepared fixture archive into a temporary
directory outside the Kandelo checkout. Copy the authenticated native executable
into that temporary directory as well. The VFS loader test resolves a synthetic
CommonJS file beneath `process.execPath`, so the executable's package scope
matters even when the working directory is isolated. Use a clean environment
and the temporary directory as the current directory. Call `observe.py` with the output JSONL path, the absolute
native Node executable path, its authenticated SHA-256, and each distinct
selector from the same selection. The ledger uses both the selector and
the source path because some upstream names cover both a `.js` and an
`.mjs` file. The observer verifies the binary on upstream runner
launches and records the original runner decisions and output. Preserve
native configuration separately. A reference with different features serves
only cases where those differences leave the intended assertions applicable.

```sh
scripts/dev-shell.sh python3 scripts/node-core-survey/ledger.py \
  scripts/node-core-survey/initial-shard.json .scratch/node-initial-ledger.json \
  --native .scratch/node-initial-native.jsonl --node-host .scratch/node-initial-guest
```

Use a new report directory for each deliberate run. Inspect the setup,
upstream logs, process retirement, and per-case output before assigning
compatibility failures or asserting member coverage. An original runner
verdict applies to its case and build profile. Keep the distinct CLI,
filesystem/path/timers, CJS, and ESM gates in their own evidence records. When a host diagnostic occurs, the survey keeps complete newline-terminated observer records alongside the transport error. An incomplete final row is discarded. The ledger records the failed transport even when an individual row contains an upstream verdict.

## Browser hosts

Run each project against the same prepared selection and standard package
artifacts used for the Node host. The test serves image and lazy asset
snapshots from a loopback fixture server. The browser uses the ordinary
kernel-worker filesystem and guest process APIs.

For a run that overlaps a new image build, set
`KANDELO_NODE_SURVEY_BINARY_ROOT` to a retained copy of the candidate's
`partial/` and `source-only-v1/` parent directory. The same loader verifies
the partial image and resolves the kernel and lazy assets from that copy.
Compare the reported image, kernel, Node payloads, and lazy asset identities
with the candidate receipt before combining results across hosts.

```sh
scripts/dev-shell.sh npm --prefix apps/browser-demos ci
mkdir .scratch/node-survey-browsers
scripts/dev-shell.sh env \
  NODE_CORE_SURVEY_PREPARED=.scratch/node-initial-prepared \
  NODE_CORE_SURVEY_OUTPUT=.scratch/node-survey-browsers \
  apps/browser-demos/node_modules/.bin/playwright test \
  --config scripts/node-core-survey/browser.config.ts \
  --project chromium --project firefox --project webkit
```

Supply the project subdirectories to `ledger.py` as `--chromium`,
`--firefox`, and `--webkit`. Each directory retains its own observations,
browser version, artifact hashes, and retirement or setup error. The
standalone CJS and ESM selections in `shards/` record separate file-entry
results. They are bounded survey samples of the acceptance gates.
Set `NODE_CORE_SURVEY_PREPARED=--preflight` to record only the installed CLI
profile in the browsers. The Node host takes `--preflight` as its second
argument for the same profile.

`audit-catalog.py` checks the archived source against the adopted Candidate
2 inventory. `catalog-ledger.py` takes the gzipped catalog, the gzipped
native runner discovery JSONL, and one or more case ledgers to produce the
combined index. It retains evidence for individual candidates and leaves
unobserved cases explicitly unrun. Its ledger paths are relative to the
catalog directory, and each case records whether it is upstream or supplemental.
Pass a retained installed-CLI case summary with `--direct` and supply the
authenticated reference digest with `--native-reference-sha256`. The index
checks the source archive, fixtures, case arguments, artifact identity, and
guest retirement. Direct summaries normally identify each invocation by source
file. A harness that records a unique upstream selector as the invocation phase
can declare `"casePhaseField": "selector"`. Both forms require the recorded
command to match the native arguments and staged source. `directCaseEvidence` records these case bodies separately
from the original runner observations and counts. Reviewed observations retain the original
disposition and the reason or finding recorded in the source ledger.

When a guest runner stops before reporting a case verdict, the ledger checks
its child observations against the selected native command and staged source
path. A unique matching launch request earns `runner-timeout` or
`runner-interrupted` and records the last child event and receipt line.
An upstream child timeout has its own `timeout` verdict. The combined index
retains the original classification when it reconciles older receipts.

## Supplemental HTTPS checks

The `fetch-https-streaming` shard uses a Kandelo-authored test marked
`"origin": "kandelo"`. The original runner executes it through the same
bounded path as upstream tests. The prepared input receipt records the
supplemental source hash and the unchanged upstream fixture hashes.

The peer mode connects two independent kernels with the existing Kandelo
session network. The installed Node client uses numeric IPv4 and the test
server checks the guest peer address, so the result concerns the session
network independently of DNS or public Internet egress.

```sh
peer=$(mktemp -d .scratch/node-https-peer.XXXXXX)
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 2 \
  -subj '/CN=Kandelo controlled peer test' \
  -addext 'subjectAltName=IP:127.0.0.1,IP:10.89.0.1' \
  -keyout "$peer/peer-key.pem" -out "$peer/peer-cert.pem"
scripts/dev-shell.sh node_modules/.bin/tsx scripts/node-core-survey/node-host.ts \
  "$peer/node-host" "$peer" --peer
mkdir "$peer/browsers"
scripts/dev-shell.sh env NODE_CORE_SURVEY_PEER_FIXTURES="$peer" NODE_CORE_SURVEY_OUTPUT="$peer/browsers" \
  apps/browser-demos/node_modules/.bin/playwright test \
  --config scripts/node-core-survey/browser.config.ts \
  --project chromium --project firefox --project webkit
```

Run the authenticated native client and server on IPv4 loopback with the
same certificate using `native-peer.py <node> <sha256> "$peer" "$peer/native.json"`.
Peer receipts record both processes, exit fences, listener withdrawal, and
the image, kernel, executable, and fixture digests. The ephemeral test key
belongs in scratch.
