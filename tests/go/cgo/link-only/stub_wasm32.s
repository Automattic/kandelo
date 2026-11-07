#include "textflag.h"

// wasm32 uses four-byte ABI0 values and direct C function-table handles.
// The eight-byte Go continuation slot is supplied by the caller.

TEXT ·dummy(SB),NOSPLIT,$0-0
	RET

TEXT ·callWeighted(SB),NOSPLIT,$0-8
	I32Load value+0(FP)
	I32Const $weighted(SB)
	CallIndirect $0
	I64ExtendI32S
	Set R0
	MOVW R0, ret+4(FP)
	RET

TEXT ·callCrossWeighted(SB),NOSPLIT,$0-8
	I32Load value+0(FP)
	I32Const $cross_weighted(SB)
	CallIndirect $0
	I64ExtendI32S
	Set R0
	MOVW R0, ret+4(FP)
	RET

TEXT ·callTLSWeighted(SB),NOSPLIT,$0-8
	I32Load value+0(FP)
	I32Const $tls_weighted(SB)
	CallIndirect $0
	I64ExtendI32S
	Set R0
	MOVW R0, ret+4(FP)
	RET

TEXT ·callFunctionPointer(SB),NOSPLIT,$0-8
	I32Load value+0(FP)
	I32Const $call_function_pointer(SB)
	CallIndirect $0
	I64ExtendI32S
	Set R0
	MOVW R0, ret+4(FP)
	RET

TEXT ·callChannelBase(SB),NOSPLIT,$0-8
	I32Load value+0(FP)
	I32Const $channel_base_ready(SB)
	CallIndirect $0
	I64ExtendI32S
	Set R0
	MOVW R0, ret+4(FP)
	RET
