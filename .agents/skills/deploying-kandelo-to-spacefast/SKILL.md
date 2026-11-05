---
name: deploying-kandelo-to-spacefast
description: Use when preparing or deploying a Kandelo web app or CORS proxy on Spacefast, or changing its deployment scripts and documentation while preserving WP Cloud support.
---

# Deploying Kandelo to Spacefast

This skill owns Kandelo's local preparation workflow. Follow the installed
Spacefast skill and current tool contracts for platform management and
publication. A connected account is not a destination or publishing request.

## Read first

Read `CLAUDE.md`, then
`docs/agent-guidance/spacefast-deployment.md`. That focused guide is the
authority for target selection, publication intent, private context, the
script's modes and validation claims. Use
`apps/spacefast-cors-proxy/README.md` for runtime boundaries and advanced
layouts; use `apps/signalling/spacefast/README.md` for signalling behavior.
Paths are relative to the repository root.

## Workflow

1. Resolve the user's selected existing Space and its canonical HTTPS
   origin. Reuse authorization already given for that target; do not infer
   a personal deployment from old examples or saved CLI state. Keep real
   deployment URLs and account identifiers out of tracked source and docs.
2. Use Node 24 and the repository's build prerequisites. Run
   `node scripts/deploy-spacefast.mjs --help` for the current interface.
   Preparation does not require installing or authenticating the CLI.
3. Prepare with
   `node scripts/deploy-spacefast.mjs --space "$KANDELO_SPACE_URL"`.
   For an already authorized deployment use `--publish`; for a local CLI
   check use `--dry-run`. Do not run all modes as successive required steps.
   Add repeated `--allow-referer` only for origins the operator approves.
4. Review the generated bundle, relevant tests and current platform limits.
   If a prepared artifact is awaiting approval, keep that exact artifact and
   use its printed publish command after approval. Do not rebuild merely to
   cross the publication boundary. If the user selected MCP publication,
   give the generated bundle to that authorized Functions-aware workflow.
5. Verify the receipt and actual live version after publication. Verify
   runtime requests and direct peer traffic separately. Report whether the
   result is prepared, locally checked, preview-ready or live.

For a standalone proxy Space, follow the service README's separate-proxy
recipe instead. Its existing packager requires explicit approved client
origins; publish only its generated bundle to the explicitly selected proxy
Space. The deployment script prepares the combined app layout.

Spacefast remains optional. Normal `./run.sh build-browser` output keeps
the portable PHP signalling endpoint and the default Playground proxy for
WP Cloud. Do not add personal defaults, auto-authentication, auto-installation,
access changes or a shared fallback quota to make deployment convenient.

## Verify changes

Run `scripts/dev-shell.sh npm --prefix apps/spacefast-cors-proxy test` for
orchestration and packaging changes. Use account-free subprocess fixtures
for the deployment script and the official CLI's dry run for a real generated
bundle when available. Neither proves live Spacefast behavior. Follow the
focused guide for required live checks and the current service README for
the experimental separate-proxy layout and known networking boundaries.
