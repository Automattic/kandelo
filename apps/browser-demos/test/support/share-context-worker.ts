import {createMainForwardChannel} from "../../../../host/src/webgl/main-forward";
import {createWasmPosixKernelTestHarness} from "../../../../host/src/kernel";
import {createKernelScratchTestInstance} from "../../../../host/test/support/kernel-scratch-instance";
import * as O from "../../../../host/src/webgl/ops";

// Driver-level ABI 58 construction, not public C sharing or Rust marshalling.
self.onmessage=({data})=>{
  try {
    const forwarded=data.mode==="forwarded";
    const channels=[11,12,13,14].map(session=>createMainForwardChannel({postMessage:message=>postMessage(message)},7,session));
    let gl:WebGL2RenderingContext|null=null,memory:WebAssembly.Memory|null=null;
    let imports:Record<string,(...args:any[])=>any>|null=null;
    const created:object[]=[],deleted:object[]=[],live:Array<()=>boolean>=[],creationCounts:Record<string,number>={};
    if(!forwarded) {
      const canvas=data.canvas as OffscreenCanvas;
      gl=canvas.getContext("webgl2",{antialias:false,premultipliedAlpha:false,depth:true,stencil:true,preserveDrawingBuffer:true});
      if(!gl)throw new Error("native WebGL2 unavailable");
      for(const [createName,deleteName,isName] of [["createTexture","deleteTexture","isTexture"],["createFramebuffer","deleteFramebuffer","isFramebuffer"],["createRenderbuffer","deleteRenderbuffer","isRenderbuffer"],...(data.uniforms?[["createProgram","deleteProgram","isProgram"],["createShader","deleteShader","isShader"]]:[]),...(data.reservations?[["createBuffer","deleteBuffer","isBuffer"]]:[])]) {
        const api=gl as any,create=api[createName].bind(gl),destroy=api[deleteName].bind(gl),isLive=api[isName].bind(gl);
        api[createName]=(...args:unknown[])=>{const value=create(...args);if(value){created.push(value);live.push(()=>isLive(value));creationCounts[createName]=(creationCounts[createName]??0)+1;}return value;};
        api[deleteName]=(value:object|null)=>{if(value)deleted.push(value);destroy(value);};
      }
      memory=new WebAssembly.Memory({initial:2,maximum:2});
      const native=createWasmPosixKernelTestHarness({io:{} as any,callbacks:{getProcessMemory:()=>memory!},memory,pointerWidth:4,
        instance:createKernelScratchTestInstance(4,memory,()=>({}),()=>4096)});
      imports=(native.testAuthority.buildImportObject(memory) as {env:typeof imports}).env;
      // The source fixture models distinct sessions on one stable DRM file.
      for(let i=0;i<4;i++)imports!.host_gl_bind(7,4096,65536,11+i,1n);
      native.gl.attachCanvas(7,canvas);
    }
    const requireZero=(rc:number,label:string)=>{if(rc!==0)throw new Error(`${label}: ${rc}`);};
    const create=(i:number,source?:number)=>{
      if(forwarded)requireZero(channels[i].onCreateContext(11+i,source===undefined?undefined:11+source),"forward create");
      else {
        new Uint32Array(memory!.buffer,64,4).set([2,source===undefined?0:21+source,0,0]);
        requireZero(imports!.host_gl_create_context(7,21+i,64,16,11+i),"native create");
      }
    };
    const current=(i:number)=>requireZero(forwarded?channels[i].onMakeCurrent!({drawSurfaceId:0,readSurfaceId:0,width:0,height:0})
      :imports!.host_gl_make_current(7,21+i,0,0,11+i),"current");
    const send=(i:number,op:number,words:number[],tail=new Uint8Array())=>{
      const bytes=new Uint8Array(4+4*words.length+tail.length),view=new DataView(bytes.buffer);
      view.setUint16(0,op,true);view.setUint16(2,4*words.length+tail.length,true);
      words.forEach((word,index)=>view.setUint32(4+4*index,word,true));bytes.set(tail,4+4*words.length);
      if(forwarded)channels[i].onSubmit(bytes);
      else {new Uint8Array(memory!.buffer,4096,bytes.length).set(bytes);requireZero(imports!.host_gl_submit(7,0,bytes.length,11+i),`submit op ${op.toString(16)}`);}
    };
    const query=(i:number,op:number,words:number[],length:number,tail=new Uint8Array())=>{
      const input=new Uint8Array(words.length*4+tail.length),view=new DataView(input.buffer);
      words.forEach((word,index)=>view.setUint32(index*4,word,true));input.set(tail,words.length*4);
      if(forwarded) {
        const reply=channels[i].onQuery!(op,input,length);if(reply.rc!==length)throw new Error(`query: ${reply.rc}`);return [...reply.bytes];
      }
      new Uint8Array(memory!.buffer,64,input.length).set(input);
      const rc=imports!.host_gl_query(7,op,64,input.length,128,length,11+i);if(rc!==length)throw new Error(`query: ${rc}`);
      return [...new Uint8Array(memory!.buffer,128,length)];
    };
    const pixels=(i:number)=>query(i,O.QOP_READ_PIXELS,[0,0,1,1,0x1908,0x1401],4);
    const storage=(i:number,color:number[])=>{
      send(i,O.OP_BIND_TEXTURE,[0x0de1,17]);
      send(i,O.OP_TEX_IMAGE_2D,[0x0de1,0,0x1908,1,1,0,0x1908,0x1401,4],new Uint8Array(color));
    };
    const attachment=(i:number)=>{
      send(i,O.OP_GEN_FRAMEBUFFERS,[1,7]);send(i,O.OP_BIND_FRAMEBUFFER,[0x8d40,7]);
      send(i,O.OP_FRAMEBUFFER_TEXTURE_2D,[0x8d40,0x8ce0,0x0de1,17,0]);
    };
    const destroy=(i:number)=>{if(forwarded)channels[i].onDestroyContext!();else imports!.host_gl_destroy_context(7,21+i);};
    if(data.reservations) {
      const isObject=(i:number,kind:number,name:number)=>{
        const view=new DataView(new Uint8Array(query(i,O.QOP_IS_OBJECT,[kind,name],12)).buffer);
        if(view.getUint32(0,true)!==0 || view.getUint32(8,true)!==0x47514c33)throw new Error("object query failed");
        return view.getUint32(4,true)!==0;
      };
      create(0);current(0);
      const gens=[O.OP_GEN_BUFFERS,O.OP_GEN_TEXTURES,O.OP_GEN_RENDERBUFFERS],deletes=[O.OP_DELETE_BUFFERS,O.OP_DELETE_TEXTURES,O.OP_DELETE_RENDERBUFFERS];
      for(const op of gens)send(0,op,[1,90]);
      const reserved=gens.map((_,kind)=>isObject(0,kind,90));
      for(const op of deletes)send(0,op,[1,90]);
      create(1,0);current(1);storage(1,[255,0,0,255]);attachment(1);
      send(1,O.OP_BIND_BUFFER,[0x8892,21]);send(1,O.OP_BUFFER_DATA,[0x8892,4,0x88e4]);send(1,O.OP_BUFFER_SUB_DATA,[0x8892,0,4],new Uint8Array([0,1,2,3]));
      send(1,O.OP_BIND_RENDERBUFFER,[0x8d41,31]);send(1,O.OP_RENDERBUFFER_STORAGE,[0x8d41,0x8056,1,1]);
      send(1,O.OP_GEN_FRAMEBUFFERS,[1,8]);send(1,O.OP_BIND_FRAMEBUFFER,[0x8d40,8]);send(1,O.OP_FRAMEBUFFER_RENDERBUFFER,[0x8d40,0x8ce0,0x8d41,31]);
      send(1,O.OP_CLEAR_COLOR,Array.from(new Uint32Array(new Float32Array([0,1,0,1]).buffer)));send(1,O.OP_CLEAR,[0x4000]);
      // A client's reserved names can reach a peer before its queued Gen
      // declarations reach the renderer. Those records must not reset objects.
      current(0);const names=[21,17,31];gens.forEach((op,index)=>send(0,op,[1,names[index]]));
      const realized=names.map((name,kind)=>isObject(0,kind,name));
      attachment(0);const texturePixels=pixels(0);
      send(0,O.OP_GEN_FRAMEBUFFERS,[1,8]);send(0,O.OP_BIND_FRAMEBUFFER,[0x8d40,8]);send(0,O.OP_FRAMEBUFFER_RENDERBUFFER,[0x8d40,0x8ce0,0x8d41,31]);const renderbufferPixels=pixels(0);
      send(0,O.OP_BIND_BUFFER,[0x8893,21]);const usage=new Uint8Array(query(0,O.QOP_GET_INDEX_USAGE,[0x1401,0,4],8204)),v=new DataView(usage.buffer);
      if(v.getUint32(0,true)!==0 || v.getUint32(8200,true)!==0x47514c33)throw new Error("buffer usage failed");
      const bufferMaximum=v.getUint32(4,true),bufferBits=usage[8];
      deletes.forEach((op,index)=>send(0,op,[1,names[index]]));gens.forEach((op,index)=>send(0,op,[1,names[index]]));
      const retired=names.map((name,kind)=>isObject(0,kind,name));
      const errors=[query(0,O.QOP_GET_ERROR,[],4),query(1,O.QOP_GET_ERROR,[],4)];destroy(0);destroy(1);
      for(const i of [0,1]){
        if(forwarded){channels[i].onUnbind!(11+i);if(channels[i].onPresent!()!==-5)throw new Error("retired session revived");}
        else imports!.host_gl_unbind(7,11+i);
      }
      const clean=forwarded?null:created.length===deleted.length && created.every(value=>deleted.includes(value)) && live.every(isLive=>!isLive());
      postMessage({type:"reservation_result",reserved,realized,retired,texturePixels,renderbufferPixels,bufferMaximum,bufferBits,errors,
        allocations:forwarded?null:[creationCounts.createBuffer??0,creationCounts.createTexture??0,creationCounts.createRenderbuffer??0],clean,error:forwarded?0:gl!.getError()});return;
    }
    if(data.uniforms) {
      create(0);current(0);storage(0,[0,0,0,255]);attachment(0);
      const shader=(name:number,type:number,text:string)=>{
        send(0,O.OP_CREATE_SHADER,[type,name]);const bytes=new TextEncoder().encode(text);
        send(0,O.OP_SHADER_SOURCE,[name,bytes.length],bytes);send(0,O.OP_COMPILE_SHADER,[name]);
      };
      shader(10,0x8b31,"void main(){gl_Position=vec4(0.,0.,0.,1.);gl_PointSize=1.;}");
      const longName="u"+"n".repeat(248);
      shader(11,0x8b30,`precision mediump float;uniform float ${longName};uniform vec4 colorValue;uniform mat3 normal;uniform mat4 transform;uniform vec3 items[2];uniform bvec4 flags;uniform float scalar;void main(){gl_FragColor=colorValue+vec4(items[0]+items[1],0.)*scalar+vec4(flags)*.0001+vec4(normal[0][0]+transform[0][0])*.0001+vec4(${longName}*.0001);}`);
      send(0,O.OP_CREATE_PROGRAM,[20]);send(0,O.OP_ATTACH_SHADER,[20,10]);send(0,O.OP_ATTACH_SHADER,[20,11]);
      send(0,O.OP_LINK_PROGRAM,[20]);send(0,O.OP_USE_PROGRAM,[20]);
      const tokens=[0,0,0,0];
      const lookupName=(i:number,name:string)=>{
        const bytes=new TextEncoder().encode(name),token=++tokens[i];
        const request=(action:number,arg=0,tail=new Uint8Array())=>{
          const reply=query(i,O.QOP_LOOKUP_UNIFORM,[action,20,token,arg],16,tail),view=new DataView(new Uint8Array(reply).buffer);
          if(view.getUint32(0,true)!==0 || view.getUint32(4,true)!==token || view.getUint32(12,true)!==0x47514c33)throw new Error("checked uniform lookup failed");
          return view.getInt32(8,true);
        };
        if(bytes.length<=65520)return request(0,bytes.length,bytes);
        request(1,bytes.length);
        for(let offset=0;offset<bytes.length;offset+=65520)request(2,offset,bytes.subarray(offset,offset+65520));
        return request(3);
      };
      const location=(i:number,name:string)=>{const result=lookupName(i,name);if(result<0)throw new Error(`inactive uniform ${name}`);return result;};
      const names=["colorValue","normal","transform","items[0]","items[1]","flags","scalar",longName];
      const locations=names.map(name=>location(0,name));
      const stable=location(0,"colorValue")===locations[0] && location(0,"items")===locations[3] && location(0,"items[000]")===locations[3];
      const floats=(i:number,op:number,words:number[],values:number[])=>send(i,op,words,new Uint8Array(new Float32Array(values).buffer));
      const matrix3=[1,2,3,4,5,6,7,8,9],matrix4=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
      floats(0,O.OP_UNIFORM4F,[locations[0]],[.25,.5,.75,1]);
      floats(0,O.OP_UNIFORM_MATRIX3FV,[locations[1],1,0],matrix3);
      floats(0,O.OP_UNIFORM_MATRIX4FV,[locations[2],1,0],matrix4);
      floats(0,O.OP_UNIFORM3FV,[locations[3],2],[1,2,3,4,5,6]);
      send(0,O.OP_UNIFORM4IV,[locations[5],1],new Uint8Array(new Int32Array([1,0,1,0]).buffer));
      floats(0,O.OP_UNIFORM1F,[locations[6]],[.5]);
      create(1,0);current(1);
      const peerStable=location(1,"items")===locations[3],missingBulk=lookupName(1,"missing"+"n".repeat(70000));
      const reflected:Array<[string,number,number]>=[];
      const count=new DataView(new Uint8Array(query(1,O.QOP_GET_PROGRAMIV,[20,0x8b86],4)).buffer).getUint32(0,true);
      for(let index=0;index<count;index++){
        const read=(offset:number,capacity:number)=>{
          const bytes=new Uint8Array(query(1,O.QOP_GET_ACTIVE_UNIFORM_INFO,[20,index,offset,capacity],20+capacity)),v=new DataView(bytes.buffer);
          if(v.getUint32(0,true)!==0 || v.getUint32(16+capacity,true)!==0x47514c33)throw new Error("reflection incomplete");
          return {bytes:bytes.subarray(16,16+capacity),length:v.getUint32(4,true),size:v.getInt32(8,true),type:v.getUint32(12,true)};
        };
        const meta=read(0,0),bytes=new Uint8Array(meta.length);
        for(let offset=0;offset<meta.length;offset+=17){const capacity=Math.min(17,meta.length-offset),part=read(offset,capacity);
          if(part.length!==meta.length || part.size!==meta.size || part.type!==meta.type)throw new Error("changed reflection");bytes.set(part.bytes,offset);}
        reflected.push([new TextDecoder().decode(bytes),meta.size,meta.type]);
      }
      reflected.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);

      const values=(i:number,loc:number,integer=0)=>{
        const bytes=query(i,O.QOP_GET_UNIFORM_VALUES,[20,loc,integer],76),view=new DataView(new Uint8Array(bytes).buffer);
        if(view.getUint32(72,true)!==0x47514c33)throw new Error("uniform reply incomplete");
        const status=view.getUint32(0,true),count=view.getUint32(4,true);
        return {status,count,values:Array.from({length:count},(_,n)=>integer?view.getInt32(8+n*4,true):view.getFloat32(8+n*4,true))};
      };
      const shared=locations.map(loc=>values(1,loc)),integers=values(1,locations[0],1),booleans=values(1,locations[5],1);
      // Querying does not require installing the program in this peer.
      destroy(0);const survivor=values(1,locations[0]);
      current(1);send(1,O.OP_USE_PROGRAM,[20]);floats(1,O.OP_UNIFORM4F,[locations[0]],[1,0,0,1]);floats(1,O.OP_UNIFORM1F,[locations[6]],[0]);
      storage(1,[0,0,0,255]);attachment(1);send(1,O.OP_VIEWPORT,[0,0,1,1]);send(1,O.OP_DRAW_ARRAYS,[0,0,1]);const rendered=pixels(1);
      const badSource=new TextEncoder().encode("this is invalid GLSL");send(1,O.OP_SHADER_SOURCE,[11,badSource.length],badSource);send(1,O.OP_COMPILE_SHADER,[11]);send(1,O.OP_LINK_PROGRAM,[20]);
      const failedLink=values(1,locations[0]),failedError=query(1,O.QOP_GET_ERROR,[],4);
      send(1,O.OP_DRAW_ARRAYS,[0,0,1]);const retainedExecutable=pixels(1);
      const goodSource=new TextEncoder().encode("precision mediump float;uniform vec4 colorValue;void main(){gl_FragColor=colorValue;}");
      send(1,O.OP_SHADER_SOURCE,[11,goodSource.length],goodSource);send(1,O.OP_COMPILE_SHADER,[11]);
      send(1,O.OP_LINK_PROGRAM,[20]);const invalidated=values(1,locations[0]);const staleError=query(1,O.QOP_GET_ERROR,[],4);
      const fresh=location(1,"colorValue"),relinked=values(1,fresh);
      send(1,O.OP_DELETE_PROGRAM,[20]);const pending=values(1,fresh);send(1,O.OP_USE_PROGRAM,[0]);const afterDelete=values(1,fresh);const deletedError=query(1,O.QOP_GET_ERROR,[],4);
      destroy(1);
      for(const i of [0,1]) {
        if(forwarded){channels[i].onUnbind!(11+i);if(channels[i].onPresent!()!==-5)throw new Error("retired session revived");}
        else imports!.host_gl_unbind(7,11+i);
      }
      const clean=forwarded?null:created.length===deleted.length && created.every(value=>deleted.includes(value)) && live.every(isLive=>!isLive());
      postMessage({type:"uniform_values_result",stable,peerStable,missingBulk,reflected,shared,integers,booleans,survivor,rendered,failedLink,failedError,retainedExecutable,invalidated,staleError,relinked,pending,afterDelete,deletedError,clean,error:forwarded?0:gl!.getError()});return;
    }
    create(0);current(0);storage(0,[255,0,0,255]);attachment(0);const red=pixels(0);
    create(1,0);current(1);attachment(1);const sharedRed=pixels(1);
    send(1,O.OP_BIND_TEXTURE,[0x0de1,17]);
    send(1,O.OP_TEX_SUB_IMAGE_2D,[0x0de1,0,0,0,1,1,0x1908,0x1401,4],new Uint8Array([0,255,0,255]));
    current(0);const sharedGreen=pixels(0);
    create(2);current(2);storage(2,[0,0,255,255]);attachment(2);const independent=pixels(2);
    destroy(0);current(1);const survivor=pixels(1);
    create(3,1);current(3);attachment(3);const chained=pixels(3);
    current(1);send(1,O.OP_DELETE_TEXTURES,[1,17]);
    current(3);const unnamed=pixels(3),publicName=query(3,O.QOP_IS_OBJECT,[1,17],12);
    current(1);storage(1,[255,255,0,255]);
    current(3);const afterReuse=pixels(3);destroy(1);const afterPeerDestroy=pixels(3);
    destroy(2);destroy(3);
    for(let i=0;i<4;i++) {
      if(forwarded){channels[i].onUnbind!(11+i);if(channels[i].onPresent!()!==-5)throw new Error("retired session revived");}
      else imports!.host_gl_unbind(7,11+i);
    }
    const clean=forwarded?null:created.length===deleted.length && created.every(value=>deleted.includes(value)) && live.every(isLive=>!isLive());
    postMessage({type:"share_context_result",red,sharedRed,sharedGreen,independent,survivor,chained,unnamed,
      publicName:publicName.slice(4,8),afterReuse,afterPeerDestroy,clean,error:forwarded?0:gl!.getError()});
  } catch(error){postMessage({type:"share_context_failed",error:String(error)});}
};
