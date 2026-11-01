import {expect,test} from '@playwright/test';
import {nodeSocketTimeoutCommand,nodeSocketTimeoutExpected} from '../../../host/test/fixtures/node-socket-timeouts';
import {gotoMachine} from './support/kandelo-machine';
import {runTerminalCommand} from './support/terminal-command';
test('Node socket inactivity, activity refresh, cancellation and unref',async({page})=>{
 test.setTimeout(180_000);await gotoMachine(page,'shell');
 await expect.poll(()=>page.locator('.xterm-rows').first().textContent(),{timeout:120_000}).toContain('kandelo$');
 const result=await runTerminalCommand(page,nodeSocketTimeoutCommand,undefined,120_000);
 expect(result.exitCode).toBe(0);for(const marker of nodeSocketTimeoutExpected)expect(result.output).toContain(marker);
});
