var e = Object.create, t = Object.defineProperty, n = Object.getOwnPropertyDescriptor, r = Object.getOwnPropertyNames, i = Object.getPrototypeOf, s = Object.prototype.hasOwnProperty, o = (e, t) => () => (t || (e((t = { exports: {} }).exports, t), e = null), t.exports), a = (o, a, c) => (c = null != o ? e(i(o)) : {}, ((e, i, o, a) => {
	if (i && "object" == typeof i || "function" == typeof i) for (var c, l = r(i), h = 0, d = l.length; h < d; h++) c = l[h], s.call(e, c) || c === o || t(e, c, {
		get: ((e) => i[e]).bind(null, c),
		enumerable: !(a = n(i, c)) || a.enumerable
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
		const n = new e(new SharedArrayBuffer(16 + t), t);
		return Atomics.store(n.meta, 0, 0), Atomics.store(n.meta, 1, 0), Atomics.store(n.meta, 2, 0), Atomics.store(n.meta, 3, 3), n;
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
		const t = Atomics.load(this.meta, 2), n = this.cap - t, r = Math.min(e.length, n);
		if (0 === r) return 0;
		let i = Atomics.load(this.meta, 1);
		for (let s = 0; s < r; s++) this.data[i] = e[s], i = (i + 1) % this.cap;
		return Atomics.store(this.meta, 1, i), Atomics.add(this.meta, 2, r), r;
	}
	read(e) {
		const t = Atomics.load(this.meta, 2), n = Math.min(e.length, t);
		if (0 === n) return 0;
		let r = Atomics.load(this.meta, 0);
		for (let i = 0; i < n; i++) e[i] = this.data[r], r = (r + 1) % this.cap;
		return Atomics.store(this.meta, 0, r), Atomics.sub(this.meta, 2, n), n;
	}
	closeRead() {
		Atomics.and(this.meta, 3, -2);
	}
	closeWrite() {
		Atomics.and(this.meta, 3, -3);
	}
};
var l = class e {
	view;
	sab;
	constructor(e) {
		this.sab = e, this.view = new Int32Array(e);
	}
	static create(t = 256) {
		const n = new e(new SharedArrayBuffer(16 + 8 * t * 4));
		return Atomics.store(n.view, 0, 0), Atomics.store(n.view, 1, 0), Atomics.store(n.view, 2, t), Atomics.store(n.view, 3, 0), n;
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
		const n = this.entryBase(e);
		this.view[n + 0] = t.pathHash, this.view[n + 1] = t.pid, this.view[n + 2] = t.lockType, this.view[n + 3] = 0;
		const [r, i] = this.i64ToParts(t.start);
		this.view[n + 4] = r, this.view[n + 5] = i;
		const [s, o] = this.i64ToParts(t.len);
		this.view[n + 6] = s, this.view[n + 7] = o;
	}
	removeEntryUnsafe(e) {
		const t = this.view[1];
		if (e < t - 1) {
			const n = this.entryBase(t - 1), r = this.entryBase(e);
			for (let e = 0; e < 8; e++) this.view[r + e] = this.view[n + e];
		}
		this.view[1] = t - 1;
	}
	i64FromParts(e, t) {
		return BigInt(t) << 32n | BigInt(e >>> 0);
	}
	i64ToParts(e) {
		return [Number(4294967295n & e), Number(e >> 32n & 4294967295n)];
	}
	static rangesOverlap(e, t, n, r) {
		const i = 0n === t ? BigInt("0x7fffffffffffffff") : e + t;
		return e < (0n === r ? BigInt("0x7fffffffffffffff") : n + r) && n < i;
	}
	static conflicts(t, n, r, i, s) {
		return t.pid !== s && !!e.rangesOverlap(t.start, t.len, r, i) && (0 !== t.lockType || 0 !== n);
	}
	getBlockingLock(e, t, n, r, i) {
		this.acquire();
		try {
			return this._getBlockingLockUnsafe(e, t, n, r, i);
		} finally {
			this.release();
		}
	}
	_getBlockingLockUnsafe(t, n, r, i, s) {
		const o = this.view[1];
		for (let a = 0; a < o; a++) {
			const o = this.readEntry(a);
			if (o.pathHash === t && e.conflicts(o, n, r, i, s)) return o;
		}
		return null;
	}
	setLock(e, t, n, r, i) {
		this.acquire();
		try {
			return this._setLockUnsafe(e, t, n, r, i);
		} finally {
			this.release();
		}
	}
	_setLockUnsafe(t, n, r, i, s) {
		if (2 === r) {
			let r = 0;
			for (; r < this.view[1];) {
				const o = this.readEntry(r);
				o.pathHash === t && o.pid === n && e.rangesOverlap(o.start, o.len, i, s) ? this.removeEntryUnsafe(r) : r++;
			}
			return Atomics.add(this.view, 3, 1), Atomics.notify(this.view, 3), !0;
		}
		if (this._getBlockingLockUnsafe(t, r, i, s, n)) return !1;
		let o = 0;
		for (; o < this.view[1];) {
			const r = this.readEntry(o);
			r.pathHash === t && r.pid === n && e.rangesOverlap(r.start, r.len, i, s) ? this.removeEntryUnsafe(o) : o++;
		}
		const a = this.view[1];
		return !(a >= this.view[2]) && (this.writeEntry(a, {
			pathHash: t,
			pid: n,
			lockType: r,
			start: i,
			len: s
		}), this.view[1] = a + 1, !0);
	}
	setLockWait(e, t, n, r, i) {
		for (;;) {
			if (this.acquire(), !this._getBlockingLockUnsafe(e, n, r, i, t)) return this._setLockUnsafe(e, t, n, r, i), void this.release();
			const s = Atomics.load(this.view, 3);
			this.release(), Atomics.wait(this.view, 3, s, 5e3);
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
		for (let n = 0; n < e.length; n++) t ^= e.charCodeAt(n), t = Math.imul(t, 16777619);
		return 0 | t;
	}
}, h = class {
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
		for (const n of this.listeners) n(e.pid, "bind");
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
	fbWrite(e, t, n) {
		const r = this.bindings.get(e);
		if (r?.hostBuffer) {
			const e = Math.min(t + n.length, r.hostBuffer.length);
			e > t && r.hostBuffer.set(n.subarray(0, e - t), t);
		}
		for (const i of this.writeListeners) i(e, t, n);
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
	"kernel_set_mode",
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
}, g = 65536, m = 65608, _ = 65560, y = 211, w = 212, S = 213, k = 500, b = 386, A = 1, I = 2, C = 3, E = 4, v = 6, x = 10, T = 11, P = 12, B = 19, H = 22, U = 24, M = 25, L = 34, R = 35, W = 41, D = 46, K = 47, O = 48, z = 53, N = 54, $ = 55, F = 56, V = 60, q = 62, G = 63, j = 64, Y = 65, X = 68, J = 69, Z = 72, Q = 81, ee = 82, te = 90, ne = 92, re = 93, ie = 97, se = 102, oe = 103, ae = 109, ce = 124, le = 126, he = 137, de = 138, fe = 139, ue = 200, pe = 201, ge = 207, me = 239, _e = 240, ye = 241, we = 251, Se = 252, ke = 278, be = 288, Ae = 294, Ie = 295, Ce = 296, Ee = 333, ve = 334, xe = 343, Te = 345, Pe = 346, Be = 378, He = 379, Ue = 384, Me = 387, Le = 415, Re = {
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
}, We = 65536;
function De(e, t) {
	let n = 0, r = 0, i = t;
	for (;;) {
		const t = e[i++];
		if (n |= (127 & t) << r, !(128 & t)) break;
		r += 7;
	}
	return [n, i - t];
}
function Ke(e, t) {
	let n = 0, r = 0, i = t, s = 0;
	for (; s = e[i++], n |= (127 & s) << r, r += 7, 128 & s;);
	return r < 32 && 64 & s && (n |= -1 << r), [n, i - t];
}
function Oe(e, t) {
	let n = 0n, r = 0n, i = t, s = 0;
	for (; s = e[i++], n |= BigInt(127 & s) << r, r += 7n, 128 & s;);
	return r < 64n && 64 & s && (n |= -1n << r), [n, i - t];
}
function ze(e, t) {
	const n = e[t];
	if (64 === n || 127 === n || 126 === n || 125 === n || 124 === n || 123 === n || 112 === n || 111 === n) return t + 1;
	const [, r] = Ke(e, t);
	return t + r;
}
function Ne(e, t) {
	const [, n] = De(e, t);
	t += n;
	const [, r] = De(e, t);
	return t + r;
}
function $e(e, t, n) {
	const [r, i] = De(t, n);
	if (n += i, 252 === e) switch (r) {
		case 0:
		case 1:
		case 2:
		case 3:
		case 4:
		case 5:
		case 6:
		case 7: return n;
		case 8: {
			const [, e] = De(t, n);
			n += e;
			const [, r] = De(t, n);
			return n + r;
		}
		case 9: {
			const [, e] = De(t, n);
			return n + e;
		}
		case 10: {
			const [, e] = De(t, n);
			n += e;
			const [, r] = De(t, n);
			return n + r;
		}
		case 11: {
			const [, e] = De(t, n);
			return n + e;
		}
		case 12: {
			const [, e] = De(t, n);
			n += e;
			const [, r] = De(t, n);
			return n + r;
		}
		case 13: {
			const [, e] = De(t, n);
			return n + e;
		}
		case 14: {
			const [, e] = De(t, n);
			n += e;
			const [, r] = De(t, n);
			return n + r;
		}
		case 15:
		case 16:
		case 17: {
			const [, e] = De(t, n);
			return n + e;
		}
		default: return null;
	}
	return 253 === e ? 12 === r || 13 === r ? n + 16 : r >= 21 && r <= 34 ? Ne(t, n) : 84 === r || r >= 92 && r <= 99 || r >= 112 && r <= 123 || r >= 124 && r <= 131 || r >= 156 && r <= 159 ? n + 1 : n : 254 === e ? 0 === r || 1 === r || 2 === r ? Ne(t, n) : 3 === r ? n : r >= 16 && r <= 79 ? Ne(t, n) : null : null;
}
function Fe(e, t, n) {
	const [r, i] = De(e, t);
	t += i + r;
	const [s, o] = De(e, t);
	t += o + s;
	const a = e[t++];
	if (0 === a) {
		n.funcImports++;
		const [, r] = De(e, t);
		t += r;
	} else if (1 === a) {
		t++;
		const n = e[t++], [, r] = De(e, t);
		if (t += r, 1 & n) {
			const [, n] = De(e, t);
			t += n;
		}
	} else if (2 === a) {
		const n = e[t++], [, r] = De(e, t);
		if (t += r, 1 & n) {
			const [, n] = De(e, t);
			t += n;
		}
	} else 3 === a && (n.globalImports++, t += 2);
	return t;
}
function Ve(e, t) {
	for (t += 2; 11 !== e[t];) t++;
	return t + 1;
}
function qe(e) {
	const t = new Uint8Array(e);
	if (t.length < 8) return null;
	let n = 0, r = 0, i = null, s = null, o = 8;
	for (; o < t.length;) {
		const e = t[o], [a, c] = De(t, o + 1), l = o + 1 + c;
		if (2 === e) {
			const e = {
				funcImports: r,
				globalImports: n
			};
			let i = l;
			const [s, o] = De(t, i);
			i += o;
			for (let n = 0; n < s; n++) i = Fe(t, i, e);
			r = e.funcImports, n = e.globalImports;
		} else if (6 === e) s = {
			offset: l,
			size: a
		};
		else if (7 === e) {
			let e = l;
			const [n, r] = De(t, e);
			e += r;
			for (let s = 0; s < n; s++) {
				const [n, r] = De(t, e);
				e += r;
				const s = new TextDecoder().decode(t.subarray(e, e + n));
				e += n;
				const o = t[e++], [a, c] = De(t, e);
				if (e += c, 3 === o && "__heap_base" === s) {
					i = a;
					break;
				}
			}
			if (null === i) return null;
			if (null === s) return null;
			break;
		}
		o = l + a;
	}
	if (null === i || null === s) return null;
	const a = i - n;
	if (a < 0) return null;
	let c = s.offset;
	const [l, h] = De(t, c);
	if (c += h, a >= l) return null;
	for (let d = 0; d < a; d++) c = Ve(t, c);
	return function(e, t) {
		t++, t++;
		const n = e[t++];
		if (65 === n) {
			const [n] = Ke(e, t);
			return BigInt.asUintN(32, BigInt(n));
		}
		if (66 === n) {
			const [n] = Oe(e, t);
			return BigInt.asUintN(64, n);
		}
		return null;
	}(t, c);
}
function Ge(e, t) {
	const n = new Uint8Array(e);
	if (n.length < 8) return null;
	let r = 0, i = null, s = null, o = 8;
	for (; o < n.length;) {
		const e = n[o], [a, c] = De(n, o + 1), l = o + 1 + c;
		if (2 === e) {
			const e = {
				funcImports: r,
				globalImports: 0
			};
			let t = l;
			const [i, s] = De(n, t);
			t += s;
			for (let r = 0; r < i; r++) t = Fe(n, t, e);
			r = e.funcImports;
		} else if (7 === e) {
			let e = l;
			const [r, s] = De(n, e);
			e += s;
			for (let o = 0; o < r; o++) {
				const [r, s] = De(n, e);
				e += s;
				const o = new TextDecoder().decode(n.subarray(e, e + r));
				e += r;
				const a = n[e++], [c, l] = De(n, e);
				if (e += l, 0 === a && o === t) {
					i = c;
					break;
				}
			}
		} else 10 === e && (s = {
			offset: l,
			size: a
		});
		o = l + a;
	}
	if (null === i || null === s) return null;
	let a = s.offset;
	const [c, l] = De(n, a);
	return a += l, function e(t, i = 0) {
		if (i > 4) return null;
		const s = function(e) {
			const t = e - r;
			if (t < 0 || t >= c) return null;
			let i = a;
			for (let r = 0; r < t; r++) {
				const [e, t] = De(n, i);
				i += t + e;
			}
			const [s, o] = De(n, i);
			return i += o, {
				start: i,
				end: i + s
			};
		}(t);
		if (!s) return null;
		const o = function(e, t) {
			if (e >= t) return null;
			const [r, i] = De(n, e);
			e += i;
			for (let s = 0; s < r; s++) {
				const [, r] = De(n, e);
				if (e += r, ++e > t) return null;
			}
			return e;
		}(s.start, s.end);
		if (null === o) return null;
		let l = o;
		const h = s.end;
		for (; l < h;) {
			const t = n[l++];
			if (11 !== t) {
				if (65 === t) {
					const [e] = Ke(n, l), [, t] = Ke(n, l), r = l + t;
					if (15 === n[r] || 11 === n[r] && r + 1 === h) return e;
					l = r;
				} else if (16 === t) {
					const [t, r] = De(n, l), s = l + r;
					if (15 === n[s] || 11 === n[s] && s + 1 === h) {
						const n = e(t, i + 1);
						if (null !== n) return n;
					}
					l = s;
				} else if (12 === t || 13 === t || 18 === t || 210 === t) {
					const [, e] = De(n, l);
					l += e;
				} else if (2 === t || 3 === t || 4 === t) l = ze(n, l);
				else if (14 === t) {
					const [e, t] = De(n, l);
					l += t;
					for (let r = 0; r <= e; r++) {
						const [, e] = De(n, l);
						l += e;
					}
				} else if (17 === t) {
					const [, e] = De(n, l);
					l += e;
					const [, t] = De(n, l);
					l += t;
				} else if (28 === t) {
					const [e, t] = De(n, l);
					l += t;
					for (let r = 0; r < e; r++) {
						const [, e] = De(n, l);
						l += e;
					}
				} else if (t >= 32 && t <= 38 || 208 === t) {
					const [, e] = De(n, l);
					l += e;
				} else if (t >= 40 && t <= 62) l = Ne(n, l);
				else if (63 === t || 64 === t) l++;
				else if (66 === t) {
					const [, e] = Oe(n, l);
					l += e;
				} else if (67 === t) l += 4;
				else if (68 === t) l += 8;
				else if (252 === t || 253 === t || 254 === t) {
					const e = $e(t, n, l);
					if (null === e) return null;
					l = e;
				}
			} else if (l === h) return null;
		}
		return null;
	}(i);
}
function je(e) {
	const t = new Uint8Array(e);
	if (t.length < 8) return 4;
	function n(e, t) {
		let n = 0, r = 0, i = t;
		for (;;) {
			const t = e[i++];
			if (n |= (127 & t) << r, !(128 & t)) break;
			r += 7;
		}
		return [n, i - t];
	}
	let r = 8;
	for (; r < t.length;) {
		const e = t[r], [i, s] = n(t, r + 1), o = r + 1 + s;
		if (2 === e) {
			let e = o;
			const [r, i] = n(t, e);
			e += i;
			for (let s = 0; s < r; s++) {
				const [r, i] = n(t, e);
				e += i + r;
				const [s, o] = n(t, e);
				e += o + s;
				const a = t[e++];
				if (2 === a) return 4 & t[e] ? 8 : 4;
				if (0 === a) {
					const [, r] = n(t, e);
					e += r;
				} else if (1 === a) {
					e++;
					const r = t[e++], [, i] = n(t, e);
					if (e += i, 1 & r) {
						const [, r] = n(t, e);
						e += r;
					}
				} else 3 === a && (e += 2);
			}
			break;
		}
		r = o + i;
	}
	return 4;
}
function Ye(e) {
	const t = e instanceof ArrayBuffer ? new Uint8Array(e) : new Uint8Array(e.buffer, e.byteOffset, e.byteLength), n = new Uint8Array(t.byteLength);
	return n.set(t), n.buffer;
}
function Xe(e) {
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
var Je = class e {
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
	framebuffers = new h();
	mergeCallbacks(e) {
		this.callbacks = {
			...this.callbacks,
			...e
		};
	}
	setProgramFuncTable(e) {
		this.programFuncTable = e;
	}
	constructor(e, t, n) {
		this.config = e, this.io = t, this.callbacks = n ?? {};
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
	injectMouseEvent(e, t, n) {
		const r = this.instance?.exports?.kernel_inject_mouse_event;
		r && r(e, t, n);
	}
	audioScratchOffset = 0;
	static AUDIO_SCRATCH_SIZE = 65536;
	ensureAudioScratch() {
		if (0 !== this.audioScratchOffset) return !0;
		const t = (this.instance?.exports)?.kernel_alloc_scratch;
		if (!t) return !1;
		const n = Number(t(e.AUDIO_SCRATCH_SIZE));
		return 0 !== n && (this.audioScratchOffset = n, !0);
	}
	drainAudio(t) {
		const n = (this.instance?.exports)?.kernel_drain_audio;
		if (!n || !this.memory || !this.ensureAudioScratch()) return 0;
		const r = Math.min(t.byteLength, e.AUDIO_SCRATCH_SIZE), i = n(this.toKernelPtr(this.audioScratchOffset), r);
		if (i > 0) {
			const e = new Uint8Array(this.memory.buffer, this.audioScratchOffset, i);
			t.set(e.subarray(0, i));
		}
		return i;
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
	registerSharedPipe(e, t, n) {
		this.sharedPipes.set(e, {
			pipe: c.fromSharedBuffer(t),
			end: n
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
		this.sharedLockTable = l.fromBuffer(e);
	}
	registerForkSab(e) {
		this.forkSab = e;
	}
	registerWaitpidSab(e) {
		this.waitpidSab = e;
	}
	async init(e) {
		this.kernelPtrWidth = je(Ye(e));
		const t = this.createKernelMemory();
		this.memory = t;
		const n = this.buildImportObject(t), r = await WebAssembly.compile(e);
		this.instance = await WebAssembly.instantiate(r, n);
	}
	async initWithMemory(e, t) {
		this.kernelPtrWidth = je(Ye(e)), this.memory = t;
		const n = this.buildImportObject(t), r = await WebAssembly.compile(e);
		this.instance = await WebAssembly.instantiate(r, n);
	}
	buildImportObject(e) {
		return { env: {
			memory: e,
			host_debug_log: (t, n) => {
				const r = new Uint8Array(e.buffer, Number(t), n), i = new TextDecoder().decode(r.slice());
				console.log(`[KERNEL] ${i}`);
			},
			host_open: (e, t, n, r) => this.hostOpen(Number(e), t, n, r),
			host_close: (e) => this.hostClose(e),
			host_read: (e, t, n) => this.hostRead(e, Number(t), n),
			host_write: (e, t, n) => this.hostWrite(e, Number(t), n),
			host_seek: (e, t, n, r) => this.hostSeek(e, t, n, r),
			host_fstat: (e, t) => this.hostFstat(e, Number(t)),
			host_stat: (e, t, n) => this.hostStat(Number(e), t, Number(n)),
			host_lstat: (e, t, n) => this.hostLstat(Number(e), t, Number(n)),
			host_statfs: (e, t, n) => this.hostStatfs(Number(e), t, Number(n)),
			host_mkdir: (e, t, n) => this.hostMkdir(Number(e), t, n),
			host_rmdir: (e, t) => this.hostRmdir(Number(e), t),
			host_unlink: (e, t) => this.hostUnlink(Number(e), t),
			host_rename: (e, t, n, r) => this.hostRename(Number(e), t, Number(n), r),
			host_link: (e, t, n, r) => this.hostLink(Number(e), t, Number(n), r),
			host_symlink: (e, t, n, r) => this.hostSymlink(Number(e), t, Number(n), r),
			host_readlink: (e, t, n, r) => this.hostReadlink(Number(e), t, Number(n), r),
			host_chmod: (e, t, n) => this.hostChmod(Number(e), t, n),
			host_chown: (e, t, n, r) => this.hostChown(Number(e), t, n, r),
			host_access: (e, t, n) => this.hostAccess(Number(e), t, n),
			host_opendir: (e, t) => this.hostOpendir(Number(e), t),
			host_readdir: (e, t, n, r) => this.hostReaddir(e, Number(t), Number(n), r),
			host_closedir: (e) => this.hostClosedir(e),
			host_clock_gettime: (e, t, n) => this.hostClockGettime(e, Number(t), Number(n)),
			host_nanosleep: (e, t) => this.hostNanosleep(e, t),
			host_ftruncate: (e, t) => this.hostFtruncate(e, t),
			host_fsync: (e) => this.hostFsync(e),
			host_fchmod: (e, t) => this.hostFchmod(e, t),
			host_fchown: (e, t, n) => this.hostFchown(e, t, n),
			host_kill: (e, t) => this.hostKill(e, t),
			host_exec: (e, t) => this.hostExec(Number(e), t),
			host_set_alarm: (e) => this.hostSetAlarm(e),
			host_set_posix_timer: (e, t, n, r, i, s) => {
				const o = 4294967296 * (r >>> 0) + (n >>> 0), a = 4294967296 * (s >>> 0) + (i >>> 0);
				return this.hostSetPosixTimer(e, t, o, a);
			},
			host_sigsuspend_wait: () => this.hostSigsuspendWait(),
			host_call_signal_handler: (e, t, n) => {
				const r = this.programFuncTable ?? this.instance?.exports.__indirect_function_table;
				if (!r) return -22;
				const i = r.get(e);
				if (i) try {
					return 4 & n ? i(t, 0, 0) : i(t), 0;
				} catch (s) {
					return -5;
				}
				return -22;
			},
			host_getrandom: (e, t) => {
				try {
					const n = this.getMemoryBuffer(), r = Number(e), i = n.subarray(r, r + t);
					if (void 0 !== globalThis.crypto && globalThis.crypto.getRandomValues) {
						const e = new Uint8Array(t);
						globalThis.crypto.getRandomValues(e), i.set(e);
					} else for (let e = 0; e < t; e++) i[e] = 256 * Math.random() | 0;
					return t;
				} catch {
					return -5;
				}
			},
			host_utimensat: (e, t, n, r, i, s) => this.hostUtimensat(Number(e), t, n, r, i, s),
			host_waitpid: (e, t, n) => this.hostWaitpid(e, t, Number(n)),
			host_net_connect: (e, t, n, r) => this.hostNetConnect(e, Number(t), n, r),
			host_net_send: (e, t, n, r) => this.hostNetSend(e, Number(t), n, r),
			host_net_recv: (e, t, n, r) => this.hostNetRecv(e, Number(t), n, r),
			host_net_poll: (e, t) => this.hostNetPoll(e, t),
			host_net_connect_status: (e) => this.hostNetConnectStatus(e),
			host_net_close: (e) => this.hostNetClose(e),
			host_net_listen: (e, t, n, r, i, s) => this.hostNetListen(e, t, n, r, i, s),
			host_udp_bind: (e, t, n, r, i, s) => this.hostUdpBind(e, t, n, r, i, s),
			host_udp_unbind: (e) => this.hostUdpUnbind(e),
			host_udp_send: (e, t, n, r, i, s, o, a, c, l, h, d) => this.hostUdpSend(e, t, n, r, i, s, o, a, c, l, Number(h), d),
			host_getaddrinfo: (e, t, n, r) => this.hostGetaddrinfo(Number(e), t, Number(n), r),
			host_fcntl_lock: (e, t, n, r, i, s, o, a, c, l) => this.hostFcntlLock(Number(e), t, n, r, i, s, o, a, c, Number(l)),
			host_fork: () => this.hostFork(),
			host_futex_wait: (e, t, n, r) => this.hostFutexWait(Number(e), t, n, r),
			host_futex_wake: (e, t) => this.hostFutexWake(Number(e), t),
			host_clone: (e, t, n, r, i) => this.hostClone(Number(e), Number(t), Number(n), Number(r), Number(i)),
			host_is_thread_worker: () => this.isThreadWorker ? 1 : 0,
			host_bind_framebuffer: (e, t, n, r, i, s, o) => {
				this.framebuffers.bind({
					pid: e,
					addr: Number(t),
					len: Number(n),
					w: r,
					h: i,
					stride: s,
					fmt: "BGRA32"
				});
			},
			host_unbind_framebuffer: (e) => {
				this.framebuffers.unbind(e);
			},
			host_fb_write: (e, t, n, r) => {
				this.framebuffers.fbWrite(e, Number(t), this.readKernelBytes(Number(n), Number(r)));
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
		const n = new Uint8Array(t);
		return n.set(this.getMemoryBuffer().subarray(e, e + t)), n;
	}
	hostOpen(e, t, n, r) {
		try {
			const i = this.getMemoryBuffer().slice(e, e + t), s = new TextDecoder().decode(i);
			return BigInt(this.io.open(s, n, r));
		} catch (i) {
			return BigInt(Xe(i));
		}
	}
	hostClose(e) {
		const t = Number(e), n = this.sharedPipes.get(t);
		if (n) return "read" === n.end ? n.pipe.closeRead() : n.pipe.closeWrite(), this.sharedPipes.delete(t), 0;
		if (t >= 0 && t <= 2) return 0;
		try {
			return this.io.close(t);
		} catch (r) {
			return Xe(r);
		}
	}
	hostRead(e, t, n) {
		const r = Number(e), i = this.sharedPipes.get(r);
		if (i) {
			const e = this.getMemoryBuffer(), r = new Uint8Array(e.buffer, t, n);
			return i.pipe.read(r);
		}
		if (0 === r) {
			if (this.callbacks.onStdin) {
				const e = this.callbacks.onStdin(n);
				if (null === e) return 0;
				if (0 === e.length) return -11;
				const r = this.getMemoryBuffer(), i = Math.min(e.length, n);
				return r.set(e.subarray(0, i), t), i;
			}
			return 0;
		}
		try {
			const e = this.getMemoryBuffer().subarray(t, t + n);
			return this.io.read(r, e, null, n);
		} catch (s) {
			return Xe(s);
		}
	}
	hostWrite(e, t, n) {
		const r = Number(e), i = this.getMemoryBuffer().slice(t, t + n), s = this.sharedPipes.get(r);
		if (s) return s.pipe.write(i);
		if (1 === r) return this.callbacks.onStdout ? this.callbacks.onStdout(i) : "undefined" != typeof process && process.stdout ? process.stdout.write(i) : console.log(new TextDecoder().decode(i)), n;
		if (2 === r) return this.callbacks.onStderr ? this.callbacks.onStderr(i) : "undefined" != typeof process && process.stderr ? process.stderr.write(i) : console.error(new TextDecoder().decode(i)), n;
		try {
			return this.io.write(r, i, null, n);
		} catch (o) {
			return Xe(o);
		}
	}
	hostSeek(e, t, n, r) {
		const i = Number(e), s = 4294967296 * n + (t >>> 0);
		try {
			return BigInt(this.io.seek(i, s, r));
		} catch (o) {
			return BigInt(Xe(o));
		}
	}
	hostFstat(e, t) {
		const n = Number(e);
		try {
			const e = this.io.fstat(n);
			return this.writeStatToMemory(t, e), 0;
		} catch (r) {
			return Xe(r);
		}
	}
	writeStatToMemory(e, t) {
		const n = this.getMemoryDataView();
		this.getMemoryBuffer().fill(0, e, e + 88), n.setBigUint64(e + 0, BigInt(t.dev), !0), n.setBigUint64(e + 8, BigInt(t.ino), !0), n.setUint32(e + 16, t.mode, !0), n.setUint32(e + 20, t.nlink, !0), n.setUint32(e + 24, t.uid, !0), n.setUint32(e + 28, t.gid, !0), n.setBigUint64(e + 32, BigInt(t.size), !0);
		const r = Math.floor(t.atimeMs / 1e3), i = Math.floor(t.atimeMs % 1e3 * 1e6);
		n.setBigUint64(e + 40, BigInt(r), !0), n.setUint32(e + 48, i, !0);
		const s = Math.floor(t.mtimeMs / 1e3), o = Math.floor(t.mtimeMs % 1e3 * 1e6);
		n.setBigUint64(e + 56, BigInt(s), !0), n.setUint32(e + 64, o, !0);
		const a = Math.floor(t.ctimeMs / 1e3), c = Math.floor(t.ctimeMs % 1e3 * 1e6);
		n.setBigUint64(e + 72, BigInt(a), !0), n.setUint32(e + 80, c, !0);
	}
	writeStatfsToMemory(e, t) {
		const n = this.getMemoryDataView();
		this.getMemoryBuffer().fill(0, e, e + 72);
		const r = (e) => Number.isFinite(e) ? Math.max(0, Math.floor(e)) >>> 0 : 0, i = (e) => !Number.isFinite(e) || e <= 0 ? 0n : BigInt(Math.min(Math.floor(e), Number.MAX_SAFE_INTEGER));
		n.setUint32(e + 0, r(t.type), !0), n.setUint32(e + 4, r(t.bsize), !0), n.setBigUint64(e + 8, i(t.blocks), !0), n.setBigUint64(e + 16, i(t.bfree), !0), n.setBigUint64(e + 24, i(t.bavail), !0), n.setBigUint64(e + 32, i(t.files), !0), n.setBigUint64(e + 40, i(t.ffree), !0), n.setBigUint64(e + 48, i(t.fsid), !0), n.setUint32(e + 56, r(t.namelen), !0), n.setUint32(e + 60, r(t.frsize), !0), n.setUint32(e + 64, r(t.flags), !0);
	}
	readPathFromMemory(e, t) {
		const n = this.getMemoryBuffer().slice(e, e + t);
		return new TextDecoder().decode(n);
	}
	hostStat(e, t, n) {
		try {
			const r = this.readPathFromMemory(e, t), i = this.io.stat(r);
			return this.writeStatToMemory(n, i), 0;
		} catch (r) {
			return Xe(r);
		}
	}
	hostLstat(e, t, n) {
		try {
			const r = this.readPathFromMemory(e, t), i = this.io.lstat(r);
			return this.writeStatToMemory(n, i), 0;
		} catch (r) {
			return Xe(r);
		}
	}
	hostStatfs(e, t, n) {
		try {
			const r = this.readPathFromMemory(e, t), i = this.io.statfs(r);
			return this.writeStatfsToMemory(n, i), 0;
		} catch (r) {
			return Xe(r);
		}
	}
	hostMkdir(e, t, n) {
		try {
			const r = this.readPathFromMemory(e, t);
			return this.io.mkdir(r, n), 0;
		} catch (r) {
			return Xe(r);
		}
	}
	hostRmdir(e, t) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.rmdir(n), 0;
		} catch (n) {
			return Xe(n);
		}
	}
	hostUnlink(e, t) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.unlink(n), 0;
		} catch (n) {
			return Xe(n);
		}
	}
	hostRename(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.readPathFromMemory(n, r);
			return this.io.rename(i, s), 0;
		} catch (i) {
			return Xe(i);
		}
	}
	hostLink(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.readPathFromMemory(n, r);
			return this.io.link(i, s), 0;
		} catch (i) {
			return Xe(i);
		}
	}
	hostSymlink(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.readPathFromMemory(n, r);
			return this.io.symlink(i, s), 0;
		} catch (i) {
			return Xe(i);
		}
	}
	hostReadlink(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.io.readlink(i), o = new TextEncoder().encode(s), a = Math.min(o.length, r);
			return this.getMemoryBuffer().set(o.subarray(0, a), n), a;
		} catch (i) {
			return Xe(i);
		}
	}
	hostChmod(e, t, n) {
		try {
			const r = this.readPathFromMemory(e, t);
			return this.io.chmod(r, n), 0;
		} catch (r) {
			return Xe(r);
		}
	}
	hostChown(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.chown(i, n, r), 0;
		} catch (i) {
			return Xe(i);
		}
	}
	hostAccess(e, t, n) {
		try {
			const r = this.readPathFromMemory(e, t);
			return this.io.access(r, n), 0;
		} catch (r) {
			return Xe(r);
		}
	}
	hostUtimensat(e, t, n, r, i, s) {
		try {
			const o = this.readPathFromMemory(e, t);
			return this.io.utimensat(o, Number(n), Number(r), Number(i), Number(s)), 0;
		} catch {
			return -1;
		}
	}
	hostWaitpid(e, t, n) {
		if (this.waitpidSab && this.callbacks.onWaitpid) {
			const r = new Int32Array(this.waitpidSab);
			Atomics.store(r, 0, 0), Atomics.store(r, 1, 0), Atomics.store(r, 2, 0), this.callbacks.onWaitpid(e, t), Atomics.wait(r, 0, 0);
			const i = Atomics.load(r, 1), s = Atomics.load(r, 2);
			return i < 0 || 0 !== n && this.memory && new DataView(this.memory.buffer).setInt32(n, s, !0), i;
		}
		if (!this.io.waitpid) return -10;
		try {
			const r = this.io.waitpid(e, t);
			return 0 !== n && this.memory && new DataView(this.memory.buffer).setInt32(n, r.status, !0), r.pid;
		} catch {
			return -10;
		}
	}
	hostOpendir(e, t) {
		try {
			const n = this.readPathFromMemory(e, t);
			return BigInt(this.io.opendir(n));
		} catch (n) {
			return BigInt(Xe(n));
		}
	}
	hostReaddir(e, t, n, r) {
		try {
			const i = Number(e), s = this.io.readdir(i);
			if (null === s) return 0;
			const o = this.getMemoryDataView(), a = this.getMemoryBuffer(), c = new TextEncoder().encode(s.name), l = Math.min(c.length, r);
			return o.setBigUint64(t, BigInt(s.ino), !0), o.setUint32(t + 8, s.type, !0), o.setUint32(t + 12, l, !0), a.set(c.subarray(0, l), n), 1;
		} catch (i) {
			return Xe(i);
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
	hostClockGettime(e, t, n) {
		try {
			const r = this.io.clockGettime(e), i = this.getMemoryDataView();
			return i.setBigInt64(t, BigInt(r.sec), !0), i.setBigInt64(n, BigInt(r.nsec), !0), 0;
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
	hostFchown(e, t, n) {
		try {
			return this.io.fchown(Number(e), t, n), 0;
		} catch {
			return -1;
		}
	}
	hostKill(e, t) {
		return this.callbacks.onKill ? this.callbacks.onKill(e, t) : -3;
	}
	hostExec(e, t) {
		if (this.callbacks.onExec) {
			const n = this.getMemoryBuffer(), r = new TextDecoder().decode(n.slice(e, e + t));
			return this.callbacks.onExec(r);
		}
		return -2;
	}
	hostSetAlarm(e) {
		return this.callbacks.onAlarm ? this.callbacks.onAlarm(e) : 0;
	}
	hostSetPosixTimer(e, t, n, r) {
		return this.callbacks.onPosixTimer ? this.callbacks.onPosixTimer(e, t, n, r) : 0;
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
	socket(e, t, n) {
		const r = (0, this.instance.exports.kernel_socket)(e, t, n);
		if (r < 0) throw new Error("socket failed: errno " + -r);
		return r;
	}
	socketpair(e, t, n) {
		const r = this.instance.exports.kernel_socketpair, i = this.getMemoryDataView(), s = r(e, t, n, 4);
		if (s < 0) throw new Error("socketpair failed: errno " + -s);
		return [i.getInt32(4, !0), i.getInt32(8, !0)];
	}
	shutdown(e, t) {
		const n = (0, this.instance.exports.kernel_shutdown)(e, t);
		if (n < 0) throw new Error("shutdown failed: errno " + -n);
	}
	send(e, t, n = 0) {
		const r = this.instance.exports.kernel_send;
		this.getMemoryBuffer().set(t, 16);
		const i = r(e, 16, t.length, n);
		if (i < 0) throw new Error("send failed: errno " + -i);
		return i;
	}
	recv(e, t, n = 0) {
		const r = (0, this.instance.exports.kernel_recv)(e, 16, t, n);
		if (r < 0) throw new Error("recv failed: errno " + -r);
		return this.getMemoryBuffer().slice(16, 16 + r);
	}
	poll(e, t) {
		const n = this.instance.exports.kernel_poll, r = e.length, i = this.getMemoryDataView();
		for (let o = 0; o < r; o++) {
			const t = 16 + 8 * o;
			i.setInt32(t, e[o].fd, !0), i.setInt16(t + 4, e[o].events, !0), i.setInt16(t + 6, 0, !0);
		}
		const s = n(16, r, t);
		if (s < 0) throw new Error("poll failed: errno " + -s);
		return e.map((e, t) => ({
			fd: e.fd,
			events: e.events,
			revents: i.getInt16(16 + 8 * t + 6, !0)
		}));
	}
	getsockopt(e, t, n) {
		const r = this.instance.exports.kernel_getsockopt, i = this.getMemoryDataView(), s = r(e, t, n, 4);
		if (s < 0) throw new Error("getsockopt failed: errno " + -s);
		return i.getUint32(4, !0);
	}
	setsockopt(e, t, n, r) {
		const i = (0, this.instance.exports.kernel_setsockopt)(e, t, n, r);
		if (i < 0) throw new Error("setsockopt failed: errno " + -i);
	}
	tcgetattr(e) {
		const t = (0, this.instance.exports.kernel_tcgetattr)(e, 16, 48);
		if (t < 0) throw new Error("tcgetattr failed: errno " + -t);
		return this.getMemoryBuffer().slice(16, 64);
	}
	tcsetattr(e, t, n) {
		const r = this.instance.exports.kernel_tcsetattr;
		this.getMemoryBuffer().set(n, 16);
		const i = r(e, t, 16, n.length);
		if (i < 0) throw new Error("tcsetattr failed: errno " + -i);
	}
	ioctl(e, t, n) {
		const r = this.instance.exports.kernel_ioctl, i = this.getMemoryBuffer(), s = n ? n.length : 8;
		n && i.set(n, 16);
		const o = r(e, t, 16, s);
		if (o < 0) throw new Error("ioctl failed: errno " + -o);
		return i.slice(16, 16 + s);
	}
	signal(e, t) {
		const n = (0, this.instance.exports.kernel_signal)(e, t);
		if (n < 0) throw new Error("signal failed: errno " + -n);
		return n;
	}
	umask(e) {
		return (0, this.instance.exports.kernel_umask)(e);
	}
	uname() {
		const e = this.instance.exports.kernel_uname, t = e(16, 325);
		if (t < 0) throw new Error("uname failed: errno " + -t);
		const n = this.getMemoryBuffer(), r = new TextDecoder(), i = (e) => {
			const t = 16 + e;
			let i = t;
			for (; i < t + 65 && 0 !== n[i];) i++;
			return r.decode(n.slice(t, i));
		};
		return {
			sysname: i(0),
			nodename: i(65),
			release: i(130),
			version: i(195),
			machine: i(260)
		};
	}
	sysconf(e) {
		const t = (0, this.instance.exports.kernel_sysconf)(e);
		return Number(t);
	}
	dup3(e, t, n) {
		const r = (0, this.instance.exports.kernel_dup3)(e, t, n);
		if (r < 0) throw new Error("dup3 failed: errno " + -r);
		return r;
	}
	pipe2(e) {
		const t = this.instance.exports.kernel_pipe2, n = this.getMemoryDataView(), r = t(e, 4);
		if (r < 0) throw new Error("pipe2 failed: errno " + -r);
		return [n.getInt32(4, !0), n.getInt32(8, !0)];
	}
	ftruncate(e, t) {
		const n = (0, this.instance.exports.kernel_ftruncate)(e, 4294967295 & t, Math.floor(t / 4294967296));
		if (n < 0) throw new Error("ftruncate failed: errno " + -n);
	}
	fsync(e) {
		const t = (0, this.instance.exports.kernel_fsync)(e);
		if (t < 0) throw new Error("fsync failed: errno " + -t);
	}
	truncate(e, t, n) {
		const r = (0, this.instance.exports.kernel_truncate)(e, t, 4294967295 & n, Math.floor(n / 4294967296));
		if (r < 0) throw new Error("truncate failed: errno " + -r);
	}
	fdatasync(e) {
		const t = (0, this.instance.exports.kernel_fdatasync)(e);
		if (t < 0) throw new Error("fdatasync failed: errno " + -t);
	}
	fchmod(e, t) {
		const n = (0, this.instance.exports.kernel_fchmod)(e, t);
		if (n < 0) throw new Error("fchmod failed: errno " + -n);
	}
	fchown(e, t, n) {
		const r = (0, this.instance.exports.kernel_fchown)(e, t, n);
		if (r < 0) throw new Error("fchown failed: errno " + -r);
	}
	getpgrp() {
		return (0, this.instance.exports.kernel_getpgrp)();
	}
	setpgid(e, t) {
		const n = (0, this.instance.exports.kernel_setpgid)(e, t);
		if (n < 0) throw new Error("setpgid failed: errno " + -n);
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
	select(e, t, n, r) {
		const i = this.instance.exports.kernel_select, s = this.getMemoryBuffer(), o = t ? 16 : 0, a = n ? 144 : 0, c = r ? 272 : 0;
		if (t) {
			s.fill(0, o, o + 128);
			for (const e of t) s[o + Math.floor(e / 8)] |= 1 << e % 8;
		}
		if (n) {
			s.fill(0, a, a + 128);
			for (const e of n) s[a + Math.floor(e / 8)] |= 1 << e % 8;
		}
		if (r) {
			s.fill(0, c, c + 128);
			for (const e of r) s[c + Math.floor(e / 8)] |= 1 << e % 8;
		}
		const l = i(e, o, a, c, 0);
		if (l < 0) throw new Error("select failed: errno " + -l);
		const h = (e, t) => t && e ? t.filter((t) => s[e + Math.floor(t / 8)] >> t % 8 & 1) : [];
		return {
			readReady: h(o, t),
			writeReady: h(a, n),
			exceptReady: h(c, r)
		};
	}
	hostNetConnect(e, t, n, r) {
		if (!this.io.network) return -111;
		try {
			const i = new Uint8Array(this.memory.buffer).slice(t, t + n);
			return this.io.network.connect(e, i, r), 0;
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
	hostNetSend(e, t, n, r) {
		if (!this.io.network) return -107;
		try {
			const i = new Uint8Array(this.memory.buffer).slice(t, t + n);
			return this.io.network.send(e, i, r);
		} catch (i) {
			return 11 === i?.errno ? -11 : -32;
		}
	}
	hostNetRecv(e, t, n, r) {
		if (!this.io.network) return -107;
		try {
			const i = this.io.network.recv(e, n, r);
			return i.length > 0 && this.memory && new Uint8Array(this.memory.buffer).set(i, t), i.length;
		} catch (i) {
			return 11 === i?.errno ? -11 : -104;
		}
	}
	hostNetPoll(e, t) {
		if (!this.io.network) return -107;
		try {
			return this.io.network.poll ? this.io.network.poll(e, t) : 5 & t;
		} catch (n) {
			return "number" == typeof n?.errno ? -Math.abs(n.errno) : -104;
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
	hostNetListen(e, t, n, r, i, s) {
		return this.callbacks.onNetListen ? this.callbacks.onNetListen(e, t, [
			n,
			r,
			i,
			s
		]) : 0;
	}
	hostUdpBind(e, t, n, r, i, s) {
		return this.callbacks.onUdpBind ? this.callbacks.onUdpBind(e, [
			t,
			n,
			r,
			i
		], s) : 0;
	}
	hostUdpUnbind(e) {
		return this.callbacks.onUdpUnbind ? this.callbacks.onUdpUnbind(e) : 0;
	}
	hostUdpSend(e, t, n, r, i, s, o, a, c, l, h, d) {
		if (!this.io.network?.sendDatagram) return -101;
		try {
			const f = this.getMemoryBuffer();
			let u = new Uint8Array([
				e,
				t,
				n,
				r
			]);
			0 === u[0] && 0 === u[1] && 0 === u[2] && 0 === u[3] && this.io.network.localAddress && (u = this.io.network.localAddress.slice());
			const p = f.slice(h, h + d), g = this.io.network.sendDatagram({
				srcAddr: u,
				srcPort: i,
				dstAddr: new Uint8Array([
					s,
					o,
					a,
					c
				]),
				dstPort: l,
				data: p
			});
			return 0 === g ? d : -g;
		} catch (f) {
			return "number" == typeof f?.errno ? -Math.abs(f.errno) : -101;
		}
	}
	hostGetaddrinfo(e, t, n, r) {
		if (!this.io.network) return -2;
		try {
			const i = new Uint8Array(this.memory.buffer), s = new TextDecoder().decode(i.slice(e, e + t)), o = this.io.network.getaddrinfo(s);
			return o.length > r ? -22 : (i.set(o, n), o.length);
		} catch (i) {
			return 11 === i?.errno ? -11 : -2;
		}
	}
	static F_GETLK = 12;
	static F_SETLK = 13;
	static F_SETLKW = 14;
	static F_UNLCK = 2;
	hostFcntlLock(t, n, r, i, s, o, a, c, h, d) {
		if (!this.sharedLockTable) return 0;
		try {
			const f = this.getMemoryBuffer(), u = new TextDecoder().decode(f.slice(t, t + n)), p = l.hashPath(u), g = BigInt(a) << 32n | BigInt(o >>> 0), m = BigInt(h) << 32n | BigInt(c >>> 0);
			switch (i) {
				case e.F_GETLK: {
					const t = this.sharedLockTable.getBlockingLock(p, s, g, m, r), n = this.getMemoryDataView();
					if (t) {
						n.setUint32(d, t.lockType, !0), n.setUint32(d + 4, t.pid, !0);
						const e = t.start;
						n.setUint32(d + 8, Number(4294967295n & e), !0), n.setUint32(d + 12, Number(e >> 32n & 4294967295n), !0);
						const r = t.len;
						n.setUint32(d + 16, Number(4294967295n & r), !0), n.setUint32(d + 20, Number(r >> 32n & 4294967295n), !0);
					} else n.setUint32(d, e.F_UNLCK, !0);
					return 0;
				}
				case e.F_SETLK: return this.sharedLockTable.setLock(p, r, s, g, m) ? 0 : -11;
				case e.F_SETLKW: return this.sharedLockTable.setLockWait(p, r, s, g, m), 0;
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
	hostFutexWait(e, t, n, r) {
		if (!this.memory) return -22;
		const i = new Int32Array(this.memory.buffer), s = e >>> 2, o = 4294967296n * BigInt(r >>> 0) + BigInt(n >>> 0), a = BigInt.asIntN(64, o);
		let c;
		a >= 0n && (c = Number(a / 1000000n), 0 === c && a > 0n && (c = 1));
		const l = Atomics.wait(i, s, t, c);
		return "timed-out" === l ? -110 : "not-equal" === l ? -11 : 0;
	}
	hostFutexWake(e, t) {
		if (!this.memory) return 0;
		const n = new Int32Array(this.memory.buffer), r = e >>> 2;
		return Atomics.notify(n, r, t);
	}
	hostClone(e, t, n, r, i) {
		return this.callbacks.onClone ? this.callbacks.onClone(e, t, n, r, i) : -38;
	}
};
const Ze = new TextEncoder(), Qe = new TextDecoder();
function et(e) {
	const t = function(e) {
		for (let t = 0; t + 3 < e.length; t++) if (13 === e[t] && 10 === e[t + 1] && 13 === e[t + 2] && 10 === e[t + 3]) return t;
		return -1;
	}(e);
	if (t < 0) return {
		status: 200,
		headers: {},
		body: e
	};
	const n = Qe.decode(e.subarray(0, t)).split("\r\n"), r = n[0]?.match(/^HTTP\/[\d.]+ (\d+)/), i = r ? parseInt(r[1], 10) : 200, s = {};
	for (let c = 1; c < n.length; c++) {
		const e = n[c], t = e.indexOf(": ");
		if (t < 0) continue;
		const r = e.slice(0, t), i = e.slice(t + 2);
		"set-cookie" === r.toLowerCase() && s[r] ? s[r] += "\n" + i : s[r] = i;
	}
	let o = e.subarray(t + 4);
	const a = s["Transfer-Encoding"] ?? s["transfer-encoding"];
	return a && a.toLowerCase().includes("chunked") && (o = function(e) {
		const t = [];
		let n = 0;
		for (; n < e.length;) {
			let r = -1;
			for (let t = n; t + 1 < e.length; t++) if (13 === e[t] && 10 === e[t + 1]) {
				r = t;
				break;
			}
			if (r < 0) break;
			const i = Qe.decode(e.subarray(n, r)).trim(), s = parseInt(i, 16);
			if (Number.isNaN(s) || 0 === s) break;
			const o = r + 2, a = o + s;
			if (a > e.length) break;
			t.push(e.subarray(o, a)), n = a + 2;
		}
		return function(e) {
			if (0 === e.length) return new Uint8Array(0);
			if (1 === e.length) return e[0];
			const t = e.reduce((e, t) => e + t.length, 0), n = new Uint8Array(t);
			let r = 0;
			for (const i of e) n.set(i, r), r += i.length;
			return n;
		}(t);
	}(o), delete s["Transfer-Encoding"], delete s["transfer-encoding"]), {
		status: i,
		headers: s,
		body: new Uint8Array(o)
	};
}
function tt(e, t, n = function() {
	let e = 0;
	return "function" == typeof SharedArrayBuffer && (e |= f.shared_array_buffer), "function" == typeof Atomics.wait && (e |= f.atomics_wait), "function" == typeof Atomics.waitAsync && (e |= f.atomics_wait_async), e;
}()) {
	const r = function(e, t) {
		const n = nt(e, "kernel_host_adapter_manifest_ptr"), r = nt(e, "kernel_host_adapter_manifest_len"), i = rt(n(), "kernel_host_adapter_manifest_ptr"), s = rt(r(), "kernel_host_adapter_manifest_len");
		if (s < 40) throw new Error(`kernel host adapter manifest is too small: ${s} bytes (expected at least 40)`);
		if (i + 40 > t.buffer.byteLength) throw new Error(`kernel host adapter manifest is out of bounds: ptr=${i} size=40 memory=${t.buffer.byteLength}`);
		const o = new DataView(t.buffer, i, 40);
		return {
			magic: st(o, "magic"),
			manifestVersion: it(o, "manifestVersion"),
			manifestSize: it(o, "manifestSize"),
			abiVersion: st(o, "abiVersion"),
			requiredHostAdapterVersion: st(o, "requiredHostAdapterVersion"),
			requiredWorkerFeatures: st(o, "requiredWorkerFeatures"),
			optionalKernelFeatures: st(o, "optionalKernelFeatures"),
			channelHeaderSize: st(o, "channelHeaderSize"),
			channelDataOffset: st(o, "channelDataOffset"),
			channelDataSize: st(o, "channelDataSize"),
			channelMinSize: st(o, "channelMinSize")
		};
	}(e, t);
	if (1296781399 !== r.magic) throw new Error(`kernel host adapter manifest has invalid magic: ${r.magic}`);
	if (1 !== r.manifestVersion) throw new Error(`kernel host adapter manifest version ${r.manifestVersion} is not supported by host manifest reader 1`);
	if (40 !== r.manifestSize) throw new Error(`kernel host adapter manifest size ${r.manifestSize} does not match host reader size 40`);
	if (14 !== r.abiVersion) throw new Error(`kernel host adapter manifest ABI version ${r.abiVersion} does not match host ABI version 14`);
	if (r.requiredHostAdapterVersion > 1) throw new Error(`kernel requires host adapter version ${r.requiredHostAdapterVersion}, but this host supports 1`);
	const i = r.requiredWorkerFeatures & ~n;
	if (0 !== i) throw new Error("kernel requires unsupported worker features: " + function(e) {
		const t = [];
		let n = 0;
		for (const [i, s] of Object.entries(f)) n |= s, 0 !== (e & s) && t.push(i);
		const r = e & ~n;
		0 !== r && t.push(`unknown(0x${r.toString(16)})`);
		return 0 === t.length ? "none" : t.join(", ");
	}(i));
	ot("channel header size", r.channelHeaderSize, 72), ot("channel data offset", r.channelDataOffset, 72), ot("channel data size", r.channelDataSize, g), ot("channel minimum size", r.channelMinSize, m);
	for (const s of u) if ("function" != typeof e.exports[s]) throw new Error(`kernel wasm is missing required host adapter export ${s}`);
	return r;
}
function nt(e, t) {
	const n = e.exports[t];
	if ("function" != typeof n) throw new Error(`kernel wasm is missing required host adapter export ${t}`);
	return n;
}
function rt(e, t) {
	const n = "bigint" == typeof e ? Number(e) : e;
	if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${t} returned invalid manifest pointer/length ${String(e)}`);
	return n;
}
function it(e, t) {
	return e.getUint16(p[t].offset, !0);
}
function st(e, t) {
	return e.getUint32(p[t].offset, !0);
}
function ot(e, t, n) {
	if (t !== n) throw new Error(`kernel host adapter manifest ${e} ${t} does not match generated host ABI value ${n}`);
}
const at = 67108864, ct = 1024, lt = 16384, ht = Math.ceil(1.0010986328125);
function dt(e, t) {
	let n = 0n, r = 0n, i = t;
	for (;;) {
		if (i >= e.length) throw new Error("truncated wasm LEB128");
		const t = e[i++];
		if (n |= BigInt(127 & t) << r, !(128 & t)) break;
		r += 7n;
	}
	return [n, i - t];
}
function ft(e, t) {
	const [n, r] = dt(e, t);
	if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`wasm LEB128 value exceeds JS safe integer: ${n}`);
	return [Number(n), r];
}
function ut(e, t) {
	const [n, r] = ft(e, t);
	let i = t + r;
	const [, s] = dt(e, i);
	if (i += s, 1 & n) {
		const [, t] = dt(e, i);
		i += t;
	}
	return i;
}
function pt(e, t) {
	if (!Number.isInteger(e) || e < 0) throw new Error(`invalid ${t}: ${e}`);
	return e;
}
function gt(e, t = 1024) {
	pt(t, "host default thread slot count");
	const n = e ? function(e) {
		return Ge(e, "__wasm_posix_thread_slots");
	}(e) : null;
	if (null === n || -1 === n) return t;
	if (!Number.isInteger(n) || n < -1) throw new Error(`invalid process thread slot declaration: ${n}`);
	return pt(n, "process thread slot declaration");
}
function mt(e) {
	const t = e.maxPages ?? 16384;
	if (!Number.isInteger(t) || t <= ht) throw new Error(`invalid process maximum pages: ${t}`);
	const n = e.programBytes ? function(e) {
		const t = new Uint8Array(e);
		if (t.length < 8 || 0 !== t[0] || 97 !== t[1] || 115 !== t[2] || 109 !== t[3]) return null;
		let n = 8;
		for (; n < t.length;) {
			const e = t[n++], [r, i] = ft(t, n);
			if (n += i, 2 !== e) {
				n += r;
				continue;
			}
			const [s, o] = ft(t, n);
			n += o;
			for (let a = 0; a < s; a++) {
				const [e, r] = ft(t, n);
				n += r + e;
				const [i, s] = ft(t, n);
				n += s + i;
				const o = t[n++];
				if (0 === o) {
					const [, e] = ft(t, n);
					n += e;
				} else if (1 === o) n += 1, n = ut(t, n);
				else {
					if (2 === o) {
						const [, e] = ft(t, n);
						n += e;
						const [r] = ft(t, n);
						return r;
					}
					if (3 === o) n += 2;
					else {
						if (4 !== o) return null;
						{
							n += 1;
							const [, e] = ft(t, n);
							n += e;
						}
					}
				}
			}
			return null;
		}
		return null;
	}(e.programBytes) ?? 0 : 0, r = Math.max(17, e.minPages ?? 0, n), i = function(e) {
		if (null == e) return null;
		if ("bigint" == typeof e) {
			if (e > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`heap base exceeds JS safe integer: ${e}`);
			return Number(e);
		}
		return e;
	}(e.heapBase), s = (o = Math.max(i ?? 16777216, r * We), Math.ceil(o / We) * We);
	var o;
	const a = s / We, c = void 0 !== e.threadSlots ? pt(e.threadSlots, "process thread slot count") : gt(e.programBytes, e.defaultThreadSlots), l = a + 1, h = l * We, d = l + ht, f = d + 2, u = d + (e.preallocateThreadSlots ? 4 * c : 0), p = Math.max(r, u);
	if (p > t) throw new Error(`initial pages ${p} exceed process maximum ${t}`);
	const g = u * We, m = t * We;
	return {
		initialPages: p,
		maximumPages: t,
		controlBase: s,
		controlEnd: g,
		channelOffset: h,
		channelPage: l,
		brkBase: g,
		mmapBase: g,
		brkLimit: m,
		maxAddr: m,
		firstThreadSlotPage: d,
		firstThreadBasePage: f,
		threadArenaEndPage: u,
		threadSlotCount: c
	};
}
function _t(e, t, n = 4) {
	const r = Math.ceil(t / We) - Math.ceil(e.buffer.byteLength / We);
	r <= 0 || (8 === n ? e.grow(BigInt(r)) : e.grow(r));
}
const yt = 11, wt = W, St = X, kt = ce, bt = ue, At = V, It = we, Ct = Se, Et = oe, vt = ye, xt = me, Tt = Be, Pt = _e, Bt = He, Ht = ge, Ut = R, Mt = y, Lt = b, Rt = w, Wt = S, Dt = k, Kt = pe, Ot = L, zt = Me, Nt = te, $t = ne, Ft = fe, Vt = be, qt = Le, Gt = 16777216, jt = Z, Yt = D, Xt = K, Jt = O, Zt = le, Qt = ke, en = E, tn = C, nn = j, rn = Y, sn = $, on = F, an = q, cn = G, ln = he, hn = de, dn = z, fn = Ue, un = N, pn = Q, gn = ee, mn = Ie, _n = Ce, yn = x, wn = xe, Sn = Te, kn = Pe, bn = Ee, An = ve, In = "undefined" != typeof process && !!{}.WASM_POSIX_PROFILE, Cn = new Set([
	C,
	F,
	G,
	j,
	ee,
	de
]), En = new Set([
	E,
	$,
	q,
	Y,
	Q,
	he,
	Ae
]);
const vn = m;
const xn = {
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
}, Tn = {
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
var Pn = class {
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
		const t = this.channelTids.get(`${e.pid}:${e.channelOffset}`) ?? 0, n = this.kernelInstance?.exports.kernel_set_current_tid;
		n && n(t);
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
	profileData = In ? /* @__PURE__ */ new Map() : null;
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
	constructor(e, t, n = {}) {
		if (this.config = e, this.io = t, this.callbacks = n, this.kernel = new Je(e, t, {
			onStdin: (e) => {
				const t = this.currentHandlePid, n = this.stdinBuffers.get(t);
				if (!n) return this.stdinFinite.has(t) ? null : new Uint8Array(0);
				const r = n.data.length - n.offset;
				if (r <= 0) return this.stdinBuffers.delete(t), this.stdinFinite.has(t) ? null : new Uint8Array(0);
				const i = Math.min(r, e), s = n.data.subarray(n.offset, n.offset + i);
				return n.offset += i, n.offset >= n.data.length && this.stdinBuffers.delete(t), s;
			},
			onAlarm: (e) => {
				const t = this.currentHandlePid;
				if (0 === t) return 0;
				const n = this.alarmTimers.get(t);
				if (n && (clearTimeout(n), this.alarmTimers.delete(t)), e > 0) {
					const n = setTimeout(() => {
						this.alarmTimers.delete(t), this.processes.has(t) && this.sendSignalToProcess(t, 14);
					}, 1e3 * e);
					this.alarmTimers.set(t, n);
				}
				return 0;
			},
			onNetListen: (e, t, n) => {
				const r = this.currentHandlePid;
				return 0 === r || this.startTcpListener(r, e, t, n), 0;
			},
			onUdpBind: (e, t, n) => {
				const r = this.currentHandlePid;
				if (0 === r || !this.io.network?.bindUdp) return 0;
				const i = `${r}:${e}`, s = this.io.network.bindUdp(i, new Uint8Array(t), n, { receive: (e) => this.injectUdpDatagram(r, e) });
				return 0 === s && this.udpBindings.add(i), 0 === s ? 0 : -s;
			},
			onUdpUnbind: (e) => {
				const t = this.currentHandlePid;
				if (0 === t || !this.io.network?.unbindUdp) return 0;
				const n = `${t}:${e}`;
				return this.io.network.unbindUdp(n), this.udpBindings.delete(n), 0;
			},
			onPosixTimer: (e, t, n, r) => {
				const i = this.currentHandlePid;
				if (0 === i) return 0;
				const s = `${i}:${e}`, o = this.posixTimers.get(s);
				if (o && (clearTimeout(o.timeout), o.interval && clearInterval(o.interval), this.posixTimers.delete(s)), n > 0 || r > 0) {
					const o = setTimeout(() => {
						if (this.processes.has(i)) if (this.sendSignalToProcess(i, t), r > 0) {
							const n = setInterval(() => {
								if (!this.processes.has(i)) {
									const e = this.posixTimers.get(s);
									e?.interval && clearInterval(e.interval), this.posixTimers.delete(s);
									return;
								}
								const n = this.kernelInstance.exports.kernel_posix_timer_interval_fire;
								n && n(i, e) || this.sendSignalToProcess(i, t);
							}, r), o = this.posixTimers.get(s);
							o && (o.interval = n);
						} else this.posixTimers.delete(s);
						else this.posixTimers.delete(s);
					}, Math.max(0, n));
					this.posixTimers.set(s, {
						timeout: o,
						signo: t
					});
				}
				return 0;
			}
		}), this.virtualMacAddress = new Uint8Array(6), void 0 !== globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(this.virtualMacAddress);
		else for (let r = 0; r < 6; r++) this.virtualMacAddress[r] = Math.floor(256 * Math.random());
		this.virtualMacAddress[0] = 254 & this.virtualMacAddress[0] | 2;
	}
	async init(e) {
		await this.kernel.init(e), this.kernelInstance = this.kernel.getInstance(), this.kernelMemory = this.kernel.getMemory();
		const t = this.kernelInstance.exports[d];
		if ("function" != typeof t) throw new Error(`kernel wasm is missing the ${d} export — refusing to run. Rebuild the kernel (bash build.sh) against the current ABI.`);
		this.kernelAbiVersion = t(), tt(this.kernelInstance, this.kernelMemory);
		(0, this.kernelInstance.exports.kernel_set_mode)(1);
		const n = this.kernelInstance.exports.kernel_alloc_scratch;
		if (this.scratchOffset = Number(n(vn)), 0 === this.scratchOffset) throw new Error("Failed to allocate kernel scratch buffer");
		try {
			const e = await import("./__vite-browser-external-DSazUnuX.js").then((e) => a(e.default, 1));
			"function" == typeof e.createServer && (this.netModule = e);
		} catch {}
		if (this.tcpScratchOffset = Number(n(65536)), 0 === this.tcpScratchOffset) throw new Error("Failed to allocate TCP scratch buffer");
		this.lockTable = l.create(), this.kernel.registerSharedLockTable(this.lockTable.getBuffer()), this.initialized = !0;
	}
	registerProcess(e, t, n, r) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		if (this.hostReaped.delete(e), !r?.skipKernelCreate) {
			const t = (0, this.kernelInstance.exports.kernel_create_process)(e);
			if (t < 0) throw new Error(`Failed to create process ${e}: errno ${-t}`);
		}
		if (void 0 !== r?.brkBase && !this.setBrkBase(e, r.brkBase)) throw new Error("Kernel export kernel_set_brk_base is required for compact process memory layout");
		if (r?.argv && r.argv.length > 0) {
			const t = this.kernelInstance.exports.kernel_set_process_argv;
			if (t) {
				const n = new TextEncoder(), i = r.argv.join("\0"), s = n.encode(i), o = new Uint8Array(this.kernelMemory.buffer), a = this.scratchOffset;
				o.set(s, a), t(e, this.toKernelPtr(a), s.length);
			}
		}
		const i = this.kernelInstance.exports.kernel_set_max_addr;
		if (i) {
			const t = r?.maxAddr ?? (n.length > 0 ? Math.min(...n) : void 0);
			void 0 !== t && i(e, this.toKernelPtr(t));
		}
		if (void 0 !== r?.mmapBase && !this.setMmapBase(e, r.mmapBase)) throw new Error("Kernel export kernel_set_mmap_base is required for compact process memory layout");
		if (void 0 !== r?.brkLimit && !this.setBrkLimit(e, r.brkLimit)) throw new Error("Kernel export kernel_set_brk_limit is required for legacy low-control layout");
		const s = n.map((n) => ({
			pid: e,
			memory: t,
			channelOffset: n,
			i32View: new Int32Array(t.buffer, n),
			consecutiveSyscalls: 0
		})), o = {
			pid: e,
			memory: t,
			channels: s,
			ptrWidth: r?.ptrWidth ?? 4,
			explicitMaxAddr: void 0 !== r?.maxAddr
		};
		if (this.processes.set(e, o), this.activeChannels.push(...s), this.usePolling) this.startPolling();
		else for (const a of s) this.listenOnChannel(a);
	}
	setStdinData(e, t) {
		this.stdinBuffers.set(e, {
			data: t,
			offset: 0
		}), this.stdinFinite.add(e);
		const n = this.kernelInstance.exports.kernel_set_stdin_pipe;
		n && n(e);
	}
	setOutputCallbacks(e) {
		this.kernel.mergeCallbacks(e);
	}
	appendStdinData(e, t) {
		const n = this.stdinBuffers.get(e);
		if (n) {
			const r = n.data.subarray(n.offset), i = new Uint8Array(r.length + t.length);
			i.set(r), i.set(t, r.length), this.stdinBuffers.set(e, {
				data: i,
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
		const n = t(e);
		if (n < 0) throw new Error("kernel_pty_create failed: errno " + -n);
		return this.ptyIndexByPid.set(e, n), this.activePtyIndices.add(n), n;
	}
	ptyMasterWrite(e, t) {
		const n = this.kernelInstance.exports.kernel_pty_master_write;
		n && (new Uint8Array(this.kernelMemory.buffer).set(t, this.scratchOffset), n(e, this.toKernelPtr(this.scratchOffset), t.length), this.drainPtyOutput(e), this.scheduleWakeBlockedRetries());
	}
	ptyMasterRead(e) {
		const t = this.kernelInstance.exports.kernel_pty_master_read;
		if (!t) return null;
		const n = t(e, this.toKernelPtr(this.scratchOffset), 4096);
		return n <= 0 ? null : new Uint8Array(this.kernelMemory.buffer).slice(this.scratchOffset, this.scratchOffset + n);
	}
	ptySetWinsize(e, t, n) {
		const r = this.kernelInstance.exports.kernel_pty_set_winsize;
		if (!r) return;
		r(e, t, n), this.scheduleWakeBlockedRetries();
		for (const [i, s] of Array.from(this.pendingSleeps.entries())) this.processes.has(i) && (this.dequeueSignalForDelivery(s.channel), new DataView(s.channel.memory.buffer, s.channel.channelOffset).getUint32(65560, !0) > 0 && (clearTimeout(s.timer), this.pendingSleeps.delete(i), this.completeChannel(s.channel, s.syscallNr, s.origArgs, Re[s.syscallNr], -1, 4)));
	}
	onPtyOutput(e, t) {
		this.ptyOutputCallbacks.set(e, t);
	}
	drainPtyOutput(e) {
		const t = this.ptyOutputCallbacks.get(e);
		if (t) for (;;) {
			const n = this.ptyMasterRead(e);
			if (!n) break;
			t(n);
		}
	}
	drainAllPtyOutputs() {
		if (0 !== this.activePtyIndices.size) for (const e of this.activePtyIndices) this.drainPtyOutput(e);
	}
	setCwd(e, t) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		const n = this.kernelInstance.exports.kernel_set_cwd;
		if (!n) return;
		const r = new TextEncoder().encode(t);
		new Uint8Array(this.kernelMemory.buffer).set(r, this.scratchOffset), n(e, this.toKernelPtr(this.scratchOffset), r.length);
	}
	setCredentials(e, t) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		if (null == t.uid && null == t.gid) return;
		const n = 4294967295, r = this.kernelInstance.exports.kernel_set_process_credentials;
		if (r) {
			const i = r(e, t.uid ?? n, t.gid ?? n);
			if (i < 0) throw new Error(`setCredentials failed for pid ${e}: errno ${-i}`);
			return;
		}
		const i = this.kernelInstance.exports.kernel_set_current_pid, s = this.kernelInstance.exports.kernel_setgid, o = this.kernelInstance.exports.kernel_setuid;
		if (i && s && o) try {
			if (i(e), null != t.gid) {
				const n = s(t.gid);
				if (n < 0) throw new Error(`setgid failed for pid ${e}: errno ${-n}`);
			}
			if (null != t.uid) {
				const n = o(t.uid);
				if (n < 0) throw new Error(`setuid failed for pid ${e}: errno ${-n}`);
			}
		} finally {
			i(0);
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
		const t = e(this.toKernelPtr(this.scratchOffset), vn);
		if (t <= 0) return [];
		const n = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, t), r = new Uint8Array(t);
		r.set(n);
		const i = function(e) {
			if (e.byteLength < 4) return [];
			const t = new DataView(e.buffer, e.byteOffset, e.byteLength), n = t.getUint32(0, !0);
			let r = 4;
			const i = [], s = new TextDecoder("utf-8", { fatal: !1 });
			for (let o = 0; o < n && !(r + 36 > e.byteLength); o++) {
				const n = t.getUint32(r, !0);
				r += 4;
				const o = t.getUint32(r, !0);
				r += 4;
				const a = t.getUint32(r, !0);
				r += 4;
				const c = t.getUint32(r, !0);
				r += 4;
				const l = Number(t.getBigUint64(r, !0));
				r += 8;
				const h = String.fromCharCode(t.getUint32(r, !0));
				r += 4;
				const d = t.getUint32(r, !0);
				r += 4;
				const f = t.getUint32(r, !0);
				if (r += 4, r + d + f > e.byteLength) break;
				const u = s.decode(e.subarray(r, r + d));
				r += d;
				const p = e.subarray(r, r + f);
				r += f;
				const g = s.decode(p).replace(/\0/g, " ").trimEnd();
				i.push({
					pid: n,
					ppid: o,
					uid: a,
					gid: c,
					vsizeBytes: l,
					state: h,
					comm: u,
					cmdline: g || `[${u}]`
				});
			}
			return i;
		}(r);
		for (const s of i) {
			const e = this.processes.get(s.pid);
			e && (s.memoryBytes = e.memory.buffer.byteLength);
		}
		return i;
	}
	readProcMaps(e) {
		if (!this.initialized) return null;
		const t = this.kernelInstance.exports.kernel_read_proc_maps;
		if (!t) return null;
		const n = t(e, this.toKernelPtr(this.scratchOffset), vn);
		if (n < 0) return null;
		if (0 === n) return "";
		const r = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, n), i = new Uint8Array(n);
		return i.set(r), new TextDecoder("utf-8", { fatal: !1 }).decode(i);
	}
	unregisterProcess(e) {
		if (!this.processes.get(e)) return;
		this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.cleanupUdpBindings(e), this.cleanupTcpListeners(e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingPipeReaders(e), this.cleanupPendingPipeWriters(e);
		for (const [n, r] of this.socketTimeoutTimers) n.pid === e && (clearTimeout(r), this.socketTimeoutTimers.delete(n));
		for (const n of this.epollInterests.keys()) n.startsWith(`${e}:`) && this.epollInterests.delete(n);
		if (this.lockTable) {
			const t = this.lockTable.getBuffer();
			Atomics.store(new Int32Array(t), 0, 0), this.lockTable.removeLocksByPid(e);
		}
		this.removeFromKernelProcessTable(e), this.processes.delete(e), this.stdinFinite.delete(e), this.stdinBuffers.delete(e), this.usePolling && 0 === this.processes.size && this.stopPolling();
		const t = this.ptyIndexByPid.get(e);
		void 0 !== t && (this.ptyIndexByPid.delete(e), this.activePtyIndices.delete(t), this.ptyOutputCallbacks.delete(t));
	}
	removeProcessFromKernelTable(e) {
		if (!this.initialized) return;
		const t = this.kernelInstance?.exports.kernel_remove_process;
		t && t(e);
	}
	deactivateProcess(e) {
		this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.processes.delete(e), this.stdinFinite.delete(e), this.stdinBuffers.delete(e);
		const t = this.alarmTimers.get(e);
		t && (clearTimeout(t), this.alarmTimers.delete(e));
		for (const [r, i] of this.posixTimers) r.startsWith(`${e}:`) && (clearTimeout(i.timeout), i.interval && clearInterval(i.interval), this.posixTimers.delete(r));
		const n = this.pendingSleeps.get(e);
		n && (clearTimeout(n.timer), this.pendingSleeps.delete(e)), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupUdpBindings(e), this.cleanupTcpListeners(e), this.hostReaped.delete(e);
	}
	kernelExecSetup(e) {
		return (0, this.kernelInstance.exports.kernel_exec_setup)(e);
	}
	prepareProcessForExec(e) {
		this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingPipeReaders(e), this.cleanupPendingPipeWriters(e);
		for (const [t, n] of this.socketTimeoutTimers) t.pid === e && (clearTimeout(n), this.socketTimeoutTimers.delete(t));
		this.processes.delete(e);
	}
	removeFromKernelProcessTable(e) {
		(0, this.kernelInstance.exports.kernel_remove_process)(e);
	}
	addChannel(e, t, n, r, i) {
		const s = this.processes.get(e);
		if (!s) throw new Error(`Process ${e} not registered`);
		const o = {
			pid: e,
			memory: s.memory,
			channelOffset: t,
			i32View: new Int32Array(s.memory.buffer, t),
			consecutiveSyscalls: 0
		};
		s.channels.push(o), this.activeChannels.push(o), void 0 !== n && this.channelTids.set(`${e}:${t}`, n), void 0 !== r && void 0 !== i && this.threadForkContexts.set(`${e}:${t}`, {
			fnPtr: r,
			argPtr: i
		});
		const a = this.kernelInstance.exports.kernel_set_max_addr;
		if (a && !s.explicitMaxAddr) {
			const n = t - 131072;
			n >= at && a(e, this.toKernelPtr(n));
		}
		this.usePolling || this.listenOnChannel(o);
	}
	removeChannel(e, t) {
		const n = this.processes.get(e);
		n && (n.channels = n.channels.filter((e) => e.channelOffset !== t), this.activeChannels = this.activeChannels.filter((n) => !(n.pid === e && n.channelOffset === t)), this.channelTids.delete(`${e}:${t}`), this.threadForkContexts.delete(`${e}:${t}`));
	}
	listenOnChannel(e) {
		const t = new Int32Array(e.memory.buffer, e.channelOffset);
		e.i32View = t;
		const n = Atomics.load(t, 0);
		if (1 === n) return void (this.relistenBatchSize <= 1 ? setImmediate(() => {
			this.processes.has(e.pid) && this.handleSyscall(e);
		}) : this.handleSyscall(e));
		const r = Atomics.waitAsync(t, 0, n);
		r.async ? r.value.then(() => {
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
	readCString(e, t, n = 256) {
		if (0 === t) return "(null)";
		const r = new Uint8Array(e.buffer);
		let i = 0;
		for (; i < n && t + i < r.length && 0 !== r[t + i];) i++;
		const s = new Uint8Array(i);
		return s.set(r.subarray(t, t + i)), new TextDecoder().decode(s);
	}
	formatSyscallEntry(e, t, n) {
		const r = xn[t] ?? `syscall_${t}`, i = e.pid, s = this.channelTids.get(`${i}:${e.channelOffset}`), o = void 0 !== s ? `:t${s}` : "";
		switch (t) {
			case A: return `[${i}${o}] open("${this.readCString(e.memory, n[0])}", 0x${(n[1] >>> 0).toString(16)}, 0o${(n[2] >>> 0).toString(8)})`;
			case J: return `[${i}${o}] openat(${n[0]}, "${this.readCString(e.memory, n[1])}", 0x${(n[2] >>> 0).toString(16)}, 0o${(n[3] >>> 0).toString(8)})`;
			case T: return `[${i}${o}] stat("${this.readCString(e.memory, n[0])}")`;
			case P: return `[${i}${o}] lstat("${this.readCString(e.memory, n[0])}")`;
			case re: return `[${i}${o}] fstatat(${n[0]}, "${this.readCString(e.memory, n[1])}", 0x${(n[3] >>> 0).toString(16)})`;
			case H: return `[${i}${o}] access("${this.readCString(e.memory, n[0])}", ${n[1]})`;
			case ie: return `[${i}${o}] faccessat(${n[0]}, "${this.readCString(e.memory, n[1])}", ${n[2]})`;
			case U: return `[${i}${o}] chdir("${this.readCString(e.memory, n[0])}")`;
			case M: return `[${i}${o}] opendir("${this.readCString(e.memory, n[0])}")`;
			case B: return `[${i}${o}] readlink("${this.readCString(e.memory, n[0])}", ${n[2]})`;
			case se: return `[${i}${o}] readlinkat(${n[0]}, "${this.readCString(e.memory, n[1])}", ${n[3]})`;
			case ae: return `[${i}${o}] realpath("${this.readCString(e.memory, n[0])}")`;
			case C: return `[${i}${o}] read(${n[0]}, ${n[2]})`;
			case E: return `[${i}${o}] write(${n[0]}, ${n[2]})`;
			case I: return `[${i}${o}] close(${n[0]})`;
			case v: return `[${i}${o}] fstat(${n[0]})`;
			case x: return `[${i}${o}] fcntl(${n[0]}, ${n[1]}, ${n[2]})`;
			case D: return `[${i}${o}] mmap(0x${(n[0] >>> 0).toString(16)}, ${n[1] >>> 0}, ${n[2]}, 0x${(n[3] >>> 0).toString(16)}, ${n[4]}, ${n[5] >>> 0})`;
			case K: return `[${i}${o}] munmap(0x${(n[0] >>> 0).toString(16)}, ${n[1] >>> 0})`;
			case O: return `[${i}${o}] brk(0x${(n[0] >>> 0).toString(16)})`;
			case y: return `[${i}${o}] execve("${this.readCString(e.memory, n[0])}")`;
			case w: return `[${i}${o}] fork()`;
			case S: return `[${i}${o}] vfork()`;
			case pe: return `[${i}${o}] clone(0x${(n[0] >>> 0).toString(16)})`;
			case L: return `[${i}${o}] exit(${n[0]})`;
			case V: return `[${i}${o}] poll(${n[1]}, ${n[2]})`;
			case Z: return `[${i}${o}] ioctl(${n[0]}, 0x${(n[1] >>> 0).toString(16)})`;
			default: return `[${i}${o}] ${r}(${n.filter((e, t) => t < 3).join(", ")})`;
		}
	}
	formatSyscallReturn(e, t, n) {
		if (t < 0 || 0 !== n) return ` = ${t} (${Tn[n] ?? `errno=${n}`})`;
		switch (e) {
			case D:
			case O: return ` = 0x${(t >>> 0).toString(16)}`;
			default: return ` = ${t}`;
		}
	}
	handleSyscall(e) {
		try {
			if (In) {
				const t = new DataView(e.memory.buffer, e.channelOffset).getUint32(4, !0), n = performance.now();
				this._handleSyscallInner(e);
				const r = performance.now() - n;
				let i = this.profileData.get(t);
				i || (i = {
					count: 0,
					totalTimeMs: 0,
					retries: 0
				}, this.profileData.set(t, i)), i.count++, i.totalTimeMs += r;
				return;
			}
			this._handleSyscallInner(e);
		} catch ($n) {
			console.error(`[handleSyscall] UNCAUGHT ERROR pid=${e.pid}:`, $n), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
		}
	}
	_handleSyscallInner(e) {
		const t = new DataView(e.memory.buffer, e.channelOffset), n = t.getUint32(4, !0), r = [];
		for (let g = 0; g < 6; g++) r.push(Number(t.getBigInt64(8 + 8 * g, !0)));
		const i = e.channelOffset;
		let s = this.syscallRing.get(i);
		s || (s = [], this.syscallRing.set(i, s)), s.push(`  syscall=${n} args=[${r.join(",")}]`), s.length > 30 && s.shift(), this.syscallTraceEnabled && (this.syscallTraceRing.length >= this.syscallTraceCap && this.syscallTraceRing.shift(), this.syscallTraceRing.push({
			t: performance.now(),
			pid: e.pid,
			nr: n,
			args: [
				r[0] ?? 0,
				r[1] ?? 0,
				r[2] ?? 0,
				r[3] ?? 0,
				r[4] ?? 0,
				r[5] ?? 0
			]
		}));
		const o = this.config.syscallLogPtrWidth, a = void 0 !== o && this.processes.get(e.pid)?.ptrWidth === o, c = !!this.config.enableSyscallLog || a;
		let l = "";
		if (c && (l = this.formatSyscallEntry(e, n, r)), n === Rt || n === Wt) return c && console.error(l), void this.handleFork(e, r);
		if (n === Dt) return c && console.error(l), void this.handleSpawn(e, r);
		if (n === Mt) return c && console.error(l), void this.handleExec(e, r);
		if (n === Lt) return c && console.error(l), void this.handleExecveat(e, r);
		if (n === Kt) return c && console.error(l), void this.handleClone(e, r);
		if (n === Ot || n === zt) return c && console.error(l), void this.handleExit(e, n, r);
		if (n === Ft) return c && console.error(l), void this.handleWaitpid(e, r);
		if (n === Vt) return c && console.error(l), void this.handleWaitid(e, r);
		if (n === bt) {
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
				}, n = 128, i = 256, s = r[1] >>> 0, o = -385 & s, a = t[o] ?? `op${o}`, c = (s & n ? "|PRIVATE" : "") + (s & i ? "|REALTIME" : ""), l = this.channelTids.get(`${e.pid}:${e.channelOffset}`), h = void 0 !== l ? `:t${l}` : "";
				console.error(`[${e.pid}${h}] futex(0x${(r[0] >>> 0).toString(16)}, ${a}${c}, val=${r[2]})`);
			}
			this.handleFutex(e, r);
			return;
		}
		if (n === qt) return c && console.error(l), void this.handleThreadCancel(e, r);
		if (n === pn || n === _n) return c && console.error(l), void this.handleWritev(e, n, r);
		if (n === gn || n === mn) return c && console.error(l), void this.handleReadv(e, n, r);
		if ((n === en || n === rn) && r[2] > 65536) return void this.handleLargeWrite(e, n, r);
		if ((n === tn || n === nn) && r[2] > 65536) return void this.handleLargeRead(e, n, r);
		if (n === ln) return void this.handleSendmsg(e, r);
		if (n === hn) return void this.handleRecvmsg(e, r);
		if (n === jt) {
			const t = r[1] >>> 0;
			if (35090 === t) return void this.handleIoctlIfconf(e, r);
			if (35111 === t) return void this.handleIoctlIfhwaddr(e, r);
			if (35093 === t) return void this.handleIoctlIfaddr(e, r);
		}
		if (n === yn) {
			const t = r[1];
			if (5 === t || 6 === t || 7 === t || 12 === t || 13 === t || 14 === t || 36 === t || 37 === t || 38 === t) return void this.handleFcntlLock(e, r);
		}
		if (n === xt || n === Tt) return void this.handleEpollCreate(e, n, r);
		if (n === Pt) return void this.handleEpollCtl(e, r);
		if (n === vt || n === Bt) return void this.handleEpollPwait(e, n, r);
		if (n === Sn) return void this.handleIpcShmat(e, r);
		if (n === kn) return void this.handleIpcShmdt(e, r);
		if (n === wn) return void this.handleSemctl(e, r);
		if (n === Ct) return void this.handlePselect6(e, r);
		if (n === Et) return void this.handleSelect(e, r);
		const h = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = [...r], f = Re[n];
		let u = 0;
		if (f) {
			const t = new Uint8Array(e.memory.buffer), n = this.getKernelMem(), i = this.scratchOffset + 72;
			for (const e of f) {
				const s = r[e.argIndex];
				if (0 === s) continue;
				let o;
				if ("cstring" === e.size.type) {
					let e = 0;
					for (; 0 !== t[s + e] && e < 65536 - u - 1;) e++;
					o = e + 1;
				} else if ("arg" === e.size.type) o = r[e.size.argIndex] * (e.size.multiplier ?? 1) + (e.size.add ?? 0);
				else if ("deref" === e.size.type) {
					const n = r[e.size.argIndex];
					if (0 === n) continue;
					o = t[n] | t[n + 1] << 8 | t[n + 2] << 16 | t[n + 3] << 24;
				} else o = e.size.size;
				if (o <= 0) continue;
				if (u + o > 65536) {
					if (o = g - u, o <= 0) continue;
					"arg" === e.size.type && (d[e.size.argIndex] = o);
				}
				const a = i + u;
				"in" === e.direction || "inout" === e.direction ? n.set(t.subarray(s, s + o), a) : n.fill(0, a, a + o), d[e.argIndex] = a, u += o, u = u + 3 & -4;
			}
		}
		if (n === It) {
			const t = r[2];
			if (0 !== t) {
				const n = new DataView(e.memory.buffer, t), r = Number(n.getBigInt64(0, !0)), i = Number(n.getBigInt64(8, !0));
				d[2] = 1e3 * r + Math.floor(i / 1e6);
			} else d[2] = -1;
			const n = r[3];
			if (0 !== n) {
				const t = new DataView(e.memory.buffer, n);
				d[3] = 1, d[4] = t.getUint32(0, !0), d[5] = t.getUint32(4, !0);
			} else d[3] = 0, d[4] = 0, d[5] = 0;
		}
		h.setUint32(4, n, !0);
		for (let g = 0; g < 6; g++) h.setBigInt64(8 + 8 * g, BigInt(d[g]), !0);
		const p = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		const m = globalThis.__sysprof, _ = m ? performance.now() : 0;
		if (m) {
			const t = globalThis;
			t.__sysprofGap || (t.__sysprofGap = /* @__PURE__ */ new Map()), t.__sysprofLastSeen || (t.__sysprofLastSeen = /* @__PURE__ */ new Map());
			const n = t.__sysprofLastSeen.get(e.pid);
			if (void 0 !== n) {
				const r = _ - n;
				let i = t.__sysprofGap.get(e.pid);
				i || (i = {
					count: 0,
					gapTotalMs: 0,
					gapMaxMs: 0
				}, t.__sysprofGap.set(e.pid, i)), i.count++, i.gapTotalMs += r, r > i.gapMaxMs && (i.gapMaxMs = r);
			}
			t.__sysprofLastSeen.set(e.pid, _);
		}
		try {
			p(this.toKernelPtr(this.scratchOffset), e.pid);
		} catch ($n) {
			c && console.error(l + " = KERNEL THROW"), console.error(`[handleSyscall] kernel threw for pid=${e.pid} syscall=${n} args=[${r}]:`, $n), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
			return;
		} finally {
			if (this.currentHandlePid = 0, m) {
				const t = performance.now() - _, i = globalThis;
				i.__sysprofTable || (i.__sysprofTable = /* @__PURE__ */ new Map());
				const s = `${e.pid}:${n}`;
				let o = i.__sysprofTable.get(s);
				o || (o = {
					count: 0,
					totalMs: 0,
					maxMs: 0
				}, i.__sysprofTable.set(s, o)), o.count++, o.totalMs += t, t > o.maxMs && (o.maxMs = t), t > 50 && console.warn(`[sysprof] slow pid=${e.pid} nr=${n} ${t.toFixed(1)}ms args=[${r.join(",")}]`);
			}
		}
		const y = Number(h.getBigInt64(56, !0)), w = h.getUint32(64, !0);
		y > 0 && this.ensureProcessMemoryCovers(e.pid, e.memory, n, y, r);
		const S = this.highControlFloorForProcess(e.pid);
		if (n === Yt && y > 0 && y >>> 0 != 4294967295) {
			const t = y >>> 0, n = r[1] >>> 0;
			null !== S && t + n > S && console.error(`[MMAP ALERT] pid=${e.pid} mmap returned 0x${t.toString(16)} len=${n} — OVERLAPS THREAD REGION! args=[${r.map((e) => "0x" + (e >>> 0).toString(16)).join(",")}]`);
		}
		if (n === Zt && y > 0 && y >>> 0 != 4294967295) {
			const t = y >>> 0, n = r[2] >>> 0;
			null !== S && t + n > S && console.error(`[MREMAP ALERT] pid=${e.pid} mremap returned 0x${t.toString(16)} len=${n} — OVERLAPS THREAD REGION!`);
		}
		if (null !== S && n === Jt && y > S && console.error(`[BRK ALERT] pid=${e.pid} brk returned 0x${(y >>> 0).toString(16)} — IN THREAD REGION!`), n === Yt && y > 0 && y >>> 0 != 4294967295) {
			const t = r[4], n = r[3] >>> 0;
			if (t >= 0 && !(32 & n) && (this.populateMmapFromFile(e, y >>> 0, r), 1 & n)) {
				const n = r[5] >>> 0;
				let i = this.sharedMappings.get(e.pid);
				i || (i = /* @__PURE__ */ new Map(), this.sharedMappings.set(e.pid, i)), i.set(y >>> 0, {
					fd: t,
					fileOffset: 4096 * n,
					len: r[1] >>> 0
				});
			}
		}
		n === Qt && 0 === y && this.flushSharedMappings(e, r), n === Xt && 0 === y && (this.flushSharedMappings(e, r), this.cleanupSharedMappings(e.pid, r[0] >>> 0, r[1] >>> 0));
		const k = this.kernelInstance.exports.kernel_get_process_exit_status;
		if (k && k(e.pid) >= 128) this.handleProcessTerminated(e);
		else {
			if (n === bn && 0 === y && this.drainMqueueNotification(), this.dequeueSignalForDelivery(e), -1 === y && w === yt) return c && console.error(l + " = -1 (EAGAIN, will retry)"), void this.handleBlockingRetry(e, n, r);
			this.handleSleepDelay(e, n, r, y, w) || (0 !== w || n !== Nt && n !== $t || this.recheckDeferredWaitpids(), 0 === w && n === Ut && (this.scheduleWakeBlockedRetries(), this.reapKilledProcessesAfterSyscall()), c && console.error(l + this.formatSyscallReturn(n, y, w)), this.completeChannel(e, n, r, f, y, w));
		}
	}
	dequeueSignalForDelivery(e) {
		const t = this.kernelInstance.exports.kernel_dequeue_signal;
		if (!t) return;
		const n = this.scratchOffset + _;
		if (t(e.pid, this.toKernelPtr(n)) > 0) {
			const t = this.getKernelMem();
			new Uint8Array(e.memory.buffer).set(t.subarray(n, n + 44), e.channelOffset + _);
		} else {
			const t = e.channelOffset + _;
			new Uint8Array(e.memory.buffer, t, 48).fill(0);
		}
	}
	completeChannel(e, t, n, r, i, s) {
		const o = new DataView(e.memory.buffer, e.channelOffset);
		if (r) {
			const t = new Uint8Array(e.memory.buffer), s = this.getKernelMem(), o = this.scratchOffset + 72;
			let a = 0;
			for (const e of r) {
				const r = n[e.argIndex];
				if (0 === r) continue;
				let c;
				if ("cstring" === e.size.type) {
					let e = 0;
					for (; 0 !== t[r + e] && e < 65536 - a - 1;) e++;
					c = e + 1;
				} else if ("arg" === e.size.type) c = n[e.size.argIndex] * (e.size.multiplier ?? 1) + (e.size.add ?? 0);
				else if ("deref" === e.size.type) {
					const r = n[e.size.argIndex];
					if (0 === r) continue;
					c = t[r] | t[r + 1] << 8 | t[r + 2] << 16 | t[r + 3] << 24;
				} else c = e.size.size;
				if (c <= 0) continue;
				if (a + c > 65536 && (c = g - a, c <= 0)) continue;
				const l = o + a;
				if ("out" === e.direction || "inout" === e.direction) {
					if ("out" === e.direction && i < 0) {
						a += c, a = a + 3 & -4;
						continue;
					}
					let n = c;
					if ("out" === e.direction && "arg" === e.size.type) {
						const t = e.copyRetvalAdd ?? 0;
						i > 0 && i + t < c && (n = i + t);
					}
					t.set(s.subarray(l, l + n), r);
				}
				a += c, a = a + 3 & -4;
			}
		}
		e.handling = !1, o.setBigInt64(56, BigInt(i), !0), o.setUint32(64, s, !0), this.clearSocketTimeout(e), this.drainAllPtyOutputs(), this.flushTcpSendPipes(e.pid);
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
	completeChannelRaw(e, t, n) {
		e.handling = !1;
		const r = new DataView(e.memory.buffer, e.channelOffset);
		r.setBigInt64(56, BigInt(t), !0), r.setUint32(64, n, !0), this.clearSocketTimeout(e), this.pendingCancels.delete(e.channelOffset);
		const i = new Int32Array(e.memory.buffer, e.channelOffset);
		Atomics.store(i, 0, 2), Atomics.notify(i, 0, 1);
	}
	abandonChannel(e) {
		e.handling = !1, this.clearSocketTimeout(e), this.pendingCancels.delete(e.channelOffset);
	}
	resolvePollReadinessIndices(e, t) {
		const n = this.kernelInstance.exports.kernel_get_fd_pipe_idx ?? this.kernelInstance.exports.kernel_get_socket_recv_pipe, r = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		if (!n && !r) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const i = t[0], s = t[1];
		if (0 === i || 0 === s) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const o = this.activeChannels.find((t) => t.pid === e);
		if (!o) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const a = [], c = [], l = new DataView(o.memory.buffer);
		for (let h = 0; h < s; h++) {
			const t = l.getInt32(i + 8 * h, !0);
			if (t < 0) continue;
			const s = l.getInt16(i + 8 * h + 4, !0);
			if (n) {
				const r = n(e, t);
				r >= 0 && a.push(r);
			}
			if (r && 1 & s) {
				const n = r(e, t);
				n >= 0 && c.push(n);
			}
		}
		return {
			pipeIndices: a,
			acceptIndices: c
		};
	}
	resolveEpollReadinessIndices(e) {
		const t = this.kernelInstance.exports.kernel_get_socket_recv_pipe, n = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		if (!t && !n) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const r = `${e}:`, i = [], s = [];
		for (const [o, a] of this.epollInterests) if (o.startsWith(r)) for (const r of a) {
			if (t) {
				const n = t(e, r.fd);
				n >= 0 && i.push(n);
			}
			if (n && 1 & r.events) {
				const t = n(e, r.fd);
				t >= 0 && s.push(t);
			}
		}
		return {
			pipeIndices: i,
			acceptIndices: s
		};
	}
	wakeBlockedAccept(e) {
		const t = Array.from(this.pendingPollRetries.entries()).filter(([, t]) => t.acceptIndices?.includes(e));
		for (const [n, r] of t) this.pendingPollRetries.get(n) === r && (null !== r.timer && clearTimeout(r.timer), this.pendingPollRetries.delete(n), this.processes.has(r.channel.pid) && this.retrySyscall(r.channel));
	}
	wakeBlockedPoll(e, t) {
		const n = Array.from(this.pendingPollRetries.entries()).filter(([, n]) => n.channel.pid === e && n.pipeIndices.includes(t));
		for (const [r, i] of n) this.pendingPollRetries.get(r) === i && (null !== i.timer && clearTimeout(i.timer), this.pendingPollRetries.delete(r), this.processes.has(e) && this.retrySyscall(i.channel));
	}
	notifyPipeReadable(e, t) {
		const n = this.pendingPipeReaders.get(e);
		if (n && n.length > 0) {
			this.pendingPipeReaders.delete(e);
			for (const e of n) this.processes.has(e.pid) && this.retrySyscall(e.channel);
		}
		for (const [r, i] of this.pendingPollRetries) void 0 !== t && i.channel.pid !== t || i.pipeIndices.includes(e) && (null !== i.timer && clearTimeout(i.timer), this.pendingPollRetries.delete(r), this.processes.has(i.channel.pid) && this.retrySyscall(i.channel));
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
		for (const [t, n] of this.pendingPollRetries) n.channel.pid === e && (n.timer && clearTimeout(n.timer), this.pendingPollRetries.delete(t));
	}
	cleanupPendingSelectRetries(e) {
		for (const [t, n] of this.pendingSelectRetries) n.channel.pid === e && (null !== n.timer && (clearTimeout(n.timer), clearImmediate(n.timer)), this.pendingSelectRetries.delete(t));
	}
	drainAndProcessWakeupEvents() {
		const e = this.kernelInstance.exports.kernel_drain_wakeup_events;
		if (!e) return;
		const t = e(this.toKernelPtr(this.scratchOffset), 1280, 256);
		if (0 === t) return;
		const n = new Uint8Array(this.kernelMemory.buffer);
		let r = !1;
		for (let i = 0; i < t; i++) {
			const e = this.scratchOffset + 5 * i, t = n[e] | n[e + 1] << 8 | n[e + 2] << 16 | n[e + 3] << 24, s = n[e + 4];
			if (1 & s) {
				const e = this.pendingPipeReaders.get(t);
				if (e && e.length > 0) {
					this.pendingPipeReaders.delete(t);
					for (const t of e) this.processes.has(t.pid) && this.retrySyscall(t.channel);
				}
			}
			if (2 & s) {
				const e = this.pendingPipeWriters.get(t);
				if (e && e.length > 0) {
					this.pendingPipeWriters.delete(t);
					for (const t of e) this.processes.has(t.pid) && this.retrySyscall(t.channel);
				}
			}
			4 & s && this.wakeBlockedAccept(t), r = !0;
		}
		r && (this.anyPendingRetryNeedsSignalSafeWake() ? this.scheduleWakeBlockedRetriesDeferred() : this.scheduleWakeBlockedRetries());
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
		for (const [n, r] of this.pendingPollRetries) {
			if (!r.needsSignalSafeWake) continue;
			null !== r.timer && clearTimeout(r.timer);
			const i = r.deadline && r.deadline > 0 ? Math.max(1, r.deadline - t) : e;
			r.timer = setTimeout(() => {
				this.pendingPollRetries.delete(n), this.processes.has(r.channel.pid) && this.retrySyscall(r.channel);
			}, Math.max(1, Math.min(e, i)));
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
		for (const [n, r] of e) this.processes.has(r.channel.pid) && (null !== r.timer && clearTimeout(r.timer), this.retrySyscall(r.channel));
		for (const [, n] of t) this.processes.has(n.channel.pid) && (clearTimeout(n.timer), clearImmediate(n.timer), n.syscallNr === Et ? this.handleSelect(n.channel, n.origArgs) : this.handlePselect6(n.channel, n.origArgs));
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
		for (const [t, n] of this.pendingPipeReaders) {
			const r = n.filter((t) => t.pid !== e);
			0 === r.length ? this.pendingPipeReaders.delete(t) : this.pendingPipeReaders.set(t, r);
		}
	}
	cleanupPendingPipeWriters(e) {
		for (const [t, n] of this.pendingPipeWriters) {
			const r = n.filter((t) => t.pid !== e);
			0 === r.length ? this.pendingPipeWriters.delete(t) : this.pendingPipeWriters.set(t, r);
		}
	}
	clearSocketTimeout(e) {
		const t = this.socketTimeoutTimers.get(e);
		void 0 !== t && (clearTimeout(t), this.socketTimeoutTimers.delete(e));
	}
	removePendingPipeReader(e) {
		for (const [t, n] of this.pendingPipeReaders) {
			const r = n.filter((t) => t.channel !== e);
			0 === r.length ? this.pendingPipeReaders.delete(t) : r.length !== n.length && this.pendingPipeReaders.set(t, r);
		}
	}
	removePendingPipeWriter(e) {
		for (const [t, n] of this.pendingPipeWriters) {
			const r = n.filter((t) => t.channel !== e);
			0 === r.length ? this.pendingPipeWriters.delete(t) : r.length !== n.length && this.pendingPipeWriters.set(t, r);
		}
	}
	handleThreadCancel(e, t) {
		const n = t[0], r = this.processes.get(e.pid);
		if (this.completeChannelRaw(e, 0, 0), this.relistenChannel(e), !r) return;
		let i;
		for (const l of r.channels) {
			const t = this.channelTids.get(`${e.pid}:${l.channelOffset}`);
			if ((void 0 !== t ? t : e.pid) === n) {
				i = l;
				break;
			}
		}
		if (!i) return;
		this.pendingCancels.add(i.channelOffset);
		const s = this.pendingFutexWaits.get(i.channelOffset);
		if (s) {
			const e = new Int32Array(i.memory.buffer);
			Atomics.notify(e, s.futexIndex, 1);
			return;
		}
		const o = this.pendingPollRetries.get(i.channelOffset);
		if (o) return null !== o.timer && clearTimeout(o.timer), this.pendingPollRetries.delete(i.channelOffset), this.completeChannelRaw(i, -4, 4), void this.relistenChannel(i);
		const a = this.pendingSelectRetries.get(i.channelOffset);
		if (a && a.channel === i) return clearTimeout(a.timer), clearImmediate(a.timer), this.pendingSelectRetries.delete(i.channelOffset), this.completeChannelRaw(i, -4, 4), void this.relistenChannel(i);
		let c = !1;
		for (const [l, h] of this.pendingPipeReaders) {
			const e = h.filter((e) => e.channel !== i);
			e.length !== h.length && (0 === e.length ? this.pendingPipeReaders.delete(l) : this.pendingPipeReaders.set(l, e), c = !0);
		}
		for (const [l, h] of this.pendingPipeWriters) {
			const e = h.filter((e) => e.channel !== i);
			e.length !== h.length && (0 === e.length ? this.pendingPipeWriters.delete(l) : this.pendingPipeWriters.set(l, e), c = !0);
		}
		c && (this.clearSocketTimeout(i), this.completeChannelRaw(i, -4, 4), this.relistenChannel(i));
	}
	dumpProfile() {
		if (!this.profileData) return void console.error("[profile] Profiling not enabled. Set WASM_POSIX_PROFILE=1");
		const e = Array.from(this.profileData.entries()).sort((e, t) => t[1].totalTimeMs - e[1].totalTimeMs);
		let t = 0, n = 0, r = 0;
		console.error("\n=== Syscall Profile ==="), console.error(`${"Syscall".padEnd(8)} ${"Count".padStart(10)} ${"Time(ms)".padStart(12)} ${"Avg(ms)".padStart(10)} ${"Retries".padStart(10)}`), console.error("-".repeat(52));
		for (const [i, s] of e) t += s.count, n += s.totalTimeMs, r += s.retries, console.error(`${String(i).padEnd(8)} ${String(s.count).padStart(10)} ${s.totalTimeMs.toFixed(2).padStart(12)} ${(s.totalTimeMs / s.count).toFixed(3).padStart(10)} ${String(s.retries).padStart(10)}`);
		console.error("-".repeat(52)), console.error(`${"TOTAL".padEnd(8)} ${String(t).padStart(10)} ${n.toFixed(2).padStart(12)} ${(n / (t || 1)).toFixed(3).padStart(10)} ${String(r).padStart(10)}`), console.error(`Pending pipe readers: ${this.pendingPipeReaders.size}, writers: ${this.pendingPipeWriters.size}`), console.error("=== End Profile ===\n");
	}
	flushTcpSendPipes(e) {
		const t = this.tcpConnections.get(e);
		if (!t || 0 === t.length) return;
		const n = this.kernelInstance.exports.kernel_pipe_read, r = this.getKernelMem();
		for (const i of t) {
			for (;;) {
				const e = n(0, i.sendPipeIdx, this.toKernelPtr(i.scratchOffset), 65536);
				if (e <= 0) break;
				const t = Buffer.from(r.slice(i.scratchOffset, i.scratchOffset + e));
				i.clientSocket.destroyed || i.clientSocket.write(t);
			}
			i.schedulePump();
		}
	}
	handleBlockingRetry(e, t, n) {
		if (!this.processes.has(e.pid)) return;
		if (t === bt && !(127 & n[1])) {
			const t = n[0], r = n[2], i = new Int32Array(e.memory.buffer), s = t >>> 2;
			if (Atomics.load(i, s) !== r) return void this.retrySyscall(e);
			const o = Atomics.waitAsync(i, s, r);
			o.async ? o.value.then(() => {
				this.processes.has(e.pid) && this.retrySyscall(e);
			}) : setImmediate(() => this.retrySyscall(e));
			return;
		}
		if (t === At || t === It) {
			let r = -1;
			const i = t === It && 0 !== n[3];
			if (t === At) r = n[2];
			else {
				const t = n[2];
				if (0 !== t) {
					const n = new DataView(e.memory.buffer, t), i = Number(n.getBigInt64(0, !0)), s = Number(n.getBigInt64(8, !0));
					r = 1e3 * i + Math.floor(s / 1e6);
				}
			}
			if (0 === r) return void this.completeChannel(e, t, n, Re[t], 0, 0);
			const { pipeIndices: s, acceptIndices: o } = this.resolvePollReadinessIndices(e.pid, n), a = n[1];
			if (r > 0 && 0 === a) {
				const a = setTimeout(() => {
					this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.completeChannel(e, t, n, Re[t], 0, 0);
				}, r);
				this.pendingPollRetries.set(e.channelOffset, {
					timer: a,
					channel: e,
					pipeIndices: s,
					acceptIndices: o,
					needsSignalSafeWake: i,
					deadline: Date.now() + r
				});
				return;
			}
			const c = r > 0 ? Date.now() + r : -1, l = () => {
				this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && (c > 0 && Date.now() >= c ? this.completeChannel(e, t, n, Re[t], 0, 0) : this.retrySyscall(e));
			}, h = s.length > 0 || o.length > 0 ? c > 0 ? Math.min(c - Date.now(), 10) : 10 : c > 0 ? Math.min(c - Date.now(), 50) : 50, d = setTimeout(l, Math.max(h, 1));
			this.pendingPollRetries.set(e.channelOffset, {
				timer: d,
				channel: e,
				pipeIndices: s,
				acceptIndices: o,
				needsSignalSafeWake: i,
				deadline: c
			});
			return;
		}
		if (t === Ht) {
			const r = n[2];
			if (0 === r) return void setTimeout(() => {
				this.processes.has(e.pid) && this.retrySyscall(e);
			}, 500);
			const i = new DataView(e.memory.buffer, r), s = Number(i.getBigInt64(0, !0)), o = Number(i.getBigInt64(8, !0)), a = 1e3 * s + Math.floor(o / 1e6), c = 11;
			a <= 0 ? this.completeChannel(e, t, n, Re[t], -1, c) : setTimeout(() => {
				this.processes.has(e.pid) && this.completeChannel(e, t, n, Re[t], -1, c);
			}, a);
			return;
		}
		if (function(e, t) {
			let n;
			switch (e) {
				case sn:
				case on:
				case an:
				case cn:
					n = t[3];
					break;
				case ln:
				case hn:
					n = t[2];
					break;
				default: return !1;
			}
			return void 0 !== n && !!(64 & n);
		}(t, n)) return void this.completeChannel(e, t, n, Re[t], -1, yt);
		if (Cn.has(t) || En.has(t) || t === dn || t === fn || t === un) {
			const r = n[0], i = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (i && 1 === i(e.pid, r)) return void this.completeChannel(e, t, n, Re[t], -1, yt);
		}
		if (t === bn || t === An) {
			const r = n[0], i = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (i && 1 === i(e.pid, r)) return void this.completeChannel(e, t, n, Re[t], -1, yt);
		}
		if (Cn.has(t) || En.has(t)) {
			const r = n[0], i = this.kernelInstance.exports.kernel_get_socket_timeout_ms;
			if (i && !this.socketTimeoutTimers.has(e)) {
				const s = Cn.has(t) ? 1 : 0, o = Number(i(e.pid, r, s));
				if (o > 0) {
					const r = setTimeout(() => {
						this.socketTimeoutTimers.delete(e), this.removePendingPipeReader(e), this.processes.has(e.pid) && this.completeChannel(e, t, n, Re[t], -1, 110);
					}, o);
					this.socketTimeoutTimers.set(e, r);
				}
			}
		}
		if (Cn.has(t)) {
			const r = n[0], i = this.kernelInstance.exports.kernel_get_fd_pipe_idx;
			if (i) {
				const n = i(e.pid, r);
				if (n >= 0) {
					let r = this.pendingPipeReaders.get(n);
					if (r || (r = [], this.pendingPipeReaders.set(n, r)), r.some((t) => t.channel === e) || r.push({
						channel: e,
						pid: e.pid
					}), In) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (En.has(t)) {
			const r = n[0], i = this.kernelInstance.exports.kernel_get_fd_send_pipe_idx;
			if (i) {
				const n = i(e.pid, r);
				if (n >= 0) {
					let r = this.pendingPipeWriters.get(n);
					if (r || (r = [], this.pendingPipeWriters.set(n, r)), r.some((t) => t.channel === e) || r.push({
						channel: e,
						pid: e.pid
					}), In) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (t === dn || t === fn) {
			const r = n[0], i = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
			if (i) {
				const n = i(e.pid, r);
				if (n >= 0) {
					const r = setTimeout(() => {
						this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.retrySyscall(e);
					}, 10);
					if (this.pendingPollRetries.set(e.channelOffset, {
						timer: r,
						channel: e,
						pipeIndices: [],
						acceptIndices: [n]
					}), In) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (In) {
			const e = this.profileData.get(t);
			e && e.retries++;
		}
		const r = setTimeout(() => {
			this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.retrySyscall(e);
		}, 10);
		this.pendingPollRetries.set(e.channelOffset, {
			timer: r,
			channel: e,
			pipeIndices: []
		});
	}
	retrySyscall(e) {
		const t = this.kernelInstance.exports.kernel_get_process_exit_status;
		t && t(e.pid) >= 128 ? this.handleProcessTerminated(e) : this.handleSyscall(e);
	}
	handleSleepDelay(e, t, n, r, i) {
		let s = 0;
		if (t === wt && r >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), n = e.getUint32(80, !0);
			s = 1e3 * t + Math.floor(n / 1e6);
		} else if (t === St && r >= 0) {
			const e = n[0] >>> 0;
			s = Math.max(1, Math.floor(e / 1e3));
		} else if (t === kt && r >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), n = e.getUint32(80, !0);
			s = 1e3 * t + Math.floor(n / 1e6);
		}
		if (s > 0) {
			const o = setTimeout(() => {
				this.pendingSleeps.delete(e.pid), this.processes.has(e.pid) && this.completeSleepWithSignalCheck(e, t, n, r, i);
			}, s);
			return this.pendingSleeps.set(e.pid, {
				timer: o,
				channel: e,
				syscallNr: t,
				origArgs: n,
				retVal: r,
				errVal: i
			}), !0;
		}
		return !1;
	}
	completeSleepWithSignalCheck(e, t, n, r, i) {
		this.dequeueSignalForDelivery(e), new DataView(e.memory.buffer, e.channelOffset).getUint32(65560, !0) > 0 ? this.completeChannel(e, t, n, Re[t], -1, 4) : this.completeChannel(e, t, n, Re[t], r, i);
	}
	handleFcntlLock(e, t) {
		const n = t[2], r = new Uint8Array(e.memory.buffer), i = this.getKernelMem(), s = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72;
		0 !== n && i.set(r.subarray(n, n + 32), o), s.setUint32(4, yn, !0), s.setBigInt64(8, BigInt(t[0]), !0), s.setBigInt64(16, BigInt(t[1]), !0), s.setBigInt64(24, BigInt(0 !== n ? o : 0), !0);
		for (let h = 3; h < 6; h++) s.setBigInt64(8 + 8 * h, BigInt(t[h]), !0);
		const a = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			a(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const c = Number(s.getBigInt64(56, !0)), l = s.getUint32(64, !0);
		0 !== n && c >= 0 && new Uint8Array(e.memory.buffer).set(i.subarray(o, o + 32), n), this.completeChannel(e, yn, t, void 0, c, l);
	}
	handleSelect(e, t) {
		const n = 128, r = t[0], i = t[1], s = t[2], o = t[3], a = t[4];
		let c = -1;
		if (0 !== a) {
			const t = this.getPtrWidth(e.pid), n = new DataView(e.memory.buffer, a);
			let r, i;
			8 === t ? (r = Number(n.getBigInt64(0, !0)), i = Number(n.getBigInt64(8, !0))) : (r = n.getInt32(0, !0), i = n.getInt32(4, !0)), c = 1e3 * r + Math.floor(i / 1e3), c < 0 && (c = 0);
		}
		if (0 === r && 0 === i && 0 === s && 0 === o) {
			if (0 === c) return void this.completeChannel(e, Et, t, void 0, 0, 0);
			const n = c > 0, r = n ? setTimeout(() => {
				this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.completeChannel(e, Et, t, void 0, 0, 0);
			}, c) : null;
			this.pendingSelectRetries.set(e.channelOffset, {
				timer: r,
				channel: e,
				origArgs: t,
				deadline: n ? Date.now() + c : -1,
				needsSignalSafeWake: !1,
				syscallNr: Et
			});
			return;
		}
		const l = new Uint8Array(e.memory.buffer), h = this.getKernelMem(), d = new DataView(this.kernelMemory.buffer, this.scratchOffset), f = this.scratchOffset + 72;
		0 !== i ? h.set(l.subarray(i, i + n), f) : h.fill(0, f, f + n), 0 !== s ? h.set(l.subarray(s, s + n), f + n) : h.fill(0, f + n, f + 256), 0 !== o ? h.set(l.subarray(o, o + n), f + 256) : h.fill(0, f + 256, f + 384), d.setUint32(4, Et, !0), d.setBigInt64(8, BigInt(r), !0), d.setBigInt64(16, BigInt(0 !== i ? f : 0), !0), d.setBigInt64(24, BigInt(0 !== s ? f + n : 0), !0), d.setBigInt64(32, BigInt(0 !== o ? f + 256 : 0), !0), d.setBigInt64(40, BigInt(c), !0);
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
			0 !== i && t.set(h.subarray(f, f + n), i), 0 !== s && t.set(h.subarray(f + n, f + 256), s), 0 !== o && t.set(h.subarray(f + 256, f + 384), o);
		}
		if (this.dequeueSignalForDelivery(e), -1 === p && g === yt) {
			if (0 === c) return void this.completeChannel(e, Et, t, void 0, 0, 0);
			const n = c > 0 ? Date.now() + c : -1, r = () => {
				this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && (n > 0 && Date.now() >= n ? this.completeChannel(e, Et, t, void 0, 0, 0) : this.handleSelect(e, t));
			}, i = c > 0 ? Math.max(n - Date.now(), 1) : 50, s = setTimeout(r, Math.min(i, 50));
			this.pendingSelectRetries.set(e.channelOffset, {
				timer: s,
				channel: e,
				origArgs: t,
				deadline: n,
				needsSignalSafeWake: !1,
				syscallNr: Et
			});
			return;
		}
		this.completeChannel(e, Et, t, void 0, p, g);
	}
	handlePselect6(e, t) {
		const n = 128, r = new Uint8Array(e.memory.buffer), i = this.getKernelMem(), s = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72, a = t[0], c = t[1], l = t[2], h = t[3], d = t[4], f = t[5];
		0 !== c ? i.set(r.subarray(c, c + n), o) : i.fill(0, o, o + n), 0 !== l ? i.set(r.subarray(l, l + n), o + n) : i.fill(0, o + n, o + 256), 0 !== h ? i.set(r.subarray(h, h + n), o + 256) : i.fill(0, o + 256, o + 384);
		let u = -1;
		if (0 !== d) {
			const t = new DataView(e.memory.buffer, d), n = Number(t.getBigInt64(0, !0)), r = Number(t.getBigInt64(8, !0));
			u = 1e3 * n + Math.floor(r / 1e6);
		}
		const p = o + 384;
		let g = 0;
		if (0 !== f) {
			const t = this.getPtrWidth(e.pid), n = new DataView(e.memory.buffer, f), s = 8 === t ? Number(n.getBigUint64(0, !0)) : n.getUint32(0, !0);
			0 !== s && (i.set(r.subarray(s, s + 8), p), g = p);
		}
		s.setUint32(4, Ct, !0), s.setBigInt64(8, BigInt(a), !0), s.setBigInt64(16, BigInt(0 !== c ? o : 0), !0), s.setBigInt64(24, BigInt(0 !== l ? o + n : 0), !0), s.setBigInt64(32, BigInt(0 !== h ? o + 256 : 0), !0), s.setBigInt64(40, BigInt(u), !0), s.setBigInt64(48, BigInt(g), !0);
		const m = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			m(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const _ = Number(s.getBigInt64(56, !0)), y = s.getUint32(64, !0);
		if (_ >= 0) {
			const t = new Uint8Array(e.memory.buffer);
			0 !== c && t.set(i.subarray(o, o + n), c), 0 !== l && t.set(i.subarray(o + n, o + 256), l), 0 !== h && t.set(i.subarray(o + 256, o + 384), h);
		}
		if (this.dequeueSignalForDelivery(e), -1 === _ && y === yt) {
			if (0 === u) return void this.completeChannel(e, Ct, t, void 0, 0, 0);
			const n = u > 0 ? Date.now() + u : -1, r = 0 !== f;
			if (0 === a) {
				if (u > 0) {
					const i = setTimeout(() => {
						this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.completeChannel(e, Ct, t, void 0, 0, 0);
					}, u);
					this.pendingSelectRetries.set(e.channelOffset, {
						timer: i,
						channel: e,
						origArgs: t,
						deadline: n,
						needsSignalSafeWake: r,
						syscallNr: Ct
					});
				} else this.pendingSelectRetries.set(e.channelOffset, {
					timer: null,
					channel: e,
					origArgs: t,
					deadline: -1,
					needsSignalSafeWake: r,
					syscallNr: Ct
				});
				return;
			}
			const i = setImmediate(() => {
				this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && (n > 0 && Date.now() >= n ? this.completeChannel(e, Ct, t, void 0, 0, 0) : this.handlePselect6(e, t));
			});
			this.pendingSelectRetries.set(e.channelOffset, {
				timer: i,
				channel: e,
				origArgs: t,
				deadline: n,
				needsSignalSafeWake: r,
				syscallNr: Ct
			});
			return;
		}
		this.completeChannel(e, Ct, t, void 0, _, y);
	}
	handleEpollCreate(e, t, n) {
		const r = new DataView(this.kernelMemory.buffer, this.scratchOffset), i = n[0], s = t === Tt ? 0 : i;
		r.setUint32(4, t, !0), r.setBigInt64(8, BigInt(s), !0);
		for (let l = 1; l < 6; l++) r.setBigInt64(8 + 8 * l, 0n, !0);
		const o = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			o(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const a = Number(r.getBigInt64(56, !0)), c = r.getUint32(64, !0);
		if (a >= 0) {
			const t = `${e.pid}:${a}`;
			this.epollInterests.set(t, []);
		}
		this.completeChannel(e, t, n, void 0, a, c);
	}
	handleEpollCtl(e, t) {
		const n = t[0], r = t[1], i = t[2], s = t[3];
		let o = 0, a = 0n;
		if (0 !== s) {
			const t = new DataView(e.memory.buffer, s);
			o = t.getUint32(0, !0), a = t.getBigUint64(4, !0);
		}
		const c = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.getKernelMem(), h = this.scratchOffset + 72;
		if (0 !== s) {
			const t = new Uint8Array(e.memory.buffer);
			l.set(t.subarray(s, s + 12), h);
		}
		c.setUint32(4, Pt, !0), c.setBigInt64(8, BigInt(n), !0), c.setBigInt64(16, BigInt(r), !0), c.setBigInt64(24, BigInt(i), !0), c.setBigInt64(32, BigInt(0 !== s ? h : 0), !0), c.setBigInt64(40, BigInt(0), !0), c.setBigInt64(48, BigInt(0), !0);
		const d = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			d(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const f = Number(c.getBigInt64(56, !0)), u = c.getUint32(64, !0);
		if (0 === f) {
			const t = 1, s = 2, c = 3, l = `${e.pid}:${n}`;
			let h = this.epollInterests.get(l);
			if (h || (h = [], this.epollInterests.set(l, h)), r === t) h.push({
				fd: i,
				events: o,
				data: a
			});
			else if (r === s) {
				const e = h.findIndex((e) => e.fd === i);
				e >= 0 && h.splice(e, 1);
			} else if (r === c) {
				const e = h.find((e) => e.fd === i);
				e && (e.events = o, e.data = a);
			}
		}
		this.completeChannel(e, Pt, t, void 0, f, u);
	}
	handleEpollPwait(e, t, n) {
		const r = n[0], i = n[1], s = n[2], o = n[3];
		if (s <= 0) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const a = `${e.pid}:${r}`, c = this.epollInterests.get(a);
		if (!c) return this.completeChannelRaw(e, -9, 9), void this.relistenChannel(e);
		if (0 === c.length) {
			if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
			const r = setTimeout(() => {
				this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.handleEpollPwait(e, t, n);
			}, 10);
			this.pendingPollRetries.set(e.channelOffset, {
				timer: r,
				channel: e,
				pipeIndices: []
			});
			return;
		}
		const l = c.length;
		if (8 * l > 65536) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		this.getKernelMem();
		const h = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72;
		for (let w = 0; w < l; w++) {
			const e = c[w], t = d + 8 * w;
			let n = 0;
			1 & e.events && (n |= 1), 4 & e.events && (n |= 4), new DataView(this.kernelMemory.buffer).setInt32(t, e.fd, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 4, n, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 6, 0, !0);
		}
		h.setUint32(4, At, !0), h.setBigInt64(8, BigInt(d), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(0), !0);
		for (let w = 3; w < 6; w++) h.setBigInt64(8 + 8 * w, 0n, !0);
		const f = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			f(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const u = Number(h.getBigInt64(56, !0)), p = h.getUint32(64, !0);
		if (this.dequeueSignalForDelivery(e), u < 0 && p !== yt) return this.completeChannelRaw(e, u, p), void this.relistenChannel(e);
		let g = 0;
		if (u > 0) {
			const t = new DataView(e.memory.buffer);
			for (let e = 0; e < l && g < s; e++) {
				const n = d + 8 * e, r = new DataView(this.kernelMemory.buffer).getInt16(n + 6, !0);
				if (0 !== r) {
					let n = 0;
					1 & r && (n |= 1), 4 & r && (n |= 4), 8 & r && (n |= 8), 16 & r && (n |= 16);
					const s = i + 12 * g;
					t.setUint32(s, n, !0), t.setBigUint64(s + 4, c[e].data, !0), g++;
				}
			}
		}
		if (g > 0) return this.completeChannelRaw(e, g, 0), void this.relistenChannel(e);
		if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
		const { pipeIndices: m, acceptIndices: _ } = this.resolveEpollReadinessIndices(e.pid), y = setTimeout(() => {
			this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.handleEpollPwait(e, t, n);
		}, 10);
		this.pendingPollRetries.set(e.channelOffset, {
			timer: y,
			channel: e,
			pipeIndices: m,
			acceptIndices: _
		});
	}
	handleIoctlIfconf(e, t) {
		const n = new DataView(e.memory.buffer), r = new Uint8Array(e.memory.buffer), i = this.getPtrWidth(e.pid), s = t[2], o = n.getInt32(s, !0);
		let a;
		a = 8 === i ? Number(n.getBigUint64(s + 8, !0)) : n.getUint32(s + 4, !0);
		if (o >= 32 && 0 !== a) {
			const e = new TextEncoder().encode("eth0");
			r.set(e, a), r.fill(0, a + e.length, a + 16), r.fill(0, a + 16, a + 32), n.setUint16(a + 16, 2, !0), r[a + 20] = 127, r[a + 21] = 0, r[a + 22] = 0, r[a + 23] = 1, n.setInt32(s, 32, !0);
		} else n.setInt32(s, 0, !0);
		this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	handleIoctlIfhwaddr(e, t) {
		const n = new DataView(e.memory.buffer), r = new Uint8Array(e.memory.buffer), i = t[2];
		r.fill(0, i + 16, i + 32), n.setUint16(i + 16, 1, !0), r.set(this.virtualMacAddress, i + 18), this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	handleIoctlIfaddr(e, t) {
		const n = new DataView(e.memory.buffer), r = new Uint8Array(e.memory.buffer), i = t[2];
		r.fill(0, i + 16, i + 32), n.setUint16(i + 16, 2, !0), r[i + 20] = 127, r[i + 21] = 0, r[i + 22] = 0, r[i + 23] = 1, this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	handleWritev(e, t, n) {
		const r = n[0], i = n[1], s = n[2], o = new Uint8Array(e.memory.buffer), a = new DataView(e.memory.buffer), c = this.getKernelMem(), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.scratchOffset + 72, d = this.getPtrWidth(e.pid), f = 8 === d ? 16 : 8, u = [];
		let p = 0;
		for (let g = 0; g < s; g++) {
			let e, t;
			8 === d ? (e = Number(a.getBigUint64(i + g * f, !0)), t = Number(a.getBigUint64(i + g * f + 8, !0))) : (e = a.getUint32(i + g * f, !0), t = a.getUint32(i + g * f + 4, !0)), u.push({
				base: e,
				len: t
			}), p += t;
		}
		const m = 8 * s;
		if (p <= g - m) {
			let i = m;
			for (let e = 0; e < s; e++) {
				const t = h + i;
				u[e].len > 0 && c.set(o.subarray(u[e].base, u[e].base + u[e].len), t);
				const n = h + 8 * e;
				new DataView(c.buffer).setUint32(n, t, !0), new DataView(c.buffer).setUint32(n + 4, u[e].len, !0), i += u[e].len, i = i + 3 & -4;
			}
			l.setUint32(4, t, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(s), !0), t === _n && (l.setBigInt64(32, BigInt(n[3]), !0), l.setBigInt64(40, BigInt(n[4]), !0));
			const a = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				a(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const d = Number(l.getBigInt64(56, !0)), f = l.getUint32(64, !0);
			if (-1 === d && f === yt) return void this.handleBlockingRetry(e, t, n);
			this.completeChannel(e, t, n, void 0, d, f);
		} else {
			const i = this.kernelInstance.exports.kernel_handle_channel, s = t === _n;
			let a = s ? (0 | n[3]) + 4294967296 * (0 | n[4]) : 0, d = 0, f = !1;
			const p = 65528;
			for (const t of u) {
				if (0 === t.len) continue;
				let n = 0;
				for (; n < t.len;) {
					const u = Math.min(t.len - n, p), g = h + 8;
					c.set(o.subarray(t.base + n, t.base + n + u), g), new DataView(c.buffer).setUint32(h, g, !0), new DataView(c.buffer).setUint32(h + 4, u, !0), s ? (l.setUint32(4, _n, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0), l.setBigInt64(32, BigInt(4294967295 & a), !0), l.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (l.setUint32(4, pn, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0)), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
					try {
						i(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					const m = Number(l.getBigInt64(56, !0)), _ = l.getUint32(64, !0);
					if (-1 === m) {
						_ === yt && 0 === d && (f = !0);
						break;
					}
					if (n += m, d += m, s && (a += m), m < u) break;
				}
				if (f || n < t.len) break;
			}
			if (f) return void this.handleBlockingRetry(e, t, n);
			this.completeChannelRaw(e, d, 0), this.relistenChannel(e);
		}
	}
	handleLargeWrite(e, t, n) {
		const r = n[0], i = n[1], s = n[2], o = t === rn;
		let a = o ? n[3] : 0;
		const c = new Uint8Array(e.memory.buffer), l = this.getKernelMem(), h = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72, f = this.kernelInstance.exports.kernel_handle_channel;
		let u = 0;
		for (; u < s;) {
			const p = Math.min(s - u, g);
			l.set(c.subarray(i + u, i + u + p), d), h.setUint32(4, t, !0), h.setBigInt64(8, BigInt(r), !0), h.setBigInt64(16, BigInt(d), !0), h.setBigInt64(24, BigInt(p), !0), o && h.setBigInt64(32, BigInt(a), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				f(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch ($n) {
				console.error(`[handleLargeWrite] kernel threw for pid=${e.pid}:`, $n), u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			const m = Number(h.getBigInt64(56, !0)), _ = h.getUint32(64, !0);
			if (-1 === m && _ === yt) return u > 0 ? (this.completeChannelRaw(e, u, 0), void this.relistenChannel(e)) : void this.handleBlockingRetry(e, t, n);
			if (0 !== _ || m <= 0) return u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, m, _), void this.relistenChannel(e);
			if (u += m, o && (a += m), m < p) break;
		}
		this.dequeueSignalForDelivery(e), this.completeChannelRaw(e, u, 0), this.relistenChannel(e);
	}
	handleLargeRead(e, t, n) {
		const r = n[0], i = n[1], s = n[2], o = t === nn;
		let a = o ? n[3] : 0;
		const c = new Uint8Array(e.memory.buffer), l = this.getKernelMem(), h = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72, f = this.kernelInstance.exports.kernel_handle_channel;
		let u = 0;
		for (; u < s;) {
			const p = Math.min(s - u, g);
			l.fill(0, d, d + p), h.setUint32(4, t, !0), h.setBigInt64(8, BigInt(r), !0), h.setBigInt64(16, BigInt(d), !0), h.setBigInt64(24, BigInt(p), !0), o && h.setBigInt64(32, BigInt(a), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				f(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch ($n) {
				console.error(`[handleLargeRead] kernel threw for pid=${e.pid}:`, $n), u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			const m = Number(h.getBigInt64(56, !0)), _ = h.getUint32(64, !0);
			if (-1 === m && _ === yt) return u > 0 ? (this.completeChannelRaw(e, u, 0), void this.relistenChannel(e)) : void this.handleBlockingRetry(e, t, n);
			if (0 !== _ || m <= 0) return u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, m, _), void this.relistenChannel(e);
			if (c.set(l.subarray(d, d + m), i + u), u += m, o && (a += m), m < p) break;
		}
		this.dequeueSignalForDelivery(e), this.completeChannelRaw(e, u, 0), this.relistenChannel(e);
	}
	handleReadv(e, t, n) {
		const r = n[0], i = n[1], s = n[2], o = new Uint8Array(e.memory.buffer), a = new DataView(e.memory.buffer), c = this.getKernelMem(), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.scratchOffset + 72, d = this.getPtrWidth(e.pid), f = 8 === d ? 16 : 8, u = [];
		let p = 0;
		for (let g = 0; g < s; g++) {
			let e, t;
			8 === d ? (e = Number(a.getBigUint64(i + g * f, !0)), t = Number(a.getBigUint64(i + g * f + 8, !0))) : (e = a.getUint32(i + g * f, !0), t = a.getUint32(i + g * f + 4, !0)), u.push({
				base: e,
				len: t
			}), p += t;
		}
		if (p <= 65528 && s <= Math.floor(8192)) {
			let i = 8 * s;
			const a = [];
			for (let e = 0; e < s; e++) {
				const t = h + i;
				a.push({
					base: u[e].base,
					kernelBase: t,
					len: u[e].len
				}), u[e].len > 0 && c.fill(0, t, t + u[e].len);
				const n = h + 8 * e;
				new DataView(c.buffer).setUint32(n, t, !0), new DataView(c.buffer).setUint32(n + 4, u[e].len, !0), i += u[e].len, i = i + 3 & -4;
			}
			l.setUint32(4, t, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(s), !0), t === mn && (l.setBigInt64(32, BigInt(n[3]), !0), l.setBigInt64(40, BigInt(n[4]), !0));
			const d = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				d(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const f = Number(l.getBigInt64(56, !0)), p = l.getUint32(64, !0);
			if (-1 === f && p === yt) return void this.handleBlockingRetry(e, t, n);
			if (f > 0) {
				let e = f;
				for (const t of a) {
					if (e <= 0) break;
					const n = Math.min(t.len, e);
					o.set(c.subarray(t.kernelBase, t.kernelBase + n), t.base), e -= n;
				}
			}
			this.completeChannel(e, t, n, void 0, f, p);
		} else {
			const i = this.kernelInstance.exports.kernel_handle_channel, s = t === mn;
			let a = s ? (0 | n[3]) + 4294967296 * (0 | n[4]) : 0, d = 0, f = 0, p = !1;
			for (const t of u) {
				if (0 === t.len) continue;
				let n = 0;
				for (; n < t.len;) {
					const u = Math.min(t.len - n, 65528), g = h + 8;
					new DataView(c.buffer).setUint32(h, g, !0), new DataView(c.buffer).setUint32(h + 4, u, !0), c.fill(0, g, g + u), s ? (l.setUint32(4, mn, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0), l.setBigInt64(32, BigInt(4294967295 & a), !0), l.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (l.setUint32(4, gn, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0)), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
					try {
						i(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					const m = Number(l.getBigInt64(56, !0)), _ = l.getUint32(64, !0);
					if (-1 === m) {
						if (_ === yt && 0 === d) {
							p = !0;
							break;
						}
						f = _;
						break;
					}
					if (0 === m) break;
					if (o.set(c.subarray(g, g + m), t.base + n), n += m, d += m, s && (a += m), m < u) break;
				}
				if (p || f) break;
			}
			if (p) return void this.handleBlockingRetry(e, t, n);
			const g = d > 0 ? d : f ? -1 : 0, m = d > 0 ? 0 : f;
			this.completeChannel(e, t, n, void 0, g, m);
		}
	}
	handleSendmsg(e, t) {
		const n = t[0], r = t[1], i = t[2], s = new Uint8Array(e.memory.buffer), o = new DataView(e.memory.buffer), a = this.getKernelMem(), c = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.scratchOffset + 72, h = this.getPtrWidth(e.pid);
		let d, f, u, p, g, m;
		8 === h ? (d = Number(o.getBigUint64(r, !0)), f = o.getUint32(r + 8, !0), u = Number(o.getBigUint64(r + 16, !0)), p = o.getUint32(r + 24, !0), g = Number(o.getBigUint64(r + 32, !0)), m = o.getUint32(r + 40, !0)) : (d = o.getUint32(r, !0), f = o.getUint32(r + 4, !0), u = o.getUint32(r + 8, !0), p = o.getUint32(r + 12, !0), g = o.getUint32(r + 16, !0), m = o.getUint32(r + 20, !0));
		const _ = l, y = new DataView(a.buffer);
		y.setUint32(_, d, !0), y.setUint32(_ + 4, f, !0), y.setUint32(_ + 8, u, !0), y.setUint32(_ + 12, p, !0), y.setUint32(_ + 16, g, !0), y.setUint32(_ + 20, m, !0), y.setUint32(_ + 24, 0, !0);
		let w = 28;
		if (0 !== d && f > 0 && w + f <= 65536) {
			const e = l + w;
			a.set(s.subarray(d, d + f), e), y.setUint32(_, e, !0), w += f, w = w + 3 & -4;
		}
		if (0 !== g && m > 0 && w + m <= 65536) {
			const e = l + w;
			a.set(s.subarray(g, g + m), e), y.setUint32(_ + 16, e, !0), w += m, w = w + 3 & -4;
		}
		const S = 8 === h ? 16 : 8;
		if (p > 0 && 0 !== u) {
			const e = l + w;
			w += 8 * p, w = w + 3 & -4, y.setUint32(_ + 8, e, !0);
			for (let t = 0; t < p; t++) {
				let n, r;
				if (8 === h ? (n = Number(o.getBigUint64(u + t * S, !0)), r = Number(o.getBigUint64(u + t * S + 8, !0))) : (n = o.getUint32(u + 8 * t, !0), r = o.getUint32(u + 8 * t + 4, !0)), y.setUint32(e + 8 * t, 0, !0), y.setUint32(e + 8 * t + 4, r, !0), r > 0 && w + r <= 65536) {
					const i = l + w;
					a.set(s.subarray(n, n + r), i), y.setUint32(e + 8 * t, i, !0), w += r, w = w + 3 & -4;
				}
			}
		}
		c.setUint32(4, ln, !0), c.setBigInt64(8, BigInt(n), !0), c.setBigInt64(16, BigInt(_), !0), c.setBigInt64(24, BigInt(i), !0);
		const k = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			k(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const b = Number(c.getBigInt64(56, !0)), A = c.getUint32(64, !0);
		-1 !== b || A !== yt ? this.completeChannel(e, ln, t, void 0, b, A) : this.handleBlockingRetry(e, ln, t);
	}
	handleRecvmsg(e, t) {
		const n = t[0], r = t[1], i = t[2], s = new Uint8Array(e.memory.buffer), o = new DataView(e.memory.buffer), a = this.getKernelMem(), c = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.scratchOffset + 72, h = this.getPtrWidth(e.pid);
		let d, f, u, p, g, m;
		8 === h ? (d = Number(o.getBigUint64(r, !0)), f = o.getUint32(r + 8, !0), u = Number(o.getBigUint64(r + 16, !0)), p = o.getUint32(r + 24, !0), g = Number(o.getBigUint64(r + 32, !0)), m = o.getUint32(r + 40, !0)) : (d = o.getUint32(r, !0), f = o.getUint32(r + 4, !0), u = o.getUint32(r + 8, !0), p = o.getUint32(r + 12, !0), g = o.getUint32(r + 16, !0), m = o.getUint32(r + 20, !0));
		const _ = l, y = new DataView(a.buffer);
		y.setUint32(_, d, !0), y.setUint32(_ + 4, f, !0), y.setUint32(_ + 8, u, !0), y.setUint32(_ + 12, p, !0), y.setUint32(_ + 16, g, !0), y.setUint32(_ + 20, m, !0), y.setUint32(_ + 24, 0, !0);
		let w = 28, S = 0;
		0 !== d && f > 0 && w + f <= 65536 && (S = l + w, a.fill(0, S, S + f), y.setUint32(_, S, !0), w += f, w = w + 3 & -4);
		let k = 0;
		0 !== g && m > 0 && w + m <= 65536 && (k = l + w, a.fill(0, k, k + m), y.setUint32(_ + 16, k, !0), w += m, w = w + 3 & -4);
		const b = [], A = 8 === h ? 16 : 8;
		if (p > 0 && 0 !== u) {
			const e = l + w;
			w += 8 * p, w = w + 3 & -4, y.setUint32(_ + 8, e, !0);
			for (let t = 0; t < p; t++) {
				let n, r;
				if (8 === h ? (n = Number(o.getBigUint64(u + t * A, !0)), r = Number(o.getBigUint64(u + t * A + 8, !0))) : (n = o.getUint32(u + 8 * t, !0), r = o.getUint32(u + 8 * t + 4, !0)), r > 0 && w + r <= 65536) {
					const i = l + w;
					a.fill(0, i, i + r), y.setUint32(e + 8 * t, i, !0), y.setUint32(e + 8 * t + 4, r, !0), b.push({
						base: n,
						len: r,
						kernelBase: i
					}), w += r, w = w + 3 & -4;
				} else y.setUint32(e + 8 * t, 0, !0), y.setUint32(e + 8 * t + 4, r, !0);
			}
		}
		c.setUint32(4, hn, !0), c.setBigInt64(8, BigInt(n), !0), c.setBigInt64(16, BigInt(_), !0), c.setBigInt64(24, BigInt(i), !0);
		const I = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			I(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const C = Number(c.getBigInt64(56, !0)), E = c.getUint32(64, !0);
		if (-1 === C && E === yt) return void this.handleBlockingRetry(e, hn, t);
		if (C > 0) {
			let e = C;
			for (const t of b) {
				if (e <= 0) break;
				const n = Math.min(t.len, e);
				s.set(a.subarray(t.kernelBase, t.kernelBase + n), t.base), e -= n;
			}
		}
		if (0 !== S && 0 !== d && f > 0 && s.set(a.subarray(S, S + f), d), 0 !== k && 0 !== g) {
			const e = y.getUint32(_ + 20, !0);
			e > 0 && e <= m && s.set(a.subarray(k, k + e), g);
		}
		const v = y.getUint32(_ + 4, !0), x = y.getUint32(_ + 20, !0), T = y.getUint32(_ + 24, !0);
		8 === h ? (o.setUint32(r + 8, v, !0), o.setUint32(r + 40, x, !0), o.setUint32(r + 44, T, !0)) : (o.setUint32(r + 4, v, !0), o.setUint32(r + 20, x, !0), o.setUint32(r + 24, T, !0)), this.completeChannel(e, hn, t, void 0, C, E);
	}
	handleFork(e, t) {
		if (!this.callbacks.onFork) return void this.completeChannel(e, Rt, t, void 0, -1, 38);
		const n = e.pid;
		for (; this.processes.has(this.nextChildPid);) this.nextChildPid++;
		const r = this.nextChildPid++, i = (0, this.kernelInstance.exports.kernel_fork_process)(n, r);
		if (i < 0) return void this.completeChannel(e, Rt, t, void 0, -1, -i >>> 0);
		const s = this.kernelInstance.exports.kernel_clear_fork_child;
		s && s(r);
		const o = this.kernelInstance.exports.kernel_reset_signal_mask;
		o && o(r);
		const a = `${n}:${e.channelOffset}`, c = this.threadForkContexts.get(a), l = e.channelOffset - 131072, h = c ? {
			fnPtr: c.fnPtr,
			argPtr: c.argPtr,
			forkBufAddr: e.channelOffset - 16384,
			slotStart: l,
			slotLen: 262144
		} : void 0;
		if (h) try {
			this.reserveHostRegionAt(r, h.slotStart, h.slotLen);
		} catch ($n) {
			this.removeFromKernelProcessTable(r);
			const i = $n instanceof Error ? $n.message : String($n);
			console.error(`[kernel-worker] fork child slot reservation failed: ${i}`), this.completeChannel(e, Rt, t, void 0, -1, 12);
			return;
		}
		this.callbacks.onFork(n, r, e.memory, h).then((i) => {
			if (this.processes.has(n)) {
				for (const [e, t] of this.tcpListenerTargets) {
					const e = t.find((e) => e.pid === n);
					e && !t.some((e) => e.pid === r) && t.push({
						pid: r,
						fd: e.fd
					});
				}
				for (const [e, t] of this.epollInterests) if (e.startsWith(`${n}:`)) {
					const n = e.slice(e.indexOf(":") + 1);
					this.epollInterests.set(`${r}:${n}`, t.map((e) => ({ ...e })));
				}
				this.completeChannel(e, Rt, t, void 0, r, 0);
			}
		}).catch(() => {
			(0, this.kernelInstance.exports.kernel_remove_process)(r), this.completeChannel(e, Rt, t, void 0, -1, 12);
		});
	}
	handleSpawn(e, t) {
		const n = e.pid, r = t[0], i = t[1], s = t[2], o = t[3], a = t[4];
		if (!this.callbacks.onSpawn || !this.callbacks.onResolveSpawn) return void this.completeChannel(e, Dt, t, void 0, -1, 38);
		const c = new Uint8Array(e.memory.buffer);
		let l = "";
		0 !== r && i > 0 && (l = new TextDecoder().decode(c.slice(r, r + i)), l.endsWith("\0") && (l = l.slice(0, -1)));
		const h = l;
		if (l && !l.startsWith("/") && (l = this.resolveExecPathAgainstCwd(n, l)), o <= 0 || 0 === s && o > 0) return void this.completeChannel(e, Dt, t, void 0, -1, 22);
		const d = c.slice(s, s + o);
		let f, u;
		try {
			const e = function(e) {
				if (e.byteLength < 40) throw new Error("blob too short for header");
				const t = new DataView(e.buffer, e.byteOffset, e.byteLength), n = t.getUint32(0, !0), r = t.getUint32(4, !0), i = t.getUint32(8, !0);
				if (n > 4096 || r > 4096 || i > 1024) throw new Error("blob count exceeds limit");
				const s = 40 + 4 * n, o = s + 4 * r + 28 * i;
				if (o > e.byteLength) throw new Error("blob truncated before strings region");
				const a = e.byteLength - o, c = new TextDecoder(), l = (t) => {
					if (t > a) throw new Error("string offset OOB");
					let n = t;
					for (; n < a && 0 !== e[o + n];) n++;
					return c.decode(e.slice(o + t, o + n));
				}, h = [];
				for (let f = 0; f < n; f++) h.push(l(t.getUint32(40 + 4 * f, !0)));
				const d = [];
				for (let f = 0; f < r; f++) d.push(l(t.getUint32(s + 4 * f, !0)));
				return {
					argv: h,
					envp: d
				};
			}(d);
			f = e.argv, u = e.envp;
		} catch (p) {
			this.completeChannel(e, Dt, t, void 0, -1, 22);
			return;
		}
		(async () => {
			const e = await this.callbacks.onResolveSpawn(l, f);
			return e || h === l || !h || h.startsWith("/") ? e : this.callbacks.onResolveSpawn(h, f);
		})().then((r) => {
			if (!r) return void this.completeChannel(e, Dt, t, void 0, -1, 2);
			const i = r instanceof ArrayBuffer ? r : r.programBytes, s = r instanceof ArrayBuffer ? f : r.argv;
			this.handleSpawnAfterResolve(e, t, n, a, d, o, s, u, i);
		}).catch((r) => {
			console.error(`[kernel] spawn resolve error for parent ${n}:`, r), this.completeChannel(e, Dt, t, void 0, -1, 5);
		});
	}
	handleSpawnAfterResolve(e, t, n, r, i, s, o, a, c) {
		const l = new Uint8Array(this.kernelMemory.buffer);
		if (s > l.byteLength - this.scratchOffset) return void this.completeChannel(e, Dt, t, void 0, -1, 22);
		l.set(i, this.scratchOffset);
		const h = (0, this.kernelInstance.exports.kernel_spawn_process)(n, this.toKernelPtr(this.scratchOffset), this.toKernelPtr(s));
		if (h < 0) return void this.completeChannel(e, Dt, t, void 0, -1, -h >>> 0);
		const d = h >>> 0;
		d >= this.nextChildPid && (this.nextChildPid = d + 1), this.callbacks.onSpawn(d, c, o, a).then((n) => {
			if (n < 0) {
				(0, this.kernelInstance.exports.kernel_remove_process)(d), this.completeChannel(e, Dt, t, void 0, -1, -n >>> 0);
				return;
			}
			0 !== r && new DataView(e.memory.buffer).setInt32(r, d, !0), this.completeChannel(e, Dt, t, void 0, 0, 0);
		}).catch((r) => {
			console.error(`[kernel] spawn error for parent ${n}:`, r);
			(0, this.kernelInstance.exports.kernel_remove_process)(d), this.completeChannel(e, Dt, t, void 0, -1, 5);
		});
	}
	readCStringFromProcess(e, t, n = 4096) {
		if (0 === t) return "";
		let r = 0;
		for (; t + r < e.length && 0 !== e[t + r] && r < n;) r++;
		return new TextDecoder().decode(e.slice(t, t + r));
	}
	readStringArrayFromProcess(e, t, n = 4) {
		if (0 === t) return [];
		const r = [], i = new DataView(e.buffer, e.byteOffset, e.byteLength);
		for (let s = 0; s < 1024; s++) {
			let o;
			if (o = 8 === n ? Number(i.getBigUint64(t + 8 * s, !0)) : i.getUint32(t + 4 * s, !0), 0 === o) break;
			r.push(this.readCStringFromProcess(e, o));
		}
		return r;
	}
	handleExec(e, t) {
		const n = new Uint8Array(e.memory.buffer), r = this.getPtrWidth(e.pid);
		let i = this.readCStringFromProcess(n, t[0]);
		const s = this.readStringArrayFromProcess(n, t[1], r), o = this.readStringArrayFromProcess(n, t[2], r);
		i && !i.startsWith("/") && (i = this.resolveExecPathAgainstCwd(e.pid, i)), this.callbacks.onExec ? this.callbacks.onExec(e.pid, i, s, o).then((n) => {
			n < 0 && this.completeChannel(e, Mt, t, void 0, -1, -n >>> 0);
		}).catch((n) => {
			console.error(`[kernel] exec error for pid ${e.pid}:`, n), this.completeChannel(e, Mt, t, void 0, -1, 5);
		}) : this.completeChannel(e, Mt, t, void 0, -1, 38);
	}
	resolveExecPathAgainstCwd(e, t) {
		const n = this.kernelInstance.exports.kernel_get_cwd;
		if (!n) return t;
		const r = n(e, this.toKernelPtr(this.scratchOffset), 4096);
		if (r <= 0) return t;
		const i = new Uint8Array(this.kernelMemory.buffer), s = new TextDecoder().decode(i.slice(this.scratchOffset, this.scratchOffset + r)), o = (s.endsWith("/") ? s + t : s + "/" + t).split("/"), a = [];
		for (const c of o) "." !== c && "" !== c && (".." === c && a.length > 0 ? a.pop() : a.push(c));
		return "/" + a.join("/");
	}
	handleExecveat(e, t) {
		const n = t[0], r = t[4], i = new Uint8Array(e.memory.buffer), s = this.getPtrWidth(e.pid), o = this.readCStringFromProcess(i, t[1]), a = this.readStringArrayFromProcess(i, t[2], s), c = this.readStringArrayFromProcess(i, t[3], s);
		let l;
		if (4096 & r && "" === o) {
			const r = this.kernelInstance.exports.kernel_get_fd_path;
			if (!r) return void this.completeChannel(e, Lt, t, void 0, -1, 38);
			const i = r(e.pid, n, this.toKernelPtr(this.scratchOffset), 4096);
			if (i <= 0) {
				const n = i < 0 ? -i >>> 0 : 2;
				this.completeChannel(e, Lt, t, void 0, -1, n);
				return;
			}
			const s = new Uint8Array(this.kernelMemory.buffer);
			l = new TextDecoder().decode(s.slice(this.scratchOffset, this.scratchOffset + i));
		} else if (o.startsWith("/")) l = o;
		else {
			const t = this.kernelInstance.exports.kernel_get_cwd;
			if (t) {
				const n = t(e.pid, this.scratchOffset, 4096);
				if (n > 0) {
					const e = new Uint8Array(this.kernelMemory.buffer), t = new TextDecoder().decode(e.slice(this.scratchOffset, this.scratchOffset + n));
					l = t.endsWith("/") ? t + o : t + "/" + o;
				} else l = o;
			} else l = o;
		}
		this.callbacks.onExec ? this.callbacks.onExec(e.pid, l, a, c).then((n) => {
			n < 0 && this.completeChannel(e, Lt, t, void 0, -1, -n >>> 0);
		}).catch((n) => {
			console.error(`[kernel] execveat error for pid ${e.pid}:`, n), this.completeChannel(e, Lt, t, void 0, -1, 5);
		}) : this.completeChannel(e, Lt, t, void 0, -1, 38);
	}
	handleClone(e, t) {
		if (!this.callbacks.onClone) return void this.completeChannel(e, Kt, t, void 0, -1, 38);
		const n = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		n.setUint32(4, Kt, !0);
		for (let g = 0; g < 6; g++) n.setBigInt64(8 + 8 * g, BigInt(t[g]), !0);
		const r = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			r(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const i = Number(n.getBigInt64(56, !0)), s = n.getUint32(64, !0);
		if (i < 0) return void this.completeChannel(e, Kt, t, void 0, i, s);
		const o = i, a = t[0], c = t[2];
		1048576 & a && 0 !== c && new DataView(e.memory.buffer).setInt32(c, o, !0);
		const l = new DataView(e.memory.buffer, e.channelOffset), h = l.getUint32(72, !0), d = l.getUint32(76, !0), f = t[1], u = t[3], p = t[4];
		0 !== p && this.threadCtidPtrs.set(`${e.pid}:${o}`, p), this.callbacks.onClone(e.pid, o, h, d, f, u, p, e.memory).then((n) => {
			this.processes.has(e.pid) ? (n !== o && 0 !== p && (this.threadCtidPtrs.delete(`${e.pid}:${o}`), this.threadCtidPtrs.set(`${e.pid}:${n}`, p)), this.completeChannel(e, Kt, t, void 0, n, 0)) : 0 !== p && this.threadCtidPtrs.delete(`${e.pid}:${o}`);
		}).catch((n) => {
			0 !== p && this.threadCtidPtrs.delete(`${e.pid}:${o}`), console.error(`[kernel-worker] onClone failed: ${n}`), this.completeChannel(e, Kt, t, void 0, -1, 12);
		});
	}
	handleExit(e, t, n) {
		const r = n[0], i = this.processes.get(e.pid), s = i && i.channels.length > 0 && i.channels[0].channelOffset === e.channelOffset;
		if (t === Ot && !s) {
			const t = `${e.pid}:${e.channelOffset}`, n = this.channelTids.get(t) ?? 0;
			if (n > 0 && (this.channelTids.delete(t), this.threadForkContexts.delete(t)), n > 0) {
				const t = `${e.pid}:${n}`, r = this.threadCtidPtrs.get(t);
				if (r && 0 !== r) {
					this.threadCtidPtrs.delete(t), new DataView(e.memory.buffer).setInt32(r, 0, !0);
					const n = new Int32Array(e.memory.buffer);
					Atomics.notify(n, r >>> 2, 1);
				}
			}
			n > 0 && this.notifyThreadExit(e.pid, n), this.removeChannel(e.pid, e.channelOffset), n > 0 && !0 === this.callbacks.onThreadExit?.(e.pid, n, e.channelOffset) ? this.abandonChannel(e) : this.completeChannelRaw(e, 0, 0);
			return;
		}
		{
			const n = new DataView(this.kernelMemory.buffer, this.scratchOffset);
			n.setUint32(4, t, !0), n.setBigInt64(8, BigInt(r), !0);
			const i = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				i(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch {} finally {
				this.currentHandlePid = 0;
			}
		}
		const o = e.pid;
		if (this.hostReaped.has(o)) return this.completeChannelRaw(e, 0, 0), this.scheduleWakeBlockedRetries(), void (this.callbacks.onExit && this.callbacks.onExit(o, r));
		this.hostReaped.add(o), this.notifyParentOfExitedProcess(o), this.completeChannelRaw(e, 0, 0), this.scheduleWakeBlockedRetries(), this.callbacks.onExit && this.callbacks.onExit(o, r);
	}
	handleProcessTerminated(e) {
		const t = e.pid;
		if (!this.hostReaped.has(t) && (this.hostReaped.add(t), this.notifyParentOfExitedProcess(t), this.sharedMappings.delete(t), this.callbacks.onExit)) {
			const e = this.kernelInstance.exports.kernel_get_process_exit_status, n = e ? e(t) : -1;
			this.callbacks.onExit(t, n >= 128 ? n : -1);
		}
	}
	notifyHostProcessCrashed(e, t = 11) {
		if (this.hostReaped.has(e)) return;
		const n = this.kernelInstance.exports.kernel_mark_process_signaled;
		n && n(e, t) < 0 || (this.hostReaped.add(e), this.notifyParentOfExitedProcess(e), this.sharedMappings.delete(e));
	}
	reapKilledProcessesAfterSyscall() {
		const e = this.kernelInstance.exports.kernel_get_process_exit_status;
		if (!e) return;
		const t = Array.from(this.processes.keys());
		for (const n of t) {
			if (e(n) < 128) continue;
			if (this.hostReaped.has(n)) continue;
			const t = this.pendingSleeps.get(n);
			t && (clearTimeout(t.timer), this.pendingSleeps.delete(n));
			const r = this.processes.get(n)?.channels[0];
			r && this.handleProcessTerminated(r);
		}
	}
	hostReaped = /* @__PURE__ */ new Set();
	handleWaitpid(e, t) {
		const n = t[0], r = t[1], i = t[2] >>> 0, s = e.pid, o = this.pollWaitableChild(s, n);
		if ("error" !== o.kind) return "exited" === o.kind ? (this.consumeExitedChild(s, o.childPid), this.writeWaitStatus(e, r, o.waitStatus), void this.completeWaitpid(e, t, o.childPid, 0)) : void (1 & i ? this.completeWaitpid(e, t, 0, 0) : this.waitingForChild.push({
			parentPid: s,
			channel: e,
			origArgs: t,
			pid: n,
			options: i,
			syscallNr: Ft
		}));
		this.completeWaitpid(e, t, -1, o.errno);
	}
	pollWaitableChild(e, t) {
		const n = (0, this.kernelInstance.exports.kernel_wait4_poll)(e, t, this.toKernelPtr(this.scratchOffset));
		return n > 0 ? {
			kind: "exited",
			childPid: n,
			waitStatus: new DataView(this.kernelMemory.buffer).getInt32(this.scratchOffset, !0)
		} : 0 === n ? { kind: "running" } : {
			kind: "error",
			errno: -n >>> 0
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
		const n = this.kernelInstance.exports.kernel_has_sa_nocldwait;
		n && 1 === n(t) ? this.consumeExitedChild(t, e) : (this.sendSignalToProcess(t, 17), this.wakeWaitingParent(t));
	}
	writeWaitStatus(e, t, n) {
		0 !== t && new DataView(e.memory.buffer).setInt32(t, n, !0);
	}
	completeWaitpid(e, t, n, r) {
		this.dequeueSignalForDelivery(e), this.completeChannel(e, Ft, t, void 0, n, r);
	}
	wakeWaitingParent(e) {
		let t, n = -1;
		for (let i = 0; i < this.waitingForChild.length; i++) {
			const r = this.waitingForChild[i];
			if (r.parentPid !== e) continue;
			const s = this.pollWaitableChild(r.parentPid, r.pid);
			if ("exited" === s.kind) {
				n = i, t = s;
				break;
			}
		}
		if (-1 === n || "exited" !== t?.kind) return;
		const r = this.waitingForChild[n];
		this.waitingForChild.splice(n, 1), r.syscallNr === Vt ? (this.writeSignalInfo(r.channel, r.origArgs[2], t.childPid, t.waitStatus), r.options & Gt || this.consumeExitedChild(e, t.childPid), this.dequeueSignalForDelivery(r.channel), this.completeChannel(r.channel, Vt, r.origArgs, void 0, 0, 0)) : (this.consumeExitedChild(e, t.childPid), this.writeWaitStatus(r.channel, r.origArgs[1], t.waitStatus), this.completeWaitpid(r.channel, r.origArgs, t.childPid, 0));
	}
	recheckDeferredWaitpids() {
		for (let e = this.waitingForChild.length - 1; e >= 0; e--) {
			const t = this.waitingForChild[e];
			if (t.pid > 0 || -1 === t.pid) continue;
			const n = this.pollWaitableChild(t.parentPid, t.pid);
			"error" === n.kind && (this.waitingForChild.splice(e, 1), t.syscallNr === Vt ? this.completeChannel(t.channel, Vt, t.origArgs, void 0, -1, n.errno) : this.completeWaitpid(t.channel, t.origArgs, -1, n.errno));
		}
	}
	handleWaitid(e, t) {
		const n = t[0], r = t[1], i = t[2], s = t[3] >>> 0, o = e.pid, a = this.waitidToWaitPid(n, r), c = this.pollWaitableChild(o, a);
		if ("error" !== c.kind) {
			if ("exited" === c.kind) return this.writeSignalInfo(e, i, c.childPid, c.waitStatus), s & Gt || this.consumeExitedChild(o, c.childPid), void this.completeChannel(e, Vt, t, void 0, 0, 0);
			if (1 & s) {
				if (0 !== i) {
					const t = new DataView(e.memory.buffer);
					t.setInt32(i, 0, !0), t.setInt32(i + 12, 0, !0);
				}
				this.completeChannel(e, Vt, t, void 0, 0, 0);
			} else this.waitingForChild.push({
				parentPid: o,
				channel: e,
				origArgs: t,
				pid: a,
				options: s,
				syscallNr: Vt
			});
		} else this.completeChannel(e, Vt, t, void 0, -1, c.errno);
	}
	waitidToWaitPid(e, t) {
		return 1 === e ? t : 2 === e ? 0 === t ? 0 : -t : -1;
	}
	writeSignalInfo(e, t, n, r) {
		if (0 === t) return;
		const i = new DataView(e.memory.buffer);
		for (let o = 0; o < 128; o += 4) i.setInt32(t + o, 0, !0);
		const s = !!(127 & r);
		i.setInt32(t + 0, 17, !0), i.setInt32(t + 4, 0, !0), s ? i.setInt32(t + 8, 2, !0) : i.setInt32(t + 8, 1, !0), i.setInt32(t + 12, n, !0), i.setInt32(t + 16, 1e3, !0), s ? i.setInt32(t + 20, 127 & r, !0) : i.setInt32(t + 20, r >> 8 & 255, !0);
	}
	handleFutex(e, t) {
		const n = t[0], r = t[1], i = t[2], s = -385 & r, o = new Int32Array(e.memory.buffer), a = n >>> 2;
		if (0 === s || 9 === s) {
			if (this.pendingCancels.has(e.channelOffset)) return this.pendingCancels.delete(e.channelOffset), this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
			if (Atomics.load(o, a) !== i) return this.completeChannelRaw(e, -11, yt), void this.relistenChannel(e);
			let n;
			const r = t[3];
			if (0 !== r) {
				const t = new DataView(e.memory.buffer), i = Number(t.getBigInt64(r, !0)), s = Number(t.getBigInt64(r + 8, !0));
				if (i < 0 || 0 === i && s <= 0) return this.completeChannelRaw(e, -110, 110), void this.relistenChannel(e);
				n = 1e3 * i + Math.ceil(s / 1e6), n <= 0 && (n = 1), n > 2147483647 && (n = 2147483647);
			}
			const s = Atomics.waitAsync(o, a, i);
			if (s.async) {
				let t, r = !1;
				const i = (n, i) => {
					r || (r = !0, void 0 !== t && clearTimeout(t), this.pendingFutexWaits.delete(e.channelOffset), this.processes.has(e.pid) && (this.completeChannelRaw(e, n, i), e.consecutiveSyscalls = 0, this.relistenChannel(e)));
				};
				this.pendingFutexWaits.set(e.channelOffset, {
					channel: e,
					futexIndex: a
				}), s.value.then(() => {
					i(0, 0);
				}), void 0 !== n && (t = setTimeout(() => {
					Atomics.notify(o, a, 1), i(-110, 110);
				}, n));
			} else this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
			return;
		}
		if (1 === s || 10 === s) {
			const t = Atomics.notify(o, a, i);
			this.completeChannelRaw(e, t, 0), this.relistenChannel(e);
			return;
		}
		if (3 === s || 4 === s) {
			const n = t[3], r = Atomics.notify(o, a, i + n);
			this.completeChannelRaw(e, r, 0), this.relistenChannel(e);
			return;
		}
		if (5 === s) {
			const n = t[3], r = t[4] >>> 2;
			let s = Atomics.notify(o, a, i);
			s += Atomics.notify(o, r, n), this.completeChannelRaw(e, s, 0), this.relistenChannel(e);
			return;
		}
		this.completeChannelRaw(e, -38, 38), this.relistenChannel(e);
	}
	notifyThreadExit(e, t) {
		if (!this.kernelInstance) return;
		const n = this.kernelInstance.exports.kernel_thread_exit;
		n && n(e, t);
	}
	sendSignalToProcess(e, t) {
		if (!this.kernelInstance || !this.kernelMemory) return;
		if (!this.processes.has(e)) return;
		const n = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		n.setUint32(4, Ut, !0), n.setBigInt64(8, BigInt(e), !0), n.setBigInt64(16, BigInt(t), !0);
		for (let o = 2; o < 6; o++) n.setBigInt64(8 + 8 * o, 0n, !0);
		const r = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e;
		const i = this.kernelInstance.exports.kernel_set_current_tid;
		i && i(0);
		try {
			r(this.toKernelPtr(this.scratchOffset), e);
		} catch ($n) {
			console.error(`[sendSignalToProcess] kernel threw for pid=${e} sig=${t}: ${$n}`);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.kernelInstance.exports.kernel_is_signal_blocked(e, t)) return;
		const s = this.pendingSleeps.get(e);
		s && (clearTimeout(s.timer), this.pendingSleeps.delete(e), this.completeSleepWithSignalCheck(s.channel, s.syscallNr, s.origArgs, s.retVal, s.errVal));
		for (const [o, a] of this.pendingPollRetries) a.channel.pid === e && (a.timer && clearTimeout(a.timer), this.pendingPollRetries.delete(o), this.processes.has(e) && this.retrySyscall(a.channel));
		for (const [o, a] of this.pendingSelectRetries) a.channel.pid === e && (clearTimeout(a.timer), clearImmediate(a.timer), this.pendingSelectRetries.delete(o), this.processes.has(e) && (a.syscallNr === Et ? this.handleSelect(a.channel, a.origArgs) : this.handlePselect6(a.channel, a.origArgs)));
	}
	ensureProcessMemoryCovers(e, t, n, r, i) {
		let s = 0, o = 0, a = 0;
		n === Jt ? r >= 0 && (s = r) : n === Yt ? r >= 0 && (o = r, a = i[1], s = o + a) : n === Zt && r >= 0 && (o = r, a = i[2], s = o + a);
		const c = t.buffer.byteLength;
		if (s > 0 && s > c) _t(t, s, this.processes.get(e)?.ptrWidth ?? 4), this.kernel.framebuffers.rebindMemory(e);
		if (a > 0) {
			const e = 65536, r = Math.ceil(a / e) * e, s = t.buffer.byteLength;
			let c = o;
			const l = Math.min(o + r, s);
			if (n === Zt) {
				const t = i[0] >>> 0, n = i[1] >>> 0;
				if (o === t && n > 0) {
					const r = Math.ceil((t + n) / e) * e;
					c = Math.max(c, r);
				}
			}
			c < l && new Uint8Array(t.buffer, c, l - c).fill(0);
		}
		if (n === Zt && r >= 0 && r !== i[0] && 0 !== i[0] && i[1] > 0) {
			const e = i[0] >>> 0, n = i[1] >>> 0, s = r >>> 0, o = i[2] >>> 0, a = Math.min(n, o);
			if (a > 0) {
				const n = t.buffer, r = n.byteLength;
				if (e + a <= r && s + a <= r) {
					const t = new Uint8Array(n, e, a);
					new Uint8Array(n, s, a).set(t);
				}
			}
		}
	}
	populateMmapFromFile(e, t, n) {
		const r = n[4], i = n[1];
		let s = 4096 * n[5];
		const o = this.kernelInstance.exports.kernel_handle_channel, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = new Uint8Array(this.kernelMemory.buffer), l = this.scratchOffset + 72;
		let h = 0;
		for (; h < i;) {
			const n = Math.min(g, i - h);
			a.setUint32(4, nn, !0), a.setBigInt64(8, BigInt(r), !0), a.setBigInt64(16, BigInt(l), !0), a.setBigInt64(24, BigInt(n), !0), a.setBigInt64(32, BigInt(4294967295 & s), !0), a.setBigInt64(40, BigInt(0 | Math.floor(s / 4294967296)), !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				o(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch {
				break;
			}
			this.currentHandlePid = 0;
			const d = Number(a.getBigInt64(56, !0));
			if (d <= 0) break;
			if (new Uint8Array(e.memory.buffer).set(c.subarray(l, l + d), t + h), h += d, s += d, d < n) break;
		}
	}
	flushSharedMappings(e, t) {
		const n = t[0] >>> 0, r = t[1] >>> 0, i = this.sharedMappings.get(e.pid);
		if (!i || 0 === i.size) return;
		const s = n + r;
		for (const [o, a] of i) {
			const t = o + a.len;
			if (o >= s || t <= n) continue;
			const r = Math.max(n, o), i = Math.min(s, t) - r;
			if (i <= 0) continue;
			const c = a.fileOffset + (r - o);
			this.pwriteFromProcessMemory(e, a.fd, r, i, c);
		}
	}
	pwriteFromProcessMemory(e, t, n, r, i) {
		const s = this.kernelInstance.exports.kernel_handle_channel, o = new DataView(this.kernelMemory.buffer, this.scratchOffset), a = new Uint8Array(this.kernelMemory.buffer), c = this.scratchOffset + 72;
		let l = 0;
		for (; l < r;) {
			const h = Math.min(g, r - l), d = new Uint8Array(e.memory.buffer);
			a.set(d.subarray(n + l, n + l + h), c);
			const f = i + l;
			o.setUint32(4, rn, !0), o.setBigInt64(8, BigInt(t), !0), o.setBigInt64(16, BigInt(c), !0), o.setBigInt64(24, BigInt(h), !0), o.setBigInt64(32, BigInt(4294967295 & f), !0), o.setBigInt64(40, BigInt(0 | Math.floor(f / 4294967296)), !0), o.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				s(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch {
				break;
			}
			this.currentHandlePid = 0;
			const u = Number(o.getBigInt64(56, !0));
			if (u <= 0) break;
			if (l += u, u < h) break;
		}
	}
	cleanupSharedMappings(e, t, n) {
		const r = this.sharedMappings.get(e);
		if (!r) return;
		const i = t + n;
		for (const [s, o] of r) {
			const e = s + o.len;
			s >= t && e <= i && r.delete(s);
		}
		0 === r.size && this.sharedMappings.delete(e);
	}
	setNextChildPid(e) {
		this.nextChildPid = e;
	}
	setMaxAddr(e, t) {
		const n = this.kernelInstance.exports.kernel_set_max_addr;
		n && n(e, this.toKernelPtr(t));
	}
	setBrkLimit(e, t) {
		const n = this.kernelInstance.exports.kernel_set_brk_limit;
		return !!n && n(e, this.toKernelPtr(t)) >= 0;
	}
	setMmapBase(e, t) {
		const n = this.kernelInstance.exports.kernel_set_mmap_base;
		return !!n && n(e, this.toKernelPtr(t)) >= 0;
	}
	reserveHostRegion(e, t) {
		const n = this.kernelInstance.exports.kernel_reserve_host_region;
		if (!n) throw new Error("Kernel export kernel_reserve_host_region is required for dynamic pthread control slots");
		const r = n(e, this.toKernelPtr(t)), i = "bigint" == typeof r ? Number(r) : r;
		if (!Number.isSafeInteger(i) || i < 0 || i >>> 0 == 4294967295) throw new Error(`failed to reserve ${t} bytes of pthread control memory for pid=${e}`);
		return i;
	}
	reserveHostRegionAt(e, t, n) {
		const r = this.kernelInstance.exports.kernel_reserve_host_region_at;
		if (!r) throw new Error("Kernel export kernel_reserve_host_region_at is required for fork-from-pthread control slots");
		const i = r(e, this.toKernelPtr(t), this.toKernelPtr(n)), s = "bigint" == typeof i ? Number(i) : i;
		if (!Number.isSafeInteger(s) || s < 0 || s >>> 0 == 4294967295 || s !== t) throw new Error(`failed to reserve pthread control memory at 0x${t.toString(16)} for pid=${e}`);
		return s;
	}
	highControlFloorForProcess(e) {
		const t = this.processes.get(e);
		if (!t) return null;
		if (t.explicitMaxAddr) return null;
		let n = null;
		for (const r of t.channels) {
			const e = r.channelOffset - 131072;
			e >= at && (n = null === n ? e : Math.min(n, e));
		}
		return n;
	}
	setBrkBase(e, t) {
		const n = this.kernelInstance.exports.kernel_set_brk_base;
		return !!n && n(e, this.toKernelPtr(t)) >= 0;
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
	injectMouseEvent(e, t, n) {
		this.kernel.injectMouseEvent(e, t, n), this.scheduleWakeBlockedRetries();
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
	startTcpListener(e, t, n, r = [
		0,
		0,
		0,
		0
	]) {
		const i = `${e}:${t}`;
		if (this.tcpListeners.has(i)) return;
		this.tcpListenerTargets.has(n) || (this.tcpListenerTargets.set(n, []), this.tcpListenerRRIndex.set(n, 0));
		const s = this.tcpListenerTargets.get(n);
		if (s.some((n) => n.pid === e && n.fd === t) || s.push({
			pid: e,
			fd: t
		}), this.io.network?.listenTcp) {
			const s = this.io.network.listenTcp(i, new Uint8Array(r), n, { accept: (n, r, i) => this.handleIncomingVirtualTcpConnection(e, t, n, i) });
			0 !== s && console.warn(`virtual TCP listener registration failed on port ${n}: errno ${s}`);
		}
		if (!this.netModule) return;
		for (const [, l] of this.tcpListeners) if (l.port === n) return void this.tcpListeners.set(i, l);
		const o = this.netModule, a = /* @__PURE__ */ new Set(), c = o.createServer((e) => {
			const t = this.pickListenerTarget(n);
			t ? this.handleIncomingTcpConnection(t.pid, t.fd, e, a) : e.destroy();
		});
		c.listen(n, "0.0.0.0", () => {}), c.on("error", (e) => {
			console.error(`TCP listener error on port ${n}:`, e);
		}), this.tcpListeners.set(i, {
			server: c,
			pid: e,
			port: n,
			connections: a
		});
	}
	pickListenerTarget(e) {
		const t = this.tcpListenerTargets.get(e);
		if (!t || 0 === t.length) return null;
		const n = t.filter((e) => this.processes.has(e.pid));
		if (0 === n.length) return null;
		n.length !== t.length && this.tcpListenerTargets.set(e, n);
		let r = n;
		if (n.length > 1) {
			const e = n.filter((e) => void 0 !== this.getParentPid(e.pid));
			e.length > 0 && (r = e);
		}
		const i = (this.tcpListenerRRIndex.get(e) ?? 0) % r.length;
		return this.tcpListenerRRIndex.set(e, i + 1), r[i];
	}
	async sendHttpRequest(e, t, n = {}) {
		const r = n.timeoutMs ?? 6e4, i = n.debugLabel ?? `${t.method} ${t.url}`, s = this.pickListenerTarget(e);
		if (!s) throw new Error(`No in-kernel listener for port ${e}`);
		const o = this.kernelInstance.exports, a = o.kernel_inject_connection, c = o.kernel_pipe_write, l = o.kernel_pipe_read, h = o.kernel_pipe_is_write_open, d = o.kernel_pipe_close_write, f = o.kernel_pipe_close_read, u = 1024 + Math.floor(6e4 * Math.random()), p = a(s.pid, s.fd, 127, 0, 0, 1, u);
		if (p < 0) throw new Error(`[in-kernel-http ${i}] kernel_inject_connection failed (${p})`);
		const g = p + 1;
		this.wakeTargetPollNow(s.pid), this.scheduleWakeBlockedRetries();
		const m = function(e) {
			let t = `${e.method} ${e.url} HTTP/1.1\r\n`;
			const n = Object.keys(e.headers).map((e) => e.toLowerCase());
			for (const [s, o] of Object.entries(e.headers)) t += `${s}: ${o}\r\n`;
			e.body && e.body.length > 0 && !n.includes("content-length") && (t += `Content-Length: ${e.body.length}\r\n`), n.includes("connection") || (t += "Connection: close\r\n"), t += "\r\n";
			const r = Ze.encode(t);
			if (!e.body || 0 === e.body.length) return r;
			const i = new Uint8Array(r.length + e.body.length);
			return i.set(r, 0), i.set(e.body, r.length), i;
		}(t), _ = this.writePipeChunked(c, 0, p, m);
		if (_ < m.length) throw d(0, p), f(0, g), /* @__PURE__ */ new Error(`[in-kernel-http ${i}] partial write ${_}/${m.length}`);
		this.notifyPipeReadable(p);
		const y = await this.pumpHttpResponse(0, g, p, l, h, f, d, r, i), w = n.emptyResponseRetries ?? 1;
		return w > 0 && ("GET" === t.method || "HEAD" === t.method) && 200 === y.status && 0 === Object.keys(y.headers).length && 0 === y.body.length ? await this.sendHttpRequest(e, t, {
			...n,
			emptyResponseRetries: w - 1
		}) : y;
	}
	wakeTargetPollNow(e) {
		for (const [t, n] of this.pendingPollRetries) if (n.channel.pid === e) {
			null !== n.timer && clearTimeout(n.timer), this.pendingPollRetries.delete(t), this.processes.has(e) && this.retrySyscall(n.channel);
			break;
		}
	}
	writePipeChunked(e, t, n, r) {
		const i = this.tcpScratchOffset;
		let s = 0;
		for (; s < r.length;) {
			const o = Math.min(r.length - s, 65536);
			this.getKernelMem().set(r.subarray(s, s + o), i);
			const a = e(t, n, this.toKernelPtr(i), o);
			if (a <= 0) break;
			s += a;
		}
		return s;
	}
	pumpHttpResponse(e, t, n, r, i, s, o, a, c) {
		return new Promise((c) => {
			const l = [], h = Date.now();
			let d = !1;
			const f = this.tcpScratchOffset, u = (r) => {
				s(e, t), o(e, n), this.notifyPipeReadable(n), this.scheduleWakeBlockedRetries(), c(r);
			}, p = () => {
				if (Date.now() - h > a) return void u({
					status: 504,
					headers: {},
					body: new Uint8Array(0)
				});
				let n = !1;
				for (;;) {
					const i = r(e, t, this.toKernelPtr(f), 65536);
					if (i <= 0) break;
					n = !0;
					const s = this.getKernelMem();
					l.push(s.slice(f, f + i));
				}
				n && this.notifyPipeWritable(t);
				const s = 1 === i(e, t);
				s && !d && (d = !0), !d || s || n ? setTimeout(p, n ? 0 : 2) : u(et(function(e) {
					if (0 === e.length) return new Uint8Array(0);
					if (1 === e.length) return e[0];
					const t = e.reduce((e, t) => e + t.length, 0), n = new Uint8Array(t);
					let r = 0;
					for (const i of e) n.set(i, r), r += i.length;
					return n;
				}(l)));
			};
			p();
		});
	}
	handleIncomingTcpConnection(e, t, n, r) {
		r.add(n);
		const i = n.remoteAddress || "127.0.0.1", s = n.remotePort || 0, o = i.replace("::ffff:", "").split(".").map(Number), a = o[0] || 127, c = o[1] || 0, l = o[2] || 0, h = o[3] || 1, d = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, a, c, l, h, s);
		if (d < 0) return n.destroy(), void r.delete(n);
		this.scheduleWakeBlockedRetries();
		const f = d + 1, u = this.kernelInstance.exports.kernel_pipe_write, p = this.kernelInstance.exports.kernel_pipe_read, g = this.kernelInstance.exports.kernel_pipe_close_write, m = this.kernelInstance.exports.kernel_pipe_close_read;
		this.kernelInstance.exports.kernel_pipe_is_read_open;
		const _ = [];
		let y = !1, w = !1, S = !1;
		const k = this.tcpScratchOffset, b = this.kernelInstance.exports.kernel_pipe_is_write_open, A = () => {
			const e = this.getKernelMem();
			for (; _.length > 0;) {
				const t = _[0], n = Math.min(t.length, 65536);
				e.set(t.subarray(0, n), k);
				const r = u(0, d, this.toKernelPtr(k), n);
				if (r <= 0) break;
				r >= t.length ? _.shift() : _[0] = t.subarray(r);
			}
			y && 0 === _.length && g(0, d);
		}, I = () => {
			const e = this.getKernelMem();
			let t = 0;
			for (;;) {
				const r = p(0, f, this.toKernelPtr(k), 65536);
				if (r <= 0) break;
				t += r;
				const i = Buffer.from(e.slice(k, k + r));
				n.destroyed || n.write(i);
			}
			return t;
		}, C = (e = 0) => {
			w || S || (w = !0, e > 0 ? setTimeout(E, e) : setImmediate(E));
		}, E = () => {
			if (w = !1, S || !this.processes.has(e)) return void T();
			A();
			const t = I();
			if (0 === b(0, f) && 0 === t) return n.destroyed || n.end(), void T();
			C();
		};
		n.on("data", (t) => {
			_.push(t), this.processes.has(e) ? (A(), this.notifyPipeReadable(d, e), C()) : T();
		}), n.on("end", () => {
			y = !0, C();
		}), n.on("error", () => {
			y = !0, n.destroy();
		}), n.on("close", () => {
			r.delete(n);
		});
		let v = this.tcpConnections.get(e);
		v || (v = [], this.tcpConnections.set(e, v));
		const x = {
			sendPipeIdx: f,
			scratchOffset: k,
			clientSocket: n,
			recvPipeIdx: d,
			schedulePump: C
		};
		v.push(x);
		const T = () => {
			if (S) return;
			S = !0, g(0, d), m(0, f), r.delete(n);
			const t = this.tcpConnections?.get(e);
			if (t) {
				const n = t.indexOf(x);
				n >= 0 && t.splice(n, 1), 0 === t.length && this.tcpConnections?.delete(e);
			}
			n.destroyed || n.destroy();
		};
	}
	handleIncomingVirtualTcpConnection(e, t, n, r) {
		if (!this.kernelInstance) return 107;
		const i = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, r.addr[0] ?? 0, r.addr[1] ?? 0, r.addr[2] ?? 0, r.addr[3] ?? 0, r.port);
		if (i < 0) return -i;
		const s = i + 1, o = this.kernelInstance.exports.kernel_pipe_write, a = this.kernelInstance.exports.kernel_pipe_read, c = this.kernelInstance.exports.kernel_pipe_close_write, l = this.kernelInstance.exports.kernel_pipe_close_read, h = this.kernelInstance.exports.kernel_pipe_is_write_open;
		let d = !1, f = !1;
		const u = this.tcpScratchOffset, p = () => {
			d || (d = !0, c(0, i), l(0, s), n.close(), this.notifyPipeReadable(i, e), this.notifyPipeWritable(s), this.scheduleWakeBlockedRetries());
		}, g = () => {
			for (;;) {
				let r;
				try {
					r = n.recv(65536, 0);
				} catch (t) {
					if (11 === t?.errno) return;
					p();
					return;
				}
				if (0 === r.length) return c(0, i), void this.notifyPipeReadable(i, e);
				if (this.writePipeChunked(o, 0, i, r) < r.length) return;
				this.notifyPipeReadable(i, e);
			}
		}, m = () => {
			const e = this.getKernelMem();
			for (;;) {
				const t = a(0, s, this.toKernelPtr(u), 65536);
				if (t <= 0) break;
				try {
					n.send(e.slice(u, u + t), 0);
				} catch {
					p();
					return;
				}
				this.notifyPipeWritable(s);
			}
		}, _ = () => {
			if (f = !1, !d) {
				if (!this.processes.has(e)) return m(), n.shutdown(1), void p();
				if (g(), m(), 0 === h(0, s)) return n.shutdown(1), void p();
				y(2);
			}
		}, y = (e = 0) => {
			f || d || (f = !0, setTimeout(_, e));
		};
		return this.scheduleWakeBlockedRetries(), y(), 0;
	}
	injectUdpDatagram(e, t) {
		if (!this.kernelInstance || !this.processes.has(e)) return 113;
		if (t.data.length > 65536) return 90;
		const n = this.kernelInstance.exports.kernel_inject_datagram;
		if (!n) return 38;
		const r = this.tcpScratchOffset;
		this.getKernelMem().set(t.data, r);
		const i = n(e, t.dstAddr[0] ?? 0, t.dstAddr[1] ?? 0, t.dstAddr[2] ?? 0, t.dstAddr[3] ?? 0, t.dstPort, t.srcAddr[0] ?? 0, t.srcAddr[1] ?? 0, t.srcAddr[2] ?? 0, t.srcAddr[3] ?? 0, t.srcPort, this.toKernelPtr(r), t.data.length);
		return i < 0 ? -i : (this.scheduleWakeBlockedRetries(), 0);
	}
	cleanupUdpBindings(e) {
		if (!this.io.network?.unbindUdp) return;
		const t = `${e}:`;
		for (const n of Array.from(this.udpBindings)) n.startsWith(t) && (this.io.network.unbindUdp(n), this.udpBindings.delete(n));
	}
	cleanupTcpListeners(e) {
		for (const [t, n] of this.tcpListenerTargets) {
			const r = n.filter((t) => t.pid !== e);
			0 === r.length ? (this.tcpListenerTargets.delete(t), this.tcpListenerRRIndex.delete(t)) : this.tcpListenerTargets.set(t, r);
		}
		for (const [t, n] of this.tcpListeners) if (n.pid === e) {
			if (this.io.network?.closeTcpListener?.(t), !this.tcpListenerTargets.has(n.port)) {
				n.server.close();
				for (const e of n.connections) e.destroy();
				n.connections.clear();
			}
			this.tcpListeners.delete(t);
		}
		this.tcpConnections.delete(e), this.shmMappings.delete(e);
	}
	handleSemctl(e, t) {
		const [n, r, i, s] = t, o = -257 & i, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = this.kernelInstance.exports.kernel_handle_channel, l = this.getKernelMem(), h = this.scratchOffset + 72;
		if (2 === o && 0 !== s) {
			a.setUint32(4, wn, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(r), !0), a.setBigInt64(24, BigInt(i), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), l.fill(0, h, h + 72), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const t = Number(a.getBigInt64(56, !0));
			t >= 0 && new Uint8Array(e.memory.buffer).set(l.subarray(h, h + 72), s), this.completeChannelRaw(e, t, t < 0 ? -t : 0), this.relistenChannel(e);
			return;
		}
		if (13 === o && 0 !== s) {
			const t = 1024;
			a.setUint32(4, wn, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(r), !0), a.setBigInt64(24, BigInt(i), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), l.fill(0, h, h + t), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const o = Number(a.getBigInt64(56, !0));
			o >= 0 && new Uint8Array(e.memory.buffer).set(l.subarray(h, h + t), s), this.completeChannelRaw(e, o, o < 0 ? -o : 0), this.relistenChannel(e);
			return;
		}
		if (17 === o && 0 !== s) {
			const t = 1024, o = new Uint8Array(e.memory.buffer);
			l.set(o.subarray(s, s + t), h), a.setUint32(4, wn, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(r), !0), a.setBigInt64(24, BigInt(i), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const d = Number(a.getBigInt64(56, !0));
			this.completeChannelRaw(e, d, d < 0 ? -d : 0), this.relistenChannel(e);
			return;
		}
		a.setUint32(4, wn, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(r), !0), a.setBigInt64(24, BigInt(i), !0), a.setBigInt64(32, BigInt(s), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			c(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const d = Number(a.getBigInt64(56, !0));
		this.completeChannelRaw(e, d, d < 0 ? -d : 0), this.relistenChannel(e);
	}
	handleIpcShmat(e, t) {
		const [n, r, i] = t, s = this.kernelInstance.exports.kernel_set_current_pid;
		s && s(e.pid);
		const o = (0, this.kernelInstance.exports.kernel_ipc_shmat)(n, r, i);
		if (o < 0) return this.completeChannelRaw(e, o, -o), void this.relistenChannel(e);
		const a = o, c = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		c.setUint32(4, Yt, !0), c.setBigInt64(8, BigInt(0), !0), c.setBigInt64(16, BigInt(a), !0), c.setBigInt64(24, BigInt(3), !0), c.setBigInt64(32, BigInt(34), !0), c.setBigInt64(40, BigInt(-1), !0), c.setBigInt64(48, BigInt(0), !0);
		const l = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			l(this.toKernelPtr(this.scratchOffset), e.pid);
		} catch ($n) {
			console.error(`[handleIpcShmat] mmap failed for pid=${e.pid}:`, $n), this.completeChannelRaw(e, -12, 12), this.relistenChannel(e);
			return;
		} finally {
			this.currentHandlePid = 0;
		}
		const h = Number(c.getBigInt64(56, !0));
		if (h < 0) return this.completeChannelRaw(e, -12, 12), void this.relistenChannel(e);
		this.ensureProcessMemoryCovers(e.pid, e.memory, Yt, h, [
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
			const e = a - g, t = Math.min(e, 65536), r = d(n, g, this.toKernelPtr(p), t);
			if (r <= 0) break;
			f.set(u.subarray(p, p + r), (h >>> 0) + g), g += r;
		}
		let m = this.shmMappings.get(e.pid);
		m || (m = /* @__PURE__ */ new Map(), this.shmMappings.set(e.pid, m)), m.set(h >>> 0, {
			segId: n,
			size: a
		}), this.completeChannelRaw(e, h, 0), this.relistenChannel(e);
	}
	handleIpcShmdt(e, t) {
		const n = t[0], r = this.shmMappings.get(e.pid);
		if (!r) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const i = r.get(n);
		if (!i) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const s = this.kernelInstance.exports.kernel_set_current_pid;
		s && s(e.pid);
		const o = this.kernelInstance.exports.kernel_ipc_shm_write_chunk, a = new Uint8Array(e.memory.buffer), c = this.getKernelMem(), l = this.scratchOffset + 72;
		let h = 0;
		for (; h < i.size;) {
			const e = i.size - h, t = Math.min(e, 65536);
			c.set(a.subarray(n + h, n + h + t), l);
			const r = o(i.segId, h, this.toKernelPtr(l), t);
			if (r <= 0) break;
			h += r;
		}
		const d = (0, this.kernelInstance.exports.kernel_ipc_shmdt)(i.segId);
		r.delete(n), d < 0 ? this.completeChannelRaw(e, d, -d) : this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	drainMqueueNotification() {
		const e = this.kernelInstance.exports.kernel_mq_drain_notification;
		if (!e) return;
		const t = this.scratchOffset;
		if (e(this.toKernelPtr(t))) {
			const e = new DataView(this.kernelMemory.buffer, t), n = e.getUint32(0, !0), r = e.getUint32(4, !0);
			r > 0 && this.sendSignalToProcess(n, r);
		}
	}
};
var Bn = class {
	entryUrl;
	constructor(e) {
		this.entryUrl = e;
	}
	createWorker(e) {
		const t = new Worker(this.entryUrl, { type: "module" }), n = new Hn(t);
		return t.postMessage(e), n;
	}
}, Hn = class {
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
		let n = this.handlers.get(e);
		n || (n = /* @__PURE__ */ new Set(), this.handlers.set(e, n)), n.add(t);
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
				const n = new Promise((e) => {
					this.shutdownAckResolver = () => {
						t = !0, e();
					};
				});
				this.worker.postMessage({ type: "__kandelo_worker_shutdown" }), await Promise.race([n, (e = 500, new Promise((t) => setTimeout(t, e)))]);
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
};
var Un = class {
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
				let n = e.slice(t.prefix.length);
				return n.startsWith("/") || (n = "/" + n), {
					backend: t.backend,
					relativePath: n
				};
			}
		}
		throw new Error(`ENOENT: no mount for path: ${e}`);
	}
	resolveTwoPaths(e, t) {
		const n = this.resolve(e), r = this.resolve(t);
		if (n.backend !== r.backend) throw new Error("EXDEV: cross-device link");
		return {
			backend: n.backend,
			rel1: n.relativePath,
			rel2: r.relativePath
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
	open(e, t, n) {
		const { backend: r, relativePath: i } = this.resolve(e), s = r.open(i, t, n), o = this.nextFileHandle++;
		return this.fileHandles.set(o, {
			backend: r,
			localHandle: s
		}), o;
	}
	close(e) {
		const t = this.getFileHandle(e), n = t.backend.close(t.localHandle);
		return this.fileHandles.delete(e), n;
	}
	read(e, t, n, r) {
		const i = this.getFileHandle(e);
		return i.backend.read(i.localHandle, t, n, r);
	}
	write(e, t, n, r) {
		const i = this.getFileHandle(e);
		return i.backend.write(i.localHandle, t, n, r);
	}
	seek(e, t, n) {
		const r = this.getFileHandle(e);
		return r.backend.seek(r.localHandle, t, n);
	}
	fstat(e) {
		const t = this.getFileHandle(e);
		return t.backend.fstat(t.localHandle);
	}
	ftruncate(e, t) {
		const n = this.getFileHandle(e);
		n.backend.ftruncate(n.localHandle, t);
	}
	fsync(e) {
		const t = this.getFileHandle(e);
		t.backend.fsync(t.localHandle);
	}
	fchmod(e, t) {
		const n = this.getFileHandle(e);
		n.backend.fchmod(n.localHandle, t);
	}
	fchown(e, t, n) {
		const r = this.getFileHandle(e);
		r.backend.fchown(r.localHandle, t, n);
	}
	stat(e) {
		const { backend: t, relativePath: n } = this.resolve(e);
		return t.stat(n);
	}
	lstat(e) {
		const { backend: t, relativePath: n } = this.resolve(e);
		return t.lstat(n);
	}
	statfs(e) {
		const { backend: t, relativePath: n } = this.resolve(e);
		return t.statfs(n);
	}
	mkdir(e, t) {
		const { backend: n, relativePath: r } = this.resolve(e);
		n.mkdir(r, t);
	}
	rmdir(e) {
		const { backend: t, relativePath: n } = this.resolve(e);
		t.rmdir(n);
	}
	unlink(e) {
		const { backend: t, relativePath: n } = this.resolve(e);
		t.unlink(n);
	}
	rename(e, t) {
		const { backend: n, rel1: r, rel2: i } = this.resolveTwoPaths(e, t);
		n.rename(r, i);
	}
	link(e, t) {
		const { backend: n, rel1: r, rel2: i } = this.resolveTwoPaths(e, t);
		n.link(r, i);
	}
	symlink(e, t) {
		const { backend: n, relativePath: r } = this.resolve(t);
		n.symlink(e, r);
	}
	readlink(e) {
		const { backend: t, relativePath: n } = this.resolve(e);
		return t.readlink(n);
	}
	chmod(e, t) {
		const { backend: n, relativePath: r } = this.resolve(e);
		n.chmod(r, t);
	}
	chown(e, t, n) {
		const { backend: r, relativePath: i } = this.resolve(e);
		r.chown(i, t, n);
	}
	access(e, t) {
		const { backend: n, relativePath: r } = this.resolve(e);
		n.access(r, t);
	}
	utimensat(e, t, n, r, i) {
		const { backend: s, relativePath: o } = this.resolve(e);
		s.utimensat(o, t, n, r, i);
	}
	opendir(e) {
		const { backend: t, relativePath: n } = this.resolve(e), r = t.opendir(n), i = this.nextDirHandle++;
		return this.dirHandles.set(i, {
			backend: t,
			localHandle: r
		}), i;
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
}, Mn = ArrayBuffer, Ln = Uint8Array, Rn = Uint16Array, Wn = Int16Array, Dn = Int32Array, Kn = function(e, t, n) {
	if (Ln.prototype.slice) return Ln.prototype.slice.call(e, t, n);
	(null == t || t < 0) && (t = 0), (null == n || n > e.length) && (n = e.length);
	var r = new Ln(n - t);
	return r.set(e.subarray(t, n)), r;
}, On = function(e, t, n, r) {
	if (Ln.prototype.fill) return Ln.prototype.fill.call(e, t, n, r);
	for ((null == n || n < 0) && (n = 0), (null == r || r > e.length) && (r = e.length); n < r; ++n) e[n] = t;
	return e;
}, zn = function(e, t, n, r) {
	if (Ln.prototype.copyWithin) return Ln.prototype.copyWithin.call(e, t, n, r);
	for ((null == n || n < 0) && (n = 0), (null == r || r > e.length) && (r = e.length); n < r;) e[t++] = e[n++];
}, Nn = [
	"invalid zstd data",
	"window size too large (>2046MB)",
	"invalid block type",
	"FSE accuracy too high",
	"match distance too far back",
	"unexpected EOF"
], $n = function(e, t, n) {
	var r = new Error(t || Nn[e]);
	if (r.code = e, Error.captureStackTrace && Error.captureStackTrace(r, $n), !n) throw r;
	return r;
}, Fn = function(e, t, n) {
	for (var r = 0, i = 0; r < n; ++r) i |= e[t++] << (r << 3);
	return i;
}, Vn = function(e, t) {
	var n, r, i = e[0] | e[1] << 8 | e[2] << 16;
	if (3126568 == i && 253 == e[3]) {
		var s = e[4], o = s >> 5 & 1, a = s >> 2 & 1, c = 3 & s, l = s >> 6;
		8 & s && $n(0);
		var h = 6 - o, d = 3 == c ? 4 : c, f = Fn(e, h, d), u = l ? 1 << l : o, p = Fn(e, h += d, u) + (1 == l && 256), g = p;
		if (!o) {
			var m = 1 << 10 + (e[5] >> 3);
			g = m + (m >> 3) * (7 & e[5]);
		}
		g > 2145386496 && $n(1);
		var _ = new Ln((1 == t ? p || g : t ? 0 : g) + 12);
		return _[0] = 1, _[4] = 4, _[8] = 8, {
			b: h + u,
			y: 0,
			l: 0,
			d: f,
			w: t && 1 != t ? t : _.subarray(12),
			e: g,
			o: new Dn(_.buffer, 0, 3),
			u: p,
			c: a,
			m: Math.min(131072, g)
		};
	}
	if (25481893 == (i >> 4 | e[3] << 20)) return (((n = e)[r = 4] | n[r + 1] << 8 | n[r + 2] << 16 | n[r + 3] << 24) >>> 0) + 8;
	$n(0);
}, qn = function(e) {
	for (var t = 0; 1 << t <= e; ++t);
	return t - 1;
}, Gn = function(e, t, n) {
	var r = 4 + (t << 3), i = 5 + (15 & e[t]);
	i > n && $n(3);
	for (var s = 1 << i, o = s, a = -1, c = -1, l = -1, h = s, d = new Mn(512 + (s << 2)), f = new Wn(d, 0, 256), u = new Rn(d, 0, 256), p = new Rn(d, 512, s), g = 512 + (s << 1), m = new Ln(d, g, s), _ = new Ln(d, g + s); a < 255 && o > 0;) {
		var y = qn(o + 1), w = r >> 3, S = (1 << y + 1) - 1, k = (e[w] | e[w + 1] << 8 | e[w + 2] << 16) >> (7 & r) & S, b = (1 << y) - 1, A = S - o - 1, I = k & b;
		if (I < A ? (r += y, k = I) : (r += y + 1, k > b && (k -= A)), f[++a] = --k, -1 == k ? (o += k, m[--h] = a) : o -= k, !k) do {
			var C = r >> 3;
			c = (e[C] | e[C + 1] << 8) >> (7 & r) & 3, r += 2, a += c;
		} while (3 == c);
	}
	(a > 255 || o) && $n(0);
	for (var E = 0, v = (s >> 1) + (s >> 3) + 3, x = s - 1, T = 0; T <= a; ++T) {
		var P = f[T];
		if (P < 1) u[T] = -P;
		else for (l = 0; l < P; ++l) {
			m[E] = T;
			do
				E = E + v & x;
			while (E >= h);
		}
	}
	for (E && $n(0), l = 0; l < s; ++l) {
		var B = u[m[l]]++;
		p[l] = (B << (_[l] = i - qn(B))) - s;
	}
	return [r + 7 >> 3, {
		b: i,
		s: m,
		n: _,
		t: p
	}];
}, jn = Gn(new Ln([
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
]), 0, 6)[1], Yn = Gn(new Ln([
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
]), 0, 6)[1], Xn = Gn(new Ln([
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
]), 0, 5)[1], Jn = function(e, t) {
	for (var n = e.length, r = new Dn(n), i = 0; i < n; ++i) r[i] = t, t += 1 << e[i];
	return r;
}, Zn = new Ln(new Dn([
	0,
	0,
	0,
	0,
	16843009,
	50528770,
	134678020,
	202050057,
	269422093
]).buffer, 0, 36), Qn = Jn(Zn, 0), er = new Ln(new Dn([
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
]).buffer, 0, 53), tr = Jn(er, 3), nr = function(e, t, n) {
	var r = e.length, i = t.length, s = e[r - 1], o = (1 << n.b) - 1, a = -n.b;
	s || $n(0);
	for (var c = 0, l = n.b, h = (r << 3) - 8 + qn(s) - l, d = -1; h > a && d < i;) {
		var f = h >> 3;
		c = (c << l | (e[f] | e[f + 1] << 8 | e[f + 2] << 16) >> (7 & h)) & o, t[++d] = n.s[c], h -= l = n.n[c];
	}
	h == a && d + 1 == i || $n(0);
}, rr = function(e, t, n) {
	var r = 6, i = t.length + 3 >> 2, s = i << 1, o = i + s;
	nr(e.subarray(r, r += e[0] | e[1] << 8), t.subarray(0, i), n), nr(e.subarray(r, r += e[2] | e[3] << 8), t.subarray(i, s), n), nr(e.subarray(r, r += e[4] | e[5] << 8), t.subarray(s, o), n), nr(e.subarray(r), t.subarray(o), n);
}, ir = function(e, t, n) {
	var r, i = t.b, s = e[i], o = s >> 1 & 3;
	t.l = 1 & s;
	var a = s >> 3 | e[i + 1] << 5 | e[i + 2] << 13, c = (i += 3) + a;
	if (1 == o) {
		if (i >= e.length) return;
		return t.b = i + 1, n ? (On(n, e[i], t.y, t.y += a), n) : On(new Ln(a), e[i]);
	}
	if (!(c > e.length)) {
		if (0 == o) return t.b = c, n ? (n.set(e.subarray(i, c), t.y), t.y += a, n) : Kn(e, i, c);
		if (2 == o) {
			var l = e[i], h = 3 & l, d = l >> 2 & 3, f = l >> 4, u = 0, p = 0;
			h < 2 ? 1 & d ? f |= e[++i] << 4 | (2 & d && e[++i] << 12) : f = l >> 3 : (p = d, d < 2 ? (f |= (63 & e[++i]) << 4, u = e[i] >> 6 | e[++i] << 2) : 2 == d ? (f |= e[++i] << 4 | (3 & e[++i]) << 12, u = e[i] >> 2 | e[++i] << 6) : (f |= e[++i] << 4 | (63 & e[++i]) << 12, u = e[i] >> 6 | e[++i] << 2 | e[++i] << 10)), ++i;
			var g = n ? n.subarray(t.y, t.y + t.m) : new Ln(t.m), m = g.length - f;
			if (0 == h) g.set(e.subarray(i, i += f), m);
			else if (1 == h) On(g, e[i++], m);
			else {
				var _ = t.h;
				if (2 == h) {
					var y = function(e, t) {
						var n = 0, r = -1, i = new Ln(292), s = e[t], o = i.subarray(0, 256), a = i.subarray(256, 268), c = new Rn(i.buffer, 268);
						if (s < 128) {
							var l = Gn(e, t + 1, 6), h = l[0], d = l[1], f = h << 3, u = e[t += s];
							u || $n(0);
							for (var p = 0, g = 0, m = d.b, _ = m, y = (++t << 3) - 8 + qn(u); !((y -= m) < f);) {
								var w = y >> 3;
								if (p += (e[w] | e[w + 1] << 8) >> (7 & y) & (1 << m) - 1, o[++r] = d.s[p], (y -= _) < f) break;
								g += (e[w = y >> 3] | e[w + 1] << 8) >> (7 & y) & (1 << _) - 1, o[++r] = d.s[g], m = d.n[p], p = d.t[p], _ = d.n[g], g = d.t[g];
							}
							++r > 255 && $n(0);
						} else {
							for (r = s - 127; n < r; n += 2) {
								var S = e[++t];
								o[n] = S >> 4, o[n + 1] = 15 & S;
							}
							++t;
						}
						var k = 0;
						for (n = 0; n < r; ++n) (C = o[n]) > 11 && $n(0), k += C && 1 << C - 1;
						var b = qn(k) + 1, A = 1 << b, I = A - k;
						for (I & I - 1 && $n(0), o[r++] = qn(I) + 1, n = 0; n < r; ++n) {
							var C = o[n];
							++a[o[n] = C && b + 1 - C];
						}
						var E = new Ln(A << 1), v = E.subarray(0, A), x = E.subarray(A);
						for (c[b] = 0, n = b; n > 0; --n) {
							var T = c[n];
							On(x, n, T, c[n - 1] = T + a[n] * (1 << b - n));
						}
						for (c[0] != A && $n(0), n = 0; n < r; ++n) {
							var P = o[n];
							if (P) {
								var B = c[P];
								On(v, n, B, c[P] = B + (1 << b - P));
							}
						}
						return [t, {
							n: x,
							b,
							s: v
						}];
					}(e, i);
					u += i - (i = y[0]), t.h = _ = y[1];
				} else _ || $n(0);
				(p ? rr : nr)(e.subarray(i, i += u), g.subarray(m), _);
			}
			var w = e[i++];
			if (w) {
				255 == w ? w = 32512 + (e[i++] | e[i++] << 8) : w > 127 && (w = w - 128 << 8 | e[i++]);
				var S = e[i++];
				3 & S && $n(0);
				for (var k = [
					Yn,
					Xn,
					jn
				], b = 2; b > -1; --b) {
					var A = S >> 2 + (b << 1) & 3;
					if (1 == A) {
						var I = new Ln([
							0,
							0,
							e[i++]
						]);
						k[b] = {
							s: I.subarray(2, 3),
							n: I.subarray(0, 1),
							t: new Rn(I.buffer, 0, 1),
							b: 0
						};
					} else 2 == A ? (i = (r = Gn(e, i, 9 - (1 & b)))[0], k[b] = r[1]) : 3 == A && (t.t || $n(0), k[b] = t.t[b]);
				}
				var C = t.t = k, E = C[0], v = C[1], x = C[2], T = e[c - 1];
				T || $n(0);
				var P = (c << 3) - 8 + qn(T) - x.b, B = P >> 3, H = 0, U = (e[B] | e[B + 1] << 8) >> (7 & P) & (1 << x.b) - 1, M = (e[B = (P -= v.b) >> 3] | e[B + 1] << 8) >> (7 & P) & (1 << v.b) - 1, L = (e[B = (P -= E.b) >> 3] | e[B + 1] << 8) >> (7 & P) & (1 << E.b) - 1;
				for (++w; --w;) {
					var R = x.s[U], W = x.n[U], D = E.s[L], K = E.n[L], O = v.s[M], z = v.n[M], N = 1 << O, $ = N + ((e[B = (P -= O) >> 3] | e[B + 1] << 8 | e[B + 2] << 16 | e[B + 3] << 24) >>> (7 & P) & N - 1);
					B = (P -= er[D]) >> 3;
					var F = tr[D] + ((e[B] | e[B + 1] << 8 | e[B + 2] << 16) >> (7 & P) & (1 << er[D]) - 1);
					B = (P -= Zn[R]) >> 3;
					var V = Qn[R] + ((e[B] | e[B + 1] << 8 | e[B + 2] << 16) >> (7 & P) & (1 << Zn[R]) - 1);
					if (B = (P -= W) >> 3, U = x.t[U] + ((e[B] | e[B + 1] << 8) >> (7 & P) & (1 << W) - 1), B = (P -= K) >> 3, L = E.t[L] + ((e[B] | e[B + 1] << 8) >> (7 & P) & (1 << K) - 1), B = (P -= z) >> 3, M = v.t[M] + ((e[B] | e[B + 1] << 8) >> (7 & P) & (1 << z) - 1), $ > 3) t.o[2] = t.o[1], t.o[1] = t.o[0], t.o[0] = $ -= 3;
					else {
						var q = $ - (0 != V);
						q ? ($ = 3 == q ? t.o[0] - 1 : t.o[q], q > 1 && (t.o[2] = t.o[1]), t.o[1] = t.o[0], t.o[0] = $) : $ = t.o[0];
					}
					for (b = 0; b < V; ++b) g[H + b] = g[m + b];
					m += V;
					var G = (H += V) - $;
					if (G < 0) {
						var j = -G, Y = t.e + G;
						j > F && (j = F);
						for (b = 0; b < j; ++b) g[H + b] = t.w[Y + b];
						H += j, F -= j, G = 0;
					}
					for (b = 0; b < F; ++b) g[H + b] = g[G + b];
					H += F;
				}
				if (H != m) for (; m < g.length;) g[H++] = g[m++];
				else H = g.length;
				n ? t.y += H : g = Kn(g, 0, H);
			} else if (n) {
				if (t.y += f, m) for (b = 0; b < f; ++b) g[b] = g[m + b];
			} else m && (g = Kn(g, m));
			return t.b = c, g;
		}
		$n(2);
	}
};
function sr(e, t) {
	for (var n = [], r = +!t, i = 0, s = 0; e.length;) {
		var o = Vn(e, r || t);
		if ("object" == typeof o) {
			for (r ? (t = null, o.w.length == o.u && (n.push(t = o.w), s += o.u)) : (n.push(t), o.e = 0); !o.l;) {
				var a = ir(e, o, t);
				a || $n(5), t ? o.e = o.y : (n.push(a), s += a.length, zn(o.w, 0, a.length), o.w.set(a, o.w.length - a.length));
			}
			i = o.b + 4 * o.c;
		} else i = o;
		e = e.subarray(i);
	}
	return function(e, t) {
		if (1 == e.length) return e[0];
		for (var n = new Ln(t), r = 0, i = 0; r < e.length; ++r) {
			var s = e[r];
			n.set(s, i), i += s.length;
		}
		return n;
	}(n, s);
}
const or = 4096, ar = 1024, cr = 12, lr = 16, hr = 32, dr = 48, fr = 100, ur = 24, pr = -2147483648, gr = {
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
var mr = class extends Error {
	code;
	constructor(e, t) {
		super(t || gr[e] || `Error ${e}`), this.code = e, this.name = "SFSError";
	}
};
const _r = new TextEncoder(), yr = new TextDecoder();
function wr(e) {
	return e.buffer instanceof SharedArrayBuffer ? yr.decode(new Uint8Array(e)) : yr.decode(e);
}
function Sr(e) {
	return e + 3 & -4;
}
var kr = class e {
	buffer;
	view;
	i32;
	u8;
	constructor(e) {
		this.buffer = e, this.view = new DataView(e), this.i32 = new Int32Array(e), this.u8 = new Uint8Array(e);
	}
	static mkfs(t, n) {
		const r = t.byteLength;
		if (r < 65536) throw new mr(-22);
		const i = Math.floor(r / or), s = n ? Math.floor(n / or) : 4 * i;
		let o = Math.floor(s / 4);
		o < 32 && (o = 32), o = 32 * Math.ceil(o / 32);
		const a = Math.ceil(o / 32768), c = Math.ceil(s / 32768), l = Math.ceil(128 * o / or), h = 1 + a, d = h + c, f = d + l;
		if (f >= i) throw new mr(-28);
		new Uint8Array(t).fill(0);
		const u = new e(t);
		u.w32(0, 1397114451), u.w32(4, 1), u.w32(8, or), u.w32(12, i), u.w32(16, o), u.w32(28, 1), u.w32(32, h), u.w32(36, d), u.w32(40, f), u.w32(44, a), u.w32(48, c), u.w32(52, l), u.w32(68, s), u.w32(72, 256);
		const p = h * or;
		for (let e = 0; e < f; e++) {
			const t = (p >> 2) + (e >> 5);
			u.i32[t] |= 1 << (31 & e);
		}
		const g = i - f;
		Atomics.store(u.i32, 5, g), u.i32[1024] |= 3, Atomics.store(u.i32, 6, o - 2);
		const m = u.inodeOffset(1);
		u.w32(m + 8, 16877), u.w32(m + cr, 2);
		const _ = u.blockAlloc();
		if (_ < 0) throw new mr(-28);
		u.w32(m + dr, _);
		const y = _ * or, w = Sr(9), S = Sr(10);
		u.w32(y, 1), u.view.setUint16(y + 4, w, !0), u.view.setUint16(y + 6, 1, !0), u.u8[y + 8] = 46;
		const k = y + w;
		return u.w32(k, 1), u.view.setUint16(k + 4, S, !0), u.view.setUint16(k + 6, 2, !0), u.u8[k + 8] = 46, u.u8[k + 8 + 1] = 46, u.w64(m + lr, w + S), Atomics.store(u.i32, 14, 1), u;
	}
	static mount(t) {
		const n = new e(t);
		if (1397114451 !== n.r32(0)) throw new mr(-22, "Bad magic");
		if (1 !== n.r32(4)) throw new mr(-22, "Bad version");
		if (4096 !== n.r32(8)) throw new mr(-22, "Bad block size");
		return n;
	}
	statfs() {
		const e = this.r32(8), t = this.r32(12), n = this.r32(68), r = "number" == typeof this.buffer.maxByteLength ? this.buffer.maxByteLength : this.buffer.byteLength, i = Math.floor(r / e), s = Math.max(t, Math.min(n, i));
		return {
			blockSize: e,
			totalBlocks: s,
			freeBlocks: Atomics.load(this.i32, 5) + Math.max(0, s - t),
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
		const e = this.r32(12), t = this.r32(32) * or, n = Math.ceil(e / 32);
		for (let r = 0; r < n; r++) {
			const n = (t >> 2) + r, i = Atomics.load(this.i32, n);
			if (-1 !== i) for (let t = 0; t < 32; t++) {
				const s = 32 * r + t;
				if (s >= e) return -28;
				if (i & 1 << t) continue;
				const o = i | 1 << t;
				if (Atomics.compareExchange(this.i32, n, i, o) === i) {
					Atomics.sub(this.i32, 5, 1);
					const e = s * or;
					return this.u8.fill(0, e, e + or), s;
				}
				r--;
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
		const t = (this.r32(32) * or >> 2) + (e >> 5), n = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t), r = e & ~(1 << n);
			if (Atomics.compareExchange(this.i32, t, e, r) === e) break;
		}
		Atomics.add(this.i32, 5, 1);
	}
	grow() {
		this.sbLock();
		try {
			if (Atomics.load(this.i32, 5) > 0) return 0;
			const e = this.r32(12), t = this.r32(68);
			let n = this.r32(72), r = e + n;
			if (r > t && (r = t, n = r - e, 0 === n)) return -28;
			const i = r * or;
			if (this.buffer.byteLength < i) try {
				this.buffer.grow(i), this.view = new DataView(this.buffer), this.i32 = new Int32Array(this.buffer), this.u8 = new Uint8Array(this.buffer);
			} catch {
				return -28;
			}
			return this.w32(12, r), Atomics.add(this.i32, 5, n), Atomics.add(this.i32, 14, 1), 0;
		} finally {
			this.sbUnlock();
		}
	}
	inodeOffset(e) {
		return (this.r32(36) + Math.floor(e / 32)) * or + e % 32 * 128;
	}
	inodeAlloc() {
		const e = this.r32(16), t = this.r32(28) * or, n = Math.ceil(e / 32);
		for (let r = 0; r < n; r++) {
			const n = (t >> 2) + r, i = Atomics.load(this.i32, n);
			if (-1 !== i) for (let t = 0; t < 32; t++) {
				const s = 32 * r + t;
				if (s >= e) return -28;
				if (i & 1 << t) continue;
				const o = i | 1 << t;
				if (Atomics.compareExchange(this.i32, n, i, o) === i) {
					Atomics.sub(this.i32, 6, 1);
					const e = this.inodeOffset(s);
					return this.u8.fill(0, e, e + 128), s;
				}
				r--;
				break;
			}
		}
		return -28;
	}
	inodeFree(e) {
		const t = (this.r32(28) * or >> 2) + (e >> 5), n = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t), r = e & ~(1 << n);
			if (Atomics.compareExchange(this.i32, t, e, r) === e) break;
		}
		Atomics.add(this.i32, 6, 1);
	}
	inodeReadLock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		for (;;) {
			const e = Atomics.load(this.i32, t);
			if (e & pr) Atomics.wait(this.i32, t, e);
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
				if (0 === Atomics.compareExchange(this.i32, t, 0, pr)) return;
			} else Atomics.wait(this.i32, t, e);
		}
	}
	inodeWriteUnlock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		Atomics.store(this.i32, t, 0), Atomics.notify(this.i32, t, Infinity);
	}
	inodeBlockMap(e, t, n) {
		const r = this.inodeOffset(e);
		if (t < 10) {
			const e = this.r32(r + dr + 4 * t);
			if (0 !== e) return e;
			if (!n) return 0;
			const i = this.blockAllocWithGrow();
			return i < 0 || this.w32(r + dr + 4 * t, i), i;
		}
		if ((t -= 10) < 1024) {
			let e = this.r32(r + 88);
			if (0 === e) {
				if (!n) return 0;
				if (e = this.blockAllocWithGrow(), e < 0) return e;
				this.w32(r + 88, e);
			}
			const i = e * or + 4 * t, s = this.r32(i);
			if (0 !== s) return s;
			if (!n) return 0;
			const o = this.blockAllocWithGrow();
			return o < 0 || this.w32(i, o), o;
		}
		if ((t -= ar) < 1048576) {
			const e = Math.floor(t / ar), i = t % ar;
			let s = this.r32(r + 92);
			if (0 === s) {
				if (!n) return 0;
				if (s = this.blockAllocWithGrow(), s < 0) return s;
				this.w32(r + 92, s);
			}
			const o = s * or + 4 * e;
			let a = this.r32(o);
			if (0 === a) {
				if (!n) return 0;
				if (a = this.blockAllocWithGrow(), a < 0) return a;
				this.w32(o, a);
			}
			const c = a * or + 4 * i, l = this.r32(c);
			if (0 !== l) return l;
			if (!n) return 0;
			const h = this.blockAllocWithGrow();
			return h < 0 || this.w32(c, h), h;
		}
		return -22;
	}
	inodeReadData(e, t, n, r) {
		const i = this.inodeOffset(e), s = this.r64(i + lr);
		if (t >= s) return 0;
		t + r > s && (r = s - t);
		let o = 0, a = 0;
		for (; r > 0;) {
			const i = Math.floor(t / or), s = t % or;
			let c = or - s;
			c > r && (c = r);
			const l = this.inodeBlockMap(e, i, !1);
			if (l <= 0) n.fill(0, a, a + c);
			else {
				const e = l * or + s;
				n.set(this.u8.subarray(e, e + c), a);
			}
			a += c, t += c, r -= c, o += c;
		}
		return o;
	}
	inodeWriteData(e, t, n, r) {
		const i = this.inodeOffset(e);
		let s = 0, o = 0;
		for (; r > 0;) {
			const i = Math.floor(t / or), a = t % or;
			let c = or - a;
			c > r && (c = r);
			const l = this.inodeBlockMap(e, i, !0);
			if (l < 0) return s > 0 ? s : l;
			const h = l * or + a;
			this.u8.set(n.subarray(o, o + c), h), o += c, t += c, r -= c, s += c;
		}
		return t > this.r64(i + lr) && this.w64(i + lr, t), s;
	}
	freeBlocksFrom(e, t) {
		const n = this.inodeOffset(e);
		for (let s = t; s < 10; s++) {
			const e = this.r32(n + dr + 4 * s);
			e && (this.blockFree(e), this.w32(n + dr + 4 * s, 0));
		}
		const r = this.r32(n + 88);
		if (r) {
			const e = t > 10 ? t - 10 : 0;
			for (let t = e; t < ar; t++) {
				const e = r * or + 4 * t, n = this.r32(e);
				n && (this.blockFree(n), this.w32(e, 0));
			}
			0 === e && (this.blockFree(r), this.w32(n + 88, 0));
		}
		const i = this.r32(n + 92);
		if (i) {
			const e = t > 1034 ? t - 10 - ar : 0, r = Math.floor(e / ar);
			for (let t = r; t < ar; t++) {
				const n = i * or + 4 * t, s = this.r32(n);
				if (!s) continue;
				const o = t === r ? e % ar : 0;
				for (let e = o; e < ar; e++) {
					const t = s * or + 4 * e, n = this.r32(t);
					n && (this.blockFree(n), this.w32(t, 0));
				}
				0 === o && (this.blockFree(s), this.w32(n, 0));
			}
			0 === r && (this.blockFree(i), this.w32(n + 92, 0));
		}
	}
	inodeTruncate(e, t) {
		const n = this.inodeOffset(e);
		if (t >= this.r64(n + lr)) return void this.w64(n + lr, t);
		const r = Math.ceil(t / or);
		this.freeBlocksFrom(e, r), this.w64(n + lr, t);
	}
	dirLookup(e, t) {
		const n = this.inodeOffset(e), r = this.r64(n + lr);
		let i = 0;
		for (; i < r;) {
			const n = Math.floor(i / or), s = i % or, o = this.inodeBlockMap(e, n, !1);
			if (o <= 0) return -5;
			const a = o * or;
			let c = r - i;
			c > 4096 - s && (c = or - s);
			let l = s;
			for (; l < s + c;) {
				const e = a + l, n = this.r32(e), r = this.view.getUint16(e + 4, !0), i = this.view.getUint16(e + 6, !0);
				if (0 === r) return -5;
				if (0 !== n && i === t.length) {
					let r = !0;
					for (let n = 0; n < t.length; n++) if (this.u8[e + 8 + n] !== t[n]) {
						r = !1;
						break;
					}
					if (r) return n;
				}
				l += r;
			}
			i += c;
		}
		return -2;
	}
	dirAddEntry(e, t, n) {
		const r = this.inodeOffset(e), i = this.r64(r + lr), s = Sr(8 + t.length);
		let o = -1, a = 0;
		for (; a < i;) {
			const r = Math.floor(a / or), c = a % or, l = this.inodeBlockMap(e, r, !1);
			if (l <= 0) return -5;
			const h = l * or;
			let d = i - a;
			d > 4096 - c && (d = or - c);
			let f = c;
			for (; f < c + d;) {
				const e = h + f, r = this.r32(e), i = this.view.getUint16(e + 4, !0), a = this.view.getUint16(e + 6, !0);
				if (0 === i) return -5;
				if (0 === r && i >= s) return this.w32(e, n), this.view.setUint16(e + 6, t.length, !0), this.u8.set(t, e + 8), 0;
				const c = Sr(8 + a), l = i - c;
				if (0 !== r && l >= s) {
					this.view.setUint16(e + 4, c, !0);
					const r = e + c;
					return this.w32(r, n), this.view.setUint16(r + 4, l, !0), this.view.setUint16(r + 6, t.length, !0), this.u8.set(t, r + 8), 0;
				}
				o = e, f += i;
			}
			a += d;
		}
		let c, l = i, h = Math.floor(l / or), d = l % or;
		if (0 !== d && d + s > 4096) {
			const t = or - d;
			if (t >= 8) {
				const n = this.inodeBlockMap(e, h, !1);
				if (n > 0) {
					const e = n * or + d;
					this.w32(e, 0), this.view.setUint16(e + 4, t, !0), this.view.setUint16(e + 6, 0, !0);
				}
			} else if (o >= 0) {
				const e = this.view.getUint16(o + 4, !0);
				this.view.setUint16(o + 4, e + t, !0);
			}
			l = (h + 1) * or, h++, d = 0;
		}
		if (0 === d) {
			if (c = this.inodeBlockMap(e, h, !0), c < 0) return c;
		} else if (c = this.inodeBlockMap(e, h, !1), c <= 0) return -5;
		const f = c * or + d;
		return this.w32(f, n), this.view.setUint16(f + 4, s, !0), this.view.setUint16(f + 6, t.length, !0), this.u8.set(t, f + 8), this.w64(r + lr, l + s), 0;
	}
	dirRemoveEntry(e, t) {
		const n = this.inodeOffset(e), r = this.r64(n + lr);
		let i = 0;
		for (; i < r;) {
			const n = Math.floor(i / or), s = i % or, o = this.inodeBlockMap(e, n, !1);
			if (o <= 0) return -5;
			const a = o * or;
			let c = r - i;
			c > 4096 - s && (c = or - s);
			let l = s;
			for (; l < s + c;) {
				const e = a + l, n = this.r32(e), r = this.view.getUint16(e + 4, !0), i = this.view.getUint16(e + 6, !0);
				if (0 === r) return -5;
				if (0 !== n && i === t.length) {
					let n = !0;
					for (let r = 0; r < t.length; r++) if (this.u8[e + 8 + r] !== t[r]) {
						n = !1;
						break;
					}
					if (n) return this.w32(e, 0), 0;
				}
				l += r;
			}
			i += c;
		}
		return -2;
	}
	dirIsEmpty(e) {
		const t = this.inodeOffset(e), n = this.r64(t + lr);
		let r = 0;
		for (; r < n;) {
			const t = Math.floor(r / or), i = r % or, s = this.inodeBlockMap(e, t, !1);
			if (s <= 0) return !0;
			const o = s * or;
			let a = n - r;
			a > 4096 - i && (a = or - i);
			let c = i;
			for (; c < i + a;) {
				const e = o + c, t = this.r32(e), n = this.view.getUint16(e + 4, !0), r = this.view.getUint16(e + 6, !0);
				if (0 === n) break;
				if (0 !== t) {
					if (1 === r && 46 === this.u8[e + 8]) {
						c += n;
						continue;
					}
					if (2 === r && 46 === this.u8[e + 8] && 46 === this.u8[e + 8 + 1]) {
						c += n;
						continue;
					}
					return !1;
				}
				c += n;
			}
			r += a;
		}
		return !0;
	}
	pathResolve(e, t) {
		if (!e.startsWith("/")) return -2;
		let n = 1;
		const r = e.split("/").filter((e) => e.length > 0);
		let i = 0;
		for (let s = 0; s < r.length; s++) {
			const e = r[s];
			if (e.length > 255) return -36;
			const o = this.inodeOffset(n);
			if (16384 != (61440 & this.r32(o + 8))) return -20;
			const a = _r.encode(e), c = this.dirLookup(n, a);
			if (c < 0) return c;
			const l = this.inodeOffset(c);
			if (40960 == (61440 & this.r32(l + 8)) && (s !== r.length - 1 || t)) {
				if (++i > 8) return -40;
				const e = this.r64(l + lr);
				let t;
				if (e <= 40) t = wr(this.u8.subarray(l + dr, l + dr + e));
				else {
					const n = new Uint8Array(e);
					this.inodeReadData(c, 0, n, e), t = yr.decode(n);
				}
				if (t.startsWith("/")) {
					n = 1;
					const e = t.split("/").filter((e) => e.length > 0), i = r.slice(s + 1);
					r.length = 0, r.push(...e, ...i), s = -1;
				} else {
					const e = t.split("/").filter((e) => e.length > 0), n = r.slice(s + 1);
					r.length = s, r.push(...e, ...n), s--;
				}
				continue;
			}
			n = c;
		}
		return n;
	}
	pathResolveParent(e) {
		if (!e.startsWith("/")) throw new mr(-22, "Path must be absolute");
		const t = e.split("/").filter((e) => e.length > 0);
		if (0 === t.length) throw new mr(-22, "Cannot operate on /");
		const n = t.pop();
		if (n.length > 255) throw new mr(-36);
		const r = "/" + t.join("/"), i = this.pathResolve(r, !0);
		if (i < 0) throw new mr(i);
		const s = this.inodeOffset(i);
		if (16384 != (61440 & this.r32(s + 8))) throw new mr(-20);
		return {
			parentIno: i,
			name: n
		};
	}
	fdAlloc(e, t, n) {
		for (let r = 0; r < 64; r++) {
			const i = 256 + r * ur, s = i >> 2;
			if (0 === Atomics.compareExchange(this.i32, s, 0, 1)) return this.w32(i + 4, e), this.w64(i + 8, 0), this.w32(i + 16, t), this.w32(i + 20, n ? 1 : 0), r;
		}
		return -24;
	}
	fdGet(e) {
		if (e < 0 || e >= 64) return null;
		const t = 256 + e * ur;
		return Atomics.load(this.i32, t >> 2) ? {
			base: t,
			ino: this.r32(t + 4),
			offset: this.r64(t + 8),
			flags: this.r32(t + 16),
			isDir: 0 !== this.r32(t + 20)
		} : null;
	}
	fdFree(e) {
		if (e >= 0 && e < 64) {
			const t = 256 + e * ur;
			Atomics.store(this.i32, t >> 2, 0);
		}
	}
	buildStat(e) {
		const t = this.inodeOffset(e);
		return {
			ino: e,
			mode: this.r32(t + 8),
			linkCount: this.r32(t + cr),
			size: this.r64(t + lr),
			mtime: this.r64(t + 24),
			ctime: this.r64(t + hr),
			atime: this.r64(t + 40),
			uid: this.r32(t + 96),
			gid: this.r32(t + fr)
		};
	}
	open(e, t, n = 420) {
		const r = 3 & t, i = !!(64 & t);
		let s = this.pathResolve(e, !0);
		if (s < 0 && -2 === s && i) {
			const { parentIno: t, name: r } = this.pathResolveParent(e);
			this.inodeWriteLock(t);
			try {
				const e = _r.encode(r), i = this.dirLookup(t, e);
				if (i >= 0) s = i;
				else {
					const r = this.inodeAlloc();
					if (r < 0) throw new mr(-28);
					const i = this.inodeOffset(r);
					this.w32(i + 8, 32768 | 4095 & n), this.w32(i + cr, 1), this.w64(i + lr, 0);
					const o = Date.now();
					this.w64(i + 40, o), this.w64(i + 24, o), this.w64(i + hr, o);
					const a = this.dirAddEntry(t, e, r);
					if (a < 0) throw this.inodeFree(r), new mr(a);
					s = r;
				}
			} finally {
				this.inodeWriteUnlock(t);
			}
		}
		if (s < 0) throw new mr(s);
		const o = this.inodeOffset(s), a = this.r32(o + 8);
		if (16384 == (61440 & a) && 0 !== r) throw new mr(-21);
		if (65536 & t && 16384 != (61440 & a)) throw new mr(-20);
		if (512 & t) {
			if (16384 == (61440 & a)) throw new mr(-21);
			this.inodeWriteLock(s), this.inodeTruncate(s, 0), this.inodeWriteUnlock(s);
		}
		const c = this.fdAlloc(s, t, !1);
		if (c < 0) throw new mr(c);
		if (1024 & t) {
			const e = 256 + c * ur;
			this.w64(e + 8, this.r64(o + lr));
		}
		return c;
	}
	close(e) {
		if (!this.fdGet(e)) throw new mr(-9);
		this.fdFree(e);
	}
	read(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new mr(-9);
		this.inodeReadLock(n.ino);
		try {
			const r = this.inodeReadData(n.ino, n.offset, t, t.length), i = 256 + e * ur;
			return this.w64(i + 8, n.offset + r), r;
		} finally {
			this.inodeReadUnlock(n.ino);
		}
	}
	write(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new mr(-9);
		if (!(3 & n.flags)) throw new mr(-9);
		this.inodeWriteLock(n.ino);
		try {
			let r = n.offset;
			if (1024 & n.flags) {
				const e = this.inodeOffset(n.ino);
				r = this.r64(e + lr);
			}
			const i = this.inodeWriteData(n.ino, r, t, t.length), s = 256 + e * ur;
			return this.w64(s + 8, r + i), i;
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	lseek(e, t, n) {
		const r = this.fdGet(e);
		if (!r) throw new mr(-9);
		let i;
		if (0 === n) i = t;
		else if (1 === n) i = r.offset + t;
		else {
			if (2 !== n) throw new mr(-22);
			{
				const e = this.inodeOffset(r.ino);
				i = this.r64(e + lr) + t;
			}
		}
		if (i < 0) throw new mr(-22);
		const s = 256 + e * ur;
		return this.w64(s + 8, i), i;
	}
	ftruncate(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new mr(-9);
		if (!(3 & n.flags)) throw new mr(-9);
		this.inodeWriteLock(n.ino);
		try {
			this.inodeTruncate(n.ino, t);
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	fstat(e) {
		const t = this.fdGet(e);
		if (!t) throw new mr(-9);
		this.inodeReadLock(t.ino);
		try {
			return this.buildStat(t.ino);
		} finally {
			this.inodeReadUnlock(t.ino);
		}
	}
	stat(e) {
		const t = this.pathResolve(e, !0);
		if (t < 0) throw new mr(t);
		this.inodeReadLock(t);
		try {
			return this.buildStat(t);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	lstat(e) {
		const t = this.pathResolve(e, !1);
		if (t < 0) throw new mr(t);
		this.inodeReadLock(t);
		try {
			return this.buildStat(t);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	unlink(e) {
		const { parentIno: t, name: n } = this.pathResolveParent(e), r = _r.encode(n);
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, r);
			if (e < 0) throw new mr(e);
			const n = this.inodeOffset(e);
			if (16384 == (61440 & this.r32(n + 8))) throw new mr(-21);
			const i = this.dirRemoveEntry(t, r);
			if (i < 0) throw new mr(i);
			this.inodeWriteLock(e);
			const s = this.r32(n + cr);
			s <= 1 ? (this.inodeTruncate(e, 0), this.w32(n + cr, 0), this.inodeWriteUnlock(e), this.inodeFree(e)) : (this.w32(n + cr, s - 1), this.inodeWriteUnlock(e));
		} finally {
			this.inodeWriteUnlock(t);
		}
	}
	rename(e, t) {
		const { parentIno: n, name: r } = this.pathResolveParent(e), { parentIno: i, name: s } = this.pathResolveParent(t), o = _r.encode(r), a = _r.encode(s), c = Math.min(n, i), l = Math.max(n, i);
		this.inodeWriteLock(c), c !== l && this.inodeWriteLock(l);
		try {
			const e = this.dirLookup(n, o);
			if (e < 0) throw new mr(e);
			const t = this.dirLookup(i, a);
			if (t >= 0) {
				const e = this.inodeOffset(t);
				if (16384 == (61440 & this.r32(e + 8))) throw new mr(-21);
				this.dirRemoveEntry(i, a), this.inodeWriteLock(t), this.inodeTruncate(t, 0), this.w32(e + cr, 0), this.inodeWriteUnlock(t), this.inodeFree(t);
			}
			const r = this.dirAddEntry(i, a, e);
			if (r < 0) throw new mr(r);
			this.dirRemoveEntry(n, o);
			const s = this.inodeOffset(e);
			if (16384 == (61440 & this.r32(s + 8)) && n !== i) {
				const e = this.inodeOffset(n);
				this.w32(e + cr, this.r32(e + cr) - 1);
				const t = this.inodeOffset(i);
				this.w32(t + cr, this.r32(t + cr) + 1);
			}
		} finally {
			c !== l && this.inodeWriteUnlock(l), this.inodeWriteUnlock(c);
		}
	}
	mkdir(e, t = 493) {
		const { parentIno: n, name: r } = this.pathResolveParent(e), i = _r.encode(r);
		this.inodeWriteLock(n);
		try {
			if (this.dirLookup(n, i) >= 0) throw new mr(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new mr(-28);
			const r = this.inodeOffset(e);
			this.w32(r + 8, 16384 | t), this.w32(r + cr, 2), this.w64(r + lr, 0);
			const s = Date.now();
			this.w64(r + 40, s), this.w64(r + 24, s), this.w64(r + hr, s);
			const o = this.blockAllocWithGrow();
			if (o < 0) throw this.inodeFree(e), new mr(-28);
			this.w32(r + dr, o);
			const a = o * or, c = Sr(9), l = Sr(10);
			this.w32(a, e), this.view.setUint16(a + 4, c, !0), this.view.setUint16(a + 6, 1, !0), this.u8[a + 8] = 46;
			const h = a + c;
			this.w32(h, n), this.view.setUint16(h + 4, l, !0), this.view.setUint16(h + 6, 2, !0), this.u8[h + 8] = 46, this.u8[h + 8 + 1] = 46, this.w64(r + lr, c + l);
			const d = this.dirAddEntry(n, i, e);
			if (d < 0) throw this.blockFree(o), this.inodeFree(e), new mr(d);
			const f = this.inodeOffset(n);
			this.w32(f + cr, this.r32(f + cr) + 1);
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	rmdir(e) {
		const { parentIno: t, name: n } = this.pathResolveParent(e), r = _r.encode(n);
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, r);
			if (e < 0) throw new mr(e);
			const n = this.inodeOffset(e);
			if (16384 != (61440 & this.r32(n + 8))) throw new mr(-20);
			this.inodeWriteLock(e);
			try {
				if (!this.dirIsEmpty(e)) throw new mr(-39);
				this.dirRemoveEntry(t, r), this.inodeTruncate(e, 0), this.w32(n + cr, 0);
			} finally {
				this.inodeWriteUnlock(e);
			}
			this.inodeFree(e);
			const i = this.inodeOffset(t);
			this.w32(i + cr, this.r32(i + cr) - 1);
		} finally {
			this.inodeWriteUnlock(t);
		}
	}
	symlink(e, t) {
		const { parentIno: n, name: r } = this.pathResolveParent(t), i = _r.encode(r), s = _r.encode(e);
		this.inodeWriteLock(n);
		try {
			if (this.dirLookup(n, i) >= 0) throw new mr(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new mr(-28);
			const t = this.inodeOffset(e);
			if (this.w32(t + 8, 41471), this.w32(t + cr, 1), s.length <= 40) this.u8.set(s, t + dr), this.w64(t + lr, s.length);
			else {
				this.w64(t + lr, 0);
				const n = this.inodeWriteData(e, 0, s, s.length);
				if (n < 0) throw this.inodeFree(e), new mr(n);
			}
			const r = this.dirAddEntry(n, i, e);
			if (r < 0) throw this.inodeFree(e), new mr(r);
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	chmod(e, t) {
		const n = this.pathResolve(e, !0);
		if (n < 0) throw new mr(n);
		this.inodeWriteLock(n);
		try {
			const e = this.inodeOffset(n), r = this.r32(e + 8);
			this.w32(e + 8, 61440 & r | 4095 & t), this.w64(e + hr, Date.now());
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	fchmod(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new mr(-9);
		this.inodeWriteLock(n.ino);
		try {
			const e = this.inodeOffset(n.ino), r = this.r32(e + 8);
			this.w32(e + 8, 61440 & r | 4095 & t), this.w64(e + hr, Date.now());
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	chown(e, t, n) {
		const r = this.pathResolve(e, !0);
		if (r < 0) throw new mr(r);
		this.inodeWriteLock(r);
		try {
			const e = this.inodeOffset(r);
			this.w32(e + 96, t), this.w32(e + fr, n), this.w64(e + hr, Date.now());
		} finally {
			this.inodeWriteUnlock(r);
		}
	}
	fchown(e, t, n) {
		const r = this.fdGet(e);
		if (!r) throw new mr(-9);
		this.inodeWriteLock(r.ino);
		try {
			const e = this.inodeOffset(r.ino);
			this.w32(e + 96, t), this.w32(e + fr, n), this.w64(e + hr, Date.now());
		} finally {
			this.inodeWriteUnlock(r.ino);
		}
	}
	lchown(e, t, n) {
		const r = this.pathResolve(e, !1);
		if (r < 0) throw new mr(r);
		this.inodeWriteLock(r);
		try {
			const e = this.inodeOffset(r);
			this.w32(e + 96, t), this.w32(e + fr, n), this.w64(e + hr, Date.now());
		} finally {
			this.inodeWriteUnlock(r);
		}
	}
	utimens(e, t, n, r, i) {
		const s = this.pathResolve(e, !0);
		if (s < 0) throw new mr(s);
		this.inodeWriteLock(s);
		try {
			const e = this.inodeOffset(s), o = 1073741823, a = 1073741822, c = Date.now();
			if (n !== a) {
				const r = n === o ? c : 1e3 * t + Math.floor(n / 1e6);
				this.w64(e + 40, r);
			}
			if (i !== a) {
				const t = i === o ? c : 1e3 * r + Math.floor(i / 1e6);
				this.w64(e + 24, t);
			}
			this.w64(e + hr, c);
		} finally {
			this.inodeWriteUnlock(s);
		}
	}
	link(e, t) {
		const n = this.pathResolve(e, !0);
		if (n < 0) throw new mr(n);
		const r = this.inodeOffset(n);
		if (16384 == (61440 & this.r32(r + 8))) throw new mr(-1);
		const { parentIno: i, name: s } = this.pathResolveParent(t), o = _r.encode(s);
		this.inodeWriteLock(i);
		try {
			if (this.dirLookup(i, o) >= 0) throw new mr(-17);
			const e = this.dirAddEntry(i, o, n);
			if (e < 0) throw new mr(e);
			this.inodeWriteLock(n);
			try {
				const e = this.r32(r + cr);
				this.w32(r + cr, e + 1), this.w64(r + hr, Date.now());
			} finally {
				this.inodeWriteUnlock(n);
			}
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	readlink(e) {
		const t = this.pathResolve(e, !1);
		if (t < 0) throw new mr(t);
		const n = this.inodeOffset(t);
		if (40960 != (61440 & this.r32(n + 8))) throw new mr(-22);
		const r = this.r64(n + lr);
		if (r <= 40) return wr(this.u8.subarray(n + dr, n + dr + r));
		this.inodeReadLock(t);
		try {
			const e = new Uint8Array(r);
			return this.inodeReadData(t, 0, e, r), yr.decode(e);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	opendir(e) {
		const t = this.pathResolve(e, !0);
		if (t < 0) throw new mr(t);
		const n = this.inodeOffset(t);
		if (16384 != (61440 & this.r32(n + 8))) throw new mr(-20);
		const r = this.fdAlloc(t, 0, !0);
		if (r < 0) throw new mr(r);
		return r;
	}
	readdirEntry(e) {
		const t = this.fdGet(e);
		if (!t || !t.isDir) throw new mr(-9);
		const n = this.inodeOffset(t.ino), r = this.r64(n + lr);
		for (; t.offset < r;) {
			const n = t.offset, r = Math.floor(n / or), i = n % or, s = this.inodeBlockMap(t.ino, r, !1);
			if (s <= 0) return null;
			const o = s * or + i, a = this.r32(o), c = this.view.getUint16(o + 4, !0), l = this.view.getUint16(o + 6, !0);
			if (0 === c) return null;
			t.offset = n + c;
			const h = 256 + e * ur;
			if (this.w64(h + 8, n + c), 0 !== a) return {
				name: wr(this.u8.subarray(o + 8, o + 8 + l)),
				stat: this.buildStat(a)
			};
		}
		return null;
	}
	closedir(e) {
		this.close(e);
	}
	readdir(e) {
		const t = this.opendir(e), n = [];
		try {
			let e;
			for (; null !== (e = this.readdirEntry(t));) "." !== e.name && ".." !== e.name && n.push(e.name);
		} finally {
			this.closedir(t);
		}
		return n;
	}
	writeFile(e, t) {
		const n = "string" == typeof t ? _r.encode(t) : t, r = this.open(e, 577);
		try {
			this.write(r, n);
		} finally {
			this.close(r);
		}
	}
	readFile(e) {
		const t = this.open(e, 0);
		try {
			const e = this.fstat(t), n = new Uint8Array(e.size);
			return this.read(t, n), n;
		} finally {
			this.close(t);
		}
	}
	readFileText(e) {
		return yr.decode(this.readFile(e));
	}
};
const br = [
	40,
	181,
	47,
	253
], Ar = 1447449417, Ir = 16, Cr = 65536;
function Er(e) {
	if (!e || "object" != typeof e) throw new Error("VFS image metadata must be an object");
	if (1 !== e.version) throw new Error(`Unsupported VFS image metadata version: ${String(e.version)}`);
	if (void 0 !== e.kernelAbi && (!Number.isInteger(e.kernelAbi) || e.kernelAbi < 0)) throw new Error("VFS image metadata kernelAbi must be a non-negative integer");
	if (void 0 !== e.createdBy && "string" != typeof e.createdBy) throw new Error("VFS image metadata createdBy must be a string");
	return { ...e };
}
function vr(e) {
	return e.byteLength >= br.length && e[0] === br[0] && e[1] === br[1] && e[2] === br[2] && e[3] === br[3] ? function(e) {
		return sr(e);
	}(e) : e;
}
function xr(e) {
	const t = vr(e);
	if (t.byteLength < Ir) throw new Error("VFS image too small");
	const n = new DataView(t.buffer, t.byteOffset, t.byteLength), r = n.getUint32(0, !0);
	if (r !== Ar) throw new Error(`Bad VFS image magic: 0x${r.toString(16)} (expected 0x${Ar.toString(16)})`);
	const i = n.getUint32(4, !0);
	if (1 !== i) throw new Error(`Unsupported VFS image version: ${i} (expected 1)`);
	const s = n.getUint32(8, !0), o = n.getUint32(12, !0);
	if (t.byteLength < Ir + o + 4) throw new Error("VFS image truncated");
	return {
		image: t,
		view: n,
		flags: s,
		sabLen: o
	};
}
var Tr = class e {
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
	static create(t, n) {
		return new e(kr.mkfs(t, n));
	}
	static fromExisting(t) {
		return new e(kr.mount(t));
	}
	getImageMetadata() {
		return null === (e = this.imageMetadata) ? null : { ...e };
		var e;
	}
	setImageMetadata(e) {
		this.imageMetadata = null === e ? null : Er(e);
	}
	registerLazyFile(e, t, n, r = 493) {
		const i = e.split("/").filter(Boolean);
		let s = "";
		for (let c = 0; c < i.length - 1; c++) {
			s += "/" + i[c];
			try {
				this.fs.mkdir(s, 493);
			} catch {}
		}
		const o = this.fs.open(e, 577, r);
		this.fs.close(o);
		const a = this.fs.stat(e);
		return this.lazyFiles.set(a.ino, {
			path: e,
			url: t,
			size: n
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
		for (const [t, { path: n, url: r, size: i }] of this.lazyFiles) e.push({
			ino: t,
			path: n,
			url: r,
			size: i
		});
		return e;
	}
	getLazyEntry(e) {
		try {
			const t = this.fs.stat(e), n = this.lazyFiles.get(t.ino);
			return n ? {
				ino: t.ino,
				path: n.path,
				url: n.url,
				size: n.size
			} : null;
		} catch {
			return null;
		}
	}
	rewriteLazyFileUrls(e) {
		for (const [t, n] of this.lazyFiles) this.lazyFiles.set(t, {
			...n,
			url: e(n.url, n.path)
		});
	}
	registerLazyArchiveFromEntries(e, t, n, r) {
		const i = {
			url: e,
			mountPrefix: n,
			materialized: !1,
			entries: /* @__PURE__ */ new Map()
		}, s = n.replace(/\/+$/, "");
		for (const o of t) {
			if (o.isDirectory) continue;
			const e = s + "/" + o.fileName, t = e.split("/").filter(Boolean);
			let n = "";
			for (let r = 0; r < t.length - 1; r++) {
				n += "/" + t[r];
				try {
					this.fs.mkdir(n, 493);
				} catch {}
			}
			if (o.isSymlink && r?.has(o.fileName)) {
				const t = r.get(o.fileName);
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
			i.entries.set(e, c), this.lazyArchiveInodes.set(a.ino, i);
		}
		return this.lazyArchiveGroups.push(i), i;
	}
	importLazyArchiveEntries(e) {
		for (const t of e) {
			const e = /* @__PURE__ */ new Map();
			for (const r of t.entries) e.set(r.vfsPath, {
				ino: r.ino,
				size: r.size,
				isSymlink: r.isSymlink,
				deleted: r.deleted
			});
			const n = {
				url: t.url,
				mountPrefix: t.mountPrefix,
				materialized: t.materialized,
				entries: e
			};
			if (this.lazyArchiveGroups.push(n), !n.materialized) for (const [, t] of e) t.deleted || this.lazyArchiveInodes.set(t.ino, n);
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
			const t = this.fs.stat(e), n = this.lazyFiles.get(t.ino);
			if (n) {
				const e = await fetch(n.url);
				if (!e.ok) throw new Error(`Failed to fetch lazy file ${n.path}: HTTP ${e.status}`);
				const r = new Uint8Array(await e.arrayBuffer()), i = this.fs.open(n.path, 577, 493);
				return this.fs.write(i, r), this.fs.close(i), this.lazyFiles.delete(t.ino), !0;
			}
			const r = this.lazyArchiveInodes.get(t.ino);
			return !!r && (await this.ensureArchiveMaterialized(r), !0);
		} catch {
			return !1;
		}
	}
	async ensureArchiveMaterialized(e) {
		if (e.materialized) return;
		const t = await fetch(e.url);
		if (!t.ok) throw new Error(`Failed to fetch archive ${e.url}: HTTP ${t.status}`);
		const n = new Uint8Array(await t.arrayBuffer()), { parseZipCentralDirectory: r, extractZipEntry: i } = await import("./zip-D1JNL24E.js"), s = r(n), o = /* @__PURE__ */ new Map();
		for (const c of s) o.set(c.fileName, c);
		const a = e.mountPrefix.replace(/\/+$/, "");
		for (const [c, l] of e.entries) {
			if (l.deleted) continue;
			if (l.isSymlink) continue;
			const e = c.slice(a.length + 1), t = o.get(e);
			if (!t) continue;
			const r = i(n, t), s = this.fs.open(c, 577, 493);
			r.length > 0 && this.fs.write(s, r), this.fs.close(s);
		}
		e.materialized = !0;
		for (const [, c] of e.entries) this.lazyArchiveInodes.delete(c.ino);
	}
	async saveImage(e) {
		if (e?.materializeAll) {
			const e = Array.from(this.lazyFiles.values()).map((e) => e.path);
			for (const t of e) await this.ensureMaterialized(t);
		}
		const t = new Uint8Array(this.fs.buffer), n = this.exportLazyEntries(), r = n.length > 0, i = r ? new TextEncoder().encode(JSON.stringify(n)) : new Uint8Array(0), s = this.exportLazyArchiveEntries(), o = s.length > 0, a = o ? new TextEncoder().encode(JSON.stringify(s)) : new Uint8Array(0), c = function(e) {
			if (null === e) return new Uint8Array(0);
			const t = Er(e), n = new TextEncoder().encode(JSON.stringify(t));
			if (n.byteLength > Cr) throw new Error("VFS image metadata exceeds 65536 bytes");
			return n;
		}(void 0 === e?.metadata ? this.imageMetadata : e.metadata), l = c.byteLength > 0, h = o ? 4 + a.byteLength : 0, d = l ? 4 + c.byteLength : 0, f = Ir + t.byteLength + 4 + i.byteLength + h + d, u = new Uint8Array(f), p = new DataView(u.buffer);
		p.setUint32(0, Ar, !0), p.setUint32(4, 1, !0), p.setUint32(8, (r ? 1 : 0) | (o ? 2 : 0) | (l ? 4 : 0), !0), p.setUint32(12, t.byteLength, !0);
		const g = new Uint8Array(t.byteLength);
		g.set(t), u.set(g, Ir);
		const m = Ir + t.byteLength;
		if (p.setUint32(m, i.byteLength, !0), i.byteLength > 0 && u.set(i, m + 4), o) {
			const e = m + 4 + i.byteLength;
			p.setUint32(e, a.byteLength, !0), u.set(a, e + 4);
		}
		if (l) {
			const e = m + 4 + i.byteLength + h;
			p.setUint32(e, c.byteLength, !0), u.set(c, e + 4);
		}
		return u;
	}
	static readImageMetadata(e) {
		const t = xr(e);
		if (!(4 & t.flags)) return null;
		const { metadataOffset: n } = function(e, t, n, r) {
			const i = Ir + r, s = t.getUint32(i, !0), o = i + 4 + s;
			let a = o;
			if (2 & n) {
				if (e.byteLength < o + 4) throw new Error("VFS image truncated (lazy archive section)");
				a = o + 4 + t.getUint32(o, !0);
			}
			return {
				lazyLen: s,
				archiveOffset: o,
				metadataOffset: a
			};
		}(t.image, t.view, t.flags, t.sabLen);
		if (t.image.byteLength < n + 4) throw new Error("VFS image truncated (metadata section)");
		const r = t.view.getUint32(n, !0);
		if (r > Cr) throw new Error("VFS image metadata exceeds 65536 bytes");
		if (t.image.byteLength < n + 4 + r) throw new Error("VFS image truncated (metadata payload)");
		return 0 === r ? null : function(e) {
			if (e.byteLength > Cr) throw new Error("VFS image metadata exceeds 65536 bytes");
			let t;
			try {
				t = JSON.parse(new TextDecoder().decode(e));
			} catch (n) {
				const e = n instanceof Error ? n.message : String(n);
				throw new Error(`Invalid VFS image metadata JSON: ${e}`);
			}
			return Er(t);
		}(t.image.subarray(n + 4, n + 4 + r));
	}
	static assertImageKernelAbi(t, n, r = "VFS image") {
		const i = e.readImageMetadata(t)?.kernelAbi;
		if (void 0 !== i && i !== n) throw new Error(`${r} requires kernel ABI ${i}, but the running kernel is ABI ${n}`);
	}
	static fromImage(t, n) {
		const r = xr(t);
		t = r.image;
		const i = r.view, s = r.flags, o = r.sabLen, a = n?.maxByteLength ? { maxByteLength: n.maxByteLength } : void 0, c = new SharedArrayBuffer(o, a);
		new Uint8Array(c).set(t.subarray(Ir, Ir + o));
		let l = null;
		4 & s && (l = e.readImageMetadata(t));
		const h = new e(kr.mount(c), l), d = Ir + o, f = i.getUint32(d, !0);
		if (1 & s && f > 0) {
			const e = t.subarray(d + 4, d + 4 + f), n = JSON.parse(new TextDecoder().decode(e));
			h.importLazyEntries(n);
		}
		if (2 & s) {
			const e = d + 4 + f;
			if (t.byteLength < e + 4) throw new Error("VFS image truncated (lazy archive section)");
			const n = i.getUint32(e, !0);
			if (n > 0) {
				const r = t.subarray(e + 4, e + 4 + n), i = JSON.parse(new TextDecoder().decode(r));
				h.importLazyArchiveEntries(i);
			}
		}
		return h;
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
	open(e, t, n) {
		return this.fs.open(e, t, n);
	}
	close(e) {
		return this.fs.close(e), 0;
	}
	read(e, t, n, r) {
		if (null !== n) {
			const i = this.fs.lseek(e, 0, 1);
			this.fs.lseek(e, n, 0);
			const s = this.fs.read(e, t.subarray(0, r));
			return this.fs.lseek(e, i, 0), s;
		}
		return this.fs.read(e, t.subarray(0, r));
	}
	write(e, t, n, r) {
		if (null !== n) {
			const i = this.fs.lseek(e, 0, 1);
			this.fs.lseek(e, n, 0);
			const s = this.fs.write(e, t.subarray(0, r));
			return this.fs.lseek(e, i, 0), s;
		}
		return this.fs.write(e, t.subarray(0, r));
	}
	seek(e, t, n) {
		return this.fs.lseek(e, t, n);
	}
	fstat(e) {
		const t = this.adaptStat(this.fs.fstat(e)), n = this.lazyFiles.get(t.ino);
		if (n) t.size = n.size;
		else {
			const e = this.lazyArchiveInodes.get(t.ino);
			if (e) {
				for (const n of e.entries.values()) if (n.ino === t.ino) {
					t.size = n.size;
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
	fchown(e, t, n) {
		this.fs.fchown(e, t, n);
	}
	stat(e) {
		const t = this.adaptStat(this.fs.stat(e)), n = this.lazyFiles.get(t.ino);
		if (n) t.size = n.size;
		else {
			const e = this.lazyArchiveInodes.get(t.ino);
			if (e) {
				for (const n of e.entries.values()) if (n.ino === t.ino) {
					t.size = n.size;
					break;
				}
			}
		}
		return t;
	}
	lstat(e) {
		const t = this.adaptStat(this.fs.lstat(e)), n = this.lazyFiles.get(t.ino);
		if (n) t.size = n.size;
		else {
			const e = this.lazyArchiveInodes.get(t.ino);
			if (e) {
				for (const n of e.entries.values()) if (n.ino === t.ino) {
					t.size = n.size;
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
			const t = this.fs.lstat(e), n = this.lazyArchiveInodes.get(t.ino);
			if (n) {
				const r = n.entries.get(e);
				r && (r.deleted = !0), this.lazyArchiveInodes.delete(t.ino);
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
	chown(e, t, n) {
		this.fs.chown(e, t, n);
	}
	lchown(e, t, n) {
		this.fs.lchown(e, t, n);
	}
	createFileWithOwner(e, t, n, r, i) {
		const s = this.open(e, 577, t);
		i.length > 0 && this.write(s, i, null, i.length), this.close(s), this.chown(e, n, r), this.chmod(e, t);
	}
	mkdirWithOwner(e, t, n, r) {
		this.mkdir(e, t), this.chown(e, n, r), this.chmod(e, t);
	}
	symlinkWithOwner(e, t, n, r) {
		this.symlink(e, t), this.lchown(t, n, r);
	}
	access(e, t) {
		this.fs.stat(e);
	}
	utimensat(e, t, n, r, i) {
		this.fs.utimens(e, t, n, r, i);
	}
	opendir(e) {
		return this.fs.opendir(e);
	}
	readdir(e) {
		const t = this.fs.readdirEntry(e);
		if (!t) return null;
		const n = t.stat.mode;
		let r = 0;
		return 32768 == (61440 & n) ? r = 8 : 16384 == (61440 & n) ? r = 4 : 40960 == (61440 & n) && (r = 10), {
			name: t.name,
			type: r,
			ino: t.stat.ino
		};
	}
	closedir(e) {
		this.fs.closedir(e);
	}
};
const Pr = {
	reader: () => 0,
	writer: (e, t) => t,
	mode: 8630
}, Br = {
	reader: (e, t) => (e.fill(0, 0, t), t),
	writer: (e, t) => t,
	mode: 8630
}, Hr = {
	reader: () => {
		throw new Error("ENXIO");
	},
	writer: () => {
		throw new Error("ENXIO");
	},
	mode: 8630
};
const Ur = [
	"pts",
	"shm",
	"mqueue"
], Mr = [
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
function Lr(e) {
	return "/" === e || "" === e || "." === e;
}
var Rr = class {
	devices = /* @__PURE__ */ new Map();
	handles = /* @__PURE__ */ new Map();
	nextHandle = 1;
	deviceNames;
	constructor() {
		const e = {
			reader: (e, t) => {
				if (void 0 !== globalThis.crypto && globalThis.crypto.getRandomValues) {
					const n = new Uint8Array(t);
					globalThis.crypto.getRandomValues(n), e.set(n, 0);
				} else for (let n = 0; n < t; n++) e[n] = 256 * Math.random() | 0;
				return t;
			},
			writer: (e, t) => t,
			mode: 8630
		};
		this.devices.set("null", Pr), this.devices.set("zero", Br), this.devices.set("urandom", e), this.devices.set("random", e), this.devices.set("console", Hr), this.devices.set("tty", Hr), this.deviceNames = [...this.devices.keys()];
	}
	getDevice(e) {
		const t = e.startsWith("/") ? e.slice(1) : e, n = this.devices.get(t);
		if (!n) throw new Error("ENOENT");
		return n;
	}
	open(e, t, n) {
		const r = e.startsWith("/") ? e.slice(1) : e;
		if (Lr(e) || Ur.includes(r)) {
			const e = this.nextHandle++;
			return this.handles.set(e, { device: null }), e;
		}
		const i = this.getDevice(e), s = this.nextHandle++;
		return this.handles.set(s, { device: i }), s;
	}
	close(e) {
		if (!this.handles.delete(e)) throw new Error("EBADF");
		return 0;
	}
	read(e, t, n, r) {
		const i = this.handles.get(e);
		if (!i) throw new Error("EBADF");
		if (!i.device) throw new Error("EISDIR");
		return i.device.reader(t, Math.min(r, t.length));
	}
	write(e, t, n, r) {
		const i = this.handles.get(e);
		if (!i) throw new Error("EBADF");
		if (!i.device) throw new Error("EISDIR");
		return i.device.writer(t, Math.min(r, t.length));
	}
	seek(e, t, n) {
		return 0;
	}
	fstat(e) {
		const t = this.handles.get(e);
		if (!t) throw new Error("EBADF");
		const n = Date.now();
		return t.device ? {
			dev: 5,
			ino: 0,
			mode: t.device.mode,
			nlink: 1,
			uid: 0,
			gid: 0,
			size: 0,
			atimeMs: n,
			mtimeMs: n,
			ctimeMs: n
		} : {
			dev: 5,
			ino: 0,
			mode: 16877,
			nlink: 2,
			uid: 0,
			gid: 0,
			size: 0,
			atimeMs: n,
			mtimeMs: n,
			ctimeMs: n
		};
	}
	ftruncate(e, t) {}
	fsync(e) {}
	fchmod(e, t) {}
	fchown(e, t, n) {}
	stat(e) {
		const t = Date.now();
		if (Lr(e)) return {
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
		const n = e.startsWith("/") ? e.slice(1) : e;
		return Ur.includes(n) ? {
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
		return t.files = this.devices.size + Ur.length + Mr.length, t;
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
	chown(e, t, n) {}
	access(e, t) {
		this.stat(e);
	}
	utimensat(e, t, n, r, i) {}
	dirHandles = /* @__PURE__ */ new Map();
	nextDirHandle = 1;
	opendir(e) {
		const t = e.startsWith("/") ? e.slice(1) : e;
		let n;
		if (Lr(e)) n = [...this.deviceNames.map((e, t) => ({
			name: e,
			type: 2,
			ino: t + 1
		})), ...Mr.filter((e) => !this.devices.has(e.name))];
		else {
			if (!Ur.includes(t)) throw new Error("ENOTDIR");
			n = [];
		}
		const r = this.nextDirHandle++;
		return this.dirHandles.set(r, {
			idx: 0,
			entries: n
		}), r;
	}
	readdir(e) {
		const t = this.dirHandles.get(e);
		if (!t) throw new Error("EBADF");
		if (t.idx >= t.entries.length) return null;
		const n = t.entries[t.idx];
		return t.idx++, n;
	}
	closedir(e) {
		this.dirHandles.delete(e);
	}
}, Wr = class {
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
		const n = 1e3 * e + Math.floor(t / 1e6);
		if (n > 0) {
			const e = new SharedArrayBuffer(4);
			Atomics.wait(new Int32Array(e), 0, 0, n);
		}
	}
};
const Dr = [
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
function Kr(e) {
	const t = function(e, t) {
		let n = null;
		try {
			const r = e.stat(t);
			n = e.open(t, 0, 0);
			const i = new Uint8Array(r.size);
			let s = 0;
			for (; s < i.byteLength;) {
				const t = e.read(n, i.subarray(s), null, i.byteLength - s);
				if (t <= 0) break;
				s += t;
			}
			return new TextDecoder().decode(i.subarray(0, s));
		} catch {
			return null;
		} finally {
			if (null !== n) try {
				e.close(n);
			} catch {}
		}
	}(e, "/etc/group");
	null === t || /^nobody:/m.test(t) || function(e, t, n) {
		const r = new TextEncoder().encode(n), i = e.open(t, 577, 420);
		try {
			r.byteLength > 0 && e.write(i, r, null, r.byteLength);
		} finally {
			e.close(i);
		}
	}(e, "/etc/group", `${t.replace(/\n?$/, "\n")}nobody:x:65534:\n`);
}
function Or(e, t, n = {}) {
	(function(e) {
		const t = /* @__PURE__ */ new Set();
		for (const n of e) {
			if ("string" != typeof n.path || 0 === n.path.length) throw new Error("MountSpec: empty path");
			if (!n.path.startsWith("/")) throw new Error(`MountSpec: path must be absolute: ${n.path}`);
			if ("/" !== n.path && n.path.endsWith("/")) throw new Error(`MountSpec: trailing slash on non-root path: ${n.path}`);
			const e = n.path.split("/");
			for (const t of e) if ("." === t || ".." === t) throw new Error(`MountSpec: path contains "${t}" segment: ${n.path}`);
			if (t.has(n.path)) throw new Error(`MountSpec: duplicate mount path: ${n.path}`);
			t.add(n.path);
		}
	})(e);
	const r = [];
	for (const i of e) if ("image" === i.source) {
		const e = Tr.fromImage(t, { maxByteLength: 1073741824 });
		Kr(e), r.push({
			mountPoint: i.path,
			backend: e,
			readonly: i.readonly
		});
	} else {
		const e = n.scratchSabBytes?.[i.path] ?? 16777216, t = new SharedArrayBuffer(e), s = Tr.create(t);
		void 0 !== i.mode && s.chmod("/", i.mode), void 0 === i.uid && void 0 === i.gid || s.chown("/", i.uid ?? 0, i.gid ?? 0), r.push({
			mountPoint: i.path,
			backend: s,
			readonly: i.readonly
		});
	}
	return r;
}
var zr = class extends Error {
	errno = 11;
	constructor() {
		super("EAGAIN");
	}
};
function Nr(e) {
	let t = 0;
	e.forEach((e) => t += e.length);
	const n = new Uint8Array(t);
	let r = 0;
	return e.forEach((e) => {
		n.set(e, r), r += e.length;
	}), n;
}
function $r(e) {
	return Nr(e.map((e) => ArrayBuffer.isView(e) ? new Uint8Array(e.buffer, e.byteOffset, e.byteLength) : new Uint8Array(e))).buffer;
}
const Fr = (...e) => console.warn(...e);
function Vr(e) {
	return Object.fromEntries(Object.entries(e).map(([e, t]) => [t, e]));
}
function qr(e) {
	return new Uint8Array([e >> 8 & 255, 255 & e]);
}
function Gr(e) {
	return new Uint8Array([
		e >> 16 & 255,
		e >> 8 & 255,
		255 & e
	]);
}
function jr(e) {
	const t = /* @__PURE__ */ new ArrayBuffer(8);
	return new DataView(t).setBigUint64(0, BigInt(e), !1), new Uint8Array(t);
}
var Yr = class {
	view;
	offset = 0;
	buffer;
	constructor(e) {
		this.buffer = e, this.view = new DataView(e);
	}
	readUint8() {
		const e = this.view.getUint8(this.offset);
		return this.offset += 1, e;
	}
	readUint16() {
		const e = this.view.getUint16(this.offset);
		return this.offset += 2, e;
	}
	readUint32() {
		const e = this.view.getUint32(this.offset);
		return this.offset += 4, e;
	}
	readUint8Array(e) {
		const t = this.buffer.slice(this.offset, this.offset + e);
		return this.offset += e, new Uint8Array(t);
	}
	isFinished() {
		return this.offset >= this.buffer.byteLength;
	}
}, Xr = class {
	buffer;
	view;
	uint8Array;
	offset = 0;
	constructor(e) {
		this.buffer = new ArrayBuffer(e), this.uint8Array = new Uint8Array(this.buffer), this.view = new DataView(this.buffer);
	}
	writeUint8(e) {
		this.view.setUint8(this.offset, e), this.offset += 1;
	}
	writeUint16(e) {
		this.view.setUint16(this.offset, e), this.offset += 2;
	}
	writeUint32(e) {
		this.view.setUint32(this.offset, e), this.offset += 4;
	}
	writeUint8Array(e) {
		this.uint8Array.set(e, this.offset), this.offset += e.length;
	}
};
const Jr = {
	server_name: 0,
	max_fragment_length: 1,
	client_certificate_url: 2,
	trusted_ca_keys: 3,
	truncated_hmac: 4,
	status_request: 5,
	user_mapping: 6,
	client_authz: 7,
	server_authz: 8,
	cert_type: 9,
	supported_groups: 10,
	ec_point_formats: 11,
	srp: 12,
	signature_algorithms: 13,
	use_srtp: 14,
	heartbeat: 15,
	application_layer_protocol_negotiation: 16,
	status_request_v2: 17,
	signed_certificate_timestamp: 18,
	client_certificate_type: 19,
	server_certificate_type: 20,
	padding: 21,
	encrypt_then_mac: 22,
	extended_master_secret: 23,
	token_binding: 24,
	cached_info: 25,
	tls_its: 26,
	compress_certificate: 27,
	record_size_limit: 28,
	pwd_protect: 29,
	pwo_clear: 30,
	password_salt: 31,
	ticket_pinning: 32,
	tls_cert_with_extern_psk: 33,
	delegated_credential: 34,
	session_ticket: 35,
	TLMSP: 36,
	TLMSP_proxying: 37,
	TLMSP_delegate: 38,
	supported_ekt_ciphers: 39,
	pre_shared_key: 41,
	early_data: 42,
	supported_versions: 43,
	cookie: 44,
	psk_key_exchange_modes: 45,
	reserved: 46,
	certificate_authorities: 47,
	oid_filters: 48,
	post_handshake_auth: 49,
	signature_algorithms_cert: 50,
	key_share: 51,
	transparency_info: 52,
	connection_id: 54,
	renegotiation_info: 65281
}, Zr = Vr(Jr), Qr = { host_name: 0 }, ei = Vr(Qr);
var ti = class {
	static decodeFromClient(e) {
		const t = new DataView(e.buffer);
		let n = 0;
		const r = t.getUint16(n);
		n += 2;
		const i = [];
		for (; n < r + 2;) {
			const r = e[n];
			n += 1;
			const s = t.getUint16(n);
			n += 2;
			const o = e.slice(n, n + s);
			if (n += s, r !== Qr.host_name) throw new Error(`Unsupported name type ${r}`);
			i.push({
				name_type: ei[r],
				name: { host_name: new TextDecoder().decode(o) }
			});
		}
		return { server_name_list: i };
	}
	static encodeForClient(e) {
		if (e?.server_name_list.length) throw new Error("Encoding non-empty lists for ClientHello is not supported yet. Only empty lists meant for ServerHello are supported today.");
		const t = new Xr(4);
		return t.writeUint16(Jr.server_name), t.writeUint16(0), t.uint8Array;
	}
};
const ni = {
	uncompressed: 0,
	ansiX962_compressed_prime: 1,
	ansiX962_compressed_char2: 2
}, ri = Vr(ni);
var ii = class {
	static decodeFromClient(e) {
		const t = new Yr(e.buffer), n = t.readUint8(), r = [];
		for (let i = 0; i < n; i++) {
			const e = t.readUint8();
			e in ri && r.push(ri[e]);
		}
		return r;
	}
	static encodeForClient(e) {
		const t = new Xr(6);
		return t.writeUint16(Jr.ec_point_formats), t.writeUint16(2), t.writeUint8(1), t.writeUint8(ni[e]), t.uint8Array;
	}
};
const si = {
	decodeFromClient: (e) => ({}),
	encodeForClient() {
		const e = Jr.extended_master_secret;
		return new Uint8Array([
			e >> 8 & 255,
			255 & e,
			0,
			0
		]);
	}
}, oi = {
	decodeFromClient(e) {
		const t = e[0] ?? 0;
		return { renegotiatedConnection: e.slice(1, 1 + t) };
	},
	encodeForClient() {
		const e = Jr.renegotiation_info, t = new Uint8Array([0]);
		return new Uint8Array([
			e >> 8 & 255,
			255 & e,
			0,
			t.length,
			...t
		]);
	}
}, ai = {
	TLS1_CK_PSK_WITH_RC4_128_SHA: 138,
	TLS1_CK_PSK_WITH_3DES_EDE_CBC_SHA: 139,
	TLS1_CK_PSK_WITH_AES_128_CBC_SHA: 140,
	TLS1_CK_PSK_WITH_AES_256_CBC_SHA: 141,
	TLS1_CK_DHE_PSK_WITH_RC4_128_SHA: 142,
	TLS1_CK_DHE_PSK_WITH_3DES_EDE_CBC_SHA: 143,
	TLS1_CK_DHE_PSK_WITH_AES_128_CBC_SHA: 144,
	TLS1_CK_DHE_PSK_WITH_AES_256_CBC_SHA: 145,
	TLS1_CK_RSA_PSK_WITH_RC4_128_SHA: 146,
	TLS1_CK_RSA_PSK_WITH_3DES_EDE_CBC_SHA: 147,
	TLS1_CK_RSA_PSK_WITH_AES_128_CBC_SHA: 148,
	TLS1_CK_RSA_PSK_WITH_AES_256_CBC_SHA: 149,
	TLS1_CK_PSK_WITH_AES_128_GCM_SHA256: 168,
	TLS1_CK_PSK_WITH_AES_256_GCM_SHA384: 169,
	TLS1_CK_DHE_PSK_WITH_AES_128_GCM_SHA256: 170,
	TLS1_CK_DHE_PSK_WITH_AES_256_GCM_SHA384: 171,
	TLS1_CK_RSA_PSK_WITH_AES_128_GCM_SHA256: 172,
	TLS1_CK_RSA_PSK_WITH_AES_256_GCM_SHA384: 173,
	TLS1_CK_PSK_WITH_AES_128_CBC_SHA256: 174,
	TLS1_CK_PSK_WITH_AES_256_CBC_SHA384: 175,
	TLS1_CK_PSK_WITH_NULL_SHA256: 176,
	TLS1_CK_PSK_WITH_NULL_SHA384: 177,
	TLS1_CK_DHE_PSK_WITH_AES_128_CBC_SHA256: 178,
	TLS1_CK_DHE_PSK_WITH_AES_256_CBC_SHA384: 179,
	TLS1_CK_DHE_PSK_WITH_NULL_SHA256: 180,
	TLS1_CK_DHE_PSK_WITH_NULL_SHA384: 181,
	TLS1_CK_RSA_PSK_WITH_AES_128_CBC_SHA256: 182,
	TLS1_CK_RSA_PSK_WITH_AES_256_CBC_SHA384: 183,
	TLS1_CK_RSA_PSK_WITH_NULL_SHA256: 184,
	TLS1_CK_RSA_PSK_WITH_NULL_SHA384: 185,
	TLS1_CK_PSK_WITH_NULL_SHA: 44,
	TLS1_CK_DHE_PSK_WITH_NULL_SHA: 45,
	TLS1_CK_RSA_PSK_WITH_NULL_SHA: 46,
	TLS1_CK_RSA_WITH_AES_128_SHA: 47,
	TLS1_CK_DH_DSS_WITH_AES_128_SHA: 48,
	TLS1_CK_DH_RSA_WITH_AES_128_SHA: 49,
	TLS1_CK_DHE_DSS_WITH_AES_128_SHA: 50,
	TLS1_CK_DHE_RSA_WITH_AES_128_SHA: 51,
	TLS1_CK_ADH_WITH_AES_128_SHA: 52,
	TLS1_CK_RSA_WITH_AES_256_SHA: 53,
	TLS1_CK_DH_DSS_WITH_AES_256_SHA: 54,
	TLS1_CK_DH_RSA_WITH_AES_256_SHA: 55,
	TLS1_CK_DHE_DSS_WITH_AES_256_SHA: 56,
	TLS1_CK_DHE_RSA_WITH_AES_256_SHA: 57,
	TLS1_CK_ADH_WITH_AES_256_SHA: 58,
	TLS1_CK_RSA_WITH_NULL_SHA256: 59,
	TLS1_CK_RSA_WITH_AES_128_SHA256: 60,
	TLS1_CK_RSA_WITH_AES_256_SHA256: 61,
	TLS1_CK_DH_DSS_WITH_AES_128_SHA256: 62,
	TLS1_CK_DH_RSA_WITH_AES_128_SHA256: 63,
	TLS1_CK_DHE_DSS_WITH_AES_128_SHA256: 64,
	TLS1_CK_RSA_WITH_CAMELLIA_128_CBC_SHA: 65,
	TLS1_CK_DH_DSS_WITH_CAMELLIA_128_CBC_SHA: 66,
	TLS1_CK_DH_RSA_WITH_CAMELLIA_128_CBC_SHA: 67,
	TLS1_CK_DHE_DSS_WITH_CAMELLIA_128_CBC_SHA: 68,
	TLS1_CK_DHE_RSA_WITH_CAMELLIA_128_CBC_SHA: 69,
	TLS1_CK_ADH_WITH_CAMELLIA_128_CBC_SHA: 70,
	TLS1_CK_DHE_RSA_WITH_AES_128_SHA256: 103,
	TLS1_CK_DH_DSS_WITH_AES_256_SHA256: 104,
	TLS1_CK_DH_RSA_WITH_AES_256_SHA256: 105,
	TLS1_CK_DHE_DSS_WITH_AES_256_SHA256: 106,
	TLS1_CK_DHE_RSA_WITH_AES_256_SHA256: 107,
	TLS1_CK_ADH_WITH_AES_128_SHA256: 108,
	TLS1_CK_ADH_WITH_AES_256_SHA256: 109,
	TLS1_CK_RSA_WITH_CAMELLIA_256_CBC_SHA: 132,
	TLS1_CK_DH_DSS_WITH_CAMELLIA_256_CBC_SHA: 133,
	TLS1_CK_DH_RSA_WITH_CAMELLIA_256_CBC_SHA: 134,
	TLS1_CK_DHE_DSS_WITH_CAMELLIA_256_CBC_SHA: 135,
	TLS1_CK_DHE_RSA_WITH_CAMELLIA_256_CBC_SHA: 136,
	TLS1_CK_ADH_WITH_CAMELLIA_256_CBC_SHA: 137,
	TLS1_CK_RSA_WITH_SEED_SHA: 150,
	TLS1_CK_DH_DSS_WITH_SEED_SHA: 151,
	TLS1_CK_DH_RSA_WITH_SEED_SHA: 152,
	TLS1_CK_DHE_DSS_WITH_SEED_SHA: 153,
	TLS1_CK_DHE_RSA_WITH_SEED_SHA: 154,
	TLS1_CK_ADH_WITH_SEED_SHA: 155,
	TLS1_CK_RSA_WITH_AES_128_GCM_SHA256: 156,
	TLS1_CK_RSA_WITH_AES_256_GCM_SHA384: 157,
	TLS1_CK_DHE_RSA_WITH_AES_128_GCM_SHA256: 158,
	TLS1_CK_DHE_RSA_WITH_AES_256_GCM_SHA384: 159,
	TLS1_CK_DH_RSA_WITH_AES_128_GCM_SHA256: 160,
	TLS1_CK_DH_RSA_WITH_AES_256_GCM_SHA384: 161,
	TLS1_CK_DHE_DSS_WITH_AES_128_GCM_SHA256: 162,
	TLS1_CK_DHE_DSS_WITH_AES_256_GCM_SHA384: 163,
	TLS1_CK_DH_DSS_WITH_AES_128_GCM_SHA256: 164,
	TLS1_CK_DH_DSS_WITH_AES_256_GCM_SHA384: 165,
	TLS1_CK_ADH_WITH_AES_128_GCM_SHA256: 166,
	TLS1_CK_ADH_WITH_AES_256_GCM_SHA384: 167,
	TLS1_CK_RSA_WITH_AES_128_CCM: 49308,
	TLS1_CK_RSA_WITH_AES_256_CCM: 49309,
	TLS1_CK_DHE_RSA_WITH_AES_128_CCM: 49310,
	TLS1_CK_DHE_RSA_WITH_AES_256_CCM: 49311,
	TLS1_CK_RSA_WITH_AES_128_CCM_8: 49312,
	TLS1_CK_RSA_WITH_AES_256_CCM_8: 49313,
	TLS1_CK_DHE_RSA_WITH_AES_128_CCM_8: 49314,
	TLS1_CK_DHE_RSA_WITH_AES_256_CCM_8: 49315,
	TLS1_CK_PSK_WITH_AES_128_CCM: 49316,
	TLS1_CK_PSK_WITH_AES_256_CCM: 49317,
	TLS1_CK_DHE_PSK_WITH_AES_128_CCM: 49318,
	TLS1_CK_DHE_PSK_WITH_AES_256_CCM: 49319,
	TLS1_CK_PSK_WITH_AES_128_CCM_8: 49320,
	TLS1_CK_PSK_WITH_AES_256_CCM_8: 49321,
	TLS1_CK_DHE_PSK_WITH_AES_128_CCM_8: 49322,
	TLS1_CK_DHE_PSK_WITH_AES_256_CCM_8: 49323,
	TLS1_CK_ECDHE_ECDSA_WITH_AES_128_CCM: 49324,
	TLS1_CK_ECDHE_ECDSA_WITH_AES_256_CCM: 49325,
	TLS1_CK_ECDHE_ECDSA_WITH_AES_128_CCM_8: 49326,
	TLS1_CK_ECDHE_ECDSA_WITH_AES_256_CCM_8: 49327,
	TLS1_CK_RSA_WITH_CAMELLIA_128_CBC_SHA256: 186,
	TLS1_CK_DH_DSS_WITH_CAMELLIA_128_CBC_SHA256: 187,
	TLS1_CK_DH_RSA_WITH_CAMELLIA_128_CBC_SHA256: 188,
	TLS1_CK_DHE_DSS_WITH_CAMELLIA_128_CBC_SHA256: 189,
	TLS1_CK_DHE_RSA_WITH_CAMELLIA_128_CBC_SHA256: 190,
	TLS1_CK_ADH_WITH_CAMELLIA_128_CBC_SHA256: 191,
	TLS1_CK_RSA_WITH_CAMELLIA_256_CBC_SHA256: 192,
	TLS1_CK_DH_DSS_WITH_CAMELLIA_256_CBC_SHA256: 193,
	TLS1_CK_DH_RSA_WITH_CAMELLIA_256_CBC_SHA256: 194,
	TLS1_CK_DHE_DSS_WITH_CAMELLIA_256_CBC_SHA256: 195,
	TLS1_CK_DHE_RSA_WITH_CAMELLIA_256_CBC_SHA256: 196,
	TLS1_CK_ADH_WITH_CAMELLIA_256_CBC_SHA256: 197,
	TLS1_CK_ECDH_ECDSA_WITH_NULL_SHA: 49153,
	TLS1_CK_ECDH_ECDSA_WITH_RC4_128_SHA: 49154,
	TLS1_CK_ECDH_ECDSA_WITH_DES_192_CBC3_SHA: 49155,
	TLS1_CK_ECDH_ECDSA_WITH_AES_128_CBC_SHA: 49156,
	TLS1_CK_ECDH_ECDSA_WITH_AES_256_CBC_SHA: 49157,
	TLS1_CK_ECDHE_ECDSA_WITH_NULL_SHA: 49158,
	TLS1_CK_ECDHE_ECDSA_WITH_RC4_128_SHA: 49159,
	TLS1_CK_ECDHE_ECDSA_WITH_DES_192_CBC3_SHA: 49160,
	TLS1_CK_ECDHE_ECDSA_WITH_AES_128_CBC_SHA: 49161,
	TLS1_CK_ECDHE_ECDSA_WITH_AES_256_CBC_SHA: 49162,
	TLS1_CK_ECDH_RSA_WITH_NULL_SHA: 49163,
	TLS1_CK_ECDH_RSA_WITH_RC4_128_SHA: 49164,
	TLS1_CK_ECDH_RSA_WITH_DES_192_CBC3_SHA: 49165,
	TLS1_CK_ECDH_RSA_WITH_AES_128_CBC_SHA: 49166,
	TLS1_CK_ECDH_RSA_WITH_AES_256_CBC_SHA: 49167,
	TLS1_CK_ECDHE_RSA_WITH_NULL_SHA: 49168,
	TLS1_CK_ECDHE_RSA_WITH_RC4_128_SHA: 49169,
	TLS1_CK_ECDHE_RSA_WITH_DES_192_CBC3_SHA: 49170,
	TLS1_CK_ECDHE_RSA_WITH_AES_128_CBC_SHA: 49171,
	TLS1_CK_ECDHE_RSA_WITH_AES_256_CBC_SHA: 49172,
	TLS1_CK_ECDH_anon_WITH_NULL_SHA: 49173,
	TLS1_CK_ECDH_anon_WITH_RC4_128_SHA: 49174,
	TLS1_CK_ECDH_anon_WITH_DES_192_CBC3_SHA: 49175,
	TLS1_CK_ECDH_anon_WITH_AES_128_CBC_SHA: 49176,
	TLS1_CK_ECDH_anon_WITH_AES_256_CBC_SHA: 49177,
	TLS1_CK_SRP_SHA_WITH_3DES_EDE_CBC_SHA: 49178,
	TLS1_CK_SRP_SHA_RSA_WITH_3DES_EDE_CBC_SHA: 49179,
	TLS1_CK_SRP_SHA_DSS_WITH_3DES_EDE_CBC_SHA: 49180,
	TLS1_CK_SRP_SHA_WITH_AES_128_CBC_SHA: 49181,
	TLS1_CK_SRP_SHA_RSA_WITH_AES_128_CBC_SHA: 49182,
	TLS1_CK_SRP_SHA_DSS_WITH_AES_128_CBC_SHA: 49183,
	TLS1_CK_SRP_SHA_WITH_AES_256_CBC_SHA: 49184,
	TLS1_CK_SRP_SHA_RSA_WITH_AES_256_CBC_SHA: 49185,
	TLS1_CK_SRP_SHA_DSS_WITH_AES_256_CBC_SHA: 49186,
	TLS1_CK_ECDHE_ECDSA_WITH_AES_128_SHA256: 49187,
	TLS1_CK_ECDHE_ECDSA_WITH_AES_256_SHA384: 49188,
	TLS1_CK_ECDH_ECDSA_WITH_AES_128_SHA256: 49189,
	TLS1_CK_ECDH_ECDSA_WITH_AES_256_SHA384: 49190,
	TLS1_CK_ECDHE_RSA_WITH_AES_128_SHA256: 49191,
	TLS1_CK_ECDHE_RSA_WITH_AES_256_SHA384: 49192,
	TLS1_CK_ECDH_RSA_WITH_AES_128_SHA256: 49193,
	TLS1_CK_ECDH_RSA_WITH_AES_256_SHA384: 49194,
	TLS1_CK_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256: 49195,
	TLS1_CK_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384: 49196,
	TLS1_CK_ECDH_ECDSA_WITH_AES_128_GCM_SHA256: 49197,
	TLS1_CK_ECDH_ECDSA_WITH_AES_256_GCM_SHA384: 49198,
	TLS1_CK_ECDHE_RSA_WITH_AES_128_GCM_SHA256: 49199,
	TLS1_CK_ECDHE_RSA_WITH_AES_256_GCM_SHA384: 49200,
	TLS1_CK_ECDH_RSA_WITH_AES_128_GCM_SHA256: 49201,
	TLS1_CK_ECDH_RSA_WITH_AES_256_GCM_SHA384: 49202,
	TLS1_CK_ECDHE_PSK_WITH_RC4_128_SHA: 49203,
	TLS1_CK_ECDHE_PSK_WITH_3DES_EDE_CBC_SHA: 49204,
	TLS1_CK_ECDHE_PSK_WITH_AES_128_CBC_SHA: 49205,
	TLS1_CK_ECDHE_PSK_WITH_AES_256_CBC_SHA: 49206,
	TLS1_CK_ECDHE_PSK_WITH_AES_128_CBC_SHA256: 49207,
	TLS1_CK_ECDHE_PSK_WITH_AES_256_CBC_SHA384: 49208,
	TLS1_CK_ECDHE_PSK_WITH_NULL_SHA: 49209,
	TLS1_CK_ECDHE_PSK_WITH_NULL_SHA256: 49210,
	TLS1_CK_ECDHE_PSK_WITH_NULL_SHA384: 49211,
	TLS1_CK_ECDHE_ECDSA_WITH_CAMELLIA_128_CBC_SHA256: 49266,
	TLS1_CK_ECDHE_ECDSA_WITH_CAMELLIA_256_CBC_SHA384: 49267,
	TLS1_CK_ECDH_ECDSA_WITH_CAMELLIA_128_CBC_SHA256: 49268,
	TLS1_CK_ECDH_ECDSA_WITH_CAMELLIA_256_CBC_SHA384: 49269,
	TLS1_CK_ECDHE_RSA_WITH_CAMELLIA_128_CBC_SHA256: 49270,
	TLS1_CK_ECDHE_RSA_WITH_CAMELLIA_256_CBC_SHA384: 49271,
	TLS1_CK_ECDH_RSA_WITH_CAMELLIA_128_CBC_SHA256: 49272,
	TLS1_CK_ECDH_RSA_WITH_CAMELLIA_256_CBC_SHA384: 49273,
	TLS1_CK_PSK_WITH_CAMELLIA_128_CBC_SHA256: 49300,
	TLS1_CK_PSK_WITH_CAMELLIA_256_CBC_SHA384: 49301,
	TLS1_CK_DHE_PSK_WITH_CAMELLIA_128_CBC_SHA256: 49302,
	TLS1_CK_DHE_PSK_WITH_CAMELLIA_256_CBC_SHA384: 49303,
	TLS1_CK_RSA_PSK_WITH_CAMELLIA_128_CBC_SHA256: 49304,
	TLS1_CK_RSA_PSK_WITH_CAMELLIA_256_CBC_SHA384: 49305,
	TLS1_CK_ECDHE_PSK_WITH_CAMELLIA_128_CBC_SHA256: 49306,
	TLS1_CK_ECDHE_PSK_WITH_CAMELLIA_256_CBC_SHA384: 49307,
	TLS1_CK_ECDHE_RSA_WITH_CHACHA20_POLY1305: 52392,
	TLS1_CK_ECDHE_ECDSA_WITH_CHACHA20_POLY1305: 52393,
	TLS1_CK_DHE_RSA_WITH_CHACHA20_POLY1305: 52394,
	TLS1_CK_PSK_WITH_CHACHA20_POLY1305: 52395,
	TLS1_CK_ECDHE_PSK_WITH_CHACHA20_POLY1305: 52396,
	TLS1_CK_DHE_PSK_WITH_CHACHA20_POLY1305: 52397,
	TLS1_CK_RSA_PSK_WITH_CHACHA20_POLY1305: 52398
}, ci = Vr(ai), li = {
	secp256r1: 23,
	secp384r1: 24,
	secp521r1: 25,
	x25519: 29,
	x448: 30
}, hi = Vr(li);
const di = {
	anonymous: 0,
	rsa: 1,
	dsa: 2,
	ecdsa: 3
}, fi = Vr(di), ui = {
	none: 0,
	md5: 1,
	sha1: 2,
	sha224: 3,
	sha256: 4,
	sha384: 5,
	sha512: 6
}, pi = Vr(ui);
const gi = {
	server_name: ti,
	signature_algorithms: class {
		static decodeFromClient(e) {
			const t = new Yr(e.buffer);
			t.readUint16();
			const n = [];
			for (; !t.isFinished();) {
				const e = t.readUint8(), r = t.readUint8();
				fi[r] && (pi[e] ? n.push({
					algorithm: fi[r],
					hash: pi[e]
				}) : Fr(`Unknown hash algorithm: ${e}`));
			}
			return n;
		}
		static encodeforClient(e, t) {
			const n = new Xr(6);
			return n.writeUint16(Jr.signature_algorithms), n.writeUint16(2), n.writeUint8(ui[e]), n.writeUint8(di[t]), n.uint8Array;
		}
	},
	supported_groups: class {
		static decodeFromClient(e) {
			const t = new Yr(e.buffer);
			t.readUint16();
			const n = [];
			for (; !t.isFinished();) {
				const e = t.readUint16();
				e in hi && n.push(hi[e]);
			}
			return n;
		}
		static encodeForClient(e) {
			const t = new Xr(6);
			return t.writeUint16(Jr.supported_groups), t.writeUint16(2), t.writeUint16(li[e]), t.uint8Array;
		}
	},
	ec_point_formats: ii,
	renegotiation_info: oi,
	extended_master_secret: si
};
async function mi(e, t, n, r) {
	const i = $r([t, n]), s = await crypto.subtle.importKey("raw", e, {
		name: "HMAC",
		hash: { name: "SHA-256" }
	}, !1, ["sign"]);
	let o = i;
	const a = [];
	for (; $r(a).byteLength < r;) {
		o = await _i(s, o);
		const e = await _i(s, $r([o, i]));
		a.push(e);
	}
	return $r(a).slice(0, r);
}
async function _i(e, t) {
	return await crypto.subtle.sign({
		name: "HMAC",
		hash: "SHA-256"
	}, e, t);
}
const yi = 0, wi = {
	Warning: 1,
	Fatal: 2
}, Si = Vr(wi), ki = {
	CloseNotify: 0,
	UnexpectedMessage: 10,
	BadRecordMac: 20,
	DecryptionFailed: 21,
	RecordOverflow: 22,
	DecompressionFailure: 30,
	HandshakeFailure: 40,
	NoCertificate: 41,
	BadCertificate: 42,
	UnsupportedCertificate: 43,
	CertificateRevoked: 44,
	CertificateExpired: 45,
	CertificateUnknown: 46,
	IllegalParameter: 47,
	UnknownCa: 48,
	AccessDenied: 49,
	DecodeError: 50,
	DecryptError: 51,
	ExportRestriction: 60,
	ProtocolVersion: 70,
	InsufficientSecurity: 71,
	InternalError: 80,
	UserCanceled: 90,
	NoRenegotiation: 100,
	UnsupportedExtension: 110
}, bi = Vr(ki), Ai = 20, Ii = 21, Ci = 22, Ei = 23, vi = 0, xi = 1, Ti = 2, Pi = 11, Bi = 12, Hi = 14, Ui = 16, Mi = 20, Li = 3, Ri = 23;
var Wi = class extends Error {};
const Di = new Uint8Array([3, 3]), Ki = crypto.subtle.generateKey({
	name: "ECDH",
	namedCurve: "P-256"
}, !0, ["deriveKey", "deriveBits"]);
var Oi = class {
	receivedRecordSequenceNumber = 0;
	sentRecordSequenceNumber = 0;
	sessionKeys;
	closed = !1;
	receivedBytesBuffer = new Uint8Array();
	receivedTLSRecords = [];
	partialTLSMessages = {};
	handshakeMessages = [];
	MAX_CHUNK_SIZE = 16384;
	clientEnd = {
		upstream: new TransformStream(),
		downstream: new TransformStream()
	};
	clientDownstreamWriter = this.clientEnd.downstream.writable.getWriter();
	clientUpstreamReader = this.clientEnd.upstream.readable.getReader();
	serverEnd = {
		upstream: new TransformStream(),
		downstream: Ni(this.MAX_CHUNK_SIZE)
	};
	serverUpstreamWriter = this.serverEnd.upstream.writable.getWriter();
	constructor() {
		const e = this;
		this.serverEnd.downstream.readable.pipeTo(new WritableStream({
			async write(t) {
				await e.writeTLSRecord(Ei, t);
			},
			async abort(t) {
				e.clientDownstreamWriter.releaseLock(), e.clientEnd.downstream.writable.abort(t), e.close();
			},
			close() {
				e.close();
			}
		})).catch(() => {});
	}
	async close() {
		if (!this.closed) {
			this.closed = !0;
			try {
				await this.clientDownstreamWriter.close();
			} catch {}
			try {
				await this.clientUpstreamReader.cancel();
			} catch {}
			try {
				await this.serverUpstreamWriter.close();
			} catch {}
			try {
				await this.clientEnd.upstream.readable.cancel();
			} catch {}
			try {
				await this.clientEnd.downstream.writable.close();
			} catch {}
		}
	}
	async TLSHandshake(e, t) {
		const n = await this.readNextHandshakeMessage(xi);
		if (!n.body.cipher_suites.length) throw new Error("Client did not propose any supported cipher suites.");
		const r = crypto.getRandomValues(new Uint8Array(32));
		await this.writeTLSRecord(Ci, $i.serverHello(n.body, r, yi)), await this.writeTLSRecord(Ci, $i.certificate(t));
		const i = await Ki, s = n.body.random, o = await $i.ECDHEServerKeyExchange(s, r, i, e);
		await this.writeTLSRecord(Ci, o), await this.writeTLSRecord(Ci, $i.serverHelloDone());
		const a = n.body.extensions.some((e) => "extended_master_secret" === e.type), c = await this.readNextHandshakeMessage(Ui);
		await this.readNextMessage(Ai), this.sessionKeys = await this.deriveSessionKeys({
			clientRandom: s,
			serverRandom: r,
			serverPrivateKey: i.privateKey,
			clientPublicKey: await crypto.subtle.importKey("raw", c.body.exchange_keys, {
				name: "ECDH",
				namedCurve: "P-256"
			}, !1, []),
			useEMS: a
		}), await this.readNextHandshakeMessage(Mi), await this.writeTLSRecord(Ai, $i.changeCipherSpec()), await this.writeTLSRecord(Ci, await $i.createFinishedMessage(this.handshakeMessages, this.sessionKeys.masterSecret)), this.handshakeMessages = [], this.pollForClientMessages();
	}
	async deriveSessionKeys({ clientRandom: e, serverRandom: t, serverPrivateKey: n, clientPublicKey: r, useEMS: i = !1 }) {
		const s = await crypto.subtle.deriveBits({
			name: "ECDH",
			public: r
		}, n, 256);
		let o;
		if (i) {
			const e = new Uint8Array(await crypto.subtle.digest("SHA-256", Nr(this.handshakeMessages)));
			o = new Uint8Array(await mi(s, new TextEncoder().encode("extended master secret"), e, 48));
		} else o = new Uint8Array(await mi(s, new TextEncoder().encode("master secret"), Nr([e, t]), 48));
		const a = new Yr(await mi(o, new TextEncoder().encode("key expansion"), Nr([t, e]), 40)), c = a.readUint8Array(16), l = a.readUint8Array(16), h = a.readUint8Array(4), d = a.readUint8Array(4);
		return {
			masterSecret: o,
			clientWriteKey: await crypto.subtle.importKey("raw", c, { name: "AES-GCM" }, !1, ["encrypt", "decrypt"]),
			serverWriteKey: await crypto.subtle.importKey("raw", l, { name: "AES-GCM" }, !1, ["encrypt", "decrypt"]),
			clientIV: h,
			serverIV: d
		};
	}
	async readNextHandshakeMessage(e) {
		const t = await this.readNextMessage(Ci);
		if (t.msg_type !== e) throw new Error(`Expected ${e} message`);
		return t;
	}
	async readNextMessage(e) {
		let t, n = !1;
		do
			t = await this.readNextTLSRecord(e), n = await this.accumulateUntilMessageIsComplete(t);
		while (!1 === n);
		const r = zi.TLSMessage(t.type, n);
		return t.type === Ci && this.handshakeMessages.push(t.fragment), r;
	}
	async readNextTLSRecord(e) {
		for (;;) {
			for (let o = 0; o < this.receivedTLSRecords.length; o++) {
				const t = this.receivedTLSRecords[o];
				if (t.type === e) return this.receivedTLSRecords.splice(o, 1), t;
			}
			const t = await this.pollBytes(5), n = t[3] << 8 | t[4], r = t[0], i = await this.pollBytes(n), s = {
				type: r,
				version: {
					major: t[1],
					minor: t[2]
				},
				length: n,
				fragment: this.sessionKeys && r !== Ai ? await this.decryptData(r, i) : i
			};
			if (s.type === Ii) {
				const e = s.fragment[0], t = s.fragment[1], n = Si[e], r = bi[t];
				if (e === wi.Warning && t === ki.CloseNotify) throw new Wi("TLS connection closed by peer (CloseNotify)");
				throw new Error(`TLS alert received: ${n} ${r}`);
			}
			this.receivedTLSRecords.push(s);
		}
	}
	async pollBytes(e) {
		for (; this.receivedBytesBuffer.length < e;) {
			const { value: t, done: n } = await this.clientUpstreamReader.read();
			if (n) throw await this.close(), new Wi("TLS connection closed");
			if (this.receivedBytesBuffer = Nr([this.receivedBytesBuffer, t]), this.receivedBytesBuffer.length >= e) break;
			await new Promise((e) => setTimeout(e, 100));
		}
		const t = this.receivedBytesBuffer.slice(0, e);
		return this.receivedBytesBuffer = this.receivedBytesBuffer.slice(e), t;
	}
	async pollForClientMessages() {
		try {
			for (;;) {
				const e = await this.readNextMessage(Ei);
				this.serverUpstreamWriter.write(e.body);
			}
		} catch (e) {
			return;
		}
	}
	async decryptData(e, t) {
		const n = this.sessionKeys.clientIV, r = t.slice(0, 8), i = new Uint8Array([...n, ...r]), s = await crypto.subtle.decrypt({
			name: "AES-GCM",
			iv: i,
			additionalData: new Uint8Array([
				...jr(this.receivedRecordSequenceNumber),
				e,
				...Di,
				...qr(t.length - 8 - 16)
			]),
			tagLength: 128
		}, this.sessionKeys.clientWriteKey, t.slice(8));
		return ++this.receivedRecordSequenceNumber, new Uint8Array(s);
	}
	async accumulateUntilMessageIsComplete(e) {
		this.partialTLSMessages[e.type] = Nr([this.partialTLSMessages[e.type] || new Uint8Array(), e.fragment]);
		const t = this.partialTLSMessages[e.type];
		switch (e.type) {
			case Ci: {
				if (t.length < 4) return !1;
				const e = t[1] << 8 | t[2];
				if (t.length < 3 + e) return !1;
				break;
			}
			case Ii:
				if (t.length < 2) return !1;
				break;
			case Ai:
			case Ei: break;
			default: throw new Error(`TLS: Unsupported record type ${e.type}`);
		}
		return delete this.partialTLSMessages[e.type], t;
	}
	async writeTLSRecord(e, t) {
		e === Ci && this.handshakeMessages.push(t), this.sessionKeys && e !== Ai && (t = await this.encryptData(e, t));
		const n = Di, r = t.length, i = new Uint8Array(5);
		i[0] = e, i[1] = n[0], i[2] = n[1], i[3] = r >> 8 & 255, i[4] = 255 & r;
		const s = Nr([i, t]);
		this.clientDownstreamWriter.write(s);
	}
	async encryptData(e, t) {
		const n = this.sessionKeys.serverIV, r = crypto.getRandomValues(new Uint8Array(8)), i = new Uint8Array([...n, ...r]), s = new Uint8Array([
			...jr(this.sentRecordSequenceNumber),
			e,
			...Di,
			...qr(t.length)
		]), o = await crypto.subtle.encrypt({
			name: "AES-GCM",
			iv: i,
			additionalData: s,
			tagLength: 128
		}, this.sessionKeys.serverWriteKey, t);
		return ++this.sentRecordSequenceNumber, Nr([r, new Uint8Array(o)]);
	}
}, zi = class e {
	static TLSMessage(t, n) {
		switch (t) {
			case Ci: return e.clientHandshake(n);
			case Ii: return e.alert(n);
			case Ai: return e.changeCipherSpec();
			case Ei: return e.applicationData(n);
			default: throw new Error(`TLS: Unsupported TLS record type ${t}`);
		}
	}
	static parseCipherSuites(e) {
		const t = new Yr(e), n = [], r = [t.readUint16()];
		for (; !t.isFinished();) {
			const e = t.readUint16();
			r.push(e), e in ci && n.push(ci[e]);
		}
		return n;
	}
	static applicationData(e) {
		return {
			type: Ei,
			body: e
		};
	}
	static changeCipherSpec() {
		return {
			type: Ai,
			body: new Uint8Array()
		};
	}
	static alert(e) {
		return {
			type: Ii,
			level: Si[e[0]],
			description: bi[e[1]]
		};
	}
	static clientHandshake(t) {
		const n = t[0], r = t[1] << 16 | t[2] << 8 | t[3], i = t.slice(4);
		let s;
		switch (n) {
			case vi:
				s = e.clientHelloRequestPayload();
				break;
			case xi:
				s = e.clientHelloPayload(i);
				break;
			case Ui:
				s = e.clientKeyExchangePayload(i);
				break;
			case Mi:
				s = e.clientFinishedPayload(i);
				break;
			default: throw new Error(`Invalid handshake type ${n}`);
		}
		return {
			type: Ci,
			msg_type: n,
			length: r,
			body: s
		};
	}
	static clientHelloRequestPayload() {
		return {};
	}
	static clientHelloPayload(t) {
		const n = new Yr(t.buffer), r = {
			client_version: n.readUint8Array(2),
			random: n.readUint8Array(32)
		}, i = n.readUint8();
		r.session_id = n.readUint8Array(i);
		const s = n.readUint16();
		r.cipher_suites = e.parseCipherSuites(n.readUint8Array(s).buffer);
		const o = n.readUint8();
		r.compression_methods = n.readUint8Array(o);
		const a = n.readUint16();
		return r.extensions = function(e) {
			const t = new Yr(e.buffer), n = [];
			for (; !t.isFinished();) {
				const r = t.offset, i = Zr[t.readUint16()], s = t.readUint16(), o = t.readUint8Array(s);
				if (!(i in gi)) continue;
				const a = gi[i];
				n.push({
					type: i,
					data: a.decodeFromClient(o),
					raw: e.slice(r, r + 4 + s)
				});
			}
			return n;
		}(n.readUint8Array(a)), r;
	}
	static clientKeyExchangePayload(e) {
		return { exchange_keys: e.slice(1, e.length) };
	}
	static clientFinishedPayload(e) {
		return { verify_data: e };
	}
};
function Ni(e) {
	return new TransformStream({ transform(t, n) {
		for (; t.length > 0;) n.enqueue(t.slice(0, e)), t = t.slice(e);
	} });
}
var $i = class {
	static certificate(e) {
		const t = [];
		for (const i of e) t.push(Gr(i.byteLength)), t.push(new Uint8Array(ArrayBuffer.isView(i) ? i.buffer : i));
		const n = Nr(t), r = new Uint8Array([...Gr(n.byteLength), ...n]);
		return new Uint8Array([
			Pi,
			...Gr(r.length),
			...r
		]);
	}
	static async ECDHEServerKeyExchange(e, t, n, r) {
		const i = new Uint8Array(await crypto.subtle.exportKey("raw", n.publicKey)), s = new Uint8Array([
			Li,
			...qr(Ri),
			i.byteLength,
			...i
		]), o = await crypto.subtle.sign({
			name: "RSASSA-PKCS1-v1_5",
			hash: "SHA-256"
		}, r, new Uint8Array([
			...e,
			...t,
			...s
		])), a = new Uint8Array(o), c = new Uint8Array([ui.sha256, di.rsa]), l = new Uint8Array([
			...s,
			...c,
			...qr(a.length),
			...a
		]);
		return new Uint8Array([
			Bi,
			...Gr(l.length),
			...l
		]);
	}
	static serverHello(e, t, n) {
		const r = e.extensions.map((e) => {
			switch (e.type) {
				case "server_name": return ti.encodeForClient();
				case "ec_point_formats": return ii.encodeForClient("uncompressed");
				case "renegotiation_info": return oi.encodeForClient();
				case "extended_master_secret": return si.encodeForClient();
			}
		}).filter((e) => void 0 !== e);
		r.length > 0 && e.extensions.some((e) => "renegotiation_info" === e.type) || r.push(oi.encodeForClient());
		const i = Nr(r), s = new Uint8Array([
			...Di,
			...t,
			e.session_id.length,
			...e.session_id,
			...qr(ai.TLS1_CK_ECDHE_RSA_WITH_AES_128_GCM_SHA256),
			n,
			...qr(i.length),
			...i
		]);
		return new Uint8Array([
			Ti,
			...Gr(s.length),
			...s
		]);
	}
	static serverHelloDone() {
		return new Uint8Array([Hi, ...Gr(0)]);
	}
	static async createFinishedMessage(e, t) {
		const n = await crypto.subtle.digest("SHA-256", Nr(e)), r = new Uint8Array(await mi(t, new TextEncoder().encode("server finished"), n, 12));
		return new Uint8Array([
			Mi,
			...Gr(r.length),
			...r
		]);
	}
	static changeCipherSpec() {
		return new Uint8Array([1]);
	}
};
function Fi(e, t) {
	return qi.generateCertificate(e, t);
}
function Vi(e) {
	return `-----BEGIN CERTIFICATE-----\n${n = e.buffer, t = btoa(String.fromCodePoint(...new Uint8Array(n))), t.match(/.{1,64}/g)?.join("\n") || t}\n-----END CERTIFICATE-----`;
	var t, n;
}
var qi = class {
	static async generateCertificate(e, t) {
		const n = await crypto.subtle.generateKey({
			name: "RSASSA-PKCS1-v1_5",
			hash: "SHA-256",
			modulusLength: 2048,
			publicExponent: new Uint8Array([
				1,
				0,
				1
			])
		}, !0, ["sign", "verify"]), r = await this.signingRequest(e, n.publicKey);
		return {
			keyPair: n,
			certificate: await this.sign(r, t?.privateKey ?? n.privateKey),
			tbsCertificate: r,
			tbsDescription: e
		};
	}
	static async sign(e, t) {
		const n = await crypto.subtle.sign({
			name: "RSASSA-PKCS1-v1_5",
			hash: "SHA-256"
		}, t, e.buffer);
		return Xi.sequence([
			new Uint8Array(e.buffer),
			this.signatureAlgorithm("sha256WithRSAEncryption"),
			Xi.bitString(new Uint8Array(n))
		]);
	}
	static async signingRequest(e, t) {
		const n = [];
		return e.keyUsage && n.push(this.keyUsage(e.keyUsage)), e.extKeyUsage && n.push(this.extKeyUsage(e.extKeyUsage)), e.subjectAltNames && n.push(this.subjectAltName(e.subjectAltNames)), e.nsCertType && n.push(this.nsCertType(e.nsCertType)), e.basicConstraints && n.push(this.basicConstraints(e.basicConstraints)), Xi.sequence([
			this.version(e.version),
			this.serialNumber(e.serialNumber),
			this.signatureAlgorithm(e.signatureAlgorithm),
			this.distinguishedName(e.issuer ?? e.subject),
			this.validity(e.validity),
			this.distinguishedName(e.subject),
			await this.subjectPublicKeyInfo(t),
			this.extensions(n)
		]);
	}
	static version(e = 2) {
		return Xi.ASN1(160, Xi.integer(new Uint8Array([e])));
	}
	static serialNumber(e = crypto.getRandomValues(new Uint8Array(4))) {
		return Xi.integer(e);
	}
	static signatureAlgorithm(e = "sha256WithRSAEncryption") {
		return Xi.sequence([Xi.objectIdentifier(ji(e)), Xi.null()]);
	}
	static async subjectPublicKeyInfo(e) {
		return new Uint8Array(await crypto.subtle.exportKey("spki", e));
	}
	static extensions(e) {
		return Xi.ASN1(163, Xi.sequence(e));
	}
	static distinguishedName(e) {
		const t = [];
		for (const [n, r] of Object.entries(e)) {
			const e = [Xi.objectIdentifier(ji(n))];
			if ("countryName" === n) e.push(Xi.printableString(r));
			else e.push(Xi.utf8String(r));
			t.push(Xi.set([Xi.sequence(e)]));
		}
		return Xi.sequence(t);
	}
	static validity(e) {
		return Xi.sequence([Xi.ASN1(Yi.UTCTime, new TextEncoder().encode(Ji(e?.notBefore ?? /* @__PURE__ */ new Date()))), Xi.ASN1(Yi.UTCTime, new TextEncoder().encode(Ji(e?.notAfter ?? Qi(/* @__PURE__ */ new Date(), 10))))]);
	}
	static basicConstraints({ ca: e = !0, pathLenConstraint: t }) {
		const n = [Xi.boolean(e)];
		return void 0 !== t && n.push(Xi.integer(new Uint8Array([t]))), Xi.sequence([Xi.objectIdentifier(ji("basicConstraints")), Xi.octetString(Xi.sequence(n))]);
	}
	static keyUsage(e) {
		const t = new Uint8Array([0]);
		return e?.digitalSignature && (t[0] |= 128), e?.nonRepudiation && (t[0] |= 64), e?.keyEncipherment && (t[0] |= 32), e?.dataEncipherment && (t[0] |= 16), e?.keyAgreement && (t[0] |= 8), e?.keyCertSign && (t[0] |= 4), e?.cRLSign && (t[0] |= 2), e?.encipherOnly && (t[0] |= 1), Xi.sequence([
			Xi.objectIdentifier(ji("keyUsage")),
			Xi.boolean(!0),
			Xi.octetString(Xi.bitString(t))
		]);
	}
	static extKeyUsage(e = {}) {
		return Xi.sequence([
			Xi.objectIdentifier(ji("extKeyUsage")),
			Xi.boolean(!0),
			Xi.octetString(Xi.sequence(Object.entries(e).map(([e, t]) => t ? Xi.objectIdentifier(ji(e)) : Xi.null())))
		]);
	}
	static nsCertType(e) {
		const t = new Uint8Array([0]);
		return e.client && (t[0] |= 1), e.server && (t[0] |= 2), e.email && (t[0] |= 4), e.objsign && (t[0] |= 8), e.sslCA && (t[0] |= 16), e.emailCA && (t[0] |= 32), e.objCA && (t[0] |= 64), Xi.sequence([Xi.objectIdentifier(ji("nsCertType")), Xi.octetString(t)]);
	}
	static subjectAltName(e) {
		const t = e.dnsNames?.map((e) => {
			const t = new TextEncoder().encode(e);
			return Xi.contextSpecific(2, t);
		}) || [], n = e.ipAddresses?.map((e) => {
			const t = new TextEncoder().encode(e);
			return Xi.contextSpecific(7, t);
		}) || [], r = Xi.octetString(Xi.sequence([...t, ...n]));
		return Xi.sequence([
			Xi.objectIdentifier(ji("subjectAltName")),
			Xi.boolean(!0),
			r
		]);
	}
};
const Gi = {
	"1.2.840.113549.1.1.1": "rsaEncryption",
	"1.2.840.113549.1.1.4": "md5WithRSAEncryption",
	"1.2.840.113549.1.1.5": "sha1WithRSAEncryption",
	"1.2.840.113549.1.1.7": "RSAES-OAEP",
	"1.2.840.113549.1.1.8": "mgf1",
	"1.2.840.113549.1.1.9": "pSpecified",
	"1.2.840.113549.1.1.10": "RSASSA-PSS",
	"1.2.840.113549.1.1.11": "sha256WithRSAEncryption",
	"1.2.840.113549.1.1.12": "sha384WithRSAEncryption",
	"1.2.840.113549.1.1.13": "sha512WithRSAEncryption",
	"1.3.101.112": "EdDSA25519",
	"1.2.840.10040.4.3": "dsa-with-sha1",
	"1.3.14.3.2.7": "desCBC",
	"1.3.14.3.2.26": "sha1",
	"1.3.14.3.2.29": "sha1WithRSASignature",
	"2.16.840.1.101.3.4.2.1": "sha256",
	"2.16.840.1.101.3.4.2.2": "sha384",
	"2.16.840.1.101.3.4.2.3": "sha512",
	"2.16.840.1.101.3.4.2.4": "sha224",
	"2.16.840.1.101.3.4.2.5": "sha512-224",
	"2.16.840.1.101.3.4.2.6": "sha512-256",
	"1.2.840.113549.2.2": "md2",
	"1.2.840.113549.2.5": "md5",
	"1.2.840.113549.1.7.1": "data",
	"1.2.840.113549.1.7.2": "signedData",
	"1.2.840.113549.1.7.3": "envelopedData",
	"1.2.840.113549.1.7.4": "signedAndEnvelopedData",
	"1.2.840.113549.1.7.5": "digestedData",
	"1.2.840.113549.1.7.6": "encryptedData",
	"1.2.840.113549.1.9.1": "emailAddress",
	"1.2.840.113549.1.9.2": "unstructuredName",
	"1.2.840.113549.1.9.3": "contentType",
	"1.2.840.113549.1.9.4": "messageDigest",
	"1.2.840.113549.1.9.5": "signingTime",
	"1.2.840.113549.1.9.6": "counterSignature",
	"1.2.840.113549.1.9.7": "challengePassword",
	"1.2.840.113549.1.9.8": "unstructuredAddress",
	"1.2.840.113549.1.9.14": "extensionRequest",
	"1.2.840.113549.1.9.20": "friendlyName",
	"1.2.840.113549.1.9.21": "localKeyId",
	"1.2.840.113549.1.9.22.1": "x509Certificate",
	"1.2.840.113549.1.12.10.1.1": "keyBag",
	"1.2.840.113549.1.12.10.1.2": "pkcs8ShroudedKeyBag",
	"1.2.840.113549.1.12.10.1.3": "certBag",
	"1.2.840.113549.1.12.10.1.4": "crlBag",
	"1.2.840.113549.1.12.10.1.5": "secretBag",
	"1.2.840.113549.1.12.10.1.6": "safeContentsBag",
	"1.2.840.113549.1.5.13": "pkcs5PBES2",
	"1.2.840.113549.1.5.12": "pkcs5PBKDF2",
	"1.2.840.113549.1.12.1.1": "pbeWithSHAAnd128BitRC4",
	"1.2.840.113549.1.12.1.2": "pbeWithSHAAnd40BitRC4",
	"1.2.840.113549.1.12.1.3": "pbeWithSHAAnd3-KeyTripleDES-CBC",
	"1.2.840.113549.1.12.1.4": "pbeWithSHAAnd2-KeyTripleDES-CBC",
	"1.2.840.113549.1.12.1.5": "pbeWithSHAAnd128BitRC2-CBC",
	"1.2.840.113549.1.12.1.6": "pbewithSHAAnd40BitRC2-CBC",
	"1.2.840.113549.2.7": "hmacWithSHA1",
	"1.2.840.113549.2.8": "hmacWithSHA224",
	"1.2.840.113549.2.9": "hmacWithSHA256",
	"1.2.840.113549.2.10": "hmacWithSHA384",
	"1.2.840.113549.2.11": "hmacWithSHA512",
	"1.2.840.113549.3.7": "des-EDE3-CBC",
	"2.16.840.1.101.3.4.1.2": "aes128-CBC",
	"2.16.840.1.101.3.4.1.22": "aes192-CBC",
	"2.16.840.1.101.3.4.1.42": "aes256-CBC",
	"2.5.4.3": "commonName",
	"2.5.4.4": "surname",
	"2.5.4.5": "serialNumber",
	"2.5.4.6": "countryName",
	"2.5.4.7": "localityName",
	"2.5.4.8": "stateOrProvinceName",
	"2.5.4.9": "streetAddress",
	"2.5.4.10": "organizationName",
	"2.5.4.11": "organizationalUnitName",
	"2.5.4.12": "title",
	"2.5.4.13": "description",
	"2.5.4.15": "businessCategory",
	"2.5.4.17": "postalCode",
	"2.5.4.42": "givenName",
	"1.3.6.1.4.1.311.60.2.1.2": "jurisdictionOfIncorporationStateOrProvinceName",
	"1.3.6.1.4.1.311.60.2.1.3": "jurisdictionOfIncorporationCountryName",
	"2.16.840.1.113730.1.1": "nsCertType",
	"2.16.840.1.113730.1.13": "nsComment",
	"2.5.29.14": "subjectKeyIdentifier",
	"2.5.29.15": "keyUsage",
	"2.5.29.17": "subjectAltName",
	"2.5.29.18": "issuerAltName",
	"2.5.29.19": "basicConstraints",
	"2.5.29.31": "cRLDistributionPoints",
	"2.5.29.32": "certificatePolicies",
	"2.5.29.35": "authorityKeyIdentifier",
	"2.5.29.37": "extKeyUsage",
	"1.3.6.1.4.1.11129.2.4.2": "timestampList",
	"1.3.6.1.5.5.7.1.1": "authorityInfoAccess",
	"1.3.6.1.5.5.7.3.1": "serverAuth",
	"1.3.6.1.5.5.7.3.2": "clientAuth",
	"1.3.6.1.5.5.7.3.3": "codeSigning",
	"1.3.6.1.5.5.7.3.4": "emailProtection",
	"1.3.6.1.5.5.7.3.8": "timeStamping"
};
function ji(e) {
	for (const [t, n] of Object.entries(Gi)) if (n === e) return t;
	throw new Error(`OID not found for name: ${e}`);
}
const Yi = {
	EOC: 0,
	Boolean: 1,
	Integer: 2,
	BitString: 3,
	OctetString: 4,
	Null: 5,
	OID: 6,
	ObjectDescriptor: 7,
	External: 8,
	Real: 9,
	Enumeration: 10,
	PDV: 11,
	Utf8String: 12,
	RelativeOID: 13,
	Sequence: 48,
	Set: 49,
	NumericString: 18,
	PrintableString: 19,
	T61String: 20,
	VideotexString: 21,
	IA5String: 22,
	UTCTime: 23,
	GeneralizedTime: 24,
	GraphicString: 25,
	VisibleString: 26,
	GeneralString: 28,
	UniversalString: 29,
	CharacterString: 30,
	BMPString: 31,
	Constructor: 32,
	Context: 128
};
var Xi = class e {
	static length_(e) {
		if (e < 128) return new Uint8Array([e]);
		{
			let t = e;
			const n = [];
			for (; t > 0;) n.unshift(255 & t), t >>= 8;
			const r = n.length, i = new Uint8Array(1 + r);
			i[0] = 128 | r;
			for (let e = 0; e < r; e++) i[e + 1] = n[e];
			return i;
		}
	}
	static ASN1(t, n) {
		const r = e.length_(n.length), i = new Uint8Array(1 + r.length + n.length);
		return i[0] = t, i.set(r, 1), i.set(n, 1 + r.length), i;
	}
	static integer(t) {
		if (t[0] > 127) {
			const e = new Uint8Array(t.length + 1);
			e[0] = 0, e.set(t, 1), t = e;
		}
		return e.ASN1(Yi.Integer, t);
	}
	static bitString(t) {
		const n = new Uint8Array([0]), r = new Uint8Array(n.length + t.length);
		return r.set(n), r.set(t, n.length), e.ASN1(Yi.BitString, r);
	}
	static octetString(t) {
		return e.ASN1(Yi.OctetString, t);
	}
	static null() {
		return e.ASN1(Yi.Null, new Uint8Array(0));
	}
	static objectIdentifier(t) {
		const n = t.split(".").map(Number), r = [40 * n[0] + n[1]];
		for (let e = 2; e < n.length; e++) {
			let t = n[e];
			const i = [];
			do
				i.unshift(127 & t), t >>= 7;
			while (t > 0);
			for (let e = 0; e < i.length - 1; e++) i[e] |= 128;
			r.push(...i);
		}
		return e.ASN1(Yi.OID, new Uint8Array(r));
	}
	static utf8String(t) {
		const n = new TextEncoder().encode(t);
		return e.ASN1(Yi.Utf8String, n);
	}
	static printableString(t) {
		const n = new TextEncoder().encode(t);
		return e.ASN1(Yi.PrintableString, n);
	}
	static sequence(t) {
		return e.ASN1(Yi.Sequence, Nr(t));
	}
	static set(t) {
		return e.ASN1(Yi.Set, Nr(t));
	}
	static ia5String(t) {
		const n = new TextEncoder().encode(t);
		return e.ASN1(Yi.IA5String, n);
	}
	static contextSpecific(t, n, r = !1) {
		const i = (r ? 160 : 128) | t;
		return e.ASN1(i, n);
	}
	static boolean(t) {
		return e.ASN1(Yi.Boolean, new Uint8Array([t ? 255 : 0]));
	}
};
function Ji(e) {
	return `${e.getUTCFullYear().toString().substr(2)}${Zi(e.getUTCMonth() + 1)}${Zi(e.getUTCDate())}${Zi(e.getUTCHours())}${Zi(e.getUTCMinutes())}${Zi(e.getUTCSeconds())}Z`;
}
function Zi(e) {
	return e.toString().padStart(2, "0");
}
function Qi(e, t) {
	const n = new Date(e);
	return n.setUTCFullYear(n.getUTCFullYear() + t), n;
}
function es(e, t) {
	const n = new Uint8Array(e.length + t.length);
	return n.set(e), n.set(t, e.length), n;
}
function ts(e) {
	for (let t = 0; t <= e.length - 4; t++) if (13 === e[t] && 10 === e[t + 1] && 13 === e[t + 2] && 10 === e[t + 3]) return t;
	return -1;
}
function ns(e) {
	const t = e.match(/content-length:\s*(\d+)/i);
	return t ? parseInt(t[1], 10) : 0;
}
function rs(e, t) {
	const n = new TextDecoder().decode(e.subarray(0, t)).split("\r\n"), [r, i] = n[0].split(" "), s = /* @__PURE__ */ new Map();
	for (let a = 1; a < n.length; a++) {
		const e = n[a].indexOf(":");
		e > 0 && s.set(n[a].substring(0, e).trim().toLowerCase(), n[a].substring(e + 1).trim());
	}
	const o = t + 4;
	return {
		method: r,
		path: i,
		headers: s,
		body: o < e.length ? e.subarray(o) : null
	};
}
const is = new Set([
	"transfer-encoding",
	"content-encoding",
	"connection",
	"keep-alive"
]);
function ss(e, t, n, r) {
	const i = new Uint8Array(r);
	let s = `HTTP/1.1 ${e} ${t}\r\n`;
	n.forEach((e, t) => {
		is.has(t.toLowerCase()) || "content-length" === t.toLowerCase() || (s += `${t}: ${e}\r\n`);
	}), s += `Content-Length: ${i.length}\r\n`, s += "\r\n";
	const o = new TextEncoder().encode(s), a = new Uint8Array(o.length + i.length);
	return a.set(o), a.set(i, o.length), a;
}
function os(e, t) {
	return t.startsWith(e) ? t : `${e}${e.endsWith("?") ? t : encodeURIComponent(t)}`;
}
var as = class {
	connections = /* @__PURE__ */ new Map();
	hostnameMap = /* @__PURE__ */ new Map();
	corsProxyUrl;
	dnsAliases;
	caKeyPair = null;
	caCert = null;
	caCertPEM = "";
	initialized = !1;
	constructor(e) {
		this.corsProxyUrl = e?.corsProxyUrl?.trim() ?? "", this.dnsAliases = e?.dnsAliases ?? { "proxy.local": "https://registry.npmjs.org" };
	}
	async init() {
		this.initialized || (this.caCert = await Fi({
			subject: {
				commonName: "WASM POSIX MITM CA",
				organizationName: "WASM POSIX Kernel"
			},
			basicConstraints: { ca: !0 },
			keyUsage: {
				keyCertSign: !0,
				cRLSign: !0
			}
		}), this.caKeyPair = this.caCert.keyPair, this.caCertPEM = Vi(this.caCert.certificate), this.initialized = !0);
	}
	getCACertPEM() {
		return this.caCertPEM;
	}
	getaddrinfo(e) {
		const t = this.syntheticIp(e), n = this.ipKey(t);
		return this.hostnameMap.set(n, e), t;
	}
	connect(e, t, n) {
		const r = this.ipKey(t), i = this.hostnameMap.get(r) || r;
		443 === n ? this.connectTls(e, t, n, i) : this.connections.set(e, {
			kind: "http",
			hostname: i,
			ip: new Uint8Array(t),
			port: n,
			sendBuf: new Uint8Array(0),
			responseBuf: null,
			responseOffset: 0,
			fetchDone: !1,
			fetchError: null
		});
	}
	connectStatus(e) {
		return this.connections.has(e) ? 0 : 107;
	}
	send(e, t, n) {
		const r = this.connections.get(e);
		if (!r) throw new Error("ENOTCONN");
		return "tls" === r.kind ? this.tlsSend(r, t) : this.httpSend(r, t);
	}
	recv(e, t, n) {
		const r = this.connections.get(e);
		if (!r) throw new Error("ENOTCONN");
		return "tls" === r.kind ? this.tlsRecv(r, t) : this.httpRecv(r, t);
	}
	close(e) {
		const t = this.connections.get(e);
		t && ("tls" === t.kind && (t.closed = !0, t.tls.close().catch(() => {})), this.connections.delete(e));
	}
	connectTls(e, t, n, r) {
		const i = new Oi(), s = i.clientEnd.upstream.writable.getWriter(), o = i.serverEnd.downstream.writable.getWriter(), a = {
			kind: "tls",
			hostname: r,
			ip: new Uint8Array(t),
			port: n,
			tls: i,
			clientUpstreamWriter: s,
			serverDownstreamWriter: o,
			clientDownstreamBuf: new Uint8Array(0),
			plaintextBuf: new Uint8Array(0),
			handshakeDone: !1,
			httpResponsePending: !1,
			closed: !1,
			error: null
		};
		this.connections.set(e, a);
		const c = i.clientEnd.downstream.readable.getReader();
		(async () => {
			try {
				for (;;) {
					const { value: e, done: t } = await c.read();
					if (t) break;
					e && e.length > 0 && (a.clientDownstreamBuf = es(a.clientDownstreamBuf, e));
				}
			} catch {}
		})();
		const l = i.serverEnd.upstream.readable.getReader();
		(async () => {
			try {
				for (;;) {
					const { value: e, done: t } = await l.read();
					if (t) break;
					e && e.length > 0 && (a.plaintextBuf = es(a.plaintextBuf, e), this.tryProcessHttpRequest(a));
				}
			} catch {}
		})(), this.startHandshake(e, a).catch((e) => {
			a.error = e, a.closed = !0;
		});
	}
	async startHandshake(e, t) {
		if (!this.caKeyPair || !this.caCert) throw new Error("CA not initialized — call init() first");
		const n = await Fi({
			subject: { commonName: t.hostname },
			issuer: this.caCert.tbsDescription.subject,
			subjectAltNames: { dnsNames: [t.hostname] },
			keyUsage: {
				digitalSignature: !0,
				keyEncipherment: !0
			},
			extKeyUsage: { serverAuth: !0 },
			basicConstraints: { ca: !1 }
		}, this.caKeyPair);
		t.tls.TLSHandshake(n.keyPair.privateKey, [n.certificate, this.caCert.certificate]).then(() => {
			t.handshakeDone = !0;
		}).catch((e) => {
			t.closed || (t.error = e), t.closed = !0;
		});
	}
	tlsSend(e, t) {
		if (e.closed && !e.error) return t.length;
		if (e.error) throw e.error;
		return e.clientUpstreamWriter.write(new Uint8Array(t)).catch(() => {
			e.closed || (e.closed = !0);
		}), t.length;
	}
	tlsRecv(e, t) {
		if (e.error) throw e.error;
		if (e.clientDownstreamBuf.length > 0) {
			const n = Math.min(t, e.clientDownstreamBuf.length), r = e.clientDownstreamBuf.slice(0, n);
			return e.clientDownstreamBuf = e.clientDownstreamBuf.subarray(n), r;
		}
		if (e.closed) return new Uint8Array(0);
		throw new zr();
	}
	tryProcessHttpRequest(e) {
		if (e.httpResponsePending || e.closed) return;
		const t = ts(e.plaintextBuf);
		if (-1 === t) return;
		const n = ns(new TextDecoder().decode(e.plaintextBuf.subarray(0, t))), r = t + 4, i = e.plaintextBuf.length - r;
		if (n > 0 && i < n) return;
		e.httpResponsePending = !0;
		const { method: s, path: o, headers: a, body: c } = rs(e.plaintextBuf, t), l = t + 4 + Math.max(n, 0);
		e.plaintextBuf = e.plaintextBuf.subarray(l);
		const h = `https://${a.get("host") || e.hostname}${o}`, d = this.corsProxyUrl ? os(this.corsProxyUrl, h) : h, f = new Headers();
		for (const [p, g] of a) {
			const e = p.toLowerCase();
			"host" !== e && "connection" !== e && f.set(p, g);
		}
		const u = c && c.length > 0 ? new Uint8Array(c) : void 0;
		(async () => {
			try {
				const t = await fetch(d, {
					method: s,
					headers: f,
					body: "GET" !== s && "HEAD" !== s ? u : void 0
				}), n = ss(t.status, t.statusText, t.headers, await t.arrayBuffer());
				await e.serverDownstreamWriter.write(n), await e.serverDownstreamWriter.close(), e.closed = !0;
			} catch ($n) {
				const n = `Error fetching ${d}: ${$n}`, r = ss(502, "Bad Gateway", new Headers({ "Content-Type": "text/plain" }), new TextEncoder().encode(n).buffer);
				try {
					await e.serverDownstreamWriter.write(r), await e.serverDownstreamWriter.close(), e.closed = !0;
				} catch {}
			}
			e.httpResponsePending = !1;
		})();
	}
	httpSend(e, t) {
		const n = new Uint8Array(e.sendBuf.length + t.length);
		n.set(e.sendBuf), n.set(t, e.sendBuf.length), e.sendBuf = n;
		const r = ts(e.sendBuf);
		if (-1 === r) return t.length;
		const i = ns(new TextDecoder().decode(e.sendBuf.subarray(0, r))), s = r + 4, o = e.sendBuf.length - s;
		if (i > 0 && o < i) return t.length;
		const { method: a, path: c, headers: l, body: h } = rs(e.sendBuf, r), d = l.get("host"), f = 443 === e.port ? "https" : "http", u = 80 === e.port || 443 === e.port ? "" : `:${e.port}`, p = d || `${e.hostname}${u}`, g = this.dnsAliases[e.hostname], m = void 0 !== g ? `${g}${c}` : `${f}://${p}${c}`, _ = this.corsProxyUrl ? os(this.corsProxyUrl, m) : m, y = "https://registry.npmjs.org" === g, w = new Headers();
		for (const [k, b] of l) {
			const e = k.toLowerCase();
			"host" !== e && "connection" !== e && w.set(k, b);
		}
		const S = h && h.length > 0 ? new Uint8Array(h) : void 0;
		return e.fetchDone = !1, e.responseBuf = null, e.responseOffset = 0, e.fetchError = null, (async () => {
			try {
				const t = await fetch(_, {
					method: a,
					headers: w,
					body: S
				});
				let n = await t.arrayBuffer();
				if (y && (t.headers.get("content-type") || "").includes("json")) {
					const t = new TextDecoder().decode(n), r = t.replace(/"tarball"\s*:\s*"https:\/\/registry\.npmjs\.org/g, `"tarball":"http://${e.hostname}`);
					r !== t && (n = new TextEncoder().encode(r).buffer);
				}
				e.responseBuf = ss(t.status, t.statusText, t.headers, n), e.fetchDone = !0;
			} catch (t) {
				e.fetchError = t, e.fetchDone = !0;
			}
		})(), e.sendBuf = new Uint8Array(0), t.length;
	}
	httpRecv(e, t) {
		if (!e.fetchDone) throw new zr();
		if (e.fetchError) throw e.fetchError;
		if (!e.responseBuf) return new Uint8Array(0);
		const n = e.responseBuf.length - e.responseOffset, r = Math.min(t, n);
		if (0 === r) return new Uint8Array(0);
		const i = e.responseBuf.slice(e.responseOffset, e.responseOffset + r);
		return e.responseOffset += r, i;
	}
	syntheticIp(e) {
		let t = 0;
		for (let n = 0; n < e.length; n++) t = (t << 5) - t + e.charCodeAt(n) | 0;
		return new Uint8Array([
			10,
			t >> 16 & 255,
			t >> 8 & 255,
			255 & t
		]);
	}
	ipKey(e) {
		return `${e[0]}.${e[1]}.${e[2]}.${e[3]}`;
	}
};
var cs = class {
	nextPage;
	freePages = [];
	maxPageExclusive;
	direction;
	ptrWidth;
	reservedSlots;
	reserveSlotStartPage;
	activeCount = 0;
	constructor(e) {
		if ("number" == typeof e) this.nextPage = e - 2 - 4 - 2, this.maxPageExclusive = e, this.direction = "down", this.ptrWidth = 4, this.reservedSlots = Math.max(0, Math.floor(e / 4)), this.reserveSlotStartPage = void 0;
		else {
			if (void 0 !== e.firstSlotStartPage) this.nextPage = e.firstSlotStartPage;
			else {
				if (void 0 === e.firstBasePage) throw new Error("ThreadPageAllocator requires firstSlotStartPage");
				this.nextPage = e.firstBasePage - 2;
			}
			this.maxPageExclusive = e.maxPageExclusive, this.direction = "up", this.ptrWidth = e.ptrWidth ?? 4, this.reservedSlots = e.reservedSlots ?? Math.max(0, Math.floor((this.maxPageExclusive - this.nextPage) / 4)), this.reserveSlotStartPage = e.reserveSlotStartPage;
		}
	}
	allocate(e) {
		if (this.activeCount >= this.reservedSlots) throw new Error(`process pthread slot limit exhausted (limit=${this.reservedSlots}, active=${this.activeCount}). Rebuild with --kandelo-thread-slots=N or increase the host defaultThreadSlots setting.`);
		let t;
		if (this.freePages.length > 0 ? t = this.freePages.pop() : this.reserveSlotStartPage ? t = this.reserveSlotStartPage() : (t = this.nextPage, "up" === this.direction ? this.nextPage += 4 : this.nextPage -= 4), !this.reserveSlotStartPage && (t < 0 || t + 4 > this.maxPageExclusive)) throw new Error(`process pthread slot limit exhausted (limit=${this.reservedSlots}, active=${this.activeCount}). Rebuild with --kandelo-thread-slots=N or increase the host defaultThreadSlots setting.`);
		const n = (t + 0) * We, r = (t + 1) * We, i = (t + 2) * We;
		return _t(e, (t + 4) * We, this.ptrWidth), new Uint8Array(e.buffer, i, m).fill(0), new Uint8Array(e.buffer, n, We).fill(0), new Uint8Array(e.buffer, r, We).fill(0), new Uint8Array(e.buffer, r, lt).fill(0), this.activeCount++, {
			slotStartPage: t,
			basePage: t,
			tlsOffset: n,
			forkSaveOffset: r,
			channelOffset: i,
			tlsAllocAddr: n
		};
	}
	free(e) {
		this.freePages.push(e), this.activeCount = Math.max(0, this.activeCount - 1);
	}
};
if (void 0 === globalThis.setImmediate) {
	const Ys = [];
	let Xs = 0, Js = !1, Zs = !1;
	const Qs = /* @__PURE__ */ new Set(), eo = new MessageChannel();
	function to() {
		Js = !1, Zs = !0;
		const e = Ys.length;
		for (let n = 0; n < e && Ys.length > 0; n++) {
			const e = Ys.shift();
			if (Qs.has(e.id)) Qs.delete(e.id);
			else try {
				e.fn(...e.args);
			} catch (t) {
				console.error("[setImmediate] callback threw:", t);
			}
		}
		Zs = !1, Ys.length > 0 && !Js && (Js = !0, eo.port2.postMessage(null));
	}
	eo.port1.onmessage = to, globalThis.setImmediate = (e, ...t) => {
		const n = ++Xs;
		return Ys.push({
			id: n,
			fn: e,
			args: t
		}), Js || Zs || (Js = !0, eo.port2.postMessage(null)), n;
	}, globalThis.clearImmediate = (e) => {
		Qs.add(e);
	};
}
const ls = 65536, hs = lt;
let ds, fs, us, ps, gs = 16384, ms = ct, _s = [];
const ys = /* @__PURE__ */ new Map(), ws = /* @__PURE__ */ new Map(), Ss = /* @__PURE__ */ new Set(), ks = /* @__PURE__ */ new Set(), bs = 250, As = /* @__PURE__ */ new WeakSet();
async function Is(e, t, n = 0) {
	if (n > 4) return null;
	await us.ensureMaterialized(e);
	const r = js(e);
	if (!r) return null;
	const i = function(e) {
		const t = new Uint8Array(e);
		if (t.length < 2 || 35 !== t[0] || 33 !== t[1]) return null;
		let n = 2;
		for (; n < t.length && 10 !== t[n] && n < 4096;) n++;
		const r = new TextDecoder().decode(t.subarray(2, n)).replace(/\r$/, "").trim();
		if (!r) return null;
		const i = r.match(/^(\S+)(?:\s+(.*))?$/);
		return i ? {
			interpreter: i[1],
			arg: i[2]
		} : null;
	}(r);
	if (!i) return {
		programBytes: r,
		argv: t
	};
	const s = [
		i.interpreter,
		...i.arg ? [i.arg] : [],
		e,
		...t.slice(1)
	];
	return Is(i.interpreter, s, n + 1);
}
const Cs = /* @__PURE__ */ new Map(), Es = /* @__PURE__ */ new Map(), vs = new class {
	terminators = /* @__PURE__ */ new Map();
	pendingExits = /* @__PURE__ */ new Set();
	register(e, t, n) {
		const r = this.key(e, t);
		this.terminators.set(r, n), this.pendingExits.delete(r) && n();
	}
	release(e, t) {
		const n = this.key(e, t);
		this.terminators.delete(n), this.pendingExits.delete(n);
	}
	requestExit(e, t) {
		const n = this.key(e, t), r = this.terminators.get(n);
		return r ? (r(), !0) : (this.pendingExits.add(n), !0);
	}
	key(e, t) {
		return `${e}:${t}`;
	}
}();
async function xs() {
	for (; ws.size > 0 || Ss.size > 0;) await Promise.allSettled([...ws.values(), ...Ss]);
}
async function Ts(e, t = 0) {
	As.add(e);
	const n = (async () => {
		var n;
		await e.terminate().catch(() => {}), t > 0 && await (n = t, new Promise((e) => setTimeout(e, n)));
	})();
	Ss.add(n), n.finally(() => Ss.delete(n)), await n;
}
async function Ps(e) {
	const t = Es.get(e);
	if (t) {
		Es.delete(e);
		for (const n of t) await (n.termination ?? Ts(n.worker, bs)), vs.release(e, n.channelOffset);
	}
}
const Bs = /* @__PURE__ */ new Map();
let Hs = null, Us = null, Ms = null, Ls = null;
function Rs(e, t) {
	globalThis.postMessage(e, t ?? []);
}
function Ws(e, t) {
	Rs({
		type: "response",
		requestId: e,
		result: t
	});
}
function Ds(e, t) {
	Rs({
		type: "response",
		requestId: e,
		result: null,
		error: t
	});
}
function Ks(e, t, n) {
	return new cs({
		firstSlotStartPage: e.firstThreadSlotPage,
		maxPageExclusive: e.threadArenaEndPage,
		ptrWidth: t,
		reservedSlots: e.threadSlotCount,
		reserveSlotStartPage: () => ds.reserveHostRegion(n, 262144) / ls
	});
}
function Os(e, t, n, r = gs) {
	const i = qe(t), s = mt({
		maxPages: r,
		defaultThreadSlots: ms,
		ptrWidth: n,
		programBytes: t,
		heapBase: i
	}), o = function(e, t) {
		return 8 === e ? new WebAssembly.Memory({
			initial: BigInt(t.initialPages),
			maximum: BigInt(t.maximumPages),
			shared: !0,
			address: "i64"
		}) : new WebAssembly.Memory({
			initial: t.initialPages,
			maximum: t.maximumPages,
			shared: !0
		});
	}(n, s);
	return new Uint8Array(o.buffer, s.channelOffset, m).fill(0), {
		memory: o,
		layout: s,
		threadAllocator: Ks(s, n, e)
	};
}
function zs(e, t) {
	return /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("/") ? t : e.replace(/\/?$/, "/") + t;
}
async function Ns(e) {
	gs = e.config.maxMemoryPages, ms = e.config.defaultThreadSlots ?? ct, _s = e.config.env;
	const t = Tr.fromExisting(e.shmSab), n = new Rr();
	let r;
	if (e.vfsImage) {
		const i = Or(Dr, e.vfsImage), s = i.find((e) => "/" === e.mountPoint);
		if (!s) throw new Error("DEFAULT_MOUNT_SPEC missing / mount");
		us = s.backend, e.lazyUrlBase && (us.rewriteLazyFileUrls((t) => zs(e.lazyUrlBase, t)), us.rewriteLazyArchiveUrls((t) => zs(e.lazyUrlBase, t))), r = [
			{
				mountPoint: "/dev/shm",
				backend: t
			},
			{
				mountPoint: "/dev",
				backend: n
			},
			...i
		];
	} else {
		if (!e.fsSab) throw new Error("init: vfsImage or fsSab required");
		if (us = Tr.fromExisting(e.fsSab), e.rootfsImage) try {
			(function(e, t) {
				const n = Tr.fromImage(t);
				try {
					e.mkdir("/etc", 493);
				} catch {}
				let r;
				try {
					r = n.opendir("/etc");
				} catch {
					return;
				}
				try {
					for (;;) {
						const t = n.readdir(r);
						if (null === t) break;
						if ("." === t.name || ".." === t.name) continue;
						const i = `/etc/${t.name}`, s = i;
						let o = !1;
						try {
							e.stat(s), o = !0;
						} catch {}
						if (o) continue;
						const a = n.stat(i);
						if (32768 != (61440 & a.mode)) continue;
						const c = n.open(i, 0, 0), l = a.size, h = new Uint8Array(l);
						let d = 0;
						for (; d < l;) {
							const e = n.read(c, h.subarray(d), null, l - d);
							if (e <= 0) break;
							d += e;
						}
						n.close(c);
						const f = e.open(s, 577, 511 & a.mode);
						d > 0 && e.write(f, h.subarray(0, d), null, d), e.close(f);
					}
				} finally {
					n.closedir(r);
				}
			})(us, e.rootfsImage);
		} catch (l) {
			console.error("[kernel-worker] Failed to overlay /etc from rootfs.vfs:", l);
		}
		r = [
			{
				mountPoint: "/dev/shm",
				backend: t
			},
			{
				mountPoint: "/dev",
				backend: n
			},
			{
				mountPoint: "/",
				backend: us
			}
		];
	}
	ps = new Un(r, new Wr());
	const i = new as({ dnsAliases: e.config.dnsAliases });
	await i.init(), ps.network = i;
	const s = i.getCACertPEM();
	try {
		for (const n of [
			"/etc",
			"/etc/ssl",
			"/etc/ssl/certs"
		]) try {
			us.mkdir(n, 493);
		} catch {}
		const e = new TextEncoder().encode(s), t = us.open("/etc/ssl/certs/ca-certificates.crt", 577, 420);
		us.write(t, e, 0, e.length), us.close(t);
	} catch (l) {
		console.error("[kernel-worker] Failed to write CA cert to VFS:", l);
	}
	fs = new Bn(e.workerEntryUrl), ds = new Pn({
		maxWorkers: e.config.maxWorkers,
		dataBufferSize: ls,
		useSharedMemory: !0,
		defaultThreadSlots: ms,
		enableSyscallLog: e.config.enableSyscallLog,
		syscallLogPtrWidth: e.config.syscallLogPtrWidth
	}, ps, {
		onFork: (e, t, n, r) => (Rs({
			type: "proc_event",
			kind: "spawn",
			pid: t,
			ppid: e
		}), async function(e, t, n, r) {
			await xs();
			const i = ys.get(e);
			if (!i) throw new Error(`Unknown parent pid ${e}`);
			i.programModule || (i.programModule = await WebAssembly.compile(i.programBytes));
			const s = new Uint8Array(n.buffer), o = Math.ceil(s.byteLength / ls), a = i.ptrWidth, c = i.layout, l = function(e, t, n) {
				return 8 === e ? new WebAssembly.Memory({
					initial: BigInt(t),
					maximum: BigInt(n),
					shared: !0,
					address: "i64"
				}) : new WebAssembly.Memory({
					initial: t,
					maximum: n,
					shared: !0
				});
			}(a, o, c.maximumPages);
			new Uint8Array(l.buffer).set(s);
			const h = c.channelOffset;
			new Uint8Array(l.buffer, h, m).fill(0), ds.registerProcess(t, l, [h], {
				skipKernelCreate: !0,
				ptrWidth: a,
				maxAddr: c.maxAddr,
				mmapBase: c.mmapBase
			});
			const d = r ? r.forkBufAddr : h - hs, f = {
				type: "centralized_init",
				pid: t,
				ppid: e,
				programBytes: i.programBytes,
				programModule: i.programModule,
				memory: l,
				channelOffset: h,
				isForkChild: !0,
				forkBufAddr: d,
				forkChildThreadFnPtr: r?.fnPtr,
				forkChildThreadArgPtr: r?.argPtr,
				ptrWidth: a,
				kernelAbiVersion: ds.getKernelAbiVersion()
			}, u = fs.createWorker(f);
			return ys.set(t, {
				memory: l,
				programBytes: i.programBytes,
				programModule: i.programModule,
				worker: u,
				argv: i.argv,
				channelOffset: h,
				ptrWidth: a,
				layout: c,
				threadAllocator: Ks(c, a, t)
			}), Fs(u, t), [h];
		}(e, t, n, r)),
		onExec: async (e, t, n, r) => {
			const i = await async function(e, t, n, r) {
				const i = await Is(t, n);
				if (!i) return -2;
				const { programBytes: s, argv: o } = i, a = ds.kernelExecSetup(e);
				if (a < 0) return a;
				ds.prepareProcessForExec(e);
				const c = ys.get(e);
				c?.worker && (As.add(c.worker), await c.worker.terminate().catch(() => {}));
				{
					const n = globalThis;
					n.__pidMap || (n.__pidMap = /* @__PURE__ */ new Map()), n.__pidMap.set(e, t);
				}
				const l = je(s), { memory: h, layout: d, threadAllocator: f } = Os(e, s, l), u = d.channelOffset;
				ds.registerProcess(e, h, [u], {
					skipKernelCreate: !0,
					ptrWidth: l,
					brkBase: d.brkBase,
					mmapBase: d.mmapBase,
					maxAddr: d.maxAddr,
					argv: o
				});
				const p = {
					type: "centralized_init",
					pid: e,
					ppid: 0,
					programBytes: s,
					memory: h,
					channelOffset: u,
					argv: o,
					env: r,
					ptrWidth: l,
					kernelAbiVersion: ds.getKernelAbiVersion()
				}, g = fs.createWorker(p);
				return Cs.delete(e), ys.set(e, {
					memory: h,
					programBytes: s,
					worker: g,
					argv: o,
					channelOffset: u,
					ptrWidth: l,
					layout: d,
					threadAllocator: f
				}), Fs(g, e), 0;
			}(e, t, n, r);
			return 0 === i && Rs({
				type: "proc_event",
				kind: "exec",
				pid: e
			}), i;
		},
		onResolveSpawn: Vs,
		onSpawn: qs,
		onClone: (e, t, n, r, i, s, o, a) => async function(e, t, n, r, i, s, o, a) {
			const c = ys.get(e);
			if (!c) throw new Error(`Unknown pid ${e} for clone`);
			ks.add(e);
			let h, d = Cs.get(e);
			if (!d) {
				const t = function(e) {
					const t = new Uint8Array(e);
					if (t.length < 8) return e;
					function n(e, t) {
						let n = 0, r = 0, i = t;
						for (;;) {
							const t = e[i++];
							if (n |= (127 & t) << r, !(128 & t)) break;
							r += 7;
						}
						return [n, i - t];
					}
					function r(e) {
						const t = [];
						do {
							let n = 127 & e;
							0 != (e >>>= 7) && (n |= 128), t.push(n);
						} while (0 !== e);
						return t;
					}
					const i = [];
					let s = 0, o = !1, a = 8;
					for (; a < t.length;) {
						const e = t[a], [r, s] = n(t, a + 1), c = a + 1 + s, l = 1 + s + r;
						i.push({
							id: e,
							offset: a,
							totalSize: l,
							contentOffset: c,
							contentSize: r
						}), 8 === e && (o = !0), a += l;
					}
					if (!o) return e;
					for (const S of i) if (2 === S.id) {
						let e = S.contentOffset;
						const [r, i] = n(t, e);
						e += i;
						for (let o = 0; o < r; o++) {
							const [r, i] = n(t, e);
							e += i + r;
							const [o, a] = n(t, e);
							e += a + o;
							const c = t[e++];
							if (0 === c) {
								s++;
								const [, r] = n(t, e);
								e += r;
							} else if (1 === c) {
								e++;
								const r = t[e++], [, i] = n(t, e);
								if (e += i, 1 & r) {
									const [, r] = n(t, e);
									e += r;
								}
							} else if (2 === c) {
								const r = t[e++], [, i] = n(t, e);
								if (e += i, 1 & r) {
									const [, r] = n(t, e);
									e += r;
								}
							} else 3 === c && (e++, e++);
						}
						break;
					}
					let c = -1, l = [];
					const h = /* @__PURE__ */ new Map();
					for (const S of i) if (7 === S.id) {
						let e = S.contentOffset;
						const [r, i] = n(t, e);
						e += i;
						for (let s = 0; s < r; s++) {
							const [r, i] = n(t, e);
							e += i;
							const s = new TextDecoder().decode(t.subarray(e, e + r));
							e += r;
							const o = t[e++], [a, c] = n(t, e);
							e += c, 0 === o && (l.push(a), h.set(s, a));
						}
						break;
					}
					function d(e) {
						const [, r] = n(t, e);
						return e + r;
					}
					function f(e) {
						return e = d(e), d(e);
					}
					function u(e, r) {
						const i = r - s;
						if (i < 0) return null;
						let o = e.contentOffset;
						const [a, c] = n(t, o);
						if (o += c, i >= a) return null;
						for (let s = 0; s < i; s++) {
							const [e, r] = n(t, o);
							o += r + e;
						}
						const [l, h] = n(t, o);
						o += h;
						const f = o + l, [u, p] = n(t, o);
						o += p;
						for (let t = 0; t < u; t++) o = d(o), o++;
						return {
							start: o,
							end: f
						};
					}
					function p(e, r) {
						const i = u(e, r);
						if (!i) return [];
						const s = [];
						let o = i.start;
						for (; o < i.end;) {
							const e = t[o++];
							if (16 === e) {
								const [e, r] = n(t, o);
								o += r, s.push(e);
							} else if (17 === e || 19 === e) o = d(o), o = d(o);
							else if (18 === e || 20 === e || 21 === e) o = d(o);
							else if (2 === e || 3 === e || 4 === e) o = 64 === t[o] || t[o] >= 112 ? o + 1 : d(o);
							else if (12 === e || 13 === e || e >= 32 && e <= 38 || 208 === e || 210 === e) o = d(o);
							else if (14 === e) {
								const [e, r] = n(t, o);
								o += r;
								for (let t = 0; t <= e; t++) o = d(o);
							} else if (e >= 40 && e <= 62) o = f(o);
							else if (63 === e || 64 === e) o++;
							else if (65 === e || 66 === e) o = d(o);
							else if (67 === e) o += 4;
							else if (68 === e) o += 8;
							else if (252 === e) {
								const [e, r] = n(t, o);
								o += r, 8 === e || 10 === e || 12 === e || 14 === e ? o = d(d(o)) : e >= 9 && e <= 17 && (o = d(o));
							} else if (254 === e) o = d(o), o = f(o);
							else if (253 === e) break;
						}
						return s;
					}
					for (const S of i) if (10 === S.id && l.length > 0) {
						const e = [
							"__wasm_init_tls",
							"__abi_version",
							"__get_channel_base_addr",
							"_start",
							"__wasm_thread_init"
						], r = /* @__PURE__ */ new Map();
						let i = 0;
						for (const t of e) {
							const e = h.get(t);
							if (void 0 === e) continue;
							const n = new Set(p(S, e).filter((e) => e >= s));
							for (const t of n) {
								const e = r.get(t);
								e ? e.count++ : r.set(t, {
									count: 1,
									firstOrder: i++
								});
							}
						}
						let o = null;
						for (const [t, n] of r) n.count >= 2 && (!o || n.count > o.count || n.count === o.count && n.firstOrder < o.firstOrder) && (o = {
							target: t,
							count: n.count,
							firstOrder: n.firstOrder
						});
						if (o) c = o.target;
						else for (const a of l) {
							const e = u(S, a);
							if (!e || 16 !== t[e.start]) continue;
							const [r] = n(t, e.start + 1);
							if (r >= s) {
								c = r;
								break;
							}
						}
						break;
					}
					const g = c >= 0 ? c - s : -1, m = [];
					m.push(t.subarray(0, 8));
					for (const S of i) if (8 !== S.id) if (10 === S.id && g >= 0) {
						let e = S.contentOffset;
						const [i, s] = n(t, e);
						e += s;
						let o = e;
						for (let r = 0; r < g; r++) {
							const [e, r] = n(t, o);
							o += r + e;
						}
						const [a, c] = n(t, o), l = o + c + a, h = new Uint8Array([
							2,
							0,
							11
						]), d = o - S.contentOffset, f = S.contentOffset + S.contentSize - l, u = r(d + h.length + f);
						m.push(new Uint8Array([10])), m.push(new Uint8Array(u)), m.push(t.subarray(S.contentOffset, o)), m.push(h), m.push(t.subarray(l, S.contentOffset + S.contentSize));
					} else m.push(t.subarray(S.offset, S.offset + S.totalSize));
					const _ = m.reduce((e, t) => e + t.length, 0), y = new Uint8Array(_);
					let w = 0;
					for (const S of m) y.set(S, w), w += S.length;
					return y.buffer;
				}(c.programBytes);
				d = await WebAssembly.compile(t), Cs.set(e, d);
			}
			try {
				h = c.threadAllocator.allocate(a);
			} catch (l) {
				const n = l instanceof Error ? l.message : String(l);
				throw Rs({
					type: "stderr",
					pid: e,
					data: new TextEncoder().encode(`[kernel-worker] pid=${e}: ${n}\n`)
				}), l;
			}
			ds.addChannel(e, h.channelOffset, t, n, r);
			const f = {
				type: "centralized_thread_init",
				pid: e,
				tid: t,
				programBytes: c.programBytes,
				programModule: d,
				memory: a,
				channelOffset: h.channelOffset,
				fnPtr: n,
				argPtr: r,
				stackPtr: i,
				tlsPtr: s,
				ctidPtr: o,
				tlsOffset: h.tlsOffset,
				tlsAllocAddr: h.tlsAllocAddr,
				ptrWidth: c.ptrWidth,
				kernelAbiVersion: ds.getKernelAbiVersion()
			}, u = fs.createWorker(f);
			Es.has(e) || Es.set(e, []);
			const p = {
				worker: u,
				channelOffset: h.channelOffset,
				tid: t,
				basePage: h.slotStartPage
			};
			Es.get(e).push(p);
			let g = !1;
			const m = () => {
				if (g) return;
				g = !0, c.threadAllocator.free(h.basePage), vs.release(e, h.channelOffset);
				const t = Es.get(e);
				if (t) {
					const e = t.indexOf(p);
					e >= 0 && t.splice(e, 1);
				}
			}, _ = () => (p.termination || (p.termination = Ts(u, bs).finally(m)), p.termination);
			vs.register(e, h.channelOffset, _);
			const y = (n) => {
				const r = `[kernel-worker] pid=${e} tid=${t}: ${n}\n`;
				Rs({
					type: "stderr",
					pid: e,
					data: new TextEncoder().encode(r)
				}), ds.notifyThreadExit(e, t), ds.removeChannel(e, h.channelOffset), _();
			};
			return u.on("message", (e) => {
				const t = e;
				"thread_exit" === t.type ? _() : "error" === t.type && y(t.message ?? "thread error");
			}), u.on("error", (n) => {
				console.error(`[kernel-worker] thread worker error pid=${e} tid=${t}:`, n.message), y(`worker error: ${n.message ?? n}`);
			}), t;
		}(e, t, n, r, i, s, o, a),
		onThreadExit: (e, t, n) => function(e, t) {
			return vs.requestExit(e, t);
		}(e, n),
		onExit: (e, t) => Gs(e, t)
	}), ds.usePolling = !1, ds.relistenBatchSize = 8;
	const o = ds, a = o.kernel.callbacks || {};
	o.kernel.callbacks = {
		...a,
		onStdout: (e) => Rs({
			type: "stdout",
			pid: o.currentHandlePid || 0,
			data: e
		}),
		onStderr: (e) => Rs({
			type: "stderr",
			pid: o.currentHandlePid || 0,
			data: e
		}),
		onNetListen: (e, t, n) => {
			const r = o.currentHandlePid;
			return 0 !== r && o.startTcpListener(r, e, t, n), Rs({
				type: "listen_tcp",
				pid: r,
				fd: e,
				port: t
			}), 0;
		}
	}, await ds.init(e.kernelWasmBytes), Hs = o.kernelInstance, Us = o.kernelMemory, ds.framebuffers.onChange((e, t) => {
		if ("bind" === t) {
			const t = ds.framebuffers.get(e), n = ds.getProcessMemory(e);
			if (!t || !n) return;
			Rs({
				type: "fb_bind",
				pid: e,
				addr: t.addr,
				len: t.len,
				w: t.w,
				h: t.h,
				stride: t.stride,
				fmt: "BGRA32",
				memory: n
			});
		} else Rs({
			type: "fb_unbind",
			pid: e
		});
	});
	const c = ds.framebuffers.rebindMemory.bind(ds.framebuffers);
	ds.framebuffers.rebindMemory = (e) => {
		if (c(e), !ds.framebuffers.get(e)) return;
		const t = ds.getProcessMemory(e);
		t && Rs({
			type: "fb_rebind_memory",
			pid: e,
			memory: t
		});
	}, ds.framebuffers.onWrite((e, t, n) => {
		const r = n.buffer.slice(n.byteOffset, n.byteOffset + n.byteLength);
		Rs({
			type: "fb_write",
			pid: e,
			offset: t,
			bytes: new Uint8Array(r)
		}, [r]);
	}), e.bridgePort && (Ms = e.bridgePort), Rs({ type: "ready" });
}
async function $s(e) {
	try {
		let t;
		if (await xs(), e.programBytes) t = e.programBytes;
		else {
			if (!e.programPath) return void Ds(e.requestId, "No programBytes or programPath");
			{
				const n = await async function(e) {
					return await us.ensureMaterialized(e), js(e);
				}(e.programPath);
				if (!n) return void Ds(e.requestId, `ENOENT: ${e.programPath}`);
				t = n;
			}
		}
		const n = e.pid ?? ds.allocatePid(), r = e.maxPages ?? gs, i = je(t), { memory: s, layout: o, threadAllocator: a } = Os(n, t, i, r), c = o.channelOffset;
		if (ds.registerProcess(n, s, [c], {
			ptrWidth: i,
			argv: e.argv,
			brkBase: o.brkBase,
			mmapBase: o.mmapBase,
			maxAddr: o.maxAddr
		}), e.cwd && ds.setCwd(n, e.cwd), ds.setCredentials(n, {
			uid: e.uid,
			gid: e.gid
		}), e.pty) {
			const t = ds.setupPty(n);
			Bs.set(n, t), null != e.ptyCols && null != e.ptyRows && ds.ptySetWinsize(t, e.ptyRows, e.ptyCols);
		} else if (e.stdin) {
			const t = e.stdin instanceof Uint8Array ? e.stdin : new Uint8Array(e.stdin);
			ds.setStdinData(n, t);
		}
		const l = {
			type: "centralized_init",
			pid: n,
			ppid: 0,
			programBytes: t,
			memory: s,
			channelOffset: c,
			env: e.env ?? _s,
			argv: e.argv,
			cwd: e.cwd,
			ptrWidth: i,
			kernelAbiVersion: ds.getKernelAbiVersion()
		}, h = fs.createWorker(l);
		ys.set(n, {
			memory: s,
			programBytes: t,
			worker: h,
			argv: e.argv,
			channelOffset: c,
			ptrWidth: i,
			layout: o,
			threadAllocator: a
		}), Fs(h, n), Ws(e.requestId, n);
	} catch (t) {
		Ds(e.requestId, String(t));
	}
}
function Fs(e, t) {
	let n = !1;
	const r = (r, i) => {
		if (n) return;
		if (n = !0, ys.get(t)?.worker !== e) return;
		const s = `[kernel-worker] pid=${t} ${i} -> forcing exit ${r}`;
		0 === r && "worker-main exit message" === i ? console.debug(s) : console.warn(s), Gs(t, r);
	};
	e.on("error", (n) => {
		As.has(e) || (console.error(`[kernel-worker] Worker error pid=${t}:`, n.message), r(139, "worker.onerror"));
	}), e.on("exit", (t) => {
		As.has(e) || r(139, "worker exit event");
	}), e.on("message", (e) => {
		const n = e;
		"error" === n.type ? (console.error(`[kernel-worker] Process error pid=${t}:`, n.message), Rs({
			type: "stderr",
			pid: t,
			data: new TextEncoder().encode(`[process-worker] ${n.message ?? "unknown error"}\n`)
		}), r(-1, "worker-main error message")) : "exit" === n.type && r(n.status ?? 0, "worker-main exit message");
	});
}
async function Vs(e, t) {
	return Is(e, t);
}
async function qs(e, t, n, r) {
	await xs(), Rs({
		type: "proc_event",
		kind: "spawn",
		pid: e
	});
	const i = je(t), { memory: s, layout: o, threadAllocator: a } = Os(e, t, i), c = o.channelOffset;
	ds.registerProcess(e, s, [c], {
		skipKernelCreate: !0,
		ptrWidth: i,
		brkBase: o.brkBase,
		mmapBase: o.mmapBase,
		maxAddr: o.maxAddr
	});
	const l = {
		type: "centralized_init",
		pid: e,
		ppid: 0,
		programBytes: t,
		memory: s,
		channelOffset: c,
		argv: n,
		env: r,
		ptrWidth: i,
		kernelAbiVersion: ds.getKernelAbiVersion()
	}, h = fs.createWorker(l);
	return ys.set(e, {
		memory: s,
		programBytes: t,
		worker: h,
		argv: n,
		channelOffset: c,
		ptrWidth: i,
		layout: o,
		threadAllocator: a
	}), Fs(h, e), 0;
}
function Gs(e, t) {
	(async function(e, t) {
		if (ws.has(e)) return;
		const n = ys.get(e), r = ks.has(e) ? bs : 0, i = Math.max(r, function(e) {
			const t = function(e) {
				const t = e.lastIndexOf("/");
				return t >= 0 ? e.slice(t + 1) : e;
			}(e?.[0] ?? "");
			return "node" === t || "spidermonkey-node" === t || "spidermonkey-node.wasm" === t ? 2e3 : 0;
		}(n?.argv));
		ks.delete(e);
		const s = (async () => {
			try {
				ds.notifyHostProcessCrashed(e);
			} catch {}
			ds.deactivateProcess(e), ys.delete(e), Cs.delete(e), Bs.delete(e), await Ps(e), n?.worker && await Ts(n.worker, i);
		})();
		ws.set(e, s), Rs({
			type: "exit",
			pid: e,
			status: t
		});
		try {
			await s;
		} finally {
			ws.delete(e);
		}
	})(e, t);
}
function js(e) {
	try {
		const t = us.open(e, 0, 0);
		try {
			const e = us.fstat(t).size;
			if (e <= 0) return us.close(t), null;
			const n = new Uint8Array(e), r = us.read(t, n, null, e);
			return us.close(t), r <= 0 ? null : n.buffer.slice(n.byteOffset, n.byteOffset + r);
		} catch {
			return us.close(t), null;
		}
	} catch {
		return null;
	}
}
globalThis.onmessage = (e) => {
	const t = e.data;
	switch (t.type) {
		case "init":
			Ns(t).catch((e) => {
				const t = function(e) {
					return e instanceof Error ? e.stack ? `${e.message}\n${e.stack}` : e.message : String(e);
				}(e);
				console.error("[kernel-worker] init failed:", e), Rs({
					type: "init_error",
					error: t
				});
			});
			break;
		case "spawn":
			$s(t);
			break;
		case "terminate_process":
			(async function(e) {
				const t = e.pid, n = Es.get(t);
				if (n) {
					for (const e of n) {
						await (e.termination ?? Ts(e.worker, bs));
						try {
							ds.notifyThreadExit(t, e.tid), ds.removeChannel(t, e.channelOffset);
						} catch {}
					}
					Es.delete(t);
				}
				const r = ys.get(t);
				r?.worker && await Ts(r.worker);
				try {
					ds.unregisterProcess(t);
				} catch {}
				ys.delete(t), Cs.delete(t), ks.delete(t), Bs.delete(t), Ws(e.requestId, !0);
			})(t);
			break;
		case "append_stdin_data":
			ds.appendStdinData(t.pid, t.data);
			break;
		case "set_stdin_data":
			ds.setStdinData(t.pid, t.data);
			break;
		case "pty_write":
			(function(e) {
				const t = Bs.get(e.pid);
				void 0 !== t && ds.ptyMasterWrite(t, e.data);
			})(t);
			break;
		case "pty_resize":
			(function(e) {
				const t = Bs.get(e.pid);
				void 0 !== t && ds.ptySetWinsize(t, e.rows, e.cols);
			})(t);
			break;
		case "register_pty_output":
			(function(e) {
				const t = Bs.get(e.pid);
				void 0 !== t && ds.onPtyOutput(t, (t) => {
					Rs({
						type: "pty_output",
						pid: e.pid,
						data: t
					});
				});
			})(t);
			break;
		case "inject_connection":
			(function(e) {
				if (!Hs) return void Ws(e.requestId, -1);
				const t = (0, Hs.exports.kernel_inject_connection)(e.pid, e.fd, e.peerAddr[0], e.peerAddr[1], e.peerAddr[2], e.peerAddr[3], e.peerPort);
				t >= 0 && ds.scheduleWakeBlockedRetries(), Ws(e.requestId, t);
			})(t);
			break;
		case "pipe_read":
			(function(e) {
				if (!Hs) return void Ws(e.requestId, null);
				const t = Hs.exports.kernel_pipe_read, n = ds.tcpScratchOffset || ds.scratchOffset, r = [];
				for (;;) {
					const i = t(e.pid, e.pipeIdx, ds.toKernelPtr(n), ls);
					if (i <= 0) break;
					const s = new Uint8Array(Us.buffer);
					r.push(s.slice(n, n + i));
				}
				if (0 === r.length) return void Ws(e.requestId, null);
				const i = r.reduce((e, t) => e + t.length, 0), s = new Uint8Array(i);
				let o = 0;
				for (const a of r) s.set(a, o), o += a.length;
				Ws(e.requestId, s);
			})(t);
			break;
		case "pipe_write":
			(function(e) {
				if (!Hs) return void Ws(e.requestId, -1);
				const t = Hs.exports.kernel_pipe_write, n = ds.tcpScratchOffset || ds.scratchOffset;
				let r = 0;
				const i = e.data;
				for (; r < i.length;) {
					const s = Math.min(i.length - r, ls);
					new Uint8Array(Us.buffer).set(i.subarray(r, r + s), n);
					const o = t(e.pid, e.pipeIdx, ds.toKernelPtr(n), s);
					if (o <= 0) break;
					r += o;
				}
				ds.notifyPipeReadable(e.pipeIdx), Ws(e.requestId, r);
			})(t);
			break;
		case "pipe_close_read":
			(function(e) {
				if (!Hs) return;
				(0, Hs.exports.kernel_pipe_close_read)(e.pid, e.pipeIdx);
			})(t);
			break;
		case "pipe_close_write":
			(function(e) {
				if (!Hs) return;
				(0, Hs.exports.kernel_pipe_close_write)(e.pid, e.pipeIdx);
			})(t);
			break;
		case "pipe_is_write_open":
			(function(e) {
				if (!Hs) return void Ws(e.requestId, !1);
				const t = Hs.exports.kernel_pipe_is_write_open;
				Ws(e.requestId, 1 === t(e.pid, e.pipeIdx));
			})(t);
			break;
		case "wake_blocked_readers":
			(function(e) {
				const t = ds, n = t.pendingPipeReaders?.get(e.pipeIdx);
				if (n && n.length > 0) {
					t.pendingPipeReaders.delete(e.pipeIdx);
					for (const e of n) t.processes.has(e.pid) && t.retrySyscall(e.channel);
				}
				t.scheduleWakeBlockedRetries();
			})(t);
			break;
		case "wake_blocked_writers":
			(function(e) {
				const t = ds, n = t.pendingPipeWriters?.get(e.pipeIdx);
				if (n && n.length > 0) {
					t.pendingPipeWriters.delete(e.pipeIdx);
					for (const e of n) t.processes.has(e.pid) && t.retrySyscall(e.channel);
				}
				t.scheduleWakeBlockedRetries();
			})(t);
			break;
		case "is_stdin_consumed":
			(function(e) {
				const t = ds;
				Ws(e.requestId, t.stdinFinite.has(e.pid) && !t.stdinBuffers.has(e.pid));
			})(t);
			break;
		case "pick_listener_target":
			(function(e) {
				const t = ds.pickListenerTarget(e.port);
				Ws(e.requestId, t);
			})(t);
			break;
		case "http_request":
			(async function(t) {
				if (Hs) try {
					const e = await ds.sendHttpRequest(t.port, t.request, { timeoutMs: t.timeoutMs });
					Ws(t.requestId, e);
				} catch (e) {
					Ds(t.requestId, e instanceof Error ? e.message : String(e));
				}
				else Ds(t.requestId, "Kernel not initialized");
			})(t);
			break;
		case "destroy":
			(async function(e) {
				for (const [t, n] of ys) {
					n.worker && (await Ps(t), await Ts(n.worker));
					try {
						ds.unregisterProcess(t);
					} catch {}
				}
				for (const t of Es.values()) for (const e of t) await (e.termination ?? Ts(e.worker, bs));
				ys.clear(), Cs.clear(), Es.clear(), ks.clear(), Bs.clear(), await xs(), Ws(e.requestId, !0);
			})(t);
			break;
		case "register_lazy_files":
			us.importLazyEntries(t.entries);
			break;
		case "register_lazy_archives":
			us.importLazyArchiveEntries(t.entries);
			break;
		case "get_fork_count":
			try {
				const e = ds.getForkCount(t.pid);
				Ws(t.requestId, e);
			} catch ($n) {
				Ds(t.requestId, $n?.message ?? String($n));
			}
			break;
		case "mouse_inject":
			(function(e) {
				ds.injectMouseEvent(e.dx, e.dy, e.buttons);
			})(t);
			break;
		case "audio_drain":
			(function(e) {
				const t = Math.min(e.maxBytes, 65536), n = new Uint8Array(t), r = ds.drainAudio(n), i = ds.audioSampleRate(), s = ds.audioChannels(), o = r > 0 ? n.slice(0, r) : new Uint8Array(0);
				Rs({
					type: "response",
					requestId: e.requestId,
					result: {
						bytes: o,
						sampleRate: i,
						channels: s
					}
				}, [o.buffer]);
			})(t);
			break;
		case "enum_procs":
			try {
				Ws(t.requestId, ds.enumProcs());
			} catch ($n) {
				Ds(t.requestId, $n?.message ?? String($n));
			}
			break;
		case "read_proc_maps":
			try {
				Ws(t.requestId, ds.readProcMaps(t.pid));
			} catch ($n) {
				Ds(t.requestId, $n?.message ?? String($n));
			}
			break;
		case "set_syscall_trace":
			t.enabled ? ds.enableSyscallTrace() : ds.disableSyscallTrace();
			break;
		case "drain_syscall_trace":
			try {
				Ws(t.requestId, ds.drainSyscallTrace());
			} catch ($n) {
				Ds(t.requestId, $n?.message ?? String($n));
			}
			break;
		default: {
			const t = e.data;
			if ("sysprof_start" === t?.type) globalThis.__sysprof = !0, globalThis.__sysprofTable = /* @__PURE__ */ new Map(), globalThis.__sysprofStartedAt = performance.now(), Rs({
				type: "stdout",
				pid: 0,
				data: new TextEncoder().encode("[sysprof] started\n")
			});
			else if ("pid_map_dump" === t?.type) {
				const e = globalThis.__pidMap, t = ["[pid-map] (pid → exec'd path)\n"];
				if (e) for (const [n, r] of [...e.entries()].sort((e, t) => e[0] - t[0])) t.push(`  pid=${n} ${r}\n`);
				Rs({
					type: "stdout",
					pid: 0,
					data: new TextEncoder().encode(t.join(""))
				});
			} else if ("sysprof_dump" === t?.type) {
				const e = globalThis.__sysprofTable, t = globalThis.__sysprofGap, n = globalThis.__sysprofStartedAt ?? 0, r = performance.now() - n, i = e ? [...e.entries()].map(([e, t]) => ({
					key: e,
					...t
				})) : [];
				i.sort((e, t) => t.totalMs - e.totalMs);
				let s = `[sysprof] ${r.toFixed(0)}ms total, top syscalls by kernel-side time:\n`;
				for (const o of i.slice(0, 20)) {
					const [e, t] = o.key.split(":");
					s += `  pid=${e} nr=${t} count=${o.count} total=${o.totalMs.toFixed(0)}ms max=${o.maxMs.toFixed(1)}ms avg=${(o.totalMs / o.count).toFixed(2)}ms\n`;
				}
				if (t) {
					const e = [...t.entries()].map(([e, t]) => ({
						pid: e,
						...t
					}));
					e.sort((e, t) => t.gapTotalMs - e.gapTotalMs), s += "[sysprof] gap-between-syscalls per pid (= time spent in user wasm):\n";
					for (const t of e.slice(0, 15)) s += `  pid=${t.pid} gaps=${t.count} total=${t.gapTotalMs.toFixed(0)}ms max=${t.gapMaxMs.toFixed(1)}ms avg=${(t.gapTotalMs / t.count).toFixed(2)}ms\n`;
				}
				Rs({
					type: "stdout",
					pid: 0,
					data: new TextEncoder().encode(s)
				}), globalThis.__sysprof = !1;
			} else "set_bridge_port" === t?.type && t.bridgePort ? (Ms = t.bridgePort, "number" == typeof t.httpPort && (Ls = t.httpPort), Ms && (Ms.onmessage = (t) => {
				const n = t.data;
				"http-request" === n?.type && async function(t, n) {
					if (!Hs || !Ms) return;
					const r = n.url || "?";
					let i = Ls;
					if (null == i && (i = Array.from(ds.tcpListenerTargets?.keys() ?? [])[0] ?? null), null == i) return console.warn(`[bridge] no listener target for req#${t} ${r}`), void Ms.postMessage({
						type: "http-error",
						requestId: t,
						error: "No listener target available"
					});
					console.log(`[bridge] req#${t} ${n.method} ${r} → port=${i}`);
					try {
						const e = await ds.sendHttpRequest(i, {
							method: n.method,
							url: r,
							headers: n.headers ?? {},
							body: n.body ?? null
						}, { debugLabel: `req#${t}` });
						Ms.postMessage({
							type: "http-response",
							requestId: t,
							status: e.status,
							headers: e.headers,
							body: e.body
						});
					} catch (e) {
						console.warn(`[bridge] req#${t} ${r} failed:`, e), Ms.postMessage({
							type: "http-error",
							requestId: t,
							error: e instanceof Error ? e.message : String(e)
						});
					}
				}(n.requestId, n);
			})) : console.warn("[kernel-worker] Unknown message type:", t?.type);
		}
	}
};
export { o as t };
