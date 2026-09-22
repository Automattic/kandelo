import { describe, expect, it } from "vitest";
import {
  BootDescriptorError,
  decodeBootDescriptor,
  encodeBootDescriptor,
  HARD_CAPS,
  validateBootDescriptor,
} from "../src/boot-descriptor";
import { createInlineBootInput } from "../src/boot-inputs";
import type { BootDescriptor, BootInput, BootParameters } from "../src/kernel-host";

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

/**
 * Build a descriptor carrying a boot-link script the way ShareDialog does
 * post-migration: an inline, gzip-transported `script` input plus a
 * `runScript` boot parameter naming it. Scripts no longer have a dedicated
 * descriptor field or cap — they are an ordinary boot input, so all the
 * generic input caps in "boot inputs and parameters validation" below (size,
 * hash, filename, count) apply to them exactly as to any other input.
 */
async function withScript(text: string): Promise<BootDescriptor> {
  const value = structuredClone(BASE);
  value.boot.inputs = [await createInlineBootInput({
    id: "script",
    filename: "kandelo-link.sh",
    bytes: new TextEncoder().encode(text),
    compression: "gzip",
  })];
  value.boot.parameters = { runScript: "script" };
  return value;
}

const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function helloInlineInput(id = "rom"): BootInput {
  return {
    id,
    filename: "game.nes",
    byteLength: 5,
    sha256: HELLO_SHA256,
    // base64url("hello")
    source: { kind: "inline", data: "aGVsbG8" },
  };
}

function withInputs(inputs: BootInput[]): BootDescriptor {
  const value = structuredClone(BASE);
  value.boot.inputs = inputs;
  return value;
}

function withParameters(parameters: BootParameters): BootDescriptor {
  const value = structuredClone(BASE);
  value.boot.parameters = parameters;
  return value;
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

  it("round-trips a descriptor carrying a boot-link script as an input", async () => {
    const desc = await withScript('echo "hello from a link"\nuname -a\n');
    const { fragment } = await encodeBootDescriptor(desc);
    const decoded = await decodeBootDescriptor(fragment);
    expect(decoded?.boot.inputs).toEqual(desc.boot.inputs);
    expect(decoded?.boot.parameters).toEqual({ runScript: "script" });
  });

  it("returns null for a non-k1 fragment", async () => {
    expect(await decodeBootDescriptor("#node")).toBeNull();
    expect(await decodeBootDescriptor("")).toBeNull();
  });

  it("rejects garbage after a valid k1 envelope prefix", async () => {
    await expect(decodeBootDescriptor("#k1=AAAA")).rejects.toThrow();
  });
});

describe("boot inputs and parameters validation", () => {
  it("accepts a descriptor without a script", () => {
    expect(() => validateBootDescriptor(structuredClone(BASE))).not.toThrow();
  });

  it("accepts a script-carrying descriptor built by createInlineBootInput", async () => {
    const desc = await withScript("echo hi\n");
    expect(() => validateBootDescriptor(desc)).not.toThrow();
  });

  it("accepts a zero-byte script input", async () => {
    // Boot inputs have no dedicated non-empty rule (unlike the removed
    // `script.text` field): `createInlineBootInput` and descriptor
    // validation both accept byteLength 0, mirroring the donor library this
    // was ported from. An empty link script is inert, not malformed.
    const desc = await withScript("");
    expect(() => validateBootDescriptor(desc)).not.toThrow();
    expect(desc.boot.inputs?.[0]?.byteLength).toBe(0);
  });

  it("rejects a script input over the inline transport cap the same way any input does", async () => {
    // Scripts carry no bespoke size cap post-migration; oversized script
    // text hits the same generic inline caps exercised below for arbitrary
    // inputs (`rejects inline input data over the carried-bytes cap`).
    const big = "x".repeat(HARD_CAPS.maxInlineInflatedInputBytes + 1);
    await expect(withScript(big)).rejects.toMatchObject({ name: "BootDescriptorError" });
  });

  it("accepts inputs and parameters on a version-1 descriptor with no version bump", () => {
    const desc = withInputs([helloInlineInput()]);
    desc.boot.parameters = { system: "nes" };
    expect(() => validateBootDescriptor(desc)).not.toThrow();
  });

  it("round-trips a descriptor carrying inputs and parameters through encode/decode", async () => {
    const desc = withInputs([helloInlineInput()]);
    desc.boot.parameters = { system: "nes", options: { overscan: false, players: 1 } };
    const { fragment } = await encodeBootDescriptor(desc);
    const decoded = await decodeBootDescriptor(fragment);
    expect(decoded).toEqual(desc);
  });

  it("rejects boot input counts over maxBootInputs", () => {
    const inputs = Array.from({ length: HARD_CAPS.maxBootInputs + 1 }, (_, index) =>
      helloInlineInput(`rom-${index}`));
    expect(validationError(withInputs(inputs)).code).toBe("E_TOO_MANY_INPUTS");
  });

  it("accepts a boot input count exactly at maxBootInputs", () => {
    const inputs = Array.from({ length: HARD_CAPS.maxBootInputs }, (_, index) =>
      helloInlineInput(`rom-${index}`));
    expect(() => validateBootDescriptor(withInputs(inputs))).not.toThrow();
  });

  it("accepts bounded canonical inline data and rejects non-canonical padding bits", () => {
    const valid = withInputs([{
      id: "rom",
      filename: "game.nes",
      byteLength: 5,
      sha256: HELLO_SHA256,
      source: { kind: "inline", data: "aGVsbG8" },
    }]);
    expect(() => validateBootDescriptor(valid)).not.toThrow();

    // "Zh" also decodes to one byte in permissive decoders, but its unused
    // bits are non-zero. Descriptor validation performs the canonical-bit
    // check rather than accepting any base64url-shaped string.
    const nonCanonical = withInputs([{
      id: "file",
      filename: "file.bin",
      byteLength: 1,
      sha256: "0".repeat(64),
      source: { kind: "inline", data: "Zh" },
    }]);
    expect(validationError(nonCanonical).code).toBe("E_INLINE_ENCODING");
  });

  it("rejects inline input data over the carried-bytes cap", () => {
    // The base64url char cap (`Math.ceil(maxInlineInputBytes * 4 / 3)`) is
    // the first gate an oversized payload hits, so it fails as a plain
    // over-length field rather than reaching the decoded-length check.
    const oversized: BootInput = {
      id: "big",
      filename: "big.bin",
      byteLength: Math.ceil(HARD_CAPS.maxInlineInputBytes * 4 / 3),
      sha256: "0".repeat(64),
      source: { kind: "inline", data: "A".repeat(Math.ceil(HARD_CAPS.maxInlineInputBytes * 4 / 3) + 4) },
    };
    expect(validationError(withInputs([oversized])).code).toBe("E_FIELD_TOO_LONG");
  });

  it("rejects a gzip-compressed input whose declared byteLength exceeds the inflated cap", () => {
    const oversized: BootInput = {
      id: "state",
      filename: "save.state",
      byteLength: HARD_CAPS.maxInlineInflatedInputBytes + 1,
      sha256: "0".repeat(64),
      source: { kind: "inline", data: "aGVsbG8", compression: "gzip" },
    };
    expect(validationError(withInputs([oversized])).code).toBe("E_INLINE_TOO_LARGE");
  });

  it("rejects boot.parameters over maxParametersBytes", () => {
    // Each string stays under the per-string JSON char cap; only their sum
    // pushes the serialized object over the aggregate byte cap.
    const chunk = "x".repeat(HARD_CAPS.maxJsonStringChars - 1);
    const chunkCount = Math.ceil(HARD_CAPS.maxParametersBytes / chunk.length) + 1;
    const oversized = withParameters({ chunks: Array.from({ length: chunkCount }, () => chunk) });
    expect(validationError(oversized).code).toBe("E_JSON_TOO_LARGE");
  });

  it("accepts boot.parameters comfortably under maxParametersBytes", () => {
    const chunk = "x".repeat(HARD_CAPS.maxJsonStringChars - 1);
    const value = withParameters({ chunks: [chunk, chunk] });
    expect(() => validateBootDescriptor(value)).not.toThrow();
  });

  it("rejects a malformed sha256 shape", () => {
    const bad: BootInput = { ...helloInlineInput(), sha256: "ABC" };
    expect(validationError(withInputs([bad])).code).toBe("E_INPUT_HASH");
  });

  it("rejects duplicate boot input ids", () => {
    const dup = helloInlineInput("rom");
    expect(validationError(withInputs([dup, { ...dup }])).code).toBe("E_DUPLICATE_INPUT");
  });

  it("rejects an unsafe input filename", () => {
    const bad: BootInput = { ...helloInlineInput(), filename: "../escape.nes" };
    expect(validationError(withInputs([bad])).code).toBe("E_INPUT_FILENAME");
  });

  it("validates resolver-kind sources structurally without resolving them", () => {
    const resolverInput: BootInput = {
      id: "rom",
      filename: "game.nes",
      mediaType: "application/x-nes-rom",
      byteLength: 5,
      sha256: HELLO_SHA256,
      source: {
        kind: "resolver",
        resolver: "internet-archive",
        locator: { identifier: "example", entries: ["game.nes"] },
      },
    };
    expect(() => validateBootDescriptor(withInputs([resolverInput]))).not.toThrow();
  });

  it("rejects a resolver-kind source with an unsafe resolver name", () => {
    const bad: BootInput = {
      id: "rom",
      filename: "game.nes",
      byteLength: 5,
      sha256: HELLO_SHA256,
      source: { kind: "resolver", resolver: "Not Safe!", locator: {} },
    };
    expect(validationError(withInputs([bad])).code).toBe("E_INPUT_RESOLVER");
  });

  it("rejects an unrecognized boot input source kind", () => {
    const bad = {
      id: "rom",
      filename: "game.nes",
      byteLength: 5,
      sha256: HELLO_SHA256,
      source: { kind: "http", url: "https://example.com/game.nes" },
    } as unknown as BootInput;
    expect(validationError(withInputs([bad])).code).toBe("E_INPUT_SOURCE");
  });
});
