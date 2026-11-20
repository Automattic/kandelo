// Versioned group memory layout; constants are generated from Rust.
// Page zero is reserved group metadata, outside every guest address space.
#define VM_Q KANDELO_MG_WAIT_HEADER
#define VM_NODES KANDELO_MG_WAIT_NODES
#define VM_NODE_BYTES KANDELO_MG_WAIT_NODE_BYTES
#define VM_NODE_COUNT ((65536u-VM_NODES)/VM_NODE_BYTES)
#define VM_FREE KANDELO_MG_WAIT_FREE
#define VM_WAITING KANDELO_MG_WAIT_WAITING
#define VM_NOTIFIED KANDELO_MG_WAIT_NOTIFIED
#define VM_STOPPED KANDELO_MG_WAIT_STOPPED
AI uint32_t q_load(uint32_t *p) { return __atomic_load_n(p,__ATOMIC_SEQ_CST); }
AI void q_store(uint32_t *p,uint32_t v) { __atomic_store_n(p,v,__ATOMIC_SEQ_CST); }
AI void q_lock(void) {
    while(__atomic_exchange_n(words(VM_Q),1,__ATOMIC_ACQUIRE)) { }
}
AI void q_unlock(void) {
    __atomic_store_n(words(VM_Q),0,__ATOMIC_RELEASE);
    __builtin_wasm_memory_atomic_notify((int*)words(VM_Q),1);
}
AI uint32_t q_register(uint32_t p,uint64_t expected,uint32_t width,uint32_t root,uint32_t replica) {
    q_lock();
    if(!r_alive(root,replica)||r_load(replica,KANDELO_MG_REPLICA_WAIT_NODE)) { q_unlock();fail(); }
    uint64_t actual=width==4?(uint64_t)q_load(words(p)):
        __atomic_load_n((uint64_t*)(uintptr_t)p,__ATOMIC_SEQ_CST);
    if(actual!=expected) { q_unlock();return 0; }
    uint32_t *q=words(VM_Q),slot=0;
    for(uint32_t i=0;i<VM_NODE_COUNT;i++) {
        uint32_t index=(q[3]+i)%VM_NODE_COUNT,candidate=VM_NODES+index*VM_NODE_BYTES;
        if(!q_load(words(candidate))) { slot=candidate;q[3]=(index+1)%VM_NODE_COUNT;break; }
    }
    if(!slot) { q_unlock();fail(); } // Explicit bounded runtime resource exhaustion.
    uint32_t *node=words(slot);
    node[1]=0;node[2]=p;node[3]=root;node[4]=replica;q_store(node,VM_WAITING);
    if(q[2])words(q[2])[1]=slot;else q[1]=slot;
    q[2]=slot;q[4]++;if(q[4]>q[5])q[5]=q[4];
    q_store(words(replica+KANDELO_MG_REPLICA_WAIT_NODE),slot);
    // Close pause-before-publication: a registered wait performs no guest
    // payload stores until its return-side checkpoint. Keep the original
    // native timeout and FIFO position; its physical target remains pinned.
    uint32_t epoch=r_load(replica,KANDELO_MG_REPLICA_REQUEST);
    if(epoch)r_ack(replica,epoch);
    q_unlock();return slot;
}
AI void q_remove(uint32_t slot) {
    uint32_t *q=words(VM_Q),previous=0;
    for(uint32_t at=q[1];at;at=words(at)[1]) {
        if(at==slot) {
            uint32_t next=words(at)[1];
            if(previous)words(previous)[1]=next;else q[1]=next;
            if(q[2]==at)q[2]=previous;
            return;
        }
        previous=at;
    }
    fail();
}
AI uint32_t q_await(uint32_t slot,int64_t timeout,uint32_t root,uint32_t replica) {
    if(!slot){vm_checkpoint(root,replica);return 1;} // Original word mismatched.
    // The private state word closes notify-before-park races. There is one
    // native wait, with the original timeout: no slices or missed notifications.
    __builtin_wasm_memory_atomic_wait32((int*)words(slot),VM_WAITING,timeout);
    q_lock();uint32_t state=q_load(words(slot));
    if(state==VM_WAITING)q_remove(slot);
    if(state<VM_WAITING||state>VM_STOPPED) { q_unlock();fail(); }
    if(q_load(words(replica+KANDELO_MG_REPLICA_WAIT_NODE))!=slot) { q_unlock();fail(); }
    q_store(words(replica+KANDELO_MG_REPLICA_WAIT_NODE),0);
    q_store(words(slot),VM_FREE);words(VM_Q)[4]--;
    q_unlock();
    if(state==VM_STOPPED||!r_alive(root,replica))fail();
    vm_checkpoint(root,replica);
    return state==VM_NOTIFIED?0:2;
}
EXPORT("vm_wait32")
uint32_t vm_wait32(uint32_t p,int32_t expected,int64_t timeout,uint32_t root,uint32_t replica) {
    return q_await(q_register(p,(uint32_t)expected,4,root,replica),timeout,root,replica);
}
EXPORT("vm_wait64")
uint32_t vm_wait64(uint32_t p,int64_t expected,int64_t timeout,uint32_t root,uint32_t replica) {
    return q_await(q_register(p,(uint64_t)expected,8,root,replica),timeout,root,replica);
}
// Worker-generated IPC must use the same replica-owned queue as source Wasm.
// Accept a virtual word so no JS caller retains a translated physical pointer.
EXPORT("vm_worker_wait32")
uint32_t vm_worker_wait32(uint32_t p,int32_t expected,int64_t timeout,uint32_t root,uint32_t replica) {
    vm_checkpoint(root,replica);
    return vm_wait32(vm_atomic_address(p,0,4,1,root),expected,timeout,root,replica);
}
EXPORT("vm_notify")
uint32_t vm_notify(uint32_t p,uint32_t count) {
    q_lock();uint32_t *q=words(VM_Q),previous=0,woken=0;
    for(uint32_t at=q[1];at&&woken<count;) {
        uint32_t *node=words(at),next=node[1];
        if(node[2]==p) {
            if(previous)words(previous)[1]=next;else q[1]=next;
            if(q[2]==at)q[2]=previous;
            q_store(node,VM_NOTIFIED);__builtin_wasm_memory_atomic_notify((int*)node,1);woken++;
        }else previous=at;
        at=next;
    }
    q_unlock();
    // Kernel channel listeners observe the physical word directly. They are
    // runtime observers, not guest waiters, and do not affect the return count.
    __builtin_wasm_memory_atomic_notify((int*)words(p),count);
    return woken;
}
