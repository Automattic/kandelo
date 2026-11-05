const fs=require('node:fs');const base=process.argv[2],source=base+'/source',dest=base+'/dest';
function link(a,b){try{fs.linkSync(a,b);return 0;}catch(error){return error.errno;}}
fs.writeFileSync(source,'owned');const created=link(source,dest),a=fs.statSync(source),b=fs.statSync(dest);
const errors=[link(source,dest),link(base+'/missing',base+'/alias'),link(source,base+'/missing-parent/dest'),link('',base+'/empty')];
fs.unlinkSync(source);const remaining=fs.statSync(dest).nlink;
fs.symlinkSync('dest',base+'/symlink');const symlinkResult=link(base+'/symlink',base+'/symlink-alias');
const raw=Buffer.concat([Buffer.from(base+'/raw-'),Buffer.from([0xe9,0x9b,0xaa])]);fs.writeFileSync(raw,'bytes');const rawResult=link(raw,base+'/raw-alias');
console.log(JSON.stringify({created,same:a.ino===b.ino,links:a.nlink,retained:fs.readFileSync(dest,'utf8'),remaining,errors,symlinkResult,symlink:fs.lstatSync(base+'/symlink-alias').isSymbolicLink(),rawResult,rawSame:fs.statSync(raw).ino===fs.statSync(base+'/raw-alias').ino}));
