'use strict';
// One unchanged case body is run against native Node and actual candidate
// bootstrap/record factories. No assertion substitutes a mocked load result.
module.exports = {
 registration({ M }) {
  const results=[];
  const out=fn=>{try{return {value:fn()}}catch(e){return {name:e.name,code:e.code,message:e.message}}};
  for(const x of [undefined,null,0,false,'',{}, {resolve:0,load:false},{resolve:'x'},{load:1},{resolve:{}},{load:Symbol('x')}])
   results.push(out(()=>{const h=M.registerHooks(x);const r={keys:Reflect.ownKeys(h).map(k=>typeof k==='symbol'?k.description:k),frozen:Object.isFrozen(h),resolve:h.resolve,load:h.load,dispose:h[Symbol.dispose]===h.deregister,protoKeys:Object.getOwnPropertyNames(Object.getPrototypeOf(h))};h.deregister();h.deregister();return r}));
  return results;
 },
 chain({M,req,dir,url}) {
  const trace=[],handles=[];let i=0;
  handles.push(M.registerHooks({resolve(s,c,next){if(s!=='chain')return next(s,c);trace.push(['r1',c.parentURL,c.extra,c.importAttributes,c.conditions.includes('require')]);return {url:'fixture:chain',format:'commonjs',shortCircuit:true}},load(u,c,next){if(u!=='fixture:chain')return next(u,c);trace.push(['l1',c.format,c.extra]);return {source:'module.exports={answer:41+1,filename:__filename,dirname:__dirname}',format:'commonjs',shortCircuit:true}}}));
  handles.push(M.registerHooks({resolve(s,c,next){if(s!=='chain')return next(s,c);trace.push(['r2',c.parentURL,c.importAttributes]);const r=next(s,{...c,extra:'merged'});trace.push(['r2after',c.extra]);return r},load(u,c,next){if(u!=='fixture:chain')return next(u,c);trace.push(['l2',c.format,c.importAttributes]);return next(u,{...c,extra:'loadmerged'})}}));
  try {const value=req('chain');return {trace,value,resolved:req.resolve('chain')}}finally{for(const h of handles)h.deregister()}
 },
 errors({M,req}) {
  const outputs=[],capture=f=>{try{f();return {ok:true}}catch(e){return {name:e.name,code:e.code,message:e.message}}};
  for(const bad of [{},{url:1,shortCircuit:true},{url:'fixture:x',format:3,shortCircuit:true},{url:'fixture:x',importAttributes:1,shortCircuit:true},{url:'fixture:x'}]) {
   const h=M.registerHooks({resolve(){return bad}});try{outputs.push(capture(()=>req('x')))}finally{h.deregister()}
  }
  for(const bad of [{format:'commonjs',shortCircuit:true},{source:3,format:'commonjs',shortCircuit:true},{source:'module.exports=1',format:3,shortCircuit:true},{source:'module.exports=1',format:'commonjs'}]) {
   const h=M.registerHooks({resolve(){return {url:'fixture:x',format:'commonjs',shortCircuit:true}},load(){return bad}});try{outputs.push(capture(()=>req('x')))}finally{h.deregister()}
  }
  return outputs;
 },
 sourceTypes({M,req}) {
  const out=[],sources=['module.exports=42',Buffer.from('module.exports=43'),new TextEncoder().encode('module.exports=44').buffer,new DataView(new TextEncoder().encode('module.exports=45').buffer)];let n=0;
  const h=M.registerHooks({resolve(s,c,next){return s.startsWith('typed')?{url:'fixture:'+s,format:'commonjs',shortCircuit:true}:next(s,c)},load(u,c,next){if(!u.startsWith('fixture:typed'))return next(u,c);return {source:sources[n++],format:'commonjs',shortCircuit:true}}});
  try{for(let i=0;i<sources.length;i++)out.push(req('typed'+i));return out}finally{h.deregister()}
 },
 transformation({M,req,dir}) {
  let loads=0;const trace=[];
  const h=M.registerHooks({load(u,c,next){if(!u.endsWith('/a.cjs'))return next(u,c);const r=next(u,c);loads++;trace.push({format:c.format,conditions:c.conditions.includes('require'),attrs:c.importAttributes});return {...r,source:r.source.replace('"disk"','"transformed"')}}});
  try {const a=req('./a.cjs'), b=req('./a.cjs');return {value:a.value,child:a.child,filename:a.filename,dirname:a.dirname,same:a===b,loads,trace,loaded:req.cache[dir+'/a.cjs'].loaded,keys:Object.keys(req.cache).filter(name=>name.startsWith(dir+'/'))}}finally{h.deregister()}
 },
 conditions({M,req}) {
  const h=M.registerHooks({resolve(s,c,next){return s==='pkg'?next(s,{...c,conditions:['custom']}):next(s,c)}});
  try{return {resolved:req.resolve('pkg'),value:req('pkg')}}finally{h.deregister()}
 },
 invalidConditions({M,req}) {
  const out=[];
  for(const conditions of [1,null,{},'require']){const h=M.registerHooks({resolve(s,c,next){return next(s,{...c,conditions})}});try{req.resolve('pkg');out.push('ok')}catch(e){out.push({name:e.name,code:e.code,message:e.message})}finally{h.deregister()}}
  return out;
 },
 builtins({M,req}) {
  const trace=[];let count=0;
  const h=M.registerHooks({resolve(s,c,next){if(s==='alias')return {url:'node:path',format:'builtin',shortCircuit:true};return next(s,c)},load(u,c,next){if(u!=='node:path')return next(u,c);trace.push({url:u,format:c.format,conditions:c.conditions.includes('require')});if(++count===1){const r=next(u,c);return {...r,source:'ignored builtin source'}}return {format:'commonjs',source:'module.exports={replacement:true}',shortCircuit:true}}});
  try{return {first:req('alias').join('a','b'),second:req('node:path'),third:req('path'),trace}}finally{h.deregister()}
 },
 json({M,req}) {
  let calls=0;const h=M.registerHooks({resolve(s,c,next){return s==='json'?{url:'fixture:json',format:'json',shortCircuit:true}:next(s,c)},load(u,c,next){return u==='fixture:json'?{source:Buffer.from('{"real":42}'),format:'json',shortCircuit:true}:next(u,c)}});
  try{return {one:req('json'),two:req('json'),loaded:req.cache['fixture:json'].loaded}}finally{h.deregister()}
 },
 failureRepair({M,req}) {
  let broken=true,calls=0;const h=M.registerHooks({resolve(s,c,next){return s==='broken'?{url:'fixture:broken',format:'commonjs',shortCircuit:true}:next(s,c)},load(u,c,next){if(u!=='fixture:broken')return next(u,c);calls++;return {source:broken?'const = ;':'module.exports={fixed:true}',format:'commonjs',shortCircuit:true}}});
  try{let error;try{req('broken')}catch(e){error={name:e.name,cache:!!req.cache['fixture:broken']}}broken=false;return{error,repaired:req('broken'),calls}}finally{h.deregister()}
 },
 circular({M,req}) {
  const src={a:'exports.name="a";exports.b=require("b");exports.done=true',b:'exports.name="b";exports.a=require("a")'};
  const h=M.registerHooks({resolve(s,c,next){return Object.hasOwn(src,s)?{url:'fixture:'+s,format:'commonjs',shortCircuit:true}:next(s,c)},load(u,c,next){const k=u.slice(8);return Object.hasOwn(src,k)?{source:src[k],format:'commonjs',shortCircuit:true}:next(u,c)}});
  try{const a=req('a');return{name:a.name,b:a.b.name,same:a.b.a===a,done:a.done,children:req.cache['fixture:a'].children.map(m=>m.filename),loaded:req.cache['fixture:a'].loaded}}finally{h.deregister()}
 },
 deregistration({M,req}) {
  let first=0,second=0;
  const h1=M.registerHooks({resolve(s,c,next){first++;return next(s,c)}}),h2=M.registerHooks({resolve(s,c,next){second++;return next(s,c)}});
  try{req.resolve('./a.cjs');h2[Symbol.dispose]();req.resolve('./a.cjs');h1.deregister();req.resolve('./a.cjs');return {first,second}}finally{h1.deregister();h2.deregister()}
 },
 formatOverrides({M,req}) {
  const out=[];
  for(const [format,source] of [['json','{"value":42}'],['imaginary','module.exports=42'],['commonjs','export default 42']]){
   const h=M.registerHooks({load(u,c,next){if(!u.endsWith('/child.cjs'))return next(u,c);return{source,format,shortCircuit:true}}});
   try{out.push({value:req('./child.cjs')})}catch(e){out.push({name:e.name,code:e.code})}finally{h.deregister();for(const k of Object.keys(req.cache))if(k.endsWith('/child.cjs'))delete req.cache[k]}
  }
  return out;
 },
 loadRedirect({M,req,dir,url}) {
  const h=M.registerHooks({load(u,c,next){return u.endsWith('/a.cjs')?next(url.pathToFileURL(dir+'/child.cjs').href,c):next(u,c)}});
  try{return{value:req('./a.cjs'),filename:req.cache[dir+'/a.cjs'].filename}}finally{h.deregister()}
 },
 loadFailure({M,req,dir}) {
  let first=true,calls=0;
  const h=M.registerHooks({load(u,c,next){if(u.endsWith('/child.cjs')){calls++;if(first){first=false;throw Object.assign(Error('hook failed'),{code:'CUSTOM_HOOK_ERROR'})}}return next(u,c)}});
  try{let err;try{req('./child.cjs')}catch(e){err={name:e.name,code:e.code,message:e.message,cached:!!req.cache[dir+'/child.cjs']}}return{err,value:req('./child.cjs'),calls}}finally{h.deregister()}
 },
 resolveOptions({M,req,dir}) {
  const h=M.registerHooks({resolve(s,c,next){return next(s,{...c,conditions:['custom']})}});
  try{return req.resolve('pkg',{paths:[dir]})}finally{h.deregister()}
 },
 cache({M,req}) {
  let resolves=0,loads=0;
  const h=M.registerHooks({resolve(s,c,next){if(s==='cache'){resolves++;return {url:'fixture:cache',format:'commonjs',shortCircuit:true}}return next(s,c)},load(u,c,next){if(u==='fixture:cache'){loads++;return {source:'module.exports={value:42}',format:'commonjs',shortCircuit:true}}return next(u,c)}});
  try{const a=req('cache'),b=req('cache');delete req.cache['fixture:cache'];const c=req('cache');return{same:a===b,reloaded:a!==c,resolves,loads}}finally{h.deregister()}
 },
};
