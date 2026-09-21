import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createReviewedPrivilegedProgramPolicy,
  parsePrivilegedProgramProjections,
  publishPrivilegedProgramProduct,
  snapshotPublishedPrivilegedProgramBrowserMount,
  validatePrivilegedProgramProductCandidate,
  type PrivilegedProgramProjection,
  type PrivilegedProgramSource,
} from "../src/vfs/privileged-projection";
import * as privilegedProjectionModule from
  "../src/vfs/privileged-projection";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import { MemoryFileSystem, resolveMountSetIdCapability } from "../src/vfs/memory-fs";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { NodeTimeProvider } from "../src/vfs/time";

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const SOURCE_ROOT = "/opt/kandelo/pkg/cellar";
const SHA_A = "a".repeat(64);
const PROGRAMS = [
  {
    formula: "kandelo-dev/tap-core/login",
    sourcePath: "login/1.0/bin/login",
    destinationPath: "/usr/bin/login",
    bytes: new TextEncoder().encode("login program\n"),
  },
  {
    formula: "kandelo-dev/tap-core/sudo-lite",
    sourcePath: "sudo-lite/1.0/bin/sudo-lite",
    destinationPath: "/usr/bin/sudo-lite",
    bytes: new TextEncoder().encode("sudo-lite program\n"),
  },
  {
    formula: "kandelo-dev/tap-core/sudo",
    sourcePath: "sudo/1.9.17p2/bin/sudo",
    destinationPath: "/usr/bin/sudo",
    bytes: new TextEncoder().encode("upstream sudo program\n"),
  },
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createFs(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
}

function projections(): PrivilegedProgramProjection[] {
  return PROGRAMS.map((program) => ({
    schema: 1,
    formula: program.formula,
    bottleSha256: SHA_A,
    sourcePath: program.sourcePath,
    destinationPath: program.destinationPath,
    uid: 0,
    gid: 0,
    mode: 0o4755,
    mountPoint: "trusted-root-product",
    artifactValidationSha256: sha256(program.bytes),
  }));
}

function reviewedPolicy(value: unknown = projections()) {
  return createReviewedPrivilegedProgramPolicy(value);
}

function sourceFixture(options: {
  sourceSymlink?: string;
  sourceHardlink?: { from: string; to: string };
} = {}): {
  writableBottleFs: MemoryFileSystem;
  sources: PrivilegedProgramSource[];
} {
  const writableBottleFs = createFs();
  const sources: PrivilegedProgramSource[] = [];
  for (const program of PROGRAMS) {
    const guestPath = `${SOURCE_ROOT}/${program.sourcePath}`;
    ensureDirRecursive(writableBottleFs, guestPath.slice(0, guestPath.lastIndexOf("/")));
    if (options.sourceSymlink === program.sourcePath) {
      writableBottleFs.symlink("login-real", guestPath);
    } else if (options.sourceHardlink?.from === program.sourcePath) {
      const canonicalGuestPath = `${SOURCE_ROOT}/${options.sourceHardlink.to}`;
      ensureDirRecursive(
        writableBottleFs,
        canonicalGuestPath.slice(0, canonicalGuestPath.lastIndexOf("/")),
      );
      writeVfsBinary(writableBottleFs, canonicalGuestPath, program.bytes, 0o755);
      writableBottleFs.link(canonicalGuestPath, guestPath);
    } else {
      writeVfsBinary(writableBottleFs, guestPath, program.bytes, 0o755);
    }
    sources.push({
      formula: program.formula,
      bottleSha256: SHA_A,
      fs: writableBottleFs,
      inventory: {
        entries: options.sourceHardlink?.from === program.sourcePath
          ? [
            {
              sourcePath: options.sourceHardlink.to,
              type: "file",
              size: program.bytes.byteLength,
            },
            {
              sourcePath: program.sourcePath,
              type: "hardlink",
              size: 0,
              target: options.sourceHardlink.to,
            },
          ]
          : [{
            sourcePath: program.sourcePath,
            type: options.sourceSymlink === program.sourcePath ? "symlink" : "file",
            size: options.sourceSymlink === program.sourcePath ? 0 : program.bytes.byteLength,
            ...(options.sourceSymlink === program.sourcePath
              ? { target: "login-real" }
              : {}),
          }],
      },
      guestPathForSource(sourcePath) {
        return `${SOURCE_ROOT}/${sourcePath}`;
      },
    });
  }
  return { writableBottleFs, sources };
}

describe("privileged projection record", () => {
  it("accepts only the closed reviewed root-owned projection group", () => {
    expect(parsePrivilegedProgramProjections(projections())).toEqual(projections());

    for (const [label, mutate] of [
      ["unknown field", (record: Record<string, unknown>) => record.extra = true],
      ["wrong mode", (record: Record<string, unknown>) => record.mode = 0o755],
      ["wrong owner", (record: Record<string, unknown>) => record.uid = 1000],
      ["wrong group", (record: Record<string, unknown>) => record.gid = 1000],
      ["unrecognized mount", (record: Record<string, unknown>) => record.mountPoint = "/"],
      ["unreviewed destination", (record: Record<string, unknown>) => {
        record.destinationPath = "/usr/bin/su";
      }],
    ] as const) {
      const value = structuredClone(projections()) as unknown as Record<string, unknown>[];
      mutate(value[0]!);
      expect(
        () => parsePrivilegedProgramProjections(value),
        label,
      ).toThrow();
    }
  });

  it("rejects duplicate or incomplete product destinations", () => {
    const duplicate = projections();
    duplicate[1] = { ...duplicate[1]!, destinationPath: "/usr/bin/login" };
    expect(() => parsePrivilegedProgramProjections(duplicate)).toThrow(/duplicate/i);
    expect(() => parsePrivilegedProgramProjections(projections().slice(0, 2)))
      .toThrow(/exactly|missing/i);
  });

  it("rejects missing and inherited required projection fields", () => {
    const missing = structuredClone(projections()) as unknown as
      Record<string, unknown>[];
    delete missing[0]!.formula;
    expect(() => parsePrivilegedProgramProjections(missing)).toThrow(/closed schema/i);

    const inherited = projections();
    inherited[0] = Object.create(inherited[0]) as PrivilegedProgramProjection;
    expect(() => parsePrivilegedProgramProjections(inherited)).toThrow(/plain record/i);
  });
});

describe("privileged product publication", () => {
  it("does not grant product authority through caller-candidate seams", async () => {
    const source = sourceFixture();
    const candidate = createFs();
    ensureDirRecursive(candidate, "/usr/bin");
    for (const program of PROGRAMS) {
      writeVfsBinary(candidate, program.destinationPath, program.bytes, 0o755);
      candidate.chown(program.destinationPath, 0, 0);
      candidate.chmod(program.destinationPath, 0o4755);
    }
    const sharedAlias = MemoryFileSystem.fromExisting(
      structuredClone(candidate.sharedBuffer),
    );
    const unsafeAdmission = Reflect.get(
      privilegedProjectionModule,
      "admitPrivilegedProgramProductCandidateForTest",
    ) as ((options: {
      candidateFs: MemoryFileSystem;
      policy: ReturnType<typeof reviewedPolicy>;
      sources: PrivilegedProgramSource[];
      writableBottleFileSystems: MemoryFileSystem[];
    }) => Promise<{
      mount: ConstructorParameters<typeof VirtualPlatformIO>[0][number];
    }>) |
      undefined;

    let grantedCapability: string | undefined;
    if (unsafeAdmission !== undefined) {
      const product = await unsafeAdmission({
        candidateFs: candidate,
        policy: reviewedPolicy(),
        sources: source.sources,
        writableBottleFileSystems: [sharedAlias],
      });
      grantedCapability = resolveMountSetIdCapability(product.mount).kind;
    }

    expect(grantedCapability).not.toBe("trusted-root-product");
    await expect(validatePrivilegedProgramProductCandidate({
      candidateFs: candidate,
      policy: reviewedPolicy(),
      sources: source.sources,
      writableBottleFileSystems: [sharedAlias],
    })).resolves.toBeUndefined();
    expect(() => resolveMountSetIdCapability({
      backend: candidate,
      readonly: true,
      setIdCapability: {
        kind: "trusted-root-product",
        guestWritable: false,
        stableExecutableIdentity: true,
      },
    })).toThrow(/immutable product backend/i);
    expect(Reflect.has(
      privilegedProjectionModule,
      "admitPrivilegedProgramProductCandidate",
    )).toBe(false);
    expect(Reflect.has(
      privilegedProjectionModule,
      "admitPrivilegedProgramProductCandidateForTest",
    )).toBe(false);
  });

  it("copies regular bytes into three fresh unique root-owned inodes", async () => {
    const source = sourceFixture();
    const product = await publishPrivilegedProgramProduct({
      policy: reviewedPolicy(),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    });
    const io = new VirtualPlatformIO([product.mount], new NodeTimeProvider());

    expect(product.projections.map((entry) => entry.destinationPath)).toEqual([
      "/usr/bin/login",
      "/usr/bin/sudo-lite",
      "/usr/bin/sudo",
    ]);
    const productIdentities = new Set<string>();
    const bottleIdentities = new Set<string>();
    for (const [index, program] of PROGRAMS.entries()) {
      const projected = io.lstat(program.destinationPath);
      const bottle = source.writableBottleFs.lstat(`${SOURCE_ROOT}/${program.sourcePath}`);
      expect(projected.mode & S_IFMT).toBe(S_IFREG);
      expect(projected.mode & 0o7777).toBe(0o4755);
      expect(projected.uid).toBe(0);
      expect(projected.gid).toBe(0);
      expect(projected.nlink).toBe(1);
      expect(product.evidence[index]?.sourceIdentity)
        .not.toEqual(product.evidence[index]?.destinationIdentity);
      productIdentities.add(JSON.stringify(product.evidence[index]?.destinationIdentity));
      bottleIdentities.add(JSON.stringify({ dev: bottle.dev, ino: bottle.ino }));
    }
    expect(productIdentities.size).toBe(3);
    expect(product.evidence.every((entry) => entry.collidesWithWritableBottle === false))
      .toBe(true);
    expect(resolveMountSetIdCapability(product.mount)).toEqual({
      kind: "trusted-root-product",
      guestWritable: false,
      stableExecutableIdentity: true,
    });
    expect(() => product.mount.backend.unlink("/usr/bin/login")).toThrow(/EROFS/);
    expect(bottleIdentities.size).toBe(3);

    const restoredArtifact = MemoryFileSystem.fromImage(product.imageBytes);
    expect(restoredArtifact.lstat("/usr/bin/login")).toMatchObject({
      uid: 0,
      gid: 0,
      nlink: 1,
    });
    expect(restoredArtifact.lstat("/usr/bin/login").mode & 0o7777).toBe(0o4755);

    const repeated = await publishPrivilegedProgramProduct({
      policy: reviewedPolicy(),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    });
    expect(repeated.imageBytes).toEqual(product.imageBytes);
  });

  it("snapshots browser mount authority only from the exact publication", async () => {
    const source = sourceFixture();
    const product = await publishPrivilegedProgramProduct({
      policy: reviewedPolicy(),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    });
    const first = snapshotPublishedPrivilegedProgramBrowserMount(product);
    const expected = first.imageBytes.slice();

    expect(first.mountPoint).toBe("/usr/bin");
    expect(MemoryFileSystem.fromImage(first.imageBytes).lstat("/login"))
      .toMatchObject({ uid: 0, gid: 0, nlink: 1 });
    first.imageBytes.fill(0);
    product.imageBytes.fill(0);
    expect(snapshotPublishedPrivilegedProgramBrowserMount(product).imageBytes)
      .toEqual(expected);
    expect(() => snapshotPublishedPrivilegedProgramBrowserMount({
      ...product,
      imageBytes: expected,
    })).toThrow(/publication authority/i);
  });

  it("resolves an authenticated bottle hardlink but publishes a fresh inode", async () => {
    const source = sourceFixture({
      sourceHardlink: {
        from: PROGRAMS[0].sourcePath,
        to: "login/1.0/bin/login-real",
      },
    });
    const product = await publishPrivilegedProgramProduct({
      policy: reviewedPolicy(),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    });
    expect(product.evidence[0]).toMatchObject({
      sourcePath: PROGRAMS[0].sourcePath,
      canonicalSourcePath: "login/1.0/bin/login-real",
      destinationPath: "/usr/bin/login",
      collidesWithWritableBottle: false,
    });
    expect(product.evidence[0]?.sourceIdentity)
      .not.toEqual(product.evidence[0]?.destinationIdentity);
  });

  it("rejects source symlinks and members absent from the complete inventory", async () => {
    const symlink = sourceFixture({ sourceSymlink: PROGRAMS[0].sourcePath });
    await expect(publishPrivilegedProgramProduct({
      policy: reviewedPolicy(),
      sources: symlink.sources,
      writableBottleFileSystems: [symlink.writableBottleFs],
    })).rejects.toThrow(/source.*symlink/i);

    const absent = sourceFixture();
    absent.sources[0] = { ...absent.sources[0]!, inventory: { entries: [] } };
    await expect(publishPrivilegedProgramProduct({
      policy: reviewedPolicy(),
      sources: absent.sources,
      writableBottleFileSystems: [absent.writableBottleFs],
    })).rejects.toThrow(/absent.*complete.*inventory/i);

    const cycle = sourceFixture();
    cycle.sources[0] = {
      ...cycle.sources[0]!,
      inventory: {
        entries: [
          {
            sourcePath: PROGRAMS[0].sourcePath,
            type: "hardlink",
            size: 0,
            target: "login/1.0/bin/login-cycle",
          },
          {
            sourcePath: "login/1.0/bin/login-cycle",
            type: "hardlink",
            size: 0,
            target: PROGRAMS[0].sourcePath,
          },
        ],
      },
    };
    await expect(publishPrivilegedProgramProduct({
      policy: reviewedPolicy(),
      sources: cycle.sources,
      writableBottleFileSystems: [cycle.writableBottleFs],
    })).rejects.toThrow(/hard-?link.*cycle/i);
  });

  it("rejects source or artifact digest drift before publication", async () => {
    const source = sourceFixture();
    const bottleDrift = projections();
    bottleDrift[0] = { ...bottleDrift[0]!, bottleSha256: "b".repeat(64) };
    await expect(publishPrivilegedProgramProduct({
      policy: reviewedPolicy(bottleDrift),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    })).rejects.toThrow(/bottle.*digest/i);

    const artifactDrift = projections();
    artifactDrift[0] = {
      ...artifactDrift[0]!,
      artifactValidationSha256: "c".repeat(64),
    };
    await expect(publishPrivilegedProgramProduct({
      policy: reviewedPolicy(artifactDrift),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    })).rejects.toThrow(/artifact.*digest/i);
  });

  it("rejects projected symlinks, hard links, writable aliases, and bottle collisions", async () => {
    const source = sourceFixture();
    const base = createFs();
    ensureDirRecursive(base, "/usr/bin");
    for (const program of PROGRAMS) {
      writeVfsBinary(base, program.destinationPath, program.bytes, 0o755);
      base.chown(program.destinationPath, 0, 0);
      base.chmod(program.destinationPath, 0o4755);
    }

    const projectedSymlink = createFs();
    ensureDirRecursive(projectedSymlink, "/usr/bin");
    projectedSymlink.symlink("/opt/kandelo/pkg/bin/login", "/usr/bin/login");
    for (const program of PROGRAMS.slice(1)) {
      writeVfsBinary(projectedSymlink, program.destinationPath, program.bytes, 0o4755);
    }
    await expect(validatePrivilegedProgramProductCandidate({
      candidateFs: projectedSymlink,
      policy: reviewedPolicy(),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    })).rejects.toThrow(/projected.*regular/i);

    const preservedHardlink = base.rebaseToNewFileSystem(4 * 1024 * 1024);
    preservedHardlink.unlink("/usr/bin/login");
    preservedHardlink.link("/usr/bin/sudo", "/usr/bin/login");
    await expect(validatePrivilegedProgramProductCandidate({
      candidateFs: preservedHardlink,
      policy: reviewedPolicy(),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    })).rejects.toThrow(/hard link|unique inode/i);

    const writableAlias = base.rebaseToNewFileSystem(4 * 1024 * 1024);
    ensureDirRecursive(writableAlias, "/tmp");
    writableAlias.link("/usr/bin/login", "/tmp/writable-login");
    await expect(validatePrivilegedProgramProductCandidate({
      candidateFs: writableAlias,
      policy: reviewedPolicy(),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    })).rejects.toThrow(/writable alias|link count/i);

    ensureDirRecursive(source.writableBottleFs, "/usr/bin");
    for (const program of PROGRAMS) {
      source.writableBottleFs.link(
        `${SOURCE_ROOT}/${program.sourcePath}`,
        program.destinationPath,
      );
      source.writableBottleFs.chmod(program.destinationPath, 0o4755);
    }
    const writableBottlePeer = MemoryFileSystem.fromExisting(
      source.writableBottleFs.sharedBuffer,
    );
    await expect(validatePrivilegedProgramProductCandidate({
      candidateFs: writableBottlePeer,
      policy: reviewedPolicy(),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    })).rejects.toThrow(/writable bottle inode|collision/i);
  });

  it("rejects non-root files, writable parents, and an unstable backend", async () => {
    const source = sourceFixture();
    const candidate = createFs();
    ensureDirRecursive(candidate, "/usr/bin");
    for (const program of PROGRAMS) {
      writeVfsBinary(candidate, program.destinationPath, program.bytes, 0o4755);
    }
    candidate.chown("/usr/bin/login", 1000, 0);
    await expect(validatePrivilegedProgramProductCandidate({
      candidateFs: candidate,
      policy: reviewedPolicy(),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    })).rejects.toThrow(/root-owned/i);

    candidate.chown("/usr/bin/login", 0, 0);
    candidate.chmod("/usr/bin", 0o775);
    await expect(validatePrivilegedProgramProductCandidate({
      candidateFs: candidate,
      policy: reviewedPolicy(),
      sources: source.sources,
      writableBottleFileSystems: [source.writableBottleFs],
    })).rejects.toThrow(/parent.*writable/i);

    candidate.chmod("/usr/bin", 0o755);
    expect(() => resolveMountSetIdCapability({
      backend: candidate,
      readonly: true,
      setIdCapability: {
        kind: "trusted-root-product",
        guestWritable: false,
        stableExecutableIdentity: true,
      },
    })).toThrow(/immutable product backend/i);
  });

  it("rolls back the entire group when the final projection fails", async () => {
    const source = sourceFixture();
    const invalid = projections();
    invalid[2] = {
      ...invalid[2]!,
      artifactValidationSha256: "d".repeat(64),
    };
    let product: Awaited<ReturnType<typeof publishPrivilegedProgramProduct>> | undefined;
    await expect((async () => {
      product = await publishPrivilegedProgramProduct({
        policy: reviewedPolicy(invalid),
        sources: source.sources,
        writableBottleFileSystems: [source.writableBottleFs],
      });
    })()).rejects.toThrow(/artifact.*digest/i);
    expect(product).toBeUndefined();
    for (const program of PROGRAMS) {
      expect(source.writableBottleFs.lstat(`${SOURCE_ROOT}/${program.sourcePath}`).nlink)
        .toBe(1);
    }
  });
});
