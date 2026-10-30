import { expect, test, vi } from "vitest";
import { BinaryNotFoundError } from "../src/binary-resolver";
import { resolveRootfsArtifact, ROOTFS_ARTIFACT_REQUESTS } from "../src/node-kernel-host";

test("default rootfs prefers the registry program over an older packaged alias", () => {
  const resolver = vi.fn((request: string) => request === "programs/rootfs.vfs.zst" ? "/current/rootfs" : "/old/rootfs");
  expect(resolveRootfsArtifact(resolver)).toEqual({ resolverRequest: "programs/rootfs.vfs.zst", selectedPath: "/current/rootfs" });
  expect(resolver.mock.calls).toEqual([["programs/rootfs.vfs.zst"]]);
});

test("standalone package alias remains available when the registry path is absent", () => {
  const resolver = vi.fn((request: string) => {
    if (request === "programs/rootfs.vfs.zst") throw new BinaryNotFoundError("program rootfs is absent");
    return "/installed/rootfs";
  });
  expect(resolveRootfsArtifact(resolver)).toEqual({ resolverRequest: "rootfs.vfs.zst", selectedPath: "/installed/rootfs" });
  expect(resolver.mock.calls.map(([request]) => request)).toEqual([...ROOTFS_ARTIFACT_REQUESTS]);
});

test("default rootfs preserves policy and I/O refusal without trying a stale alias", () => {
  for (const failure of [new Error("present artifact has invalid provenance"), Object.assign(new Error("read failed"), { code: "EIO" })]) {
    const resolver = vi.fn((request: string) => {
      if (request === "programs/rootfs.vfs.zst") throw failure;
      return "/old/rootfs";
    });
    expect(() => resolveRootfsArtifact(resolver)).toThrow(failure);
    expect(resolver).toHaveBeenCalledOnce();
  }
});

test("default rootfs reports both missing locations without pretending initialization succeeded", () => {
  const resolver = vi.fn((request: string): string => { throw new BinaryNotFoundError(`absent ${request}`); });
  expect(() => resolveRootfsArtifact(resolver)).toThrow('rootfsImage:"default" requested but no rootfs image was available');
  expect(resolver.mock.calls.map(([request]) => request)).toEqual([...ROOTFS_ARTIFACT_REQUESTS]);
});
