import assert from "node:assert/strict";
import test from "node:test";
import { partialLibrarySelection } from "./partial-library-selection.ts";
const page = "http://127.0.0.1:7788/";
const image = new URL("/@kandelo-partial/image.vfs.zst", page).href;
const manifest = { schema: 1, image: "shell", productId: "shell-vfs", file: "shell-partial.vfs.zst",
  sha256: "a".repeat(64), bytes: 1234, packages: ["wayland-demo"], selection: ["wayland-demo"],
  activities: ["omarchy"], excludedActivities: [], builtAt: "2026-11-07T00:00:00Z" };
function urls(vfs = image, profile = "omarchy") {
  const url = new URL(page); url.searchParams.set("vfs", vfs); url.searchParams.set("profile", profile);
  return JSON.stringify({ omarchy: url.href });
}
function select(text = JSON.stringify(manifest), mapping: string | undefined = urls()) {
  return partialLibrarySelection("omarchy", page, text, mapping);
}
test("unset opt-in leaves canonical selection unchanged without parsing prepared inputs", () => {
  assert.equal(partialLibrarySelection("omarchy", page, undefined, "not JSON"), null);
});
test("explicit manifest and exact partial URL select only its partial row", () => {
  assert.deepEqual(select(), { imageId: "partial-shell", imageUrl: image, sha256: manifest.sha256, bytes: 1234 });
});
test("deployment-base partial route remains explicit", () => {
  const url = new URL("/base/?profile=omarchy", page);
  const vfs = new URL("/base/@kandelo-partial/image.vfs.zst", page).href; url.searchParams.set("vfs", vfs);
  assert.equal(partialLibrarySelection("omarchy", page, JSON.stringify(manifest), JSON.stringify({ omarchy: url.href }))?.imageUrl, vfs);
});
test("missing prepared URL opt-in cannot fall back", () => {
  assert.throws(() => partialLibrarySelection("omarchy", page, JSON.stringify(manifest), undefined), /requires KANDELO_TEST_MACHINE_URLS/);
});
test("missing profile mapping cannot fall back", () => assert.throws(() => select(undefined, "{}"), /lack profile/));
test("wrong prepared profile cannot select the partial", () => assert.throws(() => select(undefined, urls(image, "sway")), /invalid prepared/));
test("canonical image cannot satisfy explicit partial opt-in", () => assert.throws(() => select(undefined, urls("/assets/shell.vfs.zst")), /not the partial route/));
test("foreign server cannot satisfy explicit partial opt-in", () => assert.throws(() => select(undefined, urls("http://localhost:9999/@kandelo-partial/image.vfs.zst")), /not the partial route/));
test("foreign prepared page cannot redirect selection authority", () => {
  const url = new URL("http://localhost:9999/?profile=omarchy"); url.searchParams.set("vfs", image);
  assert.throws(() => select(undefined, JSON.stringify({ omarchy: url.href })), /invalid prepared/);
});
test("query or hash variants cannot alias the recorded partial route", () => {
  for (const suffix of ["?other=1", "#other"]) assert.throws(() => select(undefined, urls(image + suffix)), /not the partial route/);
});
test("absent activity cannot be replaced with a canonical activity", () => {
  assert.throws(() => select(JSON.stringify({ ...manifest, activities: ["sway"] })), /does not admit/);
});
test("excluded activity rejects even contradictory present activities", () => {
  assert.throws(() => select(JSON.stringify({ ...manifest, excludedActivities: [{ profile: "omarchy", missing: ["foot"] }] })), /does not admit/);
});
test("row identity and manifest filename must agree", () => {
  for (const image of ["other", "bad\"selector"]) assert.throws(() => select(JSON.stringify({ ...manifest, image })), /image\/file mismatch/);
});
test("malformed manifest digest remains loud", () => {
  assert.throws(() => select(JSON.stringify({ ...manifest, sha256: "bad" })), /sha256/);
});
