import base from '../../../../apps/browser-demos/playwright.config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export default {
    ...base,
    testDir: dirname(fileURLToPath(import.meta.url)),
    testMatch: 'npm-browser.spec.ts',
    retries: 0,
    workers: 1,
    projects: base.projects?.filter(project => ['chromium', 'firefox', 'webkit'].includes(project.name)),
    webServer: {
        ...base.webServer,
        cwd: fileURLToPath(new URL('../../../../apps/browser-demos/', import.meta.url)),
    },
};
