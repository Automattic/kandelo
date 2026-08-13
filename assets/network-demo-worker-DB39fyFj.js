var e = Object.create, t = Object.defineProperty, i = Object.getOwnPropertyDescriptor, n = Object.getOwnPropertyNames, r = Object.getPrototypeOf, s = Object.prototype.hasOwnProperty, o = (o, a, c) => (c = null != o ? e(r(o)) : {}, ((e, r, o, a) => {
	if (r && "object" == typeof r || "function" == typeof r) for (var c, h = n(r), l = 0, d = h.length; l < d; l++) c = h[l], s.call(e, c) || c === o || t(e, c, {
		get: ((e) => r[e]).bind(null, c),
		enumerable: !(a = i(r, c)) || a.enumerable
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
		let r = Atomics.load(this.meta, 1);
		for (let s = 0; s < n; s++) this.data[r] = e[s], r = (r + 1) % this.cap;
		return Atomics.store(this.meta, 1, r), Atomics.add(this.meta, 2, n), n;
	}
	read(e) {
		const t = Atomics.load(this.meta, 2), i = Math.min(e.length, t);
		if (0 === i) return 0;
		let n = Atomics.load(this.meta, 0);
		for (let r = 0; r < i; r++) e[r] = this.data[n], n = (n + 1) % this.cap;
		return Atomics.store(this.meta, 0, n), Atomics.sub(this.meta, 2, i), i;
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
		for (const i of this.listeners) i(e.pid, "bind");
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
	fbWrite(e, t, i) {
		const n = this.bindings.get(e);
		if (n?.hostBuffer) {
			const e = Math.min(t + i.length, n.hostBuffer.length);
			e > t && n.hostBuffer.set(i.subarray(0, e - t), t);
		}
		for (const r of this.writeListeners) r(e, t, i);
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
}, h = class {
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
		for (const i of this.listeners) i(e.pid, e.bo_id, "create");
	}
	destroy(e, t) {
		if (this.bos.delete(t)) for (const i of this.listeners) i(e, t, "destroy");
	}
	bind(e, t, i, n) {
		const r = this.bos.get(t);
		if (!r) return -1;
		r.pids.add(e), r.bindingsByPid.set(e, {
			addr: i,
			len: n
		});
		for (const s of this.listeners) s(e, t, "bind");
		return 0;
	}
	unbind(e, t) {
		const i = this.bos.get(t);
		if (!i) return;
		const n = i.bindingsByPid.get(e);
		n && this.flushMemoryToSab(i, e, n), i.bindingsByPid.delete(e);
		for (const r of this.listeners) r(e, t, "unbind");
	}
	releaseProcess(e) {
		for (const [t, i] of Array.from(this.bos)) {
			const n = i.bindingsByPid.get(e);
			if (n) {
				this.flushMemoryToSab(i, e, n), i.bindingsByPid.delete(e);
				for (const i of this.listeners) i(e, t, "unbind");
			}
			if (i.pids.delete(e) && 0 === i.pids.size) {
				this.bos.delete(t);
				for (const i of this.listeners) i(e, t, "destroy");
			}
		}
	}
	findBindingByAddr(e, t) {
		for (const i of this.bos.values()) {
			const n = i.bindingsByPid.get(e);
			if (n && n.addr === t) return i.bo_id;
		}
	}
	primeBindFromSab(e, t, i) {
		const n = this.bos.get(t);
		if (!n) return;
		const r = n.bindingsByPid.get(e);
		if (!r) return;
		for (const [c, h] of n.bindingsByPid) c !== e && this.flushMemoryToSab(n, c, h);
		const s = Math.min(r.len, n.size);
		if (r.addr + s > i.buffer.byteLength) return;
		const o = new Uint8Array(i.buffer, r.addr, s), a = new Uint8Array(n.sab, 0, s);
		o.set(a);
	}
	flushMemoryToSab(e, t, i) {
		const n = this.getProcessMemory;
		if (!n) return;
		const r = n(t);
		if (!r) return;
		const s = Math.min(i.len, e.size);
		if (i.addr + s > r.buffer.byteLength) return;
		const o = new Uint8Array(e.sab, 0, s), a = new Uint8Array(r.buffer, i.addr, s);
		o.set(a);
	}
	get(e, t) {
		const i = this.bos.get(t);
		if (i && i.pids.has(e)) return this.project(i, e);
	}
	listForPid(e) {
		const t = [];
		for (const i of this.bos.values()) i.pids.has(e) && t.push(this.project(i, e));
		return t;
	}
	pixelView(e) {
		const t = this.bos.get(e);
		if (t) return new Uint8Array(t.sab);
	}
	syncFromMemory(e) {
		const t = this.bos.get(e);
		if (t) for (const [i, n] of t.bindingsByPid) this.flushMemoryToSab(t, i, n);
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
}, l = class {
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
const d = 2929, f = 2960, u = 3042, p = 2884, g = 3089, m = 32823, y = 33984;
function w(e, t, i) {
	switch (t) {
		case d:
			e.depthTestEnabled = i;
			return;
		case f:
			e.stencilTestEnabled = i;
			return;
		case u:
			e.blendEnabled = i;
			return;
		case p:
			e.cullFaceEnabled = i;
			return;
		case m:
			e.polygonOffsetFillEnabled = i;
			return;
		case g:
			e.scissor.enabled = i;
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
		const i = this.pendingCanvases.get(e.pid) ?? null;
		this.pendingCanvases.delete(e.pid), this.bindings.set(e.pid, {
			...e,
			cmdbufView: null,
			gl: null,
			canvas: i,
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
		for (const n of this.listeners) n(e.pid, "bind");
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
		const i = this.bindings.get(e);
		i ? i.canvas = t : this.pendingCanvases.set(e, t);
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
		const i = this.bindings.get(e);
		i ? i.forward = t : this.pendingForwards.set(e, t);
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
const k = 1024, v = 1025, S = 1026, P = 1027, I = 1028, z = 1029, x = 1030, E = 1280, M = 1281, A = 1282, C = 1283, _ = 1284, L = 1536, B = 1537, T = 1538, F = 1792, R = 1793, U = 1794, $ = 1795, O = 1796, N = 1797, W = 1798;
function D(e, t, i) {
	return e.cmdbufView && e.gl ? V(e.cmdbufView, t, i, (t, i) => {
		try {
			return function(e, t, i, n, r) {
				switch (r) {
					case 1:
						e.clear(i.getUint32(n, !0));
						return;
					case 2:
						t.shadow.clearColor = [
							i.getFloat32(n, !0),
							i.getFloat32(n + 4, !0),
							i.getFloat32(n + 8, !0),
							i.getFloat32(n + 12, !0)
						], e.clearColor(...t.shadow.clearColor);
						return;
					case 3:
						t.shadow.viewport = [
							i.getInt32(n, !0),
							i.getInt32(n + 4, !0),
							i.getInt32(n + 8, !0),
							i.getInt32(n + 12, !0)
						], e.viewport(...t.shadow.viewport);
						return;
					case 4: {
						const r = i.getInt32(n, !0), s = i.getInt32(n + 4, !0), o = i.getInt32(n + 8, !0), a = i.getInt32(n + 12, !0);
						e.scissor(r, s, o, a), t.shadow.scissor.rect = [
							r,
							s,
							o,
							a
						];
						return;
					}
					case 5: {
						const r = i.getUint32(n, !0);
						e.enable(r), w(t.shadow, r, !0);
						return;
					}
					case 6: {
						const r = i.getUint32(n, !0);
						e.disable(r), w(t.shadow, r, !1);
						return;
					}
					case 7: {
						const r = i.getUint32(n, !0), s = i.getUint32(n + 4, !0);
						e.blendFunc(r, s), t.shadow.blendFunc = {
							srcRGB: r,
							dstRGB: s,
							srcA: r,
							dstA: s
						};
						return;
					}
					case 8:
						t.shadow.depthFunc = i.getUint32(n, !0), e.depthFunc(t.shadow.depthFunc);
						return;
					case 9:
						t.shadow.cullFace = i.getUint32(n, !0), e.cullFace(t.shadow.cullFace);
						return;
					case 10:
						t.shadow.frontFace = i.getUint32(n, !0), e.frontFace(t.shadow.frontFace);
						return;
					case 11:
						e.lineWidth(i.getFloat32(n, !0));
						return;
					case 12: {
						const r = i.getUint32(n, !0), s = i.getInt32(n + 4, !0);
						e.pixelStorei(r, s), 3317 === r ? t.shadow.unpackAlignment = s : 3333 === r && (t.shadow.packAlignment = s);
						return;
					}
					case 256: {
						const r = i.getUint32(n, !0);
						for (let s = 0; s < r; s++) {
							const r = i.getUint32(n + 4 + 4 * s, !0), o = e.createBuffer();
							o && t.buffers.set(r, o);
						}
						return;
					}
					case 257: {
						const r = i.getUint32(n, !0);
						for (let s = 0; s < r; s++) {
							const r = i.getUint32(n + 4 + 4 * s, !0), o = t.buffers.get(r);
							o && e.deleteBuffer(o), t.buffers.delete(r);
						}
						return;
					}
					case 258:
						e.bindBuffer(i.getUint32(n, !0), t.buffers.get(i.getUint32(n + 4, !0)) ?? null);
						return;
					case 259: {
						const t = i.getUint32(n, !0), r = i.getUint32(n + 4, !0), s = i.getUint32(n + 8 + r, !0);
						if (0 === r) e.bufferData(t, 0, s);
						else {
							const o = new Uint8Array(i.buffer, i.byteOffset + n + 8, r);
							e.bufferData(t, o, s);
						}
						return;
					}
					case 260: {
						const t = i.getUint32(n, !0), r = i.getInt32(n + 4, !0), s = i.getUint32(n + 8, !0), o = new Uint8Array(i.buffer, i.byteOffset + n + 12, s);
						e.bufferSubData(t, r, o);
						return;
					}
					case 512: {
						const r = i.getUint32(n, !0);
						for (let s = 0; s < r; s++) {
							const r = i.getUint32(n + 4 + 4 * s, !0), o = e.createTexture();
							o && t.textures.set(r, o);
						}
						return;
					}
					case 513: {
						const r = i.getUint32(n, !0);
						for (let s = 0; s < r; s++) {
							const r = i.getUint32(n + 4 + 4 * s, !0), o = t.textures.get(r);
							o && e.deleteTexture(o), t.textures.delete(r);
						}
						return;
					}
					case 514: {
						const r = t.textures.get(i.getUint32(n + 4, !0)) ?? null;
						e.bindTexture(i.getUint32(n, !0), r);
						const s = t.shadow.activeTexture;
						s >= 0 && s < t.shadow.textureUnits.length && (t.shadow.textureUnits[s] = r);
						return;
					}
					case 515: {
						const t = i.getUint32(n, !0), r = i.getInt32(n + 4, !0), s = i.getInt32(n + 8, !0), o = i.getInt32(n + 12, !0), a = i.getInt32(n + 16, !0), c = i.getInt32(n + 20, !0), h = i.getUint32(n + 24, !0), l = i.getUint32(n + 28, !0), d = i.getUint32(n + 32, !0), f = 0 === d ? null : new Uint8Array(i.buffer, i.byteOffset + n + 36, d);
						e.texImage2D(t, r, s, o, a, c, h, l, f);
						return;
					}
					case 516: {
						const t = i.getUint32(n, !0), r = i.getInt32(n + 4, !0), s = i.getInt32(n + 8, !0), o = i.getInt32(n + 12, !0), a = i.getInt32(n + 16, !0), c = i.getInt32(n + 20, !0), h = i.getUint32(n + 24, !0), l = i.getUint32(n + 28, !0), d = i.getUint32(n + 32, !0), f = new Uint8Array(i.buffer, i.byteOffset + n + 36, d);
						e.texSubImage2D(t, r, s, o, a, c, h, l, f);
						return;
					}
					case 517:
						e.texParameteri(i.getUint32(n, !0), i.getUint32(n + 4, !0), i.getInt32(n + 8, !0));
						return;
					case 518: {
						const r = i.getUint32(n, !0);
						e.activeTexture(r), t.shadow.activeTexture = r - y;
						return;
					}
					case 519:
						e.generateMipmap(i.getUint32(n, !0));
						return;
					case 768: {
						const r = i.getUint32(n, !0), s = i.getUint32(n + 4, !0), o = e.createShader(r);
						o && t.shaders.set(s, o);
						return;
					}
					case 769: {
						const r = i.getUint32(n, !0), s = i.getUint32(n + 4, !0), o = new Uint8Array(s);
						o.set(new Uint8Array(i.buffer, i.byteOffset + n + 8, s));
						const a = new TextDecoder().decode(o), c = t.shaders.get(r);
						c && e.shaderSource(c, a);
						return;
					}
					case 770: {
						const r = t.shaders.get(i.getUint32(n, !0));
						r && e.compileShader(r);
						return;
					}
					case 771: {
						const r = i.getUint32(n, !0), s = t.shaders.get(r);
						s && e.deleteShader(s), t.shaders.delete(r);
						return;
					}
					case 772: {
						const r = i.getUint32(n, !0), s = e.createProgram();
						s && t.programs.set(r, s);
						return;
					}
					case 773: {
						const r = t.programs.get(i.getUint32(n, !0)), s = t.shaders.get(i.getUint32(n + 4, !0));
						r && s && e.attachShader(r, s);
						return;
					}
					case 774: {
						const r = t.programs.get(i.getUint32(n, !0));
						r && e.linkProgram(r);
						return;
					}
					case 775: {
						const r = t.programs.get(i.getUint32(n, !0)) ?? null;
						e.useProgram(r), t.currentProgram = r, t.shadow.currentProgram = r;
						return;
					}
					case 776: {
						const r = t.programs.get(i.getUint32(n, !0)), s = i.getUint32(n + 4, !0), o = i.getUint32(n + 8, !0), a = new Uint8Array(o);
						a.set(new Uint8Array(i.buffer, i.byteOffset + n + 12, o));
						const c = new TextDecoder().decode(a);
						r && e.bindAttribLocation(r, s, c);
						return;
					}
					case 777: {
						const r = i.getUint32(n, !0), s = t.programs.get(r);
						s && e.deleteProgram(s), t.programs.delete(r);
						return;
					}
					case k: {
						const r = t.uniformLocations.get(i.getInt32(n, !0)) ?? null;
						e.uniform1i(r, i.getInt32(n + 4, !0));
						return;
					}
					case v: {
						const r = t.uniformLocations.get(i.getInt32(n, !0)) ?? null;
						e.uniform1f(r, i.getFloat32(n + 4, !0));
						return;
					}
					case S: {
						const r = t.uniformLocations.get(i.getInt32(n, !0)) ?? null;
						e.uniform2f(r, i.getFloat32(n + 4, !0), i.getFloat32(n + 8, !0));
						return;
					}
					case P: {
						const r = t.uniformLocations.get(i.getInt32(n, !0)) ?? null;
						e.uniform3f(r, i.getFloat32(n + 4, !0), i.getFloat32(n + 8, !0), i.getFloat32(n + 12, !0));
						return;
					}
					case I: {
						const r = t.uniformLocations.get(i.getInt32(n, !0)) ?? null;
						e.uniform4f(r, i.getFloat32(n + 4, !0), i.getFloat32(n + 8, !0), i.getFloat32(n + 12, !0), i.getFloat32(n + 16, !0));
						return;
					}
					case z: {
						const r = t.uniformLocations.get(i.getInt32(n, !0)) ?? null, s = i.getUint32(n + 4, !0), o = 0 !== i.getUint32(n + 8, !0), a = new Float32Array(i.buffer, i.byteOffset + n + 12, 16 * s);
						e.uniformMatrix4fv(r, o, a);
						return;
					}
					case x: {
						const r = t.uniformLocations.get(i.getInt32(n, !0)) ?? null, s = i.getUint32(n + 4, !0), o = new Float32Array(i.buffer, i.byteOffset + n + 8, 4 * s);
						e.uniform4fv(r, o);
						return;
					}
					case E:
						e.enableVertexAttribArray(i.getUint32(n, !0));
						return;
					case M:
						e.disableVertexAttribArray(i.getUint32(n, !0));
						return;
					case A: {
						const t = i.getUint32(n, !0), r = i.getInt32(n + 4, !0), s = i.getUint32(n + 8, !0), o = 0 !== i.getUint32(n + 12, !0), a = i.getInt32(n + 16, !0), c = i.getInt32(n + 20, !0);
						e.vertexAttribPointer(t, r, s, o, a, c);
						return;
					}
					case C:
						e.drawArrays(i.getUint32(n, !0), i.getInt32(n + 4, !0), i.getInt32(n + 8, !0));
						return;
					case _:
						e.drawElements(i.getUint32(n, !0), i.getInt32(n + 4, !0), i.getUint32(n + 8, !0), i.getUint32(n + 12, !0));
						return;
					case L: {
						const r = i.getUint32(n, !0);
						for (let s = 0; s < r; s++) {
							const r = i.getUint32(n + 4 + 4 * s, !0), o = e.createVertexArray();
							o && t.vaos.set(r, o);
						}
						return;
					}
					case B: {
						const r = i.getUint32(n, !0);
						for (let s = 0; s < r; s++) {
							const r = i.getUint32(n + 4 + 4 * s, !0), o = t.vaos.get(r);
							o && e.deleteVertexArray(o), t.vaos.delete(r);
						}
						return;
					}
					case T: {
						const r = t.vaos.get(i.getUint32(n, !0)) ?? null;
						e.bindVertexArray(r), t.shadow.vao = r;
						return;
					}
					case F: {
						const r = i.getUint32(n, !0);
						for (let s = 0; s < r; s++) {
							const r = i.getUint32(n + 4 + 4 * s, !0), o = e.createFramebuffer();
							o && t.fbos.set(r, o);
						}
						return;
					}
					case R: {
						const r = i.getUint32(n, !0), s = t.fbos.get(i.getUint32(n + 4, !0)) ?? null;
						e.bindFramebuffer(r, s), 36008 !== r && (t.shadow.fbo = s);
						return;
					}
					case U: {
						const r = i.getUint32(n, !0), s = i.getUint32(n + 4, !0), o = i.getUint32(n + 8, !0), a = t.textures.get(i.getUint32(n + 12, !0)) ?? null, c = i.getInt32(n + 16, !0);
						e.framebufferTexture2D(r, s, o, a, c);
						return;
					}
					case $: {
						const r = i.getUint32(n, !0);
						for (let s = 0; s < r; s++) {
							const r = i.getUint32(n + 4 + 4 * s, !0), o = e.createRenderbuffer();
							o && t.rbos.set(r, o);
						}
						return;
					}
					case O:
						e.bindRenderbuffer(i.getUint32(n, !0), t.rbos.get(i.getUint32(n + 4, !0)) ?? null);
						return;
					case N:
						e.renderbufferStorage(i.getUint32(n, !0), i.getUint32(n + 4, !0), i.getInt32(n + 8, !0), i.getInt32(n + 12, !0));
						return;
					case W: {
						const r = i.getUint32(n, !0), s = i.getUint32(n + 4, !0), o = i.getUint32(n + 8, !0), a = t.rbos.get(i.getUint32(n + 12, !0)) ?? null;
						e.framebufferRenderbuffer(r, s, o, a);
						return;
					}
					default: throw new Error(`gl bridge: unknown op 0x${r.toString(16).padStart(4, "0")} at offset ${n - 4}`);
				}
			}(e.gl, e, t, 0, i), 0;
		} catch {
			return -5;
		}
	}) : 0;
}
function V(e, t, i, n) {
	if (!function(e, t, i) {
		return Number.isSafeInteger(e) && Number.isSafeInteger(t) && e >= 0 && t >= 0 && e <= i && t <= i - e;
	}(t, i, e.byteLength)) return -22;
	const r = new DataView(e.buffer, e.byteOffset + t, i);
	let s = 0;
	for (; s < i;) {
		if (i - s < 4) return -22;
		const e = r.getUint16(s, !0), t = r.getUint16(s + 2, !0), o = s + 4, a = o + t;
		if (a > i) return -22;
		const c = new DataView(r.buffer, r.byteOffset + o, t);
		if (!q(e, c)) return -22;
		const h = n(c, e);
		if (0 !== h) return h;
		s = a;
	}
	return 0;
}
function K(e, t) {
	return e.byteLength === t;
}
function H(e, t, i) {
	if (e.byteLength < i + 4) return !1;
	const n = e.getUint32(i, !0);
	return e.byteLength === t + n;
}
function G(e, t, i, n) {
	if (e.byteLength < i + 4 || e.byteOffset % 4 != 0) return !1;
	const r = e.getUint32(i, !0);
	return e.byteLength === t + r * n * 4;
}
function q(e, t) {
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
		case M:
		case T: return K(t, 4);
		case 7:
		case 12:
		case 258:
		case 514:
		case 768:
		case 773:
		case k:
		case v:
		case R:
		case O: return K(t, 8);
		case 517:
		case S:
		case C: return K(t, 12);
		case 2:
		case 3:
		case 4:
		case P:
		case _:
		case N:
		case W: return K(t, 16);
		case I:
		case U: return K(t, 20);
		case A: return K(t, 24);
		case 256:
		case 257:
		case 512:
		case 513:
		case L:
		case B:
		case F:
		case $: return function(e) {
			if (e.byteLength < 4) return !1;
			const t = e.getUint32(0, !0);
			return e.byteLength === 4 + 4 * t;
		}(t);
		case 259: return H(t, 12, 4);
		case 260: return H(t, 12, 8);
		case 515:
		case 516: return H(t, 36, 32);
		case 769: return H(t, 8, 4);
		case 776: return H(t, 12, 8);
		case z: return G(t, 12, 4, 16);
		case x: return G(t, 8, 4, 4);
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
		const i = `${e.pid}:${e.contextId ?? "_"}`;
		let n = this.byKey.get(i);
		n || (n = {
			key: i,
			binding: e,
			frames: []
		}, this.byKey.set(i, n), (this.isCompositor(e.pid) ? this.compositor : this.clients).push(n)), n.frames.push(t);
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
		const t = this.isCompositor(e.binding.pid) ? this.compositor : this.clients, i = t.indexOf(e);
		i >= 0 && t.splice(i, 1);
	}
	removePid(e) {
		for (const [t, i] of Array.from(this.byKey)) {
			if (i.binding.pid !== e) continue;
			i.frames.length = 0, this.byKey.delete(t);
			const n = this.compositor.indexOf(i);
			n >= 0 && this.compositor.splice(n, 1);
			const r = this.clients.indexOf(i);
			r >= 0 && this.clients.splice(r, 1);
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
		const t = e.shadow, i = this.gl;
		i.bindVertexArray(t.vao), i.bindFramebuffer(36160, t.fbo), i.viewport(...t.viewport), t.scissor.enabled ? i.enable(g) : i.disable(g), i.scissor(...t.scissor.rect), i.clearColor(...t.clearColor), t.depthTestEnabled ? i.enable(d) : i.disable(d), i.depthFunc(t.depthFunc), t.stencilTestEnabled ? i.enable(f) : i.disable(f), t.blendEnabled ? i.enable(u) : i.disable(u), i.blendFuncSeparate(t.blendFunc.srcRGB, t.blendFunc.dstRGB, t.blendFunc.srcA, t.blendFunc.dstA), t.cullFaceEnabled ? i.enable(p) : i.disable(p), i.cullFace(t.cullFace), i.frontFace(t.frontFace), t.polygonOffsetFillEnabled ? i.enable(m) : i.disable(m), i.useProgram(t.currentProgram);
		for (let n = 0; n < t.textureUnits.length; n++) {
			const e = t.textureUnits[n];
			e && (i.activeTexture(y + n), i.bindTexture(3553, e));
		}
		i.activeTexture(y + t.activeTexture), i.pixelStorei(3317, t.unpackAlignment), i.pixelStorei(3333, t.packAlignment), this.current = e;
	}
	invalidateCurrent() {
		this.current = null;
	}
};
const Z = "__abi_version", J = [{
	bytes: 4,
	chunkHeaderSize: 32,
	nodeHeaderSize: 24
}, {
	bytes: 8,
	chunkHeaderSize: 56,
	nodeHeaderSize: 32
}], Y = {
	atomics_wait: 2,
	atomics_wait_async: 4,
	shared_array_buffer: 1
}, Q = [
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
], ee = {
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
}, te = 65536, ie = 65608, ne = 65560, re = 65560, se = 16777216, oe = 211, ae = 212, ce = 213, he = 500, le = 386, de = 1, fe = 2, ue = 3, pe = 4, ge = 6, me = 7, ye = 8, we = 10, be = 11, ke = 12, ve = 19, Se = 22, Pe = 24, Ie = 25, ze = 34, xe = 35, Ee = 41, Me = 46, Ae = 47, Ce = 48, _e = 49, Le = 53, Be = 54, Te = 55, Fe = 56, Re = 60, Ue = 62, $e = 63, Oe = 64, Ne = 65, We = 68, De = 69, Ve = 72, Ke = 77, He = 79, Ge = 80, qe = 81, je = 82, Xe = 85, Ze = 86, Je = 90, Ye = 92, Qe = 93, et = 97, tt = 102, it = 103, nt = 109, rt = 121, st = 124, ot = 126, at = 137, ct = 138, ht = 139, lt = 200, dt = 201, ft = 205, ut = 207, pt = 238, gt = 239, mt = 240, yt = 241, wt = 251, bt = 252, kt = 278, vt = 288, St = 294, Pt = 295, It = 296, zt = 308, xt = 333, Et = 334, Mt = 343, At = 345, Ct = 346, _t = 378, Lt = 379, Bt = 384, Tt = 387, Ft = 415, Rt = 0, Ut = 1, $t = 2, Ot = 3, Nt = 4, Wt = 5, Dt = 6, Vt = 7, Kt = 8, Ht = 9, Gt = 10, qt = 11, jt = 12, Xt = 13, Zt = 14, Jt = 15, Yt = 16, Qt = 17, ei = 18, ti = 19, ii = 20, ni = 21, ri = 22, si = 23, oi = {
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
}, ai = 65536;
function ci(e, t) {
	let i = 0, n = 0, r = t;
	for (;;) {
		const t = e[r++];
		if (i |= (127 & t) << n, !(128 & t)) break;
		n += 7;
	}
	return [i, r - t];
}
function hi(e, t, i) {
	const [n, r] = ci(e, t);
	t += r + n;
	const [s, o] = ci(e, t);
	t += o + s;
	const a = e[t++];
	if (0 === a) {
		i.funcImports++;
		const [, n] = ci(e, t);
		t += n;
	} else if (1 === a) {
		t++;
		const i = e[t++], [, n] = ci(e, t);
		if (t += n, 1 & i) {
			const [, i] = ci(e, t);
			t += i;
		}
	} else if (2 === a) {
		const i = e[t++], [, n] = ci(e, t);
		if (t += n, 1 & i) {
			const [, i] = ci(e, t);
			t += i;
		}
	} else 3 === a && (i.globalImports++, t += 2);
	return t;
}
[
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
].map(({ name: e }) => e);
function li(e, t) {
	t++, t++;
	const i = e[t++];
	if (65 === i) {
		const [i] = function(e, t) {
			let i = 0, n = 0, r = t, s = 0;
			for (; s = e[r++], i |= (127 & s) << n, n += 7, 128 & s;);
			return n < 32 && 64 & s && (i |= -1 << n), [i, r - t];
		}(e, t);
		return BigInt.asUintN(32, BigInt(i));
	}
	if (66 === i) {
		const [i] = function(e, t) {
			let i = 0n, n = 0n, r = t, s = 0;
			for (; s = e[r++], i |= BigInt(127 & s) << n, n += 7n, 128 & s;);
			return n < 64n && 64 & s && (i |= -1n << n), [i, r - t];
		}(e, t);
		return BigInt.asUintN(64, i);
	}
	return null;
}
function di(e, t) {
	for (t += 2; 11 !== e[t];) t++;
	return t + 1;
}
function fi(e) {
	const t = new Uint8Array(e);
	if (t.length < 8) return 4;
	function i(e, t) {
		let i = 0, n = 0, r = t;
		for (;;) {
			const t = e[r++];
			if (i |= (127 & t) << n, !(128 & t)) break;
			n += 7;
		}
		return [i, r - t];
	}
	let n = 8;
	for (; n < t.length;) {
		const e = t[n], [r, s] = i(t, n + 1), o = n + 1 + s;
		if (2 === e) {
			let e = o;
			const [n, r] = i(t, e);
			e += r;
			for (let s = 0; s < n; s++) {
				const [n, r] = i(t, e);
				e += r + n;
				const [s, o] = i(t, e);
				e += o + s;
				const a = t[e++];
				if (2 === a) return 4 & t[e] ? 8 : 4;
				if (0 === a) {
					const [, n] = i(t, e);
					e += n;
				} else if (1 === a) {
					e++;
					const n = t[e++], [, r] = i(t, e);
					if (e += r, 1 & n) {
						const [, n] = i(t, e);
						e += n;
					}
				} else 3 === a && (e += 2);
			}
			break;
		}
		n = o + r;
	}
	return 4;
}
const ui = (1n << 64n) - 1n;
function pi(e, t) {
	if ("bigint" == typeof e) {
		if (e >= 0n && e <= ui) return e;
	} else if (Number.isSafeInteger(e) && e >= 0) return BigInt(e);
	const i = /* @__PURE__ */ new Error(`EOVERFLOW: ${t} is not exactly representable as an unsigned 64-bit value`);
	throw i.code = "EOVERFLOW", i;
}
function gi(e) {
	const t = e instanceof ArrayBuffer ? new Uint8Array(e) : new Uint8Array(e.buffer, e.byteOffset, e.byteLength), i = new Uint8Array(t.byteLength);
	return i.set(t), i.buffer;
}
function mi(e, t) {
	return void 0 === e || !Number.isFinite(e) || e < 1 ? t : yi(Math.trunc(e));
}
function yi(e) {
	return Math.max(1, Math.min(65535, Math.trunc(e)));
}
const wi = {
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
function bi(e) {
	if (e && "object" == typeof e && "code" in e) {
		const t = e.code;
		if ("number" == typeof t && 0 !== t) return t < 0 ? t : -t;
		if ("string" == typeof t) {
			const e = wi[t];
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
			const e = wi[t];
			if (void 0 !== e) return e;
		}
	}
	return -5;
}
var ki = class e {
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
	bos = new h();
	kms = new l(this.bos);
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
	constructor(e, t, i) {
		this.config = e, this.io = t, this.callbacks = i ?? {}, this.bos.setProcessMemoryResolver((e) => this.callbacks.getProcessMemory?.(e));
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
		} catch (i) {
			return bi(i);
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
		const n = Math.min(t.byteLength, e.AUDIO_SCRATCH_SIZE), r = i(this.toKernelPtr(this.audioScratchOffset), n);
		if (r > 0) {
			const e = new Uint8Array(this.memory.buffer, this.audioScratchOffset, r);
			t.set(e.subarray(0, r));
		}
		return r;
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
			pipe: a.fromSharedBuffer(t),
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
	registerWaitpidSab(e) {
		this.waitpidSab = e;
	}
	async init(e) {
		this.kernelPtrWidth = fi(gi(e));
		const t = this.createKernelMemory();
		this.memory = t;
		const i = this.buildImportObject(t), n = await WebAssembly.compile(e);
		this.instance = await WebAssembly.instantiate(n, i);
	}
	async initWithMemory(e, t) {
		this.kernelPtrWidth = fi(gi(e)), this.memory = t;
		const i = this.buildImportObject(t), n = await WebAssembly.compile(e);
		this.instance = await WebAssembly.instantiate(n, i);
	}
	buildImportObject(e) {
		return { env: {
			memory: e,
			host_debug_log: (t, i) => {
				const n = new Uint8Array(e.buffer, Number(t), i), r = new TextDecoder().decode(n.slice());
				console.log(`[KERNEL] ${r}`);
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
			host_pathconf: (e, t, i, n) => this.hostPathconf(Number(e), t, i, Number(n)),
			host_fpathconf: (e, t, i) => this.hostFpathconf(e, t, Number(i)),
			host_mkdir: (e, t, i) => this.hostMkdir(Number(e), t, i),
			host_rmdir: (e, t) => this.hostRmdir(Number(e), t),
			host_unlink: (e, t) => this.hostUnlink(Number(e), t),
			host_rename: (e, t, i, n) => this.hostRename(Number(e), t, Number(i), n),
			host_link: (e, t, i, n) => this.hostLink(Number(e), t, Number(i), n),
			host_symlink: (e, t, i, n) => this.hostSymlink(Number(e), t, Number(i), n),
			host_readlink: (e, t, i, n) => this.hostReadlink(Number(e), t, Number(i), n),
			host_chmod: (e, t, i) => this.hostChmod(Number(e), t, i),
			host_chown: (e, t, i, n) => this.hostChown(Number(e), t, i, n),
			host_lchown: (e, t, i, n) => this.hostLchown(Number(e), t, i, n),
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
			host_exec: (e, t) => this.hostExec(Number(e), t),
			host_set_alarm: (e) => this.hostSetAlarm(e),
			host_set_posix_timer: (e, t, i, n, r, s) => {
				const o = 4294967296 * (n >>> 0) + (i >>> 0), a = 4294967296 * (s >>> 0) + (r >>> 0);
				return this.hostSetPosixTimer(e, t, o, a);
			},
			host_sigsuspend_wait: () => this.hostSigsuspendWait(),
			host_call_signal_handler: (e, t, i) => {
				const n = this.programFuncTable ?? this.instance?.exports.__indirect_function_table;
				if (!n) return -22;
				const r = n.get(e);
				if (r) try {
					return 4 & i ? r(t, 0, 0) : r(t), 0;
				} catch (s) {
					return -5;
				}
				return -22;
			},
			host_getrandom: (e, t) => {
				try {
					const i = this.getMemoryBuffer(), n = Number(e), r = i.subarray(n, n + t);
					if (void 0 !== globalThis.crypto && globalThis.crypto.getRandomValues) {
						const e = new Uint8Array(t);
						globalThis.crypto.getRandomValues(e), r.set(e);
					} else for (let e = 0; e < t; e++) r[e] = 256 * Math.random() | 0;
					return t;
				} catch {
					return -5;
				}
			},
			host_utimensat: (e, t, i, n, r, s) => this.hostUtimensat(Number(e), t, i, n, r, s),
			host_waitpid: (e, t, i) => this.hostWaitpid(e, t, Number(i)),
			host_net_connect: (e, t, i, n) => this.hostNetConnect(e, Number(t), i, n),
			host_net_send: (e, t, i, n) => this.hostNetSend(e, Number(t), i, n),
			host_net_recv: (e, t, i, n) => this.hostNetRecv(e, Number(t), i, n),
			host_net_poll: (e, t) => this.hostNetPoll(e, t),
			host_net_connect_status: (e) => this.hostNetConnectStatus(e),
			host_net_close: (e) => this.hostNetClose(e),
			host_net_listen: (e, t, i, n, r, s) => this.hostNetListen(e, t, i, n, r, s),
			host_udp_bind: (e, t, i, n, r, s) => this.hostUdpBind(e, t, i, n, r, s),
			host_udp_unbind: (e) => this.hostUdpUnbind(e),
			host_udp_send: (e, t, i, n, r, s, o, a, c, h, l, d) => this.hostUdpSend(e, t, i, n, r, s, o, a, c, h, Number(l), d),
			host_getaddrinfo: (e, t, i, n) => this.hostGetaddrinfo(Number(e), t, Number(i), n),
			host_futex_wait: (e, t, i, n) => this.hostFutexWait(Number(e), t, i, n),
			host_futex_wake: (e, t) => this.hostFutexWake(Number(e), t),
			host_is_thread_worker: () => this.isThreadWorker ? 1 : 0,
			host_bind_framebuffer: (e, t, i, n, r, s, o) => {
				this.framebuffers.bind({
					pid: e,
					addr: Number(t),
					len: Number(i),
					w: n,
					h: r,
					stride: s,
					fmt: "BGRA32"
				});
			},
			host_unbind_framebuffer: (e) => {
				this.framebuffers.unbind(e);
			},
			host_fb_write: (e, t, i, n) => {
				this.framebuffers.fbWrite(e, Number(t), this.readKernelBytes(Number(i), Number(n)));
			},
			host_gbm_bo_create: (e, t, i, n, r, s) => (this.bos.create({
				pid: e,
				bo_id: t,
				size: Number(i),
				w: n,
				h: r,
				stride: s
			}), 0),
			host_gbm_bo_destroy: (e, t) => {
				this.bos.destroy(e, t);
			},
			host_gbm_bo_bind: (e, t, i, n) => this.bos.bind(e, t, Number(i), Number(n)),
			host_gbm_bo_unbind: (e, t, i, n) => {
				this.bos.unbind(e, t);
			},
			host_gl_bind: (e, t, i) => {
				this.gl.bind({
					pid: e,
					cmdbufAddr: Number(t),
					cmdbufLen: Number(i)
				});
			},
			host_gl_unbind: (e) => {
				this.gl.unbind(e);
			},
			host_gl_create_context: (e, t, i, n) => {
				const r = this.gl.get(e);
				if (!r) return;
				if (r.contextId = t, r.forward) return void r.forward.onCreateContext();
				if (!r.canvas) {
					const t = this.kms.masterCrtcForPid(e);
					if (null != t) {
						const i = this.callbacks.getKmsCanvas?.(t);
						if (i) {
							const n = this.kms.currentFb(t);
							!n || i.width === n.width && i.height === n.height || (i.width = n.width, i.height = n.height), this.gl.attachCanvas(e, i), r.canvas = i, this.callbacks.markKmsCanvasGlOwned?.(t);
						}
					}
					if (!r.canvas) return;
				}
				const s = r.canvas.getContext("webgl2", {
					antialias: !1,
					premultipliedAlpha: !1,
					preserveDrawingBuffer: !0
				});
				s && (s.getExtension("EXT_color_buffer_float"), s.getExtension("OES_texture_float_linear"), s.getExtension("EXT_float_blend")), r.gl = s;
			},
			host_gl_destroy_context: (e, t) => {
				const i = this.gl.get(e);
				i && (i.gl = null, i.contextId = null, i.currentProgram = null, i.forward && i.forward.onDestroyContext());
			},
			host_gl_create_surface: (e, t, i, n) => {
				const r = this.gl.get(e);
				r && (r.surfaceId = t);
			},
			host_gl_destroy_surface: (e, t) => {
				const i = this.gl.get(e);
				i && (i.surfaceId = null);
			},
			host_gl_make_current: (e, t, i) => {},
			host_gl_submit: (e, t, i) => {
				const n = this.gl.get(e);
				if (!n) return -5;
				if (!n.forward && !n.gl) return 0;
				if (!n.cmdbufView) {
					const t = this.callbacks.getProcessMemory?.(e);
					if (!t) return -5;
					try {
						n.cmdbufView = new Uint8Array(t.buffer, n.cmdbufAddr, n.cmdbufLen), this.callbacks.onProcessMemoryTarget?.(t, t.buffer), this.callbacks.onProcessMemoryTarget?.(t, n.cmdbufView), this.callbacks.onProcessMemoryTarget?.(t, n);
					} catch {
						return -5;
					}
				}
				if (n.forward) {
					const e = Number(t), r = Number(i), s = function(e, t, i) {
						return V(e, t, i, () => 0);
					}(n.cmdbufView, e, r);
					return s < 0 ? s : (n.forward.onSubmit(n.cmdbufView.slice(e, e + r)), 0);
				}
				return this.gl_submit_queue.enqueue(n, {
					memorySab: n.cmdbufView.buffer,
					off: Number(t),
					len: Number(i)
				}), function(e, t, i) {
					for (;;) {
						const n = e.pickNext();
						if (!n) return 0;
						const r = n.frames.shift(), s = t(n.binding);
						s && s.switchTo(n.binding);
						const o = i(n.binding, r.off, r.len);
						if (e.releaseIfEmpty(n), "number" == typeof o && o < 0) return o;
					}
				}(this.gl_submit_queue, (e) => {
					if (!e.gl) return null;
					let t = this.gl_muxers.get(e.gl);
					return t || (t = new X(e.gl), this.gl_muxers.set(e.gl, t)), t;
				}, (e, t, i) => D(e, t, i));
			},
			host_gl_present: (e) => {},
			host_gl_query: (e, t, i, n, r, s) => {
				const o = this.gl.get(e);
				if (!o || !o.gl) return -1;
				const a = n > 0n ? this.readKernelBytes(Number(i), Number(n)) : new Uint8Array(0), c = new Uint8Array(Number(s)), h = function(e, t, i, n) {
					if (!e.gl) return -1;
					const r = e.gl, s = new DataView(i.buffer, i.byteOffset, i.byteLength), o = new DataView(n.buffer, n.byteOffset, n.byteLength);
					switch (t) {
						case 1: return n.byteLength < 4 ? -22 : (o.setUint32(0, r.getError(), !0), 4);
						case 2: {
							if (i.byteLength < 4) return -22;
							const e = s.getUint32(0, !0), t = r.getParameter(e) ?? "", a = new TextEncoder().encode(t), c = 4 + a.byteLength;
							return n.byteLength < c ? -22 : (o.setUint32(0, a.byteLength, !0), n.set(a, 4), c);
						}
						case 3: {
							if (i.byteLength < 4 || n.byteLength < 4) return -22;
							const e = s.getUint32(0, !0), t = r.getParameter(e);
							return o.setInt32(0, Number(t ?? 0), !0), 4;
						}
						case 4: {
							if (i.byteLength < 4 || n.byteLength < 4) return -22;
							const e = s.getUint32(0, !0), t = r.getParameter(e);
							return o.setFloat32(0, Number(t ?? 0), !0), 4;
						}
						case 5: {
							if (i.byteLength < 8 || n.byteLength < 4) return -22;
							const t = s.getUint32(0, !0), a = s.getUint32(4, !0);
							if (i.byteLength < 8 + a) return -22;
							const c = e.programs.get(t), h = new TextDecoder().decode(i.subarray(8, 8 + a)), l = c ? r.getUniformLocation(c, h) : null;
							if (l) {
								const t = ++e.nextUniformLoc;
								e.uniformLocations.set(t, l), o.setInt32(0, t, !0);
							} else o.setInt32(0, -1, !0);
							return 4;
						}
						case 6: {
							if (i.byteLength < 8 || n.byteLength < 4) return -22;
							const t = s.getUint32(0, !0), a = s.getUint32(4, !0);
							if (i.byteLength < 8 + a) return -22;
							const c = e.programs.get(t), h = new TextDecoder().decode(i.subarray(8, 8 + a)), l = c ? r.getAttribLocation(c, h) : -1;
							return o.setInt32(0, l, !0), 4;
						}
						case 7: {
							if (i.byteLength < 8 || n.byteLength < 4) return -22;
							const t = e.shaders.get(s.getUint32(0, !0));
							if (!t) return o.setInt32(0, 0, !0), 4;
							const a = r.getShaderParameter(t, s.getUint32(4, !0));
							return o.setInt32(0, "boolean" == typeof a ? a ? 1 : 0 : Number(a ?? 0), !0), 4;
						}
						case 8: {
							if (i.byteLength < 4) return -22;
							const t = e.shaders.get(s.getUint32(0, !0)), a = (t && r.getShaderInfoLog(t)) ?? "", c = new TextEncoder().encode(a), h = 4 + c.byteLength;
							return n.byteLength < h ? (o.setUint32(0, 0, !0), 4) : (o.setUint32(0, c.byteLength, !0), n.set(c, 4), h);
						}
						case 9: {
							if (i.byteLength < 8 || n.byteLength < 4) return -22;
							const t = e.programs.get(s.getUint32(0, !0));
							if (!t) return o.setInt32(0, 0, !0), 4;
							const a = r.getProgramParameter(t, s.getUint32(4, !0));
							return o.setInt32(0, "boolean" == typeof a ? a ? 1 : 0 : Number(a ?? 0), !0), 4;
						}
						case 10: {
							if (i.byteLength < 4) return -22;
							const t = e.programs.get(s.getUint32(0, !0)), a = (t && r.getProgramInfoLog(t)) ?? "", c = new TextEncoder().encode(a), h = 4 + c.byteLength;
							return n.byteLength < h ? (o.setUint32(0, 0, !0), 4) : (o.setUint32(0, c.byteLength, !0), n.set(c, 4), h);
						}
						case 11: {
							if (i.byteLength < 24) return -22;
							const e = s.getInt32(0, !0), t = s.getInt32(4, !0), o = s.getInt32(8, !0), a = s.getInt32(12, !0), c = s.getUint32(16, !0), h = s.getUint32(20, !0);
							let l = n;
							return 5126 === h ? l = new Float32Array(n.buffer, n.byteOffset, n.byteLength / 4 | 0) : 5131 === h && (l = new Uint16Array(n.buffer, n.byteOffset, n.byteLength / 2 | 0)), r.readPixels(e, t, o, a, c, h, l), n.byteLength;
						}
						case 12: {
							if (i.byteLength < 4 || n.byteLength < 4) return -22;
							const e = r.checkFramebufferStatus(s.getUint32(0, !0));
							return o.setUint32(0, e, !0), 4;
						}
						default: return -22;
					}
				}(o, t, a, c);
				return h > 0 && 0 !== Number(r) && this.writeKernelBytes(Number(r), c.subarray(0, h)), h;
			},
			host_kms_set_master: (e) => {
				this.kms.setMasterPid(e);
			},
			host_kms_drop_master: (e) => {
				this.kms.dropMaster();
			},
			host_proc_write_bytes: (e, t, i, n) => {
				const r = this.callbacks.getProcessMemory?.(e);
				if (!r) return -14;
				try {
					const e = this.readKernelBytes(Number(i), n);
					return new Uint8Array(r.buffer, Number(t), n).set(e), 0;
				} catch {
					return -14;
				}
			},
			host_proc_read_bytes: (e, t, i, n) => {
				const r = this.callbacks.getProcessMemory?.(e);
				if (!r) return -14;
				try {
					const e = new Uint8Array(r.buffer, Number(t), n), s = new Uint8Array(n);
					return s.set(e), this.writeKernelBytes(Number(i), s), 0;
				} catch {
					return -14;
				}
			},
			host_kms_mode_info: (e, t) => {
				const i = this.callbacks.getKmsCanvas?.(e);
				this.writeKernelBytes(Number(t), function(e, t, i = 60) {
					const n = mi(e, 1920), r = mi(t, 1080), s = yi(n + 16), o = yi(n + 48), a = yi(n + 160), c = yi(r + 3), h = yi(r + 8), l = yi(r + 45), d = Math.max(1, Math.min(4294967295, Math.round(a * l * i / 1e3))), f = new Uint8Array(68), u = new DataView(f.buffer);
					u.setUint32(0, d, !0), u.setUint16(4, n, !0), u.setUint16(6, s, !0), u.setUint16(8, o, !0), u.setUint16(10, a, !0), u.setUint16(12, 0, !0), u.setUint16(14, r, !0), u.setUint16(16, c, !0), u.setUint16(18, h, !0), u.setUint16(20, l, !0), u.setUint16(22, 0, !0), u.setUint32(24, i, !0), u.setUint32(28, 0, !0), u.setUint32(32, 9, !0);
					const p = `${n}x${r}`;
					for (let g = 0; g < Math.min(p.length, 31); g++) f[36 + g] = 255 & p.charCodeAt(g);
					return f;
				}(i?.width, i?.height));
			},
			host_kms_addfb: (e, t, i, n, r, s, o) => (this.kms.addFb({
				fb_id: t,
				bo_id: i,
				width: n,
				height: r,
				pixel_format: s,
				pitch: o
			}), 0),
			host_kms_rmfb: (e, t) => {
				this.kms.rmFb(t);
			},
			host_kms_set_fb: (e, t, i) => {
				this.kms.setFb(t, i);
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
	writeKernelBytes(e, t) {
		this.getMemoryBuffer().set(t, e);
	}
	hostOpen(e, t, i, n) {
		try {
			const r = this.getMemoryBuffer().slice(e, e + t), s = new TextDecoder().decode(r);
			return BigInt(this.io.open(s, i, n));
		} catch (r) {
			return BigInt(bi(r));
		}
	}
	hostClose(e) {
		const t = Number(e), i = this.sharedPipes.get(t);
		if (i) return "read" === i.end ? i.pipe.closeRead() : i.pipe.closeWrite(), this.sharedPipes.delete(t), 0;
		if (t >= 0 && t <= 2) return 0;
		const n = this.retainedHostFileHandles.get(t);
		if (n) return n.descriptorClosePending = !0, 0;
		try {
			return this.io.close(t);
		} catch (r) {
			return bi(r);
		}
	}
	hostRead(e, t, i) {
		const n = Number(e), r = this.sharedPipes.get(n);
		if (r) {
			const e = this.getMemoryBuffer(), n = new Uint8Array(e.buffer, t, i);
			return r.pipe.read(n);
		}
		if (0 === n) {
			if (this.callbacks.onStdin) {
				const e = this.callbacks.onStdin(i);
				if (null === e) return 0;
				if (0 === e.length) return -11;
				const n = this.getMemoryBuffer(), r = Math.min(e.length, i);
				return n.set(e.subarray(0, r), t), r;
			}
			return 0;
		}
		try {
			const e = this.getMemoryBuffer().subarray(t, t + i);
			return this.io.read(n, e, null, i);
		} catch (s) {
			return bi(s);
		}
	}
	hostWrite(e, t, i) {
		const n = Number(e), r = this.getMemoryBuffer().slice(t, t + i), s = this.sharedPipes.get(n);
		if (s) return s.pipe.write(r);
		if (1 === n) return this.callbacks.onStdout ? this.callbacks.onStdout(r) : "undefined" != typeof process && process.stdout ? process.stdout.write(r) : console.log(new TextDecoder().decode(r)), i;
		if (2 === n) return this.callbacks.onStderr ? this.callbacks.onStderr(r) : "undefined" != typeof process && process.stderr ? process.stderr.write(r) : console.error(new TextDecoder().decode(r)), i;
		try {
			return this.io.write(n, r, null, i);
		} catch (o) {
			return bi(o);
		}
	}
	hostSeek(e, t, i, n) {
		const r = Number(e), s = 4294967296 * i + (t >>> 0);
		try {
			return BigInt(this.io.seek(r, s, n));
		} catch (o) {
			return BigInt(bi(o));
		}
	}
	hostFstat(e, t) {
		const i = Number(e);
		try {
			const e = this.io.fstat(i);
			return this.writeStatToMemory(t, e), this.fstatHandleCapture && (this.fstatHandleCapture.handle = i), 0;
		} catch (n) {
			return bi(n);
		}
	}
	writeStatToMemory(e, t) {
		const i = this.getMemoryDataView();
		this.getMemoryBuffer().fill(0, e, e + 88), i.setBigUint64(e + 0, pi(t.dev, "st_dev"), !0), i.setBigUint64(e + 8, pi(t.ino, "st_ino"), !0), i.setUint32(e + 16, t.mode, !0), i.setUint32(e + 20, t.nlink, !0), i.setUint32(e + 24, t.uid, !0), i.setUint32(e + 28, t.gid, !0), i.setBigUint64(e + 32, BigInt(t.size), !0);
		const n = Math.floor(t.atimeMs / 1e3), r = Math.floor(t.atimeMs % 1e3 * 1e6);
		i.setBigUint64(e + 40, BigInt(n), !0), i.setUint32(e + 48, r, !0);
		const s = Math.floor(t.mtimeMs / 1e3), o = Math.floor(t.mtimeMs % 1e3 * 1e6);
		i.setBigUint64(e + 56, BigInt(s), !0), i.setUint32(e + 64, o, !0);
		const a = Math.floor(t.ctimeMs / 1e3), c = Math.floor(t.ctimeMs % 1e3 * 1e6);
		i.setBigUint64(e + 72, BigInt(a), !0), i.setUint32(e + 80, c, !0);
	}
	writeStatfsToMemory(e, t) {
		const i = this.getMemoryDataView();
		this.getMemoryBuffer().fill(0, e, e + 72);
		const n = (e) => Number.isFinite(e) ? Math.max(0, Math.floor(e)) >>> 0 : 0, r = (e) => !Number.isFinite(e) || e <= 0 ? 0n : BigInt(Math.min(Math.floor(e), Number.MAX_SAFE_INTEGER));
		i.setUint32(e + 0, n(t.type), !0), i.setUint32(e + 4, n(t.bsize), !0), i.setBigUint64(e + 8, r(t.blocks), !0), i.setBigUint64(e + 16, r(t.bfree), !0), i.setBigUint64(e + 24, r(t.bavail), !0), i.setBigUint64(e + 32, r(t.files), !0), i.setBigUint64(e + 40, r(t.ffree), !0), i.setBigUint64(e + 48, r(t.fsid), !0), i.setUint32(e + 56, n(t.namelen), !0), i.setUint32(e + 60, n(t.frsize), !0), i.setUint32(e + 64, n(t.flags), !0);
	}
	readPathFromMemory(e, t) {
		const i = this.getMemoryBuffer().slice(e, e + t);
		return new TextDecoder().decode(i);
	}
	hostStat(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t), r = this.io.stat(n);
			return this.writeStatToMemory(i, r), 0;
		} catch (n) {
			return bi(n);
		}
	}
	hostLstat(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t), r = this.io.lstat(n);
			return this.writeStatToMemory(i, r), 0;
		} catch (n) {
			return bi(n);
		}
	}
	hostStatfs(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t), r = this.io.statfs(n);
			return this.writeStatfsToMemory(i, r), 0;
		} catch (n) {
			return bi(n);
		}
	}
	hostPathconf(e, t, i, n) {
		try {
			const r = this.readPathFromMemory(e, t), s = this.io.pathconf(r, i);
			return this.getMemoryDataView().setBigInt64(n, BigInt(s ?? -1), !0), 0;
		} catch (r) {
			return bi(r);
		}
	}
	hostFpathconf(e, t, i) {
		try {
			const n = this.io.fpathconf(Number(e), t);
			return this.getMemoryDataView().setBigInt64(i, BigInt(n ?? -1), !0), 0;
		} catch (n) {
			return bi(n);
		}
	}
	hostMkdir(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.mkdir(n, i), 0;
		} catch (n) {
			return bi(n);
		}
	}
	hostRmdir(e, t) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.rmdir(i), 0;
		} catch (i) {
			return bi(i);
		}
	}
	hostUnlink(e, t) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.unlink(i), 0;
		} catch (i) {
			return bi(i);
		}
	}
	hostRename(e, t, i, n) {
		try {
			const r = this.readPathFromMemory(e, t), s = this.readPathFromMemory(i, n);
			return this.io.rename(r, s), 0;
		} catch (r) {
			return bi(r);
		}
	}
	hostLink(e, t, i, n) {
		try {
			const r = this.readPathFromMemory(e, t), s = this.readPathFromMemory(i, n);
			return this.io.link(r, s), 0;
		} catch (r) {
			return bi(r);
		}
	}
	hostSymlink(e, t, i, n) {
		try {
			const r = this.readPathFromMemory(e, t), s = this.readPathFromMemory(i, n);
			return this.io.symlink(r, s), 0;
		} catch (r) {
			return bi(r);
		}
	}
	hostReadlink(e, t, i, n) {
		try {
			const r = this.readPathFromMemory(e, t), s = this.io.readlink(r), o = new TextEncoder().encode(s), a = Math.min(o.length, n);
			return this.getMemoryBuffer().set(o.subarray(0, a), i), a;
		} catch (r) {
			return bi(r);
		}
	}
	hostChmod(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.chmod(n, i), 0;
		} catch (n) {
			return bi(n);
		}
	}
	hostChown(e, t, i, n) {
		try {
			const r = this.readPathFromMemory(e, t);
			return this.io.chown(r, i, n), 0;
		} catch (r) {
			return bi(r);
		}
	}
	hostLchown(e, t, i, n) {
		try {
			const r = this.readPathFromMemory(e, t);
			return this.io.lchown(r, i, n), 0;
		} catch (r) {
			return bi(r);
		}
	}
	hostAccess(e, t, i) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.access(n, i), 0;
		} catch (n) {
			return bi(n);
		}
	}
	hostUtimensat(e, t, i, n, r, s) {
		try {
			const o = this.readPathFromMemory(e, t);
			return this.io.utimensat(o, Number(i), Number(n), Number(r), Number(s)), 0;
		} catch {
			return -1;
		}
	}
	hostWaitpid(e, t, i) {
		if (this.waitpidSab && this.callbacks.onWaitpid) {
			const n = new Int32Array(this.waitpidSab);
			Atomics.store(n, 0, 0), Atomics.store(n, 1, 0), Atomics.store(n, 2, 0), this.callbacks.onWaitpid(e, t), Atomics.wait(n, 0, 0);
			const r = Atomics.load(n, 1), s = Atomics.load(n, 2);
			return r < 0 || 0 !== i && this.memory && new DataView(this.memory.buffer).setInt32(i, s, !0), r;
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
			const i = this.readPathFromMemory(e, t), n = this.io.opendir(i);
			return this.pendingDirectoryEntries.delete(n), BigInt(n);
		} catch (i) {
			return BigInt(bi(i));
		}
	}
	hostReaddir(e, t, i, n) {
		try {
			const r = Number(e);
			let s = this.pendingDirectoryEntries.get(r);
			if (void 0 === s) {
				const e = this.io.readdir(r);
				if (null === e) return 0;
				this.pendingDirectoryEntries.set(r, e), s = e;
			}
			const o = this.getMemoryDataView(), a = this.getMemoryBuffer(), c = new TextEncoder().encode(s.name), h = Math.min(c.length, n);
			return o.setBigUint64(t, BigInt(s.ino), !0), o.setUint32(t + 8, s.type, !0), o.setUint32(t + 12, h, !0), a.set(c.subarray(0, h), i), this.pendingDirectoryEntries.delete(r), 1;
		} catch (r) {
			return bi(r);
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
	hostClockGettime(e, t, i) {
		try {
			const n = this.io.clockGettime(e), r = this.getMemoryDataView();
			return r.setBigInt64(t, BigInt(n.sec), !0), r.setBigInt64(i, BigInt(n.nsec), !0), 0;
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
		const n = this.instance.exports.kernel_socketpair, r = this.getMemoryDataView(), s = n(e, t, i, 4);
		if (s < 0) throw new Error("socketpair failed: errno " + -s);
		return [r.getInt32(4, !0), r.getInt32(8, !0)];
	}
	shutdown(e, t) {
		const i = (0, this.instance.exports.kernel_shutdown)(e, t);
		if (i < 0) throw new Error("shutdown failed: errno " + -i);
	}
	send(e, t, i = 0) {
		const n = this.instance.exports.kernel_send;
		this.getMemoryBuffer().set(t, 16);
		const r = n(e, 16, t.length, i);
		if (r < 0) throw new Error("send failed: errno " + -r);
		return r;
	}
	recv(e, t, i = 0) {
		const n = (0, this.instance.exports.kernel_recv)(e, 16, t, i);
		if (n < 0) throw new Error("recv failed: errno " + -n);
		return this.getMemoryBuffer().slice(16, 16 + n);
	}
	poll(e, t) {
		const i = this.instance.exports.kernel_poll, n = e.length, r = this.getMemoryDataView();
		for (let o = 0; o < n; o++) {
			const t = 16 + 8 * o;
			r.setInt32(t, e[o].fd, !0), r.setInt16(t + 4, e[o].events, !0), r.setInt16(t + 6, 0, !0);
		}
		const s = i(16, n, t);
		if (s < 0) throw new Error("poll failed: errno " + -s);
		return e.map((e, t) => ({
			fd: e.fd,
			events: e.events,
			revents: r.getInt16(16 + 8 * t + 6, !0)
		}));
	}
	getsockopt(e, t, i) {
		const n = this.instance.exports.kernel_getsockopt, r = this.getMemoryDataView(), s = n(e, t, i, 4);
		if (s < 0) throw new Error("getsockopt failed: errno " + -s);
		return r.getUint32(4, !0);
	}
	setsockopt(e, t, i, n) {
		const r = (0, this.instance.exports.kernel_setsockopt)(e, t, i, n);
		if (r < 0) throw new Error("setsockopt failed: errno " + -r);
	}
	tcgetattr(e) {
		const t = (0, this.instance.exports.kernel_tcgetattr)(e, 16, 48);
		if (t < 0) throw new Error("tcgetattr failed: errno " + -t);
		return this.getMemoryBuffer().slice(16, 64);
	}
	tcsetattr(e, t, i) {
		const n = this.instance.exports.kernel_tcsetattr;
		this.getMemoryBuffer().set(i, 16);
		const r = n(e, t, 16, i.length);
		if (r < 0) throw new Error("tcsetattr failed: errno " + -r);
	}
	ioctl(e, t, i) {
		const n = this.instance.exports.kernel_ioctl, r = this.getMemoryBuffer(), s = i ? i.length : 8;
		i && r.set(i, 16);
		const o = n(e, t, 16, s);
		if (o < 0) throw new Error("ioctl failed: errno " + -o);
		return r.slice(16, 16 + s);
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
		const i = this.getMemoryBuffer(), n = new TextDecoder(), r = (e) => {
			const t = 16 + e;
			let r = t;
			for (; r < t + 65 && 0 !== i[r];) r++;
			return n.decode(i.slice(t, r));
		};
		return {
			sysname: r(0),
			nodename: r(65),
			release: r(130),
			version: r(195),
			machine: r(260)
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
		const r = this.instance.exports.kernel_select, s = this.getMemoryBuffer(), o = t ? 16 : 0, a = i ? 144 : 0, c = n ? 272 : 0;
		if (t) {
			s.fill(0, o, o + 128);
			for (const e of t) s[o + Math.floor(e / 8)] |= 1 << e % 8;
		}
		if (i) {
			s.fill(0, a, a + 128);
			for (const e of i) s[a + Math.floor(e / 8)] |= 1 << e % 8;
		}
		if (n) {
			s.fill(0, c, c + 128);
			for (const e of n) s[c + Math.floor(e / 8)] |= 1 << e % 8;
		}
		const h = r(e, o, a, c, 0);
		if (h < 0) throw new Error("select failed: errno " + -h);
		const l = (e, t) => t && e ? t.filter((t) => s[e + Math.floor(t / 8)] >> t % 8 & 1) : [];
		return {
			readReady: l(o, t),
			writeReady: l(a, i),
			exceptReady: l(c, n)
		};
	}
	hostNetConnect(e, t, i, n) {
		if (!this.io.network) return -111;
		try {
			const r = new Uint8Array(this.memory.buffer).slice(t, t + i);
			return this.io.network.connect(e, r, n), 0;
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
			const r = new Uint8Array(this.memory.buffer).slice(t, t + i);
			return this.io.network.send(e, r, n);
		} catch (r) {
			return 11 === r?.errno ? -11 : -32;
		}
	}
	hostNetRecv(e, t, i, n) {
		if (!this.io.network) return -107;
		try {
			const r = this.io.network.recv(e, i, n);
			return r.length > 0 && this.memory && new Uint8Array(this.memory.buffer).set(r, t), r.length;
		} catch (r) {
			return 11 === r?.errno ? -11 : -104;
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
	hostNetListen(e, t, i, n, r, s) {
		return this.callbacks.onNetListen ? this.callbacks.onNetListen(e, t, [
			i,
			n,
			r,
			s
		]) : 0;
	}
	hostUdpBind(e, t, i, n, r, s) {
		return this.callbacks.onUdpBind ? this.callbacks.onUdpBind(e, [
			t,
			i,
			n,
			r
		], s) : 0;
	}
	hostUdpUnbind(e) {
		return this.callbacks.onUdpUnbind ? this.callbacks.onUdpUnbind(e) : 0;
	}
	hostUdpSend(e, t, i, n, r, s, o, a, c, h, l, d) {
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
				srcPort: r,
				dstAddr: new Uint8Array([
					s,
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
			const r = new Uint8Array(this.memory.buffer), s = new TextDecoder().decode(r.slice(e, e + t)), o = this.io.network.getaddrinfo(s);
			return o.length > n ? -22 : (r.set(o, i), o.length);
		} catch (r) {
			return 11 === r?.errno ? -11 : -2;
		}
	}
	hostFutexWait(e, t, i, n) {
		if (!this.memory) return -22;
		const r = new Int32Array(this.memory.buffer), s = e >>> 2, o = 4294967296n * BigInt(n >>> 0) + BigInt(i >>> 0), a = BigInt.asIntN(64, o);
		let c;
		a >= 0n && (c = Number(a / 1000000n), 0 === c && a > 0n && (c = 1));
		const h = Atomics.wait(r, s, t, c);
		return "timed-out" === h ? -110 : "not-equal" === h ? -11 : 0;
	}
	hostFutexWake(e, t) {
		if (!this.memory) return 0;
		const i = new Int32Array(this.memory.buffer), n = e >>> 2;
		return Atomics.notify(i, n, t);
	}
};
const vi = new TextEncoder(), Si = new TextDecoder();
var Pi = class {
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
		for (const i of this.chunks) e.set(i, t), t += i.byteLength;
		return e;
	}
};
function Ii(e, t = "GET") {
	if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(t)) throw new Error("in-kernel HTTP request method is malformed");
	const i = function(e) {
		for (let t = 0; t + 3 < e.length; t++) if (13 === e[t] && 10 === e[t + 1] && 13 === e[t + 2] && 10 === e[t + 3]) return t;
		return -1;
	}(e);
	if (i < 0) throw new Error("in-kernel HTTP response lacks a header terminator");
	const n = Si.decode(e.subarray(0, i)).split("\r\n"), r = n[0]?.match(/^HTTP\/(?:1\.0|1\.1) ([1-5][0-9]{2})(?: [^\r\n]*)?$/u);
	if (null == r) throw new Error("in-kernel HTTP response has a malformed status line");
	const s = parseInt(r[1], 10), o = {}, a = /* @__PURE__ */ new Map();
	for (let f = 1; f < n.length; f++) {
		const { key: e, value: t } = zi(n[f], "header"), i = e.toLowerCase(), r = a.get(i) ?? [];
		r.push(t), a.set(i, r);
		const s = Object.keys(o).find((e) => e.toLowerCase() === i);
		"set-cookie" === i && void 0 !== s ? o[s] += "\n" + t : o[e] = t;
	}
	let c = e.subarray(i + 4);
	const h = "HEAD" === t.toUpperCase() || s >= 100 && s < 200 || 204 === s || 304 === s;
	if (h && 0 !== c.byteLength) throw new Error("in-kernel HTTP response must not contain a body");
	const l = a.get("transfer-encoding") ?? [], d = a.get("content-length") ?? [];
	if (l.length > 0 && d.length > 0) throw new Error("in-kernel HTTP response has conflicting body framing");
	if (l.length > 0) {
		if (1 !== l.length || "chunked" !== l[0].trim().toLowerCase()) throw new Error("in-kernel HTTP response has unsupported transfer encoding");
		h || (c = function(e) {
			const t = [];
			let i = 0;
			for (;;) {
				const n = xi(e, i);
				if (n < 0) throw new Error("in-kernel HTTP chunk size line is truncated");
				const r = Si.decode(e.subarray(i, n)), s = /^([0-9A-Fa-f]+)(?:;[^\r\n]*)?$/u.exec(r);
				if (null === s) throw new Error("in-kernel HTTP response has a malformed chunk size");
				const o = Number.parseInt(s[1], 16);
				if (!Number.isSafeInteger(o)) throw new Error("in-kernel HTTP response chunk size exceeds its bound");
				const a = n + 2;
				if (0 === o) for (i = a;;) {
					const n = xi(e, i);
					if (n < 0) throw new Error("in-kernel HTTP response lacks its terminating chunk");
					if (n === i) {
						if (n + 2 !== e.byteLength) throw new Error("in-kernel HTTP response has bytes after its chunked body");
						return Ei(t);
					}
					zi(Si.decode(e.subarray(i, n)), "trailer"), i = n + 2;
				}
				const c = a + o;
				if (c > e.length) throw new Error("in-kernel HTTP response chunk is truncated");
				if (c + 2 > e.length || 13 !== e[c] || 10 !== e[c + 1]) throw new Error("in-kernel HTTP response chunk lacks its terminator");
				t.push(e.subarray(a, c)), i = c + 2;
			}
		}(c));
		for (const e of Object.keys(o)) "transfer-encoding" === e.toLowerCase() && delete o[e];
	} else if (d.length > 0) {
		if (!d.every((e) => e === d[0]) || !/^(?:0|[1-9][0-9]*)$/u.test(d[0])) throw new Error("in-kernel HTTP response has an invalid Content-Length");
		const e = Number(d[0]);
		if (!Number.isSafeInteger(e) || !h && c.byteLength !== e) throw new Error("in-kernel HTTP response differs from its Content-Length");
	}
	return {
		status: s,
		headers: o,
		body: new Uint8Array(c)
	};
}
function zi(e, t) {
	const i = e.indexOf(":");
	if (i < 1) throw new Error(`in-kernel HTTP response has a malformed ${t} line`);
	const n = e.slice(0, i);
	if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(n)) throw new Error(`in-kernel HTTP response has a malformed ${t} name`);
	const r = e.slice(i + 1);
	if (/[^\t\x20-\x7e\x80-\xff]/u.test(r)) throw new Error(`in-kernel HTTP response has a malformed ${t} value`);
	return {
		key: n,
		value: r.replace(/^[\t ]*/u, "").replace(/[\t ]*$/u, "")
	};
}
function xi(e, t) {
	for (let i = t; i + 1 < e.length; i++) if (13 === e[i] && 10 === e[i + 1]) return i;
	return -1;
}
function Ei(e) {
	if (0 === e.length) return new Uint8Array(0);
	if (1 === e.length) return e[0];
	const t = e.reduce((e, t) => e + t.length, 0), i = new Uint8Array(t);
	let n = 0;
	for (const r of e) i.set(r, n), n += r.length;
	return i;
}
function Mi(e, t, i = function() {
	let e = 0;
	return "function" == typeof SharedArrayBuffer && (e |= Y.shared_array_buffer), "function" == typeof Atomics.wait && (e |= Y.atomics_wait), "function" == typeof Atomics.waitAsync && (e |= Y.atomics_wait_async), e;
}()) {
	const n = function(e, t) {
		const i = Ai(e, "kernel_host_adapter_manifest_ptr"), n = Ai(e, "kernel_host_adapter_manifest_len"), r = Ci(i(), "kernel_host_adapter_manifest_ptr"), s = Ci(n(), "kernel_host_adapter_manifest_len");
		if (s < 40) throw new Error(`kernel host adapter manifest is too small: ${s} bytes (expected at least 40)`);
		if (r + 40 > t.buffer.byteLength) throw new Error(`kernel host adapter manifest is out of bounds: ptr=${r} size=40 memory=${t.buffer.byteLength}`);
		const o = new DataView(t.buffer, r, 40);
		return {
			magic: Li(o, "magic"),
			manifestVersion: _i(o, "manifestVersion"),
			manifestSize: _i(o, "manifestSize"),
			abiVersion: Li(o, "abiVersion"),
			requiredHostAdapterVersion: Li(o, "requiredHostAdapterVersion"),
			requiredWorkerFeatures: Li(o, "requiredWorkerFeatures"),
			optionalKernelFeatures: Li(o, "optionalKernelFeatures"),
			channelHeaderSize: Li(o, "channelHeaderSize"),
			channelDataOffset: Li(o, "channelDataOffset"),
			channelDataSize: Li(o, "channelDataSize"),
			channelMinSize: Li(o, "channelMinSize")
		};
	}(e, t);
	if (1296781399 !== n.magic) throw new Error(`kernel host adapter manifest has invalid magic: ${n.magic}`);
	if (1 !== n.manifestVersion) throw new Error(`kernel host adapter manifest version ${n.manifestVersion} is not supported by host manifest reader 1`);
	if (40 !== n.manifestSize) throw new Error(`kernel host adapter manifest size ${n.manifestSize} does not match host reader size 40`);
	if (42 !== n.abiVersion) throw new Error(`kernel host adapter manifest ABI version ${n.abiVersion} does not match host ABI version 42`);
	if (n.requiredHostAdapterVersion > 1) throw new Error(`kernel requires host adapter version ${n.requiredHostAdapterVersion}, but this host supports 1`);
	const r = n.requiredWorkerFeatures & ~i;
	if (0 !== r) throw new Error("kernel requires unsupported worker features: " + function(e) {
		const t = [];
		let i = 0;
		for (const [r, s] of Object.entries(Y)) i |= s, 0 !== (e & s) && t.push(r);
		const n = e & ~i;
		0 !== n && t.push(`unknown(0x${n.toString(16)})`);
		return 0 === t.length ? "none" : t.join(", ");
	}(r));
	Bi("channel header size", n.channelHeaderSize, 72), Bi("channel data offset", n.channelDataOffset, 72), Bi("channel data size", n.channelDataSize, te), Bi("channel minimum size", n.channelMinSize, ie);
	for (const s of Q) if ("function" != typeof e.exports[s]) throw new Error(`kernel wasm is missing required host adapter export ${s}`);
	return n;
}
function Ai(e, t) {
	const i = e.exports[t];
	if ("function" != typeof i) throw new Error(`kernel wasm is missing required host adapter export ${t}`);
	return i;
}
function Ci(e, t) {
	const i = "bigint" == typeof e ? Number(e) : e;
	if (!Number.isSafeInteger(i) || i < 0) throw new Error(`${t} returned invalid manifest pointer/length ${String(e)}`);
	return i;
}
function _i(e, t) {
	return e.getUint16(ee[t].offset, !0);
}
function Li(e, t) {
	return e.getUint32(ee[t].offset, !0);
}
function Bi(e, t, i) {
	if (t !== i) throw new Error(`kernel host adapter manifest ${e} ${t} does not match generated host ABI value ${i}`);
}
const Ti = 67108864;
var Fi = class extends Error {
	errno = 11;
	requestedBytes;
	pendingRetiredMemories;
	pendingRetiredBytes;
	retirementAdmissionMemoryThreshold;
	retirementAdmissionByteThreshold;
	constructor(e, t, i, n, r, s) {
		super(e), this.name = "ProcessMemoryRetirementBacklogError", this.requestedBytes = t, this.pendingRetiredMemories = i, this.pendingRetiredBytes = n, this.retirementAdmissionMemoryThreshold = r, this.retirementAdmissionByteThreshold = s;
	}
};
function Ri(e, t, i = 4) {
	const n = Math.ceil(t / ai) - Math.ceil(e.buffer.byteLength / ai);
	n <= 0 || (8 === i ? e.grow(BigInt(n)) : e.grow(n));
}
function Ui(e, t, i) {
	const n = new DataView(e.buffer), r = 8 === i ? Number(n.getBigUint64(t, !0)) : n.getUint32(t, !0), s = function(e) {
		return J.find(({ bytes: t }) => t === e);
	}(i);
	if (!s) throw new Error(`unsupported fork continuation pointer width ${i}`);
	const o = r - s.chunkHeaderSize;
	if (!Number.isSafeInteger(r) || r <= 0 || !Number.isSafeInteger(o) || o <= 0 || o % ai !== 0 || o + ai > e.buffer.byteLength) throw new Error(`invalid fork continuation anchor ${String(r)}`);
	return r;
}
function $i(e, t, i) {
	if (!Number.isInteger(t) || t < -2147483648 || t > i) throw new Error(`${e} returned an invalid byte count ${String(t)} for a ${i}-byte buffer`);
	return t;
}
const Oi = 11, Ni = 14, Wi = 22, Di = 2147483647;
var Vi = class extends Error {
	pid;
	tid;
	errno;
	constructor(e, t, i, n) {
		super(n ?? `Kernel rejected tid ${t} for process ${e}: errno ${i}`), this.pid = e, this.tid = t, this.errno = i, this.name = "KernelTaskBindingError";
	}
};
function Ki(e, t, i) {
	if (!Number.isSafeInteger(t) || t <= 0 || t >= e.length) return { errno: Ni };
	if (i <= 0) return { errno: 36 };
	const n = e.length - t, r = Math.min(n, i), s = e.subarray(t, t + r).indexOf(0);
	return s >= 0 ? { size: s + 1 } : { errno: n < i ? Ni : 36 };
}
function Hi(e, t, i) {
	return Number.isSafeInteger(t) && t > 0 && Number.isSafeInteger(i) && i >= 0 && t <= e.length - i;
}
const Gi = 4194304, qi = 4096, ji = Ee, Xi = We, Zi = st, Ji = lt, Yi = Re, Qi = wt, en = bt, tn = it, nn = yt, rn = gt, sn = _t, on = mt, an = Lt, cn = ut, hn = pt, ln = xe, dn = ft, fn = oe, un = le, pn = ae, gn = ce, mn = he, yn = dt, wn = ze, bn = Tt, kn = Je, vn = Ye, Sn = ht, Pn = vt, In = Ft, zn = 16, xn = [{
	name: "lo",
	index: 1,
	loopback: !0
}, {
	name: "eth0",
	index: 2,
	loopback: !1
}], En = Ve, Mn = Me, An = Ae, Cn = _e, _n = Ce, Ln = ot, Bn = kt, Tn = pe, Fn = ue, Rn = Oe, Un = Ne, $n = Ge, On = Ze, Nn = He, Wn = Xe, Dn = zt, Vn = St, Kn = me, Hn = ye, Gn = Ke, qn = Te, jn = Fe, Xn = Ue, Zn = $e, Jn = at, Yn = ct, Qn = Le, er = Bt, tr = Be, ir = 4096, nr = -100;
function rr(e) {
	return Math.ceil(e / ai) * ai;
}
const sr = qe, or = je, ar = Pt, cr = It, hr = we, lr = Mt, dr = At, fr = Ct, ur = xt, pr = Et, gr = de, mr = De, yr = fe, wr = rt, br = "undefined" != typeof process && !!{}.WASM_POSIX_PROFILE, kr = new Set([
	ue,
	Fe,
	$e,
	Oe,
	je,
	ct
]), vr = new Set([
	pe,
	Te,
	Ue,
	Ne,
	qe,
	at,
	St
]);
const Sr = ie;
const Pr = {
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
}, Ir = {
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
}, zr = {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe"
};
function xr(e) {
	switch (e) {
		case "pipe": return 0;
		case "terminal": return 1;
	}
}
const Er = Symbol("ThreadChannelAttachment"), Mr = /* @__PURE__ */ new WeakMap();
var Ar = class {
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
		const i = this.kernelInstance?.exports.kernel_set_current_tid;
		if (!i) throw new Error("Kernel missing kernel_set_current_tid export");
		const n = i(e, t);
		if (n < 0) throw new Vi(e, t, -n);
	}
	validateKernelTid(e, t) {
		const i = this.kernelInstance?.exports.kernel_validate_task;
		if (!i) throw new Error("Kernel missing kernel_validate_task export");
		const n = i(e, t);
		if (n < 0) throw new Vi(e, t, -n);
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
		return new Vi(e.pid, void 0, 3, `No kernel-validated TID for non-main channel ${e.channelOffset} of process ${e.pid}`);
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
	profileData = br ? /* @__PURE__ */ new Map() : null;
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
	constructor(e, t, i = {}) {
		if (this.config = e, this.io = t, this.callbacks = i, this.kernel = new ki(e, t, {
			getProcessMemory: (e) => this.processes.get(e)?.memory,
			onProcessMemoryTarget: (e, t) => {
				this.callbacks.onProcessMemoryTarget?.(e, t);
			},
			getKmsCanvas: (e) => this.kmsCanvases.get(e),
			markKmsCanvasGlOwned: (e) => {
				this.kmsContextMode.set(e, "webgl2");
			},
			onStdin: (e) => {
				const t = this.currentHandlePid, i = this.stdinBuffers.get(t);
				if (!i) return this.stdinFinite.has(t) ? null : new Uint8Array(0);
				const n = i.data.length - i.offset;
				if (n <= 0) return this.stdinBuffers.delete(t), this.stdinFinite.has(t) ? null : new Uint8Array(0);
				const r = Math.min(n, e), s = i.data.subarray(i.offset, i.offset + r);
				return i.offset += r, i.offset >= i.data.length && this.stdinBuffers.delete(t), s;
			},
			onAlarm: (e) => {
				const t = this.currentHandlePid;
				if (0 === t) return 0;
				const i = this.alarmTimers.get(t);
				if (i && (clearTimeout(i), this.alarmTimers.delete(t)), e > 0) {
					const i = setTimeout(() => {
						this.alarmTimers.delete(t), this.sendSignalToProcess(t, 14);
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
				const r = `${n}:${e}`, s = this.io.network.bindUdp(r, new Uint8Array(t), i, { receive: (e) => this.injectUdpDatagram(n, e) });
				return 0 === s && this.udpBindings.add(r), 0 === s ? 0 : -s;
			},
			onUdpUnbind: (e) => {
				const t = this.currentHandlePid;
				if (0 === t || !this.io.network?.unbindUdp) return 0;
				const i = `${t}:${e}`;
				return this.io.network.unbindUdp(i), this.udpBindings.delete(i), 0;
			},
			onPosixTimer: (e, t, i, n) => {
				const r = this.currentHandlePid;
				if (0 === r) return 0;
				const s = `${r}:${e}`, o = this.posixTimers.get(s);
				if (o && (clearTimeout(o.timeout), o.interval && clearInterval(o.interval), this.posixTimers.delete(s)), i > 0 || n > 0) {
					const o = setTimeout(() => {
						const i = this.posixTimers.get(s);
						if (i && i.timeout === o) if (this.processes.has(r)) if (this.firePosixTimer(r, e, t), n > 0) {
							const i = setInterval(() => {
								const n = this.posixTimers.get(s);
								if (n && n.interval === i) return this.processes.has(r) ? void this.firePosixTimer(r, e, t) : (clearInterval(i), void this.posixTimers.delete(s));
								clearInterval(i);
							}, n), a = this.posixTimers.get(s);
							a?.timeout === o ? a.interval = i : clearInterval(i);
						} else this.posixTimers.delete(s);
						else this.posixTimers.delete(s);
					}, Math.max(0, i));
					this.posixTimers.set(s, {
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
		const t = this.kernelInstance.exports[Z];
		if ("function" != typeof t) throw new Error(`kernel wasm is missing the ${Z} export — refusing to run. Rebuild the kernel (bash build.sh) against the current ABI.`);
		this.kernelAbiVersion = t(), Mi(this.kernelInstance, this.kernelMemory);
		const i = this.kernelInstance.exports.kernel_alloc_scratch;
		if (this.scratchOffset = Number(i(Sr)), 0 === this.scratchOffset) throw new Error("Failed to allocate kernel scratch buffer");
		try {
			const e = await import("./__vite-browser-external-ClzbFl4s.js").then((e) => o(e.default, 1));
			"function" == typeof e.createServer && (this.netModule = e);
		} catch {}
		if (this.tcpScratchOffset = Number(i(65536)), 0 === this.tcpScratchOffset) throw new Error("Failed to allocate TCP scratch buffer");
		this.initialized = !0;
	}
	createProcess(e) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		const t = this.kernelInstance.exports.kernel_create_process_with_stdio;
		if (!t) throw new Error("Kernel missing kernel_create_process_with_stdio export");
		const i = t(xr(e.stdin), xr(e.stdout), xr(e.stderr));
		if (i <= 0) throw new Error("Failed to create process: errno " + -i);
		return i;
	}
	registerProcess(e, t, i, n) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		if (!Number.isSafeInteger(e) || e <= 0 || e > Di) throw new Error(`Cannot register invalid kernel process ID ${e}`);
		if (1 !== i.length) throw new Error(`Process ${e} must register exactly one main syscall channel`);
		const r = this.kernelInstance.exports.kernel_get_process_state, s = r?.(e);
		if (void 0 === s || s < 0) throw new Error(`Cannot register unknown kernel process ${e}`);
		if (0 !== s && 1 !== s) throw new Error(`Cannot register inactive kernel process ${e}`);
		if (1 === e) throw new Error("Cannot register the kernel-reserved init process");
		const o = this.processes.get(e), a = !0 === n?.preserveProcessState && !0 === this.execHandoffPids?.has(e) && 0 === o?.channels.length;
		if (o && !a) throw new Error(`Process ${e} is already registered with the host`);
		if (this.discardStoppedChannelStateForProcess(e, !n?.preserveProcessState), void 0 !== n?.argv || void 0 !== n?.env) {
			const e = this.validateExecMetadata(n.argv ?? [], n.env ?? [], n.metadataPtrWidth ?? n.ptrWidth ?? 4);
			if (e < 0) throw new Error("Process argv/environment exceeds exec metadata limits: errno " + -e);
		}
		if (this.hostReaped.delete(e), void 0 !== n?.brkBase && !this.setBrkBase(e, n.brkBase)) throw new Error("Kernel export kernel_set_brk_base is required for compact process memory layout");
		void 0 !== n?.argv && this.replaceProcessMetadata(e, 0, n.argv), void 0 !== n?.env && this.replaceProcessMetadata(e, 1, n.env);
		const c = this.kernelInstance.exports.kernel_set_max_addr;
		if (c) {
			const t = n?.maxAddr ?? (i.length > 0 ? Math.min(...i) : void 0);
			void 0 !== t && c(e, this.toKernelPtr(t));
		}
		if (void 0 !== n?.mmapBase && !this.setMmapBase(e, n.mmapBase)) throw new Error("Kernel export kernel_set_mmap_base is required for compact process memory layout");
		if (void 0 !== n?.brkLimit && !this.setBrkLimit(e, n.brkLimit)) throw new Error("Kernel export kernel_set_brk_limit is required for legacy low-control layout");
		const h = i.map((i) => ({
			pid: e,
			memory: t,
			channelOffset: i,
			i32View: new Int32Array(t.buffer, i),
			consecutiveSyscalls: 0
		})), l = {
			pid: e,
			memory: t,
			channels: h,
			ptrWidth: n?.ptrWidth ?? 4,
			explicitMaxAddr: void 0 !== n?.maxAddr
		};
		this.processes.set(e, l), this.activeChannels.push(...h), this.observeProcessMemoryTarget(t, t), this.observeProcessMemoryTarget(t, t.buffer), this.observeProcessMemoryTarget(t, l);
		for (const d of h) this.observeProcessMemoryTarget(t, d), this.observeProcessMemoryTarget(t, d.i32View);
		if (this.usePolling) this.startPolling();
		else for (const d of h) this.listenOnChannel(d);
	}
	validateExecMetadata(e, t, i = 4) {
		const n = new TextEncoder();
		let r = 2 * i;
		for (const s of [...e, ...t]) {
			const e = n.encode(s).byteLength;
			if (e > 65536) return -7;
			if (r += i + e + 1, !Number.isSafeInteger(r) || r > Gi) return -7;
		}
		return 0;
	}
	supportsExecMetadataReplacement() {
		const e = this.kernelInstance?.exports;
		return "function" == typeof e?.kernel_clear_process_metadata && "function" == typeof e?.kernel_push_process_metadata_entry;
	}
	replaceProcessMetadata(e, t, i) {
		const n = this.kernelInstance.exports.kernel_clear_process_metadata, r = this.kernelInstance.exports.kernel_push_process_metadata_entry;
		if (!n || !r) {
			const n = this.kernelInstance.exports.kernel_set_process_argv;
			if (0 !== t || !n) throw new Error("Kernel missing bounded process metadata exports");
			const r = new TextEncoder().encode(i.join("\0"));
			if (r.byteLength > 65536) throw new Error("Legacy process argv exceeds bounded scratch transport: errno 7");
			new Uint8Array(this.kernelMemory.buffer).set(r, this.scratchOffset);
			const s = n(e, this.toKernelPtr(this.scratchOffset), r.byteLength);
			if (s < 0) throw new Error(`Failed to replace process argv for pid ${e}: errno ${-s}`);
			return;
		}
		const s = n(e, t);
		if (s < 0) throw new Error(`Failed to clear process metadata for pid ${e}: errno ${-s}`);
		const o = new TextEncoder();
		for (const a of i) {
			const i = o.encode(a);
			if (i.byteLength > 65536) throw new Error("Process metadata entry exceeds bounded scratch transport: errno 7");
			new Uint8Array(this.kernelMemory.buffer).set(i, this.scratchOffset);
			const n = r(e, t, this.toKernelPtr(this.scratchOffset), i.byteLength);
			if (n < 0) throw new Error(`Failed to append process metadata for pid ${e}: errno ${-n}`);
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
		const i = this.stdinBuffers.get(e);
		if (i) {
			const n = i.data.subarray(i.offset), r = new Uint8Array(n.length + t.length);
			r.set(n), r.set(t, n.length), this.stdinBuffers.set(e, {
				data: r,
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
		for (const [r, s] of Array.from(this.pendingSleeps.entries())) this.isRegisteredChannel(s.channel) && (this.dequeueSignalForDelivery(s.channel), this.finishSignalTermination(s.channel) || new DataView(s.channel.memory.buffer, s.channel.channelOffset).getUint32(65560, !0) > 0 && (clearTimeout(s.timer), this.pendingSleeps.delete(r), this.completeChannel(s.channel, s.syscallNr, s.origArgs, oi[s.syscallNr], -1, 4)));
	}
	onPtyOutput(e, t) {
		this.ptyOutputCallbacks.set(e, t), this.drainPtyOutput(e);
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
		new Uint8Array(this.kernelMemory.buffer).set(n, this.scratchOffset);
		const r = i(e, this.toKernelPtr(this.scratchOffset), n.length);
		if (r < 0) throw new Error(`setCwd failed for pid ${e}: errno ${-r}`);
	}
	setCredentials(e, t) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		if (null == t.uid && null == t.gid) return;
		const i = 4294967295, n = this.kernelInstance.exports.kernel_set_process_credentials;
		if (!n) throw new Error("Kernel missing kernel_set_process_credentials export");
		const r = n(e, t.uid ?? i, t.gid ?? i);
		if (r < 0) throw new Error(`setCredentials failed for pid ${e}: errno ${-r}`);
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
		const t = e(this.toKernelPtr(this.scratchOffset), Sr);
		if (t <= 0) return [];
		const i = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, t), n = new Uint8Array(t);
		n.set(i);
		const r = function(e) {
			if (e.byteLength < 4) return [];
			const t = new DataView(e.buffer, e.byteOffset, e.byteLength), i = t.getUint32(0, !0);
			let n = 4;
			const r = [], s = new TextDecoder("utf-8", { fatal: !1 });
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
				const u = s.decode(e.subarray(n, n + d));
				n += d;
				const p = e.subarray(n, n + f);
				n += f;
				const g = s.decode(p).replace(/\0/g, " ").trimEnd();
				r.push({
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
			return r;
		}(n);
		for (const s of r) {
			const e = this.processes.get(s.pid);
			e && (s.memoryBytes = e.memory.buffer.byteLength);
		}
		return r;
	}
	readProcMaps(e) {
		if (!this.initialized) return null;
		const t = this.kernelInstance.exports.kernel_read_proc_maps;
		if (!t) return null;
		const i = t(e, this.toKernelPtr(this.scratchOffset), Sr);
		if (i < 0) return null;
		if (0 === i) return "";
		const n = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, i), r = new Uint8Array(i);
		return r.set(n), new TextDecoder("utf-8", { fatal: !1 }).decode(r);
	}
	unregisterProcess(e, t) {
		const i = this.processes.get(e);
		if (!i) return !0;
		if (t && i.memory !== t) return !1;
		this.retireAsyncChannelsForProcess(e), this.discardStoppedChannelStateForProcess(e), this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.parentPid !== e && t.channel.pid !== e), this.releaseAllSharedMemoryForProcess(e), this.releaseProcessViews(e, i.memory), this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.clearProcessThreadTransportState(e), this.cleanupUdpBindings(e), this.cleanupTcpListeners(e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingSignalWaits(e), this.cleanupPendingPipeReaders(e), this.cleanupPendingPipeWriters(e), this.cancelPendingSleepsForProcess(e);
		for (const [r, s] of this.socketTimeoutTimers) r.pid === e && (clearTimeout(s), this.socketTimeoutTimers.delete(r));
		for (const r of this.epollInterests.keys()) r.startsWith(`${e}:`) && this.epollInterests.delete(r);
		this.removeFromKernelProcessTable(e), this.processes.delete(e), this.execHandoffPids?.delete(e), this.stdinFinite.delete(e), this.stdinBuffers.delete(e), this.usePolling && 0 === this.processes.size && this.stopPolling();
		const n = this.ptyIndexByPid.get(e);
		return void 0 !== n && (this.ptyIndexByPid.delete(e), this.activePtyIndices.delete(n), this.ptyOutputCallbacks.delete(n)), !0;
	}
	removeProcessFromKernelTable(e) {
		if (!this.initialized) throw new Error("Kernel is not initialized for process removal");
		this.removeFromKernelProcessTable(e);
	}
	cancelPendingSleepsForProcess(e) {
		for (const [t, i] of this.pendingSleeps) t.pid === e && (clearTimeout(i.timer), this.pendingSleeps.delete(t));
	}
	deactivateProcess(e, t) {
		const i = this.processes.get(e);
		if (!i) return !0;
		if (t && i.memory !== t) return !1;
		this.retireAsyncChannelsForProcess(e), this.discardStoppedChannelStateForProcess(e), this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.parentPid !== e && t.channel.pid !== e), this.releaseAllSharedMemoryForProcess(e), i && this.releaseProcessViews(e, i.memory), this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.clearProcessThreadTransportState(e), this.processes.delete(e), this.execHandoffPids?.delete(e), this.stdinFinite.delete(e), this.stdinBuffers.delete(e);
		const n = this.alarmTimers.get(e);
		n && (clearTimeout(n), this.alarmTimers.delete(e));
		for (const [r, s] of this.posixTimers) r.startsWith(`${e}:`) && (clearTimeout(s.timeout), s.interval && clearInterval(s.interval), this.posixTimers.delete(r));
		return this.cancelPendingSleepsForProcess(e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingSignalWaits(e), this.cleanupUdpBindings(e), this.cleanupTcpListeners(e), this.hostReaped.delete(e), !0;
	}
	releaseProcessViews(e, t) {
		const i = this.processes.get(e);
		return !(!i || i.memory !== t) && (this.kernel.releaseProcessViews(e), !0);
	}
	kernelExecPrepare(e, t) {
		const i = this.kernelInstance.exports.kernel_exec_prepare;
		if (!i) throw new Error("Kernel missing required kernel_exec_prepare export");
		const n = this.currentHandlePid;
		this.currentHandlePid = e;
		try {
			return i(e, t);
		} finally {
			this.currentHandlePid = n, this.drainAndProcessWakeupEvents();
		}
	}
	kernelExecSetup(e, t) {
		const i = this.kernelInstance.exports.kernel_exec_setup_for_thread;
		if (!i) throw new Error("Kernel missing required kernel_exec_setup_for_thread export");
		const n = this.currentHandlePid;
		this.currentHandlePid = e;
		try {
			const n = this.snapshotExecTcpListenerWakeIds(e), r = i(e, t);
			return 0 === r && this.pruneExecFdMirrors(e, n), r;
		} finally {
			this.currentHandlePid = n, this.drainAndProcessWakeupEvents();
		}
	}
	snapshotExecTcpListenerWakeIds(e) {
		const t = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx, i = /* @__PURE__ */ new Map();
		if (!t) return i;
		const n = (n, r, s) => {
			const o = s ?? t(e, r);
			o >= 0 && i.set(`${n}:${r}`, o);
		};
		for (const [s, o] of this.tcpListenerTargets) for (const t of o) t.pid === e && n(s, t.fd, t.acceptWakeIdx);
		const r = `${e}:`;
		for (const [s, o] of this.tcpListeners) {
			if (!s.startsWith(r)) continue;
			const t = Number(s.slice(r.length)), i = this.tcpListenerTargets.get(o.port)?.find((i) => i.pid === e && i.fd === t);
			n(o.port, t, i?.acceptWakeIdx);
		}
		return i;
	}
	resolveInheritedListenerFd(e, t, i) {
		const n = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		if (!n) return {
			fd: t,
			...void 0 !== i ? { acceptWakeIdx: i } : {}
		};
		const r = n(e, t);
		if (void 0 === i) return r >= 0 ? {
			fd: t,
			acceptWakeIdx: r
		} : null;
		if (r === i) return {
			fd: t,
			acceptWakeIdx: i
		};
		const s = this.kernelInstance.exports.kernel_find_listener_fd_by_accept_wake;
		let o = s?.(e, i) ?? -1;
		if (!s) {
			for (let a = 0; a < 1024; a++) if (n(e, a) === i) {
				o = a;
				break;
			}
		}
		return o >= 0 ? {
			fd: o,
			acceptWakeIdx: i
		} : null;
	}
	inheritHostFdMirrors(e, t, i = !0) {
		const n = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		for (const [, s] of this.tcpListenerTargets) for (const i of s.filter((t) => t.pid === e)) {
			const r = i.acceptWakeIdx ?? (() => {
				const t = n?.(e, i.fd) ?? -1;
				return t >= 0 ? t : void 0;
			})(), o = this.resolveInheritedListenerFd(t, i.fd, r);
			o && !s.some((e) => e.pid === t && e.fd === o.fd) && s.push({
				pid: t,
				...o
			});
		}
		if (!i) return;
		const r = this.kernelInstance.exports.kernel_fd_is_open;
		for (const [s, o] of Array.from(this.epollInterests.entries())) {
			if (!s.startsWith(`${e}:`)) continue;
			const i = Number(s.slice(s.indexOf(":") + 1));
			r && 1 !== r(t, i) || this.epollInterests.set(`${t}:${i}`, o.filter((e) => !r || 1 === r(t, e.fd)).map((e) => ({ ...e })));
		}
	}
	rollbackChildHostRegistration(e) {
		this.deactivateProcess(e);
		for (const t of Array.from(this.epollInterests.keys())) t.startsWith(`${e}:`) && this.epollInterests.delete(t);
	}
	pruneExecFdMirrors(e, t) {
		const i = this.kernelInstance.exports.kernel_fd_is_open;
		if (!i) return;
		const n = (t) => 1 === i(e, t), r = `${e}:`, s = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx, o = this.kernelInstance.exports.kernel_find_listener_fd_by_accept_wake, a = /* @__PURE__ */ new Map(), c = (i, r) => {
			const c = t.get(`${i}:${r}`);
			if (void 0 === c || !s) return n(r) ? r : null;
			if (s(e, r) === c) return r;
			if (a.has(c)) return a.get(c);
			let h = o?.(e, c) ?? -1;
			if (!o) {
				for (let t = 0; t < 1024; t++) if (s(e, t) === c) {
					h = t;
					break;
				}
			}
			const l = h >= 0 ? h : null;
			return a.set(c, l), l;
		};
		for (const [l, d] of Array.from(this.epollInterests.entries())) l.startsWith(r) && (n(Number(l.slice(r.length))) ? this.epollInterests.set(l, d.filter((e) => n(e.fd))) : this.epollInterests.delete(l));
		for (const [l, d] of Array.from(this.tcpListenerTargets.entries())) {
			const t = [];
			for (const i of d) {
				if (i.pid !== e) {
					t.push(i);
					continue;
				}
				const n = c(l, i.fd);
				null === n || t.some((t) => t.pid === e && t.fd === n) || t.push({
					...i,
					pid: e,
					fd: n
				});
			}
			if (0 === t.length) {
				this.tcpListenerTargets.delete(l), this.tcpListenerRRIndex.delete(l);
				const e = this.tcpVirtualListenerKeys.get(l);
				e && (this.io.network?.closeTcpListener?.(e), this.tcpVirtualListenerKeys.delete(l));
			} else {
				this.tcpListenerTargets.set(l, t);
				const e = this.tcpListenerRRIndex.get(l) ?? 0;
				this.tcpListenerRRIndex.set(l, e % t.length);
			}
		}
		const h = /* @__PURE__ */ new Map();
		for (const [l, d] of Array.from(this.tcpListeners.entries())) {
			if (!l.startsWith(r)) continue;
			const t = Number(l.slice(r.length)), i = c(d.port, t);
			if (i !== t) if (this.tcpListeners.delete(l), null === i) h.set(d.port, d);
			else {
				const t = `${e}:${i}`;
				this.tcpListeners.has(t) || this.tcpListeners.set(t, {
					...d,
					pid: e
				});
			}
		}
		for (const [l, d] of h) {
			const e = this.tcpListenerTargets.get(l);
			if (e && 0 !== e.length) {
				const t = e[0], i = `${t.pid}:${t.fd}`;
				this.tcpListeners.has(i) || this.tcpListeners.set(i, {
					...d,
					pid: t.pid
				});
			} else {
				d.server.close();
				const e = this.tcpVirtualListenerKeys.get(l);
				e && (this.io.network?.closeTcpListener?.(e), this.tcpVirtualListenerKeys.delete(l));
			}
		}
	}
	fdSupportsMmapWriteback(e, t) {
		const i = this.kernelInstance.exports.kernel_fd_supports_mmap_writeback;
		return !i || 1 === i(e, t);
	}
	prepareAddressSpaceForExec(e) {
		const t = this.processes.get(e)?.channels[0];
		if (!t) {
			const t = (this.sharedMappings.get(e)?.size ?? 0) > 0, i = (this.shmMappings.get(e)?.size ?? 0) > 0;
			return t || i ? -5 : 0;
		}
		try {
			this.syncAnonymousSharedMappingsFromProcess(t, { force: !0 }), this.syncFileSharedMappingsFromProcess(t, { force: !0 });
			const i = this.sharedMappings.get(e);
			if (i) {
				for (const [e, n] of i) if (n.writable) {
					if ("file" === n.backingKind && n.backingKey) {
						const e = this.sharedMmapBackings.get(n.backingKey);
						if (e && !this.flushSharedMmapBackingRange(e, n.fileOffset, n.len)) return -5;
						continue;
					}
					if (!n.backingKey && !this.pwriteFromProcessMemory(t, n.fd, e, n.len, n.fileOffset)) return -5;
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
		const i = this.shmMappings.get(e);
		if (!i) return 0;
		const n = this.kernelInstance.exports.kernel_ipc_shmdt_for_process;
		let r = 0;
		try {
			if (!n) return -5;
			for (const t of i.values()) n(e, t.segId) < 0 && (r = -5);
		} catch {
			r = -5;
		} finally {
			this.shmMappings.delete(e);
		}
		return r;
	}
	prepareProcessForExec(e, t) {
		const i = this.processes.get(e);
		if (t && (!i || i.memory !== t)) return !1;
		i && this.releaseProcessViews(e, i.memory), (this.execHandoffPids ??= /* @__PURE__ */ new Set()).add(e);
		for (const n of i?.channels ?? []) this.retireChannelListener(n);
		for (const n of this.activeChannels ?? []) n.pid === e && this.retireChannelListener(n);
		i && (i.channels = []), this.discardStoppedChannelStateForProcess(e, !1), this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingSignalWaits(e), this.cleanupPendingPipeReaders(e), this.cleanupPendingPipeWriters(e);
		for (const [n, r] of this.pendingAdvisoryLockRetries ?? []) n.pid === e && (clearTimeout(r.timer), this.pendingAdvisoryLockRetries.delete(n));
		this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.parentPid !== e), this.cancelPendingSleepsForProcess(e);
		for (const [n, r] of this.pendingFutexWaits) if (n.pid === e) {
			this.pendingFutexWaits.delete(n);
			try {
				r.retire ? r.retire() : Atomics.notify(new Int32Array(n.memory.buffer), r.futexIndex, 1);
			} catch {}
		}
		for (const n of this.pendingCancels) n.pid === e && this.pendingCancels.delete(n);
		this.clearProcessThreadTransportState(e);
		for (const [n, r] of this.posixTimers) n.startsWith(`${e}:`) && (clearTimeout(r.timeout), r.interval && clearInterval(r.interval), this.posixTimers.delete(n));
		for (const [n, r] of this.socketTimeoutTimers) n.pid === e && (clearTimeout(r), this.socketTimeoutTimers.delete(n));
		return !0;
	}
	isExecHandoffActive(e) {
		return this.execHandoffPids?.has(e) ?? !1;
	}
	clearProcessThreadTransportState(e) {
		const t = `${e}:`;
		for (const i of Array.from(this.channelTids.keys())) {
			if (!i.startsWith(t)) continue;
			const n = Number(i.slice(t.length));
			this.releaseThreadChannelOwnership(e, n);
		}
		for (const i of this.threadForkContexts.keys()) i.startsWith(t) && this.threadForkContexts.delete(i);
		for (const i of this.threadCtidPtrs.keys()) i.startsWith(t) && this.threadCtidPtrs.delete(i);
	}
	finishProcessExecHandoff(e) {
		this.execHandoffPids?.delete(e);
	}
	removeFromKernelProcessTable(e) {
		const t = this.kernelInstance?.exports.kernel_remove_process;
		if (!t) throw new Error("Kernel missing required kernel_remove_process export");
		const i = t(e);
		if (0 !== i && -3 !== i) {
			const t = i < 0 ? -i : 5;
			throw new Vi(e, void 0, t, `Kernel could not remove process ${e}: errno ${t}`);
		}
		this.drainAndProcessWakeupEvents();
	}
	attachThreadChannel(e, t) {
		const i = Mr.get(e);
		if (!i || i.owner !== this) throw new Error("Unknown, expired, or already consumed thread attachment");
		Mr.delete(e);
		const { pid: n, tid: r, fnPtr: s, argPtr: o, memory: a } = i;
		if (this.execHandoffPids?.has(n)) throw new Error(`Process ${n} is replacing its image`);
		if (!this.isProcessExecutionActive(n)) throw new Error(`Process ${n} is not running`);
		const c = this.processes.get(n);
		if (!c) throw new Error(`Process ${n} not registered`);
		if (c.memory !== a) throw new Error(`Process ${n} changed memory generation`);
		if (!Number.isSafeInteger(r) || r <= 0 || r > Di || r === n) throw new Error(`Thread channel for process ${n} requires a positive, non-leader kernel TID`);
		const h = `${n}:${t}`;
		if (c.channels.some((e) => e.channelOffset === t) || this.activeChannels.some((e) => e.pid === n && e.channelOffset === t) || this.channelTids.has(h) || this.threadForkContexts.has(h)) throw new Error(`Channel offset ${t} for process ${n} is already registered`);
		this.validateKernelTid(n, r);
		for (const [f, u] of this.channelTids) if (u === r) throw new Error(`Kernel TID ${r} is already attached to channel ${f}`);
		const l = {
			pid: n,
			memory: c.memory,
			channelOffset: t,
			i32View: new Int32Array(c.memory.buffer, t),
			consecutiveSyscalls: 0
		};
		this.observeProcessMemoryTarget(c.memory, l), this.observeProcessMemoryTarget(c.memory, l.i32View);
		try {
			c.channels.push(l), this.activeChannels.push(l), this.channelTids.set(h, r), this.threadForkContexts.set(h, {
				fnPtr: s,
				argPtr: o
			});
			const e = this.kernelInstance.exports.kernel_set_max_addr;
			if (e && !c.explicitMaxAddr) {
				const i = t - 131072;
				i >= Ti && e(n, this.toKernelPtr(i));
			}
			this.usePolling || this.listenOnChannel(l), i.attachedChannelOffset = t;
		} catch (d) {
			throw c.channels = c.channels.filter((e) => e !== l), this.activeChannels = this.activeChannels.filter((e) => e !== l), this.releaseThreadChannelOwnership(n, t), d;
		}
	}
	removeChannel(e, t) {
		const i = this.processes.get(e);
		for (const n of i?.channels ?? []) n.channelOffset === t && this.retireExactChannelAsyncState(n);
		i && (i.channels = i.channels.filter((e) => e.channelOffset !== t)), this.activeChannels = this.activeChannels.filter((i) => !(i.pid === e && i.channelOffset === t)), this.releaseThreadChannelOwnership(e, t);
	}
	releaseThreadChannelOwnership(e, t) {
		this.channelTids.delete(`${e}:${t}`), this.threadForkContexts.delete(`${e}:${t}`);
	}
	retireExactChannelAsyncState(e) {
		this.retireChannelListener(e), this.cancelParkedFifoOpen(e), this.discardStoppedChannelState(e), this.resumePreparedSignals?.delete(e), this.pendingCancels?.delete(e), this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.channel !== e);
		const t = `${e.pid}:${e.channelOffset}`, i = this.pendingSignalWaits?.get(t);
		i && clearTimeout(i.timer), this.pendingSignalWaits?.delete(t), this.signalWaitDeadlines?.delete(t);
		const n = this.pendingSleeps?.get(e);
		n && clearTimeout(n.timer), this.pendingSleeps?.delete(e);
		const r = this.pendingFutexWaits?.get(e);
		if (r) if (this.pendingFutexWaits.delete(e), r.retire) r.retire();
		else try {
			Atomics.notify(new Int32Array(e.memory.buffer), r.futexIndex);
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
		for (const i of this.processes.get(e)?.channels ?? []) t.add(i);
		for (const i of this.activeChannels ?? []) i.pid === e && t.add(i);
		for (const i of this.waitingForChild ?? []) i.channel.pid === e && t.add(i.channel);
		for (const i of this.pendingSleeps?.keys() ?? []) i.pid === e && t.add(i);
		for (const i of this.pendingFutexWaits?.keys() ?? []) i.pid === e && t.add(i);
		for (const i of this.pendingPollRetries?.keys() ?? []) i.pid === e && t.add(i);
		for (const i of this.pendingAdvisoryLockRetries?.keys() ?? []) i.pid === e && t.add(i);
		for (const i of this.pendingSelectRetries?.keys() ?? []) i.pid === e && t.add(i);
		for (const i of this.pendingCancels ?? []) i.pid === e && t.add(i);
		for (const i of this.pendingPipeReaders?.values() ?? []) for (const n of i) n.channel.pid === e && t.add(n.channel);
		for (const i of this.pendingPipeWriters?.values() ?? []) for (const n of i) n.channel.pid === e && t.add(n.channel);
		for (const i of t) this.retireExactChannelAsyncState(i);
	}
	retireChannelListener(e) {
		(this.retiredChannelListeners ??= /* @__PURE__ */ new Set()).add(e);
	}
	settleRetiredChannelListeners(e, t, i) {
		const n = this.retiredChannelListeners;
		if (!n || 0 === n.size) return Promise.resolve();
		const r = [];
		for (const s of Array.from(n)) {
			if (s.pid !== e) continue;
			if (t && s.memory !== t) continue;
			if (void 0 !== i && s.channelOffset !== i) continue;
			const n = this.retiredListenerSettlement(s);
			if (r.push(n.promise), 0 !== (this.pendingChannelListenerCounts?.get(s) ?? 0)) {
				if (!n.notified) {
					n.notified = !0;
					try {
						const e = new Int32Array(s.memory.buffer, s.channelOffset);
						Atomics.notify(e, 0 / Int32Array.BYTES_PER_ELEMENT);
					} catch {
						this.acknowledgeRetiredChannelListener(s);
					}
				}
			} else this.acknowledgeRetiredChannelListener(s);
		}
		return Promise.all(r).then(() => {});
	}
	retiredListenerSettlement(e) {
		const t = this.retiredChannelSettlements ??= /* @__PURE__ */ new Map(), i = t.get(e);
		if (i) return i;
		let n;
		const r = {
			promise: new Promise((e) => {
				n = e;
			}),
			resolve: n,
			notified: !1
		};
		return t.set(e, r), r;
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
		const t = this.pendingChannelListenerCounts ??= /* @__PURE__ */ new Map(), i = (t.get(e) ?? 1) - 1;
		return i > 0 ? t.set(e, i) : t.delete(e), i <= 0;
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
	startProcessWorkerWhenRunnable(e, t, i, n, r) {
		const s = this.processes.get(e);
		if (!s || s.memory !== t) return n(), "stale";
		const o = this.kernelInstance.exports.kernel_get_process_state, a = o(e);
		if (2 === a) return n(), "dead";
		if (a < 0) return n(), "stale";
		const c = () => {
			this.stoppedPids.add(e);
			const s = {
				expectedMemory: t,
				start: i,
				cancel: n,
				onStartError: r
			};
			let o = this.deferredProcessWorkerStarts.get(e);
			return o || (o = /* @__PURE__ */ new Set(), this.deferredProcessWorkerStarts.set(e, o)), o.add(s), "deferred";
		};
		if (1 === a) return c();
		if (0 !== a) return n(), "stale";
		if (this.pendingResumePids?.has(e) || this.stoppedPids?.has(e)) {
			if (c(), this.resumeStoppedProcess(e)) return "started";
			this.drainAndProcessWakeupEvents();
			const t = o(e);
			return 2 === t ? "dead" : t < 0 ? "stale" : "deferred";
		}
		return this.stoppedPids.delete(e), i(), "started";
	}
	listenOnChannel(e) {
		if (!this.isRegisteredChannel(e)) return;
		if (this.deferChannelWhileStopped(e)) return;
		const t = new Int32Array(e.memory.buffer, e.channelOffset);
		e.i32View = t;
		const i = Atomics.load(t, 0);
		if (1 === i) return void (this.relistenBatchSize <= 1 ? setImmediate(() => {
			this.isRegisteredChannel(e) && this.handleSyscall(e);
		}) : this.handleSyscall(e));
		const n = Atomics.waitAsync(t, 0, i);
		n.async ? (this.beginChannelListenerWait(e), n.value.then(() => {
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
	readCString(e, t, i = 256) {
		if (0 === t) return "(null)";
		const n = new Uint8Array(e.buffer);
		let r = 0;
		for (; r < i && t + r < n.length && 0 !== n[t + r];) r++;
		const s = new Uint8Array(r);
		return s.set(n.subarray(t, t + r)), new TextDecoder().decode(s);
	}
	readBytesPreview(e, t, i, n = 160) {
		if (0 === t || i <= 0) return "";
		const r = new Uint8Array(e.buffer), s = Math.max(0, Math.min(i, n, r.length - t));
		if (s <= 0) return "";
		const o = new Uint8Array(s);
		return o.set(r.subarray(t, t + s)), new TextDecoder("utf-8", { fatal: !1 }).decode(o);
	}
	formatPollFds(e, t, i) {
		if (0 === t || i <= 0) return "";
		const n = new DataView(e.buffer), r = [], s = Math.min(i, 8);
		for (let o = 0; o < s; o++) {
			const e = t + 8 * o;
			if (e + 8 > n.byteLength) break;
			const i = n.getInt32(e, !0), s = n.getInt16(e + 4, !0), a = n.getInt16(e + 6, !0);
			r.push(`{fd:${i},events:0x${(65535 & s).toString(16)},revents:0x${(65535 & a).toString(16)}}`);
		}
		return i > s && r.push("..."), r.join(",");
	}
	formatSyscallEntry(e, t, i) {
		const n = Pr[t] ?? `syscall_${t}`, r = e.pid, s = this.channelTids.get(`${r}:${e.channelOffset}`), o = void 0 !== s ? `:t${s}` : "";
		switch (t) {
			case de: return `[${r}${o}] open("${this.readCString(e.memory, i[0])}", 0x${(i[1] >>> 0).toString(16)}, 0o${(i[2] >>> 0).toString(8)})`;
			case De: return `[${r}${o}] openat(${i[0]}, "${this.readCString(e.memory, i[1])}", 0x${(i[2] >>> 0).toString(16)}, 0o${(i[3] >>> 0).toString(8)})`;
			case be: return `[${r}${o}] stat("${this.readCString(e.memory, i[0])}")`;
			case ke: return `[${r}${o}] lstat("${this.readCString(e.memory, i[0])}")`;
			case Qe: return `[${r}${o}] fstatat(${i[0]}, "${this.readCString(e.memory, i[1])}", 0x${(i[3] >>> 0).toString(16)})`;
			case Se: return `[${r}${o}] access("${this.readCString(e.memory, i[0])}", ${i[1]})`;
			case et: return `[${r}${o}] faccessat(${i[0]}, "${this.readCString(e.memory, i[1])}", ${i[2]})`;
			case Pe: return `[${r}${o}] chdir("${this.readCString(e.memory, i[0])}")`;
			case Ie: return `[${r}${o}] opendir("${this.readCString(e.memory, i[0])}")`;
			case ve: return `[${r}${o}] readlink("${this.readCString(e.memory, i[0])}", ${i[2]})`;
			case tt: return `[${r}${o}] readlinkat(${i[0]}, "${this.readCString(e.memory, i[1])}", ${i[3]})`;
			case nt: return `[${r}${o}] realpath("${this.readCString(e.memory, i[0])}")`;
			case ue: return `[${r}${o}] read(${i[0]}, ${i[2]})`;
			case pe: return `[${r}${o}] write(${i[0]}, ${i[2]}, ${JSON.stringify(this.readBytesPreview(e.memory, i[1], i[2]))})`;
			case fe: return `[${r}${o}] close(${i[0]})`;
			case ge: return `[${r}${o}] fstat(${i[0]})`;
			case we: return `[${r}${o}] fcntl(${i[0]}, ${i[1]}, ${i[2]})`;
			case Me: return `[${r}${o}] mmap(0x${(i[0] >>> 0).toString(16)}, ${i[1] >>> 0}, ${i[2]}, 0x${(i[3] >>> 0).toString(16)}, ${i[4]}, ${i[5] >>> 0})`;
			case Ae: return `[${r}${o}] munmap(0x${(i[0] >>> 0).toString(16)}, ${i[1] >>> 0})`;
			case Ce: return `[${r}${o}] brk(0x${(i[0] >>> 0).toString(16)})`;
			case oe: return `[${r}${o}] execve("${this.readCString(e.memory, i[0])}")`;
			case ae: return `[${r}${o}] fork()`;
			case ce: return `[${r}${o}] vfork()`;
			case dt: return `[${r}${o}] clone(0x${(i[0] >>> 0).toString(16)})`;
			case ze: return `[${r}${o}] exit(${i[0]})`;
			case Re: return `[${r}${o}] poll(${i[1]}, ${i[2]}, [${this.formatPollFds(e.memory, i[0], i[1])}])`;
			case Ve: return `[${r}${o}] ioctl(${i[0]}, 0x${(i[1] >>> 0).toString(16)})`;
			default: return `[${r}${o}] ${n}(${i.filter((e, t) => t < 3).join(", ")})`;
		}
	}
	formatSyscallReturn(e, t, i) {
		if (t < 0 || 0 !== i) return ` = ${t} (${Ir[i] ?? `errno=${i}`})`;
		switch (e) {
			case Me:
			case Ce: return ` = 0x${(t >>> 0).toString(16)}`;
			default: return ` = ${t}`;
		}
	}
	handleSyscall(e) {
		if (this.isRegisteredChannel(e) && !this.handleExitedProcessChannel(e) && !this.deferChannelWhileStopped(e)) try {
			if (br) {
				const t = new DataView(e.memory.buffer, e.channelOffset).getUint32(4, !0), i = performance.now();
				this._handleSyscallInner(e);
				const n = performance.now() - i;
				let r = this.profileData.get(t);
				r || (r = {
					count: 0,
					totalTimeMs: 0,
					retries: 0
				}, this.profileData.set(t, r)), r.count++, r.totalTimeMs += n;
				return;
			}
			this._handleSyscallInner(e);
		} catch (as) {
			if (as instanceof Vi) return void this.terminateForKernelProtocolFailure(e, `task binding error: ${as.message}`);
			console.error(`[handleSyscall] UNCAUGHT ERROR pid=${e.pid}:`, as), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
		}
	}
	terminateForKernelProtocolFailure(e, t) {
		console.error(`[handleSyscall] FATAL ${t}`), e.handling = !0;
		try {
			this.notifyHostProcessCrashed(e.pid, 11);
		} catch (i) {
			throw console.error(`[handleSyscall] Failed to record process ${e.pid} crash in kernel:`, i), i;
		} finally {
			this.callbacks.onExit?.(e.pid, 139);
		}
	}
	handleExitedProcessChannel(e) {
		if (!this.hostReaped?.has(e.pid)) return !1;
		const t = new DataView(e.memory.buffer, e.channelOffset).getUint32(4, !0);
		return t === wn || t === bn ? this.completeProcessExitHandshake(e, t) : e.handling = !0, !0;
	}
	completeProcessExitHandshake(e, t) {
		this.completeChannelRaw(e, 0, 0), t === bn && this.relistenChannel(e);
	}
	_handleSyscallInner(e) {
		const t = new DataView(e.memory.buffer, e.channelOffset), i = t.getUint32(4, !0), n = [];
		for (let w = 0; w < 6; w++) {
			const e = t.getBigInt64(8 + 8 * w, !0);
			i === hn && 1 === w ? n.push(Number(BigInt.asUintN(32, e))) : n.push(Number(e));
		}
		const r = e.pid;
		let s = this.syscallRing.get(r);
		s || (s = [], this.syscallRing.set(r, s)), s.push(`  ${this.formatSyscallEntry(e, i, n)}`), s.length > 30 && s.shift(), this.syscallTraceEnabled && (this.syscallTraceRing.length >= this.syscallTraceCap && this.syscallTraceRing.shift(), this.syscallTraceRing.push({
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
			],
			decoded: this.formatSyscallEntry(e, i, n)
		}));
		const o = this.config.syscallLogPtrWidth, a = void 0 !== o && this.processes.get(e.pid)?.ptrWidth === o, c = !!this.config.enableSyscallLog || a;
		let h = "";
		c && (h = this.formatSyscallEntry(e, i, n)), this.synchronizeSharedMemoryForBoundary(e);
		const l = (this.sharedMmapBackings?.size ?? 0) > 0, d = !l || this.flushSharedMappingsBeforeFileSyscall(e, i, n);
		if (l && this.hostReaped?.has(e.pid)) return;
		if (!d) return void this.completeChannel(e, i, n, void 0, -1, 5);
		if (i === Cn && 2 & n[2]) {
			const t = this.prepareFileSharedMappingsForWrite(e.pid, n[0] >>> 0, rr(n[1] >>> 0));
			if (0 !== t) return void this.completeChannel(e, i, n, void 0, -1, t);
		}
		if (i === pn || i === gn) return c && console.error(h), void this.handleFork(e, n);
		if (i === mn) return c && console.error(h), void this.handleSpawn(e, n);
		if (i === fn) return c && console.error(h), void this.handleExec(e, n);
		if (i === un) return c && console.error(h), void this.handleExecveat(e, n);
		if (i === yn) return c && console.error(h), void this.handleClone(e, n);
		if (i === wn || i === bn) return c && console.error(h), void this.handleExit(e, i, n);
		if (i === Sn) return c && console.error(h), void this.handleWaitpid(e, n);
		if (i === Pn) return c && console.error(h), void this.handleWaitid(e, n);
		if (i === Ji) {
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
				}, i = 128, r = 256, s = n[1] >>> 0, o = -385 & s, a = t[o] ?? `op${o}`, c = (s & i ? "|PRIVATE" : "") + (s & r ? "|REALTIME" : ""), h = this.channelTids.get(`${e.pid}:${e.channelOffset}`), l = void 0 !== h ? `:t${h}` : "";
				console.error(`[${e.pid}${l}] futex(0x${(n[0] >>> 0).toString(16)}, ${a}${c}, val=${n[2]})`);
			}
			this.handleFutex(e, n);
			return;
		}
		if (i === In) return c && console.error(h), void this.handleThreadCancel(e, n);
		if (i === sr || i === cr) return c && console.error(h), void this.handleWritev(e, i, n);
		if (i === or || i === ar) return c && console.error(h), void this.handleReadv(e, i, n);
		if ((i === Tn || i === Un) && n[2] > 65536) return void this.handleLargeWrite(e, i, n);
		if ((i === Fn || i === Rn) && n[2] > 65536) return void this.handleLargeRead(e, i, n);
		if (i === Jn) return void this.handleSendmsg(e, n);
		if (i === Yn) return void this.handleRecvmsg(e, n);
		if (i === En) {
			const t = n[1] >>> 0;
			if (35090 === t) return void this.handleIoctlIfconf(e, n);
			if (35088 === t) return void this.handleIoctlIfname(e, n);
			if (35111 === t) return void this.handleIoctlIfhwaddr(e, n);
			if (35093 === t) return void this.handleIoctlIfaddr(e, n);
			if (35123 === t) return void this.handleIoctlIfindex(e, n);
		}
		if (i === hr) {
			const t = n[1];
			if (5 === t || 6 === t || 7 === t || 12 === t || 13 === t || 14 === t || 36 === t || 37 === t || 38 === t) return void this.handleFcntlLock(e, n);
		}
		if (i === rn || i === sn) return void this.handleEpollCreate(e, i, n);
		if (i === on) return void this.handleEpollCtl(e, n);
		if (i === nn || i === an) return void this.handleEpollPwait(e, i, n);
		if (i === dr) return void this.handleIpcShmat(e, n);
		if (i === fr) return void this.handleIpcShmdt(e, n);
		if (i === lr) return void this.handleSemctl(e, n);
		if (i === en) return void this.handlePselect6(e, n);
		if (i === tn) return void this.handleSelect(e, n);
		if (i === hn && (n[1] < 4 || n[1] % 4 != 0)) return void this.completeChannel(e, i, n, void 0, -1, Wi);
		const f = new DataView(this.kernelMemory.buffer, this.scratchOffset), u = [...n], p = oi[i];
		let g = 0, m = !1;
		if (p) {
			const t = new Uint8Array(e.memory.buffer), r = this.getKernelMem(), s = this.scratchOffset + 72;
			for (const o of p) {
				const a = n[o.argIndex];
				if (i === En && n[1] >>> 0 == 21515 && 2 === o.argIndex) {
					const e = s + g;
					new DataView(this.kernelMemory.buffer).setInt32(e, n[2], !0), u[2] = e, g = g + 4 + 7 & -8;
					continue;
				}
				const c = i === hn && 2 === o.argIndex && "out" === o.direction;
				if (0 === a && !c) {
					if (!0 === o.required || "cstring" === o.size.type && !0 !== o.nullable) return void this.completeChannel(e, i, n, void 0, -1, Ni);
					continue;
				}
				let h;
				if ("cstring" === o.size.type) {
					const r = Ki(t, a, te - g);
					if ("errno" in r) return void this.completeChannel(e, i, n, void 0, -1, r.errno);
					h = r.size;
				} else if ("arg" === o.size.type) h = n[o.size.argIndex] * (o.size.multiplier ?? 1) + (o.size.add ?? 0);
				else if ("deref" === o.size.type) {
					const r = n[o.size.argIndex];
					if (0 === r) continue;
					if (!Hi(t, r, 4)) return void this.completeChannel(e, i, n, void 0, -1, Ni);
					h = t[r] | t[r + 1] << 8 | t[r + 2] << 16 | t[r + 3] << 24;
				} else h = o.size.size;
				if (h <= 0) continue;
				if (g + h > 65536) {
					if (h = te - g, h <= 0) continue;
					"arg" === o.size.type && (u[o.size.argIndex] = h);
				}
				if (!Hi(t, a, h)) {
					if (!c) return void this.completeChannel(e, i, n, void 0, -1, Ni);
					m = !0;
				}
				const l = s + g;
				"in" === o.direction || "inout" === o.direction ? r.set(t.subarray(a, a + h), l) : r.fill(0, l, l + h), u[o.argIndex] = l, g += h, g = g + 7 & -8;
			}
		}
		if (i === Qi) {
			const t = n[2];
			if (0 !== t) {
				const i = new DataView(e.memory.buffer, t), n = Number(i.getBigInt64(0, !0)), r = Number(i.getBigInt64(8, !0));
				u[2] = 1e3 * n + Math.floor(r / 1e6);
			} else u[2] = -1;
			const i = n[3];
			if (0 !== i) {
				const t = new DataView(e.memory.buffer, i);
				u[3] = 1, u[4] = t.getUint32(0, !0), u[5] = t.getUint32(4, !0);
			} else u[3] = 0, u[4] = 0, u[5] = 0;
		}
		!0 !== e.readinessFinalCheck || i !== Yi && i !== Qi || (u[2] = 0, e.readinessFinalCheck = !1);
		let y = null;
		if (i === Mn && n[1] >>> 0 > 0 && 1 & n[3] && !(32 & n[3]) && n[4] >= 0) {
			const t = this.prepareSharedMmapFromFile(e, n);
			if (this.hostReaped?.has(e.pid)) return;
			if ("error" === t.kind) return void this.completeChannel(e, i, n, void 0, -1, t.errno);
			y = t;
		}
		try {
			if (i === Ln) {
				const t = this.preflightFileSharedMremap(e.pid, n);
				if (0 !== t) return void this.completeChannel(e, i, n, void 0, -1, t);
			}
			try {
				if (i === Mn && 16 & n[3]) {
					if (!this.ensureFixedMmapProcessMemoryCapacity(e, n)) return "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), void this.completeChannel(e, i, n, void 0, -1, 12);
					const t = this.flushSharedMappings(e, [n[0] >>> 0, rr(n[1] >>> 0)]);
					if (this.hostReaped?.has(e.pid)) return void ("prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null));
					if (!t) return "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), void this.completeChannel(e, i, n, void 0, -1, 5);
				}
				f.setUint32(4, i, !0);
				for (let e = 0; e < 6; e++) f.setBigInt64(8 + 8 * e, BigInt(u[e]), !0);
			} catch (as) {
				throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), as;
			}
			const t = this.kernelInstance.exports.kernel_handle_channel;
			try {
				this.bindKernelTidForChannel(e);
			} catch (as) {
				throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), as;
			}
			this.currentHandlePid = e.pid;
			const r = globalThis.__sysprof, s = r ? performance.now() : 0;
			if (r) {
				const t = globalThis;
				t.__sysprofGap || (t.__sysprofGap = /* @__PURE__ */ new Map()), t.__sysprofLastSeen || (t.__sysprofLastSeen = /* @__PURE__ */ new Map());
				const i = t.__sysprofLastSeen.get(e.pid);
				if (void 0 !== i) {
					const n = s - i;
					let r = t.__sysprofGap.get(e.pid);
					r || (r = {
						count: 0,
						gapTotalMs: 0,
						gapMaxMs: 0
					}, t.__sysprofGap.set(e.pid, r)), r.count++, r.gapTotalMs += n, n > r.gapMaxMs && (r.gapMaxMs = n);
				}
				t.__sysprofLastSeen.set(e.pid, s);
			}
			try {
				t(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (as) {
				"prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), c && console.error(h + " = KERNEL THROW"), console.error(`[handleSyscall] kernel threw for pid=${e.pid} syscall=${i} args=[${n}]:`, as), i === cn && this.signalWaitDeadlines.delete(`${e.pid}:${e.channelOffset}`), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				if (this.currentHandlePid = 0, r) {
					const t = performance.now() - s, r = globalThis;
					r.__sysprofTable || (r.__sysprofTable = /* @__PURE__ */ new Map());
					const o = `${e.pid}:${i}`;
					let a = r.__sysprofTable.get(o);
					a || (a = {
						count: 0,
						totalMs: 0,
						maxMs: 0
					}, r.__sysprofTable.set(o, a)), a.count++, a.totalMs += t, t > a.maxMs && (a.maxMs = t), t > 50 && console.warn(`[sysprof] slow pid=${e.pid} nr=${i} ${t.toFixed(1)}ms args=[${n.join(",")}]`);
				}
			}
			if (this.getProcessExitSignal(e.pid) > 0) return "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), void this.handleProcessTerminated(e);
			let o = Number(f.getBigInt64(56, !0)), a = f.getUint32(64, !0);
			if (i !== cn || -1 === o && a === Oi || this.signalWaitDeadlines.delete(`${e.pid}:${e.channelOffset}`), i === hn && m && o >= 0 && (o = -1, a = Ni), i !== Mn || "prepared" !== y?.kind || o > 0 && o >>> 0 != 4294967295 || (this.releasePreparedSharedMmap(y.context), y = null), i === Mn && o > 0 && 16 & n[3]) {
				const t = [o >>> 0, rr(n[1] >>> 0)];
				this.cleanupSharedMappings(e.pid, t[0], t[1]);
			}
			if (i === Ln && o > 0 && (this.flushSharedMappings(e, [n[0] >>> 0, rr(n[1] >>> 0)]), this.hostReaped?.has(e.pid))) return;
			if (o > 0) try {
				this.ensureProcessMemoryCovers(e.pid, e.memory, i, o, n);
			} catch (as) {
				throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), as;
			}
			const l = this.highControlFloorForProcess(e.pid);
			if (i === Mn && o > 0 && o >>> 0 != 4294967295) {
				const t = o >>> 0, i = n[1] >>> 0;
				null !== l && t + i > l && console.error(`[MMAP ALERT] pid=${e.pid} mmap returned 0x${t.toString(16)} len=${i} — OVERLAPS THREAD REGION! args=[${n.map((e) => "0x" + (e >>> 0).toString(16)).join(",")}]`);
			}
			if (i === Ln && o > 0 && o >>> 0 != 4294967295) {
				const t = o >>> 0, i = n[2] >>> 0;
				null !== l && t + i > l && console.error(`[MREMAP ALERT] pid=${e.pid} mremap returned 0x${t.toString(16)} len=${i} — OVERLAPS THREAD REGION!`);
			}
			if (null !== l && i === _n && o > l && console.error(`[BRK ALERT] pid=${e.pid} brk returned 0x${(o >>> 0).toString(16)} — IN THREAD REGION!`), i === Mn && o > 0 && o >>> 0 != 4294967295) {
				const t = n[4], i = n[3] >>> 0;
				if (1 & i && 32 & i) this.trackAnonymousSharedMapping(e, o >>> 0, n);
				else if (t >= 0 && !(32 & i)) {
					if (1 & i) {
						const t = "prepared" === y?.kind ? this.registerPreparedSharedMmap(e, o >>> 0, y.context) : "unsupported" === y?.kind ? y : this.mapSharedMmapFromFile(e, o >>> 0, n);
						if (y = null, this.hostReaped?.has(e.pid)) return;
						if ("unsupported" === t.kind) {
							if (this.populateMmapFromFile(e, o >>> 0, n), this.hostReaped?.has(e.pid)) return;
						} else if ("error" === t.kind) {
							try {
								if (this.runSyntheticMemorySyscall(e, An, [o >>> 0, rr(n[1] >>> 0)]), this.hostReaped?.has(e.pid)) return;
							} catch {}
							o = -1, a = t.errno;
						}
					} else if (this.populateMmapFromFile(e, o >>> 0, n), this.hostReaped?.has(e.pid)) return;
				}
				if (o > 0) {
					const t = o >>> 0, i = this.kernel.bos.findBindingByAddr(e.pid, t);
					void 0 !== i && this.kernel.bos.primeBindFromSab(e.pid, i, e.memory);
				}
			}
			if (i === Bn && 0 === o && (this.flushSharedMappings(e, n) || (o = -1, a = 5), this.hostReaped?.has(e.pid))) return;
			if (i === An && 0 === o) {
				const t = [n[0] >>> 0, rr(n[1] >>> 0)];
				if (this.flushSharedMappings(e, t), this.hostReaped?.has(e.pid)) return;
				this.cleanupSharedMappings(e.pid, t[0], t[1]);
			}
			if (i === Ln && o > 0 && this.remapSharedMapping(e.pid, n[0] >>> 0, o >>> 0, n[2] >>> 0), i === Cn && 0 === o && this.updateSharedMappingProtection(e.pid, n[0] >>> 0, rr(n[1] >>> 0), !!(2 & n[2])), (this.sharedMmapBackings?.size ?? 0) > 0 && (this.handleSharedMappingsAfterFileSyscall(e, i, n, o, a), this.hostReaped?.has(e.pid))) return;
			const d = i === ur && 0 === o;
			if (d && (this.drainMqueueNotification(), this.finishSignalTermination(e))) return;
			const g = this.dequeueSignalForDelivery(e);
			if (d && this.finishSignalTermination(e)) return;
			if (this.handlePendingInetConnect(e, i, n, o, a)) return;
			if (this.handleFlockConflict(e, i, n, o, a, g)) return;
			if (-1 === o && a === Oi) return c && console.error(h + " = -1 (EAGAIN, will retry)"), void this.handleBlockingRetry(e, i, n);
			if (this.handleSleepDelay(e, i, n, o, a)) return;
			0 !== a || i !== kn && i !== vn || this.recheckDeferredWaitpids(), 0 !== a || i !== ln && 204 !== i && i !== dn || (this.drainAndProcessWakeupEvents(), this.scheduleWakeBlockedRetries(), this.reapKilledProcessesAfterSyscall(), 204 === i ? (this.wakePendingSignalWaits(e.pid, n[1] >>> 0, n[0] >>> 0), this.interruptWaitingChildForDirectedSignal(e.pid, n[0])) : this.interruptWaitingChildrenForGeneratedSignal(n[1])), c && console.error(h + this.formatSyscallReturn(i, o, a)), this.completeChannel(e, i, n, p, o, a);
		} catch (as) {
			throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), as;
		}
	}
	dequeueSignalForDelivery(e) {
		const t = this.resumePreparedSignals;
		if (t?.has(e)) {
			const i = new DataView(e.memory.buffer, e.channelOffset).getUint32(re, !0);
			if (i > 0) return i;
			t.delete(e);
		}
		const i = this.kernelInstance.exports.kernel_dequeue_signal;
		if (!i) return 0;
		const n = this.guestTidForChannel(e), r = this.scratchOffset + ne, s = i(e.pid, n, this.toKernelPtr(r));
		if (s < 0) throw new Vi(e.pid, n, -s, `Kernel rejected signal dequeue for tid ${n} in process ${e.pid}`);
		if (s > 0) {
			const t = this.getKernelMem();
			return new Uint8Array(e.memory.buffer).set(t.subarray(r, r + 44), e.channelOffset + ne), s;
		}
		{
			const t = e.channelOffset + ne;
			return new Uint8Array(e.memory.buffer, t, 48).fill(0), 0;
		}
	}
	completeChannel(e, t, i, n, r, s) {
		const o = {
			kind: "marshalled",
			outputWrites: this.snapshotChannelOutput(e, t, i, n, r),
			retVal: r,
			errVal: s,
			materialized: !1,
			relistenRequested: !0
		};
		this.materializePreparedChannelCompletion(e, o), this.clearSocketTimeout(e), this.clearReadinessWait(e), this.drainAllPtyOutputs(), this.flushTcpSendPipes(e.pid), this.drainAndProcessWakeupEvents(), this.publishOrParkChannelCompletion(e, o);
	}
	snapshotChannelOutput(e, t, i, n, r) {
		if (!n) return [];
		const s = [], o = new Uint8Array(e.memory.buffer), a = this.getKernelMem(), c = this.scratchOffset + 72;
		let h = 0;
		for (const l of n) {
			const n = i[l.argIndex];
			if (t === En && i[1] >>> 0 == 21515 && 2 === l.argIndex) continue;
			if (0 === n) continue;
			let d;
			if ("cstring" === l.size.type) {
				let e = 0;
				for (; e < 65536 - h - 1 && 0 !== o[n + e];) e++;
				d = e + 1;
			} else if ("arg" === l.size.type) d = i[l.size.argIndex] * (l.size.multiplier ?? 1) + (l.size.add ?? 0);
			else if ("deref" === l.size.type) {
				const e = i[l.size.argIndex];
				if (0 === e) continue;
				d = o[e] | o[e + 1] << 8 | o[e + 2] << 16 | o[e + 3] << 24;
			} else d = l.size.size;
			if (d <= 0) continue;
			if (h + d > 65536 && (d = te - h, d <= 0)) continue;
			const f = c + h;
			if (!("out" !== l.direction && "inout" !== l.direction || "out" === l.direction && r < 0)) {
				let i = d;
				if ("out" === l.direction && "arg" === l.size.type) {
					const e = l.copyRetvalAdd ?? 0;
					0 === r ? i = Math.min(e, d) : r + e < d && (i = r + e);
				}
				let o = new Uint8Array(i);
				o.set(a.subarray(f, f + i)), t === cn && 1 === l.argIndex && 8 === this.getPtrWidth(e.pid) && i >= 32 && (o.copyWithin(16, 12, 24), o.fill(0, 12, 16)), s.push({
					ptr: n,
					bytes: o
				});
			}
			h += d, h = h + 7 & -8;
		}
		return s;
	}
	publishOrParkChannelCompletion(e, t) {
		if (this.stoppedPids?.has(e.pid) && this.isRegisteredChannel(e)) {
			const i = this.parkedChannelCompletions ??= /* @__PURE__ */ new Map(), n = i.get(e);
			n ? n.relistenRequested ||= t.relistenRequested : (this.materializePreparedChannelCompletion(e, t), e.handling = !0, this.deferredStoppedChannels?.delete(e), i.set(e, {
				prepared: t,
				relistenRequested: t.relistenRequested
			}));
			return;
		}
		this.publishPreparedChannelCompletion(e, t);
	}
	publishPreparedChannelCompletion(e, t) {
		this.materializePreparedChannelCompletion(e, t), e.handling = !1;
		const i = new DataView(e.memory.buffer, e.channelOffset);
		i.setBigInt64(56, BigInt(t.retVal), !0), i.setUint32(64, t.errVal, !0), this.resumePreparedSignals?.delete(e), this.pendingCancels?.delete(e);
		const n = new Int32Array(e.memory.buffer, e.channelOffset);
		Atomics.store(n, 0, 2), Atomics.notify(n, 0, 1), t.relistenRequested && this.isRegisteredChannel(e) && this.relistenChannel(e);
	}
	materializePreparedChannelCompletion(e, t) {
		if (t.materialized) return;
		const i = new Uint8Array(e.memory.buffer);
		for (const n of t.outputWrites) i.set(n.bytes, n.ptr);
		t.outputWrites = [];
		try {
			this.synchronizeSharedMemoryForBoundary(e);
		} catch (as) {
			console.error(`[completeChannel] shared-memory synchronization failed for pid=${e.pid}:`, as), t.retVal = -5, t.errVal = 5;
		}
		t.materialized = !0;
	}
	deferChannelWhileStopped(e) {
		return !!this.stoppedPids?.has(e.pid) && (!this.isRegisteredChannel(e) || (this.parkedChannelCompletions?.has(e) || (this.deferredStoppedChannels ??= /* @__PURE__ */ new Map()).set(e, !0), e.handling = !0, !0));
	}
	resumeStoppedProcess(e) {
		const t = this.kernelInstance.exports.kernel_get_process_state, i = t(e);
		if (0 !== i) return 1 !== i && this.discardStoppedChannelStateForProcess(e), !1;
		const n = this.processes.get(e);
		if (!n || 0 === n.channels.length) return (this.pendingResumePids ??= /* @__PURE__ */ new Set()).add(e), (this.stoppedPids ??= /* @__PURE__ */ new Set()).add(e), !0;
		this.pendingResumePids?.delete(e);
		const r = this.parkedChannelCompletions ??= /* @__PURE__ */ new Map(), s = this.deferredStoppedChannels ??= /* @__PURE__ */ new Map(), o = this.resumePreparedSignals ??= /* @__PURE__ */ new WeakSet(), a = [];
		(this.stoppedPids ??= /* @__PURE__ */ new Set()).add(e);
		for (const u of Array.from(n.channels)) {
			if (!this.isRegisteredChannel(u)) continue;
			let i = new DataView(u.memory.buffer, u.channelOffset).getUint32(re, !0);
			if (i > 0 ? o.add(u) : (o.delete(u), i = this.dequeueSignalForDelivery(u), i > 0 && o.add(u)), this.finishSignalTermination(u)) return !1;
			const n = t(e);
			if (1 === n) return this.stoppedPids.add(e), !1;
			if (0 !== n) return this.discardStoppedChannelStateForProcess(e), !1;
			i > 0 && a.push(u);
		}
		for (const u of a) {
			if (r.has(u)) continue;
			if (this.interruptStoppedChannelWithPreparedSignal(u), this.finishSignalTermination(u)) return !1;
			const i = t(e);
			if (1 === i) return !1;
			if (0 !== i) return this.discardStoppedChannelStateForProcess(e), !1;
		}
		if (0 !== t(e)) return !1;
		this.stoppedPids.delete(e);
		const c = this.deferredProcessWorkerStarts.get(e);
		if (c) {
			this.deferredProcessWorkerStarts.delete(e);
			const t = Array.from(c);
			for (let i = 0; i < t.length; i++) {
				const n = t[i], r = this.processes.get(e);
				if (r && r.memory === n.expectedMemory) try {
					n.start();
				} catch (f) {
					if (n.cancel(), console.error(`[kernel-worker] deferred Worker launch failed for pid=${e}:`, f), !0 === n.onStartError?.(f)) continue;
					for (const e of t.slice(i + 1)) try {
						e.cancel();
					} catch {}
					return this.notifyHostProcessCrashed(e), this.callbacks.onExit && this.callbacks.onExit(e, 139), !1;
				}
				else n.cancel();
			}
		}
		const h = Array.from(r.entries()).filter(([t]) => t.pid === e);
		for (const [u, p] of h) {
			if (r.get(u) !== p) continue;
			if (!this.isRegisteredChannel(u)) {
				r.delete(u), s.delete(u);
				continue;
			}
			const i = t(e);
			if (1 === i) return this.stoppedPids.add(e), !1;
			if (0 !== i) return this.discardStoppedChannelStateForProcess(e), !1;
			r.delete(u), s.delete(u), p.prepared.relistenRequested ||= p.relistenRequested, this.publishPreparedChannelCompletion(u, p.prepared);
		}
		const l = Array.from(s.keys()).filter((t) => t.pid === e);
		for (const u of l) s.delete(u), this.isRegisteredChannel(u) && (u.handling = !1, this.relistenChannel(u));
		const d = t(e);
		return 1 === d ? (this.stoppedPids.add(e), !1) : 0 === d || (this.discardStoppedChannelStateForProcess(e), !1);
	}
	interruptStoppedChannelWithPreparedSignal(e) {
		const t = this.waitingForChild.findIndex((t) => t.channel === e);
		if (t >= 0) {
			const [e] = this.waitingForChild.splice(t, 1);
			return !!this.interruptWaiterWithPendingSignal(e) || (this.waitingForChild.splice(t, 0, e), !1);
		}
		const i = this.pendingSleeps.get(e);
		if (i) return clearTimeout(i.timer), this.pendingSleeps.delete(e), this.completeSleepWithSignalCheck(i.channel, i.syscallNr, i.origArgs, i.retVal, i.errVal), !0;
		const n = this.pendingFutexWaits.get(e);
		if (n) return n.interrupt ? n.interrupt(-4, 4) : Atomics.notify(new Int32Array(e.memory.buffer), n.futexIndex, 1), !0;
		let r = this.pendingPollRetries.has(e) || (this.pendingAdvisoryLockRetries?.has(e) ?? !1) || this.pendingSelectRetries.has(e);
		for (const s of this.pendingPipeReaders.values()) if (s.some((t) => t.channel === e)) {
			r = !0;
			break;
		}
		if (!r) {
			for (const s of this.pendingPipeWriters.values()) if (s.some((t) => t.channel === e)) {
				r = !0;
				break;
			}
		}
		return !!r && (this.cancelParkedFifoOpen(e), this.removePendingPipeReader(e), this.removePendingPipeWriter(e), this.completeChannelRaw(e, -4, 4), this.relistenChannel(e), !0);
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
		if (t !== gr && t !== mr) return !1;
		try {
			return 0 === this.runSyntheticMemorySyscall(e, In, [this.guestTidForChannel(e)]).errVal;
		} catch {
			return !1;
		}
	}
	interruptPendingFifoOpenCancellation(e, t) {
		return (t === gr || t === mr) && !!this.pendingCancels.has(e) && !!this.cancelParkedFifoOpen(e) && (this.pendingCancels.delete(e), this.completeChannelRaw(e, -4, 4), this.relistenChannel(e), !0);
	}
	failDeferredCloneLaunch(e, t, i) {
		for (const [n, r] of this.parkedChannelCompletions ?? []) {
			if (n.pid !== e || r.prepared.retVal !== t) continue;
			const s = new DataView(n.memory.buffer, n.channelOffset);
			if (s.getUint32(4, !0) !== yn) continue;
			const o = Number(s.getBigInt64(8, !0)), a = Number(s.getBigInt64(24, !0));
			return 1048576 & o && Hi(new Uint8Array(n.memory.buffer), a, 4) && new DataView(n.memory.buffer).setInt32(a, 0, !0), r.prepared.outputWrites = [], r.prepared.retVal = -1, r.prepared.errVal = i, !0;
		}
		return !1;
	}
	discardStoppedChannelStateForProcess(e, t = !0) {
		const i = this.deferredProcessWorkerStarts?.get(e);
		if (i) {
			this.deferredProcessWorkerStarts.delete(e);
			for (const e of i) try {
				e.cancel();
			} catch {}
		}
		for (const n of Array.from(this.parkedChannelCompletions?.keys() ?? [])) n.pid === e && this.parkedChannelCompletions.delete(n);
		for (const n of Array.from(this.deferredStoppedChannels?.keys() ?? [])) n.pid === e && this.deferredStoppedChannels.delete(n);
		t && this.stoppedPids?.delete(e), t && this.pendingResumePids?.delete(e);
	}
	discardStoppedChannelState(e) {
		this.parkedChannelCompletions?.delete(e), this.deferredStoppedChannels?.delete(e);
	}
	killAllBlockedForTeardown() {
		for (const i of this.pendingPollRetries.values()) i.timer && clearTimeout(i.timer);
		for (const i of this.pendingAdvisoryLockRetries?.values() ?? []) clearTimeout(i.timer);
		for (const i of this.pendingSelectRetries.values()) i.timer && clearTimeout(i.timer);
		for (const i of this.pendingSleeps.values()) clearTimeout(i.timer);
		for (const i of this.pendingSignalWaits.values()) clearTimeout(i.timer);
		this.pendingPipeReaders.clear(), this.pendingPipeWriters.clear(), this.pendingPollRetries.clear(), this.pendingAdvisoryLockRetries?.clear(), this.pendingSelectRetries.clear(), this.pendingSleeps.clear(), this.pendingSignalWaits.clear(), this.signalWaitDeadlines.clear(), this.pendingFutexWaits.clear();
		const e = /* @__PURE__ */ new Set(), t = this.kernelInstance?.exports.kernel_get_process_exit_status;
		for (const i of this.processes.values()) if (!t || -1 === t(i.pid)) for (const t of i.channels) {
			let i;
			try {
				const e = new Int32Array(t.memory.buffer, t.channelOffset);
				i = Atomics.load(e, 0);
			} catch {
				continue;
			}
			if (1 === i) try {
				this.wakeChannelForTeardownExit(t), e.add(t.pid);
			} catch (as) {
				console.error(`[killAllBlockedForTeardown] wake failed for pid=${t.pid} off=${t.channelOffset}: ${as}`);
			}
		}
		return e;
	}
	wakeProcessWorkersForExecRetirement(e, t) {
		const i = /* @__PURE__ */ new Set(), n = this.processes.get(e);
		if (!n) return i;
		if (n.memory !== t) throw new Error(`Exec retirement generation changed for pid ${e}`);
		const r = n.channels.filter((e) => {
			if (e.memory !== t) return !1;
			const i = new DataView(t.buffer, e.channelOffset).getUint32(4, !0);
			return 1 === Atomics.load(new Int32Array(t.buffer, e.channelOffset), 0) && (i === fn || i === un);
		});
		if (1 !== r.length) throw new Error(`Exec retirement expected exactly one execve/execveat caller for pid ${e}, found ${r.length}`);
		for (const s of n.channels) {
			if (s.memory !== t) throw new Error(`Exec retirement found a mixed memory generation for pid ${e}`);
			const n = new Int32Array(s.memory.buffer, s.channelOffset);
			if (1 !== Atomics.load(n, 0)) continue;
			const r = new DataView(s.memory.buffer, s.channelOffset);
			r.setUint32(re, 9, !0), r.setUint32(65564, 0, !0), r.setUint32(65584, 1262835794, !0), this.completeChannelRaw(s, -1, 4), i.add(s.channelOffset);
		}
		return i;
	}
	wakeChannelForTeardownExit(e) {
		const t = new DataView(e.memory.buffer, e.channelOffset);
		t.setUint32(re, 9, !0), t.setUint32(65564, 0, !0);
		const i = t.getUint32(4, !0), n = [];
		for (let r = 0; r < 6; r++) n.push(Number(t.getBigInt64(8 + 8 * r, !0)));
		this.completeChannel(e, i, n, oi[i], -1, 4);
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
	completeChannelRaw(e, t, i) {
		this.clearSocketTimeout(e), this.clearReadinessWait(e), this.pendingCancels.delete(e);
		const n = {
			kind: "raw",
			outputWrites: [],
			retVal: t,
			errVal: i,
			materialized: !1,
			relistenRequested: !1
		};
		this.materializePreparedChannelCompletion(e, n), this.drainAndProcessWakeupEvents(), this.publishOrParkChannelCompletion(e, n);
	}
	resolvePollReadinessIndices(e, t) {
		const i = this.kernelInstance.exports.kernel_get_fd_pipe_idx ?? this.kernelInstance.exports.kernel_get_socket_recv_pipe, n = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		if (!i && !n) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const r = t[0], s = t[1];
		if (0 === r || 0 === s) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const o = this.activeChannels.find((t) => t.pid === e);
		if (!o) return {
			pipeIndices: [],
			acceptIndices: []
		};
		const a = [], c = [], h = new DataView(o.memory.buffer);
		for (let l = 0; l < s; l++) {
			const t = h.getInt32(r + 8 * l, !0);
			if (t < 0) continue;
			const s = h.getInt16(r + 8 * l + 4, !0);
			if (i) {
				const n = i(e, t);
				n >= 0 && a.push(n);
			}
			if (n && 1 & s) {
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
		const n = `${e}:`, r = [], s = [];
		for (const [o, a] of this.epollInterests) if (o.startsWith(n)) for (const n of a) {
			if (t) {
				const i = t(e, n.fd);
				i >= 0 && r.push(i);
			}
			if (i && 1 & n.events) {
				const t = i(e, n.fd);
				t >= 0 && s.push(t);
			}
		}
		return {
			pipeIndices: r,
			acceptIndices: s
		};
	}
	wakeBlockedAccept(e) {
		const t = Array.from(this.pendingPollRetries.entries()).filter(([, t]) => t.acceptIndices?.includes(e));
		for (const [i, n] of t) this.pendingPollRetries.get(i) === n && (null !== n.timer && clearTimeout(n.timer), this.pendingPollRetries.delete(i), this.isRegisteredChannel(n.channel) && this.retrySyscall(n.channel));
	}
	wakeBlockedPoll(e, t) {
		const i = Array.from(this.pendingPollRetries.entries()).filter(([, i]) => i.channel.pid === e && i.pipeIndices.includes(t));
		for (const [n, r] of i) this.pendingPollRetries.get(n) === r && (null !== r.timer && clearTimeout(r.timer), this.pendingPollRetries.delete(n), this.isRegisteredChannel(r.channel) && this.retrySyscall(r.channel));
	}
	notifyPipeReadable(e, t) {
		const i = this.pendingPipeReaders.get(e);
		if (i && i.length > 0) {
			this.pendingPipeReaders.delete(e);
			for (const e of i) this.isRegisteredChannel(e.channel) && this.retrySyscall(e.channel);
		}
		const n = Array.from(this.pendingPollRetries.entries()).filter(([, i]) => (void 0 === t || i.channel.pid === t) && i.pipeIndices.includes(e));
		for (const [r, s] of n) this.pendingPollRetries.get(r) === s && (null !== s.timer && clearTimeout(s.timer), this.pendingPollRetries.delete(r), this.isRegisteredChannel(s.channel) && this.retrySyscall(s.channel));
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
		for (const [t, i] of this.pendingPollRetries) i.channel.pid === e && (i.timer && clearTimeout(i.timer), this.pendingPollRetries.delete(t));
	}
	cleanupPendingSelectRetries(e) {
		for (const [t, i] of this.pendingSelectRetries) i.channel.pid === e && (null !== i.timer && (clearTimeout(i.timer), clearImmediate(i.timer)), this.pendingSelectRetries.delete(t));
	}
	drainAndProcessWakeupEvents() {
		const e = this.kernelInstance.exports.kernel_drain_wakeup_events;
		if (!e) return;
		const t = [];
		for (;;) {
			const i = e(this.toKernelPtr(this.scratchOffset), 1280, 256);
			if (i <= 0) break;
			const n = new Uint8Array(this.kernelMemory.buffer);
			for (let e = 0; e < i; e++) {
				const i = this.scratchOffset + 5 * e;
				t.push({
					wakeIdx: (n[i] | n[i + 1] << 8 | n[i + 2] << 16 | n[i + 3] << 24) >>> 0,
					wakeType: n[i + 4]
				});
			}
			if (i < 256) break;
		}
		if (0 === t.length) return;
		let i = !1, n = !1, r = !1;
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
			4 & o && this.wakeBlockedAccept(s), 8 & o && (n = !0), 64 & o && (r = !0), 15 & o && (i = !0);
		}
		n && this.wakeBlockedFallbackWriters(), r && this.wakeBlockedAdvisoryLockRetries(), i && (this.anyPendingRetryNeedsSignalSafeWake() ? this.scheduleWakeBlockedRetriesDeferred() : this.scheduleWakeBlockedRetries());
	}
	wakeBlockedAdvisoryLockRetries() {
		const e = this.pendingAdvisoryLockRetries;
		if (!e || 0 === e.size) return;
		const t = Array.from(e.entries());
		for (const [i, n] of t) e.get(i) === n && (clearTimeout(n.timer), e.delete(i), this.isRegisteredChannel(n.channel) && this.retrySyscall(n.channel));
	}
	notifyParentOfChildStateTransition(e) {
		const t = this.getParentPid(e);
		if (void 0 === t) return;
		1 !== (0, this.kernelInstance.exports.kernel_has_sa_nocldstop)(t) ? this.sendSignalToProcess(t, 17) : this.wakeWaitingParent(t);
	}
	wakeBlockedFallbackWriters() {
		const e = Array.from(this.pendingPollRetries.entries()).filter(([, e]) => e.isWriteRetry);
		for (const [t, i] of e) this.pendingPollRetries.get(t) === i && (this.pendingPollRetries.delete(t), null !== i.timer && clearTimeout(i.timer), this.isRegisteredChannel(i.channel) && this.retrySyscall(i.channel));
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
		for (const [i, n] of this.pendingPollRetries) {
			if (!n.needsSignalSafeWake) continue;
			null !== n.timer && clearTimeout(n.timer);
			const r = n.deadline && n.deadline > 0 ? Math.max(1, n.deadline - t) : e;
			n.timer = setTimeout(() => {
				this.pendingPollRetries.get(i) === n && (this.pendingPollRetries.delete(i), this.isRegisteredChannel(n.channel) && this.retrySyscall(n.channel));
			}, Math.max(1, Math.min(e, r)));
		}
	}
	postponeSignalSafeSelectRetries(e) {
		const t = Date.now();
		for (const [i, n] of this.pendingSelectRetries) {
			if (!n.needsSignalSafeWake) continue;
			null !== n.timer && (clearTimeout(n.timer), clearImmediate(n.timer));
			const r = n.deadline > 0 ? Math.max(1, n.deadline - t) : e;
			n.timer = setTimeout(() => {
				this.pendingSelectRetries.get(i) === n && (this.pendingSelectRetries.delete(i), this.isRegisteredChannel(n.channel) && (n.syscallNr === tn ? this.handleSelect(n.channel, n.origArgs) : this.handlePselect6(n.channel, n.origArgs)));
			}, Math.max(1, Math.min(e, r)));
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
		for (const [i, n] of e) this.isRegisteredChannel(n.channel) && (null !== n.timer && clearTimeout(n.timer), this.retrySyscall(n.channel));
		for (const [, i] of t) this.isRegisteredChannel(i.channel) && (clearTimeout(i.timer), clearImmediate(i.timer), i.syscallNr === tn ? this.handleSelect(i.channel, i.origArgs) : this.handlePselect6(i.channel, i.origArgs));
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
	getReadinessDeadline(e, t) {
		return t <= 0 ? -1 : (void 0 === e.readinessDeadline && (e.readinessDeadline = Date.now() + t), e.readinessDeadline);
	}
	clearReadinessWait(e) {
		e.readinessDeadline = void 0, e.readinessFinalCheck = void 0;
		const t = this.pendingPollRetries.get(e);
		t && (null !== t.timer && clearTimeout(t.timer), this.pendingPollRetries.delete(e));
		const i = this.pendingAdvisoryLockRetries?.get(e);
		i && (clearTimeout(i.timer), this.pendingAdvisoryLockRetries.delete(e));
		const n = this.pendingSelectRetries.get(e);
		n && (null !== n.timer && (clearTimeout(n.timer), clearImmediate(n.timer)), this.pendingSelectRetries.delete(e));
	}
	removePendingPipeReader(e) {
		if (this.pendingPipeReaders) for (const [t, i] of this.pendingPipeReaders) {
			const n = i.filter((t) => t.channel !== e);
			0 === n.length ? this.pendingPipeReaders.delete(t) : n.length !== i.length && this.pendingPipeReaders.set(t, n);
		}
	}
	removePendingPipeWriter(e) {
		if (this.pendingPipeWriters) for (const [t, i] of this.pendingPipeWriters) {
			const n = i.filter((t) => t.channel !== e);
			0 === n.length ? this.pendingPipeWriters.delete(t) : n.length !== i.length && this.pendingPipeWriters.set(t, n);
		}
	}
	handleThreadCancel(e, t) {
		const i = t[0], n = this.processes.get(e.pid);
		if (this.runSyntheticMemorySyscall(e, In, [i]), this.completeChannelRaw(e, 0, 0), this.relistenChannel(e), !n) return;
		let r;
		for (const d of n.channels) if (this.guestTidForChannel(d) === i) {
			r = d;
			break;
		}
		if (!r) return;
		this.pendingCancels.add(r);
		const s = this.pendingFutexWaits.get(r);
		if (s) {
			if (s.interrupt) s.interrupt(-4, 4);
			else {
				const e = new Int32Array(r.memory.buffer);
				Atomics.notify(e, s.futexIndex, 1);
			}
			return;
		}
		const o = this.pendingPollRetries.get(r);
		if (o) return null !== o.timer && clearTimeout(o.timer), this.pendingPollRetries.delete(r), this.completeChannelRaw(r, -4, 4), void this.relistenChannel(r);
		const a = this.pendingAdvisoryLockRetries?.get(r);
		if (a) return clearTimeout(a.timer), this.pendingAdvisoryLockRetries.delete(r), this.completeChannelRaw(r, -4, 4), void this.relistenChannel(r);
		const c = this.pendingSelectRetries.get(r);
		if (c) return clearTimeout(c.timer), clearImmediate(c.timer), this.pendingSelectRetries.delete(r), this.completeChannelRaw(r, -4, 4), void this.relistenChannel(r);
		let h = !1;
		for (const [d, f] of this.pendingPipeReaders) {
			const e = f.filter((e) => e.channel !== r);
			e.length !== f.length && (0 === e.length ? this.pendingPipeReaders.delete(d) : this.pendingPipeReaders.set(d, e), h = !0);
		}
		for (const [d, f] of this.pendingPipeWriters) {
			const e = f.filter((e) => e.channel !== r);
			e.length !== f.length && (0 === e.length ? this.pendingPipeWriters.delete(d) : this.pendingPipeWriters.set(d, e), h = !0);
		}
		if (h) return this.clearSocketTimeout(r), this.completeChannelRaw(r, -4, 4), void this.relistenChannel(r);
		const l = this.waitingForChild.findIndex((e) => e.channel === r);
		l >= 0 && (this.waitingForChild.splice(l, 1), this.completeChannelRaw(r, -4, 4), this.relistenChannel(r));
	}
	dumpProfile() {
		if (!this.profileData) return void console.error("[profile] Profiling not enabled. Set WASM_POSIX_PROFILE=1");
		const e = Array.from(this.profileData.entries()).sort((e, t) => t[1].totalTimeMs - e[1].totalTimeMs);
		let t = 0, i = 0, n = 0;
		console.error("\n=== Syscall Profile ==="), console.error(`${"Syscall".padEnd(8)} ${"Count".padStart(10)} ${"Time(ms)".padStart(12)} ${"Avg(ms)".padStart(10)} ${"Retries".padStart(10)}`), console.error("-".repeat(52));
		for (const [r, s] of e) t += s.count, i += s.totalTimeMs, n += s.retries, console.error(`${String(r).padEnd(8)} ${String(s.count).padStart(10)} ${s.totalTimeMs.toFixed(2).padStart(12)} ${(s.totalTimeMs / s.count).toFixed(3).padStart(10)} ${String(s.retries).padStart(10)}`);
		console.error("-".repeat(52)), console.error(`${"TOTAL".padEnd(8)} ${String(t).padStart(10)} ${i.toFixed(2).padStart(12)} ${(i / (t || 1)).toFixed(3).padStart(10)} ${String(n).padStart(10)}`), console.error(`Pending pipe readers: ${this.pendingPipeReaders.size}, writers: ${this.pendingPipeWriters.size}`), console.error("=== End Profile ===\n");
	}
	flushTcpSendPipes(e) {
		const t = this.tcpConnections.get(e);
		if (!t || 0 === t.length) return;
		const i = this.kernelInstance.exports.kernel_pipe_read, n = this.getKernelMem();
		for (const r of t) {
			for (;;) {
				const e = $i("kernel_pipe_read", i(0, r.sendPipeIdx, this.toKernelPtr(r.scratchOffset), 65536), 65536);
				if (e <= 0) break;
				const t = Buffer.from(n.slice(r.scratchOffset, r.scratchOffset + e));
				r.clientSocket.destroyed || r.clientSocket.write(t);
			}
			r.schedulePump();
		}
	}
	handlePendingInetConnect(e, t, i, n, r) {
		if (t !== tr || -1 !== n || 115 !== r && 114 !== r) return !1;
		const s = i[1], o = i[2];
		if (!Number.isSafeInteger(s) || s <= 0 || o < 2 || s + 2 > e.memory.buffer.byteLength) return !1;
		if (2 !== new DataView(e.memory.buffer).getUint16(s, !0)) return !1;
		const a = this.kernelInstance.exports.kernel_is_fd_nonblock;
		return 1 === a?.(e.pid, i[0]) ? this.completeChannel(e, t, i, oi[t], -1, r) : this.handleBlockingRetry(e, t, i), !0;
	}
	parkAdvisoryLockRetry(e, t = hr) {
		if (!this.isRegisteredChannel(e)) return;
		const i = this.pendingAdvisoryLockRetries ??= /* @__PURE__ */ new Map(), n = i.get(e);
		n && clearTimeout(n.timer);
		const r = setTimeout(() => {
			const t = i.get(e);
			t && t.timer === r && (i.delete(e), this.isAsyncChannelProcessActive(e) && this.retrySyscall(e));
		}, 10);
		if (i.set(e, {
			timer: r,
			channel: e
		}), br) {
			const e = this.profileData.get(t);
			e && e.retries++;
		}
	}
	handleFlockConflict(e, t, i, n, r, s) {
		return t === wr && -1 === n && r === Oi && (4 & i[1] ? this.completeChannel(e, t, i, void 0, n, r) : s > 0 ? this.completeChannel(e, t, i, void 0, -1, 4) : this.parkAdvisoryLockRetry(e, t), !0);
	}
	handleBlockingRetry(e, t, i) {
		if (!this.isRegisteredChannel(e)) return;
		if (this.interruptPendingFifoOpenCancellation(e, t)) return;
		if (t === Ji && !(127 & i[1])) {
			const t = i[0], n = i[2], r = new Int32Array(e.memory.buffer), s = t >>> 2;
			if (Atomics.load(r, s) !== n) return void this.retrySyscall(e);
			const o = Atomics.waitAsync(r, s, n);
			o.async ? o.value.then(() => {
				this.isRegisteredChannel(e) && this.retrySyscall(e);
			}) : setImmediate(() => this.retrySyscall(e));
			return;
		}
		if (t === Yi || t === Qi) {
			let n = -1;
			const r = t === Qi && 0 !== i[3];
			if (t === Yi) n = i[2];
			else {
				const t = i[2];
				if (0 !== t) {
					const i = new DataView(e.memory.buffer, t), r = Number(i.getBigInt64(0, !0)), s = Number(i.getBigInt64(8, !0));
					n = 1e3 * r + Math.floor(s / 1e6);
				}
			}
			if (0 === n) return void this.completeChannel(e, t, i, oi[t], 0, 0);
			const s = this.getReadinessDeadline(e, n);
			if (s > 0 && Date.now() >= s) return e.readinessFinalCheck = !0, void this.retrySyscall(e);
			const { pipeIndices: o, acceptIndices: a } = this.resolvePollReadinessIndices(e.pid, i), c = i[1];
			if (n > 0 && 0 === c) {
				const t = Math.max(s - Date.now(), 1), i = setTimeout(() => {
					this.pendingPollRetries.get(e)?.timer === i && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && (e.readinessFinalCheck = !0, this.retrySyscall(e)));
				}, t);
				this.pendingPollRetries.set(e, {
					timer: i,
					channel: e,
					pipeIndices: o,
					acceptIndices: a,
					needsSignalSafeWake: r,
					deadline: s
				});
				return;
			}
			const h = () => {
				const t = this.pendingPollRetries.get(e);
				t && t.timer === d && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && this.retrySyscall(e));
			}, l = o.length > 0 || a.length > 0 ? s > 0 ? Math.min(s - Date.now(), 10) : 10 : s > 0 ? Math.min(s - Date.now(), 50) : 50, d = setTimeout(h, Math.max(l, 1));
			this.pendingPollRetries.set(e, {
				timer: d,
				channel: e,
				pipeIndices: o,
				acceptIndices: a,
				needsSignalSafeWake: r,
				deadline: s
			});
			return;
		}
		if (t === cn) {
			const n = i[2];
			if (0 === n) {
				const t = `${e.pid}:${e.channelOffset}`, n = this.pendingSignalWaits.get(t);
				n && clearTimeout(n.timer);
				const r = setTimeout(() => {
					this.pendingSignalWaits.delete(t), this.isRegisteredChannel(e) && this.retrySyscall(e);
				}, 500);
				this.pendingSignalWaits.set(t, {
					timer: r,
					channel: e,
					origArgs: i
				});
				return;
			}
			const r = new DataView(e.memory.buffer, n), s = Number(r.getBigInt64(0, !0)), o = Number(r.getBigInt64(8, !0)), a = 1e3 * s + Math.floor(o / 1e6), c = 11, h = `${e.pid}:${e.channelOffset}`;
			if (a <= 0) this.signalWaitDeadlines.delete(h), this.completeChannel(e, t, i, oi[t], -1, c);
			else {
				const n = this.signalWaitDeadlines.get(h), r = n?.deadline ?? performance.now() + a;
				n || this.signalWaitDeadlines.set(h, {
					pid: e.pid,
					deadline: r
				});
				const s = r - performance.now();
				if (s <= 0) return this.signalWaitDeadlines.delete(h), void this.completeChannel(e, t, i, oi[t], -1, c);
				const o = this.pendingSignalWaits.get(h);
				o && clearTimeout(o.timer);
				const l = setTimeout(() => {
					this.pendingSignalWaits.delete(h), this.signalWaitDeadlines.delete(h), this.isRegisteredChannel(e) && this.completeChannel(e, t, i, oi[t], -1, c);
				}, s);
				this.pendingSignalWaits.set(h, {
					timer: l,
					channel: e,
					origArgs: i
				});
			}
			return;
		}
		if (function(e, t) {
			let i;
			switch (e) {
				case qn:
				case jn:
				case Xn:
				case Zn:
					i = t[3];
					break;
				case Jn:
				case Yn:
					i = t[2];
					break;
				default: return !1;
			}
			return void 0 !== i && !!(64 & i);
		}(t, i)) return void this.completeChannel(e, t, i, oi[t], -1, Oi);
		if (kr.has(t) || vr.has(t) || t === Qn || t === er || t === tr) {
			const n = i[0], r = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (r && 1 === r(e.pid, n)) return void this.completeChannel(e, t, i, oi[t], -1, Oi);
		}
		if (t === ur || t === pr) {
			const n = i[0], r = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (r && 1 === r(e.pid, n)) return void this.completeChannel(e, t, i, oi[t], -1, Oi);
		}
		if (kr.has(t) || vr.has(t)) {
			const n = i[0], r = this.kernelInstance.exports.kernel_get_socket_timeout_ms;
			if (r && !this.socketTimeoutTimers.has(e)) {
				const s = kr.has(t) ? 1 : 0, o = Number(r(e.pid, n, s));
				if (o > 0) {
					const n = setTimeout(() => {
						this.socketTimeoutTimers.get(e) === n && (this.socketTimeoutTimers.delete(e), this.removePendingPipeReader(e), this.isRegisteredChannel(e) && this.completeChannel(e, t, i, oi[t], -1, 110));
					}, o);
					this.socketTimeoutTimers.set(e, n);
				}
			}
		}
		if (kr.has(t)) {
			const n = i[0], r = this.kernelInstance.exports.kernel_get_fd_pipe_idx;
			if (r) {
				const i = r(e.pid, n);
				if (i >= 0) {
					let n = this.pendingPipeReaders.get(i);
					if (n || (n = [], this.pendingPipeReaders.set(i, n)), n.some((t) => t.channel === e) || n.push({
						channel: e,
						pid: e.pid
					}), br) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (vr.has(t)) {
			const n = i[0], r = this.kernelInstance.exports.kernel_get_fd_send_pipe_idx;
			if (r) {
				const i = r(e.pid, n);
				if (i >= 0) {
					let n = this.pendingPipeWriters.get(i);
					if (n || (n = [], this.pendingPipeWriters.set(i, n)), n.some((t) => t.channel === e) || n.push({
						channel: e,
						pid: e.pid
					}), br) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (t === Qn || t === er) {
			const n = i[0], r = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
			if (r) {
				const i = r(e.pid, n);
				if (i >= 0) {
					const n = setTimeout(() => {
						const t = this.pendingPollRetries.get(e);
						t && t.timer === n && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && this.retrySyscall(e));
					}, 10);
					if (this.pendingPollRetries.set(e, {
						timer: n,
						channel: e,
						pipeIndices: [],
						acceptIndices: [i]
					}), br) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (br) {
			const e = this.profileData.get(t);
			e && e.retries++;
		}
		const n = setTimeout(() => {
			const t = this.pendingPollRetries.get(e);
			t && t.timer === n && (this.pendingPollRetries.delete(e), this.isAsyncChannelProcessActive(e) && this.retrySyscall(e));
		}, 10);
		this.pendingPollRetries.set(e, {
			timer: n,
			channel: e,
			pipeIndices: [],
			isWriteRetry: vr.has(t)
		});
	}
	retrySyscall(e) {
		if (this.isRegisteredChannel(e) && !this.deferChannelWhileStopped(e)) return this.getProcessExitSignal(e.pid) > 0 ? (this.signalWaitDeadlines.delete(`${e.pid}:${e.channelOffset}`), void this.handleProcessTerminated(e)) : void this.handleSyscall(e);
	}
	handleSleepDelay(e, t, i, n, r) {
		let s = 0;
		if (t === ji && n >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), i = e.getUint32(80, !0);
			s = 1e3 * t + Math.floor(i / 1e6);
		} else if (t === Xi && n >= 0) {
			const e = i[0] >>> 0;
			s = Math.max(1, Math.floor(e / 1e3));
		} else if (t === Zi && n >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), i = e.getUint32(80, !0);
			s = 1e3 * t + Math.floor(i / 1e6);
		}
		if (s > 0) {
			const o = setTimeout(() => {
				const s = this.pendingSleeps.get(e);
				s?.timer === o && s.channel === e && (this.pendingSleeps.delete(e), this.isRegisteredChannel(e) && this.completeSleepWithSignalCheck(e, t, i, n, r));
			}, s);
			return this.pendingSleeps.set(e, {
				timer: o,
				channel: e,
				syscallNr: t,
				origArgs: i,
				retVal: n,
				errVal: r
			}), !0;
		}
		return !1;
	}
	completeSleepWithSignalCheck(e, t, i, n, r) {
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || (new DataView(e.memory.buffer, e.channelOffset).getUint32(65560, !0) > 0 ? this.completeChannel(e, t, i, oi[t], -1, 4) : this.completeChannel(e, t, i, oi[t], n, r));
	}
	handleFcntlLock(e, t) {
		const i = t[2], n = new Uint8Array(e.memory.buffer);
		if (!Number.isSafeInteger(i) || i <= 0 || i > n.byteLength - 32) return void this.completeChannel(e, hr, t, void 0, -1, Ni);
		const r = this.getKernelMem(), s = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72;
		r.set(n.subarray(i, i + 32), o), s.setUint32(4, hr, !0), s.setBigInt64(8, BigInt(t[0]), !0), s.setBigInt64(16, BigInt(t[1]), !0), s.setBigInt64(24, BigInt(o), !0);
		for (let f = 3; f < 6; f++) s.setBigInt64(8 + 8 * f, BigInt(t[f]), !0);
		const a = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			a(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const c = Number(s.getBigInt64(56, !0)), h = s.getUint32(64, !0), l = this.dequeueSignalForDelivery(e);
		if (this.finishSignalTermination(e)) return;
		c >= 0 && new Uint8Array(e.memory.buffer).set(r.subarray(o, o + 32), i);
		const d = t[1];
		if (-1 === c && h === Oi && (7 === d || 14 === d || 38 === d)) return l > 0 ? void this.completeChannel(e, hr, t, void 0, -1, 4) : void this.parkAdvisoryLockRetry(e);
		this.completeChannel(e, hr, t, void 0, c, h);
	}
	completeSelectSignalOutcome(e, t, i, n) {
		const r = this.dequeueSignalForDelivery(e);
		return !!this.finishSignalTermination(e) || !!(n && r > 0) && (this.completeChannel(e, t, i, void 0, -1, 4), !0);
	}
	handleSelect(e, t) {
		if (this.deferChannelWhileStopped(e)) return;
		const i = 128, n = t[0], r = t[1], s = t[2], o = t[3], a = t[4];
		let c = -1;
		if (0 !== a) {
			const t = this.getPtrWidth(e.pid), i = new DataView(e.memory.buffer, a);
			let n, r;
			8 === t ? (n = Number(i.getBigInt64(0, !0)), r = Number(i.getBigInt64(8, !0))) : (n = i.getInt32(0, !0), r = i.getInt32(4, !0)), c = 1e3 * n + Math.floor(r / 1e3), c < 0 && (c = 0);
		}
		const h = !0 === e.readinessFinalCheck;
		e.readinessFinalCheck = !1;
		const l = h ? 0 : c, d = this.getReadinessDeadline(e, c);
		if (0 === n && 0 === r && 0 === s && 0 === o) {
			if (this.completeSelectSignalOutcome(e, tn, t, !0)) return;
			if (0 === l) return void this.completeChannel(e, tn, t, void 0, 0, 0);
			const i = c > 0, n = i ? Math.max(d - Date.now(), 1) : -1, r = i ? setTimeout(() => {
				this.pendingSelectRetries.get(e)?.timer === r && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && this.completeChannel(e, tn, t, void 0, 0, 0));
			}, n) : null;
			this.pendingSelectRetries.set(e, {
				timer: r,
				channel: e,
				origArgs: t,
				deadline: d,
				needsSignalSafeWake: !1,
				syscallNr: tn
			});
			return;
		}
		const f = new Uint8Array(e.memory.buffer), u = this.getKernelMem(), p = new DataView(this.kernelMemory.buffer, this.scratchOffset), g = this.scratchOffset + 72;
		0 !== r ? u.set(f.subarray(r, r + i), g) : u.fill(0, g, g + i), 0 !== s ? u.set(f.subarray(s, s + i), g + i) : u.fill(0, g + i, g + 256), 0 !== o ? u.set(f.subarray(o, o + i), g + 256) : u.fill(0, g + 256, g + 384), p.setUint32(4, tn, !0), p.setBigInt64(8, BigInt(n), !0), p.setBigInt64(16, BigInt(0 !== r ? g : 0), !0), p.setBigInt64(24, BigInt(0 !== s ? g + i : 0), !0), p.setBigInt64(32, BigInt(0 !== o ? g + 256 : 0), !0), p.setBigInt64(40, BigInt(l), !0);
		const m = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			m(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const y = Number(p.getBigInt64(56, !0)), w = p.getUint32(64, !0);
		if (y >= 0) {
			const t = new Uint8Array(e.memory.buffer);
			0 !== r && t.set(u.subarray(g, g + i), r), 0 !== s && t.set(u.subarray(g + i, g + 256), s), 0 !== o && t.set(u.subarray(g + 256, g + 384), o);
		}
		if (!this.completeSelectSignalOutcome(e, tn, t, -1 === y && w === Oi)) {
			if (-1 === y && w === Oi) {
				if (0 === c) return void this.completeChannel(e, tn, t, void 0, 0, 0);
				if (d > 0 && Date.now() >= d) return e.readinessFinalCheck = !0, void this.handleSelect(e, t);
				const i = () => {
					const i = this.pendingSelectRetries.get(e);
					i && i.timer === r && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && this.handleSelect(e, t));
				}, n = c > 0 ? Math.max(d - Date.now(), 1) : 50, r = setTimeout(i, Math.min(n, 50));
				this.pendingSelectRetries.set(e, {
					timer: r,
					channel: e,
					origArgs: t,
					deadline: d,
					needsSignalSafeWake: !1,
					syscallNr: tn
				});
				return;
			}
			this.completeChannel(e, tn, t, void 0, y, w);
		}
	}
	handlePselect6(e, t) {
		if (this.deferChannelWhileStopped(e)) return;
		const i = 128, n = new Uint8Array(e.memory.buffer), r = this.getKernelMem(), s = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72, a = t[0], c = t[1], h = t[2], l = t[3], d = t[4], f = t[5];
		0 !== c ? r.set(n.subarray(c, c + i), o) : r.fill(0, o, o + i), 0 !== h ? r.set(n.subarray(h, h + i), o + i) : r.fill(0, o + i, o + 256), 0 !== l ? r.set(n.subarray(l, l + i), o + 256) : r.fill(0, o + 256, o + 384);
		let u = -1;
		if (0 !== d) {
			const t = new DataView(e.memory.buffer, d), i = Number(t.getBigInt64(0, !0)), n = Number(t.getBigInt64(8, !0));
			u = 1e3 * i + Math.floor(n / 1e6);
		}
		const p = !0 === e.readinessFinalCheck;
		e.readinessFinalCheck = !1;
		const g = p ? 0 : u, m = this.getReadinessDeadline(e, u), y = o + 384;
		let w = 0;
		if (0 !== f) {
			const t = this.getPtrWidth(e.pid), i = new DataView(e.memory.buffer, f), s = 8 === t ? Number(i.getBigUint64(0, !0)) : i.getUint32(0, !0);
			0 !== s && (r.set(n.subarray(s, s + 8), y), w = y);
		}
		s.setUint32(4, en, !0), s.setBigInt64(8, BigInt(a), !0), s.setBigInt64(16, BigInt(0 !== c ? o : 0), !0), s.setBigInt64(24, BigInt(0 !== h ? o + i : 0), !0), s.setBigInt64(32, BigInt(0 !== l ? o + 256 : 0), !0), s.setBigInt64(40, BigInt(g), !0), s.setBigInt64(48, BigInt(w), !0);
		const b = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			b(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const k = Number(s.getBigInt64(56, !0)), v = s.getUint32(64, !0);
		if (k >= 0) {
			const t = new Uint8Array(e.memory.buffer);
			0 !== c && t.set(r.subarray(o, o + i), c), 0 !== h && t.set(r.subarray(o + i, o + 256), h), 0 !== l && t.set(r.subarray(o + 256, o + 384), l);
		}
		if (!this.completeSelectSignalOutcome(e, en, t, -1 === k && v === Oi)) {
			if (-1 === k && v === Oi) {
				if (0 === u) return void this.completeChannel(e, en, t, void 0, 0, 0);
				if (m > 0 && Date.now() >= m) return e.readinessFinalCheck = !0, void this.handlePselect6(e, t);
				const i = 0 !== w;
				if (0 === a) {
					if (u > 0) {
						const n = Math.max(m - Date.now(), 1), r = setTimeout(() => {
							this.pendingSelectRetries.get(e)?.timer === r && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && (e.readinessFinalCheck = !0, this.handlePselect6(e, t)));
						}, n);
						this.pendingSelectRetries.set(e, {
							timer: r,
							channel: e,
							origArgs: t,
							deadline: m,
							needsSignalSafeWake: i,
							syscallNr: en
						});
					} else this.pendingSelectRetries.set(e, {
						timer: null,
						channel: e,
						origArgs: t,
						deadline: -1,
						needsSignalSafeWake: i,
						syscallNr: en
					});
					return;
				}
				const n = () => {
					const i = this.pendingSelectRetries.get(e);
					i && i.timer === s && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && this.handlePselect6(e, t));
				}, r = m > 0 ? Math.max(m - Date.now(), 1) : 50, s = setTimeout(n, Math.min(r, 50));
				this.pendingSelectRetries.set(e, {
					timer: s,
					channel: e,
					origArgs: t,
					deadline: m,
					needsSignalSafeWake: i,
					syscallNr: en
				});
				return;
			}
			this.completeChannel(e, en, t, void 0, k, v);
		}
	}
	handleEpollCreate(e, t, i) {
		const n = new DataView(this.kernelMemory.buffer, this.scratchOffset), r = i[0], s = t === sn ? 0 : r;
		n.setUint32(4, t, !0), n.setBigInt64(8, BigInt(s), !0);
		for (let h = 1; h < 6; h++) n.setBigInt64(8 + 8 * h, 0n, !0);
		const o = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			o(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const a = Number(n.getBigInt64(56, !0)), c = n.getUint32(64, !0);
		if (a >= 0) {
			const t = `${e.pid}:${a}`;
			this.epollInterests.set(t, []);
		}
		this.completeChannel(e, t, i, void 0, a, c);
	}
	handleEpollCtl(e, t) {
		const i = t[0], n = t[1], r = t[2], s = t[3];
		let o = 0, a = 0n;
		if (0 !== s) {
			const t = new DataView(e.memory.buffer, s);
			o = t.getUint32(0, !0), a = t.getBigUint64(4, !0);
		}
		const c = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.getKernelMem(), l = this.scratchOffset + 72;
		if (0 !== s) {
			const t = new Uint8Array(e.memory.buffer);
			h.set(t.subarray(s, s + 12), l);
		}
		c.setUint32(4, on, !0), c.setBigInt64(8, BigInt(i), !0), c.setBigInt64(16, BigInt(n), !0), c.setBigInt64(24, BigInt(r), !0), c.setBigInt64(32, BigInt(0 !== s ? l : 0), !0), c.setBigInt64(40, BigInt(0), !0), c.setBigInt64(48, BigInt(0), !0);
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
			const t = 1, s = 2, c = 3, h = `${e.pid}:${i}`;
			let l = this.epollInterests.get(h);
			if (l || (l = [], this.epollInterests.set(h, l)), n === t) l.push({
				fd: r,
				events: o,
				data: a
			});
			else if (n === s) {
				const e = l.findIndex((e) => e.fd === r);
				e >= 0 && l.splice(e, 1);
			} else if (n === c) {
				const e = l.find((e) => e.fd === r);
				e && (e.events = o, e.data = a);
			}
		}
		this.completeChannel(e, on, t, void 0, f, u);
	}
	completeEpollSignalOutcome(e) {
		const t = this.dequeueSignalForDelivery(e);
		return !!this.finishSignalTermination(e) || t > 0 && (this.completeChannelRaw(e, -4, 4), this.relistenChannel(e), !0);
	}
	handleEpollPwait(e, t, i) {
		if (this.deferChannelWhileStopped(e)) return;
		const n = i[0], r = i[1], s = i[2], o = i[3], a = this.getReadinessDeadline(e, o);
		if (s <= 0) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const c = `${e.pid}:${n}`, h = this.epollInterests.get(c);
		if (!h) return this.completeChannelRaw(e, -9, 9), void this.relistenChannel(e);
		if (0 === h.length) {
			if (this.completeEpollSignalOutcome(e)) return;
			if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
			if (a > 0 && Date.now() >= a) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
			const n = () => {
				const n = this.pendingPollRetries.get(e);
				n && n.timer === s && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && this.handleEpollPwait(e, t, i));
			}, r = a > 0 ? Math.min(Math.max(a - Date.now(), 1), 10) : 10, s = setTimeout(n, r);
			this.pendingPollRetries.set(e, {
				timer: s,
				channel: e,
				pipeIndices: [],
				deadline: a
			});
			return;
		}
		const l = h.length;
		if (8 * l > 65536) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		this.getKernelMem();
		const d = new DataView(this.kernelMemory.buffer, this.scratchOffset), f = this.scratchOffset + 72;
		for (let v = 0; v < l; v++) {
			const e = h[v], t = f + 8 * v;
			let i = 0;
			1 & e.events && (i |= 1), 4 & e.events && (i |= 4), new DataView(this.kernelMemory.buffer).setInt32(t, e.fd, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 4, i, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 6, 0, !0);
		}
		d.setUint32(4, Yi, !0), d.setBigInt64(8, BigInt(f), !0), d.setBigInt64(16, BigInt(l), !0), d.setBigInt64(24, BigInt(0), !0);
		for (let v = 3; v < 6; v++) d.setBigInt64(8 + 8 * v, 0n, !0);
		const u = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			u(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const p = Number(d.getBigInt64(56, !0)), g = d.getUint32(64, !0);
		if (this.completeEpollSignalOutcome(e)) return;
		if (p < 0 && g !== Oi) return this.completeChannelRaw(e, p, g), void this.relistenChannel(e);
		let m = 0;
		if (p > 0) {
			const t = new DataView(e.memory.buffer);
			for (let e = 0; e < l && m < s; e++) {
				const i = f + 8 * e, n = new DataView(this.kernelMemory.buffer).getInt16(i + 6, !0);
				if (0 !== n) {
					let i = 0;
					1 & n && (i |= 1), 4 & n && (i |= 4), 8 & n && (i |= 8), 16 & n && (i |= 16);
					const s = r + 12 * m;
					t.setUint32(s, i, !0), t.setBigUint64(s + 4, h[e].data, !0), m++;
				}
			}
		}
		if (m > 0) return this.completeChannelRaw(e, m, 0), void this.relistenChannel(e);
		if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
		if (a > 0 && Date.now() >= a) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
		const { pipeIndices: y, acceptIndices: w } = this.resolveEpollReadinessIndices(e.pid), b = a > 0 ? Math.min(Math.max(a - Date.now(), 1), 10) : 10, k = setTimeout(() => {
			const n = this.pendingPollRetries.get(e);
			n && n.timer === k && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && this.handleEpollPwait(e, t, i));
		}, b);
		this.pendingPollRetries.set(e, {
			timer: k,
			channel: e,
			pipeIndices: y,
			acceptIndices: w,
			deadline: a
		});
	}
	finishNetworkIoctl(e, t = 0, i = 0) {
		this.completeChannelRaw(e, t, i), this.relistenChannel(e);
	}
	guestRangeIsValid(e, t, i) {
		return Number.isSafeInteger(t) && Number.isSafeInteger(i) && t >= 0 && i >= 0 && t <= e.memory.buffer.byteLength - i;
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
		const i = new Uint8Array(e.memory.buffer, t, zn);
		let n = 0;
		for (; n < i.length && 0 !== i[n];) n++;
		return new TextDecoder().decode(new Uint8Array(i.subarray(0, n)));
	}
	writeIfreqName(e, t, i) {
		const n = new TextEncoder().encode(i);
		e.fill(0, t, t + zn), e.set(n.subarray(0, 15), t);
	}
	handleIoctlIfconf(e, t) {
		const i = this.getPtrWidth(e.pid), n = t[2], r = 8 === i ? 16 : 8;
		if (!this.guestRangeIsValid(e, n, r)) return void this.finishNetworkIoctl(e, -14, Ni);
		const s = new DataView(e.memory.buffer), o = new Uint8Array(e.memory.buffer), a = this.ifreqSize(e), c = s.getInt32(n, !0);
		if (c < 0) return void this.finishNetworkIoctl(e, -22, Wi);
		let h;
		if (h = 8 === i ? Number(s.getBigUint64(n + 8, !0)) : s.getUint32(n + 4, !0), 0 === h) return s.setInt32(n, xn.length * a, !0), void this.finishNetworkIoctl(e);
		if (c < a) return s.setInt32(n, 0, !0), void this.finishNetworkIoctl(e);
		const l = Math.floor(c / a), d = Math.min(l, xn.length), f = d * a;
		if (this.guestRangeIsValid(e, h, f)) {
			for (let e = 0; e < d; e++) {
				const t = xn[e], i = h + e * a;
				this.writeIfreqName(o, i, t.name), o.fill(0, i + zn, i + a), s.setUint16(i + zn, 2, !0);
				const n = this.interfaceAddress(t);
				n && o.set(n, i + zn + 4);
			}
			s.setInt32(n, f, !0), this.finishNetworkIoctl(e);
		} else this.finishNetworkIoctl(e, -14, Ni);
	}
	handleIoctlIfname(e, t) {
		const i = t[2];
		if (!this.guestRangeIsValid(e, i, this.ifreqSize(e))) return void this.finishNetworkIoctl(e, -14, Ni);
		const n = new DataView(e.memory.buffer), r = new Uint8Array(e.memory.buffer), s = n.getInt32(i + 16, !0), o = xn.find((e) => e.index === s);
		o ? (this.writeIfreqName(r, i, o.name), this.finishNetworkIoctl(e)) : this.finishNetworkIoctl(e, -19, 19);
	}
	handleIoctlIfhwaddr(e, t) {
		const i = t[2], n = this.readIfreqName(e, i);
		if (null === n) return void this.finishNetworkIoctl(e, -14, Ni);
		const r = xn.find((e) => e.name === n);
		if (!r) return void this.finishNetworkIoctl(e, -19, 19);
		const s = new DataView(e.memory.buffer), o = new Uint8Array(e.memory.buffer);
		o.fill(0, i + zn, i + this.ifreqSize(e)), s.setUint16(i + zn, r.loopback ? 772 : 1, !0), r.loopback || o.set(this.virtualMacAddress, i + zn + 2), this.finishNetworkIoctl(e);
	}
	handleIoctlIfaddr(e, t) {
		const i = t[2], n = this.readIfreqName(e, i);
		if (null === n) return void this.finishNetworkIoctl(e, -14, Ni);
		const r = xn.find((e) => e.name === n);
		if (!r) return void this.finishNetworkIoctl(e, -19, 19);
		const s = this.interfaceAddress(r);
		if (!s) return void this.finishNetworkIoctl(e, -99, 99);
		const o = new DataView(e.memory.buffer), a = new Uint8Array(e.memory.buffer);
		a.fill(0, i + zn, i + this.ifreqSize(e)), o.setUint16(i + zn, 2, !0), a.set(s, i + zn + 4), this.finishNetworkIoctl(e);
	}
	handleIoctlIfindex(e, t) {
		const i = t[2], n = this.readIfreqName(e, i);
		if (null === n) return void this.finishNetworkIoctl(e, -14, Ni);
		const r = xn.find((e) => e.name === n);
		r ? (new DataView(e.memory.buffer).setInt32(i + zn, r.index, !0), this.finishNetworkIoctl(e)) : this.finishNetworkIoctl(e, -19, 19);
	}
	prepareWriteOperationBudget(e, t, i, n, r) {
		const s = this.kernelInstance.exports.kernel_prepare_write_operation;
		if (!s) throw new Error("kernel ABI is missing kernel_prepare_write_operation for chunked writes");
		let o;
		const a = this.guestTidForChannel(e);
		this.currentHandlePid = e.pid;
		try {
			o = Number(s(e.pid, a, t, BigInt(i), n, r ? 1 : 0));
		} catch (as) {
			return console.error(`[prepareWriteOperationBudget] kernel threw for pid=${e.pid}:`, as), this.completeChannelRaw(e, -1, 5), this.relistenChannel(e), null;
		} finally {
			this.currentHandlePid = 0;
		}
		return this.finishSignalTermination(e) ? null : !Number.isSafeInteger(o) || o > n ? (console.error(`[prepareWriteOperationBudget] invalid kernel budget ${o} for request ${n}`), this.completeChannelRaw(e, -1, 5), this.relistenChannel(e), null) : o < 0 ? (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || (this.completeChannelRaw(e, -1, -o), this.relistenChannel(e)), null) : o;
	}
	handleWritev(e, t, i) {
		const n = i[0], r = i[1], s = i[2], o = new Uint8Array(e.memory.buffer), a = new DataView(e.memory.buffer), c = this.getKernelMem(), h = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.scratchOffset + 72, d = this.getPtrWidth(e.pid), f = 8 === d ? 16 : 8;
		if (s <= 0 || s > 1024) return this.completeChannelRaw(e, -1, Wi), void this.relistenChannel(e);
		const u = [];
		let p = 0;
		for (let m = 0; m < s; m++) {
			let e, t;
			8 === d ? (e = Number(a.getBigUint64(r + m * f, !0)), t = Number(a.getBigUint64(r + m * f + 8, !0))) : (e = a.getUint32(r + m * f, !0), t = a.getUint32(r + m * f + 4, !0)), u.push({
				base: e,
				len: t
			}), p += t;
		}
		if (!Number.isSafeInteger(p) || p > 2147483647) return this.completeChannelRaw(e, -1, Wi), void this.relistenChannel(e);
		const g = 8 * s;
		if (p <= te - g) {
			let r = g;
			for (let e = 0; e < s; e++) {
				const t = l + r;
				u[e].len > 0 && c.set(o.subarray(u[e].base, u[e].base + u[e].len), t);
				const i = l + 8 * e;
				new DataView(c.buffer).setUint32(i, t, !0), new DataView(c.buffer).setUint32(i + 4, u[e].len, !0), r += u[e].len, r = r + 3 & -4;
			}
			h.setUint32(4, t, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(s), !0), t === cr && (h.setBigInt64(32, BigInt(i[3]), !0), h.setBigInt64(40, BigInt(i[4]), !0));
			const a = this.kernelInstance.exports.kernel_handle_channel;
			this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				a(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
			const d = Number(h.getBigInt64(56, !0)), f = h.getUint32(64, !0);
			if (-1 === d && f === Oi) return void this.handleBlockingRetry(e, t, i);
			this.handleSharedMappingsAfterFileSyscall(e, t, i, d, f), this.completeChannel(e, t, i, void 0, d, f);
		} else {
			const r = this.kernelInstance.exports.kernel_handle_channel, s = t === cr;
			let a = s ? (i[3] >>> 0) + 4294967296 * (0 | i[4]) : 0;
			const d = this.prepareWriteOperationBudget(e, n, a, p, s);
			if (null === d) return;
			let f = 0, g = !1, m = null;
			const y = 65528;
			for (const t of u) {
				if (f >= d) break;
				if (0 === t.len) continue;
				let i = 0;
				for (; i < t.len && f < d;) {
					const u = Math.min(t.len - i, y, d - f), p = l + 8;
					c.set(o.subarray(t.base + i, t.base + i + u), p), new DataView(c.buffer).setUint32(l, p, !0), new DataView(c.buffer).setUint32(l + 4, u, !0), s ? (h.setUint32(4, cr, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(1), !0), h.setBigInt64(32, BigInt(4294967295 & a), !0), h.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (h.setUint32(4, sr, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(1), !0)), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
					try {
						r(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					if (this.finishSignalTermination(e)) return;
					const w = Number(h.getBigInt64(56, !0)), b = h.getUint32(64, !0);
					if (-1 === w) {
						b === Oi && 0 === f ? g = !0 : 0 === f && (m = {
							retVal: w,
							errVal: b
						});
						break;
					}
					if (i += w, f += w, s && (a += w), w < u) break;
				}
				if (g || i < t.len) break;
			}
			if (g) {
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				this.handleBlockingRetry(e, t, i);
				return;
			}
			if (m) {
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				this.completeChannelRaw(e, m.retVal, m.errVal), this.relistenChannel(e);
				return;
			}
			if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
			this.handleSharedMappingsAfterFileSyscall(e, t, i, f, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, f, 0), this.relistenChannel(e);
		}
	}
	handleLargeWrite(e, t, i) {
		const n = i[0], r = i[1], s = i[2];
		if (!Number.isSafeInteger(s) || s < 0 || s > 2147483647) return this.completeChannelRaw(e, -1, Wi), void this.relistenChannel(e);
		const o = t === Un;
		let a = o ? i[3] : 0;
		const c = this.prepareWriteOperationBudget(e, n, a, s, o);
		if (null === c) return;
		const h = new Uint8Array(e.memory.buffer), l = this.getKernelMem(), d = new DataView(this.kernelMemory.buffer, this.scratchOffset), f = this.scratchOffset + 72, u = this.kernelInstance.exports.kernel_handle_channel;
		let p = 0;
		for (; p < c;) {
			const s = Math.min(c - p, te);
			l.set(h.subarray(r + p, r + p + s), f), d.setUint32(4, t, !0), d.setBigInt64(8, BigInt(n), !0), d.setBigInt64(16, BigInt(f), !0), d.setBigInt64(24, BigInt(s), !0), o && d.setBigInt64(32, BigInt(a), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				u(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (as) {
				console.error(`[handleLargeWrite] kernel threw for pid=${e.pid}:`, as), p > 0 ? (this.handleSharedMappingsAfterFileSyscall(e, t, i, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0)) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.finishSignalTermination(e)) return;
			const g = Number(d.getBigInt64(56, !0)), m = d.getUint32(64, !0);
			if (-1 === g && m === Oi) {
				if (p > 0) {
					if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
					this.handleSharedMappingsAfterFileSyscall(e, t, i, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0), this.relistenChannel(e);
					return;
				}
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				this.handleBlockingRetry(e, t, i);
				return;
			}
			if (0 !== m || g <= 0) {
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				p > 0 ? (this.handleSharedMappingsAfterFileSyscall(e, t, i, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0)) : this.completeChannelRaw(e, g, m), this.relistenChannel(e);
				return;
			}
			if (p += g, o && (a += g), g < s) break;
		}
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || (this.handleSharedMappingsAfterFileSyscall(e, t, i, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0), this.relistenChannel(e));
	}
	handleLargeRead(e, t, i) {
		const n = i[0], r = i[1], s = i[2], o = t === Rn;
		let a = o ? i[3] : 0;
		const c = new Uint8Array(e.memory.buffer), h = this.getKernelMem(), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72, f = this.kernelInstance.exports.kernel_handle_channel;
		let u = 0;
		for (; u < s;) {
			const p = Math.min(s - u, te);
			h.fill(0, d, d + p), l.setUint32(4, t, !0), l.setBigInt64(8, BigInt(n), !0), l.setBigInt64(16, BigInt(d), !0), l.setBigInt64(24, BigInt(p), !0), o && l.setBigInt64(32, BigInt(a), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				f(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (as) {
				console.error(`[handleLargeRead] kernel threw for pid=${e.pid}:`, as), u > 0 ? (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0)) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.finishSignalTermination(e)) return;
			const g = Number(l.getBigInt64(56, !0)), m = l.getUint32(64, !0);
			if (-1 === g && m === Oi) return u > 0 ? (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0), void this.relistenChannel(e)) : void this.handleBlockingRetry(e, t, i);
			if (0 !== m || g <= 0) return u > 0 ? (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0)) : this.completeChannelRaw(e, g, m), void this.relistenChannel(e);
			if (c.set(h.subarray(d, d + g), r + u), u += g, o && (a += g), g < p) break;
		}
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0), this.relistenChannel(e));
	}
	handleReadv(e, t, i) {
		const n = i[0], r = i[1], s = i[2], o = new Uint8Array(e.memory.buffer), a = new DataView(e.memory.buffer), c = this.getKernelMem(), h = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.scratchOffset + 72, d = this.getPtrWidth(e.pid), f = 8 === d ? 16 : 8, u = [];
		let p = 0;
		for (let g = 0; g < s; g++) {
			let e, t;
			8 === d ? (e = Number(a.getBigUint64(r + g * f, !0)), t = Number(a.getBigUint64(r + g * f + 8, !0))) : (e = a.getUint32(r + g * f, !0), t = a.getUint32(r + g * f + 4, !0)), u.push({
				base: e,
				len: t
			}), p += t;
		}
		if (p <= 65528 && s <= Math.floor(8192)) {
			let r = 8 * s;
			const a = [];
			for (let e = 0; e < s; e++) {
				const t = l + r;
				a.push({
					base: u[e].base,
					kernelBase: t,
					len: u[e].len
				}), u[e].len > 0 && c.fill(0, t, t + u[e].len);
				const i = l + 8 * e;
				new DataView(c.buffer).setUint32(i, t, !0), new DataView(c.buffer).setUint32(i + 4, u[e].len, !0), r += u[e].len, r = r + 3 & -4;
			}
			h.setUint32(4, t, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(s), !0), t === ar && (h.setBigInt64(32, BigInt(i[3]), !0), h.setBigInt64(40, BigInt(i[4]), !0));
			const d = this.kernelInstance.exports.kernel_handle_channel;
			this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				d(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.finishSignalTermination(e)) return;
			const f = Number(h.getBigInt64(56, !0)), p = h.getUint32(64, !0);
			if (-1 === f && p === Oi) return void this.handleBlockingRetry(e, t, i);
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
			const r = this.kernelInstance.exports.kernel_handle_channel, s = t === ar;
			let a = s ? (0 | i[3]) + 4294967296 * (0 | i[4]) : 0, d = 0, f = 0, p = !1;
			for (const t of u) {
				if (0 === t.len) continue;
				let i = 0;
				for (; i < t.len;) {
					const u = Math.min(t.len - i, 65528), g = l + 8;
					new DataView(c.buffer).setUint32(l, g, !0), new DataView(c.buffer).setUint32(l + 4, u, !0), c.fill(0, g, g + u), s ? (h.setUint32(4, ar, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(1), !0), h.setBigInt64(32, BigInt(4294967295 & a), !0), h.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (h.setUint32(4, or, !0), h.setBigInt64(8, BigInt(n), !0), h.setBigInt64(16, BigInt(l), !0), h.setBigInt64(24, BigInt(1), !0)), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
					try {
						r(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					if (this.finishSignalTermination(e)) return;
					const m = Number(h.getBigInt64(56, !0)), y = h.getUint32(64, !0);
					if (-1 === m) {
						if (y === Oi && 0 === d) {
							p = !0;
							break;
						}
						f = y;
						break;
					}
					if (0 === m) break;
					if (o.set(c.subarray(g, g + m), t.base + i), i += m, d += m, s && (a += m), m < u) break;
				}
				if (p || f) break;
			}
			if (p) return void this.handleBlockingRetry(e, t, i);
			const g = d > 0 ? d : f ? -1 : 0, m = d > 0 ? 0 : f;
			this.completeChannel(e, t, i, void 0, g, m);
		}
	}
	handleSendmsg(e, t) {
		const i = t[0], n = t[1], r = t[2], s = new Uint8Array(e.memory.buffer), o = new DataView(e.memory.buffer), a = this.getKernelMem(), c = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.scratchOffset + 72, l = this.getPtrWidth(e.pid);
		let d, f, u, p, g, m;
		8 === l ? (d = Number(o.getBigUint64(n, !0)), f = o.getUint32(n + 8, !0), u = Number(o.getBigUint64(n + 16, !0)), p = o.getUint32(n + 24, !0), g = Number(o.getBigUint64(n + 32, !0)), m = o.getUint32(n + 40, !0)) : (d = o.getUint32(n, !0), f = o.getUint32(n + 4, !0), u = o.getUint32(n + 8, !0), p = o.getUint32(n + 12, !0), g = o.getUint32(n + 16, !0), m = o.getUint32(n + 20, !0));
		const y = h, w = new DataView(a.buffer);
		w.setUint32(y, d, !0), w.setUint32(y + 4, f, !0), w.setUint32(y + 8, u, !0), w.setUint32(y + 12, p, !0), w.setUint32(y + 16, g, !0), w.setUint32(y + 20, m, !0), w.setUint32(y + 24, 0, !0);
		let b = 28;
		if (0 !== d && f > 0 && b + f <= 65536) {
			const e = h + b;
			a.set(s.subarray(d, d + f), e), w.setUint32(y, e, !0), b += f, b = b + 3 & -4;
		}
		if (0 !== g && m > 0 && b + m <= 65536) {
			const e = h + b;
			a.set(s.subarray(g, g + m), e), w.setUint32(y + 16, e, !0), b += m, b = b + 3 & -4;
		}
		const k = 8 === l ? 16 : 8;
		if (p > 0 && 0 !== u) {
			const e = h + b;
			b += 8 * p, b = b + 3 & -4, w.setUint32(y + 8, e, !0);
			for (let t = 0; t < p; t++) {
				let i, n;
				if (8 === l ? (i = Number(o.getBigUint64(u + t * k, !0)), n = Number(o.getBigUint64(u + t * k + 8, !0))) : (i = o.getUint32(u + 8 * t, !0), n = o.getUint32(u + 8 * t + 4, !0)), w.setUint32(e + 8 * t, 0, !0), w.setUint32(e + 8 * t + 4, n, !0), n > 0 && b + n <= 65536) {
					const r = h + b;
					a.set(s.subarray(i, i + n), r), w.setUint32(e + 8 * t, r, !0), b += n, b = b + 3 & -4;
				}
			}
		}
		c.setUint32(4, Jn, !0), c.setBigInt64(8, BigInt(i), !0), c.setBigInt64(16, BigInt(y), !0), c.setBigInt64(24, BigInt(r), !0);
		const v = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			v(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const S = Number(c.getBigInt64(56, !0)), P = c.getUint32(64, !0);
		-1 !== S || P !== Oi ? this.completeChannel(e, Jn, t, void 0, S, P) : this.handleBlockingRetry(e, Jn, t);
	}
	handleRecvmsg(e, t) {
		const i = t[0], n = t[1], r = t[2], s = new Uint8Array(e.memory.buffer), o = new DataView(e.memory.buffer), a = this.getKernelMem(), c = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.scratchOffset + 72, l = this.getPtrWidth(e.pid);
		let d, f, u, p, g, m;
		8 === l ? (d = Number(o.getBigUint64(n, !0)), f = o.getUint32(n + 8, !0), u = Number(o.getBigUint64(n + 16, !0)), p = o.getUint32(n + 24, !0), g = Number(o.getBigUint64(n + 32, !0)), m = o.getUint32(n + 40, !0)) : (d = o.getUint32(n, !0), f = o.getUint32(n + 4, !0), u = o.getUint32(n + 8, !0), p = o.getUint32(n + 12, !0), g = o.getUint32(n + 16, !0), m = o.getUint32(n + 20, !0));
		const y = h, w = new DataView(a.buffer);
		w.setUint32(y, d, !0), w.setUint32(y + 4, f, !0), w.setUint32(y + 8, u, !0), w.setUint32(y + 12, p, !0), w.setUint32(y + 16, g, !0), w.setUint32(y + 20, m, !0), w.setUint32(y + 24, 0, !0);
		let b = 28, k = 0;
		0 !== d && f > 0 && b + f <= 65536 && (k = h + b, a.fill(0, k, k + f), w.setUint32(y, k, !0), b += f, b = b + 3 & -4);
		let v = 0;
		0 !== g && m > 0 && b + m <= 65536 && (v = h + b, a.fill(0, v, v + m), w.setUint32(y + 16, v, !0), b += m, b = b + 3 & -4);
		const S = [], P = 8 === l ? 16 : 8;
		if (p > 0 && 0 !== u) {
			const e = h + b;
			b += 8 * p, b = b + 3 & -4, w.setUint32(y + 8, e, !0);
			for (let t = 0; t < p; t++) {
				let i, n;
				if (8 === l ? (i = Number(o.getBigUint64(u + t * P, !0)), n = Number(o.getBigUint64(u + t * P + 8, !0))) : (i = o.getUint32(u + 8 * t, !0), n = o.getUint32(u + 8 * t + 4, !0)), n > 0 && b + n <= 65536) {
					const r = h + b;
					a.fill(0, r, r + n), w.setUint32(e + 8 * t, r, !0), w.setUint32(e + 8 * t + 4, n, !0), S.push({
						base: i,
						len: n,
						kernelBase: r
					}), b += n, b = b + 3 & -4;
				} else w.setUint32(e + 8 * t, 0, !0), w.setUint32(e + 8 * t + 4, n, !0);
			}
		}
		c.setUint32(4, Yn, !0), c.setBigInt64(8, BigInt(i), !0), c.setBigInt64(16, BigInt(y), !0), c.setBigInt64(24, BigInt(r), !0);
		const I = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			I(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const z = Number(c.getBigInt64(56, !0)), x = c.getUint32(64, !0);
		if (-1 === z && x === Oi) return void this.handleBlockingRetry(e, Yn, t);
		if (z > 0) {
			let e = z;
			for (const t of S) {
				if (e <= 0) break;
				const i = Math.min(t.len, e);
				s.set(a.subarray(t.kernelBase, t.kernelBase + i), t.base), e -= i;
			}
		}
		if (0 !== k && 0 !== d && f > 0 && s.set(a.subarray(k, k + f), d), 0 !== v && 0 !== g) {
			const e = w.getUint32(y + 20, !0);
			e > 0 && e <= m && s.set(a.subarray(v, v + e), g);
		}
		const E = w.getUint32(y + 4, !0), M = w.getUint32(y + 20, !0), A = w.getUint32(y + 24, !0);
		8 === l ? (o.setUint32(n + 8, E, !0), o.setUint32(n + 40, M, !0), o.setUint32(n + 44, A, !0)) : (o.setUint32(n + 4, E, !0), o.setUint32(n + 20, M, !0), o.setUint32(n + 24, A, !0)), this.completeChannel(e, Yn, t, void 0, z, x);
	}
	handleFork(e, t) {
		if (!this.callbacks.onFork) return void this.completeChannel(e, pn, t, void 0, -1, 38);
		const i = e.pid, n = this.guestTidForChannel(e);
		if (this.syncAnonymousSharedMappingsFromProcess(e, { force: !0 }), this.syncFileSharedMappingsFromProcess(e, { force: !0 }), !this.syncSysvShmMappingsFromProcess(e, { force: !0 })) return void this.completeChannel(e, pn, t, void 0, -1, 5);
		const r = `${i}:${e.channelOffset}`, s = this.threadForkContexts.get(r), o = e.channelOffset - 131072, a = Ui(e.memory, e.channelOffset - 61440, this.processes.get(i)?.ptrWidth ?? 4), c = s ? {
			kind: "thread",
			fnPtr: s.fnPtr,
			argPtr: s.argPtr,
			forkBufAddr: a,
			slotStart: o,
			slotLen: 262144
		} : {
			kind: "main",
			forkBufAddr: a
		}, h = (0, this.kernelInstance.exports.kernel_fork_process)(i, n);
		if (h <= 0) {
			const i = h < 0 ? -h >>> 0 : 5;
			this.completeChannel(e, pn, t, void 0, -1, i);
			return;
		}
		const l = h >>> 0, d = this.kernelInstance.exports.kernel_clear_fork_child;
		if (d && d(l), "thread" === c.kind) try {
			this.reserveHostRegionAt(l, c.slotStart, c.slotLen);
		} catch (as) {
			try {
				this.removeFromKernelProcessTable(l);
			} catch (p) {
				this.terminateForKernelProtocolFailure(e, `could not roll back fork child ${l}: ${p instanceof Error ? p.message : String(p)}`);
				return;
			}
			const n = as instanceof Error ? as.message : String(as);
			console.error(`[kernel-worker] fork child slot reservation failed: ${n}`), this.completeChannel(e, pn, t, void 0, -1, 12);
			return;
		}
		const f = (i) => {
			void 0 !== i && console.error(`[kernel-worker] fork worker launch failed: ${String(i)}`);
			try {
				this.rollbackChildHostRegistration(l);
			} catch (n) {
				console.error(`[kernel-worker] fork child ${l} host rollback failed:`, n);
			}
			try {
				this.removeFromKernelProcessTable(l);
			} catch (p) {
				this.terminateForKernelProtocolFailure(e, `could not roll back fork child ${l}: ${p instanceof Error ? p.message : String(p)}`);
				return;
			}
			if (this.isAsyncChannelProcessActive(e)) {
				const n = i instanceof Fi ? 11 : 12;
				this.completeChannel(e, pn, t, void 0, -1, n);
			}
		};
		let u;
		try {
			this.inheritHostFdMirrors(i, l), u = Promise.resolve(this.callbacks.onFork({
				parentPid: i,
				childPid: l,
				parentMemory: e.memory,
				continuation: c
			}));
		} catch (as) {
			f(as);
			return;
		}
		u.then((i) => {
			this.finalizePendingChildTermination(l), this.isAsyncChannelProcessActive(e) && this.completeChannel(e, pn, t, void 0, l, 0);
		}).catch(f);
	}
	handleSpawn(e, t) {
		const i = e.pid, n = this.guestTidForChannel(e), r = t[0], s = t[1], o = t[2], a = t[3], c = t[4];
		if (!this.callbacks.onSpawn || !this.callbacks.onResolveSpawn) return void this.completeChannel(e, mn, t, void 0, -1, 38);
		const h = new Uint8Array(e.memory.buffer);
		if (!Number.isSafeInteger(s) || s < 0 || !Number.isSafeInteger(a) || a <= 0) return void this.completeChannel(e, mn, t, void 0, -1, Wi);
		if (s >= qi) return void this.completeChannel(e, mn, t, void 0, -1, 36);
		if (s > 0 && !Hi(h, r, s)) return void this.completeChannel(e, mn, t, void 0, -1, Ni);
		if (a > 8417320) return void this.completeChannel(e, mn, t, void 0, -1, 7);
		if (!Hi(h, o, a)) return void this.completeChannel(e, mn, t, void 0, -1, Ni);
		if (0 !== c && !Hi(h, c, 4)) return void this.completeChannel(e, mn, t, void 0, -1, Ni);
		let l = "";
		s > 0 && (l = new TextDecoder().decode(h.slice(r, r + s)), l.endsWith("\0") && (l = l.slice(0, -1)));
		const d = l;
		l && !l.startsWith("/") && (l = this.resolveExecPathAgainstCwd(i, l));
		const f = h.slice(o, o + a);
		let u, p;
		try {
			const e = function(e) {
				if (e.byteLength < 40) throw new Error("blob too short for header");
				const t = new DataView(e.buffer, e.byteOffset, e.byteLength), i = t.getUint32(0, !0), n = t.getUint32(4, !0), r = t.getUint32(8, !0);
				if (i > 4096 || n > 4096 || r > 1024) throw new Error("blob count exceeds limit");
				const s = 40 + 4 * i, o = s + 4 * n + 28 * r;
				if (o > e.byteLength) throw new Error("blob truncated before strings region");
				const a = e.byteLength - o, c = new TextDecoder(), h = (t) => {
					if (t > a) throw new Error("string offset OOB");
					let i = t;
					for (; i < a && 0 !== e[o + i];) i++;
					return c.decode(e.slice(o + t, o + i));
				}, l = [];
				for (let f = 0; f < i; f++) l.push(h(t.getUint32(40 + 4 * f, !0)));
				const d = [];
				for (let f = 0; f < n; f++) d.push(h(t.getUint32(s + 4 * f, !0)));
				return {
					argv: l,
					envp: d
				};
			}(f);
			u = e.argv, p = e.envp;
		} catch (m) {
			this.completeChannel(e, mn, t, void 0, -1, 22);
			return;
		}
		const g = this.validateExecMetadata(u, p, this.getPtrWidth(i));
		if (g < 0) return void this.completeChannel(e, mn, t, void 0, -1, -g);
		(async () => {
			const e = await this.callbacks.onResolveSpawn(l, u);
			return e || d === l || !d || d.startsWith("/") ? e : this.callbacks.onResolveSpawn(d, u);
		})().then((r) => {
			var s;
			this.isAsyncChannelProcessActive(e) && (r ? "errno" in (s = r) && "number" == typeof s.errno ? this.completeChannel(e, mn, t, void 0, -1, r.errno >>> 0) : this.handleSpawnAfterResolve(e, t, i, n, c, f, a, r, p) : this.completeChannel(e, mn, t, void 0, -1, 2));
		}).catch((n) => {
			this.isAsyncChannelProcessActive(e) && (console.error(`[kernel] spawn resolve error for parent ${i}:`, n), this.completeChannel(e, mn, t, void 0, -1, 5));
		});
	}
	scratchOffsetForSpawnBlob(e) {
		if (e <= Sr) return this.scratchOffset;
		if (0 !== (this.largeSpawnScratchOffset ?? 0)) return this.largeSpawnScratchOffset;
		const t = this.kernelInstance.exports.kernel_alloc_scratch;
		return this.largeSpawnScratchOffset = Number(t(8417320)), this.largeSpawnScratchOffset;
	}
	handleSpawnAfterResolve(e, t, i, n, r, s, o, a, c) {
		if (o !== s.byteLength || o <= 0 || o > 8417320) {
			const i = o > 8417320 ? 7 : Wi;
			this.completeChannel(e, mn, t, void 0, -1, i);
			return;
		}
		const h = this.scratchOffsetForSpawnBlob(o);
		if (o > Sr && 0 === h) return void this.completeChannel(e, mn, t, void 0, -1, 12);
		const l = new Uint8Array(this.kernelMemory.buffer);
		if (!Number.isSafeInteger(h) || h < 0 || h > l.byteLength - o) return void this.completeChannel(e, mn, t, void 0, -1, 5);
		l.set(s, h);
		const d = (0, this.kernelInstance.exports.kernel_spawn_process)(i, n, this.toKernelPtr(h), this.toKernelPtr(o));
		if (d <= 0) {
			const i = d < 0 ? -d >>> 0 : 5;
			this.completeChannel(e, mn, t, void 0, -1, i);
			return;
		}
		const f = d >>> 0, u = (n, r) => {
			void 0 !== r && console.error(`[kernel] spawn error for parent ${i}:`, r);
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
			this.isAsyncChannelProcessActive(e) && this.completeChannel(e, mn, t, void 0, -1, n);
		};
		let p;
		try {
			this.inheritHostFdMirrors(i, f, !1), p = Promise.resolve(this.callbacks.onSpawn(i, f, a, c));
		} catch (as) {
			u(5, as);
			return;
		}
		p.then((i) => {
			i < 0 ? u(-i >>> 0) : (this.finalizePendingChildTermination(f), this.isAsyncChannelProcessActive(e) && (0 !== r && new DataView(e.memory.buffer).setInt32(r, f, !0), this.completeChannel(e, mn, t, void 0, 0, 0)));
		}).catch((e) => {
			u(5, e);
		});
	}
	readCStringFromProcess(e, t, i = 4096) {
		if (0 === t) return "";
		let n = 0;
		for (; t + n < e.length && 0 !== e[t + n] && n < i;) n++;
		return new TextDecoder().decode(e.slice(t, t + n));
	}
	readExecPathFromProcess(e, t) {
		if (!Number.isSafeInteger(t) || t <= 0 || t >= e.byteLength) return { errno: Ni };
		const i = e.byteLength - t, n = Math.min(i, qi);
		let r = 0;
		for (; r < n && 0 !== e[t + r];) r++;
		return r === n ? { errno: i >= qi ? 36 : Ni } : { value: new TextDecoder().decode(e.slice(t, t + r)) };
	}
	readStringArrayFromProcess(e, t, i = 4) {
		if (0 === t) return { values: [] };
		const n = [], r = new DataView(e.buffer, e.byteOffset, e.byteLength);
		let s = i;
		for (let o = 0; s <= Gi; o++) {
			const a = t + o * i;
			if (!Number.isSafeInteger(a) || a < 0 || a + i > r.byteLength) return { errno: Ni };
			let c;
			if (8 === i) {
				const e = r.getBigUint64(a, !0);
				if (e > BigInt(Number.MAX_SAFE_INTEGER)) return { errno: Ni };
				c = Number(e);
			} else c = r.getUint32(a, !0);
			if (0 === c) return { values: n };
			if (c < 0 || c >= e.byteLength) return { errno: Ni };
			const h = Math.min(e.byteLength - c, 65537);
			let l = 0;
			for (; l < h && 0 !== e[c + l];) l++;
			if (l === h) return { errno: h > 65536 ? 7 : Ni };
			if (l > 65536) return { errno: 7 };
			if (s += i + l + 1, !Number.isSafeInteger(s) || s > Gi) return { errno: 7 };
			n.push(new TextDecoder().decode(e.slice(c, c + l)));
		}
		return { errno: 7 };
	}
	finishFailedExec(e, t, i, n) {
		this.isAsyncChannelProcessActive(e) && this.completeChannel(e, t, i, void 0, -1, n);
	}
	handleExec(e, t) {
		const i = new Uint8Array(e.memory.buffer), n = this.getPtrWidth(e.pid), r = this.readExecPathFromProcess(i, t[0]);
		if ("errno" in r) return void this.completeChannel(e, fn, t, void 0, -1, r.errno);
		let s = r.value;
		const o = this.readStringArrayFromProcess(i, t[1], n), a = this.readStringArrayFromProcess(i, t[2], n);
		if ("errno" in o) return void this.completeChannel(e, fn, t, void 0, -1, o.errno);
		if ("errno" in a) return void this.completeChannel(e, fn, t, void 0, -1, a.errno);
		const c = o.values, h = a.values;
		if (s && !s.startsWith("/") && (s = this.resolveExecPathAgainstCwd(e.pid, s)), !this.callbacks.onExec) return void this.completeChannel(e, fn, t, void 0, -1, 38);
		const l = this.guestTidForChannel(e);
		this.callbacks.onExec(e.pid, s, c, h, l).then((i) => {
			i < 0 && this.finishFailedExec(e, fn, t, -i >>> 0);
		}).catch((i) => {
			console.error(`[kernel] exec error for pid ${e.pid}:`, i), this.finishFailedExec(e, fn, t, 5);
		});
	}
	resolveExecPathAgainstCwd(e, t) {
		const i = this.kernelInstance.exports.kernel_get_cwd;
		if (!i) return t;
		const n = i(e, this.toKernelPtr(this.scratchOffset), 4096);
		if (n <= 0) return t;
		const r = new Uint8Array(this.kernelMemory.buffer), s = new TextDecoder().decode(r.slice(this.scratchOffset, this.scratchOffset + n)), o = (s.endsWith("/") ? s + t : s + "/" + t).split("/"), a = [];
		for (const c of o) "." !== c && "" !== c && (".." === c && a.length > 0 ? a.pop() : a.push(c));
		return "/" + a.join("/");
	}
	handleExecveat(e, t) {
		const i = t[0], n = t[4], r = new Uint8Array(e.memory.buffer), s = this.getPtrWidth(e.pid), o = this.readExecPathFromProcess(r, t[1]);
		if ("errno" in o) return void this.completeChannel(e, un, t, void 0, -1, o.errno);
		const a = o.value, c = this.readStringArrayFromProcess(r, t[2], s), h = this.readStringArrayFromProcess(r, t[3], s);
		if ("errno" in c) return void this.completeChannel(e, un, t, void 0, -1, c.errno);
		if ("errno" in h) return void this.completeChannel(e, un, t, void 0, -1, h.errno);
		const l = c.values, d = h.values;
		let f;
		if (4096 & n && "" === a) {
			const n = this.kernelInstance.exports.kernel_get_fd_path;
			if (!n) return void this.completeChannel(e, un, t, void 0, -1, 38);
			const r = n(e.pid, i, this.toKernelPtr(this.scratchOffset), 4096);
			if (r <= 0) {
				const i = r < 0 ? -r >>> 0 : 2;
				this.completeChannel(e, un, t, void 0, -1, i);
				return;
			}
			const s = new Uint8Array(this.kernelMemory.buffer);
			f = new TextDecoder().decode(s.slice(this.scratchOffset, this.scratchOffset + r));
		} else if (a.startsWith("/")) f = a;
		else {
			const t = this.kernelInstance.exports.kernel_get_cwd;
			if (t) {
				const i = t(e.pid, this.scratchOffset, 4096);
				if (i > 0) {
					const e = new Uint8Array(this.kernelMemory.buffer), t = new TextDecoder().decode(e.slice(this.scratchOffset, this.scratchOffset + i));
					f = t.endsWith("/") ? t + a : t + "/" + a;
				} else f = a;
			} else f = a;
		}
		if (!this.callbacks.onExec) return void this.completeChannel(e, un, t, void 0, -1, 38);
		const u = this.guestTidForChannel(e);
		this.callbacks.onExec(e.pid, f, l, d, u).then((i) => {
			i < 0 && this.finishFailedExec(e, un, t, -i >>> 0);
		}).catch((i) => {
			console.error(`[kernel] execveat error for pid ${e.pid}:`, i), this.finishFailedExec(e, un, t, 5);
		});
	}
	handleClone(e, t) {
		if (!this.callbacks.onClone) return void this.completeChannel(e, yn, t, void 0, -1, 38);
		const i = 1048576, n = t[0] >>> 0, r = t[2], s = t[4], o = new Uint8Array(e.memory.buffer), a = (e) => !(3 & e) && Hi(o, e, 4);
		if (0 !== (n & i) && !a(r)) return void this.completeChannel(e, yn, t, void 0, -1, Ni);
		const c = 2097152 & n ? s : 0;
		if (0 !== c && !a(c)) return void this.completeChannel(e, yn, t, void 0, -1, Ni);
		const h = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		h.setUint32(4, yn, !0);
		for (let v = 0; v < 6; v++) h.setBigInt64(8 + 8 * v, BigInt(t[v]), !0);
		const l = this.kernelInstance.exports.kernel_handle_channel;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			l(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const d = Number(h.getBigInt64(56, !0)), f = h.getUint32(64, !0);
		if (d <= 0) {
			const i = d < 0 ? f : 5;
			this.completeChannel(e, yn, t, void 0, -1, i);
			return;
		}
		const u = d;
		let p, g, m = !1;
		const y = () => {
			let t;
			p && Mr.delete(p);
			const i = g?.attachedChannelOffset;
			if (void 0 !== i) {
				if (this.processes.get(e.pid)?.memory === e.memory) try {
					this.removeChannel(e.pid, i);
				} catch (n) {
					t = n;
				}
				g.attachedChannelOffset = void 0;
			}
			this.threadCtidPtrs.delete(`${e.pid}:${u}`), m && (new DataView(e.memory.buffer).setInt32(r, 0, !0), m = !1);
			try {
				this.rollbackKernelThread(e.pid, u);
			} catch (n) {
				throw n;
			}
			if (void 0 !== t) throw t;
		};
		let w;
		try {
			0 !== (n & i) && (new DataView(e.memory.buffer).setInt32(r, u, !0), m = !0);
			const s = new DataView(e.memory.buffer, e.channelOffset), o = s.getUint32(72, !0), a = s.getUint32(76, !0), h = t[1], l = t[3];
			0 !== c && this.threadCtidPtrs.set(`${e.pid}:${u}`, c);
			const d = function(e, t, i, n, r, s, o, a, c) {
				const h = Object.freeze({
					[Er]: !0,
					pid: t,
					tid: i,
					fnPtr: n,
					argPtr: r,
					stackPtr: s,
					tlsPtr: o,
					ctidPtr: a,
					memory: c
				}), l = {
					owner: e,
					pid: t,
					tid: i,
					fnPtr: n,
					argPtr: r,
					memory: c
				};
				return Mr.set(h, l), {
					attachment: h,
					pending: l
				};
			}(this, e.pid, u, o, a, h, l, c, e.memory);
			p = d.attachment, g = d.pending, w = Promise.resolve(this.callbacks.onClone(p));
		} catch (b) {
			try {
				y();
			} catch (k) {
				throw k;
			}
			throw b;
		}
		w.then(() => {
			if (p && Mr.delete(p), this.isAsyncChannelProcessActive(e)) {
				if (void 0 === g?.attachedChannelOffset) {
					try {
						y();
					} catch (k) {
						this.terminateForKernelProtocolFailure(e, `clone callback did not attach tid ${u}, and rollback failed: ${k instanceof Error ? k.message : String(k)}`);
						return;
					}
					console.error(`[kernel-worker] onClone returned without attaching kernel tid ${u}`), this.completeChannel(e, yn, t, void 0, -1, 12);
					return;
				}
				this.completeChannel(e, yn, t, void 0, u, 0);
			}
		}).catch((i) => {
			try {
				y();
			} catch (k) {
				this.isAsyncChannelProcessActive(e) && this.terminateForKernelProtocolFailure(e, `could not roll back allocated tid ${u}: ${k instanceof Error ? k.message : String(k)}`);
				return;
			}
			this.isAsyncChannelProcessActive(e) && (console.error(`[kernel-worker] onClone failed: ${i}`), this.completeChannel(e, yn, t, void 0, -1, 12));
		});
	}
	handleExit(e, t, i) {
		const n = i[0], r = this.isMainProcessChannel(e);
		if (t === wn && !r) {
			const t = this.guestTidForChannel(e);
			this.finalizeThreadExit(e.pid, t, e.channelOffset), this.completeChannelRaw(e, 0, 0), this.callbacks.onThreadExit?.(e.pid, t, e.channelOffset);
			return;
		}
		if (this.releaseAllSharedMemoryForProcess(e.pid), this.getProcessExitSignal(e.pid) > 0) return void (this.hostReaped.has(e.pid) || this.handleProcessTerminated(e));
		{
			const i = new DataView(this.kernelMemory.buffer, this.scratchOffset);
			i.setUint32(4, t, !0), i.setBigInt64(8, BigInt(n), !0);
			const r = this.kernelInstance.exports.kernel_handle_channel;
			this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				r(this.toKernelPtr(this.scratchOffset), e.pid);
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
		if (this.discardStoppedChannelStateForProcess(a), this.hostReaped.has(a)) return this.completeProcessExitHandshake(e, t), this.scheduleWakeBlockedRetries(), void (this.callbacks.onExit && this.callbacks.onExit(a, n));
		this.hostReaped.add(a), this.notifyParentOfExitedProcess(a), this.completeProcessExitHandshake(e, t), this.scheduleWakeBlockedRetries(), this.callbacks.onExit && this.callbacks.onExit(a, n);
	}
	handleProcessTerminated(e) {
		const t = e.pid;
		if (this.discardStoppedChannelStateForProcess(t), this.hostReaped.has(t)) return;
		const i = this.getProcessExitSignal(t);
		this.hostReaped.add(t), this.releaseAllSharedMemoryForProcess(t), this.drainAndProcessWakeupEvents(), this.notifyParentOfExitedProcess(t), this.callbacks.onExit && this.callbacks.onExit(t, i > 0 ? 128 + i : -1);
	}
	finalizeExitedProcessBeforeLifecycleNotification(e) {
		const t = this.kernelInstance.exports.kernel_get_process_state;
		if (!t || 2 !== t(e)) return !1;
		if (this.discardStoppedChannelStateForProcess(e), this.hostReaped.has(e)) return !0;
		this.cancelPendingSleepsForProcess(e);
		const i = this.processes.get(e)?.channels[0];
		return i ? this.handleProcessTerminated(i) : this.finalizeExecHandoffTermination(e), !0;
	}
	notifyHostProcessCrashed(e, t = 11) {
		if (this.hostReaped.has(e)) return;
		const i = this.kernelInstance.exports.kernel_mark_process_signaled;
		if (!i) throw new Error("Kernel missing required kernel_mark_process_signaled export");
		const n = i(e, t);
		if (0 !== n) throw new Error(`Kernel rejected signal-death transition for process ${e}: ${n < 0 ? "errno " + -n : `invalid result ${n}`}`);
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
		const i = t[0], n = t[1], r = t[2] >>> 0, s = t[3], o = e.pid;
		if (this.pendingCancels.delete(e)) return this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
		if (-12 & r) return void this.completeWaitpid(e, t, -1, Wi);
		if (!this.isOptionalGuestOutputRangeValid(e, n, 4) || !this.isOptionalGuestOutputRangeValid(e, s, 144)) return void this.completeWaitpid(e, t, -1, Ni);
		const a = this.wait4EventMask(r), c = this.pollWaitableChild(e, i, a, 0);
		if ("error" === c.kind) return void this.completeWaitpid(e, t, -1, c.errno);
		if ("event" === c.kind) return this.writeWait4Result(e, n, s, c), void this.completeWaitpid(e, t, c.childPid, 0);
		if (1 & r) return void this.completeWaitpid(e, t, 0, 0);
		const h = {
			parentPid: o,
			channel: e,
			origArgs: t,
			pid: i,
			options: r,
			syscallNr: Sn
		};
		this.interruptWaiterWithPendingSignal(h) || this.waitingForChild.push(h);
	}
	wait4EventMask(e) {
		let t = 1;
		return 2 & e && (t |= 2), 8 & e && (t |= 4), t;
	}
	waitidEventMask(e) {
		let t = 0;
		return 4 & e && (t |= 1), 2 & e && (t |= 2), 8 & e && (t |= 4), t;
	}
	pollWaitableChild(e, t, i, n) {
		const r = (0, this.kernelInstance.exports.kernel_wait_child_poll)(e.pid, this.guestTidForChannel(e), t, i, n, this.toKernelPtr(this.scratchOffset));
		if (r > 0) {
			const e = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, 160), t = new Uint8Array(160);
			t.set(e);
			const i = new DataView(t.buffer), n = t.subarray(16, 160);
			return {
				kind: "event",
				childPid: r,
				waitStatus: i.getInt32(0, !0),
				siCode: i.getInt32(4, !0),
				siStatus: i.getInt32(8, !0),
				childUid: i.getUint32(12, !0),
				rusage: n
			};
		}
		return 0 === r ? { kind: "running" } : {
			kind: "error",
			errno: -r >>> 0
		};
	}
	isOptionalGuestOutputRangeValid(e, t, i) {
		return 0 === t || Hi(new Uint8Array(e.memory.buffer), t, i);
	}
	isRequiredGuestOutputRangeValid(e, t, i) {
		return Hi(new Uint8Array(e.memory.buffer), t, i);
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
		if (i && 1 === i(t)) return this.consumeExitedChild(t, e), void this.wakeWaitingParent(t);
		this.sendSignalToProcess(t, 17);
	}
	writeWait4Result(e, t, i, n) {
		const r = new Uint8Array(e.memory.buffer);
		0 !== t && new DataView(e.memory.buffer).setInt32(t, n.waitStatus, !0), 0 !== i && r.set(n.rusage, i);
	}
	completeWaitpid(e, t, i, n) {
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || this.completeChannel(e, Sn, t, void 0, i, n);
	}
	completeWaitid(e, t, i, n) {
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || this.completeChannel(e, Pn, t, void 0, i, n);
	}
	interruptWaiterWithPendingSignal(e) {
		const t = this.dequeueSignalForDelivery(e.channel);
		return !!this.finishSignalTermination(e.channel) || !(t <= 0) && (this.completeChannel(e.channel, e.syscallNr, e.origArgs, void 0, -1, 4), !0);
	}
	interruptWaitingChildForSignal(e, t) {
		this.wakeWaitingParent(e);
		const i = (0, this.kernelInstance.exports.kernel_pick_signal_target_tid)(e, t);
		if (i <= 0) return !1;
		const n = this.waitingForChild.findIndex((t) => t.parentPid === e && this.isRegisteredChannel(t.channel) && this.guestTidForChannel(t.channel) === i);
		if (n < 0) return !1;
		const [r] = this.waitingForChild.splice(n, 1);
		return !!this.interruptWaiterWithPendingSignal(r) || (this.waitingForChild.splice(n, 0, r), !1);
	}
	interruptWaitingChildForDirectedSignal(e, t) {
		this.wakeWaitingParent(e);
		if ((0, this.kernelInstance.exports.kernel_thread_has_deliverable)(e, t) <= 0) return !1;
		const i = this.waitingForChild.findIndex((i) => i.parentPid === e && this.isRegisteredChannel(i.channel) && this.guestTidForChannel(i.channel) === t);
		if (i < 0) return !1;
		const [n] = this.waitingForChild.splice(i, 1);
		return !!this.interruptWaiterWithPendingSignal(n) || (this.waitingForChild.splice(i, 0, n), !1);
	}
	interruptWaitingChildrenForGeneratedSignal(e) {
		if (e <= 0) return;
		const t = this.waitingForChild ?? [], i = new Set(t.map((e) => e.parentPid));
		for (const n of i) this.interruptWaitingChildForSignal(n, e);
	}
	wakeWaitingParent(e) {
		this.waitingForChild ??= [];
		const t = [];
		for (let i = 0; i < this.waitingForChild.length;) {
			const n = this.waitingForChild[i];
			if (n.parentPid !== e) {
				i++;
				continue;
			}
			if (!this.isRegisteredChannel(n.channel)) {
				this.waitingForChild.splice(i, 1);
				continue;
			}
			const r = n.syscallNr === Pn ? this.waitidEventMask(n.options) : this.wait4EventMask(n.options), s = n.syscallNr === Pn ? n.options & se : 0, o = this.pollWaitableChild(n.channel, n.pid, r, s);
			"running" !== o.kind ? (this.waitingForChild.splice(i, 1), t.push({
				waiter: n,
				poll: o
			})) : i++;
		}
		for (const { waiter: i, poll: n } of t) "error" !== n.kind ? i.syscallNr === Pn ? (this.writeWaitidResult(i.channel, i.origArgs[2], i.origArgs[4], n), this.completeWaitid(i.channel, i.origArgs, 0, 0)) : (this.writeWait4Result(i.channel, i.origArgs[1], i.origArgs[3], n), this.completeWaitpid(i.channel, i.origArgs, n.childPid, 0)) : i.syscallNr === Pn ? this.completeWaitid(i.channel, i.origArgs, -1, n.errno) : this.completeWaitpid(i.channel, i.origArgs, -1, n.errno);
	}
	recheckDeferredWaitpids() {
		const e = /* @__PURE__ */ new Set();
		for (let t = this.waitingForChild.length - 1; t >= 0; t--) {
			const i = this.waitingForChild[t];
			if (i.pid > 0 || -1 === i.pid) continue;
			const n = i.syscallNr === Pn ? this.waitidEventMask(i.options) : this.wait4EventMask(i.options), r = se, s = this.pollWaitableChild(i.channel, i.pid, n, r);
			"error" === s.kind ? (this.waitingForChild.splice(t, 1), i.syscallNr === Pn ? this.completeWaitid(i.channel, i.origArgs, -1, s.errno) : this.completeWaitpid(i.channel, i.origArgs, -1, s.errno)) : "event" === s.kind && e.add(i.parentPid);
		}
		for (const t of e) this.wakeWaitingParent(t);
	}
	handleWaitid(e, t) {
		const i = t[0], n = t[1], r = t[2], s = t[3] >>> 0, o = t[4], a = e.pid, c = this.waitidToWaitPid(i, n);
		if (this.pendingCancels.delete(e)) return this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
		const h = this.waitidEventMask(s);
		if (void 0 === c || -16777232 & s || 0 === h) return void this.completeWaitid(e, t, -1, Wi);
		if (!this.isRequiredGuestOutputRangeValid(e, r, 128) || !this.isOptionalGuestOutputRangeValid(e, o, 144)) return void this.completeWaitid(e, t, -1, Ni);
		const l = this.pollWaitableChild(e, c, h, s & se);
		if ("error" === l.kind) return void this.completeWaitid(e, t, -1, l.errno);
		if ("event" === l.kind) return this.writeWaitidResult(e, r, o, l), void this.completeWaitid(e, t, 0, 0);
		if (1 & s) return new Uint8Array(e.memory.buffer, r, 128).fill(0), void this.completeWaitid(e, t, 0, 0);
		const d = {
			parentPid: a,
			channel: e,
			origArgs: t,
			pid: c,
			options: s,
			syscallNr: Pn
		};
		this.interruptWaiterWithPendingSignal(d) || this.waitingForChild.push(d);
	}
	waitidToWaitPid(e, t) {
		if (Number.isSafeInteger(t)) return 1 === e ? t > 0 && t <= 2147483647 ? t : void 0 : 2 === e ? t >= 0 && t <= 2147483647 ? 0 === t ? 0 : -t : void 0 : 0 === e ? -1 : void 0;
	}
	writeWaitidResult(e, t, i, n) {
		const r = new Uint8Array(e.memory.buffer), s = new DataView(e.memory.buffer);
		r.fill(0, t, t + 128), s.setInt32(t + 0, 17, !0), s.setInt32(t + 8, n.siCode, !0);
		const o = 8 === this.getPtrWidth(e.pid) ? 16 : 12;
		s.setInt32(t + o, n.childPid, !0), s.setUint32(t + o + 4, n.childUid, !0), s.setInt32(t + o + 8, n.siStatus, !0), 0 !== i && r.set(n.rusage, i);
	}
	handleFutex(e, t) {
		const i = t[0], n = t[1], r = t[2], s = -385 & n, o = new Int32Array(e.memory.buffer), a = i >>> 2;
		if (0 === s || 9 === s) {
			if (this.pendingCancels.has(e)) return this.pendingCancels.delete(e), this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
			if (Atomics.load(o, a) !== r) return this.completeChannelRaw(e, -11, Oi), void this.relistenChannel(e);
			let i;
			const n = t[3];
			if (0 !== n) {
				const t = new DataView(e.memory.buffer), r = Number(t.getBigInt64(n, !0)), s = Number(t.getBigInt64(n + 8, !0));
				if (r < 0 || 0 === r && s <= 0) return this.completeChannelRaw(e, -110, 110), void this.relistenChannel(e);
				i = 1e3 * r + Math.ceil(s / 1e6), i <= 0 && (i = 1), i > 2147483647 && (i = 2147483647);
			}
			const s = Atomics.waitAsync(o, a, r);
			if (s.async) {
				let t, n = !1;
				const r = () => !n && (n = !0, void 0 !== t && clearTimeout(t), this.pendingFutexWaits.delete(e), !0), c = (t, i) => {
					r() && this.isRegisteredChannel(e) && (this.completeChannelRaw(e, t, i), e.consecutiveSyscalls = 0, this.relistenChannel(e));
				}, h = () => {
					Atomics.notify(o, a);
				}, l = (e, t) => {
					h(), c(e, t);
				}, d = () => {
					h(), r();
				};
				this.pendingFutexWaits.set(e, {
					futexIndex: a,
					interrupt: l,
					retire: d
				}), s.value.then(() => {
					c(0, 0);
				}), void 0 !== i && (t = setTimeout(() => {
					l(-110, 110);
				}, i));
			} else this.completeChannelRaw(e, 0, 0), this.relistenChannel(e);
			return;
		}
		if (1 === s || 10 === s) {
			const t = Atomics.notify(o, a, r);
			this.completeChannelRaw(e, t, 0), this.relistenChannel(e);
			return;
		}
		if (3 === s || 4 === s) {
			const i = t[3], n = Atomics.notify(o, a, r + i);
			this.completeChannelRaw(e, n, 0), this.relistenChannel(e);
			return;
		}
		if (5 === s) {
			const i = t[3], n = t[4] >>> 2;
			let s = Atomics.notify(o, a, r);
			s += Atomics.notify(o, n, i), this.completeChannelRaw(e, s, 0), this.relistenChannel(e);
			return;
		}
		this.completeChannelRaw(e, -38, 38), this.relistenChannel(e);
	}
	notifyThreadExit(e, t) {
		if (!this.kernelInstance) throw new Error("Kernel is not initialized for thread cleanup");
		const i = this.kernelInstance.exports.kernel_thread_exit;
		if (!i) throw new Error("Kernel missing required kernel_thread_exit export");
		const n = i(e, t);
		if (0 !== n) {
			const i = n < 0 ? -n : 5;
			throw new Vi(e, t, i, `Kernel could not remove tid ${t} from process ${e}: errno ${i}`);
		}
	}
	rollbackKernelThread(e, t) {
		try {
			this.notifyThreadExit(e, t);
		} catch (i) {
			if (i instanceof Vi && 3 === i.errno) return;
			throw i;
		}
	}
	finalizeThreadExit(e, t, i) {
		const n = `${e}:${t}`, r = this.threadCtidPtrs.get(n), s = this.activeChannels.find((t) => t.pid === e && t.channelOffset === i)?.memory ?? this.processes.get(e)?.memory;
		this.notifyThreadExit(e, t);
		try {
			if (r && 0 !== r) {
				if (!s) throw new Vi(e, t, Ni, `Missing process memory for clear-TID of tid ${t} in process ${e}`);
				const i = new Uint8Array(s.buffer);
				if (3 & r || !Hi(i, r, 4)) throw new Vi(e, t, Ni, `Invalid clear-TID pointer ${r} for tid ${t} in process ${e}`);
				new DataView(s.buffer).setInt32(r, 0, !0);
				const n = new Int32Array(s.buffer);
				Atomics.notify(n, r >>> 2, 1);
			}
		} finally {
			this.threadCtidPtrs.delete(n), this.removeChannel(e, i);
		}
	}
	firePosixTimer(e, t, i) {
		const n = (0, this.kernelInstance.exports.kernel_posix_timer_fire)(e, t);
		n < 0 || (n > 0 ? this.wakePendingSignalWaits(e, i, n) : (this.wakePendingSignalWaits(e, i), this.sendSignalToProcess(e, i, !1)));
	}
	wakePendingSignalWaits(e, t, i) {
		const n = Array.from(this.pendingSignalWaits.entries()).filter(([, n]) => {
			if (n.channel.pid !== e) return !1;
			if (void 0 !== i && this.guestTidForChannel(n.channel) !== i) return !1;
			const r = n.origArgs[0] >>> 0;
			return !(0 === r || t <= 0 || t > 64) && 0n != (new DataView(n.channel.memory.buffer).getBigUint64(r, !0) & 1n << BigInt(t - 1));
		});
		for (const [r, s] of n) this.pendingSignalWaits.get(r) === s && (clearTimeout(s.timer), this.pendingSignalWaits.delete(r), this.isRegisteredChannel(s.channel) && this.retrySyscall(s.channel));
	}
	cleanupPendingSignalWaits(e) {
		for (const [t, i] of this.pendingSignalWaits ?? []) i.channel.pid === e && (clearTimeout(i.timer), this.pendingSignalWaits.delete(t), this.signalWaitDeadlines?.delete(t));
		for (const [t, i] of this.signalWaitDeadlines ?? []) i.pid === e && this.signalWaitDeadlines.delete(t);
	}
	sendSignalToProcess(e, t, i = !0) {
		if (!this.kernelInstance || !this.kernelMemory) return;
		if (i) {
			const i = new DataView(this.kernelMemory.buffer, this.scratchOffset);
			i.setUint32(4, ln, !0), i.setBigInt64(8, BigInt(e), !0), i.setBigInt64(16, BigInt(t), !0);
			for (let e = 2; e < 6; e++) i.setBigInt64(8 + 8 * e, 0n, !0);
			const n = this.kernelInstance.exports.kernel_handle_channel;
			try {
				this.bindKernelTid(e, e);
			} catch {
				return;
			}
			this.currentHandlePid = e;
			try {
				n(this.toKernelPtr(this.scratchOffset), e);
			} catch (as) {
				console.error(`[sendSignalToProcess] kernel threw for pid=${e} sig=${t}: ${as}`);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
		}
		if (i && this.wakePendingSignalWaits(e, t), this.drainAndProcessWakeupEvents(), this.reapKilledProcessesAfterSyscall(), this.getProcessExitSignal(e) > 0) return;
		if (this.interruptWaitingChildForSignal(e, t)) return;
		const n = (0, this.kernelInstance.exports.kernel_pick_signal_target_tid)(e, t);
		if (n <= 0) return;
		if ((0, this.kernelInstance.exports.kernel_thread_has_deliverable)(e, n) <= 0) return;
		const r = Array.from(this.pendingSleeps.entries()).find(([t]) => t.pid === e && this.guestTidForChannel(t) === n);
		if (r) {
			const [e, t] = r;
			clearTimeout(t.timer), this.pendingSleeps.delete(e), this.completeSleepWithSignalCheck(t.channel, t.syscallNr, t.origArgs, t.retVal, t.errVal);
		}
		const s = Array.from(this.pendingPollRetries.entries()).filter(([, t]) => t.channel.pid === e);
		for (const [h, l] of s) this.pendingPollRetries.get(h) === l && (l.timer && clearTimeout(l.timer), this.pendingPollRetries.delete(h), this.processes.has(e) && this.retrySyscall(l.channel));
		const o = this.pendingAdvisoryLockRetries, a = o ? Array.from(o.entries()).filter(([, t]) => t.channel.pid === e) : [];
		for (const [h, l] of a) o.get(h) === l && (clearTimeout(l.timer), o.delete(h), this.isRegisteredChannel(l.channel) && this.retrySyscall(l.channel));
		const c = Array.from(this.pendingSelectRetries.entries()).filter(([, t]) => t.channel.pid === e);
		for (const [h, l] of c) this.pendingSelectRetries.get(h) === l && (clearTimeout(l.timer), clearImmediate(l.timer), this.pendingSelectRetries.delete(h), this.processes.has(e) && (l.syscallNr === tn ? this.handleSelect(l.channel, l.origArgs) : this.handlePselect6(l.channel, l.origArgs)));
	}
	ensureFixedMmapProcessMemoryCapacity(e, t) {
		const i = t[0] >>> 0, n = i + (t[1] >>> 0);
		if (!Number.isSafeInteger(n) || n < i) return !1;
		if (n <= e.memory.buffer.byteLength) return !0;
		try {
			const t = this.processes.get(e.pid)?.ptrWidth ?? 4;
			return Ri(e.memory, n, t), e.memory.buffer.byteLength < n ? !1 : (this.observeProcessMemoryTarget(e.memory, e.memory.buffer), this.kernel.framebuffers.rebindMemory(e.pid), !0);
		} catch {
			return !1;
		}
	}
	ensureProcessMemoryCovers(e, t, i, n, r) {
		let s = 0, o = 0, a = 0;
		i === _n ? n >= 0 && (s = n) : i === Mn ? n >= 0 && (o = n, a = r[1], s = o + a) : i === Ln && n >= 0 && (o = n, a = r[2], s = o + a);
		const c = t.buffer.byteLength;
		if (s > 0 && s > c) Ri(t, s, this.processes.get(e)?.ptrWidth ?? 4), this.observeProcessMemoryTarget(t, t.buffer), this.kernel.framebuffers.rebindMemory(e);
		if (a > 0) {
			const e = 65536, n = Math.ceil(a / e) * e, s = t.buffer.byteLength;
			let c = o;
			const h = Math.min(o + n, s);
			if (i === Ln) {
				const t = r[0] >>> 0, i = r[1] >>> 0;
				if (o === t && i > 0) {
					const n = Math.ceil((t + i) / e) * e;
					c = Math.max(c, n);
				}
			}
			c < h && new Uint8Array(t.buffer, c, h - c).fill(0);
		}
		if (i === Ln && n >= 0 && n !== r[0] && 0 !== r[0] && r[1] > 0) {
			const e = r[0] >>> 0, i = r[1] >>> 0, s = n >>> 0, o = r[2] >>> 0, a = Math.min(i, o);
			if (a > 0) {
				const i = t.buffer, n = i.byteLength;
				if (e + a <= n && s + a <= n) {
					const t = new Uint8Array(i, e, a);
					new Uint8Array(i, s, a).set(t);
				}
			}
		}
	}
	trackAnonymousSharedMapping(e, t, i) {
		const n = i[1] >>> 0;
		if (0 === n) return;
		const r = new Uint8Array(e.memory.buffer);
		if (t + n > r.length) return;
		const s = `anon:${e.pid}:${t}:${this.nextAnonymousSharedBackingId++}`, o = r.slice(t, t + n);
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
			len: n,
			writable: !!(2 & i[2]),
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
		const i = this.sharedMappings?.get(e.pid);
		if (!i) return;
		const n = new Uint8Array(e.memory.buffer);
		for (const [r, s] of i) {
			if (!s.backingKey || !s.snapshot) continue;
			const e = this.anonymousSharedBackings?.get(s.backingKey);
			if (!e || r + s.len > n.length) continue;
			const i = (s.seenVersion ?? 0) !== e.version;
			if (!t.force && e.refCount <= 1 && !i) continue;
			let o = !1;
			if (s.writable) for (let t = 0; t < s.len; t += 4096) {
				const i = Math.min(4096, s.len - t);
				this.rangeDiffersFromSnapshot(n, r + t, s.snapshot, t, i) && this.mergeChangedByteRuns(n, r + t, s.snapshot, t, e.bytes, s.fileOffset + t, i) && (o = !0);
			}
			if (o && e.version++, o || i) {
				const t = e.bytes.slice(s.fileOffset, s.fileOffset + s.len);
				n.set(t, r), s.snapshot = t;
			}
			s.seenVersion = e.version;
		}
	}
	mapSharedMmapFromFile(e, t, i) {
		if (i[1] >>> 0 == 0) return { kind: "mapped" };
		const n = this.prepareSharedMmapFromFile(e, i);
		return "prepared" !== n.kind ? n : this.registerPreparedSharedMmap(e, t, n.context);
	}
	prepareSharedMmapFromFile(e, t) {
		const i = t[4], n = t[1] >>> 0, r = t[5], s = r * ir;
		if (!Number.isSafeInteger(r) || r < 0 || !Number.isSafeInteger(s)) return {
			kind: "error",
			errno: Wi
		};
		const o = !!(2 & t[2]), a = this.getFdStatForSharedMapping(e, i);
		if ("error" === a.kind) return a;
		const c = a.value;
		if (32768 != (61440 & c.mode)) return { kind: "unsupported" };
		if (null === c.hostHandle) return {
			kind: "error",
			errno: 95
		};
		const h = this.getFdAccessModeForSharedMapping(e, i);
		if ("error" === h.kind) return h;
		const l = h.value;
		if (1 === l) return {
			kind: "error",
			errno: 13
		};
		const d = 2 === l && this.fdSupportsMmapWriteback(e.pid, i);
		if (o && !d) return {
			kind: "error",
			errno: 13
		};
		const f = this.resolveSharedMmapBackingKey(c, c.hostHandle);
		if ("error" === f.kind) return f;
		const u = f.value, p = this.getOrCreateSharedMmapBacking(u, c, d);
		if ("error" === p.kind) return p;
		const g = p.value;
		try {
			this.publishSharedMmapBackingObservers(g), this.ensureSharedMmapBackingRangeLoaded(g, s, n);
		} catch (as) {
			return this.discardUnreferencedSharedMmapBacking(g), {
				kind: "error",
				errno: this.sharedMmapErrno(as)
			};
		}
		return g.refCount++, {
			kind: "prepared",
			context: {
				fd: i,
				fileOffset: s,
				len: n,
				writable: o,
				writeAllowed: d,
				backing: g
			}
		};
	}
	registerPreparedSharedMmap(e, t, i) {
		const { fd: n, fileOffset: r, len: s, writable: o, writeAllowed: a, backing: c } = i;
		try {
			const h = new Uint8Array(e.memory.buffer);
			if (t + s > h.length) return this.releasePreparedSharedMmap(i), {
				kind: "error",
				errno: 5
			};
			const l = this.readSharedMmapBackingRange(c, r, s);
			h.set(l, t);
			let d = this.sharedMappings.get(e.pid);
			return d || (d = /* @__PURE__ */ new Map(), this.sharedMappings.set(e.pid, d)), this.sharedMmapFdCache.set(this.sharedMmapFdCacheKey(e.pid, n), { backingKey: c.key }), d.set(t, {
				fd: n,
				fileOffset: r,
				len: s,
				writable: o,
				writeAllowed: a,
				backingKind: "file",
				backingKey: c.key,
				snapshot: l,
				seenVersion: c.version
			}), { kind: "mapped" };
		} catch (as) {
			return this.releasePreparedSharedMmap(i), {
				kind: "error",
				errno: this.sharedMmapErrno(as)
			};
		}
	}
	resolveSharedMmapBackingKey(e, t) {
		try {
			const i = this.io.fileHandleIdentity?.(t, e.dev, e.ino) ?? null;
			return i ? {
				kind: "ok",
				value: i
			} : {
				kind: "error",
				errno: 95
			};
		} catch (as) {
			return {
				kind: "error",
				errno: this.sharedMmapErrno(as)
			};
		}
	}
	getFdStatForSharedMapping(e, t) {
		const i = this.kernelInstance.exports.kernel_handle_channel, n = this.scratchOffset + 72, r = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		r.setUint32(4, ge, !0), r.setBigInt64(8, BigInt(t), !0), r.setBigInt64(16, BigInt(n), !0);
		for (let g = 2; g < 6; g++) r.setBigInt64(8 + 8 * g, 0n, !0);
		const s = this.currentHandlePid;
		let o = null;
		try {
			this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid, o = this.kernel.withFstatHandleCapture(() => i(this.toKernelPtr(this.scratchOffset), e.pid)).handle;
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
		const a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = Number(a.getBigInt64(56, !0)), h = a.getUint32(64, !0);
		if (0 !== c || 0 !== h) return {
			kind: "error",
			errno: h || (c < -1 ? -c : 5)
		};
		const l = new DataView(this.kernelMemory.buffer, n), d = l.getBigUint64(0, !0), f = l.getBigUint64(8, !0), u = l.getUint32(16, !0), p = l.getBigUint64(32, !0);
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
		const i = this.kernelInstance.exports.kernel_get_fd_path;
		if (!i) return {
			kind: "error",
			errno: 38
		};
		const n = this.scratchOffset + 72;
		let r;
		try {
			r = i(e.pid, t, this.toKernelPtr(n), Math.min(4096, te));
		} catch {
			return {
				kind: "error",
				errno: 5
			};
		}
		return r < 0 ? {
			kind: "error",
			errno: -r
		} : 0 === r ? {
			kind: "error",
			errno: 2
		} : {
			kind: "ok",
			value: new TextDecoder().decode(new Uint8Array(this.kernelMemory.buffer).slice(n, n + r))
		};
	}
	getFdAccessModeForSharedMapping(e, t) {
		const i = this.kernelInstance.exports.kernel_handle_channel, n = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		n.setUint32(4, hr, !0), n.setBigInt64(8, BigInt(t), !0), n.setBigInt64(16, BigInt(3), !0);
		for (let c = 2; c < 6; c++) n.setBigInt64(8 + 8 * c, 0n, !0);
		const r = this.currentHandlePid;
		try {
			this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid, i(this.toKernelPtr(this.scratchOffset), e.pid);
		} catch {
			return {
				kind: "error",
				errno: 5
			};
		} finally {
			this.currentHandlePid = r;
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
	getOrCreateSharedMmapBacking(e, t, i) {
		const n = t.hostHandle;
		if (null === n) return {
			kind: "error",
			errno: 95
		};
		const r = this.sharedMmapBackings.get(e);
		if (r) {
			if (i && !r.writable) {
				if (n === r.handle) return {
					kind: "error",
					errno: 5
				};
				try {
					this.kernel.retainHostFileHandle(n);
				} catch (as) {
					return {
						kind: "error",
						errno: this.sharedMmapErrno(as)
					};
				}
				const e = r.handle;
				r.handle = n, r.writable = !0, r.size = t.size, r.sizeValid = !0, this.kernel.releaseHostFileHandle(e);
			} else {
				const e = this.revalidateSharedMmapBacking(r);
				if (0 !== e) return {
					kind: "error",
					errno: e
				};
			}
			return {
				kind: "ok",
				value: r
			};
		}
		try {
			this.kernel.retainHostFileHandle(n);
		} catch (as) {
			return {
				kind: "error",
				errno: this.sharedMmapErrno(as)
			};
		}
		const s = {
			key: e,
			handle: n,
			writable: i,
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
			const i = this.resolveSharedMmapBackingKey({
				dev: BigInt(t.dev),
				ino: BigInt(t.ino),
				mode: t.mode,
				size: t.size,
				hostHandle: e.handle
			}, e.handle);
			return "error" === i.kind || i.value !== e.key ? (e.sizeValid = !1, "error" === i.kind ? i.errno : 5) : (e.size = t.size, e.sizeValid = !0, 0);
		} catch (as) {
			return e.sizeValid = !1, this.sharedMmapErrno(as);
		}
	}
	sharedMmapErrno(e) {
		const t = bi(e);
		return t < 0 ? -t : t || 5;
	}
	discardUnreferencedSharedMmapBacking(e) {
		0 === e.refCount && this.sharedMmapBackings.get(e.key) === e && (e.dirtyPages.size > 0 || (this.kernel.releaseHostFileHandle(e.handle), this.sharedMmapBackings.delete(e.key), this.invalidateSharedMmapFdCache()));
	}
	ensureSharedMmapBackingRangeLoaded(e, t, i) {
		if (i <= 0) return;
		const n = Math.floor(t / ir), r = Math.floor((t + i - 1) / ir);
		for (let s = n; s <= r; s++) this.ensureSharedMmapBackingPageLoaded(e, s);
	}
	ensureSharedMmapBackingPageLoaded(e, t) {
		const i = e.pages.get(t);
		if (i) return i;
		if (!e.sizeValid) {
			const t = this.revalidateSharedMmapBacking(e);
			if (0 !== t) {
				const e = /* @__PURE__ */ new Error("Cannot determine MAP_SHARED backing size");
				throw e.code = t, e;
			}
		}
		const n = this.readSharedMmapBackingPage(e, t);
		return e.pages.set(t, n), n;
	}
	readSharedMmapBackingPage(e, t) {
		const i = new Uint8Array(ir);
		if (!e.sizeValid) throw new Error("Unknown MAP_SHARED backing size");
		const n = t * ir, r = Math.max(0, Math.min(ir, e.size - n));
		if (0 === r) return i;
		let s = 0;
		for (; s < r;) {
			const t = r - s, o = this.io.read(e.handle, i.subarray(s), n + s, t);
			if (o <= 0 || o > t) throw new Error(`Invalid MAP_SHARED backing read length: ${o}`);
			s += o;
		}
		return i;
	}
	readSharedMmapBackingRange(e, t, i) {
		const n = new Uint8Array(i);
		let r = 0;
		for (; r < i;) {
			const s = t + r, o = Math.floor(s / ir), a = s % ir, c = Math.min(ir - a, i - r);
			n.set(this.ensureSharedMmapBackingPageLoaded(e, o).subarray(a, a + c), r), r += c;
		}
		return n;
	}
	copyRangeToSharedMmapBacking(e, t, i, n) {
		let r = 0;
		for (; r < i.length;) {
			const s = t + r, o = Math.floor(s / ir), a = s % ir, c = Math.min(ir - a, i.length - r), h = e.dirtyPages.has(o);
			this.ensureSharedMmapBackingPageLoaded(e, o).set(i.subarray(r, r + c), a), n ? e.dirtyPages.add(o) : h || e.dirtyPages.delete(o), r += c;
		}
	}
	syncFileSharedMappingsFromProcess(e, t = {}) {
		const i = this.sharedMappings?.get(e.pid);
		if (!i) return;
		const n = new Uint8Array(e.memory.buffer), r = [];
		for (const [o, a] of i) {
			if ("file" !== a.backingKind || !a.backingKey || !a.snapshot) continue;
			const e = this.sharedMmapBackings.get(a.backingKey);
			if (!e || o + a.len > n.length) continue;
			const i = (a.seenVersion ?? 0) !== e.version;
			!t.force && e.refCount <= 1 && !i || r.push({
				mapAddr: o,
				mapping: a,
				backing: e,
				snapshot: a.snapshot
			});
		}
		for (const { mapAddr: o, mapping: a, backing: c, snapshot: h } of r) {
			let e = !1;
			if (a.writable) for (let t = 0; t < a.len; t += ir) {
				const i = Math.min(ir, a.len - t);
				this.rangeDiffersFromSnapshot(n, o + t, h, t, i) && this.mergeChangedFileMappingRuns(c, n, o + t, h, t, a.fileOffset + t, i) && (e = !0);
			}
			e && c.version++;
		}
		const s = r.filter(({ mapping: e, backing: t }) => (e.seenVersion ?? 0) !== t.version).map(({ mapAddr: e, mapping: t, backing: i }) => ({
			mapAddr: e,
			mapping: t,
			backing: i,
			latest: this.readSharedMmapBackingRange(i, t.fileOffset, t.len)
		}));
		for (const { mapAddr: o, mapping: a, backing: c, latest: h } of s) n.set(h, o), a.snapshot = h, a.seenVersion = c.version;
	}
	publishSharedMmapBackingObservers(e) {
		if (e.refCount <= 0) return;
		const t = /* @__PURE__ */ new Set();
		for (const [i, n] of this.sharedMappings) for (const r of n.values()) if ("file" === r.backingKind && r.backingKey === e.key) {
			t.add(i);
			break;
		}
		for (const i of t) {
			const e = this.processes.get(i);
			if (!e) throw new Error(`Missing process memory for MAP_SHARED observer ${i}`);
			this.syncFileSharedMappingsFromProcess(e, { force: !0 });
		}
	}
	mergeChangedFileMappingRuns(e, t, i, n, r, s, o) {
		let a = !1, c = 0;
		for (; c < o;) {
			for (; c < o && t[i + c] === n[r + c];) c++;
			if (c >= o) break;
			const h = c;
			do
				c++;
			while (c < o && t[i + c] !== n[r + c]);
			this.copyRangeToSharedMmapBacking(e, s + h, t.subarray(i + h, i + c), !0), a = !0;
		}
		return a;
	}
	flushSharedMmapBackingRange(e, t, i) {
		if (i <= 0 || 0 === e.dirtyPages.size) return !0;
		if (!e.sizeValid) return !1;
		const n = t + i, r = Math.min(n, e.size);
		let s = !0;
		for (const o of Array.from(e.dirtyPages).sort((e, t) => e - t)) {
			const i = o * ir, a = i + ir;
			if (i >= e.size) {
				i < n && a > t && e.dirtyPages.delete(o);
				continue;
			}
			if (i >= r || a <= t) continue;
			const c = Math.max(t, i), h = Math.min(a, e.size), l = Math.min(r, h), d = this.ensureSharedMmapBackingPageLoaded(e, o).subarray(c - i, l - i);
			this.writeAllToSharedMmapBacking(e, d, c) ? c === i && l === h && e.dirtyPages.delete(o) : s = !1;
		}
		return s;
	}
	writeAllToSharedMmapBacking(e, t, i) {
		let n = 0;
		for (; n < t.length;) try {
			const r = this.io.write(e.handle, t.subarray(n), i + n, t.length - n);
			if (r <= 0) return !1;
			n += r;
		} catch {
			return !1;
		}
		return !0;
	}
	flushSharedMappingsBeforeFileSyscall(e, t, i) {
		if (0 === (this.sharedMmapBackings?.size ?? 0)) return !0;
		try {
			if (t === Wn) {
				const t = this.resolveSharedMmapPath(e, i[0]);
				return "error" === t.kind || this.flushSharedBackingForPath(t.value);
			}
			if ((t === gr || t === mr) && 512 & (t === gr ? i[1] : i[2])) {
				const n = this.resolveSharedMmapPath(e, t === gr ? i[0] : i[1], t === mr ? i[0] : nr);
				return "error" === n.kind || this.flushSharedBackingForPath(n.value);
			}
			return t !== Mn || 1 & i[3] || 32 & i[3] || !(i[4] >= 0) ? t === Vn ? (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, i[0]) && this.flushSharedBackingForFd(e, i[1])) : 290 === t || 291 === t ? (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, i[0]) && this.flushSharedBackingForFd(e, i[2])) : !this.syscallTouchesFdStorageBeforeKernel(t) || (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, i[0])) : (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, i[4]));
		} catch {
			return !1;
		}
	}
	syscallTouchesFdStorageBeforeKernel(e) {
		return e === Fn || e === Rn || e === or || e === ar || e === Tn || e === Un || e === sr || e === cr || e === $n || e === On || e === Nn || e === Dn;
	}
	flushSharedBackingForFd(e, t) {
		if (t < 0) return !0;
		const i = this.findSharedMmapBackingForFd(e, t);
		if (!i) return !0;
		this.publishSharedMmapBackingObservers(i);
		const n = this.flushSharedMmapBackingRange(i, 0, Number.MAX_SAFE_INTEGER);
		return n && 0 === i.refCount && this.discardUnreferencedSharedMmapBacking(i), n;
	}
	resolveSharedMmapPath(e, t, i = -100) {
		try {
			const n = new Uint8Array(e.memory.buffer);
			if (t <= 0 || t >= n.length) return {
				kind: "error",
				errno: Ni
			};
			const r = Math.min(n.length, t + 4096);
			let s = t;
			for (; s < r && 0 !== n[s];) s++;
			if (s === r) return {
				kind: "error",
				errno: 36
			};
			const o = new Uint8Array(s - t);
			o.set(n.subarray(t, s));
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
			if (i !== nr) {
				const t = this.getFdPathForSharedMapping(e, i);
				if ("error" === t.kind) return t;
				c = t.value;
			} else {
				const t = this.kernelInstance.exports.kernel_get_cwd;
				if (!t) return {
					kind: "error",
					errno: 38
				};
				const i = t(e.pid, this.toKernelPtr(this.scratchOffset), Math.min(4096, te));
				if (i < 0) return {
					kind: "error",
					errno: -i
				};
				if (0 === i) return {
					kind: "error",
					errno: 2
				};
				c = new TextDecoder().decode(new Uint8Array(this.kernelMemory.buffer).slice(this.scratchOffset, this.scratchOffset + i));
			}
			return {
				kind: "ok",
				value: this.normalizeSharedMmapPath(`${c}/${a}`)
			};
		} catch (as) {
			return {
				kind: "error",
				errno: this.sharedMmapErrno(as)
			};
		}
	}
	normalizeSharedMmapPath(e) {
		const t = [];
		for (const i of e.split("/")) i && "." !== i && (".." === i ? t.pop() : t.push(i));
		return `/${t.join("/")}`;
	}
	findSharedMmapBackingForPath(e) {
		if (0 === this.sharedMmapBackings.size) return null;
		try {
			const t = this.io.stat(e);
			if (32768 != (61440 & t.mode)) return null;
			const i = this.io.fileIdentity?.(e, BigInt(t.dev), BigInt(t.ino)) ?? null;
			return i ? this.sharedMmapBackings.get(i) ?? null : null;
		} catch {
			return null;
		}
	}
	flushSharedBackingForPath(e) {
		const t = this.findSharedMmapBackingForPath(e);
		if (!t) return !0;
		this.publishSharedMmapBackingObservers(t);
		const i = this.flushSharedMmapBackingRange(t, 0, Number.MAX_SAFE_INTEGER);
		return i && 0 === t.refCount && this.discardUnreferencedSharedMmapBacking(t), i;
	}
	handleSharedMappingsAfterFileSyscall(e, t, i, n, r) {
		if (0 !== (this.sharedMmapBackings?.size ?? 0) && 0 === r) {
			if ((t === gr || t === mr) && n >= 0) return this.invalidateSharedMmapFdCache(e.pid, n), void (512 & (t === gr ? i[1] : i[2]) && this.reloadSharedMmapBackingForFd(e, n, 0));
			if (t !== yr || 0 !== n) if (t === Kn && n >= 0) this.invalidateSharedMmapFdCache(e.pid, n);
			else if ((t === Hn || t === Gn) && n >= 0) this.invalidateSharedMmapFdCache(e.pid, i[1]);
			else {
				if (t === hr && n >= 0) {
					const t = i[1] >>> 0;
					if (0 === t || 1030 === t || 1028 === t) return void this.invalidateSharedMmapFdCache(e.pid, n);
				}
				if (t === Un && n > 0) this.updateSharedMmapBackingFromProcessBuffer(e, i[0], i[1] >>> 0, n, i[3]);
				else if (t === Tn && n > 0) this.reloadSharedMmapBackingForFd(e, i[0]);
				else if ((t === sr || t === cr) && n > 0) this.reloadSharedMmapBackingForFd(e, i[0]);
				else if (t === Vn && n > 0) this.reloadSharedMmapBackingForFd(e, i[0]);
				else if ((290 === t || 291 === t) && n > 0) this.reloadSharedMmapBackingForFd(e, i[2]);
				else if (t !== Nn || 0 !== n) if (t !== Dn || 0 !== n) {
					if (t === Wn && 0 === n) {
						const t = this.resolveSharedMmapPath(e, i[0]);
						"ok" === t.kind && this.reloadSharedMmapBackingForPath(t.value, i[1]);
					}
				} else this.reloadSharedMmapBackingForFd(e, i[0]);
				else this.reloadSharedMmapBackingForFd(e, i[0], i[1]);
			}
			else this.invalidateSharedMmapFdCache(e.pid, i[0]);
		}
	}
	updateSharedMmapBackingFromProcessBuffer(e, t, i, n, r) {
		if (n <= 0) return;
		const s = this.findSharedMmapBackingForFd(e, t);
		if (!s) return;
		if (!Number.isSafeInteger(r) || r < 0 || !Number.isSafeInteger(r + n)) return s.sizeValid = !1, void this.invalidateSharedMmapBackingPages(s);
		if (0 !== this.revalidateSharedMmapBacking(s)) return void this.invalidateSharedMmapBackingPages(s);
		const o = new Uint8Array(e.memory.buffer);
		if (i + n > o.length) this.reloadSharedMmapBackingRange(s, r, n);
		else try {
			this.copyRangeToSharedMmapBacking(s, r, o.subarray(i, i + n), !1), s.version++;
		} catch {
			this.invalidateSharedMmapBackingRange(s, r, n);
		}
	}
	reloadSharedMmapBackingForFd(e, t, i) {
		const n = this.findSharedMmapBackingForFd(e, t);
		return !n || this.reloadSharedMmapBacking(n, i);
	}
	reloadSharedMmapBackingForPath(e, t) {
		const i = this.findSharedMmapBackingForPath(e);
		return !i || this.reloadSharedMmapBacking(i, t);
	}
	reloadSharedMmapBacking(e, t) {
		if (void 0 !== t && Number.isSafeInteger(t) && t >= 0) e.size = t, e.sizeValid = !0;
		else if (0 !== this.revalidateSharedMmapBacking(e)) return this.invalidateSharedMmapBackingPages(e), !1;
		if (0 === e.pages.size) return e.version++, !0;
		const i = Array.from(e.pages.keys()), n = /* @__PURE__ */ new Map();
		try {
			for (const t of i) n.set(t, this.readSharedMmapBackingPage(e, t));
		} catch {
			return this.invalidateSharedMmapBackingPages(e, i), !1;
		}
		for (const [r, s] of n) e.pages.set(r, s), e.dirtyPages.delete(r);
		return e.version++, !0;
	}
	reloadSharedMmapBackingRange(e, t, i) {
		if (i <= 0) return !0;
		const n = Math.floor(t / ir), r = Math.floor((t + i - 1) / ir), s = /* @__PURE__ */ new Map();
		try {
			for (let t = n; t <= r; t++) e.pages.has(t) && s.set(t, this.readSharedMmapBackingPage(e, t));
		} catch {
			return this.invalidateSharedMmapBackingPages(e, Array.from({ length: r - n + 1 }, (e, t) => n + t)), !1;
		}
		for (const [o, a] of s) e.pages.set(o, a), e.dirtyPages.delete(o);
		return s.size > 0 && e.version++, !0;
	}
	invalidateSharedMmapBackingRange(e, t, i) {
		if (i <= 0) return;
		const n = Math.floor(t / ir), r = Math.floor((t + i - 1) / ir);
		this.invalidateSharedMmapBackingPages(e, Array.from({ length: r - n + 1 }, (e, t) => n + t));
	}
	invalidateSharedMmapBackingPages(e, t = Array.from(e.pages.keys())) {
		for (const i of t) e.dirtyPages.has(i) || e.pages.delete(i);
		e.version++;
	}
	findSharedMmapBackingForFd(e, t) {
		if (0 === this.sharedMmapBackings.size || t < 0) return null;
		const i = this.sharedMmapFdCacheKey(e.pid, t), n = this.sharedMmapFdCache.get(i);
		if (void 0 !== n) return n.backingKey ? this.sharedMmapBackings.get(n.backingKey) ?? null : null;
		const r = this.getFdStatForSharedMapping(e, t);
		if ("error" === r.kind) return 9 === r.errno && this.sharedMmapFdCache.set(i, { backingKey: null }), null;
		if (32768 != (61440 & r.value.mode)) return this.sharedMmapFdCache.set(i, { backingKey: null }), null;
		const s = r.value.hostHandle, o = null === s ? {
			kind: "error",
			errno: 95
		} : this.resolveSharedMmapBackingKey(r.value, s);
		if ("error" === o.kind) return 9 !== o.errno && 95 !== o.errno || this.sharedMmapFdCache.set(i, { backingKey: null }), null;
		const a = this.sharedMmapBackings.get(o.value);
		return a ? (this.sharedMmapFdCache.set(i, { backingKey: a.key }), a) : (this.sharedMmapFdCache.set(i, { backingKey: null }), null);
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
		for (const i of this.sharedMmapFdCache.keys()) i.startsWith(t) && this.sharedMmapFdCache.delete(i);
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
	mergeChangedByteRuns(e, t, i, n, r, s, o) {
		let a = !1, c = 0;
		for (; c < o;) {
			for (; c < o && e[t + c] === i[n + c];) c++;
			if (c >= o) break;
			const h = c;
			do
				c++;
			while (c < o && e[t + c] !== i[n + c]);
			r.set(e.subarray(t + h, t + c), s + h), a = !0;
		}
		return a;
	}
	rangeDiffersFromSnapshot(e, t, i, n, r) {
		const s = e.byteOffset + t, o = i.byteOffset + n;
		if (!(3 & (s | o | r))) {
			const t = new Uint32Array(e.buffer, s, r / 4), n = new Uint32Array(i.buffer, o, r / 4);
			for (let e = 0; e < t.length; e++) if (t[e] !== n[e]) return !0;
			return !1;
		}
		for (let a = 0; a < r; a++) if (e[t + a] !== i[n + a]) return !0;
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
		const i = this.processes.get(t);
		if (!i) throw new Error(`Process ${t} is not registered`);
		try {
			const n = this.sharedMappings.get(e);
			if (n) {
				const e = new Uint8Array(i.memory.buffer), r = /* @__PURE__ */ new Map();
				this.sharedMappings.set(t, r);
				for (const [t, i] of n) {
					if (!i.backingKey) continue;
					const n = "file" !== i.backingKind ? this.anonymousSharedBackings.get(i.backingKey) : void 0, s = "file" === i.backingKind ? this.sharedMmapBackings.get(i.backingKey) : void 0;
					if (!n && !s || t + i.len > e.length) throw new Error(`Cannot inherit shared mapping at 0x${t.toString(16)}`);
					const o = n ? n.bytes.slice(i.fileOffset, i.fileOffset + i.len) : this.readSharedMmapBackingRange(s, i.fileOffset, i.len);
					e.set(o, t);
					const a = n?.version ?? s.version;
					n ? n.refCount++ : s.refCount++, r.set(t, {
						...i,
						snapshot: o,
						seenVersion: a
					});
				}
				0 === r.size && this.sharedMappings.delete(t);
			}
			this.inheritSysvShmMappings(e, t);
		} catch (as) {
			throw this.releaseAllSharedMemoryForProcess(t, !1), as;
		}
	}
	populateMmapFromFile(e, t, i) {
		const n = i[4], r = i[1];
		let s = 4096 * i[5];
		const o = this.kernelInstance.exports.kernel_handle_channel, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = new Uint8Array(this.kernelMemory.buffer), h = this.scratchOffset + 72;
		let l = 0;
		for (; l < r;) {
			const i = Math.min(te, r - l);
			a.setUint32(4, Rn, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(h), !0), a.setBigInt64(24, BigInt(i), !0), a.setBigInt64(32, BigInt(s), !0), a.setBigInt64(40, 0n, !0), a.setBigInt64(48, BigInt(0), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
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
			if (new Uint8Array(e.memory.buffer).set(c.subarray(h, h + d), t + l), l += d, s += d, d < i) break;
		}
	}
	flushSharedMappings(e, t) {
		try {
			this.syncAnonymousSharedMappingsFromProcess(e, { force: !0 }), this.syncFileSharedMappingsFromProcess(e, { force: !0 });
		} catch {
			return !1;
		}
		const i = t[0] >>> 0, n = t[1] >>> 0, r = this.sharedMappings.get(e.pid);
		if (!r || 0 === r.size) return !0;
		const s = i + n;
		let o = !0;
		for (const [a, c] of r) {
			const t = a + c.len;
			if (a >= s || t <= i) continue;
			const n = Math.max(i, a), r = Math.min(s, t) - n;
			if (r <= 0) continue;
			const h = c.fileOffset + (n - a);
			if ("file" === c.backingKind && c.backingKey) {
				const e = this.sharedMmapBackings.get(c.backingKey);
				e && this.flushSharedMmapBackingRange(e, h, r) || (o = !1);
				continue;
			}
			c.writable && (c.backingKey || this.pwriteFromProcessMemory(e, c.fd, n, r, h) || (o = !1));
		}
		return o;
	}
	pwriteFromProcessMemory(e, t, i, n, r) {
		const s = this.kernelInstance.exports.kernel_handle_channel, o = this.scratchOffset + 72;
		if (i + n > e.memory.buffer.byteLength) return !1;
		const a = this.currentHandlePid;
		try {
			let a = 0;
			for (; a < n;) {
				const c = Math.min(te, n - a), h = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = new Uint8Array(this.kernelMemory.buffer), d = new Uint8Array(e.memory.buffer);
				l.set(d.subarray(i + a, i + a + c), o);
				const f = r + a;
				if (h.setUint32(4, Un, !0), h.setBigInt64(8, BigInt(t), !0), h.setBigInt64(16, BigInt(o), !0), h.setBigInt64(24, BigInt(c), !0), h.setBigInt64(32, BigInt(f), !0), h.setBigInt64(40, 0n, !0), h.setBigInt64(48, BigInt(0), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid, s(this.toKernelPtr(this.scratchOffset), e.pid), this.finishSignalTermination(e)) return !1;
				const u = new DataView(this.kernelMemory.buffer, this.scratchOffset), p = Number(u.getBigInt64(56, !0));
				if (p <= 0 || p > c) return !1;
				if (a += p, p < c) return !1;
			}
			return a === n;
		} catch {
			return !1;
		} finally {
			this.currentHandlePid = a;
		}
	}
	cleanupSharedMappings(e, t, i) {
		const n = this.sharedMappings.get(e);
		if (!n) return;
		const r = t + i;
		for (const [s, o] of Array.from(n.entries())) {
			const e = s + o.len, i = Math.max(t, s), a = Math.min(r, e);
			if (i >= a) continue;
			if (i <= s && a >= e) {
				this.releaseSharedMapping(o), n.delete(s);
				continue;
			}
			if (i <= s) {
				const t = a - s;
				n.delete(s), o.fileOffset += t, o.len = e - a, o.snapshot && (o.snapshot = o.snapshot.slice(t)), o.len > 0 ? n.set(a, o) : this.releaseSharedMapping(o);
				continue;
			}
			if (a >= e) {
				o.len = i - s, o.snapshot && (o.snapshot = o.snapshot.slice(0, o.len));
				continue;
			}
			const c = i - s, h = a - s, l = {
				...o,
				fileOffset: o.fileOffset + h,
				len: e - a,
				...o.snapshot ? { snapshot: o.snapshot.slice(h) } : {}
			};
			if (o.len = c, o.snapshot && (o.snapshot = o.snapshot.slice(0, c)), o.backingKey) {
				const e = "file" === o.backingKind ? this.sharedMmapBackings.get(o.backingKey) : this.anonymousSharedBackings.get(o.backingKey);
				e && e.refCount++;
			}
			n.set(a, l);
		}
		0 === n.size && this.sharedMappings.delete(e);
	}
	preflightFileSharedMremap(e, t) {
		const i = t[0] >>> 0, n = t[2] >>> 0, r = this.sharedMappings.get(e)?.get(i);
		if (!r || "file" !== r.backingKind || n <= r.len) return 0;
		if (!r.backingKey) return 5;
		const s = this.sharedMmapBackings.get(r.backingKey);
		if (!s) return 5;
		try {
			return this.ensureSharedMmapBackingRangeLoaded(s, r.fileOffset + r.len, n - r.len), 0;
		} catch {
			return 5;
		}
	}
	remapSharedMapping(e, t, i, n) {
		const r = this.sharedMappings.get(e), s = r?.get(t);
		if (r && s) {
			if (r.delete(t), s.backingKey && s.snapshot) {
				const t = this.processes.get(e), r = "file" === s.backingKind ? this.sharedMmapBackings.get(s.backingKey) : void 0, o = "file" !== s.backingKind ? this.anonymousSharedBackings.get(s.backingKey) : void 0;
				if (r && t) {
					this.ensureSharedMmapBackingRangeLoaded(r, s.fileOffset, n);
					const e = this.readSharedMmapBackingRange(r, s.fileOffset, n);
					new Uint8Array(t.memory.buffer).set(e, i), s.snapshot = e, s.seenVersion = r.version;
				} else if (o && t) {
					const e = s.fileOffset + n;
					if (e > o.bytes.length) {
						const r = new Uint8Array(e);
						r.set(o.bytes);
						const a = new Uint8Array(t.memory.buffer);
						i + n <= a.length && n > s.len && r.set(a.subarray(i + s.len, i + n), s.fileOffset + s.len), o.bytes = r, o.version++;
					}
					const r = o.bytes.slice(s.fileOffset, s.fileOffset + n);
					new Uint8Array(t.memory.buffer).set(r, i), s.snapshot = r, s.seenVersion = o.version;
				} else s.snapshot = s.snapshot.slice(0, n);
			}
			s.len = n, r.set(i, s);
		}
	}
	prepareFileSharedMappingsForWrite(e, t, i) {
		const n = this.sharedMappings.get(e);
		if (!n || 0 === i) return 0;
		const r = t + i;
		for (const [s, o] of n) {
			if ("file" !== o.backingKind) continue;
			if (s + o.len <= t || s >= r) continue;
			if (!0 !== o.writeAllowed) return 13;
			if (!o.backingKey) return 5;
			const e = this.sharedMmapBackings.get(o.backingKey);
			if (!e) return 5;
			if (!e.writable) return 5;
		}
		return 0;
	}
	updateSharedMappingProtection(e, t, i, n) {
		const r = this.sharedMappings.get(e);
		if (!r || 0 === i || !n) return;
		const s = t + i;
		for (const [o, a] of r) o + a.len <= t || o >= s || (a.writable = !0);
	}
	hasPeerSysvShmMapping(e, t, i) {
		for (const [n, r] of this.shmMappings) for (const [s, o] of r) if (o.segId === i && (n !== e || s !== t)) return !0;
		return !1;
	}
	syncSysvShmMappingsFromProcess(e, t = {}) {
		const i = this.shmMappings?.get(e.pid);
		if (!i) return !0;
		const n = new Uint8Array(e.memory.buffer);
		let r = !0;
		for (const [s, o] of i) (t.force || this.hasPeerSysvShmMapping(e.pid, s, o.segId)) && (this.mergeAndRefreshSysvShmMapping(n, s, o) || (r = !1));
		return r;
	}
	syncSysvShmSegmentFromMappedProcesses(e) {
		for (const [t, i] of this.shmMappings) {
			const n = this.processes.get(t);
			if (!n) continue;
			const r = new Uint8Array(n.memory.buffer);
			for (const [t, s] of i) s.segId === e && this.mergeAndRefreshSysvShmMapping(r, t, s);
		}
	}
	mappingDiffersFromSnapshot(e, t, i, n) {
		for (let r = 0; r < n; r += 4096) {
			const s = Math.min(4096, n - r);
			if (this.rangeDiffersFromSnapshot(e, t + r, i, r, s)) return !0;
		}
		return !1;
	}
	mergeAndRefreshSysvShmMapping(e, t, i) {
		if (t + i.size > e.length) return !1;
		const n = this.shmSegmentVersions.get(i.segId) ?? 0, r = !i.readOnly && this.mappingDiffersFromSnapshot(e, t, i.snapshot, i.size);
		if (!r && i.seenVersion === n) return !0;
		const s = this.readSysvShmRange(i.segId, 0, i.size);
		if (!s) return !1;
		let o = !1, a = !0;
		if (r) for (let c = 0; c < i.size; c += 4096) {
			const n = Math.min(4096, i.size - c);
			if (!this.rangeDiffersFromSnapshot(e, t + c, i.snapshot, c, n)) continue;
			let r = 0;
			for (; r < n;) {
				for (; r < n && e[t + c + r] === i.snapshot[c + r];) r++;
				if (r >= n) break;
				const h = r;
				do
					r++;
				while (r < n && e[t + c + r] !== i.snapshot[c + r]);
				const l = e.subarray(t + c + h, t + c + r);
				if (!this.writeSysvShmRange(i.segId, c + h, l)) {
					a = !1;
					break;
				}
				s.set(l, c + h), o = !0;
			}
			if (!a) break;
		}
		return o && this.shmSegmentVersions.set(i.segId, n + 1), e.set(s, t), i.snapshot = s, i.seenVersion = this.shmSegmentVersions.get(i.segId) ?? n, a;
	}
	readSysvShmRange(e, t, i) {
		const n = this.kernelInstance.exports.kernel_ipc_shm_read_chunk;
		if (!n) return null;
		const r = new Uint8Array(i);
		let s = 0;
		for (; s < i;) {
			const o = Math.min(te, i - s), a = this.scratchOffset + 72, c = n(e, t + s, this.toKernelPtr(a), o);
			if (c < 0 || c > o) return null;
			if (0 === c) break;
			r.set(new Uint8Array(this.kernelMemory.buffer, a, c), s), s += c;
		}
		return r;
	}
	writeSysvShmRange(e, t, i) {
		const n = this.kernelInstance.exports.kernel_ipc_shm_write_chunk;
		if (!n) return !1;
		let r = 0;
		for (; r < i.length;) {
			const s = Math.min(te, i.length - r), o = this.scratchOffset + 72;
			new Uint8Array(this.kernelMemory.buffer).set(i.subarray(r, r + s), o);
			const a = n(e, t + r, this.toKernelPtr(o), s);
			if (a <= 0 || a > s) return !1;
			r += a;
		}
		return !0;
	}
	inheritSysvShmMappings(e, t) {
		const i = this.shmMappings.get(e);
		if (!i || 0 === i.size) return;
		const n = this.processes.get(t);
		if (!n) throw new Error(`Process ${t} is not registered`);
		const r = this.kernelInstance.exports.kernel_ipc_shmat_for_process, s = this.kernelInstance.exports.kernel_ipc_shmdt_for_process;
		if (!r || !s) throw new Error("Kernel lacks SysV SHM inheritance exports");
		const o = new Uint8Array(n.memory.buffer), a = /* @__PURE__ */ new Map();
		try {
			for (const [e, n] of i) {
				if (e + n.size > o.length) throw new Error(`Cannot inherit SysV mapping at 0x${e.toString(16)}`);
				const i = r(t, n.segId, e, n.readOnly ? 4096 : 0);
				if (i < 0 || i !== n.size) throw new Error(`SysV shmat inheritance failed for segment ${n.segId}`);
				const c = this.readSysvShmRange(n.segId, 0, n.size);
				if (!c) throw s(t, n.segId), /* @__PURE__ */ new Error(`Cannot read inherited SysV segment ${n.segId}`);
				o.set(c, e), a.set(e, {
					...n,
					snapshot: c,
					seenVersion: this.shmSegmentVersions.get(n.segId) ?? n.seenVersion
				});
			}
		} catch (as) {
			for (const i of a.values()) s(t, i.segId);
			throw a.clear(), as;
		}
		a.size > 0 && this.shmMappings.set(t, a);
	}
	releaseAllSysvShmMappingsForProcess(e, t = !0) {
		const i = this.shmMappings?.get(e);
		if (!i) return;
		const n = this.processes.get(e);
		t && n && this.syncSysvShmMappingsFromProcess(n, { force: !0 });
		const r = this.kernelInstance.exports.kernel_ipc_shmdt_for_process;
		if (r) for (const s of i.values()) r(e, s.segId);
		this.shmMappings.delete(e);
	}
	releaseAllSharedMemoryForProcess(e, t = !0) {
		const i = this.sharedMemoryReleasePids ??= /* @__PURE__ */ new Set();
		if (!i.has(e)) {
			i.add(e);
			try {
				const i = this.processes?.get(e), n = i?.channels?.[0];
				if (t && i) {
					try {
						this.syncAnonymousSharedMappingsFromProcess(i, { force: !0 });
					} catch {}
					try {
						this.syncFileSharedMappingsFromProcess(i, { force: !0 });
					} catch {}
					try {
						this.syncSysvShmMappingsFromProcess(i, { force: !0 });
					} catch {}
					if (n) {
						const t = this.sharedMappings.get(e);
						if (t) {
							for (const [e, i] of t) if (i.writable) {
								if ("file" === i.backingKind && i.backingKey) {
									const e = this.sharedMmapBackings.get(i.backingKey);
									e && this.flushSharedMmapBackingRange(e, i.fileOffset, i.len);
									continue;
								}
								i.backingKey || this.pwriteFromProcessMemory(n, i.fd, e, i.len, i.fileOffset);
							}
						}
					}
				}
				const r = this.sharedMappings?.get(e);
				if (r) {
					for (const e of r.values()) this.releaseSharedMapping(e);
					this.sharedMappings?.delete(e);
				}
				this.invalidateSharedMmapFdCacheForPid(e), this.shmMappings && this.releaseAllSysvShmMappingsForProcess(e, !1);
			} finally {
				i.delete(e);
			}
		}
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
		const n = i(e, this.toKernelPtr(t)), r = "bigint" == typeof n ? Number(n) : n;
		if (!Number.isSafeInteger(r) || r < 0 || r >>> 0 == 4294967295) throw new Error(`failed to reserve ${t} bytes of pthread control memory for pid=${e}`);
		return r;
	}
	reserveHostRegionAt(e, t, i) {
		const n = this.kernelInstance.exports.kernel_reserve_host_region_at;
		if (!n) throw new Error("Kernel export kernel_reserve_host_region_at is required for fork-from-pthread control slots");
		const r = n(e, this.toKernelPtr(t), this.toKernelPtr(i)), s = "bigint" == typeof r ? Number(r) : r;
		if (!Number.isSafeInteger(s) || s < 0 || s >>> 0 == 4294967295 || s !== t) throw new Error(`failed to reserve pthread control memory at 0x${t.toString(16)} for pid=${e}`);
		return s;
	}
	highControlFloorForProcess(e) {
		const t = this.processes.get(e);
		if (!t) return null;
		if (t.explicitMaxAddr) return null;
		let i = null;
		for (const n of t.channels) {
			const e = n.channelOffset - 131072;
			e >= Ti && (i = null === i ? e : Math.min(i, e));
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
	getKernelMemoryPages() {
		const e = this.kernelInstance?.exports.kernel_get_memory_pages;
		if ("function" != typeof e) throw new Error("kernel_get_memory_pages export is unavailable");
		return e() >>> 0;
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
	reconcileReusedTcpListenerKey(e, t, i, n, r) {
		const s = r.port, o = (this.tcpListenerTargets.get(s) ?? []).filter((i) => !(i.pid === e && i.fd === t)), a = void 0 !== n?.acceptWakeIdx ? this.resolveInheritedListenerFd(e, t, n.acceptWakeIdx) : null;
		if (a && a.fd !== t && !o.some((t) => t.pid === e && t.fd === a.fd) && o.push({
			pid: e,
			...a
		}), 0 === o.length) {
			if (this.tcpListenerTargets.delete(s), s !== i) {
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
			this.tcpListeners.has(t) || this.tcpListeners.set(t, r);
		} else if (o.length > 0) {
			const e = o[0], t = `${e.pid}:${e.fd}`;
			this.tcpListeners.has(t) || this.tcpListeners.set(t, {
				...r,
				pid: e.pid
			});
		} else s !== i && r.server.close();
		return s === i ? r : void 0;
	}
	startTcpListener(e, t, i, n = [
		0,
		0,
		0,
		0
	]) {
		const r = `${e}:${t}`, s = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx, o = s?.(e, t) ?? -1;
		let a;
		const c = this.tcpListeners.get(r);
		if (c) {
			const n = this.tcpListenerTargets.get(c.port)?.find((i) => i.pid === e && i.fd === t), r = n?.acceptWakeIdx;
			if (void 0 === r && c.port === i || void 0 !== r && r === o) return void (n && void 0 === r && o >= 0 && (n.acceptWakeIdx = o));
			a = this.reconcileReusedTcpListenerKey(e, t, i, n, c);
		}
		this.tcpListenerTargets.has(i) || (this.tcpListenerTargets.set(i, []), this.tcpListenerRRIndex.set(i, 0));
		const h = this.tcpListenerTargets.get(i);
		if (h.some((i) => i.pid === e && i.fd === t) || h.push({
			pid: e,
			fd: t,
			...o >= 0 ? { acceptWakeIdx: o } : {}
		}), this.io.network?.listenTcp && !this.tcpVirtualListenerKeys.has(i)) {
			const e = this.io.network.listenTcp(r, new Uint8Array(n), i, { accept: (e, t, n) => {
				const r = this.pickListenerTarget(i);
				return r ? this.handleIncomingVirtualTcpConnection(r.pid, r.fd, e, n) : 113;
			} });
			0 !== e ? console.warn(`virtual TCP listener registration failed on port ${i}: errno ${e}`) : this.tcpVirtualListenerKeys.set(i, r);
		}
		if (!this.netModule) return;
		if (a) return void this.tcpListeners.set(r, {
			...a,
			pid: e,
			port: i
		});
		for (const [, u] of this.tcpListeners) if (u.port === i) return void this.tcpListeners.set(r, u);
		const l = this.netModule, d = /* @__PURE__ */ new Set(), f = l.createServer({ allowHalfOpen: !0 }, (e) => {
			const t = this.pickListenerTarget(i);
			t ? this.handleIncomingTcpConnection(t.pid, t.fd, e, d) : e.destroy();
		});
		f.listen(i, "0.0.0.0", () => {}), f.on("error", (e) => {
			console.error(`TCP listener error on port ${i}:`, e);
		}), this.tcpListeners.set(r, {
			server: f,
			pid: e,
			port: i,
			connections: d
		});
	}
	pickListenerTarget(e) {
		const t = this.tcpListenerTargets.get(e);
		if (!t || 0 === t.length) return null;
		const i = t.filter((e) => this.processes.has(e.pid));
		if (0 === i.length) return null;
		let n = i;
		if (i.length > 1) {
			const e = i.filter((e) => void 0 !== this.getParentPid(e.pid));
			e.length > 0 && (n = e);
		}
		const r = (this.tcpListenerRRIndex.get(e) ?? 0) % n.length;
		return this.tcpListenerRRIndex.set(e, r + 1), n[r];
	}
	injectHostConnection(e, t, i, n) {
		if (!this.kernelInstance) return -1;
		const r = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, i[0], i[1], i[2], i[3], n);
		return r >= 0 && this.scheduleWakeBlockedRetries(), r;
	}
	readHostPipe(e, t) {
		if (!this.kernelInstance) return null;
		const i = $i("kernel_pipe_read", (0, this.kernelInstance.exports.kernel_pipe_read)(e, t, this.toKernelPtr(this.tcpScratchOffset), 65536), 65536);
		if (i <= 0) return null;
		const n = this.getKernelMem().slice(this.tcpScratchOffset, this.tcpScratchOffset + i);
		return this.notifyPipeWritable(t), n;
	}
	writeHostPipe(e, t, i) {
		if (!this.kernelInstance) return -1;
		const n = this.kernelInstance.exports.kernel_pipe_write, r = this.writePipeChunked(n, e, t, i);
		return r > 0 && this.notifyPipeReadable(t), r;
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
	async sendHttpRequest(e, t, i = {}) {
		const n = i.timeoutMs ?? 6e4, r = i.maxResponseBytes ?? Number.MAX_SAFE_INTEGER;
		if (!Number.isSafeInteger(r) || r < 1) throw new Error("in-kernel HTTP response bound must be a positive safe integer");
		const s = i.debugLabel ?? `${t.method} ${t.url}`, o = this.pickListenerTarget(e);
		if (!o) throw new Error(`No in-kernel listener for port ${e}`);
		const a = this.kernelInstance.exports, c = a.kernel_inject_connection, h = a.kernel_pipe_write, l = a.kernel_pipe_read, d = a.kernel_pipe_is_write_open, f = a.kernel_pipe_close_write, u = a.kernel_pipe_close_read, p = 1024 + Math.floor(6e4 * Math.random()), g = c(o.pid, o.fd, 127, 0, 0, 1, p);
		if (g < 0) throw new Error(`[in-kernel-http ${s}] kernel_inject_connection failed (${g})`);
		const m = g + 1;
		this.wakeTargetPollNow(o.pid), this.scheduleWakeBlockedRetries();
		const y = function(e) {
			let t = `${e.method} ${e.url} HTTP/1.1\r\n`;
			const i = Object.keys(e.headers).map((e) => e.toLowerCase());
			for (const [s, o] of Object.entries(e.headers)) t += `${s}: ${o}\r\n`;
			e.body && e.body.length > 0 && !i.includes("content-length") && (t += `Content-Length: ${e.body.length}\r\n`), i.includes("connection") || (t += "Connection: close\r\n"), t += "\r\n";
			const n = vi.encode(t);
			if (!e.body || 0 === e.body.length) return n;
			const r = new Uint8Array(n.length + e.body.length);
			return r.set(n, 0), r.set(e.body, n.length), r;
		}(t), w = this.writePipeChunked(h, 0, g, y);
		if (w < y.length) throw f(0, g), u(0, m), /* @__PURE__ */ new Error(`[in-kernel-http ${s}] partial write ${w}/${y.length}`);
		this.notifyPipeReadable(g);
		const b = await this.pumpHttpResponse(0, m, g, l, d, u, f, n, r, t.method, s), k = i.emptyResponseRetries ?? 1;
		return k > 0 && ("GET" === t.method || "HEAD" === t.method) && 200 === b.status && 0 === Object.keys(b.headers).length && 0 === b.body.length ? await this.sendHttpRequest(e, t, {
			...i,
			emptyResponseRetries: k - 1
		}) : b;
	}
	wakeTargetPollNow(e) {
		for (const [t, i] of this.pendingPollRetries) if (i.channel.pid === e) {
			null !== i.timer && clearTimeout(i.timer), this.pendingPollRetries.delete(t), this.isRegisteredChannel(i.channel) && this.retrySyscall(i.channel);
			break;
		}
	}
	writePipeChunked(e, t, i, n) {
		const r = this.tcpScratchOffset;
		let s = 0;
		for (; s < n.length;) {
			const o = Math.min(n.length - s, 65536);
			this.getKernelMem().set(n.subarray(s, s + o), r);
			const a = $i("kernel_pipe_write", e(t, i, this.toKernelPtr(r), o), o);
			if (a <= 0) break;
			s += a;
		}
		return s;
	}
	pumpHttpResponse(e, t, i, n, r, s, o, a, c, h, l) {
		return new Promise((l, d) => {
			const f = new Pi(c), u = Date.now();
			let p = !1;
			const g = this.tcpScratchOffset, m = (n) => {
				s(e, t), o(e, i), this.notifyPipeReadable(i), this.scheduleWakeBlockedRetries(), l(n);
			}, y = (n) => {
				s(e, t), o(e, i), this.notifyPipeReadable(i), this.scheduleWakeBlockedRetries(), d(n instanceof Error ? n : new Error(String(n)));
			}, w = () => {
				if (Date.now() - u > a) return void m({
					status: 504,
					headers: {},
					body: new Uint8Array(0)
				});
				let i = !1;
				for (;;) try {
					const r = $i("kernel_pipe_read", n(e, t, this.toKernelPtr(g), 65536), 65536);
					if (r <= 0) break;
					i = !0;
					const s = this.getKernelMem();
					f.push(s.slice(g, g + r));
				} catch (o) {
					y(o);
					return;
				}
				i && this.notifyPipeWritable(t);
				const s = 1 === r(e, t);
				s && !p && (p = !0), !p || s || i ? setTimeout(w, i ? 0 : 2) : m(Ii(f.concat(), h));
			};
			w();
		});
	}
	handleIncomingTcpConnection(e, t, i, n) {
		n.add(i);
		const r = i.remoteAddress || "127.0.0.1", s = i.remotePort || 0, o = r.replace("::ffff:", "").split(".").map(Number), a = o[0] || 127, c = o[1] || 0, h = o[2] || 0, l = o[3] || 1, d = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, a, c, h, l, s);
		if (d < 0) return i.destroy(), void n.delete(i);
		this.scheduleWakeBlockedRetries();
		const f = d + 1, u = this.kernelInstance.exports.kernel_pipe_write, p = this.kernelInstance.exports.kernel_pipe_read, g = this.kernelInstance.exports.kernel_pipe_close_write, m = this.kernelInstance.exports.kernel_pipe_close_read, y = this.kernelInstance.exports.kernel_pipe_is_read_open, w = this.kernelInstance.exports.kernel_pipe_has_readers, b = [];
		let k = !1, v = !1, S = !1, P = !1, I = !1, z = !1;
		const x = this.tcpScratchOffset, E = this.kernelInstance.exports.kernel_pipe_is_write_open, M = () => {
			P || (P = !0, g(0, d), this.notifyPipeReadable(d));
		}, A = () => {
			if (0 === y(0, d)) return b.length = 0, void (k && M());
			const e = this.getKernelMem();
			let t = !1;
			for (; b.length > 0;) {
				const i = b[0], n = Math.min(i.length, 65536);
				e.set(i.subarray(0, n), x);
				const r = $i("kernel_pipe_write", u(0, d, this.toKernelPtr(x), n), n);
				if (r <= 0) break;
				t = !0, r >= i.length ? b.shift() : b[0] = i.subarray(r);
			}
			k && 0 === b.length && M(), t && this.notifyPipeReadable(d);
		}, C = () => {
			const e = this.getKernelMem();
			let t = 0;
			for (;;) {
				const n = $i("kernel_pipe_read", p(0, f, this.toKernelPtr(x), 65536), 65536);
				if (n <= 0) break;
				t += n;
				const r = Buffer.from(e.slice(x, x + n));
				i.destroyed || i.write(r);
			}
			return t > 0 && this.notifyPipeWritable(f), t;
		}, _ = (e = 0) => {
			I || z || (I = !0, e > 0 ? setTimeout(L, e) : setImmediate(L));
		}, L = () => {
			if (I = !1, z) return;
			A();
			const e = C(), t = E(0, f), n = w(0, d);
			0 !== t || 0 !== e || S || (S = !0, i.destroyed || i.writableEnded || i.end()), 0 === t && n <= 0 || S && k && 0 === b.length || v && 0 === b.length ? F() : _();
		};
		i.on("data", (e) => {
			z || (b.push(e), A(), _());
		}), i.on("end", () => {
			k = !0, _();
		}), i.on("error", () => {
			k = !0, i.destroy(), F();
		}), i.on("close", () => {
			n.delete(i), v = !0, k = !0, _();
		});
		let B = this.tcpConnections.get(e);
		B || (B = [], this.tcpConnections.set(e, B));
		const T = {
			sendPipeIdx: f,
			scratchOffset: x,
			clientSocket: i,
			recvPipeIdx: d,
			schedulePump: _
		};
		B.push(T);
		const F = () => {
			if (z) return;
			z = !0, b.length = 0, M(), m(0, f), this.notifyPipeWritable(f);
			const t = this.tcpConnections?.get(e);
			if (t) {
				const i = t.indexOf(T);
				i >= 0 && t.splice(i, 1), 0 === t.length && this.tcpConnections?.delete(e);
			}
			i.destroyed || i.destroySoon();
		};
	}
	handleIncomingVirtualTcpConnection(e, t, i, n) {
		if (!this.kernelInstance) return 107;
		const r = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, n.addr[0] ?? 0, n.addr[1] ?? 0, n.addr[2] ?? 0, n.addr[3] ?? 0, n.port);
		if (r < 0) return -r;
		const s = r + 1, o = this.kernelInstance.exports.kernel_pipe_write, a = this.kernelInstance.exports.kernel_pipe_read, c = this.kernelInstance.exports.kernel_pipe_close_write, h = this.kernelInstance.exports.kernel_pipe_close_read, l = this.kernelInstance.exports.kernel_pipe_is_write_open, d = this.kernelInstance.exports.kernel_pipe_is_read_open, f = this.kernelInstance.exports.kernel_pipe_has_readers;
		let u = !1, p = !1, g = !1, m = !1, y = null, w = !1;
		const b = this.tcpScratchOffset, k = () => {
			p || (p = !0, c(0, r));
		}, v = () => {
			u || (u = !0, k(), h(0, s), i.close(), this.notifyPipeReadable(r), this.notifyPipeWritable(s), this.scheduleWakeBlockedRetries());
		}, S = () => {
			if (0 === d(0, r)) return y = null, void (g || (g = !0, i.shutdown(0)));
			for (;;) {
				let t;
				if (y) t = y;
				else try {
					t = i.recv(65536, 0);
				} catch (e) {
					if (11 === e?.errno) return;
					v();
					return;
				}
				if (0 === t.length) return y = null, k(), void this.notifyPipeReadable(r);
				const n = this.writePipeChunked(o, 0, r, t);
				if (n < t.length) return void (y = t.subarray(n));
				y = null, this.notifyPipeReadable(r);
			}
		}, P = () => {
			const e = this.getKernelMem();
			for (;;) {
				const t = $i("kernel_pipe_read", a(0, s, this.toKernelPtr(b), 65536), 65536);
				if (t <= 0) break;
				try {
					i.send(e.slice(b, b + t), 0);
				} catch {
					v();
					return;
				}
				this.notifyPipeWritable(s);
			}
		}, I = () => {
			if (w = !1, u) return;
			S(), P();
			const e = l(0, s), t = f(0, r);
			0 !== e || m || (m = !0, i.shutdown(1)), 0 === e && t <= 0 || m && p ? v() : z(2);
		}, z = (e = 0) => {
			w || u || (w = !0, setTimeout(I, e));
		};
		return this.scheduleWakeBlockedRetries(), z(), 0;
	}
	injectUdpDatagram(e, t) {
		if (!this.kernelInstance || !this.processes.has(e)) return 113;
		if (t.data.length > 65536) return 90;
		const i = this.kernelInstance.exports.kernel_inject_datagram;
		if (!i) return 38;
		const n = this.tcpScratchOffset;
		this.getKernelMem().set(t.data, n);
		const r = i(e, t.dstAddr[0] ?? 0, t.dstAddr[1] ?? 0, t.dstAddr[2] ?? 0, t.dstAddr[3] ?? 0, t.dstPort, t.srcAddr[0] ?? 0, t.srcAddr[1] ?? 0, t.srcAddr[2] ?? 0, t.srcAddr[3] ?? 0, t.srcPort, this.toKernelPtr(n), t.data.length);
		return r < 0 ? -r : (this.scheduleWakeBlockedRetries(), 0);
	}
	cleanupUdpBindings(e) {
		if (!this.io.network?.unbindUdp) return;
		const t = `${e}:`;
		for (const i of Array.from(this.udpBindings)) i.startsWith(t) && (this.io.network.unbindUdp(i), this.udpBindings.delete(i));
	}
	cleanupTcpListeners(e) {
		for (const [i, n] of this.tcpListenerTargets) {
			const t = n.filter((t) => t.pid !== e);
			if (0 === t.length) {
				this.tcpListenerTargets.delete(i), this.tcpListenerRRIndex.delete(i);
				const e = this.tcpVirtualListenerKeys.get(i);
				e && (this.io.network?.closeTcpListener?.(e), this.tcpVirtualListenerKeys.delete(i));
			} else this.tcpListenerTargets.set(i, t);
		}
		const t = `${e}:`;
		for (const [i, n] of Array.from(this.tcpListeners)) {
			if (!i.startsWith(t)) continue;
			this.tcpListeners.delete(i);
			const e = this.tcpListenerTargets.get(n.port);
			if (e && 0 !== e.length) {
				const t = e[0], i = `${t.pid}:${t.fd}`;
				this.tcpListeners.has(i) || this.tcpListeners.set(i, {
					...n,
					pid: t.pid
				});
			} else n.server.close();
		}
		this.tcpConnections.delete(e);
	}
	handleSemctl(e, t) {
		const [i, n, r, s] = t, o = -257 & r, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = this.kernelInstance.exports.kernel_handle_channel, h = this.getKernelMem(), l = this.scratchOffset + 72;
		if (2 === o && 0 !== s) {
			a.setUint32(4, lr, !0), a.setBigInt64(8, BigInt(i), !0), a.setBigInt64(16, BigInt(n), !0), a.setBigInt64(24, BigInt(r), !0), a.setBigInt64(32, BigInt(l), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), h.fill(0, l, l + 72), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const t = Number(a.getBigInt64(56, !0)), o = a.getUint32(64, !0);
			t >= 0 && new Uint8Array(e.memory.buffer).set(h.subarray(l, l + 72), s), this.completeChannelRaw(e, t, o), this.relistenChannel(e);
			return;
		}
		if (13 === o && 0 !== s) {
			const t = 1024;
			a.setUint32(4, lr, !0), a.setBigInt64(8, BigInt(i), !0), a.setBigInt64(16, BigInt(n), !0), a.setBigInt64(24, BigInt(r), !0), a.setBigInt64(32, BigInt(l), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), h.fill(0, l, l + t), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const o = Number(a.getBigInt64(56, !0)), d = a.getUint32(64, !0);
			o >= 0 && new Uint8Array(e.memory.buffer).set(h.subarray(l, l + t), s), this.completeChannelRaw(e, o, d), this.relistenChannel(e);
			return;
		}
		if (17 === o && 0 !== s) {
			const t = 1024, o = new Uint8Array(e.memory.buffer);
			h.set(o.subarray(s, s + t), l), a.setUint32(4, lr, !0), a.setBigInt64(8, BigInt(i), !0), a.setBigInt64(16, BigInt(n), !0), a.setBigInt64(24, BigInt(r), !0), a.setBigInt64(32, BigInt(l), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const d = Number(a.getBigInt64(56, !0)), f = a.getUint32(64, !0);
			this.completeChannelRaw(e, d, f), this.relistenChannel(e);
			return;
		}
		a.setUint32(4, lr, !0), a.setBigInt64(8, BigInt(i), !0), a.setBigInt64(16, BigInt(n), !0), a.setBigInt64(24, BigInt(r), !0), a.setBigInt64(32, BigInt(s), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			c(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const d = Number(a.getBigInt64(56, !0)), f = a.getUint32(64, !0);
		this.completeChannelRaw(e, d, f), this.relistenChannel(e);
	}
	runSyntheticMemorySyscall(e, t, i) {
		const n = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		n.setUint32(4, t, !0);
		for (let a = 0; a < 6; a++) n.setBigInt64(8 + 8 * a, BigInt(i[a] ?? 0), !0);
		const r = this.kernelInstance.exports.kernel_handle_channel, s = this.currentHandlePid;
		this.bindKernelTidForChannel(e), this.currentHandlePid = e.pid;
		try {
			r(this.toKernelPtr(this.scratchOffset), e.pid);
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
		const [i, n, r] = t, s = this.guestTidForChannel(e);
		this.validateKernelTid(e.pid, s), this.syncSysvShmSegmentFromMappedProcesses(i);
		const o = this.kernelInstance.exports.kernel_ipc_shmat_for_task, a = this.kernelInstance.exports.kernel_ipc_shmdt_for_process, c = o(e.pid, s, i, n, r);
		if (c < 0) return this.completeChannelRaw(e, c, -c), void this.relistenChannel(e);
		const h = c, l = !!(4096 & r), d = l ? 1 : 3;
		let f = null;
		const u = () => {
			if (null !== f) {
				try {
					this.runSyntheticMemorySyscall(e, An, [f, h]);
				} catch {}
				if (this.hostReaped?.has(e.pid)) return;
			}
			try {
				a(e.pid, i);
			} catch {}
		};
		try {
			const t = this.runSyntheticMemorySyscall(e, Mn, [
				n >>> 0,
				h,
				d,
				34,
				-1,
				0
			]);
			if (this.hostReaped?.has(e.pid)) return;
			if (t.retVal < 0) {
				if (u(), this.hostReaped?.has(e.pid)) return;
				const i = t.errVal || 12;
				this.completeChannelRaw(e, -i, i), this.relistenChannel(e);
				return;
			}
			if (f = t.retVal >>> 0, 0 !== n && f !== n >>> 0) {
				if (u(), this.hostReaped?.has(e.pid)) return;
				this.completeChannelRaw(e, -22, Wi), this.relistenChannel(e);
				return;
			}
			this.ensureProcessMemoryCovers(e.pid, e.memory, Mn, f, [
				n,
				h,
				d,
				34,
				-1,
				0
			]);
			const r = this.readSysvShmRange(i, 0, h), s = new Uint8Array(e.memory.buffer);
			if (!r || f + h > s.length) {
				if (u(), this.hostReaped?.has(e.pid)) return;
				this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			}
			s.set(r, f);
			let o = this.shmMappings.get(e.pid);
			o || (o = /* @__PURE__ */ new Map(), this.shmMappings.set(e.pid, o)), o.set(f, {
				segId: i,
				size: h,
				readOnly: l,
				snapshot: r,
				seenVersion: this.shmSegmentVersions.get(i) ?? 0
			});
		} catch (as) {
			if (console.error(`[handleIpcShmat] mmap failed for pid=${e.pid}:`, as), u(), this.hostReaped?.has(e.pid)) return;
			this.completeChannelRaw(e, -12, 12), this.relistenChannel(e);
			return;
		}
		this.completeChannelRaw(e, f, 0), this.relistenChannel(e);
	}
	handleIpcShmdt(e, t) {
		const i = this.guestTidForChannel(e);
		this.validateKernelTid(e.pid, i);
		const n = t[0] >>> 0, r = this.shmMappings.get(e.pid);
		if (!r) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const s = r.get(n);
		if (!s) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const o = new Uint8Array(e.memory.buffer);
		if (!this.mergeAndRefreshSysvShmMapping(o, n, s)) return this.completeChannelRaw(e, -5, 5), void this.relistenChannel(e);
		const a = (0, this.kernelInstance.exports.kernel_ipc_shmdt_for_task)(e.pid, i, s.segId);
		if (a < 0) this.completeChannelRaw(e, a, -a);
		else {
			r.delete(n), 0 === r.size && this.shmMappings.delete(e.pid);
			let t = !1;
			try {
				const i = this.runSyntheticMemorySyscall(e, An, [n, s.size]);
				if (this.hostReaped?.has(e.pid)) return;
				t = i.retVal < 0;
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
			const e = new DataView(this.kernelMemory.buffer, t), i = e.getUint32(0, !0), n = e.getUint32(4, !0);
			n > 0 && this.sendSignalToProcess(i, n);
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
	attachKmsCanvas(e, t, i, n) {
		this.kmsCanvases.set(e, t), i && this.kmsStatsViews.set(e, new Int32Array(i));
		const r = n?.mode ?? "auto";
		if ("2d" === r) {
			const i = t.getContext("2d");
			i && (this.kmsContexts.set(e, i), this.kmsContextMode.set(e, "2d"));
		} else "webgl2" === r && this.kmsContextMode.set(e, "webgl2");
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
		for (const [t, i] of this.kmsCanvases) {
			if ("2d" !== this.kmsContextMode.get(t)) continue;
			const e = this.kernel.kms.currentFb(t);
			if (!e) continue;
			const n = this.kernel.kms.scanoutBytes(t);
			if (!n) continue;
			const r = this.kmsContexts.get(t);
			if (!r) continue;
			i.width === e.width && i.height === e.height || (i.width = e.width, i.height = e.height);
			const s = performance.now(), o = e.width * e.height * 4;
			let a = this.kmsScratchBytes.get(t);
			a && a.byteLength === o || (a = new Uint8ClampedArray(new ArrayBuffer(o)), this.kmsScratchBytes.set(t, a)), a.set(n), r.putImageData(new ImageData(a, e.width, e.height), 0, 0);
			const c = 1e3 * (performance.now() - s) | 0, h = this.kmsStatsViews.get(t);
			h && (Atomics.add(h, 0, 1), Atomics.store(h, 1, 0 | performance.now()), Atomics.store(h, 4, c));
		}
		if (this.kmsStatsViews.size > 0) {
			const e = this.kernelInstance?.exports;
			for (const [t, i] of this.kmsStatsViews) {
				const n = this.kernel.kms.currentFb(t);
				if (n && (Atomics.store(i, 2, n.width), Atomics.store(i, 3, n.height)), i.length < 7) continue;
				const r = e?.kernel_kms_commit_count?.(t) ?? 0n, s = e?.kernel_kms_last_frame_us?.(t) ?? 0n;
				Atomics.store(i, 5, Number(2147483647n & r)), Atomics.store(i, 6, Number(2147483647n & s));
			}
		}
	}
};
var Cr = class {
	entryUrl;
	constructor(e) {
		this.entryUrl = e;
	}
	createWorker(e) {
		const t = new Worker(this.entryUrl, { type: "module" }), i = new _r(t);
		return t.postMessage(e), i;
	}
}, _r = class {
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
		if (this.worker.terminate(), !this.terminated) {
			this.terminated = !0;
			for (const e of this.handlers.get("exit") ?? []) e(0);
		}
		return 0;
	}
};
function Lr(e) {
	return Object.assign(/* @__PURE__ */ new Error(`ENOENT: ${e}`), { errno: 2 });
}
var Br = class extends Error {
	errno = 11;
	constructor() {
		super("EAGAIN");
	}
};
const Tr = 107, Fr = "0.0.0.0";
function Rr(e) {
	return `${e[0]}.${e[1]}.${e[2]}.${e[3]}`;
}
function Ur(e) {
	return new Uint8Array([
		e[0] ?? 0,
		e[1] ?? 0,
		e[2] ?? 0,
		e[3] ?? 0
	]);
}
function $r(e, t) {
	return e === Fr || e === t;
}
function Or(e, t) {
	return e === Fr || t === Fr || e === t;
}
var Nr = class {
	onRelease;
	recvBuf = new Uint8Array(0);
	peer;
	readClosed = !1;
	writeClosed = !1;
	orphanedReceive = !1;
	reset = !1;
	constructor(e) {
		this.onRelease = e;
	}
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
		if (this.writeClosed || !this.peer) {
			const e = /* @__PURE__ */ new Error("EPIPE");
			throw e.errno = 32, e;
		}
		if (this.peer.reset) {
			const e = /* @__PURE__ */ new Error("ECONNRESET");
			throw e.errno = 104, e;
		}
		if (this.peer.readClosed) {
			const e = /* @__PURE__ */ new Error("EPIPE");
			throw e.errno = 32, e;
		}
		return this.peer.orphanedReceive || this.peer.enqueue(e.slice()), e.length;
	}
	recv(e, t) {
		if (this.reset) {
			const e = /* @__PURE__ */ new Error("ECONNRESET");
			throw e.errno = 104, e;
		}
		if (this.recvBuf.length > 0) {
			const i = Math.min(e, this.recvBuf.length), n = this.recvBuf.slice(0, i);
			return 2 & t || (this.recvBuf = this.recvBuf.slice(i)), n;
		}
		if (!this.peer || this.peer.writeClosed) return new Uint8Array(0);
		throw new Br();
	}
	poll(e) {
		let t = 0;
		return this.reset && (t |= 8), 1 & e && ((this.recvBuf.length > 0 || !this.peer || this.peer.writeClosed || this.readClosed) && (t |= 1), this.peer && !this.peer.writeClosed || (t |= 16)), 4 & e && (this.writeClosed || !this.peer || this.peer.readClosed || this.peer.reset || (t |= 4)), t;
	}
	shutdown(e) {
		0 !== e && 2 !== e || (this.readClosed = !0, this.recvBuf = new Uint8Array(0)), 1 !== e && 2 !== e || (this.writeClosed = !0);
	}
	close() {
		this.writeClosed = !0, this.orphanedReceive = !0, this.recvBuf = new Uint8Array(0), this.releaseFromOwner();
	}
	abort() {
		this.readClosed = !0, this.writeClosed = !0, this.orphanedReceive = !1, this.reset = !0, this.recvBuf = new Uint8Array(0), this.releaseFromOwner(), this.peer?.resetPeer();
	}
	resetPeer() {
		this.reset = !0, this.recvBuf = new Uint8Array(0);
	}
	releaseFromOwner() {
		const e = this.onRelease;
		this.onRelease = void 0, e?.(this);
	}
}, Wr = class {
	machines = /* @__PURE__ */ new Map();
	addressOwners = /* @__PURE__ */ new Map();
	hostnames = /* @__PURE__ */ new Map();
	tcpListeners = [];
	udpEndpoints = [];
	tcpPeersByMachine = /* @__PURE__ */ new Map();
	attachMachine(e) {
		const t = Ur(e.address instanceof Uint8Array ? e.address : new Uint8Array(e.address)), i = Rr(t);
		if (this.addressOwners.has(i)) throw new Error(`address ${i} is already attached`);
		const n = new Dr(this, e.id, t);
		this.machines.set(e.id, n), this.addressOwners.set(i, e.id), this.hostnames.set(e.id, t);
		for (const r of e.hostnames ?? []) this.hostnames.set(r, t);
		return n;
	}
	detachMachine(e) {
		const t = this.machines.get(e);
		if (t) {
			this.addressOwners.delete(Rr(t.localAddress)), this.machines.delete(e);
			for (const [i, n] of this.hostnames) Rr(n) !== Rr(t.localAddress) && i !== e || this.hostnames.delete(i);
			this.tcpListeners = this.tcpListeners.filter((t) => t.machineId !== e), this.udpEndpoints = this.udpEndpoints.filter((t) => t.machineId !== e);
			for (const t of this.tcpPeersByMachine.get(e) ?? []) t.abort();
			this.tcpPeersByMachine.delete(e), t.resetAllConnections();
		}
	}
	resolve(e) {
		const t = function(e) {
			if (!/^[0-9.]+$/.test(e)) return null;
			if (!/^\d+(?:\.\d+){0,3}$/.test(e)) throw Lr(e);
			const t = e.split("."), i = 1 === t.length ? [32n] : 2 === t.length ? [8n, 24n] : 3 === t.length ? [
				8n,
				8n,
				16n
			] : [
				8n,
				8n,
				8n,
				8n
			];
			let n = 0n;
			for (let r = 0; r < t.length; r++) {
				const s = BigInt(t[r]), o = i[r];
				if (s > (1n << o) - 1n) throw Lr(e);
				n = n << o | s;
			}
			return new Uint8Array([
				Number(n >> 24n & 255n),
				Number(n >> 16n & 255n),
				Number(n >> 8n & 255n),
				Number(255n & n)
			]);
		}(e);
		if (t) return t;
		(function(e) {
			const t = e.endsWith(".") ? e.slice(0, -1) : e;
			if (0 === t.length || !/^[\x00-\x7f]+$/.test(t)) throw Lr(e);
			let i = 1;
			for (const n of t.split(".")) {
				if (0 === n.length || n.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(n)) throw Lr(e);
				i += 1 + n.length;
			}
			if (i > 255) throw Lr(e);
		})(e);
		const i = this.hostnames.get(e);
		return i ? Ur(i) : null;
	}
	listenTcp(e, t, i, n, r) {
		const s = Rr(i);
		if (!this.machineOwnsAddress(e, s)) return 99;
		for (const o of this.tcpListeners) if (o.machineId === e && o.port === n && Or(o.addrKey, s)) return 98;
		return this.closeTcpListener(t), this.tcpListeners.push({
			machineId: e,
			listenerId: t,
			addr: Ur(i),
			addrKey: s,
			port: n,
			target: r
		}), 0;
	}
	closeTcpListener(e) {
		this.tcpListeners = this.tcpListeners.filter((t) => t.listenerId !== e);
	}
	connectTcp(e, t, i) {
		const n = Rr(i.addr), r = this.addressOwners.get(n);
		if (!r) return {
			peer: new Nr(),
			status: 113
		};
		const s = this.tcpListeners.find((e) => e.machineId === r && e.port === i.port && $r(e.addrKey, n));
		if (!s) return {
			peer: new Nr(),
			status: 111
		};
		const o = this.createTcpPeer(e), a = this.createTcpPeer(r);
		o.pairWith(a), a.pairWith(o);
		const c = s.target.accept(a, {
			addr: Ur(i.addr),
			port: i.port
		}, {
			addr: Ur(t.addr),
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
	bindUdp(e, t, i, n, r) {
		const s = Rr(i);
		if (!this.machineOwnsAddress(e, s)) return 99;
		for (const o of this.udpEndpoints) if (o.machineId === e && o.port === n && Or(o.addrKey, s)) return 98;
		return this.unbindUdp(t), this.udpEndpoints.push({
			machineId: e,
			endpointId: t,
			addr: Ur(i),
			addrKey: s,
			port: n,
			target: r
		}), 0;
	}
	unbindUdp(e) {
		this.udpEndpoints = this.udpEndpoints.filter((t) => t.endpointId !== e);
	}
	sendDatagram(e) {
		const t = Rr(e.dstAddr), i = this.addressOwners.get(t);
		if (!i) return 113;
		const n = this.udpEndpoints.find((n) => n.machineId === i && n.port === e.dstPort && $r(n.addrKey, t));
		return n ? n.target.receive({
			srcAddr: Ur(e.srcAddr),
			srcPort: e.srcPort,
			dstAddr: Ur(e.dstAddr),
			dstPort: e.dstPort,
			data: e.data.slice()
		}) : 111;
	}
	machineOwnsAddress(e, t) {
		return t === Fr || this.addressOwners.get(t) === e;
	}
	trackTcpPeer(e, t) {
		let i = this.tcpPeersByMachine.get(e);
		i || (i = /* @__PURE__ */ new Set(), this.tcpPeersByMachine.set(e, i)), i.add(t);
	}
	createTcpPeer(e) {
		const t = new Nr((t) => {
			const i = this.tcpPeersByMachine.get(e);
			i?.delete(t), 0 === i?.size && this.tcpPeersByMachine.delete(e);
		});
		return this.trackTcpPeer(e, t), t;
	}
}, Dr = class {
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
		const n = this.allocateEphemeralPort(), r = this.network.connectTcp(this.machineId, {
			addr: this.localAddress,
			port: n
		}, {
			addr: Ur(t),
			port: i
		});
		0 === r.status ? (this.connections.set(e, r.peer), this.connectErrors.delete(e)) : this.connectErrors.set(e, r.status);
	}
	connectStatus(e) {
		const t = this.connectErrors.get(e);
		return void 0 !== t ? t : this.connections.has(e) ? 0 : Tr;
	}
	send(e, t, i) {
		const n = this.connections.get(e);
		if (!n) throw Object.assign(/* @__PURE__ */ new Error("ENOTCONN"), { errno: Tr });
		return n.send(t, i);
	}
	recv(e, t, i) {
		const n = this.connections.get(e);
		if (!n) throw Object.assign(/* @__PURE__ */ new Error("ENOTCONN"), { errno: Tr });
		return n.recv(t, i);
	}
	poll(e, t) {
		const i = this.connections.get(e);
		if (!i) throw Object.assign(/* @__PURE__ */ new Error("ENOTCONN"), { errno: Tr });
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
		for (const e of this.connections.values()) e.abort();
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
function Vr(e) {
	const t = /* @__PURE__ */ new Error(`EINVAL: pathconf name ${e} is not associated with this object`);
	throw t.code = "EINVAL", t;
}
function Kr(e, t, i) {
	switch (t) {
		case Rt: return null;
		case Ot: return 255;
		case Nt: return 4096;
		case Dt:
		case Vt: return 1;
		case Gt: return 32768 == (61440 & e.mode) ? 1 : Vr(t);
		case Ht:
		case qt:
		case Xt:
		case Zt:
		case Jt:
		case Yt:
		case Qt:
		case ei:
		case ti:
		case ni: return null;
		case ii: return i.supportsSymlinks ? 1 : null;
		case ri: return 255;
		case si: return i.timestampResolutionNs;
		case Wt: {
			const i = 61440 & e.mode;
			return 4096 === i || 16384 === i ? null : Vr(t);
		}
		case Ut:
		case $t:
		case Kt:
		case jt: return Vr(t);
		default: {
			const e = /* @__PURE__ */ new Error(`EINVAL: invalid pathconf name ${t}`);
			throw e.code = "EINVAL", e;
		}
	}
}
const Hr = {
	reader: () => 0,
	writer: (e, t) => t,
	mode: 8630
}, Gr = {
	reader: (e, t) => (e.fill(0, 0, t), t),
	writer: (e, t) => t,
	mode: 8630
}, qr = {
	reader: () => {
		throw new Error("ENXIO");
	},
	writer: () => {
		throw new Error("ENXIO");
	},
	mode: 8630
};
const jr = [
	"pts",
	"shm",
	"mqueue"
], Xr = [
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
function Zr(e) {
	return "/" === e || "" === e || "." === e;
}
var Jr = class {
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
		this.devices.set("null", Hr), this.devices.set("zero", Gr), this.devices.set("urandom", e), this.devices.set("random", e), this.devices.set("console", qr), this.devices.set("tty", qr), this.deviceNames = [...this.devices.keys()];
	}
	getDevice(e) {
		const t = e.startsWith("/") ? e.slice(1) : e, i = this.devices.get(t);
		if (!i) throw new Error("ENOENT");
		return i;
	}
	open(e, t, i) {
		const n = e.startsWith("/") ? e.slice(1) : e;
		if (Zr(e) || jr.includes(n)) {
			const e = this.nextHandle++;
			return this.handles.set(e, { device: null }), e;
		}
		const r = this.getDevice(e), s = this.nextHandle++;
		return this.handles.set(s, { device: r }), s;
	}
	close(e) {
		if (!this.handles.delete(e)) throw new Error("EBADF");
		return 0;
	}
	read(e, t, i, n) {
		const r = this.handles.get(e);
		if (!r) throw new Error("EBADF");
		if (!r.device) throw new Error("EISDIR");
		return r.device.reader(t, Math.min(n, t.length));
	}
	write(e, t, i, n) {
		const r = this.handles.get(e);
		if (!r) throw new Error("EBADF");
		if (!r.device) throw new Error("EISDIR");
		return r.device.writer(t, Math.min(n, t.length));
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
	fpathconf(e, t) {
		return Kr(this.fstat(e), t, {
			supportsSymlinks: !1,
			timestampResolutionNs: null
		});
	}
	ftruncate(e, t) {}
	fsync(e) {}
	fchmod(e, t) {}
	fchown(e, t, i) {}
	stat(e) {
		const t = Date.now();
		if (Zr(e)) return {
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
		return jr.includes(i) ? {
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
		return t.files = this.devices.size + jr.length + Xr.length, t;
	}
	pathconf(e, t) {
		return Kr(this.stat(e), t, {
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
	chown(e, t, i) {}
	lchown(e, t, i) {}
	access(e, t) {
		this.stat(e);
	}
	utimensat(e, t, i, n, r) {}
	dirHandles = /* @__PURE__ */ new Map();
	nextDirHandle = 1;
	opendir(e) {
		const t = e.startsWith("/") ? e.slice(1) : e;
		let i;
		if (Zr(e)) i = [...this.deviceNames.map((e, t) => ({
			name: e,
			type: 2,
			ino: t + 1
		})), ...Xr.filter((e) => !this.devices.has(e.name))];
		else {
			if (!jr.includes(t)) throw new Error("ENOTDIR");
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
}, Yr = ArrayBuffer, Qr = Uint8Array, es = Uint16Array, ts = Int16Array, is = Int32Array, ns = function(e, t, i) {
	if (Qr.prototype.slice) return Qr.prototype.slice.call(e, t, i);
	(null == t || t < 0) && (t = 0), (null == i || i > e.length) && (i = e.length);
	var n = new Qr(i - t);
	return n.set(e.subarray(t, i)), n;
}, rs = function(e, t, i, n) {
	if (Qr.prototype.fill) return Qr.prototype.fill.call(e, t, i, n);
	for ((null == i || i < 0) && (i = 0), (null == n || n > e.length) && (n = e.length); i < n; ++i) e[i] = t;
	return e;
}, ss = function(e, t, i, n) {
	if (Qr.prototype.copyWithin) return Qr.prototype.copyWithin.call(e, t, i, n);
	for ((null == i || i < 0) && (i = 0), (null == n || n > e.length) && (n = e.length); i < n;) e[t++] = e[i++];
}, os = [
	"invalid zstd data",
	"window size too large (>2046MB)",
	"invalid block type",
	"FSE accuracy too high",
	"match distance too far back",
	"unexpected EOF"
], as = function(e, t, i) {
	var n = new Error(t || os[e]);
	if (n.code = e, Error.captureStackTrace && Error.captureStackTrace(n, as), !i) throw n;
	return n;
}, cs = function(e, t, i) {
	for (var n = 0, r = 0; n < i; ++n) r |= e[t++] << (n << 3);
	return r;
}, hs = function(e, t) {
	var i, n, r = e[0] | e[1] << 8 | e[2] << 16;
	if (3126568 == r && 253 == e[3]) {
		var s = e[4], o = s >> 5 & 1, a = s >> 2 & 1, c = 3 & s, h = s >> 6;
		8 & s && as(0);
		var l = 6 - o, d = 3 == c ? 4 : c, f = cs(e, l, d), u = h ? 1 << h : o, p = cs(e, l += d, u) + (1 == h && 256), g = p;
		if (!o) {
			var m = 1 << 10 + (e[5] >> 3);
			g = m + (m >> 3) * (7 & e[5]);
		}
		g > 2145386496 && as(1);
		var y = new Qr((1 == t ? p || g : t ? 0 : g) + 12);
		return y[0] = 1, y[4] = 4, y[8] = 8, {
			b: l + u,
			y: 0,
			l: 0,
			d: f,
			w: t && 1 != t ? t : y.subarray(12),
			e: g,
			o: new is(y.buffer, 0, 3),
			u: p,
			c: a,
			m: Math.min(131072, g)
		};
	}
	if (25481893 == (r >> 4 | e[3] << 20)) return (((i = e)[n = 4] | i[n + 1] << 8 | i[n + 2] << 16 | i[n + 3] << 24) >>> 0) + 8;
	as(0);
}, ls = function(e) {
	for (var t = 0; 1 << t <= e; ++t);
	return t - 1;
}, ds = function(e, t, i) {
	var n = 4 + (t << 3), r = 5 + (15 & e[t]);
	r > i && as(3);
	for (var s = 1 << r, o = s, a = -1, c = -1, h = -1, l = s, d = new Yr(512 + (s << 2)), f = new ts(d, 0, 256), u = new es(d, 0, 256), p = new es(d, 512, s), g = 512 + (s << 1), m = new Qr(d, g, s), y = new Qr(d, g + s); a < 255 && o > 0;) {
		var w = ls(o + 1), b = n >> 3, k = (1 << w + 1) - 1, v = (e[b] | e[b + 1] << 8 | e[b + 2] << 16) >> (7 & n) & k, S = (1 << w) - 1, P = k - o - 1, I = v & S;
		if (I < P ? (n += w, v = I) : (n += w + 1, v > S && (v -= P)), f[++a] = --v, -1 == v ? (o += v, m[--l] = a) : o -= v, !v) do {
			var z = n >> 3;
			c = (e[z] | e[z + 1] << 8) >> (7 & n) & 3, n += 2, a += c;
		} while (3 == c);
	}
	(a > 255 || o) && as(0);
	for (var x = 0, E = (s >> 1) + (s >> 3) + 3, M = s - 1, A = 0; A <= a; ++A) {
		var C = f[A];
		if (C < 1) u[A] = -C;
		else for (h = 0; h < C; ++h) {
			m[x] = A;
			do
				x = x + E & M;
			while (x >= l);
		}
	}
	for (x && as(0), h = 0; h < s; ++h) {
		var _ = u[m[h]]++;
		p[h] = (_ << (y[h] = r - ls(_))) - s;
	}
	return [n + 7 >> 3, {
		b: r,
		s: m,
		n: y,
		t: p
	}];
}, fs = ds(new Qr([
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
]), 0, 6)[1], us = ds(new Qr([
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
]), 0, 6)[1], ps = ds(new Qr([
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
]), 0, 5)[1], gs = function(e, t) {
	for (var i = e.length, n = new is(i), r = 0; r < i; ++r) n[r] = t, t += 1 << e[r];
	return n;
}, ms = new Qr(new is([
	0,
	0,
	0,
	0,
	16843009,
	50528770,
	134678020,
	202050057,
	269422093
]).buffer, 0, 36), ys = gs(ms, 0), ws = new Qr(new is([
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
]).buffer, 0, 53), bs = gs(ws, 3), ks = function(e, t, i) {
	var n = e.length, r = t.length, s = e[n - 1], o = (1 << i.b) - 1, a = -i.b;
	s || as(0);
	for (var c = 0, h = i.b, l = (n << 3) - 8 + ls(s) - h, d = -1; l > a && d < r;) {
		var f = l >> 3;
		c = (c << h | (e[f] | e[f + 1] << 8 | e[f + 2] << 16) >> (7 & l)) & o, t[++d] = i.s[c], l -= h = i.n[c];
	}
	l == a && d + 1 == r || as(0);
}, vs = function(e, t, i) {
	var n = 6, r = t.length + 3 >> 2, s = r << 1, o = r + s;
	ks(e.subarray(n, n += e[0] | e[1] << 8), t.subarray(0, r), i), ks(e.subarray(n, n += e[2] | e[3] << 8), t.subarray(r, s), i), ks(e.subarray(n, n += e[4] | e[5] << 8), t.subarray(s, o), i), ks(e.subarray(n), t.subarray(o), i);
}, Ss = function(e, t, i) {
	var n, r = t.b, s = e[r], o = s >> 1 & 3;
	t.l = 1 & s;
	var a = s >> 3 | e[r + 1] << 5 | e[r + 2] << 13, c = (r += 3) + a;
	if (1 == o) {
		if (r >= e.length) return;
		return t.b = r + 1, i ? (rs(i, e[r], t.y, t.y += a), i) : rs(new Qr(a), e[r]);
	}
	if (!(c > e.length)) {
		if (0 == o) return t.b = c, i ? (i.set(e.subarray(r, c), t.y), t.y += a, i) : ns(e, r, c);
		if (2 == o) {
			var h = e[r], l = 3 & h, d = h >> 2 & 3, f = h >> 4, u = 0, p = 0;
			l < 2 ? 1 & d ? f |= e[++r] << 4 | (2 & d && e[++r] << 12) : f = h >> 3 : (p = d, d < 2 ? (f |= (63 & e[++r]) << 4, u = e[r] >> 6 | e[++r] << 2) : 2 == d ? (f |= e[++r] << 4 | (3 & e[++r]) << 12, u = e[r] >> 2 | e[++r] << 6) : (f |= e[++r] << 4 | (63 & e[++r]) << 12, u = e[r] >> 6 | e[++r] << 2 | e[++r] << 10)), ++r;
			var g = i ? i.subarray(t.y, t.y + t.m) : new Qr(t.m), m = g.length - f;
			if (0 == l) g.set(e.subarray(r, r += f), m);
			else if (1 == l) rs(g, e[r++], m);
			else {
				var y = t.h;
				if (2 == l) {
					var w = function(e, t) {
						var i = 0, n = -1, r = new Qr(292), s = e[t], o = r.subarray(0, 256), a = r.subarray(256, 268), c = new es(r.buffer, 268);
						if (s < 128) {
							var h = ds(e, t + 1, 6), l = h[0], d = h[1], f = l << 3, u = e[t += s];
							u || as(0);
							for (var p = 0, g = 0, m = d.b, y = m, w = (++t << 3) - 8 + ls(u); !((w -= m) < f);) {
								var b = w >> 3;
								if (p += (e[b] | e[b + 1] << 8) >> (7 & w) & (1 << m) - 1, o[++n] = d.s[p], (w -= y) < f) break;
								g += (e[b = w >> 3] | e[b + 1] << 8) >> (7 & w) & (1 << y) - 1, o[++n] = d.s[g], m = d.n[p], p = d.t[p], y = d.n[g], g = d.t[g];
							}
							++n > 255 && as(0);
						} else {
							for (n = s - 127; i < n; i += 2) {
								var k = e[++t];
								o[i] = k >> 4, o[i + 1] = 15 & k;
							}
							++t;
						}
						var v = 0;
						for (i = 0; i < n; ++i) (z = o[i]) > 11 && as(0), v += z && 1 << z - 1;
						var S = ls(v) + 1, P = 1 << S, I = P - v;
						for (I & I - 1 && as(0), o[n++] = ls(I) + 1, i = 0; i < n; ++i) {
							var z = o[i];
							++a[o[i] = z && S + 1 - z];
						}
						var x = new Qr(P << 1), E = x.subarray(0, P), M = x.subarray(P);
						for (c[S] = 0, i = S; i > 0; --i) {
							var A = c[i];
							rs(M, i, A, c[i - 1] = A + a[i] * (1 << S - i));
						}
						for (c[0] != P && as(0), i = 0; i < n; ++i) {
							var C = o[i];
							if (C) {
								var _ = c[C];
								rs(E, i, _, c[C] = _ + (1 << S - C));
							}
						}
						return [t, {
							n: M,
							b: S,
							s: E
						}];
					}(e, r);
					u += r - (r = w[0]), t.h = y = w[1];
				} else y || as(0);
				(p ? vs : ks)(e.subarray(r, r += u), g.subarray(m), y);
			}
			var b = e[r++];
			if (b) {
				255 == b ? b = 32512 + (e[r++] | e[r++] << 8) : b > 127 && (b = b - 128 << 8 | e[r++]);
				var k = e[r++];
				3 & k && as(0);
				for (var v = [
					us,
					ps,
					fs
				], S = 2; S > -1; --S) {
					var P = k >> 2 + (S << 1) & 3;
					if (1 == P) {
						var I = new Qr([
							0,
							0,
							e[r++]
						]);
						v[S] = {
							s: I.subarray(2, 3),
							n: I.subarray(0, 1),
							t: new es(I.buffer, 0, 1),
							b: 0
						};
					} else 2 == P ? (r = (n = ds(e, r, 9 - (1 & S)))[0], v[S] = n[1]) : 3 == P && (t.t || as(0), v[S] = t.t[S]);
				}
				var z = t.t = v, x = z[0], E = z[1], M = z[2], A = e[c - 1];
				A || as(0);
				var C = (c << 3) - 8 + ls(A) - M.b, _ = C >> 3, L = 0, B = (e[_] | e[_ + 1] << 8) >> (7 & C) & (1 << M.b) - 1, T = (e[_ = (C -= E.b) >> 3] | e[_ + 1] << 8) >> (7 & C) & (1 << E.b) - 1, F = (e[_ = (C -= x.b) >> 3] | e[_ + 1] << 8) >> (7 & C) & (1 << x.b) - 1;
				for (++b; --b;) {
					var R = M.s[B], U = M.n[B], $ = x.s[F], O = x.n[F], N = E.s[T], W = E.n[T], D = 1 << N, V = D + ((e[_ = (C -= N) >> 3] | e[_ + 1] << 8 | e[_ + 2] << 16 | e[_ + 3] << 24) >>> (7 & C) & D - 1);
					_ = (C -= ws[$]) >> 3;
					var K = bs[$] + ((e[_] | e[_ + 1] << 8 | e[_ + 2] << 16) >> (7 & C) & (1 << ws[$]) - 1);
					_ = (C -= ms[R]) >> 3;
					var H = ys[R] + ((e[_] | e[_ + 1] << 8 | e[_ + 2] << 16) >> (7 & C) & (1 << ms[R]) - 1);
					if (_ = (C -= U) >> 3, B = M.t[B] + ((e[_] | e[_ + 1] << 8) >> (7 & C) & (1 << U) - 1), _ = (C -= O) >> 3, F = x.t[F] + ((e[_] | e[_ + 1] << 8) >> (7 & C) & (1 << O) - 1), _ = (C -= W) >> 3, T = E.t[T] + ((e[_] | e[_ + 1] << 8) >> (7 & C) & (1 << W) - 1), V > 3) t.o[2] = t.o[1], t.o[1] = t.o[0], t.o[0] = V -= 3;
					else {
						var G = V - (0 != H);
						G ? (V = 3 == G ? t.o[0] - 1 : t.o[G], G > 1 && (t.o[2] = t.o[1]), t.o[1] = t.o[0], t.o[0] = V) : V = t.o[0];
					}
					for (S = 0; S < H; ++S) g[L + S] = g[m + S];
					m += H;
					var q = (L += H) - V;
					if (q < 0) {
						var j = -q, X = t.e + q;
						j > K && (j = K);
						for (S = 0; S < j; ++S) g[L + S] = t.w[X + S];
						L += j, K -= j, q = 0;
					}
					for (S = 0; S < K; ++S) g[L + S] = g[q + S];
					L += K;
				}
				if (L != m) for (; m < g.length;) g[L++] = g[m++];
				else L = g.length;
				i ? t.y += L : g = ns(g, 0, L);
			} else if (i) {
				if (t.y += f, m) for (S = 0; S < f; ++S) g[S] = g[m + S];
			} else m && (g = ns(g, m));
			return t.b = c, g;
		}
		as(2);
	}
};
function Ps(e, t) {
	for (var i = [], n = +!t, r = 0, s = 0; e.length;) {
		var o = hs(e, n || t);
		if ("object" == typeof o) {
			for (n ? (t = null, o.w.length == o.u && (i.push(t = o.w), s += o.u)) : (i.push(t), o.e = 0); !o.l;) {
				var a = Ss(e, o, t);
				a || as(5), t ? o.e = o.y : (i.push(a), s += a.length, ss(o.w, 0, a.length), o.w.set(a, o.w.length - a.length));
			}
			r = o.b + 4 * o.c;
		} else r = o;
		e = e.subarray(r);
	}
	return function(e, t) {
		if (1 == e.length) return e[0];
		for (var i = new Qr(t), n = 0, r = 0; n < e.length; ++n) {
			var s = e[n];
			i.set(s, r), r += s.length;
		}
		return i;
	}(i, s);
}
const Is = 4096, zs = 1024, xs = Math.floor(160), Es = 61440, Ms = 4294967295, As = 12, Cs = 16, _s = 28, Ls = 12, Bs = 16, Ts = 24, Fs = 32, Rs = 48, Us = 92, $s = 100, Os = 104, Ns = 112, Ws = 120, Ds = -2147483648, Vs = 4299202560, Ks = {
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
var Hs = class extends Error {
	code;
	constructor(e, t) {
		super(t || Ks[e] || `Error ${e}`), this.code = e, this.name = "SFSError";
	}
};
const Gs = new TextEncoder(), qs = new TextDecoder(), js = Gs.encode("..");
function Xs(e) {
	return "." === e || ".." === e;
}
function Zs(e) {
	return e.buffer instanceof SharedArrayBuffer ? qs.decode(new Uint8Array(e)) : qs.decode(e);
}
function Js(e) {
	return e + 3 & -4;
}
var Ys = class e {
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
	static mkfs(t, i) {
		const n = t.byteLength;
		if (n < 65536) throw new Hs(-22);
		let r = Math.floor(n / Is);
		const s = i ? Math.floor(i / Is) : 4 * r;
		let o = Math.floor(s / 4);
		o < 32 && (o = 32), o = 32 * Math.ceil(o / 32);
		const a = Math.ceil(o / 32768), c = Math.ceil(s / 32768), h = Math.ceil(128 * o / Is), l = 1 + a, d = l + c, f = d + h;
		if (f >= r) {
			const e = (f + 1) * Is;
			try {
				t.grow(e);
			} catch {
				throw new Hs(-28);
			}
			if (r = Math.floor(t.byteLength / Is), f >= r) throw new Hs(-28);
		}
		new Uint8Array(t).fill(0);
		const u = new e(t);
		u.w32(0, 1397114451), u.w32(4, 1), u.w32(8, Is), u.w32(As, r), u.w32(Cs, o), u.w32(_s, 1), u.w32(32, l), u.w32(36, d), u.w32(40, f), u.w32(44, a), u.w32(48, c), u.w32(52, h), u.w32(68, s), u.w32(72, 256);
		const p = l * Is;
		for (let e = 0; e < f; e++) {
			const t = (p >> 2) + (e >> 5);
			u.i32[t] |= 1 << (31 & e);
		}
		const g = r - f;
		Atomics.store(u.i32, 5, g), u.blockAllocHint = f, u.i32[1024] |= 3, Atomics.store(u.i32, 6, o - 2), u.inodeAllocHint = 2;
		const m = u.inodeOffset(1);
		u.w32(m + 8, 16877), u.w32(m + Ls, 2), u.w64(m + Os, 1);
		const y = u.blockAlloc();
		if (y < 0) throw new Hs(-28);
		u.w32(m + Rs, y);
		const w = y * Is, b = Js(9), k = Js(10);
		u.w32(w, 1), u.view.setUint16(w + 4, b, !0), u.view.setUint16(w + 6, 1, !0), u.u8[w + 8] = 46;
		const v = w + b;
		return u.w32(v, 1), u.view.setUint16(v + 4, k, !0), u.view.setUint16(v + 6, 2, !0), u.u8[v + 8] = 46, u.u8[v + 8 + 1] = 46, u.w64(m + Bs, b + k), Atomics.store(u.i32, 14, 1), u;
	}
	static inspectImageCapacity(e) {
		if (e.byteLength < 72) throw new Hs(-22, "SharedFS image is too small");
		const t = new DataView(e.buffer, e.byteOffset, e.byteLength);
		if (1397114451 !== t.getUint32(0, !0)) throw new Hs(-22, "Bad magic");
		if (1 !== t.getUint32(4, !0)) throw new Hs(-22, "Bad version");
		const i = t.getUint32(8, !0);
		if (4096 !== i) throw new Hs(-22, "Bad block size");
		const n = t.getUint32(68, !0) * i;
		return {
			byteLength: e.byteLength,
			maxByteLength: Math.max(e.byteLength, n)
		};
	}
	static mount(t, i) {
		const n = new e(t);
		if (1397114451 !== n.r32(0)) throw new Hs(-22, "Bad magic");
		if (1 !== n.r32(4)) throw new Hs(-22, "Bad version");
		if (4096 !== n.r32(8)) throw new Hs(-22, "Bad block size");
		return i?.restoreImage && n.resetRestoredRuntimeState(), n.resetAllocationHints(), n;
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
		if (void 0 !== t && (!Number.isSafeInteger(t) || t < 0)) throw new Hs(-22, "Snapshot timestamp must be a non-negative safe integer in milliseconds");
		const i = void 0 === t ? void 0 : BigInt(t);
		for (let o = 0; o < xs; o++) {
			const e = 256 + 24 * o;
			if (0 !== Atomics.load(this.i32, e >> 2)) throw new Hs(-16, "Cannot save a VFS image with open descriptors");
		}
		const n = this.r32(Cs);
		for (let o = 0; o < n; o++) {
			const e = this.inodeOffset(o);
			if (0 !== this.r32(e + Ns)) throw new Hs(-16, "Cannot save a VFS image with open inode references");
		}
		const r = new Uint8Array(this.buffer.byteLength);
		r.set(this.u8);
		const s = new DataView(r.buffer);
		s.setUint32(60, 0, !0), s.setUint32(64, 0, !0), r.fill(0, 256, Is);
		for (let o = 0; o < n; o++) {
			const e = this.inodeOffset(o);
			if (s.setUint32(e + 0, 0, !0), s.setUint32(e + Ns, 0, !0), void 0 !== i) {
				const t = o >= 1 && this.inodeIsAllocated(o) ? i : 0n;
				s.setBigUint64(e + 40, t, !0), s.setBigUint64(e + Ts, t, !0), s.setBigUint64(e + Fs, t, !0);
			}
		}
		return r;
	}
	collectIdentityStateUnlocked() {
		const e = /* @__PURE__ */ new Map(), t = this.inodeOffset(1), i = this.r64(t + Os);
		e.set(`1:${i}`, {
			ino: 1,
			generation: i,
			dataSequence: Atomics.load(this.i32, t + Ws >> 2) >>> 0,
			mode: this.r32(t + 8),
			linkCount: this.r32(t + Ls),
			size: this.r64(t + Bs),
			uid: this.r32(t + 96),
			gid: this.r32(t + $s),
			paths: ["/"]
		});
		const n = [{
			ino: 1,
			path: "/"
		}], r = /* @__PURE__ */ new Set();
		for (; n.length > 0;) {
			const t = n.pop();
			if (r.has(t.ino)) throw new Hs(-5);
			r.add(t.ino);
			const i = this.inodeOffset(t.ino);
			if (16384 != (61440 & this.r32(i + 8))) throw new Hs(-5);
			const s = this.r64(i + Bs);
			let o = 0;
			for (; o < s;) {
				const i = Math.floor(o / Is), r = o % Is, a = this.inodeBlockMap(t.ino, i, !1);
				if (a <= 0) throw new Hs(-5);
				const c = a * Is, h = Math.min(s - o, Is - r);
				let l = r;
				for (; l < r + h;) {
					const i = c + l, s = this.r32(i), o = this.view.getUint16(i + 4, !0), a = this.view.getUint16(i + 6, !0);
					if (!this.isValidDirEntry(l, r + h, o, a)) throw new Hs(-5);
					if (0 !== s) {
						if (!this.inodeIsAllocated(s)) throw new Hs(-5);
						const r = Zs(this.u8.subarray(i + 8, i + 8 + a));
						if ("." !== r && ".." !== r) {
							const i = "/" === t.path ? `/${r}` : `${t.path}/${r}`, o = this.inodeOffset(s), a = this.r64(o + Os), c = `${s}:${a}`;
							let h = e.get(c);
							if (!h) {
								const t = this.r32(o + 8);
								h = {
									ino: s,
									generation: a,
									dataSequence: Atomics.load(this.i32, o + Ws >> 2) >>> 0,
									mode: t,
									linkCount: this.r32(o + Ls),
									size: this.r64(o + Bs),
									uid: this.r32(o + 96),
									gid: this.r32(o + $s),
									...40960 == (61440 & t) ? { symlinkTarget: this.readSymlinkInodeUnlocked(s) } : {},
									paths: []
								}, e.set(c, h);
							}
							h.paths.push(i), 16384 == (61440 & this.r32(o + 8)) && n.push({
								ino: s,
								path: i
							});
						}
					}
					l += o;
				}
				o += h;
			}
		}
		return e;
	}
	statfs() {
		const e = this.r32(8), t = this.r32(As), i = this.r32(68), n = "number" == typeof this.buffer.maxByteLength ? this.buffer.maxByteLength : this.buffer.byteLength, r = Math.floor(n / e), s = Math.max(t, Math.min(i, r));
		return {
			blockSize: e,
			totalBlocks: s,
			freeBlocks: Atomics.load(this.i32, 5) + Math.max(0, s - t),
			totalInodes: this.r32(Cs),
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
		} catch (i) {
			if (!(i instanceof TypeError)) throw i;
			this.atomicsWaitAllowed = !1;
		}
		for (; Atomics.load(this.i32, e) === t;);
	}
	resetAllocationHints() {
		this.blockAllocHint = this.findNextFreeBlockHint(), this.inodeAllocHint = this.findNextFreeInodeHint();
	}
	findNextFreeBlockHint() {
		const e = this.r32(As), t = this.r32(40), i = this.r32(32) * Is;
		for (let n = t; n < e; n++) {
			const e = (i >> 2) + (n >> 5), t = 31 & n;
			if (!(Atomics.load(this.i32, e) & 1 << t)) return n;
		}
		return t;
	}
	findNextFreeInodeHint() {
		const e = this.r32(Cs), t = this.r32(_s) * Is;
		for (let i = 2; i < e; i++) {
			const e = (t >> 2) + (i >> 5), n = 31 & i;
			if (!(Atomics.load(this.i32, e) & 1 << n)) return i;
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
		Atomics.store(this.i32, 15, 0), Atomics.store(this.i32, 16, 0), this.u8.fill(0, 256, Is);
		const e = this.r32(Cs), t = this.r32(_s) * Is;
		for (let i = 0; i < e; i++) {
			const e = this.inodeOffset(i);
			if (this.w32(e + 0, 0), this.w32(e + Ns, 0), i < 2) continue;
			if (!(this.r32(t + 4 * (i >> 5)) & 1 << (31 & i))) continue;
			if (0 !== this.r32(e + Ls)) continue;
			const n = this.r32(e + 8), r = this.r64(e + Bs);
			40960 == (61440 & n) && r <= 40 ? (this.u8.fill(0, e + Rs, e + Rs + 40), this.w64(e + Bs, 0)) : this.inodeTruncate(i, 0), this.inodeFree(i);
		}
	}
	blockAlloc() {
		const e = this.r32(As), t = this.r32(32) * Is, i = this.r32(40), n = this.blockAllocHint >= i && this.blockAllocHint < e ? this.blockAllocHint : i, r = e - i;
		for (let s = 0; s < r; s++) {
			const o = i + (n - i + s) % r, a = (t >> 2) + (o >> 5), c = 31 & o, h = Atomics.load(this.i32, a);
			if (h & 1 << c) continue;
			const l = h | 1 << c;
			if (Atomics.compareExchange(this.i32, a, h, l) === h) {
				Atomics.sub(this.i32, 5, 1), this.blockAllocHint = o + 1 < e ? o + 1 : i;
				const t = o * Is;
				return this.u8.fill(0, t, t + Is), o;
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
		const t = (this.r32(32) * Is >> 2) + (e >> 5), i = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t), n = e & ~(1 << i);
			if (Atomics.compareExchange(this.i32, t, e, n) === e) break;
		}
		Atomics.add(this.i32, 5, 1), e >= this.r32(40) && e < this.blockAllocHint && (this.blockAllocHint = e);
	}
	grow() {
		this.sbLock();
		try {
			if (Atomics.load(this.i32, 5) > 0) return 0;
			const e = this.r32(As), t = this.r32(68);
			let i = this.r32(72), n = e + i;
			if (n > t && (n = t, i = n - e, 0 === i)) return -28;
			const r = n * Is;
			if (this.buffer.byteLength < r) try {
				this.buffer.grow(r), this.view = new DataView(this.buffer), this.i32 = new Int32Array(this.buffer), this.u8 = new Uint8Array(this.buffer);
			} catch {
				return -28;
			}
			return this.w32(As, n), Atomics.add(this.i32, 5, i), Atomics.add(this.i32, 14, 1), this.blockAllocHint = e, 0;
		} finally {
			this.sbUnlock();
		}
	}
	inodeOffset(e) {
		return (this.r32(36) + Math.floor(e / 32)) * Is + e % 32 * 128;
	}
	inodeAlloc() {
		const e = this.r32(Cs), t = this.r32(_s) * Is, i = this.inodeAllocHint >= 2 && this.inodeAllocHint < e ? this.inodeAllocHint : 2, n = e - 2;
		for (let r = 0; r < n; r++) {
			const s = 2 + (i - 2 + r) % n, o = (t >> 2) + (s >> 5), a = 31 & s, c = Atomics.load(this.i32, o);
			if (c & 1 << a) continue;
			const h = c | 1 << a;
			if (Atomics.compareExchange(this.i32, o, c, h) === c) {
				Atomics.sub(this.i32, 6, 1), this.inodeAllocHint = s + 1 < e ? s + 1 : 2;
				const t = this.inodeOffset(s);
				return this.u8.fill(0, t, t + 128), this.w64(t + Os, this.nextInodeGeneration()), s;
			}
			r--;
		}
		return -28;
	}
	nextInodeGeneration() {
		return Atomics.add(this.i32, 14, 1) + 1;
	}
	inodeFree(e) {
		const t = (this.r32(_s) * Is >> 2) + (e >> 5), i = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t);
			if (!(e & 1 << i)) throw new Hs(-5);
			const n = e & ~(1 << i);
			if (Atomics.compareExchange(this.i32, t, e, n) === e) break;
		}
		Atomics.add(this.i32, 6, 1), e >= 2 && e < this.inodeAllocHint && (this.inodeAllocHint = e);
	}
	inodeAddOpenRef(e) {
		this.inodeWriteLock(e);
		try {
			const t = this.inodeOffset(e);
			return 0 !== this.r32(t + Ls) && (this.w32(t + Ns, this.r32(t + Ns) + 1), !0);
		} finally {
			this.inodeWriteUnlock(e);
		}
	}
	inodeDropOpenRef(e) {
		let t = !1;
		this.inodeWriteLock(e);
		try {
			const i = this.inodeOffset(e), n = this.r32(i + Ns);
			n > 0 && this.w32(i + Ns, n - 1), n <= 1 && 0 === this.r32(i + Ls) && (this.inodeTruncate(e, 0), t = !0);
		} finally {
			this.inodeWriteUnlock(e);
		}
		t && this.inodeFree(e);
	}
	inodeDropLinkRefLocked(e) {
		const t = this.inodeOffset(e), i = this.r32(t + Ls);
		return i > 1 ? (this.w32(t + Ls, i - 1), this.w64(t + Fs, Date.now()), !1) : this.inodeOrphanLocked(e);
	}
	inodeOrphanLocked(e) {
		const t = this.inodeOffset(e);
		if (this.w32(t + Ls, 0), this.w64(t + Fs, Date.now()), this.r32(t + Ns) > 0) return !1;
		const i = this.r32(t + 8), n = this.r64(t + Bs);
		return 40960 == (61440 & i) && n <= 40 ? (this.u8.fill(0, t + Rs, t + Rs + 40), this.w64(t + Bs, 0)) : this.inodeTruncate(e, 0), !0;
	}
	inodeReadLock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		for (;;) {
			const e = Atomics.load(this.i32, t);
			if (e & Ds) this.waitForAtomicChange(t, e);
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
				if (0 === Atomics.compareExchange(this.i32, t, 0, Ds)) return;
			} else this.waitForAtomicChange(t, e);
		}
	}
	inodeWriteUnlock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		Atomics.store(this.i32, t, 0), Atomics.notify(this.i32, t, Infinity);
	}
	inodeBlockMap(e, t, i) {
		const n = this.inodeOffset(e);
		if (t < 10) {
			const e = this.r32(n + Rs + 4 * t);
			if (0 !== e) return e;
			if (!i) return 0;
			const r = this.blockAllocWithGrow();
			return r < 0 || this.w32(n + Rs + 4 * t, r), r;
		}
		if ((t -= 10) < 1024) {
			let e = this.r32(n + 88), r = !1;
			if (0 === e) {
				if (!i) return 0;
				if (e = this.blockAllocWithGrow(), e < 0) return e;
				this.w32(n + 88, e), r = !0;
			}
			const s = e * Is + 4 * t, o = this.r32(s);
			if (0 !== o) return o;
			if (!i) return 0;
			const a = this.blockAllocWithGrow();
			return a < 0 ? (r && (this.w32(n + 88, 0), this.blockFree(e)), a) : (this.w32(s, a), a);
		}
		if ((t -= zs) < 1048576) {
			const e = Math.floor(t / zs), r = t % zs;
			let s = this.r32(n + Us), o = !1;
			if (0 === s) {
				if (!i) return 0;
				if (s = this.blockAllocWithGrow(), s < 0) return s;
				this.w32(n + Us, s), o = !0;
			}
			const a = s * Is + 4 * e;
			let c = this.r32(a), h = !1;
			if (0 === c) {
				if (!i) return 0;
				if (c = this.blockAllocWithGrow(), c < 0) return o && (this.w32(n + Us, 0), this.blockFree(s)), c;
				this.w32(a, c), h = !0;
			}
			const l = c * Is + 4 * r, d = this.r32(l);
			if (0 !== d) return d;
			if (!i) return 0;
			const f = this.blockAllocWithGrow();
			return f < 0 ? (h && (this.w32(a, 0), this.blockFree(c)), o && (this.w32(n + Us, 0), this.blockFree(s)), f) : (this.w32(l, f), f);
		}
		return -22;
	}
	inodeReadData(e, t, i, n) {
		const r = this.inodeOffset(e), s = this.r64(r + Bs);
		if (t >= s) return 0;
		t + n > s && (n = s - t);
		let o = 0, a = 0;
		for (; n > 0;) {
			const r = Math.floor(t / Is), s = t % Is;
			let c = Is - s;
			c > n && (c = n);
			const h = this.inodeBlockMap(e, r, !1);
			if (h <= 0) i.fill(0, a, a + c);
			else {
				const e = h * Is + s;
				i.set(this.u8.subarray(e, e + c), a);
			}
			a += c, t += c, n -= c, o += c;
		}
		return o;
	}
	inodeWriteData(e, t, i, n) {
		const r = this.inodeOffset(e), s = this.r64(r + Bs);
		t > s && this.zeroOldEofTail(e, s);
		let o = 0, a = 0;
		for (; n > 0;) {
			const r = Math.floor(t / Is), s = t % Is;
			let c = Is - s;
			c > n && (c = n);
			const h = this.inodeBlockMap(e, r, !0);
			if (h < 0) {
				if (0 === o) return h;
				break;
			}
			const l = h * Is + s;
			this.u8.set(i.subarray(a, a + c), l), a += c, t += c, n -= c, o += c;
		}
		if (o > 0 && t > this.r64(r + Bs) && this.w64(r + Bs, t), o > 0) {
			const e = Date.now();
			this.w64(r + Ts, e), this.w64(r + Fs, e), Atomics.add(this.i32, r + Ws >> 2, 1);
		}
		return o;
	}
	zeroInodeRange(e, t, i) {
		for (; t < i;) {
			const n = Math.floor(t / Is), r = t % Is, s = Math.min(Is - r, i - t), o = this.inodeBlockMap(e, n, !1);
			if (o > 0) {
				const e = o * Is + r;
				this.u8.fill(0, e, e + s);
			}
			t += s;
		}
	}
	zeroOldEofTail(e, t) {
		const i = t % Is;
		if (0 === i) return;
		const n = Math.floor(t / Is), r = this.inodeBlockMap(e, n, !1);
		if (r <= 0) return;
		const s = r * Is + i;
		this.u8.fill(0, s, r * Is + Is);
	}
	freeBlocksFrom(e, t) {
		const i = this.inodeOffset(e);
		for (let s = t; s < 10; s++) {
			const e = this.r32(i + Rs + 4 * s);
			e && (this.blockFree(e), this.w32(i + Rs + 4 * s, 0));
		}
		const n = this.r32(i + 88);
		if (n) {
			const e = t > 10 ? t - 10 : 0;
			for (let t = e; t < zs; t++) {
				const e = n * Is + 4 * t, i = this.r32(e);
				i && (this.blockFree(i), this.w32(e, 0));
			}
			0 === e && (this.blockFree(n), this.w32(i + 88, 0));
		}
		const r = this.r32(i + Us);
		if (r) {
			const e = t > 1034 ? t - 10 - zs : 0, n = Math.floor(e / zs);
			for (let t = n; t < zs; t++) {
				const i = r * Is + 4 * t, s = this.r32(i);
				if (!s) continue;
				const o = t === n ? e % zs : 0;
				for (let e = o; e < zs; e++) {
					const t = s * Is + 4 * e, i = this.r32(t);
					i && (this.blockFree(i), this.w32(t, 0));
				}
				0 === o && (this.blockFree(s), this.w32(i, 0));
			}
			0 === n && (this.blockFree(r), this.w32(i + Us, 0));
		}
	}
	inodeTruncate(e, t, i = !1) {
		const n = this.inodeOffset(e), r = this.r64(n + Bs), s = t !== r;
		if (t >= r) {
			if (t > r && this.zeroOldEofTail(e, r), this.w64(n + Bs, t), s || i) {
				const e = Date.now();
				this.w64(n + Ts, e), this.w64(n + Fs, e), Atomics.add(this.i32, n + Ws >> 2, 1);
			}
			return;
		}
		t % 4096 != 0 && this.zeroInodeRange(e, t, Math.ceil(t / Is) * Is);
		const o = Math.ceil(t / Is);
		if (this.freeBlocksFrom(e, o), this.w64(n + Bs, t), s || i) {
			const e = Date.now();
			this.w64(n + Ts, e), this.w64(n + Fs, e), Atomics.add(this.i32, n + Ws >> 2, 1);
		}
	}
	validateFileSize(e) {
		if (!Number.isSafeInteger(e) || e < 0) throw new Hs(-22);
		if (e > Vs) throw new Hs(-27);
	}
	validateSeekPosition(e) {
		if (!Number.isSafeInteger(e)) throw new Hs(-75);
		if (e < 0) throw new Hs(-22);
		if (e > Vs) throw new Hs(-27);
	}
	touchDirectoryMutation(e) {
		const t = this.inodeOffset(e), i = Date.now();
		this.w64(t + Ts, i), this.w64(t + Fs, i);
		const n = Atomics.add(this.i32, t + 116 >> 2, 1) + 1 >>> 0, r = this.dirIndexes.get(e);
		r && (r.mutationSequence = n, r.size = this.r64(t + Bs));
	}
	dirNameKey(e) {
		return Zs(e);
	}
	dirEntryNameMatches(e, t) {
		if (this.view.getUint16(e + 6, !0) !== t.length) return !1;
		for (let i = 0; i < t.length; i++) if (this.u8[e + 8 + i] !== t[i]) return !1;
		return !0;
	}
	isValidDirEntry(e, t, i, n) {
		return i >= 8 && i % 4 == 0 && e + i <= t && n <= i - 8;
	}
	inodeIsAllocated(e) {
		const t = this.r32(Cs);
		if (e <= 0 || e >= t) return !1;
		const i = this.r32(_s) * Is;
		return !!(Atomics.load(this.i32, (i >> 2) + (e >> 5)) & 1 << (31 & e));
	}
	rebuildDirIndex(e, t, i, n) {
		const r = /* @__PURE__ */ new Map(), s = [];
		let o = 0;
		for (; o < n;) {
			const t = Math.floor(o / Is), i = o % Is, a = this.inodeBlockMap(e, t, !1);
			if (a <= 0) return -5;
			const c = a * Is;
			let h = n - o;
			h > 4096 - i && (h = Is - i);
			let l = i;
			for (; l < i + h;) {
				const e = c + l, t = this.r32(e), n = this.view.getUint16(e + 4, !0), o = this.view.getUint16(e + 6, !0);
				if (!this.isValidDirEntry(l, i + h, n, o)) return -5;
				if (0 !== t) {
					if (!this.inodeIsAllocated(t)) return -5;
					const i = Zs(this.u8.subarray(e + 8, e + 8 + o));
					r.set(i, {
						ino: t,
						abs: e,
						recLen: n,
						nameLen: o
					});
				} else n >= 8 && s.push({
					abs: e,
					recLen: n
				});
				l += n;
			}
			o += h;
		}
		const a = {
			generation: t,
			mutationSequence: i,
			size: n,
			entries: r,
			free: s
		};
		return this.dirIndexes.set(e, a), a;
	}
	getDirIndex(t) {
		const i = this.inodeOffset(t), n = this.r64(i + Bs), r = this.r64(i + Os), s = Atomics.load(this.i32, i + 116 >> 2) >>> 0, o = this.dirIndexes.get(t);
		return o && o.generation === r && o.mutationSequence === s && o.size === n ? o : (o && this.dirIndexes.delete(t), n < e.DIR_INDEX_MIN_SIZE ? null : this.rebuildDirIndex(t, r, s, n));
	}
	updateDirIndexAdd(e, t, i, n, r) {
		const s = this.inodeOffset(e), o = this.r64(s + Bs), a = this.r64(s + Os), c = this.dirIndexes.get(e);
		c && (c.generation === a ? (c.size = o, c.entries.set(this.dirNameKey(t), {
			ino: i,
			abs: n,
			recLen: r,
			nameLen: t.length
		})) : this.dirIndexes.delete(e));
	}
	useDirIndexFreeSlot(e, t, i, n) {
		const r = Js(8 + i.length);
		for (let s = e.free.length - 1; s >= 0; s--) {
			const o = e.free[s];
			if (!(o.recLen < r) && (e.free.splice(s, 1), 0 === this.r32(o.abs) && this.view.getUint16(o.abs + 4, !0) === o.recLen)) return this.w32(o.abs, n), this.view.setUint16(o.abs + 6, i.length, !0), this.u8.set(i, o.abs + 8), this.touchDirectoryMutation(t), this.updateDirIndexAdd(t, i, n, o.abs, o.recLen), !0;
		}
		return !1;
	}
	updateDirIndexRemove(e, t) {
		const i = this.inodeOffset(e), n = this.r64(i + Bs), r = this.r64(i + Os), s = this.dirIndexes.get(e);
		s && (s.generation === r && s.size === n ? s.entries.delete(this.dirNameKey(t)) : this.dirIndexes.delete(e));
	}
	updateDirIndexRecLen(e, t, i) {
		const n = this.dirIndexes.get(e);
		if (n) {
			for (const r of n.entries.values()) if (r.abs === t) return void (r.recLen = i);
		}
	}
	dirLookup(e, t) {
		const i = this.getDirIndex(e);
		if ("number" == typeof i) return i;
		if (i) {
			const e = i.entries.get(this.dirNameKey(t));
			return e ? this.r32(e.abs) === e.ino && this.inodeIsAllocated(e.ino) && this.view.getUint16(e.abs + 4, !0) === e.recLen && this.view.getUint16(e.abs + 6, !0) === e.nameLen && this.dirEntryNameMatches(e.abs, t) ? e.ino : (i.entries.delete(this.dirNameKey(t)), -2) : -2;
		}
		const n = this.inodeOffset(e), r = this.r64(n + Bs);
		let s = 0;
		for (; s < r;) {
			const i = Math.floor(s / Is), n = s % Is, o = this.inodeBlockMap(e, i, !1);
			if (o <= 0) return -5;
			const a = o * Is;
			let c = r - s;
			c > 4096 - n && (c = Is - n);
			let h = n;
			for (; h < n + c;) {
				const e = a + h, i = this.r32(e), r = this.view.getUint16(e + 4, !0), s = this.view.getUint16(e + 6, !0);
				if (!this.isValidDirEntry(h, n + c, r, s)) return -5;
				if (0 !== i && s === t.length) {
					let n = !0;
					for (let i = 0; i < t.length; i++) if (this.u8[e + 8 + i] !== t[i]) {
						n = !1;
						break;
					}
					if (n) return this.inodeIsAllocated(i) ? i : -5;
				}
				h += r;
			}
			s += c;
		}
		return -2;
	}
	findLastDirEntryInBlock(e, t, i) {
		const n = this.inodeBlockMap(e, t, !1);
		if (n <= 0) return -1;
		const r = n * Is;
		let s = 0, o = -1;
		for (; s < i;) {
			const e = r + s, t = this.view.getUint16(e + 4, !0);
			if (t < 8 || t % 4 != 0 || s + t > i) return -1;
			o = e, s += t;
		}
		return s === i ? o : -1;
	}
	dirAppendEntry(e, t, i, n = -1) {
		const r = this.inodeOffset(e), s = this.r64(r + Bs), o = Js(8 + t.length);
		let a, c = s, h = Math.floor(c / Is), l = c % Is, d = 0;
		if (0 !== l && l + o > 4096) {
			const t = Is - l;
			let i = 0;
			if (t >= 8) {
				if (i = this.inodeBlockMap(e, h, !1), i <= 0) return -5;
			} else if (n < 0 && (n = this.findLastDirEntryInBlock(e, h, l)), n < 0) return -5;
			if (d = this.inodeBlockMap(e, h + 1, !0), d < 0) return d;
			if (t >= 8) {
				const e = i * Is + l;
				this.w32(e, 0), this.view.setUint16(e + 4, t, !0), this.view.setUint16(e + 6, 0, !0);
			} else {
				const i = this.view.getUint16(n + 4, !0) + t;
				this.view.setUint16(n + 4, i, !0), this.updateDirIndexRecLen(e, n, i);
			}
			c = (h + 1) * Is, h++, l = 0;
		}
		if (0 === l) {
			if (a = d || this.inodeBlockMap(e, h, !0), a < 0) return a;
		} else if (a = this.inodeBlockMap(e, h, !1), a <= 0) return -5;
		const f = a * Is + l;
		return this.w32(f, i), this.view.setUint16(f + 4, o, !0), this.view.setUint16(f + 6, t.length, !0), this.u8.set(t, f + 8), this.w64(r + Bs, c + o), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, i, f, o), 0;
	}
	dirAddEntry(e, t, i) {
		const n = this.getDirIndex(e);
		if ("number" == typeof n) return n;
		if (n) return this.useDirIndexFreeSlot(n, e, t, i) ? 0 : this.dirAppendEntry(e, t, i);
		const r = this.inodeOffset(e), s = this.r64(r + Bs), o = Js(8 + t.length);
		let a = -1, c = 0;
		for (; c < s;) {
			const n = Math.floor(c / Is), r = c % Is, h = this.inodeBlockMap(e, n, !1);
			if (h <= 0) return -5;
			const l = h * Is;
			let d = s - c;
			d > 4096 - r && (d = Is - r);
			let f = r;
			for (; f < r + d;) {
				const n = l + f, s = this.r32(n), c = this.view.getUint16(n + 4, !0), h = this.view.getUint16(n + 6, !0);
				if (c < 8 || c % 4 != 0 || f + c > r + d || h > c - 8) return -5;
				if (0 === s && c >= o) return this.w32(n, i), this.view.setUint16(n + 6, t.length, !0), this.u8.set(t, n + 8), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, i, n, c), 0;
				const u = Js(8 + h), p = c - u;
				if (0 !== s && p >= o) {
					this.view.setUint16(n + 4, u, !0);
					const r = n + u;
					return this.w32(r, i), this.view.setUint16(r + 4, p, !0), this.view.setUint16(r + 6, t.length, !0), this.u8.set(t, r + 8), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, i, r, p), 0;
				}
				a = n, f += c;
			}
			c += d;
		}
		return this.dirAppendEntry(e, t, i, a);
	}
	dirRemoveEntry(e, t) {
		const i = this.getDirIndex(e);
		if ("number" == typeof i) return i;
		if (i) {
			const n = this.dirNameKey(t), r = i.entries.get(n);
			if (!r) return -2;
			if (this.r32(r.abs) === r.ino && this.view.getUint16(r.abs + 4, !0) === r.recLen && this.view.getUint16(r.abs + 6, !0) === r.nameLen && this.dirEntryNameMatches(r.abs, t)) return this.w32(r.abs, 0), i.entries.delete(n), i.free.push({
				abs: r.abs,
				recLen: r.recLen
			}), this.touchDirectoryMutation(e), 0;
			i.entries.delete(n);
		}
		const n = this.inodeOffset(e), r = this.r64(n + Bs);
		let s = 0;
		for (; s < r;) {
			const i = Math.floor(s / Is), n = s % Is, o = this.inodeBlockMap(e, i, !1);
			if (o <= 0) return -5;
			const a = o * Is;
			let c = r - s;
			c > 4096 - n && (c = Is - n);
			let h = n;
			for (; h < n + c;) {
				const i = a + h, r = this.r32(i), s = this.view.getUint16(i + 4, !0), o = this.view.getUint16(i + 6, !0);
				if (!this.isValidDirEntry(h, n + c, s, o)) return -5;
				if (0 !== r && o === t.length) {
					let n = !0;
					for (let e = 0; e < t.length; e++) if (this.u8[i + 8 + e] !== t[e]) {
						n = !1;
						break;
					}
					if (n) return this.w32(i, 0), this.touchDirectoryMutation(e), this.updateDirIndexRemove(e, t), 0;
				}
				h += s;
			}
			s += c;
		}
		return -2;
	}
	dirReplaceEntryIno(e, t, i) {
		const n = this.getDirIndex(e);
		if ("number" == typeof n) return n;
		if (n) {
			const r = this.dirNameKey(t), s = n.entries.get(r);
			if (s && this.r32(s.abs) === s.ino && this.view.getUint16(s.abs + 4, !0) === s.recLen && this.view.getUint16(s.abs + 6, !0) === s.nameLen && this.dirEntryNameMatches(s.abs, t)) return this.w32(s.abs, i), s.ino = i, this.touchDirectoryMutation(e), 0;
			s && n.entries.delete(r);
		}
		const r = this.inodeOffset(e), s = this.r64(r + Bs);
		let o = 0;
		for (; o < s;) {
			const n = Math.floor(o / Is), r = o % Is, a = this.inodeBlockMap(e, n, !1);
			if (a <= 0) return -5;
			const c = a * Is;
			let h = s - o;
			h > 4096 - r && (h = Is - r);
			let l = r;
			for (; l < r + h;) {
				const n = c + l, s = this.r32(n), o = this.view.getUint16(n + 4, !0), a = this.view.getUint16(n + 6, !0);
				if (!this.isValidDirEntry(l, r + h, o, a)) return -5;
				if (0 !== s && a === t.length) {
					let r = !0;
					for (let e = 0; e < t.length; e++) if (this.u8[n + 8 + e] !== t[e]) {
						r = !1;
						break;
					}
					if (r) return this.w32(n, i), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, i, n, o), 0;
				}
				l += o;
			}
			o += h;
		}
		return -2;
	}
	dirIsEmpty(e) {
		const t = this.inodeOffset(e), i = this.r64(t + Bs);
		let n = 0;
		for (; n < i;) {
			const t = Math.floor(n / Is), r = n % Is, s = this.inodeBlockMap(e, t, !1);
			if (s <= 0) throw new Hs(-5);
			const o = s * Is;
			let a = i - n;
			a > 4096 - r && (a = Is - r);
			let c = r;
			for (; c < r + a;) {
				const e = o + c, t = this.r32(e), i = this.view.getUint16(e + 4, !0), n = this.view.getUint16(e + 6, !0);
				if (i < 8 || i % 4 != 0 || c + i > r + a || n > i - 8) throw new Hs(-5);
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
	dirIsAncestor(e, t) {
		let i = t;
		for (let n = 0; n < 8192; n++) {
			if (i === e) return !0;
			if (1 === i) return !1;
			const t = this.dirLookup(i, js);
			if (t < 0 || t === i) throw new Hs(-5);
			i = t;
		}
		throw new Hs(-5);
	}
	pathResolve(e, t) {
		if (!e.startsWith("/")) return -2;
		let i = 1;
		const n = e.split("/").filter((e) => e.length > 0);
		let r = 0;
		for (let s = 0; s < n.length; s++) {
			const e = n[s];
			if (e.length > 255) return -36;
			const o = Gs.encode(e);
			let a;
			this.inodeReadLock(i);
			try {
				const e = this.inodeOffset(i);
				if (16384 != (61440 & this.r32(e + 8))) return -20;
				a = this.dirLookup(i, o);
			} finally {
				this.inodeReadUnlock(i);
			}
			if (a < 0) return a;
			const c = this.inodeOffset(a);
			if (40960 == (61440 & this.r32(c + 8)) && (s !== n.length - 1 || t)) {
				if (++r > 8) return -40;
				const e = this.r64(c + Bs);
				let t;
				if (e <= 40) t = Zs(this.u8.subarray(c + Rs, c + Rs + e));
				else {
					const i = new Uint8Array(e);
					this.inodeReadData(a, 0, i, e), t = qs.decode(i);
				}
				if (t.startsWith("/")) {
					i = 1;
					const e = t.split("/").filter((e) => e.length > 0), r = n.slice(s + 1);
					n.length = 0, n.push(...e, ...r), s = -1;
				} else {
					const e = t.split("/").filter((e) => e.length > 0), i = n.slice(s + 1);
					n.length = s, n.push(...e, ...i), s--;
				}
				continue;
			}
			i = a;
		}
		return i;
	}
	pathResolveParent(e) {
		if (!e.startsWith("/")) throw new Hs(-22, "Path must be absolute");
		const t = e.split("/").filter((e) => e.length > 0);
		if (0 === t.length) throw new Hs(-22, "Cannot operate on /");
		const i = t.pop();
		if (i.length > 255) throw new Hs(-36);
		const n = "/" + t.join("/"), r = this.pathResolve(n, !0);
		if (r < 0) throw new Hs(r);
		const s = this.inodeOffset(r);
		if (16384 != (61440 & this.r32(s + 8))) throw new Hs(-20);
		return {
			parentIno: r,
			name: i
		};
	}
	fdAlloc(e, t, i) {
		for (let n = 0; n < xs; n++) {
			const r = 256 + 24 * n, s = r >> 2;
			if (0 === Atomics.compareExchange(this.i32, s, 0, 1)) return this.w32(r + 4, e), this.w64(r + 8, 0), this.w32(r + 16, t), this.w32(r + 20, i ? 1 : 0), this.inodeAddOpenRef(e) ? n : (Atomics.store(this.i32, s, 0), -2);
		}
		return -24;
	}
	fdGet(e) {
		if (e < 0 || e >= xs) return null;
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
		if (e >= 0 && e < xs) {
			const t = 256 + 24 * e;
			Atomics.store(this.i32, t >> 2, 0);
		}
	}
	buildStat(e) {
		const t = this.inodeOffset(e);
		return {
			ino: e,
			generation: this.r64(t + Os),
			dataSequence: this.r32(t + Ws),
			mode: this.r32(t + 8),
			linkCount: this.r32(t + Ls),
			size: this.r64(t + Bs),
			mtime: this.r64(t + Ts),
			ctime: this.r64(t + Fs),
			atime: this.r64(t + 40),
			uid: this.r32(t + 96),
			gid: this.r32(t + $s)
		};
	}
	namespaceEntryIdentity(e) {
		const t = this.inodeOffset(e);
		return {
			ino: e,
			generation: this.r64(t + Os),
			linkCount: this.r32(t + Ls),
			mode: this.r32(t + 8)
		};
	}
	open(e, t, i = 420) {
		return this.withNamespaceLock(() => this.openUnlocked(e, t, i));
	}
	createLazyStub(e, t) {
		return this.withNamespaceLock(() => {
			const i = this.openUnlocked(e, 65, t);
			try {
				const e = this.fdGet(i);
				if (!e) throw new Hs(-9);
				this.inodeWriteLock(e.ino);
				try {
					return this.inodeTruncate(e.ino, 0, !0), this.buildStat(e.ino);
				} finally {
					this.inodeWriteUnlock(e.ino);
				}
			} finally {
				this.closeUnlocked(i);
			}
		});
	}
	replaceIfIdentity(e, t, i, n, r) {
		return this.withNamespaceLock(() => {
			const s = this.pathResolve(e, !0);
			if (s < 0 || s !== t) return !1;
			const o = this.inodeOffset(s);
			if (this.r64(o + Os) !== i || this.r32(o + Ws) !== n) return !1;
			if (32768 != (61440 & this.r32(o + 8))) return !1;
			this.validateFileSize(r.byteLength), this.inodeWriteLock(s);
			try {
				if (this.r64(o + Os) !== i || this.r32(o + Ws) !== n) return !1;
				if (0 !== this.r64(o + Bs)) return !1;
				const e = this.r64(o + Ts), t = this.r64(o + Fs);
				this.inodeTruncate(s, 0, !0);
				const a = r.byteLength > 0 ? this.inodeWriteData(s, 0, r, r.byteLength) : 0;
				if (a !== r.byteLength) throw this.inodeTruncate(s, 0, !0), Atomics.store(this.i32, o + Ws >> 2, n), this.w64(o + Ts, e), this.w64(o + Fs, t), new Hs(a < 0 ? a : -28);
				return !0;
			} finally {
				this.inodeWriteUnlock(s);
			}
		});
	}
	replaceManyIfIdentities(e, t = []) {
		return 0 === e.length && 0 === t.length || this.withNamespaceLock(() => {
			const i = [], n = /* @__PURE__ */ new Set(), r = (e) => {
				const t = this.pathResolve(e.path, !1);
				if (t < 0 || t !== e.expectedIno) return !1;
				const i = this.inodeOffset(t);
				return this.r64(i + Os) === e.expectedGeneration && this.r32(i + Ws) === e.expectedDataSequence && this.r32(i + 8) === e.expectedMode && this.r32(i + Ls) === e.expectedLinkCount && this.r64(i + Bs) === e.expectedSize && this.r32(i + 96) === e.expectedUid && this.r32(i + $s) === e.expectedGid;
			};
			for (const e of t) if (!r(e)) return !1;
			for (const t of e) {
				this.validateFileSize(t.data.byteLength);
				let e = -1;
				for (const i of t.paths) {
					const n = this.pathResolve(i, !0);
					if (n !== t.expectedIno) continue;
					const r = this.inodeOffset(n);
					if (this.r64(r + Os) === t.expectedGeneration && this.r32(r + Ws) === t.expectedDataSequence && 32768 == (61440 & this.r32(r + 8)) && 0 === this.r64(r + Bs)) {
						e = n;
						break;
					}
				}
				if (e < 0) return !1;
				if (n.has(e)) throw new Hs(-22, "duplicate conditional replacement inode");
				n.add(e), i.push({
					...t,
					ino: e
				});
			}
			const s = [...n].sort((e, t) => e - t);
			for (const e of s) this.inodeWriteLock(e);
			try {
				for (const t of i) {
					const e = this.inodeOffset(t.ino);
					if (this.r64(e + Os) !== t.expectedGeneration || this.r32(e + Ws) !== t.expectedDataSequence || 32768 != (61440 & this.r32(e + 8)) || 0 !== this.r64(e + Bs)) return !1;
				}
				for (const i of t) if (!r(i)) return !1;
				const e = i.map((e) => {
					const t = this.inodeOffset(e.ino);
					return {
						ino: e.ino,
						dataSequence: this.r32(t + Ws),
						mtime: this.r64(t + Ts),
						ctime: this.r64(t + Fs)
					};
				});
				let n = 0;
				try {
					for (const e of i) {
						n++, this.inodeTruncate(e.ino, 0, !0);
						const t = e.data.byteLength > 0 ? this.inodeWriteData(e.ino, 0, e.data, e.data.byteLength) : 0;
						if (t !== e.data.byteLength) throw new Hs(t < 0 ? t : -28);
					}
				} catch (o) {
					for (let t = n - 1; t >= 0; t--) {
						const i = e[t], n = this.inodeOffset(i.ino);
						this.inodeTruncate(i.ino, 0, !0), Atomics.store(this.i32, n + Ws >> 2, i.dataSequence), this.w64(n + Ts, i.mtime), this.w64(n + Fs, i.ctime);
					}
					throw o;
				}
				return !0;
			} finally {
				for (let e = s.length - 1; e >= 0; e--) this.inodeWriteUnlock(s[e]);
			}
		});
	}
	openUnlocked(e, t, i = 420) {
		const n = 3 & t, r = !!(64 & t), s = !!(128 & t);
		if (r && s) {
			const t = this.pathResolve(e, !1);
			if (t >= 0) throw new Hs(-17);
			if (-2 !== t) throw new Hs(t);
		}
		let o = this.pathResolve(e, !0);
		if (o < 0 && -2 === o && r) {
			const { parentIno: t, name: n } = this.pathResolveParent(e);
			this.inodeWriteLock(t);
			try {
				const e = Gs.encode(n), r = this.dirLookup(t, e);
				if (r >= 0) {
					if (s) throw new Hs(-17);
					o = r;
				} else {
					const n = this.inodeAlloc();
					if (n < 0) throw new Hs(-28);
					const r = this.inodeOffset(n);
					this.w32(r + 8, 32768 | 4095 & i), this.w32(r + Ls, 1), this.w64(r + Bs, 0);
					const s = Date.now();
					this.w64(r + 40, s), this.w64(r + Ts, s), this.w64(r + Fs, s);
					const a = this.dirAddEntry(t, e, n);
					if (a < 0) throw this.inodeFree(n), new Hs(a);
					o = n;
				}
			} finally {
				this.inodeWriteUnlock(t);
			}
		}
		if (o < 0) throw new Hs(o);
		const a = this.inodeOffset(o), c = this.r32(a + 8);
		if (16384 == (61440 & c) && 0 !== n) throw new Hs(-21);
		if (65536 & t && 16384 != (61440 & c)) throw new Hs(-20);
		if (512 & t) {
			if (16384 == (61440 & c)) throw new Hs(-21);
			this.inodeWriteLock(o), this.inodeTruncate(o, 0, !0), this.inodeWriteUnlock(o);
		}
		const h = this.fdAlloc(o, t, !1);
		if (h < 0) throw new Hs(h);
		return h;
	}
	close(e) {
		this.withNamespaceLock(() => this.closeUnlocked(e));
	}
	closeUnlocked(e) {
		const t = this.fdGet(e);
		if (!t) throw new Hs(-9);
		this.fdFree(e), this.inodeDropOpenRef(t.ino);
	}
	read(e, t) {
		const i = this.fdGet(e);
		if (!i) throw new Hs(-9);
		const n = this.inodeOffset(i.ino);
		if (16384 == (61440 & this.r32(n + 8))) throw new Hs(-21);
		this.inodeReadLock(i.ino);
		try {
			const n = this.inodeReadData(i.ino, i.offset, t, t.length), r = 256 + 24 * e;
			return this.w64(r + 8, i.offset + n), n;
		} finally {
			this.inodeReadUnlock(i.ino);
		}
	}
	readAt(e, t, i) {
		const n = this.fdGet(e);
		if (!n) throw new Hs(-9);
		const r = this.inodeOffset(n.ino);
		if (16384 == (61440 & this.r32(r + 8))) throw new Hs(-21);
		this.validateSeekPosition(i), this.inodeReadLock(n.ino);
		try {
			return this.inodeReadData(n.ino, i, t, t.length);
		} finally {
			this.inodeReadUnlock(n.ino);
		}
	}
	write(e, t) {
		const i = this.fdGet(e);
		if (!i) throw new Hs(-9);
		if (!(3 & i.flags)) throw new Hs(-9);
		this.inodeWriteLock(i.ino);
		try {
			let n = i.offset;
			if (1024 & i.flags) {
				const e = this.inodeOffset(i.ino);
				n = this.r64(e + Bs);
			}
			if (!Number.isSafeInteger(n) || n < 0) throw new Hs(-22);
			if (n > Vs || t.length > Vs - n) throw new Hs(-27);
			const r = this.inodeWriteData(i.ino, n, t, t.length);
			if (r < 0) return r;
			const s = 256 + 24 * e;
			return this.w64(s + 8, n + r), r;
		} finally {
			this.inodeWriteUnlock(i.ino);
		}
	}
	writeAt(e, t, i) {
		const n = this.fdGet(e);
		if (!n) throw new Hs(-9);
		if (!(3 & n.flags)) throw new Hs(-9);
		this.validateSeekPosition(i), this.inodeWriteLock(n.ino);
		try {
			if (i > Vs || t.length > Vs - i) throw new Hs(-27);
			return this.inodeWriteData(n.ino, i, t, t.length);
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	lseek(e, t, i) {
		const n = this.fdGet(e);
		if (!n) throw new Hs(-9);
		let r;
		if (0 === i) r = t;
		else if (1 === i) r = n.offset + t;
		else {
			if (2 !== i) throw new Hs(-22);
			{
				const e = this.inodeOffset(n.ino);
				r = this.r64(e + Bs) + t;
			}
		}
		this.validateSeekPosition(r);
		const s = 256 + 24 * e;
		return this.w64(s + 8, r), r;
	}
	ftruncate(e, t) {
		const i = this.fdGet(e);
		if (!i) throw new Hs(-9);
		if (!(3 & i.flags)) throw new Hs(-9);
		this.validateFileSize(t), this.inodeWriteLock(i.ino);
		try {
			this.inodeTruncate(i.ino, t, !0);
		} finally {
			this.inodeWriteUnlock(i.ino);
		}
	}
	fstat(e) {
		const t = this.fdGet(e);
		if (!t) throw new Hs(-9);
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
		if (t < 0) throw new Hs(t);
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
		if (t < 0) throw new Hs(t);
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
		const { parentIno: t, name: i } = this.pathResolveParent(e), n = Gs.encode(i), r = e.length > 1 && e.endsWith("/");
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, n);
			if (e < 0) throw new Hs(e);
			const i = this.inodeOffset(e), s = this.r32(i + 8);
			if (r && 16384 != (61440 & s)) throw new Hs(-20);
			if (16384 == (61440 & s)) throw new Hs(-21);
			const o = this.namespaceEntryIdentity(e), a = this.dirRemoveEntry(t, n);
			if (a < 0) throw new Hs(a);
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
		const { parentIno: i, name: n } = this.pathResolveParent(e), { parentIno: r, name: s } = this.pathResolveParent(t);
		if (Xs(n) || Xs(s)) throw new Hs(-22);
		const o = Gs.encode(n), a = Gs.encode(s), c = e.length > 1 && e.endsWith("/"), h = t.length > 1 && t.endsWith("/"), l = Math.min(i, r), d = Math.max(i, r);
		this.inodeWriteLock(l), l !== d && this.inodeWriteLock(d);
		try {
			const e = this.dirLookup(i, o);
			if (e < 0) throw new Hs(e);
			const t = this.inodeOffset(e), n = this.r32(t + 8) & Es, s = this.namespaceEntryIdentity(e);
			if ((c || h) && 16384 !== n) throw new Hs(-20);
			if (16384 === n && this.dirIsAncestor(e, r)) throw new Hs(-22);
			const l = this.dirLookup(r, a);
			let d, f = !1;
			if (l >= 0) {
				if (l === e) return {
					source: s,
					replaced: s
				};
				d = this.namespaceEntryIdentity(l);
				const t = this.inodeOffset(l), o = this.r32(t + 8) & Es;
				if (16384 === n && 16384 !== o) throw new Hs(-20);
				if (16384 !== n && 16384 === o) throw new Hs(-21);
				let c = !1;
				const h = l === i || l === r;
				h || this.inodeWriteLock(l);
				try {
					if (16384 === o && !this.dirIsEmpty(l)) throw new Hs(-39);
					const t = this.dirReplaceEntryIno(r, a, e);
					if (t < 0) throw new Hs(t);
					c = 16384 === o ? this.inodeOrphanLocked(l) : this.inodeDropLinkRefLocked(l);
				} finally {
					h || this.inodeWriteUnlock(l);
				}
				c && this.inodeFree(l), f = 16384 === o;
			} else {
				const t = this.dirAddEntry(r, a, e);
				if (t < 0) throw new Hs(t);
			}
			const u = this.dirRemoveEntry(i, o);
			if (u < 0) throw new Hs(u);
			if (16384 === n) {
				if (i !== r) {
					const n = this.inodeOffset(i);
					this.w32(n + Ls, this.r32(n + Ls) - 1);
					const s = this.inodeOffset(r);
					this.w32(s + Ls, this.r32(s + Ls) + 1), this.inodeWriteLock(e);
					try {
						const i = this.dirReplaceEntryIno(e, js, r);
						if (i < 0) throw new Hs(i);
						this.w64(t + Fs, Date.now());
					} finally {
						this.inodeWriteUnlock(e);
					}
				}
				if (f) {
					const e = this.inodeOffset(r);
					this.w32(e + Ls, this.r32(e + Ls) - 1);
				}
			} else if (f) {
				const e = this.inodeOffset(r);
				this.w32(e + Ls, this.r32(e + Ls) - 1);
			}
			return {
				source: s,
				replaced: d
			};
		} finally {
			l !== d && this.inodeWriteUnlock(d), this.inodeWriteUnlock(l);
		}
	}
	mkdir(e, t = 493) {
		this.withNamespaceLock(() => this.mkdirUnlocked(e, t));
	}
	mkdirUnlocked(e, t = 493) {
		const { parentIno: i, name: n } = this.pathResolveParent(e), r = Gs.encode(n);
		this.inodeWriteLock(i);
		try {
			if (this.dirLookup(i, r) >= 0) throw new Hs(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new Hs(-28);
			const n = this.inodeOffset(e);
			this.w32(n + 8, 16384 | t), this.w32(n + Ls, 2), this.w64(n + Bs, 0);
			const s = Date.now();
			this.w64(n + 40, s), this.w64(n + Ts, s), this.w64(n + Fs, s);
			const o = this.blockAllocWithGrow();
			if (o < 0) throw this.inodeFree(e), new Hs(-28);
			this.w32(n + Rs, o);
			const a = o * Is, c = Js(9), h = Js(10);
			this.w32(a, e), this.view.setUint16(a + 4, c, !0), this.view.setUint16(a + 6, 1, !0), this.u8[a + 8] = 46;
			const l = a + c;
			this.w32(l, i), this.view.setUint16(l + 4, h, !0), this.view.setUint16(l + 6, 2, !0), this.u8[l + 8] = 46, this.u8[l + 8 + 1] = 46, this.w64(n + Bs, c + h);
			const d = this.dirAddEntry(i, r, e);
			if (d < 0) throw this.blockFree(o), this.inodeFree(e), new Hs(d);
			const f = this.inodeOffset(i);
			this.w32(f + Ls, this.r32(f + Ls) + 1);
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	rmdir(e) {
		this.withNamespaceLock(() => this.rmdirUnlocked(e));
	}
	rmdirUnlocked(e) {
		const { parentIno: t, name: i } = this.pathResolveParent(e);
		if (Xs(i)) throw new Hs(-22);
		const n = Gs.encode(i);
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, n);
			if (e < 0) throw new Hs(e);
			const i = this.inodeOffset(e);
			if (16384 != (61440 & this.r32(i + 8))) throw new Hs(-20);
			let r = !1;
			this.inodeWriteLock(e);
			try {
				if (!this.dirIsEmpty(e)) throw new Hs(-39);
				const i = this.dirRemoveEntry(t, n);
				if (i < 0) throw new Hs(i);
				r = this.inodeOrphanLocked(e);
			} finally {
				this.inodeWriteUnlock(e);
			}
			r && this.inodeFree(e);
			const s = this.inodeOffset(t);
			this.w32(s + Ls, this.r32(s + Ls) - 1);
		} finally {
			this.inodeWriteUnlock(t);
		}
	}
	symlink(e, t) {
		this.withNamespaceLock(() => this.symlinkUnlocked(e, t));
	}
	symlinkUnlocked(e, t) {
		const { parentIno: i, name: n } = this.pathResolveParent(t), r = Gs.encode(n), s = Gs.encode(e);
		this.inodeWriteLock(i);
		try {
			if (this.dirLookup(i, r) >= 0) throw new Hs(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new Hs(-28);
			const t = this.inodeOffset(e);
			if (this.w32(t + 8, 41471), this.w32(t + Ls, 1), s.length <= 40) this.u8.set(s, t + Rs), this.w64(t + Bs, s.length);
			else {
				this.w64(t + Bs, 0);
				const i = this.inodeWriteData(e, 0, s, s.length);
				if (i !== s.length) throw i > 0 && this.inodeTruncate(e, 0), this.inodeFree(e), new Hs(i < 0 ? i : -28);
			}
			const n = this.dirAddEntry(i, r, e);
			if (n < 0) throw s.length <= 40 ? (this.u8.fill(0, t + Rs, t + Rs + 40), this.w64(t + Bs, 0)) : this.inodeTruncate(e, 0), this.inodeFree(e), new Hs(n);
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	chmod(e, t) {
		this.withNamespaceLock(() => this.chmodUnlocked(e, t));
	}
	chmodUnlocked(e, t) {
		const i = this.pathResolve(e, !0);
		if (i < 0) throw new Hs(i);
		this.inodeWriteLock(i);
		try {
			const e = this.inodeOffset(i), n = this.r32(e + 8);
			this.w32(e + 8, n & Es | 4095 & t), this.w64(e + Fs, Date.now());
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	fchmod(e, t) {
		const i = this.fdGet(e);
		if (!i) throw new Hs(-9);
		this.inodeWriteLock(i.ino);
		try {
			const e = this.inodeOffset(i.ino), n = this.r32(e + 8);
			this.w32(e + 8, n & Es | 4095 & t), this.w64(e + Fs, Date.now());
		} finally {
			this.inodeWriteUnlock(i.ino);
		}
	}
	chown(e, t, i) {
		this.withNamespaceLock(() => this.chownUnlocked(e, t, i));
	}
	chownUnlocked(e, t, i) {
		const n = this.pathResolve(e, !0);
		if (n < 0) throw new Hs(n);
		this.inodeWriteLock(n);
		try {
			this.chownInodeUnlocked(n, t, i);
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	fchown(e, t, i) {
		const n = this.fdGet(e);
		if (!n) throw new Hs(-9);
		this.inodeWriteLock(n.ino);
		try {
			this.chownInodeUnlocked(n.ino, t, i);
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	lchown(e, t, i) {
		this.withNamespaceLock(() => this.lchownUnlocked(e, t, i));
	}
	lchownUnlocked(e, t, i) {
		const n = this.pathResolve(e, !1);
		if (n < 0) throw new Hs(n);
		this.inodeWriteLock(n);
		try {
			this.chownInodeUnlocked(n, t, i);
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	chownInodeUnlocked(e, t, i) {
		const n = this.inodeOffset(e);
		t !== Ms && this.w32(n + 96, t), i !== Ms && this.w32(n + $s, i);
		const r = this.r32(n + 8);
		32768 == (61440 & r) && 73 & r && this.w32(n + 8, -3073 & r), this.w64(n + Fs, Date.now());
	}
	utimens(e, t, i, n, r) {
		this.withNamespaceLock(() => this.utimensUnlocked(e, t, i, n, r));
	}
	utimensUnlocked(e, t, i, n, r) {
		const s = this.pathResolve(e, !0);
		if (s < 0) throw new Hs(s);
		this.inodeWriteLock(s);
		try {
			const e = this.inodeOffset(s), o = 1073741823, a = 1073741822, c = Date.now();
			if (i !== a) {
				const n = i === o ? c : 1e3 * t + Math.floor(i / 1e6);
				this.w64(e + 40, n);
			}
			if (r !== a) {
				const t = r === o ? c : 1e3 * n + Math.floor(r / 1e6);
				this.w64(e + Ts, t);
			}
			this.w64(e + Fs, c);
		} finally {
			this.inodeWriteUnlock(s);
		}
	}
	link(e, t) {
		return this.withNamespaceLock(() => this.linkUnlocked(e, t));
	}
	linkUnlocked(e, t) {
		const i = this.pathResolve(e, !1);
		if (i < 0) throw new Hs(i);
		const n = this.inodeOffset(i);
		if (16384 == (61440 & this.r32(n + 8))) throw new Hs(-1);
		const { parentIno: r, name: s } = this.pathResolveParent(t), o = Gs.encode(s);
		this.inodeWriteLock(r);
		try {
			if (this.dirLookup(r, o) >= 0) throw new Hs(-17);
			const e = this.dirAddEntry(r, o, i);
			if (e < 0) throw new Hs(e);
			this.inodeWriteLock(i);
			try {
				const e = this.r32(n + Ls);
				this.w32(n + Ls, e + 1), this.w64(n + Fs, Date.now());
			} finally {
				this.inodeWriteUnlock(i);
			}
			return {
				...this.namespaceEntryIdentity(i),
				linkCount: this.r32(n + Ls)
			};
		} finally {
			this.inodeWriteUnlock(r);
		}
	}
	readlink(e) {
		return this.withNamespaceLock(() => this.readlinkUnlocked(e));
	}
	readlinkUnlocked(e) {
		const t = this.pathResolve(e, !1);
		if (t < 0) throw new Hs(t);
		return this.readSymlinkInodeUnlocked(t);
	}
	readSymlinkInodeUnlocked(e) {
		const t = this.inodeOffset(e);
		if (40960 != (61440 & this.r32(t + 8))) throw new Hs(-22);
		const i = this.r64(t + Bs);
		if (i <= 40) return Zs(this.u8.subarray(t + Rs, t + Rs + i));
		this.inodeReadLock(e);
		try {
			const t = new Uint8Array(i);
			return this.inodeReadData(e, 0, t, i), qs.decode(t);
		} finally {
			this.inodeReadUnlock(e);
		}
	}
	opendir(e) {
		return this.withNamespaceLock(() => this.opendirUnlocked(e));
	}
	opendirUnlocked(e) {
		const t = this.pathResolve(e, !0);
		if (t < 0) throw new Hs(t);
		const i = this.inodeOffset(t);
		if (16384 != (61440 & this.r32(i + 8))) throw new Hs(-20);
		const n = this.fdAlloc(t, 0, !0);
		if (n < 0) throw new Hs(n);
		return n;
	}
	readdirEntry(e) {
		return this.withNamespaceLock(() => this.readdirEntryUnlocked(e));
	}
	readdirEntryUnlocked(e) {
		const t = this.fdGet(e);
		if (!t || !t.isDir) throw new Hs(-9);
		const i = this.inodeOffset(t.ino), n = this.r64(i + Bs);
		for (; t.offset < n;) {
			const i = t.offset, r = Math.floor(i / Is), s = i % Is, o = this.inodeBlockMap(t.ino, r, !1);
			if (o <= 0) throw new Hs(-5);
			const a = o * Is + s, c = this.r32(a), h = this.view.getUint16(a + 4, !0), l = this.view.getUint16(a + 6, !0);
			if (!this.isValidDirEntry(s, Math.min(4096, s + n - i), h, l)) throw new Hs(-5);
			const d = i + h, f = 256 + 24 * e;
			if (0 === c) {
				this.w64(f + 8, d), t.offset = d;
				continue;
			}
			if (c >= this.r32(Cs)) throw new Hs(-5);
			const u = this.r32(_s) * Is;
			if (!(this.r32(u + 4 * (c >> 5)) & 1 << (31 & c))) throw new Hs(-5);
			const p = Zs(this.u8.subarray(a + 8, a + 8 + l)), g = this.buildStat(c);
			return this.w64(f + 8, d), t.offset = d, {
				name: p,
				stat: g
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
		const i = "string" == typeof t ? Gs.encode(t) : t, n = this.open(e, 577);
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
		return qs.decode(this.readFile(e));
	}
};
const Qs = 268435456, eo = 268435456, to = 268435456, io = 1e5, no = 4096, ro = 65536, so = 8192, oo = 8, ao = 32, co = 64, ho = 255, lo = 536870912, fo = 536870912, uo = 536870912, po = 1e5, go = 512;
const mo = Object.freeze({
	prefix: "/opt/kandelo/homebrew",
	cellar: "/opt/kandelo/homebrew/Cellar",
	repository: "/opt/kandelo/homebrew",
	stableEntrypoint: "/usr/bin/brew"
}), yo = 1e5, wo = mo.prefix, bo = [
	["@@HOMEBREW_PREFIX@@", wo],
	["@@HOMEBREW_CELLAR@@", `${wo}/Cellar`],
	["@@HOMEBREW_REPOSITORY@@", wo],
	["@@HOMEBREW_LIBRARY@@", `${wo}/Library`],
	["@@HOMEBREW_PERL@@", `${wo}/opt/perl/bin/perl`]
], ko = "@@HOMEBREW_JAVA@@", vo = /^openjdk(?:@\d+(?:\.\d+)*)?/, So = new TextEncoder(), Po = [...bo.map(([e]) => e), ko].map((e) => ({
	placeholder: e,
	bytes: So.encode(e)
}));
function Io(e) {
	const t = function(e) {
		let t;
		try {
			t = JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(e));
		} catch (i) {
			throw new Error("INSTALL_RECEIPT.json is not valid UTF-8 JSON: " + function(e) {
				return e instanceof Error ? e.message : String(e);
			}(i));
		}
		if ("object" != typeof t || null === t || Array.isArray(t)) throw new Error("INSTALL_RECEIPT.json must contain an object");
		return t;
	}(e), i = t.changed_files;
	if (null != i && !Array.isArray(i)) throw new Error("INSTALL_RECEIPT.json changed_files must be an array or null when present");
	const n = Array.isArray(i) ? i : [];
	if (n.length > yo) throw new Error(`INSTALL_RECEIPT.json declares ${n.length} changed files, limit 100000`);
	const r = [], s = /* @__PURE__ */ new Set();
	for (const [o, a] of n.entries()) {
		if ("string" != typeof a) throw new Error(`INSTALL_RECEIPT.json changed_files[${o}] is not a string`);
		if (xo(a, "Homebrew changed file"), s.has(a)) throw new Error(`INSTALL_RECEIPT.json repeats changed file ${a}`);
		s.add(a), r.push(a);
	}
	return {
		changedFiles: r,
		runtimeDependencies: t.runtime_dependencies
	};
}
function zo(e, t, i) {
	let n = e;
	for (const [o, a] of bo) n = Mo(n, So.encode(o), So.encode(a));
	const r = So.encode(ko);
	if (Eo(n, r)) {
		const e = function(e) {
			if (!Array.isArray(e)) return;
			const t = [];
			for (const n of e) {
				if ("object" != typeof n || null === n || Array.isArray(n)) continue;
				const e = n, i = "string" == typeof e.full_name ? e.full_name.split("/").at(-1) : "string" == typeof e.name ? e.name.split("/").at(-1) : void 0, r = void 0 === i ? null : vo.exec(i);
				void 0 !== i && r?.[0] === i && t.push(i);
			}
			const i = [...new Set(t)];
			return 1 === i.length ? `${wo}/opt/${i[0]}/libexec` : void 0;
		}(t.runtimeDependencies);
		if (void 0 === e) throw new Error(`Homebrew changed file ${i} uses ${ko} without exactly one OpenJDK runtime dependency`);
		n = Mo(n, r, So.encode(e));
	}
	const s = Po.find(({ bytes: e }) => Eo(n, e));
	if (void 0 !== s) throw new Error(`Homebrew changed file ${i} retains ${s.placeholder}`);
	return n;
}
function xo(e, t) {
	if (0 === e.length || e.startsWith("/") || e.includes("\\") || e.includes("\0") || function(e) {
		for (let t = 0; t < e.length; t += 1) {
			const i = e.charCodeAt(t);
			if (!(i < 55296 || i > 57343)) {
				if (!(i <= 56319 && t + 1 < e.length && e.charCodeAt(t + 1) >= 56320 && e.charCodeAt(t + 1) <= 57343)) return !0;
				t += 1;
			}
		}
		return !1;
	}(e) || So.encode(e).byteLength > 4096 || e.split("/").some((e) => "" === e || "." === e || ".." === e)) throw new Error(`${t} has an unsafe path segment: ${e}`);
}
function Eo(e, t) {
	if (0 === t.byteLength || t.byteLength > e.byteLength) return !1;
	e: for (let i = 0; i <= e.byteLength - t.byteLength; i += 1) {
		for (let n = 0; n < t.byteLength; n += 1) if (e[i + n] !== t[n]) continue e;
		return !0;
	}
	return !1;
}
function Mo(e, t, i) {
	const n = [];
	for (let a = 0; a <= e.byteLength - t.byteLength;) {
		let i = !0;
		for (let n = 0; n < t.byteLength; n += 1) if (e[a + n] !== t[n]) {
			i = !1;
			break;
		}
		i ? (n.push(a), a += t.byteLength) : a += 1;
	}
	if (0 === n.length) return e;
	const r = new Uint8Array(e.byteLength + n.length * (i.byteLength - t.byteLength));
	let s = 0, o = 0;
	for (const a of n) {
		const n = e.subarray(s, a);
		r.set(n, o), o += n.byteLength, r.set(i, o), o += i.byteLength, s = a + t.byteLength;
	}
	return r.set(e.subarray(s), o), r;
}
const Ao = Symbol("DeferredTreeMaterializationHandle"), Co = [
	40,
	181,
	47,
	253
], _o = 4247762216, Lo = 407710288, Bo = 407710303, To = 131072, Fo = 1447449417, Ro = 16, Uo = 61440, $o = 32768, Oo = 16384, No = 40960, Wo = 65536, Do = 16777216, Vo = 16777216, Ko = 1107361820, Ho = Qs, Go = eo, qo = to, jo = io, Xo = go, Zo = no, Jo = ro, Yo = so, Qo = ao, ea = co, ta = ho, ia = 4294967294, na = /^[0-9a-f]{64}$/, ra = "kandelo-legacy-zip-v1", sa = "kandelo-deferred-tree-v1", oa = "kandelo-deferred-tree-v2", aa = "kandelo-deferred-tree-v3", ca = new Set([
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
var ha = class extends Error {
	status;
	retryAfterMs;
	constructor(e, t) {
		super(`HTTP ${e}`), this.status = e, this.retryAfterMs = t, this.name = "LazyHttpResponseError";
	}
};
function la(e) {
	if ("string" != typeof e || !e.startsWith("/") || new TextEncoder().encode(e).byteLength > Zo || e.includes("\0") || e.includes("\\")) throw new Error(`Lazy archive mount prefix must be an absolute POSIX path: ${JSON.stringify(e)}`);
	const t = e.replace(/\/+$/, "");
	if ("" === t) return "/";
	if (t.slice(1).split("/").some((e) => "" === e || "." === e || ".." === e)) throw new Error(`Lazy archive mount prefix is not canonical: ${JSON.stringify(e)}`);
	return t;
}
function da(e) {
	if (!e || "object" != typeof e) throw new Error("VFS image metadata must be an object");
	if (1 !== e.version) throw new Error(`Unsupported VFS image metadata version: ${String(e.version)}`);
	if (void 0 !== e.kernelAbi && (!Number.isInteger(e.kernelAbi) || e.kernelAbi < 0)) throw new Error("VFS image metadata kernelAbi must be a non-negative integer");
	if (void 0 !== e.createdBy && "string" != typeof e.createdBy) throw new Error("VFS image metadata createdBy must be a string");
	return { ...e };
}
function fa(e, t = 1107361820) {
	if (!Number.isSafeInteger(t) || t < Ro || t > Ko) throw new Error("VFS image decompressed byte bound is invalid");
	if (e.byteLength >= Co.length && e[0] === Co[0] && e[1] === Co[1] && e[2] === Co[2] && e[3] === Co[3]) {
		(function(e, t) {
			const i = new DataView(e.buffer, e.byteOffset, e.byteLength);
			let n = 0, r = 0, s = 0;
			const o = (t, i) => {
				if (t < 0 || n + t > e.byteLength) throw new Error(`zstd VFS image has a truncated ${i}`);
			}, a = (e) => {
				if (r += e, !Number.isSafeInteger(r) || r > t) throw new Error("zstd VFS image exceeds its decompressed byte bound");
			}, c = (t) => {
				o(t, "frame header");
				let i = 0n;
				for (let r = 0; r < t; r++) i |= BigInt(e[n + r]) << BigInt(8 * r);
				return n += t, i;
			};
			for (; n < e.byteLength;) {
				o(4, "frame magic");
				const r = i.getUint32(n, !0);
				if (n += 4, r >= Lo && r <= Bo) {
					o(4, "skippable frame size");
					const e = i.getUint32(n, !0);
					n += 4, o(e, "skippable frame"), n += e;
					continue;
				}
				if (r !== _o) throw new Error("zstd VFS image contains an invalid frame magic");
				s++, o(1, "frame descriptor");
				const h = e[n++];
				if (8 & h) throw new Error("zstd VFS image uses a reserved frame descriptor bit");
				const l = !!(32 & h), d = !!(4 & h), f = [
					0,
					1,
					2,
					4
				][3 & h], u = h >>> 6;
				let p;
				if (!l) {
					o(1, "window descriptor");
					const t = e[n++], i = 1n << BigInt(10 + (t >>> 3));
					p = i + (i >> 3n) * BigInt(7 & t);
				}
				o(f, "dictionary identity"), n += f;
				const g = 0 === u ? l ? 1 : 0 : 1 === u ? 2 : 2 === u ? 4 : 8;
				let m;
				if (g > 0 && (m = c(g), 1 === u && (m += 256n), l && (p = m)), void 0 !== p && p > BigInt(t)) throw new Error("zstd VFS image exceeds its decompressed window bound");
				if (void 0 !== m && m > BigInt(t)) throw new Error("zstd VFS image exceeds its decompressed byte bound");
				let y = 0;
				for (;;) {
					o(3, "block header");
					const i = e[n] | e[n + 1] << 8 | e[n + 2] << 16;
					n += 3;
					const r = !!(1 & i), s = i >>> 1 & 3, a = i >>> 3;
					if (3 === s || a > To) throw new Error("zstd VFS image contains an invalid block header");
					if (y += 2 === s ? To : a, !Number.isSafeInteger(y) || void 0 === m && y > t) throw new Error("zstd VFS image exceeds its decompressed byte bound");
					const c = 1 === s ? 1 : a;
					if (o(c, "block payload"), n += c, r) break;
				}
				if (d && (o(4, "content checksum"), n += 4), void 0 !== m && m > BigInt(y)) throw new Error("zstd VFS image frame content exceeds its block bound");
				a(void 0 === m ? y : Number(m));
			}
			if (0 === s) throw new Error("zstd VFS image contains no data frame");
		})(e, t);
		const i = function(e) {
			return Ps(e);
		}(e);
		if (i.byteLength > t) throw new Error("zstd VFS image exceeds its decompressed byte bound");
		return i;
	}
	if (e.byteLength > t) throw new Error("VFS image exceeds its decompressed byte bound");
	return e;
}
function ua(e, t) {
	const i = fa(e, t);
	if (i.byteLength < Ro) throw new Error("VFS image too small");
	const n = new DataView(i.buffer, i.byteOffset, i.byteLength), r = n.getUint32(0, !0);
	if (r !== Fo) throw new Error(`Bad VFS image magic: 0x${r.toString(16)} (expected 0x${Fo.toString(16)})`);
	const s = n.getUint32(4, !0);
	if (1 !== s) throw new Error(`Unsupported VFS image version: ${s} (expected 1)`);
	const o = n.getUint32(8, !0), a = n.getUint32(12, !0);
	if (i.byteLength < Ro + a + 4) throw new Error("VFS image truncated");
	return {
		image: i,
		view: n,
		flags: o,
		sabLen: a
	};
}
function pa(e, t, i, n) {
	const r = Ro + n, s = t.getUint32(r, !0);
	if (s > Do) throw new Error("VFS image lazy metadata exceeds 16777216 bytes");
	if (e.byteLength < r + 4 + s) throw new Error("VFS image truncated (lazy metadata section)");
	const o = r + 4 + s;
	let a = o;
	if (2 & i) {
		if (e.byteLength < o + 4) throw new Error("VFS image truncated (lazy archive section)");
		const i = t.getUint32(o, !0);
		if (i > Vo) throw new Error("VFS image lazy archive metadata exceeds 16777216 bytes");
		if (e.byteLength < o + 4 + i) throw new Error("VFS image truncated (lazy archive payload)");
		a = o + 4 + i;
	}
	return {
		lazyLen: s,
		archiveOffset: o,
		metadataOffset: a
	};
}
function ga(e, t) {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(e));
	} catch (i) {
		const e = i instanceof Error ? i.message : String(i);
		throw new Error(`${t} is not valid UTF-8 JSON: ${e}`);
	}
}
function ma(e) {
	const t = e?.get("content-encoding")?.trim().toLowerCase();
	if (t && "identity" !== t) return;
	const i = e?.get("content-length");
	if (!i) return;
	const n = Number(i);
	return Number.isFinite(n) && n >= 0 ? n : void 0;
}
function ya(e, t = Date.now()) {
	const i = e?.get("retry-after")?.trim();
	if (!i) return;
	let n;
	if (/^\d+$/.test(i)) n = 1e3 * Number(i);
	else {
		const e = Date.parse(i);
		if (!Number.isFinite(e)) return;
		n = Math.max(0, e - t);
	}
	return !Number.isSafeInteger(n) || n < 0 ? void 0 : Math.min(n, 5e3);
}
function wa(e) {
	if ("object" == typeof e && null !== e && "cause" in e) return e.cause;
}
function ba(e) {
	if ("object" == typeof e && null !== e && "name" in e) return "string" == typeof e.name ? e.name : void 0;
}
function ka(e) {
	if ("object" == typeof e && null !== e && "code" in e) return "string" == typeof e.code ? e.code : void 0;
}
function va(e, t) {
	const i = /* @__PURE__ */ new Set();
	let n = e;
	for (let r = 0; void 0 !== n && r < 8; r += 1) {
		if (i.has(n)) return !1;
		if (i.add(n), t(n)) return !0;
		n = wa(n);
	}
	return !1;
}
function Sa(e) {
	return va(e, (e) => "AbortError" === ba(e) || "ABORT_ERR" === ka(e));
}
function Pa(e, t) {
	if (e instanceof ha) {
		if (!(408 === (i = e.status) || 429 === i || i >= 500 && i <= 599)) return null;
		if (void 0 !== e.retryAfterMs) return e.retryAfterMs;
	} else if (!function(e) {
		return !Sa(e) && va(e, (e) => {
			const t = ba(e), i = ka(e);
			return e instanceof TypeError || "NetworkError" === t || "TimeoutError" === t || void 0 !== i && ca.has(i);
		});
	}(e)) return null;
	var i;
	return Math.min(250 * 2 ** t, 5e3);
}
function Ia(e) {
	if (e?.aborted) throw e.reason;
}
function za(e, t) {
	return Ia(t), 0 === e ? Promise.resolve() : new Promise((i, n) => {
		const r = setTimeout(() => a(!1), e), s = () => a(!0, t.reason);
		let o = !1;
		function a(e, a) {
			o || (o = !0, clearTimeout(r), t?.removeEventListener("abort", s), e ? n(a) : i());
		}
		t?.addEventListener("abort", s, { once: !0 }), t?.aborted && s();
	});
}
async function xa(e, t) {
	try {
		await e.body?.cancel(t);
	} catch {}
}
function Ea(e, t) {
	if (1 === e.length) return e[0];
	const i = new Uint8Array(t);
	let n = 0;
	for (const r of e) i.set(r, n), n += r.byteLength;
	return i;
}
function Ma(e) {
	if (void 0 === e) return;
	if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error("Lazy archive integrity must be an object");
	const t = e;
	if (2 !== Object.keys(t).length || !("sha256" in t) || !("bytes" in t)) throw new Error("Lazy archive integrity has unexpected fields");
	if ("string" != typeof t.sha256 || !na.test(t.sha256)) throw new Error("Lazy archive integrity has an invalid SHA-256 digest");
	if (!Number.isSafeInteger(t.bytes) || Number(t.bytes) <= 0 || Number(t.bytes) > Ho) throw new Error(`Lazy archive integrity byte count must be between 1 and ${Ho}`);
	return {
		sha256: t.sha256,
		bytes: Number(t.bytes)
	};
}
function Aa(e, t, i) {
	if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error(`${i} must be an object`);
	const n = e;
	if (Object.keys(n).length !== t.length || t.some((e) => !Object.prototype.hasOwnProperty.call(n, e))) throw new Error(`${i} has unexpected or missing fields`);
	return n;
}
function Ca(e, t, i, n) {
	if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error(`${n} must be an object`);
	const r = e, s = new Set(t);
	if (Object.keys(r).some((e) => !s.has(e)) || i.some((e) => !Object.prototype.hasOwnProperty.call(r, e))) throw new Error(`${n} has unexpected or missing fields`);
	return r;
}
function _a(e, t, i, n) {
	if (!Array.isArray(e) || e.length < i || e.length > n) throw new Error(`${t} must contain ${i} to ${n} items`);
	return e;
}
function La(e, t, i) {
	if ("string" != typeof e || 0 === e.length || e.includes("\0") || new TextEncoder().encode(e).byteLength > i) throw new Error(`${t} is invalid or exceeds ${i} bytes`);
	return e;
}
function Ba(e, t, i, n) {
	if (!Number.isSafeInteger(e) || Number(e) < i || Number(e) > n) throw new Error(`${t} must be an integer between ${i} and ${n}`);
	return Number(e);
}
function Ta(e, t = 1) {
	const i = e, n = "object" == typeof i && null !== i && !Array.isArray(i) && void 0 !== i.source, r = "object" == typeof i && null !== i && !Array.isArray(i) && void 0 !== i.modePolicy, s = Aa(e, [
		"decoder",
		"mediaType",
		"sha256",
		"bytes",
		"expandedBytes",
		"sourceEntryCount",
		"transports",
		...r ? ["modePolicy"] : [],
		...n ? ["source"] : []
	], "Lazy tree content"), o = "zip-v1" === s.decoder ? "application/zip" : "homebrew-bottle-tar-gzip-v1" === s.decoder ? "application/vnd.oci.image.layer.v1.tar+gzip" : null;
	if (null === o || s.mediaType !== o) throw new Error("Lazy tree decoder and media type are inconsistent");
	const a = Ma({
		sha256: s.sha256,
		bytes: s.bytes
	});
	if (!a) throw new Error("Lazy tree integrity is required");
	const c = _a(s.transports, "Lazy tree transports", t, oo).map((e, t) => La(e, `Lazy tree transport ${t}`, Yo));
	if (new Set(c).size !== c.length) throw new Error("Lazy tree transports contain duplicates");
	const h = Ba(s.expandedBytes, "Lazy tree expanded byte count", 0, Go), l = Ba(s.sourceEntryCount, "Lazy tree source entry count", 1, jo), d = n ? function(e, t) {
		if ("homebrew-bottle-tar-gzip-v1" !== t) throw new Error("Lazy tree source inventory is valid only for original bottles");
		const i = Aa(e, [
			"schema",
			"kind",
			"entries"
		], "Lazy tree source inventory");
		if (1 !== i.schema || "homebrew-bottle-tar-gzip-v1" !== i.kind) throw new Error("Lazy tree source inventory has an unsupported identity");
		const n = /* @__PURE__ */ new Map(), r = _a(i.entries, "Lazy tree source entries", 1, jo).map((e, t) => {
			const i = e, r = "object" != typeof i || null === i || Array.isArray(i) ? void 0 : i.type, s = "directory" === r || "file" === r ? [
				"sourcePath",
				"type",
				"mode",
				"size"
			] : "symlink" === r || "hardlink" === r ? [
				"sourcePath",
				"type",
				"mode",
				"size",
				"target"
			] : null;
			if (null === s) throw new Error(`Lazy tree source entry ${t} has invalid type`);
			const o = Aa(e, s, `Lazy tree source entry ${t}`), a = Oa(o.sourcePath, !1, `Lazy tree source entry ${t} path`);
			if (n.has(a)) throw new Error(`Lazy tree source inventory duplicates ${a}`);
			const c = Ba(o.mode, `Lazy tree source entry ${a} mode`, 0, 4095), h = Ba(o.size, `Lazy tree source entry ${a} size`, 0, qo);
			let l;
			if (("directory" === r || "symlink" === r || "hardlink" === r) && 0 !== h) throw new Error(`Lazy tree source ${a} has payload for ${String(r)}`);
			"symlink" === r ? l = La(o.target, `Lazy tree source symlink ${a} target`, Jo) : "hardlink" === r && (l = Oa(o.target, !1, `Lazy tree source hardlink ${a} target`));
			const d = {
				sourcePath: a,
				type: r,
				mode: c,
				size: h,
				...void 0 === l ? {} : { target: l }
			};
			return n.set(a, d), d;
		}), s = r.map((e) => e.sourcePath);
		if (s.some((e, t) => t > 0 && s[t - 1] >= e)) throw new Error("Lazy tree source inventory is not in canonical path order");
		return {
			schema: 1,
			kind: "homebrew-bottle-tar-gzip-v1",
			entries: r
		};
	}(s.source, s.decoder) : void 0, f = r ? s.modePolicy : void 0;
	if (void 0 !== f && ("portable-posix-v1" !== f || "zip-v1" !== s.decoder || n)) throw new Error("Lazy tree mode policy is invalid for its decoder");
	if (void 0 !== d && d.entries.length !== l) throw new Error("Lazy tree source inventory count differs from its content");
	return {
		decoder: s.decoder,
		mediaType: o,
		sha256: a.sha256,
		bytes: a.bytes,
		expandedBytes: h,
		sourceEntryCount: l,
		transports: c,
		...void 0 === f ? {} : { modePolicy: f },
		...void 0 === d ? {} : { source: d }
	};
}
function Fa(e) {
	const t = {
		groups: e.length,
		archiveBytes: 0,
		expandedBytes: 0,
		payloadBytes: 0,
		entries: 0
	};
	for (const i of e) void 0 !== i.content && void 0 !== i.inventory && (t.archiveBytes += i.content.bytes, t.expandedBytes += i.content.expandedBytes, t.payloadBytes += i.inventory.filter((e) => "file" === e.type).reduce((e, t) => e + t.size, 0), t.entries += i.inventory.length + (i.content.source?.entries.length ?? 0));
	return t;
}
function Ra(e) {
	(function(e, t = "Deferred tree collection") {
		for (const [i, n] of Object.entries(e)) if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${t} ${i} usage is invalid`);
		if (e.groups > go) throw new Error(`${t} exceeds the ${go}-group cap`);
		if (e.archiveBytes > lo) throw new Error(`${t} exceeds the archive-byte cap`);
		if (e.expandedBytes > fo) throw new Error(`${t} exceeds the expansion cap`);
		if (e.payloadBytes > uo) throw new Error(`${t} exceeds the payload-byte cap`);
		if (e.entries > po) throw new Error(`${t} exceeds the entry-count cap`);
	})(e, "Serialized lazy tree collection");
}
function Ua(e) {
	for (const [t, i] of e.entries()) if (i.kind === sa || i.kind === oa || i.kind === aa) Ha(i, i.kind);
	else {
		if (i.kind !== ra) throw new Error(`Serialized lazy archive group ${t} has an unsupported kind`);
		Ka(i, !1);
	}
	(function(e) {
		Ra(Fa(e));
	})(e), function(e) {
		const t = /* @__PURE__ */ new Map();
		for (const i of e) {
			const e = i.activation?.atomicGroup;
			if (void 0 === e) continue;
			if (!Wa(e)) throw new Error(`Serialized lazy atomic activation group ${e.id} is unsealed`);
			let n = t.get(e.id);
			if (void 0 === n) n = {
				expectedCount: e.expectedCount,
				cohortSha256: e.cohortSha256,
				members: /* @__PURE__ */ new Set(),
				descriptors: /* @__PURE__ */ new Set()
			}, t.set(e.id, n);
			else if (n.expectedCount !== e.expectedCount || n.cohortSha256 !== e.cohortSha256) throw new Error(`Serialized lazy atomic activation group ${e.id} has inconsistent seals`);
			if (n.members.has(e.member) || n.descriptors.has(e.descriptorSha256)) throw new Error(`Serialized lazy atomic activation group ${e.id} duplicates a member`);
			n.members.add(e.member), n.descriptors.add(e.descriptorSha256);
		}
		for (const [i, n] of t) if (n.members.size !== n.expectedCount) throw new Error(`Serialized lazy atomic activation group ${i} has ${n.members.size} of ${n.expectedCount} members`);
	}(e);
}
function $a(e) {
	const t = new Map(e.map((e) => [e.sourcePath, e])), i = /* @__PURE__ */ new Map();
	for (const n of e) {
		if ("hardlink" !== n.type || i.has(n.sourcePath)) continue;
		const e = [], r = /* @__PURE__ */ new Set();
		let s, o = n;
		for (; "hardlink" === o.type && (s = i.get(o.sourcePath), void 0 === s);) {
			if (r.has(o.sourcePath)) throw new Error(`Lazy tree source hardlink cycle includes ${o.sourcePath}`);
			r.add(o.sourcePath), e.push(o);
			const i = t.get(o.target);
			if (void 0 === i) throw new Error(`Lazy tree source hardlink ${o.sourcePath} target is absent`);
			if ("file" !== i.type && "hardlink" !== i.type) throw new Error(`Lazy tree source hardlink ${o.sourcePath} target is not regular`);
			o = i;
		}
		void 0 === s && (s = o);
		for (const t of e) i.set(t.sourcePath, s);
	}
	return i;
}
function Oa(e, t, i, n = !1) {
	if ("string" != typeof e || 0 === e.length || new TextEncoder().encode(e).byteLength > Zo || e.includes("\0") || e.includes("\\") || e.startsWith("/") !== t) throw new Error(`${i} is not a canonical ${t ? "absolute" : "relative"} path`);
	if (n && t && "/" === e) return e;
	if (e.slice(t ? 1 : 0).split("/").some((e) => "" === e || "." === e || ".." === e)) throw new Error(`${i} has an unsafe path segment`);
	return e;
}
function Na(e) {
	const t = "object" != typeof e || null === e || Array.isArray(e) ? null : e, i = null !== t && (Object.hasOwn(t, "descriptorSha256") || Object.hasOwn(t, "expectedCount") || Object.hasOwn(t, "cohortSha256")), n = Aa(e, i ? [
		"id",
		"member",
		"descriptorSha256",
		"expectedCount",
		"cohortSha256"
	] : ["id", "member"], "Lazy tree atomic activation membership"), r = La(n.id, "Lazy tree atomic activation group", ta), s = La(n.member, "Lazy tree atomic activation member", ta);
	if (!/^[a-z0-9][a-z0-9:._-]*$/.test(r) || !/^[a-z0-9][a-z0-9:+._/-]*$/.test(s) || s.includes("//") || s.endsWith("/")) throw new Error("Lazy tree atomic activation membership is invalid");
	if (!i) return {
		id: r,
		member: s
	};
	const o = La(n.descriptorSha256, "Lazy tree atomic member descriptor digest", 64), a = La(n.cohortSha256, "Lazy tree atomic cohort digest", 64);
	if (!na.test(o) || !na.test(a)) throw new Error("Lazy tree atomic activation digest is invalid");
	return {
		id: r,
		member: s,
		descriptorSha256: o,
		expectedCount: Ba(n.expectedCount, "Lazy tree atomic activation expected member count", 1, Xo),
		cohortSha256: a
	};
}
function Wa(e) {
	return void 0 !== e.descriptorSha256 && void 0 !== e.expectedCount && void 0 !== e.cohortSha256;
}
function Da(e, t, i, n, r = 1) {
	const s = Ta(e, r), o = la(i), a = Aa(n, [
		"mode",
		"capabilities",
		"roots",
		..."object" == typeof n && null !== n && !Array.isArray(n) && Object.hasOwn(n, "atomicGroup") ? ["atomicGroup"] : []
	], "Lazy tree activation");
	if ("boot-prefetch" !== a.mode && "first-use" !== a.mode) throw new Error("Lazy tree activation mode is invalid");
	const c = _a(a.capabilities, "Lazy tree activation capabilities", 1, Qo).map((e, t) => {
		const i = La(e, `Lazy tree activation capability ${t}`, ho);
		if (!/^[a-z0-9][a-z0-9:._-]*$/.test(i)) throw new Error(`Lazy tree activation capability ${t} is invalid`);
		return i;
	}), h = _a(a.roots, "Lazy tree activation roots", 1, ea).map((e, t) => Oa(e, !0, `Lazy tree activation root ${t}`, !0));
	if (new Set(c).size !== c.length || new Set(h).size !== h.length) throw new Error("Lazy tree activation contains duplicates");
	const l = void 0 === a.atomicGroup ? void 0 : Na(a.atomicGroup);
	if (void 0 !== l && "first-use" !== a.mode) throw new Error("Lazy tree atomic activation group requires a valid first-use identity");
	const d = {
		mode: a.mode,
		capabilities: c,
		roots: h,
		...void 0 === l ? {} : { atomicGroup: l }
	}, f = _a(t, "Lazy tree inventory", 1, jo), u = [], p = /* @__PURE__ */ new Map(), g = /* @__PURE__ */ new Map(), m = void 0 === s.source ? void 0 : new Map(s.source.entries.map((e) => [e.sourcePath, e])), y = void 0 === s.source ? void 0 : $a(s.source.entries);
	let w = 0;
	for (const [v, S] of f.entries()) {
		if ("object" != typeof S || null === S || Array.isArray(S)) throw new Error(`Lazy tree entry ${v} must be an object`);
		const e = S.type, t = "directory" === e ? [
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
		if (!t) throw new Error(`Lazy tree entry ${v} has an invalid type`);
		const i = Aa(S, [...t, ...void 0 === m ? [] : ["materialization"]], `Lazy tree entry ${v}`), n = Oa(i.vfsPath, !0, `Lazy tree entry ${v} VFS path`), r = Oa(i.sourcePath, !1, `Lazy tree entry ${v} source path`), a = void 0 === m ? void 0 : i.materialization;
		if (void 0 !== m && "archive" !== a && "archive-homebrew-relocate" !== a && "archive-copy" !== a && "archive-copy-mode" !== a && "descriptor" !== a) throw new Error(`Lazy tree entry ${n} has invalid materialization provenance`);
		if ("/" !== o && n !== o && !n.startsWith(`${o}/`)) throw new Error(`Lazy tree entry ${n} escapes its mount prefix`);
		if (p.has(n)) throw new Error(`Lazy tree duplicates VFS path ${n}`);
		const c = Ba(i.mode, `Lazy tree entry ${n} mode`, 0, 4095), h = Ba(i.size, `Lazy tree entry ${n} size`, 0, qo);
		let l, d;
		if ("directory" === e) {
			if (0 !== h) throw new Error(`Lazy tree directory ${n} has nonzero size`);
		} else if ("symlink" === e) {
			if (l = La(i.target, `Lazy tree symlink ${n} target`, Jo), new TextEncoder().encode(l).byteLength !== h) throw new Error(`Lazy tree symlink ${n} size differs from its target`);
		} else d = La(i.inodeGroup, `Lazy tree entry ${n} inode group`, Zo), "hardlink" === e && (l = Oa(i.target, !0, `Lazy tree hardlink ${n} target`));
		if ("hardlink" !== e && (w += h, w > qo)) throw new Error("Lazy tree inventory exceeds the expansion limit");
		const f = {
			vfsPath: n,
			sourcePath: r,
			...void 0 === a ? {} : { materialization: a },
			type: e,
			mode: c,
			size: h,
			...void 0 === l ? {} : { target: l },
			...void 0 === d ? {} : { inodeGroup: d }
		};
		if (void 0 === m) {
			const e = g.get(r);
			if (e) {
				if ("zip-v1" !== s.decoder || "hardlink" !== f.type || e.inodeGroup !== f.inodeGroup) throw new Error(`Lazy tree duplicates source path ${r}`);
			} else {
				if ("zip-v1" === s.decoder && "hardlink" === f.type) throw new Error(`Lazy ZIP hardlink ${n} does not reuse a canonical source path`);
				g.set(r, f);
			}
		} else if ("descriptor" === f.materialization) {
			if ("directory" !== f.type && "symlink" !== f.type) throw new Error(`Lazy tree descriptor entry ${n} is not structural`);
			if (m.has(r)) throw new Error(`Lazy tree descriptor entry ${n} impersonates a source member`);
		} else {
			const e = m.get(r);
			if (void 0 === e) throw new Error(`Lazy tree entry ${n} names absent source ${r}`);
			if ("archive-copy" === f.materialization || "archive-copy-mode" === f.materialization) {
				if ("file" !== f.type || "file" !== e.type || "archive-copy" === f.materialization && f.mode !== e.mode) throw new Error(`Lazy tree archive copy ${n} differs from its source`);
			} else if ("archive-homebrew-relocate" === f.materialization) {
				if ("file" !== f.type && "hardlink" !== f.type || e.type !== f.type || "file" === f.type && e.mode !== f.mode) throw new Error(`Lazy tree receipt-relocated entry ${n} differs from its source`);
			} else if (e.type !== f.type || "symlink" === f.type && e.target !== f.target || "hardlink" !== f.type && e.mode !== f.mode) throw new Error(`Lazy tree archive entry ${n} differs from its source`);
		}
		u.push(f), p.set(n, f);
	}
	for (const v of u) {
		const e = v.vfsPath.split("/").filter(Boolean);
		for (let t = 1; t < e.length; t += 1) {
			const i = `/${e.slice(0, t).join("/")}`, n = p.get(i);
			if (n && "directory" !== n.type) throw new Error(`Lazy tree entry ${v.vfsPath} descends through non-directory ${i}`);
		}
	}
	const b = function(e, t) {
		const i = /* @__PURE__ */ new Map(), n = /* @__PURE__ */ new Map();
		for (const o of e) {
			if (i.has(o.path)) throw new Error(`${t} duplicates path ${o.path}`);
			if (i.set(o.path, o), "file" === o.type) {
				if (!o.inodeGroup) throw new Error(`${t} file ${o.path} has no inode group`);
				if (n.has(o.inodeGroup)) throw new Error(`${t} inode group ${o.inodeGroup} has multiple files`);
				n.set(o.inodeGroup, o);
			}
		}
		const r = /* @__PURE__ */ new Set(), s = /* @__PURE__ */ new Map();
		for (const o of e) {
			if ("hardlink" !== o.type || s.has(o.path)) continue;
			const e = [];
			let a, c = o;
			for (; "hardlink" === c.type;) {
				const n = s.get(c.path);
				if (n) {
					a = n;
					break;
				}
				if (r.has(c.path)) throw new Error(`${t} hardlink cycle reaches ${c.path}`);
				if (r.add(c.path), e.push(c), !c.target) throw new Error(`${t} hardlink ${c.path} has no target`);
				const o = i.get(c.target);
				if (!o) throw new Error(`${t} hardlink ${c.path} target ${c.target} is missing`);
				if ("file" !== o.type && "hardlink" !== o.type || !c.inodeGroup || o.inodeGroup !== c.inodeGroup || o.size !== c.size || o.mode !== c.mode) throw new Error(`${t} hardlink ${c.path} has an invalid target`);
				c = o;
			}
			a ??= "file" === c.type ? c : void 0;
			const h = n.get(o.inodeGroup ?? "");
			if (!a || a !== h) throw new Error(`${t} hardlink ${o.path} does not resolve to its inode`);
			for (let i = e.length - 1; i >= 0; i -= 1) {
				const o = e[i];
				if (n.get(o.inodeGroup ?? "") !== a) throw new Error(`${t} hardlink ${o.path} does not resolve to its inode`);
				r.delete(o.path), s.set(o.path, a);
			}
		}
		return {
			canonicalByGroup: n,
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
	if (void 0 !== m) {
		const e = /* @__PURE__ */ new Set();
		for (const t of u) {
			if ("archive-homebrew-relocate" !== t.materialization) continue;
			const i = m.get(t.sourcePath), n = "file" === i.type ? i : y.get(i.sourcePath);
			if ("file" !== n?.type) throw new Error(`Lazy tree receipt-relocated entry ${t.vfsPath} is not regular`);
			e.add(n.sourcePath);
		}
		for (const t of u) {
			if ("descriptor" === t.materialization || "file" !== t.type && "hardlink" !== t.type) continue;
			const i = m.get(t.sourcePath), n = "file" === i.type ? i : y.get(i.sourcePath);
			if ("file" !== n?.type || !e.has(n.sourcePath) && t.size !== n.size) throw new Error(`Lazy tree archive entry ${t.vfsPath} differs from its source`);
		}
		for (const t of u) {
			if ("hardlink" !== t.type || "archive" !== t.materialization && "archive-homebrew-relocate" !== t.materialization) continue;
			const e = m.get(t.sourcePath), i = p.get(t.target), n = y.get(e.sourcePath);
			if (e.target !== i?.sourcePath || "file" !== n?.type || n.mode !== t.mode || i?.mode !== t.mode) throw new Error(`Lazy tree hardlink ${t.vfsPath} differs from its source`);
		}
	}
	if (s.sourceEntryCount !== (void 0 === m ? g.size : m.size)) throw new Error("Lazy tree source entry count differs from its inventory");
	if (void 0 === s.source && s.expandedBytes < w || "zip-v1" === s.decoder && s.expandedBytes !== w) throw new Error("Lazy tree expanded byte count differs from its inventory");
	for (const v of d.roots) if ("/" !== v && !u.some((e) => e.vfsPath === v || e.vfsPath.startsWith(`${v}/`))) throw new Error(`Lazy tree activation root ${v} is not owned by its inventory`);
	const k = /* @__PURE__ */ new Map();
	for (const v of u) "file" === v.type && k.set(v.inodeGroup, v);
	if (k.size !== b.canonicalByGroup.size) throw new Error("Lazy tree regular inode inventory is inconsistent");
	return {
		content: s,
		entries: u,
		mountPrefix: o,
		activation: d,
		canonicalByGroup: k
	};
}
function Va(e) {
	return JSON.stringify([
		e.sourcePath,
		e.type,
		e.inodeGroup,
		e.target
	]);
}
function Ka(e, t) {
	const i = Ca(e, [
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
	if (void 0 === i.kind) {
		if (!t) throw new Error("Serialized lazy archive is missing its kind discriminator");
	} else if (i.kind !== ra) throw new Error("Serialized legacy lazy archive has an unsupported kind");
	const n = La(i.url, "Serialized legacy lazy archive URL", Yo), r = la(i.mountPrefix), s = Ma(i.integrity);
	if (void 0 !== i.content) {
		if (!t || void 0 !== i.kind) throw new Error("Typed legacy lazy archives cannot carry generic content");
		const e = Ta(i.content);
		if ("zip-v1" !== e.decoder || 1 !== e.transports.length || e.transports[0] !== n || !s || e.sha256 !== s.sha256 || e.bytes !== s.bytes) throw new Error("Untagged legacy ZIP content identity is inconsistent");
	}
	if (!1 !== i.materialized) throw new Error("Serialized legacy lazy archive must describe pending content");
	const o = /* @__PURE__ */ new Set(), a = _a(i.entries, "Serialized legacy lazy archive entries", 1, jo).map((e, t) => {
		const i = Ca(e, [
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
		], `Serialized legacy lazy archive entry ${t}`), n = Oa(i.vfsPath, !0, `Serialized legacy lazy archive entry ${t} VFS path`);
		if (o.has(n)) throw new Error(`Serialized legacy lazy archive duplicates path ${n}`);
		o.add(n);
		const r = Ba(i.ino, `Serialized legacy lazy archive entry ${n} inode`, 1, Number.MAX_SAFE_INTEGER), s = void 0 === i.generation ? void 0 : Ba(i.generation, `Serialized legacy lazy archive entry ${n} generation`, 0, Number.MAX_SAFE_INTEGER), a = void 0 === i.dataSequence ? void 0 : Ba(i.dataSequence, `Serialized legacy lazy archive entry ${n} data sequence`, 0, Number.MAX_SAFE_INTEGER), c = Ba(i.size, `Serialized legacy lazy archive entry ${n} size`, 0, qo);
		if (!1 !== i.isSymlink || !1 !== i.deleted || void 0 !== i.materialized && !1 !== i.materialized) throw new Error(`Serialized legacy lazy archive entry ${n} is not pending`);
		if (void 0 !== i.type && "file" !== i.type) throw new Error(`Serialized legacy lazy archive entry ${n} has an invalid type`);
		const h = void 0 === i.archivePath ? void 0 : Oa(i.archivePath, !1, `Serialized legacy lazy archive entry ${n} archive path`), l = void 0 === i.sourcePath ? void 0 : Oa(i.sourcePath, !1, `Serialized legacy lazy archive entry ${n} source path`), d = void 0 === i.inodeGroup ? void 0 : La(i.inodeGroup, `Serialized legacy lazy archive entry ${n} inode group`, Zo);
		if (void 0 !== i.target) throw new Error(`Serialized legacy lazy archive entry ${n} has a link target`);
		return {
			vfsPath: n,
			ino: r,
			...void 0 === s ? {} : { generation: s },
			...void 0 === a ? {} : { dataSequence: a },
			size: c,
			isSymlink: !1,
			deleted: !1,
			materialized: !1,
			...void 0 === h ? {} : { archivePath: h },
			...void 0 === l ? {} : { sourcePath: l },
			type: "file",
			...void 0 === d ? {} : { inodeGroup: d }
		};
	});
	return {
		kind: ra,
		url: n,
		mountPrefix: r,
		...void 0 === s ? {} : { integrity: s },
		materialized: !1,
		entries: a
	};
}
function Ha(e, t) {
	const i = Aa(e, [
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
	if (i.kind !== t) throw new Error("Serialized lazy tree has an unsupported kind");
	const n = Da(i.content, i.inventory, i.mountPrefix, i.activation);
	if (t !== aa && t === sa != (void 0 === n.content.source)) throw new Error(t === sa ? "Serialized deferred-tree-v1 cannot contain original-bottle source metadata" : "Serialized deferred-tree-v2 requires original-bottle source metadata");
	const r = n.activation.atomicGroup;
	if (t === aa ? void 0 === r || !Wa(r) : void 0 !== r) throw new Error(t === aa ? "Serialized deferred-tree-v3 requires a sealed atomic activation" : "Atomic activation requires serialized deferred-tree-v3");
	const s = La(i.url, "Serialized lazy tree URL", Yo);
	if (s !== n.content.transports[0]) throw new Error("Serialized lazy tree URL differs from its primary transport");
	const o = Ma(i.integrity);
	if (!o || o.sha256 !== n.content.sha256 || o.bytes !== n.content.bytes) throw new Error("Serialized lazy tree integrity differs from its content");
	if (!1 !== i.materialized) throw new Error("Serialized lazy tree must describe pending content");
	const a = new Map(n.entries.map((e) => [e.vfsPath, e])), c = new Map(n.entries.map((e) => [Va(e), e])), h = _a(i.entries, "Serialized lazy tree entries", 0, jo), l = /* @__PURE__ */ new Set(), d = h.map((e, t) => {
		const i = Ca(e, [
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
		], `Serialized lazy tree entry ${t}`), r = Oa(i.vfsPath, !0, `Serialized lazy tree entry ${t} VFS path`);
		if (l.has(r)) throw new Error(`Serialized lazy tree duplicates pending path ${r}`);
		l.add(r);
		const s = Oa(i.sourcePath, !1, `Serialized lazy tree entry ${t} source path`), o = Oa(i.archivePath, !1, `Serialized lazy tree entry ${t} archive path`), h = a.get(r), d = c.get(Va({
			sourcePath: s,
			type: "string" == typeof i.type ? i.type : void 0,
			inodeGroup: "string" == typeof i.inodeGroup ? i.inodeGroup : void 0,
			target: "string" == typeof i.target ? i.target : void 0
		})) ?? h;
		if (!d || "file" !== d.type && "hardlink" !== d.type || void 0 !== h?.inodeGroup && h.inodeGroup !== d.inodeGroup) throw new Error(`Serialized lazy tree entry ${r} is absent from its inventory`);
		const f = n.canonicalByGroup.get(d.inodeGroup);
		if (i.type !== d.type || i.inodeGroup !== d.inodeGroup || i.size !== d.size || o !== f?.sourcePath || i.target !== d.target || !1 !== i.isSymlink || !1 !== i.deleted || !1 !== i.materialized) throw new Error(`Serialized lazy tree entry ${r} disagrees with its inventory`);
		return {
			vfsPath: r,
			ino: Ba(i.ino, `Serialized lazy tree entry ${r} inode`, 1, Number.MAX_SAFE_INTEGER),
			generation: Ba(i.generation, `Serialized lazy tree entry ${r} generation`, 0, Number.MAX_SAFE_INTEGER),
			dataSequence: Ba(i.dataSequence, `Serialized lazy tree entry ${r} data sequence`, 0, Number.MAX_SAFE_INTEGER),
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
	for (const f of n.entries) if (void 0 !== n.activation.atomicGroup && ("file" === f.type || "hardlink" === f.type) && !l.has(f.vfsPath)) throw new Error(`Serialized lazy tree omits pending path ${f.vfsPath}`);
	return {
		kind: t,
		content: n.content,
		inventory: n.entries,
		activation: n.activation,
		url: s,
		mountPrefix: n.mountPrefix,
		integrity: o,
		materialized: !1,
		entries: d
	};
}
async function Ga(e, t) {
	const i = globalThis.crypto?.subtle;
	if (!i) throw new Error(`${t} SHA-256 verification is unavailable`);
	const n = new Uint8Array(e.byteLength);
	n.set(e);
	const r = new Uint8Array(await i.digest("SHA-256", n));
	return Array.from(r, (e) => e.toString(16).padStart(2, "0")).join("");
}
async function qa(e, t, i) {
	if (void 0 === i) return;
	if (e.byteLength !== i.bytes) throw new Error(`Lazy ${t} byte count ${e.byteLength} does not match expected ${i.bytes}`);
	const n = await Ga(e, `Lazy ${t}`);
	if (n !== i.sha256) throw new Error(`Lazy ${t} SHA-256 ${n} does not match expected ${i.sha256}`);
}
function ja(e, t) {
	const i = t.map(({ member: e, descriptorSha256: t }) => ({
		member: e,
		descriptorSha256: t
	}));
	return new TextEncoder().encode(JSON.stringify({
		schema: 1,
		id: e,
		members: i.sort((e, t) => e.member < t.member ? -1 : e.member > t.member ? 1 : 0)
	}));
}
function Xa(e, t = e.transports) {
	const i = [...t];
	Object.freeze(i);
	const n = void 0 === e.source ? void 0 : {
		schema: 1,
		kind: "homebrew-bottle-tar-gzip-v1",
		entries: e.source.entries.map((e) => Object.freeze({ ...e }))
	};
	return void 0 !== n && (Object.freeze(n.entries), Object.freeze(n)), Object.freeze({
		decoder: e.decoder,
		mediaType: e.mediaType,
		sha256: e.sha256,
		bytes: e.bytes,
		expandedBytes: e.expandedBytes,
		sourceEntryCount: e.sourceEntryCount,
		transports: i,
		...void 0 === e.modePolicy ? {} : { modePolicy: e.modePolicy },
		...void 0 === n ? {} : { source: n }
	});
}
function Za(e) {
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
function Ja(e) {
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
function Ya(e, t, i) {
	const n = e.content, r = e.inventory, s = e.activation, o = e.integrity, a = e.entries, c = e.url, h = e.mountPrefix, l = e.materialized, d = s?.atomicGroup;
	if (void 0 === n || void 0 === r || void 0 === s || void 0 === d || "first-use" !== s.mode || d.id !== t || d.member !== i || l) throw new Error(`Lazy atomic activation member ${i} changed before snapshot`);
	if (o?.sha256 !== n.sha256 || o?.bytes !== n.bytes || c !== (n.transports[0] ?? "")) throw new Error(`Lazy atomic activation member ${i} has inconsistent integrity`);
	const f = Xa(n), u = function(e) {
		const t = e.map((e) => Object.freeze({ ...e }));
		return Object.freeze(t), t;
	}(r), p = function(e, t, i) {
		const n = [...e.capabilities], r = [...e.roots];
		return Object.freeze(n), Object.freeze(r), Object.freeze({
			mode: e.mode,
			capabilities: n,
			roots: r,
			atomicGroup: Object.freeze({
				id: t,
				member: i
			})
		});
	}(s, t, i), g = /* @__PURE__ */ new Map();
	for (const k of u) "file" === k.type && g.set(k.inodeGroup, k.sourcePath);
	const m = u.filter((e) => "directory" !== e.type);
	if (a.size !== m.length) throw new Error(`Lazy atomic activation member ${i} has inconsistent runtime entries`);
	const y = m.map((e) => {
		const t = a.get(e.vfsPath), n = "symlink" === e.type, r = n ? e.sourcePath : g.get(e.inodeGroup), s = void 0 !== t && (t.sourcePath === e.sourcePath && t.type === e.type && t.target === e.target || "hardlink" === e.type && t.sourcePath === r && "file" === t.type && void 0 === t.target), o = void 0 === t ? ["missing"] : [
			void 0 === r ? "archivePath source" : void 0,
			void 0 === t.generation ? "generation" : void 0,
			void 0 === t.dataSequence ? "dataSequence" : void 0,
			t.size !== e.size ? "size" : void 0,
			t.isSymlink !== n ? "symlink kind" : void 0,
			t.deleted ? "deletion state" : void 0,
			t.materialized !== n ? "materialization state" : void 0,
			t.archivePath !== r ? "archivePath" : void 0,
			s ? void 0 : "descriptor mapping",
			t.inodeGroup !== e.inodeGroup ? "inode group" : void 0
		].filter((e) => void 0 !== e);
		if (o.length > 0) throw new Error(`Lazy atomic activation member ${i} has inconsistent mapping at ${e.vfsPath}: ${o.join(", ")}`);
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
			archivePath: r,
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
	}), b = function(e, t, i, n) {
		const r = n.atomicGroup;
		if (void 0 === r) throw new Error("Lazy atomic member is missing its typed tree descriptor");
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
			mountPrefix: i,
			inventory: [...t].sort((e, t) => e.vfsPath < t.vfsPath ? -1 : e.vfsPath > t.vfsPath ? 1 : 0),
			activation: {
				mode: n.mode,
				capabilities: n.capabilities,
				roots: n.roots,
				atomicGroup: {
					id: r.id,
					member: r.member
				}
			}
		};
		return new TextEncoder().encode(JSON.stringify(s));
	}(f, u, h, p);
	return Object.freeze({
		id: t,
		member: i,
		descriptorBytes: b,
		content: f,
		inventory: u,
		activation: p,
		url: f.transports[0] ?? "",
		mountPrefix: h,
		integrity: w,
		entries: y
	});
}
function Qa(e, t, i, n) {
	return Object.freeze({
		...e,
		descriptorSha256: t,
		expectedCount: i,
		cohortSha256: n
	});
}
function ec(e, t) {
	return !(e.id !== t.id || e.member !== t.member || e.url !== t.url || e.mountPrefix !== t.mountPrefix || e.integrity.sha256 !== t.integrity.sha256 || e.integrity.bytes !== t.integrity.bytes || e.content.transports.length !== t.content.transports.length || e.content.transports.some((e, i) => e !== t.content.transports[i]) || !function(e, t) {
		if (e.byteLength !== t.byteLength) return !1;
		for (let i = 0; i < e.byteLength; i++) if (e[i] !== t[i]) return !1;
		return !0;
	}(e.descriptorBytes, t.descriptorBytes) || e.entries.length !== t.entries.length) && e.entries.every((e, i) => {
		const n = t.entries[i];
		return void 0 !== n && e.vfsPath === n.vfsPath && function(e, t) {
			return e.ino === t.ino && e.generation === t.generation && e.dataSequence === t.dataSequence && e.size === t.size && e.isSymlink === t.isSymlink && e.deleted === t.deleted && e.materialized === t.materialized && e.archivePath === t.archivePath && e.sourcePath === t.sourcePath && e.type === t.type && e.inodeGroup === t.inodeGroup && e.target === t.target;
		}(e, n);
	});
}
function tc(e, t) {
	const i = Xa(e.content, e.content.transports.map(t));
	return Object.freeze({
		...e,
		content: i,
		url: i.transports[0] ?? ""
	});
}
function ic(e) {
	return {
		paths: Array.from(e.paths),
		expectedIno: e.ino,
		expectedGeneration: e.generation,
		expectedDataSequence: e.dataSequence,
		data: e.content
	};
}
var nc = class e {
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
		return (e.mode & Uo) === $o && 0 === e.size && e.dataSequence <= 1;
	}
	reconcileLazyIdentityState(t) {
		for (const [e, i] of this.lazyFiles) {
			const n = t.get(e);
			n && n.dataSequence === i.dataSequence && 0 !== n.paths.length ? (i.paths = new Set(n.paths), i.paths.has(i.path) || (i.path = n.paths[0])) : this.lazyFiles.delete(e);
		}
		this.lazyArchiveInodes.clear();
		for (const i of this.lazyArchiveGroups) {
			const n = this.lazyAtomicGroupByTree.get(i), r = this.sealedLazyAtomicStates.get(i);
			if (void 0 !== r) {
				if (!n?.committed) for (const n of r.snapshot.entries) {
					if (n.isSymlink || n.materialized || void 0 === n.generation) continue;
					const r = e.inodeKey(n.ino, n.generation), s = t.get(r);
					void 0 !== s && s.dataSequence === n.dataSequence && s.paths.length > 0 && this.lazyArchiveInodes.set(r, i);
				}
				continue;
			}
			const s = void 0 !== i.content && void 0 !== i.inventory && !i.materialized, o = /* @__PURE__ */ new Map();
			for (const t of i.entries.values()) {
				if (t.deleted || t.materialized || void 0 === t.generation) continue;
				const i = e.inodeKey(t.ino, t.generation);
				o.has(i) || o.set(i, t);
			}
			const a = new Map(Array.from(i.entries.entries()).filter(([, e]) => e.deleted || e.isSymlink && !e.deleted));
			for (const [e, c] of o) {
				const n = t.get(e);
				if (n && n.dataSequence === (c.dataSequence ?? 0)) {
					for (const e of n.paths) a.set(e, {
						...c,
						ino: n.ino,
						generation: n.generation,
						dataSequence: n.dataSequence,
						deleted: !1,
						materialized: !1
					});
					n.paths.length > 0 && this.lazyArchiveInodes.set(e, i);
				}
			}
			i.entries = a, i.materialized = !Array.from(a.values()).some((e) => !e.isSymlink && !e.materialized) && !s && (void 0 === n || n.committed);
		}
	}
	validatePendingLazyTreeNamespaceState(e) {
		const t = /* @__PURE__ */ new Map();
		for (const i of e.values()) for (const e of i.paths) {
			if (t.has(e)) throw new Error(`SharedFS namespace identity is ambiguous at ${e}`);
			t.set(e, i);
		}
		for (const i of this.lazyArchiveGroups) {
			const e = this.lazyAtomicGroupByTree.get(i), n = this.sealedLazyAtomicStates.get(i)?.snapshot;
			if (e?.committed || void 0 === n && i.materialized || void 0 === n && (void 0 === i.content || void 0 === i.inventory)) continue;
			const r = n?.inventory ?? i.inventory, s = void 0 === n ? i.entries : new Map(n.entries.map((e) => [e.vfsPath, e])), o = /* @__PURE__ */ new Map(), a = /* @__PURE__ */ new Map(), c = /* @__PURE__ */ new Set();
			for (const t of s.values()) t.deleted && void 0 !== t.inodeGroup && c.add(t.inodeGroup);
			for (const t of r) {
				if ("file" !== t.type && "hardlink" !== t.type) continue;
				o.set(t.inodeGroup, (o.get(t.inodeGroup) ?? 0) + 1);
				const e = a.get(t.inodeGroup) ?? [];
				e.push(t.vfsPath), a.set(t.inodeGroup, e);
			}
			const h = new Set([...c].filter((e) => a.get(e)?.every((e) => !t.has(e))));
			for (const i of r) {
				const e = t.get(i.vfsPath);
				if (void 0 === e) {
					if (void 0 !== i.inodeGroup && h.has(i.inodeGroup)) continue;
					throw new Error(`Lazy tree namespace entry ${i.vfsPath} is missing from the captured filesystem state`);
				}
				const n = "directory" === i.type ? Oo : "symlink" === i.type ? No : $o;
				if ((e.mode & Uo) !== n || (4095 & e.mode) !== i.mode) throw new Error(`Lazy tree namespace entry ${i.vfsPath} disagrees with its captured type or mode`);
				if ("directory" === i.type) continue;
				const r = s.get(i.vfsPath);
				if (void 0 === r || r.ino !== e.ino || r.generation !== e.generation || r.dataSequence !== e.dataSequence) throw new Error(`Lazy tree namespace entry ${i.vfsPath} changed identity before serialization`);
				if ("symlink" === i.type) {
					const t = new TextEncoder().encode(i.target).byteLength;
					if (1 !== e.linkCount || e.size !== i.size || e.size !== t || e.symlinkTarget !== i.target) throw new Error(`Lazy tree symlink ${i.vfsPath} disagrees with its captured inventory`);
					continue;
				}
				if (0 !== e.size || e.linkCount !== o.get(i.inodeGroup)) throw new Error(`Lazy tree stub ${i.vfsPath} has changed data or undeclared aliases`);
			}
		}
	}
	lazyFileForStat(t) {
		const i = e.inodeKey(t.ino, t.generation), n = this.lazyFiles.get(i);
		if (!n || n.dataSequence === t.dataSequence) return n;
		this.lazyFiles.delete(i);
	}
	lazyArchiveEntriesForRead(e) {
		const t = this.lazyAtomicGroupByTree.get(e), i = this.sealedLazyAtomicStates.get(e);
		return void 0 === i || t?.committed ? Array.from(e.entries, ([e, t]) => ({
			vfsPath: e,
			...t
		})) : i.snapshot.entries;
	}
	lazyArchiveForStat(t) {
		const i = e.inodeKey(t.ino, t.generation), n = this.lazyArchiveInodes.get(i);
		if (!n) return;
		const r = this.lazyArchiveEntriesForRead(n).filter((e) => e.ino === t.ino && e.generation === t.generation && !e.deleted && !e.materialized);
		if (r.some((e) => e.dataSequence === t.dataSequence)) return n;
		if (this.lazyArchiveInodes.delete(i), void 0 === this.sealedLazyAtomicStates.get(n)) for (const e of r) e.materialized = !0;
	}
	lazyBackingForStat(t) {
		const i = e.inodeKey(t.ino, t.generation), n = this.lazyFiles.get(i);
		if (n) return {
			token: n,
			path: n.path
		};
		const r = this.lazyArchiveInodes.get(i);
		if (!r) return null;
		const s = this.lazyArchiveEntriesForRead(r).find((e) => e.ino === t.ino && e.generation === t.generation && !e.deleted && !e.materialized)?.vfsPath;
		if (void 0 === s) return null;
		const o = this.lazyAtomicGroupByTree.get(r);
		return void 0 === o ? {
			token: r,
			path: s
		} : {
			token: o.token,
			path: s,
			atomicGroup: o
		};
	}
	lazyBackingForPath(e) {
		const t = this.lazyArchiveGroups.find((t) => {
			const i = this.lazyAtomicGroupByTree.get(t), n = this.sealedLazyAtomicStates.get(t)?.snapshot, r = void 0 === n ? !t.materialized : !i?.committed, s = n?.content ?? t.content, o = n?.inventory ?? t.inventory, a = n?.activation ?? t.activation, c = n?.entries ?? Array.from(t.entries.values());
			return r && void 0 !== s && void 0 !== o && void 0 !== a && c.every((e) => e.deleted || e.materialized || e.isSymlink) && a.roots.some((t) => "/" === t || e === t || e.startsWith(`${t}/`));
		});
		if (t) {
			const i = this.lazyAtomicGroupByTree.get(t);
			return {
				token: i?.token ?? t,
				path: e,
				directGroup: t,
				...void 0 === i ? {} : { atomicGroup: i }
			};
		}
		try {
			const t = this.fs.stat(e), i = this.lazyBackingForStat(t);
			return i ? {
				...i,
				path: e
			} : null;
		} catch {
			return null;
		}
	}
	startLazyPreparation(e) {
		const { path: t, token: i } = e, n = {
			status: "pending",
			promise: Promise.resolve(!1)
		};
		return n.promise = (e.atomicGroup ? this.ensureAtomicLazyGroupMaterialized(e.atomicGroup).then(() => !0) : e.directGroup ? this.ensureArchiveMaterialized(e.directGroup).then(() => !0) : this.materializePath(t)).then((e) => (n.status = "fulfilled", this.lazyPreparations.get(i) === n && this.lazyPreparations.delete(i), e), (e) => {
			throw n.status = "rejected", n.error = e, e;
		}), n.promise.catch(() => {}), this.lazyPreparations.set(i, n), n;
	}
	registerLazyAtomicGroupMembership(e, t = !1) {
		const i = e.activation?.atomicGroup;
		if (void 0 === i) return;
		const { id: n, member: r } = i;
		if (void 0 === e.content || void 0 === e.inventory || "first-use" !== e.activation?.mode) throw new Error(`Lazy atomic activation group ${n} accepts only typed first-use trees`);
		let s = this.lazyAtomicGroups.get(n);
		if (void 0 === s) s = {
			id: n,
			token: Object.freeze({ id: n }),
			groups: /* @__PURE__ */ new Map(),
			committed: !1
		}, this.lazyAtomicGroups.set(n, s);
		else if (s.committed) throw new Error(`Lazy atomic activation group ${n} is already materialized`);
		if (s.groups.has(r)) throw new Error(`Lazy atomic activation group ${n} duplicates member ${r}`);
		if (Wa(i)) {
			if (void 0 !== s.expectedCount && (s.expectedCount !== i.expectedCount || s.cohortSha256 !== i.cohortSha256)) throw new Error(`Lazy atomic activation group ${n} has inconsistent seals`);
			s.expectedCount = i.expectedCount, s.cohortSha256 = i.cohortSha256;
			const o = Ya(e, n, r);
			this.sealedLazyAtomicStates.set(e, {
				snapshot: Qa(o, i.descriptorSha256, i.expectedCount, i.cohortSha256),
				verified: t
			});
		} else if (void 0 !== s.expectedCount) throw new Error(`Lazy atomic activation group ${n} mixes sealed and unsealed members`);
		s.groups.set(r, e), this.lazyAtomicGroupByTree.set(e, s);
	}
	async sealLazyAtomicGroup(e, t) {
		const i = t.map((t) => Na({
			id: e,
			member: t
		}).member).sort();
		if (0 === i.length || new Set(i).size !== i.length) throw new Error(`Lazy atomic activation group ${e} expected members are invalid`);
		const n = this.lazyAtomicGroups.get(e);
		if (void 0 === n || n.committed) throw new Error(`Lazy atomic activation group ${e} is not pending`);
		const r = [...n.groups.keys()].sort();
		if (JSON.stringify(r) !== JSON.stringify(i)) throw new Error(`Lazy atomic activation group ${e} members differ from its seal`);
		if (void 0 !== n.expectedCount) {
			if (n.expectedCount !== i.length || void 0 === n.cohortSha256) throw new Error(`Lazy atomic activation group ${e} has an invalid existing seal`);
			await this.ensureLazyAtomicGroupSealValidated(n, i.map((e) => n.groups.get(e)), !0);
			return;
		}
		const s = i.map((t) => Ya(n.groups.get(t), e, t)), o = [];
		for (const c of s) o.push({
			member: c.member,
			descriptorSha256: await Ga(c.descriptorBytes, `Lazy atomic member ${c.member}`),
			source: c
		});
		const a = await Ga(ja(e, o), `Lazy atomic activation group ${e}`);
		for (const c of o) {
			const t = Ya(n.groups.get(c.member), e, c.member);
			if (!ec(c.source, t)) throw new Error(`Lazy atomic activation member ${c.member} changed while sealing`);
		}
		for (const c of o) {
			const t = n.groups.get(c.member);
			t.activation.atomicGroup = {
				id: e,
				member: c.member,
				descriptorSha256: c.descriptorSha256,
				expectedCount: o.length,
				cohortSha256: a
			}, this.sealedLazyAtomicStates.set(t, {
				snapshot: Qa(c.source, c.descriptorSha256, o.length, a),
				verified: !0
			});
		}
		n.expectedCount = o.length, n.cohortSha256 = a;
	}
	async verifyImportedLazyAtomicGroupSeals() {
		await this.validatePendingLazyAtomicGroupSeals(!0);
	}
	guardSynchronousLazyAccess(e) {
		const t = this.lazyBackingForPath(e);
		if (!t) return;
		let i = this.lazyPreparations.get(t.token);
		if ("fulfilled" === i?.status) {
			this.lazyPreparations.delete(t.token);
			const n = this.lazyBackingForPath(e);
			if (!n) return;
			i = this.lazyPreparations.get(n.token) ?? this.startLazyPreparation(n);
		} else {
			if ("rejected" === i?.status) {
				this.lazyPreparations.delete(t.token);
				const n = i.error instanceof Error ? i.error.message : String(i.error), r = /* @__PURE__ */ new Error(`EIO: lazy backing for ${e} failed: ${n}`);
				throw r.code = "EIO", r.cause = i.error, r;
			}
			i || (i = this.startLazyPreparation(t));
		}
		const n = /* @__PURE__ */ new Error(`EAGAIN: lazy backing for ${e} is being prepared`);
		throw n.code = "EAGAIN", n;
	}
	invalidateLazyData(t) {
		const i = e.inodeKey(t.ino, t.generation);
		this.lazyFiles.delete(i);
		const n = this.lazyArchiveInodes.get(i);
		if (n) {
			this.lazyArchiveInodes.delete(i);
			for (const e of n.entries.values()) e.ino === t.ino && e.generation === t.generation && (e.materialized = !0);
		}
	}
	rewriteLazyNamespacePaths(t, i, n) {
		const r = i.length > 1 ? i.replace(/\/+$/, "") : i, s = n.length > 1 ? n.replace(/\/+$/, "") : n, o = `${r}/`, a = `${s}/`, c = e.inodeKey(t.ino, t.generation), h = (t.mode & Uo) === Oo, l = (e) => e === r ? s : h && e.startsWith(o) ? a + e.slice(o.length) : e;
		for (const [e, d] of this.lazyFiles) (h || e === c) && (d.paths = new Set(Array.from(d.paths, l)), d.path = l(d.path));
		for (const d of this.lazyArchiveGroups) {
			const t = /* @__PURE__ */ new Map();
			for (const [i, n] of d.entries) {
				const r = void 0 === n.generation ? null : e.inodeKey(n.ino, n.generation);
				t.set(h || r === c ? l(i) : i, n);
			}
			d.entries = t, d.inventory && (d.inventory = d.inventory.map((e) => ({
				...e,
				vfsPath: l(e.vfsPath),
				..."hardlink" === e.type && void 0 !== e.target ? { target: l(e.target) } : {}
			}))), d.activation && (d.activation = {
				...d.activation,
				roots: d.activation.roots.map(l)
			});
		}
	}
	get sharedBuffer() {
		return this.fs.buffer;
	}
	static create(t, i) {
		return new e(Ys.mkfs(t, i));
	}
	static fromExisting(t) {
		return new e(Ys.mount(t));
	}
	rebaseToNewFileSystem(t) {
		if (!Number.isSafeInteger(t) || t <= 0) throw new Error(`Invalid MemoryFileSystem maxByteLength: ${t}`);
		const i = SharedArrayBuffer, { bytes: n, identities: r } = this.fs.snapshotState();
		this.reconcileLazyIdentityState(r);
		const s = this.serializeLazyEntries(), o = this.serializeValidatedLazyArchiveEntries(r), a = new i(n.byteLength);
		new Uint8Array(a).set(n);
		const c = new e(Ys.mount(a, { restoreImage: !0 }), this.imageMetadata);
		c.importLazyEntries(s), c.importLazyArchiveEntriesInternal(o, !1, !0, "verified");
		const h = new i(Math.min(t, Math.max(n.byteLength, 16777216)), { maxByteLength: t }), l = e.create(h, t);
		l.setImageMetadata(this.imageMetadata);
		const d = new Set(s.flatMap((e) => e.paths ?? [e.path])), f = /* @__PURE__ */ new Set();
		for (const e of o) if (!e.materialized) for (const t of e.entries) t.deleted || t.isSymlink || f.add(t.vfsPath);
		return c.copyPathToFreshFileSystem("/", l, d, f, /* @__PURE__ */ new Map()), l.importLazyEntries(s.map((e) => {
			const t = l.fs.lstat(e.path);
			return {
				...e,
				ino: t.ino,
				generation: t.generation,
				dataSequence: t.dataSequence
			};
		})), l.importLazyArchiveEntriesInternal(o.map((e) => ({
			...e,
			entries: e.entries.map((e) => {
				if (e.deleted) return {
					...e,
					ino: 0,
					generation: void 0
				};
				const t = l.fs.lstat(e.vfsPath);
				return {
					...e,
					ino: t.ino,
					generation: t.generation,
					dataSequence: t.dataSequence
				};
			})
		})), !1, !0, "verified"), l;
	}
	getImageMetadata() {
		return null === (e = this.imageMetadata) ? null : { ...e };
		var e;
	}
	setImageMetadata(e) {
		this.imageMetadata = null === e ? null : da(e);
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
		for (const i of this.lazyDownloadListeners) try {
			i(t);
		} catch {}
	}
	async fetchLazyBytes(e, t) {
		let i = 0, n = e.integrity?.bytes ?? e.fallbackTotalBytes;
		const r = {
			id: e.id,
			kind: e.kind,
			url: e.url,
			path: e.path,
			mountPrefix: e.mountPrefix
		};
		for (let a = 0; a < 3; a += 1) {
			i = 0, this.emitLazyDownload({
				...r,
				status: "started",
				loadedBytes: i,
				totalBytes: n
			});
			try {
				Ia(t.signal);
				const o = void 0 === t.signal ? await t.fetcher(e.url) : await t.fetcher(e.url, { signal: t.signal });
				if (t.signal?.aborted) throw await xa(o, t.signal.reason), t.signal.reason;
				if (!o.ok) {
					const e = new ha(o.status, ya(o.headers));
					throw await xa(o, e), e;
				}
				if (n = ma(o.headers) ?? n, e.integrity && void 0 !== n && n !== e.integrity.bytes) {
					const t = /* @__PURE__ */ new Error(`Lazy ${e.kind} byte count ${n} does not match expected ${e.integrity.bytes}`);
					throw await xa(o, t), t;
				}
				if (!o.body) {
					const s = new Uint8Array(await o.arrayBuffer());
					return Ia(t.signal), i = s.byteLength, await qa(s, e.kind, e.integrity), Ia(t.signal), this.emitLazyDownload({
						...r,
						status: "progress",
						loadedBytes: i,
						totalBytes: n ?? i
					}), this.emitLazyDownload({
						...r,
						status: "complete",
						loadedBytes: i,
						totalBytes: n ?? i
					}), s;
				}
				const a = o.body.getReader(), c = [];
				try {
					try {
						for (;;) {
							const { done: s, value: o } = await a.read();
							if (Ia(t.signal), s) break;
							if (o) {
								if (c.push(o), i += o.byteLength, e.integrity && i > e.integrity.bytes) throw new Error(`Lazy ${e.kind} exceeded expected byte count ${e.integrity.bytes}`);
								this.emitLazyDownload({
									...r,
									status: "progress",
									loadedBytes: i,
									totalBytes: n
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
				const h = Ea(c, i);
				return Ia(t.signal), await qa(h, e.kind, e.integrity), Ia(t.signal), this.emitLazyDownload({
					...r,
					status: "complete",
					loadedBytes: i,
					totalBytes: n ?? i
				}), h;
			} catch (as) {
				if (t.signal?.aborted) {
					const e = t.signal.reason, s = e instanceof Error ? e.message : String(e);
					throw this.emitLazyDownload({
						...r,
						status: "error",
						loadedBytes: i,
						totalBytes: n,
						error: s
					}), e;
				}
				const s = a + 1 < 3 ? Pa(as, a) : null;
				if (null !== s) {
					try {
						await za(s, t.signal);
					} catch (o) {
						const e = t.signal?.aborted ? t.signal.reason : o, s = e instanceof Error ? e.message : String(e);
						throw this.emitLazyDownload({
							...r,
							status: "error",
							loadedBytes: i,
							totalBytes: n,
							error: s
						}), e;
					}
					continue;
				}
				const c = as instanceof Error ? as.message : String(as);
				throw this.emitLazyDownload({
					...r,
					status: "error",
					loadedBytes: i,
					totalBytes: n,
					error: c
				}), as;
			}
		}
		throw new Error("Lazy transport retry state became unreachable");
	}
	registerLazyFile(t, i, n, r = 493) {
		const s = t.split("/").filter(Boolean);
		let o = "";
		for (let e = 0; e < s.length - 1; e++) {
			o += "/" + s[e];
			try {
				this.fs.mkdir(o, 493);
			} catch {}
		}
		const a = this.fs.createLazyStub(t, r);
		return this.invalidateLazyData(a), this.lazyFiles.set(e.inodeKey(a.ino, a.generation), {
			ino: a.ino,
			generation: a.generation,
			dataSequence: a.dataSequence,
			path: t,
			paths: new Set([t]),
			url: i,
			size: n
		}), a.ino;
	}
	importLazyEntries(e) {
		this.importLazyEntriesInternal(e, !1);
	}
	importLazyEntriesInternal(t, i) {
		for (const n of t) {
			if ((void 0 === n.generation || void 0 === n.dataSequence) && !i) throw new Error("Live lazy-file metadata requires inode generation and data sequence");
			const t = /* @__PURE__ */ new Set();
			let r = null;
			for (const i of new Set([n.path, ...n.paths ?? []])) {
				let s;
				try {
					s = this.fs.stat(i);
				} catch {
					continue;
				}
				if (s.ino === n.ino && (void 0 === n.generation || s.generation === n.generation)) {
					if (void 0 === n.dataSequence) {
						if (!e.canAdoptLegacyLazyStub(s)) continue;
					} else if (s.dataSequence !== n.dataSequence) continue;
					r ??= s, t.add(i);
				}
			}
			if (!r || 0 === t.size) continue;
			const s = t.has(n.path) ? n.path : t.values().next().value;
			this.lazyFiles.set(e.inodeKey(r.ino, r.generation), {
				ino: r.ino,
				generation: r.generation,
				dataSequence: r.dataSequence,
				path: s,
				paths: t,
				url: n.url,
				size: n.size
			});
		}
	}
	serializeLazyEntries() {
		const e = [];
		for (const { ino: t, generation: i, dataSequence: n, path: r, paths: s, url: o, size: a } of this.lazyFiles.values()) e.push({
			ino: t,
			generation: i,
			dataSequence: n,
			path: r,
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
			const t = this.fs.stat(e), i = this.lazyFileForStat(t);
			return i ? {
				ino: t.ino,
				generation: t.generation,
				dataSequence: t.dataSequence,
				path: i.path,
				paths: Array.from(i.paths),
				url: i.url,
				size: i.size
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
	registerLazyTree(e, t, i = "/", n, r) {
		return this.registerLazyTreeInternal(e, t, i, n, !1, r);
	}
	registerLazyTreeInternal(t, i, n, r, s, o) {
		this.assertCanRegisterPendingLazyArchiveGroup();
		const a = la(n), { content: c, entries: h, mountPrefix: l, activation: d, canonicalByGroup: f } = Da(t, i, a, r ?? {
			mode: "first-use",
			capabilities: ["deferred-tree"],
			roots: [a]
		}, s ? 0 : 1), u = void 0 === o ? void 0 : function(e) {
			const t = Aa(e, ["uid", "gid"], "Lazy tree registration owner");
			return {
				uid: Ba(t.uid, "Lazy tree registration owner uid", 0, ia),
				gid: Ba(t.gid, "Lazy tree registration owner gid", 0, ia)
			};
		}(o), p = void 0 === d.atomicGroup ? void 0 : this.lazyAtomicGroups.get(d.atomicGroup.id);
		if (p?.committed || void 0 !== p && (void 0 !== p.expectedCount || p.groups.has(d.atomicGroup.member))) throw new Error(`Lazy atomic activation group ${d.atomicGroup?.id} cannot accept this member`);
		const g = {
			content: c,
			url: c.transports[0] ?? "",
			mountPrefix: l,
			integrity: {
				sha256: c.sha256,
				bytes: c.bytes
			},
			materialized: !1,
			inventory: h.map((e) => ({ ...e })),
			activation: d,
			entries: /* @__PURE__ */ new Map()
		}, m = (e) => {
			const t = e.split("/").filter(Boolean);
			let i = "";
			for (let n = 0; n < t.length - 1; n++) {
				i += `/${t[n]}`;
				try {
					this.fs.mkdir(i, 493);
				} catch {
					if ((this.fs.lstat(i).mode & Uo) !== Oo) throw new Error(`Lazy tree ancestor ${i} is not a directory`);
				}
			}
		};
		for (const e of [...h].sort((e, t) => e.vfsPath.split("/").length - t.vfsPath.split("/").length)) if ("directory" === e.type) {
			m(e.vfsPath);
			try {
				this.fs.mkdir(e.vfsPath, e.mode), this.fs.chmod(e.vfsPath, e.mode);
			} catch {
				if ((this.fs.lstat(e.vfsPath).mode & Uo) !== Oo) throw new Error(`Lazy tree directory collides at ${e.vfsPath}`);
			}
		}
		for (const e of h) {
			if ("symlink" !== e.type) continue;
			m(e.vfsPath), this.fs.symlink(e.target, e.vfsPath);
			const t = this.fs.lstat(e.vfsPath);
			g.entries.set(e.vfsPath, {
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
		for (const e of h) {
			if ("file" !== e.type) continue;
			m(e.vfsPath);
			const t = this.fs.createLazyStub(e.vfsPath, e.mode);
			this.invalidateLazyData(t), y.set(e.inodeGroup, t);
			const i = {
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
			g.entries.set(e.vfsPath, i);
		}
		for (const e of h) {
			if ("hardlink" !== e.type) continue;
			const t = f.get(e.inodeGroup);
			m(e.vfsPath), this.fs.link(t.vfsPath, e.vfsPath);
			const i = this.fs.lstat(e.vfsPath), n = y.get(e.inodeGroup);
			if (i.ino !== n.ino || i.generation !== n.generation) throw new Error(`Lazy tree hardlink ${e.vfsPath} did not share its inode`);
			g.entries.set(e.vfsPath, {
				ino: i.ino,
				generation: i.generation,
				dataSequence: i.dataSequence,
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
		if (void 0 !== u) for (const e of h) this.lchown(e.vfsPath, u.uid, u.gid);
		for (const w of g.entries.values()) w.isSymlink || void 0 === w.generation || this.lazyArchiveInodes.set(e.inodeKey(w.ino, w.generation), g);
		return this.lazyArchiveGroups.push(g), this.registerLazyAtomicGroupMembership(g), g;
	}
	registerLazyTreeWithMaterializationHandle(e, t, i = "/", n, r) {
		const s = this.registerLazyTreeInternal(e, t, i, n, !0, r), o = Object.freeze({ [Ao]: !0 });
		return this.deferredTreeMaterializationHandles.set(o, s), o;
	}
	registerLazyArchiveFromEntries(t, i, n, r, s) {
		const o = la(n), a = function(e, t, i, n) {
			const r = la(i), s = /* @__PURE__ */ new Map(), o = t.map((t) => {
				const i = t.fileName, o = `Lazy archive ${JSON.stringify(e)} member ${JSON.stringify(i)}`;
				if (0 === i.length) throw new Error(`${o} has an empty path`);
				if (i.includes("\0")) throw new Error(`${o} contains a NUL byte`);
				if (i.includes("\\")) throw new Error(`${o} contains a backslash`);
				if (i.startsWith("/") || /^[A-Za-z]:\//.test(i)) throw new Error(`${o} must be relative, not absolute`);
				if (t.isDirectory && t.isSymlink) throw new Error(`${o} has conflicting directory and symlink types`);
				if (t.isDirectory !== i.endsWith("/")) throw new Error(`${o} has inconsistent directory metadata`);
				const a = t.isDirectory ? i.slice(0, -1) : i, c = a.split("/");
				if (0 === a.length || c.some((e) => "" === e || "." === e || ".." === e)) throw new Error(`${o} is not a canonical relative POSIX path`);
				if (s.has(a)) throw new Error(`${o} collides with another member at ${JSON.stringify(a)}`);
				if (t.isSymlink && !n?.has(i)) throw new Error(`Lazy archive symlink target was not provided: ${i}`);
				return s.set(a, t), {
					entry: t,
					archivePath: a,
					vfsPath: "/" === r ? `/${a}` : `${r}/${a}`
				};
			});
			for (const { archivePath: a } of o) {
				const e = a.split("/");
				for (let t = 1; t < e.length; t++) {
					const i = e.slice(0, t).join("/"), n = s.get(i);
					if (n && !n.isDirectory) throw new Error(`Lazy archive member ${JSON.stringify(a)} descends through non-directory ${JSON.stringify(i)}`);
				}
			}
			return o;
		}(t, i, o, r);
		a.some(({ entry: e }) => !e.isDirectory && !e.isSymlink) && this.assertCanRegisterPendingLazyArchiveGroup();
		const c = {
			...s ? { content: Ta({
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
			integrity: Ma(s),
			materialized: !1,
			entries: /* @__PURE__ */ new Map()
		};
		for (const { entry: h, vfsPath: l } of a) {
			if (h.isDirectory) continue;
			const t = l.split("/").filter(Boolean);
			let i = "";
			for (let e = 0; e < t.length - 1; e++) {
				i += "/" + t[e];
				try {
					this.fs.mkdir(i, 493);
				} catch {}
			}
			if (h.isSymlink) {
				const e = r.get(h.fileName);
				this.fs.symlink(e, l);
				const t = this.fs.lstat(l), i = {
					ino: t.ino,
					generation: t.generation,
					dataSequence: t.dataSequence,
					size: h.uncompressedSize,
					isSymlink: !0,
					deleted: !1,
					materialized: !0,
					archivePath: h.fileName,
					sourcePath: h.fileName,
					type: "symlink"
				};
				c.entries.set(l, i);
			} else {
				const t = this.fs.createLazyStub(l, h.mode);
				this.invalidateLazyData(t);
				const i = {
					ino: t.ino,
					generation: t.generation,
					dataSequence: t.dataSequence,
					size: h.uncompressedSize,
					isSymlink: !1,
					deleted: !1,
					materialized: !1,
					archivePath: h.fileName,
					sourcePath: h.fileName,
					type: "file",
					inodeGroup: h.fileName
				};
				c.entries.set(l, i), this.lazyArchiveInodes.set(e.inodeKey(t.ino, t.generation), c);
			}
		}
		return c.materialized = Array.from(c.entries.values()).every((e) => e.deleted || e.materialized), this.lazyArchiveGroups.push(c), c;
	}
	importLazyArchiveEntries(e) {
		this.importLazyArchiveEntriesInternal(e, !1, !0, "reject");
	}
	async importVerifiedLazyArchiveEntries(t) {
		const i = structuredClone(t), n = this.exportLazyArchiveEntries(), r = e.fromExisting(this.sharedBuffer);
		r.importLazyArchiveEntriesInternal([...n, ...i], !1, !0, "pending"), await r.verifyImportedLazyAtomicGroupSeals(), this.importLazyArchiveEntriesInternal(i, !1, !0, "verified");
	}
	importLazyArchiveEntriesInternal(t, i, n, r) {
		const s = _a(t, "Serialized lazy archive groups", 0, Xo).map((e, t) => {
			if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error(`Serialized lazy archive group ${t} must be an object`);
			const i = e.kind;
			if (i === sa || i === oa || i === aa) return Ha(e, i);
			if (i === ra) return Ka(e, !1);
			if (void 0 !== i) throw new Error(`Serialized lazy archive group ${t} has an unsupported kind`);
			if (n) throw new Error(`Serialized lazy archive group ${t} is missing its kind discriminator`);
			return Ka(e, !0);
		}), o = this.fs.identityState();
		this.reconcileLazyIdentityState(o), Ua([...this.serializeValidatedLazyArchiveEntries(o), ...s]);
		const a = [], c = /* @__PURE__ */ new Map();
		for (const h of s) {
			const t = /* @__PURE__ */ new Map(), n = h.mountPrefix.replace(/\/+$/, ""), r = void 0 !== h.content && void 0 !== h.inventory && void 0 !== h.activation, s = r ? new Map(h.inventory.map((e) => [e.vfsPath, e])) : null, o = r ? new Map(h.inventory.map((e) => [Va(e), e])) : null, l = /* @__PURE__ */ new Map(), d = /* @__PURE__ */ new Map(), f = /* @__PURE__ */ new Map();
			for (const a of h.entries) {
				let c = null;
				const u = h.materialized || !0 === a.materialized || a.isSymlink;
				if (!a.deleted && !u) {
					if ((void 0 === a.generation || void 0 === a.dataSequence) && !i) throw new Error("Live lazy-archive metadata requires inode generation and data sequence");
					try {
						c = this.fs.lstat(a.vfsPath);
					} catch {
						if (r) throw new Error(`Serialized lazy tree stub ${a.vfsPath} is missing from the filesystem`);
						continue;
					}
					if (c.ino !== a.ino) {
						if (r) throw new Error(`Serialized lazy tree stub ${a.vfsPath} has a different inode`);
						continue;
					}
					if (void 0 !== a.generation && c.generation !== a.generation) {
						if (r) throw new Error(`Serialized lazy tree stub ${a.vfsPath} has a different generation`);
						continue;
					}
					if (void 0 === a.dataSequence) {
						if (!e.canAdoptLegacyLazyStub(c)) {
							if (r) throw new Error(`Serialized lazy tree stub ${a.vfsPath} is not pristine`);
							continue;
						}
					} else if (c.dataSequence !== a.dataSequence) {
						if (r) throw new Error(`Serialized lazy tree stub ${a.vfsPath} has a different data sequence`);
						continue;
					}
					if (r) {
						f.set(a.vfsPath, c);
						const t = s.get(a.vfsPath), i = o.get(Va(a)) ?? t;
						if (!i || (c.mode & Uo) !== $o || 0 !== c.size || (4095 & c.mode) !== i.mode || void 0 !== t?.inodeGroup && t.inodeGroup !== i.inodeGroup) throw new Error(`Serialized lazy tree stub ${a.vfsPath} disagrees with its inventory`);
						const n = e.inodeKey(c.ino, c.generation), r = a.inodeGroup, h = l.get(r), u = d.get(n);
						if (void 0 !== h && h !== n || void 0 !== u && u !== r) throw new Error(`Serialized lazy tree inode group ${r} disagrees with the filesystem`);
						l.set(r, n), d.set(n, r);
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
					archivePath: a.archivePath ?? a.vfsPath.slice(n.length + 1),
					sourcePath: a.sourcePath ?? a.archivePath ?? a.vfsPath.slice(n.length + 1),
					type: a.type ?? (a.isSymlink ? "symlink" : "file"),
					inodeGroup: a.inodeGroup,
					target: a.target
				});
			}
			if (r) {
				const e = /* @__PURE__ */ new Map();
				for (const i of h.inventory) {
					if ("file" === i.type || "hardlink" === i.type) {
						e.set(i.inodeGroup, (e.get(i.inodeGroup) ?? 0) + 1);
						continue;
					}
					let n;
					try {
						n = this.fs.lstat(i.vfsPath);
					} catch {
						throw new Error(`Serialized lazy tree namespace entry ${i.vfsPath} is missing from the filesystem`);
					}
					const r = "directory" === i.type ? Oo : No;
					if ((n.mode & Uo) !== r || (4095 & n.mode) !== i.mode || "symlink" === i.type && (n.size !== new TextEncoder().encode(i.target).byteLength || this.fs.readlink(i.vfsPath) !== i.target)) throw new Error(`Serialized lazy tree namespace entry ${i.vfsPath} disagrees with its inventory`);
					"symlink" === i.type && t.set(i.vfsPath, {
						ino: n.ino,
						generation: n.generation,
						dataSequence: n.dataSequence,
						size: i.size,
						isSymlink: !0,
						deleted: !1,
						materialized: !0,
						archivePath: i.sourcePath,
						sourcePath: i.sourcePath,
						type: "symlink",
						target: i.target
					});
				}
				if (void 0 !== h.activation?.atomicGroup) {
					for (const t of h.inventory) if (("file" === t.type || "hardlink" === t.type) && f.get(t.vfsPath).linkCount !== e.get(t.inodeGroup)) throw new Error(`Serialized lazy atomic tree inode group ${t.inodeGroup} has undeclared aliases`);
				}
			}
			const u = void 0 === h.content ? void 0 : Ta(h.content), p = {
				content: u,
				url: u?.transports[0] ?? h.url,
				mountPrefix: h.mountPrefix,
				integrity: u ? {
					sha256: u.sha256,
					bytes: u.bytes
				} : Ma(h.integrity),
				materialized: h.materialized || !(u && h.inventory) && Array.from(t.values()).every((e) => e.deleted || e.materialized),
				inventory: h.inventory?.map((e) => ({ ...e })),
				activation: h.activation ? {
					mode: h.activation.mode,
					capabilities: [...h.activation.capabilities],
					roots: [...h.activation.roots],
					...void 0 === h.activation.atomicGroup ? {} : { atomicGroup: { ...h.activation.atomicGroup } }
				} : void 0,
				entries: t
			};
			if (a.push(p), !p.materialized) {
				for (const [, i] of t) if (!i.deleted && !i.materialized && void 0 !== i.generation) {
					const t = e.inodeKey(i.ino, i.generation), n = c.get(t);
					if (void 0 !== n && n !== p) throw new Error(`Serialized lazy archive groups share pending inode ${t}`);
					if (this.lazyArchiveInodes.has(t)) throw new Error(`Serialized lazy archive group collides with pending inode ${t}`);
					c.set(t, p);
				}
			}
		}
		for (const e of a) {
			const t = e.activation?.atomicGroup;
			if (void 0 !== t && this.lazyAtomicGroups.get(t.id)?.committed) throw new Error(`Lazy atomic activation group ${t.id} is already materialized`);
		}
		if ("reject" === r && a.some((e) => {
			const t = e.activation?.atomicGroup;
			return void 0 !== t && Wa(t);
		})) throw new Error("Sealed lazy archive registrations require importVerifiedLazyArchiveEntries()");
		this.lazyArchiveGroups.push(...a);
		for (const e of a) this.registerLazyAtomicGroupMembership(e, "verified" === r);
		for (const [e, h] of c) this.lazyArchiveInodes.set(e, h);
	}
	rewriteLazyArchiveUrls(e) {
		for (const t of this.lazyArchiveGroups) {
			const i = this.lazyAtomicGroupByTree.get(t), n = this.sealedLazyAtomicStates.get(t);
			if (void 0 !== n && !i?.committed) {
				this.assertLazyAtomicSnapshotMatchesPublic(t);
				const i = tc(n.snapshot, e);
				t.content = Za(i.content), t.url = i.url, t.integrity = { ...i.integrity }, n.snapshot = i;
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
			const i = this.lazyAtomicGroupByTree.get(t), n = this.sealedLazyAtomicStates.get(t);
			if (void 0 !== n) {
				if (i?.committed) continue;
				const t = n.snapshot;
				if (0 === t.content.transports.length) throw new Error("Direct-materialization tree must be materialized before serialization");
				e.push({
					kind: aa,
					content: Za(t.content),
					inventory: t.inventory.map((e) => ({ ...e })),
					activation: Ja(t),
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
			const r = Array.from(t.entries, ([e, t]) => ({
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
			if (0 === r.length && (!t.content || !t.inventory || t.materialized)) continue;
			const s = void 0 !== t.content && void 0 !== t.inventory && void 0 !== t.activation;
			if (s && 0 === t.content.transports.length) throw new Error("Direct-materialization tree must be materialized before serialization");
			const o = t.activation?.atomicGroup;
			if (void 0 !== o && !Wa(o)) throw new Error(`Lazy atomic activation group ${o.id} must be sealed before serialization`);
			e.push(s ? {
				kind: void 0 !== o ? aa : void 0 === t.content.source ? sa : oa,
				content: t.content,
				inventory: t.inventory,
				activation: t.activation,
				url: t.url,
				mountPrefix: t.mountPrefix,
				integrity: t.integrity,
				materialized: !1,
				entries: r
			} : {
				kind: ra,
				url: t.url,
				mountPrefix: t.mountPrefix,
				integrity: t.integrity,
				materialized: !1,
				entries: r
			});
		}
		return e;
	}
	serializeValidatedLazyArchiveEntries(e) {
		this.assertPendingLazyAtomicSnapshotsReadyForSerialization();
		const t = this.serializeLazyArchiveEntries();
		return Ua(t), this.validatePendingLazyTreeNamespaceState(e), t;
	}
	exportLazyArchiveEntries() {
		const e = this.fs.identityState();
		return this.reconcileLazyIdentityState(e), this.serializeValidatedLazyArchiveEntries(e);
	}
	pendingDeferredTreeUsage() {
		const e = this.fs.identityState();
		return this.reconcileLazyIdentityState(e), Fa(this.serializeValidatedLazyArchiveEntries(e));
	}
	assertCanAppendDeferredTreeUsage(e) {
		Ra(e);
		const t = this.pendingDeferredTreeUsage();
		Ra({
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
		}).length >= go) throw new Error(`Cannot register another lazy archive group: ${go} pending groups already exist`);
	}
	async preparePath(e) {
		let t = !1;
		const i = Math.max(3, this.lazyArchiveGroups.length + 1);
		for (let n = 0; n < i; n++) {
			const i = this.lazyBackingForPath(e);
			if (!i) return t;
			const n = this.lazyPreparations.get(i.token) ?? this.startLazyPreparation(i);
			try {
				t = await n.promise || t;
			} finally {
				this.lazyPreparations.get(i.token) === n && this.lazyPreparations.delete(i.token);
			}
		}
		if (this.lazyBackingForPath(e)) throw new Error(`Lazy backing kept changing identity while preparing: ${e}`);
		return t;
	}
	async prepareBootDeferredTrees() {
		const e = this.lazyArchiveGroups.filter((e) => !e.materialized && "boot-prefetch" === e.activation?.mode);
		let t, i = 0;
		const n = Array.from({ length: Math.min(e.length, 2) }, async () => {
			for (; void 0 === t;) {
				const r = i;
				if (i += 1, r >= e.length) return;
				try {
					await this.prepareLazyTreeGroup(e[r]);
				} catch (n) {
					t ??= n;
				}
			}
		});
		if (await Promise.all(n), void 0 !== t) throw t;
		return e.length;
	}
	async materializeRegisteredDeferredTree(e, t) {
		const i = this.deferredTreeMaterializationHandles.get(e);
		if (void 0 === i) throw new Error("Deferred-tree handle was not issued by this filesystem");
		const n = this.lazyAtomicGroupByTree.get(i);
		if (void 0 !== n) throw new Error(`Deferred tree belongs to atomic activation group ${n.id}; materialize the complete group instead`);
		if (i.materialized) return !1;
		const r = this.lazyPreparations.get(i);
		if (void 0 !== r) return r.promise;
		const s = new Uint8Array(t.byteLength);
		s.set(t);
		const o = {
			status: "pending",
			promise: Promise.resolve(!1)
		};
		o.promise = Promise.resolve().then(async () => (await qa(s, "tree", i.integrity), await this.materializeArchiveBytes(i, s), !0)).then((e) => (o.status = "fulfilled", e), (e) => {
			throw o.status = "rejected", o.error = e, e;
		}), o.promise.catch(() => {}), this.lazyPreparations.set(i, o);
		try {
			return await o.promise;
		} finally {
			this.lazyPreparations.get(i) === o && this.lazyPreparations.delete(i);
		}
	}
	async prepareLazyTreeGroup(e) {
		const t = this.lazyAtomicGroupByTree.get(e);
		if (t?.committed || void 0 === t && e.materialized) return !1;
		const i = this.sealedLazyAtomicStates.get(e)?.snapshot, n = {
			token: t?.token ?? e,
			path: i?.activation.roots[0] ?? e.activation?.roots[0] ?? e.mountPrefix,
			directGroup: e,
			...void 0 === t ? {} : { atomicGroup: t }
		}, r = this.lazyPreparations.get(n.token) ?? this.startLazyPreparation(n);
		try {
			return await r.promise;
		} finally {
			this.lazyPreparations.get(n.token) === r && this.lazyPreparations.delete(n.token);
		}
	}
	async ensureMaterialized(e) {
		return this.preparePath(e);
	}
	async materializePath(t) {
		if (0 === this.lazyFiles.size && 0 === this.lazyArchiveInodes.size) return !1;
		let i;
		try {
			i = this.fs.stat(t);
		} catch {
			return !1;
		}
		const n = e.inodeKey(i.ino, i.generation), r = this.lazyFiles.get(n);
		if (r) {
			const e = this.lazyTransport, s = await this.fetchLazyBytes({
				id: `file:${i.ino}`,
				kind: "file",
				url: r.url,
				path: r.path,
				fallbackTotalBytes: r.size
			}, e);
			for (let i = 0; i < 3; i++) {
				if (this.lazyFiles.get(n) !== r) return !1;
				for (const i of new Set([t, ...r.paths])) if (Ia(e.signal), this.fs.replaceIfIdentity(i, r.ino, r.generation, r.dataSequence, s)) return r.path = i, this.lazyFiles.delete(n), !0;
				this.reconcileLazyIdentityState(this.fs.identityState());
			}
			throw new Error(`Lazy file kept changing names while materializing: ${t}`);
		}
		const s = this.lazyArchiveInodes.get(n);
		return !!s && (await this.ensureArchiveMaterialized(s, {
			path: t,
			ino: i.ino,
			generation: i.generation
		}), !this.lazyArchiveInodes.has(n));
	}
	async decodeAndValidateLazyTree(e, t, i) {
		const n = i?.content ?? e.content, r = i?.inventory ?? e.inventory;
		if (!n || !r) throw new Error("Lazy tree is missing its decoder or complete inventory");
		const s = /* @__PURE__ */ new Map(), o = new Map(r.map((e) => [e.vfsPath, e]));
		if (void 0 !== n.source) for (const d of n.source.entries) s.set(d.sourcePath, d);
		else for (const d of r) {
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
		if ("zip-v1" === n.decoder) {
			const { parseZipCentralDirectory: e, extractZipEntryBounded: i } = await import("./zip-DJ-is7oS.js"), r = e(t);
			if (r.length !== n.sourceEntryCount || r.length !== s.size) throw new Error("Lazy ZIP tree decoded inventory counts differ from its descriptor");
			for (const o of r) {
				const e = o.isDirectory ? o.fileName.replace(/\/$/, "") : o.fileName;
				if (a.has(e)) throw new Error(`Lazy ZIP tree duplicates source member ${e}`);
				const r = s.get(e);
				if (!r) throw new Error(`Lazy ZIP tree has undeclared source member ${e}`);
				if (c += o.uncompressedSize, c > n.expandedBytes || o.uncompressedSize !== r.size) throw new Error(`Lazy ZIP tree member ${e} exceeds its inventory`);
				const h = o.isDirectory ? "directory" : o.isSymlink ? "symlink" : "file", l = "portable-posix-v1" === n.modePolicy ? "directory" === h ? 493 : "symlink" === h ? 511 : 73 & o.mode ? 493 : 420 : 4095 & o.mode;
				if (h !== r.type || l !== r.mode) throw new Error(`Lazy ZIP tree member ${e} differs from inventory`);
				if (o.isDirectory) a.set(e, {
					type: "directory",
					mode: l
				});
				else {
					const n = i(t, o, r.size);
					if (o.isSymlink) {
						let t;
						try {
							t = new TextDecoder("utf-8", { fatal: !0 }).decode(n);
						} catch {
							throw new Error(`Lazy ZIP tree symlink ${e} is not UTF-8`);
						}
						a.set(e, {
							type: "symlink",
							mode: l,
							target: t
						});
					} else a.set(e, {
						type: "file",
						mode: l,
						data: n
					});
				}
			}
		} else {
			const { parseTarGzip: e } = await import("./tar-XbPVG1Oa.js"), i = e(t, {
				label: `Lazy tree ${n.sha256}`,
				limits: {
					maxCompressedBytes: n.bytes,
					maxUncompressedBytes: n.expandedBytes,
					maxEntries: n.sourceEntryCount
				}
			});
			c = new DataView(t.buffer, t.byteOffset, t.byteLength).getUint32(t.byteLength - 4, !0);
			for (const t of i) {
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
		if (a.size !== n.sourceEntryCount || a.size !== s.size || c !== n.expandedBytes) throw new Error("Lazy tree decoded inventory counts differ from its descriptor");
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
		const h = new Set(r.flatMap((e) => "archive-homebrew-relocate" === e.materialization ? [e.sourcePath] : []));
		if (void 0 !== n.source) {
			const e = new Map(n.source.entries.map((e) => [e.sourcePath, e])), t = $a(n.source.entries), i = n.source.entries.filter((e) => "INSTALL_RECEIPT.json" === e.sourcePath || e.sourcePath.endsWith("/INSTALL_RECEIPT.json"));
			if (i.length > 1) throw new Error(`Lazy Homebrew bottle has ${i.length} INSTALL_RECEIPT.json source members, expected at most one`);
			if (0 === i.length) {
				if (h.size > 0) throw new Error("Lazy Homebrew bottle marks receipt relocation without INSTALL_RECEIPT.json");
			} else {
				const n = i[0], r = "file" === n.type ? n : t.get(n.sourcePath), s = void 0 === r ? void 0 : a.get(r.sourcePath);
				if ("file" !== r?.type || "file" !== s?.type || void 0 === s.data) throw new Error("Lazy Homebrew bottle INSTALL_RECEIPT.json is not regular");
				const o = Io(s.data), c = n.sourcePath.lastIndexOf("/"), l = c < 0 ? "" : n.sourcePath.slice(0, c), d = new Set(o.changedFiles.map((e) => 0 === l.length ? e : `${l}/${e}`));
				if (h.size !== d.size || [...h].some((e) => !d.has(e))) throw new Error("Lazy Homebrew bottle relocation markers differ from INSTALL_RECEIPT.json");
				const f = /* @__PURE__ */ new Set();
				for (const i of d) {
					const n = e.get(i), r = "file" === n?.type ? n : void 0 === n ? void 0 : t.get(n.sourcePath), s = void 0 === r ? void 0 : a.get(r.sourcePath);
					if ("file" !== r?.type || "file" !== s?.type || void 0 === s.data) throw new Error(`Lazy Homebrew bottle changed source ${i} is not regular`);
					f.has(r.sourcePath) || (s.data = zo(s.data, o, i), f.add(r.sourcePath));
				}
			}
		} else if (h.size > 0) throw new Error("Lazy tree receipt relocation requires original-bottle source truth");
		const l = /* @__PURE__ */ new Map();
		for (const d of r) {
			if ("file" !== d.type) continue;
			if ("descriptor" === d.materialization) continue;
			const e = a.get(d.sourcePath);
			if ("file" !== e?.type || !e.data) throw new Error(`Lazy tree has no file content for ${d.sourcePath}`);
			l.set(d.sourcePath, e.data);
		}
		return l;
	}
	async ensureArchiveMaterialized(e, t) {
		const i = this.lazyAtomicGroupByTree.get(e);
		if (void 0 !== i) {
			if (i.committed) return;
			const t = this.sealedLazyAtomicStates.get(e)?.snapshot, n = this.lazyPreparations.get(i.token) ?? this.startLazyPreparation({
				token: i.token,
				path: t?.activation.roots[0] ?? e.activation?.roots[0] ?? e.mountPrefix,
				atomicGroup: i
			});
			try {
				await n.promise;
			} finally {
				this.lazyPreparations.get(i.token) === n && this.lazyPreparations.delete(i.token);
			}
			return;
		}
		if (e.materialized) return;
		const n = this.lazyTransport, r = await this.fetchLazyArchiveData(e, n);
		Ia(n.signal), await this.materializeArchiveBytes(e, r, t, n.signal);
	}
	async fetchLazyArchiveData(e, t, i) {
		const n = i?.content ?? e.content, r = i?.inventory ?? e.inventory, s = void 0 !== n && void 0 !== r, o = i?.mountPrefix ?? e.mountPrefix, a = i?.integrity ?? e.integrity, c = s ? n.transports : [i?.url ?? e.url], h = [];
		let l = null;
		for (const [f, u] of c.entries()) try {
			l = await this.fetchLazyBytes({
				id: `archive:${o}:${n?.sha256 ?? u}:${f}`,
				kind: s ? "tree" : "archive",
				url: u,
				mountPrefix: o,
				integrity: a
			}, t);
			break;
		} catch (d) {
			if (Ia(t.signal), Sa(d)) throw d;
			h.push(d instanceof Error ? d.message : String(d));
		}
		if (Ia(t.signal), null === l) throw new Error(`All ${c.length} lazy ${s ? "tree" : "archive"} transports failed: ${h.join("; ")}`);
		return l;
	}
	async materializeArchiveBytes(t, i, n, r) {
		if (Ia(r), t.materialized) return;
		const s = await this.prepareLazyArchiveContents(t, i, r), o = n ? e.inodeKey(n.ino, n.generation) : null;
		for (let e = 0; e < 3; e++) {
			const e = this.collectLazyArchiveReplacements(t, s, n);
			if (e.size > 0 && (Ia(r), !this.fs.replaceManyIfIdentities(Array.from(e.values(), ic)))) {
				if (this.reconcileLazyIdentityState(this.fs.identityState()), o && !this.lazyArchiveInodes.has(o)) return;
			} else {
				if (Ia(r), this.publishLazyArchiveReplacements(t, e), t.materialized) return;
				if (this.reconcileLazyIdentityState(this.fs.identityState()), o && !this.lazyArchiveInodes.has(o)) return;
			}
		}
		if (o && this.lazyArchiveInodes.has(o)) throw new Error(`Lazy archive member kept changing names while materializing: ${n?.path}`);
	}
	async prepareLazyArchiveContents(t, i, n, r) {
		Ia(n);
		const s = r?.content ?? t.content, o = r?.inventory ?? t.inventory, a = void 0 !== s && void 0 !== o ? await this.decodeAndValidateLazyTree(t, i, r) : null;
		Ia(n);
		const { parseZipCentralDirectory: c, extractZipEntry: h } = await import("./zip-DJ-is7oS.js");
		Ia(n);
		const l = a ? [] : c(i), d = /* @__PURE__ */ new Map();
		for (const e of l) {
			if (d.has(e.fileName)) throw new Error(`Lazy archive contains duplicate member: ${e.fileName}`);
			d.set(e.fileName, e);
		}
		const f = (r?.mountPrefix ?? t.mountPrefix).replace(/\/+$/, ""), u = /* @__PURE__ */ new Map(), p = void 0 === r ? Array.from(t.entries) : r.entries.map((e) => [e.vfsPath, e]);
		for (const [g, m] of p) {
			if (m.deleted || m.materialized) continue;
			const t = m.archivePath ?? g.slice(f.length + 1), n = a ? void 0 : d.get(t), r = a?.get(t);
			if (a) {
				if (void 0 === r || r.byteLength !== m.size) throw new Error(`Lazy tree member ${t} does not match its registered metadata`);
			} else if (void 0 === n || n.isDirectory || n.isSymlink || n.uncompressedSize !== m.size) throw new Error(`Lazy archive member ${t} does not match its registered metadata`);
			if (void 0 === m.generation) continue;
			const s = e.inodeKey(m.ino, m.generation), o = u.get(s);
			if (o && o.archivePath !== t) throw new Error(`Lazy archive aliases for inode ${s} name different members`);
			if (!o) {
				const e = r ?? h(i, n);
				if (e.byteLength !== m.size) throw new Error(`Lazy archive member ${t} extracted ${e.byteLength} bytes, expected ${m.size}`);
				u.set(s, {
					archivePath: t,
					content: e
				});
			}
		}
		return u;
	}
	collectLazyArchiveReplacements(t, i, n, r) {
		const s = /* @__PURE__ */ new Map(), o = void 0 === r ? Array.from(t.entries) : r.entries.map((e) => [e.vfsPath, e]);
		for (const [a, c] of o) {
			if (c.deleted || c.materialized || void 0 === c.generation) continue;
			const r = e.inodeKey(c.ino, c.generation);
			if (this.lazyArchiveInodes.get(r) !== t) continue;
			const o = i.get(r);
			if (!o) throw new Error(`Lazy archive has no extracted content for inode ${r}`);
			let h = s.get(r);
			h || (h = {
				ino: c.ino,
				generation: c.generation,
				dataSequence: c.dataSequence ?? 0,
				paths: /* @__PURE__ */ new Set(),
				content: o.content
			}, s.set(r, h)), h.paths.add(a), n && n.ino === c.ino && n.generation === c.generation && h.paths.add(n.path);
		}
		return s;
	}
	publishLazyArchiveReplacements(e, t) {
		for (const [i, n] of t) {
			this.lazyArchiveInodes.delete(i);
			for (const t of e.entries.values()) t.ino === n.ino && t.generation === n.generation && (t.materialized = !0);
		}
		e.materialized = Array.from(e.entries.values()).every((e) => e.deleted || e.materialized);
	}
	collectAtomicTreeNamespace(t, i) {
		const n = /* @__PURE__ */ new Set(), r = /* @__PURE__ */ new Map(), s = /* @__PURE__ */ new Map(), o = new Map(i.entries.map((e) => [e.vfsPath, e]));
		for (const e of i.inventory) "file" !== e.type && "hardlink" !== e.type || s.set(e.inodeGroup, (s.get(e.inodeGroup) ?? 0) + 1);
		const a = [];
		for (const c of i.inventory) {
			let i;
			try {
				i = this.fs.lstat(c.vfsPath);
			} catch {
				throw new Error(`Lazy atomic tree changed at ${c.vfsPath}`);
			}
			const h = "directory" === c.type ? Oo : "symlink" === c.type ? No : $o;
			if ((i.mode & Uo) !== h || (4095 & i.mode) !== c.mode) throw new Error(`Lazy atomic tree changed at ${c.vfsPath}`);
			if ("symlink" === c.type) {
				const e = o.get(c.vfsPath);
				if (void 0 === e || !e.isSymlink || e.deleted || e.ino !== i.ino || e.generation !== i.generation || e.dataSequence !== i.dataSequence || this.fs.readlink(c.vfsPath) !== c.target) throw new Error(`Lazy atomic tree changed at ${c.vfsPath}`);
			} else if ("file" === c.type || "hardlink" === c.type) {
				const a = o.get(c.vfsPath);
				if (void 0 === a || a.deleted || a.materialized || a.isSymlink || void 0 === a.generation || a.inodeGroup !== c.inodeGroup || a.ino !== i.ino || a.generation !== i.generation || a.dataSequence !== i.dataSequence || 0 !== i.size || i.linkCount !== s.get(c.inodeGroup)) throw new Error(`Lazy atomic tree changed at ${c.vfsPath}`);
				const h = e.inodeKey(a.ino, a.generation);
				if (this.lazyArchiveInodes.get(h) !== t) throw new Error(`Lazy atomic tree lost deferred ownership of ${c.vfsPath}`);
				const l = r.get(c.inodeGroup);
				if (void 0 !== l && l !== h) throw new Error(`Lazy atomic tree split hard links at ${c.vfsPath}`);
				r.set(c.inodeGroup, h), n.add(h);
			}
			a.push({
				path: c.vfsPath,
				expectedIno: i.ino,
				expectedGeneration: i.generation,
				expectedDataSequence: i.dataSequence,
				expectedMode: i.mode,
				expectedLinkCount: i.linkCount,
				expectedSize: i.size,
				expectedUid: i.uid,
				expectedGid: i.gid
			});
		}
		return {
			guards: a,
			pendingIdentities: n.size
		};
	}
	assertLazyAtomicSnapshotMatchesPublic(e) {
		const t = this.sealedLazyAtomicStates.get(e), i = t?.snapshot, n = e.activation?.atomicGroup, r = i?.member ?? n?.member ?? "unknown";
		let s;
		if (void 0 !== i) try {
			s = Ya(e, i.id, i.member);
		} catch {
			s = void 0;
		}
		if (void 0 === t || void 0 === i || void 0 === n || !Wa(n) || n.id !== i.id || n.member !== i.member || n.descriptorSha256 !== i.descriptorSha256 || n.expectedCount !== i.expectedCount || n.cohortSha256 !== i.cohortSha256 || void 0 === s || !ec(i, s)) throw new Error(`Lazy atomic activation member ${r} changed after sealing`);
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
			const i = [...t.groups.entries()].sort(([e], [t]) => e < t ? -1 : e > t ? 1 : 0).map(([, e]) => e);
			await this.ensureLazyAtomicGroupSealValidated(t, i, e);
		}
	}
	async ensureLazyAtomicGroupSealValidated(e, t, i) {
		if (this.assertLazyAtomicGroupSealValidatedAtLinearization(e, t, i)) return;
		let n = e.sealValidationFlight;
		if (void 0 === n && (n = this.validateLazyAtomicGroupSealOnce(e, t), e.sealValidationFlight = n, n.then(() => {
			e.sealValidationFlight === n && (e.sealValidationFlight = void 0);
		}, () => {
			e.sealValidationFlight === n && (e.sealValidationFlight = void 0);
		})), await n, !this.assertLazyAtomicGroupSealValidatedAtLinearization(e, t, i)) throw new Error(`Lazy atomic activation group ${e.id} seal verification did not authenticate every member`);
	}
	assertLazyAtomicGroupSealValidatedAtLinearization(e, t, i) {
		if (e.committed) return !0;
		if (void 0 === e.expectedCount || void 0 === e.cohortSha256 || t.length !== e.expectedCount) throw new Error(`Lazy atomic activation group ${e.id} is not completely sealed`);
		let n = !0;
		const r = [];
		for (const s of t) {
			const t = this.assertLazyAtomicSnapshotMatchesPublic(s), i = t.snapshot;
			if (i.id !== e.id || i.expectedCount !== e.expectedCount || i.cohortSha256 !== e.cohortSha256 || e.groups.get(i.member) !== s) throw new Error(`Lazy atomic activation group ${e.id} has an inconsistent member`);
			n &&= t.verified, r.push(t);
		}
		if (n && i) for (let s = 0; s < t.length; s++) this.collectAtomicTreeNamespace(t[s], r[s].snapshot);
		return n;
	}
	async validateLazyAtomicGroupSealOnce(e, t) {
		const i = [], n = [];
		for (const r of t) {
			const t = this.assertLazyAtomicSnapshotMatchesPublic(r), s = t.snapshot;
			if (s.id !== e.id || s.expectedCount !== e.expectedCount || s.cohortSha256 !== e.cohortSha256 || e.groups.get(s.member) !== r) throw new Error(`Lazy atomic activation group ${e.id} has an inconsistent member`);
			const o = await Ga(s.descriptorBytes, `Lazy atomic member ${s.member}`);
			if (o !== s.descriptorSha256) throw new Error(`Lazy atomic activation member ${s.member} changed after sealing`);
			i.push({
				member: s.member,
				descriptorSha256: o
			}), n.push(t);
		}
		if (await Ga(ja(e.id, i), `Lazy atomic activation group ${e.id}`) !== e.cohortSha256) throw new Error(`Lazy atomic activation group ${e.id} differs from its seal`);
		for (const r of t) this.assertLazyAtomicSnapshotMatchesPublic(r);
		for (const r of n) r.verified = !0;
	}
	async ensureAtomicLazyGroupMaterialized(t) {
		if (t.committed) return;
		const i = [...t.groups.entries()].sort(([e], [t]) => e < t ? -1 : e > t ? 1 : 0).map(([, e]) => e);
		if (0 === i.length) throw new Error(`Lazy atomic activation group ${t.id} has no trees`);
		if (await this.ensureLazyAtomicGroupSealValidated(t, i, !0), t.committed) return;
		const n = i.map((e) => this.sealedLazyAtomicStates.get(e).snapshot), r = i.map((e, t) => ({
			group: e,
			...this.collectAtomicTreeNamespace(e, n[t])
		})), s = this.lazyTransport, o = new Array(i.length);
		let a, c = 0, h = !1;
		const l = Array.from({ length: Math.min(4, i.length) }, async () => {
			for (; !h;) {
				const t = c++;
				if (t >= i.length) return;
				const r = i[t], l = n[t];
				try {
					const e = await this.fetchLazyArchiveData(r, s, l);
					Ia(s.signal), o[t] = {
						group: r,
						snapshot: l,
						contents: await this.prepareLazyArchiveContents(r, e, s.signal, l)
					};
				} catch (e) {
					h || (h = !0, a = e);
				}
			}
		});
		if (await Promise.all(l), h) throw o.fill(void 0), a;
		Ia(s.signal);
		for (const e of i) this.assertLazyAtomicSnapshotMatchesPublic(e);
		const d = [], f = [], u = [];
		for (let p = 0; p < o.length; p++) {
			const i = o[p], n = this.collectLazyArchiveReplacements(i.group, i.contents, void 0, i.snapshot), s = r[p];
			if (n.size !== s.pendingIdentities) throw new Error(`Lazy atomic activation group ${t.id} changed before commit`);
			const a = [];
			for (const [e, t] of n) a.push(e), d.push(ic(t));
			for (const r of i.snapshot.entries) {
				if (r.deleted || r.materialized || void 0 === r.generation) continue;
				const i = e.inodeKey(r.ino, r.generation);
				if (!n.has(i)) throw new Error(`Lazy atomic activation group ${t.id} has an incomplete publication`);
			}
			u.push({
				group: i.group,
				snapshot: i.snapshot,
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
				const i = e.group.entries.get(t.vfsPath);
				void 0 !== i && (i.materialized = !0);
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
			for (const n of t) await this.ensureMaterialized(n);
			const i = new Set(this.lazyArchiveInodes.values());
			for (const n of e) i.add(n);
			for (const n of i) await this.prepareLazyTreeGroup(n);
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
		const { bytes: t, identities: i } = this.fs.snapshotState({ normalizeTimestampsMs: e?.normalizeTimestampsMs });
		this.reconcileLazyIdentityState(i);
		const n = this.serializeLazyEntries(), r = n.length > 0, s = r ? new TextEncoder().encode(JSON.stringify(n)) : new Uint8Array(0);
		if (s.byteLength > Do) throw new Error("VFS image lazy metadata exceeds 16777216 bytes");
		const o = this.serializeValidatedLazyArchiveEntries(i), a = o.length > 0, c = a ? new TextEncoder().encode(JSON.stringify(o)) : new Uint8Array(0);
		if (c.byteLength > Vo) throw new Error("VFS image lazy archive metadata exceeds 16777216 bytes");
		const h = function(e) {
			if (null === e) return new Uint8Array(0);
			const t = da(e), i = new TextEncoder().encode(JSON.stringify(t));
			if (i.byteLength > Wo) throw new Error("VFS image metadata exceeds 65536 bytes");
			return i;
		}(void 0 === e?.metadata ? this.imageMetadata : e.metadata), l = h.byteLength > 0, d = a ? 4 + c.byteLength : 0, f = l ? 4 + h.byteLength : 0, u = Ro + t.byteLength + 4 + s.byteLength + d + f, p = new Uint8Array(u), g = new DataView(p.buffer);
		g.setUint32(0, Fo, !0), g.setUint32(4, 1, !0), g.setUint32(8, (r ? 1 : 0) | (a ? 2 : 0) | (a ? 8 : 0) | (l ? 4 : 0), !0), g.setUint32(12, t.byteLength, !0), p.set(t, Ro);
		const m = Ro + t.byteLength;
		if (g.setUint32(m, s.byteLength, !0), s.byteLength > 0 && p.set(s, m + 4), a) {
			const e = m + 4 + s.byteLength;
			g.setUint32(e, c.byteLength, !0), p.set(c, e + 4);
		}
		if (l) {
			const e = m + 4 + s.byteLength + d;
			g.setUint32(e, h.byteLength, !0), p.set(h, e + 4);
		}
		return p;
	}
	static readImageMetadata(e) {
		const t = ua(e);
		if (!(4 & t.flags)) return null;
		const { metadataOffset: i } = pa(t.image, t.view, t.flags, t.sabLen);
		if (t.image.byteLength < i + 4) throw new Error("VFS image truncated (metadata section)");
		const n = t.view.getUint32(i, !0);
		if (n > Wo) throw new Error("VFS image metadata exceeds 65536 bytes");
		if (t.image.byteLength < i + 4 + n) throw new Error("VFS image truncated (metadata payload)");
		return 0 === n ? null : function(e) {
			if (e.byteLength > Wo) throw new Error("VFS image metadata exceeds 65536 bytes");
			let t;
			try {
				t = JSON.parse(new TextDecoder().decode(e));
			} catch (i) {
				const e = i instanceof Error ? i.message : String(i);
				throw new Error(`Invalid VFS image metadata JSON: ${e}`);
			}
			return da(t);
		}(t.image.subarray(i + 4, i + 4 + n));
	}
	static assertImageKernelAbi(t, i, n = "VFS image") {
		const r = e.readImageMetadata(t)?.kernelAbi;
		if (void 0 !== r && r !== i) throw new Error(`${n} requires kernel ABI ${r}, but the running kernel is ABI ${i}`);
	}
	static readImageCapacity(e) {
		const t = ua(e);
		return Ys.inspectImageCapacity(t.image.subarray(Ro, Ro + t.sabLen));
	}
	static fromImagePreservingCapacity(t) {
		const i = ua(t), n = Ys.inspectImageCapacity(i.image.subarray(Ro, Ro + i.sabLen));
		return e.restoreParsedImage(i, { maxByteLength: n.maxByteLength });
	}
	static fromImage(t, i) {
		const n = ua(t, i?.maxDecompressedBytes);
		return e.restoreParsedImage(n, i);
	}
	static restoreParsedImage(t, i) {
		const n = t.image, r = t.view, s = t.flags, o = t.sabLen, a = pa(n, r, s, o);
		if (!(1 & s) && 0 !== a.lazyLen) throw new Error("VFS image has lazy metadata without its format flag");
		if (8 & s && !(2 & s)) throw new Error("VFS image has typed lazy-archive metadata without its archive flag");
		const c = i?.maxByteLength ? { maxByteLength: i.maxByteLength } : void 0, h = new SharedArrayBuffer(o, c);
		new Uint8Array(h).set(n.subarray(Ro, Ro + o));
		let l = null;
		4 & s && (l = e.readImageMetadata(n));
		const d = new e(Ys.mount(h, { restoreImage: !0 }), l), f = Ro + o, u = a.lazyLen;
		if (1 & s && u > 0) {
			const e = _a(ga(n.subarray(f + 4, f + 4 + u), "VFS image lazy metadata"), "VFS image lazy entries", 0, jo);
			d.importLazyEntriesInternal(e, !0);
		}
		if (2 & s) {
			const e = a.archiveOffset, t = r.getUint32(e, !0);
			if (t > 0) {
				const i = ga(n.subarray(e + 4, e + 4 + t), "VFS image lazy archive metadata");
				d.importLazyArchiveEntriesInternal(i, !0, Boolean(8 & s), "pending");
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
		const t = this.adaptStat(e), i = this.lazyFileForStat(e);
		if (i) return t.size = i.size, t;
		const n = this.lazyArchiveForStat(e);
		if (n) {
			for (const r of this.lazyArchiveEntriesForRead(n)) if (r.ino === e.ino && r.generation === e.generation && !r.deleted) {
				t.size = r.size;
				break;
			}
		}
		return t;
	}
	open(e, t, i) {
		512 & t || 64 & t && 128 & t || this.guardSynchronousLazyAccess(e);
		const n = this.fs.open(e, t, i);
		return 512 & t && this.invalidateLazyData(this.fs.fstat(n)), n;
	}
	close(e) {
		return this.fs.close(e), 0;
	}
	read(e, t, i, n) {
		if (n > 0) {
			let t = this.lazyBackingForStat(this.fs.fstat(e));
			t && (this.reconcileLazyIdentityState(this.fs.identityState()), t = this.lazyBackingForStat(this.fs.fstat(e)), t && this.guardSynchronousLazyAccess(t.path));
		}
		return null !== i ? this.fs.readAt(e, t.subarray(0, n), i) : this.fs.read(e, t.subarray(0, n));
	}
	write(e, t, i, n) {
		if (null !== i) {
			const r = this.fs.writeAt(e, t.subarray(0, n), i);
			return r > 0 && this.invalidateLazyData(this.fs.fstat(e)), r;
		}
		const r = this.fs.write(e, t.subarray(0, n));
		return r > 0 && this.invalidateLazyData(this.fs.fstat(e)), r;
	}
	seek(e, t, i) {
		return this.fs.lseek(e, t, i);
	}
	fstat(e) {
		return this.adaptStatWithLazySize(this.fs.fstat(e));
	}
	fpathconf(e, t) {
		return Kr(this.fstat(e), t, {
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
	fchown(e, t, i) {
		this.fs.fchown(e, t, i);
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
		return Kr(this.stat(e), t, {
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
		const i = this.fs.unlink(t), n = e.inodeKey(i.ino, i.generation);
		if (i.linkCount > 1 && (this.lazyFiles.has(n) || this.lazyArchiveInodes.has(n))) return void this.reconcileLazyIdentityState(this.fs.identityState());
		const r = this.lazyFiles.get(n);
		r && (r.paths.delete(t), i.linkCount <= 1 ? this.lazyFiles.delete(n) : r.path === t && (r.path = r.paths.values().next().value));
		const s = this.lazyArchiveInodes.get(n);
		if (s) {
			const e = s.entries.get(t);
			if (i.linkCount <= 1) {
				for (const e of s.entries.values()) e.ino === i.ino && e.generation === i.generation && (e.deleted = !0);
				this.lazyArchiveInodes.delete(n);
			} else e && s.entries.delete(t);
		}
	}
	rename(t, i) {
		const { source: n, replaced: r } = this.fs.rename(t, i);
		if (r && r.ino === n.ino && r.generation === n.generation) return;
		let s = !1;
		if (r) {
			const t = e.inodeKey(r.ino, r.generation);
			r.linkCount > 1 && (this.lazyFiles.has(t) || this.lazyArchiveInodes.has(t)) && (this.reconcileLazyIdentityState(this.fs.identityState()), s = !0);
			const n = this.lazyFiles.get(t);
			!s && n && (n.paths.delete(i), r.linkCount <= 1 ? this.lazyFiles.delete(t) : n.path === i && (n.path = n.paths.values().next().value));
			const o = this.lazyArchiveInodes.get(t);
			if (!s && o) {
				const e = o.entries.get(i);
				r.linkCount <= 1 ? (e && (e.deleted = !0), this.lazyArchiveInodes.delete(t)) : e && o.entries.delete(i);
			}
		}
		s || this.rewriteLazyNamespacePaths(n, t, i);
	}
	link(t, i) {
		const n = this.fs.link(t, i), r = e.inodeKey(n.ino, n.generation), s = this.lazyFiles.get(r);
		s && s.paths.add(i);
		const o = this.lazyArchiveInodes.get(r);
		if (o) {
			const e = Array.from(o.entries.values()).find((e) => e.ino === n.ino && e.generation === n.generation);
			e && o.entries.set(i, { ...e });
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
	chown(e, t, i) {
		this.fs.chown(e, t, i);
	}
	lchown(e, t, i) {
		this.fs.lchown(e, t, i);
	}
	createFileWithOwner(e, t, i, n, r) {
		const s = this.open(e, 577, t);
		r.length > 0 && this.write(s, r, null, r.length), this.close(s), this.chown(e, i, n), this.chmod(e, t);
	}
	mkdirWithOwner(e, t, i, n) {
		this.mkdir(e, t), this.chown(e, i, n), this.chmod(e, t);
	}
	symlinkWithOwner(e, t, i, n) {
		this.symlink(e, t), this.lchown(t, i, n);
	}
	copyPathToFreshFileSystem(t, i, n, r, s) {
		const o = this.lstat(t), a = o.mode & Uo, c = 4095 & o.mode;
		if (a === Oo) {
			"/" === t ? (i.chown(t, o.uid, o.gid), i.chmod(t, c)) : i.mkdirWithOwner(t, c, o.uid, o.gid);
			const a = this.opendir(t);
			try {
				for (;;) {
					const e = this.readdir(a);
					if (!e) break;
					"." !== e.name && ".." !== e.name && this.copyPathToFreshFileSystem("/" === t ? `/${e.name}` : `${t}/${e.name}`, i, n, r, s);
				}
			} finally {
				this.closedir(a);
			}
			e.applyTimes(i, t, o);
			return;
		}
		const h = o.nlink > 1 ? `${o.dev}:${o.ino}` : null, l = h ? s.get(h) : void 0;
		if (l) i.link(l, t);
		else {
			if (a === No) return i.symlinkWithOwner(this.readlink(t), t, o.uid, o.gid), void (h && s.set(h, t));
			if (a !== $o) throw new Error(`Unsupported file type while rebasing VFS: ${t}`);
			if (n.has(t) || r.has(t)) return i.createFileWithOwner(t, c, o.uid, o.gid, new Uint8Array(0)), e.applyTimes(i, t, o), void (h && s.set(h, t));
			this.copyRegularFileToFreshFileSystem(t, i, o, c), h && s.set(h, t);
		}
	}
	copyRegularFileToFreshFileSystem(t, i, n, r) {
		const s = this.open(t, 0, 0);
		let o = null;
		try {
			o = i.open(t, 577, r);
			const e = new Uint8Array(Math.min(1048576, Math.max(1, n.size)));
			let a = n.size;
			for (; a > 0;) {
				const n = Math.min(e.byteLength, a), r = this.read(s, e, null, n);
				if (r <= 0) throw new Error(`Unexpected EOF while rebasing VFS file: ${t}`);
				let c = 0;
				for (; c < r;) {
					const n = i.write(o, e.subarray(c, r), null, r - c);
					if (n <= 0) throw new Error(`Short write while rebasing VFS file: ${t}`);
					c += n;
				}
				a -= r;
			}
		} finally {
			null !== o && i.close(o), this.close(s);
		}
		i.chown(t, n.uid, n.gid), i.chmod(t, r), e.applyTimes(i, t, n);
	}
	static applyTimes(e, t, i) {
		const n = Math.floor(i.atimeMs / 1e3), r = Math.floor(1e6 * (i.atimeMs - 1e3 * n)), s = Math.floor(i.mtimeMs / 1e3), o = Math.floor(1e6 * (i.mtimeMs - 1e3 * s));
		e.utimensat(t, n, r, s, o);
	}
	access(e, t) {
		this.fs.stat(e);
	}
	utimensat(e, t, i, n, r) {
		this.fs.utimens(e, t, i, n, r);
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
var rc = class {
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
		const i = 1e3 * e + Math.floor(t / 1e6);
		if (i > 0) {
			const e = new SharedArrayBuffer(4);
			Atomics.wait(new Int32Array(e), 0, 0, i);
		}
	}
};
async function sc(e, t) {
	const i = nc.fromImage(e, t);
	return await i.verifyImportedLazyAtomicGroupSeals(), i;
}
const oc = [
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
function ac(e) {
	const t = function(e, t) {
		let i = null;
		try {
			const n = e.stat(t);
			i = e.open(t, 0, 0);
			const r = new Uint8Array(n.size);
			let s = 0;
			for (; s < r.byteLength;) {
				const t = e.read(i, r.subarray(s), null, r.byteLength - s);
				if (t <= 0) break;
				s += t;
			}
			return new TextDecoder().decode(r.subarray(0, s));
		} catch {
			return null;
		} finally {
			if (null !== i) try {
				e.close(i);
			} catch {}
		}
	}(e, "/etc/group");
	null === t || /^nobody:/m.test(t) || function(e, t, i) {
		const n = new TextEncoder().encode(i), r = e.open(t, 577, 420);
		try {
			n.byteLength > 0 && e.write(r, n, null, n.byteLength);
		} finally {
			e.close(r);
		}
	}(e, "/etc/group", `${t.replace(/\n?$/, "\n")}nobody:x:65534:\n`);
}
function cc(e, t, i = {}) {
	return function(e) {
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
	}(e), async function(e, t, i) {
		const n = await async function(e, t) {
			const i = new Map(await Promise.all(e.filter((e) => "image" === e.source).map(async (e) => [e, await sc(t, { maxByteLength: 1073741824 })])));
			for (const n of i.values()) ac(n);
			return i;
		}(e, t), r = [];
		for (const s of e) if ("image" === s.source) {
			const e = n.get(s);
			if (void 0 === e) throw new Error(`verified image mount is missing: ${s.path}`);
			r.push({
				mountPoint: s.path,
				backend: e,
				readonly: s.readonly
			});
		} else {
			const e = i.scratchSabBytes?.[s.path] ?? 16777216, t = new SharedArrayBuffer(e), n = nc.create(t);
			void 0 !== s.mode && n.chmod("/", s.mode), void 0 === s.uid && void 0 === s.gid || n.chown("/", s.uid ?? 0, s.gid ?? 0), r.push({
				mountPoint: s.path,
				backend: n,
				readonly: s.readonly
			});
		}
		return r;
	}(e, t, i);
}
const hc = (1n << 64n) - 1n;
function lc(e, t) {
	if ("bigint" == typeof e) {
		if (e >= 0n && e <= hc) return e;
	} else if (Number.isSafeInteger(e) && e >= 0) return BigInt(e);
	const i = /* @__PURE__ */ new Error(`EOVERFLOW: ${t} is not exactly representable as an unsigned 64-bit value`);
	throw i.code = "EOVERFLOW", i;
}
var dc = class {
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
		const i = /* @__PURE__ */ new Map();
		let n = 1;
		if (this.mounts = e.map((e) => {
			let t = i.get(e.backend);
			return void 0 === t && (t = n++, i.set(e.backend, t)), {
				prefix: (r = e.mountPoint, "/" !== r && r.endsWith("/") ? r.slice(0, -1) : r),
				backend: e.backend,
				backendId: t
			};
			var r;
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
				let i = e.slice(t.prefix.length);
				return i.startsWith("/") || (i = "/" + i), {
					backend: t.backend,
					backendId: t.backendId,
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
	qualifyStat(e, t) {
		const i = lc(t.dev, "st_dev"), n = lc(t.ino, "st_ino");
		let r = this.qualifiedDeviceIds.get(e);
		void 0 === r && (r = /* @__PURE__ */ new Map(), this.qualifiedDeviceIds.set(e, r));
		let s = r.get(i);
		if (void 0 === s) {
			if (this.nextQualifiedDeviceId > hc) {
				const e = /* @__PURE__ */ new Error("EOVERFLOW: exhausted virtual filesystem device identities");
				throw e.code = "EOVERFLOW", e;
			}
			s = this.nextQualifiedDeviceId++, r.set(i, s);
		}
		return {
			...t,
			dev: s,
			ino: n
		};
	}
	fileIdentity(e, t, i) {
		if (i <= 0n || t < 0n) return null;
		const { backendId: n } = this.resolve(e);
		return `vfs:${n}:${t}:${i}`;
	}
	fileHandleIdentity(e, t, i) {
		if (i <= 0n || t < 0n) return null;
		const { backendId: n } = this.getFileHandle(e);
		return `vfs:${n}:${t}:${i}`;
	}
	async preparePath(e) {
		const { backend: t, relativePath: i } = this.resolve(e);
		return t.preparePath?.(i) ?? !1;
	}
	open(e, t, i) {
		const { backend: n, backendId: r, relativePath: s } = this.resolve(e), o = n.open(s, t, i), a = this.nextFileHandle++;
		return this.fileHandles.set(a, {
			backend: n,
			backendId: r,
			localHandle: o
		}), a;
	}
	close(e) {
		const t = this.getFileHandle(e), i = t.backend.close(t.localHandle);
		return this.fileHandles.delete(e), i;
	}
	read(e, t, i, n) {
		const r = this.getFileHandle(e);
		return r.backend.read(r.localHandle, t, i, n);
	}
	write(e, t, i, n) {
		const r = this.getFileHandle(e);
		return r.backend.write(r.localHandle, t, i, n);
	}
	seek(e, t, i) {
		const n = this.getFileHandle(e);
		return n.backend.seek(n.localHandle, t, i);
	}
	fstat(e) {
		const t = this.getFileHandle(e);
		return this.qualifyStat(t.backend, t.backend.fstat(t.localHandle));
	}
	fpathconf(e, t) {
		const i = this.getFileHandle(e);
		return i.backend.fpathconf(i.localHandle, t);
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
		return this.qualifyStat(t, t.stat(i));
	}
	lstat(e) {
		const { backend: t, relativePath: i } = this.resolve(e);
		return this.qualifyStat(t, t.lstat(i));
	}
	statfs(e) {
		const { backend: t, relativePath: i } = this.resolve(e);
		return t.statfs(i);
	}
	pathconf(e, t) {
		const { backend: i, relativePath: n } = this.resolve(e);
		return i.pathconf(n, t);
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
		const { backend: i, rel1: n, rel2: r } = this.resolveTwoPaths(e, t);
		i.rename(n, r);
	}
	link(e, t) {
		const { backend: i, rel1: n, rel2: r } = this.resolveTwoPaths(e, t);
		i.link(n, r);
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
		const { backend: n, relativePath: r } = this.resolve(e);
		n.chown(r, t, i);
	}
	lchown(e, t, i) {
		const { backend: n, relativePath: r } = this.resolve(e);
		n.lchown(r, t, i);
	}
	access(e, t) {
		const { backend: i, relativePath: n } = this.resolve(e);
		i.access(n, t);
	}
	utimensat(e, t, i, n, r) {
		const { backend: s, relativePath: o } = this.resolve(e);
		s.utimensat(o, t, i, n, r);
	}
	opendir(e) {
		const { backend: t, backendId: i, relativePath: n } = this.resolve(e), r = t.opendir(n), s = this.nextDirHandle++;
		return this.dirHandles.set(s, {
			backend: t,
			backendId: i,
			localHandle: r
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
(function(e = globalThis) {
	if (void 0 !== e.setImmediate) return null;
	const t = [], i = /* @__PURE__ */ new Map();
	let n = 0, r = !1, s = !1;
	const o = new e.MessageChannel();
	function a() {
		r || s || (r = !0, o.port2.postMessage(null));
	}
	o.port1.onmessage = function() {
		r = !1, s = !0;
		const e = t.length;
		for (let r = 0; r < e && t.length > 0; r++) {
			const e = t.shift();
			if (i.delete(e.handle), !e.cancelled) try {
				e.fn(...e.args);
			} catch (n) {
				console.error("[setImmediate] callback threw:", n);
			}
		}
		s = !1, t.length > 0 && a();
	}, e.setImmediate = (e, ...r) => {
		const s = { id: ++n }, o = {
			handle: s,
			fn: e,
			args: r,
			cancelled: !1
		};
		return t.push(o), i.set(s, o), a(), s;
	}, e.clearImmediate = (e) => {
		if ("object" != typeof e || null === e) return;
		const t = i.get(e);
		void 0 !== t && (t.cancelled = !0, i.delete(t.handle));
	};
})();
const fc = 16384, uc = new TextEncoder(), pc = new TextDecoder();
let mc = null, yc = !1;
function wc(e) {
	self.postMessage(e);
}
function bc(e, t) {
	wc({
		type: "machine",
		machine: e,
		status: t
	});
}
function kc(e, t) {
	wc({
		type: "step",
		step: e,
		status: t
	});
}
function vc(e, t, i) {
	0 !== i.length && wc({
		type: "log",
		machine: e,
		stream: t,
		text: i
	});
}
function Sc(e, t, i, n) {
	wc({
		type: "result",
		step: e,
		title: t,
		ok: i,
		detail: n
	});
}
async function Pc(e) {
	const t = await fetch(e);
	if (!t.ok) throw new Error(`failed to fetch ${e}: ${t.status}`);
	return t.arrayBuffer();
}
async function Ic(e, t, i) {
	const n = /* @__PURE__ */ new Map(), r = fi(i.programBytes);
	let s = 0, o = "", a = "", c = !1;
	bc(i.machine, `running ${i.programName}`);
	const h = await async function(e, t, i, n) {
		const r = new dc([
			{
				mountPoint: "/dev/shm",
				backend: nc.create(new SharedArrayBuffer(1048576))
			},
			{
				mountPoint: "/dev",
				backend: new Jr()
			},
			...await cc(oc, t)
		], new rc());
		return r.network = e.attachMachine({
			id: i,
			address: n,
			hostnames: [i]
		}), r;
	}(e, t.rootfs, i.machine, i.address), l = new Cr("/kandelo/assets/worker-entry-browser-C5xrjVDr.js");
	let d, f;
	const u = new Promise((e, t) => {
		d = e, f = t;
	}), p = new Ar({
		maxWorkers: 4,
		dataBufferSize: 65536,
		useSharedMemory: !0
	}, h, {
		onExit: (e, t) => {
			c || e === s && (c = !0, p.unregisterProcess(e), n.get(e)?.terminate().catch(() => {}), n.delete(e), d(t));
		},
		onExitGroup: (e) => {
			n.get(e)?.terminate().catch(() => {}), n.delete(e);
		}
	});
	p.usePolling = !1, p.relistenBatchSize = 8, p.setOutputCallbacks({
		onStdout: (e) => {
			const t = pc.decode(e);
			o += t, vc(i.machine, "stdout", t);
		},
		onStderr: (e) => {
			const t = pc.decode(e);
			a += t, vc(i.machine, "stderr", t);
		}
	}), await p.init(t.kernel);
	const g = function(e, t = 17) {
		return 8 === e ? new WebAssembly.Memory({
			initial: BigInt(t),
			maximum: BigInt(fc),
			shared: !0,
			address: "i64"
		}) : new WebAssembly.Memory({
			initial: t,
			maximum: fc,
			shared: !0
		});
	}(r), m = 1073610752;
	(function(e, t, i) {
		const n = fc - i;
		n <= 0 || (8 === t ? e.grow(BigInt(n)) : e.grow(n));
	})(g, r, 17), new Uint8Array(g.buffer, m, 65608).fill(0), s = p.createProcess(zr), p.registerProcess(s, g, [m], {
		argv: i.argv,
		ptrWidth: r
	});
	const y = function(e) {
		const t = new Uint8Array(e);
		if (t.length < 8) return null;
		let i = 0, n = 0, r = null, s = null, o = 8;
		for (; o < t.length;) {
			const e = t[o], [a, c] = ci(t, o + 1), h = o + 1 + c;
			if (2 === e) {
				const e = {
					funcImports: n,
					globalImports: i
				};
				let r = h;
				const [s, o] = ci(t, r);
				r += o;
				for (let i = 0; i < s; i++) r = hi(t, r, e);
				n = e.funcImports, i = e.globalImports;
			} else if (6 === e) s = {
				offset: h,
				size: a
			};
			else if (7 === e) {
				let e = h;
				const [i, n] = ci(t, e);
				e += n;
				for (let s = 0; s < i; s++) {
					const [i, n] = ci(t, e);
					e += n;
					const s = new TextDecoder().decode(t.subarray(e, e + i));
					e += i;
					const o = t[e++], [a, c] = ci(t, e);
					if (e += c, 3 === o && "__heap_base" === s) {
						r = a;
						break;
					}
				}
				if (null === r) return null;
				if (null === s) return null;
				break;
			}
			o = h + a;
		}
		if (null === r || null === s) return null;
		const a = r - i;
		if (a < 0) return null;
		let c = s.offset;
		const [h, l] = ci(t, c);
		if (c += l, a >= h) return null;
		for (let d = 0; d < a; d++) c = di(t, c);
		return li(t, c);
	}(i.programBytes);
	null !== y && p.setBrkBase(s, y), void 0 !== i.stdin && p.setStdinData(s, uc.encode(i.stdin));
	const w = {
		type: "centralized_init",
		pid: s,
		programBytes: i.programBytes,
		memory: g,
		channelOffset: m,
		argv: i.argv,
		ptrWidth: r
	}, b = l.createWorker(w);
	n.set(s, b);
	const k = i.timeoutMs ?? 15e3, v = setTimeout(() => {
		if (!c) {
			c = !0;
			for (const e of n.values()) e.terminate().catch(() => {});
			n.clear(), f(/* @__PURE__ */ new Error(`${i.machine} ${i.programName} timed out after ${k}ms`));
		}
	}, k);
	b.on("error", (e) => {
		c || (c = !0, clearTimeout(v), f(e));
	}), b.on("message", (e) => {
		const t = e;
		"error" !== t.type || t.pid !== s || c || (c = !0, clearTimeout(v), f(new Error(t.message)));
	});
	try {
		const e = await u;
		return clearTimeout(v), bc(i.machine, 0 === e ? "passed" : `failed ${e}`), {
			exitCode: e,
			stdout: o,
			stderr: a
		};
	} finally {
		clearTimeout(v);
		for (const e of n.values()) e.terminate().catch(() => {});
		n.clear(), e.detachMachine(i.machine);
	}
}
function zc(e) {
	return new Promise((t) => setTimeout(t, e));
}
function xc(e) {
	return e.map((e) => e.includes(" ") ? JSON.stringify(e) : e).join(" ");
}
async function Ec(e, t) {
	kc("udp", "running");
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
	vc("runner", "system", `UDP alpha: ${xc(i)}\nUDP beta: ${xc(n)}`), vc("beta", "stdin", "hello from beta over udp\n");
	const r = Ic(e, t, {
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
	await zc(100);
	const s = Ic(e, t, {
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
	}), [o, a] = await Promise.all([r, s]), c = 0 === o.exitCode && 0 === a.exitCode && o.stdout.includes("hello from beta over udp");
	return kc("udp", c ? "passed" : "failed"), Sc("udp", "UDP datagram", c, c ? "alpha received beta's datagram through POSIX recv/read on a UDP socket." : `server=${o.exitCode}, client=${a.exitCode}`), c;
}
async function Mc(e, t) {
	kc("tcp", "running");
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
	vc("runner", "system", `TCP alpha: ${xc(i)}\nTCP beta: ${xc(n)}`), vc("beta", "stdin", "hello from beta over tcp\n");
	const r = Ic(e, t, {
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
	await zc(100);
	const s = Ic(e, t, {
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
	}), [o, a] = await Promise.all([r, s]), c = 0 === o.exitCode && 0 === a.exitCode && o.stdout.includes("hello from beta over tcp");
	return kc("tcp", c ? "passed" : "failed"), Sc("tcp", "TCP stream", c, c ? "alpha accepted beta's TCP connection and received stream data." : `server=${o.exitCode}, client=${a.exitCode}`), c;
}
async function Ac(e, t) {
	kc("curl", "running");
	const i = "hello from alpha via curl\n", n = [
		"HTTP/1.0 200 OK",
		"Content-Type: text/plain",
		`Content-Length: ${uc.encode(i).length}`,
		"Connection: close",
		"",
		i
	].join("\r\n"), r = [
		"nc",
		"-n",
		"-l",
		"-p",
		String(18080),
		"-w",
		"5"
	], s = [
		"curl",
		"-sS",
		"--max-time",
		"4",
		"http://10.88.0.2:18080/"
	];
	vc("runner", "system", `HTTP alpha: ${xc(r)}\nHTTP gamma: ${xc(s)}`), vc("runner", "system", `HTTP alpha stdin: generated ${uc.encode(n).length} byte response\n`), vc("alpha", "stdin", `${n.replaceAll("\r\n", "\n")}`);
	const o = Ic(e, t, {
		machine: "alpha",
		address: [
			10,
			88,
			0,
			2
		],
		programName: "nc http listen",
		programBytes: t.nc,
		argv: r,
		stdin: n,
		timeoutMs: 2e4
	});
	await zc(100);
	const a = Ic(e, t, {
		machine: "gamma",
		address: [
			10,
			88,
			0,
			4
		],
		programName: "curl",
		programBytes: t.curl,
		argv: s,
		timeoutMs: 2e4
	}), [c, h] = await Promise.all([o, a]), l = 0 === c.exitCode && 0 === h.exitCode && h.stdout.includes(i);
	return kc("curl", l ? "passed" : "failed"), Sc("curl", "curl over TCP", l, l ? "gamma fetched alpha's HTTP response through curl over the virtual TCP backend." : `server=${c.exitCode}, curl=${h.exitCode}`), l;
}
async function Cc() {
	if (!yc) {
		yc = !0, wc({
			type: "status",
			status: "loading artifacts"
		});
		try {
			const e = await async function() {
				if (!mc) {
					const e = Pc("/kandelo/assets/rootfs-BbcPuTLt.vfs");
					mc = Promise.all([
						Pc("/kandelo/assets/kandelo-kernel-CxcWONSd.wasm"),
						e,
						Pc("/kandelo/assets/nc-BzttWdgD.wasm"),
						Pc("/kandelo/assets/curl-CPnVkyl0.wasm")
					]).then(([e, t, i, n]) => ({
						kernel: e,
						rootfs: new Uint8Array(t),
						nc: i,
						curl: n
					}));
				}
				return mc;
			}();
			wc({
				type: "status",
				status: "running"
			});
			const t = new Wr();
			vc("runner", "system", "Virtual addresses: alpha=10.88.0.2 beta=10.88.0.3 gamma=10.88.0.4\n"), wc({
				type: "done",
				ok: [
					await Ec(t, e),
					await Mc(t, e),
					await Ac(t, e)
				].every(Boolean)
			});
		} catch (e) {
			wc({
				type: "error",
				message: e instanceof Error ? e.message : String(e)
			});
		} finally {
			yc = !1;
		}
	}
}
self.onmessage = (e) => {
	"run" === e.data.type && Cc();
}, wc({ type: "ready" });
