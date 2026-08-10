import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface VfsProductBuilderOptions {
  manifestPath: string;
  inputsPath: string;
  reportPath: string;
  outputPath: string;
  workDir: string;
}

export interface VfsProductBuilderDependencies {
  launch(
    builderPath: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    cwd: string,
  ): Promise<Readonly<{ exitCode: number }>>;
  validateInputs(inputsPath: string): Promise<void>;
  compareReport(inputsPath: string, reportPath: string): Promise<void>;
}

const SAFE_AMBIENT_ENVIRONMENT = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NIX_SSL_CERT_FILE",
  "NO_COLOR",
  "PATH",
  "SOURCE_DATE_EPOCH",
  "SSL_CERT_FILE",
  "TERM",
  "TZ",
] as const;

export async function runVfsProductBuilder(
  options: VfsProductBuilderOptions,
  dependencies: VfsProductBuilderDependencies,
): Promise<void> {
  const normalized = validateOptions(options);
  const builderPath = readBuilderPath(normalized.manifestPath);

  await dependencies.validateInputs(normalized.inputsPath);

  assertDirectoryNonsymlink(normalized.workDir, "work directory");
  if (readdirSync(normalized.workDir).length !== 0) {
    throw new Error(
      "VFS product builder work directory changed during input validation",
    );
  }
  assertAbsent(normalized.outputPath, "builder output");
  assertAbsent(normalized.reportPath, "builder report");
  ensureParentDirectories(normalized.workDir, normalized.outputPath);
  ensureParentDirectories(normalized.workDir, normalized.reportPath);
  createPrivateDirectory(resolve(normalized.workDir, "home"));
  createPrivateDirectory(resolve(normalized.workDir, "tmp"));
  const environment = isolatedEnvironment(normalized.workDir);
  const args = Object.freeze([
    "--vfs-product-manifest",
    normalized.manifestPath,
    "--vfs-product-inputs",
    normalized.inputsPath,
    "--vfs-product-report",
    normalized.reportPath,
    "--vfs-product-output",
    normalized.outputPath,
  ]);
  const result = await dependencies.launch(
    builderPath,
    args,
    environment,
    normalized.workDir,
  );
  if (!Number.isInteger(result.exitCode) || result.exitCode !== 0) {
    throw new Error(
      `VFS product builder exited with status ${String(result.exitCode)}`,
    );
  }

  assertRegularNonsymlinkBelow(
    normalized.workDir,
    normalized.outputPath,
    "builder output",
  );
  assertRegularNonsymlinkBelow(
    normalized.workDir,
    normalized.reportPath,
    "builder report",
  );
  await dependencies.compareReport(normalized.inputsPath, normalized.reportPath);
}

export async function runVfsProductBuilderCli(
  args: readonly string[],
  dependencies: VfsProductBuilderDependencies = productionDependencies(),
): Promise<void> {
  const flags = parseRunnerFlags(args);
  await runVfsProductBuilder({
    inputsPath: requiredRunnerFlag(flags, "--inputs"),
    manifestPath: requiredRunnerFlag(flags, "--manifest"),
    outputPath: requiredRunnerFlag(flags, "--output"),
    reportPath: requiredRunnerFlag(flags, "--report"),
    workDir: requiredRunnerFlag(flags, "--work-dir"),
  }, dependencies);
}

function productionDependencies(): VfsProductBuilderDependencies {
  const protectedRoot = resolve(import.meta.dirname, "..");
  const hostTarget = protectedHostTarget(protectedRoot);
  const validate = async (arguments_: readonly string[]): Promise<void> => {
    const exitCode = await spawnStatus(
      "cargo",
      [
        "run",
        "-p",
        "xtask",
        "--target",
        hostTarget,
        "--quiet",
        "--",
        "abi-staging",
        "builder",
        ...arguments_,
      ],
      process.env,
      protectedRoot,
    );
    if (exitCode !== 0) {
      throw new Error(`protected VFS product contract validator exited with status ${exitCode}`);
    }
  };
  return {
    compareReport: async (inputsPath, reportPath) => validate([
      "compare-report",
      "--input-root",
      dirname(inputsPath),
      "--inputs",
      inputsPath,
      "--report",
      reportPath,
      "--report-root",
      dirname(reportPath),
    ]),
    launch: async (builderPath, args, env, cwd) => ({
      exitCode: await spawnStatus(builderPath, args, env, cwd),
    }),
    validateInputs: async (inputsPath) => validate([
      "validate-inputs",
      "--input-root",
      dirname(inputsPath),
      "--inputs",
      inputsPath,
    ]),
  };
}

function protectedHostTarget(protectedRoot: string): string {
  if (!process.env.KANDELO_DEV_SHELL_TOOL_PATH) {
    throw new Error("VFS product runner must execute inside scripts/dev-shell.sh");
  }
  const result = spawnSync("rustc", ["-vV"], {
    cwd: protectedRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cannot resolve protected host target: rustc exited ${String(result.status)}`);
  }
  const matches = result.stdout.match(/^host: ([A-Za-z0-9_.-]+)$/m);
  if (matches === null) throw new Error("rustc did not report one protected host target");
  return matches[1]!;
}

function spawnStatus(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | Readonly<Record<string, string>>,
  cwd: string,
): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: { ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} was terminated by signal ${signal}`));
        return;
      }
      resolveStatus(code ?? 1);
    });
  });
}

const RUNNER_FLAGS = [
  "--inputs",
  "--manifest",
  "--output",
  "--report",
  "--work-dir",
] as const;

function parseRunnerFlags(args: readonly string[]): Map<string, string> {
  if (args.length !== RUNNER_FLAGS.length * 2) {
    throw new Error(
      "usage: run-vfs-product-builder.ts " +
        RUNNER_FLAGS.map((flag) => `${flag} <path>`).join(" "),
    );
  }
  const allowed = new Set<string>(RUNNER_FLAGS);
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1]!;
    if (!allowed.has(flag) || flags.has(flag) || value.length === 0) {
      throw new Error(`VFS product runner flag is invalid: ${flag}`);
    }
    flags.set(flag, value);
  }
  return flags;
}

function requiredRunnerFlag(
  flags: ReadonlyMap<string, string>,
  name: typeof RUNNER_FLAGS[number],
): string {
  const value = flags.get(name);
  if (value === undefined) throw new Error(`missing required flag ${name}`);
  return value;
}

function validateOptions(options: VfsProductBuilderOptions): VfsProductBuilderOptions {
  const normalized = {
    manifestPath: absolutePath(options.manifestPath, "manifest path"),
    inputsPath: absolutePath(options.inputsPath, "resolved-input path"),
    reportPath: absolutePath(options.reportPath, "report path"),
    outputPath: absolutePath(options.outputPath, "output path"),
    workDir: absolutePath(options.workDir, "work directory"),
  };
  assertDirectoryNonsymlink(normalized.workDir, "work directory");
  assertRegularNonsymlink(normalized.manifestPath, "product manifest");
  assertRegularNonsymlink(normalized.inputsPath, "resolved input document");
  assertInsideWorkDirectory(normalized.workDir, normalized.outputPath, "output");
  assertInsideWorkDirectory(normalized.workDir, normalized.reportPath, "report");
  assertAbsent(normalized.outputPath, "builder output");
  assertAbsent(normalized.reportPath, "builder report");
  if (readdirSync(normalized.workDir).length !== 0) {
    throw new Error("VFS product builder work directory must be empty");
  }
  return Object.freeze(normalized);
}

function readBuilderPath(manifestPath: string): string {
  const bytes = readFileSync(manifestPath);
  if (bytes.byteLength > 1024 * 1024) {
    throw new Error("VFS product manifest exceeds the 1 MiB runner limit");
  }
  const text = bytes.toString("utf8");
  const matches = [...text.matchAll(/^builder = "([^"\\]+)"$/gm)];
  if (matches.length !== 1) {
    throw new Error("VFS product manifest must contain exactly one literal builder path");
  }
  const declared = normalizedRepositoryPath(matches[0][1], "builder path");
  const repositoryRoot = resolve(process.cwd());
  const builderPath = resolve(repositoryRoot, declared);
  if (!builderPath.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("VFS product builder path escapes the repository root");
  }
  assertRegularNonsymlink(builderPath, "VFS product builder");
  return builderPath;
}

function isolatedEnvironment(workDir: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const name of SAFE_AMBIENT_ENVIRONMENT) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (!environment.PATH) {
    throw new Error("VFS product builder requires PATH from the repository dev shell");
  }
  environment.HOME = resolve(workDir, "home");
  environment.TMPDIR = resolve(workDir, "tmp");
  environment.CI = "true";
  return Object.freeze(environment);
}

function createPrivateDirectory(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  assertDirectoryNonsymlink(path, "private builder directory");
}

function ensureParentDirectories(root: string, target: string): void {
  const parentRelative = relative(root, dirname(target));
  if (parentRelative === "") return;
  let current = root;
  for (const part of parentRelative.split(sep)) {
    current = resolve(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    assertDirectoryNonsymlink(current, "builder output parent");
  }
}

function assertInsideWorkDirectory(root: string, path: string, label: string): void {
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error(`VFS product builder ${label} must be inside the work directory`);
  }
}

function absolutePath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a nonempty path`);
  }
  const normalized = resolve(value);
  if (normalized !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return normalized;
}

function normalizedRepositoryPath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not a normalized repository-relative path`);
  }
  return value;
}

function assertRegularNonsymlink(path: string, label: string): void {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new Error(`${label} must be a regular nonsymlink file`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular nonsymlink file`);
  }
}

function assertRegularNonsymlinkBelow(
  root: string,
  path: string,
  label: string,
): void {
  assertDirectoryNonsymlink(root, "work directory");
  const pathRelative = relative(root, path);
  if (
    pathRelative === "" ||
    pathRelative.startsWith(`..${sep}`) ||
    pathRelative === ".."
  ) {
    throw new Error(`${label} must remain inside the work directory`);
  }
  let current = root;
  for (const part of pathRelative.split(sep)) {
    current = resolve(current, part);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new Error(`${label} must be a regular nonsymlink file`);
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} path contains a symbolic link`);
    }
  }
  assertRegularNonsymlink(path, label);
}

function assertDirectoryNonsymlink(path: string, label: string): void {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new Error(`${label} must be a nonsymlink directory`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a nonsymlink directory`);
  }
}

function assertAbsent(path: string, label: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(`${label} already exists`);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void runVfsProductBuilderCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
