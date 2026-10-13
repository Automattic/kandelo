import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const imageModulePath = [
  resolve(repoRoot, "local-binaries/kandelo_image_module32.wasm"),
  resolve(repoRoot, "target/wasm32-unknown-unknown/release/kandelo_image_module.wasm"),
].find((path) => existsSync(path) && WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(path))).length === 0) ?? null;
const programPath = tryResolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm");
const composerPath = resolve(repoRoot, "apps/browser-demos/pages/kandelo/kernel-host/image-composer-client.ts");

test.skip(imageModulePath === null || programPath === null, "image writer and guest fixture are required");

async function imageWithState(state: string): Promise<Uint8Array> {
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  filesystem.setImageCapacity(64 * 1024 * 1024);
  filesystem.mkdir("/etc", 0o755);
  filesystem.mkdir("/etc/kandelo", 0o755);
  filesystem.mkdir("/bin", 0o755);
  filesystem.writeFile("/state", new TextEncoder().encode(state), 0o644);
  filesystem.writeFile("/bin/persistence-overwrite", new Uint8Array(readFileSync(programPath!)), 0o755);
  filesystem.writeFile("/etc/kandelo/demo.json", new TextEncoder().encode(JSON.stringify({
    version: 1,
    defaultProfile: "probe",
    profiles: { probe: { identity: { title: "Persistence probe", summary: "Fixed-size overwrite test", accent: "#123456", glyph: "sh" } } },
  })), 0o644);
  filesystem.writeFile("/etc/kandelo/experimental-terminal-session.json", new TextEncoder().encode(JSON.stringify({
    kind: "kandelo-experimental-terminal-session",
    version: 1,
    initial: { path: "/bin/persistence-overwrite", argv: ["persistence-overwrite"], uid: 0, gid: 0 },
  })), 0o644);
  return filesystem.saveImage();
}

test("composer reuses exact frozen computer image despite a changed source", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const firstImage = await imageWithState("abcdefgh");
  const changedImage = await imageWithState("changed!");
  const firstUrl = new URL("/fixed-composer-first.vfs", baseURL).href;
  const changedUrl = new URL("/fixed-composer-changed.vfs", baseURL).href;
  await page.route(firstUrl, (route) => route.fulfill({ body: Buffer.from(firstImage) }));
  await page.route(changedUrl, (route) => route.fulfill({ body: Buffer.from(changedImage) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(async ({ composerUrl, firstUrl, changedUrl }) => {
    const { composeImageInWorker } = await import(composerUrl);
    const compose = (imageBytes: Uint8Array, frozenImageBytes?: Uint8Array) =>
      composeImageInWorker({
        imageBytes,
        frozenImageBytes,
        maxVfsByteLength: 64 * 1024 * 1024,
        imageLabel: "persistence probe",
        requestedProfileId: "probe",
        requestedProfileSource: "test",
        hasCandidateEvidence: false,
        descriptor: { boot: { inputs: [] } } as never,
        appPath: "/pages/kandelo/",
        proto: "http",
        preforkServiceProcesses: 1,
      }, {
        onTick: () => {},
        isCurrent: () => true,
        supersededError: () => new Error("superseded"),
      });
    const first = await compose(new Uint8Array(await (await fetch(firstUrl)).arrayBuffer()));
    const frozen = first.imageBytes.slice();
    const restored = await compose(new Uint8Array(await (await fetch(changedUrl)).arrayBuffer()), frozen);
    const changed = await compose(new Uint8Array(await (await fetch(changedUrl)).arrayBuffer()));
    const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).join(",");
    return {
      exact: await digest(first.imageBytes) === await digest(restored.imageBytes),
      differsFromChangedSource: await digest(restored.imageBytes) !== await digest(changed.imageBytes),
      profile: restored.profileId,
    };
  }, {
    composerUrl: new URL(`/@fs/${composerPath}`, baseURL).href,
    firstUrl,
    changedUrl,
  });
  expect(result).toEqual({ exact: true, differsFromChangedSource: true, profile: "probe" });
});
