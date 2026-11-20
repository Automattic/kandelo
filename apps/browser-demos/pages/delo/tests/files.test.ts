import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync } from "fflate";

import { KandeloImageFs } from "../../../../../images/vfs/lib/kandelo-image-fs";
import { childPath, listFolder, parentPath, readRegularFile, upload, uploadConflicts, zipFolder } from "../src/files";

const text = (value: string) => new TextEncoder().encode(value);

const disk = () => {
  const fs = KandeloImageFs.create();
  fs.mkdir("/foo", 0o750, 1000, 1000);
  fs.mkdir("/foo/bar", 0o755);
  fs.writeFile("/foo/baz", text("baz"), 0o600);
  fs.writeFile("/foo/bar/qux", text("qux"));
  fs.symlink("/foo/baz", "/foo/quux");
  fs.writeFile("/corge", text("corge"));
  return fs;
};

test("childPath and parentPath join and split from the root", () => {
  assert.equal(childPath("/", "foo"), "/foo");
  assert.equal(childPath("/foo", "bar"), "/foo/bar");
  assert.equal(parentPath("/foo/bar"), "/foo");
  assert.equal(parentPath("/foo"), "/");
});

test("listFolder lists folders first, then by name, with what each entry is", () => {
  const entries = listFolder(disk(), "/foo");
  assert.deepEqual(entries.map((entry) => [entry.name, entry.kind]), [["bar", "folder"], ["baz", "file"], ["quux", "symlink"]]);
  const baz = entries[1];
  assert.equal(baz.path, "/foo/baz");
  assert.equal(baz.mode & 0o777, 0o600);
  assert.equal(baz.size, 3);
  assert.equal(baz.lazy, false);
  assert.equal(entries[2].target, "/foo/baz");
  const root = listFolder(disk(), "/");
  assert.deepEqual(root.map((entry) => entry.name), ["foo", "corge"]);
  assert.deepEqual([root[0].uid, root[0].gid], [1000, 1000]);
});

test("listFolder refuses a path that is not a folder", () => {
  assert.throws(() => listFolder(disk(), "/corge"), /\/corge is not a folder/);
});

test("readRegularFile reads a file and refuses anything else", () => {
  const fs = disk();
  assert.equal(new TextDecoder().decode(readRegularFile(fs, "/foo/bar/qux")), "qux");
  assert.throws(() => readRegularFile(fs, "/foo/bar"), /\/foo\/bar is not a file/);
  assert.throws(() => readRegularFile(fs, "/foo/quux"), /\/foo\/quux is not a file/);
});

test("zipFolder names entries under the folder and marks what has no bytes with an empty file", () => {
  const fs = disk();
  fs.registerLazyFile("/foo/grault", "https://example.com/grault", 6, 0o644);
  const files = unzipSync(zipFolder(fs, "/foo"));
  assert.deepEqual(Object.keys(files).sort(), ["foo/", "foo/bar/", "foo/bar/qux", "foo/baz", "foo/grault.lazy", "foo/quux.symlink"]);
  assert.equal(new TextDecoder().decode(files["foo/baz"]), "baz");
  assert.equal(files["foo/quux.symlink"].length, 0);
  assert.equal(files["foo/grault.lazy"].length, 0);
  assert.ok(Object.keys(unzipSync(zipFolder(disk(), "/"))).includes("disk/corge"));
});

test("uploadConflicts names the uploads that land on an existing path", () => {
  assert.deepEqual(uploadConflicts(disk(), "/foo", ["baz", "bar/qux", "grault", "bar/garply/waldo"]), ["baz", "bar/qux"]);
});

test("upload writes root files 644 and creates the folders the paths name, 755", () => {
  const fs = disk();
  upload(fs, "/foo", [{ path: "grault", bytes: text("grault") }, { path: "garply/waldo/fred", bytes: text("fred") }, { path: "baz", bytes: text("new") }]);
  assert.equal(new TextDecoder().decode(fs.readFile("/foo/grault")), "grault");
  assert.equal(new TextDecoder().decode(fs.readFile("/foo/garply/waldo/fred")), "fred");
  assert.equal(new TextDecoder().decode(fs.readFile("/foo/baz")), "new");
  const grault = fs.lstat("/foo/grault");
  assert.deepEqual([grault.mode & 0o777, grault.uid, grault.gid], [0o644, 0, 0]);
  const garply = fs.lstat("/foo/garply");
  assert.deepEqual([garply.mode & 0o777, garply.uid, garply.gid], [0o755, 0, 0]);
});

test("upload refuses a path that is not inside the folder", () => {
  for (const path of ["../grault", "garply/../grault", "/grault", "garply//grault", ""]) {
    assert.throws(() => upload(disk(), "/foo", [{ path, bytes: text("x") }]), /is not a path inside a folder/);
  }
});

test("upload writes nothing when one path runs into a file or lands on a folder", () => {
  const fs = disk();
  assert.throws(() => upload(fs, "/foo", [{ path: "corge", bytes: text("x") }, { path: "corge/garply", bytes: text("x") }]), /\/foo\/corge is a file, so \/foo\/corge\/garply cannot go inside it/);
  assert.throws(() => upload(fs, "/foo", [{ path: "grault", bytes: text("x") }, { path: "baz/garply", bytes: text("x") }]), /\/foo\/baz is not a folder/);
  assert.throws(() => upload(fs, "/foo", [{ path: "grault", bytes: text("x") }, { path: "bar", bytes: text("x") }]), /\/foo\/bar is not a file/);
  assert.deepEqual(listFolder(fs, "/foo").map((entry) => entry.name), ["bar", "baz", "quux"]);
});

test("readRegularFile refuses a lazy file the computer has not downloaded", () => {
  const fs = disk();
  fs.registerLazyFile("/foo/grault", "https://example.com/grault", 6, 0o644);
  assert.throws(() => readRegularFile(fs, "/foo/grault"), /\/foo\/grault is not on the disk yet/);
});
