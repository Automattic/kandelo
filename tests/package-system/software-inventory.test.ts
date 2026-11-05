import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { ensureDirRecursive } from "../../host/src/vfs/image-helpers";
import { parseZipCentralDirectory } from "../../host/src/vfs/zip";
import { archiveMemberDigests, installSoftwareInventory, INSTALLED_SOFTWARE,
  ownsSoftwarePath, softwarePaths } from "../../images/vfs/scripts/software-inventory";

const contract = { programAbi: 55, programDigest: "07".repeat(32) };
const encoder = new TextEncoder();

describe("software inventory production policy", () => {
  it("separates software from credentials, service choices, WordPress data and generated trust", () => {
    for (const path of ["/usr/bin/bash", "/etc/nginx/nginx.conf", "/etc/wordpress/sqlite-db.php", "/var/www/html/wp-admin/index.php"]) {
      expect(ownsSoftwarePath(path, "wordpress-family")).toBe(true);
    }
    for (const path of ["/home/maker/note", "/etc/passwd", "/etc/kandelo/enabled-service",
      "/etc/kandelo/initial-service", "/etc/kandelo/wordpress-secrets.php", "/etc/kandelo/wordpress-backend",
      "/etc/ssl/certs/ca-certificates.crt", "/var/www/html/wp-config.php",
      "/var/www/html/wp-content/uploads/photo.png", "/var/www/html/wp-content/database/db.sqlite",
      "/var/lib/wordpress-sites/sqlite/wp-content/uploads/photo.png",
      "/var/lib/wordpress-sites/mariadb/wp-content/uploads/photo.png", "/var/lib/mysql/ibdata1"]) {
      expect(ownsSoftwarePath(path, "wordpress-family"), path).toBe(false);
    }
    expect(ownsSoftwarePath("/var/lib/todo/server.rb", "web-stack")).toBe(true);
    expect(ownsSoftwarePath("/var/lib/todo/data.json", "web-stack")).toBe(false);
    expect(ownsSoftwarePath("/var/lib/todo/server.rb", "base-shell")).toBe(false);
  });

  it("captures selected pristine paths and keeps the private installed baseline out of its own inventory", () => {
    const fs = KandeloImageFs.create();
    ensureDirRecursive(fs, "/usr/bin");
    ensureDirRecursive(fs, "/etc");
    ensureDirRecursive(fs, "/home/maker");
    fs.writeFile("/usr/bin/tool", encoder.encode("program"), 0o755);
    fs.writeFile("/etc/passwd", encoder.encode("seed credentials"), 0o600);
    fs.symlink("/home/maker", "/usr/user-link");
    fs.writeFile("/home/maker/notes", encoder.encode("user data"), 0o644);
    const paths = softwarePaths(fs, "base-shell");
    expect(paths).toContain("/usr/user-link");
    expect(paths).not.toContain("/usr/user-link/notes");
    expect(paths).not.toContain("/etc/passwd");
    const baseline = installSoftwareInventory(fs, "base-shell", { contract });
    expect(fs.readFile(INSTALLED_SOFTWARE)).toEqual(baseline);
    expect(fs.lstat(INSTALLED_SOFTWARE).mode & 0o7777).toBe(0o600);
    expect(fs.lstat("/var/lib/kandelo/packages").mode & 0o7777).toBe(0o700);
    expect(softwarePaths(fs, "base-shell")).toEqual(paths);
    expect(() => installSoftwareInventory(fs, "web-stack", { contract, parentInventory: baseline })).not.toThrow();
  });

  it("hashes the verified declared archive once and inherits native member identities in derived images", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-inventory-"));
    try {
      const fs = KandeloImageFs.create();
      const body = encoder.encode("package archive member");
      const bytes = zipSync({ "bin/member": body });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const path = join(root, "bundle.zip");
      writeFileSync(path, bytes);
      fs.registerLazyArchive({ url: "kandelo-lazy:programs/bundle.zip", entries: parseZipCentralDirectory(bytes),
        mountPrefix: "/usr/", integrity: { sha256, bytes: bytes.length } });
      const deferredDigests = archiveMemberDigests(fs, () => path);
      expect(deferredDigests.get("/usr/bin/member")).toBe(createHash("sha256").update(body).digest("hex"));
      const parentInventory = installSoftwareInventory(fs, "base-shell", { contract, deferredDigests });
      expect(() => installSoftwareInventory(fs, "web-stack", { contract, parentInventory })).not.toThrow();
      writeFileSync(path, new Uint8Array(bytes.length));
      expect(() => archiveMemberDigests(fs, () => path)).toThrow(/does not match/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
