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
