import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeKernelHost } from '../../../../host/src/node-kernel-host';
import { runNpmCases } from './npm-consumer';
import { npmInventory, npmTestInputs } from './npm-test-inputs';
it('runs offline npm and the controlled guest registry through the installed package', async (context) => {
    const { image, kernel, inventory, identities } = await npmTestInputs();
    const result = await runNpmCases(image, kernel, inventory, options => new NodeKernelHost(options));
    const reportDirectory = process.env.KANDELO_TEST_REPORT_DIR;
    if (reportDirectory) {
        mkdirSync(reportDirectory, { recursive: true });
        writeFileSync(join(reportDirectory, 'npm-regression-receipt.json'), JSON.stringify({ identities, result }, null, 2) + '\n');
    }
    await context.annotate('npm regression receipt', { contentType: 'application/json', body: JSON.stringify({ identities, result }, null, 2) });
    expect(result.unrun).toEqual([]);
    expect(result.cases.map((row: any) => row.id)).toEqual(inventory.cases.map((row: any) => row.id));
    expect(result.cases).toHaveLength(10);
    expect(result.passed, JSON.stringify(result)).toBe(true);
}, npmInventory.limitsMs.outerRunner);
