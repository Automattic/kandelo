/**
 * End-to-end `/dev/dsp` playback through the same paced Node sink used by the
 * worker-thread host. No legacy pull drain participates in these tests: the
 * shared-clock transport is claimed before the guest starts, and descriptor
 * close cannot complete until the null sink's wall clock consumes the tail.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { NodePcmDriver } from "../src/audio/node-pcm-driver";
import {
  pcmControlWords,
  readConsumerPosition,
  readDiscardPosition,
  readProducerPosition,
  type PcmTransportDescriptor,
} from "../src/audio/pcm-transport";
import { NodePlatformIO } from "../src/platform/node";
import { resolveBinary } from "../src/binary-resolver";
import type { CentralizedKernelWorker } from "../src/kernel-worker";
import { ABI_SYSCALLS } from "../src/generated/abi";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureSdlDspFixtures } from "./sdl-dsp-fixtures";

const SNDCTL_DSP_GETOSPACE = 0x8010_500c;

interface AudioProgramResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  consumed: Uint8Array;
  sampleRate: number;
  channels: number;
  drainedAtExit: boolean;
  cleanTail: boolean;
  producerBytes: number;
  consumerBytes: number;
  discardedBytes: number;
  ioctlRequests: number[];
}

async function runAudioProgram(
  relativePath: string,
  argv: string[],
  timeoutMs = 15_000,
): Promise<AudioProgramResult> {
  const consumedChunks: Uint8Array[] = [];
  let kernel: CentralizedKernelWorker | null = null;
  let pcmDriver: NodePcmDriver | null = null;
  let transport: PcmTransportDescriptor | null = null;
  let initialProducer = 0n;
  let initialConsumer = 0n;
  let initialDiscard = 0n;
  const start = performance.now();
  try {
    const result = await runCentralizedProgram({
      programPath: resolveBinary(relativePath),
      argv,
      env: ["SDL_AUDIODRIVER=dsp"],
      timeout: timeoutMs,
      io: new NodePlatformIO(),
      onKernelReady: async (readyKernel) => {
        kernel = readyKernel;
        // This opt-in trace is scoped to the fixture process and is drained
        // after exit. It proves which unmodified upstream backend path ran
        // without adding a production-only ioctl counter or weakening the ABI.
        readyKernel.enableSyscallTrace();
        transport = readyKernel.claimPcmTransport(false);
        const words = pcmControlWords(transport);
        initialProducer = readProducerPosition(words);
        initialConsumer = readConsumerPosition(words);
        initialDiscard = readDiscardPosition(words);
        pcmDriver = new NodePcmDriver({
          clockUpdate: (frames) => readyKernel.pcmClockUpdate(frames),
          onConsume: ({ bytes }) => consumedChunks.push(bytes.slice()),
        });
        await pcmDriver.prepare(transport);
      },
    });
    const elapsedMs = performance.now() - start;
    const activeKernel = kernel as CentralizedKernelWorker | null;
    if (!activeKernel) throw new Error("PCM kernel hook did not run");
    const activeTransport = transport as PcmTransportDescriptor | null;
    if (!activeTransport) throw new Error("PCM transport hook did not run");
    const words = pcmControlWords(activeTransport);
    // Snapshot before the teardown helper gets any opportunity to finish an
    // orphan drain. The fixture's explicit SDL device close must itself have
    // reached the audio clock and released the OFD before process exit.
    const drainedAtExit =
      readProducerPosition(words) === readConsumerPosition(words) &&
      readDiscardPosition(words) === initialDiscard;
    const cleanTail = await activeKernel.waitForPcmDrain(1000);
    const producerBytes = Number(readProducerPosition(words) - initialProducer);
    const consumerBytes = Number(readConsumerPosition(words) - initialConsumer);
    const discardedBytes = Number(readDiscardPosition(words) - initialDiscard);
    const ioctlRequests = activeKernel
      .drainSyscallTrace()
      .filter((event) => event.nr === ABI_SYSCALLS.Ioctl)
      .map((event) => event.args[1] >>> 0);
    const total = consumedChunks.reduce(
      (sum, chunk) => sum + chunk.byteLength,
      0,
    );
    const consumed = new Uint8Array(total);
    let offset = 0;
    for (const chunk of consumedChunks) {
      consumed.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      elapsedMs,
      consumed,
      sampleRate: activeKernel.audioSampleRate(),
      channels: activeKernel.audioChannels(),
      drainedAtExit,
      cleanTail,
      producerBytes,
      consumerBytes,
      discardedBytes,
      ioctlRequests,
    };
  } finally {
    await pcmDriver?.close().catch(() => {});
    kernel?.shutdownPcmTransport();
  }
}

describe("audio integration", () => {
  beforeAll(() => ensureSdlDspFixtures(), 20 * 60_000);

  it("paces and consumes the deterministic OSS PCM fixture verbatim", async () => {
    const result = await runAudioProgram("programs/audiotest.wasm", [
      "audiotest",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "ready 44100 2",
      "wrote 256",
    ]);
    expect(result.sampleRate).toBe(44_100);
    expect(result.channels).toBe(2);
    expect(result.drainedAtExit).toBe(true);
    expect(result.cleanTail).toBe(true);
    expect(result.consumed.byteLength).toBe(256);
    expect(result.producerBytes).toBe(256);
    expect(result.consumerBytes).toBe(256);
    expect(result.discardedBytes).toBe(0);
    for (let i = 0; i < result.consumed.byteLength; i++) {
      expect(result.consumed[i]).toBe(i & 0xff);
    }
  }, 30_000);

  for (const fixture of [
    {
      relativePath: "programs/sdl-dsp-test/sdl2-dsp-test.wasm",
      argv0: "sdl2-dsp-test",
      sdlMajor: 2,
      rate: 22_050,
      format: "U8",
      channels: 1,
    },
    {
      relativePath: "programs/sdl-dsp-test/sdl3-dsp-test.wasm",
      argv0: "sdl3-dsp-test",
      sdlMajor: 3,
      rate: 48_000,
      format: "S16LE",
      channels: 2,
    },
  ]) {
    it(`runs upstream SDL${fixture.sdlMajor}'s dsp backend at real-time pace`, async () => {
      const result = await runAudioProgram(
        fixture.relativePath,
        [fixture.argv0],
        20_000,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const resultLines = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("SDL_DSP_RESULT "));
      expect(resultLines, result.stdout).toHaveLength(1);
      const report = JSON.parse(
        resultLines[0]!.slice("SDL_DSP_RESULT ".length),
      ) as {
        sdl_major: number;
        requested_rate: number;
        requested_format: string;
        requested_channels: number;
        actual_rate: number;
        actual_format: string;
        actual_channels: number;
        callbacks: number;
        frames: number;
        pcm_bytes: number;
        period_frames?: number;
        elapsed_ms: number;
        close_ms: number;
        paced: boolean;
      };

      expect(report).toMatchObject({
        sdl_major: fixture.sdlMajor,
        requested_rate: fixture.rate,
        requested_format: fixture.format,
        requested_channels: fixture.channels,
        actual_rate: fixture.rate,
        actual_format: fixture.format,
        actual_channels: fixture.channels,
        paced: true,
      });
      expect(report.callbacks).toBeGreaterThanOrEqual(2);
      expect(report.frames).toBeGreaterThan(0);
      expect(report.elapsed_ms).toBeGreaterThanOrEqual(750);
      expect(report.elapsed_ms).toBeLessThan(2500);
      expect(report.close_ms).toBeLessThan(2000);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(750);
      expect(result.elapsedMs).toBeLessThan(5000);
      expect(report.pcm_bytes).toBe(
        report.frames * (fixture.sdlMajor === 2 ? 1 : 4),
      );
      expect(result.producerBytes).toBeGreaterThan(0);
      const startupSilenceBytes =
        fixture.sdlMajor === 2 ? result.producerBytes - report.pcm_bytes : 0;
      if (fixture.sdlMajor === 2) {
        // SDL2 primes OSS playback with callback-sized silent periods before
        // it starts delivering application callback data. The count depends
        // on how many device periods elapse while its audio thread starts,
        // but each period and every following pattern byte remain exact.
        expect(report.period_frames).toBeGreaterThan(0);
        expect(startupSilenceBytes).toBeGreaterThanOrEqual(
          report.period_frames!,
        );
        expect(startupSilenceBytes % report.period_frames!).toBe(0);
        expect(startupSilenceBytes).toBeLessThanOrEqual(
          report.period_frames! * 4,
        );
        expect(result.producerBytes).toBe(
          report.pcm_bytes + startupSilenceBytes,
        );
      } else {
        // SDL3 may retain a callback-produced suffix in its AudioStream when
        // it destroys the stream; every byte that reached /dev/dsp is still
        // verified below and drained according to the transport cursors.
        expect(result.producerBytes).toBeLessThanOrEqual(report.pcm_bytes);
      }
      expect(result.consumerBytes).toBe(result.producerBytes);
      expect(result.discardedBytes).toBe(0);
      expect(result.consumed.byteLength).toBe(result.producerBytes);
      const expectedPcm = new Uint8Array(result.consumed.byteLength);
      for (let offset = 0; offset < result.consumed.byteLength; offset++) {
        if (fixture.sdlMajor === 2) {
          expectedPcm[offset] =
            offset < startupSilenceBytes
              ? 0x80
              : 32 + ((offset - startupSilenceBytes) % 192);
        } else {
          const phase = Math.floor(offset / 4) % 200;
          const sample = (phase - 100) * 240;
          const right = -sample;
          expectedPcm[offset] = [
            sample & 0xff,
            (sample >> 8) & 0xff,
            right & 0xff,
            (right >> 8) & 0xff,
          ][offset % 4]!;
        }
      }
      expect(result.consumed).toEqual(expectedPcm);
      expect(result.drainedAtExit).toBe(true);
      expect(result.cleanTail).toBe(true);
      if (fixture.sdlMajor === 3) {
        expect(result.ioctlRequests).toContain(SNDCTL_DSP_GETOSPACE);
      }
    }, 30_000);
  }

  it("paces SDL through the production dedicated Node kernel worker", async () => {
    const start = performance.now();
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/sdl-dsp-test/sdl2-dsp-test.wasm"),
      argv: ["sdl2-dsp-test"],
      env: ["SDL_AUDIODRIVER=dsp"],
      timeout: 20_000,
      useDefaultRootfs: false,
    });
    const elapsedMs = performance.now() - start;

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('\"sdl_major\":2');
    expect(result.stdout).toContain('\"paced\":true');
    expect(elapsedMs).toBeGreaterThanOrEqual(750);
    expect(elapsedMs).toBeLessThan(5000);
    expect(result.hostDiagnostics).toEqual([]);
  }, 30_000);
});
