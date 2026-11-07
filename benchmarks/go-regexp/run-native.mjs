import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const outputDir = resolve(process.argv[2] ?? '.context/go-regexp-evaluation');
const cases = (process.env.REGEXP_BENCH_CASES ?? 'literal,literal-text,class,capture,bounded-lazy,url').split(',');
const rounds = Number(process.env.REGEXP_BENCH_ROUNDS ?? 3);
if (!Number.isInteger(rounds) || rounds < 1) throw Error('REGEXP_BENCH_ROUNDS must be a positive integer');
const rows = [];
for (const host of ['native', 'node-wasi']) {
    for (let round = 0; round < rounds; round++) {
        for (const name of cases) {
            const order = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
            for (const variant of order) {
                const path = resolve(outputDir, 'bench-' + variant + (host === 'native' ? '-native' : '-wasi.wasm'));
                const command = host === 'native' ? path : process.execPath;
                const args = host === 'native' ? [] : [fileURLToPath(new URL('./run-node-wasi.mjs', import.meta.url)), path, name];
                const output = execFileSync(command, args, { encoding: 'utf8', env: { ...process.env, REGEXP_BENCH_CASE: name, GOMAXPROCS: '1' }, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
                const result = JSON.parse(output);
                rows.push({ host, round, name, variant, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), result });
                writeFileSync(resolve(outputDir, 'native-benchmarks.json'), JSON.stringify({ scope: 'Fresh child per row; compilation only; same source/compiler except regexp traversal; GOMAXPROCS=1; alternating order', node: process.version, rows }, null, 2) + '\n');
                console.log(JSON.stringify({ host, round, name, variant, nsPerOp: result.Samples.map(s => s.DurationNs / result.N) }));
            }
        }
    }
}
