import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const runExample = join(repoRoot, "examples", "run-example.ts");
const credentialProbe = join(repoRoot, "examples", "initial-credentials-test.wasm");

function runCredentialProbe(overrides: Record<string, string | undefined>) {
  const env = { ...process.env };
  delete env.KERNEL_UID;
  delete env.KERNEL_GID;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }

  return spawnSync(
    process.execPath,
    [
      "--experimental-wasm-exnref",
      "--import",
      "tsx/esm",
      runExample,
      credentialProbe,
    ],
    {
      cwd: repoRoot,
      // The probe only inspects credentials. Keep its guest cwd independent
      // of checkout ownership and group modes on the CI host.
      env: { ...env, KERNEL_CWD: "/tmp", TIMEOUT: "30000" },
      encoding: "utf8",
      timeout: 45_000,
    },
  );
}

describe("run-example initial credentials", () => {
  it("starts the guest with the requested real and effective IDs", () => {
    const result = runCredentialProbe({ KERNEL_UID: "1000", KERNEL_GID: "1001" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("uid=1000 euid=1000 gid=1001 egid=1001");
  });

  it("leaves an omitted credential at the kernel default", () => {
    const result = runCredentialProbe({ KERNEL_UID: "2000" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("uid=2000 euid=2000 gid=0 egid=0");
  });

  it("accepts the largest ID that is not the unchanged sentinel", () => {
    const result = runCredentialProbe({
      KERNEL_UID: "4294967294",
      KERNEL_GID: "4294967294",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "uid=4294967294 euid=4294967294 gid=4294967294 egid=4294967294",
    );
  });

  it.each(["-1", "1.5", "0x10", " 1000 ", "4294967295", "4294967296"])(
    "rejects an invalid KERNEL_UID value (%s)",
    (value) => {
      const cacheRoot = mkdtempSync(
        join(tmpdir(), "kandelo-invalid-credential-cache-"),
      );
      try {
        const result = runCredentialProbe({
          KERNEL_UID: value,
          // This deliberately disagrees with any checked-out binaries mirror.
          // Credential parsing must reject the input before package probing.
          WASM_POSIX_BINARY_CACHE_ROOT: cacheRoot,
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "KERNEL_UID must be a decimal integer from 0 to 4294967294",
        );
        expect(result.stderr).not.toContain("Package artifact closure");
      } finally {
        rmSync(cacheRoot, { recursive: true, force: true });
      }
    },
  );
});
