import { afterEach, expect, it, vi } from 'vitest';
import { registerWebMcp, type AppBindings } from '../../apps/browser-demos/pages/kandelo/webmcp/adapter';
import type { GalleryItem } from '../../web-libs/kandelo-session/src/gallery';
import type { KernelHost } from '../../web-libs/kandelo-session/src/kernel-host';

afterEach(() => vi.unstubAllGlobals());

type Tool = { execute(args: Record<string, unknown>, options: { signal: AbortSignal }): Promise<string> };

const foo: GalleryItem = { id: 'foo', title: 'Foo', summary: 'Foo machine', vfsImageUrl: 'https://kandelo.local/foo.vfs.zst' } as GalleryItem;
const bar: GalleryItem = { id: 'bar', title: 'Bar', summary: 'Bar machine' } as GalleryItem;

function harness(href: string) {
  const tools = new Map<string, Tool>();
  const timers: (() => void)[] = [];
  vi.stubGlobal('document', { modelContext: { registerTool: async (tool: Tool & { name: string }) => { tools.set(tool.name, tool); } } });
  vi.stubGlobal('location', { href });
  vi.stubGlobal('window', { location: { href }, setTimeout: (run: () => void) => { timers.push(run); return timers.length; } });
  const host = {
    getStatus: () => 'running',
    getSurfaceAvailability: () => ({ terminal: false }),
    getWebPreview: () => null,
    galleryQuery: async () => [foo, bar],
    dmesgHistory: () => [],
    subscribeStatus: () => () => {},
    subscribeDmesg: () => () => {},
  } as unknown as KernelHost;
  const launch = vi.fn(async () => {});
  const dispose = registerWebMcp(() => ({ host, terminals: [], launch } as unknown as AppBindings));
  const call = async (args: Record<string, unknown>) =>
    JSON.parse(await tools.get('kandelo_launch_computer')!.execute(args, { signal: new AbortController().signal }));
  return { tools, timers, launch, dispose, call };
}

it('acknowledges a deferred launch with the destination URL and no rediscovery hint', async () => {
  const { tools, timers, launch, dispose, call } = harness('https://kandelo.local/');
  try {
    await vi.waitFor(() => expect(tools.has('kandelo_launch_computer')).toBe(true));
    const result = await call({ profileId: 'foo' });
    expect(result).toEqual({ ok: true, initiated: true, destinationUrl: `https://kandelo.local/?vfs=${encodeURIComponent(foo.vfsImageUrl!)}&profile=foo` });
    expect(launch).not.toHaveBeenCalled();
    timers.forEach(run => run());
    expect(launch).toHaveBeenCalledWith(foo);
  } finally {
    dispose();
  }
});

it('reports the current machine as already current without booting it again', async () => {
  const href = `https://kandelo.local/?vfs=${encodeURIComponent(foo.vfsImageUrl!)}&profile=foo`;
  const { tools, launch, dispose, call } = harness(href);
  try {
    await vi.waitFor(() => expect(tools.has('kandelo_launch_computer')).toBe(true));
    expect(await call({ profileId: 'foo' })).toEqual({ ok: true, initiated: false, alreadyCurrent: true, destinationUrl: href, status: 'running' });
    expect(launch).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});

it('awaits a machine that carries no image URL and reports its status', async () => {
  const { tools, launch, dispose, call } = harness('https://kandelo.local/');
  try {
    await vi.waitFor(() => expect(tools.has('kandelo_launch_computer')).toBe(true));
    expect(await call({ profileId: 'bar' })).toEqual({ ok: true, initiated: true, destinationUrl: null, status: 'running' });
    expect(launch).toHaveBeenCalledWith(bar);
  } finally {
    dispose();
  }
});

it('rejects a profile the gallery does not offer', async () => {
  const { tools, launch, dispose, call } = harness('https://kandelo.local/');
  try {
    await vi.waitFor(() => expect(tools.has('kandelo_launch_computer')).toBe(true));
    expect(await call({ profileId: 'baz' })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_PROFILE' } });
    expect(launch).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});
