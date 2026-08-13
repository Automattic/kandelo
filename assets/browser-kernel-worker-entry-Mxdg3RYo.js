var e = Object.create, t = Object.defineProperty, r = Object.getOwnPropertyDescriptor, i = Object.getOwnPropertyNames, n = Object.getPrototypeOf, s = Object.prototype.hasOwnProperty, o = (o, a, c) => (c = null != o ? e(n(o)) : {}, ((e, n, o, a) => {
	if (n && "object" == typeof n || "function" == typeof n) for (var c, l = i(n), h = 0, d = l.length; h < d; h++) c = l[h], s.call(e, c) || c === o || t(e, c, {
		get: ((e) => n[e]).bind(null, c),
		enumerable: !(a = r(n, c)) || a.enumerable
	});
	return e;
})(!a && o && o.__esModule ? c : t(c, "default", {
	value: o,
	enumerable: !0
}), o));
var a = class e {
	meta;
	data;
	cap;
	sab;
	constructor(e, t) {
		this.sab = e, this.cap = t, this.meta = new Int32Array(e, 0, 4), this.data = new Uint8Array(e, 16, t);
	}
	static create(t = 65536) {
		const r = new e(new SharedArrayBuffer(16 + t), t);
		return Atomics.store(r.meta, 0, 0), Atomics.store(r.meta, 1, 0), Atomics.store(r.meta, 2, 0), Atomics.store(r.meta, 3, 3), r;
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
		const t = Atomics.load(this.meta, 2), r = this.cap - t, i = Math.min(e.length, r);
		if (0 === i) return 0;
		let n = Atomics.load(this.meta, 1);
		for (let s = 0; s < i; s++) this.data[n] = e[s], n = (n + 1) % this.cap;
		return Atomics.store(this.meta, 1, n), Atomics.add(this.meta, 2, i), i;
	}
	read(e) {
		const t = Atomics.load(this.meta, 2), r = Math.min(e.length, t);
		if (0 === r) return 0;
		let i = Atomics.load(this.meta, 0);
		for (let n = 0; n < r; n++) e[n] = this.data[i], i = (i + 1) % this.cap;
		return Atomics.store(this.meta, 0, i), Atomics.sub(this.meta, 2, r), r;
	}
	closeRead() {
		Atomics.and(this.meta, 3, -2);
	}
	closeWrite() {
		Atomics.and(this.meta, 3, -3);
	}
}, c = class {
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
		for (const r of this.listeners) r(e.pid, "bind");
	}
	unbind(e) {
		if (this.bindings.has(e)) {
			this.bindings.delete(e);
			for (const t of this.listeners) t(e, "unbind");
		}
	}
	clear() {
		const e = [...this.bindings.keys()];
		this.bindings.clear();
		for (const t of e) for (const e of this.listeners) e(t, "unbind");
	}
	get(e) {
		return this.bindings.get(e);
	}
	rebindMemory(e) {
		const t = this.bindings.get(e);
		t && !t.hostBuffer && (t.view = null, t.imageData = null);
	}
	fbWrite(e, t, r) {
		const i = this.bindings.get(e);
		if (i?.hostBuffer) {
			const e = Math.min(t + r.length, i.hostBuffer.length);
			e > t && i.hostBuffer.set(r.subarray(0, e - t), t);
		}
		for (const n of this.writeListeners) n(e, t, r);
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
}, l = class {
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
		for (const r of this.listeners) r(e.pid, e.bo_id, "create");
	}
	destroy(e, t) {
		if (this.bos.delete(t)) for (const r of this.listeners) r(e, t, "destroy");
	}
	bind(e, t, r, i) {
		const n = this.bos.get(t);
		if (!n) return -1;
		n.pids.add(e), n.bindingsByPid.set(e, {
			addr: r,
			len: i
		});
		for (const s of this.listeners) s(e, t, "bind");
		return 0;
	}
	unbind(e, t) {
		const r = this.bos.get(t);
		if (!r) return;
		const i = r.bindingsByPid.get(e);
		i && this.flushMemoryToSab(r, e, i), r.bindingsByPid.delete(e);
		for (const n of this.listeners) n(e, t, "unbind");
	}
	releaseProcess(e) {
		for (const [t, r] of Array.from(this.bos)) {
			const i = r.bindingsByPid.get(e);
			if (i) {
				this.flushMemoryToSab(r, e, i), r.bindingsByPid.delete(e);
				for (const r of this.listeners) r(e, t, "unbind");
			}
			if (r.pids.delete(e) && 0 === r.pids.size) {
				this.bos.delete(t);
				for (const r of this.listeners) r(e, t, "destroy");
			}
		}
	}
	findBindingByAddr(e, t) {
		for (const r of this.bos.values()) {
			const i = r.bindingsByPid.get(e);
			if (i && i.addr === t) return r.bo_id;
		}
	}
	primeBindFromSab(e, t, r) {
		const i = this.bos.get(t);
		if (!i) return;
		const n = i.bindingsByPid.get(e);
		if (!n) return;
		for (const [c, l] of i.bindingsByPid) c !== e && this.flushMemoryToSab(i, c, l);
		const s = Math.min(n.len, i.size);
		if (n.addr + s > r.buffer.byteLength) return;
		const o = new Uint8Array(r.buffer, n.addr, s), a = new Uint8Array(i.sab, 0, s);
		o.set(a);
	}
	flushMemoryToSab(e, t, r) {
		const i = this.getProcessMemory;
		if (!i) return;
		const n = i(t);
		if (!n) return;
		const s = Math.min(r.len, e.size);
		if (r.addr + s > n.buffer.byteLength) return;
		const o = new Uint8Array(e.sab, 0, s), a = new Uint8Array(n.buffer, r.addr, s);
		o.set(a);
	}
	get(e, t) {
		const r = this.bos.get(t);
		if (r && r.pids.has(e)) return this.project(r, e);
	}
	listForPid(e) {
		const t = [];
		for (const r of this.bos.values()) r.pids.has(e) && t.push(this.project(r, e));
		return t;
	}
	pixelView(e) {
		const t = this.bos.get(e);
		if (t) return new Uint8Array(t.sab);
	}
	syncFromMemory(e) {
		const t = this.bos.get(e);
		if (t) for (const [r, i] of t.bindingsByPid) this.flushMemoryToSab(t, r, i);
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
}, h = class {
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
const d = 2929, f = 2960, u = 3042, p = 2884, m = 3089, g = 32823, y = 33984;
function w(e, t, r) {
	switch (t) {
		case d:
			e.depthTestEnabled = r;
			return;
		case f:
			e.stencilTestEnabled = r;
			return;
		case u:
			e.blendEnabled = r;
			return;
		case p:
			e.cullFaceEnabled = r;
			return;
		case g:
			e.polygonOffsetFillEnabled = r;
			return;
		case m:
			e.scissor.enabled = r;
			return;
	}
}
var b = class {
	bindings = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	pendingForwards = /* @__PURE__ */ new Map();
	pendingCanvases = /* @__PURE__ */ new Map();
	bind(e) {
		const t = this.pendingForwards.get(e.pid) ?? null;
		this.pendingForwards.delete(e.pid);
		const r = this.pendingCanvases.get(e.pid) ?? null;
		this.pendingCanvases.delete(e.pid), this.bindings.set(e.pid, {
			...e,
			cmdbufView: null,
			gl: null,
			canvas: r,
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
		const r = this.bindings.get(e);
		r ? r.canvas = t : this.pendingCanvases.set(e, t);
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
		const r = this.bindings.get(e);
		r ? r.forward = t : this.pendingForwards.set(e, t);
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
const S = 1024, _ = 1025, k = 1026, v = 1027, A = 1028, I = 1029, P = 1030, E = 1280, C = 1281, x = 1282, z = 1283, M = 1284, T = 1536, L = 1537, B = 1538, R = 1792, U = 1793, F = 1794, H = 1795, $ = 1796, W = 1797, D = 1798;
function O(e, t, r) {
	return e.cmdbufView && e.gl ? N(e.cmdbufView, t, r, (t, r) => {
		try {
			return function(e, t, r, i, n) {
				switch (n) {
					case 1:
						e.clear(r.getUint32(i, !0));
						return;
					case 2:
						t.shadow.clearColor = [
							r.getFloat32(i, !0),
							r.getFloat32(i + 4, !0),
							r.getFloat32(i + 8, !0),
							r.getFloat32(i + 12, !0)
						], e.clearColor(...t.shadow.clearColor);
						return;
					case 3:
						t.shadow.viewport = [
							r.getInt32(i, !0),
							r.getInt32(i + 4, !0),
							r.getInt32(i + 8, !0),
							r.getInt32(i + 12, !0)
						], e.viewport(...t.shadow.viewport);
						return;
					case 4: {
						const n = r.getInt32(i, !0), s = r.getInt32(i + 4, !0), o = r.getInt32(i + 8, !0), a = r.getInt32(i + 12, !0);
						e.scissor(n, s, o, a), t.shadow.scissor.rect = [
							n,
							s,
							o,
							a
						];
						return;
					}
					case 5: {
						const n = r.getUint32(i, !0);
						e.enable(n), w(t.shadow, n, !0);
						return;
					}
					case 6: {
						const n = r.getUint32(i, !0);
						e.disable(n), w(t.shadow, n, !1);
						return;
					}
					case 7: {
						const n = r.getUint32(i, !0), s = r.getUint32(i + 4, !0);
						e.blendFunc(n, s), t.shadow.blendFunc = {
							srcRGB: n,
							dstRGB: s,
							srcA: n,
							dstA: s
						};
						return;
					}
					case 8:
						t.shadow.depthFunc = r.getUint32(i, !0), e.depthFunc(t.shadow.depthFunc);
						return;
					case 9:
						t.shadow.cullFace = r.getUint32(i, !0), e.cullFace(t.shadow.cullFace);
						return;
					case 10:
						t.shadow.frontFace = r.getUint32(i, !0), e.frontFace(t.shadow.frontFace);
						return;
					case 11:
						e.lineWidth(r.getFloat32(i, !0));
						return;
					case 12: {
						const n = r.getUint32(i, !0), s = r.getInt32(i + 4, !0);
						e.pixelStorei(n, s), 3317 === n ? t.shadow.unpackAlignment = s : 3333 === n && (t.shadow.packAlignment = s);
						return;
					}
					case 256: {
						const n = r.getUint32(i, !0);
						for (let s = 0; s < n; s++) {
							const n = r.getUint32(i + 4 + 4 * s, !0), o = e.createBuffer();
							o && t.buffers.set(n, o);
						}
						return;
					}
					case 257: {
						const n = r.getUint32(i, !0);
						for (let s = 0; s < n; s++) {
							const n = r.getUint32(i + 4 + 4 * s, !0), o = t.buffers.get(n);
							o && e.deleteBuffer(o), t.buffers.delete(n);
						}
						return;
					}
					case 258:
						e.bindBuffer(r.getUint32(i, !0), t.buffers.get(r.getUint32(i + 4, !0)) ?? null);
						return;
					case 259: {
						const t = r.getUint32(i, !0), n = r.getUint32(i + 4, !0), s = r.getUint32(i + 8 + n, !0);
						if (0 === n) e.bufferData(t, 0, s);
						else {
							const o = new Uint8Array(r.buffer, r.byteOffset + i + 8, n);
							e.bufferData(t, o, s);
						}
						return;
					}
					case 260: {
						const t = r.getUint32(i, !0), n = r.getInt32(i + 4, !0), s = r.getUint32(i + 8, !0), o = new Uint8Array(r.buffer, r.byteOffset + i + 12, s);
						e.bufferSubData(t, n, o);
						return;
					}
					case 512: {
						const n = r.getUint32(i, !0);
						for (let s = 0; s < n; s++) {
							const n = r.getUint32(i + 4 + 4 * s, !0), o = e.createTexture();
							o && t.textures.set(n, o);
						}
						return;
					}
					case 513: {
						const n = r.getUint32(i, !0);
						for (let s = 0; s < n; s++) {
							const n = r.getUint32(i + 4 + 4 * s, !0), o = t.textures.get(n);
							o && e.deleteTexture(o), t.textures.delete(n);
						}
						return;
					}
					case 514: {
						const n = t.textures.get(r.getUint32(i + 4, !0)) ?? null;
						e.bindTexture(r.getUint32(i, !0), n);
						const s = t.shadow.activeTexture;
						s >= 0 && s < t.shadow.textureUnits.length && (t.shadow.textureUnits[s] = n);
						return;
					}
					case 515: {
						const t = r.getUint32(i, !0), n = r.getInt32(i + 4, !0), s = r.getInt32(i + 8, !0), o = r.getInt32(i + 12, !0), a = r.getInt32(i + 16, !0), c = r.getInt32(i + 20, !0), l = r.getUint32(i + 24, !0), h = r.getUint32(i + 28, !0), d = r.getUint32(i + 32, !0), f = 0 === d ? null : new Uint8Array(r.buffer, r.byteOffset + i + 36, d);
						e.texImage2D(t, n, s, o, a, c, l, h, f);
						return;
					}
					case 516: {
						const t = r.getUint32(i, !0), n = r.getInt32(i + 4, !0), s = r.getInt32(i + 8, !0), o = r.getInt32(i + 12, !0), a = r.getInt32(i + 16, !0), c = r.getInt32(i + 20, !0), l = r.getUint32(i + 24, !0), h = r.getUint32(i + 28, !0), d = r.getUint32(i + 32, !0), f = new Uint8Array(r.buffer, r.byteOffset + i + 36, d);
						e.texSubImage2D(t, n, s, o, a, c, l, h, f);
						return;
					}
					case 517:
						e.texParameteri(r.getUint32(i, !0), r.getUint32(i + 4, !0), r.getInt32(i + 8, !0));
						return;
					case 518: {
						const n = r.getUint32(i, !0);
						e.activeTexture(n), t.shadow.activeTexture = n - y;
						return;
					}
					case 519:
						e.generateMipmap(r.getUint32(i, !0));
						return;
					case 768: {
						const n = r.getUint32(i, !0), s = r.getUint32(i + 4, !0), o = e.createShader(n);
						o && t.shaders.set(s, o);
						return;
					}
					case 769: {
						const n = r.getUint32(i, !0), s = r.getUint32(i + 4, !0), o = new Uint8Array(s);
						o.set(new Uint8Array(r.buffer, r.byteOffset + i + 8, s));
						const a = new TextDecoder().decode(o), c = t.shaders.get(n);
						c && e.shaderSource(c, a);
						return;
					}
					case 770: {
						const n = t.shaders.get(r.getUint32(i, !0));
						n && e.compileShader(n);
						return;
					}
					case 771: {
						const n = r.getUint32(i, !0), s = t.shaders.get(n);
						s && e.deleteShader(s), t.shaders.delete(n);
						return;
					}
					case 772: {
						const n = r.getUint32(i, !0), s = e.createProgram();
						s && t.programs.set(n, s);
						return;
					}
					case 773: {
						const n = t.programs.get(r.getUint32(i, !0)), s = t.shaders.get(r.getUint32(i + 4, !0));
						n && s && e.attachShader(n, s);
						return;
					}
					case 774: {
						const n = t.programs.get(r.getUint32(i, !0));
						n && e.linkProgram(n);
						return;
					}
					case 775: {
						const n = t.programs.get(r.getUint32(i, !0)) ?? null;
						e.useProgram(n), t.currentProgram = n, t.shadow.currentProgram = n;
						return;
					}
					case 776: {
						const n = t.programs.get(r.getUint32(i, !0)), s = r.getUint32(i + 4, !0), o = r.getUint32(i + 8, !0), a = new Uint8Array(o);
						a.set(new Uint8Array(r.buffer, r.byteOffset + i + 12, o));
						const c = new TextDecoder().decode(a);
						n && e.bindAttribLocation(n, s, c);
						return;
					}
					case 777: {
						const n = r.getUint32(i, !0), s = t.programs.get(n);
						s && e.deleteProgram(s), t.programs.delete(n);
						return;
					}
					case S: {
						const n = t.uniformLocations.get(r.getInt32(i, !0)) ?? null;
						e.uniform1i(n, r.getInt32(i + 4, !0));
						return;
					}
					case _: {
						const n = t.uniformLocations.get(r.getInt32(i, !0)) ?? null;
						e.uniform1f(n, r.getFloat32(i + 4, !0));
						return;
					}
					case k: {
						const n = t.uniformLocations.get(r.getInt32(i, !0)) ?? null;
						e.uniform2f(n, r.getFloat32(i + 4, !0), r.getFloat32(i + 8, !0));
						return;
					}
					case v: {
						const n = t.uniformLocations.get(r.getInt32(i, !0)) ?? null;
						e.uniform3f(n, r.getFloat32(i + 4, !0), r.getFloat32(i + 8, !0), r.getFloat32(i + 12, !0));
						return;
					}
					case A: {
						const n = t.uniformLocations.get(r.getInt32(i, !0)) ?? null;
						e.uniform4f(n, r.getFloat32(i + 4, !0), r.getFloat32(i + 8, !0), r.getFloat32(i + 12, !0), r.getFloat32(i + 16, !0));
						return;
					}
					case I: {
						const n = t.uniformLocations.get(r.getInt32(i, !0)) ?? null, s = r.getUint32(i + 4, !0), o = 0 !== r.getUint32(i + 8, !0), a = new Float32Array(r.buffer, r.byteOffset + i + 12, 16 * s);
						e.uniformMatrix4fv(n, o, a);
						return;
					}
					case P: {
						const n = t.uniformLocations.get(r.getInt32(i, !0)) ?? null, s = r.getUint32(i + 4, !0), o = new Float32Array(r.buffer, r.byteOffset + i + 8, 4 * s);
						e.uniform4fv(n, o);
						return;
					}
					case E:
						e.enableVertexAttribArray(r.getUint32(i, !0));
						return;
					case C:
						e.disableVertexAttribArray(r.getUint32(i, !0));
						return;
					case x: {
						const t = r.getUint32(i, !0), n = r.getInt32(i + 4, !0), s = r.getUint32(i + 8, !0), o = 0 !== r.getUint32(i + 12, !0), a = r.getInt32(i + 16, !0), c = r.getInt32(i + 20, !0);
						e.vertexAttribPointer(t, n, s, o, a, c);
						return;
					}
					case z:
						e.drawArrays(r.getUint32(i, !0), r.getInt32(i + 4, !0), r.getInt32(i + 8, !0));
						return;
					case M:
						e.drawElements(r.getUint32(i, !0), r.getInt32(i + 4, !0), r.getUint32(i + 8, !0), r.getUint32(i + 12, !0));
						return;
					case T: {
						const n = r.getUint32(i, !0);
						for (let s = 0; s < n; s++) {
							const n = r.getUint32(i + 4 + 4 * s, !0), o = e.createVertexArray();
							o && t.vaos.set(n, o);
						}
						return;
					}
					case L: {
						const n = r.getUint32(i, !0);
						for (let s = 0; s < n; s++) {
							const n = r.getUint32(i + 4 + 4 * s, !0), o = t.vaos.get(n);
							o && e.deleteVertexArray(o), t.vaos.delete(n);
						}
						return;
					}
					case B: {
						const n = t.vaos.get(r.getUint32(i, !0)) ?? null;
						e.bindVertexArray(n), t.shadow.vao = n;
						return;
					}
					case R: {
						const n = r.getUint32(i, !0);
						for (let s = 0; s < n; s++) {
							const n = r.getUint32(i + 4 + 4 * s, !0), o = e.createFramebuffer();
							o && t.fbos.set(n, o);
						}
						return;
					}
					case U: {
						const n = r.getUint32(i, !0), s = t.fbos.get(r.getUint32(i + 4, !0)) ?? null;
						e.bindFramebuffer(n, s), 36008 !== n && (t.shadow.fbo = s);
						return;
					}
					case F: {
						const n = r.getUint32(i, !0), s = r.getUint32(i + 4, !0), o = r.getUint32(i + 8, !0), a = t.textures.get(r.getUint32(i + 12, !0)) ?? null, c = r.getInt32(i + 16, !0);
						e.framebufferTexture2D(n, s, o, a, c);
						return;
					}
					case H: {
						const n = r.getUint32(i, !0);
						for (let s = 0; s < n; s++) {
							const n = r.getUint32(i + 4 + 4 * s, !0), o = e.createRenderbuffer();
							o && t.rbos.set(n, o);
						}
						return;
					}
					case $:
						e.bindRenderbuffer(r.getUint32(i, !0), t.rbos.get(r.getUint32(i + 4, !0)) ?? null);
						return;
					case W:
						e.renderbufferStorage(r.getUint32(i, !0), r.getUint32(i + 4, !0), r.getInt32(i + 8, !0), r.getInt32(i + 12, !0));
						return;
					case D: {
						const n = r.getUint32(i, !0), s = r.getUint32(i + 4, !0), o = r.getUint32(i + 8, !0), a = t.rbos.get(r.getUint32(i + 12, !0)) ?? null;
						e.framebufferRenderbuffer(n, s, o, a);
						return;
					}
					default: throw new Error(`gl bridge: unknown op 0x${n.toString(16).padStart(4, "0")} at offset ${i - 4}`);
				}
			}(e.gl, e, t, 0, r), 0;
		} catch {
			return -5;
		}
	}) : 0;
}
function N(e, t, r, i) {
	if (!function(e, t, r) {
		return Number.isSafeInteger(e) && Number.isSafeInteger(t) && e >= 0 && t >= 0 && e <= r && t <= r - e;
	}(t, r, e.byteLength)) return -22;
	const n = new DataView(e.buffer, e.byteOffset + t, r);
	let s = 0;
	for (; s < r;) {
		if (r - s < 4) return -22;
		const e = n.getUint16(s, !0), t = n.getUint16(s + 2, !0), o = s + 4, a = o + t;
		if (a > r) return -22;
		const c = new DataView(n.buffer, n.byteOffset + o, t);
		if (!G(e, c)) return -22;
		const l = i(c, e);
		if (0 !== l) return l;
		s = a;
	}
	return 0;
}
function K(e, t) {
	return e.byteLength === t;
}
function V(e, t, r) {
	if (e.byteLength < r + 4) return !1;
	const i = e.getUint32(r, !0);
	return e.byteLength === t + i;
}
function q(e, t, r, i) {
	if (e.byteLength < r + 4 || e.byteOffset % 4 != 0) return !1;
	const n = e.getUint32(r, !0);
	return e.byteLength === t + n * i * 4;
}
function G(e, t) {
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
		case E:
		case C:
		case B: return K(t, 4);
		case 7:
		case 12:
		case 258:
		case 514:
		case 768:
		case 773:
		case S:
		case _:
		case U:
		case $: return K(t, 8);
		case 517:
		case k:
		case z: return K(t, 12);
		case 2:
		case 3:
		case 4:
		case v:
		case M:
		case W:
		case D: return K(t, 16);
		case A:
		case F: return K(t, 20);
		case x: return K(t, 24);
		case 256:
		case 257:
		case 512:
		case 513:
		case T:
		case L:
		case R:
		case H: return function(e) {
			if (e.byteLength < 4) return !1;
			const t = e.getUint32(0, !0);
			return e.byteLength === 4 + 4 * t;
		}(t);
		case 259: return V(t, 12, 4);
		case 260: return V(t, 12, 8);
		case 515:
		case 516: return V(t, 36, 32);
		case 769: return V(t, 8, 4);
		case 776: return V(t, 12, 8);
		case I: return q(t, 12, 4, 16);
		case P: return q(t, 8, 4, 4);
		default: return !1;
	}
}
var j = class {
	isCompositor;
	compositor = [];
	clients = [];
	byKey = /* @__PURE__ */ new Map();
	constructor(e = (e) => 2 === e) {
		this.isCompositor = e;
	}
	enqueue(e, t) {
		const r = `${e.pid}:${e.contextId ?? "_"}`;
		let i = this.byKey.get(r);
		i || (i = {
			key: r,
			binding: e,
			frames: []
		}, this.byKey.set(r, i), (this.isCompositor(e.pid) ? this.compositor : this.clients).push(i)), i.frames.push(t);
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
		const t = this.isCompositor(e.binding.pid) ? this.compositor : this.clients, r = t.indexOf(e);
		r >= 0 && t.splice(r, 1);
	}
	removePid(e) {
		for (const [t, r] of Array.from(this.byKey)) {
			if (r.binding.pid !== e) continue;
			r.frames.length = 0, this.byKey.delete(t);
			const i = this.compositor.indexOf(r);
			i >= 0 && this.compositor.splice(i, 1);
			const n = this.clients.indexOf(r);
			n >= 0 && this.clients.splice(n, 1);
		}
	}
	isEmpty() {
		return 0 === this.byKey.size;
	}
}, X = class {
	gl;
	current = null;
	constructor(e) {
		this.gl = e;
	}
	switchTo(e) {
		if (this.current === e) return;
		const t = e.shadow, r = this.gl;
		r.bindVertexArray(t.vao), r.bindFramebuffer(36160, t.fbo), r.viewport(...t.viewport), t.scissor.enabled ? r.enable(m) : r.disable(m), r.scissor(...t.scissor.rect), r.clearColor(...t.clearColor), t.depthTestEnabled ? r.enable(d) : r.disable(d), r.depthFunc(t.depthFunc), t.stencilTestEnabled ? r.enable(f) : r.disable(f), t.blendEnabled ? r.enable(u) : r.disable(u), r.blendFuncSeparate(t.blendFunc.srcRGB, t.blendFunc.dstRGB, t.blendFunc.srcA, t.blendFunc.dstA), t.cullFaceEnabled ? r.enable(p) : r.disable(p), r.cullFace(t.cullFace), r.frontFace(t.frontFace), t.polygonOffsetFillEnabled ? r.enable(g) : r.disable(g), r.useProgram(t.currentProgram);
		for (let i = 0; i < t.textureUnits.length; i++) {
			const e = t.textureUnits[i];
			e && (r.activeTexture(y + i), r.bindTexture(3553, e));
		}
		r.activeTexture(y + t.activeTexture), r.pixelStorei(3317, t.unpackAlignment), r.pixelStorei(3333, t.packAlignment), this.current = e;
	}
	invalidateCurrent() {
		this.current = null;
	}
};
const Y = "__abi_version", Z = [{
	bytes: 4,
	chunkHeaderSize: 32,
	nodeHeaderSize: 24
}, {
	bytes: 8,
	chunkHeaderSize: 56,
	nodeHeaderSize: 32
}], J = [
	{
		name: "wpk_fork_abort_begin",
		params: ["ptr"],
		results: []
	},
	{
		name: "wpk_fork_abort_end",
		params: [],
		results: []
	},
	{
		name: "wpk_fork_rewind_begin",
		params: ["ptr"],
		results: []
	},
	{
		name: "wpk_fork_rewind_end",
		params: [],
		results: []
	},
	{
		name: "wpk_fork_state",
		params: [],
		results: ["i32"]
	},
	{
		name: "wpk_fork_unwind_begin",
		params: ["ptr"],
		results: []
	},
	{
		name: "wpk_fork_unwind_end",
		params: [],
		results: []
	}
], Q = {
	atomics_wait: 2,
	atomics_wait_async: 4,
	shared_array_buffer: 1
}, ee = [
	"__abi_version",
	"kernel_alloc_scratch",
	"kernel_create_process",
	"kernel_create_process_with_stdio",
	"kernel_dequeue_signal",
	"kernel_exec_prepare",
	"kernel_exec_setup_for_thread",
	"kernel_fork_process",
	"kernel_get_parent_pid",
	"kernel_get_process_exit_signal",
	"kernel_get_process_state",
	"kernel_handle_channel",
	"kernel_has_sa_nocldstop",
	"kernel_host_adapter_manifest_len",
	"kernel_host_adapter_manifest_ptr",
	"kernel_ipc_shmat_for_process",
	"kernel_ipc_shmat_for_task",
	"kernel_ipc_shmdt_for_process",
	"kernel_ipc_shmdt_for_task",
	"kernel_mark_process_signaled",
	"kernel_pipe_has_readers",
	"kernel_posix_timer_fire",
	"kernel_prepare_write_operation",
	"kernel_reap_exited_child",
	"kernel_remove_process",
	"kernel_set_current_tid",
	"kernel_spawn_process",
	"kernel_thread_exit",
	"kernel_validate_task",
	"kernel_wait_child_poll"
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
}, re = 65536, ie = 65608, ne = 65560, se = 65560, oe = 16777216, ae = 211, ce = 212, le = 213, he = 500, de = 386, fe = 1, ue = 2, pe = 3, me = 4, ge = 6, ye = 7, we = 8, be = 10, Se = 11, _e = 12, ke = 19, ve = 22, Ae = 24, Ie = 25, Pe = 34, Ee = 35, Ce = 41, xe = 46, ze = 47, Me = 48, Te = 49, Le = 53, Be = 54, Re = 55, Ue = 56, Fe = 60, He = 62, $e = 63, We = 64, De = 65, Oe = 68, Ne = 69, Ke = 72, Ve = 77, qe = 79, Ge = 80, je = 81, Xe = 82, Ye = 85, Ze = 86, Je = 90, Qe = 92, et = 93, tt = 97, rt = 102, it = 103, nt = 109, st = 121, ot = 124, at = 126, ct = 137, lt = 138, ht = 139, dt = 200, ft = 201, ut = 205, pt = 207, mt = 238, gt = 239, yt = 240, wt = 241, bt = 251, St = 252, _t = 278, kt = 288, vt = 294, At = 295, It = 296, Pt = 308, Et = 333, Ct = 334, xt = 343, zt = 345, Mt = 346, Tt = 378, Lt = 379, Bt = 384, Rt = 387, Ut = 415, Ft = 0, Ht = 1, $t = 2, Wt = 3, Dt = 4, Ot = 5, Nt = 6, Kt = 7, Vt = 8, qt = 9, Gt = 10, jt = 11, Xt = 12, Yt = 13, Zt = 14, Jt = 15, Qt = 16, er = 17, tr = 18, rr = 19, ir = 20, nr = 21, sr = 22, or = 23, ar = {
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
		},
		required: !0
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
	112: [{
		argIndex: 0,
		direction: "in",
		size: { type: "cstring" }
	}, {
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 8
		},
		required: !0
	}],
	113: [{
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 8
		},
		required: !0
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
		size: { type: "cstring" },
		nullable: !0
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
			size: 144
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
	238: [{
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 4
		},
		required: !0
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
	288: [{
		argIndex: 2,
		direction: "out",
		size: {
			type: "fixed",
			size: 128
		},
		required: !0
	}, {
		argIndex: 4,
		direction: "out",
		size: {
			type: "fixed",
			size: 144
		},
		nullable: !0
	}],
	299: [{
		argIndex: 0,
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
}, cr = 65536;
function lr(e) {
	const t = new Uint8Array(e);
	return t.length >= 8 && 0 === t[0] && 97 === t[1] && 115 === t[2] && 109 === t[3] && 1 === t[4] && 0 === t[5] && 0 === t[6] && 0 === t[7];
}
function hr(e, t) {
	let r = 0, i = 0, n = t;
	for (;;) {
		const t = e[n++];
		if (r |= (127 & t) << i, !(128 & t)) break;
		i += 7;
	}
	return [r, n - t];
}
function dr(e, t) {
	let r = 0, i = 0, n = t, s = 0;
	for (; s = e[n++], r |= (127 & s) << i, i += 7, 128 & s;);
	return i < 32 && 64 & s && (r |= -1 << i), [r, n - t];
}
function fr(e, t) {
	let r = 0n, i = 0n, n = t, s = 0;
	for (; s = e[n++], r |= BigInt(127 & s) << i, i += 7n, 128 & s;);
	return i < 64n && 64 & s && (r |= -1n << i), [r, n - t];
}
function ur(e, t) {
	const r = e[t];
	if (64 === r || 127 === r || 126 === r || 125 === r || 124 === r || 123 === r || 112 === r || 111 === r) return t + 1;
	const [, i] = dr(e, t);
	return t + i;
}
function pr(e, t) {
	const [, r] = hr(e, t);
	t += r;
	const [, i] = hr(e, t);
	return t + i;
}
function mr(e, t, r) {
	const [i, n] = hr(t, r);
	if (r += n, 252 === e) switch (i) {
		case 0:
		case 1:
		case 2:
		case 3:
		case 4:
		case 5:
		case 6:
		case 7: return r;
		case 8: {
			const [, e] = hr(t, r);
			r += e;
			const [, i] = hr(t, r);
			return r + i;
		}
		case 9: {
			const [, e] = hr(t, r);
			return r + e;
		}
		case 10: {
			const [, e] = hr(t, r);
			r += e;
			const [, i] = hr(t, r);
			return r + i;
		}
		case 11: {
			const [, e] = hr(t, r);
			return r + e;
		}
		case 12: {
			const [, e] = hr(t, r);
			r += e;
			const [, i] = hr(t, r);
			return r + i;
		}
		case 13: {
			const [, e] = hr(t, r);
			return r + e;
		}
		case 14: {
			const [, e] = hr(t, r);
			r += e;
			const [, i] = hr(t, r);
			return r + i;
		}
		case 15:
		case 16:
		case 17: {
			const [, e] = hr(t, r);
			return r + e;
		}
		default: return null;
	}
	return 253 === e ? 12 === i || 13 === i ? r + 16 : i >= 21 && i <= 34 ? pr(t, r) : 84 === i || i >= 92 && i <= 99 || i >= 112 && i <= 123 || i >= 124 && i <= 131 || i >= 156 && i <= 159 ? r + 1 : r : 254 === e ? 0 === i || 1 === i || 2 === i ? pr(t, r) : 3 === i ? r : i >= 16 && i <= 79 ? pr(t, r) : null : null;
}
function gr(e, t, r) {
	const [i, n] = hr(e, t);
	t += n + i;
	const [s, o] = hr(e, t);
	t += o + s;
	const a = e[t++];
	if (0 === a) {
		r.funcImports++;
		const [, i] = hr(e, t);
		t += i;
	} else if (1 === a) {
		t++;
		const r = e[t++], [, i] = hr(e, t);
		if (t += i, 1 & r) {
			const [, r] = hr(e, t);
			t += r;
		}
	} else if (2 === a) {
		const r = e[t++], [, i] = hr(e, t);
		if (t += i, 1 & r) {
			const [, r] = hr(e, t);
			t += r;
		}
	} else 3 === a && (r.globalImports++, t += 2);
	return t;
}
J.map(({ name: e }) => e);
function yr(e, t) {
	for (t += 2; 11 !== e[t];) t++;
	return t + 1;
}
function wr(e) {
	const t = new Uint8Array(e);
	if (t.length < 8) return null;
	let r = 0, i = 0, n = null, s = null, o = 8;
	for (; o < t.length;) {
		const e = t[o], [a, c] = hr(t, o + 1), l = o + 1 + c;
		if (2 === e) {
			const e = {
				funcImports: i,
				globalImports: r
			};
			let n = l;
			const [s, o] = hr(t, n);
			n += o;
			for (let r = 0; r < s; r++) n = gr(t, n, e);
			i = e.funcImports, r = e.globalImports;
		} else if (6 === e) s = {
			offset: l,
			size: a
		};
		else if (7 === e) {
			let e = l;
			const [r, i] = hr(t, e);
			e += i;
			for (let s = 0; s < r; s++) {
				const [r, i] = hr(t, e);
				e += i;
				const s = new TextDecoder().decode(t.subarray(e, e + r));
				e += r;
				const o = t[e++], [a, c] = hr(t, e);
				if (e += c, 3 === o && "__heap_base" === s) {
					n = a;
					break;
				}
			}
			if (null === n) return null;
			if (null === s) return null;
			break;
		}
		o = l + a;
	}
	if (null === n || null === s) return null;
	const a = n - r;
	if (a < 0) return null;
	let c = s.offset;
	const [l, h] = hr(t, c);
	if (c += h, a >= l) return null;
	for (let d = 0; d < a; d++) c = yr(t, c);
	return function(e, t) {
		t++, t++;
		const r = e[t++];
		if (65 === r) {
			const [r] = dr(e, t);
			return BigInt.asUintN(32, BigInt(r));
		}
		if (66 === r) {
			const [r] = fr(e, t);
			return BigInt.asUintN(64, r);
		}
		return null;
	}(t, c);
}
function br(e, t) {
	const r = new Uint8Array(e);
	if (r.length < 8) return null;
	let i = 0, n = null, s = null, o = 8;
	for (; o < r.length;) {
		const e = r[o], [a, c] = hr(r, o + 1), l = o + 1 + c;
		if (2 === e) {
			const e = {
				funcImports: i,
				globalImports: 0
			};
			let t = l;
			const [n, s] = hr(r, t);
			t += s;
			for (let i = 0; i < n; i++) t = gr(r, t, e);
			i = e.funcImports;
		} else if (7 === e) {
			let e = l;
			const [i, s] = hr(r, e);
			e += s;
			for (let o = 0; o < i; o++) {
				const [i, s] = hr(r, e);
				e += s;
				const o = new TextDecoder().decode(r.subarray(e, e + i));
				e += i;
				const a = r[e++], [c, l] = hr(r, e);
				if (e += l, 0 === a && o === t) {
					n = c;
					break;
				}
			}
		} else 10 === e && (s = {
			offset: l,
			size: a
		});
		o = l + a;
	}
	if (null === n || null === s) return null;
	let a = s.offset;
	const [c, l] = hr(r, a);
	return a += l, function e(t, n = 0) {
		if (n > 4) return null;
		const s = function(e) {
			const t = e - i;
			if (t < 0 || t >= c) return null;
			let n = a;
			for (let i = 0; i < t; i++) {
				const [e, t] = hr(r, n);
				n += t + e;
			}
			const [s, o] = hr(r, n);
			return n += o, {
				start: n,
				end: n + s
			};
		}(t);
		if (!s) return null;
		const o = function(e, t) {
			if (e >= t) return null;
			const [i, n] = hr(r, e);
			e += n;
			for (let s = 0; s < i; s++) {
				const [, i] = hr(r, e);
				if (e += i, ++e > t) return null;
			}
			return e;
		}(s.start, s.end);
		if (null === o) return null;
		let l = o;
		const h = s.end;
		for (; l < h;) {
			const t = r[l++];
			if (11 !== t) {
				if (65 === t) {
					const [e] = dr(r, l), [, t] = dr(r, l), i = l + t;
					if (15 === r[i] || 11 === r[i] && i + 1 === h) return e;
					l = i;
				} else if (16 === t) {
					const [t, i] = hr(r, l), s = l + i;
					if (15 === r[s] || 11 === r[s] && s + 1 === h) {
						const r = e(t, n + 1);
						if (null !== r) return r;
					}
					l = s;
				} else if (12 === t || 13 === t || 18 === t || 210 === t) {
					const [, e] = hr(r, l);
					l += e;
				} else if (2 === t || 3 === t || 4 === t) l = ur(r, l);
				else if (14 === t) {
					const [e, t] = hr(r, l);
					l += t;
					for (let i = 0; i <= e; i++) {
						const [, e] = hr(r, l);
						l += e;
					}
				} else if (17 === t) {
					const [, e] = hr(r, l);
					l += e;
					const [, t] = hr(r, l);
					l += t;
				} else if (28 === t) {
					const [e, t] = hr(r, l);
					l += t;
					for (let i = 0; i < e; i++) {
						const [, e] = hr(r, l);
						l += e;
					}
				} else if (t >= 32 && t <= 38 || 208 === t) {
					const [, e] = hr(r, l);
					l += e;
				} else if (t >= 40 && t <= 62) l = pr(r, l);
				else if (63 === t || 64 === t) l++;
				else if (66 === t) {
					const [, e] = fr(r, l);
					l += e;
				} else if (67 === t) l += 4;
				else if (68 === t) l += 8;
				else if (252 === t || 253 === t || 254 === t) {
					const e = mr(t, r, l);
					if (null === e) return null;
					l = e;
				}
			} else if (l === h) return null;
		}
		return null;
	}(n);
}
function Sr(e) {
	const t = new Uint8Array(e);
	if (t.length < 8) return 4;
	function r(e, t) {
		let r = 0, i = 0, n = t;
		for (;;) {
			const t = e[n++];
			if (r |= (127 & t) << i, !(128 & t)) break;
			i += 7;
		}
		return [r, n - t];
	}
	let i = 8;
	for (; i < t.length;) {
		const e = t[i], [n, s] = r(t, i + 1), o = i + 1 + s;
		if (2 === e) {
			let e = o;
			const [i, n] = r(t, e);
			e += n;
			for (let s = 0; s < i; s++) {
				const [i, n] = r(t, e);
				e += n + i;
				const [s, o] = r(t, e);
				e += o + s;
				const a = t[e++];
				if (2 === a) return 4 & t[e] ? 8 : 4;
				if (0 === a) {
					const [, i] = r(t, e);
					e += i;
				} else if (1 === a) {
					e++;
					const i = t[e++], [, n] = r(t, e);
					if (e += n, 1 & i) {
						const [, i] = r(t, e);
						e += i;
					}
				} else 3 === a && (e += 2);
			}
			break;
		}
		i = o + n;
	}
	return 4;
}
const _r = (1n << 64n) - 1n;
function kr(e, t) {
	if ("bigint" == typeof e) {
		if (e >= 0n && e <= _r) return e;
	} else if (Number.isSafeInteger(e) && e >= 0) return BigInt(e);
	const r = /* @__PURE__ */ new Error(`EOVERFLOW: ${t} is not exactly representable as an unsigned 64-bit value`);
	throw r.code = "EOVERFLOW", r;
}
function vr(e) {
	const t = e instanceof ArrayBuffer ? new Uint8Array(e) : new Uint8Array(e.buffer, e.byteOffset, e.byteLength), r = new Uint8Array(t.byteLength);
	return r.set(t), r.buffer;
}
function Ar(e, t) {
	return void 0 === e || !Number.isFinite(e) || e < 1 ? t : Ir(Math.trunc(e));
}
function Ir(e) {
	return Math.max(1, Math.min(65535, Math.trunc(e)));
}
const Pr = {
	EPERM: -1,
	ENOENT: -2,
	ESRCH: -3,
	EINTR: -4,
	EIO: -5,
	ENXIO: -6,
	E2BIG: -7,
	ENOEXEC: -8,
	EBADF: -9,
	ECHILD: -10,
	EAGAIN: -11,
	EWOULDBLOCK: -11,
	ENOMEM: -12,
	EACCES: -13,
	EFAULT: -14,
	EBUSY: -16,
	EEXIST: -17,
	EXDEV: -18,
	ENODEV: -19,
	ENOTDIR: -20,
	EISDIR: -21,
	EINVAL: -22,
	ENFILE: -23,
	EMFILE: -24,
	ENOTTY: -25,
	ETXTBSY: -26,
	EFBIG: -27,
	ENOSPC: -28,
	ESPIPE: -29,
	EROFS: -30,
	EMLINK: -31,
	EPIPE: -32,
	ERANGE: -34,
	EDEADLK: -35,
	ENAMETOOLONG: -36,
	ENOSYS: -38,
	ENOTEMPTY: -39,
	ELOOP: -40,
	ENOMSG: -42,
	EIDRM: -43,
	ENODATA: -61,
	EOVERFLOW: -75,
	ENOTSOCK: -88,
	EDESTADDRREQ: -89,
	EMSGSIZE: -90,
	EPROTOTYPE: -91,
	ENOPROTOOPT: -92,
	EPROTONOSUPPORT: -93,
	EOPNOTSUPP: -95,
	ENOTSUP: -95,
	EAFNOSUPPORT: -97,
	EADDRINUSE: -98,
	EADDRNOTAVAIL: -99,
	ENETUNREACH: -101,
	ECONNABORTED: -103,
	ECONNRESET: -104,
	EISCONN: -106,
	ENOTCONN: -107,
	ESHUTDOWN: -108,
	ETIMEDOUT: -110,
	ECONNREFUSED: -111,
	EALREADY: -114,
	EINPROGRESS: -115
};
function Er(e) {
	if (e && "object" == typeof e && "code" in e) {
		const t = e.code;
		if ("number" == typeof t && 0 !== t) return t < 0 ? t : -t;
		if ("string" == typeof t) {
			const e = Pr[t];
			if (void 0 !== e) return e;
		}
	}
	if (e && "object" == typeof e && "errno" in e) {
		const t = e.errno;
		if ("number" == typeof t && Number.isInteger(t) && 0 !== t) return t < 0 ? t : -t;
	}
	if (e instanceof Error) {
		const t = /^([A-Z][A-Z0-9_]*)\b/.exec(e.message)?.[1];
		if (void 0 !== t) {
			const e = Pr[t];
			if (void 0 !== e) return e;
		}
	}
	return -5;
}
var Cr = class e {
	config;
	io;
	callbacks;
	instance = null;
	memory = null;
	kernelPtrWidth = 4;
	sharedPipes = /* @__PURE__ */ new Map();
	signalWakeSab = null;
	programFuncTable = null;
	waitpidSab = null;
	pendingDirectoryEntries = /* @__PURE__ */ new Map();
	retainedHostFileHandles = /* @__PURE__ */ new Map();
	fstatHandleCapture = null;
	isThreadWorker = !1;
	framebuffers = new c();
	bos = new l();
	kms = new h(this.bos);
	gl = new b();
	gl_submit_queue = new j((e) => this.kms.isMasterPid(e));
	gl_muxers = /* @__PURE__ */ new WeakMap();
	mergeCallbacks(e) {
		this.callbacks = {
			...this.callbacks,
			...e
		};
	}
	releaseProcessViews(e) {
		this.gl_submit_queue.removePid(e), this.gl.unbind(e), this.framebuffers.unbind(e), this.bos.releaseProcess(e), this.kms.isMasterPid(e) && this.kms.dropMaster();
	}
	setProgramFuncTable(e) {
		this.programFuncTable = e;
	}
	constructor(e, t, r) {
		this.config = e, this.io = t, this.callbacks = r ?? {}, this.bos.setProcessMemoryResolver((e) => this.callbacks.getProcessMemory?.(e));
	}
	getKernelPtrWidth() {
		return this.kernelPtrWidth;
	}
	toKernelPtr(e) {
		const t = "bigint" == typeof e ? Number(e) : e;
		if (!Number.isSafeInteger(t) || t < 0) throw new Error(`invalid kernel pointer ${String(e)}`);
		return 8 === this.kernelPtrWidth ? BigInt(t) : t;
	}
	withFstatHandleCapture(e) {
		if (this.fstatHandleCapture) throw new Error("nested host fstat handle capture");
		const t = { handle: null };
		this.fstatHandleCapture = t;
		try {
			return {
				result: e(),
				handle: t.handle
			};
		} finally {
			this.fstatHandleCapture = null;
		}
	}
	retainHostFileHandle(e) {
		if (!Number.isSafeInteger(e) || e < 0) throw new Error(`invalid host file handle ${e}`);
		const t = this.retainedHostFileHandles.get(e);
		if (t) {
			if (t.descriptorClosePending) throw new Error(`cannot retain closed host file handle ${e}`);
			t.mappingRefs++;
		} else this.retainedHostFileHandles.set(e, {
			mappingRefs: 1,
			descriptorClosePending: !1
		});
	}
	releaseHostFileHandle(e) {
		const t = this.retainedHostFileHandles.get(e);
		if (!t || t.mappingRefs <= 0) return -9;
		if (t.mappingRefs--, t.mappingRefs > 0) return 0;
		if (this.retainedHostFileHandles.delete(e), !t.descriptorClosePending) return 0;
		try {
			return this.io.close(e);
		} catch (r) {
			return Er(r);
		}
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
	injectMouseEvent(e, t, r) {
		const i = this.instance?.exports?.kernel_inject_mouse_event;
		i && i(e, t, r);
	}
	audioScratchOffset = 0;
	static AUDIO_SCRATCH_SIZE = 65536;
	ensureAudioScratch() {
		if (0 !== this.audioScratchOffset) return !0;
		const t = (this.instance?.exports)?.kernel_alloc_scratch;
		if (!t) return !1;
		const r = Number(t(e.AUDIO_SCRATCH_SIZE));
		return 0 !== r && (this.audioScratchOffset = r, !0);
	}
	drainAudio(t) {
		const r = (this.instance?.exports)?.kernel_drain_audio;
		if (!r || !this.memory || !this.ensureAudioScratch()) return 0;
		const i = Math.min(t.byteLength, e.AUDIO_SCRATCH_SIZE), n = r(this.toKernelPtr(this.audioScratchOffset), i);
		if (n > 0) {
			const e = new Uint8Array(this.memory.buffer, this.audioScratchOffset, n);
			t.set(e.subarray(0, n));
		}
		return n;
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
	registerSharedPipe(e, t, r) {
		this.sharedPipes.set(e, {
			pipe: a.fromSharedBuffer(t),
			end: r
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
	registerWaitpidSab(e) {
		this.waitpidSab = e;
	}
	async init(e) {
		this.kernelPtrWidth = Sr(vr(e));
		const t = this.createKernelMemory();
		this.memory = t;
		const r = this.buildImportObject(t), i = await WebAssembly.compile(e);
		this.instance = await WebAssembly.instantiate(i, r);
	}
	async initWithMemory(e, t) {
		this.kernelPtrWidth = Sr(vr(e)), this.memory = t;
		const r = this.buildImportObject(t), i = await WebAssembly.compile(e);
		this.instance = await WebAssembly.instantiate(i, r);
	}
	buildImportObject(e) {
		return { env: {
			memory: e,
			host_debug_log: (t, r) => {
				const i = new Uint8Array(e.buffer, Number(t), r), n = new TextDecoder().decode(i.slice());
				console.log(`[KERNEL] ${n}`);
			},
			host_open: (e, t, r, i) => this.hostOpen(Number(e), t, r, i),
			host_close: (e) => this.hostClose(e),
			host_read: (e, t, r) => this.hostRead(e, Number(t), r),
			host_write: (e, t, r) => this.hostWrite(e, Number(t), r),
			host_seek: (e, t, r, i) => this.hostSeek(e, t, r, i),
			host_fstat: (e, t) => this.hostFstat(e, Number(t)),
			host_stat: (e, t, r) => this.hostStat(Number(e), t, Number(r)),
			host_lstat: (e, t, r) => this.hostLstat(Number(e), t, Number(r)),
			host_statfs: (e, t, r) => this.hostStatfs(Number(e), t, Number(r)),
			host_pathconf: (e, t, r, i) => this.hostPathconf(Number(e), t, r, Number(i)),
			host_fpathconf: (e, t, r) => this.hostFpathconf(e, t, Number(r)),
			host_mkdir: (e, t, r) => this.hostMkdir(Number(e), t, r),
			host_rmdir: (e, t) => this.hostRmdir(Number(e), t),
			host_unlink: (e, t) => this.hostUnlink(Number(e), t),
			host_rename: (e, t, r, i) => this.hostRename(Number(e), t, Number(r), i),
			host_link: (e, t, r, i) => this.hostLink(Number(e), t, Number(r), i),
			host_symlink: (e, t, r, i) => this.hostSymlink(Number(e), t, Number(r), i),
			host_readlink: (e, t, r, i) => this.hostReadlink(Number(e), t, Number(r), i),
			host_chmod: (e, t, r) => this.hostChmod(Number(e), t, r),
			host_chown: (e, t, r, i) => this.hostChown(Number(e), t, r, i),
			host_lchown: (e, t, r, i) => this.hostLchown(Number(e), t, r, i),
			host_access: (e, t, r) => this.hostAccess(Number(e), t, r),
			host_opendir: (e, t) => this.hostOpendir(Number(e), t),
			host_readdir: (e, t, r, i) => this.hostReaddir(e, Number(t), Number(r), i),
			host_closedir: (e) => this.hostClosedir(e),
			host_clock_gettime: (e, t, r) => this.hostClockGettime(e, Number(t), Number(r)),
			host_nanosleep: (e, t) => this.hostNanosleep(e, t),
			host_ftruncate: (e, t) => this.hostFtruncate(e, t),
			host_fsync: (e) => this.hostFsync(e),
			host_fchmod: (e, t) => this.hostFchmod(e, t),
			host_fchown: (e, t, r) => this.hostFchown(e, t, r),
			host_exec: (e, t) => this.hostExec(Number(e), t),
			host_set_alarm: (e) => this.hostSetAlarm(e),
			host_set_posix_timer: (e, t, r, i, n, s) => {
				const o = 4294967296 * (i >>> 0) + (r >>> 0), a = 4294967296 * (s >>> 0) + (n >>> 0);
				return this.hostSetPosixTimer(e, t, o, a);
			},
			host_sigsuspend_wait: () => this.hostSigsuspendWait(),
			host_call_signal_handler: (e, t, r) => {
				const i = this.programFuncTable ?? this.instance?.exports.__indirect_function_table;
				if (!i) return -22;
				const n = i.get(e);
				if (n) try {
					return 4 & r ? n(t, 0, 0) : n(t), 0;
				} catch (s) {
					return -5;
				}
				return -22;
			},
			host_getrandom: (e, t) => {
				try {
					const r = this.getMemoryBuffer(), i = Number(e), n = r.subarray(i, i + t);
					if (void 0 !== globalThis.crypto && globalThis.crypto.getRandomValues) {
						const e = new Uint8Array(t);
						globalThis.crypto.getRandomValues(e), n.set(e);
					} else for (let e = 0; e < t; e++) n[e] = 256 * Math.random() | 0;
					return t;
				} catch {
					return -5;
				}
			},
			host_utimensat: (e, t, r, i, n, s) => this.hostUtimensat(Number(e), t, r, i, n, s),
			host_waitpid: (e, t, r) => this.hostWaitpid(e, t, Number(r)),
			host_net_connect: (e, t, r, i) => this.hostNetConnect(e, Number(t), r, i),
			host_net_send: (e, t, r, i) => this.hostNetSend(e, Number(t), r, i),
			host_net_recv: (e, t, r, i) => this.hostNetRecv(e, Number(t), r, i),
			host_net_poll: (e, t) => this.hostNetPoll(e, t),
			host_net_connect_status: (e) => this.hostNetConnectStatus(e),
			host_net_close: (e) => this.hostNetClose(e),
			host_net_listen: (e, t, r, i, n, s) => this.hostNetListen(e, t, r, i, n, s),
			host_udp_bind: (e, t, r, i, n, s) => this.hostUdpBind(e, t, r, i, n, s),
			host_udp_unbind: (e) => this.hostUdpUnbind(e),
			host_udp_send: (e, t, r, i, n, s, o, a, c, l, h, d) => this.hostUdpSend(e, t, r, i, n, s, o, a, c, l, Number(h), d),
			host_getaddrinfo: (e, t, r, i) => this.hostGetaddrinfo(Number(e), t, Number(r), i),
			host_futex_wait: (e, t, r, i) => this.hostFutexWait(Number(e), t, r, i),
			host_futex_wake: (e, t) => this.hostFutexWake(Number(e), t),
			host_is_thread_worker: () => this.isThreadWorker ? 1 : 0,
			host_bind_framebuffer: (e, t, r, i, n, s, o) => {
				this.framebuffers.bind({
					pid: e,
					addr: Number(t),
					len: Number(r),
					w: i,
					h: n,
					stride: s,
					fmt: "BGRA32"
				});
			},
			host_unbind_framebuffer: (e) => {
				this.framebuffers.unbind(e);
			},
			host_fb_write: (e, t, r, i) => {
				this.framebuffers.fbWrite(e, Number(t), this.readKernelBytes(Number(r), Number(i)));
			},
			host_gbm_bo_create: (e, t, r, i, n, s) => (this.bos.create({
				pid: e,
				bo_id: t,
				size: Number(r),
				w: i,
				h: n,
				stride: s
			}), 0),
			host_gbm_bo_destroy: (e, t) => {
				this.bos.destroy(e, t);
			},
			host_gbm_bo_bind: (e, t, r, i) => this.bos.bind(e, t, Number(r), Number(i)),
			host_gbm_bo_unbind: (e, t, r, i) => {
				this.bos.unbind(e, t);
			},
			host_gl_bind: (e, t, r) => {
				this.gl.bind({
					pid: e,
					cmdbufAddr: Number(t),
					cmdbufLen: Number(r)
				});
			},
			host_gl_unbind: (e) => {
				this.gl.unbind(e);
			},
			host_gl_create_context: (e, t, r, i) => {
				const n = this.gl.get(e);
				if (!n) return;
				if (n.contextId = t, n.forward) return void n.forward.onCreateContext();
				if (!n.canvas) {
					const t = this.kms.masterCrtcForPid(e);
					if (null != t) {
						const r = this.callbacks.getKmsCanvas?.(t);
						if (r) {
							const i = this.kms.currentFb(t);
							!i || r.width === i.width && r.height === i.height || (r.width = i.width, r.height = i.height), this.gl.attachCanvas(e, r), n.canvas = r, this.callbacks.markKmsCanvasGlOwned?.(t);
						}
					}
					if (!n.canvas) return;
				}
				const s = n.canvas.getContext("webgl2", {
					antialias: !1,
					premultipliedAlpha: !1,
					preserveDrawingBuffer: !0
				});
				s && (s.getExtension("EXT_color_buffer_float"), s.getExtension("OES_texture_float_linear"), s.getExtension("EXT_float_blend")), n.gl = s;
			},
			host_gl_destroy_context: (e, t) => {
				const r = this.gl.get(e);
				r && (r.gl = null, r.contextId = null, r.currentProgram = null, r.forward && r.forward.onDestroyContext());
			},
			host_gl_create_surface: (e, t, r, i) => {
				const n = this.gl.get(e);
				n && (n.surfaceId = t);
			},
			host_gl_destroy_surface: (e, t) => {
				const r = this.gl.get(e);
				r && (r.surfaceId = null);
			},
			host_gl_make_current: (e, t, r) => {},
			host_gl_submit: (e, t, r) => {
				const i = this.gl.get(e);
				if (!i) return -5;
				if (!i.forward && !i.gl) return 0;
				if (!i.cmdbufView) {
					const t = this.callbacks.getProcessMemory?.(e);
					if (!t) return -5;
					try {
						i.cmdbufView = new Uint8Array(t.buffer, i.cmdbufAddr, i.cmdbufLen), this.callbacks.onProcessMemoryTarget?.(t, t.buffer), this.callbacks.onProcessMemoryTarget?.(t, i.cmdbufView), this.callbacks.onProcessMemoryTarget?.(t, i);
					} catch {
						return -5;
					}
				}
				if (i.forward) {
					const e = Number(t), n = Number(r), s = function(e, t, r) {
						return N(e, t, r, () => 0);
					}(i.cmdbufView, e, n);
					return s < 0 ? s : (i.forward.onSubmit(i.cmdbufView.slice(e, e + n)), 0);
				}
				return this.gl_submit_queue.enqueue(i, {
					memorySab: i.cmdbufView.buffer,
					off: Number(t),
					len: Number(r)
				}), function(e, t, r) {
					for (;;) {
						const i = e.pickNext();
						if (!i) return 0;
						const n = i.frames.shift(), s = t(i.binding);
						s && s.switchTo(i.binding);
						const o = r(i.binding, n.off, n.len);
						if (e.releaseIfEmpty(i), "number" == typeof o && o < 0) return o;
					}
				}(this.gl_submit_queue, (e) => {
					if (!e.gl) return null;
					let t = this.gl_muxers.get(e.gl);
					return t || (t = new X(e.gl), this.gl_muxers.set(e.gl, t)), t;
				}, (e, t, r) => O(e, t, r));
			},
			host_gl_present: (e) => {},
			host_gl_query: (e, t, r, i, n, s) => {
				const o = this.gl.get(e);
				if (!o || !o.gl) return -1;
				const a = i > 0n ? this.readKernelBytes(Number(r), Number(i)) : new Uint8Array(0), c = new Uint8Array(Number(s)), l = function(e, t, r, i) {
					if (!e.gl) return -1;
					const n = e.gl, s = new DataView(r.buffer, r.byteOffset, r.byteLength), o = new DataView(i.buffer, i.byteOffset, i.byteLength);
					switch (t) {
						case 1: return i.byteLength < 4 ? -22 : (o.setUint32(0, n.getError(), !0), 4);
						case 2: {
							if (r.byteLength < 4) return -22;
							const e = s.getUint32(0, !0), t = n.getParameter(e) ?? "", a = new TextEncoder().encode(t), c = 4 + a.byteLength;
							return i.byteLength < c ? -22 : (o.setUint32(0, a.byteLength, !0), i.set(a, 4), c);
						}
						case 3: {
							if (r.byteLength < 4 || i.byteLength < 4) return -22;
							const e = s.getUint32(0, !0), t = n.getParameter(e);
							return o.setInt32(0, Number(t ?? 0), !0), 4;
						}
						case 4: {
							if (r.byteLength < 4 || i.byteLength < 4) return -22;
							const e = s.getUint32(0, !0), t = n.getParameter(e);
							return o.setFloat32(0, Number(t ?? 0), !0), 4;
						}
						case 5: {
							if (r.byteLength < 8 || i.byteLength < 4) return -22;
							const t = s.getUint32(0, !0), a = s.getUint32(4, !0);
							if (r.byteLength < 8 + a) return -22;
							const c = e.programs.get(t), l = new TextDecoder().decode(r.subarray(8, 8 + a)), h = c ? n.getUniformLocation(c, l) : null;
							if (h) {
								const t = ++e.nextUniformLoc;
								e.uniformLocations.set(t, h), o.setInt32(0, t, !0);
							} else o.setInt32(0, -1, !0);
							return 4;
						}
						case 6: {
							if (r.byteLength < 8 || i.byteLength < 4) return -22;
							const t = s.getUint32(0, !0), a = s.getUint32(4, !0);
							if (r.byteLength < 8 + a) return -22;
							const c = e.programs.get(t), l = new TextDecoder().decode(r.subarray(8, 8 + a)), h = c ? n.getAttribLocation(c, l) : -1;
							return o.setInt32(0, h, !0), 4;
						}
						case 7: {
							if (r.byteLength < 8 || i.byteLength < 4) return -22;
							const t = e.shaders.get(s.getUint32(0, !0));
							if (!t) return o.setInt32(0, 0, !0), 4;
							const a = n.getShaderParameter(t, s.getUint32(4, !0));
							return o.setInt32(0, "boolean" == typeof a ? a ? 1 : 0 : Number(a ?? 0), !0), 4;
						}
						case 8: {
							if (r.byteLength < 4) return -22;
							const t = e.shaders.get(s.getUint32(0, !0)), a = (t && n.getShaderInfoLog(t)) ?? "", c = new TextEncoder().encode(a), l = 4 + c.byteLength;
							return i.byteLength < l ? (o.setUint32(0, 0, !0), 4) : (o.setUint32(0, c.byteLength, !0), i.set(c, 4), l);
						}
						case 9: {
							if (r.byteLength < 8 || i.byteLength < 4) return -22;
							const t = e.programs.get(s.getUint32(0, !0));
							if (!t) return o.setInt32(0, 0, !0), 4;
							const a = n.getProgramParameter(t, s.getUint32(4, !0));
							return o.setInt32(0, "boolean" == typeof a ? a ? 1 : 0 : Number(a ?? 0), !0), 4;
						}
						case 10: {
							if (r.byteLength < 4) return -22;
							const t = e.programs.get(s.getUint32(0, !0)), a = (t && n.getProgramInfoLog(t)) ?? "", c = new TextEncoder().encode(a), l = 4 + c.byteLength;
							return i.byteLength < l ? (o.setUint32(0, 0, !0), 4) : (o.setUint32(0, c.byteLength, !0), i.set(c, 4), l);
						}
						case 11: {
							if (r.byteLength < 24) return -22;
							const e = s.getInt32(0, !0), t = s.getInt32(4, !0), o = s.getInt32(8, !0), a = s.getInt32(12, !0), c = s.getUint32(16, !0), l = s.getUint32(20, !0);
							let h = i;
							return 5126 === l ? h = new Float32Array(i.buffer, i.byteOffset, i.byteLength / 4 | 0) : 5131 === l && (h = new Uint16Array(i.buffer, i.byteOffset, i.byteLength / 2 | 0)), n.readPixels(e, t, o, a, c, l, h), i.byteLength;
						}
						case 12: {
							if (r.byteLength < 4 || i.byteLength < 4) return -22;
							const e = n.checkFramebufferStatus(s.getUint32(0, !0));
							return o.setUint32(0, e, !0), 4;
						}
						default: return -22;
					}
				}(o, t, a, c);
				return l > 0 && 0 !== Number(n) && this.writeKernelBytes(Number(n), c.subarray(0, l)), l;
			},
			host_kms_set_master: (e) => {
				this.kms.setMasterPid(e);
			},
			host_kms_drop_master: (e) => {
				this.kms.dropMaster();
			},
			host_proc_write_bytes: (e, t, r, i) => {
				const n = this.callbacks.getProcessMemory?.(e);
				if (!n) return -14;
				try {
					const e = this.readKernelBytes(Number(r), i);
					return new Uint8Array(n.buffer, Number(t), i).set(e), 0;
				} catch {
					return -14;
				}
			},
			host_proc_read_bytes: (e, t, r, i) => {
				const n = this.callbacks.getProcessMemory?.(e);
				if (!n) return -14;
				try {
					const e = new Uint8Array(n.buffer, Number(t), i), s = new Uint8Array(i);
					return s.set(e), this.writeKernelBytes(Number(r), s), 0;
				} catch {
					return -14;
				}
			},
			host_kms_mode_info: (e, t) => {
				const r = this.callbacks.getKmsCanvas?.(e);
				this.writeKernelBytes(Number(t), function(e, t, r = 60) {
					const i = Ar(e, 1920), n = Ar(t, 1080), s = Ir(i + 16), o = Ir(i + 48), a = Ir(i + 160), c = Ir(n + 3), l = Ir(n + 8), h = Ir(n + 45), d = Math.max(1, Math.min(4294967295, Math.round(a * h * r / 1e3))), f = new Uint8Array(68), u = new DataView(f.buffer);
					u.setUint32(0, d, !0), u.setUint16(4, i, !0), u.setUint16(6, s, !0), u.setUint16(8, o, !0), u.setUint16(10, a, !0), u.setUint16(12, 0, !0), u.setUint16(14, n, !0), u.setUint16(16, c, !0), u.setUint16(18, l, !0), u.setUint16(20, h, !0), u.setUint16(22, 0, !0), u.setUint32(24, r, !0), u.setUint32(28, 0, !0), u.setUint32(32, 9, !0);
					const p = `${i}x${n}`;
					for (let m = 0; m < Math.min(p.length, 31); m++) f[36 + m] = 255 & p.charCodeAt(m);
					return f;
				}(r?.width, r?.height));
			},
			host_kms_addfb: (e, t, r, i, n, s, o) => (this.kms.addFb({
				fb_id: t,
				bo_id: r,
				width: i,
				height: n,
				pixel_format: s,
				pitch: o
			}), 0),
			host_kms_rmfb: (e, t) => {
				this.kms.rmFb(t);
			},
			host_kms_set_fb: (e, t, r) => {
				this.kms.setFb(t, r);
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
		const r = new Uint8Array(t);
		return r.set(this.getMemoryBuffer().subarray(e, e + t)), r;
	}
	writeKernelBytes(e, t) {
		this.getMemoryBuffer().set(t, e);
	}
	hostOpen(e, t, r, i) {
		try {
			const n = this.getMemoryBuffer().slice(e, e + t), s = new TextDecoder().decode(n);
			return BigInt(this.io.open(s, r, i));
		} catch (n) {
			return BigInt(Er(n));
		}
	}
	hostClose(e) {
		const t = Number(e), r = this.sharedPipes.get(t);
		if (r) return "read" === r.end ? r.pipe.closeRead() : r.pipe.closeWrite(), this.sharedPipes.delete(t), 0;
		if (t >= 0 && t <= 2) return 0;
		const i = this.retainedHostFileHandles.get(t);
		if (i) return i.descriptorClosePending = !0, 0;
		try {
			return this.io.close(t);
		} catch (n) {
			return Er(n);
		}
	}
	hostRead(e, t, r) {
		const i = Number(e), n = this.sharedPipes.get(i);
		if (n) {
			const e = this.getMemoryBuffer(), i = new Uint8Array(e.buffer, t, r);
			return n.pipe.read(i);
		}
		if (0 === i) {
			if (this.callbacks.onStdin) {
				const e = this.callbacks.onStdin(r);
				if (null === e) return 0;
				if (0 === e.length) return -11;
				const i = this.getMemoryBuffer(), n = Math.min(e.length, r);
				return i.set(e.subarray(0, n), t), n;
			}
			return 0;
		}
		try {
			const e = this.getMemoryBuffer().subarray(t, t + r);
			return this.io.read(i, e, null, r);
		} catch (s) {
			return Er(s);
		}
	}
	hostWrite(e, t, r) {
		const i = Number(e), n = this.getMemoryBuffer().slice(t, t + r), s = this.sharedPipes.get(i);
		if (s) return s.pipe.write(n);
		if (1 === i) return this.callbacks.onStdout ? this.callbacks.onStdout(n) : "undefined" != typeof process && process.stdout ? process.stdout.write(n) : console.log(new TextDecoder().decode(n)), r;
		if (2 === i) return this.callbacks.onStderr ? this.callbacks.onStderr(n) : "undefined" != typeof process && process.stderr ? process.stderr.write(n) : console.error(new TextDecoder().decode(n)), r;
		try {
			return this.io.write(i, n, null, r);
		} catch (o) {
			return Er(o);
		}
	}
	hostSeek(e, t, r, i) {
		const n = Number(e), s = 4294967296 * r + (t >>> 0);
		try {
			return BigInt(this.io.seek(n, s, i));
		} catch (o) {
			return BigInt(Er(o));
		}
	}
	hostFstat(e, t) {
		const r = Number(e);
		try {
			const e = this.io.fstat(r);
			return this.writeStatToMemory(t, e), this.fstatHandleCapture && (this.fstatHandleCapture.handle = r), 0;
		} catch (i) {
			return Er(i);
		}
	}
	writeStatToMemory(e, t) {
		const r = this.getMemoryDataView();
		this.getMemoryBuffer().fill(0, e, e + 88), r.setBigUint64(e + 0, kr(t.dev, "st_dev"), !0), r.setBigUint64(e + 8, kr(t.ino, "st_ino"), !0), r.setUint32(e + 16, t.mode, !0), r.setUint32(e + 20, t.nlink, !0), r.setUint32(e + 24, t.uid, !0), r.setUint32(e + 28, t.gid, !0), r.setBigUint64(e + 32, BigInt(t.size), !0);
		const i = Math.floor(t.atimeMs / 1e3), n = Math.floor(t.atimeMs % 1e3 * 1e6);
		r.setBigUint64(e + 40, BigInt(i), !0), r.setUint32(e + 48, n, !0);
		const s = Math.floor(t.mtimeMs / 1e3), o = Math.floor(t.mtimeMs % 1e3 * 1e6);
		r.setBigUint64(e + 56, BigInt(s), !0), r.setUint32(e + 64, o, !0);
		const a = Math.floor(t.ctimeMs / 1e3), c = Math.floor(t.ctimeMs % 1e3 * 1e6);
		r.setBigUint64(e + 72, BigInt(a), !0), r.setUint32(e + 80, c, !0);
	}
	writeStatfsToMemory(e, t) {
		const r = this.getMemoryDataView();
		this.getMemoryBuffer().fill(0, e, e + 72);
		const i = (e) => Number.isFinite(e) ? Math.max(0, Math.floor(e)) >>> 0 : 0, n = (e) => !Number.isFinite(e) || e <= 0 ? 0n : BigInt(Math.min(Math.floor(e), Number.MAX_SAFE_INTEGER));
		r.setUint32(e + 0, i(t.type), !0), r.setUint32(e + 4, i(t.bsize), !0), r.setBigUint64(e + 8, n(t.blocks), !0), r.setBigUint64(e + 16, n(t.bfree), !0), r.setBigUint64(e + 24, n(t.bavail), !0), r.setBigUint64(e + 32, n(t.files), !0), r.setBigUint64(e + 40, n(t.ffree), !0), r.setBigUint64(e + 48, n(t.fsid), !0), r.setUint32(e + 56, i(t.namelen), !0), r.setUint32(e + 60, i(t.frsize), !0), r.setUint32(e + 64, i(t.flags), !0);
	}
	readPathFromMemory(e, t) {
		const r = this.getMemoryBuffer().slice(e, e + t);
		return new TextDecoder().decode(r);
	}
	hostStat(e, t, r) {
		try {
			const i = this.readPathFromMemory(e, t), n = this.io.stat(i);
			return this.writeStatToMemory(r, n), 0;
		} catch (i) {
			return Er(i);
		}
	}
	hostLstat(e, t, r) {
		try {
			const i = this.readPathFromMemory(e, t), n = this.io.lstat(i);
			return this.writeStatToMemory(r, n), 0;
		} catch (i) {
			return Er(i);
		}
	}
	hostStatfs(e, t, r) {
		try {
			const i = this.readPathFromMemory(e, t), n = this.io.statfs(i);
			return this.writeStatfsToMemory(r, n), 0;
		} catch (i) {
			return Er(i);
		}
	}
	hostPathconf(e, t, r, i) {
		try {
			const n = this.readPathFromMemory(e, t), s = this.io.pathconf(n, r);
			return this.getMemoryDataView().setBigInt64(i, BigInt(s ?? -1), !0), 0;
		} catch (n) {
			return Er(n);
		}
	}
	hostFpathconf(e, t, r) {
		try {
			const i = this.io.fpathconf(Number(e), t);
			return this.getMemoryDataView().setBigInt64(r, BigInt(i ?? -1), !0), 0;
		} catch (i) {
			return Er(i);
		}
	}
	hostMkdir(e, t, r) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.mkdir(i, r), 0;
		} catch (i) {
			return Er(i);
		}
	}
	hostRmdir(e, t) {
		try {
			const r = this.readPathFromMemory(e, t);
			return this.io.rmdir(r), 0;
		} catch (r) {
			return Er(r);
		}
	}
	hostUnlink(e, t) {
		try {
			const r = this.readPathFromMemory(e, t);
			return this.io.unlink(r), 0;
		} catch (r) {
			return Er(r);
		}
	}
	hostRename(e, t, r, i) {
		try {
			const n = this.readPathFromMemory(e, t), s = this.readPathFromMemory(r, i);
			return this.io.rename(n, s), 0;
		} catch (n) {
			return Er(n);
		}
	}
	hostLink(e, t, r, i) {
		try {
			const n = this.readPathFromMemory(e, t), s = this.readPathFromMemory(r, i);
			return this.io.link(n, s), 0;
		} catch (n) {
			return Er(n);
		}
	}
	hostSymlink(e, t, r, i) {
		try {
			const n = this.readPathFromMemory(e, t), s = this.readPathFromMemory(r, i);
			return this.io.symlink(n, s), 0;
		} catch (n) {
			return Er(n);
		}
	}
	hostReadlink(e, t, r, i) {
		try {
			const n = this.readPathFromMemory(e, t), s = this.io.readlink(n), o = new TextEncoder().encode(s), a = Math.min(o.length, i);
			return this.getMemoryBuffer().set(o.subarray(0, a), r), a;
		} catch (n) {
			return Er(n);
		}
	}
	hostChmod(e, t, r) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.chmod(i, r), 0;
		} catch (i) {
			return Er(i);
		}
	}
	hostChown(e, t, r, i) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.chown(n, r, i), 0;
		} catch (n) {
			return Er(n);
		}
	}
	hostLchown(e, t, r, i) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.lchown(n, r, i), 0;
		} catch (n) {
			return Er(n);
		}
	}
	hostAccess(e, t, r) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.access(i, r), 0;
		} catch (i) {
			return Er(i);
		}
	}
	hostUtimensat(e, t, r, i, n, s) {
		try {
			const o = this.readPathFromMemory(e, t);
			return this.io.utimensat(o, Number(r), Number(i), Number(n), Number(s)), 0;
		} catch {
			return -1;
		}
	}
	hostWaitpid(e, t, r) {
		if (this.waitpidSab && this.callbacks.onWaitpid) {
			const i = new Int32Array(this.waitpidSab);
			Atomics.store(i, 0, 0), Atomics.store(i, 1, 0), Atomics.store(i, 2, 0), this.callbacks.onWaitpid(e, t), Atomics.wait(i, 0, 0);
			const n = Atomics.load(i, 1), s = Atomics.load(i, 2);
			return n < 0 || 0 !== r && this.memory && new DataView(this.memory.buffer).setInt32(r, s, !0), n;
		}
		if (!this.io.waitpid) return -10;
		try {
			const i = this.io.waitpid(e, t);
			return 0 !== r && this.memory && new DataView(this.memory.buffer).setInt32(r, i.status, !0), i.pid;
		} catch {
			return -10;
		}
	}
	hostOpendir(e, t) {
		try {
			const r = this.readPathFromMemory(e, t), i = this.io.opendir(r);
			return this.pendingDirectoryEntries.delete(i), BigInt(i);
		} catch (r) {
			return BigInt(Er(r));
		}
	}
	hostReaddir(e, t, r, i) {
		try {
			const n = Number(e);
			let s = this.pendingDirectoryEntries.get(n);
			if (void 0 === s) {
				const e = this.io.readdir(n);
				if (null === e) return 0;
				this.pendingDirectoryEntries.set(n, e), s = e;
			}
			const o = this.getMemoryDataView(), a = this.getMemoryBuffer(), c = new TextEncoder().encode(s.name), l = Math.min(c.length, i);
			return o.setBigUint64(t, BigInt(s.ino), !0), o.setUint32(t + 8, s.type, !0), o.setUint32(t + 12, l, !0), a.set(c.subarray(0, l), r), this.pendingDirectoryEntries.delete(n), 1;
		} catch (n) {
			return Er(n);
		}
	}
	hostClosedir(e) {
		const t = Number(e);
		try {
			return this.io.closedir(t), 0;
		} catch {
			return -1;
		} finally {
			this.pendingDirectoryEntries.delete(t);
		}
	}
	hostClockGettime(e, t, r) {
		try {
			const i = this.io.clockGettime(e), n = this.getMemoryDataView();
			return n.setBigInt64(t, BigInt(i.sec), !0), n.setBigInt64(r, BigInt(i.nsec), !0), 0;
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
	hostFchown(e, t, r) {
		try {
			return this.io.fchown(Number(e), t, r), 0;
		} catch {
			return -1;
		}
	}
	hostExec(e, t) {
		if (this.callbacks.onExec) {
			const r = this.getMemoryBuffer(), i = new TextDecoder().decode(r.slice(e, e + t));
			return this.callbacks.onExec(i);
		}
		return -2;
	}
	hostSetAlarm(e) {
		return this.callbacks.onAlarm ? this.callbacks.onAlarm(e) : 0;
	}
	hostSetPosixTimer(e, t, r, i) {
		return this.callbacks.onPosixTimer ? this.callbacks.onPosixTimer(e, t, r, i) : 0;
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
	socket(e, t, r) {
		const i = (0, this.instance.exports.kernel_socket)(e, t, r);
		if (i < 0) throw new Error("socket failed: errno " + -i);
		return i;
	}
	socketpair(e, t, r) {
		const i = this.instance.exports.kernel_socketpair, n = this.getMemoryDataView(), s = i(e, t, r, 4);
		if (s < 0) throw new Error("socketpair failed: errno " + -s);
		return [n.getInt32(4, !0), n.getInt32(8, !0)];
	}
	shutdown(e, t) {
		const r = (0, this.instance.exports.kernel_shutdown)(e, t);
		if (r < 0) throw new Error("shutdown failed: errno " + -r);
	}
	send(e, t, r = 0) {
		const i = this.instance.exports.kernel_send;
		this.getMemoryBuffer().set(t, 16);
		const n = i(e, 16, t.length, r);
		if (n < 0) throw new Error("send failed: errno " + -n);
		return n;
	}
	recv(e, t, r = 0) {
		const i = (0, this.instance.exports.kernel_recv)(e, 16, t, r);
		if (i < 0) throw new Error("recv failed: errno " + -i);
		return this.getMemoryBuffer().slice(16, 16 + i);
	}
	poll(e, t) {
		const r = this.instance.exports.kernel_poll, i = e.length, n = this.getMemoryDataView();
		for (let o = 0; o < i; o++) {
			const t = 16 + 8 * o;
			n.setInt32(t, e[o].fd, !0), n.setInt16(t + 4, e[o].events, !0), n.setInt16(t + 6, 0, !0);
		}
		const s = r(16, i, t);
		if (s < 0) throw new Error("poll failed: errno " + -s);
		return e.map((e, t) => ({
			fd: e.fd,
			events: e.events,
			revents: n.getInt16(16 + 8 * t + 6, !0)
		}));
	}
	getsockopt(e, t, r) {
		const i = this.instance.exports.kernel_getsockopt, n = this.getMemoryDataView(), s = i(e, t, r, 4);
		if (s < 0) throw new Error("getsockopt failed: errno " + -s);
		return n.getUint32(4, !0);
	}
	setsockopt(e, t, r, i) {
		const n = (0, this.instance.exports.kernel_setsockopt)(e, t, r, i);
		if (n < 0) throw new Error("setsockopt failed: errno " + -n);
	}
	tcgetattr(e) {
		const t = (0, this.instance.exports.kernel_tcgetattr)(e, 16, 48);
		if (t < 0) throw new Error("tcgetattr failed: errno " + -t);
		return this.getMemoryBuffer().slice(16, 64);
	}
	tcsetattr(e, t, r) {
		const i = this.instance.exports.kernel_tcsetattr;
		this.getMemoryBuffer().set(r, 16);
		const n = i(e, t, 16, r.length);
		if (n < 0) throw new Error("tcsetattr failed: errno " + -n);
	}
	ioctl(e, t, r) {
		const i = this.instance.exports.kernel_ioctl, n = this.getMemoryBuffer(), s = r ? r.length : 8;
		r && n.set(r, 16);
		const o = i(e, t, 16, s);
		if (o < 0) throw new Error("ioctl failed: errno " + -o);
		return n.slice(16, 16 + s);
	}
	signal(e, t) {
		const r = (0, this.instance.exports.kernel_signal)(e, t);
		if (r < 0) throw new Error("signal failed: errno " + -r);
		return r;
	}
	umask(e) {
		return (0, this.instance.exports.kernel_umask)(e);
	}
	uname() {
		const e = this.instance.exports.kernel_uname, t = e(16, 325);
		if (t < 0) throw new Error("uname failed: errno " + -t);
		const r = this.getMemoryBuffer(), i = new TextDecoder(), n = (e) => {
			const t = 16 + e;
			let n = t;
			for (; n < t + 65 && 0 !== r[n];) n++;
			return i.decode(r.slice(t, n));
		};
		return {
			sysname: n(0),
			nodename: n(65),
			release: n(130),
			version: n(195),
			machine: n(260)
		};
	}
	sysconf(e) {
		const t = (0, this.instance.exports.kernel_sysconf)(e);
		return Number(t);
	}
	dup3(e, t, r) {
		const i = (0, this.instance.exports.kernel_dup3)(e, t, r);
		if (i < 0) throw new Error("dup3 failed: errno " + -i);
		return i;
	}
	pipe2(e) {
		const t = this.instance.exports.kernel_pipe2, r = this.getMemoryDataView(), i = t(e, 4);
		if (i < 0) throw new Error("pipe2 failed: errno " + -i);
		return [r.getInt32(4, !0), r.getInt32(8, !0)];
	}
	ftruncate(e, t) {
		const r = (0, this.instance.exports.kernel_ftruncate)(e, 4294967295 & t, Math.floor(t / 4294967296));
		if (r < 0) throw new Error("ftruncate failed: errno " + -r);
	}
	fsync(e) {
		const t = (0, this.instance.exports.kernel_fsync)(e);
		if (t < 0) throw new Error("fsync failed: errno " + -t);
	}
	truncate(e, t, r) {
		const i = (0, this.instance.exports.kernel_truncate)(e, t, 4294967295 & r, Math.floor(r / 4294967296));
		if (i < 0) throw new Error("truncate failed: errno " + -i);
	}
	fdatasync(e) {
		const t = (0, this.instance.exports.kernel_fdatasync)(e);
		if (t < 0) throw new Error("fdatasync failed: errno " + -t);
	}
	fchmod(e, t) {
		const r = (0, this.instance.exports.kernel_fchmod)(e, t);
		if (r < 0) throw new Error("fchmod failed: errno " + -r);
	}
	fchown(e, t, r) {
		const i = (0, this.instance.exports.kernel_fchown)(e, t, r);
		if (i < 0) throw new Error("fchown failed: errno " + -i);
	}
	getpgrp() {
		return (0, this.instance.exports.kernel_getpgrp)();
	}
	setpgid(e, t) {
		const r = (0, this.instance.exports.kernel_setpgid)(e, t);
		if (r < 0) throw new Error("setpgid failed: errno " + -r);
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
	select(e, t, r, i) {
		const n = this.instance.exports.kernel_select, s = this.getMemoryBuffer(), o = t ? 16 : 0, a = r ? 144 : 0, c = i ? 272 : 0;
		if (t) {
			s.fill(0, o, o + 128);
			for (const e of t) s[o + Math.floor(e / 8)] |= 1 << e % 8;
		}
		if (r) {
			s.fill(0, a, a + 128);
			for (const e of r) s[a + Math.floor(e / 8)] |= 1 << e % 8;
		}
		if (i) {
			s.fill(0, c, c + 128);
			for (const e of i) s[c + Math.floor(e / 8)] |= 1 << e % 8;
		}
		const l = n(e, o, a, c, 0);
		if (l < 0) throw new Error("select failed: errno " + -l);
		const h = (e, t) => t && e ? t.filter((t) => s[e + Math.floor(t / 8)] >> t % 8 & 1) : [];
		return {
			readReady: h(o, t),
			writeReady: h(a, r),
			exceptReady: h(c, i)
		};
	}
	hostNetConnect(e, t, r, i) {
		if (!this.io.network) return -111;
		try {
			const n = new Uint8Array(this.memory.buffer).slice(t, t + r);
			return this.io.network.connect(e, n, i), 0;
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
	hostNetSend(e, t, r, i) {
		if (!this.io.network) return -107;
		try {
			const n = new Uint8Array(this.memory.buffer).slice(t, t + r);
			return this.io.network.send(e, n, i);
		} catch (n) {
			return 11 === n?.errno ? -11 : -32;
		}
	}
	hostNetRecv(e, t, r, i) {
		if (!this.io.network) return -107;
		try {
			const n = this.io.network.recv(e, r, i);
			return n.length > 0 && this.memory && new Uint8Array(this.memory.buffer).set(n, t), n.length;
		} catch (n) {
			return 11 === n?.errno ? -11 : -104;
		}
	}
	hostNetPoll(e, t) {
		if (!this.io.network) return -107;
		try {
			return this.io.network.poll ? this.io.network.poll(e, t) : 5 & t;
		} catch (r) {
			return "number" == typeof r?.errno ? -Math.abs(r.errno) : -104;
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
	hostNetListen(e, t, r, i, n, s) {
		return this.callbacks.onNetListen ? this.callbacks.onNetListen(e, t, [
			r,
			i,
			n,
			s
		]) : 0;
	}
	hostUdpBind(e, t, r, i, n, s) {
		return this.callbacks.onUdpBind ? this.callbacks.onUdpBind(e, [
			t,
			r,
			i,
			n
		], s) : 0;
	}
	hostUdpUnbind(e) {
		return this.callbacks.onUdpUnbind ? this.callbacks.onUdpUnbind(e) : 0;
	}
	hostUdpSend(e, t, r, i, n, s, o, a, c, l, h, d) {
		if (!this.io.network?.sendDatagram) return -101;
		try {
			const f = this.getMemoryBuffer();
			let u = new Uint8Array([
				e,
				t,
				r,
				i
			]);
			0 === u[0] && 0 === u[1] && 0 === u[2] && 0 === u[3] && this.io.network.localAddress && (u = this.io.network.localAddress.slice());
			const p = f.slice(h, h + d), m = this.io.network.sendDatagram({
				srcAddr: u,
				srcPort: n,
				dstAddr: new Uint8Array([
					s,
					o,
					a,
					c
				]),
				dstPort: l,
				data: p
			});
			return 0 === m ? d : -m;
		} catch (f) {
			return "number" == typeof f?.errno ? -Math.abs(f.errno) : -101;
		}
	}
	hostGetaddrinfo(e, t, r, i) {
		if (!this.io.network) return -2;
		try {
			const n = new Uint8Array(this.memory.buffer), s = new TextDecoder().decode(n.slice(e, e + t)), o = this.io.network.getaddrinfo(s);
			return o.length > i ? -22 : (n.set(o, r), o.length);
		} catch (n) {
			return 11 === n?.errno ? -11 : -2;
		}
	}
	hostFutexWait(e, t, r, i) {
		if (!this.memory) return -22;
		const n = new Int32Array(this.memory.buffer), s = e >>> 2, o = 4294967296n * BigInt(i >>> 0) + BigInt(r >>> 0), a = BigInt.asIntN(64, o);
		let c;
		a >= 0n && (c = Number(a / 1000000n), 0 === c && a > 0n && (c = 1));
		const l = Atomics.wait(n, s, t, c);
		return "timed-out" === l ? -110 : "not-equal" === l ? -11 : 0;
	}
	hostFutexWake(e, t) {
		if (!this.memory) return 0;
		const r = new Int32Array(this.memory.buffer), i = e >>> 2;
		return Atomics.notify(r, i, t);
	}
};
const xr = new TextEncoder(), zr = new TextDecoder();
var Mr = class {
	maximumBytes;
	chunks = [];
	bytes = 0;
	constructor(e) {
		if (this.maximumBytes = e, !Number.isSafeInteger(e) || e < 1) throw new Error("HTTP response byte bound must be a positive safe integer");
	}
	push(e) {
		if (e.byteLength > this.maximumBytes - this.bytes) throw new Error(`in-kernel HTTP response exceeds its ${this.maximumBytes}-byte bound`);
		this.chunks.push(e), this.bytes += e.byteLength;
	}
	concat() {
		const e = new Uint8Array(this.bytes);
		let t = 0;
		for (const r of this.chunks) e.set(r, t), t += r.byteLength;
		return e;
	}
};
function Tr(e, t = "GET") {
	if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(t)) throw new Error("in-kernel HTTP request method is malformed");
	const r = function(e) {
		for (let t = 0; t + 3 < e.length; t++) if (13 === e[t] && 10 === e[t + 1] && 13 === e[t + 2] && 10 === e[t + 3]) return t;
		return -1;
	}(e);
	if (r < 0) throw new Error("in-kernel HTTP response lacks a header terminator");
	const i = zr.decode(e.subarray(0, r)).split("\r\n"), n = i[0]?.match(/^HTTP\/(?:1\.0|1\.1) ([1-5][0-9]{2})(?: [^\r\n]*)?$/u);
	if (null == n) throw new Error("in-kernel HTTP response has a malformed status line");
	const s = parseInt(n[1], 10), o = {}, a = /* @__PURE__ */ new Map();
	for (let f = 1; f < i.length; f++) {
		const { key: e, value: t } = Lr(i[f], "header"), r = e.toLowerCase(), n = a.get(r) ?? [];
		n.push(t), a.set(r, n);
		const s = Object.keys(o).find((e) => e.toLowerCase() === r);
		"set-cookie" === r && void 0 !== s ? o[s] += "\n" + t : o[e] = t;
	}
	let c = e.subarray(r + 4);
	const l = "HEAD" === t.toUpperCase() || s >= 100 && s < 200 || 204 === s || 304 === s;
	if (l && 0 !== c.byteLength) throw new Error("in-kernel HTTP response must not contain a body");
	const h = a.get("transfer-encoding") ?? [], d = a.get("content-length") ?? [];
	if (h.length > 0 && d.length > 0) throw new Error("in-kernel HTTP response has conflicting body framing");
	if (h.length > 0) {
		if (1 !== h.length || "chunked" !== h[0].trim().toLowerCase()) throw new Error("in-kernel HTTP response has unsupported transfer encoding");
		l || (c = function(e) {
			const t = [];
			let r = 0;
			for (;;) {
				const i = Br(e, r);
				if (i < 0) throw new Error("in-kernel HTTP chunk size line is truncated");
				const n = zr.decode(e.subarray(r, i)), s = /^([0-9A-Fa-f]+)(?:;[^\r\n]*)?$/u.exec(n);
				if (null === s) throw new Error("in-kernel HTTP response has a malformed chunk size");
				const o = Number.parseInt(s[1], 16);
				if (!Number.isSafeInteger(o)) throw new Error("in-kernel HTTP response chunk size exceeds its bound");
				const a = i + 2;
				if (0 === o) for (r = a;;) {
					const i = Br(e, r);
					if (i < 0) throw new Error("in-kernel HTTP response lacks its terminating chunk");
					if (i === r) {
						if (i + 2 !== e.byteLength) throw new Error("in-kernel HTTP response has bytes after its chunked body");
						return Rr(t);
					}
					Lr(zr.decode(e.subarray(r, i)), "trailer"), r = i + 2;
				}
				const c = a + o;
				if (c > e.length) throw new Error("in-kernel HTTP response chunk is truncated");
				if (c + 2 > e.length || 13 !== e[c] || 10 !== e[c + 1]) throw new Error("in-kernel HTTP response chunk lacks its terminator");
				t.push(e.subarray(a, c)), r = c + 2;
			}
		}(c));
		for (const e of Object.keys(o)) "transfer-encoding" === e.toLowerCase() && delete o[e];
	} else if (d.length > 0) {
		if (!d.every((e) => e === d[0]) || !/^(?:0|[1-9][0-9]*)$/u.test(d[0])) throw new Error("in-kernel HTTP response has an invalid Content-Length");
		const e = Number(d[0]);
		if (!Number.isSafeInteger(e) || !l && c.byteLength !== e) throw new Error("in-kernel HTTP response differs from its Content-Length");
	}
	return {
		status: s,
		headers: o,
		body: new Uint8Array(c)
	};
}
function Lr(e, t) {
	const r = e.indexOf(":");
	if (r < 1) throw new Error(`in-kernel HTTP response has a malformed ${t} line`);
	const i = e.slice(0, r);
	if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(i)) throw new Error(`in-kernel HTTP response has a malformed ${t} name`);
	const n = e.slice(r + 1);
	if (/[^\t\x20-\x7e\x80-\xff]/u.test(n)) throw new Error(`in-kernel HTTP response has a malformed ${t} value`);
	return {
		key: i,
		value: n.replace(/^[\t ]*/u, "").replace(/[\t ]*$/u, "")
	};
}
function Br(e, t) {
	for (let r = t; r + 1 < e.length; r++) if (13 === e[r] && 10 === e[r + 1]) return r;
	return -1;
}
function Rr(e) {
	if (0 === e.length) return new Uint8Array(0);
	if (1 === e.length) return e[0];
	const t = e.reduce((e, t) => e + t.length, 0), r = new Uint8Array(t);
	let i = 0;
	for (const n of e) r.set(n, i), i += n.length;
	return r;
}
function Ur(e, t, r = function() {
	let e = 0;
	return "function" == typeof SharedArrayBuffer && (e |= Q.shared_array_buffer), "function" == typeof Atomics.wait && (e |= Q.atomics_wait), "function" == typeof Atomics.waitAsync && (e |= Q.atomics_wait_async), e;
}()) {
	const i = function(e, t) {
		const r = Fr(e, "kernel_host_adapter_manifest_ptr"), i = Fr(e, "kernel_host_adapter_manifest_len"), n = Hr(r(), "kernel_host_adapter_manifest_ptr"), s = Hr(i(), "kernel_host_adapter_manifest_len");
		if (s < 40) throw new Error(`kernel host adapter manifest is too small: ${s} bytes (expected at least 40)`);
		if (n + 40 > t.buffer.byteLength) throw new Error(`kernel host adapter manifest is out of bounds: ptr=${n} size=40 memory=${t.buffer.byteLength}`);
		const o = new DataView(t.buffer, n, 40);
		return {
			magic: Wr(o, "magic"),
			manifestVersion: $r(o, "manifestVersion"),
			manifestSize: $r(o, "manifestSize"),
			abiVersion: Wr(o, "abiVersion"),
			requiredHostAdapterVersion: Wr(o, "requiredHostAdapterVersion"),
			requiredWorkerFeatures: Wr(o, "requiredWorkerFeatures"),
			optionalKernelFeatures: Wr(o, "optionalKernelFeatures"),
			channelHeaderSize: Wr(o, "channelHeaderSize"),
			channelDataOffset: Wr(o, "channelDataOffset"),
			channelDataSize: Wr(o, "channelDataSize"),
			channelMinSize: Wr(o, "channelMinSize")
		};
	}(e, t);
	if (1296781399 !== i.magic) throw new Error(`kernel host adapter manifest has invalid magic: ${i.magic}`);
	if (1 !== i.manifestVersion) throw new Error(`kernel host adapter manifest version ${i.manifestVersion} is not supported by host manifest reader 1`);
	if (40 !== i.manifestSize) throw new Error(`kernel host adapter manifest size ${i.manifestSize} does not match host reader size 40`);
	if (42 !== i.abiVersion) throw new Error(`kernel host adapter manifest ABI version ${i.abiVersion} does not match host ABI version 42`);
	if (i.requiredHostAdapterVersion > 1) throw new Error(`kernel requires host adapter version ${i.requiredHostAdapterVersion}, but this host supports 1`);
	const n = i.requiredWorkerFeatures & ~r;
	if (0 !== n) throw new Error("kernel requires unsupported worker features: " + function(e) {
		const t = [];
		let r = 0;
		for (const [n, s] of Object.entries(Q)) r |= s, 0 !== (e & s) && t.push(n);
		const i = e & ~r;
		0 !== i && t.push(`unknown(0x${i.toString(16)})`);
		return 0 === t.length ? "none" : t.join(", ");
	}(n));
	Dr("channel header size", i.channelHeaderSize, 72), Dr("channel data offset", i.channelDataOffset, 72), Dr("channel data size", i.channelDataSize, re), Dr("channel minimum size", i.channelMinSize, ie);
	for (const s of ee) if ("function" != typeof e.exports[s]) throw new Error(`kernel wasm is missing required host adapter export ${s}`);
	return i;
}
function Fr(e, t) {
	const r = e.exports[t];
	if ("function" != typeof r) throw new Error(`kernel wasm is missing required host adapter export ${t}`);
	return r;
}
function Hr(e, t) {
	const r = "bigint" == typeof e ? Number(e) : e;
	if (!Number.isSafeInteger(r) || r < 0) throw new Error(`${t} returned invalid manifest pointer/length ${String(e)}`);
	return r;
}
function $r(e, t) {
	return e.getUint16(te[t].offset, !0);
}
function Wr(e, t) {
	return e.getUint32(te[t].offset, !0);
}
function Dr(e, t, r) {
	if (t !== r) throw new Error(`kernel host adapter manifest ${e} ${t} does not match generated host ABI value ${r}`);
}
const Or = 67108864, Nr = 1024, Kr = 61440, Vr = Math.ceil(1.0010986328125);
function qr(e, t) {
	let r = 0n, i = 0n, n = t;
	for (;;) {
		if (n >= e.length) throw new Error("truncated wasm LEB128");
		const t = e[n++];
		if (r |= BigInt(127 & t) << i, !(128 & t)) break;
		i += 7n;
	}
	return [r, n - t];
}
function Gr(e, t) {
	const [r, i] = qr(e, t);
	if (r > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`wasm LEB128 value exceeds JS safe integer: ${r}`);
	return [Number(r), i];
}
function jr(e, t) {
	const [r, i] = Gr(e, t);
	let n = t + i;
	const [, s] = qr(e, n);
	if (n += s, 1 & r) {
		const [, t] = qr(e, n);
		n += t;
	}
	return n;
}
function Xr(e, t) {
	if (!Number.isInteger(e) || e < 0) throw new Error(`invalid ${t}: ${e}`);
	return e;
}
function Yr(e, t = 1024) {
	Xr(t, "host default thread slot count");
	const r = e ? function(e) {
		return br(e, "__wasm_posix_thread_slots");
	}(e) : null;
	if (null === r || -1 === r) return t;
	if (!Number.isInteger(r) || r < -1) throw new Error(`invalid process thread slot declaration: ${r}`);
	return Xr(r, "process thread slot declaration");
}
function Zr(e) {
	const t = e.maxPages ?? 16384;
	if (!Number.isInteger(t) || t <= Vr) throw new Error(`invalid process maximum pages: ${t}`);
	const r = e.programBytes ? function(e) {
		const t = new Uint8Array(e);
		if (t.length < 8 || 0 !== t[0] || 97 !== t[1] || 115 !== t[2] || 109 !== t[3]) return null;
		let r = 8;
		for (; r < t.length;) {
			const e = t[r++], [i, n] = Gr(t, r);
			if (r += n, 2 !== e) {
				r += i;
				continue;
			}
			const [s, o] = Gr(t, r);
			r += o;
			for (let a = 0; a < s; a++) {
				const [e, i] = Gr(t, r);
				r += i + e;
				const [n, s] = Gr(t, r);
				r += s + n;
				const o = t[r++];
				if (0 === o) {
					const [, e] = Gr(t, r);
					r += e;
				} else if (1 === o) r += 1, r = jr(t, r);
				else {
					if (2 === o) {
						const [, e] = Gr(t, r);
						r += e;
						const [i] = Gr(t, r);
						return i;
					}
					if (3 === o) r += 2;
					else {
						if (4 !== o) return null;
						{
							r += 1;
							const [, e] = Gr(t, r);
							r += e;
						}
					}
				}
			}
			return null;
		}
		return null;
	}(e.programBytes) ?? 0 : 0, i = Math.max(17, e.minPages ?? 0, r), n = function(e) {
		if (null == e) return null;
		if ("bigint" == typeof e) {
			if (e > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`heap base exceeds JS safe integer: ${e}`);
			return Number(e);
		}
		return e;
	}(e.heapBase), s = (o = Math.max(n ?? 16777216, i * cr), Math.ceil(o / cr) * cr);
	var o;
	const a = s / cr, c = void 0 !== e.threadSlots ? Xr(e.threadSlots, "process thread slot count") : Yr(e.programBytes, e.defaultThreadSlots), l = a + 1, h = l * cr, d = l + Vr, f = d + 2, u = d + (e.preallocateThreadSlots ? 4 * c : 0), p = Math.max(i, u);
	if (p > t) throw new Error(`initial pages ${p} exceed process maximum ${t}`);
	const m = u * cr, g = t * cr;
	return {
		initialPages: p,
		maximumPages: t,
		controlBase: s,
		controlEnd: m,
		channelOffset: h,
		channelPage: l,
		brkBase: m,
		mmapBase: m,
		brkLimit: g,
		maxAddr: g,
		firstThreadSlotPage: d,
		firstThreadBasePage: f,
		threadArenaEndPage: u,
		threadSlotCount: c
	};
}
const Jr = 268435456;
function Qr(e, t) {
	if (!Number.isSafeInteger(e) || e <= 0) throw new Error(`invalid process worker limit: ${e}`);
	if (!Number.isSafeInteger(t) || t <= 0) throw new Error(`invalid process memory admission byte budget: ${t}`);
	return {
		retirementAdmissionMemoryThreshold: Math.max(4, Math.min(32, 2 * e)),
		retirementAdmissionByteThreshold: Math.min(t, Jr)
	};
}
var ei = class extends Error {
	errno = 12;
	requestedBytes;
	chargedBytes;
	maxTotalBytes;
	constructor(e, t, r, i) {
		super(e), this.name = "ProcessMemoryCapacityError", this.requestedBytes = t, this.chargedBytes = r, this.maxTotalBytes = i;
	}
}, ti = class extends Error {
	errno = 11;
	requestedBytes;
	pendingRetiredMemories;
	pendingRetiredBytes;
	retirementAdmissionMemoryThreshold;
	retirementAdmissionByteThreshold;
	constructor(e, t, r, i, n, s) {
		super(e), this.name = "ProcessMemoryRetirementBacklogError", this.requestedBytes = t, this.pendingRetiredMemories = r, this.pendingRetiredBytes = i, this.retirementAdmissionMemoryThreshold = n, this.retirementAdmissionByteThreshold = s;
	}
}, ri = class {
	ptrWidth;
	maximumPages;
	ownedMemory;
	consumeOwnedRecord;
	constructor(e, t, r, i) {
		this.ptrWidth = t, this.maximumPages = r, this.ownedMemory = e, this.consumeOwnedRecord = i;
	}
	get memory() {
		if (!this.ownedMemory) throw new Error("Process memory lease was already consumed");
		return this.ownedMemory;
	}
	release() {
		this.consume("quiescent");
	}
	releaseAfterForcedTermination() {
		this.consume("forced");
	}
	consume(e) {
		const t = this.consumeOwnedRecord;
		if (!t || !this.ownedMemory) throw new Error("Process memory lease was already consumed");
		t(e), this.ownedMemory = void 0, this.consumeOwnedRecord = void 0;
	}
}, ii = class {
	options;
	records = /* @__PURE__ */ new Map();
	recordsByMemory = /* @__PURE__ */ new WeakMap();
	observedTargets = /* @__PURE__ */ new WeakMap();
	retirementRegistry;
	retirementAdmissionMemoryThreshold;
	retirementAdmissionByteThreshold;
	retirementBackpressureMs;
	maxRetirementTelemetryRecords;
	retirementTelemetryOrder = [];
	liveMemories = 0;
	liveBytes = 0;
	retirementBacklogMemories = 0;
	retirementBacklogBytes = 0;
	retirementTelemetryRecords = 0;
	retirementBacklogWaiters = /* @__PURE__ */ new Set();
	nextAllocationId = 1;
	nextTargetId = 1;
	observedRetirements = 0;
	observedFinalizations = 0;
	constructor(e) {
		if (this.options = e, !Number.isSafeInteger(e.maxMemories) || e.maxMemories <= 0) throw new Error(`invalid process memory count budget: ${e.maxMemories}`);
		if (!Number.isSafeInteger(e.maxTotalBytes) || e.maxTotalBytes <= 0) throw new Error(`invalid process memory admission byte budget: ${e.maxTotalBytes}`);
		if (this.retirementAdmissionMemoryThreshold = e.retirementAdmissionMemoryThreshold ?? Math.max(1, Math.min(e.maxMemories, 8)), this.retirementAdmissionByteThreshold = e.retirementAdmissionByteThreshold ?? Math.min(e.maxTotalBytes, Jr), this.retirementBackpressureMs = e.retirementBackpressureMs ?? 50, this.maxRetirementTelemetryRecords = e.maxRetirementTelemetryRecords ?? 256, !Number.isSafeInteger(this.retirementAdmissionMemoryThreshold) || this.retirementAdmissionMemoryThreshold <= 0) throw new Error("invalid process memory retirement count admission threshold: " + this.retirementAdmissionMemoryThreshold);
		if (!Number.isSafeInteger(this.retirementAdmissionByteThreshold) || this.retirementAdmissionByteThreshold <= 0) throw new Error("invalid process memory retirement byte admission threshold: " + this.retirementAdmissionByteThreshold);
		if (!Number.isSafeInteger(this.retirementBackpressureMs) || this.retirementBackpressureMs < 0) throw new Error(`invalid process memory retirement backpressure interval: ${this.retirementBackpressureMs}`);
		if (!Number.isSafeInteger(this.maxRetirementTelemetryRecords) || this.maxRetirementTelemetryRecords < 0) throw new Error(`invalid process memory retirement telemetry bound: ${this.maxRetirementTelemetryRecords}`);
		this.retirementRegistry = "function" == typeof FinalizationRegistry ? new FinalizationRegistry((e) => {
			const t = this.records.get(e.allocationId);
			t?.pendingTargets.delete(e.targetId) && this.finishRetirementIfCollected(t);
		}) : void 0;
	}
	acquire(e) {
		return this.acquireInternal(e, !1);
	}
	async acquireWhenAvailable(e, t = Math.max(250, 4 * this.retirementBackpressureMs)) {
		const r = Date.now() + t;
		for (;;) try {
			return this.acquire(e);
		} catch (i) {
			if (!(i instanceof ti)) throw i;
			const e = r - Date.now();
			if (e <= 0) throw i;
			await this.waitForRetirementBacklogCapacity(i.requestedBytes, e);
		}
	}
	acquireForForkSnapshot(e) {
		return this.acquireInternal(e, !0);
	}
	async waitForRetirementBacklogCapacity(e, t = Math.max(250, 4 * this.retirementBackpressureMs)) {
		if (!Number.isSafeInteger(e) || e <= 0) throw new Error(`invalid process memory retirement admission size: ${e}`);
		if (!Number.isSafeInteger(t) || t < 0) throw new Error(`invalid process memory retirement admission timeout: ${t}`);
		if (!this.retirementBacklogSaturated()) return;
		let r;
		const i = new Promise((e) => {
			r = e, this.retirementBacklogWaiters.add(e);
		});
		let n;
		try {
			await Promise.race([i, new Promise((e) => {
				n = setTimeout(e, t);
			})]);
		} finally {
			this.retirementBacklogWaiters.delete(r), void 0 !== n && clearTimeout(n);
		}
		if (this.retirementBacklogSaturated()) throw this.createRetirementBacklogError(e);
	}
	acquireInternal(e, t) {
		this.validateRequest(e), this.refreshOwnedBytes();
		const r = e.initialPages * cr;
		if (r > this.options.maxTotalBytes) throw new ei(`Process memory request exceeds admission budget ${this.options.maxTotalBytes}`, r, this.liveBytes, this.options.maxTotalBytes);
		this.requireAllocationCapacity(r, t);
		const i = this.createMemory(e), n = {
			allocationId: this.nextAllocationId++,
			memory: i,
			ptrWidth: e.ptrWidth,
			maximumPages: e.maximumPages,
			accountedBytes: i.buffer.byteLength,
			state: "leased",
			retirementBackpressureActive: !1,
			finalizationObserved: !1,
			telemetryQueued: !1,
			pendingTargets: /* @__PURE__ */ new Map()
		};
		return this.records.set(n.allocationId, n), this.recordsByMemory.set(i, n), this.liveMemories += 1, this.liveBytes = this.safeAdd(this.liveBytes, n.accountedBytes), this.observeTargetRecord(n, i), this.observeTargetRecord(n, i.buffer), new ri(i, n.ptrWidth, n.maximumPages, (e) => this.releaseRecord(n, e));
	}
	observeTarget(e, t) {
		const r = this.recordsByMemory.get(e);
		if (!r || "leased" !== r.state) throw new Error("Cannot observe a target for unknown process memory");
		this.observeTargetRecord(r, t);
	}
	clear() {
		for (const e of this.records.values()) {
			if ("leased" === e.state) throw new Error("Cannot clear process memory allocator with leased memory");
			void 0 !== e.retirementBackpressureTimer && clearTimeout(e.retirementBackpressureTimer);
			for (const t of e.pendingTargets.values()) this.retirementRegistry?.unregister(t);
		}
		this.records.clear(), this.retirementTelemetryOrder.length = 0, this.liveMemories = 0, this.liveBytes = 0, this.retirementBacklogMemories = 0, this.retirementBacklogBytes = 0, this.retirementTelemetryRecords = 0, this.notifyRetirementBacklogWaiters();
	}
	getRetirementStats() {
		let e = 0, t = 0;
		for (const r of this.records.values()) "retiring" === r.state && (e += 1, t = this.safeAdd(t, r.accountedBytes));
		return {
			observedRetirements: this.observedRetirements,
			observedFinalizations: this.observedFinalizations,
			liveMemories: this.liveMemories,
			liveBytes: this.liveBytes,
			pendingRetirements: e,
			pendingRetiredBytes: t,
			retirementBacklogMemories: this.retirementBacklogMemories,
			retirementBacklogBytes: this.retirementBacklogBytes,
			chargedMemories: this.liveMemories + this.retirementBacklogMemories,
			chargedBytes: this.safeAdd(this.liveBytes, this.retirementBacklogBytes)
		};
	}
	releaseRecord(e, t) {
		if (this.records.get(e.allocationId) !== e || "leased" !== e.state) throw new Error("Process memory record is not an active lease");
		const r = e.memory;
		if (!r) throw new Error("Process memory record lost its active Memory");
		this.observeTargetRecord(e, r.buffer);
		const i = r.buffer.byteLength;
		if (i < e.accountedBytes) throw new Error("WebAssembly.Memory unexpectedly shrank");
		this.liveBytes = this.safeAdd(this.liveBytes, i - e.accountedBytes), e.accountedBytes = i, this.liveBytes = Math.max(0, this.liveBytes - i), this.liveMemories = Math.max(0, this.liveMemories - 1), this.recordsByMemory.delete(r), e.state = "retiring", e.retirementMode = t, e.retirementBackpressureActive = !0, e.memory = void 0, this.retirementBacklogMemories += 1, this.retirementBacklogBytes = this.safeAdd(this.retirementBacklogBytes, i), this.observedRetirements += 1;
		const n = Object.freeze({
			retirementId: e.allocationId,
			retirementMode: t,
			ptrWidth: e.ptrWidth,
			maximumPages: e.maximumPages,
			byteLength: e.accountedBytes,
			trackedTargets: e.pendingTargets.size
		}), s = e.allocationId;
		e.retirementBackpressureTimer = setTimeout(() => {
			this.releaseRetirementBackpressure(s);
		}, this.retirementBackpressureMs);
		const o = this.options.retirementPressureHook;
		o && setTimeout(() => {
			try {
				o(n);
			} catch {}
		}, 0), this.finishRetirementIfCollected(e);
	}
	requireAllocationCapacity(e, t = !1) {
		if (!t && this.retirementBacklogSaturated()) throw this.createRetirementBacklogError(e);
		if (this.liveMemories >= this.options.maxMemories) throw new ei(`Live process memory object budget ${this.options.maxMemories} is exhausted`, e, this.liveBytes, this.options.maxTotalBytes);
		if (this.liveBytes + e > this.options.maxTotalBytes) throw new ei(`Live process memory admission budget ${this.options.maxTotalBytes} is exhausted`, e, this.liveBytes, this.options.maxTotalBytes);
	}
	retirementBacklogSaturated() {
		return this.retirementBacklogMemories >= this.retirementAdmissionMemoryThreshold || this.retirementBacklogBytes >= this.retirementAdmissionByteThreshold;
	}
	createRetirementBacklogError(e) {
		return new ti("Process memory retirement backlog is temporarily saturated", e, this.retirementBacklogMemories, this.retirementBacklogBytes, this.retirementAdmissionMemoryThreshold, this.retirementAdmissionByteThreshold);
	}
	validateRequest(e) {
		if (4 !== e.ptrWidth && 8 !== e.ptrWidth) throw new Error(`invalid process pointer width: ${e.ptrWidth}`);
		if (!Number.isSafeInteger(e.initialPages) || e.initialPages <= 0 || !Number.isSafeInteger(e.maximumPages) || e.maximumPages < e.initialPages) throw new Error(`invalid process memory pages: ${e.initialPages}/${e.maximumPages}`);
		const t = e.initialPages * cr, r = e.maximumPages * cr;
		if (!Number.isSafeInteger(t) || !Number.isSafeInteger(r)) throw new Error("process memory byte length is not a safe integer");
	}
	createMemory(e) {
		return 8 === e.ptrWidth ? new WebAssembly.Memory({
			initial: BigInt(e.initialPages),
			maximum: BigInt(e.maximumPages),
			shared: !0,
			address: "i64"
		}) : new WebAssembly.Memory({
			initial: e.initialPages,
			maximum: e.maximumPages,
			shared: !0
		});
	}
	refreshOwnedBytes() {
		let e = 0, t = 0;
		for (const r of this.records.values()) {
			if ("leased" !== r.state) continue;
			const i = r.memory;
			if (!i) throw new Error("Live process memory record lost its Memory");
			this.observeTargetRecord(r, i.buffer);
			const n = i.buffer.byteLength;
			if (n < r.accountedBytes) throw new Error("WebAssembly.Memory unexpectedly shrank");
			r.accountedBytes = n, t += 1, e = this.safeAdd(e, n);
		}
		this.liveMemories = t, this.liveBytes = e;
	}
	observeTargetRecord(e, t) {
		if (!this.retirementRegistry) return;
		const r = this.observedTargets.get(t);
		if (r) {
			if (r.allocationId === e.allocationId) return;
			throw new Error("Process memory observation target belongs to another allocation");
		}
		const i = this.nextTargetId++, n = {};
		this.observedTargets.set(t, {
			allocationId: e.allocationId,
			targetId: i
		}), e.pendingTargets.set(i, n), this.retirementRegistry.register(t, {
			allocationId: e.allocationId,
			targetId: i
		}, n);
	}
	finishRetirementIfCollected(e) {
		this.retirementRegistry && "retiring" === e.state && !e.finalizationObserved && 0 === e.pendingTargets.size && (e.finalizationObserved = !0, this.observedFinalizations += 1, e.retirementBackpressureActive || this.removeRetirementRecord(e));
	}
	releaseRetirementBackpressure(e) {
		const t = this.records.get(e);
		t && "retiring" === t.state && t.retirementBackpressureActive && (t.retirementBackpressureTimer = void 0, t.retirementBackpressureActive = !1, this.retirementBacklogMemories = Math.max(0, this.retirementBacklogMemories - 1), this.retirementBacklogBytes = Math.max(0, this.retirementBacklogBytes - t.accountedBytes), this.retirementBacklogSaturated() || this.notifyRetirementBacklogWaiters(), this.retirementRegistry && !t.finalizationObserved ? (t.telemetryQueued = !0, this.retirementTelemetryRecords += 1, this.retirementTelemetryOrder.push(t.allocationId), this.trimRetirementTelemetry()) : this.removeRetirementRecord(t));
	}
	trimRetirementTelemetry() {
		for (; this.retirementTelemetryRecords > this.maxRetirementTelemetryRecords;) {
			const e = this.retirementTelemetryOrder.shift();
			if (void 0 === e) return;
			const t = this.records.get(e);
			t?.telemetryQueued && this.removeRetirementRecord(t);
		}
	}
	removeRetirementRecord(e) {
		if ("retiring" === e.state && !e.retirementBackpressureActive && this.records.delete(e.allocationId)) {
			e.telemetryQueued && (e.telemetryQueued = !1, this.retirementTelemetryRecords = Math.max(0, this.retirementTelemetryRecords - 1));
			for (const t of e.pendingTargets.values()) this.retirementRegistry?.unregister(t);
			e.pendingTargets.clear();
		}
	}
	notifyRetirementBacklogWaiters() {
		for (const e of this.retirementBacklogWaiters) e();
		this.retirementBacklogWaiters.clear();
	}
	safeAdd(e, t) {
		const r = e + t;
		return Number.isSafeInteger(r) ? r : Number.MAX_SAFE_INTEGER;
	}
};
function ni(e, t, r, i) {
	const n = t.buffer.byteLength;
	if (n % cr !== 0) throw new Error(`fork parent memory is not page-aligned: ${n}`);
	const s = e.acquireForForkSnapshot({
		ptrWidth: r,
		initialPages: n / cr,
		maximumPages: i
	});
	try {
		return function(e, t, r = 67108864) {
			if (e.byteLength !== t.byteLength) throw new Error(`process memory copy length mismatch: ${t.byteLength}/${e.byteLength}`);
			if (!Number.isSafeInteger(r) || r <= 0) throw new Error(`invalid process memory copy chunk length: ${r}`);
			for (let i = 0; i < t.byteLength; i += r) {
				const n = Math.min(r, t.byteLength - i);
				new Uint8Array(e, i, n).set(new Uint8Array(t, i, n));
			}
		}(s.memory.buffer, t.buffer), s;
	} catch (o) {
		throw s.release(), o;
	}
}
function si(e, t, r = 4) {
	const i = Math.ceil(t / cr) - Math.ceil(e.buffer.byteLength / cr);
	i <= 0 || (8 === r ? e.grow(BigInt(i)) : e.grow(i));
}
function oi(e, t, r) {
	const i = new DataView(e.buffer), n = 8 === r ? Number(i.getBigUint64(t, !0)) : i.getUint32(t, !0), s = function(e) {
		return Z.find(({ bytes: t }) => t === e);
	}(r);
	if (!s) throw new Error(`unsupported fork continuation pointer width ${r}`);
	const o = n - s.chunkHeaderSize;
	if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(o) || o <= 0 || o % cr !== 0 || o + cr > e.buffer.byteLength) throw new Error(`invalid fork continuation anchor ${String(n)}`);
	return n;
}
function ai(e, t, r) {
	if (!Number.isInteger(t) || t < -2147483648 || t > r) throw new Error(`${e} returned an invalid byte count ${String(t)} for a ${r}-byte buffer`);
	return t;
}
function ci(e, t, r, i, n = !1) {
	return !n && e.get(t) === r && r.memory === i;
}
const li = 11, hi = 14, di = 22, fi = 2147483647;
var ui = class extends Error {
	pid;
	tid;
	errno;
	constructor(e, t, r, i) {
		super(i ?? `Kernel rejected tid ${t} for process ${e}: errno ${r}`), this.pid = e, this.tid = t, this.errno = r, this.name = "KernelTaskBindingError";
	}
};
function pi(e, t, r) {
	if (!Number.isSafeInteger(t) || t <= 0 || t >= e.length) return { errno: hi };
	if (r <= 0) return { errno: 36 };
	const i = e.length - t, n = Math.min(i, r), s = e.subarray(t, t + n).indexOf(0);
	return s >= 0 ? { size: s + 1 } : { errno: i < r ? hi : 36 };
}
function mi(e, t, r) {
	return Number.isSafeInteger(t) && t > 0 && Number.isSafeInteger(r) && r >= 0 && t <= e.length - r;
}
const gi = 4194304, yi = 4096, wi = Ce, bi = Oe, Si = ot, _i = dt, ki = Fe, vi = bt, Ai = St, Ii = it, Pi = wt, Ei = gt, Ci = Tt, xi = yt, zi = Lt, Mi = pt, Ti = mt, Li = Ee, Bi = ut, Ri = ae, Ui = de, Fi = ce, Hi = le, $i = he, Wi = ft, Di = Pe, Oi = Rt, Ni = Je, Ki = Qe, Vi = ht, qi = kt, Gi = Ut, ji = 16, Xi = [{
	name: "lo",
	index: 1,
	loopback: !0
}, {
	name: "eth0",
	index: 2,
	loopback: !1
}], Yi = Ke, Zi = xe, Ji = ze, Qi = Te, en = Me, tn = at, rn = _t, nn = me, sn = pe, on = We, an = De, cn = Ge, ln = Ze, hn = qe, dn = Ye, fn = Pt, un = vt, pn = ye, mn = we, gn = Ve, yn = Re, wn = Ue, bn = He, Sn = $e, _n = ct, kn = lt, vn = Le, An = Bt, In = Be, Pn = 4096, En = -100;
function Cn(e) {
	return Math.ceil(e / cr) * cr;
}
const xn = je, zn = Xe, Mn = At, Tn = It, Ln = be, Bn = xt, Rn = zt, Un = Mt, Fn = Et, Hn = Ct, $n = fe, Wn = Ne, Dn = ue, On = st, Nn = "undefined" != typeof process && !!{}.WASM_POSIX_PROFILE, Kn = new Set([
	pe,
	Ue,
	$e,
	We,
	Xe,
	lt
]), Vn = new Set([
	me,
	Re,
	He,
	De,
	je,
	ct,
	vt
]);
const qn = ie;
const Gn = {
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
	238: "sched_getaffinity",
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
	299: "lchown",
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
}, jn = {
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
	114: "EALREADY",
	115: "EINPROGRESS"
}, Xn = {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe"
}, Yn = {
	stdin: "terminal",
	stdout: "terminal",
	stderr: "terminal"
};
function Zn(e) {
	switch (e) {
		case "pipe": return 0;
		case "terminal": return 1;
	}
}
const Jn = Symbol("ThreadChannelAttachment"), Qn = /* @__PURE__ */ new WeakMap();
var es = class {
	config;
	io;
	callbacks;
	kernel;
	kernelInstance = null;
	kernelMemory = null;
	kernelAbiVersion = 0;
	processes = /* @__PURE__ */ new Map();
	activeChannels = [];
	retiredChannelListeners = /* @__PURE__ */ new Set();
	pendingChannelListenerCounts = /* @__PURE__ */ new Map();
	retiredChannelSettlements = /* @__PURE__ */ new Map();
	execHandoffPids = /* @__PURE__ */ new Set();
	scratchOffset = 0;
	largeSpawnScratchOffset = 0;
	initialized = !1;
	channelTids = /* @__PURE__ */ new Map();
	threadForkContexts = /* @__PURE__ */ new Map();
	currentHandlePid = 0;
	bindKernelTidForChannel(e) {
		const t = this.channelTids.get(`${e.pid}:${e.channelOffset}`);
		if (void 0 === t) {
			if (!this.isMainProcessChannel(e)) throw this.missingChannelTidError(e);
			this.bindKernelTid(e.pid, e.pid);
		} else this.bindKernelTid(e.pid, t);
	}
	bindKernelTid(e, t) {
		const r = this.kernelInstance?.exports.kernel_set_current_tid;
		if (!r) throw new Error("Kernel missing kernel_set_current_tid export");
		const i = r(e, t);
		if (i < 0) throw new ui(e, t, -i);
	}
	validateKernelTid(e, t) {
		const r = this.kernelInstance?.exports.kernel_validate_task;
		if (!r) throw new Error("Kernel missing kernel_validate_task export");
		const i = r(e, t);
		if (i < 0) throw new ui(e, t, -i);
	}
	guestTidForChannel(e) {
		const t = this.channelTids.get(`${e.pid}:${e.channelOffset}`);
		if (void 0 !== t) return t;
		if (this.isMainProcessChannel(e)) return e.pid;
		throw this.missingChannelTidError(e);
	}
	isMainProcessChannel(e) {
		return this.processes.get(e.pid)?.channels[0] === e;
	}
	missingChannelTidError(e) {
		return new ui(e.pid, void 0, 3, `No kernel-validated TID for non-main channel ${e.channelOffset} of process ${e.pid}`);
	}
	alarmTimers = /* @__PURE__ */ new Map();
	posixTimers = /* @__PURE__ */ new Map();
	pendingSleeps = /* @__PURE__ */ new Map();
	pendingSignalWaits = /* @__PURE__ */ new Map();
	signalWaitDeadlines = /* @__PURE__ */ new Map();
	threadCtidPtrs = /* @__PURE__ */ new Map();
	tcpListeners = /* @__PURE__ */ new Map();
	tcpListenerTargets = /* @__PURE__ */ new Map();
	tcpListenerRRIndex = /* @__PURE__ */ new Map();
	tcpVirtualListenerKeys = /* @__PURE__ */ new Map();
	udpBindings = /* @__PURE__ */ new Set();
	tcpScratchOffset = 0;
	netModule = null;
	waitingForChild = [];
	stoppedPids = /* @__PURE__ */ new Set();
	pendingResumePids = /* @__PURE__ */ new Set();
	parkedChannelCompletions = /* @__PURE__ */ new Map();
	resumePreparedSignals = /* @__PURE__ */ new WeakSet();
	deferredStoppedChannels = /* @__PURE__ */ new Map();
	deferredProcessWorkerStarts = /* @__PURE__ */ new Map();
	cachedKernelMem = null;
	cachedKernelBuffer = null;
	pendingPollRetries = /* @__PURE__ */ new Map();
	pendingAdvisoryLockRetries = /* @__PURE__ */ new Map();
	pendingSelectRetries = /* @__PURE__ */ new Map();
	wakeScheduled = !1;
	pendingPipeReaders = /* @__PURE__ */ new Map();
	pendingPipeWriters = /* @__PURE__ */ new Map();
	socketTimeoutTimers = /* @__PURE__ */ new Map();
	pendingFutexWaits = /* @__PURE__ */ new Map();
	pendingCancels = /* @__PURE__ */ new Set();
	profileData = Nn ? /* @__PURE__ */ new Map() : null;
	stdinBuffers = /* @__PURE__ */ new Map();
	stdinFinite = /* @__PURE__ */ new Set();
	tcpConnections = /* @__PURE__ */ new Map();
	sharedMappings = /* @__PURE__ */ new Map();
	anonymousSharedBackings = /* @__PURE__ */ new Map();
	nextAnonymousSharedBackingId = 1;
	sharedMmapBackings = /* @__PURE__ */ new Map();
	sharedMemoryReleasePids = /* @__PURE__ */ new Set();
	sharedMmapFdCache = /* @__PURE__ */ new Map();
	epollInterests = /* @__PURE__ */ new Map();
	shmMappings = /* @__PURE__ */ new Map();
	shmSegmentVersions = /* @__PURE__ */ new Map();
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
	constructor(e, t, r = {}) {
		if (this.config = e, this.io = t, this.callbacks = r, this.kernel = new Cr(e, t, {
			getProcessMemory: (e) => this.processes.get(e)?.memory,
			onProcessMemoryTarget: (e, t) => {
				this.callbacks.onProcessMemoryTarget?.(e, t);
			},
			getKmsCanvas: (e) => this.kmsCanvases.get(e),
			markKmsCanvasGlOwned: (e) => {
				this.kmsContextMode.set(e, "webgl2");
			},
			onStdin: (e) => {
				const t = this.currentHandlePid, r = this.stdinBuffers.get(t);
				if (!r) return this.stdinFinite.has(t) ? null : new Uint8Array(0);
				const i = r.data.length - r.offset;
				if (i <= 0) return this.stdinBuffers.delete(t), this.stdinFinite.has(t) ? null : new Uint8Array(0);
				const n = Math.min(i, e), s = r.data.subarray(r.offset, r.offset + n);
				return r.offset += n, r.offset >= r.data.length && this.stdinBuffers.delete(t), s;
			},
			onAlarm: (e) => {
				const t = this.currentHandlePid;
				if (0 === t) return 0;
				const r = this.alarmTimers.get(t);
				if (r && (clearTimeout(r), this.alarmTimers.delete(t)), e > 0) {
					const r = setTimeout(() => {
						this.alarmTimers.delete(t), this.sendSignalToProcess(t, 14);
					}, 1e3 * e);
					this.alarmTimers.set(t, r);
				}
				return 0;
			},
			onNetListen: (e, t, r) => {
				const i = this.currentHandlePid;
				return 0 === i || this.startTcpListener(i, e, t, r), 0;
			},
			onUdpBind: (e, t, r) => {
				const i = this.currentHandlePid;
				if (0 === i || !this.io.network?.bindUdp) return 0;
				const n = `${i}:${e}`, s = this.io.network.bindUdp(n, new Uint8Array(t), r, { receive: (e) => this.injectUdpDatagram(i, e) });
				return 0 === s && this.udpBindings.add(n), 0 === s ? 0 : -s;
			},
			onUdpUnbind: (e) => {
				const t = this.currentHandlePid;
				if (0 === t || !this.io.network?.unbindUdp) return 0;
				const r = `${t}:${e}`;
				return this.io.network.unbindUdp(r), this.udpBindings.delete(r), 0;
			},
			onPosixTimer: (e, t, r, i) => {
				const n = this.currentHandlePid;
				if (0 === n) return 0;
				const s = `${n}:${e}`, o = this.posixTimers.get(s);
				if (o && (clearTimeout(o.timeout), o.interval && clearInterval(o.interval), this.posixTimers.delete(s)), r > 0 || i > 0) {
					const o = setTimeout(() => {
						const r = this.posixTimers.get(s);
						if (r && r.timeout === o) if (this.processes.has(n)) if (this.firePosixTimer(n, e, t), i > 0) {
							const r = setInterval(() => {
								const i = this.posixTimers.get(s);
								if (i && i.interval === r) return this.processes.has(n) ? void this.firePosixTimer(n, e, t) : (clearInterval(r), void this.posixTimers.delete(s));
								clearInterval(r);
							}, i), a = this.posixTimers.get(s);
							a?.timeout === o ? a.interval = r : clearInterval(r);
						} else this.posixTimers.delete(s);
						else this.posixTimers.delete(s);
					}, Math.max(0, r));
					this.posixTimers.set(s, {
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
		const t = this.kernelInstance.exports[Y];
		if ("function" != typeof t) throw new Error(`kernel wasm is missing the ${Y} export — refusing to run. Rebuild the kernel (bash build.sh) against the current ABI.`);
		this.kernelAbiVersion = t(), Ur(this.kernelInstance, this.kernelMemory);
		const r = this.kernelInstance.exports.kernel_alloc_scratch;
		if (this.scratchOffset = Number(r(qn)), 0 === this.scratchOffset) throw new Error("Failed to allocate kernel scratch buffer");
		try {
			const e = await import("./__vite-browser-external-FmLWTtdE.js").then((e) => o(e.default, 1));
			"function" == typeof e.createServer && (this.netModule = e);
		} catch {}
		if (this.tcpScratchOffset = Number(r(65536)), 0 === this.tcpScratchOffset) throw new Error("Failed to allocate TCP scratch buffer");
		this.initialized = !0;
	}
	createProcess(e) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		const t = this.kernelInstance.exports.kernel_create_process_with_stdio;
		if (!t) throw new Error("Kernel missing kernel_create_process_with_stdio export");
		const r = t(Zn(e.stdin), Zn(e.stdout), Zn(e.stderr));
		if (r <= 0) throw new Error("Failed to create process: errno " + -r);
		return r;
	}
	registerProcess(e, t, r, i) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		if (!Number.isSafeInteger(e) || e <= 0 || e > fi) throw new Error(`Cannot register invalid kernel process ID ${e}`);
		if (1 !== r.length) throw new Error(`Process ${e} must register exactly one main syscall channel`);
		const n = this.kernelInstance.exports.kernel_get_process_state, s = n?.(e);
		if (void 0 === s || s < 0) throw new Error(`Cannot register unknown kernel process ${e}`);
		if (0 !== s && 1 !== s) throw new Error(`Cannot register inactive kernel process ${e}`);
		if (1 === e) throw new Error("Cannot register the kernel-reserved init process");
		const o = this.processes.get(e), a = !0 === i?.preserveProcessState && !0 === this.execHandoffPids?.has(e) && 0 === o?.channels.length;
		if (o && !a) throw new Error(`Process ${e} is already registered with the host`);
		if (this.discardStoppedChannelStateForProcess(e, !i?.preserveProcessState), void 0 !== i?.argv || void 0 !== i?.env) {
			const e = this.validateExecMetadata(i.argv ?? [], i.env ?? [], i.metadataPtrWidth ?? i.ptrWidth ?? 4);
			if (e < 0) throw new Error("Process argv/environment exceeds exec metadata limits: errno " + -e);
		}
		if (this.hostReaped.delete(e), void 0 !== i?.brkBase && !this.setBrkBase(e, i.brkBase)) throw new Error("Kernel export kernel_set_brk_base is required for compact process memory layout");
		void 0 !== i?.argv && this.replaceProcessMetadata(e, 0, i.argv), void 0 !== i?.env && this.replaceProcessMetadata(e, 1, i.env);
		const c = this.kernelInstance.exports.kernel_set_max_addr;
		if (c) {
			const t = i?.maxAddr ?? (r.length > 0 ? Math.min(...r) : void 0);
			void 0 !== t && c(e, this.toKernelPtr(t));
		}
		if (void 0 !== i?.mmapBase && !this.setMmapBase(e, i.mmapBase)) throw new Error("Kernel export kernel_set_mmap_base is required for compact process memory layout");
		if (void 0 !== i?.brkLimit && !this.setBrkLimit(e, i.brkLimit)) throw new Error("Kernel export kernel_set_brk_limit is required for legacy low-control layout");
		const l = r.map((r) => ({
			pid: e,
			memory: t,
			channelOffset: r,
			i32View: new Int32Array(t.buffer, r),
			consecutiveSyscalls: 0
		})), h = {
			pid: e,
			memory: t,
			channels: l,
			ptrWidth: i?.ptrWidth ?? 4,
			explicitMaxAddr: void 0 !== i?.maxAddr
		};
		this.processes.set(e, h), this.activeChannels.push(...l), this.observeProcessMemoryTarget(t, t), this.observeProcessMemoryTarget(t, t.buffer), this.observeProcessMemoryTarget(t, h);
		for (const d of l) this.observeProcessMemoryTarget(t, d), this.observeProcessMemoryTarget(t, d.i32View);
		if (this.usePolling) this.startPolling();
		else for (const d of l) this.listenOnChannel(d);
	}
	validateExecMetadata(e, t, r = 4) {
		const i = new TextEncoder();
		let n = 2 * r;
		for (const s of [...e, ...t]) {
			const e = i.encode(s).byteLength;
			if (e > 65536) return -7;
			if (n += r + e + 1, !Number.isSafeInteger(n) || n > gi) return -7;
		}
		return 0;
	}
	supportsExecMetadataReplacement() {
		const e = this.kernelInstance?.exports;
		return "function" == typeof e?.kernel_clear_process_metadata && "function" == typeof e?.kernel_push_process_metadata_entry;
	}
	replaceProcessMetadata(e, t, r) {
		const i = this.kernelInstance.exports.kernel_clear_process_metadata, n = this.kernelInstance.exports.kernel_push_process_metadata_entry;
		if (!i || !n) {
			const i = this.kernelInstance.exports.kernel_set_process_argv;
			if (0 !== t || !i) throw new Error("Kernel missing bounded process metadata exports");
			const n = new TextEncoder().encode(r.join("\0"));
			if (n.byteLength > 65536) throw new Error("Legacy process argv exceeds bounded scratch transport: errno 7");
			new Uint8Array(this.kernelMemory.buffer).set(n, this.scratchOffset);
			const s = i(e, this.toKernelPtr(this.scratchOffset), n.byteLength);
			if (s < 0) throw new Error(`Failed to replace process argv for pid ${e}: errno ${-s}`);
			return;
		}
		const s = i(e, t);
		if (s < 0) throw new Error(`Failed to clear process metadata for pid ${e}: errno ${-s}`);
		const o = new TextEncoder();
		for (const a of r) {
			const r = o.encode(a);
			if (r.byteLength > 65536) throw new Error("Process metadata entry exceeds bounded scratch transport: errno 7");
			new Uint8Array(this.kernelMemory.buffer).set(r, this.scratchOffset);
			const i = n(e, t, this.toKernelPtr(this.scratchOffset), r.byteLength);
			if (i < 0) throw new Error(`Failed to append process metadata for pid ${e}: errno ${-i}`);
		}
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
		const r = this.stdinBuffers.get(e);
		if (r) {
			const i = r.data.subarray(r.offset), n = new Uint8Array(i.length + t.length);
			n.set(i), n.set(t, i.length), this.stdinBuffers.set(e, {
				data: n,
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
		const r = t(e);
		if (r < 0) throw new Error("kernel_pty_create failed: errno " + -r);
		return this.ptyIndexByPid.set(e, r), this.activePtyIndices.add(r), r;
	}
	ptyMasterWrite(e, t) {
		const r = this.kernelInstance.exports.kernel_pty_master_write;
		r && (new Uint8Array(this.kernelMemory.buffer).set(t, this.scratchOffset), r(e, this.toKernelPtr(this.scratchOffset), t.length), this.drainPtyOutput(e), this.scheduleWakeBlockedRetries());
	}
	ptyMasterRead(e) {
		const t = this.kernelInstance.exports.kernel_pty_master_read;
		if (!t) return null;
		const r = t(e, this.toKernelPtr(this.scratchOffset), 4096);
		return r <= 0 ? null : new Uint8Array(this.kernelMemory.buffer).slice(this.scratchOffset, this.scratchOffset + r);
	}
	ptySetWinsize(e, t, r) {
		const i = this.kernelInstance.exports.kernel_pty_set_winsize;
		if (!i) return;
		i(e, t, r), this.scheduleWakeBlockedRetries();
		for (const [n, s] of Array.from(this.pendingSleeps.entries())) this.isRegisteredChannel(s.channel) && (this.dequeueSignalForDelivery(s.channel), this.finishSignalTermination(s.channel) || new DataView(s.channel.memory.buffer, s.channel.channelOffset).getUint32(65560, !0) > 0 && (clearTimeout(s.timer), this.pendingSleeps.delete(n), this.completeChannel(s.channel, s.syscallNr, s.origArgs, ar[s.syscallNr], -1, 4)));
	}
	onPtyOutput(e, t) {
		this.ptyOutputCallbacks.set(e, t), this.drainPtyOutput(e);
	}
	drainPtyOutput(e) {
		const t = this.ptyOutputCallbacks.get(e);
		if (t) for (;;) {
			const r = this.ptyMasterRead(e);
			if (!r) break;
			t(r);
		}
	}
	drainAllPtyOutputs() {
		if (0 !== this.activePtyIndices.size) for (const e of this.activePtyIndices) this.drainPtyOutput(e);
	}
	setCwd(e, t) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		const r = this.kernelInstance.exports.kernel_set_cwd;
		if (!r) return;
		const i = new TextEncoder().encode(t);
		new Uint8Array(this.kernelMemory.buffer).set(i, this.scratchOffset);
		const n = r(e, this.toKernelPtr(this.scratchOffset), i.length);
		if (n < 0) throw new Error(`setCwd failed for pid ${e}: errno ${-n}`);
	}
	setCredentials(e, t) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		if (null == t.uid && null == t.gid) return;
		const r = 4294967295, i = this.kernelInstance.exports.kernel_set_process_credentials;
		if (!i) throw new Error("Kernel missing kernel_set_process_credentials export");
		const n = i(e, t.uid ?? r, t.gid ?? r);
		if (n < 0) throw new Error(`setCredentials failed for pid ${e}: errno ${-n}`);
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
		const t = e(this.toKernelPtr(this.scratchOffset), qn);
		if (t <= 0) return [];
		const r = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, t), i = new Uint8Array(t);
		i.set(r);
		const n = function(e) {
			if (e.byteLength < 4) return [];
			const t = new DataView(e.buffer, e.byteOffset, e.byteLength), r = t.getUint32(0, !0);
			let i = 4;
			const n = [], s = new TextDecoder("utf-8", { fatal: !1 });
			for (let o = 0; o < r && !(i + 36 > e.byteLength); o++) {
				const r = t.getUint32(i, !0);
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
				const u = s.decode(e.subarray(i, i + d));
				i += d;
				const p = e.subarray(i, i + f);
				i += f;
				const m = s.decode(p).replace(/\0/g, " ").trimEnd();
				n.push({
					pid: r,
					ppid: o,
					uid: a,
					gid: c,
					vsizeBytes: l,
					state: h,
					comm: u,
					cmdline: m || `[${u}]`
				});
			}
			return n;
		}(i);
		for (const s of n) {
			const e = this.processes.get(s.pid);
			e && (s.memoryBytes = e.memory.buffer.byteLength);
		}
		return n;
	}
	readProcMaps(e) {
		if (!this.initialized) return null;
		const t = this.kernelInstance.exports.kernel_read_proc_maps;
		if (!t) return null;
		const r = t(e, this.toKernelPtr(this.scratchOffset), qn);
		if (r < 0) return null;
		if (0 === r) return "";
		const i = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, r), n = new Uint8Array(r);
		return n.set(i), new TextDecoder("utf-8", { fatal: !1 }).decode(n);
	}
	unregisterProcess(e, t) {
		const r = this.processes.get(e);
		if (!r) return !0;
		if (t && r.memory !== t) return !1;
		this.retireAsyncChannelsForProcess(e), this.discardStoppedChannelStateForProcess(e), this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.parentPid !== e && t.channel.pid !== e), this.releaseAllSharedMemoryForProcess(e), this.releaseProcessViews(e, r.memory), this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.clearProcessThreadTransportState(e), this.cleanupUdpBindings(e), this.cleanupTcpListeners(e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingSignalWaits(e), this.cleanupPendingPipeReaders(e), this.cleanupPendingPipeWriters(e), this.cancelPendingSleepsForProcess(e);
		for (const [n, s] of this.socketTimeoutTimers) n.pid === e && (clearTimeout(s), this.socketTimeoutTimers.delete(n));
		for (const n of this.epollInterests.keys()) n.startsWith(`${e}:`) && this.epollInterests.delete(n);
		this.removeFromKernelProcessTable(e), this.processes.delete(e), this.execHandoffPids?.delete(e), this.stdinFinite.delete(e), this.stdinBuffers.delete(e), this.usePolling && 0 === this.processes.size && this.stopPolling();
		const i = this.ptyIndexByPid.get(e);
		return void 0 !== i && (this.ptyIndexByPid.delete(e), this.activePtyIndices.delete(i), this.ptyOutputCallbacks.delete(i)), !0;
	}
	removeProcessFromKernelTable(e) {
		if (!this.initialized) throw new Error("Kernel is not initialized for process removal");
		this.removeFromKernelProcessTable(e);
	}
	cancelPendingSleepsForProcess(e) {
		for (const [t, r] of this.pendingSleeps) t.pid === e && (clearTimeout(r.timer), this.pendingSleeps.delete(t));
	}
	deactivateProcess(e, t) {
		const r = this.processes.get(e);
		if (!r) return !0;
		if (t && r.memory !== t) return !1;
		this.retireAsyncChannelsForProcess(e), this.discardStoppedChannelStateForProcess(e), this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.parentPid !== e && t.channel.pid !== e), this.releaseAllSharedMemoryForProcess(e), r && this.releaseProcessViews(e, r.memory), this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.clearProcessThreadTransportState(e), this.processes.delete(e), this.execHandoffPids?.delete(e), this.stdinFinite.delete(e), this.stdinBuffers.delete(e);
		const i = this.alarmTimers.get(e);
		i && (clearTimeout(i), this.alarmTimers.delete(e));
		for (const [n, s] of this.posixTimers) n.startsWith(`${e}:`) && (clearTimeout(s.timeout), s.interval && clearInterval(s.interval), this.posixTimers.delete(n));
		return this.cancelPendingSleepsForProcess(e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingSignalWaits(e), this.cleanupUdpBindings(e), this.cleanupTcpListeners(e), this.hostReaped.delete(e), !0;
	}
	releaseProcessViews(e, t) {
		const r = this.processes.get(e);
		return !(!r || r.memory !== t) && (this.kernel.releaseProcessViews(e), !0);
	}
	kernelExecPrepare(e, t) {
		const r = this.kernelInstance.exports.kernel_exec_prepare;
		if (!r) throw new Error("Kernel missing required kernel_exec_prepare export");
		const i = this.currentHandlePid;
		this.currentHandlePid = e;
		try {
			return r(e, t);
		} finally {
			this.currentHandlePid = i, this.drainAndProcessWakeupEvents();
		}
	}
	kernelExecSetup(e, t) {
		const r = this.kernelInstance.exports.kernel_exec_setup_for_thread;
		if (!r) throw new Error("Kernel missing required kernel_exec_setup_for_thread export");
		const i = this.currentHandlePid;
		this.currentHandlePid = e;
		try {
			const i = this.snapshotExecTcpListenerWakeIds(e), n = r(e, t);
			return 0 === n && this.pruneExecFdMirrors(e, i), n;
		} finally {
			this.currentHandlePid = i, this.drainAndProcessWakeupEvents();
		}
	}
	snapshotExecTcpListenerWakeIds(e) {
		const t = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx, r = /* @__PURE__ */ new Map();
		if (!t) return r;
		const i = (i, n, s) => {
			const o = s ?? t(e, n);
			o >= 0 && r.set(`${i}:${n}`, o);
		};
		for (const [s, o] of this.tcpListenerTargets) for (const t of o) t.pid === e && i(s, t.fd, t.acceptWakeIdx);
		const n = `${e}:`;
		for (const [s, o] of this.tcpListeners) {
			if (!s.startsWith(n)) continue;
			const t = Number(s.slice(n.length)), r = this.tcpListenerTargets.get(o.port)?.find((r) => r.pid === e && r.fd === t);
			i(o.port, t, r?.acceptWakeIdx);
		}
		return r;
	}
	resolveInheritedListenerFd(e, t, r) {
		const i = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		if (!i) return {
			fd: t,
			...void 0 !== r ? { acceptWakeIdx: r } : {}
		};
		const n = i(e, t);
		if (void 0 === r) return n >= 0 ? {
			fd: t,
			acceptWakeIdx: n
		} : null;
		if (n === r) return {
			fd: t,
			acceptWakeIdx: r
		};
		const s = this.kernelInstance.exports.kernel_find_listener_fd_by_accept_wake;
		let o = s?.(e, r) ?? -1;
		if (!s) {
			for (let a = 0; a < 1024; a++) if (i(e, a) === r) {
				o = a;
				break;
			}
		}
		return o >= 0 ? {
			fd: o,
			acceptWakeIdx: r
		} : null;
	}
	inheritHostFdMirrors(e, t, r = !0) {
		const i = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		for (const [, s] of this.tcpListenerTargets) for (const r of s.filter((t) => t.pid === e)) {
			const n = r.acceptWakeIdx ?? (() => {
				const t = i?.(e, r.fd) ?? -1;
				return t >= 0 ? t : void 0;
			})(), o = this.resolveInheritedListenerFd(t, r.fd, n);
			o && !s.some((e) => e.pid === t && e.fd === o.fd) && s.push({
				pid: t,
				...o
			});
		}
		if (!r) return;
		const n = this.kernelInstance.exports.kernel_fd_is_open;
		for (const [s, o] of Array.from(this.epollInterests.entries())) {
			if (!s.startsWith(`${e}:`)) continue;
			const r = Number(s.slice(s.indexOf(":") + 1));
			n && 1 !== n(t, r) || this.epollInterests.set(`${t}:${r}`, o.filter((e) => !n || 1 === n(t, e.fd)).map((e) => ({ ...e })));
		}
	}
	rollbackChildHostRegistration(e) {
		this.deactivateProcess(e);
		for (const t of Array.from(this.epollInterests.keys())) t.startsWith(`${e}:`) && this.epollInterests.delete(t);
	}
	pruneExecFdMirrors(e, t) {
		const r = this.kernelInstance.exports.kernel_fd_is_open;
		if (!r) return;
		const i = (t) => 1 === r(e, t), n = `${e}:`, s = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx, o = this.kernelInstance.exports.kernel_find_listener_fd_by_accept_wake, a = /* @__PURE__ */ new Map(), c = (r, n) => {
			const c = t.get(`${r}:${n}`);
			if (void 0 === c || !s) return i(n) ? n : null;
			if (s(e, n) === c) return n;
			if (a.has(c)) return a.get(c);
			let l = o?.(e, c) ?? -1;
			if (!o) {
				for (let t = 0; t < 1024; t++) if (s(e, t) === c) {
					l = t;
					break;
				}
			}
			const h = l >= 0 ? l : null;
			return a.set(c, h), h;
		};
		for (const [h, d] of Array.from(this.epollInterests.entries())) h.startsWith(n) && (i(Number(h.slice(n.length))) ? this.epollInterests.set(h, d.filter((e) => i(e.fd))) : this.epollInterests.delete(h));
		for (const [h, d] of Array.from(this.tcpListenerTargets.entries())) {
			const t = [];
			for (const r of d) {
				if (r.pid !== e) {
					t.push(r);
					continue;
				}
				const i = c(h, r.fd);
				null === i || t.some((t) => t.pid === e && t.fd === i) || t.push({
					...r,
					pid: e,
					fd: i
				});
			}
			if (0 === t.length) {
				this.tcpListenerTargets.delete(h), this.tcpListenerRRIndex.delete(h);
				const e = this.tcpVirtualListenerKeys.get(h);
				e && (this.io.network?.closeTcpListener?.(e), this.tcpVirtualListenerKeys.delete(h));
			} else {
				this.tcpListenerTargets.set(h, t);
				const e = this.tcpListenerRRIndex.get(h) ?? 0;
				this.tcpListenerRRIndex.set(h, e % t.length);
			}
		}
		const l = /* @__PURE__ */ new Map();
		for (const [h, d] of Array.from(this.tcpListeners.entries())) {
			if (!h.startsWith(n)) continue;
			const t = Number(h.slice(n.length)), r = c(d.port, t);
			if (r !== t) if (this.tcpListeners.delete(h), null === r) l.set(d.port, d);
			else {
				const t = `${e}:${r}`;
				this.tcpListeners.has(t) || this.tcpListeners.set(t, {
					...d,
					pid: e
				});
			}
		}
		for (const [h, d] of l) {
			const e = this.tcpListenerTargets.get(h);
			if (e && 0 !== e.length) {
				const t = e[0], r = `${t.pid}:${t.fd}`;
				this.tcpListeners.has(r) || this.tcpListeners.set(r, {
					...d,
					pid: t.pid
				});
			} else {
				d.server.close();
				const e = this.tcpVirtualListenerKeys.get(h);
				e && (this.io.network?.closeTcpListener?.(e), this.tcpVirtualListenerKeys.delete(h));
			}
		}
	}
	fdSupportsMmapWriteback(e, t) {
		const r = this.kernelInstance.exports.kernel_fd_supports_mmap_writeback;
		return !r || 1 === r(e, t);
	}
	prepareAddressSpaceForExec(e) {
		const t = this.processes.get(e)?.channels[0];
		if (!t) {
			const t = (this.sharedMappings.get(e)?.size ?? 0) > 0, r = (this.shmMappings.get(e)?.size ?? 0) > 0;
			return t || r ? -5 : 0;
		}
		try {
			this.syncAnonymousSharedMappingsFromProcess(t, { force: !0 }), this.syncFileSharedMappingsFromProcess(t, { force: !0 });
			const r = this.sharedMappings.get(e);
			if (r) {
				for (const [e, i] of r) if (i.writable) {
					if ("file" === i.backingKind && i.backingKey) {
						const e = this.sharedMmapBackings.get(i.backingKey);
						if (e && !this.flushSharedMmapBackingRange(e, i.fileOffset, i.len)) return -5;
						continue;
					}
					if (!i.backingKey && !this.pwriteFromProcessMemory(t, i.fd, e, i.len, i.fileOffset)) return -5;
				}
			}
			return this.syncSysvShmMappingsFromProcess(t, { force: !0 }) ? 0 : -5;
		} catch {
			return -5;
		}
	}
	finalizeAddressSpaceForExec(e) {
		const t = this.sharedMappings.get(e);
		if (t) {
			for (const e of t.values()) this.releaseSharedMapping(e);
			this.sharedMappings.delete(e);
		}
		this.invalidateSharedMmapFdCacheForPid(e);
		const r = this.shmMappings.get(e);
		if (!r) return 0;
		const i = this.kernelInstance.exports.kernel_ipc_shmdt_for_process;
		let n = 0;
		try {
			if (!i) return -5;
			for (const t of r.values()) i(e, t.segId) < 0 && (n = -5);
		} catch {
			n = -5;
		} finally {
			this.shmMappings.delete(e);
		}
		return n;
	}
	prepareProcessForExec(e, t) {
		const r = this.processes.get(e);
		if (t && (!r || r.memory !== t)) return !1;
		r && this.releaseProcessViews(e, r.memory), (this.execHandoffPids ??= /* @__PURE__ */ new Set()).add(e);
		for (const i of r?.channels ?? []) this.retireChannelListener(i);
		for (const i of this.activeChannels ?? []) i.pid === e && this.retireChannelListener(i);
		r && (r.channels = []), this.discardStoppedChannelStateForProcess(e, !1), this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingSignalWaits(e), this.cleanupPendingPipeReaders(e), this.cleanupPendingPipeWriters(e);
		for (const [i, n] of this.pendingAdvisoryLockRetries ?? []) i.pid === e && (clearTimeout(n.timer), this.pendingAdvisoryLockRetries.delete(i));
		this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.parentPid !== e), this.cancelPendingSleepsForProcess(e);
		for (const [i, n] of this.pendingFutexWaits) if (i.pid === e) {
			this.pendingFutexWaits.delete(i);
			try {
				n.retire ? n.retire() : Atomics.notify(new Int32Array(i.memory.buffer), n.futexIndex, 1);
			} catch {}
		}
		for (const i of this.pendingCancels) i.pid === e && this.pendingCancels.delete(i);
		this.clearProcessThreadTransportState(e);
		for (const [i, n] of this.posixTimers) i.startsWith(`${e}:`) && (clearTimeout(n.timeout), n.interval && clearInterval(n.interval), this.posixTimers.delete(i));
		for (const [i, n] of this.socketTimeoutTimers) i.pid === e && (clearTimeout(n), this.socketTimeoutTimers.delete(i));
		return !0;
	}
	isExecHandoffActive(e) {
		return this.execHandoffPids?.has(e) ?? !1;
	}
	clearProcessThreadTransportState(e) {
		const t = `${e}:`;
		for (const r of Array.from(this.channelTids.keys())) {
			if (!r.startsWith(t)) continue;
			const i = Number(r.slice(t.length));
			this.releaseThreadChannelOwnership(e, i);
		}
		for (const r of this.threadForkContexts.keys()) r.startsWith(t) && this.threadForkContexts.delete(r);
		for (const r of this.threadCtidPtrs.keys()) r.startsWith(t) && this.threadCtidPtrs.delete(r);
	}
	finishProcessExecHandoff(e) {
		this.execHandoffPids?.delete(e);
	}
	removeFromKernelProcessTable(e) {
		const t = this.kernelInstance?.exports.kernel_remove_process;
		if (!t) throw new Error("Kernel missing required kernel_remove_process export");
		const r = t(e);
		if (0 !== r && -3 !== r) {
			const t = r < 0 ? -r : 5;
			throw new ui(e, void 0, t, `Kernel could not remove process ${e}: errno ${t}`);
		}
		this.drainAndProcessWakeupEvents();
	}
	attachThreadChannel(e, t) {
		const r = Qn.get(e);
		if (!r || r.owner !== this) throw new Error("Unknown, expired, or already consumed thread attachment");
		Qn.delete(e);
		const { pid: i, tid: n, fnPtr: s, argPtr: o, memory: a } = r;
		if (this.execHandoffPids?.has(i)) throw new Error(`Process ${i} is replacing its image`);
		if (!this.isProcessExecutionActive(i)) throw new Error(`Process ${i} is not running`);
		const c = this.processes.get(i);
		if (!c) throw new Error(`Process ${i} not registered`);
		if (c.memory !== a) throw new Error(`Process ${i} changed memory generation`);
		if (!Number.isSafeInteger(n) || n <= 0 || n > fi || n === i) throw new Error(`Thread channel for process ${i} requires a positive, non-leader kernel TID`);
		const l = `${i}:${t}`;
		if (c.channels.some((e) => e.channelOffset === t) || this.activeChannels.some((e) => e.pid === i && e.channelOffset === t) || this.channelTids.has(l) || this.threadForkContexts.has(l)) throw new Error(`Channel offset ${t} for process ${i} is already registered`);
		this.validateKernelTid(i, n);
		for (const [f, u] of this.channelTids) if (u === n) throw new Error(`Kernel TID ${n} is already attached to channel ${f}`);
		const h = {
			pid: i,
			memory: c.memory,
			channelOffset: t,
			i32View: new Int32Array(c.memory.buffer, t),
			consecutiveSyscalls: 0
		};
		this.observeProcessMemoryTarget(c.memory, h), this.observeProcessMemoryTarget(c.memory, h.i32View);
		try {
			c.channels.push(h), this.activeChannels.push(h), this.channelTids.set(l, n), this.threadForkContexts.set(l, {
				fnPtr: s,
				argPtr: o
			});
			const e = this.kernelInstance.exports.kernel_set_max_addr;
			if (e && !c.explicitMaxAddr) {
				const r = t - 131072;
				r >= Or && e(i, this.toKernelPtr(r));
			}
			this.usePolling || this.listenOnChannel(h), r.attachedChannelOffset = t;
		} catch (d) {
			throw c.channels = c.channels.filter((e) => e !== h), this.activeChannels = this.activeChannels.filter((e) => e !== h), this.releaseThreadChannelOwnership(i, t), d;
		}
	}
	removeChannel(e, t) {
		const r = this.processes.get(e);
		for (const i of r?.channels ?? []) i.channelOffset === t && this.retireExactChannelAsyncState(i);
		r && (r.channels = r.channels.filter((e) => e.channelOffset !== t)), this.activeChannels = this.activeChannels.filter((r) => !(r.pid === e && r.channelOffset === t)), this.releaseThreadChannelOwnership(e, t);
	}
	releaseThreadChannelOwnership(e, t) {
		this.channelTids.delete(`${e}:${t}`), this.threadForkContexts.delete(`${e}:${t}`);
	}
	retireExactChannelAsyncState(e) {
		this.retireChannelListener(e), this.cancelParkedFifoOpen(e), this.discardStoppedChannelState(e), this.resumePreparedSignals?.delete(e), this.pendingCancels?.delete(e), this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.channel !== e);
		const t = `${e.pid}:${e.channelOffset}`, r = this.pendingSignalWaits?.get(t);
		r && clearTimeout(r.timer), this.pendingSignalWaits?.delete(t), this.signalWaitDeadlines?.delete(t);
		const i = this.pendingSleeps?.get(e);
		i && clearTimeout(i.timer), this.pendingSleeps?.delete(e);
		const n = this.pendingFutexWaits?.get(e);
		if (n) if (this.pendingFutexWaits.delete(e), n.retire) n.retire();
		else try {
			Atomics.notify(new Int32Array(e.memory.buffer), n.futexIndex);
		} catch {}
		const s = this.pendingPollRetries?.get(e);
		null != s?.timer && (clearTimeout(s.timer), clearImmediate(s.timer)), this.pendingPollRetries?.delete(e);
		const o = this.pendingAdvisoryLockRetries?.get(e);
		o && clearTimeout(o.timer), this.pendingAdvisoryLockRetries?.delete(e);
		const a = this.pendingSelectRetries?.get(e);
		null != a?.timer && (clearTimeout(a.timer), clearImmediate(a.timer)), this.pendingSelectRetries?.delete(e), e.readinessDeadline = void 0, e.readinessFinalCheck = void 0, this.removePendingPipeReader(e), this.removePendingPipeWriter(e);
		const c = this.socketTimeoutTimers?.get(e);
		void 0 !== c && clearTimeout(c), this.socketTimeoutTimers?.delete(e);
	}
	retireAsyncChannelsForProcess(e) {
		const t = /* @__PURE__ */ new Set();
		for (const r of this.processes.get(e)?.channels ?? []) t.add(r);
		for (const r of this.activeChannels ?? []) r.pid === e && t.add(r);
		for (const r of this.waitingForChild ?? []) r.channel.pid === e && t.add(r.channel);
		for (const r of this.pendingSleeps?.keys() ?? []) r.pid === e && t.add(r);
		for (const r of this.pendingFutexWaits?.keys() ?? []) r.pid === e && t.add(r);
		for (const r of this.pendingPollRetries?.keys() ?? []) r.pid === e && t.add(r);
		for (const r of this.pendingAdvisoryLockRetries?.keys() ?? []) r.pid === e && t.add(r);
		for (const r of this.pendingSelectRetries?.keys() ?? []) r.pid === e && t.add(r);
		for (const r of this.pendingCancels ?? []) r.pid === e && t.add(r);
		for (const r of this.pendingPipeReaders?.values() ?? []) for (const i of r) i.channel.pid === e && t.add(i.channel);
		for (const r of this.pendingPipeWriters?.values() ?? []) for (const i of r) i.channel.pid === e && t.add(i.channel);
		for (const r of t) this.retireExactChannelAsyncState(r);
	}
	retireChannelListener(e) {
		(this.retiredChannelListeners ??= /* @__PURE__ */ new Set()).add(e);
	}
	settleRetiredChannelListeners(e, t, r) {
		const i = this.retiredChannelListeners;
		if (!i || 0 === i.size) return Promise.resolve();
		const n = [];
		for (const s of Array.from(i)) {
			if (s.pid !== e) continue;
			if (t && s.memory !== t) continue;
			if (void 0 !== r && s.channelOffset !== r) continue;
			const i = this.retiredListenerSettlement(s);
			if (n.push(i.promise), 0 !== (this.pendingChannelListenerCounts?.get(s) ?? 0)) {
				if (!i.notified) {
					i.notified = !0;
					try {
						const e = new Int32Array(s.memory.buffer, s.channelOffset);
						Atomics.notify(e, 0 / Int32Array.BYTES_PER_ELEMENT);
					} catch {
						this.acknowledgeRetiredChannelListener(s);
					}
				}
			} else this.acknowledgeRetiredChannelListener(s);
		}
		return Promise.all(n).then(() => {});
	}
	retiredListenerSettlement(e) {
		const t = this.retiredChannelSettlements ??= /* @__PURE__ */ new Map(), r = t.get(e);
		if (r) return r;
		let i;
		const n = {
			promise: new Promise((e) => {
				i = e;
			}),
			resolve: i,
			notified: !1
		};
		return t.set(e, n), n;
	}
	acknowledgeRetiredChannelListener(e) {
		if (0 !== (this.pendingChannelListenerCounts?.get(e) ?? 0)) return;
		(this.retiredChannelListeners ??= /* @__PURE__ */ new Set()).delete(e);
		const t = this.retiredChannelSettlements?.get(e);
		t && (this.retiredChannelSettlements.delete(e), t.resolve());
	}
	beginChannelListenerWait(e) {
		const t = this.pendingChannelListenerCounts ??= /* @__PURE__ */ new Map();
		t.set(e, (t.get(e) ?? 0) + 1);
	}
	finishChannelListenerWait(e) {
		const t = this.pendingChannelListenerCounts ??= /* @__PURE__ */ new Map(), r = (t.get(e) ?? 1) - 1;
		return r > 0 ? t.set(e, r) : t.delete(e), r <= 0;
	}
	observeProcessMemoryTarget(e, t) {
		try {
			this.callbacks.onProcessMemoryTarget?.(e, t);
		} catch {}
	}
	isRegisteredChannel(e) {
		const t = this.processes.get(e.pid);
		return !this.retiredChannelListeners?.has(e) && void 0 !== t && t.channels.includes(e);
	}
	isAsyncChannelProcessActive(e) {
		if (!this.isRegisteredChannel(e) || this.hostReaped?.has(e.pid)) return !1;
		try {
			if (this.getProcessExitSignal(e.pid) > 0) return this.handleProcessTerminated(e), !1;
		} catch {}
		return !0;
	}
	isProcessExecutionActive(e) {
		if (this.hostReaped?.has(e)) return !1;
		try {
			return -1 === this.getProcessExitSignal(e);
		} catch {
			return !0;
		}
	}
	shouldLaunchPendingChild(e) {
		return !!this.isProcessExecutionActive(e) || (this.finalizePendingChildTermination(e), !1);
	}
	startProcessWorkerWhenRunnable(e, t, r, i, n) {
		const s = this.processes.get(e);
		if (!s || s.memory !== t) return i(), "stale";
		const o = this.kernelInstance.exports.kernel_get_process_state, a = o(e);
		if (2 === a) return i(), "dead";
		if (a < 0) return i(), "stale";
		const c = () => {
			this.stoppedPids.add(e);
			const s = {
				expectedMemory: t,
				start: r,
				cancel: i,
				onStartError: n
			};
			let o = this.deferredProcessWorkerStarts.get(e);
			return o || (o = /* @__PURE__ */ new Set(), this.deferredProcessWorkerStarts.set(e, o)), o.add(s), "deferred";
		};
		if (1 === a) return c();
		if (0 !== a) return i(), "stale";
		if (this.pendingResumePids?.has(e) || this.stoppedPids?.has(e)) {
			if (c(), this.resumeStoppedProcess(e)) return "started";
			this.drainAndProcessWakeupEvents();
			const t = o(e);
			return 2 === t ? "dead" : t < 0 ? "stale" : "deferred";
		}
		return this.stoppedPids.delete(e), r(), "started";
	}
	listenOnChannel(e) {
		if (!this.isRegisteredChannel(e)) return;
		if (this.deferChannelWhileStopped(e)) return;
		const t = new Int32Array(e.memory.buffer, e.channelOffset);
		e.i32View = t;
		const r = Atomics.load(t, 0);
		if (1 === r) return void (this.relistenBatchSize <= 1 ? setImmediate(() => {
			this.isRegisteredChannel(e) && this.handleSyscall(e);
		}) : this.handleSyscall(e));
		const i = Atomics.waitAsync(t, 0, r);
		i.async ? (this.beginChannelListenerWait(e), i.value.then(() => {
			const t = this.finishChannelListenerWait(e);
			this.retiredChannelListeners?.has(e) ? t && this.acknowledgeRetiredChannelListener(e) : this.isRegisteredChannel(e) && this.listenOnChannel(e);
		}, () => {
			this.finishChannelListenerWait(e) && this.retiredChannelListeners?.has(e) && this.acknowledgeRetiredChannelListener(e);
		})) : this.relistenChannel(e);
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
	readCString(e, t, r = 256) {
		if (0 === t) return "(null)";
		const i = new Uint8Array(e.buffer);
		let n = 0;
		for (; n < r && t + n < i.length && 0 !== i[t + n];) n++;
		const s = new Uint8Array(n);
		return s.set(i.subarray(t, t + n)), new TextDecoder().decode(s);
	}
	readBytesPreview(e, t, r, i = 160) {
		if (0 === t || r <= 0) return "";
		const n = new Uint8Array(e.buffer), s = Math.max(0, Math.min(r, i, n.length - t));
		if (s <= 0) return "";
		const o = new Uint8Array(s);
		return o.set(n.subarray(t, t + s)), new TextDecoder("utf-8", { fatal: !1 }).decode(o);
	}
	formatPollFds(e, t, r) {
		if (0 === t || r <= 0) return "";
		const i = new DataView(e.buffer), n = [], s = Math.min(r, 8);
		for (let o = 0; o < s; o++) {
			const e = t + 8 * o;
			if (e + 8 > i.byteLength) break;
			const r = i.getInt32(e, !0), s = i.getInt16(e + 4, !0), a = i.getInt16(e + 6, !0);
			n.push(`{fd:${r},events:0x${(65535 & s).toString(16)},revents:0x${(65535 & a).toString(16)}}`);
		}
		return r > s && n.push("..."), n.join(",");
	}
	formatSyscallEntry(e, t, r) {
		const i = Gn[t] ?? `syscall_${t}`, n = e.pid, s = this.channelTids.get(`${n}:${e.channelOffset}`), o = void 0 !== s ? `:t${s}` : "";
		switch (t) {
			case fe: return `[${n}${o}] open("${this.readCString(e.memory, r[0])}", 0x${(r[1] >>> 0).toString(16)}, 0o${(r[2] >>> 0).toString(8)})`;
			case Ne: return `[${n}${o}] openat(${r[0]}, "${this.readCString(e.memory, r[1])}", 0x${(r[2] >>> 0).toString(16)}, 0o${(r[3] >>> 0).toString(8)})`;
			case Se: return `[${n}${o}] stat("${this.readCString(e.memory, r[0])}")`;
			case _e: return `[${n}${o}] lstat("${this.readCString(e.memory, r[0])}")`;
			case et: return `[${n}${o}] fstatat(${r[0]}, "${this.readCString(e.memory, r[1])}", 0x${(r[3] >>> 0).toString(16)})`;
			case ve: return `[${n}${o}] access("${this.readCString(e.memory, r[0])}", ${r[1]})`;
			case tt: return `[${n}${o}] faccessat(${r[0]}, "${this.readCString(e.memory, r[1])}", ${r[2]})`;
			case Ae: return `[${n}${o}] chdir("${this.readCString(e.memory, r[0])}")`;
			case Ie: return `[${n}${o}] opendir("${this.readCString(e.memory, r[0])}")`;
			case ke: return `[${n}${o}] readlink("${this.readCString(e.memory, r[0])}", ${r[2]})`;
			case rt: return `[${n}${o}] readlinkat(${r[0]}, "${this.readCString(e.memory, r[1])}", ${r[3]})`;
			case nt: return `[${n}${o}] realpath("${this.readCString(e.memory, r[0])}")`;
			case pe: return `[${n}${o}] read(${r[0]}, ${r[2]})`;
			case me: return `[${n}${o}] write(${r[0]}, ${r[2]}, ${JSON.stringify(this.readBytesPreview(e.memory, r[1], r[2]))})`;
			case ue: return `[${n}${o}] close(${r[0]})`;
			case ge: return `[${n}${o}] fstat(${r[0]})`;
			case be: return `[${n}${o}] fcntl(${r[0]}, ${r[1]}, ${r[2]})`;
			case xe: return `[${n}${o}] mmap(0x${(r[0] >>> 0).toString(16)}, ${r[1] >>> 0}, ${r[2]}, 0x${(r[3] >>> 0).toString(16)}, ${r[4]}, ${r[5] >>> 0})`;
			case ze: return `[${n}${o}] munmap(0x${(r[0] >>> 0).toString(16)}, ${r[1] >>> 0})`;
			case Me: return `[${n}${o}] brk(0x${(r[0] >>> 0).toString(16)})`;
			case ae: return `[${n}${o}] execve("${this.readCString(e.memory, r[0])}")`;
			case ce: return `[${n}${o}] fork()`;
			case le: return `[${n}${o}] vfork()`;
			case ft: return `[${n}${o}] clone(0x${(r[0] >>> 0).toString(16)})`;
			case Pe: return `[${n}${o}] exit(${r[0]})`;
			case Fe: return `[${n}${o}] poll(${r[1]}, ${r[2]}, [${this.formatPollFds(e.memory, r[0], r[1])}])`;
			case Ke: return `[${n}${o}] ioctl(${r[0]}, 0x${(r[1] >>> 0).toString(16)})`;
			default: return `[${n}${o}] ${i}(${r.filter((e, t) => t < 3).join(", ")})`;
		}
	}
	formatSyscallReturn(e, t, r) {
		if (t < 0 || 0 !== r) return ` = ${t} (${jn[r] ?? `errno=${r}`})`;
		switch (e) {
			case xe:
			case Me: return ` = 0x${(t >>> 0).toString(16)}`;
			default: return ` = ${t}`;
		}
	}
	handleSyscall(e) {
		if (this.isRegisteredChannel(e) && !this.handleExitedProcessChannel(e) && !this.deferChannelWhileStopped(e)) try {
			if (Nn) {
				const t = new DataView(e.memory.buffer, e.channelOffset).getUint32(4, !0), r = performance.now();
				this._handleSyscallInner(e);
				const i = performance.now() - r;
				let n = this.profileData.get(t);
				n || (n = {
					count: 0,
					totalTimeMs: 0,
					retries: 0
				}, this.profileData.set(t, n)), n.count++, n.totalTimeMs += i;
				return;
			}
			this._handleSyscallInner(e);
		} catch (ys) {
			if (ys instanceof ui) return void this.terminateForKernelProtocolFailure(e, `task binding error: ${ys.message}`);
			console.error(`[handleSyscall] UNCAUGHT ERROR pid=${e.pid}:`, ys), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
		}
	}
	terminateForKernelProtocolFailure(e, t) {
		console.error(`[handleSyscall] FATAL ${t}`), e.handling = !0;
		try {
			this.notifyHostProcessCrashed(e.pid, 11);
		} catch (r) {
			throw console.error(`[handleSyscall] Failed to record process ${e.pid} crash in kernel:`, r), r;
		} finally {
			this.callbacks.onExit?.(e.pid, 139);
		}
	}
	handleExitedProcessChannel(e) {
		if (!this.hostReaped?.has(e.pid)) return !1;
		const t = new DataView(e.memory.buffer, e.channelOffset).getUint32(4, !0);
		return t === Di || t === Oi ? this.completeProcessExitHandshake(e, t) : e.handling = !0, !0;
	}
	completeProcessExitHandshake(e, t) {
		this.completeChannelRaw(e, 0, 0), t === Oi && this.relistenChannel(e);
	}
	_handleSyscallInner(e) {
		const t = new DataView(e.memory.buffer, e.channelOffset), r = t.getUint32(4, !0), i = [];
		for (let w = 0; w < 6; w++) {
			const e = t.getBigInt64(8 + 8 * w, !0);
			r === Ti && 1 === w ? i.push(Number(BigInt.asUintN(32, e))) : i.push(Number(e));
		}
		const n = e.pid;
		let s = this.syscallRing.get(n);
		s || (s = [], this.syscallRing.set(n, s)), s.push(`  ${this.formatSyscallEntry(e, r, i)}`), s.length > 30 && s.shift(), this.syscallTraceEnabled && (this.syscallTraceRing.length >= this.syscallTraceCap && this.syscallTraceRing.shift(), this.syscallTraceRing.push({
			t: performance.now(),
			pid: e.pid,
			nr: r,
			args: [
				i[0] ?? 0,
				i[1] ?? 0,
				i[2] ?? 0,
				i[3] ?? 0,
				i[4] ?? 0,
				i[5] ?? 0
			],
			decoded: this.formatSyscallEntry(e, r, i)
		}));
		const o = this.config.syscallLogPtrWidth, a = void 0 !== o && this.processes.get(e.pid)?.ptrWidth === o, c = !!this.config.enableSyscallLog || a;
		let l = "";
		c && (l = this.formatSyscallEntry(e, r, i)), this.synchronizeSharedMemoryForBoundary(e);
		const h = (this.sharedMmapBackings?.size ?? 0) > 0, d = !h || this.flushSharedMappingsBeforeFileSyscall(e, r, i);
		if (h && this.hostReaped?.has(e.pid)) return;
		if (!d) return void this.completeChannel(e, r, i, void 0, -1, 5);
		if (r === Qi && 2 & i[2]) {
			const t = this.prepareFileSharedMappingsForWrite(e.pid, i[0] >>> 0, Cn(i[1] >>> 0));
			if (0 !== t) return void this.completeChannel(e, r, i, void 0, -1, t);
		}
		if (r === Fi || r === Hi) return c && console.error(l), void this.handleFork(e, i);
		if (r === $i) return c && console.error(l), void this.handleSpawn(e, i);
		if (r === Ri) return c && console.error(l), void this.handleExec(e, i);
		if (r === Ui) return c && console.error(l), void this.handleExecveat(e, i);
		if (r === Wi) return c && console.error(l), void this.handleClone(e, i);
		if (r === Di || r === Oi) return c && console.error(l), void this.handleExit(e, r, i);
		if (r === Vi) return c && console.error(l), void this.handleWaitpid(e, i);
		if (r === qi) return c && console.error(l), void this.handleWaitid(e, i);
		if (r === _i) {
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
				}, r = 128, n = 256, s = i[1] >>> 0, o = -385 & s, a = t[o] ?? `op${o}`, c = (s & r ? "|PRIVATE" : "") + (s & n ? "|REALTIME" : ""), l = this.channelTids.get(`${e.pid}:${e.channelOffset}`), h = void 0 !== l ? `:t${l}` : "";
				console.error(`[${e.pid}${h}] futex(0x${(i[0] >>> 0).toString(16)}, ${a}${c}, val=${i[2]})`);
			}
			this.handleFutex(e, i);
			return;
		}
		if (r === Gi) return c && console.error(l), void this.handleThreadCancel(e, i);
		if (r === xn || r === Tn) return c && console.error(l), void this.handleWritev(e, r, i);
		if (r === zn || r === Mn) return c && console.error(l), void this.handleReadv(e, r, i);
		if ((r === nn || r === an) && i[2] > 65536) return void this.handleLargeWrite(e, r, i);
		if ((r === sn || r === on) && i[2] > 65536) return void this.handleLargeRead(e, r, i);
		if (r === _n) return void this.handleSendmsg(e, i);
		if (r === kn) return void this.handleRecvmsg(e, i);
		if (r === Yi) {
			const t = i[1] >>> 0;
			if (35090 === t) return void this.handleIoctlIfconf(e, i);
			if (35088 === t) return void this.handleIoctlIfname(e, i);
			if (35111 === t) return void this.handleIoctlIfhwaddr(e, i);
			if (35093 === t) return void this.handleIoctlIfaddr(e, i);
			if (35123 === t) return void this.handleIoctlIfindex(e, i);
		}
		if (r === Ln) {
			const t = i[1];
			if (5 === t || 6 === t || 7 === t || 12 === t || 13 === t || 14 === t || 36 === t || 37 === t || 38 === t) return void this.handleFcntlLock(e, i);
		}
		if (r === Ei || r === Ci) return void this.handleEpollCreate(e, r, i);
		if (r === xi) return void this.handleEpollCtl(e, i);
		if (r === Pi || r === zi) return void this.handleEpollPwait(e, r, i);
		if (r === Rn) return void this.handleIpcShmat(e, i);
		if (r === Un) return void this.handleIpcShmdt(e, i);
		if (r === Bn) return void this.handleSemctl(e, i);
		if (r === Ai) return void this.handlePselect6(e, i);
		if (r === Ii) return void this.handleSelect(e, i);
		if (r === Ti && (i[1] < 4 || i[1] % 4 != 0)) return void this.completeChannel(e, r, i, void 0, -1, di);
		const f = new DataView(this.kernelMemory.buffer, this.scratchOffset), u = [...i], p = ar[r];
		let m = 0, g = !1;
		if (p) {
			const t = new Uint8Array(e.memory.buffer), n = this.getKernelMem(), s = this.scratchOffset + 72;
			for (const o of p) {
				const a = i[o.argIndex];
				if (r === Yi && i[1] >>> 0 == 21515 && 2 === o.argIndex) {
					const e = s + m;
					new DataView(this.kernelMemory.buffer).setInt32(e, i[2], !0), u[2] = e, m = m + 4 + 7 & -8;
					continue;
				}
				const c = r === Ti && 2 === o.argIndex && "out" === o.direction;
				if (0 === a && !c) {
					if (!0 === o.required || "cstring" === o.size.type && !0 !== o.nullable) return void this.completeChannel(e, r, i, void 0, -1, hi);
					continue;
				}
				let l;
				if ("cstring" === o.size.type) {
					const n = pi(t, a, re - m);
					if ("errno" in n) return void this.completeChannel(e, r, i, void 0, -1, n.errno);
					l = n.size;
				} else if ("arg" === o.size.type) l = i[o.size.argIndex] * (o.size.multiplier ?? 1) + (o.size.add ?? 0);
				else if ("deref" === o.size.type) {
					const n = i[o.size.argIndex];
					if (0 === n) continue;
					if (!mi(t, n, 4)) return void this.completeChannel(e, r, i, void 0, -1, hi);
					l = t[n] | t[n + 1] << 8 | t[n + 2] << 16 | t[n + 3] << 24;
				} else l = o.size.size;
				if (l <= 0) continue;
				if (m + l > 65536) {
					if (l = re - m, l <= 0) continue;
					"arg" === o.size.type && (u[o.size.argIndex] = l);
				}
				if (!mi(t, a, l)) {
					if (!c) return void this.completeChannel(e, r, i, void 0, -1, hi);
					g = !0;
				}
				const h = s + m;
				"in" === o.direction || "inout" === o.direction ? n.set(t.subarray(a, a + l), h) : n.fill(0, h, h + l), u[o.argIndex] = h, m += l, m = m + 7 & -8;
			}
		}
		if (r === vi) {
			const t = i[2];
			if (0 !== t) {
				const r = new DataView(e.memory.buffer, t), i = Number(r.getBigInt64(0, !0)), n = Number(r.getBigInt64(8, !0));
				u[2] = 1e3 * i + Math.floor(n / 1e6);
			} else u[2] = -1;
			const r = i[3];
			if (0 !== r) {
				const t = new DataView(e.memory.buffer, r);
				u[3] = 1, u[4] = t.getUint32(0, !0), u[5] = t.getUint32(4, !0);
			} else u[3] = 0, u[4] = 0, u[5] = 0;
		}
		!0 !== e.readinessFinalCheck || r !== ki && r !== vi || (u[2] = 0, e.readinessFinalCheck = !1);
		let y = null;
		if (r === Zi && i[1] >>> 0 > 0 && 1 & i[3] && !(32 & i[3]) && i[4] >= 0) {
			const t = this.prepareSharedMmapFromFile(e, i);
			if (this.hostReaped?.has(e.pid)) return;
			if ("error" === t.kind) return void this.completeChannel(e, r, i, void 0, -1, t.errno);
			y = t;
		}
		try {
			if (r === tn) {
				const t = this.preflightFileSharedMremap(e.pid, i);
				if (0 !== t) return void this.completeChannel(e, r, i, void 0, -1, t);
			}
			try {
				if (r === Zi && 16 & i[3]) {
					if (!this.ensureFixedMmapProcessMemoryCapacity(e, i)) return "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), void this.completeChannel(e, r, i, void 0, -1, 12);
					const t = this.flushSharedMappings(e, [i[0] >>> 0, Cn(i[1] >>> 0)]);
					if (this.hostReaped?.has(e.pid)) return void ("prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null));
					if (!t) return "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), void this.completeChannel(e, r, i, void 0, -1, 5);
				}
				f.setUint32(4, r, !0);
				for (let e = 0; e < 6; e++) f.setBigInt64(8 + 8 * e, BigInt(u[e]), !0);
			} catch (ys) {
				throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), ys;
			}
			const t = this.kernelInstance.exports.kernel_handle_channel;
			try {
				this.bindKernelTidForChannel(e);
			} catch (ys) {
				throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), ys;
			}
			this.currentHandlePid = e.pid;
			const n = globalThis.__sysprof, s = n ? performance.now() : 0;
			if (n) {
				const t = globalThis;
				t.__sysprofGap || (t.__sysprofGap = /* @__PURE__ */ new Map()), t.__sysprofLastSeen || (t.__sysprofLastSeen = /* @__PURE__ */ new Map());
				const r = t.__sysprofLastSeen.get(e.pid);
				if (void 0 !== r) {
					const i = s - r;
					let n = t.__sysprofGap.get(e.pid);
					n || (n = {
						count: 0,
						gapTotalMs: 0,
						gapMaxMs: 0
					}, t.__sysprofGap.set(e.pid, n)), n.count++, n.gapTotalMs += i, i > n.gapMaxMs && (n.gapMaxMs = i);
				}
				t.__sysprofLastSeen.set(e.pid, s);
			}
			try {
				t(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (ys) {
				"prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), c && console.error(l + " = KERNEL THROW"), console.error(`[handleSyscall] kernel threw for pid=${e.pid} syscall=${r} args=[${i}]:`, ys), r === Mi && this.signalWaitDeadlines.delete(`${e.pid}:${e.channelOffset}`), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				if (this.currentHandlePid = 0, n) {
					const t = performance.now() - s, n = globalThis;
					n.__sysprofTable || (n.__sysprofTable = /* @__PURE__ */ new Map());
					const o = `${e.pid}:${r}`;
					let a = n.__sysprofTable.get(o);
					a || (a = {
						count: 0,
						totalMs: 0,
						maxMs: 0
					}, n.__sysprofTable.set(o, a)), a.count++, a.totalMs += t, t > a.maxMs && (a.maxMs = t), t > 50 && console.warn(`[sysprof] slow pid=${e.pid} nr=${r} ${t.toFixed(1)}ms args=[${i.join(",")}]`);
				}
			}
			if (this.getProcessExitSignal(e.pid) > 0) return "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), void this.handleProcessTerminated(e);
			let o = Number(f.getBigInt64(56, !0)), a = f.getUint32(64, !0);
			if (r !== Mi || -1 === o && a === li || this.signalWaitDeadlines.delete(`${e.pid}:${e.channelOffset}`), r === Ti && g && o >= 0 && (o = -1, a = hi), r !== Zi || "prepared" !== y?.kind || o > 0 && o >>> 0 != 4294967295 || (this.releasePreparedSharedMmap(y.context), y = null), r === Zi && o > 0 && 16 & i[3]) {
				const t = [o >>> 0, Cn(i[1] >>> 0)];
				this.cleanupSharedMappings(e.pid, t[0], t[1]);
			}
			if (r === tn && o > 0 && (this.flushSharedMappings(e, [i[0] >>> 0, Cn(i[1] >>> 0)]), this.hostReaped?.has(e.pid))) return;
			if (o > 0) try {
				this.ensureProcessMemoryCovers(e.pid, e.memory, r, o, i);
			} catch (ys) {
				throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), ys;
			}
			const h = this.highControlFloorForProcess(e.pid);
			if (r === Zi && o > 0 && o >>> 0 != 4294967295) {
				const t = o >>> 0, r = i[1] >>> 0;
				null !== h && t + r > h && console.error(`[MMAP ALERT] pid=${e.pid} mmap returned 0x${t.toString(16)} len=${r} — OVERLAPS THREAD REGION! args=[${i.map((e) => "0x" + (e >>> 0).toString(16)).join(",")}]`);
			}
			if (r === tn && o > 0 && o >>> 0 != 4294967295) {
				const t = o >>> 0, r = i[2] >>> 0;
				null !== h && t + r > h && console.error(`[MREMAP ALERT] pid=${e.pid} mremap returned 0x${t.toString(16)} len=${r} — OVERLAPS THREAD REGION!`);
			}
			if (null !== h && r === en && o > h && console.error(`[BRK ALERT] pid=${e.pid} brk returned 0x${(o >>> 0).toString(16)} — IN THREAD REGION!`), r === Zi && o > 0 && o >>> 0 != 4294967295) {
				const t = i[4], r = i[3] >>> 0;
				if (1 & r && 32 & r) this.trackAnonymousSharedMapping(e, o >>> 0, i);
				else if (t >= 0 && !(32 & r)) {
					if (1 & r) {
						const t = "prepared" === y?.kind ? this.registerPreparedSharedMmap(e, o >>> 0, y.context) : "unsupported" === y?.kind ? y : this.mapSharedMmapFromFile(e, o >>> 0, i);
						if (y = null, this.hostReaped?.has(e.pid)) return;
						if ("unsupported" === t.kind) {
							if (this.populateMmapFromFile(e, o >>> 0, i), this.hostReaped?.has(e.pid)) return;
						} else if ("error" === t.kind) {
							try {
								if (this.runSyntheticMemorySyscall(e, Ji, [o >>> 0, Cn(i[1] >>> 0)]), this.hostReaped?.has(e.pid)) return;
							} catch {}
							o = -1, a = t.errno;
						}
					} else if (this.populateMmapFromFile(e, o >>> 0, i), this.hostReaped?.has(e.pid)) return;
				}
				if (o > 0) {
					const t = o >>> 0, r = this.kernel.bos.findBindingByAddr(e.pid, t);
					void 0 !== r && this.kernel.bos.primeBindFromSab(e.pid, r, e.memory);
				}
			}
			if (r === rn && 0 === o && (this.flushSharedMappings(e, i) || (o = -1, a = 5), this.hostReaped?.has(e.pid))) return;
			if (r === Ji && 0 === o) {
				const t = [i[0] >>> 0, Cn(i[1] >>> 0)];
				if (this.flushSharedMappings(e, t), this.hostReaped?.has(e.pid)) return;
				this.cleanupSharedMappings(e.pid, t[0], t[1]);
			}
			if (r === tn && o > 0 && this.remapSharedMapping(e.pid, i[0] >>> 0, o >>> 0, i[2] >>> 0), r === Qi && 0 === o && this.updateSharedMappingProtection(e.pid, i[0] >>> 0, Cn(i[1] >>> 0), !!(2 & i[2])), (this.sharedMmapBackings?.size ?? 0) > 0 && (this.handleSharedMappingsAfterFileSyscall(e, r, i, o, a), this.hostReaped?.has(e.pid))) return;
			const d = r === Fn && 0 === o;
			if (d && (this.drainMqueueNotification(), this.finishSignalTermination(e))) return;
			const m = this.dequeueSignalForDelivery(e);
			if (d && this.finishSignalTermination(e)) return;
			if (this.handlePendingInetConnect(e, r, i, o, a)) return;
			if (this.handleFlockConflict(e, r, i, o, a, m)) return;
			if (-1 === o && a === li) return c && console.error(l + " = -1 (EAGAIN, will retry)"), void this.handleBlockingRetry(e, r, i);
			if (this.handleSleepDelay(e, r, i, o, a)) return;
			0 !== a || r !== Ni && r !== Ki || this.recheckDeferredWaitpids(), 0 !== a || r !== Li && 204 !== r && r !== Bi || (this.drainAndProcessWakeupEvents(), this.scheduleWakeBlockedRetries(), this.reapKilledProcessesAfterSyscall(), 204 === r ? (this.wakePendingSignalWaits(e.pid, i[1] >>> 0, i[0] >>> 0), this.interruptWaitingChildForDirectedSignal(e.pid, i[0])) : this.interruptWaitingChildrenForGeneratedSignal(i[1])), c && console.error(l + this.formatSyscallReturn(r, o, a)), this.completeChannel(e, r, i, p, o, a);
		} catch (ys) {
			throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), ys;
		}
	}
	dequeueSignalForDelivery(e) {
		const t = this.resumePreparedSignals;
		if (t?.has(e)) {
			const r = new DataView(e.memory.buffer, e.channelOffset).getUint32(se, !0);
			if (r > 0) return r;
			t.delete(e);
		}
		const r = this.kernelInstance.exports.kernel_dequeue_signal;
		if (!r) return 0;
		const i = this.guestTidForChannel(e), n = this.scratchOffset + ne, s = r(e.pid, i, this.toKernelPtr(n));
		if (s < 0) throw new ui(e.pid, i, -s, `Kernel rejected signal dequeue for tid ${i} in process ${e.pid}`);
		if (s > 0) {
			const t = this.getKernelMem();
			return new Uint8Array(e.memory.buffer).set(t.subarray(n, n + 44), e.channelOffset + ne), s;
		}
		{
			const t = e.channelOffset + ne;
			return new Uint8Array(e.memory.buffer, t, 48).fill(0), 0;
		}
	}
	completeChannel(e, t, r, i, n, s) {
		const o = {
			kind: "marshalled",
			outputWrites: this.snapshotChannelOutput(e, t, r, i, n),
			retVal: n,
			errVal: s,
			materialized: !1,
			relistenRequested: !0
		};
		this.materializePreparedChannelCompletion(e, o), this.clearSocketTimeout(e), this.clearReadinessWait(e), this.drainAllPtyOutputs(), this.flushTcpSendPipes(e.pid), this.drainAndProcessWakeupEvents(), this.publishOrParkChannelCompletion(e, o);
	}
	snapshotChannelOutput(e, t, r, i, n) {
		if (!i) return [];
		const s = [], o = new Uint8Array(e.memory.buffer), a = this.getKernelMem(), c = this.scratchOffset + 72;
		let l = 0;
		for (const h of i) {
			const i = r[h.argIndex];
			if (t === Yi && r[1] >>> 0 == 21515 && 2 === h.argIndex) continue;
			if (0 === i) continue;
			let d;
			if ("cstring" === h.size.type) {
				let e = 0;
				for (; e < 65536 - l - 1 && 0 !== o[i + e];) e++;
				d = e + 1;
			} else if ("arg" === h.size.type) d = r[h.size.argIndex] * (h.size.multiplier ?? 1) + (h.size.add ?? 0);
			else if ("deref" === h.size.type) {
				const e = r[h.size.argIndex];
				if (0 === e) continue;
				d = o[e] | o[e + 1] << 8 | o[e + 2] << 16 | o[e + 3] << 24;
			} else d = h.size.size;
			if (d <= 0) continue;
			if (l + d > 65536 && (d = re - l, d <= 0)) continue;
			const f = c + l;
			if (!("out" !== h.direction && "inout" !== h.direction || "out" === h.direction && n < 0)) {
				let r = d;
				if ("out" === h.direction && "arg" === h.size.type) {
					const e = h.copyRetvalAdd ?? 0;
					0 === n ? r = Math.min(e, d) : n + e < d && (r = n + e);
				}
				let o = new Uint8Array(r);
				o.set(a.subarray(f, f + r)), t === Mi && 1 === h.argIndex && 8 === this.getPtrWidth(e.pid) && r >= 32 && (o.copyWithin(16, 12, 24), o.fill(0, 12, 16)), s.push({
					ptr: i,
					bytes: o
				});
			}
			l += d, l = l + 7 & -8;
		}
		return s;
	}
	publishOrParkChannelCompletion(e, t) {
		if (this.stoppedPids?.has(e.pid) && this.isRegisteredChannel(e)) {
			const r = this.parkedChannelCompletions ??= /* @__PURE__ */ new Map(), i = r.get(e);
			i ? i.relistenRequested ||= t.relistenRequested : (this.materializePreparedChannelCompletion(e, t), e.handling = !0, this.deferredStoppedChannels?.delete(e), r.set(e, {
				prepared: t,
				relistenRequested: t.relistenRequested
			}));
			return;
		}
		this.publishPreparedChannelCompletion(e, t);
	}
	publishPreparedChannelCompletion(e, t) {
		this.materializePreparedChannelCompletion(e, t), e.handling = !1;
		const r = new DataView(e.memory.buffer, e.channelOffset);
		r.setBigInt64(56, BigInt(t.retVal), !0), r.setUint32(64, t.errVal, !0), this.resumePreparedSignals?.delete(e), this.pendingCancels?.delete(e);
		const i = new Int32Array(e.memory.buffer, e.channelOffset);
		Atomics.store(i, 0, 2), Atomics.notify(i, 0, 1), t.relistenRequested && this.isRegisteredChannel(e) && this.relistenChannel(e);
	}
	materializePreparedChannelCompletion(e, t) {
		if (t.materialized) return;
		const r = new Uint8Array(e.memory.buffer);
		for (const i of t.outputWrites) r.set(i.bytes, i.ptr);
		t.outputWrites = [];
		try {
			this.synchronizeSharedMemoryForBoundary(e);
		} catch (ys) {
			console.error(`[completeChannel] shared-memory synchronization failed for pid=${e.pid}:`, ys), t.retVal = -5, t.errVal = 5;
		}
		t.materialized = !0;
	}
	deferChannelWhileStopped(e) {
		return !!this.stoppedPids?.has(e.pid) && (!this.isRegisteredChannel(e) || (this.parkedChannelCompletions?.has(e) || (this.deferredStoppedChannels ??= /* @__PURE__ */ new Map()).set(e, !0), e.handling = !0, !0));
	}
	resumeStoppedProcess(e) {
		const t = this.kernelInstance.exports.kernel_get_process_state, r = t(e);
		if (0 !== r) return 1 !== r && this.discardStoppedChannelStateForProcess(e), !1;
		const i = this.processes.get(e);
		if (!i || 0 === i.channels.length) return (this.pendingResumePids ??= /* @__PURE__ */ new Set()).add(e), (this.stoppedPids ??= /* @__PURE__ */ new Set()).add(e), !0;
		this.pendingResumePids?.delete(e);
		const n = this.parkedChannelCompletions ??= /* @__PURE__ */ new Map(), s = this.deferredStoppedChannels ??= /* @__PURE__ */ new Map(), o = this.resumePreparedSignals ??= /* @__PURE__ */ new WeakSet(), a = [];
		(this.stoppedPids ??= /* @__PURE__ */ new Set()).add(e);
		for (const u of Array.from(i.channels)) {
			if (!this.isRegisteredChannel(u)) continue;
			let r = new DataView(u.memory.buffer, u.channelOffset).getUint32(se, !0);
			if (r > 0 ? o.add(u) : (o.delete(u), r = this.dequeueSignalForDelivery(u), r > 0 && o.add(u)), this.finishSignalTermination(u)) return !1;
			const i = t(e);
			if (1 === i) return this.stoppedPids.add(e), !1;
			if (0 !== i) return this.discardStoppedChannelStateForProcess(e), !1;
			r > 0 && a.push(u);
		}
		for (const u of a) {
			if (n.has(u)) continue;
			if (this.interruptStoppedChannelWithPreparedSignal(u), this.finishSignalTermination(u)) return !1;
			const r = t(e);
			if (1 === r) return !1;
			if (0 !== r) return this.discardStoppedChannelStateForProcess(e), !1;
		}
		if (0 !== t(e)) return !1;
		this.stoppedPids.delete(e);
		const c = this.deferredProcessWorkerStarts.get(e);
		if (c) {
			this.deferredProcessWorkerStarts.delete(e);
			const t = Array.from(c);
			for (let r = 0; r < t.length; r++) {
				const i = t[r], n = this.processes.get(e);
				if (n && n.memory === i.expectedMemory) try {
					i.start();
				} catch (f) {
					if (i.cancel(), console.error(`[kernel-worker] deferred Worker launch failed for pid=${e}:`, f), !0 === i.onStartError?.(f)) continue;
					for (const e of t.slice(r + 1)) try {
						e.cancel();
					} catch {}
					return this.notifyHostProcessCrashed(e), this.callbacks.onExit && this.callbacks.onExit(e, 139), !1;
				}
				else i.cancel();
			}
		}
		const l = Array.from(n.entries()).filter(([t]) => t.pid === e);
		for (const [u, p] of l) {
			if (n.get(u) !== p) continue;
			if (!this.isRegisteredChannel(u)) {
				n.delete(u), s.delete(u);
				continue;
			}
			const r = t(e);
			if (1 === r) return this.stoppedPids.add(e), !1;
			if (0 !== r) return this.discardStoppedChannelStateForProcess(e), !1;
			n.delete(u), s.delete(u), p.prepared.relistenRequested ||= p.relistenRequested, this.publishPreparedChannelCompletion(u, p.prepared);
		}
		const h = Array.from(s.keys()).filter((t) => t.pid === e);
		for (const u of h) s.delete(u), this.isRegisteredChannel(u) && (u.handling = !1, this.relistenChannel(u));
		const d = t(e);
		return 1 === d ? (this.stoppedPids.add(e), !1) : 0 === d || (this.discardStoppedChannelStateForProcess(e), !1);
	}
	interruptStoppedChannelWithPreparedSignal(e) {
		const t = this.waitingForChild.findIndex((t) => t.channel === e);
		if (t >= 0) {
			const [e] = this.waitingForChild.splice(t, 1);
			return !!this.interruptWaiterWithPendingSignal(e) || (this.waitingForChild.splice(t, 0, e), !1);
		}
		const r = this.pendingSleeps.get(e);
		if (r) return clearTimeout(r.timer), this.pendingSleeps.delete(e), this.completeSleepWithSignalCheck(r.channel, r.syscallNr, r.origArgs, r.retVal, r.errVal), !0;
		const i = this.pendingFutexWaits.get(e);
		if (i) return i.interrupt ? i.interrupt(-4, 4) : Atomics.notify(new Int32Array(e.memory.buffer), i.futexIndex, 1), !0;
		let n = this.pendingPollRetries.has(e) || (this.pendingAdvisoryLockRetries?.has(e) ?? !1) || this.pendingSelectRetries.has(e);
		for (const s of this.pendingPipeReaders.values()) if (s.some((t) => t.channel === e)) {
			n = !0;
			break;
		}
		if (!n) {
			for (const s of this.pendingPipeWriters.values()) if (s.some((t) => t.channel === e)) {
				n = !0;
				break;
			}
		}
		return !!n && (this.cancelParkedFifoOpen(e), this.removePendingPipeReader(e), this.removePendingPipeWriter(e), this.completeChannelRaw(e, -4, 4), this.relistenChannel(e), !0);
	}
	cancelParkedFifoOpen(e) {
		if (!this.kernelInstance || !this.kernelMemory) return !1;
		if (!this.isProcessExecutionActive(e.pid)) return !1;
		let t;
		try {
			t = new DataView(e.memory.buffer, e.channelOffset).getUint32(4, !0);
		} catch {
			return !1;
		}
		if (t !== $n && t !== Wn) return !1;
		try {
			return 0 === this.runSyntheticMemorySyscall(e, Gi, [this.guestTidForChannel(e)]).errVal;
		} catch {
			return !1;
		}
	}
	interruptPendingFifoOpenCancellation(e, t) {
		return (t === $n || t === Wn) && !!this.pendingCancels.has(e) && !!this.cancelParkedFifoOpen(e) && (this.pendingCancels.delete(e), this.completeChannelRaw(e, -4, 4), this.relistenChannel(e), !0);
	}
	failDeferredCloneLaunch(e, t, r) {
		for (const [i, n] of this.parkedChannelCompletions ?? []) {
			if (i.pid !== e || n.prepared.retVal !== t) continue;
			const s = new DataView(i.memory.buffer, i.channelOffset);
			if (s.getUint32(4, !0) !== Wi) continue;
			const o = Number(s.getBigInt64(8, !0)), a = Number(s.getBigInt64(24, !0));
			return 1048576 & o && mi(new Uint8Array(i.memory.buffer), a, 4) && new DataView(i.memory.buffer).setInt32(a, 0, !0), n.prepared.outputWrites = [], n.prepared.retVal = -1, n.prepared.errVal = r, !0;
		}
		return !1;
	}
	discardStoppedChannelStateForProcess(e, t = !0) {
		const r = this.deferredProcessWorkerStarts?.get(e);
		if (r) {
			this.deferredProcessWorkerStarts.delete(e);
			for (const e of r) try {
				e.cancel();
			} catch {}
		}
		for (const i of Array.from(this.parkedChannelCompletions?.keys() ?? [])) i.pid === e && this.parkedChannelCompletions.delete(i);
		for (const i of Array.from(this.deferredStoppedChannels?.keys() ?? [])) i.pid === e && this.deferredStoppedChannels.delete(i);
		t && this.stoppedPids?.delete(e), t && this.pendingResumePids?.delete(e);
	}
	discardStoppedChannelState(e) {
		this.parkedChannelCompletions?.delete(e), this.deferredStoppedChannels?.delete(e);
	}
	killAllBlockedForTeardown() {
		for (const r of this.pendingPollRetries.values()) r.timer && clearTimeout(r.timer);
		for (const r of this.pendingAdvisoryLockRetries?.values() ?? []) clearTimeout(r.timer);
		for (const r of this.pendingSelectRetries.values()) r.timer && clearTimeout(r.timer);
		for (const r of this.pendingSleeps.values()) clearTimeout(r.timer);
		for (const r of this.pendingSignalWaits.values()) clearTimeout(r.timer);
		this.pendingPipeReaders.clear(), this.pendingPipeWriters.clear(), this.pendingPollRetries.clear(), this.pendingAdvisoryLockRetries?.clear(), this.pendingSelectRetries.clear(), this.pendingSleeps.clear(), this.pendingSignalWaits.clear(), this.signalWaitDeadlines.clear(), this.pendingFutexWaits.clear();
		const e = /* @__PURE__ */ new Set(), t = this.kernelInstance?.exports.kernel_get_process_exit_status;
		for (const r of this.processes.values()) if (!t || -1 === t(r.pid)) for (const t of r.channels) {
			let r;
			try {
				const e = new Int32Array(t.memory.buffer, t.channelOffset);
				r = Atomics.load(e, 0);
			} catch {
				continue;
			}
			if (1 === r) try {
				this.wakeChannelForTeardownExit(t), e.add(t.pid);
			} catch (ys) {
				console.error(`[killAllBlockedForTeardown] wake failed for pid=${t.pid} off=${t.channelOffset}: ${ys}`);
			}
		}
		return e;
	}
	wakeProcessWorkersForExecRetirement(e, t) {
		const r = /* @__PURE__ */ new Set(), i = this.processes.get(e);
		if (!i) return r;
		if (i.memory !== t) throw new Error(`Exec retirement generation changed for pid ${e}`);
		const n = i.channels.filter((e) => {
			if (e.memory !== t) return !1;
			const r = new DataView(t.buffer, e.channelOffset).getUint32(4, !0);
			return 1 === Atomics.load(new Int32Array(t.buffer, e.channelOffset), 0) && (r === Ri || r === Ui);
		});
		if (1 !== n.length) throw new Error(`Exec retirement expected exactly one execve/execveat caller for pid ${e}, found ${n.length}`);
		for (const s of i.channels) {
			if (s.memory !== t) throw new Error(`Exec retirement found a mixed memory generation for pid ${e}`);
			const i = new Int32Array(s.memory.buffer, s.channelOffset);
			if (1 !== Atomics.load(i, 0)) continue;
			const n = new DataView(s.memory.buffer, s.channelOffset);
			n.setUint32(se, 9, !0), n.setUint32(65564, 0, !0), n.setUint32(65584, 1262835794, !0), this.completeChannelRaw(s, -1, 4), r.add(s.channelOffset);
		}
		return r;
	}
	wakeChannelForTeardownExit(e) {
		const t = new DataView(e.memory.buffer, e.channelOffset);
		t.setUint32(se, 9, !0), t.setUint32(65564, 0, !0);
		const r = t.getUint32(4, !0), i = [];
		for (let n = 0; n < 6; n++) i.push(Number(t.getBigInt64(8 + 8 * n, !0)));
		this.completeChannel(e, r, i, ar[r], -1, 4);
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
			if (!this.isRegisteredChannel(t)) continue;
			if (this.stoppedPids?.has(t.pid)) {
				const e = new Int32Array(t.memory.buffer, t.channelOffset);
				t.i32View = e, 1 === Atomics.load(e, 0) && this.deferChannelWhileStopped(t);
				continue;
			}
			if (t.handling) continue;
			const e = new Int32Array(t.memory.buffer, t.channelOffset);
			t.i32View = e, 1 === Atomics.load(e, 0) && (t.handling = !0, this.handleSyscall(t));
		}
		this.schedulePoll();
	}
	relistenChannel(e) {
		const t = this.parkedChannelCompletions?.get(e);
		if (t) return t.relistenRequested = !0, t.prepared.relistenRequested = !0, void (e.handling = !0);
		this.deferChannelWhileStopped(e) || (e.handling = !1, this.isRegisteredChannel(e) && (this.usePolling || (this.relistenCount++, this.relistenCount >= this.relistenBatchSize ? (this.relistenCount = 0, setImmediate(() => this.listenOnChannel(e))) : queueMicrotask(() => this.listenOnChannel(e)))));
	}
	completeChannelRaw(e, t, r) {
		this.clearSocketTimeout(e), this.clearReadinessWait(e), this.pendingCancels.delete(e);
		const i = {
			kind: "raw",
			outputWrites: [],
			retVal: t,
			errVal: r,
			materialized: !1,
			relistenRequested: !1
		};
		this.materializePreparedChannelCompletion(e, i), this.drainAndProcessWakeupEvents(), this.publishOrParkChannelCompletion(e, i);
	}
	resolvePollReadinessIndices(e, t) {
		const r = this.kernelInstance.exports.kernel_get_fd_pipe_idx ?? this.kernelInstance.exports.kernel_get_socket_recv_pipe, i = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		if (!r && !i) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const n = t[0], s = t[1];
		if (0 === n || 0 === s) return {
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
			const t = l.getInt32(n + 8 * h, !0);
			if (t < 0) continue;
			const s = l.getInt16(n + 8 * h + 4, !0);
			if (r) {
				const i = r(e, t);
				i >= 0 && a.push(i);
			}
			if (i && 1 & s) {
				const r = i(e, t);
				r >= 0 && c.push(r);
			}
		}
		return {
			pipeIndices: a,
			acceptIndices: c
		};
	}
	resolveEpollReadinessIndices(e) {
		const t = this.kernelInstance.exports.kernel_get_socket_recv_pipe, r = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		if (!t && !r) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const i = `${e}:`, n = [], s = [];
		for (const [o, a] of this.epollInterests) if (o.startsWith(i)) for (const i of a) {
			if (t) {
				const r = t(e, i.fd);
				r >= 0 && n.push(r);
			}
			if (r && 1 & i.events) {
				const t = r(e, i.fd);
				t >= 0 && s.push(t);
			}
		}
		return {
			pipeIndices: n,
			acceptIndices: s
		};
	}
	wakeBlockedAccept(e) {
		const t = Array.from(this.pendingPollRetries.entries()).filter(([, t]) => t.acceptIndices?.includes(e));
		for (const [r, i] of t) this.pendingPollRetries.get(r) === i && (null !== i.timer && clearTimeout(i.timer), this.pendingPollRetries.delete(r), this.isRegisteredChannel(i.channel) && this.retrySyscall(i.channel));
	}
	wakeBlockedPoll(e, t) {
		const r = Array.from(this.pendingPollRetries.entries()).filter(([, r]) => r.channel.pid === e && r.pipeIndices.includes(t));
		for (const [i, n] of r) this.pendingPollRetries.get(i) === n && (null !== n.timer && clearTimeout(n.timer), this.pendingPollRetries.delete(i), this.isRegisteredChannel(n.channel) && this.retrySyscall(n.channel));
	}
	notifyPipeReadable(e, t) {
		const r = this.pendingPipeReaders.get(e);
		if (r && r.length > 0) {
			this.pendingPipeReaders.delete(e);
			for (const e of r) this.isRegisteredChannel(e.channel) && this.retrySyscall(e.channel);
		}
		const i = Array.from(this.pendingPollRetries.entries()).filter(([, r]) => (void 0 === t || r.channel.pid === t) && r.pipeIndices.includes(e));
		for (const [n, s] of i) this.pendingPollRetries.get(n) === s && (null !== s.timer && clearTimeout(s.timer), this.pendingPollRetries.delete(n), this.isRegisteredChannel(s.channel) && this.retrySyscall(s.channel));
		this.scheduleWakeBlockedRetries();
	}
	notifyPipeWritable(e) {
		const t = this.pendingPipeWriters.get(e);
		if (t && t.length > 0) {
			this.pendingPipeWriters.delete(e);
			for (const e of t) this.isRegisteredChannel(e.channel) && this.retrySyscall(e.channel);
		}
		this.scheduleWakeBlockedRetries();
	}
	cleanupPendingPollRetries(e) {
		for (const [t, r] of this.pendingPollRetries) r.channel.pid === e && (r.timer && clearTimeout(r.timer), this.pendingPollRetries.delete(t));
	}
	cleanupPendingSelectRetries(e) {
		for (const [t, r] of this.pendingSelectRetries) r.channel.pid === e && (null !== r.timer && (clearTimeout(r.timer), clearImmediate(r.timer)), this.pendingSelectRetries.delete(t));
	}
	drainAndProcessWakeupEvents() {
		const e = this.kernelInstance.exports.kernel_drain_wakeup_events;
		if (!e) return;
		const t = [];
		for (;;) {
			const r = e(this.toKernelPtr(this.scratchOffset), 1280, 256);
			if (r <= 0) break;
			const i = new Uint8Array(this.kernelMemory.buffer);
			for (let e = 0; e < r; e++) {
				const r = this.scratchOffset + 5 * e;
				t.push({
					wakeIdx: (i[r] | i[r + 1] << 8 | i[r + 2] << 16 | i[r + 3] << 24) >>> 0,
					wakeType: i[r + 4]
				});
			}
			if (r < 256) break;
		}
		if (0 === t.length) return;
		let r = !1, i = !1, n = !1;
		for (const { wakeIdx: s, wakeType: o } of t) {
			const e = !!(48 & o) && this.finalizeExitedProcessBeforeLifecycleNotification(s);
			if (!e && 16 & o && ((this.stoppedPids ??= /* @__PURE__ */ new Set()).add(s), this.notifyParentOfChildStateTransition(s)), !e && 32 & o && (this.resumeStoppedProcess(s) ? this.notifyParentOfChildStateTransition(s) : this.drainAndProcessWakeupEvents()), 1 & o) {
				const e = this.pendingPipeReaders.get(s);
				if (e && e.length > 0) {
					this.pendingPipeReaders.delete(s);
					for (const t of e) this.isRegisteredChannel(t.channel) && this.retrySyscall(t.channel);
				}
			}
			if (2 & o) {
				const e = this.pendingPipeWriters.get(s);
				if (e && e.length > 0) {
					this.pendingPipeWriters.delete(s);
					for (const t of e) this.isRegisteredChannel(t.channel) && this.retrySyscall(t.channel);
				}
			}
			4 & o && this.wakeBlockedAccept(s), 8 & o && (i = !0), 64 & o && (n = !0), 15 & o && (r = !0);
		}
		i && this.wakeBlockedFallbackWriters(), n && this.wakeBlockedAdvisoryLockRetries(), r && (this.anyPendingRetryNeedsSignalSafeWake() ? this.scheduleWakeBlockedRetriesDeferred() : this.scheduleWakeBlockedRetries());
	}
	wakeBlockedAdvisoryLockRetries() {
		const e = this.pendingAdvisoryLockRetries;
		if (!e || 0 === e.size) return;
		const t = Array.from(e.entries());
		for (const [r, i] of t) e.get(r) === i && (clearTimeout(i.timer), e.delete(r), this.isRegisteredChannel(i.channel) && this.retrySyscall(i.channel));
	}
	notifyParentOfChildStateTransition(e) {
		const t = this.getParentPid(e);
		if (void 0 === t) return;
		1 !== (0, this.kernelInstance.exports.kernel_has_sa_nocldstop)(t) ? this.sendSignalToProcess(t, 17) : this.wakeWaitingParent(t);
	}
	wakeBlockedFallbackWriters() {
		const e = Array.from(this.pendingPollRetries.entries()).filter(([, e]) => e.isWriteRetry);
		for (const [t, r] of e) this.pendingPollRetries.get(t) === r && (this.pendingPollRetries.delete(t), null !== r.timer && clearTimeout(r.timer), this.isRegisteredChannel(r.channel) && this.retrySyscall(r.channel));
	}
	anyPendingRetryNeedsSignalSafeWake() {
		for (const e of this.pendingPollRetries.values()) if (e.needsSignalSafeWake) return !0;
		for (const e of this.pendingSelectRetries.values()) if (e.needsSignalSafeWake) return !0;
		return !1;
	}
	scheduleWakeBlockedRetriesDeferred() {
		0 === this.pendingPollRetries.size && 0 === this.pendingSelectRetries.size && 0 === this.pendingPipeReaders.size && 0 === this.pendingPipeWriters.size || (this.postponeSignalSafePollRetries(50), this.postponeSignalSafeSelectRetries(50), this.wakeScheduled || (this.wakeScheduled = !0, setTimeout(() => {
			this.wakeScheduled = !1, this.wakeAllBlockedRetries();
		}, 50)));
	}
	postponeSignalSafePollRetries(e) {
		const t = Date.now();
		for (const [r, i] of this.pendingPollRetries) {
			if (!i.needsSignalSafeWake) continue;
			null !== i.timer && clearTimeout(i.timer);
			const n = i.deadline && i.deadline > 0 ? Math.max(1, i.deadline - t) : e;
			i.timer = setTimeout(() => {
				this.pendingPollRetries.get(r) === i && (this.pendingPollRetries.delete(r), this.isRegisteredChannel(i.channel) && this.retrySyscall(i.channel));
			}, Math.max(1, Math.min(e, n)));
		}
	}
	postponeSignalSafeSelectRetries(e) {
		const t = Date.now();
		for (const [r, i] of this.pendingSelectRetries) {
			if (!i.needsSignalSafeWake) continue;
			null !== i.timer && (clearTimeout(i.timer), clearImmediate(i.timer));
			const n = i.deadline > 0 ? Math.max(1, i.deadline - t) : e;
			i.timer = setTimeout(() => {
				this.pendingSelectRetries.get(r) === i && (this.pendingSelectRetries.delete(r), this.isRegisteredChannel(i.channel) && (i.syscallNr === Ii ? this.handleSelect(i.channel, i.origArgs) : this.handlePselect6(i.channel, i.origArgs)));
			}, Math.max(1, Math.min(e, n)));
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
		for (const [r, i] of e) this.isRegisteredChannel(i.channel) && (null !== i.timer && clearTimeout(i.timer), this.retrySyscall(i.channel));
		for (const [, r] of t) this.isRegisteredChannel(r.channel) && (clearTimeout(r.timer), clearImmediate(r.timer), r.syscallNr === Ii ? this.handleSelect(r.channel, r.origArgs) : this.handlePselect6(r.channel, r.origArgs));
		if (this.pendingPipeReaders.size > 0) {
			const e = Array.from(this.pendingPipeReaders.entries());
			this.pendingPipeReaders.clear();
			for (const [, t] of e) for (const e of t) this.isRegisteredChannel(e.channel) && this.retrySyscall(e.channel);
		}
		if (this.pendingPipeWriters.size > 0) {
			const e = Array.from(this.pendingPipeWriters.entries());
			this.pendingPipeWriters.clear();
			for (const [, t] of e) for (const e of t) this.isRegisteredChannel(e.channel) && this.retrySyscall(e.channel);
		}
	}
	cleanupPendingPipeReaders(e) {
		for (const [t, r] of this.pendingPipeReaders) {
			const i = r.filter((t) => t.pid !== e);
			0 === i.length ? this.pendingPipeReaders.delete(t) : this.pendingPipeReaders.set(t, i);
		}
	}
	cleanupPendingPipeWriters(e) {
		for (const [t, r] of this.pendingPipeWriters) {
			const i = r.filter((t) => t.pid !== e);
			0 === i.length ? this.pendingPipeWriters.delete(t) : this.pendingPipeWriters.set(t, i);
		}
	}
	clearSocketTimeout(e) {
		const t = this.socketTimeoutTimers.get(e);
		void 0 !== t && (clearTimeout(t), this.socketTimeoutTimers.delete(e));
	}
	getReadinessDeadline(e, t) {
		return t <= 0 ? -1 : (void 0 === e.readinessDeadline && (e.readinessDeadline = Date.now() + t), e.readinessDeadline);
	}
	clearReadinessWait(e) {
		e.readinessDeadline = void 0, e.readinessFinalCheck = void 0;
		const t = this.pendingPollRetries.get(e);
		t && (null !== t.timer && clearTimeout(t.timer), this.pendingPollRetries.delete(e));
		const r = this.pendingAdvisoryLockRetries?.get(e);
		r && (clearTimeout(r.timer), this.pendingAdvisoryLockRetries.delete(e));
		const i = this.pendingSelectRetries.get(e);
		i && (null !== i.timer && (clearTimeout(i.timer), clearImmediate(i.timer)), this.pendingSelectRetries.delete(e));
	}
	removePendingPipeReader(e) {
		if (this.pendingPipeReaders) for (const [t, r] of this.pendingPipeReaders) {
			const i = r.filter((t) => t.channel !== e);
			0 === i.length ? this.pendingPipeReaders.delete(t) : i.length !== r.length && this.pendingPipeReaders.set(t, i);
		}
	}
	removePendingPipeWriter(e) {
		if (this.pendingPipeWriters) for (const [t, r] of this.pendingPipeWriters) {
			const i = r.filter((t) => t.channel !== e);
			0 === i.length ? this.pendingPipeWriters.delete(t) : i.length !== r.length && this.pendingPipeWriters.set(t, i);
		}
	}
	handleThreadCancel(e, t) {
		const r = t[0], i = this.processes.get(e.pid);
		if (this.runSyntheticMemorySyscall(e, Gi, [r]), this.completeChannelRaw(e, 0, 0), this.relistenChannel(e), !i) return;
		let n;
		for (const d of i.channels) if (this.guestTidForChannel(d) === r) {
			n = d;
			break;
		}
		if (!n) return;
		this.pendingCancels.add(n);
		const s = this.pendingFutexWaits.get(n);
		if (s) {
			if (s.interrupt) s.interrupt(-4, 4);
			else {
				const e = new Int32Array(n.memory.buffer);
				Atomics.notify(e, s.futexIndex, 1);
			}
			return;
		}
		const o = this.pendingPollRetries.get(n);
		if (o) return null !== o.timer && clearTimeout(o.timer), this.pendingPollRetries.delete(n), this.completeChannelRaw(n, -4, 4), void this.relistenChannel(n);
		const a = this.pendingAdvisoryLockRetries?.get(n);
		if (a) return clearTimeout(a.timer), this.pendingAdvisoryLockRetries.delete(n), this.completeChannelRaw(n, -4, 4), void this.relistenChannel(n);
		const c = this.pendingSelectRetries.get(n);
		if (c) return clearTimeout(c.timer), clearImmediate(c.timer), this.pendingSelectRetries.delete(n), this.completeChannelRaw(n, -4, 4), void this.relistenChannel(n);
		let l = !1;
		for (const [d, f] of this.pendingPipeReaders) {
			const e = f.filter((e) => e.channel !== n);
			e.length !== f.length && (0 === e.length ? this.pendingPipeReaders.delete(d) : this.pendingPipeReaders.set(d, e), l = !0);
		}
		for (const [d, f] of this.pendingPipeWriters) {
			const e = f.filter((e) => e.channel !== n);
			e.length !== f.length && (0 === e.length ? this.pendingPipeWriters.delete(d) : this.pendingPipeWriters.set(d, e), l = !0);
		}
		if (l) return this.clearSocketTimeout(n), this.completeChannelRaw(n, -4, 4), void this.relistenChannel(n);
		const h = this.waitingForChild.findIndex((e) => e.channel === n);
		h >= 0 && (this.waitingForChild.splice(h, 1), this.completeChannelRaw(n, -4, 4), this.relistenChannel(n));
	}
	dumpProfile() {
		if (!this.profileData) return void console.error("[profile] Profiling not enabled. Set WASM_POSIX_PROFILE=1");
		const e = Array.from(this.profileData.entries()).sort((e, t) => t[1].totalTimeMs - e[1].totalTimeMs);
		let t = 0, r = 0, i = 0;
		console.error("\n=== Syscall Profile ==="), console.error(`${"Syscall".padEnd(8)} ${"Count".padStart(10)} ${"Time(ms)".padStart(12)} ${"Avg(ms)".padStart(10)} ${"Retries".padStart(10)}`), console.error("-".repeat(52));
		for (const [n, s] of e) t += s.count, r += s.totalTimeMs, i += s.retries, console.error(`${String(n).padEnd(8)} ${String(s.count).padStart(10)} ${s.totalTimeMs.toFixed(2).padStart(12)} ${(s.totalTimeMs / s.count).toFixed(3).padStart(10)} ${String(s.retries).padStart(10)}`);
		console.error("-".repeat(52)), console.error(`${"TOTAL".padEnd(8)} ${String(t).padStart(10)} ${r.toFixed(2).padStart(12)} ${(r / (t || 1)).toFixed(3).padStart(10)} ${String(i).padStart(10)}`), console.error(`Pending pipe readers: ${this.pendingPipeReaders.size}, writers: ${this.pendingPipeWriters.size}`), console.error("=== End Profile ===\n");
	}
	flushTcpSendPipes(e) {
		const t = this.tcpConnections.get(e);
		if (!t || 0 === t.length) return;
		const r = this.kernelInstance.exports.kernel_pipe_read, i = this.getKernelMem();
		for (const n of t) {
			for (;;) {
				const e = ai("kernel_pipe_read", r(0, n.sendPipeIdx, this.toKernelPtr(n.scratchOffset), 65536), 65536);
				if (e <= 0) break;
				const t = Buffer.from(i.slice(n.scratchOffset, n.scratchOffset + e));
				n.clientSocket.destroyed || n.clientSocket.write(t);
			}
			n.schedulePump();
		}
	}
	handlePendingInetConnect(e, t, r, i, n) {
		if (t !== In || -1 !== i || 115 !== n && 114 !== n) return !1;
		const s = r[1], o = r[2];
		if (!Number.isSafeInteger(s) || s <= 0 || o < 2 || s + 2 > e.memory.buffer.byteLength) return !1;
		if (2 !== new DataView(e.memory.buffer).getUint16(s, !0)) return !1;
		const a = this.kernelInstance.exports.kernel_is_fd_nonblock;
		return 1 === a?.(e.pid, r[0]) ? this.completeChannel(e, t, r, ar[t], -1, n) : this.handleBlockingRetry(e, t, r), !0;
	}
	parkAdvisoryLockRetry(e, t = Ln) {
		if (!this.isRegisteredChannel(e)) return;
		const r = this.pendingAdvisoryLockRetries ??= /* @__PURE__ */ new Map(), i = r.get(e);
		i && clearTimeout(i.timer);
		const n = setTimeout(() => {
			const t = r.get(e);
			t && t.timer === n && (r.delete(e), this.isAsyncChannelProcessActive(e) && this.retrySyscall(e));
		}, 10);
		if (r.set(e, {
			timer: n,
			channel: e
		}), Nn) {
			const e = this.profileData.get(t);
			e && e.retries++;
		}
	}
	handleFlockConflict(e, t, r, i, n, s) {
		return t === On && -1 === i && n === li && (4 & r[1] ? this.completeChannel(e, t, r, void 0, i, n) : s > 0 ? this.completeChannel(e, t, r, void 0, -1, 4) : this.parkAdvisoryLockRetry(e, t), !0);
	}
	handleBlockingRetry(e, t, r) {
		if (!this.isRegisteredChannel(e)) return;
		if (this.interruptPendingFifoOpenCancellation(e, t)) return;
		if (t === _i && !(127 & r[1])) {
			const t = r[0], i = r[2], n = new Int32Array(e.memory.buffer), s = t >>> 2;
			if (Atomics.load(n, s) !== i) return void this.retrySyscall(e);
			const o = Atomics.waitAsync(n, s, i);
			o.async ? o.value.then(() => {
				this.isRegisteredChannel(e) && this.retrySyscall(e);
			}) : setImmediate(() => this.retrySyscall(e));
			return;
		}
		if (t === ki || t === vi) {
			let i = -1;
			const n = t === vi && 0 !== r[3];
			if (t === ki) i = r[2];
			else {
				const t = r[2];
				if (0 !== t) {
					const r = new DataView(e.memory.buffer, t), n = Number(r.getBigInt64(0, !0)), s = Number(r.getBigInt64(8, !0));
					i = 1e3 * n + Math.floor(s / 1e6);
				}
			}
			if (0 === i) return void this.completeChannel(e, t, r, ar[t], 0, 0);
			const s = this.getReadinessDeadline(e, i);
			if (s > 0 && Date.now() >= s) return e.readinessFinalCheck = !0, void this.retrySyscall(e);
			const { pipeIndices: o, acceptIndices: a } = this.resolvePollReadinessIndices(e.pid, r), c = r[1];
			if (i > 0 && 0 === c) {
				const t = Math.max(s - Date.now(), 1), r = setTimeout(() => {
					this.pendingPollRetries.get(e)?.timer === r && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && (e.readinessFinalCheck = !0, this.retrySyscall(e)));
				}, t);
				this.pendingPollRetries.set(e, {
					timer: r,
					channel: e,
					pipeIndices: o,
					acceptIndices: a,
					needsSignalSafeWake: n,
					deadline: s
				});
				return;
			}
			const l = () => {
				const t = this.pendingPollRetries.get(e);
				t && t.timer === d && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && this.retrySyscall(e));
			}, h = o.length > 0 || a.length > 0 ? s > 0 ? Math.min(s - Date.now(), 10) : 10 : s > 0 ? Math.min(s - Date.now(), 50) : 50, d = setTimeout(l, Math.max(h, 1));
			this.pendingPollRetries.set(e, {
				timer: d,
				channel: e,
				pipeIndices: o,
				acceptIndices: a,
				needsSignalSafeWake: n,
				deadline: s
			});
			return;
		}
		if (t === Mi) {
			const i = r[2];
			if (0 === i) {
				const t = `${e.pid}:${e.channelOffset}`, i = this.pendingSignalWaits.get(t);
				i && clearTimeout(i.timer);
				const n = setTimeout(() => {
					this.pendingSignalWaits.delete(t), this.isRegisteredChannel(e) && this.retrySyscall(e);
				}, 500);
				this.pendingSignalWaits.set(t, {
					timer: n,
					channel: e,
					origArgs: r
				});
				return;
			}
			const n = new DataView(e.memory.buffer, i), s = Number(n.getBigInt64(0, !0)), o = Number(n.getBigInt64(8, !0)), a = 1e3 * s + Math.floor(o / 1e6), c = 11, l = `${e.pid}:${e.channelOffset}`;
			if (a <= 0) this.signalWaitDeadlines.delete(l), this.completeChannel(e, t, r, ar[t], -1, c);
			else {
				const i = this.signalWaitDeadlines.get(l), n = i?.deadline ?? performance.now() + a;
				i || this.signalWaitDeadlines.set(l, {
					pid: e.pid,
					deadline: n
				});
				const s = n - performance.now();
				if (s <= 0) return this.signalWaitDeadlines.delete(l), void this.completeChannel(e, t, r, ar[t], -1, c);
				const o = this.pendingSignalWaits.get(l);
				o && clearTimeout(o.timer);
				const h = setTimeout(() => {
					this.pendingSignalWaits.delete(l), this.signalWaitDeadlines.delete(l), this.isRegisteredChannel(e) && this.completeChannel(e, t, r, ar[t], -1, c);
				}, s);
				this.pendingSignalWaits.set(l, {
					timer: h,
					channel: e,
					origArgs: r
				});
			}
			return;
		}
		if (function(e, t) {
			let r;
			switch (e) {
				case yn:
				case wn:
				case bn:
				case Sn:
					r = t[3];
					break;
				case _n:
				case kn:
					r = t[2];
					break;
				default: return !1;
			}
			return void 0 !== r && !!(64 & r);
		}(t, r)) return void this.completeChannel(e, t, r, ar[t], -1, li);
		if (Kn.has(t) || Vn.has(t) || t === vn || t === An || t === In) {
			const i = r[0], n = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (n && 1 === n(e.pid, i)) return void this.completeChannel(e, t, r, ar[t], -1, li);
		}
		if (t === Fn || t === Hn) {
			const i = r[0], n = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (n && 1 === n(e.pid, i)) return void this.completeChannel(e, t, r, ar[t], -1, li);
		}
		if (Kn.has(t) || Vn.has(t)) {
			const i = r[0], n = this.kernelInstance.exports.kernel_get_socket_timeout_ms;
			if (n && !this.socketTimeoutTimers.has(e)) {
				const s = Kn.has(t) ? 1 : 0, o = Number(n(e.pid, i, s));
				if (o > 0) {
					const i = setTimeout(() => {
						this.socketTimeoutTimers.get(e) === i && (this.socketTimeoutTimers.delete(e), this.removePendingPipeReader(e), this.isRegisteredChannel(e) && this.completeChannel(e, t, r, ar[t], -1, 110));
					}, o);
					this.socketTimeoutTimers.set(e, i);
				}
			}
		}
		if (Kn.has(t)) {
			const i = r[0], n = this.kernelInstance.exports.kernel_get_fd_pipe_idx;
			if (n) {
				const r = n(e.pid, i);
				if (r >= 0) {
					let i = this.pendingPipeReaders.get(r);
					if (i || (i = [], this.pendingPipeReaders.set(r, i)), i.some((t) => t.channel === e) || i.push({
						channel: e,
						pid: e.pid
					}), Nn) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (Vn.has(t)) {
			const i = r[0], n = this.kernelInstance.exports.kernel_get_fd_send_pipe_idx;
			if (n) {
				const r = n(e.pid, i);
				if (r >= 0) {
					let i = this.pendingPipeWriters.get(r);
					if (i || (i = [], this.pendingPipeWriters.set(r, i)), i.some((t) => t.channel === e) || i.push({
						channel: e,
						pid: e.pid
					}), Nn) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (t === vn || t === An) {
			const i = r[0], n = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
			if (n) {
				const r = n(e.pid, i);
				if (r >= 0) {
					const i = setTimeout(() => {
						const t = this.pendingPollRetries.get(e);
						t && t.timer === i && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && this.retrySyscall(e));
					}, 10);
					if (this.pendingPollRetries.set(e, {
						timer: i,
						channel: e,
						pipeIndices: [],
						acceptIndices: [r]
					}), Nn) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (Nn) {
			const e = this.profileData.get(t);
			e && e.retries++;
		}
		const i = setTimeout(() => {
			const t = this.pendingPollRetries.get(e);
			t && t.timer === i && (this.pendingPollRetries.delete(e), this.isAsyncChannelProcessActive(e) && this.retrySyscall(e));
		}, 10);
		this.pendingPollRetries.set(e, {
			timer: i,
			channel: e,
			pipeIndices: [],
			isWriteRetry: Vn.has(t)
		});
	}
	retrySyscall(e) {
		if (this.isRegisteredChannel(e) && !this.deferChannelWhileStopped(e)) return this.getProcessExitSignal(e.pid) > 0 ? (this.signalWaitDeadlines.delete(`${e.pid}:${e.channelOffset}`), void this.handleProcessTerminated(e)) : void this.handleSyscall(e);
	}
	handleSleepDelay(e, t, r, i, n) {
		let s = 0;
		if (t === wi && i >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), r = e.getUint32(80, !0);
			s = 1e3 * t + Math.floor(r / 1e6);
		} else if (t === bi && i >= 0) {
			const e = r[0] >>> 0;
			s = Math.max(1, Math.floor(e / 1e3));
		} else if (t === Si && i >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), r = e.getUint32(80, !0);
			s = 1e3 * t + Math.floor(r / 1e6);
		}
		if (s > 0) {
			const o = setTimeout(() => {
				const s = this.pendingSleeps.get(e);
				s?.timer === o && s.channel === e && (this.pendingSleeps.delete(e), this.isRegisteredChannel(e) && this.completeSleepWithSignalCheck(e, t, r, i, n));
			}, s);
			return this.pendingSleeps.set(e, {
				timer: o,
				channel: e,
				syscallNr: t,
				origArgs: r,
				retVal: i,
				errVal: n
			}), !0;
		}
		return !1;
	}
	completeSleepWithSignalCheck(e, t, r, i, n) {
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || (new DataView(e.memory.buffer, e.channelOffset).getUint32(65560, !0) > 0 ? this.completeChannel(e, t, r, ar[t], -1, 4) : this.completeChannel(e, t, r, ar[t], i, n));
	}
	handleFcntlLock(e, t) {
		const r = t[2], i = new Uint8Array(e.memory.buffer);
		if (!Number.isSafeInteger(r) || r <= 0 || r > i.byteLength - 32) return void this.completeChannel(e, Ln, t, void 0, -1, hi);
		const n = this.getKernelMem(), s = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72;
		n.set(i.subarray(r, r + 32), o), s.setUint32(4, Ln, !0), s.setBigInt64(8, BigInt(t[0]), !0), s.setBigInt64(16, BigInt(t[1]), !0), s.setBigInt64(24, BigInt(o), !0);
		for (let f = 3; f < 6; f++) s.setBigInt64(8 + 8 * f, BigInt(t[f]), !0);
		const a = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			a(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const c = Number(s.getBigInt64(56, !0)), l = s.getUint32(64, !0), h = this.dequeueSignalForDelivery(e);
		if (this.finishSignalTermination(e)) return;
		c >= 0 && new Uint8Array(e.memory.buffer).set(n.subarray(o, o + 32), r);
		const d = t[1];
		if (-1 === c && l === li && (7 === d || 14 === d || 38 === d)) return h > 0 ? void this.completeChannel(e, Ln, t, void 0, -1, 4) : void this.parkAdvisoryLockRetry(e);
		this.completeChannel(e, Ln, t, void 0, c, l);
	}
	completeSelectSignalOutcome(e, t, r, i) {
		const n = this.dequeueSignalForDelivery(e);
		return !!this.finishSignalTermination(e) || !!(i && n > 0) && (this.completeChannel(e, t, r, void 0, -1, 4), !0);
	}
	handleSelect(e, t) {
		if (this.deferChannelWhileStopped(e)) return;
		const r = 128, i = t[0], n = t[1], s = t[2], o = t[3], a = t[4];
		let c = -1;
		if (0 !== a) {
			const t = this.getPtrWidth(e.pid), r = new DataView(e.memory.buffer, a);
			let i, n;
			8 === t ? (i = Number(r.getBigInt64(0, !0)), n = Number(r.getBigInt64(8, !0))) : (i = r.getInt32(0, !0), n = r.getInt32(4, !0)), c = 1e3 * i + Math.floor(n / 1e3), c < 0 && (c = 0);
		}
		const l = !0 === e.readinessFinalCheck;
		e.readinessFinalCheck = !1;
		const h = l ? 0 : c, d = this.getReadinessDeadline(e, c);
		if (0 === i && 0 === n && 0 === s && 0 === o) {
			if (this.completeSelectSignalOutcome(e, Ii, t, !0)) return;
			if (0 === h) return void this.completeChannel(e, Ii, t, void 0, 0, 0);
			const r = c > 0, i = r ? Math.max(d - Date.now(), 1) : -1, n = r ? setTimeout(() => {
				this.pendingSelectRetries.get(e)?.timer === n && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && this.completeChannel(e, Ii, t, void 0, 0, 0));
			}, i) : null;
			this.pendingSelectRetries.set(e, {
				timer: n,
				channel: e,
				origArgs: t,
				deadline: d,
				needsSignalSafeWake: !1,
				syscallNr: Ii
			});
			return;
		}
		const f = new Uint8Array(e.memory.buffer), u = this.getKernelMem(), p = new DataView(this.kernelMemory.buffer, this.scratchOffset), m = this.scratchOffset + 72;
		0 !== n ? u.set(f.subarray(n, n + r), m) : u.fill(0, m, m + r), 0 !== s ? u.set(f.subarray(s, s + r), m + r) : u.fill(0, m + r, m + 256), 0 !== o ? u.set(f.subarray(o, o + r), m + 256) : u.fill(0, m + 256, m + 384), p.setUint32(4, Ii, !0), p.setBigInt64(8, BigInt(i), !0), p.setBigInt64(16, BigInt(0 !== n ? m : 0), !0), p.setBigInt64(24, BigInt(0 !== s ? m + r : 0), !0), p.setBigInt64(32, BigInt(0 !== o ? m + 256 : 0), !0), p.setBigInt64(40, BigInt(h), !0);
		const g = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			g(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const y = Number(p.getBigInt64(56, !0)), w = p.getUint32(64, !0);
		if (y >= 0) {
			const t = new Uint8Array(e.memory.buffer);
			0 !== n && t.set(u.subarray(m, m + r), n), 0 !== s && t.set(u.subarray(m + r, m + 256), s), 0 !== o && t.set(u.subarray(m + 256, m + 384), o);
		}
		if (!this.completeSelectSignalOutcome(e, Ii, t, -1 === y && w === li)) {
			if (-1 === y && w === li) {
				if (0 === c) return void this.completeChannel(e, Ii, t, void 0, 0, 0);
				if (d > 0 && Date.now() >= d) return e.readinessFinalCheck = !0, void this.handleSelect(e, t);
				const r = () => {
					const r = this.pendingSelectRetries.get(e);
					r && r.timer === n && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && this.handleSelect(e, t));
				}, i = c > 0 ? Math.max(d - Date.now(), 1) : 50, n = setTimeout(r, Math.min(i, 50));
				this.pendingSelectRetries.set(e, {
					timer: n,
					channel: e,
					origArgs: t,
					deadline: d,
					needsSignalSafeWake: !1,
					syscallNr: Ii
				});
				return;
			}
			this.completeChannel(e, Ii, t, void 0, y, w);
		}
	}
	handlePselect6(e, t) {
		if (this.deferChannelWhileStopped(e)) return;
		const r = 128, i = new Uint8Array(e.memory.buffer), n = this.getKernelMem(), s = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72, a = t[0], c = t[1], l = t[2], h = t[3], d = t[4], f = t[5];
		0 !== c ? n.set(i.subarray(c, c + r), o) : n.fill(0, o, o + r), 0 !== l ? n.set(i.subarray(l, l + r), o + r) : n.fill(0, o + r, o + 256), 0 !== h ? n.set(i.subarray(h, h + r), o + 256) : n.fill(0, o + 256, o + 384);
		let u = -1;
		if (0 !== d) {
			const t = new DataView(e.memory.buffer, d), r = Number(t.getBigInt64(0, !0)), i = Number(t.getBigInt64(8, !0));
			u = 1e3 * r + Math.floor(i / 1e6);
		}
		const p = !0 === e.readinessFinalCheck;
		e.readinessFinalCheck = !1;
		const m = p ? 0 : u, g = this.getReadinessDeadline(e, u), y = o + 384;
		let w = 0;
		if (0 !== f) {
			const t = this.getPtrWidth(e.pid), r = new DataView(e.memory.buffer, f), s = 8 === t ? Number(r.getBigUint64(0, !0)) : r.getUint32(0, !0);
			0 !== s && (n.set(i.subarray(s, s + 8), y), w = y);
		}
		s.setUint32(4, Ai, !0), s.setBigInt64(8, BigInt(a), !0), s.setBigInt64(16, BigInt(0 !== c ? o : 0), !0), s.setBigInt64(24, BigInt(0 !== l ? o + r : 0), !0), s.setBigInt64(32, BigInt(0 !== h ? o + 256 : 0), !0), s.setBigInt64(40, BigInt(m), !0), s.setBigInt64(48, BigInt(w), !0);
		const b = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			b(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const S = Number(s.getBigInt64(56, !0)), _ = s.getUint32(64, !0);
		if (S >= 0) {
			const t = new Uint8Array(e.memory.buffer);
			0 !== c && t.set(n.subarray(o, o + r), c), 0 !== l && t.set(n.subarray(o + r, o + 256), l), 0 !== h && t.set(n.subarray(o + 256, o + 384), h);
		}
		if (!this.completeSelectSignalOutcome(e, Ai, t, -1 === S && _ === li)) {
			if (-1 === S && _ === li) {
				if (0 === u) return void this.completeChannel(e, Ai, t, void 0, 0, 0);
				if (g > 0 && Date.now() >= g) return e.readinessFinalCheck = !0, void this.handlePselect6(e, t);
				const r = 0 !== w;
				if (0 === a) {
					if (u > 0) {
						const i = Math.max(g - Date.now(), 1), n = setTimeout(() => {
							this.pendingSelectRetries.get(e)?.timer === n && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && (e.readinessFinalCheck = !0, this.handlePselect6(e, t)));
						}, i);
						this.pendingSelectRetries.set(e, {
							timer: n,
							channel: e,
							origArgs: t,
							deadline: g,
							needsSignalSafeWake: r,
							syscallNr: Ai
						});
					} else this.pendingSelectRetries.set(e, {
						timer: null,
						channel: e,
						origArgs: t,
						deadline: -1,
						needsSignalSafeWake: r,
						syscallNr: Ai
					});
					return;
				}
				const i = () => {
					const r = this.pendingSelectRetries.get(e);
					r && r.timer === s && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && this.handlePselect6(e, t));
				}, n = g > 0 ? Math.max(g - Date.now(), 1) : 50, s = setTimeout(i, Math.min(n, 50));
				this.pendingSelectRetries.set(e, {
					timer: s,
					channel: e,
					origArgs: t,
					deadline: g,
					needsSignalSafeWake: r,
					syscallNr: Ai
				});
				return;
			}
			this.completeChannel(e, Ai, t, void 0, S, _);
		}
	}
	handleEpollCreate(e, t, r) {
		const i = new DataView(this.kernelMemory.buffer, this.scratchOffset), n = r[0], s = t === Ci ? 0 : n;
		i.setUint32(4, t, !0), i.setBigInt64(8, BigInt(s), !0);
		for (let l = 1; l < 6; l++) i.setBigInt64(8 + 8 * l, 0n, !0);
		const o = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			o(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const a = Number(i.getBigInt64(56, !0)), c = i.getUint32(64, !0);
		if (a >= 0) {
			const t = `${e.pid}:${a}`;
			this.epollInterests.set(t, []);
		}
		this.completeChannel(e, t, r, void 0, a, c);
	}
	handleEpollCtl(e, t) {
		const r = t[0], i = t[1], n = t[2], s = t[3];
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
		c.setUint32(4, xi, !0), c.setBigInt64(8, BigInt(r), !0), c.setBigInt64(16, BigInt(i), !0), c.setBigInt64(24, BigInt(n), !0), c.setBigInt64(32, BigInt(0 !== s ? h : 0), !0), c.setBigInt64(40, BigInt(0), !0), c.setBigInt64(48, BigInt(0), !0);
		const d = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			d(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const f = Number(c.getBigInt64(56, !0)), u = c.getUint32(64, !0);
		if (0 === f) {
			const t = 1, s = 2, c = 3, l = `${e.pid}:${r}`;
			let h = this.epollInterests.get(l);
			if (h || (h = [], this.epollInterests.set(l, h)), i === t) h.push({
				fd: n,
				events: o,
				data: a
			});
			else if (i === s) {
				const e = h.findIndex((e) => e.fd === n);
				e >= 0 && h.splice(e, 1);
			} else if (i === c) {
				const e = h.find((e) => e.fd === n);
				e && (e.events = o, e.data = a);
			}
		}
		this.completeChannel(e, xi, t, void 0, f, u);
	}
	completeEpollSignalOutcome(e) {
		const t = this.dequeueSignalForDelivery(e);
		return !!this.finishSignalTermination(e) || t > 0 && (this.completeChannelRaw(e, -4, 4), this.relistenChannel(e), !0);
	}
	handleEpollPwait(e, t, r) {
		if (this.deferChannelWhileStopped(e)) return;
		const i = r[0], n = r[1], s = r[2], o = r[3], a = this.getReadinessDeadline(e, o);
		if (s <= 0) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const c = `${e.pid}:${i}`, l = this.epollInterests.get(c);
		if (!l) return this.completeChannelRaw(e, -9, 9), void this.relistenChannel(e);
		if (0 === l.length) {
			if (this.completeEpollSignalOutcome(e)) return;
			if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
			if (a > 0 && Date.now() >= a) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
			const i = () => {
				const i = this.pendingPollRetries.get(e);
				i && i.timer === s && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && this.handleEpollPwait(e, t, r));
			}, n = a > 0 ? Math.min(Math.max(a - Date.now(), 1), 10) : 10, s = setTimeout(i, n);
			this.pendingPollRetries.set(e, {
				timer: s,
				channel: e,
				pipeIndices: [],
				deadline: a
			});
			return;
		}
		const h = l.length;
		if (8 * h > 65536) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		this.getKernelMem();
		const d = new DataView(this.kernelMemory.buffer, this.scratchOffset), f = this.scratchOffset + 72;
		for (let _ = 0; _ < h; _++) {
			const e = l[_], t = f + 8 * _;
			let r = 0;
			1 & e.events && (r |= 1), 4 & e.events && (r |= 4), new DataView(this.kernelMemory.buffer).setInt32(t, e.fd, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 4, r, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 6, 0, !0);
		}
		d.setUint32(4, ki, !0), d.setBigInt64(8, BigInt(f), !0), d.setBigInt64(16, BigInt(h), !0), d.setBigInt64(24, BigInt(0), !0);
		for (let _ = 3; _ < 6; _++) d.setBigInt64(8 + 8 * _, 0n, !0);
		const u = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			u(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const p = Number(d.getBigInt64(56, !0)), m = d.getUint32(64, !0);
		if (this.completeEpollSignalOutcome(e)) return;
		if (p < 0 && m !== li) return this.completeChannelRaw(e, p, m), void this.relistenChannel(e);
		let g = 0;
		if (p > 0) {
			const t = new DataView(e.memory.buffer);
			for (let e = 0; e < h && g < s; e++) {
				const r = f + 8 * e, i = new DataView(this.kernelMemory.buffer).getInt16(r + 6, !0);
				if (0 !== i) {
					let r = 0;
					1 & i && (r |= 1), 4 & i && (r |= 4), 8 & i && (r |= 8), 16 & i && (r |= 16);
					const s = n + 12 * g;
					t.setUint32(s, r, !0), t.setBigUint64(s + 4, l[e].data, !0), g++;
				}
			}
		}
		if (g > 0) return this.completeChannelRaw(e, g, 0), void this.relistenChannel(e);
		if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
		if (a > 0 && Date.now() >= a) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
		const { pipeIndices: y, acceptIndices: w } = this.resolveEpollReadinessIndices(e.pid), b = a > 0 ? Math.min(Math.max(a - Date.now(), 1), 10) : 10, S = setTimeout(() => {
			const i = this.pendingPollRetries.get(e);
			i && i.timer === S && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && this.handleEpollPwait(e, t, r));
		}, b);
		this.pendingPollRetries.set(e, {
			timer: S,
			channel: e,
			pipeIndices: y,
			acceptIndices: w,
			deadline: a
		});
	}
	finishNetworkIoctl(e, t = 0, r = 0) {
		this.completeChannelRaw(e, t, r), this.relistenChannel(e);
	}
	guestRangeIsValid(e, t, r) {
		return Number.isSafeInteger(t) && Number.isSafeInteger(r) && t >= 0 && r >= 0 && t <= e.memory.buffer.byteLength - r;
	}
	interfaceAddress(e) {
		if (e.loopback) return new Uint8Array([
			127,
			0,
			0,
			1
		]);
		const t = this.io.network?.localAddress;
		return 4 === t?.length ? new Uint8Array(t) : null;
	}
	ifreqSize(e) {
		return 8 === this.getPtrWidth(e.pid) ? 40 : 32;
	}
	readIfreqName(e, t) {
		if (!this.guestRangeIsValid(e, t, this.ifreqSize(e))) return null;
		const r = new Uint8Array(e.memory.buffer, t, ji);
		let i = 0;
		for (; i < r.length && 0 !== r[i];) i++;
		return new TextDecoder().decode(new Uint8Array(r.subarray(0, i)));
	}
	writeIfreqName(e, t, r) {
		const i = new TextEncoder().encode(r);
		e.fill(0, t, t + ji), e.set(i.subarray(0, 15), t);
	}
	handleIoctlIfconf(e, t) {
		const r = this.getPtrWidth(e.pid), i = t[2], n = 8 === r ? 16 : 8;
		if (!this.guestRangeIsValid(e, i, n)) return void this.finishNetworkIoctl(e, -14, hi);
		const s = new DataView(e.memory.buffer), o = new Uint8Array(e.memory.buffer), a = this.ifreqSize(e), c = s.getInt32(i, !0);
		if (c < 0) return void this.finishNetworkIoctl(e, -22, di);
		let l;
		if (l = 8 === r ? Number(s.getBigUint64(i + 8, !0)) : s.getUint32(i + 4, !0), 0 === l) return s.setInt32(i, Xi.length * a, !0), void this.finishNetworkIoctl(e);
		if (c < a) return s.setInt32(i, 0, !0), void this.finishNetworkIoctl(e);
		const h = Math.floor(c / a), d = Math.min(h, Xi.length), f = d * a;
		if (this.guestRangeIsValid(e, l, f)) {
			for (let e = 0; e < d; e++) {
				const t = Xi[e], r = l + e * a;
				this.writeIfreqName(o, r, t.name), o.fill(0, r + ji, r + a), s.setUint16(r + ji, 2, !0);
				const i = this.interfaceAddress(t);
				i && o.set(i, r + ji + 4);
			}
			s.setInt32(i, f, !0), this.finishNetworkIoctl(e);
		} else this.finishNetworkIoctl(e, -14, hi);
	}
	handleIoctlIfname(e, t) {
		const r = t[2];
		if (!this.guestRangeIsValid(e, r, this.ifreqSize(e))) return void this.finishNetworkIoctl(e, -14, hi);
		const i = new DataView(e.memory.buffer), n = new Uint8Array(e.memory.buffer), s = i.getInt32(r + 16, !0), o = Xi.find((e) => e.index === s);
		o ? (this.writeIfreqName(n, r, o.name), this.finishNetworkIoctl(e)) : this.finishNetworkIoctl(e, -19, 19);
	}
	handleIoctlIfhwaddr(e, t) {
		const r = t[2], i = this.readIfreqName(e, r);
		if (null === i) return void this.finishNetworkIoctl(e, -14, hi);
		const n = Xi.find((e) => e.name === i);
		if (!n) return void this.finishNetworkIoctl(e, -19, 19);
		const s = new DataView(e.memory.buffer), o = new Uint8Array(e.memory.buffer);
		o.fill(0, r + ji, r + this.ifreqSize(e)), s.setUint16(r + ji, n.loopback ? 772 : 1, !0), n.loopback || o.set(this.virtualMacAddress, r + ji + 2), this.finishNetworkIoctl(e);
	}
	handleIoctlIfaddr(e, t) {
		const r = t[2], i = this.readIfreqName(e, r);
		if (null === i) return void this.finishNetworkIoctl(e, -14, hi);
		const n = Xi.find((e) => e.name === i);
		if (!n) return void this.finishNetworkIoctl(e, -19, 19);
		const s = this.interfaceAddress(n);
		if (!s) return void this.finishNetworkIoctl(e, -99, 99);
		const o = new DataView(e.memory.buffer), a = new Uint8Array(e.memory.buffer);
		a.fill(0, r + ji, r + this.ifreqSize(e)), o.setUint16(r + ji, 2, !0), a.set(s, r + ji + 4), this.finishNetworkIoctl(e);
	}
	handleIoctlIfindex(e, t) {
		const r = t[2], i = this.readIfreqName(e, r);
		if (null === i) return void this.finishNetworkIoctl(e, -14, hi);
		const n = Xi.find((e) => e.name === i);
		n ? (new DataView(e.memory.buffer).setInt32(r + ji, n.index, !0), this.finishNetworkIoctl(e)) : this.finishNetworkIoctl(e, -19, 19);
	}
	prepareWriteOperationBudget(e, t, r, i, n) {
		const s = this.kernelInstance.exports.kernel_prepare_write_operation;
		if (!s) throw new Error("kernel ABI is missing kernel_prepare_write_operation for chunked writes");
		let o;
		const a = this.guestTidForChannel(e);
		this.currentHandlePid = e.pid;
		try {
			o = Number(s(e.pid, a, t, BigInt(r), i, n ? 1 : 0));
		} catch (ys) {
			return console.error(`[prepareWriteOperationBudget] kernel threw for pid=${e.pid}:`, ys), this.completeChannelRaw(e, -1, 5), this.relistenChannel(e), null;
		} finally {
			this.currentHandlePid = 0;
		}
		return this.finishSignalTermination(e) ? null : !Number.isSafeInteger(o) || o > i ? (console.error(`[prepareWriteOperationBudget] invalid kernel budget ${o} for request ${i}`), this.completeChannelRaw(e, -1, 5), this.relistenChannel(e), null) : o < 0 ? (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || (this.completeChannelRaw(e, -1, -o), this.relistenChannel(e)), null) : o;
	}
	handleWritev(e, t, r) {
		const i = r[0], n = r[1], s = r[2], o = new Uint8Array(e.memory.buffer), a = new DataView(e.memory.buffer), c = this.getKernelMem(), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.scratchOffset + 72, d = this.getPtrWidth(e.pid), f = 8 === d ? 16 : 8;
		if (s <= 0 || s > 1024) return this.completeChannelRaw(e, -1, di), void this.relistenChannel(e);
		const u = [];
		let p = 0;
		for (let g = 0; g < s; g++) {
			let e, t;
			8 === d ? (e = Number(a.getBigUint64(n + g * f, !0)), t = Number(a.getBigUint64(n + g * f + 8, !0))) : (e = a.getUint32(n + g * f, !0), t = a.getUint32(n + g * f + 4, !0)), u.push({
				base: e,
				len: t
			}), p += t;
		}
		if (!Number.isSafeInteger(p) || p > 2147483647) return this.completeChannelRaw(e, -1, di), void this.relistenChannel(e);
		const m = 8 * s;
		if (p <= re - m) {
			let n = m;
			for (let e = 0; e < s; e++) {
				const t = h + n;
				u[e].len > 0 && c.set(o.subarray(u[e].base, u[e].base + u[e].len), t);
				const r = h + 8 * e;
				new DataView(c.buffer).setUint32(r, t, !0), new DataView(c.buffer).setUint32(r + 4, u[e].len, !0), n += u[e].len, n = n + 3 & -4;
			}
			l.setUint32(4, t, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(s), !0), t === Tn && (l.setBigInt64(32, BigInt(r[3]), !0), l.setBigInt64(40, BigInt(r[4]), !0));
			const a = this.kernelInstance.exports.kernel_handle_channel;
			this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				a(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
			const d = Number(l.getBigInt64(56, !0)), f = l.getUint32(64, !0);
			if (-1 === d && f === li) return void this.handleBlockingRetry(e, t, r);
			this.handleSharedMappingsAfterFileSyscall(e, t, r, d, f), this.completeChannel(e, t, r, void 0, d, f);
		} else {
			const n = this.kernelInstance.exports.kernel_handle_channel, s = t === Tn;
			let a = s ? (r[3] >>> 0) + 4294967296 * (0 | r[4]) : 0;
			const d = this.prepareWriteOperationBudget(e, i, a, p, s);
			if (null === d) return;
			let f = 0, m = !1, g = null;
			const y = 65528;
			for (const t of u) {
				if (f >= d) break;
				if (0 === t.len) continue;
				let r = 0;
				for (; r < t.len && f < d;) {
					const u = Math.min(t.len - r, y, d - f), p = h + 8;
					c.set(o.subarray(t.base + r, t.base + r + u), p), new DataView(c.buffer).setUint32(h, p, !0), new DataView(c.buffer).setUint32(h + 4, u, !0), s ? (l.setUint32(4, Tn, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0), l.setBigInt64(32, BigInt(4294967295 & a), !0), l.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (l.setUint32(4, xn, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0)), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
					try {
						n(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					if (this.finishSignalTermination(e)) return;
					const w = Number(l.getBigInt64(56, !0)), b = l.getUint32(64, !0);
					if (-1 === w) {
						b === li && 0 === f ? m = !0 : 0 === f && (g = {
							retVal: w,
							errVal: b
						});
						break;
					}
					if (r += w, f += w, s && (a += w), w < u) break;
				}
				if (m || r < t.len) break;
			}
			if (m) {
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				this.handleBlockingRetry(e, t, r);
				return;
			}
			if (g) {
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				this.completeChannelRaw(e, g.retVal, g.errVal), this.relistenChannel(e);
				return;
			}
			if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
			this.handleSharedMappingsAfterFileSyscall(e, t, r, f, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, f, 0), this.relistenChannel(e);
		}
	}
	handleLargeWrite(e, t, r) {
		const i = r[0], n = r[1], s = r[2];
		if (!Number.isSafeInteger(s) || s < 0 || s > 2147483647) return this.completeChannelRaw(e, -1, di), void this.relistenChannel(e);
		const o = t === an;
		let a = o ? r[3] : 0;
		const c = this.prepareWriteOperationBudget(e, i, a, s, o);
		if (null === c) return;
		const l = new Uint8Array(e.memory.buffer), h = this.getKernelMem(), d = new DataView(this.kernelMemory.buffer, this.scratchOffset), f = this.scratchOffset + 72, u = this.kernelInstance.exports.kernel_handle_channel;
		let p = 0;
		for (; p < c;) {
			const s = Math.min(c - p, re);
			h.set(l.subarray(n + p, n + p + s), f), d.setUint32(4, t, !0), d.setBigInt64(8, BigInt(i), !0), d.setBigInt64(16, BigInt(f), !0), d.setBigInt64(24, BigInt(s), !0), o && d.setBigInt64(32, BigInt(a), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				u(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (ys) {
				console.error(`[handleLargeWrite] kernel threw for pid=${e.pid}:`, ys), p > 0 ? (this.handleSharedMappingsAfterFileSyscall(e, t, r, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0)) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.finishSignalTermination(e)) return;
			const m = Number(d.getBigInt64(56, !0)), g = d.getUint32(64, !0);
			if (-1 === m && g === li) {
				if (p > 0) {
					if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
					this.handleSharedMappingsAfterFileSyscall(e, t, r, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0), this.relistenChannel(e);
					return;
				}
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				this.handleBlockingRetry(e, t, r);
				return;
			}
			if (0 !== g || m <= 0) {
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				p > 0 ? (this.handleSharedMappingsAfterFileSyscall(e, t, r, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0)) : this.completeChannelRaw(e, m, g), this.relistenChannel(e);
				return;
			}
			if (p += m, o && (a += m), m < s) break;
		}
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || (this.handleSharedMappingsAfterFileSyscall(e, t, r, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0), this.relistenChannel(e));
	}
	handleLargeRead(e, t, r) {
		const i = r[0], n = r[1], s = r[2], o = t === on;
		let a = o ? r[3] : 0;
		const c = new Uint8Array(e.memory.buffer), l = this.getKernelMem(), h = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72, f = this.kernelInstance.exports.kernel_handle_channel;
		let u = 0;
		for (; u < s;) {
			const p = Math.min(s - u, re);
			l.fill(0, d, d + p), h.setUint32(4, t, !0), h.setBigInt64(8, BigInt(i), !0), h.setBigInt64(16, BigInt(d), !0), h.setBigInt64(24, BigInt(p), !0), o && h.setBigInt64(32, BigInt(a), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				f(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (ys) {
				console.error(`[handleLargeRead] kernel threw for pid=${e.pid}:`, ys), u > 0 ? (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0)) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.finishSignalTermination(e)) return;
			const m = Number(h.getBigInt64(56, !0)), g = h.getUint32(64, !0);
			if (-1 === m && g === li) return u > 0 ? (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0), void this.relistenChannel(e)) : void this.handleBlockingRetry(e, t, r);
			if (0 !== g || m <= 0) return u > 0 ? (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0)) : this.completeChannelRaw(e, m, g), void this.relistenChannel(e);
			if (c.set(l.subarray(d, d + m), n + u), u += m, o && (a += m), m < p) break;
		}
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0), this.relistenChannel(e));
	}
	handleReadv(e, t, r) {
		const i = r[0], n = r[1], s = r[2], o = new Uint8Array(e.memory.buffer), a = new DataView(e.memory.buffer), c = this.getKernelMem(), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.scratchOffset + 72, d = this.getPtrWidth(e.pid), f = 8 === d ? 16 : 8, u = [];
		let p = 0;
		for (let m = 0; m < s; m++) {
			let e, t;
			8 === d ? (e = Number(a.getBigUint64(n + m * f, !0)), t = Number(a.getBigUint64(n + m * f + 8, !0))) : (e = a.getUint32(n + m * f, !0), t = a.getUint32(n + m * f + 4, !0)), u.push({
				base: e,
				len: t
			}), p += t;
		}
		if (p <= 65528 && s <= Math.floor(8192)) {
			let n = 8 * s;
			const a = [];
			for (let e = 0; e < s; e++) {
				const t = h + n;
				a.push({
					base: u[e].base,
					kernelBase: t,
					len: u[e].len
				}), u[e].len > 0 && c.fill(0, t, t + u[e].len);
				const r = h + 8 * e;
				new DataView(c.buffer).setUint32(r, t, !0), new DataView(c.buffer).setUint32(r + 4, u[e].len, !0), n += u[e].len, n = n + 3 & -4;
			}
			l.setUint32(4, t, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(s), !0), t === Mn && (l.setBigInt64(32, BigInt(r[3]), !0), l.setBigInt64(40, BigInt(r[4]), !0));
			const d = this.kernelInstance.exports.kernel_handle_channel;
			this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				d(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.finishSignalTermination(e)) return;
			const f = Number(l.getBigInt64(56, !0)), p = l.getUint32(64, !0);
			if (-1 === f && p === li) return void this.handleBlockingRetry(e, t, r);
			if (f > 0) {
				let e = f;
				for (const t of a) {
					if (e <= 0) break;
					const r = Math.min(t.len, e);
					o.set(c.subarray(t.kernelBase, t.kernelBase + r), t.base), e -= r;
				}
			}
			this.completeChannel(e, t, r, void 0, f, p);
		} else {
			const n = this.kernelInstance.exports.kernel_handle_channel, s = t === Mn;
			let a = s ? (0 | r[3]) + 4294967296 * (0 | r[4]) : 0, d = 0, f = 0, p = !1;
			for (const t of u) {
				if (0 === t.len) continue;
				let r = 0;
				for (; r < t.len;) {
					const u = Math.min(t.len - r, 65528), m = h + 8;
					new DataView(c.buffer).setUint32(h, m, !0), new DataView(c.buffer).setUint32(h + 4, u, !0), c.fill(0, m, m + u), s ? (l.setUint32(4, Mn, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0), l.setBigInt64(32, BigInt(4294967295 & a), !0), l.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (l.setUint32(4, zn, !0), l.setBigInt64(8, BigInt(i), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0)), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
					try {
						n(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					if (this.finishSignalTermination(e)) return;
					const g = Number(l.getBigInt64(56, !0)), y = l.getUint32(64, !0);
					if (-1 === g) {
						if (y === li && 0 === d) {
							p = !0;
							break;
						}
						f = y;
						break;
					}
					if (0 === g) break;
					if (o.set(c.subarray(m, m + g), t.base + r), r += g, d += g, s && (a += g), g < u) break;
				}
				if (p || f) break;
			}
			if (p) return void this.handleBlockingRetry(e, t, r);
			const m = d > 0 ? d : f ? -1 : 0, g = d > 0 ? 0 : f;
			this.completeChannel(e, t, r, void 0, m, g);
		}
	}
	handleSendmsg(e, t) {
		const r = t[0], i = t[1], n = t[2], s = new Uint8Array(e.memory.buffer), o = new DataView(e.memory.buffer), a = this.getKernelMem(), c = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.scratchOffset + 72, h = this.getPtrWidth(e.pid);
		let d, f, u, p, m, g;
		8 === h ? (d = Number(o.getBigUint64(i, !0)), f = o.getUint32(i + 8, !0), u = Number(o.getBigUint64(i + 16, !0)), p = o.getUint32(i + 24, !0), m = Number(o.getBigUint64(i + 32, !0)), g = o.getUint32(i + 40, !0)) : (d = o.getUint32(i, !0), f = o.getUint32(i + 4, !0), u = o.getUint32(i + 8, !0), p = o.getUint32(i + 12, !0), m = o.getUint32(i + 16, !0), g = o.getUint32(i + 20, !0));
		const y = l, w = new DataView(a.buffer);
		w.setUint32(y, d, !0), w.setUint32(y + 4, f, !0), w.setUint32(y + 8, u, !0), w.setUint32(y + 12, p, !0), w.setUint32(y + 16, m, !0), w.setUint32(y + 20, g, !0), w.setUint32(y + 24, 0, !0);
		let b = 28;
		if (0 !== d && f > 0 && b + f <= 65536) {
			const e = l + b;
			a.set(s.subarray(d, d + f), e), w.setUint32(y, e, !0), b += f, b = b + 3 & -4;
		}
		if (0 !== m && g > 0 && b + g <= 65536) {
			const e = l + b;
			a.set(s.subarray(m, m + g), e), w.setUint32(y + 16, e, !0), b += g, b = b + 3 & -4;
		}
		const S = 8 === h ? 16 : 8;
		if (p > 0 && 0 !== u) {
			const e = l + b;
			b += 8 * p, b = b + 3 & -4, w.setUint32(y + 8, e, !0);
			for (let t = 0; t < p; t++) {
				let r, i;
				if (8 === h ? (r = Number(o.getBigUint64(u + t * S, !0)), i = Number(o.getBigUint64(u + t * S + 8, !0))) : (r = o.getUint32(u + 8 * t, !0), i = o.getUint32(u + 8 * t + 4, !0)), w.setUint32(e + 8 * t, 0, !0), w.setUint32(e + 8 * t + 4, i, !0), i > 0 && b + i <= 65536) {
					const n = l + b;
					a.set(s.subarray(r, r + i), n), w.setUint32(e + 8 * t, n, !0), b += i, b = b + 3 & -4;
				}
			}
		}
		c.setUint32(4, _n, !0), c.setBigInt64(8, BigInt(r), !0), c.setBigInt64(16, BigInt(y), !0), c.setBigInt64(24, BigInt(n), !0);
		const _ = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			_(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const k = Number(c.getBigInt64(56, !0)), v = c.getUint32(64, !0);
		-1 !== k || v !== li ? this.completeChannel(e, _n, t, void 0, k, v) : this.handleBlockingRetry(e, _n, t);
	}
	handleRecvmsg(e, t) {
		const r = t[0], i = t[1], n = t[2], s = new Uint8Array(e.memory.buffer), o = new DataView(e.memory.buffer), a = this.getKernelMem(), c = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.scratchOffset + 72, h = this.getPtrWidth(e.pid);
		let d, f, u, p, m, g;
		8 === h ? (d = Number(o.getBigUint64(i, !0)), f = o.getUint32(i + 8, !0), u = Number(o.getBigUint64(i + 16, !0)), p = o.getUint32(i + 24, !0), m = Number(o.getBigUint64(i + 32, !0)), g = o.getUint32(i + 40, !0)) : (d = o.getUint32(i, !0), f = o.getUint32(i + 4, !0), u = o.getUint32(i + 8, !0), p = o.getUint32(i + 12, !0), m = o.getUint32(i + 16, !0), g = o.getUint32(i + 20, !0));
		const y = l, w = new DataView(a.buffer);
		w.setUint32(y, d, !0), w.setUint32(y + 4, f, !0), w.setUint32(y + 8, u, !0), w.setUint32(y + 12, p, !0), w.setUint32(y + 16, m, !0), w.setUint32(y + 20, g, !0), w.setUint32(y + 24, 0, !0);
		let b = 28, S = 0;
		0 !== d && f > 0 && b + f <= 65536 && (S = l + b, a.fill(0, S, S + f), w.setUint32(y, S, !0), b += f, b = b + 3 & -4);
		let _ = 0;
		0 !== m && g > 0 && b + g <= 65536 && (_ = l + b, a.fill(0, _, _ + g), w.setUint32(y + 16, _, !0), b += g, b = b + 3 & -4);
		const k = [], v = 8 === h ? 16 : 8;
		if (p > 0 && 0 !== u) {
			const e = l + b;
			b += 8 * p, b = b + 3 & -4, w.setUint32(y + 8, e, !0);
			for (let t = 0; t < p; t++) {
				let r, i;
				if (8 === h ? (r = Number(o.getBigUint64(u + t * v, !0)), i = Number(o.getBigUint64(u + t * v + 8, !0))) : (r = o.getUint32(u + 8 * t, !0), i = o.getUint32(u + 8 * t + 4, !0)), i > 0 && b + i <= 65536) {
					const n = l + b;
					a.fill(0, n, n + i), w.setUint32(e + 8 * t, n, !0), w.setUint32(e + 8 * t + 4, i, !0), k.push({
						base: r,
						len: i,
						kernelBase: n
					}), b += i, b = b + 3 & -4;
				} else w.setUint32(e + 8 * t, 0, !0), w.setUint32(e + 8 * t + 4, i, !0);
			}
		}
		c.setUint32(4, kn, !0), c.setBigInt64(8, BigInt(r), !0), c.setBigInt64(16, BigInt(y), !0), c.setBigInt64(24, BigInt(n), !0);
		const A = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			A(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const I = Number(c.getBigInt64(56, !0)), P = c.getUint32(64, !0);
		if (-1 === I && P === li) return void this.handleBlockingRetry(e, kn, t);
		if (I > 0) {
			let e = I;
			for (const t of k) {
				if (e <= 0) break;
				const r = Math.min(t.len, e);
				s.set(a.subarray(t.kernelBase, t.kernelBase + r), t.base), e -= r;
			}
		}
		if (0 !== S && 0 !== d && f > 0 && s.set(a.subarray(S, S + f), d), 0 !== _ && 0 !== m) {
			const e = w.getUint32(y + 20, !0);
			e > 0 && e <= g && s.set(a.subarray(_, _ + e), m);
		}
		const E = w.getUint32(y + 4, !0), C = w.getUint32(y + 20, !0), x = w.getUint32(y + 24, !0);
		8 === h ? (o.setUint32(i + 8, E, !0), o.setUint32(i + 40, C, !0), o.setUint32(i + 44, x, !0)) : (o.setUint32(i + 4, E, !0), o.setUint32(i + 20, C, !0), o.setUint32(i + 24, x, !0)), this.completeChannel(e, kn, t, void 0, I, P);
	}
	handleFork(e, t) {
		if (!this.callbacks.onFork) return void this.completeChannel(e, Fi, t, void 0, -1, 38);
		const r = e.pid, i = this.guestTidForChannel(e);
		if (this.syncAnonymousSharedMappingsFromProcess(e, { force: !0 }), this.syncFileSharedMappingsFromProcess(e, { force: !0 }), !this.syncSysvShmMappingsFromProcess(e, { force: !0 })) return void this.completeChannel(e, Fi, t, void 0, -1, 5);
		const n = `${r}:${e.channelOffset}`, s = this.threadForkContexts.get(n), o = e.channelOffset - 131072, a = oi(e.memory, e.channelOffset - 61440, this.processes.get(r)?.ptrWidth ?? 4), c = s ? {
			kind: "thread",
			fnPtr: s.fnPtr,
			argPtr: s.argPtr,
			forkBufAddr: a,
			slotStart: o,
			slotLen: 262144
		} : {
			kind: "main",
			forkBufAddr: a
		}, l = (0, this.kernelInstance.exports.kernel_fork_process)(r, i);
		if (l <= 0) {
			const r = l < 0 ? -l >>> 0 : 5;
			this.completeChannel(e, Fi, t, void 0, -1, r);
			return;
		}
		const h = l >>> 0, d = this.kernelInstance.exports.kernel_clear_fork_child;
		if (d && d(h), "thread" === c.kind) try {
			this.reserveHostRegionAt(h, c.slotStart, c.slotLen);
		} catch (ys) {
			try {
				this.removeFromKernelProcessTable(h);
			} catch (p) {
				this.terminateForKernelProtocolFailure(e, `could not roll back fork child ${h}: ${p instanceof Error ? p.message : String(p)}`);
				return;
			}
			const i = ys instanceof Error ? ys.message : String(ys);
			console.error(`[kernel-worker] fork child slot reservation failed: ${i}`), this.completeChannel(e, Fi, t, void 0, -1, 12);
			return;
		}
		const f = (r) => {
			void 0 !== r && console.error(`[kernel-worker] fork worker launch failed: ${String(r)}`);
			try {
				this.rollbackChildHostRegistration(h);
			} catch (i) {
				console.error(`[kernel-worker] fork child ${h} host rollback failed:`, i);
			}
			try {
				this.removeFromKernelProcessTable(h);
			} catch (p) {
				this.terminateForKernelProtocolFailure(e, `could not roll back fork child ${h}: ${p instanceof Error ? p.message : String(p)}`);
				return;
			}
			if (this.isAsyncChannelProcessActive(e)) {
				const i = r instanceof ti ? 11 : 12;
				this.completeChannel(e, Fi, t, void 0, -1, i);
			}
		};
		let u;
		try {
			this.inheritHostFdMirrors(r, h), u = Promise.resolve(this.callbacks.onFork({
				parentPid: r,
				childPid: h,
				parentMemory: e.memory,
				continuation: c
			}));
		} catch (ys) {
			f(ys);
			return;
		}
		u.then((r) => {
			this.finalizePendingChildTermination(h), this.isAsyncChannelProcessActive(e) && this.completeChannel(e, Fi, t, void 0, h, 0);
		}).catch(f);
	}
	handleSpawn(e, t) {
		const r = e.pid, i = this.guestTidForChannel(e), n = t[0], s = t[1], o = t[2], a = t[3], c = t[4];
		if (!this.callbacks.onSpawn || !this.callbacks.onResolveSpawn) return void this.completeChannel(e, $i, t, void 0, -1, 38);
		const l = new Uint8Array(e.memory.buffer);
		if (!Number.isSafeInteger(s) || s < 0 || !Number.isSafeInteger(a) || a <= 0) return void this.completeChannel(e, $i, t, void 0, -1, di);
		if (s >= yi) return void this.completeChannel(e, $i, t, void 0, -1, 36);
		if (s > 0 && !mi(l, n, s)) return void this.completeChannel(e, $i, t, void 0, -1, hi);
		if (a > 8417320) return void this.completeChannel(e, $i, t, void 0, -1, 7);
		if (!mi(l, o, a)) return void this.completeChannel(e, $i, t, void 0, -1, hi);
		if (0 !== c && !mi(l, c, 4)) return void this.completeChannel(e, $i, t, void 0, -1, hi);
		let h = "";
		s > 0 && (h = new TextDecoder().decode(l.slice(n, n + s)), h.endsWith("\0") && (h = h.slice(0, -1)));
		const d = h;
		h && !h.startsWith("/") && (h = this.resolveExecPathAgainstCwd(r, h));
		const f = l.slice(o, o + a);
		let u, p;
		try {
			const e = function(e) {
				if (e.byteLength < 40) throw new Error("blob too short for header");
				const t = new DataView(e.buffer, e.byteOffset, e.byteLength), r = t.getUint32(0, !0), i = t.getUint32(4, !0), n = t.getUint32(8, !0);
				if (r > 4096 || i > 4096 || n > 1024) throw new Error("blob count exceeds limit");
				const s = 40 + 4 * r, o = s + 4 * i + 28 * n;
				if (o > e.byteLength) throw new Error("blob truncated before strings region");
				const a = e.byteLength - o, c = new TextDecoder(), l = (t) => {
					if (t > a) throw new Error("string offset OOB");
					let r = t;
					for (; r < a && 0 !== e[o + r];) r++;
					return c.decode(e.slice(o + t, o + r));
				}, h = [];
				for (let f = 0; f < r; f++) h.push(l(t.getUint32(40 + 4 * f, !0)));
				const d = [];
				for (let f = 0; f < i; f++) d.push(l(t.getUint32(s + 4 * f, !0)));
				return {
					argv: h,
					envp: d
				};
			}(f);
			u = e.argv, p = e.envp;
		} catch (g) {
			this.completeChannel(e, $i, t, void 0, -1, 22);
			return;
		}
		const m = this.validateExecMetadata(u, p, this.getPtrWidth(r));
		if (m < 0) return void this.completeChannel(e, $i, t, void 0, -1, -m);
		(async () => {
			const e = await this.callbacks.onResolveSpawn(h, u);
			return e || d === h || !d || d.startsWith("/") ? e : this.callbacks.onResolveSpawn(d, u);
		})().then((n) => {
			var s;
			this.isAsyncChannelProcessActive(e) && (n ? "errno" in (s = n) && "number" == typeof s.errno ? this.completeChannel(e, $i, t, void 0, -1, n.errno >>> 0) : this.handleSpawnAfterResolve(e, t, r, i, c, f, a, n, p) : this.completeChannel(e, $i, t, void 0, -1, 2));
		}).catch((i) => {
			this.isAsyncChannelProcessActive(e) && (console.error(`[kernel] spawn resolve error for parent ${r}:`, i), this.completeChannel(e, $i, t, void 0, -1, 5));
		});
	}
	scratchOffsetForSpawnBlob(e) {
		if (e <= qn) return this.scratchOffset;
		if (0 !== (this.largeSpawnScratchOffset ?? 0)) return this.largeSpawnScratchOffset;
		const t = this.kernelInstance.exports.kernel_alloc_scratch;
		return this.largeSpawnScratchOffset = Number(t(8417320)), this.largeSpawnScratchOffset;
	}
	handleSpawnAfterResolve(e, t, r, i, n, s, o, a, c) {
		if (o !== s.byteLength || o <= 0 || o > 8417320) {
			const r = o > 8417320 ? 7 : di;
			this.completeChannel(e, $i, t, void 0, -1, r);
			return;
		}
		const l = this.scratchOffsetForSpawnBlob(o);
		if (o > qn && 0 === l) return void this.completeChannel(e, $i, t, void 0, -1, 12);
		const h = new Uint8Array(this.kernelMemory.buffer);
		if (!Number.isSafeInteger(l) || l < 0 || l > h.byteLength - o) return void this.completeChannel(e, $i, t, void 0, -1, 5);
		h.set(s, l);
		const d = (0, this.kernelInstance.exports.kernel_spawn_process)(r, i, this.toKernelPtr(l), this.toKernelPtr(o));
		if (d <= 0) {
			const r = d < 0 ? -d >>> 0 : 5;
			this.completeChannel(e, $i, t, void 0, -1, r);
			return;
		}
		const f = d >>> 0, u = (i, n) => {
			void 0 !== n && console.error(`[kernel] spawn error for parent ${r}:`, n);
			try {
				this.rollbackChildHostRegistration(f);
			} catch (s) {
				console.error(`[kernel-worker] spawn child ${f} host rollback failed:`, s);
			}
			try {
				this.removeFromKernelProcessTable(f);
			} catch (o) {
				this.terminateForKernelProtocolFailure(e, `could not roll back spawn child ${f}: ${o instanceof Error ? o.message : String(o)}`);
				return;
			}
			this.isAsyncChannelProcessActive(e) && this.completeChannel(e, $i, t, void 0, -1, i);
		};
		let p;
		try {
			this.inheritHostFdMirrors(r, f, !1), p = Promise.resolve(this.callbacks.onSpawn(r, f, a, c));
		} catch (ys) {
			u(5, ys);
			return;
		}
		p.then((r) => {
			r < 0 ? u(-r >>> 0) : (this.finalizePendingChildTermination(f), this.isAsyncChannelProcessActive(e) && (0 !== n && new DataView(e.memory.buffer).setInt32(n, f, !0), this.completeChannel(e, $i, t, void 0, 0, 0)));
		}).catch((e) => {
			u(5, e);
		});
	}
	readCStringFromProcess(e, t, r = 4096) {
		if (0 === t) return "";
		let i = 0;
		for (; t + i < e.length && 0 !== e[t + i] && i < r;) i++;
		return new TextDecoder().decode(e.slice(t, t + i));
	}
	readExecPathFromProcess(e, t) {
		if (!Number.isSafeInteger(t) || t <= 0 || t >= e.byteLength) return { errno: hi };
		const r = e.byteLength - t, i = Math.min(r, yi);
		let n = 0;
		for (; n < i && 0 !== e[t + n];) n++;
		return n === i ? { errno: r >= yi ? 36 : hi } : { value: new TextDecoder().decode(e.slice(t, t + n)) };
	}
	readStringArrayFromProcess(e, t, r = 4) {
		if (0 === t) return { values: [] };
		const i = [], n = new DataView(e.buffer, e.byteOffset, e.byteLength);
		let s = r;
		for (let o = 0; s <= gi; o++) {
			const a = t + o * r;
			if (!Number.isSafeInteger(a) || a < 0 || a + r > n.byteLength) return { errno: hi };
			let c;
			if (8 === r) {
				const e = n.getBigUint64(a, !0);
				if (e > BigInt(Number.MAX_SAFE_INTEGER)) return { errno: hi };
				c = Number(e);
			} else c = n.getUint32(a, !0);
			if (0 === c) return { values: i };
			if (c < 0 || c >= e.byteLength) return { errno: hi };
			const l = Math.min(e.byteLength - c, 65537);
			let h = 0;
			for (; h < l && 0 !== e[c + h];) h++;
			if (h === l) return { errno: l > 65536 ? 7 : hi };
			if (h > 65536) return { errno: 7 };
			if (s += r + h + 1, !Number.isSafeInteger(s) || s > gi) return { errno: 7 };
			i.push(new TextDecoder().decode(e.slice(c, c + h)));
		}
		return { errno: 7 };
	}
	finishFailedExec(e, t, r, i) {
		this.isAsyncChannelProcessActive(e) && this.completeChannel(e, t, r, void 0, -1, i);
	}
	handleExec(e, t) {
		const r = new Uint8Array(e.memory.buffer), i = this.getPtrWidth(e.pid), n = this.readExecPathFromProcess(r, t[0]);
		if ("errno" in n) return void this.completeChannel(e, Ri, t, void 0, -1, n.errno);
		let s = n.value;
		const o = this.readStringArrayFromProcess(r, t[1], i), a = this.readStringArrayFromProcess(r, t[2], i);
		if ("errno" in o) return void this.completeChannel(e, Ri, t, void 0, -1, o.errno);
		if ("errno" in a) return void this.completeChannel(e, Ri, t, void 0, -1, a.errno);
		const c = o.values, l = a.values;
		if (s && !s.startsWith("/") && (s = this.resolveExecPathAgainstCwd(e.pid, s)), !this.callbacks.onExec) return void this.completeChannel(e, Ri, t, void 0, -1, 38);
		const h = this.guestTidForChannel(e);
		this.callbacks.onExec(e.pid, s, c, l, h).then((r) => {
			r < 0 && this.finishFailedExec(e, Ri, t, -r >>> 0);
		}).catch((r) => {
			console.error(`[kernel] exec error for pid ${e.pid}:`, r), this.finishFailedExec(e, Ri, t, 5);
		});
	}
	resolveExecPathAgainstCwd(e, t) {
		const r = this.kernelInstance.exports.kernel_get_cwd;
		if (!r) return t;
		const i = r(e, this.toKernelPtr(this.scratchOffset), 4096);
		if (i <= 0) return t;
		const n = new Uint8Array(this.kernelMemory.buffer), s = new TextDecoder().decode(n.slice(this.scratchOffset, this.scratchOffset + i)), o = (s.endsWith("/") ? s + t : s + "/" + t).split("/"), a = [];
		for (const c of o) "." !== c && "" !== c && (".." === c && a.length > 0 ? a.pop() : a.push(c));
		return "/" + a.join("/");
	}
	handleExecveat(e, t) {
		const r = t[0], i = t[4], n = new Uint8Array(e.memory.buffer), s = this.getPtrWidth(e.pid), o = this.readExecPathFromProcess(n, t[1]);
		if ("errno" in o) return void this.completeChannel(e, Ui, t, void 0, -1, o.errno);
		const a = o.value, c = this.readStringArrayFromProcess(n, t[2], s), l = this.readStringArrayFromProcess(n, t[3], s);
		if ("errno" in c) return void this.completeChannel(e, Ui, t, void 0, -1, c.errno);
		if ("errno" in l) return void this.completeChannel(e, Ui, t, void 0, -1, l.errno);
		const h = c.values, d = l.values;
		let f;
		if (4096 & i && "" === a) {
			const i = this.kernelInstance.exports.kernel_get_fd_path;
			if (!i) return void this.completeChannel(e, Ui, t, void 0, -1, 38);
			const n = i(e.pid, r, this.toKernelPtr(this.scratchOffset), 4096);
			if (n <= 0) {
				const r = n < 0 ? -n >>> 0 : 2;
				this.completeChannel(e, Ui, t, void 0, -1, r);
				return;
			}
			const s = new Uint8Array(this.kernelMemory.buffer);
			f = new TextDecoder().decode(s.slice(this.scratchOffset, this.scratchOffset + n));
		} else if (a.startsWith("/")) f = a;
		else {
			const t = this.kernelInstance.exports.kernel_get_cwd;
			if (t) {
				const r = t(e.pid, this.scratchOffset, 4096);
				if (r > 0) {
					const e = new Uint8Array(this.kernelMemory.buffer), t = new TextDecoder().decode(e.slice(this.scratchOffset, this.scratchOffset + r));
					f = t.endsWith("/") ? t + a : t + "/" + a;
				} else f = a;
			} else f = a;
		}
		if (!this.callbacks.onExec) return void this.completeChannel(e, Ui, t, void 0, -1, 38);
		const u = this.guestTidForChannel(e);
		this.callbacks.onExec(e.pid, f, h, d, u).then((r) => {
			r < 0 && this.finishFailedExec(e, Ui, t, -r >>> 0);
		}).catch((r) => {
			console.error(`[kernel] execveat error for pid ${e.pid}:`, r), this.finishFailedExec(e, Ui, t, 5);
		});
	}
	handleClone(e, t) {
		if (!this.callbacks.onClone) return void this.completeChannel(e, Wi, t, void 0, -1, 38);
		const r = 1048576, i = t[0] >>> 0, n = t[2], s = t[4], o = new Uint8Array(e.memory.buffer), a = (e) => !(3 & e) && mi(o, e, 4);
		if (0 !== (i & r) && !a(n)) return void this.completeChannel(e, Wi, t, void 0, -1, hi);
		const c = 2097152 & i ? s : 0;
		if (0 !== c && !a(c)) return void this.completeChannel(e, Wi, t, void 0, -1, hi);
		const l = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		l.setUint32(4, Wi, !0);
		for (let _ = 0; _ < 6; _++) l.setBigInt64(8 + 8 * _, BigInt(t[_]), !0);
		const h = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			h(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const d = Number(l.getBigInt64(56, !0)), f = l.getUint32(64, !0);
		if (d <= 0) {
			const r = d < 0 ? f : 5;
			this.completeChannel(e, Wi, t, void 0, -1, r);
			return;
		}
		const u = d;
		let p, m, g = !1;
		const y = () => {
			let t;
			p && Qn.delete(p);
			const r = m?.attachedChannelOffset;
			if (void 0 !== r) {
				if (this.processes.get(e.pid)?.memory === e.memory) try {
					this.removeChannel(e.pid, r);
				} catch (i) {
					t = i;
				}
				m.attachedChannelOffset = void 0;
			}
			this.threadCtidPtrs.delete(`${e.pid}:${u}`), g && (new DataView(e.memory.buffer).setInt32(n, 0, !0), g = !1);
			try {
				this.rollbackKernelThread(e.pid, u);
			} catch (i) {
				throw i;
			}
			if (void 0 !== t) throw t;
		};
		let w;
		try {
			0 !== (i & r) && (new DataView(e.memory.buffer).setInt32(n, u, !0), g = !0);
			const s = new DataView(e.memory.buffer, e.channelOffset), o = s.getUint32(72, !0), a = s.getUint32(76, !0), l = t[1], h = t[3];
			0 !== c && this.threadCtidPtrs.set(`${e.pid}:${u}`, c);
			const d = function(e, t, r, i, n, s, o, a, c) {
				const l = Object.freeze({
					[Jn]: !0,
					pid: t,
					tid: r,
					fnPtr: i,
					argPtr: n,
					stackPtr: s,
					tlsPtr: o,
					ctidPtr: a,
					memory: c
				}), h = {
					owner: e,
					pid: t,
					tid: r,
					fnPtr: i,
					argPtr: n,
					memory: c
				};
				return Qn.set(l, h), {
					attachment: l,
					pending: h
				};
			}(this, e.pid, u, o, a, l, h, c, e.memory);
			p = d.attachment, m = d.pending, w = Promise.resolve(this.callbacks.onClone(p));
		} catch (b) {
			try {
				y();
			} catch (S) {
				throw S;
			}
			throw b;
		}
		w.then(() => {
			if (p && Qn.delete(p), this.isAsyncChannelProcessActive(e)) {
				if (void 0 === m?.attachedChannelOffset) {
					try {
						y();
					} catch (S) {
						this.terminateForKernelProtocolFailure(e, `clone callback did not attach tid ${u}, and rollback failed: ${S instanceof Error ? S.message : String(S)}`);
						return;
					}
					console.error(`[kernel-worker] onClone returned without attaching kernel tid ${u}`), this.completeChannel(e, Wi, t, void 0, -1, 12);
					return;
				}
				this.completeChannel(e, Wi, t, void 0, u, 0);
			}
		}).catch((r) => {
			try {
				y();
			} catch (S) {
				this.isAsyncChannelProcessActive(e) && this.terminateForKernelProtocolFailure(e, `could not roll back allocated tid ${u}: ${S instanceof Error ? S.message : String(S)}`);
				return;
			}
			this.isAsyncChannelProcessActive(e) && (console.error(`[kernel-worker] onClone failed: ${r}`), this.completeChannel(e, Wi, t, void 0, -1, 12));
		});
	}
	handleExit(e, t, r) {
		const i = r[0], n = this.isMainProcessChannel(e);
		if (t === Di && !n) {
			const t = this.guestTidForChannel(e);
			this.finalizeThreadExit(e.pid, t, e.channelOffset), this.completeChannelRaw(e, 0, 0), this.callbacks.onThreadExit?.(e.pid, t, e.channelOffset);
			return;
		}
		if (this.releaseAllSharedMemoryForProcess(e.pid), this.getProcessExitSignal(e.pid) > 0) return void (this.hostReaped.has(e.pid) || this.handleProcessTerminated(e));
		{
			const r = new DataView(this.kernelMemory.buffer, this.scratchOffset);
			r.setUint32(4, t, !0), r.setBigInt64(8, BigInt(i), !0);
			const n = this.kernelInstance.exports.kernel_handle_channel;
			this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				n(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch {} finally {
				this.currentHandlePid = 0;
			}
		}
		const s = this.kernelInstance.exports.kernel_get_process_state;
		let o;
		try {
			if (!s) throw new Error("Kernel missing required kernel_get_process_state export");
			o = s(e.pid);
		} catch (c) {
			this.terminateForKernelProtocolFailure(e, `could not verify exit state for process ${e.pid}: ${c instanceof Error ? c.message : String(c)}`);
			return;
		}
		if (2 !== o) return void this.terminateForKernelProtocolFailure(e, `kernel exit left process ${e.pid} in state ${o}`);
		this.drainAndProcessWakeupEvents();
		const a = e.pid;
		if (this.discardStoppedChannelStateForProcess(a), this.hostReaped.has(a)) return this.completeProcessExitHandshake(e, t), this.scheduleWakeBlockedRetries(), void (this.callbacks.onExit && this.callbacks.onExit(a, i));
		this.hostReaped.add(a), this.notifyParentOfExitedProcess(a), this.completeProcessExitHandshake(e, t), this.scheduleWakeBlockedRetries(), this.callbacks.onExit && this.callbacks.onExit(a, i);
	}
	handleProcessTerminated(e) {
		const t = e.pid;
		if (this.discardStoppedChannelStateForProcess(t), this.hostReaped.has(t)) return;
		const r = this.getProcessExitSignal(t);
		this.hostReaped.add(t), this.releaseAllSharedMemoryForProcess(t), this.drainAndProcessWakeupEvents(), this.notifyParentOfExitedProcess(t), this.callbacks.onExit && this.callbacks.onExit(t, r > 0 ? 128 + r : -1);
	}
	finalizeExitedProcessBeforeLifecycleNotification(e) {
		const t = this.kernelInstance.exports.kernel_get_process_state;
		if (!t || 2 !== t(e)) return !1;
		if (this.discardStoppedChannelStateForProcess(e), this.hostReaped.has(e)) return !0;
		this.cancelPendingSleepsForProcess(e);
		const r = this.processes.get(e)?.channels[0];
		return r ? this.handleProcessTerminated(r) : this.finalizeExecHandoffTermination(e), !0;
	}
	notifyHostProcessCrashed(e, t = 11) {
		if (this.hostReaped.has(e)) return;
		const r = this.kernelInstance.exports.kernel_mark_process_signaled;
		if (!r) throw new Error("Kernel missing required kernel_mark_process_signaled export");
		const i = r(e, t);
		if (0 !== i) throw new Error(`Kernel rejected signal-death transition for process ${e}: ${i < 0 ? "errno " + -i : `invalid result ${i}`}`);
		this.discardStoppedChannelStateForProcess(e), this.hostReaped.add(e), this.releaseAllSharedMemoryForProcess(e), this.drainAndProcessWakeupEvents(), this.notifyParentOfExitedProcess(e);
	}
	reapKilledProcessesAfterSyscall() {
		const e = Array.from(this.processes.keys());
		for (const t of e) {
			if (this.getProcessExitSignal(t) <= 0) continue;
			if (this.hostReaped.has(t)) continue;
			this.cancelPendingSleepsForProcess(t);
			const e = this.processes.get(t)?.channels[0];
			e && this.handleProcessTerminated(e);
		}
	}
	getProcessExitSignal(e) {
		const t = this.kernelInstance.exports.kernel_get_process_exit_signal;
		if (!t) throw new Error("Kernel missing required kernel_get_process_exit_signal export");
		return t(e);
	}
	finishSignalTermination(e) {
		return !(this.getProcessExitSignal(e.pid) <= 0) && (this.cancelPendingSleepsForProcess(e.pid), this.handleProcessTerminated(e), !0);
	}
	finalizeExecHandoffTermination(e) {
		const t = this.getProcessExitSignal(e);
		return t <= 0 ? t : (this.discardStoppedChannelStateForProcess(e), this.hostReaped.has(e) || (this.hostReaped.add(e), this.releaseAllSharedMemoryForProcess(e), this.notifyParentOfExitedProcess(e), this.callbacks.onExit && this.callbacks.onExit(e, 128 + t)), t);
	}
	finalizePendingChildTermination(e) {
		const t = this.finalizeExecHandoffTermination(e);
		if (-1 !== t) {
			this.cleanupTcpListeners(e);
			for (const t of Array.from(this.epollInterests.keys())) t.startsWith(`${e}:`) && this.epollInterests.delete(t);
		}
		return t;
	}
	hostReaped = /* @__PURE__ */ new Set();
	handleWaitpid(e, t) {
		const r = t[0], i = t[1], n = t[2] >>> 0, s = t[3], o = e.pid;
		if (this.pendingCancels.delete(e)) return this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
		if (-12 & n) return void this.completeWaitpid(e, t, -1, di);
		if (!this.isOptionalGuestOutputRangeValid(e, i, 4) || !this.isOptionalGuestOutputRangeValid(e, s, 144)) return void this.completeWaitpid(e, t, -1, hi);
		const a = this.wait4EventMask(n), c = this.pollWaitableChild(e, r, a, 0);
		if ("error" === c.kind) return void this.completeWaitpid(e, t, -1, c.errno);
		if ("event" === c.kind) return this.writeWait4Result(e, i, s, c), void this.completeWaitpid(e, t, c.childPid, 0);
		if (1 & n) return void this.completeWaitpid(e, t, 0, 0);
		const l = {
			parentPid: o,
			channel: e,
			origArgs: t,
			pid: r,
			options: n,
			syscallNr: Vi
		};
		this.interruptWaiterWithPendingSignal(l) || this.waitingForChild.push(l);
	}
	wait4EventMask(e) {
		let t = 1;
		return 2 & e && (t |= 2), 8 & e && (t |= 4), t;
	}
	waitidEventMask(e) {
		let t = 0;
		return 4 & e && (t |= 1), 2 & e && (t |= 2), 8 & e && (t |= 4), t;
	}
	pollWaitableChild(e, t, r, i) {
		const n = (0, this.kernelInstance.exports.kernel_wait_child_poll)(e.pid, this.guestTidForChannel(e), t, r, i, this.toKernelPtr(this.scratchOffset));
		if (n > 0) {
			const e = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, 160), t = new Uint8Array(160);
			t.set(e);
			const r = new DataView(t.buffer), i = t.subarray(16, 160);
			return {
				kind: "event",
				childPid: n,
				waitStatus: r.getInt32(0, !0),
				siCode: r.getInt32(4, !0),
				siStatus: r.getInt32(8, !0),
				childUid: r.getUint32(12, !0),
				rusage: i
			};
		}
		return 0 === n ? { kind: "running" } : {
			kind: "error",
			errno: -n >>> 0
		};
	}
	isOptionalGuestOutputRangeValid(e, t, r) {
		return 0 === t || mi(new Uint8Array(e.memory.buffer), t, r);
	}
	isRequiredGuestOutputRangeValid(e, t, r) {
		return mi(new Uint8Array(e.memory.buffer), t, r);
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
		const r = this.kernelInstance.exports.kernel_has_sa_nocldwait;
		if (r && 1 === r(t)) return this.consumeExitedChild(t, e), void this.wakeWaitingParent(t);
		this.sendSignalToProcess(t, 17);
	}
	writeWait4Result(e, t, r, i) {
		const n = new Uint8Array(e.memory.buffer);
		0 !== t && new DataView(e.memory.buffer).setInt32(t, i.waitStatus, !0), 0 !== r && n.set(i.rusage, r);
	}
	completeWaitpid(e, t, r, i) {
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || this.completeChannel(e, Vi, t, void 0, r, i);
	}
	completeWaitid(e, t, r, i) {
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || this.completeChannel(e, qi, t, void 0, r, i);
	}
	interruptWaiterWithPendingSignal(e) {
		const t = this.dequeueSignalForDelivery(e.channel);
		return !!this.finishSignalTermination(e.channel) || !(t <= 0) && (this.completeChannel(e.channel, e.syscallNr, e.origArgs, void 0, -1, 4), !0);
	}
	interruptWaitingChildForSignal(e, t) {
		this.wakeWaitingParent(e);
		const r = (0, this.kernelInstance.exports.kernel_pick_signal_target_tid)(e, t);
		if (r <= 0) return !1;
		const i = this.waitingForChild.findIndex((t) => t.parentPid === e && this.isRegisteredChannel(t.channel) && this.guestTidForChannel(t.channel) === r);
		if (i < 0) return !1;
		const [n] = this.waitingForChild.splice(i, 1);
		return !!this.interruptWaiterWithPendingSignal(n) || (this.waitingForChild.splice(i, 0, n), !1);
	}
	interruptWaitingChildForDirectedSignal(e, t) {
		this.wakeWaitingParent(e);
		if ((0, this.kernelInstance.exports.kernel_thread_has_deliverable)(e, t) <= 0) return !1;
		const r = this.waitingForChild.findIndex((r) => r.parentPid === e && this.isRegisteredChannel(r.channel) && this.guestTidForChannel(r.channel) === t);
		if (r < 0) return !1;
		const [i] = this.waitingForChild.splice(r, 1);
		return !!this.interruptWaiterWithPendingSignal(i) || (this.waitingForChild.splice(r, 0, i), !1);
	}
	interruptWaitingChildrenForGeneratedSignal(e) {
		if (e <= 0) return;
		const t = this.waitingForChild ?? [], r = new Set(t.map((e) => e.parentPid));
		for (const i of r) this.interruptWaitingChildForSignal(i, e);
	}
	wakeWaitingParent(e) {
		this.waitingForChild ??= [];
		const t = [];
		for (let r = 0; r < this.waitingForChild.length;) {
			const i = this.waitingForChild[r];
			if (i.parentPid !== e) {
				r++;
				continue;
			}
			if (!this.isRegisteredChannel(i.channel)) {
				this.waitingForChild.splice(r, 1);
				continue;
			}
			const n = i.syscallNr === qi ? this.waitidEventMask(i.options) : this.wait4EventMask(i.options), s = i.syscallNr === qi ? i.options & oe : 0, o = this.pollWaitableChild(i.channel, i.pid, n, s);
			"running" !== o.kind ? (this.waitingForChild.splice(r, 1), t.push({
				waiter: i,
				poll: o
			})) : r++;
		}
		for (const { waiter: r, poll: i } of t) "error" !== i.kind ? r.syscallNr === qi ? (this.writeWaitidResult(r.channel, r.origArgs[2], r.origArgs[4], i), this.completeWaitid(r.channel, r.origArgs, 0, 0)) : (this.writeWait4Result(r.channel, r.origArgs[1], r.origArgs[3], i), this.completeWaitpid(r.channel, r.origArgs, i.childPid, 0)) : r.syscallNr === qi ? this.completeWaitid(r.channel, r.origArgs, -1, i.errno) : this.completeWaitpid(r.channel, r.origArgs, -1, i.errno);
	}
	recheckDeferredWaitpids() {
		const e = /* @__PURE__ */ new Set();
		for (let t = this.waitingForChild.length - 1; t >= 0; t--) {
			const r = this.waitingForChild[t];
			if (r.pid > 0 || -1 === r.pid) continue;
			const i = r.syscallNr === qi ? this.waitidEventMask(r.options) : this.wait4EventMask(r.options), n = oe, s = this.pollWaitableChild(r.channel, r.pid, i, n);
			"error" === s.kind ? (this.waitingForChild.splice(t, 1), r.syscallNr === qi ? this.completeWaitid(r.channel, r.origArgs, -1, s.errno) : this.completeWaitpid(r.channel, r.origArgs, -1, s.errno)) : "event" === s.kind && e.add(r.parentPid);
		}
		for (const t of e) this.wakeWaitingParent(t);
	}
	handleWaitid(e, t) {
		const r = t[0], i = t[1], n = t[2], s = t[3] >>> 0, o = t[4], a = e.pid, c = this.waitidToWaitPid(r, i);
		if (this.pendingCancels.delete(e)) return this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
		const l = this.waitidEventMask(s);
		if (void 0 === c || -16777232 & s || 0 === l) return void this.completeWaitid(e, t, -1, di);
		if (!this.isRequiredGuestOutputRangeValid(e, n, 128) || !this.isOptionalGuestOutputRangeValid(e, o, 144)) return void this.completeWaitid(e, t, -1, hi);
		const h = this.pollWaitableChild(e, c, l, s & oe);
		if ("error" === h.kind) return void this.completeWaitid(e, t, -1, h.errno);
		if ("event" === h.kind) return this.writeWaitidResult(e, n, o, h), void this.completeWaitid(e, t, 0, 0);
		if (1 & s) return new Uint8Array(e.memory.buffer, n, 128).fill(0), void this.completeWaitid(e, t, 0, 0);
		const d = {
			parentPid: a,
			channel: e,
			origArgs: t,
			pid: c,
			options: s,
			syscallNr: qi
		};
		this.interruptWaiterWithPendingSignal(d) || this.waitingForChild.push(d);
	}
	waitidToWaitPid(e, t) {
		if (Number.isSafeInteger(t)) return 1 === e ? t > 0 && t <= 2147483647 ? t : void 0 : 2 === e ? t >= 0 && t <= 2147483647 ? 0 === t ? 0 : -t : void 0 : 0 === e ? -1 : void 0;
	}
	writeWaitidResult(e, t, r, i) {
		const n = new Uint8Array(e.memory.buffer), s = new DataView(e.memory.buffer);
		n.fill(0, t, t + 128), s.setInt32(t + 0, 17, !0), s.setInt32(t + 8, i.siCode, !0);
		const o = 8 === this.getPtrWidth(e.pid) ? 16 : 12;
		s.setInt32(t + o, i.childPid, !0), s.setUint32(t + o + 4, i.childUid, !0), s.setInt32(t + o + 8, i.siStatus, !0), 0 !== r && n.set(i.rusage, r);
	}
	handleFutex(e, t) {
		const r = t[0], i = t[1], n = t[2], s = -385 & i, o = new Int32Array(e.memory.buffer), a = r >>> 2;
		if (0 === s || 9 === s) {
			if (this.pendingCancels.has(e)) return this.pendingCancels.delete(e), this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
			if (Atomics.load(o, a) !== n) return this.completeChannelRaw(e, -11, li), void this.relistenChannel(e);
			let r;
			const i = t[3];
			if (0 !== i) {
				const t = new DataView(e.memory.buffer), n = Number(t.getBigInt64(i, !0)), s = Number(t.getBigInt64(i + 8, !0));
				if (n < 0 || 0 === n && s <= 0) return this.completeChannelRaw(e, -110, 110), void this.relistenChannel(e);
				r = 1e3 * n + Math.ceil(s / 1e6), r <= 0 && (r = 1), r > 2147483647 && (r = 2147483647);
			}
			const s = Atomics.waitAsync(o, a, n);
			if (s.async) {
				let t, i = !1;
				const n = () => !i && (i = !0, void 0 !== t && clearTimeout(t), this.pendingFutexWaits.delete(e), !0), c = (t, r) => {
					n() && this.isRegisteredChannel(e) && (this.completeChannelRaw(e, t, r), e.consecutiveSyscalls = 0, this.relistenChannel(e));
				}, l = () => {
					Atomics.notify(o, a);
				}, h = (e, t) => {
					l(), c(e, t);
				}, d = () => {
					l(), n();
				};
				this.pendingFutexWaits.set(e, {
					futexIndex: a,
					interrupt: h,
					retire: d
				}), s.value.then(() => {
					c(0, 0);
				}), void 0 !== r && (t = setTimeout(() => {
					h(-110, 110);
				}, r));
			} else this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
			return;
		}
		if (1 === s || 10 === s) {
			const t = Atomics.notify(o, a, n);
			this.completeChannelRaw(e, t, 0), this.relistenChannel(e);
			return;
		}
		if (3 === s || 4 === s) {
			const r = t[3], i = Atomics.notify(o, a, n + r);
			this.completeChannelRaw(e, i, 0), this.relistenChannel(e);
			return;
		}
		if (5 === s) {
			const r = t[3], i = t[4] >>> 2;
			let s = Atomics.notify(o, a, n);
			s += Atomics.notify(o, i, r), this.completeChannelRaw(e, s, 0), this.relistenChannel(e);
			return;
		}
		this.completeChannelRaw(e, -38, 38), this.relistenChannel(e);
	}
	notifyThreadExit(e, t) {
		if (!this.kernelInstance) throw new Error("Kernel is not initialized for thread cleanup");
		const r = this.kernelInstance.exports.kernel_thread_exit;
		if (!r) throw new Error("Kernel missing required kernel_thread_exit export");
		const i = r(e, t);
		if (0 !== i) {
			const r = i < 0 ? -i : 5;
			throw new ui(e, t, r, `Kernel could not remove tid ${t} from process ${e}: errno ${r}`);
		}
	}
	rollbackKernelThread(e, t) {
		try {
			this.notifyThreadExit(e, t);
		} catch (r) {
			if (r instanceof ui && 3 === r.errno) return;
			throw r;
		}
	}
	finalizeThreadExit(e, t, r) {
		const i = `${e}:${t}`, n = this.threadCtidPtrs.get(i), s = this.activeChannels.find((t) => t.pid === e && t.channelOffset === r)?.memory ?? this.processes.get(e)?.memory;
		this.notifyThreadExit(e, t);
		try {
			if (n && 0 !== n) {
				if (!s) throw new ui(e, t, hi, `Missing process memory for clear-TID of tid ${t} in process ${e}`);
				const r = new Uint8Array(s.buffer);
				if (3 & n || !mi(r, n, 4)) throw new ui(e, t, hi, `Invalid clear-TID pointer ${n} for tid ${t} in process ${e}`);
				new DataView(s.buffer).setInt32(n, 0, !0);
				const i = new Int32Array(s.buffer);
				Atomics.notify(i, n >>> 2, 1);
			}
		} finally {
			this.threadCtidPtrs.delete(i), this.removeChannel(e, r);
		}
	}
	firePosixTimer(e, t, r) {
		const i = (0, this.kernelInstance.exports.kernel_posix_timer_fire)(e, t);
		i < 0 || (i > 0 ? this.wakePendingSignalWaits(e, r, i) : (this.wakePendingSignalWaits(e, r), this.sendSignalToProcess(e, r, !1)));
	}
	wakePendingSignalWaits(e, t, r) {
		const i = Array.from(this.pendingSignalWaits.entries()).filter(([, i]) => {
			if (i.channel.pid !== e) return !1;
			if (void 0 !== r && this.guestTidForChannel(i.channel) !== r) return !1;
			const n = i.origArgs[0] >>> 0;
			return !(0 === n || t <= 0 || t > 64) && 0n != (new DataView(i.channel.memory.buffer).getBigUint64(n, !0) & 1n << BigInt(t - 1));
		});
		for (const [n, s] of i) this.pendingSignalWaits.get(n) === s && (clearTimeout(s.timer), this.pendingSignalWaits.delete(n), this.isRegisteredChannel(s.channel) && this.retrySyscall(s.channel));
	}
	cleanupPendingSignalWaits(e) {
		for (const [t, r] of this.pendingSignalWaits ?? []) r.channel.pid === e && (clearTimeout(r.timer), this.pendingSignalWaits.delete(t), this.signalWaitDeadlines?.delete(t));
		for (const [t, r] of this.signalWaitDeadlines ?? []) r.pid === e && this.signalWaitDeadlines.delete(t);
	}
	sendSignalToProcess(e, t, r = !0) {
		if (!this.kernelInstance || !this.kernelMemory) return;
		if (r) {
			const r = new DataView(this.kernelMemory.buffer, this.scratchOffset);
			r.setUint32(4, Li, !0), r.setBigInt64(8, BigInt(e), !0), r.setBigInt64(16, BigInt(t), !0);
			for (let e = 2; e < 6; e++) r.setBigInt64(8 + 8 * e, 0n, !0);
			const i = this.kernelInstance.exports.kernel_handle_channel;
			try {
				this.bindKernelTid(e, e);
			} catch {
				return;
			}
			this.currentHandlePid = e;
			try {
				i(this.toKernelPtr(this.scratchOffset), e);
			} catch (ys) {
				console.error(`[sendSignalToProcess] kernel threw for pid=${e} sig=${t}: ${ys}`);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
		}
		if (r && this.wakePendingSignalWaits(e, t), this.drainAndProcessWakeupEvents(), this.reapKilledProcessesAfterSyscall(), this.getProcessExitSignal(e) > 0) return;
		if (this.interruptWaitingChildForSignal(e, t)) return;
		const i = (0, this.kernelInstance.exports.kernel_pick_signal_target_tid)(e, t);
		if (i <= 0) return;
		if ((0, this.kernelInstance.exports.kernel_thread_has_deliverable)(e, i) <= 0) return;
		const n = Array.from(this.pendingSleeps.entries()).find(([t]) => t.pid === e && this.guestTidForChannel(t) === i);
		if (n) {
			const [e, t] = n;
			clearTimeout(t.timer), this.pendingSleeps.delete(e), this.completeSleepWithSignalCheck(t.channel, t.syscallNr, t.origArgs, t.retVal, t.errVal);
		}
		const s = Array.from(this.pendingPollRetries.entries()).filter(([, t]) => t.channel.pid === e);
		for (const [l, h] of s) this.pendingPollRetries.get(l) === h && (h.timer && clearTimeout(h.timer), this.pendingPollRetries.delete(l), this.processes.has(e) && this.retrySyscall(h.channel));
		const o = this.pendingAdvisoryLockRetries, a = o ? Array.from(o.entries()).filter(([, t]) => t.channel.pid === e) : [];
		for (const [l, h] of a) o.get(l) === h && (clearTimeout(h.timer), o.delete(l), this.isRegisteredChannel(h.channel) && this.retrySyscall(h.channel));
		const c = Array.from(this.pendingSelectRetries.entries()).filter(([, t]) => t.channel.pid === e);
		for (const [l, h] of c) this.pendingSelectRetries.get(l) === h && (clearTimeout(h.timer), clearImmediate(h.timer), this.pendingSelectRetries.delete(l), this.processes.has(e) && (h.syscallNr === Ii ? this.handleSelect(h.channel, h.origArgs) : this.handlePselect6(h.channel, h.origArgs)));
	}
	ensureFixedMmapProcessMemoryCapacity(e, t) {
		const r = t[0] >>> 0, i = r + (t[1] >>> 0);
		if (!Number.isSafeInteger(i) || i < r) return !1;
		if (i <= e.memory.buffer.byteLength) return !0;
		try {
			const t = this.processes.get(e.pid)?.ptrWidth ?? 4;
			return si(e.memory, i, t), e.memory.buffer.byteLength < i ? !1 : (this.observeProcessMemoryTarget(e.memory, e.memory.buffer), this.kernel.framebuffers.rebindMemory(e.pid), !0);
		} catch {
			return !1;
		}
	}
	ensureProcessMemoryCovers(e, t, r, i, n) {
		let s = 0, o = 0, a = 0;
		r === en ? i >= 0 && (s = i) : r === Zi ? i >= 0 && (o = i, a = n[1], s = o + a) : r === tn && i >= 0 && (o = i, a = n[2], s = o + a);
		const c = t.buffer.byteLength;
		if (s > 0 && s > c) si(t, s, this.processes.get(e)?.ptrWidth ?? 4), this.observeProcessMemoryTarget(t, t.buffer), this.kernel.framebuffers.rebindMemory(e);
		if (a > 0) {
			const e = 65536, i = Math.ceil(a / e) * e, s = t.buffer.byteLength;
			let c = o;
			const l = Math.min(o + i, s);
			if (r === tn) {
				const t = n[0] >>> 0, r = n[1] >>> 0;
				if (o === t && r > 0) {
					const i = Math.ceil((t + r) / e) * e;
					c = Math.max(c, i);
				}
			}
			c < l && new Uint8Array(t.buffer, c, l - c).fill(0);
		}
		if (r === tn && i >= 0 && i !== n[0] && 0 !== n[0] && n[1] > 0) {
			const e = n[0] >>> 0, r = n[1] >>> 0, s = i >>> 0, o = n[2] >>> 0, a = Math.min(r, o);
			if (a > 0) {
				const r = t.buffer, i = r.byteLength;
				if (e + a <= i && s + a <= i) {
					const t = new Uint8Array(r, e, a);
					new Uint8Array(r, s, a).set(t);
				}
			}
		}
	}
	trackAnonymousSharedMapping(e, t, r) {
		const i = r[1] >>> 0;
		if (0 === i) return;
		const n = new Uint8Array(e.memory.buffer);
		if (t + i > n.length) return;
		const s = `anon:${e.pid}:${t}:${this.nextAnonymousSharedBackingId++}`, o = n.slice(t, t + i);
		this.anonymousSharedBackings.set(s, {
			key: s,
			bytes: o.slice(),
			refCount: 1,
			version: 0
		});
		let a = this.sharedMappings.get(e.pid);
		a || (a = /* @__PURE__ */ new Map(), this.sharedMappings.set(e.pid, a)), a.set(t, {
			fd: -1,
			fileOffset: 0,
			len: i,
			writable: !!(2 & r[2]),
			backingKind: "anonymous",
			backingKey: s,
			snapshot: o,
			seenVersion: 0
		});
	}
	synchronizeSharedMemoryForBoundary(e) {
		const t = this.processes?.get(e.pid);
		t && t.memory !== e.memory || this.processes && !t || 0 === (this.sharedMappings?.size ?? 0) && 0 === (this.shmMappings?.size ?? 0) || (this.syncAnonymousSharedMappingsFromProcess(e), this.syncFileSharedMappingsFromProcess(e), this.syncSysvShmMappingsFromProcess(e));
	}
	syncAnonymousSharedMappingsFromProcess(e, t = {}) {
		const r = this.sharedMappings?.get(e.pid);
		if (!r) return;
		const i = new Uint8Array(e.memory.buffer);
		for (const [n, s] of r) {
			if (!s.backingKey || !s.snapshot) continue;
			const e = this.anonymousSharedBackings?.get(s.backingKey);
			if (!e || n + s.len > i.length) continue;
			const r = (s.seenVersion ?? 0) !== e.version;
			if (!t.force && e.refCount <= 1 && !r) continue;
			let o = !1;
			if (s.writable) for (let t = 0; t < s.len; t += 4096) {
				const r = Math.min(4096, s.len - t);
				this.rangeDiffersFromSnapshot(i, n + t, s.snapshot, t, r) && this.mergeChangedByteRuns(i, n + t, s.snapshot, t, e.bytes, s.fileOffset + t, r) && (o = !0);
			}
			if (o && e.version++, o || r) {
				const t = e.bytes.slice(s.fileOffset, s.fileOffset + s.len);
				i.set(t, n), s.snapshot = t;
			}
			s.seenVersion = e.version;
		}
	}
	mapSharedMmapFromFile(e, t, r) {
		if (r[1] >>> 0 == 0) return { kind: "mapped" };
		const i = this.prepareSharedMmapFromFile(e, r);
		return "prepared" !== i.kind ? i : this.registerPreparedSharedMmap(e, t, i.context);
	}
	prepareSharedMmapFromFile(e, t) {
		const r = t[4], i = t[1] >>> 0, n = t[5], s = n * Pn;
		if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(s)) return {
			kind: "error",
			errno: di
		};
		const o = !!(2 & t[2]), a = this.getFdStatForSharedMapping(e, r);
		if ("error" === a.kind) return a;
		const c = a.value;
		if (32768 != (61440 & c.mode)) return { kind: "unsupported" };
		if (null === c.hostHandle) return {
			kind: "error",
			errno: 95
		};
		const l = this.getFdAccessModeForSharedMapping(e, r);
		if ("error" === l.kind) return l;
		const h = l.value;
		if (1 === h) return {
			kind: "error",
			errno: 13
		};
		const d = 2 === h && this.fdSupportsMmapWriteback(e.pid, r);
		if (o && !d) return {
			kind: "error",
			errno: 13
		};
		const f = this.resolveSharedMmapBackingKey(c, c.hostHandle);
		if ("error" === f.kind) return f;
		const u = f.value, p = this.getOrCreateSharedMmapBacking(u, c, d);
		if ("error" === p.kind) return p;
		const m = p.value;
		try {
			this.publishSharedMmapBackingObservers(m), this.ensureSharedMmapBackingRangeLoaded(m, s, i);
		} catch (ys) {
			return this.discardUnreferencedSharedMmapBacking(m), {
				kind: "error",
				errno: this.sharedMmapErrno(ys)
			};
		}
		return m.refCount++, {
			kind: "prepared",
			context: {
				fd: r,
				fileOffset: s,
				len: i,
				writable: o,
				writeAllowed: d,
				backing: m
			}
		};
	}
	registerPreparedSharedMmap(e, t, r) {
		const { fd: i, fileOffset: n, len: s, writable: o, writeAllowed: a, backing: c } = r;
		try {
			const l = new Uint8Array(e.memory.buffer);
			if (t + s > l.length) return this.releasePreparedSharedMmap(r), {
				kind: "error",
				errno: 5
			};
			const h = this.readSharedMmapBackingRange(c, n, s);
			l.set(h, t);
			let d = this.sharedMappings.get(e.pid);
			return d || (d = /* @__PURE__ */ new Map(), this.sharedMappings.set(e.pid, d)), this.sharedMmapFdCache.set(this.sharedMmapFdCacheKey(e.pid, i), { backingKey: c.key }), d.set(t, {
				fd: i,
				fileOffset: n,
				len: s,
				writable: o,
				writeAllowed: a,
				backingKind: "file",
				backingKey: c.key,
				snapshot: h,
				seenVersion: c.version
			}), { kind: "mapped" };
		} catch (ys) {
			return this.releasePreparedSharedMmap(r), {
				kind: "error",
				errno: this.sharedMmapErrno(ys)
			};
		}
	}
	resolveSharedMmapBackingKey(e, t) {
		try {
			const r = this.io.fileHandleIdentity?.(t, e.dev, e.ino) ?? null;
			return r ? {
				kind: "ok",
				value: r
			} : {
				kind: "error",
				errno: 95
			};
		} catch (ys) {
			return {
				kind: "error",
				errno: this.sharedMmapErrno(ys)
			};
		}
	}
	getFdStatForSharedMapping(e, t) {
		const r = this.kernelInstance.exports.kernel_handle_channel, i = this.scratchOffset + 72, n = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		n.setUint32(4, ge, !0), n.setBigInt64(8, BigInt(t), !0), n.setBigInt64(16, BigInt(i), !0);
		for (let m = 2; m < 6; m++) n.setBigInt64(8 + 8 * m, 0n, !0);
		const s = this.currentHandlePid;
		let o = null;
		try {
			this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid, o = this.kernel.withFstatHandleCapture(() => r(this.toKernelPtr(this.scratchOffset), e.pid)).handle;
		} catch {
			return {
				kind: "error",
				errno: 5
			};
		} finally {
			this.currentHandlePid = s;
		}
		if (this.finishSignalTermination(e)) return {
			kind: "error",
			errno: 4
		};
		const a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = Number(a.getBigInt64(56, !0)), l = a.getUint32(64, !0);
		if (0 !== c || 0 !== l) return {
			kind: "error",
			errno: l || (c < -1 ? -c : 5)
		};
		const h = new DataView(this.kernelMemory.buffer, i), d = h.getBigUint64(0, !0), f = h.getBigUint64(8, !0), u = h.getUint32(16, !0), p = h.getBigUint64(32, !0);
		return {
			kind: "ok",
			value: {
				dev: d,
				ino: f,
				size: p > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(p),
				mode: u,
				hostHandle: o
			}
		};
	}
	getFdPathForSharedMapping(e, t) {
		const r = this.kernelInstance.exports.kernel_get_fd_path;
		if (!r) return {
			kind: "error",
			errno: 38
		};
		const i = this.scratchOffset + 72;
		let n;
		try {
			n = r(e.pid, t, this.toKernelPtr(i), Math.min(4096, re));
		} catch {
			return {
				kind: "error",
				errno: 5
			};
		}
		return n < 0 ? {
			kind: "error",
			errno: -n
		} : 0 === n ? {
			kind: "error",
			errno: 2
		} : {
			kind: "ok",
			value: new TextDecoder().decode(new Uint8Array(this.kernelMemory.buffer).slice(i, i + n))
		};
	}
	getFdAccessModeForSharedMapping(e, t) {
		const r = this.kernelInstance.exports.kernel_handle_channel, i = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		i.setUint32(4, Ln, !0), i.setBigInt64(8, BigInt(t), !0), i.setBigInt64(16, BigInt(3), !0);
		for (let c = 2; c < 6; c++) i.setBigInt64(8 + 8 * c, 0n, !0);
		const n = this.currentHandlePid;
		try {
			this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid, r(this.toKernelPtr(this.scratchOffset), e.pid);
		} catch {
			return {
				kind: "error",
				errno: 5
			};
		} finally {
			this.currentHandlePid = n;
		}
		if (this.finishSignalTermination(e)) return {
			kind: "error",
			errno: 4
		};
		const s = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = Number(s.getBigInt64(56, !0)), a = s.getUint32(64, !0);
		return o < 0 || 0 !== a ? {
			kind: "error",
			errno: a || (o < -1 ? -o : 5)
		} : {
			kind: "ok",
			value: 3 & o
		};
	}
	getOrCreateSharedMmapBacking(e, t, r) {
		const i = t.hostHandle;
		if (null === i) return {
			kind: "error",
			errno: 95
		};
		const n = this.sharedMmapBackings.get(e);
		if (n) {
			if (r && !n.writable) {
				if (i === n.handle) return {
					kind: "error",
					errno: 5
				};
				try {
					this.kernel.retainHostFileHandle(i);
				} catch (ys) {
					return {
						kind: "error",
						errno: this.sharedMmapErrno(ys)
					};
				}
				const e = n.handle;
				n.handle = i, n.writable = !0, n.size = t.size, n.sizeValid = !0, this.kernel.releaseHostFileHandle(e);
			} else {
				const e = this.revalidateSharedMmapBacking(n);
				if (0 !== e) return {
					kind: "error",
					errno: e
				};
			}
			return {
				kind: "ok",
				value: n
			};
		}
		try {
			this.kernel.retainHostFileHandle(i);
		} catch (ys) {
			return {
				kind: "error",
				errno: this.sharedMmapErrno(ys)
			};
		}
		const s = {
			key: e,
			handle: i,
			writable: r,
			size: t.size,
			sizeValid: !0,
			pages: /* @__PURE__ */ new Map(),
			dirtyPages: /* @__PURE__ */ new Set(),
			refCount: 0,
			version: 0
		};
		return this.sharedMmapBackings.set(e, s), this.invalidateSharedMmapFdCache(), {
			kind: "ok",
			value: s
		};
	}
	revalidateSharedMmapBacking(e) {
		try {
			const t = this.io.fstat(e.handle);
			if (!Number.isSafeInteger(t.size) || t.size < 0) return e.sizeValid = !1, 5;
			if (32768 != (61440 & t.mode)) return e.sizeValid = !1, 5;
			const r = this.resolveSharedMmapBackingKey({
				dev: BigInt(t.dev),
				ino: BigInt(t.ino),
				mode: t.mode,
				size: t.size,
				hostHandle: e.handle
			}, e.handle);
			return "error" === r.kind || r.value !== e.key ? (e.sizeValid = !1, "error" === r.kind ? r.errno : 5) : (e.size = t.size, e.sizeValid = !0, 0);
		} catch (ys) {
			return e.sizeValid = !1, this.sharedMmapErrno(ys);
		}
	}
	sharedMmapErrno(e) {
		const t = Er(e);
		return t < 0 ? -t : t || 5;
	}
	discardUnreferencedSharedMmapBacking(e) {
		0 === e.refCount && this.sharedMmapBackings.get(e.key) === e && (e.dirtyPages.size > 0 || (this.kernel.releaseHostFileHandle(e.handle), this.sharedMmapBackings.delete(e.key), this.invalidateSharedMmapFdCache()));
	}
	ensureSharedMmapBackingRangeLoaded(e, t, r) {
		if (r <= 0) return;
		const i = Math.floor(t / Pn), n = Math.floor((t + r - 1) / Pn);
		for (let s = i; s <= n; s++) this.ensureSharedMmapBackingPageLoaded(e, s);
	}
	ensureSharedMmapBackingPageLoaded(e, t) {
		const r = e.pages.get(t);
		if (r) return r;
		if (!e.sizeValid) {
			const t = this.revalidateSharedMmapBacking(e);
			if (0 !== t) {
				const e = /* @__PURE__ */ new Error("Cannot determine MAP_SHARED backing size");
				throw e.code = t, e;
			}
		}
		const i = this.readSharedMmapBackingPage(e, t);
		return e.pages.set(t, i), i;
	}
	readSharedMmapBackingPage(e, t) {
		const r = new Uint8Array(Pn);
		if (!e.sizeValid) throw new Error("Unknown MAP_SHARED backing size");
		const i = t * Pn, n = Math.max(0, Math.min(Pn, e.size - i));
		if (0 === n) return r;
		let s = 0;
		for (; s < n;) {
			const t = n - s, o = this.io.read(e.handle, r.subarray(s), i + s, t);
			if (o <= 0 || o > t) throw new Error(`Invalid MAP_SHARED backing read length: ${o}`);
			s += o;
		}
		return r;
	}
	readSharedMmapBackingRange(e, t, r) {
		const i = new Uint8Array(r);
		let n = 0;
		for (; n < r;) {
			const s = t + n, o = Math.floor(s / Pn), a = s % Pn, c = Math.min(Pn - a, r - n);
			i.set(this.ensureSharedMmapBackingPageLoaded(e, o).subarray(a, a + c), n), n += c;
		}
		return i;
	}
	copyRangeToSharedMmapBacking(e, t, r, i) {
		let n = 0;
		for (; n < r.length;) {
			const s = t + n, o = Math.floor(s / Pn), a = s % Pn, c = Math.min(Pn - a, r.length - n), l = e.dirtyPages.has(o);
			this.ensureSharedMmapBackingPageLoaded(e, o).set(r.subarray(n, n + c), a), i ? e.dirtyPages.add(o) : l || e.dirtyPages.delete(o), n += c;
		}
	}
	syncFileSharedMappingsFromProcess(e, t = {}) {
		const r = this.sharedMappings?.get(e.pid);
		if (!r) return;
		const i = new Uint8Array(e.memory.buffer), n = [];
		for (const [o, a] of r) {
			if ("file" !== a.backingKind || !a.backingKey || !a.snapshot) continue;
			const e = this.sharedMmapBackings.get(a.backingKey);
			if (!e || o + a.len > i.length) continue;
			const r = (a.seenVersion ?? 0) !== e.version;
			!t.force && e.refCount <= 1 && !r || n.push({
				mapAddr: o,
				mapping: a,
				backing: e,
				snapshot: a.snapshot
			});
		}
		for (const { mapAddr: o, mapping: a, backing: c, snapshot: l } of n) {
			let e = !1;
			if (a.writable) for (let t = 0; t < a.len; t += Pn) {
				const r = Math.min(Pn, a.len - t);
				this.rangeDiffersFromSnapshot(i, o + t, l, t, r) && this.mergeChangedFileMappingRuns(c, i, o + t, l, t, a.fileOffset + t, r) && (e = !0);
			}
			e && c.version++;
		}
		const s = n.filter(({ mapping: e, backing: t }) => (e.seenVersion ?? 0) !== t.version).map(({ mapAddr: e, mapping: t, backing: r }) => ({
			mapAddr: e,
			mapping: t,
			backing: r,
			latest: this.readSharedMmapBackingRange(r, t.fileOffset, t.len)
		}));
		for (const { mapAddr: o, mapping: a, backing: c, latest: l } of s) i.set(l, o), a.snapshot = l, a.seenVersion = c.version;
	}
	publishSharedMmapBackingObservers(e) {
		if (e.refCount <= 0) return;
		const t = /* @__PURE__ */ new Set();
		for (const [r, i] of this.sharedMappings) for (const n of i.values()) if ("file" === n.backingKind && n.backingKey === e.key) {
			t.add(r);
			break;
		}
		for (const r of t) {
			const e = this.processes.get(r);
			if (!e) throw new Error(`Missing process memory for MAP_SHARED observer ${r}`);
			this.syncFileSharedMappingsFromProcess(e, { force: !0 });
		}
	}
	mergeChangedFileMappingRuns(e, t, r, i, n, s, o) {
		let a = !1, c = 0;
		for (; c < o;) {
			for (; c < o && t[r + c] === i[n + c];) c++;
			if (c >= o) break;
			const l = c;
			do
				c++;
			while (c < o && t[r + c] !== i[n + c]);
			this.copyRangeToSharedMmapBacking(e, s + l, t.subarray(r + l, r + c), !0), a = !0;
		}
		return a;
	}
	flushSharedMmapBackingRange(e, t, r) {
		if (r <= 0 || 0 === e.dirtyPages.size) return !0;
		if (!e.sizeValid) return !1;
		const i = t + r, n = Math.min(i, e.size);
		let s = !0;
		for (const o of Array.from(e.dirtyPages).sort((e, t) => e - t)) {
			const r = o * Pn, a = r + Pn;
			if (r >= e.size) {
				r < i && a > t && e.dirtyPages.delete(o);
				continue;
			}
			if (r >= n || a <= t) continue;
			const c = Math.max(t, r), l = Math.min(a, e.size), h = Math.min(n, l), d = this.ensureSharedMmapBackingPageLoaded(e, o).subarray(c - r, h - r);
			this.writeAllToSharedMmapBacking(e, d, c) ? c === r && h === l && e.dirtyPages.delete(o) : s = !1;
		}
		return s;
	}
	writeAllToSharedMmapBacking(e, t, r) {
		let i = 0;
		for (; i < t.length;) try {
			const n = this.io.write(e.handle, t.subarray(i), r + i, t.length - i);
			if (n <= 0) return !1;
			i += n;
		} catch {
			return !1;
		}
		return !0;
	}
	flushSharedMappingsBeforeFileSyscall(e, t, r) {
		if (0 === (this.sharedMmapBackings?.size ?? 0)) return !0;
		try {
			if (t === dn) {
				const t = this.resolveSharedMmapPath(e, r[0]);
				return "error" === t.kind || this.flushSharedBackingForPath(t.value);
			}
			if ((t === $n || t === Wn) && 512 & (t === $n ? r[1] : r[2])) {
				const i = this.resolveSharedMmapPath(e, t === $n ? r[0] : r[1], t === Wn ? r[0] : En);
				return "error" === i.kind || this.flushSharedBackingForPath(i.value);
			}
			return t !== Zi || 1 & r[3] || 32 & r[3] || !(r[4] >= 0) ? t === un ? (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, r[0]) && this.flushSharedBackingForFd(e, r[1])) : 290 === t || 291 === t ? (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, r[0]) && this.flushSharedBackingForFd(e, r[2])) : !this.syscallTouchesFdStorageBeforeKernel(t) || (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, r[0])) : (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, r[4]));
		} catch {
			return !1;
		}
	}
	syscallTouchesFdStorageBeforeKernel(e) {
		return e === sn || e === on || e === zn || e === Mn || e === nn || e === an || e === xn || e === Tn || e === cn || e === ln || e === hn || e === fn;
	}
	flushSharedBackingForFd(e, t) {
		if (t < 0) return !0;
		const r = this.findSharedMmapBackingForFd(e, t);
		if (!r) return !0;
		this.publishSharedMmapBackingObservers(r);
		const i = this.flushSharedMmapBackingRange(r, 0, Number.MAX_SAFE_INTEGER);
		return i && 0 === r.refCount && this.discardUnreferencedSharedMmapBacking(r), i;
	}
	resolveSharedMmapPath(e, t, r = -100) {
		try {
			const i = new Uint8Array(e.memory.buffer);
			if (t <= 0 || t >= i.length) return {
				kind: "error",
				errno: hi
			};
			const n = Math.min(i.length, t + 4096);
			let s = t;
			for (; s < n && 0 !== i[s];) s++;
			if (s === n) return {
				kind: "error",
				errno: 36
			};
			const o = new Uint8Array(s - t);
			o.set(i.subarray(t, s));
			const a = new TextDecoder().decode(o);
			if (!a) return {
				kind: "error",
				errno: 2
			};
			if (a.startsWith("/")) return {
				kind: "ok",
				value: this.normalizeSharedMmapPath(a)
			};
			let c;
			if (r !== En) {
				const t = this.getFdPathForSharedMapping(e, r);
				if ("error" === t.kind) return t;
				c = t.value;
			} else {
				const t = this.kernelInstance.exports.kernel_get_cwd;
				if (!t) return {
					kind: "error",
					errno: 38
				};
				const r = t(e.pid, this.toKernelPtr(this.scratchOffset), Math.min(4096, re));
				if (r < 0) return {
					kind: "error",
					errno: -r
				};
				if (0 === r) return {
					kind: "error",
					errno: 2
				};
				c = new TextDecoder().decode(new Uint8Array(this.kernelMemory.buffer).slice(this.scratchOffset, this.scratchOffset + r));
			}
			return {
				kind: "ok",
				value: this.normalizeSharedMmapPath(`${c}/${a}`)
			};
		} catch (ys) {
			return {
				kind: "error",
				errno: this.sharedMmapErrno(ys)
			};
		}
	}
	normalizeSharedMmapPath(e) {
		const t = [];
		for (const r of e.split("/")) r && "." !== r && (".." === r ? t.pop() : t.push(r));
		return `/${t.join("/")}`;
	}
	findSharedMmapBackingForPath(e) {
		if (0 === this.sharedMmapBackings.size) return null;
		try {
			const t = this.io.stat(e);
			if (32768 != (61440 & t.mode)) return null;
			const r = this.io.fileIdentity?.(e, BigInt(t.dev), BigInt(t.ino)) ?? null;
			return r ? this.sharedMmapBackings.get(r) ?? null : null;
		} catch {
			return null;
		}
	}
	flushSharedBackingForPath(e) {
		const t = this.findSharedMmapBackingForPath(e);
		if (!t) return !0;
		this.publishSharedMmapBackingObservers(t);
		const r = this.flushSharedMmapBackingRange(t, 0, Number.MAX_SAFE_INTEGER);
		return r && 0 === t.refCount && this.discardUnreferencedSharedMmapBacking(t), r;
	}
	handleSharedMappingsAfterFileSyscall(e, t, r, i, n) {
		if (0 !== (this.sharedMmapBackings?.size ?? 0) && 0 === n) {
			if ((t === $n || t === Wn) && i >= 0) return this.invalidateSharedMmapFdCache(e.pid, i), void (512 & (t === $n ? r[1] : r[2]) && this.reloadSharedMmapBackingForFd(e, i, 0));
			if (t !== Dn || 0 !== i) if (t === pn && i >= 0) this.invalidateSharedMmapFdCache(e.pid, i);
			else if ((t === mn || t === gn) && i >= 0) this.invalidateSharedMmapFdCache(e.pid, r[1]);
			else {
				if (t === Ln && i >= 0) {
					const t = r[1] >>> 0;
					if (0 === t || 1030 === t || 1028 === t) return void this.invalidateSharedMmapFdCache(e.pid, i);
				}
				if (t === an && i > 0) this.updateSharedMmapBackingFromProcessBuffer(e, r[0], r[1] >>> 0, i, r[3]);
				else if (t === nn && i > 0) this.reloadSharedMmapBackingForFd(e, r[0]);
				else if ((t === xn || t === Tn) && i > 0) this.reloadSharedMmapBackingForFd(e, r[0]);
				else if (t === un && i > 0) this.reloadSharedMmapBackingForFd(e, r[0]);
				else if ((290 === t || 291 === t) && i > 0) this.reloadSharedMmapBackingForFd(e, r[2]);
				else if (t !== hn || 0 !== i) if (t !== fn || 0 !== i) {
					if (t === dn && 0 === i) {
						const t = this.resolveSharedMmapPath(e, r[0]);
						"ok" === t.kind && this.reloadSharedMmapBackingForPath(t.value, r[1]);
					}
				} else this.reloadSharedMmapBackingForFd(e, r[0]);
				else this.reloadSharedMmapBackingForFd(e, r[0], r[1]);
			}
			else this.invalidateSharedMmapFdCache(e.pid, r[0]);
		}
	}
	updateSharedMmapBackingFromProcessBuffer(e, t, r, i, n) {
		if (i <= 0) return;
		const s = this.findSharedMmapBackingForFd(e, t);
		if (!s) return;
		if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(n + i)) return s.sizeValid = !1, void this.invalidateSharedMmapBackingPages(s);
		if (0 !== this.revalidateSharedMmapBacking(s)) return void this.invalidateSharedMmapBackingPages(s);
		const o = new Uint8Array(e.memory.buffer);
		if (r + i > o.length) this.reloadSharedMmapBackingRange(s, n, i);
		else try {
			this.copyRangeToSharedMmapBacking(s, n, o.subarray(r, r + i), !1), s.version++;
		} catch {
			this.invalidateSharedMmapBackingRange(s, n, i);
		}
	}
	reloadSharedMmapBackingForFd(e, t, r) {
		const i = this.findSharedMmapBackingForFd(e, t);
		return !i || this.reloadSharedMmapBacking(i, r);
	}
	reloadSharedMmapBackingForPath(e, t) {
		const r = this.findSharedMmapBackingForPath(e);
		return !r || this.reloadSharedMmapBacking(r, t);
	}
	reloadSharedMmapBacking(e, t) {
		if (void 0 !== t && Number.isSafeInteger(t) && t >= 0) e.size = t, e.sizeValid = !0;
		else if (0 !== this.revalidateSharedMmapBacking(e)) return this.invalidateSharedMmapBackingPages(e), !1;
		if (0 === e.pages.size) return e.version++, !0;
		const r = Array.from(e.pages.keys()), i = /* @__PURE__ */ new Map();
		try {
			for (const t of r) i.set(t, this.readSharedMmapBackingPage(e, t));
		} catch {
			return this.invalidateSharedMmapBackingPages(e, r), !1;
		}
		for (const [n, s] of i) e.pages.set(n, s), e.dirtyPages.delete(n);
		return e.version++, !0;
	}
	reloadSharedMmapBackingRange(e, t, r) {
		if (r <= 0) return !0;
		const i = Math.floor(t / Pn), n = Math.floor((t + r - 1) / Pn), s = /* @__PURE__ */ new Map();
		try {
			for (let t = i; t <= n; t++) e.pages.has(t) && s.set(t, this.readSharedMmapBackingPage(e, t));
		} catch {
			return this.invalidateSharedMmapBackingPages(e, Array.from({ length: n - i + 1 }, (e, t) => i + t)), !1;
		}
		for (const [o, a] of s) e.pages.set(o, a), e.dirtyPages.delete(o);
		return s.size > 0 && e.version++, !0;
	}
	invalidateSharedMmapBackingRange(e, t, r) {
		if (r <= 0) return;
		const i = Math.floor(t / Pn), n = Math.floor((t + r - 1) / Pn);
		this.invalidateSharedMmapBackingPages(e, Array.from({ length: n - i + 1 }, (e, t) => i + t));
	}
	invalidateSharedMmapBackingPages(e, t = Array.from(e.pages.keys())) {
		for (const r of t) e.dirtyPages.has(r) || e.pages.delete(r);
		e.version++;
	}
	findSharedMmapBackingForFd(e, t) {
		if (0 === this.sharedMmapBackings.size || t < 0) return null;
		const r = this.sharedMmapFdCacheKey(e.pid, t), i = this.sharedMmapFdCache.get(r);
		if (void 0 !== i) return i.backingKey ? this.sharedMmapBackings.get(i.backingKey) ?? null : null;
		const n = this.getFdStatForSharedMapping(e, t);
		if ("error" === n.kind) return 9 === n.errno && this.sharedMmapFdCache.set(r, { backingKey: null }), null;
		if (32768 != (61440 & n.value.mode)) return this.sharedMmapFdCache.set(r, { backingKey: null }), null;
		const s = n.value.hostHandle, o = null === s ? {
			kind: "error",
			errno: 95
		} : this.resolveSharedMmapBackingKey(n.value, s);
		if ("error" === o.kind) return 9 !== o.errno && 95 !== o.errno || this.sharedMmapFdCache.set(r, { backingKey: null }), null;
		const a = this.sharedMmapBackings.get(o.value);
		return a ? (this.sharedMmapFdCache.set(r, { backingKey: a.key }), a) : (this.sharedMmapFdCache.set(r, { backingKey: null }), null);
	}
	sharedMmapFdCacheKey(e, t) {
		return `${e}:${t}`;
	}
	invalidateSharedMmapFdCache(e, t) {
		void 0 !== e && void 0 !== t ? this.sharedMmapFdCache.delete(this.sharedMmapFdCacheKey(e, t)) : this.sharedMmapFdCache.clear();
	}
	invalidateSharedMmapFdCacheForPid(e) {
		if (!this.sharedMmapFdCache) return;
		const t = `${e}:`;
		for (const r of this.sharedMmapFdCache.keys()) r.startsWith(t) && this.sharedMmapFdCache.delete(r);
	}
	releaseFileSharedMapping(e) {
		if ("file" !== e.backingKind || !e.backingKey) return;
		const t = this.sharedMmapBackings.get(e.backingKey);
		t && this.releaseSharedMmapBackingReference(t);
	}
	releasePreparedSharedMmap(e) {
		this.releaseSharedMmapBackingReference(e.backing);
	}
	releaseSharedMmapBackingReference(e) {
		e.refCount = Math.max(0, e.refCount - 1), e.refCount > 0 || this.flushSharedMmapBackingRange(e, 0, Number.MAX_SAFE_INTEGER) && (this.kernel.releaseHostFileHandle(e.handle), this.sharedMmapBackings.delete(e.key), this.invalidateSharedMmapFdCache());
	}
	mergeChangedByteRuns(e, t, r, i, n, s, o) {
		let a = !1, c = 0;
		for (; c < o;) {
			for (; c < o && e[t + c] === r[i + c];) c++;
			if (c >= o) break;
			const l = c;
			do
				c++;
			while (c < o && e[t + c] !== r[i + c]);
			n.set(e.subarray(t + l, t + c), s + l), a = !0;
		}
		return a;
	}
	rangeDiffersFromSnapshot(e, t, r, i, n) {
		const s = e.byteOffset + t, o = r.byteOffset + i;
		if (!(3 & (s | o | n))) {
			const t = new Uint32Array(e.buffer, s, n / 4), i = new Uint32Array(r.buffer, o, n / 4);
			for (let e = 0; e < t.length; e++) if (t[e] !== i[e]) return !0;
			return !1;
		}
		for (let a = 0; a < n; a++) if (e[t + a] !== r[i + a]) return !0;
		return !1;
	}
	releaseAnonymousSharedMapping(e) {
		if (!e.backingKey) return;
		const t = this.anonymousSharedBackings?.get(e.backingKey);
		t && (t.refCount = Math.max(0, t.refCount - 1), 0 === t.refCount && this.anonymousSharedBackings.delete(t.key));
	}
	releaseSharedMapping(e) {
		"file" === e.backingKind ? this.releaseFileSharedMapping(e) : this.releaseAnonymousSharedMapping(e);
	}
	inheritProcessSharedMappings(e, t) {
		const r = this.processes.get(t);
		if (!r) throw new Error(`Process ${t} is not registered`);
		try {
			const i = this.sharedMappings.get(e);
			if (i) {
				const e = new Uint8Array(r.memory.buffer), n = /* @__PURE__ */ new Map();
				this.sharedMappings.set(t, n);
				for (const [t, r] of i) {
					if (!r.backingKey) continue;
					const i = "file" !== r.backingKind ? this.anonymousSharedBackings.get(r.backingKey) : void 0, s = "file" === r.backingKind ? this.sharedMmapBackings.get(r.backingKey) : void 0;
					if (!i && !s || t + r.len > e.length) throw new Error(`Cannot inherit shared mapping at 0x${t.toString(16)}`);
					const o = i ? i.bytes.slice(r.fileOffset, r.fileOffset + r.len) : this.readSharedMmapBackingRange(s, r.fileOffset, r.len);
					e.set(o, t);
					const a = i?.version ?? s.version;
					i ? i.refCount++ : s.refCount++, n.set(t, {
						...r,
						snapshot: o,
						seenVersion: a
					});
				}
				0 === n.size && this.sharedMappings.delete(t);
			}
			this.inheritSysvShmMappings(e, t);
		} catch (ys) {
			throw this.releaseAllSharedMemoryForProcess(t, !1), ys;
		}
	}
	populateMmapFromFile(e, t, r) {
		const i = r[4], n = r[1];
		let s = 4096 * r[5];
		const o = this.kernelInstance.exports.kernel_handle_channel, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = new Uint8Array(this.kernelMemory.buffer), l = this.scratchOffset + 72;
		let h = 0;
		for (; h < n;) {
			const r = Math.min(re, n - h);
			a.setUint32(4, on, !0), a.setBigInt64(8, BigInt(i), !0), a.setBigInt64(16, BigInt(l), !0), a.setBigInt64(24, BigInt(r), !0), a.setBigInt64(32, BigInt(s), !0), a.setBigInt64(40, 0n, !0), a.setBigInt64(48, BigInt(0), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				o(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch {
				break;
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.finishSignalTermination(e)) return;
			const d = Number(a.getBigInt64(56, !0));
			if (d <= 0) break;
			if (new Uint8Array(e.memory.buffer).set(c.subarray(l, l + d), t + h), h += d, s += d, d < r) break;
		}
	}
	flushSharedMappings(e, t) {
		try {
			this.syncAnonymousSharedMappingsFromProcess(e, { force: !0 }), this.syncFileSharedMappingsFromProcess(e, { force: !0 });
		} catch {
			return !1;
		}
		const r = t[0] >>> 0, i = t[1] >>> 0, n = this.sharedMappings.get(e.pid);
		if (!n || 0 === n.size) return !0;
		const s = r + i;
		let o = !0;
		for (const [a, c] of n) {
			const t = a + c.len;
			if (a >= s || t <= r) continue;
			const i = Math.max(r, a), n = Math.min(s, t) - i;
			if (n <= 0) continue;
			const l = c.fileOffset + (i - a);
			if ("file" === c.backingKind && c.backingKey) {
				const e = this.sharedMmapBackings.get(c.backingKey);
				e && this.flushSharedMmapBackingRange(e, l, n) || (o = !1);
				continue;
			}
			c.writable && (c.backingKey || this.pwriteFromProcessMemory(e, c.fd, i, n, l) || (o = !1));
		}
		return o;
	}
	pwriteFromProcessMemory(e, t, r, i, n) {
		const s = this.kernelInstance.exports.kernel_handle_channel, o = this.scratchOffset + 72;
		if (r + i > e.memory.buffer.byteLength) return !1;
		const a = this.currentHandlePid;
		try {
			let a = 0;
			for (; a < i;) {
				const c = Math.min(re, i - a), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = new Uint8Array(this.kernelMemory.buffer), d = new Uint8Array(e.memory.buffer);
				h.set(d.subarray(r + a, r + a + c), o);
				const f = n + a;
				if (l.setUint32(4, an, !0), l.setBigInt64(8, BigInt(t), !0), l.setBigInt64(16, BigInt(o), !0), l.setBigInt64(24, BigInt(c), !0), l.setBigInt64(32, BigInt(f), !0), l.setBigInt64(40, 0n, !0), l.setBigInt64(48, BigInt(0), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid, s(this.toKernelPtr(this.scratchOffset), e.pid), this.finishSignalTermination(e)) return !1;
				const u = new DataView(this.kernelMemory.buffer, this.scratchOffset), p = Number(u.getBigInt64(56, !0));
				if (p <= 0 || p > c) return !1;
				if (a += p, p < c) return !1;
			}
			return a === i;
		} catch {
			return !1;
		} finally {
			this.currentHandlePid = a;
		}
	}
	cleanupSharedMappings(e, t, r) {
		const i = this.sharedMappings.get(e);
		if (!i) return;
		const n = t + r;
		for (const [s, o] of Array.from(i.entries())) {
			const e = s + o.len, r = Math.max(t, s), a = Math.min(n, e);
			if (r >= a) continue;
			if (r <= s && a >= e) {
				this.releaseSharedMapping(o), i.delete(s);
				continue;
			}
			if (r <= s) {
				const t = a - s;
				i.delete(s), o.fileOffset += t, o.len = e - a, o.snapshot && (o.snapshot = o.snapshot.slice(t)), o.len > 0 ? i.set(a, o) : this.releaseSharedMapping(o);
				continue;
			}
			if (a >= e) {
				o.len = r - s, o.snapshot && (o.snapshot = o.snapshot.slice(0, o.len));
				continue;
			}
			const c = r - s, l = a - s, h = {
				...o,
				fileOffset: o.fileOffset + l,
				len: e - a,
				...o.snapshot ? { snapshot: o.snapshot.slice(l) } : {}
			};
			if (o.len = c, o.snapshot && (o.snapshot = o.snapshot.slice(0, c)), o.backingKey) {
				const e = "file" === o.backingKind ? this.sharedMmapBackings.get(o.backingKey) : this.anonymousSharedBackings.get(o.backingKey);
				e && e.refCount++;
			}
			i.set(a, h);
		}
		0 === i.size && this.sharedMappings.delete(e);
	}
	preflightFileSharedMremap(e, t) {
		const r = t[0] >>> 0, i = t[2] >>> 0, n = this.sharedMappings.get(e)?.get(r);
		if (!n || "file" !== n.backingKind || i <= n.len) return 0;
		if (!n.backingKey) return 5;
		const s = this.sharedMmapBackings.get(n.backingKey);
		if (!s) return 5;
		try {
			return this.ensureSharedMmapBackingRangeLoaded(s, n.fileOffset + n.len, i - n.len), 0;
		} catch {
			return 5;
		}
	}
	remapSharedMapping(e, t, r, i) {
		const n = this.sharedMappings.get(e), s = n?.get(t);
		if (n && s) {
			if (n.delete(t), s.backingKey && s.snapshot) {
				const t = this.processes.get(e), n = "file" === s.backingKind ? this.sharedMmapBackings.get(s.backingKey) : void 0, o = "file" !== s.backingKind ? this.anonymousSharedBackings.get(s.backingKey) : void 0;
				if (n && t) {
					this.ensureSharedMmapBackingRangeLoaded(n, s.fileOffset, i);
					const e = this.readSharedMmapBackingRange(n, s.fileOffset, i);
					new Uint8Array(t.memory.buffer).set(e, r), s.snapshot = e, s.seenVersion = n.version;
				} else if (o && t) {
					const e = s.fileOffset + i;
					if (e > o.bytes.length) {
						const n = new Uint8Array(e);
						n.set(o.bytes);
						const a = new Uint8Array(t.memory.buffer);
						r + i <= a.length && i > s.len && n.set(a.subarray(r + s.len, r + i), s.fileOffset + s.len), o.bytes = n, o.version++;
					}
					const n = o.bytes.slice(s.fileOffset, s.fileOffset + i);
					new Uint8Array(t.memory.buffer).set(n, r), s.snapshot = n, s.seenVersion = o.version;
				} else s.snapshot = s.snapshot.slice(0, i);
			}
			s.len = i, n.set(r, s);
		}
	}
	prepareFileSharedMappingsForWrite(e, t, r) {
		const i = this.sharedMappings.get(e);
		if (!i || 0 === r) return 0;
		const n = t + r;
		for (const [s, o] of i) {
			if ("file" !== o.backingKind) continue;
			if (s + o.len <= t || s >= n) continue;
			if (!0 !== o.writeAllowed) return 13;
			if (!o.backingKey) return 5;
			const e = this.sharedMmapBackings.get(o.backingKey);
			if (!e) return 5;
			if (!e.writable) return 5;
		}
		return 0;
	}
	updateSharedMappingProtection(e, t, r, i) {
		const n = this.sharedMappings.get(e);
		if (!n || 0 === r || !i) return;
		const s = t + r;
		for (const [o, a] of n) o + a.len <= t || o >= s || (a.writable = !0);
	}
	hasPeerSysvShmMapping(e, t, r) {
		for (const [i, n] of this.shmMappings) for (const [s, o] of n) if (o.segId === r && (i !== e || s !== t)) return !0;
		return !1;
	}
	syncSysvShmMappingsFromProcess(e, t = {}) {
		const r = this.shmMappings?.get(e.pid);
		if (!r) return !0;
		const i = new Uint8Array(e.memory.buffer);
		let n = !0;
		for (const [s, o] of r) (t.force || this.hasPeerSysvShmMapping(e.pid, s, o.segId)) && (this.mergeAndRefreshSysvShmMapping(i, s, o) || (n = !1));
		return n;
	}
	syncSysvShmSegmentFromMappedProcesses(e) {
		for (const [t, r] of this.shmMappings) {
			const i = this.processes.get(t);
			if (!i) continue;
			const n = new Uint8Array(i.memory.buffer);
			for (const [t, s] of r) s.segId === e && this.mergeAndRefreshSysvShmMapping(n, t, s);
		}
	}
	mappingDiffersFromSnapshot(e, t, r, i) {
		for (let n = 0; n < i; n += 4096) {
			const s = Math.min(4096, i - n);
			if (this.rangeDiffersFromSnapshot(e, t + n, r, n, s)) return !0;
		}
		return !1;
	}
	mergeAndRefreshSysvShmMapping(e, t, r) {
		if (t + r.size > e.length) return !1;
		const i = this.shmSegmentVersions.get(r.segId) ?? 0, n = !r.readOnly && this.mappingDiffersFromSnapshot(e, t, r.snapshot, r.size);
		if (!n && r.seenVersion === i) return !0;
		const s = this.readSysvShmRange(r.segId, 0, r.size);
		if (!s) return !1;
		let o = !1, a = !0;
		if (n) for (let c = 0; c < r.size; c += 4096) {
			const i = Math.min(4096, r.size - c);
			if (!this.rangeDiffersFromSnapshot(e, t + c, r.snapshot, c, i)) continue;
			let n = 0;
			for (; n < i;) {
				for (; n < i && e[t + c + n] === r.snapshot[c + n];) n++;
				if (n >= i) break;
				const l = n;
				do
					n++;
				while (n < i && e[t + c + n] !== r.snapshot[c + n]);
				const h = e.subarray(t + c + l, t + c + n);
				if (!this.writeSysvShmRange(r.segId, c + l, h)) {
					a = !1;
					break;
				}
				s.set(h, c + l), o = !0;
			}
			if (!a) break;
		}
		return o && this.shmSegmentVersions.set(r.segId, i + 1), e.set(s, t), r.snapshot = s, r.seenVersion = this.shmSegmentVersions.get(r.segId) ?? i, a;
	}
	readSysvShmRange(e, t, r) {
		const i = this.kernelInstance.exports.kernel_ipc_shm_read_chunk;
		if (!i) return null;
		const n = new Uint8Array(r);
		let s = 0;
		for (; s < r;) {
			const o = Math.min(re, r - s), a = this.scratchOffset + 72, c = i(e, t + s, this.toKernelPtr(a), o);
			if (c < 0 || c > o) return null;
			if (0 === c) break;
			n.set(new Uint8Array(this.kernelMemory.buffer, a, c), s), s += c;
		}
		return n;
	}
	writeSysvShmRange(e, t, r) {
		const i = this.kernelInstance.exports.kernel_ipc_shm_write_chunk;
		if (!i) return !1;
		let n = 0;
		for (; n < r.length;) {
			const s = Math.min(re, r.length - n), o = this.scratchOffset + 72;
			new Uint8Array(this.kernelMemory.buffer).set(r.subarray(n, n + s), o);
			const a = i(e, t + n, this.toKernelPtr(o), s);
			if (a <= 0 || a > s) return !1;
			n += a;
		}
		return !0;
	}
	inheritSysvShmMappings(e, t) {
		const r = this.shmMappings.get(e);
		if (!r || 0 === r.size) return;
		const i = this.processes.get(t);
		if (!i) throw new Error(`Process ${t} is not registered`);
		const n = this.kernelInstance.exports.kernel_ipc_shmat_for_process, s = this.kernelInstance.exports.kernel_ipc_shmdt_for_process;
		if (!n || !s) throw new Error("Kernel lacks SysV SHM inheritance exports");
		const o = new Uint8Array(i.memory.buffer), a = /* @__PURE__ */ new Map();
		try {
			for (const [e, i] of r) {
				if (e + i.size > o.length) throw new Error(`Cannot inherit SysV mapping at 0x${e.toString(16)}`);
				const r = n(t, i.segId, e, i.readOnly ? 4096 : 0);
				if (r < 0 || r !== i.size) throw new Error(`SysV shmat inheritance failed for segment ${i.segId}`);
				const c = this.readSysvShmRange(i.segId, 0, i.size);
				if (!c) throw s(t, i.segId), /* @__PURE__ */ new Error(`Cannot read inherited SysV segment ${i.segId}`);
				o.set(c, e), a.set(e, {
					...i,
					snapshot: c,
					seenVersion: this.shmSegmentVersions.get(i.segId) ?? i.seenVersion
				});
			}
		} catch (ys) {
			for (const r of a.values()) s(t, r.segId);
			throw a.clear(), ys;
		}
		a.size > 0 && this.shmMappings.set(t, a);
	}
	releaseAllSysvShmMappingsForProcess(e, t = !0) {
		const r = this.shmMappings?.get(e);
		if (!r) return;
		const i = this.processes.get(e);
		t && i && this.syncSysvShmMappingsFromProcess(i, { force: !0 });
		const n = this.kernelInstance.exports.kernel_ipc_shmdt_for_process;
		if (n) for (const s of r.values()) n(e, s.segId);
		this.shmMappings.delete(e);
	}
	releaseAllSharedMemoryForProcess(e, t = !0) {
		const r = this.sharedMemoryReleasePids ??= /* @__PURE__ */ new Set();
		if (!r.has(e)) {
			r.add(e);
			try {
				const r = this.processes?.get(e), i = r?.channels?.[0];
				if (t && r) {
					try {
						this.syncAnonymousSharedMappingsFromProcess(r, { force: !0 });
					} catch {}
					try {
						this.syncFileSharedMappingsFromProcess(r, { force: !0 });
					} catch {}
					try {
						this.syncSysvShmMappingsFromProcess(r, { force: !0 });
					} catch {}
					if (i) {
						const t = this.sharedMappings.get(e);
						if (t) {
							for (const [e, r] of t) if (r.writable) {
								if ("file" === r.backingKind && r.backingKey) {
									const e = this.sharedMmapBackings.get(r.backingKey);
									e && this.flushSharedMmapBackingRange(e, r.fileOffset, r.len);
									continue;
								}
								r.backingKey || this.pwriteFromProcessMemory(i, r.fd, e, r.len, r.fileOffset);
							}
						}
					}
				}
				const n = this.sharedMappings?.get(e);
				if (n) {
					for (const e of n.values()) this.releaseSharedMapping(e);
					this.sharedMappings?.delete(e);
				}
				this.invalidateSharedMmapFdCacheForPid(e), this.shmMappings && this.releaseAllSysvShmMappingsForProcess(e, !1);
			} finally {
				r.delete(e);
			}
		}
	}
	setMaxAddr(e, t) {
		const r = this.kernelInstance.exports.kernel_set_max_addr;
		r && r(e, this.toKernelPtr(t));
	}
	setBrkLimit(e, t) {
		const r = this.kernelInstance.exports.kernel_set_brk_limit;
		return !!r && r(e, this.toKernelPtr(t)) >= 0;
	}
	setMmapBase(e, t) {
		const r = this.kernelInstance.exports.kernel_set_mmap_base;
		return !!r && r(e, this.toKernelPtr(t)) >= 0;
	}
	reserveHostRegion(e, t) {
		const r = this.kernelInstance.exports.kernel_reserve_host_region;
		if (!r) throw new Error("Kernel export kernel_reserve_host_region is required for dynamic pthread control slots");
		const i = r(e, this.toKernelPtr(t)), n = "bigint" == typeof i ? Number(i) : i;
		if (!Number.isSafeInteger(n) || n < 0 || n >>> 0 == 4294967295) throw new Error(`failed to reserve ${t} bytes of pthread control memory for pid=${e}`);
		return n;
	}
	reserveHostRegionAt(e, t, r) {
		const i = this.kernelInstance.exports.kernel_reserve_host_region_at;
		if (!i) throw new Error("Kernel export kernel_reserve_host_region_at is required for fork-from-pthread control slots");
		const n = i(e, this.toKernelPtr(t), this.toKernelPtr(r)), s = "bigint" == typeof n ? Number(n) : n;
		if (!Number.isSafeInteger(s) || s < 0 || s >>> 0 == 4294967295 || s !== t) throw new Error(`failed to reserve pthread control memory at 0x${t.toString(16)} for pid=${e}`);
		return s;
	}
	highControlFloorForProcess(e) {
		const t = this.processes.get(e);
		if (!t) return null;
		if (t.explicitMaxAddr) return null;
		let r = null;
		for (const i of t.channels) {
			const e = i.channelOffset - 131072;
			e >= Or && (r = null === r ? e : Math.min(r, e));
		}
		return r;
	}
	setBrkBase(e, t) {
		const r = this.kernelInstance.exports.kernel_set_brk_base;
		return !!r && r(e, this.toKernelPtr(t)) >= 0;
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
	getKernelMemoryPages() {
		const e = this.kernelInstance?.exports.kernel_get_memory_pages;
		if ("function" != typeof e) throw new Error("kernel_get_memory_pages export is unavailable");
		return e() >>> 0;
	}
	injectMouseEvent(e, t, r) {
		this.kernel.injectMouseEvent(e, t, r), this.scheduleWakeBlockedRetries();
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
	reconcileReusedTcpListenerKey(e, t, r, i, n) {
		const s = n.port, o = (this.tcpListenerTargets.get(s) ?? []).filter((r) => !(r.pid === e && r.fd === t)), a = void 0 !== i?.acceptWakeIdx ? this.resolveInheritedListenerFd(e, t, i.acceptWakeIdx) : null;
		if (a && a.fd !== t && !o.some((t) => t.pid === e && t.fd === a.fd) && o.push({
			pid: e,
			...a
		}), 0 === o.length) {
			if (this.tcpListenerTargets.delete(s), s !== r) {
				this.tcpListenerRRIndex.delete(s);
				const e = this.tcpVirtualListenerKeys.get(s);
				e && (this.io.network?.closeTcpListener?.(e), this.tcpVirtualListenerKeys.delete(s));
			}
		} else {
			this.tcpListenerTargets.set(s, o);
			const e = this.tcpListenerRRIndex.get(s) ?? 0;
			this.tcpListenerRRIndex.set(s, e % o.length);
		}
		const c = `${e}:${t}`;
		if (this.tcpListeners.delete(c), a && a.fd !== t) {
			const t = `${e}:${a.fd}`;
			this.tcpListeners.has(t) || this.tcpListeners.set(t, n);
		} else if (o.length > 0) {
			const e = o[0], t = `${e.pid}:${e.fd}`;
			this.tcpListeners.has(t) || this.tcpListeners.set(t, {
				...n,
				pid: e.pid
			});
		} else s !== r && n.server.close();
		return s === r ? n : void 0;
	}
	startTcpListener(e, t, r, i = [
		0,
		0,
		0,
		0
	]) {
		const n = `${e}:${t}`, s = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx, o = s?.(e, t) ?? -1;
		let a;
		const c = this.tcpListeners.get(n);
		if (c) {
			const i = this.tcpListenerTargets.get(c.port)?.find((r) => r.pid === e && r.fd === t), n = i?.acceptWakeIdx;
			if (void 0 === n && c.port === r || void 0 !== n && n === o) return void (i && void 0 === n && o >= 0 && (i.acceptWakeIdx = o));
			a = this.reconcileReusedTcpListenerKey(e, t, r, i, c);
		}
		this.tcpListenerTargets.has(r) || (this.tcpListenerTargets.set(r, []), this.tcpListenerRRIndex.set(r, 0));
		const l = this.tcpListenerTargets.get(r);
		if (l.some((r) => r.pid === e && r.fd === t) || l.push({
			pid: e,
			fd: t,
			...o >= 0 ? { acceptWakeIdx: o } : {}
		}), this.io.network?.listenTcp && !this.tcpVirtualListenerKeys.has(r)) {
			const e = this.io.network.listenTcp(n, new Uint8Array(i), r, { accept: (e, t, i) => {
				const n = this.pickListenerTarget(r);
				return n ? this.handleIncomingVirtualTcpConnection(n.pid, n.fd, e, i) : 113;
			} });
			0 !== e ? console.warn(`virtual TCP listener registration failed on port ${r}: errno ${e}`) : this.tcpVirtualListenerKeys.set(r, n);
		}
		if (!this.netModule) return;
		if (a) return void this.tcpListeners.set(n, {
			...a,
			pid: e,
			port: r
		});
		for (const [, u] of this.tcpListeners) if (u.port === r) return void this.tcpListeners.set(n, u);
		const h = this.netModule, d = /* @__PURE__ */ new Set(), f = h.createServer({ allowHalfOpen: !0 }, (e) => {
			const t = this.pickListenerTarget(r);
			t ? this.handleIncomingTcpConnection(t.pid, t.fd, e, d) : e.destroy();
		});
		f.listen(r, "0.0.0.0", () => {}), f.on("error", (e) => {
			console.error(`TCP listener error on port ${r}:`, e);
		}), this.tcpListeners.set(n, {
			server: f,
			pid: e,
			port: r,
			connections: d
		});
	}
	pickListenerTarget(e) {
		const t = this.tcpListenerTargets.get(e);
		if (!t || 0 === t.length) return null;
		const r = t.filter((e) => this.processes.has(e.pid));
		if (0 === r.length) return null;
		let i = r;
		if (r.length > 1) {
			const e = r.filter((e) => void 0 !== this.getParentPid(e.pid));
			e.length > 0 && (i = e);
		}
		const n = (this.tcpListenerRRIndex.get(e) ?? 0) % i.length;
		return this.tcpListenerRRIndex.set(e, n + 1), i[n];
	}
	injectHostConnection(e, t, r, i) {
		if (!this.kernelInstance) return -1;
		const n = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, r[0], r[1], r[2], r[3], i);
		return n >= 0 && this.scheduleWakeBlockedRetries(), n;
	}
	readHostPipe(e, t) {
		if (!this.kernelInstance) return null;
		const r = ai("kernel_pipe_read", (0, this.kernelInstance.exports.kernel_pipe_read)(e, t, this.toKernelPtr(this.tcpScratchOffset), 65536), 65536);
		if (r <= 0) return null;
		const i = this.getKernelMem().slice(this.tcpScratchOffset, this.tcpScratchOffset + r);
		return this.notifyPipeWritable(t), i;
	}
	writeHostPipe(e, t, r) {
		if (!this.kernelInstance) return -1;
		const i = this.kernelInstance.exports.kernel_pipe_write, n = this.writePipeChunked(i, e, t, r);
		return n > 0 && this.notifyPipeReadable(t), n;
	}
	closeHostPipeRead(e, t) {
		if (!this.kernelInstance) return;
		(0, this.kernelInstance.exports.kernel_pipe_close_read)(e, t);
	}
	closeHostPipeWrite(e, t) {
		if (!this.kernelInstance) return;
		(0, this.kernelInstance.exports.kernel_pipe_close_write)(e, t);
	}
	isHostPipeWriteOpen(e, t) {
		if (!this.kernelInstance) return !1;
		return 1 === (0, this.kernelInstance.exports.kernel_pipe_is_write_open)(e, t);
	}
	wakeHostPipeReaders(e) {
		this.notifyPipeReadable(e);
	}
	wakeHostPipeWriters(e) {
		this.notifyPipeWritable(e);
	}
	async sendHttpRequest(e, t, r = {}) {
		const i = r.timeoutMs ?? 6e4, n = r.maxResponseBytes ?? Number.MAX_SAFE_INTEGER;
		if (!Number.isSafeInteger(n) || n < 1) throw new Error("in-kernel HTTP response bound must be a positive safe integer");
		const s = r.debugLabel ?? `${t.method} ${t.url}`, o = this.pickListenerTarget(e);
		if (!o) throw new Error(`No in-kernel listener for port ${e}`);
		const a = this.kernelInstance.exports, c = a.kernel_inject_connection, l = a.kernel_pipe_write, h = a.kernel_pipe_read, d = a.kernel_pipe_is_write_open, f = a.kernel_pipe_close_write, u = a.kernel_pipe_close_read, p = 1024 + Math.floor(6e4 * Math.random()), m = c(o.pid, o.fd, 127, 0, 0, 1, p);
		if (m < 0) throw new Error(`[in-kernel-http ${s}] kernel_inject_connection failed (${m})`);
		const g = m + 1;
		this.wakeTargetPollNow(o.pid), this.scheduleWakeBlockedRetries();
		const y = function(e) {
			let t = `${e.method} ${e.url} HTTP/1.1\r\n`;
			const r = Object.keys(e.headers).map((e) => e.toLowerCase());
			for (const [s, o] of Object.entries(e.headers)) t += `${s}: ${o}\r\n`;
			e.body && e.body.length > 0 && !r.includes("content-length") && (t += `Content-Length: ${e.body.length}\r\n`), r.includes("connection") || (t += "Connection: close\r\n"), t += "\r\n";
			const i = xr.encode(t);
			if (!e.body || 0 === e.body.length) return i;
			const n = new Uint8Array(i.length + e.body.length);
			return n.set(i, 0), n.set(e.body, i.length), n;
		}(t), w = this.writePipeChunked(l, 0, m, y);
		if (w < y.length) throw f(0, m), u(0, g), /* @__PURE__ */ new Error(`[in-kernel-http ${s}] partial write ${w}/${y.length}`);
		this.notifyPipeReadable(m);
		const b = await this.pumpHttpResponse(0, g, m, h, d, u, f, i, n, t.method, s), S = r.emptyResponseRetries ?? 1;
		return S > 0 && ("GET" === t.method || "HEAD" === t.method) && 200 === b.status && 0 === Object.keys(b.headers).length && 0 === b.body.length ? await this.sendHttpRequest(e, t, {
			...r,
			emptyResponseRetries: S - 1
		}) : b;
	}
	wakeTargetPollNow(e) {
		for (const [t, r] of this.pendingPollRetries) if (r.channel.pid === e) {
			null !== r.timer && clearTimeout(r.timer), this.pendingPollRetries.delete(t), this.isRegisteredChannel(r.channel) && this.retrySyscall(r.channel);
			break;
		}
	}
	writePipeChunked(e, t, r, i) {
		const n = this.tcpScratchOffset;
		let s = 0;
		for (; s < i.length;) {
			const o = Math.min(i.length - s, 65536);
			this.getKernelMem().set(i.subarray(s, s + o), n);
			const a = ai("kernel_pipe_write", e(t, r, this.toKernelPtr(n), o), o);
			if (a <= 0) break;
			s += a;
		}
		return s;
	}
	pumpHttpResponse(e, t, r, i, n, s, o, a, c, l, h) {
		return new Promise((h, d) => {
			const f = new Mr(c), u = Date.now();
			let p = !1;
			const m = this.tcpScratchOffset, g = (i) => {
				s(e, t), o(e, r), this.notifyPipeReadable(r), this.scheduleWakeBlockedRetries(), h(i);
			}, y = (i) => {
				s(e, t), o(e, r), this.notifyPipeReadable(r), this.scheduleWakeBlockedRetries(), d(i instanceof Error ? i : new Error(String(i)));
			}, w = () => {
				if (Date.now() - u > a) return void g({
					status: 504,
					headers: {},
					body: new Uint8Array(0)
				});
				let r = !1;
				for (;;) try {
					const n = ai("kernel_pipe_read", i(e, t, this.toKernelPtr(m), 65536), 65536);
					if (n <= 0) break;
					r = !0;
					const s = this.getKernelMem();
					f.push(s.slice(m, m + n));
				} catch (o) {
					y(o);
					return;
				}
				r && this.notifyPipeWritable(t);
				const s = 1 === n(e, t);
				s && !p && (p = !0), !p || s || r ? setTimeout(w, r ? 0 : 2) : g(Tr(f.concat(), l));
			};
			w();
		});
	}
	handleIncomingTcpConnection(e, t, r, i) {
		i.add(r);
		const n = r.remoteAddress || "127.0.0.1", s = r.remotePort || 0, o = n.replace("::ffff:", "").split(".").map(Number), a = o[0] || 127, c = o[1] || 0, l = o[2] || 0, h = o[3] || 1, d = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, a, c, l, h, s);
		if (d < 0) return r.destroy(), void i.delete(r);
		this.scheduleWakeBlockedRetries();
		const f = d + 1, u = this.kernelInstance.exports.kernel_pipe_write, p = this.kernelInstance.exports.kernel_pipe_read, m = this.kernelInstance.exports.kernel_pipe_close_write, g = this.kernelInstance.exports.kernel_pipe_close_read, y = this.kernelInstance.exports.kernel_pipe_is_read_open, w = this.kernelInstance.exports.kernel_pipe_has_readers, b = [];
		let S = !1, _ = !1, k = !1, v = !1, A = !1, I = !1;
		const P = this.tcpScratchOffset, E = this.kernelInstance.exports.kernel_pipe_is_write_open, C = () => {
			v || (v = !0, m(0, d), this.notifyPipeReadable(d));
		}, x = () => {
			if (0 === y(0, d)) return b.length = 0, void (S && C());
			const e = this.getKernelMem();
			let t = !1;
			for (; b.length > 0;) {
				const r = b[0], i = Math.min(r.length, 65536);
				e.set(r.subarray(0, i), P);
				const n = ai("kernel_pipe_write", u(0, d, this.toKernelPtr(P), i), i);
				if (n <= 0) break;
				t = !0, n >= r.length ? b.shift() : b[0] = r.subarray(n);
			}
			S && 0 === b.length && C(), t && this.notifyPipeReadable(d);
		}, z = () => {
			const e = this.getKernelMem();
			let t = 0;
			for (;;) {
				const i = ai("kernel_pipe_read", p(0, f, this.toKernelPtr(P), 65536), 65536);
				if (i <= 0) break;
				t += i;
				const n = Buffer.from(e.slice(P, P + i));
				r.destroyed || r.write(n);
			}
			return t > 0 && this.notifyPipeWritable(f), t;
		}, M = (e = 0) => {
			A || I || (A = !0, e > 0 ? setTimeout(T, e) : setImmediate(T));
		}, T = () => {
			if (A = !1, I) return;
			x();
			const e = z(), t = E(0, f), i = w(0, d);
			0 !== t || 0 !== e || k || (k = !0, r.destroyed || r.writableEnded || r.end()), 0 === t && i <= 0 || k && S && 0 === b.length || _ && 0 === b.length ? R() : M();
		};
		r.on("data", (e) => {
			I || (b.push(e), x(), M());
		}), r.on("end", () => {
			S = !0, M();
		}), r.on("error", () => {
			S = !0, r.destroy(), R();
		}), r.on("close", () => {
			i.delete(r), _ = !0, S = !0, M();
		});
		let L = this.tcpConnections.get(e);
		L || (L = [], this.tcpConnections.set(e, L));
		const B = {
			sendPipeIdx: f,
			scratchOffset: P,
			clientSocket: r,
			recvPipeIdx: d,
			schedulePump: M
		};
		L.push(B);
		const R = () => {
			if (I) return;
			I = !0, b.length = 0, C(), g(0, f), this.notifyPipeWritable(f);
			const t = this.tcpConnections?.get(e);
			if (t) {
				const r = t.indexOf(B);
				r >= 0 && t.splice(r, 1), 0 === t.length && this.tcpConnections?.delete(e);
			}
			r.destroyed || r.destroySoon();
		};
	}
	handleIncomingVirtualTcpConnection(e, t, r, i) {
		if (!this.kernelInstance) return 107;
		const n = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, i.addr[0] ?? 0, i.addr[1] ?? 0, i.addr[2] ?? 0, i.addr[3] ?? 0, i.port);
		if (n < 0) return -n;
		const s = n + 1, o = this.kernelInstance.exports.kernel_pipe_write, a = this.kernelInstance.exports.kernel_pipe_read, c = this.kernelInstance.exports.kernel_pipe_close_write, l = this.kernelInstance.exports.kernel_pipe_close_read, h = this.kernelInstance.exports.kernel_pipe_is_write_open, d = this.kernelInstance.exports.kernel_pipe_is_read_open, f = this.kernelInstance.exports.kernel_pipe_has_readers;
		let u = !1, p = !1, m = !1, g = !1, y = null, w = !1;
		const b = this.tcpScratchOffset, S = () => {
			p || (p = !0, c(0, n));
		}, _ = () => {
			u || (u = !0, S(), l(0, s), r.close(), this.notifyPipeReadable(n), this.notifyPipeWritable(s), this.scheduleWakeBlockedRetries());
		}, k = () => {
			if (0 === d(0, n)) return y = null, void (m || (m = !0, r.shutdown(0)));
			for (;;) {
				let t;
				if (y) t = y;
				else try {
					t = r.recv(65536, 0);
				} catch (e) {
					if (11 === e?.errno) return;
					_();
					return;
				}
				if (0 === t.length) return y = null, S(), void this.notifyPipeReadable(n);
				const i = this.writePipeChunked(o, 0, n, t);
				if (i < t.length) return void (y = t.subarray(i));
				y = null, this.notifyPipeReadable(n);
			}
		}, v = () => {
			const e = this.getKernelMem();
			for (;;) {
				const t = ai("kernel_pipe_read", a(0, s, this.toKernelPtr(b), 65536), 65536);
				if (t <= 0) break;
				try {
					r.send(e.slice(b, b + t), 0);
				} catch {
					_();
					return;
				}
				this.notifyPipeWritable(s);
			}
		}, A = () => {
			if (w = !1, u) return;
			k(), v();
			const e = h(0, s), t = f(0, n);
			0 !== e || g || (g = !0, r.shutdown(1)), 0 === e && t <= 0 || g && p ? _() : I(2);
		}, I = (e = 0) => {
			w || u || (w = !0, setTimeout(A, e));
		};
		return this.scheduleWakeBlockedRetries(), I(), 0;
	}
	injectUdpDatagram(e, t) {
		if (!this.kernelInstance || !this.processes.has(e)) return 113;
		if (t.data.length > 65536) return 90;
		const r = this.kernelInstance.exports.kernel_inject_datagram;
		if (!r) return 38;
		const i = this.tcpScratchOffset;
		this.getKernelMem().set(t.data, i);
		const n = r(e, t.dstAddr[0] ?? 0, t.dstAddr[1] ?? 0, t.dstAddr[2] ?? 0, t.dstAddr[3] ?? 0, t.dstPort, t.srcAddr[0] ?? 0, t.srcAddr[1] ?? 0, t.srcAddr[2] ?? 0, t.srcAddr[3] ?? 0, t.srcPort, this.toKernelPtr(i), t.data.length);
		return n < 0 ? -n : (this.scheduleWakeBlockedRetries(), 0);
	}
	cleanupUdpBindings(e) {
		if (!this.io.network?.unbindUdp) return;
		const t = `${e}:`;
		for (const r of Array.from(this.udpBindings)) r.startsWith(t) && (this.io.network.unbindUdp(r), this.udpBindings.delete(r));
	}
	cleanupTcpListeners(e) {
		for (const [r, i] of this.tcpListenerTargets) {
			const t = i.filter((t) => t.pid !== e);
			if (0 === t.length) {
				this.tcpListenerTargets.delete(r), this.tcpListenerRRIndex.delete(r);
				const e = this.tcpVirtualListenerKeys.get(r);
				e && (this.io.network?.closeTcpListener?.(e), this.tcpVirtualListenerKeys.delete(r));
			} else this.tcpListenerTargets.set(r, t);
		}
		const t = `${e}:`;
		for (const [r, i] of Array.from(this.tcpListeners)) {
			if (!r.startsWith(t)) continue;
			this.tcpListeners.delete(r);
			const e = this.tcpListenerTargets.get(i.port);
			if (e && 0 !== e.length) {
				const t = e[0], r = `${t.pid}:${t.fd}`;
				this.tcpListeners.has(r) || this.tcpListeners.set(r, {
					...i,
					pid: t.pid
				});
			} else i.server.close();
		}
		this.tcpConnections.delete(e);
	}
	handleSemctl(e, t) {
		const [r, i, n, s] = t, o = -257 & n, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = this.kernelInstance.exports.kernel_handle_channel, l = this.getKernelMem(), h = this.scratchOffset + 72;
		if (2 === o && 0 !== s) {
			a.setUint32(4, Bn, !0), a.setBigInt64(8, BigInt(r), !0), a.setBigInt64(16, BigInt(i), !0), a.setBigInt64(24, BigInt(n), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), l.fill(0, h, h + 72), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const t = Number(a.getBigInt64(56, !0)), o = a.getUint32(64, !0);
			t >= 0 && new Uint8Array(e.memory.buffer).set(l.subarray(h, h + 72), s), this.completeChannelRaw(e, t, o), this.relistenChannel(e);
			return;
		}
		if (13 === o && 0 !== s) {
			const t = 1024;
			a.setUint32(4, Bn, !0), a.setBigInt64(8, BigInt(r), !0), a.setBigInt64(16, BigInt(i), !0), a.setBigInt64(24, BigInt(n), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), l.fill(0, h, h + t), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const o = Number(a.getBigInt64(56, !0)), d = a.getUint32(64, !0);
			o >= 0 && new Uint8Array(e.memory.buffer).set(l.subarray(h, h + t), s), this.completeChannelRaw(e, o, d), this.relistenChannel(e);
			return;
		}
		if (17 === o && 0 !== s) {
			const t = 1024, o = new Uint8Array(e.memory.buffer);
			l.set(o.subarray(s, s + t), h), a.setUint32(4, Bn, !0), a.setBigInt64(8, BigInt(r), !0), a.setBigInt64(16, BigInt(i), !0), a.setBigInt64(24, BigInt(n), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const d = Number(a.getBigInt64(56, !0)), f = a.getUint32(64, !0);
			this.completeChannelRaw(e, d, f), this.relistenChannel(e);
			return;
		}
		a.setUint32(4, Bn, !0), a.setBigInt64(8, BigInt(r), !0), a.setBigInt64(16, BigInt(i), !0), a.setBigInt64(24, BigInt(n), !0), a.setBigInt64(32, BigInt(s), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			c(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const d = Number(a.getBigInt64(56, !0)), f = a.getUint32(64, !0);
		this.completeChannelRaw(e, d, f), this.relistenChannel(e);
	}
	runSyntheticMemorySyscall(e, t, r) {
		const i = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		i.setUint32(4, t, !0);
		for (let a = 0; a < 6; a++) i.setBigInt64(8 + 8 * a, BigInt(r[a] ?? 0), !0);
		const n = this.kernelInstance.exports.kernel_handle_channel, s = this.currentHandlePid;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			n(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = s;
		}
		if (this.finishSignalTermination(e)) return {
			retVal: -4,
			errVal: 4
		};
		const o = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		return {
			retVal: Number(o.getBigInt64(56, !0)),
			errVal: o.getUint32(64, !0)
		};
	}
	handleIpcShmat(e, t) {
		const [r, i, n] = t, s = this.guestTidForChannel(e);
		this.validateKernelTid(e.pid, s), this.syncSysvShmSegmentFromMappedProcesses(r);
		const o = this.kernelInstance.exports.kernel_ipc_shmat_for_task, a = this.kernelInstance.exports.kernel_ipc_shmdt_for_process, c = o(e.pid, s, r, i, n);
		if (c < 0) return this.completeChannelRaw(e, c, -c), void this.relistenChannel(e);
		const l = c, h = !!(4096 & n), d = h ? 1 : 3;
		let f = null;
		const u = () => {
			if (null !== f) {
				try {
					this.runSyntheticMemorySyscall(e, Ji, [f, l]);
				} catch {}
				if (this.hostReaped?.has(e.pid)) return;
			}
			try {
				a(e.pid, r);
			} catch {}
		};
		try {
			const t = this.runSyntheticMemorySyscall(e, Zi, [
				i >>> 0,
				l,
				d,
				34,
				-1,
				0
			]);
			if (this.hostReaped?.has(e.pid)) return;
			if (t.retVal < 0) {
				if (u(), this.hostReaped?.has(e.pid)) return;
				const r = t.errVal || 12;
				this.completeChannelRaw(e, -r, r), this.relistenChannel(e);
				return;
			}
			if (f = t.retVal >>> 0, 0 !== i && f !== i >>> 0) {
				if (u(), this.hostReaped?.has(e.pid)) return;
				this.completeChannelRaw(e, -22, di), this.relistenChannel(e);
				return;
			}
			this.ensureProcessMemoryCovers(e.pid, e.memory, Zi, f, [
				i,
				l,
				d,
				34,
				-1,
				0
			]);
			const n = this.readSysvShmRange(r, 0, l), s = new Uint8Array(e.memory.buffer);
			if (!n || f + l > s.length) {
				if (u(), this.hostReaped?.has(e.pid)) return;
				this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			}
			s.set(n, f);
			let o = this.shmMappings.get(e.pid);
			o || (o = /* @__PURE__ */ new Map(), this.shmMappings.set(e.pid, o)), o.set(f, {
				segId: r,
				size: l,
				readOnly: h,
				snapshot: n,
				seenVersion: this.shmSegmentVersions.get(r) ?? 0
			});
		} catch (ys) {
			if (console.error(`[handleIpcShmat] mmap failed for pid=${e.pid}:`, ys), u(), this.hostReaped?.has(e.pid)) return;
			this.completeChannelRaw(e, -12, 12), this.relistenChannel(e);
			return;
		}
		this.completeChannelRaw(e, f, 0), this.relistenChannel(e);
	}
	handleIpcShmdt(e, t) {
		const r = this.guestTidForChannel(e);
		this.validateKernelTid(e.pid, r);
		const i = t[0] >>> 0, n = this.shmMappings.get(e.pid);
		if (!n) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const s = n.get(i);
		if (!s) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const o = new Uint8Array(e.memory.buffer);
		if (!this.mergeAndRefreshSysvShmMapping(o, i, s)) return this.completeChannelRaw(e, -5, 5), void this.relistenChannel(e);
		const a = (0, this.kernelInstance.exports.kernel_ipc_shmdt_for_task)(e.pid, r, s.segId);
		if (a < 0) this.completeChannelRaw(e, a, -a);
		else {
			n.delete(i), 0 === n.size && this.shmMappings.delete(e.pid);
			let t = !1;
			try {
				const r = this.runSyntheticMemorySyscall(e, Ji, [i, s.size]);
				if (this.hostReaped?.has(e.pid)) return;
				t = r.retVal < 0;
			} catch {
				t = !0;
			}
			this.completeChannelRaw(e, t ? -5 : 0, t ? 5 : 0);
		}
		this.relistenChannel(e);
	}
	drainMqueueNotification() {
		const e = this.kernelInstance.exports.kernel_mq_drain_notification;
		if (!e) return;
		const t = this.scratchOffset;
		if (e(this.toKernelPtr(t))) {
			const e = new DataView(this.kernelMemory.buffer, t), r = e.getUint32(0, !0), i = e.getUint32(4, !0);
			i > 0 && this.sendSignalToProcess(r, i);
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
	attachKmsCanvas(e, t, r, i) {
		this.kmsCanvases.set(e, t), r && this.kmsStatsViews.set(e, new Int32Array(r));
		const n = i?.mode ?? "auto";
		if ("2d" === n) {
			const r = t.getContext("2d");
			r && (this.kmsContexts.set(e, r), this.kmsContextMode.set(e, "2d"));
		} else "webgl2" === n && this.kmsContextMode.set(e, "webgl2");
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
		for (const [t, r] of this.kmsCanvases) {
			if ("2d" !== this.kmsContextMode.get(t)) continue;
			const e = this.kernel.kms.currentFb(t);
			if (!e) continue;
			const i = this.kernel.kms.scanoutBytes(t);
			if (!i) continue;
			const n = this.kmsContexts.get(t);
			if (!n) continue;
			r.width === e.width && r.height === e.height || (r.width = e.width, r.height = e.height);
			const s = performance.now(), o = e.width * e.height * 4;
			let a = this.kmsScratchBytes.get(t);
			a && a.byteLength === o || (a = new Uint8ClampedArray(new ArrayBuffer(o)), this.kmsScratchBytes.set(t, a)), a.set(i), n.putImageData(new ImageData(a, e.width, e.height), 0, 0);
			const c = 1e3 * (performance.now() - s) | 0, l = this.kmsStatsViews.get(t);
			l && (Atomics.add(l, 0, 1), Atomics.store(l, 1, 0 | performance.now()), Atomics.store(l, 4, c));
		}
		if (this.kmsStatsViews.size > 0) {
			const e = this.kernelInstance?.exports;
			for (const [t, r] of this.kmsStatsViews) {
				const i = this.kernel.kms.currentFb(t);
				if (i && (Atomics.store(r, 2, i.width), Atomics.store(r, 3, i.height)), r.length < 7) continue;
				const n = e?.kernel_kms_commit_count?.(t) ?? 0n, s = e?.kernel_kms_last_frame_us?.(t) ?? 0n;
				Atomics.store(r, 5, Number(2147483647n & n)), Atomics.store(r, 6, Number(2147483647n & s));
			}
		}
	}
}, ts = class {
	entryUrl;
	constructor(e) {
		this.entryUrl = e;
	}
	createWorker(e) {
		const t = new Worker(this.entryUrl, { type: "module" }), r = new rs(t);
		return t.postMessage(e), r;
	}
}, rs = class {
	worker;
	handlers = /* @__PURE__ */ new Map();
	terminated = !1;
	terminationPromise = null;
	constructor(e) {
		this.worker = e, e.onmessage = (e) => {
			for (const t of this.handlers.get("message") ?? []) t(e.data);
		}, e.onerror = (e) => {
			for (const t of this.handlers.get("error") ?? []) t(new Error(e.message));
			if (!this.terminated) {
				this.terminated = !0;
				for (const e of this.handlers.get("exit") ?? []) e(1);
			}
		};
	}
	postMessage(e, t) {
		this.worker.postMessage(e, t ?? []);
	}
	on(e, t) {
		let r = this.handlers.get(e);
		r || (r = /* @__PURE__ */ new Set(), this.handlers.set(e, r)), r.add(t);
	}
	off(e, t) {
		this.handlers.get(e)?.delete(t);
	}
	async terminate() {
		return this.terminationPromise || (this.terminationPromise = this.terminateOnce()), this.terminationPromise;
	}
	async terminateOnce() {
		if (this.worker.terminate(), !this.terminated) {
			this.terminated = !0;
			for (const e of this.handlers.get("exit") ?? []) e(0);
		}
		return 0;
	}
}, is = class {
	create;
	worker = null;
	terminated = !1;
	terminationPromise = null;
	handlers = /* @__PURE__ */ new Map();
	pendingMessages = [];
	constructor(e) {
		this.create = e;
	}
	start() {
		if (this.terminated) return !1;
		if (this.worker) return !0;
		const e = this.create;
		if (!e) return !1;
		let t;
		this.create = null;
		try {
			t = e();
		} catch (r) {
			throw this.terminated = !0, this.pendingMessages.splice(0), r;
		}
		this.worker = t;
		for (const [i, n] of this.handlers) for (const e of n) t.on(i, e);
		this.handlers.clear();
		for (const { message: i, transfer: n } of this.pendingMessages.splice(0)) t.postMessage(i, n);
		return !0;
	}
	postMessage(e, t) {
		this.terminated || (this.worker ? this.worker.postMessage(e, t) : this.pendingMessages.push({
			message: e,
			transfer: t
		}));
	}
	on(e, t) {
		if (this.worker) return void this.worker.on(e, t);
		let r = this.handlers.get(e);
		r || (r = /* @__PURE__ */ new Set(), this.handlers.set(e, r)), r.add(t);
	}
	off(e, t) {
		this.handlers.get(e)?.delete(t), this.worker && this.worker.off(e, t);
	}
	terminate() {
		if (this.terminationPromise) return this.terminationPromise;
		if (this.terminated) return Promise.resolve(0);
		this.terminated = !0, this.create = null, this.pendingMessages.splice(0), this.handlers.clear();
		const e = this.worker;
		return this.worker = null, this.terminationPromise = e?.terminate() ?? Promise.resolve(0), this.terminationPromise;
	}
};
const ns = (1n << 64n) - 1n;
function ss(e, t) {
	if ("bigint" == typeof e) {
		if (e >= 0n && e <= ns) return e;
	} else if (Number.isSafeInteger(e) && e >= 0) return BigInt(e);
	const r = /* @__PURE__ */ new Error(`EOVERFLOW: ${t} is not exactly representable as an unsigned 64-bit value`);
	throw r.code = "EOVERFLOW", r;
}
var os = class {
	mounts;
	time;
	fileHandles = /* @__PURE__ */ new Map();
	dirHandles = /* @__PURE__ */ new Map();
	nextFileHandle = 100;
	nextDirHandle = 1;
	qualifiedDeviceIds = /* @__PURE__ */ new Map();
	nextQualifiedDeviceId = 1n;
	network;
	constructor(e, t) {
		const r = /* @__PURE__ */ new Map();
		let i = 1;
		if (this.mounts = e.map((e) => {
			let t = r.get(e.backend);
			return void 0 === t && (t = i++, r.set(e.backend, t)), {
				prefix: (n = e.mountPoint, "/" !== n && n.endsWith("/") ? n.slice(0, -1) : n),
				backend: e.backend,
				backendId: t
			};
			var n;
		}).sort((e, t) => t.prefix.length - e.prefix.length), this.time = t, 0 === this.mounts.length) throw new Error("VirtualPlatformIO requires at least one mount");
	}
	resolve(e) {
		for (const t of this.mounts) {
			if ("/" === t.prefix) return {
				backend: t.backend,
				backendId: t.backendId,
				relativePath: e
			};
			if (e === t.prefix || e.startsWith(t.prefix + "/")) {
				let r = e.slice(t.prefix.length);
				return r.startsWith("/") || (r = "/" + r), {
					backend: t.backend,
					backendId: t.backendId,
					relativePath: r
				};
			}
		}
		throw new Error(`ENOENT: no mount for path: ${e}`);
	}
	resolveTwoPaths(e, t) {
		const r = this.resolve(e), i = this.resolve(t);
		if (r.backend !== i.backend) throw new Error("EXDEV: cross-device link");
		return {
			backend: r.backend,
			rel1: r.relativePath,
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
	qualifyStat(e, t) {
		const r = ss(t.dev, "st_dev"), i = ss(t.ino, "st_ino");
		let n = this.qualifiedDeviceIds.get(e);
		void 0 === n && (n = /* @__PURE__ */ new Map(), this.qualifiedDeviceIds.set(e, n));
		let s = n.get(r);
		if (void 0 === s) {
			if (this.nextQualifiedDeviceId > ns) {
				const e = /* @__PURE__ */ new Error("EOVERFLOW: exhausted virtual filesystem device identities");
				throw e.code = "EOVERFLOW", e;
			}
			s = this.nextQualifiedDeviceId++, n.set(r, s);
		}
		return {
			...t,
			dev: s,
			ino: i
		};
	}
	fileIdentity(e, t, r) {
		if (r <= 0n || t < 0n) return null;
		const { backendId: i } = this.resolve(e);
		return `vfs:${i}:${t}:${r}`;
	}
	fileHandleIdentity(e, t, r) {
		if (r <= 0n || t < 0n) return null;
		const { backendId: i } = this.getFileHandle(e);
		return `vfs:${i}:${t}:${r}`;
	}
	async preparePath(e) {
		const { backend: t, relativePath: r } = this.resolve(e);
		return t.preparePath?.(r) ?? !1;
	}
	open(e, t, r) {
		const { backend: i, backendId: n, relativePath: s } = this.resolve(e), o = i.open(s, t, r), a = this.nextFileHandle++;
		return this.fileHandles.set(a, {
			backend: i,
			backendId: n,
			localHandle: o
		}), a;
	}
	close(e) {
		const t = this.getFileHandle(e), r = t.backend.close(t.localHandle);
		return this.fileHandles.delete(e), r;
	}
	read(e, t, r, i) {
		const n = this.getFileHandle(e);
		return n.backend.read(n.localHandle, t, r, i);
	}
	write(e, t, r, i) {
		const n = this.getFileHandle(e);
		return n.backend.write(n.localHandle, t, r, i);
	}
	seek(e, t, r) {
		const i = this.getFileHandle(e);
		return i.backend.seek(i.localHandle, t, r);
	}
	fstat(e) {
		const t = this.getFileHandle(e);
		return this.qualifyStat(t.backend, t.backend.fstat(t.localHandle));
	}
	fpathconf(e, t) {
		const r = this.getFileHandle(e);
		return r.backend.fpathconf(r.localHandle, t);
	}
	ftruncate(e, t) {
		const r = this.getFileHandle(e);
		r.backend.ftruncate(r.localHandle, t);
	}
	fsync(e) {
		const t = this.getFileHandle(e);
		t.backend.fsync(t.localHandle);
	}
	fchmod(e, t) {
		const r = this.getFileHandle(e);
		r.backend.fchmod(r.localHandle, t);
	}
	fchown(e, t, r) {
		const i = this.getFileHandle(e);
		i.backend.fchown(i.localHandle, t, r);
	}
	stat(e) {
		const { backend: t, relativePath: r } = this.resolve(e);
		return this.qualifyStat(t, t.stat(r));
	}
	lstat(e) {
		const { backend: t, relativePath: r } = this.resolve(e);
		return this.qualifyStat(t, t.lstat(r));
	}
	statfs(e) {
		const { backend: t, relativePath: r } = this.resolve(e);
		return t.statfs(r);
	}
	pathconf(e, t) {
		const { backend: r, relativePath: i } = this.resolve(e);
		return r.pathconf(i, t);
	}
	mkdir(e, t) {
		const { backend: r, relativePath: i } = this.resolve(e);
		r.mkdir(i, t);
	}
	rmdir(e) {
		const { backend: t, relativePath: r } = this.resolve(e);
		t.rmdir(r);
	}
	unlink(e) {
		const { backend: t, relativePath: r } = this.resolve(e);
		t.unlink(r);
	}
	rename(e, t) {
		const { backend: r, rel1: i, rel2: n } = this.resolveTwoPaths(e, t);
		r.rename(i, n);
	}
	link(e, t) {
		const { backend: r, rel1: i, rel2: n } = this.resolveTwoPaths(e, t);
		r.link(i, n);
	}
	symlink(e, t) {
		const { backend: r, relativePath: i } = this.resolve(t);
		r.symlink(e, i);
	}
	readlink(e) {
		const { backend: t, relativePath: r } = this.resolve(e);
		return t.readlink(r);
	}
	chmod(e, t) {
		const { backend: r, relativePath: i } = this.resolve(e);
		r.chmod(i, t);
	}
	chown(e, t, r) {
		const { backend: i, relativePath: n } = this.resolve(e);
		i.chown(n, t, r);
	}
	lchown(e, t, r) {
		const { backend: i, relativePath: n } = this.resolve(e);
		i.lchown(n, t, r);
	}
	access(e, t) {
		const { backend: r, relativePath: i } = this.resolve(e);
		r.access(i, t);
	}
	utimensat(e, t, r, i, n) {
		const { backend: s, relativePath: o } = this.resolve(e);
		s.utimensat(o, t, r, i, n);
	}
	opendir(e) {
		const { backend: t, backendId: r, relativePath: i } = this.resolve(e), n = t.opendir(i), s = this.nextDirHandle++;
		return this.dirHandles.set(s, {
			backend: t,
			backendId: r,
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
async function as(e, t) {
	await e.preparePath?.(t);
	const r = e.stat(t);
	if (!Number.isSafeInteger(r.size) || r.size < 0) {
		const e = /* @__PURE__ */ new Error(`EOVERFLOW: invalid file size for ${t}`);
		throw e.code = "EOVERFLOW", e;
	}
	const i = e.open(t, 0, 0);
	try {
		const t = new Uint8Array(r.size);
		let n = 0;
		for (; n < t.byteLength;) {
			const r = e.read(i, t.subarray(n), null, t.byteLength - n);
			if (r <= 0) break;
			n += r;
		}
		return {
			data: n === t.byteLength ? t : t.slice(0, n),
			stat: r
		};
	} finally {
		e.close(i);
	}
}
var cs = ArrayBuffer, ls = Uint8Array, hs = Uint16Array, ds = Int16Array, fs = Int32Array, us = function(e, t, r) {
	if (ls.prototype.slice) return ls.prototype.slice.call(e, t, r);
	(null == t || t < 0) && (t = 0), (null == r || r > e.length) && (r = e.length);
	var i = new ls(r - t);
	return i.set(e.subarray(t, r)), i;
}, ps = function(e, t, r, i) {
	if (ls.prototype.fill) return ls.prototype.fill.call(e, t, r, i);
	for ((null == r || r < 0) && (r = 0), (null == i || i > e.length) && (i = e.length); r < i; ++r) e[r] = t;
	return e;
}, ms = function(e, t, r, i) {
	if (ls.prototype.copyWithin) return ls.prototype.copyWithin.call(e, t, r, i);
	for ((null == r || r < 0) && (r = 0), (null == i || i > e.length) && (i = e.length); r < i;) e[t++] = e[r++];
}, gs = [
	"invalid zstd data",
	"window size too large (>2046MB)",
	"invalid block type",
	"FSE accuracy too high",
	"match distance too far back",
	"unexpected EOF"
], ys = function(e, t, r) {
	var i = new Error(t || gs[e]);
	if (i.code = e, Error.captureStackTrace && Error.captureStackTrace(i, ys), !r) throw i;
	return i;
}, ws = function(e, t, r) {
	for (var i = 0, n = 0; i < r; ++i) n |= e[t++] << (i << 3);
	return n;
}, bs = function(e, t) {
	var r, i, n = e[0] | e[1] << 8 | e[2] << 16;
	if (3126568 == n && 253 == e[3]) {
		var s = e[4], o = s >> 5 & 1, a = s >> 2 & 1, c = 3 & s, l = s >> 6;
		8 & s && ys(0);
		var h = 6 - o, d = 3 == c ? 4 : c, f = ws(e, h, d), u = l ? 1 << l : o, p = ws(e, h += d, u) + (1 == l && 256), m = p;
		if (!o) {
			var g = 1 << 10 + (e[5] >> 3);
			m = g + (g >> 3) * (7 & e[5]);
		}
		m > 2145386496 && ys(1);
		var y = new ls((1 == t ? p || m : t ? 0 : m) + 12);
		return y[0] = 1, y[4] = 4, y[8] = 8, {
			b: h + u,
			y: 0,
			l: 0,
			d: f,
			w: t && 1 != t ? t : y.subarray(12),
			e: m,
			o: new fs(y.buffer, 0, 3),
			u: p,
			c: a,
			m: Math.min(131072, m)
		};
	}
	if (25481893 == (n >> 4 | e[3] << 20)) return (((r = e)[i = 4] | r[i + 1] << 8 | r[i + 2] << 16 | r[i + 3] << 24) >>> 0) + 8;
	ys(0);
}, Ss = function(e) {
	for (var t = 0; 1 << t <= e; ++t);
	return t - 1;
}, _s = function(e, t, r) {
	var i = 4 + (t << 3), n = 5 + (15 & e[t]);
	n > r && ys(3);
	for (var s = 1 << n, o = s, a = -1, c = -1, l = -1, h = s, d = new cs(512 + (s << 2)), f = new ds(d, 0, 256), u = new hs(d, 0, 256), p = new hs(d, 512, s), m = 512 + (s << 1), g = new ls(d, m, s), y = new ls(d, m + s); a < 255 && o > 0;) {
		var w = Ss(o + 1), b = i >> 3, S = (1 << w + 1) - 1, _ = (e[b] | e[b + 1] << 8 | e[b + 2] << 16) >> (7 & i) & S, k = (1 << w) - 1, v = S - o - 1, A = _ & k;
		if (A < v ? (i += w, _ = A) : (i += w + 1, _ > k && (_ -= v)), f[++a] = --_, -1 == _ ? (o += _, g[--h] = a) : o -= _, !_) do {
			var I = i >> 3;
			c = (e[I] | e[I + 1] << 8) >> (7 & i) & 3, i += 2, a += c;
		} while (3 == c);
	}
	(a > 255 || o) && ys(0);
	for (var P = 0, E = (s >> 1) + (s >> 3) + 3, C = s - 1, x = 0; x <= a; ++x) {
		var z = f[x];
		if (z < 1) u[x] = -z;
		else for (l = 0; l < z; ++l) {
			g[P] = x;
			do
				P = P + E & C;
			while (P >= h);
		}
	}
	for (P && ys(0), l = 0; l < s; ++l) {
		var M = u[g[l]]++;
		p[l] = (M << (y[l] = n - Ss(M))) - s;
	}
	return [i + 7 >> 3, {
		b: n,
		s: g,
		n: y,
		t: p
	}];
}, ks = _s(new ls([
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
]), 0, 6)[1], vs = _s(new ls([
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
]), 0, 6)[1], As = _s(new ls([
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
]), 0, 5)[1], Is = function(e, t) {
	for (var r = e.length, i = new fs(r), n = 0; n < r; ++n) i[n] = t, t += 1 << e[n];
	return i;
}, Ps = new ls(new fs([
	0,
	0,
	0,
	0,
	16843009,
	50528770,
	134678020,
	202050057,
	269422093
]).buffer, 0, 36), Es = Is(Ps, 0), Cs = new ls(new fs([
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
]).buffer, 0, 53), xs = Is(Cs, 3), zs = function(e, t, r) {
	var i = e.length, n = t.length, s = e[i - 1], o = (1 << r.b) - 1, a = -r.b;
	s || ys(0);
	for (var c = 0, l = r.b, h = (i << 3) - 8 + Ss(s) - l, d = -1; h > a && d < n;) {
		var f = h >> 3;
		c = (c << l | (e[f] | e[f + 1] << 8 | e[f + 2] << 16) >> (7 & h)) & o, t[++d] = r.s[c], h -= l = r.n[c];
	}
	h == a && d + 1 == n || ys(0);
}, Ms = function(e, t, r) {
	var i = 6, n = t.length + 3 >> 2, s = n << 1, o = n + s;
	zs(e.subarray(i, i += e[0] | e[1] << 8), t.subarray(0, n), r), zs(e.subarray(i, i += e[2] | e[3] << 8), t.subarray(n, s), r), zs(e.subarray(i, i += e[4] | e[5] << 8), t.subarray(s, o), r), zs(e.subarray(i), t.subarray(o), r);
}, Ts = function(e, t, r) {
	var i, n = t.b, s = e[n], o = s >> 1 & 3;
	t.l = 1 & s;
	var a = s >> 3 | e[n + 1] << 5 | e[n + 2] << 13, c = (n += 3) + a;
	if (1 == o) {
		if (n >= e.length) return;
		return t.b = n + 1, r ? (ps(r, e[n], t.y, t.y += a), r) : ps(new ls(a), e[n]);
	}
	if (!(c > e.length)) {
		if (0 == o) return t.b = c, r ? (r.set(e.subarray(n, c), t.y), t.y += a, r) : us(e, n, c);
		if (2 == o) {
			var l = e[n], h = 3 & l, d = l >> 2 & 3, f = l >> 4, u = 0, p = 0;
			h < 2 ? 1 & d ? f |= e[++n] << 4 | (2 & d && e[++n] << 12) : f = l >> 3 : (p = d, d < 2 ? (f |= (63 & e[++n]) << 4, u = e[n] >> 6 | e[++n] << 2) : 2 == d ? (f |= e[++n] << 4 | (3 & e[++n]) << 12, u = e[n] >> 2 | e[++n] << 6) : (f |= e[++n] << 4 | (63 & e[++n]) << 12, u = e[n] >> 6 | e[++n] << 2 | e[++n] << 10)), ++n;
			var m = r ? r.subarray(t.y, t.y + t.m) : new ls(t.m), g = m.length - f;
			if (0 == h) m.set(e.subarray(n, n += f), g);
			else if (1 == h) ps(m, e[n++], g);
			else {
				var y = t.h;
				if (2 == h) {
					var w = function(e, t) {
						var r = 0, i = -1, n = new ls(292), s = e[t], o = n.subarray(0, 256), a = n.subarray(256, 268), c = new hs(n.buffer, 268);
						if (s < 128) {
							var l = _s(e, t + 1, 6), h = l[0], d = l[1], f = h << 3, u = e[t += s];
							u || ys(0);
							for (var p = 0, m = 0, g = d.b, y = g, w = (++t << 3) - 8 + Ss(u); !((w -= g) < f);) {
								var b = w >> 3;
								if (p += (e[b] | e[b + 1] << 8) >> (7 & w) & (1 << g) - 1, o[++i] = d.s[p], (w -= y) < f) break;
								m += (e[b = w >> 3] | e[b + 1] << 8) >> (7 & w) & (1 << y) - 1, o[++i] = d.s[m], g = d.n[p], p = d.t[p], y = d.n[m], m = d.t[m];
							}
							++i > 255 && ys(0);
						} else {
							for (i = s - 127; r < i; r += 2) {
								var S = e[++t];
								o[r] = S >> 4, o[r + 1] = 15 & S;
							}
							++t;
						}
						var _ = 0;
						for (r = 0; r < i; ++r) (I = o[r]) > 11 && ys(0), _ += I && 1 << I - 1;
						var k = Ss(_) + 1, v = 1 << k, A = v - _;
						for (A & A - 1 && ys(0), o[i++] = Ss(A) + 1, r = 0; r < i; ++r) {
							var I = o[r];
							++a[o[r] = I && k + 1 - I];
						}
						var P = new ls(v << 1), E = P.subarray(0, v), C = P.subarray(v);
						for (c[k] = 0, r = k; r > 0; --r) {
							var x = c[r];
							ps(C, r, x, c[r - 1] = x + a[r] * (1 << k - r));
						}
						for (c[0] != v && ys(0), r = 0; r < i; ++r) {
							var z = o[r];
							if (z) {
								var M = c[z];
								ps(E, r, M, c[z] = M + (1 << k - z));
							}
						}
						return [t, {
							n: C,
							b: k,
							s: E
						}];
					}(e, n);
					u += n - (n = w[0]), t.h = y = w[1];
				} else y || ys(0);
				(p ? Ms : zs)(e.subarray(n, n += u), m.subarray(g), y);
			}
			var b = e[n++];
			if (b) {
				255 == b ? b = 32512 + (e[n++] | e[n++] << 8) : b > 127 && (b = b - 128 << 8 | e[n++]);
				var S = e[n++];
				3 & S && ys(0);
				for (var _ = [
					vs,
					As,
					ks
				], k = 2; k > -1; --k) {
					var v = S >> 2 + (k << 1) & 3;
					if (1 == v) {
						var A = new ls([
							0,
							0,
							e[n++]
						]);
						_[k] = {
							s: A.subarray(2, 3),
							n: A.subarray(0, 1),
							t: new hs(A.buffer, 0, 1),
							b: 0
						};
					} else 2 == v ? (n = (i = _s(e, n, 9 - (1 & k)))[0], _[k] = i[1]) : 3 == v && (t.t || ys(0), _[k] = t.t[k]);
				}
				var I = t.t = _, P = I[0], E = I[1], C = I[2], x = e[c - 1];
				x || ys(0);
				var z = (c << 3) - 8 + Ss(x) - C.b, M = z >> 3, T = 0, L = (e[M] | e[M + 1] << 8) >> (7 & z) & (1 << C.b) - 1, B = (e[M = (z -= E.b) >> 3] | e[M + 1] << 8) >> (7 & z) & (1 << E.b) - 1, R = (e[M = (z -= P.b) >> 3] | e[M + 1] << 8) >> (7 & z) & (1 << P.b) - 1;
				for (++b; --b;) {
					var U = C.s[L], F = C.n[L], H = P.s[R], $ = P.n[R], W = E.s[B], D = E.n[B], O = 1 << W, N = O + ((e[M = (z -= W) >> 3] | e[M + 1] << 8 | e[M + 2] << 16 | e[M + 3] << 24) >>> (7 & z) & O - 1);
					M = (z -= Cs[H]) >> 3;
					var K = xs[H] + ((e[M] | e[M + 1] << 8 | e[M + 2] << 16) >> (7 & z) & (1 << Cs[H]) - 1);
					M = (z -= Ps[U]) >> 3;
					var V = Es[U] + ((e[M] | e[M + 1] << 8 | e[M + 2] << 16) >> (7 & z) & (1 << Ps[U]) - 1);
					if (M = (z -= F) >> 3, L = C.t[L] + ((e[M] | e[M + 1] << 8) >> (7 & z) & (1 << F) - 1), M = (z -= $) >> 3, R = P.t[R] + ((e[M] | e[M + 1] << 8) >> (7 & z) & (1 << $) - 1), M = (z -= D) >> 3, B = E.t[B] + ((e[M] | e[M + 1] << 8) >> (7 & z) & (1 << D) - 1), N > 3) t.o[2] = t.o[1], t.o[1] = t.o[0], t.o[0] = N -= 3;
					else {
						var q = N - (0 != V);
						q ? (N = 3 == q ? t.o[0] - 1 : t.o[q], q > 1 && (t.o[2] = t.o[1]), t.o[1] = t.o[0], t.o[0] = N) : N = t.o[0];
					}
					for (k = 0; k < V; ++k) m[T + k] = m[g + k];
					g += V;
					var G = (T += V) - N;
					if (G < 0) {
						var j = -G, X = t.e + G;
						j > K && (j = K);
						for (k = 0; k < j; ++k) m[T + k] = t.w[X + k];
						T += j, K -= j, G = 0;
					}
					for (k = 0; k < K; ++k) m[T + k] = m[G + k];
					T += K;
				}
				if (T != g) for (; g < m.length;) m[T++] = m[g++];
				else T = m.length;
				r ? t.y += T : m = us(m, 0, T);
			} else if (r) {
				if (t.y += f, g) for (k = 0; k < f; ++k) m[k] = m[g + k];
			} else g && (m = us(m, g));
			return t.b = c, m;
		}
		ys(2);
	}
};
function Ls(e, t) {
	for (var r = [], i = +!t, n = 0, s = 0; e.length;) {
		var o = bs(e, i || t);
		if ("object" == typeof o) {
			for (i ? (t = null, o.w.length == o.u && (r.push(t = o.w), s += o.u)) : (r.push(t), o.e = 0); !o.l;) {
				var a = Ts(e, o, t);
				a || ys(5), t ? o.e = o.y : (r.push(a), s += a.length, ms(o.w, 0, a.length), o.w.set(a, o.w.length - a.length));
			}
			n = o.b + 4 * o.c;
		} else n = o;
		e = e.subarray(n);
	}
	return function(e, t) {
		if (1 == e.length) return e[0];
		for (var r = new ls(t), i = 0, n = 0; i < e.length; ++i) {
			var s = e[i];
			r.set(s, n), n += s.length;
		}
		return r;
	}(r, s);
}
function Bs(e) {
	const t = /* @__PURE__ */ new Error(`EINVAL: pathconf name ${e} is not associated with this object`);
	throw t.code = "EINVAL", t;
}
function Rs(e, t, r) {
	switch (t) {
		case Ft: return null;
		case Wt: return 255;
		case Dt: return 4096;
		case Nt:
		case Kt: return 1;
		case Gt: return 32768 == (61440 & e.mode) ? 1 : Bs(t);
		case qt:
		case jt:
		case Yt:
		case Zt:
		case Jt:
		case Qt:
		case er:
		case tr:
		case rr:
		case nr: return null;
		case ir: return r.supportsSymlinks ? 1 : null;
		case sr: return 255;
		case or: return r.timestampResolutionNs;
		case Ot: {
			const r = 61440 & e.mode;
			return 4096 === r || 16384 === r ? null : Bs(t);
		}
		case Ht:
		case $t:
		case Vt:
		case Xt: return Bs(t);
		default: {
			const e = /* @__PURE__ */ new Error(`EINVAL: invalid pathconf name ${t}`);
			throw e.code = "EINVAL", e;
		}
	}
}
const Us = 4096, Fs = 1024, Hs = Math.floor(160), $s = 61440, Ws = 4294967295, Ds = 12, Os = 16, Ns = 28, Ks = 12, Vs = 16, qs = 24, Gs = 32, js = 48, Xs = 92, Ys = 100, Zs = 104, Js = 112, Qs = 120, eo = -2147483648, to = 4299202560, ro = {
	[-2]: "No such file or directory",
	[-5]: "I/O error",
	[-9]: "Bad file descriptor",
	[-16]: "Device or resource busy",
	[-17]: "File exists",
	[-20]: "Not a directory",
	[-21]: "Is a directory",
	[-22]: "Invalid argument",
	[-24]: "Too many open files",
	[-27]: "File too large",
	[-28]: "No space left on device",
	[-36]: "File name too long",
	[-39]: "Directory not empty",
	[-40]: "Too many symbolic links",
	[-75]: "Value too large for data type"
};
var io = class extends Error {
	code;
	constructor(e, t) {
		super(t || ro[e] || `Error ${e}`), this.code = e, this.name = "SFSError";
	}
};
const no = new TextEncoder(), so = new TextDecoder(), oo = no.encode("..");
function ao(e) {
	return "." === e || ".." === e;
}
function co(e) {
	return e.buffer instanceof SharedArrayBuffer ? so.decode(new Uint8Array(e)) : so.decode(e);
}
function lo(e) {
	return e + 3 & -4;
}
var ho = class e {
	buffer;
	view;
	i32;
	u8;
	dirIndexes = /* @__PURE__ */ new Map();
	blockAllocHint = 0;
	inodeAllocHint = 2;
	atomicsWaitAllowed;
	static DIR_INDEX_MIN_SIZE = 65536;
	constructor(e) {
		this.buffer = e, this.view = new DataView(e), this.i32 = new Int32Array(e), this.u8 = new Uint8Array(e);
	}
	static mkfs(t, r) {
		const i = t.byteLength;
		if (i < 65536) throw new io(-22);
		let n = Math.floor(i / Us);
		const s = r ? Math.floor(r / Us) : 4 * n;
		let o = Math.floor(s / 4);
		o < 32 && (o = 32), o = 32 * Math.ceil(o / 32);
		const a = Math.ceil(o / 32768), c = Math.ceil(s / 32768), l = Math.ceil(128 * o / Us), h = 1 + a, d = h + c, f = d + l;
		if (f >= n) {
			const e = (f + 1) * Us;
			try {
				t.grow(e);
			} catch {
				throw new io(-28);
			}
			if (n = Math.floor(t.byteLength / Us), f >= n) throw new io(-28);
		}
		new Uint8Array(t).fill(0);
		const u = new e(t);
		u.w32(0, 1397114451), u.w32(4, 1), u.w32(8, Us), u.w32(Ds, n), u.w32(Os, o), u.w32(Ns, 1), u.w32(32, h), u.w32(36, d), u.w32(40, f), u.w32(44, a), u.w32(48, c), u.w32(52, l), u.w32(68, s), u.w32(72, 256);
		const p = h * Us;
		for (let e = 0; e < f; e++) {
			const t = (p >> 2) + (e >> 5);
			u.i32[t] |= 1 << (31 & e);
		}
		const m = n - f;
		Atomics.store(u.i32, 5, m), u.blockAllocHint = f, u.i32[1024] |= 3, Atomics.store(u.i32, 6, o - 2), u.inodeAllocHint = 2;
		const g = u.inodeOffset(1);
		u.w32(g + 8, 16877), u.w32(g + Ks, 2), u.w64(g + Zs, 1);
		const y = u.blockAlloc();
		if (y < 0) throw new io(-28);
		u.w32(g + js, y);
		const w = y * Us, b = lo(9), S = lo(10);
		u.w32(w, 1), u.view.setUint16(w + 4, b, !0), u.view.setUint16(w + 6, 1, !0), u.u8[w + 8] = 46;
		const _ = w + b;
		return u.w32(_, 1), u.view.setUint16(_ + 4, S, !0), u.view.setUint16(_ + 6, 2, !0), u.u8[_ + 8] = 46, u.u8[_ + 8 + 1] = 46, u.w64(g + Vs, b + S), Atomics.store(u.i32, 14, 1), u;
	}
	static inspectImageCapacity(e) {
		if (e.byteLength < 72) throw new io(-22, "SharedFS image is too small");
		const t = new DataView(e.buffer, e.byteOffset, e.byteLength);
		if (1397114451 !== t.getUint32(0, !0)) throw new io(-22, "Bad magic");
		if (1 !== t.getUint32(4, !0)) throw new io(-22, "Bad version");
		const r = t.getUint32(8, !0);
		if (4096 !== r) throw new io(-22, "Bad block size");
		const i = t.getUint32(68, !0) * r;
		return {
			byteLength: e.byteLength,
			maxByteLength: Math.max(e.byteLength, i)
		};
	}
	static mount(t, r) {
		const i = new e(t);
		if (1397114451 !== i.r32(0)) throw new io(-22, "Bad magic");
		if (1 !== i.r32(4)) throw new io(-22, "Bad version");
		if (4096 !== i.r32(8)) throw new io(-22, "Bad block size");
		return r?.restoreImage && i.resetRestoredRuntimeState(), i.resetAllocationHints(), i;
	}
	snapshotBytes(e) {
		return this.withNamespaceLock(() => this.snapshotBytesUnlocked(e));
	}
	snapshotState(e) {
		return this.withNamespaceLock(() => ({
			bytes: this.snapshotBytesUnlocked(e),
			identities: this.collectIdentityStateUnlocked()
		}));
	}
	identityState() {
		return this.withNamespaceLock(() => this.collectIdentityStateUnlocked());
	}
	snapshotBytesUnlocked(e) {
		const t = e?.normalizeTimestampsMs;
		if (void 0 !== t && (!Number.isSafeInteger(t) || t < 0)) throw new io(-22, "Snapshot timestamp must be a non-negative safe integer in milliseconds");
		const r = void 0 === t ? void 0 : BigInt(t);
		for (let o = 0; o < Hs; o++) {
			const e = 256 + 24 * o;
			if (0 !== Atomics.load(this.i32, e >> 2)) throw new io(-16, "Cannot save a VFS image with open descriptors");
		}
		const i = this.r32(Os);
		for (let o = 0; o < i; o++) {
			const e = this.inodeOffset(o);
			if (0 !== this.r32(e + Js)) throw new io(-16, "Cannot save a VFS image with open inode references");
		}
		const n = new Uint8Array(this.buffer.byteLength);
		n.set(this.u8);
		const s = new DataView(n.buffer);
		s.setUint32(60, 0, !0), s.setUint32(64, 0, !0), n.fill(0, 256, Us);
		for (let o = 0; o < i; o++) {
			const e = this.inodeOffset(o);
			if (s.setUint32(e + 0, 0, !0), s.setUint32(e + Js, 0, !0), void 0 !== r) {
				const t = o >= 1 && this.inodeIsAllocated(o) ? r : 0n;
				s.setBigUint64(e + 40, t, !0), s.setBigUint64(e + qs, t, !0), s.setBigUint64(e + Gs, t, !0);
			}
		}
		return n;
	}
	collectIdentityStateUnlocked() {
		const e = /* @__PURE__ */ new Map(), t = this.inodeOffset(1), r = this.r64(t + Zs);
		e.set(`1:${r}`, {
			ino: 1,
			generation: r,
			dataSequence: Atomics.load(this.i32, t + Qs >> 2) >>> 0,
			mode: this.r32(t + 8),
			linkCount: this.r32(t + Ks),
			size: this.r64(t + Vs),
			uid: this.r32(t + 96),
			gid: this.r32(t + Ys),
			paths: ["/"]
		});
		const i = [{
			ino: 1,
			path: "/"
		}], n = /* @__PURE__ */ new Set();
		for (; i.length > 0;) {
			const t = i.pop();
			if (n.has(t.ino)) throw new io(-5);
			n.add(t.ino);
			const r = this.inodeOffset(t.ino);
			if (16384 != (61440 & this.r32(r + 8))) throw new io(-5);
			const s = this.r64(r + Vs);
			let o = 0;
			for (; o < s;) {
				const r = Math.floor(o / Us), n = o % Us, a = this.inodeBlockMap(t.ino, r, !1);
				if (a <= 0) throw new io(-5);
				const c = a * Us, l = Math.min(s - o, Us - n);
				let h = n;
				for (; h < n + l;) {
					const r = c + h, s = this.r32(r), o = this.view.getUint16(r + 4, !0), a = this.view.getUint16(r + 6, !0);
					if (!this.isValidDirEntry(h, n + l, o, a)) throw new io(-5);
					if (0 !== s) {
						if (!this.inodeIsAllocated(s)) throw new io(-5);
						const n = co(this.u8.subarray(r + 8, r + 8 + a));
						if ("." !== n && ".." !== n) {
							const r = "/" === t.path ? `/${n}` : `${t.path}/${n}`, o = this.inodeOffset(s), a = this.r64(o + Zs), c = `${s}:${a}`;
							let l = e.get(c);
							if (!l) {
								const t = this.r32(o + 8);
								l = {
									ino: s,
									generation: a,
									dataSequence: Atomics.load(this.i32, o + Qs >> 2) >>> 0,
									mode: t,
									linkCount: this.r32(o + Ks),
									size: this.r64(o + Vs),
									uid: this.r32(o + 96),
									gid: this.r32(o + Ys),
									...40960 == (61440 & t) ? { symlinkTarget: this.readSymlinkInodeUnlocked(s) } : {},
									paths: []
								}, e.set(c, l);
							}
							l.paths.push(r), 16384 == (61440 & this.r32(o + 8)) && i.push({
								ino: s,
								path: r
							});
						}
					}
					h += o;
				}
				o += l;
			}
		}
		return e;
	}
	statfs() {
		const e = this.r32(8), t = this.r32(Ds), r = this.r32(68), i = "number" == typeof this.buffer.maxByteLength ? this.buffer.maxByteLength : this.buffer.byteLength, n = Math.floor(i / e), s = Math.max(t, Math.min(r, n));
		return {
			blockSize: e,
			totalBlocks: s,
			freeBlocks: Atomics.load(this.i32, 5) + Math.max(0, s - t),
			totalInodes: this.r32(Os),
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
	waitForAtomicChange(e, t) {
		if (!1 !== this.atomicsWaitAllowed) try {
			Atomics.wait(this.i32, e, t), this.atomicsWaitAllowed = !0;
			return;
		} catch (r) {
			if (!(r instanceof TypeError)) throw r;
			this.atomicsWaitAllowed = !1;
		}
		for (; Atomics.load(this.i32, e) === t;);
	}
	resetAllocationHints() {
		this.blockAllocHint = this.findNextFreeBlockHint(), this.inodeAllocHint = this.findNextFreeInodeHint();
	}
	findNextFreeBlockHint() {
		const e = this.r32(Ds), t = this.r32(40), r = this.r32(32) * Us;
		for (let i = t; i < e; i++) {
			const e = (r >> 2) + (i >> 5), t = 31 & i;
			if (!(Atomics.load(this.i32, e) & 1 << t)) return i;
		}
		return t;
	}
	findNextFreeInodeHint() {
		const e = this.r32(Os), t = this.r32(Ns) * Us;
		for (let r = 2; r < e; r++) {
			const e = (t >> 2) + (r >> 5), i = 31 & r;
			if (!(Atomics.load(this.i32, e) & 1 << i)) return r;
		}
		return 2;
	}
	sbLock() {
		for (;;) {
			if (0 === Atomics.compareExchange(this.i32, 15, 0, 1)) return;
			this.waitForAtomicChange(15, 1);
		}
	}
	sbUnlock() {
		Atomics.store(this.i32, 15, 0), Atomics.notify(this.i32, 15, Infinity);
	}
	namespaceLock() {
		for (;;) {
			if (0 === Atomics.compareExchange(this.i32, 16, 0, 1)) return;
			this.waitForAtomicChange(16, 1);
		}
	}
	namespaceUnlock() {
		Atomics.store(this.i32, 16, 0), Atomics.notify(this.i32, 16, Infinity);
	}
	withNamespaceLock(e) {
		this.namespaceLock();
		try {
			return e();
		} finally {
			this.namespaceUnlock();
		}
	}
	resetRestoredRuntimeState() {
		Atomics.store(this.i32, 15, 0), Atomics.store(this.i32, 16, 0), this.u8.fill(0, 256, Us);
		const e = this.r32(Os), t = this.r32(Ns) * Us;
		for (let r = 0; r < e; r++) {
			const e = this.inodeOffset(r);
			if (this.w32(e + 0, 0), this.w32(e + Js, 0), r < 2) continue;
			if (!(this.r32(t + 4 * (r >> 5)) & 1 << (31 & r))) continue;
			if (0 !== this.r32(e + Ks)) continue;
			const i = this.r32(e + 8), n = this.r64(e + Vs);
			40960 == (61440 & i) && n <= 40 ? (this.u8.fill(0, e + js, e + js + 40), this.w64(e + Vs, 0)) : this.inodeTruncate(r, 0), this.inodeFree(r);
		}
	}
	blockAlloc() {
		const e = this.r32(Ds), t = this.r32(32) * Us, r = this.r32(40), i = this.blockAllocHint >= r && this.blockAllocHint < e ? this.blockAllocHint : r, n = e - r;
		for (let s = 0; s < n; s++) {
			const o = r + (i - r + s) % n, a = (t >> 2) + (o >> 5), c = 31 & o, l = Atomics.load(this.i32, a);
			if (l & 1 << c) continue;
			const h = l | 1 << c;
			if (Atomics.compareExchange(this.i32, a, l, h) === l) {
				Atomics.sub(this.i32, 5, 1), this.blockAllocHint = o + 1 < e ? o + 1 : r;
				const t = o * Us;
				return this.u8.fill(0, t, t + Us), o;
			}
			s--;
		}
		return -28;
	}
	blockAllocWithGrow() {
		let e = this.blockAlloc();
		return -28 !== e ? e : this.grow() < 0 ? -28 : (e = this.blockAlloc(), e);
	}
	blockFree(e) {
		const t = (this.r32(32) * Us >> 2) + (e >> 5), r = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t), i = e & ~(1 << r);
			if (Atomics.compareExchange(this.i32, t, e, i) === e) break;
		}
		Atomics.add(this.i32, 5, 1), e >= this.r32(40) && e < this.blockAllocHint && (this.blockAllocHint = e);
	}
	grow() {
		this.sbLock();
		try {
			if (Atomics.load(this.i32, 5) > 0) return 0;
			const e = this.r32(Ds), t = this.r32(68);
			let r = this.r32(72), i = e + r;
			if (i > t && (i = t, r = i - e, 0 === r)) return -28;
			const n = i * Us;
			if (this.buffer.byteLength < n) try {
				this.buffer.grow(n), this.view = new DataView(this.buffer), this.i32 = new Int32Array(this.buffer), this.u8 = new Uint8Array(this.buffer);
			} catch {
				return -28;
			}
			return this.w32(Ds, i), Atomics.add(this.i32, 5, r), Atomics.add(this.i32, 14, 1), this.blockAllocHint = e, 0;
		} finally {
			this.sbUnlock();
		}
	}
	inodeOffset(e) {
		return (this.r32(36) + Math.floor(e / 32)) * Us + e % 32 * 128;
	}
	inodeAlloc() {
		const e = this.r32(Os), t = this.r32(Ns) * Us, r = this.inodeAllocHint >= 2 && this.inodeAllocHint < e ? this.inodeAllocHint : 2, i = e - 2;
		for (let n = 0; n < i; n++) {
			const s = 2 + (r - 2 + n) % i, o = (t >> 2) + (s >> 5), a = 31 & s, c = Atomics.load(this.i32, o);
			if (c & 1 << a) continue;
			const l = c | 1 << a;
			if (Atomics.compareExchange(this.i32, o, c, l) === c) {
				Atomics.sub(this.i32, 6, 1), this.inodeAllocHint = s + 1 < e ? s + 1 : 2;
				const t = this.inodeOffset(s);
				return this.u8.fill(0, t, t + 128), this.w64(t + Zs, this.nextInodeGeneration()), s;
			}
			n--;
		}
		return -28;
	}
	nextInodeGeneration() {
		return Atomics.add(this.i32, 14, 1) + 1;
	}
	inodeFree(e) {
		const t = (this.r32(Ns) * Us >> 2) + (e >> 5), r = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t);
			if (!(e & 1 << r)) throw new io(-5);
			const i = e & ~(1 << r);
			if (Atomics.compareExchange(this.i32, t, e, i) === e) break;
		}
		Atomics.add(this.i32, 6, 1), e >= 2 && e < this.inodeAllocHint && (this.inodeAllocHint = e);
	}
	inodeAddOpenRef(e) {
		this.inodeWriteLock(e);
		try {
			const t = this.inodeOffset(e);
			return 0 !== this.r32(t + Ks) && (this.w32(t + Js, this.r32(t + Js) + 1), !0);
		} finally {
			this.inodeWriteUnlock(e);
		}
	}
	inodeDropOpenRef(e) {
		let t = !1;
		this.inodeWriteLock(e);
		try {
			const r = this.inodeOffset(e), i = this.r32(r + Js);
			i > 0 && this.w32(r + Js, i - 1), i <= 1 && 0 === this.r32(r + Ks) && (this.inodeTruncate(e, 0), t = !0);
		} finally {
			this.inodeWriteUnlock(e);
		}
		t && this.inodeFree(e);
	}
	inodeDropLinkRefLocked(e) {
		const t = this.inodeOffset(e), r = this.r32(t + Ks);
		return r > 1 ? (this.w32(t + Ks, r - 1), this.w64(t + Gs, Date.now()), !1) : this.inodeOrphanLocked(e);
	}
	inodeOrphanLocked(e) {
		const t = this.inodeOffset(e);
		if (this.w32(t + Ks, 0), this.w64(t + Gs, Date.now()), this.r32(t + Js) > 0) return !1;
		const r = this.r32(t + 8), i = this.r64(t + Vs);
		return 40960 == (61440 & r) && i <= 40 ? (this.u8.fill(0, t + js, t + js + 40), this.w64(t + Vs, 0)) : this.inodeTruncate(e, 0), !0;
	}
	inodeReadLock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		for (;;) {
			const e = Atomics.load(this.i32, t);
			if (e & eo) this.waitForAtomicChange(t, e);
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
				if (0 === Atomics.compareExchange(this.i32, t, 0, eo)) return;
			} else this.waitForAtomicChange(t, e);
		}
	}
	inodeWriteUnlock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		Atomics.store(this.i32, t, 0), Atomics.notify(this.i32, t, Infinity);
	}
	inodeBlockMap(e, t, r) {
		const i = this.inodeOffset(e);
		if (t < 10) {
			const e = this.r32(i + js + 4 * t);
			if (0 !== e) return e;
			if (!r) return 0;
			const n = this.blockAllocWithGrow();
			return n < 0 || this.w32(i + js + 4 * t, n), n;
		}
		if ((t -= 10) < 1024) {
			let e = this.r32(i + 88), n = !1;
			if (0 === e) {
				if (!r) return 0;
				if (e = this.blockAllocWithGrow(), e < 0) return e;
				this.w32(i + 88, e), n = !0;
			}
			const s = e * Us + 4 * t, o = this.r32(s);
			if (0 !== o) return o;
			if (!r) return 0;
			const a = this.blockAllocWithGrow();
			return a < 0 ? (n && (this.w32(i + 88, 0), this.blockFree(e)), a) : (this.w32(s, a), a);
		}
		if ((t -= Fs) < 1048576) {
			const e = Math.floor(t / Fs), n = t % Fs;
			let s = this.r32(i + Xs), o = !1;
			if (0 === s) {
				if (!r) return 0;
				if (s = this.blockAllocWithGrow(), s < 0) return s;
				this.w32(i + Xs, s), o = !0;
			}
			const a = s * Us + 4 * e;
			let c = this.r32(a), l = !1;
			if (0 === c) {
				if (!r) return 0;
				if (c = this.blockAllocWithGrow(), c < 0) return o && (this.w32(i + Xs, 0), this.blockFree(s)), c;
				this.w32(a, c), l = !0;
			}
			const h = c * Us + 4 * n, d = this.r32(h);
			if (0 !== d) return d;
			if (!r) return 0;
			const f = this.blockAllocWithGrow();
			return f < 0 ? (l && (this.w32(a, 0), this.blockFree(c)), o && (this.w32(i + Xs, 0), this.blockFree(s)), f) : (this.w32(h, f), f);
		}
		return -22;
	}
	inodeReadData(e, t, r, i) {
		const n = this.inodeOffset(e), s = this.r64(n + Vs);
		if (t >= s) return 0;
		t + i > s && (i = s - t);
		let o = 0, a = 0;
		for (; i > 0;) {
			const n = Math.floor(t / Us), s = t % Us;
			let c = Us - s;
			c > i && (c = i);
			const l = this.inodeBlockMap(e, n, !1);
			if (l <= 0) r.fill(0, a, a + c);
			else {
				const e = l * Us + s;
				r.set(this.u8.subarray(e, e + c), a);
			}
			a += c, t += c, i -= c, o += c;
		}
		return o;
	}
	inodeWriteData(e, t, r, i) {
		const n = this.inodeOffset(e), s = this.r64(n + Vs);
		t > s && this.zeroOldEofTail(e, s);
		let o = 0, a = 0;
		for (; i > 0;) {
			const n = Math.floor(t / Us), s = t % Us;
			let c = Us - s;
			c > i && (c = i);
			const l = this.inodeBlockMap(e, n, !0);
			if (l < 0) {
				if (0 === o) return l;
				break;
			}
			const h = l * Us + s;
			this.u8.set(r.subarray(a, a + c), h), a += c, t += c, i -= c, o += c;
		}
		if (o > 0 && t > this.r64(n + Vs) && this.w64(n + Vs, t), o > 0) {
			const e = Date.now();
			this.w64(n + qs, e), this.w64(n + Gs, e), Atomics.add(this.i32, n + Qs >> 2, 1);
		}
		return o;
	}
	zeroInodeRange(e, t, r) {
		for (; t < r;) {
			const i = Math.floor(t / Us), n = t % Us, s = Math.min(Us - n, r - t), o = this.inodeBlockMap(e, i, !1);
			if (o > 0) {
				const e = o * Us + n;
				this.u8.fill(0, e, e + s);
			}
			t += s;
		}
	}
	zeroOldEofTail(e, t) {
		const r = t % Us;
		if (0 === r) return;
		const i = Math.floor(t / Us), n = this.inodeBlockMap(e, i, !1);
		if (n <= 0) return;
		const s = n * Us + r;
		this.u8.fill(0, s, n * Us + Us);
	}
	freeBlocksFrom(e, t) {
		const r = this.inodeOffset(e);
		for (let s = t; s < 10; s++) {
			const e = this.r32(r + js + 4 * s);
			e && (this.blockFree(e), this.w32(r + js + 4 * s, 0));
		}
		const i = this.r32(r + 88);
		if (i) {
			const e = t > 10 ? t - 10 : 0;
			for (let t = e; t < Fs; t++) {
				const e = i * Us + 4 * t, r = this.r32(e);
				r && (this.blockFree(r), this.w32(e, 0));
			}
			0 === e && (this.blockFree(i), this.w32(r + 88, 0));
		}
		const n = this.r32(r + Xs);
		if (n) {
			const e = t > 1034 ? t - 10 - Fs : 0, i = Math.floor(e / Fs);
			for (let t = i; t < Fs; t++) {
				const r = n * Us + 4 * t, s = this.r32(r);
				if (!s) continue;
				const o = t === i ? e % Fs : 0;
				for (let e = o; e < Fs; e++) {
					const t = s * Us + 4 * e, r = this.r32(t);
					r && (this.blockFree(r), this.w32(t, 0));
				}
				0 === o && (this.blockFree(s), this.w32(r, 0));
			}
			0 === i && (this.blockFree(n), this.w32(r + Xs, 0));
		}
	}
	inodeTruncate(e, t, r = !1) {
		const i = this.inodeOffset(e), n = this.r64(i + Vs), s = t !== n;
		if (t >= n) {
			if (t > n && this.zeroOldEofTail(e, n), this.w64(i + Vs, t), s || r) {
				const e = Date.now();
				this.w64(i + qs, e), this.w64(i + Gs, e), Atomics.add(this.i32, i + Qs >> 2, 1);
			}
			return;
		}
		t % 4096 != 0 && this.zeroInodeRange(e, t, Math.ceil(t / Us) * Us);
		const o = Math.ceil(t / Us);
		if (this.freeBlocksFrom(e, o), this.w64(i + Vs, t), s || r) {
			const e = Date.now();
			this.w64(i + qs, e), this.w64(i + Gs, e), Atomics.add(this.i32, i + Qs >> 2, 1);
		}
	}
	validateFileSize(e) {
		if (!Number.isSafeInteger(e) || e < 0) throw new io(-22);
		if (e > to) throw new io(-27);
	}
	validateSeekPosition(e) {
		if (!Number.isSafeInteger(e)) throw new io(-75);
		if (e < 0) throw new io(-22);
		if (e > to) throw new io(-27);
	}
	touchDirectoryMutation(e) {
		const t = this.inodeOffset(e), r = Date.now();
		this.w64(t + qs, r), this.w64(t + Gs, r);
		const i = Atomics.add(this.i32, t + 116 >> 2, 1) + 1 >>> 0, n = this.dirIndexes.get(e);
		n && (n.mutationSequence = i, n.size = this.r64(t + Vs));
	}
	dirNameKey(e) {
		return co(e);
	}
	dirEntryNameMatches(e, t) {
		if (this.view.getUint16(e + 6, !0) !== t.length) return !1;
		for (let r = 0; r < t.length; r++) if (this.u8[e + 8 + r] !== t[r]) return !1;
		return !0;
	}
	isValidDirEntry(e, t, r, i) {
		return r >= 8 && r % 4 == 0 && e + r <= t && i <= r - 8;
	}
	inodeIsAllocated(e) {
		const t = this.r32(Os);
		if (e <= 0 || e >= t) return !1;
		const r = this.r32(Ns) * Us;
		return !!(Atomics.load(this.i32, (r >> 2) + (e >> 5)) & 1 << (31 & e));
	}
	rebuildDirIndex(e, t, r, i) {
		const n = /* @__PURE__ */ new Map(), s = [];
		let o = 0;
		for (; o < i;) {
			const t = Math.floor(o / Us), r = o % Us, a = this.inodeBlockMap(e, t, !1);
			if (a <= 0) return -5;
			const c = a * Us;
			let l = i - o;
			l > 4096 - r && (l = Us - r);
			let h = r;
			for (; h < r + l;) {
				const e = c + h, t = this.r32(e), i = this.view.getUint16(e + 4, !0), o = this.view.getUint16(e + 6, !0);
				if (!this.isValidDirEntry(h, r + l, i, o)) return -5;
				if (0 !== t) {
					if (!this.inodeIsAllocated(t)) return -5;
					const r = co(this.u8.subarray(e + 8, e + 8 + o));
					n.set(r, {
						ino: t,
						abs: e,
						recLen: i,
						nameLen: o
					});
				} else i >= 8 && s.push({
					abs: e,
					recLen: i
				});
				h += i;
			}
			o += l;
		}
		const a = {
			generation: t,
			mutationSequence: r,
			size: i,
			entries: n,
			free: s
		};
		return this.dirIndexes.set(e, a), a;
	}
	getDirIndex(t) {
		const r = this.inodeOffset(t), i = this.r64(r + Vs), n = this.r64(r + Zs), s = Atomics.load(this.i32, r + 116 >> 2) >>> 0, o = this.dirIndexes.get(t);
		return o && o.generation === n && o.mutationSequence === s && o.size === i ? o : (o && this.dirIndexes.delete(t), i < e.DIR_INDEX_MIN_SIZE ? null : this.rebuildDirIndex(t, n, s, i));
	}
	updateDirIndexAdd(e, t, r, i, n) {
		const s = this.inodeOffset(e), o = this.r64(s + Vs), a = this.r64(s + Zs), c = this.dirIndexes.get(e);
		c && (c.generation === a ? (c.size = o, c.entries.set(this.dirNameKey(t), {
			ino: r,
			abs: i,
			recLen: n,
			nameLen: t.length
		})) : this.dirIndexes.delete(e));
	}
	useDirIndexFreeSlot(e, t, r, i) {
		const n = lo(8 + r.length);
		for (let s = e.free.length - 1; s >= 0; s--) {
			const o = e.free[s];
			if (!(o.recLen < n) && (e.free.splice(s, 1), 0 === this.r32(o.abs) && this.view.getUint16(o.abs + 4, !0) === o.recLen)) return this.w32(o.abs, i), this.view.setUint16(o.abs + 6, r.length, !0), this.u8.set(r, o.abs + 8), this.touchDirectoryMutation(t), this.updateDirIndexAdd(t, r, i, o.abs, o.recLen), !0;
		}
		return !1;
	}
	updateDirIndexRemove(e, t) {
		const r = this.inodeOffset(e), i = this.r64(r + Vs), n = this.r64(r + Zs), s = this.dirIndexes.get(e);
		s && (s.generation === n && s.size === i ? s.entries.delete(this.dirNameKey(t)) : this.dirIndexes.delete(e));
	}
	updateDirIndexRecLen(e, t, r) {
		const i = this.dirIndexes.get(e);
		if (i) {
			for (const n of i.entries.values()) if (n.abs === t) return void (n.recLen = r);
		}
	}
	dirLookup(e, t) {
		const r = this.getDirIndex(e);
		if ("number" == typeof r) return r;
		if (r) {
			const e = r.entries.get(this.dirNameKey(t));
			return e ? this.r32(e.abs) === e.ino && this.inodeIsAllocated(e.ino) && this.view.getUint16(e.abs + 4, !0) === e.recLen && this.view.getUint16(e.abs + 6, !0) === e.nameLen && this.dirEntryNameMatches(e.abs, t) ? e.ino : (r.entries.delete(this.dirNameKey(t)), -2) : -2;
		}
		const i = this.inodeOffset(e), n = this.r64(i + Vs);
		let s = 0;
		for (; s < n;) {
			const r = Math.floor(s / Us), i = s % Us, o = this.inodeBlockMap(e, r, !1);
			if (o <= 0) return -5;
			const a = o * Us;
			let c = n - s;
			c > 4096 - i && (c = Us - i);
			let l = i;
			for (; l < i + c;) {
				const e = a + l, r = this.r32(e), n = this.view.getUint16(e + 4, !0), s = this.view.getUint16(e + 6, !0);
				if (!this.isValidDirEntry(l, i + c, n, s)) return -5;
				if (0 !== r && s === t.length) {
					let i = !0;
					for (let r = 0; r < t.length; r++) if (this.u8[e + 8 + r] !== t[r]) {
						i = !1;
						break;
					}
					if (i) return this.inodeIsAllocated(r) ? r : -5;
				}
				l += n;
			}
			s += c;
		}
		return -2;
	}
	findLastDirEntryInBlock(e, t, r) {
		const i = this.inodeBlockMap(e, t, !1);
		if (i <= 0) return -1;
		const n = i * Us;
		let s = 0, o = -1;
		for (; s < r;) {
			const e = n + s, t = this.view.getUint16(e + 4, !0);
			if (t < 8 || t % 4 != 0 || s + t > r) return -1;
			o = e, s += t;
		}
		return s === r ? o : -1;
	}
	dirAppendEntry(e, t, r, i = -1) {
		const n = this.inodeOffset(e), s = this.r64(n + Vs), o = lo(8 + t.length);
		let a, c = s, l = Math.floor(c / Us), h = c % Us, d = 0;
		if (0 !== h && h + o > 4096) {
			const t = Us - h;
			let r = 0;
			if (t >= 8) {
				if (r = this.inodeBlockMap(e, l, !1), r <= 0) return -5;
			} else if (i < 0 && (i = this.findLastDirEntryInBlock(e, l, h)), i < 0) return -5;
			if (d = this.inodeBlockMap(e, l + 1, !0), d < 0) return d;
			if (t >= 8) {
				const e = r * Us + h;
				this.w32(e, 0), this.view.setUint16(e + 4, t, !0), this.view.setUint16(e + 6, 0, !0);
			} else {
				const r = this.view.getUint16(i + 4, !0) + t;
				this.view.setUint16(i + 4, r, !0), this.updateDirIndexRecLen(e, i, r);
			}
			c = (l + 1) * Us, l++, h = 0;
		}
		if (0 === h) {
			if (a = d || this.inodeBlockMap(e, l, !0), a < 0) return a;
		} else if (a = this.inodeBlockMap(e, l, !1), a <= 0) return -5;
		const f = a * Us + h;
		return this.w32(f, r), this.view.setUint16(f + 4, o, !0), this.view.setUint16(f + 6, t.length, !0), this.u8.set(t, f + 8), this.w64(n + Vs, c + o), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, r, f, o), 0;
	}
	dirAddEntry(e, t, r) {
		const i = this.getDirIndex(e);
		if ("number" == typeof i) return i;
		if (i) return this.useDirIndexFreeSlot(i, e, t, r) ? 0 : this.dirAppendEntry(e, t, r);
		const n = this.inodeOffset(e), s = this.r64(n + Vs), o = lo(8 + t.length);
		let a = -1, c = 0;
		for (; c < s;) {
			const i = Math.floor(c / Us), n = c % Us, l = this.inodeBlockMap(e, i, !1);
			if (l <= 0) return -5;
			const h = l * Us;
			let d = s - c;
			d > 4096 - n && (d = Us - n);
			let f = n;
			for (; f < n + d;) {
				const i = h + f, s = this.r32(i), c = this.view.getUint16(i + 4, !0), l = this.view.getUint16(i + 6, !0);
				if (c < 8 || c % 4 != 0 || f + c > n + d || l > c - 8) return -5;
				if (0 === s && c >= o) return this.w32(i, r), this.view.setUint16(i + 6, t.length, !0), this.u8.set(t, i + 8), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, r, i, c), 0;
				const u = lo(8 + l), p = c - u;
				if (0 !== s && p >= o) {
					this.view.setUint16(i + 4, u, !0);
					const n = i + u;
					return this.w32(n, r), this.view.setUint16(n + 4, p, !0), this.view.setUint16(n + 6, t.length, !0), this.u8.set(t, n + 8), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, r, n, p), 0;
				}
				a = i, f += c;
			}
			c += d;
		}
		return this.dirAppendEntry(e, t, r, a);
	}
	dirRemoveEntry(e, t) {
		const r = this.getDirIndex(e);
		if ("number" == typeof r) return r;
		if (r) {
			const i = this.dirNameKey(t), n = r.entries.get(i);
			if (!n) return -2;
			if (this.r32(n.abs) === n.ino && this.view.getUint16(n.abs + 4, !0) === n.recLen && this.view.getUint16(n.abs + 6, !0) === n.nameLen && this.dirEntryNameMatches(n.abs, t)) return this.w32(n.abs, 0), r.entries.delete(i), r.free.push({
				abs: n.abs,
				recLen: n.recLen
			}), this.touchDirectoryMutation(e), 0;
			r.entries.delete(i);
		}
		const i = this.inodeOffset(e), n = this.r64(i + Vs);
		let s = 0;
		for (; s < n;) {
			const r = Math.floor(s / Us), i = s % Us, o = this.inodeBlockMap(e, r, !1);
			if (o <= 0) return -5;
			const a = o * Us;
			let c = n - s;
			c > 4096 - i && (c = Us - i);
			let l = i;
			for (; l < i + c;) {
				const r = a + l, n = this.r32(r), s = this.view.getUint16(r + 4, !0), o = this.view.getUint16(r + 6, !0);
				if (!this.isValidDirEntry(l, i + c, s, o)) return -5;
				if (0 !== n && o === t.length) {
					let i = !0;
					for (let e = 0; e < t.length; e++) if (this.u8[r + 8 + e] !== t[e]) {
						i = !1;
						break;
					}
					if (i) return this.w32(r, 0), this.touchDirectoryMutation(e), this.updateDirIndexRemove(e, t), 0;
				}
				l += s;
			}
			s += c;
		}
		return -2;
	}
	dirReplaceEntryIno(e, t, r) {
		const i = this.getDirIndex(e);
		if ("number" == typeof i) return i;
		if (i) {
			const n = this.dirNameKey(t), s = i.entries.get(n);
			if (s && this.r32(s.abs) === s.ino && this.view.getUint16(s.abs + 4, !0) === s.recLen && this.view.getUint16(s.abs + 6, !0) === s.nameLen && this.dirEntryNameMatches(s.abs, t)) return this.w32(s.abs, r), s.ino = r, this.touchDirectoryMutation(e), 0;
			s && i.entries.delete(n);
		}
		const n = this.inodeOffset(e), s = this.r64(n + Vs);
		let o = 0;
		for (; o < s;) {
			const i = Math.floor(o / Us), n = o % Us, a = this.inodeBlockMap(e, i, !1);
			if (a <= 0) return -5;
			const c = a * Us;
			let l = s - o;
			l > 4096 - n && (l = Us - n);
			let h = n;
			for (; h < n + l;) {
				const i = c + h, s = this.r32(i), o = this.view.getUint16(i + 4, !0), a = this.view.getUint16(i + 6, !0);
				if (!this.isValidDirEntry(h, n + l, o, a)) return -5;
				if (0 !== s && a === t.length) {
					let n = !0;
					for (let e = 0; e < t.length; e++) if (this.u8[i + 8 + e] !== t[e]) {
						n = !1;
						break;
					}
					if (n) return this.w32(i, r), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, r, i, o), 0;
				}
				h += o;
			}
			o += l;
		}
		return -2;
	}
	dirIsEmpty(e) {
		const t = this.inodeOffset(e), r = this.r64(t + Vs);
		let i = 0;
		for (; i < r;) {
			const t = Math.floor(i / Us), n = i % Us, s = this.inodeBlockMap(e, t, !1);
			if (s <= 0) throw new io(-5);
			const o = s * Us;
			let a = r - i;
			a > 4096 - n && (a = Us - n);
			let c = n;
			for (; c < n + a;) {
				const e = o + c, t = this.r32(e), r = this.view.getUint16(e + 4, !0), i = this.view.getUint16(e + 6, !0);
				if (r < 8 || r % 4 != 0 || c + r > n + a || i > r - 8) throw new io(-5);
				if (0 !== t) {
					if (1 === i && 46 === this.u8[e + 8]) {
						c += r;
						continue;
					}
					if (2 === i && 46 === this.u8[e + 8] && 46 === this.u8[e + 8 + 1]) {
						c += r;
						continue;
					}
					return !1;
				}
				c += r;
			}
			i += a;
		}
		return !0;
	}
	dirIsAncestor(e, t) {
		let r = t;
		for (let i = 0; i < 8192; i++) {
			if (r === e) return !0;
			if (1 === r) return !1;
			const t = this.dirLookup(r, oo);
			if (t < 0 || t === r) throw new io(-5);
			r = t;
		}
		throw new io(-5);
	}
	pathResolve(e, t) {
		if (!e.startsWith("/")) return -2;
		let r = 1;
		const i = e.split("/").filter((e) => e.length > 0);
		let n = 0;
		for (let s = 0; s < i.length; s++) {
			const e = i[s];
			if (e.length > 255) return -36;
			const o = no.encode(e);
			let a;
			this.inodeReadLock(r);
			try {
				const e = this.inodeOffset(r);
				if (16384 != (61440 & this.r32(e + 8))) return -20;
				a = this.dirLookup(r, o);
			} finally {
				this.inodeReadUnlock(r);
			}
			if (a < 0) return a;
			const c = this.inodeOffset(a);
			if (40960 == (61440 & this.r32(c + 8)) && (s !== i.length - 1 || t)) {
				if (++n > 8) return -40;
				const e = this.r64(c + Vs);
				let t;
				if (e <= 40) t = co(this.u8.subarray(c + js, c + js + e));
				else {
					const r = new Uint8Array(e);
					this.inodeReadData(a, 0, r, e), t = so.decode(r);
				}
				if (t.startsWith("/")) {
					r = 1;
					const e = t.split("/").filter((e) => e.length > 0), n = i.slice(s + 1);
					i.length = 0, i.push(...e, ...n), s = -1;
				} else {
					const e = t.split("/").filter((e) => e.length > 0), r = i.slice(s + 1);
					i.length = s, i.push(...e, ...r), s--;
				}
				continue;
			}
			r = a;
		}
		return r;
	}
	pathResolveParent(e) {
		if (!e.startsWith("/")) throw new io(-22, "Path must be absolute");
		const t = e.split("/").filter((e) => e.length > 0);
		if (0 === t.length) throw new io(-22, "Cannot operate on /");
		const r = t.pop();
		if (r.length > 255) throw new io(-36);
		const i = "/" + t.join("/"), n = this.pathResolve(i, !0);
		if (n < 0) throw new io(n);
		const s = this.inodeOffset(n);
		if (16384 != (61440 & this.r32(s + 8))) throw new io(-20);
		return {
			parentIno: n,
			name: r
		};
	}
	fdAlloc(e, t, r) {
		for (let i = 0; i < Hs; i++) {
			const n = 256 + 24 * i, s = n >> 2;
			if (0 === Atomics.compareExchange(this.i32, s, 0, 1)) return this.w32(n + 4, e), this.w64(n + 8, 0), this.w32(n + 16, t), this.w32(n + 20, r ? 1 : 0), this.inodeAddOpenRef(e) ? i : (Atomics.store(this.i32, s, 0), -2);
		}
		return -24;
	}
	fdGet(e) {
		if (e < 0 || e >= Hs) return null;
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
		if (e >= 0 && e < Hs) {
			const t = 256 + 24 * e;
			Atomics.store(this.i32, t >> 2, 0);
		}
	}
	buildStat(e) {
		const t = this.inodeOffset(e);
		return {
			ino: e,
			generation: this.r64(t + Zs),
			dataSequence: this.r32(t + Qs),
			mode: this.r32(t + 8),
			linkCount: this.r32(t + Ks),
			size: this.r64(t + Vs),
			mtime: this.r64(t + qs),
			ctime: this.r64(t + Gs),
			atime: this.r64(t + 40),
			uid: this.r32(t + 96),
			gid: this.r32(t + Ys)
		};
	}
	namespaceEntryIdentity(e) {
		const t = this.inodeOffset(e);
		return {
			ino: e,
			generation: this.r64(t + Zs),
			linkCount: this.r32(t + Ks),
			mode: this.r32(t + 8)
		};
	}
	open(e, t, r = 420) {
		return this.withNamespaceLock(() => this.openUnlocked(e, t, r));
	}
	createLazyStub(e, t) {
		return this.withNamespaceLock(() => {
			const r = this.openUnlocked(e, 65, t);
			try {
				const e = this.fdGet(r);
				if (!e) throw new io(-9);
				this.inodeWriteLock(e.ino);
				try {
					return this.inodeTruncate(e.ino, 0, !0), this.buildStat(e.ino);
				} finally {
					this.inodeWriteUnlock(e.ino);
				}
			} finally {
				this.closeUnlocked(r);
			}
		});
	}
	replaceIfIdentity(e, t, r, i, n) {
		return this.withNamespaceLock(() => {
			const s = this.pathResolve(e, !0);
			if (s < 0 || s !== t) return !1;
			const o = this.inodeOffset(s);
			if (this.r64(o + Zs) !== r || this.r32(o + Qs) !== i) return !1;
			if (32768 != (61440 & this.r32(o + 8))) return !1;
			this.validateFileSize(n.byteLength), this.inodeWriteLock(s);
			try {
				if (this.r64(o + Zs) !== r || this.r32(o + Qs) !== i) return !1;
				if (0 !== this.r64(o + Vs)) return !1;
				const e = this.r64(o + qs), t = this.r64(o + Gs);
				this.inodeTruncate(s, 0, !0);
				const a = n.byteLength > 0 ? this.inodeWriteData(s, 0, n, n.byteLength) : 0;
				if (a !== n.byteLength) throw this.inodeTruncate(s, 0, !0), Atomics.store(this.i32, o + Qs >> 2, i), this.w64(o + qs, e), this.w64(o + Gs, t), new io(a < 0 ? a : -28);
				return !0;
			} finally {
				this.inodeWriteUnlock(s);
			}
		});
	}
	replaceManyIfIdentities(e, t = []) {
		return 0 === e.length && 0 === t.length || this.withNamespaceLock(() => {
			const r = [], i = /* @__PURE__ */ new Set(), n = (e) => {
				const t = this.pathResolve(e.path, !1);
				if (t < 0 || t !== e.expectedIno) return !1;
				const r = this.inodeOffset(t);
				return this.r64(r + Zs) === e.expectedGeneration && this.r32(r + Qs) === e.expectedDataSequence && this.r32(r + 8) === e.expectedMode && this.r32(r + Ks) === e.expectedLinkCount && this.r64(r + Vs) === e.expectedSize && this.r32(r + 96) === e.expectedUid && this.r32(r + Ys) === e.expectedGid;
			};
			for (const e of t) if (!n(e)) return !1;
			for (const t of e) {
				this.validateFileSize(t.data.byteLength);
				let e = -1;
				for (const r of t.paths) {
					const i = this.pathResolve(r, !0);
					if (i !== t.expectedIno) continue;
					const n = this.inodeOffset(i);
					if (this.r64(n + Zs) === t.expectedGeneration && this.r32(n + Qs) === t.expectedDataSequence && 32768 == (61440 & this.r32(n + 8)) && 0 === this.r64(n + Vs)) {
						e = i;
						break;
					}
				}
				if (e < 0) return !1;
				if (i.has(e)) throw new io(-22, "duplicate conditional replacement inode");
				i.add(e), r.push({
					...t,
					ino: e
				});
			}
			const s = [...i].sort((e, t) => e - t);
			for (const e of s) this.inodeWriteLock(e);
			try {
				for (const t of r) {
					const e = this.inodeOffset(t.ino);
					if (this.r64(e + Zs) !== t.expectedGeneration || this.r32(e + Qs) !== t.expectedDataSequence || 32768 != (61440 & this.r32(e + 8)) || 0 !== this.r64(e + Vs)) return !1;
				}
				for (const r of t) if (!n(r)) return !1;
				const e = r.map((e) => {
					const t = this.inodeOffset(e.ino);
					return {
						ino: e.ino,
						dataSequence: this.r32(t + Qs),
						mtime: this.r64(t + qs),
						ctime: this.r64(t + Gs)
					};
				});
				let i = 0;
				try {
					for (const e of r) {
						i++, this.inodeTruncate(e.ino, 0, !0);
						const t = e.data.byteLength > 0 ? this.inodeWriteData(e.ino, 0, e.data, e.data.byteLength) : 0;
						if (t !== e.data.byteLength) throw new io(t < 0 ? t : -28);
					}
				} catch (o) {
					for (let t = i - 1; t >= 0; t--) {
						const r = e[t], i = this.inodeOffset(r.ino);
						this.inodeTruncate(r.ino, 0, !0), Atomics.store(this.i32, i + Qs >> 2, r.dataSequence), this.w64(i + qs, r.mtime), this.w64(i + Gs, r.ctime);
					}
					throw o;
				}
				return !0;
			} finally {
				for (let e = s.length - 1; e >= 0; e--) this.inodeWriteUnlock(s[e]);
			}
		});
	}
	openUnlocked(e, t, r = 420) {
		const i = 3 & t, n = !!(64 & t), s = !!(128 & t);
		if (n && s) {
			const t = this.pathResolve(e, !1);
			if (t >= 0) throw new io(-17);
			if (-2 !== t) throw new io(t);
		}
		let o = this.pathResolve(e, !0);
		if (o < 0 && -2 === o && n) {
			const { parentIno: t, name: i } = this.pathResolveParent(e);
			this.inodeWriteLock(t);
			try {
				const e = no.encode(i), n = this.dirLookup(t, e);
				if (n >= 0) {
					if (s) throw new io(-17);
					o = n;
				} else {
					const i = this.inodeAlloc();
					if (i < 0) throw new io(-28);
					const n = this.inodeOffset(i);
					this.w32(n + 8, 32768 | 4095 & r), this.w32(n + Ks, 1), this.w64(n + Vs, 0);
					const s = Date.now();
					this.w64(n + 40, s), this.w64(n + qs, s), this.w64(n + Gs, s);
					const a = this.dirAddEntry(t, e, i);
					if (a < 0) throw this.inodeFree(i), new io(a);
					o = i;
				}
			} finally {
				this.inodeWriteUnlock(t);
			}
		}
		if (o < 0) throw new io(o);
		const a = this.inodeOffset(o), c = this.r32(a + 8);
		if (16384 == (61440 & c) && 0 !== i) throw new io(-21);
		if (65536 & t && 16384 != (61440 & c)) throw new io(-20);
		if (512 & t) {
			if (16384 == (61440 & c)) throw new io(-21);
			this.inodeWriteLock(o), this.inodeTruncate(o, 0, !0), this.inodeWriteUnlock(o);
		}
		const l = this.fdAlloc(o, t, !1);
		if (l < 0) throw new io(l);
		return l;
	}
	close(e) {
		this.withNamespaceLock(() => this.closeUnlocked(e));
	}
	closeUnlocked(e) {
		const t = this.fdGet(e);
		if (!t) throw new io(-9);
		this.fdFree(e), this.inodeDropOpenRef(t.ino);
	}
	read(e, t) {
		const r = this.fdGet(e);
		if (!r) throw new io(-9);
		const i = this.inodeOffset(r.ino);
		if (16384 == (61440 & this.r32(i + 8))) throw new io(-21);
		this.inodeReadLock(r.ino);
		try {
			const i = this.inodeReadData(r.ino, r.offset, t, t.length), n = 256 + 24 * e;
			return this.w64(n + 8, r.offset + i), i;
		} finally {
			this.inodeReadUnlock(r.ino);
		}
	}
	readAt(e, t, r) {
		const i = this.fdGet(e);
		if (!i) throw new io(-9);
		const n = this.inodeOffset(i.ino);
		if (16384 == (61440 & this.r32(n + 8))) throw new io(-21);
		this.validateSeekPosition(r), this.inodeReadLock(i.ino);
		try {
			return this.inodeReadData(i.ino, r, t, t.length);
		} finally {
			this.inodeReadUnlock(i.ino);
		}
	}
	write(e, t) {
		const r = this.fdGet(e);
		if (!r) throw new io(-9);
		if (!(3 & r.flags)) throw new io(-9);
		this.inodeWriteLock(r.ino);
		try {
			let i = r.offset;
			if (1024 & r.flags) {
				const e = this.inodeOffset(r.ino);
				i = this.r64(e + Vs);
			}
			if (!Number.isSafeInteger(i) || i < 0) throw new io(-22);
			if (i > to || t.length > to - i) throw new io(-27);
			const n = this.inodeWriteData(r.ino, i, t, t.length);
			if (n < 0) return n;
			const s = 256 + 24 * e;
			return this.w64(s + 8, i + n), n;
		} finally {
			this.inodeWriteUnlock(r.ino);
		}
	}
	writeAt(e, t, r) {
		const i = this.fdGet(e);
		if (!i) throw new io(-9);
		if (!(3 & i.flags)) throw new io(-9);
		this.validateSeekPosition(r), this.inodeWriteLock(i.ino);
		try {
			if (r > to || t.length > to - r) throw new io(-27);
			return this.inodeWriteData(i.ino, r, t, t.length);
		} finally {
			this.inodeWriteUnlock(i.ino);
		}
	}
	lseek(e, t, r) {
		const i = this.fdGet(e);
		if (!i) throw new io(-9);
		let n;
		if (0 === r) n = t;
		else if (1 === r) n = i.offset + t;
		else {
			if (2 !== r) throw new io(-22);
			{
				const e = this.inodeOffset(i.ino);
				n = this.r64(e + Vs) + t;
			}
		}
		this.validateSeekPosition(n);
		const s = 256 + 24 * e;
		return this.w64(s + 8, n), n;
	}
	ftruncate(e, t) {
		const r = this.fdGet(e);
		if (!r) throw new io(-9);
		if (!(3 & r.flags)) throw new io(-9);
		this.validateFileSize(t), this.inodeWriteLock(r.ino);
		try {
			this.inodeTruncate(r.ino, t, !0);
		} finally {
			this.inodeWriteUnlock(r.ino);
		}
	}
	fstat(e) {
		const t = this.fdGet(e);
		if (!t) throw new io(-9);
		this.inodeReadLock(t.ino);
		try {
			return this.buildStat(t.ino);
		} finally {
			this.inodeReadUnlock(t.ino);
		}
	}
	stat(e) {
		return this.withNamespaceLock(() => this.statUnlocked(e));
	}
	statUnlocked(e) {
		const t = this.pathResolve(e, !0);
		if (t < 0) throw new io(t);
		this.inodeReadLock(t);
		try {
			return this.buildStat(t);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	lstat(e) {
		return this.withNamespaceLock(() => this.lstatUnlocked(e));
	}
	lstatUnlocked(e) {
		const t = this.pathResolve(e, !1);
		if (t < 0) throw new io(t);
		this.inodeReadLock(t);
		try {
			return this.buildStat(t);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	unlink(e) {
		return this.withNamespaceLock(() => this.unlinkUnlocked(e));
	}
	unlinkUnlocked(e) {
		const { parentIno: t, name: r } = this.pathResolveParent(e), i = no.encode(r), n = e.length > 1 && e.endsWith("/");
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, i);
			if (e < 0) throw new io(e);
			const r = this.inodeOffset(e), s = this.r32(r + 8);
			if (n && 16384 != (61440 & s)) throw new io(-20);
			if (16384 == (61440 & s)) throw new io(-21);
			const o = this.namespaceEntryIdentity(e), a = this.dirRemoveEntry(t, i);
			if (a < 0) throw new io(a);
			let c = !1;
			this.inodeWriteLock(e);
			try {
				c = this.inodeDropLinkRefLocked(e);
			} finally {
				this.inodeWriteUnlock(e);
			}
			return c && this.inodeFree(e), o;
		} finally {
			this.inodeWriteUnlock(t);
		}
	}
	rename(e, t) {
		return this.withNamespaceLock(() => this.renameUnlocked(e, t));
	}
	renameUnlocked(e, t) {
		const { parentIno: r, name: i } = this.pathResolveParent(e), { parentIno: n, name: s } = this.pathResolveParent(t);
		if (ao(i) || ao(s)) throw new io(-22);
		const o = no.encode(i), a = no.encode(s), c = e.length > 1 && e.endsWith("/"), l = t.length > 1 && t.endsWith("/"), h = Math.min(r, n), d = Math.max(r, n);
		this.inodeWriteLock(h), h !== d && this.inodeWriteLock(d);
		try {
			const e = this.dirLookup(r, o);
			if (e < 0) throw new io(e);
			const t = this.inodeOffset(e), i = this.r32(t + 8) & $s, s = this.namespaceEntryIdentity(e);
			if ((c || l) && 16384 !== i) throw new io(-20);
			if (16384 === i && this.dirIsAncestor(e, n)) throw new io(-22);
			const h = this.dirLookup(n, a);
			let d, f = !1;
			if (h >= 0) {
				if (h === e) return {
					source: s,
					replaced: s
				};
				d = this.namespaceEntryIdentity(h);
				const t = this.inodeOffset(h), o = this.r32(t + 8) & $s;
				if (16384 === i && 16384 !== o) throw new io(-20);
				if (16384 !== i && 16384 === o) throw new io(-21);
				let c = !1;
				const l = h === r || h === n;
				l || this.inodeWriteLock(h);
				try {
					if (16384 === o && !this.dirIsEmpty(h)) throw new io(-39);
					const t = this.dirReplaceEntryIno(n, a, e);
					if (t < 0) throw new io(t);
					c = 16384 === o ? this.inodeOrphanLocked(h) : this.inodeDropLinkRefLocked(h);
				} finally {
					l || this.inodeWriteUnlock(h);
				}
				c && this.inodeFree(h), f = 16384 === o;
			} else {
				const t = this.dirAddEntry(n, a, e);
				if (t < 0) throw new io(t);
			}
			const u = this.dirRemoveEntry(r, o);
			if (u < 0) throw new io(u);
			if (16384 === i) {
				if (r !== n) {
					const i = this.inodeOffset(r);
					this.w32(i + Ks, this.r32(i + Ks) - 1);
					const s = this.inodeOffset(n);
					this.w32(s + Ks, this.r32(s + Ks) + 1), this.inodeWriteLock(e);
					try {
						const r = this.dirReplaceEntryIno(e, oo, n);
						if (r < 0) throw new io(r);
						this.w64(t + Gs, Date.now());
					} finally {
						this.inodeWriteUnlock(e);
					}
				}
				if (f) {
					const e = this.inodeOffset(n);
					this.w32(e + Ks, this.r32(e + Ks) - 1);
				}
			} else if (f) {
				const e = this.inodeOffset(n);
				this.w32(e + Ks, this.r32(e + Ks) - 1);
			}
			return {
				source: s,
				replaced: d
			};
		} finally {
			h !== d && this.inodeWriteUnlock(d), this.inodeWriteUnlock(h);
		}
	}
	mkdir(e, t = 493) {
		this.withNamespaceLock(() => this.mkdirUnlocked(e, t));
	}
	mkdirUnlocked(e, t = 493) {
		const { parentIno: r, name: i } = this.pathResolveParent(e), n = no.encode(i);
		this.inodeWriteLock(r);
		try {
			if (this.dirLookup(r, n) >= 0) throw new io(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new io(-28);
			const i = this.inodeOffset(e);
			this.w32(i + 8, 16384 | t), this.w32(i + Ks, 2), this.w64(i + Vs, 0);
			const s = Date.now();
			this.w64(i + 40, s), this.w64(i + qs, s), this.w64(i + Gs, s);
			const o = this.blockAllocWithGrow();
			if (o < 0) throw this.inodeFree(e), new io(-28);
			this.w32(i + js, o);
			const a = o * Us, c = lo(9), l = lo(10);
			this.w32(a, e), this.view.setUint16(a + 4, c, !0), this.view.setUint16(a + 6, 1, !0), this.u8[a + 8] = 46;
			const h = a + c;
			this.w32(h, r), this.view.setUint16(h + 4, l, !0), this.view.setUint16(h + 6, 2, !0), this.u8[h + 8] = 46, this.u8[h + 8 + 1] = 46, this.w64(i + Vs, c + l);
			const d = this.dirAddEntry(r, n, e);
			if (d < 0) throw this.blockFree(o), this.inodeFree(e), new io(d);
			const f = this.inodeOffset(r);
			this.w32(f + Ks, this.r32(f + Ks) + 1);
		} finally {
			this.inodeWriteUnlock(r);
		}
	}
	rmdir(e) {
		this.withNamespaceLock(() => this.rmdirUnlocked(e));
	}
	rmdirUnlocked(e) {
		const { parentIno: t, name: r } = this.pathResolveParent(e);
		if (ao(r)) throw new io(-22);
		const i = no.encode(r);
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, i);
			if (e < 0) throw new io(e);
			const r = this.inodeOffset(e);
			if (16384 != (61440 & this.r32(r + 8))) throw new io(-20);
			let n = !1;
			this.inodeWriteLock(e);
			try {
				if (!this.dirIsEmpty(e)) throw new io(-39);
				const r = this.dirRemoveEntry(t, i);
				if (r < 0) throw new io(r);
				n = this.inodeOrphanLocked(e);
			} finally {
				this.inodeWriteUnlock(e);
			}
			n && this.inodeFree(e);
			const s = this.inodeOffset(t);
			this.w32(s + Ks, this.r32(s + Ks) - 1);
		} finally {
			this.inodeWriteUnlock(t);
		}
	}
	symlink(e, t) {
		this.withNamespaceLock(() => this.symlinkUnlocked(e, t));
	}
	symlinkUnlocked(e, t) {
		const { parentIno: r, name: i } = this.pathResolveParent(t), n = no.encode(i), s = no.encode(e);
		this.inodeWriteLock(r);
		try {
			if (this.dirLookup(r, n) >= 0) throw new io(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new io(-28);
			const t = this.inodeOffset(e);
			if (this.w32(t + 8, 41471), this.w32(t + Ks, 1), s.length <= 40) this.u8.set(s, t + js), this.w64(t + Vs, s.length);
			else {
				this.w64(t + Vs, 0);
				const r = this.inodeWriteData(e, 0, s, s.length);
				if (r !== s.length) throw r > 0 && this.inodeTruncate(e, 0), this.inodeFree(e), new io(r < 0 ? r : -28);
			}
			const i = this.dirAddEntry(r, n, e);
			if (i < 0) throw s.length <= 40 ? (this.u8.fill(0, t + js, t + js + 40), this.w64(t + Vs, 0)) : this.inodeTruncate(e, 0), this.inodeFree(e), new io(i);
		} finally {
			this.inodeWriteUnlock(r);
		}
	}
	chmod(e, t) {
		this.withNamespaceLock(() => this.chmodUnlocked(e, t));
	}
	chmodUnlocked(e, t) {
		const r = this.pathResolve(e, !0);
		if (r < 0) throw new io(r);
		this.inodeWriteLock(r);
		try {
			const e = this.inodeOffset(r), i = this.r32(e + 8);
			this.w32(e + 8, i & $s | 4095 & t), this.w64(e + Gs, Date.now());
		} finally {
			this.inodeWriteUnlock(r);
		}
	}
	fchmod(e, t) {
		const r = this.fdGet(e);
		if (!r) throw new io(-9);
		this.inodeWriteLock(r.ino);
		try {
			const e = this.inodeOffset(r.ino), i = this.r32(e + 8);
			this.w32(e + 8, i & $s | 4095 & t), this.w64(e + Gs, Date.now());
		} finally {
			this.inodeWriteUnlock(r.ino);
		}
	}
	chown(e, t, r) {
		this.withNamespaceLock(() => this.chownUnlocked(e, t, r));
	}
	chownUnlocked(e, t, r) {
		const i = this.pathResolve(e, !0);
		if (i < 0) throw new io(i);
		this.inodeWriteLock(i);
		try {
			this.chownInodeUnlocked(i, t, r);
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	fchown(e, t, r) {
		const i = this.fdGet(e);
		if (!i) throw new io(-9);
		this.inodeWriteLock(i.ino);
		try {
			this.chownInodeUnlocked(i.ino, t, r);
		} finally {
			this.inodeWriteUnlock(i.ino);
		}
	}
	lchown(e, t, r) {
		this.withNamespaceLock(() => this.lchownUnlocked(e, t, r));
	}
	lchownUnlocked(e, t, r) {
		const i = this.pathResolve(e, !1);
		if (i < 0) throw new io(i);
		this.inodeWriteLock(i);
		try {
			this.chownInodeUnlocked(i, t, r);
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	chownInodeUnlocked(e, t, r) {
		const i = this.inodeOffset(e);
		t !== Ws && this.w32(i + 96, t), r !== Ws && this.w32(i + Ys, r);
		const n = this.r32(i + 8);
		32768 == (61440 & n) && 73 & n && this.w32(i + 8, -3073 & n), this.w64(i + Gs, Date.now());
	}
	utimens(e, t, r, i, n) {
		this.withNamespaceLock(() => this.utimensUnlocked(e, t, r, i, n));
	}
	utimensUnlocked(e, t, r, i, n) {
		const s = this.pathResolve(e, !0);
		if (s < 0) throw new io(s);
		this.inodeWriteLock(s);
		try {
			const e = this.inodeOffset(s), o = 1073741823, a = 1073741822, c = Date.now();
			if (r !== a) {
				const i = r === o ? c : 1e3 * t + Math.floor(r / 1e6);
				this.w64(e + 40, i);
			}
			if (n !== a) {
				const t = n === o ? c : 1e3 * i + Math.floor(n / 1e6);
				this.w64(e + qs, t);
			}
			this.w64(e + Gs, c);
		} finally {
			this.inodeWriteUnlock(s);
		}
	}
	link(e, t) {
		return this.withNamespaceLock(() => this.linkUnlocked(e, t));
	}
	linkUnlocked(e, t) {
		const r = this.pathResolve(e, !1);
		if (r < 0) throw new io(r);
		const i = this.inodeOffset(r);
		if (16384 == (61440 & this.r32(i + 8))) throw new io(-1);
		const { parentIno: n, name: s } = this.pathResolveParent(t), o = no.encode(s);
		this.inodeWriteLock(n);
		try {
			if (this.dirLookup(n, o) >= 0) throw new io(-17);
			const e = this.dirAddEntry(n, o, r);
			if (e < 0) throw new io(e);
			this.inodeWriteLock(r);
			try {
				const e = this.r32(i + Ks);
				this.w32(i + Ks, e + 1), this.w64(i + Gs, Date.now());
			} finally {
				this.inodeWriteUnlock(r);
			}
			return {
				...this.namespaceEntryIdentity(r),
				linkCount: this.r32(i + Ks)
			};
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	readlink(e) {
		return this.withNamespaceLock(() => this.readlinkUnlocked(e));
	}
	readlinkUnlocked(e) {
		const t = this.pathResolve(e, !1);
		if (t < 0) throw new io(t);
		return this.readSymlinkInodeUnlocked(t);
	}
	readSymlinkInodeUnlocked(e) {
		const t = this.inodeOffset(e);
		if (40960 != (61440 & this.r32(t + 8))) throw new io(-22);
		const r = this.r64(t + Vs);
		if (r <= 40) return co(this.u8.subarray(t + js, t + js + r));
		this.inodeReadLock(e);
		try {
			const t = new Uint8Array(r);
			return this.inodeReadData(e, 0, t, r), so.decode(t);
		} finally {
			this.inodeReadUnlock(e);
		}
	}
	opendir(e) {
		return this.withNamespaceLock(() => this.opendirUnlocked(e));
	}
	opendirUnlocked(e) {
		const t = this.pathResolve(e, !0);
		if (t < 0) throw new io(t);
		const r = this.inodeOffset(t);
		if (16384 != (61440 & this.r32(r + 8))) throw new io(-20);
		const i = this.fdAlloc(t, 0, !0);
		if (i < 0) throw new io(i);
		return i;
	}
	readdirEntry(e) {
		return this.withNamespaceLock(() => this.readdirEntryUnlocked(e));
	}
	readdirEntryUnlocked(e) {
		const t = this.fdGet(e);
		if (!t || !t.isDir) throw new io(-9);
		const r = this.inodeOffset(t.ino), i = this.r64(r + Vs);
		for (; t.offset < i;) {
			const r = t.offset, n = Math.floor(r / Us), s = r % Us, o = this.inodeBlockMap(t.ino, n, !1);
			if (o <= 0) throw new io(-5);
			const a = o * Us + s, c = this.r32(a), l = this.view.getUint16(a + 4, !0), h = this.view.getUint16(a + 6, !0);
			if (!this.isValidDirEntry(s, Math.min(4096, s + i - r), l, h)) throw new io(-5);
			const d = r + l, f = 256 + 24 * e;
			if (0 === c) {
				this.w64(f + 8, d), t.offset = d;
				continue;
			}
			if (c >= this.r32(Os)) throw new io(-5);
			const u = this.r32(Ns) * Us;
			if (!(this.r32(u + 4 * (c >> 5)) & 1 << (31 & c))) throw new io(-5);
			const p = co(this.u8.subarray(a + 8, a + 8 + h)), m = this.buildStat(c);
			return this.w64(f + 8, d), t.offset = d, {
				name: p,
				stat: m
			};
		}
		return null;
	}
	closedir(e) {
		this.close(e);
	}
	readdir(e) {
		const t = this.opendir(e), r = [];
		try {
			let e;
			for (; null !== (e = this.readdirEntry(t));) "." !== e.name && ".." !== e.name && r.push(e.name);
		} finally {
			this.closedir(t);
		}
		return r;
	}
	writeFile(e, t) {
		const r = "string" == typeof t ? no.encode(t) : t, i = this.open(e, 577);
		try {
			this.write(i, r);
		} finally {
			this.close(i);
		}
	}
	readFile(e) {
		const t = this.open(e, 0);
		try {
			const e = this.fstat(t), r = new Uint8Array(e.size);
			return this.read(t, r), r;
		} finally {
			this.close(t);
		}
	}
	readFileText(e) {
		return so.decode(this.readFile(e));
	}
};
const fo = 268435456, uo = 268435456, po = 268435456, mo = 1e5, go = 4096, yo = 65536, wo = 8192, bo = 8, So = 32, _o = 64, ko = 255, vo = 536870912, Ao = 536870912, Io = 536870912, Po = 1e5, Eo = 512;
const Co = Object.freeze({
	prefix: "/opt/kandelo/homebrew",
	cellar: "/opt/kandelo/homebrew/Cellar",
	repository: "/opt/kandelo/homebrew",
	stableEntrypoint: "/usr/bin/brew"
}), xo = 1e5, zo = Co.prefix, Mo = [
	["@@HOMEBREW_PREFIX@@", zo],
	["@@HOMEBREW_CELLAR@@", `${zo}/Cellar`],
	["@@HOMEBREW_REPOSITORY@@", zo],
	["@@HOMEBREW_LIBRARY@@", `${zo}/Library`],
	["@@HOMEBREW_PERL@@", `${zo}/opt/perl/bin/perl`]
], To = "@@HOMEBREW_JAVA@@", Lo = /^openjdk(?:@\d+(?:\.\d+)*)?/, Bo = new TextEncoder(), Ro = [...Mo.map(([e]) => e), To].map((e) => ({
	placeholder: e,
	bytes: Bo.encode(e)
}));
function Uo(e) {
	const t = function(e) {
		let t;
		try {
			t = JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(e));
		} catch (r) {
			throw new Error("INSTALL_RECEIPT.json is not valid UTF-8 JSON: " + function(e) {
				return e instanceof Error ? e.message : String(e);
			}(r));
		}
		if ("object" != typeof t || null === t || Array.isArray(t)) throw new Error("INSTALL_RECEIPT.json must contain an object");
		return t;
	}(e), r = t.changed_files;
	if (null != r && !Array.isArray(r)) throw new Error("INSTALL_RECEIPT.json changed_files must be an array or null when present");
	const i = Array.isArray(r) ? r : [];
	if (i.length > xo) throw new Error(`INSTALL_RECEIPT.json declares ${i.length} changed files, limit 100000`);
	const n = [], s = /* @__PURE__ */ new Set();
	for (const [o, a] of i.entries()) {
		if ("string" != typeof a) throw new Error(`INSTALL_RECEIPT.json changed_files[${o}] is not a string`);
		if (Ho(a, "Homebrew changed file"), s.has(a)) throw new Error(`INSTALL_RECEIPT.json repeats changed file ${a}`);
		s.add(a), n.push(a);
	}
	return {
		changedFiles: n,
		runtimeDependencies: t.runtime_dependencies
	};
}
function Fo(e, t, r) {
	let i = e;
	for (const [o, a] of Mo) i = Wo(i, Bo.encode(o), Bo.encode(a));
	const n = Bo.encode(To);
	if ($o(i, n)) {
		const e = function(e) {
			if (!Array.isArray(e)) return;
			const t = [];
			for (const i of e) {
				if ("object" != typeof i || null === i || Array.isArray(i)) continue;
				const e = i, r = "string" == typeof e.full_name ? e.full_name.split("/").at(-1) : "string" == typeof e.name ? e.name.split("/").at(-1) : void 0, n = void 0 === r ? null : Lo.exec(r);
				void 0 !== r && n?.[0] === r && t.push(r);
			}
			const r = [...new Set(t)];
			return 1 === r.length ? `${zo}/opt/${r[0]}/libexec` : void 0;
		}(t.runtimeDependencies);
		if (void 0 === e) throw new Error(`Homebrew changed file ${r} uses ${To} without exactly one OpenJDK runtime dependency`);
		i = Wo(i, n, Bo.encode(e));
	}
	const s = Ro.find(({ bytes: e }) => $o(i, e));
	if (void 0 !== s) throw new Error(`Homebrew changed file ${r} retains ${s.placeholder}`);
	return i;
}
function Ho(e, t) {
	if (0 === e.length || e.startsWith("/") || e.includes("\\") || e.includes("\0") || function(e) {
		for (let t = 0; t < e.length; t += 1) {
			const r = e.charCodeAt(t);
			if (!(r < 55296 || r > 57343)) {
				if (!(r <= 56319 && t + 1 < e.length && e.charCodeAt(t + 1) >= 56320 && e.charCodeAt(t + 1) <= 57343)) return !0;
				t += 1;
			}
		}
		return !1;
	}(e) || Bo.encode(e).byteLength > 4096 || e.split("/").some((e) => "" === e || "." === e || ".." === e)) throw new Error(`${t} has an unsafe path segment: ${e}`);
}
function $o(e, t) {
	if (0 === t.byteLength || t.byteLength > e.byteLength) return !1;
	e: for (let r = 0; r <= e.byteLength - t.byteLength; r += 1) {
		for (let i = 0; i < t.byteLength; i += 1) if (e[r + i] !== t[i]) continue e;
		return !0;
	}
	return !1;
}
function Wo(e, t, r) {
	const i = [];
	for (let a = 0; a <= e.byteLength - t.byteLength;) {
		let r = !0;
		for (let i = 0; i < t.byteLength; i += 1) if (e[a + i] !== t[i]) {
			r = !1;
			break;
		}
		r ? (i.push(a), a += t.byteLength) : a += 1;
	}
	if (0 === i.length) return e;
	const n = new Uint8Array(e.byteLength + i.length * (r.byteLength - t.byteLength));
	let s = 0, o = 0;
	for (const a of i) {
		const i = e.subarray(s, a);
		n.set(i, o), o += i.byteLength, n.set(r, o), o += r.byteLength, s = a + t.byteLength;
	}
	return n.set(e.subarray(s), o), n;
}
const Do = Symbol("DeferredTreeMaterializationHandle"), Oo = [
	40,
	181,
	47,
	253
], No = 4247762216, Ko = 407710288, Vo = 407710303, qo = 131072, Go = 1447449417, jo = 16, Xo = 61440, Yo = 32768, Zo = 16384, Jo = 40960, Qo = 65536, ea = 16777216, ta = 16777216, ra = 1107361820, ia = fo, na = uo, sa = po, oa = mo, aa = Eo, ca = go, la = yo, ha = wo, da = So, fa = _o, ua = ko, pa = 4294967294, ma = /^[0-9a-f]{64}$/, ga = "kandelo-legacy-zip-v1", ya = "kandelo-deferred-tree-v1", wa = "kandelo-deferred-tree-v2", ba = "kandelo-deferred-tree-v3", Sa = new Set([
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETDOWN",
	"ENETRESET",
	"ENETUNREACH",
	"EPIPE",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET"
]);
var _a = class extends Error {
	status;
	retryAfterMs;
	constructor(e, t) {
		super(`HTTP ${e}`), this.status = e, this.retryAfterMs = t, this.name = "LazyHttpResponseError";
	}
};
function ka(e) {
	if ("string" != typeof e || !e.startsWith("/") || new TextEncoder().encode(e).byteLength > ca || e.includes("\0") || e.includes("\\")) throw new Error(`Lazy archive mount prefix must be an absolute POSIX path: ${JSON.stringify(e)}`);
	const t = e.replace(/\/+$/, "");
	if ("" === t) return "/";
	if (t.slice(1).split("/").some((e) => "" === e || "." === e || ".." === e)) throw new Error(`Lazy archive mount prefix is not canonical: ${JSON.stringify(e)}`);
	return t;
}
function va(e) {
	if (!e || "object" != typeof e) throw new Error("VFS image metadata must be an object");
	if (1 !== e.version) throw new Error(`Unsupported VFS image metadata version: ${String(e.version)}`);
	if (void 0 !== e.kernelAbi && (!Number.isInteger(e.kernelAbi) || e.kernelAbi < 0)) throw new Error("VFS image metadata kernelAbi must be a non-negative integer");
	if (void 0 !== e.createdBy && "string" != typeof e.createdBy) throw new Error("VFS image metadata createdBy must be a string");
	return { ...e };
}
function Aa(e, t = 1107361820) {
	if (!Number.isSafeInteger(t) || t < jo || t > ra) throw new Error("VFS image decompressed byte bound is invalid");
	if (e.byteLength >= Oo.length && e[0] === Oo[0] && e[1] === Oo[1] && e[2] === Oo[2] && e[3] === Oo[3]) {
		(function(e, t) {
			const r = new DataView(e.buffer, e.byteOffset, e.byteLength);
			let i = 0, n = 0, s = 0;
			const o = (t, r) => {
				if (t < 0 || i + t > e.byteLength) throw new Error(`zstd VFS image has a truncated ${r}`);
			}, a = (e) => {
				if (n += e, !Number.isSafeInteger(n) || n > t) throw new Error("zstd VFS image exceeds its decompressed byte bound");
			}, c = (t) => {
				o(t, "frame header");
				let r = 0n;
				for (let n = 0; n < t; n++) r |= BigInt(e[i + n]) << BigInt(8 * n);
				return i += t, r;
			};
			for (; i < e.byteLength;) {
				o(4, "frame magic");
				const n = r.getUint32(i, !0);
				if (i += 4, n >= Ko && n <= Vo) {
					o(4, "skippable frame size");
					const e = r.getUint32(i, !0);
					i += 4, o(e, "skippable frame"), i += e;
					continue;
				}
				if (n !== No) throw new Error("zstd VFS image contains an invalid frame magic");
				s++, o(1, "frame descriptor");
				const l = e[i++];
				if (8 & l) throw new Error("zstd VFS image uses a reserved frame descriptor bit");
				const h = !!(32 & l), d = !!(4 & l), f = [
					0,
					1,
					2,
					4
				][3 & l], u = l >>> 6;
				let p;
				if (!h) {
					o(1, "window descriptor");
					const t = e[i++], r = 1n << BigInt(10 + (t >>> 3));
					p = r + (r >> 3n) * BigInt(7 & t);
				}
				o(f, "dictionary identity"), i += f;
				const m = 0 === u ? h ? 1 : 0 : 1 === u ? 2 : 2 === u ? 4 : 8;
				let g;
				if (m > 0 && (g = c(m), 1 === u && (g += 256n), h && (p = g)), void 0 !== p && p > BigInt(t)) throw new Error("zstd VFS image exceeds its decompressed window bound");
				if (void 0 !== g && g > BigInt(t)) throw new Error("zstd VFS image exceeds its decompressed byte bound");
				let y = 0;
				for (;;) {
					o(3, "block header");
					const r = e[i] | e[i + 1] << 8 | e[i + 2] << 16;
					i += 3;
					const n = !!(1 & r), s = r >>> 1 & 3, a = r >>> 3;
					if (3 === s || a > qo) throw new Error("zstd VFS image contains an invalid block header");
					if (y += 2 === s ? qo : a, !Number.isSafeInteger(y) || void 0 === g && y > t) throw new Error("zstd VFS image exceeds its decompressed byte bound");
					const c = 1 === s ? 1 : a;
					if (o(c, "block payload"), i += c, n) break;
				}
				if (d && (o(4, "content checksum"), i += 4), void 0 !== g && g > BigInt(y)) throw new Error("zstd VFS image frame content exceeds its block bound");
				a(void 0 === g ? y : Number(g));
			}
			if (0 === s) throw new Error("zstd VFS image contains no data frame");
		})(e, t);
		const r = function(e) {
			return Ls(e);
		}(e);
		if (r.byteLength > t) throw new Error("zstd VFS image exceeds its decompressed byte bound");
		return r;
	}
	if (e.byteLength > t) throw new Error("VFS image exceeds its decompressed byte bound");
	return e;
}
function Ia(e, t) {
	const r = Aa(e, t);
	if (r.byteLength < jo) throw new Error("VFS image too small");
	const i = new DataView(r.buffer, r.byteOffset, r.byteLength), n = i.getUint32(0, !0);
	if (n !== Go) throw new Error(`Bad VFS image magic: 0x${n.toString(16)} (expected 0x${Go.toString(16)})`);
	const s = i.getUint32(4, !0);
	if (1 !== s) throw new Error(`Unsupported VFS image version: ${s} (expected 1)`);
	const o = i.getUint32(8, !0), a = i.getUint32(12, !0);
	if (r.byteLength < jo + a + 4) throw new Error("VFS image truncated");
	return {
		image: r,
		view: i,
		flags: o,
		sabLen: a
	};
}
function Pa(e, t, r, i) {
	const n = jo + i, s = t.getUint32(n, !0);
	if (s > ea) throw new Error("VFS image lazy metadata exceeds 16777216 bytes");
	if (e.byteLength < n + 4 + s) throw new Error("VFS image truncated (lazy metadata section)");
	const o = n + 4 + s;
	let a = o;
	if (2 & r) {
		if (e.byteLength < o + 4) throw new Error("VFS image truncated (lazy archive section)");
		const r = t.getUint32(o, !0);
		if (r > ta) throw new Error("VFS image lazy archive metadata exceeds 16777216 bytes");
		if (e.byteLength < o + 4 + r) throw new Error("VFS image truncated (lazy archive payload)");
		a = o + 4 + r;
	}
	return {
		lazyLen: s,
		archiveOffset: o,
		metadataOffset: a
	};
}
function Ea(e, t) {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(e));
	} catch (r) {
		const e = r instanceof Error ? r.message : String(r);
		throw new Error(`${t} is not valid UTF-8 JSON: ${e}`);
	}
}
function Ca(e) {
	const t = e?.get("content-encoding")?.trim().toLowerCase();
	if (t && "identity" !== t) return;
	const r = e?.get("content-length");
	if (!r) return;
	const i = Number(r);
	return Number.isFinite(i) && i >= 0 ? i : void 0;
}
function xa(e, t = Date.now()) {
	const r = e?.get("retry-after")?.trim();
	if (!r) return;
	let i;
	if (/^\d+$/.test(r)) i = 1e3 * Number(r);
	else {
		const e = Date.parse(r);
		if (!Number.isFinite(e)) return;
		i = Math.max(0, e - t);
	}
	return !Number.isSafeInteger(i) || i < 0 ? void 0 : Math.min(i, 5e3);
}
function za(e) {
	if ("object" == typeof e && null !== e && "cause" in e) return e.cause;
}
function Ma(e) {
	if ("object" == typeof e && null !== e && "name" in e) return "string" == typeof e.name ? e.name : void 0;
}
function Ta(e) {
	if ("object" == typeof e && null !== e && "code" in e) return "string" == typeof e.code ? e.code : void 0;
}
function La(e, t) {
	const r = /* @__PURE__ */ new Set();
	let i = e;
	for (let n = 0; void 0 !== i && n < 8; n += 1) {
		if (r.has(i)) return !1;
		if (r.add(i), t(i)) return !0;
		i = za(i);
	}
	return !1;
}
function Ba(e) {
	return La(e, (e) => "AbortError" === Ma(e) || "ABORT_ERR" === Ta(e));
}
function Ra(e, t) {
	if (e instanceof _a) {
		if (!(408 === (r = e.status) || 429 === r || r >= 500 && r <= 599)) return null;
		if (void 0 !== e.retryAfterMs) return e.retryAfterMs;
	} else if (!function(e) {
		return !Ba(e) && La(e, (e) => {
			const t = Ma(e), r = Ta(e);
			return e instanceof TypeError || "NetworkError" === t || "TimeoutError" === t || void 0 !== r && Sa.has(r);
		});
	}(e)) return null;
	var r;
	return Math.min(250 * 2 ** t, 5e3);
}
function Ua(e) {
	if (e?.aborted) throw e.reason;
}
function Fa(e, t) {
	return Ua(t), 0 === e ? Promise.resolve() : new Promise((r, i) => {
		const n = setTimeout(() => a(!1), e), s = () => a(!0, t.reason);
		let o = !1;
		function a(e, a) {
			o || (o = !0, clearTimeout(n), t?.removeEventListener("abort", s), e ? i(a) : r());
		}
		t?.addEventListener("abort", s, { once: !0 }), t?.aborted && s();
	});
}
async function Ha(e, t) {
	try {
		await e.body?.cancel(t);
	} catch {}
}
function $a(e, t) {
	if (1 === e.length) return e[0];
	const r = new Uint8Array(t);
	let i = 0;
	for (const n of e) r.set(n, i), i += n.byteLength;
	return r;
}
function Wa(e) {
	if (void 0 === e) return;
	if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error("Lazy archive integrity must be an object");
	const t = e;
	if (2 !== Object.keys(t).length || !("sha256" in t) || !("bytes" in t)) throw new Error("Lazy archive integrity has unexpected fields");
	if ("string" != typeof t.sha256 || !ma.test(t.sha256)) throw new Error("Lazy archive integrity has an invalid SHA-256 digest");
	if (!Number.isSafeInteger(t.bytes) || Number(t.bytes) <= 0 || Number(t.bytes) > ia) throw new Error(`Lazy archive integrity byte count must be between 1 and ${ia}`);
	return {
		sha256: t.sha256,
		bytes: Number(t.bytes)
	};
}
function Da(e, t, r) {
	if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error(`${r} must be an object`);
	const i = e;
	if (Object.keys(i).length !== t.length || t.some((e) => !Object.prototype.hasOwnProperty.call(i, e))) throw new Error(`${r} has unexpected or missing fields`);
	return i;
}
function Oa(e, t, r, i) {
	if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error(`${i} must be an object`);
	const n = e, s = new Set(t);
	if (Object.keys(n).some((e) => !s.has(e)) || r.some((e) => !Object.prototype.hasOwnProperty.call(n, e))) throw new Error(`${i} has unexpected or missing fields`);
	return n;
}
function Na(e, t, r, i) {
	if (!Array.isArray(e) || e.length < r || e.length > i) throw new Error(`${t} must contain ${r} to ${i} items`);
	return e;
}
function Ka(e, t, r) {
	if ("string" != typeof e || 0 === e.length || e.includes("\0") || new TextEncoder().encode(e).byteLength > r) throw new Error(`${t} is invalid or exceeds ${r} bytes`);
	return e;
}
function Va(e, t, r, i) {
	if (!Number.isSafeInteger(e) || Number(e) < r || Number(e) > i) throw new Error(`${t} must be an integer between ${r} and ${i}`);
	return Number(e);
}
function qa(e, t = 1) {
	const r = e, i = "object" == typeof r && null !== r && !Array.isArray(r) && void 0 !== r.source, n = "object" == typeof r && null !== r && !Array.isArray(r) && void 0 !== r.modePolicy, s = Da(e, [
		"decoder",
		"mediaType",
		"sha256",
		"bytes",
		"expandedBytes",
		"sourceEntryCount",
		"transports",
		...n ? ["modePolicy"] : [],
		...i ? ["source"] : []
	], "Lazy tree content"), o = "zip-v1" === s.decoder ? "application/zip" : "homebrew-bottle-tar-gzip-v1" === s.decoder ? "application/vnd.oci.image.layer.v1.tar+gzip" : null;
	if (null === o || s.mediaType !== o) throw new Error("Lazy tree decoder and media type are inconsistent");
	const a = Wa({
		sha256: s.sha256,
		bytes: s.bytes
	});
	if (!a) throw new Error("Lazy tree integrity is required");
	const c = Na(s.transports, "Lazy tree transports", t, bo).map((e, t) => Ka(e, `Lazy tree transport ${t}`, ha));
	if (new Set(c).size !== c.length) throw new Error("Lazy tree transports contain duplicates");
	const l = Va(s.expandedBytes, "Lazy tree expanded byte count", 0, na), h = Va(s.sourceEntryCount, "Lazy tree source entry count", 1, oa), d = i ? function(e, t) {
		if ("homebrew-bottle-tar-gzip-v1" !== t) throw new Error("Lazy tree source inventory is valid only for original bottles");
		const r = Da(e, [
			"schema",
			"kind",
			"entries"
		], "Lazy tree source inventory");
		if (1 !== r.schema || "homebrew-bottle-tar-gzip-v1" !== r.kind) throw new Error("Lazy tree source inventory has an unsupported identity");
		const i = /* @__PURE__ */ new Map(), n = Na(r.entries, "Lazy tree source entries", 1, oa).map((e, t) => {
			const r = e, n = "object" != typeof r || null === r || Array.isArray(r) ? void 0 : r.type, s = "directory" === n || "file" === n ? [
				"sourcePath",
				"type",
				"mode",
				"size"
			] : "symlink" === n || "hardlink" === n ? [
				"sourcePath",
				"type",
				"mode",
				"size",
				"target"
			] : null;
			if (null === s) throw new Error(`Lazy tree source entry ${t} has invalid type`);
			const o = Da(e, s, `Lazy tree source entry ${t}`), a = Za(o.sourcePath, !1, `Lazy tree source entry ${t} path`);
			if (i.has(a)) throw new Error(`Lazy tree source inventory duplicates ${a}`);
			const c = Va(o.mode, `Lazy tree source entry ${a} mode`, 0, 4095), l = Va(o.size, `Lazy tree source entry ${a} size`, 0, sa);
			let h;
			if (("directory" === n || "symlink" === n || "hardlink" === n) && 0 !== l) throw new Error(`Lazy tree source ${a} has payload for ${String(n)}`);
			"symlink" === n ? h = Ka(o.target, `Lazy tree source symlink ${a} target`, la) : "hardlink" === n && (h = Za(o.target, !1, `Lazy tree source hardlink ${a} target`));
			const d = {
				sourcePath: a,
				type: n,
				mode: c,
				size: l,
				...void 0 === h ? {} : { target: h }
			};
			return i.set(a, d), d;
		}), s = n.map((e) => e.sourcePath);
		if (s.some((e, t) => t > 0 && s[t - 1] >= e)) throw new Error("Lazy tree source inventory is not in canonical path order");
		return {
			schema: 1,
			kind: "homebrew-bottle-tar-gzip-v1",
			entries: n
		};
	}(s.source, s.decoder) : void 0, f = n ? s.modePolicy : void 0;
	if (void 0 !== f && ("portable-posix-v1" !== f || "zip-v1" !== s.decoder || i)) throw new Error("Lazy tree mode policy is invalid for its decoder");
	if (void 0 !== d && d.entries.length !== h) throw new Error("Lazy tree source inventory count differs from its content");
	return {
		decoder: s.decoder,
		mediaType: o,
		sha256: a.sha256,
		bytes: a.bytes,
		expandedBytes: l,
		sourceEntryCount: h,
		transports: c,
		...void 0 === f ? {} : { modePolicy: f },
		...void 0 === d ? {} : { source: d }
	};
}
function Ga(e) {
	const t = {
		groups: e.length,
		archiveBytes: 0,
		expandedBytes: 0,
		payloadBytes: 0,
		entries: 0
	};
	for (const r of e) void 0 !== r.content && void 0 !== r.inventory && (t.archiveBytes += r.content.bytes, t.expandedBytes += r.content.expandedBytes, t.payloadBytes += r.inventory.filter((e) => "file" === e.type).reduce((e, t) => e + t.size, 0), t.entries += r.inventory.length + (r.content.source?.entries.length ?? 0));
	return t;
}
function ja(e) {
	(function(e, t = "Deferred tree collection") {
		for (const [r, i] of Object.entries(e)) if (!Number.isSafeInteger(i) || i < 0) throw new Error(`${t} ${r} usage is invalid`);
		if (e.groups > Eo) throw new Error(`${t} exceeds the ${Eo}-group cap`);
		if (e.archiveBytes > vo) throw new Error(`${t} exceeds the archive-byte cap`);
		if (e.expandedBytes > Ao) throw new Error(`${t} exceeds the expansion cap`);
		if (e.payloadBytes > Io) throw new Error(`${t} exceeds the payload-byte cap`);
		if (e.entries > Po) throw new Error(`${t} exceeds the entry-count cap`);
	})(e, "Serialized lazy tree collection");
}
function Xa(e) {
	for (const [t, r] of e.entries()) if (r.kind === ya || r.kind === wa || r.kind === ba) ic(r, r.kind);
	else {
		if (r.kind !== ga) throw new Error(`Serialized lazy archive group ${t} has an unsupported kind`);
		rc(r, !1);
	}
	(function(e) {
		ja(Ga(e));
	})(e), function(e) {
		const t = /* @__PURE__ */ new Map();
		for (const r of e) {
			const e = r.activation?.atomicGroup;
			if (void 0 === e) continue;
			if (!Qa(e)) throw new Error(`Serialized lazy atomic activation group ${e.id} is unsealed`);
			let i = t.get(e.id);
			if (void 0 === i) i = {
				expectedCount: e.expectedCount,
				cohortSha256: e.cohortSha256,
				members: /* @__PURE__ */ new Set(),
				descriptors: /* @__PURE__ */ new Set()
			}, t.set(e.id, i);
			else if (i.expectedCount !== e.expectedCount || i.cohortSha256 !== e.cohortSha256) throw new Error(`Serialized lazy atomic activation group ${e.id} has inconsistent seals`);
			if (i.members.has(e.member) || i.descriptors.has(e.descriptorSha256)) throw new Error(`Serialized lazy atomic activation group ${e.id} duplicates a member`);
			i.members.add(e.member), i.descriptors.add(e.descriptorSha256);
		}
		for (const [r, i] of t) if (i.members.size !== i.expectedCount) throw new Error(`Serialized lazy atomic activation group ${r} has ${i.members.size} of ${i.expectedCount} members`);
	}(e);
}
function Ya(e) {
	const t = new Map(e.map((e) => [e.sourcePath, e])), r = /* @__PURE__ */ new Map();
	for (const i of e) {
		if ("hardlink" !== i.type || r.has(i.sourcePath)) continue;
		const e = [], n = /* @__PURE__ */ new Set();
		let s, o = i;
		for (; "hardlink" === o.type && (s = r.get(o.sourcePath), void 0 === s);) {
			if (n.has(o.sourcePath)) throw new Error(`Lazy tree source hardlink cycle includes ${o.sourcePath}`);
			n.add(o.sourcePath), e.push(o);
			const r = t.get(o.target);
			if (void 0 === r) throw new Error(`Lazy tree source hardlink ${o.sourcePath} target is absent`);
			if ("file" !== r.type && "hardlink" !== r.type) throw new Error(`Lazy tree source hardlink ${o.sourcePath} target is not regular`);
			o = r;
		}
		void 0 === s && (s = o);
		for (const t of e) r.set(t.sourcePath, s);
	}
	return r;
}
function Za(e, t, r, i = !1) {
	if ("string" != typeof e || 0 === e.length || new TextEncoder().encode(e).byteLength > ca || e.includes("\0") || e.includes("\\") || e.startsWith("/") !== t) throw new Error(`${r} is not a canonical ${t ? "absolute" : "relative"} path`);
	if (i && t && "/" === e) return e;
	if (e.slice(t ? 1 : 0).split("/").some((e) => "" === e || "." === e || ".." === e)) throw new Error(`${r} has an unsafe path segment`);
	return e;
}
function Ja(e) {
	const t = "object" != typeof e || null === e || Array.isArray(e) ? null : e, r = null !== t && (Object.hasOwn(t, "descriptorSha256") || Object.hasOwn(t, "expectedCount") || Object.hasOwn(t, "cohortSha256")), i = Da(e, r ? [
		"id",
		"member",
		"descriptorSha256",
		"expectedCount",
		"cohortSha256"
	] : ["id", "member"], "Lazy tree atomic activation membership"), n = Ka(i.id, "Lazy tree atomic activation group", ua), s = Ka(i.member, "Lazy tree atomic activation member", ua);
	if (!/^[a-z0-9][a-z0-9:._-]*$/.test(n) || !/^[a-z0-9][a-z0-9:+._/-]*$/.test(s) || s.includes("//") || s.endsWith("/")) throw new Error("Lazy tree atomic activation membership is invalid");
	if (!r) return {
		id: n,
		member: s
	};
	const o = Ka(i.descriptorSha256, "Lazy tree atomic member descriptor digest", 64), a = Ka(i.cohortSha256, "Lazy tree atomic cohort digest", 64);
	if (!ma.test(o) || !ma.test(a)) throw new Error("Lazy tree atomic activation digest is invalid");
	return {
		id: n,
		member: s,
		descriptorSha256: o,
		expectedCount: Va(i.expectedCount, "Lazy tree atomic activation expected member count", 1, aa),
		cohortSha256: a
	};
}
function Qa(e) {
	return void 0 !== e.descriptorSha256 && void 0 !== e.expectedCount && void 0 !== e.cohortSha256;
}
function ec(e, t, r, i, n = 1) {
	const s = qa(e, n), o = ka(r), a = Da(i, [
		"mode",
		"capabilities",
		"roots",
		..."object" == typeof i && null !== i && !Array.isArray(i) && Object.hasOwn(i, "atomicGroup") ? ["atomicGroup"] : []
	], "Lazy tree activation");
	if ("boot-prefetch" !== a.mode && "first-use" !== a.mode) throw new Error("Lazy tree activation mode is invalid");
	const c = Na(a.capabilities, "Lazy tree activation capabilities", 1, da).map((e, t) => {
		const r = Ka(e, `Lazy tree activation capability ${t}`, ko);
		if (!/^[a-z0-9][a-z0-9:._-]*$/.test(r)) throw new Error(`Lazy tree activation capability ${t} is invalid`);
		return r;
	}), l = Na(a.roots, "Lazy tree activation roots", 1, fa).map((e, t) => Za(e, !0, `Lazy tree activation root ${t}`, !0));
	if (new Set(c).size !== c.length || new Set(l).size !== l.length) throw new Error("Lazy tree activation contains duplicates");
	const h = void 0 === a.atomicGroup ? void 0 : Ja(a.atomicGroup);
	if (void 0 !== h && "first-use" !== a.mode) throw new Error("Lazy tree atomic activation group requires a valid first-use identity");
	const d = {
		mode: a.mode,
		capabilities: c,
		roots: l,
		...void 0 === h ? {} : { atomicGroup: h }
	}, f = Na(t, "Lazy tree inventory", 1, oa), u = [], p = /* @__PURE__ */ new Map(), m = /* @__PURE__ */ new Map(), g = void 0 === s.source ? void 0 : new Map(s.source.entries.map((e) => [e.sourcePath, e])), y = void 0 === s.source ? void 0 : Ya(s.source.entries);
	let w = 0;
	for (const [_, k] of f.entries()) {
		if ("object" != typeof k || null === k || Array.isArray(k)) throw new Error(`Lazy tree entry ${_} must be an object`);
		const e = k.type, t = "directory" === e ? [
			"vfsPath",
			"sourcePath",
			"type",
			"mode",
			"size"
		] : "file" === e ? [
			"vfsPath",
			"sourcePath",
			"type",
			"mode",
			"size",
			"inodeGroup"
		] : "symlink" === e ? [
			"vfsPath",
			"sourcePath",
			"type",
			"mode",
			"size",
			"target"
		] : "hardlink" === e ? [
			"vfsPath",
			"sourcePath",
			"type",
			"mode",
			"size",
			"target",
			"inodeGroup"
		] : null;
		if (!t) throw new Error(`Lazy tree entry ${_} has an invalid type`);
		const r = Da(k, [...t, ...void 0 === g ? [] : ["materialization"]], `Lazy tree entry ${_}`), i = Za(r.vfsPath, !0, `Lazy tree entry ${_} VFS path`), n = Za(r.sourcePath, !1, `Lazy tree entry ${_} source path`), a = void 0 === g ? void 0 : r.materialization;
		if (void 0 !== g && "archive" !== a && "archive-homebrew-relocate" !== a && "archive-copy" !== a && "archive-copy-mode" !== a && "descriptor" !== a) throw new Error(`Lazy tree entry ${i} has invalid materialization provenance`);
		if ("/" !== o && i !== o && !i.startsWith(`${o}/`)) throw new Error(`Lazy tree entry ${i} escapes its mount prefix`);
		if (p.has(i)) throw new Error(`Lazy tree duplicates VFS path ${i}`);
		const c = Va(r.mode, `Lazy tree entry ${i} mode`, 0, 4095), l = Va(r.size, `Lazy tree entry ${i} size`, 0, sa);
		let h, d;
		if ("directory" === e) {
			if (0 !== l) throw new Error(`Lazy tree directory ${i} has nonzero size`);
		} else if ("symlink" === e) {
			if (h = Ka(r.target, `Lazy tree symlink ${i} target`, la), new TextEncoder().encode(h).byteLength !== l) throw new Error(`Lazy tree symlink ${i} size differs from its target`);
		} else d = Ka(r.inodeGroup, `Lazy tree entry ${i} inode group`, ca), "hardlink" === e && (h = Za(r.target, !0, `Lazy tree hardlink ${i} target`));
		if ("hardlink" !== e && (w += l, w > sa)) throw new Error("Lazy tree inventory exceeds the expansion limit");
		const f = {
			vfsPath: i,
			sourcePath: n,
			...void 0 === a ? {} : { materialization: a },
			type: e,
			mode: c,
			size: l,
			...void 0 === h ? {} : { target: h },
			...void 0 === d ? {} : { inodeGroup: d }
		};
		if (void 0 === g) {
			const e = m.get(n);
			if (e) {
				if ("zip-v1" !== s.decoder || "hardlink" !== f.type || e.inodeGroup !== f.inodeGroup) throw new Error(`Lazy tree duplicates source path ${n}`);
			} else {
				if ("zip-v1" === s.decoder && "hardlink" === f.type) throw new Error(`Lazy ZIP hardlink ${i} does not reuse a canonical source path`);
				m.set(n, f);
			}
		} else if ("descriptor" === f.materialization) {
			if ("directory" !== f.type && "symlink" !== f.type) throw new Error(`Lazy tree descriptor entry ${i} is not structural`);
			if (g.has(n)) throw new Error(`Lazy tree descriptor entry ${i} impersonates a source member`);
		} else {
			const e = g.get(n);
			if (void 0 === e) throw new Error(`Lazy tree entry ${i} names absent source ${n}`);
			if ("archive-copy" === f.materialization || "archive-copy-mode" === f.materialization) {
				if ("file" !== f.type || "file" !== e.type || "archive-copy" === f.materialization && f.mode !== e.mode) throw new Error(`Lazy tree archive copy ${i} differs from its source`);
			} else if ("archive-homebrew-relocate" === f.materialization) {
				if ("file" !== f.type && "hardlink" !== f.type || e.type !== f.type || "file" === f.type && e.mode !== f.mode) throw new Error(`Lazy tree receipt-relocated entry ${i} differs from its source`);
			} else if (e.type !== f.type || "symlink" === f.type && e.target !== f.target || "hardlink" !== f.type && e.mode !== f.mode) throw new Error(`Lazy tree archive entry ${i} differs from its source`);
		}
		u.push(f), p.set(i, f);
	}
	for (const _ of u) {
		const e = _.vfsPath.split("/").filter(Boolean);
		for (let t = 1; t < e.length; t += 1) {
			const r = `/${e.slice(0, t).join("/")}`, i = p.get(r);
			if (i && "directory" !== i.type) throw new Error(`Lazy tree entry ${_.vfsPath} descends through non-directory ${r}`);
		}
	}
	const b = function(e, t) {
		const r = /* @__PURE__ */ new Map(), i = /* @__PURE__ */ new Map();
		for (const o of e) {
			if (r.has(o.path)) throw new Error(`${t} duplicates path ${o.path}`);
			if (r.set(o.path, o), "file" === o.type) {
				if (!o.inodeGroup) throw new Error(`${t} file ${o.path} has no inode group`);
				if (i.has(o.inodeGroup)) throw new Error(`${t} inode group ${o.inodeGroup} has multiple files`);
				i.set(o.inodeGroup, o);
			}
		}
		const n = /* @__PURE__ */ new Set(), s = /* @__PURE__ */ new Map();
		for (const o of e) {
			if ("hardlink" !== o.type || s.has(o.path)) continue;
			const e = [];
			let a, c = o;
			for (; "hardlink" === c.type;) {
				const i = s.get(c.path);
				if (i) {
					a = i;
					break;
				}
				if (n.has(c.path)) throw new Error(`${t} hardlink cycle reaches ${c.path}`);
				if (n.add(c.path), e.push(c), !c.target) throw new Error(`${t} hardlink ${c.path} has no target`);
				const o = r.get(c.target);
				if (!o) throw new Error(`${t} hardlink ${c.path} target ${c.target} is missing`);
				if ("file" !== o.type && "hardlink" !== o.type || !c.inodeGroup || o.inodeGroup !== c.inodeGroup || o.size !== c.size || o.mode !== c.mode) throw new Error(`${t} hardlink ${c.path} has an invalid target`);
				c = o;
			}
			a ??= "file" === c.type ? c : void 0;
			const l = i.get(o.inodeGroup ?? "");
			if (!a || a !== l) throw new Error(`${t} hardlink ${o.path} does not resolve to its inode`);
			for (let r = e.length - 1; r >= 0; r -= 1) {
				const o = e[r];
				if (i.get(o.inodeGroup ?? "") !== a) throw new Error(`${t} hardlink ${o.path} does not resolve to its inode`);
				n.delete(o.path), s.set(o.path, a);
			}
		}
		return {
			canonicalByGroup: i,
			canonicalTargetByPath: s
		};
	}(u.map((e) => ({
		path: e.vfsPath,
		type: e.type,
		mode: e.mode,
		size: e.size,
		target: e.target,
		inodeGroup: e.inodeGroup
	})), "Lazy tree");
	if (void 0 !== g) {
		const e = /* @__PURE__ */ new Set();
		for (const t of u) {
			if ("archive-homebrew-relocate" !== t.materialization) continue;
			const r = g.get(t.sourcePath), i = "file" === r.type ? r : y.get(r.sourcePath);
			if ("file" !== i?.type) throw new Error(`Lazy tree receipt-relocated entry ${t.vfsPath} is not regular`);
			e.add(i.sourcePath);
		}
		for (const t of u) {
			if ("descriptor" === t.materialization || "file" !== t.type && "hardlink" !== t.type) continue;
			const r = g.get(t.sourcePath), i = "file" === r.type ? r : y.get(r.sourcePath);
			if ("file" !== i?.type || !e.has(i.sourcePath) && t.size !== i.size) throw new Error(`Lazy tree archive entry ${t.vfsPath} differs from its source`);
		}
		for (const t of u) {
			if ("hardlink" !== t.type || "archive" !== t.materialization && "archive-homebrew-relocate" !== t.materialization) continue;
			const e = g.get(t.sourcePath), r = p.get(t.target), i = y.get(e.sourcePath);
			if (e.target !== r?.sourcePath || "file" !== i?.type || i.mode !== t.mode || r?.mode !== t.mode) throw new Error(`Lazy tree hardlink ${t.vfsPath} differs from its source`);
		}
	}
	if (s.sourceEntryCount !== (void 0 === g ? m.size : g.size)) throw new Error("Lazy tree source entry count differs from its inventory");
	if (void 0 === s.source && s.expandedBytes < w || "zip-v1" === s.decoder && s.expandedBytes !== w) throw new Error("Lazy tree expanded byte count differs from its inventory");
	for (const _ of d.roots) if ("/" !== _ && !u.some((e) => e.vfsPath === _ || e.vfsPath.startsWith(`${_}/`))) throw new Error(`Lazy tree activation root ${_} is not owned by its inventory`);
	const S = /* @__PURE__ */ new Map();
	for (const _ of u) "file" === _.type && S.set(_.inodeGroup, _);
	if (S.size !== b.canonicalByGroup.size) throw new Error("Lazy tree regular inode inventory is inconsistent");
	return {
		content: s,
		entries: u,
		mountPrefix: o,
		activation: d,
		canonicalByGroup: S
	};
}
function tc(e) {
	return JSON.stringify([
		e.sourcePath,
		e.type,
		e.inodeGroup,
		e.target
	]);
}
function rc(e, t) {
	const r = Oa(e, [
		"kind",
		"content",
		"url",
		"mountPrefix",
		"integrity",
		"materialized",
		"entries"
	], [
		"url",
		"mountPrefix",
		"materialized",
		"entries"
	], "Serialized legacy lazy archive");
	if (void 0 === r.kind) {
		if (!t) throw new Error("Serialized lazy archive is missing its kind discriminator");
	} else if (r.kind !== ga) throw new Error("Serialized legacy lazy archive has an unsupported kind");
	const i = Ka(r.url, "Serialized legacy lazy archive URL", ha), n = ka(r.mountPrefix), s = Wa(r.integrity);
	if (void 0 !== r.content) {
		if (!t || void 0 !== r.kind) throw new Error("Typed legacy lazy archives cannot carry generic content");
		const e = qa(r.content);
		if ("zip-v1" !== e.decoder || 1 !== e.transports.length || e.transports[0] !== i || !s || e.sha256 !== s.sha256 || e.bytes !== s.bytes) throw new Error("Untagged legacy ZIP content identity is inconsistent");
	}
	if (!1 !== r.materialized) throw new Error("Serialized legacy lazy archive must describe pending content");
	const o = /* @__PURE__ */ new Set(), a = Na(r.entries, "Serialized legacy lazy archive entries", 1, oa).map((e, t) => {
		const r = Oa(e, [
			"vfsPath",
			"ino",
			"generation",
			"dataSequence",
			"size",
			"isSymlink",
			"deleted",
			"materialized",
			"archivePath",
			"sourcePath",
			"type",
			"inodeGroup",
			"target"
		], [
			"vfsPath",
			"ino",
			"size",
			"isSymlink",
			"deleted"
		], `Serialized legacy lazy archive entry ${t}`), i = Za(r.vfsPath, !0, `Serialized legacy lazy archive entry ${t} VFS path`);
		if (o.has(i)) throw new Error(`Serialized legacy lazy archive duplicates path ${i}`);
		o.add(i);
		const n = Va(r.ino, `Serialized legacy lazy archive entry ${i} inode`, 1, Number.MAX_SAFE_INTEGER), s = void 0 === r.generation ? void 0 : Va(r.generation, `Serialized legacy lazy archive entry ${i} generation`, 0, Number.MAX_SAFE_INTEGER), a = void 0 === r.dataSequence ? void 0 : Va(r.dataSequence, `Serialized legacy lazy archive entry ${i} data sequence`, 0, Number.MAX_SAFE_INTEGER), c = Va(r.size, `Serialized legacy lazy archive entry ${i} size`, 0, sa);
		if (!1 !== r.isSymlink || !1 !== r.deleted || void 0 !== r.materialized && !1 !== r.materialized) throw new Error(`Serialized legacy lazy archive entry ${i} is not pending`);
		if (void 0 !== r.type && "file" !== r.type) throw new Error(`Serialized legacy lazy archive entry ${i} has an invalid type`);
		const l = void 0 === r.archivePath ? void 0 : Za(r.archivePath, !1, `Serialized legacy lazy archive entry ${i} archive path`), h = void 0 === r.sourcePath ? void 0 : Za(r.sourcePath, !1, `Serialized legacy lazy archive entry ${i} source path`), d = void 0 === r.inodeGroup ? void 0 : Ka(r.inodeGroup, `Serialized legacy lazy archive entry ${i} inode group`, ca);
		if (void 0 !== r.target) throw new Error(`Serialized legacy lazy archive entry ${i} has a link target`);
		return {
			vfsPath: i,
			ino: n,
			...void 0 === s ? {} : { generation: s },
			...void 0 === a ? {} : { dataSequence: a },
			size: c,
			isSymlink: !1,
			deleted: !1,
			materialized: !1,
			...void 0 === l ? {} : { archivePath: l },
			...void 0 === h ? {} : { sourcePath: h },
			type: "file",
			...void 0 === d ? {} : { inodeGroup: d }
		};
	});
	return {
		kind: ga,
		url: i,
		mountPrefix: n,
		...void 0 === s ? {} : { integrity: s },
		materialized: !1,
		entries: a
	};
}
function ic(e, t) {
	const r = Da(e, [
		"kind",
		"content",
		"inventory",
		"activation",
		"url",
		"mountPrefix",
		"integrity",
		"materialized",
		"entries"
	], "Serialized lazy tree");
	if (r.kind !== t) throw new Error("Serialized lazy tree has an unsupported kind");
	const i = ec(r.content, r.inventory, r.mountPrefix, r.activation);
	if (t !== ba && t === ya != (void 0 === i.content.source)) throw new Error(t === ya ? "Serialized deferred-tree-v1 cannot contain original-bottle source metadata" : "Serialized deferred-tree-v2 requires original-bottle source metadata");
	const n = i.activation.atomicGroup;
	if (t === ba ? void 0 === n || !Qa(n) : void 0 !== n) throw new Error(t === ba ? "Serialized deferred-tree-v3 requires a sealed atomic activation" : "Atomic activation requires serialized deferred-tree-v3");
	const s = Ka(r.url, "Serialized lazy tree URL", ha);
	if (s !== i.content.transports[0]) throw new Error("Serialized lazy tree URL differs from its primary transport");
	const o = Wa(r.integrity);
	if (!o || o.sha256 !== i.content.sha256 || o.bytes !== i.content.bytes) throw new Error("Serialized lazy tree integrity differs from its content");
	if (!1 !== r.materialized) throw new Error("Serialized lazy tree must describe pending content");
	const a = new Map(i.entries.map((e) => [e.vfsPath, e])), c = new Map(i.entries.map((e) => [tc(e), e])), l = Na(r.entries, "Serialized lazy tree entries", 0, oa), h = /* @__PURE__ */ new Set(), d = l.map((e, t) => {
		const r = Oa(e, [
			"vfsPath",
			"ino",
			"generation",
			"dataSequence",
			"size",
			"isSymlink",
			"deleted",
			"materialized",
			"archivePath",
			"sourcePath",
			"type",
			"inodeGroup",
			"target"
		], [
			"vfsPath",
			"ino",
			"generation",
			"dataSequence",
			"size",
			"isSymlink",
			"deleted",
			"materialized",
			"archivePath",
			"sourcePath",
			"type",
			"inodeGroup"
		], `Serialized lazy tree entry ${t}`), n = Za(r.vfsPath, !0, `Serialized lazy tree entry ${t} VFS path`);
		if (h.has(n)) throw new Error(`Serialized lazy tree duplicates pending path ${n}`);
		h.add(n);
		const s = Za(r.sourcePath, !1, `Serialized lazy tree entry ${t} source path`), o = Za(r.archivePath, !1, `Serialized lazy tree entry ${t} archive path`), l = a.get(n), d = c.get(tc({
			sourcePath: s,
			type: "string" == typeof r.type ? r.type : void 0,
			inodeGroup: "string" == typeof r.inodeGroup ? r.inodeGroup : void 0,
			target: "string" == typeof r.target ? r.target : void 0
		})) ?? l;
		if (!d || "file" !== d.type && "hardlink" !== d.type || void 0 !== l?.inodeGroup && l.inodeGroup !== d.inodeGroup) throw new Error(`Serialized lazy tree entry ${n} is absent from its inventory`);
		const f = i.canonicalByGroup.get(d.inodeGroup);
		if (r.type !== d.type || r.inodeGroup !== d.inodeGroup || r.size !== d.size || o !== f?.sourcePath || r.target !== d.target || !1 !== r.isSymlink || !1 !== r.deleted || !1 !== r.materialized) throw new Error(`Serialized lazy tree entry ${n} disagrees with its inventory`);
		return {
			vfsPath: n,
			ino: Va(r.ino, `Serialized lazy tree entry ${n} inode`, 1, Number.MAX_SAFE_INTEGER),
			generation: Va(r.generation, `Serialized lazy tree entry ${n} generation`, 0, Number.MAX_SAFE_INTEGER),
			dataSequence: Va(r.dataSequence, `Serialized lazy tree entry ${n} data sequence`, 0, Number.MAX_SAFE_INTEGER),
			size: d.size,
			isSymlink: !1,
			deleted: !1,
			materialized: !1,
			archivePath: o,
			sourcePath: s,
			type: d.type,
			inodeGroup: d.inodeGroup,
			...void 0 === d.target ? {} : { target: d.target }
		};
	});
	for (const f of i.entries) if (void 0 !== i.activation.atomicGroup && ("file" === f.type || "hardlink" === f.type) && !h.has(f.vfsPath)) throw new Error(`Serialized lazy tree omits pending path ${f.vfsPath}`);
	return {
		kind: t,
		content: i.content,
		inventory: i.entries,
		activation: i.activation,
		url: s,
		mountPrefix: i.mountPrefix,
		integrity: o,
		materialized: !1,
		entries: d
	};
}
async function nc(e, t) {
	const r = globalThis.crypto?.subtle;
	if (!r) throw new Error(`${t} SHA-256 verification is unavailable`);
	const i = new Uint8Array(e.byteLength);
	i.set(e);
	const n = new Uint8Array(await r.digest("SHA-256", i));
	return Array.from(n, (e) => e.toString(16).padStart(2, "0")).join("");
}
async function sc(e, t, r) {
	if (void 0 === r) return;
	if (e.byteLength !== r.bytes) throw new Error(`Lazy ${t} byte count ${e.byteLength} does not match expected ${r.bytes}`);
	const i = await nc(e, `Lazy ${t}`);
	if (i !== r.sha256) throw new Error(`Lazy ${t} SHA-256 ${i} does not match expected ${r.sha256}`);
}
function oc(e, t) {
	const r = t.map(({ member: e, descriptorSha256: t }) => ({
		member: e,
		descriptorSha256: t
	}));
	return new TextEncoder().encode(JSON.stringify({
		schema: 1,
		id: e,
		members: r.sort((e, t) => e.member < t.member ? -1 : e.member > t.member ? 1 : 0)
	}));
}
function ac(e, t = e.transports) {
	const r = [...t];
	Object.freeze(r);
	const i = void 0 === e.source ? void 0 : {
		schema: 1,
		kind: "homebrew-bottle-tar-gzip-v1",
		entries: e.source.entries.map((e) => Object.freeze({ ...e }))
	};
	return void 0 !== i && (Object.freeze(i.entries), Object.freeze(i)), Object.freeze({
		decoder: e.decoder,
		mediaType: e.mediaType,
		sha256: e.sha256,
		bytes: e.bytes,
		expandedBytes: e.expandedBytes,
		sourceEntryCount: e.sourceEntryCount,
		transports: r,
		...void 0 === e.modePolicy ? {} : { modePolicy: e.modePolicy },
		...void 0 === i ? {} : { source: i }
	});
}
function cc(e) {
	return {
		decoder: e.decoder,
		mediaType: e.mediaType,
		sha256: e.sha256,
		bytes: e.bytes,
		expandedBytes: e.expandedBytes,
		sourceEntryCount: e.sourceEntryCount,
		transports: [...e.transports],
		...void 0 === e.modePolicy ? {} : { modePolicy: e.modePolicy },
		...void 0 === e.source ? {} : { source: {
			schema: 1,
			kind: "homebrew-bottle-tar-gzip-v1",
			entries: e.source.entries.map((e) => ({ ...e }))
		} }
	};
}
function lc(e) {
	return {
		mode: e.activation.mode,
		capabilities: [...e.activation.capabilities],
		roots: [...e.activation.roots],
		atomicGroup: {
			id: e.id,
			member: e.member,
			descriptorSha256: e.descriptorSha256,
			expectedCount: e.expectedCount,
			cohortSha256: e.cohortSha256
		}
	};
}
function hc(e, t, r) {
	const i = e.content, n = e.inventory, s = e.activation, o = e.integrity, a = e.entries, c = e.url, l = e.mountPrefix, h = e.materialized, d = s?.atomicGroup;
	if (void 0 === i || void 0 === n || void 0 === s || void 0 === d || "first-use" !== s.mode || d.id !== t || d.member !== r || h) throw new Error(`Lazy atomic activation member ${r} changed before snapshot`);
	if (o?.sha256 !== i.sha256 || o?.bytes !== i.bytes || c !== (i.transports[0] ?? "")) throw new Error(`Lazy atomic activation member ${r} has inconsistent integrity`);
	const f = ac(i), u = function(e) {
		const t = e.map((e) => Object.freeze({ ...e }));
		return Object.freeze(t), t;
	}(n), p = function(e, t, r) {
		const i = [...e.capabilities], n = [...e.roots];
		return Object.freeze(i), Object.freeze(n), Object.freeze({
			mode: e.mode,
			capabilities: i,
			roots: n,
			atomicGroup: Object.freeze({
				id: t,
				member: r
			})
		});
	}(s, t, r), m = /* @__PURE__ */ new Map();
	for (const S of u) "file" === S.type && m.set(S.inodeGroup, S.sourcePath);
	const g = u.filter((e) => "directory" !== e.type);
	if (a.size !== g.length) throw new Error(`Lazy atomic activation member ${r} has inconsistent runtime entries`);
	const y = g.map((e) => {
		const t = a.get(e.vfsPath), i = "symlink" === e.type, n = i ? e.sourcePath : m.get(e.inodeGroup), s = void 0 !== t && (t.sourcePath === e.sourcePath && t.type === e.type && t.target === e.target || "hardlink" === e.type && t.sourcePath === n && "file" === t.type && void 0 === t.target), o = void 0 === t ? ["missing"] : [
			void 0 === n ? "archivePath source" : void 0,
			void 0 === t.generation ? "generation" : void 0,
			void 0 === t.dataSequence ? "dataSequence" : void 0,
			t.size !== e.size ? "size" : void 0,
			t.isSymlink !== i ? "symlink kind" : void 0,
			t.deleted ? "deletion state" : void 0,
			t.materialized !== i ? "materialization state" : void 0,
			t.archivePath !== n ? "archivePath" : void 0,
			s ? void 0 : "descriptor mapping",
			t.inodeGroup !== e.inodeGroup ? "inode group" : void 0
		].filter((e) => void 0 !== e);
		if (o.length > 0) throw new Error(`Lazy atomic activation member ${r} has inconsistent mapping at ${e.vfsPath}: ${o.join(", ")}`);
		const c = t;
		return Object.freeze({
			vfsPath: e.vfsPath,
			ino: c.ino,
			generation: c.generation,
			dataSequence: c.dataSequence,
			size: c.size,
			isSymlink: c.isSymlink,
			deleted: !1,
			materialized: c.materialized,
			archivePath: n,
			sourcePath: e.sourcePath,
			type: e.type,
			...void 0 === e.inodeGroup ? {} : { inodeGroup: e.inodeGroup },
			...void 0 === e.target ? {} : { target: e.target }
		});
	});
	Object.freeze(y);
	const w = Object.freeze({
		sha256: f.sha256,
		bytes: f.bytes
	}), b = function(e, t, r, i) {
		const n = i.atomicGroup;
		if (void 0 === n) throw new Error("Lazy atomic member is missing its typed tree descriptor");
		const s = {
			schema: 1,
			content: {
				decoder: e.decoder,
				mediaType: e.mediaType,
				sha256: e.sha256,
				bytes: e.bytes,
				expandedBytes: e.expandedBytes,
				sourceEntryCount: e.sourceEntryCount,
				...void 0 === e.modePolicy ? {} : { modePolicy: e.modePolicy },
				...void 0 === e.source ? {} : { source: e.source }
			},
			mountPrefix: r,
			inventory: [...t].sort((e, t) => e.vfsPath < t.vfsPath ? -1 : e.vfsPath > t.vfsPath ? 1 : 0),
			activation: {
				mode: i.mode,
				capabilities: i.capabilities,
				roots: i.roots,
				atomicGroup: {
					id: n.id,
					member: n.member
				}
			}
		};
		return new TextEncoder().encode(JSON.stringify(s));
	}(f, u, l, p);
	return Object.freeze({
		id: t,
		member: r,
		descriptorBytes: b,
		content: f,
		inventory: u,
		activation: p,
		url: f.transports[0] ?? "",
		mountPrefix: l,
		integrity: w,
		entries: y
	});
}
function dc(e, t, r, i) {
	return Object.freeze({
		...e,
		descriptorSha256: t,
		expectedCount: r,
		cohortSha256: i
	});
}
function fc(e, t) {
	return !(e.id !== t.id || e.member !== t.member || e.url !== t.url || e.mountPrefix !== t.mountPrefix || e.integrity.sha256 !== t.integrity.sha256 || e.integrity.bytes !== t.integrity.bytes || e.content.transports.length !== t.content.transports.length || e.content.transports.some((e, r) => e !== t.content.transports[r]) || !function(e, t) {
		if (e.byteLength !== t.byteLength) return !1;
		for (let r = 0; r < e.byteLength; r++) if (e[r] !== t[r]) return !1;
		return !0;
	}(e.descriptorBytes, t.descriptorBytes) || e.entries.length !== t.entries.length) && e.entries.every((e, r) => {
		const i = t.entries[r];
		return void 0 !== i && e.vfsPath === i.vfsPath && function(e, t) {
			return e.ino === t.ino && e.generation === t.generation && e.dataSequence === t.dataSequence && e.size === t.size && e.isSymlink === t.isSymlink && e.deleted === t.deleted && e.materialized === t.materialized && e.archivePath === t.archivePath && e.sourcePath === t.sourcePath && e.type === t.type && e.inodeGroup === t.inodeGroup && e.target === t.target;
		}(e, i);
	});
}
function uc(e, t) {
	const r = ac(e.content, e.content.transports.map(t));
	return Object.freeze({
		...e,
		content: r,
		url: r.transports[0] ?? ""
	});
}
function pc(e) {
	return {
		paths: Array.from(e.paths),
		expectedIno: e.ino,
		expectedGeneration: e.generation,
		expectedDataSequence: e.dataSequence,
		data: e.content
	};
}
var mc = class e {
	fs;
	imageMetadata;
	lazyFiles = /* @__PURE__ */ new Map();
	lazyArchiveGroups = [];
	deferredTreeMaterializationHandles = /* @__PURE__ */ new WeakMap();
	lazyArchiveInodes = /* @__PURE__ */ new Map();
	lazyAtomicGroups = /* @__PURE__ */ new Map();
	lazyAtomicGroupByTree = /* @__PURE__ */ new WeakMap();
	sealedLazyAtomicStates = /* @__PURE__ */ new WeakMap();
	lazyDownloadListeners = /* @__PURE__ */ new Set();
	lazyPreparations = /* @__PURE__ */ new Map();
	lazyTransport = { fetcher: (e, t) => void 0 === t ? globalThis.fetch(e) : globalThis.fetch(e, t) };
	constructor(e, t = null) {
		this.fs = e, this.imageMetadata = t;
	}
	static inodeKey(e, t) {
		return `${e}:${t}`;
	}
	static canAdoptLegacyLazyStub(e) {
		return (e.mode & Xo) === Yo && 0 === e.size && e.dataSequence <= 1;
	}
	reconcileLazyIdentityState(t) {
		for (const [e, r] of this.lazyFiles) {
			const i = t.get(e);
			i && i.dataSequence === r.dataSequence && 0 !== i.paths.length ? (r.paths = new Set(i.paths), r.paths.has(r.path) || (r.path = i.paths[0])) : this.lazyFiles.delete(e);
		}
		this.lazyArchiveInodes.clear();
		for (const r of this.lazyArchiveGroups) {
			const i = this.lazyAtomicGroupByTree.get(r), n = this.sealedLazyAtomicStates.get(r);
			if (void 0 !== n) {
				if (!i?.committed) for (const i of n.snapshot.entries) {
					if (i.isSymlink || i.materialized || void 0 === i.generation) continue;
					const n = e.inodeKey(i.ino, i.generation), s = t.get(n);
					void 0 !== s && s.dataSequence === i.dataSequence && s.paths.length > 0 && this.lazyArchiveInodes.set(n, r);
				}
				continue;
			}
			const s = void 0 !== r.content && void 0 !== r.inventory && !r.materialized, o = /* @__PURE__ */ new Map();
			for (const t of r.entries.values()) {
				if (t.deleted || t.materialized || void 0 === t.generation) continue;
				const r = e.inodeKey(t.ino, t.generation);
				o.has(r) || o.set(r, t);
			}
			const a = new Map(Array.from(r.entries.entries()).filter(([, e]) => e.deleted || e.isSymlink && !e.deleted));
			for (const [e, c] of o) {
				const i = t.get(e);
				if (i && i.dataSequence === (c.dataSequence ?? 0)) {
					for (const e of i.paths) a.set(e, {
						...c,
						ino: i.ino,
						generation: i.generation,
						dataSequence: i.dataSequence,
						deleted: !1,
						materialized: !1
					});
					i.paths.length > 0 && this.lazyArchiveInodes.set(e, r);
				}
			}
			r.entries = a, r.materialized = !Array.from(a.values()).some((e) => !e.isSymlink && !e.materialized) && !s && (void 0 === i || i.committed);
		}
	}
	validatePendingLazyTreeNamespaceState(e) {
		const t = /* @__PURE__ */ new Map();
		for (const r of e.values()) for (const e of r.paths) {
			if (t.has(e)) throw new Error(`SharedFS namespace identity is ambiguous at ${e}`);
			t.set(e, r);
		}
		for (const r of this.lazyArchiveGroups) {
			const e = this.lazyAtomicGroupByTree.get(r), i = this.sealedLazyAtomicStates.get(r)?.snapshot;
			if (e?.committed || void 0 === i && r.materialized || void 0 === i && (void 0 === r.content || void 0 === r.inventory)) continue;
			const n = i?.inventory ?? r.inventory, s = void 0 === i ? r.entries : new Map(i.entries.map((e) => [e.vfsPath, e])), o = /* @__PURE__ */ new Map(), a = /* @__PURE__ */ new Map(), c = /* @__PURE__ */ new Set();
			for (const t of s.values()) t.deleted && void 0 !== t.inodeGroup && c.add(t.inodeGroup);
			for (const t of n) {
				if ("file" !== t.type && "hardlink" !== t.type) continue;
				o.set(t.inodeGroup, (o.get(t.inodeGroup) ?? 0) + 1);
				const e = a.get(t.inodeGroup) ?? [];
				e.push(t.vfsPath), a.set(t.inodeGroup, e);
			}
			const l = new Set([...c].filter((e) => a.get(e)?.every((e) => !t.has(e))));
			for (const r of n) {
				const e = t.get(r.vfsPath);
				if (void 0 === e) {
					if (void 0 !== r.inodeGroup && l.has(r.inodeGroup)) continue;
					throw new Error(`Lazy tree namespace entry ${r.vfsPath} is missing from the captured filesystem state`);
				}
				const i = "directory" === r.type ? Zo : "symlink" === r.type ? Jo : Yo;
				if ((e.mode & Xo) !== i || (4095 & e.mode) !== r.mode) throw new Error(`Lazy tree namespace entry ${r.vfsPath} disagrees with its captured type or mode`);
				if ("directory" === r.type) continue;
				const n = s.get(r.vfsPath);
				if (void 0 === n || n.ino !== e.ino || n.generation !== e.generation || n.dataSequence !== e.dataSequence) throw new Error(`Lazy tree namespace entry ${r.vfsPath} changed identity before serialization`);
				if ("symlink" === r.type) {
					const t = new TextEncoder().encode(r.target).byteLength;
					if (1 !== e.linkCount || e.size !== r.size || e.size !== t || e.symlinkTarget !== r.target) throw new Error(`Lazy tree symlink ${r.vfsPath} disagrees with its captured inventory`);
					continue;
				}
				if (0 !== e.size || e.linkCount !== o.get(r.inodeGroup)) throw new Error(`Lazy tree stub ${r.vfsPath} has changed data or undeclared aliases`);
			}
		}
	}
	lazyFileForStat(t) {
		const r = e.inodeKey(t.ino, t.generation), i = this.lazyFiles.get(r);
		if (!i || i.dataSequence === t.dataSequence) return i;
		this.lazyFiles.delete(r);
	}
	lazyArchiveEntriesForRead(e) {
		const t = this.lazyAtomicGroupByTree.get(e), r = this.sealedLazyAtomicStates.get(e);
		return void 0 === r || t?.committed ? Array.from(e.entries, ([e, t]) => ({
			vfsPath: e,
			...t
		})) : r.snapshot.entries;
	}
	lazyArchiveForStat(t) {
		const r = e.inodeKey(t.ino, t.generation), i = this.lazyArchiveInodes.get(r);
		if (!i) return;
		const n = this.lazyArchiveEntriesForRead(i).filter((e) => e.ino === t.ino && e.generation === t.generation && !e.deleted && !e.materialized);
		if (n.some((e) => e.dataSequence === t.dataSequence)) return i;
		if (this.lazyArchiveInodes.delete(r), void 0 === this.sealedLazyAtomicStates.get(i)) for (const e of n) e.materialized = !0;
	}
	lazyBackingForStat(t) {
		const r = e.inodeKey(t.ino, t.generation), i = this.lazyFiles.get(r);
		if (i) return {
			token: i,
			path: i.path
		};
		const n = this.lazyArchiveInodes.get(r);
		if (!n) return null;
		const s = this.lazyArchiveEntriesForRead(n).find((e) => e.ino === t.ino && e.generation === t.generation && !e.deleted && !e.materialized)?.vfsPath;
		if (void 0 === s) return null;
		const o = this.lazyAtomicGroupByTree.get(n);
		return void 0 === o ? {
			token: n,
			path: s
		} : {
			token: o.token,
			path: s,
			atomicGroup: o
		};
	}
	lazyBackingForPath(e) {
		const t = this.lazyArchiveGroups.find((t) => {
			const r = this.lazyAtomicGroupByTree.get(t), i = this.sealedLazyAtomicStates.get(t)?.snapshot, n = void 0 === i ? !t.materialized : !r?.committed, s = i?.content ?? t.content, o = i?.inventory ?? t.inventory, a = i?.activation ?? t.activation, c = i?.entries ?? Array.from(t.entries.values());
			return n && void 0 !== s && void 0 !== o && void 0 !== a && c.every((e) => e.deleted || e.materialized || e.isSymlink) && a.roots.some((t) => "/" === t || e === t || e.startsWith(`${t}/`));
		});
		if (t) {
			const r = this.lazyAtomicGroupByTree.get(t);
			return {
				token: r?.token ?? t,
				path: e,
				directGroup: t,
				...void 0 === r ? {} : { atomicGroup: r }
			};
		}
		try {
			const t = this.fs.stat(e), r = this.lazyBackingForStat(t);
			return r ? {
				...r,
				path: e
			} : null;
		} catch {
			return null;
		}
	}
	startLazyPreparation(e) {
		const { path: t, token: r } = e, i = {
			status: "pending",
			promise: Promise.resolve(!1)
		};
		return i.promise = (e.atomicGroup ? this.ensureAtomicLazyGroupMaterialized(e.atomicGroup).then(() => !0) : e.directGroup ? this.ensureArchiveMaterialized(e.directGroup).then(() => !0) : this.materializePath(t)).then((e) => (i.status = "fulfilled", this.lazyPreparations.get(r) === i && this.lazyPreparations.delete(r), e), (e) => {
			throw i.status = "rejected", i.error = e, e;
		}), i.promise.catch(() => {}), this.lazyPreparations.set(r, i), i;
	}
	registerLazyAtomicGroupMembership(e, t = !1) {
		const r = e.activation?.atomicGroup;
		if (void 0 === r) return;
		const { id: i, member: n } = r;
		if (void 0 === e.content || void 0 === e.inventory || "first-use" !== e.activation?.mode) throw new Error(`Lazy atomic activation group ${i} accepts only typed first-use trees`);
		let s = this.lazyAtomicGroups.get(i);
		if (void 0 === s) s = {
			id: i,
			token: Object.freeze({ id: i }),
			groups: /* @__PURE__ */ new Map(),
			committed: !1
		}, this.lazyAtomicGroups.set(i, s);
		else if (s.committed) throw new Error(`Lazy atomic activation group ${i} is already materialized`);
		if (s.groups.has(n)) throw new Error(`Lazy atomic activation group ${i} duplicates member ${n}`);
		if (Qa(r)) {
			if (void 0 !== s.expectedCount && (s.expectedCount !== r.expectedCount || s.cohortSha256 !== r.cohortSha256)) throw new Error(`Lazy atomic activation group ${i} has inconsistent seals`);
			s.expectedCount = r.expectedCount, s.cohortSha256 = r.cohortSha256;
			const o = hc(e, i, n);
			this.sealedLazyAtomicStates.set(e, {
				snapshot: dc(o, r.descriptorSha256, r.expectedCount, r.cohortSha256),
				verified: t
			});
		} else if (void 0 !== s.expectedCount) throw new Error(`Lazy atomic activation group ${i} mixes sealed and unsealed members`);
		s.groups.set(n, e), this.lazyAtomicGroupByTree.set(e, s);
	}
	async sealLazyAtomicGroup(e, t) {
		const r = t.map((t) => Ja({
			id: e,
			member: t
		}).member).sort();
		if (0 === r.length || new Set(r).size !== r.length) throw new Error(`Lazy atomic activation group ${e} expected members are invalid`);
		const i = this.lazyAtomicGroups.get(e);
		if (void 0 === i || i.committed) throw new Error(`Lazy atomic activation group ${e} is not pending`);
		const n = [...i.groups.keys()].sort();
		if (JSON.stringify(n) !== JSON.stringify(r)) throw new Error(`Lazy atomic activation group ${e} members differ from its seal`);
		if (void 0 !== i.expectedCount) {
			if (i.expectedCount !== r.length || void 0 === i.cohortSha256) throw new Error(`Lazy atomic activation group ${e} has an invalid existing seal`);
			await this.ensureLazyAtomicGroupSealValidated(i, r.map((e) => i.groups.get(e)), !0);
			return;
		}
		const s = r.map((t) => hc(i.groups.get(t), e, t)), o = [];
		for (const c of s) o.push({
			member: c.member,
			descriptorSha256: await nc(c.descriptorBytes, `Lazy atomic member ${c.member}`),
			source: c
		});
		const a = await nc(oc(e, o), `Lazy atomic activation group ${e}`);
		for (const c of o) {
			const t = hc(i.groups.get(c.member), e, c.member);
			if (!fc(c.source, t)) throw new Error(`Lazy atomic activation member ${c.member} changed while sealing`);
		}
		for (const c of o) {
			const t = i.groups.get(c.member);
			t.activation.atomicGroup = {
				id: e,
				member: c.member,
				descriptorSha256: c.descriptorSha256,
				expectedCount: o.length,
				cohortSha256: a
			}, this.sealedLazyAtomicStates.set(t, {
				snapshot: dc(c.source, c.descriptorSha256, o.length, a),
				verified: !0
			});
		}
		i.expectedCount = o.length, i.cohortSha256 = a;
	}
	async verifyImportedLazyAtomicGroupSeals() {
		await this.validatePendingLazyAtomicGroupSeals(!0);
	}
	guardSynchronousLazyAccess(e) {
		const t = this.lazyBackingForPath(e);
		if (!t) return;
		let r = this.lazyPreparations.get(t.token);
		if ("fulfilled" === r?.status) {
			this.lazyPreparations.delete(t.token);
			const i = this.lazyBackingForPath(e);
			if (!i) return;
			r = this.lazyPreparations.get(i.token) ?? this.startLazyPreparation(i);
		} else {
			if ("rejected" === r?.status) {
				this.lazyPreparations.delete(t.token);
				const i = r.error instanceof Error ? r.error.message : String(r.error), n = /* @__PURE__ */ new Error(`EIO: lazy backing for ${e} failed: ${i}`);
				throw n.code = "EIO", n.cause = r.error, n;
			}
			r || (r = this.startLazyPreparation(t));
		}
		const i = /* @__PURE__ */ new Error(`EAGAIN: lazy backing for ${e} is being prepared`);
		throw i.code = "EAGAIN", i;
	}
	invalidateLazyData(t) {
		const r = e.inodeKey(t.ino, t.generation);
		this.lazyFiles.delete(r);
		const i = this.lazyArchiveInodes.get(r);
		if (i) {
			this.lazyArchiveInodes.delete(r);
			for (const e of i.entries.values()) e.ino === t.ino && e.generation === t.generation && (e.materialized = !0);
		}
	}
	rewriteLazyNamespacePaths(t, r, i) {
		const n = r.length > 1 ? r.replace(/\/+$/, "") : r, s = i.length > 1 ? i.replace(/\/+$/, "") : i, o = `${n}/`, a = `${s}/`, c = e.inodeKey(t.ino, t.generation), l = (t.mode & Xo) === Zo, h = (e) => e === n ? s : l && e.startsWith(o) ? a + e.slice(o.length) : e;
		for (const [e, d] of this.lazyFiles) (l || e === c) && (d.paths = new Set(Array.from(d.paths, h)), d.path = h(d.path));
		for (const d of this.lazyArchiveGroups) {
			const t = /* @__PURE__ */ new Map();
			for (const [r, i] of d.entries) {
				const n = void 0 === i.generation ? null : e.inodeKey(i.ino, i.generation);
				t.set(l || n === c ? h(r) : r, i);
			}
			d.entries = t, d.inventory && (d.inventory = d.inventory.map((e) => ({
				...e,
				vfsPath: h(e.vfsPath),
				..."hardlink" === e.type && void 0 !== e.target ? { target: h(e.target) } : {}
			}))), d.activation && (d.activation = {
				...d.activation,
				roots: d.activation.roots.map(h)
			});
		}
	}
	get sharedBuffer() {
		return this.fs.buffer;
	}
	static create(t, r) {
		return new e(ho.mkfs(t, r));
	}
	static fromExisting(t) {
		return new e(ho.mount(t));
	}
	rebaseToNewFileSystem(t) {
		if (!Number.isSafeInteger(t) || t <= 0) throw new Error(`Invalid MemoryFileSystem maxByteLength: ${t}`);
		const r = SharedArrayBuffer, { bytes: i, identities: n } = this.fs.snapshotState();
		this.reconcileLazyIdentityState(n);
		const s = this.serializeLazyEntries(), o = this.serializeValidatedLazyArchiveEntries(n), a = new r(i.byteLength);
		new Uint8Array(a).set(i);
		const c = new e(ho.mount(a, { restoreImage: !0 }), this.imageMetadata);
		c.importLazyEntries(s), c.importLazyArchiveEntriesInternal(o, !1, !0, "verified");
		const l = new r(Math.min(t, Math.max(i.byteLength, 16777216)), { maxByteLength: t }), h = e.create(l, t);
		h.setImageMetadata(this.imageMetadata);
		const d = new Set(s.flatMap((e) => e.paths ?? [e.path])), f = /* @__PURE__ */ new Set();
		for (const e of o) if (!e.materialized) for (const t of e.entries) t.deleted || t.isSymlink || f.add(t.vfsPath);
		return c.copyPathToFreshFileSystem("/", h, d, f, /* @__PURE__ */ new Map()), h.importLazyEntries(s.map((e) => {
			const t = h.fs.lstat(e.path);
			return {
				...e,
				ino: t.ino,
				generation: t.generation,
				dataSequence: t.dataSequence
			};
		})), h.importLazyArchiveEntriesInternal(o.map((e) => ({
			...e,
			entries: e.entries.map((e) => {
				if (e.deleted) return {
					...e,
					ino: 0,
					generation: void 0
				};
				const t = h.fs.lstat(e.vfsPath);
				return {
					...e,
					ino: t.ino,
					generation: t.generation,
					dataSequence: t.dataSequence
				};
			})
		})), !1, !0, "verified"), h;
	}
	getImageMetadata() {
		return null === (e = this.imageMetadata) ? null : { ...e };
		var e;
	}
	setImageMetadata(e) {
		this.imageMetadata = null === e ? null : va(e);
	}
	subscribeLazyDownloads(e) {
		return this.lazyDownloadListeners.add(e), () => this.lazyDownloadListeners.delete(e);
	}
	setLazyFetcher(e, t = {}) {
		this.lazyTransport = {
			fetcher: e,
			...void 0 === t.signal ? {} : { signal: t.signal }
		};
	}
	emitLazyDownload(e) {
		if (0 === this.lazyDownloadListeners.size) return;
		const t = {
			...e,
			t: "undefined" != typeof performance ? performance.now() : Date.now()
		};
		for (const r of this.lazyDownloadListeners) try {
			r(t);
		} catch {}
	}
	async fetchLazyBytes(e, t) {
		let r = 0, i = e.integrity?.bytes ?? e.fallbackTotalBytes;
		const n = {
			id: e.id,
			kind: e.kind,
			url: e.url,
			path: e.path,
			mountPrefix: e.mountPrefix
		};
		for (let a = 0; a < 3; a += 1) {
			r = 0, this.emitLazyDownload({
				...n,
				status: "started",
				loadedBytes: r,
				totalBytes: i
			});
			try {
				Ua(t.signal);
				const o = void 0 === t.signal ? await t.fetcher(e.url) : await t.fetcher(e.url, { signal: t.signal });
				if (t.signal?.aborted) throw await Ha(o, t.signal.reason), t.signal.reason;
				if (!o.ok) {
					const e = new _a(o.status, xa(o.headers));
					throw await Ha(o, e), e;
				}
				if (i = Ca(o.headers) ?? i, e.integrity && void 0 !== i && i !== e.integrity.bytes) {
					const t = /* @__PURE__ */ new Error(`Lazy ${e.kind} byte count ${i} does not match expected ${e.integrity.bytes}`);
					throw await Ha(o, t), t;
				}
				if (!o.body) {
					const s = new Uint8Array(await o.arrayBuffer());
					return Ua(t.signal), r = s.byteLength, await sc(s, e.kind, e.integrity), Ua(t.signal), this.emitLazyDownload({
						...n,
						status: "progress",
						loadedBytes: r,
						totalBytes: i ?? r
					}), this.emitLazyDownload({
						...n,
						status: "complete",
						loadedBytes: r,
						totalBytes: i ?? r
					}), s;
				}
				const a = o.body.getReader(), c = [];
				try {
					try {
						for (;;) {
							const { done: s, value: o } = await a.read();
							if (Ua(t.signal), s) break;
							if (o) {
								if (c.push(o), r += o.byteLength, e.integrity && r > e.integrity.bytes) throw new Error(`Lazy ${e.kind} exceeded expected byte count ${e.integrity.bytes}`);
								this.emitLazyDownload({
									...n,
									status: "progress",
									loadedBytes: r,
									totalBytes: i
								});
							}
						}
					} catch (s) {
						try {
							await a.cancel(s);
						} catch {}
						throw s;
					}
				} finally {
					a.releaseLock();
				}
				const l = $a(c, r);
				return Ua(t.signal), await sc(l, e.kind, e.integrity), Ua(t.signal), this.emitLazyDownload({
					...n,
					status: "complete",
					loadedBytes: r,
					totalBytes: i ?? r
				}), l;
			} catch (ys) {
				if (t.signal?.aborted) {
					const e = t.signal.reason, s = e instanceof Error ? e.message : String(e);
					throw this.emitLazyDownload({
						...n,
						status: "error",
						loadedBytes: r,
						totalBytes: i,
						error: s
					}), e;
				}
				const s = a + 1 < 3 ? Ra(ys, a) : null;
				if (null !== s) {
					try {
						await Fa(s, t.signal);
					} catch (o) {
						const e = t.signal?.aborted ? t.signal.reason : o, s = e instanceof Error ? e.message : String(e);
						throw this.emitLazyDownload({
							...n,
							status: "error",
							loadedBytes: r,
							totalBytes: i,
							error: s
						}), e;
					}
					continue;
				}
				const c = ys instanceof Error ? ys.message : String(ys);
				throw this.emitLazyDownload({
					...n,
					status: "error",
					loadedBytes: r,
					totalBytes: i,
					error: c
				}), ys;
			}
		}
		throw new Error("Lazy transport retry state became unreachable");
	}
	registerLazyFile(t, r, i, n = 493) {
		const s = t.split("/").filter(Boolean);
		let o = "";
		for (let e = 0; e < s.length - 1; e++) {
			o += "/" + s[e];
			try {
				this.fs.mkdir(o, 493);
			} catch {}
		}
		const a = this.fs.createLazyStub(t, n);
		return this.invalidateLazyData(a), this.lazyFiles.set(e.inodeKey(a.ino, a.generation), {
			ino: a.ino,
			generation: a.generation,
			dataSequence: a.dataSequence,
			path: t,
			paths: new Set([t]),
			url: r,
			size: i
		}), a.ino;
	}
	importLazyEntries(e) {
		this.importLazyEntriesInternal(e, !1);
	}
	importLazyEntriesInternal(t, r) {
		for (const i of t) {
			if ((void 0 === i.generation || void 0 === i.dataSequence) && !r) throw new Error("Live lazy-file metadata requires inode generation and data sequence");
			const t = /* @__PURE__ */ new Set();
			let n = null;
			for (const r of new Set([i.path, ...i.paths ?? []])) {
				let s;
				try {
					s = this.fs.stat(r);
				} catch {
					continue;
				}
				if (s.ino === i.ino && (void 0 === i.generation || s.generation === i.generation)) {
					if (void 0 === i.dataSequence) {
						if (!e.canAdoptLegacyLazyStub(s)) continue;
					} else if (s.dataSequence !== i.dataSequence) continue;
					n ??= s, t.add(r);
				}
			}
			if (!n || 0 === t.size) continue;
			const s = t.has(i.path) ? i.path : t.values().next().value;
			this.lazyFiles.set(e.inodeKey(n.ino, n.generation), {
				ino: n.ino,
				generation: n.generation,
				dataSequence: n.dataSequence,
				path: s,
				paths: t,
				url: i.url,
				size: i.size
			});
		}
	}
	serializeLazyEntries() {
		const e = [];
		for (const { ino: t, generation: r, dataSequence: i, path: n, paths: s, url: o, size: a } of this.lazyFiles.values()) e.push({
			ino: t,
			generation: r,
			dataSequence: i,
			path: n,
			paths: Array.from(s),
			url: o,
			size: a
		});
		return e;
	}
	exportLazyEntries() {
		return this.reconcileLazyIdentityState(this.fs.identityState()), this.serializeLazyEntries();
	}
	getLazyEntry(e) {
		try {
			const t = this.fs.stat(e), r = this.lazyFileForStat(t);
			return r ? {
				ino: t.ino,
				generation: t.generation,
				dataSequence: t.dataSequence,
				path: r.path,
				paths: Array.from(r.paths),
				url: r.url,
				size: r.size
			} : null;
		} catch {
			return null;
		}
	}
	isPathDeferred(e) {
		return null !== this.lazyBackingForPath(e);
	}
	rewriteLazyFileUrls(e) {
		for (const t of this.lazyFiles.values()) t.url = e(t.url, t.path);
	}
	registerLazyTree(e, t, r = "/", i, n) {
		return this.registerLazyTreeInternal(e, t, r, i, !1, n);
	}
	registerLazyTreeInternal(t, r, i, n, s, o) {
		this.assertCanRegisterPendingLazyArchiveGroup();
		const a = ka(i), { content: c, entries: l, mountPrefix: h, activation: d, canonicalByGroup: f } = ec(t, r, a, n ?? {
			mode: "first-use",
			capabilities: ["deferred-tree"],
			roots: [a]
		}, s ? 0 : 1), u = void 0 === o ? void 0 : function(e) {
			const t = Da(e, ["uid", "gid"], "Lazy tree registration owner");
			return {
				uid: Va(t.uid, "Lazy tree registration owner uid", 0, pa),
				gid: Va(t.gid, "Lazy tree registration owner gid", 0, pa)
			};
		}(o), p = void 0 === d.atomicGroup ? void 0 : this.lazyAtomicGroups.get(d.atomicGroup.id);
		if (p?.committed || void 0 !== p && (void 0 !== p.expectedCount || p.groups.has(d.atomicGroup.member))) throw new Error(`Lazy atomic activation group ${d.atomicGroup?.id} cannot accept this member`);
		const m = {
			content: c,
			url: c.transports[0] ?? "",
			mountPrefix: h,
			integrity: {
				sha256: c.sha256,
				bytes: c.bytes
			},
			materialized: !1,
			inventory: l.map((e) => ({ ...e })),
			activation: d,
			entries: /* @__PURE__ */ new Map()
		}, g = (e) => {
			const t = e.split("/").filter(Boolean);
			let r = "";
			for (let i = 0; i < t.length - 1; i++) {
				r += `/${t[i]}`;
				try {
					this.fs.mkdir(r, 493);
				} catch {
					if ((this.fs.lstat(r).mode & Xo) !== Zo) throw new Error(`Lazy tree ancestor ${r} is not a directory`);
				}
			}
		};
		for (const e of [...l].sort((e, t) => e.vfsPath.split("/").length - t.vfsPath.split("/").length)) if ("directory" === e.type) {
			g(e.vfsPath);
			try {
				this.fs.mkdir(e.vfsPath, e.mode), this.fs.chmod(e.vfsPath, e.mode);
			} catch {
				if ((this.fs.lstat(e.vfsPath).mode & Xo) !== Zo) throw new Error(`Lazy tree directory collides at ${e.vfsPath}`);
			}
		}
		for (const e of l) {
			if ("symlink" !== e.type) continue;
			g(e.vfsPath), this.fs.symlink(e.target, e.vfsPath);
			const t = this.fs.lstat(e.vfsPath);
			m.entries.set(e.vfsPath, {
				ino: t.ino,
				generation: t.generation,
				dataSequence: t.dataSequence,
				size: e.size,
				isSymlink: !0,
				deleted: !1,
				materialized: !0,
				archivePath: e.sourcePath,
				sourcePath: e.sourcePath,
				type: "symlink",
				target: e.target
			});
		}
		const y = /* @__PURE__ */ new Map();
		for (const e of l) {
			if ("file" !== e.type) continue;
			g(e.vfsPath);
			const t = this.fs.createLazyStub(e.vfsPath, e.mode);
			this.invalidateLazyData(t), y.set(e.inodeGroup, t);
			const r = {
				ino: t.ino,
				generation: t.generation,
				dataSequence: t.dataSequence,
				size: e.size,
				isSymlink: !1,
				deleted: !1,
				materialized: !1,
				archivePath: e.sourcePath,
				sourcePath: e.sourcePath,
				type: "file",
				inodeGroup: e.inodeGroup
			};
			m.entries.set(e.vfsPath, r);
		}
		for (const e of l) {
			if ("hardlink" !== e.type) continue;
			const t = f.get(e.inodeGroup);
			g(e.vfsPath), this.fs.link(t.vfsPath, e.vfsPath);
			const r = this.fs.lstat(e.vfsPath), i = y.get(e.inodeGroup);
			if (r.ino !== i.ino || r.generation !== i.generation) throw new Error(`Lazy tree hardlink ${e.vfsPath} did not share its inode`);
			m.entries.set(e.vfsPath, {
				ino: r.ino,
				generation: r.generation,
				dataSequence: r.dataSequence,
				size: e.size,
				isSymlink: !1,
				deleted: !1,
				materialized: !1,
				archivePath: t.sourcePath,
				sourcePath: e.sourcePath,
				type: "hardlink",
				inodeGroup: e.inodeGroup,
				target: e.target
			});
		}
		if (void 0 !== u) for (const e of l) this.lchown(e.vfsPath, u.uid, u.gid);
		for (const w of m.entries.values()) w.isSymlink || void 0 === w.generation || this.lazyArchiveInodes.set(e.inodeKey(w.ino, w.generation), m);
		return this.lazyArchiveGroups.push(m), this.registerLazyAtomicGroupMembership(m), m;
	}
	registerLazyTreeWithMaterializationHandle(e, t, r = "/", i, n) {
		const s = this.registerLazyTreeInternal(e, t, r, i, !0, n), o = Object.freeze({ [Do]: !0 });
		return this.deferredTreeMaterializationHandles.set(o, s), o;
	}
	registerLazyArchiveFromEntries(t, r, i, n, s) {
		const o = ka(i), a = function(e, t, r, i) {
			const n = ka(r), s = /* @__PURE__ */ new Map(), o = t.map((t) => {
				const r = t.fileName, o = `Lazy archive ${JSON.stringify(e)} member ${JSON.stringify(r)}`;
				if (0 === r.length) throw new Error(`${o} has an empty path`);
				if (r.includes("\0")) throw new Error(`${o} contains a NUL byte`);
				if (r.includes("\\")) throw new Error(`${o} contains a backslash`);
				if (r.startsWith("/") || /^[A-Za-z]:\//.test(r)) throw new Error(`${o} must be relative, not absolute`);
				if (t.isDirectory && t.isSymlink) throw new Error(`${o} has conflicting directory and symlink types`);
				if (t.isDirectory !== r.endsWith("/")) throw new Error(`${o} has inconsistent directory metadata`);
				const a = t.isDirectory ? r.slice(0, -1) : r, c = a.split("/");
				if (0 === a.length || c.some((e) => "" === e || "." === e || ".." === e)) throw new Error(`${o} is not a canonical relative POSIX path`);
				if (s.has(a)) throw new Error(`${o} collides with another member at ${JSON.stringify(a)}`);
				if (t.isSymlink && !i?.has(r)) throw new Error(`Lazy archive symlink target was not provided: ${r}`);
				return s.set(a, t), {
					entry: t,
					archivePath: a,
					vfsPath: "/" === n ? `/${a}` : `${n}/${a}`
				};
			});
			for (const { archivePath: a } of o) {
				const e = a.split("/");
				for (let t = 1; t < e.length; t++) {
					const r = e.slice(0, t).join("/"), i = s.get(r);
					if (i && !i.isDirectory) throw new Error(`Lazy archive member ${JSON.stringify(a)} descends through non-directory ${JSON.stringify(r)}`);
				}
			}
			return o;
		}(t, r, o, n);
		a.some(({ entry: e }) => !e.isDirectory && !e.isSymlink) && this.assertCanRegisterPendingLazyArchiveGroup();
		const c = {
			...s ? { content: qa({
				decoder: "zip-v1",
				mediaType: "application/zip",
				sha256: s.sha256,
				bytes: s.bytes,
				expandedBytes: a.reduce((e, t) => e + t.entry.uncompressedSize, 0),
				sourceEntryCount: a.length,
				transports: [t]
			}) } : {},
			url: t,
			mountPrefix: o,
			integrity: Wa(s),
			materialized: !1,
			entries: /* @__PURE__ */ new Map()
		};
		for (const { entry: l, vfsPath: h } of a) {
			if (l.isDirectory) continue;
			const t = h.split("/").filter(Boolean);
			let r = "";
			for (let e = 0; e < t.length - 1; e++) {
				r += "/" + t[e];
				try {
					this.fs.mkdir(r, 493);
				} catch {}
			}
			if (l.isSymlink) {
				const e = n.get(l.fileName);
				this.fs.symlink(e, h);
				const t = this.fs.lstat(h), r = {
					ino: t.ino,
					generation: t.generation,
					dataSequence: t.dataSequence,
					size: l.uncompressedSize,
					isSymlink: !0,
					deleted: !1,
					materialized: !0,
					archivePath: l.fileName,
					sourcePath: l.fileName,
					type: "symlink"
				};
				c.entries.set(h, r);
			} else {
				const t = this.fs.createLazyStub(h, l.mode);
				this.invalidateLazyData(t);
				const r = {
					ino: t.ino,
					generation: t.generation,
					dataSequence: t.dataSequence,
					size: l.uncompressedSize,
					isSymlink: !1,
					deleted: !1,
					materialized: !1,
					archivePath: l.fileName,
					sourcePath: l.fileName,
					type: "file",
					inodeGroup: l.fileName
				};
				c.entries.set(h, r), this.lazyArchiveInodes.set(e.inodeKey(t.ino, t.generation), c);
			}
		}
		return c.materialized = Array.from(c.entries.values()).every((e) => e.deleted || e.materialized), this.lazyArchiveGroups.push(c), c;
	}
	importLazyArchiveEntries(e) {
		this.importLazyArchiveEntriesInternal(e, !1, !0, "reject");
	}
	async importVerifiedLazyArchiveEntries(t) {
		const r = structuredClone(t), i = this.exportLazyArchiveEntries(), n = e.fromExisting(this.sharedBuffer);
		n.importLazyArchiveEntriesInternal([...i, ...r], !1, !0, "pending"), await n.verifyImportedLazyAtomicGroupSeals(), this.importLazyArchiveEntriesInternal(r, !1, !0, "verified");
	}
	importLazyArchiveEntriesInternal(t, r, i, n) {
		const s = Na(t, "Serialized lazy archive groups", 0, aa).map((e, t) => {
			if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error(`Serialized lazy archive group ${t} must be an object`);
			const r = e.kind;
			if (r === ya || r === wa || r === ba) return ic(e, r);
			if (r === ga) return rc(e, !1);
			if (void 0 !== r) throw new Error(`Serialized lazy archive group ${t} has an unsupported kind`);
			if (i) throw new Error(`Serialized lazy archive group ${t} is missing its kind discriminator`);
			return rc(e, !0);
		}), o = this.fs.identityState();
		this.reconcileLazyIdentityState(o), Xa([...this.serializeValidatedLazyArchiveEntries(o), ...s]);
		const a = [], c = /* @__PURE__ */ new Map();
		for (const l of s) {
			const t = /* @__PURE__ */ new Map(), i = l.mountPrefix.replace(/\/+$/, ""), n = void 0 !== l.content && void 0 !== l.inventory && void 0 !== l.activation, s = n ? new Map(l.inventory.map((e) => [e.vfsPath, e])) : null, o = n ? new Map(l.inventory.map((e) => [tc(e), e])) : null, h = /* @__PURE__ */ new Map(), d = /* @__PURE__ */ new Map(), f = /* @__PURE__ */ new Map();
			for (const a of l.entries) {
				let c = null;
				const u = l.materialized || !0 === a.materialized || a.isSymlink;
				if (!a.deleted && !u) {
					if ((void 0 === a.generation || void 0 === a.dataSequence) && !r) throw new Error("Live lazy-archive metadata requires inode generation and data sequence");
					try {
						c = this.fs.lstat(a.vfsPath);
					} catch {
						if (n) throw new Error(`Serialized lazy tree stub ${a.vfsPath} is missing from the filesystem`);
						continue;
					}
					if (c.ino !== a.ino) {
						if (n) throw new Error(`Serialized lazy tree stub ${a.vfsPath} has a different inode`);
						continue;
					}
					if (void 0 !== a.generation && c.generation !== a.generation) {
						if (n) throw new Error(`Serialized lazy tree stub ${a.vfsPath} has a different generation`);
						continue;
					}
					if (void 0 === a.dataSequence) {
						if (!e.canAdoptLegacyLazyStub(c)) {
							if (n) throw new Error(`Serialized lazy tree stub ${a.vfsPath} is not pristine`);
							continue;
						}
					} else if (c.dataSequence !== a.dataSequence) {
						if (n) throw new Error(`Serialized lazy tree stub ${a.vfsPath} has a different data sequence`);
						continue;
					}
					if (n) {
						f.set(a.vfsPath, c);
						const t = s.get(a.vfsPath), r = o.get(tc(a)) ?? t;
						if (!r || (c.mode & Xo) !== Yo || 0 !== c.size || (4095 & c.mode) !== r.mode || void 0 !== t?.inodeGroup && t.inodeGroup !== r.inodeGroup) throw new Error(`Serialized lazy tree stub ${a.vfsPath} disagrees with its inventory`);
						const i = e.inodeKey(c.ino, c.generation), n = a.inodeGroup, l = h.get(n), u = d.get(i);
						if (void 0 !== l && l !== i || void 0 !== u && u !== n) throw new Error(`Serialized lazy tree inode group ${n} disagrees with the filesystem`);
						h.set(n, i), d.set(i, n);
					}
				}
				t.set(a.vfsPath, {
					ino: a.ino,
					generation: c?.generation ?? a.generation,
					dataSequence: c?.dataSequence ?? a.dataSequence,
					size: a.size,
					isSymlink: a.isSymlink,
					deleted: a.deleted,
					materialized: u,
					archivePath: a.archivePath ?? a.vfsPath.slice(i.length + 1),
					sourcePath: a.sourcePath ?? a.archivePath ?? a.vfsPath.slice(i.length + 1),
					type: a.type ?? (a.isSymlink ? "symlink" : "file"),
					inodeGroup: a.inodeGroup,
					target: a.target
				});
			}
			if (n) {
				const e = /* @__PURE__ */ new Map();
				for (const r of l.inventory) {
					if ("file" === r.type || "hardlink" === r.type) {
						e.set(r.inodeGroup, (e.get(r.inodeGroup) ?? 0) + 1);
						continue;
					}
					let i;
					try {
						i = this.fs.lstat(r.vfsPath);
					} catch {
						throw new Error(`Serialized lazy tree namespace entry ${r.vfsPath} is missing from the filesystem`);
					}
					const n = "directory" === r.type ? Zo : Jo;
					if ((i.mode & Xo) !== n || (4095 & i.mode) !== r.mode || "symlink" === r.type && (i.size !== new TextEncoder().encode(r.target).byteLength || this.fs.readlink(r.vfsPath) !== r.target)) throw new Error(`Serialized lazy tree namespace entry ${r.vfsPath} disagrees with its inventory`);
					"symlink" === r.type && t.set(r.vfsPath, {
						ino: i.ino,
						generation: i.generation,
						dataSequence: i.dataSequence,
						size: r.size,
						isSymlink: !0,
						deleted: !1,
						materialized: !0,
						archivePath: r.sourcePath,
						sourcePath: r.sourcePath,
						type: "symlink",
						target: r.target
					});
				}
				if (void 0 !== l.activation?.atomicGroup) {
					for (const t of l.inventory) if (("file" === t.type || "hardlink" === t.type) && f.get(t.vfsPath).linkCount !== e.get(t.inodeGroup)) throw new Error(`Serialized lazy atomic tree inode group ${t.inodeGroup} has undeclared aliases`);
				}
			}
			const u = void 0 === l.content ? void 0 : qa(l.content), p = {
				content: u,
				url: u?.transports[0] ?? l.url,
				mountPrefix: l.mountPrefix,
				integrity: u ? {
					sha256: u.sha256,
					bytes: u.bytes
				} : Wa(l.integrity),
				materialized: l.materialized || !(u && l.inventory) && Array.from(t.values()).every((e) => e.deleted || e.materialized),
				inventory: l.inventory?.map((e) => ({ ...e })),
				activation: l.activation ? {
					mode: l.activation.mode,
					capabilities: [...l.activation.capabilities],
					roots: [...l.activation.roots],
					...void 0 === l.activation.atomicGroup ? {} : { atomicGroup: { ...l.activation.atomicGroup } }
				} : void 0,
				entries: t
			};
			if (a.push(p), !p.materialized) {
				for (const [, r] of t) if (!r.deleted && !r.materialized && void 0 !== r.generation) {
					const t = e.inodeKey(r.ino, r.generation), i = c.get(t);
					if (void 0 !== i && i !== p) throw new Error(`Serialized lazy archive groups share pending inode ${t}`);
					if (this.lazyArchiveInodes.has(t)) throw new Error(`Serialized lazy archive group collides with pending inode ${t}`);
					c.set(t, p);
				}
			}
		}
		for (const e of a) {
			const t = e.activation?.atomicGroup;
			if (void 0 !== t && this.lazyAtomicGroups.get(t.id)?.committed) throw new Error(`Lazy atomic activation group ${t.id} is already materialized`);
		}
		if ("reject" === n && a.some((e) => {
			const t = e.activation?.atomicGroup;
			return void 0 !== t && Qa(t);
		})) throw new Error("Sealed lazy archive registrations require importVerifiedLazyArchiveEntries()");
		this.lazyArchiveGroups.push(...a);
		for (const e of a) this.registerLazyAtomicGroupMembership(e, "verified" === n);
		for (const [e, l] of c) this.lazyArchiveInodes.set(e, l);
	}
	rewriteLazyArchiveUrls(e) {
		for (const t of this.lazyArchiveGroups) {
			const r = this.lazyAtomicGroupByTree.get(t), i = this.sealedLazyAtomicStates.get(t);
			if (void 0 !== i && !r?.committed) {
				this.assertLazyAtomicSnapshotMatchesPublic(t);
				const r = uc(i.snapshot, e);
				t.content = cc(r.content), t.url = r.url, t.integrity = { ...r.integrity }, i.snapshot = r;
				continue;
			}
			t.content ? (t.content = {
				...t.content,
				transports: t.content.transports.map(e)
			}, t.url = t.content.transports[0]) : t.url = e(t.url);
		}
	}
	serializeLazyArchiveEntries() {
		const e = [];
		for (const t of this.lazyArchiveGroups) {
			const r = this.lazyAtomicGroupByTree.get(t), i = this.sealedLazyAtomicStates.get(t);
			if (void 0 !== i) {
				if (r?.committed) continue;
				const t = i.snapshot;
				if (0 === t.content.transports.length) throw new Error("Direct-materialization tree must be materialized before serialization");
				e.push({
					kind: ba,
					content: cc(t.content),
					inventory: t.inventory.map((e) => ({ ...e })),
					activation: lc(t),
					url: t.url,
					mountPrefix: t.mountPrefix,
					integrity: { ...t.integrity },
					materialized: !1,
					entries: t.entries.filter((e) => !e.deleted && !e.materialized).map(({ vfsPath: e, ...t }) => ({
						vfsPath: e,
						...t
					}))
				});
				continue;
			}
			const n = Array.from(t.entries, ([e, t]) => ({
				vfsPath: e,
				ino: t.ino,
				generation: t.generation,
				dataSequence: t.dataSequence,
				size: t.size,
				isSymlink: t.isSymlink,
				deleted: t.deleted,
				materialized: t.materialized,
				archivePath: t.archivePath,
				sourcePath: t.sourcePath,
				type: t.type,
				inodeGroup: t.inodeGroup,
				target: t.target
			})).filter((e) => !e.deleted && !e.materialized);
			if (0 === n.length && (!t.content || !t.inventory || t.materialized)) continue;
			const s = void 0 !== t.content && void 0 !== t.inventory && void 0 !== t.activation;
			if (s && 0 === t.content.transports.length) throw new Error("Direct-materialization tree must be materialized before serialization");
			const o = t.activation?.atomicGroup;
			if (void 0 !== o && !Qa(o)) throw new Error(`Lazy atomic activation group ${o.id} must be sealed before serialization`);
			e.push(s ? {
				kind: void 0 !== o ? ba : void 0 === t.content.source ? ya : wa,
				content: t.content,
				inventory: t.inventory,
				activation: t.activation,
				url: t.url,
				mountPrefix: t.mountPrefix,
				integrity: t.integrity,
				materialized: !1,
				entries: n
			} : {
				kind: ga,
				url: t.url,
				mountPrefix: t.mountPrefix,
				integrity: t.integrity,
				materialized: !1,
				entries: n
			});
		}
		return e;
	}
	serializeValidatedLazyArchiveEntries(e) {
		this.assertPendingLazyAtomicSnapshotsReadyForSerialization();
		const t = this.serializeLazyArchiveEntries();
		return Xa(t), this.validatePendingLazyTreeNamespaceState(e), t;
	}
	exportLazyArchiveEntries() {
		const e = this.fs.identityState();
		return this.reconcileLazyIdentityState(e), this.serializeValidatedLazyArchiveEntries(e);
	}
	pendingDeferredTreeUsage() {
		const e = this.fs.identityState();
		return this.reconcileLazyIdentityState(e), Ga(this.serializeValidatedLazyArchiveEntries(e));
	}
	assertCanAppendDeferredTreeUsage(e) {
		ja(e);
		const t = this.pendingDeferredTreeUsage();
		ja({
			groups: t.groups + e.groups,
			archiveBytes: t.archiveBytes + e.archiveBytes,
			expandedBytes: t.expandedBytes + e.expandedBytes,
			payloadBytes: t.payloadBytes + e.payloadBytes,
			entries: t.entries + e.entries
		});
	}
	assertCanRegisterPendingLazyArchiveGroup() {
		if (this.reconcileLazyIdentityState(this.fs.identityState()), this.lazyArchiveGroups.filter((e) => {
			const t = this.lazyAtomicGroupByTree.get(e);
			return void 0 !== this.sealedLazyAtomicStates.get(e)?.snapshot ? !t?.committed : !e.materialized && (void 0 !== e.content && void 0 !== e.inventory || Array.from(e.entries.values()).some((e) => !e.deleted && !e.materialized));
		}).length >= Eo) throw new Error(`Cannot register another lazy archive group: ${Eo} pending groups already exist`);
	}
	async preparePath(e) {
		let t = !1;
		const r = Math.max(3, this.lazyArchiveGroups.length + 1);
		for (let i = 0; i < r; i++) {
			const r = this.lazyBackingForPath(e);
			if (!r) return t;
			const i = this.lazyPreparations.get(r.token) ?? this.startLazyPreparation(r);
			try {
				t = await i.promise || t;
			} finally {
				this.lazyPreparations.get(r.token) === i && this.lazyPreparations.delete(r.token);
			}
		}
		if (this.lazyBackingForPath(e)) throw new Error(`Lazy backing kept changing identity while preparing: ${e}`);
		return t;
	}
	async prepareBootDeferredTrees() {
		const e = this.lazyArchiveGroups.filter((e) => !e.materialized && "boot-prefetch" === e.activation?.mode);
		let t, r = 0;
		const i = Array.from({ length: Math.min(e.length, 2) }, async () => {
			for (; void 0 === t;) {
				const n = r;
				if (r += 1, n >= e.length) return;
				try {
					await this.prepareLazyTreeGroup(e[n]);
				} catch (i) {
					t ??= i;
				}
			}
		});
		if (await Promise.all(i), void 0 !== t) throw t;
		return e.length;
	}
	async materializeRegisteredDeferredTree(e, t) {
		const r = this.deferredTreeMaterializationHandles.get(e);
		if (void 0 === r) throw new Error("Deferred-tree handle was not issued by this filesystem");
		const i = this.lazyAtomicGroupByTree.get(r);
		if (void 0 !== i) throw new Error(`Deferred tree belongs to atomic activation group ${i.id}; materialize the complete group instead`);
		if (r.materialized) return !1;
		const n = this.lazyPreparations.get(r);
		if (void 0 !== n) return n.promise;
		const s = new Uint8Array(t.byteLength);
		s.set(t);
		const o = {
			status: "pending",
			promise: Promise.resolve(!1)
		};
		o.promise = Promise.resolve().then(async () => (await sc(s, "tree", r.integrity), await this.materializeArchiveBytes(r, s), !0)).then((e) => (o.status = "fulfilled", e), (e) => {
			throw o.status = "rejected", o.error = e, e;
		}), o.promise.catch(() => {}), this.lazyPreparations.set(r, o);
		try {
			return await o.promise;
		} finally {
			this.lazyPreparations.get(r) === o && this.lazyPreparations.delete(r);
		}
	}
	async prepareLazyTreeGroup(e) {
		const t = this.lazyAtomicGroupByTree.get(e);
		if (t?.committed || void 0 === t && e.materialized) return !1;
		const r = this.sealedLazyAtomicStates.get(e)?.snapshot, i = {
			token: t?.token ?? e,
			path: r?.activation.roots[0] ?? e.activation?.roots[0] ?? e.mountPrefix,
			directGroup: e,
			...void 0 === t ? {} : { atomicGroup: t }
		}, n = this.lazyPreparations.get(i.token) ?? this.startLazyPreparation(i);
		try {
			return await n.promise;
		} finally {
			this.lazyPreparations.get(i.token) === n && this.lazyPreparations.delete(i.token);
		}
	}
	async ensureMaterialized(e) {
		return this.preparePath(e);
	}
	async materializePath(t) {
		if (0 === this.lazyFiles.size && 0 === this.lazyArchiveInodes.size) return !1;
		let r;
		try {
			r = this.fs.stat(t);
		} catch {
			return !1;
		}
		const i = e.inodeKey(r.ino, r.generation), n = this.lazyFiles.get(i);
		if (n) {
			const e = this.lazyTransport, s = await this.fetchLazyBytes({
				id: `file:${r.ino}`,
				kind: "file",
				url: n.url,
				path: n.path,
				fallbackTotalBytes: n.size
			}, e);
			for (let r = 0; r < 3; r++) {
				if (this.lazyFiles.get(i) !== n) return !1;
				for (const r of new Set([t, ...n.paths])) if (Ua(e.signal), this.fs.replaceIfIdentity(r, n.ino, n.generation, n.dataSequence, s)) return n.path = r, this.lazyFiles.delete(i), !0;
				this.reconcileLazyIdentityState(this.fs.identityState());
			}
			throw new Error(`Lazy file kept changing names while materializing: ${t}`);
		}
		const s = this.lazyArchiveInodes.get(i);
		return !!s && (await this.ensureArchiveMaterialized(s, {
			path: t,
			ino: r.ino,
			generation: r.generation
		}), !this.lazyArchiveInodes.has(i));
	}
	async decodeAndValidateLazyTree(e, t, r) {
		const i = r?.content ?? e.content, n = r?.inventory ?? e.inventory;
		if (!i || !n) throw new Error("Lazy tree is missing its decoder or complete inventory");
		const s = /* @__PURE__ */ new Map(), o = new Map(n.map((e) => [e.vfsPath, e]));
		if (void 0 !== i.source) for (const d of i.source.entries) s.set(d.sourcePath, d);
		else for (const d of n) {
			if ("hardlink" === d.type) {
				const e = o.get(d.target);
				if (!e) throw new Error(`Lazy tree hardlink target disappeared: ${d.target}`);
				if (d.sourcePath === e.sourcePath) continue;
			}
			if (s.get(d.sourcePath)) throw new Error(`Lazy tree inventory duplicates source member ${d.sourcePath}`);
			s.set(d.sourcePath, {
				sourcePath: d.sourcePath,
				type: d.type,
				mode: d.mode,
				size: d.size,
				..."symlink" === d.type ? { target: d.target } : {},
				..."hardlink" === d.type ? { target: o.get(d.target)?.sourcePath } : {}
			});
		}
		const a = /* @__PURE__ */ new Map();
		let c = 0;
		if ("zip-v1" === i.decoder) {
			const { parseZipCentralDirectory: e, extractZipEntryBounded: r } = await import("./zip-DJ-is7oS.js"), n = e(t);
			if (n.length !== i.sourceEntryCount || n.length !== s.size) throw new Error("Lazy ZIP tree decoded inventory counts differ from its descriptor");
			for (const o of n) {
				const e = o.isDirectory ? o.fileName.replace(/\/$/, "") : o.fileName;
				if (a.has(e)) throw new Error(`Lazy ZIP tree duplicates source member ${e}`);
				const n = s.get(e);
				if (!n) throw new Error(`Lazy ZIP tree has undeclared source member ${e}`);
				if (c += o.uncompressedSize, c > i.expandedBytes || o.uncompressedSize !== n.size) throw new Error(`Lazy ZIP tree member ${e} exceeds its inventory`);
				const l = o.isDirectory ? "directory" : o.isSymlink ? "symlink" : "file", h = "portable-posix-v1" === i.modePolicy ? "directory" === l ? 493 : "symlink" === l ? 511 : 73 & o.mode ? 493 : 420 : 4095 & o.mode;
				if (l !== n.type || h !== n.mode) throw new Error(`Lazy ZIP tree member ${e} differs from inventory`);
				if (o.isDirectory) a.set(e, {
					type: "directory",
					mode: h
				});
				else {
					const i = r(t, o, n.size);
					if (o.isSymlink) {
						let t;
						try {
							t = new TextDecoder("utf-8", { fatal: !0 }).decode(i);
						} catch {
							throw new Error(`Lazy ZIP tree symlink ${e} is not UTF-8`);
						}
						a.set(e, {
							type: "symlink",
							mode: h,
							target: t
						});
					} else a.set(e, {
						type: "file",
						mode: h,
						data: i
					});
				}
			}
		} else {
			const { parseTarGzip: e } = await import("./tar-XbPVG1Oa.js"), r = e(t, {
				label: `Lazy tree ${i.sha256}`,
				limits: {
					maxCompressedBytes: i.bytes,
					maxUncompressedBytes: i.expandedBytes,
					maxEntries: i.sourceEntryCount
				}
			});
			c = new DataView(t.buffer, t.byteOffset, t.byteLength).getUint32(t.byteLength - 4, !0);
			for (const t of r) {
				if (a.has(t.path)) throw new Error(`Lazy TAR tree duplicates source member ${t.path}`);
				"file" === t.type ? a.set(t.path, {
					type: "file",
					mode: t.mode,
					data: t.data
				}) : "directory" === t.type ? a.set(t.path, {
					type: "directory",
					mode: t.mode
				}) : a.set(t.path, {
					type: t.type,
					mode: t.mode,
					target: t.linkName
				});
			}
		}
		if (a.size !== i.sourceEntryCount || a.size !== s.size || c !== i.expandedBytes) throw new Error("Lazy tree decoded inventory counts differ from its descriptor");
		for (const [d, f] of s) {
			const e = a.get(d);
			if (!e) throw new Error(`Lazy tree is missing source member ${d}`);
			const t = f.type;
			if (e.type !== t) throw new Error(`Lazy tree member ${d} is ${e.type}, expected ${t}`);
			if ((4095 & e.mode) !== f.mode) throw new Error(`Lazy tree member ${d} mode differs from inventory`);
			if ("file" === t && e.data?.byteLength !== f.size) throw new Error(`Lazy tree member ${d} size differs from inventory`);
			if ("symlink" === t && e.target !== f.target) throw new Error(`Lazy tree symlink ${d} target differs from inventory`);
			if ("hardlink" === t && e.target !== f.target) throw new Error(`Lazy tree hardlink ${d} target differs from inventory`);
		}
		const l = new Set(n.flatMap((e) => "archive-homebrew-relocate" === e.materialization ? [e.sourcePath] : []));
		if (void 0 !== i.source) {
			const e = new Map(i.source.entries.map((e) => [e.sourcePath, e])), t = Ya(i.source.entries), r = i.source.entries.filter((e) => "INSTALL_RECEIPT.json" === e.sourcePath || e.sourcePath.endsWith("/INSTALL_RECEIPT.json"));
			if (r.length > 1) throw new Error(`Lazy Homebrew bottle has ${r.length} INSTALL_RECEIPT.json source members, expected at most one`);
			if (0 === r.length) {
				if (l.size > 0) throw new Error("Lazy Homebrew bottle marks receipt relocation without INSTALL_RECEIPT.json");
			} else {
				const i = r[0], n = "file" === i.type ? i : t.get(i.sourcePath), s = void 0 === n ? void 0 : a.get(n.sourcePath);
				if ("file" !== n?.type || "file" !== s?.type || void 0 === s.data) throw new Error("Lazy Homebrew bottle INSTALL_RECEIPT.json is not regular");
				const o = Uo(s.data), c = i.sourcePath.lastIndexOf("/"), h = c < 0 ? "" : i.sourcePath.slice(0, c), d = new Set(o.changedFiles.map((e) => 0 === h.length ? e : `${h}/${e}`));
				if (l.size !== d.size || [...l].some((e) => !d.has(e))) throw new Error("Lazy Homebrew bottle relocation markers differ from INSTALL_RECEIPT.json");
				const f = /* @__PURE__ */ new Set();
				for (const r of d) {
					const i = e.get(r), n = "file" === i?.type ? i : void 0 === i ? void 0 : t.get(i.sourcePath), s = void 0 === n ? void 0 : a.get(n.sourcePath);
					if ("file" !== n?.type || "file" !== s?.type || void 0 === s.data) throw new Error(`Lazy Homebrew bottle changed source ${r} is not regular`);
					f.has(n.sourcePath) || (s.data = Fo(s.data, o, r), f.add(n.sourcePath));
				}
			}
		} else if (l.size > 0) throw new Error("Lazy tree receipt relocation requires original-bottle source truth");
		const h = /* @__PURE__ */ new Map();
		for (const d of n) {
			if ("file" !== d.type) continue;
			if ("descriptor" === d.materialization) continue;
			const e = a.get(d.sourcePath);
			if ("file" !== e?.type || !e.data) throw new Error(`Lazy tree has no file content for ${d.sourcePath}`);
			h.set(d.sourcePath, e.data);
		}
		return h;
	}
	async ensureArchiveMaterialized(e, t) {
		const r = this.lazyAtomicGroupByTree.get(e);
		if (void 0 !== r) {
			if (r.committed) return;
			const t = this.sealedLazyAtomicStates.get(e)?.snapshot, i = this.lazyPreparations.get(r.token) ?? this.startLazyPreparation({
				token: r.token,
				path: t?.activation.roots[0] ?? e.activation?.roots[0] ?? e.mountPrefix,
				atomicGroup: r
			});
			try {
				await i.promise;
			} finally {
				this.lazyPreparations.get(r.token) === i && this.lazyPreparations.delete(r.token);
			}
			return;
		}
		if (e.materialized) return;
		const i = this.lazyTransport, n = await this.fetchLazyArchiveData(e, i);
		Ua(i.signal), await this.materializeArchiveBytes(e, n, t, i.signal);
	}
	async fetchLazyArchiveData(e, t, r) {
		const i = r?.content ?? e.content, n = r?.inventory ?? e.inventory, s = void 0 !== i && void 0 !== n, o = r?.mountPrefix ?? e.mountPrefix, a = r?.integrity ?? e.integrity, c = s ? i.transports : [r?.url ?? e.url], l = [];
		let h = null;
		for (const [f, u] of c.entries()) try {
			h = await this.fetchLazyBytes({
				id: `archive:${o}:${i?.sha256 ?? u}:${f}`,
				kind: s ? "tree" : "archive",
				url: u,
				mountPrefix: o,
				integrity: a
			}, t);
			break;
		} catch (d) {
			if (Ua(t.signal), Ba(d)) throw d;
			l.push(d instanceof Error ? d.message : String(d));
		}
		if (Ua(t.signal), null === h) throw new Error(`All ${c.length} lazy ${s ? "tree" : "archive"} transports failed: ${l.join("; ")}`);
		return h;
	}
	async materializeArchiveBytes(t, r, i, n) {
		if (Ua(n), t.materialized) return;
		const s = await this.prepareLazyArchiveContents(t, r, n), o = i ? e.inodeKey(i.ino, i.generation) : null;
		for (let e = 0; e < 3; e++) {
			const e = this.collectLazyArchiveReplacements(t, s, i);
			if (e.size > 0 && (Ua(n), !this.fs.replaceManyIfIdentities(Array.from(e.values(), pc)))) {
				if (this.reconcileLazyIdentityState(this.fs.identityState()), o && !this.lazyArchiveInodes.has(o)) return;
			} else {
				if (Ua(n), this.publishLazyArchiveReplacements(t, e), t.materialized) return;
				if (this.reconcileLazyIdentityState(this.fs.identityState()), o && !this.lazyArchiveInodes.has(o)) return;
			}
		}
		if (o && this.lazyArchiveInodes.has(o)) throw new Error(`Lazy archive member kept changing names while materializing: ${i?.path}`);
	}
	async prepareLazyArchiveContents(t, r, i, n) {
		Ua(i);
		const s = n?.content ?? t.content, o = n?.inventory ?? t.inventory, a = void 0 !== s && void 0 !== o ? await this.decodeAndValidateLazyTree(t, r, n) : null;
		Ua(i);
		const { parseZipCentralDirectory: c, extractZipEntry: l } = await import("./zip-DJ-is7oS.js");
		Ua(i);
		const h = a ? [] : c(r), d = /* @__PURE__ */ new Map();
		for (const e of h) {
			if (d.has(e.fileName)) throw new Error(`Lazy archive contains duplicate member: ${e.fileName}`);
			d.set(e.fileName, e);
		}
		const f = (n?.mountPrefix ?? t.mountPrefix).replace(/\/+$/, ""), u = /* @__PURE__ */ new Map(), p = void 0 === n ? Array.from(t.entries) : n.entries.map((e) => [e.vfsPath, e]);
		for (const [m, g] of p) {
			if (g.deleted || g.materialized) continue;
			const t = g.archivePath ?? m.slice(f.length + 1), i = a ? void 0 : d.get(t), n = a?.get(t);
			if (a) {
				if (void 0 === n || n.byteLength !== g.size) throw new Error(`Lazy tree member ${t} does not match its registered metadata`);
			} else if (void 0 === i || i.isDirectory || i.isSymlink || i.uncompressedSize !== g.size) throw new Error(`Lazy archive member ${t} does not match its registered metadata`);
			if (void 0 === g.generation) continue;
			const s = e.inodeKey(g.ino, g.generation), o = u.get(s);
			if (o && o.archivePath !== t) throw new Error(`Lazy archive aliases for inode ${s} name different members`);
			if (!o) {
				const e = n ?? l(r, i);
				if (e.byteLength !== g.size) throw new Error(`Lazy archive member ${t} extracted ${e.byteLength} bytes, expected ${g.size}`);
				u.set(s, {
					archivePath: t,
					content: e
				});
			}
		}
		return u;
	}
	collectLazyArchiveReplacements(t, r, i, n) {
		const s = /* @__PURE__ */ new Map(), o = void 0 === n ? Array.from(t.entries) : n.entries.map((e) => [e.vfsPath, e]);
		for (const [a, c] of o) {
			if (c.deleted || c.materialized || void 0 === c.generation) continue;
			const n = e.inodeKey(c.ino, c.generation);
			if (this.lazyArchiveInodes.get(n) !== t) continue;
			const o = r.get(n);
			if (!o) throw new Error(`Lazy archive has no extracted content for inode ${n}`);
			let l = s.get(n);
			l || (l = {
				ino: c.ino,
				generation: c.generation,
				dataSequence: c.dataSequence ?? 0,
				paths: /* @__PURE__ */ new Set(),
				content: o.content
			}, s.set(n, l)), l.paths.add(a), i && i.ino === c.ino && i.generation === c.generation && l.paths.add(i.path);
		}
		return s;
	}
	publishLazyArchiveReplacements(e, t) {
		for (const [r, i] of t) {
			this.lazyArchiveInodes.delete(r);
			for (const t of e.entries.values()) t.ino === i.ino && t.generation === i.generation && (t.materialized = !0);
		}
		e.materialized = Array.from(e.entries.values()).every((e) => e.deleted || e.materialized);
	}
	collectAtomicTreeNamespace(t, r) {
		const i = /* @__PURE__ */ new Set(), n = /* @__PURE__ */ new Map(), s = /* @__PURE__ */ new Map(), o = new Map(r.entries.map((e) => [e.vfsPath, e]));
		for (const e of r.inventory) "file" !== e.type && "hardlink" !== e.type || s.set(e.inodeGroup, (s.get(e.inodeGroup) ?? 0) + 1);
		const a = [];
		for (const c of r.inventory) {
			let r;
			try {
				r = this.fs.lstat(c.vfsPath);
			} catch {
				throw new Error(`Lazy atomic tree changed at ${c.vfsPath}`);
			}
			const l = "directory" === c.type ? Zo : "symlink" === c.type ? Jo : Yo;
			if ((r.mode & Xo) !== l || (4095 & r.mode) !== c.mode) throw new Error(`Lazy atomic tree changed at ${c.vfsPath}`);
			if ("symlink" === c.type) {
				const e = o.get(c.vfsPath);
				if (void 0 === e || !e.isSymlink || e.deleted || e.ino !== r.ino || e.generation !== r.generation || e.dataSequence !== r.dataSequence || this.fs.readlink(c.vfsPath) !== c.target) throw new Error(`Lazy atomic tree changed at ${c.vfsPath}`);
			} else if ("file" === c.type || "hardlink" === c.type) {
				const a = o.get(c.vfsPath);
				if (void 0 === a || a.deleted || a.materialized || a.isSymlink || void 0 === a.generation || a.inodeGroup !== c.inodeGroup || a.ino !== r.ino || a.generation !== r.generation || a.dataSequence !== r.dataSequence || 0 !== r.size || r.linkCount !== s.get(c.inodeGroup)) throw new Error(`Lazy atomic tree changed at ${c.vfsPath}`);
				const l = e.inodeKey(a.ino, a.generation);
				if (this.lazyArchiveInodes.get(l) !== t) throw new Error(`Lazy atomic tree lost deferred ownership of ${c.vfsPath}`);
				const h = n.get(c.inodeGroup);
				if (void 0 !== h && h !== l) throw new Error(`Lazy atomic tree split hard links at ${c.vfsPath}`);
				n.set(c.inodeGroup, l), i.add(l);
			}
			a.push({
				path: c.vfsPath,
				expectedIno: r.ino,
				expectedGeneration: r.generation,
				expectedDataSequence: r.dataSequence,
				expectedMode: r.mode,
				expectedLinkCount: r.linkCount,
				expectedSize: r.size,
				expectedUid: r.uid,
				expectedGid: r.gid
			});
		}
		return {
			guards: a,
			pendingIdentities: i.size
		};
	}
	assertLazyAtomicSnapshotMatchesPublic(e) {
		const t = this.sealedLazyAtomicStates.get(e), r = t?.snapshot, i = e.activation?.atomicGroup, n = r?.member ?? i?.member ?? "unknown";
		let s;
		if (void 0 !== r) try {
			s = hc(e, r.id, r.member);
		} catch {
			s = void 0;
		}
		if (void 0 === t || void 0 === r || void 0 === i || !Qa(i) || i.id !== r.id || i.member !== r.member || i.descriptorSha256 !== r.descriptorSha256 || i.expectedCount !== r.expectedCount || i.cohortSha256 !== r.cohortSha256 || void 0 === s || !fc(r, s)) throw new Error(`Lazy atomic activation member ${n} changed after sealing`);
		return t;
	}
	assertPendingLazyAtomicSnapshotsReadyForSerialization() {
		for (const e of this.lazyArchiveGroups) {
			if (!this.sealedLazyAtomicStates.has(e)) continue;
			if (this.lazyAtomicGroupByTree.get(e)?.committed) continue;
			const t = this.assertLazyAtomicSnapshotMatchesPublic(e);
			if (!t.verified) throw new Error(`Lazy atomic activation group ${t.snapshot.id} has not been cryptographically verified after import`);
		}
	}
	async validatePendingLazyAtomicGroupSeals(e) {
		for (const t of this.lazyAtomicGroups.values()) {
			if (t.committed || void 0 === t.expectedCount || void 0 === t.cohortSha256) continue;
			const r = [...t.groups.entries()].sort(([e], [t]) => e < t ? -1 : e > t ? 1 : 0).map(([, e]) => e);
			await this.ensureLazyAtomicGroupSealValidated(t, r, e);
		}
	}
	async ensureLazyAtomicGroupSealValidated(e, t, r) {
		if (this.assertLazyAtomicGroupSealValidatedAtLinearization(e, t, r)) return;
		let i = e.sealValidationFlight;
		if (void 0 === i && (i = this.validateLazyAtomicGroupSealOnce(e, t), e.sealValidationFlight = i, i.then(() => {
			e.sealValidationFlight === i && (e.sealValidationFlight = void 0);
		}, () => {
			e.sealValidationFlight === i && (e.sealValidationFlight = void 0);
		})), await i, !this.assertLazyAtomicGroupSealValidatedAtLinearization(e, t, r)) throw new Error(`Lazy atomic activation group ${e.id} seal verification did not authenticate every member`);
	}
	assertLazyAtomicGroupSealValidatedAtLinearization(e, t, r) {
		if (e.committed) return !0;
		if (void 0 === e.expectedCount || void 0 === e.cohortSha256 || t.length !== e.expectedCount) throw new Error(`Lazy atomic activation group ${e.id} is not completely sealed`);
		let i = !0;
		const n = [];
		for (const s of t) {
			const t = this.assertLazyAtomicSnapshotMatchesPublic(s), r = t.snapshot;
			if (r.id !== e.id || r.expectedCount !== e.expectedCount || r.cohortSha256 !== e.cohortSha256 || e.groups.get(r.member) !== s) throw new Error(`Lazy atomic activation group ${e.id} has an inconsistent member`);
			i &&= t.verified, n.push(t);
		}
		if (i && r) for (let s = 0; s < t.length; s++) this.collectAtomicTreeNamespace(t[s], n[s].snapshot);
		return i;
	}
	async validateLazyAtomicGroupSealOnce(e, t) {
		const r = [], i = [];
		for (const n of t) {
			const t = this.assertLazyAtomicSnapshotMatchesPublic(n), s = t.snapshot;
			if (s.id !== e.id || s.expectedCount !== e.expectedCount || s.cohortSha256 !== e.cohortSha256 || e.groups.get(s.member) !== n) throw new Error(`Lazy atomic activation group ${e.id} has an inconsistent member`);
			const o = await nc(s.descriptorBytes, `Lazy atomic member ${s.member}`);
			if (o !== s.descriptorSha256) throw new Error(`Lazy atomic activation member ${s.member} changed after sealing`);
			r.push({
				member: s.member,
				descriptorSha256: o
			}), i.push(t);
		}
		if (await nc(oc(e.id, r), `Lazy atomic activation group ${e.id}`) !== e.cohortSha256) throw new Error(`Lazy atomic activation group ${e.id} differs from its seal`);
		for (const n of t) this.assertLazyAtomicSnapshotMatchesPublic(n);
		for (const n of i) n.verified = !0;
	}
	async ensureAtomicLazyGroupMaterialized(t) {
		if (t.committed) return;
		const r = [...t.groups.entries()].sort(([e], [t]) => e < t ? -1 : e > t ? 1 : 0).map(([, e]) => e);
		if (0 === r.length) throw new Error(`Lazy atomic activation group ${t.id} has no trees`);
		if (await this.ensureLazyAtomicGroupSealValidated(t, r, !0), t.committed) return;
		const i = r.map((e) => this.sealedLazyAtomicStates.get(e).snapshot), n = r.map((e, t) => ({
			group: e,
			...this.collectAtomicTreeNamespace(e, i[t])
		})), s = this.lazyTransport, o = new Array(r.length);
		let a, c = 0, l = !1;
		const h = Array.from({ length: Math.min(4, r.length) }, async () => {
			for (; !l;) {
				const t = c++;
				if (t >= r.length) return;
				const n = r[t], h = i[t];
				try {
					const e = await this.fetchLazyArchiveData(n, s, h);
					Ua(s.signal), o[t] = {
						group: n,
						snapshot: h,
						contents: await this.prepareLazyArchiveContents(n, e, s.signal, h)
					};
				} catch (e) {
					l || (l = !0, a = e);
				}
			}
		});
		if (await Promise.all(h), l) throw o.fill(void 0), a;
		Ua(s.signal);
		for (const e of r) this.assertLazyAtomicSnapshotMatchesPublic(e);
		const d = [], f = [], u = [];
		for (let p = 0; p < o.length; p++) {
			const r = o[p], i = this.collectLazyArchiveReplacements(r.group, r.contents, void 0, r.snapshot), s = n[p];
			if (i.size !== s.pendingIdentities) throw new Error(`Lazy atomic activation group ${t.id} changed before commit`);
			const a = [];
			for (const [e, t] of i) a.push(e), d.push(pc(t));
			for (const n of r.snapshot.entries) {
				if (n.deleted || n.materialized || void 0 === n.generation) continue;
				const r = e.inodeKey(n.ino, n.generation);
				if (!i.has(r)) throw new Error(`Lazy atomic activation group ${t.id} has an incomplete publication`);
			}
			u.push({
				group: r.group,
				snapshot: r.snapshot,
				inodeKeys: a
			});
			for (const e of s.guards) f.push(e);
		}
		if (!this.fs.replaceManyIfIdentities(d, f)) throw new Error(`Lazy atomic activation group ${t.id} changed before commit`);
		for (const e of u) for (const t of e.inodeKeys) this.lazyArchiveInodes.delete(t);
		t.committed = !0;
		for (const e of u) try {
			for (const t of e.snapshot.entries) {
				if (t.isSymlink || void 0 === t.generation) continue;
				const r = e.group.entries.get(t.vfsPath);
				void 0 !== r && (r.materialized = !0);
			}
			e.group.materialized = !0;
		} catch {}
	}
	async materializeAllLazyEntries() {
		for (let t = 0; t < 3; t++) {
			this.reconcileLazyIdentityState(this.fs.identityState());
			const e = this.lazyArchiveGroups.filter((e) => {
				const t = this.lazyAtomicGroupByTree.get(e);
				return void 0 === this.sealedLazyAtomicStates.get(e)?.snapshot ? !e.materialized && void 0 !== e.content && void 0 !== e.inventory : !t?.committed;
			});
			if (0 === this.lazyFiles.size && 0 === this.lazyArchiveInodes.size && 0 === e.length) return;
			const t = Array.from(this.lazyFiles.values(), (e) => e.path);
			for (const i of t) await this.ensureMaterialized(i);
			const r = new Set(this.lazyArchiveInodes.values());
			for (const i of e) r.add(i);
			for (const i of r) await this.prepareLazyTreeGroup(i);
		}
		this.reconcileLazyIdentityState(this.fs.identityState());
		const e = this.lazyArchiveGroups.some((e) => {
			const t = this.lazyAtomicGroupByTree.get(e);
			return void 0 === this.sealedLazyAtomicStates.get(e)?.snapshot ? !e.materialized && void 0 !== e.content && void 0 !== e.inventory : !t?.committed;
		});
		if (0 !== this.lazyFiles.size || 0 !== this.lazyArchiveInodes.size || e) throw new Error("Cannot create a self-contained VFS image while lazy entries remain pending");
	}
	async saveImage(e) {
		e?.materializeAll && await this.materializeAllLazyEntries(), await this.validatePendingLazyAtomicGroupSeals(!1);
		const { bytes: t, identities: r } = this.fs.snapshotState({ normalizeTimestampsMs: e?.normalizeTimestampsMs });
		this.reconcileLazyIdentityState(r);
		const i = this.serializeLazyEntries(), n = i.length > 0, s = n ? new TextEncoder().encode(JSON.stringify(i)) : new Uint8Array(0);
		if (s.byteLength > ea) throw new Error("VFS image lazy metadata exceeds 16777216 bytes");
		const o = this.serializeValidatedLazyArchiveEntries(r), a = o.length > 0, c = a ? new TextEncoder().encode(JSON.stringify(o)) : new Uint8Array(0);
		if (c.byteLength > ta) throw new Error("VFS image lazy archive metadata exceeds 16777216 bytes");
		const l = function(e) {
			if (null === e) return new Uint8Array(0);
			const t = va(e), r = new TextEncoder().encode(JSON.stringify(t));
			if (r.byteLength > Qo) throw new Error("VFS image metadata exceeds 65536 bytes");
			return r;
		}(void 0 === e?.metadata ? this.imageMetadata : e.metadata), h = l.byteLength > 0, d = a ? 4 + c.byteLength : 0, f = h ? 4 + l.byteLength : 0, u = jo + t.byteLength + 4 + s.byteLength + d + f, p = new Uint8Array(u), m = new DataView(p.buffer);
		m.setUint32(0, Go, !0), m.setUint32(4, 1, !0), m.setUint32(8, (n ? 1 : 0) | (a ? 2 : 0) | (a ? 8 : 0) | (h ? 4 : 0), !0), m.setUint32(12, t.byteLength, !0), p.set(t, jo);
		const g = jo + t.byteLength;
		if (m.setUint32(g, s.byteLength, !0), s.byteLength > 0 && p.set(s, g + 4), a) {
			const e = g + 4 + s.byteLength;
			m.setUint32(e, c.byteLength, !0), p.set(c, e + 4);
		}
		if (h) {
			const e = g + 4 + s.byteLength + d;
			m.setUint32(e, l.byteLength, !0), p.set(l, e + 4);
		}
		return p;
	}
	static readImageMetadata(e) {
		const t = Ia(e);
		if (!(4 & t.flags)) return null;
		const { metadataOffset: r } = Pa(t.image, t.view, t.flags, t.sabLen);
		if (t.image.byteLength < r + 4) throw new Error("VFS image truncated (metadata section)");
		const i = t.view.getUint32(r, !0);
		if (i > Qo) throw new Error("VFS image metadata exceeds 65536 bytes");
		if (t.image.byteLength < r + 4 + i) throw new Error("VFS image truncated (metadata payload)");
		return 0 === i ? null : function(e) {
			if (e.byteLength > Qo) throw new Error("VFS image metadata exceeds 65536 bytes");
			let t;
			try {
				t = JSON.parse(new TextDecoder().decode(e));
			} catch (r) {
				const e = r instanceof Error ? r.message : String(r);
				throw new Error(`Invalid VFS image metadata JSON: ${e}`);
			}
			return va(t);
		}(t.image.subarray(r + 4, r + 4 + i));
	}
	static assertImageKernelAbi(t, r, i = "VFS image") {
		const n = e.readImageMetadata(t)?.kernelAbi;
		if (void 0 !== n && n !== r) throw new Error(`${i} requires kernel ABI ${n}, but the running kernel is ABI ${r}`);
	}
	static readImageCapacity(e) {
		const t = Ia(e);
		return ho.inspectImageCapacity(t.image.subarray(jo, jo + t.sabLen));
	}
	static fromImagePreservingCapacity(t) {
		const r = Ia(t), i = ho.inspectImageCapacity(r.image.subarray(jo, jo + r.sabLen));
		return e.restoreParsedImage(r, { maxByteLength: i.maxByteLength });
	}
	static fromImage(t, r) {
		const i = Ia(t, r?.maxDecompressedBytes);
		return e.restoreParsedImage(i, r);
	}
	static restoreParsedImage(t, r) {
		const i = t.image, n = t.view, s = t.flags, o = t.sabLen, a = Pa(i, n, s, o);
		if (!(1 & s) && 0 !== a.lazyLen) throw new Error("VFS image has lazy metadata without its format flag");
		if (8 & s && !(2 & s)) throw new Error("VFS image has typed lazy-archive metadata without its archive flag");
		const c = r?.maxByteLength ? { maxByteLength: r.maxByteLength } : void 0, l = new SharedArrayBuffer(o, c);
		new Uint8Array(l).set(i.subarray(jo, jo + o));
		let h = null;
		4 & s && (h = e.readImageMetadata(i));
		const d = new e(ho.mount(l, { restoreImage: !0 }), h), f = jo + o, u = a.lazyLen;
		if (1 & s && u > 0) {
			const e = Na(Ea(i.subarray(f + 4, f + 4 + u), "VFS image lazy metadata"), "VFS image lazy entries", 0, oa);
			d.importLazyEntriesInternal(e, !0);
		}
		if (2 & s) {
			const e = a.archiveOffset, t = n.getUint32(e, !0);
			if (t > 0) {
				const r = Ea(i.subarray(e + 4, e + 4 + t), "VFS image lazy archive metadata");
				d.importLazyArchiveEntriesInternal(r, !0, Boolean(8 & s), "pending");
			}
		}
		return d;
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
	adaptStatWithLazySize(e) {
		const t = this.adaptStat(e), r = this.lazyFileForStat(e);
		if (r) return t.size = r.size, t;
		const i = this.lazyArchiveForStat(e);
		if (i) {
			for (const n of this.lazyArchiveEntriesForRead(i)) if (n.ino === e.ino && n.generation === e.generation && !n.deleted) {
				t.size = n.size;
				break;
			}
		}
		return t;
	}
	open(e, t, r) {
		512 & t || 64 & t && 128 & t || this.guardSynchronousLazyAccess(e);
		const i = this.fs.open(e, t, r);
		return 512 & t && this.invalidateLazyData(this.fs.fstat(i)), i;
	}
	close(e) {
		return this.fs.close(e), 0;
	}
	read(e, t, r, i) {
		if (i > 0) {
			let t = this.lazyBackingForStat(this.fs.fstat(e));
			t && (this.reconcileLazyIdentityState(this.fs.identityState()), t = this.lazyBackingForStat(this.fs.fstat(e)), t && this.guardSynchronousLazyAccess(t.path));
		}
		return null !== r ? this.fs.readAt(e, t.subarray(0, i), r) : this.fs.read(e, t.subarray(0, i));
	}
	write(e, t, r, i) {
		if (null !== r) {
			const n = this.fs.writeAt(e, t.subarray(0, i), r);
			return n > 0 && this.invalidateLazyData(this.fs.fstat(e)), n;
		}
		const n = this.fs.write(e, t.subarray(0, i));
		return n > 0 && this.invalidateLazyData(this.fs.fstat(e)), n;
	}
	seek(e, t, r) {
		return this.fs.lseek(e, t, r);
	}
	fstat(e) {
		return this.adaptStatWithLazySize(this.fs.fstat(e));
	}
	fpathconf(e, t) {
		return Rs(this.fstat(e), t, {
			supportsSymlinks: !0,
			timestampResolutionNs: 1e6
		});
	}
	ftruncate(e, t) {
		this.fs.ftruncate(e, t), this.invalidateLazyData(this.fs.fstat(e));
	}
	fsync(e) {}
	fchmod(e, t) {
		this.fs.fchmod(e, t);
	}
	fchown(e, t, r) {
		this.fs.fchown(e, t, r);
	}
	stat(e) {
		return this.adaptStatWithLazySize(this.fs.stat(e));
	}
	lstat(e) {
		return this.adaptStatWithLazySize(this.fs.lstat(e));
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
	pathconf(e, t) {
		return Rs(this.stat(e), t, {
			supportsSymlinks: !0,
			timestampResolutionNs: 1e6
		});
	}
	mkdir(e, t) {
		this.fs.mkdir(e, t);
	}
	rmdir(e) {
		this.fs.rmdir(e);
	}
	unlink(t) {
		const r = this.fs.unlink(t), i = e.inodeKey(r.ino, r.generation);
		if (r.linkCount > 1 && (this.lazyFiles.has(i) || this.lazyArchiveInodes.has(i))) return void this.reconcileLazyIdentityState(this.fs.identityState());
		const n = this.lazyFiles.get(i);
		n && (n.paths.delete(t), r.linkCount <= 1 ? this.lazyFiles.delete(i) : n.path === t && (n.path = n.paths.values().next().value));
		const s = this.lazyArchiveInodes.get(i);
		if (s) {
			const e = s.entries.get(t);
			if (r.linkCount <= 1) {
				for (const e of s.entries.values()) e.ino === r.ino && e.generation === r.generation && (e.deleted = !0);
				this.lazyArchiveInodes.delete(i);
			} else e && s.entries.delete(t);
		}
	}
	rename(t, r) {
		const { source: i, replaced: n } = this.fs.rename(t, r);
		if (n && n.ino === i.ino && n.generation === i.generation) return;
		let s = !1;
		if (n) {
			const t = e.inodeKey(n.ino, n.generation);
			n.linkCount > 1 && (this.lazyFiles.has(t) || this.lazyArchiveInodes.has(t)) && (this.reconcileLazyIdentityState(this.fs.identityState()), s = !0);
			const i = this.lazyFiles.get(t);
			!s && i && (i.paths.delete(r), n.linkCount <= 1 ? this.lazyFiles.delete(t) : i.path === r && (i.path = i.paths.values().next().value));
			const o = this.lazyArchiveInodes.get(t);
			if (!s && o) {
				const e = o.entries.get(r);
				n.linkCount <= 1 ? (e && (e.deleted = !0), this.lazyArchiveInodes.delete(t)) : e && o.entries.delete(r);
			}
		}
		s || this.rewriteLazyNamespacePaths(i, t, r);
	}
	link(t, r) {
		const i = this.fs.link(t, r), n = e.inodeKey(i.ino, i.generation), s = this.lazyFiles.get(n);
		s && s.paths.add(r);
		const o = this.lazyArchiveInodes.get(n);
		if (o) {
			const e = Array.from(o.entries.values()).find((e) => e.ino === i.ino && e.generation === i.generation);
			e && o.entries.set(r, { ...e });
		}
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
	chown(e, t, r) {
		this.fs.chown(e, t, r);
	}
	lchown(e, t, r) {
		this.fs.lchown(e, t, r);
	}
	createFileWithOwner(e, t, r, i, n) {
		const s = this.open(e, 577, t);
		n.length > 0 && this.write(s, n, null, n.length), this.close(s), this.chown(e, r, i), this.chmod(e, t);
	}
	mkdirWithOwner(e, t, r, i) {
		this.mkdir(e, t), this.chown(e, r, i), this.chmod(e, t);
	}
	symlinkWithOwner(e, t, r, i) {
		this.symlink(e, t), this.lchown(t, r, i);
	}
	copyPathToFreshFileSystem(t, r, i, n, s) {
		const o = this.lstat(t), a = o.mode & Xo, c = 4095 & o.mode;
		if (a === Zo) {
			"/" === t ? (r.chown(t, o.uid, o.gid), r.chmod(t, c)) : r.mkdirWithOwner(t, c, o.uid, o.gid);
			const a = this.opendir(t);
			try {
				for (;;) {
					const e = this.readdir(a);
					if (!e) break;
					"." !== e.name && ".." !== e.name && this.copyPathToFreshFileSystem("/" === t ? `/${e.name}` : `${t}/${e.name}`, r, i, n, s);
				}
			} finally {
				this.closedir(a);
			}
			e.applyTimes(r, t, o);
			return;
		}
		const l = o.nlink > 1 ? `${o.dev}:${o.ino}` : null, h = l ? s.get(l) : void 0;
		if (h) r.link(h, t);
		else {
			if (a === Jo) return r.symlinkWithOwner(this.readlink(t), t, o.uid, o.gid), void (l && s.set(l, t));
			if (a !== Yo) throw new Error(`Unsupported file type while rebasing VFS: ${t}`);
			if (i.has(t) || n.has(t)) return r.createFileWithOwner(t, c, o.uid, o.gid, new Uint8Array(0)), e.applyTimes(r, t, o), void (l && s.set(l, t));
			this.copyRegularFileToFreshFileSystem(t, r, o, c), l && s.set(l, t);
		}
	}
	copyRegularFileToFreshFileSystem(t, r, i, n) {
		const s = this.open(t, 0, 0);
		let o = null;
		try {
			o = r.open(t, 577, n);
			const e = new Uint8Array(Math.min(1048576, Math.max(1, i.size)));
			let a = i.size;
			for (; a > 0;) {
				const i = Math.min(e.byteLength, a), n = this.read(s, e, null, i);
				if (n <= 0) throw new Error(`Unexpected EOF while rebasing VFS file: ${t}`);
				let c = 0;
				for (; c < n;) {
					const i = r.write(o, e.subarray(c, n), null, n - c);
					if (i <= 0) throw new Error(`Short write while rebasing VFS file: ${t}`);
					c += i;
				}
				a -= n;
			}
		} finally {
			null !== o && r.close(o), this.close(s);
		}
		r.chown(t, i.uid, i.gid), r.chmod(t, n), e.applyTimes(r, t, i);
	}
	static applyTimes(e, t, r) {
		const i = Math.floor(r.atimeMs / 1e3), n = Math.floor(1e6 * (r.atimeMs - 1e3 * i)), s = Math.floor(r.mtimeMs / 1e3), o = Math.floor(1e6 * (r.mtimeMs - 1e3 * s));
		e.utimensat(t, i, n, s, o);
	}
	access(e, t) {
		this.fs.stat(e);
	}
	utimensat(e, t, r, i, n) {
		this.fs.utimens(e, t, r, i, n);
	}
	opendir(e) {
		return this.fs.opendir(e);
	}
	readdir(e) {
		const t = this.fs.readdirEntry(e);
		if (!t) return null;
		const r = t.stat.mode;
		let i = 0;
		return 32768 == (61440 & r) ? i = 8 : 16384 == (61440 & r) ? i = 4 : 40960 == (61440 & r) && (i = 10), {
			name: t.name,
			type: i,
			ino: t.stat.ino
		};
	}
	closedir(e) {
		this.fs.closedir(e);
	}
};
const gc = /^[0-9a-f]{64}$/;
function yc(e) {
	return function(e) {
		const t = new Map(e.map((e) => [e.url, e]));
		return async (e) => {
			const r = t.get(e);
			if (void 0 === r) throw new Error(`closed lazy assets do not bind URL ${e}`);
			if (r.bytes.byteLength !== r.size) throw new Error(`closed lazy asset ${e} changed size before response`);
			const i = new ArrayBuffer(r.bytes.byteLength);
			if (new Uint8Array(i).set(r.bytes), n = new Uint8Array(await crypto.subtle.digest("SHA-256", i)), Array.from(n, (e) => e.toString(16).padStart(2, "0")).join("") !== r.sha256) throw new Error(`closed lazy asset ${e} changed SHA-256 before response`);
			var n;
			const s = Sc(r.bytes);
			return new Response(s.buffer, {
				status: 200,
				headers: { "content-length": String(s.byteLength) }
			});
		};
	}(function(e, t) {
		if (!Array.isArray(e)) throw new Error("closed lazy assets must be an array");
		if (e.length > 128) throw new Error("closed lazy assets exceed 128 bindings");
		const r = /* @__PURE__ */ new Set();
		let i = 0;
		const n = new Array(e.length);
		for (let s = 0; s < e.length; s += 1) {
			if (!Object.hasOwn(e, s)) throw new Error(`closed lazy asset ${s} is missing`);
			const o = e[s];
			if ("object" != typeof o || null === o) throw new Error(`closed lazy asset ${s} is not an object`);
			const { url: a, sha256: c, size: l, bytes: h } = o;
			if ("string" != typeof a || "string" != typeof c || !gc.test(c) || !Number.isSafeInteger(l) || l <= 0 || !(h instanceof Uint8Array)) throw new Error(`closed lazy asset ${s} has invalid fields`);
			if (bc(a, `closed lazy asset ${s}`), r.has(a)) throw new Error(`closed lazy assets duplicate URL ${a}`);
			if (h.byteLength !== l) throw new Error(`closed lazy asset ${s} has ${h.byteLength} bytes, expected ${l}`);
			if (i += l, !Number.isSafeInteger(i) || i > 536870912) throw new Error("closed lazy assets exceed 536870912 bytes");
			if (r.add(a), !(t || h.buffer instanceof ArrayBuffer && 0 === h.byteOffset && h.buffer.byteLength === h.byteLength)) throw new Error(`closed lazy asset ${s} ownership requires one whole ordinary ArrayBuffer`);
			n[s] = {
				url: a,
				sha256: c,
				size: l,
				bytes: h
			};
		}
		return t ? n.map(({ url: e, sha256: t, size: r, bytes: i }) => ({
			url: e,
			sha256: t,
			size: r,
			bytes: Sc(i)
		})) : n;
	}(e, !1));
}
const wc = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?\/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/;
function bc(e, t) {
	if (wc.test(e)) return;
	let r;
	try {
		r = new URL(e);
	} catch (i) {
		throw new Error(`${t} URL is invalid`, { cause: i });
	}
	if ("https:" !== r.protocol || "" !== r.username || "" !== r.password || "" !== r.hash || e.includes("#") || r.href !== e) throw new Error(`${t} must use one canonical HTTPS URL or immutable OCI reference without userinfo or a fragment`);
}
function Sc(e) {
	const t = new Uint8Array(e.byteLength);
	return t.set(e), t;
}
function _c(e, t) {
	const r = e.trim();
	if (0 === r.length) throw new Error("CORS proxy URL must not be empty");
	return t.startsWith(r) ? t : `${r}${r.endsWith("?") ? t : encodeURIComponent(t)}`;
}
function kc(e, t) {
	return /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("/") ? t : e.replace(/\/?$/, "/") + t;
}
const vc = {
	reader: () => 0,
	writer: (e, t) => t,
	mode: 8630
}, Ac = {
	reader: (e, t) => (e.fill(0, 0, t), t),
	writer: (e, t) => t,
	mode: 8630
}, Ic = {
	reader: () => {
		throw new Error("ENXIO");
	},
	writer: () => {
		throw new Error("ENXIO");
	},
	mode: 8630
};
const Pc = [
	"pts",
	"shm",
	"mqueue"
], Ec = [
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
function Cc(e) {
	return "/" === e || "" === e || "." === e;
}
var xc = class {
	devices = /* @__PURE__ */ new Map();
	handles = /* @__PURE__ */ new Map();
	nextHandle = 1;
	deviceNames;
	constructor() {
		const e = {
			reader: (e, t) => {
				if (void 0 !== globalThis.crypto && globalThis.crypto.getRandomValues) {
					const r = new Uint8Array(t);
					globalThis.crypto.getRandomValues(r), e.set(r, 0);
				} else for (let r = 0; r < t; r++) e[r] = 256 * Math.random() | 0;
				return t;
			},
			writer: (e, t) => t,
			mode: 8630
		};
		this.devices.set("null", vc), this.devices.set("zero", Ac), this.devices.set("urandom", e), this.devices.set("random", e), this.devices.set("console", Ic), this.devices.set("tty", Ic), this.deviceNames = [...this.devices.keys()];
	}
	getDevice(e) {
		const t = e.startsWith("/") ? e.slice(1) : e, r = this.devices.get(t);
		if (!r) throw new Error("ENOENT");
		return r;
	}
	open(e, t, r) {
		const i = e.startsWith("/") ? e.slice(1) : e;
		if (Cc(e) || Pc.includes(i)) {
			const e = this.nextHandle++;
			return this.handles.set(e, { device: null }), e;
		}
		const n = this.getDevice(e), s = this.nextHandle++;
		return this.handles.set(s, { device: n }), s;
	}
	close(e) {
		if (!this.handles.delete(e)) throw new Error("EBADF");
		return 0;
	}
	read(e, t, r, i) {
		const n = this.handles.get(e);
		if (!n) throw new Error("EBADF");
		if (!n.device) throw new Error("EISDIR");
		return n.device.reader(t, Math.min(i, t.length));
	}
	write(e, t, r, i) {
		const n = this.handles.get(e);
		if (!n) throw new Error("EBADF");
		if (!n.device) throw new Error("EISDIR");
		return n.device.writer(t, Math.min(i, t.length));
	}
	seek(e, t, r) {
		return 0;
	}
	fstat(e) {
		const t = this.handles.get(e);
		if (!t) throw new Error("EBADF");
		const r = Date.now();
		return t.device ? {
			dev: 5,
			ino: 0,
			mode: t.device.mode,
			nlink: 1,
			uid: 0,
			gid: 0,
			size: 0,
			atimeMs: r,
			mtimeMs: r,
			ctimeMs: r
		} : {
			dev: 5,
			ino: 0,
			mode: 16877,
			nlink: 2,
			uid: 0,
			gid: 0,
			size: 0,
			atimeMs: r,
			mtimeMs: r,
			ctimeMs: r
		};
	}
	fpathconf(e, t) {
		return Rs(this.fstat(e), t, {
			supportsSymlinks: !1,
			timestampResolutionNs: null
		});
	}
	ftruncate(e, t) {}
	fsync(e) {}
	fchmod(e, t) {}
	fchown(e, t, r) {}
	stat(e) {
		const t = Date.now();
		if (Cc(e)) return {
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
		const r = e.startsWith("/") ? e.slice(1) : e;
		return Pc.includes(r) ? {
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
		return t.files = this.devices.size + Pc.length + Ec.length, t;
	}
	pathconf(e, t) {
		return Rs(this.stat(e), t, {
			supportsSymlinks: !1,
			timestampResolutionNs: null
		});
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
	chown(e, t, r) {}
	lchown(e, t, r) {}
	access(e, t) {
		this.stat(e);
	}
	utimensat(e, t, r, i, n) {}
	dirHandles = /* @__PURE__ */ new Map();
	nextDirHandle = 1;
	opendir(e) {
		const t = e.startsWith("/") ? e.slice(1) : e;
		let r;
		if (Cc(e)) r = [...this.deviceNames.map((e, t) => ({
			name: e,
			type: 2,
			ino: t + 1
		})), ...Ec.filter((e) => !this.devices.has(e.name))];
		else {
			if (!Pc.includes(t)) throw new Error("ENOTDIR");
			r = [];
		}
		const i = this.nextDirHandle++;
		return this.dirHandles.set(i, {
			idx: 0,
			entries: r
		}), i;
	}
	readdir(e) {
		const t = this.dirHandles.get(e);
		if (!t) throw new Error("EBADF");
		if (t.idx >= t.entries.length) return null;
		const r = t.entries[t.idx];
		return t.idx++, r;
	}
	closedir(e) {
		this.dirHandles.delete(e);
	}
}, zc = class {
	clockGettime(e) {
		if (1 === e || 2 === e || 3 === e || 7 === e) {
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
		const r = 1e3 * e + Math.floor(t / 1e6);
		if (r > 0) {
			const e = new SharedArrayBuffer(4);
			Atomics.wait(new Int32Array(e), 0, 0, r);
		}
	}
};
async function Mc(e, t) {
	const r = mc.fromImage(e, t);
	return await r.verifyImportedLazyAtomicGroupSeals(), r;
}
const Tc = [
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
function Lc(e) {
	const t = function(e, t) {
		let r = null;
		try {
			const i = e.stat(t);
			r = e.open(t, 0, 0);
			const n = new Uint8Array(i.size);
			let s = 0;
			for (; s < n.byteLength;) {
				const t = e.read(r, n.subarray(s), null, n.byteLength - s);
				if (t <= 0) break;
				s += t;
			}
			return new TextDecoder().decode(n.subarray(0, s));
		} catch {
			return null;
		} finally {
			if (null !== r) try {
				e.close(r);
			} catch {}
		}
	}(e, "/etc/group");
	null === t || /^nobody:/m.test(t) || function(e, t, r) {
		const i = new TextEncoder().encode(r), n = e.open(t, 577, 420);
		try {
			i.byteLength > 0 && e.write(n, i, null, i.byteLength);
		} finally {
			e.close(n);
		}
	}(e, "/etc/group", `${t.replace(/\n?$/, "\n")}nobody:x:65534:\n`);
}
function Bc(e, t, r = {}) {
	return function(e) {
		const t = /* @__PURE__ */ new Set();
		for (const r of e) {
			if ("string" != typeof r.path || 0 === r.path.length) throw new Error("MountSpec: empty path");
			if (!r.path.startsWith("/")) throw new Error(`MountSpec: path must be absolute: ${r.path}`);
			if ("/" !== r.path && r.path.endsWith("/")) throw new Error(`MountSpec: trailing slash on non-root path: ${r.path}`);
			const e = r.path.split("/");
			for (const t of e) if ("." === t || ".." === t) throw new Error(`MountSpec: path contains "${t}" segment: ${r.path}`);
			if (t.has(r.path)) throw new Error(`MountSpec: duplicate mount path: ${r.path}`);
			t.add(r.path);
		}
	}(e), async function(e, t, r) {
		const i = await async function(e, t) {
			const r = new Map(await Promise.all(e.filter((e) => "image" === e.source).map(async (e) => [e, await Mc(t, { maxByteLength: 1073741824 })])));
			for (const i of r.values()) Lc(i);
			return r;
		}(e, t), n = [];
		for (const s of e) if ("image" === s.source) {
			const e = i.get(s);
			if (void 0 === e) throw new Error(`verified image mount is missing: ${s.path}`);
			n.push({
				mountPoint: s.path,
				backend: e,
				readonly: s.readonly
			});
		} else {
			const e = r.scratchSabBytes?.[s.path] ?? 16777216, t = new SharedArrayBuffer(e), i = mc.create(t);
			void 0 !== s.mode && i.chmod("/", s.mode), void 0 === s.uid && void 0 === s.gid || i.chown("/", s.uid ?? 0, s.gid ?? 0), n.push({
				mountPoint: s.path,
				backend: i,
				readonly: s.readonly
			});
		}
		return n;
	}(e, t, r);
}
function Rc(e) {
	return Object.assign(/* @__PURE__ */ new Error(`ENOENT: ${e}`), { errno: 2 });
}
function Uc(e, t) {
	(function(e) {
		const t = e.endsWith(".") ? e.slice(0, -1) : e;
		if (0 === t.length || !/^[\x00-\x7f]+$/.test(t)) throw Rc(e);
		let r = 1;
		for (const i of t.split(".")) {
			if (0 === i.length || i.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(i)) throw Rc(e);
			r += 1 + i.length;
		}
		if (r > 255) throw Rc(e);
	})(e);
	const r = e.endsWith(".") ? e.slice(0, -1) : e, i = r.toLowerCase();
	if ((!t || !Object.prototype.hasOwnProperty.call(t, r) && !Object.prototype.hasOwnProperty.call(t, i)) && ("invalid" === i || i.endsWith(".invalid"))) throw Rc(e);
}
var Fc = class extends Error {
	errno = 11;
	constructor() {
		super("EAGAIN");
	}
};
function Hc(e) {
	let t = 0;
	e.forEach((e) => t += e.length);
	const r = new Uint8Array(t);
	let i = 0;
	return e.forEach((e) => {
		r.set(e, i), i += e.length;
	}), r;
}
function $c(e) {
	return Hc(e.map((e) => ArrayBuffer.isView(e) ? new Uint8Array(e.buffer, e.byteOffset, e.byteLength) : new Uint8Array(e))).buffer;
}
const Wc = (...e) => console.warn(...e);
function Dc(e) {
	return Object.fromEntries(Object.entries(e).map(([e, t]) => [t, e]));
}
function Oc(e) {
	return new Uint8Array([e >> 8 & 255, 255 & e]);
}
function Nc(e) {
	return new Uint8Array([
		e >> 16 & 255,
		e >> 8 & 255,
		255 & e
	]);
}
function Kc(e) {
	const t = /* @__PURE__ */ new ArrayBuffer(8);
	return new DataView(t).setBigUint64(0, BigInt(e), !1), new Uint8Array(t);
}
var Vc = class {
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
}, qc = class {
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
const Gc = {
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
}, jc = Dc(Gc), Xc = { host_name: 0 }, Yc = Dc(Xc);
var Zc = class {
	static decodeFromClient(e) {
		const t = new DataView(e.buffer);
		let r = 0;
		const i = t.getUint16(r);
		r += 2;
		const n = [];
		for (; r < i + 2;) {
			const i = e[r];
			r += 1;
			const s = t.getUint16(r);
			r += 2;
			const o = e.slice(r, r + s);
			if (r += s, i !== Xc.host_name) throw new Error(`Unsupported name type ${i}`);
			n.push({
				name_type: Yc[i],
				name: { host_name: new TextDecoder().decode(o) }
			});
		}
		return { server_name_list: n };
	}
	static encodeForClient(e) {
		if (e?.server_name_list.length) throw new Error("Encoding non-empty lists for ClientHello is not supported yet. Only empty lists meant for ServerHello are supported today.");
		const t = new qc(4);
		return t.writeUint16(Gc.server_name), t.writeUint16(0), t.uint8Array;
	}
};
const Jc = {
	uncompressed: 0,
	ansiX962_compressed_prime: 1,
	ansiX962_compressed_char2: 2
}, Qc = Dc(Jc);
var el = class {
	static decodeFromClient(e) {
		const t = new Vc(e.buffer), r = t.readUint8(), i = [];
		for (let n = 0; n < r; n++) {
			const e = t.readUint8();
			e in Qc && i.push(Qc[e]);
		}
		return i;
	}
	static encodeForClient(e) {
		const t = new qc(6);
		return t.writeUint16(Gc.ec_point_formats), t.writeUint16(2), t.writeUint8(1), t.writeUint8(Jc[e]), t.uint8Array;
	}
};
const tl = {
	decodeFromClient: (e) => ({}),
	encodeForClient() {
		const e = Gc.extended_master_secret;
		return new Uint8Array([
			e >> 8 & 255,
			255 & e,
			0,
			0
		]);
	}
}, rl = {
	decodeFromClient(e) {
		const t = e[0] ?? 0;
		return { renegotiatedConnection: e.slice(1, 1 + t) };
	},
	encodeForClient() {
		const e = Gc.renegotiation_info, t = new Uint8Array([0]);
		return new Uint8Array([
			e >> 8 & 255,
			255 & e,
			0,
			t.length,
			...t
		]);
	}
}, il = {
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
}, nl = Dc(il), sl = {
	secp256r1: 23,
	secp384r1: 24,
	secp521r1: 25,
	x25519: 29,
	x448: 30
}, ol = Dc(sl);
const al = {
	anonymous: 0,
	rsa: 1,
	dsa: 2,
	ecdsa: 3
}, cl = Dc(al), ll = {
	none: 0,
	md5: 1,
	sha1: 2,
	sha224: 3,
	sha256: 4,
	sha384: 5,
	sha512: 6
}, hl = Dc(ll);
const dl = {
	server_name: Zc,
	signature_algorithms: class {
		static decodeFromClient(e) {
			const t = new Vc(e.buffer);
			t.readUint16();
			const r = [];
			for (; !t.isFinished();) {
				const e = t.readUint8(), i = t.readUint8();
				cl[i] && (hl[e] ? r.push({
					algorithm: cl[i],
					hash: hl[e]
				}) : Wc(`Unknown hash algorithm: ${e}`));
			}
			return r;
		}
		static encodeforClient(e, t) {
			const r = new qc(6);
			return r.writeUint16(Gc.signature_algorithms), r.writeUint16(2), r.writeUint8(ll[e]), r.writeUint8(al[t]), r.uint8Array;
		}
	},
	supported_groups: class {
		static decodeFromClient(e) {
			const t = new Vc(e.buffer);
			t.readUint16();
			const r = [];
			for (; !t.isFinished();) {
				const e = t.readUint16();
				e in ol && r.push(ol[e]);
			}
			return r;
		}
		static encodeForClient(e) {
			const t = new qc(6);
			return t.writeUint16(Gc.supported_groups), t.writeUint16(2), t.writeUint16(sl[e]), t.uint8Array;
		}
	},
	ec_point_formats: el,
	renegotiation_info: rl,
	extended_master_secret: tl
};
async function fl(e, t, r, i) {
	const n = $c([t, r]), s = await crypto.subtle.importKey("raw", e, {
		name: "HMAC",
		hash: { name: "SHA-256" }
	}, !1, ["sign"]);
	let o = n;
	const a = [];
	for (; $c(a).byteLength < i;) {
		o = await ul(s, o);
		const e = await ul(s, $c([o, n]));
		a.push(e);
	}
	return $c(a).slice(0, i);
}
async function ul(e, t) {
	return await crypto.subtle.sign({
		name: "HMAC",
		hash: "SHA-256"
	}, e, t);
}
const pl = 0, ml = {
	Warning: 1,
	Fatal: 2
}, gl = Dc(ml), yl = {
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
}, wl = Dc(yl), bl = 20, Sl = 21, _l = 22, kl = 23, vl = 0, Al = 1, Il = 2, Pl = 11, El = 12, Cl = 14, xl = 16, zl = 20, Ml = 3, Tl = 23;
var Ll = class extends Error {};
const Bl = new Uint8Array([3, 3]), Rl = crypto.subtle.generateKey({
	name: "ECDH",
	namedCurve: "P-256"
}, !0, ["deriveKey", "deriveBits"]);
var Ul = class {
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
		downstream: Hl(this.MAX_CHUNK_SIZE)
	};
	serverUpstreamWriter = this.serverEnd.upstream.writable.getWriter();
	constructor() {
		const e = this;
		this.serverEnd.downstream.readable.pipeTo(new WritableStream({
			async write(t) {
				await e.writeTLSRecord(kl, t);
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
		const r = await this.readNextHandshakeMessage(Al);
		if (!r.body.cipher_suites.length) throw new Error("Client did not propose any supported cipher suites.");
		const i = crypto.getRandomValues(new Uint8Array(32));
		await this.writeTLSRecord(_l, $l.serverHello(r.body, i, pl)), await this.writeTLSRecord(_l, $l.certificate(t));
		const n = await Rl, s = r.body.random, o = await $l.ECDHEServerKeyExchange(s, i, n, e);
		await this.writeTLSRecord(_l, o), await this.writeTLSRecord(_l, $l.serverHelloDone());
		const a = r.body.extensions.some((e) => "extended_master_secret" === e.type), c = await this.readNextHandshakeMessage(xl);
		await this.readNextMessage(bl), this.sessionKeys = await this.deriveSessionKeys({
			clientRandom: s,
			serverRandom: i,
			serverPrivateKey: n.privateKey,
			clientPublicKey: await crypto.subtle.importKey("raw", c.body.exchange_keys, {
				name: "ECDH",
				namedCurve: "P-256"
			}, !1, []),
			useEMS: a
		}), await this.readNextHandshakeMessage(zl), await this.writeTLSRecord(bl, $l.changeCipherSpec()), await this.writeTLSRecord(_l, await $l.createFinishedMessage(this.handshakeMessages, this.sessionKeys.masterSecret)), this.handshakeMessages = [], this.pollForClientMessages();
	}
	async deriveSessionKeys({ clientRandom: e, serverRandom: t, serverPrivateKey: r, clientPublicKey: i, useEMS: n = !1 }) {
		const s = await crypto.subtle.deriveBits({
			name: "ECDH",
			public: i
		}, r, 256);
		let o;
		if (n) {
			const e = new Uint8Array(await crypto.subtle.digest("SHA-256", Hc(this.handshakeMessages)));
			o = new Uint8Array(await fl(s, new TextEncoder().encode("extended master secret"), e, 48));
		} else o = new Uint8Array(await fl(s, new TextEncoder().encode("master secret"), Hc([e, t]), 48));
		const a = new Vc(await fl(o, new TextEncoder().encode("key expansion"), Hc([t, e]), 40)), c = a.readUint8Array(16), l = a.readUint8Array(16), h = a.readUint8Array(4), d = a.readUint8Array(4);
		return {
			masterSecret: o,
			clientWriteKey: await crypto.subtle.importKey("raw", c, { name: "AES-GCM" }, !1, ["encrypt", "decrypt"]),
			serverWriteKey: await crypto.subtle.importKey("raw", l, { name: "AES-GCM" }, !1, ["encrypt", "decrypt"]),
			clientIV: h,
			serverIV: d
		};
	}
	async readNextHandshakeMessage(e) {
		const t = await this.readNextMessage(_l);
		if (t.msg_type !== e) throw new Error(`Expected ${e} message`);
		return t;
	}
	async readNextMessage(e) {
		let t, r = !1;
		do
			t = await this.readNextTLSRecord(e), r = await this.accumulateUntilMessageIsComplete(t);
		while (!1 === r);
		const i = Fl.TLSMessage(t.type, r);
		return t.type === _l && this.handshakeMessages.push(t.fragment), i;
	}
	async readNextTLSRecord(e) {
		for (;;) {
			for (let o = 0; o < this.receivedTLSRecords.length; o++) {
				const t = this.receivedTLSRecords[o];
				if (t.type === e) return this.receivedTLSRecords.splice(o, 1), t;
			}
			const t = await this.pollBytes(5), r = t[3] << 8 | t[4], i = t[0], n = await this.pollBytes(r), s = {
				type: i,
				version: {
					major: t[1],
					minor: t[2]
				},
				length: r,
				fragment: this.sessionKeys && i !== bl ? await this.decryptData(i, n) : n
			};
			if (s.type === Sl) {
				const e = s.fragment[0], t = s.fragment[1], r = gl[e], i = wl[t];
				if (e === ml.Warning && t === yl.CloseNotify) throw new Ll("TLS connection closed by peer (CloseNotify)");
				throw new Error(`TLS alert received: ${r} ${i}`);
			}
			this.receivedTLSRecords.push(s);
		}
	}
	async pollBytes(e) {
		for (; this.receivedBytesBuffer.length < e;) {
			const { value: t, done: r } = await this.clientUpstreamReader.read();
			if (r) throw await this.close(), new Ll("TLS connection closed");
			if (this.receivedBytesBuffer = Hc([this.receivedBytesBuffer, t]), this.receivedBytesBuffer.length >= e) break;
			await new Promise((e) => setTimeout(e, 100));
		}
		const t = this.receivedBytesBuffer.slice(0, e);
		return this.receivedBytesBuffer = this.receivedBytesBuffer.slice(e), t;
	}
	async pollForClientMessages() {
		try {
			for (;;) {
				const e = await this.readNextMessage(kl);
				this.serverUpstreamWriter.write(e.body);
			}
		} catch (e) {
			return;
		}
	}
	async decryptData(e, t) {
		const r = this.sessionKeys.clientIV, i = t.slice(0, 8), n = new Uint8Array([...r, ...i]), s = await crypto.subtle.decrypt({
			name: "AES-GCM",
			iv: n,
			additionalData: new Uint8Array([
				...Kc(this.receivedRecordSequenceNumber),
				e,
				...Bl,
				...Oc(t.length - 8 - 16)
			]),
			tagLength: 128
		}, this.sessionKeys.clientWriteKey, t.slice(8));
		return ++this.receivedRecordSequenceNumber, new Uint8Array(s);
	}
	async accumulateUntilMessageIsComplete(e) {
		this.partialTLSMessages[e.type] = Hc([this.partialTLSMessages[e.type] || new Uint8Array(), e.fragment]);
		const t = this.partialTLSMessages[e.type];
		switch (e.type) {
			case _l: {
				if (t.length < 4) return !1;
				const e = t[1] << 8 | t[2];
				if (t.length < 3 + e) return !1;
				break;
			}
			case Sl:
				if (t.length < 2) return !1;
				break;
			case bl:
			case kl: break;
			default: throw new Error(`TLS: Unsupported record type ${e.type}`);
		}
		return delete this.partialTLSMessages[e.type], t;
	}
	async writeTLSRecord(e, t) {
		e === _l && this.handshakeMessages.push(t), this.sessionKeys && e !== bl && (t = await this.encryptData(e, t));
		const r = Bl, i = t.length, n = new Uint8Array(5);
		n[0] = e, n[1] = r[0], n[2] = r[1], n[3] = i >> 8 & 255, n[4] = 255 & i;
		const s = Hc([n, t]);
		this.clientDownstreamWriter.write(s);
	}
	async encryptData(e, t) {
		const r = this.sessionKeys.serverIV, i = crypto.getRandomValues(new Uint8Array(8)), n = new Uint8Array([...r, ...i]), s = new Uint8Array([
			...Kc(this.sentRecordSequenceNumber),
			e,
			...Bl,
			...Oc(t.length)
		]), o = await crypto.subtle.encrypt({
			name: "AES-GCM",
			iv: n,
			additionalData: s,
			tagLength: 128
		}, this.sessionKeys.serverWriteKey, t);
		return ++this.sentRecordSequenceNumber, Hc([i, new Uint8Array(o)]);
	}
}, Fl = class e {
	static TLSMessage(t, r) {
		switch (t) {
			case _l: return e.clientHandshake(r);
			case Sl: return e.alert(r);
			case bl: return e.changeCipherSpec();
			case kl: return e.applicationData(r);
			default: throw new Error(`TLS: Unsupported TLS record type ${t}`);
		}
	}
	static parseCipherSuites(e) {
		const t = new Vc(e), r = [], i = [t.readUint16()];
		for (; !t.isFinished();) {
			const e = t.readUint16();
			i.push(e), e in nl && r.push(nl[e]);
		}
		return r;
	}
	static applicationData(e) {
		return {
			type: kl,
			body: e
		};
	}
	static changeCipherSpec() {
		return {
			type: bl,
			body: new Uint8Array()
		};
	}
	static alert(e) {
		return {
			type: Sl,
			level: gl[e[0]],
			description: wl[e[1]]
		};
	}
	static clientHandshake(t) {
		const r = t[0], i = t[1] << 16 | t[2] << 8 | t[3], n = t.slice(4);
		let s;
		switch (r) {
			case vl:
				s = e.clientHelloRequestPayload();
				break;
			case Al:
				s = e.clientHelloPayload(n);
				break;
			case xl:
				s = e.clientKeyExchangePayload(n);
				break;
			case zl:
				s = e.clientFinishedPayload(n);
				break;
			default: throw new Error(`Invalid handshake type ${r}`);
		}
		return {
			type: _l,
			msg_type: r,
			length: i,
			body: s
		};
	}
	static clientHelloRequestPayload() {
		return {};
	}
	static clientHelloPayload(t) {
		const r = new Vc(t.buffer), i = {
			client_version: r.readUint8Array(2),
			random: r.readUint8Array(32)
		}, n = r.readUint8();
		i.session_id = r.readUint8Array(n);
		const s = r.readUint16();
		i.cipher_suites = e.parseCipherSuites(r.readUint8Array(s).buffer);
		const o = r.readUint8();
		i.compression_methods = r.readUint8Array(o);
		const a = r.readUint16();
		return i.extensions = function(e) {
			const t = new Vc(e.buffer), r = [];
			for (; !t.isFinished();) {
				const i = t.offset, n = jc[t.readUint16()], s = t.readUint16(), o = t.readUint8Array(s);
				if (!(n in dl)) continue;
				const a = dl[n];
				r.push({
					type: n,
					data: a.decodeFromClient(o),
					raw: e.slice(i, i + 4 + s)
				});
			}
			return r;
		}(r.readUint8Array(a)), i;
	}
	static clientKeyExchangePayload(e) {
		return { exchange_keys: e.slice(1, e.length) };
	}
	static clientFinishedPayload(e) {
		return { verify_data: e };
	}
};
function Hl(e) {
	return new TransformStream({ transform(t, r) {
		for (; t.length > 0;) r.enqueue(t.slice(0, e)), t = t.slice(e);
	} });
}
var $l = class {
	static certificate(e) {
		const t = [];
		for (const n of e) t.push(Nc(n.byteLength)), t.push(new Uint8Array(ArrayBuffer.isView(n) ? n.buffer : n));
		const r = Hc(t), i = new Uint8Array([...Nc(r.byteLength), ...r]);
		return new Uint8Array([
			Pl,
			...Nc(i.length),
			...i
		]);
	}
	static async ECDHEServerKeyExchange(e, t, r, i) {
		const n = new Uint8Array(await crypto.subtle.exportKey("raw", r.publicKey)), s = new Uint8Array([
			Ml,
			...Oc(Tl),
			n.byteLength,
			...n
		]), o = await crypto.subtle.sign({
			name: "RSASSA-PKCS1-v1_5",
			hash: "SHA-256"
		}, i, new Uint8Array([
			...e,
			...t,
			...s
		])), a = new Uint8Array(o), c = new Uint8Array([ll.sha256, al.rsa]), l = new Uint8Array([
			...s,
			...c,
			...Oc(a.length),
			...a
		]);
		return new Uint8Array([
			El,
			...Nc(l.length),
			...l
		]);
	}
	static serverHello(e, t, r) {
		const i = e.extensions.map((e) => {
			switch (e.type) {
				case "server_name": return Zc.encodeForClient();
				case "ec_point_formats": return el.encodeForClient("uncompressed");
				case "renegotiation_info": return rl.encodeForClient();
				case "extended_master_secret": return tl.encodeForClient();
			}
		}).filter((e) => void 0 !== e);
		i.length > 0 && e.extensions.some((e) => "renegotiation_info" === e.type) || i.push(rl.encodeForClient());
		const n = Hc(i), s = new Uint8Array([
			...Bl,
			...t,
			0,
			...Oc(il.TLS1_CK_ECDHE_RSA_WITH_AES_128_GCM_SHA256),
			r,
			...Oc(n.length),
			...n
		]);
		return new Uint8Array([
			Il,
			...Nc(s.length),
			...s
		]);
	}
	static serverHelloDone() {
		return new Uint8Array([Cl, ...Nc(0)]);
	}
	static async createFinishedMessage(e, t) {
		const r = await crypto.subtle.digest("SHA-256", Hc(e)), i = new Uint8Array(await fl(t, new TextEncoder().encode("server finished"), r, 12));
		return new Uint8Array([
			zl,
			...Nc(i.length),
			...i
		]);
	}
	static changeCipherSpec() {
		return new Uint8Array([1]);
	}
};
function Wl(e, t) {
	return Ol.generateCertificate(e, t);
}
function Dl(e) {
	return `-----BEGIN CERTIFICATE-----\n${r = e.buffer, t = btoa(String.fromCodePoint(...new Uint8Array(r))), t.match(/.{1,64}/g)?.join("\n") || t}\n-----END CERTIFICATE-----`;
	var t, r;
}
var Ol = class {
	static async generateCertificate(e, t) {
		const r = await crypto.subtle.generateKey({
			name: "RSASSA-PKCS1-v1_5",
			hash: "SHA-256",
			modulusLength: 2048,
			publicExponent: new Uint8Array([
				1,
				0,
				1
			])
		}, !0, ["sign", "verify"]), i = await this.signingRequest(e, r.publicKey);
		return {
			keyPair: r,
			certificate: await this.sign(i, t?.privateKey ?? r.privateKey),
			tbsCertificate: i,
			tbsDescription: e
		};
	}
	static async sign(e, t) {
		const r = await crypto.subtle.sign({
			name: "RSASSA-PKCS1-v1_5",
			hash: "SHA-256"
		}, t, e.buffer);
		return ql.sequence([
			new Uint8Array(e.buffer),
			this.signatureAlgorithm("sha256WithRSAEncryption"),
			ql.bitString(new Uint8Array(r))
		]);
	}
	static async signingRequest(e, t) {
		const r = [];
		return e.keyUsage && r.push(this.keyUsage(e.keyUsage)), e.extKeyUsage && r.push(this.extKeyUsage(e.extKeyUsage)), e.subjectAltNames && r.push(this.subjectAltName(e.subjectAltNames)), e.nsCertType && r.push(this.nsCertType(e.nsCertType)), e.basicConstraints && r.push(this.basicConstraints(e.basicConstraints)), ql.sequence([
			this.version(e.version),
			this.serialNumber(e.serialNumber),
			this.signatureAlgorithm(e.signatureAlgorithm),
			this.distinguishedName(e.issuer ?? e.subject),
			this.validity(e.validity),
			this.distinguishedName(e.subject),
			await this.subjectPublicKeyInfo(t),
			this.extensions(r)
		]);
	}
	static version(e = 2) {
		return ql.ASN1(160, ql.integer(new Uint8Array([e])));
	}
	static serialNumber(e = crypto.getRandomValues(new Uint8Array(4))) {
		return ql.integer(e);
	}
	static signatureAlgorithm(e = "sha256WithRSAEncryption") {
		return ql.sequence([ql.objectIdentifier(Kl(e)), ql.null()]);
	}
	static async subjectPublicKeyInfo(e) {
		return new Uint8Array(await crypto.subtle.exportKey("spki", e));
	}
	static extensions(e) {
		return ql.ASN1(163, ql.sequence(e));
	}
	static distinguishedName(e) {
		const t = [];
		for (const [r, i] of Object.entries(e)) {
			const e = [ql.objectIdentifier(Kl(r))];
			if ("countryName" === r) e.push(ql.printableString(i));
			else e.push(ql.utf8String(i));
			t.push(ql.set([ql.sequence(e)]));
		}
		return ql.sequence(t);
	}
	static validity(e) {
		return ql.sequence([ql.ASN1(Vl.UTCTime, new TextEncoder().encode(Gl(e?.notBefore ?? /* @__PURE__ */ new Date()))), ql.ASN1(Vl.UTCTime, new TextEncoder().encode(Gl(e?.notAfter ?? Xl(/* @__PURE__ */ new Date(), 10))))]);
	}
	static basicConstraints({ ca: e = !0, pathLenConstraint: t }) {
		const r = [ql.boolean(e)];
		return void 0 !== t && r.push(ql.integer(new Uint8Array([t]))), ql.sequence([ql.objectIdentifier(Kl("basicConstraints")), ql.octetString(ql.sequence(r))]);
	}
	static keyUsage(e) {
		const t = new Uint8Array([0]);
		return e?.digitalSignature && (t[0] |= 128), e?.nonRepudiation && (t[0] |= 64), e?.keyEncipherment && (t[0] |= 32), e?.dataEncipherment && (t[0] |= 16), e?.keyAgreement && (t[0] |= 8), e?.keyCertSign && (t[0] |= 4), e?.cRLSign && (t[0] |= 2), e?.encipherOnly && (t[0] |= 1), ql.sequence([
			ql.objectIdentifier(Kl("keyUsage")),
			ql.boolean(!0),
			ql.octetString(ql.bitString(t))
		]);
	}
	static extKeyUsage(e = {}) {
		return ql.sequence([
			ql.objectIdentifier(Kl("extKeyUsage")),
			ql.boolean(!0),
			ql.octetString(ql.sequence(Object.entries(e).map(([e, t]) => t ? ql.objectIdentifier(Kl(e)) : ql.null())))
		]);
	}
	static nsCertType(e) {
		const t = new Uint8Array([0]);
		return e.client && (t[0] |= 1), e.server && (t[0] |= 2), e.email && (t[0] |= 4), e.objsign && (t[0] |= 8), e.sslCA && (t[0] |= 16), e.emailCA && (t[0] |= 32), e.objCA && (t[0] |= 64), ql.sequence([ql.objectIdentifier(Kl("nsCertType")), ql.octetString(t)]);
	}
	static subjectAltName(e) {
		const t = e.dnsNames?.map((e) => {
			const t = new TextEncoder().encode(e);
			return ql.contextSpecific(2, t);
		}) || [], r = e.ipAddresses?.map((e) => {
			const t = new TextEncoder().encode(e);
			return ql.contextSpecific(7, t);
		}) || [], i = ql.octetString(ql.sequence([...t, ...r]));
		return ql.sequence([
			ql.objectIdentifier(Kl("subjectAltName")),
			ql.boolean(!0),
			i
		]);
	}
};
const Nl = {
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
function Kl(e) {
	for (const [t, r] of Object.entries(Nl)) if (r === e) return t;
	throw new Error(`OID not found for name: ${e}`);
}
const Vl = {
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
var ql = class e {
	static length_(e) {
		if (e < 128) return new Uint8Array([e]);
		{
			let t = e;
			const r = [];
			for (; t > 0;) r.unshift(255 & t), t >>= 8;
			const i = r.length, n = new Uint8Array(1 + i);
			n[0] = 128 | i;
			for (let e = 0; e < i; e++) n[e + 1] = r[e];
			return n;
		}
	}
	static ASN1(t, r) {
		const i = e.length_(r.length), n = new Uint8Array(1 + i.length + r.length);
		return n[0] = t, n.set(i, 1), n.set(r, 1 + i.length), n;
	}
	static integer(t) {
		if (0 === t.length) throw new Error("ASN.1 INTEGER magnitude must not be empty");
		let r = 0;
		for (; r < t.length - 1 && 0 === t[r] && !(128 & t[r + 1]);) r += 1;
		const i = t.subarray(r);
		if (128 & i[0]) {
			const t = new Uint8Array(i.length + 1);
			return t[0] = 0, t.set(i, 1), e.ASN1(Vl.Integer, t);
		}
		return e.ASN1(Vl.Integer, i);
	}
	static bitString(t) {
		const r = new Uint8Array([0]), i = new Uint8Array(r.length + t.length);
		return i.set(r), i.set(t, r.length), e.ASN1(Vl.BitString, i);
	}
	static octetString(t) {
		return e.ASN1(Vl.OctetString, t);
	}
	static null() {
		return e.ASN1(Vl.Null, new Uint8Array(0));
	}
	static objectIdentifier(t) {
		const r = t.split(".").map(Number), i = [40 * r[0] + r[1]];
		for (let e = 2; e < r.length; e++) {
			let t = r[e];
			const n = [];
			do
				n.unshift(127 & t), t >>= 7;
			while (t > 0);
			for (let e = 0; e < n.length - 1; e++) n[e] |= 128;
			i.push(...n);
		}
		return e.ASN1(Vl.OID, new Uint8Array(i));
	}
	static utf8String(t) {
		const r = new TextEncoder().encode(t);
		return e.ASN1(Vl.Utf8String, r);
	}
	static printableString(t) {
		const r = new TextEncoder().encode(t);
		return e.ASN1(Vl.PrintableString, r);
	}
	static sequence(t) {
		return e.ASN1(Vl.Sequence, Hc(t));
	}
	static set(t) {
		return e.ASN1(Vl.Set, Hc(t));
	}
	static ia5String(t) {
		const r = new TextEncoder().encode(t);
		return e.ASN1(Vl.IA5String, r);
	}
	static contextSpecific(t, r, i = !1) {
		const n = (i ? 160 : 128) | t;
		return e.ASN1(n, r);
	}
	static boolean(t) {
		return e.ASN1(Vl.Boolean, new Uint8Array([t ? 255 : 0]));
	}
};
function Gl(e) {
	return `${e.getUTCFullYear().toString().substr(2)}${jl(e.getUTCMonth() + 1)}${jl(e.getUTCDate())}${jl(e.getUTCHours())}${jl(e.getUTCMinutes())}${jl(e.getUTCSeconds())}Z`;
}
function jl(e) {
	return e.toString().padStart(2, "0");
}
function Xl(e, t) {
	const r = new Date(e);
	return r.setUTCFullYear(r.getUTCFullYear() + t), r;
}
function Yl(e, t) {
	const r = new Uint8Array(e.length + t.length);
	return r.set(e), r.set(t, e.length), r;
}
function Zl(e) {
	for (let t = 0; t <= e.length - 4; t++) if (13 === e[t] && 10 === e[t + 1] && 13 === e[t + 2] && 10 === e[t + 3]) return t;
	return -1;
}
function Jl(e) {
	const t = e.match(/content-length:\s*(\d+)/i);
	return t ? parseInt(t[1], 10) : 0;
}
function Ql(e, t) {
	const r = new TextDecoder().decode(e.subarray(0, t)).split("\r\n"), [i, n] = r[0].split(" "), s = /* @__PURE__ */ new Map();
	for (let a = 1; a < r.length; a++) {
		const e = r[a].indexOf(":");
		e > 0 && s.set(r[a].substring(0, e).trim().toLowerCase(), r[a].substring(e + 1).trim());
	}
	const o = t + 4;
	return {
		method: i,
		path: n,
		headers: s,
		body: o < e.length ? e.subarray(o) : null
	};
}
const eh = new Set([
	"transfer-encoding",
	"content-encoding",
	"connection",
	"keep-alive"
]);
function th(e, t, r, i) {
	const n = new Uint8Array(i);
	let s = `HTTP/1.1 ${e} ${t}\r\n`;
	r.forEach((e, t) => {
		eh.has(t.toLowerCase()) || "content-length" === t.toLowerCase() || (s += `${t}: ${e}\r\n`);
	}), s += `Content-Length: ${n.length}\r\n`, s += "\r\n";
	const o = new TextEncoder().encode(s), a = new Uint8Array(o.length + n.length);
	return a.set(o), a.set(n, o.length), a;
}
var rh = class {
	connections = /* @__PURE__ */ new Map();
	hostnameMap = /* @__PURE__ */ new Map();
	corsProxyUrl;
	dnsAliases;
	createTlsConnection;
	caKeyPair = null;
	caCert = null;
	caCertPEM = "";
	initialized = !1;
	constructor(e) {
		this.corsProxyUrl = e?.corsProxyUrl?.trim() ?? "", this.dnsAliases = e?.dnsAliases ?? { "proxy.local": "https://registry.npmjs.org" }, this.createTlsConnection = e?.createTlsConnection ?? (() => new Ul());
	}
	async init() {
		this.initialized || (this.caCert = await Wl({
			subject: {
				commonName: "WASM POSIX MITM CA",
				organizationName: "WASM POSIX Kernel"
			},
			basicConstraints: { ca: !0 },
			keyUsage: {
				keyCertSign: !0,
				cRLSign: !0
			}
		}), this.caKeyPair = this.caCert.keyPair, this.caCertPEM = Dl(this.caCert.certificate), this.initialized = !0);
	}
	getCACertPEM() {
		return this.caCertPEM;
	}
	getaddrinfo(e) {
		const t = function(e) {
			if (!/^[0-9.]+$/.test(e)) return null;
			if (!/^\d+(?:\.\d+){0,3}$/.test(e)) throw Rc(e);
			const t = e.split("."), r = 1 === t.length ? [32n] : 2 === t.length ? [8n, 24n] : 3 === t.length ? [
				8n,
				8n,
				16n
			] : [
				8n,
				8n,
				8n,
				8n
			];
			let i = 0n;
			for (let n = 0; n < t.length; n++) {
				const s = BigInt(t[n]), o = r[n];
				if (s > (1n << o) - 1n) throw Rc(e);
				i = i << o | s;
			}
			return new Uint8Array([
				Number(i >> 24n & 255n),
				Number(i >> 16n & 255n),
				Number(i >> 8n & 255n),
				Number(255n & i)
			]);
		}(e);
		if (t) return t;
		Uc(e, this.dnsAliases);
		const r = this.syntheticIp(e), i = this.ipKey(r);
		return this.hostnameMap.set(i, e), r;
	}
	connect(e, t, r) {
		const i = this.ipKey(t), n = this.hostnameMap.get(i) || i;
		443 === r ? this.connectTls(e, t, r, n) : this.connections.set(e, {
			kind: "http",
			hostname: n,
			ip: new Uint8Array(t),
			port: r,
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
	send(e, t, r) {
		const i = this.connections.get(e);
		if (!i) throw new Error("ENOTCONN");
		return "tls" === i.kind ? this.tlsSend(i, t) : this.httpSend(i, t);
	}
	recv(e, t, r) {
		const i = this.connections.get(e);
		if (!i) throw new Error("ENOTCONN");
		return "tls" === i.kind ? this.tlsRecv(i, t, r) : this.httpRecv(i, t, r);
	}
	close(e) {
		const t = this.connections.get(e);
		t && ("tls" === t.kind && (t.closed = !0, t.tls.close().catch(() => {})), this.connections.delete(e));
	}
	connectTls(e, t, r, i) {
		const n = this.createTlsConnection(), s = n.clientEnd.upstream.writable.getWriter(), o = n.serverEnd.downstream.writable.getWriter(), a = {
			kind: "tls",
			hostname: i,
			ip: new Uint8Array(t),
			port: r,
			tls: n,
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
		const c = n.clientEnd.downstream.readable.getReader();
		(async () => {
			try {
				for (;;) {
					const { value: e, done: t } = await c.read();
					if (t) break;
					e && e.length > 0 && (a.clientDownstreamBuf = Yl(a.clientDownstreamBuf, e));
				}
			} catch {} finally {
				a.closed = !0;
			}
		})();
		const l = n.serverEnd.upstream.readable.getReader();
		(async () => {
			try {
				for (;;) {
					const { value: e, done: t } = await l.read();
					if (t) break;
					e && e.length > 0 && (a.plaintextBuf = Yl(a.plaintextBuf, e), this.tryProcessHttpRequest(a));
				}
			} catch {}
		})(), this.startHandshake(e, a).catch((e) => {
			a.error = e, a.closed = !0;
		});
	}
	async startHandshake(e, t) {
		if (!this.caKeyPair || !this.caCert) throw new Error("CA not initialized — call init() first");
		const r = await Wl({
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
		t.tls.TLSHandshake(r.keyPair.privateKey, [r.certificate, this.caCert.certificate]).then(() => {
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
	tlsRecv(e, t, r) {
		if (e.error) throw e.error;
		if (e.clientDownstreamBuf.length > 0) {
			const i = Math.min(t, e.clientDownstreamBuf.length), n = e.clientDownstreamBuf.slice(0, i);
			return 2 & r || (e.clientDownstreamBuf = e.clientDownstreamBuf.subarray(i)), n;
		}
		if (e.closed) return new Uint8Array(0);
		throw new Fc();
	}
	tryProcessHttpRequest(e) {
		if (e.httpResponsePending || e.closed) return;
		const t = Zl(e.plaintextBuf);
		if (-1 === t) return;
		const r = Jl(new TextDecoder().decode(e.plaintextBuf.subarray(0, t))), i = t + 4, n = e.plaintextBuf.length - i;
		if (r > 0 && n < r) return;
		e.httpResponsePending = !0;
		const { method: s, path: o, headers: a, body: c } = Ql(e.plaintextBuf, t), l = t + 4 + Math.max(r, 0);
		e.plaintextBuf = e.plaintextBuf.subarray(l);
		const h = `https://${a.get("host") || e.hostname}${o}`, d = this.corsProxyUrl ? _c(this.corsProxyUrl, h) : h, f = new Headers();
		for (const [p, m] of a) {
			const e = p.toLowerCase();
			"host" !== e && "connection" !== e && f.set(p, m);
		}
		const u = c && c.length > 0 ? new Uint8Array(c) : void 0;
		(async () => {
			try {
				const t = await fetch(d, {
					method: s,
					headers: f,
					body: "GET" !== s && "HEAD" !== s ? u : void 0
				}), r = th(t.status, t.statusText, t.headers, await t.arrayBuffer());
				await e.serverDownstreamWriter.write(r), await e.serverDownstreamWriter.close();
			} catch (ys) {
				const r = `Error fetching ${d}: ${ys}`, i = th(502, "Bad Gateway", new Headers({ "Content-Type": "text/plain" }), new TextEncoder().encode(r).buffer);
				try {
					await e.serverDownstreamWriter.write(i), await e.serverDownstreamWriter.close();
				} catch {}
			}
			e.httpResponsePending = !1;
		})();
	}
	httpSend(e, t) {
		const r = new Uint8Array(e.sendBuf.length + t.length);
		r.set(e.sendBuf), r.set(t, e.sendBuf.length), e.sendBuf = r;
		const i = Zl(e.sendBuf);
		if (-1 === i) return t.length;
		const n = Jl(new TextDecoder().decode(e.sendBuf.subarray(0, i))), s = i + 4, o = e.sendBuf.length - s;
		if (n > 0 && o < n) return t.length;
		const { method: a, path: c, headers: l, body: h } = Ql(e.sendBuf, i), d = l.get("host"), f = 443 === e.port ? "https" : "http", u = 80 === e.port || 443 === e.port ? "" : `:${e.port}`, p = d || `${e.hostname}${u}`, m = this.dnsAliases[e.hostname], g = void 0 !== m ? `${m}${c}` : `${f}://${p}${c}`, y = this.corsProxyUrl ? _c(this.corsProxyUrl, g) : g, w = "https://registry.npmjs.org" === m, b = new Headers();
		for (const [_, k] of l) {
			const e = _.toLowerCase();
			"host" !== e && "connection" !== e && b.set(_, k);
		}
		const S = h && h.length > 0 ? new Uint8Array(h) : void 0;
		return e.fetchDone = !1, e.responseBuf = null, e.responseOffset = 0, e.fetchError = null, (async () => {
			try {
				const t = await fetch(y, {
					method: a,
					headers: b,
					body: S
				});
				let r = await t.arrayBuffer();
				if (w && (t.headers.get("content-type") || "").includes("json")) {
					const t = new TextDecoder().decode(r), i = t.replace(/"tarball"\s*:\s*"https:\/\/registry\.npmjs\.org/g, `"tarball":"http://${e.hostname}`);
					i !== t && (r = new TextEncoder().encode(i).buffer);
				}
				e.responseBuf = th(t.status, t.statusText, t.headers, r), e.fetchDone = !0;
			} catch (t) {
				e.fetchError = t, e.fetchDone = !0;
			}
		})(), e.sendBuf = new Uint8Array(0), t.length;
	}
	httpRecv(e, t, r) {
		if (!e.fetchDone) throw new Fc();
		if (e.fetchError) throw e.fetchError;
		if (!e.responseBuf) return new Uint8Array(0);
		const i = e.responseBuf.length - e.responseOffset, n = Math.min(t, i);
		if (0 === n) return new Uint8Array(0);
		const s = e.responseBuf.slice(e.responseOffset, e.responseOffset + n);
		return 2 & r || (e.responseOffset += n), s;
	}
	poll(e, t) {
		const r = this.connections.get(e);
		if (!r) throw Object.assign(/* @__PURE__ */ new Error("ENOTCONN"), { errno: 107 });
		let i = 0;
		return 4 & t && ("http" === r.kind || !r.closed) && (i |= 4), "http" === r.kind ? r.fetchError ? 8 | i : (1 & t && r.responseBuf && r.responseOffset < r.responseBuf.length && (i |= 1), r.fetchDone && r.responseBuf && r.responseOffset >= r.responseBuf.length && (i |= 16), i) : r.error ? 8 | i : (1 & t && r.clientDownstreamBuf.length > 0 && (i |= 1), r.closed && 0 === r.clientDownstreamBuf.length && (i |= 16), i);
	}
	syntheticIp(e) {
		let t = 0;
		for (let r = 0; r < e.length; r++) t = (t << 5) - t + e.charCodeAt(r) | 0;
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
BigInt(Number.MAX_SAFE_INTEGER);
if (Math.max(12, 24, 16, 32, 20, 40) > 4096) throw new Error("invalid fork-save scratch-page geometry");
J.map(({ name: e }) => e);
const ih = [
	{
		category: "arithmetic",
		signum: 8,
		signalName: "SIGFPE",
		patterns: [
			/divide by zero/i,
			/division by zero/i,
			/remainder by zero/i,
			/integer overflow/i,
			/integer divide by zero/i
		]
	},
	{
		category: "memory",
		signum: 11,
		signalName: "SIGSEGV",
		patterns: [
			/memory access out of bounds/i,
			/out of bounds memory access/i,
			/out-of-bounds memory/i,
			/index out of bounds.*memory/i,
			/memory out of bounds/i,
			/unaligned accesses?/i
		]
	},
	{
		category: "bounds",
		signum: 11,
		signalName: "SIGSEGV",
		patterns: [
			/RuntimeError:[^\n]*\bindex out of bounds\b/i,
			/table index (?:is )?out of bounds/i,
			/table index (?:is )?outside/i,
			/out of bounds call_indirect/i,
			/indirect call.*out of bounds/i
		]
	},
	{
		category: "illegal-instruction",
		signum: 4,
		signalName: "SIGILL",
		patterns: [
			/\bunreachable\b/i,
			/call_indirect.*null/i,
			/call_indirect.*type mismatch/i,
			/call_indirect.*signature.*does not match/i,
			/indirect call.*null/i,
			/indirect call.*type mismatch/i,
			/function signature mismatch/i,
			/signature mismatch/i,
			/signature.*does not match/i,
			/type mismatch/i,
			/null function/i,
			/undefined element/i,
			/uninitialized element/i
		]
	},
	{
		category: "stack",
		signum: 11,
		signalName: "SIGSEGV",
		patterns: [
			/maximum call stack/i,
			/call stack size exceeded/i,
			/call stack exhausted/i,
			/stack overflow/i,
			/stack exhausted/i
		]
	}
];
function nh(e) {
	const t = function(e) {
		return e instanceof Error ? e.stack ? `${e.message}\n${e.stack}` : e.message : String(e ?? "");
	}(e);
	if (!t) return null;
	for (const r of ih) for (const e of r.patterns) {
		const i = e.exec(t);
		if (i) return {
			category: r.category,
			signum: r.signum,
			signalName: r.signalName,
			matched: i[0]
		};
	}
	return null;
}
function sh(e) {
	return 128 + e;
}
function oh(e, t = 11) {
	return nh(e)?.signum ?? t;
}
function ah(e) {
	const t = nh(e);
	return t ? sh(t.signum) : null;
}
function ch(e) {
	return e >= 128 ? e - 128 & 127 : null;
}
function lh(e, t, r) {
	const i = e.memory.buffer;
	return "undefined" != typeof SharedArrayBuffer && i instanceof SharedArrayBuffer ? !Number.isSafeInteger(t) || t < 0 || t >= i.byteLength || !Number.isSafeInteger(r) || r < 0 || r >= i.byteLength ? null : new Uint8Array(i) : null;
}
function hh() {
	let e, t = !1;
	return {
		get settled() {
			return t;
		},
		promise: new Promise((t) => {
			e = t;
		}),
		settle() {
			t || (t = !0, e());
		}
	};
}
function dh(e) {
	switch (e) {
		case "pick-listener":
		case "read": return null;
		case "inject":
		case "write": return -1;
		case "is-write-open": return !1;
	}
}
var fh = class {
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
		const r = (t + 0) * cr, i = (t + 1) * cr, n = (t + 2) * cr;
		return si(e, (t + 4) * cr, this.ptrWidth), new Uint8Array(e.buffer, n, ie).fill(0), new Uint8Array(e.buffer, r, cr).fill(0), new Uint8Array(e.buffer, i, cr).fill(0), new Uint8Array(e.buffer, i, Kr).fill(0), this.activeCount++, {
			slotStartPage: t,
			basePage: t,
			tlsOffset: r,
			forkSaveOffset: i,
			channelOffset: n,
			tlsAllocAddr: r
		};
	}
	free(e) {
		this.freePages.push(e), this.activeCount = Math.max(0, this.activeCount - 1);
	}
};
(function(e = globalThis) {
	if (void 0 !== e.setImmediate) return null;
	const t = [], r = /* @__PURE__ */ new Map();
	let i = 0, n = !1, s = !1;
	const o = new e.MessageChannel();
	function a() {
		n || s || (n = !0, o.port2.postMessage(null));
	}
	o.port1.onmessage = function() {
		n = !1, s = !0;
		const e = t.length;
		for (let n = 0; n < e && t.length > 0; n++) {
			const e = t.shift();
			if (r.delete(e.handle), !e.cancelled) try {
				e.fn(...e.args);
			} catch (i) {
				console.error("[setImmediate] callback threw:", i);
			}
		}
		s = !1, t.length > 0 && a();
	}, e.setImmediate = (e, ...n) => {
		const s = { id: ++i }, o = {
			handle: s,
			fn: e,
			args: n,
			cancelled: !1
		};
		return t.push(o), r.set(s, o), a(), s;
	}, e.clearImmediate = (e) => {
		if ("object" != typeof e || null === e) return;
		const t = r.get(e);
		void 0 !== t && (t.cancelled = !0, r.delete(t.handle));
	};
})();
const uh = 65536;
let ph, mh, gh, yh, wh, bh = 16384, Sh = Nr;
const _h = function(e = 4194304) {
	if (!Number.isSafeInteger(e) || e < 0) throw new Error(`invalid process memory retirement pressure: ${e}`);
	let t = !1;
	return (r) => {
		0 === e || t || (t = !0, setTimeout(() => {
			new ArrayBuffer(e), t = !1;
		}, 0));
	};
}();
let kh = [];
let vh = !1, Ah = null;
const Ih = [];
let Ph = Promise.resolve();
const Eh = new class {
	snapshotActive = !1;
	activeMutations = 0;
	mutationDrainWaiters = [];
	beginMutation(e) {
		if (this.snapshotActive) throw new Error(`rootfs export is in progress; cannot ${e}`);
		this.activeMutations += 1;
		let t = !1;
		return () => {
			if (t) throw new Error(`rootfs snapshot mutation released twice: ${e}`);
			if (t = !0, this.activeMutations -= 1, 0 === this.activeMutations) {
				const e = this.mutationDrainWaiters.splice(0);
				for (const t of e) t();
			}
		};
	}
	async runSnapshot(e) {
		if (this.snapshotActive) throw new Error("rootfs export is already in progress");
		this.snapshotActive = !0;
		try {
			return 0 !== this.activeMutations && await new Promise((e) => {
				this.mutationDrainWaiters.push(e);
			}), await e();
		} finally {
			this.snapshotActive = !1;
		}
	}
}(), Ch = new class {
	open = !0;
	activeCreators = 0;
	drainWaiters = /* @__PURE__ */ new Set();
	destroyOperation;
	run(e, t) {
		if (!this.open) return Promise.reject(/* @__PURE__ */ new Error(`kernel worker is being destroyed; cannot start ${e}`));
		let r;
		this.activeCreators += 1;
		try {
			r = t();
		} catch (i) {
			return this.releaseCreator(), Promise.reject(i);
		}
		return Promise.resolve(r).finally(() => {
			this.releaseCreator();
		});
	}
	closeAndWait() {
		return this.open = !1, 0 === this.activeCreators ? Promise.resolve() : new Promise((e) => {
			this.drainWaiters.add(e);
		});
	}
	closeAndRunAfterDrain(e) {
		if (this.destroyOperation) return this.destroyOperation;
		const t = this.closeAndWait().then(() => e());
		return this.destroyOperation = t, t;
	}
	releaseCreator() {
		if (this.activeCreators <= 0) throw new Error("process memory creator admission released twice");
		if (this.activeCreators -= 1, !this.open && 0 === this.activeCreators) {
			for (const e of this.drainWaiters) e();
			this.drainWaiters.clear();
		}
	}
}(), xh = /* @__PURE__ */ new Map(), zh = /* @__PURE__ */ new Map(), Mh = new class {
	currentGeneration;
	scheduler;
	entries = /* @__PURE__ */ new Map();
	constructor(e, t = function() {
		return {
			now: () => performance.now(),
			set: (e, t) => setTimeout(e, t),
			clear: (e) => clearTimeout(e)
		};
	}()) {
		this.currentGeneration = e, this.scheduler = t;
	}
	handleRequest(e, t, r) {
		return r.seconds > 0 ? this.arm(e, t, r) : this.cancel(e, t);
	}
	arm(e, t, r) {
		if (this.currentGeneration(e) !== t) return !1;
		if (this.clear(e), !(Number.isFinite(r.seconds) && r.seconds > 0)) return !1;
		if (!lh(t, r.timedOutPtr, r.vmInterruptPtr)) return !1;
		const i = this.scheduler.now(), n = 1e3 * r.seconds, s = i + n;
		if (!Number.isFinite(i) || !Number.isFinite(n) || !Number.isFinite(s)) return !1;
		const o = {
			generation: t,
			deadlineMs: s,
			timedOutPtr: r.timedOutPtr,
			vmInterruptPtr: r.vmInterruptPtr
		};
		return this.entries.set(e, o), this.schedule(e, o), !0;
	}
	cancel(e, t) {
		return this.currentGeneration(e) === t && (this.clear(e, t), !0);
	}
	clear(e, t) {
		const r = this.entries.get(e);
		return !(!r || void 0 !== t && r.generation !== t) && (void 0 !== r.handle && (this.scheduler.clear(r.handle), r.handle = void 0), this.entries.delete(e), !0);
	}
	clearAll() {
		for (const [e] of this.entries) this.clear(e);
	}
	get activeCount() {
		return this.entries.size;
	}
	schedule(e, t) {
		if (this.entries.get(e) !== t || this.currentGeneration(e) !== t.generation) return void this.discardIfCurrent(e, t);
		const r = t.deadlineMs - this.scheduler.now();
		if (r <= 0) return void this.fire(e, t);
		const i = Math.min(2147483647, Math.max(1, Math.ceil(r))), n = this.scheduler.set(() => {
			this.entries.get(e) === t && t.handle === n && (t.handle = void 0, this.schedule(e, t));
		}, i);
		t.handle = n;
	}
	fire(e, t) {
		if (this.entries.get(e) !== t || this.currentGeneration(e) !== t.generation) return void this.discardIfCurrent(e, t);
		const r = lh(t.generation, t.timedOutPtr, t.vmInterruptPtr);
		this.entries.delete(e), t.handle = void 0, r && (Atomics.store(r, t.timedOutPtr, 1), Atomics.store(r, t.vmInterruptPtr, 1));
	}
	discardIfCurrent(e, t) {
		this.entries.get(e) === t && (void 0 !== t.handle && (this.scheduler.clear(t.handle), t.handle = void 0), this.entries.delete(e));
	}
}((e) => xh.get(e)), Th = /* @__PURE__ */ new Set();
let Lh = 1, Bh = 1;
const Rh = /* @__PURE__ */ new Map(), Uh = /* @__PURE__ */ new Set(), Fh = 250, Hh = /* @__PURE__ */ new WeakSet();
async function $h(e, t, r = 0) {
	if (r > 4) return null;
	const i = await Rd(e);
	if (!i) return null;
	const n = function(e) {
		const t = new Uint8Array(e);
		if (t.length < 2 || 35 !== t[0] || 33 !== t[1]) return null;
		let r = 2;
		for (; r < t.length && 10 !== t[r] && r < 4096;) r++;
		const i = new TextDecoder().decode(t.subarray(2, r)).replace(/\r$/, "").trim();
		if (!i) return null;
		const n = i.match(/^(\S+)(?:\s+(.*))?$/);
		return n ? {
			interpreter: n[1],
			arg: n[2]
		} : null;
	}(i);
	if (!n) {
		if (!lr(i)) return { errno: 8 };
		let e;
		try {
			e = await WebAssembly.compile(i);
		} catch (o) {
			if (o instanceof WebAssembly.CompileError) return { errno: 8 };
			throw o;
		}
		const r = br(i, "__abi_version");
		return null !== r && r !== ph.getKernelAbiVersion() ? { errno: 8 } : {
			programBytes: i,
			programModule: e,
			argv: t
		};
	}
	const s = [
		n.interpreter,
		...n.arg ? [n.arg] : [],
		e,
		...t.slice(1)
	];
	return $h(n.interpreter, s, r + 1);
}
const Wh = /* @__PURE__ */ new Map(), Dh = /* @__PURE__ */ new Map(), Oh = new class {
	terminators = /* @__PURE__ */ new Map();
	pendingExits = /* @__PURE__ */ new Set();
	register(e, t, r) {
		const i = this.key(e, t);
		this.terminators.set(i, r), this.pendingExits.delete(i) && r();
	}
	release(e, t) {
		const r = this.key(e, t);
		this.terminators.delete(r), this.pendingExits.delete(r);
	}
	requestExit(e, t) {
		const r = this.key(e, t), i = this.terminators.get(r);
		return i ? (i(), !0) : (this.pendingExits.add(r), !0);
	}
	key(e, t) {
		return `${e}:${t}`;
	}
}();
async function Nh(e) {
	return await async function(e, t) {
		if (e.settled) return !0;
		let r;
		return await Promise.race([e.promise, new Promise((e) => {
			r = setTimeout(e, t);
		})]), void 0 !== r && clearTimeout(r), e.settled;
	}(e, 100);
}
async function Kh(e, t) {
	return async function(e, t, r) {
		if (e.settled && t.settled) return !0;
		let i;
		return await Promise.race([Promise.all([e.promise, t.promise]), new Promise((e) => {
			i = setTimeout(e, r);
		})]), void 0 !== i && clearTimeout(i), e.settled && t.settled;
	}(e, t, 5e3);
}
function Vh(e, t, r) {
	e.pid === t && Mh.handleRequest(t, r, e);
}
function qh(e) {
	return new Promise((t) => setTimeout(t, e));
}
function Gh(e) {
	const t = e.lastIndexOf("/");
	return t >= 0 ? e.slice(t + 1) : e;
}
function jh(e) {
	const t = "nginx" === Gh(e?.[0] ?? "") ? "/var/log/nginx.log" : null;
	if (!t) return null;
	const r = function(e) {
		try {
			const t = gh.open(e, 0, 0);
			try {
				const e = gh.fstat(t).size;
				if (e <= 0) return gh.close(t), null;
				const r = new Uint8Array(e), i = gh.read(t, r, null, e);
				return gh.close(t), i <= 0 ? null : r.buffer.slice(r.byteOffset, r.byteOffset + i);
			} catch {
				return gh.close(t), null;
			}
		} catch {
			return null;
		}
	}(t);
	return r && 0 !== r.byteLength ? `${t}:\n${new TextDecoder("utf-8", { fatal: !1 }).decode(r).trimEnd() || "<empty>"}` : `${t}: <empty>`;
}
function Xh(e) {
	const t = xh.get(e), r = jh(t?.argv), i = ph.dumpLastSyscalls(e) || "<none>";
	return [
		`argv=${JSON.stringify(t?.argv ?? [])}`,
		r,
		`last syscalls:\n${i}`
	].filter((e) => null !== e).join("\n");
}
async function Yh() {
	for (; zh.size > 0 || Th.size > 0;) await Promise.allSettled([...zh.values(), ...Th]);
}
async function Zh(e, t, r, i) {
	zh.has(r) || Md(e, t, i, r), await zh.get(r);
}
async function Jh(e, t = 0) {
	Hh.add(e);
	const r = (async () => {
		await e.terminate().catch(() => {}), t > 0 && await qh(t);
	})();
	Th.add(r), r.finally(() => Th.delete(r)), await r;
}
async function Qh(e, t = !1) {
	const r = Dh.get(e);
	if (!r) return !0;
	Dh.delete(e);
	const i = (await Promise.all(r.map((e) => t ? Kh(e.execRetirement, e.workerQuiescence) : Nh(e.workerQuiescence)))).every(Boolean);
	for (const n of r) Hh.add(n.worker);
	for (const n of r) await (n.termination ?? Jh(n.worker, Fh)), Oh.release(e, n.channelOffset);
	return i;
}
const ed = /* @__PURE__ */ new Map(), td = new class {
	current;
	removeCurrent;
	pending = /* @__PURE__ */ new Map();
	completed = /* @__PURE__ */ new WeakMap();
	constructor(e, t) {
		this.current = e, this.removeCurrent = t;
	}
	get pendingCount() {
		return this.pending.size;
	}
	hasPending(e) {
		return this.pending.has(e);
	}
	async detach(e) {
		const t = this.completed.get(e.generation);
		if (t) return {
			...t,
			removedCurrent: !1,
			mayReapPid: !1
		};
		let r = this.pending.get(e.generation);
		if (r) {
			const t = r.transaction;
			if (t.pid !== e.pid || t.memory !== e.memory) throw new Error("process generation was queued with conflicting detach identity");
		} else r = {
			transaction: e,
			detached: !1,
			settled: !1,
			retired: !1,
			postCommitFailed: !1
		}, this.pending.set(e.generation, r);
		return this.run(r);
	}
	async retryPending() {
		const e = [];
		for (const t of [...this.pending.values()]) e.push(await this.run(t));
		return e;
	}
	async run(e) {
		if (e.active) {
			const t = await e.active;
			return "released" !== t.status ? t : {
				...t,
				removedCurrent: !1,
				mayReapPid: !1
			};
		}
		const t = this.perform(e);
		e.active = t;
		try {
			return await t;
		} finally {
			e.active === t && (e.active = void 0);
		}
	}
	async perform(e) {
		const { transaction: t } = e;
		try {
			if (!e.detached) {
				const r = await t.detach(t.pid, t.memory);
				e.detached = !0, e.detachDisposition = r ? "removed-or-absent" : "superseded";
			}
			if (e.settled || (await t.settle(t.pid, t.memory), e.settled = !0), !e.retired) try {
				if (await t.retire(() => {
					if (e.retired) throw new Error("process generation retirement committed more than once");
					e.retired = !0;
				}), !e.retired) throw new Error("process generation retirement returned without committing");
			} catch (r) {
				if (!e.retired) throw r;
				e.postCommitFailed = !0, e.postCommitError = r;
			}
			let i = !1;
			if (this.current(t.pid) === t.generation) {
				if (this.removeCurrent(t.pid, t.generation), this.current(t.pid) === t.generation) throw new Error("exact process generation cleanup left the generation current");
				i = !0;
			}
			const n = {
				status: "released",
				removedCurrent: i,
				mayReapPid: i && "removed-or-absent" === e.detachDisposition,
				detachDisposition: e.detachDisposition,
				...e.postCommitFailed ? { postCommitError: e.postCommitError } : {}
			};
			return this.completed.set(t.generation, n), this.pending.delete(t.generation), n;
		} catch (r) {
			return {
				status: "retained-error",
				removedCurrent: !1,
				mayReapPid: !1,
				error: r
			};
		}
	}
}((e) => xh.get(e), (e, t) => {
	const r = xh.get(e);
	r === t && (Mh.clear(e, r), xh.delete(e), Wh.delete(e), Uh.delete(e), ed.delete(e));
});
async function rd(e) {
	const { pid: t, generation: r, operation: i, retire: n } = e, s = await td.detach({
		pid: t,
		generation: r,
		memory: r.memory,
		detach: () => "none" === i || ("deactivate" === i ? ph.deactivateProcess(t, r.memory) : ph.unregisterProcess(t, r.memory)),
		settle: () => {
			if ("none" !== i) return ph.settleRetiredChannelListeners(t, r.memory);
		},
		retire: n
	});
	if ("released" === s.status && "postCommitError" in s) try {
		fd({
			pid: t,
			source: "process memory retirement",
			message: `[browser-kernel-worker] pid ${t} retired its exact process memory before a cleanup callback failed: ${md(s.postCommitError)}`
		});
	} catch {}
	return s;
}
function id(e, t, r, i) {
	try {
		fd({
			pid: e,
			source: t,
			...void 0 === i ? {} : { status: i },
			message: `[browser-kernel-worker] retained pid ${e}'s exact process memory: ` + md(r.error)
		});
	} catch {}
}
let nd = null, sd = null, od = null, ad = 1;
const cd = /* @__PURE__ */ new Set();
function ld(e, t) {
	globalThis.postMessage(e, t ?? []);
}
function hd() {
	const e = Lh++;
	if (!Number.isSafeInteger(e)) throw new Error("browser process execution generation space exhausted");
	return e;
}
function dd(e, t) {
	if (!t.framebufferExposed) return Promise.resolve(!0);
	if (t.framebufferRelease) return t.framebufferRelease;
	const r = Bh++;
	return t.framebufferRelease = new Promise((i) => {
		const n = setTimeout(() => {
			Rh.delete(r) && i(!1);
		}, 2e3);
		Rh.set(r, {
			resolve: i,
			timeout: n
		}), ld({
			type: "fb_release_generation",
			requestId: r,
			pid: e,
			generation: t.generation
		});
	}).then((r) => (r && ld({
		type: "fb_forget_generation",
		pid: e,
		generation: t.generation
	}), r)), t.framebufferRelease;
}
function fd(e, t = "error") {
	"warn" === t ? console.warn(e.message) : console.error(e.message), ld({
		type: "host_diagnostic",
		...e
	});
}
function ud() {
	ld({
		type: "http_bridge_pending",
		count: cd.size
	});
}
function pd() {
	0 !== cd.size && (cd.clear(), ud());
}
function md(e) {
	return e instanceof Error ? e.stack ? `${e.message}\n${e.stack}` : e.message : String(e);
}
function gd(e) {
	if (!e || "object" != typeof e) return !1;
	const t = e.code;
	return -2 === t || "ENOENT" === t;
}
function yd(e, t) {
	ld({
		type: "response",
		requestId: e,
		result: t
	});
}
function wd(e, t) {
	ld({
		type: "response",
		requestId: e,
		result: null,
		error: t
	});
}
function bd(e, t) {
	"number" == typeof e.requestId && wd(e.requestId, t);
}
function Sd(e) {
	fd({
		pid: 0,
		source: "worker protocol",
		message: `[kernel-worker] ${e}`
	});
}
async function _d(e) {
	"register_lazy_files" === e.type ? gh.importLazyEntries(e.entries) : await gh.importVerifiedLazyArchiveEntries(e.entries), function(e, t) {
		"number" == typeof e.requestId && yd(e.requestId, t);
	}(e, !0);
}
function kd(e) {
	const t = Ih.splice(0);
	for (const r of t) bd(r, e);
}
function vd(e) {
	const t = Ph.then(async () => {
		const t = Eh.beginMutation("register lazy rootfs entries");
		try {
			await _d(e);
		} finally {
			t();
		}
	});
	return Ph = t.catch(() => {}), t;
}
function Ad(e, t) {
	const r = md(t);
	bd(e, r), Sd(`${e.type} failed: ${r}`);
}
async function Id(e) {
	if (Ah) return bd(e, Ah), void Sd(`${e.type} rejected because kernel worker init failed: ${Ah}`);
	if (vh) try {
		await vd(e);
	} catch (ys) {
		Ad(e, ys);
	}
	else Ih.push(e);
}
function Pd(e, t, r) {
	return new fh({
		firstSlotStartPage: e.firstThreadSlotPage,
		maxPageExclusive: e.threadArenaEndPage,
		ptrWidth: t,
		reservedSlots: e.threadSlotCount,
		reserveSlotStartPage: () => ph.reserveHostRegion(r, 262144) / uh
	});
}
async function Ed(e, t, r, i = bh, n) {
	const s = wr(t), o = Zr({
		maxPages: i,
		defaultThreadSlots: Sh,
		ptrWidth: r,
		programBytes: t,
		heapBase: s
	});
	let a;
	try {
		a = await wh.acquireWhenAvailable({
			ptrWidth: r,
			initialPages: o.initialPages,
			maximumPages: o.maximumPages
		});
	} catch (c) {
		throw console.error("[kernel-worker] process memory allocation failed", JSON.stringify(function(e, t, r, i, n) {
			let s = 0;
			const o = Array.from(xh.entries()).sort(([e], [t]) => e - t).map(([e, t]) => {
				const r = t.memory.buffer.byteLength;
				return s += r, {
					pid: e,
					argv: t.argv.slice(0, 8),
					ptrWidth: t.ptrWidth,
					currentPages: Math.ceil(r / uh),
					maximumPages: t.layout.maximumPages,
					bufferBytes: r
				};
			});
			return {
				operation: n?.operation,
				pid: e,
				path: n?.path,
				argv: n?.argv,
				ptrWidth: t,
				heapBase: null == i ? null : i.toString(),
				requestedLayout: {
					initialPages: r.initialPages,
					maximumPages: r.maximumPages,
					controlBase: r.controlBase,
					brkBase: r.brkBase,
					mmapBase: r.mmapBase,
					maxAddr: r.maxAddr,
					threadSlotCount: r.threadSlotCount,
					threadArenaEndPage: r.threadArenaEndPage
				},
				liveProcessCount: xh.size,
				pendingProcessTeardowns: zh.size,
				pendingWorkerTeardowns: Th.size,
				totalLiveBufferBytes: s,
				liveProcesses: o
			};
		}(e, r, o, s, n))), c;
	}
	try {
		const t = a.memory;
		return new Uint8Array(t.buffer, o.channelOffset, ie).fill(0), {
			memory: t,
			memoryLease: a,
			layout: o,
			threadAllocator: Pd(o, r, e)
		};
	} catch (l) {
		throw a.release(), l;
	}
}
async function Cd(e) {
	vh = !1, Ah = null, bh = e.config.maxMemoryPages, Sh = e.config.defaultThreadSlots ?? Nr, kh = e.config.env, wh = new ii({
		maxMemories: Math.max(1, Math.floor(e.config.maxProcessMemoryBytes / uh)),
		maxTotalBytes: e.config.maxProcessMemoryBytes,
		...Qr(e.config.maxWorkers, e.config.maxProcessMemoryBytes),
		retirementPressureHook: _h
	});
	const t = mc.fromExisting(e.shmSab), r = new xc(), i = await function(e, t = Tc) {
		return Bc([...t], e);
	}(e.vfsImage, e.rootfsMountSpec), n = i.find((e) => "/" === e.mountPoint);
	if (!n) throw new Error("rootfs mount spec missing / mount");
	gh = n.backend, e.lazyUrlBase && (gh.rewriteLazyFileUrls((t) => kc(e.lazyUrlBase, t)), gh.rewriteLazyArchiveUrls((t) => kc(e.lazyUrlBase, t))), void 0 !== e.closedLazyAssets ? gh.setLazyFetcher(yc(e.closedLazyAssets)) : e.config.corsProxyUrl?.trim() && gh.setLazyFetcher(function(e, t = {}) {
		const r = t.fetchImpl ?? ((e, t) => globalThis.fetch(e, t)), i = e.trim();
		if (0 === i.length) throw new Error("browser lazy CORS proxy URL must not be empty");
		const n = new URL(t.runtimeUrl ?? globalThis.location.href), s = new URL(i, n).href;
		return (e, t) => {
			const i = new URL(e, n);
			return "http:" !== i.protocol && "https:" !== i.protocol || i.origin === n.origin ? void 0 === t ? r(e) : r(e, t) : r(_c(s, i.href), {
				...t ?? {},
				credentials: "omit",
				referrerPolicy: "no-referrer"
			});
		};
	}(e.config.corsProxyUrl));
	const s = [
		{
			mountPoint: "/dev/shm",
			backend: t
		},
		{
			mountPoint: "/dev",
			backend: r
		},
		...i
	];
	gh.subscribeLazyDownloads((e) => {
		ld({
			type: "lazy_download",
			event: e
		});
	}), yh = new os(s, new zc());
	const o = new rh({
		dnsAliases: e.config.dnsAliases,
		corsProxyUrl: e.config.corsProxyUrl
	});
	await o.init(), yh.network = o;
	const a = o.getCACertPEM();
	try {
		for (const r of [
			"/etc",
			"/etc/ssl",
			"/etc/ssl/certs"
		]) try {
			gh.mkdir(r, 493);
		} catch {}
		const e = new TextEncoder().encode(a), t = gh.open("/etc/ssl/certs/ca-certificates.crt", 577, 420);
		gh.write(t, e, 0, e.length), gh.close(t);
	} catch (d) {
		console.error("[kernel-worker] Failed to write CA cert to VFS:", d);
	}
	mh = new ts(e.workerEntryUrl), ph = new es({
		maxWorkers: e.config.maxWorkers,
		dataBufferSize: uh,
		useSharedMemory: !0,
		defaultThreadSlots: Sh,
		enableSyscallLog: e.config.enableSyscallLog,
		syscallLogPtrWidth: e.config.syscallLogPtrWidth
	}, yh, {
		onProcessMemoryTarget: (e, t) => {
			wh.observeTarget(e, t);
		},
		onFork: ({ parentPid: e, childPid: t, parentMemory: r, continuation: i }) => Ch.run("a fork process Worker", () => (ld({
			type: "proc_event",
			kind: "spawn",
			pid: t,
			ppid: e
		}), async function(e, t, r, i) {
			const n = xh.get(e);
			if (!n || n.memory !== r) throw new Error(`Unknown parent generation for pid ${e}`);
			const s = n.ptrWidth, o = n.layout, a = ni(wh, r, s, o.maximumPages), c = a.memory, l = o.channelOffset;
			let h, d, f = !1, u = !1, p = !1;
			try {
				if (await Yh(), await wh.waitForRetirementBacklogCapacity(c.buffer.byteLength), n.programModule || (n.programModule = await WebAssembly.compile(n.programBytes)), !ph.shouldLaunchPendingChild(t)) return a.release(), [];
				new Uint8Array(c.buffer, l, ie).fill(0), ph.registerProcess(t, c, [l], {
					ptrWidth: s,
					maxAddr: o.maxAddr,
					mmapBase: o.mmapBase
				}), f = !0, ph.inheritProcessSharedMappings(e, t);
				const r = i.forkBufAddr, m = "thread" === i.kind ? {
					fnPtr: i.fnPtr,
					argPtr: i.argPtr,
					forkBufAddr: r
				} : n.forkReplayContext ? {
					...n.forkReplayContext,
					forkBufAddr: r
				} : void 0, g = {
					type: "centralized_init",
					pid: t,
					programBytes: n.programBytes,
					programModule: n.programModule,
					memory: c,
					channelOffset: l,
					isForkChild: !0,
					forkBufAddr: r,
					forkChildThreadFnPtr: m?.fnPtr,
					forkChildThreadArgPtr: m?.argPtr,
					ptrWidth: s,
					kernelAbiVersion: ph.getKernelAbiVersion()
				};
				h = new is(() => mh.createWorker(g));
				const y = h;
				d = {
					generation: hd(),
					memory: c,
					memoryLease: a,
					workerQuiescence: hh(),
					execRetirement: hh(),
					memoryRetirementSafe: !0,
					framebufferExposed: !1,
					programBytes: n.programBytes,
					programModule: n.programModule,
					worker: y,
					argv: n.argv,
					channelOffset: l,
					ptrWidth: s,
					layout: o,
					threadAllocator: Pd(o, s, t),
					forkReplayContext: m
				}, xh.set(t, d), xd(y, t);
				const w = ph.startProcessWorkerWhenRunnable(t, c, () => {
					u = !0, y.start();
				}, () => {
					y.terminate();
				});
				if ("stale" === w) throw new Error(`Fork child ${t} changed generation before Worker launch`);
				if ("dead" === w) {
					await y.terminate(), xh.get(t)?.workerQuiescence.settle();
					const e = ph.finalizePendingChildTermination(t);
					return p = !0, await Zh(t, e > 0 ? sh(e) : 0, y, e > 0 ? e : void 0), [];
				}
			} catch (m) {
				if (p) throw m;
				h && await Jh(h);
				const e = await rd({
					pid: t,
					generation: d ?? {
						memory: c,
						memoryLease: a
					},
					operation: f ? "deactivate" : "none",
					retire: async (e) => {
						const r = !d || await dd(t, d);
						u || !r ? a.releaseAfterForcedTermination() : a.release(), e();
					}
				});
				throw "released" !== e.status && id(t, "fork rollback", e), m;
			}
			return [l];
		}(e, t, r, i))),
		onExec: (e, t, r, i, n) => Ch.run("an exec process Worker", async () => {
			const s = xh.get(e)?.worker, o = await async function(e, t, r, i, n) {
				const s = xh.get(e);
				if (!s) return -3;
				if (!ph.supportsExecMetadataReplacement()) return -38;
				const o = await $h(t, r);
				if (!o) return -2;
				if ("errno" in o) return -o.errno;
				const { programBytes: a, programModule: c, argv: l } = o, h = Sr(a), d = ph.validateExecMetadata(l, i, s.ptrWidth);
				if (d < 0) return d;
				let f;
				try {
					f = await Ed(e, a, h, bh, {
						operation: "exec",
						path: t,
						argv: l
					});
				} catch (k) {
					if (k instanceof ti) return -11;
					if (k instanceof ei) return -12;
					throw k;
				}
				let u = !1, p = !1, m = !1, g = !1, y = !1, w = !1;
				if (xh.get(e) !== s || ph.isExecHandoffActive(e) || !ph.isProcessExecutionActive(e)) return f.memoryLease.release(), -3;
				const b = ph.kernelExecPrepare(e, n);
				if (b < 0) return f.memoryLease.release(), b;
				const S = ph.prepareAddressSpaceForExec(e);
				if (S < 0) return f.memoryLease.release(), S;
				let _;
				try {
					const r = ph.kernelExecSetup(e, n);
					if (r < 0) return f.memoryLease.release(), r;
					Mh.clear(e, s), s.worker && Hh.add(s.worker);
					for (const t of Dh.get(e) ?? []) Hh.add(t.worker);
					const o = ph.wakeProcessWorkersForExecRetirement(e, s.memory).has(s.channelOffset);
					if (Uh.delete(e), !ph.prepareProcessForExec(e, s.memory)) throw new Error(`Exec pid ${e} changed generation during commit`);
					if (ph.finalizeAddressSpaceForExec(e) < 0) throw new Error("failed to detach the discarded address space");
					const [d, b] = await Promise.all([o ? Kh(s.execRetirement, s.workerQuiescence) : Promise.resolve(!1), Qh(e, !0)]);
					s.worker && (Hh.add(s.worker), await s.worker.terminate().catch(() => {})), d && await ph.settleRetiredChannelListeners(e, s.memory, s.channelOffset);
					const S = await dd(e, s);
					y = d && b && s.memoryRetirementSafe && S;
					const k = ph.finalizeExecHandoffTermination(e);
					if (k > 0) return f.memoryLease.release(), p = !0, await Zh(e, sh(k), s.worker, k), 0;
					{
						const r = globalThis;
						r.__pidMap || (r.__pidMap = /* @__PURE__ */ new Map()), r.__pidMap.set(e, t);
					}
					const { memory: v, memoryLease: A, layout: I, threadAllocator: P } = f, E = I.channelOffset, C = {
						type: "centralized_init",
						pid: e,
						programBytes: a,
						programModule: c,
						memory: v,
						channelOffset: E,
						argv: l,
						env: i,
						ptrWidth: h,
						kernelAbiVersion: ph.getKernelAbiVersion()
					};
					_ = new is(() => mh.createWorker(C)), ph.registerProcess(e, v, [E], {
						preserveProcessState: !0,
						ptrWidth: h,
						metadataPtrWidth: s.ptrWidth,
						brkBase: I.brkBase,
						mmapBase: I.mmapBase,
						maxAddr: I.maxAddr,
						argv: l,
						env: i
					}), m = !0, Wh.delete(e), xh.set(e, {
						generation: hd(),
						memory: v,
						memoryLease: A,
						workerQuiescence: hh(),
						execRetirement: hh(),
						memoryRetirementSafe: !0,
						framebufferExposed: !1,
						programBytes: a,
						programModule: c,
						worker: _,
						argv: l,
						channelOffset: E,
						ptrWidth: h,
						layout: I,
						threadAllocator: P
					}), u = !0, y ? s.memoryLease.release() : s.memoryLease.releaseAfterForcedTermination(), w = !0, xd(_, e);
					const x = ph.startProcessWorkerWhenRunnable(e, v, () => {
						g = !0, _.start();
					}, () => {
						_?.terminate();
					});
					if ("stale" === x) throw new Error(`Exec pid ${e} changed generation before Worker launch`);
					if ("dead" === x) {
						xh.get(e)?.workerQuiescence.settle(), ph.finishProcessExecHandoff(e);
						const t = ph.finalizeExecHandoffTermination(e);
						return await Zh(e, t > 0 ? sh(t) : 0, _, t > 0 ? t : void 0), 0;
					}
					return ph.finishProcessExecHandoff(e), 0;
				} catch (ys) {
					s.worker && Hh.add(s.worker), Uh.delete(e);
					try {
						const t = u || m ? f.memoryLease.memory : s.memory;
						ph.prepareProcessForExec(e, t);
					} catch {}
					if (_ && xh.get(e)?.worker !== _ && await Jh(_), !u && !p) {
						const t = await rd({
							pid: e,
							generation: {
								memory: f.memoryLease.memory,
								memoryLease: f.memoryLease
							},
							operation: m ? "deactivate" : "none",
							retire: (e) => {
								g ? f.memoryLease.releaseAfterForcedTermination() : f.memoryLease.release(), e();
							}
						});
						"released" === t.status ? p = !0 : id(e, "exec replacement rollback", t, sh(11));
					}
					u && !w && (y ? s.memoryLease.release() : s.memoryLease.releaseAfterForcedTermination(), w = !0);
					const r = ys instanceof Error ? ys.message : String(ys);
					try {
						fd({
							pid: e,
							status: sh(11),
							source: "exec post-commit transition",
							message: `[exec] post-commit transition failed: ${r}`
						});
					} catch {}
					try {
						ph.notifyHostProcessCrashed(e, 11);
					} catch {}
					return Md(e, sh(11), 11), 0;
				}
			}(e, t, r, i, n), a = xh.get(e)?.worker;
			return 0 === o && a && a !== s && ph.isProcessExecutionActive(e) && ld({
				type: "proc_event",
				kind: "exec",
				pid: e
			}), o;
		}),
		onResolveSpawn: zd,
		onSpawn: (e, t, r, i) => Ch.run("a posix_spawn process Worker", () => async function(e, t, r, i) {
			if (await Yh(), !ph.shouldLaunchPendingChild(t)) return 0;
			ld({
				type: "proc_event",
				kind: "spawn",
				pid: t,
				ppid: e
			});
			const { programBytes: n, programModule: s, argv: o } = r, a = Sr(n);
			let c;
			try {
				c = await Ed(t, n, a, bh, {
					operation: "posix_spawn",
					path: o[0],
					argv: o
				});
			} catch (b) {
				if (b instanceof ti) return -11;
				if (b instanceof ei) return -12;
				throw b;
			}
			const { memory: l, memoryLease: h, layout: d, threadAllocator: f } = c;
			if (!ph.shouldLaunchPendingChild(t)) return h.release(), 0;
			const u = d.channelOffset;
			let p, m, g = !1, y = !1, w = !1;
			try {
				ph.registerProcess(t, l, [u], {
					ptrWidth: a,
					brkBase: d.brkBase,
					mmapBase: d.mmapBase,
					maxAddr: d.maxAddr
				}), g = !0;
				const e = {
					type: "centralized_init",
					pid: t,
					programBytes: n,
					programModule: s,
					memory: l,
					channelOffset: u,
					argv: o,
					env: i,
					ptrWidth: a,
					kernelAbiVersion: ph.getKernelAbiVersion()
				};
				p = new is(() => mh.createWorker(e));
				const r = p;
				m = {
					generation: hd(),
					memory: l,
					memoryLease: h,
					workerQuiescence: hh(),
					execRetirement: hh(),
					memoryRetirementSafe: !0,
					framebufferExposed: !1,
					programBytes: n,
					programModule: s,
					worker: r,
					argv: o,
					channelOffset: u,
					ptrWidth: a,
					layout: d,
					threadAllocator: f
				}, xh.set(t, m), xd(r, t);
				const c = ph.startProcessWorkerWhenRunnable(t, l, () => {
					y = !0, r.start();
				}, () => {
					r.terminate();
				});
				if ("stale" === c) throw new Error(`Spawn child ${t} changed generation before Worker launch`);
				if ("dead" === c) {
					await r.terminate(), xh.get(t)?.workerQuiescence.settle();
					const e = ph.finalizePendingChildTermination(t);
					return w = !0, await Zh(t, e > 0 ? sh(e) : 0, r, e > 0 ? e : void 0), 0;
				}
			} catch (b) {
				if (w) throw b;
				p && await Jh(p);
				const e = await rd({
					pid: t,
					generation: m ?? {
						memory: l,
						memoryLease: h
					},
					operation: g ? "deactivate" : "none",
					retire: async (e) => {
						const r = !m || await dd(t, m);
						y || !r ? h.releaseAfterForcedTermination() : h.release(), e();
					}
				});
				throw "released" !== e.status && id(t, "posix_spawn rollback", e), b;
			}
			return 0;
		}(e, t, r, i)),
		onClone: (e) => Ch.run("a pthread Worker", () => async function(e) {
			const { pid: t, tid: r, fnPtr: i, argPtr: n, stackPtr: s, tlsPtr: o, ctidPtr: a, memory: c } = e, l = xh.get(t);
			if (!l) throw new Error(`Unknown pid ${t} for clone`);
			Uh.add(t);
			let h, f = Wh.get(t), u = !1;
			if (!f) {
				const e = function(e) {
					const t = new Uint8Array(e);
					if (t.length < 8) return e;
					function r(e, t) {
						let r = 0, i = 0, n = t;
						for (;;) {
							const t = e[n++];
							if (r |= (127 & t) << i, !(128 & t)) break;
							i += 7;
						}
						return [r, n - t];
					}
					function i(e) {
						const t = [];
						do {
							let r = 127 & e;
							0 != (e >>>= 7) && (r |= 128), t.push(r);
						} while (0 !== e);
						return t;
					}
					const n = [];
					let s = 0, o = !1, a = 8;
					for (; a < t.length;) {
						const e = t[a], [i, s] = r(t, a + 1), c = a + 1 + s, l = 1 + s + i;
						n.push({
							id: e,
							offset: a,
							totalSize: l,
							contentOffset: c,
							contentSize: i
						}), 8 === e && (o = !0), a += l;
					}
					if (!o) return e;
					for (const S of n) if (2 === S.id) {
						let e = S.contentOffset;
						const [i, n] = r(t, e);
						e += n;
						for (let o = 0; o < i; o++) {
							const [i, n] = r(t, e);
							e += n + i;
							const [o, a] = r(t, e);
							e += a + o;
							const c = t[e++];
							if (0 === c) {
								s++;
								const [, i] = r(t, e);
								e += i;
							} else if (1 === c) {
								e++;
								const i = t[e++], [, n] = r(t, e);
								if (e += n, 1 & i) {
									const [, i] = r(t, e);
									e += i;
								}
							} else if (2 === c) {
								const i = t[e++], [, n] = r(t, e);
								if (e += n, 1 & i) {
									const [, i] = r(t, e);
									e += i;
								}
							} else 3 === c && (e++, e++);
						}
						break;
					}
					let c = -1, l = [];
					const h = /* @__PURE__ */ new Map();
					for (const S of n) if (7 === S.id) {
						let e = S.contentOffset;
						const [i, n] = r(t, e);
						e += n;
						for (let s = 0; s < i; s++) {
							const [i, n] = r(t, e);
							e += n;
							const s = new TextDecoder().decode(t.subarray(e, e + i));
							e += i;
							const o = t[e++], [a, c] = r(t, e);
							e += c, 0 === o && (l.push(a), h.set(s, a));
						}
						break;
					}
					function d(e) {
						const [, i] = r(t, e);
						return e + i;
					}
					function f(e) {
						return e = d(e), d(e);
					}
					function u(e, i) {
						const n = i - s;
						if (n < 0) return null;
						let o = e.contentOffset;
						const [a, c] = r(t, o);
						if (o += c, n >= a) return null;
						for (let s = 0; s < n; s++) {
							const [e, i] = r(t, o);
							o += i + e;
						}
						const [l, h] = r(t, o);
						o += h;
						const f = o + l, [u, p] = r(t, o);
						o += p;
						for (let t = 0; t < u; t++) o = d(o), o++;
						return {
							start: o,
							end: f
						};
					}
					function p(e, i) {
						const n = u(e, i);
						if (!n) return [];
						const s = [];
						let o = n.start;
						for (; o < n.end;) {
							const e = t[o++];
							if (16 === e) {
								const [e, i] = r(t, o);
								o += i, s.push(e);
							} else if (17 === e || 19 === e) o = d(o), o = d(o);
							else if (18 === e || 20 === e || 21 === e) o = d(o);
							else if (2 === e || 3 === e || 4 === e) o = 64 === t[o] || t[o] >= 112 ? o + 1 : d(o);
							else if (12 === e || 13 === e || e >= 32 && e <= 38 || 208 === e || 210 === e) o = d(o);
							else if (14 === e) {
								const [e, i] = r(t, o);
								o += i;
								for (let t = 0; t <= e; t++) o = d(o);
							} else if (e >= 40 && e <= 62) o = f(o);
							else if (63 === e || 64 === e) o++;
							else if (65 === e || 66 === e) o = d(o);
							else if (67 === e) o += 4;
							else if (68 === e) o += 8;
							else if (252 === e) {
								const [e, i] = r(t, o);
								o += i, 8 === e || 10 === e || 12 === e || 14 === e ? o = d(d(o)) : e >= 9 && e <= 17 && (o = d(o));
							} else if (254 === e) o = d(o), o = f(o);
							else if (253 === e) break;
						}
						return s;
					}
					for (const S of n) if (10 === S.id && l.length > 0) {
						const e = [
							"__wasm_init_tls",
							"__abi_version",
							"__get_channel_base_addr",
							"_start",
							"__wasm_thread_init"
						], i = /* @__PURE__ */ new Map();
						let n = 0;
						for (const t of e) {
							const e = h.get(t);
							if (void 0 === e) continue;
							const r = new Set(p(S, e).filter((e) => e >= s));
							for (const t of r) {
								const e = i.get(t);
								e ? e.count++ : i.set(t, {
									count: 1,
									firstOrder: n++
								});
							}
						}
						let o = null;
						for (const [t, r] of i) r.count >= 2 && (!o || r.count > o.count || r.count === o.count && r.firstOrder < o.firstOrder) && (o = {
							target: t,
							count: r.count,
							firstOrder: r.firstOrder
						});
						if (o) c = o.target;
						else for (const a of l) {
							const e = u(S, a);
							if (!e || 16 !== t[e.start]) continue;
							const [i] = r(t, e.start + 1);
							if (i >= s) {
								c = i;
								break;
							}
						}
						break;
					}
					const m = c >= 0 ? c - s : -1, g = [];
					g.push(t.subarray(0, 8));
					for (const S of n) if (8 !== S.id) if (10 === S.id && m >= 0) {
						let e = S.contentOffset;
						const [n, s] = r(t, e);
						e += s;
						let o = e;
						for (let i = 0; i < m; i++) {
							const [e, i] = r(t, o);
							o += i + e;
						}
						const [a, c] = r(t, o), l = o + c + a, h = new Uint8Array([
							2,
							0,
							11
						]), d = o - S.contentOffset, f = S.contentOffset + S.contentSize - l, u = i(d + h.length + f);
						g.push(new Uint8Array([10])), g.push(new Uint8Array(u)), g.push(t.subarray(S.contentOffset, o)), g.push(h), g.push(t.subarray(l, S.contentOffset + S.contentSize));
					} else g.push(t.subarray(S.offset, S.offset + S.totalSize));
					const y = g.reduce((e, t) => e + t.length, 0), w = new Uint8Array(y);
					let b = 0;
					for (const S of g) w.set(S, b), b += S.length;
					return w.buffer;
				}(l.programBytes);
				f = await WebAssembly.compile(e), u = !0;
			}
			if (!ci(xh, t, l, c, ph.isExecHandoffActive(t)) || !ph.isProcessExecutionActive(t)) throw new Error(`Process ${t} changed generation during clone`);
			u && Wh.set(t, f);
			try {
				h = l.threadAllocator.allocate(c);
			} catch (d) {
				throw fd({
					pid: t,
					source: "clone allocation",
					message: `[kernel-worker] pid=${t}: ${d instanceof Error ? d.message : String(d)}`
				}), d;
			}
			try {
				ph.attachThreadChannel(e, h.channelOffset);
			} catch (ys) {
				throw l.threadAllocator.free(h.basePage), ys;
			}
			const p = {
				type: "centralized_thread_init",
				pid: t,
				tid: r,
				programBytes: l.programBytes,
				programModule: f,
				memory: c,
				processChannelOffset: l.channelOffset,
				channelOffset: h.channelOffset,
				fnPtr: i,
				argPtr: n,
				stackPtr: s,
				tlsPtr: o,
				ctidPtr: a,
				tlsOffset: h.tlsOffset,
				tlsAllocAddr: h.tlsAllocAddr,
				ptrWidth: l.ptrWidth,
				kernelAbiVersion: ph.getKernelAbiVersion()
			}, m = new is(() => mh.createWorker(p));
			Dh.has(t) || Dh.set(t, []);
			const g = {
				worker: m,
				channelOffset: h.channelOffset,
				tid: r,
				basePage: h.slotStartPage,
				quiescent: !1,
				workerQuiescence: hh(),
				execRetirement: hh()
			};
			Dh.get(t).push(g);
			const y = () => ci(xh, t, l, c, ph.isExecHandoffActive(t));
			let w = !1;
			const b = async () => {
				w || (w = !0, g.quiescent ? (await ph.settleRetiredChannelListeners(t, c, h.channelOffset), l.threadAllocator.free(h.basePage)) : l.memoryRetirementSafe = !1, y() && Oh.release(t, h.channelOffset), function(e, t, r) {
					const i = e.get(t);
					if (!i) return !1;
					const n = i.indexOf(r);
					n < 0 || (i.splice(n, 1), 0 === i.length && e.delete(t));
				}(Dh, t, g));
			}, S = () => (g.termination || (g.termination = Jh(m, Fh).then(b)), g.termination);
			Oh.register(t, h.channelOffset, S);
			const _ = () => !Hh.has(m) && y(), k = (e, i = !1) => {
				if (!_()) return void S();
				const n = function(e) {
					const t = ah(e);
					return null === t ? { kind: "host-thread-failure" } : {
						kind: "guest-fatal-trap",
						exitStatus: t,
						signum: ch(t) ?? 11
					};
				}(e);
				fd({
					pid: t,
					status: "guest-fatal-trap" === n.kind ? n.exitStatus : void 0,
					source: "thread worker failure",
					message: `[kernel-worker] pid=${t} tid=${r}: ${e}`
				}), ph.finalizeThreadExit(t, r, h.channelOffset), i || S(), "guest-fatal-trap" === n.kind && Md(t, n.exitStatus, n.signum);
			};
			let v;
			m.on("message", (e) => {
				const i = e;
				if ("exec_retired" === i.type && i.tid === r) g.execRetirement.settle();
				else if ("thread_exit" === i.type) {
					if (!_()) return void S();
				} else if ("memory_quiescent" === i.type && i.tid === r) g.quiescent = !0, g.workerQuiescence.settle(), S();
				else if ("error" === i.type) k(i.message ?? "thread error", !0);
				else if ("vm_interrupt_timer" === i.type) {
					if (!_() || i.pid !== t) return;
					Vh(i, t, l);
				}
			}), m.on("error", (e) => {
				k(`worker error: ${e.message ?? e}`);
			});
			try {
				v = ph.startProcessWorkerWhenRunnable(t, c, () => {
					m.start();
				}, () => {
					m.terminate();
				}, () => {
					ph.finalizeThreadExit(t, r, h.channelOffset);
					const e = ph.failDeferredCloneLaunch(t, r, 12);
					return S(), e;
				});
			} catch (A) {
				throw ph.finalizeThreadExit(t, r, h.channelOffset), S(), A;
			}
			if ("stale" === v) throw S(), /* @__PURE__ */ new Error(`Process ${t} changed generation before thread Worker launch`);
		}(e)),
		onThreadExit: (e, t, r) => !0,
		onExit: (e, t) => Md(e, t)
	}), ph.usePolling = !1, ph.relistenBatchSize = 1;
	const c = ph, l = c.kernel.callbacks || {};
	c.kernel.callbacks = {
		...l,
		onStdout: (e) => ld({
			type: "stdout",
			pid: c.currentHandlePid || 0,
			data: e
		}),
		onStderr: (e) => ld({
			type: "stderr",
			pid: c.currentHandlePid || 0,
			data: e
		}),
		onNetListen: (e, t, r) => {
			const i = c.currentHandlePid;
			return 0 !== i && c.startTcpListener(i, e, t, r), ld({
				type: "listen_tcp",
				pid: i,
				fd: e,
				port: t
			}), 0;
		}
	}, await ph.init(e.kernelWasmBytes), nd = c.kernelInstance, c.kernelMemory, ph.framebuffers.onChange((e, t) => {
		const r = xh.get(e);
		if (r) if ("bind" === t) {
			const t = ph.framebuffers.get(e), i = ph.getProcessMemory(e);
			if (!t || !i) return;
			r.framebufferExposed = !0, ld({
				type: "fb_bind",
				pid: e,
				generation: r.generation,
				addr: t.addr,
				len: t.len,
				w: t.w,
				h: t.h,
				stride: t.stride,
				fmt: "BGRA32",
				memory: i
			});
		} else ld({
			type: "fb_unbind",
			pid: e,
			generation: r.generation
		});
	});
	const h = ph.framebuffers.rebindMemory.bind(ph.framebuffers);
	ph.framebuffers.rebindMemory = (e) => {
		if (h(e), !ph.framebuffers.get(e)) return;
		const t = ph.getProcessMemory(e), r = xh.get(e);
		t && r && ld({
			type: "fb_rebind_memory",
			pid: e,
			generation: r.generation,
			memory: t
		});
	}, ph.framebuffers.onWrite((e, t, r) => {
		const i = xh.get(e);
		if (!i) return;
		const n = r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength);
		ld({
			type: "fb_write",
			pid: e,
			generation: i.generation,
			offset: t,
			bytes: new Uint8Array(n)
		}, [n]);
	}), e.bridgePort && (sd = e.bridgePort, pd()), await async function() {
		for (; 0 !== Ih.length;) {
			const e = Ih.shift();
			try {
				await vd(e);
			} catch (ys) {
				throw Ad(e, ys), ys;
			}
		}
	}(), vh = !0, ld({ type: "ready" });
}
function xd(e, t) {
	let r = !1;
	const i = (i, n, s) => {
		if (!r && !Hh.has(e) && xh.get(t)?.worker === e) {
			r = !0;
			try {
				void 0 !== s && fd({
					pid: t,
					status: i,
					source: s.source,
					message: `${s.message}\n${Xh(t)}`
				});
			} finally {
				Md(t, i, n, e);
			}
		}
	};
	e.on("error", (r) => {
		if (Hh.has(e)) return;
		const n = oh(r);
		i(sh(n), n, {
			source: "worker.onerror",
			message: `[kernel-worker] worker error pid=${t}: ${r.message}`
		});
	}), e.on("exit", (n) => {
		Hh.has(e) || r || i(sh(11), 11, {
			source: "worker exit event",
			message: `[process-worker] pid=${t} crashed (worker exit code=${n}, no exit message from wasm)`
		});
	}), e.on("message", (r) => {
		const n = xh.get(t);
		if (!n || n.worker !== e) return;
		const s = r;
		if ("memory_quiescent" === s.type && void 0 === s.tid && n.workerQuiescence.settle(), "exec_retired" === s.type && void 0 === s.tid && n.execRetirement.settle(), !Hh.has(e)) if ("error" === s.type) {
			const e = oh(s.message);
			i(ah(s.message) ?? -1, e, {
				source: "worker-main error message",
				message: `[process-worker] ${s.message ?? "unknown error"}`
			});
		} else "exit" === s.type ? i(s.status ?? 0) : "vm_interrupt_timer" === s.type && Vh(s, t, n);
	});
}
async function zd(e, t) {
	return $h(e, t);
}
function Md(e, t, r, i = xh.get(e)?.worker) {
	(async function(e, t, r = function(e) {
		return e >= 128 ? e - 128 & 127 : null;
	}(t) ?? 11, i = xh.get(e)?.worker) {
		if (!i) return;
		const n = xh.get(e);
		if (!n || n.worker !== i) return;
		if (zh.has(i)) return;
		Mh.clear(e, n);
		const s = Uh.has(e) ? Fh : 0, o = Math.max(s, function(e) {
			const t = Gh(e?.[0] ?? "");
			return "node" === t || "spidermonkey-node" === t || "spidermonkey-node.wasm" === t ? 2e3 : 0;
		}(n?.argv));
		Uh.delete(e);
		const a = (async () => {
			try {
				ph.notifyHostProcessCrashed(e, r);
			} catch {}
			const s = await Nh(n.workerQuiescence), a = await Qh(e);
			await Jh(i, o);
			const c = await rd({
				pid: e,
				generation: n,
				operation: "deactivate",
				retire: async (t) => {
					const r = await dd(e, n);
					s && a && n.memoryRetirementSafe && r ? n.memoryLease.release() : n.memoryLease.releaseAfterForcedTermination(), t();
				}
			});
			if ("released" === c.status) {
				if (c.mayReapPid) try {
					(function(e, t) {
						if (!e) throw new Error("kernel instance is unavailable while reaping a process");
						const r = e.exports.kernel_get_parent_pid, i = e.exports.kernel_reap_exited_child;
						if ("function" != typeof r) throw new Error("kernel_get_parent_pid export is unavailable");
						if ("function" != typeof i) throw new Error("kernel_reap_exited_child export is unavailable");
						const n = r(t);
						if (-3 === n) return "already-reaped";
						if (n < 0) throw new Error(`kernel_get_parent_pid rejected process ${t} with errno ${-n}`);
						if (0 !== n) return "guest-owned";
						const s = i(0, t);
						if (0 === s) return "reaped";
						if (-10 === s) throw new Error(`kernel rejected host-owned process ${t}; it is not an exited ppid=0 child`);
						throw new Error(`kernel_reap_exited_child rejected process ${t} with errno ${-s}`);
					})(nd, e);
				} catch (l) {
					fd({
						pid: e,
						status: t,
						source: "host-owned process reap",
						message: `[browser-kernel-worker] failed to reap completed host-owned pid ${e}: ` + md(l)
					});
				}
			} else id(e, "process channel teardown", c, t);
		})();
		zh.set(i, a), ld({
			type: "exit",
			pid: e,
			generation: n.generation,
			status: t
		});
		try {
			await a;
		} finally {
			zh.delete(i);
		}
	})(e, t, r, i);
}
async function Td(e) {
	var t;
	if (gh) if (vh) try {
		const r = await Eh.runSnapshot(async () => {
			if (0 !== xh.size || 0 !== zh.size || 0 !== Th.size) throw new Error("rootfs export requires a quiescent kernel with no live or tearing-down processes");
			return gh.saveImage();
		});
		ld({
			type: "response",
			requestId: e.requestId,
			result: t = r
		}, [t.buffer]);
	} catch (r) {
		wd(e.requestId, md(r));
	}
	else wd(e.requestId, "rootfs export requires an initialized kernel");
	else wd(e.requestId, "VFS is not initialized");
}
async function Ld() {
	let e = /* @__PURE__ */ new Set();
	try {
		e = ph.killAllBlockedForTeardown();
	} catch (o) {
		console.error(`[kernel-worker] killAllBlockedForTeardown failed: ${o}`);
	}
	const t = Date.now() + 1500, r = () => {
		for (const t of e) if (xh.has(t)) return !0;
		return !1;
	};
	for (; r() && Date.now() < t;) await qh(15);
	r() && console.warn("[kernel-worker] destroy drain timed out with woken process(es) still live; force-terminating");
	const i = async () => {
		for (const [e, t] of [...xh.entries()]) {
			t.worker && (await Qh(e), await Jh(t.worker));
			const r = await rd({
				pid: e,
				generation: t,
				operation: "unregister",
				retire: async (r) => {
					await dd(e, t), t.memoryLease.releaseAfterForcedTermination(), r();
				}
			});
			"released" !== r.status && id(e, "destroy process teardown", r);
		}
	};
	await i();
	for (const c of Dh.values()) for (const e of c) await (e.termination ?? Jh(e.worker, Fh));
	await Yh(), await i();
	const n = await td.retryPending();
	for (const c of n) "released" !== c.status && console.warn("[browser-kernel-worker] destroy retained an exact process generation: " + md(c.error));
	Mh.clearAll();
	let s = 0 === td.pendingCount && 0 === xh.size;
	if (Wh.clear(), Dh.clear(), Uh.clear(), ed.clear(), vh = !1, Ah = "kernel worker destroyed", kd(Ah), s) try {
		wh.clear();
	} catch (a) {
		s = !1, console.warn(`[browser-kernel-worker] process memory allocator retained an unsafe lease during destroy: ${md(a)}`);
	}
	return s || console.warn("[browser-kernel-worker] destroy retained exact process-generation ownership; terminating this kernel Worker realm is the final release fallback"), function(e) {
		return Object.freeze({ gracefulDetachComplete: e });
	}(s);
}
async function Bd(e, t) {
	if (!nd || !sd) return;
	const r = sd, i = function() {
		const e = ad++;
		return cd.add(e), ud(), e;
	}(), n = t.url || "?";
	try {
		let i = od;
		if (null == i && (i = Array.from(ph.tcpListenerTargets?.keys() ?? [])[0] ?? null), null == i) return console.warn(`[bridge] no listener target for req#${e} ${n}`), void r.postMessage({
			type: "http-error",
			requestId: e,
			error: "No listener target available"
		});
		console.debug(`[bridge] req#${e} ${t.method} ${n} -> port=${i}`);
		const s = await ph.sendHttpRequest(i, {
			method: t.method,
			url: n,
			headers: t.headers ?? {},
			body: t.body ?? null
		}, { debugLabel: `req#${e}` });
		r.postMessage({
			type: "http-response",
			requestId: e,
			status: s.status,
			headers: s.headers,
			body: s.body
		});
	} catch (s) {
		console.warn(`[bridge] req#${e} ${n} failed:`, s), r.postMessage({
			type: "http-error",
			requestId: e,
			error: s instanceof Error ? s.message : String(s)
		});
	} finally {
		(function(e) {
			cd.delete(e) && ud();
		})(i);
	}
}
async function Rd(e) {
	try {
		const { data: t } = await as(yh, e);
		return t.buffer.slice(t.byteOffset, t.byteOffset + t.byteLength);
	} catch (t) {
		if (gd(t)) return null;
		throw t;
	}
}
globalThis.onmessage = (e) => {
	const t = e.data;
	switch (t.type) {
		case "init":
			Cd(t).catch((e) => {
				const t = md(e);
				vh = !1, Ah = t, kd(t), console.error("[kernel-worker] init failed:", e), ld({
					type: "init_error",
					error: t
				});
			});
			break;
		case "spawn":
			Ch.run("a host-spawned process Worker", () => async function(t) {
				let r, i, n, s, o, a = !1, c = !1;
				try {
					let e;
					if (r = Eh.beginMutation("spawn a process"), await Yh(), t.programBytes) e = t.programBytes;
					else {
						if (!t.programPath) return void wd(t.requestId, "No programBytes or programPath");
						{
							const r = await Rd(t.programPath);
							if (!r) return void wd(t.requestId, `ENOENT: ${t.programPath}`);
							e = r;
						}
					}
					if (!lr(e)) return void wd(t.requestId, "ENOEXEC: program is not a WebAssembly module");
					const l = ph.createProcess(t.pty ? Yn : Xn);
					i = l;
					const h = t.programPath ?? t.argv[0], d = t.maxPages ?? bh, f = Sr(e), { memory: u, memoryLease: p, layout: m, threadAllocator: g } = await Ed(l, e, f, d, {
						operation: "spawn",
						path: h,
						argv: t.argv
					});
					n = p;
					const y = m.channelOffset, w = t.env ?? kh;
					if (ph.registerProcess(l, u, [y], {
						ptrWidth: f,
						argv: t.argv,
						env: w,
						brkBase: m.brkBase,
						mmapBase: m.mmapBase,
						maxAddr: m.maxAddr
					}), a = !0, ph.setCredentials(l, {
						uid: t.uid,
						gid: t.gid
					}), t.cwd && ph.setCwd(l, t.cwd), t.pty) {
						const e = ph.setupPty(l);
						ed.set(l, e), null != t.ptyCols && null != t.ptyRows && ph.ptySetWinsize(e, t.ptyRows, t.ptyCols);
					} else if (t.stdin) {
						const e = t.stdin instanceof Uint8Array ? t.stdin : new Uint8Array(t.stdin);
						ph.setStdinData(l, e);
					}
					const b = {
						type: "centralized_init",
						pid: l,
						programBytes: e,
						memory: u,
						channelOffset: y,
						env: w,
						argv: t.argv,
						cwd: t.cwd,
						ptrWidth: f,
						kernelAbiVersion: ph.getKernelAbiVersion()
					};
					c = !0;
					const S = mh.createWorker(b);
					s = S, o = {
						generation: hd(),
						memory: u,
						memoryLease: p,
						workerQuiescence: hh(),
						execRetirement: hh(),
						memoryRetirementSafe: !0,
						framebufferExposed: !1,
						programBytes: e,
						worker: S,
						argv: t.argv,
						channelOffset: y,
						ptrWidth: f,
						layout: m,
						threadAllocator: g
					}, xh.set(l, o), xd(S, l), n = void 0, i = void 0, yd(t.requestId, l);
				} catch (e) {
					if (void 0 !== i) {
						s && await Jh(s);
						const e = o?.memoryLease ?? n;
						if (e) {
							const t = o ?? {
								memory: e.memory,
								memoryLease: e
							}, r = await rd({
								pid: i,
								generation: t,
								operation: a ? "unregister" : "none",
								retire: async (t) => {
									const r = !o || await dd(i, o);
									c || !r ? e.releaseAfterForcedTermination() : e.release(), t();
								}
							});
							"released" !== r.status && id(i, "initial spawn rollback", r);
						}
						if (!a) try {
							ph.removeProcessFromKernelTable(i);
						} catch {}
					}
					wd(t.requestId, String(e));
				} finally {
					r?.();
				}
			}(t)).catch((e) => wd(t.requestId, md(e)));
			break;
		case "terminate_process":
			(async function(e) {
				const t = e.pid, r = xh.get(t);
				r && Mh.clear(t, r);
				const i = Dh.get(t);
				if (i) {
					for (const e of i) {
						await (e.termination ?? Jh(e.worker, Fh));
						try {
							ph.notifyThreadExit(t, e.tid), ph.removeChannel(t, e.channelOffset);
						} catch {}
					}
					Dh.delete(t);
				}
				if (r?.worker && await Jh(r.worker), r) {
					const i = await rd({
						pid: t,
						generation: r,
						operation: "unregister",
						retire: async (e) => {
							await dd(t, r), r.memoryLease.releaseAfterForcedTermination(), e();
						}
					});
					if ("released" !== i.status) return id(t, "terminate_process teardown", i, e.status), void wd(e.requestId, `failed to detach exact process generation for pid ${t}`);
				} else {
					try {
						ph.unregisterProcess(t);
					} catch (n) {
						wd(e.requestId, `failed to unregister unknown pid ${t}: ${md(n)}`);
						return;
					}
					Wh.delete(t), Uh.delete(t), ed.delete(t);
				}
				yd(e.requestId, !0);
			})(t);
			break;
		case "read_vfs_file":
			(async function(e) {
				if (!yh) return void yd(e.requestId, null);
				let t;
				try {
					t = Eh.beginMutation("read or materialize a rootfs file");
					const { data: r, stat: i } = await as(yh, e.path);
					if (32768 != (61440 & i.mode)) return void yd(e.requestId, null);
					const n = r.slice();
					yd(e.requestId, e.includeMode ? {
						data: n,
						mode: 4095 & i.mode
					} : n);
				} catch (r) {
					gd(r) ? yd(e.requestId, null) : wd(e.requestId, md(r));
				} finally {
					t?.();
				}
			})(t);
			break;
		case "write_vfs_file":
			(function(e) {
				if (!yh) return void wd(e.requestId, "VFS is not initialized");
				let t, r = null;
				try {
					t = Eh.beginMutation("write a rootfs file"), r = yh.open(e.path, 577, 4095 & e.mode);
					let i = 0;
					for (; i < e.data.byteLength;) {
						const t = yh.write(r, e.data.subarray(i), null, e.data.byteLength - i);
						if (t <= 0) throw new Error(`Short write while staging ${e.path}`);
						i += t;
					}
					yh.close(r), r = null, yh.chmod(e.path, 4095 & e.mode), yd(e.requestId, !0);
				} catch (ys) {
					if (null !== r) try {
						yh.close(r);
					} catch {}
					wd(e.requestId, md(ys));
				} finally {
					t?.();
				}
			})(t);
			break;
		case "unlink_vfs_file":
			(function(e) {
				if (!yh) return void wd(e.requestId, "VFS is not initialized");
				let t;
				try {
					t = Eh.beginMutation("unlink a rootfs file");
					try {
						yh.lstat(e.path);
					} catch {
						yd(e.requestId, !1);
						return;
					}
					yh.unlink(e.path), yd(e.requestId, !0);
				} catch (ys) {
					wd(e.requestId, md(ys));
				} finally {
					t?.();
				}
			})(t);
			break;
		case "export_rootfs_image":
			Td(t);
			break;
		case "append_stdin_data":
			ph.appendStdinData(t.pid, t.data);
			break;
		case "set_stdin_data":
			ph.setStdinData(t.pid, t.data);
			break;
		case "pty_write":
			(function(e) {
				const t = ed.get(e.pid);
				void 0 !== t && ph.ptyMasterWrite(t, e.data);
			})(t);
			break;
		case "pty_resize":
			(function(e) {
				const t = ed.get(e.pid);
				void 0 !== t && ph.ptySetWinsize(t, e.rows, e.cols);
			})(t);
			break;
		case "register_pty_output":
			(function(e) {
				const t = ed.get(e.pid);
				void 0 !== t && ph.onPtyOutput(t, (t) => {
					ld({
						type: "pty_output",
						pid: e.pid,
						data: t
					});
				});
			})(t);
			break;
		case "inject_connection":
			(function(e) {
				yd(e.requestId, vh ? ph.injectHostConnection(e.pid, e.fd, e.peerAddr, e.peerPort) : dh("inject"));
			})(t);
			break;
		case "pipe_read":
			(function(e) {
				yd(e.requestId, vh ? ph.readHostPipe(e.pid, e.pipeIdx) : dh("read"));
			})(t);
			break;
		case "pipe_write":
			(function(e) {
				yd(e.requestId, vh ? ph.writeHostPipe(e.pid, e.pipeIdx, e.data) : dh("write"));
			})(t);
			break;
		case "pipe_close_read":
			(function(e) {
				vh && ph.closeHostPipeRead(e.pid, e.pipeIdx);
			})(t);
			break;
		case "pipe_close_write":
			(function(e) {
				vh && ph.closeHostPipeWrite(e.pid, e.pipeIdx);
			})(t);
			break;
		case "pipe_is_write_open":
			(function(e) {
				yd(e.requestId, vh ? ph.isHostPipeWriteOpen(e.pid, e.pipeIdx) : dh("is-write-open"));
			})(t);
			break;
		case "wake_blocked_readers":
			(function(e) {
				vh && ph.wakeHostPipeReaders(e.pipeIdx);
			})(t);
			break;
		case "wake_blocked_writers":
			(function(e) {
				vh && ph.wakeHostPipeWriters(e.pipeIdx);
			})(t);
			break;
		case "is_stdin_consumed":
			(function(e) {
				if (!vh) return void yd(e.requestId, !1);
				const t = ph;
				yd(e.requestId, t.stdinFinite.has(e.pid) && !t.stdinBuffers.has(e.pid));
			})(t);
			break;
		case "pick_listener_target":
			(function(e) {
				yd(e.requestId, vh ? ph.pickListenerTarget(e.port) : dh("pick-listener"));
			})(t);
			break;
		case "http_request":
			(async function(t) {
				if (nd) try {
					const e = await ph.sendHttpRequest(t.port, t.request, {
						timeoutMs: t.timeoutMs,
						maxResponseBytes: t.maxResponseBytes
					});
					yd(t.requestId, e);
				} catch (e) {
					wd(t.requestId, e instanceof Error ? e.message : String(e));
				}
				else wd(t.requestId, "Kernel not initialized");
			})(t);
			break;
		case "destroy":
			(async function(e) {
				const t = await Ch.closeAndRunAfterDrain(Ld);
				yd(e.requestId, t);
			})(t);
			break;
		case "register_lazy_files":
		case "register_lazy_archives":
			Id(t);
			break;
		case "get_fork_count":
			try {
				const e = ph.getForkCount(t.pid);
				yd(t.requestId, e);
			} catch (ys) {
				wd(t.requestId, ys?.message ?? String(ys));
			}
			break;
		case "get_kernel_memory_pages":
			try {
				yd(t.requestId, ph.getKernelMemoryPages());
			} catch (ys) {
				wd(t.requestId, ys?.message ?? String(ys));
			}
			break;
		case "mouse_inject":
			(function(e) {
				ph.injectMouseEvent(e.dx, e.dy, e.buttons);
			})(t);
			break;
		case "audio_drain":
			(function(e) {
				const t = Math.min(e.maxBytes, 65536), r = new Uint8Array(t), i = ph.drainAudio(r), n = ph.audioSampleRate(), s = ph.audioChannels(), o = i > 0 ? r.slice(0, i) : new Uint8Array(0);
				ld({
					type: "response",
					requestId: e.requestId,
					result: {
						bytes: o,
						sampleRate: n,
						channels: s
					}
				}, [o.buffer]);
			})(t);
			break;
		case "enum_procs":
			try {
				yd(t.requestId, ph.enumProcs());
			} catch (ys) {
				wd(t.requestId, ys?.message ?? String(ys));
			}
			break;
		case "read_proc_maps":
			try {
				yd(t.requestId, ph.readProcMaps(t.pid));
			} catch (ys) {
				wd(t.requestId, ys?.message ?? String(ys));
			}
			break;
		case "set_syscall_trace":
			t.enabled ? ph.enableSyscallTrace() : ph.disableSyscallTrace();
			break;
		case "drain_syscall_trace":
			try {
				yd(t.requestId, ph.drainSyscallTrace());
			} catch (ys) {
				wd(t.requestId, ys?.message ?? String(ys));
			}
			break;
		case "kms_attach_canvas":
			ph.attachKmsCanvas(t.crtcId, t.canvas, t.stats, t.opts);
			break;
		case "kms_attach_stats":
			ph.attachKmsStats(t.crtcId, t.stats);
			break;
		case "fb_release_generation_ack":
			(function(e) {
				const t = Rh.get(e);
				t && (Rh.delete(e), clearTimeout(t.timeout), t.resolve(!0));
			})(t.requestId);
			break;
		default: {
			const t = e.data;
			if ("sysprof_start" === t?.type) globalThis.__sysprof = !0, globalThis.__sysprofTable = /* @__PURE__ */ new Map(), globalThis.__sysprofStartedAt = performance.now(), ld({
				type: "stdout",
				pid: 0,
				data: new TextEncoder().encode("[sysprof] started\n")
			});
			else if ("pid_map_dump" === t?.type) {
				const e = globalThis.__pidMap, t = ["[pid-map] (pid → exec'd path)\n"];
				if (e) for (const [r, i] of [...e.entries()].sort((e, t) => e[0] - t[0])) t.push(`  pid=${r} ${i}\n`);
				ld({
					type: "stdout",
					pid: 0,
					data: new TextEncoder().encode(t.join(""))
				});
			} else if ("sysprof_dump" === t?.type) {
				const e = globalThis.__sysprofTable, t = globalThis.__sysprofGap, r = globalThis.__sysprofStartedAt ?? 0, i = performance.now() - r, n = e ? [...e.entries()].map(([e, t]) => ({
					key: e,
					...t
				})) : [];
				n.sort((e, t) => t.totalMs - e.totalMs);
				let s = `[sysprof] ${i.toFixed(0)}ms total, top syscalls by kernel-side time:\n`;
				for (const o of n.slice(0, 20)) {
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
				ld({
					type: "stdout",
					pid: 0,
					data: new TextEncoder().encode(s)
				}), globalThis.__sysprof = !1;
			} else "set_bridge_port" === t?.type && t.bridgePort ? (sd = t.bridgePort, pd(), "number" == typeof t.httpPort && (od = t.httpPort), sd && (sd.onmessage = (e) => {
				const t = e.data;
				"http-request" === t?.type && Bd(t.requestId, t);
			})) : fd({
				pid: 0,
				source: "worker protocol",
				message: `[kernel-worker] unknown main-thread message type: ${String(t?.type)}`
			}, "warn");
		}
	}
};
