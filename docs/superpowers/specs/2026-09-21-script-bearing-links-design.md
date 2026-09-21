# Script-Bearing Kandelo Links

Date: 2026-09-21
Status: Implementation complete

## Why

People should be able to hand someone a URL that opens Kandelo, boots a
machine, and visibly runs a shell script in that machine's initial
interactive shell. Today the browser app can *produce* shareable
`#k1=` descriptor fragments (share codec in
`web-libs/kandelo-session/src/boot-descriptor.ts`) but nothing ever
*consumes* them: `decodeBootDescriptor` has zero callers,
`apps/browser-demos/pages/kandelo/main.tsx` reads only
`location.search`, and the `ShareDialog` / `LiveUrlBar` components are
unreferenced dead UI. This feature wires the first real consumer of the
fragment and adds a script payload to it.

## Decisions already made

- Reuse the existing versioned `#k1=base64url(gzip(JSON))` fragment as
  the carrier. No new ad-hoc URL channel.
- The script runs under the image's default shell (bash on images that
  ship it), not forced POSIX `sh`.
- No consent dialog in the first slice, because every machine the app
  boots today is ephemeral. See the loud warning below.
- Execution is file-then-invoke (write the script to a file, type the
  invocation into the shell), not pasting script text into the PTY,
  and the invocation runs *as* the image's autoCommand — a new
  highest-precedence branch in the existing launch ladder, not a
  separate hook.
- Authoring lives in the existing `ShareDialog`, which this work also
  wires into the app UI for the first time.

## ⚠️ LOUD WARNING: consent is REQUIRED before persistent machines

This design deliberately auto-runs URL-supplied scripts **only because
every machine is ephemeral today**: a hostile link can at worst waste
the visitor's own tab. The moment Kandelo restores persistent machines
(OPFS-backed images, restored snapshots, anything a user would mind
losing), auto-run becomes a drive-by attack on user data: a clicked
link could destroy or exfiltrate a persisted machine.

**Before any persistent/restored-machine feature ships, script links
MUST gain an explicit consent step** (display the full script, require
a Run/Skip choice, never execute on load). Whoever implements
persistence must treat this as a blocking dependency, not a follow-up.
The implementation must carry this warning as a prominent comment at
the script-execution site.

## Design

### 1. Carrier: descriptor v1 gains optional `inputs` and `parameters` fields

Descriptor `version: 1` remains unchanged in structure; two new optional fields
carry boot inputs and configuration parameters:

In `web-libs/kandelo-session/src/kernel-host.ts`, the new fields attach to
`BootCommand` (reached as `descriptor.boot.inputs`/`descriptor.boot.parameters`):

```ts
export interface BootCommand {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  uid?: number;
  gid?: number;
  /** Named input files to resolve and stage before the initial process. */
  inputs?: BootInput[];
  /** Structured boot parameters materialized to /run/kandelo/boot-input.json. */
  parameters?: BootParameters;
}

export interface BootInput {
  /** Unique input identifier (e.g., "script"). */
  id: string;
  /** Filename when materialized (e.g., "kandelo-link.sh"). */
  filename: string;
  /** Input source: inline bytes or resolver reference. */
  source: BootInputSource;
}

export type BootInputSource =
  | { kind: "inline"; bytes: Uint8Array; sha256: Uint8Array; compression?: "gzip" }
  | { kind: "resolver"; resolverName: string; resolverData: unknown };

export type BootParameters = Record<string, unknown>;
```

Validation in `boot-descriptor.ts` (`validateBootDescriptor`):

- New `HARD_CAPS`: `maxBootInputs`, `maxInlineInputBytes` (32 KiB per input),
  `maxInlineInflatedInputBytes` (2 MiB per input), `maxTotalInputBytes`,
  `maxParametersBytes` (32 KiB JSON text).
- `inputs`, when present, must be an array of objects with `id`, `filename`,
  and `source`; each id must be unique; inline sources require sha256 hash
  and uncompressed byte length for verification; reject oversize with coded
  `BootDescriptorError`s (`E_TOO_MANY_INPUTS`, `E_INPUT_SIZE`,
  `E_INPUT_TOTAL_SIZE`, `E_INLINE_TOO_LARGE`, `E_INPUT_HASH`,
  `E_INPUT_HASH_MISMATCH`).
- `parameters`, when present, must be a plain JSON object; reject oversize
  with `E_JSON_TOO_LARGE`.
- Descriptor stays `version: 1`. The existing parser tolerates unknown fields,
  so old app builds that decode a descriptor with inputs simply ignore them;
  they do not fail.

### 2. Boot wiring: first consumer of `decodeBootDescriptor`

`apps/browser-demos/pages/kandelo/main.tsx` (and the query-param layer
in `url-state.ts`) gains fragment handling:

- On load, attempt `decodeBootDescriptor(location.hash)`.
- `null` (non-`k1` fragment) → existing behavior unchanged. The
  trusted-VFS-URL fragment channel (`live-setup.ts` demo-id-in-hash)
  is a *different* hash consumer; `decodeBootDescriptor` already
  returns `null` for non-`k1` fragments, so the two coexist.
- Malformed / oversized / cap-violating fragment → **loud visible
  failure** (error surface naming the `BootDescriptorError` code), no
  silent fallback boot. This is the browser-and-user contract's
  untrusted-input rule.
- A valid descriptor's image selection stays on the existing rails:
  the root image mount ref / demo id goes through the same
  trusted-source matching (`matchTrustedVfsSourceId`) and capacity
  policy as `?demo=` / `?vfs=` today. A fragment cannot select an
  image or escalate a limit that the query params could not.
- `descriptor.boot.inputs` and `descriptor.boot.parameters` are passed to
  `createLiveHost` for materialization at the image-staging point in
  `live-setup.ts`.

### 3. Execution: boot inputs materialize before the initial shell

Boot inputs are materialized in the kernel-owned VFS before the initial shell
starts. The library `materializeBootInputs` in `web-libs/kandelo-session/src/boot-inputs.ts`
performs all-or-nothing materialization with sha256+byteLength verification:

1. Each inline input's compressed bytes are decompressed if tagged with
   `compression: "gzip"`.
2. Every input's sha256 hash and final byteLength are verified against the
   descriptor's declared values. If any input fails verification, the entire
   operation aborts with no VFS changes.
3. Inputs materialize under `/run/kandelo/inputs/<id>/<filename>` with mode
   `0o755` (writable, executable). The directory `/run/kandelo/inputs` is
   created recursively.
4. An input manifest at `/run/kandelo/boot-input.json` records `{version:1,
   parameters, inputs}` so guest code can inspect what was supplied.

The script is the first consumer of boot inputs: when `boot.parameters.runScript`
names an input id (e.g., `"script"`), the launch ladder in
`apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` becomes:

1. `profile.framebufferTest` (unchanged).
2. **New branch: script-input execution** (highest precedence, above
   `presentation.autoCommand`):
   - If `boot.parameters.runScript` names an input that exists in the
     manifest, resolve the invoking shell: probe `host.stat("/bin/bash")`
     and invoke with `bash` when it exists, falling back to `sh` when it
     doesn't. Authors needing another interpreter can `exec` it from the
     script body.
   - Run `host.runShellCommand("cat <scriptPath>")` so the full script
     contents are displayed in the terminal.
   - Run `host.runShellCommand("<shellPath> <scriptPath>")` with the same
     `tick` progress line and `.catch` error reporting the existing
     autoCommand branches use — one code path, identical semantics.
   - If `runScript` names an unknown input id or materialization failed
     previously, this branch throws a loud boot error and aborts.
3. `presentation.autoCommand`, `profile.autoCommand` (unchanged).

The visitor sees the script's contents printed via `cat`, then the invocation
typed into their terminal and the output stream normally. The file remains
writable at `0o755` so the visitor can inspect, edit, and re-run it after boot.

Precedence falls out of the ladder: a link that carries a script suppresses
the image's `presentation.autoCommand` and the profile `autoCommand` (running
both would interleave two command streams in one PTY).

Ownership boundary: the script occupies the autoCommand *slot in the launch chain*
but is never written into `/etc/kandelo/demo.json` — that file is image-owned
presentation metadata, and a URL payload must not masquerade as image state.
The materialized script files live under `/run/kandelo/inputs`, which is a
boot-local runtime directory, not image metadata.

### 4. Share dialog: wire it in and add script authoring

`ShareDialog` exists but is unmounted. This work:

- Adds a Share affordance to the app chrome in
  `apps/browser-demos/pages/kandelo/app/App.tsx` (alongside the
  existing theme/internals controls) that opens `ShareDialog` for the
  current machine.
- Adds a "Run a script on open" textarea to the dialog. Non-empty text
  is compressed with gzip, wrapped in `createInlineBootInput({ id:
  "script", filename: "kandelo-link.sh", bytes, compression: "gzip" })`,
  and becomes a `boot.inputs` entry with corresponding `boot.parameters:
  { runScript: "script" }`. The byte counter shows the inflated size vs
  `maxInlineInflatedInputBytes` (2 MiB); the dialog skips zero-length
  scripts silently. Authors see URL size in the existing tier bar as they
  type.
- Emits links in the shape that actually opens today:
  `location.origin + location.pathname + "?demo=<id>" + "#" + fragment`.
  `buildShareUrl`'s path-based modes (`/c/<id>`, `/m/…`, `/p/…`) have
  no routes in this app; the dialog must not present URLs that 404.
  The unroutable modes and the never-implemented encrypt toggle are
  hidden until they are real (truthful-failure principle: do not offer
  share modes the platform does not honor).

Authoring flow: open a demo → click Share → paste script → copy URL.

### 5. Non-goals (this slice)

- No VFS overlay/state capture (`takeSnapshot` still computes no real
  overlay; `delta`/`inline` remain effectively preset links).
- No descriptor-v2 / BootInput integration (that lives on the emulator
  branch `emdash/consider-video-game-emulators-3ksig`; the `script`
  field is designed to be absorbed there as another boot input at
  rebase time).
- No standalone link-builder page, no server-side short links, no
  script signing.
- No consent UI — see the loud warning; it becomes mandatory with
  persistence.

## Testing

- **Unit (Vitest):** encode→decode round-trip for a descriptor with
  script input; rejection cases for every new cap (`E_TOO_MANY_INPUTS`,
  `E_INPUT_TOO_LARGE`, `E_PARAMETERS_TOO_LARGE`, oversized parameters
  JSON, bad sha256, duplicate input ids); confirm a non-`k1` fragment
  still decodes to `null`; confirm unknown-field tolerance (old descriptor
  without `inputs` and new descriptor decoded by validation both pass);
  zero-length inline inputs round-trip without error; sha256 mismatch
  fails materialization loudly.
- **Browser (Playwright):** open a URL with a script-bearing input
  fragment → machine boots → `/run/kandelo/inputs/script/kandelo-link.sh`
  exists with mode 0o755 → `/run/kandelo/boot-input.json` exists → terminal
  shows the script's invocation and output; malformed fragment → visible
  error, no boot-as-if-nothing-happened; Share dialog round-trip (open
  dialog, enter script, copy URL, open copied URL in a new page, observe
  the script run and the materialized files on disk).
- **Manual:** user-visible browser behavior verified with
  `./run.sh browser` per the validation contract.

## Files touched

| File | Change |
|---|---|
| `web-libs/kandelo-session/src/kernel-host.ts` | `BootInput`, `BootInputSource`, `BootParameters` types; `inputs?` and `parameters?` fields |
| `web-libs/kandelo-session/src/boot-inputs.ts` | new library: `materializeBootInputs`, `BootInputManifest`, materialization with verification and VFS write atomicity |
| `web-libs/kandelo-session/src/boot-descriptor.ts` | input/parameter caps and validation, error codes |
| `apps/browser-demos/pages/kandelo/main.tsx` | decode `#k1=` fragment, pass `inputs`/`parameters` to boot |
| `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` | call `materializeBootInputs`, script branch in the autoCommand ladder (resolving input id "script"), consent warning comment |
| `apps/browser-demos/pages/kandelo/dialogs/ShareDialog.tsx` | script textarea → boot input via `createInlineBootInput` with gzip |
| `apps/browser-demos/pages/kandelo/app/App.tsx` | Share affordance |
| `web-libs/kandelo-session/test/…`, `apps/browser-demos/test/…` | tests covering inputs, parameters, materialization, and script-input execution |
