import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

/**
 * Check if the current module is being run directly (not imported).
 * Handles npm link symlinks by comparing resolved real paths.
 */
export function isMain(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  const thisFile = realpathSync(fileURLToPath(importMetaUrl));
  const entryFile = realpathSync(process.argv[1]);
  return thisFile === entryFile;
}
