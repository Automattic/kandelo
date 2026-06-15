/*
 * Recursive walker shaped after Zend/zend_compile.c's
 * zend_compile_short_circuiting. The leaf calls fork() — never reached
 * during the V8 overflow sweep (run.mjs stubs kernel_fork) — only so
 * wasm-fork-instrument's call-graph closure includes walk and applies
 * the instrumentation we want to measure.
 */

#include <stdint.h>
#include <unistd.h>

typedef struct {
    int32_t op_type;
    int32_t u_op_var;
    int64_t u_constant_value;
    int64_t u_constant_type;
    int32_t flags;
    int32_t reserved;
} znode_t;

/* Inlining leaf into walk would fold leaf's locals into walk's frame
 * and shift the 4-vs-12 locals count this benchmark measures. */
__attribute__((noinline))
static int leaf(int64_t carry)
{
    pid_t pid = fork();
    if (pid == 0) _exit(0);
    return (int)(carry & 0xFF);
}

__attribute__((export_name("benchmark_walk")))
int walk(int depth)
{
    /* volatile keeps -O2 from folding the working set away; the shape
     * (znode-like locals + scalar bookkeeping) mimics
     * zend_compile_binary_op's per-frame footprint. */
    volatile znode_t left_node = {0, 0, 0, 0, 0, 0};
    volatile znode_t right_node = {0, 0, 0, 0, 0, 0};
    volatile znode_t result_node = {0, 0, 0, 0, 0, 0};
    volatile int32_t opcode = depth & 0xff;
    volatile int32_t attrs = (depth >> 8) & 0xff;
    volatile int32_t jmp_target = 0;
    volatile int32_t jmp_fallback = 0;
    volatile int64_t left_ast_ptr = (int64_t)(intptr_t)&left_node;
    volatile int64_t right_ast_ptr = (int64_t)(intptr_t)&right_node;
    volatile int64_t parent_ast_ptr = 0;
    volatile int32_t lineno = depth;
    volatile int32_t child_count = 2;
    volatile int32_t kind = 0xa0;
    volatile int32_t flags = 0;

    left_node.op_type = opcode + 1;
    right_node.op_type = opcode + 2;
    result_node.op_type = opcode | attrs;
    result_node.u_constant_value =
        left_node.u_constant_value + right_node.u_constant_value;
    jmp_target = (int32_t)(left_ast_ptr ^ right_ast_ptr) & 0xffff;
    jmp_fallback = jmp_target ^ 0xa5a5;

    if (depth == 0) {
        int64_t carry = result_node.u_constant_value
                      ^ (int64_t)opcode
                      ^ (int64_t)kind
                      ^ (int64_t)flags
                      ^ (int64_t)(jmp_target + jmp_fallback)
                      ^ left_ast_ptr ^ right_ast_ptr ^ parent_ast_ptr
                      ^ (int64_t)(lineno + child_count);
        return leaf(carry);
    }

    int next = walk(depth - 1);
    return next
         + (int)(result_node.u_constant_value & 1)
         + (jmp_target & 1)
         + (lineno & 1);
}

int main(void) { return 0; }
