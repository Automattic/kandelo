'use strict';
const vm=require('node:vm'),{writeSync}=require('node:fs');
const compileBody=(global,filename,body)=>vm.compileFunction(body,['require','__filename','__dirname'],{filename,parsingContext:global===globalThis?undefined:global});
const createCompilerRealm=()=>vm.createContext({});
const evaluateCompilerScript=(global,source)=>global===globalThis?vm.runInThisContext(source):vm.runInContext(source,global);
const compilerFullGC=()=>gc();
const collectCompilerGarbage=async()=>{await new Promise(setImmediate);gc();await new Promise(setImmediate);gc()};
const compilerErrorLocation=error=>{const prior=Error.prepareStackTrace;try{Error.prepareStackTrace=(_,frames)=>frames;const frame=error.stack[0];return {file:frame.getFileName(),line:frame.getLineNumber()}}finally{Error.prepareStackTrace=prior}};
