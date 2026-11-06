import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { registerProgramOriginal } from "../../images/vfs/scripts/program-originals";
import type { ResolvedProgramOriginalWasmArtifact } from "../src/binary-resolver";
import { loadDependencyOriginalInputs, resolveDependencyOriginalInput } from "../../images/vfs/scripts/dependency-original-inputs";

function originalFixture(size = 8) {
  const original = Buffer.from("\0asm\x01\0\0\0");
  const sha256 = createHash("sha256").update(original).digest("hex");
  const name = Buffer.from("kandelo.original-program");
  const reference = Buffer.alloc(44);
  reference.writeUInt32LE(1);
  reference.writeBigUInt64LE(BigInt(size), 4);
  Buffer.from(sha256, "hex").copy(reference, 12);
  const program = Buffer.concat([original, Buffer.from([0, 1 + name.length + reference.length, name.length]), name, reference]);
  const companion: ResolvedProgramOriginalWasmArtifact = {
    path: "/owned/originals/program.wasm", packageName: "program", sourceArtifact: "originals/program.wasm",
    cacheKey: "a".repeat(64), relPath: `programs/wasm32/.originals/program/${"a".repeat(64)}/originals/program.wasm`,
    size, sha256, mode: 0o444,
  };
  const fs = KandeloImageFs.create();
  const vfsPath = "/bin/program";
  const originalPath = `/usr/lib/kandelo/originals/${sha256}.wasm`;
  const options = { resolverPath: "programs/wasm32/program.wasm", dependency: "program",
    executablePath: "/owned/program.wasm", program, vfsPath, resolveOriginal: vi.fn(() => companion) };
  return { fs, original, program, companion, originalPath, options };
}

describe("image original-program delivery", () => {
  it("registers a read-only digest-bound lazy original rather than embedding its body", async () => {
    const fixture = originalFixture(32 * 1024 * 1024);
    const beforeLength = (await fixture.fs.saveImage()).byteLength;
    registerProgramOriginal(fixture.fs, fixture.options);
    const stat = fixture.fs.lstat(fixture.originalPath);
    expect(stat.size).toBe(fixture.companion.size);
    expect(stat.mode & 0o7777).toBe(0o444);
    expect(stat.deferred).toBe(true);
    expect(stat.uid).toBe(0);
    expect(stat.gid).toBe(0);
    const entry = fixture.fs.lazyEntries().files.find((entry) => entry.path === fixture.originalPath)!;
    expect(entry.uri).toBe(`kandelo-lazy:${fixture.companion.relPath}`);
    expect(Buffer.from(entry.digest).toString("hex")).toBe(fixture.companion.sha256);
    expect((await fixture.fs.saveImage()).byteLength - beforeLength).toBeLessThan(64 * 1024);
  });

  it("restores a missing companion when its executable is already lazy in the imported image", () => {
    const fixture = originalFixture();
    fixture.fs.registerLazyFile(fixture.options.vfsPath, "kandelo-lazy:programs/program.wasm", fixture.program.length, 0o755,
      createHash("sha256").update(fixture.program).digest("hex"));
    const executableInode = fixture.fs.stat(fixture.options.vfsPath).ino;
    registerProgramOriginal(fixture.fs, fixture.options);
    const originalInode = fixture.fs.stat(fixture.originalPath).ino;
    registerProgramOriginal(fixture.fs, fixture.options);
    expect(fixture.fs.stat(fixture.options.vfsPath).ino).toBe(executableInode);
    expect(fixture.fs.stat(fixture.originalPath).ino).toBe(originalInode);
    expect(fixture.fs.lazyEntries().files).toHaveLength(2);
  });

  it("admits an unassociated program only when both declaration and reference are absent", () => {
    const fixture = originalFixture();
    const resolveOriginal = vi.fn(() => null);
    registerProgramOriginal(fixture.fs, { ...fixture.options, program: fixture.original, resolveOriginal });
    expect(resolveOriginal).toHaveBeenCalledOnce();
    expect(fixture.fs.lazyEntries().files).toHaveLength(0);
    expect(() => fixture.fs.checkOriginalProgramReference(fixture.original, fixture.companion)).toThrow(/ENOEXEC/);
  });

  it("refuses a declared original when the executable's reference has been stripped", () => {
    const fixture = originalFixture();
    expect(() => registerProgramOriginal(fixture.fs, { ...fixture.options, program: fixture.original })).toThrow(/ENOEXEC/);
    expect(fixture.options.resolveOriginal).toHaveBeenCalledOnce();
    expect(fixture.fs.lazyEntries().files).toHaveLength(0);
  });

  it.each(["missing", "length", "digest", "package", "mode"])("refuses %s association defects before registering an original", (mutation) => {
    const fixture = originalFixture();
    const companion = { ...fixture.companion };
    if (mutation === "length") companion.size += 1;
    if (mutation === "digest") companion.sha256 = "b".repeat(64);
    if (mutation === "package") companion.packageName = "unrelated";
    if (mutation === "mode") companion.mode = 0o755;
    expect(() => registerProgramOriginal(fixture.fs, { ...fixture.options,
      resolveOriginal: () => mutation === "missing" ? null : companion })).toThrow();
    expect(fixture.fs.lazyEntries().files).toHaveLength(0);
  });

  it("refuses malformed reference containers instead of treating them as absent", () => {
    const fixture = originalFixture();
    const malformed = Buffer.concat([fixture.program, Buffer.from([0, 10, 0])]);
    expect(() => registerProgramOriginal(fixture.fs, { ...fixture.options, program: malformed })).toThrow(/ENOEXEC/);
    expect(fixture.options.resolveOriginal).not.toHaveBeenCalled();
  });

  it.each(["originals/app?.wasm", "originals/app#.wasm", "originals/%41.wasm", "originals/%2Fapp.wasm", "originals/%252e%252e/app.wasm"])("refuses an undeliverable original URI %s before registration", (artifact) => {
    const fixture = originalFixture();
    const original = { ...fixture.companion, sourceArtifact: artifact,
      relPath: `programs/wasm32/.originals/program/${fixture.companion.cacheKey}/${artifact}` };
    expect(() => registerProgramOriginal(fixture.fs, { ...fixture.options, resolveOriginal: () => original })).toThrow(/path is invalid/);
    expect(fixture.fs.lazyEntries().files).toHaveLength(0);
  });

  it("does not attach current originals to a different existing executable", () => {
    const fixture = originalFixture();
    fixture.fs.registerLazyFile(fixture.options.vfsPath, "kandelo-lazy:programs/program.wasm", fixture.program.length, 0o755, "0".repeat(64));
    expect(() => registerProgramOriginal(fixture.fs, fixture.options)).toThrow(/Existing image program differs/);
    expect(fixture.fs.lazyEntries().files).toHaveLength(1);
  });

  it.each(["mode", "owner", "content", "symlink"])("preserves and refuses conflicting original %s", (mutation) => {
    const fixture = originalFixture();
    fixture.fs.ensureDirRecursive(fixture.originalPath, 0o755);
    if (mutation === "symlink") {
      fixture.fs.writeFile("/target", fixture.original, 0o444);
      fixture.fs.symlink("/target", fixture.originalPath);
    } else {
      fixture.fs.writeFile(fixture.originalPath, mutation === "content" ? Buffer.alloc(8) : fixture.original,
        mutation === "mode" ? 0o755 : 0o444);
      if (mutation === "owner") fixture.fs.chown(fixture.originalPath, 1000, 1000);
    }
    const before = fixture.fs.lstat(fixture.originalPath);
    expect(() => registerProgramOriginal(fixture.fs, fixture.options)).toThrow(/conflicts with selected package/);
    expect(fixture.fs.lstat(fixture.originalPath)).toEqual(before);
  });
});

describe("resolver-owned dependency original inputs", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const value = originalFixture();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kandelo-dependency-originals-")));
    roots.push(root);
    const executablePath = join(root, "program.wasm");
    const originalPath = join(root, "original.wasm");
    writeFileSync(executablePath, value.program, { mode: 0o755 });
    writeFileSync(originalPath, value.original, { mode: 0o444 });
    const input = { packageName: "program", resolverPath: "programs/wasm32/program.wasm",
      executablePath, executableSize: value.program.length, executableSha256: createHash("sha256").update(value.program).digest("hex"),
      original: { ...value.companion, path: originalPath } };
    const metadata = { schema: 1, kind: "kandelo-dependency-original-inputs", consumerPackage: "shell", inputs: [input] };
    const path = join(root, "inputs.json");
    const save = () => writeFileSync(path, JSON.stringify(metadata));
    save();
    return { ...value, root, path, input, metadata, save, executablePath };
  }

  it("registers an original from native bindings without consulting an aggregate or ambient resolver", () => {
    const value = fixture();
    vi.stubEnv("WASM_POSIX_DEP_ORIGINAL_INPUTS", value.path);
    vi.stubEnv("WASM_POSIX_DEP_NAME", "shell");
    vi.stubEnv("WASM_POSIX_DEPS_REGISTRY", join(value.root, "missing-registry"));
    registerProgramOriginal(value.fs, { ...value.options, executablePath: value.executablePath, resolveOriginal: undefined });
    expect(value.fs.stat(value.originalPath).deferred).toBe(true);
  });

  it.each(["owner", "mode", "large-mode", "size", "duplicate", "path", "unknown", "version"])("refuses %s metadata defects", (mutation) => {
    const value = fixture();
    if (mutation === "owner") value.metadata.consumerPackage = "other";
    if (mutation === "mode") value.input.original.mode = 0o755;
    if (mutation === "large-mode") value.input.original.mode = 2 ** 32 + 0o444;
    if (mutation === "size") value.input.original.size = 2 ** 53;
    if (mutation === "duplicate") value.metadata.inputs.push(value.input);
    if (mutation === "path") value.input.original.relPath += "/..";
    if (mutation === "unknown") Object.assign(value.input.original, { dataOnly: true });
    if (mutation === "version") value.metadata.schema = 2;
    value.save();
    expect(() => loadDependencyOriginalInputs(value.path, "shell")).toThrow();
  });

  it("refuses changed executable/original bodies and preserves the native source files", () => {
    const value = fixture();
    const inputs = loadDependencyOriginalInputs(value.path, "shell");
    expect(resolveDependencyOriginalInput(inputs, "programs/program.wasm", "program", value.executablePath, value.program)).toEqual(value.input.original);
    expect(() => resolveDependencyOriginalInput(inputs, "programs/program.wasm", "program", value.executablePath, Buffer.alloc(value.program.length))).toThrow(/Prepared program differs/);
    chmodSync(value.input.original.path, 0o644);
    writeFileSync(value.input.original.path, Buffer.alloc(value.original.length));
    chmodSync(value.input.original.path, 0o444);
    expect(() => resolveDependencyOriginalInput(inputs, "programs/program.wasm", "program", value.executablePath, value.program)).toThrow(/Original differs/);
    expect(readFileSync(value.executablePath)).toEqual(value.program);
  });

  it("bounds metadata reads and refuses symlinked manifests", () => {
    const value = fixture();
    const alias = join(value.root, "alias.json");
    symlinkSync(value.path, alias);
    expect(() => loadDependencyOriginalInputs(alias, "shell")).toThrow(/symlink/);
    truncateSync(value.path, 4 * 1024 * 1024 + 1);
    expect(() => loadDependencyOriginalInputs(value.path, "shell")).toThrow(/4 MiB/);
  });
});
