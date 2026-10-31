/** Default fatal exits must not drain timers or lose thrown callback values. */
const definitions = [
  ['cjs', '.cjs', 1, `throw Error('fatal cjs');`],
  ['eval', 'eval', 1, `throw Error('fatal eval');`],
  ['esm', '.mjs', 1, `throw Error('fatal esm');`],
  ['rejection', '.cjs', 1, `Promise.resolve().then(() => { throw Error('fatal rejection'); });`],
  ['esm-await', '.mjs', 1, `await Promise.reject(false);`],
  ['timer', '.cjs', 1, `setTimeout(() => { throw Error('fatal timer'); }, 5);`],
  ['zero-timer', '.cjs', 1, `setTimeout(() => { throw Error('fatal zero timer'); }, 0);`],
  ['caught-checkpoint', '.cjs', 7, `
    let caught = false;
    const rejected = Promise.reject(Error('handled during this checkpoint'));
    queueMicrotask(() => { rejected.catch(() => { caught = true; }); });
    setTimeout(() => {
      if (!caught) throw Error('same-checkpoint rejection handler did not run');
      finished = true; clearInterval(pending);
    }, 5);
  `],
  ['assigned-code', '.cjs', 7, `setTimeout(() => { finished = true; clearInterval(pending); }, 5);`],
] as const;

export const nodeFatalExitCases = definitions.map(([name, extension, status, body]) => ({
  name, extension, status, marker: `node-fatal-exit-${name}:${status}`,
  source: `
process.exitCode = 7;
let finished = false;
process.on('exit', code => {
  if (code !== ${status}) throw Error('wrong exit-event status: ' + code);
  if (${status} === 7 && !finished) throw Error('nonfatal work was not completed');
  console.log('node-fatal-exit-${name}:' + code);
});
const pending = setInterval(() => {}, 1000);
${body}
`,
}));

function quote(text: string) { return `'${text.replace(/'/g, `'"'"'`)}'`; }
export const nodeFatalExitCommand = 'set -eu\nmkdir -p /tmp/node-fatal-exit\n' +
  nodeFatalExitCases.map(c => {
    const file = `/tmp/node-fatal-exit/${c.name}${c.extension}`;
    const prepare = c.extension === 'eval' ? '' : `cat > ${quote(file)} <<'JS'\n${c.source}\nJS\n`;
    const args = c.extension === 'eval' ? '-e ' + quote(c.source) : quote(file);
    return prepare + `
if node ${args} > /tmp/node-fatal.out 2>/tmp/node-fatal.err; then status=0; else status=$?; fi
if test "$status" -ne ${c.status}; then cat /tmp/node-fatal.out; cat /tmp/node-fatal.err >&2; exit 1; fi
test "$(cat /tmp/node-fatal.out)" = ${quote(c.marker)}
printf '%s\\n' ${quote(c.marker)}
`;
  }).join('');
export const nodeFatalExitExpected = nodeFatalExitCases.map(c => c.marker);
