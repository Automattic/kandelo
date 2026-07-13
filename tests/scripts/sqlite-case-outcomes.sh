#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

STDOUT_FILE="$TMP_ROOT/direct.stdout"
RESULTS_DIR="$TMP_ROOT/results"

cat > "$STDOUT_FILE" <<'EOF'
utf16.misc1-1.1... Ok
utf16.misc1-1.2... Ok
SQLite 2025-02-18 13:38:58 abcdef
0 errors out of 3 tests on OpenBSD 32-bit
Omitted test cases:
.  misc1-10.1   skipped by focused test
EOF

python3 "$REPO_ROOT/scripts/sqlite-case-outcomes.py" \
  --stdout-file "$STDOUT_FILE" \
  --results-dir "$RESULTS_DIR" \
  --host browser \
  --display-name "test/misc1.test" >/dev/null

if [ "$(wc -l < "$RESULTS_DIR/outcome-lists/passed-cases.txt" | tr -d ' ')" != "2" ]; then
  echo "expected two named passed case entries" >&2
  exit 1
fi

if [ "$(tail -n +2 "$RESULTS_DIR/outcome-lists/unattributed-passed-cases.tsv" | wc -l | tr -d ' ')" != "1" ]; then
  echo "expected one unattributed passed-case row" >&2
  exit 1
fi

if [ "$(tail -n +2 "$RESULTS_DIR/outcome-lists/skipped-cases.tsv" | wc -l | tr -d ' ')" != "1" ]; then
  echo "expected one skipped case entry" >&2
  exit 1
fi

python3 - "$RESULTS_DIR/outcome-lists/case-outcomes.json" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text())
summary = data["summary"]
assert summary["reported_executed_cases"] == 3, summary
assert summary["passed_cases"] == 2, summary
assert summary["skipped_cases"] == 1, summary
assert summary["unattributed_passed_cases"] == 1, summary
assert data["categories"]["passed_cases"]["status"] == "partial", data["categories"]
assert data["unavailable"][0]["category"] == "passed_cases", data["unavailable"]
PY

OMITTED_STDOUT="$TMP_ROOT/omitted.stdout"
OMITTED_RESULTS="$TMP_ROOT/omitted-results"
cat > "$OMITTED_STDOUT" <<'EOF'
omitted-1.1... Omitted
0 errors out of 1 tests on OpenBSD 32-bit
Omitted test cases:
.  omitted-1.1   requires an unavailable optional feature
EOF

python3 "$REPO_ROOT/scripts/sqlite-case-outcomes.py" \
  --stdout-file "$OMITTED_STDOUT" \
  --results-dir "$OMITTED_RESULTS" \
  --host browser \
  --display-name "test/omitted.test" >/dev/null

if [ "$(tail -n +2 "$OMITTED_RESULTS/outcome-lists/skipped-cases.tsv" | wc -l | tr -d ' ')" != "1" ]; then
  echo "expected duplicate omitted output to produce one skipped row" >&2
  exit 1
fi
if ! grep -q 'requires an unavailable optional feature' "$OMITTED_RESULTS/outcome-lists/skipped-cases.tsv"; then
  echo "expected the detailed omission reason" >&2
  exit 1
fi

DB="$TMP_ROOT/testrunner.db"
python3 - "$DB" "$STDOUT_FILE" <<'PY'
import sqlite3
import sys
from pathlib import Path

db_path = Path(sys.argv[1])
stdout = Path(sys.argv[2]).read_text()
con = sqlite3.connect(db_path)
con.executescript("""
CREATE TABLE jobs(
  jobid INTEGER PRIMARY KEY,
  displaytype TEXT NOT NULL,
  displayname TEXT NOT NULL,
  build TEXT NOT NULL DEFAULT '',
  dirname TEXT NOT NULL DEFAULT '',
  cmd TEXT NOT NULL,
  depid INTEGER,
  priority INTEGER NOT NULL,
  starttime INTEGER,
  endtime INTEGER,
  span INTEGER,
  estwork INTEGER,
  state TEXT,
  ntest INT,
  nerr INT,
  svers TEXT,
  pltfm TEXT,
  output TEXT
);
""")
con.execute(
    "INSERT INTO jobs(jobid, displaytype, displayname, cmd, priority, state, ntest, nerr, output) VALUES(1, 'tcl', 'test/misc1.test', '', 1, 'done', 3, 0, ?)",
    (stdout,),
)
con.execute(
    "INSERT INTO jobs(jobid, displaytype, displayname, cmd, priority, state, ntest, nerr, output) VALUES(2, 'tcl', 'test/failing.test', '', 1, 'done', 1, 1, ?)",
    ("! failing-1.1 expected: value\n1 errors out of 1 tests on OpenBSD 32-bit\n",),
)
invalid_output = b"invalid-\x80-1.1... Ok\n0 errors out of 1 tests on OpenBSD 32-bit\n"
con.execute(
    "INSERT INTO jobs(jobid, displaytype, displayname, cmd, priority, state, ntest, nerr, output) VALUES(3, 'tcl', 'test/nonutf8.test', '', 1, 'done', 1, 0, CAST(? AS TEXT))",
    (sqlite3.Binary(invalid_output),),
)
con.commit()
con.close()
PY

# Reporting must not mutate or clean up the evidence it reads.
: > "$DB-wal"
: > "$DB-shm"
SIDECAR_HASHES_BEFORE="$(shasum -a 256 "$DB" "$DB-wal" "$DB-shm")"

DB_RESULTS="$TMP_ROOT/db-results"
python3 "$REPO_ROOT/scripts/sqlite-case-outcomes.py" \
  --db "$DB" \
  --results-dir "$DB_RESULTS" \
  --host node >/dev/null

SIDECAR_HASHES_AFTER="$(shasum -a 256 "$DB" "$DB-wal" "$DB-shm")"
if [ "$SIDECAR_HASHES_BEFORE" != "$SIDECAR_HASHES_AFTER" ]; then
  echo "outcome extraction changed its source database or sidecars" >&2
  exit 1
fi

python3 - "$DB_RESULTS/outcome-lists/case-outcomes.json" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text())
assert data["summary"]["jobs"] == {
    "passed": 2,
    "failed": 1,
    "skipped": 0,
    "incomplete": 0,
}, data["summary"]["jobs"]
assert data["summary"]["failed_cases"] == 1, data["summary"]
assert data["summary"]["unattributed_passed_cases"] == 1, data["summary"]
assert "invalid-\ufffd-1.1" in Path(
    data["artifacts"]["passed_cases"]
).read_text().splitlines()
PY

echo "sqlite-case-outcomes ok"
