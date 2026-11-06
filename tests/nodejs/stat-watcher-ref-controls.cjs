'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const component=process.argv[2]==='component';const subject=component?require('../../host/test/fixtures/node-stat-watcher-platform.cjs').create():{api:fs,close(){}};
const dir=fs.mkdtempSync(path.join(process.env.KANDELO_STAT_WATCHER_TMP||os.tmpdir(),'stat-ref-'));
const file=path.join(dir,'missing');let changes=0;
const watcher=subject.api.watchFile(file,{interval:5007},()=>{changes++;watcher.unref();console.log(JSON.stringify({mode:component?'component':'native',initialChange:changes,referenced:watcher._handle.hasRef()}));});
process.once('beforeExit',()=>{if(changes!==1)throw Error('Missing native poll observation');if(watcher._handle.hasRef())throw Error('Unref owner still referenced');subject.close();fs.rmSync(dir,{recursive:true,force:true});console.log(JSON.stringify({beforeExit:true,changes}));});
