#!/usr/bin/env python3
"""Embed the complete pinned OutgoingMessage, not a selected framing model."""
import argparse
import hashlib
import json
from pathlib import Path


def generate(root):
    identity = json.loads((root / 'http-outgoing-sources.json').read_text())
    core = json.loads((root / 'sources.json').read_text())
    if (identity['version'], identity['commit']) != (core['version'], core['commit']):
        raise ValueError('OutgoingMessage must retain the exact Node target')
    sources = {}
    for name, item in identity['sources'].items():
        raw = (root / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('OutgoingMessage reference mismatch: ' + name)
        sources[name] = raw.decode()
    selector = identity['dateSelection']
    internal = sources['lib/internal/http.js']
    if internal.count(selector['start']) != 1:
        raise ValueError('Ambiguous HTTP date owner')
    start = internal.index(selector['start'])
    date = internal[start:start + selector['length']]
    if hashlib.sha256(date.encode()).hexdigest() != selector['sha256']:
        raise ValueError('HTTP date selection mismatch')
    header = core['httpHeaders']
    selected = {}
    for name in ['token', 'headerCharacters', 'chunkExpression']:
        part = header['sections'][name]
        item = header['sources'][part['source']]
        raw = (root / item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('HTTP predicate source mismatch')
        text = raw.decode()
        if text.count(part['start']) != 1:
            raise ValueError('Ambiguous HTTP predicate')
        start = text.index(part['start'])
        body = text[start:start + part['length']]
        if hashlib.sha256(body.encode()).hexdigest() != part['sha256']:
            raise ValueError('HTTP predicate selection mismatch')
        selected[name] = body
    client = (root / identity['drainSelection']['source']).read_text()
    client_pin = core['httpHeaders']['sources']['client']['sha256']
    if hashlib.sha256(client.encode()).hexdigest() != client_pin:
        raise ValueError('Outgoing client ownership source mismatch')
    drain = identity['drainSelection']
    start = client.index(drain['start'])
    drain_body = client[start:start + drain['length']]
    if hashlib.sha256(drain_body.encode()).hexdigest() != drain['sha256']:
        raise ValueError('Outgoing client drain owner mismatch')
    result = (root / 'http-outgoing-adapter.js').read_text()
    for marker, text in {
        '/* NODE_HTTP_OUTGOING_PREDICATES */': selected['token'] + '\n' + selected['headerCharacters'],
        '/* NODE_HTTP_OUTGOING_DATE */': date,
        '/* NODE_HTTP_OUTGOING_CHUNK_EXPRESSION */': selected['chunkExpression'],
        '/* NODE_HTTP_OUTGOING_MODULE */': sources['lib/_http_outgoing.js'],
        '/* NODE_HTTP_OUTGOING_DRAIN */': drain_body,
    }.items():
        if result.count(marker) != 1:
            raise ValueError('OutgoingMessage marker mismatch: ' + marker)
        result = result.replace(marker, text)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(generate(Path(__file__).resolve().parent))
