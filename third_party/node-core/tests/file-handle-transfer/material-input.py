"""Stage the exact actual native sidecar body for the tiny ownership control.

This does not compile the SpiderMonkey embedding. The assertion macro is an
explicit component dependency; no fatal-path equivalence is inferred.
"""
from pathlib import Path
import sys
repo = Path(__file__).resolve().parents[4]
source = (repo / 'third_party/node-core/histogram-clone.cpp').read_text()
start = source.index('struct KandeloFileHandleTransfer {')
end = source.index('struct KandeloHistogramCloneData {', start)
output = Path(sys.argv[1]).resolve()
if output.exists():
    raise SystemExit('Use a fresh run-owned output file')
output.write_text(source[start:end])
