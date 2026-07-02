# wasm32 -O2 ESTACK/WSTACK Risk Audit — Erlang/OTP 28.2 ERTS

Bead: `kd-jin7` (impl of `kd-r8h7` design, step 1 — Layer B2 audit).
Date: 2026-07-02. No repo change; this is the enumeration that prioritizes the
Layer A smoke matrix and any future per-file `-O1` decision.

## Method

Source: `otp_src_28.2.tar.gz` (the exact tarball `build-erlang.sh` fetches for
`OTP_VERSION=28.2`; `package.toml [source]` pins `OTP-28.2`, sha256
`b984f9e0…d141f`). Grepped the raw ERTS emulator source (no wasm build needed
— the audit only reads C source):

```sh
# from erts/emulator/beam
grep -rlE 'DECLARE_ESTACK|DECLARE_WSTACK|WSTACK_DECLARE|ESTACK_DECLARE' .
```

Raw output committed alongside this file: `audit-grep-raw.txt`.

## The idiom is broader than "ESTACK/WSTACK"

The bug class is "a control struct whose pointer fields alias a **shadow-stack
local array**, initialized by aggregate/compound-literal assignment, then walked
by a push/pop loop." In ERTS that shape appears under **four** macro/coding
families, not just the two the design named:

| Idiom family        | Declared by                     | Example users |
| ------------------- | ------------------------------- | ------------- |
| `ESTACK` (Eterm)    | `DECLARE_ESTACK`                | utils.c, external.c, copy.c |
| `WSTACK` (UWord)    | `WSTACK_DECLARE`/`DECLARE_WSTACK` | erl_map.c, erl_term_hashing.c |
| `EQUEUE` (Eterm)    | `DECLARE_EQUEUE`                | erl_iolist.c, erl_io_queue.c (3 users) |
| `DMC_STACK`         | match-compiler local stack      | erl_db_util.c (192 ops) |
| function-recursive traversal (not a declared stack) | hand-rolled | erl_db_hash.c `match_traverse` |

`DEF_ESTACK_SIZE == DEF_WSTACK_SIZE == DEF_EQUEUE_SIZE == 16` (global.h). The
on-C-stack default array holds 16 slots; only when a term is deep/large enough
to overflow 16 does ERTS switch to the heap-backed stack whose miscompiled
push/pop loop is the failure. **Consequence for Layer A: every smoke input must
exceed 16 in the relevant dimension** (nesting depth, list length, map arity,
iolist fragment count) or it never enters the buggy path.

## The two defect facets (why the global.h patch is necessary but not sufficient)

1. **Aggregate init** (facet 1) — fixed globally by
   `patches/patch-global-h.py`, which replaces the struct-literal init of
   `ESTACK_DEFAULT_VALUE` / `DECLARE_ESTACK` / `WSTACK_DEFAULT_VALUE` /
   `WSTACK_DECLARE` with explicit field-by-field assignment under
   `#ifdef __wasm32__`. Covers every ESTACK/WSTACK user. Does **not** cover
   EQUEUE or DMC_STACK (they are not wrapped) — a latent gap noted below.
2. **Traversal codegen** (facet 2) — NOT fixed by init. `-O2` still miscompiles
   the push/pop/pointer-arithmetic loop in specific functions; this is what the
   per-file `-O1` Makefile downgrades address. A file can be correctly
   initialized (facet 1) and still wrong in its loop (facet 2), so idiom-use is
   a **risk marker, not a proof of breakage**, and correct init does not retire
   the risk.

`patches/patch-db-bounds-check.py` (`wasm_db_ptr_valid` in erl_db_util.c) is an
orthogonal third mitigation: it turns a miscompiled OOB *trap* into a controlled
failure. It bounds blast radius; it does not make results correct.

## At-risk surface (15 sites), ranked by user-facing risk

Ops = count of declare+push macro invocations in the file (proxy for how
stack-heavy it is). Function attribution confirmed by grep.

### Already handled on this convoy base (origin/main, f4339836e)

| File | Ops | Workaround today | Facet | Notes |
| --- | --- | --- | --- | --- |
| erl_unicode.c | 12 | `-O1` | traversal | Known-hit: iodata→list returns garbage. Uses ESTACK. |
| erl_db_util.c | 17 (ESTACK) + DMC_STACK | `-O1` + bounds guard | traversal + trap | Known-hit: `db_is_fully_bound` OOB. Heavy DMC_STACK (192 ops). |
| erl_db_hash.c | — (no declared idiom) | `-O1` | traversal | Known-hit: `match_traverse` corruption. **Not an ESTACK decl site** — reactive `-O1` on a hand-rolled traversal. |
| erl_db.c | — (no declared idiom) | `-O1` | (consistency) | `-O1` only "for consistent ETS optimization level" per build comment; **no confirmed miscompile of its own**. |
| erl_bif_chksum.c | 3 | `-O1` **via PR #824 (kd-qe2c)** | traversal | Known-hit: `do_chksum` over iodata → md5/crc32/adler32 garbage → broke `beam_asm` MD5-of-iolist → on-Kandelo `erlc` unusable. **Not yet on origin/main**; arrives with PR #824. |
| global.h | 15 | init patch (facet 1) | init | The global aggregate-init fix; covers ESTACK/WSTACK for all users. |

### HIGH — pervasive, hot, failure = silent wrong result; unaudited by smoke

| File | Ops | Function(s) | Why high |
| --- | --- | --- | --- |
| erl_map.c | 36 | map build/compare/iter | Highest idiom density; maps back ETS keys, records, JSON-ish data. |
| external.c | 30 | `enc_term`/`dec_term`/`encode_size_struct` | `term_to_binary`/`binary_to_term`; distribution + persistence. Design-named gap. |
| erl_term_hashing.c | 30 | `make_hash`/`make_hash2` | **NEW — not in design's guess.** `erlang:phash/2`, `phash2/1`, and *internal* hashing for maps/ETS. Extremely hot and pervasive; a wrong hash silently corrupts map/ETS lookup. |
| utils.c | 23 | `eq`, `cmp`/`erts_cmp` | Term equality/ordering; underlies `==`, `<`, `lists:sort`, map key compare. Design-named. |

### MEDIUM

| File | Ops | Function(s) | Why medium |
| --- | --- | --- | --- |
| erl_printf_term.c | 16 | term printer | `io_lib:format("~p"/"~w")`; wrong output is visible but not silent corruption. |
| copy.c | 10 | `copy_struct`/`size_object` | Message send + `binary_to_term` sizing; hot but simpler traversal. Design-named. |
| erl_proc_sig_queue.c | 6 | signal-queue walk | Inter-process signals; deep queues rare. |
| erl_iolist.c | 5 | iolist size/collect (EQUEUE) | **Iodata class** — same family as the chksum/beam_asm hit; `iolist_to_binary`, `iolist_size`. |
| erl_io_queue.c | 5 | driver io-queue (EQUEUE) | Iodata via driver path. |

### LOW / incidental

| File | Ops | Note |
| --- | --- | --- |
| io.c | 2 | error/format helper use; not a term-walk hot path. |
| erl_process.c | 2 | scheduler bookkeeping; not term-data-dependent. |

## Corrections to the design's *guessed* candidate list

The design explicitly said "confirm with the grep above; do not treat this list
as authoritative." The audit confirms and corrects it:

- **Confirmed HIGH:** utils.c, external.c, copy.c — all present and idiom-heavy. ✔
- **Confirmed MEDIUM:** erl_map.c, erl_printf_term.c — present. ✔
- **REFUTED:** `erl_bif_binary.c` and `erl_bif_re.c` — the design listed both as
  medium, but **both have zero ESTACK/WSTACK/EQUEUE usage**. They traverse via
  other mechanisms; they are not this idiom and should be dropped from the
  idiom-coverage matrix (they may still merit separate scrutiny, but not here).
- **ADDED (missed by the design):** `erl_term_hashing.c` (HIGH — phash/phash2 +
  internal map/ETS hashing), `erl_iolist.c` / `erl_io_queue.c` (EQUEUE, the
  iodata class that actually produced the worst known bug), and
  `erl_proc_sig_queue.c`.
- **Clarified the "handled" set:** only erl_unicode.c, erl_db_util.c, and
  erl_bif_chksum.c(#824) are ESTACK/DMC idiom sites with a confirmed
  miscompile. `erl_db_hash.c` is a hand-rolled `match_traverse` (reactive `-O1`,
  no declared idiom) and `erl_db.c` is `-O1` purely for consistency with no
  confirmed defect of its own.

## Latent gaps this audit surfaces (for follow-up, not this bead)

1. **EQUEUE and DMC_STACK are not covered by the facet-1 init patch.** The
   global.h patch only wraps ESTACK/WSTACK. `DECLARE_EQUEUE` (erl_iolist.c,
   erl_io_queue.c) and the DMC match stack (erl_db_util.c) use the same
   shadow-stack-local-array shape but keep the stock aggregate init. If facet 1
   ever bites them, it is unpatched. Worth a targeted review.
2. **Proactive `-O1` is NOT recommended for the HIGH files** (utils.c, copy.c,
   erl_term_hashing.c are hot paths; `erl_gc.c`-class reasoning applies). Prefer
   detection (Layer A) + upstream (Layer C). No proactive downgrade without a
   measured perf delta (design step 6).

## Output → Layer A coverage requirement

The smoke matrix (step 3) must hit every HIGH file at least once with inputs
> 16 in the relevant dimension:

- utils.c → deep term `==` + `lists:sort` of heterogeneous deep terms.
- external.c → `term_to_binary`/`binary_to_term` round-trip on a deep nested term.
- erl_term_hashing.c → `phash2` of a deep nested term (oracle from native OTP).
- erl_map.c → large map (>16 keys) build/compare, exercised via sort/compare.
- Plus the known-hit regression guards: unicode, chksum (behind #824), ETS match.
- iodata (erl_iolist.c) → deep `iolist_to_binary` / `iolist_size`.
