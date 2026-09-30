# Boot Inputs Fold-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the emulator prototype's boot-input model (named, sha256-verified, URL-carried files materialized into `/run/kandelo/inputs` before boot) into this branch on descriptor **version 1**, and migrate the `script` feature onto it so PR #1386 ships one payload mechanism.

**Architecture:** Lift `boot-inputs.ts` + its test suite and the codec/type additions from branch `emdash/consider-video-game-emulators-3ksig` (a prototype we may adapt freely; this branch merges first). Drop all v2 gating — `boot.inputs` and `boot.parameters` become optional version-1 fields (Kandelo has no links in the wild; the maintainer explicitly waived a version bump). Materialize inline-source inputs at the existing image-staging point in `live-setup.ts` with an **empty resolver registry**. The `script` descriptor field is REMOVED; a script travels as input id `script` (filename `kandelo-link.sh`, gzip transport) plus boot parameter `runScript: "script"`.

**Tech Stack:** TypeScript; Vitest via `host/vitest.config.ts`; Playwright in `apps/browser-demos/test/`.

**Spec:** docs/superpowers/specs/2026-09-21-script-bearing-links-design.md (amended by Task 3 to describe the input-based mechanism). Donor code: `git show emdash/consider-video-game-emulators-3ksig:<path>`.

## Global Constraints

- Build on top of HEAD (`bd1a72dd4`); never amend or rewrite existing commits.
- Descriptor stays `version: 1`. No `descriptorVersion`, no `E_VERSIONED_FIELD`, no v2 anywhere.
- Untrusted-input contract: every new field carries explicit caps + shape checks + coded `BootDescriptorError`s; loud failures; the fragment still cannot select an image (`?demo=`/`?vfs=` rails own identity).
- Donor deviations (decided): resolver registry ships EMPTY (inline sources only; `resolver`-kind inputs must still VALIDATE structurally but fail materialization loudly with "no resolver registered"); materialized files are written mode `0o755` (thread a mode through the lifted library or default it — the script file must stay editable-in-place per the maintainer's "writable for experimentation" decision, matching today's `/tmp/kandelo-link.sh` behavior).
- The consent LOUD WARNING comment at the script execution site must survive the migration verbatim (it may move with the code; it may not be trimmed).
- Do NOT port: range-zip, rom-archive, archive-browser, share-url*, shared-boot-policy, demo-guides retro additions, presets, styles, any `packages/registry/kandelo-retro` content.
- No `host/src` changes. Commit prefixes `Browser:`/`Docs:`; 72-col bodies; Claude co-author trailer.
- Batch mode: Tasks 1–3 implement + run only the cheap Vitest suite; one consolidated Playwright pass runs in Task 4. Firefox cannot launch here (chromium+webkit only); Playwright needs `WASM_POSIX_RESOLUTION_POLICY=source-only-v1` and `WASM_POSIX_SOURCE_ONLY_BINARY_ROOT=<worktree>/local-binaries/source-only-v1`; do not touch the dev servers on ports 5417/5411.

---

### Task 1: Port the boot-inputs library, types, codec validation, and tests (v1, additive)

**Files:**
- Create: `web-libs/kandelo-session/src/boot-inputs.ts` (from donor, adapted)
- Create: `web-libs/kandelo-session/test/boot-inputs.test.ts` (from donor, adapted)
- Modify: `web-libs/kandelo-session/src/kernel-host.ts` (types)
- Modify: `web-libs/kandelo-session/src/boot-descriptor.ts` (caps + validation)
- Modify: `web-libs/kandelo-session/test/boot-descriptor.test.ts` (inputs/parameters cases)

**Interfaces:**
- Consumes: donor branch `emdash/consider-video-game-emulators-3ksig` files of the same paths; our existing `HARD_CAPS`, `BootDescriptorError`, `validateBootDescriptor`.
- Produces (Task 2 depends on these exact names): types `BootJsonValue`, `BootInputSource` (`inline` | `resolver` kinds), `BootInput`, `BootParameters`; `BootCommand.inputs?: BootInput[]` and `BootCommand.parameters?: BootParameters`; caps `maxBootInputs`, `maxInlineInputBytes` (32 KiB), `maxInlineInflatedInputBytes` (2 MiB), `maxTotalInputBytes`, `maxParametersBytes` (32 KiB); library exports `KANDELO_BOOT_INPUT_DIR`, `KANDELO_BOOT_INPUT_MANIFEST_PATH`, `materializeBootInputs`, `createInlineBootInput`, `BootInputManifest`, `MaterializedBootInput`, `MaterializeBootInputsOptions`. The `script` field/`BootScript` stay untouched in this task (removed in Task 2).

- [ ] **Step 1:** Extract the donor's `boot-inputs.ts`, the `BootInput`-family types from its `kernel-host.ts`, and the input/parameter validation + caps from its `boot-descriptor.ts` (`git show emdash/consider-video-game-emulators-3ksig:web-libs/kandelo-session/src/<file>`). Splice into OUR files preserving our existing content (including current `script` validation). Adaptations: (a) all v1/v2 gating deleted — `inputs`/`parameters` validate whenever present on `version: 1`; (b) `BootInputManifest.descriptorVersion` field dropped (manifest stays `{ version: 1, parameters, inputs }`); (c) materialized file mode `0o755` (thread or default per Global Constraints).
- [ ] **Step 2:** Port the donor's `boot-inputs.test.ts`, adjusting for the adaptations (no v2 assertions; mode expectations 0o755; manifest shape). Add `boot-descriptor.test.ts` cases: valid inputs round-trip through encode/decode; every new cap rejection (`too many inputs`, oversized inline carried/inflated, oversized parameters, bad sha256 shape, duplicate input ids if the donor validates that — mirror donor's cases); `resolver`-kind source validates structurally.
- [ ] **Step 3:** Run: `cd host && ../scripts/dev-shell.sh npx vitest run ../web-libs/kandelo-session/test/` — gate on the runner's exit code. Expected: all pass, including the ~500-line ported suite.
- [ ] **Step 4:** Commit: `Browser: Port verified boot inputs onto descriptor v1` (body: provenance from the emulator prototype, the waived version bump, the empty-resolver and 0o755 deviations; 72 cols; co-author trailer). Stage exactly the five files.

### Task 2: Migrate `script` onto boot inputs; wire materialization at boot

**Files:**
- Modify: `web-libs/kandelo-session/src/kernel-host.ts` (remove `BootScript`, `script?`)
- Modify: `web-libs/kandelo-session/src/boot-descriptor.ts` (remove script validation + `maxScriptBytes`)
- Modify: `web-libs/kandelo-session/test/boot-descriptor.test.ts` (script cases → input-based equivalents)
- Modify: `apps/browser-demos/pages/kandelo/main.tsx`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Modify: `apps/browser-demos/pages/kandelo/dialogs/ShareDialog.tsx`
- Modify: `apps/browser-demos/test/kandelo-link-script.spec.ts`

**Interfaces:**
- Consumes: Task 1's exports verbatim.
- Produces: link scripts as `boot.inputs: [{id:"script", filename:"kandelo-link.sh", …inline gzip…}]` + `boot.parameters: { runScript: "script" }`; script materialized at `/run/kandelo/inputs/script/kandelo-link.sh`; manifest at `/run/kandelo/boot-input.json`.

- [ ] **Step 1 (codec):** Delete `BootScript`/`script?`/script validation/`maxScriptBytes`; rewrite the script codec tests as input-based (empty text → `createInlineBootInput` rejects zero-length? mirror donor semantics; oversized → inline caps).
- [ ] **Step 2 (main.tsx):** Replace the script extraction with passing the validated fragment's `boot.inputs`/`boot.parameters` into `createLiveHost` (new options `inputs`/`parameters`, same protected-candidate loud-throw as `script` had). The rejection message prefix `Rejected #k1= boot link fragment: ` (with `[code]`) is unchanged.
- [ ] **Step 3 (live-setup):** Merge `opts.inputs`/`opts.parameters` into `initialDescriptor.boot` (like `script` today). At the buildFs staging point (after `stageConfiguredAssets`, mirroring donor's call site), run `materializeBootInputs(requestedDescriptor, { resolvers: {}, mkdir: (p)=>ensureDirRecursive(buildFs,p), writeFile: (p,b,m)=>writeVfsBinary(buildFs,p,b,m) })`; keep the returned manifest. Replace the ladder's script branch: when `boot.parameters?.runScript` names a manifest input id, `cat <path>` then `<bash|sh> <path>` exactly as today (interpreter probe unchanged), with the consent warning comment moved intact; unknown `runScript` id or failed materialization = loud tick + boot error per donor semantics (materialization failure must fail the boot loudly, not skip).
- [ ] **Step 4 (ShareDialog):** Build the descriptor via `createInlineBootInput({ id: "script", filename: "kandelo-link.sh", bytes, compression: "gzip" })` + `parameters: { runScript: "script" }`. Byte counter still counts script text vs `maxInlineInflatedInputBytes`? No — keep the user-facing cap meaningful: show bytes vs `HARD_CAPS.maxInlineInflatedInputBytes` and let encode errors surface as today.
- [ ] **Step 5 (spec):** Update `kandelo-link-script.spec.ts`: `scriptFragment` helper builds the input+parameter descriptor (using `createInlineBootInput` — it is async); terminal assertions change `/tmp/kandelo-link.sh` → `/run/kandelo/inputs/script/kandelo-link.sh`; add one assertion that `/run/kandelo/boot-input.json` exists in-guest (e.g. append `cat /run/kandelo/boot-input.json` to a test script or assert via a second script line). All four existing test intents stay covered.
- [ ] **Step 6:** Run the Vitest suite as in Task 1 Step 3 (green), then commit: `Browser: Carry boot-link scripts as verified boot inputs` (body: one payload mechanism, path change, loud materialization failure; trailer). Playwright deferred to Task 4.

### Task 3: Docs and design-spec alignment

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-script-bearing-links-design.md` (§1 carrier, §3 execution)
- Modify: `docs/browser-support.md` ("Script-carrying share links" section)

- [ ] **Step 1:** Rewrite the affected sections to describe shipped reality: inputs/parameters on v1, inline-only resolver policy, sha256 + byteLength verification before any VFS write, `/run/kandelo/inputs/<id>/<filename>` + manifest path, script as the first input consumer, file left writable (0o755), consent boundary unchanged. Verify each sentence against the Task 1/2 code; fix prose, never code.
- [ ] **Step 2:** Commit: `Docs: Describe boot inputs as the share-link payload mechanism` (72 cols; trailer).

### Task 4: Consolidated validation

- [ ] **Step 1:** `cd host && ../scripts/dev-shell.sh npx vitest run ../web-libs/kandelo-session/test/` → gate on exit code.
- [ ] **Step 2:** From `apps/browser-demos` with the env exports: `npx playwright test test/kandelo-link-script.spec.ts test/kandelo-url.spec.ts --project=chromium --project=webkit` → expect all pass; on failure re-run the single test once to distinguish flake, report verbatim.
- [ ] **Step 3:** Report what ran and what did not (no conformance suites — no kernel surface touched; manual walkthrough remains the maintainer's).

### Task 5: Final review of the fold-in range and push

- [ ] **Step 1:** Whole-range review (base `bd1a72dd4` → HEAD) with the standard reviewer, focused on: donor-code adaptation correctness (no v2 remnants), untrusted-input caps coverage, consent comment intact, docs truthfulness.
- [ ] **Step 2:** Fix wave if needed (one dispatch + one scoped re-review), then push the branch (updates PR #1386; no merge).
