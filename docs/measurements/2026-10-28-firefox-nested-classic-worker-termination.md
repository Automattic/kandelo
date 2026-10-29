# Firefox: ending a starting nested classic Worker crashes the page

Date: 2026-10-28. Playwright Firefox 155.0 (build firefox-1543), Chromium
153.0.8010.12 and WebKit 26.6 (webkit-2359), macOS.

## Finding

When a dedicated Worker terminates a nested **classic** Worker that is
still starting, Firefox's content process crashes: `EXC_BAD_ACCESS`
(SIGSEGV) at address `0x8` on a `DOM Worker` thread inside XUL. Playwright's
Firefox build has no symbols; the faulting frame offsets were identical in
every crash report (`61273496, 61114272, 61113188, 61123904`).

The same pattern with **module** Workers does not crash, and neither does
ending children that have already started (answered a message) or children
created by the page itself rather than by a Worker. Chromium and WebKit do
not crash in any of these variants.

Every Worker Kandelo creates on Firefox is a module Worker: the kernel
Worker (`browser-kernel-host.ts`) and every process and thread Worker
(`worker-adapter-browser.ts`). The one classic Worker in the browser host,
the process-memory allocator in `browser-process-memory-factory.ts`, exists
only on JavaScriptCore. Kandelo is therefore not exposed today, and needs no
workaround; nested Workers must stay module Workers on Firefox.

This was found while making a Kandelo-shaped reproduction of
[`JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN`](../../tests/runtime-workarounds/JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN/entry.md):
its first version used classic Workers and crashed Firefox even when no
memory grew. Not filed upstream.

## Reproduction

Serve these three files with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (not required for the defect,
only for parity with Kandelo) and open `repro.html`; add `?type=module` for
the module variant.

`repro.html`:

```html
<!doctype html>
<pre id="out"></pre>
<script>
const parent = new Worker('parent.js' + location.search, {
  type: new URLSearchParams(location.search).get('type') ?? 'classic',
});
parent.onmessage = ({ data }) => { document.getElementById('out').textContent = data; };
</script>
```

`parent.js`:

```js
// Keep three child Workers starting; terminate each 0-3 ms after creating it.
const type = new URLSearchParams(self.location.search).get('type') ?? 'classic';
let terminated = 0;
const spawn = () => {
  const child = new Worker('child.js', { type });
  setTimeout(() => { child.terminate(); terminated++; spawn(); }, Math.random() * 3);
};
for (let i = 0; i < 3; i++) spawn();
setInterval(() => postMessage(`${terminated} children terminated`), 500);
```

`child.js`:

```js
onmessage = () => postMessage('hello');
```

## Results

Each run lasted up to 60 s (45 s for the Chromium and WebKit controls). The
reduced page above produced the first two rows; the other rows and the
Chromium and WebKit controls ran the same early termination on the larger
investigation page that also implements the listed variants.

| Variant | Firefox 155.0 | Chromium | WebKit |
|---|---|---|---|
| above, classic children | crashed at 1.3 s; every classic early-termination run crashed within 1.3-1.6 s (7 runs, including the next two rows) | 29,157 terminated, no crash | 30,803 terminated, no crash |
| above, `?type=module` | 32,659 terminated, no crash | | |
| terminate after 0-50 ms instead of 0-3 ms | crashed at 1.3 s | | |
| one child at a time | crashed at 1.4 s | | |
| children created by the page, not a Worker | 28,062 terminated, no crash | | |
| terminate only after the child answered a message | 2,955 terminated, no crash | | |
| defer each terminate until the child posts from top-level script evaluation | 15,560 terminated, no crash | | |

Kandelo itself on Firefox, with the shipped bash and coreutils
(`for ((i=0;i<300;i++)); do sleep 5 & kill -9 $!; done`, and 150 rounds of
destroying a kernel 0-200 ms after spawning three processes): no crash.
Kandelo's exit and kill paths wait for each Worker's `memory_quiescent`
message before terminating it, and its Workers are module Workers.
