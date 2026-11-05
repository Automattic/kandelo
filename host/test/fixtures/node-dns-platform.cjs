'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const util = require('node:util');
const dns = require('node:dns');
const { createNativeAdapter } = require('./node-native-adapter.cjs');
const asyncHooks = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '../../..');
const factories = Function(fs.readFileSync(path.join(root, 'third_party/node-core/node-core.js'), 'utf8') +
  ';return { values: _createNodeValuesPlatform, uv: _createNodeUvPlatform, ip: _createNodeNetworkIP, dns: _createNodeDnsLookupPlatform, perf: _createNodePerformanceObserverPlatform };')();
const webFactory = Function(fs.readFileSync(path.join(root, 'third_party/node-web-platform/node-web-platform.js'), 'utf8') +
  ';return _createNodeWebPlatform;')();

// Exact native Node engine/OS/request ownership is the explicit boundary.
// These actual native requests do not validate the guest SpiderMonkey bridge.
function createDnsPlatform() {
  const cares = process.binding('cares_wrap'); // Allowed by the pinned realm.js.
  const addrProto = cares.GetAddrInfoReqWrap.prototype;
  const nameProto = cares.GetNameInfoReqWrap.prototype;
  const channelProto = cares.ChannelWrap.prototype;
  const nativeAsync = Object.getPrototypeOf(addrProto);
  const triggerIds = new Map();
  const hooks = asyncHooks.createHook({
    init(id, type, trigger) {
      if (['GETADDRINFOREQWRAP', 'GETNAMEINFOREQWRAP', 'QUERYWRAP', 'DNSCHANNEL'].includes(type)) triggerIds.set(id, trigger);
    },
    destroy(id) { triggerIds.delete(id); },
  }).enable();
  const providers = asyncHooks.asyncWrapProviders;
  const providerNames = new Map(Object.entries(providers).map(([name, id]) => [id, name]));
  const native = {
    performanceNow: performance.now.bind(performance),
    performanceTimeOrigin: () => performance.timeOrigin,
    createDnsRequest(prototype, name) {
      const req = name === undefined ? new cares.QueryReqWrap() :
        name ? new cares.GetNameInfoReqWrap() : new cares.GetAddrInfoReqWrap();
      return Object.setPrototypeOf(req, prototype);
    },
    createDnsChannel(prototype, timeout, tries, maxTimeout) {
      return Object.setPrototypeOf(new cares.ChannelWrap(timeout, tries, maxTimeout), prototype);
    },
    dnsQuery(channel, req, name, type) {
      const names = { 255: 'queryAny', 1: 'queryA', 28: 'queryAaaa', 257: 'queryCaa',
        5: 'queryCname', 15: 'queryMx', 2: 'queryNs', 52: 'queryTlsa', 16: 'queryTxt',
        33: 'querySrv', 12: 'queryPtr', 35: 'queryNaptr', 6: 'querySoa', 0: 'getHostByAddr' };
      return Reflect.apply(channelProto[names[type]], channel, [req, name]);
    },
    dnsGetServers: channel => Reflect.apply(channelProto.getServers, channel, []),
    dnsSetServers: (channel, servers) => Reflect.apply(channelProto.setServers, channel, [servers]),
    dnsCancel: channel => Reflect.apply(channelProto.cancel, channel, []),
    dnsStrError: code => cares.strerror(code),
    dnsVersion: () => process.versions.ares,
    getAsyncResourceInfo(req) {
      const id = Reflect.apply(nativeAsync.getAsyncId, req, []);
      const type = Reflect.apply(nativeAsync.getProviderType, req, []);
      return [id, triggerIds.get(id) ?? -1,
        Reflect.apply(nativeAsync.getAsyncContextFrameForDebuggingOnly, req, []),
        type ? providerNames.get(type) : undefined];
    },
    dnsLookupConstants: () => ({ AI_ADDRCONFIG: dns.ADDRCONFIG, AI_ALL: dns.ALL, AI_V4MAPPED: dns.V4MAPPED }),
    dnsLookup: (...args) => cares.getaddrinfo(...args),
    dnsLookupService: (...args) => cares.getnameinfo(...args),
  };
  const uv = factories.uv({ native: { getUvErrorData: () => [...util.getSystemErrorMap()]
    .map(([number, [name, message]]) => [number, name, message]) } });
  const boundary = { platform: 'kandelo', nextTick: process.nextTick.bind(process), emitWarning: process.emitWarning.bind(process) };
  const values = factories.values({ process: boundary, uv, Buffer, util, inspection: util, os,
    signals: os.constants.signals, getDOMException: () => DOMException });
  const web = webFactory();
  const event = require('./node-performance-platform.cjs').event;
  const perf = factories.perf({ native, values, process: boundary, util, setImmediate, event, structuredClone });
  const adapter = createNativeAdapter(native);
  assertAdapterVersion(adapter);
  const subject = factories.dns({ native: adapter, values, Buffer, process: boundary,
    ip: factories.ip(), hostnameToASCII: web.hostnameToASCII,
    observation: perf.observation, asyncProviders: providers });
  return { ...subject, perf, values, native, web, factories, event, asyncProviders: providers,
    close() { hooks.disable(); triggerIds.clear(); } };
}
function assertAdapterVersion(adapter) { require('node:assert/strict').equal(adapter.dnsVersion(), process.versions.ares); }
module.exports = { createDnsPlatform };
