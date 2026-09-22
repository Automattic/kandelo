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
