const setup=`const api=__kandeloUpstreamTest;api.initializeContext();api.initializeRealm();const message=(value,caught=false)=>api.nativeOwners('message',value,caught);function collect(){clearKeptObjects();gc(undefined,'shrinking')}function assert(value){if(!value)throw Error('native message assertion')}`;
export const nativeMessageCases=[
 {name:'native-message-retains-actual-source-after-function-and-scope-collection',code:0,stdout:'MESSAGE_SOURCE_OK',source:setup+`
 const source='(function produce(){return new Error("retained")})()';
 const error=evaluate(source,{fileName:'retained-message.js',lineNumber:17});
 let getters=0;Object.defineProperty(error,'toString',{get(){getters++;throw 19}});
 collect();collect();const result=message(error);
 assert(result.hasSource&&result.source===source&&result.resource==='retained-message.js'&&result.origin==='retained-message.js');
 assert(result.line===17&&result.lineOffset===16&&result.columnOffset===0&&result.frames>0&&result.endColumn===0&&getters===0&&result.text.includes('retained'));
 print('MESSAGE_SOURCE_OK');`},
 {name:'native-catch-message-keeps-throw-location-separate-from-error-creation',code:0,stdout:'MESSAGE_THROW_OK',source:setup+`
 globalThis.pendingError=evaluate('new Error("creation")',{fileName:'message-created.js',lineNumber:11});
 const source='(function throwLater(){throw pendingError})';
 const thrower=evaluate(source,{fileName:'message-thrown.js',lineNumber:29});
 const result=message(thrower,true);
 assert(result.hasSource&&result.source===source&&result.resource==='message-thrown.js'&&result.origin==='message-thrown.js'&&result.line===29&&result.lineOffset===28);
 assert(result.startColumn===source.indexOf('throw pendingError')&&result.frames>0);delete globalThis.pendingError;
 print('MESSAGE_THROW_OK');`},
 {name:'native-message-keeps-original-origin-display-url-and-source-map-distinct',code:0,stdout:'MESSAGE_ORIGIN_OK',source:setup+`
 const error=evaluate('new Error("mapped")\\n//# sourceURL=message-display.js\\n//# sourceMappingURL=message-source.map',{fileName:'message-origin.js',lineNumber:41,columnNumber:8});
 collect();const result=message(error);
 assert(result.resource==='message-display.js'&&result.origin==='message-origin.js'&&result.sourceMap==='message-source.map');
 assert(result.line===41&&result.lineOffset===40&&result.columnOffset===7&&result.hasSource&&result.source==='new Error("mapped")');
 print('MESSAGE_ORIGIN_OK');`},
 {name:'native-message-does-not-coerce-exotic-thrown-values',code:0,stdout:'MESSAGE_EXOTIC_OK',source:setup+`
 let called=0;const exotic=new Proxy({},{get(){called++;throw 1},getPrototypeOf(){called++;throw 2}});
 function throwExotic(){throw exotic}
 const result=message(throwExotic,true);collect();assert(called===0&&result.hasSource&&result.source.includes('throw exotic')&&result.frames>0);
 print('MESSAGE_EXOTIC_OK');`},
 {name:'native-message-preserves-unicode-and-all-javascript-line-terminators',code:0,stdout:'MESSAGE_UNICODE_OK',source:setup+`
 const expected='new Error("λ𝄞")';
 for(const separator of ${JSON.stringify(['\n','\r\n','\u2028','\u2029'])}){
   const error=evaluate('/* prefix λ */'+separator+expected,{fileName:'message-λ.js',lineNumber:61});
   collect();const result=message(error);
   assert(result.hasSource===true&&result.source===expected&&result.text.includes('λ𝄞'));
   assert(result.resource==='message-λ.js'&&result.origin==='message-λ.js'&&result.line===62&&result.lineOffset===60);
 }
 print('MESSAGE_UNICODE_OK');`},
];
