/**
 * Optional program binaries the browser demos bake into a VFS image.
 *
 * Shared by the main-thread boot path and the image composer worker. The
 * glob resolves to URLs only — no filesystem is touched here — so importing
 * this module is safe from either realm.
 */

const OPTIONAL_BINARY_URLS = {
  ...import.meta.glob(
    "../../../../../local-binaries/programs/wasm32/fbtest.wasm",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/fbtest.wasm", {
    query: "?url",
    import: "default",
  }),
  ...import.meta.glob(
    "../../../../../local-binaries/programs/wasm32/nginx-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob(
    "../../../../../binaries/programs/wasm32/nginx-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob(
    "../../../../../local-binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob(
    "../../../../../binaries/programs/wasm32/nginx-php-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob(
    "../../../../../local-binaries/programs/wasm32/nginx-python-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob(
    "../../../../../binaries/programs/wasm32/nginx-python-vfs.vfs.zst",
    {
      query: "?url",
      import: "default",
    },
  ),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/sdl2.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/sdl2.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ruby-todo-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ruby-todo-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/evdev_demo.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/evdev_demo.wasm", {
    query: "?url", import: "default",
  }),
  // espeak-ng publishes a wasm output plus a runtime file, so the resolver
  // mirrors its whole closure under the package directory.
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/espeak-ng/espeak-ng.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/espeak-ng/espeak-ng.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/espeak-ng/espeak-ng-data.zip", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/espeak-ng/espeak-ng-data.zip", {
    query: "?url", import: "default",
  }),
} as Record<string, () => Promise<string>>;

export async function optionalBinaryUrl(
  relPaths: string[],
  label: string,
): Promise<string> {
  for (const relPath of relPaths) {
    const loader = OPTIONAL_BINARY_URLS[relPath];
    if (loader) return loader();
  }
  throw new Error(
    `${label} is not built. Run: ./run.sh build programs, ` +
      `or for package-owned binaries: ` +
      `cargo xtask build-deps resolve <package>`,
  );
}

/** Throw with the fetch target's name instead of a bare status code. */
export function failOn(label: string): (r: Response) => Response {
  return (r) => {
    if (!r.ok)
      throw new Error(`fetch failed for ${label}: ${r.status} ${r.statusText}`);
    return r;
  };
}
