/**
 * startHostClipboardCopyOut: the host clipboard write starts inside the
 * gesture and only completes with the guest's text; when the guest copies
 * nothing, the write rejects and the host clipboard is never written.
 */
import { describe, expect, it } from "vitest";
import {
  CopyOutFailure,
  startHostClipboardCopyOut,
} from "../src/input/clipboard-copy-out";
import type { GuestClipboardResult } from "../src/clipboard";

/** Resolves ClipboardItem data the way a browser does when it writes. */
class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

function fakeClipboard() {
  const written: string[] = [];
  let writeCalledSync = false;
  return {
    written,
    get writeCalledSync() { return writeCalledSync; },
    clipboard: {
      async write(items: ClipboardItem[]) {
        writeCalledSync = true;
        const blob = await (items[0] as unknown as FakeClipboardItem).items["text/plain"];
        written.push(await blob.text());
      },
      async writeText(text: string) { written.push(text); },
    },
  };
}

const deferred = () => {
  let resolve!: (r: GuestClipboardResult) => void;
  const promise = new Promise<GuestClipboardResult>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("startHostClipboardCopyOut", () => {
  it("starts the write in the gesture and fills it with the guest's text", async () => {
    const guest = deferred();
    const fake = fakeClipboard();
    const copied = startHostClipboardCopyOut(
      () => guest.promise,
      fake.clipboard,
      FakeClipboardItem as unknown as typeof ClipboardItem,
    );
    // Synchronously, before the guest has answered.
    expect(fake.writeCalledSync).toBe(true);
    guest.resolve({ ok: true, text: "guest ✓" });
    await expect(copied).resolves.toBe("guest ✓");
    expect(fake.written).toEqual(["guest ✓"]);
  });

  it("leaves the host clipboard untouched when the guest copies nothing", async () => {
    const fake = fakeClipboard();
    const copied = startHostClipboardCopyOut(
      async () => ({ ok: false, reason: "timeout" }),
      fake.clipboard,
      FakeClipboardItem as unknown as typeof ClipboardItem,
    );
    await expect(copied).rejects.toEqual(new CopyOutFailure("timeout"));
    expect(fake.written).toEqual([]);
  });

  it("falls back to writeText without ClipboardItem", async () => {
    const fake = fakeClipboard();
    const copied = startHostClipboardCopyOut(
      async () => ({ ok: true, text: "plain" }),
      { writeText: fake.clipboard.writeText },
      undefined,
    );
    await expect(copied).resolves.toBe("plain");
    expect(fake.written).toEqual(["plain"]);
  });

  it("reports a browser that refuses the write", async () => {
    const copied = startHostClipboardCopyOut(
      async () => ({ ok: true, text: "denied" }),
      { writeText: async () => { throw new Error("NotAllowedError"); } },
      undefined,
    );
    await expect(copied).rejects.toBeInstanceOf(CopyOutFailure);
    await expect(copied).rejects.toHaveProperty(
      "reason",
      "host clipboard write failed: NotAllowedError",
    );
  });
});
