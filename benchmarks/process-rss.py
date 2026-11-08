"""Read native resident memory for the benchmark's exact process set."""

import json
import sys

import psutil


pids = [int(value) for value in sys.argv[1:]]
if not pids or any(pid <= 0 for pid in pids) or len(set(pids)) != len(pids):
    raise ValueError("Expected distinct positive process IDs")

# Do not replace inaccessible or vanished processes with zero: that would
# turn an incomplete observation into an apparently smaller memory sample.
print(json.dumps({"rssBytes": sum(psutil.Process(pid).memory_info().rss for pid in pids)}))
