export async function verifyImportedSealsForCurrentBoot(
  fs: { verifyImportedLazyAtomicGroupSeals(): Promise<void> },
  assertCurrent: () => void,
): Promise<void> {
  await fs.verifyImportedLazyAtomicGroupSeals();
  // WHY: asynchronous trust checks may outlive the boot that started them.
  // Re-establish ownership before its continuation can perform side effects.
  assertCurrent();
}
