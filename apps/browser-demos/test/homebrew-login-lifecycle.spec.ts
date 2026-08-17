import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

import { appendProcessTreeRssSample } from "../../../scripts/measure-homebrew-vfork-rss";
import {
  projectHomebrewGuestLifecycleBrowserFixture,
  type HomebrewGuestLifecycleBrowserFixture,
} from "../../../homebrew/test/homebrew_guest_lifecycle_browser_fixture";

declare global {
  interface Window {
    __homebrewVfsTestReady: boolean;
    __runHomebrewGuestCoreShippingProof: (
      fixture: HomebrewGuestLifecycleBrowserFixture,
    ) => Promise<{ coreRevision: string; completedUrls: string[] }>;
    __homebrewLoginProductPhase: string;
    __ackHomebrewLoginProductPhase: () => void;
    __runHomebrewLoginProductLifecycle: (
      fixture: HomebrewGuestLifecycleBrowserFixture,
    ) => Promise<{ markers: string[] }>;
  }
}

const FIXTURE_ENV = "KANDELO_HOMEBREW_GUEST_BROWSER_LIFECYCLE_FIXTURE_PATH";
const RSS_ENV = "KANDELO_LOGIN_RSS_REPORT_PATH";
const BROWSER_IDENTITY_ENV = "KANDELO_LOGIN_BROWSER_IDENTITY_PATH";

test("the ABI 43 login product installs and executes through stock Homebrew", async ({
  page,
  baseURL,
  browserName,
  browser,
}) => {
  const fixturePath = process.env[FIXTURE_ENV];
  if (fixturePath === undefined)
    test.skip(true, "exact local product fixture is not configured");
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const fixture = projectHomebrewGuestLifecycleBrowserFixture(
    JSON.parse(readFileSync(resolve(fixturePath!), "utf8")),
  );
  if (fixture.loginProduct === undefined) {
    throw new Error("exact login product composition report is not configured");
  }
  test.setTimeout(
    fixture.timeoutMs * (browserName === "chromium" ? 3 : 1) + 180_000,
  );

  const rssPath = process.env[RSS_ENV];
  const chromiumPid =
    browserName === "chromium" && rssPath !== undefined
      ? findChromiumProcessRoot()
      : undefined;
  const sample = (phase: string): void => {
    if (rssPath === undefined || chromiumPid === undefined) return;
    appendProcessTreeRssSample({
      phase,
      roots: new Map([["chromium", chromiumPid]]),
      out: rssPath,
    });
  };

  await page.goto(new URL("/pages/homebrew-vfs-test/", baseURL).href);
  await expect
    .poll(() => page.evaluate(() => window.__homebrewVfsTestReady), {
      timeout: 120_000,
    })
    .toBe(true);
  const proof = page.evaluate(
    (exactFixture) => window.__runHomebrewLoginProductLifecycle(exactFixture),
    fixture,
  );
  for (const phase of [
    "before-boot",
    "before-ruby",
    "peak",
    "after-child-reaping",
    "after-three-repetitions",
  ]) {
    await expect
      .poll(() => page.evaluate(() => window.__homebrewLoginProductPhase), {
        timeout: 180_000,
      })
      .toBe(phase);
    sample(phase);
    await page.evaluate(() => window.__ackHomebrewLoginProductPhase());
  }
  const result = await proof;
  expect(result.markers).toEqual(
    expect.arrayContaining([
      "automatic-maker-login-ok",
      "maker-id-ok",
      "sudo-list-ok",
      "sudo-id-ok",
      "failed-sudo-password-ok",
      "ordinary-login-ok",
      "nosuid-copy-rejected",
      "ruby-child-3-reaped",
      "ruby-stock-tools-ok",
      "brew-tap-install-execute-ok",
    ]),
  );
  const identityPath = process.env[BROWSER_IDENTITY_ENV];
  if (identityPath === undefined) {
    throw new Error("exact browser identity report path is not configured");
  }
  recordBrowserIdentity(identityPath, {
    project: browserName,
    version: browser.version(),
    userAgent: await page.evaluate(() => navigator.userAgent),
  });
});

function recordBrowserIdentity(
  pathValue: string,
  identity: { project: string; version: string; userAgent: string },
): void {
  const path = resolve(pathValue);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("browser identity report must not be a symbolic link");
  }
  const document = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : {
        schema: 1,
        provenance: {
          schema: 1,
          provenance_kind: "local-test",
          promotable: false,
          published: false,
        },
        browsers: [],
      };
  if (
    document.schema !== 1 ||
    document.provenance?.provenance_kind !== "local-test" ||
    document.provenance?.promotable !== false ||
    document.provenance?.published !== false ||
    !Array.isArray(document.browsers) ||
    !/^(chromium|firefox|webkit)$/.test(identity.project) ||
    identity.version.length === 0 ||
    identity.userAgent.length === 0 ||
    document.browsers.some(
      (entry: { project?: unknown }) => entry.project === identity.project,
    )
  ) {
    throw new Error("browser identity report or engine identity is invalid");
  }
  document.browsers.push(identity);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
}

function findChromiumProcessRoot(): number {
  const ps = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
  if (!existsSync(ps)) {
    throw new Error(`required process inventory tool is unavailable: ${ps}`);
  }
  const rows = execFileSync(ps, ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*([0-9]+)\s+([0-9]+)\s+(.*)$/.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              command: match[3]!,
            },
          ]
        : [];
    });
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const isDescendant = (pid: number): boolean => {
    const seen = new Set<number>();
    for (let current = pid; current > 1 && !seen.has(current);) {
      if (current === process.ppid || current === process.pid) return true;
      seen.add(current);
      current = byPid.get(current)?.ppid ?? 0;
    }
    return false;
  };
  const candidates = rows.filter(
    (row) =>
      isDescendant(row.pid) &&
      /(?:^|\/)(?:chrome|chromium)(?:\s|$)/i.test(row.command) &&
      !row.command.includes("--type="),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `expected one Chromium browser root, found ${candidates.length}`,
    );
  }
  return candidates[0]!.pid;
}
