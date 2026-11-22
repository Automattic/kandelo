/** One authored closure for SDK artifacts and the normal shell's lazy refs. */
import { readFileSync } from 'node:fs';
export const SHARED_DESKTOP_PACKAGE = 'shared-desktop-programs';
export const SHARED_DESKTOP_PACKAGE_ROOT = '/usr/libexec/kandelo/shared-desktop/';
export const sharedDesktopPackagePrograms = JSON.parse(readFileSync(
  new URL('../../../packages/registry/shared-desktop-programs/programs.json', import.meta.url), 'utf8')) as {
    id: string; dependency: string; artifact: string; guestPath: string; imageDependency?: string; requested?: string;
  }[];
export const sharedDesktopPackageArchives = sharedDesktopPackagePrograms.map(program => ({
  id: 'shared-desktop-' + program.id, dependency: SHARED_DESKTOP_PACKAGE,
  resolverPath: `programs/${SHARED_DESKTOP_PACKAGE}/${program.id}.zip`,
  mountPrefix: `${SHARED_DESKTOP_PACKAGE_ROOT}${program.id}/` as `/${string}/`,
  requiredMember: 'program.wasm',
}));

/** Partial images deliberately install only named packages, not all build dependencies. */
export const SHARED_DESKTOP_IMAGE_PACKAGES = [
  'shared-desktop-programs', 'cage', 'foot', 'sway', 'swaybg', 'sfwbar',
  'freeciv-browser-bundle', 'scummvm-static', 'curl', 'unzip', 'sysklogd',
  'desktop-data', 'bibata-cursor-theme',
] as const;
export const SHARED_DESKTOP_PARTIAL_COMMAND = './run.sh partial shell ' + SHARED_DESKTOP_IMAGE_PACKAGES.join(' ');

/** Authored metadata for canonical and selected development desktop builds. */
export const SHARED_DESKTOP_DEMO_CONFIG_PATH = new URL('../config/shared-desktop-demo.json', import.meta.url);
