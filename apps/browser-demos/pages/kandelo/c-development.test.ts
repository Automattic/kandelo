import { describe, expect, test, vi } from "vitest";

import { ABI_VERSION } from "../../../../host/src/generated/abi";
import type {
  BootDescriptor,
  GalleryItem,
  HomebrewPackagePrefetchResult,
  MachineStatus,
} from "../../../../web-libs/kandelo-session/src/kernel-host";
import { C_DEVELOPMENT_SESSION } from "./c-development";
import { descriptorFromGalleryItem } from "./gallery-descriptor";
import { candidateEvidenceLiveDemoId } from "./kernel-host/candidate-evidence-vfs";
import {
  applyPresetSessionBoot,
  preparePresetWorkspace,
  startPresetPackagePrefetch,
  type PresetSession,
  type PresetSessionHost,
  type PresetSessionIdentity,
  type PresetSessionKernel,
} from "./kernel-host/preset-session";
import { PRESET_LIBRARY } from "./presets";
import { cDevelopmentGuide } from "../../../../web-libs/kandelo-session/src/demo-guides";

const BASE_DESCRIPTOR: BootDescriptor = {
  version: 1,
  id: "shell",
  title: "Bare shell",
  base: "kandelo:shell@abi" + ABI_VERSION,
  runtime: {
    arch: "wasm32",
    kernel: "kernel@local",
    memoryPages: 2048,
    features: ["shared-array-buffer", "pty"],
    time: "real",
  },
  packages: ["bash@local"],
  mounts: [
    {
      path: "/",
      source: "image",
      ref: "browser-main-shell.vfs@local",
      readonly: false,
    },
    { path: "/tmp", source: "scratch", ephemeral: true },
  ],
  boot: {
    argv: ["bash", "-l", "-i"],
    cwd: "/home/user",
    env: {
      HOME: "/home/user",
      USER: "user",
      LOGNAME: "user",
    },
    uid: 1000,
    gid: 1000,
  },
  caps: { network: false },
};

const IDENTITY: PresetSessionIdentity = {
  cwd: "/home/user/c",
  env: ["HOME=/home/user", "USER=user"],
  uid: 1000,
  gid: 1000,
};

test("C development is presentation over the ordinary shell", () => {
  const preset = PRESET_LIBRARY.find(({ id }) => id === "c-dev");
  expect(preset).toMatchObject({
    id: "c-dev",
    title: "C development",
    base: "kandelo:shell@abi" + ABI_VERSION,
    packages: ["kandelo-sdk@local", "make@local", "bash@local"],
    bootCommand: ["bash", "-l", "-i"],
    cwd: "/home/user/c",
    env: {
      CC: "cc",
      CXX: "c++",
      MAKEFLAGS: "-j1",
      PWD: "/home/user/c",
    },
  });
  expect(C_DEVELOPMENT_SESSION.packagePrefetch?.roots).toEqual([
    "kandelo-dev/tap-core/kandelo-sdk",
  ]);
});

test("protected evidence maps the ordinary and preset toolchain surfaces exactly", () => {
  expect(candidateEvidenceLiveDemoId("toolchain-shell")).toBe("shell");
  expect(candidateEvidenceLiveDemoId("c-development")).toBe("c-dev");
});

test("the guide exposes C, C++, immutable retry, and the fork limitation", () => {
  const guide = cDevelopmentGuide();
  expect((guide.groups ?? []).flatMap(({ actions }) => actions).map(({ label }) => label))
    .toEqual(["Compile C", "Compile C++"]);
  expect(guide.script?.initialText).toBe("cc hello.c -o hello.wasm && ./hello.wasm");
  expect(guide.summary).toMatch(/first use|background/i);
  expect(guide.summary).toMatch(/same immutable version/i);
  expect(guide.summary).toMatch(/fork-family.*unsupported.*in-guest fork instrumenter/i);
});

test("gallery descriptor changes cwd and convenience env without changing image", () => {
  const preset = PRESET_LIBRARY.find(({ id }) => id === "c-dev");
  if (preset === undefined) throw new Error("c-dev preset is absent");
  const item: GalleryItem = {
    ...preset,
    packages: preset.packages.slice(),
    bootCommand: preset.bootCommand.slice(),
  };
  const result = descriptorFromGalleryItem(item, BASE_DESCRIPTOR);
  expect(result.mounts).toEqual(BASE_DESCRIPTOR.mounts);
  expect(result.boot.cwd).toBe("/home/user/c");
  expect(result.boot.env).toMatchObject({
    HOME: "/home/user",
    USER: "user",
    CC: "cc",
    CXX: "c++",
    MAKEFLAGS: "-j1",
  });
});

test("protected candidate boot retains identity while applying the preset session", () => {
  const candidate: BootDescriptor = {
    ...structuredClone(BASE_DESCRIPTOR),
    mounts: [
      {
        path: "/",
        source: "image",
        ref: "candidate-browser-main-shell.vfs@local",
        readonly: false,
      },
      { path: "/tmp", source: "scratch", ephemeral: true },
    ],
    boot: {
      argv: ["bash", "-l", "-i"],
      cwd: "/home/user",
      env: { HOME: "/home/user", PATH: "/usr/bin:/bin" },
      uid: 1000,
      gid: 1000,
    },
  };
  const result = applyPresetSessionBoot(candidate, C_DEVELOPMENT_SESSION);
  expect(result.mounts).toEqual(candidate.mounts);
  expect(result.boot.argv).toEqual(candidate.boot.argv);
  expect(result.boot.uid).toBe(candidate.boot.uid);
  expect(result.boot.gid).toBe(candidate.boot.gid);
  expect(result.boot.cwd).toBe("/home/user/c");
  expect(result.boot.env).toMatchObject({
    HOME: "/home/user",
    PATH: "/usr/bin:/bin",
    CC: "cc",
    CXX: "c++",
    PWD: "/home/user/c",
  });

  result.mounts.splice(0);
  result.boot.env.CC = "mutated";
  expect(candidate.mounts).toHaveLength(2);
  expect(candidate.boot.env.CC).toBeUndefined();
});

test("prepares local files before running status and starts prefetch afterward", async () => {
  const events: string[] = [];
  let status: MachineStatus = "booting";
  const kernel: PresetSessionKernel = {
    async spawnFromVfs(path, argv, options) {
      expect(path).toBe("/bin/bash");
      expect(argv[0]).toBe("/bin/bash");
      expect(options).toMatchObject({ cwd: "/home/user", uid: 1000, gid: 1000 });
      events.push("workspace");
      return { pid: 41, exit: Promise.resolve(0) };
    },
  };
  const host: PresetSessionHost = {
    getStatus: () => status,
    async prefetchHomebrewPackages(_id, _label, roots) {
      expect(status).toBe("running");
      expect(roots).toEqual(["kandelo-dev/tap-core/kandelo-sdk"]);
      events.push("prefetch");
      return {
        roots: [...roots],
        packages: [],
        materializedPackages: [],
        alreadyMaterializedPackages: [],
      };
    },
  };

  await preparePresetWorkspace(kernel, C_DEVELOPMENT_SESSION, IDENTITY);
  status = "running";
  events.push("status:running");
  const pending = startPresetPackagePrefetch(host, C_DEVELOPMENT_SESSION);
  if (pending === undefined) throw new Error("c-dev package prefetch is absent");
  expect(events).toEqual(["workspace", "status:running", "prefetch"]);
  await expect(pending).resolves.toMatchObject({
    roots: ["kandelo-dev/tap-core/kandelo-sdk"],
  });
});

describe("preset workspace boundaries", () => {
  const kernel: PresetSessionKernel = {
    spawnFromVfs: vi.fn(async () => ({ pid: 1, exit: Promise.resolve(0) })),
  };
  const session = (override: Partial<PresetSession>): PresetSession => ({
    cwd: "/home/user/c",
    env: {},
    workspaceFiles: [{ path: "/home/user/c/main.c", contents: "int main(){}", mode: 0o644 }],
    ...override,
  });

  test.each([
    ["cwd outside user home", session({ cwd: "/tmp/c" })],
    ["prefix sibling", session({ workspaceFiles: [{ path: "/home/user/c2/main.c", contents: "", mode: 0o644 }] })],
    ["parent segment", session({ workspaceFiles: [{ path: "/home/user/c/../main.c", contents: "", mode: 0o644 }] })],
    ["dot segment", session({ workspaceFiles: [{ path: "/home/user/c/./main.c", contents: "", mode: 0o644 }] })],
    ["backslash", session({ workspaceFiles: [{ path: "/home/user/c/main\\.c", contents: "", mode: 0o644 }] })],
    ["path NUL", session({ workspaceFiles: [{ path: "/home/user/c/main\0.c", contents: "", mode: 0o644 }] })],
    ["content NUL", session({ workspaceFiles: [{ path: "/home/user/c/main.c", contents: "bad\0", mode: 0o644 }] })],
    ["invalid mode", session({ workspaceFiles: [{ path: "/home/user/c/main.c", contents: "", mode: 0o1000 }] })],
    ["too many files", session({ workspaceFiles: Array.from({ length: 17 }, (_, i) => ({ path: `/home/user/c/${i}.c`, contents: "", mode: 0o644 })) })],
    ["oversized UTF-8 payload", session({ workspaceFiles: [{ path: "/home/user/c/main.c", contents: "🧪".repeat(16_385), mode: 0o644 }] })],
  ])("rejects %s before spawning", async (_name: string, invalid: PresetSession) => {
    vi.mocked(kernel.spawnFromVfs).mockClear();
    await expect(preparePresetWorkspace(kernel, invalid, IDENTITY)).rejects.toThrow();
    expect(kernel.spawnFromVfs).not.toHaveBeenCalled();
  });

  test("reports a nonzero workspace helper exit without starting a prefetch", async () => {
    const failingKernel: PresetSessionKernel = {
      spawnFromVfs: vi.fn(async () => ({ pid: 1, exit: Promise.resolve(7) })),
    };
    await expect(preparePresetWorkspace(
      failingKernel,
      C_DEVELOPMENT_SESSION,
      IDENTITY,
    )).rejects.toThrow("exited with 7");
  });

  test("requires running status before package prefetch", () => {
    const prefetch = vi.fn<() => Promise<HomebrewPackagePrefetchResult>>();
    const host: PresetSessionHost = {
      getStatus: () => "booting",
      prefetchHomebrewPackages: prefetch,
    };
    expect(() => startPresetPackagePrefetch(host, C_DEVELOPMENT_SESSION))
      .toThrow(/running/i);
    expect(prefetch).not.toHaveBeenCalled();
  });
});
