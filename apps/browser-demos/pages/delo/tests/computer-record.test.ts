import assert from "node:assert/strict";
import test from "node:test";
import { currentConfiguration, currentDescription, parseDeloComputerRecord, withDescription, withPending, writeDeloComputerRecord, type DeloComputerRecord } from "../src/computer-record";
import { EMPTY_DELO_PIPELINE } from "../src/draft";

const FOO_CONFIGURATION = { pipeline: { name: "foo", description: "qux", ...EMPTY_DELO_PIPELINE, use: ["bar"], enable: ["theme"], files: [{ to: "/etc/foo", content: "foo" }] }, firstProcess: "bar", added: ["foo"] };
const EMPTY_CONFIGURATION = { pipeline: { name: "quux-pipeline", description: "", ...EMPTY_DELO_PIPELINE }, firstProcess: null, added: [] };
const FOO = { description: "foo bar", ...FOO_CONFIGURATION };
const EMPTY = { description: "foo bar", ...EMPTY_CONFIGURATION };
const RECORD = { version: 0, disk: FOO, written: { steps: { "/etc/foo": { text: "foo", claims: { "/etc/foo": "bar" } } }, left: ["/srv/foo"] }, pending: null };

test("parses a record, whose configuration and description are the pending ones, else the disk's", () => {
  const record = parseDeloComputerRecord(JSON.stringify(RECORD));
  assert.deepEqual(record, RECORD);
  assert.deepEqual(currentConfiguration(record), FOO_CONFIGURATION);
  assert.equal(currentDescription(record), "foo bar");
  const pending = parseDeloComputerRecord(JSON.stringify({ ...RECORD, pending: { ...EMPTY, description: "baz" } }));
  assert.deepEqual(currentConfiguration(pending), EMPTY_CONFIGURATION);
  assert.equal(currentDescription(pending), "baz");
});

test("a change of configuration or description is pending until it matches the disk again", () => {
  const record = parseDeloComputerRecord(JSON.stringify(RECORD));
  const changed = withPending(record, EMPTY_CONFIGURATION);
  assert.deepEqual(changed.pending, EMPTY);
  assert.equal(withPending(changed, FOO_CONFIGURATION).pending, null);
  const described = withDescription(record, "baz");
  assert.deepEqual(described.pending, { ...FOO, description: "baz" });
  assert.equal(withDescription(described, "foo bar").pending, null);
});

test("refuses a record that is not exactly a delo record", () => {
  for (const value of [null, [], { ...RECORD, version: 1 }, { ...RECORD, baz: 1 }]) {
    assert.throws(() => parseDeloComputerRecord(JSON.stringify(value)), /delo.json is invalid/);
  }
  for (const disk of [{ ...FOO, firstProcess: 1 }, { ...FOO, added: [1] }, { ...FOO, quux: 1 }, FOO_CONFIGURATION, { ...FOO, description: 1 }, { ...FOO, description: "a".repeat(501) }]) {
    assert.throws(() => parseDeloComputerRecord(JSON.stringify({ ...RECORD, disk })), /delo.json disk is invalid/);
  }
  for (const written of [null, { steps: {} }, { steps: {}, left: [1] }, { steps: { "/etc/foo": { text: 1, claims: {} } }, left: [] }, { steps: { "/etc/foo": { text: "foo", claims: { "/etc/foo": 1 } } }, left: [] }]) {
    assert.throws(() => parseDeloComputerRecord(JSON.stringify({ ...RECORD, written })), /delo.json written is invalid/);
  }
  assert.throws(() => parseDeloComputerRecord(JSON.stringify({ ...RECORD, pending: { ...FOO, pipeline: { ...FOO.pipeline, start: "foo" } } })), /delo.json pending.pipeline has unknown keys: start/);
});

test("refuses a pipeline without a valid name and description", () => {
  const { name: _, ...unnamed } = FOO.pipeline;
  const { description: __, ...undescribed } = FOO.pipeline;
  for (const pipeline of [unnamed, undescribed, { ...FOO.pipeline, name: "Foo" }, { ...FOO.pipeline, description: 1 }, { ...FOO.pipeline, description: "a".repeat(501) }]) {
    assert.throws(() => parseDeloComputerRecord(JSON.stringify({ ...RECORD, disk: { ...FOO, pipeline } })), /delo.json disk.pipeline.(name|description) is invalid/);
  }
});

test("refuses to write a record whose bytes exceed the limit the read enforces", async () => {
  const files = [{ to: "/etc/foo", content: "é".repeat(2_200_000) }];
  const record = { ...RECORD, disk: { ...FOO, pipeline: { ...FOO.pipeline, files } } } as DeloComputerRecord;
  await assert.rejects(writeDeloComputerRecord("foo", record), /delo.json would exceed 4194304 bytes/);
});
