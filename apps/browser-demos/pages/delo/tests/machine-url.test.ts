import assert from "node:assert/strict";
import test from "node:test";

import { deloComputerUrl, deloImageOf, deloImageRunUrl, deloRunUrl } from "../src/machine-url";

const RAYTRACER = {
  name: "@mho22/raytracer",
  type: "image" as const,
  description: "A ray tracer that renders a 3D scene.",
  vfs: "https://raw.githubusercontent.com/mho22/kandelo-raytracer-vfs/main/vfs/raytracer.vfs",
  profile: "raytracer",
};

test("builds the computer/?vfs=&profile= URL under the delo page", () => {
  assert.equal(
    deloRunUrl(RAYTRACER, "https://kandelo.dev/pages/delo/"),
    "https://kandelo.dev/pages/delo/computer/?vfs=https%3A%2F%2Fraw.githubusercontent.com%2Fmho22%2Fkandelo-raytracer-vfs%2Fmain%2Fvfs%2Fraytracer.vfs&profile=raytracer",
  );
});

test("keeps a deployment base prefix, and drops the delo page query", () => {
  const url = new URL(deloRunUrl(RAYTRACER, "https://example.test/kandelo/pages/delo/?x=1"));
  assert.equal(url.pathname, "/kandelo/pages/delo/computer/");
  assert.deepEqual([...url.searchParams.keys()], ["vfs", "profile"]);
  assert.equal(url.searchParams.get("vfs"), RAYTRACER.vfs);
  assert.equal(url.searchParams.get("profile"), "raytracer");
});

test("opens an image URL on the delo computer page, with no profile", () => {
  assert.equal(
    deloImageRunUrl("https://foo.test/bar.vfs", "https://example.test/kandelo/pages/delo/?x=1"),
    "https://example.test/kandelo/pages/delo/computer/?vfs=https%3A%2F%2Ffoo.test%2Fbar.vfs",
  );
  assert.equal(deloImageRunUrl("http://foo.test/bar.vfs#baz", "https://kandelo.dev/pages/delo/"), "https://kandelo.dev/pages/delo/computer/?vfs=http%3A%2F%2Ffoo.test%2Fbar.vfs%23baz");
  assert.equal(deloImageRunUrl("HTTPS://foo.test/bar.vfs", "https://kandelo.dev/pages/delo/"), "https://kandelo.dev/pages/delo/computer/?vfs=https%3A%2F%2Ffoo.test%2Fbar.vfs");
  for (const name of ["foo", "@foo/bar", "/bar.vfs", "bar.vfs", "ftp://foo.test/bar.vfs", "https://"]) {
    assert.equal(deloImageRunUrl(name, "https://kandelo.dev/pages/delo/"), null, name);
  }
});

test("opens a stored computer on the delo computer page", () => {
  assert.equal(
    deloComputerUrl("8c1f0d4e-6a1b-4c2d-9e3f-0a1b2c3d4e5f", "https://example.test/kandelo/pages/delo/index.html"),
    "https://example.test/kandelo/pages/delo/computer/?computer=8c1f0d4e-6a1b-4c2d-9e3f-0a1b2c3d4e5f",
  );
});

test("names a computer that boots an image by its registered image, else by the image's title", () => {
  const mounts = (ref: string) => [{ path: "/", source: "image", ref, readonly: false }, { path: "/tmp", source: "scratch", ephemeral: true }];
  const computer = (ref: string, profileId: string | null) => ({ descriptor: { title: "Raytracer", mounts: mounts(ref) }, profileId }) as unknown as Parameters<typeof deloImageOf>[1];
  const page = "https://kandelo.dev/pages/delo/";
  assert.deepEqual(deloImageOf([RAYTRACER], computer(RAYTRACER.vfs, "raytracer"), page), "@mho22/raytracer");
  assert.deepEqual(deloImageOf([RAYTRACER], computer(RAYTRACER.vfs, "foo"), page), "Raytracer");
  assert.deepEqual(deloImageOf([RAYTRACER], computer("https://foo.test/bar.vfs", "raytracer"), page), "Raytracer");
  const delo = { descriptor: { title: "corge", mounts: [{ path: "/", source: "opfs", readonly: false }] }, profileId: null } as unknown as Parameters<typeof deloImageOf>[1];
  assert.equal(deloImageOf([RAYTRACER], delo, page), null);
});
