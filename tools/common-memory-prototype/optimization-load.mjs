import { PROFILES } from './optimization-runtime.mjs';

export async function loadOptimizationModules(read) {
  const modules = Object.fromEntries(await Promise.all(['native', 'inline', 'helper'].map(async name =>
    [name, await WebAssembly.compile(await read(`${name}.wasm`))])));
  modules.profiles = Object.fromEntries(await Promise.all(PROFILES.map(async name =>
    [name, await WebAssembly.compile(await read(`optimization-${name}.wasm`))])));
  return modules;
}
