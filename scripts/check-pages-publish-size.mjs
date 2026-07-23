#!/usr/bin/env node

import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

function fail(message) {
  console.error(`check-pages-publish-size: ${message}`);
  process.exitCode = 1;
}

async function regularFileBytes(directory) {
  let total = 0n;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      total += await regularFileBytes(entryPath);
      continue;
    }
    if (entry.isFile()) {
      const metadata = await lstat(entryPath);
      total += BigInt(metadata.size);
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        `symbolic link is not allowed in the publish tree: ${entryPath}`,
      );
    }
    throw new Error(`non-regular publish-tree entry is not allowed: ${entryPath}`);
  }

  return total;
}

async function main() {
  const [directoryArgument, limitArgument = "1000000000"] =
    process.argv.slice(2);
  if (!directoryArgument) {
    throw new Error("usage: check-pages-publish-size.mjs DIRECTORY [MAX_BYTES]");
  }
  if (!/^[1-9][0-9]*$/.test(limitArgument)) {
    throw new Error(`MAX_BYTES must be a positive integer: ${limitArgument}`);
  }

  const directory = resolve(directoryArgument);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory()) {
    throw new Error(`publish tree is not a directory: ${directory}`);
  }

  const limit = BigInt(limitArgument);
  const total = await regularFileBytes(directory);
  console.log(
    `check-pages-publish-size: ${total} regular-file bytes (limit ${limit})`,
  );
  if (total > limit) {
    throw new Error(
      `assembled publish tree exceeds the limit by ${total - limit} bytes`,
    );
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
