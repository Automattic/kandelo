// FastCGI v1 over the host's existing protected in-kernel pipe transport.
// No physical-host socket or alternate guest network implementation is used.
const encoder=new TextEncoder(),decoder=new TextDecoder();
function record(type,bytes=new Uint8Array()) {
  if(bytes.length>65535) throw Error('FastCGI record limit');
  const out=new Uint8Array(8+bytes.length);
  out.set([1,type,0,1,bytes.length>>>8,bytes.length&255,0,0]);out.set(bytes,8);return out;
}
function join(chunks) {const out=new Uint8Array(chunks.reduce((n,b)=>n+b.length,0));let at=0;for(const b of chunks){out.set(b,at);at+=b.length;}return out;}
function params(values) {
  return join(Object.entries(values).map(([key,value])=>{
    const name=encoder.encode(key),bytes=encoder.encode(value);
    if(name.length>127 || bytes.length>127) throw Error('fixture parameter length limit');
    return join([new Uint8Array([name.length,bytes.length]),name,bytes]);
  }));
}
export async function fastcgi(host,port,script,query='',timeoutMs=30000) {
  const started=performance.now(),deadline=started+timeoutMs;
  const peerPort=1024+Math.floor(Math.random()*60000);
  const admitted=typeof host.commonMemoryPrototypeConnect==='function'
    ?await host.commonMemoryPrototypeConnect(port,peerPort):null;
  const target=admitted?admitted.target:await host.pickListenerTarget(port);
  if(!target) throw Error('FPM has no live listener');
  const recv=admitted?admitted.recv:await host.injectConnection(target.pid,target.fd,[127,0,0,1],peerPort);
  if(recv<0) throw Error(`FPM injection failed ${recv}; selected=${JSON.stringify(target)}; current=${JSON.stringify(await host.pickListenerTarget(port))}`);
  const request=join([record(1,new Uint8Array([0,1,0,0,0,0,0,0])),record(4,params({
    REQUEST_METHOD:'GET',SCRIPT_FILENAME:script,SCRIPT_NAME:'/probe.php',QUERY_STRING:query,
    SERVER_PROTOCOL:'HTTP/1.1',SERVER_NAME:'localhost',SERVER_PORT:String(port),CONTENT_LENGTH:'0',REDIRECT_STATUS:'200',
  })),record(4),record(5)]);
  let at=0,pending=new Uint8Array(),stdout=[],stderr=[];
  try {
    while(at<request.length) {
      const written=await host.pipeWrite(0,recv,request.subarray(at));
      if(written<0) throw Error(`FastCGI write failed ${written}`);
      at+=written;
      if(!written) await new Promise(r=>setTimeout(r,1));
      if(performance.now()>deadline) throw Error('FastCGI write deadline');
    }
    while(performance.now()<deadline) {
      const bytes=await host.pipeRead(0,recv+1);
      if(bytes?.length) pending=join([pending,bytes]);
      if(pending.length>65536) throw Error('FastCGI response bound');
      let consumed=0;
      while(pending.length-consumed>=8) {
        const h=pending.subarray(consumed,consumed+8),length=(h[4]<<8)|h[5],total=8+length+h[6];
        if(pending.length-consumed<total) break;
        if(h[0]!==1 || h[2]!==0 || h[3]!==1) throw Error('FastCGI response header');
        const payload=pending.slice(consumed+8,consumed+8+length);
        consumed+=total;
        if(h[1]===6) stdout.push(payload);
        else if(h[1]===7) stderr.push(payload);
        else if(h[1]===3) {
          if(length!==8 || payload[4]!==0) throw Error('FastCGI end status');
          const applicationStatus=new DataView(payload.buffer).getUint32(0,false);
          const output=decoder.decode(join(stdout)),errors=decoder.decode(join(stderr));
          if(applicationStatus) throw Error(`FastCGI application status ${applicationStatus}: ${errors}`);
          const headerEnd=output.indexOf('\r\n\r\n');
          if(headerEnd<0) throw Error(`FastCGI missing CGI headers: ${output}`);
          return {elapsedMs:performance.now()-started,headers:output.slice(0,headerEnd),body:output.slice(headerEnd+4),stderr:errors,target};
        } else throw Error(`FastCGI unexpected record ${h[1]}`);
      }
      pending=pending.slice(consumed);
      await new Promise(r=>setTimeout(r,1));
    }
    throw Error('FastCGI response deadline');
  } finally {host.pipeCloseWrite(0,recv);host.pipeCloseRead(0,recv+1);}
}
