import { describe, expect, it } from "vitest";
import {
  MAX_REQUESTED_MEMORY_PAGES,
  MAX_REQUESTED_WORKERS,
  validateKandeloDemoConfig,
  resolveDemoWeb,
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
