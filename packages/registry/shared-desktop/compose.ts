/** Canonical product: declared package bytes, ordinary image composition, lazy refs. */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLockedPackageManifestDependencies } from '../shell/source-rootfs-shell-dependency-contract.mjs';
import { buildSourceRootfsShellImage, strictResolverFromDependencyEnvironment } from '../../../images/vfs/scripts/build-source-rootfs-shell-image';
import { SHARED_DESKTOP_DEMO_CONFIG_PATH } from '../../../images/vfs/scripts/shared-desktop-package-contract';

const here = import.meta.dirname, repo = resolve(here, '../../..');
const out = process.env.WASM_POSIX_DEP_OUT_DIR;
if (!out || !process.env.WASM_POSIX_DEP_WORK_DIR) throw Error('Desktop image needs resolver-owned roots');
const deps = readLockedPackageManifestDependencies(join(here, 'package.toml')) as {name: string; version: string}[];
const packages = new Set(deps.map(dep => dep.name));
const artifact = strictResolverFromDependencyEnvironment(process.env, packages);
const input = (owner: string, file: string) => artifact(`programs/${owner}/${file}`, owner);
await buildSourceRootfsShellImage({
  rootfsPath: input('rootfs', 'rootfs.vfs.zst'),
  caBundlePath: input('ca-certificates', 'ca-certificates.zip'),
  bashPath: input('bash', 'bash.wasm'),
  desktopDataPath: input('desktop-data', 'kandelo-desktop-data.zip'),
  libinputQuirksPath: input('desktop-data', 'libinput-quirks.zip'),
  xkeyboardConfigPath: input('desktop-data', 'xkeyboard-config.zip'),
  demoConfigPath: fileURLToPath(SHARED_DESKTOP_DEMO_CONFIG_PATH),
  eagerBudgetPath: join(repo, 'packages/registry/shell/eager-budget.json'),
  outFile: join(out, 'shared-desktop.vfs.zst'),
  selection: {kind: 'desktop', packages},
  resolveArtifact: artifact,
});
