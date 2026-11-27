# libmad

Static libmad 0.16.4 MPEG audio decoder for wasm32. ScummVM consumes the
normal `libmad.a` and `mad.pc` outputs. The CMake recipe selects portable
64-bit fixed-point arithmetic and disables architecture-specific assembly.

The source is the upstream Codeberg 0.16.4 tag archive, verified against
SHA-256 `f4eb229452252600ce48f3c2704c9e6d97b789f81e31c37b0c67dd66f445ea35`.
Its CMake project declares version 0.16.4. The former Debian source URL
returned HTTP 404 during the canonical desktop build; this switches archive
packaging, without upgrading the library version or bypassing verification.
The normal resolver must rebuild this source generation and its consumers.

Upstream's archive has no man pages; its header and source README document
the library API.
