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
          ];

          shellHook = ''
            export LLVM_BIN=${llvmTree}/bin
            export LLVM_PREFIX=${llvmTree}
            export LLVM_VERSION=21
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
