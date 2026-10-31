/** Pull-based response wrappers must deliver data, completion, and cancellation. */
export const nodeWebStreamsSource = `
(async () => {
  const web = require('stream/web');
  const check = (value, message) => { if (!value) throw Error(message); };
  check(ReadableStream === web.ReadableStream, 'global and module stream disagree');
  const original = new ReadableStream({start(c) {c.enqueue('one'); c.enqueue('two'); c.close();}});
  const reader = original.getReader();
  const wrapped = new ReadableStream({
    async pull(c) {
      const chunk = await reader.read();
      if (chunk.done) c.close(); else c.enqueue(chunk.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const values = [];
  for await (const value of wrapped) values.push(value);
  check(values.join(',') === 'one,two', 'pull wrapper lost data or EOF');
  check(!wrapped.locked, 'async iterator retained reader lock');
  let cancellation;
  const pending = new ReadableStream({cancel(reason) {cancellation = reason;}}, {highWaterMark:0});
  const pendingReader = pending.getReader();
  const read = pendingReader.read();
  await pendingReader.cancel('stop');
  check((await read).done && cancellation === 'stop', 'cancel did not settle pending read');
  await pendingReader.closed;
  pendingReader.releaseLock();
  const failure = Error('source failure');
  const failed = new ReadableStream({pull(c) {c.error(failure);}}).getReader();
  let rejected = false;
  try {await failed.read();} catch (e) {rejected = e === failure;}
  await failed.closed.catch(() => {});
  check(rejected, 'source error was swallowed');
  let index = 0;
  const [left, right] = new ReadableStream({pull(c) {
    if (index === 3) c.close(); else c.enqueue(++index);
  }}).tee();
  const collect = async stream => {const out=[];for await(const item of stream) out.push(item);return out.join(',');};
  const branches = await Promise.all([collect(left), collect(right)]);
  check(branches[0] === '1,2,3' && branches[1] === branches[0], 'tee lost branch data');
  const sink = [];
  await new ReadableStream({start(c) {c.enqueue('hello');c.close();}})
    .pipeThrough(new TransformStream({transform(chunk,c) {c.enqueue(chunk.toUpperCase());}}))
    .pipeTo(new WritableStream({write(chunk) {sink.push(chunk);}}));
  check(sink.join('') === 'HELLO', 'transform or writable pipe failed');
  console.log('node-web-streams-ok');
})().catch(error => {console.error(error);process.exitCode=1;});
`;
export const nodeWebStreamsCommand = `set -eu\ncat > /tmp/node-web-streams.cjs <<'JS'\n${nodeWebStreamsSource}\nJS\nnode /tmp/node-web-streams.cjs\n`;
