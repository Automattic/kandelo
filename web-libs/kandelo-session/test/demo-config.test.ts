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
