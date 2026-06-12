var e = Object.create, t = Object.defineProperty, i = Object.getOwnPropertyDescriptor, n = Object.getOwnPropertyNames, s = Object.getPrototypeOf, r = Object.prototype.hasOwnProperty, o = (e, t) => () => (t || (e((t = { exports: {} }).exports, t), e = null), t.exports), a = (o, a, c) => (c = null != o ? e(s(o)) : {}, ((e, s, o, a) => {
	if (s && "object" == typeof s || "function" == typeof s) for (var c, h = n(s), l = 0, d = h.length; l < d; l++) c = h[l], r.call(e, c) || c === o || t(e, c, {
		get: ((e) => s[e]).bind(null, c),
		enumerable: !(a = i(s, c)) || a.enumerable
	});
	return e;
})(!a && o && o.__esModule ? c : t(c, "default", {
	value: o,
	enumerable: !0
}), o));
var c = class e {
	meta;
	data;
	cap;
	sab;
	constructor(e, t) {
		this.sab = e, this.cap = t, this.meta = new Int32Array(e, 0, 4), this.data = new Uint8Array(e, 16, t);
	}
	static create(t = 65536) {
		const i = new e(new SharedArrayBuffer(16 + t), t);
		return Atomics.store(i.meta, 0, 0), Atomics.store(i.meta, 1, 0), Atomics.store(i.meta, 2, 0), Atomics.store(i.meta, 3, 3), i;
	}
	static fromSharedBuffer(t) {
		return new e(t, t.byteLength - 16);
	}
	getBuffer() {
		return this.sab;
	}
	capacity() {
		return this.cap;
	}
	available() {
		return Atomics.load(this.meta, 2);
	}
	isReadOpen() {
		return !!(1 & Atomics.load(this.meta, 3));
	}
	isWriteOpen() {
		return !!(2 & Atomics.load(this.meta, 3));
	}
	write(e) {
		const t = Atomics.load(this.meta, 2), i = this.cap - t, n = Math.min(e.length, i);
		if (0 === n) return 0;
		let s = Atomics.load(this.meta, 1);
		for (let r = 0; r < n; r++) this.data[s] = e[r], s = (s + 1) % this.cap;
		return Atomics.store(this.meta, 1, s), Atomics.add(this.meta, 2, n), n;
	}
	read(e) {
		const t = Atomics.load(this.meta, 2), i = Math.min(e.length, t);
		if (0 === i) return 0;
		let n = Atomics.load(this.meta, 0);
		for (let s = 0; s < i; s++) e[s] = this.data[n], n = (n + 1) % this.cap;
		return Atomics.store(this.meta, 0, n), Atomics.sub(this.meta, 2, i), i;
	}
	closeRead() {
		Atomics.and(this.meta, 3, -2);
	}
	closeWrite() {
		Atomics.and(this.meta, 3, -3);
	}
};
var h = class e {
	view;
	sab;
	constructor(e) {
		this.sab = e, this.view = new Int32Array(e);
	}
	static create(t = 256) {
		const i = new e(new SharedArrayBuffer(16 + 8 * t * 4));
		return Atomics.store(i.view, 0, 0), Atomics.store(i.view, 1, 0), Atomics.store(i.view, 2, t), Atomics.store(i.view, 3, 0), i;
	}
	static fromBuffer(t) {
		return new e(t);
	}
	getBuffer() {
		return this.sab;
	}
	acquire() {
		for (; 0 !== Atomics.compareExchange(this.view, 0, 0, 1);) Atomics.wait(this.view, 0, 1, 1);
	}
	release() {
		Atomics.store(this.view, 0, 0), Atomics.notify(this.view, 0, 1);
	}
	entryBase(e) {
		return 4 + 8 * e;
	}
	readEntry(e) {
		const t = this.entryBase(e);
		return {
			pathHash: this.view[t + 0],
			pid: this.view[t + 1],
			lockType: this.view[t + 2],
			start: this.i64FromParts(this.view[t + 4], this.view[t + 5]),
			len: this.i64FromParts(this.view[t + 6], this.view[t + 7])
		};
	}
	writeEntry(e, t) {
		const i = this.entryBase(e);
		this.view[i + 0] = t.pathHash, this.view[i + 1] = t.pid, this.view[i + 2] = t.lockType, this.view[i + 3] = 0;
		const [n, s] = this.i64ToParts(t.start);
		this.view[i + 4] = n, this.view[i + 5] = s;
		const [r, o] = this.i64ToParts(t.len);
		this.view[i + 6] = r, this.view[i + 7] = o;
	}
	removeEntryUnsafe(e) {
		const t = this.view[1];
		if (e < t - 1) {
			const i = this.entryBase(t - 1), n = this.entryBase(e);
			for (let e = 0; e < 8; e++) this.view[n + e] = this.view[i + e];
		}
		this.view[1] = t - 1;
	}
	i64FromParts(e, t) {
		return BigInt(t) << 32n | BigInt(e >>> 0);
	}
	i64ToParts(e) {
		return [Number(4294967295n & e), Number(e >> 32n & 4294967295n)];
	}
	static rangesOverlap(e, t, i, n) {
		const s = 0n === t ? BigInt("0x7fffffffffffffff") : e + t;
		return e < (0n === n ? BigInt("0x7fffffffffffffff") : i + n) && i < s;
	}
	static conflicts(t, i, n, s, r) {
		return t.pid !== r && !!e.rangesOverlap(t.start, t.len, n, s) && (0 !== t.lockType || 0 !== i);
	}
	getBlockingLock(e, t, i, n, s) {
		this.acquire();
		try {
			return this._getBlockingLockUnsafe(e, t, i, n, s);
		} finally {
			this.release();
		}
	}
	_getBlockingLockUnsafe(t, i, n, s, r) {
		const o = this.view[1];
		for (let a = 0; a < o; a++) {
			const o = this.readEntry(a);
			if (o.pathHash === t && e.conflicts(o, i, n, s, r)) return o;
		}
		return null;
	}
	setLock(e, t, i, n, s) {
		this.acquire();
		try {
			return this._setLockUnsafe(e, t, i, n, s);
		} finally {
			this.release();
		}
	}
	_setLockUnsafe(t, i, n, s, r) {
		if (2 === n) {
			let n = 0;
			for (; n < this.view[1];) {
				const o = this.readEntry(n);
				o.pathHash === t && o.pid === i && e.rangesOverlap(o.start, o.len, s, r) ? this.removeEntryUnsafe(n) : n++;
			}
			return Atomics.add(this.view, 3, 1), Atomics.notify(this.view, 3), !0;
		}
		if (this._getBlockingLockUnsafe(t, n, s, r, i)) return !1;
		let o = 0;
		for (; o < this.view[1];) {
			const n = this.readEntry(o);
			n.pathHash === t && n.pid === i && e.rangesOverlap(n.start, n.len, s, r) ? this.removeEntryUnsafe(o) : o++;
		}
		const a = this.view[1];
		return !(a >= this.view[2]) && (this.writeEntry(a, {
			pathHash: t,
			pid: i,
			lockType: n,
			start: s,
			len: r
		}), this.view[1] = a + 1, !0);
	}
	setLockWait(e, t, i, n, s) {
		for (;;) {
			if (this.acquire(), !this._getBlockingLockUnsafe(e, i, n, s, t)) return this._setLockUnsafe(e, t, i, n, s), void this.release();
			const r = Atomics.load(this.view, 3);
			this.release(), Atomics.wait(this.view, 3, r, 5e3);
		}
	}
	removeLocksByPid(e) {
		this.acquire();
		try {
			let t = 0;
			for (; t < this.view[1];) this.readEntry(t).pid === e ? this.removeEntryUnsafe(t) : t++;
			Atomics.add(this.view, 3, 1), Atomics.notify(this.view, 3);
		} finally {
			this.release();
		}
	}
	static hashPath(e) {
		let t = 2166136261;
		for (let i = 0; i < e.length; i++) t ^= e.charCodeAt(i), t = Math.imul(t, 16777619);
		return 0 | t;
	}
}, l = class {
	bindings = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	writeListeners = /* @__PURE__ */ new Set();
	bind(e) {
		const t = 0 === e.addr && 0 === e.len ? new Uint8ClampedArray(new ArrayBuffer(e.h * e.stride)) : null;
		this.bindings.set(e.pid, {
			...e,
			view: null,
			imageData: null,
			hostBuffer: t
		});
		for (const i of this.listeners) i(e.pid, "bind");
	}
	unbind(e) {
		if (this.bindings.has(e)) {
			this.bindings.delete(e);
			for (const t of this.listeners) t(e, "unbind");
		}
	}
	get(e) {
		return this.bindings.get(e);
	}
	rebindMemory(e) {
		const t = this.bindings.get(e);
		t && !t.hostBuffer && (t.view = null, t.imageData = null);
	}
	fbWrite(e, t, i) {
		const n = this.bindings.get(e);
		if (n?.hostBuffer) {
			const e = Math.min(t + i.length, n.hostBuffer.length);
			e > t && n.hostBuffer.set(i.subarray(0, e - t), t);
		}
		for (const s of this.writeListeners) s(e, t, i);
	}
	onWrite(e) {
		return this.writeListeners.add(e), () => {
			this.writeListeners.delete(e);
		};
	}
	list() {
		return [...this.bindings.values()];
	}
	onChange(e) {
		return this.listeners.add(e), () => {
			this.listeners.delete(e);
		};
	}
};
const d = "__abi_version", f = {
	atomics_wait: 2,
	atomics_wait_async: 4,
	shared_array_buffer: 1
}, u = [
	"__abi_version",
	"kernel_alloc_scratch",
	"kernel_create_process",
	"kernel_get_parent_pid",
	"kernel_handle_channel",
	"kernel_host_adapter_manifest_len",
	"kernel_host_adapter_manifest_ptr",
	"kernel_mark_process_signaled",
	"kernel_reap_exited_child",
	"kernel_remove_process",
	"kernel_wait4_poll"
], p = {
	magic: {
		offset: 0,
		size: 4
	},
	manifestVersion: {
		offset: 4,
		size: 2
	},
	manifestSize: {
		offset: 6,
		size: 2
	},
	abiVersion: {
		offset: 8,
		size: 4
	},
	requiredHostAdapterVersion: {
		offset: 12,
		size: 4
	},
	requiredWorkerFeatures: {
		offset: 16,
		size: 4
	},
	optionalKernelFeatures: {
		offset: 20,
		size: 4
	},
	channelHeaderSize: {
		offset: 24,
		size: 4
	},
	channelDataOffset: {
		offset: 28,
		size: 4
	},
	channelDataSize: {
		offset: 32,
		size: 4
	},
	channelMinSize: {
		offset: 36,
		size: 4
	}
}, g = 65536, m = 65608, w = 65560, y = 211, k = 212, b = 213, I = 500, v = 386, x = 1, _ = 2, P = 3, B = 4, A = 6, S = 10, E = 11, M = 12, U = 19, C = 22, z = 24, T = 25, O = 34, R = 35, $ = 41, N = 46, W = 47, F = 48, L = 53, D = 54, K = 55, V = 56, H = 60, q = 62, G = 63, j = 64, X = 65, Y = 68, J = 69, Z = 72, Q = 81, ee = 82, te = 90, ie = 92, ne = 93, se = 97, re = 102, oe = 103, ae = 109, ce = 124, he = 126, le = 137, de = 138, fe = 139, ue = 200, pe = 201, ge = 207, me = 239, we = 240, ye = 241, ke = 251, be = 252, Ie = 278, ve = 288, xe = 294, _e = 295, Pe = 296, Be = 333, Ae = 334, Se = 343, Ee = 345, Me = 346, Ue = 378, Ce = 379, ze = 384, Te = 387, Oe = 415, Re = {
	1: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	3: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	4: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	6: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 88
		}
	}],
	9: [{
		argIndex: 0,
		direction: "out",
		size: {
			type: "fixed",
			size: 8
		}
	}],
	11: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 88
		}
	}],
	12: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 88
		}
	}],
	13: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	14: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	15: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	16: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	17: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	18: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	19: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 1,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	20: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	21: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	22: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	23: [{
		argIndex: 0,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 1
		}
	}],
	24: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	25: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	26: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 16
		}
	}, {
		argIndex: 2,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 3
		}
	}],
	36: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "fixed",
			size: 16
		}
	}, {
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	37: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "fixed",
			size: 8
		}
	}, {
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 8
		}
	}],
	40: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	41: [{
		argIndex: 0,
		direction: "in",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	43: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 1,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	44: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	45: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	51: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	53: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "deref",
			argIndex: 2
		}
	}, {
		argIndex: 2,
		direction: "inout",
		size: {
			type: "fixed",
			size: 4
		}
	}],
	54: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	55: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	56: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	58: [{
		argIndex: 3,
		direction: "out",
		size: {
			type: "deref",
			argIndex: 4
		}
	}, {
		argIndex: 4,
		direction: "inout",
		size: {
			type: "fixed",
			size: 4
		}
	}],
	59: [{
		argIndex: 3,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 4
		}
	}],
	60: [{
		argIndex: 0,
		direction: "inout",
		size: {
			type: "arg",
			argIndex: 1,
			multiplier: 8
		}
	}],
	61: [{
		argIndex: 3,
		direction: "out",
		size: {
			type: "fixed",
			size: 8
		}
	}],
	62: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 2
		}
	}, {
		argIndex: 4,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 5
		}
	}],
	63: [
		{
			argIndex: 1,
			direction: "out",
			size: {
				type: "arg",
				argIndex: 2
			}
		},
		{
			argIndex: 4,
			direction: "out",
			size: {
				type: "deref",
				argIndex: 5
			}
		},
		{
			argIndex: 5,
			direction: "inout",
			size: {
				type: "fixed",
				size: 4
			}
		}
	],
	64: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	65: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	69: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	70: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 256
		}
	}],
	71: [{
		argIndex: 2,
		direction: "in",
		size: {
			type: "fixed",
			size: 256
		}
	}],
	72: [{
		argIndex: 2,
		direction: "inout",
		size: {
			type: "fixed",
			size: 256
		}
	}],
	75: [{
		argIndex: 0,
		direction: "out",
		size: {
			type: "fixed",
			size: 390
		}
	}],
	78: [{
		argIndex: 0,
		direction: "out",
		size: {
			type: "fixed",
			size: 8
		}
	}],
	83: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	84: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	85: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	93: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 88
		}
	}],
	94: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	95: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	96: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 3,
		direction: "in",
		size: { type: "cstring" }
	}],
	97: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	98: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	99: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	100: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 3,
		direction: "in",
		size: { type: "cstring" }
	}],
	101: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 2,
		direction: "in",
		size: { type: "cstring" }
	}],
	102: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 2,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 3
		}
	}],
	108: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 144
		}
	}],
	109: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 1,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	110: [{
		argIndex: 0,
		direction: "in",
		size: {
			type: "fixed",
			size: 8
		}
	}],
	114: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "deref",
			argIndex: 2
		}
	}, {
		argIndex: 2,
		direction: "inout",
		size: {
			type: "fixed",
			size: 4
		}
	}],
	115: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "deref",
			argIndex: 2
		}
	}, {
		argIndex: 2,
		direction: "inout",
		size: {
			type: "fixed",
			size: 4
		}
	}],
	119: [{
		argIndex: 3,
		direction: "out",
		size: {
			type: "fixed",
			size: 8
		}
	}],
	120: [{
		argIndex: 0,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 1
		}
	}],
	122: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	123: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	124: [{
		argIndex: 2,
		direction: "in",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	125: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 2,
		direction: "in",
		size: {
			type: "fixed",
			size: 32
		}
	}],
	129: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 72
		}
	}],
	130: [{
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 72
		}
	}],
	132: [
		{
			argIndex: 0,
			direction: "out",
			size: {
				type: "fixed",
				size: 4
			}
		},
		{
			argIndex: 1,
			direction: "out",
			size: {
				type: "fixed",
				size: 4
			}
		},
		{
			argIndex: 2,
			direction: "out",
			size: {
				type: "fixed",
				size: 4
			}
		}
	],
	134: [
		{
			argIndex: 0,
			direction: "out",
			size: {
				type: "fixed",
				size: 4
			}
		},
		{
			argIndex: 1,
			direction: "out",
			size: {
				type: "fixed",
				size: 4
			}
		},
		{
			argIndex: 2,
			direction: "out",
			size: {
				type: "fixed",
				size: 4
			}
		}
	],
	137: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	138: [{
		argIndex: 1,
		direction: "inout",
		size: {
			type: "arg",
			argIndex: 2
		}
	}],
	139: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 4
		}
	}, {
		argIndex: 3,
		direction: "out",
		size: {
			type: "fixed",
			size: 32
		}
	}],
	140: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 256
		}
	}],
	205: [{
		argIndex: 2,
		direction: "in",
		size: {
			type: "fixed",
			size: 128
		}
	}],
	206: [{
		argIndex: 0,
		direction: "out",
		size: {
			type: "fixed",
			size: 8
		}
	}],
	207: [
		{
			argIndex: 0,
			direction: "in",
			size: {
				type: "fixed",
				size: 8
			}
		},
		{
			argIndex: 1,
			direction: "out",
			size: {
				type: "fixed",
				size: 128
			}
		},
		{
			argIndex: 2,
			direction: "in",
			size: {
				type: "fixed",
				size: 16
			}
		}
	],
	209: [{
		argIndex: 0,
		direction: "in",
		size: {
			type: "fixed",
			size: 12
		}
	}, {
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 12
		}
	}],
	211: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	223: [{
		argIndex: 1,
		direction: "inout",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	224: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	225: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "fixed",
			size: 16
		}
	}, {
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	230: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 36
		}
	}],
	236: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	250: [{
		argIndex: 2,
		direction: "in",
		size: {
			type: "fixed",
			size: 16
		}
	}, {
		argIndex: 3,
		direction: "out",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	251: [{
		argIndex: 0,
		direction: "inout",
		size: {
			type: "arg",
			argIndex: 1,
			multiplier: 8
		}
	}],
	260: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 4,
		direction: "out",
		size: {
			type: "fixed",
			size: 256
		}
	}],
	271: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	272: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	326: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "fixed",
			size: 16
		}
	}, {
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 4
		}
	}],
	327: [{
		argIndex: 2,
		direction: "in",
		size: {
			type: "fixed",
			size: 32
		}
	}, {
		argIndex: 3,
		direction: "out",
		size: {
			type: "fixed",
			size: 32
		}
	}],
	328: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "fixed",
			size: 32
		}
	}],
	331: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 3,
		direction: "in",
		size: {
			type: "fixed",
			size: 32
		}
	}],
	332: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}],
	333: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 2
		}
	}, {
		argIndex: 4,
		direction: "in",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	334: [
		{
			argIndex: 1,
			direction: "out",
			size: {
				type: "arg",
				argIndex: 2
			}
		},
		{
			argIndex: 3,
			direction: "out",
			size: {
				type: "fixed",
				size: 4
			}
		},
		{
			argIndex: 4,
			direction: "in",
			size: {
				type: "fixed",
				size: 16
			}
		}
	],
	335: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "fixed",
			size: 16
		}
	}],
	336: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "fixed",
			size: 32
		}
	}, {
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 32
		}
	}],
	338: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "arg",
			argIndex: 2,
			add: 4
		},
		copyRetvalAdd: 4
	}],
	339: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 2,
			add: 4
		}
	}],
	340: [{
		argIndex: 2,
		direction: "inout",
		size: {
			type: "fixed",
			size: 96
		}
	}],
	342: [{
		argIndex: 1,
		direction: "in",
		size: {
			type: "arg",
			argIndex: 2,
			multiplier: 6
		}
	}],
	347: [{
		argIndex: 2,
		direction: "inout",
		size: {
			type: "fixed",
			size: 88
		}
	}],
	382: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	383: [{
		argIndex: 1,
		direction: "in",
		size: { type: "cstring" }
	}],
	384: [{
		argIndex: 1,
		direction: "out",
		size: {
			type: "deref",
			argIndex: 2
		}
	}, {
		argIndex: 2,
		direction: "inout",
		size: {
			type: "fixed",
			size: 4
		}
	}]
}, $e = 65536;
function Ne(e, t) {
	let i = 0, n = 0, s = t;
	for (;;) {
		const t = e[s++];
		if (i |= (127 & t) << n, !(128 & t)) break;
		n += 7;
	}
	return [i, s - t];
}
function We(e, t, i) {
	const [n, s] = Ne(e, t);
	t += s + n;
	const [r, o] = Ne(e, t);
	t += o + r;
	const a = e[t++];
	if (0 === a) {
		i.funcImports++;
		const [, n] = Ne(e, t);
		t += n;
	} else if (1 === a) {
		t++;
		const i = e[t++], [, n] = Ne(e, t);
		if (t += n, 1 & i) {
			const [, i] = Ne(e, t);
			t += i;
		}
	} else if (2 === a) {
		const i = e[t++], [, n] = Ne(e, t);
		if (t += n, 1 & i) {
			const [, i] = Ne(e, t);
			t += i;
		}
	} else 3 === a && (i.globalImports++, t += 2);
	return t;
}
function Fe(e, t) {
	t++, t++;
	const i = e[t++];
	if (65 === i) {
		const [i] = function(e, t) {
			let i = 0, n = 0, s = t, r = 0;
			for (; r = e[s++], i |= (127 & r) << n, n += 7, 128 & r;);
			return n < 32 && 64 & r && (i |= -1 << n), [i, s - t];
		}(e, t);
		return BigInt.asUintN(32, BigInt(i));
	}
	if (66 === i) {
		const [i] = function(e, t) {
			let i = 0n, n = 0n, s = t, r = 0;
			for (; r = e[s++], i |= BigInt(127 & r) << n, n += 7n, 128 & r;);
			return n < 64n && 64 & r && (i |= -1n << n), [i, s - t];
		}(e, t);
		return BigInt.asUintN(64, i);
	}
	return null;
}
function Le(e, t) {
	for (t += 2; 11 !== e[t];) t++;
	return t + 1;
}
function De(e) {
	const t = new Uint8Array(e);
	if (t.length < 8) return 4;
	function i(e, t) {
		let i = 0, n = 0, s = t;
		for (;;) {
			const t = e[s++];
			if (i |= (127 & t) << n, !(128 & t)) break;
			n += 7;
		}
		return [i, s - t];
	}
	let n = 8;
	for (; n < t.length;) {
		const e = t[n], [s, r] = i(t, n + 1), o = n + 1 + r;
		if (2 === e) {
			let e = o;
			const [n, s] = i(t, e);
			e += s;
			for (let r = 0; r < n; r++) {
				const [n, s] = i(t, e);
				e += s + n;
				const [r, o] = i(t, e);
				e += o + r;
				const a = t[e++];
				if (2 === a) return 4 & t[e] ? 8 : 4;
				if (0 === a) {
					const [, n] = i(t, e);
					e += n;
				} else if (1 === a) {
					e++;
					const n = t[e++], [, s] = i(t, e);
					if (e += s, 1 & n) {
						const [, n] = i(t, e);
						e += n;
					}
				} else 3 === a && (e += 2);
			}
			break;
		}
		n = o + s;
	}
	return 4;
}
function Ke(e) {
	const t = e instanceof ArrayBuffer ? new Uint8Array(e) : new Uint8Array(e.buffer, e.byteOffset, e.byteLength), i = new Uint8Array(t.byteLength);
	return i.set(t), i.buffer;
}
function Ve(e) {
	if (e && "object" == typeof e && "code" in e) {
		const t = e.code;
		if ("number" == typeof t && 0 !== t) return t < 0 ? t : -t;
		switch (t) {
			case "ENOENT": return -2;
			case "EACCES": return -13;
			case "EPERM": return -1;
			case "EEXIST": return -17;
			case "ENOTDIR": return -20;
			case "EISDIR": return -21;
			case "EINVAL": return -22;
			case "ENOSPC": return -28;
			case "EROFS": return -30;
			case "ENOTEMPTY": return -39;
			case "ELOOP": return -40;
			case "ENAMETOOLONG": return -36;
			case "EBADF": return -9;
			case "EMFILE": return -24;
			case "ENFILE": return -23;
			case "EBUSY": return -16;
			case "EXDEV": return -18;
			case "ENODEV": return -19;
			case "EFAULT": return -14;
			case "ETXTBSY": return -26;
		}
	}
	if (e instanceof Error) {
		const t = e.message;
		if (t.startsWith("ENOENT")) return -2;
		if (t.startsWith("EACCES")) return -13;
		if (t.startsWith("EPERM")) return -1;
		if (t.startsWith("EEXIST")) return -17;
		if (t.startsWith("ENOTDIR")) return -20;
		if (t.startsWith("EISDIR")) return -21;
		if (t.startsWith("EINVAL")) return -22;
		if (t.startsWith("ENOSPC")) return -28;
		if (t.startsWith("ENOTEMPTY")) return -39;
		if (t.startsWith("EBADF")) return -9;
		if (t.startsWith("ENOSYS")) return -38;
		if (t.startsWith("ENXIO")) return -6;
		if (t.startsWith("EXDEV")) return -18;
	}
	return -5;
}
var He = class e {
	config;
	io;
	callbacks;
	instance = null;
	memory = null;
	kernelPtrWidth = 4;
	sharedPipes = /* @__PURE__ */ new Map();
	signalWakeSab = null;
	sharedLockTable = null;
	programFuncTable = null;
	forkSab = null;
	waitpidSab = null;
	isThreadWorker = !1;
	pid = 0;
	framebuffers = new l();
	mergeCallbacks(e) {
		this.callbacks = {
			...this.callbacks,
			...e
		};
	}
	setProgramFuncTable(e) {
		this.programFuncTable = e;
	}
	constructor(e, t, i) {
		this.config = e, this.io = t, this.callbacks = i ?? {};
	}
	getKernelPtrWidth() {
		return this.kernelPtrWidth;
	}
	toKernelPtr(e) {
		const t = "bigint" == typeof e ? Number(e) : e;
		if (!Number.isSafeInteger(t) || t < 0) throw new Error(`invalid kernel pointer ${String(e)}`);
		return 8 === this.kernelPtrWidth ? BigInt(t) : t;
	}
	createKernelMemory() {
		return 8 === this.kernelPtrWidth ? new WebAssembly.Memory({
			initial: 24n,
			maximum: 16384n,
			shared: !0,
			address: "i64"
		}) : new WebAssembly.Memory({
			initial: 24,
			maximum: 16384,
			shared: !0
		});
	}
	injectMouseEvent(e, t, i) {
		const n = this.instance?.exports?.kernel_inject_mouse_event;
		n && n(e, t, i);
	}
	audioScratchOffset = 0;
	static AUDIO_SCRATCH_SIZE = 65536;
	ensureAudioScratch() {
		if (0 !== this.audioScratchOffset) return !0;
		const t = (this.instance?.exports)?.kernel_alloc_scratch;
		if (!t) return !1;
		const i = Number(t(e.AUDIO_SCRATCH_SIZE));
		return 0 !== i && (this.audioScratchOffset = i, !0);
	}
	drainAudio(t) {
		const i = (this.instance?.exports)?.kernel_drain_audio;
		if (!i || !this.memory || !this.ensureAudioScratch()) return 0;
		const n = Math.min(t.byteLength, e.AUDIO_SCRATCH_SIZE), s = i(this.toKernelPtr(this.audioScratchOffset), n);
		if (s > 0) {
			const e = new Uint8Array(this.memory.buffer, this.audioScratchOffset, s);
			t.set(e.subarray(0, s));
		}
		return s;
	}
	audioSampleRate() {
		const e = (this.instance?.exports)?.kernel_audio_sample_rate;
		return e ? e() : 0;
	}
	audioChannels() {
		const e = (this.instance?.exports)?.kernel_audio_channels;
		return e ? e() : 0;
	}
	audioPending() {
		const e = (this.instance?.exports)?.kernel_audio_pending;
		return e ? e() : 0;
	}
	registerSharedPipe(e, t, i) {
		this.sharedPipes.set(e, {
			pipe: c.fromSharedBuffer(t),
			end: i
		});
	}
	unregisterSharedPipe(e) {
		this.sharedPipes.delete(e);
	}
	getSharedPipes() {
		return this.sharedPipes;
	}
	registerSignalWakeSab(e) {
		this.signalWakeSab = e;
	}
	registerSharedLockTable(e) {
		this.sharedLockTable = h.fromBuffer(e);
	}
	registerForkSab(e) {
		this.forkSab = e;
	}
	registerWaitpidSab(e) {
		this.waitpidSab = e;
	}
	async init(e) {
		this.kernelPtrWidth = De(Ke(e));
		const t = this.createKernelMemory();
		this.memory = t;
		const i = this.buildImportObject(t), n = await WebAssembly.compile(e);
		this.instance = await WebAssembly.instantiate(n, i);
	}
	async initWithMemory(e, t) {
		this.kernelPtrWidth = De(Ke(e)), this.memory = t;
		const i = this.buildImportObject(t), n = await WebAssembly.compile(e);
		this.instance = await WebAssembly.instantiate(n, i);
	}
	buildImportObject(e) {
		return { env: {
			memory: e,
			host_debug_log: (t, i) => {
				const n = new Uint8Array(e.buffer, Number(t), i), s = new TextDecoder().decode(n.slice());
				console.log(`[KERNEL] ${s}`);
			},
			host_open: (e, t, i, n) => this.hostOpen(Number(e), t, i, n),
			host_close: (e) => this.hostClose(e),
			host_read: (e, t, i) => this.hostRead(e, Number(t), i),
			host_write: (e, t, i) => this.hostWrite(e, Number(t), i),
			host_seek: (e, t, i, n) => this.hostSeek(e, t, i, n),
			host_fstat: (e, t) => this.hostFstat(e, Number(t)),
			host_stat: (e, t, i) => this.hostStat(Number(e), t, Number(i)),
			host_lstat: (e, t, i) => this.hostLstat(Number(e), t, Number(i)),
			host_statfs: (e, t, i) => this.hostStatfs(Number(e), t, Number(i)),
			host_mkdir: (e, t, i) => this.hostMkdir(Number(e), t, i),
			host_rmdir: (e, t) => this.hostRmdir(Number(e), t),
			host_unlink: (e, t) => this.hostUnlink(Number(e), t),
			host_rename: (e, t, i, n) => this.hostRename(Number(e), t, Number(i), n),
			host_link: (e, t, i, n) => this.hostLink(Number(e), t, Number(i), n),
			host_symlink: (e, t, i, n) => this.hostSymlink(Number(e), t, Number(i), n),
			host_readlink: (e, t, i, n) => this.hostReadlink(Number(e), t, Number(i), n),
			host_chmod: (e, t, i) => this.hostChmod(Number(e), t, i),
			host_chown: (e, t, i, n) => this.hostChown(Number(e), t, i, n),
			host_access: (e, t, i) => this.hostAccess(Number(e), t, i),
			host_opendir: (e, t) => this.hostOpendir(Number(e), t),
			host_readdir: (e, t, i, n) => this.hostReaddir(e, Number(t), Number(i), n),
			host_closedir: (e) => this.hostClosedir(e),
			host_clock_gettime: (e, t, i) => this.hostClockGettime(e, Number(t), Number(i)),
			host_nanosleep: (e, t) => this.hostNanosleep(e, t),
			host_ftruncate: (e, t) => this.hostFtruncate(e, t),
			host_fsync: (e) => this.hostFsync(e),
			host_fchmod: (e, t) => this.hostFchmod(e, t),
			host_fchown: (e, t, i) => this.hostFchown(e, t, i),
			host_kill: (e, t) => this.hostKill(e, t),
			host_exec: (e, t) => this.hostExec(Number(e), t),
			host_set_alarm: (e) => this.hostSetAlarm(e),
			host_set_posix_timer: (e, t, i, n, s, r) => {
				const o = 4294967296 * (n >>> 0) + (i >>> 0), a = 4294967296 * (r >>> 0) + (s >>> 0);
				return this.hostSetPosixTimer(e, t, o, a);
			},
			host_sigsuspend_wait: () => this.hostSigsuspendWait(),
			host_call_signal_handler: (e, t, i) => {
				const n = this.programFuncTable ?? this.instance?.exports.__indirect_function_table;
				if (!n) return -22;
				const s = n.get(e);
				if (s) try {
					return 4 & i ? s(t, 0, 0) : s(t), 0;
				} catch (r) {
					return -5;
				}
				return -22;
			},
			host_getrandom: (e, t) => {
				try {
					const i = this.getMemoryBuffer(), n = Number(e), s = i.subarray(n, n + t);
					if (void 0 !== globalThis.crypto && globalThis.crypto.getRandomValues) {
						const e = new Uint8Array(t);
						globalThis.crypto.getRandomValues(e), s.set(e);
					} else for (let e = 0; e < t; e++) s[e] = 256 * Math.random() | 0;
					return t;
				} catch {
					return -5;
				}
			},
			host_utimensat: (e, t, i, n, s, r) => this.hostUtimensat(Number(e), t, i, n, s, r),
			host_waitpid: (e, t, i) => this.hostWaitpid(e, t, Number(i)),
			host_net_connect: (e, t, i, n) => this.hostNetConnect(e, Number(t), i, n),
			host_net_send: (e, t, i, n) => this.hostNetSend(e, Number(t), i, n),
			host_net_recv: (e, t, i, n) => this.hostNetRecv(e, Number(t), i, n),
			host_net_poll: (e, t) => this.hostNetPoll(e, t),
			host_net_connect_status: (e) => this.hostNetConnectStatus(e),
			host_net_close: (e) => this.hostNetClose(e),
			host_net_listen: (e, t, i, n, s, r) => this.hostNetListen(e, t, i, n, s, r),
			host_udp_bind: (e, t, i, n, s, r) => this.hostUdpBind(e, t, i, n, s, r),
			host_udp_unbind: (e) => this.hostUdpUnbind(e),
			host_udp_send: (e, t, i, n, s, r, o, a, c, h, l, d) => this.hostUdpSend(e, t, i, n, s, r, o, a, c, h, Number(l), d),
			host_getaddrinfo: (e, t, i, n) => this.hostGetaddrinfo(Number(e), t, Number(i), n),
			host_fcntl_lock: (e, t, i, n, s, r, o, a, c, h) => this.hostFcntlLock(Number(e), t, i, n, s, r, o, a, c, Number(h)),
			host_fork: () => this.hostFork(),
			host_futex_wait: (e, t, i, n) => this.hostFutexWait(Number(e), t, i, n),
			host_futex_wake: (e, t) => this.hostFutexWake(Number(e), t),
			host_clone: (e, t, i, n, s) => this.hostClone(Number(e), Number(t), Number(i), Number(n), Number(s)),
			host_is_thread_worker: () => this.isThreadWorker ? 1 : 0,
			host_bind_framebuffer: (e, t, i, n, s, r, o) => {
				this.framebuffers.bind({
					pid: e,
					addr: Number(t),
					len: Number(i),
					w: n,
					h: s,
					stride: r,
					fmt: "BGRA32"
				});
			},
			host_unbind_framebuffer: (e) => {
				this.framebuffers.unbind(e);
			},
			host_fb_write: (e, t, i, n) => {
				this.framebuffers.fbWrite(e, Number(t), this.readKernelBytes(Number(i), Number(n)));
			}
		} };
	}
	getMemory() {
		return this.memory;
	}
	getInstance() {
		return this.instance;
	}
	getMemoryBuffer() {
		if (!this.memory) throw new Error("Kernel not initialized");
		return new Uint8Array(this.memory.buffer);
	}
	getMemoryDataView() {
		if (!this.memory) throw new Error("Kernel not initialized");
		return new DataView(this.memory.buffer);
	}
	readKernelBytes(e, t) {
		const i = new Uint8Array(t);
		return i.set(this.getMemoryBuffer().subarray(e, e + t)), i;
	}
	hostOpen(e, t, i, n) {
		try {
			const s = this.getMemoryBuffer().slice(e, e + t), r = new TextDecoder().decode(s);
			return BigInt(this.io.open(r, i, n));
		} catch (s) {
			return BigInt(Ve(s));
		}
	}
	hostClose(e) {
		const t = Number(e), i = this.sharedPipes.get(t);
		if (i) return "read" === i.end ? i.pipe.closeRead() : i.pipe.closeWrite(), this.sharedPipes.delete(t), 0;
		if (t >= 0 && t <= 2) return 0;
		try {
			return this.io.close(t);
		} catch (n) {
			return Ve(n);
		}
	}
	hostRead(e, t, i) {
		const n = Number(e), s = this.sharedPipes.get(n);
		if (s) {
			const e = this.getMemoryBuffer(), n = new Uint8Array(e.buffer, t, i);
			return s.pipe.read(n);
		}
		if (0 === n) {
			if (this.callbacks.onStdin) {
				const e = this.callbacks.onStdin(i);
				if (null === e) return 0;
				if (0 === e.length) return -11;
				const n = this.getMemoryBuffer(), s = Math.min(e.length, i);
				return n.set(e.subarray(0, s), t), s;
			}
			return 0;
		}
		try {
			const e = this.getMemoryBuffer().subarray(t, t + i);
			return this.io.read(n, e, null, i);
		} catch (r) {
			return Ve(r);
		}
	}
	hostWrite(e, t, i) {
		const n = Number(e), s = this.getMemoryBuffer().slice(t, t + i), r = this.sharedPipes.get(n);
		if (r) return r.pipe.write(s);
		if (1 === n) return this.callbacks.onStdout ? this.callbacks.onStdout(s) : "undefined" != typeof process && process.stdout ? process.stdout.write(s) : console.log(new TextDecoder().decode(s)), i;
		if (2 === n) return this.callbacks.onStderr ? this.callbacks.onStderr(s) : "undefined" != typeof process && process.stderr ? process.stderr.write(s) : console.error(new TextDecoder().decode(s)), i;
		try {
			return this.io.write(n, s, null, i);
		} catch (o) {
			return Ve(o);
		}
	}
	hostSeek(e, t, i, n) {
		const s = Number(e), r = 4294967296 * i + (t >>> 0);
		try {
			return BigInt(this.io.seek(s, r, n));
		} catch (o) {
			return BigInt(Ve(o));
		}
	}
	hostFstat(e, t) {
		const i = Number(e);
		try {
			const e = this.io.fstat(i);
			return this.writeStatToMemory(t, e), 0;
		} catch (n) {
			return Ve(n);
		}
	}
	writeStatToMemory(e, t) {
		const i = this.getMemoryDataView();
		this.getMemoryBuffer().fill(0, e, e + 88), i.setBigUint64(e + 0, BigInt(t.dev), !0), i.setBigUint64(e + 8, BigInt(t.ino), !0), i.setUint32(e + 16, t.mode, !0), i.setUint32(e + 20, t.nlink, !0), i.setUint32(e + 24, t.uid, !0), i.setUint32(e + 28, t.gid, !0), i.setBigUint64(e + 32, BigInt(t.size), !0);
		const n = Math.floor(t.atimeMs / 1e3), s = Math.floor(t.atimeMs % 1e3 * 1e6);
		i.setBigUint64(e + 40, BigInt(n), !0), i.setUint32(e + 48, s, !0);
		const r = Math.floor(t.mtimeMs / 1e3), o = Math.floor(t.mtimeMs % 1e3 * 1e6);
		i.setBigUint64(e + 56, BigInt(r), !0), i.setUint32(e + 64, o, !0);
		const a = Math.floor(t.ctimeMs / 1e3), c = Math.floor(t.ctimeMs % 1e3 * 1e6);
		i.setBigUint64(e + 72, BigInt(a), !0), i.setUint32(e + 80, c, !0);
	}
	writeStatfsToMemory(e, t) {
		const i = this.getMemoryDataView();
		this.getMemoryBuffer().fill(0, e, e + 72);
		const n = (e) => Number.isFinite(e) ? Math.max(0, Math.floor(e)) >>> 0 : 0, s = (e) => !Number.isFinite(e) || e <= 0 ? 0n : BigInt(Math.min(Math.floor(e), Number.MAX_SAFE_INTEGER));
		i.setUint32(e + 0, n(t.type), !0), i.setUint32(e + 4, n(t.bsize), !0), i.setBigUint64(e + 8, s(t.blocks), !0), i.setBigUint64(e + 16, s(t.bfree), !0), i.setBigUint64(e + 24, s(t.bavail), !0), i.setBigUint64(e + 32, s(t.files), !0), i.setBigUint64(e + 40, s(t.ffree), !0), i.setBigUint64(e + 48, s(t.fsid), !0), i.setUint32(e + 56, n(t.namelen), !0), i.setUint32(e + 60, n(t.frsize), !0), i.setUint32(e + 64, n(t.flags), !0);
	}
	readPathFromMemory(e, t) {
		const i = this.getMemoryBuffer().slice(e, e + t);
		return new TextDecoder().decode(i);
	}
	hostStat(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t), s = this.io.stat(n);
			return this.writeStatToMemory(i, s), 0;
		} catch (n) {
			return Ve(n);
		}
	}
	hostLstat(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t), s = this.io.lstat(n);
			return this.writeStatToMemory(i, s), 0;
		} catch (n) {
			return Ve(n);
		}
	}
	hostStatfs(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t), s = this.io.statfs(n);
			return this.writeStatfsToMemory(i, s), 0;
		} catch (n) {
			return Ve(n);
		}
	}
	hostMkdir(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.mkdir(n, i), 0;
		} catch (n) {
			return Ve(n);
		}
	}
	hostRmdir(e, t) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.rmdir(i), 0;
		} catch (i) {
			return Ve(i);
		}
	}
	hostUnlink(e, t) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.unlink(i), 0;
		} catch (i) {
			return Ve(i);
		}
	}
	hostRename(e, t, i, n) {
		try {
			const s = this.readPathFromMemory(e, t), r = this.readPathFromMemory(i, n);
			return this.io.rename(s, r), 0;
		} catch (s) {
			return Ve(s);
		}
	}
	hostLink(e, t, i, n) {
		try {
			const s = this.readPathFromMemory(e, t), r = this.readPathFromMemory(i, n);
			return this.io.link(s, r), 0;
		} catch (s) {
			return Ve(s);
		}
	}
	hostSymlink(e, t, i, n) {
		try {
			const s = this.readPathFromMemory(e, t), r = this.readPathFromMemory(i, n);
			return this.io.symlink(s, r), 0;
		} catch (s) {
			return Ve(s);
		}
	}
	hostReadlink(e, t, i, n) {
		try {
			const s = this.readPathFromMemory(e, t), r = this.io.readlink(s), o = new TextEncoder().encode(r), a = Math.min(o.length, n);
			return this.getMemoryBuffer().set(o.subarray(0, a), i), a;
		} catch (s) {
			return Ve(s);
		}
	}
	hostChmod(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.chmod(n, i), 0;
		} catch (n) {
			return Ve(n);
		}
	}
	hostChown(e, t, i, n) {
		try {
			const s = this.readPathFromMemory(e, t);
			return this.io.chown(s, i, n), 0;
		} catch (s) {
			return Ve(s);
		}
	}
	hostAccess(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.access(n, i), 0;
		} catch (n) {
			return Ve(n);
		}
	}
	hostUtimensat(e, t, i, n, s, r) {
		try {
			const o = this.readPathFromMemory(e, t);
			return this.io.utimensat(o, Number(i), Number(n), Number(s), Number(r)), 0;
		} catch {
			return -1;
		}
	}
	hostWaitpid(e, t, i) {
		if (this.waitpidSab && this.callbacks.onWaitpid) {
			const n = new Int32Array(this.waitpidSab);
			Atomics.store(n, 0, 0), Atomics.store(n, 1, 0), Atomics.store(n, 2, 0), this.callbacks.onWaitpid(e, t), Atomics.wait(n, 0, 0);
			const s = Atomics.load(n, 1), r = Atomics.load(n, 2);
			return s < 0 || 0 !== i && this.memory && new DataView(this.memory.buffer).setInt32(i, r, !0), s;
		}
		if (!this.io.waitpid) return -10;
		try {
			const n = this.io.waitpid(e, t);
			return 0 !== i && this.memory && new DataView(this.memory.buffer).setInt32(i, n.status, !0), n.pid;
		} catch {
			return -10;
		}
	}
	hostOpendir(e, t) {
		try {
			const i = this.readPathFromMemory(e, t);
			return BigInt(this.io.opendir(i));
		} catch (i) {
			return BigInt(Ve(i));
		}
	}
	hostReaddir(e, t, i, n) {
		try {
			const s = Number(e), r = this.io.readdir(s);
			if (null === r) return 0;
			const o = this.getMemoryDataView(), a = this.getMemoryBuffer(), c = new TextEncoder().encode(r.name), h = Math.min(c.length, n);
			return o.setBigUint64(t, BigInt(r.ino), !0), o.setUint32(t + 8, r.type, !0), o.setUint32(t + 12, h, !0), a.set(c.subarray(0, h), i), 1;
		} catch (s) {
			return Ve(s);
		}
	}
	hostClosedir(e) {
		try {
			const t = Number(e);
			return this.io.closedir(t), 0;
		} catch {
			return -1;
		}
	}
	hostClockGettime(e, t, i) {
		try {
			const n = this.io.clockGettime(e), s = this.getMemoryDataView();
			return s.setBigInt64(t, BigInt(n.sec), !0), s.setBigInt64(i, BigInt(n.nsec), !0), 0;
		} catch {
			return -1;
		}
	}
	hostNanosleep(e, t) {
		try {
			return this.io.nanosleep(Number(e), Number(t)), 0;
		} catch {
			return -1;
		}
	}
	hostFtruncate(e, t) {
		try {
			return this.io.ftruncate(Number(e), Number(t)), 0;
		} catch {
			return -1;
		}
	}
	hostFsync(e) {
		try {
			return this.io.fsync(Number(e)), 0;
		} catch {
			return -1;
		}
	}
	hostFchmod(e, t) {
		try {
			return this.io.fchmod(Number(e), t), 0;
		} catch {
			return -1;
		}
	}
	hostFchown(e, t, i) {
		try {
			return this.io.fchown(Number(e), t, i), 0;
		} catch {
			return -1;
		}
	}
	hostKill(e, t) {
		return this.callbacks.onKill ? this.callbacks.onKill(e, t) : -3;
	}
	hostExec(e, t) {
		if (this.callbacks.onExec) {
			const i = this.getMemoryBuffer(), n = new TextDecoder().decode(i.slice(e, e + t));
			return this.callbacks.onExec(n);
		}
		return -2;
	}
	hostSetAlarm(e) {
		return this.callbacks.onAlarm ? this.callbacks.onAlarm(e) : 0;
	}
	hostSetPosixTimer(e, t, i, n) {
		return this.callbacks.onPosixTimer ? this.callbacks.onPosixTimer(e, t, i, n) : 0;
	}
	hostSigsuspendWait() {
		if (!this.signalWakeSab) return -4;
		const e = new Int32Array(this.signalWakeSab);
		if (1 === Atomics.compareExchange(e, 0, 1, 0)) {
			const t = Atomics.load(e, 1);
			return Atomics.store(e, 1, 0), t;
		}
		Atomics.wait(e, 0, 0);
		const t = Atomics.load(e, 1);
		return Atomics.store(e, 0, 0), Atomics.store(e, 1, 0), t;
	}
	socket(e, t, i) {
		const n = (0, this.instance.exports.kernel_socket)(e, t, i);
		if (n < 0) throw new Error("socket failed: errno " + -n);
		return n;
	}
	socketpair(e, t, i) {
		const n = this.instance.exports.kernel_socketpair, s = this.getMemoryDataView(), r = n(e, t, i, 4);
		if (r < 0) throw new Error("socketpair failed: errno " + -r);
		return [s.getInt32(4, !0), s.getInt32(8, !0)];
	}
	shutdown(e, t) {
		const i = (0, this.instance.exports.kernel_shutdown)(e, t);
		if (i < 0) throw new Error("shutdown failed: errno " + -i);
	}
	send(e, t, i = 0) {
		const n = this.instance.exports.kernel_send;
		this.getMemoryBuffer().set(t, 16);
		const s = n(e, 16, t.length, i);
		if (s < 0) throw new Error("send failed: errno " + -s);
		return s;
	}
	recv(e, t, i = 0) {
		const n = (0, this.instance.exports.kernel_recv)(e, 16, t, i);
		if (n < 0) throw new Error("recv failed: errno " + -n);
		return this.getMemoryBuffer().slice(16, 16 + n);
	}
	poll(e, t) {
		const i = this.instance.exports.kernel_poll, n = e.length, s = this.getMemoryDataView();
		for (let o = 0; o < n; o++) {
			const t = 16 + 8 * o;
			s.setInt32(t, e[o].fd, !0), s.setInt16(t + 4, e[o].events, !0), s.setInt16(t + 6, 0, !0);
		}
		const r = i(16, n, t);
		if (r < 0) throw new Error("poll failed: errno " + -r);
		return e.map((e, t) => ({
			fd: e.fd,
			events: e.events,
			revents: s.getInt16(16 + 8 * t + 6, !0)
		}));
	}
	getsockopt(e, t, i) {
		const n = this.instance.exports.kernel_getsockopt, s = this.getMemoryDataView(), r = n(e, t, i, 4);
		if (r < 0) throw new Error("getsockopt failed: errno " + -r);
		return s.getUint32(4, !0);
	}
	setsockopt(e, t, i, n) {
		const s = (0, this.instance.exports.kernel_setsockopt)(e, t, i, n);
		if (s < 0) throw new Error("setsockopt failed: errno " + -s);
	}
	tcgetattr(e) {
		const t = (0, this.instance.exports.kernel_tcgetattr)(e, 16, 48);
		if (t < 0) throw new Error("tcgetattr failed: errno " + -t);
		return this.getMemoryBuffer().slice(16, 64);
	}
	tcsetattr(e, t, i) {
		const n = this.instance.exports.kernel_tcsetattr;
		this.getMemoryBuffer().set(i, 16);
		const s = n(e, t, 16, i.length);
		if (s < 0) throw new Error("tcsetattr failed: errno " + -s);
	}
	ioctl(e, t, i) {
		const n = this.instance.exports.kernel_ioctl, s = this.getMemoryBuffer(), r = i ? i.length : 8;
		i && s.set(i, 16);
		const o = n(e, t, 16, r);
		if (o < 0) throw new Error("ioctl failed: errno " + -o);
		return s.slice(16, 16 + r);
	}
	signal(e, t) {
		const i = (0, this.instance.exports.kernel_signal)(e, t);
		if (i < 0) throw new Error("signal failed: errno " + -i);
		return i;
	}
	umask(e) {
		return (0, this.instance.exports.kernel_umask)(e);
	}
	uname() {
		const e = this.instance.exports.kernel_uname, t = e(16, 325);
		if (t < 0) throw new Error("uname failed: errno " + -t);
		const i = this.getMemoryBuffer(), n = new TextDecoder(), s = (e) => {
			const t = 16 + e;
			let s = t;
			for (; s < t + 65 && 0 !== i[s];) s++;
			return n.decode(i.slice(t, s));
		};
		return {
			sysname: s(0),
			nodename: s(65),
			release: s(130),
			version: s(195),
			machine: s(260)
		};
	}
	sysconf(e) {
		const t = (0, this.instance.exports.kernel_sysconf)(e);
		return Number(t);
	}
	dup3(e, t, i) {
		const n = (0, this.instance.exports.kernel_dup3)(e, t, i);
		if (n < 0) throw new Error("dup3 failed: errno " + -n);
		return n;
	}
	pipe2(e) {
		const t = this.instance.exports.kernel_pipe2, i = this.getMemoryDataView(), n = t(e, 4);
		if (n < 0) throw new Error("pipe2 failed: errno " + -n);
		return [i.getInt32(4, !0), i.getInt32(8, !0)];
	}
	ftruncate(e, t) {
		const i = (0, this.instance.exports.kernel_ftruncate)(e, 4294967295 & t, Math.floor(t / 4294967296));
		if (i < 0) throw new Error("ftruncate failed: errno " + -i);
	}
	fsync(e) {
		const t = (0, this.instance.exports.kernel_fsync)(e);
		if (t < 0) throw new Error("fsync failed: errno " + -t);
	}
	truncate(e, t, i) {
		const n = (0, this.instance.exports.kernel_truncate)(e, t, 4294967295 & i, Math.floor(i / 4294967296));
		if (n < 0) throw new Error("truncate failed: errno " + -n);
	}
	fdatasync(e) {
		const t = (0, this.instance.exports.kernel_fdatasync)(e);
		if (t < 0) throw new Error("fdatasync failed: errno " + -t);
	}
	fchmod(e, t) {
		const i = (0, this.instance.exports.kernel_fchmod)(e, t);
		if (i < 0) throw new Error("fchmod failed: errno " + -i);
	}
	fchown(e, t, i) {
		const n = (0, this.instance.exports.kernel_fchown)(e, t, i);
		if (n < 0) throw new Error("fchown failed: errno " + -n);
	}
	getpgrp() {
		return (0, this.instance.exports.kernel_getpgrp)();
	}
	setpgid(e, t) {
		const i = (0, this.instance.exports.kernel_setpgid)(e, t);
		if (i < 0) throw new Error("setpgid failed: errno " + -i);
	}
	getsid(e) {
		const t = (0, this.instance.exports.kernel_getsid)(e);
		if (t < 0) throw new Error("getsid failed: errno " + -t);
		return t;
	}
	setsid() {
		const e = (0, this.instance.exports.kernel_setsid)();
		if (e < 0) throw new Error("setsid failed: errno " + -e);
		return e;
	}
	setuid(e) {
		const t = (0, this.instance.exports.kernel_setuid)(e);
		if (t < 0) throw new Error("setuid failed: errno " + -t);
	}
	setgid(e) {
		const t = (0, this.instance.exports.kernel_setgid)(e);
		if (t < 0) throw new Error("setgid failed: errno " + -t);
	}
	seteuid(e) {
		const t = (0, this.instance.exports.kernel_seteuid)(e);
		if (t < 0) throw new Error("seteuid failed: errno " + -t);
	}
	setegid(e) {
		const t = (0, this.instance.exports.kernel_setegid)(e);
		if (t < 0) throw new Error("setegid failed: errno " + -t);
	}
	getrusage(e) {
		const t = (0, this.instance.exports.kernel_getrusage)(e, 16, 144);
		if (t < 0) throw new Error("getrusage failed: errno " + -t);
		return this.getMemoryBuffer().slice(16, 160);
	}
	select(e, t, i, n) {
		const s = this.instance.exports.kernel_select, r = this.getMemoryBuffer(), o = t ? 16 : 0, a = i ? 144 : 0, c = n ? 272 : 0;
		if (t) {
			r.fill(0, o, o + 128);
			for (const e of t) r[o + Math.floor(e / 8)] |= 1 << e % 8;
		}
		if (i) {
			r.fill(0, a, a + 128);
			for (const e of i) r[a + Math.floor(e / 8)] |= 1 << e % 8;
		}
		if (n) {
			r.fill(0, c, c + 128);
			for (const e of n) r[c + Math.floor(e / 8)] |= 1 << e % 8;
		}
		const h = s(e, o, a, c, 0);
		if (h < 0) throw new Error("select failed: errno " + -h);
		const l = (e, t) => t && e ? t.filter((t) => r[e + Math.floor(t / 8)] >> t % 8 & 1) : [];
		return {
			readReady: l(o, t),
			writeReady: l(a, i),
			exceptReady: l(c, n)
		};
	}
	hostNetConnect(e, t, i, n) {
		if (!this.io.network) return -111;
		try {
			const s = new Uint8Array(this.memory.buffer).slice(t, t + i);
			return this.io.network.connect(e, s, n), 0;
		} catch {
			return -111;
		}
	}
	hostNetConnectStatus(e) {
		if (!this.io.network) return -107;
		try {
			const t = this.io.network.connectStatus(e);
			return t > 0 ? -t : t;
		} catch {
			return -107;
		}
	}
	hostNetSend(e, t, i, n) {
		if (!this.io.network) return -107;
		try {
			const s = new Uint8Array(this.memory.buffer).slice(t, t + i);
			return this.io.network.send(e, s, n);
		} catch (s) {
			return 11 === s?.errno ? -11 : -32;
		}
	}
	hostNetRecv(e, t, i, n) {
		if (!this.io.network) return -107;
		try {
			const s = this.io.network.recv(e, i, n);
			return s.length > 0 && this.memory && new Uint8Array(this.memory.buffer).set(s, t), s.length;
		} catch (s) {
			return 11 === s?.errno ? -11 : -104;
		}
	}
	hostNetPoll(e, t) {
		if (!this.io.network) return -107;
		try {
			return this.io.network.poll ? this.io.network.poll(e, t) : 5 & t;
		} catch (i) {
			return "number" == typeof i?.errno ? -Math.abs(i.errno) : -104;
		}
	}
	hostNetClose(e) {
		if (!this.io.network) return 0;
		try {
			return this.io.network.close(e), 0;
		} catch {
			return 0;
		}
	}
	hostNetListen(e, t, i, n, s, r) {
		return this.callbacks.onNetListen ? this.callbacks.onNetListen(e, t, [
			i,
			n,
			s,
			r
		]) : 0;
	}
	hostUdpBind(e, t, i, n, s, r) {
		return this.callbacks.onUdpBind ? this.callbacks.onUdpBind(e, [
			t,
			i,
			n,
			s
		], r) : 0;
	}
	hostUdpUnbind(e) {
		return this.callbacks.onUdpUnbind ? this.callbacks.onUdpUnbind(e) : 0;
	}
	hostUdpSend(e, t, i, n, s, r, o, a, c, h, l, d) {
		if (!this.io.network?.sendDatagram) return -101;
		try {
			const f = this.getMemoryBuffer();
			let u = new Uint8Array([
				e,
				t,
				i,
				n
			]);
			0 === u[0] && 0 === u[1] && 0 === u[2] && 0 === u[3] && this.io.network.localAddress && (u = this.io.network.localAddress.slice());
			const p = f.slice(l, l + d), g = this.io.network.sendDatagram({
				srcAddr: u,
				srcPort: s,
				dstAddr: new Uint8Array([
					r,
					o,
					a,
					c
				]),
				dstPort: h,
				data: p
			});
			return 0 === g ? d : -g;
		} catch (f) {
			return "number" == typeof f?.errno ? -Math.abs(f.errno) : -101;
		}
	}
	hostGetaddrinfo(e, t, i, n) {
		if (!this.io.network) return -2;
		try {
			const s = new Uint8Array(this.memory.buffer), r = new TextDecoder().decode(s.slice(e, e + t)), o = this.io.network.getaddrinfo(r);
			return o.length > n ? -22 : (s.set(o, i), o.length);
		} catch (s) {
			return 11 === s?.errno ? -11 : -2;
		}
	}
	static F_GETLK = 12;
	static F_SETLK = 13;
	static F_SETLKW = 14;
	static F_UNLCK = 2;
	hostFcntlLock(t, i, n, s, r, o, a, c, l, d) {
		if (!this.sharedLockTable) return 0;
		try {
			const f = this.getMemoryBuffer(), u = new TextDecoder().decode(f.slice(t, t + i)), p = h.hashPath(u), g = BigInt(a) << 32n | BigInt(o >>> 0), m = BigInt(l) << 32n | BigInt(c >>> 0);
			switch (s) {
				case e.F_GETLK: {
					const t = this.sharedLockTable.getBlockingLock(p, r, g, m, n), i = this.getMemoryDataView();
					if (t) {
						i.setUint32(d, t.lockType, !0), i.setUint32(d + 4, t.pid, !0);
						const e = t.start;
						i.setUint32(d + 8, Number(4294967295n & e), !0), i.setUint32(d + 12, Number(e >> 32n & 4294967295n), !0);
						const n = t.len;
						i.setUint32(d + 16, Number(4294967295n & n), !0), i.setUint32(d + 20, Number(n >> 32n & 4294967295n), !0);
					} else i.setUint32(d, e.F_UNLCK, !0);
					return 0;
				}
				case e.F_SETLK:
				case e.F_SETLKW: return this.sharedLockTable.setLock(p, n, r, g, m) ? 0 : -11;
				default: return -22;
			}
		} catch {
			return -5;
		}
	}
	hostFork() {
		if (!this.forkSab) return -38;
		const e = new Int32Array(this.forkSab);
		return Atomics.store(e, 0, 0), Atomics.store(e, 1, 0), this.callbacks.onFork ? (this.callbacks.onFork(this.forkSab), Atomics.wait(e, 0, 0), Atomics.load(e, 1)) : -38;
	}
	hostFutexWait(e, t, i, n) {
		if (!this.memory) return -22;
		const s = new Int32Array(this.memory.buffer), r = e >>> 2, o = 4294967296n * BigInt(n >>> 0) + BigInt(i >>> 0), a = BigInt.asIntN(64, o);
		let c;
		a >= 0n && (c = Number(a / 1000000n), 0 === c && a > 0n && (c = 1));
		const h = Atomics.wait(s, r, t, c);
		return "timed-out" === h ? -110 : "not-equal" === h ? -11 : 0;
	}
	hostFutexWake(e, t) {
		if (!this.memory) return 0;
		const i = new Int32Array(this.memory.buffer), n = e >>> 2;
		return Atomics.notify(i, n, t);
	}
	hostClone(e, t, i, n, s) {
		return this.callbacks.onClone ? this.callbacks.onClone(e, t, i, n, s) : -38;
	}
};
const qe = new TextEncoder(), Ge = new TextDecoder();
function je(e) {
	const t = function(e) {
		for (let t = 0; t + 3 < e.length; t++) if (13 === e[t] && 10 === e[t + 1] && 13 === e[t + 2] && 10 === e[t + 3]) return t;
		return -1;
	}(e);
	if (t < 0) return {
		status: 200,
		headers: {},
		body: e
	};
	const i = Ge.decode(e.subarray(0, t)).split("\r\n"), n = i[0]?.match(/^HTTP\/[\d.]+ (\d+)/), s = n ? parseInt(n[1], 10) : 200, r = {};
	for (let c = 1; c < i.length; c++) {
		const e = i[c], t = e.indexOf(": ");
		if (t < 0) continue;
		const n = e.slice(0, t), s = e.slice(t + 2);
		"set-cookie" === n.toLowerCase() && r[n] ? r[n] += "\n" + s : r[n] = s;
	}
	let o = e.subarray(t + 4);
	const a = r["Transfer-Encoding"] ?? r["transfer-encoding"];
	return a && a.toLowerCase().includes("chunked") && (o = function(e) {
		const t = [];
		let i = 0;
		for (; i < e.length;) {
			let n = -1;
			for (let t = i; t + 1 < e.length; t++) if (13 === e[t] && 10 === e[t + 1]) {
				n = t;
				break;
			}
			if (n < 0) break;
			const s = Ge.decode(e.subarray(i, n)).trim(), r = parseInt(s, 16);
			if (Number.isNaN(r) || 0 === r) break;
			const o = n + 2, a = o + r;
			if (a > e.length) break;
			t.push(e.subarray(o, a)), i = a + 2;
		}
		return function(e) {
			if (0 === e.length) return new Uint8Array(0);
			if (1 === e.length) return e[0];
			const t = e.reduce((e, t) => e + t.length, 0), i = new Uint8Array(t);
			let n = 0;
			for (const s of e) i.set(s, n), n += s.length;
			return i;
		}(t);
	}(o), delete r["Transfer-Encoding"], delete r["transfer-encoding"]), {
		status: s,
		headers: r,
		body: new Uint8Array(o)
	};
}
function Xe(e, t, i = function() {
	let e = 0;
	return "function" == typeof SharedArrayBuffer && (e |= f.shared_array_buffer), "function" == typeof Atomics.wait && (e |= f.atomics_wait), "function" == typeof Atomics.waitAsync && (e |= f.atomics_wait_async), e;
}()) {
	const n = function(e, t) {
		const i = Ye(e, "kernel_host_adapter_manifest_ptr"), n = Ye(e, "kernel_host_adapter_manifest_len"), s = Je(i(), "kernel_host_adapter_manifest_ptr"), r = Je(n(), "kernel_host_adapter_manifest_len");
		if (r < 40) throw new Error(`kernel host adapter manifest is too small: ${r} bytes (expected at least 40)`);
		if (s + 40 > t.buffer.byteLength) throw new Error(`kernel host adapter manifest is out of bounds: ptr=${s} size=40 memory=${t.buffer.byteLength}`);
		const o = new DataView(t.buffer, s, 40);
		return {
			magic: Qe(o, "magic"),
			manifestVersion: Ze(o, "manifestVersion"),
			manifestSize: Ze(o, "manifestSize"),
			abiVersion: Qe(o, "abiVersion"),
			requiredHostAdapterVersion: Qe(o, "requiredHostAdapterVersion"),
			requiredWorkerFeatures: Qe(o, "requiredWorkerFeatures"),
			optionalKernelFeatures: Qe(o, "optionalKernelFeatures"),
			channelHeaderSize: Qe(o, "channelHeaderSize"),
			channelDataOffset: Qe(o, "channelDataOffset"),
			channelDataSize: Qe(o, "channelDataSize"),
			channelMinSize: Qe(o, "channelMinSize")
		};
	}(e, t);
	if (1296781399 !== n.magic) throw new Error(`kernel host adapter manifest has invalid magic: ${n.magic}`);
	if (1 !== n.manifestVersion) throw new Error(`kernel host adapter manifest version ${n.manifestVersion} is not supported by host manifest reader 1`);
	if (40 !== n.manifestSize) throw new Error(`kernel host adapter manifest size ${n.manifestSize} does not match host reader size 40`);
	if (15 !== n.abiVersion) throw new Error(`kernel host adapter manifest ABI version ${n.abiVersion} does not match host ABI version 15`);
	if (n.requiredHostAdapterVersion > 1) throw new Error(`kernel requires host adapter version ${n.requiredHostAdapterVersion}, but this host supports 1`);
	const s = n.requiredWorkerFeatures & ~i;
	if (0 !== s) throw new Error("kernel requires unsupported worker features: " + function(e) {
		const t = [];
		let i = 0;
		for (const [s, r] of Object.entries(f)) i |= r, 0 !== (e & r) && t.push(s);
		const n = e & ~i;
		0 !== n && t.push(`unknown(0x${n.toString(16)})`);
		return 0 === t.length ? "none" : t.join(", ");
	}(s));
	et("channel header size", n.channelHeaderSize, 72), et("channel data offset", n.channelDataOffset, 72), et("channel data size", n.channelDataSize, g), et("channel minimum size", n.channelMinSize, m);
	for (const r of u) if ("function" != typeof e.exports[r]) throw new Error(`kernel wasm is missing required host adapter export ${r}`);
	return n;
}
function Ye(e, t) {
	const i = e.exports[t];
	if ("function" != typeof i) throw new Error(`kernel wasm is missing required host adapter export ${t}`);
	return i;
}
function Je(e, t) {
	const i = "bigint" == typeof e ? Number(e) : e;
	if (!Number.isSafeInteger(i) || i < 0) throw new Error(`${t} returned invalid manifest pointer/length ${String(e)}`);
	return i;
}
function Ze(e, t) {
	return e.getUint16(p[t].offset, !0);
}
function Qe(e, t) {
	return e.getUint32(p[t].offset, !0);
}
function et(e, t, i) {
	if (t !== i) throw new Error(`kernel host adapter manifest ${e} ${t} does not match generated host ABI value ${i}`);
}
const tt = 67108864;
const it = 11, nt = $, st = Y, rt = ce, ot = ue, at = H, ct = ke, ht = be, lt = oe, dt = ye, ft = me, ut = Ue, pt = we, gt = Ce, mt = ge, wt = R, yt = y, kt = v, bt = k, It = b, vt = I, xt = pe, _t = O, Pt = Te, Bt = te, At = ie, St = fe, Et = ve, Mt = Oe, Ut = 16777216, Ct = Z, zt = N, Tt = W, Ot = F, Rt = he, $t = Ie, Nt = B, Wt = P, Ft = j, Lt = X, Dt = K, Kt = V, Vt = q, Ht = G, qt = le, Gt = de, jt = L, Xt = ze, Yt = D, Jt = Q, Zt = ee, Qt = _e, ei = Pe, ti = S, ii = Se, ni = Ee, si = Me, ri = Be, oi = Ae, ai = "undefined" != typeof process && !!{}.WASM_POSIX_PROFILE, ci = new Set([
	P,
	V,
	G,
	j,
	ee,
	de
]), hi = new Set([
	B,
	K,
	q,
	X,
	Q,
	le,
	xe
]);
const li = m;
const di = {
	1: "open",
	2: "close",
	3: "read",
	4: "write",
	5: "lseek",
	6: "fstat",
	7: "dup",
	8: "dup2",
	9: "pipe",
	10: "fcntl",
	11: "stat",
	12: "lstat",
	13: "mkdir",
	14: "rmdir",
	15: "unlink",
	16: "rename",
	17: "link",
	18: "symlink",
	19: "readlink",
	20: "chmod",
	21: "chown",
	22: "access",
	23: "getcwd",
	24: "chdir",
	25: "opendir",
	26: "readdir",
	27: "closedir",
	28: "getpid",
	29: "getppid",
	30: "getuid",
	31: "geteuid",
	32: "getgid",
	33: "getegid",
	34: "exit",
	35: "kill",
	36: "sigaction",
	37: "sigprocmask",
	38: "raise",
	39: "alarm",
	40: "clock_gettime",
	41: "nanosleep",
	42: "isatty",
	43: "getenv",
	44: "setenv",
	45: "unsetenv",
	46: "mmap",
	47: "munmap",
	48: "brk",
	49: "mprotect",
	50: "socket",
	51: "bind",
	52: "listen",
	53: "accept",
	54: "connect",
	55: "send",
	56: "recv",
	57: "shutdown",
	58: "getsockopt",
	59: "setsockopt",
	60: "poll",
	61: "socketpair",
	62: "sendto",
	63: "recvfrom",
	64: "pread",
	65: "pwrite",
	66: "time",
	67: "gettimeofday",
	68: "usleep",
	69: "openat",
	70: "tcgetattr",
	71: "tcsetattr",
	72: "ioctl",
	73: "signal",
	74: "umask",
	75: "uname",
	76: "sysconf",
	77: "dup3",
	78: "pipe2",
	79: "ftruncate",
	80: "fsync",
	81: "writev",
	82: "readv",
	83: "getrlimit",
	84: "setrlimit",
	85: "truncate",
	86: "fdatasync",
	87: "fchmod",
	88: "fchown",
	89: "getpgrp",
	90: "setpgid",
	91: "getsid",
	92: "setsid",
	93: "fstatat",
	94: "unlinkat",
	95: "mkdirat",
	96: "renameat",
	97: "faccessat",
	98: "fchmodat",
	99: "fchownat",
	100: "linkat",
	101: "symlinkat",
	102: "readlinkat",
	103: "select",
	104: "setuid",
	105: "setgid",
	106: "seteuid",
	107: "setegid",
	108: "getrusage",
	109: "realpath",
	110: "sigsuspend",
	111: "pause",
	112: "pathconf",
	113: "fpathconf",
	114: "getsockname",
	115: "getpeername",
	116: "rewinddir",
	117: "telldir",
	118: "seekdir",
	119: "_llseek",
	120: "getrandom",
	121: "flock",
	122: "getdents64",
	123: "clock_getres",
	124: "clock_nanosleep",
	125: "utimensat",
	126: "mremap",
	127: "fchdir",
	128: "madvise",
	129: "statfs64",
	130: "fstatfs64",
	131: "setresuid",
	132: "getresuid",
	133: "setresgid",
	134: "getresgid",
	135: "getgroups",
	136: "setgroups",
	137: "sendmsg",
	138: "recvmsg",
	139: "wait4",
	140: "getaddrinfo",
	200: "futex",
	201: "clone",
	202: "gettid",
	203: "set_tid_address",
	205: "rt_sigqueueinfo",
	206: "rt_sigpending",
	207: "rt_sigtimedwait",
	208: "rt_sigreturn",
	209: "sigaltstack",
	211: "execve",
	212: "fork",
	213: "vfork",
	214: "getpgid",
	215: "setreuid",
	216: "setregid",
	223: "prctl",
	224: "getitimer",
	225: "setitimer",
	226: "clock_settime",
	229: "sched_yield",
	230: "sched_getparam",
	236: "sched_rr_get_interval",
	239: "epoll_create1",
	240: "epoll_ctl",
	241: "epoll_pwait",
	250: "prlimit64",
	251: "ppoll",
	252: "pselect6",
	260: "statx",
	261: "set_robust_list",
	262: "get_robust_list",
	271: "mknod",
	272: "mknodat",
	278: "msync",
	288: "waitid",
	294: "sendfile",
	295: "preadv",
	296: "pwritev",
	308: "fallocate",
	326: "timer_create",
	327: "timer_settime",
	328: "timer_gettime",
	329: "timer_getoverrun",
	330: "timer_delete",
	331: "mq_open",
	332: "mq_unlink",
	333: "mq_timedsend",
	334: "mq_timedreceive",
	335: "mq_notify",
	336: "mq_getsetattr",
	337: "msgget",
	338: "msgrcv",
	339: "msgsnd",
	340: "msgctl",
	341: "semget",
	342: "semop",
	343: "semctl",
	344: "shmget",
	345: "shmat",
	346: "shmdt",
	347: "shmctl",
	378: "epoll_create",
	379: "epoll_wait",
	382: "faccessat2",
	383: "fchmodat2",
	384: "accept4",
	386: "execveat",
	387: "exit_group",
	415: "thread_cancel",
	500: "spawn"
}, fi = {
	1: "EPERM",
	2: "ENOENT",
	3: "ESRCH",
	4: "EINTR",
	5: "EIO",
	6: "ENXIO",
	7: "E2BIG",
	8: "ENOEXEC",
	9: "EBADF",
	10: "ECHILD",
	11: "EAGAIN",
	12: "ENOMEM",
	13: "EACCES",
	14: "EFAULT",
	16: "EBUSY",
	17: "EEXIST",
	19: "ENODEV",
	20: "ENOTDIR",
	21: "EISDIR",
	22: "EINVAL",
	28: "ENOSPC",
	29: "ESPIPE",
	30: "EROFS",
	36: "ENAMETOOLONG",
	38: "ENOSYS",
	39: "ENOTEMPTY",
	61: "ENODATA",
	75: "EOVERFLOW",
	88: "ENOTSOCK",
	90: "EMSGSIZE",
	92: "ENOPROTOOPT",
	93: "EPROTONOSUPPORT",
	95: "EOPNOTSUPP",
	97: "EAFNOSUPPORT",
	98: "EADDRINUSE",
	99: "EADDRNOTAVAIL",
	100: "ENETDOWN",
	103: "ECONNABORTED",
	104: "ECONNRESET",
	106: "EISCONN",
	107: "ENOTCONN",
	110: "ETIMEDOUT",
	111: "ECONNREFUSED",
	115: "EINPROGRESS"
};
var ui = class {
	config;
	io;
	callbacks;
	kernel;
	kernelInstance = null;
	kernelMemory = null;
	kernelAbiVersion = 0;
	processes = /* @__PURE__ */ new Map();
	activeChannels = [];
	scratchOffset = 0;
	initialized = !1;
	nextChildPid = 100;
	allocatePid() {
		for (; this.processes.has(this.nextChildPid);) this.nextChildPid++;
		return this.nextChildPid++;
	}
	channelTids = /* @__PURE__ */ new Map();
	threadForkContexts = /* @__PURE__ */ new Map();
	currentHandlePid = 0;
	bindKernelTidForChannel(e) {
		const t = this.channelTids.get(`${e.pid}:${e.channelOffset}`) ?? 0, i = this.kernelInstance?.exports.kernel_set_current_tid;
		i && i(t);
	}
	alarmTimers = /* @__PURE__ */ new Map();
	posixTimers = /* @__PURE__ */ new Map();
	pendingSleeps = /* @__PURE__ */ new Map();
	threadCtidPtrs = /* @__PURE__ */ new Map();
	tcpListeners = /* @__PURE__ */ new Map();
	tcpListenerTargets = /* @__PURE__ */ new Map();
	tcpListenerRRIndex = /* @__PURE__ */ new Map();
	udpBindings = /* @__PURE__ */ new Set();
	tcpScratchOffset = 0;
	netModule = null;
	waitingForChild = [];
	cachedKernelMem = null;
	cachedKernelBuffer = null;
	pendingPollRetries = /* @__PURE__ */ new Map();
	pendingSelectRetries = /* @__PURE__ */ new Map();
	wakeScheduled = !1;
	pendingPipeReaders = /* @__PURE__ */ new Map();
	pendingPipeWriters = /* @__PURE__ */ new Map();
	socketTimeoutTimers = /* @__PURE__ */ new Map();
	pendingFutexWaits = /* @__PURE__ */ new Map();
	pendingCancels = /* @__PURE__ */ new Set();
	profileData = ai ? /* @__PURE__ */ new Map() : null;
	stdinBuffers = /* @__PURE__ */ new Map();
	stdinFinite = /* @__PURE__ */ new Set();
	tcpConnections = /* @__PURE__ */ new Map();
	sharedMappings = /* @__PURE__ */ new Map();
	epollInterests = /* @__PURE__ */ new Map();
	lockTable = null;
	shmMappings = /* @__PURE__ */ new Map();
	ptyIndexByPid = /* @__PURE__ */ new Map();
	activePtyIndices = /* @__PURE__ */ new Set();
	ptyOutputCallbacks = /* @__PURE__ */ new Map();
	virtualMacAddress;
	constructor(e, t, i = {}) {
		if (this.config = e, this.io = t, this.callbacks = i, this.kernel = new He(e, t, {
			onStdin: (e) => {
				const t = this.currentHandlePid, i = this.stdinBuffers.get(t);
				if (!i) return this.stdinFinite.has(t) ? null : new Uint8Array(0);
				const n = i.data.length - i.offset;
				if (n <= 0) return this.stdinBuffers.delete(t), this.stdinFinite.has(t) ? null : new Uint8Array(0);
				const s = Math.min(n, e), r = i.data.subarray(i.offset, i.offset + s);
				return i.offset += s, i.offset >= i.data.length && this.stdinBuffers.delete(t), r;
			},
			onAlarm: (e) => {
				const t = this.currentHandlePid;
				if (0 === t) return 0;
				const i = this.alarmTimers.get(t);
				if (i && (clearTimeout(i), this.alarmTimers.delete(t)), e > 0) {
					const i = setTimeout(() => {
						this.alarmTimers.delete(t), this.processes.has(t) && this.sendSignalToProcess(t, 14);
					}, 1e3 * e);
					this.alarmTimers.set(t, i);
				}
				return 0;
			},
			onNetListen: (e, t, i) => {
				const n = this.currentHandlePid;
				return 0 === n || this.startTcpListener(n, e, t, i), 0;
			},
			onUdpBind: (e, t, i) => {
				const n = this.currentHandlePid;
				if (0 === n || !this.io.network?.bindUdp) return 0;
				const s = `${n}:${e}`, r = this.io.network.bindUdp(s, new Uint8Array(t), i, { receive: (e) => this.injectUdpDatagram(n, e) });
				return 0 === r && this.udpBindings.add(s), 0 === r ? 0 : -r;
			},
			onUdpUnbind: (e) => {
				const t = this.currentHandlePid;
				if (0 === t || !this.io.network?.unbindUdp) return 0;
				const i = `${t}:${e}`;
				return this.io.network.unbindUdp(i), this.udpBindings.delete(i), 0;
			},
			onPosixTimer: (e, t, i, n) => {
				const s = this.currentHandlePid;
				if (0 === s) return 0;
				const r = `${s}:${e}`, o = this.posixTimers.get(r);
				if (o && (clearTimeout(o.timeout), o.interval && clearInterval(o.interval), this.posixTimers.delete(r)), i > 0 || n > 0) {
					const o = setTimeout(() => {
						if (this.processes.has(s)) if (this.sendSignalToProcess(s, t), n > 0) {
							const i = setInterval(() => {
								if (!this.processes.has(s)) {
									const e = this.posixTimers.get(r);
									e?.interval && clearInterval(e.interval), this.posixTimers.delete(r);
									return;
								}
								const i = this.kernelInstance.exports.kernel_posix_timer_interval_fire;
								i && i(s, e) || this.sendSignalToProcess(s, t);
							}, n), o = this.posixTimers.get(r);
							o && (o.interval = i);
						} else this.posixTimers.delete(r);
						else this.posixTimers.delete(r);
					}, Math.max(0, i));
					this.posixTimers.set(r, {
						timeout: o,
						signo: t
					});
				}
				return 0;
			}
		}), this.virtualMacAddress = new Uint8Array(6), void 0 !== globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(this.virtualMacAddress);
		else for (let n = 0; n < 6; n++) this.virtualMacAddress[n] = Math.floor(256 * Math.random());
		this.virtualMacAddress[0] = 254 & this.virtualMacAddress[0] | 2;
	}
	async init(e) {
		await this.kernel.init(e), this.kernelInstance = this.kernel.getInstance(), this.kernelMemory = this.kernel.getMemory();
		const t = this.kernelInstance.exports[d];
		if ("function" != typeof t) throw new Error(`kernel wasm is missing the ${d} export — refusing to run. Rebuild the kernel (bash build.sh) against the current ABI.`);
		this.kernelAbiVersion = t(), Xe(this.kernelInstance, this.kernelMemory);
		const i = this.kernelInstance.exports.kernel_alloc_scratch;
		if (this.scratchOffset = Number(i(li)), 0 === this.scratchOffset) throw new Error("Failed to allocate kernel scratch buffer");
		try {
			const e = await import("./__vite-browser-external-mcShZeDB.js").then((e) => a(e.default, 1));
			"function" == typeof e.createServer && (this.netModule = e);
		} catch {}
		if (this.tcpScratchOffset = Number(i(65536)), 0 === this.tcpScratchOffset) throw new Error("Failed to allocate TCP scratch buffer");
		this.lockTable = h.create(), this.kernel.registerSharedLockTable(this.lockTable.getBuffer()), this.initialized = !0;
	}
	registerProcess(e, t, i, n) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		if (this.hostReaped.delete(e), !n?.skipKernelCreate) {
			const t = (0, this.kernelInstance.exports.kernel_create_process)(e);
			if (t < 0) throw new Error(`Failed to create process ${e}: errno ${-t}`);
		}
		if (void 0 !== n?.brkBase && !this.setBrkBase(e, n.brkBase)) throw new Error("Kernel export kernel_set_brk_base is required for compact process memory layout");
		if (n?.argv && n.argv.length > 0) {
			const t = this.kernelInstance.exports.kernel_set_process_argv;
			if (t) {
				const i = new TextEncoder(), s = n.argv.join("\0"), r = i.encode(s), o = new Uint8Array(this.kernelMemory.buffer), a = this.scratchOffset;
				o.set(r, a), t(e, this.toKernelPtr(a), r.length);
			}
		}
		const s = this.kernelInstance.exports.kernel_set_max_addr;
		if (s) {
			const t = n?.maxAddr ?? (i.length > 0 ? Math.min(...i) : void 0);
			void 0 !== t && s(e, this.toKernelPtr(t));
		}
		if (void 0 !== n?.mmapBase && !this.setMmapBase(e, n.mmapBase)) throw new Error("Kernel export kernel_set_mmap_base is required for compact process memory layout");
		if (void 0 !== n?.brkLimit && !this.setBrkLimit(e, n.brkLimit)) throw new Error("Kernel export kernel_set_brk_limit is required for legacy low-control layout");
		const r = i.map((i) => ({
			pid: e,
			memory: t,
			channelOffset: i,
			i32View: new Int32Array(t.buffer, i),
			consecutiveSyscalls: 0
		})), o = {
			pid: e,
			memory: t,
			channels: r,
			ptrWidth: n?.ptrWidth ?? 4,
			explicitMaxAddr: void 0 !== n?.maxAddr
		};
		if (this.processes.set(e, o), this.activeChannels.push(...r), this.usePolling) this.startPolling();
		else for (const a of r) this.listenOnChannel(a);
	}
	setStdinData(e, t) {
		this.stdinBuffers.set(e, {
			data: t,
			offset: 0
		}), this.stdinFinite.add(e);
		const i = this.kernelInstance.exports.kernel_set_stdin_pipe;
		i && i(e);
	}
	setOutputCallbacks(e) {
		this.kernel.mergeCallbacks(e);
	}
	appendStdinData(e, t) {
		const i = this.stdinBuffers.get(e);
		if (i) {
			const n = i.data.subarray(i.offset), s = new Uint8Array(n.length + t.length);
			s.set(n), s.set(t, n.length), this.stdinBuffers.set(e, {
				data: s,
				offset: 0
			});
		} else this.stdinBuffers.set(e, {
			data: t,
			offset: 0
		});
		this.scheduleWakeBlockedRetries();
	}
	setupPty(e) {
		const t = this.kernelInstance.exports.kernel_pty_create;
		if (!t) throw new Error("Kernel missing kernel_pty_create export");
		const i = t(e);
		if (i < 0) throw new Error("kernel_pty_create failed: errno " + -i);
		return this.ptyIndexByPid.set(e, i), this.activePtyIndices.add(i), i;
	}
	ptyMasterWrite(e, t) {
		const i = this.kernelInstance.exports.kernel_pty_master_write;
		i && (new Uint8Array(this.kernelMemory.buffer).set(t, this.scratchOffset), i(e, this.toKernelPtr(this.scratchOffset), t.length), this.drainPtyOutput(e), this.scheduleWakeBlockedRetries());
	}
	ptyMasterRead(e) {
		const t = this.kernelInstance.exports.kernel_pty_master_read;
		if (!t) return null;
		const i = t(e, this.toKernelPtr(this.scratchOffset), 4096);
		return i <= 0 ? null : new Uint8Array(this.kernelMemory.buffer).slice(this.scratchOffset, this.scratchOffset + i);
	}
	ptySetWinsize(e, t, i) {
		const n = this.kernelInstance.exports.kernel_pty_set_winsize;
		if (!n) return;
		n(e, t, i), this.scheduleWakeBlockedRetries();
		for (const [s, r] of Array.from(this.pendingSleeps.entries())) this.processes.has(s) && (this.dequeueSignalForDelivery(r.channel), new DataView(r.channel.memory.buffer, r.channel.channelOffset).getUint32(65560, !0) > 0 && (clearTimeout(r.timer), this.pendingSleeps.delete(s), this.completeChannel(r.channel, r.syscallNr, r.origArgs, Re[r.syscallNr], -1, 4)));
	}
	onPtyOutput(e, t) {
		this.ptyOutputCallbacks.set(e, t);
	}
	drainPtyOutput(e) {
		const t = this.ptyOutputCallbacks.get(e);
		if (t) for (;;) {
			const i = this.ptyMasterRead(e);
			if (!i) break;
			t(i);
		}
	}
	drainAllPtyOutputs() {
		if (0 !== this.activePtyIndices.size) for (const e of this.activePtyIndices) this.drainPtyOutput(e);
	}
	setCwd(e, t) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		const i = this.kernelInstance.exports.kernel_set_cwd;
		if (!i) return;
		const n = new TextEncoder().encode(t);
		new Uint8Array(this.kernelMemory.buffer).set(n, this.scratchOffset), i(e, this.toKernelPtr(this.scratchOffset), n.length);
	}
	setCredentials(e, t) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		if (null == t.uid && null == t.gid) return;
		const i = 4294967295, n = this.kernelInstance.exports.kernel_set_process_credentials;
		if (n) {
			const s = n(e, t.uid ?? i, t.gid ?? i);
			if (s < 0) throw new Error(`setCredentials failed for pid ${e}: errno ${-s}`);
			return;
		}
		const s = this.kernelInstance.exports.kernel_set_current_pid, r = this.kernelInstance.exports.kernel_setgid, o = this.kernelInstance.exports.kernel_setuid;
		if (s && r && o) try {
			if (s(e), null != t.gid) {
				const i = r(t.gid);
				if (i < 0) throw new Error(`setgid failed for pid ${e}: errno ${-i}`);
			}
			if (null != t.uid) {
				const i = o(t.uid);
				if (i < 0) throw new Error(`setuid failed for pid ${e}: errno ${-i}`);
			}
		} finally {
			s(0);
		}
	}
	syscallTraceEnabled = !1;
	syscallTraceRing = [];
	syscallTraceCap = 4096;
	enableSyscallTrace() {
		this.syscallTraceEnabled = !0;
	}
	disableSyscallTrace() {
		this.syscallTraceEnabled = !1, this.syscallTraceRing.length = 0;
	}
	drainSyscallTrace() {
		if (0 === this.syscallTraceRing.length) return [];
		const e = this.syscallTraceRing;
		return this.syscallTraceRing = [], e;
	}
	enumProcs() {
		if (!this.initialized) return [];
		const e = this.kernelInstance.exports.kernel_enum_procs;
		if (!e) return [];
		const t = e(this.toKernelPtr(this.scratchOffset), li);
		if (t <= 0) return [];
		const i = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, t), n = new Uint8Array(t);
		n.set(i);
		const s = function(e) {
			if (e.byteLength < 4) return [];
			const t = new DataView(e.buffer, e.byteOffset, e.byteLength), i = t.getUint32(0, !0);
			let n = 4;
			const s = [], r = new TextDecoder("utf-8", { fatal: !1 });
			for (let o = 0; o < i && !(n + 36 > e.byteLength); o++) {
				const i = t.getUint32(n, !0);
				n += 4;
				const o = t.getUint32(n, !0);
				n += 4;
				const a = t.getUint32(n, !0);
				n += 4;
				const c = t.getUint32(n, !0);
				n += 4;
				const h = Number(t.getBigUint64(n, !0));
				n += 8;
				const l = String.fromCharCode(t.getUint32(n, !0));
				n += 4;
				const d = t.getUint32(n, !0);
				n += 4;
				const f = t.getUint32(n, !0);
				if (n += 4, n + d + f > e.byteLength) break;
				const u = r.decode(e.subarray(n, n + d));
				n += d;
				const p = e.subarray(n, n + f);
				n += f;
				const g = r.decode(p).replace(/\0/g, " ").trimEnd();
				s.push({
					pid: i,
					ppid: o,
					uid: a,
					gid: c,
					vsizeBytes: h,
					state: l,
					comm: u,
					cmdline: g || `[${u}]`
				});
			}
			return s;
		}(n);
		for (const r of s) {
			const e = this.processes.get(r.pid);
			e && (r.memoryBytes = e.memory.buffer.byteLength);
		}
		return s;
	}
	readProcMaps(e) {
		if (!this.initialized) return null;
		const t = this.kernelInstance.exports.kernel_read_proc_maps;
		if (!t) return null;
		const i = t(e, this.toKernelPtr(this.scratchOffset), li);
		if (i < 0) return null;
		if (0 === i) return "";
		const n = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, i), s = new Uint8Array(i);
		return s.set(n), new TextDecoder("utf-8", { fatal: !1 }).decode(s);
	}
	unregisterProcess(e) {
		if (!this.processes.get(e)) return;
		this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.cleanupUdpBindings(e), this.cleanupTcpListeners(e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingPipeReaders(e), this.cleanupPendingPipeWriters(e);
		for (const [i, n] of this.socketTimeoutTimers) i.pid === e && (clearTimeout(n), this.socketTimeoutTimers.delete(i));
		for (const i of this.epollInterests.keys()) i.startsWith(`${e}:`) && this.epollInterests.delete(i);
		this.releaseAdvisoryLocksForPid(e), this.removeFromKernelProcessTable(e), this.processes.delete(e), this.stdinFinite.delete(e), this.stdinBuffers.delete(e), this.usePolling && 0 === this.processes.size && this.stopPolling();
		const t = this.ptyIndexByPid.get(e);
		void 0 !== t && (this.ptyIndexByPid.delete(e), this.activePtyIndices.delete(t), this.ptyOutputCallbacks.delete(t));
	}
	removeProcessFromKernelTable(e) {
		if (!this.initialized) return;
		const t = this.kernelInstance?.exports.kernel_remove_process;
		t && t(e);
	}
	releaseAdvisoryLocksForPid(e) {
		if (!this.lockTable) return;
		const t = this.lockTable.getBuffer();
		Atomics.store(new Int32Array(t), 0, 0), this.lockTable.removeLocksByPid(e);
	}
	deactivateProcess(e) {
		this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.processes.delete(e), this.stdinFinite.delete(e), this.stdinBuffers.delete(e), this.releaseAdvisoryLocksForPid(e);
		const t = this.alarmTimers.get(e);
		t && (clearTimeout(t), this.alarmTimers.delete(e));
		for (const [n, s] of this.posixTimers) n.startsWith(`${e}:`) && (clearTimeout(s.timeout), s.interval && clearInterval(s.interval), this.posixTimers.delete(n));
		const i = this.pendingSleeps.get(e);
		i && (clearTimeout(i.timer), this.pendingSleeps.delete(e)), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupUdpBindings(e), this.cleanupTcpListeners(e), this.hostReaped.delete(e);
	}
	kernelExecSetup(e) {
		return (0, this.kernelInstance.exports.kernel_exec_setup)(e);
	}
	prepareProcessForExec(e) {
		this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingPipeReaders(e), this.cleanupPendingPipeWriters(e);
		for (const [t, i] of this.socketTimeoutTimers) t.pid === e && (clearTimeout(i), this.socketTimeoutTimers.delete(t));
		this.processes.delete(e);
	}
	removeFromKernelProcessTable(e) {
		(0, this.kernelInstance.exports.kernel_remove_process)(e);
	}
	addChannel(e, t, i, n, s) {
		const r = this.processes.get(e);
		if (!r) throw new Error(`Process ${e} not registered`);
		const o = {
			pid: e,
			memory: r.memory,
			channelOffset: t,
			i32View: new Int32Array(r.memory.buffer, t),
			consecutiveSyscalls: 0
		};
		r.channels.push(o), this.activeChannels.push(o), void 0 !== i && this.channelTids.set(`${e}:${t}`, i), void 0 !== n && void 0 !== s && this.threadForkContexts.set(`${e}:${t}`, {
			fnPtr: n,
			argPtr: s
		});
		const a = this.kernelInstance.exports.kernel_set_max_addr;
		if (a && !r.explicitMaxAddr) {
			const i = t - 131072;
			i >= tt && a(e, this.toKernelPtr(i));
		}
		this.usePolling || this.listenOnChannel(o);
	}
	removeChannel(e, t) {
		const i = this.processes.get(e);
		i && (i.channels = i.channels.filter((e) => e.channelOffset !== t), this.activeChannels = this.activeChannels.filter((i) => !(i.pid === e && i.channelOffset === t)), this.channelTids.delete(`${e}:${t}`), this.threadForkContexts.delete(`${e}:${t}`));
	}
	listenOnChannel(e) {
		const t = new Int32Array(e.memory.buffer, e.channelOffset);
		e.i32View = t;
		const i = Atomics.load(t, 0);
		if (1 === i) return void (this.relistenBatchSize <= 1 ? setImmediate(() => {
			this.processes.has(e.pid) && this.handleSyscall(e);
		}) : this.handleSyscall(e));
		const n = Atomics.waitAsync(t, 0, i);
		n.async ? n.value.then(() => {
			this.processes.has(e.pid) && this.listenOnChannel(e);
		}) : this.relistenChannel(e);
	}
	getKernelMem() {
		const e = this.kernelMemory.buffer;
		return e !== this.cachedKernelBuffer && (this.cachedKernelMem = new Uint8Array(e), this.cachedKernelBuffer = e), this.cachedKernelMem;
	}
	getPtrWidth(e) {
		return this.processes.get(e)?.ptrWidth ?? 4;
	}
	toKernelPtr(e) {
		return this.kernel.toKernelPtr(e);
	}
	syscallRing = /* @__PURE__ */ new Map();
	dumpLastSyscalls(e) {
		return (this.syscallRing.get(e) ?? []).join("\n");
	}
	readCString(e, t, i = 256) {
		if (0 === t) return "(null)";
		const n = new Uint8Array(e.buffer);
		let s = 0;
		for (; s < i && t + s < n.length && 0 !== n[t + s];) s++;
		const r = new Uint8Array(s);
		return r.set(n.subarray(t, t + s)), new TextDecoder().decode(r);
	}
	formatSyscallEntry(e, t, i) {
		const n = di[t] ?? `syscall_${t}`, s = e.pid, r = this.channelTids.get(`${s}:${e.channelOffset}`), o = void 0 !== r ? `:t${r}` : "";
		switch (t) {
			case x: return `[${s}${o}] open("${this.readCString(e.memory, i[0])}", 0x${(i[1] >>> 0).toString(16)}, 0o${(i[2] >>> 0).toString(8)})`;
			case J: return `[${s}${o}] openat(${i[0]}, "${this.readCString(e.memory, i[1])}", 0x${(i[2] >>> 0).toString(16)}, 0o${(i[3] >>> 0).toString(8)})`;
			case E: return `[${s}${o}] stat("${this.readCString(e.memory, i[0])}")`;
			case M: return `[${s}${o}] lstat("${this.readCString(e.memory, i[0])}")`;
			case ne: return `[${s}${o}] fstatat(${i[0]}, "${this.readCString(e.memory, i[1])}", 0x${(i[3] >>> 0).toString(16)})`;
			case C: return `[${s}${o}] access("${this.readCString(e.memory, i[0])}", ${i[1]})`;
			case se: return `[${s}${o}] faccessat(${i[0]}, "${this.readCString(e.memory, i[1])}", ${i[2]})`;
			case z: return `[${s}${o}] chdir("${this.readCString(e.memory, i[0])}")`;
			case T: return `[${s}${o}] opendir("${this.readCString(e.memory, i[0])}")`;
			case U: return `[${s}${o}] readlink("${this.readCString(e.memory, i[0])}", ${i[2]})`;
			case re: return `[${s}${o}] readlinkat(${i[0]}, "${this.readCString(e.memory, i[1])}", ${i[3]})`;
			case ae: return `[${s}${o}] realpath("${this.readCString(e.memory, i[0])}")`;
			case P: return `[${s}${o}] read(${i[0]}, ${i[2]})`;
			case B: return `[${s}${o}] write(${i[0]}, ${i[2]})`;
			case _: return `[${s}${o}] close(${i[0]})`;
			case A: return `[${s}${o}] fstat(${i[0]})`;
			case S: return `[${s}${o}] fcntl(${i[0]}, ${i[1]}, ${i[2]})`;
			case N: return `[${s}${o}] mmap(0x${(i[0] >>> 0).toString(16)}, ${i[1] >>> 0}, ${i[2]}, 0x${(i[3] >>> 0).toString(16)}, ${i[4]}, ${i[5] >>> 0})`;
			case W: return `[${s}${o}] munmap(0x${(i[0] >>> 0).toString(16)}, ${i[1] >>> 0})`;
			case F: return `[${s}${o}] brk(0x${(i[0] >>> 0).toString(16)})`;
			case y: return `[${s}${o}] execve("${this.readCString(e.memory, i[0])}")`;
			case k: return `[${s}${o}] fork()`;
			case b: return `[${s}${o}] vfork()`;
			case pe: return `[${s}${o}] clone(0x${(i[0] >>> 0).toString(16)})`;
			case O: return `[${s}${o}] exit(${i[0]})`;
			case H: return `[${s}${o}] poll(${i[1]}, ${i[2]})`;
			case Z: return `[${s}${o}] ioctl(${i[0]}, 0x${(i[1] >>> 0).toString(16)})`;
			default: return `[${s}${o}] ${n}(${i.filter((e, t) => t < 3).join(", ")})`;
		}
	}
	formatSyscallReturn(e, t, i) {
		if (t < 0 || 0 !== i) return ` = ${t} (${fi[i] ?? `errno=${i}`})`;
		switch (e) {
			case N:
			case F: return ` = 0x${(t >>> 0).toString(16)}`;
			default: return ` = ${t}`;
		}
	}
	handleSyscall(e) {
		try {
			if (ai) {
				const t = new DataView(e.memory.buffer, e.channelOffset).getUint32(4, !0), i = performance.now();
				this._handleSyscallInner(e);
				const n = performance.now() - i;
				let s = this.profileData.get(t);
				s || (s = {
					count: 0,
					totalTimeMs: 0,
					retries: 0
				}, this.profileData.set(t, s)), s.count++, s.totalTimeMs += n;
				return;
			}
			this._handleSyscallInner(e);
		} catch (Di) {
			console.error(`[handleSyscall] UNCAUGHT ERROR pid=${e.pid}:`, Di), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
		}
	}
	_handleSyscallInner(e) {
		const t = new DataView(e.memory.buffer, e.channelOffset), i = t.getUint32(4, !0), n = [];
		for (let g = 0; g < 6; g++) n.push(Number(t.getBigInt64(8 + 8 * g, !0)));
		const s = e.channelOffset;
		let r = this.syscallRing.get(s);
		r || (r = [], this.syscallRing.set(s, r)), r.push(`  syscall=${i} args=[${n.join(",")}]`), r.length > 30 && r.shift(), this.syscallTraceEnabled && (this.syscallTraceRing.length >= this.syscallTraceCap && this.syscallTraceRing.shift(), this.syscallTraceRing.push({
			t: performance.now(),
			pid: e.pid,
			nr: i,
			args: [
				n[0] ?? 0,
				n[1] ?? 0,
				n[2] ?? 0,
				n[3] ?? 0,
				n[4] ?? 0,
				n[5] ?? 0
			]
		}));
		const o = this.config.syscallLogPtrWidth, a = void 0 !== o && this.processes.get(e.pid)?.ptrWidth === o, c = !!this.config.enableSyscallLog || a;
		let h = "";
		if (c && (h = this.formatSyscallEntry(e, i, n)), i === bt || i === It) return c && console.error(h), void this.handleFork(e, n);
		if (i === vt) return c && console.error(h), void this.handleSpawn(e, n);
		if (i === yt) return c && console.error(h), void this.handleExec(e, n);
		if (i === kt) return c && console.error(h), void this.handleExecveat(e, n);
		if (i === xt) return c && console.error(h), void this.handleClone(e, n);
		if (i === _t || i === Pt) return c && console.error(h), void this.handleExit(e, i, n);
		if (i === St) return c && console.error(h), void this.handleWaitpid(e, n);
		if (i === Et) return c && console.error(h), void this.handleWaitid(e, n);
		if (i === ot) {
			if (c) {
				const t = {
					0: "WAIT",
					1: "WAKE",
					2: "FD",
					3: "REQUEUE",
					4: "CMP_REQUEUE",
					5: "WAKE_OP",
					6: "LOCK_PI",
					7: "UNLOCK_PI",
					8: "TRYLOCK_PI",
					9: "WAIT_BITSET",
					10: "WAKE_BITSET",
					11: "WAIT_REQUEUE_PI",
					12: "CMP_REQUEUE_PI"
				}, i = 128, s = 256, r = n[1] >>> 0, o = -385 & r, a = t[o] ?? `op${o}`, c = (r & i ? "|PRIVATE" : "") + (r & s ? "|REALTIME" : ""), h = this.channelTids.get(`${e.pid}:${e.channelOffset}`), l = void 0 !== h ? `:t${h}` : "";
				console.error(`[${e.pid}${l}] futex(0x${(n[0] >>> 0).toString(16)}, ${a}${c}, val=${n[2]})`);
			}
			this.handleFutex(e, n);
			return;
		}
		if (i === Mt) return c && console.error(h), void this.handleThreadCancel(e, n);
		if (i === Jt || i === ei) return c && console.error(h), void this.handleWritev(e, i, n);
		if (i === Zt || i === Qt) return c && console.error(h), void this.handleReadv(e, i, n);
		if ((i === Nt || i === Lt) && n[2] > 65536) return void this.handleLargeWrite(e, i, n);
		if ((i === Wt || i === Ft) && n[2] > 65536) return void this.handleLargeRead(e, i, n);
		if (i === qt) return void this.handleSendmsg(e, n);
		if (i === Gt) return void this.handleRecvmsg(e, n);
		if (i === Ct) {
			const t = n[1] >>> 0;
			if (35090 === t) return void this.handleIoctlIfconf(e, n);
			if (35111 === t) return void this.handleIoctlIfhwaddr(e, n);
			if (35093 === t) return void this.handleIoctlIfaddr(e, n);
		}
		if (i === ti) {
			const t = n[1];
			if (5 === t || 6 === t || 7 === t || 12 === t || 13 === t || 14 === t || 36 === t || 37 === t || 38 === t) return void this.handleFcntlLock(e, n);
		}
		if (i === ft || i === ut) return void this.handleEpollCreate(e, i, n);
		if (i === pt) return void this.handleEpollCtl(e, n);
		if (i === dt || i === gt) return void this.handleEpollPwait(e, i, n);
		if (i === ni) return void this.handleIpcShmat(e, n);
		if (i === si) return void this.handleIpcShmdt(e, n);
		if (i === ii) return void this.handleSemctl(e, n);
		if (i === ht) return void this.handlePselect6(e, n);
		if (i === lt) return void this.handleSelect(e, n);
		const l = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = [...n], f = Re[i];
		let u = 0;
		if (f) {
			const t = new Uint8Array(e.memory.buffer), i = this.getKernelMem(), s = this.scratchOffset + 72;
			for (const e of f) {
				const r = n[e.argIndex];
				if (0 === r) continue;
				let o;
				if ("cstring" === e.size.type) {
					let e = 0;
					for (; 0 !== t[r + e] && e < 65536 - u - 1;) e++;
					o = e + 1;
				} else if ("arg" === e.size.type) o = n[e.size.argIndex] * (e.size.multiplier ?? 1) + (e.size.add ?? 0);
				else if ("deref" === e.size.type) {
					const i = n[e.size.argIndex];
					if (0 === i) continue;
					o = t[i] | t[i + 1] << 8 | t[i + 2] << 16 | t[i + 3] << 24;
				} else o = e.size.size;
				if (o <= 0) continue;
				if (u + o > 65536) {
					if (o = g - u, o <= 0) continue;
					"arg" === e.size.type && (d[e.size.argIndex] = o);
				}
				const a = s + u;
				"in" === e.direction || "inout" === e.direction ? i.set(t.subarray(r, r + o), a) : i.fill(0, a, a + o), d[e.argIndex] = a, u += o, u = u + 3 & -4;
			}
		}
		if (i === ct) {
			const t = n[2];
			if (0 !== t) {
				const i = new DataView(e.memory.buffer, t), n = Number(i.getBigInt64(0, !0)), s = Number(i.getBigInt64(8, !0));
				d[2] = 1e3 * n + Math.floor(s / 1e6);
			} else d[2] = -1;
			const i = n[3];
			if (0 !== i) {
				const t = new DataView(e.memory.buffer, i);
				d[3] = 1, d[4] = t.getUint32(0, !0), d[5] = t.getUint32(4, !0);
			} else d[3] = 0, d[4] = 0, d[5] = 0;
		}
		l.setUint32(4, i, !0);
		for (let g = 0; g < 6; g++) l.setBigInt64(8 + 8 * g, BigInt(d[g]), !0);
		const p = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		const m = globalThis.__sysprof, w = m ? performance.now() : 0;
		if (m) {
			const t = globalThis;
			t.__sysprofGap || (t.__sysprofGap = /* @__PURE__ */ new Map()), t.__sysprofLastSeen || (t.__sysprofLastSeen = /* @__PURE__ */ new Map());
			const i = t.__sysprofLastSeen.get(e.pid);
			if (void 0 !== i) {
				const n = w - i;
				let s = t.__sysprofGap.get(e.pid);
				s || (s = {
					count: 0,
					gapTotalMs: 0,
					gapMaxMs: 0
				}, t.__sysprofGap.set(e.pid, s)), s.count++, s.gapTotalMs += n, n > s.gapMaxMs && (s.gapMaxMs = n);
			}
			t.__sysprofLastSeen.set(e.pid, w);
		}
		try {
			p(this.toKernelPtr(this.scratchOffset), e.pid);
		} catch (Di) {
			c && console.error(h + " = KERNEL THROW"), console.error(`[handleSyscall] kernel threw for pid=${e.pid} syscall=${i} args=[${n}]:`, Di), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
			return;
		} finally {
			if (this.currentHandlePid = 0, m) {
				const t = performance.now() - w, s = globalThis;
				s.__sysprofTable || (s.__sysprofTable = /* @__PURE__ */ new Map());
				const r = `${e.pid}:${i}`;
				let o = s.__sysprofTable.get(r);
				o || (o = {
					count: 0,
					totalMs: 0,
					maxMs: 0
				}, s.__sysprofTable.set(r, o)), o.count++, o.totalMs += t, t > o.maxMs && (o.maxMs = t), t > 50 && console.warn(`[sysprof] slow pid=${e.pid} nr=${i} ${t.toFixed(1)}ms args=[${n.join(",")}]`);
			}
		}
		const y = Number(l.getBigInt64(56, !0)), k = l.getUint32(64, !0);
		y > 0 && this.ensureProcessMemoryCovers(e.pid, e.memory, i, y, n);
		const b = this.highControlFloorForProcess(e.pid);
		if (i === zt && y > 0 && y >>> 0 != 4294967295) {
			const t = y >>> 0, i = n[1] >>> 0;
			null !== b && t + i > b && console.error(`[MMAP ALERT] pid=${e.pid} mmap returned 0x${t.toString(16)} len=${i} — OVERLAPS THREAD REGION! args=[${n.map((e) => "0x" + (e >>> 0).toString(16)).join(",")}]`);
		}
		if (i === Rt && y > 0 && y >>> 0 != 4294967295) {
			const t = y >>> 0, i = n[2] >>> 0;
			null !== b && t + i > b && console.error(`[MREMAP ALERT] pid=${e.pid} mremap returned 0x${t.toString(16)} len=${i} — OVERLAPS THREAD REGION!`);
		}
		if (null !== b && i === Ot && y > b && console.error(`[BRK ALERT] pid=${e.pid} brk returned 0x${(y >>> 0).toString(16)} — IN THREAD REGION!`), i === zt && y > 0 && y >>> 0 != 4294967295) {
			const t = n[4], i = n[3] >>> 0;
			if (t >= 0 && !(32 & i) && (this.populateMmapFromFile(e, y >>> 0, n), 1 & i)) {
				const i = n[5] >>> 0;
				let s = this.sharedMappings.get(e.pid);
				s || (s = /* @__PURE__ */ new Map(), this.sharedMappings.set(e.pid, s)), s.set(y >>> 0, {
					fd: t,
					fileOffset: 4096 * i,
					len: n[1] >>> 0
				});
			}
		}
		i === $t && 0 === y && this.flushSharedMappings(e, n), i === Tt && 0 === y && (this.flushSharedMappings(e, n), this.cleanupSharedMappings(e.pid, n[0] >>> 0, n[1] >>> 0));
		const I = this.kernelInstance.exports.kernel_get_process_exit_status;
		if (I && I(e.pid) >= 128) this.handleProcessTerminated(e);
		else {
			if (i === ri && 0 === y && this.drainMqueueNotification(), this.dequeueSignalForDelivery(e), -1 === y && k === it) return c && console.error(h + " = -1 (EAGAIN, will retry)"), void this.handleBlockingRetry(e, i, n);
			this.handleSleepDelay(e, i, n, y, k) || (0 !== k || i !== Bt && i !== At || this.recheckDeferredWaitpids(), 0 === k && i === wt && (this.scheduleWakeBlockedRetries(), this.reapKilledProcessesAfterSyscall()), c && console.error(h + this.formatSyscallReturn(i, y, k)), this.completeChannel(e, i, n, f, y, k));
		}
	}
	dequeueSignalForDelivery(e) {
		const t = this.kernelInstance.exports.kernel_dequeue_signal;
		if (!t) return;
		const i = this.scratchOffset + w;
		if (t(e.pid, this.toKernelPtr(i)) > 0) {
			const t = this.getKernelMem();
			new Uint8Array(e.memory.buffer).set(t.subarray(i, i + 44), e.channelOffset + w);
		} else {
			const t = e.channelOffset + w;
			new Uint8Array(e.memory.buffer, t, 48).fill(0);
		}
	}
	completeChannel(e, t, i, n, s, r) {
		const o = new DataView(e.memory.buffer, e.channelOffset);
		if (n) {
			const t = new Uint8Array(e.memory.buffer), r = this.getKernelMem(), o = this.scratchOffset + 72;
			let a = 0;
			for (const e of n) {
				const n = i[e.argIndex];
				if (0 === n) continue;
				let c;
				if ("cstring" === e.size.type) {
					let e = 0;
					for (; 0 !== t[n + e] && e < 65536 - a - 1;) e++;
					c = e + 1;
				} else if ("arg" === e.size.type) c = i[e.size.argIndex] * (e.size.multiplier ?? 1) + (e.size.add ?? 0);
				else if ("deref" === e.size.type) {
					const n = i[e.size.argIndex];
					if (0 === n) continue;
					c = t[n] | t[n + 1] << 8 | t[n + 2] << 16 | t[n + 3] << 24;
				} else c = e.size.size;
				if (c <= 0) continue;
				if (a + c > 65536 && (c = g - a, c <= 0)) continue;
				const h = o + a;
				if ("out" === e.direction || "inout" === e.direction) {
					if ("out" === e.direction && s < 0) {
						a += c, a = a + 3 & -4;
						continue;
					}
					let i = c;
					if ("out" === e.direction && "arg" === e.size.type) {
						const t = e.copyRetvalAdd ?? 0;
						s > 0 && s + t < c && (i = s + t);
					}
					t.set(r.subarray(h, h + i), n);
				}
				a += c, a = a + 3 & -4;
			}
		}
		e.handling = !1, o.setBigInt64(56, BigInt(s), !0), o.setUint32(64, r, !0), this.clearSocketTimeout(e), this.drainAllPtyOutputs(), this.flushTcpSendPipes(e.pid);
		const a = new Int32Array(e.memory.buffer, e.channelOffset);
		Atomics.store(a, 0, 2), Atomics.notify(a, 0, 1), this.drainAndProcessWakeupEvents(), this.relistenChannel(e);
	}
	relistenCount = 0;
	relistenBatchSize = 64;
	usePolling = !1;
	pollMC = null;
	pollScheduled = !1;
	pollLastYield = 0;
	startPolling() {
		null === this.pollMC && (this.pollMC = new MessageChannel(), this.pollMC.port1.onmessage = () => this.pollTick(), this.pollLastYield = performance.now(), this.schedulePoll());
	}
	stopPolling() {
		null !== this.pollMC && (this.pollMC.port1.close(), this.pollMC = null, this.pollScheduled = !1);
	}
	schedulePoll() {
		if (this.pollScheduled || !this.pollMC) return;
		this.pollScheduled = !0;
		const e = performance.now();
		e - this.pollLastYield >= 4 ? (this.pollLastYield = e, setTimeout(() => {
			this.pollScheduled = !1, this.pollTick();
		}, 0)) : this.pollMC.port2.postMessage(null);
	}
	pollTick() {
		if (this.pollScheduled = !1, !this.pollMC || 0 === this.activeChannels.length) return;
		const e = this.activeChannels.slice();
		for (const t of e) {
			if (t.handling) continue;
			const e = new Int32Array(t.memory.buffer, t.channelOffset);
			t.i32View = e, 1 === Atomics.load(e, 0) && (t.handling = !0, this.handleSyscall(t));
		}
		this.schedulePoll();
	}
	relistenChannel(e) {
		e.handling = !1, this.processes.has(e.pid) && (this.usePolling || (this.relistenCount++, this.relistenCount >= this.relistenBatchSize ? (this.relistenCount = 0, setImmediate(() => this.listenOnChannel(e))) : queueMicrotask(() => this.listenOnChannel(e))));
	}
	completeChannelRaw(e, t, i) {
		e.handling = !1;
		const n = new DataView(e.memory.buffer, e.channelOffset);
		n.setBigInt64(56, BigInt(t), !0), n.setUint32(64, i, !0), this.clearSocketTimeout(e), this.pendingCancels.delete(e.channelOffset);
		const s = new Int32Array(e.memory.buffer, e.channelOffset);
		Atomics.store(s, 0, 2), Atomics.notify(s, 0, 1);
	}
	abandonChannel(e) {
		e.handling = !1, this.clearSocketTimeout(e), this.pendingCancels.delete(e.channelOffset);
	}
	resolvePollReadinessIndices(e, t) {
		const i = this.kernelInstance.exports.kernel_get_fd_pipe_idx ?? this.kernelInstance.exports.kernel_get_socket_recv_pipe, n = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		if (!i && !n) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const s = t[0], r = t[1];
		if (0 === s || 0 === r) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const o = this.activeChannels.find((t) => t.pid === e);
		if (!o) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const a = [], c = [], h = new DataView(o.memory.buffer);
		for (let l = 0; l < r; l++) {
			const t = h.getInt32(s + 8 * l, !0);
			if (t < 0) continue;
			const r = h.getInt16(s + 8 * l + 4, !0);
			if (i) {
				const n = i(e, t);
				n >= 0 && a.push(n);
			}
			if (n && 1 & r) {
				const i = n(e, t);
				i >= 0 && c.push(i);
			}
		}
		return {
			pipeIndices: a,
			acceptIndices: c
		};
	}
	resolveEpollReadinessIndices(e) {
		const t = this.kernelInstance.exports.kernel_get_socket_recv_pipe, i = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		if (!t && !i) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const n = `${e}:`, s = [], r = [];
		for (const [o, a] of this.epollInterests) if (o.startsWith(n)) for (const n of a) {
			if (t) {
				const i = t(e, n.fd);
				i >= 0 && s.push(i);
			}
			if (i && 1 & n.events) {
				const t = i(e, n.fd);
				t >= 0 && r.push(t);
			}
		}
		return {
			pipeIndices: s,
			acceptIndices: r
		};
	}
	wakeBlockedAccept(e) {
		const t = Array.from(this.pendingPollRetries.entries()).filter(([, t]) => t.acceptIndices?.includes(e));
		for (const [i, n] of t) this.pendingPollRetries.get(i) === n && (null !== n.timer && clearTimeout(n.timer), this.pendingPollRetries.delete(i), this.processes.has(n.channel.pid) && this.retrySyscall(n.channel));
	}
	wakeBlockedPoll(e, t) {
		const i = Array.from(this.pendingPollRetries.entries()).filter(([, i]) => i.channel.pid === e && i.pipeIndices.includes(t));
		for (const [n, s] of i) this.pendingPollRetries.get(n) === s && (null !== s.timer && clearTimeout(s.timer), this.pendingPollRetries.delete(n), this.processes.has(e) && this.retrySyscall(s.channel));
	}
	notifyPipeReadable(e, t) {
		const i = this.pendingPipeReaders.get(e);
		if (i && i.length > 0) {
			this.pendingPipeReaders.delete(e);
			for (const e of i) this.processes.has(e.pid) && this.retrySyscall(e.channel);
		}
		for (const [n, s] of this.pendingPollRetries) void 0 !== t && s.channel.pid !== t || s.pipeIndices.includes(e) && (null !== s.timer && clearTimeout(s.timer), this.pendingPollRetries.delete(n), this.processes.has(s.channel.pid) && this.retrySyscall(s.channel));
		this.scheduleWakeBlockedRetries();
	}
	notifyPipeWritable(e) {
		const t = this.pendingPipeWriters.get(e);
		if (t && t.length > 0) {
			this.pendingPipeWriters.delete(e);
			for (const e of t) this.processes.has(e.pid) && this.retrySyscall(e.channel);
		}
		this.scheduleWakeBlockedRetries();
	}
	cleanupPendingPollRetries(e) {
		for (const [t, i] of this.pendingPollRetries) i.channel.pid === e && (i.timer && clearTimeout(i.timer), this.pendingPollRetries.delete(t));
	}
	cleanupPendingSelectRetries(e) {
		for (const [t, i] of this.pendingSelectRetries) i.channel.pid === e && (null !== i.timer && (clearTimeout(i.timer), clearImmediate(i.timer)), this.pendingSelectRetries.delete(t));
	}
	drainAndProcessWakeupEvents() {
		const e = this.kernelInstance.exports.kernel_drain_wakeup_events;
		if (!e) return;
		const t = e(this.toKernelPtr(this.scratchOffset), 1280, 256);
		if (0 === t) return;
		const i = new Uint8Array(this.kernelMemory.buffer);
		let n = !1;
		for (let s = 0; s < t; s++) {
			const e = this.scratchOffset + 5 * s, t = i[e] | i[e + 1] << 8 | i[e + 2] << 16 | i[e + 3] << 24, r = i[e + 4];
			if (1 & r) {
				const e = this.pendingPipeReaders.get(t);
				if (e && e.length > 0) {
					this.pendingPipeReaders.delete(t);
					for (const t of e) this.processes.has(t.pid) && this.retrySyscall(t.channel);
				}
			}
			if (2 & r) {
				const e = this.pendingPipeWriters.get(t);
				if (e && e.length > 0) {
					this.pendingPipeWriters.delete(t);
					for (const t of e) this.processes.has(t.pid) && this.retrySyscall(t.channel);
				}
			}
			4 & r && this.wakeBlockedAccept(t), n = !0;
		}
		n && (this.anyPendingRetryNeedsSignalSafeWake() ? this.scheduleWakeBlockedRetriesDeferred() : this.scheduleWakeBlockedRetries());
	}
	anyPendingRetryNeedsSignalSafeWake() {
		for (const e of this.pendingPollRetries.values()) if (e.needsSignalSafeWake) return !0;
		for (const e of this.pendingSelectRetries.values()) if (e.needsSignalSafeWake) return !0;
		return !1;
	}
	scheduleWakeBlockedRetriesDeferred() {
		0 === this.pendingPollRetries.size && 0 === this.pendingSelectRetries.size && 0 === this.pendingPipeReaders.size && 0 === this.pendingPipeWriters.size || (this.postponeSignalSafePollRetries(50), this.wakeScheduled || (this.wakeScheduled = !0, setTimeout(() => {
			this.wakeScheduled = !1, this.wakeAllBlockedRetries();
		}, 50)));
	}
	postponeSignalSafePollRetries(e) {
		const t = Date.now();
		for (const [i, n] of this.pendingPollRetries) {
			if (!n.needsSignalSafeWake) continue;
			null !== n.timer && clearTimeout(n.timer);
			const s = n.deadline && n.deadline > 0 ? Math.max(1, n.deadline - t) : e;
			n.timer = setTimeout(() => {
				this.pendingPollRetries.delete(i), this.processes.has(n.channel.pid) && this.retrySyscall(n.channel);
			}, Math.max(1, Math.min(e, s)));
		}
	}
	scheduleWakeBlockedRetries() {
		this.wakeScheduled || 0 === this.pendingPollRetries.size && 0 === this.pendingSelectRetries.size && 0 === this.pendingPipeReaders.size && 0 === this.pendingPipeWriters.size || (this.wakeScheduled = !0, setImmediate(() => {
			this.wakeScheduled = !1, this.wakeAllBlockedRetries();
		}));
	}
	wakeAllBlockedRetries() {
		const e = Array.from(this.pendingPollRetries.entries()), t = Array.from(this.pendingSelectRetries.entries());
		this.pendingPollRetries.clear(), this.pendingSelectRetries.clear();
		for (const [i, n] of e) this.processes.has(n.channel.pid) && (null !== n.timer && clearTimeout(n.timer), this.retrySyscall(n.channel));
		for (const [, i] of t) this.processes.has(i.channel.pid) && (clearTimeout(i.timer), clearImmediate(i.timer), i.syscallNr === lt ? this.handleSelect(i.channel, i.origArgs) : this.handlePselect6(i.channel, i.origArgs));
		if (this.pendingPipeReaders.size > 0) {
			const e = Array.from(this.pendingPipeReaders.entries());
			this.pendingPipeReaders.clear();
			for (const [, t] of e) for (const e of t) this.processes.has(e.pid) && this.retrySyscall(e.channel);
		}
		if (this.pendingPipeWriters.size > 0) {
			const e = Array.from(this.pendingPipeWriters.entries());
			this.pendingPipeWriters.clear();
			for (const [, t] of e) for (const e of t) this.processes.has(e.pid) && this.retrySyscall(e.channel);
		}
	}
	cleanupPendingPipeReaders(e) {
		for (const [t, i] of this.pendingPipeReaders) {
			const n = i.filter((t) => t.pid !== e);
			0 === n.length ? this.pendingPipeReaders.delete(t) : this.pendingPipeReaders.set(t, n);
		}
	}
	cleanupPendingPipeWriters(e) {
		for (const [t, i] of this.pendingPipeWriters) {
			const n = i.filter((t) => t.pid !== e);
			0 === n.length ? this.pendingPipeWriters.delete(t) : this.pendingPipeWriters.set(t, n);
		}
	}
	clearSocketTimeout(e) {
		const t = this.socketTimeoutTimers.get(e);
		void 0 !== t && (clearTimeout(t), this.socketTimeoutTimers.delete(e));
	}
	removePendingPipeReader(e) {
		for (const [t, i] of this.pendingPipeReaders) {
			const n = i.filter((t) => t.channel !== e);
			0 === n.length ? this.pendingPipeReaders.delete(t) : n.length !== i.length && this.pendingPipeReaders.set(t, n);
		}
	}
	removePendingPipeWriter(e) {
		for (const [t, i] of this.pendingPipeWriters) {
			const n = i.filter((t) => t.channel !== e);
			0 === n.length ? this.pendingPipeWriters.delete(t) : n.length !== i.length && this.pendingPipeWriters.set(t, n);
		}
	}
	handleThreadCancel(e, t) {
		const i = t[0], n = this.processes.get(e.pid);
		if (this.completeChannelRaw(e, 0, 0), this.relistenChannel(e), !n) return;
		let s;
		for (const h of n.channels) {
			const t = this.channelTids.get(`${e.pid}:${h.channelOffset}`);
			if ((void 0 !== t ? t : e.pid) === i) {
				s = h;
				break;
			}
		}
		if (!s) return;
		this.pendingCancels.add(s.channelOffset);
		const r = this.pendingFutexWaits.get(s.channelOffset);
		if (r) {
			const e = new Int32Array(s.memory.buffer);
			Atomics.notify(e, r.futexIndex, 1);
			return;
		}
		const o = this.pendingPollRetries.get(s.channelOffset);
		if (o) return null !== o.timer && clearTimeout(o.timer), this.pendingPollRetries.delete(s.channelOffset), this.completeChannelRaw(s, -4, 4), void this.relistenChannel(s);
		const a = this.pendingSelectRetries.get(s.channelOffset);
		if (a && a.channel === s) return clearTimeout(a.timer), clearImmediate(a.timer), this.pendingSelectRetries.delete(s.channelOffset), this.completeChannelRaw(s, -4, 4), void this.relistenChannel(s);
		let c = !1;
		for (const [h, l] of this.pendingPipeReaders) {
			const e = l.filter((e) => e.channel !== s);
			e.length !== l.length && (0 === e.length ? this.pendingPipeReaders.delete(h) : this.pendingPipeReaders.set(h, e), c = !0);
		}
		for (const [h, l] of this.pendingPipeWriters) {
			const e = l.filter((e) => e.channel !== s);
			e.length !== l.length && (0 === e.length ? this.pendingPipeWriters.delete(h) : this.pendingPipeWriters.set(h, e), c = !0);
		}
		c && (this.clearSocketTimeout(s), this.completeChannelRaw(s, -4, 4), this.relistenChannel(s));
	}
	dumpProfile() {
		if (!this.profileData) return void console.error("[profile] Profiling not enabled. Set WASM_POSIX_PROFILE=1");
		const e = Array.from(this.profileData.entries()).sort((e, t) => t[1].totalTimeMs - e[1].totalTimeMs);
		let t = 0, i = 0, n = 0;
		console.error("\n=== Syscall Profile ==="), console.error(`${"Syscall".padEnd(8)} ${"Count".padStart(10)} ${"Time(ms)".padStart(12)} ${"Avg(ms)".padStart(10)} ${"Retries".padStart(10)}`), console.error("-".repeat(52));
		for (const [s, r] of e) t += r.count, i += r.totalTimeMs, n += r.retries, console.error(`${String(s).padEnd(8)} ${String(r.count).padStart(10)} ${r.totalTimeMs.toFixed(2).padStart(12)} ${(r.totalTimeMs / r.count).toFixed(3).padStart(10)} ${String(r.retries).padStart(10)}`);
		console.error("-".repeat(52)), console.error(`${"TOTAL".padEnd(8)} ${String(t).padStart(10)} ${i.toFixed(2).padStart(12)} ${(i / (t || 1)).toFixed(3).padStart(10)} ${String(n).padStart(10)}`), console.error(`Pending pipe readers: ${this.pendingPipeReaders.size}, writers: ${this.pendingPipeWriters.size}`), console.error("=== End Profile ===\n");
	}
	flushTcpSendPipes(e) {
		const t = this.tcpConnections.get(e);
		if (!t || 0 === t.length) return;
		const i = this.kernelInstance.exports.kernel_pipe_read, n = this.getKernelMem();
		for (const s of t) {
			for (;;) {
				const e = i(0, s.sendPipeIdx, this.toKernelPtr(s.scratchOffset), 65536);
				if (e <= 0) break;
				const t = Buffer.from(n.slice(s.scratchOffset, s.scratchOffset + e));
				s.clientSocket.destroyed || s.clientSocket.write(t);
			}
			s.schedulePump();
		}
	}
	handleBlockingRetry(e, t, i) {
		if (!this.processes.has(e.pid)) return;
		if (t === ot && !(127 & i[1])) {
			const t = i[0], n = i[2], s = new Int32Array(e.memory.buffer), r = t >>> 2;
			if (Atomics.load(s, r) !== n) return void this.retrySyscall(e);
			const o = Atomics.waitAsync(s, r, n);
			o.async ? o.value.then(() => {
				this.processes.has(e.pid) && this.retrySyscall(e);
			}) : setImmediate(() => this.retrySyscall(e));
			return;
		}
		if (t === at || t === ct) {
			let n = -1;
			const s = t === ct && 0 !== i[3];
			if (t === at) n = i[2];
			else {
				const t = i[2];
				if (0 !== t) {
					const i = new DataView(e.memory.buffer, t), s = Number(i.getBigInt64(0, !0)), r = Number(i.getBigInt64(8, !0));
					n = 1e3 * s + Math.floor(r / 1e6);
				}
			}
			if (0 === n) return void this.completeChannel(e, t, i, Re[t], 0, 0);
			const { pipeIndices: r, acceptIndices: o } = this.resolvePollReadinessIndices(e.pid, i), a = i[1];
			if (n > 0 && 0 === a) {
				const a = setTimeout(() => {
					this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.completeChannel(e, t, i, Re[t], 0, 0);
				}, n);
				this.pendingPollRetries.set(e.channelOffset, {
					timer: a,
					channel: e,
					pipeIndices: r,
					acceptIndices: o,
					needsSignalSafeWake: s,
					deadline: Date.now() + n
				});
				return;
			}
			const c = n > 0 ? Date.now() + n : -1, h = () => {
				this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && (c > 0 && Date.now() >= c ? this.completeChannel(e, t, i, Re[t], 0, 0) : this.retrySyscall(e));
			}, l = r.length > 0 || o.length > 0 ? c > 0 ? Math.min(c - Date.now(), 10) : 10 : c > 0 ? Math.min(c - Date.now(), 50) : 50, d = setTimeout(h, Math.max(l, 1));
			this.pendingPollRetries.set(e.channelOffset, {
				timer: d,
				channel: e,
				pipeIndices: r,
				acceptIndices: o,
				needsSignalSafeWake: s,
				deadline: c
			});
			return;
		}
		if (t === mt) {
			const n = i[2];
			if (0 === n) return void setTimeout(() => {
				this.processes.has(e.pid) && this.retrySyscall(e);
			}, 500);
			const s = new DataView(e.memory.buffer, n), r = Number(s.getBigInt64(0, !0)), o = Number(s.getBigInt64(8, !0)), a = 1e3 * r + Math.floor(o / 1e6), c = 11;
			a <= 0 ? this.completeChannel(e, t, i, Re[t], -1, c) : setTimeout(() => {
				this.processes.has(e.pid) && this.completeChannel(e, t, i, Re[t], -1, c);
			}, a);
			return;
		}
		if (function(e, t) {
			let i;
			switch (e) {
				case Dt:
				case Kt:
				case Vt:
				case Ht:
					i = t[3];
					break;
				case qt:
				case Gt:
					i = t[2];
					break;
				default: return !1;
			}
			return void 0 !== i && !!(64 & i);
		}(t, i)) return void this.completeChannel(e, t, i, Re[t], -1, it);
		if (ci.has(t) || hi.has(t) || t === jt || t === Xt || t === Yt) {
			const n = i[0], s = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (s && 1 === s(e.pid, n)) return void this.completeChannel(e, t, i, Re[t], -1, it);
		}
		if (t === ri || t === oi) {
			const n = i[0], s = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (s && 1 === s(e.pid, n)) return void this.completeChannel(e, t, i, Re[t], -1, it);
		}
		if (ci.has(t) || hi.has(t)) {
			const n = i[0], s = this.kernelInstance.exports.kernel_get_socket_timeout_ms;
			if (s && !this.socketTimeoutTimers.has(e)) {
				const r = ci.has(t) ? 1 : 0, o = Number(s(e.pid, n, r));
				if (o > 0) {
					const n = setTimeout(() => {
						this.socketTimeoutTimers.delete(e), this.removePendingPipeReader(e), this.processes.has(e.pid) && this.completeChannel(e, t, i, Re[t], -1, 110);
					}, o);
					this.socketTimeoutTimers.set(e, n);
				}
			}
		}
		if (ci.has(t)) {
			const n = i[0], s = this.kernelInstance.exports.kernel_get_fd_pipe_idx;
			if (s) {
				const i = s(e.pid, n);
				if (i >= 0) {
					let n = this.pendingPipeReaders.get(i);
					if (n || (n = [], this.pendingPipeReaders.set(i, n)), n.some((t) => t.channel === e) || n.push({
						channel: e,
						pid: e.pid
					}), ai) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (hi.has(t)) {
			const n = i[0], s = this.kernelInstance.exports.kernel_get_fd_send_pipe_idx;
			if (s) {
				const i = s(e.pid, n);
				if (i >= 0) {
					let n = this.pendingPipeWriters.get(i);
					if (n || (n = [], this.pendingPipeWriters.set(i, n)), n.some((t) => t.channel === e) || n.push({
						channel: e,
						pid: e.pid
					}), ai) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (t === jt || t === Xt) {
			const n = i[0], s = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
			if (s) {
				const i = s(e.pid, n);
				if (i >= 0) {
					const n = setTimeout(() => {
						this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.retrySyscall(e);
					}, 10);
					if (this.pendingPollRetries.set(e.channelOffset, {
						timer: n,
						channel: e,
						pipeIndices: [],
						acceptIndices: [i]
					}), ai) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (ai) {
			const e = this.profileData.get(t);
			e && e.retries++;
		}
		const n = setTimeout(() => {
			this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.retrySyscall(e);
		}, 10);
		this.pendingPollRetries.set(e.channelOffset, {
			timer: n,
			channel: e,
			pipeIndices: []
		});
	}
	retrySyscall(e) {
		const t = this.kernelInstance.exports.kernel_get_process_exit_status;
		t && t(e.pid) >= 128 ? this.handleProcessTerminated(e) : this.handleSyscall(e);
	}
	handleSleepDelay(e, t, i, n, s) {
		let r = 0;
		if (t === nt && n >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), i = e.getUint32(80, !0);
			r = 1e3 * t + Math.floor(i / 1e6);
		} else if (t === st && n >= 0) {
			const e = i[0] >>> 0;
			r = Math.max(1, Math.floor(e / 1e3));
		} else if (t === rt && n >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), i = e.getUint32(80, !0);
			r = 1e3 * t + Math.floor(i / 1e6);
		}
		if (r > 0) {
			const o = setTimeout(() => {
				this.pendingSleeps.delete(e.pid), this.processes.has(e.pid) && this.completeSleepWithSignalCheck(e, t, i, n, s);
			}, r);
			return this.pendingSleeps.set(e.pid, {
				timer: o,
				channel: e,
				syscallNr: t,
				origArgs: i,
				retVal: n,
				errVal: s
			}), !0;
		}
		return !1;
	}
	completeSleepWithSignalCheck(e, t, i, n, s) {
		this.dequeueSignalForDelivery(e), new DataView(e.memory.buffer, e.channelOffset).getUint32(65560, !0) > 0 ? this.completeChannel(e, t, i, Re[t], -1, 4) : this.completeChannel(e, t, i, Re[t], n, s);
	}
	handleFcntlLock(e, t) {
		const i = t[2], n = new Uint8Array(e.memory.buffer), s = this.getKernelMem(), r = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72;
		0 !== i && s.set(n.subarray(i, i + 32), o), r.setUint32(4, ti, !0), r.setBigInt64(8, BigInt(t[0]), !0), r.setBigInt64(16, BigInt(t[1]), !0), r.setBigInt64(24, BigInt(0 !== i ? o : 0), !0);
		for (let d = 3; d < 6; d++) r.setBigInt64(8 + 8 * d, BigInt(t[d]), !0);
		const a = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			a(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const c = Number(r.getBigInt64(56, !0)), h = r.getUint32(64, !0);
		0 !== i && c >= 0 && new Uint8Array(e.memory.buffer).set(s.subarray(o, o + 32), i);
		const l = t[1];
		-1 !== c || h !== it || 7 !== l && 14 !== l && 38 !== l ? this.completeChannel(e, ti, t, void 0, c, h) : this.handleBlockingRetry(e, ti, t);
	}
	handleSelect(e, t) {
		const i = 128, n = t[0], s = t[1], r = t[2], o = t[3], a = t[4];
		let c = -1;
		if (0 !== a) {
			const t = this.getPtrWidth(e.pid), i = new DataView(e.memory.buffer, a);
			let n, s;
			8 === t ? (n = Number(i.getBigInt64(0, !0)), s = Number(i.getBigInt64(8, !0))) : (n = i.getInt32(0, !0), s = i.getInt32(4, !0)), c = 1e3 * n + Math.floor(s / 1e3), c < 0 && (c = 0);
		}
		if (0 === n && 0 === s && 0 === r && 0 === o) {
			if (0 === c) return void this.completeChannel(e, lt, t, void 0, 0, 0);
			const i = c > 0, n = i ? setTimeout(() => {
				this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.completeChannel(e, lt, t, void 0, 0, 0);
			}, c) : null;
			this.pendingSelectRetries.set(e.channelOffset, {
				timer: n,
				channel: e,
				origArgs: t,
				deadline: i ? Date.now() + c : -1,
				needsSignalSafeWake: !1,
				syscallNr: lt
			});
			return;
		}
		const h = new Uint8Array(e.memory.buffer), l = this.getKernelMem(), d = new DataView(this.kernelMemory.buffer, this.scratchOffset), f = this.scratchOffset + 72;
		0 !== s ? l.set(h.subarray(s, s + i), f) : l.fill(0, f, f + i), 0 !== r ? l.set(h.subarray(r, r + i), f + i) : l.fill(0, f + i, f + 256), 0 !== o ? l.set(h.subarray(o, o + i), f + 256) : l.fill(0, f + 256, f + 384), d.setUint32(4, lt, !0), d.setBigInt64(8, BigInt(n), !0), d.setBigInt64(16, BigInt(0 !== s ? f : 0), !0), d.setBigInt64(24, BigInt(0 !== r ? f + i : 0), !0), d.setBigInt64(32, BigInt(0 !== o ? f + 256 : 0), !0), d.setBigInt64(40, BigInt(c), !0);
		const u = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			u(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const p = Number(d.getBigInt64(56, !0)), g = d.getUint32(64, !0);
		if (p >= 0) {
			const t = new Uint8Array(e.memory.buffer);
			0 !== s && t.set(l.subarray(f, f + i), s), 0 !== r && t.set(l.subarray(f + i, f + 256), r), 0 !== o && t.set(l.subarray(f + 256, f + 384), o);
		}
		if (this.dequeueSignalForDelivery(e), -1 === p && g === it) {
			if (0 === c) return void this.completeChannel(e, lt, t, void 0, 0, 0);
			const i = c > 0 ? Date.now() + c : -1, n = () => {
				this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && (i > 0 && Date.now() >= i ? this.completeChannel(e, lt, t, void 0, 0, 0) : this.handleSelect(e, t));
			}, s = c > 0 ? Math.max(i - Date.now(), 1) : 50, r = setTimeout(n, Math.min(s, 50));
			this.pendingSelectRetries.set(e.channelOffset, {
				timer: r,
				channel: e,
				origArgs: t,
				deadline: i,
				needsSignalSafeWake: !1,
				syscallNr: lt
			});
			return;
		}
		this.completeChannel(e, lt, t, void 0, p, g);
	}
	handlePselect6(e, t) {
		const i = 128, n = new Uint8Array(e.memory.buffer), s = this.getKernelMem(), r = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72, a = t[0], c = t[1], h = t[2], l = t[3], d = t[4], f = t[5];
		0 !== c ? s.set(n.subarray(c, c + i), o) : s.fill(0, o, o + i), 0 !== h ? s.set(n.subarray(h, h + i), o + i) : s.fill(0, o + i, o + 256), 0 !== l ? s.set(n.subarray(l, l + i), o + 256) : s.fill(0, o + 256, o + 384);
		let u = -1;
		if (0 !== d) {
			const t = new DataView(e.memory.buffer, d), i = Number(t.getBigInt64(0, !0)), n = Number(t.getBigInt64(8, !0));
			u = 1e3 * i + Math.floor(n / 1e6);
		}
		const p = o + 384;
		let g = 0;
		if (0 !== f) {
			const t = this.getPtrWidth(e.pid), i = new DataView(e.memory.buffer, f), r = 8 === t ? Number(i.getBigUint64(0, !0)) : i.getUint32(0, !0);
			0 !== r && (s.set(n.subarray(r, r + 8), p), g = p);
		}
		r.setUint32(4, ht, !0), r.setBigInt64(8, BigInt(a), !0), r.setBigInt64(16, BigInt(0 !== c ? o : 0), !0), r.setBigInt64(24, BigInt(0 !== h ? o + i : 0), !0), r.setBigInt64(32, BigInt(0 !== l ? o + 256 : 0), !0), r.setBigInt64(40, BigInt(u), !0), r.setBigInt64(48, BigInt(g), !0);
		const m = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			m(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const w = Number(r.getBigInt64(56, !0)), y = r.getUint32(64, !0);
		if (w >= 0) {
			const t = new Uint8Array(e.memory.buffer);
			0 !== c && t.set(s.subarray(o, o + i), c), 0 !== h && t.set(s.subarray(o + i, o + 256), h), 0 !== l && t.set(s.subarray(o + 256, o + 384), l);
		}
		if (this.dequeueSignalForDelivery(e), -1 === w && y === it) {
			if (0 === u) return void this.completeChannel(e, ht, t, void 0, 0, 0);
			const i = u > 0 ? Date.now() + u : -1, n = 0 !== f;
			if (0 === a) {
				if (u > 0) {
					const s = setTimeout(() => {
						this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.completeChannel(e, ht, t, void 0, 0, 0);
					}, u);
					this.pendingSelectRetries.set(e.channelOffset, {
						timer: s,
						channel: e,
						origArgs: t,
						deadline: i,
						needsSignalSafeWake: n,
						syscallNr: ht
					});
				} else this.pendingSelectRetries.set(e.channelOffset, {
					timer: null,
					channel: e,
					origArgs: t,
					deadline: -1,
					needsSignalSafeWake: n,
					syscallNr: ht
				});
				return;
			}
			const s = setImmediate(() => {
				this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && (i > 0 && Date.now() >= i ? this.completeChannel(e, ht, t, void 0, 0, 0) : this.handlePselect6(e, t));
			});
			this.pendingSelectRetries.set(e.channelOffset, {
				timer: s,
				channel: e,
				origArgs: t,
				deadline: i,
				needsSignalSafeWake: n,
				syscallNr: ht
			});
			return;
		}
		this.completeChannel(e, ht, t, void 0, w, y);
	}
	handleEpollCreate(e, t, i) {
		const n = new DataView(this.kernelMemory.buffer, this.scratchOffset), s = i[0], r = t === ut ? 0 : s;
		n.setUint32(4, t, !0), n.setBigInt64(8, BigInt(r), !0);
		for (let h = 1; h < 6; h++) n.setBigInt64(8 + 8 * h, 0n, !0);
		const o = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			o(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const a = Number(n.getBigInt64(56, !0)), c = n.getUint32(64, !0);
		if (a >= 0) {
			const t = `${e.pid}:${a}`;
			this.epollInterests.set(t, []);
		}
		this.completeChannel(e, t, i, void 0, a, c);
	}
	handleEpollCtl(e, t) {
		const i = t[0], n = t[1], s = t[2], r = t[3];
		let o = 0, a = 0n;
		if (0 !== r) {
			const t = new DataView(e.memory.buffer, r);
			o = t.getUint32(0, !0), a = t.getBigUint64(4, !0);
		}
		const c = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.getKernelMem(), l = this.scratchOffset + 72;
		if (0 !== r) {
			const t = new Uint8Array(e.memory.buffer);
			h.set(t.subarray(r, r + 12), l);
		}
		c.setUint32(4, pt, !0), c.setBigInt64(8, BigInt(i), !0), c.setBigInt64(16, BigInt(n), !0), c.setBigInt64(24, BigInt(s), !0), c.setBigInt64(32, BigInt(0 !== r ? l : 0), !0), c.setBigInt64(40, BigInt(0), !0), c.setBigInt64(48, BigInt(0), !0);
		const d = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			d(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const f = Number(c.getBigInt64(56, !0)), u = c.getUint32(64, !0);
		if (0 === f) {
			const t = 1, r = 2, c = 3, h = `${e.pid}:${i}`;
			let l = this.epollInterests.get(h);
			if (l || (l = [], this.epollInterests.set(h, l)), n === t) l.push({
				fd: s,
				events: o,
				data: a
			});
			else if (n === r) {
				const e = l.findIndex((e) => e.fd === s);
				e >= 0 && l.splice(e, 1);
			} else if (n === c) {
				const e = l.find((e) => e.fd === s);
				e && (e.events = o, e.data = a);
			}
		}
		this.completeChannel(e, pt, t, void 0, f, u);
	}
	handleEpollPwait(e, t, i) {
		const n = i[0], s = i[1], r = i[2], o = i[3];
		if (r <= 0) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const a = `${e.pid}:${n}`, c = this.epollInterests.get(a);
		if (!c) return this.completeChannelRaw(e, -9, 9), void this.relistenChannel(e);
		if (0 === c.length) {
			if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
			const n = setTimeout(() => {
				this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.handleEpollPwait(e, t, i);
			}, 10);
			this.pendingPollRetries.set(e.channelOffset, {
				timer: n,
				channel: e,
				pipeIndices: []
			});
			return;
		}
		const h = c.length;
		if (8 * h > 65536) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		this.getKernelMem();
		const l = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72;
		for (let k = 0; k < h; k++) {
			const e = c[k], t = d + 8 * k;
			let i = 0;
			1 & e.events && (i |= 1), 4 & e.events && (i |= 4), new DataView(this.kernelMemory.buffer).setInt32(t, e.fd, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 4, i, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 6, 0, !0);
		}
		l.setUint32(4, at, !0), l.setBigInt64(8, BigInt(d), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(0), !0);
		for (let k = 3; k < 6; k++) l.setBigInt64(8 + 8 * k, 0n, !0);
		const f = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			f(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const u = Number(l.getBigInt64(56, !0)), p = l.getUint32(64, !0);
		if (this.dequeueSignalForDelivery(e), u < 0 && p !== it) return this.completeChannelRaw(e, u, p), void this.relistenChannel(e);
		let g = 0;
		if (u > 0) {
			const t = new DataView(e.memory.buffer);
			for (let e = 0; e < h && g < r; e++) {
				const i = d + 8 * e, n = new DataView(this.kernelMemory.buffer).getInt16(i + 6, !0);
				if (0 !== n) {
					let i = 0;
					1 & n && (i |= 1), 4 & n && (i |= 4), 8 & n && (i |= 8), 16 & n && (i |= 16);
					const r = s + 12 * g;
					t.setUint32(r, i, !0), t.setBigUint64(r + 4, c[e].data, !0), g++;
				}
			}
		}
		if (g > 0) return this.completeChannelRaw(e, g, 0), void this.relistenChannel(e);
		if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
		const { pipeIndices: m, acceptIndices: w } = this.resolveEpollReadinessIndices(e.pid), y = setTimeout(() => {
			this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.handleEpollPwait(e, t, i);
		}, 10);
		this.pendingPollRetries.set(e.channelOffset, {
			timer: y,
			channel: e,
			pipeIndices: m,
			acceptIndices: w
		});
	}
	handleIoctlIfconf(e, t) {
		const i = new DataView(e.memory.buffer), n = new Uint8Array(e.memory.buffer), s = this.getPtrWidth(e.pid), r = t[2], o = i.getInt32(r, !0);
		let a;
		a = 8 === s ? Number(i.getBigUint64(r + 8, !0)) : i.getUint32(r + 4, !0);
		if (o >= 32 && 0 !== a) {
			const e = new TextEncoder().encode("eth0");
			n.set(e, a), n.fill(0, a + e.length, a + 16), n.fill(0, a + 16, a + 32), i.setUint16(a + 16, 2, !0), n[a + 20] = 127, n[a + 21] = 0, n[a + 22] = 0, n[a + 23] = 1, i.setInt32(r, 32, !0);
		} else i.setInt32(r, 0, !0);
		this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	handleIoctlIfhwaddr(e, t) {
		const i = new DataView(e.memory.buffer), n = new Uint8Array(e.memory.buffer), s = t[2];
		n.fill(0, s + 16, s + 32), i.setUint16(s + 16, 1, !0), n.set(this.virtualMacAddress, s + 18), this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	handleIoctlIfaddr(e, t) {
		const i = new DataView(e.memory.buffer), n = new Uint8Array(e.memory.buffer), s = t[2];
		n.fill(0, s + 16, s + 32), i.setUint16(s + 16, 2, !0), n[s + 20] = 127, n[s + 21] = 0, n[s + 22] = 0, n[s + 23] = 1, this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	handleWritev(e, t, i) {
		const n = i[0], s = i[1], r = i[2], o = new Uint8Array(e.memory.buffer), a = new DataView(e.memory.buffer), c = this.getKernelMem(), h = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.scratchOffset + 72, d = this.getPtrWidth(e.pid), f = 8 === d ? 16 : 8, u = [];
		let p = 0;
		for (let g = 0; g < r; g++) {
			let e, t;
			8 === d ? (e = Number(a.getBigUint64(s + g * f, !0)), t = Number(a.getBigUint64(s + g * f + 8, !0))) : (e = a.getUint32(s + g * f, !0), t = a.getUint32(s + g * f + 4, !0)), u.push({
				base: e,
				len: t
			}), p += t;
		}
		const m = 8 * r;
		if (p <= g - m) {
			let s = m;
			for (let e = 0; e < r; e++) {
				const t = l + s;
				u[e].len > 0 && c.set(o.subarray(u[e].base, u[e].base + u[e].len), t);
				const i = l + 8 * e;
				new DataView(c.buffer).setUint32(i, t, !0), new DataView(c.buffer).setUint32(i + 4, u[e].len, !0), s += u[e].len, s = s + 3 & -4;
			}
			h.setUint32(4, t, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(r), !0), t === ei && (h.setBigInt64(32, BigInt(i[3]), !0), h.setBigInt64(40, BigInt(i[4]), !0));
			const a = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				a(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const d = Number(h.getBigInt64(56, !0)), f = h.getUint32(64, !0);
			if (-1 === d && f === it) return void this.handleBlockingRetry(e, t, i);
			this.completeChannel(e, t, i, void 0, d, f);
		} else {
			const s = this.kernelInstance.exports.kernel_handle_channel, r = t === ei;
			let a = r ? (0 | i[3]) + 4294967296 * (0 | i[4]) : 0, d = 0, f = !1;
			const p = 65528;
			for (const t of u) {
				if (0 === t.len) continue;
				let i = 0;
				for (; i < t.len;) {
					const u = Math.min(t.len - i, p), g = l + 8;
					c.set(o.subarray(t.base + i, t.base + i + u), g), new DataView(c.buffer).setUint32(l, g, !0), new DataView(c.buffer).setUint32(l + 4, u, !0), r ? (h.setUint32(4, ei, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(1), !0), h.setBigInt64(32, BigInt(4294967295 & a), !0), h.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (h.setUint32(4, Jt, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(1), !0)), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
					try {
						s(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					const m = Number(h.getBigInt64(56, !0)), w = h.getUint32(64, !0);
					if (-1 === m) {
						w === it && 0 === d && (f = !0);
						break;
					}
					if (i += m, d += m, r && (a += m), m < u) break;
				}
				if (f || i < t.len) break;
			}
			if (f) return void this.handleBlockingRetry(e, t, i);
			this.completeChannelRaw(e, d, 0), this.relistenChannel(e);
		}
	}
	handleLargeWrite(e, t, i) {
		const n = i[0], s = i[1], r = i[2], o = t === Lt;
		let a = o ? i[3] : 0;
		const c = new Uint8Array(e.memory.buffer), h = this.getKernelMem(), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72, f = this.kernelInstance.exports.kernel_handle_channel;
		let u = 0;
		for (; u < r;) {
			const p = Math.min(r - u, g);
			h.set(c.subarray(s + u, s + u + p), d), l.setUint32(4, t, !0), l.setBigInt64(8, BigInt(n), !0), l.setBigInt64(16, BigInt(d), !0), l.setBigInt64(24, BigInt(p), !0), o && l.setBigInt64(32, BigInt(a), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				f(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (Di) {
				console.error(`[handleLargeWrite] kernel threw for pid=${e.pid}:`, Di), u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			const m = Number(l.getBigInt64(56, !0)), w = l.getUint32(64, !0);
			if (-1 === m && w === it) return u > 0 ? (this.completeChannelRaw(e, u, 0), void this.relistenChannel(e)) : void this.handleBlockingRetry(e, t, i);
			if (0 !== w || m <= 0) return u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, m, w), void this.relistenChannel(e);
			if (u += m, o && (a += m), m < p) break;
		}
		this.dequeueSignalForDelivery(e), this.completeChannelRaw(e, u, 0), this.relistenChannel(e);
	}
	handleLargeRead(e, t, i) {
		const n = i[0], s = i[1], r = i[2], o = t === Ft;
		let a = o ? i[3] : 0;
		const c = new Uint8Array(e.memory.buffer), h = this.getKernelMem(), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72, f = this.kernelInstance.exports.kernel_handle_channel;
		let u = 0;
		for (; u < r;) {
			const p = Math.min(r - u, g);
			h.fill(0, d, d + p), l.setUint32(4, t, !0), l.setBigInt64(8, BigInt(n), !0), l.setBigInt64(16, BigInt(d), !0), l.setBigInt64(24, BigInt(p), !0), o && l.setBigInt64(32, BigInt(a), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				f(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (Di) {
				console.error(`[handleLargeRead] kernel threw for pid=${e.pid}:`, Di), u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			const m = Number(l.getBigInt64(56, !0)), w = l.getUint32(64, !0);
			if (-1 === m && w === it) return u > 0 ? (this.completeChannelRaw(e, u, 0), void this.relistenChannel(e)) : void this.handleBlockingRetry(e, t, i);
			if (0 !== w || m <= 0) return u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, m, w), void this.relistenChannel(e);
			if (c.set(h.subarray(d, d + m), s + u), u += m, o && (a += m), m < p) break;
		}
		this.dequeueSignalForDelivery(e), this.completeChannelRaw(e, u, 0), this.relistenChannel(e);
	}
	handleReadv(e, t, i) {
		const n = i[0], s = i[1], r = i[2], o = new Uint8Array(e.memory.buffer), a = new DataView(e.memory.buffer), c = this.getKernelMem(), h = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.scratchOffset + 72, d = this.getPtrWidth(e.pid), f = 8 === d ? 16 : 8, u = [];
		let p = 0;
		for (let g = 0; g < r; g++) {
			let e, t;
			8 === d ? (e = Number(a.getBigUint64(s + g * f, !0)), t = Number(a.getBigUint64(s + g * f + 8, !0))) : (e = a.getUint32(s + g * f, !0), t = a.getUint32(s + g * f + 4, !0)), u.push({
				base: e,
				len: t
			}), p += t;
		}
		if (p <= 65528 && r <= Math.floor(8192)) {
			let s = 8 * r;
			const a = [];
			for (let e = 0; e < r; e++) {
				const t = l + s;
				a.push({
					base: u[e].base,
					kernelBase: t,
					len: u[e].len
				}), u[e].len > 0 && c.fill(0, t, t + u[e].len);
				const i = l + 8 * e;
				new DataView(c.buffer).setUint32(i, t, !0), new DataView(c.buffer).setUint32(i + 4, u[e].len, !0), s += u[e].len, s = s + 3 & -4;
			}
			h.setUint32(4, t, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(r), !0), t === Qt && (h.setBigInt64(32, BigInt(i[3]), !0), h.setBigInt64(40, BigInt(i[4]), !0));
			const d = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				d(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const f = Number(h.getBigInt64(56, !0)), p = h.getUint32(64, !0);
			if (-1 === f && p === it) return void this.handleBlockingRetry(e, t, i);
			if (f > 0) {
				let e = f;
				for (const t of a) {
					if (e <= 0) break;
					const i = Math.min(t.len, e);
					o.set(c.subarray(t.kernelBase, t.kernelBase + i), t.base), e -= i;
				}
			}
			this.completeChannel(e, t, i, void 0, f, p);
		} else {
			const s = this.kernelInstance.exports.kernel_handle_channel, r = t === Qt;
			let a = r ? (0 | i[3]) + 4294967296 * (0 | i[4]) : 0, d = 0, f = 0, p = !1;
			for (const t of u) {
				if (0 === t.len) continue;
				let i = 0;
				for (; i < t.len;) {
					const u = Math.min(t.len - i, 65528), g = l + 8;
					new DataView(c.buffer).setUint32(l, g, !0), new DataView(c.buffer).setUint32(l + 4, u, !0), c.fill(0, g, g + u), r ? (h.setUint32(4, Qt, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(1), !0), h.setBigInt64(32, BigInt(4294967295 & a), !0), h.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (h.setUint32(4, Zt, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(1), !0)), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
					try {
						s(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					const m = Number(h.getBigInt64(56, !0)), w = h.getUint32(64, !0);
					if (-1 === m) {
						if (w === it && 0 === d) {
							p = !0;
							break;
						}
						f = w;
						break;
					}
					if (0 === m) break;
					if (o.set(c.subarray(g, g + m), t.base + i), i += m, d += m, r && (a += m), m < u) break;
				}
				if (p || f) break;
			}
			if (p) return void this.handleBlockingRetry(e, t, i);
			const g = d > 0 ? d : f ? -1 : 0, m = d > 0 ? 0 : f;
			this.completeChannel(e, t, i, void 0, g, m);
		}
	}
	handleSendmsg(e, t) {
		const i = t[0], n = t[1], s = t[2], r = new Uint8Array(e.memory.buffer), o = new DataView(e.memory.buffer), a = this.getKernelMem(), c = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.scratchOffset + 72, l = this.getPtrWidth(e.pid);
		let d, f, u, p, g, m;
		8 === l ? (d = Number(o.getBigUint64(n, !0)), f = o.getUint32(n + 8, !0), u = Number(o.getBigUint64(n + 16, !0)), p = o.getUint32(n + 24, !0), g = Number(o.getBigUint64(n + 32, !0)), m = o.getUint32(n + 40, !0)) : (d = o.getUint32(n, !0), f = o.getUint32(n + 4, !0), u = o.getUint32(n + 8, !0), p = o.getUint32(n + 12, !0), g = o.getUint32(n + 16, !0), m = o.getUint32(n + 20, !0));
		const w = h, y = new DataView(a.buffer);
		y.setUint32(w, d, !0), y.setUint32(w + 4, f, !0), y.setUint32(w + 8, u, !0), y.setUint32(w + 12, p, !0), y.setUint32(w + 16, g, !0), y.setUint32(w + 20, m, !0), y.setUint32(w + 24, 0, !0);
		let k = 28;
		if (0 !== d && f > 0 && k + f <= 65536) {
			const e = h + k;
			a.set(r.subarray(d, d + f), e), y.setUint32(w, e, !0), k += f, k = k + 3 & -4;
		}
		if (0 !== g && m > 0 && k + m <= 65536) {
			const e = h + k;
			a.set(r.subarray(g, g + m), e), y.setUint32(w + 16, e, !0), k += m, k = k + 3 & -4;
		}
		const b = 8 === l ? 16 : 8;
		if (p > 0 && 0 !== u) {
			const e = h + k;
			k += 8 * p, k = k + 3 & -4, y.setUint32(w + 8, e, !0);
			for (let t = 0; t < p; t++) {
				let i, n;
				if (8 === l ? (i = Number(o.getBigUint64(u + t * b, !0)), n = Number(o.getBigUint64(u + t * b + 8, !0))) : (i = o.getUint32(u + 8 * t, !0), n = o.getUint32(u + 8 * t + 4, !0)), y.setUint32(e + 8 * t, 0, !0), y.setUint32(e + 8 * t + 4, n, !0), n > 0 && k + n <= 65536) {
					const s = h + k;
					a.set(r.subarray(i, i + n), s), y.setUint32(e + 8 * t, s, !0), k += n, k = k + 3 & -4;
				}
			}
		}
		c.setUint32(4, qt, !0), c.setBigInt64(8, BigInt(i), !0), c.setBigInt64(16, BigInt(w), !0), c.setBigInt64(24, BigInt(s), !0);
		const I = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			I(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const v = Number(c.getBigInt64(56, !0)), x = c.getUint32(64, !0);
		-1 !== v || x !== it ? this.completeChannel(e, qt, t, void 0, v, x) : this.handleBlockingRetry(e, qt, t);
	}
	handleRecvmsg(e, t) {
		const i = t[0], n = t[1], s = t[2], r = new Uint8Array(e.memory.buffer), o = new DataView(e.memory.buffer), a = this.getKernelMem(), c = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.scratchOffset + 72, l = this.getPtrWidth(e.pid);
		let d, f, u, p, g, m;
		8 === l ? (d = Number(o.getBigUint64(n, !0)), f = o.getUint32(n + 8, !0), u = Number(o.getBigUint64(n + 16, !0)), p = o.getUint32(n + 24, !0), g = Number(o.getBigUint64(n + 32, !0)), m = o.getUint32(n + 40, !0)) : (d = o.getUint32(n, !0), f = o.getUint32(n + 4, !0), u = o.getUint32(n + 8, !0), p = o.getUint32(n + 12, !0), g = o.getUint32(n + 16, !0), m = o.getUint32(n + 20, !0));
		const w = h, y = new DataView(a.buffer);
		y.setUint32(w, d, !0), y.setUint32(w + 4, f, !0), y.setUint32(w + 8, u, !0), y.setUint32(w + 12, p, !0), y.setUint32(w + 16, g, !0), y.setUint32(w + 20, m, !0), y.setUint32(w + 24, 0, !0);
		let k = 28, b = 0;
		0 !== d && f > 0 && k + f <= 65536 && (b = h + k, a.fill(0, b, b + f), y.setUint32(w, b, !0), k += f, k = k + 3 & -4);
		let I = 0;
		0 !== g && m > 0 && k + m <= 65536 && (I = h + k, a.fill(0, I, I + m), y.setUint32(w + 16, I, !0), k += m, k = k + 3 & -4);
		const v = [], x = 8 === l ? 16 : 8;
		if (p > 0 && 0 !== u) {
			const e = h + k;
			k += 8 * p, k = k + 3 & -4, y.setUint32(w + 8, e, !0);
			for (let t = 0; t < p; t++) {
				let i, n;
				if (8 === l ? (i = Number(o.getBigUint64(u + t * x, !0)), n = Number(o.getBigUint64(u + t * x + 8, !0))) : (i = o.getUint32(u + 8 * t, !0), n = o.getUint32(u + 8 * t + 4, !0)), n > 0 && k + n <= 65536) {
					const s = h + k;
					a.fill(0, s, s + n), y.setUint32(e + 8 * t, s, !0), y.setUint32(e + 8 * t + 4, n, !0), v.push({
						base: i,
						len: n,
						kernelBase: s
					}), k += n, k = k + 3 & -4;
				} else y.setUint32(e + 8 * t, 0, !0), y.setUint32(e + 8 * t + 4, n, !0);
			}
		}
		c.setUint32(4, Gt, !0), c.setBigInt64(8, BigInt(i), !0), c.setBigInt64(16, BigInt(w), !0), c.setBigInt64(24, BigInt(s), !0);
		const _ = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			_(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const P = Number(c.getBigInt64(56, !0)), B = c.getUint32(64, !0);
		if (-1 === P && B === it) return void this.handleBlockingRetry(e, Gt, t);
		if (P > 0) {
			let e = P;
			for (const t of v) {
				if (e <= 0) break;
				const i = Math.min(t.len, e);
				r.set(a.subarray(t.kernelBase, t.kernelBase + i), t.base), e -= i;
			}
		}
		if (0 !== b && 0 !== d && f > 0 && r.set(a.subarray(b, b + f), d), 0 !== I && 0 !== g) {
			const e = y.getUint32(w + 20, !0);
			e > 0 && e <= m && r.set(a.subarray(I, I + e), g);
		}
		const A = y.getUint32(w + 4, !0), S = y.getUint32(w + 20, !0), E = y.getUint32(w + 24, !0);
		8 === l ? (o.setUint32(n + 8, A, !0), o.setUint32(n + 40, S, !0), o.setUint32(n + 44, E, !0)) : (o.setUint32(n + 4, A, !0), o.setUint32(n + 20, S, !0), o.setUint32(n + 24, E, !0)), this.completeChannel(e, Gt, t, void 0, P, B);
	}
	handleFork(e, t) {
		if (!this.callbacks.onFork) return void this.completeChannel(e, bt, t, void 0, -1, 38);
		const i = e.pid;
		for (; this.processes.has(this.nextChildPid);) this.nextChildPid++;
		const n = this.nextChildPid++, s = (0, this.kernelInstance.exports.kernel_fork_process)(i, n);
		if (s < 0) return void this.completeChannel(e, bt, t, void 0, -1, -s >>> 0);
		const r = this.kernelInstance.exports.kernel_clear_fork_child;
		r && r(n);
		const o = this.kernelInstance.exports.kernel_reset_signal_mask;
		o && o(n);
		const a = `${i}:${e.channelOffset}`, c = this.threadForkContexts.get(a), h = e.channelOffset - 131072, l = c ? {
			fnPtr: c.fnPtr,
			argPtr: c.argPtr,
			forkBufAddr: e.channelOffset - 16384,
			slotStart: h,
			slotLen: 262144
		} : void 0;
		if (l) try {
			this.reserveHostRegionAt(n, l.slotStart, l.slotLen);
		} catch (Di) {
			this.removeFromKernelProcessTable(n);
			const s = Di instanceof Error ? Di.message : String(Di);
			console.error(`[kernel-worker] fork child slot reservation failed: ${s}`), this.completeChannel(e, bt, t, void 0, -1, 12);
			return;
		}
		this.callbacks.onFork(i, n, e.memory, l).then((s) => {
			if (this.processes.has(i)) {
				for (const [e, t] of this.tcpListenerTargets) {
					const e = t.find((e) => e.pid === i);
					e && !t.some((e) => e.pid === n) && t.push({
						pid: n,
						fd: e.fd
					});
				}
				for (const [e, t] of this.epollInterests) if (e.startsWith(`${i}:`)) {
					const i = e.slice(e.indexOf(":") + 1);
					this.epollInterests.set(`${n}:${i}`, t.map((e) => ({ ...e })));
				}
				this.completeChannel(e, bt, t, void 0, n, 0);
			}
		}).catch(() => {
			(0, this.kernelInstance.exports.kernel_remove_process)(n), this.completeChannel(e, bt, t, void 0, -1, 12);
		});
	}
	handleSpawn(e, t) {
		const i = e.pid, n = t[0], s = t[1], r = t[2], o = t[3], a = t[4];
		if (!this.callbacks.onSpawn || !this.callbacks.onResolveSpawn) return void this.completeChannel(e, vt, t, void 0, -1, 38);
		const c = new Uint8Array(e.memory.buffer);
		let h = "";
		0 !== n && s > 0 && (h = new TextDecoder().decode(c.slice(n, n + s)), h.endsWith("\0") && (h = h.slice(0, -1)));
		const l = h;
		if (h && !h.startsWith("/") && (h = this.resolveExecPathAgainstCwd(i, h)), o <= 0 || 0 === r && o > 0) return void this.completeChannel(e, vt, t, void 0, -1, 22);
		const d = c.slice(r, r + o);
		let f, u;
		try {
			const e = function(e) {
				if (e.byteLength < 40) throw new Error("blob too short for header");
				const t = new DataView(e.buffer, e.byteOffset, e.byteLength), i = t.getUint32(0, !0), n = t.getUint32(4, !0), s = t.getUint32(8, !0);
				if (i > 4096 || n > 4096 || s > 1024) throw new Error("blob count exceeds limit");
				const r = 40 + 4 * i, o = r + 4 * n + 28 * s;
				if (o > e.byteLength) throw new Error("blob truncated before strings region");
				const a = e.byteLength - o, c = new TextDecoder(), h = (t) => {
					if (t > a) throw new Error("string offset OOB");
					let i = t;
					for (; i < a && 0 !== e[o + i];) i++;
					return c.decode(e.slice(o + t, o + i));
				}, l = [];
				for (let f = 0; f < i; f++) l.push(h(t.getUint32(40 + 4 * f, !0)));
				const d = [];
				for (let f = 0; f < n; f++) d.push(h(t.getUint32(r + 4 * f, !0)));
				return {
					argv: l,
					envp: d
				};
			}(d);
			f = e.argv, u = e.envp;
		} catch (p) {
			this.completeChannel(e, vt, t, void 0, -1, 22);
			return;
		}
		(async () => {
			const e = await this.callbacks.onResolveSpawn(h, f);
			return e || l === h || !l || l.startsWith("/") ? e : this.callbacks.onResolveSpawn(l, f);
		})().then((n) => {
			if (!n) return void this.completeChannel(e, vt, t, void 0, -1, 2);
			const s = n instanceof ArrayBuffer ? n : n.programBytes, r = n instanceof ArrayBuffer ? f : n.argv;
			this.handleSpawnAfterResolve(e, t, i, a, d, o, r, u, s);
		}).catch((n) => {
			console.error(`[kernel] spawn resolve error for parent ${i}:`, n), this.completeChannel(e, vt, t, void 0, -1, 5);
		});
	}
	handleSpawnAfterResolve(e, t, i, n, s, r, o, a, c) {
		const h = new Uint8Array(this.kernelMemory.buffer);
		if (r > h.byteLength - this.scratchOffset) return void this.completeChannel(e, vt, t, void 0, -1, 22);
		h.set(s, this.scratchOffset);
		const l = (0, this.kernelInstance.exports.kernel_spawn_process)(i, this.toKernelPtr(this.scratchOffset), this.toKernelPtr(r));
		if (l < 0) return void this.completeChannel(e, vt, t, void 0, -1, -l >>> 0);
		const d = l >>> 0;
		d >= this.nextChildPid && (this.nextChildPid = d + 1), this.callbacks.onSpawn(d, c, o, a).then((i) => {
			if (i < 0) {
				(0, this.kernelInstance.exports.kernel_remove_process)(d), this.completeChannel(e, vt, t, void 0, -1, -i >>> 0);
				return;
			}
			0 !== n && new DataView(e.memory.buffer).setInt32(n, d, !0), this.completeChannel(e, vt, t, void 0, 0, 0);
		}).catch((n) => {
			console.error(`[kernel] spawn error for parent ${i}:`, n);
			(0, this.kernelInstance.exports.kernel_remove_process)(d), this.completeChannel(e, vt, t, void 0, -1, 5);
		});
	}
	readCStringFromProcess(e, t, i = 4096) {
		if (0 === t) return "";
		let n = 0;
		for (; t + n < e.length && 0 !== e[t + n] && n < i;) n++;
		return new TextDecoder().decode(e.slice(t, t + n));
	}
	readStringArrayFromProcess(e, t, i = 4) {
		if (0 === t) return [];
		const n = [], s = new DataView(e.buffer, e.byteOffset, e.byteLength);
		for (let r = 0; r < 1024; r++) {
			let o;
			if (o = 8 === i ? Number(s.getBigUint64(t + 8 * r, !0)) : s.getUint32(t + 4 * r, !0), 0 === o) break;
			n.push(this.readCStringFromProcess(e, o));
		}
		return n;
	}
	handleExec(e, t) {
		const i = new Uint8Array(e.memory.buffer), n = this.getPtrWidth(e.pid);
		let s = this.readCStringFromProcess(i, t[0]);
		const r = this.readStringArrayFromProcess(i, t[1], n), o = this.readStringArrayFromProcess(i, t[2], n);
		s && !s.startsWith("/") && (s = this.resolveExecPathAgainstCwd(e.pid, s)), this.callbacks.onExec ? this.callbacks.onExec(e.pid, s, r, o).then((i) => {
			i < 0 && this.completeChannel(e, yt, t, void 0, -1, -i >>> 0);
		}).catch((i) => {
			console.error(`[kernel] exec error for pid ${e.pid}:`, i), this.completeChannel(e, yt, t, void 0, -1, 5);
		}) : this.completeChannel(e, yt, t, void 0, -1, 38);
	}
	resolveExecPathAgainstCwd(e, t) {
		const i = this.kernelInstance.exports.kernel_get_cwd;
		if (!i) return t;
		const n = i(e, this.toKernelPtr(this.scratchOffset), 4096);
		if (n <= 0) return t;
		const s = new Uint8Array(this.kernelMemory.buffer), r = new TextDecoder().decode(s.slice(this.scratchOffset, this.scratchOffset + n)), o = (r.endsWith("/") ? r + t : r + "/" + t).split("/"), a = [];
		for (const c of o) "." !== c && "" !== c && (".." === c && a.length > 0 ? a.pop() : a.push(c));
		return "/" + a.join("/");
	}
	handleExecveat(e, t) {
		const i = t[0], n = t[4], s = new Uint8Array(e.memory.buffer), r = this.getPtrWidth(e.pid), o = this.readCStringFromProcess(s, t[1]), a = this.readStringArrayFromProcess(s, t[2], r), c = this.readStringArrayFromProcess(s, t[3], r);
		let h;
		if (4096 & n && "" === o) {
			const n = this.kernelInstance.exports.kernel_get_fd_path;
			if (!n) return void this.completeChannel(e, kt, t, void 0, -1, 38);
			const s = n(e.pid, i, this.toKernelPtr(this.scratchOffset), 4096);
			if (s <= 0) {
				const i = s < 0 ? -s >>> 0 : 2;
				this.completeChannel(e, kt, t, void 0, -1, i);
				return;
			}
			const r = new Uint8Array(this.kernelMemory.buffer);
			h = new TextDecoder().decode(r.slice(this.scratchOffset, this.scratchOffset + s));
		} else if (o.startsWith("/")) h = o;
		else {
			const t = this.kernelInstance.exports.kernel_get_cwd;
			if (t) {
				const i = t(e.pid, this.scratchOffset, 4096);
				if (i > 0) {
					const e = new Uint8Array(this.kernelMemory.buffer), t = new TextDecoder().decode(e.slice(this.scratchOffset, this.scratchOffset + i));
					h = t.endsWith("/") ? t + o : t + "/" + o;
				} else h = o;
			} else h = o;
		}
		this.callbacks.onExec ? this.callbacks.onExec(e.pid, h, a, c).then((i) => {
			i < 0 && this.completeChannel(e, kt, t, void 0, -1, -i >>> 0);
		}).catch((i) => {
			console.error(`[kernel] execveat error for pid ${e.pid}:`, i), this.completeChannel(e, kt, t, void 0, -1, 5);
		}) : this.completeChannel(e, kt, t, void 0, -1, 38);
	}
	handleClone(e, t) {
		if (!this.callbacks.onClone) return void this.completeChannel(e, xt, t, void 0, -1, 38);
		const i = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		i.setUint32(4, xt, !0);
		for (let g = 0; g < 6; g++) i.setBigInt64(8 + 8 * g, BigInt(t[g]), !0);
		const n = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			n(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const s = Number(i.getBigInt64(56, !0)), r = i.getUint32(64, !0);
		if (s < 0) return void this.completeChannel(e, xt, t, void 0, s, r);
		const o = s, a = t[0], c = t[2];
		1048576 & a && 0 !== c && new DataView(e.memory.buffer).setInt32(c, o, !0);
		const h = new DataView(e.memory.buffer, e.channelOffset), l = h.getUint32(72, !0), d = h.getUint32(76, !0), f = t[1], u = t[3], p = t[4];
		0 !== p && this.threadCtidPtrs.set(`${e.pid}:${o}`, p), this.callbacks.onClone(e.pid, o, l, d, f, u, p, e.memory).then((i) => {
			this.processes.has(e.pid) ? (i !== o && 0 !== p && (this.threadCtidPtrs.delete(`${e.pid}:${o}`), this.threadCtidPtrs.set(`${e.pid}:${i}`, p)), this.completeChannel(e, xt, t, void 0, i, 0)) : 0 !== p && this.threadCtidPtrs.delete(`${e.pid}:${o}`);
		}).catch((i) => {
			0 !== p && this.threadCtidPtrs.delete(`${e.pid}:${o}`), console.error(`[kernel-worker] onClone failed: ${i}`), this.completeChannel(e, xt, t, void 0, -1, 12);
		});
	}
	handleExit(e, t, i) {
		const n = i[0], s = this.processes.get(e.pid), r = s && s.channels.length > 0 && s.channels[0].channelOffset === e.channelOffset;
		if (t === _t && !r) {
			const t = `${e.pid}:${e.channelOffset}`, i = this.channelTids.get(t) ?? 0;
			if (i > 0 && (this.channelTids.delete(t), this.threadForkContexts.delete(t)), i > 0) {
				const t = `${e.pid}:${i}`, n = this.threadCtidPtrs.get(t);
				if (n && 0 !== n) {
					this.threadCtidPtrs.delete(t), new DataView(e.memory.buffer).setInt32(n, 0, !0);
					const i = new Int32Array(e.memory.buffer);
					Atomics.notify(i, n >>> 2, 1);
				}
			}
			i > 0 && this.notifyThreadExit(e.pid, i), this.removeChannel(e.pid, e.channelOffset), i > 0 && !0 === this.callbacks.onThreadExit?.(e.pid, i, e.channelOffset) ? this.abandonChannel(e) : this.completeChannelRaw(e, 0, 0);
			return;
		}
		{
			const i = new DataView(this.kernelMemory.buffer, this.scratchOffset);
			i.setUint32(4, t, !0), i.setBigInt64(8, BigInt(n), !0);
			const s = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				s(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch {} finally {
				this.currentHandlePid = 0;
			}
		}
		const o = e.pid;
		if (this.hostReaped.has(o)) return this.completeChannelRaw(e, 0, 0), this.scheduleWakeBlockedRetries(), void (this.callbacks.onExit && this.callbacks.onExit(o, n));
		this.hostReaped.add(o), this.notifyParentOfExitedProcess(o), this.completeChannelRaw(e, 0, 0), this.scheduleWakeBlockedRetries(), this.callbacks.onExit && this.callbacks.onExit(o, n);
	}
	handleProcessTerminated(e) {
		const t = e.pid;
		if (!this.hostReaped.has(t) && (this.hostReaped.add(t), this.notifyParentOfExitedProcess(t), this.sharedMappings.delete(t), this.callbacks.onExit)) {
			const e = this.kernelInstance.exports.kernel_get_process_exit_status, i = e ? e(t) : -1;
			this.callbacks.onExit(t, i >= 128 ? i : -1);
		}
	}
	notifyHostProcessCrashed(e, t = 11) {
		if (this.hostReaped.has(e)) return;
		const i = this.kernelInstance.exports.kernel_mark_process_signaled;
		i && i(e, t) < 0 || (this.hostReaped.add(e), this.notifyParentOfExitedProcess(e), this.sharedMappings.delete(e));
	}
	reapKilledProcessesAfterSyscall() {
		const e = this.kernelInstance.exports.kernel_get_process_exit_status;
		if (!e) return;
		const t = Array.from(this.processes.keys());
		for (const i of t) {
			if (e(i) < 128) continue;
			if (this.hostReaped.has(i)) continue;
			const t = this.pendingSleeps.get(i);
			t && (clearTimeout(t.timer), this.pendingSleeps.delete(i));
			const n = this.processes.get(i)?.channels[0];
			n && this.handleProcessTerminated(n);
		}
	}
	hostReaped = /* @__PURE__ */ new Set();
	handleWaitpid(e, t) {
		const i = t[0], n = t[1], s = t[2] >>> 0, r = e.pid, o = this.pollWaitableChild(r, i);
		if ("error" !== o.kind) return "exited" === o.kind ? (this.consumeExitedChild(r, o.childPid), this.writeWaitStatus(e, n, o.waitStatus), void this.completeWaitpid(e, t, o.childPid, 0)) : void (1 & s ? this.completeWaitpid(e, t, 0, 0) : this.waitingForChild.push({
			parentPid: r,
			channel: e,
			origArgs: t,
			pid: i,
			options: s,
			syscallNr: St
		}));
		this.completeWaitpid(e, t, -1, o.errno);
	}
	pollWaitableChild(e, t) {
		const i = (0, this.kernelInstance.exports.kernel_wait4_poll)(e, t, this.toKernelPtr(this.scratchOffset));
		return i > 0 ? {
			kind: "exited",
			childPid: i,
			waitStatus: new DataView(this.kernelMemory.buffer).getInt32(this.scratchOffset, !0)
		} : 0 === i ? { kind: "running" } : {
			kind: "error",
			errno: -i >>> 0
		};
	}
	getParentPid(e) {
		const t = (0, this.kernelInstance.exports.kernel_get_parent_pid)(e);
		return t > 0 ? t : void 0;
	}
	consumeExitedChild(e, t) {
		(0, this.kernelInstance.exports.kernel_reap_exited_child)(e, t);
	}
	notifyParentOfExitedProcess(e) {
		const t = this.getParentPid(e);
		if (void 0 === t) return;
		const i = this.kernelInstance.exports.kernel_has_sa_nocldwait;
		i && 1 === i(t) ? this.consumeExitedChild(t, e) : (this.sendSignalToProcess(t, 17), this.wakeWaitingParent(t));
	}
	writeWaitStatus(e, t, i) {
		0 !== t && new DataView(e.memory.buffer).setInt32(t, i, !0);
	}
	completeWaitpid(e, t, i, n) {
		this.dequeueSignalForDelivery(e), this.completeChannel(e, St, t, void 0, i, n);
	}
	wakeWaitingParent(e) {
		let t, i = -1;
		for (let s = 0; s < this.waitingForChild.length; s++) {
			const n = this.waitingForChild[s];
			if (n.parentPid !== e) continue;
			const r = this.pollWaitableChild(n.parentPid, n.pid);
			if ("exited" === r.kind) {
				i = s, t = r;
				break;
			}
		}
		if (-1 === i || "exited" !== t?.kind) return;
		const n = this.waitingForChild[i];
		this.waitingForChild.splice(i, 1), n.syscallNr === Et ? (this.writeSignalInfo(n.channel, n.origArgs[2], t.childPid, t.waitStatus), n.options & Ut || this.consumeExitedChild(e, t.childPid), this.dequeueSignalForDelivery(n.channel), this.completeChannel(n.channel, Et, n.origArgs, void 0, 0, 0)) : (this.consumeExitedChild(e, t.childPid), this.writeWaitStatus(n.channel, n.origArgs[1], t.waitStatus), this.completeWaitpid(n.channel, n.origArgs, t.childPid, 0));
	}
	recheckDeferredWaitpids() {
		for (let e = this.waitingForChild.length - 1; e >= 0; e--) {
			const t = this.waitingForChild[e];
			if (t.pid > 0 || -1 === t.pid) continue;
			const i = this.pollWaitableChild(t.parentPid, t.pid);
			"error" === i.kind && (this.waitingForChild.splice(e, 1), t.syscallNr === Et ? this.completeChannel(t.channel, Et, t.origArgs, void 0, -1, i.errno) : this.completeWaitpid(t.channel, t.origArgs, -1, i.errno));
		}
	}
	handleWaitid(e, t) {
		const i = t[0], n = t[1], s = t[2], r = t[3] >>> 0, o = e.pid, a = this.waitidToWaitPid(i, n), c = this.pollWaitableChild(o, a);
		if ("error" !== c.kind) {
			if ("exited" === c.kind) return this.writeSignalInfo(e, s, c.childPid, c.waitStatus), r & Ut || this.consumeExitedChild(o, c.childPid), void this.completeChannel(e, Et, t, void 0, 0, 0);
			if (1 & r) {
				if (0 !== s) {
					const t = new DataView(e.memory.buffer);
					t.setInt32(s, 0, !0), t.setInt32(s + 12, 0, !0);
				}
				this.completeChannel(e, Et, t, void 0, 0, 0);
			} else this.waitingForChild.push({
				parentPid: o,
				channel: e,
				origArgs: t,
				pid: a,
				options: r,
				syscallNr: Et
			});
		} else this.completeChannel(e, Et, t, void 0, -1, c.errno);
	}
	waitidToWaitPid(e, t) {
		return 1 === e ? t : 2 === e ? 0 === t ? 0 : -t : -1;
	}
	writeSignalInfo(e, t, i, n) {
		if (0 === t) return;
		const s = new DataView(e.memory.buffer);
		for (let o = 0; o < 128; o += 4) s.setInt32(t + o, 0, !0);
		const r = !!(127 & n);
		s.setInt32(t + 0, 17, !0), s.setInt32(t + 4, 0, !0), r ? s.setInt32(t + 8, 2, !0) : s.setInt32(t + 8, 1, !0), s.setInt32(t + 12, i, !0), s.setInt32(t + 16, 1e3, !0), r ? s.setInt32(t + 20, 127 & n, !0) : s.setInt32(t + 20, n >> 8 & 255, !0);
	}
	handleFutex(e, t) {
		const i = t[0], n = t[1], s = t[2], r = -385 & n, o = new Int32Array(e.memory.buffer), a = i >>> 2;
		if (0 === r || 9 === r) {
			if (this.pendingCancels.has(e.channelOffset)) return this.pendingCancels.delete(e.channelOffset), this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
			if (Atomics.load(o, a) !== s) return this.completeChannelRaw(e, -11, it), void this.relistenChannel(e);
			let i;
			const n = t[3];
			if (0 !== n) {
				const t = new DataView(e.memory.buffer), s = Number(t.getBigInt64(n, !0)), r = Number(t.getBigInt64(n + 8, !0));
				if (s < 0 || 0 === s && r <= 0) return this.completeChannelRaw(e, -110, 110), void this.relistenChannel(e);
				i = 1e3 * s + Math.ceil(r / 1e6), i <= 0 && (i = 1), i > 2147483647 && (i = 2147483647);
			}
			const r = Atomics.waitAsync(o, a, s);
			if (r.async) {
				let t, n = !1;
				const s = (i, s) => {
					n || (n = !0, void 0 !== t && clearTimeout(t), this.pendingFutexWaits.delete(e.channelOffset), this.processes.has(e.pid) && (this.completeChannelRaw(e, i, s), e.consecutiveSyscalls = 0, this.relistenChannel(e)));
				};
				this.pendingFutexWaits.set(e.channelOffset, {
					channel: e,
					futexIndex: a
				}), r.value.then(() => {
					s(0, 0);
				}), void 0 !== i && (t = setTimeout(() => {
					Atomics.notify(o, a, 1), s(-110, 110);
				}, i));
			} else this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
			return;
		}
		if (1 === r || 10 === r) {
			const t = Atomics.notify(o, a, s);
			this.completeChannelRaw(e, t, 0), this.relistenChannel(e);
			return;
		}
		if (3 === r || 4 === r) {
			const i = t[3], n = Atomics.notify(o, a, s + i);
			this.completeChannelRaw(e, n, 0), this.relistenChannel(e);
			return;
		}
		if (5 === r) {
			const i = t[3], n = t[4] >>> 2;
			let r = Atomics.notify(o, a, s);
			r += Atomics.notify(o, n, i), this.completeChannelRaw(e, r, 0), this.relistenChannel(e);
			return;
		}
		this.completeChannelRaw(e, -38, 38), this.relistenChannel(e);
	}
	notifyThreadExit(e, t) {
		if (!this.kernelInstance) return;
		const i = this.kernelInstance.exports.kernel_thread_exit;
		i && i(e, t);
	}
	sendSignalToProcess(e, t) {
		if (!this.kernelInstance || !this.kernelMemory) return;
		if (!this.processes.has(e)) return;
		const i = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		i.setUint32(4, wt, !0), i.setBigInt64(8, BigInt(e), !0), i.setBigInt64(16, BigInt(t), !0);
		for (let o = 2; o < 6; o++) i.setBigInt64(8 + 8 * o, 0n, !0);
		const n = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e;
		const s = this.kernelInstance.exports.kernel_set_current_tid;
		s && s(0);
		try {
			n(this.toKernelPtr(this.scratchOffset), e);
		} catch (Di) {
			console.error(`[sendSignalToProcess] kernel threw for pid=${e} sig=${t}: ${Di}`);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.kernelInstance.exports.kernel_is_signal_blocked(e, t)) return;
		const r = this.pendingSleeps.get(e);
		r && (clearTimeout(r.timer), this.pendingSleeps.delete(e), this.completeSleepWithSignalCheck(r.channel, r.syscallNr, r.origArgs, r.retVal, r.errVal));
		for (const [o, a] of this.pendingPollRetries) a.channel.pid === e && (a.timer && clearTimeout(a.timer), this.pendingPollRetries.delete(o), this.processes.has(e) && this.retrySyscall(a.channel));
		for (const [o, a] of this.pendingSelectRetries) a.channel.pid === e && (clearTimeout(a.timer), clearImmediate(a.timer), this.pendingSelectRetries.delete(o), this.processes.has(e) && (a.syscallNr === lt ? this.handleSelect(a.channel, a.origArgs) : this.handlePselect6(a.channel, a.origArgs)));
	}
	ensureProcessMemoryCovers(e, t, i, n, s) {
		let r = 0, o = 0, a = 0;
		i === Ot ? n >= 0 && (r = n) : i === zt ? n >= 0 && (o = n, a = s[1], r = o + a) : i === Rt && n >= 0 && (o = n, a = s[2], r = o + a);
		const c = t.buffer.byteLength;
		if (r > 0 && r > c) (function(e, t, i = 4) {
			const n = Math.ceil(t / $e) - Math.ceil(e.buffer.byteLength / $e);
			n <= 0 || (8 === i ? e.grow(BigInt(n)) : e.grow(n));
		})(t, r, this.processes.get(e)?.ptrWidth ?? 4), this.kernel.framebuffers.rebindMemory(e);
		if (a > 0) {
			const e = 65536, n = Math.ceil(a / e) * e, r = t.buffer.byteLength;
			let c = o;
			const h = Math.min(o + n, r);
			if (i === Rt) {
				const t = s[0] >>> 0, i = s[1] >>> 0;
				if (o === t && i > 0) {
					const n = Math.ceil((t + i) / e) * e;
					c = Math.max(c, n);
				}
			}
			c < h && new Uint8Array(t.buffer, c, h - c).fill(0);
		}
		if (i === Rt && n >= 0 && n !== s[0] && 0 !== s[0] && s[1] > 0) {
			const e = s[0] >>> 0, i = s[1] >>> 0, r = n >>> 0, o = s[2] >>> 0, a = Math.min(i, o);
			if (a > 0) {
				const i = t.buffer, n = i.byteLength;
				if (e + a <= n && r + a <= n) {
					const t = new Uint8Array(i, e, a);
					new Uint8Array(i, r, a).set(t);
				}
			}
		}
	}
	populateMmapFromFile(e, t, i) {
		const n = i[4], s = i[1];
		let r = 4096 * i[5];
		const o = this.kernelInstance.exports.kernel_handle_channel, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = new Uint8Array(this.kernelMemory.buffer), h = this.scratchOffset + 72;
		let l = 0;
		for (; l < s;) {
			const i = Math.min(g, s - l);
			a.setUint32(4, Ft, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(h), !0), a.setBigInt64(24, BigInt(i), !0), a.setBigInt64(32, BigInt(4294967295 & r), !0), a.setBigInt64(40, BigInt(0 | Math.floor(r / 4294967296)), !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				o(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch {
				break;
			}
			this.currentHandlePid = 0;
			const d = Number(a.getBigInt64(56, !0));
			if (d <= 0) break;
			if (new Uint8Array(e.memory.buffer).set(c.subarray(h, h + d), t + l), l += d, r += d, d < i) break;
		}
	}
	flushSharedMappings(e, t) {
		const i = t[0] >>> 0, n = t[1] >>> 0, s = this.sharedMappings.get(e.pid);
		if (!s || 0 === s.size) return;
		const r = i + n;
		for (const [o, a] of s) {
			const t = o + a.len;
			if (o >= r || t <= i) continue;
			const n = Math.max(i, o), s = Math.min(r, t) - n;
			if (s <= 0) continue;
			const c = a.fileOffset + (n - o);
			this.pwriteFromProcessMemory(e, a.fd, n, s, c);
		}
	}
	pwriteFromProcessMemory(e, t, i, n, s) {
		const r = this.kernelInstance.exports.kernel_handle_channel, o = new DataView(this.kernelMemory.buffer, this.scratchOffset), a = new Uint8Array(this.kernelMemory.buffer), c = this.scratchOffset + 72;
		let h = 0;
		for (; h < n;) {
			const l = Math.min(g, n - h), d = new Uint8Array(e.memory.buffer);
			a.set(d.subarray(i + h, i + h + l), c);
			const f = s + h;
			o.setUint32(4, Lt, !0), o.setBigInt64(8, BigInt(t), !0), o.setBigInt64(16, BigInt(c), !0), o.setBigInt64(24, BigInt(l), !0), o.setBigInt64(32, BigInt(4294967295 & f), !0), o.setBigInt64(40, BigInt(0 | Math.floor(f / 4294967296)), !0), o.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				r(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch {
				break;
			}
			this.currentHandlePid = 0;
			const u = Number(o.getBigInt64(56, !0));
			if (u <= 0) break;
			if (h += u, u < l) break;
		}
	}
	cleanupSharedMappings(e, t, i) {
		const n = this.sharedMappings.get(e);
		if (!n) return;
		const s = t + i;
		for (const [r, o] of n) {
			const e = r + o.len;
			r >= t && e <= s && n.delete(r);
		}
		0 === n.size && this.sharedMappings.delete(e);
	}
	setNextChildPid(e) {
		this.nextChildPid = e;
	}
	setMaxAddr(e, t) {
		const i = this.kernelInstance.exports.kernel_set_max_addr;
		i && i(e, this.toKernelPtr(t));
	}
	setBrkLimit(e, t) {
		const i = this.kernelInstance.exports.kernel_set_brk_limit;
		return !!i && i(e, this.toKernelPtr(t)) >= 0;
	}
	setMmapBase(e, t) {
		const i = this.kernelInstance.exports.kernel_set_mmap_base;
		return !!i && i(e, this.toKernelPtr(t)) >= 0;
	}
	reserveHostRegion(e, t) {
		const i = this.kernelInstance.exports.kernel_reserve_host_region;
		if (!i) throw new Error("Kernel export kernel_reserve_host_region is required for dynamic pthread control slots");
		const n = i(e, this.toKernelPtr(t)), s = "bigint" == typeof n ? Number(n) : n;
		if (!Number.isSafeInteger(s) || s < 0 || s >>> 0 == 4294967295) throw new Error(`failed to reserve ${t} bytes of pthread control memory for pid=${e}`);
		return s;
	}
	reserveHostRegionAt(e, t, i) {
		const n = this.kernelInstance.exports.kernel_reserve_host_region_at;
		if (!n) throw new Error("Kernel export kernel_reserve_host_region_at is required for fork-from-pthread control slots");
		const s = n(e, this.toKernelPtr(t), this.toKernelPtr(i)), r = "bigint" == typeof s ? Number(s) : s;
		if (!Number.isSafeInteger(r) || r < 0 || r >>> 0 == 4294967295 || r !== t) throw new Error(`failed to reserve pthread control memory at 0x${t.toString(16)} for pid=${e}`);
		return r;
	}
	highControlFloorForProcess(e) {
		const t = this.processes.get(e);
		if (!t) return null;
		if (t.explicitMaxAddr) return null;
		let i = null;
		for (const n of t.channels) {
			const e = n.channelOffset - 131072;
			e >= tt && (i = null === i ? e : Math.min(i, e));
		}
		return i;
	}
	setBrkBase(e, t) {
		const i = this.kernelInstance.exports.kernel_set_brk_base;
		return !!i && i(e, this.toKernelPtr(t)) >= 0;
	}
	getKernel() {
		return this.kernel;
	}
	get framebuffers() {
		return this.kernel.framebuffers;
	}
	getProcessMemory(e) {
		return this.processes.get(e)?.memory;
	}
	getKernelInstance() {
		return this.kernelInstance;
	}
	getForkCount(e) {
		const t = this.kernelInstance?.exports.kernel_get_fork_count;
		return t ? t(e) : BigInt(0);
	}
	injectMouseEvent(e, t, i) {
		this.kernel.injectMouseEvent(e, t, i), this.scheduleWakeBlockedRetries();
	}
	drainAudio(e) {
		return this.kernel.drainAudio(e);
	}
	audioSampleRate() {
		return this.kernel.audioSampleRate();
	}
	audioChannels() {
		return this.kernel.audioChannels();
	}
	audioPending() {
		return this.kernel.audioPending();
	}
	getKernelAbiVersion() {
		return this.kernelAbiVersion;
	}
	startTcpListener(e, t, i, n = [
		0,
		0,
		0,
		0
	]) {
		const s = `${e}:${t}`;
		if (this.tcpListeners.has(s)) return;
		this.tcpListenerTargets.has(i) || (this.tcpListenerTargets.set(i, []), this.tcpListenerRRIndex.set(i, 0));
		const r = this.tcpListenerTargets.get(i);
		if (r.some((i) => i.pid === e && i.fd === t) || r.push({
			pid: e,
			fd: t
		}), this.io.network?.listenTcp) {
			const r = this.io.network.listenTcp(s, new Uint8Array(n), i, { accept: (i, n, s) => this.handleIncomingVirtualTcpConnection(e, t, i, s) });
			0 !== r && console.warn(`virtual TCP listener registration failed on port ${i}: errno ${r}`);
		}
		if (!this.netModule) return;
		for (const [, h] of this.tcpListeners) if (h.port === i) return void this.tcpListeners.set(s, h);
		const o = this.netModule, a = /* @__PURE__ */ new Set(), c = o.createServer((e) => {
			const t = this.pickListenerTarget(i);
			t ? this.handleIncomingTcpConnection(t.pid, t.fd, e, a) : e.destroy();
		});
		c.listen(i, "0.0.0.0", () => {}), c.on("error", (e) => {
			console.error(`TCP listener error on port ${i}:`, e);
		}), this.tcpListeners.set(s, {
			server: c,
			pid: e,
			port: i,
			connections: a
		});
	}
	pickListenerTarget(e) {
		const t = this.tcpListenerTargets.get(e);
		if (!t || 0 === t.length) return null;
		const i = t.filter((e) => this.processes.has(e.pid));
		if (0 === i.length) return null;
		i.length !== t.length && this.tcpListenerTargets.set(e, i);
		let n = i;
		if (i.length > 1) {
			const e = i.filter((e) => void 0 !== this.getParentPid(e.pid));
			e.length > 0 && (n = e);
		}
		const s = (this.tcpListenerRRIndex.get(e) ?? 0) % n.length;
		return this.tcpListenerRRIndex.set(e, s + 1), n[s];
	}
	async sendHttpRequest(e, t, i = {}) {
		const n = i.timeoutMs ?? 6e4, s = i.debugLabel ?? `${t.method} ${t.url}`, r = this.pickListenerTarget(e);
		if (!r) throw new Error(`No in-kernel listener for port ${e}`);
		const o = this.kernelInstance.exports, a = o.kernel_inject_connection, c = o.kernel_pipe_write, h = o.kernel_pipe_read, l = o.kernel_pipe_is_write_open, d = o.kernel_pipe_close_write, f = o.kernel_pipe_close_read, u = 1024 + Math.floor(6e4 * Math.random()), p = a(r.pid, r.fd, 127, 0, 0, 1, u);
		if (p < 0) throw new Error(`[in-kernel-http ${s}] kernel_inject_connection failed (${p})`);
		const g = p + 1;
		this.wakeTargetPollNow(r.pid), this.scheduleWakeBlockedRetries();
		const m = function(e) {
			let t = `${e.method} ${e.url} HTTP/1.1\r\n`;
			const i = Object.keys(e.headers).map((e) => e.toLowerCase());
			for (const [r, o] of Object.entries(e.headers)) t += `${r}: ${o}\r\n`;
			e.body && e.body.length > 0 && !i.includes("content-length") && (t += `Content-Length: ${e.body.length}\r\n`), i.includes("connection") || (t += "Connection: close\r\n"), t += "\r\n";
			const n = qe.encode(t);
			if (!e.body || 0 === e.body.length) return n;
			const s = new Uint8Array(n.length + e.body.length);
			return s.set(n, 0), s.set(e.body, n.length), s;
		}(t), w = this.writePipeChunked(c, 0, p, m);
		if (w < m.length) throw d(0, p), f(0, g), /* @__PURE__ */ new Error(`[in-kernel-http ${s}] partial write ${w}/${m.length}`);
		this.notifyPipeReadable(p);
		const y = await this.pumpHttpResponse(0, g, p, h, l, f, d, n, s), k = i.emptyResponseRetries ?? 1;
		return k > 0 && ("GET" === t.method || "HEAD" === t.method) && 200 === y.status && 0 === Object.keys(y.headers).length && 0 === y.body.length ? await this.sendHttpRequest(e, t, {
			...i,
			emptyResponseRetries: k - 1
		}) : y;
	}
	wakeTargetPollNow(e) {
		for (const [t, i] of this.pendingPollRetries) if (i.channel.pid === e) {
			null !== i.timer && clearTimeout(i.timer), this.pendingPollRetries.delete(t), this.processes.has(e) && this.retrySyscall(i.channel);
			break;
		}
	}
	writePipeChunked(e, t, i, n) {
		const s = this.tcpScratchOffset;
		let r = 0;
		for (; r < n.length;) {
			const o = Math.min(n.length - r, 65536);
			this.getKernelMem().set(n.subarray(r, r + o), s);
			const a = e(t, i, this.toKernelPtr(s), o);
			if (a <= 0) break;
			r += a;
		}
		return r;
	}
	pumpHttpResponse(e, t, i, n, s, r, o, a, c) {
		return new Promise((c) => {
			const h = [], l = Date.now();
			let d = !1;
			const f = this.tcpScratchOffset, u = (n) => {
				r(e, t), o(e, i), this.notifyPipeReadable(i), this.scheduleWakeBlockedRetries(), c(n);
			}, p = () => {
				if (Date.now() - l > a) return void u({
					status: 504,
					headers: {},
					body: new Uint8Array(0)
				});
				let i = !1;
				for (;;) {
					const s = n(e, t, this.toKernelPtr(f), 65536);
					if (s <= 0) break;
					i = !0;
					const r = this.getKernelMem();
					h.push(r.slice(f, f + s));
				}
				i && this.notifyPipeWritable(t);
				const r = 1 === s(e, t);
				r && !d && (d = !0), !d || r || i ? setTimeout(p, i ? 0 : 2) : u(je(function(e) {
					if (0 === e.length) return new Uint8Array(0);
					if (1 === e.length) return e[0];
					const t = e.reduce((e, t) => e + t.length, 0), i = new Uint8Array(t);
					let n = 0;
					for (const s of e) i.set(s, n), n += s.length;
					return i;
				}(h)));
			};
			p();
		});
	}
	handleIncomingTcpConnection(e, t, i, n) {
		n.add(i);
		const s = i.remoteAddress || "127.0.0.1", r = i.remotePort || 0, o = s.replace("::ffff:", "").split(".").map(Number), a = o[0] || 127, c = o[1] || 0, h = o[2] || 0, l = o[3] || 1, d = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, a, c, h, l, r);
		if (d < 0) return i.destroy(), void n.delete(i);
		this.scheduleWakeBlockedRetries();
		const f = d + 1, u = this.kernelInstance.exports.kernel_pipe_write, p = this.kernelInstance.exports.kernel_pipe_read, g = this.kernelInstance.exports.kernel_pipe_close_write, m = this.kernelInstance.exports.kernel_pipe_close_read;
		this.kernelInstance.exports.kernel_pipe_is_read_open;
		const w = [];
		let y = !1, k = !1, b = !1;
		const I = this.tcpScratchOffset, v = this.kernelInstance.exports.kernel_pipe_is_write_open, x = () => {
			const e = this.getKernelMem();
			for (; w.length > 0;) {
				const t = w[0], i = Math.min(t.length, 65536);
				e.set(t.subarray(0, i), I);
				const n = u(0, d, this.toKernelPtr(I), i);
				if (n <= 0) break;
				n >= t.length ? w.shift() : w[0] = t.subarray(n);
			}
			y && 0 === w.length && g(0, d);
		}, _ = () => {
			const e = this.getKernelMem();
			let t = 0;
			for (;;) {
				const n = p(0, f, this.toKernelPtr(I), 65536);
				if (n <= 0) break;
				t += n;
				const s = Buffer.from(e.slice(I, I + n));
				i.destroyed || i.write(s);
			}
			return t;
		}, P = (e = 0) => {
			k || b || (k = !0, e > 0 ? setTimeout(B, e) : setImmediate(B));
		}, B = () => {
			if (k = !1, b || !this.processes.has(e)) return void E();
			x();
			const t = _();
			if (0 === v(0, f) && 0 === t) return i.destroyed || i.end(), void E();
			P();
		};
		i.on("data", (t) => {
			w.push(t), this.processes.has(e) ? (x(), this.notifyPipeReadable(d, e), P()) : E();
		}), i.on("end", () => {
			y = !0, P();
		}), i.on("error", () => {
			y = !0, i.destroy();
		}), i.on("close", () => {
			n.delete(i);
		});
		let A = this.tcpConnections.get(e);
		A || (A = [], this.tcpConnections.set(e, A));
		const S = {
			sendPipeIdx: f,
			scratchOffset: I,
			clientSocket: i,
			recvPipeIdx: d,
			schedulePump: P
		};
		A.push(S);
		const E = () => {
			if (b) return;
			b = !0, g(0, d), m(0, f), n.delete(i);
			const t = this.tcpConnections?.get(e);
			if (t) {
				const i = t.indexOf(S);
				i >= 0 && t.splice(i, 1), 0 === t.length && this.tcpConnections?.delete(e);
			}
			i.destroyed || i.destroy();
		};
	}
	handleIncomingVirtualTcpConnection(e, t, i, n) {
		if (!this.kernelInstance) return 107;
		const s = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, n.addr[0] ?? 0, n.addr[1] ?? 0, n.addr[2] ?? 0, n.addr[3] ?? 0, n.port);
		if (s < 0) return -s;
		const r = s + 1, o = this.kernelInstance.exports.kernel_pipe_write, a = this.kernelInstance.exports.kernel_pipe_read, c = this.kernelInstance.exports.kernel_pipe_close_write, h = this.kernelInstance.exports.kernel_pipe_close_read, l = this.kernelInstance.exports.kernel_pipe_is_write_open;
		let d = !1, f = !1;
		const u = this.tcpScratchOffset, p = () => {
			d || (d = !0, c(0, s), h(0, r), i.close(), this.notifyPipeReadable(s, e), this.notifyPipeWritable(r), this.scheduleWakeBlockedRetries());
		}, g = () => {
			for (;;) {
				let n;
				try {
					n = i.recv(65536, 0);
				} catch (t) {
					if (11 === t?.errno) return;
					p();
					return;
				}
				if (0 === n.length) return c(0, s), void this.notifyPipeReadable(s, e);
				if (this.writePipeChunked(o, 0, s, n) < n.length) return;
				this.notifyPipeReadable(s, e);
			}
		}, m = () => {
			const e = this.getKernelMem();
			for (;;) {
				const t = a(0, r, this.toKernelPtr(u), 65536);
				if (t <= 0) break;
				try {
					i.send(e.slice(u, u + t), 0);
				} catch {
					p();
					return;
				}
				this.notifyPipeWritable(r);
			}
		}, w = () => {
			if (f = !1, !d) {
				if (!this.processes.has(e)) return m(), i.shutdown(1), void p();
				if (g(), m(), 0 === l(0, r)) return i.shutdown(1), void p();
				y(2);
			}
		}, y = (e = 0) => {
			f || d || (f = !0, setTimeout(w, e));
		};
		return this.scheduleWakeBlockedRetries(), y(), 0;
	}
	injectUdpDatagram(e, t) {
		if (!this.kernelInstance || !this.processes.has(e)) return 113;
		if (t.data.length > 65536) return 90;
		const i = this.kernelInstance.exports.kernel_inject_datagram;
		if (!i) return 38;
		const n = this.tcpScratchOffset;
		this.getKernelMem().set(t.data, n);
		const s = i(e, t.dstAddr[0] ?? 0, t.dstAddr[1] ?? 0, t.dstAddr[2] ?? 0, t.dstAddr[3] ?? 0, t.dstPort, t.srcAddr[0] ?? 0, t.srcAddr[1] ?? 0, t.srcAddr[2] ?? 0, t.srcAddr[3] ?? 0, t.srcPort, this.toKernelPtr(n), t.data.length);
		return s < 0 ? -s : (this.scheduleWakeBlockedRetries(), 0);
	}
	cleanupUdpBindings(e) {
		if (!this.io.network?.unbindUdp) return;
		const t = `${e}:`;
		for (const i of Array.from(this.udpBindings)) i.startsWith(t) && (this.io.network.unbindUdp(i), this.udpBindings.delete(i));
	}
	cleanupTcpListeners(e) {
		for (const [t, i] of this.tcpListenerTargets) {
			const n = i.filter((t) => t.pid !== e);
			0 === n.length ? (this.tcpListenerTargets.delete(t), this.tcpListenerRRIndex.delete(t)) : this.tcpListenerTargets.set(t, n);
		}
		for (const [t, i] of this.tcpListeners) if (i.pid === e) {
			if (this.io.network?.closeTcpListener?.(t), !this.tcpListenerTargets.has(i.port)) {
				i.server.close();
				for (const e of i.connections) e.destroy();
				i.connections.clear();
			}
			this.tcpListeners.delete(t);
		}
		this.tcpConnections.delete(e), this.shmMappings.delete(e);
	}
	handleSemctl(e, t) {
		const [i, n, s, r] = t, o = -257 & s, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = this.kernelInstance.exports.kernel_handle_channel, h = this.getKernelMem(), l = this.scratchOffset + 72;
		if (2 === o && 0 !== r) {
			a.setUint32(4, ii, !0), a.setBigInt64(8, BigInt(i), !0), a.setBigInt64(16, BigInt(n), !0), a.setBigInt64(24, BigInt(s), !0), a.setBigInt64(32, BigInt(l), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), h.fill(0, l, l + 72), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const t = Number(a.getBigInt64(56, !0));
			t >= 0 && new Uint8Array(e.memory.buffer).set(h.subarray(l, l + 72), r), this.completeChannelRaw(e, t, t < 0 ? -t : 0), this.relistenChannel(e);
			return;
		}
		if (13 === o && 0 !== r) {
			const t = 1024;
			a.setUint32(4, ii, !0), a.setBigInt64(8, BigInt(i), !0), a.setBigInt64(16, BigInt(n), !0), a.setBigInt64(24, BigInt(s), !0), a.setBigInt64(32, BigInt(l), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), h.fill(0, l, l + t), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const o = Number(a.getBigInt64(56, !0));
			o >= 0 && new Uint8Array(e.memory.buffer).set(h.subarray(l, l + t), r), this.completeChannelRaw(e, o, o < 0 ? -o : 0), this.relistenChannel(e);
			return;
		}
		if (17 === o && 0 !== r) {
			const t = 1024, o = new Uint8Array(e.memory.buffer);
			h.set(o.subarray(r, r + t), l), a.setUint32(4, ii, !0), a.setBigInt64(8, BigInt(i), !0), a.setBigInt64(16, BigInt(n), !0), a.setBigInt64(24, BigInt(s), !0), a.setBigInt64(32, BigInt(l), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const d = Number(a.getBigInt64(56, !0));
			this.completeChannelRaw(e, d, d < 0 ? -d : 0), this.relistenChannel(e);
			return;
		}
		a.setUint32(4, ii, !0), a.setBigInt64(8, BigInt(i), !0), a.setBigInt64(16, BigInt(n), !0), a.setBigInt64(24, BigInt(s), !0), a.setBigInt64(32, BigInt(r), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			c(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const d = Number(a.getBigInt64(56, !0));
		this.completeChannelRaw(e, d, d < 0 ? -d : 0), this.relistenChannel(e);
	}
	handleIpcShmat(e, t) {
		const [i, n, s] = t, r = this.kernelInstance.exports.kernel_set_current_pid;
		r && r(e.pid);
		const o = (0, this.kernelInstance.exports.kernel_ipc_shmat)(i, n, s);
		if (o < 0) return this.completeChannelRaw(e, o, -o), void this.relistenChannel(e);
		const a = o, c = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		c.setUint32(4, zt, !0), c.setBigInt64(8, BigInt(0), !0), c.setBigInt64(16, BigInt(a), !0), c.setBigInt64(24, BigInt(3), !0), c.setBigInt64(32, BigInt(34), !0), c.setBigInt64(40, BigInt(-1), !0), c.setBigInt64(48, BigInt(0), !0);
		const h = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			h(this.toKernelPtr(this.scratchOffset), e.pid);
		} catch (Di) {
			console.error(`[handleIpcShmat] mmap failed for pid=${e.pid}:`, Di), this.completeChannelRaw(e, -12, 12), this.relistenChannel(e);
			return;
		} finally {
			this.currentHandlePid = 0;
		}
		const l = Number(c.getBigInt64(56, !0));
		if (l < 0) return this.completeChannelRaw(e, -12, 12), void this.relistenChannel(e);
		this.ensureProcessMemoryCovers(e.pid, e.memory, zt, l, [
			0,
			a,
			3,
			34,
			-1,
			0
		]);
		const d = this.kernelInstance.exports.kernel_ipc_shm_read_chunk, f = new Uint8Array(e.memory.buffer), u = this.getKernelMem(), p = this.scratchOffset + 72;
		let g = 0;
		for (; g < a;) {
			const e = a - g, t = Math.min(e, 65536), n = d(i, g, this.toKernelPtr(p), t);
			if (n <= 0) break;
			f.set(u.subarray(p, p + n), (l >>> 0) + g), g += n;
		}
		let m = this.shmMappings.get(e.pid);
		m || (m = /* @__PURE__ */ new Map(), this.shmMappings.set(e.pid, m)), m.set(l >>> 0, {
			segId: i,
			size: a
		}), this.completeChannelRaw(e, l, 0), this.relistenChannel(e);
	}
	handleIpcShmdt(e, t) {
		const i = t[0], n = this.shmMappings.get(e.pid);
		if (!n) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const s = n.get(i);
		if (!s) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const r = this.kernelInstance.exports.kernel_set_current_pid;
		r && r(e.pid);
		const o = this.kernelInstance.exports.kernel_ipc_shm_write_chunk, a = new Uint8Array(e.memory.buffer), c = this.getKernelMem(), h = this.scratchOffset + 72;
		let l = 0;
		for (; l < s.size;) {
			const e = s.size - l, t = Math.min(e, 65536);
			c.set(a.subarray(i + l, i + l + t), h);
			const n = o(s.segId, l, this.toKernelPtr(h), t);
			if (n <= 0) break;
			l += n;
		}
		const d = (0, this.kernelInstance.exports.kernel_ipc_shmdt)(s.segId);
		n.delete(i), d < 0 ? this.completeChannelRaw(e, d, -d) : this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	drainMqueueNotification() {
		const e = this.kernelInstance.exports.kernel_mq_drain_notification;
		if (!e) return;
		const t = this.scratchOffset;
		if (e(this.toKernelPtr(t))) {
			const e = new DataView(this.kernelMemory.buffer, t), i = e.getUint32(0, !0), n = e.getUint32(4, !0);
			n > 0 && this.sendSignalToProcess(i, n);
		}
	}
};
var pi = class {
	entryUrl;
	constructor(e) {
		this.entryUrl = e;
	}
	createWorker(e) {
		const t = new Worker(this.entryUrl, { type: "module" }), i = new gi(t);
		return t.postMessage(e), i;
	}
}, gi = class {
	worker;
	handlers = /* @__PURE__ */ new Map();
	terminated = !1;
	terminationPromise = null;
	shutdownAckResolver = null;
	constructor(e) {
		this.worker = e, e.onmessage = (e) => {
			if (e.data && "object" == typeof e.data && "__kandelo_worker_shutdown_ack" === e.data.type) return this.shutdownAckResolver?.(), void (this.shutdownAckResolver = null);
			for (const t of this.handlers.get("message") ?? []) t(e.data);
		}, e.onerror = (e) => {
			for (const t of this.handlers.get("error") ?? []) t(new Error(e.message));
			if (!this.terminated) {
				this.terminated = !0, this.shutdownAckResolver?.(), this.shutdownAckResolver = null;
				for (const e of this.handlers.get("exit") ?? []) e(1);
			}
		};
	}
	postMessage(e, t) {
		this.worker.postMessage(e, t ?? []);
	}
	on(e, t) {
		let i = this.handlers.get(e);
		i || (i = /* @__PURE__ */ new Set(), this.handlers.set(e, i)), i.add(t);
	}
	off(e, t) {
		this.handlers.get(e)?.delete(t);
	}
	async terminate() {
		return this.terminationPromise || (this.terminationPromise = this.terminateOnce()), this.terminationPromise;
	}
	async terminateOnce() {
		if (!this.terminated) {
			let t = !1;
			try {
				const i = new Promise((e) => {
					this.shutdownAckResolver = () => {
						t = !0, e();
					};
				});
				this.worker.postMessage({ type: "__kandelo_worker_shutdown" }), await Promise.race([i, (e = 500, new Promise((t) => setTimeout(t, e)))]);
			} catch {} finally {
				!t && this.shutdownAckResolver && (this.shutdownAckResolver = null);
			}
		}
		var e;
		if (this.worker.terminate(), !this.terminated) {
			this.terminated = !0;
			for (const e of this.handlers.get("exit") ?? []) e(0);
		}
		return 0;
	}
}, mi = class extends Error {
	errno = 11;
	constructor() {
		super("EAGAIN");
	}
};
const wi = 107, yi = "0.0.0.0";
function ki(e) {
	return `${e[0]}.${e[1]}.${e[2]}.${e[3]}`;
}
function bi(e) {
	return new Uint8Array([
		e[0] ?? 0,
		e[1] ?? 0,
		e[2] ?? 0,
		e[3] ?? 0
	]);
}
function Ii(e, t) {
	return e === yi || e === t;
}
function vi(e, t) {
	return e === yi || t === yi || e === t;
}
var xi = class {
	recvBuf = new Uint8Array(0);
	peer;
	readClosed = !1;
	writeClosed = !1;
	reset = !1;
	pairWith(e) {
		this.peer = e;
	}
	enqueue(e) {
		this.readClosed || this.reset || (this.recvBuf = function(e, t) {
			const i = new Uint8Array(e.length + t.length);
			return i.set(e, 0), i.set(t, e.length), i;
		}(this.recvBuf, e));
	}
	send(e, t) {
		if (this.reset) {
			const e = /* @__PURE__ */ new Error("ECONNRESET");
			throw e.errno = 104, e;
		}
		if (this.writeClosed || !this.peer || this.peer.readClosed || this.peer.reset) {
			const e = /* @__PURE__ */ new Error("EPIPE");
			throw e.errno = 32, e;
		}
		return this.peer.enqueue(e.slice()), e.length;
	}
	recv(e, t) {
		if (this.reset) {
			const e = /* @__PURE__ */ new Error("ECONNRESET");
			throw e.errno = 104, e;
		}
		if (this.recvBuf.length > 0) {
			const t = Math.min(e, this.recvBuf.length), i = this.recvBuf.slice(0, t);
			return this.recvBuf = this.recvBuf.slice(t), i;
		}
		if (!this.peer || this.peer.writeClosed) return new Uint8Array(0);
		throw new mi();
	}
	poll(e) {
		let t = 0;
		return this.reset && (t |= 8), 1 & e && ((this.recvBuf.length > 0 || !this.peer || this.peer.writeClosed || this.readClosed) && (t |= 1), this.peer && !this.peer.writeClosed || (t |= 16)), 4 & e && (this.writeClosed || !this.peer || this.peer.readClosed || this.peer.reset || (t |= 4)), t;
	}
	shutdown(e) {
		0 !== e && 2 !== e || (this.readClosed = !0, this.recvBuf = new Uint8Array(0)), 1 !== e && 2 !== e || (this.writeClosed = !0);
	}
	close() {
		this.shutdown(2);
	}
	resetPeer() {
		this.reset = !0, this.recvBuf = new Uint8Array(0);
	}
}, _i = class {
	machines = /* @__PURE__ */ new Map();
	addressOwners = /* @__PURE__ */ new Map();
	hostnames = /* @__PURE__ */ new Map();
	tcpListeners = [];
	udpEndpoints = [];
	tcpPeersByMachine = /* @__PURE__ */ new Map();
	attachMachine(e) {
		const t = bi(e.address instanceof Uint8Array ? e.address : new Uint8Array(e.address)), i = ki(t);
		if (this.addressOwners.has(i)) throw new Error(`address ${i} is already attached`);
		const n = new Pi(this, e.id, t);
		this.machines.set(e.id, n), this.addressOwners.set(i, e.id), this.hostnames.set(e.id, t);
		for (const s of e.hostnames ?? []) this.hostnames.set(s, t);
		return n;
	}
	detachMachine(e) {
		const t = this.machines.get(e);
		if (t) {
			this.addressOwners.delete(ki(t.localAddress)), this.machines.delete(e);
			for (const [i, n] of this.hostnames) ki(n) !== ki(t.localAddress) && i !== e || this.hostnames.delete(i);
			this.tcpListeners = this.tcpListeners.filter((t) => t.machineId !== e), this.udpEndpoints = this.udpEndpoints.filter((t) => t.machineId !== e);
			for (const t of this.tcpPeersByMachine.get(e) ?? []) t.close();
			this.tcpPeersByMachine.delete(e), t.resetAllConnections();
		}
	}
	resolve(e) {
		const t = e.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
		if (t) return new Uint8Array(t.slice(1).map((e) => Number(e)));
		const i = this.hostnames.get(e);
		return i ? bi(i) : null;
	}
	listenTcp(e, t, i, n, s) {
		const r = ki(i);
		if (!this.machineOwnsAddress(e, r)) return 99;
		for (const o of this.tcpListeners) if (o.machineId === e && o.port === n && vi(o.addrKey, r)) return 98;
		return this.closeTcpListener(t), this.tcpListeners.push({
			machineId: e,
			listenerId: t,
			addr: bi(i),
			addrKey: r,
			port: n,
			target: s
		}), 0;
	}
	closeTcpListener(e) {
		this.tcpListeners = this.tcpListeners.filter((t) => t.listenerId !== e);
	}
	connectTcp(e, t, i) {
		const n = ki(i.addr), s = this.addressOwners.get(n);
		if (!s) return {
			peer: new xi(),
			status: 113
		};
		const r = this.tcpListeners.find((e) => e.machineId === s && e.port === i.port && Ii(e.addrKey, n));
		if (!r) return {
			peer: new xi(),
			status: 111
		};
		const o = new xi(), a = new xi();
		o.pairWith(a), a.pairWith(o), this.trackTcpPeer(e, o), this.trackTcpPeer(s, a);
		const c = r.target.accept(a, {
			addr: bi(i.addr),
			port: i.port
		}, {
			addr: bi(t.addr),
			port: t.port
		});
		return 0 !== c ? (o.resetPeer(), a.resetPeer(), {
			peer: o,
			status: c
		}) : {
			peer: o,
			status: 0
		};
	}
	bindUdp(e, t, i, n, s) {
		const r = ki(i);
		if (!this.machineOwnsAddress(e, r)) return 99;
		for (const o of this.udpEndpoints) if (o.machineId === e && o.port === n && vi(o.addrKey, r)) return 98;
		return this.unbindUdp(t), this.udpEndpoints.push({
			machineId: e,
			endpointId: t,
			addr: bi(i),
			addrKey: r,
			port: n,
			target: s
		}), 0;
	}
	unbindUdp(e) {
		this.udpEndpoints = this.udpEndpoints.filter((t) => t.endpointId !== e);
	}
	sendDatagram(e) {
		const t = ki(e.dstAddr), i = this.addressOwners.get(t);
		if (!i) return 113;
		const n = this.udpEndpoints.find((n) => n.machineId === i && n.port === e.dstPort && Ii(n.addrKey, t));
		return n ? n.target.receive({
			srcAddr: bi(e.srcAddr),
			srcPort: e.srcPort,
			dstAddr: bi(e.dstAddr),
			dstPort: e.dstPort,
			data: e.data.slice()
		}) : 111;
	}
	machineOwnsAddress(e, t) {
		return t === yi || this.addressOwners.get(t) === e;
	}
	trackTcpPeer(e, t) {
		let i = this.tcpPeersByMachine.get(e);
		i || (i = /* @__PURE__ */ new Set(), this.tcpPeersByMachine.set(e, i)), i.add(t);
	}
}, Pi = class {
	network;
	machineId;
	localAddress;
	connections = /* @__PURE__ */ new Map();
	connectErrors = /* @__PURE__ */ new Map();
	nextEphemeralPort = 49152;
	constructor(e, t, i) {
		this.network = e, this.machineId = t, this.localAddress = i;
	}
	connect(e, t, i) {
		if (this.connections.has(e)) return void this.connectErrors.set(e, 106);
		const n = this.allocateEphemeralPort(), s = this.network.connectTcp(this.machineId, {
			addr: this.localAddress,
			port: n
		}, {
			addr: bi(t),
			port: i
		});
		0 === s.status ? (this.connections.set(e, s.peer), this.connectErrors.delete(e)) : this.connectErrors.set(e, s.status);
	}
	connectStatus(e) {
		const t = this.connectErrors.get(e);
		return void 0 !== t ? t : this.connections.has(e) ? 0 : wi;
	}
	send(e, t, i) {
		const n = this.connections.get(e);
		if (!n) throw Object.assign(/* @__PURE__ */ new Error("ENOTCONN"), { errno: wi });
		return n.send(t, i);
	}
	recv(e, t, i) {
		const n = this.connections.get(e);
		if (!n) throw Object.assign(/* @__PURE__ */ new Error("ENOTCONN"), { errno: wi });
		return n.recv(t, i);
	}
	poll(e, t) {
		const i = this.connections.get(e);
		if (!i) throw Object.assign(/* @__PURE__ */ new Error("ENOTCONN"), { errno: wi });
		return "function" == typeof i.poll ? i.poll(t) : t;
	}
	close(e) {
		const t = this.connections.get(e);
		t && t.close(), this.connections.delete(e), this.connectErrors.delete(e);
	}
	getaddrinfo(e) {
		const t = this.network.resolve(e);
		if (!t) throw Object.assign(/* @__PURE__ */ new Error("ENOENT"), { errno: 2 });
		return t;
	}
	listenTcp(e, t, i, n) {
		return this.network.listenTcp(this.machineId, this.scopedId(e), t, i, n);
	}
	closeTcpListener(e) {
		this.network.closeTcpListener(this.scopedId(e));
	}
	bindUdp(e, t, i, n) {
		return this.network.bindUdp(this.machineId, this.scopedId(e), t, i, n);
	}
	unbindUdp(e) {
		this.network.unbindUdp(this.scopedId(e));
	}
	sendDatagram(e) {
		return this.network.sendDatagram(e);
	}
	resetAllConnections() {
		for (const e of this.connections.values()) e.close();
		this.connections.clear(), this.connectErrors.clear();
	}
	allocateEphemeralPort() {
		const e = this.nextEphemeralPort;
		return this.nextEphemeralPort += 1, this.nextEphemeralPort > 65535 && (this.nextEphemeralPort = 49152), e;
	}
	scopedId(e) {
		return `${this.machineId}:${e}`;
	}
};
const Bi = {
	reader: () => 0,
	writer: (e, t) => t,
	mode: 8630
}, Ai = {
	reader: (e, t) => (e.fill(0, 0, t), t),
	writer: (e, t) => t,
	mode: 8630
}, Si = {
	reader: () => {
		throw new Error("ENXIO");
	},
	writer: () => {
		throw new Error("ENXIO");
	},
	mode: 8630
};
const Ei = [
	"pts",
	"shm",
	"mqueue"
], Mi = [
	{
		name: "ptmx",
		type: 2,
		ino: 256
	},
	{
		name: "pts",
		type: 4,
		ino: 257
	},
	{
		name: "fd",
		type: 10,
		ino: 258
	},
	{
		name: "stdin",
		type: 10,
		ino: 259
	},
	{
		name: "stdout",
		type: 10,
		ino: 260
	},
	{
		name: "stderr",
		type: 10,
		ino: 261
	}
];
function Ui(e) {
	return "/" === e || "" === e || "." === e;
}
var Ci = class {
	devices = /* @__PURE__ */ new Map();
	handles = /* @__PURE__ */ new Map();
	nextHandle = 1;
	deviceNames;
	constructor() {
		const e = {
			reader: (e, t) => {
				if (void 0 !== globalThis.crypto && globalThis.crypto.getRandomValues) {
					const i = new Uint8Array(t);
					globalThis.crypto.getRandomValues(i), e.set(i, 0);
				} else for (let i = 0; i < t; i++) e[i] = 256 * Math.random() | 0;
				return t;
			},
			writer: (e, t) => t,
			mode: 8630
		};
		this.devices.set("null", Bi), this.devices.set("zero", Ai), this.devices.set("urandom", e), this.devices.set("random", e), this.devices.set("console", Si), this.devices.set("tty", Si), this.deviceNames = [...this.devices.keys()];
	}
	getDevice(e) {
		const t = e.startsWith("/") ? e.slice(1) : e, i = this.devices.get(t);
		if (!i) throw new Error("ENOENT");
		return i;
	}
	open(e, t, i) {
		const n = e.startsWith("/") ? e.slice(1) : e;
		if (Ui(e) || Ei.includes(n)) {
			const e = this.nextHandle++;
			return this.handles.set(e, { device: null }), e;
		}
		const s = this.getDevice(e), r = this.nextHandle++;
		return this.handles.set(r, { device: s }), r;
	}
	close(e) {
		if (!this.handles.delete(e)) throw new Error("EBADF");
		return 0;
	}
	read(e, t, i, n) {
		const s = this.handles.get(e);
		if (!s) throw new Error("EBADF");
		if (!s.device) throw new Error("EISDIR");
		return s.device.reader(t, Math.min(n, t.length));
	}
	write(e, t, i, n) {
		const s = this.handles.get(e);
		if (!s) throw new Error("EBADF");
		if (!s.device) throw new Error("EISDIR");
		return s.device.writer(t, Math.min(n, t.length));
	}
	seek(e, t, i) {
		return 0;
	}
	fstat(e) {
		const t = this.handles.get(e);
		if (!t) throw new Error("EBADF");
		const i = Date.now();
		return t.device ? {
			dev: 5,
			ino: 0,
			mode: t.device.mode,
			nlink: 1,
			uid: 0,
			gid: 0,
			size: 0,
			atimeMs: i,
			mtimeMs: i,
			ctimeMs: i
		} : {
			dev: 5,
			ino: 0,
			mode: 16877,
			nlink: 2,
			uid: 0,
			gid: 0,
			size: 0,
			atimeMs: i,
			mtimeMs: i,
			ctimeMs: i
		};
	}
	ftruncate(e, t) {}
	fsync(e) {}
	fchmod(e, t) {}
	fchown(e, t, i) {}
	stat(e) {
		const t = Date.now();
		if (Ui(e)) return {
			dev: 5,
			ino: 0,
			mode: 16877,
			nlink: 2 + this.devices.size,
			uid: 0,
			gid: 0,
			size: 0,
			atimeMs: t,
			mtimeMs: t,
			ctimeMs: t
		};
		const i = e.startsWith("/") ? e.slice(1) : e;
		return Ei.includes(i) ? {
			dev: 5,
			ino: 0,
			mode: 16877,
			nlink: 2,
			uid: 0,
			gid: 0,
			size: 0,
			atimeMs: t,
			mtimeMs: t,
			ctimeMs: t
		} : {
			dev: 5,
			ino: 0,
			mode: this.getDevice(e).mode,
			nlink: 1,
			uid: 0,
			gid: 0,
			size: 0,
			atimeMs: t,
			mtimeMs: t,
			ctimeMs: t
		};
	}
	lstat(e) {
		return this.stat(e);
	}
	statfs(e) {
		this.stat(e);
		const t = function(e, t = 0) {
			return {
				type: e,
				bsize: 4096,
				blocks: 0,
				bfree: 0,
				bavail: 0,
				files: 0,
				ffree: 0,
				fsid: t,
				namelen: 255,
				frsize: 4096,
				flags: 0
			};
		}(4979, 5);
		return t.files = this.devices.size + Ei.length + Mi.length, t;
	}
	mkdir(e, t) {
		throw new Error("EACCES");
	}
	rmdir(e) {
		throw new Error("EACCES");
	}
	unlink(e) {
		throw new Error("EACCES");
	}
	rename(e, t) {
		throw new Error("EACCES");
	}
	link(e, t) {
		throw new Error("ENOSYS");
	}
	symlink(e, t) {
		throw new Error("EACCES");
	}
	readlink(e) {
		throw new Error("EINVAL");
	}
	chmod(e, t) {}
	chown(e, t, i) {}
	access(e, t) {
		this.stat(e);
	}
	utimensat(e, t, i, n, s) {}
	dirHandles = /* @__PURE__ */ new Map();
	nextDirHandle = 1;
	opendir(e) {
		const t = e.startsWith("/") ? e.slice(1) : e;
		let i;
		if (Ui(e)) i = [...this.deviceNames.map((e, t) => ({
			name: e,
			type: 2,
			ino: t + 1
		})), ...Mi.filter((e) => !this.devices.has(e.name))];
		else {
			if (!Ei.includes(t)) throw new Error("ENOTDIR");
			i = [];
		}
		const n = this.nextDirHandle++;
		return this.dirHandles.set(n, {
			idx: 0,
			entries: i
		}), n;
	}
	readdir(e) {
		const t = this.dirHandles.get(e);
		if (!t) throw new Error("EBADF");
		if (t.idx >= t.entries.length) return null;
		const i = t.entries[t.idx];
		return t.idx++, i;
	}
	closedir(e) {
		this.dirHandles.delete(e);
	}
}, zi = ArrayBuffer, Ti = Uint8Array, Oi = Uint16Array, Ri = Int16Array, $i = Int32Array, Ni = function(e, t, i) {
	if (Ti.prototype.slice) return Ti.prototype.slice.call(e, t, i);
	(null == t || t < 0) && (t = 0), (null == i || i > e.length) && (i = e.length);
	var n = new Ti(i - t);
	return n.set(e.subarray(t, i)), n;
}, Wi = function(e, t, i, n) {
	if (Ti.prototype.fill) return Ti.prototype.fill.call(e, t, i, n);
	for ((null == i || i < 0) && (i = 0), (null == n || n > e.length) && (n = e.length); i < n; ++i) e[i] = t;
	return e;
}, Fi = function(e, t, i, n) {
	if (Ti.prototype.copyWithin) return Ti.prototype.copyWithin.call(e, t, i, n);
	for ((null == i || i < 0) && (i = 0), (null == n || n > e.length) && (n = e.length); i < n;) e[t++] = e[i++];
}, Li = [
	"invalid zstd data",
	"window size too large (>2046MB)",
	"invalid block type",
	"FSE accuracy too high",
	"match distance too far back",
	"unexpected EOF"
], Di = function(e, t, i) {
	var n = new Error(t || Li[e]);
	if (n.code = e, Error.captureStackTrace && Error.captureStackTrace(n, Di), !i) throw n;
	return n;
}, Ki = function(e, t, i) {
	for (var n = 0, s = 0; n < i; ++n) s |= e[t++] << (n << 3);
	return s;
}, Vi = function(e, t) {
	var i, n, s = e[0] | e[1] << 8 | e[2] << 16;
	if (3126568 == s && 253 == e[3]) {
		var r = e[4], o = r >> 5 & 1, a = r >> 2 & 1, c = 3 & r, h = r >> 6;
		8 & r && Di(0);
		var l = 6 - o, d = 3 == c ? 4 : c, f = Ki(e, l, d), u = h ? 1 << h : o, p = Ki(e, l += d, u) + (1 == h && 256), g = p;
		if (!o) {
			var m = 1 << 10 + (e[5] >> 3);
			g = m + (m >> 3) * (7 & e[5]);
		}
		g > 2145386496 && Di(1);
		var w = new Ti((1 == t ? p || g : t ? 0 : g) + 12);
		return w[0] = 1, w[4] = 4, w[8] = 8, {
			b: l + u,
			y: 0,
			l: 0,
			d: f,
			w: t && 1 != t ? t : w.subarray(12),
			e: g,
			o: new $i(w.buffer, 0, 3),
			u: p,
			c: a,
			m: Math.min(131072, g)
		};
	}
	if (25481893 == (s >> 4 | e[3] << 20)) return (((i = e)[n = 4] | i[n + 1] << 8 | i[n + 2] << 16 | i[n + 3] << 24) >>> 0) + 8;
	Di(0);
}, Hi = function(e) {
	for (var t = 0; 1 << t <= e; ++t);
	return t - 1;
}, qi = function(e, t, i) {
	var n = 4 + (t << 3), s = 5 + (15 & e[t]);
	s > i && Di(3);
	for (var r = 1 << s, o = r, a = -1, c = -1, h = -1, l = r, d = new zi(512 + (r << 2)), f = new Ri(d, 0, 256), u = new Oi(d, 0, 256), p = new Oi(d, 512, r), g = 512 + (r << 1), m = new Ti(d, g, r), w = new Ti(d, g + r); a < 255 && o > 0;) {
		var y = Hi(o + 1), k = n >> 3, b = (1 << y + 1) - 1, I = (e[k] | e[k + 1] << 8 | e[k + 2] << 16) >> (7 & n) & b, v = (1 << y) - 1, x = b - o - 1, _ = I & v;
		if (_ < x ? (n += y, I = _) : (n += y + 1, I > v && (I -= x)), f[++a] = --I, -1 == I ? (o += I, m[--l] = a) : o -= I, !I) do {
			var P = n >> 3;
			c = (e[P] | e[P + 1] << 8) >> (7 & n) & 3, n += 2, a += c;
		} while (3 == c);
	}
	(a > 255 || o) && Di(0);
	for (var B = 0, A = (r >> 1) + (r >> 3) + 3, S = r - 1, E = 0; E <= a; ++E) {
		var M = f[E];
		if (M < 1) u[E] = -M;
		else for (h = 0; h < M; ++h) {
			m[B] = E;
			do
				B = B + A & S;
			while (B >= l);
		}
	}
	for (B && Di(0), h = 0; h < r; ++h) {
		var U = u[m[h]]++;
		p[h] = (U << (w[h] = s - Hi(U))) - r;
	}
	return [n + 7 >> 3, {
		b: s,
		s: m,
		n: w,
		t: p
	}];
}, Gi = qi(new Ti([
	81,
	16,
	99,
	140,
	49,
	198,
	24,
	99,
	12,
	33,
	196,
	24,
	99,
	102,
	102,
	134,
	70,
	146,
	4
]), 0, 6)[1], ji = qi(new Ti([
	33,
	20,
	196,
	24,
	99,
	140,
	33,
	132,
	16,
	66,
	8,
	33,
	132,
	16,
	66,
	8,
	33,
	68,
	68,
	68,
	68,
	68,
	68,
	68,
	68,
	36,
	9
]), 0, 6)[1], Xi = qi(new Ti([
	32,
	132,
	16,
	66,
	102,
	70,
	68,
	68,
	68,
	68,
	36,
	73,
	2
]), 0, 5)[1], Yi = function(e, t) {
	for (var i = e.length, n = new $i(i), s = 0; s < i; ++s) n[s] = t, t += 1 << e[s];
	return n;
}, Ji = new Ti(new $i([
	0,
	0,
	0,
	0,
	16843009,
	50528770,
	134678020,
	202050057,
	269422093
]).buffer, 0, 36), Zi = Yi(Ji, 0), Qi = new Ti(new $i([
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	16843009,
	50528770,
	117769220,
	185207048,
	252579084,
	16
]).buffer, 0, 53), en = Yi(Qi, 3), tn = function(e, t, i) {
	var n = e.length, s = t.length, r = e[n - 1], o = (1 << i.b) - 1, a = -i.b;
	r || Di(0);
	for (var c = 0, h = i.b, l = (n << 3) - 8 + Hi(r) - h, d = -1; l > a && d < s;) {
		var f = l >> 3;
		c = (c << h | (e[f] | e[f + 1] << 8 | e[f + 2] << 16) >> (7 & l)) & o, t[++d] = i.s[c], l -= h = i.n[c];
	}
	l == a && d + 1 == s || Di(0);
}, nn = function(e, t, i) {
	var n = 6, s = t.length + 3 >> 2, r = s << 1, o = s + r;
	tn(e.subarray(n, n += e[0] | e[1] << 8), t.subarray(0, s), i), tn(e.subarray(n, n += e[2] | e[3] << 8), t.subarray(s, r), i), tn(e.subarray(n, n += e[4] | e[5] << 8), t.subarray(r, o), i), tn(e.subarray(n), t.subarray(o), i);
}, sn = function(e, t, i) {
	var n, s = t.b, r = e[s], o = r >> 1 & 3;
	t.l = 1 & r;
	var a = r >> 3 | e[s + 1] << 5 | e[s + 2] << 13, c = (s += 3) + a;
	if (1 == o) {
		if (s >= e.length) return;
		return t.b = s + 1, i ? (Wi(i, e[s], t.y, t.y += a), i) : Wi(new Ti(a), e[s]);
	}
	if (!(c > e.length)) {
		if (0 == o) return t.b = c, i ? (i.set(e.subarray(s, c), t.y), t.y += a, i) : Ni(e, s, c);
		if (2 == o) {
			var h = e[s], l = 3 & h, d = h >> 2 & 3, f = h >> 4, u = 0, p = 0;
			l < 2 ? 1 & d ? f |= e[++s] << 4 | (2 & d && e[++s] << 12) : f = h >> 3 : (p = d, d < 2 ? (f |= (63 & e[++s]) << 4, u = e[s] >> 6 | e[++s] << 2) : 2 == d ? (f |= e[++s] << 4 | (3 & e[++s]) << 12, u = e[s] >> 2 | e[++s] << 6) : (f |= e[++s] << 4 | (63 & e[++s]) << 12, u = e[s] >> 6 | e[++s] << 2 | e[++s] << 10)), ++s;
			var g = i ? i.subarray(t.y, t.y + t.m) : new Ti(t.m), m = g.length - f;
			if (0 == l) g.set(e.subarray(s, s += f), m);
			else if (1 == l) Wi(g, e[s++], m);
			else {
				var w = t.h;
				if (2 == l) {
					var y = function(e, t) {
						var i = 0, n = -1, s = new Ti(292), r = e[t], o = s.subarray(0, 256), a = s.subarray(256, 268), c = new Oi(s.buffer, 268);
						if (r < 128) {
							var h = qi(e, t + 1, 6), l = h[0], d = h[1], f = l << 3, u = e[t += r];
							u || Di(0);
							for (var p = 0, g = 0, m = d.b, w = m, y = (++t << 3) - 8 + Hi(u); !((y -= m) < f);) {
								var k = y >> 3;
								if (p += (e[k] | e[k + 1] << 8) >> (7 & y) & (1 << m) - 1, o[++n] = d.s[p], (y -= w) < f) break;
								g += (e[k = y >> 3] | e[k + 1] << 8) >> (7 & y) & (1 << w) - 1, o[++n] = d.s[g], m = d.n[p], p = d.t[p], w = d.n[g], g = d.t[g];
							}
							++n > 255 && Di(0);
						} else {
							for (n = r - 127; i < n; i += 2) {
								var b = e[++t];
								o[i] = b >> 4, o[i + 1] = 15 & b;
							}
							++t;
						}
						var I = 0;
						for (i = 0; i < n; ++i) (P = o[i]) > 11 && Di(0), I += P && 1 << P - 1;
						var v = Hi(I) + 1, x = 1 << v, _ = x - I;
						for (_ & _ - 1 && Di(0), o[n++] = Hi(_) + 1, i = 0; i < n; ++i) {
							var P = o[i];
							++a[o[i] = P && v + 1 - P];
						}
						var B = new Ti(x << 1), A = B.subarray(0, x), S = B.subarray(x);
						for (c[v] = 0, i = v; i > 0; --i) {
							var E = c[i];
							Wi(S, i, E, c[i - 1] = E + a[i] * (1 << v - i));
						}
						for (c[0] != x && Di(0), i = 0; i < n; ++i) {
							var M = o[i];
							if (M) {
								var U = c[M];
								Wi(A, i, U, c[M] = U + (1 << v - M));
							}
						}
						return [t, {
							n: S,
							b: v,
							s: A
						}];
					}(e, s);
					u += s - (s = y[0]), t.h = w = y[1];
				} else w || Di(0);
				(p ? nn : tn)(e.subarray(s, s += u), g.subarray(m), w);
			}
			var k = e[s++];
			if (k) {
				255 == k ? k = 32512 + (e[s++] | e[s++] << 8) : k > 127 && (k = k - 128 << 8 | e[s++]);
				var b = e[s++];
				3 & b && Di(0);
				for (var I = [
					ji,
					Xi,
					Gi
				], v = 2; v > -1; --v) {
					var x = b >> 2 + (v << 1) & 3;
					if (1 == x) {
						var _ = new Ti([
							0,
							0,
							e[s++]
						]);
						I[v] = {
							s: _.subarray(2, 3),
							n: _.subarray(0, 1),
							t: new Oi(_.buffer, 0, 1),
							b: 0
						};
					} else 2 == x ? (s = (n = qi(e, s, 9 - (1 & v)))[0], I[v] = n[1]) : 3 == x && (t.t || Di(0), I[v] = t.t[v]);
				}
				var P = t.t = I, B = P[0], A = P[1], S = P[2], E = e[c - 1];
				E || Di(0);
				var M = (c << 3) - 8 + Hi(E) - S.b, U = M >> 3, C = 0, z = (e[U] | e[U + 1] << 8) >> (7 & M) & (1 << S.b) - 1, T = (e[U = (M -= A.b) >> 3] | e[U + 1] << 8) >> (7 & M) & (1 << A.b) - 1, O = (e[U = (M -= B.b) >> 3] | e[U + 1] << 8) >> (7 & M) & (1 << B.b) - 1;
				for (++k; --k;) {
					var R = S.s[z], $ = S.n[z], N = B.s[O], W = B.n[O], F = A.s[T], L = A.n[T], D = 1 << F, K = D + ((e[U = (M -= F) >> 3] | e[U + 1] << 8 | e[U + 2] << 16 | e[U + 3] << 24) >>> (7 & M) & D - 1);
					U = (M -= Qi[N]) >> 3;
					var V = en[N] + ((e[U] | e[U + 1] << 8 | e[U + 2] << 16) >> (7 & M) & (1 << Qi[N]) - 1);
					U = (M -= Ji[R]) >> 3;
					var H = Zi[R] + ((e[U] | e[U + 1] << 8 | e[U + 2] << 16) >> (7 & M) & (1 << Ji[R]) - 1);
					if (U = (M -= $) >> 3, z = S.t[z] + ((e[U] | e[U + 1] << 8) >> (7 & M) & (1 << $) - 1), U = (M -= W) >> 3, O = B.t[O] + ((e[U] | e[U + 1] << 8) >> (7 & M) & (1 << W) - 1), U = (M -= L) >> 3, T = A.t[T] + ((e[U] | e[U + 1] << 8) >> (7 & M) & (1 << L) - 1), K > 3) t.o[2] = t.o[1], t.o[1] = t.o[0], t.o[0] = K -= 3;
					else {
						var q = K - (0 != H);
						q ? (K = 3 == q ? t.o[0] - 1 : t.o[q], q > 1 && (t.o[2] = t.o[1]), t.o[1] = t.o[0], t.o[0] = K) : K = t.o[0];
					}
					for (v = 0; v < H; ++v) g[C + v] = g[m + v];
					m += H;
					var G = (C += H) - K;
					if (G < 0) {
						var j = -G, X = t.e + G;
						j > V && (j = V);
						for (v = 0; v < j; ++v) g[C + v] = t.w[X + v];
						C += j, V -= j, G = 0;
					}
					for (v = 0; v < V; ++v) g[C + v] = g[G + v];
					C += V;
				}
				if (C != m) for (; m < g.length;) g[C++] = g[m++];
				else C = g.length;
				i ? t.y += C : g = Ni(g, 0, C);
			} else if (i) {
				if (t.y += f, m) for (v = 0; v < f; ++v) g[v] = g[m + v];
			} else m && (g = Ni(g, m));
			return t.b = c, g;
		}
		Di(2);
	}
};
function rn(e, t) {
	for (var i = [], n = +!t, s = 0, r = 0; e.length;) {
		var o = Vi(e, n || t);
		if ("object" == typeof o) {
			for (n ? (t = null, o.w.length == o.u && (i.push(t = o.w), r += o.u)) : (i.push(t), o.e = 0); !o.l;) {
				var a = sn(e, o, t);
				a || Di(5), t ? o.e = o.y : (i.push(a), r += a.length, Fi(o.w, 0, a.length), o.w.set(a, o.w.length - a.length));
			}
			s = o.b + 4 * o.c;
		} else s = o;
		e = e.subarray(s);
	}
	return function(e, t) {
		if (1 == e.length) return e[0];
		for (var i = new Ti(t), n = 0, s = 0; n < e.length; ++n) {
			var r = e[n];
			i.set(r, s), s += r.length;
		}
		return i;
	}(i, r);
}
const on = 4096, an = 1024, cn = Math.floor(160), hn = 12, ln = 16, dn = 32, fn = 48, un = 100, pn = -2147483648, gn = {
	[-2]: "No such file or directory",
	[-5]: "I/O error",
	[-9]: "Bad file descriptor",
	[-17]: "File exists",
	[-20]: "Not a directory",
	[-21]: "Is a directory",
	[-22]: "Invalid argument",
	[-24]: "Too many open files",
	[-28]: "No space left on device",
	[-36]: "File name too long",
	[-39]: "Directory not empty",
	[-40]: "Too many symbolic links"
};
var mn = class extends Error {
	code;
	constructor(e, t) {
		super(t || gn[e] || `Error ${e}`), this.code = e, this.name = "SFSError";
	}
};
const wn = new TextEncoder(), yn = new TextDecoder();
function kn(e) {
	return e.buffer instanceof SharedArrayBuffer ? yn.decode(new Uint8Array(e)) : yn.decode(e);
}
function bn(e) {
	return e + 3 & -4;
}
var In = class e {
	buffer;
	view;
	i32;
	u8;
	constructor(e) {
		this.buffer = e, this.view = new DataView(e), this.i32 = new Int32Array(e), this.u8 = new Uint8Array(e);
	}
	static mkfs(t, i) {
		const n = t.byteLength;
		if (n < 65536) throw new mn(-22);
		const s = Math.floor(n / on), r = i ? Math.floor(i / on) : 4 * s;
		let o = Math.floor(r / 4);
		o < 32 && (o = 32), o = 32 * Math.ceil(o / 32);
		const a = Math.ceil(o / 32768), c = Math.ceil(r / 32768), h = Math.ceil(128 * o / on), l = 1 + a, d = l + c, f = d + h;
		if (f >= s) throw new mn(-28);
		new Uint8Array(t).fill(0);
		const u = new e(t);
		u.w32(0, 1397114451), u.w32(4, 1), u.w32(8, on), u.w32(12, s), u.w32(16, o), u.w32(28, 1), u.w32(32, l), u.w32(36, d), u.w32(40, f), u.w32(44, a), u.w32(48, c), u.w32(52, h), u.w32(68, r), u.w32(72, 256);
		const p = l * on;
		for (let e = 0; e < f; e++) {
			const t = (p >> 2) + (e >> 5);
			u.i32[t] |= 1 << (31 & e);
		}
		const g = s - f;
		Atomics.store(u.i32, 5, g), u.i32[1024] |= 3, Atomics.store(u.i32, 6, o - 2);
		const m = u.inodeOffset(1);
		u.w32(m + 8, 16877), u.w32(m + hn, 2);
		const w = u.blockAlloc();
		if (w < 0) throw new mn(-28);
		u.w32(m + fn, w);
		const y = w * on, k = bn(9), b = bn(10);
		u.w32(y, 1), u.view.setUint16(y + 4, k, !0), u.view.setUint16(y + 6, 1, !0), u.u8[y + 8] = 46;
		const I = y + k;
		return u.w32(I, 1), u.view.setUint16(I + 4, b, !0), u.view.setUint16(I + 6, 2, !0), u.u8[I + 8] = 46, u.u8[I + 8 + 1] = 46, u.w64(m + ln, k + b), Atomics.store(u.i32, 14, 1), u;
	}
	static mount(t) {
		const i = new e(t);
		if (1397114451 !== i.r32(0)) throw new mn(-22, "Bad magic");
		if (1 !== i.r32(4)) throw new mn(-22, "Bad version");
		if (4096 !== i.r32(8)) throw new mn(-22, "Bad block size");
		return i;
	}
	statfs() {
		const e = this.r32(8), t = this.r32(12), i = this.r32(68), n = "number" == typeof this.buffer.maxByteLength ? this.buffer.maxByteLength : this.buffer.byteLength, s = Math.floor(n / e), r = Math.max(t, Math.min(i, s));
		return {
			blockSize: e,
			totalBlocks: r,
			freeBlocks: Atomics.load(this.i32, 5) + Math.max(0, r - t),
			totalInodes: this.r32(16),
			freeInodes: Atomics.load(this.i32, 6),
			maxName: 255
		};
	}
	r32(e) {
		return this.view.getUint32(e, !0);
	}
	w32(e, t) {
		this.view.setUint32(e, t, !0);
	}
	r64(e) {
		return Number(this.view.getBigUint64(e, !0));
	}
	w64(e, t) {
		this.view.setBigUint64(e, BigInt(t), !0);
	}
	sbLock() {
		for (;;) {
			if (0 === Atomics.compareExchange(this.i32, 15, 0, 1)) return;
			Atomics.wait(this.i32, 15, 1);
		}
	}
	sbUnlock() {
		Atomics.store(this.i32, 15, 0), Atomics.notify(this.i32, 15, Infinity);
	}
	blockAlloc() {
		const e = this.r32(12), t = this.r32(32) * on, i = Math.ceil(e / 32);
		for (let n = 0; n < i; n++) {
			const i = (t >> 2) + n, s = Atomics.load(this.i32, i);
			if (-1 !== s) for (let t = 0; t < 32; t++) {
				const r = 32 * n + t;
				if (r >= e) return -28;
				if (s & 1 << t) continue;
				const o = s | 1 << t;
				if (Atomics.compareExchange(this.i32, i, s, o) === s) {
					Atomics.sub(this.i32, 5, 1);
					const e = r * on;
					return this.u8.fill(0, e, e + on), r;
				}
				n--;
				break;
			}
		}
		return -28;
	}
	blockAllocWithGrow() {
		let e = this.blockAlloc();
		return -28 !== e ? e : this.grow() < 0 ? -28 : (e = this.blockAlloc(), e);
	}
	blockFree(e) {
		const t = (this.r32(32) * on >> 2) + (e >> 5), i = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t), n = e & ~(1 << i);
			if (Atomics.compareExchange(this.i32, t, e, n) === e) break;
		}
		Atomics.add(this.i32, 5, 1);
	}
	grow() {
		this.sbLock();
		try {
			if (Atomics.load(this.i32, 5) > 0) return 0;
			const e = this.r32(12), t = this.r32(68);
			let i = this.r32(72), n = e + i;
			if (n > t && (n = t, i = n - e, 0 === i)) return -28;
			const s = n * on;
			if (this.buffer.byteLength < s) try {
				this.buffer.grow(s), this.view = new DataView(this.buffer), this.i32 = new Int32Array(this.buffer), this.u8 = new Uint8Array(this.buffer);
			} catch {
				return -28;
			}
			return this.w32(12, n), Atomics.add(this.i32, 5, i), Atomics.add(this.i32, 14, 1), 0;
		} finally {
			this.sbUnlock();
		}
	}
	inodeOffset(e) {
		return (this.r32(36) + Math.floor(e / 32)) * on + e % 32 * 128;
	}
	inodeAlloc() {
		const e = this.r32(16), t = this.r32(28) * on, i = Math.ceil(e / 32);
		for (let n = 0; n < i; n++) {
			const i = (t >> 2) + n, s = Atomics.load(this.i32, i);
			if (-1 !== s) for (let t = 0; t < 32; t++) {
				const r = 32 * n + t;
				if (r >= e) return -28;
				if (s & 1 << t) continue;
				const o = s | 1 << t;
				if (Atomics.compareExchange(this.i32, i, s, o) === s) {
					Atomics.sub(this.i32, 6, 1);
					const e = this.inodeOffset(r);
					return this.u8.fill(0, e, e + 128), r;
				}
				n--;
				break;
			}
		}
		return -28;
	}
	inodeFree(e) {
		const t = (this.r32(28) * on >> 2) + (e >> 5), i = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t), n = e & ~(1 << i);
			if (Atomics.compareExchange(this.i32, t, e, n) === e) break;
		}
		Atomics.add(this.i32, 6, 1);
	}
	inodeReadLock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		for (;;) {
			const e = Atomics.load(this.i32, t);
			if (e & pn) Atomics.wait(this.i32, t, e);
			else if (Atomics.compareExchange(this.i32, t, e, e + 1) === e) return;
		}
	}
	inodeReadUnlock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		1 == (2147483647 & Atomics.sub(this.i32, t, 1)) && Atomics.notify(this.i32, t, 1);
	}
	inodeWriteLock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		for (;;) {
			const e = Atomics.load(this.i32, t);
			if (0 === e) {
				if (0 === Atomics.compareExchange(this.i32, t, 0, pn)) return;
			} else Atomics.wait(this.i32, t, e);
		}
	}
	inodeWriteUnlock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		Atomics.store(this.i32, t, 0), Atomics.notify(this.i32, t, Infinity);
	}
	inodeBlockMap(e, t, i) {
		const n = this.inodeOffset(e);
		if (t < 10) {
			const e = this.r32(n + fn + 4 * t);
			if (0 !== e) return e;
			if (!i) return 0;
			const s = this.blockAllocWithGrow();
			return s < 0 || this.w32(n + fn + 4 * t, s), s;
		}
		if ((t -= 10) < 1024) {
			let e = this.r32(n + 88);
			if (0 === e) {
				if (!i) return 0;
				if (e = this.blockAllocWithGrow(), e < 0) return e;
				this.w32(n + 88, e);
			}
			const s = e * on + 4 * t, r = this.r32(s);
			if (0 !== r) return r;
			if (!i) return 0;
			const o = this.blockAllocWithGrow();
			return o < 0 || this.w32(s, o), o;
		}
		if ((t -= an) < 1048576) {
			const e = Math.floor(t / an), s = t % an;
			let r = this.r32(n + 92);
			if (0 === r) {
				if (!i) return 0;
				if (r = this.blockAllocWithGrow(), r < 0) return r;
				this.w32(n + 92, r);
			}
			const o = r * on + 4 * e;
			let a = this.r32(o);
			if (0 === a) {
				if (!i) return 0;
				if (a = this.blockAllocWithGrow(), a < 0) return a;
				this.w32(o, a);
			}
			const c = a * on + 4 * s, h = this.r32(c);
			if (0 !== h) return h;
			if (!i) return 0;
			const l = this.blockAllocWithGrow();
			return l < 0 || this.w32(c, l), l;
		}
		return -22;
	}
	inodeReadData(e, t, i, n) {
		const s = this.inodeOffset(e), r = this.r64(s + ln);
		if (t >= r) return 0;
		t + n > r && (n = r - t);
		let o = 0, a = 0;
		for (; n > 0;) {
			const s = Math.floor(t / on), r = t % on;
			let c = on - r;
			c > n && (c = n);
			const h = this.inodeBlockMap(e, s, !1);
			if (h <= 0) i.fill(0, a, a + c);
			else {
				const e = h * on + r;
				i.set(this.u8.subarray(e, e + c), a);
			}
			a += c, t += c, n -= c, o += c;
		}
		return o;
	}
	inodeWriteData(e, t, i, n) {
		const s = this.inodeOffset(e);
		let r = 0, o = 0;
		for (; n > 0;) {
			const s = Math.floor(t / on), a = t % on;
			let c = on - a;
			c > n && (c = n);
			const h = this.inodeBlockMap(e, s, !0);
			if (h < 0) return r > 0 ? r : h;
			const l = h * on + a;
			this.u8.set(i.subarray(o, o + c), l), o += c, t += c, n -= c, r += c;
		}
		return t > this.r64(s + ln) && this.w64(s + ln, t), r;
	}
	freeBlocksFrom(e, t) {
		const i = this.inodeOffset(e);
		for (let r = t; r < 10; r++) {
			const e = this.r32(i + fn + 4 * r);
			e && (this.blockFree(e), this.w32(i + fn + 4 * r, 0));
		}
		const n = this.r32(i + 88);
		if (n) {
			const e = t > 10 ? t - 10 : 0;
			for (let t = e; t < an; t++) {
				const e = n * on + 4 * t, i = this.r32(e);
				i && (this.blockFree(i), this.w32(e, 0));
			}
			0 === e && (this.blockFree(n), this.w32(i + 88, 0));
		}
		const s = this.r32(i + 92);
		if (s) {
			const e = t > 1034 ? t - 10 - an : 0, n = Math.floor(e / an);
			for (let t = n; t < an; t++) {
				const i = s * on + 4 * t, r = this.r32(i);
				if (!r) continue;
				const o = t === n ? e % an : 0;
				for (let e = o; e < an; e++) {
					const t = r * on + 4 * e, i = this.r32(t);
					i && (this.blockFree(i), this.w32(t, 0));
				}
				0 === o && (this.blockFree(r), this.w32(i, 0));
			}
			0 === n && (this.blockFree(s), this.w32(i + 92, 0));
		}
	}
	inodeTruncate(e, t) {
		const i = this.inodeOffset(e);
		if (t >= this.r64(i + ln)) return void this.w64(i + ln, t);
		const n = Math.ceil(t / on);
		this.freeBlocksFrom(e, n), this.w64(i + ln, t);
	}
	dirLookup(e, t) {
		const i = this.inodeOffset(e), n = this.r64(i + ln);
		let s = 0;
		for (; s < n;) {
			const i = Math.floor(s / on), r = s % on, o = this.inodeBlockMap(e, i, !1);
			if (o <= 0) return -5;
			const a = o * on;
			let c = n - s;
			c > 4096 - r && (c = on - r);
			let h = r;
			for (; h < r + c;) {
				const e = a + h, i = this.r32(e), n = this.view.getUint16(e + 4, !0), s = this.view.getUint16(e + 6, !0);
				if (0 === n) return -5;
				if (0 !== i && s === t.length) {
					let n = !0;
					for (let i = 0; i < t.length; i++) if (this.u8[e + 8 + i] !== t[i]) {
						n = !1;
						break;
					}
					if (n) return i;
				}
				h += n;
			}
			s += c;
		}
		return -2;
	}
	dirAddEntry(e, t, i) {
		const n = this.inodeOffset(e), s = this.r64(n + ln), r = bn(8 + t.length);
		let o = -1, a = 0;
		for (; a < s;) {
			const n = Math.floor(a / on), c = a % on, h = this.inodeBlockMap(e, n, !1);
			if (h <= 0) return -5;
			const l = h * on;
			let d = s - a;
			d > 4096 - c && (d = on - c);
			let f = c;
			for (; f < c + d;) {
				const e = l + f, n = this.r32(e), s = this.view.getUint16(e + 4, !0), a = this.view.getUint16(e + 6, !0);
				if (0 === s) return -5;
				if (0 === n && s >= r) return this.w32(e, i), this.view.setUint16(e + 6, t.length, !0), this.u8.set(t, e + 8), 0;
				const c = bn(8 + a), h = s - c;
				if (0 !== n && h >= r) {
					this.view.setUint16(e + 4, c, !0);
					const n = e + c;
					return this.w32(n, i), this.view.setUint16(n + 4, h, !0), this.view.setUint16(n + 6, t.length, !0), this.u8.set(t, n + 8), 0;
				}
				o = e, f += s;
			}
			a += d;
		}
		let c, h = s, l = Math.floor(h / on), d = h % on;
		if (0 !== d && d + r > 4096) {
			const t = on - d;
			if (t >= 8) {
				const i = this.inodeBlockMap(e, l, !1);
				if (i > 0) {
					const e = i * on + d;
					this.w32(e, 0), this.view.setUint16(e + 4, t, !0), this.view.setUint16(e + 6, 0, !0);
				}
			} else if (o >= 0) {
				const e = this.view.getUint16(o + 4, !0);
				this.view.setUint16(o + 4, e + t, !0);
			}
			h = (l + 1) * on, l++, d = 0;
		}
		if (0 === d) {
			if (c = this.inodeBlockMap(e, l, !0), c < 0) return c;
		} else if (c = this.inodeBlockMap(e, l, !1), c <= 0) return -5;
		const f = c * on + d;
		return this.w32(f, i), this.view.setUint16(f + 4, r, !0), this.view.setUint16(f + 6, t.length, !0), this.u8.set(t, f + 8), this.w64(n + ln, h + r), 0;
	}
	dirRemoveEntry(e, t) {
		const i = this.inodeOffset(e), n = this.r64(i + ln);
		let s = 0;
		for (; s < n;) {
			const i = Math.floor(s / on), r = s % on, o = this.inodeBlockMap(e, i, !1);
			if (o <= 0) return -5;
			const a = o * on;
			let c = n - s;
			c > 4096 - r && (c = on - r);
			let h = r;
			for (; h < r + c;) {
				const e = a + h, i = this.r32(e), n = this.view.getUint16(e + 4, !0), s = this.view.getUint16(e + 6, !0);
				if (0 === n) return -5;
				if (0 !== i && s === t.length) {
					let i = !0;
					for (let n = 0; n < t.length; n++) if (this.u8[e + 8 + n] !== t[n]) {
						i = !1;
						break;
					}
					if (i) return this.w32(e, 0), 0;
				}
				h += n;
			}
			s += c;
		}
		return -2;
	}
	dirIsEmpty(e) {
		const t = this.inodeOffset(e), i = this.r64(t + ln);
		let n = 0;
		for (; n < i;) {
			const t = Math.floor(n / on), s = n % on, r = this.inodeBlockMap(e, t, !1);
			if (r <= 0) return !0;
			const o = r * on;
			let a = i - n;
			a > 4096 - s && (a = on - s);
			let c = s;
			for (; c < s + a;) {
				const e = o + c, t = this.r32(e), i = this.view.getUint16(e + 4, !0), n = this.view.getUint16(e + 6, !0);
				if (0 === i) break;
				if (0 !== t) {
					if (1 === n && 46 === this.u8[e + 8]) {
						c += i;
						continue;
					}
					if (2 === n && 46 === this.u8[e + 8] && 46 === this.u8[e + 8 + 1]) {
						c += i;
						continue;
					}
					return !1;
				}
				c += i;
			}
			n += a;
		}
		return !0;
	}
	pathResolve(e, t) {
		if (!e.startsWith("/")) return -2;
		let i = 1;
		const n = e.split("/").filter((e) => e.length > 0);
		let s = 0;
		for (let r = 0; r < n.length; r++) {
			const e = n[r];
			if (e.length > 255) return -36;
			const o = this.inodeOffset(i);
			if (16384 != (61440 & this.r32(o + 8))) return -20;
			const a = wn.encode(e), c = this.dirLookup(i, a);
			if (c < 0) return c;
			const h = this.inodeOffset(c);
			if (40960 == (61440 & this.r32(h + 8)) && (r !== n.length - 1 || t)) {
				if (++s > 8) return -40;
				const e = this.r64(h + ln);
				let t;
				if (e <= 40) t = kn(this.u8.subarray(h + fn, h + fn + e));
				else {
					const i = new Uint8Array(e);
					this.inodeReadData(c, 0, i, e), t = yn.decode(i);
				}
				if (t.startsWith("/")) {
					i = 1;
					const e = t.split("/").filter((e) => e.length > 0), s = n.slice(r + 1);
					n.length = 0, n.push(...e, ...s), r = -1;
				} else {
					const e = t.split("/").filter((e) => e.length > 0), i = n.slice(r + 1);
					n.length = r, n.push(...e, ...i), r--;
				}
				continue;
			}
			i = c;
		}
		return i;
	}
	pathResolveParent(e) {
		if (!e.startsWith("/")) throw new mn(-22, "Path must be absolute");
		const t = e.split("/").filter((e) => e.length > 0);
		if (0 === t.length) throw new mn(-22, "Cannot operate on /");
		const i = t.pop();
		if (i.length > 255) throw new mn(-36);
		const n = "/" + t.join("/"), s = this.pathResolve(n, !0);
		if (s < 0) throw new mn(s);
		const r = this.inodeOffset(s);
		if (16384 != (61440 & this.r32(r + 8))) throw new mn(-20);
		return {
			parentIno: s,
			name: i
		};
	}
	fdAlloc(e, t, i) {
		for (let n = 0; n < cn; n++) {
			const s = 256 + 24 * n, r = s >> 2;
			if (0 === Atomics.compareExchange(this.i32, r, 0, 1)) return this.w32(s + 4, e), this.w64(s + 8, 0), this.w32(s + 16, t), this.w32(s + 20, i ? 1 : 0), n;
		}
		return -24;
	}
	fdGet(e) {
		if (e < 0 || e >= cn) return null;
		const t = 256 + 24 * e;
		return Atomics.load(this.i32, t >> 2) ? {
			base: t,
			ino: this.r32(t + 4),
			offset: this.r64(t + 8),
			flags: this.r32(t + 16),
			isDir: 0 !== this.r32(t + 20)
		} : null;
	}
	fdFree(e) {
		if (e >= 0 && e < cn) {
			const t = 256 + 24 * e;
			Atomics.store(this.i32, t >> 2, 0);
		}
	}
	buildStat(e) {
		const t = this.inodeOffset(e);
		return {
			ino: e,
			mode: this.r32(t + 8),
			linkCount: this.r32(t + hn),
			size: this.r64(t + ln),
			mtime: this.r64(t + 24),
			ctime: this.r64(t + dn),
			atime: this.r64(t + 40),
			uid: this.r32(t + 96),
			gid: this.r32(t + un)
		};
	}
	open(e, t, i = 420) {
		const n = 3 & t, s = !!(64 & t);
		let r = this.pathResolve(e, !0);
		if (r < 0 && -2 === r && s) {
			const { parentIno: t, name: n } = this.pathResolveParent(e);
			this.inodeWriteLock(t);
			try {
				const e = wn.encode(n), s = this.dirLookup(t, e);
				if (s >= 0) r = s;
				else {
					const n = this.inodeAlloc();
					if (n < 0) throw new mn(-28);
					const s = this.inodeOffset(n);
					this.w32(s + 8, 32768 | 4095 & i), this.w32(s + hn, 1), this.w64(s + ln, 0);
					const o = Date.now();
					this.w64(s + 40, o), this.w64(s + 24, o), this.w64(s + dn, o);
					const a = this.dirAddEntry(t, e, n);
					if (a < 0) throw this.inodeFree(n), new mn(a);
					r = n;
				}
			} finally {
				this.inodeWriteUnlock(t);
			}
		}
		if (r < 0) throw new mn(r);
		const o = this.inodeOffset(r), a = this.r32(o + 8);
		if (16384 == (61440 & a) && 0 !== n) throw new mn(-21);
		if (65536 & t && 16384 != (61440 & a)) throw new mn(-20);
		if (512 & t) {
			if (16384 == (61440 & a)) throw new mn(-21);
			this.inodeWriteLock(r), this.inodeTruncate(r, 0), this.inodeWriteUnlock(r);
		}
		const c = this.fdAlloc(r, t, !1);
		if (c < 0) throw new mn(c);
		if (1024 & t) {
			const e = 256 + 24 * c;
			this.w64(e + 8, this.r64(o + ln));
		}
		return c;
	}
	close(e) {
		if (!this.fdGet(e)) throw new mn(-9);
		this.fdFree(e);
	}
	read(e, t) {
		const i = this.fdGet(e);
		if (!i) throw new mn(-9);
		this.inodeReadLock(i.ino);
		try {
			const n = this.inodeReadData(i.ino, i.offset, t, t.length), s = 256 + 24 * e;
			return this.w64(s + 8, i.offset + n), n;
		} finally {
			this.inodeReadUnlock(i.ino);
		}
	}
	write(e, t) {
		const i = this.fdGet(e);
		if (!i) throw new mn(-9);
		if (!(3 & i.flags)) throw new mn(-9);
		this.inodeWriteLock(i.ino);
		try {
			let n = i.offset;
			if (1024 & i.flags) {
				const e = this.inodeOffset(i.ino);
				n = this.r64(e + ln);
			}
			const s = this.inodeWriteData(i.ino, n, t, t.length), r = 256 + 24 * e;
			return this.w64(r + 8, n + s), s;
		} finally {
			this.inodeWriteUnlock(i.ino);
		}
	}
	lseek(e, t, i) {
		const n = this.fdGet(e);
		if (!n) throw new mn(-9);
		let s;
		if (0 === i) s = t;
		else if (1 === i) s = n.offset + t;
		else {
			if (2 !== i) throw new mn(-22);
			{
				const e = this.inodeOffset(n.ino);
				s = this.r64(e + ln) + t;
			}
		}
		if (s < 0) throw new mn(-22);
		const r = 256 + 24 * e;
		return this.w64(r + 8, s), s;
	}
	ftruncate(e, t) {
		const i = this.fdGet(e);
		if (!i) throw new mn(-9);
		if (!(3 & i.flags)) throw new mn(-9);
		this.inodeWriteLock(i.ino);
		try {
			this.inodeTruncate(i.ino, t);
		} finally {
			this.inodeWriteUnlock(i.ino);
		}
	}
	fstat(e) {
		const t = this.fdGet(e);
		if (!t) throw new mn(-9);
		this.inodeReadLock(t.ino);
		try {
			return this.buildStat(t.ino);
		} finally {
			this.inodeReadUnlock(t.ino);
		}
	}
	stat(e) {
		const t = this.pathResolve(e, !0);
		if (t < 0) throw new mn(t);
		this.inodeReadLock(t);
		try {
			return this.buildStat(t);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	lstat(e) {
		const t = this.pathResolve(e, !1);
		if (t < 0) throw new mn(t);
		this.inodeReadLock(t);
		try {
			return this.buildStat(t);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	unlink(e) {
		const { parentIno: t, name: i } = this.pathResolveParent(e), n = wn.encode(i);
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, n);
			if (e < 0) throw new mn(e);
			const i = this.inodeOffset(e);
			if (16384 == (61440 & this.r32(i + 8))) throw new mn(-21);
			const s = this.dirRemoveEntry(t, n);
			if (s < 0) throw new mn(s);
			this.inodeWriteLock(e);
			const r = this.r32(i + hn);
			r <= 1 ? (this.inodeTruncate(e, 0), this.w32(i + hn, 0), this.inodeWriteUnlock(e), this.inodeFree(e)) : (this.w32(i + hn, r - 1), this.inodeWriteUnlock(e));
		} finally {
			this.inodeWriteUnlock(t);
		}
	}
	rename(e, t) {
		const { parentIno: i, name: n } = this.pathResolveParent(e), { parentIno: s, name: r } = this.pathResolveParent(t), o = wn.encode(n), a = wn.encode(r), c = Math.min(i, s), h = Math.max(i, s);
		this.inodeWriteLock(c), c !== h && this.inodeWriteLock(h);
		try {
			const e = this.dirLookup(i, o);
			if (e < 0) throw new mn(e);
			const t = this.dirLookup(s, a);
			if (t >= 0) {
				const e = this.inodeOffset(t);
				if (16384 == (61440 & this.r32(e + 8))) throw new mn(-21);
				this.dirRemoveEntry(s, a), this.inodeWriteLock(t), this.inodeTruncate(t, 0), this.w32(e + hn, 0), this.inodeWriteUnlock(t), this.inodeFree(t);
			}
			const n = this.dirAddEntry(s, a, e);
			if (n < 0) throw new mn(n);
			this.dirRemoveEntry(i, o);
			const r = this.inodeOffset(e);
			if (16384 == (61440 & this.r32(r + 8)) && i !== s) {
				const e = this.inodeOffset(i);
				this.w32(e + hn, this.r32(e + hn) - 1);
				const t = this.inodeOffset(s);
				this.w32(t + hn, this.r32(t + hn) + 1);
			}
		} finally {
			c !== h && this.inodeWriteUnlock(h), this.inodeWriteUnlock(c);
		}
	}
	mkdir(e, t = 493) {
		const { parentIno: i, name: n } = this.pathResolveParent(e), s = wn.encode(n);
		this.inodeWriteLock(i);
		try {
			if (this.dirLookup(i, s) >= 0) throw new mn(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new mn(-28);
			const n = this.inodeOffset(e);
			this.w32(n + 8, 16384 | t), this.w32(n + hn, 2), this.w64(n + ln, 0);
			const r = Date.now();
			this.w64(n + 40, r), this.w64(n + 24, r), this.w64(n + dn, r);
			const o = this.blockAllocWithGrow();
			if (o < 0) throw this.inodeFree(e), new mn(-28);
			this.w32(n + fn, o);
			const a = o * on, c = bn(9), h = bn(10);
			this.w32(a, e), this.view.setUint16(a + 4, c, !0), this.view.setUint16(a + 6, 1, !0), this.u8[a + 8] = 46;
			const l = a + c;
			this.w32(l, i), this.view.setUint16(l + 4, h, !0), this.view.setUint16(l + 6, 2, !0), this.u8[l + 8] = 46, this.u8[l + 8 + 1] = 46, this.w64(n + ln, c + h);
			const d = this.dirAddEntry(i, s, e);
			if (d < 0) throw this.blockFree(o), this.inodeFree(e), new mn(d);
			const f = this.inodeOffset(i);
			this.w32(f + hn, this.r32(f + hn) + 1);
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	rmdir(e) {
		const { parentIno: t, name: i } = this.pathResolveParent(e), n = wn.encode(i);
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, n);
			if (e < 0) throw new mn(e);
			const i = this.inodeOffset(e);
			if (16384 != (61440 & this.r32(i + 8))) throw new mn(-20);
			this.inodeWriteLock(e);
			try {
				if (!this.dirIsEmpty(e)) throw new mn(-39);
				this.dirRemoveEntry(t, n), this.inodeTruncate(e, 0), this.w32(i + hn, 0);
			} finally {
				this.inodeWriteUnlock(e);
			}
			this.inodeFree(e);
			const s = this.inodeOffset(t);
			this.w32(s + hn, this.r32(s + hn) - 1);
		} finally {
			this.inodeWriteUnlock(t);
		}
	}
	symlink(e, t) {
		const { parentIno: i, name: n } = this.pathResolveParent(t), s = wn.encode(n), r = wn.encode(e);
		this.inodeWriteLock(i);
		try {
			if (this.dirLookup(i, s) >= 0) throw new mn(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new mn(-28);
			const t = this.inodeOffset(e);
			if (this.w32(t + 8, 41471), this.w32(t + hn, 1), r.length <= 40) this.u8.set(r, t + fn), this.w64(t + ln, r.length);
			else {
				this.w64(t + ln, 0);
				const i = this.inodeWriteData(e, 0, r, r.length);
				if (i < 0) throw this.inodeFree(e), new mn(i);
			}
			const n = this.dirAddEntry(i, s, e);
			if (n < 0) throw this.inodeFree(e), new mn(n);
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	chmod(e, t) {
		const i = this.pathResolve(e, !0);
		if (i < 0) throw new mn(i);
		this.inodeWriteLock(i);
		try {
			const e = this.inodeOffset(i), n = this.r32(e + 8);
			this.w32(e + 8, 61440 & n | 4095 & t), this.w64(e + dn, Date.now());
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	fchmod(e, t) {
		const i = this.fdGet(e);
		if (!i) throw new mn(-9);
		this.inodeWriteLock(i.ino);
		try {
			const e = this.inodeOffset(i.ino), n = this.r32(e + 8);
			this.w32(e + 8, 61440 & n | 4095 & t), this.w64(e + dn, Date.now());
		} finally {
			this.inodeWriteUnlock(i.ino);
		}
	}
	chown(e, t, i) {
		const n = this.pathResolve(e, !0);
		if (n < 0) throw new mn(n);
		this.inodeWriteLock(n);
		try {
			const e = this.inodeOffset(n);
			this.w32(e + 96, t), this.w32(e + un, i), this.w64(e + dn, Date.now());
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	fchown(e, t, i) {
		const n = this.fdGet(e);
		if (!n) throw new mn(-9);
		this.inodeWriteLock(n.ino);
		try {
			const e = this.inodeOffset(n.ino);
			this.w32(e + 96, t), this.w32(e + un, i), this.w64(e + dn, Date.now());
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	lchown(e, t, i) {
		const n = this.pathResolve(e, !1);
		if (n < 0) throw new mn(n);
		this.inodeWriteLock(n);
		try {
			const e = this.inodeOffset(n);
			this.w32(e + 96, t), this.w32(e + un, i), this.w64(e + dn, Date.now());
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	utimens(e, t, i, n, s) {
		const r = this.pathResolve(e, !0);
		if (r < 0) throw new mn(r);
		this.inodeWriteLock(r);
		try {
			const e = this.inodeOffset(r), o = 1073741823, a = 1073741822, c = Date.now();
			if (i !== a) {
				const n = i === o ? c : 1e3 * t + Math.floor(i / 1e6);
				this.w64(e + 40, n);
			}
			if (s !== a) {
				const t = s === o ? c : 1e3 * n + Math.floor(s / 1e6);
				this.w64(e + 24, t);
			}
			this.w64(e + dn, c);
		} finally {
			this.inodeWriteUnlock(r);
		}
	}
	link(e, t) {
		const i = this.pathResolve(e, !0);
		if (i < 0) throw new mn(i);
		const n = this.inodeOffset(i);
		if (16384 == (61440 & this.r32(n + 8))) throw new mn(-1);
		const { parentIno: s, name: r } = this.pathResolveParent(t), o = wn.encode(r);
		this.inodeWriteLock(s);
		try {
			if (this.dirLookup(s, o) >= 0) throw new mn(-17);
			const e = this.dirAddEntry(s, o, i);
			if (e < 0) throw new mn(e);
			this.inodeWriteLock(i);
			try {
				const e = this.r32(n + hn);
				this.w32(n + hn, e + 1), this.w64(n + dn, Date.now());
			} finally {
				this.inodeWriteUnlock(i);
			}
		} finally {
			this.inodeWriteUnlock(s);
		}
	}
	readlink(e) {
		const t = this.pathResolve(e, !1);
		if (t < 0) throw new mn(t);
		const i = this.inodeOffset(t);
		if (40960 != (61440 & this.r32(i + 8))) throw new mn(-22);
		const n = this.r64(i + ln);
		if (n <= 40) return kn(this.u8.subarray(i + fn, i + fn + n));
		this.inodeReadLock(t);
		try {
			const e = new Uint8Array(n);
			return this.inodeReadData(t, 0, e, n), yn.decode(e);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	opendir(e) {
		const t = this.pathResolve(e, !0);
		if (t < 0) throw new mn(t);
		const i = this.inodeOffset(t);
		if (16384 != (61440 & this.r32(i + 8))) throw new mn(-20);
		const n = this.fdAlloc(t, 0, !0);
		if (n < 0) throw new mn(n);
		return n;
	}
	readdirEntry(e) {
		const t = this.fdGet(e);
		if (!t || !t.isDir) throw new mn(-9);
		const i = this.inodeOffset(t.ino), n = this.r64(i + ln);
		for (; t.offset < n;) {
			const i = t.offset, n = Math.floor(i / on), s = i % on, r = this.inodeBlockMap(t.ino, n, !1);
			if (r <= 0) return null;
			const o = r * on + s, a = this.r32(o), c = this.view.getUint16(o + 4, !0), h = this.view.getUint16(o + 6, !0);
			if (0 === c) return null;
			t.offset = i + c;
			const l = 256 + 24 * e;
			if (this.w64(l + 8, i + c), 0 !== a) return {
				name: kn(this.u8.subarray(o + 8, o + 8 + h)),
				stat: this.buildStat(a)
			};
		}
		return null;
	}
	closedir(e) {
		this.close(e);
	}
	readdir(e) {
		const t = this.opendir(e), i = [];
		try {
			let e;
			for (; null !== (e = this.readdirEntry(t));) "." !== e.name && ".." !== e.name && i.push(e.name);
		} finally {
			this.closedir(t);
		}
		return i;
	}
	writeFile(e, t) {
		const i = "string" == typeof t ? wn.encode(t) : t, n = this.open(e, 577);
		try {
			this.write(n, i);
		} finally {
			this.close(n);
		}
	}
	readFile(e) {
		const t = this.open(e, 0);
		try {
			const e = this.fstat(t), i = new Uint8Array(e.size);
			return this.read(t, i), i;
		} finally {
			this.close(t);
		}
	}
	readFileText(e) {
		return yn.decode(this.readFile(e));
	}
};
const vn = [
	40,
	181,
	47,
	253
], xn = 1447449417, _n = 16, Pn = 65536;
function Bn(e) {
	if (!e || "object" != typeof e) throw new Error("VFS image metadata must be an object");
	if (1 !== e.version) throw new Error(`Unsupported VFS image metadata version: ${String(e.version)}`);
	if (void 0 !== e.kernelAbi && (!Number.isInteger(e.kernelAbi) || e.kernelAbi < 0)) throw new Error("VFS image metadata kernelAbi must be a non-negative integer");
	if (void 0 !== e.createdBy && "string" != typeof e.createdBy) throw new Error("VFS image metadata createdBy must be a string");
	return { ...e };
}
function An(e) {
	return e.byteLength >= vn.length && e[0] === vn[0] && e[1] === vn[1] && e[2] === vn[2] && e[3] === vn[3] ? function(e) {
		return rn(e);
	}(e) : e;
}
function Sn(e) {
	const t = An(e);
	if (t.byteLength < _n) throw new Error("VFS image too small");
	const i = new DataView(t.buffer, t.byteOffset, t.byteLength), n = i.getUint32(0, !0);
	if (n !== xn) throw new Error(`Bad VFS image magic: 0x${n.toString(16)} (expected 0x${xn.toString(16)})`);
	const s = i.getUint32(4, !0);
	if (1 !== s) throw new Error(`Unsupported VFS image version: ${s} (expected 1)`);
	const r = i.getUint32(8, !0), o = i.getUint32(12, !0);
	if (t.byteLength < _n + o + 4) throw new Error("VFS image truncated");
	return {
		image: t,
		view: i,
		flags: r,
		sabLen: o
	};
}
var En = class e {
	fs;
	imageMetadata;
	lazyFiles = /* @__PURE__ */ new Map();
	lazyArchiveGroups = [];
	lazyArchiveInodes = /* @__PURE__ */ new Map();
	constructor(e, t = null) {
		this.fs = e, this.imageMetadata = t;
	}
	get sharedBuffer() {
		return this.fs.buffer;
	}
	static create(t, i) {
		return new e(In.mkfs(t, i));
	}
	static fromExisting(t) {
		return new e(In.mount(t));
	}
	getImageMetadata() {
		return null === (e = this.imageMetadata) ? null : { ...e };
		var e;
	}
	setImageMetadata(e) {
		this.imageMetadata = null === e ? null : Bn(e);
	}
	registerLazyFile(e, t, i, n = 493) {
		const s = e.split("/").filter(Boolean);
		let r = "";
		for (let c = 0; c < s.length - 1; c++) {
			r += "/" + s[c];
			try {
				this.fs.mkdir(r, 493);
			} catch {}
		}
		const o = this.fs.open(e, 577, n);
		this.fs.close(o);
		const a = this.fs.stat(e);
		return this.lazyFiles.set(a.ino, {
			path: e,
			url: t,
			size: i
		}), a.ino;
	}
	importLazyEntries(e) {
		for (const t of e) this.lazyFiles.set(t.ino, {
			path: t.path,
			url: t.url,
			size: t.size
		});
	}
	exportLazyEntries() {
		const e = [];
		for (const [t, { path: i, url: n, size: s }] of this.lazyFiles) e.push({
			ino: t,
			path: i,
			url: n,
			size: s
		});
		return e;
	}
	getLazyEntry(e) {
		try {
			const t = this.fs.stat(e), i = this.lazyFiles.get(t.ino);
			return i ? {
				ino: t.ino,
				path: i.path,
				url: i.url,
				size: i.size
			} : null;
		} catch {
			return null;
		}
	}
	rewriteLazyFileUrls(e) {
		for (const [t, i] of this.lazyFiles) this.lazyFiles.set(t, {
			...i,
			url: e(i.url, i.path)
		});
	}
	registerLazyArchiveFromEntries(e, t, i, n) {
		const s = {
			url: e,
			mountPrefix: i,
			materialized: !1,
			entries: /* @__PURE__ */ new Map()
		}, r = i.replace(/\/+$/, "");
		for (const o of t) {
			if (o.isDirectory) continue;
			const e = r + "/" + o.fileName, t = e.split("/").filter(Boolean);
			let i = "";
			for (let n = 0; n < t.length - 1; n++) {
				i += "/" + t[n];
				try {
					this.fs.mkdir(i, 493);
				} catch {}
			}
			if (o.isSymlink && n?.has(o.fileName)) {
				const t = n.get(o.fileName);
				this.fs.symlink(t, e);
			} else {
				const t = this.fs.open(e, 577, o.mode);
				this.fs.close(t);
			}
			const a = this.fs.lstat(e), c = {
				ino: a.ino,
				size: o.uncompressedSize,
				isSymlink: o.isSymlink,
				deleted: !1
			};
			s.entries.set(e, c), this.lazyArchiveInodes.set(a.ino, s);
		}
		return this.lazyArchiveGroups.push(s), s;
	}
	importLazyArchiveEntries(e) {
		for (const t of e) {
			const e = /* @__PURE__ */ new Map();
			for (const n of t.entries) e.set(n.vfsPath, {
				ino: n.ino,
				size: n.size,
				isSymlink: n.isSymlink,
				deleted: n.deleted
			});
			const i = {
				url: t.url,
				mountPrefix: t.mountPrefix,
				materialized: t.materialized,
				entries: e
			};
			if (this.lazyArchiveGroups.push(i), !i.materialized) for (const [, t] of e) t.deleted || this.lazyArchiveInodes.set(t.ino, i);
		}
	}
	rewriteLazyArchiveUrls(e) {
		for (const t of this.lazyArchiveGroups) t.url = e(t.url);
	}
	exportLazyArchiveEntries() {
		return this.lazyArchiveGroups.map((e) => ({
			url: e.url,
			mountPrefix: e.mountPrefix,
			materialized: e.materialized,
			entries: Array.from(e.entries, ([e, t]) => ({
				vfsPath: e,
				ino: t.ino,
				size: t.size,
				isSymlink: t.isSymlink,
				deleted: t.deleted
			}))
		}));
	}
	async ensureMaterialized(e) {
		if (0 === this.lazyFiles.size && 0 === this.lazyArchiveInodes.size) return !1;
		try {
			const t = this.fs.stat(e), i = this.lazyFiles.get(t.ino);
			if (i) {
				const e = await fetch(i.url);
				if (!e.ok) throw new Error(`Failed to fetch lazy file ${i.path}: HTTP ${e.status}`);
				const n = new Uint8Array(await e.arrayBuffer()), s = this.fs.open(i.path, 577, 493);
				return this.fs.write(s, n), this.fs.close(s), this.lazyFiles.delete(t.ino), !0;
			}
			const n = this.lazyArchiveInodes.get(t.ino);
			return !!n && (await this.ensureArchiveMaterialized(n), !0);
		} catch {
			return !1;
		}
	}
	async ensureArchiveMaterialized(e) {
		if (e.materialized) return;
		const t = await fetch(e.url);
		if (!t.ok) throw new Error(`Failed to fetch archive ${e.url}: HTTP ${t.status}`);
		const i = new Uint8Array(await t.arrayBuffer()), { parseZipCentralDirectory: n, extractZipEntry: s } = await import("./zip-D1JNL24E.js"), r = n(i), o = /* @__PURE__ */ new Map();
		for (const c of r) o.set(c.fileName, c);
		const a = e.mountPrefix.replace(/\/+$/, "");
		for (const [c, h] of e.entries) {
			if (h.deleted) continue;
			if (h.isSymlink) continue;
			const e = c.slice(a.length + 1), t = o.get(e);
			if (!t) continue;
			const n = s(i, t), r = this.fs.open(c, 577, 493);
			n.length > 0 && this.fs.write(r, n), this.fs.close(r);
		}
		e.materialized = !0;
		for (const [, c] of e.entries) this.lazyArchiveInodes.delete(c.ino);
	}
	async saveImage(e) {
		if (e?.materializeAll) {
			const e = Array.from(this.lazyFiles.values()).map((e) => e.path);
			for (const t of e) await this.ensureMaterialized(t);
		}
		const t = new Uint8Array(this.fs.buffer), i = this.exportLazyEntries(), n = i.length > 0, s = n ? new TextEncoder().encode(JSON.stringify(i)) : new Uint8Array(0), r = this.exportLazyArchiveEntries(), o = r.length > 0, a = o ? new TextEncoder().encode(JSON.stringify(r)) : new Uint8Array(0), c = function(e) {
			if (null === e) return new Uint8Array(0);
			const t = Bn(e), i = new TextEncoder().encode(JSON.stringify(t));
			if (i.byteLength > Pn) throw new Error("VFS image metadata exceeds 65536 bytes");
			return i;
		}(void 0 === e?.metadata ? this.imageMetadata : e.metadata), h = c.byteLength > 0, l = o ? 4 + a.byteLength : 0, d = h ? 4 + c.byteLength : 0, f = _n + t.byteLength + 4 + s.byteLength + l + d, u = new Uint8Array(f), p = new DataView(u.buffer);
		p.setUint32(0, xn, !0), p.setUint32(4, 1, !0), p.setUint32(8, (n ? 1 : 0) | (o ? 2 : 0) | (h ? 4 : 0), !0), p.setUint32(12, t.byteLength, !0);
		const g = new Uint8Array(t.byteLength);
		g.set(t), u.set(g, _n);
		const m = _n + t.byteLength;
		if (p.setUint32(m, s.byteLength, !0), s.byteLength > 0 && u.set(s, m + 4), o) {
			const e = m + 4 + s.byteLength;
			p.setUint32(e, a.byteLength, !0), u.set(a, e + 4);
		}
		if (h) {
			const e = m + 4 + s.byteLength + l;
			p.setUint32(e, c.byteLength, !0), u.set(c, e + 4);
		}
		return u;
	}
	static readImageMetadata(e) {
		const t = Sn(e);
		if (!(4 & t.flags)) return null;
		const { metadataOffset: i } = function(e, t, i, n) {
			const s = _n + n, r = t.getUint32(s, !0), o = s + 4 + r;
			let a = o;
			if (2 & i) {
				if (e.byteLength < o + 4) throw new Error("VFS image truncated (lazy archive section)");
				a = o + 4 + t.getUint32(o, !0);
			}
			return {
				lazyLen: r,
				archiveOffset: o,
				metadataOffset: a
			};
		}(t.image, t.view, t.flags, t.sabLen);
		if (t.image.byteLength < i + 4) throw new Error("VFS image truncated (metadata section)");
		const n = t.view.getUint32(i, !0);
		if (n > Pn) throw new Error("VFS image metadata exceeds 65536 bytes");
		if (t.image.byteLength < i + 4 + n) throw new Error("VFS image truncated (metadata payload)");
		return 0 === n ? null : function(e) {
			if (e.byteLength > Pn) throw new Error("VFS image metadata exceeds 65536 bytes");
			let t;
			try {
				t = JSON.parse(new TextDecoder().decode(e));
			} catch (i) {
				const e = i instanceof Error ? i.message : String(i);
				throw new Error(`Invalid VFS image metadata JSON: ${e}`);
			}
			return Bn(t);
		}(t.image.subarray(i + 4, i + 4 + n));
	}
	static assertImageKernelAbi(t, i, n = "VFS image") {
		const s = e.readImageMetadata(t)?.kernelAbi;
		if (void 0 !== s && s !== i) throw new Error(`${n} requires kernel ABI ${s}, but the running kernel is ABI ${i}`);
	}
	static fromImage(t, i) {
		const n = Sn(t);
		t = n.image;
		const s = n.view, r = n.flags, o = n.sabLen, a = i?.maxByteLength ? { maxByteLength: i.maxByteLength } : void 0, c = new SharedArrayBuffer(o, a);
		new Uint8Array(c).set(t.subarray(_n, _n + o));
		let h = null;
		4 & r && (h = e.readImageMetadata(t));
		const l = new e(In.mount(c), h), d = _n + o, f = s.getUint32(d, !0);
		if (1 & r && f > 0) {
			const e = t.subarray(d + 4, d + 4 + f), i = JSON.parse(new TextDecoder().decode(e));
			l.importLazyEntries(i);
		}
		if (2 & r) {
			const e = d + 4 + f;
			if (t.byteLength < e + 4) throw new Error("VFS image truncated (lazy archive section)");
			const i = s.getUint32(e, !0);
			if (i > 0) {
				const n = t.subarray(e + 4, e + 4 + i), s = JSON.parse(new TextDecoder().decode(n));
				l.importLazyArchiveEntries(s);
			}
		}
		return l;
	}
	adaptStat(e) {
		return {
			dev: 0,
			ino: e.ino,
			mode: e.mode,
			nlink: e.linkCount,
			uid: e.uid,
			gid: e.gid,
			size: e.size,
			atimeMs: e.atime,
			mtimeMs: e.mtime,
			ctimeMs: e.ctime
		};
	}
	open(e, t, i) {
		return this.fs.open(e, t, i);
	}
	close(e) {
		return this.fs.close(e), 0;
	}
	read(e, t, i, n) {
		if (null !== i) {
			const s = this.fs.lseek(e, 0, 1);
			this.fs.lseek(e, i, 0);
			const r = this.fs.read(e, t.subarray(0, n));
			return this.fs.lseek(e, s, 0), r;
		}
		return this.fs.read(e, t.subarray(0, n));
	}
	write(e, t, i, n) {
		if (null !== i) {
			const s = this.fs.lseek(e, 0, 1);
			this.fs.lseek(e, i, 0);
			const r = this.fs.write(e, t.subarray(0, n));
			return this.fs.lseek(e, s, 0), r;
		}
		return this.fs.write(e, t.subarray(0, n));
	}
	seek(e, t, i) {
		return this.fs.lseek(e, t, i);
	}
	fstat(e) {
		const t = this.adaptStat(this.fs.fstat(e)), i = this.lazyFiles.get(t.ino);
		if (i) t.size = i.size;
		else {
			const e = this.lazyArchiveInodes.get(t.ino);
			if (e) {
				for (const i of e.entries.values()) if (i.ino === t.ino) {
					t.size = i.size;
					break;
				}
			}
		}
		return t;
	}
	ftruncate(e, t) {
		this.fs.ftruncate(e, t);
	}
	fsync(e) {}
	fchmod(e, t) {
		this.fs.fchmod(e, t);
	}
	fchown(e, t, i) {
		this.fs.fchown(e, t, i);
	}
	stat(e) {
		const t = this.adaptStat(this.fs.stat(e)), i = this.lazyFiles.get(t.ino);
		if (i) t.size = i.size;
		else {
			const e = this.lazyArchiveInodes.get(t.ino);
			if (e) {
				for (const i of e.entries.values()) if (i.ino === t.ino) {
					t.size = i.size;
					break;
				}
			}
		}
		return t;
	}
	lstat(e) {
		const t = this.adaptStat(this.fs.lstat(e)), i = this.lazyFiles.get(t.ino);
		if (i) t.size = i.size;
		else {
			const e = this.lazyArchiveInodes.get(t.ino);
			if (e) {
				for (const i of e.entries.values()) if (i.ino === t.ino) {
					t.size = i.size;
					break;
				}
			}
		}
		return t;
	}
	statfs(e) {
		this.fs.stat(e);
		const t = this.fs.statfs();
		return {
			type: 1397114451,
			bsize: t.blockSize,
			blocks: t.totalBlocks,
			bfree: t.freeBlocks,
			bavail: t.freeBlocks,
			files: t.totalInodes,
			ffree: t.freeInodes,
			fsid: 0,
			namelen: t.maxName,
			frsize: t.blockSize,
			flags: 0
		};
	}
	mkdir(e, t) {
		this.fs.mkdir(e, t);
	}
	rmdir(e) {
		this.fs.rmdir(e);
	}
	unlink(e) {
		if (this.lazyArchiveInodes.size > 0) try {
			const t = this.fs.lstat(e), i = this.lazyArchiveInodes.get(t.ino);
			if (i) {
				const n = i.entries.get(e);
				n && (n.deleted = !0), this.lazyArchiveInodes.delete(t.ino);
			}
		} catch {}
		this.fs.unlink(e);
	}
	rename(e, t) {
		this.fs.rename(e, t);
	}
	link(e, t) {
		this.fs.link(e, t);
	}
	symlink(e, t) {
		this.fs.symlink(e, t);
	}
	readlink(e) {
		return this.fs.readlink(e);
	}
	chmod(e, t) {
		this.fs.chmod(e, t);
	}
	chown(e, t, i) {
		this.fs.chown(e, t, i);
	}
	lchown(e, t, i) {
		this.fs.lchown(e, t, i);
	}
	createFileWithOwner(e, t, i, n, s) {
		const r = this.open(e, 577, t);
		s.length > 0 && this.write(r, s, null, s.length), this.close(r), this.chown(e, i, n), this.chmod(e, t);
	}
	mkdirWithOwner(e, t, i, n) {
		this.mkdir(e, t), this.chown(e, i, n), this.chmod(e, t);
	}
	symlinkWithOwner(e, t, i, n) {
		this.symlink(e, t), this.lchown(t, i, n);
	}
	access(e, t) {
		this.fs.stat(e);
	}
	utimensat(e, t, i, n, s) {
		this.fs.utimens(e, t, i, n, s);
	}
	opendir(e) {
		return this.fs.opendir(e);
	}
	readdir(e) {
		const t = this.fs.readdirEntry(e);
		if (!t) return null;
		const i = t.stat.mode;
		let n = 0;
		return 32768 == (61440 & i) ? n = 8 : 16384 == (61440 & i) ? n = 4 : 40960 == (61440 & i) && (n = 10), {
			name: t.name,
			type: n,
			ino: t.stat.ino
		};
	}
	closedir(e) {
		this.fs.closedir(e);
	}
};
var Mn = class {
	clockGettime(e) {
		if (1 === e || 2 === e || 3 === e) {
			const e = performance.now();
			return {
				sec: Math.floor(e / 1e3),
				nsec: Math.floor(e % 1e3 * 1e6)
			};
		}
		const t = Date.now();
		return {
			sec: Math.floor(t / 1e3),
			nsec: t % 1e3 * 1e6
		};
	}
	nanosleep(e, t) {
		const i = 1e3 * e + Math.floor(t / 1e6);
		if (i > 0) {
			const e = new SharedArrayBuffer(4);
			Atomics.wait(new Int32Array(e), 0, 0, i);
		}
	}
};
const Un = [
	{
		path: "/",
		source: "image",
		readonly: !0
	},
	{
		path: "/tmp",
		source: "scratch",
		mode: 1023,
		ephemeral: !0
	},
	{
		path: "/var/tmp",
		source: "scratch",
		mode: 1023
	},
	{
		path: "/var/log",
		source: "scratch",
		mode: 493
	},
	{
		path: "/var/run",
		source: "scratch",
		mode: 493,
		ephemeral: !0
	},
	{
		path: "/home/user",
		source: "scratch",
		mode: 493,
		uid: 1e3,
		gid: 1e3
	},
	{
		path: "/root",
		source: "scratch",
		mode: 448,
		uid: 0,
		gid: 0
	},
	{
		path: "/srv",
		source: "scratch",
		mode: 493
	}
];
function Cn(e) {
	const t = function(e, t) {
		let i = null;
		try {
			const n = e.stat(t);
			i = e.open(t, 0, 0);
			const s = new Uint8Array(n.size);
			let r = 0;
			for (; r < s.byteLength;) {
				const t = e.read(i, s.subarray(r), null, s.byteLength - r);
				if (t <= 0) break;
				r += t;
			}
			return new TextDecoder().decode(s.subarray(0, r));
		} catch {
			return null;
		} finally {
			if (null !== i) try {
				e.close(i);
			} catch {}
		}
	}(e, "/etc/group");
	null === t || /^nobody:/m.test(t) || function(e, t, i) {
		const n = new TextEncoder().encode(i), s = e.open(t, 577, 420);
		try {
			n.byteLength > 0 && e.write(s, n, null, n.byteLength);
		} finally {
			e.close(s);
		}
	}(e, "/etc/group", `${t.replace(/\n?$/, "\n")}nobody:x:65534:\n`);
}
function zn(e, t, i = {}) {
	(function(e) {
		const t = /* @__PURE__ */ new Set();
		for (const i of e) {
			if ("string" != typeof i.path || 0 === i.path.length) throw new Error("MountSpec: empty path");
			if (!i.path.startsWith("/")) throw new Error(`MountSpec: path must be absolute: ${i.path}`);
			if ("/" !== i.path && i.path.endsWith("/")) throw new Error(`MountSpec: trailing slash on non-root path: ${i.path}`);
			const e = i.path.split("/");
			for (const t of e) if ("." === t || ".." === t) throw new Error(`MountSpec: path contains "${t}" segment: ${i.path}`);
			if (t.has(i.path)) throw new Error(`MountSpec: duplicate mount path: ${i.path}`);
			t.add(i.path);
		}
	})(e);
	const n = [];
	for (const s of e) if ("image" === s.source) {
		const e = En.fromImage(t, { maxByteLength: 1073741824 });
		Cn(e), n.push({
			mountPoint: s.path,
			backend: e,
			readonly: s.readonly
		});
	} else {
		const e = i.scratchSabBytes?.[s.path] ?? 16777216, t = new SharedArrayBuffer(e), r = En.create(t);
		void 0 !== s.mode && r.chmod("/", s.mode), void 0 === s.uid && void 0 === s.gid || r.chown("/", s.uid ?? 0, s.gid ?? 0), n.push({
			mountPoint: s.path,
			backend: r,
			readonly: s.readonly
		});
	}
	return n;
}
var Tn = class {
	mounts;
	time;
	fileHandles = /* @__PURE__ */ new Map();
	dirHandles = /* @__PURE__ */ new Map();
	nextFileHandle = 100;
	nextDirHandle = 1;
	network;
	constructor(e, t) {
		if (this.mounts = e.map((e) => {
			return {
				prefix: (t = e.mountPoint, "/" !== t && t.endsWith("/") ? t.slice(0, -1) : t),
				backend: e.backend
			};
			var t;
		}).sort((e, t) => t.prefix.length - e.prefix.length), this.time = t, 0 === this.mounts.length) throw new Error("VirtualPlatformIO requires at least one mount");
	}
	resolve(e) {
		for (const t of this.mounts) {
			if ("/" === t.prefix) return {
				backend: t.backend,
				relativePath: e
			};
			if (e === t.prefix || e.startsWith(t.prefix + "/")) {
				let i = e.slice(t.prefix.length);
				return i.startsWith("/") || (i = "/" + i), {
					backend: t.backend,
					relativePath: i
				};
			}
		}
		throw new Error(`ENOENT: no mount for path: ${e}`);
	}
	resolveTwoPaths(e, t) {
		const i = this.resolve(e), n = this.resolve(t);
		if (i.backend !== n.backend) throw new Error("EXDEV: cross-device link");
		return {
			backend: i.backend,
			rel1: i.relativePath,
			rel2: n.relativePath
		};
	}
	getFileHandle(e) {
		const t = this.fileHandles.get(e);
		if (!t) throw new Error(`EBADF: invalid file handle ${e}`);
		return t;
	}
	getDirHandle(e) {
		const t = this.dirHandles.get(e);
		if (!t) throw new Error(`EBADF: invalid dir handle ${e}`);
		return t;
	}
	open(e, t, i) {
		const { backend: n, relativePath: s } = this.resolve(e), r = n.open(s, t, i), o = this.nextFileHandle++;
		return this.fileHandles.set(o, {
			backend: n,
			localHandle: r
		}), o;
	}
	close(e) {
		const t = this.getFileHandle(e), i = t.backend.close(t.localHandle);
		return this.fileHandles.delete(e), i;
	}
	read(e, t, i, n) {
		const s = this.getFileHandle(e);
		return s.backend.read(s.localHandle, t, i, n);
	}
	write(e, t, i, n) {
		const s = this.getFileHandle(e);
		return s.backend.write(s.localHandle, t, i, n);
	}
	seek(e, t, i) {
		const n = this.getFileHandle(e);
		return n.backend.seek(n.localHandle, t, i);
	}
	fstat(e) {
		const t = this.getFileHandle(e);
		return t.backend.fstat(t.localHandle);
	}
	ftruncate(e, t) {
		const i = this.getFileHandle(e);
		i.backend.ftruncate(i.localHandle, t);
	}
	fsync(e) {
		const t = this.getFileHandle(e);
		t.backend.fsync(t.localHandle);
	}
	fchmod(e, t) {
		const i = this.getFileHandle(e);
		i.backend.fchmod(i.localHandle, t);
	}
	fchown(e, t, i) {
		const n = this.getFileHandle(e);
		n.backend.fchown(n.localHandle, t, i);
	}
	stat(e) {
		const { backend: t, relativePath: i } = this.resolve(e);
		return t.stat(i);
	}
	lstat(e) {
		const { backend: t, relativePath: i } = this.resolve(e);
		return t.lstat(i);
	}
	statfs(e) {
		const { backend: t, relativePath: i } = this.resolve(e);
		return t.statfs(i);
	}
	mkdir(e, t) {
		const { backend: i, relativePath: n } = this.resolve(e);
		i.mkdir(n, t);
	}
	rmdir(e) {
		const { backend: t, relativePath: i } = this.resolve(e);
		t.rmdir(i);
	}
	unlink(e) {
		const { backend: t, relativePath: i } = this.resolve(e);
		t.unlink(i);
	}
	rename(e, t) {
		const { backend: i, rel1: n, rel2: s } = this.resolveTwoPaths(e, t);
		i.rename(n, s);
	}
	link(e, t) {
		const { backend: i, rel1: n, rel2: s } = this.resolveTwoPaths(e, t);
		i.link(n, s);
	}
	symlink(e, t) {
		const { backend: i, relativePath: n } = this.resolve(t);
		i.symlink(e, n);
	}
	readlink(e) {
		const { backend: t, relativePath: i } = this.resolve(e);
		return t.readlink(i);
	}
	chmod(e, t) {
		const { backend: i, relativePath: n } = this.resolve(e);
		i.chmod(n, t);
	}
	chown(e, t, i) {
		const { backend: n, relativePath: s } = this.resolve(e);
		n.chown(s, t, i);
	}
	access(e, t) {
		const { backend: i, relativePath: n } = this.resolve(e);
		i.access(n, t);
	}
	utimensat(e, t, i, n, s) {
		const { backend: r, relativePath: o } = this.resolve(e);
		r.utimensat(o, t, i, n, s);
	}
	opendir(e) {
		const { backend: t, relativePath: i } = this.resolve(e), n = t.opendir(i), s = this.nextDirHandle++;
		return this.dirHandles.set(s, {
			backend: t,
			localHandle: n
		}), s;
	}
	readdir(e) {
		const t = this.getDirHandle(e);
		return t.backend.readdir(t.localHandle);
	}
	closedir(e) {
		const t = this.getDirHandle(e);
		t.backend.closedir(t.localHandle), this.dirHandles.delete(e);
	}
	clockGettime(e) {
		return this.time.clockGettime(e);
	}
	nanosleep(e, t) {
		this.time.nanosleep(e, t);
	}
};
if (void 0 === globalThis.setImmediate) {
	const e = [], t = /* @__PURE__ */ new Set(), i = new MessageChannel();
	let n = 0, s = !1, r = !1;
	i.port1.onmessage = () => {
		s = !1, r = !0;
		const n = e.length;
		for (let i = 0; i < n && e.length > 0; i++) {
			const i = e.shift();
			t.delete(i.id) || i.fn(...i.args);
		}
		r = !1, e.length > 0 && !s && (s = !0, i.port2.postMessage(null));
	}, globalThis.setImmediate = (t, ...o) => {
		const a = ++n;
		return e.push({
			id: a,
			fn: t,
			args: o
		}), s || r || (s = !0, i.port2.postMessage(null)), a;
	}, globalThis.clearImmediate = (e) => {
		t.add(e);
	};
}
const On = 16384, Rn = new TextEncoder(), $n = new TextDecoder();
let Nn = null, Wn = !1;
function Fn(e) {
	self.postMessage(e);
}
function Ln(e, t) {
	Fn({
		type: "machine",
		machine: e,
		status: t
	});
}
function Dn(e, t) {
	Fn({
		type: "step",
		step: e,
		status: t
	});
}
function Kn(e, t, i) {
	0 !== i.length && Fn({
		type: "log",
		machine: e,
		stream: t,
		text: i
	});
}
function Vn(e, t, i, n) {
	Fn({
		type: "result",
		step: e,
		title: t,
		ok: i,
		detail: n
	});
}
async function Hn(e) {
	const t = await fetch(e);
	if (!t.ok) throw new Error(`failed to fetch ${e}: ${t.status}`);
	return t.arrayBuffer();
}
async function qn(e, t, i) {
	const n = /* @__PURE__ */ new Map(), s = De(i.programBytes), r = 100;
	let o = "", a = "", c = !1;
	Ln(i.machine, `running ${i.programName}`);
	const h = function(e, t, i, n) {
		const s = new Tn([
			{
				mountPoint: "/dev/shm",
				backend: En.create(new SharedArrayBuffer(1048576))
			},
			{
				mountPoint: "/dev",
				backend: new Ci()
			},
			...zn(Un, t)
		], new Mn());
		return s.network = e.attachMachine({
			id: i,
			address: n,
			hostnames: [i]
		}), s;
	}(e, t.rootfs, i.machine, i.address), l = new pi("/kandelo/assets/worker-entry-browser-BhKbSama.js");
	let d, f;
	const u = new Promise((e, t) => {
		d = e, f = t;
	}), p = new ui({
		maxWorkers: 4,
		dataBufferSize: 65536,
		useSharedMemory: !0
	}, h, {
		onExit: (e, t) => {
			c || e === r && (c = !0, p.unregisterProcess(e), n.get(e)?.terminate().catch(() => {}), n.delete(e), d(t));
		},
		onExitGroup: (e) => {
			n.get(e)?.terminate().catch(() => {}), n.delete(e);
		}
	});
	p.usePolling = !1, p.relistenBatchSize = 8, p.setOutputCallbacks({
		onStdout: (e) => {
			const t = $n.decode(e);
			o += t, Kn(i.machine, "stdout", t);
		},
		onStderr: (e) => {
			const t = $n.decode(e);
			a += t, Kn(i.machine, "stderr", t);
		}
	}), await p.init(t.kernel);
	const g = function(e, t = 17) {
		return 8 === e ? new WebAssembly.Memory({
			initial: BigInt(t),
			maximum: BigInt(On),
			shared: !0,
			address: "i64"
		}) : new WebAssembly.Memory({
			initial: t,
			maximum: On,
			shared: !0
		});
	}(s), m = 1073610752;
	(function(e, t, i) {
		const n = On - i;
		n <= 0 || (8 === t ? e.grow(BigInt(n)) : e.grow(n));
	})(g, s, 17), new Uint8Array(g.buffer, m, 65608).fill(0), p.registerProcess(r, g, [m], {
		argv: i.argv,
		ptrWidth: s
	});
	const w = function(e) {
		const t = new Uint8Array(e);
		if (t.length < 8) return null;
		let i = 0, n = 0, s = null, r = null, o = 8;
		for (; o < t.length;) {
			const e = t[o], [a, c] = Ne(t, o + 1), h = o + 1 + c;
			if (2 === e) {
				const e = {
					funcImports: n,
					globalImports: i
				};
				let s = h;
				const [r, o] = Ne(t, s);
				s += o;
				for (let i = 0; i < r; i++) s = We(t, s, e);
				n = e.funcImports, i = e.globalImports;
			} else if (6 === e) r = {
				offset: h,
				size: a
			};
			else if (7 === e) {
				let e = h;
				const [i, n] = Ne(t, e);
				e += n;
				for (let r = 0; r < i; r++) {
					const [i, n] = Ne(t, e);
					e += n;
					const r = new TextDecoder().decode(t.subarray(e, e + i));
					e += i;
					const o = t[e++], [a, c] = Ne(t, e);
					if (e += c, 3 === o && "__heap_base" === r) {
						s = a;
						break;
					}
				}
				if (null === s) return null;
				if (null === r) return null;
				break;
			}
			o = h + a;
		}
		if (null === s || null === r) return null;
		const a = s - i;
		if (a < 0) return null;
		let c = r.offset;
		const [h, l] = Ne(t, c);
		if (c += l, a >= h) return null;
		for (let d = 0; d < a; d++) c = Le(t, c);
		return Fe(t, c);
	}(i.programBytes);
	null !== w && p.setBrkBase(r, w), void 0 !== i.stdin && p.setStdinData(r, Rn.encode(i.stdin));
	const y = {
		type: "centralized_init",
		pid: r,
		ppid: 0,
		programBytes: i.programBytes,
		memory: g,
		channelOffset: m,
		argv: i.argv,
		ptrWidth: s
	}, k = l.createWorker(y);
	n.set(r, k);
	const b = i.timeoutMs ?? 15e3, I = setTimeout(() => {
		if (!c) {
			c = !0;
			for (const e of n.values()) e.terminate().catch(() => {});
			n.clear(), f(/* @__PURE__ */ new Error(`${i.machine} ${i.programName} timed out after ${b}ms`));
		}
	}, b);
	k.on("error", (e) => {
		c || (c = !0, clearTimeout(I), f(e));
	}), k.on("message", (e) => {
		const t = e;
		"error" !== t.type || t.pid !== r || c || (c = !0, clearTimeout(I), f(new Error(t.message)));
	});
	try {
		const e = await u;
		return clearTimeout(I), Ln(i.machine, 0 === e ? "passed" : `failed ${e}`), {
			exitCode: e,
			stdout: o,
			stderr: a
		};
	} finally {
		clearTimeout(I);
		for (const e of n.values()) e.terminate().catch(() => {});
		n.clear(), e.detachMachine(i.machine);
	}
}
function Gn(e) {
	return new Promise((t) => setTimeout(t, e));
}
function jn(e) {
	return e.map((e) => e.includes(" ") ? JSON.stringify(e) : e).join(" ");
}
async function Xn(e, t) {
	Dn("udp", "running");
	const i = [
		"nc",
		"-n",
		"-c",
		"-u",
		"-l",
		"-p",
		String(24126),
		"-w",
		"3"
	], n = [
		"nc",
		"-n",
		"-u",
		"-c",
		"10.88.0.2",
		String(24126)
	];
	Kn("runner", "system", `UDP alpha: ${jn(i)}\nUDP beta: ${jn(n)}`), Kn("beta", "stdin", "hello from beta over udp\n");
	const s = qn(e, t, {
		machine: "alpha",
		address: [
			10,
			88,
			0,
			2
		],
		programName: "nc udp listen",
		programBytes: t.nc,
		argv: i,
		stdin: ""
	});
	await Gn(100);
	const r = qn(e, t, {
		machine: "beta",
		address: [
			10,
			88,
			0,
			3
		],
		programName: "nc udp send",
		programBytes: t.nc,
		argv: n,
		stdin: "hello from beta over udp\n"
	}), [o, a] = await Promise.all([s, r]), c = 0 === o.exitCode && 0 === a.exitCode && o.stdout.includes("hello from beta over udp");
	return Dn("udp", c ? "passed" : "failed"), Vn("udp", "UDP datagram", c, c ? "alpha received beta's datagram through POSIX recv/read on a UDP socket." : `server=${o.exitCode}, client=${a.exitCode}`), c;
}
async function Yn(e, t) {
	Dn("tcp", "running");
	const i = [
		"nc",
		"-n",
		"-l",
		"-p",
		String(24125),
		"-w",
		"3"
	], n = [
		"nc",
		"-n",
		"-c",
		"10.88.0.2",
		String(24125)
	];
	Kn("runner", "system", `TCP alpha: ${jn(i)}\nTCP beta: ${jn(n)}`), Kn("beta", "stdin", "hello from beta over tcp\n");
	const s = qn(e, t, {
		machine: "alpha",
		address: [
			10,
			88,
			0,
			2
		],
		programName: "nc tcp listen",
		programBytes: t.nc,
		argv: i,
		stdin: ""
	});
	await Gn(100);
	const r = qn(e, t, {
		machine: "beta",
		address: [
			10,
			88,
			0,
			3
		],
		programName: "nc tcp send",
		programBytes: t.nc,
		argv: n,
		stdin: "hello from beta over tcp\n"
	}), [o, a] = await Promise.all([s, r]), c = 0 === o.exitCode && 0 === a.exitCode && o.stdout.includes("hello from beta over tcp");
	return Dn("tcp", c ? "passed" : "failed"), Vn("tcp", "TCP stream", c, c ? "alpha accepted beta's TCP connection and received stream data." : `server=${o.exitCode}, client=${a.exitCode}`), c;
}
async function Jn(e, t) {
	Dn("curl", "running");
	const i = "hello from alpha via curl\n", n = [
		"HTTP/1.0 200 OK",
		"Content-Type: text/plain",
		`Content-Length: ${Rn.encode(i).length}`,
		"Connection: close",
		"",
		i
	].join("\r\n"), s = [
		"nc",
		"-n",
		"-l",
		"-p",
		String(18080),
		"-w",
		"5"
	], r = [
		"curl",
		"-sS",
		"--max-time",
		"4",
		"http://10.88.0.2:18080/"
	];
	Kn("runner", "system", `HTTP alpha: ${jn(s)}\nHTTP gamma: ${jn(r)}`), Kn("runner", "system", `HTTP alpha stdin: generated ${Rn.encode(n).length} byte response\n`), Kn("alpha", "stdin", `${n.replaceAll("\r\n", "\n")}`);
	const o = qn(e, t, {
		machine: "alpha",
		address: [
			10,
			88,
			0,
			2
		],
		programName: "nc http listen",
		programBytes: t.nc,
		argv: s,
		stdin: n,
		timeoutMs: 2e4
	});
	await Gn(100);
	const a = qn(e, t, {
		machine: "gamma",
		address: [
			10,
			88,
			0,
			4
		],
		programName: "curl",
		programBytes: t.curl,
		argv: r,
		timeoutMs: 2e4
	}), [c, h] = await Promise.all([o, a]), l = 0 === c.exitCode && 0 === h.exitCode && h.stdout.includes(i);
	return Dn("curl", l ? "passed" : "failed"), Vn("curl", "curl over TCP", l, l ? "gamma fetched alpha's HTTP response through curl over the virtual TCP backend." : `server=${c.exitCode}, curl=${h.exitCode}`), l;
}
async function Zn() {
	if (!Wn) {
		Wn = !0, Fn({
			type: "status",
			status: "loading artifacts"
		});
		try {
			const e = await async function() {
				return Nn || (Nn = Promise.all([
					Hn("/kandelo/assets/kernel-CXJRS9z5.wasm"),
					Hn("/kandelo/assets/rootfs-ur3ZNyNa.vfs"),
					Hn("/kandelo/assets/nc-CGHkR-Fh.wasm"),
					Hn("/kandelo/assets/curl-BT_Xh_vR.wasm")
				]).then(([e, t, i, n]) => ({
					kernel: e,
					rootfs: new Uint8Array(t),
					nc: i,
					curl: n
				}))), Nn;
			}();
			Fn({
				type: "status",
				status: "running"
			});
			const t = new _i();
			Kn("runner", "system", "Virtual addresses: alpha=10.88.0.2 beta=10.88.0.3 gamma=10.88.0.4\n"), Fn({
				type: "done",
				ok: [
					await Xn(t, e),
					await Yn(t, e),
					await Jn(t, e)
				].every(Boolean)
			});
		} catch (e) {
			Fn({
				type: "error",
				message: e instanceof Error ? e.message : String(e)
			});
		} finally {
			Wn = !1;
		}
	}
}
self.onmessage = (e) => {
	"run" === e.data.type && Zn();
}, Fn({ type: "ready" });
export { o as t };
