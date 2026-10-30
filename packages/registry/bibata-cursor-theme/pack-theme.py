#!/usr/bin/env python3
"""Package verified upstream Xcursor bytes, checking the published data contract."""
from pathlib import Path
import json
import os
import stat
import struct
import sys
import zipfile

SIZES = (16, 20, 22, 24, 28, 32, 40, 48, 56, 64, 72, 80, 88, 96)
IMAGE_TYPE = 0xFFFD0002
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TREE_BYTES = 64 * 1024 * 1024


def parse_xcursor(data):
    """Validate the real little-endian Xcursor TOC and every image chunk."""
    if not 16 <= len(data) <= MAX_FILE_BYTES:
        raise ValueError("Xcursor file size outside package bounds")
    magic, header, version, count = struct.unpack_from("<4I", data)
    if magic != 0x72756358 or header != 16 or version != 0x10000 or not 1 <= count <= 4096:
        raise ValueError("invalid Xcursor file header")
    toc_end = header + count * 12
    if toc_end > len(data):
        raise ValueError("truncated Xcursor TOC")
    images = []
    for i in range(count):
        kind, nominal, offset = struct.unpack_from("<3I", data, header + i * 12)
        if kind != IMAGE_TYPE or nominal not in SIZES or not toc_end <= offset <= len(data) - 36:
            raise ValueError("invalid Xcursor image TOC")
        chunk_header, chunk_type, subtype, image_version, width, height, xhot, yhot, delay = struct.unpack_from("<9I", data, offset)
        if (chunk_header, chunk_type, subtype, image_version) != (36, IMAGE_TYPE, nominal, 1):
            raise ValueError("invalid Xcursor image header")
        if not (1 <= width <= 96 and 1 <= height <= 96 and xhot < width and yhot < height):
            raise ValueError("invalid Xcursor geometry/hotspot")
        end = offset + chunk_header + width * height * 4
        if end > len(data):
            raise ValueError("truncated Xcursor image pixels")
        pixels = data[offset + chunk_header:end]
        if not any(pixels[3::4]):
            raise ValueError("Xcursor image is completely transparent")
        images.append({"size": nominal, "width": width, "height": height,
                       "xhot": xhot, "yhot": yhot, "delay": delay})
    if set(image["size"] for image in images) != set(SIZES):
        raise ValueError("cursor lacks the declared 16–96 size inventory")
    return images


def theme_entries(source, notices):
    source = source.resolve(strict=True)
    cursors = source / "cursors"
    if not cursors.is_dir() or cursors.is_symlink():
        raise ValueError("verified theme lacks a real cursors directory")
    files, aliases, inventory = {}, {}, {}
    for path in sorted(cursors.iterdir()):
        if path.is_symlink():
            target = os.readlink(path)
            # The pinned release aliases stay inside their one cursor directory.
            if not target or Path(target).name != target or target in (".", ".."):
                raise ValueError(f"unsafe theme alias: {path.name}")
            aliases[path.name] = target
        elif path.is_file():
            data = path.read_bytes()
            inventory[path.name] = parse_xcursor(data)
            files[path.name] = data
        else:
            raise ValueError(f"unsupported cursor entry: {path.name}")
    if (len(files), len(aliases)) != (56, 89):
        raise ValueError("unexpected compiled release cursor/alias inventory")
    for name in aliases:
        target, visited = name, set()
        while target in aliases:
            if target in visited:
                raise ValueError(f"cyclic theme alias: {name}")
            visited.add(target)
            target = aliases[target]
        if target not in files:
            raise ValueError(f"dangling theme alias: {name}")
    if aliases.get("default") != "left_ptr" or aliases.get("text") != "xterm" or aliases.get("pointer") != "hand2":
        raise ValueError("required default/text/pointer aliases are missing")
    entries = {}
    prefix = "icons/Bibata-Modern-Ice/"
    for name, data in files.items(): entries[prefix + "cursors/" + name] = (data, stat.S_IFREG | 0o644)
    for name, target in aliases.items(): entries[prefix + "cursors/" + name] = (target.encode(), stat.S_IFLNK | 0o777)
    for name in ("index.theme", "cursor.theme"):
        path = source / name
        if not path.is_file() or path.is_symlink(): raise ValueError(f"missing regular {name}")
        entries[prefix + name] = (path.read_bytes(), stat.S_IFREG | 0o644)
    entries["icons/default/index.theme"] = (b"[Icon Theme]\nName=Default\nInherits=Bibata-Modern-Ice\n", stat.S_IFREG | 0o644)
    for name in ("COPYING", "NOTICE"):
        entries["licenses/bibata-cursor-theme/" + name] = ((notices / name).read_bytes(), stat.S_IFREG | 0o644)
    if sum(len(data) for data, _ in entries.values()) > MAX_TREE_BYTES:
        raise ValueError("cursor archive exceeds its bounded data budget")
    return entries, inventory


def package(source, output):
    entries, inventory = theme_entries(source, Path(__file__).resolve().parent)
    if output.exists(): raise ValueError("refusing to replace an existing package output")
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, (data, mode) in sorted(entries.items()):
            info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = mode << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    print(json.dumps({"cursors": len(inventory), "aliases": 89, "sizes": SIZES,
                      "uncompressed_bytes": sum(len(data) for data, _ in entries.values()),
                      "archive_bytes": output.stat().st_size}))


if __name__ == "__main__":
    if len(sys.argv) != 3: raise SystemExit("usage: pack-theme.py <verified source> <new output.zip>")
    package(Path(sys.argv[1]), Path(sys.argv[2]))
