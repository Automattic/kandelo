import { expect, it, vi } from 'vitest';
import { DesktopOutputCapture } from '../../apps/browser-demos/grouped-desktop-output';

const encode = (text: string) => new TextEncoder().encode(text);
it('bounds diagnostics without truncating a command larger than the tail', async () => {
  const out = new DesktopOutputCapture(11);
  const reply = await out.capture(async () => {
    for (let i = 0; i < 1000; i++) out.appendStdout(encode(`${i},`));
    return 0;
  });
  const expected = Array.from({ length: 1000 }, (_, i) => `${i},`).join('');
  expect(reply).toEqual({ code: 0, stdout: expected });
  expect(out.stdout).toBe(expected.slice(-11));
  expect(out.stdoutDiscardedBytes).toBe(encode(expected).length - 11);
});
it('preserves split UTF-8 replies and owns buffers independently of the callback', async () => {
  const out = new DesktopOutputCapture(5), text = 'a🧪é end', bytes = encode(text);
  const reply = await out.capture(async () => {
    for (const byte of bytes) {
      const chunk = Uint8Array.of(byte); out.appendStdout(chunk); chunk[0] = 0;
    }
    return 7;
  });
  expect(reply).toEqual({ code: 7, stdout: text });
  expect(out.stdout).toBe(' end'); // The suffix starts inside é; no false replacement character.
  expect(out.stdoutDiscardedBytes).toBe(bytes.length - 5);
});
it('keeps stderr separate, including wraparound and a chunk larger than capacity', async () => {
  const out = new DesktopOutputCapture(4);
  out.appendStderr(encode('abc')); out.appendStderr(encode('def'));
  expect(out.stderr).toBe('cdef'); expect(out.stderrDiscardedBytes).toBe(2);
  const reply = await out.capture(async () => {
    out.appendStderr(encode('0123456789')); out.appendStdout(encode('ok')); return 0;
  });
  expect(reply.stdout).toBe('ok'); expect(out.stderr).toBe('6789');
  expect(out.stderrDiscardedBytes).toBe(12); expect(out.stdoutDiscardedBytes).toBe(0);
});
it('refuses concurrent capture before retaining or running another command', async () => {
  const out = new DesktopOutputCapture(8);
  let finish!: (value: number) => void;
  const pending = out.capture(() => new Promise(resolve => { finish = resolve; }));
  const other = vi.fn(async () => 1);
  await expect(out.capture(other)).rejects.toThrow('already owns stdout'); expect(other).not.toHaveBeenCalled();
  out.appendStdout(encode('first')); finish(0);
  expect(await pending).toEqual({ code: 0, stdout: 'first' });
});
it('releases capture on failure while keeping its diagnostic bytes', async () => {
  const out = new DesktopOutputCapture(16), failure = Error('launch failed');
  await expect(out.capture(async () => { out.appendStdout(encode('failed')); throw failure; })).rejects.toBe(failure);
  expect(out.stdout).toBe('failed');
  expect(await out.capture(async () => { out.appendStdout(encode('next')); return 0; })).toEqual({ code: 0, stdout: 'next' });
});
