# SDL2 KMSDRM restore regression

`0009-kmsdrm-restore-disabled-crtc.patch` is a generic upstreamable correction,
carried with the maintainer's explicit D-60 approval. It is not submitted or
accepted upstream. An originally disabled CRTC must be restored with no
framebuffer, connectors or mode. A preferred mode selected for SDL's window
does not change that saved state. Real restore errors retain `SDL_LogError`.

Run from the declared development shell, supplying the verified release
archives named by the SDL2 and libdrm manifests:

```sh
scripts/dev-shell.sh python3 packages/registry/sdl2/test/check-kmsdrm-restore.py \
  --sdl-archive /path/to/SDL2-2.32.10.tar.gz \
  --libdrm-archive /path/to/libdrm-2.4.134.tar.xz \
  --output /path/to/new-private-results
```

The check verifies both archive hashes, applies the complete SDL recipe patch
series without fuzzy matching, and compiles actual extracted SDL selection and
restore code together with actual libdrm Get/Set CRTC bodies and UAPI types.
The ioctl boundary is a double, not Linux hardware or Kandelo execution.
The same assertions reject the original disabled-display request and require
correct disabled/enabled requests, preserved saved state, unchanged enabled
observations and loud injected EACCES failures. Strict warnings and undefined
behavior sanitization are enabled. Results and diagnostics remain in the
exclusive output directory.

This source control does not replace normal SDL/application rebuilds,
Node/browser tests, three-engine Freeciv/ScummVM rendering checks or native-feel
measurements. Upstream submission should include a native KMS reproduction;
no native-hardware validation is claimed here.
