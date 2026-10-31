import { describe, expect, it } from "vitest";
import { PositionedImageTargets, type PositionedImageTarget } from "../../images/vfs/lib/positioned-image-targets";
import { ERRNO } from "../src/generated/abi";

function fixture() {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4 });
  let bytes = new Uint8Array(0);
  let flushes = 0;
  const target: PositionedImageTarget = {
    len: () => bytes.length,
    truncate: length => { bytes = bytes.slice(0, Number(length)); },
    flush: () => { flushes++; },
    readExactAt: (offset, destination) => {
      const position = Number(offset);
      if (position + destination.length > bytes.length) throw new Error("short read");
      destination.set(bytes.subarray(position, position + destination.length));
    },
    writeAllAt: (offset, source) => {
      const position = Number(offset);
      const next = new Uint8Array(Math.max(bytes.length, position + source.length));
      next.set(bytes);
      next.set(source, position);
      bytes = next;
    },
  };
  const registry = new PositionedImageTargets(() => memory);
  return { memory, registry, target, bytes: () => bytes, flushes: () => flushes };
}

describe("positioned image target byte transport", () => {
  it("pins an exact target and synchronous bounded byte windows without hashing or caching", () => {
    const state = fixture();
    const token = state.registry.attach(state.target);
    const imports = state.registry.imports;
    new Uint8Array(state.memory.buffer, 32, 3).set([11, 17, 19]);
    expect(imports.host_image_target_write(token, 5n, 32, 3)).toBe(3);
    expect(imports.host_image_target_size(token)).toBe(8n);
    expect(Array.from(state.bytes())).toEqual([0, 0, 0, 0, 0, 11, 17, 19]);
    expect(imports.host_image_target_read(token, 5n, 40, 3)).toBe(3);
    expect(Array.from(new Uint8Array(state.memory.buffer, 40, 3))).toEqual([11, 17, 19]);
    state.bytes()[6] = 23;
    state.memory.grow(1);
    expect(imports.host_image_target_read(token, 5n, 40, 3)).toBe(3);
    expect(new Uint8Array(state.memory.buffer)[41]).toBe(23);
    expect(imports.host_image_target_flush(token)).toBe(0);
    expect(state.flushes()).toBe(1);
    expect(imports.host_image_target_truncate(token, 6n)).toBe(0);
    expect(imports.host_image_target_size(token)).toBe(6n);
    state.registry.detach(token);
    expect(imports.host_image_target_flush(token)).toBe(-ERRNO.EBADF);
  });

  it("rejects stale tokens and target replacement and snapshots methods before native entry", () => {
    const state = fixture();
    const token = state.registry.attach(state.target);
    expect(() => state.registry.attach(state.target)).toThrow(/busy/);
    expect(() => state.registry.detach(token + 1)).toThrow(/owner mismatch/);
    state.target.len = () => 999;
    expect(state.registry.imports.host_image_target_size(token)).toBe(0n);
    state.registry.detach(token);
    const next = state.registry.attach(state.target);
    expect(next).not.toBe(token);
    expect(state.registry.imports.host_image_target_size(token)).toBe(BigInt(-ERRNO.EBADF));
    expect(state.registry.imports.host_image_target_size(next)).toBe(999n);
    state.registry.detach(next);
  });

  it("checks byte bounds and exact numeric positions before consulting a target", () => {
    const state = fixture();
    const token = state.registry.attach(state.target);
    const imports = state.registry.imports;
    expect(imports.host_image_target_write(token, 0n, 0, 65537)).toBe(-ERRNO.EFAULT);
    expect(imports.host_image_target_read(token, 0n, -1, 1)).toBe(-ERRNO.EFAULT);
    expect(imports.host_image_target_read(token, 0n, 0, -1)).toBe(-ERRNO.EFAULT);
    expect(imports.host_image_target_write(token, -1n, 0, 1)).toBe(-ERRNO.EOVERFLOW);
    expect(imports.host_image_target_truncate(token, 9007199254740992n)).toBe(-ERRNO.EOVERFLOW);
    expect(imports.host_image_target_write(token, 9007199254740991n, 0, 1)).toBe(-ERRNO.EOVERFLOW);
    expect(state.bytes()).toHaveLength(0);
    state.registry.detach(token);
  });

  it("preserves quota and memory failures and refuses asynchronous byte transports", () => {
    for (const code of ["ENOSPC", "ENOMEM"] as const) {
      const state = fixture();
      state.target.writeAllAt = () => { throw Object.assign(new Error(code), { code }); };
      const token = state.registry.attach(state.target);
      expect(state.registry.imports.host_image_target_write(token, 0n, 0, 1)).toBe(-ERRNO[code]);
      state.registry.detach(token);
    }
    const state = fixture();
    state.target.flush = () => { throw new DOMException("quota", "QuotaExceededError"); };
    state.target.readExactAt = async () => {};
    const token = state.registry.attach(state.target);
    expect(state.registry.imports.host_image_target_flush(token)).toBe(-ERRNO.ENOSPC);
    expect(state.registry.imports.host_image_target_read(token, 0n, 0, 1)).toBe(-ERRNO.EIO);
    state.registry.detach(token);
  });
});
