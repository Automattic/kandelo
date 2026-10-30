import {createMainForwardChannel} from "../../../../host/src/webgl/main-forward";
import {createWasmPosixKernelTestHarness} from "../../../../host/src/kernel";
import {createKernelScratchTestInstance} from "../../../../host/test/support/kernel-scratch-instance";
import * as O from "../../../../host/src/webgl/ops";

self.onmessage = ({data}) => {
  try {
    const gpu = data.mode === "retarget", forwarded = data.mode === "forwarded";
    let gl: WebGL2RenderingContext | null = null;
    let native: ReturnType<typeof createWasmPosixKernelTestHarness> | null = null;
    let memory: WebAssembly.Memory | null = null;
    let imports: Record<string,(...args:any[]) => any> | null = null;
    const created: object[] = [], deleted: object[] = [], live: Array<() => boolean> = [];
    if (!forwarded) {
      const canvas = data.canvas as OffscreenCanvas;
      gl = canvas.getContext("webgl2",{antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true});
      if (!gl) throw new Error("native worker WebGL2 unavailable");
      for (const [createName,deleteName,isName] of [
        ["createFramebuffer","deleteFramebuffer","isFramebuffer"],
        ["createTexture","deleteTexture","isTexture"],
        ["createRenderbuffer","deleteRenderbuffer","isRenderbuffer"],
      ]) {
        const api = gl as any, create = api[createName].bind(gl), destroy = api[deleteName].bind(gl), isLive = api[isName].bind(gl);
        api[createName] = () => {const value=create();if(value){created.push(value);live.push(() => isLive(value));}return value;};
        api[deleteName] = (value:object|null) => {if(value)deleted.push(value);destroy(value);};
      }
      memory = new WebAssembly.Memory({initial:2,maximum:2});
      native = createWasmPosixKernelTestHarness({io:{} as any,
        callbacks:{getProcessMemory:() => memory!},memory,pointerWidth:4,
        instance:createKernelScratchTestInstance(4,memory,() => ({}),() => 4096)});
      imports = (native.testAuthority.buildImportObject(memory) as {env:typeof imports}).env;
      native.gl.attachCanvas(7,canvas);
    }
    const channels = [11,12,13].map(session => createMainForwardChannel({postMessage:message => postMessage(message)},7,session));
    const requireZero = (rc:number,label:string) => { if (rc !== 0) throw new Error(`${label}: ${rc}`); };
    const current = (i:number,draw:number,read:number) => forwarded
      ? channels[i].onMakeCurrent!({drawSurfaceId:draw,readSurfaceId:read,width:draw ? 1 : 0,height:draw ? 1 : 0})
      : imports!.host_gl_make_current(7,21+i,draw,read,11+i);
    const submit = (i:number,bytes:Uint8Array) => {
      if (forwarded) channels[i].onSubmit(bytes);
      else {new Uint8Array(memory!.buffer,256,bytes.length).set(bytes); requireZero(imports!.host_gl_submit(7,0,bytes.length,11+i),"submit");}
    };
    const pixels = (i:number) => {
      const input = new Uint8Array(24), view = new DataView(input.buffer);
      [0,0,1,1,0x1908,0x1401].forEach((n,index) => view.setUint32(index*4,n,true));
      if (forwarded) {
        const reply = channels[i].onQuery!(O.QOP_READ_PIXELS,input,4);
        if (reply.rc !== 4) throw new Error(`read: ${reply.rc}`);
        return [...reply.bytes];
      }
      new Uint8Array(memory!.buffer,64,24).set(input);
      const rc = imports!.host_gl_query(7,O.QOP_READ_PIXELS,64,24,128,4,11+i);
      if (rc !== 4) throw new Error(`native read: ${rc}`);
      return [...new Uint8Array(memory!.buffer,128,4)];
    };
    const clear = (i:number,color:number[]) => {
      const bytes = new Uint8Array(28), view = new DataView(bytes.buffer);
      view.setUint16(0,O.OP_CLEAR_COLOR,true);view.setUint16(2,16,true);
      color.forEach((n,index) => view.setFloat32(4+index*4,n,true));
      view.setUint16(20,O.OP_CLEAR,true);view.setUint16(22,4,true);view.setUint32(24,0x4000,true);
      submit(i,bytes);
    };
    for (let i=0;i<3;i++) {
      if (forwarded) requireZero(channels[i].onCreateContext(),"create context");
      else {imports!.host_gl_bind(7,256,64,11+i,1n);requireZero(imports!.host_gl_create_context(7,21+i,0,0,11+i),"native context");}
      if (i<2) {
        if (forwarded) requireZero(channels[i].onCreateSurface!({surfaceId:71+i,kind:1,width:1,height:1,configId:1,targetBoId:0}).rc,"surface");
        else {
          if (gpu && i===0 && native!.gl.createGpuBo(37,gl!,1,1) === null) throw new Error("GPU BO creation failed");
          new Uint32Array(memory!.buffer,64,9).set([1,1,1,1,gpu && i===0 ? 37 : 0,0,0,0,0]);
          requireZero(imports!.host_gl_create_surface(7,71+i,64,36,11+i),"native surface");
        }
      }
    }
    requireZero(current(0,71,71),"first current"); clear(0,[1,0,0,1]); const red = pixels(0);
    requireZero(current(0,0,0),"first release");
    requireZero(current(1,72,72),"second current"); clear(1,[0,1,0,1]); const green = pixels(1);
    requireZero(current(1,0,0),"second release");
    requireZero(current(2,71,72),"independent draw/read");
    if (gpu) {
      if (native!.gl.createGpuBo(38,gl!,2,1) === null) throw new Error("replacement BO failed");
      new Uint32Array(memory!.buffer,64,8).set([1,0,0,1,38,0,0,0]);
      requireZero(imports!.host_gl_update_surface(7,71,64,32,11),"retarget");
      // This is the explicit host event emitted when the kernel drops the
      // former canonical BO hold. The Rust cases verify that ownership path.
      native!.gl.destroyGpuBo(37);
    }
    const bindZero = new Uint8Array(12), bindView = new DataView(bindZero.buffer);
    bindView.setUint16(0,O.OP_BIND_FRAMEBUFFER,true);bindView.setUint16(2,8,true);bindView.setUint32(4,0x8d40,true);
    submit(2,bindZero); clear(2,[0,0,1,1]); const independent = pixels(2);
    let blue: number[] | null = null;
    if (gpu) {requireZero(current(2,71,71),"retarget read");blue=pixels(2);requireZero(current(2,71,72),"restore separate read");}
    requireZero(forwarded ? channels[2].onPresent!() : imports!.host_gl_present(7,13),"present selected draw");
    let visible:number[] | null = null;
    if (!forwarded && !gpu) {
      const previous = gl!.getParameter(gl!.READ_FRAMEBUFFER_BINDING);
      gl!.bindFramebuffer(gl!.READ_FRAMEBUFFER,null);
      const pixel = new Uint8Array(4);gl!.readPixels(0,0,1,1,gl!.RGBA,gl!.UNSIGNED_BYTE,pixel);visible=[...pixel];
      gl!.bindFramebuffer(gl!.READ_FRAMEBUFFER,previous);
    }
    for (let i=0;i<2;i++) {
      if (forwarded) channels[i].onUnbind!(11+i); else imports!.host_gl_unbind(7,11+i);
    }
    const retained = pixels(2), rejected = current(2,71,72), afterRejected = pixels(2);
    requireZero(current(2,0,0),"release retained surfaces");
    if (forwarded) {
      channels[2].onUnbind!(13);
      // An acknowledged missing-session reply fences ordered cleanup.
      if (channels[2].onPresent!() !== -5) throw new Error("retired session revived");
    } else {
      imports!.host_gl_unbind(7,13);
      if (gpu) native!.gl.destroyGpuBo(38);
    }
    const clean = forwarded ? null : created.length === deleted.length && created.every(value => deleted.includes(value)) && live.every(isLive => !isLive());
    postMessage({type:"surface_routing_result",red,green,independent,blue,retained,rejected,afterRejected,visible,clean,
      error:forwarded ? 0 : gl!.getError()});
  } catch (error) {postMessage({type:"surface_routing_failed",error:String(error)});}
};
