import assert from "node:assert/strict";
import test from "node:test";

import { galleryItemMatchesCurrent } from "./gallery-current.ts";
import type {
  BootDescriptor,
  GalleryItem,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

const SHELL_IMAGE = "https://kandelo.test/products/browser-main-shell.vfs.zst";
const NGINX_IMAGE = "https://kandelo.test/products/browser-nginx.vfs.zst";

function item(id: string, vfsImageUrl?: string): GalleryItem {
  return {
    id,
    title: id,
    summary: "",
    base: "kandelo:shell@abi1",
    packages: [],
    bootCommand: ["/bin/sh"],
    ...(vfsImageUrl === undefined ? {} : { vfsImageUrl }),
    accent: "#fff",
    glyph: "x",
    estimatedUrlBytes: 0,
  };
}

function descriptor(id: string): BootDescriptor {
  return { id } as BootDescriptor;
}

test("the machine named by the booted descriptor is current", () => {
  assert.equal(
    galleryItemMatchesCurrent(item("doom", SHELL_IMAGE), descriptor("doom"), SHELL_IMAGE, null),
    true,
  );
});

test("other machines inside the same image are not current", () => {
  // One VFS image declares several machines: browser-main-shell backs shell,
  // node, doom, modeset, sdl2, evdev and espeak. Matching on the image URL
  // alone marked every one of them as the current machine.
  for (const other of ["shell", "node", "modeset", "sdl2", "evdev", "espeak"]) {
    assert.equal(
      galleryItemMatchesCurrent(
        item(other, SHELL_IMAGE),
        descriptor("doom"),
        SHELL_IMAGE,
        null,
      ),
      false,
      `${other} must not be current while doom is booted`,
    );
  }
});

test("a requested profile picks one machine out of a shared image", () => {
  // Before the image is read the descriptor cannot name the machine yet, so
  // `&profile=` is the only identity available.
  assert.equal(
    galleryItemMatchesCurrent(
      item("doom", SHELL_IMAGE),
      descriptor("browser-main-shell"),
      SHELL_IMAGE,
      "doom",
    ),
    true,
  );
  assert.equal(
    galleryItemMatchesCurrent(
      item("espeak", SHELL_IMAGE),
      descriptor("browser-main-shell"),
      SHELL_IMAGE,
      "doom",
    ),
    false,
  );
});

test("a shared image with no requested profile marks nothing current", () => {
  // Claiming a machine here would be a guess. The descriptor names the real
  // one as soon as the image's demo.json is parsed.
  assert.equal(
    galleryItemMatchesCurrent(
      item("shell", SHELL_IMAGE),
      descriptor("browser-main-shell"),
      SHELL_IMAGE,
      null,
    ),
    false,
  );
});

test("a machine from a different image is never current", () => {
  assert.equal(
    galleryItemMatchesCurrent(
      item("nginx", NGINX_IMAGE),
      descriptor("doom"),
      SHELL_IMAGE,
      "doom",
    ),
    false,
  );
});

test("an item with no image URL matches only by descriptor id", () => {
  assert.equal(
    galleryItemMatchesCurrent(item("custom"), descriptor("custom"), SHELL_IMAGE, null),
    true,
  );
  assert.equal(
    galleryItemMatchesCurrent(item("custom"), descriptor("doom"), SHELL_IMAGE, null),
    false,
  );
});
