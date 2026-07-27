import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import { zipSync, type Zippable } from "fflate";

import { ABI_VERSION } from "../../../host/src/generated/abi";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  derivePackageDeferredZipTree,
  materializePackageDeferredZipTree,
  registerPackageDeferredZipTree,
  type PackageDeferredZipTreeSpec,
} from "../../../host/src/vfs/package-deferred-tree";

const here = dirname(fileURLToPath(import.meta.url));
const workerModulePath = resolve(
  here,
  "fixtures/package-deferred-tree-worker.ts",
);

interface BrowserPackageTreeResult {
  before: {
    data: PathSnapshot;
    executable: PathSnapshot;
    directory: PathSnapshot;
  };
  after: {
    data: PathSnapshot;
    executable: PathSnapshot;
    directory: PathSnapshot;
  };
  names: string[];
  prepared: boolean;
  text: string;
  pendingTrees: number;
}

interface BrowserAtomicTreeResult {
  exportBlockedBeforeVerification: boolean;
  deferredBefore: {
    first: boolean;
    second: boolean;
  };
  verifiedPendingTrees: number;
  prepared: boolean;
  firstText: string;
  secondText: string;
  deferredAfter: {
    first: boolean;
    second: boolean;
  };
  pendingTrees: number;
}

interface PathSnapshot {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  deferred: boolean;
}

function unixZipEntry(bytes: Uint8Array, mode: number): Zippable[string] {
  return [bytes, { os: 3, attrs: ((mode << 16) >>> 0) }];
}

async function packageTreeImages(): Promise<{
  archive: Uint8Array;
  lazy: Uint8Array;
  eager: Uint8Array;
}> {
  const archive = zipSync({
    "bin/": unixZipEntry(new Uint8Array(), 0o040700),
    "bin/tool": unixZipEntry(
      new TextEncoder().encode("#!/bin/package-tool\n"),
      0o100711,
    ),
    "share/": unixZipEntry(new Uint8Array(), 0o040777),
    "share/runtime.txt": unixZipEntry(
      new TextEncoder().encode("browser package tree\n"),
      0o100600,
    ),
  } satisfies Zippable);
  const spec = {
    schema: 1,
    kind: "kandelo-package-deferred-zip-tree",
    id: "browser/package-tree",
    content_role: "runtime-tree",
    package: {
      name: "browser-package-tree",
      output: "browser-package-tree.zip",
    },
    archive: {
      url: "browser-package-tree.zip",
      mode_policy: "portable-posix-v1",
    },
    mount_prefix: "/opt/browser-package-tree",
    owner: {
      uid: 1000,
      gid: 1000,
    },
    activation: {
      mode: "first-use",
      capabilities: ["package:browser-test"],
      roots: ["/opt/browser-package-tree/bin/tool"],
    },
  } as const satisfies PackageDeferredZipTreeSpec;
  const derived = derivePackageDeferredZipTree(spec, archive);
  const createFs = () => {
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(1024 * 1024),
    );
    fs.setImageMetadata({ version: 1, kernelAbi: ABI_VERSION });
    return fs;
  };

  const lazyFs = createFs();
  registerPackageDeferredZipTree(lazyFs, derived);

  const eagerFs = createFs();
  const registered = registerPackageDeferredZipTree(eagerFs, derived);
  await materializePackageDeferredZipTree(eagerFs, registered, archive);

  return {
    archive,
    lazy: await lazyFs.saveImage(),
    eager: await eagerFs.saveImage(),
  };
}

async function atomicPackageTreeImage(): Promise<{
  firstArchive: Uint8Array;
  secondArchive: Uint8Array;
  image: Uint8Array;
  paths: {
    first: string;
    second: string;
  };
}> {
  const memberSpecs = [
    {
      member: "first",
      output: "browser-atomic-first.zip",
      mountPrefix: "/opt/browser-atomic-first",
      text: "first browser cohort\n",
    },
    {
      member: "second",
      output: "browser-atomic-second.zip",
      mountPrefix: "/opt/browser-atomic-second",
      text: "second browser cohort\n",
    },
  ] as const;
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
  fs.setImageMetadata({ version: 1, kernelAbi: ABI_VERSION });
  const archives: Uint8Array[] = [];
  const members: string[] = [];
  const paths: string[] = [];
  for (const memberSpec of memberSpecs) {
    const archive = zipSync({
      "share/": unixZipEntry(new Uint8Array(), 0o040755),
      "share/value.txt": unixZipEntry(
        new TextEncoder().encode(memberSpec.text),
        0o100644,
      ),
    } satisfies Zippable);
    const spec = {
      schema: 1,
      kind: "kandelo-package-deferred-zip-tree",
      id: `browser/atomic-${memberSpec.member}`,
      content_role: "runtime-tree",
      package: {
        name: `browser-atomic-${memberSpec.member}`,
        output: memberSpec.output,
      },
      archive: {
        url: memberSpec.output,
        mode_policy: "portable-posix-v1",
      },
      mount_prefix: memberSpec.mountPrefix,
      owner: {
        uid: 1000,
        gid: 1000,
      },
      activation: {
        mode: "first-use",
        capabilities: [`package:browser-atomic-${memberSpec.member}`],
        roots: [`${memberSpec.mountPrefix}/share/value.txt`],
      },
    } as const satisfies PackageDeferredZipTreeSpec;
    const derived = derivePackageDeferredZipTree(spec, archive);
    fs.registerLazyTree(
      derived.content,
      derived.entries,
      derived.descriptor.mount_prefix,
      {
        ...derived.descriptor.activation,
        atomicGroup: {
          id: "browser:atomic-package",
          member: memberSpec.member,
        },
      },
      derived.descriptor.owner,
    );
    archives.push(archive);
    members.push(memberSpec.member);
    paths.push(`${memberSpec.mountPrefix}/share/value.txt`);
  }
  await fs.sealLazyAtomicGroup("browser:atomic-package", members);
  return {
    firstArchive: archives[0]!,
    secondArchive: archives[1]!,
    image: await fs.saveImage(),
    paths: {
      first: paths[0]!,
      second: paths[1]!,
    },
  };
}

async function runPackageTreeWorker(
  page: Page,
  workerUrl: string,
  image: Uint8Array,
  lazyUrlBase: string,
  atomicPaths?: { first: string; second: string },
): Promise<unknown> {
  return page.evaluate(
    ({ workerUrl, image, lazyUrlBase, atomicPaths }) => {
      return new Promise<unknown>((resolve, reject) => {
        const worker = new Worker(workerUrl, { type: "module" });
        worker.onmessage = (event) => {
          worker.terminate();
          if (event.data?.ok === true) {
            resolve(event.data.result);
          } else {
            reject(new Error(event.data?.error ?? "package-tree worker failed"));
          }
        };
        worker.onerror = (event) => {
          worker.terminate();
          reject(new Error(event.message || "package-tree worker crashed"));
        };
        worker.postMessage({ image, lazyUrlBase, atomicPaths });
      });
    },
    {
      workerUrl,
      image: Array.from(image),
      lazyUrlBase,
      atomicPaths,
    },
  );
}

async function inspectPackageTreeInBrowser(
  page: Page,
  workerUrl: string,
  image: Uint8Array,
  lazyUrlBase: string,
): Promise<BrowserPackageTreeResult> {
  return await runPackageTreeWorker(
    page,
    workerUrl,
    image,
    lazyUrlBase,
  ) as BrowserPackageTreeResult;
}

async function inspectAtomicTreeInBrowser(
  page: Page,
  workerUrl: string,
  image: Uint8Array,
  lazyUrlBase: string,
  paths: { first: string; second: string },
): Promise<BrowserAtomicTreeResult> {
  return await runPackageTreeWorker(
    page,
    workerUrl,
    image,
    lazyUrlBase,
    paths,
  ) as BrowserAtomicTreeResult;
}

test("browsers retry transient lazy package trees and consume the exact ZIP", async ({
  page,
  baseURL,
  browserName,
}) => {
  expect(baseURL).toBeTruthy();
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const workerUrl = new URL(`/@fs${workerModulePath}`, baseURL).href;
  const archiveUrl = new URL(
    "/package-assets/browser-package-tree.zip",
    baseURL,
  ).href;
  const lazyUrlBase = new URL("/package-assets/", baseURL).href;
  const images = await packageTreeImages();
  let archiveFetches = 0;
  await page.route(archiveUrl, async (route) => {
    archiveFetches++;
    if (archiveFetches === 1) {
      await route.fulfill({
        status: 502,
        body: "temporary package release edge failure",
        headers: { "retry-after": "0" },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      body: Buffer.from(images.archive),
      headers: {
        "content-length": String(images.archive.byteLength),
        "content-type": "application/zip",
      },
    });
  });
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const lazy = await inspectPackageTreeInBrowser(
    page,
    workerUrl,
    images.lazy,
    lazyUrlBase,
  );
  expect(lazy.before, browserName).toEqual({
    data: {
      mode: 0o644,
      uid: 1000,
      gid: 1000,
      size: 21,
      deferred: true,
    },
    executable: {
      mode: 0o755,
      uid: 1000,
      gid: 1000,
      size: 20,
      deferred: true,
    },
    directory: {
      mode: 0o755,
      uid: 1000,
      gid: 1000,
      size: 44,
      deferred: false,
    },
  });
  expect(lazy.names, browserName).toEqual([".", "..", "runtime.txt"]);
  expect(lazy.prepared, browserName).toBe(true);
  expect(lazy.text, browserName).toBe("browser package tree\n");
  expect(lazy.after.data.deferred, browserName).toBe(false);
  expect(lazy.after.executable.deferred, browserName).toBe(false);
  expect(lazy.pendingTrees, browserName).toBe(0);
  expect(archiveFetches, browserName).toBe(2);

  const eager = await inspectPackageTreeInBrowser(
    page,
    workerUrl,
    images.eager,
    lazyUrlBase,
  );
  expect(eager.before, browserName).toEqual(lazy.after);
  expect(eager.names, browserName).toEqual(lazy.names);
  expect(eager.prepared, browserName).toBe(false);
  expect(eager.text, browserName).toBe(lazy.text);
  expect(eager.after, browserName).toEqual(lazy.after);
  expect(eager.pendingTrees, browserName).toBe(0);
  expect(archiveFetches, browserName).toBe(2);
});

test("browsers verify imported seals before atomically activating package trees", async ({
  page,
  baseURL,
  browserName,
}) => {
  expect(baseURL).toBeTruthy();
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const workerUrl = new URL(`/@fs${workerModulePath}`, baseURL).href;
  const lazyUrlBase = new URL("/package-assets/", baseURL).href;
  const fixture = await atomicPackageTreeImage();
  const archiveUrls = [
    new URL("/package-assets/browser-atomic-first.zip", baseURL).href,
    new URL("/package-assets/browser-atomic-second.zip", baseURL).href,
  ];
  const archives = [fixture.firstArchive, fixture.secondArchive];
  const fetches = [0, 0];
  for (let index = 0; index < archiveUrls.length; index++) {
    await page.route(archiveUrls[index]!, async (route) => {
      fetches[index]++;
      await route.fulfill({
        status: 200,
        body: Buffer.from(archives[index]!),
        headers: {
          "content-length": String(archives[index]!.byteLength),
          "content-type": "application/zip",
        },
      });
    });
  }
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await inspectAtomicTreeInBrowser(
    page,
    workerUrl,
    fixture.image,
    lazyUrlBase,
    fixture.paths,
  );
  expect(result.exportBlockedBeforeVerification, browserName).toBe(true);
  expect(result.deferredBefore, browserName).toEqual({
    first: true,
    second: true,
  });
  expect(result.verifiedPendingTrees, browserName).toBe(2);
  expect(result.prepared, browserName).toBe(true);
  expect(result.firstText, browserName).toBe("first browser cohort\n");
  expect(result.secondText, browserName).toBe("second browser cohort\n");
  expect(result.deferredAfter, browserName).toEqual({
    first: false,
    second: false,
  });
  expect(result.pendingTrees, browserName).toBe(0);
  expect(fetches, browserName).toEqual([1, 1]);
});
