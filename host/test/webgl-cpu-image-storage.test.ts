import {expect, it} from "vitest";
import {GbmBoRegistry} from "../src/dri/registry";
import {CpuImageStorage, type CpuImageLayout} from "../src/webgl/cpu-image-storage";
import {GlContextRegistry} from "../src/webgl/registry";
import {registerImageSource} from "../src/webgl/image-storage";
import {foreignTextureGl} from "./support/foreign-texture-gl";

function renderer() {
  const f = foreignTextureGl(), gl = f.gl;
  const get = gl.getParameter.bind(gl), bind = gl.bindTexture.bind(gl);
  const textures = new Map<WebGLTexture, Uint8Array>();
  const fields = new Map<number, unknown>([[0x88ef,null],[0x88ed,null],[0xc02,0x8ce0],
    [0xcf5,8],[0xcf2,11],[0xcf3,2],[0xcf4,3],[0x9240,true],[0x9241,true],[0x9243,0x9244],
    [0xd05,8],[0xd02,7],[0xd04,3],[0xd03,2]]);
  let texture: WebGLTexture | null = null, readFailure = false;
  Object.assign(gl, {
    isContextLost: () => false,
    getParameter: (p: number) => fields.has(p) ? fields.get(p) : get(p),
    bindTexture: (target: number, value: WebGLTexture | null) => {bind(target,value);texture=value;},
    bindBuffer: (target: number, value: object | null) => fields.set(target === 0x88ec ? 0x88ef : 0x88ed,value),
    pixelStorei: (field: number, value: number) => fields.set(field,field === 0x9240 || field === 0x9241 ? !!value : value),
    readBuffer: (value: number) => fields.set(0xc02,value),
    texImage2D: (_target: number,_level: number,_internal: number,w: number,h: number) => {
      textures.set(texture!,new Uint8Array(w*h*4));
    },
    texSubImage2D: (_target: number,_level: number,_x: number,_y: number,_w: number,_h: number,
      _format: number,_type: number,bytes: Uint8Array) => {
      expect(fields.get(0x88ef)).toBeNull();
      expect([0xcf5,0xcf2,0xcf3,0xcf4,0x9240,0x9241,0x9243].map(p=>fields.get(p)))
        .toEqual([1,0,0,0,false,false,0]);
      textures.get(texture!)!.set(bytes);
    },
    readPixels: (_x: number,_y: number,_w: number,_h: number,_format: number,_type: number,bytes: Uint8Array) => {
      if (readFailure) throw new Error("readback rejected");
      const fbo = get(0x8caa) as object;
      bytes.set(textures.get(f.frames.get(fbo)!.get(0x8ce0) as WebGLTexture)!);
    },
  });
  return {...f,textures,fields,rejectRead: (value: boolean) => {readFailure=value;}};
}

function fixture() {
  const f = renderer(), registry = new GlContextRegistry(), images = new CpuImageStorage();
  registry.bind({pid:7,sessionId:11,cmdbufAddr:0,cmdbufLen:0});
  const b=registry.get(7,11)!;b.gl=f.gl;b.contextId=21;
  const memory = new WebAssembly.Memory({initial:1,maximum:1});
  let resolve = true;
  const store=new GbmBoRegistry({getProcessMemory:()=>resolve?memory:undefined});
  store.create({pid:7,bo_id:41,size:24,w:2,h:2,stride:12});
  store.pixelView(41)!.set(Uint8Array.from({length:24},(_,i)=>i));
  const layout: CpuImageLayout={width:1,height:2,format:0x34324241,pitch:12,offset:4};
  return {...f,b,store,images,layout,memory,
    prepare:()=>images.prepare(b,store,()=>{}),publish:()=>images.publish(b,store,()=>{}),
    resolve: (value:boolean)=>{resolve=value;}};
}

it("imports declared rows independently of BO geometry and restores native upload state",()=>{
  const f=fixture(), before=[...f.fields];
  const image=f.images.acquire(f.b,41,f.store,f.layout)!;
  expect(image).not.toBeNull();expect(f.prepare()).toBe(true);
  expect([...f.textures.get(image.tex)!]).toEqual([4,5,6,7,16,17,18,19]);
  expect([...f.fields]).toEqual(before);
  expect(f.images.acquire(f.b,41,f.store,f.layout)).toBe(image);
  expect(f.b.textures.size).toBe(0);
});

it.each([0x34325241,0x34325258,0x34324241,0x34324258])("decodes and writes back format %s without modifying padding or X bits",format=>{
  const f=fixture(), layout={...f.layout,format}, original=new Uint8Array(f.store.pixelView(41)!);
  const image=f.images.acquire(f.b,41,f.store,layout)!;
  expect(f.prepare()).toBe(true);
  const bgra=format===0x34325241||format===0x34325258,opaque=format===0x34325258||format===0x34324258;
  expect([...f.textures.get(image.tex)!].slice(0,4)).toEqual([bgra?6:4,5,bgra?4:6,opaque?255:7]);
  f.images.begin(f.b);f.textures.get(image.tex)!.set([100,101,102,103]);
  expect(f.publish()).toBe(true);
  const expected=new Uint8Array(original);expected.set([bgra?102:100,101,bgra?100:102,opaque?7:103],4);
  expect(f.store.pixelView(41)).toEqual(expected);
});

it("merges changed sibling pixels without an unchanged view erasing the writer",()=>{
  const f=fixture(), first=f.images.acquire(f.b,41,f.store,f.layout)!;
  const second=f.images.acquire(f.b,41,f.store,{...f.layout,format:0x34325241})!;
  expect(first.tex).not.toBe(second.tex);expect(f.prepare()).toBe(true);
  f.images.begin(f.b);f.textures.get(first.tex)!.set([100,101,102,103]);
  expect(f.publish()).toBe(true);expect([...f.store.pixelView(41)!].slice(4,8)).toEqual([100,101,102,103]);
  expect(f.prepare()).toBe(true);expect([...f.textures.get(second.tex)!].slice(0,4)).toEqual([102,101,100,103]);
});

it("keeps accepted native writes through failed readback before any CPU refresh",()=>{
  const f=fixture(), image=f.images.acquire(f.b,41,f.store,f.layout)!;
  expect(f.prepare()).toBe(true);f.images.begin(f.b);f.textures.get(image.tex)!.set([100,101,102,103]);
  f.rejectRead(true);expect(f.publish()).toBe(false);
  expect([...f.store.pixelView(41)!].slice(4,8)).toEqual([4,5,6,7]);
  expect(f.prepare()).toBe(false);expect([...f.textures.get(image.tex)!].slice(0,4)).toEqual([100,101,102,103]);
  f.rejectRead(false);expect(f.prepare()).toBe(true);
  expect([...f.store.pixelView(41)!].slice(4,8)).toEqual([100,101,102,103]);
});

it("retries failed publication without rereading native pixels or losing unrelated CPU writes",()=>{
  const f=fixture(), image=f.images.acquire(f.b,41,f.store,f.layout)!;
  expect(f.prepare()).toBe(true);f.images.begin(f.b);f.textures.get(image.tex)!.set([100,101,102,103]);
  const publish=f.store.publishDevicePixels.bind(f.store);let accept=false;
  f.store.publishDevicePixels=(...args)=>accept&&publish(...args);
  expect(f.publish()).toBe(false);f.rejectRead(true);f.store.pixelView(41)![0]=200;
  expect(f.prepare()).toBe(false);accept=true;expect(f.prepare()).toBe(true);
  expect(f.store.pixelView(41)![0]).toBe(200);
  expect([...f.store.pixelView(41)!].slice(4,8)).toEqual([100,101,102,103]);
});

it("refuses retiring storage and completes native cleanup after a rejected deletion",()=>{
  const f=fixture(), image=f.images.acquire(f.b,41,f.store,f.layout)!;
  expect(f.prepare()).toBe(true);f.control.failDelete=true;
  expect(f.images.retire(41)).toBe(false);expect(f.images.acquire(f.b,41,f.store,f.layout)).toBeNull();
  f.control.failDelete=false;expect(f.images.retire(41)).toBe(true);expect(f.alive.has(image.tex)).toBe(false);
});

it("distinguishes image-layout identities within one retained BO",()=>{
  const f=fixture(), texture={} as WebGLTexture;
  expect(registerImageSource(f.b,41,texture,1,2,"rgba:0")).toBe(1);
  expect(registerImageSource(f.b,41,texture,1,2,"rgba:0")).toBe(1);
  expect(registerImageSource(f.b,41,texture,1,2,"bgra:4")).toBe(2);
  expect(f.b.imageSources.size).toBe(2);
});

it("restores implicit alpha one after rendering to an XRGB view",()=>{
  const f=fixture(), image=f.images.acquire(f.b,41,f.store,{...f.layout,format:0x34325258})!;
  expect(f.prepare()).toBe(true);f.images.begin(f.b);f.textures.get(image.tex)!.set([100,101,102,10]);
  expect(f.publish()).toBe(true);expect(f.prepare()).toBe(true);
  expect([...f.textures.get(image.tex)!].slice(0,4)).toEqual([100,101,102,255]);
  expect(f.store.pixelView(41)![7]).toBe(7);
});
