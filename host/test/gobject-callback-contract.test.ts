import {execFileSync} from "node:child_process";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {describe,expect,it} from "vitest";
import {resolveBinary} from "../src/binary-resolver";
import {runCentralizedProgram} from "./centralized-test-helper";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const programs=new Map<string,string>();
function program(name:string):string {
 let path=programs.get(name);
 if(!path){
  const own=process.env.WASM_POSIX_XTASK_BIN;
  const mirror=execFileSync(own??"cargo",[
   ...(own?[]:["xtask"]),"build-deps","--arch","wasm32","output-path",
   "gobject-callback-tests",`gobject-${name}.wasm`,
  ],{cwd:root,encoding:"utf8"}).trim();
  path=resolveBinary(`programs/wasm32/${mirror}`);programs.set(name,path);
 }
 return path;
}
const modes=["ffi-raw","generic-value","generic-va","swapped-value","swapped-va","vtable-value","vtable-va"];
describe("actual GObject/libffi callback ABI boundaries",()=>{
 for(const mode of modes)for(let which=0;which<7;which++){
  it(`${mode} result ${which}`,async()=>{
   const result=await runCentralizedProgram({programPath:program("contract"),
    argv:["/bin/gobject-contract",mode,String(which)],env:[],useDefaultRootfs:false,timeout:20_000});
   expect(result.exitCode,`${result.stdout}\n${result.stderr}`).toBe(0);
   expect(result.stdout).toContain(`GOBJECT_CALLBACK_OK ${mode} ${which}`);
   expect(result.hostDiagnostics).toEqual([]);
  },30_000);
 }
 for(const mode of ["signal-object-value","signal-object-va","signal-realize-value","signal-realize-va"])
  for(let route=0;route<3;route++){
   it(`${mode} ${["class-only","normal","swapped"][route]}`,async()=>{
    const result=await runCentralizedProgram({programPath:program("contract"),
     argv:["/bin/gobject-contract",mode,String(route)],env:[],useDefaultRootfs:false,timeout:20_000});
    expect(result.exitCode,`${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`GOBJECT_CALLBACK_OK ${mode} ${route}`);
    expect(result.hostDiagnostics).toEqual([]);
   },30_000);
  }
 it("GSource closure ref/dispatch/unref",async()=>{
  const result=await runCentralizedProgram({programPath:program("contract"),
   argv:["/bin/gobject-contract","source-closure"],env:[],useDefaultRootfs:false,timeout:20_000});
  expect(result.exitCode,`${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("GOBJECT_CALLBACK_OK source-closure");
  expect(result.hostDiagnostics).toEqual([]);
 },30_000);
});

describe("pinned upstream GObject CPU tests with original assertions",()=>{
 for(const name of ["type","basic-signals","signals","closure","defaultiface","dynamictype","accumulator","object","references","signal-handler"]){
  it(name,async()=>{
   const guest=`/bin/gobject-${name}`;
   const result=await runCentralizedProgram({programPath:program(name),argv:[guest,"--tap"],
    env:["G_TEST_BUILDDIR=/bin"],execPrograms:new Map([[guest,program(name)]]),
    useDefaultRootfs:false,timeout:60_000});
   expect(result.exitCode,`${result.stdout}\n${result.stderr}`).toBe(0);
   expect(result.stdout).not.toMatch(/^not ok\b/m);
   expect(result.stdout).toMatch(/^1\.\.[1-9]/m);
   expect(result.hostDiagnostics).toEqual([]);
  },80_000);
 }
});
