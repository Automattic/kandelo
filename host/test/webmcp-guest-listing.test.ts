import { expect, it } from 'vitest';
import type { BrowserKernel } from '../src/browser-kernel-host';
import type { VfsDirEntry } from '../src/browser-kernel-protocol';
import type { KernelHost } from '../../web-libs/kandelo-session/src/kernel-host';
import { listGuestDirectory, setWebMcpRuntime } from '../../apps/browser-demos/pages/kandelo/webmcp/runtime';

function runningHost(entries: VfsDirEntry[] | null) {
  const host = {
    getStatus: () => 'running',
    subscribeStatus: () => () => {},
  } as unknown as KernelHost;
  const kernel = { readDirFromVfs: async () => entries } as unknown as BrowserKernel;
  setWebMcpRuntime(host, kernel);
  return host;
}

const entry = (over: Partial<VfsDirEntry>): VfsDirEntry =>
  ({ name: 'foo', type: 8, mode: 0o644, size: 3, uid: 0, gid: 0, ...over });

it('names each dirent type the way the tool contract describes it', async () => {
  const host = runningHost([
    entry({ name: 'bar', type: 4 }),
    entry({ name: 'baz', type: 8 }),
    entry({ name: 'qux', type: 10, target: '/bar' }),
    entry({ name: 'quux', type: 1 }),
  ]);

  const byName = new Map((await listGuestDirectory(host, '/foo')).map((e) => [e.name, e.type]));

  expect(byName.get('bar')).toBe('directory');
  expect(byName.get('baz')).toBe('file');
  expect(byName.get('qux')).toBe('symlink');
  expect(byName.get('quux')).toBe('other');
});

it('keeps the stat metadata and the symlink target', async () => {
  const host = runningHost([entry({ name: 'qux', type: 10, mode: 0o777, size: 7, uid: 1000, gid: 1000, target: '/bar' })]);

  expect(await listGuestDirectory(host, '/foo')).toEqual([
    { name: 'qux', type: 'symlink', mode: 0o777, size: 7, uid: 1000, gid: 1000, target: '/bar' },
  ]);
});

it('omits target for an entry that is not a symlink', async () => {
  const host = runningHost([entry({ name: 'baz' })]);

  expect(Object.hasOwn((await listGuestDirectory(host, '/foo'))[0]!, 'target')).toBe(false);
});

it('orders entries by name so offset and limit line up across calls', async () => {
  const host = runningHost([entry({ name: 'qux' }), entry({ name: 'bar' }), entry({ name: 'baz' })]);

  expect((await listGuestDirectory(host, '/foo')).map((e) => e.name)).toEqual(['bar', 'baz', 'qux']);
});

it('reports a missing directory as FILE_NOT_FOUND rather than an empty listing', async () => {
  const host = runningHost(null);

  await expect(listGuestDirectory(host, '/foo')).rejects.toMatchObject({
    code: 'FILE_NOT_FOUND',
  });
});
