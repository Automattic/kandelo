import { createHash } from "node:crypto";

import { gzipSync, zipSync, type Zippable } from "fflate";

import type {
  HomebrewBottleArch,
  HomebrewBottleDependencyIdentity,
  HomebrewBottleDescriptor,
  HomebrewBottleSupportOutput,
  HomebrewLinkEntry,
} from "../../src";
import { encodeHomebrewBottleSelection } from "../../src/homebrew-bottle-selection";

export const HOMEBREW_TEST_PREFIX = "/opt/kandelo/homebrew";
export const HOMEBREW_TEST_CELLAR = `${HOMEBREW_TEST_PREFIX}/Cellar`;
export const HOMEBREW_TEST_BOOTSTRAP_FULL_NAME =
  "kandelo-dev/tap-core/homebrew-bootstrap";

export interface HomebrewTestTarSpec {
  path: string;
  type?: "file" | "directory" | "symlink" | "hardlink" | "pax";
  data?: string | Uint8Array;
  linkName?: string;
  mode?: number;
}

export interface HomebrewTestZipEntry {
  data?: string | Uint8Array;
  mode: number;
}

export interface HomebrewTestBottleDescriptorOptions {
  name: string;
  version: string;
  bottle: Uint8Array;
  arch?: HomebrewBottleArch;
  materialization?: HomebrewBottleDescriptor["materialization"];
  dependencies?: HomebrewBottleDependencyIdentity[];
  links?: HomebrewLinkEntry[];
  pathPrepend?: string[];
  supportOutputs?: HomebrewBottleSupportOutput[];
}

export interface HomebrewTestBootstrapFixtureOptions {
  arch?: HomebrewBottleArch;
  zip?: Uint8Array;
  environment?: Uint8Array;
  zipEntry?: HomebrewTestTarSpec;
  environmentEntry?: HomebrewTestTarSpec;
  supportOutputs?: HomebrewBottleSupportOutput[];
  extraBottleEntries?: HomebrewTestTarSpec[];
}

export function homebrewTestEnvironment(
  arch: HomebrewBottleArch = "wasm32",
): Uint8Array {
  return new TextEncoder().encode(
    "HOMEBREW_NO_ANALYTICS=1\n" +
      "HOMEBREW_NO_AUTO_UPDATE=1\n" +
      "HOMEBREW_NO_INSTALL_FROM_API=1\n" +
      "HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1\n" +
      "HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1\n" +
      `HOMEBREW_KANDELO_BOTTLE_TAG=${arch}_kandelo\n`,
  );
}

export function homebrewTestRuntimeZip(
  overrides: Record<string, HomebrewTestZipEntry> = {},
): Uint8Array {
  return homebrewTestZip({
    "bin/": { mode: 0o040700 },
    "bin/brew": { data: "#!/bin/sh\necho brew\n", mode: 0o100711 },
    "bin/homebrew-library": {
      data: "../Library/Homebrew/",
      mode: 0o120700,
    },
    "Library/": { mode: 0o040750 },
    "Library/Homebrew/": { mode: 0o040777 },
    "Library/Homebrew/global.rb": { data: "GLOBAL = true\n", mode: 0o100600 },
    "lib/": { mode: 0o040755 },
    "lib/runtime.rb": { data: "RUNTIME = true\n", mode: 0o100644 },
    ...overrides,
  });
}

export function homebrewTestZip(
  entries: Record<string, HomebrewTestZipEntry>,
): Uint8Array {
  const zippable: Zippable = {};
  for (const [path, entry] of Object.entries(entries)) {
    const bytes = entry.data instanceof Uint8Array
      ? entry.data
      : new TextEncoder().encode(entry.data ?? "");
    zippable[path] = [bytes, {
      os: 3,
      attrs: ((entry.mode << 16) >>> 0),
    }];
  }
  return zipSync(zippable, { level: 9 });
}

export function homebrewTestBootstrapEntries(
  options: HomebrewTestBootstrapFixtureOptions = {},
): HomebrewTestTarSpec[] {
  const zip = options.zip ?? homebrewTestRuntimeZip();
  const environment = options.environment ?? homebrewTestEnvironment(options.arch);
  return [
    homebrewTestBottleEntry(
      "homebrew-bootstrap",
      "6.0.12_1",
      ".brew/homebrew-bootstrap.rb",
      "class HomebrewBootstrap < Formula\nend\n",
    ),
    homebrewTestBottleEntry(
      "homebrew-bootstrap",
      "6.0.12_1",
      "INSTALL_RECEIPT.json",
      homebrewTestReceipt([]),
    ),
    options.zipEntry ?? homebrewTestBottleEntry(
      "homebrew-bootstrap",
      "6.0.12_1",
      "libexec/homebrew-bootstrap.zip",
      zip,
    ),
    options.environmentEntry ?? homebrewTestBottleEntry(
      "homebrew-bootstrap",
      "6.0.12_1",
      "libexec/homebrew-brew.env",
      environment,
    ),
    ...(options.extraBottleEntries ?? []),
  ];
}

export function homebrewTestBootstrapFixture(
  options: HomebrewTestBootstrapFixtureOptions = {},
): {
  descriptor: HomebrewBottleDescriptor;
  bottle: Uint8Array;
  zip: Uint8Array;
  environment: Uint8Array;
} {
  const arch = options.arch ?? "wasm32";
  const zip = options.zip ?? homebrewTestRuntimeZip();
  const environment = options.environment ?? homebrewTestEnvironment(arch);
  const bottle = homebrewTestBottleTar(homebrewTestBootstrapEntries({
    ...options,
    arch,
    zip,
    environment,
  }));
  const supportOutputs = options.supportOutputs ?? [
    {
      name: "homebrew-bootstrap",
      kegRelativePath: "libexec/homebrew-bootstrap.zip",
      sha256: homebrewTestSha256(zip),
      bytes: zip.byteLength,
    },
    {
      name: "homebrew-brew",
      kegRelativePath: "libexec/homebrew-brew.env",
      sha256: homebrewTestSha256(environment),
      bytes: environment.byteLength,
    },
  ];
  return {
    bottle,
    zip,
    environment,
    descriptor: homebrewTestBottleDescriptor({
      name: "homebrew-bootstrap",
      version: "6.0.12_1",
      bottle,
      arch,
      materialization: "homebrew-runtime-support-v1",
      supportOutputs,
    }),
  };
}

export function homebrewTestBottleDescriptor(
  options: HomebrewTestBottleDescriptorOptions,
): HomebrewBottleDescriptor {
  const arch = options.arch ?? "wasm32";
  const sha256 = homebrewTestSha256(options.bottle);
  const payloadRoot = `${options.name}/${options.version}`;
  return {
    schema: 1,
    name: options.name,
    fullName: `kandelo-dev/tap-core/${options.name}`,
    version: options.version,
    revision: 0,
    bottleRebuild: 0,
    arch,
    kandeloAbi: 42,
    bottleTag: `${arch}_kandelo`,
    layout: "kandelo-homebrew-v1",
    materialization: options.materialization ?? "keg",
    prefix: HOMEBREW_TEST_PREFIX,
    cellar: HOMEBREW_TEST_CELLAR,
    keg: `${HOMEBREW_TEST_CELLAR}/${payloadRoot}`,
    payloadRoot,
    receipts: [
      `Cellar/${payloadRoot}/.brew/${options.name}.rb`,
      `Cellar/${payloadRoot}/INSTALL_RECEIPT.json`,
    ],
    links: options.links ?? [],
    pathPrepend: options.pathPrepend ?? [],
    supportOutputs: options.supportOutputs ?? [],
    dependencies: options.dependencies ?? [],
    url: `https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/${options.name}/blobs/sha256:${sha256}`,
    sha256,
    bytes: options.bottle.byteLength,
    compression: "gzip",
  };
}

export function homebrewTestSelectionBytes(
  bottles: HomebrewBottleDescriptor[],
): Uint8Array {
  return encodeHomebrewBottleSelection({
    schema: 1,
    name: "experimental-abi42-flat-builder",
    arch: "wasm32",
    kandeloAbi: 42,
    bottles,
    requestedVfsFilename: "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
    resourcePolicy: "kandelo-homebrew-vfs-generous-v1",
    linkPolicy: "kandelo-homebrew-link-ownership-v1",
    runtimeSupport: "kandelo-homebrew-bootstrap-v1",
  });
}

export function homebrewTestBottleEntry(
  name: string,
  version: string,
  relativePath: string,
  data: string | Uint8Array,
  mode?: number,
): HomebrewTestTarSpec {
  return { path: `${name}/${version}/${relativePath}`, data, mode };
}

export function homebrewTestReceipt(
  runtimeDependencies: unknown[],
  changedFiles: string[] = [],
): string {
  return `${JSON.stringify({
    changed_files: changedFiles,
    runtime_dependencies: runtimeDependencies,
  })}\n`;
}

export function homebrewTestBottleTar(entries: HomebrewTestTarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) chunks.push(tarHeader(entry), tarPayload(entry));
  chunks.push(new Uint8Array(1024));
  const tar = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return gzipSync(tar);
}

export function homebrewTestSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tarHeader(entry: HomebrewTestTarSpec): Uint8Array {
  const header = new Uint8Array(512);
  const data = tarData(entry);
  writeString(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.byteLength);
  writeOctal(header, 136, 12, 0);
  for (let index = 148; index < 156; index += 1) header[index] = 0x20;
  header[156] = tarTypeflag(entry);
  if (entry.linkName !== undefined) writeString(header, 157, 100, entry.linkName);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
  header[155] = 0x20;
  return header;
}

function tarPayload(entry: HomebrewTestTarSpec): Uint8Array {
  const data = tarData(entry);
  const output = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
  output.set(data);
  return output;
}

function tarData(entry: HomebrewTestTarSpec): Uint8Array {
  if (entry.type !== undefined && entry.type !== "file" && entry.type !== "pax") {
    return new Uint8Array();
  }
  return entry.data instanceof Uint8Array
    ? entry.data
    : new TextEncoder().encode(entry.data ?? "");
}

function tarTypeflag(entry: HomebrewTestTarSpec): number {
  switch (entry.type ?? "file") {
    case "file": return "0".charCodeAt(0);
    case "directory": return "5".charCodeAt(0);
    case "symlink": return "2".charCodeAt(0);
    case "hardlink": return "1".charCodeAt(0);
    case "pax": return "x".charCodeAt(0);
  }
}

function writeString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error(`test TAR field too long: ${value}`);
  target.set(bytes, offset);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  writeString(target, offset, length, `${value.toString(8).padStart(length - 2, "0")}\0`);
}
