import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const [profile,artifact,output]=process.argv.slice(2,5).map(p=>resolve(p));
const mode=process.argv[5]??'cli';
if(!['cli','fork','shared-fork','shared-fork-native'].includes(mode)) throw Error('unexpected probe mode');
mkdirSync(output,{recursive:true});
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
let stdout='',stderr='';
const diagnostics=[];
const host=new NodeKernelHost({rootfsImage:readFileSync('local-binaries/partial/shell-partial.vfs.zst'),maxWorkers:4,
  onStdout:(_pid,data)=>{stdout+=new TextDecoder().decode(data);},
  onStderr:(_pid,data)=>{stderr+=new TextDecoder().decode(data);},
  onHostDiagnostic:event=>{diagnostics.push(event);console.error(JSON.stringify(event));},
});
const timeout=setTimeout(()=>{console.error('virtual PHP smoke deadline');void host.destroy();},180000);
try {
  console.log('initializing normal kernel with experimental process-memory adapter');
  await host.init();
  console.log('starting virtualized PHP');
  const bytes=readFileSync(artifact);
  const script=mode==='fork'?`
$graph=(object)["node"=>(object)["value"=>17]];
$parent=getmypid(); $child=pcntl_fork();
if($child===-1) exit(9);
if($child===0) {
  if($graph->node->value!==17 || getmypid()===$parent) exit(10);
  $graph->node->value=99;
  echo "__VM_CHILD__".json_encode(["pid"=>getmypid(),"private"=>$graph->node->value])."\\n";
  exit(0);
}
$wait=pcntl_waitpid($child,$status);
echo "__VM_WAIT__".json_encode(["child"=>$child,"wait"=>$wait,"status"=>$status,"errno"=>pcntl_get_last_error()])."\\n";
if($wait!==$child || !pcntl_wifexited($status) || pcntl_wexitstatus($status)!==0) exit(11);
if($graph->node->value!==17) exit(12);
echo "__VIRTUAL_PHP__".json_encode(["version"=>PHP_VERSION,"sum"=>array_sum(range(1,1000)),"private"=>$graph->node->value,"child"=>$child])."\\n";
`:'echo "__VIRTUAL_PHP__".json_encode(["version"=>PHP_VERSION,"sum"=>array_sum(range(1,1000))])."\\n";';
  const sharedProbe=mode.startsWith('shared-fork');
  const code=await host.spawn(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),
    sharedProbe?['shared-fork']:['php','-n','-r',script],
    {env:['PATH=/usr/bin:/bin','HOME=/home/maker','TMPDIR=/tmp'],cwd:'/home/maker',uid:1000,gid:1000,stdin:new Uint8Array()});
  const result={mode,code,stdout,stderr,diagnostics,artifact,sha256:createHash('sha256').update(bytes).digest('hex')};
  writeFileSync(resolve(output,'php-vm-result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  if(sharedProbe) {
    if(mode==='shared-fork-native') {
      if(code!==26 || stdout.includes('PASS real fork')) throw Error('separate-memory negative control did not refuse native shared synchronization');
    } else if(code!==0 || !stdout.includes('PASS real fork:')) throw Error('real shared-memory fork probe failed');
  } else if(code!==0 || !stdout.includes('"sum":500500')) throw Error('virtual PHP did not pass the CLI smoke');
  if(mode==='fork' && (!stdout.includes('__VM_CHILD__') || !stdout.includes('"private":17') || !stdout.includes('"private":99')))
    throw Error('virtual PHP did not pass real fork private-state isolation');
} finally {clearTimeout(timeout);await host.destroy();}
