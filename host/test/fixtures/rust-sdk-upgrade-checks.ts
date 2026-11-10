import type { NodeKernelHost } from "../../src/node-kernel-host";
import { rustCompilerEnv } from "./rust-guest-env";
import { readRustCompilerJob } from "./rust-guest-job";

type Host = Pick<
  NodeKernelHost,
  "spawnFromVfs" | "readOwnedJob" | "releaseOwnedJob"
>;
export type UpgradeResult = {
  phase: string;
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** Identical commands and assertions on Node and each browser host. */
export async function checkRustSdkUpgrade(
  getHost: () => Host,
  reboot: () => Promise<void>,
  driverSize: number,
  identity: string,
) {
  const results: UpgradeResult[] = [];
  let sequence = 0;
  const require = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`${message}\n${JSON.stringify(results)}`);
  };
  async function run(
    phase: string,
    path: string,
    argv: string[],
    root = false,
    timeoutMs = 600_000,
  ) {
    console.info("[Rust SDK upgrade]", phase, argv.join(" "));
    const host = getHost();
    const id = `sdk-upgrade-${++sequence}`;
    const command = await host.spawnFromVfs(path, argv, {
      uid: root ? 0 : 1000,
      gid: root ? 0 : 1000,
      cwd: "/home/maker/project/sdk-upgrade",
      env: [...rustCompilerEnv, "CARGO_HOME=/home/maker/.cargo"],
      // Unzip asks whether to continue after a write error. Refuse promptly
      // so storage errors remain visible instead of becoming deadline failures.
      stdin: new TextEncoder().encode("n\n"),
      ownedJob: { id, timeoutMs },
    });
    void command.exit.catch(() => {});
    const result = await readRustCompilerJob(host, id, timeoutMs + 30_000);
    results.push({ phase, ...result });
    console.info("[Rust SDK upgrade]", phase, result);
    require(result.exitCode === 0, `${phase} failed`);
    return result;
  }
  const cargo = (phase: string, ...args: string[]) =>
    run(phase, "/usr/bin/cargo", ["cargo", ...args]);
  const probe = (phase: string) =>
    cargo(phase, "run", "--offline", "-j1", "-v", "--bin", "sdk-upgrade-probe");
  const fresh = (result: UpgradeResult) => {
    require(!result.stderr.includes(
      "Compiling",
    ), `${result.phase} unexpectedly recompiled`);
    require(/Fresh sdk-upgrade-probe/.test(result.stderr) &&
      /Fresh upgrade-helper/.test(
        result.stderr,
      ), `${result.phase} omitted Fresh evidence`);
  };
  await cargo(
    "build-old-installer",
    "build",
    "--offline",
    "-j1",
    "--bin",
    "sdk-installer",
  );
  const installer =
    "/home/maker/project/sdk-upgrade/target/debug/sdk-installer.wasm";
  await run(
    "pad-old-driver",
    installer,
    [installer, "pad", String(driverSize)],
    true,
  );
  const oldVersion = await run("old-version", "/usr/bin/rustc", [
    "rustc",
    "-vV",
  ]);
  require(!oldVersion.stdout.includes(
    "kandelo-sdk:",
  ), "historical SDK must predate component identity");
  const old = await probe("old-backtrace");
  require(old.stdout.includes("backtrace-status: Unsupported") &&
    old.stdout.includes(
      "built-sdk: legacy",
    ), "old SDK baseline did not execute its original std and build script");
  fresh(await probe("old-fresh"));
  // The complete SDK expands to roughly 900 MiB. Bound the installation
  // independently of small compiler probes so staging and replacement can
  // finish on slower persistent storage.
  await run("install-real-sdk", installer, [installer, "install"], true, 900_000);
  const version = await run("new-version", "/usr/bin/rustc", ["rustc", "-vV"]);
  require(version.stdout ===
    oldVersion.stdout +
      `kandelo-sdk: ${identity}\n`, "upgrade changed upstream compiler version fields");
  const updated = await probe("new-backtrace");
  require(updated.stdout.includes(
    "backtrace-status: Captured",
  ), "SDK replacement left a stale standard library in the executable");
  require(updated.stdout.includes(
    `built-sdk: ${identity}`,
  ), "SDK replacement reused stale build-script output");
  require(/Compiling upgrade-helper/.test(updated.stderr) &&
    /Compiling sdk-upgrade-probe/.test(
      updated.stderr,
    ), "SDK replacement did not invalidate both crates");
  fresh(await probe("new-fresh"));
  await reboot();
  const reopened = await probe("reopened-fresh");
  fresh(reopened);
  require(reopened.stdout.includes("backtrace-status: Captured") &&
    reopened.stdout.includes(
      `built-sdk: ${identity}`,
    ), "upgraded executable did not survive journal reopen");
  return results;
}
