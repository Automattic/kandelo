#!/usr/bin/env python3
"""Extract the exact pinned CheckCB as a timestamp-driven native oracle."""
from pathlib import Path
import hashlib
import sys
root = Path(__file__).resolve().parents[2]
source = (root / 'upstream/histogram-reference/src/histogram.cc').read_bytes()
assert hashlib.sha256(source).hexdigest() == 'e79ac3b14457338718b8d15f0b338a78e534d3f0a3fca06a71c3a403ce067038'
text = source.decode()
start = text.index('void IterationHistogram::CheckCB(')
end = text.index('\nvoid IterationHistogram::MemoryInfo', start)
callback = text[start:end]
callback = callback.replace('void IterationHistogram::CheckCB(uv_check_t* handle)',
    'void ReferenceIteration::CheckCB(TestCheck* handle)')
old = '  IterationHistogram* self =\n      ContainerOf(&IterationHistogram::check_handle_, handle);'
assert callback.count(old) == 1
callback = callback.replace(old, '  ReferenceIteration* self = handle->owner;')
Path(sys.argv[1]).write_text('// Exact pinned CheckCB; containing class/handle unwrap adapted only.\n' + callback + '\n')
