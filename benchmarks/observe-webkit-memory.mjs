// Diagnostic adapter for the repository's pinned in-process Playwright driver.
// Its private inspector connection is test infrastructure, never host runtime.
// Load with NODE_OPTIONS=--import=<absolute-path-to-this-file> and set
// KANDELO_NATIVE_MEMORY_LOG to a test-owned JSONL output path.
// Worker events here cover direct page workers, not their nested pthreads.
// Inspector category sizes are not process RSS and must not be added to it.
// Read-only Memory tracking; no engine flags, heap snapshots, or forced GC.
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  if (process.env.KANDELO_NATIVE_PROCESS_MEMORY === '1') {
    if (process.platform !== 'darwin') throw new Error('Native process sampling requires macOS');
    const run = promisify(execFile);
    const options = { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 };
    // Explicit test-phase requests only: no polling or engine flags. Keep
    // process RSS separate from inspector categories and physical footprint.
    globalThis[Symbol.for('kandelo.webKitNativeProcessMemory')] = async publicPage => {
      const page = webkit._connection.toImpl(publicPage);
      const browser = page.browserContext._browser;
      if (browser.options.name !== 'webkit') return undefined;
      const browserPid = browser.options.browserProcess.process?.pid;
      if (!Number.isSafeInteger(browserPid)) throw new Error('Missing local WebKit browser PID');
      const startedAt = new Date().toISOString();
      const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm='], options);
      const processes = stdout.split('\n').flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]),
          rssBytes: Number(match[3]) * 1024, command: match[4] }] : [];
      });
      const owned = new Set([browserPid]);
      // Walk this one process-table snapshot and record only this browser.
      for (let count = -1; count !== owned.size;) {
        count = owned.size;
        for (const process of processes) if (owned.has(process.ppid)) owned.add(process.pid);
      }
      // macOS reparents WebKit's XPC services to launchd. The browser app's
      // own pid domain identifies them without guessing from global names
      // or a responsibility group shared by other Conductor workspaces.
      const apps = processes.filter(process => owned.has(process.pid) &&
        process.command.endsWith('/Playwright.app/Contents/MacOS/Playwright'));
      if (apps.length !== 1) throw new Error('Expected one local Playwright app');
      const { stdout: domain } = await run('/bin/launchctl', ['print', `pid/${apps[0].pid}`], options);
      const services = domain.split('\n').flatMap(line => {
        const match = /^\s*(\d+)\s+-\s+(com\.apple\.WebKit\.[\w.-]+)\s*$/.exec(line);
        return match && Number(match[1]) > 0 ? [{ pid: Number(match[1]), name: match[2] }] : [];
      });
      for (const service of services) owned.add(service.pid);
      const descendants = processes.filter(process => owned.has(process.pid));
      const ownership = { appPid: apps[0].pid, launchdServices: services };
      emit({ type: 'native-process-tree', page: page.guid, browserPid, ownership, processes: descendants });
      const content = descendants.filter(process => /WebProcess|WebContent/.test(process.command));
      if (content.length === 0) throw new Error('WebKit content process absent from native snapshot');
      const maps = [];
      for (const process of content) {
        const { stdout } = await run('/usr/bin/vmmap', ['-summary', String(process.pid)], options);
        maps.push({ pid: process.pid, summary: stdout });
      }
      const record = { startedAt, finishedAt: new Date().toISOString(), browserPid, ownership, processes: descendants, maps };
      emit({ type: 'native-process-memory', page: page.guid, ...record });
      return record;
    };
  }
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
