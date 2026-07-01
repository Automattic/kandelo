var e = Object.create, t = Object.defineProperty, n = Object.getOwnPropertyDescriptor, i = Object.getOwnPropertyNames, s = Object.getPrototypeOf, r = Object.prototype.hasOwnProperty, o = (e, t) => () => (t || (e((t = { exports: {} }).exports, t), e = null), t.exports), a = (o, a, c) => (c = null != o ? e(s(o)) : {}, ((e, s, o, a) => {
	if (s && "object" == typeof s || "function" == typeof s) for (var c, l = i(s), h = 0, d = l.length; h < d; h++) c = l[h], r.call(e, c) || c === o || t(e, c, {
		get: ((e) => s[e]).bind(null, c),
		enumerable: !(a = n(s, c)) || a.enumerable
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
		const t = Atomics.load(this.meta, 2), n = this.cap - t, i = Math.min(e.length, n);
		if (0 === i) return 0;
		let s = Atomics.load(this.meta, 1);
		for (let r = 0; r < i; r++) this.data[s] = e[r], s = (s + 1) % this.cap;
		return Atomics.store(this.meta, 1, s), Atomics.add(this.meta, 2, i), i;
	}
	read(e) {
		const t = Atomics.load(this.meta, 2), n = Math.min(e.length, t);
		if (0 === n) return 0;
		let i = Atomics.load(this.meta, 0);
		for (let s = 0; s < n; s++) e[s] = this.data[i], i = (i + 1) % this.cap;
		return Atomics.store(this.meta, 0, i), Atomics.sub(this.meta, 2, n), n;
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
		const [i, s] = this.i64ToParts(t.start);
		this.view[n + 4] = i, this.view[n + 5] = s;
		const [r, o] = this.i64ToParts(t.len);
		this.view[n + 6] = r, this.view[n + 7] = o;
	}
	removeEntryUnsafe(e) {
		const t = this.view[1];
		if (e < t - 1) {
			const n = this.entryBase(t - 1), i = this.entryBase(e);
			for (let e = 0; e < 8; e++) this.view[i + e] = this.view[n + e];
		}
		this.view[1] = t - 1;
	}
	i64FromParts(e, t) {
		return BigInt(t) << 32n | BigInt(e >>> 0);
	}
	i64ToParts(e) {
		return [Number(4294967295n & e), Number(e >> 32n & 4294967295n)];
	}
	static rangesOverlap(e, t, n, i) {
		const s = 0n === t ? BigInt("0x7fffffffffffffff") : e + t;
		return e < (0n === i ? BigInt("0x7fffffffffffffff") : n + i) && n < s;
	}
	static conflicts(t, n, i, s, r) {
		return t.pid !== r && !!e.rangesOverlap(t.start, t.len, i, s) && (0 !== t.lockType || 0 !== n);
	}
	getBlockingLock(e, t, n, i, s) {
		this.acquire();
		try {
			return this._getBlockingLockUnsafe(e, t, n, i, s);
		} finally {
			this.release();
		}
	}
	_getBlockingLockUnsafe(t, n, i, s, r) {
		const o = this.view[1];
		for (let a = 0; a < o; a++) {
			const o = this.readEntry(a);
			if (o.pathHash === t && e.conflicts(o, n, i, s, r)) return o;
		}
		return null;
	}
	setLock(e, t, n, i, s) {
		this.acquire();
		try {
			return this._setLockUnsafe(e, t, n, i, s);
		} finally {
			this.release();
		}
	}
	_setLockUnsafe(t, n, i, s, r) {
		if (2 === i) {
			let i = 0;
			for (; i < this.view[1];) {
				const o = this.readEntry(i);
				o.pathHash === t && o.pid === n && e.rangesOverlap(o.start, o.len, s, r) ? this.removeEntryUnsafe(i) : i++;
			}
			return Atomics.add(this.view, 3, 1), Atomics.notify(this.view, 3), !0;
		}
		if (this._getBlockingLockUnsafe(t, i, s, r, n)) return !1;
		let o = 0;
		for (; o < this.view[1];) {
			const i = this.readEntry(o);
			i.pathHash === t && i.pid === n && e.rangesOverlap(i.start, i.len, s, r) ? this.removeEntryUnsafe(o) : o++;
		}
		const a = this.view[1];
		return !(a >= this.view[2]) && (this.writeEntry(a, {
			pathHash: t,
			pid: n,
			lockType: i,
			start: s,
			len: r
		}), this.view[1] = a + 1, !0);
	}
	setLockWait(e, t, n, i, s) {
		for (;;) {
			if (this.acquire(), !this._getBlockingLockUnsafe(e, n, i, s, t)) return this._setLockUnsafe(e, t, n, i, s), void this.release();
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
		const i = this.bindings.get(e);
		if (i?.hostBuffer) {
			const e = Math.min(t + n.length, i.hostBuffer.length);
			e > t && i.hostBuffer.set(n.subarray(0, e - t), t);
		}
		for (const s of this.writeListeners) s(e, t, n);
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
}, d = class {
	bos = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	getProcessMemory;
	constructor(e = {}) {
		this.getProcessMemory = e.getProcessMemory ?? null;
	}
	setProcessMemoryResolver(e) {
		this.getProcessMemory = e;
	}
	create(e) {
		const t = this.bos.get(e.bo_id);
		t ? t.pids.add(e.pid) : this.bos.set(e.bo_id, {
			bo_id: e.bo_id,
			size: e.size,
			w: e.w,
			h: e.h,
			stride: e.stride,
			sab: new SharedArrayBuffer(e.size),
			pids: new Set([e.pid]),
			bindingsByPid: /* @__PURE__ */ new Map()
		});
		for (const n of this.listeners) n(e.pid, e.bo_id, "create");
	}
	destroy(e, t) {
		if (this.bos.delete(t)) for (const n of this.listeners) n(e, t, "destroy");
	}
	bind(e, t, n, i) {
		const s = this.bos.get(t);
		if (!s) return -1;
		s.pids.add(e), s.bindingsByPid.set(e, {
			addr: n,
			len: i
		});
		for (const r of this.listeners) r(e, t, "bind");
		return 0;
	}
	unbind(e, t) {
		const n = this.bos.get(t);
		if (!n) return;
		const i = n.bindingsByPid.get(e);
		i && this.flushMemoryToSab(n, e, i), n.bindingsByPid.delete(e);
		for (const s of this.listeners) s(e, t, "unbind");
	}
	findBindingByAddr(e, t) {
		for (const n of this.bos.values()) {
			const i = n.bindingsByPid.get(e);
			if (i && i.addr === t) return n.bo_id;
		}
	}
	primeBindFromSab(e, t, n) {
		const i = this.bos.get(t);
		if (!i) return;
		const s = i.bindingsByPid.get(e);
		if (!s) return;
		for (const [c, l] of i.bindingsByPid) c !== e && this.flushMemoryToSab(i, c, l);
		const r = Math.min(s.len, i.size);
		if (s.addr + r > n.buffer.byteLength) return;
		const o = new Uint8Array(n.buffer, s.addr, r), a = new Uint8Array(i.sab, 0, r);
		o.set(a);
	}
	flushMemoryToSab(e, t, n) {
		const i = this.getProcessMemory;
		if (!i) return;
		const s = i(t);
		if (!s) return;
		const r = Math.min(n.len, e.size);
		if (n.addr + r > s.buffer.byteLength) return;
		const o = new Uint8Array(e.sab, 0, r), a = new Uint8Array(s.buffer, n.addr, r);
		o.set(a);
	}
	get(e, t) {
		const n = this.bos.get(t);
		if (n && n.pids.has(e)) return this.project(n, e);
	}
	listForPid(e) {
		const t = [];
		for (const n of this.bos.values()) n.pids.has(e) && t.push(this.project(n, e));
		return t;
	}
	pixelView(e) {
		const t = this.bos.get(e);
		if (t) return new Uint8Array(t.sab);
	}
	syncFromMemory(e) {
		const t = this.bos.get(e);
		if (t) for (const [n, i] of t.bindingsByPid) this.flushMemoryToSab(t, n, i);
	}
	onChange(e) {
		return this.listeners.add(e), () => {
			this.listeners.delete(e);
		};
	}
	project(e, t) {
		return {
			pid: t,
			bo_id: e.bo_id,
			size: e.size,
			w: e.w,
			h: e.h,
			stride: e.stride,
			binding: e.bindingsByPid.get(t) ?? null
		};
	}
}, f = class {
	gbm;
	fbs = /* @__PURE__ */ new Map();
	crtcBindings = /* @__PURE__ */ new Map();
	masterPid = null;
	constructor(e) {
		this.gbm = e;
	}
	addFb(e) {
		this.fbs.set(e.fb_id, e);
	}
	rmFb(e) {
		this.fbs.delete(e);
	}
	setFb(e, t) {
		this.crtcBindings.set(e, t);
	}
	currentFb(e) {
		const t = this.crtcBindings.get(e);
		return void 0 === t ? void 0 : this.fbs.get(t);
	}
	setMasterPid(e) {
		this.masterPid = e;
	}
	dropMaster() {
		this.masterPid = null;
	}
	isMasterPid(e) {
		return this.masterPid === e;
	}
	masterCrtcForPid(e) {
		if (this.masterPid !== e) return null;
		for (const t of this.crtcBindings.keys()) return t;
		return null;
	}
	scanoutBytes(e) {
		const t = this.currentFb(e);
		if (t) return this.gbm.syncFromMemory(t.bo_id), this.gbm.pixelView(t.bo_id);
	}
};
const u = 2929, g = 2960, p = 3042, m = 2884, y = 3089, w = 32823, b = 33984;
function k(e, t, n) {
	switch (t) {
		case u:
			e.depthTestEnabled = n;
			return;
		case g:
			e.stencilTestEnabled = n;
			return;
		case p:
			e.blendEnabled = n;
			return;
		case m:
			e.cullFaceEnabled = n;
			return;
		case w:
			e.polygonOffsetFillEnabled = n;
			return;
		case y:
			e.scissor.enabled = n;
			return;
	}
}
var I = class {
	bindings = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	pendingForwards = /* @__PURE__ */ new Map();
	pendingCanvases = /* @__PURE__ */ new Map();
	bind(e) {
		const t = this.pendingForwards.get(e.pid) ?? null;
		this.pendingForwards.delete(e.pid);
		const n = this.pendingCanvases.get(e.pid) ?? null;
		this.pendingCanvases.delete(e.pid), this.bindings.set(e.pid, {
			...e,
			cmdbufView: null,
			gl: null,
			canvas: n,
			contextId: null,
			surfaceId: null,
			buffers: /* @__PURE__ */ new Map(),
			textures: /* @__PURE__ */ new Map(),
			shaders: /* @__PURE__ */ new Map(),
			programs: /* @__PURE__ */ new Map(),
			vaos: /* @__PURE__ */ new Map(),
			fbos: /* @__PURE__ */ new Map(),
			rbos: /* @__PURE__ */ new Map(),
			uniformLocations: /* @__PURE__ */ new Map(),
			nextUniformLoc: 0,
			currentProgram: null,
			shadow: {
				viewport: [
					0,
					0,
					0,
					0
				],
				scissor: {
					enabled: !1,
					rect: [
						0,
						0,
						0,
						0
					]
				},
				clearColor: [
					0,
					0,
					0,
					0
				],
				depthTestEnabled: !1,
				depthFunc: 513,
				stencilTestEnabled: !1,
				blendEnabled: !1,
				blendFunc: {
					srcRGB: 1,
					dstRGB: 0,
					srcA: 1,
					dstA: 0
				},
				cullFaceEnabled: !1,
				cullFace: 1029,
				frontFace: 2305,
				polygonOffsetFillEnabled: !1,
				currentProgram: null,
				vao: null,
				fbo: null,
				activeTexture: 0,
				textureUnits: new Array(32).fill(null),
				unpackAlignment: 4,
				packAlignment: 4
			},
			forward: t
		});
		for (const i of this.listeners) i(e.pid, "bind");
	}
	unbind(e) {
		if (this.pendingForwards.delete(e), this.bindings.delete(e)) for (const t of this.listeners) t(e, "unbind");
	}
	get(e) {
		return this.bindings.get(e);
	}
	list() {
		return [...this.bindings.values()];
	}
	rebindMemory(e) {
		const t = this.bindings.get(e);
		t && (t.cmdbufView = null);
	}
	attachCanvas(e, t) {
		const n = this.bindings.get(e);
		n ? n.canvas = t : this.pendingCanvases.set(e, t);
	}
	detachCanvas(e) {
		this.pendingCanvases.delete(e);
		const t = this.bindings.get(e);
		t && (t.canvas = null, t.gl = null);
	}
	getCanvas(e) {
		const t = this.bindings.get(e);
		return t?.canvas ? t.canvas : this.pendingCanvases.get(e) ?? null;
	}
	attachMainForward(e, t) {
		const n = this.bindings.get(e);
		n ? n.forward = t : this.pendingForwards.set(e, t);
	}
	detachMainForward(e) {
		this.pendingForwards.delete(e);
		const t = this.bindings.get(e);
		t && (t.forward = null);
	}
	onChange(e) {
		return this.listeners.add(e), () => {
			this.listeners.delete(e);
		};
	}
};
const v = 1024, x = 1025, _ = 1026, P = 1027, B = 1028, U = 1029, A = 1030, S = 1280, M = 1281, E = 1282, C = 1283, T = 1284, z = 1536, O = 1537, R = 1538, F = 1792, L = 1793, N = 1794, $ = 1795, D = 1796, W = 1797, K = 1798;
function V(e, t, n) {
	return e.cmdbufView && e.gl ? H(e.cmdbufView, t, n, (t, n) => {
		try {
			return function(e, t, n, i, s) {
				switch (s) {
					case 1:
						e.clear(n.getUint32(i, !0));
						return;
					case 2:
						t.shadow.clearColor = [
							n.getFloat32(i, !0),
							n.getFloat32(i + 4, !0),
							n.getFloat32(i + 8, !0),
							n.getFloat32(i + 12, !0)
						], e.clearColor(...t.shadow.clearColor);
						return;
					case 3:
						t.shadow.viewport = [
							n.getInt32(i, !0),
							n.getInt32(i + 4, !0),
							n.getInt32(i + 8, !0),
							n.getInt32(i + 12, !0)
						], e.viewport(...t.shadow.viewport);
						return;
					case 4: {
						const s = n.getInt32(i, !0), r = n.getInt32(i + 4, !0), o = n.getInt32(i + 8, !0), a = n.getInt32(i + 12, !0);
						e.scissor(s, r, o, a), t.shadow.scissor.rect = [
							s,
							r,
							o,
							a
						];
						return;
					}
					case 5: {
						const s = n.getUint32(i, !0);
						e.enable(s), k(t.shadow, s, !0);
						return;
					}
					case 6: {
						const s = n.getUint32(i, !0);
						e.disable(s), k(t.shadow, s, !1);
						return;
					}
					case 7: {
						const s = n.getUint32(i, !0), r = n.getUint32(i + 4, !0);
						e.blendFunc(s, r), t.shadow.blendFunc = {
							srcRGB: s,
							dstRGB: r,
							srcA: s,
							dstA: r
						};
						return;
					}
					case 8:
						t.shadow.depthFunc = n.getUint32(i, !0), e.depthFunc(t.shadow.depthFunc);
						return;
					case 9:
						t.shadow.cullFace = n.getUint32(i, !0), e.cullFace(t.shadow.cullFace);
						return;
					case 10:
						t.shadow.frontFace = n.getUint32(i, !0), e.frontFace(t.shadow.frontFace);
						return;
					case 11:
						e.lineWidth(n.getFloat32(i, !0));
						return;
					case 12: {
						const s = n.getUint32(i, !0), r = n.getInt32(i + 4, !0);
						e.pixelStorei(s, r), 3317 === s ? t.shadow.unpackAlignment = r : 3333 === s && (t.shadow.packAlignment = r);
						return;
					}
					case 256: {
						const s = n.getUint32(i, !0);
						for (let r = 0; r < s; r++) {
							const s = n.getUint32(i + 4 + 4 * r, !0), o = e.createBuffer();
							o && t.buffers.set(s, o);
						}
						return;
					}
					case 257: {
						const s = n.getUint32(i, !0);
						for (let r = 0; r < s; r++) {
							const s = n.getUint32(i + 4 + 4 * r, !0), o = t.buffers.get(s);
							o && e.deleteBuffer(o), t.buffers.delete(s);
						}
						return;
					}
					case 258:
						e.bindBuffer(n.getUint32(i, !0), t.buffers.get(n.getUint32(i + 4, !0)) ?? null);
						return;
					case 259: {
						const t = n.getUint32(i, !0), s = n.getUint32(i + 4, !0), r = n.getUint32(i + 8 + s, !0);
						if (0 === s) e.bufferData(t, 0, r);
						else {
							const o = new Uint8Array(n.buffer, n.byteOffset + i + 8, s);
							e.bufferData(t, o, r);
						}
						return;
					}
					case 260: {
						const t = n.getUint32(i, !0), s = n.getInt32(i + 4, !0), r = n.getUint32(i + 8, !0), o = new Uint8Array(n.buffer, n.byteOffset + i + 12, r);
						e.bufferSubData(t, s, o);
						return;
					}
					case 512: {
						const s = n.getUint32(i, !0);
						for (let r = 0; r < s; r++) {
							const s = n.getUint32(i + 4 + 4 * r, !0), o = e.createTexture();
							o && t.textures.set(s, o);
						}
						return;
					}
					case 513: {
						const s = n.getUint32(i, !0);
						for (let r = 0; r < s; r++) {
							const s = n.getUint32(i + 4 + 4 * r, !0), o = t.textures.get(s);
							o && e.deleteTexture(o), t.textures.delete(s);
						}
						return;
					}
					case 514: {
						const s = t.textures.get(n.getUint32(i + 4, !0)) ?? null;
						e.bindTexture(n.getUint32(i, !0), s);
						const r = t.shadow.activeTexture;
						r >= 0 && r < t.shadow.textureUnits.length && (t.shadow.textureUnits[r] = s);
						return;
					}
					case 515: {
						const t = n.getUint32(i, !0), s = n.getInt32(i + 4, !0), r = n.getInt32(i + 8, !0), o = n.getInt32(i + 12, !0), a = n.getInt32(i + 16, !0), c = n.getInt32(i + 20, !0), l = n.getUint32(i + 24, !0), h = n.getUint32(i + 28, !0), d = n.getUint32(i + 32, !0), f = 0 === d ? null : new Uint8Array(n.buffer, n.byteOffset + i + 36, d);
						e.texImage2D(t, s, r, o, a, c, l, h, f);
						return;
					}
					case 516: {
						const t = n.getUint32(i, !0), s = n.getInt32(i + 4, !0), r = n.getInt32(i + 8, !0), o = n.getInt32(i + 12, !0), a = n.getInt32(i + 16, !0), c = n.getInt32(i + 20, !0), l = n.getUint32(i + 24, !0), h = n.getUint32(i + 28, !0), d = n.getUint32(i + 32, !0), f = new Uint8Array(n.buffer, n.byteOffset + i + 36, d);
						e.texSubImage2D(t, s, r, o, a, c, l, h, f);
						return;
					}
					case 517:
						e.texParameteri(n.getUint32(i, !0), n.getUint32(i + 4, !0), n.getInt32(i + 8, !0));
						return;
					case 518: {
						const s = n.getUint32(i, !0);
						e.activeTexture(s), t.shadow.activeTexture = s - b;
						return;
					}
					case 519:
						e.generateMipmap(n.getUint32(i, !0));
						return;
					case 768: {
						const s = n.getUint32(i, !0), r = n.getUint32(i + 4, !0), o = e.createShader(s);
						o && t.shaders.set(r, o);
						return;
					}
					case 769: {
						const s = n.getUint32(i, !0), r = n.getUint32(i + 4, !0), o = new Uint8Array(r);
						o.set(new Uint8Array(n.buffer, n.byteOffset + i + 8, r));
						const a = new TextDecoder().decode(o), c = t.shaders.get(s);
						c && e.shaderSource(c, a);
						return;
					}
					case 770: {
						const s = t.shaders.get(n.getUint32(i, !0));
						s && e.compileShader(s);
						return;
					}
					case 771: {
						const s = n.getUint32(i, !0), r = t.shaders.get(s);
						r && e.deleteShader(r), t.shaders.delete(s);
						return;
					}
					case 772: {
						const s = n.getUint32(i, !0), r = e.createProgram();
						r && t.programs.set(s, r);
						return;
					}
					case 773: {
						const s = t.programs.get(n.getUint32(i, !0)), r = t.shaders.get(n.getUint32(i + 4, !0));
						s && r && e.attachShader(s, r);
						return;
					}
					case 774: {
						const s = t.programs.get(n.getUint32(i, !0));
						s && e.linkProgram(s);
						return;
					}
					case 775: {
						const s = t.programs.get(n.getUint32(i, !0)) ?? null;
						e.useProgram(s), t.currentProgram = s, t.shadow.currentProgram = s;
						return;
					}
					case 776: {
						const s = t.programs.get(n.getUint32(i, !0)), r = n.getUint32(i + 4, !0), o = n.getUint32(i + 8, !0), a = new Uint8Array(o);
						a.set(new Uint8Array(n.buffer, n.byteOffset + i + 12, o));
						const c = new TextDecoder().decode(a);
						s && e.bindAttribLocation(s, r, c);
						return;
					}
					case 777: {
						const s = n.getUint32(i, !0), r = t.programs.get(s);
						r && e.deleteProgram(r), t.programs.delete(s);
						return;
					}
					case v: {
						const s = t.uniformLocations.get(n.getInt32(i, !0)) ?? null;
						e.uniform1i(s, n.getInt32(i + 4, !0));
						return;
					}
					case x: {
						const s = t.uniformLocations.get(n.getInt32(i, !0)) ?? null;
						e.uniform1f(s, n.getFloat32(i + 4, !0));
						return;
					}
					case _: {
						const s = t.uniformLocations.get(n.getInt32(i, !0)) ?? null;
						e.uniform2f(s, n.getFloat32(i + 4, !0), n.getFloat32(i + 8, !0));
						return;
					}
					case P: {
						const s = t.uniformLocations.get(n.getInt32(i, !0)) ?? null;
						e.uniform3f(s, n.getFloat32(i + 4, !0), n.getFloat32(i + 8, !0), n.getFloat32(i + 12, !0));
						return;
					}
					case B: {
						const s = t.uniformLocations.get(n.getInt32(i, !0)) ?? null;
						e.uniform4f(s, n.getFloat32(i + 4, !0), n.getFloat32(i + 8, !0), n.getFloat32(i + 12, !0), n.getFloat32(i + 16, !0));
						return;
					}
					case U: {
						const s = t.uniformLocations.get(n.getInt32(i, !0)) ?? null, r = n.getUint32(i + 4, !0), o = 0 !== n.getUint32(i + 8, !0), a = new Float32Array(n.buffer, n.byteOffset + i + 12, 16 * r);
						e.uniformMatrix4fv(s, o, a);
						return;
					}
					case A: {
						const s = t.uniformLocations.get(n.getInt32(i, !0)) ?? null, r = n.getUint32(i + 4, !0), o = new Float32Array(n.buffer, n.byteOffset + i + 8, 4 * r);
						e.uniform4fv(s, o);
						return;
					}
					case S:
						e.enableVertexAttribArray(n.getUint32(i, !0));
						return;
					case M:
						e.disableVertexAttribArray(n.getUint32(i, !0));
						return;
					case E: {
						const t = n.getUint32(i, !0), s = n.getInt32(i + 4, !0), r = n.getUint32(i + 8, !0), o = 0 !== n.getUint32(i + 12, !0), a = n.getInt32(i + 16, !0), c = n.getInt32(i + 20, !0);
						e.vertexAttribPointer(t, s, r, o, a, c);
						return;
					}
					case C:
						e.drawArrays(n.getUint32(i, !0), n.getInt32(i + 4, !0), n.getInt32(i + 8, !0));
						return;
					case T:
						e.drawElements(n.getUint32(i, !0), n.getInt32(i + 4, !0), n.getUint32(i + 8, !0), n.getUint32(i + 12, !0));
						return;
					case z: {
						const s = n.getUint32(i, !0);
						for (let r = 0; r < s; r++) {
							const s = n.getUint32(i + 4 + 4 * r, !0), o = e.createVertexArray();
							o && t.vaos.set(s, o);
						}
						return;
					}
					case O: {
						const s = n.getUint32(i, !0);
						for (let r = 0; r < s; r++) {
							const s = n.getUint32(i + 4 + 4 * r, !0), o = t.vaos.get(s);
							o && e.deleteVertexArray(o), t.vaos.delete(s);
						}
						return;
					}
					case R: {
						const s = t.vaos.get(n.getUint32(i, !0)) ?? null;
						e.bindVertexArray(s), t.shadow.vao = s;
						return;
					}
					case F: {
						const s = n.getUint32(i, !0);
						for (let r = 0; r < s; r++) {
							const s = n.getUint32(i + 4 + 4 * r, !0), o = e.createFramebuffer();
							o && t.fbos.set(s, o);
						}
						return;
					}
					case L: {
						const s = n.getUint32(i, !0), r = t.fbos.get(n.getUint32(i + 4, !0)) ?? null;
						e.bindFramebuffer(s, r), 36008 !== s && (t.shadow.fbo = r);
						return;
					}
					case N: {
						const s = n.getUint32(i, !0), r = n.getUint32(i + 4, !0), o = n.getUint32(i + 8, !0), a = t.textures.get(n.getUint32(i + 12, !0)) ?? null, c = n.getInt32(i + 16, !0);
						e.framebufferTexture2D(s, r, o, a, c);
						return;
					}
					case $: {
						const s = n.getUint32(i, !0);
						for (let r = 0; r < s; r++) {
							const s = n.getUint32(i + 4 + 4 * r, !0), o = e.createRenderbuffer();
							o && t.rbos.set(s, o);
						}
						return;
					}
					case D:
						e.bindRenderbuffer(n.getUint32(i, !0), t.rbos.get(n.getUint32(i + 4, !0)) ?? null);
						return;
					case W:
						e.renderbufferStorage(n.getUint32(i, !0), n.getUint32(i + 4, !0), n.getInt32(i + 8, !0), n.getInt32(i + 12, !0));
						return;
					case K: {
						const s = n.getUint32(i, !0), r = n.getUint32(i + 4, !0), o = n.getUint32(i + 8, !0), a = t.rbos.get(n.getUint32(i + 12, !0)) ?? null;
						e.framebufferRenderbuffer(s, r, o, a);
						return;
					}
					default: throw new Error(`gl bridge: unknown op 0x${s.toString(16).padStart(4, "0")} at offset ${i - 4}`);
				}
			}(e.gl, e, t, 0, n), 0;
		} catch {
			return -5;
		}
	}) : 0;
}
function H(e, t, n, i) {
	if (!function(e, t, n) {
		return Number.isSafeInteger(e) && Number.isSafeInteger(t) && e >= 0 && t >= 0 && e <= n && t <= n - e;
	}(t, n, e.byteLength)) return -22;
	const s = new DataView(e.buffer, e.byteOffset + t, n);
	let r = 0;
	for (; r < n;) {
		if (n - r < 4) return -22;
		const e = s.getUint16(r, !0), t = s.getUint16(r + 2, !0), o = r + 4, a = o + t;
		if (a > n) return -22;
		const c = new DataView(s.buffer, s.byteOffset + o, t);
		if (!X(e, c)) return -22;
		const l = i(c, e);
		if (0 !== l) return l;
		r = a;
	}
	return 0;
}
function q(e, t) {
	return e.byteLength === t;
}
function G(e, t, n) {
	if (e.byteLength < n + 4) return !1;
	const i = e.getUint32(n, !0);
	return e.byteLength === t + i;
}
function j(e, t, n, i) {
	if (e.byteLength < n + 4 || e.byteOffset % 4 != 0) return !1;
	const s = e.getUint32(n, !0);
	return e.byteLength === t + s * i * 4;
}
function X(e, t) {
	switch (e) {
		case 1:
		case 5:
		case 6:
		case 8:
		case 9:
		case 10:
		case 11:
		case 518:
		case 519:
		case 770:
		case 771:
		case 772:
		case 774:
		case 775:
		case 777:
		case S:
		case M:
		case R: return q(t, 4);
		case 7:
		case 12:
		case 258:
		case 514:
		case 768:
		case 773:
		case v:
		case x:
		case L:
		case D: return q(t, 8);
		case 517:
		case _:
		case C: return q(t, 12);
		case 2:
		case 3:
		case 4:
		case P:
		case T:
		case W:
		case K: return q(t, 16);
		case B:
		case N: return q(t, 20);
		case E: return q(t, 24);
		case 256:
		case 257:
		case 512:
		case 513:
		case z:
		case O:
		case F:
		case $: return function(e) {
			if (e.byteLength < 4) return !1;
			const t = e.getUint32(0, !0);
			return e.byteLength === 4 + 4 * t;
		}(t);
		case 259: return G(t, 12, 4);
		case 260: return G(t, 12, 8);
		case 515:
		case 516: return G(t, 36, 32);
		case 769: return G(t, 8, 4);
		case 776: return G(t, 12, 8);
		case U: return j(t, 12, 4, 16);
		case A: return j(t, 8, 4, 4);
		default: return !1;
	}
}
var Y = class {
	isCompositor;
	compositor = [];
	clients = [];
	byKey = /* @__PURE__ */ new Map();
	constructor(e = (e) => 2 === e) {
		this.isCompositor = e;
	}
	enqueue(e, t) {
		const n = `${e.pid}:${e.contextId ?? "_"}`;
		let i = this.byKey.get(n);
		i || (i = {
			key: n,
			binding: e,
			frames: []
		}, this.byKey.set(n, i), (this.isCompositor(e.pid) ? this.compositor : this.clients).push(i)), i.frames.push(t);
	}
	pickNext() {
		for (; this.compositor.length > 0;) {
			const e = this.compositor[0];
			if (e.frames.length > 0) return e;
			this.compositor.shift(), this.byKey.delete(e.key);
		}
		for (; this.clients.length > 0;) {
			const e = this.clients[0];
			if (e.frames.length > 0) return this.clients.shift(), this.clients.push(e), e;
			this.clients.shift(), this.byKey.delete(e.key);
		}
		return null;
	}
	releaseIfEmpty(e) {
		if (e.frames.length > 0) return;
		this.byKey.delete(e.key);
		const t = this.isCompositor(e.binding.pid) ? this.compositor : this.clients, n = t.indexOf(e);
		n >= 0 && t.splice(n, 1);
	}
	isEmpty() {
		return 0 === this.byKey.size;
	}
}, J = class {
	gl;
	current = null;
	constructor(e) {
		this.gl = e;
	}
	switchTo(e) {
		if (this.current === e) return;
		const t = e.shadow, n = this.gl;
		n.bindVertexArray(t.vao), n.bindFramebuffer(36160, t.fbo), n.viewport(...t.viewport), t.scissor.enabled ? n.enable(y) : n.disable(y), n.scissor(...t.scissor.rect), n.clearColor(...t.clearColor), t.depthTestEnabled ? n.enable(u) : n.disable(u), n.depthFunc(t.depthFunc), t.stencilTestEnabled ? n.enable(g) : n.disable(g), t.blendEnabled ? n.enable(p) : n.disable(p), n.blendFuncSeparate(t.blendFunc.srcRGB, t.blendFunc.dstRGB, t.blendFunc.srcA, t.blendFunc.dstA), t.cullFaceEnabled ? n.enable(m) : n.disable(m), n.cullFace(t.cullFace), n.frontFace(t.frontFace), t.polygonOffsetFillEnabled ? n.enable(w) : n.disable(w), n.useProgram(t.currentProgram);
		for (let i = 0; i < t.textureUnits.length; i++) {
			const e = t.textureUnits[i];
			e && (n.activeTexture(b + i), n.bindTexture(3553, e));
		}
		n.activeTexture(b + t.activeTexture), n.pixelStorei(3317, t.unpackAlignment), n.pixelStorei(3333, t.packAlignment), this.current = e;
	}
	invalidateCurrent() {
		this.current = null;
	}
};
const Z = "__abi_version", Q = {
	atomics_wait: 2,
	atomics_wait_async: 4,
	shared_array_buffer: 1
}, ee = [
	"__abi_version",
	"kernel_alloc_scratch",
	"kernel_create_process",
	"kernel_create_process_with_stdio",
	"kernel_get_parent_pid",
	"kernel_handle_channel",
	"kernel_host_adapter_manifest_len",
	"kernel_host_adapter_manifest_ptr",
	"kernel_mark_process_signaled",
	"kernel_reap_exited_child",
	"kernel_remove_process",
	"kernel_wait4_poll"
], te = {
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
}, ne = 65536, ie = 65608, se = 65560, re = 211, oe = 212, ae = 213, ce = 500, le = 386, he = 1, de = 2, fe = 3, ue = 4, ge = 6, pe = 10, me = 11, ye = 12, we = 19, be = 22, ke = 24, Ie = 25, ve = 34, xe = 35, _e = 41, Pe = 46, Be = 47, Ue = 48, Ae = 53, Se = 54, Me = 55, Ee = 56, Ce = 60, Te = 62, ze = 63, Oe = 64, Re = 65, Fe = 68, Le = 69, Ne = 72, $e = 81, De = 82, We = 90, Ke = 92, Ve = 93, He = 97, qe = 102, Ge = 103, je = 109, Xe = 124, Ye = 126, Je = 137, Ze = 138, Qe = 139, et = 200, tt = 201, nt = 207, it = 239, st = 240, rt = 241, ot = 251, at = 252, ct = 278, lt = 288, ht = 294, dt = 295, ft = 296, ut = 333, gt = 334, pt = 343, mt = 345, yt = 346, wt = 378, bt = 379, kt = 384, It = 387, vt = 415, xt = {
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
}, _t = 65536;
function Pt(e, t) {
	let n = 0, i = 0, s = t;
	for (;;) {
		const t = e[s++];
		if (n |= (127 & t) << i, !(128 & t)) break;
		i += 7;
	}
	return [n, s - t];
}
function Bt(e, t, n) {
	const [i, s] = Pt(e, t);
	t += s + i;
	const [r, o] = Pt(e, t);
	t += o + r;
	const a = e[t++];
	if (0 === a) {
		n.funcImports++;
		const [, i] = Pt(e, t);
		t += i;
	} else if (1 === a) {
		t++;
		const n = e[t++], [, i] = Pt(e, t);
		if (t += i, 1 & n) {
			const [, n] = Pt(e, t);
			t += n;
		}
	} else if (2 === a) {
		const n = e[t++], [, i] = Pt(e, t);
		if (t += i, 1 & n) {
			const [, n] = Pt(e, t);
			t += n;
		}
	} else 3 === a && (n.globalImports++, t += 2);
	return t;
}
function Ut(e, t) {
	t++, t++;
	const n = e[t++];
	if (65 === n) {
		const [n] = function(e, t) {
			let n = 0, i = 0, s = t, r = 0;
			for (; r = e[s++], n |= (127 & r) << i, i += 7, 128 & r;);
			return i < 32 && 64 & r && (n |= -1 << i), [n, s - t];
		}(e, t);
		return BigInt.asUintN(32, BigInt(n));
	}
	if (66 === n) {
		const [n] = function(e, t) {
			let n = 0n, i = 0n, s = t, r = 0;
			for (; r = e[s++], n |= BigInt(127 & r) << i, i += 7n, 128 & r;);
			return i < 64n && 64 & r && (n |= -1n << i), [n, s - t];
		}(e, t);
		return BigInt.asUintN(64, n);
	}
	return null;
}
function At(e, t) {
	for (t += 2; 11 !== e[t];) t++;
	return t + 1;
}
function St(e) {
	const t = new Uint8Array(e);
	if (t.length < 8) return 4;
	function n(e, t) {
		let n = 0, i = 0, s = t;
		for (;;) {
			const t = e[s++];
			if (n |= (127 & t) << i, !(128 & t)) break;
			i += 7;
		}
		return [n, s - t];
	}
	let i = 8;
	for (; i < t.length;) {
		const e = t[i], [s, r] = n(t, i + 1), o = i + 1 + r;
		if (2 === e) {
			let e = o;
			const [i, s] = n(t, e);
			e += s;
			for (let r = 0; r < i; r++) {
				const [i, s] = n(t, e);
				e += s + i;
				const [r, o] = n(t, e);
				e += o + r;
				const a = t[e++];
				if (2 === a) return 4 & t[e] ? 8 : 4;
				if (0 === a) {
					const [, i] = n(t, e);
					e += i;
				} else if (1 === a) {
					e++;
					const i = t[e++], [, s] = n(t, e);
					if (e += s, 1 & i) {
						const [, i] = n(t, e);
						e += i;
					}
				} else 3 === a && (e += 2);
			}
			break;
		}
		i = o + s;
	}
	return 4;
}
function Mt(e) {
	const t = e instanceof ArrayBuffer ? new Uint8Array(e) : new Uint8Array(e.buffer, e.byteOffset, e.byteLength), n = new Uint8Array(t.byteLength);
	return n.set(t), n.buffer;
}
function Et(e, t) {
	return void 0 === e || !Number.isFinite(e) || e < 1 ? t : Ct(Math.trunc(e));
}
function Ct(e) {
	return Math.max(1, Math.min(65535, Math.trunc(e)));
}
function Tt(e) {
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
var zt = class e {
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
	bos = new d();
	kms = new f(this.bos);
	gl = new I();
	gl_submit_queue = new Y((e) => this.kms.isMasterPid(e));
	gl_muxers = /* @__PURE__ */ new WeakMap();
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
		this.config = e, this.io = t, this.callbacks = n ?? {}, this.bos.setProcessMemoryResolver((e) => this.callbacks.getProcessMemory?.(e));
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
		const i = this.instance?.exports?.kernel_inject_mouse_event;
		i && i(e, t, n);
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
		const i = Math.min(t.byteLength, e.AUDIO_SCRATCH_SIZE), s = n(this.toKernelPtr(this.audioScratchOffset), i);
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
		this.kernelPtrWidth = St(Mt(e));
		const t = this.createKernelMemory();
		this.memory = t;
		const n = this.buildImportObject(t), i = await WebAssembly.compile(e);
		this.instance = await WebAssembly.instantiate(i, n);
	}
	async initWithMemory(e, t) {
		this.kernelPtrWidth = St(Mt(e)), this.memory = t;
		const n = this.buildImportObject(t), i = await WebAssembly.compile(e);
		this.instance = await WebAssembly.instantiate(i, n);
	}
	buildImportObject(e) {
		return { env: {
			memory: e,
			host_debug_log: (t, n) => {
				const i = new Uint8Array(e.buffer, Number(t), n), s = new TextDecoder().decode(i.slice());
				console.log(`[KERNEL] ${s}`);
			},
			host_open: (e, t, n, i) => this.hostOpen(Number(e), t, n, i),
			host_close: (e) => this.hostClose(e),
			host_read: (e, t, n) => this.hostRead(e, Number(t), n),
			host_write: (e, t, n) => this.hostWrite(e, Number(t), n),
			host_seek: (e, t, n, i) => this.hostSeek(e, t, n, i),
			host_fstat: (e, t) => this.hostFstat(e, Number(t)),
			host_stat: (e, t, n) => this.hostStat(Number(e), t, Number(n)),
			host_lstat: (e, t, n) => this.hostLstat(Number(e), t, Number(n)),
			host_statfs: (e, t, n) => this.hostStatfs(Number(e), t, Number(n)),
			host_mkdir: (e, t, n) => this.hostMkdir(Number(e), t, n),
			host_rmdir: (e, t) => this.hostRmdir(Number(e), t),
			host_unlink: (e, t) => this.hostUnlink(Number(e), t),
			host_rename: (e, t, n, i) => this.hostRename(Number(e), t, Number(n), i),
			host_link: (e, t, n, i) => this.hostLink(Number(e), t, Number(n), i),
			host_symlink: (e, t, n, i) => this.hostSymlink(Number(e), t, Number(n), i),
			host_readlink: (e, t, n, i) => this.hostReadlink(Number(e), t, Number(n), i),
			host_chmod: (e, t, n) => this.hostChmod(Number(e), t, n),
			host_chown: (e, t, n, i) => this.hostChown(Number(e), t, n, i),
			host_access: (e, t, n) => this.hostAccess(Number(e), t, n),
			host_opendir: (e, t) => this.hostOpendir(Number(e), t),
			host_readdir: (e, t, n, i) => this.hostReaddir(e, Number(t), Number(n), i),
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
			host_set_posix_timer: (e, t, n, i, s, r) => {
				const o = 4294967296 * (i >>> 0) + (n >>> 0), a = 4294967296 * (r >>> 0) + (s >>> 0);
				return this.hostSetPosixTimer(e, t, o, a);
			},
			host_sigsuspend_wait: () => this.hostSigsuspendWait(),
			host_call_signal_handler: (e, t, n) => {
				const i = this.programFuncTable ?? this.instance?.exports.__indirect_function_table;
				if (!i) return -22;
				const s = i.get(e);
				if (s) try {
					return 4 & n ? s(t, 0, 0) : s(t), 0;
				} catch (r) {
					return -5;
				}
				return -22;
			},
			host_getrandom: (e, t) => {
				try {
					const n = this.getMemoryBuffer(), i = Number(e), s = n.subarray(i, i + t);
					if (void 0 !== globalThis.crypto && globalThis.crypto.getRandomValues) {
						const e = new Uint8Array(t);
						globalThis.crypto.getRandomValues(e), s.set(e);
					} else for (let e = 0; e < t; e++) s[e] = 256 * Math.random() | 0;
					return t;
				} catch {
					return -5;
				}
			},
			host_utimensat: (e, t, n, i, s, r) => this.hostUtimensat(Number(e), t, n, i, s, r),
			host_waitpid: (e, t, n) => this.hostWaitpid(e, t, Number(n)),
			host_net_connect: (e, t, n, i) => this.hostNetConnect(e, Number(t), n, i),
			host_net_send: (e, t, n, i) => this.hostNetSend(e, Number(t), n, i),
			host_net_recv: (e, t, n, i) => this.hostNetRecv(e, Number(t), n, i),
			host_net_poll: (e, t) => this.hostNetPoll(e, t),
			host_net_connect_status: (e) => this.hostNetConnectStatus(e),
			host_net_close: (e) => this.hostNetClose(e),
			host_net_listen: (e, t, n, i, s, r) => this.hostNetListen(e, t, n, i, s, r),
			host_udp_bind: (e, t, n, i, s, r) => this.hostUdpBind(e, t, n, i, s, r),
			host_udp_unbind: (e) => this.hostUdpUnbind(e),
			host_udp_send: (e, t, n, i, s, r, o, a, c, l, h, d) => this.hostUdpSend(e, t, n, i, s, r, o, a, c, l, Number(h), d),
			host_getaddrinfo: (e, t, n, i) => this.hostGetaddrinfo(Number(e), t, Number(n), i),
			host_fcntl_lock: (e, t, n, i, s, r, o, a, c, l) => this.hostFcntlLock(Number(e), t, n, i, s, r, o, a, c, Number(l)),
			host_fork: () => this.hostFork(),
			host_futex_wait: (e, t, n, i) => this.hostFutexWait(Number(e), t, n, i),
			host_futex_wake: (e, t) => this.hostFutexWake(Number(e), t),
			host_clone: (e, t, n, i, s) => this.hostClone(Number(e), Number(t), Number(n), Number(i), Number(s)),
			host_is_thread_worker: () => this.isThreadWorker ? 1 : 0,
			host_bind_framebuffer: (e, t, n, i, s, r, o) => {
				this.framebuffers.bind({
					pid: e,
					addr: Number(t),
					len: Number(n),
					w: i,
					h: s,
					stride: r,
					fmt: "BGRA32"
				});
			},
			host_unbind_framebuffer: (e) => {
				this.framebuffers.unbind(e);
			},
			host_fb_write: (e, t, n, i) => {
				this.framebuffers.fbWrite(e, Number(t), this.readKernelBytes(Number(n), Number(i)));
			},
			host_gbm_bo_create: (e, t, n, i, s, r) => (this.bos.create({
				pid: e,
				bo_id: t,
				size: Number(n),
				w: i,
				h: s,
				stride: r
			}), 0),
			host_gbm_bo_destroy: (e, t) => {
				this.bos.destroy(e, t);
			},
			host_gbm_bo_bind: (e, t, n, i) => this.bos.bind(e, t, Number(n), Number(i)),
			host_gbm_bo_unbind: (e, t, n, i) => {
				this.bos.unbind(e, t);
			},
			host_gl_bind: (e, t, n) => {
				this.gl.bind({
					pid: e,
					cmdbufAddr: Number(t),
					cmdbufLen: Number(n)
				});
			},
			host_gl_unbind: (e) => {
				this.gl.unbind(e);
			},
			host_gl_create_context: (e, t, n, i) => {
				const s = this.gl.get(e);
				if (!s) return;
				if (s.contextId = t, s.forward) return void s.forward.onCreateContext();
				if (!s.canvas) {
					const t = this.kms.masterCrtcForPid(e);
					if (null != t) {
						const n = this.callbacks.getKmsCanvas?.(t);
						if (n) {
							const i = this.kms.currentFb(t);
							!i || n.width === i.width && n.height === i.height || (n.width = i.width, n.height = i.height), this.gl.attachCanvas(e, n), s.canvas = n, this.callbacks.markKmsCanvasGlOwned?.(t);
						}
					}
					if (!s.canvas) return;
				}
				const r = s.canvas.getContext("webgl2", {
					antialias: !1,
					premultipliedAlpha: !1,
					preserveDrawingBuffer: !0
				});
				r && (r.getExtension("EXT_color_buffer_float"), r.getExtension("OES_texture_float_linear"), r.getExtension("EXT_float_blend")), s.gl = r;
			},
			host_gl_destroy_context: (e, t) => {
				const n = this.gl.get(e);
				n && (n.gl = null, n.contextId = null, n.currentProgram = null, n.forward && n.forward.onDestroyContext());
			},
			host_gl_create_surface: (e, t, n, i) => {
				const s = this.gl.get(e);
				s && (s.surfaceId = t);
			},
			host_gl_destroy_surface: (e, t) => {
				const n = this.gl.get(e);
				n && (n.surfaceId = null);
			},
			host_gl_make_current: (e, t, n) => {},
			host_gl_submit: (e, t, n) => {
				const i = this.gl.get(e);
				if (!i) return -5;
				if (!i.forward && !i.gl) return 0;
				if (!i.cmdbufView) {
					const t = this.callbacks.getProcessMemory?.(e);
					if (!t) return -5;
					try {
						i.cmdbufView = new Uint8Array(t.buffer, i.cmdbufAddr, i.cmdbufLen);
					} catch {
						return -5;
					}
				}
				if (i.forward) {
					const e = Number(t), s = Number(n), r = function(e, t, n) {
						return H(e, t, n, () => 0);
					}(i.cmdbufView, e, s);
					return r < 0 ? r : (i.forward.onSubmit(i.cmdbufView.slice(e, e + s)), 0);
				}
				return this.gl_submit_queue.enqueue(i, {
					memorySab: i.cmdbufView.buffer,
					off: Number(t),
					len: Number(n)
				}), function(e, t, n) {
					for (;;) {
						const i = e.pickNext();
						if (!i) return 0;
						const s = i.frames.shift(), r = t(i.binding);
						r && r.switchTo(i.binding);
						const o = n(i.binding, s.off, s.len);
						if (e.releaseIfEmpty(i), "number" == typeof o && o < 0) return o;
					}
				}(this.gl_submit_queue, (e) => {
					if (!e.gl) return null;
					let t = this.gl_muxers.get(e.gl);
					return t || (t = new J(e.gl), this.gl_muxers.set(e.gl, t)), t;
				}, (e, t, n) => V(e, t, n));
			},
			host_gl_present: (e) => {},
			host_gl_query: (e, t, n, i, s, r) => {
				const o = this.gl.get(e);
				if (!o || !o.gl) return -1;
				const a = i > 0n ? this.readKernelBytes(Number(n), Number(i)) : new Uint8Array(0), c = new Uint8Array(Number(r)), l = function(e, t, n, i) {
					if (!e.gl) return -1;
					const s = e.gl, r = new DataView(n.buffer, n.byteOffset, n.byteLength), o = new DataView(i.buffer, i.byteOffset, i.byteLength);
					switch (t) {
						case 1: return i.byteLength < 4 ? -22 : (o.setUint32(0, s.getError(), !0), 4);
						case 2: {
							if (n.byteLength < 4) return -22;
							const e = r.getUint32(0, !0), t = s.getParameter(e) ?? "", a = new TextEncoder().encode(t), c = 4 + a.byteLength;
							return i.byteLength < c ? -22 : (o.setUint32(0, a.byteLength, !0), i.set(a, 4), c);
						}
						case 3: {
							if (n.byteLength < 4 || i.byteLength < 4) return -22;
							const e = r.getUint32(0, !0), t = s.getParameter(e);
							return o.setInt32(0, Number(t ?? 0), !0), 4;
						}
						case 4: {
							if (n.byteLength < 4 || i.byteLength < 4) return -22;
							const e = r.getUint32(0, !0), t = s.getParameter(e);
							return o.setFloat32(0, Number(t ?? 0), !0), 4;
						}
						case 5: {
							if (n.byteLength < 8 || i.byteLength < 4) return -22;
							const t = r.getUint32(0, !0), a = r.getUint32(4, !0);
							if (n.byteLength < 8 + a) return -22;
							const c = e.programs.get(t), l = new TextDecoder().decode(n.subarray(8, 8 + a)), h = c ? s.getUniformLocation(c, l) : null;
							if (h) {
								const t = ++e.nextUniformLoc;
								e.uniformLocations.set(t, h), o.setInt32(0, t, !0);
							} else o.setInt32(0, -1, !0);
							return 4;
						}
						case 6: {
							if (n.byteLength < 8 || i.byteLength < 4) return -22;
							const t = r.getUint32(0, !0), a = r.getUint32(4, !0);
							if (n.byteLength < 8 + a) return -22;
							const c = e.programs.get(t), l = new TextDecoder().decode(n.subarray(8, 8 + a)), h = c ? s.getAttribLocation(c, l) : -1;
							return o.setInt32(0, h, !0), 4;
						}
						case 7: {
							if (n.byteLength < 8 || i.byteLength < 4) return -22;
							const t = e.shaders.get(r.getUint32(0, !0));
							if (!t) return o.setInt32(0, 0, !0), 4;
							const a = s.getShaderParameter(t, r.getUint32(4, !0));
							return o.setInt32(0, "boolean" == typeof a ? a ? 1 : 0 : Number(a ?? 0), !0), 4;
						}
						case 8: {
							if (n.byteLength < 4) return -22;
							const t = e.shaders.get(r.getUint32(0, !0)), a = (t && s.getShaderInfoLog(t)) ?? "", c = new TextEncoder().encode(a), l = 4 + c.byteLength;
							return i.byteLength < l ? (o.setUint32(0, 0, !0), 4) : (o.setUint32(0, c.byteLength, !0), i.set(c, 4), l);
						}
						case 9: {
							if (n.byteLength < 8 || i.byteLength < 4) return -22;
							const t = e.programs.get(r.getUint32(0, !0));
							if (!t) return o.setInt32(0, 0, !0), 4;
							const a = s.getProgramParameter(t, r.getUint32(4, !0));
							return o.setInt32(0, "boolean" == typeof a ? a ? 1 : 0 : Number(a ?? 0), !0), 4;
						}
						case 10: {
							if (n.byteLength < 4) return -22;
							const t = e.programs.get(r.getUint32(0, !0)), a = (t && s.getProgramInfoLog(t)) ?? "", c = new TextEncoder().encode(a), l = 4 + c.byteLength;
							return i.byteLength < l ? (o.setUint32(0, 0, !0), 4) : (o.setUint32(0, c.byteLength, !0), i.set(c, 4), l);
						}
						case 11: {
							if (n.byteLength < 24) return -22;
							const e = r.getInt32(0, !0), t = r.getInt32(4, !0), o = r.getInt32(8, !0), a = r.getInt32(12, !0), c = r.getUint32(16, !0), l = r.getUint32(20, !0);
							let h = i;
							return 5126 === l ? h = new Float32Array(i.buffer, i.byteOffset, i.byteLength / 4 | 0) : 5131 === l && (h = new Uint16Array(i.buffer, i.byteOffset, i.byteLength / 2 | 0)), s.readPixels(e, t, o, a, c, l, h), i.byteLength;
						}
						case 12: {
							if (n.byteLength < 4 || i.byteLength < 4) return -22;
							const e = s.checkFramebufferStatus(r.getUint32(0, !0));
							return o.setUint32(0, e, !0), 4;
						}
						default: return -22;
					}
				}(o, t, a, c);
				return l > 0 && 0 !== Number(s) && this.writeKernelBytes(Number(s), c.subarray(0, l)), l;
			},
			host_kms_set_master: (e) => {
				this.kms.setMasterPid(e);
			},
			host_kms_drop_master: (e) => {
				this.kms.dropMaster();
			},
			host_proc_write_bytes: (e, t, n, i) => {
				const s = this.callbacks.getProcessMemory?.(e);
				if (!s) return -14;
				try {
					const e = this.readKernelBytes(Number(n), i);
					return new Uint8Array(s.buffer, Number(t), i).set(e), 0;
				} catch {
					return -14;
				}
			},
			host_proc_read_bytes: (e, t, n, i) => {
				const s = this.callbacks.getProcessMemory?.(e);
				if (!s) return -14;
				try {
					const e = new Uint8Array(s.buffer, Number(t), i), r = new Uint8Array(i);
					return r.set(e), this.writeKernelBytes(Number(n), r), 0;
				} catch {
					return -14;
				}
			},
			host_kms_mode_info: (e, t) => {
				const n = this.callbacks.getKmsCanvas?.(e);
				this.writeKernelBytes(Number(t), function(e, t, n = 60) {
					const i = Et(e, 1920), s = Et(t, 1080), r = Ct(i + 16), o = Ct(i + 48), a = Ct(i + 160), c = Ct(s + 3), l = Ct(s + 8), h = Ct(s + 45), d = Math.max(1, Math.min(4294967295, Math.round(a * h * n / 1e3))), f = new Uint8Array(68), u = new DataView(f.buffer);
					u.setUint32(0, d, !0), u.setUint16(4, i, !0), u.setUint16(6, r, !0), u.setUint16(8, o, !0), u.setUint16(10, a, !0), u.setUint16(12, 0, !0), u.setUint16(14, s, !0), u.setUint16(16, c, !0), u.setUint16(18, l, !0), u.setUint16(20, h, !0), u.setUint16(22, 0, !0), u.setUint32(24, n, !0), u.setUint32(28, 0, !0), u.setUint32(32, 9, !0);
					const g = `${i}x${s}`;
					for (let p = 0; p < Math.min(g.length, 31); p++) f[36 + p] = 255 & g.charCodeAt(p);
					return f;
				}(n?.width, n?.height));
			},
			host_kms_addfb: (e, t, n, i, s, r, o) => (this.kms.addFb({
				fb_id: t,
				bo_id: n,
				width: i,
				height: s,
				pixel_format: r,
				pitch: o
			}), 0),
			host_kms_rmfb: (e, t) => {
				this.kms.rmFb(t);
			},
			host_kms_set_fb: (e, t, n) => {
				this.kms.setFb(t, n);
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
	writeKernelBytes(e, t) {
		this.getMemoryBuffer().set(t, e);
	}
	hostOpen(e, t, n, i) {
		try {
			const s = this.getMemoryBuffer().slice(e, e + t), r = new TextDecoder().decode(s);
			return BigInt(this.io.open(r, n, i));
		} catch (s) {
			return BigInt(Tt(s));
		}
	}
	hostClose(e) {
		const t = Number(e), n = this.sharedPipes.get(t);
		if (n) return "read" === n.end ? n.pipe.closeRead() : n.pipe.closeWrite(), this.sharedPipes.delete(t), 0;
		if (t >= 0 && t <= 2) return 0;
		try {
			return this.io.close(t);
		} catch (i) {
			return Tt(i);
		}
	}
	hostRead(e, t, n) {
		const i = Number(e), s = this.sharedPipes.get(i);
		if (s) {
			const e = this.getMemoryBuffer(), i = new Uint8Array(e.buffer, t, n);
			return s.pipe.read(i);
		}
		if (0 === i) {
			if (this.callbacks.onStdin) {
				const e = this.callbacks.onStdin(n);
				if (null === e) return 0;
				if (0 === e.length) return -11;
				const i = this.getMemoryBuffer(), s = Math.min(e.length, n);
				return i.set(e.subarray(0, s), t), s;
			}
			return 0;
		}
		try {
			const e = this.getMemoryBuffer().subarray(t, t + n);
			return this.io.read(i, e, null, n);
		} catch (r) {
			return Tt(r);
		}
	}
	hostWrite(e, t, n) {
		const i = Number(e), s = this.getMemoryBuffer().slice(t, t + n), r = this.sharedPipes.get(i);
		if (r) return r.pipe.write(s);
		if (1 === i) return this.callbacks.onStdout ? this.callbacks.onStdout(s) : "undefined" != typeof process && process.stdout ? process.stdout.write(s) : console.log(new TextDecoder().decode(s)), n;
		if (2 === i) return this.callbacks.onStderr ? this.callbacks.onStderr(s) : "undefined" != typeof process && process.stderr ? process.stderr.write(s) : console.error(new TextDecoder().decode(s)), n;
		try {
			return this.io.write(i, s, null, n);
		} catch (o) {
			return Tt(o);
		}
	}
	hostSeek(e, t, n, i) {
		const s = Number(e), r = 4294967296 * n + (t >>> 0);
		try {
			return BigInt(this.io.seek(s, r, i));
		} catch (o) {
			return BigInt(Tt(o));
		}
	}
	hostFstat(e, t) {
		const n = Number(e);
		try {
			const e = this.io.fstat(n);
			return this.writeStatToMemory(t, e), 0;
		} catch (i) {
			return Tt(i);
		}
	}
	writeStatToMemory(e, t) {
		const n = this.getMemoryDataView();
		this.getMemoryBuffer().fill(0, e, e + 88), n.setBigUint64(e + 0, BigInt(t.dev), !0), n.setBigUint64(e + 8, BigInt(t.ino), !0), n.setUint32(e + 16, t.mode, !0), n.setUint32(e + 20, t.nlink, !0), n.setUint32(e + 24, t.uid, !0), n.setUint32(e + 28, t.gid, !0), n.setBigUint64(e + 32, BigInt(t.size), !0);
		const i = Math.floor(t.atimeMs / 1e3), s = Math.floor(t.atimeMs % 1e3 * 1e6);
		n.setBigUint64(e + 40, BigInt(i), !0), n.setUint32(e + 48, s, !0);
		const r = Math.floor(t.mtimeMs / 1e3), o = Math.floor(t.mtimeMs % 1e3 * 1e6);
		n.setBigUint64(e + 56, BigInt(r), !0), n.setUint32(e + 64, o, !0);
		const a = Math.floor(t.ctimeMs / 1e3), c = Math.floor(t.ctimeMs % 1e3 * 1e6);
		n.setBigUint64(e + 72, BigInt(a), !0), n.setUint32(e + 80, c, !0);
	}
	writeStatfsToMemory(e, t) {
		const n = this.getMemoryDataView();
		this.getMemoryBuffer().fill(0, e, e + 72);
		const i = (e) => Number.isFinite(e) ? Math.max(0, Math.floor(e)) >>> 0 : 0, s = (e) => !Number.isFinite(e) || e <= 0 ? 0n : BigInt(Math.min(Math.floor(e), Number.MAX_SAFE_INTEGER));
		n.setUint32(e + 0, i(t.type), !0), n.setUint32(e + 4, i(t.bsize), !0), n.setBigUint64(e + 8, s(t.blocks), !0), n.setBigUint64(e + 16, s(t.bfree), !0), n.setBigUint64(e + 24, s(t.bavail), !0), n.setBigUint64(e + 32, s(t.files), !0), n.setBigUint64(e + 40, s(t.ffree), !0), n.setBigUint64(e + 48, s(t.fsid), !0), n.setUint32(e + 56, i(t.namelen), !0), n.setUint32(e + 60, i(t.frsize), !0), n.setUint32(e + 64, i(t.flags), !0);
	}
	readPathFromMemory(e, t) {
		const n = this.getMemoryBuffer().slice(e, e + t);
		return new TextDecoder().decode(n);
	}
	hostStat(e, t, n) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.io.stat(i);
			return this.writeStatToMemory(n, s), 0;
		} catch (i) {
			return Tt(i);
		}
	}
	hostLstat(e, t, n) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.io.lstat(i);
			return this.writeStatToMemory(n, s), 0;
		} catch (i) {
			return Tt(i);
		}
	}
	hostStatfs(e, t, n) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.io.statfs(i);
			return this.writeStatfsToMemory(n, s), 0;
		} catch (i) {
			return Tt(i);
		}
	}
	hostMkdir(e, t, n) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.mkdir(i, n), 0;
		} catch (i) {
			return Tt(i);
		}
	}
	hostRmdir(e, t) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.rmdir(n), 0;
		} catch (n) {
			return Tt(n);
		}
	}
	hostUnlink(e, t) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.unlink(n), 0;
		} catch (n) {
			return Tt(n);
		}
	}
	hostRename(e, t, n, i) {
		try {
			const s = this.readPathFromMemory(e, t), r = this.readPathFromMemory(n, i);
			return this.io.rename(s, r), 0;
		} catch (s) {
			return Tt(s);
		}
	}
	hostLink(e, t, n, i) {
		try {
			const s = this.readPathFromMemory(e, t), r = this.readPathFromMemory(n, i);
			return this.io.link(s, r), 0;
		} catch (s) {
			return Tt(s);
		}
	}
	hostSymlink(e, t, n, i) {
		try {
			const s = this.readPathFromMemory(e, t), r = this.readPathFromMemory(n, i);
			return this.io.symlink(s, r), 0;
		} catch (s) {
			return Tt(s);
		}
	}
	hostReadlink(e, t, n, i) {
		try {
			const s = this.readPathFromMemory(e, t), r = this.io.readlink(s), o = new TextEncoder().encode(r), a = Math.min(o.length, i);
			return this.getMemoryBuffer().set(o.subarray(0, a), n), a;
		} catch (s) {
			return Tt(s);
		}
	}
	hostChmod(e, t, n) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.chmod(i, n), 0;
		} catch (i) {
			return Tt(i);
		}
	}
	hostChown(e, t, n, i) {
		try {
			const s = this.readPathFromMemory(e, t);
			return this.io.chown(s, n, i), 0;
		} catch (s) {
			return Tt(s);
		}
	}
	hostAccess(e, t, n) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.access(i, n), 0;
		} catch (i) {
			return Tt(i);
		}
	}
	hostUtimensat(e, t, n, i, s, r) {
		try {
			const o = this.readPathFromMemory(e, t);
			return this.io.utimensat(o, Number(n), Number(i), Number(s), Number(r)), 0;
		} catch {
			return -1;
		}
	}
	hostWaitpid(e, t, n) {
		if (this.waitpidSab && this.callbacks.onWaitpid) {
			const i = new Int32Array(this.waitpidSab);
			Atomics.store(i, 0, 0), Atomics.store(i, 1, 0), Atomics.store(i, 2, 0), this.callbacks.onWaitpid(e, t), Atomics.wait(i, 0, 0);
			const s = Atomics.load(i, 1), r = Atomics.load(i, 2);
			return s < 0 || 0 !== n && this.memory && new DataView(this.memory.buffer).setInt32(n, r, !0), s;
		}
		if (!this.io.waitpid) return -10;
		try {
			const i = this.io.waitpid(e, t);
			return 0 !== n && this.memory && new DataView(this.memory.buffer).setInt32(n, i.status, !0), i.pid;
		} catch {
			return -10;
		}
	}
	hostOpendir(e, t) {
		try {
			const n = this.readPathFromMemory(e, t);
			return BigInt(this.io.opendir(n));
		} catch (n) {
			return BigInt(Tt(n));
		}
	}
	hostReaddir(e, t, n, i) {
		try {
			const s = Number(e), r = this.io.readdir(s);
			if (null === r) return 0;
			const o = this.getMemoryDataView(), a = this.getMemoryBuffer(), c = new TextEncoder().encode(r.name), l = Math.min(c.length, i);
			return o.setBigUint64(t, BigInt(r.ino), !0), o.setUint32(t + 8, r.type, !0), o.setUint32(t + 12, l, !0), a.set(c.subarray(0, l), n), 1;
		} catch (s) {
			return Tt(s);
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
			const i = this.io.clockGettime(e), s = this.getMemoryDataView();
			return s.setBigInt64(t, BigInt(i.sec), !0), s.setBigInt64(n, BigInt(i.nsec), !0), 0;
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
			const n = this.getMemoryBuffer(), i = new TextDecoder().decode(n.slice(e, e + t));
			return this.callbacks.onExec(i);
		}
		return -2;
	}
	hostSetAlarm(e) {
		return this.callbacks.onAlarm ? this.callbacks.onAlarm(e) : 0;
	}
	hostSetPosixTimer(e, t, n, i) {
		return this.callbacks.onPosixTimer ? this.callbacks.onPosixTimer(e, t, n, i) : 0;
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
		const i = (0, this.instance.exports.kernel_socket)(e, t, n);
		if (i < 0) throw new Error("socket failed: errno " + -i);
		return i;
	}
	socketpair(e, t, n) {
		const i = this.instance.exports.kernel_socketpair, s = this.getMemoryDataView(), r = i(e, t, n, 4);
		if (r < 0) throw new Error("socketpair failed: errno " + -r);
		return [s.getInt32(4, !0), s.getInt32(8, !0)];
	}
	shutdown(e, t) {
		const n = (0, this.instance.exports.kernel_shutdown)(e, t);
		if (n < 0) throw new Error("shutdown failed: errno " + -n);
	}
	send(e, t, n = 0) {
		const i = this.instance.exports.kernel_send;
		this.getMemoryBuffer().set(t, 16);
		const s = i(e, 16, t.length, n);
		if (s < 0) throw new Error("send failed: errno " + -s);
		return s;
	}
	recv(e, t, n = 0) {
		const i = (0, this.instance.exports.kernel_recv)(e, 16, t, n);
		if (i < 0) throw new Error("recv failed: errno " + -i);
		return this.getMemoryBuffer().slice(16, 16 + i);
	}
	poll(e, t) {
		const n = this.instance.exports.kernel_poll, i = e.length, s = this.getMemoryDataView();
		for (let o = 0; o < i; o++) {
			const t = 16 + 8 * o;
			s.setInt32(t, e[o].fd, !0), s.setInt16(t + 4, e[o].events, !0), s.setInt16(t + 6, 0, !0);
		}
		const r = n(16, i, t);
		if (r < 0) throw new Error("poll failed: errno " + -r);
		return e.map((e, t) => ({
			fd: e.fd,
			events: e.events,
			revents: s.getInt16(16 + 8 * t + 6, !0)
		}));
	}
	getsockopt(e, t, n) {
		const i = this.instance.exports.kernel_getsockopt, s = this.getMemoryDataView(), r = i(e, t, n, 4);
		if (r < 0) throw new Error("getsockopt failed: errno " + -r);
		return s.getUint32(4, !0);
	}
	setsockopt(e, t, n, i) {
		const s = (0, this.instance.exports.kernel_setsockopt)(e, t, n, i);
		if (s < 0) throw new Error("setsockopt failed: errno " + -s);
	}
	tcgetattr(e) {
		const t = (0, this.instance.exports.kernel_tcgetattr)(e, 16, 48);
		if (t < 0) throw new Error("tcgetattr failed: errno " + -t);
		return this.getMemoryBuffer().slice(16, 64);
	}
	tcsetattr(e, t, n) {
		const i = this.instance.exports.kernel_tcsetattr;
		this.getMemoryBuffer().set(n, 16);
		const s = i(e, t, 16, n.length);
		if (s < 0) throw new Error("tcsetattr failed: errno " + -s);
	}
	ioctl(e, t, n) {
		const i = this.instance.exports.kernel_ioctl, s = this.getMemoryBuffer(), r = n ? n.length : 8;
		n && s.set(n, 16);
		const o = i(e, t, 16, r);
		if (o < 0) throw new Error("ioctl failed: errno " + -o);
		return s.slice(16, 16 + r);
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
		const n = this.getMemoryBuffer(), i = new TextDecoder(), s = (e) => {
			const t = 16 + e;
			let s = t;
			for (; s < t + 65 && 0 !== n[s];) s++;
			return i.decode(n.slice(t, s));
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
	dup3(e, t, n) {
		const i = (0, this.instance.exports.kernel_dup3)(e, t, n);
		if (i < 0) throw new Error("dup3 failed: errno " + -i);
		return i;
	}
	pipe2(e) {
		const t = this.instance.exports.kernel_pipe2, n = this.getMemoryDataView(), i = t(e, 4);
		if (i < 0) throw new Error("pipe2 failed: errno " + -i);
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
		const i = (0, this.instance.exports.kernel_truncate)(e, t, 4294967295 & n, Math.floor(n / 4294967296));
		if (i < 0) throw new Error("truncate failed: errno " + -i);
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
		const i = (0, this.instance.exports.kernel_fchown)(e, t, n);
		if (i < 0) throw new Error("fchown failed: errno " + -i);
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
	select(e, t, n, i) {
		const s = this.instance.exports.kernel_select, r = this.getMemoryBuffer(), o = t ? 16 : 0, a = n ? 144 : 0, c = i ? 272 : 0;
		if (t) {
			r.fill(0, o, o + 128);
			for (const e of t) r[o + Math.floor(e / 8)] |= 1 << e % 8;
		}
		if (n) {
			r.fill(0, a, a + 128);
			for (const e of n) r[a + Math.floor(e / 8)] |= 1 << e % 8;
		}
		if (i) {
			r.fill(0, c, c + 128);
			for (const e of i) r[c + Math.floor(e / 8)] |= 1 << e % 8;
		}
		const l = s(e, o, a, c, 0);
		if (l < 0) throw new Error("select failed: errno " + -l);
		const h = (e, t) => t && e ? t.filter((t) => r[e + Math.floor(t / 8)] >> t % 8 & 1) : [];
		return {
			readReady: h(o, t),
			writeReady: h(a, n),
			exceptReady: h(c, i)
		};
	}
	hostNetConnect(e, t, n, i) {
		if (!this.io.network) return -111;
		try {
			const s = new Uint8Array(this.memory.buffer).slice(t, t + n);
			return this.io.network.connect(e, s, i), 0;
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
	hostNetSend(e, t, n, i) {
		if (!this.io.network) return -107;
		try {
			const s = new Uint8Array(this.memory.buffer).slice(t, t + n);
			return this.io.network.send(e, s, i);
		} catch (s) {
			return 11 === s?.errno ? -11 : -32;
		}
	}
	hostNetRecv(e, t, n, i) {
		if (!this.io.network) return -107;
		try {
			const s = this.io.network.recv(e, n, i);
			return s.length > 0 && this.memory && new Uint8Array(this.memory.buffer).set(s, t), s.length;
		} catch (s) {
			return 11 === s?.errno ? -11 : -104;
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
	hostNetListen(e, t, n, i, s, r) {
		return this.callbacks.onNetListen ? this.callbacks.onNetListen(e, t, [
			n,
			i,
			s,
			r
		]) : 0;
	}
	hostUdpBind(e, t, n, i, s, r) {
		return this.callbacks.onUdpBind ? this.callbacks.onUdpBind(e, [
			t,
			n,
			i,
			s
		], r) : 0;
	}
	hostUdpUnbind(e) {
		return this.callbacks.onUdpUnbind ? this.callbacks.onUdpUnbind(e) : 0;
	}
	hostUdpSend(e, t, n, i, s, r, o, a, c, l, h, d) {
		if (!this.io.network?.sendDatagram) return -101;
		try {
			const f = this.getMemoryBuffer();
			let u = new Uint8Array([
				e,
				t,
				n,
				i
			]);
			0 === u[0] && 0 === u[1] && 0 === u[2] && 0 === u[3] && this.io.network.localAddress && (u = this.io.network.localAddress.slice());
			const g = f.slice(h, h + d), p = this.io.network.sendDatagram({
				srcAddr: u,
				srcPort: s,
				dstAddr: new Uint8Array([
					r,
					o,
					a,
					c
				]),
				dstPort: l,
				data: g
			});
			return 0 === p ? d : -p;
		} catch (f) {
			return "number" == typeof f?.errno ? -Math.abs(f.errno) : -101;
		}
	}
	hostGetaddrinfo(e, t, n, i) {
		if (!this.io.network) return -2;
		try {
			const s = new Uint8Array(this.memory.buffer), r = new TextDecoder().decode(s.slice(e, e + t)), o = this.io.network.getaddrinfo(r);
			return o.length > i ? -22 : (s.set(o, n), o.length);
		} catch (s) {
			return 11 === s?.errno ? -11 : -2;
		}
	}
	static F_GETLK = 12;
	static F_SETLK = 13;
	static F_SETLKW = 14;
	static F_UNLCK = 2;
	hostFcntlLock(t, n, i, s, r, o, a, c, h, d) {
		if (!this.sharedLockTable) return 0;
		try {
			const f = this.getMemoryBuffer(), u = new TextDecoder().decode(f.slice(t, t + n)), g = l.hashPath(u), p = BigInt(a) << 32n | BigInt(o >>> 0), m = BigInt(h) << 32n | BigInt(c >>> 0);
			switch (s) {
				case e.F_GETLK: {
					const t = this.sharedLockTable.getBlockingLock(g, r, p, m, i), n = this.getMemoryDataView();
					if (t) {
						n.setUint32(d, t.lockType, !0), n.setUint32(d + 4, t.pid, !0);
						const e = t.start;
						n.setUint32(d + 8, Number(4294967295n & e), !0), n.setUint32(d + 12, Number(e >> 32n & 4294967295n), !0);
						const i = t.len;
						n.setUint32(d + 16, Number(4294967295n & i), !0), n.setUint32(d + 20, Number(i >> 32n & 4294967295n), !0);
					} else n.setUint32(d, e.F_UNLCK, !0);
					return 0;
				}
				case e.F_SETLK:
				case e.F_SETLKW: return this.sharedLockTable.setLock(g, i, r, p, m) ? 0 : -11;
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
	hostFutexWait(e, t, n, i) {
		if (!this.memory) return -22;
		const s = new Int32Array(this.memory.buffer), r = e >>> 2, o = 4294967296n * BigInt(i >>> 0) + BigInt(n >>> 0), a = BigInt.asIntN(64, o);
		let c;
		a >= 0n && (c = Number(a / 1000000n), 0 === c && a > 0n && (c = 1));
		const l = Atomics.wait(s, r, t, c);
		return "timed-out" === l ? -110 : "not-equal" === l ? -11 : 0;
	}
	hostFutexWake(e, t) {
		if (!this.memory) return 0;
		const n = new Int32Array(this.memory.buffer), i = e >>> 2;
		return Atomics.notify(n, i, t);
	}
	hostClone(e, t, n, i, s) {
		return this.callbacks.onClone ? this.callbacks.onClone(e, t, n, i, s) : -38;
	}
};
const Ot = new TextEncoder(), Rt = new TextDecoder();
function Ft(e) {
	const t = function(e) {
		for (let t = 0; t + 3 < e.length; t++) if (13 === e[t] && 10 === e[t + 1] && 13 === e[t + 2] && 10 === e[t + 3]) return t;
		return -1;
	}(e);
	if (t < 0) return {
		status: 200,
		headers: {},
		body: e
	};
	const n = Rt.decode(e.subarray(0, t)).split("\r\n"), i = n[0]?.match(/^HTTP\/[\d.]+ (\d+)/), s = i ? parseInt(i[1], 10) : 200, r = {};
	for (let c = 1; c < n.length; c++) {
		const e = n[c], t = e.indexOf(": ");
		if (t < 0) continue;
		const i = e.slice(0, t), s = e.slice(t + 2);
		"set-cookie" === i.toLowerCase() && r[i] ? r[i] += "\n" + s : r[i] = s;
	}
	let o = e.subarray(t + 4);
	const a = r["Transfer-Encoding"] ?? r["transfer-encoding"];
	return a && a.toLowerCase().includes("chunked") && (o = function(e) {
		const t = [];
		let n = 0;
		for (; n < e.length;) {
			let i = -1;
			for (let t = n; t + 1 < e.length; t++) if (13 === e[t] && 10 === e[t + 1]) {
				i = t;
				break;
			}
			if (i < 0) break;
			const s = Rt.decode(e.subarray(n, i)).trim(), r = parseInt(s, 16);
			if (Number.isNaN(r) || 0 === r) break;
			const o = i + 2, a = o + r;
			if (a > e.length) break;
			t.push(e.subarray(o, a)), n = a + 2;
		}
		return function(e) {
			if (0 === e.length) return new Uint8Array(0);
			if (1 === e.length) return e[0];
			const t = e.reduce((e, t) => e + t.length, 0), n = new Uint8Array(t);
			let i = 0;
			for (const s of e) n.set(s, i), i += s.length;
			return n;
		}(t);
	}(o), delete r["Transfer-Encoding"], delete r["transfer-encoding"]), {
		status: s,
		headers: r,
		body: new Uint8Array(o)
	};
}
function Lt(e, t, n = function() {
	let e = 0;
	return "function" == typeof SharedArrayBuffer && (e |= Q.shared_array_buffer), "function" == typeof Atomics.wait && (e |= Q.atomics_wait), "function" == typeof Atomics.waitAsync && (e |= Q.atomics_wait_async), e;
}()) {
	const i = function(e, t) {
		const n = Nt(e, "kernel_host_adapter_manifest_ptr"), i = Nt(e, "kernel_host_adapter_manifest_len"), s = $t(n(), "kernel_host_adapter_manifest_ptr"), r = $t(i(), "kernel_host_adapter_manifest_len");
		if (r < 40) throw new Error(`kernel host adapter manifest is too small: ${r} bytes (expected at least 40)`);
		if (s + 40 > t.buffer.byteLength) throw new Error(`kernel host adapter manifest is out of bounds: ptr=${s} size=40 memory=${t.buffer.byteLength}`);
		const o = new DataView(t.buffer, s, 40);
		return {
			magic: Wt(o, "magic"),
			manifestVersion: Dt(o, "manifestVersion"),
			manifestSize: Dt(o, "manifestSize"),
			abiVersion: Wt(o, "abiVersion"),
			requiredHostAdapterVersion: Wt(o, "requiredHostAdapterVersion"),
			requiredWorkerFeatures: Wt(o, "requiredWorkerFeatures"),
			optionalKernelFeatures: Wt(o, "optionalKernelFeatures"),
			channelHeaderSize: Wt(o, "channelHeaderSize"),
			channelDataOffset: Wt(o, "channelDataOffset"),
			channelDataSize: Wt(o, "channelDataSize"),
			channelMinSize: Wt(o, "channelMinSize")
		};
	}(e, t);
	if (1296781399 !== i.magic) throw new Error(`kernel host adapter manifest has invalid magic: ${i.magic}`);
	if (1 !== i.manifestVersion) throw new Error(`kernel host adapter manifest version ${i.manifestVersion} is not supported by host manifest reader 1`);
	if (40 !== i.manifestSize) throw new Error(`kernel host adapter manifest size ${i.manifestSize} does not match host reader size 40`);
	if (16 !== i.abiVersion) throw new Error(`kernel host adapter manifest ABI version ${i.abiVersion} does not match host ABI version 16`);
	if (i.requiredHostAdapterVersion > 1) throw new Error(`kernel requires host adapter version ${i.requiredHostAdapterVersion}, but this host supports 1`);
	const s = i.requiredWorkerFeatures & ~n;
	if (0 !== s) throw new Error("kernel requires unsupported worker features: " + function(e) {
		const t = [];
		let n = 0;
		for (const [s, r] of Object.entries(Q)) n |= r, 0 !== (e & r) && t.push(s);
		const i = e & ~n;
		0 !== i && t.push(`unknown(0x${i.toString(16)})`);
		return 0 === t.length ? "none" : t.join(", ");
	}(s));
	Kt("channel header size", i.channelHeaderSize, 72), Kt("channel data offset", i.channelDataOffset, 72), Kt("channel data size", i.channelDataSize, ne), Kt("channel minimum size", i.channelMinSize, ie);
	for (const r of ee) if ("function" != typeof e.exports[r]) throw new Error(`kernel wasm is missing required host adapter export ${r}`);
	return i;
}
function Nt(e, t) {
	const n = e.exports[t];
	if ("function" != typeof n) throw new Error(`kernel wasm is missing required host adapter export ${t}`);
	return n;
}
function $t(e, t) {
	const n = "bigint" == typeof e ? Number(e) : e;
	if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${t} returned invalid manifest pointer/length ${String(e)}`);
	return n;
}
function Dt(e, t) {
	return e.getUint16(te[t].offset, !0);
}
function Wt(e, t) {
	return e.getUint32(te[t].offset, !0);
}
function Kt(e, t, n) {
	if (t !== n) throw new Error(`kernel host adapter manifest ${e} ${t} does not match generated host ABI value ${n}`);
}
const Vt = 67108864;
const Ht = 11, qt = _e, Gt = Fe, jt = Xe, Xt = et, Yt = Ce, Jt = ot, Zt = at, Qt = Ge, en = rt, tn = it, nn = wt, sn = st, rn = bt, on = nt, an = xe, cn = re, ln = le, hn = oe, dn = ae, fn = ce, un = tt, gn = ve, pn = It, mn = We, yn = Ke, wn = Qe, bn = lt, kn = vt, In = 16777216, vn = Ne, xn = Pe, _n = Be, Pn = Ue, Bn = Ye, Un = ct, An = ue, Sn = fe, Mn = Oe, En = Re, Cn = Me, Tn = Ee, zn = Te, On = ze, Rn = Je, Fn = Ze, Ln = Ae, Nn = kt, $n = Se, Dn = $e, Wn = De, Kn = dt, Vn = ft, Hn = pe, qn = pt, Gn = mt, jn = yt, Xn = ut, Yn = gt, Jn = "undefined" != typeof process && !!{}.WASM_POSIX_PROFILE, Zn = new Set([
	fe,
	Ee,
	ze,
	Oe,
	De,
	Ze
]), Qn = new Set([
	ue,
	Me,
	Te,
	Re,
	$e,
	Je,
	ht
]);
const ei = ie;
const ti = {
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
}, ni = {
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
}, ii = {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe"
};
function si(e) {
	switch (e) {
		case "pipe": return 0;
		case "terminal": return 1;
	}
}
var ri = class {
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
	profileData = Jn ? /* @__PURE__ */ new Map() : null;
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
	kmsCanvases = /* @__PURE__ */ new Map();
	kmsContexts = /* @__PURE__ */ new Map();
	kmsContextMode = /* @__PURE__ */ new Map();
	kmsStatsViews = /* @__PURE__ */ new Map();
	kmsScratchBytes = /* @__PURE__ */ new Map();
	vblankTimer = null;
	constructor(e, t, n = {}) {
		if (this.config = e, this.io = t, this.callbacks = n, this.kernel = new zt(e, t, {
			getProcessMemory: (e) => this.processes.get(e)?.memory,
			getKmsCanvas: (e) => this.kmsCanvases.get(e),
			markKmsCanvasGlOwned: (e) => {
				this.kmsContextMode.set(e, "webgl2");
			},
			onStdin: (e) => {
				const t = this.currentHandlePid, n = this.stdinBuffers.get(t);
				if (!n) return this.stdinFinite.has(t) ? null : new Uint8Array(0);
				const i = n.data.length - n.offset;
				if (i <= 0) return this.stdinBuffers.delete(t), this.stdinFinite.has(t) ? null : new Uint8Array(0);
				const s = Math.min(i, e), r = n.data.subarray(n.offset, n.offset + s);
				return n.offset += s, n.offset >= n.data.length && this.stdinBuffers.delete(t), r;
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
				const i = this.currentHandlePid;
				return 0 === i || this.startTcpListener(i, e, t, n), 0;
			},
			onUdpBind: (e, t, n) => {
				const i = this.currentHandlePid;
				if (0 === i || !this.io.network?.bindUdp) return 0;
				const s = `${i}:${e}`, r = this.io.network.bindUdp(s, new Uint8Array(t), n, { receive: (e) => this.injectUdpDatagram(i, e) });
				return 0 === r && this.udpBindings.add(s), 0 === r ? 0 : -r;
			},
			onUdpUnbind: (e) => {
				const t = this.currentHandlePid;
				if (0 === t || !this.io.network?.unbindUdp) return 0;
				const n = `${t}:${e}`;
				return this.io.network.unbindUdp(n), this.udpBindings.delete(n), 0;
			},
			onPosixTimer: (e, t, n, i) => {
				const s = this.currentHandlePid;
				if (0 === s) return 0;
				const r = `${s}:${e}`, o = this.posixTimers.get(r);
				if (o && (clearTimeout(o.timeout), o.interval && clearInterval(o.interval), this.posixTimers.delete(r)), n > 0 || i > 0) {
					const o = setTimeout(() => {
						if (this.processes.has(s)) if (this.sendSignalToProcess(s, t), i > 0) {
							const n = setInterval(() => {
								if (!this.processes.has(s)) {
									const e = this.posixTimers.get(r);
									e?.interval && clearInterval(e.interval), this.posixTimers.delete(r);
									return;
								}
								const n = this.kernelInstance.exports.kernel_posix_timer_interval_fire;
								n && n(s, e) || this.sendSignalToProcess(s, t);
							}, i), o = this.posixTimers.get(r);
							o && (o.interval = n);
						} else this.posixTimers.delete(r);
						else this.posixTimers.delete(r);
					}, Math.max(0, n));
					this.posixTimers.set(r, {
						timeout: o,
						signo: t
					});
				}
				return 0;
			}
		}), this.virtualMacAddress = new Uint8Array(6), void 0 !== globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(this.virtualMacAddress);
		else for (let i = 0; i < 6; i++) this.virtualMacAddress[i] = Math.floor(256 * Math.random());
		this.virtualMacAddress[0] = 254 & this.virtualMacAddress[0] | 2;
	}
	async init(e) {
		await this.kernel.init(e), this.kernelInstance = this.kernel.getInstance(), this.kernelMemory = this.kernel.getMemory();
		const t = this.kernelInstance.exports[Z];
		if ("function" != typeof t) throw new Error(`kernel wasm is missing the ${Z} export — refusing to run. Rebuild the kernel (bash build.sh) against the current ABI.`);
		this.kernelAbiVersion = t(), Lt(this.kernelInstance, this.kernelMemory);
		const n = this.kernelInstance.exports.kernel_alloc_scratch;
		if (this.scratchOffset = Number(n(ei)), 0 === this.scratchOffset) throw new Error("Failed to allocate kernel scratch buffer");
		try {
			const e = await import("./__vite-browser-external-CIK6YeCj.js").then((e) => a(e.default, 1));
			"function" == typeof e.createServer && (this.netModule = e);
		} catch {}
		if (this.tcpScratchOffset = Number(n(65536)), 0 === this.tcpScratchOffset) throw new Error("Failed to allocate TCP scratch buffer");
		this.lockTable = l.create(), this.kernel.registerSharedLockTable(this.lockTable.getBuffer()), this.initialized = !0;
	}
	registerProcess(e, t, n, i) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		if (this.hostReaped.delete(e), !i?.skipKernelCreate) {
			const t = i?.stdio;
			if (!t) throw new Error("registerProcess requires explicit stdio when creating a kernel process");
			const n = this.kernelInstance.exports.kernel_create_process_with_stdio;
			if (!n) throw new Error("Kernel missing kernel_create_process_with_stdio export");
			const s = n(e, si(t.stdin), si(t.stdout), si(t.stderr));
			if (s < 0) throw new Error(`Failed to create process ${e}: errno ${-s}`);
		}
		if (void 0 !== i?.brkBase && !this.setBrkBase(e, i.brkBase)) throw new Error("Kernel export kernel_set_brk_base is required for compact process memory layout");
		if (i?.argv && i.argv.length > 0) {
			const t = this.kernelInstance.exports.kernel_set_process_argv;
			if (t) {
				const n = new TextEncoder(), s = i.argv.join("\0"), r = n.encode(s), o = new Uint8Array(this.kernelMemory.buffer), a = this.scratchOffset;
				o.set(r, a), t(e, this.toKernelPtr(a), r.length);
			}
		}
		const s = this.kernelInstance.exports.kernel_set_max_addr;
		if (s) {
			const t = i?.maxAddr ?? (n.length > 0 ? Math.min(...n) : void 0);
			void 0 !== t && s(e, this.toKernelPtr(t));
		}
		if (void 0 !== i?.mmapBase && !this.setMmapBase(e, i.mmapBase)) throw new Error("Kernel export kernel_set_mmap_base is required for compact process memory layout");
		if (void 0 !== i?.brkLimit && !this.setBrkLimit(e, i.brkLimit)) throw new Error("Kernel export kernel_set_brk_limit is required for legacy low-control layout");
		const r = n.map((n) => ({
			pid: e,
			memory: t,
			channelOffset: n,
			i32View: new Int32Array(t.buffer, n),
			consecutiveSyscalls: 0
		})), o = {
			pid: e,
			memory: t,
			channels: r,
			ptrWidth: i?.ptrWidth ?? 4,
			explicitMaxAddr: void 0 !== i?.maxAddr
		};
		if (this.processes.set(e, o), this.activeChannels.push(...r), this.usePolling) this.startPolling();
		else for (const a of r) this.listenOnChannel(a);
	}
	setStdinData(e, t) {
		this.stdinBuffers.set(e, {
			data: t,
			offset: 0
		}), this.stdinFinite.add(e);
	}
	setOutputCallbacks(e) {
		this.kernel.mergeCallbacks(e);
	}
	appendStdinData(e, t) {
		const n = this.stdinBuffers.get(e);
		if (n) {
			const i = n.data.subarray(n.offset), s = new Uint8Array(i.length + t.length);
			s.set(i), s.set(t, i.length), this.stdinBuffers.set(e, {
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
		const i = this.kernelInstance.exports.kernel_pty_set_winsize;
		if (!i) return;
		i(e, t, n), this.scheduleWakeBlockedRetries();
		for (const [s, r] of Array.from(this.pendingSleeps.entries())) this.processes.has(s) && (this.dequeueSignalForDelivery(r.channel), new DataView(r.channel.memory.buffer, r.channel.channelOffset).getUint32(65560, !0) > 0 && (clearTimeout(r.timer), this.pendingSleeps.delete(s), this.completeChannel(r.channel, r.syscallNr, r.origArgs, xt[r.syscallNr], -1, 4)));
	}
	onPtyOutput(e, t) {
		this.ptyOutputCallbacks.set(e, t), this.drainPtyOutput(e);
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
		const i = new TextEncoder().encode(t);
		new Uint8Array(this.kernelMemory.buffer).set(i, this.scratchOffset), n(e, this.toKernelPtr(this.scratchOffset), i.length);
	}
	setCredentials(e, t) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		if (null == t.uid && null == t.gid) return;
		const n = 4294967295, i = this.kernelInstance.exports.kernel_set_process_credentials;
		if (i) {
			const s = i(e, t.uid ?? n, t.gid ?? n);
			if (s < 0) throw new Error(`setCredentials failed for pid ${e}: errno ${-s}`);
			return;
		}
		const s = this.kernelInstance.exports.kernel_set_current_pid, r = this.kernelInstance.exports.kernel_setgid, o = this.kernelInstance.exports.kernel_setuid;
		if (s && r && o) try {
			if (s(e), null != t.gid) {
				const n = r(t.gid);
				if (n < 0) throw new Error(`setgid failed for pid ${e}: errno ${-n}`);
			}
			if (null != t.uid) {
				const n = o(t.uid);
				if (n < 0) throw new Error(`setuid failed for pid ${e}: errno ${-n}`);
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
		const t = e(this.toKernelPtr(this.scratchOffset), ei);
		if (t <= 0) return [];
		const n = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, t), i = new Uint8Array(t);
		i.set(n);
		const s = function(e) {
			if (e.byteLength < 4) return [];
			const t = new DataView(e.buffer, e.byteOffset, e.byteLength), n = t.getUint32(0, !0);
			let i = 4;
			const s = [], r = new TextDecoder("utf-8", { fatal: !1 });
			for (let o = 0; o < n && !(i + 36 > e.byteLength); o++) {
				const n = t.getUint32(i, !0);
				i += 4;
				const o = t.getUint32(i, !0);
				i += 4;
				const a = t.getUint32(i, !0);
				i += 4;
				const c = t.getUint32(i, !0);
				i += 4;
				const l = Number(t.getBigUint64(i, !0));
				i += 8;
				const h = String.fromCharCode(t.getUint32(i, !0));
				i += 4;
				const d = t.getUint32(i, !0);
				i += 4;
				const f = t.getUint32(i, !0);
				if (i += 4, i + d + f > e.byteLength) break;
				const u = r.decode(e.subarray(i, i + d));
				i += d;
				const g = e.subarray(i, i + f);
				i += f;
				const p = r.decode(g).replace(/\0/g, " ").trimEnd();
				s.push({
					pid: n,
					ppid: o,
					uid: a,
					gid: c,
					vsizeBytes: l,
					state: h,
					comm: u,
					cmdline: p || `[${u}]`
				});
			}
			return s;
		}(i);
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
		const n = t(e, this.toKernelPtr(this.scratchOffset), ei);
		if (n < 0) return null;
		if (0 === n) return "";
		const i = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, n), s = new Uint8Array(n);
		return s.set(i), new TextDecoder("utf-8", { fatal: !1 }).decode(s);
	}
	unregisterProcess(e) {
		if (!this.processes.get(e)) return;
		this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.cleanupUdpBindings(e), this.cleanupTcpListeners(e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingPipeReaders(e), this.cleanupPendingPipeWriters(e);
		for (const [n, i] of this.socketTimeoutTimers) n.pid === e && (clearTimeout(i), this.socketTimeoutTimers.delete(n));
		for (const n of this.epollInterests.keys()) n.startsWith(`${e}:`) && this.epollInterests.delete(n);
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
		for (const [i, s] of this.posixTimers) i.startsWith(`${e}:`) && (clearTimeout(s.timeout), s.interval && clearInterval(s.interval), this.posixTimers.delete(i));
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
	addChannel(e, t, n, i, s) {
		const r = this.processes.get(e);
		if (!r) throw new Error(`Process ${e} not registered`);
		const o = {
			pid: e,
			memory: r.memory,
			channelOffset: t,
			i32View: new Int32Array(r.memory.buffer, t),
			consecutiveSyscalls: 0
		};
		r.channels.push(o), this.activeChannels.push(o), void 0 !== n && this.channelTids.set(`${e}:${t}`, n), void 0 !== i && void 0 !== s && this.threadForkContexts.set(`${e}:${t}`, {
			fnPtr: i,
			argPtr: s
		});
		const a = this.kernelInstance.exports.kernel_set_max_addr;
		if (a && !r.explicitMaxAddr) {
			const n = t - 131072;
			n >= Vt && a(e, this.toKernelPtr(n));
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
		const i = Atomics.waitAsync(t, 0, n);
		i.async ? i.value.then(() => {
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
		const i = new Uint8Array(e.buffer);
		let s = 0;
		for (; s < n && t + s < i.length && 0 !== i[t + s];) s++;
		const r = new Uint8Array(s);
		return r.set(i.subarray(t, t + s)), new TextDecoder().decode(r);
	}
	readBytesPreview(e, t, n, i = 160) {
		if (0 === t || n <= 0) return "";
		const s = new Uint8Array(e.buffer), r = Math.max(0, Math.min(n, i, s.length - t));
		if (r <= 0) return "";
		const o = new Uint8Array(r);
		return o.set(s.subarray(t, t + r)), new TextDecoder("utf-8", { fatal: !1 }).decode(o);
	}
	formatPollFds(e, t, n) {
		if (0 === t || n <= 0) return "";
		const i = new DataView(e.buffer), s = [], r = Math.min(n, 8);
		for (let o = 0; o < r; o++) {
			const e = t + 8 * o;
			if (e + 8 > i.byteLength) break;
			const n = i.getInt32(e, !0), r = i.getInt16(e + 4, !0), a = i.getInt16(e + 6, !0);
			s.push(`{fd:${n},events:0x${(65535 & r).toString(16)},revents:0x${(65535 & a).toString(16)}}`);
		}
		return n > r && s.push("..."), s.join(",");
	}
	formatSyscallEntry(e, t, n) {
		const i = ti[t] ?? `syscall_${t}`, s = e.pid, r = this.channelTids.get(`${s}:${e.channelOffset}`), o = void 0 !== r ? `:t${r}` : "";
		switch (t) {
			case he: return `[${s}${o}] open("${this.readCString(e.memory, n[0])}", 0x${(n[1] >>> 0).toString(16)}, 0o${(n[2] >>> 0).toString(8)})`;
			case Le: return `[${s}${o}] openat(${n[0]}, "${this.readCString(e.memory, n[1])}", 0x${(n[2] >>> 0).toString(16)}, 0o${(n[3] >>> 0).toString(8)})`;
			case me: return `[${s}${o}] stat("${this.readCString(e.memory, n[0])}")`;
			case ye: return `[${s}${o}] lstat("${this.readCString(e.memory, n[0])}")`;
			case Ve: return `[${s}${o}] fstatat(${n[0]}, "${this.readCString(e.memory, n[1])}", 0x${(n[3] >>> 0).toString(16)})`;
			case be: return `[${s}${o}] access("${this.readCString(e.memory, n[0])}", ${n[1]})`;
			case He: return `[${s}${o}] faccessat(${n[0]}, "${this.readCString(e.memory, n[1])}", ${n[2]})`;
			case ke: return `[${s}${o}] chdir("${this.readCString(e.memory, n[0])}")`;
			case Ie: return `[${s}${o}] opendir("${this.readCString(e.memory, n[0])}")`;
			case we: return `[${s}${o}] readlink("${this.readCString(e.memory, n[0])}", ${n[2]})`;
			case qe: return `[${s}${o}] readlinkat(${n[0]}, "${this.readCString(e.memory, n[1])}", ${n[3]})`;
			case je: return `[${s}${o}] realpath("${this.readCString(e.memory, n[0])}")`;
			case fe: return `[${s}${o}] read(${n[0]}, ${n[2]})`;
			case ue: return `[${s}${o}] write(${n[0]}, ${n[2]}, ${JSON.stringify(this.readBytesPreview(e.memory, n[1], n[2]))})`;
			case de: return `[${s}${o}] close(${n[0]})`;
			case ge: return `[${s}${o}] fstat(${n[0]})`;
			case pe: return `[${s}${o}] fcntl(${n[0]}, ${n[1]}, ${n[2]})`;
			case Pe: return `[${s}${o}] mmap(0x${(n[0] >>> 0).toString(16)}, ${n[1] >>> 0}, ${n[2]}, 0x${(n[3] >>> 0).toString(16)}, ${n[4]}, ${n[5] >>> 0})`;
			case Be: return `[${s}${o}] munmap(0x${(n[0] >>> 0).toString(16)}, ${n[1] >>> 0})`;
			case Ue: return `[${s}${o}] brk(0x${(n[0] >>> 0).toString(16)})`;
			case re: return `[${s}${o}] execve("${this.readCString(e.memory, n[0])}")`;
			case oe: return `[${s}${o}] fork()`;
			case ae: return `[${s}${o}] vfork()`;
			case tt: return `[${s}${o}] clone(0x${(n[0] >>> 0).toString(16)})`;
			case ve: return `[${s}${o}] exit(${n[0]})`;
			case Ce: return `[${s}${o}] poll(${n[1]}, ${n[2]}, [${this.formatPollFds(e.memory, n[0], n[1])}])`;
			case Ne: return `[${s}${o}] ioctl(${n[0]}, 0x${(n[1] >>> 0).toString(16)})`;
			default: return `[${s}${o}] ${i}(${n.filter((e, t) => t < 3).join(", ")})`;
		}
	}
	formatSyscallReturn(e, t, n) {
		if (t < 0 || 0 !== n) return ` = ${t} (${ni[n] ?? `errno=${n}`})`;
		switch (e) {
			case Pe:
			case Ue: return ` = 0x${(t >>> 0).toString(16)}`;
			default: return ` = ${t}`;
		}
	}
	handleSyscall(e) {
		try {
			if (Jn) {
				const t = new DataView(e.memory.buffer, e.channelOffset).getUint32(4, !0), n = performance.now();
				this._handleSyscallInner(e);
				const i = performance.now() - n;
				let s = this.profileData.get(t);
				s || (s = {
					count: 0,
					totalTimeMs: 0,
					retries: 0
				}, this.profileData.set(t, s)), s.count++, s.totalTimeMs += i;
				return;
			}
			this._handleSyscallInner(e);
		} catch (zi) {
			console.error(`[handleSyscall] UNCAUGHT ERROR pid=${e.pid}:`, zi), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
		}
	}
	_handleSyscallInner(e) {
		const t = new DataView(e.memory.buffer, e.channelOffset), n = t.getUint32(4, !0), i = [];
		for (let I = 0; I < 6; I++) i.push(Number(t.getBigInt64(8 + 8 * I, !0)));
		const s = e.pid;
		let r = this.syscallRing.get(s);
		r || (r = [], this.syscallRing.set(s, r)), r.push(`  ${this.formatSyscallEntry(e, n, i)}`), r.length > 30 && r.shift(), this.syscallTraceEnabled && (this.syscallTraceRing.length >= this.syscallTraceCap && this.syscallTraceRing.shift(), this.syscallTraceRing.push({
			t: performance.now(),
			pid: e.pid,
			nr: n,
			args: [
				i[0] ?? 0,
				i[1] ?? 0,
				i[2] ?? 0,
				i[3] ?? 0,
				i[4] ?? 0,
				i[5] ?? 0
			],
			decoded: this.formatSyscallEntry(e, n, i)
		}));
		const o = this.config.syscallLogPtrWidth, a = void 0 !== o && this.processes.get(e.pid)?.ptrWidth === o, c = !!this.config.enableSyscallLog || a;
		let l = "";
		if (c && (l = this.formatSyscallEntry(e, n, i)), n === hn || n === dn) return c && console.error(l), void this.handleFork(e, i);
		if (n === fn) return c && console.error(l), void this.handleSpawn(e, i);
		if (n === cn) return c && console.error(l), void this.handleExec(e, i);
		if (n === ln) return c && console.error(l), void this.handleExecveat(e, i);
		if (n === un) return c && console.error(l), void this.handleClone(e, i);
		if (n === gn || n === pn) return c && console.error(l), void this.handleExit(e, n, i);
		if (n === wn) return c && console.error(l), void this.handleWaitpid(e, i);
		if (n === bn) return c && console.error(l), void this.handleWaitid(e, i);
		if (n === Xt) {
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
				}, n = 128, s = 256, r = i[1] >>> 0, o = -385 & r, a = t[o] ?? `op${o}`, c = (r & n ? "|PRIVATE" : "") + (r & s ? "|REALTIME" : ""), l = this.channelTids.get(`${e.pid}:${e.channelOffset}`), h = void 0 !== l ? `:t${l}` : "";
				console.error(`[${e.pid}${h}] futex(0x${(i[0] >>> 0).toString(16)}, ${a}${c}, val=${i[2]})`);
			}
			this.handleFutex(e, i);
			return;
		}
		if (n === kn) return c && console.error(l), void this.handleThreadCancel(e, i);
		if (n === Dn || n === Vn) return c && console.error(l), void this.handleWritev(e, n, i);
		if (n === Wn || n === Kn) return c && console.error(l), void this.handleReadv(e, n, i);
		if ((n === An || n === En) && i[2] > 65536) return void this.handleLargeWrite(e, n, i);
		if ((n === Sn || n === Mn) && i[2] > 65536) return void this.handleLargeRead(e, n, i);
		if (n === Rn) return void this.handleSendmsg(e, i);
		if (n === Fn) return void this.handleRecvmsg(e, i);
		if (n === vn) {
			const t = i[1] >>> 0;
			if (35090 === t) return void this.handleIoctlIfconf(e, i);
			if (35111 === t) return void this.handleIoctlIfhwaddr(e, i);
			if (35093 === t) return void this.handleIoctlIfaddr(e, i);
		}
		if (n === Hn) {
			const t = i[1];
			if (5 === t || 6 === t || 7 === t || 12 === t || 13 === t || 14 === t || 36 === t || 37 === t || 38 === t) return void this.handleFcntlLock(e, i);
		}
		if (n === tn || n === nn) return void this.handleEpollCreate(e, n, i);
		if (n === sn) return void this.handleEpollCtl(e, i);
		if (n === en || n === rn) return void this.handleEpollPwait(e, n, i);
		if (n === Gn) return void this.handleIpcShmat(e, i);
		if (n === jn) return void this.handleIpcShmdt(e, i);
		if (n === qn) return void this.handleSemctl(e, i);
		if (n === Zt) return void this.handlePselect6(e, i);
		if (n === Qt) return void this.handleSelect(e, i);
		const h = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = [...i], f = xt[n];
		let u = 0;
		if (f) {
			const t = new Uint8Array(e.memory.buffer), n = this.getKernelMem(), s = this.scratchOffset + 72;
			for (const e of f) {
				const r = i[e.argIndex];
				if (0 === r) continue;
				let o;
				if ("cstring" === e.size.type) {
					let e = 0;
					for (; 0 !== t[r + e] && e < 65536 - u - 1;) e++;
					o = e + 1;
				} else if ("arg" === e.size.type) o = i[e.size.argIndex] * (e.size.multiplier ?? 1) + (e.size.add ?? 0);
				else if ("deref" === e.size.type) {
					const n = i[e.size.argIndex];
					if (0 === n) continue;
					o = t[n] | t[n + 1] << 8 | t[n + 2] << 16 | t[n + 3] << 24;
				} else o = e.size.size;
				if (o <= 0) continue;
				if (u + o > 65536) {
					if (o = ne - u, o <= 0) continue;
					"arg" === e.size.type && (d[e.size.argIndex] = o);
				}
				const a = s + u;
				"in" === e.direction || "inout" === e.direction ? n.set(t.subarray(r, r + o), a) : n.fill(0, a, a + o), d[e.argIndex] = a, u += o, u = u + 3 & -4;
			}
		}
		if (n === Jt) {
			const t = i[2];
			if (0 !== t) {
				const n = new DataView(e.memory.buffer, t), i = Number(n.getBigInt64(0, !0)), s = Number(n.getBigInt64(8, !0));
				d[2] = 1e3 * i + Math.floor(s / 1e6);
			} else d[2] = -1;
			const n = i[3];
			if (0 !== n) {
				const t = new DataView(e.memory.buffer, n);
				d[3] = 1, d[4] = t.getUint32(0, !0), d[5] = t.getUint32(4, !0);
			} else d[3] = 0, d[4] = 0, d[5] = 0;
		}
		h.setUint32(4, n, !0);
		for (let I = 0; I < 6; I++) h.setBigInt64(8 + 8 * I, BigInt(d[I]), !0);
		const g = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		const p = globalThis.__sysprof, m = p ? performance.now() : 0;
		if (p) {
			const t = globalThis;
			t.__sysprofGap || (t.__sysprofGap = /* @__PURE__ */ new Map()), t.__sysprofLastSeen || (t.__sysprofLastSeen = /* @__PURE__ */ new Map());
			const n = t.__sysprofLastSeen.get(e.pid);
			if (void 0 !== n) {
				const i = m - n;
				let s = t.__sysprofGap.get(e.pid);
				s || (s = {
					count: 0,
					gapTotalMs: 0,
					gapMaxMs: 0
				}, t.__sysprofGap.set(e.pid, s)), s.count++, s.gapTotalMs += i, i > s.gapMaxMs && (s.gapMaxMs = i);
			}
			t.__sysprofLastSeen.set(e.pid, m);
		}
		try {
			g(this.toKernelPtr(this.scratchOffset), e.pid);
		} catch (zi) {
			c && console.error(l + " = KERNEL THROW"), console.error(`[handleSyscall] kernel threw for pid=${e.pid} syscall=${n} args=[${i}]:`, zi), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
			return;
		} finally {
			if (this.currentHandlePid = 0, p) {
				const t = performance.now() - m, s = globalThis;
				s.__sysprofTable || (s.__sysprofTable = /* @__PURE__ */ new Map());
				const r = `${e.pid}:${n}`;
				let o = s.__sysprofTable.get(r);
				o || (o = {
					count: 0,
					totalMs: 0,
					maxMs: 0
				}, s.__sysprofTable.set(r, o)), o.count++, o.totalMs += t, t > o.maxMs && (o.maxMs = t), t > 50 && console.warn(`[sysprof] slow pid=${e.pid} nr=${n} ${t.toFixed(1)}ms args=[${i.join(",")}]`);
			}
		}
		const y = Number(h.getBigInt64(56, !0)), w = h.getUint32(64, !0);
		y > 0 && this.ensureProcessMemoryCovers(e.pid, e.memory, n, y, i);
		const b = this.highControlFloorForProcess(e.pid);
		if (n === xn && y > 0 && y >>> 0 != 4294967295) {
			const t = y >>> 0, n = i[1] >>> 0;
			null !== b && t + n > b && console.error(`[MMAP ALERT] pid=${e.pid} mmap returned 0x${t.toString(16)} len=${n} — OVERLAPS THREAD REGION! args=[${i.map((e) => "0x" + (e >>> 0).toString(16)).join(",")}]`);
		}
		if (n === Bn && y > 0 && y >>> 0 != 4294967295) {
			const t = y >>> 0, n = i[2] >>> 0;
			null !== b && t + n > b && console.error(`[MREMAP ALERT] pid=${e.pid} mremap returned 0x${t.toString(16)} len=${n} — OVERLAPS THREAD REGION!`);
		}
		if (null !== b && n === Pn && y > b && console.error(`[BRK ALERT] pid=${e.pid} brk returned 0x${(y >>> 0).toString(16)} — IN THREAD REGION!`), n === xn && y > 0 && y >>> 0 != 4294967295) {
			const t = i[4], n = i[3] >>> 0;
			if (t >= 0 && !(32 & n) && (this.populateMmapFromFile(e, y >>> 0, i), 1 & n)) {
				const n = i[5] >>> 0;
				let s = this.sharedMappings.get(e.pid);
				s || (s = /* @__PURE__ */ new Map(), this.sharedMappings.set(e.pid, s)), s.set(y >>> 0, {
					fd: t,
					fileOffset: 4096 * n,
					len: i[1] >>> 0
				});
			}
			const s = y >>> 0, r = this.kernel.bos.findBindingByAddr(e.pid, s);
			void 0 !== r && this.kernel.bos.primeBindFromSab(e.pid, r, e.memory);
		}
		n === Un && 0 === y && this.flushSharedMappings(e, i), n === _n && 0 === y && (this.flushSharedMappings(e, i), this.cleanupSharedMappings(e.pid, i[0] >>> 0, i[1] >>> 0));
		const k = this.kernelInstance.exports.kernel_get_process_exit_status;
		if (k && k(e.pid) >= 128) this.handleProcessTerminated(e);
		else {
			if (n === Xn && 0 === y && this.drainMqueueNotification(), this.dequeueSignalForDelivery(e), -1 === y && w === Ht) return c && console.error(l + " = -1 (EAGAIN, will retry)"), void this.handleBlockingRetry(e, n, i);
			this.handleSleepDelay(e, n, i, y, w) || (0 !== w || n !== mn && n !== yn || this.recheckDeferredWaitpids(), 0 === w && n === an && (this.scheduleWakeBlockedRetries(), this.reapKilledProcessesAfterSyscall()), c && console.error(l + this.formatSyscallReturn(n, y, w)), this.completeChannel(e, n, i, f, y, w));
		}
	}
	dequeueSignalForDelivery(e) {
		const t = this.kernelInstance.exports.kernel_dequeue_signal;
		if (!t) return;
		const n = this.scratchOffset + se;
		if (t(e.pid, this.toKernelPtr(n)) > 0) {
			const t = this.getKernelMem();
			new Uint8Array(e.memory.buffer).set(t.subarray(n, n + 44), e.channelOffset + se);
		} else {
			const t = e.channelOffset + se;
			new Uint8Array(e.memory.buffer, t, 48).fill(0);
		}
	}
	completeChannel(e, t, n, i, s, r) {
		const o = new DataView(e.memory.buffer, e.channelOffset);
		if (i) {
			const t = new Uint8Array(e.memory.buffer), r = this.getKernelMem(), o = this.scratchOffset + 72;
			let a = 0;
			for (const e of i) {
				const i = n[e.argIndex];
				if (0 === i) continue;
				let c;
				if ("cstring" === e.size.type) {
					let e = 0;
					for (; 0 !== t[i + e] && e < 65536 - a - 1;) e++;
					c = e + 1;
				} else if ("arg" === e.size.type) c = n[e.size.argIndex] * (e.size.multiplier ?? 1) + (e.size.add ?? 0);
				else if ("deref" === e.size.type) {
					const i = n[e.size.argIndex];
					if (0 === i) continue;
					c = t[i] | t[i + 1] << 8 | t[i + 2] << 16 | t[i + 3] << 24;
				} else c = e.size.size;
				if (c <= 0) continue;
				if (a + c > 65536 && (c = ne - a, c <= 0)) continue;
				const l = o + a;
				if ("out" === e.direction || "inout" === e.direction) {
					if ("out" === e.direction && s < 0) {
						a += c, a = a + 3 & -4;
						continue;
					}
					let n = c;
					if ("out" === e.direction && "arg" === e.size.type) {
						const t = e.copyRetvalAdd ?? 0;
						s > 0 && s + t < c && (n = s + t);
					}
					t.set(r.subarray(l, l + n), i);
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
	completeChannelRaw(e, t, n) {
		e.handling = !1;
		const i = new DataView(e.memory.buffer, e.channelOffset);
		i.setBigInt64(56, BigInt(t), !0), i.setUint32(64, n, !0), this.clearSocketTimeout(e), this.pendingCancels.delete(e.channelOffset);
		const s = new Int32Array(e.memory.buffer, e.channelOffset);
		Atomics.store(s, 0, 2), Atomics.notify(s, 0, 1);
	}
	abandonChannel(e) {
		e.handling = !1, this.clearSocketTimeout(e), this.pendingCancels.delete(e.channelOffset);
	}
	resolvePollReadinessIndices(e, t) {
		const n = this.kernelInstance.exports.kernel_get_fd_pipe_idx ?? this.kernelInstance.exports.kernel_get_socket_recv_pipe, i = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		if (!n && !i) return {
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
		const a = [], c = [], l = new DataView(o.memory.buffer);
		for (let h = 0; h < r; h++) {
			const t = l.getInt32(s + 8 * h, !0);
			if (t < 0) continue;
			const r = l.getInt16(s + 8 * h + 4, !0);
			if (n) {
				const i = n(e, t);
				i >= 0 && a.push(i);
			}
			if (i && 1 & r) {
				const n = i(e, t);
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
		const i = `${e}:`, s = [], r = [];
		for (const [o, a] of this.epollInterests) if (o.startsWith(i)) for (const i of a) {
			if (t) {
				const n = t(e, i.fd);
				n >= 0 && s.push(n);
			}
			if (n && 1 & i.events) {
				const t = n(e, i.fd);
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
		for (const [n, i] of t) this.pendingPollRetries.get(n) === i && (null !== i.timer && clearTimeout(i.timer), this.pendingPollRetries.delete(n), this.processes.has(i.channel.pid) && this.retrySyscall(i.channel));
	}
	wakeBlockedPoll(e, t) {
		const n = Array.from(this.pendingPollRetries.entries()).filter(([, n]) => n.channel.pid === e && n.pipeIndices.includes(t));
		for (const [i, s] of n) this.pendingPollRetries.get(i) === s && (null !== s.timer && clearTimeout(s.timer), this.pendingPollRetries.delete(i), this.processes.has(e) && this.retrySyscall(s.channel));
	}
	notifyPipeReadable(e, t) {
		const n = this.pendingPipeReaders.get(e);
		if (n && n.length > 0) {
			this.pendingPipeReaders.delete(e);
			for (const e of n) this.processes.has(e.pid) && this.retrySyscall(e.channel);
		}
		for (const [i, s] of this.pendingPollRetries) void 0 !== t && s.channel.pid !== t || s.pipeIndices.includes(e) && (null !== s.timer && clearTimeout(s.timer), this.pendingPollRetries.delete(i), this.processes.has(s.channel.pid) && this.retrySyscall(s.channel));
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
		let i = !1;
		for (let s = 0; s < t; s++) {
			const e = this.scratchOffset + 5 * s, t = n[e] | n[e + 1] << 8 | n[e + 2] << 16 | n[e + 3] << 24, r = n[e + 4];
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
			4 & r && this.wakeBlockedAccept(t), i = !0;
		}
		i && (this.anyPendingRetryNeedsSignalSafeWake() ? this.scheduleWakeBlockedRetriesDeferred() : this.scheduleWakeBlockedRetries());
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
		for (const [n, i] of this.pendingPollRetries) {
			if (!i.needsSignalSafeWake) continue;
			null !== i.timer && clearTimeout(i.timer);
			const s = i.deadline && i.deadline > 0 ? Math.max(1, i.deadline - t) : e;
			i.timer = setTimeout(() => {
				this.pendingPollRetries.delete(n), this.processes.has(i.channel.pid) && this.retrySyscall(i.channel);
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
		for (const [n, i] of e) this.processes.has(i.channel.pid) && (null !== i.timer && clearTimeout(i.timer), this.retrySyscall(i.channel));
		for (const [, n] of t) this.processes.has(n.channel.pid) && (clearTimeout(n.timer), clearImmediate(n.timer), n.syscallNr === Qt ? this.handleSelect(n.channel, n.origArgs) : this.handlePselect6(n.channel, n.origArgs));
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
			const i = n.filter((t) => t.pid !== e);
			0 === i.length ? this.pendingPipeReaders.delete(t) : this.pendingPipeReaders.set(t, i);
		}
	}
	cleanupPendingPipeWriters(e) {
		for (const [t, n] of this.pendingPipeWriters) {
			const i = n.filter((t) => t.pid !== e);
			0 === i.length ? this.pendingPipeWriters.delete(t) : this.pendingPipeWriters.set(t, i);
		}
	}
	clearSocketTimeout(e) {
		const t = this.socketTimeoutTimers.get(e);
		void 0 !== t && (clearTimeout(t), this.socketTimeoutTimers.delete(e));
	}
	removePendingPipeReader(e) {
		for (const [t, n] of this.pendingPipeReaders) {
			const i = n.filter((t) => t.channel !== e);
			0 === i.length ? this.pendingPipeReaders.delete(t) : i.length !== n.length && this.pendingPipeReaders.set(t, i);
		}
	}
	removePendingPipeWriter(e) {
		for (const [t, n] of this.pendingPipeWriters) {
			const i = n.filter((t) => t.channel !== e);
			0 === i.length ? this.pendingPipeWriters.delete(t) : i.length !== n.length && this.pendingPipeWriters.set(t, i);
		}
	}
	handleThreadCancel(e, t) {
		const n = t[0], i = this.processes.get(e.pid);
		if (this.completeChannelRaw(e, 0, 0), this.relistenChannel(e), !i) return;
		let s;
		for (const l of i.channels) {
			const t = this.channelTids.get(`${e.pid}:${l.channelOffset}`);
			if ((void 0 !== t ? t : e.pid) === n) {
				s = l;
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
		for (const [l, h] of this.pendingPipeReaders) {
			const e = h.filter((e) => e.channel !== s);
			e.length !== h.length && (0 === e.length ? this.pendingPipeReaders.delete(l) : this.pendingPipeReaders.set(l, e), c = !0);
		}
		for (const [l, h] of this.pendingPipeWriters) {
			const e = h.filter((e) => e.channel !== s);
			e.length !== h.length && (0 === e.length ? this.pendingPipeWriters.delete(l) : this.pendingPipeWriters.set(l, e), c = !0);
		}
		c && (this.clearSocketTimeout(s), this.completeChannelRaw(s, -4, 4), this.relistenChannel(s));
	}
	dumpProfile() {
		if (!this.profileData) return void console.error("[profile] Profiling not enabled. Set WASM_POSIX_PROFILE=1");
		const e = Array.from(this.profileData.entries()).sort((e, t) => t[1].totalTimeMs - e[1].totalTimeMs);
		let t = 0, n = 0, i = 0;
		console.error("\n=== Syscall Profile ==="), console.error(`${"Syscall".padEnd(8)} ${"Count".padStart(10)} ${"Time(ms)".padStart(12)} ${"Avg(ms)".padStart(10)} ${"Retries".padStart(10)}`), console.error("-".repeat(52));
		for (const [s, r] of e) t += r.count, n += r.totalTimeMs, i += r.retries, console.error(`${String(s).padEnd(8)} ${String(r.count).padStart(10)} ${r.totalTimeMs.toFixed(2).padStart(12)} ${(r.totalTimeMs / r.count).toFixed(3).padStart(10)} ${String(r.retries).padStart(10)}`);
		console.error("-".repeat(52)), console.error(`${"TOTAL".padEnd(8)} ${String(t).padStart(10)} ${n.toFixed(2).padStart(12)} ${(n / (t || 1)).toFixed(3).padStart(10)} ${String(i).padStart(10)}`), console.error(`Pending pipe readers: ${this.pendingPipeReaders.size}, writers: ${this.pendingPipeWriters.size}`), console.error("=== End Profile ===\n");
	}
	flushTcpSendPipes(e) {
		const t = this.tcpConnections.get(e);
		if (!t || 0 === t.length) return;
		const n = this.kernelInstance.exports.kernel_pipe_read, i = this.getKernelMem();
		for (const s of t) {
			for (;;) {
				const e = n(0, s.sendPipeIdx, this.toKernelPtr(s.scratchOffset), 65536);
				if (e <= 0) break;
				const t = Buffer.from(i.slice(s.scratchOffset, s.scratchOffset + e));
				s.clientSocket.destroyed || s.clientSocket.write(t);
			}
			s.schedulePump();
		}
	}
	handleBlockingRetry(e, t, n) {
		if (!this.processes.has(e.pid)) return;
		if (t === Xt && !(127 & n[1])) {
			const t = n[0], i = n[2], s = new Int32Array(e.memory.buffer), r = t >>> 2;
			if (Atomics.load(s, r) !== i) return void this.retrySyscall(e);
			const o = Atomics.waitAsync(s, r, i);
			o.async ? o.value.then(() => {
				this.processes.has(e.pid) && this.retrySyscall(e);
			}) : setImmediate(() => this.retrySyscall(e));
			return;
		}
		if (t === Yt || t === Jt) {
			let i = -1;
			const s = t === Jt && 0 !== n[3];
			if (t === Yt) i = n[2];
			else {
				const t = n[2];
				if (0 !== t) {
					const n = new DataView(e.memory.buffer, t), s = Number(n.getBigInt64(0, !0)), r = Number(n.getBigInt64(8, !0));
					i = 1e3 * s + Math.floor(r / 1e6);
				}
			}
			if (0 === i) return void this.completeChannel(e, t, n, xt[t], 0, 0);
			const { pipeIndices: r, acceptIndices: o } = this.resolvePollReadinessIndices(e.pid, n), a = n[1];
			if (i > 0 && 0 === a) {
				const a = setTimeout(() => {
					this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.completeChannel(e, t, n, xt[t], 0, 0);
				}, i);
				this.pendingPollRetries.set(e.channelOffset, {
					timer: a,
					channel: e,
					pipeIndices: r,
					acceptIndices: o,
					needsSignalSafeWake: s,
					deadline: Date.now() + i
				});
				return;
			}
			const c = i > 0 ? Date.now() + i : -1, l = () => {
				this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && (c > 0 && Date.now() >= c ? this.completeChannel(e, t, n, xt[t], 0, 0) : this.retrySyscall(e));
			}, h = r.length > 0 || o.length > 0 ? c > 0 ? Math.min(c - Date.now(), 10) : 10 : c > 0 ? Math.min(c - Date.now(), 50) : 50, d = setTimeout(l, Math.max(h, 1));
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
		if (t === on) {
			const i = n[2];
			if (0 === i) return void setTimeout(() => {
				this.processes.has(e.pid) && this.retrySyscall(e);
			}, 500);
			const s = new DataView(e.memory.buffer, i), r = Number(s.getBigInt64(0, !0)), o = Number(s.getBigInt64(8, !0)), a = 1e3 * r + Math.floor(o / 1e6), c = 11;
			a <= 0 ? this.completeChannel(e, t, n, xt[t], -1, c) : setTimeout(() => {
				this.processes.has(e.pid) && this.completeChannel(e, t, n, xt[t], -1, c);
			}, a);
			return;
		}
		if (function(e, t) {
			let n;
			switch (e) {
				case Cn:
				case Tn:
				case zn:
				case On:
					n = t[3];
					break;
				case Rn:
				case Fn:
					n = t[2];
					break;
				default: return !1;
			}
			return void 0 !== n && !!(64 & n);
		}(t, n)) return void this.completeChannel(e, t, n, xt[t], -1, Ht);
		if (Zn.has(t) || Qn.has(t) || t === Ln || t === Nn || t === $n) {
			const i = n[0], s = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (s && 1 === s(e.pid, i)) return void this.completeChannel(e, t, n, xt[t], -1, Ht);
		}
		if (t === Xn || t === Yn) {
			const i = n[0], s = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (s && 1 === s(e.pid, i)) return void this.completeChannel(e, t, n, xt[t], -1, Ht);
		}
		if (Zn.has(t) || Qn.has(t)) {
			const i = n[0], s = this.kernelInstance.exports.kernel_get_socket_timeout_ms;
			if (s && !this.socketTimeoutTimers.has(e)) {
				const r = Zn.has(t) ? 1 : 0, o = Number(s(e.pid, i, r));
				if (o > 0) {
					const i = setTimeout(() => {
						this.socketTimeoutTimers.delete(e), this.removePendingPipeReader(e), this.processes.has(e.pid) && this.completeChannel(e, t, n, xt[t], -1, 110);
					}, o);
					this.socketTimeoutTimers.set(e, i);
				}
			}
		}
		if (Zn.has(t)) {
			const i = n[0], s = this.kernelInstance.exports.kernel_get_fd_pipe_idx;
			if (s) {
				const n = s(e.pid, i);
				if (n >= 0) {
					let i = this.pendingPipeReaders.get(n);
					if (i || (i = [], this.pendingPipeReaders.set(n, i)), i.some((t) => t.channel === e) || i.push({
						channel: e,
						pid: e.pid
					}), Jn) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (Qn.has(t)) {
			const i = n[0], s = this.kernelInstance.exports.kernel_get_fd_send_pipe_idx;
			if (s) {
				const n = s(e.pid, i);
				if (n >= 0) {
					let i = this.pendingPipeWriters.get(n);
					if (i || (i = [], this.pendingPipeWriters.set(n, i)), i.some((t) => t.channel === e) || i.push({
						channel: e,
						pid: e.pid
					}), Jn) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (t === Ln || t === Nn) {
			const i = n[0], s = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
			if (s) {
				const n = s(e.pid, i);
				if (n >= 0) {
					const i = setTimeout(() => {
						this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.retrySyscall(e);
					}, 10);
					if (this.pendingPollRetries.set(e.channelOffset, {
						timer: i,
						channel: e,
						pipeIndices: [],
						acceptIndices: [n]
					}), Jn) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (Jn) {
			const e = this.profileData.get(t);
			e && e.retries++;
		}
		const i = setTimeout(() => {
			this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.retrySyscall(e);
		}, 10);
		this.pendingPollRetries.set(e.channelOffset, {
			timer: i,
			channel: e,
			pipeIndices: []
		});
	}
	retrySyscall(e) {
		const t = this.kernelInstance.exports.kernel_get_process_exit_status;
		t && t(e.pid) >= 128 ? this.handleProcessTerminated(e) : this.handleSyscall(e);
	}
	handleSleepDelay(e, t, n, i, s) {
		let r = 0;
		if (t === qt && i >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), n = e.getUint32(80, !0);
			r = 1e3 * t + Math.floor(n / 1e6);
		} else if (t === Gt && i >= 0) {
			const e = n[0] >>> 0;
			r = Math.max(1, Math.floor(e / 1e3));
		} else if (t === jt && i >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), n = e.getUint32(80, !0);
			r = 1e3 * t + Math.floor(n / 1e6);
		}
		if (r > 0) {
			const o = setTimeout(() => {
				this.pendingSleeps.delete(e.pid), this.processes.has(e.pid) && this.completeSleepWithSignalCheck(e, t, n, i, s);
			}, r);
			return this.pendingSleeps.set(e.pid, {
				timer: o,
				channel: e,
				syscallNr: t,
				origArgs: n,
				retVal: i,
				errVal: s
			}), !0;
		}
		return !1;
	}
	completeSleepWithSignalCheck(e, t, n, i, s) {
		this.dequeueSignalForDelivery(e), new DataView(e.memory.buffer, e.channelOffset).getUint32(65560, !0) > 0 ? this.completeChannel(e, t, n, xt[t], -1, 4) : this.completeChannel(e, t, n, xt[t], i, s);
	}
	handleFcntlLock(e, t) {
		const n = t[2], i = new Uint8Array(e.memory.buffer), s = this.getKernelMem(), r = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72;
		0 !== n && s.set(i.subarray(n, n + 32), o), r.setUint32(4, Hn, !0), r.setBigInt64(8, BigInt(t[0]), !0), r.setBigInt64(16, BigInt(t[1]), !0), r.setBigInt64(24, BigInt(0 !== n ? o : 0), !0);
		for (let d = 3; d < 6; d++) r.setBigInt64(8 + 8 * d, BigInt(t[d]), !0);
		const a = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			a(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const c = Number(r.getBigInt64(56, !0)), l = r.getUint32(64, !0);
		0 !== n && c >= 0 && new Uint8Array(e.memory.buffer).set(s.subarray(o, o + 32), n);
		const h = t[1];
		-1 !== c || l !== Ht || 7 !== h && 14 !== h && 38 !== h ? this.completeChannel(e, Hn, t, void 0, c, l) : this.handleBlockingRetry(e, Hn, t);
	}
	handleSelect(e, t) {
		const n = 128, i = t[0], s = t[1], r = t[2], o = t[3], a = t[4];
		let c = -1;
		if (0 !== a) {
			const t = this.getPtrWidth(e.pid), n = new DataView(e.memory.buffer, a);
			let i, s;
			8 === t ? (i = Number(n.getBigInt64(0, !0)), s = Number(n.getBigInt64(8, !0))) : (i = n.getInt32(0, !0), s = n.getInt32(4, !0)), c = 1e3 * i + Math.floor(s / 1e3), c < 0 && (c = 0);
		}
		if (0 === i && 0 === s && 0 === r && 0 === o) {
			if (0 === c) return void this.completeChannel(e, Qt, t, void 0, 0, 0);
			const n = c > 0, i = n ? setTimeout(() => {
				this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.completeChannel(e, Qt, t, void 0, 0, 0);
			}, c) : null;
			this.pendingSelectRetries.set(e.channelOffset, {
				timer: i,
				channel: e,
				origArgs: t,
				deadline: n ? Date.now() + c : -1,
				needsSignalSafeWake: !1,
				syscallNr: Qt
			});
			return;
		}
		const l = new Uint8Array(e.memory.buffer), h = this.getKernelMem(), d = new DataView(this.kernelMemory.buffer, this.scratchOffset), f = this.scratchOffset + 72;
		0 !== s ? h.set(l.subarray(s, s + n), f) : h.fill(0, f, f + n), 0 !== r ? h.set(l.subarray(r, r + n), f + n) : h.fill(0, f + n, f + 256), 0 !== o ? h.set(l.subarray(o, o + n), f + 256) : h.fill(0, f + 256, f + 384), d.setUint32(4, Qt, !0), d.setBigInt64(8, BigInt(i), !0), d.setBigInt64(16, BigInt(0 !== s ? f : 0), !0), d.setBigInt64(24, BigInt(0 !== r ? f + n : 0), !0), d.setBigInt64(32, BigInt(0 !== o ? f + 256 : 0), !0), d.setBigInt64(40, BigInt(c), !0);
		const u = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			u(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const g = Number(d.getBigInt64(56, !0)), p = d.getUint32(64, !0);
		if (g >= 0) {
			const t = new Uint8Array(e.memory.buffer);
			0 !== s && t.set(h.subarray(f, f + n), s), 0 !== r && t.set(h.subarray(f + n, f + 256), r), 0 !== o && t.set(h.subarray(f + 256, f + 384), o);
		}
		if (this.dequeueSignalForDelivery(e), -1 === g && p === Ht) {
			if (0 === c) return void this.completeChannel(e, Qt, t, void 0, 0, 0);
			const n = c > 0 ? Date.now() + c : -1, i = () => {
				this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && (n > 0 && Date.now() >= n ? this.completeChannel(e, Qt, t, void 0, 0, 0) : this.handleSelect(e, t));
			}, s = c > 0 ? Math.max(n - Date.now(), 1) : 50, r = setTimeout(i, Math.min(s, 50));
			this.pendingSelectRetries.set(e.channelOffset, {
				timer: r,
				channel: e,
				origArgs: t,
				deadline: n,
				needsSignalSafeWake: !1,
				syscallNr: Qt
			});
			return;
		}
		this.completeChannel(e, Qt, t, void 0, g, p);
	}
	handlePselect6(e, t) {
		const n = 128, i = new Uint8Array(e.memory.buffer), s = this.getKernelMem(), r = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72, a = t[0], c = t[1], l = t[2], h = t[3], d = t[4], f = t[5];
		0 !== c ? s.set(i.subarray(c, c + n), o) : s.fill(0, o, o + n), 0 !== l ? s.set(i.subarray(l, l + n), o + n) : s.fill(0, o + n, o + 256), 0 !== h ? s.set(i.subarray(h, h + n), o + 256) : s.fill(0, o + 256, o + 384);
		let u = -1;
		if (0 !== d) {
			const t = new DataView(e.memory.buffer, d), n = Number(t.getBigInt64(0, !0)), i = Number(t.getBigInt64(8, !0));
			u = 1e3 * n + Math.floor(i / 1e6);
		}
		const g = o + 384;
		let p = 0;
		if (0 !== f) {
			const t = this.getPtrWidth(e.pid), n = new DataView(e.memory.buffer, f), r = 8 === t ? Number(n.getBigUint64(0, !0)) : n.getUint32(0, !0);
			0 !== r && (s.set(i.subarray(r, r + 8), g), p = g);
		}
		r.setUint32(4, Zt, !0), r.setBigInt64(8, BigInt(a), !0), r.setBigInt64(16, BigInt(0 !== c ? o : 0), !0), r.setBigInt64(24, BigInt(0 !== l ? o + n : 0), !0), r.setBigInt64(32, BigInt(0 !== h ? o + 256 : 0), !0), r.setBigInt64(40, BigInt(u), !0), r.setBigInt64(48, BigInt(p), !0);
		const m = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			m(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const y = Number(r.getBigInt64(56, !0)), w = r.getUint32(64, !0);
		if (y >= 0) {
			const t = new Uint8Array(e.memory.buffer);
			0 !== c && t.set(s.subarray(o, o + n), c), 0 !== l && t.set(s.subarray(o + n, o + 256), l), 0 !== h && t.set(s.subarray(o + 256, o + 384), h);
		}
		if (this.dequeueSignalForDelivery(e), -1 === y && w === Ht) {
			if (0 === u) return void this.completeChannel(e, Zt, t, void 0, 0, 0);
			const n = u > 0 ? Date.now() + u : -1, i = 0 !== f;
			if (0 === a) {
				if (u > 0) {
					const s = setTimeout(() => {
						this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.completeChannel(e, Zt, t, void 0, 0, 0);
					}, u);
					this.pendingSelectRetries.set(e.channelOffset, {
						timer: s,
						channel: e,
						origArgs: t,
						deadline: n,
						needsSignalSafeWake: i,
						syscallNr: Zt
					});
				} else this.pendingSelectRetries.set(e.channelOffset, {
					timer: null,
					channel: e,
					origArgs: t,
					deadline: -1,
					needsSignalSafeWake: i,
					syscallNr: Zt
				});
				return;
			}
			const s = setImmediate(() => {
				this.pendingSelectRetries.delete(e.channelOffset), this.processes.has(e.pid) && (n > 0 && Date.now() >= n ? this.completeChannel(e, Zt, t, void 0, 0, 0) : this.handlePselect6(e, t));
			});
			this.pendingSelectRetries.set(e.channelOffset, {
				timer: s,
				channel: e,
				origArgs: t,
				deadline: n,
				needsSignalSafeWake: i,
				syscallNr: Zt
			});
			return;
		}
		this.completeChannel(e, Zt, t, void 0, y, w);
	}
	handleEpollCreate(e, t, n) {
		const i = new DataView(this.kernelMemory.buffer, this.scratchOffset), s = n[0], r = t === nn ? 0 : s;
		i.setUint32(4, t, !0), i.setBigInt64(8, BigInt(r), !0);
		for (let l = 1; l < 6; l++) i.setBigInt64(8 + 8 * l, 0n, !0);
		const o = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			o(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const a = Number(i.getBigInt64(56, !0)), c = i.getUint32(64, !0);
		if (a >= 0) {
			const t = `${e.pid}:${a}`;
			this.epollInterests.set(t, []);
		}
		this.completeChannel(e, t, n, void 0, a, c);
	}
	handleEpollCtl(e, t) {
		const n = t[0], i = t[1], s = t[2], r = t[3];
		let o = 0, a = 0n;
		if (0 !== r) {
			const t = new DataView(e.memory.buffer, r);
			o = t.getUint32(0, !0), a = t.getBigUint64(4, !0);
		}
		const c = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.getKernelMem(), h = this.scratchOffset + 72;
		if (0 !== r) {
			const t = new Uint8Array(e.memory.buffer);
			l.set(t.subarray(r, r + 12), h);
		}
		c.setUint32(4, sn, !0), c.setBigInt64(8, BigInt(n), !0), c.setBigInt64(16, BigInt(i), !0), c.setBigInt64(24, BigInt(s), !0), c.setBigInt64(32, BigInt(0 !== r ? h : 0), !0), c.setBigInt64(40, BigInt(0), !0), c.setBigInt64(48, BigInt(0), !0);
		const d = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			d(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const f = Number(c.getBigInt64(56, !0)), u = c.getUint32(64, !0);
		if (0 === f) {
			const t = 1, r = 2, c = 3, l = `${e.pid}:${n}`;
			let h = this.epollInterests.get(l);
			if (h || (h = [], this.epollInterests.set(l, h)), i === t) h.push({
				fd: s,
				events: o,
				data: a
			});
			else if (i === r) {
				const e = h.findIndex((e) => e.fd === s);
				e >= 0 && h.splice(e, 1);
			} else if (i === c) {
				const e = h.find((e) => e.fd === s);
				e && (e.events = o, e.data = a);
			}
		}
		this.completeChannel(e, sn, t, void 0, f, u);
	}
	handleEpollPwait(e, t, n) {
		const i = n[0], s = n[1], r = n[2], o = n[3];
		if (r <= 0) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const a = `${e.pid}:${i}`, c = this.epollInterests.get(a);
		if (!c) return this.completeChannelRaw(e, -9, 9), void this.relistenChannel(e);
		if (0 === c.length) {
			if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
			const i = setTimeout(() => {
				this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.handleEpollPwait(e, t, n);
			}, 10);
			this.pendingPollRetries.set(e.channelOffset, {
				timer: i,
				channel: e,
				pipeIndices: []
			});
			return;
		}
		const l = c.length;
		if (8 * l > 65536) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		this.getKernelMem();
		const h = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72;
		for (let b = 0; b < l; b++) {
			const e = c[b], t = d + 8 * b;
			let n = 0;
			1 & e.events && (n |= 1), 4 & e.events && (n |= 4), new DataView(this.kernelMemory.buffer).setInt32(t, e.fd, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 4, n, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 6, 0, !0);
		}
		h.setUint32(4, Yt, !0), h.setBigInt64(8, BigInt(d), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(0), !0);
		for (let b = 3; b < 6; b++) h.setBigInt64(8 + 8 * b, 0n, !0);
		const f = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			f(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const u = Number(h.getBigInt64(56, !0)), g = h.getUint32(64, !0);
		if (this.dequeueSignalForDelivery(e), u < 0 && g !== Ht) return this.completeChannelRaw(e, u, g), void this.relistenChannel(e);
		let p = 0;
		if (u > 0) {
			const t = new DataView(e.memory.buffer);
			for (let e = 0; e < l && p < r; e++) {
				const n = d + 8 * e, i = new DataView(this.kernelMemory.buffer).getInt16(n + 6, !0);
				if (0 !== i) {
					let n = 0;
					1 & i && (n |= 1), 4 & i && (n |= 4), 8 & i && (n |= 8), 16 & i && (n |= 16);
					const r = s + 12 * p;
					t.setUint32(r, n, !0), t.setBigUint64(r + 4, c[e].data, !0), p++;
				}
			}
		}
		if (p > 0) return this.completeChannelRaw(e, p, 0), void this.relistenChannel(e);
		if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
		const { pipeIndices: m, acceptIndices: y } = this.resolveEpollReadinessIndices(e.pid), w = setTimeout(() => {
			this.pendingPollRetries.delete(e.channelOffset), this.processes.has(e.pid) && this.handleEpollPwait(e, t, n);
		}, 10);
		this.pendingPollRetries.set(e.channelOffset, {
			timer: w,
			channel: e,
			pipeIndices: m,
			acceptIndices: y
		});
	}
	handleIoctlIfconf(e, t) {
		const n = new DataView(e.memory.buffer), i = new Uint8Array(e.memory.buffer), s = this.getPtrWidth(e.pid), r = t[2], o = n.getInt32(r, !0);
		let a;
		a = 8 === s ? Number(n.getBigUint64(r + 8, !0)) : n.getUint32(r + 4, !0);
		if (o >= 32 && 0 !== a) {
			const e = new TextEncoder().encode("eth0");
			i.set(e, a), i.fill(0, a + e.length, a + 16), i.fill(0, a + 16, a + 32), n.setUint16(a + 16, 2, !0), i[a + 20] = 127, i[a + 21] = 0, i[a + 22] = 0, i[a + 23] = 1, n.setInt32(r, 32, !0);
		} else n.setInt32(r, 0, !0);
		this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	handleIoctlIfhwaddr(e, t) {
		const n = new DataView(e.memory.buffer), i = new Uint8Array(e.memory.buffer), s = t[2];
		i.fill(0, s + 16, s + 32), n.setUint16(s + 16, 1, !0), i.set(this.virtualMacAddress, s + 18), this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	handleIoctlIfaddr(e, t) {
		const n = new DataView(e.memory.buffer), i = new Uint8Array(e.memory.buffer), s = t[2];
		i.fill(0, s + 16, s + 32), n.setUint16(s + 16, 2, !0), i[s + 20] = 127, i[s + 21] = 0, i[s + 22] = 0, i[s + 23] = 1, this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	handleWritev(e, t, n) {
		const i = n[0], s = n[1], r = n[2], o = new Uint8Array(e.memory.buffer), a = new DataView(e.memory.buffer), c = this.getKernelMem(), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.scratchOffset + 72, d = this.getPtrWidth(e.pid), f = 8 === d ? 16 : 8, u = [];
		let g = 0;
		for (let m = 0; m < r; m++) {
			let e, t;
			8 === d ? (e = Number(a.getBigUint64(s + m * f, !0)), t = Number(a.getBigUint64(s + m * f + 8, !0))) : (e = a.getUint32(s + m * f, !0), t = a.getUint32(s + m * f + 4, !0)), u.push({
				base: e,
				len: t
			}), g += t;
		}
		const p = 8 * r;
		if (g <= ne - p) {
			let s = p;
			for (let e = 0; e < r; e++) {
				const t = h + s;
				u[e].len > 0 && c.set(o.subarray(u[e].base, u[e].base + u[e].len), t);
				const n = h + 8 * e;
				new DataView(c.buffer).setUint32(n, t, !0), new DataView(c.buffer).setUint32(n + 4, u[e].len, !0), s += u[e].len, s = s + 3 & -4;
			}
			l.setUint32(4, t, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(r), !0), t === Vn && (l.setBigInt64(32, BigInt(n[3]), !0), l.setBigInt64(40, BigInt(n[4]), !0));
			const a = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				a(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const d = Number(l.getBigInt64(56, !0)), f = l.getUint32(64, !0);
			if (-1 === d && f === Ht) return void this.handleBlockingRetry(e, t, n);
			this.completeChannel(e, t, n, void 0, d, f);
		} else {
			const s = this.kernelInstance.exports.kernel_handle_channel, r = t === Vn;
			let a = r ? (0 | n[3]) + 4294967296 * (0 | n[4]) : 0, d = 0, f = !1;
			const g = 65528;
			for (const t of u) {
				if (0 === t.len) continue;
				let n = 0;
				for (; n < t.len;) {
					const u = Math.min(t.len - n, g), p = h + 8;
					c.set(o.subarray(t.base + n, t.base + n + u), p), new DataView(c.buffer).setUint32(h, p, !0), new DataView(c.buffer).setUint32(h + 4, u, !0), r ? (l.setUint32(4, Vn, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0), l.setBigInt64(32, BigInt(4294967295 & a), !0), l.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (l.setUint32(4, Dn, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0)), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
					try {
						s(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					const m = Number(l.getBigInt64(56, !0)), y = l.getUint32(64, !0);
					if (-1 === m) {
						y === Ht && 0 === d && (f = !0);
						break;
					}
					if (n += m, d += m, r && (a += m), m < u) break;
				}
				if (f || n < t.len) break;
			}
			if (f) return void this.handleBlockingRetry(e, t, n);
			this.completeChannelRaw(e, d, 0), this.relistenChannel(e);
		}
	}
	handleLargeWrite(e, t, n) {
		const i = n[0], s = n[1], r = n[2], o = t === En;
		let a = o ? n[3] : 0;
		const c = new Uint8Array(e.memory.buffer), l = this.getKernelMem(), h = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72, f = this.kernelInstance.exports.kernel_handle_channel;
		let u = 0;
		for (; u < r;) {
			const g = Math.min(r - u, ne);
			l.set(c.subarray(s + u, s + u + g), d), h.setUint32(4, t, !0), h.setBigInt64(8, BigInt(i), !0), h.setBigInt64(16, BigInt(d), !0), h.setBigInt64(24, BigInt(g), !0), o && h.setBigInt64(32, BigInt(a), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				f(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (zi) {
				console.error(`[handleLargeWrite] kernel threw for pid=${e.pid}:`, zi), u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			const p = Number(h.getBigInt64(56, !0)), m = h.getUint32(64, !0);
			if (-1 === p && m === Ht) return u > 0 ? (this.completeChannelRaw(e, u, 0), void this.relistenChannel(e)) : void this.handleBlockingRetry(e, t, n);
			if (0 !== m || p <= 0) return u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, p, m), void this.relistenChannel(e);
			if (u += p, o && (a += p), p < g) break;
		}
		this.dequeueSignalForDelivery(e), this.completeChannelRaw(e, u, 0), this.relistenChannel(e);
	}
	handleLargeRead(e, t, n) {
		const i = n[0], s = n[1], r = n[2], o = t === Mn;
		let a = o ? n[3] : 0;
		const c = new Uint8Array(e.memory.buffer), l = this.getKernelMem(), h = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72, f = this.kernelInstance.exports.kernel_handle_channel;
		let u = 0;
		for (; u < r;) {
			const g = Math.min(r - u, ne);
			l.fill(0, d, d + g), h.setUint32(4, t, !0), h.setBigInt64(8, BigInt(i), !0), h.setBigInt64(16, BigInt(d), !0), h.setBigInt64(24, BigInt(g), !0), o && h.setBigInt64(32, BigInt(a), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				f(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (zi) {
				console.error(`[handleLargeRead] kernel threw for pid=${e.pid}:`, zi), u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			const p = Number(h.getBigInt64(56, !0)), m = h.getUint32(64, !0);
			if (-1 === p && m === Ht) return u > 0 ? (this.completeChannelRaw(e, u, 0), void this.relistenChannel(e)) : void this.handleBlockingRetry(e, t, n);
			if (0 !== m || p <= 0) return u > 0 ? this.completeChannelRaw(e, u, 0) : this.completeChannelRaw(e, p, m), void this.relistenChannel(e);
			if (c.set(l.subarray(d, d + p), s + u), u += p, o && (a += p), p < g) break;
		}
		this.dequeueSignalForDelivery(e), this.completeChannelRaw(e, u, 0), this.relistenChannel(e);
	}
	handleReadv(e, t, n) {
		const i = n[0], s = n[1], r = n[2], o = new Uint8Array(e.memory.buffer), a = new DataView(e.memory.buffer), c = this.getKernelMem(), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.scratchOffset + 72, d = this.getPtrWidth(e.pid), f = 8 === d ? 16 : 8, u = [];
		let g = 0;
		for (let p = 0; p < r; p++) {
			let e, t;
			8 === d ? (e = Number(a.getBigUint64(s + p * f, !0)), t = Number(a.getBigUint64(s + p * f + 8, !0))) : (e = a.getUint32(s + p * f, !0), t = a.getUint32(s + p * f + 4, !0)), u.push({
				base: e,
				len: t
			}), g += t;
		}
		if (g <= 65528 && r <= Math.floor(8192)) {
			let s = 8 * r;
			const a = [];
			for (let e = 0; e < r; e++) {
				const t = h + s;
				a.push({
					base: u[e].base,
					kernelBase: t,
					len: u[e].len
				}), u[e].len > 0 && c.fill(0, t, t + u[e].len);
				const n = h + 8 * e;
				new DataView(c.buffer).setUint32(n, t, !0), new DataView(c.buffer).setUint32(n + 4, u[e].len, !0), s += u[e].len, s = s + 3 & -4;
			}
			l.setUint32(4, t, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(r), !0), t === Kn && (l.setBigInt64(32, BigInt(n[3]), !0), l.setBigInt64(40, BigInt(n[4]), !0));
			const d = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				d(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const f = Number(l.getBigInt64(56, !0)), g = l.getUint32(64, !0);
			if (-1 === f && g === Ht) return void this.handleBlockingRetry(e, t, n);
			if (f > 0) {
				let e = f;
				for (const t of a) {
					if (e <= 0) break;
					const n = Math.min(t.len, e);
					o.set(c.subarray(t.kernelBase, t.kernelBase + n), t.base), e -= n;
				}
			}
			this.completeChannel(e, t, n, void 0, f, g);
		} else {
			const s = this.kernelInstance.exports.kernel_handle_channel, r = t === Kn;
			let a = r ? (0 | n[3]) + 4294967296 * (0 | n[4]) : 0, d = 0, f = 0, g = !1;
			for (const t of u) {
				if (0 === t.len) continue;
				let n = 0;
				for (; n < t.len;) {
					const u = Math.min(t.len - n, 65528), p = h + 8;
					new DataView(c.buffer).setUint32(h, p, !0), new DataView(c.buffer).setUint32(h + 4, u, !0), c.fill(0, p, p + u), r ? (l.setUint32(4, Kn, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0), l.setBigInt64(32, BigInt(4294967295 & a), !0), l.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (l.setUint32(4, Wn, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0)), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
					try {
						s(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					const m = Number(l.getBigInt64(56, !0)), y = l.getUint32(64, !0);
					if (-1 === m) {
						if (y === Ht && 0 === d) {
							g = !0;
							break;
						}
						f = y;
						break;
					}
					if (0 === m) break;
					if (o.set(c.subarray(p, p + m), t.base + n), n += m, d += m, r && (a += m), m < u) break;
				}
				if (g || f) break;
			}
			if (g) return void this.handleBlockingRetry(e, t, n);
			const p = d > 0 ? d : f ? -1 : 0, m = d > 0 ? 0 : f;
			this.completeChannel(e, t, n, void 0, p, m);
		}
	}
	handleSendmsg(e, t) {
		const n = t[0], i = t[1], s = t[2], r = new Uint8Array(e.memory.buffer), o = new DataView(e.memory.buffer), a = this.getKernelMem(), c = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.scratchOffset + 72, h = this.getPtrWidth(e.pid);
		let d, f, u, g, p, m;
		8 === h ? (d = Number(o.getBigUint64(i, !0)), f = o.getUint32(i + 8, !0), u = Number(o.getBigUint64(i + 16, !0)), g = o.getUint32(i + 24, !0), p = Number(o.getBigUint64(i + 32, !0)), m = o.getUint32(i + 40, !0)) : (d = o.getUint32(i, !0), f = o.getUint32(i + 4, !0), u = o.getUint32(i + 8, !0), g = o.getUint32(i + 12, !0), p = o.getUint32(i + 16, !0), m = o.getUint32(i + 20, !0));
		const y = l, w = new DataView(a.buffer);
		w.setUint32(y, d, !0), w.setUint32(y + 4, f, !0), w.setUint32(y + 8, u, !0), w.setUint32(y + 12, g, !0), w.setUint32(y + 16, p, !0), w.setUint32(y + 20, m, !0), w.setUint32(y + 24, 0, !0);
		let b = 28;
		if (0 !== d && f > 0 && b + f <= 65536) {
			const e = l + b;
			a.set(r.subarray(d, d + f), e), w.setUint32(y, e, !0), b += f, b = b + 3 & -4;
		}
		if (0 !== p && m > 0 && b + m <= 65536) {
			const e = l + b;
			a.set(r.subarray(p, p + m), e), w.setUint32(y + 16, e, !0), b += m, b = b + 3 & -4;
		}
		const k = 8 === h ? 16 : 8;
		if (g > 0 && 0 !== u) {
			const e = l + b;
			b += 8 * g, b = b + 3 & -4, w.setUint32(y + 8, e, !0);
			for (let t = 0; t < g; t++) {
				let n, i;
				if (8 === h ? (n = Number(o.getBigUint64(u + t * k, !0)), i = Number(o.getBigUint64(u + t * k + 8, !0))) : (n = o.getUint32(u + 8 * t, !0), i = o.getUint32(u + 8 * t + 4, !0)), w.setUint32(e + 8 * t, 0, !0), w.setUint32(e + 8 * t + 4, i, !0), i > 0 && b + i <= 65536) {
					const s = l + b;
					a.set(r.subarray(n, n + i), s), w.setUint32(e + 8 * t, s, !0), b += i, b = b + 3 & -4;
				}
			}
		}
		c.setUint32(4, Rn, !0), c.setBigInt64(8, BigInt(n), !0), c.setBigInt64(16, BigInt(y), !0), c.setBigInt64(24, BigInt(s), !0);
		const I = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			I(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const v = Number(c.getBigInt64(56, !0)), x = c.getUint32(64, !0);
		-1 !== v || x !== Ht ? this.completeChannel(e, Rn, t, void 0, v, x) : this.handleBlockingRetry(e, Rn, t);
	}
	handleRecvmsg(e, t) {
		const n = t[0], i = t[1], s = t[2], r = new Uint8Array(e.memory.buffer), o = new DataView(e.memory.buffer), a = this.getKernelMem(), c = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.scratchOffset + 72, h = this.getPtrWidth(e.pid);
		let d, f, u, g, p, m;
		8 === h ? (d = Number(o.getBigUint64(i, !0)), f = o.getUint32(i + 8, !0), u = Number(o.getBigUint64(i + 16, !0)), g = o.getUint32(i + 24, !0), p = Number(o.getBigUint64(i + 32, !0)), m = o.getUint32(i + 40, !0)) : (d = o.getUint32(i, !0), f = o.getUint32(i + 4, !0), u = o.getUint32(i + 8, !0), g = o.getUint32(i + 12, !0), p = o.getUint32(i + 16, !0), m = o.getUint32(i + 20, !0));
		const y = l, w = new DataView(a.buffer);
		w.setUint32(y, d, !0), w.setUint32(y + 4, f, !0), w.setUint32(y + 8, u, !0), w.setUint32(y + 12, g, !0), w.setUint32(y + 16, p, !0), w.setUint32(y + 20, m, !0), w.setUint32(y + 24, 0, !0);
		let b = 28, k = 0;
		0 !== d && f > 0 && b + f <= 65536 && (k = l + b, a.fill(0, k, k + f), w.setUint32(y, k, !0), b += f, b = b + 3 & -4);
		let I = 0;
		0 !== p && m > 0 && b + m <= 65536 && (I = l + b, a.fill(0, I, I + m), w.setUint32(y + 16, I, !0), b += m, b = b + 3 & -4);
		const v = [], x = 8 === h ? 16 : 8;
		if (g > 0 && 0 !== u) {
			const e = l + b;
			b += 8 * g, b = b + 3 & -4, w.setUint32(y + 8, e, !0);
			for (let t = 0; t < g; t++) {
				let n, i;
				if (8 === h ? (n = Number(o.getBigUint64(u + t * x, !0)), i = Number(o.getBigUint64(u + t * x + 8, !0))) : (n = o.getUint32(u + 8 * t, !0), i = o.getUint32(u + 8 * t + 4, !0)), i > 0 && b + i <= 65536) {
					const s = l + b;
					a.fill(0, s, s + i), w.setUint32(e + 8 * t, s, !0), w.setUint32(e + 8 * t + 4, i, !0), v.push({
						base: n,
						len: i,
						kernelBase: s
					}), b += i, b = b + 3 & -4;
				} else w.setUint32(e + 8 * t, 0, !0), w.setUint32(e + 8 * t + 4, i, !0);
			}
		}
		c.setUint32(4, Fn, !0), c.setBigInt64(8, BigInt(n), !0), c.setBigInt64(16, BigInt(y), !0), c.setBigInt64(24, BigInt(s), !0);
		const _ = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			_(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const P = Number(c.getBigInt64(56, !0)), B = c.getUint32(64, !0);
		if (-1 === P && B === Ht) return void this.handleBlockingRetry(e, Fn, t);
		if (P > 0) {
			let e = P;
			for (const t of v) {
				if (e <= 0) break;
				const n = Math.min(t.len, e);
				r.set(a.subarray(t.kernelBase, t.kernelBase + n), t.base), e -= n;
			}
		}
		if (0 !== k && 0 !== d && f > 0 && r.set(a.subarray(k, k + f), d), 0 !== I && 0 !== p) {
			const e = w.getUint32(y + 20, !0);
			e > 0 && e <= m && r.set(a.subarray(I, I + e), p);
		}
		const U = w.getUint32(y + 4, !0), A = w.getUint32(y + 20, !0), S = w.getUint32(y + 24, !0);
		8 === h ? (o.setUint32(i + 8, U, !0), o.setUint32(i + 40, A, !0), o.setUint32(i + 44, S, !0)) : (o.setUint32(i + 4, U, !0), o.setUint32(i + 20, A, !0), o.setUint32(i + 24, S, !0)), this.completeChannel(e, Fn, t, void 0, P, B);
	}
	handleFork(e, t) {
		if (!this.callbacks.onFork) return void this.completeChannel(e, hn, t, void 0, -1, 38);
		const n = e.pid;
		for (; this.processes.has(this.nextChildPid);) this.nextChildPid++;
		const i = this.nextChildPid++, s = (0, this.kernelInstance.exports.kernel_fork_process)(n, i);
		if (s < 0) return void this.completeChannel(e, hn, t, void 0, -1, -s >>> 0);
		const r = this.kernelInstance.exports.kernel_clear_fork_child;
		r && r(i);
		const o = this.kernelInstance.exports.kernel_reset_signal_mask;
		o && o(i);
		const a = `${n}:${e.channelOffset}`, c = this.threadForkContexts.get(a), l = e.channelOffset - 131072, h = c ? {
			fnPtr: c.fnPtr,
			argPtr: c.argPtr,
			forkBufAddr: e.channelOffset - 16384,
			slotStart: l,
			slotLen: 262144
		} : void 0;
		if (h) try {
			this.reserveHostRegionAt(i, h.slotStart, h.slotLen);
		} catch (zi) {
			this.removeFromKernelProcessTable(i);
			const s = zi instanceof Error ? zi.message : String(zi);
			console.error(`[kernel-worker] fork child slot reservation failed: ${s}`), this.completeChannel(e, hn, t, void 0, -1, 12);
			return;
		}
		this.callbacks.onFork(n, i, e.memory, h).then((s) => {
			if (this.processes.has(n)) {
				for (const [e, t] of this.tcpListenerTargets) {
					const e = t.find((e) => e.pid === n);
					e && !t.some((e) => e.pid === i) && t.push({
						pid: i,
						fd: e.fd
					});
				}
				for (const [e, t] of this.epollInterests) if (e.startsWith(`${n}:`)) {
					const n = e.slice(e.indexOf(":") + 1);
					this.epollInterests.set(`${i}:${n}`, t.map((e) => ({ ...e })));
				}
				this.completeChannel(e, hn, t, void 0, i, 0);
			}
		}).catch(() => {
			(0, this.kernelInstance.exports.kernel_remove_process)(i), this.completeChannel(e, hn, t, void 0, -1, 12);
		});
	}
	handleSpawn(e, t) {
		const n = e.pid, i = t[0], s = t[1], r = t[2], o = t[3], a = t[4];
		if (!this.callbacks.onSpawn || !this.callbacks.onResolveSpawn) return void this.completeChannel(e, fn, t, void 0, -1, 38);
		const c = new Uint8Array(e.memory.buffer);
		let l = "";
		0 !== i && s > 0 && (l = new TextDecoder().decode(c.slice(i, i + s)), l.endsWith("\0") && (l = l.slice(0, -1)));
		const h = l;
		if (l && !l.startsWith("/") && (l = this.resolveExecPathAgainstCwd(n, l)), o <= 0 || 0 === r && o > 0) return void this.completeChannel(e, fn, t, void 0, -1, 22);
		const d = c.slice(r, r + o);
		let f, u;
		try {
			const e = function(e) {
				if (e.byteLength < 40) throw new Error("blob too short for header");
				const t = new DataView(e.buffer, e.byteOffset, e.byteLength), n = t.getUint32(0, !0), i = t.getUint32(4, !0), s = t.getUint32(8, !0);
				if (n > 4096 || i > 4096 || s > 1024) throw new Error("blob count exceeds limit");
				const r = 40 + 4 * n, o = r + 4 * i + 28 * s;
				if (o > e.byteLength) throw new Error("blob truncated before strings region");
				const a = e.byteLength - o, c = new TextDecoder(), l = (t) => {
					if (t > a) throw new Error("string offset OOB");
					let n = t;
					for (; n < a && 0 !== e[o + n];) n++;
					return c.decode(e.slice(o + t, o + n));
				}, h = [];
				for (let f = 0; f < n; f++) h.push(l(t.getUint32(40 + 4 * f, !0)));
				const d = [];
				for (let f = 0; f < i; f++) d.push(l(t.getUint32(r + 4 * f, !0)));
				return {
					argv: h,
					envp: d
				};
			}(d);
			f = e.argv, u = e.envp;
		} catch (g) {
			this.completeChannel(e, fn, t, void 0, -1, 22);
			return;
		}
		(async () => {
			const e = await this.callbacks.onResolveSpawn(l, f);
			return e || h === l || !h || h.startsWith("/") ? e : this.callbacks.onResolveSpawn(h, f);
		})().then((i) => {
			if (!i) return void this.completeChannel(e, fn, t, void 0, -1, 2);
			if (!((s = i) instanceof ArrayBuffer) && "errno" in s && "number" == typeof s.errno) return void this.completeChannel(e, fn, t, void 0, -1, i.errno >>> 0);
			var s;
			const r = i instanceof ArrayBuffer ? i : i.programBytes, c = i instanceof ArrayBuffer ? f : i.argv;
			this.handleSpawnAfterResolve(e, t, n, a, d, o, c, u, r);
		}).catch((i) => {
			console.error(`[kernel] spawn resolve error for parent ${n}:`, i), this.completeChannel(e, fn, t, void 0, -1, 5);
		});
	}
	handleSpawnAfterResolve(e, t, n, i, s, r, o, a, c) {
		const l = new Uint8Array(this.kernelMemory.buffer);
		if (r > l.byteLength - this.scratchOffset) return void this.completeChannel(e, fn, t, void 0, -1, 22);
		l.set(s, this.scratchOffset);
		const h = (0, this.kernelInstance.exports.kernel_spawn_process)(n, this.toKernelPtr(this.scratchOffset), this.toKernelPtr(r));
		if (h < 0) return void this.completeChannel(e, fn, t, void 0, -1, -h >>> 0);
		const d = h >>> 0;
		d >= this.nextChildPid && (this.nextChildPid = d + 1), this.callbacks.onSpawn(d, c, o, a).then((n) => {
			if (n < 0) {
				(0, this.kernelInstance.exports.kernel_remove_process)(d), this.completeChannel(e, fn, t, void 0, -1, -n >>> 0);
				return;
			}
			0 !== i && new DataView(e.memory.buffer).setInt32(i, d, !0), this.completeChannel(e, fn, t, void 0, 0, 0);
		}).catch((i) => {
			console.error(`[kernel] spawn error for parent ${n}:`, i);
			(0, this.kernelInstance.exports.kernel_remove_process)(d), this.completeChannel(e, fn, t, void 0, -1, 5);
		});
	}
	readCStringFromProcess(e, t, n = 4096) {
		if (0 === t) return "";
		let i = 0;
		for (; t + i < e.length && 0 !== e[t + i] && i < n;) i++;
		return new TextDecoder().decode(e.slice(t, t + i));
	}
	readStringArrayFromProcess(e, t, n = 4) {
		if (0 === t) return [];
		const i = [], s = new DataView(e.buffer, e.byteOffset, e.byteLength);
		for (let r = 0; r < 1024; r++) {
			let o;
			if (o = 8 === n ? Number(s.getBigUint64(t + 8 * r, !0)) : s.getUint32(t + 4 * r, !0), 0 === o) break;
			i.push(this.readCStringFromProcess(e, o));
		}
		return i;
	}
	handleExec(e, t) {
		const n = new Uint8Array(e.memory.buffer), i = this.getPtrWidth(e.pid);
		let s = this.readCStringFromProcess(n, t[0]);
		const r = this.readStringArrayFromProcess(n, t[1], i), o = this.readStringArrayFromProcess(n, t[2], i);
		s && !s.startsWith("/") && (s = this.resolveExecPathAgainstCwd(e.pid, s)), this.callbacks.onExec ? this.callbacks.onExec(e.pid, s, r, o).then((n) => {
			n < 0 && this.completeChannel(e, cn, t, void 0, -1, -n >>> 0);
		}).catch((n) => {
			console.error(`[kernel] exec error for pid ${e.pid}:`, n), this.completeChannel(e, cn, t, void 0, -1, 5);
		}) : this.completeChannel(e, cn, t, void 0, -1, 38);
	}
	resolveExecPathAgainstCwd(e, t) {
		const n = this.kernelInstance.exports.kernel_get_cwd;
		if (!n) return t;
		const i = n(e, this.toKernelPtr(this.scratchOffset), 4096);
		if (i <= 0) return t;
		const s = new Uint8Array(this.kernelMemory.buffer), r = new TextDecoder().decode(s.slice(this.scratchOffset, this.scratchOffset + i)), o = (r.endsWith("/") ? r + t : r + "/" + t).split("/"), a = [];
		for (const c of o) "." !== c && "" !== c && (".." === c && a.length > 0 ? a.pop() : a.push(c));
		return "/" + a.join("/");
	}
	handleExecveat(e, t) {
		const n = t[0], i = t[4], s = new Uint8Array(e.memory.buffer), r = this.getPtrWidth(e.pid), o = this.readCStringFromProcess(s, t[1]), a = this.readStringArrayFromProcess(s, t[2], r), c = this.readStringArrayFromProcess(s, t[3], r);
		let l;
		if (4096 & i && "" === o) {
			const i = this.kernelInstance.exports.kernel_get_fd_path;
			if (!i) return void this.completeChannel(e, ln, t, void 0, -1, 38);
			const s = i(e.pid, n, this.toKernelPtr(this.scratchOffset), 4096);
			if (s <= 0) {
				const n = s < 0 ? -s >>> 0 : 2;
				this.completeChannel(e, ln, t, void 0, -1, n);
				return;
			}
			const r = new Uint8Array(this.kernelMemory.buffer);
			l = new TextDecoder().decode(r.slice(this.scratchOffset, this.scratchOffset + s));
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
			n < 0 && this.completeChannel(e, ln, t, void 0, -1, -n >>> 0);
		}).catch((n) => {
			console.error(`[kernel] execveat error for pid ${e.pid}:`, n), this.completeChannel(e, ln, t, void 0, -1, 5);
		}) : this.completeChannel(e, ln, t, void 0, -1, 38);
	}
	handleClone(e, t) {
		if (!this.callbacks.onClone) return void this.completeChannel(e, un, t, void 0, -1, 38);
		const n = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		n.setUint32(4, un, !0);
		for (let p = 0; p < 6; p++) n.setBigInt64(8 + 8 * p, BigInt(t[p]), !0);
		const i = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			i(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const s = Number(n.getBigInt64(56, !0)), r = n.getUint32(64, !0);
		if (s < 0) return void this.completeChannel(e, un, t, void 0, s, r);
		const o = s, a = t[0], c = t[2];
		1048576 & a && 0 !== c && new DataView(e.memory.buffer).setInt32(c, o, !0);
		const l = new DataView(e.memory.buffer, e.channelOffset), h = l.getUint32(72, !0), d = l.getUint32(76, !0), f = t[1], u = t[3], g = t[4];
		0 !== g && this.threadCtidPtrs.set(`${e.pid}:${o}`, g), this.callbacks.onClone(e.pid, o, h, d, f, u, g, e.memory).then((n) => {
			this.processes.has(e.pid) ? (n !== o && 0 !== g && (this.threadCtidPtrs.delete(`${e.pid}:${o}`), this.threadCtidPtrs.set(`${e.pid}:${n}`, g)), this.completeChannel(e, un, t, void 0, n, 0)) : 0 !== g && this.threadCtidPtrs.delete(`${e.pid}:${o}`);
		}).catch((n) => {
			0 !== g && this.threadCtidPtrs.delete(`${e.pid}:${o}`), console.error(`[kernel-worker] onClone failed: ${n}`), this.completeChannel(e, un, t, void 0, -1, 12);
		});
	}
	handleExit(e, t, n) {
		const i = n[0], s = this.processes.get(e.pid), r = s && s.channels.length > 0 && s.channels[0].channelOffset === e.channelOffset;
		if (t === gn && !r) {
			const t = `${e.pid}:${e.channelOffset}`, n = this.channelTids.get(t) ?? 0;
			n > 0 && this.finalizeThreadExit(e.pid, n, e.channelOffset), n > 0 && !0 === this.callbacks.onThreadExit?.(e.pid, n, e.channelOffset) ? this.abandonChannel(e) : this.completeChannelRaw(e, 0, 0);
			return;
		}
		{
			const n = new DataView(this.kernelMemory.buffer, this.scratchOffset);
			n.setUint32(4, t, !0), n.setBigInt64(8, BigInt(i), !0);
			const s = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				s(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch {} finally {
				this.currentHandlePid = 0;
			}
		}
		const o = e.pid;
		if (this.hostReaped.has(o)) return this.completeChannelRaw(e, 0, 0), this.scheduleWakeBlockedRetries(), void (this.callbacks.onExit && this.callbacks.onExit(o, i));
		this.hostReaped.add(o), this.notifyParentOfExitedProcess(o), this.completeChannelRaw(e, 0, 0), this.scheduleWakeBlockedRetries(), this.callbacks.onExit && this.callbacks.onExit(o, i);
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
			const i = this.processes.get(n)?.channels[0];
			i && this.handleProcessTerminated(i);
		}
	}
	hostReaped = /* @__PURE__ */ new Set();
	handleWaitpid(e, t) {
		const n = t[0], i = t[1], s = t[2] >>> 0, r = e.pid, o = this.pollWaitableChild(r, n);
		if ("error" !== o.kind) return "exited" === o.kind ? (this.consumeExitedChild(r, o.childPid), this.writeWaitStatus(e, i, o.waitStatus), void this.completeWaitpid(e, t, o.childPid, 0)) : void (1 & s ? this.completeWaitpid(e, t, 0, 0) : this.waitingForChild.push({
			parentPid: r,
			channel: e,
			origArgs: t,
			pid: n,
			options: s,
			syscallNr: wn
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
	completeWaitpid(e, t, n, i) {
		this.dequeueSignalForDelivery(e), this.completeChannel(e, wn, t, void 0, n, i);
	}
	wakeWaitingParent(e) {
		let t, n = -1;
		for (let s = 0; s < this.waitingForChild.length; s++) {
			const i = this.waitingForChild[s];
			if (i.parentPid !== e) continue;
			const r = this.pollWaitableChild(i.parentPid, i.pid);
			if ("exited" === r.kind) {
				n = s, t = r;
				break;
			}
		}
		if (-1 === n || "exited" !== t?.kind) return;
		const i = this.waitingForChild[n];
		this.waitingForChild.splice(n, 1), i.syscallNr === bn ? (this.writeSignalInfo(i.channel, i.origArgs[2], t.childPid, t.waitStatus), i.options & In || this.consumeExitedChild(e, t.childPid), this.dequeueSignalForDelivery(i.channel), this.completeChannel(i.channel, bn, i.origArgs, void 0, 0, 0)) : (this.consumeExitedChild(e, t.childPid), this.writeWaitStatus(i.channel, i.origArgs[1], t.waitStatus), this.completeWaitpid(i.channel, i.origArgs, t.childPid, 0));
	}
	recheckDeferredWaitpids() {
		for (let e = this.waitingForChild.length - 1; e >= 0; e--) {
			const t = this.waitingForChild[e];
			if (t.pid > 0 || -1 === t.pid) continue;
			const n = this.pollWaitableChild(t.parentPid, t.pid);
			"error" === n.kind && (this.waitingForChild.splice(e, 1), t.syscallNr === bn ? this.completeChannel(t.channel, bn, t.origArgs, void 0, -1, n.errno) : this.completeWaitpid(t.channel, t.origArgs, -1, n.errno));
		}
	}
	handleWaitid(e, t) {
		const n = t[0], i = t[1], s = t[2], r = t[3] >>> 0, o = e.pid, a = this.waitidToWaitPid(n, i), c = this.pollWaitableChild(o, a);
		if ("error" !== c.kind) {
			if ("exited" === c.kind) return this.writeSignalInfo(e, s, c.childPid, c.waitStatus), r & In || this.consumeExitedChild(o, c.childPid), void this.completeChannel(e, bn, t, void 0, 0, 0);
			if (1 & r) {
				if (0 !== s) {
					const t = new DataView(e.memory.buffer);
					t.setInt32(s, 0, !0), t.setInt32(s + 12, 0, !0);
				}
				this.completeChannel(e, bn, t, void 0, 0, 0);
			} else this.waitingForChild.push({
				parentPid: o,
				channel: e,
				origArgs: t,
				pid: a,
				options: r,
				syscallNr: bn
			});
		} else this.completeChannel(e, bn, t, void 0, -1, c.errno);
	}
	waitidToWaitPid(e, t) {
		return 1 === e ? t : 2 === e ? 0 === t ? 0 : -t : -1;
	}
	writeSignalInfo(e, t, n, i) {
		if (0 === t) return;
		const s = new DataView(e.memory.buffer);
		for (let o = 0; o < 128; o += 4) s.setInt32(t + o, 0, !0);
		const r = !!(127 & i);
		s.setInt32(t + 0, 17, !0), s.setInt32(t + 4, 0, !0), r ? s.setInt32(t + 8, 2, !0) : s.setInt32(t + 8, 1, !0), s.setInt32(t + 12, n, !0), s.setInt32(t + 16, 1e3, !0), r ? s.setInt32(t + 20, 127 & i, !0) : s.setInt32(t + 20, i >> 8 & 255, !0);
	}
	handleFutex(e, t) {
		const n = t[0], i = t[1], s = t[2], r = -385 & i, o = new Int32Array(e.memory.buffer), a = n >>> 2;
		if (0 === r || 9 === r) {
			if (this.pendingCancels.has(e.channelOffset)) return this.pendingCancels.delete(e.channelOffset), this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
			if (Atomics.load(o, a) !== s) return this.completeChannelRaw(e, -11, Ht), void this.relistenChannel(e);
			let n;
			const i = t[3];
			if (0 !== i) {
				const t = new DataView(e.memory.buffer), s = Number(t.getBigInt64(i, !0)), r = Number(t.getBigInt64(i + 8, !0));
				if (s < 0 || 0 === s && r <= 0) return this.completeChannelRaw(e, -110, 110), void this.relistenChannel(e);
				n = 1e3 * s + Math.ceil(r / 1e6), n <= 0 && (n = 1), n > 2147483647 && (n = 2147483647);
			}
			const r = Atomics.waitAsync(o, a, s);
			if (r.async) {
				let t, i = !1;
				const s = (n, s) => {
					i || (i = !0, void 0 !== t && clearTimeout(t), this.pendingFutexWaits.delete(e.channelOffset), this.processes.has(e.pid) && (this.completeChannelRaw(e, n, s), e.consecutiveSyscalls = 0, this.relistenChannel(e)));
				};
				this.pendingFutexWaits.set(e.channelOffset, {
					channel: e,
					futexIndex: a
				}), r.value.then(() => {
					s(0, 0);
				}), void 0 !== n && (t = setTimeout(() => {
					Atomics.notify(o, a, 1), s(-110, 110);
				}, n));
			} else this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
			return;
		}
		if (1 === r || 10 === r) {
			const t = Atomics.notify(o, a, s);
			this.completeChannelRaw(e, t, 0), this.relistenChannel(e);
			return;
		}
		if (3 === r || 4 === r) {
			const n = t[3], i = Atomics.notify(o, a, s + n);
			this.completeChannelRaw(e, i, 0), this.relistenChannel(e);
			return;
		}
		if (5 === r) {
			const n = t[3], i = t[4] >>> 2;
			let r = Atomics.notify(o, a, s);
			r += Atomics.notify(o, i, n), this.completeChannelRaw(e, r, 0), this.relistenChannel(e);
			return;
		}
		this.completeChannelRaw(e, -38, 38), this.relistenChannel(e);
	}
	notifyThreadExit(e, t) {
		if (!this.kernelInstance) return;
		const n = this.kernelInstance.exports.kernel_thread_exit;
		n && n(e, t);
	}
	finalizeThreadExit(e, t, n) {
		const i = `${e}:${n}`;
		this.channelTids.delete(i), this.threadForkContexts.delete(i);
		const s = `${e}:${t}`, r = this.threadCtidPtrs.get(s);
		if (r && 0 !== r) {
			this.threadCtidPtrs.delete(s);
			const t = this.activeChannels.find((t) => t.pid === e && t.channelOffset === n)?.memory ?? this.processes.get(e)?.memory;
			if (t) {
				new DataView(t.buffer).setInt32(r, 0, !0);
				const e = new Int32Array(t.buffer);
				Atomics.notify(e, r >>> 2, 1);
			}
		}
		this.notifyThreadExit(e, t), this.removeChannel(e, n);
	}
	sendSignalToProcess(e, t) {
		if (!this.kernelInstance || !this.kernelMemory) return;
		if (!this.processes.has(e)) return;
		const n = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		n.setUint32(4, an, !0), n.setBigInt64(8, BigInt(e), !0), n.setBigInt64(16, BigInt(t), !0);
		for (let o = 2; o < 6; o++) n.setBigInt64(8 + 8 * o, 0n, !0);
		const i = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e;
		const s = this.kernelInstance.exports.kernel_set_current_tid;
		s && s(0);
		try {
			i(this.toKernelPtr(this.scratchOffset), e);
		} catch (zi) {
			console.error(`[sendSignalToProcess] kernel threw for pid=${e} sig=${t}: ${zi}`);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.kernelInstance.exports.kernel_is_signal_blocked(e, t)) return;
		const r = this.pendingSleeps.get(e);
		r && (clearTimeout(r.timer), this.pendingSleeps.delete(e), this.completeSleepWithSignalCheck(r.channel, r.syscallNr, r.origArgs, r.retVal, r.errVal));
		for (const [o, a] of this.pendingPollRetries) a.channel.pid === e && (a.timer && clearTimeout(a.timer), this.pendingPollRetries.delete(o), this.processes.has(e) && this.retrySyscall(a.channel));
		for (const [o, a] of this.pendingSelectRetries) a.channel.pid === e && (clearTimeout(a.timer), clearImmediate(a.timer), this.pendingSelectRetries.delete(o), this.processes.has(e) && (a.syscallNr === Qt ? this.handleSelect(a.channel, a.origArgs) : this.handlePselect6(a.channel, a.origArgs)));
	}
	ensureProcessMemoryCovers(e, t, n, i, s) {
		let r = 0, o = 0, a = 0;
		n === Pn ? i >= 0 && (r = i) : n === xn ? i >= 0 && (o = i, a = s[1], r = o + a) : n === Bn && i >= 0 && (o = i, a = s[2], r = o + a);
		const c = t.buffer.byteLength;
		if (r > 0 && r > c) (function(e, t, n = 4) {
			const i = Math.ceil(t / _t) - Math.ceil(e.buffer.byteLength / _t);
			i <= 0 || (8 === n ? e.grow(BigInt(i)) : e.grow(i));
		})(t, r, this.processes.get(e)?.ptrWidth ?? 4), this.kernel.framebuffers.rebindMemory(e);
		if (a > 0) {
			const e = 65536, i = Math.ceil(a / e) * e, r = t.buffer.byteLength;
			let c = o;
			const l = Math.min(o + i, r);
			if (n === Bn) {
				const t = s[0] >>> 0, n = s[1] >>> 0;
				if (o === t && n > 0) {
					const i = Math.ceil((t + n) / e) * e;
					c = Math.max(c, i);
				}
			}
			c < l && new Uint8Array(t.buffer, c, l - c).fill(0);
		}
		if (n === Bn && i >= 0 && i !== s[0] && 0 !== s[0] && s[1] > 0) {
			const e = s[0] >>> 0, n = s[1] >>> 0, r = i >>> 0, o = s[2] >>> 0, a = Math.min(n, o);
			if (a > 0) {
				const n = t.buffer, i = n.byteLength;
				if (e + a <= i && r + a <= i) {
					const t = new Uint8Array(n, e, a);
					new Uint8Array(n, r, a).set(t);
				}
			}
		}
	}
	populateMmapFromFile(e, t, n) {
		const i = n[4], s = n[1];
		let r = 4096 * n[5];
		const o = this.kernelInstance.exports.kernel_handle_channel, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = new Uint8Array(this.kernelMemory.buffer), l = this.scratchOffset + 72;
		let h = 0;
		for (; h < s;) {
			const n = Math.min(ne, s - h);
			a.setUint32(4, Mn, !0), a.setBigInt64(8, BigInt(i), !0), a.setBigInt64(16, BigInt(l), !0), a.setBigInt64(24, BigInt(n), !0), a.setBigInt64(32, BigInt(4294967295 & r), !0), a.setBigInt64(40, BigInt(0 | Math.floor(r / 4294967296)), !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				o(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch {
				break;
			}
			this.currentHandlePid = 0;
			const d = Number(a.getBigInt64(56, !0));
			if (d <= 0) break;
			if (new Uint8Array(e.memory.buffer).set(c.subarray(l, l + d), t + h), h += d, r += d, d < n) break;
		}
	}
	flushSharedMappings(e, t) {
		const n = t[0] >>> 0, i = t[1] >>> 0, s = this.sharedMappings.get(e.pid);
		if (!s || 0 === s.size) return;
		const r = n + i;
		for (const [o, a] of s) {
			const t = o + a.len;
			if (o >= r || t <= n) continue;
			const i = Math.max(n, o), s = Math.min(r, t) - i;
			if (s <= 0) continue;
			const c = a.fileOffset + (i - o);
			this.pwriteFromProcessMemory(e, a.fd, i, s, c);
		}
	}
	pwriteFromProcessMemory(e, t, n, i, s) {
		const r = this.kernelInstance.exports.kernel_handle_channel, o = new DataView(this.kernelMemory.buffer, this.scratchOffset), a = new Uint8Array(this.kernelMemory.buffer), c = this.scratchOffset + 72;
		let l = 0;
		for (; l < i;) {
			const h = Math.min(ne, i - l), d = new Uint8Array(e.memory.buffer);
			a.set(d.subarray(n + l, n + l + h), c);
			const f = s + l;
			o.setUint32(4, En, !0), o.setBigInt64(8, BigInt(t), !0), o.setBigInt64(16, BigInt(c), !0), o.setBigInt64(24, BigInt(h), !0), o.setBigInt64(32, BigInt(4294967295 & f), !0), o.setBigInt64(40, BigInt(0 | Math.floor(f / 4294967296)), !0), o.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				r(this.toKernelPtr(this.scratchOffset), e.pid);
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
		const i = this.sharedMappings.get(e);
		if (!i) return;
		const s = t + n;
		for (const [r, o] of i) {
			const e = r + o.len;
			r >= t && e <= s && i.delete(r);
		}
		0 === i.size && this.sharedMappings.delete(e);
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
		const i = n(e, this.toKernelPtr(t)), s = "bigint" == typeof i ? Number(i) : i;
		if (!Number.isSafeInteger(s) || s < 0 || s >>> 0 == 4294967295) throw new Error(`failed to reserve ${t} bytes of pthread control memory for pid=${e}`);
		return s;
	}
	reserveHostRegionAt(e, t, n) {
		const i = this.kernelInstance.exports.kernel_reserve_host_region_at;
		if (!i) throw new Error("Kernel export kernel_reserve_host_region_at is required for fork-from-pthread control slots");
		const s = i(e, this.toKernelPtr(t), this.toKernelPtr(n)), r = "bigint" == typeof s ? Number(s) : s;
		if (!Number.isSafeInteger(r) || r < 0 || r >>> 0 == 4294967295 || r !== t) throw new Error(`failed to reserve pthread control memory at 0x${t.toString(16)} for pid=${e}`);
		return r;
	}
	highControlFloorForProcess(e) {
		const t = this.processes.get(e);
		if (!t) return null;
		if (t.explicitMaxAddr) return null;
		let n = null;
		for (const i of t.channels) {
			const e = i.channelOffset - 131072;
			e >= Vt && (n = null === n ? e : Math.min(n, e));
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
	startTcpListener(e, t, n, i = [
		0,
		0,
		0,
		0
	]) {
		const s = `${e}:${t}`;
		if (this.tcpListeners.has(s)) return;
		this.tcpListenerTargets.has(n) || (this.tcpListenerTargets.set(n, []), this.tcpListenerRRIndex.set(n, 0));
		const r = this.tcpListenerTargets.get(n);
		if (r.some((n) => n.pid === e && n.fd === t) || r.push({
			pid: e,
			fd: t
		}), this.io.network?.listenTcp) {
			const r = this.io.network.listenTcp(s, new Uint8Array(i), n, { accept: (n, i, s) => this.handleIncomingVirtualTcpConnection(e, t, n, s) });
			0 !== r && console.warn(`virtual TCP listener registration failed on port ${n}: errno ${r}`);
		}
		if (!this.netModule) return;
		for (const [, l] of this.tcpListeners) if (l.port === n) return void this.tcpListeners.set(s, l);
		const o = this.netModule, a = /* @__PURE__ */ new Set(), c = o.createServer((e) => {
			const t = this.pickListenerTarget(n);
			t ? this.handleIncomingTcpConnection(t.pid, t.fd, e, a) : e.destroy();
		});
		c.listen(n, "0.0.0.0", () => {}), c.on("error", (e) => {
			console.error(`TCP listener error on port ${n}:`, e);
		}), this.tcpListeners.set(s, {
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
		let i = n;
		if (n.length > 1) {
			const e = n.filter((e) => void 0 !== this.getParentPid(e.pid));
			e.length > 0 && (i = e);
		}
		const s = (this.tcpListenerRRIndex.get(e) ?? 0) % i.length;
		return this.tcpListenerRRIndex.set(e, s + 1), i[s];
	}
	async sendHttpRequest(e, t, n = {}) {
		const i = n.timeoutMs ?? 6e4, s = n.debugLabel ?? `${t.method} ${t.url}`, r = this.pickListenerTarget(e);
		if (!r) throw new Error(`No in-kernel listener for port ${e}`);
		const o = this.kernelInstance.exports, a = o.kernel_inject_connection, c = o.kernel_pipe_write, l = o.kernel_pipe_read, h = o.kernel_pipe_is_write_open, d = o.kernel_pipe_close_write, f = o.kernel_pipe_close_read, u = 1024 + Math.floor(6e4 * Math.random()), g = a(r.pid, r.fd, 127, 0, 0, 1, u);
		if (g < 0) throw new Error(`[in-kernel-http ${s}] kernel_inject_connection failed (${g})`);
		const p = g + 1;
		this.wakeTargetPollNow(r.pid), this.scheduleWakeBlockedRetries();
		const m = function(e) {
			let t = `${e.method} ${e.url} HTTP/1.1\r\n`;
			const n = Object.keys(e.headers).map((e) => e.toLowerCase());
			for (const [r, o] of Object.entries(e.headers)) t += `${r}: ${o}\r\n`;
			e.body && e.body.length > 0 && !n.includes("content-length") && (t += `Content-Length: ${e.body.length}\r\n`), n.includes("connection") || (t += "Connection: close\r\n"), t += "\r\n";
			const i = Ot.encode(t);
			if (!e.body || 0 === e.body.length) return i;
			const s = new Uint8Array(i.length + e.body.length);
			return s.set(i, 0), s.set(e.body, i.length), s;
		}(t), y = this.writePipeChunked(c, 0, g, m);
		if (y < m.length) throw d(0, g), f(0, p), /* @__PURE__ */ new Error(`[in-kernel-http ${s}] partial write ${y}/${m.length}`);
		this.notifyPipeReadable(g);
		const w = await this.pumpHttpResponse(0, p, g, l, h, f, d, i, s), b = n.emptyResponseRetries ?? 1;
		return b > 0 && ("GET" === t.method || "HEAD" === t.method) && 200 === w.status && 0 === Object.keys(w.headers).length && 0 === w.body.length ? await this.sendHttpRequest(e, t, {
			...n,
			emptyResponseRetries: b - 1
		}) : w;
	}
	wakeTargetPollNow(e) {
		for (const [t, n] of this.pendingPollRetries) if (n.channel.pid === e) {
			null !== n.timer && clearTimeout(n.timer), this.pendingPollRetries.delete(t), this.processes.has(e) && this.retrySyscall(n.channel);
			break;
		}
	}
	writePipeChunked(e, t, n, i) {
		const s = this.tcpScratchOffset;
		let r = 0;
		for (; r < i.length;) {
			const o = Math.min(i.length - r, 65536);
			this.getKernelMem().set(i.subarray(r, r + o), s);
			const a = e(t, n, this.toKernelPtr(s), o);
			if (a <= 0) break;
			r += a;
		}
		return r;
	}
	pumpHttpResponse(e, t, n, i, s, r, o, a, c) {
		return new Promise((c) => {
			const l = [], h = Date.now();
			let d = !1;
			const f = this.tcpScratchOffset, u = (i) => {
				r(e, t), o(e, n), this.notifyPipeReadable(n), this.scheduleWakeBlockedRetries(), c(i);
			}, g = () => {
				if (Date.now() - h > a) return void u({
					status: 504,
					headers: {},
					body: new Uint8Array(0)
				});
				let n = !1;
				for (;;) {
					const s = i(e, t, this.toKernelPtr(f), 65536);
					if (s <= 0) break;
					n = !0;
					const r = this.getKernelMem();
					l.push(r.slice(f, f + s));
				}
				n && this.notifyPipeWritable(t);
				const r = 1 === s(e, t);
				r && !d && (d = !0), !d || r || n ? setTimeout(g, n ? 0 : 2) : u(Ft(function(e) {
					if (0 === e.length) return new Uint8Array(0);
					if (1 === e.length) return e[0];
					const t = e.reduce((e, t) => e + t.length, 0), n = new Uint8Array(t);
					let i = 0;
					for (const s of e) n.set(s, i), i += s.length;
					return n;
				}(l)));
			};
			g();
		});
	}
	handleIncomingTcpConnection(e, t, n, i) {
		i.add(n);
		const s = n.remoteAddress || "127.0.0.1", r = n.remotePort || 0, o = s.replace("::ffff:", "").split(".").map(Number), a = o[0] || 127, c = o[1] || 0, l = o[2] || 0, h = o[3] || 1, d = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, a, c, l, h, r);
		if (d < 0) return n.destroy(), void i.delete(n);
		this.scheduleWakeBlockedRetries();
		const f = d + 1, u = this.kernelInstance.exports.kernel_pipe_write, g = this.kernelInstance.exports.kernel_pipe_read, p = this.kernelInstance.exports.kernel_pipe_close_write, m = this.kernelInstance.exports.kernel_pipe_close_read;
		this.kernelInstance.exports.kernel_pipe_is_read_open;
		const y = [];
		let w = !1, b = !1, k = !1;
		const I = this.tcpScratchOffset, v = this.kernelInstance.exports.kernel_pipe_is_write_open, x = () => {
			const e = this.getKernelMem();
			for (; y.length > 0;) {
				const t = y[0], n = Math.min(t.length, 65536);
				e.set(t.subarray(0, n), I);
				const i = u(0, d, this.toKernelPtr(I), n);
				if (i <= 0) break;
				i >= t.length ? y.shift() : y[0] = t.subarray(i);
			}
			w && 0 === y.length && p(0, d);
		}, _ = () => {
			const e = this.getKernelMem();
			let t = 0;
			for (;;) {
				const i = g(0, f, this.toKernelPtr(I), 65536);
				if (i <= 0) break;
				t += i;
				const s = Buffer.from(e.slice(I, I + i));
				n.destroyed || n.write(s);
			}
			return t;
		}, P = (e = 0) => {
			b || k || (b = !0, e > 0 ? setTimeout(B, e) : setImmediate(B));
		}, B = () => {
			if (b = !1, k || !this.processes.has(e)) return void S();
			x();
			const t = _();
			if (0 === v(0, f) && 0 === t) return n.destroyed || n.end(), void S();
			P();
		};
		n.on("data", (t) => {
			y.push(t), this.processes.has(e) ? (x(), this.notifyPipeReadable(d, e), P()) : S();
		}), n.on("end", () => {
			w = !0, P();
		}), n.on("error", () => {
			w = !0, n.destroy();
		}), n.on("close", () => {
			i.delete(n);
		});
		let U = this.tcpConnections.get(e);
		U || (U = [], this.tcpConnections.set(e, U));
		const A = {
			sendPipeIdx: f,
			scratchOffset: I,
			clientSocket: n,
			recvPipeIdx: d,
			schedulePump: P
		};
		U.push(A);
		const S = () => {
			if (k) return;
			k = !0, p(0, d), m(0, f), i.delete(n);
			const t = this.tcpConnections?.get(e);
			if (t) {
				const n = t.indexOf(A);
				n >= 0 && t.splice(n, 1), 0 === t.length && this.tcpConnections?.delete(e);
			}
			n.destroyed || n.destroy();
		};
	}
	handleIncomingVirtualTcpConnection(e, t, n, i) {
		if (!this.kernelInstance) return 107;
		const s = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, i.addr[0] ?? 0, i.addr[1] ?? 0, i.addr[2] ?? 0, i.addr[3] ?? 0, i.port);
		if (s < 0) return -s;
		const r = s + 1, o = this.kernelInstance.exports.kernel_pipe_write, a = this.kernelInstance.exports.kernel_pipe_read, c = this.kernelInstance.exports.kernel_pipe_close_write, l = this.kernelInstance.exports.kernel_pipe_close_read, h = this.kernelInstance.exports.kernel_pipe_is_write_open;
		let d = !1, f = !1;
		const u = this.tcpScratchOffset, g = () => {
			d || (d = !0, c(0, s), l(0, r), n.close(), this.notifyPipeReadable(s, e), this.notifyPipeWritable(r), this.scheduleWakeBlockedRetries());
		}, p = () => {
			for (;;) {
				let i;
				try {
					i = n.recv(65536, 0);
				} catch (t) {
					if (11 === t?.errno) return;
					g();
					return;
				}
				if (0 === i.length) return c(0, s), void this.notifyPipeReadable(s, e);
				if (this.writePipeChunked(o, 0, s, i) < i.length) return;
				this.notifyPipeReadable(s, e);
			}
		}, m = () => {
			const e = this.getKernelMem();
			for (;;) {
				const t = a(0, r, this.toKernelPtr(u), 65536);
				if (t <= 0) break;
				try {
					n.send(e.slice(u, u + t), 0);
				} catch {
					g();
					return;
				}
				this.notifyPipeWritable(r);
			}
		}, y = () => {
			if (f = !1, !d) {
				if (!this.processes.has(e)) return m(), n.shutdown(1), void g();
				if (p(), m(), 0 === h(0, r)) return n.shutdown(1), void g();
				w(2);
			}
		}, w = (e = 0) => {
			f || d || (f = !0, setTimeout(y, e));
		};
		return this.scheduleWakeBlockedRetries(), w(), 0;
	}
	injectUdpDatagram(e, t) {
		if (!this.kernelInstance || !this.processes.has(e)) return 113;
		if (t.data.length > 65536) return 90;
		const n = this.kernelInstance.exports.kernel_inject_datagram;
		if (!n) return 38;
		const i = this.tcpScratchOffset;
		this.getKernelMem().set(t.data, i);
		const s = n(e, t.dstAddr[0] ?? 0, t.dstAddr[1] ?? 0, t.dstAddr[2] ?? 0, t.dstAddr[3] ?? 0, t.dstPort, t.srcAddr[0] ?? 0, t.srcAddr[1] ?? 0, t.srcAddr[2] ?? 0, t.srcAddr[3] ?? 0, t.srcPort, this.toKernelPtr(i), t.data.length);
		return s < 0 ? -s : (this.scheduleWakeBlockedRetries(), 0);
	}
	cleanupUdpBindings(e) {
		if (!this.io.network?.unbindUdp) return;
		const t = `${e}:`;
		for (const n of Array.from(this.udpBindings)) n.startsWith(t) && (this.io.network.unbindUdp(n), this.udpBindings.delete(n));
	}
	cleanupTcpListeners(e) {
		for (const [t, n] of this.tcpListenerTargets) {
			const i = n.filter((t) => t.pid !== e);
			0 === i.length ? (this.tcpListenerTargets.delete(t), this.tcpListenerRRIndex.delete(t)) : this.tcpListenerTargets.set(t, i);
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
		const [n, i, s, r] = t, o = -257 & s, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = this.kernelInstance.exports.kernel_handle_channel, l = this.getKernelMem(), h = this.scratchOffset + 72;
		if (2 === o && 0 !== r) {
			a.setUint32(4, qn, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(i), !0), a.setBigInt64(24, BigInt(s), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), l.fill(0, h, h + 72), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const t = Number(a.getBigInt64(56, !0));
			t >= 0 && new Uint8Array(e.memory.buffer).set(l.subarray(h, h + 72), r), this.completeChannelRaw(e, t, t < 0 ? -t : 0), this.relistenChannel(e);
			return;
		}
		if (13 === o && 0 !== r) {
			const t = 1024;
			a.setUint32(4, qn, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(i), !0), a.setBigInt64(24, BigInt(s), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), l.fill(0, h, h + t), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const o = Number(a.getBigInt64(56, !0));
			o >= 0 && new Uint8Array(e.memory.buffer).set(l.subarray(h, h + t), r), this.completeChannelRaw(e, o, o < 0 ? -o : 0), this.relistenChannel(e);
			return;
		}
		if (17 === o && 0 !== r) {
			const t = 1024, o = new Uint8Array(e.memory.buffer);
			l.set(o.subarray(r, r + t), h), a.setUint32(4, qn, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(i), !0), a.setBigInt64(24, BigInt(s), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const d = Number(a.getBigInt64(56, !0));
			this.completeChannelRaw(e, d, d < 0 ? -d : 0), this.relistenChannel(e);
			return;
		}
		a.setUint32(4, qn, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(i), !0), a.setBigInt64(24, BigInt(s), !0), a.setBigInt64(32, BigInt(r), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			c(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const d = Number(a.getBigInt64(56, !0));
		this.completeChannelRaw(e, d, d < 0 ? -d : 0), this.relistenChannel(e);
	}
	handleIpcShmat(e, t) {
		const [n, i, s] = t, r = this.kernelInstance.exports.kernel_set_current_pid;
		r && r(e.pid);
		const o = (0, this.kernelInstance.exports.kernel_ipc_shmat)(n, i, s);
		if (o < 0) return this.completeChannelRaw(e, o, -o), void this.relistenChannel(e);
		const a = o, c = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		c.setUint32(4, xn, !0), c.setBigInt64(8, BigInt(0), !0), c.setBigInt64(16, BigInt(a), !0), c.setBigInt64(24, BigInt(3), !0), c.setBigInt64(32, BigInt(34), !0), c.setBigInt64(40, BigInt(-1), !0), c.setBigInt64(48, BigInt(0), !0);
		const l = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			l(this.toKernelPtr(this.scratchOffset), e.pid);
		} catch (zi) {
			console.error(`[handleIpcShmat] mmap failed for pid=${e.pid}:`, zi), this.completeChannelRaw(e, -12, 12), this.relistenChannel(e);
			return;
		} finally {
			this.currentHandlePid = 0;
		}
		const h = Number(c.getBigInt64(56, !0));
		if (h < 0) return this.completeChannelRaw(e, -12, 12), void this.relistenChannel(e);
		this.ensureProcessMemoryCovers(e.pid, e.memory, xn, h, [
			0,
			a,
			3,
			34,
			-1,
			0
		]);
		const d = this.kernelInstance.exports.kernel_ipc_shm_read_chunk, f = new Uint8Array(e.memory.buffer), u = this.getKernelMem(), g = this.scratchOffset + 72;
		let p = 0;
		for (; p < a;) {
			const e = a - p, t = Math.min(e, 65536), i = d(n, p, this.toKernelPtr(g), t);
			if (i <= 0) break;
			f.set(u.subarray(g, g + i), (h >>> 0) + p), p += i;
		}
		let m = this.shmMappings.get(e.pid);
		m || (m = /* @__PURE__ */ new Map(), this.shmMappings.set(e.pid, m)), m.set(h >>> 0, {
			segId: n,
			size: a
		}), this.completeChannelRaw(e, h, 0), this.relistenChannel(e);
	}
	handleIpcShmdt(e, t) {
		const n = t[0], i = this.shmMappings.get(e.pid);
		if (!i) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const s = i.get(n);
		if (!s) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const r = this.kernelInstance.exports.kernel_set_current_pid;
		r && r(e.pid);
		const o = this.kernelInstance.exports.kernel_ipc_shm_write_chunk, a = new Uint8Array(e.memory.buffer), c = this.getKernelMem(), l = this.scratchOffset + 72;
		let h = 0;
		for (; h < s.size;) {
			const e = s.size - h, t = Math.min(e, 65536);
			c.set(a.subarray(n + h, n + h + t), l);
			const i = o(s.segId, h, this.toKernelPtr(l), t);
			if (i <= 0) break;
			h += i;
		}
		const d = (0, this.kernelInstance.exports.kernel_ipc_shmdt)(s.segId);
		i.delete(n), d < 0 ? this.completeChannelRaw(e, d, -d) : this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
	}
	drainMqueueNotification() {
		const e = this.kernelInstance.exports.kernel_mq_drain_notification;
		if (!e) return;
		const t = this.scratchOffset;
		if (e(this.toKernelPtr(t))) {
			const e = new DataView(this.kernelMemory.buffer, t), n = e.getUint32(0, !0), i = e.getUint32(4, !0);
			i > 0 && this.sendSignalToProcess(n, i);
		}
	}
	get bos() {
		return this.kernel.bos;
	}
	get gl() {
		return this.kernel.gl;
	}
	get kms() {
		return this.kernel.kms;
	}
	attachKmsCanvas(e, t, n, i) {
		this.kmsCanvases.set(e, t), n && this.kmsStatsViews.set(e, new Int32Array(n));
		const s = i?.mode ?? "auto";
		if ("2d" === s) {
			const n = t.getContext("2d");
			n && (this.kmsContexts.set(e, n), this.kmsContextMode.set(e, "2d"));
		} else "webgl2" === s && this.kmsContextMode.set(e, "webgl2");
		this.startVblankPump();
	}
	attachKmsStats(e, t) {
		this.kmsStatsViews.set(e, new Int32Array(t)), this.startVblankPump();
	}
	startVblankPump() {
		this.vblankTimer || (this.vblankTimer = setInterval(() => this.tickVblank(), 1e3 / 60), this.vblankTimer.unref?.());
	}
	tickVblank() {
		const e = this.kernelInstance?.exports.kernel_vblank;
		e?.();
		for (const [t, n] of this.kmsCanvases) {
			if ("2d" !== this.kmsContextMode.get(t)) continue;
			const e = this.kernel.kms.currentFb(t);
			if (!e) continue;
			const i = this.kernel.kms.scanoutBytes(t);
			if (!i) continue;
			const s = this.kmsContexts.get(t);
			if (!s) continue;
			n.width === e.width && n.height === e.height || (n.width = e.width, n.height = e.height);
			const r = performance.now(), o = e.width * e.height * 4;
			let a = this.kmsScratchBytes.get(t);
			a && a.byteLength === o || (a = new Uint8ClampedArray(new ArrayBuffer(o)), this.kmsScratchBytes.set(t, a)), a.set(i), s.putImageData(new ImageData(a, e.width, e.height), 0, 0);
			const c = 1e3 * (performance.now() - r) | 0, l = this.kmsStatsViews.get(t);
			l && (Atomics.add(l, 0, 1), Atomics.store(l, 1, 0 | performance.now()), Atomics.store(l, 4, c));
		}
		if (this.kmsStatsViews.size > 0) {
			const e = this.kernelInstance?.exports;
			for (const [t, n] of this.kmsStatsViews) {
				const i = this.kernel.kms.currentFb(t);
				if (i && (Atomics.store(n, 2, i.width), Atomics.store(n, 3, i.height)), n.length < 7) continue;
				const s = e?.kernel_kms_commit_count?.(t) ?? 0n, r = e?.kernel_kms_last_frame_us?.(t) ?? 0n;
				Atomics.store(n, 5, Number(2147483647n & s)), Atomics.store(n, 6, Number(2147483647n & r));
			}
		}
	}
};
var oi = class {
	entryUrl;
	constructor(e) {
		this.entryUrl = e;
	}
	createWorker(e) {
		const t = new Worker(this.entryUrl, { type: "module" }), n = new ai(t);
		return t.postMessage(e), n;
	}
}, ai = class {
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
}, ci = class extends Error {
	errno = 11;
	constructor() {
		super("EAGAIN");
	}
};
const li = 107, hi = "0.0.0.0";
function di(e) {
	return `${e[0]}.${e[1]}.${e[2]}.${e[3]}`;
}
function fi(e) {
	return new Uint8Array([
		e[0] ?? 0,
		e[1] ?? 0,
		e[2] ?? 0,
		e[3] ?? 0
	]);
}
function ui(e, t) {
	return e === hi || e === t;
}
function gi(e, t) {
	return e === hi || t === hi || e === t;
}
var pi = class {
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
			const n = new Uint8Array(e.length + t.length);
			return n.set(e, 0), n.set(t, e.length), n;
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
			const t = Math.min(e, this.recvBuf.length), n = this.recvBuf.slice(0, t);
			return this.recvBuf = this.recvBuf.slice(t), n;
		}
		if (!this.peer || this.peer.writeClosed) return new Uint8Array(0);
		throw new ci();
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
}, mi = class {
	machines = /* @__PURE__ */ new Map();
	addressOwners = /* @__PURE__ */ new Map();
	hostnames = /* @__PURE__ */ new Map();
	tcpListeners = [];
	udpEndpoints = [];
	tcpPeersByMachine = /* @__PURE__ */ new Map();
	attachMachine(e) {
		const t = fi(e.address instanceof Uint8Array ? e.address : new Uint8Array(e.address)), n = di(t);
		if (this.addressOwners.has(n)) throw new Error(`address ${n} is already attached`);
		const i = new yi(this, e.id, t);
		this.machines.set(e.id, i), this.addressOwners.set(n, e.id), this.hostnames.set(e.id, t);
		for (const s of e.hostnames ?? []) this.hostnames.set(s, t);
		return i;
	}
	detachMachine(e) {
		const t = this.machines.get(e);
		if (t) {
			this.addressOwners.delete(di(t.localAddress)), this.machines.delete(e);
			for (const [n, i] of this.hostnames) di(i) !== di(t.localAddress) && n !== e || this.hostnames.delete(n);
			this.tcpListeners = this.tcpListeners.filter((t) => t.machineId !== e), this.udpEndpoints = this.udpEndpoints.filter((t) => t.machineId !== e);
			for (const t of this.tcpPeersByMachine.get(e) ?? []) t.close();
			this.tcpPeersByMachine.delete(e), t.resetAllConnections();
		}
	}
	resolve(e) {
		const t = e.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
		if (t) return new Uint8Array(t.slice(1).map((e) => Number(e)));
		const n = this.hostnames.get(e);
		return n ? fi(n) : null;
	}
	listenTcp(e, t, n, i, s) {
		const r = di(n);
		if (!this.machineOwnsAddress(e, r)) return 99;
		for (const o of this.tcpListeners) if (o.machineId === e && o.port === i && gi(o.addrKey, r)) return 98;
		return this.closeTcpListener(t), this.tcpListeners.push({
			machineId: e,
			listenerId: t,
			addr: fi(n),
			addrKey: r,
			port: i,
			target: s
		}), 0;
	}
	closeTcpListener(e) {
		this.tcpListeners = this.tcpListeners.filter((t) => t.listenerId !== e);
	}
	connectTcp(e, t, n) {
		const i = di(n.addr), s = this.addressOwners.get(i);
		if (!s) return {
			peer: new pi(),
			status: 113
		};
		const r = this.tcpListeners.find((e) => e.machineId === s && e.port === n.port && ui(e.addrKey, i));
		if (!r) return {
			peer: new pi(),
			status: 111
		};
		const o = new pi(), a = new pi();
		o.pairWith(a), a.pairWith(o), this.trackTcpPeer(e, o), this.trackTcpPeer(s, a);
		const c = r.target.accept(a, {
			addr: fi(n.addr),
			port: n.port
		}, {
			addr: fi(t.addr),
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
	bindUdp(e, t, n, i, s) {
		const r = di(n);
		if (!this.machineOwnsAddress(e, r)) return 99;
		for (const o of this.udpEndpoints) if (o.machineId === e && o.port === i && gi(o.addrKey, r)) return 98;
		return this.unbindUdp(t), this.udpEndpoints.push({
			machineId: e,
			endpointId: t,
			addr: fi(n),
			addrKey: r,
			port: i,
			target: s
		}), 0;
	}
	unbindUdp(e) {
		this.udpEndpoints = this.udpEndpoints.filter((t) => t.endpointId !== e);
	}
	sendDatagram(e) {
		const t = di(e.dstAddr), n = this.addressOwners.get(t);
		if (!n) return 113;
		const i = this.udpEndpoints.find((i) => i.machineId === n && i.port === e.dstPort && ui(i.addrKey, t));
		return i ? i.target.receive({
			srcAddr: fi(e.srcAddr),
			srcPort: e.srcPort,
			dstAddr: fi(e.dstAddr),
			dstPort: e.dstPort,
			data: e.data.slice()
		}) : 111;
	}
	machineOwnsAddress(e, t) {
		return t === hi || this.addressOwners.get(t) === e;
	}
	trackTcpPeer(e, t) {
		let n = this.tcpPeersByMachine.get(e);
		n || (n = /* @__PURE__ */ new Set(), this.tcpPeersByMachine.set(e, n)), n.add(t);
	}
}, yi = class {
	network;
	machineId;
	localAddress;
	connections = /* @__PURE__ */ new Map();
	connectErrors = /* @__PURE__ */ new Map();
	nextEphemeralPort = 49152;
	constructor(e, t, n) {
		this.network = e, this.machineId = t, this.localAddress = n;
	}
	connect(e, t, n) {
		if (this.connections.has(e)) return void this.connectErrors.set(e, 106);
		const i = this.allocateEphemeralPort(), s = this.network.connectTcp(this.machineId, {
			addr: this.localAddress,
			port: i
		}, {
			addr: fi(t),
			port: n
		});
		0 === s.status ? (this.connections.set(e, s.peer), this.connectErrors.delete(e)) : this.connectErrors.set(e, s.status);
	}
	connectStatus(e) {
		const t = this.connectErrors.get(e);
		return void 0 !== t ? t : this.connections.has(e) ? 0 : li;
	}
	send(e, t, n) {
		const i = this.connections.get(e);
		if (!i) throw Object.assign(/* @__PURE__ */ new Error("ENOTCONN"), { errno: li });
		return i.send(t, n);
	}
	recv(e, t, n) {
		const i = this.connections.get(e);
		if (!i) throw Object.assign(/* @__PURE__ */ new Error("ENOTCONN"), { errno: li });
		return i.recv(t, n);
	}
	poll(e, t) {
		const n = this.connections.get(e);
		if (!n) throw Object.assign(/* @__PURE__ */ new Error("ENOTCONN"), { errno: li });
		return "function" == typeof n.poll ? n.poll(t) : t;
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
	listenTcp(e, t, n, i) {
		return this.network.listenTcp(this.machineId, this.scopedId(e), t, n, i);
	}
	closeTcpListener(e) {
		this.network.closeTcpListener(this.scopedId(e));
	}
	bindUdp(e, t, n, i) {
		return this.network.bindUdp(this.machineId, this.scopedId(e), t, n, i);
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
const wi = {
	reader: () => 0,
	writer: (e, t) => t,
	mode: 8630
}, bi = {
	reader: (e, t) => (e.fill(0, 0, t), t),
	writer: (e, t) => t,
	mode: 8630
}, ki = {
	reader: () => {
		throw new Error("ENXIO");
	},
	writer: () => {
		throw new Error("ENXIO");
	},
	mode: 8630
};
const Ii = [
	"pts",
	"shm",
	"mqueue"
], vi = [
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
function xi(e) {
	return "/" === e || "" === e || "." === e;
}
var _i = class {
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
		this.devices.set("null", wi), this.devices.set("zero", bi), this.devices.set("urandom", e), this.devices.set("random", e), this.devices.set("console", ki), this.devices.set("tty", ki), this.deviceNames = [...this.devices.keys()];
	}
	getDevice(e) {
		const t = e.startsWith("/") ? e.slice(1) : e, n = this.devices.get(t);
		if (!n) throw new Error("ENOENT");
		return n;
	}
	open(e, t, n) {
		const i = e.startsWith("/") ? e.slice(1) : e;
		if (xi(e) || Ii.includes(i)) {
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
	read(e, t, n, i) {
		const s = this.handles.get(e);
		if (!s) throw new Error("EBADF");
		if (!s.device) throw new Error("EISDIR");
		return s.device.reader(t, Math.min(i, t.length));
	}
	write(e, t, n, i) {
		const s = this.handles.get(e);
		if (!s) throw new Error("EBADF");
		if (!s.device) throw new Error("EISDIR");
		return s.device.writer(t, Math.min(i, t.length));
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
		if (xi(e)) return {
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
		return Ii.includes(n) ? {
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
		return t.files = this.devices.size + Ii.length + vi.length, t;
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
	utimensat(e, t, n, i, s) {}
	dirHandles = /* @__PURE__ */ new Map();
	nextDirHandle = 1;
	opendir(e) {
		const t = e.startsWith("/") ? e.slice(1) : e;
		let n;
		if (xi(e)) n = [...this.deviceNames.map((e, t) => ({
			name: e,
			type: 2,
			ino: t + 1
		})), ...vi.filter((e) => !this.devices.has(e.name))];
		else {
			if (!Ii.includes(t)) throw new Error("ENOTDIR");
			n = [];
		}
		const i = this.nextDirHandle++;
		return this.dirHandles.set(i, {
			idx: 0,
			entries: n
		}), i;
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
}, Pi = ArrayBuffer, Bi = Uint8Array, Ui = Uint16Array, Ai = Int16Array, Si = Int32Array, Mi = function(e, t, n) {
	if (Bi.prototype.slice) return Bi.prototype.slice.call(e, t, n);
	(null == t || t < 0) && (t = 0), (null == n || n > e.length) && (n = e.length);
	var i = new Bi(n - t);
	return i.set(e.subarray(t, n)), i;
}, Ei = function(e, t, n, i) {
	if (Bi.prototype.fill) return Bi.prototype.fill.call(e, t, n, i);
	for ((null == n || n < 0) && (n = 0), (null == i || i > e.length) && (i = e.length); n < i; ++n) e[n] = t;
	return e;
}, Ci = function(e, t, n, i) {
	if (Bi.prototype.copyWithin) return Bi.prototype.copyWithin.call(e, t, n, i);
	for ((null == n || n < 0) && (n = 0), (null == i || i > e.length) && (i = e.length); n < i;) e[t++] = e[n++];
}, Ti = [
	"invalid zstd data",
	"window size too large (>2046MB)",
	"invalid block type",
	"FSE accuracy too high",
	"match distance too far back",
	"unexpected EOF"
], zi = function(e, t, n) {
	var i = new Error(t || Ti[e]);
	if (i.code = e, Error.captureStackTrace && Error.captureStackTrace(i, zi), !n) throw i;
	return i;
}, Oi = function(e, t, n) {
	for (var i = 0, s = 0; i < n; ++i) s |= e[t++] << (i << 3);
	return s;
}, Ri = function(e, t) {
	var n, i, s = e[0] | e[1] << 8 | e[2] << 16;
	if (3126568 == s && 253 == e[3]) {
		var r = e[4], o = r >> 5 & 1, a = r >> 2 & 1, c = 3 & r, l = r >> 6;
		8 & r && zi(0);
		var h = 6 - o, d = 3 == c ? 4 : c, f = Oi(e, h, d), u = l ? 1 << l : o, g = Oi(e, h += d, u) + (1 == l && 256), p = g;
		if (!o) {
			var m = 1 << 10 + (e[5] >> 3);
			p = m + (m >> 3) * (7 & e[5]);
		}
		p > 2145386496 && zi(1);
		var y = new Bi((1 == t ? g || p : t ? 0 : p) + 12);
		return y[0] = 1, y[4] = 4, y[8] = 8, {
			b: h + u,
			y: 0,
			l: 0,
			d: f,
			w: t && 1 != t ? t : y.subarray(12),
			e: p,
			o: new Si(y.buffer, 0, 3),
			u: g,
			c: a,
			m: Math.min(131072, p)
		};
	}
	if (25481893 == (s >> 4 | e[3] << 20)) return (((n = e)[i = 4] | n[i + 1] << 8 | n[i + 2] << 16 | n[i + 3] << 24) >>> 0) + 8;
	zi(0);
}, Fi = function(e) {
	for (var t = 0; 1 << t <= e; ++t);
	return t - 1;
}, Li = function(e, t, n) {
	var i = 4 + (t << 3), s = 5 + (15 & e[t]);
	s > n && zi(3);
	for (var r = 1 << s, o = r, a = -1, c = -1, l = -1, h = r, d = new Pi(512 + (r << 2)), f = new Ai(d, 0, 256), u = new Ui(d, 0, 256), g = new Ui(d, 512, r), p = 512 + (r << 1), m = new Bi(d, p, r), y = new Bi(d, p + r); a < 255 && o > 0;) {
		var w = Fi(o + 1), b = i >> 3, k = (1 << w + 1) - 1, I = (e[b] | e[b + 1] << 8 | e[b + 2] << 16) >> (7 & i) & k, v = (1 << w) - 1, x = k - o - 1, _ = I & v;
		if (_ < x ? (i += w, I = _) : (i += w + 1, I > v && (I -= x)), f[++a] = --I, -1 == I ? (o += I, m[--h] = a) : o -= I, !I) do {
			var P = i >> 3;
			c = (e[P] | e[P + 1] << 8) >> (7 & i) & 3, i += 2, a += c;
		} while (3 == c);
	}
	(a > 255 || o) && zi(0);
	for (var B = 0, U = (r >> 1) + (r >> 3) + 3, A = r - 1, S = 0; S <= a; ++S) {
		var M = f[S];
		if (M < 1) u[S] = -M;
		else for (l = 0; l < M; ++l) {
			m[B] = S;
			do
				B = B + U & A;
			while (B >= h);
		}
	}
	for (B && zi(0), l = 0; l < r; ++l) {
		var E = u[m[l]]++;
		g[l] = (E << (y[l] = s - Fi(E))) - r;
	}
	return [i + 7 >> 3, {
		b: s,
		s: m,
		n: y,
		t: g
	}];
}, Ni = Li(new Bi([
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
]), 0, 6)[1], $i = Li(new Bi([
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
]), 0, 6)[1], Di = Li(new Bi([
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
]), 0, 5)[1], Wi = function(e, t) {
	for (var n = e.length, i = new Si(n), s = 0; s < n; ++s) i[s] = t, t += 1 << e[s];
	return i;
}, Ki = new Bi(new Si([
	0,
	0,
	0,
	0,
	16843009,
	50528770,
	134678020,
	202050057,
	269422093
]).buffer, 0, 36), Vi = Wi(Ki, 0), Hi = new Bi(new Si([
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
]).buffer, 0, 53), qi = Wi(Hi, 3), Gi = function(e, t, n) {
	var i = e.length, s = t.length, r = e[i - 1], o = (1 << n.b) - 1, a = -n.b;
	r || zi(0);
	for (var c = 0, l = n.b, h = (i << 3) - 8 + Fi(r) - l, d = -1; h > a && d < s;) {
		var f = h >> 3;
		c = (c << l | (e[f] | e[f + 1] << 8 | e[f + 2] << 16) >> (7 & h)) & o, t[++d] = n.s[c], h -= l = n.n[c];
	}
	h == a && d + 1 == s || zi(0);
}, ji = function(e, t, n) {
	var i = 6, s = t.length + 3 >> 2, r = s << 1, o = s + r;
	Gi(e.subarray(i, i += e[0] | e[1] << 8), t.subarray(0, s), n), Gi(e.subarray(i, i += e[2] | e[3] << 8), t.subarray(s, r), n), Gi(e.subarray(i, i += e[4] | e[5] << 8), t.subarray(r, o), n), Gi(e.subarray(i), t.subarray(o), n);
}, Xi = function(e, t, n) {
	var i, s = t.b, r = e[s], o = r >> 1 & 3;
	t.l = 1 & r;
	var a = r >> 3 | e[s + 1] << 5 | e[s + 2] << 13, c = (s += 3) + a;
	if (1 == o) {
		if (s >= e.length) return;
		return t.b = s + 1, n ? (Ei(n, e[s], t.y, t.y += a), n) : Ei(new Bi(a), e[s]);
	}
	if (!(c > e.length)) {
		if (0 == o) return t.b = c, n ? (n.set(e.subarray(s, c), t.y), t.y += a, n) : Mi(e, s, c);
		if (2 == o) {
			var l = e[s], h = 3 & l, d = l >> 2 & 3, f = l >> 4, u = 0, g = 0;
			h < 2 ? 1 & d ? f |= e[++s] << 4 | (2 & d && e[++s] << 12) : f = l >> 3 : (g = d, d < 2 ? (f |= (63 & e[++s]) << 4, u = e[s] >> 6 | e[++s] << 2) : 2 == d ? (f |= e[++s] << 4 | (3 & e[++s]) << 12, u = e[s] >> 2 | e[++s] << 6) : (f |= e[++s] << 4 | (63 & e[++s]) << 12, u = e[s] >> 6 | e[++s] << 2 | e[++s] << 10)), ++s;
			var p = n ? n.subarray(t.y, t.y + t.m) : new Bi(t.m), m = p.length - f;
			if (0 == h) p.set(e.subarray(s, s += f), m);
			else if (1 == h) Ei(p, e[s++], m);
			else {
				var y = t.h;
				if (2 == h) {
					var w = function(e, t) {
						var n = 0, i = -1, s = new Bi(292), r = e[t], o = s.subarray(0, 256), a = s.subarray(256, 268), c = new Ui(s.buffer, 268);
						if (r < 128) {
							var l = Li(e, t + 1, 6), h = l[0], d = l[1], f = h << 3, u = e[t += r];
							u || zi(0);
							for (var g = 0, p = 0, m = d.b, y = m, w = (++t << 3) - 8 + Fi(u); !((w -= m) < f);) {
								var b = w >> 3;
								if (g += (e[b] | e[b + 1] << 8) >> (7 & w) & (1 << m) - 1, o[++i] = d.s[g], (w -= y) < f) break;
								p += (e[b = w >> 3] | e[b + 1] << 8) >> (7 & w) & (1 << y) - 1, o[++i] = d.s[p], m = d.n[g], g = d.t[g], y = d.n[p], p = d.t[p];
							}
							++i > 255 && zi(0);
						} else {
							for (i = r - 127; n < i; n += 2) {
								var k = e[++t];
								o[n] = k >> 4, o[n + 1] = 15 & k;
							}
							++t;
						}
						var I = 0;
						for (n = 0; n < i; ++n) (P = o[n]) > 11 && zi(0), I += P && 1 << P - 1;
						var v = Fi(I) + 1, x = 1 << v, _ = x - I;
						for (_ & _ - 1 && zi(0), o[i++] = Fi(_) + 1, n = 0; n < i; ++n) {
							var P = o[n];
							++a[o[n] = P && v + 1 - P];
						}
						var B = new Bi(x << 1), U = B.subarray(0, x), A = B.subarray(x);
						for (c[v] = 0, n = v; n > 0; --n) {
							var S = c[n];
							Ei(A, n, S, c[n - 1] = S + a[n] * (1 << v - n));
						}
						for (c[0] != x && zi(0), n = 0; n < i; ++n) {
							var M = o[n];
							if (M) {
								var E = c[M];
								Ei(U, n, E, c[M] = E + (1 << v - M));
							}
						}
						return [t, {
							n: A,
							b: v,
							s: U
						}];
					}(e, s);
					u += s - (s = w[0]), t.h = y = w[1];
				} else y || zi(0);
				(g ? ji : Gi)(e.subarray(s, s += u), p.subarray(m), y);
			}
			var b = e[s++];
			if (b) {
				255 == b ? b = 32512 + (e[s++] | e[s++] << 8) : b > 127 && (b = b - 128 << 8 | e[s++]);
				var k = e[s++];
				3 & k && zi(0);
				for (var I = [
					$i,
					Di,
					Ni
				], v = 2; v > -1; --v) {
					var x = k >> 2 + (v << 1) & 3;
					if (1 == x) {
						var _ = new Bi([
							0,
							0,
							e[s++]
						]);
						I[v] = {
							s: _.subarray(2, 3),
							n: _.subarray(0, 1),
							t: new Ui(_.buffer, 0, 1),
							b: 0
						};
					} else 2 == x ? (s = (i = Li(e, s, 9 - (1 & v)))[0], I[v] = i[1]) : 3 == x && (t.t || zi(0), I[v] = t.t[v]);
				}
				var P = t.t = I, B = P[0], U = P[1], A = P[2], S = e[c - 1];
				S || zi(0);
				var M = (c << 3) - 8 + Fi(S) - A.b, E = M >> 3, C = 0, T = (e[E] | e[E + 1] << 8) >> (7 & M) & (1 << A.b) - 1, z = (e[E = (M -= U.b) >> 3] | e[E + 1] << 8) >> (7 & M) & (1 << U.b) - 1, O = (e[E = (M -= B.b) >> 3] | e[E + 1] << 8) >> (7 & M) & (1 << B.b) - 1;
				for (++b; --b;) {
					var R = A.s[T], F = A.n[T], L = B.s[O], N = B.n[O], $ = U.s[z], D = U.n[z], W = 1 << $, K = W + ((e[E = (M -= $) >> 3] | e[E + 1] << 8 | e[E + 2] << 16 | e[E + 3] << 24) >>> (7 & M) & W - 1);
					E = (M -= Hi[L]) >> 3;
					var V = qi[L] + ((e[E] | e[E + 1] << 8 | e[E + 2] << 16) >> (7 & M) & (1 << Hi[L]) - 1);
					E = (M -= Ki[R]) >> 3;
					var H = Vi[R] + ((e[E] | e[E + 1] << 8 | e[E + 2] << 16) >> (7 & M) & (1 << Ki[R]) - 1);
					if (E = (M -= F) >> 3, T = A.t[T] + ((e[E] | e[E + 1] << 8) >> (7 & M) & (1 << F) - 1), E = (M -= N) >> 3, O = B.t[O] + ((e[E] | e[E + 1] << 8) >> (7 & M) & (1 << N) - 1), E = (M -= D) >> 3, z = U.t[z] + ((e[E] | e[E + 1] << 8) >> (7 & M) & (1 << D) - 1), K > 3) t.o[2] = t.o[1], t.o[1] = t.o[0], t.o[0] = K -= 3;
					else {
						var q = K - (0 != H);
						q ? (K = 3 == q ? t.o[0] - 1 : t.o[q], q > 1 && (t.o[2] = t.o[1]), t.o[1] = t.o[0], t.o[0] = K) : K = t.o[0];
					}
					for (v = 0; v < H; ++v) p[C + v] = p[m + v];
					m += H;
					var G = (C += H) - K;
					if (G < 0) {
						var j = -G, X = t.e + G;
						j > V && (j = V);
						for (v = 0; v < j; ++v) p[C + v] = t.w[X + v];
						C += j, V -= j, G = 0;
					}
					for (v = 0; v < V; ++v) p[C + v] = p[G + v];
					C += V;
				}
				if (C != m) for (; m < p.length;) p[C++] = p[m++];
				else C = p.length;
				n ? t.y += C : p = Mi(p, 0, C);
			} else if (n) {
				if (t.y += f, m) for (v = 0; v < f; ++v) p[v] = p[m + v];
			} else m && (p = Mi(p, m));
			return t.b = c, p;
		}
		zi(2);
	}
};
function Yi(e, t) {
	for (var n = [], i = +!t, s = 0, r = 0; e.length;) {
		var o = Ri(e, i || t);
		if ("object" == typeof o) {
			for (i ? (t = null, o.w.length == o.u && (n.push(t = o.w), r += o.u)) : (n.push(t), o.e = 0); !o.l;) {
				var a = Xi(e, o, t);
				a || zi(5), t ? o.e = o.y : (n.push(a), r += a.length, Ci(o.w, 0, a.length), o.w.set(a, o.w.length - a.length));
			}
			s = o.b + 4 * o.c;
		} else s = o;
		e = e.subarray(s);
	}
	return function(e, t) {
		if (1 == e.length) return e[0];
		for (var n = new Bi(t), i = 0, s = 0; i < e.length; ++i) {
			var r = e[i];
			n.set(r, s), s += r.length;
		}
		return n;
	}(n, r);
}
const Ji = 4096, Zi = 1024, Qi = Math.floor(160), es = 12, ts = 16, ns = 32, is = 48, ss = 100, rs = -2147483648, os = {
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
var as = class extends Error {
	code;
	constructor(e, t) {
		super(t || os[e] || `Error ${e}`), this.code = e, this.name = "SFSError";
	}
};
const cs = new TextEncoder(), ls = new TextDecoder();
function hs(e) {
	return e.buffer instanceof SharedArrayBuffer ? ls.decode(new Uint8Array(e)) : ls.decode(e);
}
function ds(e) {
	return e + 3 & -4;
}
var fs = class e {
	buffer;
	view;
	i32;
	u8;
	constructor(e) {
		this.buffer = e, this.view = new DataView(e), this.i32 = new Int32Array(e), this.u8 = new Uint8Array(e);
	}
	static mkfs(t, n) {
		const i = t.byteLength;
		if (i < 65536) throw new as(-22);
		const s = Math.floor(i / Ji), r = n ? Math.floor(n / Ji) : 4 * s;
		let o = Math.floor(r / 4);
		o < 32 && (o = 32), o = 32 * Math.ceil(o / 32);
		const a = Math.ceil(o / 32768), c = Math.ceil(r / 32768), l = Math.ceil(128 * o / Ji), h = 1 + a, d = h + c, f = d + l;
		if (f >= s) throw new as(-28);
		new Uint8Array(t).fill(0);
		const u = new e(t);
		u.w32(0, 1397114451), u.w32(4, 1), u.w32(8, Ji), u.w32(12, s), u.w32(16, o), u.w32(28, 1), u.w32(32, h), u.w32(36, d), u.w32(40, f), u.w32(44, a), u.w32(48, c), u.w32(52, l), u.w32(68, r), u.w32(72, 256);
		const g = h * Ji;
		for (let e = 0; e < f; e++) {
			const t = (g >> 2) + (e >> 5);
			u.i32[t] |= 1 << (31 & e);
		}
		const p = s - f;
		Atomics.store(u.i32, 5, p), u.i32[1024] |= 3, Atomics.store(u.i32, 6, o - 2);
		const m = u.inodeOffset(1);
		u.w32(m + 8, 16877), u.w32(m + es, 2);
		const y = u.blockAlloc();
		if (y < 0) throw new as(-28);
		u.w32(m + is, y);
		const w = y * Ji, b = ds(9), k = ds(10);
		u.w32(w, 1), u.view.setUint16(w + 4, b, !0), u.view.setUint16(w + 6, 1, !0), u.u8[w + 8] = 46;
		const I = w + b;
		return u.w32(I, 1), u.view.setUint16(I + 4, k, !0), u.view.setUint16(I + 6, 2, !0), u.u8[I + 8] = 46, u.u8[I + 8 + 1] = 46, u.w64(m + ts, b + k), Atomics.store(u.i32, 14, 1), u;
	}
	static mount(t) {
		const n = new e(t);
		if (1397114451 !== n.r32(0)) throw new as(-22, "Bad magic");
		if (1 !== n.r32(4)) throw new as(-22, "Bad version");
		if (4096 !== n.r32(8)) throw new as(-22, "Bad block size");
		return n;
	}
	statfs() {
		const e = this.r32(8), t = this.r32(12), n = this.r32(68), i = "number" == typeof this.buffer.maxByteLength ? this.buffer.maxByteLength : this.buffer.byteLength, s = Math.floor(i / e), r = Math.max(t, Math.min(n, s));
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
		const e = this.r32(12), t = this.r32(32) * Ji, n = Math.ceil(e / 32);
		for (let i = 0; i < n; i++) {
			const n = (t >> 2) + i, s = Atomics.load(this.i32, n);
			if (-1 !== s) for (let t = 0; t < 32; t++) {
				const r = 32 * i + t;
				if (r >= e) return -28;
				if (s & 1 << t) continue;
				const o = s | 1 << t;
				if (Atomics.compareExchange(this.i32, n, s, o) === s) {
					Atomics.sub(this.i32, 5, 1);
					const e = r * Ji;
					return this.u8.fill(0, e, e + Ji), r;
				}
				i--;
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
		const t = (this.r32(32) * Ji >> 2) + (e >> 5), n = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t), i = e & ~(1 << n);
			if (Atomics.compareExchange(this.i32, t, e, i) === e) break;
		}
		Atomics.add(this.i32, 5, 1);
	}
	grow() {
		this.sbLock();
		try {
			if (Atomics.load(this.i32, 5) > 0) return 0;
			const e = this.r32(12), t = this.r32(68);
			let n = this.r32(72), i = e + n;
			if (i > t && (i = t, n = i - e, 0 === n)) return -28;
			const s = i * Ji;
			if (this.buffer.byteLength < s) try {
				this.buffer.grow(s), this.view = new DataView(this.buffer), this.i32 = new Int32Array(this.buffer), this.u8 = new Uint8Array(this.buffer);
			} catch {
				return -28;
			}
			return this.w32(12, i), Atomics.add(this.i32, 5, n), Atomics.add(this.i32, 14, 1), 0;
		} finally {
			this.sbUnlock();
		}
	}
	inodeOffset(e) {
		return (this.r32(36) + Math.floor(e / 32)) * Ji + e % 32 * 128;
	}
	inodeAlloc() {
		const e = this.r32(16), t = this.r32(28) * Ji, n = Math.ceil(e / 32);
		for (let i = 0; i < n; i++) {
			const n = (t >> 2) + i, s = Atomics.load(this.i32, n);
			if (-1 !== s) for (let t = 0; t < 32; t++) {
				const r = 32 * i + t;
				if (r >= e) return -28;
				if (s & 1 << t) continue;
				const o = s | 1 << t;
				if (Atomics.compareExchange(this.i32, n, s, o) === s) {
					Atomics.sub(this.i32, 6, 1);
					const e = this.inodeOffset(r);
					return this.u8.fill(0, e, e + 128), r;
				}
				i--;
				break;
			}
		}
		return -28;
	}
	inodeFree(e) {
		const t = (this.r32(28) * Ji >> 2) + (e >> 5), n = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t), i = e & ~(1 << n);
			if (Atomics.compareExchange(this.i32, t, e, i) === e) break;
		}
		Atomics.add(this.i32, 6, 1);
	}
	inodeReadLock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		for (;;) {
			const e = Atomics.load(this.i32, t);
			if (e & rs) Atomics.wait(this.i32, t, e);
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
				if (0 === Atomics.compareExchange(this.i32, t, 0, rs)) return;
			} else Atomics.wait(this.i32, t, e);
		}
	}
	inodeWriteUnlock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		Atomics.store(this.i32, t, 0), Atomics.notify(this.i32, t, Infinity);
	}
	inodeBlockMap(e, t, n) {
		const i = this.inodeOffset(e);
		if (t < 10) {
			const e = this.r32(i + is + 4 * t);
			if (0 !== e) return e;
			if (!n) return 0;
			const s = this.blockAllocWithGrow();
			return s < 0 || this.w32(i + is + 4 * t, s), s;
		}
		if ((t -= 10) < 1024) {
			let e = this.r32(i + 88);
			if (0 === e) {
				if (!n) return 0;
				if (e = this.blockAllocWithGrow(), e < 0) return e;
				this.w32(i + 88, e);
			}
			const s = e * Ji + 4 * t, r = this.r32(s);
			if (0 !== r) return r;
			if (!n) return 0;
			const o = this.blockAllocWithGrow();
			return o < 0 || this.w32(s, o), o;
		}
		if ((t -= Zi) < 1048576) {
			const e = Math.floor(t / Zi), s = t % Zi;
			let r = this.r32(i + 92);
			if (0 === r) {
				if (!n) return 0;
				if (r = this.blockAllocWithGrow(), r < 0) return r;
				this.w32(i + 92, r);
			}
			const o = r * Ji + 4 * e;
			let a = this.r32(o);
			if (0 === a) {
				if (!n) return 0;
				if (a = this.blockAllocWithGrow(), a < 0) return a;
				this.w32(o, a);
			}
			const c = a * Ji + 4 * s, l = this.r32(c);
			if (0 !== l) return l;
			if (!n) return 0;
			const h = this.blockAllocWithGrow();
			return h < 0 || this.w32(c, h), h;
		}
		return -22;
	}
	inodeReadData(e, t, n, i) {
		const s = this.inodeOffset(e), r = this.r64(s + ts);
		if (t >= r) return 0;
		t + i > r && (i = r - t);
		let o = 0, a = 0;
		for (; i > 0;) {
			const s = Math.floor(t / Ji), r = t % Ji;
			let c = Ji - r;
			c > i && (c = i);
			const l = this.inodeBlockMap(e, s, !1);
			if (l <= 0) n.fill(0, a, a + c);
			else {
				const e = l * Ji + r;
				n.set(this.u8.subarray(e, e + c), a);
			}
			a += c, t += c, i -= c, o += c;
		}
		return o;
	}
	inodeWriteData(e, t, n, i) {
		const s = this.inodeOffset(e);
		let r = 0, o = 0;
		for (; i > 0;) {
			const s = Math.floor(t / Ji), a = t % Ji;
			let c = Ji - a;
			c > i && (c = i);
			const l = this.inodeBlockMap(e, s, !0);
			if (l < 0) return r > 0 ? r : l;
			const h = l * Ji + a;
			this.u8.set(n.subarray(o, o + c), h), o += c, t += c, i -= c, r += c;
		}
		return t > this.r64(s + ts) && this.w64(s + ts, t), r;
	}
	freeBlocksFrom(e, t) {
		const n = this.inodeOffset(e);
		for (let r = t; r < 10; r++) {
			const e = this.r32(n + is + 4 * r);
			e && (this.blockFree(e), this.w32(n + is + 4 * r, 0));
		}
		const i = this.r32(n + 88);
		if (i) {
			const e = t > 10 ? t - 10 : 0;
			for (let t = e; t < Zi; t++) {
				const e = i * Ji + 4 * t, n = this.r32(e);
				n && (this.blockFree(n), this.w32(e, 0));
			}
			0 === e && (this.blockFree(i), this.w32(n + 88, 0));
		}
		const s = this.r32(n + 92);
		if (s) {
			const e = t > 1034 ? t - 10 - Zi : 0, i = Math.floor(e / Zi);
			for (let t = i; t < Zi; t++) {
				const n = s * Ji + 4 * t, r = this.r32(n);
				if (!r) continue;
				const o = t === i ? e % Zi : 0;
				for (let e = o; e < Zi; e++) {
					const t = r * Ji + 4 * e, n = this.r32(t);
					n && (this.blockFree(n), this.w32(t, 0));
				}
				0 === o && (this.blockFree(r), this.w32(n, 0));
			}
			0 === i && (this.blockFree(s), this.w32(n + 92, 0));
		}
	}
	inodeTruncate(e, t) {
		const n = this.inodeOffset(e);
		if (t >= this.r64(n + ts)) return void this.w64(n + ts, t);
		const i = Math.ceil(t / Ji);
		this.freeBlocksFrom(e, i), this.w64(n + ts, t);
	}
	dirLookup(e, t) {
		const n = this.inodeOffset(e), i = this.r64(n + ts);
		let s = 0;
		for (; s < i;) {
			const n = Math.floor(s / Ji), r = s % Ji, o = this.inodeBlockMap(e, n, !1);
			if (o <= 0) return -5;
			const a = o * Ji;
			let c = i - s;
			c > 4096 - r && (c = Ji - r);
			let l = r;
			for (; l < r + c;) {
				const e = a + l, n = this.r32(e), i = this.view.getUint16(e + 4, !0), s = this.view.getUint16(e + 6, !0);
				if (0 === i) return -5;
				if (0 !== n && s === t.length) {
					let i = !0;
					for (let n = 0; n < t.length; n++) if (this.u8[e + 8 + n] !== t[n]) {
						i = !1;
						break;
					}
					if (i) return n;
				}
				l += i;
			}
			s += c;
		}
		return -2;
	}
	dirAddEntry(e, t, n) {
		const i = this.inodeOffset(e), s = this.r64(i + ts), r = ds(8 + t.length);
		let o = -1, a = 0;
		for (; a < s;) {
			const i = Math.floor(a / Ji), c = a % Ji, l = this.inodeBlockMap(e, i, !1);
			if (l <= 0) return -5;
			const h = l * Ji;
			let d = s - a;
			d > 4096 - c && (d = Ji - c);
			let f = c;
			for (; f < c + d;) {
				const e = h + f, i = this.r32(e), s = this.view.getUint16(e + 4, !0), a = this.view.getUint16(e + 6, !0);
				if (0 === s) return -5;
				if (0 === i && s >= r) return this.w32(e, n), this.view.setUint16(e + 6, t.length, !0), this.u8.set(t, e + 8), 0;
				const c = ds(8 + a), l = s - c;
				if (0 !== i && l >= r) {
					this.view.setUint16(e + 4, c, !0);
					const i = e + c;
					return this.w32(i, n), this.view.setUint16(i + 4, l, !0), this.view.setUint16(i + 6, t.length, !0), this.u8.set(t, i + 8), 0;
				}
				o = e, f += s;
			}
			a += d;
		}
		let c, l = s, h = Math.floor(l / Ji), d = l % Ji;
		if (0 !== d && d + r > 4096) {
			const t = Ji - d;
			if (t >= 8) {
				const n = this.inodeBlockMap(e, h, !1);
				if (n > 0) {
					const e = n * Ji + d;
					this.w32(e, 0), this.view.setUint16(e + 4, t, !0), this.view.setUint16(e + 6, 0, !0);
				}
			} else if (o >= 0) {
				const e = this.view.getUint16(o + 4, !0);
				this.view.setUint16(o + 4, e + t, !0);
			}
			l = (h + 1) * Ji, h++, d = 0;
		}
		if (0 === d) {
			if (c = this.inodeBlockMap(e, h, !0), c < 0) return c;
		} else if (c = this.inodeBlockMap(e, h, !1), c <= 0) return -5;
		const f = c * Ji + d;
		return this.w32(f, n), this.view.setUint16(f + 4, r, !0), this.view.setUint16(f + 6, t.length, !0), this.u8.set(t, f + 8), this.w64(i + ts, l + r), 0;
	}
	dirRemoveEntry(e, t) {
		const n = this.inodeOffset(e), i = this.r64(n + ts);
		let s = 0;
		for (; s < i;) {
			const n = Math.floor(s / Ji), r = s % Ji, o = this.inodeBlockMap(e, n, !1);
			if (o <= 0) return -5;
			const a = o * Ji;
			let c = i - s;
			c > 4096 - r && (c = Ji - r);
			let l = r;
			for (; l < r + c;) {
				const e = a + l, n = this.r32(e), i = this.view.getUint16(e + 4, !0), s = this.view.getUint16(e + 6, !0);
				if (0 === i) return -5;
				if (0 !== n && s === t.length) {
					let n = !0;
					for (let i = 0; i < t.length; i++) if (this.u8[e + 8 + i] !== t[i]) {
						n = !1;
						break;
					}
					if (n) return this.w32(e, 0), 0;
				}
				l += i;
			}
			s += c;
		}
		return -2;
	}
	dirIsEmpty(e) {
		const t = this.inodeOffset(e), n = this.r64(t + ts);
		let i = 0;
		for (; i < n;) {
			const t = Math.floor(i / Ji), s = i % Ji, r = this.inodeBlockMap(e, t, !1);
			if (r <= 0) return !0;
			const o = r * Ji;
			let a = n - i;
			a > 4096 - s && (a = Ji - s);
			let c = s;
			for (; c < s + a;) {
				const e = o + c, t = this.r32(e), n = this.view.getUint16(e + 4, !0), i = this.view.getUint16(e + 6, !0);
				if (0 === n) break;
				if (0 !== t) {
					if (1 === i && 46 === this.u8[e + 8]) {
						c += n;
						continue;
					}
					if (2 === i && 46 === this.u8[e + 8] && 46 === this.u8[e + 8 + 1]) {
						c += n;
						continue;
					}
					return !1;
				}
				c += n;
			}
			i += a;
		}
		return !0;
	}
	pathResolve(e, t) {
		if (!e.startsWith("/")) return -2;
		let n = 1;
		const i = e.split("/").filter((e) => e.length > 0);
		let s = 0;
		for (let r = 0; r < i.length; r++) {
			const e = i[r];
			if (e.length > 255) return -36;
			const o = this.inodeOffset(n);
			if (16384 != (61440 & this.r32(o + 8))) return -20;
			const a = cs.encode(e), c = this.dirLookup(n, a);
			if (c < 0) return c;
			const l = this.inodeOffset(c);
			if (40960 == (61440 & this.r32(l + 8)) && (r !== i.length - 1 || t)) {
				if (++s > 8) return -40;
				const e = this.r64(l + ts);
				let t;
				if (e <= 40) t = hs(this.u8.subarray(l + is, l + is + e));
				else {
					const n = new Uint8Array(e);
					this.inodeReadData(c, 0, n, e), t = ls.decode(n);
				}
				if (t.startsWith("/")) {
					n = 1;
					const e = t.split("/").filter((e) => e.length > 0), s = i.slice(r + 1);
					i.length = 0, i.push(...e, ...s), r = -1;
				} else {
					const e = t.split("/").filter((e) => e.length > 0), n = i.slice(r + 1);
					i.length = r, i.push(...e, ...n), r--;
				}
				continue;
			}
			n = c;
		}
		return n;
	}
	pathResolveParent(e) {
		if (!e.startsWith("/")) throw new as(-22, "Path must be absolute");
		const t = e.split("/").filter((e) => e.length > 0);
		if (0 === t.length) throw new as(-22, "Cannot operate on /");
		const n = t.pop();
		if (n.length > 255) throw new as(-36);
		const i = "/" + t.join("/"), s = this.pathResolve(i, !0);
		if (s < 0) throw new as(s);
		const r = this.inodeOffset(s);
		if (16384 != (61440 & this.r32(r + 8))) throw new as(-20);
		return {
			parentIno: s,
			name: n
		};
	}
	fdAlloc(e, t, n) {
		for (let i = 0; i < Qi; i++) {
			const s = 256 + 24 * i, r = s >> 2;
			if (0 === Atomics.compareExchange(this.i32, r, 0, 1)) return this.w32(s + 4, e), this.w64(s + 8, 0), this.w32(s + 16, t), this.w32(s + 20, n ? 1 : 0), i;
		}
		return -24;
	}
	fdGet(e) {
		if (e < 0 || e >= Qi) return null;
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
		if (e >= 0 && e < Qi) {
			const t = 256 + 24 * e;
			Atomics.store(this.i32, t >> 2, 0);
		}
	}
	buildStat(e) {
		const t = this.inodeOffset(e);
		return {
			ino: e,
			mode: this.r32(t + 8),
			linkCount: this.r32(t + es),
			size: this.r64(t + ts),
			mtime: this.r64(t + 24),
			ctime: this.r64(t + ns),
			atime: this.r64(t + 40),
			uid: this.r32(t + 96),
			gid: this.r32(t + ss)
		};
	}
	open(e, t, n = 420) {
		const i = 3 & t, s = !!(64 & t);
		let r = this.pathResolve(e, !0);
		if (r < 0 && -2 === r && s) {
			const { parentIno: t, name: i } = this.pathResolveParent(e);
			this.inodeWriteLock(t);
			try {
				const e = cs.encode(i), s = this.dirLookup(t, e);
				if (s >= 0) r = s;
				else {
					const i = this.inodeAlloc();
					if (i < 0) throw new as(-28);
					const s = this.inodeOffset(i);
					this.w32(s + 8, 32768 | 4095 & n), this.w32(s + es, 1), this.w64(s + ts, 0);
					const o = Date.now();
					this.w64(s + 40, o), this.w64(s + 24, o), this.w64(s + ns, o);
					const a = this.dirAddEntry(t, e, i);
					if (a < 0) throw this.inodeFree(i), new as(a);
					r = i;
				}
			} finally {
				this.inodeWriteUnlock(t);
			}
		}
		if (r < 0) throw new as(r);
		const o = this.inodeOffset(r), a = this.r32(o + 8);
		if (16384 == (61440 & a) && 0 !== i) throw new as(-21);
		if (65536 & t && 16384 != (61440 & a)) throw new as(-20);
		if (512 & t) {
			if (16384 == (61440 & a)) throw new as(-21);
			this.inodeWriteLock(r), this.inodeTruncate(r, 0), this.inodeWriteUnlock(r);
		}
		const c = this.fdAlloc(r, t, !1);
		if (c < 0) throw new as(c);
		if (1024 & t) {
			const e = 256 + 24 * c;
			this.w64(e + 8, this.r64(o + ts));
		}
		return c;
	}
	close(e) {
		if (!this.fdGet(e)) throw new as(-9);
		this.fdFree(e);
	}
	read(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new as(-9);
		this.inodeReadLock(n.ino);
		try {
			const i = this.inodeReadData(n.ino, n.offset, t, t.length), s = 256 + 24 * e;
			return this.w64(s + 8, n.offset + i), i;
		} finally {
			this.inodeReadUnlock(n.ino);
		}
	}
	write(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new as(-9);
		if (!(3 & n.flags)) throw new as(-9);
		this.inodeWriteLock(n.ino);
		try {
			let i = n.offset;
			if (1024 & n.flags) {
				const e = this.inodeOffset(n.ino);
				i = this.r64(e + ts);
			}
			const s = this.inodeWriteData(n.ino, i, t, t.length), r = 256 + 24 * e;
			return this.w64(r + 8, i + s), s;
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	lseek(e, t, n) {
		const i = this.fdGet(e);
		if (!i) throw new as(-9);
		let s;
		if (0 === n) s = t;
		else if (1 === n) s = i.offset + t;
		else {
			if (2 !== n) throw new as(-22);
			{
				const e = this.inodeOffset(i.ino);
				s = this.r64(e + ts) + t;
			}
		}
		if (s < 0) throw new as(-22);
		const r = 256 + 24 * e;
		return this.w64(r + 8, s), s;
	}
	ftruncate(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new as(-9);
		if (!(3 & n.flags)) throw new as(-9);
		this.inodeWriteLock(n.ino);
		try {
			this.inodeTruncate(n.ino, t);
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	fstat(e) {
		const t = this.fdGet(e);
		if (!t) throw new as(-9);
		this.inodeReadLock(t.ino);
		try {
			return this.buildStat(t.ino);
		} finally {
			this.inodeReadUnlock(t.ino);
		}
	}
	stat(e) {
		const t = this.pathResolve(e, !0);
		if (t < 0) throw new as(t);
		this.inodeReadLock(t);
		try {
			return this.buildStat(t);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	lstat(e) {
		const t = this.pathResolve(e, !1);
		if (t < 0) throw new as(t);
		this.inodeReadLock(t);
		try {
			return this.buildStat(t);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	unlink(e) {
		const { parentIno: t, name: n } = this.pathResolveParent(e), i = cs.encode(n);
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, i);
			if (e < 0) throw new as(e);
			const n = this.inodeOffset(e);
			if (16384 == (61440 & this.r32(n + 8))) throw new as(-21);
			const s = this.dirRemoveEntry(t, i);
			if (s < 0) throw new as(s);
			this.inodeWriteLock(e);
			const r = this.r32(n + es);
			r <= 1 ? (this.inodeTruncate(e, 0), this.w32(n + es, 0), this.inodeWriteUnlock(e), this.inodeFree(e)) : (this.w32(n + es, r - 1), this.inodeWriteUnlock(e));
		} finally {
			this.inodeWriteUnlock(t);
		}
	}
	rename(e, t) {
		const { parentIno: n, name: i } = this.pathResolveParent(e), { parentIno: s, name: r } = this.pathResolveParent(t), o = cs.encode(i), a = cs.encode(r), c = Math.min(n, s), l = Math.max(n, s);
		this.inodeWriteLock(c), c !== l && this.inodeWriteLock(l);
		try {
			const e = this.dirLookup(n, o);
			if (e < 0) throw new as(e);
			const t = this.dirLookup(s, a);
			if (t >= 0) {
				const e = this.inodeOffset(t);
				if (16384 == (61440 & this.r32(e + 8))) throw new as(-21);
				this.dirRemoveEntry(s, a), this.inodeWriteLock(t), this.inodeTruncate(t, 0), this.w32(e + es, 0), this.inodeWriteUnlock(t), this.inodeFree(t);
			}
			const i = this.dirAddEntry(s, a, e);
			if (i < 0) throw new as(i);
			this.dirRemoveEntry(n, o);
			const r = this.inodeOffset(e);
			if (16384 == (61440 & this.r32(r + 8)) && n !== s) {
				const e = this.inodeOffset(n);
				this.w32(e + es, this.r32(e + es) - 1);
				const t = this.inodeOffset(s);
				this.w32(t + es, this.r32(t + es) + 1);
			}
		} finally {
			c !== l && this.inodeWriteUnlock(l), this.inodeWriteUnlock(c);
		}
	}
	mkdir(e, t = 493) {
		const { parentIno: n, name: i } = this.pathResolveParent(e), s = cs.encode(i);
		this.inodeWriteLock(n);
		try {
			if (this.dirLookup(n, s) >= 0) throw new as(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new as(-28);
			const i = this.inodeOffset(e);
			this.w32(i + 8, 16384 | t), this.w32(i + es, 2), this.w64(i + ts, 0);
			const r = Date.now();
			this.w64(i + 40, r), this.w64(i + 24, r), this.w64(i + ns, r);
			const o = this.blockAllocWithGrow();
			if (o < 0) throw this.inodeFree(e), new as(-28);
			this.w32(i + is, o);
			const a = o * Ji, c = ds(9), l = ds(10);
			this.w32(a, e), this.view.setUint16(a + 4, c, !0), this.view.setUint16(a + 6, 1, !0), this.u8[a + 8] = 46;
			const h = a + c;
			this.w32(h, n), this.view.setUint16(h + 4, l, !0), this.view.setUint16(h + 6, 2, !0), this.u8[h + 8] = 46, this.u8[h + 8 + 1] = 46, this.w64(i + ts, c + l);
			const d = this.dirAddEntry(n, s, e);
			if (d < 0) throw this.blockFree(o), this.inodeFree(e), new as(d);
			const f = this.inodeOffset(n);
			this.w32(f + es, this.r32(f + es) + 1);
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	rmdir(e) {
		const { parentIno: t, name: n } = this.pathResolveParent(e), i = cs.encode(n);
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, i);
			if (e < 0) throw new as(e);
			const n = this.inodeOffset(e);
			if (16384 != (61440 & this.r32(n + 8))) throw new as(-20);
			this.inodeWriteLock(e);
			try {
				if (!this.dirIsEmpty(e)) throw new as(-39);
				this.dirRemoveEntry(t, i), this.inodeTruncate(e, 0), this.w32(n + es, 0);
			} finally {
				this.inodeWriteUnlock(e);
			}
			this.inodeFree(e);
			const s = this.inodeOffset(t);
			this.w32(s + es, this.r32(s + es) - 1);
		} finally {
			this.inodeWriteUnlock(t);
		}
	}
	symlink(e, t) {
		const { parentIno: n, name: i } = this.pathResolveParent(t), s = cs.encode(i), r = cs.encode(e);
		this.inodeWriteLock(n);
		try {
			if (this.dirLookup(n, s) >= 0) throw new as(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new as(-28);
			const t = this.inodeOffset(e);
			if (this.w32(t + 8, 41471), this.w32(t + es, 1), r.length <= 40) this.u8.set(r, t + is), this.w64(t + ts, r.length);
			else {
				this.w64(t + ts, 0);
				const n = this.inodeWriteData(e, 0, r, r.length);
				if (n < 0) throw this.inodeFree(e), new as(n);
			}
			const i = this.dirAddEntry(n, s, e);
			if (i < 0) throw this.inodeFree(e), new as(i);
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	chmod(e, t) {
		const n = this.pathResolve(e, !0);
		if (n < 0) throw new as(n);
		this.inodeWriteLock(n);
		try {
			const e = this.inodeOffset(n), i = this.r32(e + 8);
			this.w32(e + 8, 61440 & i | 4095 & t), this.w64(e + ns, Date.now());
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	fchmod(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new as(-9);
		this.inodeWriteLock(n.ino);
		try {
			const e = this.inodeOffset(n.ino), i = this.r32(e + 8);
			this.w32(e + 8, 61440 & i | 4095 & t), this.w64(e + ns, Date.now());
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	chown(e, t, n) {
		const i = this.pathResolve(e, !0);
		if (i < 0) throw new as(i);
		this.inodeWriteLock(i);
		try {
			const e = this.inodeOffset(i);
			this.w32(e + 96, t), this.w32(e + ss, n), this.w64(e + ns, Date.now());
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	fchown(e, t, n) {
		const i = this.fdGet(e);
		if (!i) throw new as(-9);
		this.inodeWriteLock(i.ino);
		try {
			const e = this.inodeOffset(i.ino);
			this.w32(e + 96, t), this.w32(e + ss, n), this.w64(e + ns, Date.now());
		} finally {
			this.inodeWriteUnlock(i.ino);
		}
	}
	lchown(e, t, n) {
		const i = this.pathResolve(e, !1);
		if (i < 0) throw new as(i);
		this.inodeWriteLock(i);
		try {
			const e = this.inodeOffset(i);
			this.w32(e + 96, t), this.w32(e + ss, n), this.w64(e + ns, Date.now());
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	utimens(e, t, n, i, s) {
		const r = this.pathResolve(e, !0);
		if (r < 0) throw new as(r);
		this.inodeWriteLock(r);
		try {
			const e = this.inodeOffset(r), o = 1073741823, a = 1073741822, c = Date.now();
			if (n !== a) {
				const i = n === o ? c : 1e3 * t + Math.floor(n / 1e6);
				this.w64(e + 40, i);
			}
			if (s !== a) {
				const t = s === o ? c : 1e3 * i + Math.floor(s / 1e6);
				this.w64(e + 24, t);
			}
			this.w64(e + ns, c);
		} finally {
			this.inodeWriteUnlock(r);
		}
	}
	link(e, t) {
		const n = this.pathResolve(e, !0);
		if (n < 0) throw new as(n);
		const i = this.inodeOffset(n);
		if (16384 == (61440 & this.r32(i + 8))) throw new as(-1);
		const { parentIno: s, name: r } = this.pathResolveParent(t), o = cs.encode(r);
		this.inodeWriteLock(s);
		try {
			if (this.dirLookup(s, o) >= 0) throw new as(-17);
			const e = this.dirAddEntry(s, o, n);
			if (e < 0) throw new as(e);
			this.inodeWriteLock(n);
			try {
				const e = this.r32(i + es);
				this.w32(i + es, e + 1), this.w64(i + ns, Date.now());
			} finally {
				this.inodeWriteUnlock(n);
			}
		} finally {
			this.inodeWriteUnlock(s);
		}
	}
	readlink(e) {
		const t = this.pathResolve(e, !1);
		if (t < 0) throw new as(t);
		const n = this.inodeOffset(t);
		if (40960 != (61440 & this.r32(n + 8))) throw new as(-22);
		const i = this.r64(n + ts);
		if (i <= 40) return hs(this.u8.subarray(n + is, n + is + i));
		this.inodeReadLock(t);
		try {
			const e = new Uint8Array(i);
			return this.inodeReadData(t, 0, e, i), ls.decode(e);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	opendir(e) {
		const t = this.pathResolve(e, !0);
		if (t < 0) throw new as(t);
		const n = this.inodeOffset(t);
		if (16384 != (61440 & this.r32(n + 8))) throw new as(-20);
		const i = this.fdAlloc(t, 0, !0);
		if (i < 0) throw new as(i);
		return i;
	}
	readdirEntry(e) {
		const t = this.fdGet(e);
		if (!t || !t.isDir) throw new as(-9);
		const n = this.inodeOffset(t.ino), i = this.r64(n + ts);
		for (; t.offset < i;) {
			const n = t.offset, i = Math.floor(n / Ji), s = n % Ji, r = this.inodeBlockMap(t.ino, i, !1);
			if (r <= 0) return null;
			const o = r * Ji + s, a = this.r32(o), c = this.view.getUint16(o + 4, !0), l = this.view.getUint16(o + 6, !0);
			if (0 === c) return null;
			t.offset = n + c;
			const h = 256 + 24 * e;
			if (this.w64(h + 8, n + c), 0 !== a) return {
				name: hs(this.u8.subarray(o + 8, o + 8 + l)),
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
		const n = "string" == typeof t ? cs.encode(t) : t, i = this.open(e, 577);
		try {
			this.write(i, n);
		} finally {
			this.close(i);
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
		return ls.decode(this.readFile(e));
	}
};
const us = [
	40,
	181,
	47,
	253
], gs = 1447449417, ps = 16, ms = 65536;
function ys(e) {
	if (!e || "object" != typeof e) throw new Error("VFS image metadata must be an object");
	if (1 !== e.version) throw new Error(`Unsupported VFS image metadata version: ${String(e.version)}`);
	if (void 0 !== e.kernelAbi && (!Number.isInteger(e.kernelAbi) || e.kernelAbi < 0)) throw new Error("VFS image metadata kernelAbi must be a non-negative integer");
	if (void 0 !== e.createdBy && "string" != typeof e.createdBy) throw new Error("VFS image metadata createdBy must be a string");
	return { ...e };
}
function ws(e) {
	return e.byteLength >= us.length && e[0] === us[0] && e[1] === us[1] && e[2] === us[2] && e[3] === us[3] ? function(e) {
		return Yi(e);
	}(e) : e;
}
function bs(e) {
	const t = ws(e);
	if (t.byteLength < ps) throw new Error("VFS image too small");
	const n = new DataView(t.buffer, t.byteOffset, t.byteLength), i = n.getUint32(0, !0);
	if (i !== gs) throw new Error(`Bad VFS image magic: 0x${i.toString(16)} (expected 0x${gs.toString(16)})`);
	const s = n.getUint32(4, !0);
	if (1 !== s) throw new Error(`Unsupported VFS image version: ${s} (expected 1)`);
	const r = n.getUint32(8, !0), o = n.getUint32(12, !0);
	if (t.byteLength < ps + o + 4) throw new Error("VFS image truncated");
	return {
		image: t,
		view: n,
		flags: r,
		sabLen: o
	};
}
var ks = class e {
	fs;
	imageMetadata;
	lazyFiles = /* @__PURE__ */ new Map();
	lazyArchiveGroups = [];
	lazyArchiveInodes = /* @__PURE__ */ new Map();
	lazyDownloadListeners = /* @__PURE__ */ new Set();
	constructor(e, t = null) {
		this.fs = e, this.imageMetadata = t;
	}
	get sharedBuffer() {
		return this.fs.buffer;
	}
	static create(t, n) {
		return new e(fs.mkfs(t, n));
	}
	static fromExisting(t) {
		return new e(fs.mount(t));
	}
	rebaseToNewFileSystem(t) {
		if (!Number.isSafeInteger(t) || t <= 0) throw new Error(`Invalid MemoryFileSystem maxByteLength: ${t}`);
		const n = Math.min(t, Math.max(this.sharedBuffer.byteLength, 16777216)), i = new SharedArrayBuffer(n, { maxByteLength: t }), s = e.create(i, t);
		s.setImageMetadata(this.imageMetadata);
		const r = this.exportLazyEntries(), o = new Set(r.map((e) => e.path)), a = this.exportLazyArchiveEntries(), c = /* @__PURE__ */ new Set();
		for (const e of a) if (!e.materialized) for (const t of e.entries) t.deleted || t.isSymlink || c.add(t.vfsPath);
		return this.copyPathToFreshFileSystem("/", s, o, c), s.importLazyEntries(r.map((e) => ({
			...e,
			ino: s.lstat(e.path).ino
		}))), s.importLazyArchiveEntries(a.map((e) => ({
			...e,
			entries: e.entries.map((e) => ({
				...e,
				ino: e.deleted ? 0 : s.lstat(e.vfsPath).ino
			}))
		}))), s;
	}
	getImageMetadata() {
		return null === (e = this.imageMetadata) ? null : { ...e };
		var e;
	}
	setImageMetadata(e) {
		this.imageMetadata = null === e ? null : ys(e);
	}
	subscribeLazyDownloads(e) {
		return this.lazyDownloadListeners.add(e), () => this.lazyDownloadListeners.delete(e);
	}
	emitLazyDownload(e) {
		if (0 === this.lazyDownloadListeners.size) return;
		const t = {
			...e,
			t: "undefined" != typeof performance ? performance.now() : Date.now()
		};
		for (const n of this.lazyDownloadListeners) try {
			n(t);
		} catch {}
	}
	async fetchLazyBytes(e) {
		let t = 0, n = e.fallbackTotalBytes;
		const i = {
			id: e.id,
			kind: e.kind,
			url: e.url,
			path: e.path,
			mountPrefix: e.mountPrefix
		};
		this.emitLazyDownload({
			...i,
			status: "started",
			loadedBytes: t,
			totalBytes: n
		});
		try {
			const s = await fetch(e.url);
			if (!s.ok) throw new Error(`HTTP ${s.status}`);
			if (n = function(e) {
				const t = e?.get("content-length");
				if (!t) return;
				const n = Number(t);
				return Number.isFinite(n) && n >= 0 ? n : void 0;
			}(s.headers) ?? n, !s.body) {
				const e = new Uint8Array(await s.arrayBuffer());
				return t = e.byteLength, this.emitLazyDownload({
					...i,
					status: "progress",
					loadedBytes: t,
					totalBytes: n ?? t
				}), this.emitLazyDownload({
					...i,
					status: "complete",
					loadedBytes: t,
					totalBytes: n ?? t
				}), e;
			}
			const r = s.body.getReader(), o = [];
			try {
				for (;;) {
					const { done: e, value: s } = await r.read();
					if (e) break;
					s && (o.push(s), t += s.byteLength, this.emitLazyDownload({
						...i,
						status: "progress",
						loadedBytes: t,
						totalBytes: n
					}));
				}
			} finally {
				r.releaseLock();
			}
			const a = function(e, t) {
				if (1 === e.length) return e[0];
				const n = new Uint8Array(t);
				let i = 0;
				for (const s of e) n.set(s, i), i += s.byteLength;
				return n;
			}(o, t);
			return this.emitLazyDownload({
				...i,
				status: "complete",
				loadedBytes: t,
				totalBytes: n ?? t
			}), a;
		} catch (zi) {
			const s = zi instanceof Error ? zi.message : String(zi);
			throw this.emitLazyDownload({
				...i,
				status: "error",
				loadedBytes: t,
				totalBytes: n,
				error: s
			}), zi;
		}
	}
	registerLazyFile(e, t, n, i = 493) {
		const s = e.split("/").filter(Boolean);
		let r = "";
		for (let c = 0; c < s.length - 1; c++) {
			r += "/" + s[c];
			try {
				this.fs.mkdir(r, 493);
			} catch {}
		}
		const o = this.fs.open(e, 577, i);
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
		for (const [t, { path: n, url: i, size: s }] of this.lazyFiles) e.push({
			ino: t,
			path: n,
			url: i,
			size: s
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
	registerLazyArchiveFromEntries(e, t, n, i) {
		const s = {
			url: e,
			mountPrefix: n,
			materialized: !1,
			entries: /* @__PURE__ */ new Map()
		}, r = n.replace(/\/+$/, "");
		for (const o of t) {
			if (o.isDirectory) continue;
			const e = r + "/" + o.fileName, t = e.split("/").filter(Boolean);
			let n = "";
			for (let i = 0; i < t.length - 1; i++) {
				n += "/" + t[i];
				try {
					this.fs.mkdir(n, 493);
				} catch {}
			}
			if (o.isSymlink && i?.has(o.fileName)) {
				const t = i.get(o.fileName);
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
			for (const i of t.entries) e.set(i.vfsPath, {
				ino: i.ino,
				size: i.size,
				isSymlink: i.isSymlink,
				deleted: i.deleted
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
				const e = await this.fetchLazyBytes({
					id: `file:${t.ino}`,
					kind: "file",
					url: n.url,
					path: n.path,
					fallbackTotalBytes: n.size
				}), i = this.fs.open(n.path, 577, 493);
				return this.fs.write(i, e), this.fs.close(i), this.lazyFiles.delete(t.ino), !0;
			}
			const i = this.lazyArchiveInodes.get(t.ino);
			return !!i && (await this.ensureArchiveMaterialized(i), !0);
		} catch {
			return !1;
		}
	}
	async ensureArchiveMaterialized(e) {
		if (e.materialized) return;
		const t = await this.fetchLazyBytes({
			id: `archive:${e.mountPrefix}:${e.url}`,
			kind: "archive",
			url: e.url,
			mountPrefix: e.mountPrefix
		}), { parseZipCentralDirectory: n, extractZipEntry: i } = await import("./zip-D1JNL24E.js"), s = n(t), r = /* @__PURE__ */ new Map();
		for (const a of s) r.set(a.fileName, a);
		const o = e.mountPrefix.replace(/\/+$/, "");
		for (const [a, c] of e.entries) {
			if (c.deleted) continue;
			if (c.isSymlink) continue;
			const e = a.slice(o.length + 1), n = r.get(e);
			if (!n) continue;
			const s = i(t, n), l = this.fs.open(a, 577, 493);
			s.length > 0 && this.fs.write(l, s), this.fs.close(l);
		}
		e.materialized = !0;
		for (const [, a] of e.entries) this.lazyArchiveInodes.delete(a.ino);
	}
	async saveImage(e) {
		if (e?.materializeAll) {
			const e = Array.from(this.lazyFiles.values()).map((e) => e.path);
			for (const t of e) await this.ensureMaterialized(t);
		}
		const t = new Uint8Array(this.fs.buffer), n = this.exportLazyEntries(), i = n.length > 0, s = i ? new TextEncoder().encode(JSON.stringify(n)) : new Uint8Array(0), r = this.exportLazyArchiveEntries(), o = r.length > 0, a = o ? new TextEncoder().encode(JSON.stringify(r)) : new Uint8Array(0), c = function(e) {
			if (null === e) return new Uint8Array(0);
			const t = ys(e), n = new TextEncoder().encode(JSON.stringify(t));
			if (n.byteLength > ms) throw new Error("VFS image metadata exceeds 65536 bytes");
			return n;
		}(void 0 === e?.metadata ? this.imageMetadata : e.metadata), l = c.byteLength > 0, h = o ? 4 + a.byteLength : 0, d = l ? 4 + c.byteLength : 0, f = ps + t.byteLength + 4 + s.byteLength + h + d, u = new Uint8Array(f), g = new DataView(u.buffer);
		g.setUint32(0, gs, !0), g.setUint32(4, 1, !0), g.setUint32(8, (i ? 1 : 0) | (o ? 2 : 0) | (l ? 4 : 0), !0), g.setUint32(12, t.byteLength, !0);
		const p = new Uint8Array(t.byteLength);
		p.set(t), u.set(p, ps);
		const m = ps + t.byteLength;
		if (g.setUint32(m, s.byteLength, !0), s.byteLength > 0 && u.set(s, m + 4), o) {
			const e = m + 4 + s.byteLength;
			g.setUint32(e, a.byteLength, !0), u.set(a, e + 4);
		}
		if (l) {
			const e = m + 4 + s.byteLength + h;
			g.setUint32(e, c.byteLength, !0), u.set(c, e + 4);
		}
		return u;
	}
	static readImageMetadata(e) {
		const t = bs(e);
		if (!(4 & t.flags)) return null;
		const { metadataOffset: n } = function(e, t, n, i) {
			const s = ps + i, r = t.getUint32(s, !0), o = s + 4 + r;
			let a = o;
			if (2 & n) {
				if (e.byteLength < o + 4) throw new Error("VFS image truncated (lazy archive section)");
				a = o + 4 + t.getUint32(o, !0);
			}
			return {
				lazyLen: r,
				archiveOffset: o,
				metadataOffset: a
			};
		}(t.image, t.view, t.flags, t.sabLen);
		if (t.image.byteLength < n + 4) throw new Error("VFS image truncated (metadata section)");
		const i = t.view.getUint32(n, !0);
		if (i > ms) throw new Error("VFS image metadata exceeds 65536 bytes");
		if (t.image.byteLength < n + 4 + i) throw new Error("VFS image truncated (metadata payload)");
		return 0 === i ? null : function(e) {
			if (e.byteLength > ms) throw new Error("VFS image metadata exceeds 65536 bytes");
			let t;
			try {
				t = JSON.parse(new TextDecoder().decode(e));
			} catch (n) {
				const e = n instanceof Error ? n.message : String(n);
				throw new Error(`Invalid VFS image metadata JSON: ${e}`);
			}
			return ys(t);
		}(t.image.subarray(n + 4, n + 4 + i));
	}
	static assertImageKernelAbi(t, n, i = "VFS image") {
		const s = e.readImageMetadata(t)?.kernelAbi;
		if (void 0 !== s && s !== n) throw new Error(`${i} requires kernel ABI ${s}, but the running kernel is ABI ${n}`);
	}
	static fromImage(t, n) {
		const i = bs(t);
		t = i.image;
		const s = i.view, r = i.flags, o = i.sabLen, a = n?.maxByteLength ? { maxByteLength: n.maxByteLength } : void 0, c = new SharedArrayBuffer(o, a);
		new Uint8Array(c).set(t.subarray(ps, ps + o));
		let l = null;
		4 & r && (l = e.readImageMetadata(t));
		const h = new e(fs.mount(c), l), d = ps + o, f = s.getUint32(d, !0);
		if (1 & r && f > 0) {
			const e = t.subarray(d + 4, d + 4 + f), n = JSON.parse(new TextDecoder().decode(e));
			h.importLazyEntries(n);
		}
		if (2 & r) {
			const e = d + 4 + f;
			if (t.byteLength < e + 4) throw new Error("VFS image truncated (lazy archive section)");
			const n = s.getUint32(e, !0);
			if (n > 0) {
				const i = t.subarray(e + 4, e + 4 + n), s = JSON.parse(new TextDecoder().decode(i));
				h.importLazyArchiveEntries(s);
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
	read(e, t, n, i) {
		if (null !== n) {
			const s = this.fs.lseek(e, 0, 1);
			this.fs.lseek(e, n, 0);
			const r = this.fs.read(e, t.subarray(0, i));
			return this.fs.lseek(e, s, 0), r;
		}
		return this.fs.read(e, t.subarray(0, i));
	}
	write(e, t, n, i) {
		if (null !== n) {
			const s = this.fs.lseek(e, 0, 1);
			this.fs.lseek(e, n, 0);
			const r = this.fs.write(e, t.subarray(0, i));
			return this.fs.lseek(e, s, 0), r;
		}
		return this.fs.write(e, t.subarray(0, i));
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
				const i = n.entries.get(e);
				i && (i.deleted = !0), this.lazyArchiveInodes.delete(t.ino);
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
	createFileWithOwner(e, t, n, i, s) {
		const r = this.open(e, 577, t);
		s.length > 0 && this.write(r, s, null, s.length), this.close(r), this.chown(e, n, i), this.chmod(e, t);
	}
	mkdirWithOwner(e, t, n, i) {
		this.mkdir(e, t), this.chown(e, n, i), this.chmod(e, t);
	}
	symlinkWithOwner(e, t, n, i) {
		this.symlink(e, t), this.lchown(t, n, i);
	}
	copyPathToFreshFileSystem(t, n, i, s) {
		const r = this.lstat(t), o = 61440 & r.mode, a = 4095 & r.mode;
		if (16384 === o) {
			"/" === t ? (n.chown(t, r.uid, r.gid), n.chmod(t, a)) : n.mkdirWithOwner(t, a, r.uid, r.gid);
			const o = this.opendir(t);
			try {
				for (;;) {
					const e = this.readdir(o);
					if (!e) break;
					"." !== e.name && ".." !== e.name && this.copyPathToFreshFileSystem("/" === t ? `/${e.name}` : `${t}/${e.name}`, n, i, s);
				}
			} finally {
				this.closedir(o);
			}
			e.applyTimes(n, t, r);
			return;
		}
		if (40960 !== o) {
			if (32768 !== o) throw new Error(`Unsupported file type while rebasing VFS: ${t}`);
			if (i.has(t) || s.has(t)) return n.createFileWithOwner(t, a, r.uid, r.gid, new Uint8Array(0)), void e.applyTimes(n, t, r);
			this.copyRegularFileToFreshFileSystem(t, n, r, a);
		} else n.symlinkWithOwner(this.readlink(t), t, r.uid, r.gid);
	}
	copyRegularFileToFreshFileSystem(t, n, i, s) {
		const r = this.open(t, 0, 0);
		let o = null;
		try {
			o = n.open(t, 577, s);
			const e = new Uint8Array(Math.min(1048576, Math.max(1, i.size)));
			let a = i.size;
			for (; a > 0;) {
				const i = Math.min(e.byteLength, a), s = this.read(r, e, null, i);
				if (s <= 0) throw new Error(`Unexpected EOF while rebasing VFS file: ${t}`);
				let c = 0;
				for (; c < s;) {
					const i = n.write(o, e.subarray(c, s), null, s - c);
					if (i <= 0) throw new Error(`Short write while rebasing VFS file: ${t}`);
					c += i;
				}
				a -= s;
			}
		} finally {
			null !== o && n.close(o), this.close(r);
		}
		n.chown(t, i.uid, i.gid), n.chmod(t, s), e.applyTimes(n, t, i);
	}
	static applyTimes(e, t, n) {
		const i = Math.floor(n.atimeMs / 1e3), s = Math.floor(1e6 * (n.atimeMs - 1e3 * i)), r = Math.floor(n.mtimeMs / 1e3), o = Math.floor(1e6 * (n.mtimeMs - 1e3 * r));
		e.utimensat(t, i, s, r, o);
	}
	access(e, t) {
		this.fs.stat(e);
	}
	utimensat(e, t, n, i, s) {
		this.fs.utimens(e, t, n, i, s);
	}
	opendir(e) {
		return this.fs.opendir(e);
	}
	readdir(e) {
		const t = this.fs.readdirEntry(e);
		if (!t) return null;
		const n = t.stat.mode;
		let i = 0;
		return 32768 == (61440 & n) ? i = 8 : 16384 == (61440 & n) ? i = 4 : 40960 == (61440 & n) && (i = 10), {
			name: t.name,
			type: i,
			ino: t.stat.ino
		};
	}
	closedir(e) {
		this.fs.closedir(e);
	}
};
var Is = class {
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
const vs = [
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
function xs(e) {
	const t = function(e, t) {
		let n = null;
		try {
			const i = e.stat(t);
			n = e.open(t, 0, 0);
			const s = new Uint8Array(i.size);
			let r = 0;
			for (; r < s.byteLength;) {
				const t = e.read(n, s.subarray(r), null, s.byteLength - r);
				if (t <= 0) break;
				r += t;
			}
			return new TextDecoder().decode(s.subarray(0, r));
		} catch {
			return null;
		} finally {
			if (null !== n) try {
				e.close(n);
			} catch {}
		}
	}(e, "/etc/group");
	null === t || /^nobody:/m.test(t) || function(e, t, n) {
		const i = new TextEncoder().encode(n), s = e.open(t, 577, 420);
		try {
			i.byteLength > 0 && e.write(s, i, null, i.byteLength);
		} finally {
			e.close(s);
		}
	}(e, "/etc/group", `${t.replace(/\n?$/, "\n")}nobody:x:65534:\n`);
}
function _s(e, t, n = {}) {
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
	const i = [];
	for (const s of e) if ("image" === s.source) {
		const e = ks.fromImage(t, { maxByteLength: 1073741824 });
		xs(e), i.push({
			mountPoint: s.path,
			backend: e,
			readonly: s.readonly
		});
	} else {
		const e = n.scratchSabBytes?.[s.path] ?? 16777216, t = new SharedArrayBuffer(e), r = ks.create(t);
		void 0 !== s.mode && r.chmod("/", s.mode), void 0 === s.uid && void 0 === s.gid || r.chown("/", s.uid ?? 0, s.gid ?? 0), i.push({
			mountPoint: s.path,
			backend: r,
			readonly: s.readonly
		});
	}
	return i;
}
var Ps = class {
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
		const n = this.resolve(e), i = this.resolve(t);
		if (n.backend !== i.backend) throw new Error("EXDEV: cross-device link");
		return {
			backend: n.backend,
			rel1: n.relativePath,
			rel2: i.relativePath
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
		const { backend: i, relativePath: s } = this.resolve(e), r = i.open(s, t, n), o = this.nextFileHandle++;
		return this.fileHandles.set(o, {
			backend: i,
			localHandle: r
		}), o;
	}
	close(e) {
		const t = this.getFileHandle(e), n = t.backend.close(t.localHandle);
		return this.fileHandles.delete(e), n;
	}
	read(e, t, n, i) {
		const s = this.getFileHandle(e);
		return s.backend.read(s.localHandle, t, n, i);
	}
	write(e, t, n, i) {
		const s = this.getFileHandle(e);
		return s.backend.write(s.localHandle, t, n, i);
	}
	seek(e, t, n) {
		const i = this.getFileHandle(e);
		return i.backend.seek(i.localHandle, t, n);
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
		const i = this.getFileHandle(e);
		i.backend.fchown(i.localHandle, t, n);
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
		const { backend: n, relativePath: i } = this.resolve(e);
		n.mkdir(i, t);
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
		const { backend: n, rel1: i, rel2: s } = this.resolveTwoPaths(e, t);
		n.rename(i, s);
	}
	link(e, t) {
		const { backend: n, rel1: i, rel2: s } = this.resolveTwoPaths(e, t);
		n.link(i, s);
	}
	symlink(e, t) {
		const { backend: n, relativePath: i } = this.resolve(t);
		n.symlink(e, i);
	}
	readlink(e) {
		const { backend: t, relativePath: n } = this.resolve(e);
		return t.readlink(n);
	}
	chmod(e, t) {
		const { backend: n, relativePath: i } = this.resolve(e);
		n.chmod(i, t);
	}
	chown(e, t, n) {
		const { backend: i, relativePath: s } = this.resolve(e);
		i.chown(s, t, n);
	}
	access(e, t) {
		const { backend: n, relativePath: i } = this.resolve(e);
		n.access(i, t);
	}
	utimensat(e, t, n, i, s) {
		const { backend: r, relativePath: o } = this.resolve(e);
		r.utimensat(o, t, n, i, s);
	}
	opendir(e) {
		const { backend: t, relativePath: n } = this.resolve(e), i = t.opendir(n), s = this.nextDirHandle++;
		return this.dirHandles.set(s, {
			backend: t,
			localHandle: i
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
	const e = [], t = /* @__PURE__ */ new Set(), n = new MessageChannel();
	let i = 0, s = !1, r = !1;
	n.port1.onmessage = () => {
		s = !1, r = !0;
		const i = e.length;
		for (let n = 0; n < i && e.length > 0; n++) {
			const n = e.shift();
			t.delete(n.id) || n.fn(...n.args);
		}
		r = !1, e.length > 0 && !s && (s = !0, n.port2.postMessage(null));
	}, globalThis.setImmediate = (t, ...o) => {
		const a = ++i;
		return e.push({
			id: a,
			fn: t,
			args: o
		}), s || r || (s = !0, n.port2.postMessage(null)), a;
	}, globalThis.clearImmediate = (e) => {
		t.add(e);
	};
}
const Bs = 16384, Us = new TextEncoder(), As = new TextDecoder();
let Ss = null, Ms = !1;
function Es(e) {
	self.postMessage(e);
}
function Cs(e, t) {
	Es({
		type: "machine",
		machine: e,
		status: t
	});
}
function Ts(e, t) {
	Es({
		type: "step",
		step: e,
		status: t
	});
}
function zs(e, t, n) {
	0 !== n.length && Es({
		type: "log",
		machine: e,
		stream: t,
		text: n
	});
}
function Os(e, t, n, i) {
	Es({
		type: "result",
		step: e,
		title: t,
		ok: n,
		detail: i
	});
}
async function Rs(e) {
	const t = await fetch(e);
	if (!t.ok) throw new Error(`failed to fetch ${e}: ${t.status}`);
	return t.arrayBuffer();
}
async function Fs(e, t, n) {
	const i = /* @__PURE__ */ new Map(), s = St(n.programBytes), r = 100;
	let o = "", a = "", c = !1;
	Cs(n.machine, `running ${n.programName}`);
	const l = function(e, t, n, i) {
		const s = new Ps([
			{
				mountPoint: "/dev/shm",
				backend: ks.create(new SharedArrayBuffer(1048576))
			},
			{
				mountPoint: "/dev",
				backend: new _i()
			},
			..._s(vs, t)
		], new Is());
		return s.network = e.attachMachine({
			id: n,
			address: i,
			hostnames: [n]
		}), s;
	}(e, t.rootfs, n.machine, n.address), h = new oi("/kandelo/assets/worker-entry-browser-DbUPHTXD.js");
	let d, f;
	const u = new Promise((e, t) => {
		d = e, f = t;
	}), g = new ri({
		maxWorkers: 4,
		dataBufferSize: 65536,
		useSharedMemory: !0
	}, l, {
		onExit: (e, t) => {
			c || e === r && (c = !0, g.unregisterProcess(e), i.get(e)?.terminate().catch(() => {}), i.delete(e), d(t));
		},
		onExitGroup: (e) => {
			i.get(e)?.terminate().catch(() => {}), i.delete(e);
		}
	});
	g.usePolling = !1, g.relistenBatchSize = 8, g.setOutputCallbacks({
		onStdout: (e) => {
			const t = As.decode(e);
			o += t, zs(n.machine, "stdout", t);
		},
		onStderr: (e) => {
			const t = As.decode(e);
			a += t, zs(n.machine, "stderr", t);
		}
	}), await g.init(t.kernel);
	const p = function(e, t = 17) {
		return 8 === e ? new WebAssembly.Memory({
			initial: BigInt(t),
			maximum: BigInt(Bs),
			shared: !0,
			address: "i64"
		}) : new WebAssembly.Memory({
			initial: t,
			maximum: Bs,
			shared: !0
		});
	}(s), m = 1073610752;
	(function(e, t, n) {
		const i = Bs - n;
		i <= 0 || (8 === t ? e.grow(BigInt(i)) : e.grow(i));
	})(p, s, 17), new Uint8Array(p.buffer, m, 65608).fill(0), g.registerProcess(r, p, [m], {
		argv: n.argv,
		ptrWidth: s,
		stdio: ii
	});
	const y = function(e) {
		const t = new Uint8Array(e);
		if (t.length < 8) return null;
		let n = 0, i = 0, s = null, r = null, o = 8;
		for (; o < t.length;) {
			const e = t[o], [a, c] = Pt(t, o + 1), l = o + 1 + c;
			if (2 === e) {
				const e = {
					funcImports: i,
					globalImports: n
				};
				let s = l;
				const [r, o] = Pt(t, s);
				s += o;
				for (let n = 0; n < r; n++) s = Bt(t, s, e);
				i = e.funcImports, n = e.globalImports;
			} else if (6 === e) r = {
				offset: l,
				size: a
			};
			else if (7 === e) {
				let e = l;
				const [n, i] = Pt(t, e);
				e += i;
				for (let r = 0; r < n; r++) {
					const [n, i] = Pt(t, e);
					e += i;
					const r = new TextDecoder().decode(t.subarray(e, e + n));
					e += n;
					const o = t[e++], [a, c] = Pt(t, e);
					if (e += c, 3 === o && "__heap_base" === r) {
						s = a;
						break;
					}
				}
				if (null === s) return null;
				if (null === r) return null;
				break;
			}
			o = l + a;
		}
		if (null === s || null === r) return null;
		const a = s - n;
		if (a < 0) return null;
		let c = r.offset;
		const [l, h] = Pt(t, c);
		if (c += h, a >= l) return null;
		for (let d = 0; d < a; d++) c = At(t, c);
		return Ut(t, c);
	}(n.programBytes);
	null !== y && g.setBrkBase(r, y), void 0 !== n.stdin && g.setStdinData(r, Us.encode(n.stdin));
	const w = {
		type: "centralized_init",
		pid: r,
		ppid: 0,
		programBytes: n.programBytes,
		memory: p,
		channelOffset: m,
		argv: n.argv,
		ptrWidth: s
	}, b = h.createWorker(w);
	i.set(r, b);
	const k = n.timeoutMs ?? 15e3, I = setTimeout(() => {
		if (!c) {
			c = !0;
			for (const e of i.values()) e.terminate().catch(() => {});
			i.clear(), f(/* @__PURE__ */ new Error(`${n.machine} ${n.programName} timed out after ${k}ms`));
		}
	}, k);
	b.on("error", (e) => {
		c || (c = !0, clearTimeout(I), f(e));
	}), b.on("message", (e) => {
		const t = e;
		"error" !== t.type || t.pid !== r || c || (c = !0, clearTimeout(I), f(new Error(t.message)));
	});
	try {
		const e = await u;
		return clearTimeout(I), Cs(n.machine, 0 === e ? "passed" : `failed ${e}`), {
			exitCode: e,
			stdout: o,
			stderr: a
		};
	} finally {
		clearTimeout(I);
		for (const e of i.values()) e.terminate().catch(() => {});
		i.clear(), e.detachMachine(n.machine);
	}
}
function Ls(e) {
	return new Promise((t) => setTimeout(t, e));
}
function Ns(e) {
	return e.map((e) => e.includes(" ") ? JSON.stringify(e) : e).join(" ");
}
async function $s(e, t) {
	Ts("udp", "running");
	const n = [
		"nc",
		"-n",
		"-c",
		"-u",
		"-l",
		"-p",
		String(24126),
		"-w",
		"3"
	], i = [
		"nc",
		"-n",
		"-u",
		"-c",
		"10.88.0.2",
		String(24126)
	];
	zs("runner", "system", `UDP alpha: ${Ns(n)}\nUDP beta: ${Ns(i)}`), zs("beta", "stdin", "hello from beta over udp\n");
	const s = Fs(e, t, {
		machine: "alpha",
		address: [
			10,
			88,
			0,
			2
		],
		programName: "nc udp listen",
		programBytes: t.nc,
		argv: n,
		stdin: ""
	});
	await Ls(100);
	const r = Fs(e, t, {
		machine: "beta",
		address: [
			10,
			88,
			0,
			3
		],
		programName: "nc udp send",
		programBytes: t.nc,
		argv: i,
		stdin: "hello from beta over udp\n"
	}), [o, a] = await Promise.all([s, r]), c = 0 === o.exitCode && 0 === a.exitCode && o.stdout.includes("hello from beta over udp");
	return Ts("udp", c ? "passed" : "failed"), Os("udp", "UDP datagram", c, c ? "alpha received beta's datagram through POSIX recv/read on a UDP socket." : `server=${o.exitCode}, client=${a.exitCode}`), c;
}
async function Ds(e, t) {
	Ts("tcp", "running");
	const n = [
		"nc",
		"-n",
		"-l",
		"-p",
		String(24125),
		"-w",
		"3"
	], i = [
		"nc",
		"-n",
		"-c",
		"10.88.0.2",
		String(24125)
	];
	zs("runner", "system", `TCP alpha: ${Ns(n)}\nTCP beta: ${Ns(i)}`), zs("beta", "stdin", "hello from beta over tcp\n");
	const s = Fs(e, t, {
		machine: "alpha",
		address: [
			10,
			88,
			0,
			2
		],
		programName: "nc tcp listen",
		programBytes: t.nc,
		argv: n,
		stdin: ""
	});
	await Ls(100);
	const r = Fs(e, t, {
		machine: "beta",
		address: [
			10,
			88,
			0,
			3
		],
		programName: "nc tcp send",
		programBytes: t.nc,
		argv: i,
		stdin: "hello from beta over tcp\n"
	}), [o, a] = await Promise.all([s, r]), c = 0 === o.exitCode && 0 === a.exitCode && o.stdout.includes("hello from beta over tcp");
	return Ts("tcp", c ? "passed" : "failed"), Os("tcp", "TCP stream", c, c ? "alpha accepted beta's TCP connection and received stream data." : `server=${o.exitCode}, client=${a.exitCode}`), c;
}
async function Ws(e, t) {
	Ts("curl", "running");
	const n = "hello from alpha via curl\n", i = [
		"HTTP/1.0 200 OK",
		"Content-Type: text/plain",
		`Content-Length: ${Us.encode(n).length}`,
		"Connection: close",
		"",
		n
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
	zs("runner", "system", `HTTP alpha: ${Ns(s)}\nHTTP gamma: ${Ns(r)}`), zs("runner", "system", `HTTP alpha stdin: generated ${Us.encode(i).length} byte response\n`), zs("alpha", "stdin", `${i.replaceAll("\r\n", "\n")}`);
	const o = Fs(e, t, {
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
		stdin: i,
		timeoutMs: 2e4
	});
	await Ls(100);
	const a = Fs(e, t, {
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
	}), [c, l] = await Promise.all([o, a]), h = 0 === c.exitCode && 0 === l.exitCode && l.stdout.includes(n);
	return Ts("curl", h ? "passed" : "failed"), Os("curl", "curl over TCP", h, h ? "gamma fetched alpha's HTTP response through curl over the virtual TCP backend." : `server=${c.exitCode}, curl=${l.exitCode}`), h;
}
async function Ks() {
	if (!Ms) {
		Ms = !0, Es({
			type: "status",
			status: "loading artifacts"
		});
		try {
			const e = await async function() {
				return Ss || (Ss = Promise.all([
					Rs("/kandelo/assets/kernel-YlfMgg_x.wasm"),
					Rs("/kandelo/assets/rootfs-DY5i7wN7.vfs"),
					Rs("/kandelo/assets/nc-BmT7hcgk.wasm"),
					Rs("/kandelo/assets/curl-Fl4R2zcb.wasm")
				]).then(([e, t, n, i]) => ({
					kernel: e,
					rootfs: new Uint8Array(t),
					nc: n,
					curl: i
				}))), Ss;
			}();
			Es({
				type: "status",
				status: "running"
			});
			const t = new mi();
			zs("runner", "system", "Virtual addresses: alpha=10.88.0.2 beta=10.88.0.3 gamma=10.88.0.4\n"), Es({
				type: "done",
				ok: [
					await $s(t, e),
					await Ds(t, e),
					await Ws(t, e)
				].every(Boolean)
			});
		} catch (e) {
			Es({
				type: "error",
				message: e instanceof Error ? e.message : String(e)
			});
		} finally {
			Ms = !1;
		}
	}
}
self.onmessage = (e) => {
	"run" === e.data.type && Ks();
}, Es({ type: "ready" });
export { o as t };
