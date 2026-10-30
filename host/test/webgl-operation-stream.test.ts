import { expect, it, vi } from "vitest";
import { GlOperationStream, GlOperationTicket, type GlOperationKind } from "../src/webgl/operation-stream.js";

it("keeps accepted commands before every immediate-result operation family", () => {
  const stream = new GlOperationStream(), command = stream.reserve("commands")!;
  const kinds: Exclude<GlOperationKind,"commands">[] = ["query","fence-create","fence-status","fence-release","present","make-current"];
  for (const kind of kinds) expect(stream.tryBeginImmediate(kind)).toBeNull();
  expect(stream.pending).toBe(1);
  expect(command.start()).toBe(true);
  for (const kind of kinds) expect(stream.tryBeginImmediate(kind)).toBeNull();
  command.finish();
  for (const kind of kinds) {
    const operation = stream.tryBeginImmediate(kind)!;
    expect(operation.kind).toBe(kind); expect(operation.sequence).toBeGreaterThan(command.sequence);
    expect(stream.pending).toBe(1); operation.finish();
  }
  expect(stream.pending).toBe(0);
});

it("cancelled followers cannot bypass an active head and foreign tickets grant no authority", () => {
  const stream = new GlOperationStream(), head = stream.reserve("commands")!, next = stream.reserve("commands")!;
  expect(next.start()).toBe(false); expect(head.start()).toBe(true);
  expect(head.cancel()).toBe(false); expect(next.cancel()).toBe(true);
  const foreign = new GlOperationTicket(stream,"query",head.sequence);
  expect(foreign.start()).toBe(false); foreign.finish(); expect(foreign.cancel()).toBe(false);
  expect(stream.pending).toBe(2);
  head.finish(); expect(stream.pending).toBe(0);
  head.finish(); expect(stream.pending).toBe(0);
});

it("closing a session cancels queued authority without cancelling an active caller", () => {
  const stream = new GlOperationStream(), active = stream.tryBeginImmediate("query")!, queued = stream.reserve("commands")!;
  stream.close(); expect(queued.start()).toBe(false); expect(active.cancel()).toBe(false);
  expect(stream.reserve("commands")).toBeNull(); expect(stream.tryBeginImmediate("present")).toBeNull();
  active.finish(); expect(stream.pending).toBe(0);
});


it("distinguishes busy, closed, exhaustion and allocation refusal before immediate effects",()=>{
  const stream=new GlOperationStream(), prefix=stream.reserve("commands")!;
  expect(stream.tryBeginImmediateTyped("query")).toEqual({state:"busy"});prefix.cancel();
  const reserve=vi.spyOn(stream,"reserve").mockReturnValueOnce(null);
  expect(stream.tryBeginImmediateTyped("query")).toEqual({state:"allocation-failure"});reserve.mockRestore();
  (stream as unknown as {serial:number}).serial=Number.MAX_SAFE_INTEGER;
  expect(stream.tryBeginImmediateTyped("query")).toEqual({state:"exhausted"});stream.close();
  expect(stream.tryBeginImmediateTyped("query")).toEqual({state:"closed"});
});
