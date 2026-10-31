/** Exact programs shared by native controls and ordinary guest entrypoints. */
const rows = [
  ['unset', undefined, '', '', 0, 1, true],
  ['zero', 0, '', '', 0, 0, true],
  ['assigned', 7, '', '', 7, 7, true],
  ['cleared', 7, 'process.exitCode = undefined;', '', 7, 1, true],
  ['explicit', undefined, '', 'process.exit(9);', 9, 9, true],
  ['fatal-sync', 7, '', "setInterval(() => {}, 1000);\nthrow Error('main-primary');", 1, 1, false],
  ['fatal-promise', 7, '', "setInterval(() => {}, 1000);\nPromise.resolve().then(() => { throw Error('main-primary'); });", 1, 1, false],
  ['fatal-timer', 7, '', "setInterval(() => {}, 1000);\nsetTimeout(() => { throw Error('main-primary'); }, 1);", 1, 1, false],
  ['fatal-changed', 7, 'process.exitCode = 8;', "throw Error('main-primary');", 1, 8, false],
  ['fatal-cleared', 7, 'process.exitCode = undefined;', "throw Error('main-primary');", 1, 1, false],
] as const;
export const nodeExitListenerCases = rows.map(([name, assigned, listener, body, eventStatus, status, secondary]) => ({
  name, status, secondary,
  marker: `node-exit-listener-${name}:${eventStatus}`,
  source: `
${assigned === undefined ? '' : `process.exitCode = ${assigned};`}
process.on('exit', code => {
  console.log('node-exit-listener-${name}:' + code);
  ${listener}
  throw Error('exit-listener-secondary');
});
process.on('exit', () => console.log('unexpected-second-exit'));
${body}
`,
}));
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export const nodeExitListenerCommand = `set -eu
mkdir -p /tmp/node-exit-listeners
` + nodeExitListenerCases.map(c => {
  const file = `/tmp/node-exit-listeners/${c.name}.cjs`;
  return `cat > ${quote(file)} <<'JS'\n${c.source}\nJS\n` + `
if node ${quote(file)} >/tmp/node-exit-listener.out 2>/tmp/node-exit-listener.err; then status=0; else status=$?; fi
if test "$status" -ne ${c.status}; then cat /tmp/node-exit-listener.out; cat /tmp/node-exit-listener.err >&2; exit 1; fi
test "$(cat /tmp/node-exit-listener.out)" = ${quote(c.marker)}
${c.secondary ? '' : '! '}grep -q 'Error: exit-listener-secondary' /tmp/node-exit-listener.err
${c.secondary ? '' : "grep -q 'main-primary' /tmp/node-exit-listener.err"}
printf '%s\\n' ${quote(c.marker)}
`;
}).join('');
export const nodeExitListenerExpected = nodeExitListenerCases.map(c => c.marker);
