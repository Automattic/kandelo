const body = String.raw`
function outer() {
  function inner() {
    return getCallSites(3);
  }
  return inner();
}
const oldLimit = Error.stackTraceLimit;
const oldPrepare = Error.prepareStackTrace;
let sites;
try {
  Error.stackTraceLimit = 0;
  Error.prepareStackTrace = () => { throw Error('stack formatting hook was called'); };
  sites = outer();
} finally {
  Error.stackTraceLimit = oldLimit;
  Error.prepareStackTrace = oldPrepare;
}
assert.equal(sites.length, 3);
assert.equal(sites[0].functionName, 'inner');
assert.equal(sites[1].functionName, 'outer');
assert.equal(sites[0].lineNumber, 4);
assert.equal(sites[0].columnNumber, 12);
assert.equal(sites[1].lineNumber, 6);
assert.equal(sites[1].columnNumber, 10);
assert.equal(sites[0].scriptName, expectedScriptName);
assert.equal(sites[0].scriptId, sites[1].scriptId);
assert.match(sites[0].scriptId, /^[0-9]+$/);
for (const site of sites) {
  assert.equal(Object.getPrototypeOf(site), null);
  assert.deepEqual(Object.keys(site), ['functionName','scriptId','scriptName','lineNumber','columnNumber','column']);
  assert.equal(site.column, site.columnNumber);
  for (const d of Object.values(Object.getOwnPropertyDescriptors(site))) {
    assert.equal(d.enumerable && d.writable && d.configurable, true);
  }
}
sites[0].lineNumber = 999;
assert.equal(outer()[0].lineNumber, 4);
assert.equal(getCallSites(1).length, 1);
assert.ok(getCallSites(200).length > 0);
assert.ok(getCallSites({ sourceMap:false }).length > 0);
const originalAssign = Object.assign, originalCreate = Object.create;
const originalDefine = Object.defineProperty, originalPush = Array.prototype.push;
const originalInteger = Number.isInteger, originalArray = Array.isArray;
let protectedSites;
try {
  const poisoned = () => { throw Error('mutable public intrinsic was called'); };
  Object.assign = Object.create = Object.defineProperty = poisoned;
  Array.prototype.push = poisoned;
  Number.isInteger = Array.isArray = poisoned;
  protectedSites = outer();
} finally {
  Object.assign = originalAssign; Object.create = originalCreate;
  Object.defineProperty = originalDefine; Array.prototype.push = originalPush;
  Number.isInteger = originalInteger; Array.isArray = originalArray;
}
assert.equal(protectedSites[0].lineNumber, 4);
console.log('node-call-sites-' + entryKind + '-ok');
`;

export const nodeCallSiteFiles = {
  'frames.cjs': `const {getCallSites}=require('node:util'); const assert=require('node:assert/strict'); const expectedScriptName=__filename; const entryKind='cjs';` + body,
  'frames.mjs': `import {getCallSites} from 'node:util'; import assert from 'node:assert/strict'; const expectedScriptName=import.meta.url; const entryKind='esm';` + body,
};
export const nodeCallSiteEvalSource = `const {getCallSites}=require('node:util'); if(getCallSites(1)[0].scriptName!=='[eval]')throw Error('eval label'); console.log('node-call-sites-eval-ok');`;
export const nodeCallSiteCommand = 'set -eu\nmkdir -p /tmp/node-call-sites\n' +
  Object.entries(nodeCallSiteFiles).map(([name, source]) =>
    `cat > '/tmp/node-call-sites/${name}' <<'JS'\n${source}\nJS\n`).join('') +
  `node /tmp/node-call-sites/frames.cjs
node /tmp/node-call-sites/frames.mjs
node -e '${nodeCallSiteEvalSource.replace(/'/g, `'"'"'`)}'
`;
