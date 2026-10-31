#!/usr/bin/env python3
"""Embed reviewed Node compatibility sources and the exact target pin."""
from pathlib import Path
import sys
import json

adapter = Path(sys.argv[1]).read_text(encoding="utf-8")
shared = Path(sys.argv[2]).read_text(encoding="utf-8")
suffix = Path(sys.argv[3]).read_text(encoding="utf-8")
generated = Path(sys.argv[4])
dest = Path(sys.argv[5])

shared_lines = [
    line for line in shared.splitlines()
    if not line.startswith("import * as ")
]
web_platform_source = Path(sys.argv[6]).read_text(encoding="utf-8")
target = json.loads(Path(sys.argv[7]).read_text(encoding="utf-8"))
core_source = Path(sys.argv[8]).read_text(encoding="utf-8")
if target["schema"] != 1:
    raise ValueError("unknown Node compatibility target schema")
prelude = "const _nodeCompatibilityTarget = " + json.dumps(target, ensure_ascii=True) + ";\n"
source_text = adapter.rstrip() + "\n" + prelude + web_platform_source + "\n" + core_source + "\n" + "\n".join(shared_lines) + "\n" + suffix.rstrip() + "\n"
generated.write_text(source_text, encoding="utf-8")
source = source_text.encode("utf-8")
dest.parent.mkdir(parents=True, exist_ok=True)
with dest.open("w", encoding="ascii") as f:
    f.write("#ifndef shell_kandelo_node_bootstrap_h\n")
    f.write("#define shell_kandelo_node_bootstrap_h\n\n")
    f.write("#define KANDELO_NODE_COMPAT_VERSION " + json.dumps("v" + target["version"]) + "\n\n")
    f.write("static const unsigned char kKandeloNodeBootstrap[] = {\n")
    for i in range(0, len(source), 12):
        chunk = source[i:i + 12]
        f.write("  " + ", ".join(f"0x{b:02x}" for b in chunk) + ",\n")
    f.write("};\n")
    f.write("static const size_t kKandeloNodeBootstrapLen = sizeof(kKandeloNodeBootstrap);\n")
    f.write("\n#endif  // shell_kandelo_node_bootstrap_h\n")
