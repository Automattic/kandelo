import { afterAll, describe, expect, it } from "vitest";
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "../../../../host/test/centralized-test-helper";
import { ffmpegProgram, fixture, run } from "./ffmpeg-support";

// Native n9.0 behaviors measured in fixtures/README.md ("Native behaviors").
const NATIVE_OVERWRITE_STATUS = 0;
const NATIVE_SIGINT_STATUS = 255;
const SIGINT = 2;

const ffmpeg = ffmpegProgram("ffmpeg");
const ffprobe = ffmpegProgram("ffprobe");
const dash = tryResolveBinary("programs/dash.wasm");
const clip = fixture("fixture.mp4");
const scratch: string[] = [];
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(): string {
  const d = makeHostScratchTempRoot("kandelo-ffmpeg-");
  scratch.push(d);
  return d;
}

function bytes(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Run ffmpeg under NodeKernelHost directly so the test can signal it or type into its PTY. */
async function interactive(
  argv: string[],
  drive: (host: NodeKernelHost, pid: number, output: () => string) => Promise<void>,
  pty: boolean,
): Promise<number> {
  let out = "";
  const append = (_pid: number, d: Uint8Array) => { out += new TextDecoder().decode(d); };
  const host = new NodeKernelHost({
    maxWorkers: 4,
    onStdout: append,
    onStderr: append,
    onPtyOutput: append,
  });
  await host.init();
  try {
    let started!: (pid: number) => void;
    const pidReady = new Promise<number>((r) => { started = r; });
    const exit = host.spawn(bytes(ffmpeg!), argv, { pty, onStarted: (pid) => started(pid) });
    const pid = await pidReady;
    // An early exit must fail with FFmpeg's own output, not a driver timeout.
    const exitedEarly = exit.then((status) => {
      throw new Error(`ffmpeg exited with ${status} before the test drove it:\n${out}`);
    });
    await Promise.race([drive(host, pid, () => out), exitedEarly]);
    exitedEarly.catch(() => {});
    return await exit;
  } finally {
    await host.destroy();
  }
}

async function durationOf(file: string): Promise<number> {
  const probe = await run(ffprobe!, [
    "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  expect(probe.exitCode, probe.stderr).toBe(0);
  return Number(probe.stdout.trim());
}

describe.skipIf(!ffmpeg || !ffprobe || !dash)("ffmpeg process runtime", () => {
  it("transcodes through a pipe between two processes in a shell", async () => {
    // The shell makes the pipe; its input is the fixture on the host
    // filesystem. (Feeding the shell host-supplied stdin that a child then
    // reads is ledger gap G4.)
    const r = await runCentralizedProgram({
      programPath: dash!,
      argv: ["sh", "-c",
        `${ffmpeg} -nostdin -v error -i '${clip}' -map 0:v -c:v rawvideo -f nut pipe:1 | ` +
        `${ffprobe} -v error -show_entries stream=codec_name,width,height -of csv=p=0 pipe:0`],
      useDefaultRootfs: false,
      timeout: 120_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("rawvideo,176,144");
  }, 180_000);

  it("writes an output path containing a space and UTF-8", async () => {
    const out = join(tmp(), "out ü.wav");
    const r = await run(ffmpeg!, [
      "ffmpeg", "-nostdin", "-v", "error", "-i", clip, "-map", "0:a", "-c:a", "pcm_s16le", out,
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(44);
  }, 180_000);

  it("refuses to overwrite without -y when stdin is not a terminal", async () => {
    const out = join(tmp(), "exists.wav");
    writeFileSync(out, "keep");
    const r = await run(ffmpeg!, [
      "ffmpeg", "-nostdin", "-i", clip, "-map", "0:a", out,
    ], { timeout: 30_000 });
    expect(r.exitCode).toBe(NATIVE_OVERWRITE_STATUS);
    expect(r.stderr).toContain("already exists. Exiting.");
    expect(readFileSync(out, "utf8")).toBe("keep");
  }, 180_000);

  it("SIGINT stops a long encode and leaves a valid file", async () => {
    const out = join(tmp(), "sigint.mp4");
    const status = await interactive(
      ["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25",
       "-c:v", "mpeg4", out],
      async (host, pid) => {
        await until(() => existsSync(out) && statSync(out).size > 0, 60_000);
        expect(await host.signalProcess(pid, SIGINT)).toBe(true);
      },
      false,
    );
    expect(status).toBe(NATIVE_SIGINT_STATUS);
    expect(await durationOf(out)).toBeGreaterThan(0);
  }, 180_000);

  it("typing q on a terminal stops the run cleanly", async () => {
    const out = join(tmp(), "q.mp4");
    const status = await interactive(
      ["ffmpeg", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-c:v", "mpeg4", out],
      async (host, pid, output) => {
        await until(() => /frame=\s*\d+/.test(output()), 60_000);
        host.ptyWrite(pid, new TextEncoder().encode("q"));
      },
      true,
    );
    expect(status).toBe(0);
    expect(await durationOf(out)).toBeGreaterThan(0);
  }, 180_000);
});
