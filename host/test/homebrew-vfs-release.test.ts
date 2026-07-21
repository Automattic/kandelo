import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ABI_VERSION } from "../src/generated/abi";
import {
  fetchHomebrewVfsReleaseDescriptor,
  fetchVerifiedHomebrewVfsImage,
  parseHomebrewVfsReleaseDescriptor,
  resolveHomebrewVfsRelease,
} from "../src/homebrew-vfs-release";

const TAP_REPOSITORY = "Example/homebrew-tools";
const TAP_NAME = "example/tools";
const TAP_COMMIT = "1111111111111111111111111111111111111111";
const KANDELO_COMMIT = "2222222222222222222222222222222222222222";
const IMAGE = new TextEncoder().encode("exact immutable VFS bytes");
const IMAGE_SHA = digest(IMAGE);
const TAG = `homebrew-vfs-sha256-${IMAGE_SHA}`;
const DESCRIPTOR_URL = assetUrl("kandelo-homebrew-vfs.json");
const IMAGE_URL = assetUrl("kandelo-homebrew.vfs.zst");

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assetUrl(asset: string): string {
  return `https://github.com/${TAP_REPOSITORY}/releases/download/${TAG}/${asset}`;
}

function asset(assetName: string, bytes: Uint8Array = new TextEncoder().encode(assetName)) {
  return {
    asset: assetName,
    url: assetUrl(assetName),
    sha256: digest(bytes),
    bytes: bytes.byteLength,
  };
}

function descriptor(): Record<string, any> {
  return {
    schema: 1,
    kind: "kandelo-homebrew-vfs",
    formula: "file-formula",
    arch: "wasm32",
    tap: {
      repository: TAP_REPOSITORY,
      name: TAP_NAME,
      commit: TAP_COMMIT,
    },
    kandelo: {
      repository: "Automattic/kandelo",
      commit: KANDELO_COMMIT,
      abi: ABI_VERSION,
    },
    bottle_release_tag: `bottles-abi-v${ABI_VERSION}`,
    selection: {
      requested_packages: ["dash", "file-formula"],
      dependency_edges: [{
        from: "example/tools/file-formula",
        to: "example/tools/libmagic",
        version: "5.45",
      }],
    },
    acceptance: {
      node: "success",
      browser: "chromium",
      executable: "/home/linuxbrew/.linuxbrew/bin/file",
      argv: ["file", "-Lb", "/home/linuxbrew/.linuxbrew/bin/file"],
    },
    release: { repository: TAP_REPOSITORY, tag: TAG },
    image: {
      ...asset("kandelo-homebrew.vfs.zst", IMAGE),
      kernel_abi: ABI_VERSION,
    },
    evidence: {
      report: asset("kandelo-homebrew-vfs-report.json"),
      node: asset("kandelo-homebrew-node-evidence.json"),
      browser: asset("kandelo-homebrew-browser-evidence.json"),
    },
    launch: { query_parameter: "vfs", value: IMAGE_URL },
    default_shell: {
      path: "/home/linuxbrew/.linuxbrew/bin/dash",
      argv: ["dash", "-l", "-i"],
    },
  };
}

function response(body: BodyInit, contentLength?: number): Response {
  return new Response(body, {
    status: 200,
    headers: contentLength === undefined
      ? undefined
      : { "content-length": String(contentLength) },
  });
}

describe("immutable Homebrew VFS release resolver", () => {
  it("accepts a conventional third-party tap without first-party allowlisting", () => {
    const parsed = parseHomebrewVfsReleaseDescriptor(
      descriptor(),
      DESCRIPTOR_URL,
      ABI_VERSION,
    );

    expect(parsed.tap).toEqual({
      repository: TAP_REPOSITORY,
      name: TAP_NAME,
      commit: TAP_COMMIT,
    });
    expect(parsed.default_shell).toEqual({
      path: "/home/linuxbrew/.linuxbrew/bin/dash",
      argv: ["dash", "-l", "-i"],
    });
    expect(parsed.image).toMatchObject({
      url: IMAGE_URL,
      sha256: IMAGE_SHA,
      bytes: IMAGE.byteLength,
      kernel_abi: ABI_VERSION,
    });
  });

  it("uses one bounded resolver in Node and browser-compatible callers", async () => {
    const descriptorBytes = new TextEncoder().encode(JSON.stringify(descriptor()));
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(init).toMatchObject({
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
      });
      if (String(url) === DESCRIPTOR_URL) {
        return response(descriptorBytes, descriptorBytes.byteLength);
      }
      if (String(url) === IMAGE_URL) return response(IMAGE, IMAGE.byteLength);
      return new Response("missing", { status: 404 });
    });

    const resolved = await resolveHomebrewVfsRelease(DESCRIPTOR_URL, ABI_VERSION, {
      fetch: fetchMock,
    });

    expect(resolved.descriptor.formula).toBe("file-formula");
    expect(resolved.imageBytes).toEqual(IMAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches the descriptor independently when callers resolve mounts before images", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(descriptor()));
    const fetchMock = vi.fn<typeof fetch>(async () => response(bytes));

    const parsed = await fetchHomebrewVfsReleaseDescriptor(
      DESCRIPTOR_URL,
      ABI_VERSION,
      { fetch: fetchMock },
    );

    expect(parsed.release.tag).toBe(TAG);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a descriptor whose URL, tap identity, ABI, or launch target drifts", () => {
    const wrongUrl = descriptor();
    expect(() => parseHomebrewVfsReleaseDescriptor(
      wrongUrl,
      DESCRIPTOR_URL.replace("Example/", "Elsewhere/"),
      ABI_VERSION,
    )).toThrow("descriptor URL");

    const wrongTap = descriptor();
    wrongTap.tap.name = "example/elsewhere";
    expect(() => parseHomebrewVfsReleaseDescriptor(
      wrongTap,
      DESCRIPTOR_URL,
      ABI_VERSION,
    )).toThrow("canonical tap name");

    const wrongAbi = descriptor();
    wrongAbi.kandelo.abi = ABI_VERSION + 1;
    expect(() => parseHomebrewVfsReleaseDescriptor(
      wrongAbi,
      DESCRIPTOR_URL,
      ABI_VERSION,
    )).toThrow("Kandelo ABI");

    const wrongLaunch = descriptor();
    wrongLaunch.launch.value = "https://example.invalid/mutable.vfs.zst";
    expect(() => parseHomebrewVfsReleaseDescriptor(
      wrongLaunch,
      DESCRIPTOR_URL,
      ABI_VERSION,
    )).toThrow("launch image URL");
  });

  it("rejects unexpected fields and unsafe default-shell paths", () => {
    const extra = descriptor();
    extra.trusted = true;
    expect(() => parseHomebrewVfsReleaseDescriptor(
      extra,
      DESCRIPTOR_URL,
      ABI_VERSION,
    )).toThrow("unexpected or missing fields");

    const unsafeShell = descriptor();
    unsafeShell.default_shell.path = "/home/user/../bin/dash";
    expect(() => parseHomebrewVfsReleaseDescriptor(
      unsafeShell,
      DESCRIPTOR_URL,
      ABI_VERSION,
    )).toThrow("must be normalized");
  });

  it("rejects oversized declarations before downloading an image", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(fetchVerifiedHomebrewVfsImage({
      url: IMAGE_URL,
      sha256: IMAGE_SHA,
      bytes: 1025,
    }, {
      fetch: fetchMock,
      maxImageBytes: 1024,
    })).rejects.toThrow("consumer cap");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects truncated, overlong, and digest-mismatched image responses", async () => {
    await expect(fetchVerifiedHomebrewVfsImage({
      url: IMAGE_URL,
      sha256: IMAGE_SHA,
      bytes: IMAGE.byteLength,
    }, {
      fetch: async () => response(IMAGE.subarray(0, IMAGE.byteLength - 1)),
    })).rejects.toThrow("byte count mismatch");

    const overlong = new Uint8Array(IMAGE.byteLength + 1);
    overlong.set(IMAGE);
    await expect(fetchVerifiedHomebrewVfsImage({
      url: IMAGE_URL,
      sha256: IMAGE_SHA,
      bytes: IMAGE.byteLength,
    }, {
      fetch: async () => response(overlong),
    })).rejects.toThrow("exceeded its declared byte count");

    const tampered = IMAGE.slice();
    tampered[0] ^= 0xff;
    await expect(fetchVerifiedHomebrewVfsImage({
      url: IMAGE_URL,
      sha256: IMAGE_SHA,
      bytes: IMAGE.byteLength,
    }, {
      fetch: async () => response(tampered),
    })).rejects.toThrow("SHA-256 mismatch");
  });
});
