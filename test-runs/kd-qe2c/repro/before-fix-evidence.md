# kd-qe2c — erlang:md5/1 iolist badarg — BEFORE-FIX evidence

Build under test: kd-fyqz-staged erlang.wasm (OTP 28.2 rev2, wasm32, base f4339836e),
erl_bif_chksum.c compiled at -O2 (unpatched). Run via demo/serve.ts under NodeKernelHost.

## Symptom matrix (erlang:md5/1)
| input                         | result                    |
|-------------------------------|---------------------------|
| <<"test">> (binary)           | OK <<9,143,...>>          |
| [] (empty list)               | OK (md5 of "")            |
| "abc" (byte list)             | badarg                    |
| [<<"abc">>] (list w/ binary)  | badarg                    |
| [[]] (list w/ empty list)     | badarg                    |
| [<<>>] (list w/ empty binary) | badarg                    |
| [<<"ab">>,"cd",[101]] (iolist)| badarg                    |

Empty list works because is_nil(ioterm) returns before touching the ESTACK-based
traversal; EVERY non-empty list fails — isolating the defect to do_chksum's list path.

## Shared do_chksum path — all fail on list, work on binary
crc32(<<"abc">>)=OK ; crc32("abc")=badarg
adler32("abc")=badarg
md5([97])=badarg
(erlang:md5, crc32, adler32 all funnel through do_chksum() in erl_bif_chksum.c)

## Control: other flatten paths (different C functions) handle the SAME lists fine
iolist_to_binary("abc") = <<"abc">>
list_to_binary("abc")   = <<"abc">>
iolist_size("abc")      = 3
=> term repr, is_byte, CAR/CDR, general list flattening are all correct.

## Downstream impact: on-Kandelo compilation is blocked
compile:forms([...module...],[binary,report_errors]) =>
  : internal error in pass beam_asm:
  exception error: bad argument
    in function  erlang:md5/1
       called as erlang:md5([<<255,255,255,251,208,...   (iolist of BEAM chunks)
    in call from beam_asm:build_file/8 (beam_asm.erl:383)
    in call from beam_asm:module/4 (beam_asm.erl:83)
    in call from compile:beam_asm/2 (compile.erl:2631)
COMPILE_RESULT = error

Direct probe of the same shape beam_asm uses:
  erlang:md5([<<"FOR1">>,<<0,0,0,4>>,"BEAM"]) = {'EXIT',{badarg, ...erlang:md5...}}

## Root cause
LLVM's wasm32 backend miscompiles do_chksum() in erts/emulator/beam/erl_bif_chksum.c
at -O2 (the same class already handled for erl_unicode.c "iodata traversal returns
garbage", erl_db_util.c, erl_db_hash.c in build-erlang.sh). do_chksum is compiled at
-O2 and was NOT in the -O1 list. Fix: compile erl_bif_chksum.c at -O1.
