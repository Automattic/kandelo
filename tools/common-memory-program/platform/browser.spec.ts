import {test,expect} from '../../../tests/playwright-test';
import {serve} from './server.mjs';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
test('virtualized PHP-FPM shared OPcache across real fork workers',async ({page,browser},testInfo)=>{
  const profile=resolve(process.env.KANDELO_COMMON_MEMORY_PROFILE!);
  const artifact=resolve(process.env.KANDELO_COMMON_MEMORY_FPM!);
  const output=resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!);
  const server=await serve(profile,artifact);
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.stack||String(error)));
  try {
    await page.goto(server.url);
    await page.waitForFunction(()=>typeof (window as any).run==='function');
    const result=await page.evaluate(()=> (window as any).run('shared'));
    await writeFile(resolve(output,`php-fpm-${testInfo.project.name}.json`),JSON.stringify({...result,version:browser.version(),pageErrors:errors},null,2)+'\n');
    expect(errors).toEqual([]);expect(result.error).toBeUndefined();expect(result.passed).toBe(true);expect(result.destroyed).toBe(true);
  } finally {await server.close();}
});
