# Script-Bearing Kandelo Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Kandelo URL can carry a shell script in its `#k1=` fragment; opening the link boots the machine and visibly runs the script in the initial shell, and the (currently unwired) ShareDialog becomes the authoring UI.

**Architecture:** Extend descriptor v1 with an optional capped `script` field in the existing `#k1=base64url(gzip(JSON))` envelope; make `main.tsx` the first consumer of `decodeBootDescriptor` (fragment supplies ONLY the script — image selection stays on the `?demo=`/`?vfs=` query rails); run the script as a new highest-precedence shell-command branch of the existing autoCommand ladder in `live-setup.ts`; wire ShareDialog into the Dock with a script textarea that emits working `?demo=…#k1=…` URLs.

**Tech Stack:** TypeScript, React, Vitest (via `host/vitest.config.ts`, which includes `../web-libs/**/*.test.ts`), Playwright (`apps/browser-demos/test/*.spec.ts`).

**Spec:** `docs/superpowers/specs/2026-09-21-script-bearing-links-design.md` — read it first; it carries the approved decisions and the consent warning this plan must preserve.

## Global Constraints

- Build/verification commands run under `scripts/dev-shell.sh` (repo contract; direnv is convenience, not evidence).
- Commit subjects use `Area: Purpose` prefixes (`Browser:` for app/web-libs code, `Docs:` for docs). Wrap commit bodies at 72 columns.
- URL fragments are untrusted input: loud coded failures, hard caps, no silent fallback (browser-and-user contract).
- The consent warning comment (Task 2) is REQUIRED by the spec — do not trim it.
- No `host/src` changes are in scope, so no Node/browser parity work arises; if you find yourself editing `host/src`, stop — the plan is off the rails.
- All new behavior is browser-app surface (`web-libs/kandelo-session`, `apps/browser-demos`); the final user-visible claim requires a manual `./run.sh browser` check (Task 5), not just Playwright.
- Do not weaken or skip existing validation in `validateBootDescriptor` to make a test pass.

---

### Task 0: Provision the worktree and prove the test harnesses run

**Files:** none created — this task materializes build artifacts and verifies runners.

**Interfaces:**
- Consumes: nothing.
- Produces: a worktree where `npx vitest run` (from `host/`) and `npx playwright test` (from `apps/browser-demos/`) execute real tests.

- [ ] **Step 1: Provision platform artifacts**

A fresh worktree has no sysroots, kernel wasm, or program binaries. Building them is expected work, not scope creep:

```bash
cd /Users/brandon/conductor/workspaces/kandelo/houston
scripts/dev-shell.sh ./run.sh setup
npm install
npm --prefix host install
npm --prefix apps/browser-demos install
```

If any of these fail, read `docs/agent-guidance/validation.md` (fresh-worktree provisioning steps) and fix forward; a missing artifact is provisioning, an artifact that fails to build is a real platform failure to report.

- [ ] **Step 2: Prove Vitest runs web-libs tests**

```bash
cd host && npx vitest run ../web-libs/kandelo-session/test/kandelo-session.test.ts
```

Expected: existing tests PASS.

- [ ] **Step 3: Prove Playwright runs a browser spec**

Gotcha (recorded project memory): a stale vite dev server from another workspace on the default port makes Playwright silently test OLD code. Before running, check for and kill stale servers owned by other checkouts:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -i node   # look for vite servers on 5401/similar
```

Then:

```bash
cd apps/browser-demos && npx playwright test test/kandelo-url.spec.ts --grep "dock defaults"
```

Expected: PASS (this proves the app builds, boots `?demo=shell`, and the harness serves the current worktree's code).

- [ ] **Step 4: Commit nothing** — this task produces no tree changes. If it surfaced fixes, stop and report before proceeding.

---

### Task 1: `script` field in the descriptor codec, with unit tests

**Files:**
- Modify: `web-libs/kandelo-session/src/kernel-host.ts` (BootDescriptor at ~line 270)
- Modify: `web-libs/kandelo-session/src/boot-descriptor.ts` (`HARD_CAPS` ~line 25, `validateBootDescriptor` end ~line 357)
- Create: `web-libs/kandelo-session/test/boot-descriptor.test.ts`

**Interfaces:**
- Consumes: existing `validateBootDescriptor`, `encodeBootDescriptor`, `decodeBootDescriptor`, `BootDescriptorError`, `HARD_CAPS`.
- Produces: `interface BootScript { text: string }`; `BootDescriptor.script?: BootScript`; `HARD_CAPS.maxScriptBytes = 32 * 1024`; error codes `"E_SCRIPT_INVALID"` and `"E_SCRIPT_TOO_LARGE"`. Tasks 2–4 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Create `web-libs/kandelo-session/test/boot-descriptor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BootDescriptorError,
  decodeBootDescriptor,
  encodeBootDescriptor,
  HARD_CAPS,
  validateBootDescriptor,
} from "../src/boot-descriptor";
import type { BootDescriptor } from "../src/kernel-host";

const BASE: BootDescriptor = {
  version: 1,
  id: "shell",
  title: "Shell",
  base: "kandelo:shell@abi8",
  runtime: {
    arch: "wasm32",
    kernel: "kernel@local",
    memoryPages: 2048,
    features: [],
    time: "real",
  },
  packages: [],
  mounts: [{ path: "/", source: "image", ref: "shell.vfs@local" }],
  boot: { argv: ["/usr/bin/login"], cwd: "/root", env: {} },
};

function withScript(text: string): BootDescriptor {
  return { ...structuredClone(BASE), script: { text } };
}

function validationError(desc: unknown): BootDescriptorError {
  try {
    validateBootDescriptor(desc);
  } catch (err) {
    expect(err).toBeInstanceOf(BootDescriptorError);
    return err as BootDescriptorError;
  }
  throw new Error("expected validateBootDescriptor to throw");
}

describe("k1 envelope round-trip", () => {
  it("round-trips a descriptor without a script", async () => {
    const { fragment } = await encodeBootDescriptor(structuredClone(BASE));
    expect(fragment.startsWith("k1=")).toBe(true);
    const decoded = await decodeBootDescriptor(`#${fragment}`);
    expect(decoded).toEqual(BASE);
  });

  it("round-trips a descriptor with a script", async () => {
    const desc = withScript('echo "hello from a link"\nuname -a\n');
    const { fragment } = await encodeBootDescriptor(desc);
    const decoded = await decodeBootDescriptor(fragment);
    expect(decoded?.script).toEqual(desc.script);
  });

  it("returns null for a non-k1 fragment", async () => {
    expect(await decodeBootDescriptor("#node")).toBeNull();
    expect(await decodeBootDescriptor("")).toBeNull();
  });

  it("rejects garbage after a valid k1 envelope prefix", async () => {
    await expect(decodeBootDescriptor("#k1=AAAA")).rejects.toThrow();
  });
});

describe("script validation", () => {
  it("accepts a descriptor without a script", () => {
    expect(() => validateBootDescriptor(structuredClone(BASE))).not.toThrow();
  });

  it("rejects a non-object script", () => {
    const bad = { ...structuredClone(BASE), script: "echo hi" };
    expect(validationError(bad).code).toBe("E_SCRIPT_INVALID");
  });

  it("rejects a script with extra fields", () => {
    const bad = { ...structuredClone(BASE), script: { text: "echo hi", x: 1 } };
    expect(validationError(bad).code).toBe("E_SCRIPT_INVALID");
  });

  it("rejects an empty script text", () => {
    expect(validationError(withScript("")).code).toBe("E_SCRIPT_INVALID");
  });

  it("rejects NUL bytes in script text", () => {
    expect(validationError(withScript("echo\0hi")).code).toBe("E_SCRIPT_INVALID");
  });

  it("rejects script text over maxScriptBytes", () => {
    const big = "x".repeat(HARD_CAPS.maxScriptBytes + 1);
    expect(validationError(withScript(big)).code).toBe("E_SCRIPT_TOO_LARGE");
  });

  it("accepts script text exactly at maxScriptBytes", () => {
    const exact = "x".repeat(HARD_CAPS.maxScriptBytes);
    expect(() => validateBootDescriptor(withScript(exact))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd host && npx vitest run ../web-libs/kandelo-session/test/boot-descriptor.test.ts
```

Expected: FAIL — `maxScriptBytes` does not exist and script validation throws nothing (plus a TS error on `script:` until the type lands).

- [ ] **Step 3: Add the type**

In `web-libs/kandelo-session/src/kernel-host.ts`, directly after the `BootDescriptor` interface (~line 280), add:

```ts
export interface BootScript {
  /**
   * Script text run in the initial interactive shell after boot. Executed by
   * the image's default shell (bash on stock images), so authors should
   * target that shell; a shebang-selected interpreter can be exec'd from the
   * script body.
   */
  text: string;
}
```

and inside `BootDescriptor` (after `boot: BootCommand;`):

```ts
  /** Optional script a share link asks the machine to run after boot. */
  script?: BootScript;
```

- [ ] **Step 4: Add the cap and validation**

In `web-libs/kandelo-session/src/boot-descriptor.ts`, add to `HARD_CAPS` (after `maxInlineOverlayBytes`):

```ts
  /** Max UTF-8 bytes of a boot-link script (`descriptor.script.text`). */
  maxScriptBytes: 32 * 1024,
```

At the end of `validateBootDescriptor` (after the `uid`/`gid` loop, before the closing brace), add:

```ts
  if (d.script !== undefined) {
    if (!d.script || typeof d.script !== "object" || Array.isArray(d.script)) {
      throw new BootDescriptorError("E_SCRIPT_INVALID", "script must be an object");
    }
    const script = d.script as Record<string, unknown>;
    if (JSON.stringify(Object.keys(script).sort()) !== JSON.stringify(["text"])) {
      throw new BootDescriptorError(
        "E_SCRIPT_INVALID",
        "script must contain exactly a text field",
      );
    }
    if (typeof script.text !== "string" || script.text.length === 0) {
      throw new BootDescriptorError(
        "E_SCRIPT_INVALID",
        "script.text must be a non-empty string",
      );
    }
    if (script.text.includes("\0")) {
      throw new BootDescriptorError(
        "E_SCRIPT_INVALID",
        "script.text must not contain NUL bytes",
      );
    }
    if (new TextEncoder().encode(script.text).byteLength > HARD_CAPS.maxScriptBytes) {
      throw new BootDescriptorError(
        "E_SCRIPT_TOO_LARGE",
        `script.text exceeds cap of ${HARD_CAPS.maxScriptBytes} bytes`,
      );
    }
  }
```

The exact-key check follows the package-layer precedent for untrusted payloads: a future schema addition changes the envelope deliberately rather than slipping past old validators.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd host && npx vitest run ../web-libs/kandelo-session/test/boot-descriptor.test.ts
```

Expected: PASS (all tests). Then run the neighboring suite to catch collateral damage in the same directory:

```bash
cd host && npx vitest run ../web-libs/kandelo-session/test/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web-libs/kandelo-session/src/kernel-host.ts \
        web-libs/kandelo-session/src/boot-descriptor.ts \
        web-libs/kandelo-session/test/boot-descriptor.test.ts
git commit -m "Browser: Add capped script field to the k1 boot descriptor"
```

(Write a 72-column body explaining the field, the cap, and the error codes; end with the Claude co-author trailer.)

---

### Task 2: Boot wiring — decode the fragment, run the script in the autoCommand ladder

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/main.tsx` (whole file is 61 lines)
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` (`CreateLiveHostOptions` ~line 570, `initialDescriptor` ~line 616, `host.setDescriptor` in `bootProfile` ~line 1087, autoCommand ladder ~line 1455, new helper near `reportInitError` ~line 1043)
- Modify: `apps/browser-demos/pages/kandelo/url-state.ts` (`galleryItemUrl` ~line 37)
- Create: `apps/browser-demos/test/kandelo-link-script.spec.ts`

**Interfaces:**
- Consumes: Task 1's `BootScript`/`script?` field and `encodeBootDescriptor` (in the spec file); existing `decodeBootDescriptor`, `LiveKernelHost.writeFile/stat/runShellCommand`, `bootProfile`'s `requestedDescriptor` parameter (already validated at the top of `bootProfile` via `validateBootDescriptor`).
- Produces: `CreateLiveHostOptions.script?: string | null`; script execution at boot; `galleryItemUrl` drops the page hash. Task 3's share links depend on this boot path existing.

- [ ] **Step 1: Write the failing Playwright spec**

Create `apps/browser-demos/test/kandelo-link-script.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { encodeBootDescriptor } from "../../../web-libs/kandelo-session/src/boot-descriptor";
import type { BootDescriptor } from "../../../web-libs/kandelo-session/src/kernel-host";

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").first().evaluate(
    (node) => node.textContent ?? "",
  );
}

async function scriptFragment(text: string): Promise<string> {
  const descriptor: BootDescriptor = {
    version: 1,
    id: "shell",
    title: "Shell",
    base: "kandelo:shell@abi8",
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: 2048,
      features: [],
      time: "real",
    },
    packages: [],
    mounts: [{ path: "/", source: "image", ref: "shell.vfs@local" }],
    boot: { argv: ["/usr/bin/login"], cwd: "/root", env: {} },
    script: { text },
  };
  return (await encodeBootDescriptor(descriptor)).fragment;
}

test("a #k1= boot link runs its script in the initial shell @slow", async ({ page }) => {
  test.setTimeout(300_000);
  // $((6 * 7)) proves the SCRIPT executed: the literal answer never appears
  // in the typed command line, only in the script's output.
  const fragment = await scriptFragment('echo "link-script:$((6 * 7))"\n');
  await page.goto(appUrl(`/?demo=shell#${fragment}`), {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
  const text = expect.poll(() => terminalText(page), { timeout: 120_000 });
  await text.toContain("/tmp/kandelo-link.sh"); // visible invocation
  await text.toContain("link-script:42");       // script output
});

test("a malformed #k1= fragment fails loudly instead of booting", async ({ page }) => {
  await page.goto(appUrl("/?demo=shell#k1=!!!not-base64url!!!"), {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByText("Rejected #k1= boot link fragment", { exact: false }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".xterm-rows")).toHaveCount(0);
});

test("gallery navigation drops a boot-link fragment", async ({ page }) => {
  await page.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
  const next = await page.evaluate(async () => {
    const { galleryItemUrl } = await import("/pages/kandelo/url-state.ts");
    return galleryItemUrl(
      {
        id: "node",
        title: "Node.js",
        vfsImageUrl: "https://cdn.example.invalid/node.vfs.zst",
      },
      "https://kandelo.local/?demo=shell#k1=abc",
    );
  });
  expect(new URL(next).hash).toBe("");
  expect(new URL(next).searchParams.get("demo")).toBe("node");
});
```

- [ ] **Step 2: Run the spec to verify it fails**

```bash
cd apps/browser-demos && npx playwright test test/kandelo-link-script.spec.ts
```

Expected: FAIL — the first test times out without "link-script:42" (fragment is ignored today), the second finds no rejection message, the third finds a non-empty hash.

- [ ] **Step 3: Decode the fragment in `main.tsx`**

Add the import:

```ts
import { decodeBootDescriptor } from "../../../../web-libs/kandelo-session/src/boot-descriptor";
```

Inside the existing `void (async () => { try {` block, before the `createLiveHost` call, add:

```ts
    // URL fragments are untrusted input. A malformed or oversized #k1= boot
    // link must fail loudly here, not silently boot as if it were absent.
    const linkDescriptor = await decodeBootDescriptor(location.hash).catch(
      (err) => {
        throw new Error(
          `Rejected #k1= boot link fragment: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
```

and extend the `createLiveHost` options object:

```ts
        script: linkDescriptor?.script?.text ?? null,
```

(The fragment supplies ONLY the script in this slice; `?demo=`/`?vfs=` keep owning image selection — a fragment cannot select an image the query params could not.)

- [ ] **Step 4: Thread the script through `live-setup.ts`**

(a) Extend `CreateLiveHostOptions` (~line 570):

```ts
export interface CreateLiveHostOptions {
  demo?: string | null;
  vfsUrl?: string | null;
  fb?: FbDemo;
  /** Script text from a #k1= boot link; runs in the initial shell. */
  script?: string | null;
}
```

(b) At the `initialDescriptor` computation (~line 616), replace:

```ts
  const initialDescriptor = protectedProfile?.descriptor ??
    await descriptorForBootQuery(opts.vfsUrl, opts.demo);
```

with:

```ts
  let initialDescriptor = protectedProfile?.descriptor ??
    await descriptorForBootQuery(opts.vfsUrl, opts.demo);
  if (opts.script) {
    if (protectedProfile !== undefined) {
      // Protected candidate boots pin their descriptor byte-for-byte;
      // silently dropping the link's script would misrepresent the link.
      throw new Error(
        "protected browser candidate boots do not accept boot-link scripts",
      );
    }
    initialDescriptor = { ...initialDescriptor, script: { text: opts.script } };
  }
```

(c) In `bootProfile`'s `host.setDescriptor({ ... })` call (~line 1087), add one line so the UI descriptor truthfully includes the script:

```ts
    script: requestedDescriptor.script,
```

(d) Add the runner helper after `reportInitError` (~line 1059):

```ts
const LINK_SCRIPT_PATH = "/tmp/kandelo-link.sh";

async function runLinkScript(
  host: LiveKernelHost,
  text: string,
  tick: (msg: string) => void,
): Promise<void> {
  await host.writeFile(LINK_SCRIPT_PATH, new TextEncoder().encode(text), 0o755);
  // "Default shell" for the invocation: the PTY session program is login,
  // not a shell, so probe the image for bash and fall back to sh. Authors
  // needing another interpreter can exec it from the script body.
  const bash = await host.stat("/bin/bash").catch(() => null);
  const interpreter = bash ? "bash" : "sh";
  tick(`running boot-link script with ${interpreter}...`);
  await host.runShellCommand(`${interpreter} ${LINK_SCRIPT_PATH}`);
}
```

(e) Insert the ladder branch at ~line 1455, between the `framebufferTest` branch and `presentation?.autoCommand`:

```ts
    } else if (requestedDescriptor.script) {
      // ⚠️ CONSENT REQUIRED BEFORE PERSISTENT MACHINES ⚠️
      // This auto-runs a URL-supplied script with no confirmation, which is
      // acceptable ONLY because every machine this app boots is ephemeral: a
      // hostile link can at worst waste the visitor's own tab. The moment
      // Kandelo restores persistent machines (OPFS-backed images, restored
      // snapshots), auto-run becomes a drive-by attack on user data. Any
      // persistence feature MUST first add an explicit show-the-script
      // Run/Skip consent step here. See
      // docs/superpowers/specs/2026-09-21-script-bearing-links-design.md.
      void runLinkScript(host, requestedDescriptor.script.text, tick).catch(
        (err) => {
          tick(
            `boot-link script failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        },
      );
    } else if (presentation?.autoCommand) {
```

Note the ladder ordering consequence (already in the spec): a link script suppresses `presentation.autoCommand` and `profile.autoCommand`.

- [ ] **Step 5: Drop the page hash on gallery navigation**

In `url-state.ts` `galleryItemUrl` (~line 41), after `clearVfsImageQueryParams(url.searchParams);` add:

```ts
  // A #k1= boot-link fragment belongs to the linked machine only. Launching
  // a different machine from the gallery must not carry its script along.
  url.hash = "";
```

- [ ] **Step 6: Run the spec to verify it passes**

```bash
cd apps/browser-demos && npx playwright test test/kandelo-link-script.spec.ts
```

Expected: PASS (3 tests). Then confirm no URL-handling regressions:

```bash
cd apps/browser-demos && npx playwright test test/kandelo-url.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/browser-demos/pages/kandelo/main.tsx \
        apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts \
        apps/browser-demos/pages/kandelo/url-state.ts \
        apps/browser-demos/test/kandelo-link-script.spec.ts
git commit -m "Browser: Run k1 boot-link scripts in the initial shell"
```

(Body: first consumer of decodeBootDescriptor; script-as-autoCommand ladder branch; loud rejection of malformed fragments; consent warning rationale. 72 columns; Claude co-author trailer.)

---

### Task 3: Wire ShareDialog into the Dock with script authoring

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/dialogs/ShareDialog.tsx` (rework `SharePanel`)
- Modify: `apps/browser-demos/pages/kandelo/app/Dock.tsx` (new Share button + props, pattern of the internals button at ~line 488)
- Modify: `apps/browser-demos/pages/kandelo/app/App.tsx` (state + render + Dock props, ~lines 64–74 and 346–374)
- Modify: `apps/browser-demos/pages/kandelo/styles.css` (`.kshare-script` styles next to the existing `kshare-*` rules)
- Modify: `apps/browser-demos/test/kandelo-link-script.spec.ts` (add the round-trip test)

**Interfaces:**
- Consumes: Task 1's `script` field + `HARD_CAPS.maxScriptBytes`; Task 2's boot path; existing `encodeBootDescriptor`, `classifyTier`, `useKernelHost().getBootDescriptor()`.
- Produces: Dock props `shareAvailable: boolean` and `onOpenShare: () => void`; a `.kshare-url` element carrying `data-share-url`; a Share button reachable as `getByRole("button", { name: "Share this machine as a link" })`. The Task 3 test and Task 5 manual check rely on these.

- [ ] **Step 1: Write the failing round-trip test**

Append to `apps/browser-demos/test/kandelo-link-script.spec.ts`:

```ts
test("share dialog authors a script link that runs on open @slow", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });

  await page
    .getByRole("button", { name: "Share this machine as a link" })
    .click();
  await page
    .locator(".kshare textarea")
    .fill('echo "shared-script:$((40 + 2))"');
  await expect
    .poll(async () =>
      page.locator(".kshare-url").getAttribute("data-share-url"),
    )
    .toMatch(/#k1=/);
  const sharedUrl = await page
    .locator(".kshare-url")
    .getAttribute("data-share-url");
  if (!sharedUrl) throw new Error("share dialog produced no URL");

  await page.goto(sharedUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".xterm-rows").first()).toBeVisible({
    timeout: 180_000,
  });
  await expect
    .poll(() => terminalText(page), { timeout: 120_000 })
    .toContain("shared-script:42");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/browser-demos && npx playwright test test/kandelo-link-script.spec.ts --grep "share dialog"
```

Expected: FAIL — no Share button exists.

- [ ] **Step 3: Rework `SharePanel`**

Replace `SharePanel`'s body in `ShareDialog.tsx`. Keep the `ShareDialog` portal wrapper, `PrevRow`, and the header exactly as they are; the panel becomes: summary → script textarea → link + tier → descriptor preview → actions. Remove the mode picker, the snapshot effect, the Include-overlay and Encrypt toggles, and the `stripOverlayIfDisabled` helper — per the truthful-failure rule they promise behavior the platform does not implement (overlays are never computed, encrypt was UI-only, `/c/…`//`m/…`//`p/…` routes do not exist). Imports shrink to:

```ts
import {
  classifyTier, encodeBootDescriptor, HARD_CAPS,
} from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import type {
  BootDescriptor,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
```

New panel logic (replacing the old state + effect):

```ts
export const SharePanel: React.FC<SharePanelProps> = ({
  descriptor: presetDesc, onClose, embedded = false,
}) => {
  const host = useKernelHost();
  const [script, setScript] = React.useState("");
  const [url, setUrl] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const baseDescriptor: BootDescriptor = React.useMemo(
    () => presetDesc ?? host.getBootDescriptor(),
    [presetDesc, host],
  );

  const scriptBytes = React.useMemo(
    () => new TextEncoder().encode(script).byteLength,
    [script],
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const trimmed = script.trim();
        if (!trimmed) {
          if (!cancelled) { setUrl(workingShareUrl(null)); setError(null); }
          return;
        }
        const desc: BootDescriptor = {
          ...baseDescriptor,
          script: { text: script.endsWith("\n") ? script : `${script}\n` },
        };
        const { fragment } = await encodeBootDescriptor(desc);
        if (!cancelled) { setUrl(workingShareUrl(fragment)); setError(null); }
      } catch (err) {
        if (!cancelled) {
          setUrl("");
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [baseDescriptor, script]);
```

with this helper at module level:

```ts
/**
 * Links must open in THIS app. The codec's buildShareUrl() path modes
 * (/c/<id>, /m/…, /p/…) have no routes here, so the working link is the
 * current page URL (which already carries ?demo=/?vfs= machine identity)
 * plus the descriptor fragment.
 */
function workingShareUrl(fragment: string | null): string {
  const url = new URL(window.location.href);
  url.hash = fragment ?? "";
  return url.href;
}
```

Render changes inside the existing `kshare-body` structure:
- Update the second summary card's copy to match reality: `Export boundary` → text "Link-only sharing. The machine is ephemeral; the link carries the preset identity plus your script, nothing else."
- Add the script section before the Link section:

```tsx
          <div className="kshare-script">
            <div className="kshare-sect-lbl" style={{ marginBottom: 6 }}>
              Run a script on open
            </div>
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder={'echo "hello from this link"'}
              rows={5}
              spellCheck={false}
              aria-label="Script to run when the link is opened"
            />
            <div className="kshare-script-meta">
              {scriptBytes} B / {HARD_CAPS.maxScriptBytes} B
              {" · runs in the machine's default shell, visible in the terminal"}
            </div>
            {error && <div className="kshare-script-err">{error}</div>}
          </div>
```

- Give the URL row a machine-readable copy of the link:

```tsx
            <div className="kshare-url" data-share-url={url}>{renderUrl()}</div>
```

- In `renderUrl`, widen the scheme regex so localhost dev links still highlight: `/^(https?:\/\/)([^/]+)(\/[^#]*)(#.*)?$/`.
- Keep the tier bar and the `PrevRow` preview block; add one row so the script is represented truthfully:

```tsx
              <PrevRow
                k="script"
                v={script.trim() ? `${scriptBytes} B, runs at boot` : "none"}
              />
```

- Keep the Cancel/Open/Copy actions unchanged (they already operate on `url`).

- [ ] **Step 4: Add the Dock button**

In `Dock.tsx`, next to the existing `INTERNALS_ITEM`-style constants, add (match the neighboring constants' exact shape):

```tsx
const SHARE_ITEM = {
  label: "Share",
  title: "Share this machine as a link",
  icon: (
    <svg width="16" height="16" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="5.5" cy="11" r="2.4" />
      <circle cx="16" cy="5" r="2.4" />
      <circle cx="16" cy="17" r="2.4" />
      <path d="M7.6 10l6.4-3.6M7.6 12l6.4 3.6" />
    </svg>
  ),
};
```

Add to the Dock props interface:

```ts
  shareAvailable: boolean;
  onOpenShare: () => void;
```

and render the button first in the `kdock-section-actions` section (~line 488), before the internals button:

```tsx
                <button
                  type="button"
                  className="kdock-item"
                  title={SHARE_ITEM.title}
                  disabled={!shareAvailable}
                  onClick={onOpenShare}
                >
                  <span className="kdock-icon">{SHARE_ITEM.icon}</span>
                  <span className="kdock-label">{SHARE_ITEM.label}</span>
                </button>
```

(Destructure `shareAvailable` and `onOpenShare` alongside the component's existing props.)

- [ ] **Step 5: Wire App state**

In `App.tsx`:

```ts
import { ShareDialog } from "../dialogs/ShareDialog";
```

state next to `internalsOpen` (~line 70):

```ts
  const [shareOpen, setShareOpen] = React.useState(false);
```

Dock props (in the `<Dock` element, ~line 346):

```tsx
        shareAvailable={!isEmpty}
        onOpenShare={() => setShareOpen(true)}
```

and render before `<Dock`:

```tsx
      {shareOpen && <ShareDialog onClose={() => setShareOpen(false)} />}
```

- [ ] **Step 6: Style the textarea**

In `styles.css`, next to the existing `kshare-*` rules, add:

```css
.kshare-script textarea {
  width: 100%;
  resize: vertical;
  min-height: 84px;
  font-family: var(--k-font-mono);
  font-size: 12px;
  color: var(--k-text);
  background: color-mix(in oklch, var(--k-text) 5%, transparent);
  border: 1px solid color-mix(in oklch, var(--k-text) 16%, transparent);
  border-radius: 6px;
  padding: 8px;
  box-sizing: border-box;
}
.kshare-script-meta {
  margin-top: 4px;
  font-size: 11px;
  color: var(--k-text-muted);
}
.kshare-script-err {
  margin-top: 4px;
  font-size: 11px;
  color: var(--k-err);
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/browser-demos && npx playwright test test/kandelo-link-script.spec.ts
```

Expected: PASS (4 tests, including the new round-trip). Also re-run the dock-layout test, since Dock gained a button:

```bash
cd apps/browser-demos && npx playwright test test/kandelo-url.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/browser-demos/pages/kandelo/dialogs/ShareDialog.tsx \
        apps/browser-demos/pages/kandelo/app/Dock.tsx \
        apps/browser-demos/pages/kandelo/app/App.tsx \
        apps/browser-demos/pages/kandelo/styles.css \
        apps/browser-demos/test/kandelo-link-script.spec.ts
git commit -m "Browser: Wire ShareDialog into the dock with script authoring"
```

(Body: first UI mount of ShareDialog; working-URL shape rationale; removal of unroutable modes/encrypt/overlay toggles as truthful-failure cleanup. 72 columns; Claude co-author trailer.)

---

### Task 4: Document the supported behavior

**Files:**
- Modify: `docs/browser-support.md` (after the gallery-launch-URL section that ends ~line 583)

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1–3 (document nothing beyond it).
- Produces: the platform-promise documentation Task 5's final report points at.

- [ ] **Step 1: Add a "Script-carrying share links" subsection**

Insert after the launch-URL contract section (~line 583), matching the file's heading level and prose style:

```markdown
### Script-carrying share links

The Share button in the dock produces links of the form
`…/?demo=<id>#k1=<payload>`. The fragment is a versioned, gzip-compressed
boot descriptor (`web-libs/kandelo-session/src/boot-descriptor.ts`) that may
carry an optional `script` field: shell script text, capped at 32 KiB
(UTF-8), validated with the same hard caps and loud `BootDescriptorError`
failures as the rest of the descriptor. A malformed or oversized fragment
rejects the boot with a visible error; it never falls back to booting as if
the fragment were absent.

Opening a script link boots the machine selected by the query parameters
(the fragment cannot select an image the query parameters could not), writes
the script to `/tmp/kandelo-link.sh`, and runs it from the initial
interactive shell — `bash` when the image ships it, `sh` otherwise. The
invocation and the script's output are visible in the terminal, and the
script takes the image `autoCommand`'s place in the launch sequence.
Navigating to a different machine from the gallery drops the fragment.

Scripts currently run without a confirmation step because every machine the
browser app boots is ephemeral. This is a load-bearing boundary: before any
persistent or restored-machine feature ships, script links must gain an
explicit show-the-script consent step (see the warning at the execution
site in `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` and
`docs/superpowers/specs/2026-09-21-script-bearing-links-design.md`).
```

Wrap prose at the file's prevailing column width.

- [ ] **Step 2: Verify claims against the implementation**

Re-read the added prose and confirm each sentence matches shipped behavior (cap value, file path, interpreter fallback, gallery-drop, error surface). Fix any drift in the prose, not the code.

- [ ] **Step 3: Commit**

```bash
git add docs/browser-support.md
git commit -m "Docs: Document script-carrying Kandelo share links"
```

(72-column body; Claude co-author trailer.)

---

### Task 5: Manual browser verification and final report

**Files:** none — this task produces evidence.

**Interfaces:**
- Consumes: everything above.
- Produces: the validation evidence the final report's claims rest on.

- [ ] **Step 1: Run the full automated evidence set**

```bash
cd host && npx vitest run ../web-libs/kandelo-session/test/
cd ../apps/browser-demos && npx playwright test test/kandelo-link-script.spec.ts test/kandelo-url.spec.ts
```

Expected: all PASS. If anything fails, fix before proceeding — do not report around a red test.

- [ ] **Step 2: Manual `./run.sh browser` walkthrough**

Per the validation contract, user-visible browser behavior needs a manual check:

```bash
scripts/dev-shell.sh ./run.sh browser -- --port 5417 --strictPort
```

(Pick an unused port; 5401 collides across workspaces.) Then in a real browser:

1. Open `http://localhost:5417/?demo=shell`, click the dock's **Share** button, type `echo "manual-check:$((3 * 3))"` into the script box, and confirm the byte counter and the `#k1=` link update live.
2. Copy the link, open it in a new tab, and watch the terminal: the `bash /tmp/kandelo-link.sh` invocation and `manual-check:9` output must appear without any interaction.
3. Open a corrupted link (`…#k1=broken`) and confirm the visible "Rejected #k1= boot link fragment" error instead of a silent boot.
4. From a script link, open the gallery and launch another machine; confirm the new machine's URL has no fragment and runs no script.

Record what was observed for each item.

- [ ] **Step 3: Final report**

Report: what changed (by task/commit), which suites ran with their results, the manual walkthrough observations, and explicitly what was NOT run (e.g. no conformance suites — no kernel/syscall surface was touched; no performance claims — nothing was measured). Note the consent-before-persistence warning as a standing constraint for future work.

---

## Self-review notes

- Spec coverage: carrier + caps (Task 1), first fragment consumer + loud failure + query-rail image selection (Task 2), autoCommand-ladder execution + consent comment + `/tmp` + bash-else-sh (Task 2), gallery-fragment drop (Task 2), ShareDialog wiring + textarea + working URLs + hiding unroutable modes/encrypt/overlay (Task 3), tests incl. the followups-doc round-trip cases this change touches (Tasks 1–3), manual `./run.sh browser` (Task 5), docs (Task 4). Non-goals honored: no snapshot/overlay work, no descriptor v2, no consent UI.
- The spec's "hide unroutable modes" is implemented as removal of the mode picker/toggles from the rendered panel; the codec's `buildShareUrl`/`SHARE_MODE_INFO` stay untouched in `web-libs` for the emulator branch to reconcile.
- Type names used across tasks: `BootScript`, `script?: BootScript`, `maxScriptBytes`, `E_SCRIPT_INVALID`, `E_SCRIPT_TOO_LARGE`, `CreateLiveHostOptions.script`, `LINK_SCRIPT_PATH`, `runLinkScript`, `workingShareUrl`, `shareAvailable`, `onOpenShare`, `data-share-url` — consistent between producer and consumer tasks.
