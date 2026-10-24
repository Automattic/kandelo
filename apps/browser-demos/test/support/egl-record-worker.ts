import {createMainForwardChannel} from "../../../../host/src/webgl/main-forward";
import {createWasmPosixKernelTestHarness} from "../../../../host/src/kernel";
import {createKernelScratchTestInstance} from "../../../../host/test/support/kernel-scratch-instance";
import * as O from "../../../../host/src/webgl/ops";

// Replay accepted public-C operations. This adapter supplies the kernel's
// dispatch/identity role; real Rust guest marshalling remains a separate gate.
self.onmessage = ({data}) => {
  try {
    const forwarded=data.mode==="forwarded";
    const channels=new Map<number,ReturnType<typeof createMainForwardChannel>>();
    const sizes=new Map<number,{width:number;height:number}>();
    let currentSession:number|null=null;
    let gl:WebGL2RenderingContext|null=null;
    let native:ReturnType<typeof createWasmPosixKernelTestHarness>|null=null;
    let memory:WebAssembly.Memory|null=null;
    let imports:Record<string,(...args:any[])=>any>|null=null;
    const created:object[]=[],deleted:object[]=[],live:Array<()=>boolean>=[];
    if(!forwarded) {
      const canvas=data.canvas as OffscreenCanvas;
      gl=canvas.getContext("webgl2",{antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true});
      if(!gl)throw new Error("native worker WebGL2 unavailable");
      for(const [createName,deleteName,isName] of [
        ["createFramebuffer","deleteFramebuffer","isFramebuffer"],
        ["createTexture","deleteTexture","isTexture"],
        ["createRenderbuffer","deleteRenderbuffer","isRenderbuffer"],
      ]) {
        const api=gl as any,create=api[createName].bind(gl),destroy=api[deleteName].bind(gl),isLive=api[isName].bind(gl);
        api[createName]=()=>{const value=create();if(value){created.push(value);live.push(()=>isLive(value));}return value;};
        api[deleteName]=(value:object|null)=>{if(value)deleted.push(value);destroy(value);};
      }
      memory=new WebAssembly.Memory({initial:2,maximum:2});
      native=createWasmPosixKernelTestHarness({io:{} as any,callbacks:{getProcessMemory:()=>memory!},memory,pointerWidth:4,
        instance:createKernelScratchTestInstance(4,memory,()=>({}),()=>4096)});
      imports=(native.testAuthority.buildImportObject(memory) as {env:typeof imports}).env;
      native.gl.attachCanvas(7,canvas);
    }
    const requireZero=(rc:number,label:string)=>{if(rc!==0)throw new Error(`${label}: ${rc}`);};
    const channel=(fd:number)=>{const value=channels.get(fd);if(!value)throw new Error(`unknown session ${fd}`);return value;};
    const pixels=(fd:number)=>{
      const input=new Uint8Array(24),view=new DataView(input.buffer);
      [0,0,1,1,0x1908,0x1401].forEach((word,i)=>view.setUint32(i*4,word,true));
      if(forwarded) {
        const reply=channel(fd).onQuery!(O.QOP_READ_PIXELS,input,4);
        if(reply.rc!==4)throw new Error(`forwarded pixel read: ${reply.rc}`);
        return [...reply.bytes];
      }
      new Uint8Array(memory!.buffer,64,24).set(input);
      const rc=imports!.host_gl_query(7,O.QOP_READ_PIXELS,64,24,128,4,fd);
      if(rc!==4)throw new Error(`native pixel read: ${rc}`);
      return [...new Uint8Array(memory!.buffer,128,4)];
    };
    const frames=new Uint8Array(data.trace),view=new DataView(frames.buffer),observed:number[][]=[];
    const retiredContexts:number[]=[],retiredSurfaces:number[]=[];
    for(let offset=0;offset<frames.length;) {
      if(offset+12>frames.length)throw new Error("truncated trace header");
      const kind=view.getUint32(offset,true),fd=view.getUint32(offset+4,true),length=view.getUint32(offset+8,true);
      offset+=12;if(offset+length>frames.length)throw new Error("truncated trace payload");
      const bytes=frames.slice(offset,offset+length),words=new DataView(bytes.buffer);offset+=length;
      if(kind===1) {
        if(forwarded)channels.set(fd,createMainForwardChannel({postMessage:message=>postMessage(message)},7,fd));
        else imports!.host_gl_bind(7,4096,65536,fd);
      } else if(kind===2) {
        const id=words.getUint32(12,true);
        requireZero(forwarded?channel(fd).onCreateContext():imports!.host_gl_create_context(7,id,0,0,fd),"create context");
      } else if(kind===3) {
        const surfaceId=words.getUint32(32,true),width=words.getUint32(4,true),height=words.getUint32(8,true);
        sizes.set(surfaceId,{width,height});
        if(forwarded)requireZero(channel(fd).onCreateSurface!({surfaceId,kind:words.getUint32(0,true),width,height,
          configId:words.getUint32(12,true),targetBoId:words.getUint32(16,true)}).rc,"create surface");
        else {
          // The Rust kernel supplies the fresh identity separately and keeps
          // the output field zero in the host's private request copy.
          words.setUint32(32,0,true);new Uint8Array(memory!.buffer,64,bytes.length).set(bytes);
          requireZero(imports!.host_gl_create_surface(7,surfaceId,64,36,fd),"create surface");
        }
      } else if(kind===4) {
        const context=words.getUint32(0,true),draw=words.getUint32(4,true),read=words.getUint32(8,true);
        if(!context) {
          if(!forwarded)requireZero(imports!.host_gl_make_current(7,0,0,0,fd),"release");
          currentSession=null;
        } else {
          const size=sizes.get(draw)??{width:0,height:0};
          requireZero(forwarded?channel(fd).onMakeCurrent!({drawSurfaceId:draw,readSurfaceId:read,...size})
            :imports!.host_gl_make_current(7,context,draw,read,fd),"make current");
          // As in the kernel, displace the old binding only after acceptance.
          if(!forwarded && currentSession!==null && currentSession!==fd)
            requireZero(imports!.host_gl_make_current(7,0,0,0,currentSession),"release previous");
          currentSession=fd;
        }
      } else if(kind===5) {
        if(forwarded)channel(fd).onSubmit(bytes);
        else {
          new Uint8Array(memory!.buffer,4096,bytes.length).set(bytes);
          requireZero(imports!.host_gl_submit(7,0,bytes.length,fd),"submit");
        }
        let clear=false;
        for(let at=0;at<bytes.length;) {
          const op=words.getUint16(at,true),size=words.getUint16(at+2,true);at+=4+size;
          if(op===O.OP_CLEAR)clear=true;
        }
        if(clear)observed.push(pixels(fd));
      } else if(kind===6) {
        const id=words.getUint32(0,true);retiredContexts.push(id);
        if(forwarded)channel(fd).onDestroyContext!();else imports!.host_gl_destroy_context(7,id);
      } else if(kind===7) {
        const id=words.getUint32(0,true);retiredSurfaces.push(id);
        if(forwarded)channel(fd).onDestroySurface!(id);else imports!.host_gl_destroy_surface(7,id,fd);
      } else if(kind===8)requireZero(forwarded?channel(fd).onPresent!():imports!.host_gl_present(7,fd),"present");
      else if(kind===9) {
        if(forwarded) {
          channel(fd).onUnbind!(fd);
          if(channel(fd).onPresent!()!==-5)throw new Error("retired session revived");
        } else imports!.host_gl_unbind(7,fd);
      } else throw new Error(`unknown trace operation ${kind}`);
    }
    const clean=forwarded?null:created.length===deleted.length && created.every(value=>deleted.includes(value)) && live.every(isLive=>!isLive());
    postMessage({type:"egl_record_result",observed,retiredContexts,retiredSurfaces,clean,error:forwarded?0:gl!.getError()});
  } catch(error) {postMessage({type:"egl_record_failed",error:String(error)});}
};
