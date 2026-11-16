# Shared-memory desktop baseline

This record supports the [preview contract](../shared-memory-groups.md).
It distinguishes the isolated experiment from the shipping integration target.
It does not claim that the contract's release gates have passed.

## Failure and reproduction

The ordinary desktop contains Sway, Foot, Swaybg, wayland-demo and the Bibata
cursor theme. The normal package composition command is:

```sh
scripts/dev-shell.sh ./run.sh partial shell sway foot wayland-demo swaybg bibata-cursor-theme
```

At a 3072x1728 display mode, start Sway with the shipped configuration and
GLES renderer. Start two Foot terminals on workspace 1, allowing them to tile.
Move the focused terminal to workspace 2 while keeping workspace 1 selected,
then switch between workspaces and move the terminal back. This changes terminal
geometry from tiled to full-width; hiding an otherwise unchanged surface is
not the cause being asserted.

In the recorded ordinary run, Sway requests a 20,469,696-byte shared mapping
and receives ENOMEM at the existing I/O admission limit. The live admission
peak is 132,120,562 bytes against a 132,120,576-byte live allowance; the total
allowance is 134,217,728 bytes including writeback headroom. One terminal loses
its Wayland connection. Reproductions with the ordinary kernel and with the
isolated diagnostic kernel show the same pattern.

Foot's wasm32 build uses its unlinked temporary-file fallback in Kandelo tmpfs;
this path is not a memfd demonstration. Swaybar also uses a /dev/shm pool.
Admission charges, mirrored file-mapping snapshots, logical mapped bytes and
physical backing are separate quantities; they must not be added together as
independent copies. GPU storage and upload costs are separate again.

The original report did not identify the user's exact browser, dimensions or
terminal count. These are controlled reproductions of that failure pattern.
Rebuilding today's main is a new baseline run, not proof that it is byte-for-byte
the recorded artifact cohort.

## Experimental comparison

The research branch is represented by [draft PR1720](https://github.com/Automattic/kandelo/pull/1720).
The later desktop and pthread candidate is an isolated checkout based on
5d05771f28fc805e3267f061c669a8d6fd8538b5; it is not the contents of main and is
not wholly represented by that draft PR. The research implementation is
material for extraction, not a single merge unit.

The candidate promotes fixed-size whole tmpfs objects into one physical group
backing. Compatible mappings alias those pages rather than retaining separate
coherence snapshots. It rejects operations it cannot implement, including
descriptor content I/O after promotion and resizing. The complete shared-object
contract remains integration work.

The later format-4 candidate passes the 3072x1728 Sway/two-Foot screen on
Chromium 153.0.8010.12, Firefox 155.0 and Playwright WebKit 26.6: real keyboard
input to shell output, six workspace split/retile cycles, compositor exit and
machine destruction. This proves capacity value for that workload with unchanged
renderer and limits. It is not native Safari evidence or full desktop endurance
acceptance.

| Frozen input | Identity |
|---|---|
| Source base | 5d05771f28fc805e3267f061c669a8d6fd8538b5 |
| Program ABI | 56 |
| Private host adapter | 15 |
| Translated contract | Format 4; thread attach 2; cooperative stop 2; ordered wait queue 1 |
| Kernel SHA-256 | 4f70f0f8aed655a99464c41f7ffb4000e0e4d97f33c24e06996d8fe7f84381a2 |
| Grouped desktop image SHA-256 | 3edabbcff45286ff2b0bebecac8757b48822c3352e75c466b2b10d54c2198e3d |
| Ordinary paired image SHA-256 | 7e407066772a0abb1a8f97d3948ed7aef612a304d39626bceb2154d0f05dd0af |
| Retained experiment archive SHA-256 | 77091f887761b9e38420aa93c83f161dd2e9e0b6f870c58d308308b45ec4a957 |

The local retained archive is
`.context/grouped-pthread-20261115/checkpoint-1.zip`, with content-addressed
payloads, 1,102 logical files and 336 verified final source inputs. Its manifest
contains source, fixtures, binaries and raw results, including failed screens.
It is retained workspace evidence, not a publicly downloadable release asset.
The research harness's baseline command was:

```sh
# Requires the matching research source and artifacts from that manifest.
scripts/dev-shell.sh bash -c '
export KANDELO_DESKTOP_HOST="$PWD/.scratch/grouped-pthread-host-5"
export KANDELO_DESKTOP_KERNEL="$PWD/.scratch/grouped-pthread-kernel-1/kandelo-kernel.wasm"
export KANDELO_DESKTOP_IMAGE="$PWD/.scratch/grouped-pthread-desktop-images-1/grouped.vfs.zst"
export KANDELO_DESKTOP_OUTPUT="$PWD/.scratch/grouped-desktop-reproduction"
export KANDELO_COMMON_MEMORY_ARTIFACTS="$KANDELO_DESKTOP_OUTPUT"
export KANDELO_DESKTOP_WIDTH=3072 KANDELO_DESKTOP_HEIGHT=1728
export KANDELO_DESKTOP_TWO_VISIBLE_FIRST=1
node apps/browser-demos/node_modules/@playwright/test/cli.js test \
  --config tools/desktop-shared-memory/playwright.config.ts baseline.spec.ts --project=chromium
'
```

This is provenance, not a supported main-branch launcher. The integration series
must supply a normal build/run path and a committed equivalent pressure fixture.

## Remaining resource question

Earlier format-3 measurements at 1920x1080 found usable scripted interaction
and higher reported total browser footprint for the grouped candidate. Those
timings cannot be attributed to format 4's new ordered wait protocol.
The physical group remains 512 MiB pregrown and each thread has translation
scratch. A raw memory.grow stress still advances the physical high-water extent
despite exact release of all roots, pins and wait records.

The next comparison must measure the current candidate and address sustained
allocation reuse. Record idle, interaction, resize and teardown separately;
preserve failed runs and startup costs. Capacity improvement alone is useful,
but it is not evidence of lower total resident RAM. The eventual integrated
candidate also needs comparison with its actual target branch at a pinned SHA.
