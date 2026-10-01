import assert from "node:assert/strict";
import test from "node:test";

import { buildPreviewUrl } from "./preview-url.ts";

const base = "/a/app/foo/";
const root = "https://kandelo.dev/a/app/foo/";

Object.assign(globalThis, { window: { location: { href: "https://kandelo.dev/kandelo/" } } });

test("a guest path resolves under the preview root", () => {
  assert.equal(buildPreviewUrl(base, "/"), root);
  assert.equal(buildPreviewUrl(base, "/bar.html?baz=1#qux"), `${root}bar.html?baz=1#qux`);
  assert.equal(buildPreviewUrl(base, "?baz=1"), `${root}?baz=1`);
  assert.equal(buildPreviewUrl(base, `${root}bar/`), `${root}bar/`);
});

test("a path that names a scheme stays under the preview root", () => {
  assert.equal(buildPreviewUrl(base, "/javascript:alert(document.domain)"), `${root}javascript:alert(document.domain)`);
  assert.equal(buildPreviewUrl(base, "/https://example.com/bar"), `${root}https://example.com/bar`);
  assert.equal(buildPreviewUrl(base, "/data:text/html,bar"), `${root}data:text/html,bar`);
  assert.equal(buildPreviewUrl(base, "/blob:https://kandelo.dev/bar"), `${root}blob:https://kandelo.dev/bar`);
  assert.equal(buildPreviewUrl(base, "https://example.com/bar"), `${root}https://example.com/bar`);
  assert.equal(buildPreviewUrl(base, "javascript:alert(document.domain)"), `${root}javascript:alert(document.domain)`);
});

test("a traversal out of the preview root opens the preview root", () => {
  assert.equal(buildPreviewUrl(base, "/../../bar"), root);
  assert.equal(buildPreviewUrl(base, "/%2e%2e/bar"), root);
});

test("a blank preview stays blank", () => {
  assert.equal(buildPreviewUrl("about:blank", "/javascript:alert(document.domain)"), "about:blank");
});
