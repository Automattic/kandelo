import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { loadVfsProductCatalog } from "../../../scripts/vfs-product-catalog.mjs";
import {
  MemoryFileSystem,
} from "../../../host/src/vfs/memory-fs";
import { ENOENT } from "../../../host/src/vfs/sharedfs-vendor";
import {
  parseTarBytes,
  parseTarGzip,
  type TarEntry,
} from "../../../host/src/vfs/tar";
import {
  extractZipEntryBounded,
  parseZipCentralDirectory,
} from "../../../host/src/vfs/zip";
import { openVfsProductBuild } from "./vfs-product-builder-contract";
import type {
  VfsProductBuild,
  VfsProductInputHandle,
  VfsProductInputKind,
} from "./vfs-product-builder-contract";
import { buildNodeVfsImage } from "./build-node-vfs-image";
import { buildNginxVfsImage } from "./build-nginx-vfs-image";
import { buildNginxPhpVfsImage } from "./build-nginx-php-vfs-image";
import { buildWordPressVfsImage } from "./build-wp-vfs-image";
import { buildLampVfsImage } from "./build-lamp-vfs-image";
import { buildMariadbVfsImage } from "./build-mariadb-vfs-image";
import { buildPythonVfsImage } from "./build-python-vfs-image";
import { buildPerlVfsImage } from "./build-perl-vfs-image";
import { buildRedisVfsImage } from "./build-redis-vfs-image";
import { buildErlangVfsImage } from "./build-erlang-vfs-image";
import { buildKandeloSdkVfsImage } from "./build-kandelo-sdk-vfs-image";
import { buildMariadbTestVfsImage } from "./build-mariadb-test-vfs-image";
import { buildPhpTestVfsImage } from "./build-php-test-vfs-image";
import { buildSqliteTestVfsImage } from "./build-sqlite-test-vfs-image";
import {
  loadShellBaseFileSystemFromImage,
} from "./package-shell-vfs-build";
import {
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
} from "../../../web-libs/kandelo-session/src/vfs-capacity";
export { createRepositoryPathBundle } from "./repository-path-bundle";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 100_000;
const STAGING_FLAGS = new Map([
  ["--vfs-product-manifest", "manifestPath"],
  ["--vfs-product-inputs", "resolvedInputsPath"],
  ["--vfs-product-report", "builderReportPath"],
  ["--vfs-product-output", "outputPath"],
] as const);

export interface StagedProductInvocation {
  manifestPath: string;
  resolvedInputsPath: string;
  builderReportPath: string;
  outputPath: string;
}

export interface ExactSourceIdentity {
  repository: string;
  commit: string;
  tree: string;
}

export type RepositoryPathBundleEntry =
  | Readonly<{
      path: string;
      kind: "directory";
      mode: number;
    }>
  | Readonly<{
      path: string;
      kind: "file";
      mode: number;
      sha256: string;
      bytes: number;
      content_base64: string;
    }>
  | Readonly<{
      path: string;
      kind: "symlink";
      mode: number;
      target: string;
    }>;

export interface RepositoryPathBundle {
  readonly schema: 1;
  readonly kind: "kandelo-vfs-repository-path-bundle";
  readonly source: Readonly<ExactSourceIdentity>;
  readonly paths: readonly string[];
  readonly entries: readonly RepositoryPathBundleEntry[];
}

export async function buildStagedPlatformRootfs(
  invocation: StagedProductInvocation,
): Promise<void> {
  await buildStagedPackageVfs(
    invocation,
    "platform-rootfs",
    "packages/registry/rootfs/build-rootfs-package.sh",
    "rootfs",
    "rootfs",
  );
}

export async function buildStagedBrowserMainShell(
  invocation: StagedProductInvocation,
): Promise<void> {
  await buildStagedPackageVfs(
    invocation,
    "browser-main-shell",
    "packages/registry/shell/build-shell.sh",
    "shell",
    "shell",
  );
}

async function buildStagedPackageVfs(
  invocation: StagedProductInvocation,
  productId: "platform-rootfs" | "browser-main-shell",
  builder: string,
  packageName: string,
  outputName: string,
): Promise<void> {
  assertStagedProductEnvironment(process.env);
  const build = await openVfsProductBuild(
    invocation.resolvedInputsPath,
    invocation.builderReportPath,
  );
  const manifest = validateSelectedProductManifest(invocation.manifestPath, build);
  const claim = manifest.software.package[0];
  if (
    build.product.id !== productId ||
    manifest.id !== productId ||
    manifest.builder !== builder ||
    manifest.composition.product.length !== 0 ||
    manifest.composition.repository.length !== 0 ||
    manifest.software.package.length !== 1 ||
    claim?.name !== packageName ||
    canonicalJson(claim.outputs) !== canonicalJson([outputName]) ||
    claim.source_roles.length !== 0 ||
    claim.role !== "runtime" ||
    claim.materialization !== "embedded" ||
    manifest.software.homebrew.length !== 0 ||
    manifest.software.archive.length !== 0 ||
    manifest.software.toolchain.length !== 0
  ) {
    throw new Error(
      `${productId} must be an embedded ${packageName}/${outputName} package image`,
    );
  }
  const expected = expectedManifestInputs(manifest);
  assertExactInputInventory(build, expected, productId);
  const input = requireExpectedInput(
    build,
    expected,
    resolvedInputId("package-output", packageName, "output", outputName),
    "package-output",
  );
  if (input.placement !== "embedded") {
    throw new Error(`${productId} package image must be embedded`);
  }
  const bytes = exactInputBytes(input, `${productId} package image`);
  const metadata = MemoryFileSystem.readImageMetadata(bytes);
  if (
    metadata?.kernelAbi !== build.targetAbi.version ||
    metadata.abiSnapshotSha256 !== build.targetAbi.snapshot_sha256
  ) {
    throw new Error(`${productId} package image ABI differs from its target`);
  }
  writeFileSync(invocation.outputPath, bytes, { flag: "wx", mode: 0o600 });
  await build.finish(invocation.outputPath);
}


const SERVICE_PRODUCT_BUILDERS = new Map([
  ["browser-node", "images/vfs/scripts/build-node-vfs-image.sh"],
  ["browser-nginx", "images/vfs/scripts/build-nginx-vfs-image.sh"],
  ["browser-nginx-php", "images/vfs/scripts/build-nginx-php-vfs-image.sh"],
  ["browser-wordpress", "images/vfs/scripts/build-wp-vfs-image.sh"],
  ["browser-lamp", "images/vfs/scripts/build-lamp-vfs-image.sh"],
] as const);

type ServiceProductId = (typeof SERVICE_PRODUCT_BUILDERS extends Map<infer K, string>
  ? K
  : never);

interface ExpectedServiceInput {
  kind: VfsProductInputKind;
  placement: "embedded" | "lazy-reference" | "build-only";
}

/**
 * Build one browser service product exclusively from the exact resolved input
 * handles selected by its canonical product manifest.
 */
export async function buildStagedBrowserService(
  productId: ServiceProductId,
  invocation: StagedProductInvocation,
): Promise<void> {
  assertStagedProductEnvironment(process.env);
  const build = await openVfsProductBuild(
    invocation.resolvedInputsPath,
    invocation.builderReportPath,
  );
  const manifest = validateSelectedProductManifest(invocation.manifestPath, build);
  const expectedBuilder = SERVICE_PRODUCT_BUILDERS.get(productId);
  if (
    build.product.id !== productId ||
    manifest.id !== productId ||
    manifest.builder !== expectedBuilder
  ) {
    throw new Error(
      `${productId} staging selected a different product or builder`,
    );
  }
  const expected = expectedManifestInputs(manifest);
  assertExactInputInventory(build, expected, productId);
  if (manifest.software.homebrew.length !== 0) {
    throw new Error(`${productId} cannot consume Homebrew inputs`);
  }

  const temporaryRoot = realDirectory(
    process.env.TMPDIR ?? "",
    "staged product temporary root",
  );
  const work = mkdtempSync(join(temporaryRoot, `kandelo-${productId}-`));
  try {
    const shellImage = exactInputBytes(
      requireExpectedInput(
        build,
        expected,
        "product-browser-main-shell",
        "product-image",
      ),
      `${productId} shell base`,
    );
    const sourceArchive = (id: string): Uint8Array =>
      exactInputBytes(
        requireExpectedInput(
          build,
          expected,
          resolvedInputId("source-archive", id),
          "source-archive",
        ),
        `${productId} archive ${id}`,
      );
    const packageInput = (name: string, output: string) =>
      requireExpectedInput(
        build,
        expected,
        resolvedInputId("package-output", name, "output", output),
        "package-output",
      );
    const packageBytes = (name: string, output: string): Uint8Array =>
      exactInputBytes(
        packageInput(name, output),
        `${productId} ${name}/${output}`,
      );
    const packageSourceRole = (name: string, role: string): Uint8Array =>
      exactInputBytes(
        requireExpectedInput(
          build,
          expected,
          resolvedInputId("package-output", name, "source-role", role),
          "package-output",
        ),
        `${productId} ${name} source role ${role}`,
      );
    const dinit = () => ({
      dinit: packageBytes("dinit", "dinit"),
      dinitctl: packageBytes("dinit", "dinitctl"),
    });
    const kernel = (): Uint8Array => {
      const input = exactInputBytes(
        requireExpectedInput(
          build,
          expected,
          "toolchain-kernel-wasm",
          "toolchain-output",
        ),
        `${productId} prepared kernel`,
      );
      const directory = join(work, "kernel-toolchain");
      materializeSingleRootArchive(
        input,
        directory,
        `${productId} prepared kernel`,
      );
      return new Uint8Array(readFileSync(join(directory, "kernel.wasm")));
    };

    switch (productId) {
      case "browser-node": {
        const npmDirectory = join(work, "npm-runtime");
        materializeSingleRootArchive(
          sourceArchive("npm-runtime"),
          npmDirectory,
          "browser-node npm runtime",
        );
        await buildNodeVfsImage({
          shellImage,
          node: packageBytes("node", "node"),
          npmDirectory,
          outputPath: invocation.outputPath,
        });
        break;
      }
      case "browser-nginx":
        await buildNginxVfsImage({
          shellImage,
          nginx: packageBytes("nginx", "nginx"),
          dinit: dinit(),
          outputPath: invocation.outputPath,
        });
        break;
      case "browser-nginx-php":
        await buildNginxPhpVfsImage({
          shellImage,
          nginx: packageBytes("nginx", "nginx"),
          phpFpm: packageBytes("php", "php-fpm"),
          opcache: packageBytes("php", "opcache"),
          dinit: dinit(),
          buildPrograms: {
            php: packageBytes("php", "php"),
            kernel: kernel(),
          },
          outputPath: invocation.outputPath,
        });
        break;
      case "browser-wordpress": {
        const wordpressDirectory = join(work, "wordpress-core");
        const sqliteDirectory = join(work, "wordpress-sqlite-integration");
        materializeSingleRootArchive(
          sourceArchive("wordpress-core"),
          wordpressDirectory,
          "browser-wordpress core",
        );
        materializeSingleRootArchive(
          sourceArchive("wordpress-sqlite-integration"),
          sqliteDirectory,
          "browser-wordpress SQLite integration",
        );
        await buildWordPressVfsImage({
          shellImage,
          wordpressDirectory,
          sqliteDirectory,
          nginx: packageBytes("nginx", "nginx"),
          phpFpm: packageBytes("php", "php-fpm"),
          opcache: packageBytes("php", "opcache"),
          msmtpd: packageBytes("msmtpd", "msmtpd"),
          dinit: dinit(),
          buildPrograms: {
            php: packageBytes("php", "php"),
            kernel: kernel(),
          },
          outputPath: invocation.outputPath,
        });
        break;
      }
      case "browser-lamp": {
        const wordpressDirectory = join(work, "wordpress-core");
        const mariadbSystemTablesDirectory = join(work, "mariadb-system-tables");
        materializeSingleRootArchive(
          sourceArchive("wordpress-core"),
          wordpressDirectory,
          "browser-lamp WordPress core",
        );
        materializeSingleRootArchive(
          packageSourceRole("mariadb", "system-tables"),
          mariadbSystemTablesDirectory,
          "browser-lamp MariaDB system tables",
        );
        const mariadbd = packageBytes("mariadb", "mariadbd");
        await buildLampVfsImage({
          shellImage,
          wordpressDirectory,
          mariadbSystemTablesDirectory,
          mariadbd,
          nginx: packageBytes("nginx", "nginx"),
          phpFpm: packageBytes("php", "php-fpm"),
          opcache: packageBytes("php", "opcache"),
          msmtpd: packageBytes("msmtpd", "msmtpd"),
          dinit: dinit(),
          buildPrograms: {
            php: packageBytes("php", "php"),
            kernel: kernel(),
            mariadb: mariadbd,
          },
          outputPath: invocation.outputPath,
        });
        break;
      }
    }
    await build.finish(invocation.outputPath);
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
}

const STANDALONE_PRODUCT_BUILDERS = new Map([
  [
    "browser-mariadb-wasm32",
    "images/vfs/scripts/build-mariadb-vfs-image.sh",
  ],
  [
    "browser-mariadb-wasm64",
    "images/vfs/scripts/build-mariadb-vfs-image.sh",
  ],
  ["browser-python", "images/vfs/scripts/build-python-vfs-image.sh"],
  ["browser-perl", "images/vfs/scripts/build-perl-vfs-image.sh"],
  ["browser-redis", "images/vfs/scripts/build-redis-vfs-image.sh"],
  ["browser-erlang", "images/vfs/scripts/build-erlang-vfs-image.sh"],
] as const);

const STANDALONE_COMMAND_PRODUCTS = new Map([
  [
    "browser-mariadb",
    new Set(["browser-mariadb-wasm32", "browser-mariadb-wasm64"]),
  ],
  ["browser-python", new Set(["browser-python"])],
  ["browser-perl", new Set(["browser-perl"])],
  ["browser-redis", new Set(["browser-redis"])],
  ["browser-erlang", new Set(["browser-erlang"])],
] as const);

type StandaloneProductId =
  (typeof STANDALONE_PRODUCT_BUILDERS extends Map<infer K, string>
    ? K
    : never);
type StandaloneProductCommand =
  (typeof STANDALONE_COMMAND_PRODUCTS extends Map<infer K, Set<string>>
    ? K
    : never);

/** Build a standalone browser product solely from its resolved manifest inputs. */
export async function buildStagedStandaloneProduct(
  command: StandaloneProductCommand,
  invocation: StagedProductInvocation,
): Promise<void> {
  assertStagedProductEnvironment(process.env);
  const build = await openVfsProductBuild(
    invocation.resolvedInputsPath,
    invocation.builderReportPath,
  );
  const manifest = validateSelectedProductManifest(invocation.manifestPath, build);
  const productId = build.product.id as StandaloneProductId;
  const acceptedProducts = STANDALONE_COMMAND_PRODUCTS.get(command);
  const expectedBuilder = STANDALONE_PRODUCT_BUILDERS.get(productId);
  if (
    acceptedProducts === undefined ||
    !acceptedProducts.has(productId) ||
    manifest.id !== productId ||
    manifest.builder !== expectedBuilder
  ) {
    throw new Error(
      `${command} staging selected a different product or builder`,
    );
  }
  if (
    manifest.composition.product.length !== 0 ||
    manifest.software.homebrew.length !== 0 ||
    manifest.software.archive.length !== 0 ||
    manifest.software.toolchain.length !== 0
  ) {
    throw new Error(
      `${productId} standalone staging accepts only package and repository inputs`,
    );
  }
  const expected = expectedManifestInputs(manifest);
  assertExactInputInventory(build, expected, productId);

  const temporaryRoot = realDirectory(
    process.env.TMPDIR ?? "",
    "staged product temporary root",
  );
  const work = mkdtempSync(join(temporaryRoot, `kandelo-${productId}-`));
  try {
    const packageInput = (name: string, selector: string) =>
      requireExpectedInput(
        build,
        expected,
        resolvedInputId("package-output", name, "output", selector),
        "package-output",
      );
    const packageBytes = (name: string, selector: string): Uint8Array =>
      exactInputBytes(
        packageInput(name, selector),
        `${productId} ${name}/${selector}`,
      );
    const sourceRole = (name: string, role: string): Uint8Array =>
      exactInputBytes(
        requireExpectedInput(
          build,
          expected,
          resolvedInputId("package-output", name, "source-role", role),
          "package-output",
        ),
        `${productId} ${name} source role ${role}`,
      );
    const dinit = () => ({
      dinit: packageBytes("dinit", "dinit"),
      dinitctl: packageBytes("dinit", "dinitctl"),
    });
    const targetAbi = {
      version: build.targetAbi.version,
      snapshotSha256: build.targetAbi.snapshot_sha256,
    };
    const repositoryFile = (
      id: string,
      selectedPath: string,
    ): Uint8Array => {
      const repository = requireExpectedInput(
        build,
        expected,
        resolvedInputId("repository-path", id),
        "repository-path",
      );
      if (repository.placement === "lazy-reference") {
        throw new Error(`${productId} repository ${id} must be embedded`);
      }
      const bundle = readRepositoryPathBundle(repository.path, build.source);
      if (canonicalJson(bundle.paths) !== canonicalJson([selectedPath])) {
        throw new Error(
          `${productId} repository ${id} differs from its canonical paths`,
        );
      }
      const destination = join(work, `repository-${id}`);
      materializeRepositoryPathBundle(bundle, destination);
      const bytes = new Uint8Array(readFileSync(join(destination, selectedPath)));
      if (bytes.byteLength === 0) {
        throw new Error(`${productId} repository file ${selectedPath} is empty`);
      }
      return bytes;
    };

    switch (productId) {
      case "browser-mariadb-wasm32":
      case "browser-mariadb-wasm64": {
        const systemTablesDirectory = join(work, "mariadb-system-tables");
        materializeSingleRootArchive(
          sourceRole("mariadb", "system-tables"),
          systemTablesDirectory,
          `${productId} MariaDB system tables`,
        );
        await buildMariadbVfsImage({
          architecture: build.product.architecture,
          mariadbd: packageBytes("mariadb", "mariadbd"),
          systemTablesDirectory,
          dash: packageBytes("dash", "dash"),
          coreutils: packageBytes("coreutils", "coreutils"),
          dinit: dinit(),
          services: repositoryFile(
            "services-database",
            "images/rootfs/etc/services",
          ),
          outputPath: invocation.outputPath,
          targetAbi,
        });
        break;
      }
      case "browser-python": {
        const runtimeRoot = join(work, "python-runtime");
        materializeArchiveContents(
          packageBytes("cpython", "python-runtime"),
          runtimeRoot,
          "browser-python runtime",
        );
        await buildPythonVfsImage({
          python: packageBytes("cpython", "cpython"),
          runtimeRoot,
          outputPath: invocation.outputPath,
          targetAbi,
        });
        break;
      }
      case "browser-perl": {
        const sourceDirectory = join(work, "perl-standard-library");
        materializeSingleRootArchive(
          sourceRole("perl", "standard-library"),
          sourceDirectory,
          "browser-perl standard library",
        );
        const perl = packageInput("perl", "perl");
        if (perl.placement !== "lazy-reference") {
          throw new Error("browser-perl executable must remain lazy");
        }
        await buildPerlVfsImage({
          sourceDirectory,
          perl: {
            reference: perl.reference,
            sha256: perl.sha256,
            bytes: perl.bytes,
          },
          outputPath: invocation.outputPath,
          targetAbi,
        });
        break;
      }
      case "browser-redis":
        await buildRedisVfsImage({
          redis: packageBytes("redis", "redis-server"),
          dinit: dinit(),
          services: repositoryFile(
            "services-database",
            "images/rootfs/etc/services",
          ),
          outputPath: invocation.outputPath,
          targetAbi,
        });
        break;
      case "browser-erlang": {
        const otpDirectory = join(work, "erlang-otp");
        materializeArchiveContents(
          packageBytes("erlang", "erlang-otp"),
          otpDirectory,
          "browser-erlang OTP runtime",
        );
        await buildErlangVfsImage({
          erlang: packageBytes("erlang", "erlang"),
          otpDirectory,
          outputPath: invocation.outputPath,
          targetAbi,
        });
        break;
      }
    }
    await build.finish(invocation.outputPath);
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
}

const SDK_TEST_PRODUCT_BUILDERS = new Map([
  ["developer-kandelo-sdk", "images/vfs/scripts/build-kandelo-sdk-vfs-image.sh"],
  ["test-mariadb", "images/vfs/scripts/build-mariadb-test-vfs-image.sh"],
  ["test-php", "images/vfs/scripts/build-php-test-vfs-image.sh"],
  ["test-sqlite", "images/vfs/scripts/build-sqlite-test-vfs-image.sh"],
] as const);

type SdkTestProductId =
  (typeof SDK_TEST_PRODUCT_BUILDERS extends Map<infer K, string> ? K : never);

/** Build an SDK or upstream-test product only from its resolved manifest inputs. */
export async function buildStagedSdkOrTestProduct(
  productId: SdkTestProductId,
  invocation: StagedProductInvocation,
): Promise<void> {
  assertStagedProductEnvironment(process.env);
  const build = await openVfsProductBuild(
    invocation.resolvedInputsPath,
    invocation.builderReportPath,
  );
  const manifest = validateSelectedProductManifest(invocation.manifestPath, build);
  if (
    build.product.id !== productId ||
    manifest.id !== productId ||
    manifest.builder !== SDK_TEST_PRODUCT_BUILDERS.get(productId)
  ) {
    throw new Error(`${productId} staging selected a different product or builder`);
  }
  if (
    manifest.software.homebrew.length !== 0 ||
    (productId !== "test-sqlite" && manifest.software.archive.length !== 0) ||
    (productId === "test-sqlite" && (
      manifest.software.archive.length !== 1 ||
      manifest.software.archive[0]?.id !== "sqlite-full-source"
    ))
  ) {
    throw new Error(`${productId} staging has unsupported Homebrew or external archives`);
  }
  const expected = expectedManifestInputs(manifest);
  assertExactInputInventory(build, expected, productId);
  const temporaryRoot = realDirectory(
    process.env.TMPDIR ?? "",
    "staged product temporary root",
  );
  const work = mkdtempSync(join(temporaryRoot, `kandelo-${productId}-`));
  try {
    const required = (id: string, kind: VfsProductInputKind) =>
      requireExpectedInput(build, expected, id, kind);
    const packageBytes = (name: string, output: string) => exactInputBytes(
      required(
        resolvedInputId("package-output", name, "output", output),
        "package-output",
      ),
      `${productId} ${name}/${output}`,
    );
    const archiveBytes = (id: string) => exactInputBytes(
      required(
        resolvedInputId("source-archive", id),
        "source-archive",
      ),
      `${productId} source archive ${id}`,
    );
    const materializeRole = (
      name: string,
      role: string,
      destination: string,
      archiveRoot: string,
    ) => materializeNamedSingleRootArchive(
      exactInputBytes(
        required(
          resolvedInputId("package-output", name, "source-role", role),
          "package-output",
        ),
        `${productId} ${name} source role ${role}`,
      ),
      destination,
      `${productId} ${name} source role ${role}`,
      archiveRoot,
    );
    const materializeRepository = (
      id: string,
      paths: readonly string[],
      destination: string,
    ) => {
      const input = required(
        resolvedInputId("repository-path", id),
        "repository-path",
      );
      if (input.placement === "lazy-reference") {
        throw new Error(`${productId} repository ${id} must be embedded`);
      }
      const bundle = readRepositoryPathBundle(input.path, build.source);
      if (canonicalJson(bundle.paths) !== canonicalJson(paths)) {
        throw new Error(`${productId} repository ${id} differs from canonical paths`);
      }
      materializeRepositoryPathBundle(bundle, destination);
    };
    const targetAbi = {
      version: build.targetAbi.version,
      snapshotSha256: build.targetAbi.snapshot_sha256,
    };

    switch (productId) {
      case "developer-kandelo-sdk": {
        const wrappersRoot = join(work, "sdk-wrappers");
        const glueRoot = join(work, "sdk-glue");
        const licensesRoot = join(work, "sdk-licenses");
        materializeRepository(
          "sdk-wrappers",
          ["sdk/config.site", "sdk/kandelo/bin"],
          wrappersRoot,
        );
        materializeRepository("sdk-glue", ["libc/glue"], glueRoot);
        materializeRepository(
          "sdk-licenses",
          ["COPYING.runtime", "LICENSE", "libc/musl/COPYRIGHT", "sdk/kandelo/licenses"],
          licensesRoot,
        );
        const sysroot = join(work, "wasm32-sysroot");
        const clangResources = join(work, "clang-resource-headers");
        const libcxx = join(work, "libcxx");
        materializeNamedSingleRootArchive(
          exactInputBytes(
            required("toolchain-wasm32-sysroot", "toolchain-output"),
            "developer-kandelo-sdk wasm32 sysroot",
          ),
          sysroot,
          "developer-kandelo-sdk wasm32 sysroot",
          "wasm32-sysroot",
        );
        materializeNamedSingleRootArchive(
          exactInputBytes(
            required("toolchain-clang-resource-headers", "toolchain-output"),
            "developer-kandelo-sdk Clang resource headers",
          ),
          clangResources,
          "developer-kandelo-sdk Clang resource headers",
          "clang-resource-headers",
        );
        materializeNamedSingleRootArchive(
          packageBytes("libcxx", "libcxx"),
          libcxx,
          "developer-kandelo-sdk libc++",
          "libcxx",
        );
        const glueDirectory = join(glueRoot, "libc/glue");
        const glueObjects = join(work, "glue-objects");
        mkdirSync(glueObjects, { mode: 0o700 });
        const compiler = join(wrappersRoot, "sdk/kandelo/bin/wasm32posix-cc");
        for (const name of ["channel_syscall", "compiler_rt", "cxxrt", "dlopen"]) {
          const result = spawnSync(
            compiler,
            ["-O2", "-c", join(glueDirectory, `${name}.c`), "-o", join(glueObjects, `${name}.o`)],
            {
              cwd: work,
              encoding: "utf8",
              env: {
                ...process.env,
                WASM_POSIX_CLANG_RESOURCE_DIR: clangResources,
                WASM_POSIX_CXX_DRIVER: "0",
                WASM_POSIX_GLUE_DIR: glueDirectory,
                WASM_POSIX_GLUE_OBJ_DIR: glueObjects,
                WASM_POSIX_SYSROOT: sysroot,
              },
              maxBuffer: 4 * 1024 * 1024,
            },
          );
          if (result.error) throw result.error;
          if (result.status !== 0) {
            throw new Error(
              `developer-kandelo-sdk glue compilation failed for ${name}:\n` +
                boundedDiagnostics(result.stdout, result.stderr),
            );
          }
        }
        await buildKandeloSdkVfsImage({
          sysrootDirectory: sysroot,
          glueDirectory,
          glueObjectsDirectory: glueObjects,
          sdkBinDirectory: join(wrappersRoot, "sdk/kandelo/bin"),
          configSitePath: join(wrappersRoot, "sdk/config.site"),
          clangResourceDirectory: clangResources,
          libcxxDirectory: libcxx,
          licenseFiles: [
            { hostPath: join(licensesRoot, "LICENSE"), guestPath: "/usr/share/licenses/kandelo/LICENSE" },
            { hostPath: join(licensesRoot, "COPYING.runtime"), guestPath: "/usr/share/licenses/kandelo/COPYING.runtime" },
            { hostPath: join(licensesRoot, "libc/musl/COPYRIGHT"), guestPath: "/usr/share/licenses/musl/COPYRIGHT" },
            { hostPath: join(licensesRoot, "sdk/kandelo/licenses/LLVM-LICENSE.TXT"), guestPath: "/usr/share/licenses/llvm/LICENSE.TXT" },
          ],
          outputPath: invocation.outputPath,
          targetAbi,
        });
        break;
      }
      case "test-mariadb": {
        const systemTables = join(work, "mariadb-system-tables");
        const testSuite = join(work, "mariadb-test-suite");
        const repository = join(work, "mariadb-repository");
        materializeRole("mariadb", "system-tables", systemTables, "system-tables");
        materializeRole("mariadb", "test-suite", testSuite, "test-suite");
        materializeRepository(
          "services-database",
          ["images/rootfs/etc/services"],
          repository,
        );
        await buildMariadbTestVfsImage({
          mariadbd: packageBytes("mariadb", "mariadbd"),
          mysqltest: packageBytes("mariadb", "mysqltest"),
          dash: packageBytes("dash", "dash"),
          coreutils: packageBytes("coreutils", "coreutils"),
          dinit: {
            dinit: packageBytes("dinit", "dinit"),
            dinitctl: packageBytes("dinit", "dinitctl"),
          },
          services: new Uint8Array(
            readFileSync(join(repository, "images/rootfs/etc/services")),
          ),
          systemTablesDirectory: systemTables,
          testSuiteDirectory: testSuite,
          includeAll: false,
          outputPath: invocation.outputPath,
          targetAbi,
        });
        break;
      }
      case "test-php": {
        const source = join(work, "php-test-suite");
        const repository = join(work, "php-repository");
        materializeRole("php", "test-suite", source, "test-suite");
        materializeRepository(
          "php-test-fixtures",
          ["tests/php-fixtures"],
          repository,
        );
        const base = exactInputBytes(
          required("product-platform-rootfs", "product-image"),
          "test-php platform rootfs",
        );
        const extensionOutputs = ["opcache", "curl", "phar", "zend_test", "zip", "intl"];
        const extensions = Object.fromEntries(
          extensionOutputs.map((name) => [`${name}.so`, packageBytes("php", name)]),
        );
        await buildPhpTestVfsImage({
          baseImage: base,
          php: packageBytes("php", "php"),
          phpFpm: packageBytes("php", "php-fpm"),
          extensions,
          icuData: packageBytes("php", "icu-data"),
          sourceDirectory: source,
          fixtureDirectory: join(repository, "tests/php-fixtures"),
          outputPath: invocation.outputPath,
          targetAbi,
        });
        break;
      }
      case "test-sqlite": {
        const sqliteSource = join(work, "sqlite-full-source");
        const tclLibrary = join(work, "tcl-runtime-library");
        // These build-only objects are inputs to the transitional package
        // adapter that produced sqlite3/testfixture. The final VFS composer
        // authenticates their exact captured bytes as part of the product
        // report even though it embeds only the resulting programs/runtime.
        for (const [name, output] of [
          ["sqlite", "development-files"],
          ["tcl", "development-files"],
          ["zlib", "zlib"],
        ] as const) {
          packageBytes(name, output);
        }
        materializeNamedSingleRootArchive(
          archiveBytes("sqlite-full-source"),
          sqliteSource,
          "test-sqlite full source",
          "sqlite-src-3490100",
        );
        materializeRole("tcl", "runtime-library", tclLibrary, "runtime-library");
        await buildSqliteTestVfsImage({
          sqlite3: packageBytes("sqlite", "sqlite3"),
          testfixture: packageBytes("sqlite", "testfixture"),
          dash: packageBytes("dash", "dash"),
          coreutils: packageBytes("coreutils", "coreutils"),
          sqliteSourceDirectory: sqliteSource,
          tclLibraryDirectory: tclLibrary,
          outputPath: invocation.outputPath,
          targetAbi,
        });
        break;
      }
    }
    await build.finish(invocation.outputPath);
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
}

function expectedManifestInputs(
  manifest: SelectedProductManifest,
): Map<string, ExpectedServiceInput> {
  const expected = new Map<string, ExpectedServiceInput>();
  const add = (
    id: string,
    kind: VfsProductInputKind,
    placement: ExpectedServiceInput["placement"],
  ) => {
    if (expected.has(id)) {
      throw new Error(`${manifest.id} manifest repeats staged input ${id}`);
    }
    expected.set(id, { kind, placement });
  };
  for (const product of manifest.composition.product) {
    add(
      resolvedInputId("product-image", product.id),
      "product-image",
      runtimePlacement(product.materialization),
    );
  }
  for (const repository of manifest.composition.repository) {
    add(
      resolvedInputId("repository-path", repository.id),
      "repository-path",
      claimPlacement(repository.role, repository.materialization),
    );
  }
  for (const claim of manifest.software.package) {
    for (const output of claim.outputs) {
      add(
        resolvedInputId("package-output", claim.name, "output", output),
        "package-output",
        claimPlacement(claim.role, claim.materialization),
      );
    }
    for (const role of claim.source_roles) {
      add(
        resolvedInputId("package-output", claim.name, "source-role", role),
        "package-output",
        claimPlacement(claim.role, claim.materialization),
      );
    }
  }
  for (const group of manifest.software.homebrew) {
    for (const formula of group.formulae) {
      add(
        resolvedInputId("homebrew-bottle", formula),
        "homebrew-bottle",
        runtimePlacement(group.materialization),
      );
    }
  }
  for (const archive of manifest.software.archive) {
    add(
      resolvedInputId("source-archive", archive.id),
      "source-archive",
      claimPlacement(archive.role, archive.materialization),
    );
  }
  for (const toolchain of manifest.software.toolchain) {
    add(
      resolvedInputId("toolchain-output", toolchain.id),
      "toolchain-output",
      claimPlacement(toolchain.role, toolchain.materialization),
    );
  }
  return expected;
}

function runtimePlacement(
  materialization: "embedded" | "lazy",
): "embedded" | "lazy-reference" {
  return materialization === "embedded" ? "embedded" : "lazy-reference";
}

function claimPlacement(
  role: "runtime" | "build",
  materialization?: "embedded" | "lazy",
): ExpectedServiceInput["placement"] {
  if (role === "build") return "build-only";
  if (materialization === undefined) {
    throw new Error("runtime staged input omits materialization");
  }
  return runtimePlacement(materialization);
}

function resolvedInputId(
  kind: VfsProductInputKind,
  ...parts: string[]
): string {
  const prefix: Record<VfsProductInputKind, string> = {
    "product-image": "product",
    "homebrew-bottle": "homebrew",
    "package-output": "package",
    "source-archive": "archive",
    "toolchain-output": "toolchain",
    "repository-path": "repository",
  };
  const stem = [prefix[kind], ...parts].join("-");
  if (Buffer.byteLength(stem, "utf8") <= 128) return stem;
  const suffix = digest(Buffer.from(canonicalJson({ kind, parts }))).slice(0, 16);
  return `${stem.slice(0, 128 - suffix.length - 1).replace(/[-._]+$/, "")}-${suffix}`;
}

function assertExactInputInventory(
  build: VfsProductBuild,
  expected: ReadonlyMap<string, ExpectedServiceInput>,
  productId: string,
): void {
  const homebrewIds = new Set(build.inputIds("homebrew-bottle"));
  const actual = [...build.inputIds()]
    .filter((id) => !homebrewIds.has(id))
    .sort(compareText);
  const wanted = [...expected.entries()]
    .filter(([, item]) => item.kind !== "homebrew-bottle")
    .map(([id]) => id)
    .sort(compareText);
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error(
      `${productId} resolved input IDs differ from its canonical manifest: ` +
        `expected ${wanted.join(", ")}; received ${actual.join(", ")}`,
    );
  }
  for (const [id, item] of expected) {
    if (!build.inputIds(item.kind).includes(id)) {
      throw new Error(`${productId} input ${id} has the wrong input kind`);
    }
  }
}

function requireExpectedInput(
  build: VfsProductBuild,
  expected: ReadonlyMap<string, ExpectedServiceInput>,
  id: string,
  kind: VfsProductInputKind,
): VfsProductInputHandle {
  const declaration = expected.get(id);
  if (declaration?.kind !== kind) {
    throw new Error(`${build.product.id} does not canonically declare ${id}`);
  }
  const handle = kind === "product-image"
    ? build.requireProductImage(id)
    : kind === "package-output"
      ? build.requirePackageOutput(id)
      : kind === "source-archive"
        ? build.requireSourceArchive(id)
        : kind === "toolchain-output"
          ? build.requireToolchainOutput(id)
          : kind === "repository-path"
            ? build.requireRepositoryPath(id)
            : build.requireHomebrewBottle(id);
  if (handle.placement !== declaration.placement) {
    throw new Error(
      `${build.product.id} input ${id} materialized as ${handle.placement}, ` +
        `expected ${declaration.placement}`,
    );
  }
  return handle;
}

function exactInputBytes(
  handle: VfsProductInputHandle,
  label: string,
): Uint8Array {
  if (handle.placement === "lazy-reference") {
    throw new Error(`${label} must be materialized for this build`);
  }
  const bytes = new Uint8Array(readFileSync(handle.path));
  if (bytes.byteLength === 0) throw new Error(`${label} is empty`);
  return bytes;
}

function readVfsBytes(fs: MemoryFileSystem, path: string): Uint8Array {
  const size = fs.stat(path).size;
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`short VFS read for ${path}`);
      }
      offset += count;
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}

const MAX_SOURCE_TREE_BYTES = 512 * 1024 * 1024;

function materializeSingleRootArchive(
  bytes: Uint8Array,
  destination: string,
  label: string,
): void {
  materializeExactArchive(bytes, destination, label, true);
}

function materializeNamedSingleRootArchive(
  bytes: Uint8Array,
  destination: string,
  label: string,
  expectedRoot: string,
): void {
  materializeExactArchive(bytes, destination, label, true, expectedRoot);
}

function materializeArchiveContents(
  bytes: Uint8Array,
  destination: string,
  label: string,
): void {
  materializeExactArchive(bytes, destination, label, false);
}

function materializeExactArchive(
  bytes: Uint8Array,
  destination: string,
  label: string,
  stripSingleRoot: boolean,
  expectedRoot?: string,
): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new Error(`${label} archive size is outside the accepted bound`);
  }
  mkdirSync(destination, { mode: 0o700 });
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    materializeTarEntries(
      parseTarGzip(bytes, {
        label,
        limits: {
          maxCompressedBytes: MAX_BUNDLE_BYTES,
          maxUncompressedBytes: MAX_SOURCE_TREE_BYTES,
          maxEntries: MAX_BUNDLE_ENTRIES,
        },
      }),
      destination,
      label,
      stripSingleRoot,
      expectedRoot,
    );
    return;
  }
  if (
    bytes[0] === 0x28 &&
    bytes[1] === 0xb5 &&
    bytes[2] === 0x2f &&
    bytes[3] === 0xfd
  ) {
    const decompressed = new Uint8Array(zstdDecompressSync(bytes, {
      maxOutputLength: MAX_SOURCE_TREE_BYTES,
    }));
    materializeTarEntries(
      parseTarBytes(decompressed, {
        label,
        limits: {
          maxUncompressedBytes: MAX_SOURCE_TREE_BYTES,
          maxEntries: MAX_BUNDLE_ENTRIES,
        },
      }),
      destination,
      label,
      stripSingleRoot,
      expectedRoot,
    );
    return;
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    materializeZipSource(
      bytes,
      destination,
      label,
      stripSingleRoot,
      expectedRoot,
    );
    return;
  }
  throw new Error(`${label} is not a supported gzip/zstd TAR or ZIP archive`);
}

function materializeTarEntries(
  entries: readonly TarEntry[],
  destination: string,
  label: string,
  stripSingleRoot: boolean,
  expectedRoot?: string,
): void {
  const root = stripSingleRoot
    ? commonArchiveRoot(entries.map((entry) => entry.path), label)
    : null;
  if (expectedRoot !== undefined && root !== expectedRoot) {
    throw new Error(`${label} has top-level directory ${root}, expected ${expectedRoot}`);
  }
  for (const entry of entries) {
    if (entry.type === "symlink" || entry.type === "hardlink") {
      throw new Error(`${label} contains unsupported ${entry.type} ${entry.path}`);
    }
    const relativePath = root === null
      ? normalizedArchiveComponents(entry.path, label).join("/")
      : stripArchiveRoot(entry.path, root, label);
    if (relativePath === null) continue;
    if (entry.type === "directory") {
      materializeArchiveDirectory(destination, relativePath, entry.mode);
    } else {
      materializeArchiveFile(
        destination,
        relativePath,
        entry.data,
        entry.mode,
        label,
      );
    }
  }
}

function materializeZipSource(
  bytes: Uint8Array,
  destination: string,
  label: string,
  stripSingleRoot: boolean,
  expectedRoot?: string,
): void {
  const entries = parseZipCentralDirectory(bytes);
  if (entries.length === 0 || entries.length > MAX_BUNDLE_ENTRIES) {
    throw new Error(`${label} ZIP entry count is outside the accepted bound`);
  }
  const totalBytes = entries.reduce((sum, entry) => {
    if (!Number.isSafeInteger(entry.uncompressedSize)) {
      throw new Error(`${label} ZIP entry has an invalid size`);
    }
    return sum + entry.uncompressedSize;
  }, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SOURCE_TREE_BYTES) {
    throw new Error(`${label} ZIP expands beyond the accepted bound`);
  }
  const root = stripSingleRoot
    ? commonArchiveRoot(entries.map((entry) => entry.fileName), label)
    : null;
  if (expectedRoot !== undefined && root !== expectedRoot) {
    throw new Error(`${label} has top-level directory ${root}, expected ${expectedRoot}`);
  }
  for (const entry of entries) {
    if (entry.isSymlink) {
      throw new Error(`${label} contains unsupported symlink ${entry.fileName}`);
    }
    const relativePath = root === null
      ? normalizedArchiveComponents(entry.fileName, label).join("/")
      : stripArchiveRoot(entry.fileName, root, label);
    if (relativePath === null) continue;
    if (entry.isDirectory) {
      materializeArchiveDirectory(destination, relativePath, entry.mode);
    } else {
      materializeArchiveFile(
        destination,
        relativePath,
        extractZipEntryBounded(bytes, entry, entry.uncompressedSize),
        entry.mode,
        label,
      );
    }
  }
}

function commonArchiveRoot(paths: readonly string[], label: string): string {
  let root: string | undefined;
  let hasChild = false;
  for (const path of paths) {
    const components = normalizedArchiveComponents(path, label);
    if (components.length > 1) hasChild = true;
    if (root === undefined) root = components[0];
    if (root !== components[0]) {
      throw new Error(`${label} does not have one exact top-level directory`);
    }
  }
  if (root === undefined || !hasChild) {
    throw new Error(`${label} has no files below its top-level directory`);
  }
  return root;
}

function stripArchiveRoot(
  path: string,
  root: string,
  label: string,
): string | null {
  const components = normalizedArchiveComponents(path, label);
  if (components[0] !== root) {
    throw new Error(`${label} entry moved outside its top-level directory`);
  }
  return components.length === 1 ? null : components.slice(1).join("/");
}

function normalizedArchiveComponents(path: string, label: string): string[] {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  const components = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    components.some((item) => item.length === 0 || item === "." || item === "..")
  ) {
    throw new Error(`${label} contains unsafe archive path ${JSON.stringify(path)}`);
  }
  return components;
}

function materializeArchiveDirectory(
  root: string,
  relativePath: string,
  mode: number,
): void {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(path, { mode: archiveMode(mode, 0o755), recursive: true });
  chmodSync(path, archiveMode(mode, 0o755));
}

function materializeArchiveFile(
  root: string,
  relativePath: string,
  bytes: Uint8Array,
  mode: number,
  label: string,
): void {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { mode: 0o755, recursive: true });
  try {
    writeFileSync(path, bytes, {
      flag: "wx",
      mode: archiveMode(mode, 0o644),
    });
  } catch (error) {
    throw new Error(`${label} has a duplicate or conflicting entry ${relativePath}`, {
      cause: error,
    });
  }
}

function archiveMode(mode: number, fallback: number): number {
  const permissions = mode & 0o777;
  return permissions === 0 ? fallback : permissions;
}

export function parseStagedProductInvocation(
  arguments_: readonly string[],
): StagedProductInvocation | null {
  if (arguments_.length === 0) return null;
  if (arguments_.length !== STAGING_FLAGS.size * 2) {
    throw new Error(
      "staging flags must be exactly --vfs-product-manifest, --vfs-product-inputs, --vfs-product-report, and --vfs-product-output",
    );
  }
  const values: Partial<StagedProductInvocation> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const field = STAGING_FLAGS.get(flag as keyof typeof STAGING_FLAGS);
    if (field === undefined) {
      throw new Error(`unknown staging flag ${JSON.stringify(flag)}`);
    }
    if (values[field] !== undefined) {
      throw new Error(`duplicate staging flag ${JSON.stringify(flag)}`);
    }
    const value = arguments_[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      !isAbsolute(value) ||
      resolve(value) !== value
    ) {
      throw new Error(`${flag} must name a normalized absolute path`);
    }
    values[field] = value;
  }
  for (const field of STAGING_FLAGS.values()) {
    if (values[field] === undefined) {
      throw new Error(`staging flags omit ${field}`);
    }
  }
  const invocation = values as StagedProductInvocation;
  if (new Set(Object.values(invocation)).size !== 4) {
    throw new Error("staging manifest, input, report, and output paths must be distinct");
  }
  return invocation;
}

/** Reject legacy discovery variables before an opt-in staged builder runs. */
export function assertStagedProductEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const forbidden = Object.keys(environment)
    .filter((name) => {
      const value = environment[name];
      if (value === undefined || value === "") return false;
      return (
        name === "BOTTLE_CACHE" ||
        name === "KANDELO_NO_OPCACHE_PREWARM" ||
        name === "KANDELO_OPCACHE_PREWARM_STRICT" ||
        name === "KANDELO_VFS_INPUT_ROOT" ||
        name === "ROOTFS_BINARIES_DIR" ||
        name === "ROOTFS_PACKAGE_MANIFEST" ||
        name === "ROOTFS_PACKAGES_CONFIG" ||
        name === "WASM_POSIX_BINARY_CACHE_ROOT" ||
        name === "WASM_POSIX_DEPS_REGISTRY" ||
        /^WASM_POSIX_DEP_[A-Z0-9_]+_DIR$/.test(name)
      );
    })
    .sort();
  if (forbidden.length > 0) {
    throw new Error(
      `staged VFS product rejects ambient input authority: ${forbidden.join(", ")}`,
    );
  }
}

export function readRepositoryPathBundle(
  path: string,
  expectedSource: Readonly<ExactSourceIdentity>,
): RepositoryPathBundle {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("repository bundle must be a regular nonsymlink file");
  }
  if (metadata.size > MAX_BUNDLE_BYTES) {
    throw new Error(`repository bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  }
  const text = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`repository bundle is invalid JSON: ${describeError(error)}`);
  }
  if (canonicalJson(value) !== text) {
    throw new Error("repository bundle is not canonical JSON");
  }
  const root = exactRecord(
    value,
    ["entries", "kind", "paths", "schema", "source"],
    "repository bundle",
  );
  if (
    root.schema !== 1 ||
    root.kind !== "kandelo-vfs-repository-path-bundle"
  ) {
    throw new Error("repository bundle protocol is unsupported");
  }
  const source = sourceIdentity(root.source, "repository bundle source");
  if (canonicalJson(source) !== canonicalJson(sourceIdentity(expectedSource, "expected source"))) {
    throw new Error("repository bundle source differs from the resolved exact source");
  }
  if (!Array.isArray(root.paths)) {
    throw new Error("repository bundle paths must be an array");
  }
  const paths = normalizedRoots(root.paths);
  if (!Array.isArray(root.entries) || root.entries.length > MAX_BUNDLE_ENTRIES) {
    throw new Error("repository bundle entries exceed their bound");
  }
  const seen = new Set<string>();
  let previous = "";
  const entries = root.entries.map((raw, index): RepositoryPathBundleEntry => {
    const entry = recordValue(raw, `repository bundle entry ${index}`);
    const kind = entry.kind;
    const keys = kind === "file"
      ? ["bytes", "content_base64", "kind", "mode", "path", "sha256"]
      : kind === "directory"
      ? ["kind", "mode", "path"]
      : kind === "symlink"
      ? ["kind", "mode", "path", "target"]
      : [];
    if (keys.length === 0) {
      throw new Error(`repository bundle entry ${index} kind is unsupported`);
    }
    exactRecord(entry, keys, `repository bundle entry ${index}`);
    const entryPath = normalizedRelativePath(
      entry.path,
      `repository bundle entry ${index} path`,
    );
    if (
      entryPath <= previous ||
      seen.has(entryPath) ||
      !paths.some((rootPath) => isAtOrBelow(rootPath, entryPath))
    ) {
      throw new Error("repository bundle entry paths are not sorted, unique, and selected");
    }
    previous = entryPath;
    seen.add(entryPath);
    const mode = fileMode(entry.mode, `repository bundle entry ${index} mode`);
    if (kind === "directory") return { kind, mode, path: entryPath };
    if (kind === "symlink") {
      const target = textValue(entry.target, `repository bundle entry ${index} target`, 4096);
      validateSymlinkTarget(entryPath, target);
      return { kind, mode, path: entryPath, target };
    }
    const bytes = nonnegativeInteger(
      entry.bytes,
      `repository bundle entry ${index} bytes`,
    );
    const sha256 = sha(entry.sha256, `repository bundle entry ${index} SHA-256`);
    const contentBase64 = entry.content_base64;
    if (
      typeof contentBase64 !== "string" ||
      contentBase64.includes("\0") ||
      Buffer.byteLength(contentBase64) > MAX_BUNDLE_BYTES * 2
    ) {
      throw new Error(`repository bundle entry ${index} base64 must be bounded text`);
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
      throw new Error(`repository bundle entry ${index} content is not canonical base64`);
    }
    const contents = Buffer.from(contentBase64, "base64");
    if (contents.toString("base64") !== contentBase64) {
      throw new Error(`repository bundle entry ${index} content is not canonical base64`);
    }
    if (contents.byteLength !== bytes) {
      throw new Error(`repository bundle entry ${index} byte count does not match`);
    }
    if (digest(contents) !== sha256) {
      throw new Error(`repository bundle entry ${index} SHA-256 does not match`);
    }
    return {
      bytes,
      content_base64: contentBase64,
      kind,
      mode,
      path: entryPath,
      sha256,
    };
  });
  for (const rootPath of paths) {
    if (!entries.some((entry) => isAtOrBelow(rootPath, entry.path))) {
      throw new Error(`repository bundle omits selected root ${JSON.stringify(rootPath)}`);
    }
  }
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    const resolvedTarget = normalizeRelativeTarget(entry.path, entry.target);
    if (!seen.has(resolvedTarget)) {
      throw new Error(
        `repository bundle symlink ${JSON.stringify(entry.path)} targets unselected path ${JSON.stringify(resolvedTarget)}`,
      );
    }
  }
  return Object.freeze({
    schema: 1,
    kind: "kandelo-vfs-repository-path-bundle",
    source: Object.freeze(source),
    paths: Object.freeze(paths),
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
}

export function materializeRepositoryPathBundle(
  bundle: RepositoryPathBundle,
  destination: string,
): void {
  try {
    lstatSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(destination, { recursive: false, mode: 0o700 });
    const directories = bundle.entries
      .filter((entry) => entry.kind === "directory")
      .sort((left, right) => {
        const depth = left.path.split("/").length - right.path.split("/").length;
        return depth || compareText(left.path, right.path);
      });
    for (const entry of directories) {
      const target = within(destination, entry.path, "repository bundle directory");
      mkdirSync(target, { recursive: true, mode: entry.mode });
      chmodSync(target, entry.mode);
    }
    for (const entry of bundle.entries) {
      if (entry.kind === "directory") continue;
      const target = within(destination, entry.path, "repository bundle entry");
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      if (entry.kind === "symlink") {
        symlinkSync(entry.target, target);
      } else {
        const contents = Buffer.from(entry.content_base64, "base64");
        writeFileSync(target, contents, { flag: "wx", mode: entry.mode });
        chmodSync(target, entry.mode);
      }
    }
    return;
  }
  throw new Error(`repository bundle destination already exists: ${destination}`);
}


function normalizedRoots(value: readonly unknown[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error("repository bundle paths must contain 1..256 entries");
  }
  const paths = value.map((path, index) =>
    normalizedRelativePath(path, `repository bundle path ${index}`)
  );
  const sorted = [...new Set(paths)].sort(compareText);
  if (
    sorted.length !== paths.length ||
    sorted.some((path, index) => path !== paths[index]) ||
    sorted.some((path, index) =>
      sorted.some((other, otherIndex) =>
        index !== otherIndex && isAtOrBelow(other, path)
      )
    )
  ) {
    throw new Error("repository bundle paths must be sorted, unique, and nonoverlapping");
  }
  return sorted;
}

function sourceIdentity(value: unknown, label: string): ExactSourceIdentity {
  const source = exactRecord(value, ["commit", "repository", "tree"], label);
  const repository = textValue(source.repository, `${label} repository`, 255);
  if (!REPOSITORY.test(repository)) throw new Error(`${label} repository is invalid`);
  return {
    repository,
    commit: gitSha(source.commit, `${label} commit`),
    tree: gitSha(source.tree, `${label} tree`),
  };
}

function normalizedRelativePath(value: unknown, label: string): string {
  const path = textValue(value, label, 4096);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path !== path.normalize("NFC") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not a normalized relative POSIX path`);
  }
  return path;
}

function validateSymlinkTarget(path: string, target: string): void {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.length > 4096 ||
    target.includes("\0") ||
    target.includes("\\") ||
    target.startsWith("/") ||
    target !== target.normalize("NFC")
  ) {
    throw new Error(`repository symlink ${JSON.stringify(path)} has an unsafe target`);
  }
  normalizeRelativeTarget(path, target);
}

function normalizeRelativeTarget(path: string, target: string): string {
  const stack = path.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) {
        throw new Error(`repository symlink ${JSON.stringify(path)} escapes its bundle`);
      }
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  if (stack.length === 0) {
    throw new Error(`repository symlink ${JSON.stringify(path)} targets the bundle root`);
  }
  return stack.join("/");
}

function realDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(absolute);
}

function within(root: string, path: string, label: string): string {
  const target = resolve(root, ...path.split("/"));
  assertBelow(root, target, label);
  return target;
}

function assertBelow(root: string, target: string, label: string): void {
  const fromRoot = relative(root, target);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} escapes its root`);
  }
}

function isAtOrBelow(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function assertNewRegularParent(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  const parent = lstatSync(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`${label} parent must be a real directory`);
  }
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists`);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = recordValue(value, label);
  const actual = Object.keys(record).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return record;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function textValue(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maximum
  ) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function fileMode(value: unknown, label: string): number {
  const mode = nonnegativeInteger(value, label);
  if (mode > 0o7777) throw new Error(`${label} exceeds POSIX permission bits`);
  return mode;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is not lowercase SHA-256`);
  }
  return value;
}

function gitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) {
    throw new Error(`${label} is not a full lowercase Git SHA`);
  }
  return value;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SelectedProductManifest {
  id: string;
  architecture: "wasm32" | "wasm64";
  output: string;
  builder: string;
  composition: {
    product: Array<{
      id: string;
      materialization: "embedded" | "lazy";
    }>;
    repository: Array<{
      id: string;
      paths: string[];
      role: "runtime" | "build";
      materialization?: "embedded" | "lazy";
    }>;
  };
  software: {
    homebrew: Array<{
      tap: string;
      formulae: string[];
      materialization: "embedded" | "lazy";
    }>;
    package: Array<{
      name: string;
      outputs: string[];
      source_roles: string[];
      role: "runtime" | "build";
      materialization?: "embedded" | "lazy";
    }>;
    archive: Array<{
      id: string;
      url: string;
      sha256: string;
      role: "runtime" | "build";
      materialization?: "embedded" | "lazy";
    }>;
    toolchain: Array<{
      id: string;
      component: string;
      provider: string;
      role: "runtime" | "build";
      materialization?: "embedded" | "lazy";
    }>;
  };
}

function validateSelectedProductManifest(
  manifestPath: string,
  build: Awaited<ReturnType<typeof openVfsProductBuild>>,
): SelectedProductManifest {
  const expectedPath = resolve(REPOSITORY_ROOT, build.product.manifest_path);
  if (manifestPath !== expectedPath) {
    throw new Error("staged product manifest path differs from resolved inputs");
  }
  const metadata = lstatSync(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("staged product manifest must be a regular nonsymlink file");
  }
  const catalog = loadVfsProductCatalog(
    join(REPOSITORY_ROOT, "images/vfs/products/generated/catalog.json"),
  );
  const manifest = catalog.productById(build.product.id) as SelectedProductManifest;
  if (manifest.software.homebrew.length !== 0) {
    throw new Error(`${manifest.id} cannot build while Homebrew is disabled`);
  }
  if (
    manifest.id !== build.product.id ||
    manifest.architecture !== build.product.architecture ||
    manifest.output !== build.product.output ||
    digest(Buffer.from(canonicalJson(manifest))) !== build.product.manifest_sha256
  ) {
    throw new Error("staged product manifest identity differs from resolved inputs");
  }
  return manifest;
}

function boundedDiagnostics(...values: readonly string[]): string {
  const joined = values.filter((value) => value.length > 0).join("\n");
  const maximum = 32 * 1024;
  return joined.length <= maximum
    ? joined
    : `${joined.slice(0, maximum)}\n[diagnostics truncated]`;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  const command = process.argv[2];
  Promise.resolve().then(async () => {
    if (
      command !== "platform-rootfs" &&
      command !== "browser-main-shell" &&
      !SERVICE_PRODUCT_BUILDERS.has(command as ServiceProductId) &&
      !STANDALONE_COMMAND_PRODUCTS.has(command as StandaloneProductCommand) &&
      !SDK_TEST_PRODUCT_BUILDERS.has(command as SdkTestProductId)
    ) {
      throw new Error(
        "expected a supported staged VFS product command",
      );
    }
    const invocation = parseStagedProductInvocation(process.argv.slice(3));
    if (invocation === null) {
      throw new Error(`${command} staging flags are required`);
    }
    if (command === "platform-rootfs") {
      await buildStagedPlatformRootfs(invocation);
    } else if (command === "browser-main-shell") {
      await buildStagedBrowserMainShell(invocation);
    } else if (
      STANDALONE_COMMAND_PRODUCTS.has(command as StandaloneProductCommand)
    ) {
      await buildStagedStandaloneProduct(
        command as StandaloneProductCommand,
        invocation,
      );
    } else if (SDK_TEST_PRODUCT_BUILDERS.has(command as SdkTestProductId)) {
      await buildStagedSdkOrTestProduct(
        command as SdkTestProductId,
        invocation,
      );
    } else {
      await buildStagedBrowserService(command as ServiceProductId, invocation);
    }
  }).catch((error) => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  });
}
