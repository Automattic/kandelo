import { getPreviewProgress } from "../panes/preview-progress";
import type { DmesgLine, GalleryItem, KernelHost, PtyHandle } from '../../../../../web-libs/kandelo-session/src/kernel-host';
import type { ShellTerminal } from '../panes/Shell';
import { descriptorFromGalleryItem } from '../gallery-descriptor';
import { galleryItemUrl } from '../url-state';
import { encodeBootDescriptor, HARD_CAPS } from '../../../../../web-libs/kandelo-session/src/boot-descriptor';
import { createInlineBootInput } from '../../../../../web-libs/kandelo-session/src/boot-inputs';
import { contracts, guestPath, ToolError, validate, type Schema } from './contract';
import { getWebMcpRuntimeCapabilities, listGuestDirectory, startGuestJob, readGuestJob, readGuestFile, writeGuestFile } from './runtime';

export interface AppBindings {
  host: KernelHost;
  terminals: ShellTerminal[];
  activeTerminalId: string;
  createTerminal(activate: boolean): ShellTerminal;
  selectTerminal(id: string): void;
  launch(item: GalleryItem): Promise<void>;
  navigatePreview(path: string): boolean;
}
interface ModelContext {
  registerTool(tool: { name: string; description: string; inputSchema: Schema; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute(args: Record<string, unknown>, options: { signal: AbortSignal }): Promise<string> }, options: { signal: AbortSignal }): Promise<void>;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RETAINED_BYTES = 256 * 1024;
const MAX_TERMINALS = 32;
const MAX_REQUESTS = 256;
const controls: Record<string, string> = { enter: '\r', ctrl_c: '\x03', ctrl_d: '\x04', ctrl_z: '\x1a', tab: '\t', escape: '\x1b', backspace: '\x7f', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };

class OutputBuffer {
  bytes = new Uint8Array(0);
  start = 0;
  append(chunk: Uint8Array) {
    const combined = new Uint8Array(Math.min(RETAINED_BYTES, this.bytes.length + chunk.length));
    const dropped = this.bytes.length + chunk.length - combined.length;
    const previous = this.bytes.subarray(Math.min(dropped, this.bytes.length));
    combined.set(previous);
    combined.set(chunk.subarray(Math.max(0, dropped - this.bytes.length)), previous.length);
    this.start += dropped;
    this.bytes = combined;
  }
}
type RetryRecord = { fingerprint: string; result: Promise<Record<string, unknown>> };
const documentRequests = new WeakMap<KernelHost, Map<string, RetryRecord>>();

interface TerminalRecord { terminal: ShellTerminal; output: OutputBuffer; pty?: PtyHandle; pending?: Promise<void>; error?: string; off?: () => void; queue: Promise<void> }

/** One adapter per mounted app; no tools or capabilities are installed in preview frames. */
export function registerWebMcp(get: () => AppBindings): (() => void) & { sync?: () => void } {
  const context = (document as Document & { modelContext?: ModelContext }).modelContext;
  if (!context?.registerTool) return () => {};
  const controller = new AbortController();
  const host = get().host;
  let generationId = crypto.randomUUID();
  let previousStatus = host.getStatus();
  let disposed = false;
  const terminals = new Map<string, TerminalRecord>();
  // Keep retry records for the entire mounted document lifetime, including boot changes.
  const requests = documentRequests.get(host) ?? new Map<string, RetryRecord>();
  documentRequests.set(host, requests);
  type LogEntry = DmesgLine & { messageTruncated?: boolean };
  const boundedLog = (line: DmesgLine): LogEntry => ({ ...line, facility: line.facility.slice(0, 256), msg: line.msg.slice(0, 4096), ...(line.msg.length > 4096 ? { messageTruncated: true } : {}) });
  const history = host.dmesgHistory();
  let logs: LogEntry[] = history.slice(-1000).map(boundedLog);
  let logStart = Math.max(0, history.length - 1000);

  function invalidate() {
    generationId = crypto.randomUUID();
    for (const record of terminals.values()) { record.off?.(); record.pty?.close(); }
    terminals.clear();
    logs = [];
    logStart = 0;
  }
  const offStatus = host.subscribeStatus(status => {
    if ((status === 'booting' && previousStatus !== 'booting') || (status === 'halted' && previousStatus !== 'halted')) invalidate();
    previousStatus = status;
    if (status === 'running') sync();
  });
  const offLogs = host.subscribeDmesg(line => {
    logs.push(boundedLog(line));
    if (logs.length > 1000) { logs.shift(); logStart++; }
  });
  function checkSignal(signal?: AbortSignal) {
    if (disposed || signal?.aborted) throw new ToolError('ABORTED', 'Tool execution cancelled');
  }
  function ready() {
    if (host.getStatus() !== 'running') throw new ToolError('NOT_READY', `Computer is ${host.getStatus()}`);
  }
  function sameGeneration(id: string) {
    if (generationId !== id || disposed) throw new ToolError('STALE_SESSION', 'Computer was replaced; rediscover current IDs');
  }
  function qualified(id: string) { return `${generationId}:${id}`; }
  function parseCursor(raw: unknown, stream: string, oldest: number, end: number): number {
    if (raw === undefined) return oldest;
    const prefix = `${generationId}:${stream}:`;
    if (typeof raw !== 'string' || !raw.startsWith(prefix) || !/^\d+$/.test(raw.slice(prefix.length))) throw new ToolError('INVALID_CURSOR', 'Cursor belongs to another stream or computer');
    const offset = Number(raw.slice(prefix.length));
    if (!Number.isSafeInteger(offset) || offset > end) throw new ToolError('INVALID_CURSOR', 'Cursor is beyond available output');
    if (offset < oldest) throw new ToolError('OUTPUT_EXPIRED', 'Output is no longer retained', { oldestCursor: `${prefix}${oldest}`, truncated: true });
    return offset;
  }
  function lookupTerminal(id: string) {
    if (!id.startsWith(`${generationId}:`)) throw new ToolError('STALE_SESSION', 'Terminal belongs to a previous computer');
    const raw = id.slice(generationId.length + 1);
    const terminal = get().terminals.find(t => t.id === raw);
    if (!terminal) throw new ToolError('UNKNOWN_TERMINAL', 'Terminal is not present in the dock');
    return terminal;
  }
  function ensureTerminal(terminal: ShellTerminal): TerminalRecord {
    let record = terminals.get(terminal.id);
    if (record) return record;
    if (terminals.size >= MAX_TERMINALS) throw new ToolError('LIMIT_EXCEEDED', `WebMCP retains at most ${MAX_TERMINALS} terminals per computer`);
    record = { terminal, output: new OutputBuffer(), queue: Promise.resolve() };
    terminals.set(terminal.id, record);
    const current = generationId;
    const target = record;
    target.pending = host.attachPty(terminal.path).then(pty => {
      if (disposed || current !== generationId || terminals.get(terminal.id) !== target) { pty.close(); return; }
      target.pty = pty;
      target.off = pty.onData(bytes => target.output.append(bytes));
    }).catch(error => { target.error = String(error); });
    return target;
  }
  function terminalInfo(terminal: ShellTerminal) {
    const record = terminals.get(terminal.id);
    return { terminalId: qualified(terminal.id), label: terminal.label, ready: Boolean(record?.pty), active: get().activeTerminalId === terminal.id, error: record?.error ?? null };
  }
  function sync() {
    if (disposed) return;
    const visible = new Set(get().terminals.map(t => t.id));
    for (const [id, record] of terminals) {
      if (!visible.has(id)) { record.off?.(); record.pty?.close(); terminals.delete(id); }
    }
    if (host.getStatus() === "running" && host.getSurfaceAvailability().terminal) {
      for (const terminal of get().terminals.slice(0, MAX_TERMINALS)) ensureTerminal(terminal);
    }
  }
  async function profile(id: string) {
    const item = (await host.galleryQuery({ tab: 'presets' })).find(p => p.id === id);
    if (!item) throw new ToolError('UNKNOWN_PROFILE', `Unknown profile: ${id}`);
    return item;
  }
  async function resolvedProfile(id: string) {
    const item = await profile(id);
    return item.vfsImageUrl || !item.resolveVfsImageUrl ? item : { ...item, vfsImageUrl: await item.resolveVfsImageUrl() };
  }
  async function readJob(jobId: string, rawCursor?: unknown, limit = 4096, cancel = false): Promise<Record<string, unknown>> {
    const prefix = `${jobId}:output:`;
    let offset: number | undefined;
    if (rawCursor !== undefined) {
      if (typeof rawCursor !== 'string' || !rawCursor.startsWith(prefix) || !/^\d+$/.test(rawCursor.slice(prefix.length))) throw new ToolError('INVALID_CURSOR', 'Cursor belongs to another job');
      offset = Number(rawCursor.slice(prefix.length));
    }
    let result;
    try { result = await readGuestJob(host, jobId, offset, limit, cancel); }
    catch (error) {
      if (String(error).includes('UNKNOWN_JOB')) throw new ToolError('UNKNOWN_JOB', 'No owned job exists with this ID');
      if (String(error).includes('INVALID_CURSOR')) throw new ToolError('INVALID_CURSOR', 'Cursor is beyond available output');
      throw error;
    }
    if (result.expired) throw new ToolError('OUTPUT_EXPIRED', 'Job output is no longer retained', { oldestCursor: `${prefix}${result.oldest}`, truncated: true });
    const decode = (stream: 'stdout' | 'stderr') => {
      const chunks = result.chunks.filter(chunk => chunk.stream === stream);
      const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0));
      let index = 0;
      for (const chunk of chunks) { bytes.set(chunk.bytes, index); index += chunk.bytes.length; }
      return decoder.decode(bytes);
    };
    return { jobId, pid: result.pid, status: result.status, exitCode: result.exitCode, terminationObserved: result.terminationObserved, stdout: decode('stdout'), stderr: decode('stderr'), nextCursor: `${prefix}${result.next}`, hasMore: result.hasMore, truncated: result.truncated };
  }
  async function execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    checkSignal(signal);
    const current = generationId;
    switch (name) {
      case 'list_profiles': {
        const items = await host.galleryQuery({ tab: 'presets', q: args.search as string | undefined });
        return { profiles: items.map(p => ({ profileId: p.id, name: p.title, description: p.summary, availability: p.vfsImageUrl ? 'available' : p.resolveVfsImageUrl ? 'resolved_on_launch' : 'descriptor' })) };
      }
      case 'get_computer_status': {
        return { generationId, document: { title: document.title, url: location.href }, profile: { profileId: host.getBootDescriptor().id, name: host.getBootDescriptor().title }, status: host.getStatus(), bootError: host.getStatus() === 'error' ? host.dmesgHistory().filter(l => l.level === 'err').slice(-1)[0]?.msg ?? 'Boot failed; read logs' : null, capabilities: { terminals: host.getSurfaceAvailability().terminal, preview: host.getWebPreview()?.status === 'running', ...getWebMcpRuntimeCapabilities(host) }, activeTerminalId: qualified(get().activeTerminalId), preview: host.getWebPreview(), previewProgress: getPreviewProgress(host) };
      }
      case 'launch_computer': {
        const item = await resolvedProfile(args.profileId as string);
        checkSignal(signal); sameGeneration(current);
        const destinationUrl = item.vfsImageUrl ? galleryItemUrl(item) : null;
        // Yield the acknowledgement to the browser before invoking existing navigation.
        if (destinationUrl && destinationUrl !== location.href) {
          window.setTimeout(() => { if (!disposed && !signal?.aborted) void get().launch(item).catch(console.warn); }, 0);
          return { initiated: true, destinationUrl, rediscoverTools: true };
        }
        if (destinationUrl === location.href) return { initiated: false, alreadyCurrent: true, destinationUrl, rediscoverTools: false, status: host.getStatus() };
        await get().launch(item);
        return { initiated: true, destinationUrl, rediscoverTools: false, status: host.getStatus() };
      }
      case 'run_command': {
        if (args.cwd !== undefined) guestPath(args.cwd as string);
        ready();
        const jobId = qualified(`job-${crypto.randomUUID()}`);
        await startGuestJob(host, jobId, args as { script: string });
        sameGeneration(current);
        const deadline = performance.now() + Number(args.waitMs ?? 1000);
        let result = await readJob(jobId);
        while (result.status === 'running' && performance.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline - performance.now()))));
          sameGeneration(current);
          result = await readJob(jobId);
        }
        return result;
      }
      case 'read_job':
      case 'cancel_job': {
        const jobId = args.jobId as string;
        if (!jobId.startsWith(`${generationId}:`)) throw new ToolError('STALE_SESSION', 'Job belongs to another computer generation');
        ready();
        const result = await readJob(jobId, args.cursor, Number(args.byteLimit ?? 4096), name === 'cancel_job');
        sameGeneration(current);
        return result;
      }
      case 'list_terminals': {
        if (host.getStatus() === 'running' && host.getSurfaceAvailability().terminal) {
          // Attach output observers to the same host-owned PTYs, never restart them.
          await Promise.all([...terminals.values()].map(t => t.pending));
          sameGeneration(current);
        }
        return { terminals: get().terminals.map(terminalInfo) };
      }
      case 'create_terminal': {
        ready();
        if (!host.getSurfaceAvailability().terminal) throw new ToolError('UNSUPPORTED_CAPABILITY', 'This profile has no interactive terminal');
        if (get().terminals.length >= MAX_TERMINALS || terminals.size >= MAX_TERMINALS) throw new ToolError('LIMIT_EXCEEDED', `At most ${MAX_TERMINALS} terminals`);
        const terminal = get().createTerminal(args.activate !== false);
        const record = ensureTerminal(terminal);
        await record.pending; sameGeneration(current);
        return { ...terminalInfo(terminal), active: args.activate !== false };
      }
      case 'switch_terminal': {
        ready();
        const terminal = lookupTerminal(args.terminalId as string);
        get().selectTerminal(terminal.id);
        return { ...terminalInfo(terminal), active: true };
      }
      case 'send_terminal_input': {
        ready();
        if ((args.text === undefined) === (args.key === undefined)) throw new ToolError('INVALID_ARGUMENT', 'Supply exactly one of text or key');
        const terminal = lookupTerminal(args.terminalId as string);
        const record = ensureTerminal(terminal);
        const bytes = encoder.encode(args.text === undefined ? controls[args.key as string] : args.text as string);
        if (bytes.length > 65536) throw new ToolError('LIMIT_EXCEEDED', 'Input exceeds 65536 bytes');
        const work = record.queue.then(async () => {
          await record.pending; checkSignal(signal); sameGeneration(current);
          if (!record.pty) throw new ToolError('NOT_READY', record.error ?? 'Terminal not attached');
          record.pty.write(bytes);
        });
        record.queue = work.catch(() => {});
        await work;
        return { terminalId: args.terminalId, delivered: true, bytesWritten: bytes.length, completion: 'not_observed' };
      }
      case 'read_terminal_output': {
        ready();
        const terminal = lookupTerminal(args.terminalId as string);
        const record = ensureTerminal(terminal);
        await record.pending; checkSignal(signal); sameGeneration(current);
        if (!record.pty) throw new ToolError('NOT_READY', record.error ?? 'Terminal not attached');
        const { bytes, start } = record.output;
        const stream = terminal.id;
        const offset = parseCursor(args.cursor, stream, start, start + bytes.length);
        const chunk = bytes.subarray(offset - start, offset - start + Number(args.byteLimit ?? 4096));
        const next = offset + chunk.length;
        return { output: decoder.decode(chunk), bytesRead: chunk.length, nextCursor: `${generationId}:${stream}:${next}`, truncated: args.cursor === undefined && start > 0, hasMore: next < start + bytes.length };
      }
      case 'list_files': {
        ready();
        const path = guestPath(args.path as string);
        if (!getWebMcpRuntimeCapabilities(host).listFiles) throw new ToolError('UNSUPPORTED_CAPABILITY', 'Directory listing requires a guest directory API that this live backend does not expose');
        const entries = await listGuestDirectory(host, path);
        sameGeneration(current);
        const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 100);
        return { entries: entries.slice(offset, offset + limit), nextOffset: Math.min(offset + limit, entries.length), hasMore: offset + limit < entries.length };
      }
      case 'read_file': {
        ready();
        const bytes = await readGuestFile(host, guestPath(args.path as string));
        checkSignal(signal); sameGeneration(current);
        const offset = Number(args.offset ?? 0);
        const chunk = bytes.subarray(offset, offset + Number(args.byteLimit ?? 4096));
        return { path: args.path, encoding: args.encoding ?? 'utf8', content: args.encoding === 'base64' ? btoa(Array.from(chunk, b => String.fromCharCode(b)).join('')) : decoder.decode(chunk), bytesRead: chunk.length, nextOffset: offset + chunk.length, eof: offset + chunk.length >= bytes.length, truncated: offset + chunk.length < bytes.length };
      }
      case 'write_file': {
        ready();
        const path = guestPath(args.path as string);
        let bytes: Uint8Array;
        if (args.encoding === 'base64') {
          const content = args.content as string;
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new ToolError('INVALID_ARGUMENT', 'Expected standard padded base64');
          bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0));
        } else bytes = encoder.encode(args.content as string);
        if (bytes.length > 65536) throw new ToolError('LIMIT_EXCEEDED', 'File write exceeds 65536 bytes');
        checkSignal(signal); sameGeneration(current);
        await writeGuestFile(host, path, bytes, args.overwrite as boolean);
        sameGeneration(current);
        return { path, bytesWritten: bytes.length };
      }
      case 'navigate_preview': {
        ready();
        const path = args.path as string;
        let decoded: string;
        try { decoded = decodeURIComponent(path.split(/[?#]/)[0]); } catch { throw new ToolError('INVALID_ARGUMENT', 'Malformed URL encoding'); }
        guestPath(decoded);
        if (path.startsWith('//') || decoded.startsWith('//') || /[\\\x00-\x20]/.test(path) || /%25/i.test(path)) throw new ToolError('INVALID_ARGUMENT', 'Preview requires a guest URL path');
        const preview = host.getWebPreview();
        if (!preview) throw new ToolError('UNSUPPORTED_CAPABILITY', 'This computer does not expose a web preview');
        if (preview.status !== 'running' || !get().navigatePreview(path)) throw new ToolError('NOT_READY', 'Web preview is not ready');
        return { requestedPath: path, navigationRequested: true, preview: host.getWebPreview(), previewProgress: getPreviewProgress(host) };
      }
      case 'read_logs': {
        const offset = parseCursor(args.cursor, 'logs', logStart, logStart + logs.length);
        const entries: LogEntry[] = [];
        let index = offset - logStart;
        while (index < logs.length && entries.length < Number(args.limit ?? 50)) {
          const entry = logs[index++];
          if (!args.level || entry.level === args.level) entries.push(entry);
        }
        return { entries, nextCursor: `${generationId}:logs:${logStart + index}`, truncated: (args.cursor === undefined && logStart > 0) || entries.some(e => e.messageTruncated), hasMore: index < logs.length };
      }
      case 'create_launch_link': {
        const item = args.profileId === undefined ? undefined : await resolvedProfile(args.profileId as string);
        let descriptor = item ? descriptorFromGalleryItem(item, host.getBootDescriptor()) : host.getBootDescriptor();
        if (item) descriptor = { ...descriptor, boot: { ...descriptor.boot, inputs: undefined, parameters: undefined } };
        const url = new URL(item ? galleryItemUrl(item) : location.href);
        if (args.startupScript !== undefined) {
          const script = args.startupScript as string;
          const bytes = encoder.encode(script.endsWith('\n') ? script : `${script}\n`);
          if (bytes.length > HARD_CAPS.maxInlineInflatedInputBytes) throw new ToolError('LIMIT_EXCEEDED', 'Startup script exceeds inline inflated input limit');
          descriptor = { ...descriptor, boot: { ...descriptor.boot, inputs: [await createInlineBootInput({ id: 'script', filename: 'kandelo-link.sh', bytes, compression: 'gzip' })], parameters: { runScript: 'script', runScriptShell: 'bash' } } };
        }
        url.hash = (await encodeBootDescriptor(descriptor)).fragment;
        checkSignal(signal); sameGeneration(current);
        return { url: url.href, sizeBytes: encoder.encode(url.href).length, reproduces: 'Boot configuration and encoded startup inputs only; no modified files, processes or terminal state.' };
      }
      default: throw new ToolError('UNKNOWN_TOOL', name);
    }
  }
  async function invoke(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    if (args.requestId === undefined) return execute(name, args, signal);
    const key = `${name}:${args.requestId}`;
    const fingerprint = JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))));
    const prior = requests.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ToolError('REQUEST_CONFLICT', 'Retry key was already used with different arguments');
      return prior.result;
    }
    if (requests.size >= MAX_REQUESTS) throw new ToolError('LIMIT_EXCEEDED', 'Document retry-key capacity reached; no mutation performed');
    const result = execute(name, args, signal);
    requests.set(key, { fingerprint, result });
    return result;
  }
  // Registration is serialized across StrictMode teardown/remount, so an old
  // async registration cannot replace or unregister the new instance's tools.
  registration = registration.catch(() => {}).then(async () => {
    for (const [name, description, readOnlyHint, properties, required] of contracts) {
      if (controller.signal.aborted) break;
      const inputSchema: Schema = { type: 'object', properties: properties as Record<string, Schema>, required: [...required], additionalProperties: false };
      await context.registerTool({ name: `kandelo_${name}`, description, inputSchema, annotations: { readOnlyHint, untrustedContentHint: true }, execute: async (args, options) => {
        try {
          validate(args, inputSchema);
          const result = await invoke(name, args, options?.signal);
          return JSON.stringify({ ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code = error instanceof ToolError ? error.code : /no synchronous VFS surface|no writeFileToVfs/.test(message) ? 'UNSUPPORTED_CAPABILITY' : /ENOENT/.test(message) ? 'FILE_NOT_FOUND' : 'OPERATION_FAILED';
          return JSON.stringify({ ok: false, error: { code, message, ...(error instanceof ToolError ? error.details : {}) } });
        }
      } }, { signal: controller.signal });
    }
  }).catch(error => { if (!controller.signal.aborted) console.warn('WebMCP registration failed', error); });
  sync();
  const dispose = () => { disposed = true; controller.abort(); offStatus(); offLogs(); invalidate(); };
  return Object.assign(dispose, { sync });
}
let registration: Promise<void> = Promise.resolve();
