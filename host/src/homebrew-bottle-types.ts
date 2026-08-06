import { assertHomebrewCanonicalText } from "./homebrew-lazy-layer-descriptor";

export type HomebrewBottleArch = "wasm32" | "wasm64";

export interface HomebrewLinkEntry {
  type: "symlink" | "directory" | "file";
  source: string;
  target: string;
  mode?: string;
}

/**
 * Accept one portable POSIX path relative to its caller-defined root.
 *
 * Homebrew bottles legitimately contain punctuation, dotfiles, and names such
 * as `[` or `_foo`; path safety is about component structure, controls, and
 * Unicode scalar validity rather than an application-specific filename regex.
 */
export function assertHomebrewSafeRelativePath(value: string): void {
  assertHomebrewCanonicalText(value);
  if (value.length === 0 || value.startsWith("/")) {
    throw new Error("path must be a nonempty relative POSIX path");
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) {
      throw new Error("path must not contain ASCII control characters");
    }
  }
  for (const component of value.split("/")) {
    if (component.length === 0 || component === "." || component === "..") {
      throw new Error("path has an unsafe relative component");
    }
  }
}
