import { ABI_VERSION } from "../../../../../host/src/generated/abi";
import type { BootDescriptor } from "../../../../../web-libs/kandelo-session/src/kernel-host";

/**
 * The descriptor of a computer `delo run` creates from a draft. Its root
 * mount is `opfs`: the app provisions the filesystem from the image Delo
 * stored in the computer's own directory, not from a URL. What the machine
 * runs comes from that image, so `boot` is only the shape the validator
 * requires; the app replaces it with what the image declares.
 */
export function deloComputerDescriptor(name: string): BootDescriptor {
  return {
    version: 1,
    id: "delo",
    title: name,
    base: `kandelo:shell@abi${ABI_VERSION}`,
    runtime: { arch: "wasm32", kernel: "kernel@local", memoryPages: 2048, features: ["shared-array-buffer", "pty"], time: "real" },
    packages: [],
    mounts: [
      { path: "/", source: "opfs", readonly: false },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: { argv: ["sh"], cwd: "/", env: {} },
  };
}
