import { expect, test } from "@playwright/test";
import {
  browserLazyFetchUrl,
  browserResolvedLazySourceUrl,
  canonicalAssetForPackage,
  canonicalHomebrewTransportPlan,
  expectedBrowserLazyTransport,
  type CanonicalHomebrewTransportPlan,
} from "./support/homebrew-lazy-transport";

test("classifies browser lazy transport after URL normalization", () => {
  const pageUrl = "https://demo.kandelo.test/kandelo/?demo=shell";
  const sameOrigin = browserResolvedLazySourceUrl(
    "/assets/root.zip",
    pageUrl,
  );
  const external = browserResolvedLazySourceUrl(
    "https://packages.example/runtime.zip",
    pageUrl,
  );
  expect(sameOrigin).toBe("https://demo.kandelo.test/assets/root.zip");
  expect(expectedBrowserLazyTransport(sameOrigin, pageUrl)).toBe("direct");
  expect(external).toBe("https://packages.example/runtime.zip");
  expect(expectedBrowserLazyTransport(external, pageUrl)).toBe("proxy");
  expect(() =>
    browserResolvedLazySourceUrl("assets/ambiguous.zip", pageUrl)
  ).toThrow(
    "lazy source must be absolute or root-relative",
  );
});

test("derives a closed transport plan from canonical resolved inputs", () => {
  const digest = "c".repeat(64);
  const descriptorDigest = "d".repeat(64);
  const resolved = {
    schema: 1,
    kind: "kandelo-resolved-vfs-product-inputs",
    reference_class: "canonical",
    inputs: [{
      architecture: "wasm32",
      bytes: 321,
      declared_materialization: "lazy",
      effective_materialization: "lazy-reference",
      id: "homebrew-kandelo-sdk",
      kind: "homebrew-bottle",
      reference:
        `ghcr.io/kandelo-dev/homebrew-tap-core-abi-42/kandelo-sdk@sha256:${digest}`,
      role: "runtime",
      sha256: digest,
      descriptor: {
        bytes: 91,
        path: "inputs/objects/homebrew-kandelo-sdk-metadata",
        reference:
          "ghcr.io/kandelo-dev/homebrew-tap-core-abi-42/kandelo-sdk" +
          `@sha256:${descriptorDigest}`,
        sha256: descriptorDigest,
      },
    }, {
      architecture: "wasm32",
      bytes: 11,
      declared_materialization: "embedded",
      effective_materialization: "embedded",
      id: "homebrew-bash",
      kind: "homebrew-bottle",
      path: "inputs/objects/homebrew-bash",
      reference:
        `ghcr.io/kandelo-dev/homebrew-tap-core-abi-42/bash@sha256:${"e".repeat(64)}`,
      role: "runtime",
      sha256: "e".repeat(64),
    }],
  };
  expect(canonicalHomebrewTransportPlan(resolved)).toEqual({
    assets: [{
      inputId: "homebrew-kandelo-sdk",
      package: "kandelo-dev/tap-core/kandelo-sdk",
      descriptorReference: resolved.inputs[0]!.descriptor.reference,
      sourceUrl:
        "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-42/kandelo-sdk/" +
        `blobs/sha256:${digest}`,
      sha256: digest,
      bytes: 321,
    }],
  });

  for (const mutate of [
    (value: any) => { value.reference_class = "candidate"; },
    (value: any) => { value.inputs = value.inputs.slice(1); },
    (value: any) => { value.inputs[0].reference = value.inputs[0].reference.replace("@sha256:", ":latest@sha256:"); },
    (value: any) => { value.inputs[0].descriptor.reference = value.inputs[0].descriptor.reference.replace("/kandelo-sdk@", "/clang@"); },
  ]) {
    const changed = structuredClone(resolved);
    mutate(changed);
    expect(() => canonicalHomebrewTransportPlan(changed)).toThrow();
  }
});

test("derives the browser fetch URL from the resolved transport", () => {
  const pageUrl = "https://demo.kandelo.test/kandelo/?demo=shell";
  expect(
    browserLazyFetchUrl(
      "/assets/root.zip",
      pageUrl,
      "/__kandelo_cors_proxy?url=",
    ),
  ).toBe("https://demo.kandelo.test/assets/root.zip");
  expect(
    browserLazyFetchUrl(
      "https://ghcr.io/v2/kandelo-dev/toolchain/blobs/sha256:" + "a".repeat(64),
      pageUrl,
      "/__kandelo_cors_proxy?url=",
    ),
  ).toBe(
    "https://demo.kandelo.test/__kandelo_cors_proxy?url=" +
      encodeURIComponent(
        "https://ghcr.io/v2/kandelo-dev/toolchain/blobs/sha256:" + "a".repeat(64),
      ),
  );
});

test("selects one exact canonical Homebrew package asset", () => {
  const digest = "b".repeat(64);
  const plan: CanonicalHomebrewTransportPlan = {
    assets: [{
      inputId: "homebrew-clang",
      package: "kandelo-dev/tap-core/clang",
      descriptorReference:
        `ghcr.io/kandelo-dev/homebrew-tap-core-abi-42/clang@sha256:${digest}`,
      sourceUrl:
        `https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-42/clang/` +
        `blobs/sha256:${digest}`,
      sha256: digest,
      bytes: 123,
    }],
  };
  expect(canonicalAssetForPackage(plan, "kandelo-dev/tap-core/clang"))
    .toEqual(plan.assets[0]);

  for (const mutate of [
    (asset: CanonicalHomebrewTransportPlan["assets"][number]) => {
      asset.inputId = "homebrew-sdk";
    },
    (asset: CanonicalHomebrewTransportPlan["assets"][number]) => {
      asset.descriptorReference = asset.descriptorReference.replace(
        "/clang@",
        "/libcxx@",
      );
    },
    (asset: CanonicalHomebrewTransportPlan["assets"][number]) => {
      asset.sourceUrl += "?mutable=1";
    },
    (asset: CanonicalHomebrewTransportPlan["assets"][number]) => {
      asset.bytes = 0;
    },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed.assets[0]!);
    expect(
      () => canonicalAssetForPackage(changed, "kandelo-dev/tap-core/clang"),
    ).toThrow("canonical lazy asset identity is invalid");
  }

  expect(() => canonicalAssetForPackage(
    { assets: [...plan.assets, { ...plan.assets[0]! }] },
    "kandelo-dev/tap-core/clang",
  )).toThrow("expected one canonical lazy asset");
});
