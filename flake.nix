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
        llvmTree = pkgs.symlinkJoin {
          name = "llvm-21-tree";
          paths = [
            llvmPkg.clang-unwrapped
            llvmPkg.llvm
            llvmPkg.lld
            llvmPkg.libcxx
          ];
        };
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            rustToolchain
            llvmTree
            pkgs.nodejs_22
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
            echo "wasm-posix-kernel dev shell — LLVM 21, Rust (pinned via rust-toolchain.toml), Node 22, Erlang 28"
          '';
        };
      });
}
