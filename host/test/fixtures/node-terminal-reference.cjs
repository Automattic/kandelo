const fs=require('node:fs'),tty=require('node:tty'),{spawnSync}=require('node:child_process');
const device=process.argv[2],probe=process.argv[3];
function snapshot(){const p=spawnSync(probe,[device,'snapshot'],{encoding:'utf8'});if(p.status!==0)throw Error(p.stderr);return JSON.parse(p.stdout);}
async function main(){const fd=fs.openSync(device,fs.constants.O_RDWR|fs.constants.O_NOCTTY),input=new tty.ReadStream(fd);const result=[snapshot()];
 for(const mode of ['raw','io',false,true]){input.setRawMode(mode);result.push(snapshot());}
 const closed=new Promise((resolve,reject)=>{input.once('close',resolve);input.once('error',reject);});input.destroy();await closed;result.push(snapshot());
 fs.fstatSync(fd);fs.closeSync(fd);console.log(JSON.stringify(result));}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
