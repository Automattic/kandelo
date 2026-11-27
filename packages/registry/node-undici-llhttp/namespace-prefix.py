"""Namespace original C identifiers without editing their source algorithms."""
from pathlib import Path
import re
import sys

source = Path(sys.argv[1])
output = Path(sys.argv[2])
files = [source / 'include/llhttp.h'] + sorted((source / 'src').glob('*.c'))
names = set()
for path in files:
    names.update(re.findall(r'\bllhttp_[A-Za-z0-9_]+\b', path.read_text()))
    names.update(re.findall(r'\bwasm_on_[A-Za-z0-9_]+\b', path.read_text()))
names.add('wasm_settings')
assert 'llhttp_execute' in names and 'llhttp_free' in names
with output.open('x') as stream:
    stream.write('/* Compile-time symbol namespace for Undici llhttp 9.3.1. */\n')
    for name in sorted(names):
        stream.write('#define ' + name + ' kandelo_undici_' + name + '\n')
