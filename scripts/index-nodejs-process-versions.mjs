// Conservative syntax index, including aliases; no claim of full dataflow,
// scope resolution, runtime reachability or worker/exceptional-path coverage.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error('usage: index-nodejs-process-versions.mjs <sources.json> <output.json>');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const records = [], files = [];
const key = node => node?.type === 'Identifier' ? node.name : node?.type === 'StringLiteral' ? node.value : null;
const property = node => node?.computed ? node.property.type === 'StringLiteral' ? node.property.value : null : key(node?.property);
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [name, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(name)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
for (const file of manifest.files.filter(row => row.builtinId)) {
  const bytes = readFileSync(resolve(dirname(manifestPath), 'upstream', file.path));
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('source identity mismatch: ' + file.path);
  let tree;
  try { tree = parse(bytes.toString('utf8'), { sourceType: 'unambiguous', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); }
  catch (error) { files.push({ path: file.path, status: 'parse-error', message: error.message, line: error.loc?.line }); continue; }
  const processNames = new Set(['process']), versionNames = new Set();
  const isProcess = node => node?.type === 'Identifier' && processNames.has(node.name);
  const isVersions = node => node?.type === 'Identifier' && versionNames.has(node.name) || node?.type === 'MemberExpression' && isProcess(node.object) && property(node) === 'versions';
  const nodes = []; walk(tree, node => nodes.push(node));
  let changed;
  do {
    const before = processNames.size + versionNames.size;
    for (const node of nodes) {
      if (node.type === 'ImportDeclaration' && ['process', 'node:process'].includes(node.source.value)) {
        for (const s of node.specifiers) {
          if (s.type === 'ImportDefaultSpecifier' || s.type === 'ImportNamespaceSpecifier') processNames.add(s.local.name);
          if (s.type === 'ImportSpecifier' && key(s.imported) === 'versions') versionNames.add(s.local.name);
        }
      }
      if (node.type !== 'VariableDeclarator') continue;
      const init = node.init;
      const imported = init?.type === 'CallExpression' && ['require', 'requireBuiltin'].includes(init.callee?.name) && ['process', 'node:process'].includes(init.arguments[0]?.value);
      if (node.id.type === 'Identifier') {
        if (imported || isProcess(init)) processNames.add(node.id.name);
        if (isVersions(init)) versionNames.add(node.id.name);
      }
      if (node.id.type === 'ObjectPattern' && (imported || isProcess(init))) for (const p of node.id.properties) {
        if (p.type === 'ObjectProperty' && key(p.key) === 'versions' && p.value.type === 'Identifier') versionNames.add(p.value.name);
      }
    }
    changed = before !== processNames.size + versionNames.size;
  } while (changed);
  const add = (node, kind, field) => records.push({ path: file.path, builtinId: file.builtinId, line: node.loc.start.line, column: node.loc.start.column, kind, field, text: bytes.toString('utf8').slice(node.start, node.end) });
  for (const node of nodes) {
    if (node.type === 'MemberExpression' && isVersions(node.object)) add(node, 'version-field-access', property(node));
    else if (node.type === 'MemberExpression' && isProcess(node.object) && property(node) === 'versions') add(node, 'versions-object-access', null);
    else if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && isVersions(node.init)) {
      for (const p of node.id.properties) add(p, p.type === 'RestElement' ? 'rest-destructure' : 'field-destructure', p.type === 'RestElement' ? null : key(p.key));
    }
  }
  files.push({ path: file.path, sha256: file.sha256, status: 'parsed', processNames: [...processNames], versionNames: [...versionNames] });
}
writeFileSync(outputPath, JSON.stringify({ schema: 1, scope: 'Conservative original-source syntax/alias index; not full contract or reachability closure', builtinSources: files.length, parsed: files.filter(row => row.status === 'parsed').length, parseErrors: files.filter(row => row.status === 'parse-error'), files, records, completeGraphReconciled: false, limits: ['File-wide aliases can overapproximate shadowed bindings', 'Assignments, parameter propagation, object escapes and computed aliases need manual reconciliation', 'Literal strings used by remote debugger evaluation remain in the separate text index', 'No runtime, worker, lazy, conditional or exceptional reachability proof'] }, null, 2) + '\n');
console.log(JSON.stringify({ builtinSources: files.length, parsed: files.filter(row => row.status === 'parsed').length, references: records.length, computedFields: records.filter(row => row.kind === 'version-field-access' && row.field === null).length }));
