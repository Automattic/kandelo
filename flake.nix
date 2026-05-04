{
  description = "wasm-posix-kernel dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, rust-overlay, flake-utils }:
    flake-utils.lib.eachSystem [
      "aarch64-darwin"
      "x86_64-darwin"
      "x86_64-linux"
      "aarch64-linux"
    ] (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };

        rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

        llvmPkg = pkgs.llvmPackages_21;

        # Combined tree so LLVM_PREFIX/bin contains clang + llvm-* + wasm-ld,
        # and LLVM_PREFIX/include/c++/v1 contains libc++ headers — matching
        # the layout the build scripts expect from a Homebrew LLVM install.
        # libcxx.dev carries the standard-library headers (iostream, cstring,
        # etc.) — without the .dev output, only the runtime modules at
        # share/libc++/v1 are present and C++ source builds fail with
        # "'cstring' file not found".
        llvmTree = pkgs.symlinkJoin {
          name = "llvm-21-tree";
          paths = [
            llvmPkg.clang-unwrapped
            llvmPkg.llvm
            llvmPkg.lld
            llvmPkg.libcxx
            llvmPkg.libcxx.dev
          ];
        };
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            rustToolchain
            llvmTree
            # Node 24, not 22: the host code constructs
            # WebAssembly.Memory with address: "i64" + BigInt
            # initial/max (memory64), which V8 12.4 (Node 22) does
            # not enable by default. V8 12.9 (Node 24) ships with
            # memory64 on, matching the host Macs the team develops
            # on (homebrew node 24/25).
            pkgs.nodejs_24
            pkgs.erlang_28
            pkgs.cmake
            pkgs.autoconf
            pkgs.automake
            pkgs.libtool
            pkgs.pkg-config
            pkgs.gnumake
            pkgs.bash
            pkgs.wget
            pkgs.zstd
            pkgs.git
            pkgs.binaryen
            pkgs.wabt
            # System tools that build scripts pull from /usr/bin or
            # /opt/homebrew/bin in non-pure shells. Pinning them via
            # the flake makes `nix develop --ignore-environment` work
            # (so `bash examples/libs/<pkg>/build-*.sh` reproduces CI
            # locally) and removes silent host-version drift between
            # darwin dev boxes and the Ubuntu CI runner. Each is
            # invoked by ≥1 build script:
            #   curl   — every download step (40+ scripts)
            #   perl   — openssl Configure, mariadb cmake codegen,
            #            wget configure, libxml2 (xmllint), etc.
            #   python3 — perl-cross checksize patch, ruby
            #            mkconfig, cpython itself, file's
            #            magic-build, etc.
            #   flex/bison — bash, m4, mariadb (yacc-style parsers)
            #   xz     — extracting .tar.xz tarballs (sed, m4, …)
            #   patch  — applying *.patch files (mariadb, ruby)
            #   gh     — only used by stage-pr-staging release lookup
            pkgs.curl
            pkgs.perl
            pkgs.python3
            pkgs.flex
            pkgs.bison
            pkgs.xz
            pkgs.gnupatch
            pkgs.gh
            # rsync — build-vim-zip.sh / build-shell-vfs-image.sh
            #   use it to copy vim's runtime tree.
            # jq    — fetch-binaries / verify-release / publish-release
            #   parse manifest.json against expected schema.
            # unzip — sqlite source tarball is a .zip; tcl + several
            #   other releases also ship .zip.
            pkgs.rsync
            pkgs.jq
            pkgs.unzip
            # `zip` for build-vim-zip.sh / build-nethack-zip.sh which
            # bundle the vim/nethack runtime trees into the .zip
            # lazy-archives mounted by the shell VFS image. Note: the
            # `examples/libs/zip/` registry entry builds a wasm32 zip
            # binary for user programs — different from the host
            # packager pkgs.zip.
            pkgs.zip
            # texinfo provides `makeinfo` — autotools projects (bc,
            # gawk, m4, …) call it to generate .info docs from .texi
            # sources. Without it, configure passes (it's only
            # WANT_-but-not-required at configure time) and the build
            # dies later with "makeinfo: command not found" on every
            # `*.info` rule.
            pkgs.texinfo
            # Mozilla CA bundle — Nix's curl is built against
            # cacert and looks up its bundle via SSL_CERT_FILE /
            # NIX_SSL_CERT_FILE / GIT_SSL_CAINFO. Pure-shell
            # (`scripts/dev-shell.sh` uses --ignore-environment)
            # strips those env vars from the parent, so without
            # cacert in the flake + the shellHook export below,
            # every HTTPS download fails with curl exit 77 ("Problem
            # with the SSL CA cert"). All ~50 build scripts fetch
            # sources via curl over HTTPS, so this is load-bearing.
            pkgs.cacert
            # libcrypt.so.1 (legacy SONAME) for host miniperl. Ubuntu
            # 24.04 dropped libcrypt.so.1 from default install (libc
            # split crypt(3) out into libxcrypt, which carries
            # libcrypt.so.2 only). perl-cross's host-side Configure
            # link-tests `crypt(3)`, succeeds against the Nix stdlib's
            # libxcrypt-2 symbol-aliases, and bakes
            # `DT_NEEDED libcrypt.so.1` into the resulting miniperl
            # ELF. The dynamic loader can't resolve `.so.1` without
            # this package, so the next make step
            # (`./miniperl_top make_patchnum.pl`) dies with
            # "cannot open shared object file". libxcrypt-legacy
            # explicitly carries the .so.1 SONAME and rpath-binds via
            # the gcc-wrapper.
            pkgs.libxcrypt-legacy
            # Host-side ncurses for MariaDB's Step 1 host build. Its
            # CMake unconditionally calls MYSQL_CHECK_READLINE →
            # FIND_CURSES (CMakeLists.txt:416 → cmake/readline.cmake)
            # even when -DWITH_EDITLINE=bundled is passed; without
            # this, configure fails with "Could NOT find Curses
            # (missing: CURSES_LIBRARY CURSES_INCLUDE_PATH)" before
            # `import_executables.cmake` is generated, so the wasm32
            # cross-build can't proceed. Nix's CMake searches Nix-store
            # paths only, so installing libncurses-dev on the host
            # doesn't help — the lib has to come from nixpkgs.
            pkgs.ncurses
            # sqlite3 CLI — host-side test helper. The WordPress
            # site-editor test (`examples/wordpress/test/wordpress-
            # site-editor.test.ts`) polls the WP install's SQLite DB
            # via `execSync("sqlite3 ...")` to detect when WP is
            # ready; without this every poll prints "/bin/sh: 1:
            # sqlite3: not found" and the test eventually times out
            # at 10 minutes. Different from the wasm32 sqlite we
            # cross-build under examples/libs/sqlite/ — that's the
            # target binary, this is the host CLI used by tests.
            pkgs.sqlite
          ];

          shellHook = ''
            export LLVM_BIN=${llvmTree}/bin
            export LLVM_PREFIX=${llvmTree}
            export LLVM_VERSION=21
            # CA bundle for HTTPS — pure-shell strips the user's
            # SSL_CERT_FILE; without an explicit re-export, every
            # `curl https://…` returns exit 77 ("Problem with the
            # SSL CA cert"). pkgs.cacert ships the Mozilla bundle.
            export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            export NIX_SSL_CERT_FILE="$SSL_CERT_FILE"
            export GIT_SSL_CAINFO="$SSL_CERT_FILE"
            # Make libcrypt.so.1 findable at runtime for host miniperl
            # built by perl-cross. mkShell rpath-binds via gcc-wrapper
            # at link time, but if the perl-cross link line comes from
            # an unwrapped invocation (or the wrapper's rpath rules
            # don't fire for SONAME=.so.1), the dynamic loader falls
            # back to LD_LIBRARY_PATH. Belt-and-suspenders.
            export LD_LIBRARY_PATH="${pkgs.libxcrypt-legacy}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            # Put the worktree-local SDK shims on PATH so wasm32posix-cc
            # / wasm64posix-cc resolve without requiring contributors to
            # source sdk/activate.sh manually. Mirrors what activate.sh
            # does — kept idempotent + tolerant of being run from a
            # subdirectory by anchoring on the flake's repo root via
            # `git rev-parse`. Falls back to $PWD if git isn't usable
            # (shouldn't happen in this repo, but cheap to guard).
            __repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
            if [ -d "$__repo_root/sdk/bin" ]; then
              case ":$PATH:" in
                *:"$__repo_root/sdk/bin":*) ;;
                *) export PATH="$__repo_root/sdk/bin:$PATH" ;;
              esac
            fi
            unset __repo_root
            echo "wasm-posix-kernel dev shell — LLVM 21, Rust (pinned via rust-toolchain.toml), Node 24, Erlang 28, SDK on PATH"
          '';
        };
      });
}
