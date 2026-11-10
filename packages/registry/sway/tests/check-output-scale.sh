#!/usr/bin/env bash
set -euo pipefail
source_file=${1:?upstream output.c is required}
work_dir=${2:?owned work directory is required}
test_dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$work_dir"
python3 - "$source_file" "$test_dir/output-scale.c" "$work_dir/output-scale.c" <<'PY'
from pathlib import Path
import sys
source, scaffold, output = map(Path, sys.argv[1:])
text = source.read_text()
start = text.index('static bool phys_size_is_aspect_ratio(')
end = text.index('static enum render_bit_depth ', start)
marker = '/* UPSTREAM_OUTPUT_SCALE */'
harness = scaffold.read_text()
assert harness.count(marker) == 1
output.write_text(harness.replace(marker, text[start:end]))
PY
clang -std=c11 -Wall -Wextra -Werror -O2 "$work_dir/output-scale.c" -lm -o "$work_dir/output-scale"
"$work_dir/output-scale"
