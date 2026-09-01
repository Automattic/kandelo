import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("qtbase package contract", () => {
  it("pins the upstream archive by version and digest", () => {
    const manifest = source("packages/registry/qtbase/package.toml");
    const build = source("packages/registry/qtbase/build-qtbase.sh");

    expect(manifest).toContain('version = "6.10.2"');
    expect(manifest).toContain(
      'sha256 = "aeb78d29291a2b5fd53cb55950f8f5065b4978c25fb1d77f627d695ab9adf21e"',
    );
    expect(build).toContain("shasum -a 256 -c -");
  });

  it("declares the three target adaptations the wasm32 build needs", () => {
    const build = source("packages/registry/qtbase/build-qtbase.sh");

    // qsystemdetection.h:134 errors out without a known OS macro; this
    // toolchain defines __unix__ but not __linux__.
    expect(build).toContain("-D__linux__=1");
    // Qt's own lever for a Linux userland with no futex syscall.
    expect(build).toContain("-DQT_LINUXBASE");
    // Supplies the empty <linux/fs.h> QtCore includes.
    expect(build).toContain('-I$SCRIPT_DIR/src/include');
  });

  it("patches the two upstream sites that ignore QT_LINUXBASE", () => {
    const build = source("packages/registry/qtbase/build-qtbase.sh");
    const patch = source(
      "packages/registry/qtbase/src/qmutex-honour-qt-linuxbase.patch",
    );

    expect(build).toContain(
      'patch -d "$SRC_DIR" -p1 < "$SCRIPT_DIR/src/qmutex-honour-qt-linuxbase.patch"',
    );
    expect(patch).toContain("a/src/corelib/thread/qmutex.h");
    expect(patch).toContain("a/src/corelib/thread/qmutex.cpp");
    // Both hunks add the same guard qfutex_p.h:41 already applies.
    expect(
      patch.match(/^\+.*&& !defined\(QT_LINUXBASE\)/gm)?.length,
    ).toBe(2);
  });

  it("keeps the resolver staging path out of the shipped library", () => {
    const build = source("packages/registry/qtbase/build-qtbase.sh");

    // Qt bakes the configure-time prefix into QtCore as qt_prfxpath. It
    // must be the guest path, with the staging directory reached only by
    // relocating at install time.
    expect(build).toContain('GUEST_PREFIX="/usr/local/qt6"');
    expect(build).toContain('-DCMAKE_INSTALL_PREFIX="$GUEST_PREFIX"');
    expect(build).toContain(
      'cmake --install "$BUILD_DIR" --prefix "$INSTALL_DIR"',
    );
    // And the recipe proves it on every build rather than trusting it.
    expect(build).toContain(
      'if strings "$INSTALL_DIR/lib/libQt6Core.a" | grep -q "build-stage"; then',
    );
    // The guard is only as good as the tool it runs, so preflight it with
    // the rest rather than letting a missing `strings` read as a pass.
    expect(build).toContain(
      "for tool in wasm32posix-c++ wasm32posix-cc cmake ninja qmake strings; do",
    );
  });

  it("keeps the <linux/fs.h> shim free of definitions", () => {
    const shim = source("packages/registry/qtbase/src/include/linux/fs.h");

    // qfilesystemengine_unix.cpp:68 defines FICLONE itself when the header
    // does not carry it. Defining it here instead would pin the ioctl
    // number in the shim, where nothing checks it against Qt's own value.
    expect(shim).not.toMatch(/^#\s*define\s+FICLONE/m);
    expect(shim).not.toMatch(/^#\s*define\s+FS_/m);
    // Only the include guard.
    expect(shim.match(/^#\s*define\s+\w+/gm)).toEqual([
      "#define KANDELO_SHIM_LINUX_FS_H",
    ]);
  });

  it("rejects a host Qt whose version differs from the target", () => {
    const manifest = source("packages/registry/qtbase/package.toml");
    const build = source("packages/registry/qtbase/build-qtbase.sh");

    // The resolver understands only `>=`, so the exact match CMake needs
    // is enforced by the recipe itself.
    expect(manifest).toContain('name = "qmake"');
    expect(manifest).toContain('version_constraint = ">=6.10.2"');
    expect(build).toContain(
      'if [ "$HOST_QT_VERSION" != "$QTBASE_VERSION" ]; then',
    );
    expect(build).toContain('QT_HOST_PATH');
  });

  it("declares every repository-local input that reaches the cache key", () => {
    const buildToml = source("packages/registry/qtbase/build.toml");

    // script_path is not implicit: only what `inputs` names is hashed, so
    // an omission here means editing the recipe does not invalidate the
    // cache. Every tracked file the build reads must be listed.
    for (const input of [
      "packages/registry/qtbase/build-qtbase.sh",
      "packages/registry/qtbase/src/qmutex-honour-qt-linuxbase.patch",
      "packages/registry/qtbase/src/include/linux/fs.h",
      "scripts/package-build-roots.sh",
    ]) {
      expect(buildToml).toContain(`"${input}"`);
    }
  });

  it("ships the static libraries the Qt stack above it links against", () => {
    const manifest = source("packages/registry/qtbase/package.toml");

    for (const lib of [
      "lib/libQt6Core.a",
      "lib/libQt6Gui.a",
      "lib/libQt6WaylandClient.a",
      "lib/libQt6Concurrent.a",
      "lib/libQt6Xml.a",
      "lib/libQt6BundledPcre2.a",
    ]) {
      expect(manifest).toContain(`"${lib}"`);
    }
    // Every library QtGui and the Wayland plugin read comes from the
    // registry; PCRE2 stays bundled because QRegularExpression needs the
    // 16-bit build and the registry package ships only libpcre2-8.a.
    for (const dep of [
      "libcxx@21.1.7",
      "zlib@1.3.1",
      "freetype@2.13.3",
      "fontconfig@2.15.0",
      "harfbuzz@10.1.0",
      "libpng@1.6.43",
      "libxkbcommon@1.7.0",
      "libwayland@1.24.0",
    ]) {
      expect(manifest).toContain(`"${dep}"`);
    }
    const build = source("packages/registry/qtbase/build-qtbase.sh");
    expect(build).toContain("-DFEATURE_system_zlib=ON");
    expect(build).toContain("-DFEATURE_system_pcre2=OFF");
  });

  it("builds the Wayland platform plugin qtbase 6.10 absorbed", () => {
    const build = source("packages/registry/qtbase/build-qtbase.sh");

    // src/plugins/platforms/wayland/CMakeLists.txt:9 returns early unless
    // both features hold, and the second needs the host generator
    // flake.nix supplies.
    expect(build).toContain("-DFEATURE_gui=ON");
    expect(build).toContain("-DFEATURE_qtwaylandscanner=ON");
    // The target has no X server and no framebuffer, so wayland is the
    // only truthful default.
    expect(build).toContain("-DQT_QPA_DEFAULT_PLATFORM=wayland");
    // OpenGL is refused through Qt's own input, not FEATURE_opengl:
    // gui/configure.cmake:1753 raises an error unless INPUT_opengl reads
    // exactly 'no'.
    expect(build).toContain("-DINPUT_opengl=no");
  });
});
