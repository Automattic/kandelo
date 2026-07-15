import { describe, expect, it } from "vitest";
import { ABI_VERSION } from "../src/generated/abi";
import {
  planHomebrewVfs,
  type HomebrewLinkManifest,
  type HomebrewTapMetadata,
} from "../src/homebrew-vfs-planner";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const SHA_D = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const TAP_COMMIT = "1111111111111111111111111111111111111111";
const KANDELO_COMMIT = "2222222222222222222222222222222222222222";

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
      tap_repository: "Automattic/kandelo-homebrew",
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
    full_name: `automattic/kandelo-homebrew/${name}`,
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
    tap_repository: "Automattic/kandelo-homebrew",
    tap_name: "automattic/kandelo-homebrew",
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
      'metadata tap "automattic/kandelo-homebrew" does not match requested tap "example/tools"',
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

  it("rejects a repository alias for the protected first-party tap", async () => {
    let loaded = false;
    await expect(planHomebrewVfs(metadata([packageEntry("hello", "2.12.1")], {
      tap_repository: "Automattic/homebrew-kandelo-homebrew",
    }), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest() {
        loaded = true;
        return linkManifest("hello", "2.12.1");
      },
    })).rejects.toThrow(
      'metadata tap repository "Automattic/homebrew-kandelo-homebrew" cannot claim protected first-party tap',
    );
    expect(loaded).toBe(false);
  });

  it("rejects a tap name that does not match its conventional repository", async () => {
    await expect(planHomebrewVfs(metadata([packageEntry("hello", "2.12.1")], {
      tap_repository: "Example/homebrew-tools",
    }), {
      packages: ["hello"],
      arch: "wasm32",
      loadLinkManifest: manifestMap({}),
    })).rejects.toThrow(
      'metadata tap "automattic/kandelo-homebrew" does not match repository "Example/homebrew-tools"; expected "example/tools"',
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
