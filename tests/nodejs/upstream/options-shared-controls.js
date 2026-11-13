// Harness provides the actual native binding and GC operation. No guest shim.
check('native-method-names-lengths-and-export-descriptors',()=>{
  const expected=['getCLIOptionsValues','getCLIOptionsInfo','getOptionsAsFlags','getEmbedderOptions','getEnvOptionsInputType','getNamespaceOptionsInputType','parseNodeOptionsEnvVar'];
  assertEq(Object.keys(binding).filter(name=>typeof binding[name]==='function').join(','),expected.join(','));
  for(const name of expected){const fn=binding[name],d=Object.getOwnPropertyDescriptor(binding,name);assertEq(fn.name,name);assertEq(fn.length,0);assertEq(d.enumerable&&d.writable&&d.configurable,true)}
});
check('native-setting-and-type-enums-have-original-readonly-descriptors',()=>{
  assertEq(JSON.stringify(binding.envSettings),JSON.stringify({kAllowedInEnvvar:0,kDisallowedInEnvvar:1}));assertEq(JSON.stringify(binding.types),JSON.stringify({kNoOp:0,kV8Option:1,kBoolean:2,kInteger:3,kUInteger:4,kString:5,kHostPort:6,kStringList:7}));
  for(const table of [binding.types,binding.envSettings])for(const name of Object.keys(table)){const d=Object.getOwnPropertyDescriptor(table,name);assertEq(d.enumerable,true);assertEq(d.writable||d.configurable,false)}
});
check('whole-original-env-parser-retains-quote-escape-and-empty-token-semantics',()=>{
  for(const [text,expected] of [['',[]],['--conditions="a b" --no-warnings',['--conditions=a b','--no-warnings']],['--require="a\\"b\\\\c"',['--require=a"b\\c']],['"" a ""',['a']],['x\ty',['x\ty']],['x\u0000y',['x\u0000y']]])assertEq(JSON.stringify(binding.parseNodeOptionsEnvVar(text)),JSON.stringify(expected));
});
check('whole-original-env-parser-preserves-errors',()=>{
  for(const [text,message] of [['"a','invalid value for NODE_OPTIONS (unterminated string)\n'],['"a\\','invalid value for NODE_OPTIONS (invalid escape)\n']]){const error=thrown(()=>binding.parseNodeOptionsEnvVar(text));assertEq(error.name,'Error');assertEq(error.message,message);assertEq(error.code,undefined)}
});
check('native-env-string-coercion-calls-user-code-once-and-ignores-extra-arguments',()=>{
  let calls=0;const input={[Symbol.toPrimitive](hint){calls++;assertEq(hint,'string');return '--conditions="unicode \u03bb \ud83d\ude00"'}};
  assertEq(JSON.stringify(binding.parseNodeOptionsEnvVar.call({},input,{get unused(){throw new Error('EXTRA_ARG')}})),JSON.stringify(['--conditions=unicode \u03bb \ud83d\ude00']));assertEq(calls,1);
  assertEq(JSON.stringify(binding.parseNodeOptionsEnvVar()),JSON.stringify(['undefined']));assertEq(JSON.stringify(binding.parseNodeOptionsEnvVar(null)),JSON.stringify(['null']));
});
check('native-env-coercion-preserves-exception-identity-and-survives-reentrancy-gc',()=>{
  const marker={marker:'original input exception'};assertEq(thrown(()=>binding.parseNodeOptionsEnvVar({toString(){throw marker}})),marker);
  const input={toString(){assertEq(JSON.stringify(binding.parseNodeOptionsEnvVar('--inner')),JSON.stringify(['--inner']));collect();return '--outer'}};
  assertEq(JSON.stringify(binding.parseNodeOptionsEnvVar(input)),JSON.stringify(['--outer']));
});
