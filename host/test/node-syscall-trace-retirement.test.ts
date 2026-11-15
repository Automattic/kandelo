import {afterEach,expect,it,vi} from "vitest";
import {NodeKernelHost} from "../src/node-kernel-host";

afterEach(()=>vi.useRealTimers());
it("destroy cancels trace polling even before a worker starts",async()=>{
  vi.useFakeTimers();
  const host=new NodeKernelHost();
  // The transport is not under test; no real worker or guest memory exists.
  (host as unknown as {worker:{postMessage:()=>void}}).worker={postMessage:vi.fn()};
  host.subscribeSyscalls(()=>{});
  expect(vi.getTimerCount()).toBe(1);
  await host.destroy();
  expect(vi.getTimerCount()).toBe(0);
});
