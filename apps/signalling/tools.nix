# Keep PHP test tools app-scoped; package builds use the root dev shell.
{ system ? builtins.currentSystem }:
let
  root = builtins.getFlake (toString ../..);
  pkgs = import root.inputs.nixpkgs { inherit system; };
in pkgs.symlinkJoin {
  name = "kandelo-signalling-test-tools";
  paths = [ pkgs.php pkgs.phpPackages.composer ];
}
