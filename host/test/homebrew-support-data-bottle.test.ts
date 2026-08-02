import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { gzipSync } from "fflate";
import { ABI_VERSION } from "../src/generated/abi";
import {
  extractHomebrewSupportDataBottle,
  type ExtractHomebrewSupportDataBottleOptions,
  verifyHomebrewSupportDataExtraction,
} from "../src/homebrew-support-data-bottle";
import { runHomebrewSupportDataExtractionVerifier } from "../../scripts/verify-homebrew-support-data-extraction";

const TAP_REPOSITORY = "kandelo-dev/homebrew-tap-core";
const TAP_NAME = "kandelo-dev/tap-core";
const CHECKOUT_COMMIT = "1111111111111111111111111111111111111111";
const SOURCE_TAP_COMMIT = "2222222222222222222222222222222222222222";
const KANDELO_COMMIT = "3333333333333333333333333333333333333333";
const METADATA_TAP_COMMIT = "4444444444444444444444444444444444444444";
const PACKAGE = "support-data";
const VERSION = "1.2.3";
const PREFIX = "/opt/kandelo/homebrew";
const CELLAR = `${PREFIX}/Cellar`;
const PAYLOAD_ROOT = `${PACKAGE}/${VERSION}`;
const KEG = `${CELLAR}/${PAYLOAD_ROOT}`;
const FORMULA_PATH = `Formula/${PACKAGE}.rb`;
const FORMULA_METADATA_PATH = `Kandelo/formula/${PACKAGE}.json`;
const LOCK_PATH = `Kandelo/recipes/${PACKAGE}/source-lock.json`;
const LINK_PATH = `Kandelo/link/${PACKAGE}-${VERSION}-rebuild1-wasm32.json`;
const ARCHIVE = utf8("reviewed support archive\n");
const ENVIRONMENT = utf8("SUPPORT_MODE=1\n");
const FORMULA = utf8("class SupportData < Formula\nend\n");
const SOURCE_FORMULA_SHA256 = sha256(
  utf8("canonical .brew Formula without the finalized bottle block\n"),
);
const BLOCK = 512;
const encoder = new TextEncoder();

interface TarSpec {
  path: string;
  type?: "file" | "directory" | "symlink" | "hardlink" | "device";
  data?: string | Uint8Array;
  linkName?: string;
  mode?: number;
}

interface Fixture {
  options: ExtractHomebrewSupportDataBottleOptions;
  metadata: Record<string, unknown>;
  lock: Record<string, unknown>;
  files: Map<string, Uint8Array>;
  bottle: Uint8Array;
}

describe("Homebrew support-data bottle extraction", () => {
  it("binds exact tap, Formula, recipe, bottle, keg, and output bytes", async () => {
    const fixture = makeFixture();
    const result = await extractHomebrewSupportDataBottle(fixture.options);
    const verified = await verifyHomebrewSupportDataExtraction({
      ...fixture.options,
      report: result.report,
      loadOutput: ({ name }) => {
        const output = result.outputs.find(
          (candidate) => candidate.name === name,
        );
        if (output === undefined)
          throw new Error(`missing test output ${name}`);
        return output.data;
      },
    });

    expect(result.outputs.map((output) => output.name)).toEqual([
      "archive",
      "environment",
    ]);
    expect(result.outputs.map((output) => output.memberPath)).toEqual([
      `${PAYLOAD_ROOT}/libexec/support.zip`,
      `${PAYLOAD_ROOT}/libexec/support.env`,
    ]);
    expect(result.outputs[0].data).toEqual(ARCHIVE);
    expect(result.outputs[1].data).toEqual(ENVIRONMENT);
    expect(verified.report).toEqual(result.report);
    expect(result.report).toMatchObject({
      catalog: {
        tap_repository: TAP_REPOSITORY,
        tap_name: TAP_NAME,
        checkout_commit: CHECKOUT_COMMIT,
        metadata_tap_commit: METADATA_TAP_COMMIT,
        kandelo_abi: ABI_VERSION,
      },
      package: {
        name: PACKAGE,
        full_name: `${TAP_NAME}/${PACKAGE}`,
        version: VERSION,
        formula_path: FORMULA_PATH,
        current_tap_formula_sha256: sha256(FORMULA),
        formula_metadata_path: FORMULA_METADATA_PATH,
        formula_metadata_sha256: sha256(
          fixture.files.get(FORMULA_METADATA_PATH)!,
        ),
        recipe_lock_path: LOCK_PATH,
        recipe_lock_sha256: sha256(fixture.files.get(LOCK_PATH)!),
      },
      bottle: {
        arch: "wasm32",
        keg: KEG,
        payload_root: PAYLOAD_ROOT,
        built_from: {
          tap_commit: SOURCE_TAP_COMMIT,
          kandelo_commit: KANDELO_COMMIT,
          formula_sha256: SOURCE_FORMULA_SHA256,
        },
      },
    });
  });

  it("rejects wrong bottle size and digest before parsing members", async () => {
    const short = makeFixture();
    short.options.loadBottleBytes = () =>
      short.bottle.subarray(0, short.bottle.byteLength - 1);
    await expect(
      extractHomebrewSupportDataBottle(short.options),
    ).rejects.toThrow(/bottle has .* bytes, expected/);

    const wrongDigest = makeFixture();
    const changed = new Uint8Array(wrongDigest.bottle);
    changed[changed.byteLength - 8] ^= 1;
    wrongDigest.options.loadBottleBytes = () => changed;
    await expect(
      extractHomebrewSupportDataBottle(wrongDigest.options),
    ).rejects.toThrow(/bottle sha256 .* does not match metadata/);
  });

  it("rejects detached report and output substitution", async () => {
    const fixture = makeFixture();
    const extraction = await extractHomebrewSupportDataBottle(fixture.options);
    const loadOutput = ({ name }: { name: string }): Uint8Array => {
      const output = extraction.outputs.find(
        (candidate) => candidate.name === name,
      );
      if (output === undefined) throw new Error(`missing test output ${name}`);
      return output.data;
    };

    const changedReport = structuredClone(extraction.report);
    changedReport.catalog.checkout_commit = SOURCE_TAP_COMMIT;
    await expect(
      verifyHomebrewSupportDataExtraction({
        ...fixture.options,
        report: changedReport,
        loadOutput,
      }),
    ).rejects.toThrow(/extraction report differs from the exact tap/);

    await expect(
      verifyHomebrewSupportDataExtraction({
        ...fixture.options,
        report: extraction.report,
        loadOutput: ({ name }) =>
          name === "archive" ? utf8("substituted\n") : loadOutput({ name }),
      }),
    ).rejects.toThrow(/support-data output "archive" has sha256/);
  });

  it("verifies detached files against a clean exact tap checkout", async () => {
    const fixture = makeFixture();
    const extraction = await extractHomebrewSupportDataBottle(fixture.options);
    const root = mkdtempSync(join(tmpdir(), "kandelo-support-data-verifier-"));
    try {
      const tapRoot = join(root, "tap");
      mkdirSync(tapRoot);
      for (const [path, bytes] of fixture.files) {
        const destination = join(tapRoot, path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
      }
      mkdirSync(join(tapRoot, "Kandelo"), { recursive: true });
      writeFileSync(
        join(tapRoot, "Kandelo/metadata.json"),
        jsonBytes(fixture.metadata),
      );
      git(tapRoot, ["init", "-q"]);
      git(tapRoot, ["config", "user.name", "Verifier test"]);
      git(tapRoot, ["config", "user.email", "verifier-test@example.invalid"]);
      git(tapRoot, ["add", "."]);
      git(tapRoot, ["commit", "-qm", "Homebrew: Add verifier fixture"]);
      const checkoutCommit = git(tapRoot, ["rev-parse", "HEAD"]).trim();

      const extractionRoot = join(root, "extraction");
      mkdirSync(extractionRoot);
      for (const output of extraction.outputs) {
        writeFileSync(join(extractionRoot, output.path), output.data);
      }
      const report = structuredClone(extraction.report);
      report.catalog.checkout_commit = checkoutCommit;
      const reportPath = join(extractionRoot, "report.json");
      writeFileSync(reportPath, jsonBytes(report));
      const verifiedPath = join(root, "verified", "report.json");

      await runHomebrewSupportDataExtractionVerifier([
        "--tap-root",
        tapRoot,
        "--expected-tap-sha",
        checkoutCommit,
        "--tap-repository",
        TAP_REPOSITORY,
        "--tap-name",
        TAP_NAME,
        "--package",
        PACKAGE,
        "--arch",
        "wasm32",
        "--expected-abi",
        String(ABI_VERSION),
        "--report",
        reportPath,
        "--output",
        `archive=${join(extractionRoot, "support.zip")}`,
        "--output",
        `environment=${join(extractionRoot, "support.env")}`,
        "--verified-report-out",
        verifiedPath,
      ]);

      expect(JSON.parse(readFileSync(verifiedPath, "utf8"))).toEqual(report);

      const preparedTree = git(tapRoot, ["write-tree"]).trim();
      rmSync(join(tapRoot, ".git"), { recursive: true, force: true });
      const selectionAuthorization = join(
        root,
        "closed-selection-authorization.json",
      );
      writeFileSync(
        selectionAuthorization,
        jsonBytes({
          arch: "wasm32",
          formula_count: 1,
          formulae: [PACKAGE],
          kandelo_abi: ABI_VERSION,
          kind: "kandelo-homebrew-closed-selection-verification",
          prepared_tree_git_oid: preparedTree,
          readback: {
            receipt_sha256: "5".repeat(64),
            release_id: 19,
            repository: TAP_REPOSITORY,
            tag: `homebrew-prefix-selection-sha256-${"6".repeat(64)}`,
            visibility: "public-anonymous-readback",
          },
          roots: [PACKAGE],
          schema: 1,
          selection_manifest_sha256: "7".repeat(64),
          source_tap_commit: checkoutCommit,
          tap_name: TAP_NAME,
        }),
      );
      const detachedVerifiedPath = join(
        root,
        "detached-verified",
        "report.json",
      );
      // WHY: public closed selections intentionally have no `.git` directory.
      // The reusable Python verifier authorizes their exact tree and receipt;
      // this detached pass proves the output verifier consumes that contract.
      await runHomebrewSupportDataExtractionVerifier([
        "--tap-root",
        tapRoot,
        "--expected-tap-sha",
        checkoutCommit,
        "--tap-repository",
        TAP_REPOSITORY,
        "--tap-name",
        TAP_NAME,
        "--package",
        PACKAGE,
        "--arch",
        "wasm32",
        "--expected-abi",
        String(ABI_VERSION),
        "--report",
        reportPath,
        "--output",
        `archive=${join(extractionRoot, "support.zip")}`,
        "--output",
        `environment=${join(extractionRoot, "support.env")}`,
        "--selection-verification-report",
        selectionAuthorization,
        "--verified-report-out",
        detachedVerifiedPath,
      ]);
      expect(JSON.parse(readFileSync(detachedVerifiedPath, "utf8"))).toEqual(
        report,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, duplicate, linked, and undeclared output members", async () => {
    const cases: Array<{ entries: TarSpec[]; message: RegExp }> = [
      {
        entries: bottleEntries().filter(
          (entry) => entry.path !== `${PAYLOAD_ROOT}/libexec/support.env`,
        ),
        message: /omits declared support-data member .*support\.env/,
      },
      {
        entries: [
          ...bottleEntries(),
          {
            path: `${PAYLOAD_ROOT}/libexec/support.zip`,
            data: ARCHIVE,
          },
        ],
        message: /duplicates support-data member .*support\.zip/,
      },
      {
        entries: bottleEntries().map((entry) =>
          entry.path === `${PAYLOAD_ROOT}/libexec/support.zip`
            ? {
                path: entry.path,
                type: "symlink" as const,
                linkName: "support.env",
              }
            : entry,
        ),
        message: /support-data member .*support\.zip.*regular file.*symlink/,
      },
      {
        entries: [
          ...bottleEntries(),
          {
            path: `${PAYLOAD_ROOT}/libexec/not-declared`,
            data: "surprise",
          },
        ],
        message: /undeclared support-data member .*not-declared/,
      },
    ];

    for (const testCase of cases) {
      const fixture = makeFixture(testCase.entries);
      await expect(
        extractHomebrewSupportDataBottle(fixture.options),
      ).rejects.toThrow(testCase.message);
    }
  });

  it("keeps unsafe and special TAR members behind the hardened parser", async () => {
    const unsafe = makeFixture([
      ...bottleEntries(),
      { path: "../escape", data: "bad" },
    ]);
    await expect(
      extractHomebrewSupportDataBottle(unsafe.options),
    ).rejects.toThrow(/TAR path.*unsafe path segment/);

    const device = makeFixture([
      ...bottleEntries(),
      { path: `${PAYLOAD_ROOT}/device`, type: "device" },
    ]);
    await expect(
      extractHomebrewSupportDataBottle(device.options),
    ).rejects.toThrow(/unsupported TAR device\/FIFO entry/);
  });

  it("rejects oversized and mismatched recipe output contracts", async () => {
    const oversized = makeFixture();
    const oversizedLock = structuredClone(oversized.lock);
    (
      oversizedLock.outputs as Record<string, Record<string, unknown>>
    ).archive.bytes = 256 * 1024 * 1024 + 1;
    replaceLock(oversized, oversizedLock);
    await expect(
      extractHomebrewSupportDataBottle(oversized.options),
    ).rejects.toThrow(/outputs\.archive\.bytes must be in/);

    const wrongOutput = makeFixture();
    const wrongLock = structuredClone(wrongOutput.lock);
    (
      wrongLock.outputs as Record<string, Record<string, unknown>>
    ).archive.sha256 = "f".repeat(64);
    replaceLock(wrongOutput, wrongLock);
    await expect(
      extractHomebrewSupportDataBottle(wrongOutput.options),
    ).rejects.toThrow(/support-data member .* has sha256/);
  });

  it("keeps current tap and bottle-receipt Formula digests distinct", async () => {
    const fixture = makeFixture();
    fixture.files.set(FORMULA_PATH, utf8("changed current tap Formula\n"));

    const result = await extractHomebrewSupportDataBottle(fixture.options);

    expect(result.report.package.current_tap_formula_sha256).toBe(
      sha256(fixture.files.get(FORMULA_PATH)!),
    );
    expect(result.report.bottle.built_from.formula_sha256).toBe(
      SOURCE_FORMULA_SHA256,
    );
    expect(result.report.package.current_tap_formula_sha256).not.toBe(
      result.report.bottle.built_from.formula_sha256,
    );
  });

  it("rejects stale catalog, sidecar, version, and keg identities", async () => {
    const staleCatalog = makeFixture();
    staleCatalog.metadata.tap_repository = "example/homebrew-wrong-tap";
    await expect(
      extractHomebrewSupportDataBottle(staleCatalog.options),
    ).rejects.toThrow(/metadata tap .* does not match repository/);

    const staleSidecar = makeFixture();
    const sidecar = JSON.parse(
      new TextDecoder().decode(staleSidecar.files.get(FORMULA_METADATA_PATH)),
    ) as Record<string, unknown>;
    sidecar.version = "9.9.9";
    staleSidecar.files.set(FORMULA_METADATA_PATH, jsonBytes(sidecar));
    await expect(
      extractHomebrewSupportDataBottle(staleSidecar.options),
    ).rejects.toThrow(
      /Formula metadata version differs from the catalog package/,
    );

    const wrongVersion = makeFixture();
    const wrongVersionLock = structuredClone(wrongVersion.lock);
    (wrongVersionLock.package as Record<string, unknown>).version = "9.9.9";
    replaceLock(wrongVersion, wrongVersionLock);
    await expect(
      extractHomebrewSupportDataBottle(wrongVersion.options),
    ).rejects.toThrow(/bottle version .* does not match tap recipe lock/);

    const wrongKeg = makeFixture();
    const link = JSON.parse(
      new TextDecoder().decode(wrongKeg.files.get(LINK_PATH)),
    ) as Record<string, unknown>;
    link.keg = `${CELLAR}/${PACKAGE}/elsewhere`;
    wrongKeg.files.set(LINK_PATH, jsonBytes(link));
    await expect(
      extractHomebrewSupportDataBottle(wrongKeg.options),
    ).rejects.toThrow(/bottle keg identity must be exactly/);
  });

  it("rejects a support-data Formula with runtime dependencies", async () => {
    const fixture = makeFixture();
    const packages = fixture.metadata.packages as Array<
      Record<string, unknown>
    >;
    packages[0].dependencies = [
      {
        name: "runtime",
        full_name: `${TAP_NAME}/runtime`,
        version: "1.0",
      },
    ];
    packages.push(
      metadataPackage({
        name: "runtime",
        version: "1.0",
        formulaPath: "Formula/runtime.rb",
        sourceFormulaSha256: "a".repeat(64),
        bottle: fixture.bottle,
        payloadRoot: "runtime/1.0",
        linkPath: "Kandelo/link/runtime-1.0-rebuild1-wasm32.json",
      }),
    );
    fixture.files.set(
      "Kandelo/link/runtime-1.0-rebuild1-wasm32.json",
      jsonBytes(
        linkManifest({
          name: "runtime",
          version: "1.0",
          payloadRoot: "runtime/1.0",
          bottle: fixture.bottle,
        }),
      ),
    );
    fixture.files.set(
      FORMULA_METADATA_PATH,
      jsonBytes(formulaMetadata(packages[0])),
    );
    await expect(
      extractHomebrewSupportDataBottle(fixture.options),
    ).rejects.toThrow(/must have no runtime dependency closure/);
  });
});

function makeFixture(entries = bottleEntries()): Fixture {
  const bottle = gzipTar(entries);
  const lock: Record<string, unknown> = {
    schema: 1,
    kind: "kandelo-support-data-tap-recipe-lock",
    package: {
      name: PACKAGE,
      version: VERSION,
      arch: "wasm32",
    },
    source: { intentionally: "opaque to the generic consumer" },
    outputs: {
      environment: {
        path: "support.env",
        sha256: sha256(ENVIRONMENT),
        bytes: ENVIRONMENT.byteLength,
      },
      archive: {
        path: "support.zip",
        sha256: sha256(ARCHIVE),
        bytes: ARCHIVE.byteLength,
      },
    },
  };
  const packageMetadata = metadataPackage({
    name: PACKAGE,
    version: VERSION,
    formulaPath: FORMULA_PATH,
    sourceFormulaSha256: SOURCE_FORMULA_SHA256,
    bottle,
    payloadRoot: PAYLOAD_ROOT,
    linkPath: LINK_PATH,
  });
  const metadata: Record<string, unknown> = {
    schema: 1,
    tap_repository: TAP_REPOSITORY,
    tap_name: TAP_NAME,
    tap_commit: METADATA_TAP_COMMIT,
    kandelo_repository: "Automattic/kandelo",
    kandelo_commit: KANDELO_COMMIT,
    kandelo_abi: ABI_VERSION,
    release_tag: `bottles-abi-v${ABI_VERSION}`,
    generated_at: "2026-07-29T00:00:00Z",
    generator: "test",
    packages: [packageMetadata],
  };
  const files = new Map<string, Uint8Array>([
    [FORMULA_PATH, FORMULA],
    [FORMULA_METADATA_PATH, jsonBytes(formulaMetadata(packageMetadata))],
    [LOCK_PATH, jsonBytes(lock)],
    [
      LINK_PATH,
      jsonBytes(
        linkManifest({
          name: PACKAGE,
          version: VERSION,
          payloadRoot: PAYLOAD_ROOT,
          bottle,
        }),
      ),
    ],
  ]);
  const options: ExtractHomebrewSupportDataBottleOptions = {
    metadata,
    packageName: PACKAGE,
    arch: "wasm32",
    expectedAbi: ABI_VERSION,
    expectedTapRepository: TAP_REPOSITORY,
    expectedTapName: TAP_NAME,
    expectedCheckoutCommit: CHECKOUT_COMMIT,
    loadTapFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing test tap file ${path}`);
      return value;
    },
    loadBottleBytes: () => bottle,
  };
  return { options, metadata, lock, files, bottle };
}

function replaceLock(fixture: Fixture, value: Record<string, unknown>): void {
  fixture.lock = value;
  fixture.files.set(LOCK_PATH, jsonBytes(value));
}

function metadataPackage(options: {
  name: string;
  version: string;
  formulaPath: string;
  sourceFormulaSha256: string;
  bottle: Uint8Array;
  payloadRoot: string;
  linkPath: string;
}): Record<string, unknown> {
  const bottleSha256 = sha256(options.bottle);
  return {
    name: options.name,
    full_name: `${TAP_NAME}/${options.name}`,
    version: options.version,
    formula_revision: 0,
    bottle_rebuild: 1,
    formula_path: options.formulaPath,
    formula_metadata: `Kandelo/formula/${options.name}.json`,
    dependencies: [],
    bottles: [
      {
        arch: "wasm32",
        bottle_tag: "wasm32_kandelo",
        kandelo_abi: ABI_VERSION,
        cellar: CELLAR,
        prefix: PREFIX,
        runtime_support: ["node", "browser"],
        browser_compatible: true,
        fork_instrumentation: "not-required",
        status: "success",
        built_by: "https://github.com/example/actions/runs/1",
        built_at: "2026-07-29T00:00:00Z",
        url:
          `https://ghcr.io/v2/${TAP_REPOSITORY}/${options.name}/blobs/` +
          `sha256:${bottleSha256}`,
        sha256: bottleSha256,
        bytes: options.bottle.byteLength,
        cache_key_sha: bottleSha256,
        link_manifest: options.linkPath,
        built_from: {
          tap_repository: TAP_REPOSITORY,
          tap_commit: SOURCE_TAP_COMMIT,
          kandelo_repository: "Automattic/kandelo",
          kandelo_commit: KANDELO_COMMIT,
          formula_sha256: options.sourceFormulaSha256,
        },
      },
    ],
  };
}

function formulaMetadata(
  packageMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const packageFields = structuredClone(packageMetadata);
  delete packageFields.formula_metadata;
  return {
    schema: 1,
    tap_repository: TAP_REPOSITORY,
    tap_name: TAP_NAME,
    tap_commit: METADATA_TAP_COMMIT,
    kandelo_abi: ABI_VERSION,
    source_metadata: "Kandelo/metadata.json",
    ...packageFields,
  };
}

function linkManifest(options: {
  name: string;
  version: string;
  payloadRoot: string;
  bottle: Uint8Array;
}): Record<string, unknown> {
  const bottleSha256 = sha256(options.bottle);
  return {
    schema: 1,
    package: options.name,
    version: options.version,
    arch: "wasm32",
    kandelo_abi: ABI_VERSION,
    prefix: PREFIX,
    cellar: CELLAR,
    keg: `${CELLAR}/${options.payloadRoot}`,
    bottle: {
      url:
        `https://ghcr.io/v2/${TAP_REPOSITORY}/${options.name}/blobs/` +
        `sha256:${bottleSha256}`,
      sha256: bottleSha256,
      bytes: options.bottle.byteLength,
      cache_key_sha: bottleSha256,
      payload_root: options.payloadRoot,
    },
    links: [],
    receipts: ["INSTALL_RECEIPT.json"],
    env: {},
  };
}

function bottleEntries(): TarSpec[] {
  return [
    { path: PAYLOAD_ROOT, type: "directory" },
    { path: `${PAYLOAD_ROOT}/libexec`, type: "directory" },
    {
      path: `${PAYLOAD_ROOT}/libexec/support.zip`,
      data: ARCHIVE,
    },
    {
      path: `${PAYLOAD_ROOT}/libexec/support.env`,
      data: ENVIRONMENT,
    },
    {
      path: `${PAYLOAD_ROOT}/INSTALL_RECEIPT.json`,
      data: "{}\n",
    },
  ];
}

function gzipTar(entries: readonly TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 2 * BLOCK;
  for (const entry of entries) {
    const data = entryData(entry);
    const payload = new Uint8Array(Math.ceil(data.byteLength / BLOCK) * BLOCK);
    payload.set(data);
    const header = tarHeader(entry, data.byteLength);
    chunks.push(header, payload);
    total += header.byteLength + payload.byteLength;
  }
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return gzipSync(tar);
}

function tarHeader(entry: TarSpec, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.mode ?? defaultMode(entry.type));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = typeflag(entry.type).charCodeAt(0);
  if (entry.linkName !== undefined) {
    writeString(header, 157, 100, entry.linkName);
  }
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function entryData(entry: TarSpec): Uint8Array {
  if (entry.data instanceof Uint8Array) return entry.data;
  if (typeof entry.data === "string") return utf8(entry.data);
  return new Uint8Array();
}

function typeflag(type: TarSpec["type"]): string {
  switch (type) {
    case "directory":
      return "5";
    case "symlink":
      return "2";
    case "hardlink":
      return "1";
    case "device":
      return "3";
    default:
      return "0";
  }
}

function defaultMode(type: TarSpec["type"]): number {
  if (type === "directory") return 0o755;
  if (type === "symlink") return 0o777;
  return 0o644;
}

function writeString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) {
    throw new Error(`test TAR field is too long: ${value}`);
  }
  target.set(bytes, offset);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  writeString(
    target,
    offset,
    length,
    `${value.toString(8).padStart(length - 2, "0")}\0`,
  );
}

function jsonBytes(value: unknown): Uint8Array {
  return utf8(`${JSON.stringify(value, null, 2)}\n`);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
}
