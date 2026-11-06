"""Exact public integers/bytes; tolerance only for identified floating statistics.

The relative 2e-11 / absolute 2e-12 bounds cover native libm and QRDE arithmetic
rounding in these deterministic controls, never integer Number or BigInt fields.
"""
import math
import re


def floating(path):
    if re.search(r"(?:^|\.)pair\.[^.]+\[\d+\]$", path):
        return True
    if re.search(r"\.(?:stats|cdf|meanCI)\[\d+\]$", path):
        return True
    match = re.search(r"\.qrde[0-2]\[(\d+)\]\[1\]$", path)
    # Six quantiles and six densities; the remaining three rows are exact
    # corrections, count and bucketCount. All row indices are exact too.
    return match is not None and int(match.group(1)) < 12


def compare(actual, expected, path=''):
    if isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), (path, actual, expected)
        for i, (a, e) in enumerate(zip(actual, expected)):
            compare(a, e, f'{path}[{i}]')
    elif isinstance(expected, dict):
        assert isinstance(actual, dict) and actual.keys() == expected.keys(), (path, actual, expected)
        for key in expected:
            compare(actual[key], expected[key], f'{path}.{key}')
    elif isinstance(expected, (float, int)) and not isinstance(expected, bool):
        assert isinstance(actual, (float, int)) and not isinstance(actual, bool), (path, actual, expected)
        if floating(path):
            assert math.isclose(actual, expected, rel_tol=2e-11, abs_tol=2e-12), (path, actual, expected)
        else:
            # JSON's shortest decimal representation can be parsed as a Python
            # arbitrary-precision int (e.g. Node's 9223372036854776000).
            # Public Number equality means exact binary64 equality; BigInts
            # are decimal strings and remain losslessly exact below.
            assert float(actual) == float(expected), (path, actual, expected)
    else:
        assert actual == expected, (path, actual, expected)
