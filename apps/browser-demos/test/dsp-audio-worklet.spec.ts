import { expect, test } from "@playwright/test";

type AudioSnapshot = {
  audioState: string;
  audioStates: string[];
  workletAssetUrl: string;
  workletPrepared: boolean;
  producerBytes: number;
  consumerBytes: number;
  discardBytes: number;
  queuedBytes: number;
  activeCapacityBytes: number;
  settled: boolean;
  resumeAttempts: number;
  trustedResumeAttempts: number;
  lastResumeError: string | null;
  stdout: string;
  stderr: string;
  hostDiagnostics: string[];
};

type AudioResult = AudioSnapshot & {
  exitCode: number;
  elapsedMs: number;
};

test("the production AudioWorklet drains /dev/dsp after a trusted resume", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  expect(baseURL).toBeTruthy();

  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });

  await page.goto(new URL("/pages/test-runner/", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);

  try {
    const programUrl = await page.evaluate(
      () => (window as any).__audioTestProgramUrl as string,
    );
    const initial = await page.evaluate(async ({ programUrl }): Promise<AudioSnapshot> => {
      const response = await fetch(programUrl);
      if (!response.ok) {
        throw new Error(`audiotest fetch failed: ${response.status} ${response.url}`);
      }
      return (window as any).__prepareAudioTest(
        await response.arrayBuffer(),
        ["audiotest"],
        30_000,
      );
    }, { programUrl });

    expect(initial.workletPrepared).toBe(true);
    expect(initial.audioState).toBe("suspended");
    expect(initial.activeCapacityBytes).toBeGreaterThan(0);
    const workletAsset = await page.evaluate(async (url) => {
      const response = await fetch(url, { cache: "no-store" });
      return {
        status: response.status,
        url: response.url,
        source: await response.text(),
      };
    }, initial.workletAssetUrl);
    expect(workletAsset.status, workletAsset.url).toBe(200);
    expect(workletAsset.source).toContain("kandelo-pcm-output");
    expect(workletAsset.source).toContain("registerProcessor");

    // The guest writes its deterministic buffer, then close(SYNC) must remain
    // blocked while the AudioContext clock is suspended. No timer-based or
    // instantaneous host drain is allowed to move the consumer cursor.
    await expect.poll(
      () => page.evaluate((): AudioSnapshot => (window as any).__audioTestSnapshot()),
      { timeout: 15_000 },
    ).toMatchObject({
      audioState: "suspended",
      settled: false,
      stdout: expect.stringContaining("wrote 256"),
    });
    const queued = await page.evaluate(
      (): AudioSnapshot => (window as any).__audioTestSnapshot(),
    );
    expect(queued.producerBytes).toBeGreaterThan(queued.consumerBytes);
    expect(queued.queuedBytes).toBe(256);

    await page.waitForTimeout(250);
    const held = await page.evaluate(
      (): AudioSnapshot => (window as any).__audioTestSnapshot(),
    );
    expect(held.consumerBytes).toBe(queued.consumerBytes);
    expect(held.queuedBytes).toBe(queued.queuedBytes);
    expect(held.settled).toBe(false);

    // Playwright's physical click dispatches a trusted event. The page's click
    // handler calls BrowserKernel.resumeAudio() directly in that activation.
    await page.getByRole("button", { name: "Resume audio" }).click();
    await expect.poll(
      () => page.evaluate((): AudioSnapshot => (window as any).__audioTestSnapshot()),
      { timeout: 10_000 },
    ).toMatchObject({
      audioState: "running",
      resumeAttempts: 1,
      trustedResumeAttempts: 1,
      lastResumeError: null,
    });

    const result = await page.evaluate(
      (): Promise<AudioResult> => (window as any).__waitForAudioTest(),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "ready 44100 2",
      "wrote 256",
    ]);
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
    expect(result.producerBytes).toBeGreaterThan(0);
    expect(result.consumerBytes).toBe(result.producerBytes);
    expect(result.queuedBytes).toBe(0);
    expect(result.settled).toBe(true);

    // Exercise the machine-level lifecycle once more after the clean drain:
    // suspension is observable, and a second trusted gesture restores the
    // same worklet-backed sink without rebuilding or replacing the transport.
    const suspended = await page.evaluate(
      (): Promise<AudioSnapshot> => (window as any).__suspendAudioTest(),
    );
    expect(suspended.audioState).toBe("suspended");
    await page.getByRole("button", { name: "Resume audio" }).click();
    await expect.poll(
      () => page.evaluate((): AudioSnapshot => (window as any).__audioTestSnapshot()),
      { timeout: 10_000 },
    ).toMatchObject({
      audioState: "running",
      resumeAttempts: 2,
      trustedResumeAttempts: 2,
      lastResumeError: null,
    });

    expect(runtimeErrors).toEqual([]);
  } finally {
    await page.evaluate(() => (window as any).__finishAudioTest?.()).catch(() => {});
  }
});
