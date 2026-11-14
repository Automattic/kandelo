import {readFileSync} from 'node:fs';
import {runAccessForms} from './access-checks.mjs';
console.log(JSON.stringify(runAccessForms(new WebAssembly.Module(readFileSync(process.argv[2])))));
