// Node half of the exact cross-realm fixture; no browser/display is opened.
import {writeFileSync} from 'node:fs';
import {originalInputEvidenceFixtures,originalInputFailureFixtures} from './original-input-evidence-fixtures';
const out=process.argv[2];if(!out)throw Error('Private output file required');
const result={...originalInputEvidenceFixtures(),failureCustody:await originalInputFailureFixtures()};writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log('Original-input Node fixtures passed: '+Object.keys(result).join(', '));
