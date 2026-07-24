var t = Uint8Array, r = Uint16Array, n = Int32Array, i = new t([
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
]), e = new t([
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
]), a = new t([
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
]), s = function(t, i) {
	for (var e = new r(31), a = 0; a < 31; ++a) e[a] = i += 1 << t[a - 1];
	var s = new n(e[30]);
	for (a = 1; a < 30; ++a) for (var o = e[a]; o < e[a + 1]; ++o) s[o] = o - e[a] << 5 | a;
	return {
		b: e,
		r: s
	};
}, o = s(i, 2), h = o.b, f = o.r;
h[28] = 258, f[258] = 28;
for (var l = s(e, 0), u = l.b, v = (l.r, new r(32768)), c = 0; c < 32768; ++c) {
	var p = (43690 & c) >> 1 | (21845 & c) << 1;
	p = (61680 & (p = (52428 & p) >> 2 | (13107 & p) << 2)) >> 4 | (3855 & p) << 4, v[c] = ((65280 & p) >> 8 | (255 & p) << 8) >> 1;
}
var d = function(t, n, i) {
	for (var e = t.length, a = 0, s = new r(n); a < e; ++a) t[a] && ++s[t[a] - 1];
	var o, h = new r(n);
	for (a = 1; a < n; ++a) h[a] = h[a - 1] + s[a - 1] << 1;
	if (i) {
		o = new r(1 << n);
		var f = 15 - n;
		for (a = 0; a < e; ++a) if (t[a]) for (var l = a << 4 | t[a], u = n - t[a], c = h[t[a] - 1]++ << u, p = c | (1 << u) - 1; c <= p; ++c) o[v[c] >> f] = l;
	} else for (o = new r(e), a = 0; a < e; ++a) t[a] && (o[a] = v[h[t[a] - 1]++] >> 15 - t[a]);
	return o;
}, b = new t(288);
for (c = 0; c < 144; ++c) b[c] = 8;
for (c = 144; c < 256; ++c) b[c] = 9;
for (c = 256; c < 280; ++c) b[c] = 7;
for (c = 280; c < 288; ++c) b[c] = 8;
var w = new t(32);
for (c = 0; c < 32; ++c) w[c] = 5;
var g = d(b, 9, 1), y = d(w, 5, 1), m = function(t) {
	for (var r = t[0], n = 1; n < t.length; ++n) t[n] > r && (r = t[n]);
	return r;
}, k = function(t, r, n) {
	var i = r / 8 | 0;
	return (t[i] | t[i + 1] << 8) >> (7 & r) & n;
}, x = function(t, r) {
	var n = r / 8 | 0;
	return (t[n] | t[n + 1] << 8 | t[n + 2] << 16) >> (7 & r);
}, T = function(t) {
	return (t + 7) / 8 | 0;
}, E = function(r, n, i) {
	return (null == n || n < 0) && (n = 0), (null == i || i > r.length) && (i = r.length), new t(r.subarray(n, i));
}, A = [
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
], U = function(t, r, n) {
	var i = new Error(r || A[t]);
	if (i.code = t, Error.captureStackTrace && Error.captureStackTrace(i, U), !n) throw i;
	return i;
}, z = function(r, n, s, o) {
	var f = r.length, l = o ? o.length : 0;
	if (!f || n.f && !n.l) return s || new t(0);
	var v = !s, c = v || 2 != n.i, p = n.i;
	v && (s = new t(3 * f));
	var b = function(r) {
		var n = s.length;
		if (r > n) {
			var i = new t(Math.max(2 * n, r));
			i.set(s), s = i;
		}
	}, w = n.f || 0, A = n.p || 0, z = n.b || 0, D = n.l, F = n.d, M = n.m, S = n.n, I = 8 * f;
	do {
		if (!D) {
			w = k(r, A, 1);
			var O = k(r, A + 1, 3);
			if (A += 3, !O) {
				var j = r[(Q = T(A) + 4) - 4] | r[Q - 3] << 8, q = Q + j;
				if (q > f) {
					p && U(0);
					break;
				}
				c && b(z + j), s.set(r.subarray(Q, q), z), n.b = z += j, n.p = A = 8 * q, n.f = w;
				continue;
			}
			if (1 == O) D = g, F = y, M = 9, S = 5;
			else if (2 == O) {
				var B = k(r, A, 31) + 257, C = k(r, A + 10, 15) + 4, G = B + k(r, A + 5, 31) + 1;
				A += 14;
				for (var H = new t(G), J = new t(19), K = 0; K < C; ++K) J[a[K]] = k(r, A + 3 * K, 7);
				A += 3 * C;
				var L = m(J), N = (1 << L) - 1, P = d(J, L, 1);
				for (K = 0; K < G;) {
					var Q, R = P[k(r, A, N)];
					if (A += 15 & R, (Q = R >> 4) < 16) H[K++] = Q;
					else {
						var V = 0, W = 0;
						for (16 == Q ? (W = 3 + k(r, A, 3), A += 2, V = H[K - 1]) : 17 == Q ? (W = 3 + k(r, A, 7), A += 3) : 18 == Q && (W = 11 + k(r, A, 127), A += 7); W--;) H[K++] = V;
					}
				}
				var X = H.subarray(0, B), Y = H.subarray(B);
				M = m(X), S = m(Y), D = d(X, M, 1), F = d(Y, S, 1);
			} else U(1);
			if (A > I) {
				p && U(0);
				break;
			}
		}
		c && b(z + 131072);
		for (var Z = (1 << M) - 1, $ = (1 << S) - 1, _ = A;; _ = A) {
			var tt = (V = D[x(r, A) & Z]) >> 4;
			if ((A += 15 & V) > I) {
				p && U(0);
				break;
			}
			if (V || U(2), tt < 256) s[z++] = tt;
			else {
				if (256 == tt) {
					_ = A, D = null;
					break;
				}
				var rt = tt - 254;
				if (tt > 264) {
					var nt = i[K = tt - 257];
					rt = k(r, A, (1 << nt) - 1) + h[K], A += nt;
				}
				var it = F[x(r, A) & $], et = it >> 4;
				it || U(3), A += 15 & it;
				Y = u[et];
				if (et > 3) {
					nt = e[et];
					Y += x(r, A) & (1 << nt) - 1, A += nt;
				}
				if (A > I) {
					p && U(0);
					break;
				}
				c && b(z + 131072);
				var at = z + rt;
				if (z < Y) {
					var st = l - Y, ot = Math.min(Y, at);
					for (st + z < 0 && U(3); z < ot; ++z) s[z] = o[st + z];
				}
				for (; z < at; ++z) s[z] = s[z - Y];
			}
		}
		n.l = D, n.p = _, n.b = z, n.f = w, D && (w = 1, n.m = M, n.d = F, n.n = S);
	} while (!w);
	return z != s.length && v ? E(s, 0, z) : s.subarray(0, z);
}, D = new t(0), F = function() {
	function r(r, n) {
		"function" == typeof r && (n = r, r = {}), this.ondata = n;
		var i = r && r.dictionary && r.dictionary.subarray(-32768);
		this.s = {
			i: 0,
			b: i ? i.length : 0
		}, this.o = new t(32768), this.p = new t(0), i && this.o.set(i);
	}
	return r.prototype.e = function(r) {
		if (this.ondata || U(5), this.d && U(4), this.p.length) {
			if (r.length) {
				var n = new t(this.p.length + r.length);
				n.set(this.p), n.set(r, this.p.length), this.p = n;
			}
		} else this.p = r;
	}, r.prototype.c = function(t) {
		this.s.i = +(this.d = t || !1);
		var r = this.s.b, n = z(this.p, this.s, this.o);
		this.ondata(E(n, r, this.s.b), this.d), this.o = E(n, this.s.b - 32768), this.s.b = this.o.length, this.p = E(this.p, this.s.p / 8 | 0), this.s.p &= 7;
	}, r.prototype.push = function(t, r) {
		this.e(t), this.c(r);
	}, r;
}();
function M(t, r) {
	return z(t, { i: 2 }, r && r.out, r && r.dictionary);
}
var S = function() {
	function r(t, r) {
		this.v = 1, this.r = 0, F.call(this, t, r);
	}
	return r.prototype.push = function(r, n) {
		if (F.prototype.e.call(this, r), this.r += r.length, this.v) {
			var i = this.p.subarray(this.v - 1), e = i.length > 3 ? function(t) {
				31 == t[0] && 139 == t[1] && 8 == t[2] || U(6, "invalid gzip data");
				var r = t[3], n = 10;
				4 & r && (n += 2 + (t[10] | t[11] << 8));
				for (var i = (r >> 3 & 1) + (r >> 4 & 1); i > 0; i -= !t[n++]);
				return n + (2 & r);
			}(i) : 4;
			if (e > i.length) {
				if (!n) return;
			} else this.v > 1 && this.onmember && this.onmember(this.r - i.length);
			this.p = i.subarray(e), this.v = 0;
		}
		F.prototype.c.call(this, 0), this.s.f && !this.s.l ? (this.v = T(this.s.p) + 9, this.s = { i: 0 }, this.o = new t(0), this.push(new t(0), n)) : n && F.prototype.c.call(this, n);
	}, r;
}(), I = "undefined" != typeof TextDecoder && new TextDecoder();
try {
	I.decode(D, { stream: !0 });
} catch (O) {}
export { F as n, M as r, S as t };
