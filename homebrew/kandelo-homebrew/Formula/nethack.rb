require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Nethack < Formula
  include KandeloFormulaSupport

  desc "NetHack dungeon exploration game for Kandelo"
  homepage "https://www.nethack.org/"
  url "https://www.nethack.org/download/3.6.7/nethack-367-src.tgz"
  sha256 "98cf67df6debf9668a61745aa84c09bcab362e5d33f5b944ec5155d44d2aacb2"
  license "NGPL"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "f15954a0ffb58783450ff8b713c3a05fcd48e56c29a75cfcb43e1d1c92ecb604"
  end

  # nethack links libncursesw/libtinfow from ncurses, resolved through Kandelo's
  # build-deps resolver at build time; the Kandelo package dependency
  # (ncurses@6.5) is recorded in the generated sidecar, keeping VFS planning data
  # out of Formula Ruby (same pattern as bash).

  skip_clean "bin/nethack"
  skip_clean "share/nethack"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    ENV["NETHACK_VERSION"] = version.to_s
    out_dir = prepare_kandelo_package_env(
      source_url: "https://www.nethack.org/download/3.6.7/nethack-367-src.tgz",
      source_sha256: "98cf67df6debf9668a61745aa84c09bcab362e5d33f5b944ec5155d44d2aacb2",
    )
    # Build from the tarball Homebrew already fetched, checksum-verified, and
    # unpacked into buildpath so the sandboxed build does not re-download from
    # nethack.org (the build sandbox blocks that fetch).
    ENV["WASM_POSIX_DEP_SOURCE_DIR"] = buildpath.to_s
    system "bash", "#{root}/packages/registry/nethack/build-nethack.sh"
    install_kandelo_wasm(out_dir, "nethack.wasm", "nethack")

    # Runtime data tree (nhdat + symbols + license) staged by the build into
    # out_dir/runtime/share/nethack. Install it under the keg's share/nethack so
    # the bottle carries the data the game opens from HACKDIR
    # (/usr/share/nethack). These files are declared in
    # packages/registry/nethack/package.toml outputs[].data_files and emitted as
    # `file` links in the generated sidecar's link manifest.
    data_src = out_dir/"runtime/share/nethack"
    odie "nethack build did not stage #{data_src}" unless data_src.directory?
    (share/"nethack").install Dir["#{data_src}/*"]
  end

  test do
    assert_kandelo_wasm "nethack"
    # `--version` early-exits after printing the version banner, before any
    # terminal or HACKDIR data init — a safe non-interactive smoke.
    assert_match "NetHack Version",
      shell_output_kandelo_wasm("nethack", ["--version"])
  end
end
