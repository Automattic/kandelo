/** Exit-code absence and exit-event status follow the Node 22.0 target. */
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
if (mode === 'zero') process.exitCode = 0;
if (mode === 'assigned') process.exitCode = 7;
if (mode === 'cleared') { process.exitCode = 7; process.exitCode = undefined; }
if (mode === 'listener') process.on('exit', () => { process.exitCode = 7; });
if (mode === 'listener-clear') { process.exitCode = 7; process.on('exit', () => { process.exitCode = undefined; }); }
JS
cp /tmp/node-process-exit.cjs /tmp/node-process-exit.mjs
node /tmp/node-process-exit.mjs esm
for mode in unset immediate zero cleared listener-clear; do node /tmp/node-process-exit.cjs "$mode"; done
for mode in assigned listener; do
if node /tmp/node-process-exit.cjs "$mode"; then
  printf 'assigned exit status was lost\\n' >&2
  exit 1
else
  status=$?
  test "$status" -eq 7
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
  'node-process-exit:assigned:7:7',
  'node-process-exit:listener:0:undefined',
  'node-process-exit:listener-clear:7:7',
];
