import { describe, expect, it } from "vitest";
import { descriptorFromGalleryItem } from "../../apps/browser-demos/pages/kandelo/gallery-descriptor";
import type {
  BootDescriptor,
  GalleryItem,
} from "../../web-libs/kandelo-session/src/kernel-host";

describe("gallery descriptor profiles", () => {
  it.each([
    {
      id: "node",
      command: ["bash", "-l", "-i"],
      cwd: "/home/maker",
      uid: 1000,
      gid: 1000,
      env: {
        HOME: "/home/maker",
        PWD: "/home/maker",
        USER: "maker",
        LOGNAME: "maker",
      },
    },
    {
      id: "shell",
      command: ["bash", "-l", "-i"],
      cwd: "/home/maker",
      uid: 1000,
      gid: 1000,
      env: {
        HOME: "/home/maker",
        USER: "maker",
        LOGNAME: "maker",
      },
    },
    {
      id: "nginx",
      command: ["/sbin/dinit", "nginx"],
      cwd: "/root",
      uid: 0,
      gid: 0,
      env: {
        HOME: "/root",
        USER: "root",
        LOGNAME: "root",
      },
    },
  ])(
    "replaces stale identity state for the $id profile",
    ({ id, command, cwd, uid, gid, env }) => {
      const base = descriptorFixture();
      const item = galleryFixture(id, command);

      const descriptor = descriptorFromGalleryItem(item, base);

      expect(descriptor).toMatchObject({
        id,
        title: `Title: ${id}`,
        packages: [`package:${id}`],
        boot: { argv: command, cwd, uid, gid, env },
      });
      expect(descriptor.boot.env).not.toHaveProperty("PS1");
      expect(descriptor.boot.env).not.toHaveProperty("npm_config_cache");
      expect(descriptor.runtime).toBe(base.runtime);
      expect(descriptor.caps).toBe(base.caps);
    },
  );

  it("replaces only the root image mount for a direct VFS gallery item", () => {
    const base = descriptorFixture();
    const item = {
      ...galleryFixture("custom", ["bash", "-l", "-i"]),
      vfsImageUrl: "https://cdn.example.test/custom.vfs.zst",
    };

    const descriptor = descriptorFromGalleryItem(item, base);

    expect(descriptor.mounts).toEqual([
      {
        path: "/",
        source: "image",
        ref: item.vfsImageUrl,
        readonly: false,
      },
      base.mounts[1],
    ]);
    expect(base.mounts[0]).toMatchObject({
      ref: "shell.vfs@local",
      readonly: true,
    });
  });
});

function descriptorFixture(): BootDescriptor {
  return {
    version: 1,
    id: "stale",
    title: "Stale",
    base: "kandelo:shell@abi42",
    runtime: {
      arch: "wasm32",
      kernel: "kernel@local",
      memoryPages: 2048,
      features: ["shared-array-buffer", "pty"],
      time: "real",
    },
    packages: ["package:stale"],
    mounts: [
      {
        path: "/",
        source: "image",
        ref: "shell.vfs@local",
        readonly: true,
      },
      {
        path: "/data",
        source: "tmpfs",
        readonly: false,
      },
    ],
    boot: {
      argv: ["stale"],
      cwd: "/stale",
      env: {
        HOME: "/root",
        PWD: "/stale",
        PS1: "stale$ ",
        npm_config_cache: "/stale-cache",
      },
      uid: 42,
      gid: 42,
    },
    caps: { network: false },
  };
}

function galleryFixture(
  id: string,
  bootCommand: string[],
): GalleryItem {
  return {
    id,
    title: `Title: ${id}`,
    summary: id,
    base: "kandelo:shell@abi42",
    packages: [`package:${id}`],
    bootCommand,
    accent: "#000000",
    glyph: id.slice(0, 2),
    estimatedUrlBytes: 1,
  };
}
