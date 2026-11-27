# FreeType file access during Foot startup

On develop `dffcfca5325666d5e02cacdef03d4f14893a4584`, opening one Foot terminal in an already running Sway session opened Inconsolata five times. All five opens came from the new Foot PID. Its descriptors for that font accounted for 194 seeks and 149 vectored reads. Firefox and Playwright WebKit produced the same counts.

FreeType 2.13.3 revision 2 linked the generic stdio implementation of `ftsystem.c`. Its Unix configure probe tests fixed-address mapping replacement, which the font loader never requests and which the Kandelo build cannot confirm when cross-compiling. Revision 3 selects FreeType's own Unix file stream in the package recipe. It opens and stats the file, maps it read-only and private at a kernel-selected address, and closes the descriptor. A refused map takes the upstream whole-file read path. Closing the stream releases the mapping or the heap copy. This changes the access pattern of file-backed FreeType faces across clients. A live face can hold the entire file.

## File and glyph observations

Each desktop used `./run.sh partial shell bibata-cursor-theme desktop-data foot sway swaybg` and `./run.sh browser --partial`. The SDK, kernel and shell package selection matched. The served kernel SHA-256 was `62caee617cf7fd3aff5b17927ba6cb96fb5f796457757160118775475fe10d1a`. The control and candidate shell image digests were `b445f09b0a09724820adfbe1afb6f791b57834b5652273033c7e963ac93c058a` and `9172affac07a128bd434f11c85f0a34d820a1fb8f76fbc138318e082e193ffd0`. Each server used the lazy assets resolved for its own build.

| New Foot process, key to painted prompt | Revision 2 | Revision 3 |
| --- | ---: | ---: |
| Inconsolata opens | 5 | 5 |
| Seeks | 194 | 0 |
| Vectored reads | 149 | 0 |
| Private read-only mappings of the 105,628-byte font | 0 | 5 |

A separate SDK executable repeatedly opened the packaged font with `FT_New_Face`, set a 17-pixel size and rendered ASCII 32 through 126 with `FT_Load_Char(FT_LOAD_RENDER)`. Each of 12 iterations also rejected a six-byte truncated font and closed the good face. All binaries produced the same FNV-1a bitmap digest, `5f8732fc`, across 1,140 glyphs. A link-time test that refused all twelve full-font mappings with `ENOMEM` exercised the upstream read fallback and reproduced the digest.

The browser test timed guest spawn through exit in the real kernel on a cross-origin-isolated page, in control/candidate/candidate/control order. Earlier WebKit tests using a route-fulfilled harness page failed kernel initialization before any font opened. The same-origin harness ran on all three engines.

| Host | Revision 2 elapsed milliseconds | Revision 3 elapsed milliseconds |
| --- | ---: | ---: |
| Chromium | 487, 448 | 95, 86 |
| Firefox | 3,458, 2,744 | 885, 668 |
| Playwright WebKit | 749, 685 | 340, 128 |
| Node, separate one-run comparison | 5,487 | 568 |

## Visible terminal response

The display measured 2634 × 1806 pixels at device scale factor two. Starting from one fully painted terminal, the probe issued one or four Alt+Return keypresses. The interval starts at the first trusted key and ends at the first sample with dark terminal content, no exposed wallpaper and white prompt pixels in every expected tile. Sampling ran at roughly 180 ms intervals. These runs used the stock Sway configuration on both arms. Concurrent builds made scheduling variable.

| Browser | Additional terminals | Revision 2 seconds, two runs | Revision 3 seconds, two runs |
| --- | ---: | ---: | ---: |
| Firefox | 1 | 8.15, 5.25 | 4.61, 3.36 |
| Firefox | 4 | 12.39, 25.36 | 19.41, 12.83 |
| Playwright WebKit | 1 | 2.25, 2.14 | 2.37, 2.31 |
| Playwright WebKit | 4 | 8.44, 7.41 | 9.98, 7.15 |

Firefox's single-launch observations improved. The four-launch ranges overlap and WebKit's single-launch observations were slightly slower. Both packages still took seconds to produce terminal text. The measured saving is in file access and glyph loading. The desktop intervals also include starting the shell and Foot, negotiating Wayland surfaces and presenting the frame.

Chromium also painted all five prompts in 4.88 s on revision 2 and 4.70 s on revision 3, one run per arm. An initial ink-count detector timed out on both builds because an unfocused prompt contains fewer bright pixels than the focused one. The existing Chromium glyph-mask probe recognized the prompt in every tile and observed the cursor at all eight destinations.

## Desktop storage during repeated launches

Starting with one Foot, open four, wait for all five prompts, exit the four added terminals and repeat three times. Each sample uses the live kernel's group accounting. The values below are allocated 64 KiB pages after returning to one Foot and the highest page high-water mark observed in the entire run. The desktop and its other processes are included.

| Browser | Recipe | Allocated pages after each cycle | Group high-water pages |
| --- | --- | --- | ---: |
| Firefox | 2 | 2,001 / 1,999 / 2,131 | 4,055 |
| Firefox | 3 | 2,146 / 2,149 / 2,012 | 4,179 |
| Playwright WebKit | 2 | 1,997 / 2,005 / 1,999 | 3,994 |
| Playwright WebKit | 3 | 2,010 / 2,010 / 2,011 | 4,099 |

All twelve post-cycle samples above had eight execution images, ten tasks, zero quarantined replicas, zero pending wait drains and zero retained mapping references. The high-water increase was 124 pages in Firefox and 105 pages in WebKit. Live faces now map whole files, and the compositor and other guest processes also allocate from this group. The snapshots cannot isolate the font's share of the peak. Three cycles establish reclamation over these launches. An earlier candidate Firefox run reached its four-minute whole-test deadline during the second close sequence. Both Firefox arms above used a ten-minute whole-test budget with the same per-launch, exit, pixel and process assertions.
