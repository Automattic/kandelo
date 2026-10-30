import { readFileSync } from "node:fs";

import { NodeKernelHost } from "../../src/node-kernel-host";

async function main(): Promise<void> {
  const [imagePath, journalPath, kernelPath, writeMode, persistenceMode] = process.argv.slice(2);
  if (!imagePath || !journalPath || !kernelPath
    || (writeMode !== "synced" && writeMode !== "unsynced")
    || (persistenceMode !== "fixed" && persistenceMode !== "resizable")) {
    throw new Error("persistent crash writer requires image, journal, kernel, write mode, and persistence mode");
  }
  const kernelBytes = readFileSync(kernelPath);
  const kernel = kernelBytes.buffer.slice(
    kernelBytes.byteOffset,
    kernelBytes.byteOffset + kernelBytes.byteLength,
  ) as ArrayBuffer;
  const host = new NodeKernelHost({
    rootfsImageFile: imagePath,
    ...(persistenceMode === "fixed"
      ? { experimentalFixedPersistencePath: journalPath }
      : { experimentalResizablePersistencePath: journalPath }),
  });
  await host.init(kernel);
  const { exit } = await host.spawnFromVfs(
    "/bin/persistence-overwrite",
    ["persistence-overwrite", writeMode],
  );
  const code = await exit;
  if (code !== 0) throw new Error(`persistence guest exited ${code}`);
  if (!process.send) throw new Error("persistent crash writer requires IPC");
  process.send("guest-exited");
  setInterval(() => {}, 1_000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
