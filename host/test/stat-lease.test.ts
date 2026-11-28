import { strict as assert } from "node:assert";
import { it } from "vitest";
import { ABI_SYSCALLS as SYSCALLS, KIFS_STAT_CERTIFICATE as cert } from "../src/generated/abi";
import { STAT_CACHE_SYSCALL_BITS } from "../src/generated/program-extensions";
import { makeStatLeaseImport, StatLeasePublisher, StatLeaseReader } from "../src/stat-lease";

const encode = (name: string) => new TextEncoder().encode(name);
const stat = (value: number) => new Uint8Array(cert.STAT_BYTES).fill(value);
const fail = () => assert.fail("A cache miss copied bytes to the caller");

function certificate(
  name: string,
  {
    scope = 1n, route = 1n, pathname = 1n, firstBucket = 1n, secondBucket = 1n,
    bucket = 0, value = 17, syscall = SYSCALLS.Stat as number, flags = 0,
  } = {},
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(cert.BYTES);
  const view = new DataView(bytes.buffer);
  const path = encode(name);
  view.setUint32(cert.MAGIC_OFFSET, cert.MAGIC, true);
  view.setUint32(cert.LENGTH_OFFSET, cert.BYTES, true);
  view.setBigUint64(cert.SCOPE_OFFSET, scope, true);
  view.setBigUint64(cert.ROUTE_OFFSET, route, true);
  view.setBigUint64(cert.PATHNAME_GENERATION_OFFSET, pathname, true);
  view.setBigUint64(cert.INODE_GENERATION_OFFSET, bucket === 0 ? firstBucket : secondBucket, true);
  view.setUint32(cert.BUCKET_OFFSET, bucket, true);
  view.setUint32(cert.SYSCALL_OFFSET, syscall, true);
  view.setUint32(cert.FLAGS_OFFSET, flags, true);
  view.setUint32(cert.PATH_LENGTH_OFFSET, path.length, true);
  bytes.set(path, cert.PATH_OFFSET);
  bytes.set(stat(value), cert.STAT_OFFSET);
  view.setBigUint64(cert.GENERATIONS_OFFSET, firstBucket, true);
  view.setBigUint64(cert.GENERATIONS_OFFSET + 8, secondBucket, true);
  return bytes;
}

it("limits a result to the exact request and process generation", () => {
  const publisher = new StatLeasePublisher();
  const reader = new StatLeaseReader(publisher.buffer, 2n);
  const replacement = new StatLeaseReader(publisher.buffer, 3n);
  const path = encode("file");
  assert.equal(publisher.buffer.byteLength, 129056);
  assert.equal(reader.copy(path, SYSCALLS.Stat, 0, fail), false);
  assert.equal(publisher.publish(2n, certificate("file")), true);
  assert.equal(reader.copy(path, SYSCALLS.Stat, 0, bytes => assert.deepEqual(bytes, stat(17))), true);
  assert.equal(reader.copy(encode("files"), SYSCALLS.Stat, 0, fail), false);
  assert.equal(reader.copy(path, SYSCALLS.Lstat, 0, fail), false);
  assert.equal(reader.copy(path, SYSCALLS.Stat, 256, fail), false);
  assert.equal(replacement.copy(path, SYSCALLS.Stat, 0, fail), false);
  const ticket = publisher.prepareTicket();
  publisher.close();
  assert.notEqual(ticket, publisher.ticket());
  assert.equal(reader.copy(path, SYSCALLS.Stat, 0, fail), false);
  assert.equal(publisher.publish(3n, certificate("file")), true);
  assert.equal(reader.copy(path, SYSCALLS.Stat, 0, fail), false);
  assert.equal(replacement.copy(path, SYSCALLS.Stat, 0, () => {}), true);
});

it("waits for consecutive eligible completions before offering a publication", () => {
  const publisher = new StatLeasePublisher();
  assert.equal(publisher.canOffer(2n), false);
  assert.equal(publisher.canOffer(3n), false);
  assert.equal(publisher.canOffer(2n), false);
  assert.equal(publisher.canOffer(2n), true);
  assert.ok(publisher.publish(2n, certificate("file")));

  publisher.close();
  assert.equal(publisher.canOffer(3n), false);
  assert.equal(new StatLeaseReader(publisher.buffer, 2n).copy(encode("file"), SYSCALLS.Stat, 0, fail), false);
  assert.equal(publisher.canOffer(3n), true);
  assert.ok(publisher.publish(3n, certificate("file")));
  assert.equal(publisher.canOffer(3n), true);
});

it("invalidates affected inode and pathname results on a new publication", () => {
  const publisher = new StatLeasePublisher();
  const reader = new StatLeaseReader(publisher.buffer, 2n);
  const hit = (name: string) => reader.copy(encode(name), SYSCALLS.Stat, 0, () => {});
  assert.ok(publisher.publish(2n, certificate("first")));
  assert.ok(publisher.publish(2n, certificate("second", { bucket: 1 })));
  assert.ok(hit("first") && hit("second"));
  assert.ok(publisher.publish(2n, certificate("second", { bucket: 1, firstBucket: 2n })));
  assert.ok(!hit("first") && hit("second"));
  assert.ok(publisher.publish(2n, certificate("third", { pathname: 2n })));
  assert.ok(!hit("second") && hit("third"));
  assert.ok(publisher.publish(2n, certificate("fourth", { pathname: 2n, route: 2n })));
  assert.ok(!hit("third") && hit("fourth"));
  assert.ok(publisher.publish(2n, certificate("fifth", { pathname: 2n, route: 2n, scope: 2n })));
  assert.ok(!hit("fourth") && hit("fifth"));
  const malformed = certificate("fifth");
  malformed[cert.GENERATIONS_OFFSET] ^= 1;
  assert.equal(publisher.publish(2n, malformed), false);
  assert.equal(hit("fifth"), false);
});

it("copies the complete stat record and leaves fallback memory untouched", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const bytes = new Uint8Array(memory.buffer);
  const output = 300;
  bytes.fill(0xb7, output, output + cert.STAT_BYTES + 1);
  bytes.set(encode("file\0"), 32);
  const publisher = new StatLeasePublisher();
  const binding = { buffer: publisher.buffer, token: 2n };
  const cached = makeStatLeaseImport(memory, 4, binding);
  const flags = 0x100;
  const request = SYSCALLS.Fstatat | (flags << STAT_CACHE_SYSCALL_BITS);
  assert.ok(publisher.publish(2n, certificate("file", { syscall: SYSCALLS.Fstatat, flags })));
  assert.equal(cached(0, output, request), 0);
  assert.equal(cached(65535, output, request), 0);
  assert.equal(cached(32, 65536 - cert.STAT_BYTES + 1, request), 0);
  assert.equal(cached(32, output, SYSCALLS.Fstatat), 0);
  assert.equal(makeStatLeaseImport(memory, 4)(32, output, request), 0);
  assert.equal(makeStatLeaseImport(memory, 8, binding)(32n, output, request), 0);
  assert.deepEqual(bytes.slice(output, output + cert.STAT_BYTES), stat(0xb7));
  assert.equal(cached(32, output, request), 1);
  assert.deepEqual(bytes.slice(output, output + cert.STAT_BYTES), stat(17));
  assert.equal(bytes[output + cert.STAT_BYTES], 0xb7);
});

it("discards a copy raced by a replacement publication", () => {
  const publisher = new StatLeasePublisher();
  const reader = new StatLeaseReader(publisher.buffer, 2n);
  const name = encode("file");
  assert.ok(publisher.publish(2n, certificate("file")));
  const replacement = certificate("file", { value: 42 });
  const original = Uint8Array.prototype.set;
  let replaced = false;

  // Interleave a new even sequence just before the reader's final check.
  Uint8Array.prototype.set = function (source: ArrayLike<number>, offset?: number) {
    original.call(this, source, offset);
    if (!replaced && this.byteLength === cert.STAT_BYTES && source.length === cert.STAT_BYTES) {
      replaced = true;
      assert.ok(publisher.publish(2n, replacement));
    }
  };
  try {
    assert.equal(reader.copy(name, SYSCALLS.Stat, 0, fail), false);
    assert.equal(replaced, true);
  } finally {
    Uint8Array.prototype.set = original;
  }
  assert.equal(reader.copy(name, SYSCALLS.Stat, 0, bytes => assert.deepEqual(bytes, stat(42))), true);
});
