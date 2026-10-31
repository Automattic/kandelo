# Cage initial display scale

The port selects Cage's initial scale from the chosen mode's pixel dimensions
and the connector's physical millimetres, using the same distribution policy
as Sway and Labwc: round the lower panel-axis DPI divided by96, with minimum1.
Unknown, invalid and aspect-only physical dimensions retain scale1. Explicit
later output-management requests preserve their chosen scale.

The combined initial mode/scale is tested before commit. Cursor themes are
loaded with the committed scale, then the output joins the layout. Rejected
states do not reach the commit or layout; failed commits do not load a cursor
or add an output. The cursor bitmap comes from the normal shared Xcursor data
package in the shell image. This policy does not alter connector metadata or
scale pixels in the browser host.

The focused native control extracts the actual pinned upstream
`handle_new_output`, `handle_output_request_state` and scale helper. It
executes54 existing/preferred/fallback-mode density cases, explicit later
scale changes and three backend failure controls. Running the unpatched
source must fail; normal package builds run the patched source control.

```sh
scripts/dev-shell.sh bash packages/registry/cage/tests/check-output-scale.sh \
  /path/to/patched/cage/output.c /path/to/owned/control-directory
```

Native controls do not prove normal guest/browser HiDPI behavior. Rebuild the
normal packages/image, then verify the actual output and client buffer scales,
readable native-pixel rendering, pointer/click geometry and session teardown.
