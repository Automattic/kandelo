#!/usr/bin/env node
// Source analysis only: never execute upstream modules or infer conformance.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve,posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parse} from '@babel/parser';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const literal=n=>n?.type==='StringLiteral'?n.value:n?.type==='TemplateLiteral'&&n.expressions.length===0?n.quasis[0].value.cooked:null;
const property=n=>n?.computed?literal(n.property):n?.property?.name;
const functions=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ObjectMethod','ClassMethod','ClassPrivateMethod']);
const nativeKinds=new Set(['internalBinding','getInternalBinding','getLinkedBinding','process.binding','process._linkedBinding']);
const lazyKinds=new Set(['defineLazyProperties','exposeLazyInterfaces','defineReplaceableLazyAttribute']);
function loaderKind(n){
 const c=n.callee;
 if(c?.type==='Identifier'&&['require','requireBuiltin',...nativeKinds].includes(c.name))return c.name;
 if(c?.type==='MemberExpression'&&c.object.type==='Identifier'&&c.object.name==='process'&&['binding','_linkedBinding'].includes(property(c)))return 'process.'+property(c);
 if(c?.type==='Import')return 'import';
 return null;
}
function children(n){
 const out=[];
 for(const[k,v]of Object.entries(n)){
  if(['loc','start','end','extra','comments','tokens','errors'].includes(k))continue;
  if(Array.isArray(v)){for(const c of v)if(c?.type)out.push([c,k]);}
  else if(v?.type)out.push([v,k]);
 }
 return out;
}
function walk(n,callback,ancestors=[]){
 callback(n,ancestors);
 for(const[c,k]of children(n))walk(c,callback,[...ancestors,{node:n,key:k}]);
}
function requested(n,parent){
 const paths=[];
 function pattern(p,prefix=[]){
  if(p?.type!=='ObjectPattern')return;
  for(const x of p.properties){
   if(x.type==='RestElement'){paths.push([...prefix,'<rest>']);continue;}
   const key=x.computed?literal(x.key)??'<computed>':x.key.name??x.key.value;
   const path=[...prefix,key];paths.push(path);pattern(x.value,path);
  }
 }
 if(parent?.type==='VariableDeclarator'&&parent.init===n)pattern(parent.id);
 else if(['MemberExpression','OptionalMemberExpression'].includes(parent?.type)&&parent.object===n)paths.push([property(parent)??'<computed>']);
 return paths;
}
function wasmPath(n){
 if(n?.type==='Identifier')return n.name==='WebAssembly'?['WebAssembly']:null;
 if(!['MemberExpression','OptionalMemberExpression'].includes(n?.type))return null;
 const base=wasmPath(n.object),key=property(n);return base&&key?[...base,key]:null;
}
const reviewKey=(path,line,kind)=>`${path}:${line}:${kind}`;

export function buildDependencyGraph(manifestPath,reviewDocument={records:[]}){
 const manifestBytes=readFileSync(manifestPath),manifest=JSON.parse(manifestBytes);
 const upstream=resolve(dirname(manifestPath),'upstream'),records=manifest.files.filter(r=>r.builtinId);
 const byId=new Map(),byPath=new Map();
 for(const r of records){
  if(byId.has(r.builtinId)||byPath.has(r.path))throw Error('duplicate source identity: '+r.path);
  byId.set(r.builtinId,r);byPath.set(r.path,r);
 }
 const reviews=new Map((reviewDocument.records??[]).map(r=>[reviewKey(r.path,r.line,r.kind),r]));
 if(reviews.size!==(reviewDocument.records??[]).length)throw Error('duplicate dynamic review');
 if(reviewDocument.sourceCommit&&reviewDocument.sourceCommit!==manifest.source.commit)throw Error('dynamic review source commit mismatch');
 const files=[],sites=[],contexts=new Map(),wasmSites=[],transferSites=[],collections=new Map(),usedReviews=new Set();
 const location=(path,n)=>({path,start:n.start,end:n.end,line:n.loc.start.line,column:n.loc.start.column});
 for(const record of records){
  const bytes=readFileSync(resolve(upstream,record.path));
  if(bytes.length!==record.bytes||hash(bytes)!==record.sha256)throw Error('source identity mismatch: '+record.path);
  const text=bytes.toString('utf8');let tree;
  try{tree=parse(text,{sourceType:'unambiguous',allowReturnOutsideFunction:true,allowAwaitOutsideFunction:true,sourceFilename:record.path});}
  catch(error){files.push({...record,status:'parse-error',error:{message:error.message,line:error.loc?.line??null}});continue;}
  const first=sites.length;
  function contextIds(ancestors){
   const ids=[];
   for(const{node:n,key}of ancestors){
    let detail;
    if(functions.has(n.type))detail={category:'function',name:n.id?.name??n.key?.name??literal(n.key)??null,async:!!n.async,generator:!!n.generator,methodKind:n.kind??null};
    else if(n.type==='IfStatement'||n.type==='ConditionalExpression')detail={category:'branch',arm:key,condition:text.slice(n.test.start,n.test.end)};
    else if(n.type==='LogicalExpression')detail={category:'short-circuit',operator:n.operator,arm:key,left:text.slice(n.left.start,n.left.end)};
    else if(n.type==='TryStatement')detail={category:'exception-region',region:key};
    else if(n.type==='SwitchStatement')detail={category:'switch',region:key,discriminant:text.slice(n.discriminant.start,n.discriminant.end)};
    else if(n.type==='SwitchCase')detail={category:'switch-case',test:n.test?text.slice(n.test.start,n.test.end):null};
    else if(['ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoWhileStatement'].includes(n.type))detail={category:'loop',region:key,test:n.test?text.slice(n.test.start,n.test.end):null};
    else if(['ClassProperty','ClassPrivateProperty','StaticBlock'].includes(n.type))detail={category:'class-initialization',static:n.type==='StaticBlock'||!!n.static,region:key};
    if(detail){const id=`${record.path}:${n.start}:${n.type}:${detail.arm??detail.region??''}`;if(!contexts.has(id))contexts.set(id,{id,...location(record.path,n),syntax:n.type,...detail});ids.push(id);}
   }
   return ids;
  }
  function add(n,ancestors,kind,argument,{native=false,phase='loader-call',target=literal(argument)}={}){
   const parent=ancestors.at(-1)?.node;
   const site={id:`${record.path}:${n.start}:${kind}`,...location(record.path,n),builtinId:record.builtinId,kind,native,target,computed:target===null,phase,requestedExportPaths:requested(n,parent),contextIds:contextIds(ancestors)};
   if(target===null){
    site.expression=argument?text.slice(argument.start,argument.end):null;
    const key=reviewKey(record.path,site.line,kind),review=reviews.get(key);
    if(review){if(review.expression!==site.expression)throw Error('dynamic review expression mismatch: '+key);site.dynamicReview=review;usedReviews.add(key);}
   }
   sites.push(site);return site;
  }
  walk(tree,(n,ancestors)=>{
   if(['CallExpression','OptionalCallExpression'].includes(n.type)){
    const kind=loaderKind(n);
    if(kind)add(n,ancestors,kind,n.arguments[0],{native:nativeKinds.has(kind)});
    else if(n.callee?.type==='Identifier'&&lazyKinds.has(n.callee.name)){
     const site=add(n,ancestors,n.callee.name,n.arguments[1],{phase:'lazy-property-registration'});
     site.lazyKeys=n.arguments[2]?.type==='ArrayExpression'?n.arguments[2].elements.map(x=>literal(x)??'<computed>'):null;
     site.helperIdentity='callee-name syntax; helper/alias identity needs contract review';
    }
   }
   if(n.type==='ImportDeclaration'||n.type==='ExportNamedDeclaration'&&n.source||n.type==='ExportAllDeclaration')add(n,ancestors,'esm-import-or-reexport',n.source);
   if(['CallExpression','NewExpression','OptionalCallExpression'].includes(n.type)){
    const callee=wasmPath(n.callee);
    if(callee)wasmSites.push({...location(record.path,n),builtinId:record.builtinId,operation:callee.slice(1).join('.'),syntax:n.type,contextIds:contextIds(ancestors)});
   }
   let value;
   if(n.type==='ObjectProperty'&&(n.computed?literal(n.key):n.key.name??n.key.value)==='deserializeInfo')value=n.value;
   if(n.type==='AssignmentExpression'&&property(n.left)==='deserializeInfo')value=n.right;
   if(value){
    const payload=literal(value),index=payload?.indexOf(':')??-1;
    const row={...location(record.path,n),builtinId:record.builtinId,payload,target:index>0?payload.slice(0,index):null,constructor:index>0?payload.slice(index+1):null,contextIds:contextIds(ancestors)};transferSites.push(row);
    if(row.target)add(n,ancestors,'transfer-deserialization-target',value,{phase:'receiver-deserialization',target:row.target});
   }
   if(n.type==='VariableDeclarator'&&n.id.type==='Identifier'&&n.init?.type==='NewExpression'&&['SafeSet','SafeMap'].includes(n.init.callee.name)){
    let array=n.init.arguments[0];
    if(array?.type==='NewExpression'&&array.callee.name==='SafeArrayIterator')array=array.arguments[0];
    if(array?.type==='ArrayExpression'){
     const values=n.init.callee.name==='SafeSet'?array.elements.map(literal):array.elements.map(x=>x?.type==='ArrayExpression'?literal(x.elements[1]):null);
     collections.set(`${record.path}:${n.id.name}`,{...location(record.path,n),name:n.id.name,type:n.init.callee.name,values,writes:[],nonliteral:values.some(x=>x===null)});
    }
   }
  });
  // Collect literal .set/.add mutations separately, including later conditional writes.
  walk(tree,(n,ancestors)=>{
   if(n.type!=='CallExpression'||n.callee.type!=='MemberExpression'||n.callee.object.type!=='Identifier')return;
   const c=collections.get(`${record.path}:${n.callee.object.name}`),method=property(n.callee);if(!c||!['set','add'].includes(method))return;
   const value=literal(n.arguments[c.type==='SafeMap'?1:0]);c.writes.push({...location(record.path,n),value,contextIds:contextIds(ancestors)});if(value===null)c.nonliteral=true;else c.values.push(value);
  });
  files.push({...record,status:'syntax-indexed',references:sites.length-first});
 }
 for(const key of reviews.keys())if(!usedReviews.has(key))throw Error('unused dynamic review: '+key);
 function resolveTarget(target,native=false,from=null){
  if(native)return {kind:'native-binding',name:target};
  const id=target.startsWith('node:')?target.slice(5):target;
  if(byId.has(id))return {kind:'registered-source',builtinId:id};
  if(target.startsWith('.')&&from){
   const base=posix.normalize(posix.join(posix.dirname(from),target));
   const paths=[base,base+'.js',base+'.mjs',base+'/index.js'].filter(p=>byPath.has(p));
   if(paths.length===1)return {kind:'registered-source',builtinId:byPath.get(paths[0]).builtinId,relativePath:paths[0]};
   if(paths.length>1)return {kind:'ambiguous-source',candidates:paths};
  }
  return {kind:'unregistered-literal',target};
 }
 for(const s of sites){
  if(!s.computed)s.resolution=resolveTarget(s.target,s.native,s.path);
  else if(s.dynamicReview?.resolution==='finite-targets')s.resolution={kind:'reviewed-finite-targets',targets:s.dynamicReview.targets.map(t=>resolveTarget(t,s.native,s.path))};
  else if(s.dynamicReview?.resolution==='collection-values'){
   const c=collections.get(`${s.path}:${s.dynamicReview.collection}`);if(!c||c.nonliteral)throw Error('unreviewed dynamic collection: '+s.id);
   s.resolution={kind:'reviewed-finite-targets',collection:c,targets:[...new Set(c.values)].sort().map(t=>resolveTarget(t,s.native,s.path))};
  }else s.resolution={kind:'symbolic-dispatch',domain:s.dynamicReview?.domain??'unreviewed',status:s.dynamicReview?'source-reviewed-open-or-parameterized':'unreviewed'};
 }
 const concrete=s=>s.resolution.kind==='reviewed-finite-targets'?s.resolution.targets:[s.resolution];
 const adjacency=new Map(records.map(r=>[r.builtinId,new Set()]));
 const bindingConsumers=new Map();
 for(const s of sites)for(const r of concrete(s)){
  if(r.kind==='registered-source')adjacency.get(s.builtinId).add(r.builtinId);
  if(r.kind==='native-binding'){
   if(!bindingConsumers.has(r.name))bindingConsumers.set(r.name,[]);bindingConsumers.get(r.name).push(s.id);
  }
 }
 const moduleEdges=[...adjacency].flatMap(([from,to])=>[...to].sort().map(target=>({from,to:target})));
 // Generic loader dispatch stays symbolic: expanding it to all 443 sources
 // would make every ordinary transitive closure look like the whole runtime.
 function closure(start){
  const reached=new Set(),pending=[start];while(pending.length){const id=pending.pop();if(reached.has(id))continue;reached.add(id);pending.push(...adjacency.get(id));}
  const sourceSites=sites.filter(s=>reached.has(s.builtinId));
  const nativeBindings=[...new Set(sourceSites.flatMap(s=>concrete(s).filter(r=>r.kind==='native-binding').map(r=>r.name)))].sort();
  return {builtinId:start,sourceIds:[...reached].sort(),nativeBindings,symbolicSiteIds:sourceSites.filter(s=>s.resolution.kind==='symbolic-dispatch').map(s=>s.id),unregisteredSiteIds:sourceSites.filter(s=>concrete(s).some(r=>r.kind==='unregistered-literal'||r.kind==='ambiguous-source')).map(s=>s.id)};
 }
 function entryRole(id){
  if(id==='internal/modules/cjs/loader')return 'commonjs-loader-source';
  if(id==='internal/modules/esm/loader')return 'esm-loader-source';
  if(!id.startsWith('internal/'))return 'public-source-candidate';
  if(id.startsWith('internal/main/'))return 'main-source-candidate';
  if(id.startsWith('internal/bootstrap/'))return 'bootstrap-source';
  if(id.startsWith('internal/per_context/'))return 'per-context-source';
  return null;
 }
 const entryCandidates=records.filter(r=>entryRole(r.builtinId)).map(r=>({role:entryRole(r.builtinId),...closure(r.builtinId)}));
 // Source cycles must remain visible; they do not establish an order for
 // implementing the native backends or imply that any entrypoint executes.
 const numbers=new Map(),low=new Map(),stack=[],onStack=new Set(),sourceCycles=[];let sequence=0;
 function connect(id){
  numbers.set(id,sequence);low.set(id,sequence++);stack.push(id);onStack.add(id);
  for(const target of adjacency.get(id)){
   if(!numbers.has(target)){connect(target);low.set(id,Math.min(low.get(id),low.get(target)));}
   else if(onStack.has(target))low.set(id,Math.min(low.get(id),numbers.get(target)));
  }
  if(low.get(id)===numbers.get(id)){
   const group=[];let member;do{member=stack.pop();onStack.delete(member);group.push(member)}while(member!==id);
   if(group.length>1||adjacency.get(id).has(id))sourceCycles.push(group.sort());
  }
 }
 for(const id of adjacency.keys())if(!numbers.has(id))connect(id);
 sourceCycles.sort((a,b)=>a[0].localeCompare(b[0]));
 sites.sort((a,b)=>a.path.localeCompare(b.path)||a.start-b.start||a.kind.localeCompare(b.kind));
 const primary=sites.filter(s=>s.phase==='loader-call');
 const counts={registeredSources:records.length,parsedSources:files.filter(f=>f.status==='syntax-indexed').length,parseErrors:files.filter(f=>f.status==='parse-error').length,primaryReferences:primary.length,primaryComputedReferences:primary.filter(s=>s.computed).length,lazyRegistrations:sites.filter(s=>s.phase==='lazy-property-registration').length,transferMetadataSites:transferSites.length,transferLiteralEdges:sites.filter(s=>s.phase==='receiver-deserialization').length,allReferences:sites.length,literalNativeBindings:bindingConsumers.size,contexts:contexts.size,wasmOperations:wasmSites.length,distinctModuleEdges:moduleEdges.length,unreviewedComputedReferences:sites.filter(s=>s.computed&&!s.dynamicReview).length,unregisteredLiteralReferences:sites.filter(s=>concrete(s).some(r=>r.kind==='unregistered-literal')).length};
 const bindings=[...bindingConsumers].sort(([a],[b])=>a.localeCompare(b)).map(([name,siteIds])=>{
  const paths=sites.filter(s=>siteIds.includes(s.id)).flatMap(s=>s.requestedExportPaths.map(p=>JSON.stringify(p)));
  return {name,siteIds,contractStatus:'incomplete',directRequestedExportPaths:[...new Set(paths)].sort().map(p=>JSON.parse(p))};
 });
 return {
  schema:1,target:{version:manifest.version,sourceCommit:manifest.source.commit},
  sourceManifestSha256:hash(manifestBytes),
  method:'Authenticated Babel source graph with syntactic execution contexts, reviewed computed dispatch, lazy registrations and transfer metadata; never executes upstream code',
  counts,completeNativeContractCatalog:false,runtimeEvidenceAdded:false,
  limitations:[
   'Name-based syntax recognition does not prove callee identity, alias analysis or complete dynamic loading coverage',
   'Function context is syntax, not proof of lazy scheduling; immediately invoked functions remain possible',
   'Concrete closure includes branches/lazy/receiver-transfer paths but leaves generic loader domains symbolic; not an execution trace or exact reachability',
   'Native export aliases, signatures, errors, scheduling, GC, liveness and per-host behavior need their own source/implementation/runtime evidence',
   'Known deserializeInfo producers do not close the open native or user-supplied transfer domain',
   'No feature gate is treated as an exclusion, and nested Wasm remains required where source uses it',
  ],
  files,contexts:[...contexts.values()],bindings,sites,moduleEdges,sourceCycles,entryCandidates,wasmSites,transferSites,
 };
}

function serializeGraph(graph){
 // Keep one record per line so the complete generated evidence can be reviewed
 // without expanding thousands of small source-coordinate objects.
 const entries=Object.entries(graph);
 return '{\n'+entries.map(([key,value])=>{
  const encoded=Array.isArray(value)?'['+(value.length?'\n'+value.map(row=>'  '+JSON.stringify(row)).join(',\n')+'\n':'')+']':JSON.stringify(value,null,2);
  return '  '+JSON.stringify(key)+': '+encoded;
 }).join(',\n')+'\n}\n';
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const[manifestPath,reviewPath,outputPath]=process.argv.slice(2);if(!manifestPath||!reviewPath||!outputPath)throw Error('usage: index-nodejs-dependency-graph.mjs <sources.json> <dynamic-reviews.json> <output.json>');
 const result=buildDependencyGraph(manifestPath,JSON.parse(readFileSync(reviewPath,'utf8')));writeFileSync(outputPath,serializeGraph(result));console.log(JSON.stringify(result.counts));if(result.counts.parseErrors)process.exitCode=1;
}
