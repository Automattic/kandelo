const setup=`const api=__kandeloUpstreamTest;api.initializeContext();const realm=api.initializeRealm();realm.internalBinding('buffer').setBufferPrototype(realm.require('internal/buffer').FastBuffer.prototype);const op=(...args)=>api.nativeOwners('internalsBuffer',...args);function assert(value){if(!value)throw Error('original internals assertion')}`;
export const nativeInternalsCases=[
 {name:'original-internals-buffer-helper-copies-stack-preserves-invalid-and-zero',code:0,stdout:'INTERNALS_STACK_OK',source:setup+`
 const inline=op(0);assert(inline.buffer instanceof Uint8Array&&inline.buffer.length===7&&!inline.samePointer&&!inline.sourceAllocated&&inline.sourceLength===7);
 assert(Array.from(inline.buffer).join(',')==='97,0,98,255,99,10,100');
 const invalid=op(2);assert(invalid.buffer===undefined&&invalid.sourceInvalidated&&invalid.sourceLength===0);
 const empty=op(3);assert(empty.buffer instanceof Uint8Array&&empty.buffer.length===0&&!empty.sourceInvalidated);
 const wide=op(4);assert(wide.buffer.length===4&&Array.from(wide.buffer).join(',')==='187,3,0,0'&&!wide.samePointer);
 gc(undefined,'shrinking');assert(inline.buffer[0]===97&&wide.buffer[0]===187);print('INTERNALS_STACK_OK');`},
 {name:'original-internals-buffer-helper-transfers-heap-storage-through-real-gc',code:0,stdout:'INTERNALS_HEAP_OK',source:setup+`
 let first=op(1);assert(first.buffer instanceof Uint8Array&&first.buffer.length===4097&&first.samePointer&&!first.sourceAllocated&&first.sourceLength===0);
 for(let i=0;i<first.buffer.length;i++)assert(first.buffer[i]===(i*17+3)%256);
 const retained=first.buffer;first=null;gc(undefined,'shrinking');gc(undefined,'shrinking');assert(retained[0]===3&&retained[4096]===3);
 for(let n=0;n<12;n++){let next=op(1);assert(next.samePointer&&next.buffer[101]===(101*17+3)%256);next=null;gc(undefined,'shrinking')}
 assert(retained[2048]===3);print('INTERNALS_HEAP_OK');`},
];
