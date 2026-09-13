/**
 * Point a fork-module at the dylink loader archive it reconciles against.
 *
 * WHY THIS IS HOST CODE, and the only part of the reconcile that is: the
 * published archive belongs to the dynamic loader, not to fork. It is not in
 * the fork module-state arena, so the module cannot find it by walking its own
 * records, and the guest's `__wpk_fork_module_state_table_generation_addr`
 * import is an address INSIDE the published header (the generation fence at
 * offset 40) rather than a fork-visible root. The host is the one party that
 * already holds the head, because the host is what wrote the header there.
 *
 * WHY A CALL RATHER THAN AN IMPORT: the module could instead import the fence
 * global and subtract the header offset, which needs no host call at all. That
 * trades one host EXPORT call for one host IMPORT obligation, and imports are
 * the more expensive of the two -- every host must implement an import, while
 * an export call costs one line at one call site. See the `forkModuleHostImports`
 * rationale in docs/surface-budget.json.
 *
 * Everything downstream of the head is the module's: decoding the archive,
 * planning which table slots a generation moves (`fork_codec::dylink_table_plan`),
 * and writing them.
 */
export interface ForkTableArchive {
  /** Absolute byte offset of the published KFLA header in guest memory. */
  readonly head: number;
  /** The activation that owns the patches this worker must apply. */
  readonly owner: number;
}

interface ArchiveSeedingExports {
  readonly fm_set_table_archive?: (head: number, owner: number) => void;
  readonly fm_last_errno: () => number;
}

/**
 * Seed the archive, once per worker, before any fork drives a reconcile.
 *
 * Fails loud: a module without the entry cannot reconcile at all, and a
 * rejected head is a malformed archive rather than a missing feature.
 */
export function seedForkTableArchive(
  exports: ArchiveSeedingExports,
  archive: ForkTableArchive,
  label = "fork table archive",
): void {
  const seed = exports.fm_set_table_archive;
  if (seed === undefined) {
    throw new Error(
      `${label}: this fork-module has no fm_set_table_archive, so it cannot ` +
        `reconcile its indirect function table`,
    );
  }
  seed(archive.head, archive.owner);
  const errno = exports.fm_last_errno();
  if (errno !== 0) {
    throw new Error(
      `${label}: fm_set_table_archive rejected head ${archive.head} owner ` +
        `${archive.owner} with errno ${errno}`,
    );
  }
}
