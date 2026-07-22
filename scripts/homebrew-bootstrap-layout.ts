import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const HOMEBREW_BOOTSTRAP_PREFIX = "/home/linuxbrew/.linuxbrew";
export const HOMEBREW_BOOTSTRAP_HOME = "/home/linuxbrew";
export const HOMEBREW_BOOTSTRAP_UID = 1000;
export const HOMEBREW_BOOTSTRAP_GID = 1000;
export const HOMEBREW_BOOTSTRAP_EAGER_ROOTFS_PACKAGES = [
  "dash",
  "bash",
  "coreutils",
  "gawk",
  "grep",
  "sed",
  "findutils",
] as const;
export const HOMEBREW_BOOTSTRAP_EAGER_ROOTFS_OUTPUTS = [
  { package: "posix-utils-lite", path: "/usr/bin/locale" },
] as const;

type GuestMode = "0700" | "0755";

export interface HomebrewBootstrapDirectory {
  path: string;
  mode: GuestMode;
  purpose: "home" | "repository" | "install-state" | "cache" | "configuration";
}

export interface HomebrewBootstrapEntrypoint {
  path: string;
  kind: "wasm-program" | "ruby-script" | "symlink";
  provider: "bootstrap-manifest" | "ruby-runtime";
  target?: string;
}

export interface HomebrewBootstrapLayout {
  schema: 1;
  guest: {
    uid: number;
    gid: number;
    home: string;
  };
  prefix: string;
  eagerRootfsPackages: string[];
  eagerRootfsOutputs: Array<{ package: string; path: string }>;
  repository: {
    path: string;
    state: "mutable-working-repository";
    initialSourceProvenance: string;
  };
  entrypoints: HomebrewBootstrapEntrypoint[];
  writableDirectories: HomebrewBootstrapDirectory[];
  protectedFiles: Array<{
    path: string;
    mode: "0444";
    owner: "root";
    purpose: "system-environment" | "source-provenance" | "layout-contract";
  }>;
}

/**
 * The live Homebrew checkout is intentionally guest-writable. Stock Homebrew
 * updates its repository and creates taps below Library/Taps. The immutable
 * VFS artifact and root-owned image metadata bind the checkout's initial
 * source; they do not pretend the post-boot working repository is immutable.
 */
export const HOMEBREW_BOOTSTRAP_LAYOUT: HomebrewBootstrapLayout = {
  schema: 1,
  guest: {
    uid: HOMEBREW_BOOTSTRAP_UID,
    gid: HOMEBREW_BOOTSTRAP_GID,
    home: HOMEBREW_BOOTSTRAP_HOME,
  },
  prefix: HOMEBREW_BOOTSTRAP_PREFIX,
  eagerRootfsPackages: [...HOMEBREW_BOOTSTRAP_EAGER_ROOTFS_PACKAGES],
  eagerRootfsOutputs: HOMEBREW_BOOTSTRAP_EAGER_ROOTFS_OUTPUTS.map((entry) => ({ ...entry })),
  repository: {
    path: HOMEBREW_BOOTSTRAP_PREFIX,
    state: "mutable-working-repository",
    initialSourceProvenance: "/etc/kandelo/homebrew-image.json",
  },
  entrypoints: [
    {
      path: "/usr/bin/brew",
      kind: "symlink",
      provider: "bootstrap-manifest",
      target: `${HOMEBREW_BOOTSTRAP_PREFIX}/bin/brew`,
    },
    {
      path: "/usr/bin/ruby",
      kind: "wasm-program",
      provider: "bootstrap-manifest",
    },
    { path: "/usr/bin/gem", kind: "ruby-script", provider: "ruby-runtime" },
    { path: "/usr/bin/bundle", kind: "ruby-script", provider: "ruby-runtime" },
    { path: "/usr/bin/bundler", kind: "ruby-script", provider: "ruby-runtime" },
  ],
  writableDirectories: [
    { path: HOMEBREW_BOOTSTRAP_HOME, mode: "0755", purpose: "home" },
    { path: `${HOMEBREW_BOOTSTRAP_HOME}/.cache`, mode: "0700", purpose: "cache" },
    { path: `${HOMEBREW_BOOTSTRAP_HOME}/.cache/Homebrew`, mode: "0700", purpose: "cache" },
    { path: `${HOMEBREW_BOOTSTRAP_HOME}/.cache/Homebrew/Formula`, mode: "0700", purpose: "cache" },
    { path: `${HOMEBREW_BOOTSTRAP_HOME}/.cache/Homebrew/Logs`, mode: "0700", purpose: "cache" },
    { path: `${HOMEBREW_BOOTSTRAP_HOME}/.config`, mode: "0700", purpose: "configuration" },
    { path: `${HOMEBREW_BOOTSTRAP_HOME}/.config/homebrew`, mode: "0700", purpose: "configuration" },
    { path: HOMEBREW_BOOTSTRAP_PREFIX, mode: "0755", purpose: "repository" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/bin`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/Caskroom`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/Cellar`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/etc`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/etc/homebrew`, mode: "0755", purpose: "configuration" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/Frameworks`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/include`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/lib`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/Library`, mode: "0755", purpose: "repository" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/Library/Taps`, mode: "0755", purpose: "repository" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/opt`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/sbin`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/share`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/var`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/var/homebrew`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/var/homebrew/linked`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/var/homebrew/locks`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/var/homebrew/pinned`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/var/homebrew/pinned_casks`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/var/homebrew/tmp`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/var/homebrew/tmp/.cellar`, mode: "0755", purpose: "install-state" },
    { path: `${HOMEBREW_BOOTSTRAP_PREFIX}/var/log`, mode: "0755", purpose: "install-state" },
  ],
  protectedFiles: [
    {
      path: "/etc/homebrew/brew.env",
      mode: "0444",
      owner: "root",
      purpose: "system-environment",
    },
    {
      path: "/etc/kandelo/homebrew-image.json",
      mode: "0444",
      owner: "root",
      purpose: "source-provenance",
    },
    {
      path: "/etc/kandelo/homebrew-bootstrap-layout.json",
      mode: "0444",
      owner: "root",
      purpose: "layout-contract",
    },
  ],
};

const EAGER_PROGRAMS = [
  { key: "ruby", path: "/usr/bin/ruby", aliases: ["/bin/ruby"] },
  { key: "git", path: "/usr/bin/git", aliases: ["/bin/git"] },
  { key: "gitRemoteHttp", path: "/usr/bin/git-remote-http", aliases: [] },
  { key: "curl", path: "/usr/bin/curl", aliases: ["/bin/curl"] },
  { key: "tar", path: "/usr/bin/tar", aliases: ["/bin/tar"] },
  { key: "gzip", path: "/usr/bin/gzip", aliases: ["/bin/gzip"] },
  { key: "xz", path: "/usr/bin/xz", aliases: ["/bin/xz"] },
  { key: "zstd", path: "/usr/bin/zstd", aliases: ["/bin/zstd"] },
  { key: "bzip2", path: "/usr/bin/bzip2", aliases: ["/bin/bzip2"] },
] as const;

export type HomebrewBootstrapArtifactKey = (typeof EAGER_PROGRAMS)[number]["key"];

export interface HomebrewBootstrapManifestInput {
  artifacts: Record<HomebrewBootstrapArtifactKey, string>;
  rubyRuntime: string;
  brewArchive: string;
  brewEnvironment: string;
  imageMetadata: string;
  layoutMetadata: string;
}

function assertGuestPath(path: string, label: string): void {
  if (
    !path.startsWith("/") ||
    path.includes("//") ||
    path.split("/").some((segment) => segment === "." || segment === "..") ||
    /[\u0000-\u001f\u007f\s]/.test(path)
  ) {
    throw new Error(`${label} is not a canonical absolute guest path: ${path}`);
  }
}

function assertSourceToken(source: string, label: string): void {
  if (
    source.startsWith("/") ||
    source.includes("\\") ||
    source.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    /[\u0000-\u001f\u007f\s]/.test(source)
  ) {
    throw new Error(`${label} is not a canonical relative manifest source: ${source}`);
  }
}

export function validateHomebrewBootstrapLayout(
  layout: HomebrewBootstrapLayout = HOMEBREW_BOOTSTRAP_LAYOUT,
): void {
  if (layout.schema !== 1) throw new Error(`unsupported bootstrap layout schema: ${layout.schema}`);
  if (layout.guest.uid <= 0 || layout.guest.gid <= 0) {
    throw new Error("the Homebrew guest must be an unprivileged user");
  }
  if (layout.repository.path !== layout.prefix) {
    throw new Error("the Kandelo Homebrew working repository must retain the canonical prefix");
  }
  if (layout.repository.state !== "mutable-working-repository") {
    throw new Error("the stock Homebrew repository must remain an explicit mutable working repository");
  }
  if (
    JSON.stringify(layout.eagerRootfsPackages) !==
    JSON.stringify(HOMEBREW_BOOTSTRAP_EAGER_ROOTFS_PACKAGES)
  ) {
    throw new Error("bootstrap layout does not embed the reviewed rootfs tool closure");
  }
  if (
    JSON.stringify(layout.eagerRootfsOutputs) !==
    JSON.stringify(HOMEBREW_BOOTSTRAP_EAGER_ROOTFS_OUTPUTS)
  ) {
    throw new Error("bootstrap layout does not embed the reviewed rootfs output closure");
  }
  for (const entry of layout.eagerRootfsOutputs) {
    if (!/^[a-z0-9][a-z0-9+._@-]*$/.test(entry.package)) {
      throw new Error(`invalid eager rootfs output package: ${entry.package}`);
    }
    assertGuestPath(entry.path, "eager rootfs output");
  }

  const paths = new Set<string>();
  for (const directory of layout.writableDirectories) {
    assertGuestPath(directory.path, "writable directory");
    if (paths.has(directory.path)) throw new Error(`duplicate bootstrap path: ${directory.path}`);
    paths.add(directory.path);
    if (directory.mode !== "0700" && directory.mode !== "0755") {
      throw new Error(`writable directory has unsafe mode: ${directory.path} ${directory.mode}`);
    }
  }
  if (!paths.has(layout.prefix) || !paths.has(`${layout.prefix}/Cellar`) ||
      !paths.has(`${layout.prefix}/Library/Taps`) ||
      !paths.has(`${layout.prefix}/var/homebrew/locks`)) {
    throw new Error("bootstrap layout omits required stock Homebrew writable state");
  }

  const entrypoints = new Set<string>();
  for (const entrypoint of layout.entrypoints) {
    assertGuestPath(entrypoint.path, "entrypoint");
    if (entrypoints.has(entrypoint.path)) {
      throw new Error(`duplicate Homebrew bootstrap entrypoint: ${entrypoint.path}`);
    }
    entrypoints.add(entrypoint.path);
    if (entrypoint.target) assertGuestPath(entrypoint.target, "entrypoint target");
  }
  for (const name of ["brew", "ruby", "gem", "bundle", "bundler"]) {
    if (!entrypoints.has(`/usr/bin/${name}`)) {
      throw new Error(`bootstrap layout omits /usr/bin/${name}`);
    }
  }

  for (const protectedFile of layout.protectedFiles) {
    assertGuestPath(protectedFile.path, "protected file");
    if (paths.has(protectedFile.path)) throw new Error(`duplicate bootstrap path: ${protectedFile.path}`);
    paths.add(protectedFile.path);
    if (protectedFile.owner !== "root" || protectedFile.mode !== "0444") {
      throw new Error(`protected bootstrap file is guest-writable: ${protectedFile.path}`);
    }
  }
}

export function renderHomebrewBootstrapLayoutJson(): string {
  validateHomebrewBootstrapLayout();
  return `${JSON.stringify(HOMEBREW_BOOTSTRAP_LAYOUT, null, 2)}\n`;
}

export function homebrewBootstrapRootfsEagerArguments(): string[] {
  validateHomebrewBootstrapLayout();
  return [
    ...HOMEBREW_BOOTSTRAP_LAYOUT.eagerRootfsPackages.flatMap((packageName) => [
      "--eager-package",
      packageName,
    ]),
    ...HOMEBREW_BOOTSTRAP_LAYOUT.eagerRootfsOutputs.flatMap((entry) => [
      "--eager-output",
      `${entry.package}:${entry.path}`,
    ]),
  ];
}

export function renderHomebrewBootstrapManifest(input: HomebrewBootstrapManifestInput): string {
  validateHomebrewBootstrapLayout();
  for (const [key, source] of Object.entries(input.artifacts)) {
    assertSourceToken(source, `artifact ${key}`);
  }
  for (const [label, source] of Object.entries({
    rubyRuntime: input.rubyRuntime,
    brewArchive: input.brewArchive,
    brewEnvironment: input.brewEnvironment,
    imageMetadata: input.imageMetadata,
    layoutMetadata: input.layoutMetadata,
  })) {
    assertSourceToken(source, label);
  }

  const lines = [
    "# Generated by scripts/homebrew-bootstrap-layout.ts; do not edit.",
    "",
  ];
  for (const directory of HOMEBREW_BOOTSTRAP_LAYOUT.writableDirectories) {
    lines.push(
      `${directory.path} d ${directory.mode} ${HOMEBREW_BOOTSTRAP_UID} ${HOMEBREW_BOOTSTRAP_GID}`,
    );
  }
  lines.push(
    "",
    "/etc/homebrew d 0755 0 0",
    `/etc/homebrew/brew.env f 0444 0 0 src=${input.brewEnvironment}`,
    "/etc/kandelo d 0755 0 0",
    `/etc/kandelo/homebrew-image.json f 0444 0 0 src=${input.imageMetadata}`,
    `/etc/kandelo/homebrew-bootstrap-layout.json f 0444 0 0 src=${input.layoutMetadata}`,
    "",
  );

  for (const program of EAGER_PROGRAMS) {
    lines.push(`${program.path} f 0755 0 0 src=${input.artifacts[program.key]}`);
    for (const alias of program.aliases) {
      lines.push(`${alias} l 0777 0 0 target=${program.path}`);
    }
  }
  lines.push(
    "/usr/bin/git-remote-https l 0777 0 0 target=/usr/bin/git-remote-http",
    `/usr/bin/brew l 0777 0 0 target=${HOMEBREW_BOOTSTRAP_PREFIX}/bin/brew`,
    "",
    `archive url=${input.brewArchive} base=${HOMEBREW_BOOTSTRAP_PREFIX} ` +
      `fmode=0644 fmode_policy=preserve-executable dmode=0755 ` +
      `uid=${HOMEBREW_BOOTSTRAP_UID} gid=${HOMEBREW_BOOTSTRAP_GID}`,
    `archive url=${input.rubyRuntime} base=/ fmode=0644 ` +
      "fmode_policy=preserve-executable dmode=0755 uid=0 gid=0",
    "",
  );
  return lines.join("\n");
}

function usage(): never {
  process.stderr.write(
    "usage: homebrew-bootstrap-layout.ts --print-rootfs-eager-arguments\n" +
      "   or: homebrew-bootstrap-layout.ts --out <manifest> --layout-out <json> " +
      "--ruby <path> --ruby-runtime <path> --git <path> --git-remote-http <path> " +
      "--curl <path> --tar <path> --gzip <path> --xz <path> --zstd <path> " +
      "--bzip2 <path> --brew-archive <path> --brew-env <path> " +
      "--image-metadata <path>\n",
  );
  process.exit(2);
}

function parseCli(argv: string[]): { out: string; layoutOut: string; input: HomebrewBootstrapManifestInput } {
  const options = new Map<string, string>();
  const allowed = new Set([
    "out", "layout-out", "ruby", "ruby-runtime", "git", "git-remote-http",
    "curl", "tar", "gzip", "xz", "zstd", "bzip2", "brew-archive", "brew-env",
    "image-metadata",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) usage();
    const name = flag.slice(2);
    if (!allowed.has(name) || options.has(name)) usage();
    options.set(name, value);
  }
  const required = (name: string): string => options.get(name) ?? usage();
  const artifacts: Record<HomebrewBootstrapArtifactKey, string> = {
    ruby: required("ruby"),
    git: required("git"),
    gitRemoteHttp: required("git-remote-http"),
    curl: required("curl"),
    tar: required("tar"),
    gzip: required("gzip"),
    xz: required("xz"),
    zstd: required("zstd"),
    bzip2: required("bzip2"),
  };
  const layoutOut = required("layout-out");
  return {
    out: required("out"),
    layoutOut,
    input: {
      artifacts,
      rubyRuntime: required("ruby-runtime"),
      brewArchive: required("brew-archive"),
      brewEnvironment: required("brew-env"),
      imageMetadata: required("image-metadata"),
      layoutMetadata: layoutOut,
    },
  };
}

function runCli(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--print-rootfs-eager-arguments") {
    process.stdout.write(`${homebrewBootstrapRootfsEagerArguments().join("\n")}\n`);
    return;
  }
  const { out, layoutOut, input } = parseCli(argv);
  writeFileSync(layoutOut, renderHomebrewBootstrapLayoutJson());
  writeFileSync(out, renderHomebrewBootstrapManifest(input));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
