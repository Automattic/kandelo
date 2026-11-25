import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceOnlyBinarySnapshotSession } from '../../../../host/src/binary-resolver';
import { ensureDirRecursive, writeVfsBinary } from '../../../../host/src/vfs/image-helpers';
import { KandeloImageFs } from '../../../../images/vfs/lib/kandelo-image-fs';
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const inventoryBytes = readFileSync(resolve(fixtures, 'npm-cases.json'));
export const npmInventory = JSON.parse(inventoryBytes.toString());
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function npmTestInputs() {
    const snapshots = createSourceOnlyBinarySnapshotSession().snapshots(['kernel.wasm', 'programs/wasm32/shell.vfs.zst'], 128 * 1024 * 1024);
    if (snapshots.some(snapshot => snapshot === null)) {
        throw Error('Build browser-main-shell before running the npm package regressions');
    }
    const [kernel, shell] = snapshots.map(snapshot => snapshot!);
    const fs = KandeloImageFs.create();
    fs.loadImage(shell!.bytes);
    if (!fs.isPathDeferred('/usr/bin/node'))
        throw Error('Expected the normal lazy Node archive');
    const tarball = readFileSync(resolve(fixtures, 'kandelo-install-fixture-0.0.1.tgz'));
    if (sha(tarball) !== '6d96cae986a84022911d7507ce5713e56284ec89b51fd017d1b5484a8651e460')
        throw Error('Changed npm fixture tarball');
    for (const [name, bytes] of [
        ['package.tgz', tarball],
        ...['fixture-package.json', 'install-driver.cjs', 'verify-local.cjs']
            .map(name => [name, readFileSync(resolve(fixtures, name))]),
    ] as Array<[
        string,
        Uint8Array
    ]>) {
        const path = '/usr/share/node-npm-fixture/' + name;
        ensureDirRecursive(fs, dirname(path));
        writeVfsBinary(fs, path, bytes, 0o644);
    }
    if (!fs.isPathDeferred('/usr/bin/node'))
        throw Error('Expected the normal lazy Node archive');
    const image = await fs.saveImage();
    return { image, kernel: kernel!.bytes, inventory: npmInventory, identities: { kernel: kernel!.sha256, canonicalShell: shell!.sha256, inventory: sha(inventoryBytes) } };
}
