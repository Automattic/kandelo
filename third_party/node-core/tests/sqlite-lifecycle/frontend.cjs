'use strict';
// Actual frontend policy over explicit native SQLite/VM/encoding dependencies.
const fs=require('node:fs'),path=require('node:path'),sqlite=require('node:sqlite'),util=require('node:util'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..');
const factories=Function(fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8')+';return{sqlite:_createNodeSqlitePlatform,values:_createNodeValuesPlatform}')();
const encoder=new TextEncoder();
let parameterTool;
function native(operation,owner,first,second){
 if(operation==='create')return{db:new sqlite.Database(owner,{open:first.open,readOnly:first.readOnly,defensive:first.defensive}),filename:owner,functions:[]};
 if(operation==='open'||operation==='close')return owner.db[operation]();
 if(operation==='checkDatabase'){if(!owner.db.isOpen)throw Object.assign(Error('database is not open'),{code:'ERR_INVALID_STATE'});return}
 if(operation==='isOpen'||operation==='isTransaction')return owner.db[operation];
 if(operation==='exec')return owner.db.exec(first);
 if(operation==='prepare'){
  const stmt=owner.db.prepare(first,{readBigInts:true});
  // Prepare metadata against a real serialized snapshot of the native fixture
  // connection, including its schema and registered callback signatures.
  const directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'sqlite-metadata-'));
  try {
   const snapshot=path.join(directory,'snapshot.sqlite');fs.writeFileSync(snapshot,owner.db.serialize());
   const result=require('node:child_process').spawnSync(parameterTool,[snapshot,first,...owner.functions.flat()],{encoding:'utf8',timeout:5000});
   assert.equal(result.status,0,result.stderr);
   return{stmt,db:owner.db,values:[],iterator:null,parameters:JSON.parse(result.stdout).map(name=>Buffer.from(name,'latin1').toString('utf8'))};
  }finally{fs.rmSync(directory,{recursive:true,force:true})}
 }
 if(operation==='isStatementFinalized'){try{owner.stmt.columns();return false}catch(e){if(e.code==='ERR_INVALID_STATE'&&e.message==='statement has been finalized')return true;throw e}}
 if(operation==='closeStatement')return first?owner.stmt[Symbol.dispose]():owner.stmt.close();
 if(operation==='finalize')return owner.stmt[Symbol.dispose]();
 if(operation==='checkStatement'){owner.stmt.columns();return}
 if(operation==='sourceSQL'||operation==='expandedSQL')return owner.stmt[operation];
 if(operation==='reset'){owner.stmt.columns();if(owner.iterator)owner.iterator.return();owner.iterator=null;if(first)owner.values=[];return}
 if(operation==='bind'){owner.values[first-1]=second;return}
 if(operation==='parameters')return owner.parameters;
 if(operation==='columns')return owner.stmt.columns().map(c=>[c.column,c.database,c.name,c.table,c.type]);
 if(operation==='names')return owner.stmt.columns().map(c=>c.name);
 if(operation==='registerScalar'){owner.db.function(first,{useBigIntArguments:arguments[5],varargs:arguments[4]===-1,deterministic:arguments[6],directOnly:arguments[7]},second);owner.functions.push(['scalar',first,String(arguments[4])]);return}
 if(operation==='registerAggregate'){const [,,name,start,step,inverse,result,arity,big,direct]=arguments;owner.db.aggregate(name,{start,step,inverse,result,varargs:arity===-1,useBigIntArguments:big,directOnly:direct});owner.functions.push(['aggregate',name,String(arity)]);return}
 if(operation==='step'||operation==='stepDiscard'){
  if(!owner.iterator){const named={};for(let i=0;i<owner.parameters.length;i++)named[owner.parameters[i]]=owner.values[i];owner.iterator=owner.stmt.iterate(...(owner.parameters.length?[named]:[]))}
  const value=owner.iterator.next();if(operation==='stepDiscard')return!value.done;if(value.done)return null;
  return owner.stmt.columns().map(c=>{const n=value.value[c.name];return n===null?[5,null]:typeof n==='bigint'?[1,n]:typeof n==='number'?[2,n]:typeof n==='string'?[3,encoder.encode(n)]:[4,n]})
 }
 throw Error('Unexpected native SQLite fixture operation: '+operation);
}
module.exports=function(tool){parameterTool=tool;const values=factories.values({process,Buffer,util,inspection:util,os:{},signals:require('node:os').constants.signals});return factories.sqlite({native:{sqlite:native},values,util,Buffer,TextDecoder,URL,fileURLToPath:require('node:url').fileURLToPath,markUncloneable:require('node:worker_threads').markAsUncloneable,constants:sqlite.constants})};
