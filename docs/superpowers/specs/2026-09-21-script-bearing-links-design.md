# Script-Bearing Kandelo Links

Date: 2026-09-21
Status: Approved design, pre-implementation

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

### 1. Carrier: descriptor v1 gains an optional `script` field

In `web-libs/kandelo-session/src/kernel-host.ts`:

```ts
export interface BootDescriptor {
  // ...existing fields...
  /** Optional script run in the initial interactive shell after boot. */
  script?: BootScript;
}

export interface BootScript {
  /**
   * Script text, executed by the image's default shell. Authors should
   * target the shell the image ships (bash for the stock shell image).
   */
  text: string;
}
```

Validation in `boot-descriptor.ts` (`validateBootDescriptor`):

- New `HARD_CAPS.maxScriptBytes = 32 * 1024` (UTF-8 byte length,
  mirroring `maxInlineOverlayBytes`).
- `script`, when present, must be an object with exactly a non-empty
  string `text`; reject NUL bytes; reject oversize with a coded
  `BootDescriptorError` (`E_SCRIPT_TOO_LARGE`, `E_SCRIPT_INVALID`).
- Descriptor stays `version: 1`. The existing parser tolerates unknown
  fields, so old app builds that decode a script-bearing link simply
  ignore the script; they do not fail. The emulator branch's
  descriptor-v2 work absorbs this field at rebase time.

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
- `descriptor.script` is stashed for the execution hook (below).

### 3. Execution: the script runs *as* the autoCommand

The launch chain at
`apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts:1438-1469`
is an if/else-if ladder: `profile.framebufferTest` →
`presentation.autoCommand` → `profile.autoCommand`. The URL script
becomes a new branch in that ladder, inserted as the
highest-precedence *shell-command* branch (above
`presentation.autoCommand`; `framebufferTest` is a dev-profile
surface test and keeps its position):

1. Before the ladder runs:
   `host.writeFile("/tmp/kandelo-link.sh", bytes, 0o755)` — `/tmp` is
   the always-present ephemeral scratch mount, so no mkdir is needed.
   The file is left in place writable so the visitor can inspect,
   edit, and re-run it after boot.
2. Resolve the invoking shell: the image's configured default shell
   (`/etc/kandelo/shell.json` via the host's shell config, the same
   source `startShellCommand` uses for prompt detection), falling back
   to `sh` when the image declares none.
3. The new branch first runs
   `host.runShellCommand("cat /tmp/kandelo-link.sh")` so the full
   script contents are displayed in the terminal, then runs
   `host.runShellCommand("<shellPath> /tmp/kandelo-link.sh")` with the
   same `tick` progress line and `.catch` error reporting the existing
   autoCommand branches use — one code path, identical semantics.

The visitor sees the script's contents printed via `cat`, then the
invocation typed into their terminal and the output stream normally.

Precedence falls out of the ladder: a link that carries a script
suppresses the image's `presentation.autoCommand` and the profile
`autoCommand` (running both would interleave two command streams in
one PTY).

Ownership boundary: the script occupies the autoCommand *slot in the
launch chain* but is never written into `/etc/kandelo/demo.json` —
that file is image-owned presentation metadata, and a URL payload
must not masquerade as image state.

### 4. Share dialog: wire it in and add script authoring

`ShareDialog` exists but is unmounted. This work:

- Adds a Share affordance to the app chrome in
  `apps/browser-demos/pages/kandelo/app/App.tsx` (alongside the
  existing theme/internals controls) that opens `ShareDialog` for the
  current machine.
- Adds a "Run a script on open" textarea to the dialog. Non-empty text
  becomes `descriptor.script`, is validated live against
  `maxScriptBytes` (show the byte count against the cap), and feeds the
  existing tier bar so authors see URL size as they type.
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

- **Unit (Vitest):** encode→decode round-trip for a script-bearing
  descriptor; rejection cases for every new cap (`E_SCRIPT_TOO_LARGE`,
  `E_SCRIPT_INVALID`, NUL bytes, non-string, empty); confirm a non-`k1`
  fragment still decodes to `null`; confirm unknown-field tolerance
  (old descriptor without `script` and new descriptor decoded by
  validation both pass). The unwritten `k1` round-trip cases listed in
  `docs/plans/2026-05-14-kandelo-ui-followups.md` are implemented for
  the paths this change touches.
- **Browser (Playwright):** open a URL with a script-bearing fragment →
  machine boots → terminal shows the invocation and the script's
  expected output; malformed fragment → visible error, no boot-as-if-
  nothing-happened; Share dialog round-trip (open dialog, enter
  script, copy URL, open copied URL in a new page, observe the script
  run).
- **Manual:** user-visible browser behavior verified with
  `./run.sh browser` per the validation contract.

## Files touched

| File | Change |
|---|---|
| `web-libs/kandelo-session/src/kernel-host.ts` | `BootScript` type, `script?` field |
| `web-libs/kandelo-session/src/boot-descriptor.ts` | `maxScriptBytes` cap, script validation, error codes |
| `apps/browser-demos/pages/kandelo/main.tsx` | decode `#k1=` fragment, loud failure surface |
| `apps/browser-demos/pages/kandelo/url-state.ts` | fragment/query precedence helpers |
| `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` | script branch in the autoCommand ladder + consent warning comment |
| `apps/browser-demos/pages/kandelo/dialogs/ShareDialog.tsx` | script textarea, working-URL shape, hide unroutable modes |
| `apps/browser-demos/pages/kandelo/app/App.tsx` | Share affordance |
| `web-libs/kandelo-session/test/…`, `apps/browser-demos/test/…` | tests above |
