'use strict';
const fs = require('node:fs');
const path = require('node:path');
const stream = require('node:stream');
const net = require('node:net');
const url = require('node:url');
const root = path.resolve(__dirname, '../../..');
const bundle = fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'packages/registry/node-compat/bootstrap.js'), 'utf8');
const factories = Function(bundle + ';return { incoming:_createNodeHttpIncoming, headers:_createNodeHttpHeaders, parser:_createNodeHttpParser, agent:_createNodeHttpAgent };')();
function nativeParserBoundary() {
  const reference = require('./node-http-parser-reference.cjs');
  const NativeBuffer = require('node:buffer').Buffer;
  return { httpParser(operation, owner, limit, insecure, relaxed) {
    if (operation === 'create') return reference.create(owner, limit, insecure, relaxed);
    const packet = operation === 'feed' ? owner.feed(NativeBuffer.from(limit)) : owner.finish();
    for (const event of packet.events) if (event.type === 1) event.body = NativeBuffer.from(event.body, 'hex');
    packet.remainder = NativeBuffer.from(packet.remainder, 'hex');
    if (packet.complete || packet.code || operation === 'finish') owner.close();
    return packet;
  } };
}
function create(connect = options => net.connect(options)) {
  // Explicit native boundaries: stream machinery, AbortController, task queue,
  // URL, real native Node HTTPParser and loopback transport. The candidate
  // IncomingMessage/header/parser frontend/client sources are exercised; the
  // portable backend is checked separately, and this is never guest proof.
  const { Buffer, values } = require('./node-buffer-pool.cjs').create();
  const incoming = factories.incoming({ stream, abort: { AbortController }, process });
  const outgoing = require('./node-http-outgoing-platform.cjs').create(Buffer, values);
  const headers = factories.headers({ Buffer, values, outgoing, insecureHTTPParser: false });
  const native = nativeParserBoundary();
  const { internalBinding } = require('internal/test/binding');
  // This component boundary supplies actual native Node socket/async owners.
  // It exercises the candidate Agent/client algorithms, not candidate JSAPI.
  const asyncOwner = { ...require('internal/async_hooks'), api: require('node:async_hooks') };
  const socketStream = { ...require('internal/stream_base_commons'), binding: internalBinding('stream_wrap') };
  const nativeNet = { ...net, createConnection: connect };
  const start = source.indexOf('const HTTP_METHODS =');
  const end = source.indexOf('const http = makeHttpModule(', start);
  if (start < 0 || end < 0) throw Error('Missing actual HTTP parser/client source boundary');
  const { makeHttpModule, makeResponseParser, agent } = Function('_nodeHttpHeaders', '_nodeHttpIncoming',
    'Buffer', 'stream', 'url', '_nodeValues', 'process', '_createNodeHttpParser', '_nodeNative', '_nodeHttpOutgoing', '_createNodeHttpAgent', '_nodeAsyncPlatform', '_nodeSocketStream', 'net', 'events', 'assert', 'tls',
    'const STATUS_CODES=_nodeHttpHeaders.STATUS_CODES;' + source.slice(start, end) +
    ';return {makeHttpModule,makeResponseParser,agent:_nodeHttpAgent};')(headers, incoming, Buffer, stream, url, values, process, factories.parser, native, outgoing, factories.agent, asyncOwner, socketStream, nativeNet, require('node:events'), require('node:assert'), require('node:tls'));
  const http = makeHttpModule({ defaultPort: 80, defaultProtocol: 'http:', connect, agentOwner: agent });
  const route = source.split('\n').find(line => line.trimStart().startsWith("'_http_incoming':"));
  if (!route) throw Error('Missing actual IncomingMessage builtin route');
  const builtinIncoming = Function('_nodeHttpIncoming', 'return ({' + route + '})["_http_incoming"];')(incoming);
  return { incoming, builtinIncoming, http, makeResponseParser, Buffer };
}
module.exports = { create, nativeParserBoundary };
