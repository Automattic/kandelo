import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NodeKernelHost } from "../../host/src/node-kernel-host";
import {
  HOMEBREW_BOOTSTRAP_GUEST,
  HOMEBREW_BOOTSTRAP_GUEST_ENV,
} from "../../scripts/homebrew-bootstrap-guest-contract";

const PINNED_HOMEBREW_REVISION = "4ead8619231cb15cbe15e8e8188081e347d6f7cd";
const PROVEN_TAP_REVISION = "e7cfe3140e692965cd7abf10e8029633c5d20c02";
const SUCCESS_MARKER = "KANDELO_NATIVE_REQUIREMENT_GUEST_OK";

interface Options {
  image: string;
  bash: string;
  kernel: string;
  timeoutMs: number;
}

function usage(): never {
  throw new Error(
    "usage: homebrew_native_requirement_guest_node.ts " +
      "--image <vfs> --kernel <wasm> --bash <wasm> [--timeout-ms <N>]",
  );
}

function parseOptions(args: string[]): Options {
  const options = new Map<string, string>();
  const allowed = new Set(["image", "kernel", "bash", "timeout-ms"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.has(name) || options.has(name) || value === undefined) usage();
    options.set(name, value);
  }
  const image = options.get("image");
  const kernel = options.get("kernel");
  const bash = options.get("bash");
  const timeoutMs = Number(options.get("timeout-ms") ?? "600000");
  if (!image || !kernel || !bash || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) usage();
  return { image: resolve(image), kernel: resolve(kernel), bash: resolve(bash), timeoutMs };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function guestProofScript(): string {
  return String.raw`
set -euo pipefail
fail() { printf 'homebrew-native-requirement: %s\n' "$*" >&2; exit 1; }

/usr/bin/ruby -rjson -e '
  metadata = JSON.parse(File.binread("/etc/kandelo/homebrew-image.json"))
  abort "wrong pinned Homebrew revision" unless metadata.fetch("homebrew_revision") ==
    "${PINNED_HOMEBREW_REVISION}"
'

brew_repository="$(/usr/bin/brew --repository)"
installer="$brew_repository/Library/Homebrew/formula_installer.rb"
installer_before="$(/usr/bin/sha256sum "$installer" | /usr/bin/cut -d " " -f 1)"
core="$brew_repository/Library/Taps/homebrew/homebrew-core"
[ ! -e "$core" ] || fail "homebrew/core existed before the proof"

/usr/bin/brew tap kandelo-dev/tap-core
tap="$(/usr/bin/brew --repository kandelo-dev/tap-core)"
/usr/bin/git -C "$tap" checkout --detach ${PROVEN_TAP_REVISION}
[ "$(/usr/bin/git -C "$tap" rev-parse HEAD)" = "${PROVEN_TAP_REVISION}" ] ||
  fail "tap did not select the proven revision"
[ ! -e "$core" ] || fail "tapping the custom tap created homebrew/core"

support="$tap/Kandelo/formula_support/kandelo_formula_support.rb"
/usr/bin/cat >>"$support" <<'RUBY'

# Proof-only tap fixture. The production shape is statically validated by
# scripts/homebrew-formula-runtime-closure.rb before publisher execution.
module KandeloFormulaSupport
  class BinaryenRequirement < Requirement
    fatal true
    satisfy(build_env: false) { which("wasm-opt") }
  end

  class PkgconfRequirement < Requirement
    fatal true
    satisfy(build_env: false) { which("pkg-config") }
  end

  class WabtRequirement < Requirement
    fatal true
    satisfy(build_env: false) { which("wasm-validate") }
  end
end
RUBY

formula="$tap/Formula/bzip2.rb"
/usr/bin/sed -i 's/  depends_on "binaryen" => :build/  depends_on KandeloFormulaSupport::BinaryenRequirement => :build/' "$formula"
/usr/bin/sed -i 's/  depends_on "wabt" => :build/  depends_on KandeloFormulaSupport::WabtRequirement => :build/' "$formula"
/usr/bin/sed -i 's/  depends_on "pkgconf" => :test/  depends_on KandeloFormulaSupport::PkgconfRequirement => [:build, :test]/' "$formula"
/usr/bin/grep -F 'depends_on KandeloFormulaSupport::BinaryenRequirement => :build' "$formula" >/dev/null
/usr/bin/grep -F 'depends_on KandeloFormulaSupport::PkgconfRequirement => [:build, :test]' "$formula" >/dev/null
/usr/bin/grep -F 'depends_on KandeloFormulaSupport::WabtRequirement => :build' "$formula" >/dev/null

# No dependency bypass, synthetic core tree, API metadata, or patched installer
# participates in this transaction.
/usr/bin/brew install --no-ask --force-bottle kandelo-dev/tap-core/bzip2

[ ! -e "$core" ] || fail "force-bottle install created homebrew/core"
installer_after="$(/usr/bin/sha256sum "$installer" | /usr/bin/cut -d " " -f 1)"
[ "$installer_after" = "$installer_before" ] || fail "stock FormulaInstaller changed"

prefix="$(/usr/bin/brew --prefix kandelo-dev/tap-core/bzip2)"
receipt="$prefix/INSTALL_RECEIPT.json"
/usr/bin/ruby -rjson -e '
  receipt = JSON.parse(File.binread(ARGV.fetch(0)))
  abort "bottle was not poured" unless receipt.fetch("poured_from_bottle") == true
  abort "unexpected runtime dependency" unless receipt.fetch("runtime_dependencies", []).empty?
' "$receipt"

roundtrip=/tmp/kandelo-native-requirement-roundtrip
/usr/bin/printf 'native Requirement bottle round trip\n' >"$roundtrip.input"
"$prefix/bin/bzip2" -c "$roundtrip.input" >"$roundtrip.bz2"
"$prefix/bin/bzip2" -dc "$roundtrip.bz2" >"$roundtrip.output"
/usr/bin/ruby -e '
  abort "Bzip2 round trip differs" unless File.binread(ARGV.fetch(0)) == File.binread(ARGV.fetch(1))
' "$roundtrip.input" "$roundtrip.output"
/usr/bin/rm -f "$roundtrip.input" "$roundtrip.bz2" "$roundtrip.output"

/usr/bin/printf '%s\n' ${SUCCESS_MARKER}
`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const image = new Uint8Array(readFileSync(options.image));
  const kernel = new Uint8Array(readFileSync(options.kernel));
  const bash = new Uint8Array(readFileSync(options.bash));
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  let pid: number | undefined;
  const hostDiagnostics: string[] = [];

  const host = new NodeKernelHost({
    rootfsImage: toArrayBuffer(image),
    enableTcpNetwork: true,
    dataBufferSize: 1 << 20,
    onStdout: (_pid, bytes) => {
      stdout += decoder.decode(bytes, { stream: true });
    },
    onStderr: (_pid, bytes) => {
      stderr += decoder.decode(bytes, { stream: true });
    },
    onHostDiagnostic: (diagnostic) => {
      hostDiagnostics.push(diagnostic.message);
    },
  });

  await host.init(toArrayBuffer(kernel));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitPromise = host.spawn(
      toArrayBuffer(bash),
      ["/bin/bash", "-c", guestProofScript()],
      {
        env: [...HOMEBREW_BOOTSTRAP_GUEST_ENV],
        cwd: HOMEBREW_BOOTSTRAP_GUEST.cwd,
        uid: HOMEBREW_BOOTSTRAP_GUEST.uid,
        gid: HOMEBREW_BOOTSTRAP_GUEST.gid,
        onStarted: (startedPid) => {
          pid = startedPid;
        },
      },
    );
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`native Requirement proof timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    });
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);
    if (exitCode !== 0) {
      throw new Error(
        `native Requirement proof exited ${exitCode}; stdout=${JSON.stringify(stdout)}; ` +
          `stderr=${JSON.stringify(stderr)}; diagnostics=${JSON.stringify(hostDiagnostics)}`,
      );
    }
  } catch (error) {
    if (pid !== undefined) await host.terminateProcess(pid, 124).catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    await host.destroy().catch(() => {});
  }

  if (!stdout.split(/\r?\n/).includes(SUCCESS_MARKER)) {
    throw new Error(
      `native Requirement proof marker is missing; stdout=${JSON.stringify(stdout)}; ` +
        `stderr=${JSON.stringify(stderr)}`,
    );
  }
  const reserveFailure = hostDiagnostics.find((message) =>
    message.includes("(FORK_SAVE_BUFFER_SIZE) are reserved"),
  );
  if (reserveFailure) throw new Error(`native Requirement proof hit fork reserve: ${reserveFailure}`);
  process.stdout.write("homebrew_native_requirement_guest_node: pass\n");
}

await main();
