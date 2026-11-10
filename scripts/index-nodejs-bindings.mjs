#!/usr/bin/env node
// Index unchanged source syntax. This is not a binding-contract audit or a
// runtime probe: parse failures and computed references stay visible.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error('usage: index-nodejs-bindings.mjs <sources.json> <output.json>');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const upstream = resolve(dirname(manifestPath), 'upstream');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const calls = [], files = [], bindingMap = new Map();
const literal = (node) => node?.type === 'StringLiteral' ? node.value :
  node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null;
function kindOf(node) {
  const callee = node.callee;
  if (callee?.type === 'Identifier' && ['require', 'requireBuiltin', 'internalBinding', 'getInternalBinding', 'getLinkedBinding'].includes(callee.name)) return callee.name;
  if (callee?.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'process') {
    const key = callee.computed ? literal(callee.property) : callee.property.name;
    if (['binding', '_linkedBinding'].includes(key)) return 'process.' + key;
  }
  if (callee?.type === 'Import') return 'import';
  return null;
}
for (const file of manifest.files.filter((f) => f.builtinId)) {
  const bytes = readFileSync(resolve(upstream, file.path));
  if (sha256(bytes) !== file.sha256) throw new Error('source identity mismatch: ' + file.path);
  const text = bytes.toString('utf8');
  let tree;
  try {
    tree = parse(text, { sourceType: 'unambiguous', allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true, sourceFilename: file.path });
  } catch (error) {
    files.push({path: file.path, sha256: file.sha256, status: 'parse-error', message: error.message, line: error.loc?.line ?? null});
    continue;
  }
  const first = calls.length;
  const pending = [{node: tree, parent: null}];
  while (pending.length) {
    const {node, parent} = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (['CallExpression', 'OptionalCallExpression'].includes(node.type)) {
      const kind = kindOf(node);
      if (kind) {
        const target = literal(node.arguments[0]);
        const native = ['internalBinding', 'getInternalBinding', 'getLinkedBinding', 'process.binding', 'process._linkedBinding'].includes(kind);
        const requestedExports = [];
        if (parent?.type === 'VariableDeclarator' && parent.id.type === 'ObjectPattern') {
          for (const prop of parent.id.properties) {
            if (prop.type !== 'ObjectProperty') requestedExports.push('<rest>');
            else requestedExports.push(prop.computed ? literal(prop.key) ?? '<computed>' : prop.key.name ?? prop.key.value);
          }
        } else if (parent?.type === 'MemberExpression' && parent.object === node) {
          requestedExports.push(parent.computed ? literal(parent.property) ?? '<computed>' : parent.property.name);
        }
        const call = {path: file.path, builtinId: file.builtinId, line: node.loc.start.line,
          kind, target, computed: target === null, requestedExports, native,
          contractStatus: 'unreviewed', evidence: 'static syntax only'};
        calls.push(call);
        if (native && target !== null) {
          if (!bindingMap.has(target)) bindingMap.set(target, []);
          bindingMap.get(target).push({path: call.path, line: call.line, kind, requestedExports});
        }
      }
    }
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' && node.source || node.type === 'ExportAllDeclaration') {
      calls.push({path: file.path, builtinId: file.builtinId, line: node.loc.start.line,
        kind: 'esm-import-or-reexport', target: literal(node.source), computed: false,
        requestedExports: [], native: false, contractStatus: 'unreviewed', evidence: 'static syntax only'});
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'tokens', 'errors'].includes(key)) continue;
      if (Array.isArray(value)) for (let i = value.length - 1; i >= 0; i--) {
        if (value[i]?.type) pending.push({node: value[i], parent: node});
      }
      else if (value?.type) pending.push({node: value, parent: node});
    }
  }
  files.push({path: file.path, sha256: file.sha256, status: 'syntax-indexed', indexedReferences: calls.length - first});
}
calls.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
const bindings = [...bindingMap].sort(([a], [b]) => a.localeCompare(b)).map(([name, consumers]) => ({
  name, consumers, implementation: 'not evaluated', contractAudit: 'not completed',
  hosts: {Node: 'unvalidated', Chromium: 'unvalidated', Firefox: 'unvalidated', WebKit: 'unvalidated'},
}));
const result = {
  schema: 1, target: {version: manifest.version, commit: manifest.source.commit},
  sourceManifestSha256: sha256(readFileSync(manifestPath)),
  method: 'Babel syntax traversal of every registered source; literal and computed loader/binding calls retained',
  limitations: ['No execution or transitive reachability proof', 'Aliases and implicit native/engine contracts need manual review',
    'Destructuring records only directly requested export keys; nested types/signatures/lifecycles remain unaudited',
    'Parse failures and computed references remain outstanding; zero syntax errors is not compatibility'],
  runtimeTestsRun: false, contractCatalogComplete: false,
  counts: {sourceFiles: files.length, parsed: files.filter((f) => f.status === 'syntax-indexed').length,
    parseErrors: files.filter((f) => f.status === 'parse-error').length, references: calls.length,
    computedReferences: calls.filter((c) => c.computed).length, distinctLiteralBindings: bindings.length},
  files, bindings, references: calls,
};
writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.counts));
