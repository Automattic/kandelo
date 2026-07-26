export function verifyImportedSealsForCurrentBoot(fs: {
  verifyImportedLazyAtomicGroupSeals(): Promise<void>;
}): Promise<void> {
  // WHY: return the filesystem's exact promise rather than awaiting it here.
  // The owning boot must recheck ownership immediately after its await; an
  // async wrapper would add a microtask in which a newer boot could supersede
  // this one after the helper's check but before the caller's side effects.
  return fs.verifyImportedLazyAtomicGroupSeals();
}
