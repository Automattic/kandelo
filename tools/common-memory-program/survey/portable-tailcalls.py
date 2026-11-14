"""Private standard-Wasm tail-dispatch header adaptation; not an SDK change."""
from pathlib import Path
import json,sys

def adapt(opcodes,execute):
    selector='#elif defined(HAVE_MUSTTAIL) && defined(HAVE_PRESERVE_NONE) && (defined(__x86_64__) || defined(__aarch64__)) && defined(__clang__)'
    assert opcodes.count(selector)==1
    opcodes=opcodes.replace(selector,'#elif defined(__wasm__) && defined(__wasm_tail_call__) && defined(HAVE_MUSTTAIL)\n# define ZEND_VM_KIND ZEND_VM_KIND_TAILCALL\n'+selector)
    conv='# define ZEND_OPCODE_HANDLER_CCONV    ZEND_PRESERVE_NONE'
    assert opcodes.count(conv)==1
    opcodes=opcodes.replace(conv,'# if defined(__wasm__) && defined(__wasm_tail_call__)\n#  define ZEND_OPCODE_HANDLER_CCONV ZEND_FASTCALL\n# else\n'+conv+'\n# endif')
    # Both handler tables are real interfaces: tail dispatch uses opcode_handler,
    # whereas the public single-step path must use opcode_handler_func.
    guard='#if (ZEND_VM_KIND != ZEND_VM_KIND_HYBRID && ZEND_VM_KIND != ZEND_VM_KIND_TAILCALL) || !ZEND_VM_SPEC'
    assert execute.count(guard)==2
    execute=execute.replace(guard,'#if (ZEND_VM_KIND != ZEND_VM_KIND_HYBRID) || !ZEND_VM_SPEC')
    prototype='static zend_vm_opcode_handler_t zend_vm_get_opcode_handler(uint8_t opcode, const zend_op* op);'
    assert execute.count(prototype)==1
    execute=execute.replace(prototype,prototype+'\n#if ZEND_VM_KIND == ZEND_VM_KIND_TAILCALL\nstatic zend_vm_opcode_handler_func_t zend_vm_get_opcode_handler_func(uint8_t opcode, const zend_op* op);\n#endif')
    begin='#if ZEND_VM_KIND == ZEND_VM_KIND_TAILCALL\n\n# undef ZEND_VM_TAIL_CALL'
    assert execute.count(begin)==1
    macros=['ZEND_VM_TAIL_CALL','ZEND_VM_CONTINUE','ZEND_VM_RETURN','ZEND_VM_DISPATCH_TO_HELPER','ZEND_VM_DISPATCH_TO_LEAVE_HELPER','ZEND_VM_INTERRUPT','ZEND_VM_DISPATCH']
    pushed='\n'.join('#pragma push_macro("'+m+'")'for m in macros)
    execute=execute.replace(begin,'#if ZEND_VM_KIND == ZEND_VM_KIND_TAILCALL\n'+pushed+'\n# undef ZEND_VM_TAIL_CALL')
    # Force the actual tail opcode dispatch to remain a tail call, including
    # user-opcode redispatch; don't weaken musttail for signature compatibility.
    dispatch='# define ZEND_VM_TAIL_CALL(call)               ZEND_MUSTTAIL return call'
    assert execute.count(dispatch)==1
    execute=execute.replace(dispatch,dispatch+'\n# undef ZEND_VM_DISPATCH\n# define ZEND_VM_DISPATCH(opcode, opline) ZEND_VM_TAIL_CALL(zend_vm_get_opcode_handler(opcode, opline)(ZEND_OPCODE_HANDLER_ARGS_PASSTHRU))')
    end='#endif /* ZEND_VM_KIND == ZEND_VM_KIND_TAILCALL */'
    assert execute.count(end)==1
    popped='\n'.join('#pragma pop_macro("'+m+'")'for m in reversed(macros))
    execute=execute.replace(end,popped+'\n'+end+'\n#if ZEND_VM_KIND == ZEND_VM_KIND_TAILCALL\n# undef ZEND_VM_DISPATCH\n# define ZEND_VM_DISPATCH(opcode, opline) return zend_vm_get_opcode_handler_func(opcode, opline)(ZEND_OPCODE_HANDLER_ARGS_PASSTHRU);\n#endif')
    single='# if ZEND_VM_KIND == ZEND_VM_KIND_TAILCALL\n\thandler = zend_vm_get_opcode_handler_func'
    assert execute.count(single)==1
    execute=execute.replace(single,'# if ZEND_VM_KIND == ZEND_VM_KIND_TAILCALL\n\tzend_vm_opcode_handler_func_t handler = zend_vm_get_opcode_handler_func')
    return opcodes,execute

if __name__=='__main__':
    source,destination=map(Path,sys.argv[1:]);destination.mkdir()
    opcodes,execute=adapt((source/'zend_vm_opcodes.h').read_text(),(source/'zend_vm_execute.h').read_text())
    (destination/'zend_vm_opcodes.h').write_text(opcodes);(destination/'zend_vm_execute.h').write_text(execute)
    for name in ['zend_vm_opcodes.c','zend_vm_handlers.h']:(destination/name).write_bytes((source/name).read_bytes())
    print(json.dumps({'adapted':['zend_vm_opcodes.h','zend_vm_execute.h'],'preserved':['zend_vm_opcodes.c','zend_vm_handlers.h'],'scope':__doc__}))
