/*
 * Hand-curated config.h for the wasm32-posix-kernel libevdev port
 * (packages/registry/libevdev), pinned to libevdev 1.13.3.
 *
 * We bypass upstream's meson build because its feature probes run against
 * the build host, not the wasm sysroot (see build-libevdev.sh and
 * docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5). libevdev's
 * meson `configuration_data` sets exactly one macro — `_GNU_SOURCE` — and
 * its sources reference no HAVE_* flags (verified by grep over the
 * libevdev C sources and headers), so this file is intentionally just
 * that one define.
 * The `_Float128` block upstream adds is gated on the `coverity` option
 * and is irrelevant here.
 */
#ifndef LIBEVDEV_WASM_CONFIG_H
#define LIBEVDEV_WASM_CONFIG_H

#define _GNU_SOURCE 1

#endif /* LIBEVDEV_WASM_CONFIG_H */
