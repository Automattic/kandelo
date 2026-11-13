// A private diagnostic is served by an exact test endpoint. It never enters
// package resolution, the js/node aliases, an image or the published cache.
import base from '../libuv-browser/vite.config';
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import type {ConfigEnv,Plugin} from 'vite';
export default async function config(env:ConfigEnv){
 const selected=await base(env),program=process.env.KANDELO_NODE_NATIVE_OWNER_ENGINE_WASM;
 if(!program||!isAbsolute(program))throw Error('Private native-owner artifact must be absolute');
 const bytes=readFileSync(program);
 const probe:Plugin={name:'private-native-owner-probe',configureServer(server){
  server.middlewares.use((request,response,next)=>{
   if(request.url!=='/__kandelo_native_owner_probe.wasm')return next();
   if(request.method!=='GET'){response.statusCode=405;response.end();return;}
   response.setHeader('Content-Type','application/wasm');response.setHeader('Cache-Control','no-store');response.end(bytes);
  });
 }};
 return {...selected,plugins:[probe,...(selected.plugins??[])]};
}
