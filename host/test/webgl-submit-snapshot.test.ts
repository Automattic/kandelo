import { expect, it } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel.js";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance.js";
import { setupMainForward, type GlForwardMessage } from "../src/webgl/main-forward.js";
import { createGlForwardQueryMailbox, prepareGlForwardQuery, waitForGlForwardQuery } from "../src/webgl/main-forward-query.js";
import { OP_CLEAR_COLOR } from "../src/webgl/ops.js";

function colors(): Uint8Array {
  const bytes = new Uint8Array(40), view = new DataView(bytes.buffer);
  for (const [index, color] of [[0,[1,0,0,1]], [1,[0,0,1,1]]] as const) {
    view.setUint16(index*20,OP_CLEAR_COLOR,true);view.setUint16(index*20+2,16,true);
    color.forEach((value,i)=>view.setFloat32(index*20+4+i*4,value,true));
  }
  return bytes;
}
function replaceSecond(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  [0,1,0,1].forEach((value,index)=>view.setFloat32(24+index*4,value,true));
}
function renderer(rewrite: () => void) {
  const observed: number[][] = [];
  const gl = new Proxy({
    getError: () => 0, getParameter: () => null, isContextLost: () => false,
    clearColor(...color: number[]) {
      observed.push(color);
      if (color[0] === 1 && color[3] === 1) rewrite();
    },
  },{get(target,key){return Reflect.get(target,key) ?? (()=>null);}}) as unknown as WebGL2RenderingContext;
  return { gl, observed };
}

it.each([4,8] as const)("native submission decodes its accepted snapshot after the guest rewrites a later record at width %d", width => {
  const memory = new WebAssembly.Memory({initial:2,maximum:2});
  const guest = new Uint8Array(memory.buffer,4096,40);guest.set(colors());
  const native = renderer(()=>replaceSecond(guest));
  const kernel = createWasmPosixKernelTestHarness({io:{},memory,pointerWidth:width,
    callbacks:{getProcessMemory:()=>memory},
    instance:createKernelScratchTestInstance(width,memory,()=>({}),()=>width===4?4096:4096n)});
  kernel.gl.bind({pid:7,sessionId:11,cmdbufAddr:4096,cmdbufLen:40});
  const binding = kernel.gl.get(7,11)!;binding.gl=native.gl;binding.contextId=1;
  const imports=kernel.testAuthority.buildImportObject(memory).env as Record<string,(...args:any[])=>any>;
  const ptr=(value:number)=>width===4?value:BigInt(value);
  try {
    expect(imports.host_gl_submit(7,ptr(0),ptr(40),11)).toBe(0);
    expect(native.observed.slice(-2)).toEqual([[1,0,0,1],[0,0,1,1]]);
    expect(new DataView(guest.buffer,guest.byteOffset,40).getFloat32(28,true)).toBe(1);
    expect(binding.cmdbufView?.buffer).toBe(memory.buffer);
  } finally {kernel.releaseProcessViews(7);}
});

it("main forwarding decodes an owned snapshot even when a renderer callback rewrites the delivered message", () => {
  const bytes=colors(),native=renderer(()=>replaceSecond(bytes));
  let listener: ((event:MessageEvent)=>void)|null=null;
  const worker={addEventListener(_type:"message",next:(event:MessageEvent)=>void){listener=next;},removeEventListener(){listener=null;}};
  const dispose=setupMainForward(worker,{width:1,height:1,getContext:()=>native.gl} as unknown as HTMLCanvasElement,7);
  const fire=(data:GlForwardMessage)=>listener!({data} as MessageEvent);
  try {
    const mailbox=createGlForwardQueryMailbox();prepareGlForwardQuery(mailbox,0);
    fire({type:"gl_forward_create_context",pid:7,sessionId:11,mailbox});expect(waitForGlForwardQuery(mailbox).rc).toBe(0);
    fire({type:"gl_forward_submit",pid:7,sessionId:11,bytes});
    expect(native.observed.slice(-2)).toEqual([[1,0,0,1],[0,0,1,1]]);
    expect(new DataView(bytes.buffer).getFloat32(28,true)).toBe(1);
  } finally {dispose();}
});
