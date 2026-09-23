import { expect, test } from "@playwright/test";
import {
  DinitBootStatusTracker,
  type DinitServiceCompletion,
} from "../pages/kandelo/kernel-host/dinit-boot-status";

test("successful dinit output satisfies service readiness", () => {
  const progress: string[] = [];
  const completions: DinitServiceCompletion[] = [];
  const tracker = new DinitBootStatusTracker(
    (message) => progress.push(message),
    (completion) => completions.push(completion),
  );

  tracker.observeProcessOutput("\x1b[32m[ OK ]\x1b[0m php-", "stdout");
  tracker.observeProcessOutput("fpm\r\n", "stdout");

  expect(tracker.hasSucceeded("php-fpm")).toBe(true);
  expect(tracker.hasFailed("php-fpm")).toBe(false);
  expect(progress).toEqual(["Starting php-fpm..."]);
  expect(completions).toEqual([
    { serviceName: "php-fpm", outcome: "succeeded" },
  ]);
});

test("failed dinit output never satisfies service readiness", () => {
  const progress: string[] = [];
  const completions: DinitServiceCompletion[] = [];
  const tracker = new DinitBootStatusTracker(
    (message) => progress.push(message),
    (completion) => completions.push(completion),
  );

  tracker.observeProcessOutput("[FAILED] php-fpm\n", "stderr");

  expect(tracker.hasSucceeded("php-fpm")).toBe(false);
  expect(tracker.hasFailed("php-fpm")).toBe(true);
  expect(progress).toEqual(["Starting php-fpm..."]);
  expect(completions).toEqual([
    { serviceName: "php-fpm", outcome: "failed" },
  ]);
});
