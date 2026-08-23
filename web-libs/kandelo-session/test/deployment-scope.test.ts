import { describe, expect, it } from "vitest";

import {
  deploymentScopeFromServiceWorkerUrl,
  normalizeDeploymentBase,
  scopedStorageKey,
} from "../src/deployment-scope";

const acceptedBases = [
  "/",
  "/a/",
  "/candidate-b/",
  "/nested/kandelo-2/",
  "/safe%20space/",
];

const rejectedBases = [
  "",
  "a/",
  "./",
  "../a/",
  "/a",
  "//a/",
  "https://example/a/",
  "/a//b/",
  "/a/./",
  "/a/../b/",
  "/a/%2e/",
  "/a/%2E%2E/b/",
  "/a/%252e%252e/b/",
  "/a/%2f/b/",
  "/a/%5c/b/",
  "/a\\b/",
  "/a/?q=1",
  "/a/#x",
  "/a/\0/",
];

describe("normalizeDeploymentBase", () => {
  it.each(acceptedBases)("preserves the accepted pathname spelling %j", (value) => {
    expect(normalizeDeploymentBase(value)).toBe(value);
  });

  it.each(rejectedBases)("rejects unsafe deployment base %j", (value) => {
    expect(() => normalizeDeploymentBase(value)).toThrow();
  });
});

describe("deploymentScopeFromServiceWorkerUrl", () => {
  it("returns the normalized script directory for a page inside it", () => {
    expect(deploymentScopeFromServiceWorkerUrl(
      "https://demo.test/a/service-worker.js",
      "https://demo.test/a/pages/kandelo/?demo=shell#terminal",
    )).toBe("/a/");
    expect(deploymentScopeFromServiceWorkerUrl(
      "https://demo.test/service-worker.js",
      "https://demo.test/",
    )).toBe("/");
    expect(deploymentScopeFromServiceWorkerUrl(
      "http://localhost:5401/a/service-worker.js",
      "http://localhost:5401/a/pages/kandelo/",
    )).toBe("/a/");
  });

  it.each([
    ["file:///a/service-worker.js", "file:///a/page.html"],
    ["file://worker-host/a/service-worker.js", "file://page-host/a/page.html"],
    ["data:text/javascript,worker", "data:text/html,page"],
    ["blob:null/worker", "blob:null/page"],
    ["ftp://demo.test/a/service-worker.js", "ftp://demo.test/a/page.html"],
  ])("rejects unsupported or opaque URL authorities %j", (swUrl, pageUrl) => {
    expect(() => deploymentScopeFromServiceWorkerUrl(swUrl, pageUrl))
      .toThrow(/must use http: or https:/iu);
  });

  it("rejects another origin and pages outside the script directory", () => {
    expect(() => deploymentScopeFromServiceWorkerUrl(
      "https://workers.test/a/service-worker.js",
      "https://demo.test/a/",
    )).toThrow();
    expect(() => deploymentScopeFromServiceWorkerUrl(
      "https://demo.test/a/service-worker.js",
      "https://demo.test/b/",
    )).toThrow();
    expect(() => deploymentScopeFromServiceWorkerUrl(
      "https://demo.test/a/service-worker.js",
      "https://demo.test/a",
    )).toThrow();
  });

  it("rejects a script directory that is not a normalized deployment base", () => {
    expect(() => deploymentScopeFromServiceWorkerUrl(
      "https://demo.test/a/%252e%252e/service-worker.js",
      "https://demo.test/a/%252e%252e/",
    )).toThrow();
  });
});

describe("scopedStorageKey", () => {
  it("produces stable, distinct keys for sibling deployment scopes", () => {
    expect(scopedStorageKey("/a/", "lazy-assets-v1"))
      .toBe("kandelo:%2Fa%2F:lazy-assets-v1");
    expect(scopedStorageKey("/b/", "lazy-assets-v1"))
      .toBe("kandelo:%2Fb%2F:lazy-assets-v1");
  });

  it("rejects invalid scope paths and storage names", () => {
    expect(() => scopedStorageKey("a/", "lazy-assets-v1")).toThrow();
    for (const name of ["", "Lazy-assets-v1", "lazy_assets", "lazy/assets"]) {
      expect(() => scopedStorageKey("/a/", name)).toThrow();
    }
  });
});
