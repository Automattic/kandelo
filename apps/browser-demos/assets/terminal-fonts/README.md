The browser terminal normally loads the pinned Fontsource WOFF2 assets from
`apps/browser-demos/package-lock.json`. These supplemental fonts provide
combining marks, symbols and old Hangul jamo absent from those published
subsets. They derive from [Go Noto Current Regular v7.0](https://github.com/satbyy/go-noto-universal/releases/tag/v7.0)
and retain OpenType shaping tables for the retained glyphs. The combined
[font notices and OFL](../../public/terminal-fonts-OFL.txt) accompany the
browser app.

The three subsets are checked in so browser builds can use the pinned font
bytes without downloading the 15 MB source font or installing a font
subsetting toolchain.

To regenerate, download `GoNotoCurrent-Regular.ttf` from that release and run
the command below with FontTools 4.69.1 and Brotli 1.2.1 installed. The
generator checks the source digest before writing the three WOFF2 files.

```sh
python3 apps/browser-demos/assets/terminal-fonts/regenerate.py /path/to/GoNotoCurrent-Regular.ttf
```
