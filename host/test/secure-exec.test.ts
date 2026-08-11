import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { DeviceFileSystem } from "../src/vfs/device-fs";
import {
  createImmutableProductBackend,
  MemoryFileSystem,
} from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { runCentralizedProgram } from "./centralized-test-helper";

const probeBinary = tryResolveBinary("programs/secure-exec-probe.wasm");
const hasProbe = probeBinary !== null;
const SECURE_STDOUT_SENTINEL = "secure-stdout-sentinel\n";
const SECURE_STDERR_SENTINEL = "secure-stderr-sentinel\n";
const TRUSTED_ROOT_PRODUCT = {
  kind: "trusted-root-product",
  guestWritable: false,
  stableExecutableIdentity: true,
} as const;
const localeMo = new Uint8Array([
  0xde, 0x12, 0x04, 0x95, 0, 0, 0, 0,
  1, 0, 0, 0, 28, 0, 0, 0, 36, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  3, 0, 0, 0, 44, 0, 0, 0,
  3, 0, 0, 0, 48, 0, 0, 0,
  0x53, 0x75, 0x6e, 0, 0x4c, 0x6f, 0x6b, 0,
]);
const emptyCatalog = new Uint8Array([
  0xff, 0x88, 0xff, 0x89,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
]);
const testZone = new Uint8Array([
  0x54, 0x5a, 0x69, 0x66, 0x31,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0,
  0, 0, 0, 1, 0, 0, 0, 4,
  0, 0, 0x0e, 0x10, 0, 0,
  0x54, 0x53, 0x54, 0,
]);

function createProbeIo(trusted: boolean): VirtualPlatformIO {
  const bytes = new Uint8Array(readFileSync(probeBinary!));
  const root = MemoryFileSystem.create(
    new SharedArrayBuffer(Math.max(4 * 1024 * 1024, bytes.byteLength * 3)),
  );
  root.mkdir("/bin", 0o755);
  root.mkdir("/dev", 0o755);
  root.mkdir("/tmp", 0o1777);
  root.createFileWithOwner("/bin/secure-parent", 0o4755, 0, 0, bytes);
  root.createFileWithOwner("/bin/secure-child", 0o755, 0, 0, bytes);
  const tmp = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
  tmp.chmod("/", 0o1777);
  tmp.createFileWithOwner("/zz_TEST", 0o644, 1000, 1000, localeMo);
  tmp.createFileWithOwner("/secure.cat", 0o644, 1000, 1000, emptyCatalog);
  tmp.createFileWithOwner("/secure-zone", 0o644, 1000, 1000, testZone);

  return new VirtualPlatformIO([
    trusted
      ? {
          mountPoint: "/",
          backend: createImmutableProductBackend(root),
          readonly: true,
          setIdCapability: TRUSTED_ROOT_PRODUCT,
        }
      : { mountPoint: "/", backend: root },
    { mountPoint: "/dev", backend: new DeviceFileSystem() },
    { mountPoint: "/tmp", backend: tmp },
  ], new NodeTimeProvider());
}

async function launch(
  trusted: boolean,
  mode: "target" | "stdio-target" | "spawn-parent",
  secure: boolean,
  maskOrReset: number,
) {
  return runCentralizedProgram({
    programPath: probeBinary!,
    argv: [
      "secure-exec-probe",
      "launch",
      "/bin/secure-parent",
      mode,
      secure ? "1" : "0",
      String(maskOrReset),
    ],
    env: ["KANDELO_UNTRUSTED=visible-only-outside-secure-startup"],
    uid: 1000,
    gid: 1000,
    io: createProbeIo(trusted),
    execPrograms: new Map([["/bin/secure-child", probeBinary!]]),
    timeout: 20_000,
  });
}

describe.skipIf(!hasProbe)("secure exec startup", () => {
  it("keeps constructor dispatch out of the linker-synthesized entry prefix", () => {
    const disassembly = execFileSync(
      "wasm-objdump",
      ["-d", probeBinary!],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    const startOffset = disassembly.search(/func\[\d+\] <_start>:/);
    const nextFunctionOffset = disassembly.indexOf(" func[", startOffset + 1);
    const startBody = disassembly.slice(
      startOffset,
      nextFunctionOffset < 0 ? undefined : nextFunctionOffset,
    );
    const argcCall = startBody.indexOf("<kernel.kernel_get_argc>");
    const secureCall = startBody.indexOf("<kernel.kernel_get_secure_exec>");
    const constructorDispatch = startBody.indexOf("call_indirect");

    expect(startOffset).toBeGreaterThanOrEqual(0);
    expect(argcCall).toBeGreaterThanOrEqual(0);
    expect(secureCall).toBeGreaterThan(argcCall);
    expect(constructorDispatch).toBeGreaterThan(secureCall);
  });

  it("keeps an ordinary image outside secure startup", async () => {
    const result = await runCentralizedProgram({
      programPath: probeBinary!,
      argv: ["secure-exec-probe", "target", "0", "0"],
      env: ["KANDELO_UNTRUSTED=visible-only-outside-secure-startup"],
      io: createProbeIo(false),
      uid: 1000,
      gid: 1000,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1",
    );
    expect(result.stdout).toContain(
      "locale=Lok timezone=TST catalog=loaded fds=ok",
    );
  });

  it("carries the ordinary marker through the production Node worker host", async () => {
    const result = await runCentralizedProgram({
      programPath: probeBinary!,
      argv: ["secure-exec-probe", "startup-target", "0", "0"],
      env: ["KANDELO_UNTRUSTED=visible-only-outside-secure-startup"],
      uid: 1000,
      gid: 1000,
      useDefaultRootfs: false,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1",
    );
  });

  it("enters secure startup only for a trusted set-ID exec", async () => {
    const result = await launch(true, "target", true, 0);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "secure=1 ctor_secure=1 untrusted_visible=0 ctor_visible=0",
    );
    expect(result.stdout).toContain(
      "locale=Sun timezone=UTC catalog=blocked fds=ok",
    );
  });

  it("does not enter secure startup for a nosuid set-ID file", async () => {
    const result = await launch(false, "target", false, 0);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1",
    );
  });

  it.each([
    [0, "preserves", true],
    [1, "resets", false],
  ] as const)(
    "%s: posix_spawn %s IDs before exact secure-state commit",
    async (resetIds, _verb, expectedSecure) => {
      const result = await launch(true, "spawn-parent", true, resetIds);
      expect(result.exitCode).toBe(0);
      if (expectedSecure) {
        expect(result.stdout).toContain(
          "secure=1 ctor_secure=1 untrusted_visible=0 ctor_visible=0",
        );
      } else {
        expect(result.stdout).toContain(
          "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1",
        );
      }
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "repairs secure standard descriptors for closed mask %i",
    async (mask) => {
      const result = await launch(true, "stdio-target", true, mask);
      expect(result.exitCode).toBe(0);
      if (mask & 2) {
        expect(result.stdout).not.toContain(SECURE_STDOUT_SENTINEL);
      } else {
        expect(result.stdout).toContain(SECURE_STDOUT_SENTINEL);
      }
      if (mask & 4) {
        expect(result.stderr).not.toContain(SECURE_STDERR_SENTINEL);
      } else {
        expect(result.stderr).toContain(SECURE_STDERR_SENTINEL);
      }
    },
  );

  it("does not repair closed standard descriptors for an ordinary image", async () => {
    const result = await launch(false, "stdio-target", false, 1);
    expect(result.exitCode).toBe(40);
  });

  it("exits 127 when secure standard-descriptor repair cannot allocate a descriptor", async () => {
    const result = await runCentralizedProgram({
      programPath: probeBinary!,
      argv: [
        "secure-exec-probe",
        "launch-nofile",
        "/bin/secure-parent",
        "stdio-target",
        "1",
        "1",
      ],
      env: ["KANDELO_UNTRUSTED=visible-only-outside-secure-startup"],
      uid: 1000,
      gid: 1000,
      io: createProbeIo(true),
      execPrograms: new Map([["/bin/secure-child", probeBinary!]]),
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(127);
  });
});
