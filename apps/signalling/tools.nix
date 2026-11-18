# Keep PHP test tools app-scoped; package builds use the root dev shell.
# nixpkgs comes from the root flake's lock, not getFlake, which would copy the
# whole worktree into the store on every evaluation.
{ system ? builtins.currentSystem }:
let
  lock = builtins.fromJSON (builtins.readFile ../../flake.lock);
  nixpkgs = builtins.fetchTree lock.nodes.${lock.nodes.${lock.root}.inputs.nixpkgs}.locked;
  pkgs = import nixpkgs { inherit system; };
in pkgs.symlinkJoin {
  name = "kandelo-signalling-test-tools";
  paths = [ pkgs.php pkgs.phpPackages.composer ];
}
