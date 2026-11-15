import{createFastClockReader}from'./fast-clock-control';
import{clockCertificateReader,type DirectClockInit}from'./fast-clock-record';
import{decodeFastClockDescriptor}from'./fast-clock-provider';
import{prepareDirectClockOutput}from'./fast-clock-output';
export function createWorkerClockQuery(init:DirectClockInit|undefined,memory:WebAssembly.Memory,pid:number,tid:number,generation:number|undefined,width:4|8){
 if(!init||width!==4)return;
 if(init.binding.pid!==pid||init.binding.tid!==tid||init.binding.generation!==generation)throw Error('clock worker binding mismatch');
 const read=createFastClockReader({epoch:init.epoch,binding:init.binding,sample:decodeFastClockDescriptor(init.provider),certificate:clockCertificateReader(init),prepareOutput:pointer=>prepareDirectClockOutput(memory,pointer)});
 return(pointer:number|bigint,id:number,format:number)=>{
  if(typeof pointer!=='number'||(format!==0&&format!==1))return 1;
  return read(pointer>>>0,id,format);
 };
}
