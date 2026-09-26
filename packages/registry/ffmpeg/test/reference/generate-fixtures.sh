#!/usr/bin/env bash
# Regenerate the committed FFmpeg fixtures and native reference outputs.
# Run only when a fixture or reference must change; commit the results.
# The commands here must stay identical to the ones the tests run; the
# fixtures README records them.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../fixtures"
BIN="${KANDELO_FFMPEG_NATIVE_PREFIX:-$HOME/.cache/kandelo/ffmpeg-native-9.0}/bin"
FF="$BIN/ffmpeg"; FP="$BIN/ffprobe"
BBB="${KANDELO_FFMPEG_MEDIA_CACHE:-$HOME/.cache/kandelo/ffmpeg-test-media}/BigBuckBunny_320x180.mp4"
BX=(-flags +bitexact -fflags +bitexact)
mkdir -p "$OUT"

# 2 s, 176x144, 10 fps MPEG-4 Part 2 with B-frames + 22.05 kHz mono AAC.
# Native encoders only, single-threaded encode for a deterministic bitstream,
# moov first (+faststart) so the file is readable from a pipe.
"$FF" -nostdin -y -v error \
  -f lavfi -i testsrc=duration=2:size=176x144:rate=10 \
  -f lavfi -i sine=frequency=440:beep_factor=4:duration=2:sample_rate=22050 \
  -threads 1 -c:v mpeg4 -q:v 5 -g 5 -bf 1 \
  -c:a aac -b:a 32k -ac 1 \
  "${BX[@]}" -map_metadata -1 -movflags +faststart \
  "$OUT/fixture.mp4"

"$FP" -v error -show_entries \
  stream=index,codec_name,codec_type,width,height,pix_fmt,sample_rate,channels \
  -of json "$OUT/fixture.mp4" > "$OUT/fixture.ffprobe.json"
"$FF" -nostdin -v error -threads 1 -i "$OUT/fixture.mp4" -map 0:v "${BX[@]}" \
  -f framecrc - > "$OUT/fixture.video.framecrc"
"$FF" -nostdin -v error -c:a aac_fixed -i "$OUT/fixture.mp4" -map 0:a "${BX[@]}" \
  -f framecrc - > "$OUT/fixture.audio-fixed.framecrc"
"$FF" -nostdin -v error -i "$OUT/fixture.mp4" -map 0:a -f s16le - \
  > "$OUT/fixture.audio-float.s16le"
# Browser check: encode the same video in-machine and compare packets.
"$FF" -nostdin -v error -f lavfi -i testsrc=duration=2:size=176x144:rate=10 \
  -threads 1 -c:v mpeg4 -q:v 5 -g 5 -bf 1 "${BX[@]}" \
  -f framecrc - > "$OUT/fixture.browser-encode.framecrc"

if [ -f "$BBB" ]; then
  "$FF" -nostdin -v error -threads 1 -i "$BBB" -map 0:v "${BX[@]}" \
    -f streamhash -hash sha256 - > "$OUT/bbb.video.streamhash"
  "$FF" -nostdin -v error -c:a aac_fixed -i "$BBB" -map 0:a "${BX[@]}" \
    -f streamhash -hash sha256 - > "$OUT/bbb.audio-fixed.streamhash"
  "$FF" -nostdin -v error -ss 300 -i "$BBB" -frames:v 5 -map 0:v "${BX[@]}" \
    -f framecrc - > "$OUT/bbb.seek300.framecrc"
else
  echo "BBB not cached at $BBB; fetch it first (see fixtures/README.md)" >&2
  exit 1
fi

( cd "$OUT" && node -e '
  const fs=require("fs"),c=require("crypto");
  const files=fs.readdirSync(".").filter(f=>f!=="manifest.json"&&f!=="README.md").sort();
  const m={};for(const f of files)m[f]=c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  fs.writeFileSync("manifest.json",JSON.stringify(m,null,2)+"\n");' )
ls -l "$OUT"
