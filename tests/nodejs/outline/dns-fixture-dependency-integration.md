# Focused DNS dependency repair

This is a test-setup/evidence checkpoint at source171, not a new runtime or
package revision. The DNS fixture omitted genuine histogram/eventLoopDelay
owners required by its existing candidate PerformanceObserver factory and
failed before any DNS case. It now supplies real internal/histogram and
node:perf_hooks, matching the existing Performance component fixture. No mock,
no-op or synthetic metadata replaces those native producers.

Original before evidence: exit1/harnesserror1/zero DNS cases. The same error
and old source are retained in the immutable handoff. Current root171 source
runs all26unchanged resolver cases successfully, with real loopback UDP and
native ChannelWrap/request/OS/clock boundaries. Assertions, packet/control
source and TypeScript selection are byte-identical. The private original26case
pass/94requests is separate identified evidence, not a relabeled current guest
result. Current source/core/unity/input checks pass, with790declared inputs.

The source17114package checks are reused because no runtime/package inputs
changed. No engine recipe revision is bumped for this fixture-only correction,
no native/engine/kernel/product compilation occurs and no overall suite runs.
This does not change the historical setup error into a pass or claim other DNS
selections ran. Production native JSAPI/kernel/libc/browser/guest provider,
resource lifecycle and all four hosts still need identified artifacts.

See [ledger](dns-fixture-dependency-finding-progress.json) and
[scoped DNS source](dns-scoped-address-integration.md).
