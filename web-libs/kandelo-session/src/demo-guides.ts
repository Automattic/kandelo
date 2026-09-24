/**
 * The DOOM shareware WAD's identity.
 *
 * What is left of this module. It used to hold `builtinDemoGuide`,
 * `builtinDemoPresentation`, and `builtinDemoAssets` — per-demo-id tables the
 * browser app consulted whenever an image's own `/etc/kandelo/demo.json` did
 * not answer, and which the image builders ALSO imported as content to bake
 * in. One file was therefore both the build-time source and the runtime
 * fallback for the same data, which is exactly the dual authority
 * `docs/superpowers/specs/2026-09-22-image-owned-machine-definitions-design.md`
 * removes: every machine is now declared by the image it lives in, and an
 * image that declares nothing gets nothing invented for it.
 *
 * These two constants survive because they are not machine metadata: they
 * identify one external artifact, and
 * `tests/package-system/source-rootfs-shell-bridge.test.ts` asserts that the
 * shell image's tracked demo config points the doom profile at exactly this
 * URL and digest.
 */
export const DOOM_WAD_URL = "https://cdn.jsdelivr.net/gh/gaborbata/vanilla-mocha-doom@15825a07a48806bcfb242a42afd5ee7cb3c9a3a4/wads/doom1.wad";
export const DOOM_WAD_SHA256 = "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771";
