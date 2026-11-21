import { GroupProcessAddressSpace, LinearProcessAddressSpace } from '../../../../host/src/process-address-space';
import { captureProcessRead, processDataView } from '../../../../host/src/process-memory-views';
import * as G from '../../../../host/src/generated/program-extensions';

function check(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function refuses(operation: () => unknown): boolean {
  try { operation(); return false; } catch { return true; }
}
async function runProbe() {
  // These small synthetic memories remain in this disposable Worker. Neither
  // the common backing nor any view is sent to the persistent page realm.
  const memory = new WebAssembly.Memory({ initial: 16, maximum: 32, shared: true });
  const native = new WebAssembly.Memory({ initial: 3, maximum: 4, shared: true });
  const p = G.MEMORY_GROUP_PAGE_BYTES, root = p, words = new Uint32Array(memory.buffer);
  const table = (root + G.MEMORY_GROUP_ROOT_HEADER_BYTES) / 4;
  words[root / 4] = 3; words[table] = 4 * p | 3; words[table + 1] = 6 * p | 3; words[table + 2] = 4 * p | 3;
  let pins = 0, target = 0;
  const access = new GroupProcessAddressSpace({ memory, root, maximumPages: 32,
    assertLive: () => {}, retainNativeObservation: address => {
      target = address; pins++; return () => { pins--; };
    } });
  for (const backend of [access, new LinearProcessAddressSpace(native)]) {
    backend.writeBytes(p - 2, Uint8Array.of(1, 2, 3, 4));
    check(backend.readBytes(p - 2, 4).join() === '1,2,3,4', 'cross-page bytes');
  }
  access.writeBytes(20, Uint8Array.of(71));
  check(access.readBytes(2 * p + 20, 1)[0] === 71, 'direct alias');
  const view = processDataView(access, p - 3, 8);
  view.setBigUint64(0, 0xfedcba9876543210n);
  check(view.getBigUint64(0, true) === 0x1032547698badcfen, 'scalar byte order');
  words[table + 1] = 6 * p | 1;
  check(refuses(() => view.setBigUint64(0, 0n)), 'protection refusal');
  check(view.getBigUint64(0) === 0xfedcba9876543210n, 'no partial write');
  const captured = captureProcessRead(access);
  words[table + 3] = 8 * p | 3; Atomics.store(words, root / 4, 4);
  check(access.readBytes(3 * p, 1)[0] === 0, 'logical growth');
  check(refuses(() => captured.readBytes(3 * p, 1)), 'captured extent');
  const observer = access.prepareNativeObservationI32(24), pending = observer.arm(0, 5000);
  check(pending.async && pins === 1 && target === 4 * p + 24, 'exact engine pin');
  words[table] = 0; access.detachHostAccess();
  check(refuses(() => access.readBytes(24, 1)) && !observer.settled && pins === 1, 'revoked access retains engine pin');
  observer.wake(); check(await pending.value === 'ok', 'actual wait settlement');
  check(observer.settled && Number(pins) === 0, 'pin released once');
  return { crossPage: true, alias: true, byteOrder: true, protectedWrite: true,
    capturedExtent: true, revokedWaitSettled: true, finalPins: pins };
}
self.onmessage = () => {
  void runProbe().then(result => self.postMessage({ result }), error => self.postMessage({ error: String(error) }))
    .finally(() => self.close());
};
