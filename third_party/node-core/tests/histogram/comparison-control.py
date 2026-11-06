from pathlib import Path
exec(Path(__file__).with_name('compare-values.py').read_text())
rejected = 0
for path, a, b in [('.h.qrde0[13][1]', 2**53 + 2, 2**53),
                   ('.h.qrde0[14][1]', 2**32 + 1, 2**32),
                   ('.h.percentiles[0][1]', 2**53 + 2, 2**53),
                   ('.h.count', 2**32 + 1, 2**32),
                   ('.h.countBigInt', str(2**63 - 2), str(2**63 - 1)),
                   ('.h.export', '0102', '0103')]:
    try: compare(a, b, path)
    except AssertionError: rejected += 1
    else: raise AssertionError(('unexpected tolerance', path))
compare(1 + 1e-12, 1., '.h.stats[0]')
compare(1 + 1e-12, 1., '.h.qrde0[0][1]')
compare(1 + 1e-12, 1., '.pair.ab[0]')
print(f'exact-field negative controls: {rejected}; floating tolerance controls: 3')
