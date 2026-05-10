#!/usr/bin/env node
// mkrootfs — build, inspect, extract, and augment wasm-posix-kernel rootfs
// VFS images.
//
// Usage:
//   mkrootfs build <MANIFEST> <sourceTree> -o <output.vfs> [--repo-root=<dir>] [--quiet]
//   mkrootfs inspect <image>
//   mkrootfs extract <image> <outDir>
//   mkrootfs add <image> <vfs-path> {--file <src>|--dir|--symlink <target>} [--mode=N] [--uid=N] [--gid=N] [--force]

const USAGE = `Usage: mkrootfs {build|inspect|extract|add} ...
  build   <MANIFEST> <sourceTree> -o <output.vfs> [--repo-root=<dir>] [--quiet]
  inspect <image>
  extract <image> <outDir>
  add     <image> <vfs-path> {--file <src>|--dir|--symlink <target>} [--mode=N] [--uid=N] [--gid=N] [--force]
`;

async function main(argv: string[]): Promise<number> {
  const cmd = argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (cmd) {
    case "build": {
      const { runBuild } = await import("./cli/build.ts");
      return await runBuild(argv.slice(3));
    }
    case "inspect": {
      const { runInspect } = await import("./cli/inspect.ts");
      return await runInspect(argv.slice(3));
    }
    case "extract": {
      const { runExtract } = await import("./cli/extract.ts");
      return await runExtract(argv.slice(3));
    }
    case "add": {
      const { runAdd } = await import("./cli/add.ts");
      return await runAdd(argv.slice(3));
    }
    default:
      process.stderr.write(`mkrootfs: unknown command "${cmd}"\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv).then((code) => process.exit(code));
