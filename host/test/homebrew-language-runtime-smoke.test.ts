import { describe, expect, it } from "vitest";

import { LANGUAGE_RUNTIME_INVOCATIONS } from "../../scripts/homebrew-language-runtime-contract";
import {
  parseCompositionExpectation,
  validateComposition,
  validateLanguageRuntimeResult,
  type CompositionExpectation,
  type LanguageRuntimeExpectation,
} from "../../scripts/homebrew-language-runtime-smoke";

const expectation: LanguageRuntimeExpectation = {
  label: "Homebrew python3",
  expectedStdout: "python-runtime-ok:/home/linuxbrew/.linuxbrew/bin/python3\n",
};

const compatibilityLinkSpecs = [
  ["/bin/dash", "dash", "dash"],
  ["/usr/bin/dash", "dash", "dash"],
  ["/bin/sh", "dash", "dash"],
  ["/usr/bin/sh", "dash", "dash"],
  ["/bin/python", "python", "python"],
  ["/usr/bin/python", "python", "python"],
  ["/bin/python3", "python", "python3"],
  ["/usr/bin/python3", "python", "python3"],
  ["/bin/python3.13", "python", "python3.13"],
  ["/usr/bin/python3.13", "python", "python3.13"],
  ["/bin/erl", "erlang", "erl"],
  ["/usr/bin/erl", "erlang", "erl"],
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return value as Array<Record<string, unknown>>;
}

function compositionExpectationValue(): Record<string, unknown> {
  const packages = [
    ["dash", "0.5.12", 0, 0, "published"],
    ["zlib", "1.3.1_4", 4, 1, "published"],
    ["python", "3.13.3_1", 1, 0, "local-synthetic"],
    ["erlang", "28.2_1", 1, 0, "local-synthetic"],
  ] as const;
  return {
    schema: 1,
    tap_commit: "a".repeat(40),
    kandelo_commit: "f".repeat(40),
    packages: packages.map(
      (
        [name, version, formulaRevision, bottleRebuild, provenanceKind],
        index,
      ) => ({
        name,
        version,
        formula_revision: formulaRevision,
        bottle_rebuild: bottleRebuild,
        cache_key_sha: String(index + 1).repeat(64),
        formula_sha256: String(index + 5).repeat(64),
        built_from_tap_commit:
          name === "python" || name === "erlang"
            ? "a".repeat(40)
            : String.fromCharCode(98 + index).repeat(40),
        built_from_kandelo_commit:
          name === "python" || name === "erlang"
            ? "f".repeat(40)
            : String(index + 1).repeat(40),
        built_by:
          provenanceKind === "published"
            ? `https://github.com/kandelo-dev/homebrew-tap-core/actions/runs/${100 + index}`
            : `https://localhost.invalid/kandelo/${name}-fixture`,
        provenance_kind: provenanceKind,
      }),
    ),
  };
}

function compositionDocuments(expectation: CompositionExpectation): {
  metadata: Record<string, unknown>;
  report: Record<string, unknown>;
} {
  return {
    metadata: {
      schema: 1,
      tap_repository: "kandelo-dev/homebrew-tap-core",
      tap_name: "kandelo-dev/tap-core",
      tap_commit: expectation.tapCommit,
      kandelo_repository: "Automattic/kandelo",
      kandelo_commit: expectation.kandeloCommit,
      kandelo_abi: 41,
      release_tag: "bottles-abi-v41",
      packages: expectation.packages.map((pkg) => ({
        name: pkg.name,
        full_name: `kandelo-dev/tap-core/${pkg.name}`,
        version: pkg.version,
        formula_revision: pkg.formulaRevision,
        bottle_rebuild: pkg.bottleRebuild,
        bottles: [
          {
            arch: "wasm32",
            cache_key_sha: pkg.cacheKeySha,
            sha256: pkg.cacheKeySha,
            built_by: pkg.builtBy,
            url: `https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/${pkg.name}/blobs/sha256:${pkg.cacheKeySha}`,
            built_from: {
              tap_repository: "kandelo-dev/homebrew-tap-core",
              tap_commit: pkg.builtFromTapCommit,
              kandelo_repository: "Automattic/kandelo",
              kandelo_commit: pkg.builtFromKandeloCommit,
              formula_sha256: pkg.formulaSha256,
            },
          },
        ],
      })),
    },
    report: {
      metadata: {
        tap_repository: "kandelo-dev/homebrew-tap-core",
        tap_name: "kandelo-dev/tap-core",
        tap_commit: expectation.tapCommit,
        kandelo_repository: "Automattic/kandelo",
        kandelo_commit: expectation.kandeloCommit,
        kandelo_abi: 41,
        release_tag: "bottles-abi-v41",
      },
      selection: {
        kind: "packages",
        requested_packages: ["dash", "python", "erlang"],
      },
      packages: expectation.packages.map((pkg) => ({
        name: pkg.name,
        full_name: `kandelo-dev/tap-core/${pkg.name}`,
        tap_repository: "kandelo-dev/homebrew-tap-core",
        tap_name: "kandelo-dev/tap-core",
        tap_commit: pkg.builtFromTapCommit,
        version: pkg.version,
        arch: "wasm32",
        url: `https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/${pkg.name}/blobs/sha256:${pkg.cacheKeySha}`,
        cache_key_sha: pkg.cacheKeySha,
        sha256: pkg.cacheKeySha,
        prefix: "/home/linuxbrew/.linuxbrew",
        keg: `/home/linuxbrew/.linuxbrew/Cellar/${pkg.name}/${pkg.version}`,
        built_from: {
          tap_repository: "kandelo-dev/homebrew-tap-core",
          tap_commit: pkg.builtFromTapCommit,
          kandelo_repository: "Automattic/kandelo",
          kandelo_commit: pkg.builtFromKandeloCommit,
          formula_sha256: pkg.formulaSha256,
        },
      })),
      compatibility_links: compatibilityLinkSpecs.map(
        ([path, packageName, targetName]) => ({
          path,
          package: `kandelo-dev/tap-core/${packageName}`,
          target: `/home/linuxbrew/.linuxbrew/bin/${targetName}`,
        }),
      ),
    },
  };
}

interface ExpectationFailureCase {
  label: string;
  mutate: (value: Record<string, unknown>) => unknown;
  error: RegExp;
}

const expectationFailureCases: ExpectationFailureCase[] = [
  {
    label: "requires an object root",
    mutate: () => [],
    error: /composition expectation must be an object/,
  },
  {
    label: "requires schema 1",
    mutate: (value) => ({ ...value, schema: "1" }),
    error: /composition expectation\.schema/,
  },
  {
    label: "requires a string tap commit",
    mutate: (value) => ({ ...value, tap_commit: 42 }),
    error: /tap_commit must be a nonempty string/,
  },
  {
    label: "requires a full lowercase tap commit",
    mutate: (value) => ({ ...value, tap_commit: "A".repeat(40) }),
    error: /tap_commit must be a full Git SHA/,
  },
  {
    label: "requires a string Kandelo commit",
    mutate: (value) => ({ ...value, kandelo_commit: 42 }),
    error: /kandelo_commit must be a nonempty string/,
  },
  {
    label: "requires a full lowercase Kandelo commit",
    mutate: (value) => ({ ...value, kandelo_commit: "F".repeat(40) }),
    error: /kandelo_commit must be a full Git SHA/,
  },
  {
    label: "requires a package array",
    mutate: (value) => ({ ...value, packages: {} }),
    error: /packages must be an array/,
  },
  {
    label: "requires the exact package count",
    mutate: (value) => {
      asRecords(value.packages).pop();
      return value;
    },
    error: /package names/,
  },
  {
    label: "requires the exact package order",
    mutate: (value) => {
      const packages = asRecords(value.packages);
      [packages[0], packages[1]] = [packages[1], packages[0]];
      return value;
    },
    error: /package names/,
  },
  {
    label: "rejects duplicate package names",
    mutate: (value) => {
      const packages = asRecords(value.packages);
      packages[3] = structuredClone(packages[2]);
      return value;
    },
    error: /package names/,
  },
  {
    label: "rejects unsupported package names",
    mutate: (value) => {
      asRecords(value.packages)[0].name = "ruby";
      return value;
    },
    error: /name is not in the runtime closure/,
  },
  {
    label: "requires a string version",
    mutate: (value) => {
      asRecords(value.packages)[0].version = 512;
      return value;
    },
    error: /version must be a nonempty string/,
  },
  {
    label: "requires the contracted version",
    mutate: (value) => {
      asRecords(value.packages)[0].version = "0.5.11";
      return value;
    },
    error: /version\/revision\/rebuild/,
  },
  {
    label: "requires an integer Formula revision",
    mutate: (value) => {
      asRecords(value.packages)[2].formula_revision = "1";
      return value;
    },
    error: /formula_revision must be a nonnegative integer/,
  },
  {
    label: "requires the contracted Formula revision",
    mutate: (value) => {
      asRecords(value.packages)[2].formula_revision = 2;
      return value;
    },
    error: /version\/revision\/rebuild/,
  },
  {
    label: "requires a nonnegative integer bottle rebuild",
    mutate: (value) => {
      asRecords(value.packages)[1].bottle_rebuild = -1;
      return value;
    },
    error: /bottle_rebuild must be a nonnegative integer/,
  },
  {
    label: "requires the contracted bottle rebuild",
    mutate: (value) => {
      asRecords(value.packages)[1].bottle_rebuild = 0;
      return value;
    },
    error: /version\/revision\/rebuild/,
  },
  {
    label: "requires a lowercase bottle SHA-256",
    mutate: (value) => {
      asRecords(value.packages)[0].cache_key_sha = "A".repeat(64);
      return value;
    },
    error: /bottle and formula hashes must be lowercase SHA-256/,
  },
  {
    label: "requires a 64-digit Formula SHA-256",
    mutate: (value) => {
      asRecords(value.packages)[0].formula_sha256 = "5".repeat(63);
      return value;
    },
    error: /bottle and formula hashes must be lowercase SHA-256/,
  },
  {
    label: "requires a full built-from tap SHA",
    mutate: (value) => {
      asRecords(value.packages)[0].built_from_tap_commit = "b".repeat(39);
      return value;
    },
    error: /built_from_tap_commit must be a full Git SHA/,
  },
  {
    label: "requires a full built-from Kandelo SHA",
    mutate: (value) => {
      asRecords(value.packages)[0].built_from_kandelo_commit = "1".repeat(39);
      return value;
    },
    error: /built_from_kandelo_commit must be a full Git SHA/,
  },
  {
    label: "binds Python source to the candidate tap commit",
    mutate: (value) => {
      asRecords(value.packages)[2].built_from_tap_commit = "f".repeat(40);
      return value;
    },
    error: /python\.built_from_tap_commit must equal tap_commit/,
  },
  {
    label: "binds Erlang source to the candidate tap commit",
    mutate: (value) => {
      asRecords(value.packages)[3].built_from_tap_commit = "f".repeat(40);
      return value;
    },
    error: /erlang\.built_from_tap_commit must equal tap_commit/,
  },
  {
    label: "binds Python build source to the candidate Kandelo commit",
    mutate: (value) => {
      asRecords(value.packages)[2].built_from_kandelo_commit = "e".repeat(40);
      return value;
    },
    error: /python\.built_from_kandelo_commit must equal kandelo_commit/,
  },
  {
    label: "binds Erlang build source to the candidate Kandelo commit",
    mutate: (value) => {
      asRecords(value.packages)[3].built_from_kandelo_commit = "e".repeat(40);
      return value;
    },
    error: /erlang\.built_from_kandelo_commit must equal kandelo_commit/,
  },
  {
    label: "rejects an unknown provenance kind",
    mutate: (value) => {
      asRecords(value.packages)[0].provenance_kind = "cached";
      return value;
    },
    error: /provenance_kind is invalid/,
  },
  {
    label: "rejects local provenance with a published origin",
    mutate: (value) => {
      asRecords(value.packages)[2].built_by =
        "https://github.com/kandelo-dev/homebrew-tap-core/actions/runs/123";
      return value;
    },
    error: /does not match its local-synthetic provenance origin/,
  },
  {
    label: "rejects published provenance with a local origin",
    mutate: (value) => {
      asRecords(value.packages)[0].built_by =
        "https://localhost.invalid/kandelo/dash-fixture";
      return value;
    },
    error: /does not match its published provenance origin/,
  },
  {
    label: "rejects malformed local provenance origins",
    mutate: (value) => {
      asRecords(value.packages)[2].built_by =
        "http://localhost.invalid/kandelo/python-fixture";
      return value;
    },
    error: /does not match its local-synthetic provenance origin/,
  },
  {
    label: "rejects malformed published provenance origins",
    mutate: (value) => {
      asRecords(value.packages)[0].built_by =
        "https://github.com/kandelo-dev/homebrew-tap-core/actions/runs/0";
      return value;
    },
    error: /does not match its published provenance origin/,
  },
];

type CompositionDocuments = ReturnType<typeof compositionDocuments>;

function metadataPackage(
  documents: CompositionDocuments,
  index = 0,
): Record<string, unknown> {
  return asRecords(asRecord(documents.metadata).packages)[index];
}

function metadataBottle(
  documents: CompositionDocuments,
): Record<string, unknown> {
  return asRecords(metadataPackage(documents).bottles)[0];
}

function reportPackage(
  documents: CompositionDocuments,
  index = 0,
): Record<string, unknown> {
  return asRecords(asRecord(documents.report).packages)[index];
}

function compatibilityLink(
  documents: CompositionDocuments,
  path: string,
): Record<string, unknown> {
  const link = asRecords(asRecord(documents.report).compatibility_links).find(
    (value) => value.path === path,
  );
  if (!link) throw new Error(`fixture is missing ${path}`);
  return link;
}

interface CompositionFailureCase {
  label: string;
  mutate: (documents: CompositionDocuments) => void;
  error: RegExp;
}

const compositionFailureCases: CompositionFailureCase[] = [
  {
    label: "binds the metadata schema",
    mutate: ({ metadata }) => {
      asRecord(metadata).schema = 2;
    },
    error: /Homebrew metadata\.schema/,
  },
  {
    label: "binds the metadata tap repository",
    mutate: ({ metadata }) => {
      asRecord(metadata).tap_repository = "Automattic/homebrew-tap-core";
    },
    error: /Homebrew metadata\.tap_repository/,
  },
  {
    label: "binds the metadata tap name",
    mutate: ({ metadata }) => {
      asRecord(metadata).tap_name = "automattic/tap-core";
    },
    error: /Homebrew metadata\.tap_name/,
  },
  {
    label: "binds the metadata tap commit",
    mutate: ({ metadata }) => {
      asRecord(metadata).tap_commit = "f".repeat(40);
    },
    error: /Homebrew metadata\.tap_commit/,
  },
  {
    label: "binds the metadata ABI",
    mutate: ({ metadata }) => {
      asRecord(metadata).kandelo_abi = 40;
    },
    error: /Homebrew metadata\.kandelo_abi/,
  },
  {
    label: "binds the metadata Kandelo repository",
    mutate: ({ metadata }) => {
      asRecord(metadata).kandelo_repository = "kandelo-dev/kandelo";
    },
    error: /Homebrew metadata\.kandelo_repository/,
  },
  {
    label: "binds the metadata Kandelo commit",
    mutate: ({ metadata }) => {
      asRecord(metadata).kandelo_commit = "e".repeat(40);
    },
    error: /Homebrew metadata\.kandelo_commit/,
  },
  {
    label: "binds the metadata release tag",
    mutate: ({ metadata }) => {
      asRecord(metadata).release_tag = "bottles-abi-v40";
    },
    error: /Homebrew metadata\.release_tag/,
  },
  {
    label: "binds the report metadata tap repository",
    mutate: ({ report }) => {
      asRecord(asRecord(report).metadata).tap_repository =
        "Automattic/homebrew-tap-core";
    },
    error: /Homebrew VFS report\.metadata\.tap_repository/,
  },
  {
    label: "binds the report metadata tap name",
    mutate: ({ report }) => {
      asRecord(asRecord(report).metadata).tap_name = "automattic/tap-core";
    },
    error: /Homebrew VFS report\.metadata\.tap_name/,
  },
  {
    label: "binds the report metadata tap commit",
    mutate: ({ report }) => {
      asRecord(asRecord(report).metadata).tap_commit = "f".repeat(40);
    },
    error: /Homebrew VFS report\.metadata\.tap_commit/,
  },
  {
    label: "binds the report metadata ABI",
    mutate: ({ report }) => {
      asRecord(asRecord(report).metadata).kandelo_abi = 40;
    },
    error: /Homebrew VFS report\.metadata\.kandelo_abi/,
  },
  {
    label: "binds the report metadata Kandelo repository",
    mutate: ({ report }) => {
      asRecord(asRecord(report).metadata).kandelo_repository =
        "kandelo-dev/kandelo";
    },
    error: /Homebrew VFS report\.metadata\.kandelo_repository/,
  },
  {
    label: "binds the report metadata Kandelo commit",
    mutate: ({ report }) => {
      asRecord(asRecord(report).metadata).kandelo_commit = "e".repeat(40);
    },
    error: /Homebrew VFS report\.metadata\.kandelo_commit/,
  },
  {
    label: "binds the report metadata release tag",
    mutate: ({ report }) => {
      asRecord(asRecord(report).metadata).release_tag = "bottles-abi-v40";
    },
    error: /Homebrew VFS report\.metadata\.release_tag/,
  },
  {
    label: "requires package selection",
    mutate: ({ report }) => {
      asRecord(asRecord(report).selection).kind = "all";
    },
    error: /Homebrew VFS report\.selection\.kind/,
  },
  {
    label: "binds requested package roots and order",
    mutate: ({ report }) => {
      asRecord(asRecord(report).selection).requested_packages = [
        "dash",
        "erlang",
        "python",
      ];
    },
    error: /requested_packages/,
  },
  {
    label: "requires the exact report package count",
    mutate: ({ report }) => {
      asRecords(asRecord(report).packages).pop();
    },
    error: /has 3 packages, expected 4/,
  },
  {
    label: "requires exact report package order",
    mutate: ({ report }) => {
      const packages = asRecords(asRecord(report).packages);
      [packages[0], packages[1]] = [packages[1], packages[0]];
    },
    error: /Homebrew VFS report package names/,
  },
  {
    label: "rejects duplicate report package names",
    mutate: ({ report }) => {
      const packages = asRecords(asRecord(report).packages);
      packages[1] = structuredClone(packages[0]);
    },
    error: /Homebrew VFS report package names/,
  },
  {
    label: "requires each metadata package name",
    mutate: (documents) => {
      metadataPackage(documents).name = "not-dash";
    },
    error: /must contain exactly one dash record/,
  },
  {
    label: "rejects duplicate metadata package names",
    mutate: (documents) => {
      metadataPackage(documents, 1).name = "dash";
    },
    error: /must contain exactly one dash record/,
  },
  {
    label: "binds metadata package full name",
    mutate: (documents) => {
      metadataPackage(documents).full_name = "automattic/tap-core/dash";
    },
    error: /Homebrew metadata package dash\.full_name/,
  },
  {
    label: "binds metadata package version",
    mutate: (documents) => {
      metadataPackage(documents).version = "0.5.11";
    },
    error: /Homebrew metadata package dash\.version/,
  },
  {
    label: "binds metadata Formula revision",
    mutate: (documents) => {
      metadataPackage(documents).formula_revision = 1;
    },
    error: /Homebrew metadata package dash\.formula_revision/,
  },
  {
    label: "binds metadata bottle rebuild",
    mutate: (documents) => {
      metadataPackage(documents).bottle_rebuild = 1;
    },
    error: /Homebrew metadata package dash\.bottle_rebuild/,
  },
  {
    label: "requires one wasm32 metadata bottle",
    mutate: (documents) => {
      metadataBottle(documents).arch = "x86_64";
    },
    error: /must have one wasm32 bottle/,
  },
  {
    label: "rejects duplicate wasm32 metadata bottles",
    mutate: (documents) => {
      asRecords(metadataPackage(documents).bottles).push(
        structuredClone(metadataBottle(documents)),
      );
    },
    error: /must have one wasm32 bottle/,
  },
  {
    label: "binds metadata bottle cache key",
    mutate: (documents) => {
      metadataBottle(documents).cache_key_sha = "f".repeat(64);
    },
    error: /Homebrew metadata package dash bottle\.cache_key_sha/,
  },
  {
    label: "binds metadata bottle SHA",
    mutate: (documents) => {
      metadataBottle(documents).sha256 = "f".repeat(64);
    },
    error: /Homebrew metadata package dash bottle\.sha256/,
  },
  {
    label: "binds metadata bottle builder origin",
    mutate: (documents) => {
      metadataBottle(documents).built_by = "https://example.invalid/build";
    },
    error: /Homebrew metadata package dash bottle\.built_by/,
  },
  {
    label: "binds metadata bottle repository-rooted URL",
    mutate: (documents) => {
      metadataBottle(documents).url =
        "https://ghcr.io/v2/automattic/homebrew-tap-core/dash/blobs/sha256:" +
        "1".repeat(64);
    },
    error: /Homebrew metadata package dash bottle\.url/,
  },
  {
    label: "binds metadata bottle source tap repository",
    mutate: (documents) => {
      asRecord(metadataBottle(documents).built_from).tap_repository =
        "Automattic/homebrew-tap-core";
    },
    error: /Homebrew metadata package dash bottle\.built_from\.tap_repository/,
  },
  {
    label: "binds metadata bottle source tap commit",
    mutate: (documents) => {
      asRecord(metadataBottle(documents).built_from).tap_commit = "f".repeat(
        40,
      );
    },
    error: /Homebrew metadata package dash bottle\.built_from\.tap_commit/,
  },
  {
    label: "binds metadata bottle source Formula hash",
    mutate: (documents) => {
      asRecord(metadataBottle(documents).built_from).formula_sha256 =
        "f".repeat(64);
    },
    error: /Homebrew metadata package dash bottle\.built_from\.formula_sha256/,
  },
  {
    label: "binds metadata bottle source Kandelo repository",
    mutate: (documents) => {
      asRecord(metadataBottle(documents).built_from).kandelo_repository =
        "kandelo-dev/kandelo";
    },
    error:
      /Homebrew metadata package dash bottle\.built_from\.kandelo_repository/,
  },
  {
    label: "binds metadata bottle source Kandelo commit",
    mutate: (documents) => {
      asRecord(metadataBottle(documents).built_from).kandelo_commit =
        "e".repeat(40);
    },
    error: /Homebrew metadata package dash bottle\.built_from\.kandelo_commit/,
  },
  {
    label: "binds report package version",
    mutate: (documents) => {
      reportPackage(documents).version = "0.5.11";
    },
    error: /Homebrew VFS report package dash\.version/,
  },
  {
    label: "binds report package full name",
    mutate: (documents) => {
      reportPackage(documents).full_name = "automattic/tap-core/dash";
    },
    error: /Homebrew VFS report package dash\.full_name/,
  },
  {
    label: "binds report package tap repository",
    mutate: (documents) => {
      reportPackage(documents).tap_repository = "Automattic/homebrew-tap-core";
    },
    error: /Homebrew VFS report package dash\.tap_repository/,
  },
  {
    label: "binds report package tap name",
    mutate: (documents) => {
      reportPackage(documents).tap_name = "automattic/tap-core";
    },
    error: /Homebrew VFS report package dash\.tap_name/,
  },
  {
    label: "binds report package tap commit",
    mutate: (documents) => {
      reportPackage(documents).tap_commit = "e".repeat(40);
    },
    error: /Homebrew VFS report package dash\.tap_commit/,
  },
  {
    label: "binds report package cache key",
    mutate: (documents) => {
      reportPackage(documents).cache_key_sha = "f".repeat(64);
    },
    error: /Homebrew VFS report package dash\.cache_key_sha/,
  },
  {
    label: "binds report package SHA",
    mutate: (documents) => {
      reportPackage(documents).sha256 = "f".repeat(64);
    },
    error: /Homebrew VFS report package dash\.sha256/,
  },
  {
    label: "binds report package architecture",
    mutate: (documents) => {
      reportPackage(documents).arch = "wasm64";
    },
    error: /Homebrew VFS report package dash\.arch/,
  },
  {
    label: "binds report package repository-rooted URL",
    mutate: (documents) => {
      reportPackage(documents).url =
        "https://ghcr.io/v2/automattic/homebrew-tap-core/dash/blobs/sha256:" +
        "1".repeat(64);
    },
    error: /Homebrew VFS report package dash\.url/,
  },
  {
    label: "binds report package prefix",
    mutate: (documents) => {
      reportPackage(documents).prefix = "/opt/homebrew";
    },
    error: /Homebrew VFS report package dash\.prefix/,
  },
  {
    label: "binds report package keg",
    mutate: (documents) => {
      reportPackage(documents).keg =
        "/home/linuxbrew/.linuxbrew/Cellar/dash/0.5.11";
    },
    error: /Homebrew VFS report package dash\.keg/,
  },
  {
    label: "binds report package source tap repository",
    mutate: (documents) => {
      asRecord(reportPackage(documents).built_from).tap_repository =
        "Automattic/homebrew-tap-core";
    },
    error: /Homebrew VFS report package dash\.built_from\.tap_repository/,
  },
  {
    label: "binds report package source tap commit",
    mutate: (documents) => {
      asRecord(reportPackage(documents).built_from).tap_commit = "f".repeat(40);
    },
    error: /Homebrew VFS report package dash\.built_from\.tap_commit/,
  },
  {
    label: "binds report package source Formula hash",
    mutate: (documents) => {
      asRecord(reportPackage(documents).built_from).formula_sha256 = "f".repeat(
        64,
      );
    },
    error: /Homebrew VFS report package dash\.built_from\.formula_sha256/,
  },
  {
    label: "binds report package source Kandelo repository",
    mutate: (documents) => {
      asRecord(reportPackage(documents).built_from).kandelo_repository =
        "kandelo-dev/kandelo";
    },
    error: /Homebrew VFS report package dash\.built_from\.kandelo_repository/,
  },
  {
    label: "binds report package source Kandelo commit",
    mutate: (documents) => {
      asRecord(reportPackage(documents).built_from).kandelo_commit = "e".repeat(
        40,
      );
    },
    error: /Homebrew VFS report package dash\.built_from\.kandelo_commit/,
  },
  ...compatibilityLinkSpecs.map(
    ([path]): CompositionFailureCase => ({
      label: `requires exactly one ${path} compatibility link`,
      mutate: ({ report }) => {
        asRecord(report).compatibility_links = asRecords(
          asRecord(report).compatibility_links,
        ).filter((link) => link.path !== path);
      },
      error: new RegExp(`exactly one ${path.replaceAll("/", "\\/")} record`),
    }),
  ),
  {
    label: "rejects duplicate compatibility link paths",
    mutate: (documents) => {
      asRecords(asRecord(documents.report).compatibility_links).push(
        structuredClone(compatibilityLink(documents, "/bin/python")),
      );
    },
    error: /exactly one \/bin\/python record/,
  },
  {
    label: "binds compatibility link package ownership",
    mutate: (documents) => {
      compatibilityLink(documents, "/usr/bin/erl").package =
        "kandelo-dev/tap-core/python";
    },
    error: /compatibility link \/usr\/bin\/erl\.package/,
  },
  {
    label: "binds compatibility link targets",
    mutate: (documents) => {
      compatibilityLink(documents, "/usr/bin/python3.13").target =
        "/home/linuxbrew/.linuxbrew/bin/python3";
    },
    error: /compatibility link \/usr\/bin\/python3\.13\.target/,
  },
];

describe("Homebrew language runtime smoke result validation", () => {
  it("accepts an exact synthetic composition contract", () => {
    const parsed = parseCompositionExpectation(compositionExpectationValue());
    const documents = compositionDocuments(parsed);
    expect(() =>
      validateComposition(documents.metadata, documents.report, parsed),
    ).not.toThrow();
  });

  it.each(expectationFailureCases)("$label", ({ mutate, error }) => {
    const value = compositionExpectationValue();
    expect(() => parseCompositionExpectation(mutate(value))).toThrow(error);
  });

  it.each(compositionFailureCases)("$label", ({ mutate, error }) => {
    const parsed = parseCompositionExpectation(compositionExpectationValue());
    const documents = compositionDocuments(parsed);
    mutate(documents);
    expect(() =>
      validateComposition(documents.metadata, documents.report, parsed),
    ).toThrow(error);
  });

  it("fixes all fourteen installed shell entry points without runtime overrides", () => {
    expect(LANGUAGE_RUNTIME_INVOCATIONS.map(({ label }) => label)).toEqual([
      "Homebrew python (global)",
      "Homebrew python (/bin)",
      "Homebrew python (/usr/bin)",
      "Homebrew python3 (global)",
      "Homebrew python3 (/bin)",
      "Homebrew python3 (/usr/bin)",
      "Homebrew python3.13 (global)",
      "Homebrew python3.13 (/bin)",
      "Homebrew python3.13 (/usr/bin)",
      "Homebrew erl (global)",
      "Homebrew erl (bin)",
      "Homebrew erl (usr-bin)",
      "Homebrew erl (opt)",
      "Homebrew erl (keg)",
    ]);
    expect(LANGUAGE_RUNTIME_INVOCATIONS.map(({ argv }) => argv[4])).toEqual([
      "python",
      "/bin/python",
      "/usr/bin/python",
      "python3",
      "/bin/python3",
      "/usr/bin/python3",
      "python3.13",
      "/bin/python3.13",
      "/usr/bin/python3.13",
      "erl",
      "/bin/erl",
      "/usr/bin/erl",
      "/home/linuxbrew/.linuxbrew/opt/erlang/bin/erl",
      "/home/linuxbrew/.linuxbrew/Cellar/erlang/28.2_1/bin/erl",
    ]);
    for (const invocation of LANGUAGE_RUNTIME_INVOCATIONS) {
      expect(invocation.executable).toBe("/bin/sh");
      expect(invocation.argv.slice(0, 4)).toEqual([
        "/bin/sh",
        "-c",
        'exec "$@"',
        "sh",
      ]);
      expect(invocation.argv).not.toContain("-boot");
      const serialized = JSON.stringify(invocation.argv);
      for (const override of [
        "PYTHONHOME",
        "ROOTDIR",
        "BINDIR",
        "EMU",
        "PROGNAME",
      ]) {
        expect(serialized).not.toContain(override);
      }
    }
  });

  it("accepts exact clean output", () => {
    expect(() =>
      validateLanguageRuntimeResult(expectation, {
        exitCode: 0,
        stdout: expectation.expectedStdout,
        stderr: "",
      }),
    ).not.toThrow();
  });

  it("rejects startup diagnostics even when the command succeeds", () => {
    expect(() =>
      validateLanguageRuntimeResult(expectation, {
        exitCode: 0,
        stdout: expectation.expectedStdout,
        stderr: "Could not find platform dependent libraries <exec_prefix>\n",
      }),
    ).toThrow(/wrote unexpected stderr/);
  });

  it("rejects nonzero status and mismatched output", () => {
    expect(() =>
      validateLanguageRuntimeResult(expectation, {
        exitCode: 127,
        stdout: "",
        stderr: "erl: not found\n",
      }),
    ).toThrow(/exited 127/);
    expect(() =>
      validateLanguageRuntimeResult(expectation, {
        exitCode: 0,
        stdout: "wrong\n",
        stderr: "",
      }),
    ).toThrow(/did not equal/);
  });
});
