#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <testrunner.db> <outcome-list-dir>" >&2
  exit 2
fi

DB="$1"
OUT_DIR="$2"
mkdir -p "$OUT_DIR"

PASSED="$OUT_DIR/passed-jobs.tsv"
FAILED="$OUT_DIR/failed-jobs.tsv"
SKIPPED="$OUT_DIR/skipped-jobs.tsv"
INCOMPLETE="$OUT_DIR/incomplete-jobs.tsv"

write_empty_lists() {
  printf 'jobid\tdisplaytype\tdisplayname\tcases\terrors\tms\n' > "$PASSED"
  printf 'jobid\tdisplaytype\tdisplayname\tcases\terrors\tms\toutput_excerpt\n' > "$FAILED"
  printf 'jobid\tdisplaytype\tdisplayname\tcases\terrors\tms\treason\n' > "$SKIPPED"
  printf 'jobid\tstate\tdisplaytype\tdisplayname\tcases\terrors\tms\treason\n' > "$INCOMPLETE"
}

write_empty_lists

if [ ! -f "$DB" ]; then
  exit 0
fi

if ! sqlite3 "$DB" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs' LIMIT 1;" | grep -qx 1; then
  exit 0
fi

sqlite3 -separator $'\t' "$DB" \
  "SELECT jobid,
          displaytype,
          displayname,
          coalesce(ntest, 0) AS cases,
          coalesce(nerr, 0) AS errors,
          coalesce(span, 0) AS ms
     FROM jobs
    WHERE state='done'
    ORDER BY jobid;" >> "$PASSED"

sqlite3 -separator $'\t' "$DB" \
  "SELECT jobid,
          displaytype,
          displayname,
          coalesce(ntest, 0) AS cases,
          coalesce(nerr, 0) AS errors,
          coalesce(span, 0) AS ms,
          substr(replace(replace(coalesce(output, ''), char(13), ' '), char(10), ' '), 1, 1000) AS output_excerpt
     FROM jobs
    WHERE state='failed'
    ORDER BY jobid;" >> "$FAILED"

sqlite3 -separator $'\t' "$DB" \
  "SELECT jobid,
          displaytype,
          displayname,
          coalesce(ntest, 0) AS cases,
          coalesce(nerr, 0) AS errors,
          coalesce(span, 0) AS ms,
          substr(
            replace(
              replace(
                coalesce(nullif(output, ''), 'omitted by SQLite testrunner'),
                char(13),
                ' '
              ),
              char(10),
              ' '
            ),
            1,
            1000
          ) AS reason
     FROM jobs
    WHERE state='omit'
    ORDER BY jobid;" >> "$SKIPPED"

sqlite3 -separator $'\t' "$DB" \
  "SELECT jobid,
          coalesce(state, '') AS state,
          displaytype,
          displayname,
          coalesce(ntest, 0) AS cases,
          coalesce(nerr, 0) AS errors,
          coalesce(span, 0) AS ms,
          CASE
            WHEN state='running' THEN 'still running at report time'
            WHEN state='ready' THEN 'not started before run stopped'
            WHEN state='halt' THEN 'halted by SQLite testrunner'
            ELSE 'nonterminal state at report time'
          END AS reason
     FROM jobs
    WHERE state IS NULL OR state NOT IN ('done', 'failed', 'omit')
    ORDER BY jobid;" >> "$INCOMPLETE"
