/**
 * Single source of truth for the wasm32 `-O2` miscompilation smoke matrix.
 *
 * Background: LLVM's wasm32 backend miscompiles ERTS's shadow-stack work-stack
 * idiom (ESTACK/WSTACK/EQUEUE/DMC_STACK) at `-O2`. `build-erlang.sh` works
 * around known cases with per-file `-O1` + a `global.h` init patch; the full
 * registry is `packages/registry/erlang/wasm32-miscompilations.md`. This matrix
 * is the *detection* layer: it exercises each at-risk term/iodata operation
 * with inputs large enough to force the heap-backed stack path and asserts the
 * exact result a correct BEAM must produce.
 *
 * Consumed by TWO runners so coverage never drifts between them:
 *   - Local/dev: `erlang.test.ts` (vitest), `skipIf` no local build.
 *   - CI gate:   `test/run-wasm32-miscompilation-smoke.mjs`, run in the
 *     bottle-build/smoke job where the OTP runtime tree is present.
 *
 * ORACLE PROVENANCE: every `expected` is the `~w` rendering of the result
 * computed on native Erlang/OTP 28 (validated on ERTS 16.4; these operations
 * are format-stable across OTP 28.x). The md5/crc32/adler32 oracle was
 * additionally cross-checked byte-for-byte against Python hashlib/zlib. To
 * re-derive on an OTP bump, re-run the generator described in the registry's
 * "Re-audit trigger" section and update any value that legitimately changes.
 *
 * INPUT SIZING: `DEF_ESTACK_SIZE == DEF_WSTACK_SIZE == DEF_EQUEUE_SIZE == 16`,
 * so every input nests/contains > 16 elements — otherwise the operation stays
 * on the inline fast path and never reaches the miscompiled loop. Each case's
 * `why` records the dimension that clears 16.
 */

export interface SmokeCase {
  /** Stable machine name; appears in `ok <name>` / `FAIL <name>` output. */
  name: string;
  /** Which ERTS translation unit / operation this drives. */
  exercises: string;
  /**
   * An Erlang expression sequence (the body of a `fun() -> ... end`) that
   * evaluates to a compact term. MUST stay byte-identical to the oracle
   * generator so `expected` remains valid.
   */
  expr: string;
  /** `~w` string of the correct result, from native OTP 28. */
  expected: string;
  /** Why the input exceeds the 16-slot inline threshold. */
  why: string;
  /**
   * If set, the guarding `-O1`/patch is not yet on `origin/main` (it arrives
   * with this PR), so the case is *skipped* rather than run — running it on a
   * base without the workaround would fail by design. Flip to run once the PR
   * lands. See the registry's "PR #824 sequencing" note.
   */
  pendingPr?: number;
  /** Extra `-pa` code paths the case needs beyond kernel+stdlib (CI runner). */
  needsCodePath?: string[];
}

export const OTP_ORACLE_VERSION =
  "OTP 28.2 (oracles validated on ERTS 16.4; results format-stable across OTP 28.x)";

export const cases: SmokeCase[] = [
  {
    name: "term_to_binary_roundtrip",
    exercises: "external.c (enc_term/dec_term, WSTACK)",
    expr: `T = lists:foldl(fun(I,A) -> {I,A} end, nil, lists:seq(1,500)),
{binary_to_term(term_to_binary(T)) =:= T, byte_size(term_to_binary(T))}`,
    expected: "{true,2741}",
    why: "500-deep nested 2-tuple; encode/decode WSTACK depth >> 16",
  },
  {
    name: "unicode_deep",
    exercises: "erl_unicode.c (iodata traversal, ESTACK) [known-hit -O1]",
    expr: `L = lists:duplicate(50, [16#1F600, <<"héllo"/utf8>>, "abc"]),
B = unicode:characters_to_binary(L),
{byte_size(B), lists:sum(binary_to_list(B))}`,
    expected: "{650,88400}",
    why: "50-element list of mixed codepoint/binary/string fragments (> 16)",
  },
  {
    name: "chksum_iolist",
    exercises: "erl_bif_chksum.c (do_chksum over iodata) [known-hit -O1 via PR #824]",
    expr: `IO = lists:duplicate(100, <<"kandelo">>),
{erlang:md5(IO), erlang:crc32(IO), erlang:adler32(IO)}`,
    expected:
      "{<<140,120,254,181,217,34,17,213,230,74,169,247,123,44,26,193>>,2948946130,2665225928}",
    why: "100-fragment iolist (> 16); md5 broke beam_asm in kd-qe2c",
    pendingPr: 824,
  },
  {
    name: "ets_match",
    exercises: "erl_db_util.c / erl_db_hash.c (DMC stack, match_traverse) [known-hit -O1]",
    expr: `T = ets:new(jin7_ets, [bag]),
[ets:insert(T, {K, K*K, "v"}) || K <- lists:seq(1,100)],
R = ets:select(T, [{{'$1','$2','_'}, [{'>','$2',2500}], ['$1']}]),
ets:delete(T),
{length(R), lists:sum(R), lists:min(R), lists:max(R)}`,
    expected: "{50,3775,51,100}",
    why: "100-row table, match spec selects K where K*K>2500 (K in 51..100)",
  },
  {
    name: "term_compare_sort",
    exercises: "utils.c (eq/cmp, ESTACK) + erl_map.c (WSTACK)",
    expr: `L = [ {I rem 7, #{a => I, b => lists:seq(1, I rem 20)}, [I | lists:seq(1, I rem 25)]}
      || I <- lists:seq(1,100) ],
S = lists:sort(L),
{S =:= lists:sort(lists:reverse(L)), erlang:phash2(S)}`,
    expected: "{true,45350027}",
    why: "100 heterogeneous deep terms (tuples/maps/lists) drive cmp beyond 16",
  },
  {
    name: "phash2_deep",
    exercises: "erl_term_hashing.c (make_hash2, WSTACK)",
    expr: `T = lists:foldl(fun(I,A) -> {I, A} end, done, lists:seq(1,300)),
erlang:phash2(T)`,
    expected: "64685795",
    why: "300-deep nested tuple; make_hash2 WSTACK depth >> 16",
  },
  {
    name: "copy_large_term",
    exercises: "copy.c (copy_struct/size_object, ESTACK)",
    expr: `T = lists:foldl(fun(I,A) -> {I, A} end, nil, lists:seq(1,400)),
S = self(),
P = spawn(fun() -> receive X -> S ! erlang:phash2(X) end end),
P ! T,
H = receive R -> R after 5000 -> timeout end,
{H =:= erlang:phash2(T), H}`,
    expected: "{true,60113841}",
    why: "400-deep term copied via closure capture + message send (copy_struct)",
  },
  {
    name: "format_p_deep",
    exercises: "erl_printf_term.c (term printer stack)",
    expr: `Str = lists:flatten(io_lib:format("~w", [lists:seq(1,100)])),
{length(Str), erlang:phash2(Str)}`,
    expected: "{293,100105088}",
    why: "printing a 100-element list walks the printer stack past 16",
  },
  {
    name: "iolist_to_binary_deep",
    exercises: "erl_iolist.c (EQUEUE iodata traversal)",
    expr: `L = lists:foldl(fun(I,A) -> [<<I:8>>, A, "x"] end, [], lists:seq(1,100)),
B = iolist_to_binary(L),
{byte_size(B), binary:first(B), binary:last(B), erlang:iolist_size(L)}`,
    expected: "{200,100,120,200}",
    why: "100-deep nested iolist; EQUEUE traversal depth >> 16",
  },
  {
    name: "compile_module",
    exercises: "beam_asm (MD5-over-iolist) + general term traversal [end-to-end]",
    expr: `Scan = fun(Str) ->
        {ok,Ts,_} = erl_scan:string(Str),
        {ok,F} = erl_parse:parse_form(Ts),
        F
    end,
Forms = [ Scan("-module(jin7t)."),
          Scan("-export([f/1])."),
          Scan("f(N) -> lists:sum(lists:seq(1,N)).") ],
{ok, jin7t, Bin} = compile:forms(Forms, [binary]),
code:load_binary(jin7t, "jin7t.beam", Bin),
{jin7t:f(100), is_binary(Bin), byte_size(Bin) > 100}`,
    expected: "{5050,true,true}",
    why: "on-platform compile; beam_asm MD5s BEAM chunks as an iolist (kd-qe2c)",
    pendingPr: 824,
    needsCodePath: ["lib/compiler-9.0.3/ebin"],
  },
];

/** Cases whose workaround is on the current base and should run now. */
export function activeCases(all: SmokeCase[] = cases): SmokeCase[] {
  return all.filter((c) => !c.pendingPr);
}

/** Cases deferred behind an unmerged PR (reported as expected skips). */
export function pendingCases(all: SmokeCase[] = cases): SmokeCase[] {
  return all.filter((c) => c.pendingPr);
}

/**
 * Build a single Erlang `-eval` program that runs every case in ONE BEAM boot
 * (BEAM startup dominates cost, so batching keeps the CI gate cheap). Active
 * cases print `ok <name>` or `FAIL <name> expected=.. got=..`; pending cases
 * print `skip <name> pending_pr_<n>`; a final `matrix_done <n>` sentinel proves
 * the program ran to completion (so a truncated/among-missing run is detectable,
 * satisfying "fail on unexpected skip").
 */
export function buildBatchProgram(all: SmokeCase[] = cases): string {
  const lines: string[] = [];
  lines.push(
    `Run = fun(Nm, Fun, Exp) ->` +
      ` Got = try lists:flatten(io_lib:format("~w", [Fun()]))` +
      ` catch Cls:Err -> lists:flatten(io_lib:format("caught_~w_~w", [Cls, Err])) end,` +
      ` case Got =:= Exp of` +
      ` true -> io:format("ok ~s~n", [Nm]);` +
      ` false -> io:format("FAIL ~s expected=~s got=~s~n", [Nm, Exp, Got])` +
      ` end end,`,
  );
  for (const c of all) {
    if (c.pendingPr) {
      lines.push(
        `io:format("skip ~s pending_pr_~w~n", ["${c.name}", ${c.pendingPr}]),`,
      );
    } else {
      lines.push(`Run("${c.name}", fun() ->\n${c.expr}\nend, ${JSON.stringify(c.expected)}),`);
    }
  }
  lines.push(`io:format("matrix_done ~w~n", [${all.length}]),`);
  lines.push(`halt().`);
  return lines.join("\n");
}

/** Line-oriented result of one batch run. */
export interface BatchResult {
  completed: boolean; // saw `matrix_done <n>` with matching n
  ok: Set<string>;
  skipped: Map<string, number>; // name -> pendingPr
  failures: Map<string, string>; // name -> full FAIL line
}

/** Parse a batch run's stdout (which also contains serve.ts boilerplate). */
export function parseBatchOutput(stdout: string, expectedCount: number): BatchResult {
  const res: BatchResult = {
    completed: false,
    ok: new Set(),
    skipped: new Map(),
    failures: new Map(),
  };
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^ok (\S+)$/))) res.ok.add(m[1]);
    else if ((m = line.match(/^skip (\S+) pending_pr_(\d+)$/)))
      res.skipped.set(m[1], Number(m[2]));
    else if ((m = line.match(/^FAIL (\S+) /))) res.failures.set(m[1], line);
    else if ((m = line.match(/^matrix_done (\d+)$/)))
      res.completed = Number(m[1]) === expectedCount;
  }
  return res;
}
