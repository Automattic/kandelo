#include "textflag.h"

TEXT ·dummy(SB),NOSPLIT,$0-0
	RET

TEXT ·callWeighted(SB),NOSPLIT,$0-16
	I64Load value+0(FP)
	I32WrapI64
	I64Const $weighted(SB)
	I64Const $16
	I64ShrU
	I32WrapI64
	CallIndirect $0
	I64ExtendI32S
	Set R0
	MOVD R0, ret+8(FP)
	RET

TEXT ·callCrossWeighted(SB),NOSPLIT,$0-16
	I64Load value+0(FP)
	I32WrapI64
	I64Const $cross_weighted(SB)
	I64Const $16
	I64ShrU
	I32WrapI64
	CallIndirect $0
	I64ExtendI32S
	Set R0
	MOVD R0, ret+8(FP)
	RET

TEXT ·callTLSWeighted(SB),NOSPLIT,$0-16
	I64Load value+0(FP)
	I32WrapI64
	I64Const $tls_weighted(SB)
	I64Const $16
	I64ShrU
	I32WrapI64
	CallIndirect $0
	I64ExtendI32S
	Set R0
	MOVD R0, ret+8(FP)
	RET

TEXT ·callFunctionPointer(SB),NOSPLIT,$0-16
	I64Load value+0(FP)
	I32WrapI64
	I64Const $call_function_pointer(SB)
	I64Const $16
	I64ShrU
	I32WrapI64
	CallIndirect $0
	I64ExtendI32S
	Set R0
	MOVD R0, ret+8(FP)
	RET
