import { BrowserKernel } from '../../host/src/browser-kernel-host';
import { BrowserInputSource } from '../../host/src/input/browser-input-source';
import { ABSOLUTE_POINTER_EXTENT, absolutePointerValue, type InputEvent as KernelInputEvent } from '../../host/src/input/input-source';
import { pointerButtons } from '../../host/src/input/pointer-buttons';
import { INPUT_CODES } from '../../host/src/generated/abi';
import { DesktopOutputCapture } from './grouped-desktop-output';

const style = document.createElement('style');
style.textContent = 'body{margin:0;background:#16191d;color:#eee;font:14px system-ui}header{padding:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}button{padding:7px 12px}#status{padding:0 12px 12px;white-space:pre-wrap}.desktop{position:relative;outline:none}.desktop canvas{position:absolute;left:0;top:0}main{overflow:auto}';
document.head.append(style);
const header = document.createElement('header'), title = document.createElement('strong');
title.textContent = 'Shared-memory Sway · experimental'; header.append(title);
const status = document.createElement('div'); status.id = 'status';
status.textContent = 'Opt in to start a temporary trusted desktop. Reload starts a fresh machine.';
const main = document.createElement('main'); document.body.replaceChildren(header, status, main);
const fail = (error: unknown) => { status.dataset.error = 'true'; status.textContent = String(error); console.error(error); };
let kernel: BrowserKernel | undefined;
let ready = false;
const env = ['LIBSEAT_BACKEND=noop', 'WLR_RENDERER=gles2', 'XDG_RUNTIME_DIR=/tmp', 'PATH=/usr/bin:/bin',
  'HOME=/home/user', 'SHELL=/bin/sh', 'SWAYSOCK=/tmp/sway-ipc.sock', 'XDG_CONFIG_HOME=/usr/share/kandelo',
  'FONTCONFIG_FILE=/usr/share/kandelo/fonts/fonts.conf'];
const output = new DesktopOutputCapture();
const state = { get stdout() { return output.stdout; }, get stderr() { return output.stderr; },
  get stdoutDiscardedBytes() { return output.stdoutDiscardedBytes; },
  get stderrDiscardedBytes() { return output.stderrDiscardedBytes; }, outputTailBytes: output.tailBytes,
  rootPid: undefined as number | undefined, rootExit: undefined as number | undefined,
  diagnostics: [] as unknown[], trace: [] as unknown[], startupTrace: [] as unknown[], keys: [] as unknown[], input: [] as unknown[],
  processEvents: [] as { kind: 'spawn' | 'exec' | 'exit'; pid: number; ppid?: number; exitStatus?: number; receivedAt: number }[],
  commands: [] as { args: string[]; code: number; stdout: string }[], ready: false, stopping: false };
const page = window as typeof window & { groupedDesktop?: unknown };
const action = (label: string, callback: () => Promise<unknown>, requiresReady = true) => {
  const button = document.createElement('button'); button.textContent = label;
  button.onclick = async () => {
    if (requiresReady && !ready) return;
    button.disabled = true;
    try { await callback(); } catch (error) { if (!requiresReady || !state.stopping) fail(error); } finally { button.disabled = false; }
  };
  header.append(button); return button;
};
let commandTail = Promise.resolve();
let controlProgram: Uint8Array | undefined;
const command = (...args: string[]) => {
  const result = commandTail.then(async () => {
  if (!kernel || state.stopping) throw Error('Desktop is unavailable');
  controlProgram ??= await kernel.readFileFromVfs('/usr/bin/swaymsg') ?? undefined;
  if (!controlProgram) throw Error('Swaymsg is missing from the image');
  const { code, stdout } = await output.capture(() => kernel!.spawn(Uint8Array.from(controlProgram!).buffer,
    ['swaymsg', '-r', ...args], { env, cwd: '/tmp', uid: 1000, gid: 1000 }));
  const result = { args, code, stdout };
  state.commands.push(result); if (state.commands.length > 32) state.commands.shift();
  if (code !== 0) throw Error(`Sway command exited ${code}\n${state.stderr}`);
  main.querySelector<HTMLElement>('.desktop')?.focus(); return result;
  });
  commandTail = result.then(() => {}, () => {});
  return result;
};
action('Start shared desktop', async () => {
  if (kernel) throw Error('Reload to start a fresh machine');
  delete status.dataset.error;
  status.textContent = 'Loading the desktop…';
  const maximumPages = Number(new URLSearchParams(location.search).get('groupPages') ?? 8192);
  if (!Number.isSafeInteger(maximumPages) || maximumPages < 256 || maximumPages > 8192) throw Error('Invalid group page budget');
  kernel = new BrowserKernel({ kernelOwnedFs: true,
    experimentalMemoryGroup: { maximumPages, maximumProcesses: 24, maximumTasks: 64 },
    onStdout: bytes => output.appendStdout(bytes),
    onStderr: bytes => output.appendStderr(bytes),
    onProcessEvent: event => {
      // Keep parent identity for failed launches without polling the kernel.
      state.processEvents.push({ ...event, receivedAt: performance.now() });
      if (state.processEvents.length > 512) state.processEvents.shift();
    },
    onHostDiagnostic: event => { state.diagnostics.push(event); if (!state.stopping) fail(event.message || 'Desktop worker failed'); },
  });
  const [kernelResponse, imageResponse] = await Promise.all([fetch('/__grouped_preview/kernel.wasm'), fetch('/__grouped_preview/image.vfs.zst')]);
  if (!kernelResponse.ok || !imageResponse.ok) throw Error('Desktop artifacts are unavailable');
  await kernel.initFromImage({ kernelWasm: await kernelResponse.arrayBuffer(),
    vfsImage: new Uint8Array(await imageResponse.arrayBuffer()), lazyUrlBase: location.origin + '/', lazyAssetDirectory: location.origin + '/' });
  if (new URLSearchParams(location.search).has('trace')) kernel.subscribeSyscalls(event => {
    if (state.startupTrace.length < 1024) state.startupTrace.push(event);
    state.trace.push(event); if (state.trace.length > 2048) state.trace.shift();
  });
  const query = new URLSearchParams(location.search);
  const dimension = (name: string, fallback: number, min: number, max: number) => {
    const value = query.has(name) ? Number(query.get(name)) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw Error(`Invalid ${name}`); return value;
  };
  const width = dimension('width', Math.min(1920, Math.max(1024, innerWidth)), 1024, 3072);
  const height = dimension('height', Math.min(1080, Math.max(640, innerHeight - 110)), 640, 1728);
  const display = document.createElement('div'); display.className = 'desktop'; display.tabIndex = 0;
  display.style.width = `${width}px`; display.style.height = `${height}px`;
  const scene = document.createElement('canvas'), cursor = document.createElement('canvas'); scene.id = 'desktop-scene';
  for (const canvas of [scene, cursor]) { canvas.width = width; canvas.height = height; display.append(canvas); }
  main.append(display); display.addEventListener('pointerdown', () => display.focus());
  const stats = new Int32Array(new SharedArrayBuffer(36));
  kernel.kmsSetDisplaySize(1, width, height);
  kernel.kmsAttachBitmapRelay(1, scene.transferControlToOffscreen(), stats.buffer, { mode: 'webgl2-scanout', cursorCanvas: cursor.transferControlToOffscreen() });
  const tracing = query.has('trace');
  const input = new BrowserInputSource(window, { pointer: false, wheel: true, shouldCapture: event => {
    const capture = display.contains(event.target as Node) || document.activeElement === display && event instanceof KeyboardEvent;
    if (tracing && event instanceof KeyboardEvent && state.keys.length < 256) state.keys.push({ type: event.type,
      code: event.code, key: event.key, capture, active: document.activeElement?.className, target: (event.target as Element)?.tagName });
    return capture;
  } });
  let cleanupPointer = () => {};
  kernel.attachInputSource({ start: dispatch => {
    const emit = (event: KernelInputEvent) => {
      if (tracing && state.input.length < 512) state.input.push({ ...event });
      dispatch(event);
    };
    input.start(emit);
    const { EV_ABS, EV_SYN, EV_KEY, SYN_REPORT, ABS_X, ABS_Y, BTN_LEFT, BTN_RIGHT, BTN_MIDDLE } = INPUT_CODES;
    const frame = (records: KernelInputEvent[]) => {
      for (const record of records) emit(record);
      emit({ device: 1, ev_type: EV_SYN, code: SYN_REPORT, value: 0 });
    };
    let buttons = 0, active = false;
    const setButtons = (next: number) => {
      const changed = buttons ^ next;
      if (!changed) return;
      const records: KernelInputEvent[] = [];
      for (const value of [0, 1]) for (const [bit, code] of [[1, BTN_LEFT], [2, BTN_RIGHT], [4, BTN_MIDDLE]]) {
        if ((changed & bit) && Number(Boolean(next & bit)) === value) records.push({ device: 1, ev_type: EV_KEY, code, value });
      }
      frame(records); buttons = next;
    };
    const release = () => { setButtons(0); active = false; };
    const pointer = (event: PointerEvent) => {
      const inside = display.contains(event.target as Node);
      if (!inside && !active && !buttons) return;
      if (event.type === 'pointerdown' && inside) { active = true; display.focus(); }
      if (inside || active) {
        const rect = display.getBoundingClientRect();
        // Use the same fixed absolute-device space as the normal Modeset
        // surface. BrowserInputSource owns keyboard/wheel, not a competing
        // relative pointer feed into this absolute evdev device.
        if (rect.width > 0 && rect.height > 0) frame([
          { device: 1, ev_type: EV_ABS, code: ABS_X, value: absolutePointerValue((event.clientX - rect.left) * width / rect.width, width) },
          { device: 1, ev_type: EV_ABS, code: ABS_Y, value: absolutePointerValue((event.clientY - rect.top) * height / rect.height, height) },
        ]);
        event.preventDefault();
      }
      setButtons(pointerButtons(buttons, event, event.type === 'pointerdown' ? 'down' : event.type === 'pointerup' ? 'up' : 'move', active));
      if (event.type === 'pointerup') active = buttons !== 0;
    };
    for (const type of ['pointermove', 'pointerdown', 'pointerup']) window.addEventListener(type, pointer as EventListener);
    window.addEventListener('blur', release); window.addEventListener('pointercancel', release);
    cleanupPointer = () => {
      release();
      for (const type of ['pointermove', 'pointerdown', 'pointerup']) window.removeEventListener(type, pointer as EventListener);
      window.removeEventListener('blur', release); window.removeEventListener('pointercancel', release);
    };
  }, stop: () => { cleanupPointer(); input.stop(); } }, { width: ABSOLUTE_POINTER_EXTENT, height: ABSOLUTE_POINTER_EXTENT });
  page.groupedDesktop = { kernel, state, stats, command };
  // The standard byte-launch API explicitly admits a compatible artifact.
  // Its bytes come from this machine's ordinary SDK/package-produced image.
  const program = await kernel.readFileFromVfs('/usr/bin/sway');
  if (!program) throw Error('Sway is missing from the image');
  void kernel.spawn(Uint8Array.from(program).buffer, ['sway', '-c', '/usr/share/kandelo/sway/config'],
    { env, cwd: '/tmp', uid: 1000, gid: 1000, onStarted: pid => { state.rootPid = pid; } })
    .then(code => { state.rootExit = code; if (code && !state.stopping) fail(`Sway exited ${code}\n${state.stderr}`); }).catch(fail);
  const deadline = performance.now() + 180000;
  while (performance.now() < deadline) {
    if (state.rootExit !== undefined) throw Error(`Sway exited ${state.rootExit}\n${state.stderr}`);
    const processes = await kernel.enumProcs();
    const terminal = processes.find(process => process.comm === 'foot' && processes.some(child =>
      child.ppid === process.pid && (child.comm === 'sh' || child.comm === 'bash')));
    if (Atomics.load(stats, 5) > 0 && terminal) {
      const result = await command('-t', 'get_tree');
      // IPC exposes pending layout before Sway applies the initial scene.
      // This image uses normal decorations; their current state distinguishes
      // an applied terminal from a node that cannot receive the first click.
      const hasTerminal = (node: any): boolean => node.app_id === 'foot' && node.pid === terminal.pid && node.visible
        && node.border === 'normal' && node.current_border_width > 0 && node.deco_rect?.height > 0
        || [...(node.nodes ?? []), ...(node.floating_nodes ?? [])].some(hasTerminal);
      if (hasTerminal(JSON.parse(result.stdout))) {
        ready = state.ready = true; display.focus(); status.textContent = 'Click the desktop to type. Use the buttons to open terminals or move between workspaces.'; return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error(`Desktop startup timed out\n${state.stderr}`);
}, false);
action('New terminal', () => command('exec foot --config=/usr/share/kandelo/sway/foot.ini'));
action('Workspace 1', () => command('workspace number 1'));
action('Workspace 2', () => command('workspace number 2'));
action('Move to 1', () => command('move container to workspace number 1'));
action('Move to 2', () => command('move container to workspace number 2'));
action('Stop', async () => { state.stopping = true; ready = state.ready = false; await kernel?.destroy(); status.textContent = 'Stopped. Reload to start a fresh machine.'; }, false);
