#!/usr/bin/env bash
# Check the agent skills under .claude/skills: diagnosis fixtures still report
# the right first cause, and every path, doc heading, and identifier the skills
# name still exists in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 .claude/skills/tests/test_skills.py
