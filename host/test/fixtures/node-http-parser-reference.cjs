'use strict';
// Explicit native parser dependency for differential/frontend controls. This
// executes Node's real HTTPParser, never a JS model of llhttp or guest proof.
const { internalBinding } = require('internal/test/binding');
const { HTTPParser } = internalBinding('http_parser');
const { AsyncResource } = require('node:async_hooks');
function create(method = 'GET', limit = 0, insecure = false, relaxed = false) {
  const parser = new HTTPParser();
  const resource = new AsyncResource('HTTPCLIENTREQUEST');
  parser.initialize(HTTPParser.RESPONSE, resource, limit, insecure ? HTTPParser.kLenientAll : relaxed ? HTTPParser.kLenientHeaderValueRelaxed : 0);
  let step, headers = [], informational = false, complete = false, upgrade = false;
  let error;
  parser[HTTPParser.kOnHeaders] = function(items) { headers.push(...items); };
  parser[HTTPParser.kOnHeadersComplete] = function(major, minor, items, _method, _url, status, statusMessage, isUpgrade, keepAlive) {
    if (items) headers.push(...items);
    informational = status >= 100 && status < 200 && status !== 101;
    upgrade = !!isUpgrade || method === 'CONNECT';
    step.events.push({ type: 0, headers, status, major, minor, keepAlive: !!keepAlive,
      upgrade, informational, statusMessage });
    headers = [];
    if (upgrade) return 2;
    return informational || method === 'HEAD' ? 1 : 0;
  };
  parser[HTTPParser.kOnBody] = function(bytes) { step.events.push({ type: 1, body: bytes.toString('hex') }); };
  parser[HTTPParser.kOnMessageComplete] = function() {
    step.events.push({ type: 2, headers, informational, upgrade }); headers = [];
    if (!informational) complete = true;
  };
  function run(bytes) {
    step = { consumed: 0, events: [], code: '', reason: '', complete, upgrade, remainder: '' };
    if (error) { Object.assign(step, error); return step; }
    if (complete) { if (bytes) step.remainder = bytes.toString('hex'); return step; }
    function accept(result) {
      if (typeof result === 'number') step.consumed += result;
      else if (result) {
        step.consumed += result.bytesParsed || 0;
        error = { code: result.code, reason: result.reason }; Object.assign(step, error);
      }
    }
    // Native HTTPParser's JS message-complete callback cannot return llhttp's
    // HPE_PAUSED. Supply real bytes incrementally so this client dependency
    // stops at the first final-message boundary instead of parsing bytes that
    // the guest owner deliberately leaves to socket retirement/upgrade.
    if (bytes) {
      if (!bytes.length) accept(parser.execute(bytes));
      for (let at = 0; at < bytes.length && !complete && !error; ++at)
        accept(parser.execute(bytes.subarray(at, at + 1)));
    } else accept(parser.finish());
    step.complete = complete; step.upgrade = upgrade;
    if (bytes && complete && step.consumed < bytes.length)
      step.remainder = bytes.subarray(step.consumed).toString('hex');
    return step;
  }
  return { feed: run, finish: () => run(), close() { parser.close(); resource.emitDestroy(); } };
}
module.exports = { create };
