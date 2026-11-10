#!/usr/bin/env python3
"""Select complete upstream EGL/GLES2 build graphs without changing tests."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys

package = Path(__file__).resolve().parent
source = Path(sys.argv[1]).resolve(strict=True)
pin = json.loads((package / "upstream.json").read_text())
for name, expected in pin["files"].items():
    if hashlib.sha256((source / name).read_bytes()).hexdigest() != expected:
        raise SystemExit(f"upstream source differs from CTS pin: {name}")

# Preserve upstream module/data/entry macros verbatim. Their source lists and
# all tests remain upstream files; this replaces only root build composition.
original = (source / "CMakeLists.txt").read_text()
macros = re.findall(r"(?ms)^macro\s*\(.*?^endmacro\s*\([^\n]*\)\s*$", original)
names = [re.search(r"macro\s*\(\s*(\w+)", text).group(1) for text in macros]
expected = ["PCH", "target_copy_files", "add_deqp_module", "add_deqp_module_skip_android", "add_data_dir", "add_data_file"]
if names != expected:
    raise SystemExit(f"unexpected upstream build macros: {names}")
(source / "upstream-module-macros.cmake").write_text("\n\n".join(macros) + "\n")
shutil.copyfile(package / "cmake/CMakeLists.txt", source / "CMakeLists.txt")
shutil.copyfile(package / "src/tcuKandeloPlatform.cpp", source / "framework/platform/tcuKandeloPlatform.cpp")
