'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const pin=path.resolve(__dirname,'../../../.context/nodejs-lts-cache-v2/node-v26.13.0');
function payload(name){return JSON.parse(fs.readFileSync(path.join(pin,'test/fixtures/source-map',name),'utf8'));}
function failure(fn){try{fn();return {unexpectedSuccess:true};}catch(e){return {name:e.name,code:e.code,message:e.message};}}
exports.controls={
  actualMapsAndOffsets(SourceMap){
    const result=[];
    for(const name of ['disk.map','disk-index.map','typescript-throw.js.map']){
      const map=new SourceMap(payload(name));
      for(const [line,column] of [[-1,0],[0,-1],[0,0],[0,29],[1,30],[19,14],[20,0],[100,500]])
        result.push([name,line,column,map.findEntry(line,column),map.findOrigin(line+1,column+1)]);
    }
    const empty=new SourceMap({version:3,sources:[],names:[],mappings:';;;;'});
    assert.deepEqual(empty.findEntry(0,0),{});assert.deepEqual(empty.findOrigin(1,1),{});
    return result;
  },
  vlqBoundariesAndUnmappedRanges(SourceMap){
    const columns=['A','B','C','D','E','F','+/////D','8/////D','//////D','9/////D'];
    const result=columns.map(column=>new SourceMap({sources:['original.js'],mappings:`AAA${column}`}).findEntry(0,0));
    const map=new SourceMap({sources:['original.js'],names:['first','second'],mappings:'AAAAA,UAAEC;A;AAAA'});
    result.push(map.findEntry(0,0),map.findEntry(0,5),map.findEntry(0,10),map.findEntry(1,0),map.findOrigin(2,1));
    const sorted=new SourceMap({sources:['test.js'],mappings:'UAAA,FAAE,FAAE'});
    result.push(...[6,8,10].map(column=>sorted.findEntry(0,column)));
    return result;
  },
  payloadCopiesAndRetainedInputs(SourceMap){
    const input={version:3,sources:['a.js'],names:['a'],mappings:'AAAAA',sourcesContent:['source'],sourceRoot:'/root/'};
    const lengths=[5,10],map=new SourceMap(input,{lineLengths:lengths});
    input.sources[0]='changed.js';input.names[0]='changed';input.mappings=';;;;';
    const first=map.payload;first.sources[0]='returned.js';first.names[0]='returned';
    assert.notEqual(first,map.payload);assert.notEqual(first.sources,map.payload.sources);
    assert.equal(map.payload.sources[0],'a.js');assert.equal(map.findEntry(0,0).originalSource,'a.js');
    const copy=map.lineLengths;copy[0]=77;assert.equal(map.lineLengths[0],5);
    // The constructor retains the input lineLengths array. Getter copies are
    // independent, while later caller mutation of the input remains visible.
    lengths[0]=99;assert.equal(map.lineLengths[0],99);
    const section={offset:{line:3,column:4},map:{sources:['section.js'],mappings:'AAAA'}};
    const indexed=new SourceMap({sections:[section]});section.map.sources[0]='later.js';
    assert.equal(indexed.findEntry(3,4).originalSource,'section.js');
    return {payload:map.payload,entry:map.findEntry(0,0),lengths:map.lineLengths,
      nestedPayload:indexed.payload,decodedBeforeMutation:indexed.findEntry(3,4),emptyLengths:new SourceMap({sources:[],mappings:''},{lineLengths:[]}).lineLengths};
  },
  validationReceiversAndDescriptors(SourceMap){
    const result=[];
    for(const value of [undefined,null,1,true,'x',[],()=>{}])result.push(failure(()=>new SourceMap(value)));
    const get=Object.getOwnPropertyDescriptor(SourceMap.prototype,'payload').get;
    result.push(failure(()=>get.call({})),failure(()=>SourceMap.prototype.findEntry.call({},0,0)));
    const keys=Reflect.ownKeys(SourceMap.prototype).map(key=>{
      const d=Object.getOwnPropertyDescriptor(SourceMap.prototype,key);
      return [typeof key==='symbol'?String(key):key,d.enumerable,d.configurable,d.writable,d.value?.name,d.value?.length,d.get?.name];
    });
    return {result,keys,name:SourceMap.name,length:SourceMap.length};
  },
};
