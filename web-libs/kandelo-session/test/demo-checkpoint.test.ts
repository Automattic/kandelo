import { describe, expect, it, vi } from "vitest";
import {
  parseKandeloDemoConfig,
  resolveDemoCheckpoint,
  validateKandeloDemoConfig,
  type DemoCheckpointConfig,
} from "../src/demo-config";
import {
  CheckpointError,
  captureDemoCheckpoint,
  createCheckpointBootInputs,
} from "../src/demo-checkpoint";
import { materializeBootInputs } from "../src/boot-inputs";
import type {
  BootDescriptor,
  BootInput,
  DemoIngestSource,
  KernelHost,
} from "../src/kernel-host";

const CHECKPOINT: DemoCheckpointConfig = {
  capture: {
    argv: ["/usr/local/bin/save-state", "--now"],
    path: "/tmp/app.state",
    maxBytes: 64,
  },
  inputId: "state",
  filename: "app.state",
};

const ROM: BootInput = {
  id: "rom",
  filename: "game.bin",
  byteLength: 4,
  sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
  source: { kind: "resolver", resolver: "example", locator: { item: "x" } },
};

function host(options: {
  status?: number | Error;
  file?: Uint8Array | Error;
  source?: DemoIngestSource | null;
} = {}): Pick<KernelHost, "runProgram" | "readFile" | "getDemoIngestSource"> & {
  runProgram: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
} {
  const status = options.status ?? 0;
  const file = options.file ?? Uint8Array.from([1, 2, 3, 4, 5]);
  return {
    runProgram: vi.fn(async () => {
      if (status instanceof Error) throw status;
      return status;
    }),
    readFile: vi.fn(async () => {
      if (file instanceof Error) throw file;
      return file;
    }),
    getDemoIngestSource: () => options.source ?? null,
  };
}

function config(checkpoint: unknown): string {
  return JSON.stringify({ version: 1, profiles: { app: { checkpoint } } });
}

describe("image-owned checkpoint metadata", () => {
  it("resolves a declared checkpoint for its profile only", () => {
    const parsed = parseKandeloDemoConfig(config({ ...CHECKPOINT, label: "Include save state" }))!;
    expect(resolveDemoCheckpoint(parsed, "app")).toEqual({
      ...CHECKPOINT,
      label: "Include save state",
    });
    expect(resolveDemoCheckpoint(parsed, "other")).toBeNull();
  });

  it.each([
    ["a relative command", { ...CHECKPOINT, capture: { ...CHECKPOINT.capture, argv: ["save-state"] } }, /argv\[0\] must be absolute/],
    ["an empty command", { ...CHECKPOINT, capture: { ...CHECKPOINT.capture, argv: [] } }, /argv must be an array/],
    ["a traversing output path", { ...CHECKPOINT, capture: { ...CHECKPOINT.capture, path: "/tmp/../etc/passwd" } }, /path must be a normalized/],
    ["a cap no link could carry", { ...CHECKPOINT, capture: { ...CHECKPOINT.capture, maxBytes: 2 * 1024 * 1024 + 1 } }, /exceeds the 2097152-byte ceiling/],
    ["a zero cap", { ...CHECKPOINT, capture: { ...CHECKPOINT.capture, maxBytes: 0 } }, /maxBytes must be a positive integer/],
    ["an input id with a slash", { ...CHECKPOINT, inputId: "a/b" }, /inputId must be a short identifier/],
    ["a filename with a directory", { ...CHECKPOINT, filename: "dir/app.state" }, /filename must be a safe basename/],
  ])("rejects %s", (_label, checkpoint, message) => {
    expect(() => validateKandeloDemoConfig(JSON.parse(config(checkpoint)))).toThrow(message);
  });

  it("belongs to a profile, not the top level", () => {
    expect(() =>
      validateKandeloDemoConfig({ version: 1, checkpoint: CHECKPOINT } as never)
    ).toThrow(/checkpoint at the top level/);
  });
});

describe("checkpoint capture", () => {
  it("runs the image's command, then reads the file it named", async () => {
    const h = host();
    await expect(captureDemoCheckpoint(h, CHECKPOINT)).resolves.toEqual(
      Uint8Array.from([1, 2, 3, 4, 5]),
    );
    expect(h.runProgram).toHaveBeenCalledWith(
      ["/usr/local/bin/save-state", "--now"],
      { timeoutMs: 15_000 },
    );
    expect(h.readFile).toHaveBeenCalledWith("/tmp/app.state");
  });

  it("does not read a stale file when the command fails", async () => {
    const h = host({ status: 1 });
    await expect(captureDemoCheckpoint(h, CHECKPOINT)).rejects.toMatchObject({
      reason: "capture-failed",
      message: expect.stringContaining("exited with status 1"),
    });
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it("reports a command that could not be run or timed out", async () => {
    const h = host({ status: new Error("did not exit within 15000 ms") });
    await expect(captureDemoCheckpoint(h, CHECKPOINT)).rejects.toMatchObject({
      reason: "capture-failed",
      message: expect.stringContaining("did not exit within"),
    });
  });

  it.each([
    ["missing", new Error("ENOENT: no such regular file: /tmp/app.state"), "missing"],
    ["empty", new Uint8Array(), "empty"],
    ["over the image's cap", new Uint8Array(65), "too-large"],
  ] as const)("rejects a %s checkpoint after a successful command", async (_label, file, reason) => {
    await expect(captureDemoCheckpoint(host({ file }), CHECKPOINT)).rejects.toMatchObject({
      reason,
    });
  });
});

describe("checkpoint boot inputs", () => {
  it("carries the state as a verified inline input that a later boot materializes", async () => {
    const inputs = await createCheckpointBootInputs(host(), CHECKPOINT);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      id: "state",
      filename: "app.state",
      byteLength: 5,
      source: { kind: "inline", compression: "gzip" },
    });

    // Round-trip through the real boot path: the opener's machine must end
    // up with exactly the captured bytes at the path the image reads.
    const written = new Map<string, Uint8Array>();
    const descriptor: BootDescriptor = {
      version: 1,
      id: "app",
      title: "App",
      base: "kandelo:shell@abi45",
      runtime: {
        arch: "wasm32",
        kernel: "kernel@sha256:abc",
        memoryPages: 1024,
        features: ["pty"],
        time: "real",
      },
      packages: [],
      mounts: [{ path: "/", source: "image", ref: "app.vfs@local" }],
      boot: { argv: ["sh"], cwd: "/", env: {}, inputs },
    } as BootDescriptor;
    await materializeBootInputs(descriptor, {
      mkdir: () => {},
      writeFile: (path, bytes) => { written.set(path, bytes); },
    });
    expect(written.get("/run/kandelo/inputs/state/app.state")).toEqual(
      Uint8Array.from([1, 2, 3, 4, 5]),
    );
  });

  it("keeps the inputs the machine booted with while nothing was ingested", async () => {
    const stale: BootInput = { ...ROM, id: "state", filename: "app.state" };
    const inputs = await createCheckpointBootInputs(host(), CHECKPOINT, [ROM, stale]);
    // The content input survives; the previous link's state is replaced.
    expect(inputs.map((input) => input.id)).toEqual(["rom", "state"]);
    expect(inputs[0]).toEqual(ROM);
    expect(inputs[1].source.kind).toBe("inline");
  });

  it("names ingested content by the input it was fetched through", async () => {
    const other: BootInput = { ...ROM, filename: "other.bin" };
    const inputs = await createCheckpointBootInputs(
      host({ source: { kind: "input", input: other } }),
      CHECKPOINT,
      [ROM],
    );
    // What the machine booted with is no longer what it runs.
    expect(inputs.map((input) => input.filename)).toEqual(["other.bin", "app.state"]);
  });

  it("refuses, without capturing, when the content came from the visitor's device", async () => {
    const h = host({ source: { kind: "upload", name: "mine.bin" } });
    const failure = await createCheckpointBootInputs(h, CHECKPOINT, [ROM]).catch((e) => e);
    expect(failure).toBeInstanceOf(CheckpointError);
    expect(failure.reason).toBe("unshareable-content");
    expect(failure.message).toContain("mine.bin");
    expect(h.runProgram).not.toHaveBeenCalled();
  });
});

describe("checkpoint size in a link", () => {
  it("explains a checkpoint too large for a link in terms of the link", async () => {
    // Incompressible bytes, so gzip cannot bring them under the carried cap.
    const noise = new Uint8Array(40 * 1024);
    let x = 0x2545f491;
    for (let i = 0; i < noise.length; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      noise[i] = x & 0xff;
    }
    const big = { ...CHECKPOINT, capture: { ...CHECKPOINT.capture, maxBytes: noise.length } };
    await expect(createCheckpointBootInputs(host({ file: noise }), big)).rejects.toMatchObject({
      reason: "too-large",
      message: expect.stringContaining("too large for a link"),
    });
  });
});
