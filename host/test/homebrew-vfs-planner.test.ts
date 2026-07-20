import { describe, expect, it } from "vitest";
import { ABI_VERSION } from "../src/generated/abi";
import {
  planFederatedHomebrewVfs,
  planHomebrewVfs,
  type HomebrewLinkManifest,
  type HomebrewTapMetadata,
  type HomebrewVfsTapIdentity,
} from "../src/homebrew-vfs-planner";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const SHA_D = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const TAP_COMMIT = "1111111111111111111111111111111111111111";
const EXTERNAL_TAP_COMMIT = "3333333333333333333333333333333333333333";
const KANDELO_COMMIT = "2222222222222222222222222222222222222222";
const BOTTLE_TAP_COMMIT = "4444444444444444444444444444444444444444";
const BOTTLE_KANDELO_COMMIT = "5555555555555555555555555555555555555555";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function bottle(
  name: string,
  version: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    arch: "wasm32",
    bottle_tag: "wasm32_kandelo",
    kandelo_abi: ABI_VERSION,
    cellar: "/home/linuxbrew/.linuxbrew/Cellar",
    prefix: "/home/linuxbrew/.linuxbrew",
    url: `https://example.invalid/${name}.bottle.tar.gz`,
    sha256: SHA_B,
    bytes: 123,
    cache_key_sha: SHA_C,
    link_manifest: `Kandelo/link/${name}-${version}-rebuild0-wasm32.json`,
    runtime_support: ["node"],
    browser_compatible: false,
    fork_instrumentation: "not-required",
    status: "success",
    built_by: "https://example.invalid/actions/runs/1",
    built_from: {
      kandelo_repository: "Automattic/kandelo",
      kandelo_commit: KANDELO_COMMIT,
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_commit: TAP_COMMIT,
      formula_sha256: SHA_A,
    },
    ...overrides,
  };
}

function packageEntry(
  name: string,
  version: string,
  dependencies: Array<Record<string, unknown>> = [],
  bottles: Array<Record<string, unknown>> = [bottle(name, version)],
): Record<string, unknown> {
  return {
    name,
    full_name: `kandelo-dev/tap-core/${name}`,
    version,
    formula_revision: 0,
    bottle_rebuild: 0,
    formula_path: `Formula/${name}.rb`,
    formula_metadata: `Kandelo/formula/${name}.json`,
    dependencies,
    bottles,
  };
}

function metadata(
  packages: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): HomebrewTapMetadata {
  return {
    schema: 1,
    tap_repository: "kandelo-dev/homebrew-tap-core",
    tap_name: "kandelo-dev/tap-core",
    tap_commit: TAP_COMMIT,
    kandelo_repository: "Automattic/kandelo",
    kandelo_commit: KANDELO_COMMIT,
    kandelo_abi: ABI_VERSION,
    release_tag: `bottles-abi-v${ABI_VERSION}`,
    generated_at: "2026-06-28T00:00:00Z",
    generator: "test",
    packages,
    ...overrides,
  } as unknown as HomebrewTapMetadata;
}

function linkManifest(
  name: string,
  version: string,
  overrides: Record<string, unknown> = {},
): HomebrewLinkManifest {
  return {
    schema: 1,
    package: name,
    version,
    arch: "wasm32",
    kandelo_abi: ABI_VERSION,
    prefix: "/home/linuxbrew/.linuxbrew",
    cellar: "/home/linuxbrew/.linuxbrew/Cellar",
    keg: `/home/linuxbrew/.linuxbrew/Cellar/${name}/${version}`,
    bottle: {
      url: `https://example.invalid/${name}.bottle.tar.gz`,
      sha256: SHA_B,
      bytes: 123,
      cache_key_sha: SHA_C,
      payload_root: `${name}/${version}`,
    },
    links: [
      {
        type: "symlink",
        source: `Cellar/${name}/${version}/bin/${name}`,
        target: `bin/${name}`,
      },
    ],
    receipts: [
      `Cellar/${name}/${version}/.brew/${name}.rb`,
      `Cellar/${name}/${version}/INSTALL_RECEIPT.json`,
    ],
    env: { PATH_prepend: ["bin"] },
    ...overrides,
  } as HomebrewLinkManifest;
}

function manifestMap(
  values: Record<string, HomebrewLinkManifest>,
): (path: string) => HomebrewLinkManifest {
  return (path: string) => {
    const found = values[path];
    if (!found) throw new Error(`unexpected link manifest request ${path}`);
    return found;
  };
}

interface FederatedTapFixture {
  repository: string;
  name: string;
  commit: string;
}

const CORE_TAP: FederatedTapFixture = {
  repository: "kandelo-dev/homebrew-tap-core",
  name: "kandelo-dev/tap-core",
  commit: TAP_COMMIT,
};
const EXTERNAL_TAP: FederatedTapFixture = {
  repository: "brandonpayton/homebrew-kandelo-canary",
  name: "brandonpayton/kandelo-canary",
  commit: EXTERNAL_TAP_COMMIT,
};

function federatedBottleUrl(tap: FederatedTapFixture, name: string, sha256 = SHA_B): string {
  return `https://ghcr.io/v2/${tap.repository}/${name}/blobs/sha256:${sha256}`;
}

function federatedBottle(
  tap: FederatedTapFixture,
  name: string,
  version: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return bottle(name, version, {
    url: federatedBottleUrl(tap, name),
    built_from: {
      kandelo_repository: "Automattic/kandelo",
      kandelo_commit: KANDELO_COMMIT,
      tap_repository: tap.repository,
      tap_commit: tap.commit,
      formula_sha256: SHA_A,
    },
    ...overrides,
  });
}

function federatedPackageEntry(
  tap: FederatedTapFixture,
  name: string,
  version: string,
  dependencies: Array<Record<string, unknown>> = [],
  bottles: Array<Record<string, unknown>> = [federatedBottle(tap, name, version)],
): Record<string, unknown> {
  return {
    ...packageEntry(name, version, dependencies, bottles),
    full_name: `${tap.name}/${name}`,
  };
}

function federatedMetadata(
  tap: FederatedTapFixture,
  packages: Array<Record<string, unknown>>,
): HomebrewTapMetadata {
  return metadata(packages, {
    tap_repository: tap.repository,
    tap_name: tap.name,
    tap_commit: tap.commit,
  });
}

function federatedLinkManifest(
  tap: FederatedTapFixture,
  name: string,
  version: string,
  overrides: Record<string, unknown> = {},
): HomebrewLinkManifest {
  return linkManifest(name, version, {
    bottle: {
      url: federatedBottleUrl(tap, name),
      sha256: SHA_B,
      bytes: 123,
      cache_key_sha: SHA_C,
      payload_root: `${name}/${version}`,
    },
    ...overrides,
  });
}

function federatedManifestMap(
  values: Record<string, HomebrewLinkManifest>,
): (tap: HomebrewVfsTapIdentity, path: string) => HomebrewLinkManifest {
  return (tap, path) => {
    const key = `${tap.tapName}:${path}`;
    const found = values[key];
    if (!found) throw new Error(`unexpected federated link manifest request ${key}`);
    return found;
  };
}

describe("Homebrew VFS planner", () => {
  it("resolves requested packages with dependencies in pour order", async () => {
    const tapMetadata = metadata([
      packageEntry("hello", "2.12.1", [{ name: "zlib", version: "1.3.1" }]),
      packageEntry("zlib", "1.3.1"),
    ]);

    const plan = await planHomebrewVfs(tapMetadata, {
      packages: ["hello"],
      arch: "wasm32",
      runtime: "node",
      expectedCacheKeys: { hello: SHA_C, zlib: SHA_C },
      loadLinkManifest: manifestMap({
        "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json": linkManifest("hello", "2.12.1"),
        "Kandelo/link/zlib-1.3.1-rebuild0-wasm32.json": linkManifest("zlib", "1.3.1"),
      }),
    });

    expect(plan.kandeloAbi).toBe(ABI_VERSION);
    expect(plan.requestedPackages).toEqual(["hello"]);
    expect(plan.packages.map((entry) => entry.name)).toEqual(["zlib", "hello"]);
    expect(plan.packages.map((entry) => entry.linkManifestPath)).toEqual([
      "Kandelo/link/zlib-1.3.1-rebuild0-wasm32.json",
      "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json",
    ]);
  });

  it("attributes strict single-tap bottles to built_from instead of stale catalog globals", async () => {
    const strictUrl = federatedBottleUrl(CORE_TAP, "hello");
    const tapMetadata = metadata([
      packageEntry("hello", "2.12.1", [], [bottle("hello", "2.12.1", {
        url: strictUrl,
        built_from: {
          kandelo_repository: "Automattic/kandelo",
          kandelo_commit: BOTTLE_KANDELO_COMMIT,
          tap_repository: CORE_TAP.repository,
          tap_commit: BOTTLE_TAP_COMMIT,
          formula_sha256: SHA_D,
        },
      })]),
    ]);
    const manifest = linkManifest("hello", "2.12.1", {
      bottle: {
        url: strictUrl,
        sha256: SHA_B,
        bytes: 123,
        cache_key_sha: SHA_C,
        payload_root: "hello/2.12.1",
      },
    });

    const plan = await planHomebrewVfs(tapMetadata, {
      packages: ["hello"],
      arch: "wasm32",
      allowFallback: false,
      loadLinkManifest: () => manifest,
    });

    expect(plan.tapCommit).toBe(TAP_COMMIT);
    expect(plan.kandeloCommit).toBe(KANDELO_COMMIT);
    expect(plan.packages[0]).toMatchObject({
      tapCommit: BOTTLE_TAP_COMMIT,
      kandeloCommit: BOTTLE_KANDELO_COMMIT,
      builtFrom: {
        tapRepository: CORE_TAP.repository,
        tapCommit: BOTTLE_TAP_COMMIT,
        kandeloRepository: "Automattic/kandelo",
        kandeloCommit: BOTTLE_KANDELO_COMMIT,
        formulaSha256: SHA_D,
      },
    });
  });

  it("requires complete built_from provenance for strict single-tap bottles", async () => {
    const strictUrl = federatedBottleUrl(CORE_TAP, "hello");
    const bad = metadata([
      packageEntry("hello", "2.12.1", [], [bottle("hello", "2.12.1", {
        url: strictUrl,
        built_from: {
          kandelo_repository: "Automattic/kandelo",
          kandelo_commit: BOTTLE_KANDELO_COMMIT,
          tap_repository: CORE_TAP.repository,
          tap_commit: BOTTLE_TAP_COMMIT,
          formula_sha256: "stale-global-attribution",
        },
      })]),
    ]);

    await expect(planHomebrewVfs(bad, {
      packages: ["hello"],
      arch: "wasm32",
      allowFallback: false,
      loadLinkManifest: () => linkManifest("hello", "2.12.1"),
    })).rejects.toThrow("built_from formula_sha256 must be a lowercase 64-char sha256");
  });

  it("rejects metadata ABI drift before loading link manifests", async () => {
    let loaded = false;
    const tapMetadata = metadata([packageEntry("hello", "2.12.1")], {
      kandelo_abi: ABI_VERSION - 1,
      release_tag: `bottles-abi-v${ABI_VERSION - 1}`,
    });

    await expect(planHomebrewVfs(tapMetadata, {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest() {
        loaded = true;
        return linkManifest("hello", "2.12.1");
      },
    })).rejects.toThrow(`metadata ABI ${ABI_VERSION - 1} does not match expected ABI ${ABI_VERSION}`);
    expect(loaded).toBe(false);
  });

  it("rejects missing dependency packages", async () => {
    const tapMetadata = metadata([
      packageEntry("hello", "2.12.1", [{ name: "zlib", version: "1.3.1" }]),
    ]);

    await expect(planHomebrewVfs(tapMetadata, {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow('package "hello" dependency "zlib" is not present');
  });

  it("rejects a requested tap mismatch before loading link manifests", async () => {
    let loaded = false;
    await expect(planHomebrewVfs(metadata([packageEntry("hello", "2.12.1")]), {
      packages: ["hello"],
      arch: "wasm32",
      expectedTapName: "example/tools",
      loadLinkManifest() {
        loaded = true;
        return linkManifest("hello", "2.12.1");
      },
    })).rejects.toThrow(
      'metadata tap "kandelo-dev/tap-core" does not match requested tap "example/tools"',
    );
    expect(loaded).toBe(false);
  });

  it("accepts the canonical tap name for a conventional third-party repository", async () => {
    const entry = packageEntry("hello", "2.12.1");
    entry.full_name = "example/tools/hello";
    const plan = await planHomebrewVfs(metadata([entry], {
      tap_repository: "Example/homebrew-tools",
      tap_name: "example/tools",
    }), {
      packages: ["hello"],
      arch: "wasm32",
      expectedTapName: "example/tools",
      loadLinkManifest: manifestMap({
        "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json": linkManifest("hello", "2.12.1"),
      }),
    });

    expect(plan.tapRepository).toBe("Example/homebrew-tools");
    expect(plan.tapName).toBe("example/tools");
  });

  it("rejects a tap name that does not match its conventional repository", async () => {
    await expect(planHomebrewVfs(metadata([packageEntry("hello", "2.12.1")], {
      tap_repository: "Example/homebrew-tools",
    }), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow(
      'metadata tap "kandelo-dev/tap-core" does not match repository "Example/homebrew-tools"; expected "example/tools"',
    );
  });

  it("rejects a third-party repository without the homebrew- prefix", async () => {
    await expect(planHomebrewVfs(metadata([packageEntry("hello", "2.12.1")], {
      tap_repository: "Example/tools",
      tap_name: "example/tools",
    }), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow("must use the conventional owner/homebrew-name form");
  });

  it("rejects package full names that do not belong to the metadata tap", async () => {
    const entry = packageEntry("hello", "2.12.1");
    entry.full_name = "example/tools/hello";
    await expect(planHomebrewVfs(metadata([entry]), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow("does not match tap identity");
  });

  it("bounds explicit package roots and the resolved dependency closure", async () => {
    const names = Array.from({ length: 129 }, (_, index) => `package-${index}`);
    const independent = names.map((name) => packageEntry(name, "1.0"));
    await expect(planHomebrewVfs(metadata(independent), {
      packages: names,
      arch: "wasm32",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow("accepts at most 128 requested packages");

    const chain = names.map((name, index) => packageEntry(
      name,
      "1.0",
      index + 1 < names.length
        ? [{ name: names[index + 1], version: "1.0" }]
        : [],
    ));
    await expect(planHomebrewVfs(metadata(chain), {
      packages: [names[0]],
      arch: "wasm32",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow("dependency closure exceeds 128 packages");
  });

  it("rejects duplicate dependency declarations", async () => {
    await expect(planHomebrewVfs(metadata([
      packageEntry("hello", "2.12.1", [
        { name: "zlib", version: "1.3.1" },
        { name: "zlib", version: "1.3.1" },
      ]),
      packageEntry("zlib", "1.3.1"),
    ]), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow('dependencies has duplicate package "zlib"');
  });

  it("rejects duplicate metadata packages and requested roots", async () => {
    await expect(planHomebrewVfs(metadata([
      packageEntry("hello", "2.12.1"),
      packageEntry("hello", "2.12.1"),
    ]), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow('metadata has duplicate package "hello"');

    await expect(planHomebrewVfs(metadata([
      packageEntry("hello", "2.12.1"),
    ]), {
      packages: ["hello", "hello"],
      arch: "wasm32",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow('requested package "hello" is duplicated');
  });

  it("rejects duplicate link targets", async () => {
    const manifest = linkManifest("hello", "2.12.1");
    manifest.links.push({ ...manifest.links[0] });
    await expect(planHomebrewVfs(metadata([
      packageEntry("hello", "2.12.1"),
    ]), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: () => manifest,
    })).rejects.toThrow('link manifest duplicate target "bin/hello"');
  });

  it("accepts POSIX bracket utility paths while keeping tap paths narrow", async () => {
    const manifest = linkManifest("coreutils", "9.5", {
      links: [{
        type: "symlink",
        source: "Cellar/coreutils/9.5/bin/[",
        target: "bin/[",
      }],
    });
    const plan = await planHomebrewVfs(metadata([
      packageEntry("coreutils", "9.5"),
    ]), {
      packages: ["coreutils"],
      arch: "wasm32",
      loadLinkManifest: () => manifest,
    });

    expect(plan.packages[0].linkManifest.links[0]).toMatchObject({
      source: "Cellar/coreutils/9.5/bin/[",
      target: "bin/[",
    });

    const entry = packageEntry("coreutils", "9.5");
    (entry.bottles as Array<Record<string, unknown>>)[0].link_manifest =
      "Kandelo/link/coreutils-[.json";
    await expect(planHomebrewVfs(metadata([entry]), {
      packages: ["coreutils"],
      arch: "wasm32",
      loadLinkManifest: () => manifest,
    })).rejects.toThrow("must be a safe relative path");
  });

  it("accepts upstream payload filenames containing commas", async () => {
    const texPath = [
      "share/texmf-dist/doc/latex/binarytree/examples",
      "btree-5_up_0,0,0_3729359_7458719_655360_0.7_0.7_-lrr-x--_-llrr-x--_-rll-x--_-rrll-x--.pdf",
    ].join("/");
    const manifest = linkManifest("texlive", "2025", {
      links: [{
        type: "symlink",
        source: `Cellar/texlive/2025/${texPath}`,
        target: texPath,
      }],
    });
    const plan = await planHomebrewVfs(metadata([
      packageEntry("texlive", "2025"),
    ]), {
      packages: ["texlive"],
      arch: "wasm32",
      loadLinkManifest: () => manifest,
    });

    expect(plan.packages[0].linkManifest.links[0]).toMatchObject({
      source: `Cellar/texlive/2025/${texPath}`,
      target: texPath,
    });
  });

  it("rejects dependency cycles", async () => {
    const tapMetadata = metadata([
      packageEntry("alpha", "1.0", [{ name: "beta", version: "1.0" }]),
      packageEntry("beta", "1.0", [{ name: "alpha", version: "1.0" }]),
    ]);

    await expect(planHomebrewVfs(tapMetadata, {
      packages: ["alpha"],
      arch: "wasm32",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow("dependency cycle: alpha -> beta -> alpha");
  });

  it("rejects missing arch bottles", async () => {
    const tapMetadata = metadata([packageEntry("hello", "2.12.1")]);

    await expect(planHomebrewVfs(tapMetadata, {
      packages: ["hello"],
      arch: "wasm64",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow('package "hello" has no wasm64 bottle');
  });

  it("rejects link manifest bottle sha drift before extraction", async () => {
    const tapMetadata = metadata([packageEntry("hello", "2.12.1")]);

    await expect(planHomebrewVfs(tapMetadata, {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: manifestMap({
        "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json": linkManifest("hello", "2.12.1", {
          bottle: {
            url: "https://example.invalid/hello.bottle.tar.gz",
            sha256: SHA_D,
            bytes: 123,
            cache_key_sha: SHA_C,
            payload_root: "hello/2.12.1",
          },
        }),
      }),
    })).rejects.toThrow("link manifest bottle.sha256 does not match metadata");
  });

  it("plans last-green fallback bottles for failed rebuild metadata", async () => {
    const failedBottle = bottle("hello", "2.12.1", {
      status: "failed",
      error: "build failed",
      last_attempt: "2026-06-28T00:00:00Z",
      last_attempt_by: "https://example.invalid/actions/runs/2",
      url: undefined,
      sha256: undefined,
      bytes: undefined,
      cache_key_sha: undefined,
      link_manifest: undefined,
      fallback_url: "https://example.invalid/hello.last-green.bottle.tar.gz",
      fallback_sha256: SHA_D,
      fallback_bytes: 456,
      fallback_cache_key_sha: SHA_C,
      fallback_link_manifest: "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json",
      fallback_built_at: "2026-06-27T00:00:00Z",
    });
    const tapMetadata = metadata([packageEntry("hello", "2.12.1", [], [failedBottle])]);

    const plan = await planHomebrewVfs(tapMetadata, {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: manifestMap({
        "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json": linkManifest("hello", "2.12.1", {
          bottle: {
            url: "https://example.invalid/hello.last-green.bottle.tar.gz",
            sha256: SHA_D,
            bytes: 456,
            cache_key_sha: SHA_C,
            payload_root: "hello/2.12.1",
          },
        }),
      }),
    });

    expect(plan.packages[0].sourceStatus).toBe("fallback");
    expect(plan.packages[0].url).toBe("https://example.invalid/hello.last-green.bottle.tar.gz");
    expect(plan.packages[0].sha256).toBe(SHA_D);
  });
});

describe("federated Homebrew VFS planner", () => {
  const m4ManifestPath = "Kandelo/link/m4-1.4.21-rebuild0-wasm32.json";
  const dashManifestPath = "Kandelo/link/dash-0.5.12-rebuild0-wasm32.json";

  function m4Dependency(): Record<string, unknown> {
    return {
      name: "dash",
      full_name: "kandelo-dev/tap-core/dash",
      version: "0.5.12",
    };
  }

  function successfulMetadata(): HomebrewTapMetadata[] {
    return [
      federatedMetadata(EXTERNAL_TAP, [
        federatedPackageEntry(EXTERNAL_TAP, "m4", "1.4.21", [m4Dependency()]),
      ]),
      federatedMetadata(CORE_TAP, [
        federatedPackageEntry(CORE_TAP, "dash", "0.5.12"),
      ]),
    ];
  }

  function successfulManifests(): Record<string, HomebrewLinkManifest> {
    return {
      [`${EXTERNAL_TAP.name}:${m4ManifestPath}`]:
        federatedLinkManifest(EXTERNAL_TAP, "m4", "1.4.21"),
      [`${CORE_TAP.name}:${dashManifestPath}`]:
        federatedLinkManifest(CORE_TAP, "dash", "0.5.12"),
    };
  }

  it("plans a locked external m4 to core dash closure by full Formula identity", async () => {
    const plan = await planFederatedHomebrewVfs(successfulMetadata(), {
      rootTapName: EXTERNAL_TAP.name,
      packages: ["m4"],
      arch: "wasm32",
      runtime: "node",
      allowFallback: false,
      expectedCacheKeys: {
        [`${EXTERNAL_TAP.name}/m4`]: SHA_C,
        [`${CORE_TAP.name}/dash`]: SHA_C,
      },
      loadLinkManifest: federatedManifestMap(successfulManifests()),
    });

    expect(plan.tapName).toBe(EXTERNAL_TAP.name);
    expect(plan.tapCommit).toBe(EXTERNAL_TAP.commit);
    expect(plan.requestedPackages).toEqual(["m4"]);
    expect(plan.requestedFullNames).toEqual([`${EXTERNAL_TAP.name}/m4`]);
    expect(plan.taps.map((tap) => [tap.tapName, tap.tapRepository, tap.tapCommit])).toEqual([
      [EXTERNAL_TAP.name, EXTERNAL_TAP.repository, EXTERNAL_TAP.commit],
      [CORE_TAP.name, CORE_TAP.repository, CORE_TAP.commit],
    ]);
    expect(plan.packages.map((pkg) => pkg.fullName)).toEqual([
      `${CORE_TAP.name}/dash`,
      `${EXTERNAL_TAP.name}/m4`,
    ]);
    expect(plan.packages.map((pkg) => [pkg.tapName, pkg.tapRepository, pkg.tapCommit])).toEqual([
      [CORE_TAP.name, CORE_TAP.repository, CORE_TAP.commit],
      [EXTERNAL_TAP.name, EXTERNAL_TAP.repository, EXTERNAL_TAP.commit],
    ]);
    expect(plan.packages[1].dependencies).toEqual([{
      name: "dash",
      full_name: `${CORE_TAP.name}/dash`,
      version: "0.5.12",
    }]);
    expect(plan.packages.map((pkg) => pkg.url)).toEqual([
      federatedBottleUrl(CORE_TAP, "dash"),
      federatedBottleUrl(EXTERNAL_TAP, "m4"),
    ]);
  });

  it("keeps package build provenance distinct from heterogeneous metadata provenance", async () => {
    const documents = successfulMetadata();
    const dashBuiltFrom = documents[1].packages[0].bottles[0].built_from as Record<string, unknown>;
    dashBuiltFrom.tap_commit = BOTTLE_TAP_COMMIT;
    dashBuiltFrom.kandelo_commit = BOTTLE_KANDELO_COMMIT;

    const plan = await planFederatedHomebrewVfs(documents, {
      rootTapName: EXTERNAL_TAP.name,
      packages: ["m4"],
      arch: "wasm32",
      runtime: "node",
      allowFallback: false,
      loadLinkManifest: federatedManifestMap(successfulManifests()),
    });

    const dash = plan.packages.find((pkg) => pkg.fullName === `${CORE_TAP.name}/dash`);
    expect(dash).toMatchObject({
      tapCommit: BOTTLE_TAP_COMMIT,
      kandeloCommit: BOTTLE_KANDELO_COMMIT,
    });
    expect(plan.taps.find((tap) => tap.tapName === CORE_TAP.name)?.tapCommit)
      .toBe(CORE_TAP.commit);
  });

  it("rejects an external dependency absent from the locked metadata set", async () => {
    await expect(planFederatedHomebrewVfs([successfulMetadata()[0]], {
      rootTapName: EXTERNAL_TAP.name,
      packages: ["m4"],
      arch: "wasm32",
      loadLinkManifest: federatedManifestMap({}),
    })).rejects.toThrow(
      `dependency "${CORE_TAP.name}/dash" is absent from locked tap metadata`,
    );
  });

  it("rejects repository-root and malformed build-source identities", async () => {
    const badRoot = clone(successfulMetadata());
    badRoot[1].packages[0].bottles[0].url =
      federatedBottleUrl(EXTERNAL_TAP, "dash");
    await expect(planFederatedHomebrewVfs(badRoot, {
      rootTapName: EXTERNAL_TAP.name,
      packages: ["m4"],
      arch: "wasm32",
      loadLinkManifest: federatedManifestMap(successfulManifests()),
    })).rejects.toThrow("does not match repository-rooted GHCR URL");

    const badCommit = clone(successfulMetadata());
    badCommit[1].packages[0].bottles[0].built_from.tap_commit = "not-a-commit";
    await expect(planFederatedHomebrewVfs(badCommit, {
      rootTapName: EXTERNAL_TAP.name,
      packages: ["m4"],
      arch: "wasm32",
      loadLinkManifest: federatedManifestMap(successfulManifests()),
    })).rejects.toThrow("built_from tap commit must be a lowercase 40-char git sha");
  });

  it("rejects cross-tap dependency cycles", async () => {
    const external = federatedMetadata(EXTERNAL_TAP, [
      federatedPackageEntry(EXTERNAL_TAP, "m4", "1.4.21", [m4Dependency()]),
    ]);
    const core = federatedMetadata(CORE_TAP, [
      federatedPackageEntry(CORE_TAP, "dash", "0.5.12", [{
        name: "m4",
        full_name: `${EXTERNAL_TAP.name}/m4`,
        version: "1.4.21",
      }]),
    ]);

    await expect(planFederatedHomebrewVfs([external, core], {
      rootTapName: EXTERNAL_TAP.name,
      packages: ["m4"],
      arch: "wasm32",
      loadLinkManifest: federatedManifestMap({}),
    })).rejects.toThrow(
      `federated dependency cycle: ${EXTERNAL_TAP.name}/m4 -> ` +
      `${CORE_TAP.name}/dash -> ${EXTERNAL_TAP.name}/m4`,
    );
  });

  it("rejects duplicate short Cellar names across selected taps", async () => {
    const external = federatedMetadata(EXTERNAL_TAP, [
      federatedPackageEntry(EXTERNAL_TAP, "m4", "1.4.21", [
        { name: "dash", version: "1.0" },
        m4Dependency(),
      ]),
      federatedPackageEntry(EXTERNAL_TAP, "dash", "1.0"),
    ]);
    const core = federatedMetadata(CORE_TAP, [
      federatedPackageEntry(CORE_TAP, "dash", "0.5.12"),
    ]);

    await expect(planFederatedHomebrewVfs([external, core], {
      rootTapName: EXTERNAL_TAP.name,
      packages: ["m4"],
      arch: "wasm32",
      loadLinkManifest: federatedManifestMap({}),
    })).rejects.toThrow(
      `duplicate Cellar package name "dash": "${EXTERNAL_TAP.name}/dash" and ` +
      `"${CORE_TAP.name}/dash"`,
    );
  });

  it("rejects a package identity assigned to a different metadata tap", async () => {
    const external = federatedMetadata(EXTERNAL_TAP, [
      federatedPackageEntry(EXTERNAL_TAP, "m4", "1.4.21"),
    ]);
    external.packages[0].full_name = `${CORE_TAP.name}/m4`;

    await expect(planFederatedHomebrewVfs([external], {
      rootTapName: EXTERNAL_TAP.name,
      packages: ["m4"],
      arch: "wasm32",
      loadLinkManifest: federatedManifestMap({}),
    })).rejects.toThrow("does not match tap identity");
  });
});
