import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sdkRoot = fileURLToPath(new URL("..", import.meta.url));
const wrapper = (name: string) => readFileSync(
  resolve(sdkRoot, "kandelo/bin", name),
  "utf8",
);

describe("Kandelo in-guest wrappers", () => {
  it("uses stable Formula-owned compiler, SDK, and libc++ roots", () => {
    const cc = wrapper("wasm32posix-cc");
    expect(cc).toContain("/opt/kandelo/homebrew/opt/clang/libexec/llvm");
    expect(cc).toContain("/opt/kandelo/homebrew/opt/kandelo-sdk/libexec/wasm32posix");
    expect(cc).toContain("/opt/kandelo/homebrew/opt/libcxx");
    expect(cc).toContain("-nostdinc++");
    expect(cc).toContain("include/c++/v1");
    expect(cc).toContain("lib/libc++.a");
    expect(cc).toContain("lib/libc++abi.a");
  });

  it("contains no workstation path or browser transport", () => {
    const text = [
      "wasm32posix-cc", "wasm32posix-c++", "wasm32posix-ar",
      "wasm32posix-ranlib", "wasm32posix-nm", "wasm32posix-strip",
      "wasm32posix-configure", "wasm32posix-pkg-config",
    ].map(wrapper).join("\n");
    expect(text).not.toMatch(/\/Users\/|\/nix\/store\/|https?:\/\//u);
  });

  it("vendors the exact pinned musl notice into the source archive", () => {
    expect(readFileSync(
      resolve(sdkRoot, "kandelo/notices/MUSL-COPYRIGHT"),
      "utf8",
    )).toBe(readFileSync(resolve(sdkRoot, "../libc/musl/COPYRIGHT"), "utf8"));
  });
});
