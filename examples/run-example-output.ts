import { writeSync } from "fs";

export type WriteBytes = (
    fd: number,
    data: Uint8Array,
    offset: number,
    length: number,
) => number;

const writeBytes: WriteBytes = (fd, data, offset, length) =>
    writeSync(fd, data, offset, length, null);

export function writeAllSync(
    fd: number,
    data: Uint8Array,
    write: WriteBytes = writeBytes,
): void {
    let offset = 0;
    while (offset < data.byteLength) {
        const written = write(fd, data, offset, data.byteLength - offset);
        if (written <= 0) throw new Error("short write to guest output sink");
        offset += written;
    }
}
