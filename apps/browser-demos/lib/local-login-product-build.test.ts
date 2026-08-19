import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
  HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
  type HomebrewBottleMirrorPlan,
} from "../../../host/src/homebrew-bottle-mirror-plan";
import {
  createLocalLoginProductPlugin,
  loadLocalLoginProductBuildInput,
  LOCAL_LOGIN_PRODUCT_VIRTUAL_MODULE,
} from "./local-login-product-build";

const FIXTURE_NAME = "homebrew-login-lifecycle-fixture.json";

test("loads one exact closed local login product and compiles its policy", () => {
  withFixture((fixture) => {
    const loaded = loadLocalLoginProductBuildInput(fixture.root, "/");

    assert.equal(loaded.manifest.schema, 1);
    assert.equal(loaded.manifest.assetRoot, "/homebrew-login-product/");
    assert.deepEqual(
      loaded.manifest.projections.map((entry) => entry.destinationPath).sort(),
      ["/usr/bin/login", "/usr/bin/sudo", "/usr/bin/sudo-lite"],
    );
    assert.deepEqual(
      loaded.assets.map((entry) => entry.name).sort(),
      fixture.assetNames.toSorted(),
    );
    for (const asset of loaded.assets) {
      assert.deepEqual(asset.bytes, readFileSync(join(fixture.root, asset.name)));
    }
  });
});

test("disabled local login builds carry no product authority", () => {
  assert.equal(loadLocalLoginProductBuildInput(undefined, "/kandelo/"), null);
});

test("Vite exports the compiled manifest and emits only its exact assets", () => {
  withFixture((fixture) => {
    const plugin = createLocalLoginProductPlugin({
      base: "/nested/",
      configuredRoot: fixture.root,
    });
    const resolved = plugin.resolveId!.call(
      {} as never,
      LOCAL_LOGIN_PRODUCT_VIRTUAL_MODULE,
      undefined,
      {} as never,
    );
    assert.equal(resolved, `\0${LOCAL_LOGIN_PRODUCT_VIRTUAL_MODULE}`);
    const moduleSource = plugin.load!.call({} as never, resolved as string);
    assert.match(String(moduleSource), /"assetRoot":"\/nested\/homebrew-login-product\/"/);

    const emitted: Array<{ fileName?: string; source?: unknown }> = [];
    plugin.generateBundle!.call(
      { emitFile: (asset: { fileName?: string; source?: unknown }) => {
        emitted.push(asset);
        return "asset";
      } } as never,
      {} as never,
      {} as never,
      false,
    );
    assert.deepEqual(
      emitted.map((entry) => entry.fileName).sort(),
      fixture.assetNames.map((name) => `homebrew-login-product/${name}`).sort(),
    );
  });
});

test("requires an absolute private input root", () => {
  assert.throws(
    () => loadLocalLoginProductBuildInput("relative/product", "/"),
    /absolute private input root/i,
  );
});

test("rejects changed, symlinked, missing, and extra product files", () => {
  const cases: Array<[
    string,
    (fixture: ProductFixture) => void,
    RegExp,
  ]> = [
    [
      "changed",
      ({ root, assetNames }) => writeFileSync(join(root, assetNames[0]!), "changed"),
      /identity|digest|bytes/i,
    ],
    [
      "symlink",
      ({ root, assetNames }) => {
        const target = join(root, assetNames[0]!);
        const bytes = readFileSync(target);
        rmSync(target);
        writeFileSync(join(root, "symlink-target"), bytes);
        symlinkSync(join(root, "symlink-target"), target);
      },
      /regular non-symlink/i,
    ],
    [
      "missing",
      ({ root, assetNames }) => rmSync(join(root, assetNames[0]!)),
      /missing|regular non-symlink/i,
    ],
    [
      "extra",
      ({ root }) => writeFileSync(join(root, "unreviewed.wasm"), "rogue"),
      /exact file set/i,
    ],
  ];

  for (const [name, mutate, message] of cases) {
    withFixture((fixture) => {
      mutate(fixture);
      assert.throws(
        () => loadLocalLoginProductBuildInput(fixture.root, "/"),
        message,
        name,
      );
    });
  }
});

test("rejects composition reports that do not declare the closed product", () => {
  const cases: Array<[string, (report: any) => void, RegExp]> = [
    [
      "missing destination",
      (report) => report.privileged_programs.projections.pop(),
      /exactly 3 entries|missing/i,
    ],
    [
      "unknown destination",
      (report) => {
        report.privileged_programs.projections[0].destination_path =
          "/usr/bin/not-reviewed";
      },
      /not reviewed/i,
    ],
    [
      "unknown field",
      (report) => {
        report.privileged_programs.projections[0].authority = true;
      },
      /closed schema/i,
    ],
    [
      "wrong product identity",
      (report) => {
        report.privileged_product.sha256 = "f".repeat(64);
      },
      /serialized privileged product identity/i,
    ],
    [
      "promotable provenance",
      (report) => {
        report.local_test.provenance.promotable = true;
      },
      /non-promotable local-test evidence/i,
    ],
  ];

  for (const [name, mutate, message] of cases) {
    withFixture((fixture) => {
      const path = join(fixture.root, "composition-report.json");
      const report = JSON.parse(readFileSync(path, "utf8"));
      mutate(report);
      writeFileSync(path, `${JSON.stringify(report)}\n`);
      rewriteFixtureIdentity(fixture.root, "composition-report.json");
      assert.throws(
        () => loadLocalLoginProductBuildInput(fixture.root, "/"),
        message,
        name,
      );
    });
  }
});

interface ProductFixture {
  root: string;
  assetNames: string[];
}

function withFixture(run: (fixture: ProductFixture) => void): void {
  const temp = mkdtempSync(join(tmpdir(), "kandelo-local-login-product-"));
  try {
    run(createFixture(temp));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function createFixture(temp: string): ProductFixture {
  const root = join(temp, "private-product");
  mkdirSync(root);
  const bodies = new Map<string, Uint8Array>([
    ["main-shell.vfs.zst", bytes("main shell")],
    ["main-shell-brew-package-tree.json", bytes("{}\n")],
    ["homebrew-bootstrap.zip", bytes("bootstrap archive")],
    ["homebrew-brew.env", bytes("HOMEBREW_PREFIX=/opt/kandelo/homebrew\n")],
    ["main-shell.vfs.privileged.vfs", bytes("privileged product")],
    ["bottle-test.tar.gz", bytes("bottle payload")],
  ]);
  for (const [name, body] of bodies) writeFileSync(join(root, name), body);

  const bottle = bodies.get("bottle-test.tar.gz")!;
  const repository = "kandelo-dev/homebrew-tap-core";
  const bottleIdentity = {
    id: "bottle-test",
    package: "kandelo-dev/tap-core/login",
    asset: "bottle-test.tar.gz",
    sha256: sha256(bottle),
    bytes: bottle.byteLength,
  };
  const collection = sha256(
    encodeHomebrewBottleMirrorCollectionIdentity(repository, [bottleIdentity]),
  );
  const tag = `homebrew-shell-bottles-sha256-${collection}`;
  const releaseRoot =
    `https://github.com/${repository}/releases/download/${tag}`;
  const plan: HomebrewBottleMirrorPlan = {
    schema: 1,
    kind: HOMEBREW_BOTTLE_MIRROR_PLAN_KIND,
    repository,
    collection_sha256: collection,
    tag,
    release_root: releaseRoot,
    manifest_asset: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    assets: [{
      ...bottleIdentity,
      url: `${releaseRoot}/${bottleIdentity.asset}`,
    }],
  };
  const planBytes = encodeHomebrewBottleMirrorPlan(plan);
  writeFileSync(join(root, HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET), planBytes);

  const privileged = bodies.get("main-shell.vfs.privileged.vfs")!;
  const destinations = [
    ["login", "bin/login", "/usr/bin/login"],
    ["sudo-lite", "bin/sudo-lite", "/usr/bin/sudo-lite"],
    ["sudo", "bin/sudo", "/usr/bin/sudo"],
  ] as const;
  const compositionReport = {
    image: "main-shell.vfs.zst",
    local_test: {
      provenance: {
        schema: 1,
        provenance_kind: "local-test",
        promotable: false,
        published: false,
      },
      source_tap_commit: "1".repeat(40),
    },
    privileged_programs: {
      projections: destinations.map(([formula, sourcePath, destinationPath]) => ({
        schema: 1,
        formula: `kandelo-dev/tap-core/${formula}`,
        bottle_sha256: sha256(bytes(`bottle ${formula}`)),
        source_path: sourcePath,
        destination_path: destinationPath,
        uid: 0,
        gid: 0,
        mode: 0o4755,
        mount_point: "trusted-root-product",
        artifact_validation_sha256: sha256(bytes(`program ${formula}`)),
      })),
    },
    privileged_product: {
      image: "main-shell.vfs.privileged.vfs",
      sha256: sha256(privileged),
      bytes: privileged.byteLength,
    },
  };
  const compositionBytes = bytes(`${JSON.stringify(compositionReport)}\n`);
  writeFileSync(join(root, "composition-report.json"), compositionBytes);

  const fixedRoot = "https://closed.kandelo.invalid/login-product/";
  const exact = (name: string, body: Uint8Array, url = `${fixedRoot}${name}`) => ({
    url,
    sha256: sha256(body),
    bytes: body.byteLength,
  });
  const fixture = {
    schema: 1,
    allowLiveNetwork: true,
    transportMode: "closed",
    image: exact("main-shell.vfs.zst", bodies.get("main-shell.vfs.zst")!),
    bootstrap: {
      spec: exact(
        "main-shell-brew-package-tree.json",
        bodies.get("main-shell-brew-package-tree.json")!,
      ),
      archive: exact(
        "homebrew-bootstrap.zip",
        bodies.get("homebrew-bootstrap.zip")!,
      ),
      environment: exact("homebrew-brew.env", bodies.get("homebrew-brew.env")!),
    },
    bottleMirror: {
      plan: exact(HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET, planBytes,
        `${releaseRoot}/${HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET}`),
      payloads: [{
        asset: bottleIdentity.asset,
        ...exact(bottleIdentity.asset, bottle, plan.assets[0]!.url),
      }],
    },
    loginProduct: {
      compositionReport: exact("composition-report.json", compositionBytes),
      privilegedProduct: exact("main-shell.vfs.privileged.vfs", privileged),
    },
    revisions: {
      coreRevision: "1".repeat(40),
      canaryRevision: "1".repeat(40),
    },
    timeoutMs: 60_000,
  };
  writeFileSync(join(root, FIXTURE_NAME), `${JSON.stringify(fixture)}\n`);

  return {
    root,
    assetNames: [
      ...bodies.keys(),
      HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
      "composition-report.json",
    ],
  };
}

function rewriteFixtureIdentity(root: string, name: string): void {
  const fixturePath = join(root, FIXTURE_NAME);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const body = readFileSync(join(root, name));
  fixture.loginProduct.compositionReport = {
    ...fixture.loginProduct.compositionReport,
    sha256: sha256(body),
    bytes: body.byteLength,
  };
  writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`);
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
