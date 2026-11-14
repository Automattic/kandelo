export const statMicroScript=String.raw`
$dir='/tmp/stat-micro/a/b/c';
if (!mkdir($dir,0777,true) || file_put_contents($dir.'/file','value')!==5 || !symlink('file',$dir.'/link')) exit(10);
$path=$dir.'/file'; $link=$dir.'/link';
$rows=[]; $iterations=1500;
foreach (['stat','lstat','missing'] as $kind) {
  for ($round=-2;$round<5;$round++) {
    $sum=0; $start=hrtime(true);
    for ($i=0;$i<$iterations;$i++) {
      clearstatcache();
      $v=$kind==='stat'?stat($path):($kind==='lstat'?lstat($link):@stat($dir.'/absent'));
      if($kind==='missing') {if($v!==false)exit(11);$sum++;}
      else {if(!is_array($v))exit(12);$sum+=$v['size'];}
    }
    $elapsed=hrtime(true)-$start;
    if($sum!==$iterations*($kind==='stat'?5:($kind==='lstat'?4:1)))exit(13);
    $rows[]=['kind'=>$kind,'round'=>$round,'iterations'=>$iterations,'elapsedNs'=>$elapsed,'sum'=>$sum];
  }
}
if(file_put_contents($path,'changed-value')!==13 || !touch($path,1600000060))exit(14);
clearstatcache();$v=stat($path);if($v['size']!==13||$v['mtime']!==1600000060)exit(15);
if(!rename($path,$dir.'/moved'))exit(16);clearstatcache();if(@stat($path)!==false||stat($dir.'/moved')['size']!==13)exit(17);
echo '__STAT_MICRO__'.json_encode(['passed'=>true,'rows'=>$rows])."\n";
`;

export async function statMicroTrial(host,artifact) {
 await host.writeFileToVfs('/tmp/stat-micro.wasm',new Uint8Array(artifact),0o755);
 const child=await host.spawnFromVfs('/tmp/stat-micro.wasm',['php','-n','-r',statMicroScript],
  {cwd:'/tmp',uid:1000,gid:1000,env:['HOME=/tmp','TMPDIR=/tmp','PATH=/usr/bin:/bin']});
 const code=await child.exit;if(code!==0)throw Error('stat micro exit '+code);
 return {code};
}

export function parseStatMicro(stdout) {
 const match=stdout.match(/__STAT_MICRO__(\{[^\n]+\})/);if(!match)throw Error('missing stat micro result');
 const result=JSON.parse(match[1]);
 if(!result.passed||result.rows.length!==21)throw Error('incomplete stat micro');
 for(const row of result.rows)if(!Number.isFinite(row.elapsedNs)||row.elapsedNs<=0||row.iterations!==1500)throw Error('invalid micro sample');
 return result;
}
