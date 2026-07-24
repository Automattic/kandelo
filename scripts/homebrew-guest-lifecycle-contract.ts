import {
  HOMEBREW_BOOTSTRAP_GUEST,
  HOMEBREW_BOOTSTRAP_GUEST_ENV,
} from "./homebrew-bootstrap-guest-contract";
import { HOMEBREW_BOOTSTRAP_PREFIX } from "./homebrew-bootstrap-layout";

export const HOMEBREW_GUEST_LIFECYCLE_MARKER =
  "KANDELO_HOMEBREW_GUEST_LIFECYCLE_OK";

export const HOMEBREW_GUEST_LIFECYCLE_ABI = 42;
export const HOMEBREW_GUEST_LIFECYCLE_HOMEBREW_REVISION =
  "4ead8619231cb15cbe15e8e8188081e347d6f7cd";

export const HOMEBREW_GUEST_LIFECYCLE_CORE = {
  tapName: "kandelo-dev/tap-core",
  repository: "kandelo-dev/homebrew-tap-core",
  revision: "71b3004a43be103b315d8d298a89799c3895e98a",
  supportSha256: "de52716078386e9008f9c78a6035bc557334fc5efd9908445f80a5fb145fe96b",
  kandeloRevision: "d3805721b887a19382ef1c96b576fc27badc0951",
  bzip2: {
    name: "bzip2",
    fullName: "kandelo-dev/tap-core/bzip2",
    version: "1.0.8_2",
    rebuild: 1,
    formulaSha256: "e8a966a759ad88f373fc907a76be8fe44574aa95958d7c861ffec451e509db46",
    sourceFormulaSha256:
      "478a24674a874bfa97b3c116deb37f8d23ac9f629a959e5232abf89ffecef6a3",
    bottleSha256: "a2440f810e52b250951c323b43f6d55b40c3e68b28408929df53bdfe83044c85",
  },
  dash: {
    name: "dash",
    fullName: "kandelo-dev/tap-core/dash",
    version: "0.5.12",
    rebuild: 1,
    formulaSha256: "7d3cbcf4450d12e24d8e1e72d4193cfc39288828cfbbd59012e94eb3ef5cfe90",
    sourceFormulaSha256:
      "2ea8efce384dbc00a95573cf1ac0d78964fe1816182841466694f918345e5db4",
    bottleSha256: "93ae2b1153a5f7073eb7d2ca4a86feca138e6e5130f2a7b5e15d7bb2b35c92b8",
  },
} as const;

export interface HomebrewGuestCanaryIdentity {
  /** Final public tap commit after the ABI-42 bottle sidecars are committed. */
  readonly revision: string;
  /** SHA-256 of Formula/m4.rb at `revision`, including its final bottle block. */
  readonly formulaSha256: string;
  /** SHA-256 of the anonymously readable ABI-42 bottle selected by Homebrew. */
  readonly bottleSha256: string;
  readonly bottleRebuild: number;
}

export const HOMEBREW_GUEST_LIFECYCLE_GUEST = HOMEBREW_BOOTSTRAP_GUEST;
export const HOMEBREW_GUEST_LIFECYCLE_GUEST_ENV = HOMEBREW_BOOTSTRAP_GUEST_ENV;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function validateCanaryIdentity(
  identity: HomebrewGuestCanaryIdentity,
): HomebrewGuestCanaryIdentity {
  if (!SHA1.test(identity.revision)) {
    throw new Error("canary revision must be a full lowercase Git SHA-1");
  }
  if (!SHA256.test(identity.formulaSha256)) {
    throw new Error("canary Formula SHA-256 must be 64 lowercase hexadecimal characters");
  }
  if (!SHA256.test(identity.bottleSha256)) {
    throw new Error("canary bottle SHA-256 must be 64 lowercase hexadecimal characters");
  }
  if (
    !Number.isSafeInteger(identity.bottleRebuild) ||
    identity.bottleRebuild < 0
  ) {
    throw new Error("canary bottle rebuild must be a non-negative safe integer");
  }
  return { ...identity };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const FORMULA_INFO_ASSERTION = [
  "document = JSON.parse(STDIN.read)",
  "formulae = document.fetch(\"formulae\")",
  "abort \"expected one Formula in brew info\" unless formulae.length == 1",
  "formula = formulae.fetch(0)",
  "expected_name, expected_rebuild, expected_sha = ARGV",
  "abort \"Formula full name mismatch\" unless formula.fetch(\"full_name\") == expected_name",
  "stable = formula.dig(\"bottle\", \"stable\")",
  "abort \"Formula has no stable bottle\" unless stable.is_a?(Hash)",
  "abort \"Formula bottle rebuild mismatch\" unless stable.fetch(\"rebuild\") == Integer(expected_rebuild, 10)",
  "tag = stable.fetch(\"files\").fetch(\"wasm32_kandelo\")",
  "abort \"Formula bottle digest mismatch\" unless tag.fetch(\"sha256\") == expected_sha",
].join("\n");

const SIDECAR_ASSERTION = [
  "sidecar = JSON.parse(File.binread(ARGV.fetch(0)))",
  "expected_name = ARGV.fetch(1)",
  "expected_version = ARGV.fetch(2)",
  "expected_rebuild = Integer(ARGV.fetch(3), 10)",
  "expected_sha = ARGV.fetch(4)",
  "expected_source_sha = ARGV.fetch(5)",
  "expected_kandelo_revision = ARGV.fetch(6)",
  "expected_repository = ARGV.fetch(7)",
  "expected_dependencies = ARGV.fetch(8).split(\",\").reject(&:empty?).sort",
  "short_name = expected_name.split(\"/\").last",
  "abort \"sidecar schema mismatch\" unless sidecar.fetch(\"schema\") == 1",
  "abort \"sidecar full name mismatch\" unless sidecar.fetch(\"full_name\") == expected_name",
  "abort \"sidecar package name mismatch\" unless sidecar.fetch(\"name\") == short_name",
  "abort \"sidecar Formula path mismatch\" unless sidecar.fetch(\"formula_path\") == \"Formula/#{short_name}.rb\"",
  "abort \"sidecar version mismatch\" unless sidecar.fetch(\"version\") == expected_version",
  "abort \"sidecar rebuild mismatch\" unless sidecar.fetch(\"bottle_rebuild\") == expected_rebuild",
  `abort "sidecar ABI mismatch" unless sidecar.fetch("kandelo_abi") == ${HOMEBREW_GUEST_LIFECYCLE_ABI}`,
  "dependencies = sidecar.fetch(\"dependencies\").map { |dependency| dependency.fetch(\"full_name\") }.sort",
  "abort \"sidecar dependency closure mismatch\" unless dependencies == expected_dependencies",
  "matches = sidecar.fetch(\"bottles\").select { |bottle| bottle[\"arch\"] == \"wasm32\" && bottle[\"bottle_tag\"] == \"wasm32_kandelo\" }",
  "abort \"sidecar must name exactly one wasm32_kandelo bottle\" unless matches.length == 1",
  "bottle = matches.fetch(0)",
  `abort "bottle ABI mismatch" unless bottle.fetch("kandelo_abi") == ${HOMEBREW_GUEST_LIFECYCLE_ABI}`,
  "abort \"bottle status mismatch\" unless bottle.fetch(\"status\") == \"success\"",
  "abort \"bottle digest mismatch\" unless bottle.fetch(\"sha256\") == expected_sha",
  "abort \"bottle cache digest mismatch\" unless bottle.fetch(\"cache_key_sha\") == expected_sha",
  `abort "bottle prefix mismatch" unless bottle.fetch("prefix") == ${JSON.stringify(HOMEBREW_BOOTSTRAP_PREFIX)}`,
  `abort "bottle Cellar mismatch" unless bottle.fetch("cellar") == ${JSON.stringify(`${HOMEBREW_BOOTSTRAP_PREFIX}/Cellar`)}`,
  "expected_url = \"https://ghcr.io/v2/#{expected_repository}/#{short_name}/blobs/sha256:#{expected_sha}\"",
  "abort \"bottle public URL mismatch\" unless bottle.fetch(\"url\") == expected_url",
  "source_sha = bottle.dig(\"built_from\", \"formula_sha256\")",
  "abort \"source Formula digest is malformed\" unless source_sha&.match?(/\\A[0-9a-f]{64}\\z/)",
  "unless expected_source_sha == \"-\"",
  "  abort \"source Formula digest mismatch\" unless source_sha == expected_source_sha",
  "end",
  "kandelo_revision = bottle.dig(\"built_from\", \"kandelo_commit\")",
  "abort \"Kandelo source revision is malformed\" unless kandelo_revision&.match?(/\\A[0-9a-f]{40}\\z/)",
  "unless expected_kandelo_revision == \"-\"",
  "  abort \"Kandelo source revision mismatch\" unless kandelo_revision == expected_kandelo_revision",
  "end",
].join("\n");

const RECEIPT_ASSERTION = [
  "receipt = JSON.parse(File.binread(ARGV.fetch(0)))",
  "expected_tap = ARGV.fetch(1)",
  "expected_on_request = ARGV.fetch(2) == \"true\"",
  "expected_dependencies = ARGV.fetch(3).split(\",\").reject(&:empty?).sort",
  "abort \"receipt was not built as a bottle\" unless receipt.fetch(\"built_as_bottle\") == true",
  "abort \"receipt does not prove a bottle pour\" unless receipt.fetch(\"poured_from_bottle\") == true",
  "abort \"receipt request status mismatch\" unless receipt.fetch(\"installed_on_request\") == expected_on_request",
  "abort \"receipt source tap mismatch\" unless receipt.dig(\"source\", \"tap\") == expected_tap",
  "dependencies = receipt.fetch(\"runtime_dependencies\").map { |dependency| dependency.fetch(\"full_name\") }.sort",
  "abort \"receipt dependency closure mismatch\" unless dependencies == expected_dependencies",
].join("\n");

const TEXT_ASSERTION = [
  "expected = ARGV.fetch(0)",
  "actual = STDIN.read",
  "abort \"command output mismatch: expected #{expected.inspect}, got #{actual.inspect}\" unless actual == expected",
].join("\n");

/**
 * Exercise stock Homebrew's first- and third-party lifecycle through public
 * Git and GitHub Container Registry endpoints.
 *
 * WHY: the canary identity is an input instead of a source tree that this test
 * edits. Mutating a tap before installation would prove a private test fork,
 * not the exact third-party publication that users can tap anonymously.
 */
export function createHomebrewGuestLifecycleScript(
  canaryInput: HomebrewGuestCanaryIdentity,
): string {
  const canary = validateCanaryIdentity(canaryInput);
  const core = HOMEBREW_GUEST_LIFECYCLE_CORE;
  const prefix = HOMEBREW_BOOTSTRAP_PREFIX;
  const corePath = `${prefix}/Library/Taps/kandelo-dev/homebrew-tap-core`;
  const canaryPath =
    `${prefix}/Library/Taps/brandonpayton/homebrew-kandelo-canary`;
  const supportPath = "Kandelo/formula_support/kandelo_formula_support.rb";
  const bzip2Prefix = `${prefix}/Cellar/${core.bzip2.name}/${core.bzip2.version}`;
  const dashPrefix = `${prefix}/Cellar/${core.dash.name}/${core.dash.version}`;
  const m4Prefix = `${prefix}/Cellar/m4/1.4.21`;
  const m4Input = [
    "define(`VALUE', `42')dnl",
    "Kandelo:VALUE",
    "esyscmd(`printf child-process')dnl",
    "ifelse(sysval, `0', `:child-ok', `:child-failed')",
    "",
  ].join("\n");
  const m4Output = "Kandelo:42\nchild-process:child-ok\n";

  return [
    "set -euo pipefail",
    "fail() { printf 'homebrew-guest-lifecycle: %s\\n' \"$*\" >&2; exit 1; }",
    "expect_equal() { [ \"$1\" = \"$2\" ] || fail \"$3: expected '$2', got '$1'\"; }",
    "sha256_file() { /usr/bin/ruby -rdigest -e 'puts Digest::SHA256.file(ARGV.fetch(0)).hexdigest' \"$1\"; }",
    "assert_clean_tap() {",
    "  tap_path=\"$1\"",
    "  expected_revision=\"$2\"",
    "  expect_equal \"$(/usr/bin/git -C \"$tap_path\" rev-parse HEAD)\" \"$expected_revision\" 'tap revision'",
    "  [ -z \"$(/usr/bin/git -C \"$tap_path\" status --porcelain=v1 --untracked-files=all)\" ] ||",
    "    fail \"tap checkout was mutated: $tap_path\"",
    "}",
    "assert_formula_info() {",
    `  /usr/bin/brew info --json=v2 "$1" | /usr/bin/ruby -rjson -e ${shellQuote(FORMULA_INFO_ASSERTION)} "$1" "$2" "$3"`,
    "}",
    "assert_sidecar() {",
    `  /usr/bin/ruby -rjson -e ${shellQuote(SIDECAR_ASSERTION)} "$@"`,
    "}",
    "assert_receipt() {",
    `  /usr/bin/ruby -rjson -e ${shellQuote(RECEIPT_ASSERTION)} "$@"`,
    "}",
    "assert_cached_bottle() {",
    "  cache_path=\"$(/usr/bin/brew --cache --bottle-tag=wasm32_kandelo \"$1\")\"",
    "  [ -f \"$cache_path\" ] || fail \"Homebrew bottle cache entry is missing: $cache_path\"",
    "  expect_equal \"$(sha256_file \"$cache_path\")\" \"$2\" 'cached bottle digest'",
    "}",
    "",
    "# WHY: no credential may make a private or unpublished package look public.",
    "unset GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN",
    "unset HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN",
    "export GIT_TERMINAL_PROMPT=0",
    "export HOMEBREW_NO_ANALYTICS=1",
    "export HOMEBREW_NO_AUTO_UPDATE=1",
    "export HOMEBREW_NO_ENV_HINTS=1",
    "export HOMEBREW_NO_INSTALL_FROM_API=1",
    "",
    "/usr/bin/ruby -rjson -e '",
    "  metadata = JSON.parse(File.binread(\"/etc/kandelo/homebrew-image.json\"))",
    `  abort "bootstrap ABI mismatch" unless metadata.fetch("kandelo_abi") == ${HOMEBREW_GUEST_LIFECYCLE_ABI}`,
    `  abort "bootstrap Homebrew revision mismatch" unless metadata.fetch("homebrew_revision") == ${JSON.stringify(HOMEBREW_GUEST_LIFECYCLE_HOMEBREW_REVISION)}`,
    "'",
    `[ ! -e ${shellQuote(`${prefix}/Library/Taps/homebrew/homebrew-core`)} ] || fail 'homebrew/core was installed unexpectedly'`,
    "",
    `/usr/bin/brew tap ${shellQuote(core.tapName)}`,
    `core_tap="$(/usr/bin/brew --repository ${shellQuote(core.tapName)})"`,
    `expect_equal "$core_tap" ${shellQuote(corePath)} 'first-party tap path'`,
    "# WHY: a tap's default branch can advance between hosts; detach the",
    "# finalized publication and reject any install-time source mutation.",
    `/usr/bin/git -C "$core_tap" fetch --no-tags --depth=1 origin ${shellQuote(core.revision)}`,
    "/usr/bin/git -C \"$core_tap\" checkout --quiet --detach FETCH_HEAD",
    `expect_equal "$(sha256_file "$core_tap/${supportPath}")" ${shellQuote(core.supportSha256)} 'first-party support digest'`,
    `expect_equal "$(sha256_file "$core_tap/Formula/${core.bzip2.name}.rb")" ${shellQuote(core.bzip2.formulaSha256)} 'Bzip2 Formula digest'`,
    `expect_equal "$(sha256_file "$core_tap/Formula/${core.dash.name}.rb")" ${shellQuote(core.dash.formulaSha256)} 'Dash Formula digest'`,
    `assert_formula_info ${shellQuote(core.bzip2.fullName)} ${core.bzip2.rebuild} ${shellQuote(core.bzip2.bottleSha256)}`,
    `assert_formula_info ${shellQuote(core.dash.fullName)} ${core.dash.rebuild} ${shellQuote(core.dash.bottleSha256)}`,
    `assert_sidecar "$core_tap/Kandelo/formula/${core.bzip2.name}.json" ${shellQuote(core.bzip2.fullName)} ${shellQuote(core.bzip2.version)} ${core.bzip2.rebuild} ${shellQuote(core.bzip2.bottleSha256)} ${shellQuote(core.bzip2.sourceFormulaSha256)} ${shellQuote(core.kandeloRevision)} ${shellQuote(core.repository)} ''`,
    `assert_sidecar "$core_tap/Kandelo/formula/${core.dash.name}.json" ${shellQuote(core.dash.fullName)} ${shellQuote(core.dash.version)} ${core.dash.rebuild} ${shellQuote(core.dash.bottleSha256)} ${shellQuote(core.dash.sourceFormulaSha256)} ${shellQuote(core.kandeloRevision)} ${shellQuote(core.repository)} ''`,
    `assert_clean_tap "$core_tap" ${shellQuote(core.revision)}`,
    "",
    `/usr/bin/brew install --no-ask --force-bottle ${shellQuote(core.bzip2.fullName)}`,
    `assert_cached_bottle ${shellQuote(core.bzip2.fullName)} ${shellQuote(core.bzip2.bottleSha256)}`,
    `assert_receipt ${shellQuote(`${bzip2Prefix}/INSTALL_RECEIPT.json`)} ${shellQuote(core.tapName)} true ''`,
    `[ -x ${shellQuote(`${bzip2Prefix}/bin/bzip2`)} ] || fail 'Bzip2 executable is missing from its exact keg'`,
    `bzip2_output="$(printf '%s' 'Kandelo Bzip2 bottle round trip' | ${shellQuote(`${bzip2Prefix}/bin/bzip2`)} -c | ${shellQuote(`${bzip2Prefix}/bin/bzip2`)} -dc)"`,
    "expect_equal \"$bzip2_output\" 'Kandelo Bzip2 bottle round trip' 'Bzip2 round trip'",
    "",
    `/usr/bin/brew tap ${shellQuote("brandonpayton/kandelo-canary")}`,
    `canary_tap="$(/usr/bin/brew --repository ${shellQuote("brandonpayton/kandelo-canary")})"`,
    `expect_equal "$canary_tap" ${shellQuote(canaryPath)} 'third-party tap path'`,
    "# WHY: test the immutable public canary publication, not a moving branch",
    "# or a locally rewritten Formula that third-party users cannot consume.",
    `/usr/bin/git -C "$canary_tap" fetch --no-tags --depth=1 origin ${shellQuote(canary.revision)}`,
    "/usr/bin/git -C \"$canary_tap\" checkout --quiet --detach FETCH_HEAD",
    `expect_equal "$(sha256_file "$canary_tap/${supportPath}")" ${shellQuote(core.supportSha256)} 'third-party support digest'`,
    `expect_equal "$(sha256_file "$canary_tap/Formula/m4.rb")" ${shellQuote(canary.formulaSha256)} 'M4 Formula digest'`,
    `assert_formula_info ${shellQuote("brandonpayton/kandelo-canary/m4")} ${canary.bottleRebuild} ${shellQuote(canary.bottleSha256)}`,
    `assert_sidecar "$canary_tap/Kandelo/formula/m4.json" ${shellQuote("brandonpayton/kandelo-canary/m4")} '1.4.21' ${canary.bottleRebuild} ${shellQuote(canary.bottleSha256)} - - ${shellQuote("brandonpayton/homebrew-kandelo-canary")} ${shellQuote(core.dash.fullName)}`,
    `assert_clean_tap "$canary_tap" ${shellQuote(canary.revision)}`,
    "",
    `/usr/bin/brew install --no-ask --force-bottle ${shellQuote("brandonpayton/kandelo-canary/m4")}`,
    `assert_cached_bottle ${shellQuote("brandonpayton/kandelo-canary/m4")} ${shellQuote(canary.bottleSha256)}`,
    `assert_cached_bottle ${shellQuote(core.dash.fullName)} ${shellQuote(core.dash.bottleSha256)}`,
    `assert_receipt ${shellQuote(`${m4Prefix}/INSTALL_RECEIPT.json`)} ${shellQuote("brandonpayton/kandelo-canary")} true ${shellQuote(core.dash.fullName)}`,
    `assert_receipt ${shellQuote(`${dashPrefix}/INSTALL_RECEIPT.json`)} ${shellQuote(core.tapName)} false ''`,
    `[ -x ${shellQuote(`${dashPrefix}/bin/dash`)} ] || fail 'Dash executable is missing from its exact keg'`,
    `[ -x ${shellQuote(`${m4Prefix}/bin/m4`)} ] || fail 'M4 executable is missing from its exact keg'`,
    `expect_equal "$(${shellQuote(`${dashPrefix}/bin/dash`)} -c 'printf KANDELO_DASH_BOTTLE_OK')" 'KANDELO_DASH_BOTTLE_OK' 'Dash execution'`,
    `m4_version="$(${shellQuote(`${m4Prefix}/bin/m4`)} --version | /usr/bin/sed -n '1p')"`,
    "case \"$m4_version\" in *'GNU M4) 1.4.21') ;; *) fail \"unexpected M4 version: $m4_version\" ;; esac",
    `printf '%s' ${shellQuote(m4Input)} | ${shellQuote(`${m4Prefix}/bin/m4`)} | /usr/bin/ruby -e ${shellQuote(TEXT_ASSERTION)} ${shellQuote(m4Output)}`,
    "",
    `assert_clean_tap "$core_tap" ${shellQuote(core.revision)}`,
    `assert_clean_tap "$canary_tap" ${shellQuote(canary.revision)}`,
    `[ ! -e ${shellQuote(`${prefix}/Library/Taps/homebrew/homebrew-core`)} ] || fail 'homebrew/core was installed unexpectedly'`,
    `if /usr/bin/brew tap | /usr/bin/grep -qx 'homebrew/core'; then fail 'homebrew/core appears in brew tap'; fi`,
    `printf '%s\\n' ${shellQuote(HOMEBREW_GUEST_LIFECYCLE_MARKER)}`,
  ].join("\n");
}
