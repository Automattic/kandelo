# KMS cursor position transport

The display Worker can advance an already visible KMS cursor while the same
device relay is still capturing or waiting for acknowledgement of the primary
image. The cursor update carries its version and coordinates and uses the
last published device-owned image. A change to the cursor image, visibility,
extent or color composition still uses the existing cursor update path.
The relay admits one independent position at a time on the existing ordered
port and sequence. Retirement waits for capture settlement and both published
transfers before clearing the display.

## Desktop comparison

The test used trusted pointer moves across five fitted tiles on grouped Sway
at 2634 × 1806, DPR 2. Both arms used the same packaged process Worker, fork
initialization kernel and partial shell image on the frozen desktop based
on `dffcfca5325666d5e02cacdef03d4f14893a4584` with the preceding input and
scanout work applied. The control already drew owned cursor pixels on a
separate device plane. The candidate applies the position transfer above.

| Browser, 400 ms between moves | Matching device paints per arm | Median offer to relay send |
| --- | ---: | ---: |
| Installed Firefox 161 | 8/8 | 50.15 → 0.02 ms |
| Playwright WebKit | 8/8 | 8.90 → 0.04 ms |
| Chromium, candidate only | 8/8 | 0.02 ms |

The timestamp at the end of transmission comes from the relay. Its interval
excludes compositor and monitor refresh time. The exact transport moved all
eight cursor positions on each engine. An additional Firefox attempt timed
out waiting for the five tiles before measuring 100 ms pointer spacing.
Earlier paired prototypes at that spacing recorded all eight Sway input
reads in each arm and six corresponding cursor plane versions and paints.
This leaves a separate source of pointer lag before the relay. Physical
Safari and the complete benchmark matrix were outside this comparison.
