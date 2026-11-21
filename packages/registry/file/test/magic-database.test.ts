import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { readWasmCustomSectionPayload } from "../../../../host/src/constants";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const fileBinary = tryResolveBinary("programs/file/file.wasm");
const dashBinary = tryResolveBinary("programs/dash.wasm");
const coreutilsBinary = tryResolveBinary("programs/coreutils.wasm");

// libmagic seals a loaded compiled database (.mgc) with mprotect(PROT_READ)
// and refuses the database if that fails, so file declares the mprotect
// fiction for read-only requests (package.toml).
const READ_ONLY_SEAL =
  "mprotect:prot_none=enotsup,prot_none_max=0,read_only=accept-unenforced,read_only_max=0\n";

// Compile a one-entry text database inside Kandelo, then identify a file
// with only the compiled database. src.magic.mgc is binary, so libmagic's
// fallback to parsing the -m argument as text cannot produce the match:
// the description comes from the mapped and sealed database or not at all.
// dd reads the kernel log without blocking and stops at EAGAIN.
const SCRIPT = `
set -e
cd /tmp
printf '0\\tstring\\tKANDELO-TEST\\tKandelo magic test data\\n' > src.magic
printf 'KANDELO-TEST payload\\n' > sample
file -C -m src.magic
echo "RESULT $(file -b -m /tmp/src.magic.mgc sample)"
set +e
kmsg=$(dd if=/dev/kmsg iflag=nonblock bs=8192 count=256 2>/dev/null)
case "$kmsg" in
  *"PROT_READ) succeeded but is not enforced"*) echo "KMSG read-only seal logged" ;;
  *) echo "KMSG none" ;;
esac
`;

describe.skipIf(!fileBinary)("file compiled magic databases", () => {
  it("records the declared mprotect fiction in file.wasm", () => {
    const bytes = readFileSync(fileBinary!);
    const payload = readWasmCustomSectionPayload(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      "kandelo.fictions",
    );
    expect(payload && new TextDecoder().decode(payload)).toBe(READ_ONLY_SEAL);
  });

  it.skipIf(!dashBinary || !coreutilsBinary)(
    "compiles a database and identifies a file with it",
    async () => {
      const execPrograms = new Map<string, string>([
        ["/usr/bin/file", fileBinary!],
      ]);
      execPrograms.set("/bin/dd", coreutilsBinary!);
      const result = await runCentralizedProgram({
        programPath: dashBinary!,
        argv: ["dash", "-c", SCRIPT],
        env: ["PATH=/usr/bin:/bin", "HOME=/tmp"],
        execPrograms,
        useDefaultRootfs: false,
        timeout: 60_000,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "RESULT Kandelo magic test data",
        "KMSG read-only seal logged",
      ]);
    },
    90_000,
  );
});
