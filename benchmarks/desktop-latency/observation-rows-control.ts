import assert from 'node:assert/strict';
import { ObservationRows } from './native-observer-client.js';

const frame = (index: number, displayMs: number, active = true) => ({ kind: 'frame', index, displayMs, active, pose: index });
// The predicate must not reuse an earlier frame already in the stream.
const normal = new ObservationRows();
normal.receive(frame(1, 100));
const response = normal.wait(r => r.kind === 'frame', normal.rows.length);
normal.receive({ kind: 'pong', id: 'not-a-frame' }); normal.receive(frame(2, 110));
assert.equal((await response).index, 2); normal.check(); normal.dispose();

// Failure while input dispatch is in flight remains owned until awaited.
const failed = new ObservationRows();
const inFlight = failed.wait(r => r.kind === 'frame');
failed.receive({ kind: 'error', error: 'injected capture failure during input' });
await new Promise(resolve => setImmediate(resolve));
await assert.rejects(inFlight, /injected capture failure/);
await assert.rejects(failed.wait(() => true), /injected capture failure/);

// A desired frame must never win a race against the inactive-display guard.
const inactive = new ObservationRows(); inactive.receive(frame(1, 100, false)); inactive.arm();
const badResponse = inactive.wait(r => r.kind === 'frame', inactive.rows.length);
inactive.receive(frame(2, 110, false));
await assert.rejects(badResponse, /active display/);

for (const second of [frame(1, 110), frame(2, 99)]) {
  const order = new ObservationRows(); order.receive(frame(1, 100));
  const pending = order.wait(() => true, order.rows.length); order.receive(second);
  await assert.rejects(pending, /Reordered or duplicated/);
}
for (const status of [2, 3]) {
  const suspended = new ObservationRows(); suspended.receive({ kind: 'sample-status', status }); suspended.check(); suspended.arm();
  const pending = suspended.wait(() => true, suspended.rows.length);
  suspended.receive({ kind: 'sample-status', status });
  await assert.rejects(pending, /active display/);
}
const expired = new ObservationRows();
await assert.rejects(expired.wait(() => false, 0, 1), /response timeout/); expired.dispose();
console.log('PASS response cursor, in-flight failure custody, ordering, active-display guards and timeout controls');
