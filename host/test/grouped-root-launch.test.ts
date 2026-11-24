import { beforeAll, afterAll, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { groupedRootLaunchFixture } from './support/grouped-root-launch-fixture';
import { resolveBinary } from '../src/binary-resolver';
const root = resolve(import.meta.dirname, '../..');
let directory: string, image: string;
beforeAll(async () => { directory = mkdtempSync(join(root, '.scratch/grouped-root-node-')); image = join(directory, 'rootfs.vfs'); writeFileSync(image, await groupedRootLaunchFixture()); }, 90000);
afterAll(() => { if (directory)
    rmSync(directory, { recursive: true, force: true }); });
for (const stage of ['registration-before', 'registration-after', 'constructor', 'stopped-constructor', 'readiness', 'launch-message', 'stopped-destroy', 'destroy-in-registration'])
    it(stage, async () => {
        const registration = new URL('../node_modules/tsx/dist/esm/api/index.mjs', import.meta.url).href;
        const entry = new URL('./fixtures/grouped-root-launch-node-worker.ts', import.meta.url).href;
        const worker = new Worker(`import{register}from ${JSON.stringify(registration)};register();await import(${JSON.stringify(entry)});`, { eval: true, workerData: { stage, kernel: resolveBinary('kernel.wasm'), image } });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const r: any = await new Promise((yes, no) => {
                timer = setTimeout(() => no(Error('kernel Worker deadline')), 75000);
                worker.once('message', yes);
                worker.once('error', no);
                worker.once('exit', code => no(Error('worker exit ' + code)));
            });
            if (process.env.KANDELO_ROOT_CUSTODY_EVIDENCE) {
                mkdirSync(process.env.KANDELO_ROOT_CUSTODY_EVIDENCE, { recursive: true });
                writeFileSync(join(process.env.KANDELO_ROOT_CUSTODY_EVIDENCE, stage + '.json'), JSON.stringify(r, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
            }
            if (['constructor', 'stopped-constructor', 'readiness', 'launch-message'].includes(stage)) {
                expect(r.fatal).toBe('Grouped process launch failed; storage retained');
                expect(r.constructionAttempts).toBe(1);
                expect(r.fatalLedger.kernel).toMatchObject({ processes: 1, images: 1, tasks: 1 });
                expect(r.fatalLedgerObserved).toBe('before-fatal-latch');
                expect(r.inspectionRefusal).toBe('Error: Grouped process launch failed; storage retained');
                return;
            }
            expect(r.failure, JSON.stringify(r)).toBeUndefined();
            expect(r.diagnostics).toEqual([]);
            expect(r.stderr).toBe('');
            expect(r.kernel).toMatchObject({ processes: 0, images: 0, tasks: 0 });
            expect(r.backing).toMatchObject({ allocatedPages: 1, images: 0, replicas: 0 });
            expect(r.rootReceipt).toBe(-3);
            if (stage.startsWith('registration-')) {
                expect(r.injected).toBe(16);
                expect(r.code).toBe(0);
                expect(r.stdout).toContain('grouped-sdk-fork PASS');
                for (const row of r.rollbacks) {
                    expect(row.kernel).toMatchObject({ processes: 0, images: 0, tasks: 0 });
                    expect(row.backing).toMatchObject({ allocatedPages: 1, images: 0, replicas: 0 });
                    expect(row.receipt).toBe(-3);
                }
            }
            else {
                expect(r.code).toBe(137);
                if (stage === 'stopped-destroy')
                    expect(r.constructionAttempts).toBe(0);
            }
        }
        finally {
            clearTimeout(timer);
            await worker.terminate();
        }
    }, 90000);
