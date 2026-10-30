#!/usr/bin/env bash
set -euo pipefail
# Both outputs belong to the resolver's private work directory.
source_file=${1:?upstream status_line.c is required}
work_dir=${2:?owned work directory is required}
test_dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$work_dir"
python3 - "$source_file" "$test_dir/status-line-eof.c" "$work_dir/status-line-eof.c" <<'PY'
from pathlib import Path
import sys
source, scaffold, output = map(Path, sys.argv[1:])
text = source.read_text()
start = text.index('static void status_line_close_fds(')
end = text.index('struct status_line *status_line_init(', start)
marker = '/* UPSTREAM_STATUS_READER */'
harness = scaffold.read_text()
assert harness.count(marker) == 1
output.write_text(harness.replace(marker, text[start:end]))
PY
clang -O2 "$work_dir/status-line-eof.c" -o "$work_dir/status-line-eof"
"$work_dir/status-line-eof"
