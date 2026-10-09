import { expect, it } from 'vitest';
import type { KernelHost } from '../../web-libs/kandelo-session/src/kernel-host';
import { beginPreviewNavigation, getPreviewProgress, observePreviewRequest, previewDocumentLoaded, previewRendered, resetPreviewProgress } from '../../apps/browser-demos/pages/kandelo/panes/preview-progress';
import { compactToolCatalog } from '../../apps/browser-demos/pages/kandelo/webmcp/discovery';

it('does not let late HTTP, load or paint observations complete a newer navigation', () => {
  const host = {} as KernelHost;
  const first = beginPreviewNavigation(host, '/first');
  const reply = observePreviewRequest(host, '/first')!;
  const second = beginPreviewNavigation(host, '/second?q=1#title');
  reply(200);
  expect(previewDocumentLoaded(host, '/first')).toBeNull();
  previewRendered(host, first);
  expect(getPreviewProgress(host)).toMatchObject({ navigationId: 2, http: { state: 'pending' }, documentLoaded: false, rendered: false });
  expect(observePreviewRequest(host, '/favicon.ico')).toBeUndefined();
  observePreviewRequest(host, '/second?q=1')!(404);
  expect(getPreviewProgress(host)?.http).toEqual({ state: 'received', status: 404 });
  expect(previewDocumentLoaded(host, '/second?q=1#title')).toBe(second);
  previewRendered(host, second);
  expect(getPreviewProgress(host)?.rendered).toBe(true);
  resetPreviewProgress(host);
  expect(getPreviewProgress(host)).toBeNull();
});

it('serializes a long document URL once and omits browser-owned per-tool metadata', () => {
  const url = `https://example.test/#${'encoded'.repeat(1000)}`;
  const tools = [1, 2].map(id => ({ name: `kandelo_${id}`, description: 'A tool', inputSchema: {}, url, window: {} }));
  const serialized = JSON.stringify(compactToolCatalog({ generationId: 'generation', title: 'Kandelo', url }, tools));
  expect(serialized.split(url)).toHaveLength(2);
  expect(serialized).not.toContain('"window"');
});
