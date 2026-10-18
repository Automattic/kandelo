import { describe, expect, it } from "vitest";

import { resolveInitArgv } from "../src/init-boot-identity";

// Review Focus: a pasted `#k1=` link decoded by the Kandelo app's
// NewMachinePane/EmptyState hands its whole descriptor to
// `applyBootDescriptor`, which reaches `bootProfile` -> this decision. BOOT
// IDENTITY COMES FROM THE IMAGE: the descriptor's argv must never win, but
// the drop must be visible rather than silent.

describe("resolveInitArgv", () => {
  it("does not report a caller argv matching the image's own as ignored", () => {
    const result = resolveInitArgv(["bash", "-l", "-i"], ["bash", "-l", "-i"]);
    expect(result.argv).toEqual(["bash", "-l", "-i"]);
    expect(result.ignoredMessage).toBeNull();
  });

  it("boots the image's init silently when there is no caller argv at all", () => {
    // A schema-only placeholder (validateBootDescriptor requires a
    // non-empty argv, but nothing meaningful was supplied) must not read as
    // a drop.
    const result = resolveInitArgv([], ["/sbin/dinit", "--container", "default"]);
    expect(result.argv).toEqual(["/sbin/dinit", "--container", "default"]);
    expect(result.ignoredMessage).toBeNull();
  });

  it("ignores a pasted link's differing argv rather than honouring it, with a visible log line", () => {
    // Every link ShareDialog has ever produced spreads the authoring
    // machine's whole boot block, so this is the common case for old
    // links, not an edge case.
    const requestedArgv = ["bash", "-l", "-i"];
    const imageArgv = ["/sbin/dinit", "--container", "wordpress"];

    const result = resolveInitArgv(requestedArgv, imageArgv);

    // The machine boots the image's own init — the caller's argv never
    // reaches kernel.spawnFromVfs.
    expect(result.argv).toEqual(imageArgv);
    expect(result.argv).not.toEqual(requestedArgv);
    // The drop is truthful, not silent: it names both the fact that pid 1
    // comes from the image and what that argv actually is.
    expect(result.ignoredMessage).toBe(
      "ignoring the boot descriptor's init argv: this machine's pid 1"
        + " comes from its image (/sbin/dinit --container wordpress)",
    );
  });

  it("ignores a gallery apply's stale carried-over argv too, not just link argv", () => {
    // descriptorFromGalleryItem no longer assigns boot.argv, so a gallery
    // switch's requestedDescriptor.boot.argv is whatever the PREVIOUS
    // machine happened to carry. This must be ignored exactly like a
    // pasted link's.
    const staleArgv = ["node"];
    const imageArgv = ["bash", "-l", "-i"];

    const result = resolveInitArgv(staleArgv, imageArgv);

    expect(result.argv).toEqual(imageArgv);
    expect(result.ignoredMessage).toContain("bash -l -i");
  });
});
