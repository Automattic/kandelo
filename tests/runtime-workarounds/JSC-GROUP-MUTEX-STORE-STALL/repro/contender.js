let enter;
onmessage=({data})=>{
 if(data.type==='init') {const instance=new WebAssembly.Instance(data.module,{env:{memory:data.memory}});enter=instance.exports[data.algorithm];postMessage({type:'ready'});}
 else if(data.type==='run') {postMessage({type:'entering'});enter(0);postMessage({type:'done'});}
};
