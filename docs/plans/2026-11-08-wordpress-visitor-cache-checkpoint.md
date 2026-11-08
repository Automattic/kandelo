# WordPress visitor-cache checkpoint

This is functional evidence on a development image, not a throughput
comparison or final canonical acceptance. The unchanged WP Super Cache
3.1.5 plugin runs through the ordinary WordPress admin, HTTP bridge, PHP
runtime and filesystem inside Kandelo. PHP's optimizer remains unchanged.

## Selected configuration and checks

The maintained `wordpress-super-cache.spec.ts` activates the stock plugin
through WordPress, selects post-name permalinks and enables caching. It
then selects ordinary generated configuration settings:

- `wpsc_served_header=true`, so a response can establish a PHP cache hit;
- `cache_rebuild_files=0`, disabling the serve-stale rebuild option;
- `wp_cache_clear_on_post_edit=1`, selecting cache clearing on saved edits.

These are test-selected plugin settings, not changes to plugin algorithms
or a pre-enabled image configuration. Anonymous GETs must hit the cache
without an admin bar. Authenticated GETs and anonymous POSTs must bypass
it. WordPress's configured REST client creates and edits a separate
published post, then saves a site-template heading. The first anonymous
responses must show those saves; the test does not retry away stale content.

For expiry, it changes the stock TTL to two seconds and lets four real
seconds pass without aging files, clearing caches or changing clocks.
The expired request must miss and show saved content, and the next request
must hit the rebuilt entry.

An authenticated test-owned observation endpoint schedules the stock
`wp_cache_gc` hook in the past. It records actual cache-file paths and
mtimes, then an explicit request to the unchanged `wp-cron.php` executes
the hook. The test requires deletion of the expired post file, an updated
GC timestamp and a future rescheduled hook. The observation endpoint is
not shipped in product images and does not implement garbage collection.
**Automatic cron remains disabled and is not validated by this test.**

## Chromium result

Job `wordpress-stock-cache-policy-and-gc-v6-1108-021151-5f37` ends with
two passes and one failure in 3m44s, with zero skips or retries. Classic
FrankenPHP passes in 78.4 seconds; real Caddy/FrankenPHP passes in 76.8
seconds. Both complete every check above. Their expired post and home
cache files are removed, and the stock hook is rescheduled 600 seconds
after its observed execution. These test durations are not performance
measurements.

The PHP-FPM control fails before plugin activation: the permalink screen
offers an `/index.php/%postname%/` value instead of `/%postname%/`. Its
actual rendered screenshot confirms the screen is present; the first
automatic screenshot belongs to the persistent browser's empty initial
page and must not be mistaken for the tested application's document.
The WordPress image's nginx FastCGI blocks omit `SERVER_SOFTWARE`, unlike
the generic nginx/PHP image.

Control `ee8e` observes `SERVER_SOFTWARE=null` in real PHP-FPM, adds the
standard nginx FastCGI parameter through the test-owned machine's ordinary
configuration, and observes `nginx/1.24.0`. The expected permalink option
then works. Plugin setup next exposes root-owned configuration/content
paths that the FPM account cannot write. Follow-up `a2be` observes all
three relevant PHP `is_writable` checks false, changes ordinary ownership
of the document root, content directory and configuration file to UID/GID
65534, and observes them true. Plugin activation, anonymous hits and
authenticated/POST bypass then pass; the later REST operation fails with
an unexpanded object error. Neither control is a full PHP-FPM cache pass.

The image recipes now prepare the standard server metadata and ownership
required for atomic configuration replacement: WordPress revision 46 and
WordPress family revision 12. The family already gives each backend its
own writable content directory. No recursive source rewrite or application
patch is involved. These source changes still require normal builds,
Node/browser checks and a replacement-preview proof. The shared preview
and its revision-45 image remain unchanged.

The cohort is normal revision-45 **partial** WordPress image
`9cbbb185ced4`, ABI-55 kernel `6f5afada9ae3`, classic `f1314f3e7675`
and Caddy `cfdba6545bd4`. Served image bytes and selected kernel/program
hashes are checked before execution. The consumer includes main through
`c3703ba28d6e`; its selected host/runtime code matches the earlier measured
consumer, but the image predates that integration and the SDK metadata fix.
No borrowed SDK, restamped receipt, new engine flag or forced GC is used.

## Investigation history and limits

Original failures remain separate evidence:

- `4931` and `c3df` each fail both cases while extracting an assumed REST
  nonce format. Waiting for the inline script does not establish a fix.
  The maintained test instead uses WordPress's configured REST client.
- `55f7` reaches successful post updates, but cached visitor responses
  retain the old title under the initial stock settings.
- `2a1e` disables rebuilds alone; both cases still fail the first visitor
  check after publishing. That setting alone does not meet the test's
  freshness policy.
- `a0cc` adds stock clear-on-edit: classic passes the full gate, PHP-FPM
  fails at permalinks, and Caddy loses an initial terminal command. It is
  one pass/two failures, not a successful aggregate run.
- `5f37` waits for the terminal input and actual maker prompt before
  sending each command. Both Go services pass; the separate PHP-FPM
  permalink failure remains. This does not prove every earlier input loss
  or editor intermittency had the same cause.

Raw reports, workload source and artifact identities are retained under
each job's `scratch/visitor-cache/` in the review checkout. The current
test-owned PHP probe is also retained with its identity under `a0cc`.
Private cross-engine and FastCGI controls retain their own source snapshots
and reports; no unexecuted selection is counted as a pass.

The first private control `f8da` and cross-engine attempt `6684` select no
tests because their grep expressions incorrectly anchor the full Playwright
test title. Corrected controls remove the anchor; those discovery failures
are not runtime results. The executed cross-engine selection `87cc` remains
in progress at this checkpoint; its first Firefox classic case reaches the
360-second test timeout with the real post editor rendered. No cause or
Firefox cache pass is established. Later private controls retain readable
REST error objects rather than treating `locator.evaluate: Object` as a
diagnosis.

Final coherent artifacts, automatic cron/lifecycle behavior, all browser
engines and the PHP-FPM control remain required. The separate native WebKit
memory investigation is unresolved. Fair uncached runtime comparisons and
cache-enabled visitor comparisons must report their different policies and
measured results rather than attributing cache hits to Go/PHP server speed.
