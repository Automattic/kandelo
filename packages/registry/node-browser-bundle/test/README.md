# Installed npm regressions

These tests run the normal lazy Node/npm package from the canonical shell.
Only retained fixture data is added. Missing canonical artifacts fail; an
unrelated partial image is never selected.

The ten unchanged cases cover offline installation, lifecycle execution,
package verification, a real guest loopback registry, executable links,
npm exec, lockfiles, cache-only ci and ESM package loading. Complete guest
scripts, expected results and the original tarball remain unchanged.

The shared helper checks real process-family output, exit status, every main
and thread retirement fence, remaining processes and session destruction.
Browser readiness includes artifact loading and fixture setup. Budgets remain
180 seconds for readiness, 120 seconds for each invocation including cleanup,
20 minutes per host gate, 60 seconds for session retirement and 25 minutes for
the outer runner. There are no automatic retries or missing-artifact skips.

Run npm-smoke.test.ts with the normal host Vitest config and npm-browser.config.ts
with the application Playwright executable. Use scripts/dev-shell.sh, explicit
source-only-v1 resolution and the current absolute SourceOnly projection. The
browser config uses the quiet fixture and separate Chromium/Firefox/WebKit runs.

Public online installation remains a separate network-dependent acceptance run.
These tests do not replace actual app terminal/REPL/Fetch acceptance, prove
HTTP Fetch or native addons, or establish complete Node module compatibility.
