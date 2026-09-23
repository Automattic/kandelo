import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../../../host/src/binary-resolver";
import { TRACKED_DEMO_CONFIG_SOURCES } from "../../../images/vfs/scripts/tracked-demo-config";
import {
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  MAX_REQUESTED_MEMORY_PAGES,
  MAX_REQUESTED_WORKERS,
  parseKandeloDemoConfig,
  validateKandeloDemoConfig,
  resolveDemoWeb,
  resolveDemoIdentity,
  resolveDefaultProfileId,
  resolveDemoRuntime,
  resolveDemoInit,
  resolveDemoDisplay,
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
        requests: { memoryPages: 4096, maxWorkers: 12 },
      },
    }))).not.toThrow();
  });

  it("rejects an unknown feature", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      runtime: { features: ["teleport"] },
    }))).toThrow(/profiles\.m\.runtime\.features\[0\] must be one of/);
  });

  // Deleted with its last consumer: it had no reader anywhere and only ever
  // rendered as a capability badge in a pane that no longer exists.
  it("rejects the removed js-workers feature", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      runtime: { features: ["js-workers"] },
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

  // `network` was descriptive only — it gated no socket syscall — and a
  // field that READS like a sandbox control is a trap once third-party
  // images declare it. An image declaring it now gets the normalized block
  // without it, rather than a promise nothing keeps.
  it("carries no network flag through normalization", () => {
    const config = withProfile({ runtime: { network: true } });
    validateKandeloDemoConfig(config);
    expect(resolveDemoRuntime(config, "m")).toEqual({
      features: [],
      requests: {},
    });
  });
});

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

  // A machine can boot a program from the image directly as pid 1 instead
  // of naming a dinit target — e.g. ruby-todo, which deliberately ships no
  // dinit tree at all (see images/vfs/products/browser-ruby-todo.toml).
  it("accepts a direct-program init with no dinit tree", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      init: {
        program: "/usr/bin/ruby",
        args: ["/var/lib/todo/server.rb"],
        cwd: "/var/lib/todo",
        uid: 1000,
        gid: 1000,
      },
      web: { requiredPorts: [8080] },
    }))).not.toThrow();
  });

  it("resolves a direct-program init, defaulting args to an empty array", () => {
    expect(resolveDemoInit(withProfile({
      init: { program: "/usr/bin/ruby", uid: 1000, gid: 1000 },
    }), "m")).toEqual({
      program: "/usr/bin/ruby",
      args: [],
      uid: 1000,
      gid: 1000,
    });
  });

  // A default of 0 would hand root to any third-party image that picks this
  // shape, and a default of 1000 would invent an account convention the
  // image may not share. The privilege pid 1 runs with is stated, or the
  // file is rejected.
  it.each(["uid", "gid"])("requires init.%s on a direct-program init", (field) => {
    const init: Record<string, unknown> = {
      program: "/usr/bin/ruby",
      uid: 1000,
      gid: 1000,
    };
    delete init[field];
    expect(() => validateKandeloDemoConfig(withProfile({ init }))).toThrow(
      new RegExp(`profiles\\.m\\.init\\.${field} must be a non-negative integer`),
    );
  });

  it.each([-1, 1.5, "1000", null])(
    "rejects a non-integer init uid: %s",
    (uid: unknown) => {
      expect(() => validateKandeloDemoConfig(withProfile({
        init: { program: "/usr/bin/ruby", uid, gid: 1000 },
      }))).toThrow(/profiles\.m\.init\.uid must be a non-negative integer/);
    },
  );

  it("accepts uid 0 when the image says so explicitly", () => {
    expect(resolveDemoInit(withProfile({
      init: { program: "/sbin/myinit", uid: 0, gid: 0 },
    }), "m")).toEqual({ program: "/sbin/myinit", args: [], uid: 0, gid: 0 });
  });

  it("rejects a non-absolute init program", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      init: { program: "usr/bin/ruby", uid: 0, gid: 0 },
    }))).toThrow(/profiles\.m\.init\.program must be absolute/);
  });

  it("rejects a traversal in an init program path", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      init: { program: "/usr/bin/../../etc/passwd", uid: 0, gid: 0 },
    }))).toThrow(/profiles\.m\.init\.program must be a normalized file path/);
  });

  it("rejects a non-absolute init cwd", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      init: { program: "/usr/bin/ruby", cwd: "var/lib/todo", uid: 0, gid: 0 },
    }))).toThrow(/profiles\.m\.init\.cwd must be absolute/);
  });

  // The third "what runs" shape: a command for the machine's login shell,
  // which used to live one block away as presentation.autoCommand.
  it("accepts a shell-command init", () => {
    expect(resolveDemoInit(withProfile({
      init: { shellCommand: "/usr/local/bin/fbdoom -iwad /doom1.wad" },
    }), "m")).toEqual({
      shellCommand: "/usr/local/bin/fbdoom -iwad /doom1.wad",
    });
  });

  it("rejects an empty shell command", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      init: { shellCommand: "" },
    }))).toThrow(/profiles\.m\.init\.shellCommand must be a non-empty string/);
  });

  it("rejects an unbounded shell command", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      init: { shellCommand: "x".repeat(4097) },
    }))).toThrow(
      /profiles\.m\.init\.shellCommand must be at most 4096 characters/,
    );
  });

  // Exclusivity is now STRUCTURAL: all three "what runs" shapes are arms of
  // one union, so no cross-block rule is needed to keep them apart.
  it.each([
    [{ target: "nginx", program: "/usr/bin/ruby" }, /target and program/],
    [
      { target: "nginx", shellCommand: "echo hi" },
      /target and shellCommand/,
    ],
    [
      { program: "/usr/bin/ruby", shellCommand: "echo hi" },
      /program and shellCommand/,
    ],
  ])("rejects an init declaring two shapes: %j", (init, message) => {
    expect(() => validateKandeloDemoConfig(withProfile({ init })))
      .toThrow(message as RegExp);
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

  // Review finding: previewUrlForPath resolves probePath against the page
  // origin, and "//evil.example" is a protocol-relative URL, not a path.
  it("rejects a protocol-relative probePath", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      web: { requiredPorts: [8080], probePath: "//evil.example/x" },
    }))).toThrow(/must not start with "\/\/"/);
  });

  it.each([
    "/ready?x=1",
    "/ready#frag",
    "/ready\\x",
    "/ready\0x",
  ])("rejects a probePath containing a URL metacharacter: %j", (probePath: string) => {
    expect(() => validateKandeloDemoConfig(withProfile({
      web: { requiredPorts: [8080], probePath },
    }))).toThrow(/must be a plain path/);
  });

  it("rejects an over-long probePath", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      web: { requiredPorts: [8080], probePath: `/${"a".repeat(512)}` },
    }))).toThrow(/probePath must be at most 512 characters/);
  });

  it("rejects an unbounded requiredPorts list", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      web: { requiredPorts: Array.from({ length: 65 }, (_, i) => i + 1) },
    }))).toThrow(/requiredPorts must list at most 64 ports/);
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

describe("identity, display, and defaultProfile", () => {
  it("accepts a complete identity block", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      identity: {
        title: "fbDOOM",
        summary: "DOOM on /dev/fb0 with OSS audio through /dev/dsp.",
        accent: "#b5301c",
        glyph: "D",
        packages: ["fbdoom@local", "doom-shareware@local"],
      },
    }))).not.toThrow();
  });

  // `base` is gone: nothing verified the declared string, real ABI
  // compatibility is the binaries' own `__abi_version` check, and the app
  // computes the reference itself. An image that still declares one is
  // simply carrying an unknown key, not restating the ABI.
  it("drops a declared identity base", () => {
    const config = withProfile({
      identity: {
        title: "T",
        summary: "S",
        accent: "#b5301c",
        glyph: "D",
        base: "kandelo:shell@abi44",
      },
    });
    validateKandeloDemoConfig(config);
    expect(resolveDemoIdentity(config, "m")).toEqual({
      title: "T",
      summary: "S",
      accent: "#b5301c",
      glyph: "D",
    });
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

  // Review finding: title and summary were capped while each packages entry
  // was unbounded, so a field the gallery renders as a list could carry
  // arbitrarily long strings.
  it("rejects an overlong package entry", () => {
    expect(() => validateKandeloDemoConfig(withProfile({
      identity: {
        title: "T",
        summary: "S",
        accent: "#b5301c",
        glyph: "D",
        packages: ["ok@local", "p".repeat(129)],
      },
    }))).toThrow(
      /profiles\.m\.identity\.packages\[1\] must be at most 128 characters/,
    );
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

describe("resolvers", () => {
  const config = {
    version: 1,
    profiles: {
      bare: {},
      full: { runtime: { features: ["kms"] }, init: { target: "nginx" } },
    },
  } as unknown as KandeloDemoConfig;

  // The schema is profile-only: a machine field is read from the selected
  // profile or from nowhere. There is no top-level copy to fall back to, so
  // one profile's block can never answer for another's.
  it("reads runtime from the selected profile only", () => {
    expect(resolveDemoRuntime(config, "full")).toEqual({
      features: ["kms"],
      requests: {},
    });
    expect(resolveDemoRuntime(config, "bare")).toEqual({
      features: [],
      requests: {},
    });
  });

  it("returns an empty runtime for an image with no runtime block", () => {
    expect(resolveDemoRuntime(withProfile({}), "m")).toEqual({
      features: [],
      requests: {},
    });
  });

  it("resolves init only where declared", () => {
    expect(resolveDemoInit(config, "full")).toEqual({ target: "nginx" });
    expect(resolveDemoInit(config, "bare")).toBeNull();
  });

  it("resolves null for an unknown profile id", () => {
    expect(resolveDemoInit(config, "nope")).toBeNull();
    expect(resolveDemoDisplay(config, "nope")).toBeNull();
  });
});

describe("profile-only schema", () => {
  // A machine field at the top level used to resolve for every profile.
  // Rejecting it is what keeps one file from having two places to look —
  // and silently ignoring a top-level `init` would boot a different machine
  // than the file describes.
  it.each([
    ["init", { target: "nginx" }],
    ["runtime", { features: ["kms"] }],
    ["identity", { title: "T", summary: "S", accent: "#b5301c", glyph: "D" }],
    ["web", { requiredPorts: [8080] }],
    ["display", { minWidth: 640, minHeight: 480 }],
    ["assets", []],
    ["ingest", { accept: [".wad"], targetPath: "/u.wad", maxBytes: 1 }],
    ["guide", { title: "G" }],
    ["presentation", {
      bootPrimary: "syslog",
      runningPrimary: ["terminal"],
      terminalAccess: "primary",
      internalsAccess: "drawer",
    }],
  ])("rejects a top-level %s block", (key, value) => {
    expect(() => validateKandeloDemoConfig({
      version: 1,
      [key]: value,
      profiles: { m: {} },
    } as unknown as KandeloDemoConfig)).toThrow(
      new RegExp(
        `demo config declares ${key} at the top level; every machine field`
          + " belongs to a profile",
      ),
    );
  });

  it("names every misplaced block at once", () => {
    expect(() => validateKandeloDemoConfig({
      version: 1,
      init: { target: "nginx" },
      web: { requiredPorts: [8080] },
      profiles: { m: {} },
    } as unknown as KandeloDemoConfig)).toThrow(
      /demo config declares init, web at the top level/,
    );
  });

  it("keeps version, defaultProfile, and profiles at the top level", () => {
    expect(() => validateKandeloDemoConfig({
      version: 1,
      defaultProfile: "m",
      profiles: { m: { init: { target: "nginx" } } },
    } as unknown as KandeloDemoConfig)).not.toThrow();
  });
});

describe("tracked demo-config sources", () => {
  it("declares every tracked source", () => {
    // 10 = eight converted builders plus the shell image's base config and
    // its profile overlay, which are two separate tracked files.
    expect(TRACKED_DEMO_CONFIG_SOURCES.length).toBe(10);
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

  /**
   * The shell image's profile overlay is not an image config: it is merged
   * into the base before anything is baked, and the composed result takes
   * `defaultProfile` from the base. An overlay is never independently
   * bootable, so requiring it to name a default would force a value that
   * composition throws away — and the builder now rejects any top-level
   * overlay key other than `version` and `profiles`.
   */
  const COMPOSED_ONLY_SOURCES = new Set<string>([
    "packages/registry/shell/source-rootfs-shell-demo-profiles.json",
  ]);

  it.each(
    TRACKED_DEMO_CONFIG_SOURCES.filter(
      (relPath) => !COMPOSED_ONLY_SOURCES.has(relPath),
    ),
  )("%s declares a resolvable default", (relPath) => {
    const config = parseKandeloDemoConfig(
      readFileSync(join(findRepoRoot(), relPath), "utf8"),
    )!;
    expect(resolveDefaultProfileId(config)).not.toBeNull();
  });

  it.each([...COMPOSED_ONLY_SOURCES])(
    "%s declares only profiles, so composition owns the default",
    (relPath) => {
      const config = parseKandeloDemoConfig(
        readFileSync(join(findRepoRoot(), relPath), "utf8"),
      )!;
      expect(Object.keys(config).sort()).toEqual(["profiles", "version"]);
    },
  );
});
