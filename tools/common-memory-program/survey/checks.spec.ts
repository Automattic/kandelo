import {test,expect} from '../../../tests/playwright-test';
import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {serve} from '../server.mjs';
for(const mode of (process.env.KANDELO_SURVEY_MODES??'baseline,baseline-conditional,scalar,scalar-conditional').split(',')) {
  test(`checked access forms: ${mode}`,async({page,browser},info)=>{
    const root=resolve(process.env.KANDELO_SURVEY_VARIANTS!);
    const manifest=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
    const artifacts=manifest.variants[mode].artifacts;
    const fixture=resolve(root,'browser-fixtures',mode);
    await mkdir(fixture,{recursive:true});
    await copyFile(artifacts.canary.path,resolve(fixture,'canary-vm.wasm'));
    await copyFile(artifacts.access.path,resolve(fixture,'access-vm.wasm'));
    if(artifacts.bounds)await copyFile(artifacts.bounds.path,resolve(fixture,'bounds-vm.wasm'));
    if(artifacts.atomic) {await copyFile(artifacts.atomic.path,resolve(fixture,'atomic-vm.wasm'));await copyFile(resolve(root,'atomic-native.wasm'),resolve(fixture,'atomic-native.wasm'));}
    if(artifacts.regional)await copyFile(artifacts.regional.path,resolve(fixture,'regional-vm.wasm'));
    if(artifacts.objects) {
      await copyFile(artifacts.objects.path,resolve(fixture,'objects-vm.wasm'));
      await copyFile(manifest.guardHelper.path,resolve(fixture,'object-helper.wasm'));
    }
    const server=await serve(fixture);
    try {
      await page.goto(server.url);
      await page.waitForFunction(()=>typeof(window as any).run==='function');
      const result=await page.evaluate(options=>(window as any).run(options),{bounds:!!artifacts.bounds,objects:!!artifacts.objects,atomics:!!artifacts.atomic,regional:!!artifacts.regional,regionalDiagnostics:!!artifacts.regional?.guardCounters});
      await writeFile(resolve(process.env.KANDELO_COMMON_MEMORY_ARTIFACTS!,`${info.project.name}-${mode}.json`),
        JSON.stringify({mode,version:browser.version(),...result},null,2)+'\n');
      expect(result.passed).toBe(true);expect(result.crossOriginIsolated).toBe(true);
      if(artifacts.bounds)expect(result.bounds.passed).toBe(true);
      if(artifacts.atomic){expect(result.atomics.passed).toBe(true);expect(result.atomics.forms).toBe(56);}
      if(artifacts.regional)expect(result.regional.passed).toBe(true);
      if(artifacts.objects)expect(result.objects.passed).toBe(true);
    } finally {await server.close();}
  });
}
