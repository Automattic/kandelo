'use strict';
// Diagnostic calls into complete original bodies using the one actual realm
// loader. Failed probes remain gaps, never passing startup controls. This
// does not supply PrincipalRealm bootstrap state or select a user entrypath.
const api=__kandeloUpstreamTest;
function context(){const global=newGlobal({newCompartment:true});api.initializeContext(global);return {global,realm:api.initializeRealm(global)}}
const observations=[];
for(const operation of ['principal-bootstrap-node','original-typed-node-error','original-stack-limit-policy']){
  const {global,realm}=context();
  try{
    if(operation==='principal-bootstrap-node'){
      api.runNodeBootstrap(global);
    }else if(operation==='original-typed-node-error'){
      const {codes:{ERR_INVALID_ARG_TYPE}}=realm.require('internal/errors');
      const error=new ERR_INVALID_ARG_TYPE('name','string',1);
      if(error.code!=='ERR_INVALID_ARG_TYPE')throw new Error('incorrect original NodeError code');
    }else{
      realm.require('internal/errors').isErrorStackTraceLimitWritable();
    }
    observations.push({operation,status:'returned',compiledBuiltinIds:api.inspectRealm(global).compiledBuiltinIds});
  }catch(error){
    let stack;try{stack=error.stack}catch(stackError){stack='stack formatting failed: '+stackError.message}
    observations.push({operation,status:error.code==='ERR_KANDELO_NOT_IMPLEMENTED'?'missing-backend':'unexpected-failure',name:error.name,code:error.code,message:error.message,stack,compiledBuiltinIds:api.inspectRealm(global).compiledBuiltinIds});
  }
}
print(JSON.stringify({kind:'upstream-realm-bootstrap-gap-probe',observations,upstreamStartup:false,emptyEvaluation:'not run',simpleScript:'not run',commonJsEntry:'not run',esmEntry:'not run'}));
