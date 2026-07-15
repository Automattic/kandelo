import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../../host/src/node-kernel-host";

interface Options {
  image: string;
  bash: string;
  brewScript: string;
  timeoutMs: number;
}

function parseOptions(args: string[]): Options {
  const options = new Map<string, string>();
  const allowed = new Set(["image", "bash", "brew-script", "timeout-ms"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.has(name) || options.has(name) || value === undefined) {
      throw new Error(
        "usage: homebrew_bootstrap_guest_env.ts --image <vfs> --bash <wasm> " +
          "[--brew-script <guest-path>] [--timeout-ms <N>]",
      );
    }
    options.set(name, value);
  }

  const image = options.get("image");
  const bash = options.get("bash");
  const brewScript = options.get("brew-script") ?? "/home/linuxbrew/.linuxbrew/bin/brew";
  const timeoutText = options.get("timeout-ms") ?? "120000";
  const timeoutMs = Number(timeoutText);
  if (!image || !bash || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(
      "usage: homebrew_bootstrap_guest_env.ts --image <vfs> --bash <wasm> " +
        "[--brew-script <guest-path>] [--timeout-ms <N>]",
    );
  }
  if (!brewScript.startsWith("/")) throw new Error("--brew-script must be a guest absolute path");
  return { image: resolve(image), bash: resolve(bash), brewScript, timeoutMs };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const image = new Uint8Array(readFileSync(options.image));
  const bash = new Uint8Array(readFileSync(options.bash));
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  const hostDiagnostics: string[] = [];
  let pid: number | undefined;
  let exitCode: number | undefined;

  const host = new NodeKernelHost({
    rootfsImage: toArrayBuffer(image),
    enableTcpNetwork: false,
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

  await host.init();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitPromise = host.spawn(
      toArrayBuffer(bash),
      ["/bin/bash", "-x", options.brewScript, "--version"],
      {
        env: [
          "PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
          "HOME=/home/linuxbrew",
          "USER=linuxbrew",
          "LOGNAME=linuxbrew",
          "SHELL=/bin/bash",
          "TERM=dumb",
          "HOMEBREW_CACHE=/home/linuxbrew/.cache/Homebrew",
          "HOMEBREW_USER_CONFIG_HOME=/home/linuxbrew/.config/homebrew",
          "HOMEBREW_TEMP=/tmp",
        ],
        cwd: "/home/linuxbrew",
        uid: 1000,
        gid: 1000,
        onStarted: (startedPid) => {
          pid = startedPid;
        },
      },
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(`guest Homebrew environment probe timed out after ${options.timeoutMs}ms`),
          ),
        options.timeoutMs,
      );
    });
    exitCode = await Promise.race([exitPromise, timeoutPromise]);
    if (exitCode !== 0) {
      throw new Error(
        `guest Homebrew environment probe exited ${exitCode}; ` +
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

  if (
    !stderr.includes("export_homebrew_env_file /etc/homebrew/brew.env") ||
    !stderr.includes("HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1") ||
    !stderr.includes("HOMEBREW_KANDELO_BOTTLE_TAG=wasm32_kandelo")
  ) {
    throw new Error(
      `Homebrew did not load the system bottle tag: stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`,
    );
  }
  const hasVersion = /^Homebrew [^\r\n]+$/m.test(stdout);
  const reserveFailure = hostDiagnostics.find((message) =>
    message.includes("(FORK_SAVE_BUFFER_SIZE) are reserved"),
  );
  if (!hasVersion || reserveFailure) {
    throw new Error(
      `successful brew --version had inconsistent evidence: ` +
        `stdout=${JSON.stringify(stdout)}; diagnostics=${JSON.stringify(hostDiagnostics)}`,
    );
  }
  process.stdout.write("homebrew_bootstrap_guest_env: pass\n");
}

await main();
