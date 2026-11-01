import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../../src/binary-resolver";
import { ABI_VERSION } from "../../src/generated/abi";
import { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload } from "../../src/constants";

const encoder = new TextEncoder();

export async function softwareImage(version: 1 | 2, lazyOrigin = "https://packages.invalid/",
  options: { imageOwnedReference?: boolean; pinDirectory?: string; bootConfiguration?: boolean } = {}) {
  const filesystem = KandeloImageFs.create();
  filesystem.setImageCapacity(32 * 1024 * 1024);
  for (const path of ["/software", "/user", "/var", "/var/lib", "/var/lib/kandelo", "/var/lib/kandelo/packages"]) {
    filesystem.mkdir(path, path.endsWith("/packages") ? 0o700 : 0o755);
  }
  const bodies = new Map<string, Uint8Array>([
    ["/software/tool", encoder.encode(version === 1 ? "old program" : "new program\n".repeat(7000))],
    ["/software/config", encoder.encode("package default")],
  ]);
  if (version === 1) bodies.set("/software/remove", encoder.encode("old package file"));
  else {
    filesystem.mkdir("/software/new", 0o755);
    filesystem.mkdir("/software/new/sub", 0o755);
    bodies.set("/software/new/sub/pkg", encoder.encode("new nested package file"));
  }
  const bootPaths: string[] = [];
  if (options.bootConfiguration) {
    for (const path of ["/etc", "/etc/kandelo", "/etc/dinit.d"]) { filesystem.mkdir(path, 0o755); bootPaths.push(path); }
    bodies.set("/etc/kandelo/demo.json", encoder.encode(JSON.stringify({ version: 1, image: { title: `Release ${version}` }, defaultProfile: "site", profiles: {
      site: { init: { target: version === 1 ? "boot" : "web" } } } })));
    bodies.set("/etc/kandelo/experimental-terminal-session.json", encoder.encode(JSON.stringify({
      kind: "kandelo-experimental-terminal-session", version: 1, initial: { path: "/bin/true", argv: ["true"], uid: 0, gid: 0 } })));
    bodies.set("/etc/dinit.d/boot", encoder.encode("type = process\ncommand = /bin/true\n"));
    if (version === 2) {
      bodies.set("/etc/dinit.d/web", encoder.encode("type = process\ncommand = /bin/true\ndepends-on = db\n"));
      bodies.set("/etc/dinit.d/db", encoder.encode("type = process\ncommand = /bin/true\n"));
    }
  }
  for (const [path, bytes] of bodies) filesystem.writeFile(path, bytes, 0o644);
  filesystem.writeFile("/user/notes", encoder.encode("user data"), 0o644);
  const lazy = encoder.encode(`lazy package ${version}`);
  const declaredUri = options.imageOwnedReference || options.pinDirectory !== undefined
    ? "kandelo-lazy:programs/upgrade-fixture.wasm" : new URL(`program-${version}`, lazyOrigin).href;
  filesystem.registerLazyFile("/software/lazy", declaredUri, lazy.length, 0o644,
    createHash("sha256").update(lazy).digest("hex"));
  const kernel = readFileSync(resolveBinary("kernel.wasm"));
  const digest = readWasmCustomSectionPayload(kernel, ABI_CONTRACT_SECTION);
  if (!digest || digest.byteLength !== 32) throw new Error("Current kernel lacks its program contract");
  const sourceInventory = filesystem.buildPackageInventory({
    name: "fixture-software-set", version: String(version), programAbi: ABI_VERSION,
    programDigest: Buffer.from(digest).toString("hex"),
    paths: ["/software", ...bodies.keys(), "/software/lazy", ...bootPaths, ...(version === 2 ? ["/software/new", "/software/new/sub"] : [])],
  });
  filesystem.writeFile("/var/lib/kandelo/packages/installed", sourceInventory, 0o600);
  const inventory = options.pinDirectory === undefined ? sourceInventory : filesystem.pinPackageInventorySources(sourceInventory, options.pinDirectory);
  const lazyUri = options.pinDirectory === undefined ? declaredUri : new URL("assets/programs/wasm32/upgrade-fixture.wasm", options.pinDirectory).href;
  return { bytes: await filesystem.saveImage(), inventory, sourceInventory, bodies, lazy, lazyUri };
}
