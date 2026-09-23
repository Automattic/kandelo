# Image-Owned Machine Definitions, Plan 1: Schema And Tracked Sources

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `/etc/kandelo/demo.json` to carry a complete machine definition, and make every image's copy come from a tracked JSON file baked in byte-for-byte.

**Architecture:** `web-libs/kandelo-session/src/demo-config.ts` gains four validated blocks (`identity`, `runtime`, `init`, `web`) plus `display` and `defaultProfile`, following the existing `normalizeIngest` style — absolute structural ceilings in the schema, per-deployment clamping left to the app. Then all nine image builders stop constructing config programmatically and copy a tracked `*-demo.json` verbatim, generalizing the `main-shell-demo-config.ts` pattern. A check asserts baked bytes equal tracked bytes. The browser app is not touched and stays green throughout: it simply ignores fields it does not yet read.

**Tech Stack:** TypeScript, vitest (run from `host/`), tsx for image build scripts.

**Spec:** `docs/superpowers/specs/2026-09-22-image-owned-machine-definitions-design.md`

**Plan 1 of 3.** Plan 2 makes images self-sufficient (init config into `/etc/profile.d` and dinit services; sdl2/evdev/espeak/dinit binaries baked in — spec phases 2b and 3). Plan 3 is the app cutover, roster, test migration, and checker inversion (spec phases 4–7). Each produces working software on its own; this one ships images that describe themselves completely while the app continues to use its existing tables.

## Global Constraints

- Schema version stays `version: 1`. No shipped `demo.json` consumer exists outside this repo, and `parseKandeloDemoConfig` already returns `null` for any other version.
- `MAX_KANDELO_DEMO_CONFIG_BYTES` stays `256 * 1024`. Tracked sources must fit; `loadMainShellDemoConfig` already enforces this at build time.
- Unknown keys are **tolerated**, not rejected, at both top level and profile level — this is existing behavior and preserves forward compatibility when an older app reads a newer image. Known keys are validated strictly.
- Validation is eager across every profile, not just the selected one. `validateKandeloDemoConfig`'s existing doc comment states the reason: an image builder must not publish malformed metadata for a profile its smoke test happened not to select.
- Absolute ceilings live in the schema; per-deployment clamping is Plan 3. A schema ceiling rejects a hostile image; a clamp shapes a legitimate one.
- New validation errors follow the existing message shape: `` `${field} must be ...` `` with the full dotted path (`profiles.doom.runtime.requests.memoryPages`).
- Run vitest as `cd host && npx vitest run <path>`. `host/vitest.config.ts` includes `../web-libs/**/*.test.ts`.
- Commit subjects use `Area: Purpose` per `CLAUDE.md`. Use `Browser:` for `web-libs` schema work and `Images:` for builder work.

## Review Focus

These are input classes the spec implies but which no task's happy path exercises. Each has its test added to the task that owns the code.

1. **Absurd resource requests** — `memoryPages: 2147483647` from an untrusted image must be rejected by the schema, not carried forward to allocate. (Task 1)
2. **`defaultProfile` naming a profile that does not exist** — must fail loudly at build time, not silently boot an arbitrary profile. (Task 3)
3. **A typo'd known block** (`runtimee`, `intit`) — silently tolerated as an unknown key, so the machine boots with defaults and no diagnostic. The image builder check in Task 8 is the only thing that can catch this; it must warn on near-miss keys. (Task 8)
4. **`display` minimums larger than any real viewport** — a machine declaring `minWidth: 99999` must be rejected at schema level rather than wedging the UI. (Task 3)
5. **A profile declaring both `init` and a `presentation.autoCommand`** — two things claiming to be what the machine runs. Must be rejected as ambiguous at validation time. (Task 2)

---

### Task 1: `runtime` block

**Files:**
- Modify: `web-libs/kandelo-session/src/demo-config.ts`
- Test: `web-libs/kandelo-session/test/demo-config.test.ts` (create)

**Interfaces:**
- Consumes: existing `isRecord`, `requiredString`, `INGEST_MAX_BYTES_CEILING` style from the same file.
- Produces: `DemoRuntimeConfig`, `normalizeRuntime(value: unknown, field: string): DemoRuntimeConfig`, and the exported ceilings `MAX_REQUESTED_MEMORY_PAGES`, `MAX_REQUESTED_WORKERS`.

- [ ] **Step 1: Write the failing test**

Create `web-libs/kandelo-session/test/demo-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_REQUESTED_MEMORY_PAGES,
  MAX_REQUESTED_WORKERS,
  validateKandeloDemoConfig,
  type KandeloDemoConfig,
} from "../src/demo-config";

function withProfile(profile: Record<string, unknown>): KandeloDemoConfig {
  return { version: 1, profiles: { m: profile } } as unknown as KandeloDemoConfig;
}

describe("runtime block", () => {
  it("accepts a well-formed runtime block", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      runtime: {
        features: ["kms", "evdev-input"],
        network: true,
        requests: { memoryPages: 4096, maxWorkers: 12 },
      },
    }))).not.toThrow();
  });

  it("rejects an unknown feature", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      runtime: { features: ["teleport"] },
    }))).toThrow(/profiles\.m\.runtime\.features\[0\] must be one of/);
  });

  it("rejects duplicate features", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      runtime: { features: ["kms", "kms"] },
    }))).toThrow(/must not contain duplicate features/);
  });

  // Review Focus 1: an untrusted image must not get to ask for 128 GiB.
  it("rejects an absurd memoryPages request", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      runtime: { requests: { memoryPages: 2147483647 } },
    }))).toThrow(
      new RegExp(`memoryPages exceeds the ${MAX_REQUESTED_MEMORY_PAGES}-page ceiling`),
    );
  });

  it("rejects an absurd maxWorkers request", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      runtime: { requests: { maxWorkers: 100000 } },
    }))).toThrow(
      new RegExp(`maxWorkers exceeds the ${MAX_REQUESTED_WORKERS}-worker ceiling`),
    );
  });

  it("rejects a non-integer memoryPages request", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      runtime: { requests: { memoryPages: 4096.5 } },
    }))).toThrow(/memoryPages must be a positive integer/);
  });

  it("rejects a zero or negative request", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      runtime: { requests: { maxWorkers: 0 } },
    }))).toThrow(/maxWorkers must be a positive integer/);
  });

  it("rejects a non-boolean network flag", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      runtime: { network: "yes" },
    }))).toThrow(/profiles\.m\.runtime\.network must be a boolean/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: FAIL — `MAX_REQUESTED_MEMORY_PAGES` is not exported from `../src/demo-config`.

- [ ] **Step 3: Write minimal implementation**

In `web-libs/kandelo-session/src/demo-config.ts`, add near `DemoIngestConfig`:

```ts
/**
 * Declared runtime shape of a machine.
 *
 * `network` is DESCRIPTIVE ONLY. Nothing gates a socket syscall on it today:
 * across the repo `tcp-bridge` appears at its producer, a capability-badge
 * display list, and a type comment, and `caps.network` has no readers. It is
 * carried so the Config surface can show what a machine claims, and must not
 * be presented to users as a sandbox control until it actually gates the
 * guest socket path. See the spec's "Known-inert capability flag".
 */
export interface DemoRuntimeConfig {
  features: DemoRuntimeFeature[];
  network: boolean;
  requests: DemoResourceRequests;
}

export type DemoRuntimeFeature =
  | "framebuffer"
  | "kms"
  | "evdev-input"
  | "js-workers";

/**
 * What the image ASKS for. The host clamps each of these to its own policy
 * before use; these ceilings only reject values no legitimate image would
 * declare, so a hostile `?vfs=` image cannot request unbounded allocation.
 */
export interface DemoResourceRequests {
  memoryPages?: number;
  maxWorkers?: number;
}

/** 16384 pages = 1 GiB, matching the largest legitimate machine today
 *  (wordpress-mariadb). */
export const MAX_REQUESTED_MEMORY_PAGES = 16384;
/** Comfortably above wordpress-mariadb's 24 without permitting worker floods. */
export const MAX_REQUESTED_WORKERS = 64;

const RUNTIME_FEATURES = new Set<DemoRuntimeFeature>([
  "framebuffer",
  "kms",
  "evdev-input",
  "js-workers",
]);

function normalizeRuntime(value: unknown, field: string): DemoRuntimeConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }

  const features: DemoRuntimeFeature[] = [];
  if (value.features !== undefined) {
    if (!Array.isArray(value.features)) {
      throw new Error(`${field}.features must be an array`);
    }
    value.features.forEach((entry, index) => {
      if (
        typeof entry !== "string"
        || !RUNTIME_FEATURES.has(entry as DemoRuntimeFeature)
      ) {
        throw new Error(
          `${field}.features[${index}] must be one of: `
            + `${Array.from(RUNTIME_FEATURES).join(", ")}`,
        );
      }
      if (features.includes(entry as DemoRuntimeFeature)) {
        throw new Error(`${field}.features must not contain duplicate features`);
      }
      features.push(entry as DemoRuntimeFeature);
    });
  }

  let network = false;
  if (value.network !== undefined) {
    if (typeof value.network !== "boolean") {
      throw new Error(`${field}.network must be a boolean`);
    }
    network = value.network;
  }

  return {
    features,
    network,
    requests: normalizeResourceRequests(value.requests, `${field}.requests`),
  };
}

function normalizeResourceRequests(
  value: unknown,
  field: string,
): DemoResourceRequests {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const requests: DemoResourceRequests = {};
  if (value.memoryPages !== undefined) {
    requests.memoryPages = boundedCount(
      value.memoryPages,
      `${field}.memoryPages`,
      MAX_REQUESTED_MEMORY_PAGES,
      "page",
    );
  }
  if (value.maxWorkers !== undefined) {
    requests.maxWorkers = boundedCount(
      value.maxWorkers,
      `${field}.maxWorkers`,
      MAX_REQUESTED_WORKERS,
      "worker",
    );
  }
  return requests;
}

function boundedCount(
  value: unknown,
  field: string,
  ceiling: number,
  unit: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  if (value > ceiling) {
    throw new Error(`${field} exceeds the ${ceiling}-${unit} ceiling`);
  }
  return value;
}
```

Then wire it into `validateProfileFields`, immediately after the `presentation` branch:

```ts
  if (value.runtime !== undefined) {
    normalizeRuntime(value.runtime, `${field}.runtime`);
  }
```

And add `runtime?: DemoRuntimeConfig;` to both `KandeloDemoProfileConfig` and `KandeloDemoConfig`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add web-libs/kandelo-session/src/demo-config.ts web-libs/kandelo-session/test/demo-config.test.ts
git commit -m "Browser: Add a validated runtime block to image demo config

Images declare their feature set and resource requests. Requests carry
absolute ceilings so an untrusted ?vfs= image cannot ask the browser to
allocate unbounded memory or worker threads; per-deployment clamping
stays host policy.

network is carried as descriptive only and documented as such, because
nothing gates a socket syscall on it today."
```

---

### Task 2: `init` and `web` blocks

**Files:**
- Modify: `web-libs/kandelo-session/src/demo-config.ts`
- Test: `web-libs/kandelo-session/test/demo-config.test.ts`

**Interfaces:**
- Consumes: `normalizeRuntime` and `boundedCount` from Task 1.
- Produces: `DemoInitConfig { target: string }`, `DemoWebConfig { requiredPorts: number[]; probeHttp: boolean; probePath?: string }`, `normalizeInit`, `normalizeWeb`.

- [ ] **Step 1: Write the failing test**

Append to `web-libs/kandelo-session/test/demo-config.test.ts`:

```ts
describe("init and web blocks", () => {
  it("accepts a service machine", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      init: { target: "nginx" },
      web: { requiredPorts: [8080], probeHttp: true, probePath: "/wp-admin/" },
    }))).not.toThrow();
  });

  it("rejects an empty init target", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      init: { target: "" },
    }))).toThrow(/profiles\.m\.init\.target must be a non-empty string/);
  });

  it("rejects an init target that is not a bare service name", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      init: { target: "../../sbin/sh" },
    }))).toThrow(/profiles\.m\.init\.target must be a bare service name/);
  });

  // Review Focus 5: two things claiming to be what the machine runs.
  it("rejects a profile declaring both init and autoCommand", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      init: { target: "nginx" },
      presentation: {
        bootPrimary: "syslog",
        runningPrimary: ["web"],
        terminalAccess: "drawer",
        internalsAccess: "drawer",
        autoCommand: "/usr/local/bin/fbdoom",
      },
    }))).toThrow(
      /profiles\.m cannot declare both init\.target and presentation\.autoCommand/,
    );
  });

  it("rejects an out-of-range port", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      web: { requiredPorts: [70000] },
    }))).toThrow(/profiles\.m\.web\.requiredPorts\[0\] must be a TCP port/);
  });

  it("rejects an empty requiredPorts list", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      web: { requiredPorts: [] },
    }))).toThrow(/profiles\.m\.web\.requiredPorts must be a non-empty array/);
  });

  it("rejects a relative probePath", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      web: { requiredPorts: [8080], probePath: "wp-admin" },
    }))).toThrow(/profiles\.m\.web\.probePath must be absolute/);
  });

  it("defaults probeHttp to true", () => {
    const config = withProfile({ web: { requiredPorts: [8080] } });
    validateKandeloDemoConfig(config);
    expect(resolveDemoWeb(config, "m")).toEqual({
      requiredPorts: [8080],
      probeHttp: true,
    });
  });
});
```

Add `resolveDemoWeb` to the import list at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: FAIL — `resolveDemoWeb` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `web-libs/kandelo-session/src/demo-config.ts`:

```ts
/**
 * Which init target to bring up. A NAME, not a command vector: the machine's
 * real init configuration already lives in the image (dinit service files
 * under /etc/dinit.d, the login session), and this only selects among them.
 * A profile with no `init` block boots the image's default login session.
 */
export interface DemoInitConfig {
  target: string;
}

/**
 * Readiness signalling for the host's web pane. This is presentation, not
 * init configuration: it tells the UI when to flip from "starting" to
 * "ready". Ports are declared rather than derived because deriving them
 * would mean parsing nginx.conf.
 */
export interface DemoWebConfig {
  requiredPorts: number[];
  probeHttp: boolean;
  probePath?: string;
}

/** dinit service names, matching /etc/dinit.d/<name> filenames. */
const INIT_TARGET_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function normalizeInit(value: unknown, field: string): DemoInitConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const target = value.target;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(`${field}.target must be a non-empty string`);
  }
  if (!INIT_TARGET_RE.test(target)) {
    throw new Error(
      `${field}.target must be a bare service name matching /etc/dinit.d/<name>`,
    );
  }
  return { target };
}

function normalizeWeb(value: unknown, field: string): DemoWebConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  if (!Array.isArray(value.requiredPorts) || value.requiredPorts.length === 0) {
    throw new Error(`${field}.requiredPorts must be a non-empty array`);
  }
  const requiredPorts = value.requiredPorts.map((port, index) => {
    if (
      typeof port !== "number"
      || !Number.isInteger(port)
      || port < 1
      || port > 65535
    ) {
      throw new Error(`${field}.requiredPorts[${index}] must be a TCP port`);
    }
    return port;
  });
  if (new Set(requiredPorts).size !== requiredPorts.length) {
    throw new Error(`${field}.requiredPorts must not contain duplicate ports`);
  }

  let probeHttp = true;
  if (value.probeHttp !== undefined) {
    if (typeof value.probeHttp !== "boolean") {
      throw new Error(`${field}.probeHttp must be a boolean`);
    }
    probeHttp = value.probeHttp;
  }

  const web: DemoWebConfig = { requiredPorts, probeHttp };
  if (value.probePath !== undefined) {
    const probePath = requiredString(value.probePath, `${field}.probePath`);
    if (!probePath.startsWith("/")) {
      throw new Error(`${field}.probePath must be absolute`);
    }
    web.probePath = probePath;
  }
  return web;
}

export function resolveDemoWeb(
  config: KandeloDemoConfig,
  profileId: string,
): DemoWebConfig | null {
  const profile = profileConfig(config, profileId);
  if (isRecord(profile) && profile.web !== undefined) {
    return normalizeWeb(profile.web, `profiles.${profileId}.web`);
  }
  return config.web === undefined ? null : normalizeWeb(config.web, "web");
}
```

Extend `validateProfileFields` after the `runtime` branch:

```ts
  if (value.init !== undefined) {
    normalizeInit(value.init, `${field}.init`);
    const presentation = value.presentation;
    if (isRecord(presentation) && presentation.autoCommand !== undefined) {
      throw new Error(
        `${field} cannot declare both init.target and presentation.autoCommand`
          + " — only one thing can be what the machine runs",
      );
    }
  }
  if (value.web !== undefined) {
    normalizeWeb(value.web, `${field}.web`);
  }
```

Add `init?: DemoInitConfig;` and `web?: DemoWebConfig;` to `KandeloDemoProfileConfig` and `KandeloDemoConfig`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add web-libs/kandelo-session/src/demo-config.ts web-libs/kandelo-session/test/demo-config.test.ts
git commit -m "Browser: Let an image declare its init target and web readiness

init names a dinit target rather than restating an argv vector, because
the image already carries the real init configuration under
/etc/dinit.d. A profile declaring both init.target and an autoCommand is
rejected: only one thing can be what the machine runs."
```

---

### Task 3: `identity`, `display`, and `defaultProfile`

**Files:**
- Modify: `web-libs/kandelo-session/src/demo-config.ts`
- Test: `web-libs/kandelo-session/test/demo-config.test.ts`

**Interfaces:**
- Consumes: `boundedCount` (Task 1), `normalizeInit`/`normalizeWeb` (Task 2).
- Produces: `DemoIdentityConfig`, `DemoDisplayConfig`, `normalizeIdentity`, `normalizeDisplay`, `resolveDemoIdentity(config, profileId): DemoIdentityConfig | null`, `resolveDefaultProfileId(config): string | null`.

- [ ] **Step 1: Write the failing test**

Append to `web-libs/kandelo-session/test/demo-config.test.ts`:

```ts
describe("identity, display, and defaultProfile", () => {
  it("accepts a complete identity block", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      identity: {
        title: "fbDOOM",
        summary: "DOOM on /dev/fb0 with OSS audio through /dev/dsp.",
        accent: "#b5301c",
        glyph: "D",
        base: "kandelo:shell@abi44",
        packages: ["fbdoom@local", "doom-shareware@local"],
      },
    }))).not.toThrow();
  });

  it("rejects a non-hex accent", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      identity: { title: "T", summary: "S", accent: "red", glyph: "D" },
    }))).toThrow(/profiles\.m\.identity\.accent must be a #rrggbb colour/);
  });

  it("rejects an overlong glyph", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      identity: { title: "T", summary: "S", accent: "#b5301c", glyph: "DOOMY" },
    }))).toThrow(/profiles\.m\.identity\.glyph must be 1 to 4 characters/);
  });

  // Review Focus 4: a machine must not be able to wedge the UI.
  it("rejects display minimums beyond any real viewport", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      display: { minWidth: 99999, minHeight: 100 },
    }))).toThrow(/profiles\.m\.display\.minWidth exceeds the 7680-pixel ceiling/);
  });

  it("accepts sane display minimums", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      display: { minWidth: 640, minHeight: 480 },
    }))).not.toThrow();
  });

  // Review Focus 2: a dangling default must fail at build time.
  it("rejects a defaultProfile naming a profile that does not exist", () => {
    expect(() => validateKandeloDemoConfig({
      version: 1,
      defaultProfile: "ghost",
      profiles: { m: {} },
    } as unknown as KandeloDemoConfig)).toThrow(
      /defaultProfile "ghost" is not a declared profile/,
    );
  });

  it("resolves a declared defaultProfile", () => {
    const config = {
      version: 1,
      defaultProfile: "m",
      profiles: { m: {} },
    } as unknown as KandeloDemoConfig;
    validateKandeloDemoConfig(config);
    expect(resolveDefaultProfileId(config)).toBe("m");
  });

  it("resolves the sole profile when no default is declared", () => {
    const config = withProfile({});
    validateKandeloDemoConfig(config);
    expect(resolveDefaultProfileId(config)).toBe("m");
  });

  it("resolves null when multiple profiles exist with no declared default", () => {
    const config = {
      version: 1,
      profiles: { a: {}, b: {} },
    } as unknown as KandeloDemoConfig;
    validateKandeloDemoConfig(config);
    expect(resolveDefaultProfileId(config)).toBeNull();
  });
});
```

Add `resolveDefaultProfileId` to the import list.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: FAIL — `resolveDefaultProfileId` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `web-libs/kandelo-session/src/demo-config.ts`:

```ts
/** What the gallery and machine chrome show for this profile. */
export interface DemoIdentityConfig {
  title: string;
  summary: string;
  accent: string;
  glyph: string;
  base?: string;
  packages?: string[];
}

/**
 * A FLOOR the machine states, not a size it imposes. The viewport is the
 * browser window; these only tell the host the smallest surface the machine
 * expects to be usable at.
 */
export interface DemoDisplayConfig {
  minWidth: number;
  minHeight: number;
}

const ACCENT_RE = /^#[0-9a-f]{6}$/i;
/** 8K, well past any real browser viewport, so a bad value fails loudly. */
const MAX_DISPLAY_PIXELS = 7680;
const MAX_IDENTITY_TITLE_CHARS = 64;
const MAX_IDENTITY_SUMMARY_CHARS = 512;
const MAX_IDENTITY_PACKAGES = 64;

function normalizeIdentity(value: unknown, field: string): DemoIdentityConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const title = requiredString(value.title, `${field}.title`);
  if (title.length > MAX_IDENTITY_TITLE_CHARS) {
    throw new Error(
      `${field}.title must be at most ${MAX_IDENTITY_TITLE_CHARS} characters`,
    );
  }
  const summary = requiredString(value.summary, `${field}.summary`);
  if (summary.length > MAX_IDENTITY_SUMMARY_CHARS) {
    throw new Error(
      `${field}.summary must be at most ${MAX_IDENTITY_SUMMARY_CHARS} characters`,
    );
  }
  const accent = requiredString(value.accent, `${field}.accent`);
  if (!ACCENT_RE.test(accent)) {
    throw new Error(`${field}.accent must be a #rrggbb colour`);
  }
  const glyph = requiredString(value.glyph, `${field}.glyph`);
  if (glyph.length > 4) {
    throw new Error(`${field}.glyph must be 1 to 4 characters`);
  }

  const identity: DemoIdentityConfig = { title, summary, accent, glyph };
  if (value.base !== undefined) {
    identity.base = requiredString(value.base, `${field}.base`);
  }
  if (value.packages !== undefined) {
    if (!Array.isArray(value.packages)) {
      throw new Error(`${field}.packages must be an array`);
    }
    if (value.packages.length > MAX_IDENTITY_PACKAGES) {
      throw new Error(
        `${field}.packages must list at most ${MAX_IDENTITY_PACKAGES} entries`,
      );
    }
    identity.packages = value.packages.map((entry, index) =>
      requiredString(entry, `${field}.packages[${index}]`));
  }
  return identity;
}

function normalizeDisplay(value: unknown, field: string): DemoDisplayConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return {
    minWidth: boundedCount(
      value.minWidth,
      `${field}.minWidth`,
      MAX_DISPLAY_PIXELS,
      "pixel",
    ),
    minHeight: boundedCount(
      value.minHeight,
      `${field}.minHeight`,
      MAX_DISPLAY_PIXELS,
      "pixel",
    ),
  };
}

export function resolveDemoIdentity(
  config: KandeloDemoConfig,
  profileId: string,
): DemoIdentityConfig | null {
  const profile = profileConfig(config, profileId);
  if (isRecord(profile) && profile.identity !== undefined) {
    return normalizeIdentity(profile.identity, `profiles.${profileId}.identity`);
  }
  return config.identity === undefined
    ? null
    : normalizeIdentity(config.identity, "identity");
}

/**
 * The profile a bare `?vfs=` URL boots. An image with exactly one profile
 * needs no declaration; an image with several must say which, or the caller
 * has to choose explicitly rather than the app guessing.
 */
export function resolveDefaultProfileId(
  config: KandeloDemoConfig,
): string | null {
  if (typeof config.defaultProfile === "string") return config.defaultProfile;
  const ids = isRecord(config.profiles) ? Object.keys(config.profiles) : [];
  return ids.length === 1 ? ids[0] : null;
}
```

Extend `validateProfileFields` after the `web` branch:

```ts
  if (value.identity !== undefined) {
    normalizeIdentity(value.identity, `${field}.identity`);
  }
  if (value.display !== undefined) {
    normalizeDisplay(value.display, `${field}.display`);
  }
```

Add to `validateKandeloDemoConfig`, after the per-profile loop:

```ts
  if (config.defaultProfile !== undefined) {
    const declared = requiredString(config.defaultProfile, "defaultProfile");
    if (!Object.hasOwn(config.profiles ?? {}, declared)) {
      throw new Error(`defaultProfile "${declared}" is not a declared profile`);
    }
  }
```

Note: the existing `validateKandeloDemoConfig` returns early when
`config.profiles === undefined`. Move that early return so the
`defaultProfile` check still runs — a `defaultProfile` with no `profiles`
at all must fail rather than pass silently.

Add `identity?: DemoIdentityConfig;` and `display?: DemoDisplayConfig;` to `KandeloDemoProfileConfig` and `KandeloDemoConfig`, and `defaultProfile?: string;` to `KandeloDemoConfig`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: PASS, 25 tests.

- [ ] **Step 5: Commit**

```bash
git add web-libs/kandelo-session/src/demo-config.ts web-libs/kandelo-session/test/demo-config.test.ts
git commit -m "Browser: Let an image declare its listing identity and default profile

identity carries the title, summary, accent, and glyph that PRESET_LIBRARY
holds today. display declares a minimum surface only: the viewport is the
browser window, not something a machine gets to impose.

A defaultProfile naming a profile the image does not declare now fails at
validation rather than silently booting an arbitrary one."
```

---

### Task 4: Resolvers for runtime and init

**Files:**
- Modify: `web-libs/kandelo-session/src/demo-config.ts`
- Test: `web-libs/kandelo-session/test/demo-config.test.ts`

**Interfaces:**
- Consumes: `normalizeRuntime` (Task 1), `normalizeInit` (Task 2), `normalizeDisplay` (Task 3).
- Produces: `resolveDemoRuntime(config, profileId): DemoRuntimeConfig`, `resolveDemoInit(config, profileId): DemoInitConfig | null`, `resolveDemoDisplay(config, profileId): DemoDisplayConfig | null`. Plan 3's app cutover consumes exactly these three plus `resolveDemoWeb`, `resolveDemoIdentity`, and `resolveDefaultProfileId`.

- [ ] **Step 1: Write the failing test**

Append to `web-libs/kandelo-session/test/demo-config.test.ts`:

```ts
describe("resolvers", () => {
  const config = {
    version: 1,
    runtime: { features: ["js-workers"], network: true },
    profiles: {
      base: {},
      override: { runtime: { features: ["kms"] }, init: { target: "nginx" } },
    },
  } as unknown as KandeloDemoConfig;

  it("falls back to the top-level runtime block", () => {
    expect(resolveDemoRuntime(config, "base")).toEqual({
      features: ["js-workers"],
      network: true,
      requests: {},
    });
  });

  it("prefers the profile's runtime block", () => {
    expect(resolveDemoRuntime(config, "override")).toEqual({
      features: ["kms"],
      network: false,
      requests: {},
    });
  });

  it("returns an empty runtime for an image with no runtime block", () => {
    expect(resolveDemoRuntime(withProfile({}), "m")).toEqual({
      features: [],
      network: false,
      requests: {},
    });
  });

  it("resolves init only where declared", () => {
    expect(resolveDemoInit(config, "override")).toEqual({ target: "nginx" });
    expect(resolveDemoInit(config, "base")).toBeNull();
  });

  it("resolves null for an unknown profile id", () => {
    expect(resolveDemoInit(config, "nope")).toBeNull();
    expect(resolveDemoDisplay(config, "nope")).toBeNull();
  });
});
```

Add `resolveDemoRuntime`, `resolveDemoInit`, `resolveDemoDisplay` to the import list.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: FAIL — `resolveDemoRuntime` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `web-libs/kandelo-session/src/demo-config.ts`:

```ts
export function resolveDemoRuntime(
  config: KandeloDemoConfig,
  profileId: string,
): DemoRuntimeConfig {
  const profile = profileConfig(config, profileId);
  if (isRecord(profile) && profile.runtime !== undefined) {
    return normalizeRuntime(profile.runtime, `profiles.${profileId}.runtime`);
  }
  // A fresh object each call: `features` and `requests` are mutable and a
  // shared constant would let one caller's edit leak into every machine.
  return config.runtime === undefined
    ? { features: [], network: false, requests: {} }
    : normalizeRuntime(config.runtime, "runtime");
}

export function resolveDemoInit(
  config: KandeloDemoConfig,
  profileId: string,
): DemoInitConfig | null {
  const profile = profileConfig(config, profileId);
  if (isRecord(profile) && profile.init !== undefined) {
    return normalizeInit(profile.init, `profiles.${profileId}.init`);
  }
  return config.init === undefined ? null : normalizeInit(config.init, "init");
}

export function resolveDemoDisplay(
  config: KandeloDemoConfig,
  profileId: string,
): DemoDisplayConfig | null {
  const profile = profileConfig(config, profileId);
  if (isRecord(profile) && profile.display !== undefined) {
    return normalizeDisplay(profile.display, `profiles.${profileId}.display`);
  }
  return config.display === undefined
    ? null
    : normalizeDisplay(config.display, "display");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: PASS, 30 tests.

- [ ] **Step 5: Commit**

```bash
git add web-libs/kandelo-session/src/demo-config.ts web-libs/kandelo-session/test/demo-config.test.ts
git commit -m "Browser: Add resolvers for the new image demo-config blocks

Profile-level blocks override image-level ones, matching how assets,
guide, and ingest already resolve. These six resolvers are the whole
surface the app cutover consumes."
```

---

### Task 5: Generalize verbatim tracked-source loading

**Files:**
- Create: `images/vfs/scripts/tracked-demo-config.ts`
- Modify: `images/vfs/scripts/main-shell-demo-config.ts`
- Test: `web-libs/kandelo-session/test/demo-config.test.ts`

**Interfaces:**
- Consumes: `parseKandeloDemoConfig`, `validateKandeloDemoConfig`, `MAX_KANDELO_DEMO_CONFIG_BYTES`, `KANDELO_DEMO_CONFIG_PATH` from `demo-config.ts`.
- Produces: `loadTrackedDemoConfig(relPath: string, repoRoot?: string): { config: KandeloDemoConfig; source: Uint8Array }` and `writeTrackedDemoConfig(fs: MemoryFileSystem, relPath: string, repoRoot?: string): void`, both in `images/vfs/scripts/tracked-demo-config.ts`.

- [ ] **Step 1: Write the failing test**

Append to `web-libs/kandelo-session/test/demo-config.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../../../host/src/binary-resolver";

describe("tracked demo-config sources", () => {
  it("parses and validates the shell image's tracked source", () => {
    const path = join(
      findRepoRoot(),
      "packages/registry/shell/source-rootfs-shell-demo.json",
    );
    const source = readFileSync(path, "utf8");
    const config = parseKandeloDemoConfig(source);
    expect(config).not.toBeNull();
    expect(() => validateKandeloDemoConfig(config!)).not.toThrow();
  });

  it("keeps every tracked source under the byte cap", () => {
    const path = join(
      findRepoRoot(),
      "packages/registry/shell/source-rootfs-shell-demo.json",
    );
    expect(readFileSync(path).byteLength)
      .toBeLessThanOrEqual(MAX_KANDELO_DEMO_CONFIG_BYTES);
  });
});
```

Add `parseKandeloDemoConfig` and `MAX_KANDELO_DEMO_CONFIG_BYTES` to the import list.

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: PASS — the shell source already exists and is valid. This test is the regression guard for Task 6, which will add more sources; it fails later if any new tracked file is malformed.

- [ ] **Step 3: Write the shared loader**

Create `images/vfs/scripts/tracked-demo-config.ts`:

```ts
/**
 * Load a tracked demo-config source and bake it into an image VERBATIM.
 *
 * The tracked file IS the artifact: `/etc/kandelo/demo.json` inside the
 * image is a byte-for-byte copy, never a re-serialization. That is what lets
 * the gallery aggregate machine metadata from tracked sources without any
 * image having been built, and what lets a check assert the baked bytes match
 * the reviewed ones.
 *
 * Generalizes main-shell-demo-config.ts, which established this pattern for
 * the source-rootfs shell image.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  KANDELO_DEMO_CONFIG_PATH,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  validateKandeloDemoConfig,
  type KandeloDemoConfig,
} from "../../../web-libs/kandelo-session/src/demo-config";
import { ensureDirRecursive, writeVfsBinary } from "./vfs-image-helpers";

export interface LoadedTrackedDemoConfig {
  config: KandeloDemoConfig;
  source: Uint8Array;
}

export function loadTrackedDemoConfig(
  relPath: string,
  repoRoot = findRepoRoot(),
): LoadedTrackedDemoConfig {
  const source = new Uint8Array(readFileSync(join(repoRoot, relPath)));
  if (source.byteLength > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error(
      `${relPath} exceeds ${MAX_KANDELO_DEMO_CONFIG_BYTES} bytes`,
    );
  }
  const config = parseKandeloDemoConfig(
    new TextDecoder("utf-8", { fatal: true }).decode(source),
  );
  if (config === null) {
    throw new Error(`${relPath} has an unsupported version`);
  }
  validateKandeloDemoConfig(config);
  return { config, source };
}

export function writeTrackedDemoConfig(
  fs: MemoryFileSystem,
  relPath: string,
  repoRoot = findRepoRoot(),
): void {
  const { source } = loadTrackedDemoConfig(relPath, repoRoot);
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsBinary(fs, KANDELO_DEMO_CONFIG_PATH, source, 0o644);
}
```

Then reduce `images/vfs/scripts/main-shell-demo-config.ts` to a thin wrapper that delegates to these, keeping its exported `MAIN_SHELL_DEMO_CONFIG_SOURCE`, `loadMainShellDemoConfig`, and `writeMainShellDemoConfig` names so `build-source-rootfs-shell-image.ts` and `build-shell-vfs-image.ts` keep compiling unchanged:

```ts
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import {
  loadTrackedDemoConfig,
  writeTrackedDemoConfig,
  type LoadedTrackedDemoConfig,
} from "./tracked-demo-config";

export const MAIN_SHELL_DEMO_CONFIG_SOURCE =
  "packages/registry/shell/source-rootfs-shell-demo.json";

export function loadMainShellDemoConfig(
  repoRoot = findRepoRoot(),
): LoadedTrackedDemoConfig {
  return loadTrackedDemoConfig(MAIN_SHELL_DEMO_CONFIG_SOURCE, repoRoot);
}

export function writeMainShellDemoConfig(fs: MemoryFileSystem): void {
  writeTrackedDemoConfig(fs, MAIN_SHELL_DEMO_CONFIG_SOURCE);
}
```

- [ ] **Step 4: Verify the shell image still builds**

Run: `scripts/dev-shell.sh bash -c "npx tsc --noEmit -p images/vfs/tsconfig.json"` if that project file exists; otherwise `scripts/dev-shell.sh bash -c "npx tsx --tsconfig tsconfig.json -e \"import('./images/vfs/scripts/main-shell-demo-config.ts').then(m => m.loadMainShellDemoConfig())\""`.
Expected: no error, and the loaded config validates.

Then run the full schema suite:
Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: PASS, 32 tests.

- [ ] **Step 5: Commit**

```bash
git add images/vfs/scripts/tracked-demo-config.ts images/vfs/scripts/main-shell-demo-config.ts web-libs/kandelo-session/test/demo-config.test.ts
git commit -m "Images: Generalize verbatim tracked demo-config loading

The tracked JSON file is the artifact: /etc/kandelo/demo.json is a
byte-for-byte copy, never a re-serialization. That is what lets the
gallery aggregate machine metadata with no image built, and what lets a
check compare baked bytes against reviewed ones.

main-shell-demo-config keeps its exported names and delegates."
```

---

### Task 6: Convert the seven programmatic builders to tracked sources

**Files:**
- Create: `packages/registry/node/node-demo.json`, `packages/registry/nginx/nginx-demo.json`, `packages/registry/nginx/nginx-php-demo.json`, `packages/registry/wordpress/wordpress-demo.json`, `packages/registry/wordpress/lamp-demo.json`, `packages/registry/ruby/ruby-todo-demo.json`, `packages/registry/python-vfs/python-demo.json`
- Modify: `images/vfs/scripts/build-node-vfs-image.ts:111-119`, `build-nginx-vfs-image.ts:160-168`, `build-nginx-php-vfs-image.ts:457-465`, `build-wp-vfs-image.ts:432-438`, `build-lamp-vfs-image.ts:498-504`, `build-ruby-todo-vfs-image.ts:121-128`, `build-python-vfs-image.ts:123-133`
- Delete: `images/vfs/scripts/kandelo-demo-guides.ts`
- Test: `web-libs/kandelo-session/test/demo-config.test.ts`

**Interfaces:**
- Consumes: `writeTrackedDemoConfig` from Task 5.
- Produces: seven tracked source paths, enumerated in an exported `TRACKED_DEMO_CONFIG_SOURCES` array in `images/vfs/scripts/tracked-demo-config.ts` so Task 8's check and Plan 3's gallery aggregation have one list to read.

**Note on guide content:** each builder currently calls `nodeGuide()` / `nginxGuide()` / `nginxPhpGuide()` from `images/vfs/scripts/kandelo-demo-guides.ts`, a nine-line re-export of `web-libs/kandelo-session/src/demo-guides.ts`. Inline each function's returned object as literal JSON in the corresponding tracked file. Do **not** delete `web-libs/kandelo-session/src/demo-guides.ts` — the app still imports `builtinDemoGuide` from it until Plan 3. Only the `images/vfs/scripts/` re-export goes.

- [ ] **Step 1: Write the failing test**

Replace the two tests from Task 5 with a table-driven version covering every tracked source:

```ts
import { TRACKED_DEMO_CONFIG_SOURCES } from "../../../images/vfs/scripts/tracked-demo-config";

describe("tracked demo-config sources", () => {
  it("declares every tracked source", () => {
    // 9 = seven converted builders plus the shell image's base config and
    // its profile overlay, which are two separate tracked files.
    expect(TRACKED_DEMO_CONFIG_SOURCES.length).toBe(9);
  });

  it.each(TRACKED_DEMO_CONFIG_SOURCES)("%s parses and validates", (relPath) => {
    const source = readFileSync(join(findRepoRoot(), relPath), "utf8");
    const config = parseKandeloDemoConfig(source);
    expect(config).not.toBeNull();
    expect(() => validateKandeloDemoConfig(config!)).not.toThrow();
  });

  it.each(TRACKED_DEMO_CONFIG_SOURCES)("%s stays under the byte cap", (relPath) => {
    expect(readFileSync(join(findRepoRoot(), relPath)).byteLength)
      .toBeLessThanOrEqual(MAX_KANDELO_DEMO_CONFIG_BYTES);
  });

  it.each(TRACKED_DEMO_CONFIG_SOURCES)("%s declares a resolvable default", (relPath) => {
    const config = parseKandeloDemoConfig(
      readFileSync(join(findRepoRoot(), relPath), "utf8"),
    )!;
    expect(resolveDefaultProfileId(config)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: FAIL — `TRACKED_DEMO_CONFIG_SOURCES` is not exported.

- [ ] **Step 3: Write the tracked sources and rewire the builders**

Add to `images/vfs/scripts/tracked-demo-config.ts`:

```ts
/**
 * Every tracked demo-config source, one per image that ships machine
 * metadata. The gallery aggregates these without building any image, and the
 * baked-equals-tracked check walks this list.
 */
export const TRACKED_DEMO_CONFIG_SOURCES = [
  "packages/registry/shell/source-rootfs-shell-demo.json",
  "packages/registry/shell/source-rootfs-shell-demo-profiles.json",
  "packages/registry/node/node-demo.json",
  "packages/registry/nginx/nginx-demo.json",
  "packages/registry/nginx/nginx-php-demo.json",
  "packages/registry/wordpress/wordpress-demo.json",
  "packages/registry/wordpress/lamp-demo.json",
  "packages/registry/ruby/ruby-todo-demo.json",
  "packages/registry/python-vfs/python-demo.json",
] as const;
```

**Generate the guide content; do not hand-transcribe it.** The `*Guide()`
functions compose helpers — `scriptGuide()` at `demo-guides.ts:258` and
`companionHtml()` at `:274`, which builds a multi-line HTML document string.
Retyping those into JSON by hand would silently corrupt them. Instead write a
throwaway generator, run it once, then delete it:

```ts
// images/vfs/scripts/emit-tracked-demo-config.ts — DELETE after running once.
import { writeFileSync } from "node:fs";
import {
  terminalPresentation,
  webPresentation,
} from "./kandelo-demo-config";
import {
  nginxGuide,
  nginxPhpGuide,
  nodeGuide,
} from "../../../web-libs/kandelo-session/src/demo-guides";

const emit = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

emit("packages/registry/node/node-demo.json", {
  version: 1,
  defaultProfile: "node",
  profiles: {
    node: {
      identity: {
        title: "Node.js",
        summary:
          "SpiderMonkey-backed Node.js compatibility runtime with npm staged as /usr/bin/node.",
        accent: "#43853d",
        glyph: "js",
      },
      runtime: {
        features: ["js-workers"],
        network: true,
        requests: { memoryPages: 4096 },
      },
      presentation: terminalPresentation(),
      guide: nodeGuide(),
    },
  },
});
// ... one emit() call per tracked file, same shape.
```

Run it with `npx tsx images/vfs/scripts/emit-tracked-demo-config.ts` from the
repo root, inspect the output, then `git rm` the generator. The `identity`
and `runtime` literals are the only hand-entered values, and Task 7 pins
those against `PRESET_LIBRARY`.

Each emitted file looks like this — `node-demo.json`, abbreviated with its
generated `guide` elided:

```json
{
  "version": 1,
  "defaultProfile": "node",
  "profiles": {
    "node": {
      "identity": {
        "title": "Node.js",
        "summary": "SpiderMonkey-backed Node.js compatibility runtime with npm staged as /usr/bin/node.",
        "accent": "#43853d",
        "glyph": "js"
      },
      "runtime": {
        "features": ["js-workers"],
        "network": true,
        "requests": { "memoryPages": 4096 }
      },
      "presentation": {
        "bootPrimary": "syslog",
        "runningPrimary": ["terminal", "syslog"],
        "terminalAccess": "primary",
        "internalsAccess": "drawer"
      }
    }
  }
}
```

Write the remaining six the same way, taking `identity` from `PRESET_LIBRARY` (`apps/browser-demos/pages/kandelo/presets.ts`), `runtime`/`init`/`web` from `LIVE_DEMO_SPECS` (`live-setup.ts:361-497`), `presentation` from the helper the builder currently calls, and `guide` from the current `*Guide()` function where the builder passes one. Specifically:

| Tracked file | Profiles | init.target | web.requiredPorts | requests |
|---|---|---|---|---|
| `nginx-demo.json` | `nginx` | `nginx` | `[8080]` | `maxWorkers: 6` |
| `nginx-php-demo.json` | `nginx-php` | `nginx` | `[8080]` | `maxWorkers: 12` |
| `wordpress-demo.json` | `wordpress-sqlite`, `wordpress` | `nginx` | `[8080]` | `memoryPages: 4096, maxWorkers: 12` |
| `lamp-demo.json` | `wordpress-mariadb`, `lamp` | `nginx` | `[8080, 9000]` | `memoryPages: 16384, maxWorkers: 24` |
| `ruby-todo-demo.json` | `ruby-todo` | *(omit — boots Ruby directly, see below)* | `[8080]` | `memoryPages: 4096, maxWorkers: 12` |
| `python-demo.json` | `python` | *(omit)* | *(omit)* | *(omit)* |

`lamp-demo.json` also sets `"probeHttp": true` and `"probePath"` to the value
of `WORDPRESS_MARIADB_READY_PATH`. Resolve it with
`grep -rn "WORDPRESS_MARIADB_READY_PATH\s*=" --include='*.ts' .` and emit it
through the generator (`probePath: WORDPRESS_MARIADB_READY_PATH`) rather than
retyping the string.

`kandelo-demo-config.ts` currently exports `terminalPresentation()`,
`webPresentation()`, and `framebufferPresentation()`; the generator imports
them so emitted presentation blocks match today's bytes exactly.

`ruby-todo` boots `/usr/bin/ruby /var/lib/todo/server.rb` directly as pid 1 — `build-ruby-todo-vfs-image.ts:113` states this is deliberate, not drift. It has no dinit target, so omit `init` and express the command as `presentation.autoCommand`. Plan 2 decides whether it grows a dinit target; do not change its boot shape here.

`python` is not on the gallery roster. Give it an `identity` anyway so it is complete, using title `"Python"`, glyph `"py"`, accent `"#3776ab"`, and a summary describing the version probe its `autoCommand` runs.

Then in each of the seven builders, replace the `writeKandeloDemoConfig(fs, {...})` call with a single line, e.g. in `build-node-vfs-image.ts`:

```ts
  writeTrackedDemoConfig(fs, "packages/registry/node/node-demo.json");
```

and change its import from `./kandelo-demo-config` to `./tracked-demo-config`, dropping the now-unused `terminalPresentation` / `nodeGuide` imports. Delete `images/vfs/scripts/kandelo-demo-guides.ts`.

Deal with `images/vfs/scripts/kandelo-demo-config.ts` **after** deleting the generator, since the generator imports its presentation helpers. Once the generator is gone, run `grep -rn "kandelo-demo-config" images/ scripts/ --include='*.ts'`; delete the module only if the result is empty, and leave it if a non-gallery builder still imports it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/demo-config.test.ts`
Expected: PASS. Then confirm nothing still imports the deleted module:
Run: `grep -rn "kandelo-demo-guides" --include='*.ts' . | grep -v node_modules`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add packages/registry/*/*-demo.json images/vfs/scripts/ web-libs/kandelo-session/test/demo-config.test.ts
git commit -m "Images: Move every image's demo config into a tracked source file

All nine images now bake a reviewed JSON file verbatim instead of
constructing metadata in TypeScript at build time. Each tracked file
carries the identity, runtime, init target, and readiness data that
PRESET_LIBRARY and LIVE_DEMO_SPECS hold in the browser app today.

Retires images/vfs/scripts/kandelo-demo-guides.ts, the re-export that
made one module serve as both build-time image content and runtime app
fallback."
```

---

### Task 7: Assert tracked identity data matches the app's tables

**Files:**
- Create: `web-libs/kandelo-session/test/tracked-demo-parity.test.ts`

**Interfaces:**
- Consumes: `TRACKED_DEMO_CONFIG_SOURCES` (Task 6), `resolveDemoIdentity`/`resolveDemoRuntime` (Tasks 3–4), `PRESET_LIBRARY` from `apps/browser-demos/pages/kandelo/presets.ts`.
- Produces: nothing consumed later. This is a temporary bridge test, deleted in Plan 3 when `PRESET_LIBRARY` is deleted.

This task exists because Plan 1 ships tracked data the app does not yet read. Without it, a transcription error in Task 6 stays invisible until Plan 3's cutover changes behavior, and the bug would look like a cutover regression rather than a data-entry mistake.

- [ ] **Step 1: Write the failing test**

Create `web-libs/kandelo-session/test/tracked-demo-parity.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import {
  parseKandeloDemoConfig,
  resolveDemoIdentity,
} from "../src/demo-config";
import { TRACKED_DEMO_CONFIG_SOURCES } from "../../../images/vfs/scripts/tracked-demo-config";
import { PRESET_LIBRARY } from "../../../apps/browser-demos/pages/kandelo/presets";

/**
 * TEMPORARY. Plan 1 ships image-owned identity data the app does not read
 * yet, so a transcription slip would otherwise surface as a regression during
 * the Plan 3 cutover. Delete this file in Plan 3 together with PRESET_LIBRARY.
 */
function identityFromTrackedSources(): Map<string, { title: string; summary: string; accent: string; glyph: string }> {
  const out = new Map<string, { title: string; summary: string; accent: string; glyph: string }>();
  for (const relPath of TRACKED_DEMO_CONFIG_SOURCES) {
    const config = parseKandeloDemoConfig(
      readFileSync(join(findRepoRoot(), relPath), "utf8"),
    );
    if (!config?.profiles) continue;
    for (const profileId of Object.keys(config.profiles)) {
      const identity = resolveDemoIdentity(config, profileId);
      if (identity) {
        out.set(profileId, {
          title: identity.title,
          summary: identity.summary,
          accent: identity.accent,
          glyph: identity.glyph,
        });
      }
    }
  }
  return out;
}

describe("tracked identity matches the app's preset table", () => {
  const tracked = identityFromTrackedSources();

  it.each(PRESET_LIBRARY.map((p) => [p.id, p] as const))(
    "%s identity round-trips",
    (id, preset) => {
      const entry = tracked.get(id);
      expect(entry, `no tracked identity for profile ${id}`).toBeDefined();
      expect(entry).toEqual({
        title: preset.title,
        summary: preset.summary,
        accent: preset.accent.toLowerCase(),
        glyph: preset.glyph,
      });
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/tracked-demo-parity.test.ts`
Expected: FAIL for any profile whose tracked identity was mistyped in Task 6, naming the profile.

- [ ] **Step 3: Fix the tracked sources**

Correct each mismatch in the tracked JSON, not in `presets.ts`. `PRESET_LIBRARY` is the current shipped behavior and is the reference until Plan 3 deletes it.

Expect `doom`, `modeset`, `sdl2`, `evdev`, `espeak`, and `shell` to fail with "no tracked identity" until their entries are added to `packages/registry/shell/source-rootfs-shell-demo.json` and `source-rootfs-shell-demo-profiles.json`. Add them, taking values from `PRESET_LIBRARY`. Note `build-source-rootfs-shell-image.ts:179-208` enforces that the overlay's profile ids exactly match the base's expected list and that overlapping profiles do not drift — read that check before editing either file, and update `expectedProfileIds` if you add profiles.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run ../web-libs/kandelo-session/test/`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add web-libs/kandelo-session/test/tracked-demo-parity.test.ts packages/registry/shell/
git commit -m "Images: Pin tracked image identity against the app's preset table

Plan 1 ships identity data the browser app does not read until the
cutover, so a transcription slip would otherwise look like a cutover
regression. This bridge test fails loudly at the point the data is
written instead. It is deleted with PRESET_LIBRARY in plan 3."
```

---

### Task 8: Baked-equals-tracked check

**Files:**
- Create: `scripts/check-image-demo-config.mjs`
- Modify: `run.sh` (add to the same place other contract checks are invoked)
- Test: `scripts/check-image-demo-config.test.mjs`

**Interfaces:**
- Consumes: `TRACKED_DEMO_CONFIG_SOURCES` (Task 6). Read it by parsing the TypeScript source with a regex rather than importing, matching how `check-pages-vfs-product-registry.mjs` reads app sources — the checker is a plain `.mjs` with no build step.
- Produces: a CLI that exits non-zero with a named reason.

- [ ] **Step 1: Write the failing test**

Create `scripts/check-image-demo-config.test.mjs`:

```js
import { describe, expect, it } from "vitest";
import { checkTrackedDemoConfigs, nearMissKeys } from "./check-image-demo-config.mjs";

describe("tracked demo-config checker", () => {
  it("accepts the repository's tracked sources", () => {
    expect(() => checkTrackedDemoConfigs()).not.toThrow();
  });

  // Review Focus 3: a typo'd block is tolerated as an unknown key, so the
  // machine would boot with defaults and no diagnostic. This is the only
  // place that can catch it.
  it("flags a near-miss key", () => {
    expect(nearMissKeys({ runtimee: {}, init: {} }))
      .toEqual([{ found: "runtimee", meant: "runtime" }]);
  });

  it("allows a genuinely unknown key", () => {
    expect(nearMissKeys({ futureThing: {} })).toEqual([]);
  });

  it("is case-insensitive about near misses", () => {
    expect(nearMissKeys({ Runtime: {} }))
      .toEqual([{ found: "Runtime", meant: "runtime" }]);
  });
});
```

Add `"scripts/**/*.test.mjs"` to the `test.include` array in `host/vitest.config.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && npx vitest run ../scripts/check-image-demo-config.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the checker**

Create `scripts/check-image-demo-config.mjs`:

```js
#!/usr/bin/env node
/**
 * Assert that every tracked demo-config source is valid, and that any image
 * already built from one carries those exact bytes at /etc/kandelo/demo.json.
 *
 * The tracked file is the authority; the baked copy is a verbatim artifact.
 * Images that have not been built are skipped, not failed: this repository
 * builds artifacts on demand and a fresh worktree has none.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const KNOWN_PROFILE_KEYS = [
  "presentation", "assets", "guide", "ingest",
  "identity", "runtime", "init", "web", "display",
];

/** Levenshtein distance, capped at 2 — enough to catch a typo, not a rename. */
function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

export function nearMissKeys(profile) {
  const out = [];
  for (const found of Object.keys(profile)) {
    if (KNOWN_PROFILE_KEYS.includes(found)) continue;
    for (const meant of KNOWN_PROFILE_KEYS) {
      const d = editDistance(found.toLowerCase(), meant);
      if (d > 0 && d <= 2) {
        out.push({ found, meant });
        break;
      }
    }
  }
  return out;
}

function trackedSourcePaths() {
  const source = readFileSync(
    join(repoRoot, "images/vfs/scripts/tracked-demo-config.ts"),
    "utf8",
  );
  const block = /TRACKED_DEMO_CONFIG_SOURCES\s*=\s*\[([\s\S]*?)\]/.exec(source);
  if (!block) {
    throw new Error("TRACKED_DEMO_CONFIG_SOURCES not found in tracked-demo-config.ts");
  }
  const paths = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (paths.length === 0) throw new Error("TRACKED_DEMO_CONFIG_SOURCES is empty");
  return paths;
}

export function checkTrackedDemoConfigs() {
  for (const relPath of trackedSourcePaths()) {
    const abs = join(repoRoot, relPath);
    if (!existsSync(abs)) {
      throw new Error(`tracked demo config is missing: ${relPath}`);
    }
    const text = readFileSync(abs, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${relPath} is not valid JSON: ${err.message}`);
    }
    if (parsed.version !== 1) {
      throw new Error(`${relPath} must declare version 1`);
    }
    for (const [profileId, profile] of Object.entries(parsed.profiles ?? {})) {
      for (const { found, meant } of nearMissKeys(profile)) {
        throw new Error(
          `${relPath} profiles.${profileId} has key "${found}" — did you mean `
            + `"${meant}"? Unknown keys are tolerated for forward compatibility, `
            + `so a typo here would silently boot a default machine.`,
        );
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkTrackedDemoConfigs();
  console.log("tracked demo configs OK");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && npx vitest run ../scripts/check-image-demo-config.test.mjs`
Expected: PASS, 4 tests.

Then run the checker directly:
Run: `node scripts/check-image-demo-config.mjs`
Expected: `tracked demo configs OK`, exit 0.

- [ ] **Step 5: Wire it into the repo's check path and commit**

Find where `scripts/check-pages-vfs-product-registry.mjs` is invoked (`grep -n "check-pages-vfs-product-registry" run.sh .github/workflows/*.yml`) and add `node scripts/check-image-demo-config.mjs` alongside it, in the same conditional block and with the same failure handling.

```bash
git add scripts/check-image-demo-config.mjs scripts/check-image-demo-config.test.mjs host/vitest.config.ts run.sh
git commit -m "Images: Check tracked demo configs and catch near-miss keys

Unknown keys stay tolerated so an older app can read a newer image, which
means a typo'd block name would otherwise boot a default machine with no
diagnostic. This check is the only thing positioned to catch that, so it
rejects keys within edit distance 2 of a known one."
```

---

## Done when

- `cd host && npx vitest run ../web-libs/kandelo-session/test/ ../scripts/` is green.
- `node scripts/check-image-demo-config.mjs` exits 0.
- `grep -rn "kandelo-demo-guides" --include='*.ts' . | grep -v node_modules` is empty.
- Every image builder writes `/etc/kandelo/demo.json` by copying a tracked file; no builder constructs config objects in TypeScript.
- The browser app is unmodified and `./run.sh browser` behaves exactly as before — Plan 1 ships data, not behavior.

## Known gap: baked-equals-tracked is not checked

Task 8's checker validates every tracked demo-config source. It does NOT
open a built image and compare the baked `/etc/kandelo/demo.json` bytes
against the tracked source, and its docblock now says so plainly.

Why it did not land here:

- The checker is a plain `.mjs` that `run.sh` invokes with bare `node`.
  Reading a file out of a `.vfs.zst` needs `MemoryFileSystem.fromImage`
  from `host/src/vfs`, which is TypeScript and cannot be imported from an
  unbundled `.mjs`. Re-deriving the image's shared-buffer layout in the
  checker would be a second, silently divergent copy of a platform format.
- There is no machine-readable tracked-source-to-image mapping. It exists
  only as the argument to each `writeTrackedDemoConfig(...)` call site.
- Plan 1 builds no images, so the check would have nothing to compare in
  this plan's own validation anyway.

Moved to **Plan 2**, where images are built. When it is implemented it must
apply to single-source images only and must not report success for the
source-rootfs shell image, whose `demo.json` is a deterministic merge of two
tracked files. The spec's "Byte-identity, and the one exception" records
that boundary.

## Not in this plan

- Moving shell/service environments into `/etc/profile.d` and dinit service files, and baking sdl2, evdev, espeak, and dinit binaries into images. That is Plan 2, and until it lands the tracked `init.target` values describe a target the app does not yet use.
- Giving `ruby-todo` its working directory back. `live-setup.ts:436-446` boots it as pid 1 with `cwd: "/var/lib/todo"`; the tracked `ruby-todo-demo.json` demotes that to a shell `autoCommand` with no `cwd`, because this plan's `init` block is a dinit service NAME and Ruby has no service file yet. Plan 2 owns init configuration (`/etc/profile.d`, dinit services) and must give `cwd` a home — either a dinit service for the Roda server or a documented place for a working directory in the schema. Until then `ruby-todo` would start in `/` after a cutover.
- Moving `TRACKED_DEMO_CONFIG_SOURCES` out of `images/vfs/scripts/tracked-demo-config.ts`. That module imports `node:fs`, so Plan 3's browser-side gallery cannot bundle it. Real, but Plan 3 is what introduces a browser consumer, so Plan 3 owns splitting the path list away from the Node-only loader.
- Deleting `LIVE_DEMO_SPECS`, `PRESET_LIBRARY`, `VFS_SOURCES`, `builtinDemo*`, `Config.tsx`, or `?demo=`; the roster; the availability model; the Playwright migration; the checker inversion. All Plan 3.
- Making `caps.network` enforcing. Named as a follow-up in the spec, deliberately not this work.
