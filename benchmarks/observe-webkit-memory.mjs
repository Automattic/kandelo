// Diagnostic adapter for the repository's pinned in-process Playwright driver.
// Its private inspector connection is test infrastructure, never host runtime.
// Load with NODE_OPTIONS=--import=<absolute-path-to-this-file> and set
// KANDELO_NATIVE_MEMORY_LOG to a test-owned JSONL output path.
// Worker events here cover direct page workers, not their nested pthreads.
// Inspector category sizes are not process RSS and must not be added to it.
// Read-only Memory tracking; no engine flags, heap snapshots, or forced GC.
import { createRequire } from 'node:module';
// The root and browser app may install different Playwright copies. Observe
// the app's connection, which actually owns the test browser.
const { webkit } = createRequire(new URL('../apps/browser-demos/package.json', import.meta.url))('playwright');
import { appendFileSync } from 'node:fs';
const output = process.env.KANDELO_NATIVE_MEMORY_LOG;
if (output && !webkit._connection?.toImpl) {
  throw new Error('Pinned Playwright inspector connection is unavailable');
}
if (output) {
  const emit = record => appendFileSync(output, JSON.stringify({
    recordedAt: new Date().toISOString(), observerPid: process.pid, ...record,
  }) + '\n');
  webkit._connection.toImpl(webkit).instrumentation.addListener({
    async onPageOpen(page) {
      if (page.browserContext._browser.options.name !== 'webkit') return;
      const seen = new WeakSet();
      const attach = async () => {
        const session = page.delegate._session;
        if (seen.has(session)) return;
        seen.add(session);
        const workers = new Map();
        const identity = {page: page.guid, session: session.sessionId};
        emit({ type: 'tracking-start', ...identity });
        session.on('Memory.trackingUpdate', event => emit({ type: 'native-memory', ...identity, directWorkerCount: workers.size, ...event }));
        session.on('Worker.workerCreated', event => {
          workers.set(event.workerId, event.url);
          emit({type:'worker-created',...identity,directWorkerCount:workers.size,...event});
        });
        session.on('Worker.workerTerminated', event => {
          workers.delete(event.workerId);
          emit({type:'worker-terminated',...identity,directWorkerCount:workers.size,...event});
        });
        try {
          await session.send('Memory.enable');
          await session.send('Memory.startTracking');
        } catch (error) { emit({ type: 'tracking-error', ...identity, error: String(error) }); }
      };
      // A real navigation can replace the inspector target even though the
      // Playwright Page survives. Observe the existing commit notification;
      // do not wrap or modify driver methods or navigation behavior.
      page.delegate._pageProxySession.on('Target.didCommitProvisionalTarget', () => { void attach(); });
      await attach();
    },
    onPageClose(page) { emit({ type: 'page-closed', page: page.guid }); },
  });
}
