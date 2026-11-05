#!/usr/bin/env python3
"""Retain the pinned libuv parser instead of assuming libc has its grammar."""
from pathlib import Path
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parent


def render():
    manifest = json.loads((ROOT / 'sources.json').read_text())
    item = manifest['addressRules']['sources']['inet']
    raw = (ROOT / item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Pinned libuv inet source identity changed')
    source = raw.decode('utf-8')
    start = 'static int inet_pton4(const char *src, unsigned char *dst) {'
    if source.count(start) != 1:
        raise ValueError('Review libuv address parser selection')
    body = source[source.index(start):]
    return '''// Generated from unchanged pinned libuv inet_pton4/inet_pton6 bodies.
// ISC license: licenses/uv-inet.txt. Full source identity in sources.json.
#ifndef KANDELO_NODE_ADDRESS_INET_H
#define KANDELO_NODE_ADDRESS_INET_H
#include <errno.h>
#include <netinet/in.h>
#include <string.h>
namespace kandelo::node_address_inet {
#ifndef UV_EINVAL
static constexpr int UV_EINVAL = -EINVAL;
#endif
''' + body + '\n} // namespace kandelo::node_address_inet\n#endif\n'


if __name__ == '__main__':
    output = ROOT / 'address-inet.h'
    generated = render()
    if '--check' in sys.argv:
        if output.read_text() != generated:
            raise ValueError('Regenerate pinned address-inet.h')
    else:
        output.write_text(generated)
