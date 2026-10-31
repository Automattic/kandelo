import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const vendor = readFileSync(new URL('../../third_party/node-web-platform/node-web-platform.js', import.meta.url), 'utf8');
function section(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('Missing body source boundary');
  return source.slice(a, b);
}
const web = Function(`${vendor};return _createNodeWebPlatform();`)();
const data = Function('_nodeWebPlatform', section('const _nodeBodyData =', "if (typeof globalThis.Blob === 'undefined')") + ';return _nodeBodyData;')(web);
const subject = Function('_nodeWebPlatform', '_nodeBodyData', '_nodeNative',
  section('    class FetchHeaders {', '    class FetchRequest {') +
  ';return {Response:FetchResponse,Headers:FetchHeaders,ReadableStream:WebReadableStream,Blob:_nodeBodyData.Blob,URLSearchParams:_nodeWebPlatform.URLSearchParams};')
  (web, data, { cloneValue: structuredClone });
const native = { Response, Headers, ReadableStream, Blob, URLSearchParams };
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const state = (response: any) => [response.bodyUsed, response.body?.locked ?? null];
async function outcome(fn: () => unknown) {
  try { return { value: await fn() }; } catch (error: any) { return { name: error.name }; }
}
const bytes = async (response: any) => Array.from(new Uint8Array(await response.arrayBuffer()));

describe.skipIf(process.versions.node !== target.version)('Response body state against pinned Node', () => {
  it('uses the actual stream disturbance state for readers, cancellation and pipes', async () => {
    for (const op of ['lock', 'read', 'cancel', 'reader-cancel', 'pipe']) {
      const run = async (api: any) => {
        const r = new api.Response('hello'); const states = [state(r)];
        if (op === 'cancel') { await r.body.cancel('done'); states.push(state(r)); }
        else if (op === 'pipe') {
          // Each implementation needs its matching WritableStream constructor.
          const Sink = api === subject ? web.streams.WritableStream : WritableStream;
          await r.body.pipeTo(new Sink({ write() {} })); states.push(state(r)); }
        else {
          const reader = r.body.getReader(); states.push(state(r));
          if (op === 'read') { const read = reader.read(); states.push(state(r)); await read; }
          if (op === 'reader-cancel') await reader.cancel('done');
          states.push(state(r)); reader.releaseLock(); states.push(state(r));
        }
        return { states, consume: await outcome(() => r.text()), clone: await outcome(() => { r.clone(); return true; }) };
      };
      expect(await run(subject), op).toEqual(await run(native));
    }
  });

  it('rejects locked consumption without marking an untouched body used', async () => {
    const run = async (api: any) => {
      const r = new api.Response('hello'), reader = r.body.getReader();
      const rejected = await outcome(() => r.arrayBuffer()); const locked = state(r);
      reader.releaseLock(); return [rejected, locked, await r.text(), state(r)];
    };
    expect(await run(subject)).toEqual(await run(native));
  });

  it('keeps null bodies reusable while empty non-null bodies are consumed', async () => {
    for (const body of [null, undefined, '', new Uint8Array(0), new ArrayBuffer(0)]) {
      const run = async (api: any) => {
        const r = new api.Response(body); const before = state(r);
        const first = await outcome(() => r.text()); const after = state(r);
        return [before, first, after, await outcome(() => r.text()), await outcome(() => { r.clone(); return true; })];
      };
      expect(await run(subject)).toEqual(await run(native));
    }
  });

  it('shares single-consumer state across all body methods and JSON failures', async () => {
    for (const method of ['arrayBuffer', 'bytes', 'text', 'json', 'blob']) {
      const run = async (api: any) => {
        const r = new api.Response('{"a":1}');
        const read = r[method](); const beforeAwait = state(r); await read;
        return [beforeAwait, state(r), await outcome(() => r.text()), await outcome(() => { r.clone(); return true; })];
      };
      expect(await run(subject), method).toEqual(await run(native));
    }
    const run = async (api: any) => { const r = new api.Response('bad json'); return [await outcome(() => r.json()), state(r), await outcome(() => r.text())]; };
    expect(await run(subject)).toEqual(await run(native));
  });

  it('rejects invalid stream chunks and preserves source failure identity', async () => {
    for (const chunk of ['string', [], {}, new Int8Array([1]), new DataView(new ArrayBuffer(2)), new Uint8Array([1, 2])]) {
      const run = async (api: any) => {
        const r = new api.Response(new api.ReadableStream({ start(c: any) { c.enqueue(chunk); c.close(); } }));
        const result = await outcome(() => bytes(r)); return [result, state(r)];
      };
      expect(await run(subject)).toEqual(await run(native));
    }
    for (const api of [subject, native]) {
      const error = Error('source failure');
      const r = new api.Response(new api.ReadableStream({ start(c: any) { c.error(error); } }));
      try { await r.text(); throw Error('missing rejection'); } catch (actual) { expect(actual).toBe(error); }
      expect(r.bodyUsed).toBe(true);
    }
    const detachedBuffer = new ArrayBuffer(4), detached = new Uint8Array(detachedBuffer);
    structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
    const run = async (api: any) => {
      const r = new api.Response(new api.ReadableStream({ start(c: any) { c.enqueue(detached); c.close(); } }));
      return [await outcome(() => bytes(r)), state(r)];
    };
    expect(await run(subject)).toEqual(await run(native));
  });

  it('copies byte initializers and supports real Blob and URLSearchParams bodies', async () => {
    for (const kind of ['typed', 'data', 'buffer', 'blob', 'params', 'string', 'number']) {
      const run = async (api: any) => {
        const original = new Uint8Array([0, 65, 66, 0]);
        const body = kind === 'typed' ? original.subarray(1, 3) : kind === 'data' ? new DataView(original.buffer, 1, 2)
          : kind === 'buffer' ? original.buffer : kind === 'blob' ? new api.Blob([original.subarray(1, 3)], { type: 'text/plain' })
          : kind === 'params' ? new api.URLSearchParams([['a b', 'x+y']]) : kind === 'string' ? 'a\ud800b' : 12;
        const r = new api.Response(body); original.fill(90);
        return [r.headers.get('content-type'), await bytes(r)];
      };
      expect(await run(subject), kind).toEqual(await run(native));
    }
    const view = runInNewContext('new Uint8Array([1,2,3]).subarray(1)');
    expect(await bytes(new subject.Response(view))).toEqual(await bytes(new Response(view)));
  });

  it('clones readable bodies using independent byte storage and reader locks', async () => {
    for (const byteStream of [false, true]) {
      const run = async (api: any) => {
        const stream = new api.ReadableStream({ ...(byteStream ? { type: 'bytes' } : {}),
          start(c: any) { c.enqueue(new Uint8Array([1, 2])); c.close(); } });
        const r = new api.Response(stream), same = r.body === stream, c = r.clone();
        const states = [same, r.body === stream, stream.locked, ...state(r), ...state(c)];
        const reader = r.body.getReader(); const first = await reader.read(); first.value[0] = 99;
        return [states, await bytes(c), state(r), state(c)];
      };
      expect(await run(subject), `byteStream=${byteStream}`).toEqual(await run(native));
    }
    const r = new subject.Response('hello'), c = r.clone(), d = c.clone();
    expect(await Promise.all([r.text(), c.text(), d.text()])).toEqual(['hello', 'hello', 'hello']);
  });

  it('preserves tee cancellation reasons and permits the other branch to finish', async () => {
    const run = async (api: any) => {
      let reason: unknown;
      const stream = new api.ReadableStream({ cancel(value: unknown) { reason = value; } }, { highWaterMark: 0 });
      const r = new api.Response(stream), c = r.clone();
      const left = r.body.cancel('left'), right = c.body.cancel('right');
      await Promise.all([left, right]); return [reason, state(r), state(c)];
    };
    expect(await run(subject)).toEqual(await run(native));
    const r = new subject.Response('hello'), c = r.clone();
    await Promise.all([r.body.cancel('unused'), c.text().then((text: string) => expect(text).toBe('hello'))]);
  });

  it('rejects disturbed/locked constructor bodies and preserves copied headers on clone', async () => {
    const run = async (api: any) => {
      const stream = new api.ReadableStream({ start(c: any) { c.close(); } });
      const reader = stream.getReader();
      const locked = await outcome(() => { new api.Response(stream); return true; });
      await reader.read(); reader.releaseLock();
      const disturbed = await outcome(() => { new api.Response(stream); return true; });
      const headers = new api.Headers({ 'x-name': 'original' });
      const r = new api.Response('data', { headers, status: 201 }), c = r.clone();
      headers.set('x-name', 'caller'); c.headers.set('x-name', 'clone');
      await Promise.all([r.text(), c.text()]);
      return [locked, disturbed, r.headers.get('x-name'), c.headers.get('x-name'), r.status, c.status];
    };
    expect(await run(subject)).toEqual(await run(native));
    expect(new subject.Response('x', { headers: new Map([['x-name', 'iterable']]) }).headers.get('x-name')).toBe('iterable');
  });

  it('uses byte streams for static bodies and returns genuine independent Blobs', async () => {
    const run = async (api: any) => {
      const r = new api.Response('hello', { headers: { 'content-type': 'text/plain' } });
      const blob = await r.blob(), a = new Uint8Array(await blob.arrayBuffer()); a[0] = 90;
      return [blob instanceof api.Blob, Object.prototype.toString.call(blob), blob.type, blob.size, await blob.text(), await blob.slice(1, -1).text()];
    };
    expect(await run(subject)).toEqual(await run(native));
    const r = new subject.Response('hello'), reader = r.body.getReader({ mode: 'byob' });
    expect(Array.from((await reader.read(new Uint8Array(5))).value)).toEqual([104, 101, 108, 108, 111]);
    const empty = new subject.Blob().stream().getReader({ mode: 'byob' });
    expect((await empty.read(new Uint8Array(4))).done).toBe(true);
  });

  it('does not trust shadowed response or stream convenience properties', async () => {
    const r = new subject.Response('hello'), reader = r.body.getReader();
    Object.defineProperty(r.body, 'locked', { value: false });
    (r as any)._bodyUsed = false; (r as any)._stream = null;
    await expect(r.text()).rejects.toBeInstanceOf(TypeError);
    const read = reader.read(); expect(r.bodyUsed).toBe(true); await read;
    reader.releaseLock(); await expect(r.text()).rejects.toBeInstanceOf(TypeError);
  });

  it('keeps response metadata and clone ownership in private state', async () => {
    const run = async (api: any) => {
      const r = new api.Response('hello', { status: 201, statusText: 'Created', url: 'https://ignored/', type: 'error' });
      const initial = [r.status, r.statusText, r.type, r.url, r.redirected];
      Object.defineProperties(r, { status: { value: 500 }, headers: { value: new api.Headers({ 'x-fake': 'yes' }) } });
      const c = r.clone(); return [initial, c.status, c.statusText, c.headers.get('x-fake'), await c.text(), await r.text()];
    };
    expect(await run(subject)).toEqual(await run(native));
    for (const status of [199, 200, 204, 205, 304, 599, 600, '201', 65736, NaN, 1n]) {
      for (const body of [null, 'x']) {
        const run = (api: any) => outcome(() => { const r = new api.Response(body, { status }); return [r.status, r.type]; });
        expect(await run(subject), `status=${String(status)}, body=${String(body)}`).toEqual(await run(native));
      }
    }
  });

  it('preserves immutable Blob data, slicing, endings and constructor failures', async () => {
    for (const endings of ['transparent', 'native']) for (const type of ['', 'TEXT/PLAIN', 'bad\u0100type', 1, false]) {
      const run = async (api: any) => {
        const input = new Uint8Array([0, 65, 66, 0]);
        const nested = new api.Blob(['nested']);
        const blob = new api.Blob([input.subarray(1, 3), new DataView(input.buffer, 1, 2), 'a\r\nb\rc\ud800', nested], { type, endings });
        input.fill(90);
        const a = new Uint8Array(await blob.arrayBuffer()); a.fill(90);
        return [blob.size, blob.type, await blob.text(), await blob.slice(1, -1, 'TEXT/PLAIN').text(),
          Array.from(await blob.bytes()), Array.from(new Uint8Array(await new api.Response(blob.stream()).arrayBuffer()))];
      };
      expect(await run(subject)).toEqual(await run(native));
    }
    for (const parts of [null, 1, true, 'string', {}]) {
      const run = async (api: any) => { try { new api.Blob(parts); return 'ok'; } catch (e: any) { return [e.name, e.code]; } };
      expect(await run(subject)).toEqual(await run(native));
    }
    for (const api of [subject, native]) {
      const descriptor = Object.getOwnPropertyDescriptor(api.Blob.prototype, 'size')!;
      expect(() => descriptor.get!.call({})).toThrow(TypeError);
    }
    for (const start of [-Infinity, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5, Infinity, NaN, 1n]) {
      const run = async (api: any) => outcome(() => new api.Blob(['abcd']).slice(start).text());
      expect(await run(subject), String(start)).toEqual(await run(native));
    }
    const text = '\ufeff' + 'a€\ud800'.repeat(20000);
    const run = async (api: any) => {
      const blob = new api.Blob([text]); let combined = '';
      for await (const chunk of blob.textStream()) combined += chunk;
      return combined;
    };
    expect(await run(subject)).toBe(await run(native));
  });
});
