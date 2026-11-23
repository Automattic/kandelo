import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSourceOnlyBinarySnapshotSession, resolveBinary } from "../../src/binary-resolver";
import { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload } from "../../src/constants";

const archivePath = "programs/wasm32/go.zip";
export const goGuestLazyBase = "https://kandelo.invalid/";
export const goGuestArchiveUrl = new URL(`assets/${archivePath}`, goGuestLazyBase).href;
export const goGuestOutputPath = "/tmp/hello.wasm";
export const goGuestOutput = "Hello, Kandelo\n";
export const goGuestShellOptions = {
  cwd: "/home/maker",
  uid: 1000,
  gid: 1000,
  env: [
    "PATH=/usr/bin:/bin", "HOME=/home/maker", "TMPDIR=/tmp",
    "GOTOOLCHAIN=local", "GOPROXY=off", "GOSUMDB=off", "GOENV=off",
    "CGO_ENABLED=0", "GOCACHE=/tmp/go-cache", "GOMODCACHE=/tmp/go-modcache",
  ],
};

export function goGuestShellCommand(): string {
  const fixture = new URL("../../../tests/go/hello/", import.meta.url);
  const inputs = ["go.mod", "main.go"].map((file) => {
    const source = readFileSync(new URL(file, fixture), "utf8");
    return `printf '%s' '${source.replaceAll("'", "'\\''")}' > ${file}`;
  });
  return [...inputs, "go telemetry off", `go build -x -p 1 -trimpath -o ${goGuestOutputPath} .`,
    goGuestOutputPath].join("\n");
}

export function goGuestArtifacts() {
  const shellImage = process.env.KANDELO_GO_GUEST_SHELL_IMAGE;
  const toolchainArchive = process.env.KANDELO_GO_GUEST_TOOLCHAIN_ARCHIVE;
  const session = process.env.WASM_POSIX_RESOLUTION_POLICY === "source-only-v1"
    ? createSourceOnlyBinarySnapshotSession() : undefined;
  const current = (path: string) => {
    if (!session) return new Uint8Array(readFileSync(resolveBinary(path)));
    const artifact = session.snapshots([path], 512 * 1024 * 1024)[0];
    if (!artifact) throw new Error(`Missing ${path}; build the shell with Go tools first`);
    return artifact.bytes;
  };
  const kernel = current("kernel.wasm");
  const shell = shellImage
    ? new Uint8Array(readFileSync(shellImage)) : current("programs/wasm32/shell.vfs.zst");
  const bytes = toolchainArchive
    ? new Uint8Array(readFileSync(toolchainArchive)) : current(archivePath);
  return {
    kernel, shell,
    archive: {
      url: goGuestArchiveUrl,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      bytes,
    },
  };
}

export function goGuestAbiDigest(wasm: Uint8Array): Uint8Array | null {
  return readWasmCustomSectionPayload(wasm.slice().buffer as ArrayBuffer, ABI_CONTRACT_SECTION);
}
