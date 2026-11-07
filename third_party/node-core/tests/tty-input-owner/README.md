# Focused captured-input controls

These are explicit no-global-setup native/reference controls. Run through the
declared devshell. They do not resolve/build an engine, kernel, sysroot or product.

* descriptor-identity-control.cpp: independent canonical-mode real PTY/OFD read,
  public-fd replacement and exact owned-close tests. Passing these14 checks does
  not establish raw-mode or native JSAPI behavior.
* input-control.cpp: strict raw-to-normal comparison against native words supplied
  on its command line (four initial, four normal words). It remains nonpassing.
  Earlier failing control sources are retained in the capsule.
* attributes-addon.cpp: tiny NAPI observer performing real tcgetattr and descriptor
  duplication synchronously inside native Node callbacks. It provides no fake
  TTY state and is not the candidate's production native backend.
* native-reference.py/.cjs: pinned native26 and two actual posix_openpt PTYs, real
  alias/close/reuse/read/mode/close sequence and exact termios observations. Node
  binary SHA is verified; pass the compiled attributes addon as the second arg.

The capsule supplies exact commands/hashes/preimages and preserves every native
abort. Public constructors are not implemented by this prerequisite.
