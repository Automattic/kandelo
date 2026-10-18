import { afterEach, expect, it, vi } from 'vitest';
import { registerWebMcp, type AppBindings } from '../../apps/browser-demos/pages/kandelo/webmcp/adapter';
import type { KernelHost, WebPreviewState } from '../../web-libs/kandelo-session/src/kernel-host';

afterEach(() => vi.unstubAllGlobals());

it('distinguishes unsupported, initializing, and available previews through the tool response', async () => {
  type Tool = { execute(args: Record<string, unknown>, options: { signal: AbortSignal }): Promise<string> };
  const tools = new Map<string, Tool>();
  vi.stubGlobal('document', { modelContext: { registerTool: async (tool: Tool & { name: string }) => { tools.set(tool.name, tool); } } });
  let preview: WebPreviewState | null = null;
  const host = {
    getStatus: () => 'running',
    getSurfaceAvailability: () => ({ terminal: false }),
    getWebPreview: () => preview,
    dmesgHistory: () => [],
    subscribeStatus: () => () => {},
    subscribeDmesg: () => () => {},
  } as unknown as KernelHost;
  const navigatePreview = vi.fn(() => true);
  const dispose = registerWebMcp(() => ({ host, terminals: [], navigatePreview } as unknown as AppBindings));
  try {
    await vi.waitFor(() => expect(tools.has('kandelo_navigate_preview')).toBe(true));
    const call = async () => JSON.parse(await tools.get('kandelo_navigate_preview')!.execute({ path: '/' }, { signal: new AbortController().signal }));
    expect(await call()).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_CAPABILITY' } });
    preview = { label: 'Test', url: '/guest/', status: 'starting' };
    expect(await call()).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
    expect(navigatePreview).not.toHaveBeenCalled();
    preview.status = 'running';
    expect(await call()).toMatchObject({ ok: true, navigationRequested: true });
    expect(navigatePreview).toHaveBeenCalledWith('/');
    navigatePreview.mockReturnValue(false);
    expect(await call()).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
  } finally {
    dispose();
  }
});
