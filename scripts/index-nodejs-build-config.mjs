#!/usr/bin/env node
// Bounded syntax inventory; unresolved dynamic/alias domains stay explicit.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parse} from '@babel/parser';
const manifest=JSON.parse(readFileSync('third_party/nodejs/sources.json','utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const property=n=>n.computed?n.property?.type==='StringLiteral'?n.property.value:null:n.property?.name;
const member=n=>['MemberExpression','OptionalMemberExpression'].includes(n?.type);
function chain(n){if(n?.type==='Identifier')return[n.name];if(!member(n))return null;const base=chain(n.object);return base?[...base,property(n)??'<computed>']:null}
function walk(n,visit,parent=null){if(!n?.type)return;visit(n,parent);for(const[k,v]of Object.entries(n)){if(['loc','start','end','extra','comments','tokens','errors'].includes(k))continue;if(Array.isArray(v))for(const x of v)walk(x,visit,n);else if(v?.type)walk(v,visit,n)}}
const files=[],reads=[],writes=[],dynamicProcessMembers=[],configMemberCandidates=[];
for(const row of manifest.files.filter(r=>r.builtinId)){
 const path='third_party/nodejs/upstream/'+row.path,b=readFileSync(path);if(b.length!==row.bytes||hash(b)!==row.sha256)throw Error('source mismatch '+path);
 const text=b.toString('utf8'),tree=parse(text,{sourceType:'unambiguous',allowReturnOutsideFunction:true,allowAwaitOutsideFunction:true}),bindings=new Set();
 walk(tree,n=>{if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'&&n.init?.type==='CallExpression'&&n.init.callee?.name==='internalBinding'&&n.init.arguments[0]?.value==='builtins')bindings.add(n.id.name)});
 const location=n=>({path:row.path,line:n.loc.start.line,start:n.start,end:n.end,source:text.slice(n.start,n.end)});
 walk(tree,(n,parent)=>{
  if(member(n)){
   if(member(parent)&&parent.object===n)return;
   const parts=chain(n);
   if(parts?.[0]==='process'&&parts[1]==='config')reads.push({...location(n),kind:'literal-process-config',pathParts:parts.slice(2)});
   else if(parts&&bindings.has(parts[0])&&parts[1]==='config')reads.push({...location(n),kind:'file-local-builtins-producer-candidate',pathParts:parts.slice(2),scopeResolutionComplete:false});
   else if(parts?.[0]==='process'&&parts.includes('<computed>'))dynamicProcessMembers.push({...location(n),pathParts:parts.slice(1)});
   if(parts?.includes('config'))configMemberCandidates.push({...location(n),pathParts:parts});
  }
  if(n.type==='CallExpression'&&n.callee?.name==='ObjectDefineProperty'&&n.arguments[0]?.name==='process'&&n.arguments[1]?.value==='config')writes.push(location(n));
 });files.push({path:row.path,bytes:b.length,sha256:hash(b),parsed:true});
}
const result={schema:1,scope:'Bounded build-config source syntax inventory; not a complete alias/dynamic dataflow or full native API catalog',sourceCommit:manifest.source.commit,files,reads,writes,dynamicProcessMembers,configMemberCandidates,counts:{parsedSources:files.length,readSites:reads.length,writeSites:writes.length,dynamicProcessMembers:dynamicProcessMembers.length,configMemberCandidates:configMemberCandidates.length},completeAliasAndDynamicCoverage:false};
writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result.counts));
