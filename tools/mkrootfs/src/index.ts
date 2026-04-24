#!/usr/bin/env node
// mkrootfs — build, inspect, extract, and augment wasm-posix-kernel rootfs
// VFS images.
//
// Usage:
//   mkrootfs build <sourceTree> <manifest> -o <image>
//   mkrootfs inspect <image>
//   mkrootfs extract <image> <outDir>
//   mkrootfs add <image> <path> <src> [--mode=0644] [--uid=0] [--gid=0]

const USAGE = `Usage: mkrootfs {build|inspect|extract|add} ...
  build   <sourceTree> <manifest> -o <image>
  inspect <image>
  extract <image> <outDir>
  add     <image> <path> <src> [--mode=0644] [--uid=0] [--gid=0]
`;

async function main(argv: string[]): Promise<number> {
  const cmd = argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return cmd ? 0 : 1;
  }
  switch (cmd) {
    case "build":
    case "inspect":
    case "extract":
    case "add":
      process.stderr.write(`mkrootfs: "${cmd}" not yet implemented\n`);
      return 2;
    default:
      process.stderr.write(`mkrootfs: unknown command "${cmd}"\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv).then((code) => process.exit(code));
