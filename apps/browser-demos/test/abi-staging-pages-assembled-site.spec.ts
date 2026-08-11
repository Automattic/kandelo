import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
} from "@playwright/test";

interface ProductObservation {
  id: string;
  load: "eager" | "lazy";
  path: string;
  vfs_bytes: number;
  vfs_sha256: string;
}

const expectedProducts = [
  ["browser-lamp", "lazy"],
  ["browser-main-shell", "eager"],
  ["browser-nginx", "lazy"],
  ["browser-nginx-php", "lazy"],
  ["browser-node", "lazy"],
  ["browser-wordpress", "lazy"],
  ["platform-rootfs", "eager"],
] as const;
const activationProfiles = [
  ["wordpress-mariadb", "browser-lamp"],
  ["nginx", "browser-nginx"],
  ["nginx-php", "browser-nginx-php"],
  ["node", "browser-node"],
  ["wordpress-sqlite", "browser-wordpress"],
] as const;
const eagerIds = ["browser-main-shell", "platform-rootfs"];
const siteRoot = exactSiteRoot(
  process.env.KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT,
);
const deployment = JSON.parse(
  readFileSync(
    resolve(siteRoot, ".well-known/kandelo/pages-deployment.json"),
    "utf8",
  ),
);
const abiSnapshot = JSON.parse(
  readFileSync(new URL("../../../abi/snapshot.json", import.meta.url), "utf8"),
);
const observations = validateObservationLedger(
  deployment,
  abiSnapshot.abi_version,
);
const byId = new Map(observations.map((product) => [product.id, product]));

test("boots the exact producer-returned seven-product tree with eager and lazy fetch discipline", async ({
  browser,
  request,
}, testInfo) => {
  const baseURL = String(testInfo.project.use.baseURL);
  await assertExactServedServiceWorker(request, baseURL);
  const allObserved = new Set<string>();

  const eager = await exerciseProfile(browser, baseURL, "shell");
  expect(eager.products.sort(), JSON.stringify(eager.ledger)).toEqual(
    [...eagerIds].sort(),
  );
  eager.products.forEach((id) => allObserved.add(id));

  for (const [profile, lazyId] of activationProfiles) {
    const run = await exerciseProfile(browser, baseURL, profile);
    expect(run.products.sort(), JSON.stringify(run.ledger)).toEqual(
      [...eagerIds, lazyId].sort(),
    );
    expect(
      run.ledger.starts
        .slice(0, 2)
        .map((entry: any) => entry.id)
        .sort(),
    ).toEqual([...eagerIds].sort());
    expect(run.ledger.starts.slice(2).map((entry: any) => entry.id)).toEqual([
      lazyId,
    ]);
    run.products.forEach((id) => allObserved.add(id));
  }

  expect([...allObserved].sort()).toEqual(
    expectedProducts.map(([id]) => id).sort(),
  );
});

async function assertExactServedServiceWorker(
  request: APIRequestContext,
  baseURL: string,
) {
  const expected = deployment.files.find(
    ({ path }: any) => path === "service-worker.js",
  );
  expect(expected).toBeDefined();
  const response = await request.get(
    new URL("service-worker.js", baseURL).href,
    {
      headers: { "Accept-Encoding": "identity" },
    },
  );
  expect(response.ok()).toBe(true);
  const body = await response.body();
  expect(body.byteLength).toBe(expected.bytes);
  expect(createHash("sha256").update(body).digest("hex")).toBe(expected.sha256);
}

test("sealed observation ledger rejects forbidden assembled-site identities", () => {
  const mutations: Array<[string, (value: any) => void]> = [
    [
      "extra product",
      (value) => value.products.push({ ...value.products[0], id: "extra" }),
    ],
    ["wrong load", (value) => (value.products[0].load = "eager")],
    ["duplicate rootfs", (value) => (value.products[0].id = "platform-rootfs")],
    ["legacy VFS path", (value) => (value.products[0].path = "/rootfs.vfs")],
    [
      "candidate VFS path",
      (value) => (value.products[0].path = "/candidates/product.vfs.zst"),
    ],
    [
      "prior ABI",
      (value) => (value.target_abi.version = abiSnapshot.abi_version - 1),
    ],
  ];
  for (const [label, mutate] of mutations) {
    const value = structuredClone(deployment);
    mutate(value);
    expect(
      () => validateObservationLedger(value, abiSnapshot.abi_version),
      label,
    ).toThrow();
  }
});

for (const mutation of ["corrupt", "wrong-length", "missing"] as const) {
  test(`canonical loader rejects ${mutation} producer VFS bytes`, async ({
    page,
  }) => {
    await page.context().addInitScript(instrumentSealedFetch, {
      mutation,
      products: observations,
      target: "platform-rootfs",
    });
    await page.goto("pages/kandelo/?demo=shell", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("LiveKernelHost setup failed")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("#kandelo-root pre")).toContainText(
      mutation === "corrupt"
        ? "SHA-256 differs"
        : mutation === "missing"
          ? "HTTP 404"
          : "length differs",
    );
  });
}

async function exerciseProfile(
  browser: Browser,
  baseURL: string,
  profile: string,
) {
  const context = await browser.newContext({ baseURL });
  const network = await enforceSealedNetworkAuthority(context, baseURL);
  await context.addInitScript(instrumentSealedFetch, {
    holdEager: true,
    mutation: null,
    products: observations,
    target: null,
  });
  const page = await context.newPage();
  try {
    const disabledGallery = encodeURIComponent(
      "/kandelo/.well-known/kandelo/task5-no-external-gallery.json",
    );
    const response = await page.goto(
      `pages/kandelo/?demo=${profile}&softwareManifest=${disabledGallery}`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    expect(response?.ok()).toBe(true);
    expect(response?.headers()["cross-origin-opener-policy"]).toBe(
      "same-origin",
    );
    expect(response?.headers()["cross-origin-embedder-policy"]).toBe(
      "require-corp",
    );
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as any).__KANDELO_TASK5_FETCH_LEDGER__?.starts.map(
              (entry: any) => entry.id,
            ) ?? [],
        ),
      )
      .toEqual(expect.arrayContaining(eagerIds));
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(() =>
        (window as any).__KANDELO_TASK5_FETCH_LEDGER__.starts.map(
          (entry: any) => entry.id,
        ),
      ),
    ).toHaveLength(eagerIds.length);
    // createLiveHost awaits both eager activations before it resolves the URL
    // descriptor, constructs LiveKernelHost, or starts the selected profile.
    // An empty React mount therefore observes the production pre-activation
    // boundary even though the untrusted query already names the later choice.
    expect(await page.locator("#kandelo-root").innerHTML()).toBe("");
    await page.evaluate(() =>
      (window as any).__KANDELO_TASK5_RELEASE_EAGER__(),
    );
    if (profile === "shell" || profile === "node") {
      await expect(
        page.locator(".kdock-status-text[data-status=running]"),
      ).toBeVisible({
        timeout: 60_000,
      });
    } else {
      // The bounded fixture replaces service payloads with one blocking SDK
      // process. Reaching the real BrowserKernel's post-spawn ready event is
      // the fixture's basic-boot boundary.
      // The level and message occupy adjacent spans, so Playwright's rendered
      // text observation intentionally has no separator between them.
      await expect(page.locator("main")).toContainText("infoready", {
        timeout: 60_000,
      });
    }
    expect(
      await page.evaluate(() => ({
        controlled: navigator.serviceWorker.controller !== null,
        isolated: window.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer,
      })),
    ).toEqual({
      controlled: true,
      isolated: true,
      sharedArrayBuffer: "function",
    });
    expect(await page.locator("body").innerText()).not.toContain(
      "LiveKernelHost setup failed",
    );
    const ledger = await page.evaluate(
      () => (window as any).__KANDELO_TASK5_FETCH_LEDGER__,
    );
    expect(ledger.external, "external window fetch attempt").toEqual([]);
    expect(
      network.external,
      "external browser/worker/service-worker request",
    ).toEqual([]);
    expect(
      network.unknownVfs,
      "unknown browser/worker/service-worker VFS request",
    ).toEqual([]);
    for (const entry of ledger.vfs) {
      const product = byId.get(entry.id)!;
      expect(entry.status, product.id).toBe(200);
      expect(entry.declared, product.id).toBe(product.vfs_bytes);
      expect(entry.bytes, product.id).toBe(product.vfs_bytes);
      expect(entry.sha256, product.id).toBe(product.vfs_sha256);
    }
    return {
      ledger,
      products: ledger.vfs.map((entry: any) => entry.id) as string[],
    };
  } finally {
    await context.close();
  }
}

async function instrumentSealedFetch(options: {
  holdEager?: boolean;
  mutation: "corrupt" | "wrong-length" | "missing" | null;
  products: ProductObservation[];
  target: string | null;
}) {
  const original = window.fetch.bind(window);
  const byPath = new Map(
    options.products.map((product) => [`/kandelo/${product.path}`, product]),
  );
  const ledger = {
    external: [] as string[],
    sameOrigin: [] as string[],
    starts: [] as Array<{ id: string; load: "eager" | "lazy" }>,
    vfs: [] as any[],
  };
  let releaseEager!: () => void;
  const eagerRelease = new Promise<void>((resolve) => (releaseEager = resolve));
  (window as any).__KANDELO_TASK5_RELEASE_EAGER__ = releaseEager;
  (window as any).__KANDELO_TASK5_FETCH_LEDGER__ = ledger;
  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url,
      location.href,
    );
    if (url.origin !== location.origin) {
      ledger.external.push(url.href);
      throw new TypeError(
        `sealed assembled-site gate rejected external fetch ${url.href}`,
      );
    }
    ledger.sameOrigin.push(url.pathname);
    const product =
      url.search === "" && url.hash === ""
        ? byPath.get(url.pathname)
        : undefined;
    if (product === undefined) {
      if (/(?:^|\/)[^/]*\.vfs(?:-[^/]+)?(?:\.zst)?$/u.test(url.pathname)) {
        throw new TypeError(
          `sealed assembled-site gate rejected unknown VFS ${url.href}`,
        );
      }
      return original(input, init);
    }
    if (options.mutation === "missing" && product.id === options.target) {
      return new Response("missing", { status: 404 });
    }
    ledger.starts.push({ id: product.id, load: product.load });
    const responsePromise = original(input, init);
    if (options.holdEager === true && product.load === "eager")
      await eagerRelease;
    const response = await responsePromise;
    const body = new Uint8Array(await response.clone().arrayBuffer());
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    ledger.vfs.push({
      bytes: body.byteLength,
      declared: Number(response.headers.get("content-length")),
      id: product.id,
      sha256: digest,
      status: response.status,
    });
    if (product.id !== options.target || options.mutation === null)
      return response;
    const changed =
      options.mutation === "corrupt"
        ? new Uint8Array(body)
        : body.subarray(0, body.byteLength - 1);
    if (options.mutation === "corrupt") changed[0] ^= 0xff;
    const headers = new Headers(response.headers);
    headers.set("content-length", String(changed.byteLength));
    return new Response(changed, { headers, status: response.status });
  };
}

async function enforceSealedNetworkAuthority(
  context: BrowserContext,
  baseURL: string,
) {
  const origin = new URL(baseURL).origin;
  const paths = new Set(observations.map(({ path }) => `/kandelo/${path}`));
  const external = new Set<string>();
  const unknownVfs = new Set<string>();
  const inspect = (href: string) => {
    const url = new URL(href);
    if (url.origin !== origin) {
      external.add(url.href);
      return "external";
    }
    if (
      /(?:^|\/)[^/]*\.vfs(?:-[^/]+)?(?:\.zst)?$/u.test(url.pathname) &&
      (url.search !== "" || url.hash !== "" || !paths.has(url.pathname))
    ) {
      unknownVfs.add(url.href);
      return "unknown-vfs";
    }
    return "allowed";
  };
  context.on("request", (request) => inspect(request.url()));
  await context.route("**/*", async (route) => {
    if (inspect(route.request().url()) === "allowed") await route.continue();
    else await route.abort("blockedbyclient");
  });
  return {
    get external() {
      return [...external].sort();
    },
    get unknownVfs() {
      return [...unknownVfs].sort();
    },
  };
}

function exactSiteRoot(value: string | undefined): string {
  if (value === undefined || value === "" || resolve(value) !== value) {
    throw new Error(
      "KANDELO_ABI_STAGING_ASSEMBLED_SITE_ROOT must be an absolute path",
    );
  }
  const metadata = lstatSync(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("assembled-site root must be one direct directory");
  }
  return value;
}

function validateObservationLedger(
  value: any,
  abiVersion: number,
): ProductObservation[] {
  if (
    value?.kind !== "kandelo-pages-site-manifest" ||
    value.schema !== 1 ||
    value.target_abi?.version !== abiVersion ||
    !Array.isArray(value.products)
  )
    throw new Error("assembled-site deployment ledger is invalid");
  const products = value.products.map((product: any) => ({
    id: product.id,
    load: product.load,
    path: product.path,
    vfs_bytes: product.vfs_bytes,
    vfs_sha256: product.vfs_sha256,
  }));
  expect(
    products.map(({ id, load }: ProductObservation) => [id, load]),
  ).toEqual(expectedProducts);
  const ids = new Set<string>();
  for (const product of products) {
    if (
      ids.has(product.id) ||
      !Number.isSafeInteger(product.vfs_bytes) ||
      product.vfs_bytes < 1 ||
      !/^[0-9a-f]{64}$/u.test(product.vfs_sha256) ||
      product.path !==
        `products/${product.id}/sha256-${product.vfs_sha256}/${product.id}-${abiVersion}.vfs.zst`
    )
      throw new Error(`invalid assembled-site product ${product.id}`);
    ids.add(product.id);
  }
  return products;
}
