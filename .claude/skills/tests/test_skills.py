#!/usr/bin/env python3
"""Checks that the repo's agent skills still match the repo.

Every repo path, doc heading, and identifier a SKILL.md names must still
exist, and every reference package must still follow the current build-root
contract. Stale guidance steers agents wrong with confidence, which is worse
than no guidance.

Run from the repo root: python3 .claude/skills/tests/test_skills.py
"""
import pathlib
import re
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parents[3]
SKILLS = REPO / ".claude" / "skills"
# Paths that only exist after a build, so a fresh checkout cannot contain them.
GENERATED = ("sysroot/", "sysroot64/", "local-binaries/", "binaries/", ".context/")
# Names defined outside this repo (Claude Code tool parameters, autoconf macros).
EXTERNAL = {"run_in_background", "AC_CHECK_FUNCS", "AC_SEARCH_LIBS"}

failures = []


def fail(msg):
    failures.append(msg)


def tracked_text_contains(word):
    r = subprocess.run(["git", "grep", "-qw", word, "--", ".", ":!.claude"], cwd=REPO)
    return r.returncode == 0


def check_skill(skill_md):
    text = skill_md.read_text()
    rel = skill_md.relative_to(REPO)
    m = re.match(r"---\nname: (\S+)\ndescription: (.+?)\n---\n", text, re.S)
    if not m:
        fail(f"{rel}: missing name/description frontmatter")
    else:
        if m.group(1) != skill_md.parent.name:
            fail(f"{rel}: name {m.group(1)!r} does not match directory")
        if not m.group(2).startswith("Use when") or len(m.group(2)) > 1024:
            fail(f"{rel}: description must start 'Use when' and stay under 1024 chars")

    # Doc headings cited as `docs/x.md` "Heading" (possibly several per line).
    for doc, heading in re.findall(r"`((?:docs|sdk)/[^`\s]+\.md)` \"([^\"]+)\"", text):
        doc_path = REPO / doc
        if not doc_path.exists():
            fail(f"{rel}: cites missing doc {doc}")
        elif not any(l.startswith("#") and heading in l for l in doc_path.read_text().splitlines()):
            fail(f"{rel}: {doc} has no heading containing {heading!r}")

    for token in re.findall(r"`([^`\n]+)`", text):
        if " " in token or any(c in token for c in "<>$*|"):
            continue  # commands and templates, not names
        if "/" in token:
            path = token.rstrip(".,")
            if path.startswith(GENERATED) or path.startswith("-"):
                continue
            if not (REPO / path).exists():
                fail(f"{rel}: names missing path {path}")
        elif re.fullmatch(r"[a-z][a-z0-9]*(_[a-z0-9]+)+", token) or re.fullmatch(r"[A-Z][A-Z0-9]*(_[A-Z0-9]+)+", token):
            if token not in EXTERNAL and not tracked_text_contains(token):
                fail(f"{rel}: names identifier {token} that no tracked file outside .claude/ contains")

    # Reference packages must model the current contract, not a legacy one.
    for pkg in re.findall(r"`packages/registry/([a-z0-9-]+)/`", text):
        scripts = list((REPO / "packages" / "registry" / pkg).glob("build-*.sh"))
        if scripts and not any("package-build-roots.sh" in s.read_text() for s in scripts):
            fail(f"{rel}: reference package {pkg} no longer uses scripts/package-build-roots.sh")


def main():
    skill_files = sorted(SKILLS.glob("*/SKILL.md"))
    if not skill_files:
        fail("no skills found under .claude/skills")
    for s in skill_files:
        check_skill(s)
    for f in failures:
        print("FAIL", f)
    print(f"agent skills: {len(skill_files)} skills, {len(failures)} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
