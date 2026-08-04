import {
  extractZipEntryBounded,
  parseZipCentralDirectory,
} from "./vfs/zip";

export const HOMEBREW_PORTABLE_RUBY_VERSION_MEMBER =
  "Library/Homebrew/vendor/portable-ruby-version";
export const HOMEBREW_PORTABLE_RUBY_RELATIVE_PREFIX =
  "Library/Homebrew/vendor/portable-ruby";
export const HOMEBREW_PORTABLE_RUBY_OUTPUT =
  "homebrew-portable-ruby.zip";
export const HOMEBREW_PORTABLE_RUBY_TREE_ID =
  "homebrew-bootstrap/portable-ruby";

const MAX_PORTABLE_RUBY_VERSION_BYTES = 64;
const PORTABLE_RUBY_VERSION_RE = /^\d+\.\d+\.\d+(?:_\d+)?$/;

/** Read the portable-Ruby version selected by Homebrew's exact source tree. */
export function readHomebrewPortableRubyVersion(
  sourceArchiveBytes: Uint8Array,
): string {
  const matches = parseZipCentralDirectory(sourceArchiveBytes).filter(
    (entry) => entry.fileName === HOMEBREW_PORTABLE_RUBY_VERSION_MEMBER,
  );
  if (
    matches.length !== 1 ||
    matches[0]!.isDirectory ||
    matches[0]!.isSymlink ||
    matches[0]!.uncompressedSize > MAX_PORTABLE_RUBY_VERSION_BYTES
  ) {
    throw new Error(
      "Homebrew bootstrap source has no unique portable Ruby version file",
    );
  }
  const bytes = extractZipEntryBounded(
    sourceArchiveBytes,
    matches[0]!,
    matches[0]!.uncompressedSize,
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Homebrew portable Ruby version is not UTF-8", {
      cause: error,
    });
  }
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
    throw new Error("Homebrew portable Ruby version is not one line");
  }
  const version = text.slice(0, -1);
  if (!PORTABLE_RUBY_VERSION_RE.test(version)) {
    throw new Error("Homebrew portable Ruby version is invalid");
  }
  return version;
}

export function homebrewPortableRubyMountPrefix(sourcePrefix: string): string {
  return appendGuestPath(
    sourcePrefix,
    HOMEBREW_PORTABLE_RUBY_RELATIVE_PREFIX,
  );
}

export function homebrewPortableRubyExecutable(
  sourcePrefix: string,
  version: string,
): string {
  return appendGuestPath(
    homebrewPortableRubyMountPrefix(sourcePrefix),
    `${version}/bin/ruby`,
  );
}

function appendGuestPath(prefix: string, relative: string): string {
  return prefix === "/" ? `/${relative}` : `${prefix}/${relative}`;
}
