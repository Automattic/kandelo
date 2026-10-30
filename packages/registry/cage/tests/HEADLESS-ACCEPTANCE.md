# Bounded HiDPI acceptance after normal rebuild

Status: this plan is **unrun**. Native policy/parser/image controls do not
prove the preview's visible cursor is fixed. Root owns normal products,
three-engine sessions and combined browser-memory acceptance.

Use the normal canonical shell image and Cage/Sway/Labwc profiles so the new
lazy theme package and the actual client configurations are present. A bare
`sessionRootfs` fixture currently supplies only XKB/libinput and listed files;
it is insufficient evidence for the normal shell's theme without explicitly
adding the real package through the ordinary image writer. Reuse the launch,
input, two-plane display and diagnostics patterns in
`apps/browser-demos/test/wlroots-rendered-session.spec.ts`, and the gallery
machine selection in `gallery-current-machine.spec.ts`. Keep one bounded
focused selection, rather than cloning the entire gallery suite.

## Output and client scale

At a fixed640x480 CSS pane, run DPR1 and DPR2 with native modes640x480 and
1280x960 respectively, physical reference169x127mm (CSS96DPI). The test must
actually set those mode/mm dimensions through `kmsSetDisplaySize`, like the
normal KernelHost observer does; changing the Playwright DPR alone does not
change the raw helper's hardcoded640x480 KMS mode. Assert reported output scale1
and2, and client logical grid640x480. Record connector dimensions, CSS box,
DPR and framebuffer mode in the evidence.

The normal `wlclient-test` fixture already prints `OUTPUT_MODE`,
`OUTPUT_SCALE factor=N`, `SURFACE_ENTER scale=N`, `XDG_OUTPUT_SIZE` and
`FRACTIONAL_SCALE`; set `WLC_PROTOS=1 WLC_ENTERSCALE=1`. In Cage specifically,
assert scale2 reaches the surface before the first frame. Set ordinary
`WAYLAND_DEBUG=client` and assert the actual `wl_surface.set_buffer_scale(2)`
request before attach/commit. If this build disables that debug facility,
add one truthful fixture diagnostic after its actual call; do not infer the
buffer request solely from a source constant. The probe's existing200x150
physical buffer then covers100x75 logical pixels at2x. Assert the corresponding
rendered extent/configure rather than just that text looks larger. Preserve
explicit later output-management scale choices as a separate control.

## Actual cursor geometry

Measure both ownership paths at DPR1/2:

- Compositor-owned default/resize pointer over an empty desktop region or
  decoration; for kiosk Cage use its default pointer before a client cursor
  request. Confirm ownership with normal guest cursor/debug logs.
- Client-owned text cursor over a real Foot or GTK text region in each
  desktop; the native theme-parser control alone does not prove this path.
  Use Foot/GTK's normal `wl_pointer.set_cursor` and cursor-surface buffer
  scale/request logs to distinguish it from the compositor's pointer.

Read the actual transparent cursor plane's alpha bounding box, **not** its
64x64 padded KMS BO or the canvas element's full dimensions. A snapshot must
preserve alpha: temporarily hide the scene plane and use an otherwise
transparent backdrop plus `omitBackground:true`, leaving guest/cursor state
unchanged. Capture the cursor plane alone at device scale, then decode that
bounded PNG in a temporary non-guest canvas and compute min/max x/y for alpha
above a fixed threshold (for example8). Restore scene visibility immediately.
Do not substitute a screenshot of the composited opaque background, whose
alpha is1 everywhere. Do not transfer guest memory to the page to inspect it.

Assert nonempty alpha bounds and compare bbox.width/DPR and bbox.height/DPR
across DPR1/2 with a small rasterization tolerance (about2 CSS pixels). Record
raw device-pixel bounds as well. Real nominal24/48 image canvases are known;
transparent margins mean the visible silhouette is smaller. The old10x16
fixed fallback should fail this comparison and the minimum visible-size check.
Use the real24px package image's measured alpha bbox as that minimum, not an
arbitrary full24x24 rectangle. Move between background/text/resize shapes and
verify pointer tip/hotspot stays on the same intended click target; text
selection and a titlebar drag must still hit at both scales. Do not report
stutter improvement from size comparisons.

If a platform capture stalls or cannot preserve alpha, retain that failed
observation. Do not turn it into a pass using only stored guest dimensions.
The known external snapshot limitations remain visible in acceptance evidence.

At DPR3, default24 requests real72 data, which exceeds the truthful64 hardware
limit. Require successful ordinary software cursor fallback and correct
scene-composited silhouette/hotspot there; the separate hardware plane may be
empty. Compare cursor-region pixels over a known uniform client background
or stable before/after pointer positions instead of hiding the scene. This is
a distinct rendered fallback assertion; native loader size72 alone is not it.

## Lifecycle and evidence

Reuse ordinary clean compositor exits and exact master/worker release checks;
repeat a launch in the same host. Save engine/version and exact kernel,
compositor, client, image and cursor-ZIP hashes, mode/mm/output/buffer scale,
actual alpha bounds and representative screenshots. Run the existing combined
browser-memory cycle after integrating both cursor size and independent
cursor-motion repairs. Node compositor smoke gates remain required for host
parity. None of these results exists yet for this source change.
