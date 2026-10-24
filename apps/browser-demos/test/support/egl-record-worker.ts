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
        ...(data.peerDelete?[["createBuffer","deleteBuffer","isBuffer"],["createVertexArray","deleteVertexArray","isVertexArray"]]:[]),
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
    const submit=(fd:number,bytes:Uint8Array)=>{
      if(forwarded)channel(fd).onSubmit(bytes);
      else {new Uint8Array(memory!.buffer,4096,bytes.length).set(bytes);requireZero(imports!.host_gl_submit(7,0,bytes.length,fd),"submit");}
    };
    const send=(fd:number,op:number,words:number[],tail=new Uint8Array())=>{
      const bytes=new Uint8Array(4+words.length*4+tail.length),v=new DataView(bytes.buffer);
      v.setUint16(0,op,true);v.setUint16(2,words.length*4+tail.length,true);
      words.forEach((word,i)=>v.setUint32(4+i*4,word,true));bytes.set(tail,4+words.length*4);submit(fd,bytes);
    };
    let sourceContext=0,sourceDraw=0,sourceRead=0,captured=false,injected=false;
    const peer=90;
    const make=(fd:number,id:number,draw:number,read:number)=>{
      const size=sizes.get(draw)??{width:0,height:0};
      requireZero(forwarded?channel(fd).onMakeCurrent!({drawSurfaceId:draw,readSurfaceId:read,...size})
        :imports!.host_gl_make_current(7,id,draw,read,fd),"driver current");
    };
    const prepareProgram=(fd:number)=>{
      for(const [name,type,text] of [[901,0x8b31,"attribute vec4 color; attribute vec2 position; varying vec4 c; void main(){c=color;gl_Position=vec4(position,0.,1.);gl_PointSize=1.;}"],
        [902,0x8b30,"precision mediump float; varying vec4 c; void main(){gl_FragColor=c;}"]] as [number,number,string][]) {
        const bytes=new TextEncoder().encode(text);send(fd,O.OP_CREATE_SHADER,[type,name]);
        send(fd,O.OP_SHADER_SOURCE,[name,bytes.length],bytes);send(fd,O.OP_COMPILE_SHADER,[name]);
      }
      send(fd,O.OP_CREATE_PROGRAM,[903]);send(fd,O.OP_ATTACH_SHADER,[903,901]);send(fd,O.OP_ATTACH_SHADER,[903,902]);
      send(fd,O.OP_BIND_ATTRIB_LOCATION,[903,0,5],new TextEncoder().encode("color"));
      send(fd,O.OP_BIND_ATTRIB_LOCATION,[903,1,8],new TextEncoder().encode("position"));
      send(fd,O.OP_LINK_PROGRAM,[903]);send(fd,O.OP_USE_PROGRAM,[903]);
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
        if(data.peerDelete) {
          sourceContext=id;
          if(forwarded){channels.set(peer,createMainForwardChannel({postMessage:message=>postMessage(message)},7,peer));requireZero(channel(peer).onCreateContext(peer,fd),"create peer");}
          else {
            imports!.host_gl_bind(7,4096,65536,peer);new Uint32Array(memory!.buffer,64,4).set([2,id,0,0]);
            requireZero(imports!.host_gl_create_context(7,900,64,16,peer),"create peer");
          }
          prepareProgram(fd);
        }
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
        if(data.peerDelete && context){sourceDraw=draw;sourceRead=read;}
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
        if(data.peerDelete) {
          // Explicit renderer peer actions interrupt actual C TLVs. They do
          // not stand in for public C shared-context creation or guest marshalling.
          for(let at=0;at<bytes.length;) {
            const op=words.getUint16(at,true),size=words.getUint16(at+2,true),end=at+4+size;
            submit(fd,bytes.slice(at,end));
            if(op===O.OP_BEGIN_CLIENT_ARRAY)captured=true;
            if(op===O.OP_END_CLIENT_ARRAY)captured=false;
            if(captured && !injected && op===O.OP_BIND_BUFFER && words.getUint32(at+4,true)===0x8892) {
              make(peer,900,0,0);send(peer,O.OP_DELETE_BUFFERS,[1,17]);
              send(peer,O.OP_BIND_BUFFER,[0x8892,17]);
              const blue=new Uint8Array(new Float32Array([0,0,1,1]).buffer);
              send(peer,O.OP_BUFFER_DATA,[0x8892,16,0x88e4]);send(peer,O.OP_BUFFER_SUB_DATA,[0x8892,0,16],blue);
              make(fd,sourceContext,sourceDraw,sourceRead);
              if(!forwarded)requireZero(imports!.host_gl_make_current(7,0,0,0,peer),"release peer");
              injected=true;
            }
            if(op===O.OP_DRAW_ARRAYS)observed.push(pixels(fd));
            at=end;
          }
        } else {
          submit(fd,bytes);
          let clear=false;
          for(let at=0;at<bytes.length;) {
            const op=words.getUint16(at,true),size=words.getUint16(at+2,true);at+=4+size;
            if(op===O.OP_CLEAR || (data.captureUpload && op===O.OP_TEX_SUB_IMAGE_2D))clear=true;
          }
          if(clear)observed.push(pixels(fd));
        }
      } else if(kind===12) {
        const op=words.getUint32(0,true),expected=[words.getUint32(4,true),words.getUint32(8,true),words.getUint32(12,true),0x47514c33],input=bytes.slice(16);
        let reply:Uint8Array,rc:number;
        if(forwarded){const result=channel(fd).onQuery!(op,input,16);reply=result.bytes;rc=result.rc;}
        else{
          new Uint8Array(memory!.buffer,64,input.length).set(input);
          rc=imports!.host_gl_query(7,op,64,input.length,128,16,fd);
          reply=new Uint8Array(memory!.buffer,128,16).slice();
        }
        const output=new DataView(reply.buffer,reply.byteOffset,reply.byteLength);
        if(rc!==16||expected.some((value,index)=>output.getUint32(index*4,true)!==value))throw new Error("C bound image source/revision mismatch");
      } else if(kind===11) {
        const op=words.getUint32(0,true),size=words.getUint32(4,true),expected=words.getUint32(8,true),input=bytes.slice(12);
        let reply:Uint8Array,rc:number;
        if(forwarded){const result=channel(fd).onQuery!(op,input,size);reply=result.bytes;rc=result.rc;}
        else{
          new Uint8Array(memory!.buffer,64,input.length).set(input);
          rc=imports!.host_gl_query(7,op,64,input.length,128,size,fd);
          reply=new Uint8Array(memory!.buffer,128,size).slice();
        }
        const output=new DataView(reply.buffer,reply.byteOffset,reply.byteLength);
        if(rc!==size||output.getUint32(0,true)!==expected||output.getUint32(4,true)!==(expected?0:1)
            ||output.getUint32(8,true)!==0x47514c33)throw new Error("C image mutation acceptance mismatch");
      } else if(kind===10) {
        const expected=words.getUint32(12,true), input=bytes.slice(0,12);
        let restore:(()=>void)|null=null;
        if(expected && data.bindFailure) {
          const target=forwarded?null:gl as any;
          if(target) {const create=target.createTexture;target.createTexture=()=>null;restore=()=>{target.createTexture=create;};}
          else postMessage({type:"egl_record_fail_texture_create"});
        }
        try {
          let reply:Uint8Array, rc:number;
          if(forwarded) {const result=channel(fd).onQuery!(O.QOP_BIND_IMAGE_OBJECT,input,12);reply=result.bytes;rc=result.rc;}
          else {
            new Uint8Array(memory!.buffer,64,12).set(input);
            rc=imports!.host_gl_query(7,O.QOP_BIND_IMAGE_OBJECT,64,12,128,12,fd);
            reply=new Uint8Array(memory!.buffer,128,12).slice();
          }
          const output=new DataView(reply.buffer,reply.byteOffset,reply.byteLength);
          if(rc!==12 || output.getUint32(0,true)!==expected || output.getUint32(4,true)!==(expected?0:1)
              || output.getUint32(8,true)!==0x47514c33)throw new Error("C bind acceptance mismatch");
          if(expected) {
            let error:number;
            if(forwarded) {const result=channel(fd).onQuery!(O.QOP_GET_ERROR,new Uint8Array(),4);if(result.rc!==4)throw new Error("error query failed");error=new DataView(result.bytes.buffer,result.bytes.byteOffset,4).getUint32(0,true);}
            else {if(imports!.host_gl_query(7,O.QOP_GET_ERROR,64,0,128,4,fd)!==4)throw new Error("error query failed");error=new DataView(memory!.buffer).getUint32(128,true);}
            if(error!==0x505)throw new Error(`missing injected allocation error: ${error}`);
          }
        } finally {restore?.();}
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
    if(data.peerDelete) {
      if(forwarded){channel(peer).onUnbind!(peer);if(channel(peer).onPresent!()!==-5)throw new Error("peer revived");}
      else imports!.host_gl_unbind(7,peer);
    }
    const clean=forwarded?null:created.length===deleted.length && created.every(value=>deleted.includes(value)) && live.every(isLive=>!isLive());
    postMessage({type:"egl_record_result",observed,retiredContexts,retiredSurfaces,clean,...(data.peerDelete?{injected}:{}),error:forwarded?0:gl!.getError()});
  } catch(error) {postMessage({type:"egl_record_failed",error:String(error)});}
};
