// Exercise the complete original GetCurrentStackTrace and PrintStackTrace bodies.
const setup=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();function capture(){return api.nativeOwners('stackFrames',20)}function assert(value){if(!value)throw Error('native stack assertion')}`;
export const nativeStackCases=[
 {name:'native-stack-retains-real-script-position-with-eval-looking-filename',code:0,stdout:'STACK_SCRIPT_OK',source:setup+`
 const frames=evaluate('function traced(){return capture()} traced()',{fileName:'eval-at-pretend.js',lineNumber:17});
 const frame=frames.find(frame=>frame.name==='traced');assert(frame&&frame.source==='eval-at-pretend.js'&&frame.line===17&&frame.column===26&&!frame.eval&&frame.scriptId>0);
 print('STACK_SCRIPT_OK');`},
 {name:'native-stack-uses-compiler-provenance-for-eval-and-function-constructor',code:0,stdout:'STACK_EVAL_OK',source:setup+`
 const frames=eval('function insideEval(){return capture()} insideEval()');
 const frame=frames.find(frame=>frame.name==='insideEval');assert(frame&&frame.eval&&frame.line===1&&frame.column===30);
 const constructed=Function('return capture()')();assert(constructed.some(frame=>frame.eval&&frame.line===3&&frame.column===8));
 print('STACK_EVAL_OK');`},
 {name:'native-stack-distinguishes-compilations-sharing-filename-and-position',code:0,stdout:'STACK_IDENTITY_OK',source:setup+`
 function run(){return evaluate('capture()',{fileName:'same-stack-source.js'})}
 const first=run().find(frame=>frame.source==='same-stack-source.js');clearKeptObjects();gc(undefined,'shrinking');
 const second=run().find(frame=>frame.source==='same-stack-source.js');
 assert(first&&second&&first.line===second.line&&first.column===second.column&&first.scriptId>0&&second.scriptId>0&&first.scriptId!==second.scriptId);
 assert(api.nativeOwners('stackFrames',0).length===0&&api.nativeOwners('stackFrames',1).length===1);
 print('STACK_IDENTITY_OK');`},
 {name:'native-stack-original-printer-uses-captured-source-and-position',code:0,stdout:'STACK_PRINT_OK',stderr:'    at printable-stack.js:23:5\n\n',source:setup+`
 evaluate("api.nativeOwners('stackFrames',1,true)",{fileName:'printable-stack.js',lineNumber:23});print('STACK_PRINT_OK');`},
];
