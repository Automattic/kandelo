# Optional Spacefast Deployment

Read this guide when preparing, publishing, documenting or debugging Kandelo
on Spacefast. The normal static build and portable PHP signalling endpoint
remain supported for WP Cloud. Do not change deployment defaults or add
automatic Spacefast publishing as part of another build.

## Target and publication intent

Use the operator's explicitly selected Space and canonical HTTPS origin.
Do not infer a destination or owning team from examples, previous agents'
test sites, CLI link state, or the fact that an account is signed in. Reuse
a target already authorized in the current task without asking again. If a
new Space is needed, resolve its owning team before creation. The reusable
script targets an existing Space and never creates one or changes access.

Preparing code, documentation or a bundle does not itself publish it. When
the user has requested deployment, use the existing authorization and finish
the work; do not add another confirmation step. Respect the active platform
tool's actual approval requirements and never bypass a rejected operation.
Do not install the CLI or start authentication as an incidental build step.

## Reusable workflow

Prefer `scripts/deploy-spacefast.mjs` over copying a session-specific command
sequence. It requires Node 24, as do the service tests. Its orchestration
uses Node's standard library; compilation and packaging run through the
repository's normal build entry point and declared development shell.
The external `sf` CLI runs in the operator's host environment so its existing
authentication remains usable.

```sh
# Set KANDELO_SPACE_URL to the selected Space's canonical HTTPS origin.
node scripts/deploy-spacefast.mjs --space "$KANDELO_SPACE_URL"
node scripts/deploy-spacefast.mjs --space "$KANDELO_SPACE_URL" --dry-run
node scripts/deploy-spacefast.mjs --space "$KANDELO_SPACE_URL" --publish
```

These are alternative modes, not three steps to run every time. With no
mode flag the script prepares a bundle and prints an exact command to
publish that same artifact later. Use that printed command for an approved
prepared bundle instead of rebuilding it unnecessarily. `--dry-run` prepares
and runs the CLI's local publish checks. `--publish` prepares and updates the
selected live Space. No flag installs tools, signs in or changes access.

The script builds at `/` with `/cors-proxy?url=` and `/signalling`, packages
only the generated static directory, and automatically approves the selected
origin. Repeat `--allow-referer` for additional approved app origins. The
policy uses exact origins, not all Spacefast subdomains. The generated bundle
and temporary static output live under unique gitignored `.context` paths.
Never publish the repository, tests, keys, `.env` files or `.spacefast` state.

Guest web previews need a second, public Space: pass `--preview-space` with
its canonical origin. The script builds the app and the preview bundle for
each other, publishes the preview Space first, and never approves it for the
proxy. Without it the deployed app refuses to open web previews; never work
around that by serving guests from the app Space. See the service README's
[guest preview Space](../../apps/spacefast-cors-proxy/README.md#guest-preview-space)
section, including the platform behaviors a first deployment must verify.

For a standalone proxy, use the service README's
[separate-proxy recipe](../../apps/spacefast-cors-proxy/README.md#separate-proxy-site).
Its existing packager requires explicit approved client origins. Publish its
generated bundle to the selected proxy Space. The deployment script above
prepares the combined Kandelo app, proxy and signalling layout.

For platform operations, follow the installed Spacefast skill/tool contracts
and the user's selected publishing method. If MCP publication is preferred,
prepare the bundle with the script's default mode and publish that artifact
through the authorized Functions-aware flow. CLI installation and account
setup are separate operator decisions, not script fallbacks.

## Platform contracts

Spacefast supplies `env.DB` and the native PHP database. Tables initialize
on first use. The PHP session Function verifies platform identity and signs
a quota credential; the worker checks it before fetching upstream. Publish
the updated frontend, worker and PHP bridge together. Private Spaces require
both clients to have access. Do not clear data, widen access or disable
limiting to make a failed check appear successful.

Keep explicit default-export router entry points and underscore-prefixed
bundled helpers: CLI 0.5.0 does not recognize esbuild's default-export alias
syntax. A plain Vite output directory is not the complete Spacefast package.
Spacefast packaging omits WP Cloud's self-modifying PHP piplet and supplies
the database-backed signalling Function instead; its original input remains
unchanged. Do not replace the PHP services for WP Cloud.

Keep platform limits explicit: the separate cross-origin proxy layout is
experimental; platform Fetch does not provide a claimed DNS-pinning guarantee;
identity quotas can be evaded by obtaining a fresh guest identity. WebRTC
still needs a direct route and no TURN relay is added. See the service README
for current limits rather than duplicating dated observations here.

## Validation and evidence

Run the proxy/packaging/deployment tests through `scripts/dev-shell.sh` when
changing orchestration or bundle shape. Check the generated bundle using an
official CLI dry run when that CLI is available. Keep unit tests independent
of accounts: replace subprocess tools in fixtures and assert explicit target,
allowlist, mode, unique output paths and failure propagation. Tests must never
publish to a real account.

A CLI dry run proves local packaging, not upload, platform admission or live
runtime behavior. After an authorized publication, inspect its receipt and
live state, then verify app boot, quota handshake, asset fetches and signalling.
Record direct peer traffic separately from successful signalling. A room that
exists is not evidence that WebRTC found a usable route. Report failed checks
and reproduced baseline failures without calling the full suite green.

## Reusable documentation and private context

Do not commit an operator's real Space URL, Space/version ID, team name/ID,
access link or credentials into examples, test fixtures, scripts or skills.
Use explicit arguments/environment variables in commands and reserved
`*.example` origins in tests. Keep account-specific deployment evidence and
local selection data in gitignored `.context` or the CLI's own ignored state.
Do not move those details into generic agent guidance or the PR description.

Use [the deployment recipes](../../apps/spacefast-cors-proxy/README.md) for
operator commands and runtime details. The repository skill at
`.agents/skills/deploying-kandelo-to-spacefast/SKILL.md` routes agents here.
