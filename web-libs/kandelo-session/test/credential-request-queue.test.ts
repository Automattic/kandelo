import { describe, expect, it, vi } from "vitest";
import { CredentialRequestQueue } from "../src/credential-request-queue";

const request = (pid: number) => ({
  pid,
  title: "Codex",
  program: "/usr/bin/codex",
  argv: ["codex"],
  parentChain: [],
  destinations: ["https://chatgpt.com"],
  imageSource: "Not an image this site ships: https://example.test/shell.vfs.zst",
  programChangedSinceBoot: false,
  enforcement: "proxy-gate" as const,
  transport: [{ kind: "proxy" as const, via: "https://proxy.example.test/cors", destinations: ["https://chatgpt.com"] }],
});

/** Records each settlement, so a second one would be visible. */
function track(promise: Promise<boolean>): boolean[] {
  const seen: boolean[] = [];
  void promise.then((allow) => seen.push(allow));
  return seen;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CredentialRequestQueue", () => {
  it("asks in arrival order and settles each question with its own answer", async () => {
    const queue = new CredentialRequestQueue();
    const first = queue.ask(request(1), { signal: new AbortController().signal });
    const second = queue.ask(request(2), { signal: new AbortController().signal });
    expect(queue.snapshot().map(({ request }) => request.pid)).toEqual([1, 2]);
    const [firstId, secondId] = queue.snapshot().map(({ id }) => id);
    queue.answer(firstId, true);
    expect(queue.snapshot().map(({ request }) => request.pid)).toEqual([2]);
    queue.answer(secondId, false);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it("settles each question exactly once", async () => {
    const queue = new CredentialRequestQueue();
    const kernel = new AbortController();
    const seen = track(queue.ask(request(1), { signal: kernel.signal }));
    const [{ id }] = queue.snapshot();
    queue.answer(id, true);
    queue.answer(id, false);
    kernel.abort();
    queue.close();
    await flush();
    expect(seen).toEqual([true]);
  });

  it("removes and denies a question whose signal aborts", async () => {
    const queue = new CredentialRequestQueue();
    const listener = vi.fn();
    queue.subscribe(listener);
    const kernel = new AbortController();
    const withdrawn = queue.ask(request(1), { signal: kernel.signal });
    const kept = queue.ask(request(2), { signal: new AbortController().signal });
    kernel.abort();
    await expect(withdrawn).resolves.toBe(false);
    expect(queue.snapshot().map(({ request }) => request.pid)).toEqual([2]);
    expect(listener).toHaveBeenCalledTimes(3);
    queue.answer(queue.snapshot()[0].id, true);
    await expect(kept).resolves.toBe(true);
  });

  it("denies at once a question already withdrawn", async () => {
    const queue = new CredentialRequestQueue();
    const kernel = new AbortController();
    kernel.abort();
    await expect(queue.ask(request(1), { signal: kernel.signal })).resolves.toBe(false);
    expect(queue.snapshot()).toEqual([]);
  });

  it("close() denies every open question", async () => {
    const queue = new CredentialRequestQueue();
    const answers = [1, 2, 3].map((pid) =>
      queue.ask(request(pid), { signal: new AbortController().signal })
    );
    queue.close();
    expect(queue.snapshot()).toEqual([]);
    await expect(Promise.all(answers)).resolves.toEqual([false, false, false]);
  });

  it("denyAll denies every waiting question and keeps asking later ones", async () => {
    const queue = new CredentialRequestQueue();
    const waiting = [1, 2, 3].map((pid) =>
      queue.ask(request(pid), { signal: new AbortController().signal })
    );
    queue.denyAll();
    expect(queue.snapshot()).toEqual([]);
    await expect(Promise.all(waiting)).resolves.toEqual([false, false, false]);
    const later = queue.ask(request(4), { signal: new AbortController().signal });
    const [{ id }] = queue.snapshot();
    queue.answer(id, true);
    await expect(later).resolves.toBe(true);
  });
});
