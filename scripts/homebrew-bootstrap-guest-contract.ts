import {
  HOMEBREW_BOOTSTRAP_GID,
  HOMEBREW_BOOTSTRAP_HOME,
  HOMEBREW_BOOTSTRAP_LAYOUT,
  HOMEBREW_BOOTSTRAP_PREFIX,
  HOMEBREW_BOOTSTRAP_UID,
} from "./homebrew-bootstrap-layout";

export const HOMEBREW_BOOTSTRAP_CONTRACT_MARKER =
  "KANDELO_HOMEBREW_BOOTSTRAP_CONTRACT_OK";

export const HOMEBREW_BOOTSTRAP_GUEST_ENV = [
  `PATH=${HOMEBREW_BOOTSTRAP_PREFIX}/bin:/usr/bin:/bin`,
  `HOME=${HOMEBREW_BOOTSTRAP_HOME}`,
  "USER=linuxbrew",
  "LOGNAME=linuxbrew",
  "SHELL=/bin/bash",
  "TERM=dumb",
  `HOMEBREW_CACHE=${HOMEBREW_BOOTSTRAP_HOME}/.cache/Homebrew`,
  `HOMEBREW_USER_CONFIG_HOME=${HOMEBREW_BOOTSTRAP_HOME}/.config/homebrew`,
  "HOMEBREW_TEMP=/tmp",
] as const;

export const HOMEBREW_BOOTSTRAP_GUEST = {
  uid: HOMEBREW_BOOTSTRAP_UID,
  gid: HOMEBREW_BOOTSTRAP_GID,
  cwd: HOMEBREW_BOOTSTRAP_HOME,
} as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Exercise the guest-facing bootstrap contract through ordinary POSIX paths.
 * The script deliberately invokes the Ruby scripts themselves, rather than
 * passing them to Ruby, so a missing executable bit or broken shebang fails.
 */
export function createHomebrewBootstrapGuestContractScript(): string {
  const entrypoints = HOMEBREW_BOOTSTRAP_LAYOUT.entrypoints.map(({ path }) => path);
  const writableDirectories = HOMEBREW_BOOTSTRAP_LAYOUT.writableDirectories.map(
    ({ path }) => path,
  );
  const protectedFiles = HOMEBREW_BOOTSTRAP_LAYOUT.protectedFiles.map(({ path }) => path);
  const writeProbeRoots = [
    HOMEBREW_BOOTSTRAP_PREFIX,
    `${HOMEBREW_BOOTSTRAP_PREFIX}/Cellar`,
    `${HOMEBREW_BOOTSTRAP_PREFIX}/Library/Taps`,
    `${HOMEBREW_BOOTSTRAP_PREFIX}/var/homebrew/locks`,
    `${HOMEBREW_BOOTSTRAP_HOME}/.cache/Homebrew`,
    `${HOMEBREW_BOOTSTRAP_HOME}/.config/homebrew`,
  ];

  return [
    "set -euo pipefail",
    "fail() { printf 'homebrew-bootstrap-contract: %s\\n' \"$*\" >&2; exit 1; }",
    "expect_equal() { [ \"$1\" = \"$2\" ] || fail \"$3: expected '$2', got '$1'\"; }",
    `for path in ${entrypoints.map(shellQuote).join(" ")}; do`,
    "  [ -x \"$path\" ] || fail \"entrypoint is missing or not executable: $path\"",
    "done",
    "[ -L /usr/bin/brew ] || fail '/usr/bin/brew is not a symlink'",
    `expect_equal \"$(/usr/bin/brew --prefix)\" ${shellQuote(HOMEBREW_BOOTSTRAP_PREFIX)} 'brew --prefix'`,
    `expect_equal \"$(/usr/bin/brew --repository)\" ${shellQuote(HOMEBREW_BOOTSTRAP_PREFIX)} 'brew --repository'`,
    `expect_equal \"$(/usr/bin/brew --cellar)\" ${shellQuote(`${HOMEBREW_BOOTSTRAP_PREFIX}/Cellar`)} 'brew --cellar'`,
    `expect_equal \"$(/usr/bin/brew --cache)\" ${shellQuote(`${HOMEBREW_BOOTSTRAP_HOME}/.cache/Homebrew`)} 'brew --cache'`,
    "brew_version=\"$(/usr/bin/brew --version)\"",
    "case \"$brew_version\" in 'Homebrew '*) ;; *) fail \"unexpected brew version: $brew_version\" ;; esac",
    "ruby_version=\"$(/usr/bin/ruby --version)\"",
    "case \"$ruby_version\" in 'ruby '*) ;; *) fail \"unexpected Ruby version: $ruby_version\" ;; esac",
    "gem_version=\"$(/usr/bin/gem --version)\"",
    "case \"$gem_version\" in [0-9]*) ;; *) fail \"unexpected RubyGems version: $gem_version\" ;; esac",
    "bundle_version=\"$(/usr/bin/bundle --version)\"",
    "case \"$bundle_version\" in [0-9]*) ;; *) fail \"unexpected Bundler version: $bundle_version\" ;; esac",
    "bundler_version=\"$(/usr/bin/bundler --version)\"",
    "expect_equal \"$bundler_version\" \"$bundle_version\" 'bundle and bundler versions'",
    `for path in ${writableDirectories.map(shellQuote).join(" ")}; do`,
    "  [ -d \"$path\" ] || fail \"writable directory is missing: $path\"",
    "  [ -w \"$path\" ] || fail \"directory is not writable by the Homebrew guest: $path\"",
    "done",
    `for path in ${protectedFiles.map(shellQuote).join(" ")}; do`,
    "  [ -r \"$path\" ] || fail \"protected file is not readable: $path\"",
    "  [ ! -w \"$path\" ] || fail \"protected file is writable by the Homebrew guest: $path\"",
    "  if (: >\"$path\") 2>/dev/null; then fail \"protected file accepted a write: $path\"; fi",
    "done",
    `for root in ${writeProbeRoots.map(shellQuote).join(" ")}; do`,
    "  probe=\"$root/.kandelo-bootstrap-contract-$$\"",
    "  : >\"$probe\" || fail \"cannot create state below $root\"",
    "  /usr/bin/rm -f \"$probe\" || fail \"cannot remove state below $root\"",
    "  [ ! -e \"$probe\" ] || fail \"state probe remains below $root\"",
    "done",
    "/usr/bin/ruby -rjson -rdigest -e '",
    "  metadata_path = \"/etc/kandelo/homebrew-image.json\"",
    "  layout_path = \"/etc/kandelo/homebrew-bootstrap-layout.json\"",
    "  metadata = JSON.parse(File.binread(metadata_path))",
    "  layout_bytes = File.binread(layout_path)",
    "  layout = JSON.parse(layout_bytes)",
    "  abort \"layout digest mismatch\" unless metadata.dig(\"guest_layout\", \"sha256\") == Digest::SHA256.hexdigest(layout_bytes)",
    "  abort \"repository state mismatch\" unless layout.dig(\"repository\", \"state\") == \"mutable-working-repository\"",
    "  abort \"provenance path mismatch\" unless layout.dig(\"repository\", \"initialSourceProvenance\") == metadata_path",
    "  abort \"source archive digest missing\" unless metadata.fetch(\"homebrew_archive_sha256\").match?(/\\A[0-9a-f]{64}\\z/)",
    "'",
    `printf '%s\\n' ${shellQuote(HOMEBREW_BOOTSTRAP_CONTRACT_MARKER)}`,
  ].join("\n");
}
