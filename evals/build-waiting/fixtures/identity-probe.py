#!/usr/bin/env python3
"""Record only safe identity fields, never a full environment/command line."""
import json
import os
import pathlib
import subprocess
import sys

role = sys.argv[1]
chain = []
pid = os.getppid()
for _ in range(6):
    r = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "ppid=,comm="], capture_output=True, text=True)
    fields = r.stdout.strip().split(None, 1)
    if len(fields) != 2:
        break
    chain.append(dict(pid=pid, ppid=int(fields[0]), executable=fields[1]))
    pid = int(fields[0])
    if pid <= 1:
        break
safe = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_AGENT_ID", "CLAUDE_AGENT_ID", "CLAUDE_PROJECT_DIR")
record = dict(role=role, env={k: os.environ.get(k) for k in safe},
              claude_env_names=sorted(k for k in os.environ if k.startswith("CLAUDE")), chain=chain)
pathlib.Path(f"identity-{role}.json").write_text(json.dumps(record, indent=2))
print(json.dumps(record))
