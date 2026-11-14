import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { saveImage, sourceDateEpochMilliseconds } from "../../../images/vfs/scripts/vfs-image-helpers";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { writeVfsBinary, writeVfsFile } from "../../../host/src/vfs/image-helpers";
import { describeWasmArtifactPolicyFailures } from "../../../host/src/constants";
import { ABI_VERSION } from "../../../host/src/generated/abi";

const [basePath, programPath, outputPath] = process.argv.slice(2).map(p => resolve(p));
if (!outputPath?.endsWith(".vfs.zst")) throw Error("Usage: build-image.ts BASE VM_FPM OUTPUT.vfs.zst");
const base = readFileSync(basePath), program = readFileSync(programPath);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const check = (bytes: Uint8Array, experimental = false) => {
  const failures = describeWasmArtifactPolicyFailures(Uint8Array.from(bytes).buffer, {
    expectedAbi: ABI_VERSION,
    ...(experimental ? { experimentalCommonMemory: "prototype-v2" as const, requireForkInstrumentation: true } : {}),
  });
  if (failures.length) throw Error(failures.join("; "));
};
check(program, true);
if (!describeWasmArtifactPolicyFailures(Uint8Array.from(program).buffer).some(s => s.includes("opt-in common-memory"))) {
  throw Error("FPM must be marked virtualized and refused by the ordinary host");
}
const fs = KandeloImageFs.create();
fs.loadImage(base);
const metadata = fs.getImageMetadata();
if (metadata?.kernelAbi !== ABI_VERSION) throw Error("base image ABI mismatch");
const decode = (path: string) => new TextDecoder("utf-8", { fatal: true }).decode(fs.readFile(path));
const originalFpm = sha(fs.readFile("/usr/sbin/php-fpm"));
writeVfsBinary(fs, "/usr/sbin/php-fpm", program);
let ini = decode("/etc/php.ini");
for (const [from, to] of [
  ["opcache.file_cache=/var/cache/opcache", "opcache.file_cache="],
  ["opcache.file_cache_only=1", "opcache.file_cache_only=0"],
  ["opcache.validate_timestamps=0", "opcache.validate_timestamps=1"],
]) {
  if (!ini.includes(from)) throw Error(`missing expected php.ini setting: ${from}`);
  ini = ini.replace(from, to);
}
ini += "\nopcache.memory_consumption=32\nopcache.interned_strings_buffer=4\nopcache.file_update_protection=0\nopcache.revalidate_freq=0\nopcache.jit_buffer_size=0\n";
writeVfsFile(fs, "/etc/php.ini", ini);
const conf = decode("/etc/php-fpm.conf");
if (!/^pm.max_children = 6$/m.test(conf)) throw Error("unexpected source pool configuration");
writeVfsFile(fs, "/etc/php-fpm.conf", conf.replace(/^pm.max_children = 6$/m, "pm.max_children = 2"));
writeVfsFile(fs, "/srv/www/html/common-memory-status.php", `<?php
header('Content-Type: application/json');
header('Cache-Control: no-store');
$s = opcache_get_status(false);
echo json_encode(array('pid'=>getmypid(), 'file_cache_only'=>ini_get('opcache.file_cache_only'),
  'file_cache'=>ini_get('opcache.file_cache'), 'opcache_enabled'=>$s['opcache_enabled'] ?? false,
  'memory_usage'=>$s['memory_usage'] ?? null, 'statistics'=>$s['opcache_statistics'] ?? null));
`);
const demo = JSON.parse(decode("/etc/kandelo/demo.json"));
demo.image.title = "WordPress common-memory prototype";
for (const backend of ["sqlite", "mariadb"]) {
  const identity = demo.profiles[`wordpress-${backend}`].identity;
  identity.title += " (experimental)";
  identity.summary += " Virtualized PHP-FPM with two workers and shared OPcache.";
}
writeVfsFile(fs, "/etc/kandelo/demo.json", JSON.stringify(demo, null, 2) + "\n");

const provenance = { schema: 1, baseSha256: sha(base), originalFpmSha256: originalFpm,
  virtualFpmSha256: sha(program), workers: 2, sharedOpcacheMiB: 32 };
const compressed = await saveImage(fs, outputPath, {
  metadata: { ...metadata, createdBy: "wordpress-common-memory", commonMemoryPrototype: provenance },
  normalizeTimestampsMs: sourceDateEpochMilliseconds(),
  wasmArtifactPolicies: [{ path: "/usr/sbin/php-fpm", forkInstrumentation: "auto", experimentalCommonMemory: "prototype-v2" }],
});
console.log(JSON.stringify({ outputPath, ...provenance, imageSha256: sha(compressed), bytes: compressed.length }));
