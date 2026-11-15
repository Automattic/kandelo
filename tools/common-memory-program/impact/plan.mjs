import {readFileSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import {resolve, extname} from 'node:path';
import {createHash} from 'node:crypto';

const [fixtureArg, profileArg, kernelArg, outputArg, planArg] = process.argv.slice(2);
if (!planArg) throw Error('usage: plan.mjs FIXTURE PROFILE KERNEL FRESH_RESULTS FRESH_PLAN');
const [fixture, profile, kernel, output, destination] = [fixtureArg, profileArg, kernelArg, outputArg, planArg].map(p => resolve(p));
if (existsSync(destination) || existsSync(output)) throw Error('use fresh plan and results paths');
const manifest = JSON.parse(readFileSync(resolve(fixture, 'manifest.json'), 'utf8'));
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
if (sha(manifest.image) !== manifest.imageSha256) throw Error('fixture image changed');
for (const [name, digest] of [['ordinary-fpm.wasm', manifest.ordinaryFpmSha256], ['translated-fpm.wasm', manifest.translatedFpmSha256]]) {
  if (sha(resolve(fixture, name)) !== digest) throw Error('fixture FPM changed: ' + name);
}
const inputs = {};
function remember(path) { const file = resolve(path); inputs[file] = sha(file); }
for (const file of [kernel, resolve(fixture, 'manifest.json'), manifest.image,
  resolve(fixture, 'ordinary-fpm.wasm'), resolve(fixture, 'translated-fpm.wasm'),
  resolve(profile, 'common-memory-profile.json'),
  'apps/browser-demos/lib/init/wordpress-runtime-config.ts',
  'apps/browser-demos/playwright-test.ts',
  'tools/common-memory-program/wordpress/playwright.config.ts',
  'apps/browser-demos/test/support/browser-memory-boundary.ts']) remember(file);
for (const directory of [profile, 'tools/common-memory-program/survey', 'tools/common-memory-program/impact']) {
  for (const name of readdirSync(directory).sort()) {
    if (['.mjs', '.ts'].includes(extname(name))) remember(resolve(directory, name));
  }
}
const trials = [];
for (const mode of ['timing', 'resource']) for (const host of ['node', 'chromium', 'firefox', 'webkit']) {
  for (const backend of ['sqlite', 'mariadb']) for (const cohort of [0, 1]) {
    const labels = ['native-file', 'vm-file', 'vm-shared'];
    if (cohort) labels.reverse();
    for (const [order, label] of labels.entries()) trials.push({id: `${mode}-${host}-${backend}-c${cohort}-${label}`, host, backend, label, mode, cohort, order});
  }
}
const plan = {fixture, profile, kernel, output,
  scope: 'Current PHP application latency and separate guest/OS backing observations. Two fresh parents per mode/host/backend/cache configuration; timestamp validation1/freq0; two workers; host caches not flushed; guest FILE cache empty at each start; ordinary means uninstrumented Wasm, not machine native.',
  trials, inputs};
writeFileSync(destination, JSON.stringify(plan, null, 2) + '\n', {flag: 'wx'});
console.log(destination, trials.length, 'fresh parents');
