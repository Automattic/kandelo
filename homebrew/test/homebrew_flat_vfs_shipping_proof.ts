import { ABI_VERSION } from "../../host/src/generated/abi";
import type { LazyDownloadEvent } from "../../host/src/vfs/memory-fs";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import {
  assertHomebrewGuestLifecycleRevisions,
  createHomebrewGuestShippingProofScript,
  HOMEBREW_GUEST_CORE_SHIPPING_PROOF_MARKER,
} from "./homebrew_guest_lifecycle_contract";
import {
  assertHomebrewGuestLifecycleDeadline,
  destroyHomebrewGuestLifecycleMachineBeforeDeadline,
  type HomebrewGuestLifecycleMachine,
  runHomebrewGuestLifecycleOperationBeforeDeadline,
  runHomebrewGuestLifecycleScriptBeforeDeadline,
} from "./homebrew_guest_lifecycle_runner";
import type {
  HomebrewGuestLifecycleMachineRuntimeInputs,
} from "./homebrew_guest_lifecycle_runtime_inputs";
import {
  assertNoUnexpectedHostDiagnostics,
  resolveHomebrewGuestLifecycleShell,
} from "./homebrew_guest_lifecycle_runtime_contract";

export const HOMEBREW_FLAT_VFS_BREW_VERSION_MARKER =
  "KANDELO_HOMEBREW_FLAT_VFS_BREW_VERSION_OK";

const EMBEDDED_LAZY_URL_BASE =
  "https://embedded-homebrew.kandelo.invalid/flat-vfs/";
const COMPOSITION_REPORT_PATH = "/etc/kandelo/homebrew-vfs.json";
const BREW_ENVIRONMENT_PATH = "/etc/homebrew/brew.env";
const BREW_LINK_PATH = "/usr/bin/brew";
const BREW_EXECUTABLE_PATH = "/opt/kandelo/homebrew/bin/brew";
const BOOTSTRAP_FORMULA = "kandelo-dev/tap-core/homebrew-bootstrap";
const BZIP2_FORMULA = "kandelo-dev/tap-core/bzip2";
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_REPORT_BYTES = 1024 * 1024;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xa000;

export interface HomebrewFlatVfsEmbeddedRuntimeInput {
  imageBytes: Uint8Array;
  shellPath: string;
  shellArgv0: string;
  takeImageOwnership?: boolean;
}

export interface ValidatedHomebrewFlatVfsEmbeddedRuntime
  extends HomebrewFlatVfsEmbeddedRuntimeInput {
  kandeloAbi: number;
  selectionSha256: string;
}

export interface HomebrewFlatVfsShippingProofResult {
  tapRevision: string;
  kandeloAbi: number;
  selectionSha256: string;
  lazyDownloads: readonly LazyDownloadEvent[];
}

/**
 * Validate the exact serialized runtime consumed by both host adapters.
 * The flat image owns Homebrew, its shell, and its composition report; no
 * bootstrap or bottle tree may remain available as a hidden fallback.
 */
export function validateHomebrewFlatVfsEmbeddedRuntime(
  input: HomebrewFlatVfsEmbeddedRuntimeInput,
): ValidatedHomebrewFlatVfsEmbeddedRuntime {
  if (
    !(input.imageBytes instanceof Uint8Array) ||
    input.imageBytes.byteLength === 0
  ) {
    throw new Error("flat Homebrew VFS image bytes are empty or invalid");
  }
  const imageMetadata = MemoryFileSystem.readImageMetadata(input.imageBytes);
  if (imageMetadata?.kernelAbi === undefined) {
    throw new Error(
      `flat Homebrew VFS shipping-proof image must declare kernel ABI ${ABI_VERSION}`,
    );
  }
  MemoryFileSystem.assertImageKernelAbi(
    input.imageBytes,
    ABI_VERSION,
    "flat Homebrew VFS shipping-proof image",
  );
  const fs = MemoryFileSystem.fromImage(input.imageBytes);
  const shell = resolveHomebrewGuestLifecycleShell(fs);
  if (shell.path !== input.shellPath || shell.argv0 !== input.shellArgv0) {
    throw new Error(
      `flat Homebrew VFS shell is ${shell.path} (${shell.argv0}), expected ` +
        `${input.shellPath} (${input.shellArgv0})`,
    );
  }

  assertEmbeddedBrew(fs);
  const report = parseFlatCompositionReport(
    readBoundedRegularFile(fs, COMPOSITION_REPORT_PATH, MAX_REPORT_BYTES),
  );
  return {
    imageBytes: input.imageBytes,
    shellPath: input.shellPath,
    shellArgv0: input.shellArgv0,
    ...(input.takeImageOwnership === true
      ? { takeImageOwnership: true }
      : {}),
    kandeloAbi: ABI_VERSION,
    selectionSha256: report.selectionSha256,
  };
}

/** Run the same fully embedded stock-Homebrew proof on either host adapter. */
export async function runHomebrewFlatVfsShippingProof(options: {
  runtime: HomebrewFlatVfsEmbeddedRuntimeInput;
  tapRevision: string;
  deadlineMs: number;
  createMachine: (
    runtime: HomebrewGuestLifecycleMachineRuntimeInputs,
  ) => HomebrewGuestLifecycleMachine;
}): Promise<HomebrewFlatVfsShippingProofResult> {
  assertHomebrewGuestLifecycleDeadline(options.deadlineMs);
  assertHomebrewGuestLifecycleRevisions({
    coreRevision: options.tapRevision,
    canaryRevision: options.tapRevision,
  });
  const runtime = validateHomebrewFlatVfsEmbeddedRuntime(options.runtime);
  const machineRuntime: HomebrewGuestLifecycleMachineRuntimeInputs = {
    imageBytes: runtime.imageBytes,
    lazyUrlBase: EMBEDDED_LAZY_URL_BASE,
    ...(runtime.takeImageOwnership === true
      ? { takeImageOwnership: true }
      : {}),
  };
  const machine = options.createMachine(machineRuntime);
  let succeeded = false;
  try {
    await runHomebrewGuestLifecycleOperationBeforeDeadline(
      options.deadlineMs,
      "flat Homebrew VFS shipping proof machine start",
      () => machine.start(),
      machine.failureContext,
    );
    assertNoLazyDownload(machine.lazyDownloads, "machine start");
    await runHomebrewGuestLifecycleScriptBeforeDeadline(
      machine,
      options.deadlineMs,
      {
        shellPath: runtime.shellPath,
        shellArgv0: runtime.shellArgv0,
        script: createBrewVersionScript(),
        marker: HOMEBREW_FLAT_VFS_BREW_VERSION_MARKER,
        label: "embedded stock Homebrew version proof",
      },
    );
    assertNoLazyDownload(machine.lazyDownloads, "brew --version");
    await runHomebrewGuestLifecycleScriptBeforeDeadline(
      machine,
      options.deadlineMs,
      {
        shellPath: runtime.shellPath,
        shellArgv0: runtime.shellArgv0,
        // The core scope never reads canaryRevision. Supplying the same exact
        // core SHA satisfies the existing shared script API without creating
        // a second revision or a second guest contract for the flat lane.
        script: createHomebrewGuestShippingProofScript(
          {
            coreRevision: options.tapRevision,
            canaryRevision: options.tapRevision,
          },
          "core",
        ),
        marker: HOMEBREW_GUEST_CORE_SHIPPING_PROOF_MARKER,
        label: "embedded stock Homebrew core bottle shipping proof",
      },
    );
    assertNoLazyDownload(machine.lazyDownloads, "core bottle shipping proof");
    succeeded = true;
  } finally {
    const destroy = destroyHomebrewGuestLifecycleMachineBeforeDeadline(
      machine,
      options.deadlineMs,
    );
    if (succeeded) await destroy;
    else await destroy.catch(() => {});
    assertNoUnexpectedHostDiagnostics(
      machine.diagnostics,
      "embedded stock Homebrew shipping proof host",
    );
    assertNoLazyDownload(machine.lazyDownloads, "complete shipping proof");
  }
  return {
    tapRevision: options.tapRevision,
    kandeloAbi: runtime.kandeloAbi,
    selectionSha256: runtime.selectionSha256,
    lazyDownloads: [...machine.lazyDownloads],
  };
}

function createBrewVersionScript(): string {
  return `set -eu\n` +
    `brew_version="$(/usr/bin/brew --version)"\n` +
    `[ -n "$brew_version" ] || { echo "brew --version was empty" >&2; exit 1; }\n` +
    `printf '%s\\n' '${HOMEBREW_FLAT_VFS_BREW_VERSION_MARKER}'\n`;
}

function assertNoLazyDownload(
  events: readonly LazyDownloadEvent[],
  label: string,
): void {
  if (events.length !== 0) {
    throw new Error(
      `embedded Homebrew ${label} unexpectedly fetched ${events[0]!.url}`,
    );
  }
}

function assertEmbeddedBrew(fs: MemoryFileSystem): void {
  const link = fs.lstat(BREW_LINK_PATH);
  if (
    (link.mode & S_IFMT) !== S_IFLNK ||
    fs.readlink(BREW_LINK_PATH) !== BREW_EXECUTABLE_PATH
  ) {
    throw new Error(
      `${BREW_LINK_PATH} must be a symlink to ${BREW_EXECUTABLE_PATH}`,
    );
  }
  const executable = fs.stat(BREW_EXECUTABLE_PATH);
  if (
    (executable.mode & S_IFMT) !== S_IFREG ||
    (executable.mode & 0o111) === 0 ||
    fs.isPathDeferred(BREW_EXECUTABLE_PATH)
  ) {
    throw new Error(
      `${BREW_EXECUTABLE_PATH} is not image-owned and executable`,
    );
  }
  readBoundedRegularFile(fs, BREW_ENVIRONMENT_PATH, 64 * 1024);
}

function parseFlatCompositionReport(bytes: Uint8Array): {
  selectionSha256: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`flat Homebrew VFS report is invalid JSON: ${String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("flat Homebrew VFS report must be an object");
  }
  const report = value as Record<string, unknown>;
  if (
    report.schema !== 1 ||
    report.arch !== "wasm32" ||
    report.kandelo_abi !== ABI_VERSION ||
    report.resource_policy !== "kandelo-homebrew-vfs-generous-v1" ||
    report.link_policy !== "kandelo-homebrew-link-ownership-v1" ||
    report.runtime_support !== "kandelo-homebrew-bootstrap-v1" ||
    typeof report.selection_sha256 !== "string" ||
    !SHA256_RE.test(report.selection_sha256)
  ) {
    throw new Error("flat Homebrew VFS report identity is invalid");
  }
  if (!Array.isArray(report.packages)) {
    throw new Error("flat Homebrew VFS report packages are invalid");
  }
  const fullNames = report.packages.map((pkg) =>
    pkg !== null && typeof pkg === "object" && !Array.isArray(pkg)
      ? (pkg as Record<string, unknown>).full_name
      : undefined
  );
  for (const formula of [BOOTSTRAP_FORMULA, BZIP2_FORMULA]) {
    if (fullNames.filter((fullName) => fullName === formula).length !== 1) {
      throw new Error(
        `flat Homebrew VFS report must select ${formula} exactly once`,
      );
    }
  }
  return { selectionSha256: report.selection_sha256 };
}

function readBoundedRegularFile(
  fs: MemoryFileSystem,
  path: string,
  maximumBytes: number,
): Uint8Array {
  const stat = fs.stat(path);
  if (
    (stat.mode & S_IFMT) !== S_IFREG ||
    stat.size < 1 ||
    stat.size > maximumBytes ||
    fs.isPathDeferred(path)
  ) {
    throw new Error(`${path} is not a bounded image-owned regular file`);
  }
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (read <= 0) throw new Error(`${path} ended after ${offset} bytes`);
      offset += read;
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}
