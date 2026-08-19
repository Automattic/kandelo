import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ensureDirRecursive } from "../../../../../host/src/vfs/image-helpers";
import { MemoryFileSystem } from "../../../../../host/src/vfs/memory-fs";
import {
  createReviewedPrivilegedProgramPolicy,
  publishPrivilegedProgramProduct,
  type PrivilegedProgramProjection,
} from "../../../../../host/src/vfs/privileged-projection";
import { publishCompiledLocalLoginPrograms } from "./local-login-product";

test("publishes all compiled login programs and matches the serialized product", async () => {
  const fixture = await createSourceFixture();
  const published = await publishCompiledLocalLoginPrograms({
    imageBytes: fixture.imageBytes,
    projections: fixture.projections,
    serializedProductBytes: fixture.serializedProductBytes,
  });

  assert.deepEqual(
    published.projections.map((entry) => entry.destinationPath).sort(),
    ["/usr/bin/login", "/usr/bin/sudo", "/usr/bin/sudo-lite"],
  );
  assert.deepEqual(published.imageBytes, fixture.serializedProductBytes);
});

test("rejects a serialized product that differs from the compiled policy", async () => {
  const fixture = await createSourceFixture();
  const changed = fixture.serializedProductBytes.slice();
  changed[changed.byteLength - 1] ^= 0xff;

  await assert.rejects(
    publishCompiledLocalLoginPrograms({
      imageBytes: fixture.imageBytes,
      projections: fixture.projections,
      serializedProductBytes: changed,
    }),
    /differs from the exact serialized artifact/i,
  );
});

async function createSourceFixture(): Promise<{
  imageBytes: Uint8Array;
  projections: PrivilegedProgramProjection[];
  serializedProductBytes: Uint8Array;
}> {
  const sourceFs = MemoryFileSystem.create(
    new SharedArrayBuffer(8 * 1024 * 1024),
  );
  ensureDirRecursive(sourceFs, "/opt/kandelo/homebrew/Cellar");
  const definitions = [
    ["login", "0.1/bin/login", "/usr/bin/login"],
    ["sudo-lite", "0.1/bin/sudo-lite", "/usr/bin/sudo-lite"],
    ["sudo", "1.9/bin/sudo", "/usr/bin/sudo"],
  ] as const;
  const programs = new Map<string, Uint8Array>();
  const projections = definitions.map(([formula, tail, destinationPath]) => {
    const sourcePath = `${formula}/${tail}`;
    const program = new TextEncoder().encode(`wasm program ${formula}`);
    programs.set(sourcePath, program);
    const guestPath = `/opt/kandelo/homebrew/Cellar/${sourcePath}`;
    ensureDirRecursive(sourceFs, guestPath.slice(0, guestPath.lastIndexOf("/")));
    sourceFs.createFileWithOwner(guestPath, 0o755, 1000, 1000, program);
    return {
      schema: 1 as const,
      formula: `kandelo-dev/tap-core/${formula}`,
      bottleSha256: sha256(new TextEncoder().encode(`bottle ${formula}`)),
      sourcePath,
      destinationPath,
      uid: 0 as const,
      gid: 0 as const,
      mode: 0o4755,
      mountPoint: "trusted-root-product",
      artifactValidationSha256: sha256(program),
    };
  });
  const sources = projections.map((projection) => ({
    formula: projection.formula,
    bottleSha256: projection.bottleSha256,
    fs: sourceFs,
    inventory: {
      entries: [{
        sourcePath: projection.sourcePath,
        type: "file" as const,
        size: programs.get(projection.sourcePath)!.byteLength,
      }],
    },
    guestPathForSource: (sourcePath: string) =>
      `/opt/kandelo/homebrew/Cellar/${sourcePath}`,
  }));
  const reference = await publishPrivilegedProgramProduct({
    policy: createReviewedPrivilegedProgramPolicy(projections),
    sources,
    writableBottleFileSystems: [sourceFs],
  });
  return {
    imageBytes: await sourceFs.saveImage(),
    projections,
    serializedProductBytes: reference.imageBytes,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
