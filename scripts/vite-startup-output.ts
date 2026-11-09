import { stripVTControlCharacters } from "node:util";

/** Vite may color the label and split its escape sequences across writes.
 * Keep the bounded raw tail until stripping it: stripping individual chunks
 * loses a split escape sequence and can leave `Local[22m:` unrecognizable. */
export class ViteStartupOutput {
  private tail = "";
  private ready = false;
  constructor(private readonly limit = 65_536) {
    if (!Number.isSafeInteger(limit) || limit < 32 || limit > 65_536) {
      throw new Error("Vite startup output limit must be between32 and65536 characters");
    }
  }
  push(chunk: string): boolean {
    // Clip before concatenating so even one oversized log write cannot make
    // the accumulated history unbounded. Readiness stays true once observed.
    this.tail = (this.tail + chunk.slice(-this.limit)).slice(-this.limit);
    this.ready ||= stripVTControlCharacters(this.tail).includes("Local:");
    return this.ready;
  }
  get retainedCharacters(): number { return this.tail.length; }
}
