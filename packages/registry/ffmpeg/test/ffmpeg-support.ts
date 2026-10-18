import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import {
  runCentralizedProgram,
  type RunProgramResult,
} from "../../../../host/test/centralized-test-helper";

/** Acceptance runs forbid skips: a missing binary or resource is a failure. */
export const ACCEPTANCE = process.env.KANDELO_FFMPEG_ACCEPTANCE === "1";
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * FFmpeg's own tests compare both AAC decoders, fixed-point included, per
 * sample within 2 (tests/fate/aac.mak: CMP = oneoff, FUZZ = 2): tables built
 * at startup with the C math library legitimately differ in the last bit
 * between libms. Video decoders are compared byte for byte.
 */
export const FATE_AAC_FUZZ = 2;

export function fixture(name: string): string {
  return join(FIXTURES, name);
}

export function readFixtureText(name: string): string {
  return readFileSync(fixture(name), "utf8");
}

/**
 * Resolve an FFmpeg program. KANDELO_FFMPEG_BIN_DIR points at a hand-built
 * aperture-rung tree (design §7) whose programs have no .wasm suffix;
 * otherwise the package output is resolved normally.
 */
export function ffmpegProgram(name: "ffmpeg" | "ffprobe" | "ffplay"): string | null {
  const dir = process.env.KANDELO_FFMPEG_BIN_DIR;
  const path = dir ? join(dir, name) : tryResolveBinary(`programs/ffmpeg/${name}.wasm`);
  if (!path && ACCEPTANCE) {
    throw new Error(
      `acceptance run requires programs/ffmpeg/${name}.wasm; build the ffmpeg package first`,
    );
  }
  return path ?? null;
}

/**
 * Run with the host filesystem visible (no rootfs image), so fixtures and
 * scratch files are addressed by their host paths.
 */
export function run(
  program: string,
  argv: string[],
  opts: { stdinBytes?: Uint8Array; timeout?: number; env?: string[] } = {},
): Promise<RunProgramResult> {
  return runCentralizedProgram({
    programPath: program,
    argv,
    useDefaultRootfs: false,
    stdinBytes: opts.stdinBytes,
    env: opts.env,
    timeout: opts.timeout ?? 120_000,
  });
}

function toInt16(bytes: Uint8Array): Int16Array {
  const copy = bytes.slice();
  return new Int16Array(copy.buffer, 0, copy.byteLength >> 1);
}

/** Largest per-sample difference between two s16le PCM buffers. */
export function maxAbsSampleDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.byteLength !== b.byteLength) {
    throw new Error(`PCM length differs: ${a.byteLength} vs ${b.byteLength}`);
  }
  const x = toInt16(a);
  const y = toInt16(b);
  let max = 0;
  for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i] - y[i]));
  return max;
}
