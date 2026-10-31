export const nodeResponseBodySource = `
async function main() {
  const check = (value, message) => { if (!value) throw Error(message); };
  const rejectsType = async fn => { let error; try { await fn(); } catch (e) { error = e; }
    check(error instanceof TypeError, 'expected TypeError'); };
  const failsType = fn => { let error; try { fn(); } catch (e) { error = e; }
    check(error instanceof TypeError, 'expected synchronous TypeError'); };
  const empty = new Response();
  check(empty.body === null && !empty.bodyUsed, 'null body state');
  check(await empty.text() === '' && await empty.text() === '' && !empty.bodyUsed, 'null body reused');
  check(empty.clone().body === null, 'null body clone');
  const zero = new Response('');
  check(await zero.text() === '' && zero.bodyUsed, 'empty stream consumption');
  await rejectsType(() => zero.text()); failsType(() => zero.clone());
  const locked = new Response('hello'), reader = locked.body.getReader();
  check(!locked.bodyUsed && locked.body.locked, 'lock is not disturbance');
  await rejectsType(() => locked.text()); check(!locked.bodyUsed, 'failed read disturbed body');
  reader.releaseLock(); check(await locked.text() === 'hello' && locked.bodyUsed, 'released lock');
  const external = new Response('read externally'), externalReader = external.body.getReader();
  const pending = externalReader.read(); check(external.bodyUsed, 'external read disturbance');
  await pending; externalReader.releaseLock(); await rejectsType(() => external.text());
  const cancelled = new Response('cancelled'); await cancelled.body.cancel();
  check(cancelled.bodyUsed, 'external cancellation disturbance'); failsType(() => cancelled.clone());
  const stream = new ReadableStream({start(c) {c.enqueue(new Uint8Array([65,66]));c.close();}});
  const original = new Response(stream), copy = original.clone();
  check(original.body !== stream && stream.locked && !original.bodyUsed && !copy.bodyUsed, 'tee ownership');
  const leftReader = original.body.getReader(); (await leftReader.read()).value[0] = 90;
  check(await copy.text() === 'AB', 'clone shares mutable bytes');
  let reason;
  const source = new ReadableStream({cancel(value) {reason=value;}}, {highWaterMark:0});
  const a = new Response(source), b = a.clone();
  await Promise.all([a.body.cancel('left'), b.body.cancel('right')]);
  check(JSON.stringify(reason) === '["left","right"]', 'tee cancellation reasons');
  const failed = Error('source failure');
  const failedResponse = new Response(new ReadableStream({start(c) {c.error(failed);}}));
  let actual; try { await failedResponse.text(); } catch (e) { actual = e; }
  check(actual === failed && failedResponse.bodyUsed, 'source error identity');
  const invalid = new Response(new ReadableStream({start(c) {c.enqueue('not bytes');c.close();}}));
  await rejectsType(() => invalid.arrayBuffer()); check(invalid.bodyUsed, 'invalid chunk not consumed');
  const input = new Uint8Array([0,65,66,0]);
  const bytes = new Response(new DataView(input.buffer,1,2)); input.fill(90);
  check(await bytes.text() === 'AB', 'body input was not copied');
  const response = new Response('hello', {headers:{'content-type':'text/plain'}, status:201});
  const blob = await response.blob();
  check(blob instanceof Blob && require('buffer').Blob === Blob && blob.size === 5 && blob.type === 'text/plain', 'real Blob identity');
  const changed = new Uint8Array(await blob.arrayBuffer()); changed.fill(90);
  check(await blob.text() === 'hello' && await blob.slice(1,-1).text() === 'ell', 'Blob ownership/slice');
  check(await new Response(blob.stream()).text() === 'hello', 'Blob byte stream');
  let text = ''; for await (const part of new Blob(['a€b']).textStream()) text += part;
  check(text === 'a€b', 'Blob UTF-8 text stream');
  const byob = new Blob().stream().getReader({mode:'byob'});
  check((await byob.read(new Uint8Array(4))).done, 'empty BYOB completion');
  const immutable = new Response('hello', {status:201});
  Object.defineProperty(immutable, 'status', {value:500});
  check(immutable.clone().status === 201, 'clone trusted shadowed metadata');
  console.log('node-response-body-ok');
}
main().catch(error => {console.error(error);process.exitCode=1;});
`;
export const nodeResponseBodyCommand = `set -eu
cat > /tmp/node-response-body.cjs <<'JS'
${nodeResponseBodySource}
JS
node /tmp/node-response-body.cjs
`;
