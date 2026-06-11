var e = Uint8Array, r = Uint16Array, t = Int32Array, n = new e([
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	1,
	1,
	1,
	1,
	2,
	2,
	2,
	2,
	3,
	3,
	3,
	3,
	4,
	4,
	4,
	4,
	5,
	5,
	5,
	5,
	0,
	0,
	0,
	0
]), a = new e([
	0,
	0,
	0,
	0,
	1,
	1,
	2,
	2,
	3,
	3,
	4,
	4,
	5,
	5,
	6,
	6,
	7,
	7,
	8,
	8,
	9,
	9,
	10,
	10,
	11,
	11,
	12,
	12,
	13,
	13,
	0,
	0
]), i = new e([
	16,
	17,
	18,
	0,
	8,
	7,
	9,
	6,
	10,
	5,
	11,
	4,
	12,
	3,
	13,
	2,
	14,
	1,
	15
]), o = function(e, n) {
	for (var a = new r(31), i = 0; i < 31; ++i) a[i] = n += 1 << e[i - 1];
	var o = new t(a[30]);
	for (i = 1; i < 30; ++i) for (var f = a[i]; f < a[i + 1]; ++f) o[f] = f - a[i] << 5 | i;
	return {
		b: a,
		r: o
	};
}, f = o(n, 2), s = f.b, l = f.r;
s[28] = 258, l[258] = 28;
for (var c = o(a, 0), u = c.b, d = (c.r, new r(32768)), v = 0; v < 32768; ++v) {
	var w = (43690 & v) >> 1 | (21845 & v) << 1;
	w = (61680 & (w = (52428 & w) >> 2 | (13107 & w) << 2)) >> 4 | (3855 & w) << 4, d[v] = ((65280 & w) >> 8 | (255 & w) << 8) >> 1;
}
var h = function(e, t, n) {
	for (var a = e.length, i = 0, o = new r(t); i < a; ++i) e[i] && ++o[e[i] - 1];
	var f, s = new r(t);
	for (i = 1; i < t; ++i) s[i] = s[i - 1] + o[i - 1] << 1;
	if (n) {
		f = new r(1 << t);
		var l = 15 - t;
		for (i = 0; i < a; ++i) if (e[i]) for (var c = i << 4 | e[i], u = t - e[i], v = s[e[i] - 1]++ << u, w = v | (1 << u) - 1; v <= w; ++v) f[d[v] >> l] = c;
	} else for (f = new r(a), i = 0; i < a; ++i) e[i] && (f[i] = d[s[e[i] - 1]++] >> 15 - e[i]);
	return f;
}, g = new e(288);
for (v = 0; v < 144; ++v) g[v] = 8;
for (v = 144; v < 256; ++v) g[v] = 9;
for (v = 256; v < 280; ++v) g[v] = 7;
for (v = 280; v < 288; ++v) g[v] = 8;
var b = new e(32);
for (v = 0; v < 32; ++v) b[v] = 5;
var y = h(g, 9, 1), m = h(b, 5, 1), p = function(e) {
	for (var r = e[0], t = 1; t < e.length; ++t) e[t] > r && (r = e[t]);
	return r;
}, U = function(e, r, t) {
	var n = r / 8 | 0;
	return (e[n] | e[n + 1] << 8) >> (7 & r) & t;
}, k = function(e, r) {
	var t = r / 8 | 0;
	return (e[t] | e[t + 1] << 8 | e[t + 2] << 16) >> (7 & r);
}, x = function(e) {
	return (e + 7) / 8 | 0;
}, E = [
	"unexpected EOF",
	"invalid block type",
	"invalid length/literal",
	"invalid distance",
	"stream finished",
	"no stream handler",
	,
	"no callback",
	"invalid UTF-8 data",
	"extra field too long",
	"date not in range 1980-2099",
	"filename too long",
	"stream finishing",
	"invalid zip data"
], D = function(e, r, t) {
	var n = new Error(r || E[e]);
	if (n.code = e, Error.captureStackTrace && Error.captureStackTrace(n, D), !t) throw n;
	return n;
}, O = function(r, t, o, f) {
	var l = r.length, c = f ? f.length : 0;
	if (!l || t.f && !t.l) return o || new e(0);
	var d = !o, v = d || 2 != t.i, w = t.i;
	d && (o = new e(3 * l));
	var g = function(r) {
		var t = o.length;
		if (r > t) {
			var n = new e(Math.max(2 * t, r));
			n.set(o), o = n;
		}
	}, b = t.f || 0, E = t.p || 0, O = t.b || 0, M = t.l, S = t.d, T = t.m, A = t.n, z = 8 * l;
	do {
		if (!M) {
			b = U(r, E, 1);
			var I = U(r, E + 1, 3);
			if (E += 3, !I) {
				var L = r[(B = x(E) + 4) - 4] | r[B - 3] << 8, V = B + L;
				if (V > l) {
					w && D(0);
					break;
				}
				v && g(O + L), o.set(r.subarray(B, V), O), t.b = O += L, t.p = E = 8 * V, t.f = b;
				continue;
			}
			if (1 == I) M = y, S = m, T = 9, A = 5;
			else if (2 == I) {
				var W = U(r, E, 31) + 257, $ = U(r, E + 10, 15) + 4, F = W + U(r, E + 5, 31) + 1;
				E += 14;
				for (var H = new e(F), C = new e(19), N = 0; N < $; ++N) C[i[N]] = U(r, E + 3 * N, 7);
				E += 3 * $;
				var Z = p(C), j = (1 << Z) - 1, q = h(C, Z, 1);
				for (N = 0; N < F;) {
					var B, G = q[U(r, E, j)];
					if (E += 15 & G, (B = G >> 4) < 16) H[N++] = B;
					else {
						var J = 0, K = 0;
						for (16 == B ? (K = 3 + U(r, E, 3), E += 2, J = H[N - 1]) : 17 == B ? (K = 3 + U(r, E, 7), E += 3) : 18 == B && (K = 11 + U(r, E, 127), E += 7); K--;) H[N++] = J;
					}
				}
				var P = H.subarray(0, W), Q = H.subarray(W);
				T = p(P), A = p(Q), M = h(P, T, 1), S = h(Q, A, 1);
			} else D(1);
			if (E > z) {
				w && D(0);
				break;
			}
		}
		v && g(O + 131072);
		for (var R = (1 << T) - 1, X = (1 << A) - 1, Y = E;; Y = E) {
			var _ = (J = M[k(r, E) & R]) >> 4;
			if ((E += 15 & J) > z) {
				w && D(0);
				break;
			}
			if (J || D(2), _ < 256) o[O++] = _;
			else {
				if (256 == _) {
					Y = E, M = null;
					break;
				}
				var ee = _ - 254;
				if (_ > 264) {
					var re = n[N = _ - 257];
					ee = U(r, E, (1 << re) - 1) + s[N], E += re;
				}
				var te = S[k(r, E) & X], ne = te >> 4;
				te || D(3), E += 15 & te;
				Q = u[ne];
				if (ne > 3) {
					re = a[ne];
					Q += k(r, E) & (1 << re) - 1, E += re;
				}
				if (E > z) {
					w && D(0);
					break;
				}
				v && g(O + 131072);
				var ae = O + ee;
				if (O < Q) {
					var ie = c - Q, oe = Math.min(Q, ae);
					for (ie + O < 0 && D(3); O < oe; ++O) o[O] = f[ie + O];
				}
				for (; O < ae; ++O) o[O] = o[O - Q];
			}
		}
		t.l = M, t.p = Y, t.b = O, t.f = b, M && (b = 1, t.m = T, t.d = S, t.n = A);
	} while (!b);
	return O != o.length && d ? function(r, t, n) {
		return (null == t || t < 0) && (t = 0), (null == n || n > r.length) && (n = r.length), new e(r.subarray(t, n));
	}(o, 0, O) : o.subarray(0, O);
}, M = new e(0);
var S = "undefined" != typeof TextDecoder && new TextDecoder();
try {
	S.decode(M, { stream: !0 });
} catch (z) {}
function T(e) {
	const r = new DataView(e.buffer, e.byteOffset, e.byteLength), t = function(e) {
		const r = new DataView(e.buffer, e.byteOffset, e.byteLength), t = Math.max(0, e.length - 65557);
		for (let n = e.length - 22; n >= t; n--) if (101010256 === r.getUint32(n, !0)) return n;
		throw new Error("Zip EOCD record not found");
	}(e), n = r.getUint16(t + 10, !0), a = [];
	let i = r.getUint32(t + 16, !0);
	for (let o = 0; o < n; o++) {
		if (33639248 !== r.getUint32(i, !0)) throw new Error(`Invalid central directory entry signature at offset ${i}`);
		const t = r.getUint16(i + 4, !0), n = r.getUint16(i + 10, !0), o = r.getUint32(i + 20, !0), f = r.getUint32(i + 24, !0), s = r.getUint16(i + 28, !0), l = r.getUint16(i + 30, !0), c = r.getUint16(i + 32, !0), u = r.getUint32(i + 38, !0), d = r.getUint32(i + 42, !0), v = e.subarray(i + 46, i + 46 + s), w = new TextDecoder().decode(v), h = t >> 8;
		let g;
		g = 3 === h ? u >> 16 & 65535 : w.startsWith("bin/") || w.startsWith("sbin/") || w.includes("/bin/") || w.includes("/sbin/") ? 493 : 420;
		const b = w.endsWith("/"), y = 3 === h && 40960 == (61440 & g);
		a.push({
			fileName: w,
			compressedSize: o,
			uncompressedSize: f,
			compressionMethod: n,
			localHeaderOffset: d,
			mode: g,
			isDirectory: b,
			isSymlink: y,
			externalAttrs: u,
			creatorOS: h
		}), i += 46 + s + l + c;
	}
	return a;
}
function A(e, r) {
	const t = new DataView(e.buffer, e.byteOffset, e.byteLength), n = r.localHeaderOffset;
	if (67324752 !== t.getUint32(n, !0)) throw new Error(`Invalid local file header signature at offset ${n}`);
	const a = n + 30 + t.getUint16(n + 26, !0) + t.getUint16(n + 28, !0), i = e.subarray(a, a + r.compressedSize);
	if (0 === r.compressionMethod) return new Uint8Array(i);
	if (8 === r.compressionMethod) return function(e, r) {
		return O(e, { i: 2 }, r && r.out, r && r.dictionary);
	}(i);
	throw new Error(`Unsupported compression method: ${r.compressionMethod}`);
}
export { A as extractZipEntry, T as parseZipCentralDirectory };
