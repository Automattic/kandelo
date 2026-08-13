import type { PresetSession } from "./kernel-host/preset-session";

export const C_DEVELOPMENT_SESSION: PresetSession = {
  cwd: "/home/user/c",
  env: {
    CC: "cc",
    CXX: "c++",
    MAKEFLAGS: "-j1",
    PWD: "/home/user/c",
  },
  workspaceFiles: [{
    path: "/home/user/c/hello.c",
    contents: [
      "#include <stdio.h>",
      "",
      "int main(void) {",
      "  puts(\"Hello from Kandelo C!\");",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    mode: 0o644,
  }],
  packagePrefetch: {
    id: "c-development-toolchain",
    label: "C/C++ toolchain",
    roots: ["kandelo-dev/tap-core/kandelo-sdk"],
  },
};
