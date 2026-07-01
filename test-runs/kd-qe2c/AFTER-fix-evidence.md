# kd-qe2c — erlang:md5/1 iolist — AFTER-FIX evidence

Build under test: freshly rebuilt erlang.wasm from patched build-erlang.sh
(erl_bif_chksum.c now compiled at -O1). Build log confirms:
  ==> Patched Makefile: erl_unicode.c, erl_bif_chksum.c, erl_db_util.c, erl_db_hash.c at -O1
local-binaries/programs/wasm32/erlang/erlang.wasm rebuilt (4310105 bytes).

## do_chksum BIFs now accept iodata (was badarg on any non-empty list)
md5_bin        = <<9,143,107,205,70,33,211,115,202,222,78,131,38,39,180,246>>   (md5 "test")
md5_list_abc   = <<144,1,80,152,60,210,79,176,214,150,63,125,40,225,127,114>>   (md5 "abc")
md5_eq_abc     = true    (erlang:md5("abc")  =:= erlang:md5(<<"abc">>))
md5_iolist     = true    (erlang:md5([<<"He">>,"ll",[111]," ",<<"world">>]) =:= erlang:md5(<<"Hello world">>))
md5_nil_in_list= true    (erlang:md5([[]])   =:= erlang:md5(<<>>))
crc32_list     = true    (erlang:crc32("abc")  =:= erlang:crc32(<<"abc">>))
adler32_list   = true    (erlang:adler32("abc")=:= erlang:adler32(<<"abc">>))

MD5 digests match the reference vectors (md5("")=d41d8cd9..., md5("abc")=90015098...,
md5("test")=098f6bcd...), so the fix is functionally correct, not merely non-crashing.

## On-Kandelo compilation now works (was: internal error in pass beam_asm)
compile:forms([...],[binary]) -> load_binary -> call  => FORMS_CALL=42
compile:file("/tmp/kd_qe2c_file.erl",[binary]) -> load -> call => FILE_CALL=on_kandelo
(both exercise beam_asm:build_file/8's erlang:md5/1 over the module chunk iolist)

## Host vitest (packages/registry/erlang/test/erlang.test.ts), host erlang build present
7 passed / 1 failed / 0 skipped (8 total)
  PASS  Erlang BEAM prints hello world
  PASS  Erlang BEAM evaluates arithmetic
  PASS  Erlang BEAM handles lists and pattern matching
  PASS  Erlang BEAM spawns lightweight processes
  PASS  Erlang md5 iodata (kd-qe2c) hashes a byte list the same as the equivalent binary
  PASS  Erlang md5 iodata (kd-qe2c) hashes a mixed iolist (binaries, strings, chars, nesting)
  PASS  Erlang md5 iodata (kd-qe2c) compiles and loads a module on Kandelo (beam_asm md5-over-iolist)
  FAIL  Erlang BEAM runs ring benchmark with message passing  [PRE-EXISTING, not kd-qe2c]
        ring:start() -> {undef,[{ring,start,...}]}: origin/main ships no ring.beam.
        Unrelated to md5; owned/fixed by open PR #820 (kd-fyqz). In CI (no host erlang
        build) all 8 tests skip via describe.skipIf(!hasErlang).

BEFORE-fix state for comparison: test-runs/kd-qe2c/repro/before-fix-evidence.md
(same serve.ts path: md5/crc32/adler32 on any non-empty list => badarg; compile:forms
=> internal error in pass beam_asm via erlang:md5/1).
