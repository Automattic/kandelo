/** Fresh output views for ordinary native-addressed process memory.
 * The experimental translated profile replaces this module with its reviewed
 * PTE/physical-bounds preflight, returning native physical DataViews. */
export function prepareDirectClockOutput(memory:WebAssembly.Memory,pointer:number):DataView[]|undefined{
 if(!Number.isSafeInteger(pointer)||pointer<=0||pointer>0xfffffff0)return;
 const buffer=memory.buffer;if(pointer>buffer.byteLength-16)return;
 return[new DataView(buffer,pointer,16)];
}
