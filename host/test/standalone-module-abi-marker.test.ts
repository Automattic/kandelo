// The host's own Wasm modules declare the kernel ABI epoch they were built for.
//
// The binary resolver judges every `.wasm` it resolves against
// `expectedAbi: ABI_VERSION`, and the kernel worker resolves the fork module,
// the dynamic-linking planner and the WASI module on every process launch.
// None of the three exported `__abi_version`, so every launch of every program
// -- `php -r 'echo 1;'` included -- printed
//
//     [worker] artifact lacks an __abi_version export — legacy binary predates
//     the ABI marker rollout. Rebuild against the current glue ...
//
// That message was false twice over: the modules are not legacy, and no rebuild
// could have added the marker. Worse, the epoch check could never refuse a
// module staged for a different epoch, although all three are compiled from
// `crates/shared` and change under it. Each now exports the constant.
//
// These assertions read the artifacts the host actually loads, resolved the
// way `node-kernel-worker-entry` resolves them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveBinary } from "../src/binary-resolver";
import { extractAbiVersion } from "../src/constants";
import { ABI_VERSION } from "../src/generated/abi";
import { describeWasmArtifactPolicy } from "../src/wasm-artifact-driver";

const RESOLVER_JUDGED_HOST_MODULES = [
  "fork_module32.wasm",
  "fork_module64.wasm",
  "dylink_module32.wasm",
  "wasi_module32.wasm",
] as const;

function bytesOf(relPath: string): ArrayBuffer {
  // `resolveBinary` throws, naming the build, when the module is missing. A
  // missing module is a failure here, not a skip: `./run.sh setup` builds all
  // four, and a pass that ran nothing would prove nothing.
  const buf = readFileSync(resolveBinary(relPath));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("host Wasm modules declare their ABI epoch", () => {
  for (const relPath of RESOLVER_JUDGED_HOST_MODULES) {
    it(`${relPath} exports __abi_version = ABI_VERSION`, () => {
      const bytes = bytesOf(relPath);
      expect(extractAbiVersion(bytes)).toBe(ABI_VERSION);

      // The resolver's own question, asked directly so the once-per-realm
      // de-duplication in `describeWasmArtifactPolicyFailures` cannot hide it.
      const report = describeWasmArtifactPolicy(bytes, {
        expectedAbi: ABI_VERSION,
      });
      expect(report.failures).toEqual([]);
      expect(report.warnings).toEqual([]);
    });

    it(`${relPath} is refused, by epoch, under a different kernel ABI`, () => {
      const report = describeWasmArtifactPolicy(bytesOf(relPath), {
        expectedAbi: ABI_VERSION + 1,
      });
      expect(report.failures).toContain(
        `ABI ${ABI_VERSION}, expected ${ABI_VERSION + 1}`,
      );
    });
  }
});
