# Historical separate desktop image

The normal shell image now owns the Cage, Sway and Sway/SFWBar profiles and
Activities. It retains ordinary executables, selects private SDK alternatives
for desktop launches and uses the normal computer storage policy. See
[shared desktop artifacts](../shared-desktop-programs/README.md).

This dormant recipe is retained to reproduce the earlier separate, temporary
image. It is excluded from the default build and browser gallery. Its closure
replaces ordinary executables with SDK variants; it is not the normal shell
integration and must not be used as evidence for that integration.

The recipe still uses the normal rootfs/shell composer, SDK/package archives,
permissions and image checks. It composes bytes without running an SDK compiler,
so its build toolchain is `none`. To validate the retained recipe explicitly,
run from the declared development shell:

```sh
export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
cargo xtask build-deps resolve shared-desktop --arch wasm32 --binaries-dir binaries
```

This does not reactivate a product or update an existing preview. The normal
app/game consumers select the shell profiles, not this historical image.
Persistent writable shared mappings and changing shared-object sizes remain
unsupported.
