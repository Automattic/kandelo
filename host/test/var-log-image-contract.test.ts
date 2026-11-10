/**
 * `/var/log` is part of the image now.
 *
 * It used to be a tmpfs scratch mount, which the kernel synthesised on every
 * machine whether or not the image shipped the directory. It is durable now, so
 * it lives on the root filesystem and an image that lacks it has no `/var/log`:
 * opening `/var/log/messages` fails with ENOENT (the kernel side of that is
 * `an_image_with_no_var_log_content_still_mounts` in
 * `crates/runtime-core/src/rootfs.rs`). The kernel does not create the
 * directory at boot, because the host enables journal persistence after the
 * image loads and the journal's recovery assumes the loaded tree is unmodified.
 *
 * So the guarantee is a contract on the image producers, pinned here:
 * the canonical rootfs declares the directory, and every image builder that
 * names a path beneath it provides the directory itself.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../src/binary-resolver";

const root = findRepoRoot();

describe("/var/log is provided by the image", () => {
  it("is declared by the canonical rootfs MANIFEST", () => {
    const manifest = readFileSync(join(root, "MANIFEST"), "utf8");
    expect(manifest).toMatch(/^\/var\/log\s+d\s+0755\s+0\s+0\b/m);
  });

  // SOURCE SCAN, not a behavioural test: the builders cannot be run here (they
  // need package binaries). The behavioural half is the `addDinitInit` test in
  // `dinit-image-helpers.test.ts`, which proves the helper creates the
  // directory. This scan proves each builder that mentions `/var/log` either
  // calls that helper or creates the directory itself.
  const scripts = join(root, "images", "vfs", "scripts");
  // Files that mention /var/log but do not build an image root of their own.
  const notRoots: Record<string, string> = {
    "dinit-image-helpers.ts": "the helper that creates the directory",
    "smtp-capture-helpers.ts": "adds a service to an image whose builder ran addDinitInit",
    "wordpress-first-boot.ts": "adds a service to an image whose builder ran addDinitInit",
    "build-image-families.ts": "derives from images built with addDinitInit (nginx-php, redis, ...)",
  };
  const creates = /addDinitInit\(|ensureDirRecursive\(\s*fs,\s*"\/var\/log"\s*\)/;

  const mentioning = readdirSync(scripts)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => readFileSync(join(scripts, name), "utf8").includes("/var/log"));

  it("finds the image builders that write beneath /var/log", () => {
    expect(mentioning).toContain("build-nginx-php-vfs-image.ts");
    expect(mentioning).toContain("build-ruby-todo-vfs-image.ts");
  });

  for (const name of mentioning.filter((n) => !(n in notRoots))) {
    it(`${name} creates /var/log itself`, () => {
      expect(readFileSync(join(scripts, name), "utf8")).toMatch(creates);
    });
  }
});
