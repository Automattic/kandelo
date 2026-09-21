import { describe, expect, it, vi } from "vitest";
import {
  decodeBootDescriptor,
  encodeBootDescriptor,
  HARD_CAPS,
  validateBootDescriptor,
} from "../src/boot-descriptor";
import {
  createInlineBootInput,
  KANDELO_BOOT_INPUT_DIR,
  KANDELO_BOOT_INPUT_MANIFEST_PATH,
  materializeBootInputs,
} from "../src/boot-inputs";
import type { BootDescriptor, BootInput } from "../src/kernel-host";

const HELLO_BYTES = new TextEncoder().encode("hello");
const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function patternedBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    bytes[offset] = offset % 251;
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", owned.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function descriptor(): BootDescriptor {
  return {
    version: 1,
    id: "input-test",
    title: "Input test",
    base: "kandelo:shell@abi11",
    runtime: {
      arch: "wasm32",
      kernel: "kernel@sha256:abc",
      memoryPages: 1024,
      features: ["pty"],
      time: "real",
    },
    packages: [],
    mounts: [
      { path: "/", source: "image", ref: "shell.vfs@local", readonly: false },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: ["/usr/local/bin/player", "/run/kandelo/inputs/rom/game.nes"],
      cwd: "/",
      env: { HOME: "/root" },
      uid: 0,
      gid: 0,
    },
  };
}

function descriptorWithInputs(inputs: BootInput[]): BootDescriptor {
  const value = descriptor();
  value.boot.inputs = inputs;
  return value;
}

function resolverDescriptor(): BootDescriptor {
  const value = descriptor();
  value.boot.parameters = {
    system: "nes",
    options: { overscan: false, players: 1 },
  };
  value.boot.inputs = [{
    id: "rom",
    filename: "game.nes",
    mediaType: "application/x-nes-rom",
    byteLength: HELLO_BYTES.byteLength,
    sha256: HELLO_SHA256,
    source: {
      kind: "resolver",
      resolver: "internet-archive",
      locator: {
        identifier: "example",
        file: "collection.zip",
        entries: ["game.nes"],
      },
    },
  }];
  return value;
}

describe("compressed inline boot inputs", () => {
  it("round-trips and verifies final bytes rather than gzip transport bytes", async () => {
    const finalBytes = patternedBytes(128 * 1024);
    const input = await createInlineBootInput({
      id: "state",
      filename: "save.state",
      mediaType: "application/vnd.libretro.state",
      bytes: finalBytes,
      compression: "gzip",
    });

    expect(input.byteLength).toBe(finalBytes.byteLength);
    expect(input.sha256).toBe(await sha256Hex(finalBytes));
    expect(input.source).toMatchObject({ kind: "inline", compression: "gzip" });
    if (input.source.kind !== "inline") throw new Error("expected inline source");
    expect(Math.floor(input.source.data.length * 6 / 8)).toBeLessThan(finalBytes.byteLength);
    expect(Math.floor(input.source.data.length * 6 / 8)).toBeLessThanOrEqual(
      HARD_CAPS.maxInlineInputBytes,
    );

    const encoded = await encodeBootDescriptor(descriptorWithInputs([input]));
    const decoded = await decodeBootDescriptor(encoded.fragment);
    const writes = new Map<string, Uint8Array>();
    const modes = new Map<string, number>();
    const manifest = await materializeBootInputs(decoded!, {
      mkdir: vi.fn(),
      writeFile(path, bytes, mode) {
        writes.set(path, bytes.slice());
        modes.set(path, mode);
      },
    });

    expect(writes.get("/run/kandelo/inputs/state/save.state")).toEqual(finalBytes);
    expect(modes.get("/run/kandelo/inputs/state/save.state")).toBe(0o755);
    expect(modes.get(KANDELO_BOOT_INPUT_MANIFEST_PATH)).toBe(0o644);
    expect(manifest.inputs[0]).toMatchObject({
      id: "state",
      byteLength: finalBytes.byteLength,
      sha256: await sha256Hex(finalBytes),
    });
  });

  it("rejects corrupt gzip before touching the VFS", async () => {
    const input = await createInlineBootInput({
      id: "state",
      filename: "save.state",
      bytes: patternedBytes(64 * 1024),
      compression: "gzip",
    });
    if (input.source.kind !== "inline") throw new Error("expected inline source");
    input.source.data = "AAAA";
    const mkdir = vi.fn();
    const writeFile = vi.fn();

    await expect(materializeBootInputs(descriptorWithInputs([input]), {
      mkdir,
      writeFile,
    })).rejects.toMatchObject({ code: "E_INLINE_COMPRESSION" });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("stops gzip expansion at the declared final-byte boundary", async () => {
    const input = await createInlineBootInput({
      id: "state",
      filename: "save.state",
      bytes: patternedBytes(128 * 1024),
      compression: "gzip",
    });
    input.byteLength = 1024;
    const mkdir = vi.fn();
    const writeFile = vi.fn();

    await expect(materializeBootInputs(descriptorWithInputs([input]), {
      mkdir,
      writeFile,
    })).rejects.toMatchObject({ code: "E_INPUT_SIZE_MISMATCH" });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("rejects declared gzip output above the inflated inline cap", async () => {
    const input = await createInlineBootInput({
      id: "state",
      filename: "save.state",
      bytes: HELLO_BYTES,
      compression: "gzip",
    });
    input.byteLength = HARD_CAPS.maxInlineInflatedInputBytes + 1;

    expect(() => validateBootDescriptor(descriptorWithInputs([input]))).toThrowError(
      expect.objectContaining({ code: "E_INLINE_TOO_LARGE" }),
    );
  });

  it("performs no writes when a later compressed input cannot be decoded", async () => {
    const valid = await createInlineBootInput({
      id: "config",
      filename: "config.bin",
      bytes: HELLO_BYTES,
      compression: "gzip",
    });
    const corrupt = await createInlineBootInput({
      id: "state",
      filename: "save.state",
      bytes: patternedBytes(64 * 1024),
      compression: "gzip",
    });
    if (corrupt.source.kind !== "inline") throw new Error("expected inline source");
    corrupt.source.data = "AAAA";
    const mkdir = vi.fn();
    const writeFile = vi.fn();

    await expect(materializeBootInputs(descriptorWithInputs([valid, corrupt]), {
      mkdir,
      writeFile,
    })).rejects.toMatchObject({ code: "E_INLINE_COMPRESSION" });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("honors cancellation before decompressing or writing an inline input", async () => {
    const input = await createInlineBootInput({
      id: "state",
      filename: "save.state",
      bytes: patternedBytes(64 * 1024),
      compression: "gzip",
    });
    const controller = new AbortController();
    controller.abort();
    const mkdir = vi.fn();
    const writeFile = vi.fn();

    await expect(materializeBootInputs(descriptorWithInputs([input]), {
      mkdir,
      writeFile,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("rejects an unsupported compression passed to the public helper at runtime", async () => {
    const options = {
      id: "state",
      filename: "save.state",
      bytes: HELLO_BYTES,
      compression: "deflate",
    } as unknown as Parameters<typeof createInlineBootInput>[0];

    await expect(createInlineBootInput(options)).rejects.toMatchObject({
      code: "E_INLINE_COMPRESSION",
    });
  });
});

describe("materializeBootInputs", () => {
  it("resolves, verifies, and writes inputs plus the well-known manifest", async () => {
    const writes = new Map<string, Uint8Array>();
    const directories: string[] = [];
    const resolve = vi.fn(async () => HELLO_BYTES);
    const result = await materializeBootInputs(resolverDescriptor(), {
      resolvers: { "internet-archive": resolve },
      mkdir(path) {
        directories.push(path);
      },
      writeFile(path, bytes) {
        writes.set(path, bytes.slice());
      },
    });

    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: "example", entries: ["game.nes"] }),
      expect.objectContaining({ input: expect.objectContaining({ id: "rom" }) }),
    );
    expect(directories).toContain(`${KANDELO_BOOT_INPUT_DIR}/rom`);
    expect(new TextDecoder().decode(writes.get(`${KANDELO_BOOT_INPUT_DIR}/rom/game.nes`)!)).toBe("hello");
    expect(result).toMatchObject({
      version: 1,
      parameters: { system: "nes" },
      inputs: [{
        id: "rom",
        path: `${KANDELO_BOOT_INPUT_DIR}/rom/game.nes`,
        byteLength: 5,
        sha256: HELLO_SHA256,
      }],
    });
    expect(result).not.toHaveProperty("descriptorVersion");
    const manifest = JSON.parse(
      new TextDecoder().decode(writes.get(KANDELO_BOOT_INPUT_MANIFEST_PATH)!),
    );
    expect(manifest).toEqual(result);
  });

  it("performs no writes when any resolved input fails verification", async () => {
    const invalid = resolverDescriptor();
    invalid.boot.inputs![0].byteLength = 6;
    const mkdir = vi.fn();
    const writeFile = vi.fn();

    await expect(materializeBootInputs(invalid, {
      resolvers: { "internet-archive": async () => HELLO_BYTES },
      mkdir,
      writeFile,
    })).rejects.toMatchObject({ code: "E_INPUT_SIZE_MISMATCH" });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("performs no writes when the resolved SHA-256 does not match", async () => {
    const invalid = resolverDescriptor();
    invalid.boot.inputs![0].sha256 = "0".repeat(64);
    const mkdir = vi.fn();
    const writeFile = vi.fn();

    await expect(materializeBootInputs(invalid, {
      resolvers: { "internet-archive": async () => HELLO_BYTES },
      mkdir,
      writeFile,
    })).rejects.toMatchObject({ code: "E_INPUT_HASH_MISMATCH" });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("fails loudly for an unavailable resolver without touching the VFS", async () => {
    const mkdir = vi.fn();
    const writeFile = vi.fn();

    await expect(materializeBootInputs(resolverDescriptor(), {
      mkdir,
      writeFile,
    })).rejects.toMatchObject({ code: "E_INPUT_RESOLVER_UNAVAILABLE" });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("fails loudly for an unavailable resolver even with an explicit empty registry", async () => {
    // Mirrors the deployed policy: the resolver registry ships empty (inline
    // sources only), but `resolver`-kind inputs still validate structurally
    // and fail materialization loudly rather than being silently skipped.
    const mkdir = vi.fn();
    const writeFile = vi.fn();

    await expect(materializeBootInputs(resolverDescriptor(), {
      resolvers: {},
      mkdir,
      writeFile,
    })).rejects.toMatchObject({ code: "E_INPUT_RESOLVER_UNAVAILABLE" });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("still writes the manifest when the descriptor declares no inputs", async () => {
    const writes = new Map<string, Uint8Array>();
    const mkdir = vi.fn();

    const result = await materializeBootInputs(descriptor(), {
      mkdir,
      writeFile(path, bytes) {
        writes.set(path, bytes.slice());
      },
    });

    expect(result).toEqual({ version: 1, parameters: {}, inputs: [] });
    expect(mkdir).toHaveBeenCalledWith("/run", 0o755);
    expect(mkdir).toHaveBeenCalledWith("/run/kandelo", 0o755);
    expect(mkdir).toHaveBeenCalledWith(KANDELO_BOOT_INPUT_DIR, 0o755);
    const manifest = JSON.parse(new TextDecoder().decode(writes.get(KANDELO_BOOT_INPUT_MANIFEST_PATH)!));
    expect(manifest).toEqual(result);
  });
});
