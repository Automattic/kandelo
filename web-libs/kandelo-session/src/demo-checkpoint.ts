// "Save where I am" for machines that declare how — the inverse of ingest.
//
// The capability is declared in the VFS image (`/etc/kandelo/demo.json` →
// `checkpoint`) and executed here. Nothing in this module knows what a
// checkpoint contains or which program produces it: it runs the image's own
// capture command, takes that command's exit status as the only signal that
// a checkpoint exists, and reads the file the image named.
//
// A checkpoint is only half of "where I am": it is a state OF some content (a
// ROM, a save file, a document). `createCheckpointBootInputs` pairs the state
// with whatever names that content for a later boot, and refuses when nothing
// can — a state with the wrong content under it is worse than no link.

import { BootDescriptorError } from "./boot-descriptor";
import { createInlineBootInput } from "./boot-inputs";
import type { DemoCheckpointConfig } from "./demo-config";
import type { BootInput, KernelHost } from "./kernel-host";

export type CheckpointRejection =
  | "capture-failed"
  | "missing"
  | "empty"
  | "too-large"
  | "unshareable-content";

/** A rejection the UI is expected to show the user verbatim. */
export class CheckpointError extends Error {
  readonly reason: CheckpointRejection;
  constructor(reason: CheckpointRejection, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.reason = reason;
  }
}

export interface CaptureDemoCheckpointOptions {
  /** How long the capture command may run. Defaults to 15 seconds. */
  timeoutMs?: number;
}

type CheckpointHost = Pick<
  KernelHost,
  "runProgram" | "readFile" | "getDemoIngestSource"
>;

/**
 * Run the image's capture command and return the checkpoint it wrote.
 *
 * The command's exit status is the contract. Exit 0 means `capture.path` is a
 * complete checkpoint made in answer to this call; anything else means there
 * is none, and the file is not read even if one is lying there from before.
 */
export async function captureDemoCheckpoint(
  host: Pick<CheckpointHost, "runProgram" | "readFile">,
  checkpoint: DemoCheckpointConfig,
  options: CaptureDemoCheckpointOptions = {},
): Promise<Uint8Array> {
  const { argv, path, maxBytes } = checkpoint.capture;
  let status: number;
  try {
    status = await host.runProgram(argv, { timeoutMs: options.timeoutMs ?? 15_000 });
  } catch (err) {
    throw new CheckpointError(
      "capture-failed",
      `could not run ${argv[0]}: ${errorText(err)}`,
    );
  }
  if (status !== 0) {
    throw new CheckpointError(
      "capture-failed",
      `${argv[0]} exited with status ${status}; no checkpoint was taken`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await host.readFile(path);
  } catch (err) {
    throw new CheckpointError(
      "missing",
      `${argv[0]} reported success but ${path} could not be read: ${errorText(err)}`,
    );
  }
  if (bytes.byteLength === 0) {
    throw new CheckpointError("empty", `${path} is empty`);
  }
  if (bytes.byteLength > maxBytes) {
    throw new CheckpointError(
      "too-large",
      `the checkpoint is ${bytes.byteLength} bytes; this machine allows ${maxBytes}`,
    );
  }
  return Uint8Array.from(bytes);
}

/**
 * The boot inputs that put a later machine back where this one is: the
 * checkpoint, plus whatever names the content it belongs to.
 *
 * `bootInputs` are the inputs this machine itself booted with. They are kept
 * only while nothing has been ingested since boot, because only then is the
 * machine still running what they delivered.
 */
export async function createCheckpointBootInputs(
  host: CheckpointHost,
  checkpoint: DemoCheckpointConfig,
  bootInputs: readonly BootInput[] = [],
  options: CaptureDemoCheckpointOptions = {},
): Promise<BootInput[]> {
  const source = host.getDemoIngestSource();
  if (source?.kind === "upload") {
    // Refuse before capturing: there is nothing useful to do with the state.
    throw new CheckpointError(
      "unshareable-content",
      `${source.name || "The loaded file"} came from this device, so a link ` +
      "cannot name it and a checkpoint of it would restore onto something else.",
    );
  }
  const content = source?.kind === "input"
    ? [source.input]
    : bootInputs.filter((input) => input.id !== checkpoint.inputId);
  if (content.some((input) => input.id === checkpoint.inputId)) {
    throw new CheckpointError(
      "unshareable-content",
      `the loaded content uses the checkpoint's own input id "${checkpoint.inputId}"`,
    );
  }

  const bytes = await captureDemoCheckpoint(host, checkpoint, options);
  let state: BootInput;
  try {
    state = await createInlineBootInput({
      id: checkpoint.inputId,
      filename: checkpoint.filename,
      bytes,
      compression: "gzip",
    });
  } catch (err) {
    // The link carries the checkpoint itself, so a URL-sized cap applies to
    // it compressed. Say so in those terms instead of the codec's.
    if (err instanceof BootDescriptorError && err.code === "E_INLINE_TOO_LARGE") {
      throw new CheckpointError(
        "too-large",
        `this checkpoint is too large for a link: ${err.message}`,
      );
    }
    throw err;
  }
  return [...content.map((input) => structuredClone(input)), state];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
