const fs=require('node:fs'),vm=require('node:vm');
const mode=process.argv[2],src=process.argv[3],fast=process.argv[4]==='fast';const NativeDecoder=globalThis.TextDecoder;
let Decoder=NativeDecoder;
if(mode!=='native') {
 const source=fs.readFileSync(src,'utf8'),a=source.indexOf('function _nodeBufferSourceBytes('),b=source.indexOf('// Some JavaScript engine parsers',a);
 if(a<0||b<0)throw Error('Actual decoder selection missing');
 const nativeDecoder=new NativeDecoder('utf-8',{ignoreBOM:true});
 const context=vm.createContext({TextDecoder:undefined,_nodeNative:fast?{decodeUtf8(bytes){return nativeDecoder.decode(bytes);}}:{},_bufferIsUtf8:require('node:buffer').isUtf8});
 Decoder=vm.runInContext(source.slice(a,b)+';TextDecoder;',context);
}
const utf8=[
 ['prior-success',[[[65],true],[[255],true],[[239,187,191,66],true],[[],false]]],
 ['prior-bom',[[[239,187,191,65],true],[[255],true],[[239,187,191,66],true],[[],false]]],
 ['failed-call-partial',[[[65,255],true],[[239,187,191,66],true],[[],false]]],
 ['first-error',[[[255],true],[[239,187,191,66],true],[[],false]]],
 ['pending-invalid-continuation',[[[65],true],[[226],true],[[66],true],[[239,187,191,67],true],[[],false]]],
 ['nonstream-failure-resets',[[[65],true],[[255],false],[[239,187,191,66],true],[[],false]]],
 ['pending-flush-resets',[[[65],true],[[226],true],[[],false],[[239,187,191,66],true],[[],false]]],
 ['repeated-errors',[[[65],true],[[255],true],[[254],true],[[239,187,191,66],true],[[],false]]],
 ['empty-success-after-error',[[[65],true],[[255],true],[[],true],[[239,187,191,66],true],[[],false]]],
 ['split-bom-recovery',[[[65],true],[[255],true],[[239],true],[[187],true],[[191,66],true],[[],false]]],
 ['failed-call-bom-only-prefix',[[[239,187,191,255],true],[[239,187,191,66],true],[[],false]]],
];
const cases=[];
for(const [name,steps]of utf8)cases.push({name:'utf8-'+name,label:'utf-8',fatal:true,ignoreBOM:false,steps});
for(const fatal of[false,true])cases.push({name:'utf8-ignore-bom-'+fatal,label:'utf-8',fatal,ignoreBOM:true,steps:[[[65],true],[[255],true],[[239,187,191,66],true],[[],false]]});
cases.push({name:'utf8-nonfatal-replacement',label:'utf-8',fatal:false,ignoreBOM:false,steps:[[[65],true],[[255],true],[[239,187,191,66],true],[[],false]]});
for(const [label,bom,a,low]of[['utf-16le',[255,254],[65,0],[0,220]],['utf-16be',[254,255],[0,65],[220,0]]]) {
 cases.push({name:label+'-prior-success',label,fatal:true,steps:[[a,true],[low,true],[[...bom,...a],true],[[],false]]});
 cases.push({name:label+'-failed-partial',label,fatal:true,steps:[[[...a,...low],true],[[...bom,...a],true],[[],false]]});
 cases.push({name:label+'-nonstream-reset',label,fatal:true,steps:[[a,true],[low,false],[[...bom,...a],true],[[],false]]});
}
const rows=cases.map(({name,label,fatal,ignoreBOM,steps})=>{
 const decoder=new Decoder(label,{fatal,ignoreBOM});return{name,results:steps.map(([input,stream])=>{
  try{return{value:decoder.decode(new Uint8Array(input),{stream})};}catch(error){return{error:{name:error.name,code:error.code,message:error.message}};}
 })};
});
console.log(JSON.stringify(rows));
