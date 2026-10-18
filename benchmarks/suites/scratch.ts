/**
 * Scratch directories for the Node application benchmarks.
 *
 * Why they live outside the checkout: the Node suites run guest programs
 * straight on the host filesystem, so every path a guest touches is a real
 * host path. Work that walks or mirrors a path then scales with how deep the
 * checkout sits on disk. PHP's opcache file cache, for one, recreates each
 * script's absolute path inside the cache, one directory at a time. A
 * before/after comparison between two checkouts at different depths
 * measures their locations instead of the change: a checkout one directory
 * deeper cost WordPress ~560 extra mkdir calls per run.
 *
 * The OS temp directory is the same for every checkout on a machine, and
 * mkdtemp names have a fixed length, so anything staged here has the same
 * guest-visible paths whichever checkout runs the benchmark. The temp
 * directory is resolved through realpath because guests (and opcache) see
 * resolved paths; on macOS /var is a symlink to /private/var.
 *
 * Alternative rejected: mounting the data at fixed guest paths
 * (NodeKernelHost extraMounts). Those mounts exist only under a rootfs
 * image, and moving the suites onto an image-backed root would change what
 * they measure, not just where their files live.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh, empty benchmark scratch directory named for `label`. */
export function createBenchmarkScratchDirectory(
  label: string,
  parent: string = realpathSync(tmpdir()),
): string {
  return mkdtempSync(join(parent, `kandelo-bench-${label}-`));
}
