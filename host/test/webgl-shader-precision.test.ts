import { expect, it, vi } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";

function fixture() {
  let error = 0;
  const getShaderPrecisionFormat = vi.fn((): WebGLShaderPrecisionFormat | null =>
    ({rangeMin:127,rangeMax:127,precision:23}));
  const registry = new GlContextRegistry();
  registry.bind({pid:1,cmdbufAddr:0,cmdbufLen:4096});
  const binding = registry.get(1)!;
  binding.gl = {getShaderPrecisionFormat, getError: () => {
    const value=error; error=0; return value;
  }} as unknown as WebGL2RenderingContext;
  const query = (shader:number, precision:number, inputLength=8, outputLength=16) => {
    const input=new Uint8Array(inputLength), output=new Uint8Array(outputLength).fill(0xcc);
    const view=new DataView(input.buffer);
    if (inputLength>=4) view.setUint32(0,shader,true);
    if (inputLength>=8) view.setUint32(4,precision,true);
    const result=runGlQuery(binding,O.QOP_GET_SHADER_PRECISION_FORMAT,input,output.subarray(0,Math.min(12,outputLength)));
    return {result,output};
  };
  return {binding,getShaderPrecisionFormat,query,setError:(value:number) => {error=value;}};
}

it.each([0x8b30,0x8b31].flatMap(shader =>
  [0x8df0,0x8df1,0x8df2,0x8df3,0x8df4,0x8df5].map(precision => [shader,precision])))
("returns native precision for shader %i and format %i without touching neighboring bytes", (shader,precision) => {
  const f=fixture(), {result,output}=f.query(shader,precision);
  expect(result).toBe(12);
  expect([...new Int32Array(output.buffer,0,3)]).toEqual([127,127,23]);
  expect([...output.subarray(12)]).toEqual([0xcc,0xcc,0xcc,0xcc]);
  expect(f.getShaderPrecisionFormat).toHaveBeenCalledExactlyOnceWith(shader,precision);
  expect(f.binding.errors).toEqual([]);
});

it.each([[0,0x8df2],[0x1406,0x8df2],[0xffffffff,0x8df2],[0x8b31,0],[0x8b30,0x1406],[0x8b30,0xffffffff]])
("preserves output and reports INVALID_ENUM for shader %i and format %i", (shader,precision) => {
  const f=fixture(), {result,output}=f.query(shader,precision);
  expect(result).toBeLessThan(0);
  expect([...output]).toEqual(Array(16).fill(0xcc));
  expect(f.getShaderPrecisionFormat).not.toHaveBeenCalled();
  expect(f.binding.errors).toEqual([0x500]);
});

it.each(["native error","native exception","missing native result"] as const)
("preserves precision output on %s", failure => {
  const f=fixture();
  f.getShaderPrecisionFormat.mockImplementation(() => {
    if (failure==="native exception") throw new Error("driver refused");
    if (failure==="native error") f.setError(0x505);
    return failure==="missing native result" ? null : {rangeMin:127,rangeMax:127,precision:23};
  });
  const {result,output}=f.query(0x8b30,0x8df2);
  expect(result).toBeLessThan(0);
  expect([...output]).toEqual(Array(16).fill(0xcc));
  expect(f.binding.errors).toEqual([failure==="native error" ? 0x505 : 0x502]);
});

it("preserves previously pending native errors while returning a valid precision", () => {
  const f=fixture(); f.setError(0x501);
  const {result,output}=f.query(0x8b31,0x8df0);
  expect(result).toBe(12);
  expect([...new Int32Array(output.buffer,0,3)]).toEqual([127,127,23]);
  expect(f.binding.errors).toEqual([0x501]);
});

it("preserves the valid zero result for unsupported fragment high precision", () => {
  const f=fixture(); f.getShaderPrecisionFormat.mockReturnValue({rangeMin:0,rangeMax:0,precision:0});
  const {result,output}=f.query(0x8b30,0x8df2);
  expect(result).toBe(12);
  expect([...new Int32Array(output.buffer,0,3)]).toEqual([0,0,0]);
  expect(f.binding.errors).toEqual([]);
});

it.each([[7,12],[8,11]])("refuses malformed capacities %i/%i without a native query", (inputLength,outputLength) => {
  const f=fixture(), {result,output}=f.query(0x8b30,0x8df2,inputLength,outputLength);
  expect(result).toBe(-22);
  expect([...output]).toEqual(Array(outputLength).fill(0xcc));
  expect(f.getShaderPrecisionFormat).not.toHaveBeenCalled();
  expect(f.binding.errors).toEqual([]);
});
