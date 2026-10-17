# Real SQL and PHP reference tests, without changing the main development shell.
{ system ? builtins.currentSystem }:
let
  root = builtins.getFlake (toString ../../../..);
  pkgs = import root.inputs.nixpkgs { inherit system; };
in pkgs.symlinkJoin {
  name = "kandelo-spacefast-signalling-test-tools";
  paths = [ pkgs.mariadb pkgs.php ];
}
