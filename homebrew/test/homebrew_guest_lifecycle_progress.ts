const DEFAULT_MAX_PROGRESS_LINES = 64;
const DEFAULT_MAX_PROGRESS_LINE_CHARACTERS = 512;
const NODE_PROGRESS_PREFIX =
  "homebrew_guest_lifecycle_node: progress: ";

/**
 * Forward only the generated lifecycle's bounded progress protocol.
 *
 * Package-manager output remains in the bounded failure capture. Streaming
 * arbitrary guest output would let a noisy command create an unbounded CI log,
 * while buffering every line hides the active operation if the runner dies.
 */
export class BoundedHomebrewGuestProgress {
  readonly #write: (text: string) => void;
  readonly #maximumLines: number;
  readonly #maximumLineCharacters: number;
  readonly #decoder = new TextDecoder();
  #pending = "";
  #discardingLongLine = false;
  #emittedLines = 0;
  #reportedLimit = false;

  constructor(
    write: (text: string) => void,
    options: {
      maximumLines?: number;
      maximumLineCharacters?: number;
    } = {},
  ) {
    this.#write = write;
    this.#maximumLines =
      options.maximumLines ?? DEFAULT_MAX_PROGRESS_LINES;
    this.#maximumLineCharacters =
      options.maximumLineCharacters ??
        DEFAULT_MAX_PROGRESS_LINE_CHARACTERS;
    if (
      !Number.isSafeInteger(this.#maximumLines) ||
      this.#maximumLines < 1 ||
      !Number.isSafeInteger(this.#maximumLineCharacters) ||
      this.#maximumLineCharacters < 1
    ) {
      throw new Error("Homebrew progress bounds must be positive integers");
    }
  }

  push(bytes: Uint8Array): void {
    this.#consume(this.#decoder.decode(bytes, { stream: true }));
  }

  #consume(text: string): void {
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) break;
      this.#appendFragment(text.slice(start, newline), true);
      start = newline + 1;
    }
    this.#appendFragment(text.slice(start), false);
  }

  #appendFragment(fragment: string, complete: boolean): void {
    if (this.#discardingLongLine) {
      if (complete) this.#discardingLongLine = false;
      return;
    }
    if (
      this.#pending.length + fragment.length >
      this.#maximumLineCharacters
    ) {
      this.#pending = "";
      this.#discardingLongLine = !complete;
      return;
    }
    this.#pending += fragment;
    if (!complete) return;
    const line = this.#pending.endsWith("\r")
      ? this.#pending.slice(0, -1)
      : this.#pending;
    this.#pending = "";
    if (!isLifecycleProgressLine(line)) return;
    if (this.#emittedLines >= this.#maximumLines) {
      if (!this.#reportedLimit) {
        this.#reportedLimit = true;
        this.#write(
          `${NODE_PROGRESS_PREFIX}output limit reached\n`,
        );
      }
      return;
    }
    this.#emittedLines += 1;
    this.#write(`${NODE_PROGRESS_PREFIX}${line}\n`);
  }
}

function isLifecycleProgressLine(line: string): boolean {
  return line.startsWith("homebrew-guest-lifecycle: ") ||
    line.startsWith("homebrew-guest-lifecycle-reboot: ") ||
    /^KANDELO_HOMEBREW_GUEST_[A-Z0-9_]+$/.test(line);
}
