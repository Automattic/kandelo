/** Exit-code absence and exit-event status follow the Node compatibility target. */
export const nodeProcessExitCommand = `
set -eu
cat > /tmp/node-process-exit.cjs <<'JS'
const mode = process.argv[2];
if (process.exitCode !== undefined) throw Error('exitCode must start unset');
process.on('exit', status => {
  if (typeof status !== 'number') throw Error('exit event requires a numeric status');
  console.log('node-process-exit:' + mode + ':' + status + ':' + String(process.exitCode));
});
if (mode === 'immediate') process.exit();
if (mode === 'null') { process.exitCode = 7; process.exitCode = null; }
if (mode === 'explicit-null') { process.exitCode = 7; process.exit(null); }
if (mode === 'explicit-undefined') { process.exitCode = 7; process.exit(undefined); }
if (mode === 'validate') {
  for (const [value, expected] of [['7',7], ['  ',0], [4294967296,0], [null,undefined], [undefined,undefined]]) {
    process.exitCode = value;
    if (process.exitCode !== expected) throw Error('exitCode coercion: '+String(value));
  }
  for (const [value, code] of [[true,'ERR_INVALID_ARG_TYPE'], ['', 'ERR_INVALID_ARG_TYPE'], ['bad', 'ERR_INVALID_ARG_TYPE'], [{}, 'ERR_INVALID_ARG_TYPE'], [1.5,'ERR_OUT_OF_RANGE'], [NaN,'ERR_OUT_OF_RANGE'], [Infinity,'ERR_OUT_OF_RANGE'], [Number.MAX_SAFE_INTEGER + 1,'ERR_OUT_OF_RANGE']]) {
    let error;
    try { process.exitCode = value; } catch (e) { error = e; }
    if (!error || error.code !== code || process.exitCode !== undefined) throw Error('exitCode validation: '+String(value));
  }
}
if (mode === 'zero') process.exitCode = 0;
if (mode === 'assigned') process.exitCode = 7;
if (mode === 'cleared') { process.exitCode = 7; process.exitCode = undefined; }
if (mode === 'listener') process.on('exit', () => { process.exitCode = 7; });
if (mode === 'listener-clear') { process.exitCode = 7; process.on('exit', () => { process.exitCode = undefined; }); }
if (mode.startsWith('uncaught-')) { process.exitCode = 7; throw Error('expected file failure'); }
if (mode.startsWith('falsy-')) {
  process.exitCode = 7;
  throw ({ undefined: undefined, null: null, zero: 0, false: false, empty: '' })[mode.slice(6)];
}
JS
cp /tmp/node-process-exit.cjs /tmp/node-process-exit.mjs
node /tmp/node-process-exit.mjs esm
for mode in unset immediate zero cleared null explicit-null explicit-undefined validate; do node /tmp/node-process-exit.cjs "$mode"; done
for mode in assigned listener listener-clear; do
if node /tmp/node-process-exit.cjs "$mode"; then
  printf 'assigned exit status was lost\\n' >&2
  exit 1
else
  status=$?
  test "$status" -eq 7
fi
done
node -e "process.on('exit', code => console.log('node-eval-exit:unset:' + code + ':' + String(process.exitCode)))"
node -e "let done = 0; process.on('exit', code => { if (done !== 3) throw Error('exit before jobs'); console.log('node-eval-exit:jobs:' + code); }); Promise.resolve().then(() => { done |= 1; console.log('node-eval-job-done'); }); setTimeout(() => { done |= 2; console.log('node-eval-timer-done'); }, 10)"
node -e "process.on('exit', code => console.log('node-eval-exit:explicit:' + code)); process.exit()"
if node -e "process.exitCode = 7; process.on('exit', code => { console.log('node-eval-exit:clear:' + code); process.exitCode = undefined; })"; then
  exit 1
else
  status=$?
  test "$status" -eq 7
fi
if node -e "process.on('exit', code => { console.log('node-eval-exit:override:' + code); process.exitCode = 7; })"; then
  exit 1
else
  status=$?
  test "$status" -eq 7
fi
if node -e "process.exitCode = 7; process.on('exit', code => console.log('node-eval-exit:uncaught:' + code + ':' + process.exitCode)); throw Error('expected failure')" 2>/tmp/node-eval-uncaught.err; then
  exit 1
else
  status=$?
  test "$status" -eq 1
fi
for extension in cjs mjs; do
if node "/tmp/node-process-exit.$extension" "uncaught-$extension" 2>/tmp/node-file-uncaught.err; then
  exit 1
else
  status=$?
  test "$status" -eq 1
fi
done
for value in undefined null zero false empty; do
if node /tmp/node-process-exit.mjs "falsy-$value" 2>/tmp/node-file-falsy.err; then
  exit 1
else
  status=$?
  test "$status" -eq 1
fi
done
printf 'node-process-exit-complete\\n'
`;
export const nodeProcessExitExpected = [
  'node-process-exit:esm:0:undefined',
  'node-process-exit:unset:0:undefined',
  'node-process-exit:immediate:0:undefined',
  'node-process-exit:zero:0:0',
  'node-process-exit:cleared:0:undefined',
  'node-process-exit:null:0:undefined',
  'node-process-exit:explicit-null:0:undefined',
  'node-process-exit:explicit-undefined:0:undefined',
  'node-process-exit:validate:0:undefined',
  'node-process-exit:assigned:7:7',
  'node-process-exit:listener:0:undefined',
  'node-process-exit:listener-clear:7:7',
  'node-eval-exit:unset:0:undefined',
  'node-eval-job-done',
  'node-eval-timer-done',
  'node-eval-exit:jobs:0',
  'node-eval-exit:explicit:0',
  'node-eval-exit:clear:7',
  'node-eval-exit:override:0',
  'node-eval-exit:uncaught:1:1',
  'node-process-exit:uncaught-cjs:1:1',
  'node-process-exit:uncaught-mjs:1:1',
  'node-process-exit:falsy-undefined:1:1',
  'node-process-exit:falsy-null:1:1',
  'node-process-exit:falsy-zero:1:1',
  'node-process-exit:falsy-false:1:1',
  'node-process-exit:falsy-empty:1:1',
];
