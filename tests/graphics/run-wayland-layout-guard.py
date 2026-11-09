#!/usr/bin/env python3
"""Actual source-layout guard positive and selected callsite negative control."""
import pathlib
import shutil
import subprocess
import sys
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
guard = root / 'libc/glue/check-wayland-client-layout.py'
source = pathlib.Path(sys.argv[1])
positive = subprocess.run([sys.executable, str(guard), str(source)], capture_output=True, text=True)
assert positive.returncode == 0, positive.stderr
with tempfile.TemporaryDirectory(prefix='wayland-layout-') as directory:
    changed = pathlib.Path(directory)
    for name in ['wayland-client.c', 'connection.c', 'wayland-private.h', 'wayland-util.c', 'wayland-util.h', 'wayland-client-core.h']:
        shutil.copyfile(source / name, changed / name)
    client = changed / 'wayland-client.c'
    text = client.read_text()
    selected = 'closure = wl_container_of(queue->event_list.next, closure, link);\n\twl_list_remove(&closure->link);'
    assert text.count(selected) == 1
    client.write_text(text.replace(selected, selected + '\n\t/* changed selected interception layout */'))
    negative = subprocess.run([sys.executable, str(guard), str(changed)], capture_output=True, text=True)
    assert negative.returncode != 0 and 'needs review after native source/layout change' in negative.stderr
print('PASS reviewed layout and changed first-event interception rejected before compile')
