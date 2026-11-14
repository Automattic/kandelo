import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {runCanary} from '../checks.mjs';
import {runAccessForms} from '../access-checks.mjs';
import {runCacheCoherency} from './cache-checks.mjs';
import {runBounds} from './bounds-checks.mjs';
import {runObjectRegions} from './object-checks.mjs';
const folder=resolve(process.argv[2]),manifest=JSON.parse(readFileSync(resolve(folder,'manifest.json')));
const results={};
for(const [mode,{artifacts}] of Object.entries(manifest.variants)) {
  const canary=new WebAssembly.Module(readFileSync(artifacts.canary.path)),access=new WebAssembly.Module(readFileSync(artifacts.access.path));
  results[mode]={canary:runCanary(canary),access:runAccessForms(access),coherency:runCacheCoherency(canary,access)};
  if(artifacts.bounds)results[mode].bounds=runBounds(new WebAssembly.Module(readFileSync(artifacts.bounds.path)));
  if(artifacts.objects)results[mode].objects=runObjectRegions(new WebAssembly.Module(readFileSync(artifacts.objects.path)),
    new WebAssembly.Module(readFileSync(manifest.guardHelper.path)));
  console.log(mode,JSON.stringify(results[mode]));
}
writeFileSync(resolve(folder,'mechanism-node.json'),JSON.stringify(results,null,2)+'\n');
