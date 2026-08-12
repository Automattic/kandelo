import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import {
  assertMainShellGuestCatalogIdentity,
  assertMainShellImageContract,
  assertMainShellOperationalRuntimeFetches,
  requiredMainShellPublicPaths,
} from "./homebrew-main-shell-image-contract";
import { parseHomebrewRuntimeSupportContract } from "../host/src/homebrew-runtime-support";

const lock = JSON.parse(
  readFileSync(resolve("homebrew/main-shell-migration-lock.json"), "utf8"),
) as Record<string, any>;
const runtimeSupport = parseHomebrewRuntimeSupportContract(
  JSON.parse(
    readFileSync(
      resolve("homebrew/main-shell-homebrew-runtime-support.json"),
      "utf8",
    ),
  ),
);
const demoConfigSource = new Uint8Array(
  readFileSync(resolve("homebrew/main-shell-demo.json")),
);

function fixture(): Parameters<typeof assertMainShellImageContract>[0] {
  const roots = lock.packages.map((entry: any) => entry.formula.name);
  const closure = lock.formula_closure as string[];
  const compositionOrder = [
    ...closure,
    ...runtimeSupport.additionalFormulaOrder,
  ];
  const lockedByName = new Map(
    lock.packages.map((entry: any) => [entry.formula.name, entry.formula]),
  );
  const snakePackages = compositionOrder.map((fullName) => {
    const name = fullName.split("/").at(-1)!;
    const locked = lockedByName.get(name) as any;
    const version =
      locked === undefined
        ? "1.0"
        : `${locked.version}${locked.revision === 0 ? "" : `_${locked.revision}`}`;
    const rebuild = locked?.bottle_rebuild ?? 0;
    const sha256 = "2".repeat(64);
    return {
      name,
      full_name: fullName,
      tap_repository: lock.tap_repository,
      tap_name: lock.tap_name,
      tap_commit: "1".repeat(40),
      version,
      arch: "wasm32",
      source_status: "success",
      metadata_status: "success",
      url: `https://ghcr.io/v2/${lock.tap_repository}/${name}/blobs/sha256:${sha256}`,
      sha256,
      cache_key_sha: "3".repeat(64),
      bytes: 1,
      link_manifest: `Kandelo/link/${name}-${version}-rebuild${rebuild}-wasm32.json`,
      built_from: {
        tap_repository: lock.tap_repository,
        tap_commit: "1".repeat(40),
        kandelo_repository: "Automattic/kandelo",
        kandelo_commit: "5".repeat(40),
        formula_sha256: "6".repeat(64),
      },
    };
  });
  const camelPackages = snakePackages.map((entry) => ({
    name: entry.name,
    fullName: entry.full_name,
    tapRepository: entry.tap_repository,
    tapName: entry.tap_name,
    tapCommit: entry.tap_commit,
    version: entry.version,
    arch: entry.arch,
    sourceStatus: entry.source_status,
    cacheKeySha: entry.cache_key_sha,
    builtFrom: {
      tapRepository: entry.built_from.tap_repository,
      tapCommit: entry.built_from.tap_commit,
      kandeloRepository: entry.built_from.kandelo_repository,
      kandeloCommit: entry.built_from.kandelo_commit,
      formulaSha256: entry.built_from.formula_sha256,
    },
  }));
  const lockSha = "4".repeat(64);
  const lockBytes = 1234;
  const catalog = {
    tap_repository: lock.tap_repository,
    tap_name: lock.tap_name,
    checkout_commit: lock.catalog.tap_commit,
  };
  const requestedPackagesSha256 = createHash("sha256")
    .update(JSON.stringify(roots))
    .digest("hex");
  const brewfile = {
    parser: "kandelo-static-brewfile-v1",
    sha256: "7".repeat(64),
    bytes: 123,
  };
  const runtimeState = lock.compatibility.runtime_state.map((entry: any) => {
    const contents =
      entry.kind === "text_file"
        ? new TextEncoder().encode(entry.contents)
        : entry.kind === "empty_file"
          ? new Uint8Array()
          : undefined;
    return {
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      ...(contents === undefined ? {} : { contents }),
    };
  });
  const guestRuntimeState = lock.compatibility.runtime_state.map(
    (entry: any) => {
      const contents =
        entry.kind === "text_file"
          ? new TextEncoder().encode(entry.contents)
          : entry.kind === "empty_file"
            ? new Uint8Array()
            : undefined;
      return {
        requires_package: entry.requires_package,
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        reason: entry.reason,
        ...(contents === undefined
          ? {}
          : {
              content_sha256: createHash("sha256")
                .update(contents)
                .digest("hex"),
              content_bytes: contents.byteLength,
            }),
      };
    },
  );
  const metadataRuntimeState = guestRuntimeState.map((entry: any) => ({
    requiresPackage: entry.requires_package,
    path: entry.path,
    kind: entry.kind,
    mode: entry.mode,
    uid: entry.uid,
    gid: entry.gid,
    reason: entry.reason,
    ...(entry.content_sha256 === undefined
      ? {}
      : {
          contentSha256: entry.content_sha256,
          contentBytes: entry.content_bytes,
        }),
  }));
  const demoSha256 = createHash("sha256")
    .update(demoConfigSource)
    .digest("hex");
  const publicPaths = requiredMainShellPublicPaths(lock).map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    mode: entry.kind === "directory" ? 0o755 : entry.executable ? 0o755 : 0o644,
  }));
  return {
    migrationLock: structuredClone(lock),
    migrationLockSha256: lockSha,
    migrationLockBytes: lockBytes,
    runtimeSupport: structuredClone(runtimeSupport),
    guestManifest: {
      schema: 1,
      selection: {
        kind: "brewfile",
        requested_packages: roots,
        requested_packages_sha256: requestedPackagesSha256,
        brewfile,
      },
      catalog,
      metadata: {
        tap_repository: lock.tap_repository,
        tap_name: lock.tap_name,
        tap_commit: "8".repeat(40),
        release_tag: "bottles-abi-v41",
      },
      migration_lock: { sha256: lockSha, bytes: lockBytes },
      runtime_state: guestRuntimeState,
      packages: snakePackages,
    },
    imageMetadata: {
      capacity: { maxByteLength: lock.consumer.max_vfs_byte_length },
      homebrew: {
        tapRepository: lock.tap_repository,
        tapName: lock.tap_name,
        tapCommit: "8".repeat(40),
        releaseTag: "bottles-abi-v41",
        catalog: {
          tapRepository: catalog.tap_repository,
          tapName: catalog.tap_name,
          checkoutCommit: catalog.checkout_commit,
        },
        migrationLock: { sha256: lockSha, bytes: lockBytes },
        runtimeState: metadataRuntimeState,
        selection: {
          kind: "brewfile",
          requestedPackageCount: roots.length,
          requestedPackagesSha256,
          brewfile: structuredClone(brewfile),
        },
        defaultShell: {
          path: "/opt/kandelo/homebrew/bin/bash",
          argv: ["bash", "-l", "-i"],
        },
        demoConfig: {
          path: "/etc/kandelo/demo.json",
          sha256: demoSha256,
          bytes: demoConfigSource.byteLength,
        },
        packages: camelPackages,
      },
    },
    imageCapacity: {
      byteLength: lock.consumer.max_vfs_byte_length,
      maxByteLength: lock.consumer.max_vfs_byte_length,
    },
    shellConfig: {
      version: 1,
      path: "/opt/kandelo/homebrew/bin/bash",
      argv: ["bash", "-l", "-i"],
    },
    demoConfigSource: demoConfigSource.slice(),
    expectedDemoConfigSource: demoConfigSource.slice(),
    runtimeState,
    publicPaths,
  };
}

test("accepts the exact reviewed root and Formula identities", () => {
  assert.doesNotThrow(() => assertMainShellImageContract(fixture()));
});

test("binds the ABI 43 login product inputs", () => {
  assert.equal(
    lock.catalog.tap_commit,
    "af70e3ba06367dbafb8a95fabbacc3e1352b58b2",
  );
  assert.deepEqual(
    lock.packages
      .map((entry: any) => entry.formula.name)
      .filter((name: string) =>
        ["login", "sudo-lite", "sudo", "ruby"].includes(name),
      ),
    ["login", "sudo-lite", "sudo", "ruby"],
  );
  assert.equal(runtimeSupport.activation.requiredKernelAbi, 43);
  assert.equal(runtimeSupport.availability.auditedCatalog.kandeloAbi, 43);
  assert.equal(
    runtimeSupport.availability.auditedCatalog.releaseTag,
    "bottles-abi-v43",
  );
});

test("bounds operational Homebrew downloads to the reviewed support closure", () => {
  assert.doesNotThrow(() =>
    assertMainShellOperationalRuntimeFetches(runtimeSupport, []),
  );
  assert.doesNotThrow(() =>
    assertMainShellOperationalRuntimeFetches(runtimeSupport, [
      "kandelo-dev/tap-core/coreutils",
      "kandelo-dev/tap-core/ruby",
    ]),
  );
  assert.throws(
    () =>
      assertMainShellOperationalRuntimeFetches(runtimeSupport, [
        "kandelo-dev/tap-core/file-formula",
      ]),
    /outside the reviewed support closure.*file-formula/,
  );
  assert.throws(
    () =>
      assertMainShellOperationalRuntimeFetches(runtimeSupport, [
        "kandelo-dev/tap-core/coreutils",
        "kandelo-dev/tap-core/coreutils",
      ]),
    /operational Homebrew runtime fetches contains a duplicate identity/,
  );
});

test("rejects omitted nonempty runtime-state report sections", () => {
  const value = fixture() as any;
  assert.notEqual(value.migrationLock.compatibility.runtime_state.length, 0);
  delete value.guestManifest.runtime_state;
  delete value.imageMetadata.homebrew.runtimeState;

  assert.throws(
    () => assertMainShellImageContract(value),
    /runtime-state copies do not have the reviewed declaration count/,
  );
});

test("rejects a non-array optional runtime-state report section", () => {
  const value = fixture() as any;
  delete value.guestManifest.runtime_state;
  value.imageMetadata.homebrew.runtimeState = null;

  assert.throws(
    () => assertMainShellImageContract(value),
    /VFS metadata runtimeState must be an array/,
  );
});

test("shares the authoritative guest catalog parser with narrow consumers", () => {
  const guestManifest = fixture().guestManifest as Record<string, any>;
  const expected = {
    tapRepository: lock.tap_repository,
    tapName: lock.tap_name,
    tapCommit: lock.catalog.tap_commit,
  };
  assert.doesNotThrow(() =>
    assertMainShellGuestCatalogIdentity(guestManifest, expected),
  );

  for (const [key, replacement, message] of [
    ["tap_repository", "someone/else", "tap_repository"],
    ["tap_name", "someone/else", "tap_name"],
    ["checkout_commit", "0".repeat(40), "checkout_commit"],
  ] as const) {
    const changed = structuredClone(guestManifest);
    changed.catalog[key] = replacement;
    assert.throws(
      () => assertMainShellGuestCatalogIdentity(changed, expected),
      new RegExp(message),
    );
  }
});

for (const [name, mutate, expected] of [
  [
    "rejects a substituted requested root",
    (value: any) => {
      value.guestManifest.selection.requested_packages[0] = "replacement";
    },
    "requested_packages differs",
  ],
  [
    "rejects a missing closure Formula",
    (value: any) => {
      value.guestManifest.packages.pop();
    },
    "exact closure differs",
  ],
  [
    "rejects a reordered closure Formula",
    (value: any) => {
      [value.guestManifest.packages[0], value.guestManifest.packages[1]] = [
        value.guestManifest.packages[1],
        value.guestManifest.packages[0],
      ];
    },
    "exact closure differs",
  ],
  [
    "rejects a duplicate closure Formula",
    (value: any) => {
      value.guestManifest.packages[1].full_name =
        value.guestManifest.packages[0].full_name;
    },
    "contains a duplicate identity",
  ],
  [
    "rejects a failed bottle source",
    (value: any) => {
      value.guestManifest.packages[0].source_status = "failed";
    },
    "source_status",
  ],
  [
    "rejects a package outside canonical GHCR",
    (value: any) => {
      value.guestManifest.packages[0].url = "https://example.invalid/bottle";
    },
    "url is",
  ],
  [
    "rejects the wrong immutable catalog checkout",
    (value: any) => {
      value.guestManifest.catalog.checkout_commit = "0".repeat(40);
    },
    "checkout_commit",
  ],
  [
    "rejects a stale migration-lock binding",
    (value: any) => {
      value.imageMetadata.homebrew.migrationLock.sha256 = "0".repeat(64);
    },
    "migrationLock sha256",
  ],
  [
    "rejects package provenance that differs between guest and image metadata",
    (value: any) => {
      value.imageMetadata.homebrew.packages[0].tapCommit = "0".repeat(40);
    },
    "tapCommit",
  ],
  [
    "rejects a stale locked root version",
    (value: any) => {
      value.guestManifest.packages.find(
        (entry: any) => entry.name === "bash",
      ).version = "wrong";
      value.imageMetadata.homebrew.packages.find(
        (entry: any) => entry.name === "bash",
      ).version = "wrong";
    },
    "locked version",
  ],
  [
    "rejects a different VFS capacity",
    (value: any) => {
      value.imageCapacity.maxByteLength /= 2;
    },
    "decoded VFS maxByteLength",
  ],
  [
    "rejects a non-Homebrew default shell",
    (value: any) => {
      value.shellConfig.path = "/bin/sh";
    },
    "guest shell config path",
  ],
  [
    "rejects demo config bytes that differ from the canonical contract",
    (value: any) => {
      value.demoConfigSource[0] ^= 1;
    },
    "guest demo config bytes differ",
  ],
  [
    "rejects stale demo config metadata",
    (value: any) => {
      value.imageMetadata.homebrew.demoConfig.sha256 = "0".repeat(64);
    },
    "demoConfig sha256",
  ],
  [
    "rejects a missing public command",
    (value: any) => {
      value.publicPaths = value.publicPaths.filter(
        (entry: any) => entry.path !== "/bin/bash",
      );
    },
    "decoded public paths have",
  ],
  [
    "rejects a non-executable public command",
    (value: any) => {
      value.publicPaths.find((entry: any) => entry.path === "/bin/bash").mode =
        0o644;
    },
    "/bin/bash is not executable",
  ],
  [
    "rejects supporting data with the wrong kind",
    (value: any) => {
      value.publicPaths.find(
        (entry: any) =>
          entry.path === "/opt/kandelo/homebrew/share/misc/magic.mgc",
      ).kind = "directory";
    },
    "magic.mgc decoded kind",
  ],
  [
    "rejects guest runtime state outside the reviewed lock",
    (value: any) => {
      value.guestManifest.runtime_state.push({
        path: "/tmp/unreviewed",
        kind: "directory",
      });
    },
    "runtime-state copies do not have the reviewed declaration count",
  ],
  [
    "rejects image runtime-state metadata outside the reviewed lock",
    (value: any) => {
      value.imageMetadata.homebrew.runtimeState.push({
        path: "/tmp/unreviewed",
        kind: "directory",
      });
    },
    "runtime-state copies do not have the reviewed declaration count",
  ],
  [
    "rejects decoded runtime state outside the reviewed lock",
    (value: any) => {
      value.runtimeState.push({
        path: "/tmp/unreviewed",
        kind: "directory",
        mode: 0o755,
        uid: 0,
        gid: 0,
      });
    },
    "runtime-state copies do not have the reviewed declaration count",
  ],
] as const) {
  test(name, () => {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => assertMainShellImageContract(value),
      new RegExp(expected),
    );
  });
}
