import { describe, expect, it } from "vitest";
import { SHELL_LAZY_BINARY_SPECS } from "../../images/vfs/lib/init/shell-binaries";

describe("shell binary mappings", () => {
  it("maps unzip aliases and the distinct funzip executable", () => {
    const unzip = SHELL_LAZY_BINARY_SPECS.find((spec) => spec.id === "unzip");
    const funzip = SHELL_LAZY_BINARY_SPECS.find((spec) => spec.id === "funzip");

    expect(unzip).toEqual({
      id: "unzip",
      resolverPath: "programs/unzip/unzip.wasm",
      vfsPath: "/usr/bin/unzip",
      symlinks: ["/bin/unzip", "/usr/bin/zipinfo", "/bin/zipinfo"],
    });
    expect(funzip).toEqual({
      id: "funzip",
      resolverPath: "programs/unzip/funzip.wasm",
      vfsPath: "/usr/bin/funzip",
      symlinks: ["/bin/funzip"],
    });
  });
});
