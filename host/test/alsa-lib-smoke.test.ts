import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const programBinary = tryResolveBinary("programs/alsa_lib_smoke.wasm");

describe("alsa-lib subset (PCM-hw-direct)", () => {
  it.skipIf(!programBinary)(
    "snd_pcm_open(default) → hw_params + status round-trip succeeds",
    async () => {
      const result = await runCentralizedProgram({
        programPath: programBinary!,
        argv: ["alsa_lib_smoke"],
        timeout: 10_000,
      });
      expect(
        result.exitCode,
        `stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      // STATUS line proves the wasm32 WpkAlsaPcmStatus layout
      // round-trips against alsa-lib's userspace decoders.
      // SND_PCM_STATE_PREPARED=2 (snd_pcm_hw_params calls snd_pcm_prepare).
      expect(result.stdout).toContain("STATUS state=2");
      expect(result.stdout).toContain("OK rate=48000");
      expect(result.stderr).not.toContain("FAIL:");
    },
  );
});
