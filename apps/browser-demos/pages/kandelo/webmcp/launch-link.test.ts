import assert from "node:assert/strict";
import test from "node:test";

import type { BootDescriptor, GalleryItem } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { decodeBootDescriptor, HARD_CAPS } from "../../../../../web-libs/kandelo-session/src/boot-descriptor.ts";
import { createInlineBootInput } from "../../../../../web-libs/kandelo-session/src/boot-inputs.ts";
import { ToolError } from "./contract.ts";
import { buildLaunchLink } from "./launch-link.ts";

const current: BootDescriptor = {
  version: 1,
  id: "foo",
  title: "Foo",
  base: "kandelo:shell@abi8",
  runtime: { arch: "wasm32", kernel: "kernel@local", memoryPages: 2048, features: [], time: "real" },
  packages: [],
  mounts: [{ path: "/", source: "image", ref: "foo.vfs@local" }],
  boot: {
    argv: ["/usr/bin/login"],
    cwd: "/root",
    env: {},
    inputs: [await createInlineBootInput({ id: "old", filename: "old.sh", bytes: new TextEncoder().encode("old\n"), compression: "gzip" })],
    parameters: { runScript: "old" },
  },
};

const item = {
  id: "bar",
  title: "Bar",
  packages: [],
  bootCommand: ["/usr/bin/login"],
  vfsImageUrl: "https://example.test/bar.vfs.zst",
} as unknown as GalleryItem;

const decoded = async (url: string) => decodeBootDescriptor(new URL(url).hash.slice(1));

test("without a profile the link encodes the current computer at the current URL", async () => {
  const link = await buildLaunchLink(current, undefined, "https://kandelo.test/?a=1", undefined);

  assert.ok(link.url.startsWith("https://kandelo.test/?a=1#k1="));
  assert.equal(link.sizeBytes, new TextEncoder().encode(link.url).length);
  assert.equal((await decoded(link.url)).id, "foo");
});

test("a profile drops the current computer's inputs and parameters", async () => {
  const link = await buildLaunchLink(current, item, "https://kandelo.test/?profile=bar", undefined);

  const descriptor = await decoded(link.url);
  assert.equal(descriptor.boot.inputs, undefined);
  assert.equal(descriptor.boot.parameters, undefined);
});

test("a startup script becomes the only boot input and runs through bash", async () => {
  const link = await buildLaunchLink(current, item, "https://kandelo.test/", "echo hi");

  const descriptor = await decoded(link.url);
  assert.equal(descriptor.boot.inputs?.length, 1);
  assert.equal(descriptor.boot.inputs?.[0]?.id, "script");
  assert.deepEqual(descriptor.boot.parameters, { runScript: "script", runScriptShell: "bash" });
});

test("a script over the inline cap is refused before any URL is built", async () => {
  await assert.rejects(
    buildLaunchLink(current, undefined, "https://kandelo.test/", "x".repeat(HARD_CAPS.maxInlineInflatedInputBytes + 1)),
    (error: unknown) => error instanceof ToolError && error.code === "LIMIT_EXCEEDED",
  );
});

test("the link reports what it does not reproduce", async () => {
  const link = await buildLaunchLink(current, undefined, "https://kandelo.test/", undefined);

  assert.match(link.reproduces, /no modified files, processes or terminal state/);
});
