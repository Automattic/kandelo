#!/usr/bin/env bash
set -euo pipefail
source_file=${1:?upstream output.c is required}
work_dir=${2:?owned work directory is required}
test_dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$work_dir"
python3 - "$source_file" "$test_dir/output-scale.c" "$work_dir/output-scale.c" <<'PY'
from pathlib import Path
import sys
source, scaffold, output = map(Path, sys.argv[1:]); text = source.read_text()
def function(signature):
    start = text.index(signature); brace = text.index('{', start)
    depth = 1; end = brace + 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}'); end += 1
    return text[start:end]
helper = 'static float\ninitial_output_scale('
extracted = function(helper)+'\n\n' if helper in text else ''
extracted += function('void\nhandle_new_output(')+'\n\n'
extracted += function('static void\nhandle_output_request_state(')
output.write_text(scaffold.read_text().replace('/* UPSTREAM_OUTPUT_CONFIGURATION */', extracted))
PY
clang -std=gnu11 -Wall -Wextra -Werror -O2 "$work_dir/output-scale.c" -lm -o "$work_dir/output-scale"
"$work_dir/output-scale"
