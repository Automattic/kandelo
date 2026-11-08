import type { OwnedJobRead } from '../../src/owned-jobs';
import { readRustCompilerJob } from './rust-guest-job';
import { rustCoverageSource } from './rust-coverage-project';

interface GuestHost {
  spawnFromVfs(path:string,argv:string[],options:{uid:number;gid:number;cwd:string;env:string[];ownedJob:{id:string;timeoutMs:number}}):Promise<{exit:Promise<unknown>}>;
  readOwnedJob(id:string,offset?:number,limit?:number):Promise<OwnedJobRead>;
  releaseOwnedJob(id:string):Promise<void>;
  readFileFromVfs(path:string):Promise<Uint8Array|null>;
  writeFileToVfs(path:string,bytes:Uint8Array):Promise<void>;
}
interface CoverageFile {filename:string;segments:Array<[number,number,number,boolean,boolean,boolean]>}
interface CoverageReport {
  data:Array<{files:CoverageFile[];functions:Array<{name:string;count:number}>}>;
}
const cwd='/home/maker/project/coverage-probe';
const binary=`${cwd}/target/debug/coverage-probe.wasm`;
const sourceLines=rustCoverageSource.split('\n');
const positive=sourceLines.findIndex(line=>line.trim()==='"positive"')+1;
const negative=sourceLines.findIndex(line=>line.trim()==='"nonpositive"')+1;
function require(condition:boolean,message:string):asserts condition {
  if(!condition)throw new Error(message);
}
function lineCount(file:CoverageFile,line:number):number|undefined {
  const column=sourceLines[line-1]!.indexOf('"')+1;
  let result:number|undefined;
  for(const segment of file.segments){
    if(segment[0]>line||(segment[0]===line&&segment[1]>column))break;
    result=segment[3]?segment[2]:undefined;
  }
  return result;
}

/** Identical normal guest Cargo/profile/report workflow on Node and browsers. */
export async function exerciseRustCoverage(host:GuestHost,baseEnv:string[]){
  const results:Record<string,Awaited<ReturnType<typeof readRustCompilerJob>>>={};
  const reports:Record<string,CoverageReport>={};
  const profileFiles:Record<string,string[]>={};
  let sequence=0;
  async function run(name:string,path:string,args:string[],profile='utility',expectedExit=0,timeoutMs=180000){
    const id=`rust-coverage-${++sequence}`;
    const {exit}=await host.spawnFromVfs(path,[path,...args],{uid:1000,gid:1000,cwd,
      env:[...baseEnv,'RUSTFLAGS=-C instrument-coverage',`LLVM_PROFILE_FILE=${cwd}/coverage-data/${profile}-%p.profraw`],ownedJob:{id,timeoutMs}});
    void exit.catch(()=>{});
    const result=await readRustCompilerJob(host,id,timeoutMs+30000);results[name]=result;
    console.info('[Rust coverage]',name,{exitCode:result.exitCode,status:result.status,
      stdoutBytes:new TextEncoder().encode(result.stdout).byteLength,stderr:result.stderr});
    require(result.status==='completed'&&result.exitCode===expectedExit,`${name}: ${JSON.stringify(result)}`);
    return result;
  }
  async function profiles(prefix:string){
    const listed=await run(`${prefix}-profiles`,binary,['list',prefix+'-']);
    const paths=listed.stdout.trim().split('\n').filter(Boolean);
    require(paths.length>0&&paths.length<=16,`unexpected ${prefix} profile count: ${paths.length}`);
    for(const path of paths)require(new RegExp(`^coverage-data/${prefix}-[1-9][0-9]*\\.profraw$`).test(path),`unexpected profile path ${path}`);
    require(new Set(paths).size===paths.length,'profile names collided');
    profileFiles[prefix]=paths;return paths;
  }
  async function report(prefix:string,module:string,expectedCalls:number,bothBranches:boolean){
    const paths=await profiles(prefix),merged=`coverage-data/${prefix}.profdata`;
    await run(`${prefix}-merge`,'/usr/bin/llvm-profdata',['merge','-sparse',...paths,'-o',merged]);
    const exported=await run(`${prefix}-export`,'/usr/bin/llvm-cov',['export',module,`--instr-profile=${merged}`]);
    const coverage:CoverageReport=JSON.parse(exported.stdout);reports[prefix]=coverage;
    const files=coverage.data[0]!.files.filter(file=>file.filename.endsWith('/src/main.rs'));
    const classify=coverage.data[0]!.functions.filter(fn=>fn.name.endsWith('8classify'));
    require(files.length===1&&classify.length===1,'report must identify the real project source and classify function');
    require(classify[0]!.count===expectedCalls,`${prefix}: expected ${expectedCalls} calls, got ${classify[0]!.count}`);
    require((lineCount(files[0]!,positive)??0)>0,`${prefix}: positive branch was not covered`);
    require(bothBranches?(lineCount(files[0]!,negative)??0)>0:lineCount(files[0]!,negative)===0,
      `${prefix}: coverage did not distinguish the nonpositive branch`);
    return paths;
  }
  for(const tool of ['llvm-cov','llvm-profdata']){
    const version=await run(tool+'-version','/usr/bin/'+tool,['--version']);
    require(version.stdout.includes('22.1.2'),`${tool} does not match the Rust compiler's LLVM`);
  }
  await run('build','/usr/bin/cargo',['build','--offline','-j1'],'utility',0,600000);
  require((await run('positive',binary,['positive'],'positive')).stdout==='positive\n','instrumented binary output changed');
  await report('positive',binary,1,false);
  const text=await run('text','/usr/bin/llvm-cov',['show',binary,'--instr-profile=coverage-data/positive.profdata']);
  require(text.stdout.includes('fn classify'),'text report did not read the actual guest source');
  await run('html','/usr/bin/llvm-cov',['show',binary,'--instr-profile=coverage-data/positive.profdata','--format=html','--output-dir=coverage-data/html']);
  const html=await host.readFileFromVfs(`${cwd}/coverage-data/html/index.html`);
  require(!!html&&new TextDecoder().decode(html).includes('Coverage Report'),'HTML report was not generated');
  const child=await run('subprocess',binary,['subprocess'],'subprocess');
  require(child.stdout==='nonpositive\npositive\n','instrumented child did not execute normally');
  require((await report('subprocess',binary,2,true)).length===2,'%p must preserve the parent and child profiles separately');
  require((await run('threaded',binary,['threaded'],'threaded')).stdout==='threads-completed\n','instrumented threads did not join');
  await report('threaded',binary,400,true);
  const tests=await run('unit-tests','/usr/bin/cargo',['test','--offline','-j1','--bin','coverage-probe','--message-format=json','--','--test-threads=1'],'unit',0,600000);
  require(tests.stdout.includes('2 passed; 0 failed'),'ordinary libtest did not run both instrumented tests');
  const artifacts=tests.stdout.split('\n').flatMap(line=>{
    try{const value=JSON.parse(line);return value.reason==='compiler-artifact'&&value.profile?.test&&typeof value.executable==='string'?[value.executable]:[];}catch{return [];}
  });
  require(artifacts.length===1&&artifacts[0]!.startsWith(cwd+'/target/')&&artifacts[0]!.endsWith('.wasm'),'Cargo did not identify exactly one test executable');
  await report('unit',artifacts[0]!,2,true);
  await host.writeFileToVfs(`${cwd}/coverage-data/corrupt.profraw`,new TextEncoder().encode('invalid instrumentation profile'));
  const corrupt=await run('corrupt','/usr/bin/llvm-profdata',['merge','coverage-data/corrupt.profraw','-o','coverage-data/corrupt.profdata'],'utility',1);
  require(/truncated|malformed|unrecognized/.test(corrupt.stderr),'corrupt profile failed for an unrelated reason');
  const raw=await host.readFileFromVfs(`${cwd}/${profileFiles.positive![0]}`);
  require(!!raw&&raw.byteLength>=16,'actual raw profile missing');
  const mismatched=raw.slice();mismatched[8]=255;
  await host.writeFileToVfs(`${cwd}/coverage-data/version.profraw`,mismatched);
  const version=await run('version-mismatch','/usr/bin/llvm-profdata',['merge','coverage-data/version.profraw','-o','coverage-data/version.profdata'],'utility',1);
  require(/version/.test(version.stderr),'incompatible profile version failed for an unrelated reason');
  return {results,reports,profileFiles};
}
