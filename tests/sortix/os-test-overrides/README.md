# Sortix expectation overrides

Directories named `<suite>.expect` replace the upstream expectation candidates
for a test. Use them when Kandelo has a stricter invariant that should not fall
back to another upstream platform's output.

Directories named `<suite>.expect-additional` add narrowly documented Kandelo
outcomes while retaining the upstream candidates. These files are for valid
observable differences such as signal-handler output ordering; they must not
hide an unsupported POSIX behavior. Unsupported behavior belongs in the
runner's explicit XFAIL list and in `docs/posix-status.md`.
