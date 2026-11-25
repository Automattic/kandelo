"""Read Wasm or static-archive symbols with the configured LLVM nm."""


def iter_wasm_symbols(binary, get_output, nm):
    with open(binary, "rb") as stream:
        magic = stream.read(8)
    if not (magic.startswith(b"\0asm") or magic == b"!<arch>\n"):
        raise RuntimeError("Unsupported Wasm networking-check input: " + binary)
    # POSIX nm output gives one raw symbol name/type per line. Scan all symbols
    # so a valid archive with no imports is distinguishable from failed parsing.
    for line in get_output(nm, "--format=posix", binary):
        fields = line.split()
        if not fields or (len(fields) == 1 and fields[0].endswith(":")):
            continue
        if len(fields) < 2 or len(fields[1]) != 1:
            raise RuntimeError("Unrecognized Wasm symbol output: " + line)
        name, kind = fields[:2]
        # Undefined weak symbols can still import networking functions.
        yield {"name": name, "addr": 0 if kind in ("U", "w", "v") else 1}
