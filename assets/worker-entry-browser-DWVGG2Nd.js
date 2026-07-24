const e = 212, t = 34, r = 46, n = 47, o = 201;
function s(e, t) {
	let r = 0, n = 0, o = t;
	for (;;) {
		const t = e[o++];
		if (r |= (127 & t) << n, !(128 & t)) break;
		n += 7;
	}
	return [r, o - t];
}
function a(e, t) {
	let r = 0, n = 0, o = t, i = 0;
	for (; i = e[o++], r |= (127 & i) << n, n += 7, 128 & i;);
	return n < 32 && 64 & i && (r |= -1 << n), [r, o - t];
}
function l(e, t) {
	let r = 0n, n = 0n, o = t, i = 0;
	for (; i = e[o++], r |= BigInt(127 & i) << n, n += 7n, 128 & i;);
	return n < 64n && 64 & i && (r |= -1n << n), [r, o - t];
}
function f(e, t) {
	const r = e[t];
	if (64 === r || 127 === r || 126 === r || 125 === r || 124 === r || 123 === r || 112 === r || 111 === r) return t + 1;
	const [, n] = a(e, t);
	return t + n;
}
function c(e, t) {
	const [, r] = s(e, t);
	t += r;
	const [, n] = s(e, t);
	return t + n;
}
function u(e, t, r) {
	const [n, o] = s(t, r);
	if (r += o, 252 === e) switch (n) {
		case 0:
		case 1:
		case 2:
		case 3:
		case 4:
		case 5:
		case 6:
		case 7: return r;
		case 8: {
			const [, e] = s(t, r);
			r += e;
			const [, n] = s(t, r);
			return r + n;
		}
		case 9: {
			const [, e] = s(t, r);
			return r + e;
		}
		case 10: {
			const [, e] = s(t, r);
			r += e;
			const [, n] = s(t, r);
			return r + n;
		}
		case 11: {
			const [, e] = s(t, r);
			return r + e;
		}
		case 12: {
			const [, e] = s(t, r);
			r += e;
			const [, n] = s(t, r);
			return r + n;
		}
		case 13: {
			const [, e] = s(t, r);
			return r + e;
		}
		case 14: {
			const [, e] = s(t, r);
			r += e;
			const [, n] = s(t, r);
			return r + n;
		}
		case 15:
		case 16:
		case 17: {
			const [, e] = s(t, r);
			return r + e;
		}
		default: return null;
	}
	return 253 === e ? 12 === n || 13 === n ? r + 16 : n >= 21 && n <= 34 ? c(t, r) : 84 === n || n >= 92 && n <= 99 || n >= 112 && n <= 123 || n >= 124 && n <= 131 || n >= 156 && n <= 159 ? r + 1 : r : 254 === e ? 0 === n || 1 === n || 2 === n ? c(t, r) : 3 === n ? r : n >= 16 && n <= 79 ? c(t, r) : null : null;
}
function d(e, t, r) {
	const [n, o] = s(e, t);
	t += o + n;
	const [i, a] = s(e, t);
	t += a + i;
	const l = e[t++];
	if (0 === l) {
		r.funcImports++;
		const [, n] = s(e, t);
		t += n;
	} else if (1 === l) {
		t++;
		const r = e[t++], [, n] = s(e, t);
		if (t += n, 1 & r) {
			const [, r] = s(e, t);
			t += r;
		}
	} else if (2 === l) {
		const r = e[t++], [, n] = s(e, t);
		if (t += n, 1 & r) {
			const [, r] = s(e, t);
			t += r;
		}
	} else 3 === l && (r.globalImports++, t += 2);
	return t;
}
function m(e, t) {
	const r = new Uint8Array(e);
	if (r.length < 8) return null;
	let n = 0, o = null, i = null, m = 8;
	for (; m < r.length;) {
		const e = r[m], [a, l] = s(r, m + 1), f = m + 1 + l;
		if (2 === e) {
			const e = {
				funcImports: n,
				globalImports: 0
			};
			let t = f;
			const [o, i] = s(r, t);
			t += i;
			for (let n = 0; n < o; n++) t = d(r, t, e);
			n = e.funcImports;
		} else if (7 === e) {
			let e = f;
			const [n, i] = s(r, e);
			e += i;
			for (let a = 0; a < n; a++) {
				const [n, i] = s(r, e);
				e += i;
				const a = new TextDecoder().decode(r.subarray(e, e + n));
				e += n;
				const l = r[e++], [f, c] = s(r, e);
				if (e += c, 0 === l && a === t) {
					o = f;
					break;
				}
			}
		} else 10 === e && (i = {
			offset: f,
			size: a
		});
		m = f + a;
	}
	if (null === o || null === i) return null;
	let p = i.offset;
	const [w, b] = s(r, p);
	return p += b, function e(t, o = 0) {
		if (o > 4) return null;
		const i = function(e) {
			const t = e - n;
			if (t < 0 || t >= w) return null;
			let o = p;
			for (let n = 0; n < t; n++) {
				const [e, t] = s(r, o);
				o += t + e;
			}
			const [i, a] = s(r, o);
			return o += a, {
				start: o,
				end: o + i
			};
		}(t);
		if (!i) return null;
		const d = function(e, t) {
			if (e >= t) return null;
			const [n, o] = s(r, e);
			e += o;
			for (let i = 0; i < n; i++) {
				const [, n] = s(r, e);
				if (e += n, ++e > t) return null;
			}
			return e;
		}(i.start, i.end);
		if (null === d) return null;
		let m = d;
		const b = i.end;
		for (; m < b;) {
			const t = r[m++];
			if (11 !== t) {
				if (65 === t) {
					const [e] = a(r, m), [, t] = a(r, m), n = m + t;
					if (15 === r[n] || 11 === r[n] && n + 1 === b) return e;
					m = n;
				} else if (16 === t) {
					const [t, n] = s(r, m), i = m + n;
					if (15 === r[i] || 11 === r[i] && i + 1 === b) {
						const r = e(t, o + 1);
						if (null !== r) return r;
					}
					m = i;
				} else if (12 === t || 13 === t || 18 === t || 210 === t) {
					const [, e] = s(r, m);
					m += e;
				} else if (2 === t || 3 === t || 4 === t) m = f(r, m);
				else if (14 === t) {
					const [e, t] = s(r, m);
					m += t;
					for (let n = 0; n <= e; n++) {
						const [, e] = s(r, m);
						m += e;
					}
				} else if (17 === t) {
					const [, e] = s(r, m);
					m += e;
					const [, t] = s(r, m);
					m += t;
				} else if (28 === t) {
					const [e, t] = s(r, m);
					m += t;
					for (let n = 0; n < e; n++) {
						const [, e] = s(r, m);
						m += e;
					}
				} else if (t >= 32 && t <= 38 || 208 === t) {
					const [, e] = s(r, m);
					m += e;
				} else if (t >= 40 && t <= 62) m = c(r, m);
				else if (63 === t || 64 === t) m++;
				else if (66 === t) {
					const [, e] = l(r, m);
					m += e;
				} else if (67 === t) m += 4;
				else if (68 === t) m += 8;
				else if (252 === t || 253 === t || 254 === t) {
					const e = u(t, r, m);
					if (null === e) return null;
					m = e;
				}
			} else if (m === b) return null;
		}
		return null;
	}(o);
}
const p = 61440, w = [
	"wpk_fork_unwind_begin",
	"wpk_fork_unwind_end",
	"wpk_fork_rewind_begin",
	"wpk_fork_rewind_end",
	"wpk_fork_state"
], b = "kandelo.wpk_fork.capabilities";
function _(e) {
	const t = WebAssembly.Module.customSections(e, b);
	if (0 === t.length) return {
		present: !1,
		flags: 0
	};
	if (1 !== t.length) throw new Error(`duplicate ${b} custom sections`);
	const r = new Uint8Array(t[0]);
	if (2 !== r.length) throw new Error(`malformed ${b} custom section`);
	if (1 !== r[0]) throw new Error(`unsupported fork-instrument capability version ${r[0]}; expected 1`);
	if (-4 & r[1]) throw new Error(`unknown fork-instrument capability flags 0x${r[1].toString(16)}`);
	return {
		present: !0,
		flags: r[1]
	};
}
function g(e, t, r = 41) {
	return e.present ? 0 !== (e.flags & t) : r < 17;
}
function h(e, t) {
	let r, n = 0, o = 0;
	do
		r = e[t.value++], n |= (127 & r) << o, o += 7;
	while (128 & r);
	return n >>> 0;
}
function y(e, t) {
	const r = h(e, t), n = e.subarray(t.value, t.value + r);
	return t.value += r, new TextDecoder().decode(n);
}
function k(e, t) {
	return e + t - 1 & ~(t - 1);
}
function v(e, t, r) {
	if (!Number.isSafeInteger(e) || e < 0) throw new RangeError(`${r}: address is not an exact non-negative integer`);
	return 8 === t ? BigInt(e) : e;
}
function A(e, t, r) {
	if (typeof e != (8 === t ? "bigint" : "number")) throw new TypeError(`${r}: expected a ${8 * t}-bit WebAssembly address`);
	if ("number" == typeof e && (!Number.isSafeInteger(e) || e < 0) || "bigint" == typeof e && e < 0n) throw new RangeError(`${r}: address is not an exact non-negative integer`);
	return e;
}
function E(e, t, r) {
	return v(t, "bigint" == typeof e.length ? 8 : 4, r);
}
function x(e) {
	const t = e.length;
	A(t, "bigint" == typeof t ? 8 : 4, "dynamic-linker table length");
	const r = Number(t);
	if (!Number.isSafeInteger(r)) throw new RangeError("dynamic-linker table length exceeds JavaScript's exact integer range");
	return r;
}
function $(e, t) {
	e.grow(E(e, t, "dynamic-linker table growth"));
}
function B(e, t) {
	return e.get(E(e, t, "dynamic-linker table index"));
}
function S(e, t, r) {
	e.set(E(e, t, "dynamic-linker table index"), r);
}
function I(e, t, r) {
	e.grow(v(t, r, "dynamic-linker memory growth"));
}
function M() {
	return WebAssembly.Tag;
}
function U(e) {
	if (4 !== e && 8 !== e) throw new TypeError(`invalid process pointer width ${String(e)}`);
	const t = M();
	return t ? new t({ parameters: [8 === e ? "i64" : "i32"] }) : void 0;
}
function N(e) {
	if (4 !== e && 8 !== e) throw new TypeError(`invalid process pointer width ${String(e)}`);
	const t = M();
	return t ? new t({ parameters: [8 === e ? "i64" : "i32"] }) : void 0;
}
function T(e, t) {
	const r = M();
	if (!r) throw new Error(`${t}: this WebAssembly runtime does not support exception tags`);
	if (!(e instanceof r)) throw new TypeError(`${t}: __c_longjmp must be an actual WebAssembly.Tag`);
	return e;
}
function W(e, t) {
	const r = M();
	if (!r) throw new Error(`${t}: this WebAssembly runtime does not support exception tags`);
	if (!(e instanceof r)) throw new TypeError(`${t}: __cpp_exception must be an actual WebAssembly.Tag`);
	return e;
}
function O(e) {
	const t = e.ptrWidth ?? 4;
	if (4 !== t && 8 !== t) throw new TypeError(`invalid process pointer width ${String(t)}`);
	void 0 !== e.longjmpTag && T(e.longjmpTag, "dynamic linker");
}
const F = new Set([
	"__wasm_dlopen",
	"__wasm_dlsym",
	"dlopen",
	"dlsym"
]);
function L(e, t, r) {
	return Array.from(e).filter((e) => !r.has(e) && t.has(e)).sort();
}
function P(e, t, r, n, o) {
	O(n);
	const i = n.ptrWidth ?? 4, s = 8 === i ? "i64" : "i32", a = new WebAssembly.Module(t), l = WebAssembly.Module.imports(a), f = WebAssembly.Module.exports(a), c = l.some((e) => "env" === e.module && "fork" === e.name && "function" === e.kind), u = w.filter((e) => f.some((t) => "function" === t.kind && t.name === e)), d = u.length === w.length, m = _(a), b = m.present && !!(1 & m.flags), M = g(m, 1), P = new Set(l.filter((e) => "env" === e.module && "function" === e.kind || "GOT.func" === e.module).map((e) => e.name)), D = new Set(f.filter((e) => "function" === e.kind).map((e) => e.name)), R = function(e, t) {
		const r = /* @__PURE__ */ new Set(), n = { value: 8 };
		for (; n.value < e.length;) {
			const o = e[n.value++], i = h(e, n), s = n.value + i;
			if (7 !== o) {
				n.value = s;
				continue;
			}
			const a = h(e, n);
			for (let l = 0; l < a; l++) {
				const o = y(e, n), i = e[n.value++], s = h(e, n);
				0 === i && s >= t && r.add(o);
			}
			break;
		}
		return r;
	}(t, l.filter((e) => "function" === e.kind).length), z = new Set(l.filter((e) => "env" === e.module && "function" === e.kind && R.has(e.name)).map((e) => e.name)), G = l.some((e) => "env" === e.module && "function" === e.kind && F.has(e.name)), j = l.some((e) => "env" === e.module && "__c_longjmp" === e.name && "tag" === e.kind) ? function(e) {
		return O(e), void 0 !== e.longjmpTag || (e.longjmpTag = T(U(e.ptrWidth ?? 4), "dynamic linker")), e.longjmpTag;
	}(n) : void 0, V = l.some((e) => "env" === e.module && "__cpp_exception" === e.name && "tag" === e.kind) ? function(e) {
		return O(e), void 0 !== e.cppExceptionTag ? W(e.cppExceptionTag, "dynamic linker") : (e.cppExceptionTag = W(N(e.ptrWidth ?? 4), "dynamic linker"), e.cppExceptionTag);
	}(n) : void 0;
	if (u.length > 0 && !d) {
		const t = w.filter((e) => !f.some((t) => "function" === t.kind && t.name === e));
		throw new Error(`${e}: incomplete wasm-fork-instrument exports; missing ${t.join(", ")}`);
	}
	if (c && !d) throw new Error(`${e}: env.fork requires complete side-module instrumentation; rebuild with wasm-fork-instrument --entry env.fork`);
	if (c && !M) throw new Error(`${e}: env.fork requires the versioned side-entry capability; rebuild with the current wasm-fork-instrument --entry env.fork`);
	if (b && !c) throw new Error(`${e}: side-entry capability is present without an env.fork import`);
	if (c && !n.sideModuleFork) throw new Error(`${e}: env.fork cannot be coordinated: ` + (n.sideModuleForkUnavailableReason ?? "side-module fork requires a process-worker unwind coordinator"));
	(function(e, t, r, n, o, i) {
		const s = i.mainModuleSymbols ?? /* @__PURE__ */ new Set();
		for (const a of i.loadedLibraries.values()) {
			if (!t && !a.forkCapable) continue;
			if (o || a.importsDynamicLookup) throw new Error(`${e}: fork-capable side modules cannot coexist with side-originated dlopen/dlsym; only a direct main-module-to-side fork path is supported`);
			const i = [...L(r, a.functionExports, s), ...L(a.functionImports, n, s)];
			if (i.length > 0) throw new Error(`${e}: fork-capable side-module nesting through ${a.name} is unsupported (cross-side symbols: ${Array.from(new Set(i)).join(", ")})`);
		}
	})(e, c, P, D, G, n);
	const C = x(n.table), Z = n.heapPointer?.value, q = new Map(n.globalSymbols), K = new Map(Array.from(n.got, ([e, t]) => [e, {
		global: t,
		value: t.value
	}])), H = [], J = (t, r) => {
		if (!n.allocateMemory) throw new Error(`${e}: no side-module memory allocator configured`);
		const o = n.allocateMemory(t, r);
		return H.push({
			addr: o,
			size: t
		}), o;
	};
	try {
		const t = 1 << r.memoryAlign;
		let l = 0;
		if (r.memorySize > 0) {
			if (o) l = o.memoryBase;
			else if (n.allocateMemory) {
				if (l = J(r.memorySize, t), l + r.memorySize > n.memory.buffer.byteLength) throw new Error(`${e}: allocator returned 0x${l.toString(16)} but memory only covers 0x${n.memory.buffer.byteLength.toString(16)}`);
			} else {
				if (!n.heapPointer) throw new Error(`${e}: no side-module memory allocator configured`);
				l = k(n.heapPointer.value, t), n.heapPointer.value = l + r.memorySize;
				const o = Math.ceil(n.heapPointer.value / 65536), s = n.memory.buffer.byteLength / 65536;
				o > s && I(n.memory, o - s, i);
			}
			o || new Uint8Array(n.memory.buffer, l, r.memorySize).fill(0);
		}
		let f = x(n.table);
		if (o) {
			if (!Number.isSafeInteger(o.tableBase) || o.tableBase < 0) throw new Error(`${e}: invalid replay table base ${o.tableBase}`);
			if (f > o.tableBase) throw new Error(`${e}: replay table already at ${f}, past parent base ${o.tableBase}`);
			f < o.tableBase && $(n.table, o.tableBase - f), f = o.tableBase;
		}
		r.tableSize > 0 && $(n.table, r.tableSize);
		let u = 0;
		if (c) {
			if (o) u = o.forkBufAddr ?? 0;
			else if (n.allocateMemory) u = J(p, 16);
			else if (n.heapPointer) {
				u = k(n.heapPointer.value, 16), n.heapPointer.value = u + p;
				const e = Math.ceil(n.heapPointer.value / 65536), t = n.memory.buffer.byteLength / 65536;
				e > t && I(n.memory, e - t, i);
			}
			if (u <= 0 || u + p > n.memory.buffer.byteLength) throw new Error(`${e}: invalid side-module fork save buffer`);
		}
		const d = new WebAssembly.Global({
			value: s,
			mutable: !1
		}, v(l, i, `${e}: memory base`)), m = new WebAssembly.Global({
			value: "bigint" == typeof n.table.length ? "i64" : "i32",
			mutable: !1
		}, E(n.table, f, `${e}: table base`)), w = (e) => {
			const t = n.table, r = x(t);
			for (let n = 0; n < r; n++) if (B(t, n) === e) return n;
			const o = r;
			return $(t, 1), S(t, o, e), o;
		}, b = (t, r) => {
			let o = n.got.get(t);
			if (o) A(o.value, i, `${e}: existing GOT.${r}.${t}`);
			else {
				let a = v(0, i, `${e}: GOT.${r}.${t}`);
				const l = n.globalSymbols.get(t);
				"mem" === r && l instanceof WebAssembly.Global ? a = A(l.value, i, `${e}: GOT.mem.${t}`) : "func" === r && "function" == typeof l && (a = v(w(l), i, `${e}: GOT.func.${t}`)), o = new WebAssembly.Global({
					value: s,
					mutable: !0
				}, a), n.got.set(t, o);
			}
			return o;
		};
		let _ = null, g = null;
		const h = () => {
			if (!_) throw new Error(`${e}: side-module fork before instantiation`);
			return Number(_.exports.wpk_fork_state());
		}, y = () => {
			if (!_ || !n.sideModuleFork || 0 === u) throw new Error(`${e}: side-module fork coordinator is unavailable`);
			const t = h();
			if (0 === t) {
				if (_.exports.wpk_fork_unwind_begin(v(u, i, `${e}: side-module fork save buffer`)), 1 !== h()) throw new Error(`${e}: side-module fork failed to enter UNWINDING`);
				return g = {
					name: e,
					instance: _,
					forkBufAddr: u,
					forkBufSize: p
				}, n.sideModuleFork.setActiveFork(g), n.sideModuleFork.invokeMainFork(1);
			}
			if (2 === t) {
				if (_.exports.wpk_fork_rewind_end(), 0 !== h()) throw new Error(`${e}: side-module fork failed to finish REWINDING`);
				const t = g ?? {
					name: e,
					instance: _,
					forkBufAddr: u,
					forkBufSize: p
				}, r = n.sideModuleFork.invokeMainFork(0);
				return n.sideModuleFork.clearActiveFork(t), g = null, r;
			}
			throw new Error(`${e}: env.fork reached in unexpected state ${t}`);
		}, M = {
			env: new Proxy({}, {
				get(t, r) {
					switch (r) {
						case "memory": return n.memory;
						case "__indirect_function_table": return n.table;
						case "__memory_base": return d;
						case "__table_base": return m;
						case "__stack_pointer": return n.stackPointer;
						case "__c_longjmp": return j;
						case "__cpp_exception": return V;
						case "fork": if (c) return y;
					}
					const o = n.globalSymbols.get(r);
					return void 0 !== o ? o : z.has(r) ? (...t) => {
						const n = _?.exports[r];
						if ("function" != typeof n) throw new Error(`${e}: self import env.${r} is unavailable`);
						return n(...t);
					} : void 0;
				},
				has: (e, t) => !![
					"memory",
					"__indirect_function_table",
					"__memory_base",
					"__table_base",
					"__stack_pointer",
					"__c_longjmp",
					"__cpp_exception"
				].includes(t) || !("fork" !== t || !c) || n.globalSymbols.has(t) || z.has(t)
			}),
			"GOT.mem": new Proxy({}, { get: (e, t) => b(t, "mem") }),
			"GOT.func": new Proxy({}, { get: (e, t) => b(t, "func") })
		};
		_ = new WebAssembly.Instance(a, M);
		const U = _.exports.__tls_size, N = U instanceof WebAssembly.Global ? Number(U.value) : 0;
		let T;
		if (r.tlsExports.size > 0 && !(U instanceof WebAssembly.Global)) throw new Error(`${e}: TLS exports require an exported __tls_size global`);
		if (!Number.isSafeInteger(N) || N < 0) throw new Error(`${e}: invalid side-module TLS size ${String(N)}`);
		if (N > 0) {
			const t = _.exports.__tls_base, i = _.exports.__tls_align;
			if (!(t instanceof WebAssembly.Global)) throw new Error(`${e}: TLS-bearing side modules must export mutable __tls_base for fork replay`);
			if (!(i instanceof WebAssembly.Global)) throw new Error(`${e}: TLS-bearing side modules must export __tls_align`);
			const s = Number(i.value);
			if (!Number.isSafeInteger(s) || s <= 0 || s & s - 1) throw new Error(`${e}: invalid side-module TLS alignment ${String(s)}`);
			const a = t.value;
			if (typeof a !== (8 === (n.ptrWidth ?? 4) ? "bigint" : "number")) throw new Error(`${e}: __tls_base type does not match the ${8 * (n.ptrWidth ?? 4)}-bit process pointer width`);
			try {
				t.value = a;
			} catch {
				throw new Error(`${e}: exported __tls_base must be mutable for fork replay`);
			}
			if (o) {
				if (!Number.isSafeInteger(o.tlsBase) || o.tlsBase <= 0) throw new Error(`${e}: fork replay is missing a valid side-module TLS base`);
				try {
					t.value = "bigint" == typeof a ? BigInt(o.tlsBase) : o.tlsBase;
				} catch {
					throw new Error(`${e}: exported __tls_base must be mutable for fork replay`);
				}
			}
			if (T = Number(t.value), !Number.isSafeInteger(T) || T <= 0) throw new Error(`${e}: invalid side-module TLS base ${String(T)}`);
			if (T % s !== 0) throw new Error(`${e}: side-module TLS base 0x${T.toString(16)} is not aligned to ${s}`);
			const f = T + N, c = l + r.memorySize;
			if (!Number.isSafeInteger(f) || T < l || f > c) throw new Error(`${e}: TLS range 0x${T.toString(16)}..0x${f.toString(16)} escapes module reservation 0x${l.toString(16)}..0x${c.toString(16)}`);
			if (f > n.memory.buffer.byteLength) throw new Error(`${e}: TLS range 0x${T.toString(16)}..0x${f.toString(16)} exceeds memory`);
		} else if (void 0 !== o?.tlsBase) throw new Error(`${e}: fork replay supplied TLS state for a module without TLS`);
		const W = {};
		for (const [n, o] of Object.entries(_.exports)) if (o instanceof WebAssembly.Global) try {
			o.value = o.value, W[n] = o;
		} catch {
			if ("__tls_size" === n || "__tls_align" === n) {
				W[n] = o;
				continue;
			}
			const t = o.value, i = r.tlsExports.has(n) ? T : l;
			if (void 0 === i) throw new Error(`${e}: TLS export ${n} has no live TLS base`);
			W[n] = new WebAssembly.Global({
				value: "bigint" == typeof t ? "i64" : "i32",
				mutable: !1
			}, "bigint" == typeof t ? t + BigInt(i) : t + i);
		}
		else W[n] = o;
		for (const [r, o] of Object.entries(W)) {
			if (r.startsWith("__")) continue;
			const t = n.globalSymbols.has(r);
			if ("function" == typeof o) {
				const s = x(n.table);
				$(n.table, 1), S(n.table, s, o);
				const a = n.got.get(r);
				a && !t && (a.value = v(s, i, `${e}: GOT.func.${r}`)), t || n.globalSymbols.set(r, o);
			} else if (o instanceof WebAssembly.Global) {
				const s = o.value, a = n.got.get(r);
				a && !t && (a.value = A(s, i, `${e}: GOT.mem.${r}`)), t || n.globalSymbols.set(r, o);
			}
		}
		const O = _.exports.__wasm_apply_data_relocs;
		if (O && O(), !o) {
			const e = _.exports.__wasm_call_ctors;
			e && e();
		}
		const F = {
			instance: _,
			memoryBase: l,
			tableBase: f,
			exports: W,
			metadata: r,
			name: e,
			forkBufAddr: u || void 0,
			tlsBase: T,
			forkCapable: c,
			functionImports: P,
			functionExports: D,
			importsDynamicLookup: G
		};
		return n.loadedLibraries.set(e, F), F;
	} catch (X) {
		const e = x(n.table);
		for (let t = C; t < e; t++) try {
			S(n.table, t, null);
		} catch {}
		n.globalSymbols.clear();
		for (const [t, r] of q) n.globalSymbols.set(t, r);
		n.got.clear();
		for (const [t, r] of K) {
			try {
				r.global.value = r.value;
			} catch {}
			n.got.set(t, r.global);
		}
		if (n.heapPointer && void 0 !== Z && (n.heapPointer.value = Z), n.deallocateMemory) for (const t of H.reverse()) try {
			n.deallocateMemory(t.addr, t.size);
		} catch {}
		throw X;
	}
}
function D(e, t, r, n) {
	O(r);
	const o = r.loadedLibraries.get(e);
	if (o) return o;
	const i = function(e) {
		if (e.length < 8) return null;
		if (0 !== e[0] || 97 !== e[1] || 115 !== e[2] || 109 !== e[3]) return null;
		const t = { value: 8 };
		if (t.value >= e.length) return null;
		if (0 !== e[t.value++]) return null;
		const r = h(e, t), n = t.value + r;
		if ("dylink.0" !== y(e, t)) return null;
		const o = {
			memorySize: 0,
			memoryAlign: 0,
			tableSize: 0,
			tableAlign: 0,
			neededDynlibs: [],
			tlsExports: /* @__PURE__ */ new Set(),
			weakImports: /* @__PURE__ */ new Set()
		};
		for (; t.value < n;) {
			const r = h(e, t), n = h(e, t), i = t.value + n;
			switch (r) {
				case 1:
					o.memorySize = h(e, t), o.memoryAlign = h(e, t), o.tableSize = h(e, t), o.tableAlign = h(e, t);
					break;
				case 2: {
					const r = h(e, t);
					for (let n = 0; n < r; n++) o.neededDynlibs.push(y(e, t));
					break;
				}
				case 3: {
					const r = h(e, t);
					for (let n = 0; n < r; n++) {
						const r = y(e, t);
						1 & h(e, t) && o.tlsExports.add(r);
					}
					break;
				}
				case 4: {
					const r = h(e, t);
					for (let n = 0; n < r; n++) {
						y(e, t);
						const r = y(e, t);
						2 & h(e, t) && o.weakImports.add(r);
					}
					break;
				}
			}
			t.value = i;
		}
		return o;
	}(t);
	if (!i) throw new Error(`${e}: not a shared library (no dylink.0 section)`);
	if (n && i.neededDynlibs.length > 0) throw new Error(`${e}: replay does not yet support NEEDED deps; each dep would need its own DylinkReplayOptions in a future API extension`);
	for (const s of i.neededDynlibs) {
		if (r.loadedLibraries.has(s)) continue;
		if (!r.resolveLibrarySync) throw new Error(`${e}: depends on ${s} but no resolveLibrarySync callback provided`);
		const t = r.resolveLibrarySync(s);
		if (!t) throw new Error(`${e}: dependency ${s} not found`);
		D(s, t, r);
	}
	return P(e, t, i, r, n);
}
var R = class e {
	static MAIN_PROGRAM_HANDLE = 1;
	options;
	handleCounter = e.MAIN_PROGRAM_HANDLE + 1;
	handleMap = /* @__PURE__ */ new Map();
	lastError = null;
	constructor(e) {
		O(e), this.options = e;
	}
	dlopenMain() {
		return this.lastError = null, e.MAIN_PROGRAM_HANDLE;
	}
	dlopenSync(e, t, r) {
		try {
			const n = D(e, t, this.options, r);
			for (const [e, t] of this.handleMap) if (t === n) return e;
			const o = this.handleCounter++;
			return this.handleMap.set(o, n), this.lastError = null, o;
		} catch (n) {
			return this.lastError = n instanceof Error ? n.message : String(n), 0;
		}
	}
	symbolAddress(e, t) {
		if ("function" == typeof t) {
			const e = this.options.table, r = x(e);
			for (let o = 0; o < r; o++) if (B(e, o) === t) return this.lastError = null, o;
			const n = r;
			return $(e, 1), S(e, n, t), this.lastError = null, n;
		}
		return t instanceof WebAssembly.Global ? (this.lastError = null, Number(t.value)) : (this.lastError = `symbol not found: ${e}`, null);
	}
	dlsym(t, r) {
		if (t === e.MAIN_PROGRAM_HANDLE || 0 === t) return this.symbolAddress(r, this.options.globalSymbols.get(r));
		const n = this.handleMap.get(t);
		if (!n) return this.lastError = "invalid handle", null;
		const o = n.exports[r];
		return this.symbolAddress(r, "function" == typeof o || o instanceof WebAssembly.Global ? o : this.options.globalSymbols.get(r));
	}
	dlclose(t) {
		return t === e.MAIN_PROGRAM_HANDLE ? (this.lastError = null, 0) : this.handleMap.has(t) ? (this.handleMap.delete(t), this.lastError = null, 0) : (this.lastError = "invalid handle", -1);
	}
	dlerror() {
		const e = this.lastError;
		return this.lastError = null, e;
	}
};
const z = r;
function G(r, n, i, s, a) {
	const l = i || [], f = s || [], c = new TextEncoder(), u = (e) => "bigint" == typeof e ? Number(e) : e;
	return {
		kernel_get_argc: () => l.length,
		kernel_argv_read: (e, t, n) => {
			if (e >= l.length) return 0;
			const o = c.encode(l[e]), i = Math.min(o.length, n);
			return new Uint8Array(r.buffer, u(t), i).set(o.subarray(0, i)), i;
		},
		kernel_environ_count: () => f.length,
		kernel_environ_get: (e, t, n) => {
			if (e >= f.length) return -1;
			const o = c.encode(f[e]), i = Math.min(o.length, n);
			return new Uint8Array(r.buffer, u(t), i).set(o.subarray(0, i)), i;
		},
		kernel_is_fork_child: () => 0,
		kernel_apply_fork_fd_actions: () => 0,
		kernel_get_fork_exec_path: (e, t) => 0,
		kernel_get_fork_exec_argc: () => 0,
		kernel_get_fork_exec_argv: (e, t, r) => 0,
		kernel_push_argv: (e, t) => {},
		kernel_clear_fork_exec: () => 0,
		kernel_execve: (e) => -38,
		kernel_exit: (e) => {
			const o = new DataView(r.buffer), i = n;
			o.setInt32(i + 4, t, !0), o.setBigInt64(i + 8, BigInt(e), !0);
			const s = new Int32Array(r.buffer);
			for (Atomics.store(s, (i + 0) / 4, 1), Atomics.notify(s, (i + 0) / 4, 1); "ok" === Atomics.wait(s, (i + 0) / 4, 1););
			throw a?.(e), new WebAssembly.RuntimeError("unreachable");
		},
		kernel_clone: (e, t, i, s, a, l, f) => {
			const c = o, d = new DataView(r.buffer), m = n;
			d.setInt32(m + 4, c, !0), d.setBigInt64(m + 8 + 0, BigInt(i), !0), d.setBigInt64(m + 8 + 8, BigInt(t), !0), d.setBigInt64(m + 8 + 16, BigInt(a), !0), d.setBigInt64(m + 8 + 24, BigInt(l), !0), d.setBigInt64(m + 8 + 32, BigInt(f), !0), d.setBigInt64(m + 8 + 40, 0n, !0), d.setUint32(m + 72, u(e), !0), d.setUint32(m + 72 + 4, u(s), !0);
			const p = new Int32Array(r.buffer);
			for (Atomics.store(p, (m + 0) / 4, 1), Atomics.notify(p, (m + 0) / 4, 1); "ok" === Atomics.wait(p, (m + 0) / 4, 1););
			const w = Number(d.getBigInt64(m + 56, !0)), b = d.getUint32(m + 64, !0);
			return Atomics.store(p, (m + 0) / 4, 0), b ? -b : w;
		},
		kernel_fork: () => {
			const t = new DataView(r.buffer), o = n;
			t.setInt32(o + 4, e, !0);
			for (let e = 0; e < 6; e++) t.setBigInt64(o + 8 + 8 * e, 0n, !0);
			const i = new Int32Array(r.buffer);
			for (Atomics.store(i, (o + 0) / 4, 1), Atomics.notify(i, (o + 0) / 4, 1); "ok" === Atomics.wait(i, (o + 0) / 4, 1););
			const s = Number(t.getBigInt64(o + 56, !0)), a = t.getUint32(o + 64, !0);
			return Atomics.store(i, (o + 0) / 4, 0), a ? -a : s;
		}
	};
}
const j = BigInt(Number.MAX_SAFE_INTEGER), V = -(1n << 63n), C = (1n << 64n) - 1n;
function Z(e, t) {
	if ("number" == typeof e && !Number.isSafeInteger(e)) throw new RangeError(`${t}: length is not an exact non-negative JavaScript integer`);
	const r = "bigint" == typeof e ? e : BigInt(e);
	if (r < 0n || r > j) throw new RangeError(`${t}: length is not an exact non-negative JavaScript integer`);
	return Number(r);
}
function q(e, t, r, n, o) {
	const i = function(e, t, r) {
		let n;
		if (4 === t) {
			if ("number" != typeof e || !Number.isSafeInteger(e) || e < -2147483648 || e > 4294967295) throw new TypeError(`${r}: expected an exact memory32 pointer`);
			n = BigInt(e >>> 0);
		} else {
			if ("bigint" != typeof e || e < V || e > C) throw new TypeError(`${r}: expected an exact memory64 pointer`);
			n = BigInt.asUintN(64, e);
		}
		if (n > j) throw new RangeError(`${r}: pointer exceeds JavaScript's exact address range`);
		return Number(n);
	}(t, n, o), s = Z(r, o), a = e.buffer.byteLength;
	if (i > a || s > a - i) throw new RangeError(`${o}: memory range [${i}, ${i + s}) exceeds ${a} bytes`);
	return {
		offset: i,
		length: s
	};
}
function K(e, t, r, o, i, s, a, l, f, c) {
	let u = null;
	const d = /* @__PURE__ */ new Map();
	let m = null;
	const p = new TextDecoder(), w = new TextEncoder(), b = (e) => "bigint" == typeof e ? Number(e) : e, _ = 8 === a ? ne : re, g = r - (8 === a ? Y : Q), h = r - (8 === a ? te : ee), y = new Int32Array(e.buffer, r - _, 1), k = 8 === a ? le : ae, v = (e, t) => 8 === a ? Number(e.getBigUint64(t, !0)) : e.getUint32(t, !0), A = (e, t, r) => {
		8 === a ? e.setBigUint64(t, BigInt(r), !0) : e.setUint32(t, r, !0);
	}, E = () => 8 === a ? Number(Atomics.load(new BigUint64Array(e.buffer, g, 1), 0)) : Atomics.load(new Uint32Array(e.buffer, g, 1), 0), x = /* @__PURE__ */ new Map();
	let $ = null, B = 0;
	const S = (r, n) => {
		const o = r + Math.max(n, 1) - 1, i = new DataView(e.buffer), s = t;
		i.setInt32(s + 4, z, !0), i.setBigInt64(s + 8 + 0, 0n, !0), i.setBigInt64(s + 8 + 8, BigInt(o), !0), i.setBigInt64(s + 8 + 16, BigInt(3), !0), i.setBigInt64(s + 8 + 24, BigInt(34), !0), i.setBigInt64(s + 8 + 32, -1n, !0), i.setBigInt64(s + 8 + 40, 0n, !0);
		const a = new Int32Array(e.buffer);
		for (Atomics.store(a, (s + 0) / 4, 1), Atomics.notify(a, (s + 0) / 4, 1); "ok" === Atomics.wait(a, (s + 0) / 4, 1););
		const l = Number(i.getBigInt64(s + 56, !0)), f = i.getUint32(s + 64, !0);
		if (Atomics.store(a, (s + 0) / 4, 0), f || l < 0) throw new Error(`dlopen: mmap(${o}) failed errno=${f || -l}`);
		const c = function(e, t) {
			return Math.ceil(e / t) * t;
		}(b(l), Math.max(n, 1));
		return x.set(c, {
			rawAddr: b(l),
			length: o
		}), c;
	}, I = (r, o) => {
		const i = x.get(r);
		if (!i) throw new Error(`dlopen rollback: unknown allocation 0x${r.toString(16)}`);
		const s = new DataView(e.buffer), a = t;
		s.setInt32(a + 4, n, !0), s.setBigInt64(a + 8 + 0, BigInt(i.rawAddr), !0), s.setBigInt64(a + 8 + 8, BigInt(i.length), !0);
		for (let e = 2; e < 6; e++) s.setBigInt64(a + 8 + 8 * e, 0n, !0);
		const l = new Int32Array(e.buffer);
		for (Atomics.store(l, (a + 0) / 4, 1), Atomics.notify(l, (a + 0) / 4, 1); "ok" === Atomics.wait(l, (a + 0) / 4, 1););
		const f = Number(s.getBigInt64(a + 56, !0)), c = s.getUint32(a + 64, !0);
		if (Atomics.store(l, (a + 0) / 4, 0), c || f < 0) throw new Error(`dlopen rollback: munmap failed errno=${c || -f}`);
		x.delete(r);
	}, M = () => {
		if (u) return u;
		const t = o(), r = i();
		if (!t || !r) throw new Error("dlopen: program has no table or stack pointer");
		const n = new Set([
			"memory",
			"__indirect_function_table",
			"__memory_base",
			"__table_base",
			"__stack_pointer",
			"__c_longjmp",
			"__cpp_exception"
		]), p = /* @__PURE__ */ new Map(), w = s();
		if (w) for (const [e, o] of Object.entries(w.exports)) n.has(e) || ("function" == typeof o || o instanceof WebAssembly.Global) && p.set(e, o);
		const b = new Set(p.keys()), _ = w?.exports.__c_longjmp, g = void 0 === _ ? l : T(_, "main module export"), y = w?.exports.__cpp_exception, k = void 0 === y ? f : W(y, "main module export"), E = w?.exports.fork, x = w?.exports.wpk_fork_state, $ = c && "function" == typeof E && "function" == typeof x ? {
			setActiveFork: (t) => {
				const r = v(new DataView(e.buffer), h);
				if (m || 0 !== r) throw new Error(`${t.name}: nested or concurrent side-module fork is unsupported`);
				m = t, A(new DataView(e.buffer), h, t.forkBufAddr);
			},
			clearActiveFork: (t) => {
				const r = new DataView(e.buffer), n = v(r, h);
				if (!m || m.name !== t.name || m.instance !== t.instance || m.forkBufAddr !== t.forkBufAddr || m.forkBufSize !== t.forkBufSize || n !== t.forkBufAddr) throw new Error(`${t.name}: stale side-module fork identity during rewind`);
				m = null, A(r, h, 0);
			},
			invokeMainFork: (e) => {
				const t = Number(E()), r = Number(x());
				if (r !== e) throw new Error(`main-module fork transition ended in state ${r}; expected ${e}`);
				return t;
			}
		} : void 0;
		return u = new R({
			memory: e,
			table: t,
			stackPointer: r,
			allocateMemory: S,
			deallocateMemory: I,
			globalSymbols: p,
			got: /* @__PURE__ */ new Map(),
			loadedLibraries: d,
			longjmpTag: g,
			cppExceptionTag: k,
			ptrWidth: a,
			mainModuleSymbols: b,
			sideModuleFork: $,
			sideModuleForkUnavailableReason: c ? $ ? void 0 : "main module does not export the fork trampoline and wpk_fork_state required for side-module fork" : "main module lacks the versioned dlopen-main fork capability; rebuild it with the current wasm-fork-instrument"
		}), u;
	}, U = (t, r, n, o, i, s) => {
		const l = w.encode(t), f = l.length, c = f + 7 & -8, u = S(k + c + r.length, 8), d = u + k, m = d + c, p = new DataView(e.buffer);
		8 === a ? (p.setBigUint64(u + 0, 0n, !0), p.setBigUint64(u + 8, BigInt(d), !0), p.setBigUint64(u + 16, BigInt(f), !0), p.setBigUint64(u + 24, BigInt(m), !0), p.setBigUint64(u + 32, BigInt(r.length), !0), p.setBigUint64(u + 40, BigInt(n), !0), p.setBigUint64(u + 48, BigInt(o), !0), p.setBigUint64(u + 56, BigInt(i), !0), p.setBigUint64(u + 64, BigInt(s), !0)) : (p.setUint32(u + 0, 0, !0), p.setUint32(u + 4, d, !0), p.setUint32(u + 8, f, !0), p.setUint32(u + 12, m, !0), p.setUint32(u + 16, r.length, !0), p.setUint32(u + 20, n, !0), p.setUint32(u + 24, o, !0), p.setUint32(u + 28, i, !0), p.setUint32(u + 32, s, !0)), new Uint8Array(e.buffer, d, f).set(l), new Uint8Array(e.buffer, m, r.length).set(r);
		const b = E();
		if (0 === b) return _ = u, void (8 === a ? Atomics.store(new BigUint64Array(e.buffer, g, 1), 0, BigInt(_)) : Atomics.store(new Uint32Array(e.buffer, g, 1), 0, _));
		var _;
		let h = b;
		for (;;) {
			const e = v(p, h);
			if (0 === e) return void A(p, h, u);
			h = e;
		}
	}, N = () => {
		const t = v(new DataView(e.buffer), h);
		if (0 === t) {
			if (m) throw new Error(`${m.name}: active side fork lost its persisted identity`);
			return null;
		}
		if (m) {
			if (m.forkBufAddr !== t) throw new Error(`${m.name}: active side fork buffer identity changed`);
			return m;
		}
		const r = Array.from(d.values()).filter((e) => e.forkBufAddr === t);
		if (1 !== r.length) throw new Error(`fork replay could not resolve active side-module buffer 0x${t.toString(16)}`);
		const n = r[0];
		return m = {
			name: n.name,
			instance: n.instance,
			forkBufAddr: t,
			forkBufSize: J
		}, m;
	}, O = (e) => Number(e.instance.exports.wpk_fork_state());
	return {
		imports: {
			__wasm_dlopen: (t, r, n, o) => {
				if (!(() => {
					if (B > 0) return B++, !0;
					const e = Atomics.compareExchange(y, 0, ie, se);
					return 0 !== e ? ($ = e > 0 ? "dlopen is temporarily unavailable while pthreads are forking" : "dlopen is temporarily unavailable while another dlopen operation owns the process lock", !1) : (B = 1, !0);
				})()) return 0;
				$ = null;
				try {
					const i = q(e, t, r, a, "__wasm_dlopen bytes"), s = q(e, n, o, a, "__wasm_dlopen name");
					if (0 === i.length && 0 === s.length) return M().dlopenMain();
					const l = new Uint8Array(e.buffer, i.offset, i.length), f = new Uint8Array(l), c = new Uint8Array(e.buffer, s.offset, s.length), u = new Uint8Array(c), m = p.decode(u), w = M().dlopenSync(m, f);
					if (w > 0) {
						const e = d.get(m);
						if (!e) throw new Error(`__wasm_dlopen(${m}): handle=${w} but loadedLibraries lookup failed`);
						U(m, f, e.memoryBase, e.tableBase, e.forkBufAddr ?? 0, e.tlsBase ?? 0);
					}
					return w;
				} finally {
					(() => {
						if (B <= 0) throw new Error("dlopen process lock released without ownership");
						if (B--, 0 === B) {
							const e = Atomics.compareExchange(y, 0, se, ie);
							if (e !== se) throw new Error(`dlopen process lock lost writer ownership (state=${e})`);
							Atomics.notify(y, 0);
						}
					})();
				}
			},
			__wasm_dlsym: (t, r, n) => {
				const o = q(e, r, n, a, "__wasm_dlsym name"), i = new Uint8Array(e.buffer, o.offset, o.length), s = new Uint8Array(i), l = p.decode(s), f = M().dlsym(t, l);
				return null === f ? 0 : f;
			},
			__wasm_dlclose: (e) => M().dlclose(e),
			__wasm_dlerror: (t, r) => {
				const n = $ ?? M().dlerror();
				if ($ = null, !n) return 0;
				const o = w.encode(n), i = Z(r, "__wasm_dlerror buffer"), s = q(e, t, Math.min(o.length, i), a, "__wasm_dlerror buffer");
				return new Uint8Array(e.buffer, s.offset, s.length).set(o.subarray(0, s.length)), s.length;
			}
		},
		replayDlopens: () => {
			const t = new DataView(e.buffer);
			let r = E();
			if (0 === r) return;
			const n = M();
			for (; 0 !== r;) {
				let o, i, s, l, f, c, u, m, w;
				8 === a ? (o = Number(t.getBigUint64(r + 0, !0)), i = Number(t.getBigUint64(r + 8, !0)), s = Number(t.getBigUint64(r + 16, !0)), l = Number(t.getBigUint64(r + 24, !0)), f = Number(t.getBigUint64(r + 32, !0)), c = Number(t.getBigUint64(r + 40, !0)), u = Number(t.getBigUint64(r + 48, !0)), m = Number(t.getBigUint64(r + 56, !0)), w = Number(t.getBigUint64(r + 64, !0))) : (o = t.getUint32(r + 0, !0), i = t.getUint32(r + 4, !0), s = t.getUint32(r + 8, !0), l = t.getUint32(r + 12, !0), f = t.getUint32(r + 16, !0), c = t.getUint32(r + 20, !0), u = t.getUint32(r + 24, !0), m = t.getUint32(r + 28, !0), w = t.getUint32(r + 32, !0));
				const b = p.decode(new Uint8Array(new Uint8Array(e.buffer, i, s))), _ = new Uint8Array(new Uint8Array(e.buffer, l, f));
				if (0 === n.dlopenSync(b, _, {
					memoryBase: c,
					tableBase: u,
					forkBufAddr: m || void 0,
					tlsBase: 0 === w ? void 0 : w
				})) throw new Error(`dlopen(${b}): ${n.dlerror() || "unknown"}`);
				if (0 !== m) {
					const e = d.get(b);
					if (!e || e.forkBufAddr !== m) throw new Error(`${b}: fork replay restored a mismatched save buffer`);
				}
				if (0 !== w) {
					const e = d.get(b);
					if (!e || e.tlsBase !== w) throw new Error(`${b}: fork replay restored a mismatched TLS base`);
				}
				r = o;
			}
		},
		completeSideModuleForkUnwind: () => {
			const t = N();
			t && function(e, t, r) {
				const n = () => Number(t.instance.exports.wpk_fork_state());
				if (1 !== n()) throw new Error(`${t.name}: expected UNWINDING before side-module unwind completion`);
				if (t.instance.exports.wpk_fork_unwind_end(), 0 !== n()) throw new Error(`${t.name}: side-module unwind did not return to NORMAL`);
				const o = X(e, t.forkBufAddr, r, t.forkBufSize);
				if (o > 0) throw new Error(`${t.name}: side-module fork() continuation save buffer overflow — the call stack at fork() needed ${t.forkBufSize + o} bytes but only ${t.forkBufSize} (FORK_SAVE_BUFFER_SIZE) are reserved; the side-module stack is too deep/wide to fork here. This is a platform limit of the fork continuation buffer, not a defect in the program.`);
			}(e, t, a);
		},
		beginSideModuleForkRewind: () => {
			const e = N();
			if (e) {
				if (0 !== O(e)) throw new Error(`${e.name}: expected NORMAL before side-module rewind`);
				if (e.instance.exports.wpk_fork_rewind_begin(e.forkBufAddr), 2 !== O(e)) throw new Error(`${e.name}: side-module rewind did not enter REWINDING`);
			}
		},
		assertNoActiveSideModuleFork: () => {
			const t = v(new DataView(e.buffer), h);
			if (m || 0 !== t) throw new Error(`${m?.name ?? "unknown side module"}: main image returned with an active side-module fork`);
		},
		resetForkChildLock: () => {
			Atomics.store(y, 0, 0), Atomics.notify(y, 0);
		}
	};
}
function H(e, t, r, n, o, i, s = 4, a, l, f) {
	const c = { memory: t }, u = (e) => "bigint" == typeof e ? Number(e) : e, d = (e) => 8 === s ? BigInt(e) : e, m = WebAssembly.Module.imports(e);
	if (m.some((e) => "env" === e.module && "__channel_base" === e.name && "global" === e.kind) && (c.__channel_base = 8 === s ? new WebAssembly.Global({
		value: "i64",
		mutable: !0
	}, BigInt(n)) : new WebAssembly.Global({
		value: "i32",
		mutable: !0
	}, n)), m.some((e) => "env" === e.module && "__c_longjmp" === e.name && "tag" === e.kind) && (c.__c_longjmp = T(a, "process module")), m.some((e) => "env" === e.module && "__cpp_exception" === e.name && "tag" === e.kind) && (c.__cpp_exception = W(l, "process module")), o && Object.assign(c, o), m.some((e) => "env" === e.module && "__wasm_posix_vm_interrupt_after" === e.name && "function" === e.kind)) {
		if (!f) throw new Error("VM interrupt timer import requested without a host timer route");
		c.__wasm_posix_vm_interrupt_after = (e, t, r) => {
			f(u(e), u(t), u(r));
		};
	}
	if (i) {
		const e = (e) => {
			const t = i()?.exports.malloc;
			return t ? t(e || (8 === s ? 1n : 1)) : 8 === s ? 0n : 0;
		}, t = (e) => {
			const t = i()?.exports.free;
			t && t(e);
		};
		c._Znwm = e, c._Znam = e, c._ZdlPv = t, c._ZdlPvm = t, c._ZdaPv = t, c._ZdaPvm = t, c._ZnwmRKSt9nothrow_t = e, c._ZnamRKSt9nothrow_t = e;
	}
	c.__cxa_guard_acquire = (e) => new Uint8Array(t.buffer)[u(e)] ? 0 : 1, c.__cxa_guard_release = (e) => {
		new Uint8Array(t.buffer)[u(e)] = 1;
	}, c.__cxa_guard_abort = (e) => {}, c.__cxa_pure_virtual = () => {
		throw new Error("pure virtual method called");
	}, c.__cxa_atexit = () => 0, c.__cxa_thread_atexit = () => 0, c._ZNSt3__122__libcpp_verbose_abortEPKcz = (e, t) => {
		throw new Error("libc++ verbose abort");
	}, c._ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_ = (e, t, r) => {
		throw new Error("libc++ sort called unexpectedly");
	};
	const p = /* @__PURE__ */ new Map();
	c.__dynamic_cast = (e, r, n, o) => {
		const i = u(e), a = u(n);
		if (0 === i) return d(0);
		const l = new DataView(t.buffer), f = t.buffer.byteLength, c = s, m = (e) => 8 === c ? Number(l.getBigUint64(e, !0)) : l.getUint32(e, !0), w = m(i);
		if (0 === w || w >= f) return d(0);
		if (w < 2 * c) return d(0);
		const b = m(w - c);
		if (0 === b || b >= f) return d(0);
		const _ = (g = w - 2 * c, 8 === c ? Number(l.getBigInt64(g, !0)) : l.getInt32(g, !0));
		var g;
		if (b === a) return d(i + _);
		const h = 2 * c, y = c + c, k = p, v = (e, t, r) => {
			if (e === t) return !0;
			if (0 === e || e >= f || r.has(e)) return !1;
			if (r.add(e), e + h + c > f) return !1;
			const n = k.get(e);
			if (0 === n) return !1;
			if (1 === n) return v(m(e + h), t, r);
			if (2 === n) {
				const n = l.getUint32(e + h + 4, !0);
				for (let o = 0; o < n; o++) {
					const n = m(e + h + 8 + o * y);
					if (n > 0 && v(n, t, r)) return !0;
				}
				return !1;
			}
			const o = m(e + h);
			if (o > 256 && o + c <= f) {
				const n = m(o + c);
				if (n > 0 && n < f) {
					if (k.set(e, 1), v(o, t, r)) return !0;
					k.delete(e);
				}
			}
			if (l.getUint32(e + h, !0) <= 3 && e + h + 8 <= f) {
				const n = l.getUint32(e + h + 4, !0);
				if (n > 0 && n < 100 && e + h + 8 + n * y <= f) {
					k.set(e, 2);
					for (let o = 0; o < n; o++) {
						const n = m(e + h + 8 + o * y);
						if (n > 0 && v(n, t, r)) return !0;
					}
					return !1;
				}
			}
			return k.set(e, 0), !1;
		};
		return v(b, a, /* @__PURE__ */ new Set()) ? d(i + _) : d(0);
	}, c._ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_ = (e, r) => {
		const n = u(e), o = u(r), i = new DataView(t.buffer), s = (o - n) / 8, a = [];
		for (let t = 0; t < s; t++) a.push(i.getBigUint64(n + 8 * t, !0));
		a.sort((e, t) => e < t ? -1 : e > t ? 1 : 0);
		for (let t = 0; t < s; t++) i.setBigUint64(n + 8 * t, a[t], !0);
	};
	for (const b of WebAssembly.Module.imports(e)) "function" === b.kind && ("env" === b.module ? c[b.name] || (c[b.name] = (...e) => {
		throw new Error(`Unimplemented import: env.${b.name}`);
	}) : "kernel" === b.module && (r[b.name] || (r[b.name] = (...e) => 0)));
	const w = { env: c };
	return Object.keys(r).length > 0 && (w.kernel = r), w;
}
const J = p;
function X(e, t, r, n) {
	const o = new DataView(e.buffer), i = 8 === r ? Number(o.getBigUint64(t, !0)) : o.getUint32(t, !0), s = t + n;
	return i > s ? i - s : 0;
}
const Q = 12, Y = 24, ee = 16, te = 32, re = 20, ne = 40;
const ie = 0, se = -1, ae = 40, le = 72, fe = [
	"wpk_fork_unwind_begin",
	"wpk_fork_unwind_end",
	"wpk_fork_rewind_begin",
	"wpk_fork_rewind_end",
	"wpk_fork_state"
];
function ce(e, t) {
	const r = new Set(e.map((e) => e.name)), n = [...r].filter((e) => e.startsWith("asyncify_"));
	if (n.length > 0) throw new Error(`pid=${t}: user program exports legacy Asyncify instrumentation (${n.join(", ")}). This host requires wasm-fork-instrument artifacts exporting wpk_fork_*; rebuild the package for the current ABI.`);
	const o = fe.filter((e) => r.has(e));
	if (o.length > 0 && o.length !== fe.length) {
		const e = fe.filter((e) => !r.has(e));
		throw new Error(`pid=${t}: incomplete wasm-fork-instrument exports; missing ${e.join(", ")}. Rebuild the package for the current ABI.`);
	}
	return o.length === fe.length;
}
function ue(e, t, r) {
	if (void 0 === t) return;
	const n = function(e) {
		return m(e, "__abi_version");
	}(e);
	if (null !== n) {
		if (n !== t) throw new Error(`pid=${r}: ABI version mismatch — kernel advertises ${t}, user program built against ${n}. Rebuild the program against the current kernel, or roll back the kernel to the matching version. See docs/abi-versioning.md.`);
	} else de || (de = !0, console.warn(`[worker] pid=${r}: user program lacks __abi_version export — legacy binary predates ABI marker rollout. Rebuild against the current glue (channel_syscall.c) to pick up the check. See docs/abi-versioning.md.`));
}
let de = !1;
async function me(e, t) {
	try {
		const { memory: n, programBytes: o, channelOffset: i, pid: s } = t, a = t.ptrWidth ?? 4, l = t.programModule ? t.programModule : await WebAssembly.compile(o);
		if (function(e) {
			return WebAssembly.Module.imports(e).some((e) => "wasi_snapshot_preview1" === e.module);
		}(l)) {
			if (function(e) {
				return WebAssembly.Module.exports(e).some((e) => "memory" === e.name && "memory" === e.kind);
			}(l)) throw new Error("WASI module defines its own memory. Only modules that import memory (compiled with --import-memory) are supported.");
			const { WasiShim: o, WasiExit: a } = await import("./wasi-shim-Bt7Rlna8.js"), f = new o(n, i, t.argv || [], t.env || []), c = {
				wasi_snapshot_preview1: f.getImports(),
				env: { memory: n }
			}, u = WebAssembly.Module.imports(l);
			for (const e of u) "env" === e.module && "memory" !== e.name && (c.env[e.name] || (c.env[e.name] = "function" === e.kind ? (...t) => {
				throw new Error(`Unimplemented WASI env import: ${e.name}`);
			} : void 0));
			const d = await WebAssembly.instantiate(l, c);
			f.init(), e.postMessage({
				type: "ready",
				pid: s
			});
			let m = 0;
			try {
				const e = d.exports._start;
				e && e();
			} catch (r) {
				if (!(r instanceof a)) throw r;
				m = r.code;
			}
			e.postMessage({
				type: "exit",
				pid: s,
				status: m
			});
			return;
		}
		const f = U(a), c = N(a);
		let u = null;
		const d = G(n, i, t.argv || [], t.env || [], (e) => {
			u = e;
		}), m = ce(WebAssembly.Module.exports(l), s), p = g(_(l), 2);
		let w = 0;
		const b = t.forkBufAddr ?? i - J, h = i - J;
		if (m) {
			let m = null;
			d.kernel_fork = () => {
				if (!m) return -38;
				return 2 === (0, m.exports.wpk_fork_state)() ? (m.exports.wpk_fork_rewind_end(), w) : (m.exports.wpk_fork_unwind_begin(b), 0);
			};
			const _ = K(n, i, h, () => m?.exports.__indirect_function_table, () => m?.exports.__stack_pointer, () => m ?? void 0, a, f, c, p), g = H(l, n, d, i, _.imports, () => m ?? void 0, a, f, c, (t, r, n) => {
				e.postMessage({
					type: "vm_interrupt_timer",
					pid: s,
					timedOutPtr: t,
					vmInterruptPtr: r,
					seconds: n
				});
			}), y = await WebAssembly.instantiate(l, g);
			m = y, t.isForkChild && _.resetForkChildLock(), ue(o, t.kernelAbiVersion, s), t.isForkChild || pe(y, l, n, i, o, a), e.postMessage({
				type: "ready",
				pid: s
			});
			let k = 0;
			try {
				const e = y.exports._start, f = y.exports.wpk_fork_state, c = y.exports.wpk_fork_unwind_end, m = y.exports.wpk_fork_rewind_begin;
				let p = !!t.isForkChild;
				p && (w = 0);
				const g = t.isForkChild && null != t.forkBufAddr ? t.forkBufAddr : b;
				let h, v = !1;
				if (t.isForkChild && null != t.forkChildThreadFnPtr) {
					const e = y.exports.__indirect_function_table;
					if (!e) throw new Error("Fork-from-thread child: no __indirect_function_table export");
					const r = t.forkChildThreadFnPtr, n = 8 === a ? BigInt(r) : r, o = e.get(n);
					if (!o) throw new Error(`Fork-from-thread child: thread function at index ${r} is null`);
					const i = t.forkChildThreadArgPtr ?? 0, s = 8 === a ? BigInt(i) : i;
					h = () => {
						o(s);
					};
				} else h = e;
				for (;;) {
					if (p) {
						if (m(g), pe(y, l, n, i, o, a), t.isForkChild && !v) {
							try {
								_.replayDlopens();
							} catch (r) {
								throw new Error(`fork-replay-dlopen failed: ${r instanceof Error ? r.message : String(r)}`);
							}
							v = !0;
						}
						_.beginSideModuleForkRewind(), p = !1;
					}
					try {
						h();
					} catch (r) {
						if (r instanceof Error && r.message.includes("unreachable") && null !== u) {
							k = u;
							break;
						}
						throw r;
					}
					if (1 === f()) {
						c();
						const e = X(n, b, a, J);
						if (e > 0) throw new Error(`pid=${s}: fork() continuation save buffer overflow — the call stack at fork() needed ${J + e} bytes but only ${J} (FORK_SAVE_BUFFER_SIZE) are reserved; the stack is too deep/wide to fork here. This is a platform limit of the fork continuation buffer, not a defect in the program.`);
						_.completeSideModuleForkUnwind();
						const t = we(n, i);
						if (t < 0) throw new Error("Fork failed: errno=" + -t);
						w = t, p = !0;
						continue;
					}
					_.assertNoActiveSideModuleFork(), null === u && (d.kernel_exit(0), k = u ?? 0);
					break;
				}
			} catch (r) {
				if (!(r instanceof Error && r.message.includes("unreachable") && null !== u)) throw r;
				k = u;
			}
			e.postMessage({
				type: "exit",
				pid: s,
				status: k
			});
		} else {
			d.kernel_fork = () => {
				throw new Error(`pid=${s}: kernel_fork reached without complete wasm-fork-instrument exports. Rebuild the program with scripts/run-wasm-fork-instrument.sh.`);
			};
			let m = null;
			const p = H(l, n, d, i, K(n, i, h, () => m?.exports.__indirect_function_table, () => m?.exports.__stack_pointer, () => m ?? void 0, a, f, c, !1).imports, () => m ?? void 0, a, f, c, (t, r, n) => {
				e.postMessage({
					type: "vm_interrupt_timer",
					pid: s,
					timedOutPtr: t,
					vmInterruptPtr: r,
					seconds: n
				});
			}), w = await WebAssembly.instantiate(l, p);
			m = w, ue(o, t.kernelAbiVersion, s), pe(w, l, n, i, o, a), e.postMessage({
				type: "ready",
				pid: s
			});
			let b = 0;
			try {
				const e = w.exports._start;
				e && e(), null !== u && (b = u);
			} catch (r) {
				if (!(r instanceof Error && r.message.includes("unreachable"))) throw r;
				if (null === u) throw r;
				b = u;
			}
			null === u && (d.kernel_exit(b), b = u ?? b), e.postMessage({
				type: "exit",
				pid: s,
				status: b
			});
		}
	} catch (n) {
		let r;
		if (n instanceof Error) r = `${n.message}\n${n.stack}`;
		else if (WebAssembly.Exception && n instanceof WebAssembly.Exception) {
			const e = n;
			r = `WebAssembly.Exception: ${e.message ?? "<no message>"}\n${e.stack ?? "<no stack>"}`;
		} else r = String(n);
		e.postMessage({
			type: "error",
			pid: t.pid,
			message: `Kernel worker failed: ${r}`
		});
	}
}
function pe(e, t, r, n, o, i = 4) {
	if (WebAssembly.Module.imports(t).some((e) => "env" === e.module && "__channel_base" === e.name && "global" === e.kind)) return;
	const s = e.exports.__tls_base, a = new DataView(r.buffer), l = s ? Number(s.value) : 0;
	if (l > 0) {
		let e = -1;
		o && (e = function(e) {
			const t = new Uint8Array(e);
			if (t.length < 8) return -1;
			function r(e, t) {
				let r = 0, n = 0, o = t;
				for (;;) {
					const t = e[o++];
					if (r |= (127 & t) << n, !(128 & t)) break;
					n += 7;
				}
				return [r, o - t];
			}
			const n = [];
			let o = 0, i = 8;
			for (; i < t.length;) {
				const e = t[i], [o, s] = r(t, i + 1);
				n.push({
					id: e,
					contentOffset: i + 1 + s,
					contentSize: o
				}), i += 1 + s + o;
			}
			for (const l of n) if (2 === l.id) {
				let e = l.contentOffset;
				const [n, i] = r(t, e);
				e += i;
				for (let s = 0; s < n; s++) {
					const [n, i] = r(t, e);
					e += i + n;
					const [s, a] = r(t, e);
					e += a + s;
					const l = t[e++];
					if (0 === l) {
						o++;
						const [, n] = r(t, e);
						e += n;
					} else if (1 === l) {
						e++;
						const n = t[e++], [, o] = r(t, e);
						if (e += o, 1 & n) {
							const [, n] = r(t, e);
							e += n;
						}
					} else if (2 === l) {
						const n = t[e++], [, o] = r(t, e);
						if (e += o, 1 & n) {
							const [, n] = r(t, e);
							e += n;
						}
					} else 3 === l && (e += 2);
				}
				break;
			}
			let s = -1;
			for (const l of n) if (7 === l.id) {
				let e = l.contentOffset;
				const [n, o] = r(t, e);
				e += o;
				for (let i = 0; i < n; i++) {
					const [n, o] = r(t, e);
					e += o;
					const i = new TextDecoder().decode(t.subarray(e, e + n));
					e += n;
					const a = t[e++], [l, f] = r(t, e);
					if (e += f, 0 === a && "__get_channel_base_addr" === i) {
						s = l;
						break;
					}
				}
				break;
			}
			if (s < 0) return -1;
			const a = s - o;
			if (a < 0) return -1;
			for (const l of n) {
				if (10 !== l.id) continue;
				let e = l.contentOffset;
				const [, n] = r(t, e);
				e += n;
				for (let o = 0; o < a; o++) {
					const [n, o] = r(t, e);
					e += o + n;
				}
				const [, i] = r(t, e);
				e += i;
				const [s, f] = r(t, e);
				e += f;
				for (let o = 0; o < s; o++) {
					const [, n] = r(t, e);
					e += n, e++;
				}
				const c = 65, u = 66;
				if (t[e] === c || t[e] === u) {
					e++;
					const [n] = r(t, e);
					return n;
				}
				if (35 === t[e]) {
					let n = e + 1;
					const [, o] = r(t, n);
					if (n += o, t[n] === c || t[n] === u) {
						n++;
						const [e] = r(t, n);
						return e;
					}
				}
				if (16 !== t[e]) return -1;
				e++;
				const [, d] = r(t, e);
				if (e += d, 16 !== t[e]) return -1;
				e++;
				const [m] = r(t, e), p = m - o;
				if (p < 0) return -1;
				let w = l.contentOffset;
				const [, b] = r(t, w);
				w += b;
				for (let o = 0; o < p; o++) {
					const [e, n] = r(t, w);
					w += n + e;
				}
				const [, _] = r(t, w);
				w += _;
				const [g, h] = r(t, w);
				w += h;
				for (let o = 0; o < g; o++) {
					const [, e] = r(t, w);
					w += e, w++;
				}
				if (t[w] !== c && t[w] !== u) return -1;
				w++;
				const [y] = r(t, w);
				return y;
			}
			return -1;
		}(o));
		const t = l + (e >= 0 ? e : 0);
		8 === i ? a.setBigUint64(t, BigInt(n), !0) : a.setUint32(t, n, !0);
	}
}
function we(t, r) {
	const n = new DataView(t.buffer);
	n.setInt32(r + 4, e, !0);
	for (let e = 0; e < 6; e++) n.setBigInt64(r + 8 + 8 * e, 0n, !0);
	const o = new Int32Array(t.buffer);
	for (Atomics.store(o, (r + 0) / 4, 1), Atomics.notify(o, (r + 0) / 4, 1); "ok" === Atomics.wait(o, (r + 0) / 4, 1););
	const i = Number(n.getBigInt64(r + 56, !0)), s = n.getUint32(r + 64, !0);
	return Atomics.store(o, (r + 0) / 4, 0), s ? -s : i;
}
async function be(e, r) {
	const { memory: n, processChannelOffset: o, channelOffset: i, pid: s, tid: a, fnPtr: l, argPtr: f, stackPtr: c, tlsPtr: u, ctidPtr: d } = r, m = r.tlsOffset ?? r.tlsAllocAddr, p = r.ptrWidth ?? 4;
	let w, b, _ = !1;
	const g = () => {
		if (_ && b) for (;;) {
			const e = Atomics.load(b, 0);
			if (e <= ie) throw _ = !1, /* @__PURE__ */ new Error(`pid=${s} tid=${a}: pthread fork lost reader ownership (state=${e})`);
			if (Atomics.compareExchange(b, 0, e, e - 1) === e) return _ = !1, void (1 === e && Atomics.notify(b, 0));
		}
	};
	try {
		let d = null;
		r.programModule || (d = function(e) {
			const t = new Uint8Array(e);
			if (t.length < 8) return e;
			function r(e, t) {
				let r = 0, n = 0, o = t;
				for (;;) {
					const t = e[o++];
					if (r |= (127 & t) << n, !(128 & t)) break;
					n += 7;
				}
				return [r, o - t];
			}
			function n(e) {
				const t = [];
				do {
					let r = 127 & e;
					0 != (e >>>= 7) && (r |= 128), t.push(r);
				} while (0 !== e);
				return t;
			}
			const o = [];
			let i = 0, s = !1, a = 8;
			for (; a < t.length;) {
				const e = t[a], [n, i] = r(t, a + 1), l = a + 1 + i, f = 1 + i + n;
				o.push({
					id: e,
					offset: a,
					totalSize: f,
					contentOffset: l,
					contentSize: n
				}), 8 === e && (s = !0), a += f;
			}
			if (!s) return e;
			for (const y of o) if (2 === y.id) {
				let e = y.contentOffset;
				const [n, o] = r(t, e);
				e += o;
				for (let s = 0; s < n; s++) {
					const [n, o] = r(t, e);
					e += o + n;
					const [s, a] = r(t, e);
					e += a + s;
					const l = t[e++];
					if (0 === l) {
						i++;
						const [, n] = r(t, e);
						e += n;
					} else if (1 === l) {
						e++;
						const n = t[e++], [, o] = r(t, e);
						if (e += o, 1 & n) {
							const [, n] = r(t, e);
							e += n;
						}
					} else if (2 === l) {
						const n = t[e++], [, o] = r(t, e);
						if (e += o, 1 & n) {
							const [, n] = r(t, e);
							e += n;
						}
					} else 3 === l && (e++, e++);
				}
				break;
			}
			let l = -1, f = [];
			const c = /* @__PURE__ */ new Map();
			for (const y of o) if (7 === y.id) {
				let e = y.contentOffset;
				const [n, o] = r(t, e);
				e += o;
				for (let i = 0; i < n; i++) {
					const [n, o] = r(t, e);
					e += o;
					const i = new TextDecoder().decode(t.subarray(e, e + n));
					e += n;
					const s = t[e++], [a, l] = r(t, e);
					e += l, 0 === s && (f.push(a), c.set(i, a));
				}
				break;
			}
			function u(e) {
				const [, n] = r(t, e);
				return e + n;
			}
			function d(e) {
				return e = u(e), u(e);
			}
			function m(e, n) {
				const o = n - i;
				if (o < 0) return null;
				let s = e.contentOffset;
				const [a, l] = r(t, s);
				if (s += l, o >= a) return null;
				for (let i = 0; i < o; i++) {
					const [e, n] = r(t, s);
					s += n + e;
				}
				const [f, c] = r(t, s);
				s += c;
				const d = s + f, [m, p] = r(t, s);
				s += p;
				for (let t = 0; t < m; t++) s = u(s), s++;
				return {
					start: s,
					end: d
				};
			}
			function p(e, n) {
				const o = m(e, n);
				if (!o) return [];
				const i = [];
				let s = o.start;
				for (; s < o.end;) {
					const e = t[s++];
					if (16 === e) {
						const [e, n] = r(t, s);
						s += n, i.push(e);
					} else if (17 === e || 19 === e) s = u(s), s = u(s);
					else if (18 === e || 20 === e || 21 === e) s = u(s);
					else if (2 === e || 3 === e || 4 === e) s = 64 === t[s] || t[s] >= 112 ? s + 1 : u(s);
					else if (12 === e || 13 === e || e >= 32 && e <= 38 || 208 === e || 210 === e) s = u(s);
					else if (14 === e) {
						const [e, n] = r(t, s);
						s += n;
						for (let t = 0; t <= e; t++) s = u(s);
					} else if (e >= 40 && e <= 62) s = d(s);
					else if (63 === e || 64 === e) s++;
					else if (65 === e || 66 === e) s = u(s);
					else if (67 === e) s += 4;
					else if (68 === e) s += 8;
					else if (252 === e) {
						const [e, n] = r(t, s);
						s += n, 8 === e || 10 === e || 12 === e || 14 === e ? s = u(u(s)) : e >= 9 && e <= 17 && (s = u(s));
					} else if (254 === e) s = u(s), s = d(s);
					else if (253 === e) break;
				}
				return i;
			}
			for (const y of o) if (10 === y.id && f.length > 0) {
				const e = [
					"__wasm_init_tls",
					"__abi_version",
					"__get_channel_base_addr",
					"_start",
					"__wasm_thread_init"
				], n = /* @__PURE__ */ new Map();
				let o = 0;
				for (const t of e) {
					const e = c.get(t);
					if (void 0 === e) continue;
					const r = new Set(p(y, e).filter((e) => e >= i));
					for (const t of r) {
						const e = n.get(t);
						e ? e.count++ : n.set(t, {
							count: 1,
							firstOrder: o++
						});
					}
				}
				let s = null;
				for (const [t, r] of n) r.count >= 2 && (!s || r.count > s.count || r.count === s.count && r.firstOrder < s.firstOrder) && (s = {
					target: t,
					count: r.count,
					firstOrder: r.firstOrder
				});
				if (s) l = s.target;
				else for (const a of f) {
					const e = m(y, a);
					if (!e || 16 !== t[e.start]) continue;
					const [n] = r(t, e.start + 1);
					if (n >= i) {
						l = n;
						break;
					}
				}
				break;
			}
			const w = l >= 0 ? l - i : -1, b = [];
			b.push(t.subarray(0, 8));
			for (const y of o) if (8 !== y.id) if (10 === y.id && w >= 0) {
				let e = y.contentOffset;
				const [o, i] = r(t, e);
				e += i;
				let s = e;
				for (let n = 0; n < w; n++) {
					const [e, n] = r(t, s);
					s += n + e;
				}
				const [a, l] = r(t, s), f = s + l + a, c = new Uint8Array([
					2,
					0,
					11
				]), u = s - y.contentOffset, d = y.contentOffset + y.contentSize - f, m = n(u + c.length + d);
				b.push(new Uint8Array([10])), b.push(new Uint8Array(m)), b.push(t.subarray(y.contentOffset, s)), b.push(c), b.push(t.subarray(f, y.contentOffset + y.contentSize));
			} else b.push(t.subarray(y.offset, y.offset + y.totalSize));
			const _ = b.reduce((e, t) => e + t.length, 0), g = new Uint8Array(_);
			let h = 0;
			for (const y of b) g.set(y, h), h += y.length;
			return g.buffer;
		}(r.programBytes));
		const y = r.programModule ? r.programModule : new WebAssembly.Module(d), k = ce(WebAssembly.Module.exports(y), s), v = i - J, A = o - J - (8 === p ? Y : Q), E = o - J - (8 === p ? ne : re);
		if (!Number.isSafeInteger(A) || A <= 0 || A + p > n.buffer.byteLength || !Number.isSafeInteger(E) || E <= 0 || E + 4 > n.buffer.byteLength) throw new Error(`pid=${s} tid=${a}: invalid process dlopen archive anchor ${String(A)}`);
		b = new Int32Array(n.buffer, E, 1);
		const x = () => 8 === p ? 0n !== Atomics.load(new BigUint64Array(n.buffer, A, 1), 0) : 0 !== Atomics.load(new Uint32Array(n.buffer, A, 1), 0);
		let $ = 0, B = null;
		const S = G(n, i, void 0, void 0, (e) => {
			B = e;
		});
		S.kernel_fork = k ? () => {
			if (!w) return -38;
			if (2 === (0, w.exports.wpk_fork_state)()) {
				try {
					w.exports.wpk_fork_rewind_end();
				} finally {
					g();
				}
				return $;
			}
			if (!(() => {
				if (!b) throw new Error(`pid=${s} tid=${a}: missing process dlopen lock`);
				if (_) throw new Error(`pid=${s} tid=${a}: pthread fork lock already held`);
				for (;;) {
					const e = Atomics.load(b, 0);
					if (e < ie) return !1;
					if (e >= 2147483647) throw new Error(`pid=${s} tid=${a}: process dlopen lock reader overflow`);
					if (Atomics.compareExchange(b, 0, e, e + 1) === e) return _ = !0, !0;
				}
			})()) return -95;
			if (x()) return g(), -95;
			try {
				w.exports.wpk_fork_unwind_begin(v);
			} catch (e) {
				throw g(), e;
			}
			return 0;
		} : () => {
			if (x()) return -95;
			throw new Error(`pid=${s} tid=${a}: kernel_fork reached without complete wasm-fork-instrument exports. Rebuild the program with scripts/run-wasm-fork-instrument.sh.`);
		};
		const I = U(p), M = N(p), T = H(y, n, S, i, function(e) {
			const t = new TextEncoder().encode("dlopen is unsupported from pthread workers; load side modules on the process main worker"), r = (e) => "bigint" == typeof e ? Number(e) : e;
			return {
				__wasm_dlopen: () => 0,
				__wasm_dlsym: () => 0,
				__wasm_dlclose: () => -1,
				__wasm_dlerror: (n, o) => {
					const i = r(n), s = r(o);
					if (!Number.isSafeInteger(i) || !Number.isSafeInteger(s) || i < 0 || s <= 0) return 0;
					const a = Math.min(t.length, s, e.buffer.byteLength - i);
					return a <= 0 ? 0 : (new Uint8Array(e.buffer, i, a).set(t.subarray(0, a)), a);
				}
			};
		}(n), () => w, p, I, M, (t, r, n) => {
			e.postMessage({
				type: "vm_interrupt_timer",
				pid: s,
				timedOutPtr: t,
				vmInterruptPtr: r,
				seconds: n
			});
		}), W = new WebAssembly.Instance(y, T);
		w = W;
		const O = W.exports.__wasm_init_tls, F = m;
		O && F > 0 && O(8 === p ? BigInt(F) : F);
		const L = W.exports.__stack_pointer;
		L && (L.value = 8 === p ? BigInt(c) : c);
		const P = W.exports.__wasm_thread_init;
		P && u > 0 && P(8 === p ? BigInt(u) : u), pe(W, y, n, i, r.programBytes, p);
		const D = W.exports.__indirect_function_table;
		if (!D) throw new Error("No __indirect_function_table export — cannot call thread function");
		const R = 8 === p ? BigInt(l) : l, z = D.get(R);
		if (!z) throw new Error(`Thread function at table index ${l} is null`);
		const j = 8 === p ? BigInt(f) : f;
		let V = 0;
		if (k) {
			const e = W.exports.wpk_fork_state, t = W.exports.wpk_fork_unwind_end, r = W.exports.wpk_fork_rewind_begin;
			let o = !1;
			for (;;) {
				o && (r(v), o = !1);
				try {
					const e = z(j);
					V = Number(e);
				} catch (h) {
					if (h instanceof Error && h.message.includes("unreachable") && null !== B) {
						V = B;
						break;
					}
					throw h;
				}
				if (1 === e()) {
					t();
					const e = X(n, v, p, J);
					if (e > 0) throw new Error(`pid=${s} tid=${a}: fork() continuation save buffer overflow — the call stack at fork() needed ${J + e} bytes but only ${J} (FORK_SAVE_BUFFER_SIZE) are reserved; too deep/wide to fork from this thread. Platform limit, not a program defect.`);
					if (x()) {
						$ = -95, o = !0;
						continue;
					}
					const r = we(n, i);
					if (r < 0) throw g(), /* @__PURE__ */ new Error("Fork failed: errno=" + -r);
					$ = r, o = !0;
					continue;
				}
				break;
			}
		} else try {
			const e = z(j);
			V = Number(e);
		} catch (h) {
			if (!(h instanceof Error && h.message.includes("unreachable") && null !== B)) throw h;
			V = B;
		}
		if (g(), null === B) {
			const e = new DataView(n.buffer), r = i;
			e.setInt32(r + 4, t, !0), e.setInt32(r + 8, V ?? 0, !0);
			const o = new Int32Array(n.buffer);
			for (Atomics.store(o, (r + 0) / 4, 1), Atomics.notify(o, (r + 0) / 4, 1); "ok" === Atomics.wait(o, (r + 0) / 4, 1););
		}
		e.postMessage({
			type: "thread_exit",
			pid: s,
			tid: a
		});
	} catch (y) {
		g();
		const t = y instanceof Error ? `${y.message}\n${y.stack ?? ""}` : String(y);
		e.postMessage({
			type: "error",
			pid: s,
			message: `Thread worker failed: ${t}`
		});
	}
}
const _e = globalThis;
_e.onmessage = (e) => {
	const t = e.data, r = {
		postMessage: (e, t) => _e.postMessage(e, t),
		on: (e, t) => {
			"message" === e && (_e.onmessage = (e) => t(e.data));
		}
	};
	if ("centralized_init" === t.type) me(r, e.data).catch((e) => {
		console.error(`[worker-entry-browser] centralizedWorkerMain error pid=${t.pid}:`, e);
	});
	else {
		if ("centralized_thread_init" !== t.type) throw new Error(`Unknown worker init type: ${t.type}`);
		be(r, e.data).catch((e) => {
			console.error("[worker-entry-browser] centralizedThreadWorkerMain error:", e);
		});
	}
};
