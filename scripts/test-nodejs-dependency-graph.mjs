#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildDependencyGraph} from './index-nodejs-dependency-graph.mjs';
const [reportPath]=process.argv.slice(2);if(!reportPath)throw Error('usage: test-nodejs-dependency-graph.mjs <report.json>');
const root=mkdtempSync(resolve('.scratch/node-dependency-controls.')),upstream=join(root,'upstream');mkdirSync(upstream);
const source=[
 "throw Error('SOURCE_MUST_NOT_EXECUTE');",
 "const { constants: {phase}, Tool:T } = internalBinding('work');",
 "if(process.platform==='win32') require('node:b'); else require('c');",
 "const object={get later(){return require('d')}};",
 "defineReplaceableLazyAttribute(object,'e',['E']);",
 "try { require('f'); } catch(error) { require('g'); } finally { require('h'); }",
 "const which='b'; require(which);",
 "require('missing-package');",
 "const metadata={deserializeInfo:'e:Thing'}; metadata.deserializeInfo='b:Other';",
 "new WebAssembly.Module(new Uint8Array()); import('./helper.mjs');",
 "require('generic'); require('reporters');",
 "class Fields { field=require('field'); static other=require('static'); }",
].join('\n');
const sources={
 'lib/a.js':source,'lib/b.js':"module.exports=require('c')",'lib/c.js':"require('b')",
 'lib/generic.js':"function dispatch(id){return requireBuiltin(id)}",
 'lib/reporters.js':"const reporters=new SafeMap([['x','b']]);\nif(feature)reporters.set('y','d');\nrequire(target);",
 'lib/helper.mjs':"export {x} from './relative.mjs'",'lib/relative.mjs':'export const x=1;',
 'lib/internal/modules/cjs/loader.js':'module.exports={}',
 'lib/internal/modules/esm/loader.js':'module.exports={}',
 ...Object.fromEntries(['d','e','f','g','h','field','static','isolated'].map(n=>['lib/'+n+'.js','module.exports={}'])),
};
const digest=b=>createHash('sha256').update(b).digest('hex');
function writeManifest(){
 const files=Object.entries(sources).map(([path,text])=>{const bytes=Buffer.from(text);mkdirSync(dirname(join(upstream,path)),{recursive:true});writeFileSync(join(upstream,path),bytes);return {path,builtinId:path.slice(4).replace(/\.(m?js)$/,''),bytes:bytes.length,sha256:digest(bytes)}});
 const manifest={schema:1,version:'fixture',source:{commit:'fixture'},files};writeFileSync(join(root,'sources.json'),JSON.stringify(manifest));return manifest;
}
writeManifest();
const reviews={sourceCommit:'fixture',records:[
 {path:'lib/generic.js',line:1,kind:'requireBuiltin',expression:'id',resolution:'symbolic',domain:'registry-dispatch'},
 {path:'lib/reporters.js',line:3,kind:'require',expression:'target',resolution:'collection-values',collection:'reporters'},
]};
const graph=()=>buildDependencyGraph(join(root,'sources.json'),reviews),observations=[];
let result=graph();const sites=result.sites,contexts=new Map(result.contexts.map(c=>[c.id,c]));
function check(name,callback){try{callback();observations.push({name,status:'pass'})}catch(error){observations.push({name,status:'fail',error:{name:error.name,message:error.message,stack:error.stack}})}}
const at=(target,kind='require')=>sites.find(s=>s.path==='lib/a.js'&&s.target===target&&s.kind===kind);
check('source-is-authenticated-and-never-executed',()=>{assert.equal(result.counts.parsedSources,17);assert.equal(result.runtimeEvidenceAdded,false)});
check('nested-native-destructuring-keeps-export-paths',()=>assert.deepEqual(at('work','internalBinding').requestedExportPaths,[['constants'],['constants','phase'],['Tool']]));
check('platform-branches-retain-both-targets-and-arms',()=>{
 assert.equal(at('node:b').resolution.builtinId,'b');assert.equal(at('c').resolution.builtinId,'c');
 assert.equal(contexts.get(at('node:b').contextIds.at(-1)).arm,'consequent');assert.equal(contexts.get(at('c').contextIds.at(-1)).arm,'alternate');
});
check('getter-and-class-initialization-contexts-are-preserved',()=>{
 assert(at('d').contextIds.some(id=>contexts.get(id).methodKind==='get'));
 assert(at('field').contextIds.some(id=>contexts.get(id).category==='class-initialization'&&contexts.get(id).static===false));
 assert(at('static').contextIds.some(id=>contexts.get(id).category==='class-initialization'&&contexts.get(id).static===true));
});
check('exceptional-and-finally-dependencies-remain-in-graph',()=>{
 for(const[target,region]of [['f','block'],['g','handler'],['h','finalizer']])assert(at(target).contextIds.some(id=>contexts.get(id).region===region));
});
check('lazy-registration-transfer-data-and-wasm-are-separate',()=>{
 assert.equal(at('e','defineReplaceableLazyAttribute').phase,'lazy-property-registration');assert.deepEqual(at('e','defineReplaceableLazyAttribute').lazyKeys,['E']);
 assert.equal(result.transferSites.length,2);assert.equal(result.counts.transferLiteralEdges,2);assert.equal(result.wasmSites[0].operation,'Module');
});
check('relative-esm-and-reexports-resolve-to-admitted-source',()=>{
 assert.equal(at('./helper.mjs','import').resolution.builtinId,'helper');assert.equal(sites.find(s=>s.path==='lib/helper.mjs').resolution.builtinId,'relative');
});
check('unknown-computed-and-missing-literal-remain-explicit',()=>{
 assert.equal(sites.find(s=>s.expression==='which').resolution.status,'unreviewed');assert.equal(at('missing-package').resolution.kind,'unregistered-literal');assert.equal(result.counts.unreviewedComputedReferences,1);
});
check('collection-mutations-add-conditional-reporter-targets',()=>{
 const r=sites.find(s=>s.path==='lib/reporters.js');assert.deepEqual(r.resolution.targets.map(t=>t.builtinId),['b','d']);assert.equal(r.resolution.collection.writes.length,1);assert(r.resolution.collection.writes[0].contextIds.length>0);
});
check('cyclic-closure-terminates-and-generic-dispatch-does-not-expand',()=>{
 const entry=result.entryCandidates.find(e=>e.builtinId==='a');assert(entry.sourceIds.includes('b')&&entry.sourceIds.includes('c'));assert(!entry.sourceIds.includes('isolated'));assert(entry.symbolicSiteIds.includes('lib/generic.js:29:requireBuiltin'));assert.deepEqual(entry.nativeBindings,['work']);
 assert(result.sourceCycles.some(group=>JSON.stringify(group)==='["b","c"]'));
});
check('commonjs-and-esm-loader-sources-are-tracked-separately',()=>{
 assert.equal(result.entryCandidates.find(e=>e.builtinId==='internal/modules/cjs/loader').role,'commonjs-loader-source');
 assert.equal(result.entryCandidates.find(e=>e.builtinId==='internal/modules/esm/loader').role,'esm-loader-source');
});
check('source-byte-corruption-is-rejected',()=>{
 writeFileSync(join(upstream,'lib/a.js'),source+'\n');try{assert.throws(graph,/source identity mismatch/)}finally{writeFileSync(join(upstream,'lib/a.js'),source)}
});
check('stale-and-unused-dynamic-reviews-are-rejected',()=>{
 const changed=structuredClone(reviews);changed.records[0].expression='other';assert.throws(()=>buildDependencyGraph(join(root,'sources.json'),changed),/expression mismatch/);
 changed.records[0].line=999;assert.throws(()=>buildDependencyGraph(join(root,'sources.json'),changed),/unused dynamic review/);
});
check('nonliteral-collection-write-invalidates-finite-review',()=>{
 const prior=sources['lib/reporters.js'];sources['lib/reporters.js']+="\nreporters.set('unknown',runtimeValue);";writeManifest();try{assert.throws(graph,/unreviewed dynamic collection/)}finally{sources['lib/reporters.js']=prior;writeManifest()}
});
check('parse-errors-remain-in-output-and-make-cli-fail',()=>{
 sources['lib/bad.js']='return )';writeManifest();writeFileSync(join(root,'reviews.json'),JSON.stringify(reviews));const output=join(root,'bad-graph.json');
 const child=spawnSync(process.execPath,['scripts/index-nodejs-dependency-graph.mjs',join(root,'sources.json'),join(root,'reviews.json'),output],{encoding:'utf8'});
 assert.equal(child.status,1);const d=JSON.parse(readFileSync(output));assert.equal(d.counts.parseErrors,1);assert.equal(d.files.find(f=>f.builtinId==='bad').status,'parse-error');delete sources['lib/bad.js'];writeManifest();
});
const failures=observations.filter(r=>r.status==='fail').length;writeFileSync(reportPath,JSON.stringify({scope:'Static dependency-indexer controls; no guest runtime/backend/conformance evidence',fixtureRoot:root,controls:observations.length,failures,observations},null,2)+'\n');console.log(JSON.stringify({controls:observations.length,failures}));if(failures)process.exitCode=1;
