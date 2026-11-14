import {runByteSliceChecks} from './byte-slice-checks.mjs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
const root=resolve(process.argv[2]);
const baseline=await import(pathToFileURL(resolve(root,'baseline-memory.mjs'))),candidate=await import(pathToFileURL(resolve(root,'candidate-memory.mjs')));
const result=runByteSliceChecks(baseline,candidate);
await writeFile(resolve(root,'node-result.json'),JSON.stringify({runtime:process.version,flags:process.execArgv,...result},null,2)+'\n');
console.log(JSON.stringify({passed:result.passed,checks:result.checks.length,diagnostics:result.diagnostics}));
