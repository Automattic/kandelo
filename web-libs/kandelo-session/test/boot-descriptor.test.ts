import { describe, expect, it } from "vitest";
import {
  BootDescriptorError,
  HARD_CAPS,
  validateBootDescriptor,
} from "../src/boot-descriptor";
import type { BootDescriptor } from "../src/kernel-host";

const DESCRIPTOR_URL =
  "https://github.com/Example/homebrew-tools/releases/download/" +
  `homebrew-vfs-sha256-${"a".repeat(64)}/kandelo-homebrew-vfs.json`;

function descriptor(): BootDescriptor {
  return {
    version: 1,
    id: "homebrew-shell",
    title: "Homebrew shell",
    base: "kandelo:shell@abi18",
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: 2048,
      features: ["shared-array-buffer", "pty"],
      time: "real",
    },
    packages: [],
    mounts: [{
      path: "/",
      source: "image",
      resolver: {
        kind: "homebrew-vfs-release",
        descriptorUrl: DESCRIPTOR_URL,
        requireDefaultShell: true,
      },
      readonly: false,
    }],
    boot: {
      argv: ["dash", "-l", "-i"],
      cwd: "/home/user",
      env: { HOME: "/home/user" },
    },
  };
}

describe("Homebrew VFS boot-descriptor mount resolver", () => {
  it("accepts an unresolved HTTPS descriptor and its exact resolved image", () => {
    const unresolved = descriptor();
    expect(() => validateBootDescriptor(unresolved)).not.toThrow();

    const resolved = descriptor();
    resolved.mounts[0] = {
      ...resolved.mounts[0],
      ref: DESCRIPTOR_URL.replace(
        "kandelo-homebrew-vfs.json",
        "kandelo-homebrew.vfs.zst",
      ),
      integrity: {
        algorithm: "sha256",
        digest: "a".repeat(64),
        bytes: 4096,
      },
    };
    expect(() => validateBootDescriptor(resolved)).not.toThrow();
  });

  it("rejects mutable transport shapes and optional legacy-shell fallback", () => {
    const http = descriptor();
    http.mounts[0].resolver!.descriptorUrl = DESCRIPTOR_URL.replace("https:", "http:");
    expect(() => validateBootDescriptor(http)).toThrowError(BootDescriptorError);

    const optionalShell = descriptor() as unknown as Record<string, any>;
    delete optionalShell.mounts[0].resolver.requireDefaultShell;
    expect(() => validateBootDescriptor(optionalShell)).toThrow("requireDefaultShell=true");
  });

  it("rejects remote image integrity that is malformed or over the consumer cap", () => {
    const malformed = descriptor();
    malformed.mounts[0] = {
      ...malformed.mounts[0],
      ref: "https://github.com/Example/homebrew-tools/image.vfs.zst",
      integrity: {
        algorithm: "sha256",
        digest: "A".repeat(64),
        bytes: 10,
      },
    };
    expect(() => validateBootDescriptor(malformed)).toThrow("lowercase digest");

    const oversized = descriptor();
    oversized.mounts[0] = {
      ...oversized.mounts[0],
      ref: "https://github.com/Example/homebrew-tools/image.vfs.zst",
      integrity: {
        algorithm: "sha256",
        digest: "a".repeat(64),
        bytes: HARD_CAPS.maxRemoteImageBytes + 1,
      },
    };
    expect(() => validateBootDescriptor(oversized)).toThrow("mount.integrity");
  });
});
