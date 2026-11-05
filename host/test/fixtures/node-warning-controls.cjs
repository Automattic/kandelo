'use strict';
const assert = require('node:assert/strict');
const [mode, name] = process.argv.slice(2);
const warning = mode === 'candidate' ? require('./node-warning-platform.cjs').install(name === 'noCapture') : {
  ...require('internal/process/warning'), values: { util: require('internal/util') },
};
const events = [], records = [];
process.on('warning', value => { if (value instanceof Error) events.push({name:value.name,message:value.message,code:value.code,detail:value.detail}); });
const settle = () => new Promise(resolve => setImmediate(resolve));
function failure(fn) { try { fn();return 'accepted'; } catch(error) {return {name:error.name,code:error.code,message:error.message};} }
async function main() {
  switch (name) {
    case 'overloads':
      process.emitWarning('message', {type:'CustomWarning',code:'W_TEST',detail:'detail'});
      process.emitWarning(new Error('actual error'), 'IgnoredType', 'IGNORED');
      process.emitWarning('function ctor', function boundary() {});
      for(const args of [[42],['x',42],['x',[],42],['x','Warning',42]]) records.push(failure(()=>process.emitWarning(...args)));
      await settle();return {events,records};
    case 'formatting': {
      process.emitWarning('first', {code:'W_FIRST',detail:'extra'});
      process.emitWarning('second', 'OtherWarning');
      process.emit('warning', {name:'Forged',toString(){return 'must not print';}});
      const value = new Error('fallback');value.toString=undefined;process.emitWarning(value);
      await settle();return {events};
    }
    case 'ordering':
      process.prependListener('warning',value=>records.push('warning:'+value.message));
      process.emitWarning('later');records.push('sync');
      Promise.resolve().then(()=>records.push('promise'));process.nextTick(()=>records.push('tick'));
      await settle();return {events,records};
    case 'syncDeprecator': {
      const fn=warning.values.util.deprecate(()=>records.push('body'),'deprecated','W_SYNC',true);
      process.prependListener('warning',()=>records.push('warning'));
      fn();fn();records.push('after');await settle();return {events,records};
    }
    case 'filtering':
      process.emitWarning('code filtered',{code:'W_HIDDEN'});
      process.emitWarning('name filtered','HiddenWarning');process.emitWarning('visible','OtherWarning');
      await settle();return {events};
    case 'runtimeNoWarnings':
      process.env.NODE_NO_WARNINGS='1';process.emitWarning('still printed');await settle();return {events};
    case 'suppressed':
      process.emitWarning('suppressed printer');await settle();return {events};
    case 'noDeprecation':
      process.emitWarning('suppressed','DeprecationWarning');process.emitWarning('visible');await settle();return {events};
    case 'aliases': {
      const names=['noDeprecation','noProcessWarnings','traceProcessWarnings','throwDeprecation','traceDeprecation'];
      return Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(process,name)]));
    }
    case 'throwDeprecation':
      process.once('uncaughtException',error=>records.push({name:error.name,message:error.message,code:error.code}));
      process.emitWarning('throw later','DeprecationWarning','W_THROW');records.push('sync');await settle();return {events,records};
    case 'redirect':
    case 'redirectFallback':
      process.emitWarning('file destination',{code:'W_FILE',detail:'owned output'});await settle();return {events};
    case 'noCapture': {
      let observed;process.once('warning',error=>{observed={hasStack:typeof error.stack==='string' && error.stack.includes(error.message),limit:Error.stackTraceLimit};});
      process.emitWarning('constructor stack');await settle();assert.equal(observed.hasStack,true);return observed;
    }
    case 'trace':
      // Compare real events; raw engine stack bytes are retained separately.
      process.emitWarning('trace requested');await settle();return {events};
    default: throw Error('Unknown warning control '+name);
  }
}
main().then(result=>{process.stdout.write(JSON.stringify(result)+'\n');},error=>{console.error(error);process.exitCode=1;});
