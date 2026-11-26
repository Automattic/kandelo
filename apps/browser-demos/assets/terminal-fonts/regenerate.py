"""Regenerate the supplemental WOFF2 subsets from Go Noto Current v7.0."""

import argparse
import hashlib
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path, help="GoNotoCurrent-Regular.ttf from v7.0")
source = parser.parse_args().source
expected_sha256 = "882afbab965608c2d2bc627fd8016b962aa5a6be2d358f9de24a7b5967c5632e"
if hashlib.sha256(source.read_bytes()).hexdigest() != expected_sha256:
    parser.error(f"source does not match the v7.0 SHA-256: {expected_sha256}")
for label, intervals in {
    # A font that contains a complete grapheme can shape clusters whose
    # Latin marks sit on Thai, Lao or phonetic letters.
    'marks': [(0x20, 0x20), (0xA0, 0x052F), (0x0E00, 0x0EFF), (0x1D00, 0x1FFF), (0x20D0, 0x20FF)],
    'symbols': [(0x2000, 0x20cf), (0x2100, 0x2bff)],
    'hangul-jamo': [(0x1100, 0x11ff), (0xa960, 0xa97f), (0xd7b0, 0xd7ff)],
}.items():
    font = TTFont(source, recalcTimestamp=False)
    options = subset.Options()
    options.layout_features = ['*']
    options.name_IDs = ['*']
    for record in list(font['name'].names):
        if record.nameID in (1, 3, 4, 6, 16, 21):
            name = 'Kandelo Noto ' + label
            if record.nameID == 6:
                name = name.replace(' ', '-')
            font['name'].setName(name, record.nameID, record.platformID, record.platEncID, record.langID)
    sub = subset.Subsetter(options=options)
    sub.populate(unicodes=[cp for start, end in intervals for cp in range(start, end+1)])
    sub.subset(font)
    font.flavor = 'woff2'
    font.save(Path(__file__).parent / f'noto-{label}.woff2')
