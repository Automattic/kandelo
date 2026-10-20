import type { RandomProvider } from "../vfs/types";
import type { ReplicationGuestPid } from "./clock";
import type {
  ReplicationLogReader,
  ReplicationLogRecorder,
} from "./log";

/**
 * The guest's randomness, taken from the log instead of from the host.
 *
 * Random bytes diverge two computers the way clock readings do, and then
 * harder: a draw lands in guest memory, so a session key or a hash seed
 * derived from it steers every branch after it. Both wrappers below sit at
 * the one interface every guest draw already crosses, `RandomProvider` —
 * the `getrandom` syscall and the `/dev/urandom` device both pull from it —
 * so no syscall path or device has to know which mode it is in.
 */

/** Delegate to the host's randomness, and record what the guest was handed. */
export class RecordingRandomProvider implements RandomProvider {
  readonly #source: RandomProvider;
  readonly #recorder: ReplicationLogRecorder;
  readonly #pid: ReplicationGuestPid;

  constructor(
    source: RandomProvider,
    recorder: ReplicationLogRecorder,
    pid: ReplicationGuestPid,
  ) {
    this.#source = source;
    this.#recorder = recorder;
    this.#pid = pid;
  }

  getRandomBytes(length: number): Uint8Array {
    const bytes = this.#source.getRandomBytes(length);
    // A copy, because the log outlives the caller's use of the draw and a
    // recorded view a caller later wrote into would rewrite history.
    this.#recorder.record({
      kind: "random",
      pid: this.#pid(),
      bytes: bytes.slice(),
    });
    return bytes;
  }
}

/** Serve the recorded draws, and refuse to invent one. */
export class ReplayingRandomProvider implements RandomProvider {
  readonly #reader: ReplicationLogReader;
  readonly #pid: ReplicationGuestPid;

  constructor(reader: ReplicationLogReader, pid: ReplicationGuestPid) {
    this.#reader = reader;
    this.#pid = pid;
  }

  getRandomBytes(length: number): Uint8Array {
    // A copy for the same reason the recording keeps one: the log's bytes
    // are the recording, and a caller that wrote into them would hand the
    // next replica of this log a different machine.
    return this.#reader.takeRandom(this.#pid(), length).slice();
  }
}
