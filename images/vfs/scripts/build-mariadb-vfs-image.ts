/**
 * Build a fully-bootable VFS image for the MariaDB browser demo.
 * dinit, the first user process, brings up the selected engine's service tree:
 *
 *   <engine>-bootstrap (scripted, oneshot) → <engine>-mariadb (process)
 *
 * Two engine trees are baked: aria-{bootstrap,mariadb} and
 * innodb-{bootstrap,mariadb}. The page selects which engine to start
 * by passing the service name as dinit's positional argv at boot
 * (e.g. `dinit --container aria-mariadb`); dinit resolves the
 * dependency on the matching bootstrap and brings up only that tree.
 *
 * Two target architectures are supported:
 *   bash build-mariadb-vfs-image.sh           → public/mariadb.vfs.zst    (wasm32)
 *   bash build-mariadb-vfs-image.sh --wasm64  → public/mariadb-64.vfs.zst (wasm64)
 *
 * A non-flag argument overrides the output path (a resolver build passes
 * one under its work root).
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KandeloImageFs } from "../lib/kandelo-image-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
  symlink,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import {
  exactVfsImageMetadata,
  installBashAsPosixShell,
  saveImage,
  type ExactVfsImageAbi,
} from "./vfs-image-helpers";
import {
  addDinitInit,
  type DinitBinaryInputs,
  type DinitService,
} from "./dinit-image-helpers";
import { prepareMariadbWritableDirectories } from "./mariadb-image-helpers";
import { ensureSourceExtract } from "./source-extract-helper";

// mariadbd binary comes from the resolver-managed package cache (wasm32
// or wasm64 archive in the binary release). The system_tables SQL files
// are in the upstream MariaDB source tarball under scripts/, so we extract
// it on demand for fetch-only checkouts. Local source-build users keep
// using packages/registry/mariadb/mariadb-install/ as before.
// Coreutils is baked into the VFS so users get an immediate `ls`/`cat`
// in the shell demo without waiting for a lazy-load fetch. Not strictly
// required by the bootstrap wrapper (which is just `exec mariadbd < sql`).

const COREUTILS_SYMLINK_NAMES = [
  "ls", "cat", "cp", "mv", "rm", "echo", "mkdir", "rmdir", "touch", "pwd",
  "head", "tail", "wc", "sort", "uniq", "cut", "tr", "date", "basename",
  "dirname", "chmod", "chown", "ln", "readlink", "true", "false", "yes",
  "sleep", "env", "printenv", "id", "whoami", "hostname", "uname", "stat",
  "df", "du", "tee", "nl", "paste", "tac", "rev", "expand", "unexpand",
  "fold", "fmt", "pr", "od", "hexdump", "xxd", "sha256sum", "sha512sum",
  "md5sum", "seq", "test", "[",
];

function commonMariadbArgs(engine: string): string[] {
  return [
    "/usr/sbin/mariadbd", "--no-defaults",
    // mariadbd refuses to run as root by default; we have a mysql user
    // in /etc/passwd (uid 101) precisely for this.
    "--user=mysql",
    "--datadir=/data", "--tmpdir=/data/tmp",
    `--default-storage-engine=${engine}`,
    "--skip-grant-tables",
    "--key-buffer-size=1048576", "--table-open-cache=10",
    "--sort-buffer-size=262144",
  ];
}

const INNODB_TUNING = [
  "--innodb-buffer-pool-size=8M",
  "--innodb-log-file-size=4M",
  "--innodb-log-buffer-size=1M",
  "--innodb-flush-log-at-trx-commit=2",
  "--innodb-buffer-pool-load-at-startup=OFF",
  "--innodb-buffer-pool-dump-at-shutdown=OFF",
];

/**
 * Build the bootstrap and daemon services for a given engine. Bootstrap
 * is `scripted` so dinit waits for it to exit before the daemon depends-on
 * is satisfied — the daemon never sees a half-initialized data dir.
 *
 * Bootstrap reads bootstrap.sql from stdin via `/bin/sh -c '... < FILE'`
 * because dinit's service schema doesn't take an explicit stdin redirect
 * (it does have `socket-listen` but that's for activation, not feeding).
 */
function buildEngineServices(engine: "Aria" | "InnoDB"): DinitService[] {
  const tag = engine === "Aria" ? "aria" : "innodb";
  const args = commonMariadbArgs(engine);
  const innodbArgs = engine === "InnoDB" ? INNODB_TUNING : [];
  const bootstrapArgs = [
    ...args, ...innodbArgs,
    "--bootstrap", "--skip-networking", "--log-warnings=0",
    `--log-error=/data/${tag}-bootstrap.log`,
  ].join(" ");
  const daemonCmd = [
    ...args, ...innodbArgs,
    "--skip-networking=0", "--port=3306",
    "--bind-address=0.0.0.0", "--socket=",
    "--max-connections=10",
    `--log-error=/data/${tag}-error.log`,
  ].join(" ");

  return [
    {
      name: `${tag}-bootstrap`,
      type: "scripted",
      // Wrapper script does the stdin redirection (dinit's command-line
      // parsing strips quotes, breaking inline `sh -c '... < FILE'`).
      // Invoked via `sh SCRIPT` because wasm exec doesn't honor shebangs.
      command: `/bin/sh /etc/mariadb/${tag}-bootstrap.sh`,
      logfile: `/var/log/${tag}-bootstrap.log`,
      restart: false,
    },
    {
      name: `${tag}-mariadb`,
      type: "process",
      command: daemonCmd,
      dependsOn: [`${tag}-bootstrap`],
      logfile: `/var/log/${tag}-mariadb.log`,
      restart: false,
    },
  ];
}

export interface MariadbVfsImageBuildInputs {
  architecture: "wasm32" | "wasm64";
  mariadbd: Uint8Array;
  systemTablesDirectory: string;
  bash: Uint8Array;
  dash: Uint8Array;
  coreutils: Uint8Array;
  dinit?: DinitBinaryInputs;
  services?: Uint8Array;
  outputPath: string;
  targetAbi?: ExactVfsImageAbi;
}

export async function buildMariadbVfsImage(
  inputs: MariadbVfsImageBuildInputs,
): Promise<void> {
  console.log(`==> Building MariaDB VFS image (${inputs.architecture})`);

  const fs = KandeloImageFs.create();
  // The declared capacity the product's publication gate checks the artifact
  // against. The SharedArrayBuffer it used to come from was never anything but
  // the old constructor's first argument.
  fs.setImageCapacity(256 * 1024 * 1024);

  for (const dir of [
    "/tmp", "/home", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
    "/usr/local", "/usr/local/bin", "/usr/share", "/root", "/usr/sbin",
    "/data", "/data/mysql", "/data/tmp", "/data/test",
  ]) {
    ensureDir(fs, dir);
  }
  prepareMariadbWritableDirectories(fs);

  // Bake bash as /bin/sh -- the same POSIX shell every Kandelo image binds
  // there -- plus coreutils, so the service wrappers and shell utilities are
  // available without ambient browser assets. dash stays an ordinary command
  // at its own name; it does not claim /bin/sh.
  installBashAsPosixShell(fs, inputs.bash);
  writeVfsBinary(fs, "/bin/dash", inputs.dash);
  symlink(fs, "/bin/dash", "/usr/bin/dash");
  writeVfsBinary(fs, "/bin/coreutils", inputs.coreutils);
  for (const name of COREUTILS_SYMLINK_NAMES) {
    symlink(fs, "/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
  }

  console.log("  Writing mariadbd binary...");
  writeVfsBinary(fs, "/usr/sbin/mariadbd", inputs.mariadbd);

  console.log("  Writing bootstrap SQL...");
  ensureDirRecursive(fs, "/etc/mariadb");
  const systemTables = readFileSync(
    join(inputs.systemTablesDirectory, "mysql_system_tables.sql"),
    "utf-8",
  );
  const systemData = readFileSync(
    join(inputs.systemTablesDirectory, "mysql_system_tables_data.sql"),
    "utf-8",
  );
  const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\nCREATE DATABASE IF NOT EXISTS test;\n`;
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);

  // Per-engine bootstrap-runner scripts. Invoked via `/bin/sh SCRIPT`
  // from each engine's dinit bootstrap service (see buildEngineServices
  // for why the inline `sh -c` form was abandoned: dinit's command-line
  // parsing strips quotes, breaking long single-string commands).
  for (const eng of [{ tag: "aria", engine: "Aria" }, { tag: "innodb", engine: "InnoDB" }] as const) {
    const args = commonMariadbArgs(eng.engine);
    const innodbArgs = eng.engine === "InnoDB" ? INNODB_TUNING : [];
    const bootstrapCmd = [
      ...args, ...innodbArgs,
      "--bootstrap", "--skip-networking", "--log-warnings=0",
      `--log-error=/data/${eng.tag}-bootstrap.log`,
    ].join(" ");
    // `exec` replaces the wrapper shell with mariadbd so dinit observes
    // mariadbd's exit status directly. mariadbd reads the bootstrap SQL
    // from stdin, executes it, and exits 0 at EOF.
    const script = `exec ${bootstrapCmd} < /etc/mariadb/bootstrap.sql\n`;
    writeVfsFile(fs, `/etc/mariadb/${eng.tag}-bootstrap.sh`, script);
  }

  // Bake both engine trees, no implicit boot — page selects which engine
  // to start by passing `<engine>-mariadb` as dinit's positional argv.
  addDinitInit(
    fs,
    [...buildEngineServices("Aria"), ...buildEngineServices("InnoDB")],
    { boot: false, binaries: inputs.dinit, services: inputs.services },
  );

  await saveImage(fs, inputs.outputPath, inputs.targetAbi === undefined
    ? {}
    : {
        kernelAbi: inputs.targetAbi.version,
        metadata: exactVfsImageMetadata(
          inputs.targetAbi,
          "images/vfs/scripts/build-mariadb-vfs-image.ts",
        ),
      });
}

function resolveLegacySystemTablesDirectory(
  repositoryRoot: string,
  useWasm64: boolean,
): string {
  const installed = join(
    repositoryRoot,
    "packages/registry/mariadb",
    useWasm64 ? "mariadb-install-64" : "mariadb-install",
    "share/mysql",
  );
  if (
    existsSync(join(installed, "mysql_system_tables.sql")) &&
    existsSync(join(installed, "mysql_system_tables_data.sql"))
  ) {
    return installed;
  }
  return join(ensureSourceExtract("mariadb", repositoryRoot), "scripts");
}

async function main(): Promise<void> {
  const repositoryRoot = findRepoRoot();
  const useWasm64 = process.argv.includes("--wasm64");
  const outputArgument = process.argv
    .slice(2)
    .find((argument) => !argument.startsWith("--"));
  const architecture = useWasm64 ? "wasm64" : "wasm32";
  const mariadbRoot = process.env.WASM_POSIX_DEP_MARIADB_DIR;
  const bashRoot = process.env.WASM_POSIX_DEP_BASH_DIR;
  const dashRoot = process.env.WASM_POSIX_DEP_DASH_DIR;
  const coreutilsRoot = process.env.WASM_POSIX_DEP_COREUTILS_DIR;
  const dinitRoot = process.env.WASM_POSIX_DEP_DINIT_DIR;
  // Resolver builds consume their declared dependencies, including their SQL
  // runtime files. Only standalone builds discover the installed package tree.
  const mariadbPath = mariadbRoot
    ? join(mariadbRoot, "mariadbd.wasm")
    : resolveBinary(useWasm64
      ? "programs/wasm64/mariadb/mariadbd.wasm"
      : "programs/mariadb/mariadbd.wasm");
  await buildMariadbVfsImage({
    architecture,
    mariadbd: new Uint8Array(readFileSync(mariadbPath)),
    systemTablesDirectory: mariadbRoot
      ? join(mariadbRoot, "share/mysql")
      : resolveLegacySystemTablesDirectory(repositoryRoot, useWasm64),
    bash: new Uint8Array(readFileSync(bashRoot
      ? join(bashRoot, "bash.wasm")
      : resolveBinary("programs/bash.wasm"))),
    dash: new Uint8Array(readFileSync(dashRoot
      ? join(dashRoot, "dash.wasm")
      : resolveBinary("programs/dash.wasm"))),
    coreutils: new Uint8Array(
      readFileSync(coreutilsRoot
        ? join(coreutilsRoot, "coreutils.wasm")
        : resolveBinary("programs/coreutils.wasm")),
    ),
    dinit: dinitRoot ? {
      dinit: new Uint8Array(readFileSync(join(dinitRoot, "dinit.wasm"))),
      dinitctl: new Uint8Array(readFileSync(join(dinitRoot, "dinitctl.wasm"))),
    } : undefined,
    services: new Uint8Array(readFileSync(
      join(repositoryRoot, "images/rootfs/etc/services"),
    )),
    outputPath: outputArgument
      ? resolve(outputArgument)
      : join(
        repositoryRoot,
        `apps/browser-demos/public/${useWasm64 ? "mariadb-64" : "mariadb"}.vfs.zst`,
      ),
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
