/**
 * A browser gamepad reaches a guest as a hot-plugged evdev device through
 * the real path: `navigator.getGamepads()` → `BrowserGamepadSource` (polled
 * on animation frames) → `BrowserKernel.connectInputDevice` → kernel worker
 * → `/dev/input/event2`. Only the Gamepad API is stubbed, because a test
 * browser has no pad attached; `input-gamepad-smoke` observes the device
 * with ordinary syscalls. The Node host's counterpart is
 * host/test/input-hotplug-evdev.test.ts.
 */
import { expect, test } from "../playwright-test";
import { buildProgramsFixture, requireBuiltFixtures } from "./support/program-fixtures";
import { readFileSync } from "node:fs";

const fixture = buildProgramsFixture("programs/wasm32/input-gamepad-smoke.wasm");

test.beforeAll(() => requireBuiltFixtures([fixture]));

const EV_SYN = 0, EV_KEY = 1, EV_ABS = 3;
const BTN_A = 0x130, ABS_X = 0;
const ENODEV = 19, ENOENT = 2;

test("a standard gamepad appears, reports, and hangs up as /dev/input/event2", async ({
  page,
  baseURL,
}) => {
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  // The only stub: what the browser would report for one standard pad.
  await page.evaluate(() => {
    const w = window as any;
    w.__pads = [];
    w.__setPad = (pressed: number[], axes: number[]) => {
      w.__pads = [{
        id: "Test Pad (STANDARD GAMEPAD)",
        index: 0,
        connected: true,
        mapping: "standard",
        timestamp: performance.now(),
        axes,
        buttons: Array.from({ length: 17 }, (_, i) => ({
          pressed: pressed.includes(i),
          touched: pressed.includes(i),
          value: pressed.includes(i) ? 1 : 0,
        })),
      }];
    };
    Object.defineProperty(Navigator.prototype, "getGamepads", {
      configurable: true,
      value: () => w.__pads,
    });
  });

  const bytes = Array.from(readFileSync(fixture));
  await page.evaluate((wasmBytes) => {
    const w = window as any;
    w.__gamepadRun = w.__runTest(
      new Uint8Array(wasmBytes).buffer,
      ["input-gamepad-smoke"],
      60_000,
      { gamepads: true },
    );
  }, bytes);
  const reached = (marker: string) =>
    page.waitForFunction(
      (m) => (window as any).__runningTestStdout().includes(m),
      marker,
      { timeout: 30_000 },
    );

  await reached("READY:connect\n");
  // A browser reveals a pad on its first button press, then fires this.
  await page.evaluate(() => {
    (window as any).__setPad([], [0.5, 0, 0, 0]);
    window.dispatchEvent(new Event("gamepadconnected"));
  });

  await reached("READY:events\n");
  await page.evaluate(() => (window as any).__setPad([0], [-1, 0, 0, 0]));

  await reached("READY:disconnect\n");
  await page.evaluate(() => { (window as any).__pads = []; });

  const result = await page.evaluate(() => (window as any).__gamepadRun);
  const out: string = result.stdout;
  expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);

  expect(out).toContain("before_nodes=event0,event1,\n");
  expect(out).toContain("connected_nodes=event0,event1,event2,\n");
  expect(out).toContain("disconnected_nodes=event0,event1,\n");
  expect(out).toContain("name=Test Pad (STANDARD GAMEPAD)\n");
  expect(out).toContain("id=0006:1209:0003:0001\n");
  expect(out).toContain("keys a=1 b=1 x=1 y=1 start=1 left=0\n");
  expect(out).toContain("abs_x value=16384 min=-32768 max=32767 fuzz=16 flat=128\n");
  expect(out).toContain(`ev0 type=${EV_KEY} code=${BTN_A} value=1\n`);
  expect(out).toContain(`ev1 type=${EV_ABS} code=${ABS_X} value=-32768\n`);
  expect(out).toContain(`ev2 type=${EV_SYN} code=0 value=0\n`);
  expect(out).toContain("pressed a=1 b=0\n");
  expect(out).toContain("poll ready=1 hup=1 err=1\n");
  expect(out).toContain(`read_after n=-1 errno=${ENODEV}\n`);
  expect(out).toContain(`reopen fd=-1 errno=${ENOENT}\n`);
});
