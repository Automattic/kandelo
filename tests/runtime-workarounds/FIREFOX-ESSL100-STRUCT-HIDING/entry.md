# Firefox ES100 structure-type hiding

## Defect

The ES100 frontend in Playwright Firefox155.0 on macOS rejects a local
variable that hides a global structure type when its initializer uses a
nonconstant constructor: `int S = S(u).val;` or `S S = S(u);`.
GLSL ES1.00 revision17 §4.2 allows nested scopes to hide outer declarations.
The internal compiler or driver component responsible is not established.

## Why Kandelo is affected

Four GLES2 conformance cases exercise these two declarations in vertex
and fragment shaders. Native ES100 validation must accept the original
language before the Appendix A translation can run.

## Workaround and its cost

Only after native ES100 validation fails, alpha-rename the affected local
binding and its later lexical uses. The initializer retains the preceding
binding, and each comma declarator publishes its name after its initializer.
Keep global types, interfaces and member names intact. Same-scope duplicates
reuse the same private name so native validation still rejects them.

Macro or conditional bindings, local structure declarations, array declarators
and colliding parameter bindings are left to native validation: the lexical
proof does not establish their binding. This work occurs during compilation;
there are no extra draw or frame queries. Compilation cost is not benchmarked.

## Evidence

The standalone page uses WebGL2 directly, with no Kandelo code. A dynamic
uniform drives each constructor: constant constructors can conceal this
failure. Both stages exercise scalar and aggregate local variables, a renamed
positive control, and a duplicate-local negative control.

On macOS on 2026-11-05, the normal browser-page driver reproduced both patterns
in both stages on Firefox155.0. Chromium153.0.8010.12 and WebKit26.6 accepted
the original source. Every positive and negative control retained its expected
result on all three engines. These are development builds; released browsers,
Linux and Windows have not been checked.

## Why this is not a Kandelo defect

The standalone source fails through WebGL without the Kandelo translator.
Renaming only the local variable restores compilation. The reference scope
rule is GLSL ES1.00 revision17 §4.2:
https://www.khronos.org/files/opengles_shading_language.pdf.

## Draft upstream report

Title: ES100 local variable hiding a structure type rejects dynamic constructor

Compile `uniform int u; struct S { int val; };` and, inside a function,
`int S = S(u).val;` or `S S = S(u);`. Expected: the initializer sees the
outer structure constructor, and subsequent expressions see the local.
Actual: Firefox reports a syntax error at `)` or `.`. Explicitly renaming
the local compiles. Attach `repro/repro.html`. No upstream report is filed.

## Removal criteria

When supported released Firefox accepts both original declarations with all
controls intact, remove the failed-native-compile local-binding normalization.
Retain source and pixel controls for guest ES100 lexical scope behavior.
