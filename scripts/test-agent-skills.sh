#!/usr/bin/env bash
# Check the agent skills under .claude/skills: every path, doc heading, and
# identifier a skill names must still exist in the repo, and its reference
# packages must still follow the current build contract.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 .claude/skills/tests/test_skills.py
