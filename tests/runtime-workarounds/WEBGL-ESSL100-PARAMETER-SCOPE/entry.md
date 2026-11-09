# GLSL ES100 function-body scope

## Defect

The native ES100 compiler rejects a local variable with a parameter's name
in the function's outer compound statement. GLSL ES1.00 revision17 §4.2.2
places that body inside the parameter scope; GLSL ES3.00 instead combines
parameters and body. The internal compiler or driver component responsible is not established;
the reproduction establishes only the WebGL runtime behavior.

## Why Kandelo is affected

The GLES2 conformance cases `local_variable_hides_function_parameter` in
both shader stages exercise this ES100 rule. Kandelo uses native ES100
validation before translating Appendix A restrictions to ES300.

## Workaround and its cost

On a failed ES100 compile, preserve original tokens and insert a child
compound statement inside function bodies, then ask the same ES100
validator again. ES300 translation preserves that child scope too. Keep
all same-scope redeclarations invalid. The extra work is compile-only;
no draw or frame queries are added. Compilation cost is not benchmarked.

## Evidence

The standalone page uses no Kandelo code. It tests both shader stages,
an explicitly nested positive control, and a same-scope duplicate-local
negative control. The normal registry driver reproduces both stages on Playwright
Chromium153.0.8010.12, Firefox155.0 and WebKit26.6 on macOS on
2026-11-05. All positive and negative controls retain their expected
compile results. These are development builds; released browsers, Linux
and Windows have not been checked. The original private probe also contains the
Kandelo compile path and is evidence only, not this reproduction.

## Why this is not a Kandelo defect

The page passes GLSL directly to WebGL2. The local variable is accepted
once explicitly nested, and duplicate locals remain rejected. The GLSL
ES1.00 specification distinguishes body and parameter scopes:
https://www.khronos.org/files/opengles_shading_language.pdf §4.2.2.

## Draft upstream report

Title: ES100 frontend merges parameter and function-body scopes

Compile `int f(int inp,int x){int x=5;return inp+x-5;}` in a shader
with `#version 100`. Expected: successful compilation with independent
local `x`. Actual: redefinition error. Explicitly nesting the body works.
Attach `repro/repro.html`. No upstream report has been filed.

## Removal criteria

When supported released engines accept the standalone source with both
controls intact, remove native scope normalization for their ES100 path.
Keep the ES300 translation's child scope: that language intentionally has
a different function-scope rule.
