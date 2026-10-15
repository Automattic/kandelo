import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { posix } from "node:path";

import type { VfsDirEntrySnapshot, VfsPathStat } from "../host/src/vfs/vfs";

const FIXTURE_ROOT = "/run/kandelo-run";
const MAX_ENTRIES = 10_000;
const MAX_TOTAL_FILE_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const TYPE_MASK = 0o170000;
const DIRECTORY = 0o040000;
const REGULAR_FILE = 0o100000;

interface FixtureInspectionHost {
    statVfsPath(path: string): Promise<VfsPathStat | null>;
    readDirFromVfs(path: string): Promise<VfsDirEntrySnapshot[] | null>;
    readFileRangeFromVfs(path: string, offset: number, length: number): Promise<Uint8Array | null>;
}

interface FixtureEntry extends VfsPathStat {
    path: string;
    target?: string;
    sha256?: string;
}

export async function inspectPersistentFixture(host: FixtureInspectionHost): Promise<FixtureEntry[]> {
    const root = await host.statVfsPath(FIXTURE_ROOT);
    if (root === null || (root.mode & TYPE_MASK) !== DIRECTORY) {
        throw new Error(`persistent fixture root is missing or not a directory: ${FIXTURE_ROOT}`);
    }
    const result: FixtureEntry[] = [{ path: FIXTURE_ROOT, ...root }];
    const directories = [FIXTURE_ROOT];
    let remainingFileBytes = MAX_TOTAL_FILE_BYTES;
    while (directories.length > 0) {
        const directory = directories.shift()!;
        const children = await host.readDirFromVfs(directory);
        if (children === null) throw new Error(`persistent fixture directory disappeared: ${directory}`);
        const sortedChildren = [...children].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const child of sortedChildren) {
            if (child.name === "" || child.name === "." || child.name === ".." || child.name.includes("/") || child.name.includes("\0")) {
                throw new Error(`invalid persistent fixture entry: ${JSON.stringify(child.name)}`);
            }
            if (result.length >= MAX_ENTRIES) throw new Error(`persistent fixture exceeds ${MAX_ENTRIES} entries`);
            const path = posix.join(directory, child.name);
            const entry: FixtureEntry = {
                path,
                mode: child.mode,
                size: child.size,
                uid: child.uid,
                gid: child.gid,
                ...(child.target === undefined ? {} : { target: child.target }),
            };
            if ((child.mode & TYPE_MASK) === DIRECTORY) {
                directories.push(path);
            } else if ((child.mode & TYPE_MASK) === REGULAR_FILE && child.size <= remainingFileBytes) {
                const digest = createHash("sha256");
                let offset = 0;
                while (offset < child.size) {
                    const length = Math.min(READ_CHUNK_BYTES, child.size - offset);
                    const bytes = await host.readFileRangeFromVfs(path, offset, length);
                    if (bytes === null || bytes.byteLength !== length) {
                        throw new Error(`persistent fixture file changed during inspection: ${path}`);
                    }
                    digest.update(bytes);
                    offset += length;
                }
                entry.sha256 = digest.digest("hex");
                remainingFileBytes -= child.size;
            }
            result.push(entry);
        }
    }
    return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function assertPersistentFixtureUnchanged(before: FixtureEntry[], after: FixtureEntry[]): void {
    if (isDeepStrictEqual(before, after)) return;
    const count = Math.max(before.length, after.length);
    for (let index = 0; index < count; index++) {
        if (!isDeepStrictEqual(before[index], after[index])) {
            throw new Error(`persistent fixture changed after reboot at ${before[index]?.path ?? after[index]?.path}: ${JSON.stringify({ before: before[index], after: after[index] })}`);
        }
    }
}
