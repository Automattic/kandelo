import assert from "node:assert/strict";
import { test } from "node:test";
import { computerTemplateFor, computerTemplates } from "./computer-templates";
import { filesystemProfileId, type StoredComputer } from "../../../../../web-libs/kandelo-session/src/computer-library";
import type { GalleryItem } from "../../../../../web-libs/kandelo-session/src/kernel-host";

const item = (id: string, image = "shell", defaultProfileId: string | null = "shell"): GalleryItem => ({
  id, title: id, summary: id, base: "shell", packages: [], bootCommand: ["bash"], accent: "blue", glyph: id,
  estimatedUrlBytes: 0, image: { id: image, title: `${image} image`, defaultProfileId },
});

test("templates group discrete image products, not boot profiles", () => {
  const templates = computerTemplates([item("doom"), item("shell"), item("node"), item("wordpress", "wordpress", "wordpress")]);
  assert.equal(templates.length, 2);
  assert.equal(templates[0].representative.id, "shell");
  assert.deepEqual(templates[0].profiles.map(profile => profile.id), ["doom", "shell", "node"]);
  assert.equal(templates[1].title, "wordpress image");
});

test("equal profile ids in distinct images never combine", () => {
  assert.equal(computerTemplates([item("shell", "first"), item("shell", "second")]).length, 2);
});

test("unannotated gallery entries group only when they share an explicit image URL", () => {
  const first = { ...item("shell"), image: undefined, vfsImageUrl: "/shell.vfs" };
  const second = { ...item("node"), image: undefined, vfsImageUrl: "/shell.vfs" };
  assert.equal(computerTemplates([first, second]).length, 1);
  assert.equal(computerTemplates([{ ...first, vfsImageUrl: undefined }, { ...second, vfsImageUrl: undefined }]).length, 2);
});

test("filesystem identity preserves the original explicit or default profile", () => {
  assert.equal(filesystemProfileId({ profileId: "shell" } as StoredComputer), "shell");
  assert.equal(filesystemProfileId({ profileId: "node", filesystemProfileId: "shell" } as StoredComputer), "shell");
  assert.equal(filesystemProfileId({ profileId: "node", filesystemProfileId: null } as StoredComputer), null);
});

test("computer image labels follow the original filesystem, not the current boot profile", () => {
  const templates = computerTemplates([item("shell"), item("node"), item("wordpress", "wordpress", "wordpress")]);
  const computer = {
    profileId: "wordpress", filesystemProfileId: "shell", descriptor: { id: "shell", mounts: [] },
  } as unknown as StoredComputer;
  assert.equal(computerTemplateFor(computer, templates)?.title, "shell image");
  assert.equal(computerTemplateFor({ ...computer, filesystemProfileId: null }, templates)?.title, "shell image");
  assert.equal(computerTemplateFor({ ...computer, filesystemProfileId: "unknown" }, templates), undefined);
});

test("an exact source image identifies the initial image before profile inference", () => {
  const templates = computerTemplates([
    { ...item("shell"), vfsImageUrl: "/shell.vfs" },
    { ...item("wordpress", "wordpress", "wordpress"), vfsImageUrl: "/wordpress.vfs" },
  ]);
  const computer = {
    profileId: "shell", descriptor: { id: "shell", mounts: [{ path: "/", source: "image", ref: "/wordpress.vfs" }] },
  } as unknown as StoredComputer;
  assert.equal(computerTemplateFor(computer, templates)?.title, "wordpress image");
});
