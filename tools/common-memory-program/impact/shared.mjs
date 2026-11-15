export async function fileCacheInventory(host) {
  let files=0,logicalBytes=0,directories=0;
  const queue=['/var/cache/opcache'];
  while(queue.length){
    const path=queue.shift(),entries=await host.readDirFromVfs(path);
    if(!entries)throw Error('missing OPcache directory');
    directories++;
    for(const entry of entries){
      if(entry.name==='.'||entry.name==='..')continue;
      if((entry.mode&0xf000)===0x4000)queue.push(path+'/'+entry.name);
      else{files++;logicalBytes+=entry.size;}
    }
  }
  return{files,logicalBytes,directories,scope:'logical VFS file lengths, not resident RAM'};
}
