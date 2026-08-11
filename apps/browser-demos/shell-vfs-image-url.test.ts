import assert from "node:assert/strict";
import test from "node:test";

import {
  isNodeVfsImageUrl,
  isShellVfsImageUrl,
  isVfsImageUrl,
} from "./lib/shell-vfs-image-url";

test("recognizes source and Vite-built Node VFS image URLs", () => {
  const accepted = [
    "/node-vfs.vfs.zst",
    "https://example.test/assets/node-vfs.vfs-BrtFEJTw.zst",
    "https://example.test/assets/node-vfs.vfs-BrtFEJTw.zst?download=1#fragment",
  ];
  const rejected = [
    "/assets/node.vfs.zst",
    "/assets/not-node-vfs.vfs-BrtFEJTw.zst",
    "/assets/node-vfs.vfs.zst.backup",
    "https://[invalid",
  ];

  for (const url of accepted) assert.equal(isNodeVfsImageUrl(url), true, url);
  for (const url of rejected) assert.equal(isNodeVfsImageUrl(url), false, url);
});

test("recognizes source and Vite-built shell VFS image URLs", () => {
  const accepted = [
    "/shell.vfs.zst",
    "https://example.test/assets/shell.vfs-BrtFEJTw.zst",
    "https://example.test/assets/shell.vfs-BrtFEJTw.zst?download=1#fragment",
  ];

  for (const url of accepted) {
    assert.equal(isShellVfsImageUrl(url), true, url);
  }
});

test("rejects other artifacts and shell-like filename suffixes", () => {
  const rejected = [
    "/assets/node-vfs.vfs.zst",
    "/assets/not-shell.vfs-BrtFEJTw.zst",
    "/assets/shell-debug.vfs.zst",
    "/assets/shell-debug.vfs-BrtFEJTw.zst",
    "/assets/shell.vfs.zst.backup",
    "/assets/shell.vfs-BrtFEJTw.zip",
    "/assets/shell.vfs-.zst",
    "https://[invalid",
  ];

  for (const url of rejected) {
    assert.equal(isShellVfsImageUrl(url), false, url);
  }
});

test("recognizes all source and Vite-built VFS asset shapes", () => {
  const accepted = [
    "/assets/node.vfs",
    "/assets/node.vfs-BrtFEJTw",
    "/assets/node.vfs.zst",
    "/assets/node.vfs-BrtFEJTw.zst",
    "/assets/lamp.vfs-cjaijlcm.zst.vfs.zst?download=1",
  ];

  for (const url of accepted) {
    assert.equal(isVfsImageUrl(url), true, url);
  }

  const rejected = [
    "/assets/node-vfs.wasm",
    "/assets/node.vfs.zst.backup",
    "/assets/.vfs.zst",
    "https://[invalid",
  ];

  for (const url of rejected) {
    assert.equal(isVfsImageUrl(url), false, url);
  }
});
