// The fake kernel worker for `wasm-integration.mjs`.
//
// Implements the process-worker side of the syscall channel the way
// `host/src/kernel-worker.ts` does: block on the status word, service the
// request that appears, publish the result, and notify the waiter back.
//
// It only knows the handful of syscalls the integration harness drives; an
// unrecognised one is answered with ENOSYS rather than silently succeeding,
// so a wrong syscall number shows up as a failure instead of a pass.

import { parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";

const { memory, channelBase } = workerData;
const i32 = new Int32Array(memory.buffer);
const view = new DataView(memory.buffer);

const CH_STATUS = 0;
const CH_SYSCALL = 4;
const CH_ARGS = 8;
const CH_ARG_SIZE = 8;
const CH_RETURN = 56;
const CH_ERRNO = 64;
const STATUS_IDLE = 0;
const STATUS_PENDING = 1;
const STATUS_COMPLETE = 2;

const SYS_SEEK = 5;
const SYS_OPENAT = 69;
const SYS_WRITEV = 81;

const statusIdx = (channelBase + CH_STATUS) / 4;
const calls = [];
let running = true;

// The service loop below is synchronous, so it never yields to this worker's
// event loop and an `on("message")` handler would never fire. Polling the port
// with `receiveMessageOnPort` is what lets control messages through.
function pump() {
  let envelope;
  while ((envelope = receiveMessageOnPort(parentPort)) !== undefined) {
    const msg = envelope.message;
    if (msg.type === "calls") {
      parentPort.postMessage(calls.slice());
    } else if (msg.type === "stop") {
      running = false;
    }
  }
}

parentPort.postMessage({ ready: true });

// The service loop. `Atomics.wait` here is the mirror image of the module's
// `memory.atomic.wait32`: each side sleeps on the same word and wakes the
// other with a notify.
while (running) {
  pump();
  const woke = Atomics.wait(i32, statusIdx, STATUS_IDLE, 100);
  if (Atomics.load(i32, statusIdx) !== STATUS_PENDING) {
    if (woke === "timed-out") continue;
    continue;
  }

  const nr = view.getInt32(channelBase + CH_SYSCALL, true);
  const args = Array.from({ length: 6 }, (_, index) =>
    view.getBigInt64(channelBase + CH_ARGS + index * CH_ARG_SIZE, true),
  );
  calls.push({ nr, args: args.map(String) });

  let result = 0n;
  let errno = 0;
  switch (nr) {
    case SYS_OPENAT:
      // The module asked to open "/" as a directory; hand back fd 3.
      result = 3n;
      break;
    case SYS_WRITEV: {
      // Report the total the iovec array describes, as a real writev would.
      const iovs = Number(args[1]);
      const count = Number(args[2]);
      let total = 0;
      for (let index = 0; index < count; index++) {
        total += view.getUint32(iovs + index * 8 + 4, true);
      }
      result = BigInt(total);
      break;
    }
    case SYS_SEEK: {
      // Echo the offset back, reassembled from the low/high words the
      // kernel's lseek ABI carries.
      const low = BigInt.asUintN(32, args[1]);
      const high = BigInt.asIntN(32, args[2]);
      result = (high << 32n) | low;
      break;
    }
    default:
      errno = 38; // ENOSYS -- an unexpected syscall must not look like success
      result = -1n;
      break;
  }

  view.setBigInt64(channelBase + CH_RETURN, result, true);
  view.setUint32(channelBase + CH_ERRNO, errno, true);
  Atomics.store(i32, statusIdx, STATUS_COMPLETE);
  Atomics.notify(i32, statusIdx, 1);

  // Wait for the module to reset the word to IDLE before looking again.
  while (running && Atomics.load(i32, statusIdx) === STATUS_COMPLETE) {
    pump();
    Atomics.wait(i32, statusIdx, STATUS_COMPLETE, 50);
  }
}
