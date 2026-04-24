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
    case "inspect": {
      const image = argv[3];
      if (!image) {
        process.stderr.write(`mkrootfs inspect: missing <image>\n`);
        return 2;
      }
      const { inspectImage } = await import("./inspect.ts");
      inspectImage(image);
      return 0;
    }
    case "extract": {
      const image = argv[3];
      const outDir = argv[4];
      if (!image || !outDir) {
        process.stderr.write(`mkrootfs extract: usage: extract <image> <outDir>\n`);
        return 2;
      }
      const { extractImage } = await import("./extract.ts");
      extractImage(image, outDir);
      return 0;
    }
    case "add": {
      const { addFile, parseAddArgs } = await import("./add.ts");
      try {
        const opts = parseAddArgs(argv.slice(3));
        await addFile(opts);
      } catch (e) {
        process.stderr.write(`mkrootfs add: ${(e as Error).message}\n`);
        return 2;
      }
      return 0;
    }
    case "build":
      process.stderr.write(`mkrootfs: "${cmd}" not yet implemented\n`);
      return 2;
    default:
      process.stderr.write(`mkrootfs: unknown command "${cmd}"\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv).then((code) => process.exit(code));
