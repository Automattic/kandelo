var e = Object.create, t = Object.defineProperty, n = Object.getOwnPropertyDescriptor, r = Object.getOwnPropertyNames, i = Object.getPrototypeOf, s = Object.prototype.hasOwnProperty, o = (o, a, c) => (c = null != o ? e(i(o)) : {}, ((e, i, o, a) => {
	if (i && "object" == typeof i || "function" == typeof i) for (var c, l = r(i), h = 0, d = l.length; h < d; h++) c = l[h], s.call(e, c) || c === o || t(e, c, {
		get: ((e) => i[e]).bind(null, c),
		enumerable: !(a = n(i, c)) || a.enumerable
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
		for (const n of this.listeners) n(e.pid, "bind");
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
		for (const n of this.listeners) n(e.pid, e.bo_id, "create");
	}
	destroy(e, t) {
		if (this.bos.delete(t)) for (const n of this.listeners) n(e, t, "destroy");
	}
	bind(e, t, n, r) {
		const i = this.bos.get(t);
		if (!i) return -1;
		i.pids.add(e), i.bindingsByPid.set(e, {
			addr: n,
			len: r
		});
		for (const s of this.listeners) s(e, t, "bind");
		return 0;
	}
	unbind(e, t) {
		const n = this.bos.get(t);
		if (!n) return;
		const r = n.bindingsByPid.get(e);
		r && this.flushMemoryToSab(n, e, r), n.bindingsByPid.delete(e);
		for (const i of this.listeners) i(e, t, "unbind");
	}
	findBindingByAddr(e, t) {
		for (const n of this.bos.values()) {
			const r = n.bindingsByPid.get(e);
			if (r && r.addr === t) return n.bo_id;
		}
	}
	primeBindFromSab(e, t, n) {
		const r = this.bos.get(t);
		if (!r) return;
		const i = r.bindingsByPid.get(e);
		if (!i) return;
		for (const [c, l] of r.bindingsByPid) c !== e && this.flushMemoryToSab(r, c, l);
		const s = Math.min(i.len, r.size);
		if (i.addr + s > n.buffer.byteLength) return;
		const o = new Uint8Array(n.buffer, i.addr, s), a = new Uint8Array(r.sab, 0, s);
		o.set(a);
	}
	flushMemoryToSab(e, t, n) {
		const r = this.getProcessMemory;
		if (!r) return;
		const i = r(t);
		if (!i) return;
		const s = Math.min(n.len, e.size);
		if (n.addr + s > i.buffer.byteLength) return;
		const o = new Uint8Array(e.sab, 0, s), a = new Uint8Array(i.buffer, n.addr, s);
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
		if (t) for (const [n, r] of t.bindingsByPid) this.flushMemoryToSab(t, n, r);
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
const d = 2929, f = 2960, u = 3042, p = 2884, g = 3089, m = 32823, y = 33984;
function w(e, t, n) {
	switch (t) {
		case d:
			e.depthTestEnabled = n;
			return;
		case f:
			e.stencilTestEnabled = n;
			return;
		case u:
			e.blendEnabled = n;
			return;
		case p:
			e.cullFaceEnabled = n;
			return;
		case m:
			e.polygonOffsetFillEnabled = n;
			return;
		case g:
			e.scissor.enabled = n;
			return;
	}
}
var _ = class {
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
		for (const r of this.listeners) r(e.pid, "bind");
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
const S = 1024, b = 1025, k = 1026, v = 1027, A = 1028, I = 1029, C = 1030, P = 1280, E = 1281, x = 1282, M = 1283, z = 1284, T = 1536, L = 1537, B = 1538, U = 1792, R = 1793, H = 1794, F = 1795, W = 1796, D = 1797, $ = 1798;
function O(e, t, n) {
	return e.cmdbufView && e.gl ? N(e.cmdbufView, t, n, (t, n) => {
		try {
			return function(e, t, n, r, i) {
				switch (i) {
					case 1:
						e.clear(n.getUint32(r, !0));
						return;
					case 2:
						t.shadow.clearColor = [
							n.getFloat32(r, !0),
							n.getFloat32(r + 4, !0),
							n.getFloat32(r + 8, !0),
							n.getFloat32(r + 12, !0)
						], e.clearColor(...t.shadow.clearColor);
						return;
					case 3:
						t.shadow.viewport = [
							n.getInt32(r, !0),
							n.getInt32(r + 4, !0),
							n.getInt32(r + 8, !0),
							n.getInt32(r + 12, !0)
						], e.viewport(...t.shadow.viewport);
						return;
					case 4: {
						const i = n.getInt32(r, !0), s = n.getInt32(r + 4, !0), o = n.getInt32(r + 8, !0), a = n.getInt32(r + 12, !0);
						e.scissor(i, s, o, a), t.shadow.scissor.rect = [
							i,
							s,
							o,
							a
						];
						return;
					}
					case 5: {
						const i = n.getUint32(r, !0);
						e.enable(i), w(t.shadow, i, !0);
						return;
					}
					case 6: {
						const i = n.getUint32(r, !0);
						e.disable(i), w(t.shadow, i, !1);
						return;
					}
					case 7: {
						const i = n.getUint32(r, !0), s = n.getUint32(r + 4, !0);
						e.blendFunc(i, s), t.shadow.blendFunc = {
							srcRGB: i,
							dstRGB: s,
							srcA: i,
							dstA: s
						};
						return;
					}
					case 8:
						t.shadow.depthFunc = n.getUint32(r, !0), e.depthFunc(t.shadow.depthFunc);
						return;
					case 9:
						t.shadow.cullFace = n.getUint32(r, !0), e.cullFace(t.shadow.cullFace);
						return;
					case 10:
						t.shadow.frontFace = n.getUint32(r, !0), e.frontFace(t.shadow.frontFace);
						return;
					case 11:
						e.lineWidth(n.getFloat32(r, !0));
						return;
					case 12: {
						const i = n.getUint32(r, !0), s = n.getInt32(r + 4, !0);
						e.pixelStorei(i, s), 3317 === i ? t.shadow.unpackAlignment = s : 3333 === i && (t.shadow.packAlignment = s);
						return;
					}
					case 256: {
						const i = n.getUint32(r, !0);
						for (let s = 0; s < i; s++) {
							const i = n.getUint32(r + 4 + 4 * s, !0), o = e.createBuffer();
							o && t.buffers.set(i, o);
						}
						return;
					}
					case 257: {
						const i = n.getUint32(r, !0);
						for (let s = 0; s < i; s++) {
							const i = n.getUint32(r + 4 + 4 * s, !0), o = t.buffers.get(i);
							o && e.deleteBuffer(o), t.buffers.delete(i);
						}
						return;
					}
					case 258:
						e.bindBuffer(n.getUint32(r, !0), t.buffers.get(n.getUint32(r + 4, !0)) ?? null);
						return;
					case 259: {
						const t = n.getUint32(r, !0), i = n.getUint32(r + 4, !0), s = n.getUint32(r + 8 + i, !0);
						if (0 === i) e.bufferData(t, 0, s);
						else {
							const o = new Uint8Array(n.buffer, n.byteOffset + r + 8, i);
							e.bufferData(t, o, s);
						}
						return;
					}
					case 260: {
						const t = n.getUint32(r, !0), i = n.getInt32(r + 4, !0), s = n.getUint32(r + 8, !0), o = new Uint8Array(n.buffer, n.byteOffset + r + 12, s);
						e.bufferSubData(t, i, o);
						return;
					}
					case 512: {
						const i = n.getUint32(r, !0);
						for (let s = 0; s < i; s++) {
							const i = n.getUint32(r + 4 + 4 * s, !0), o = e.createTexture();
							o && t.textures.set(i, o);
						}
						return;
					}
					case 513: {
						const i = n.getUint32(r, !0);
						for (let s = 0; s < i; s++) {
							const i = n.getUint32(r + 4 + 4 * s, !0), o = t.textures.get(i);
							o && e.deleteTexture(o), t.textures.delete(i);
						}
						return;
					}
					case 514: {
						const i = t.textures.get(n.getUint32(r + 4, !0)) ?? null;
						e.bindTexture(n.getUint32(r, !0), i);
						const s = t.shadow.activeTexture;
						s >= 0 && s < t.shadow.textureUnits.length && (t.shadow.textureUnits[s] = i);
						return;
					}
					case 515: {
						const t = n.getUint32(r, !0), i = n.getInt32(r + 4, !0), s = n.getInt32(r + 8, !0), o = n.getInt32(r + 12, !0), a = n.getInt32(r + 16, !0), c = n.getInt32(r + 20, !0), l = n.getUint32(r + 24, !0), h = n.getUint32(r + 28, !0), d = n.getUint32(r + 32, !0), f = 0 === d ? null : new Uint8Array(n.buffer, n.byteOffset + r + 36, d);
						e.texImage2D(t, i, s, o, a, c, l, h, f);
						return;
					}
					case 516: {
						const t = n.getUint32(r, !0), i = n.getInt32(r + 4, !0), s = n.getInt32(r + 8, !0), o = n.getInt32(r + 12, !0), a = n.getInt32(r + 16, !0), c = n.getInt32(r + 20, !0), l = n.getUint32(r + 24, !0), h = n.getUint32(r + 28, !0), d = n.getUint32(r + 32, !0), f = new Uint8Array(n.buffer, n.byteOffset + r + 36, d);
						e.texSubImage2D(t, i, s, o, a, c, l, h, f);
						return;
					}
					case 517:
						e.texParameteri(n.getUint32(r, !0), n.getUint32(r + 4, !0), n.getInt32(r + 8, !0));
						return;
					case 518: {
						const i = n.getUint32(r, !0);
						e.activeTexture(i), t.shadow.activeTexture = i - y;
						return;
					}
					case 519:
						e.generateMipmap(n.getUint32(r, !0));
						return;
					case 768: {
						const i = n.getUint32(r, !0), s = n.getUint32(r + 4, !0), o = e.createShader(i);
						o && t.shaders.set(s, o);
						return;
					}
					case 769: {
						const i = n.getUint32(r, !0), s = n.getUint32(r + 4, !0), o = new Uint8Array(s);
						o.set(new Uint8Array(n.buffer, n.byteOffset + r + 8, s));
						const a = new TextDecoder().decode(o), c = t.shaders.get(i);
						c && e.shaderSource(c, a);
						return;
					}
					case 770: {
						const i = t.shaders.get(n.getUint32(r, !0));
						i && e.compileShader(i);
						return;
					}
					case 771: {
						const i = n.getUint32(r, !0), s = t.shaders.get(i);
						s && e.deleteShader(s), t.shaders.delete(i);
						return;
					}
					case 772: {
						const i = n.getUint32(r, !0), s = e.createProgram();
						s && t.programs.set(i, s);
						return;
					}
					case 773: {
						const i = t.programs.get(n.getUint32(r, !0)), s = t.shaders.get(n.getUint32(r + 4, !0));
						i && s && e.attachShader(i, s);
						return;
					}
					case 774: {
						const i = t.programs.get(n.getUint32(r, !0));
						i && e.linkProgram(i);
						return;
					}
					case 775: {
						const i = t.programs.get(n.getUint32(r, !0)) ?? null;
						e.useProgram(i), t.currentProgram = i, t.shadow.currentProgram = i;
						return;
					}
					case 776: {
						const i = t.programs.get(n.getUint32(r, !0)), s = n.getUint32(r + 4, !0), o = n.getUint32(r + 8, !0), a = new Uint8Array(o);
						a.set(new Uint8Array(n.buffer, n.byteOffset + r + 12, o));
						const c = new TextDecoder().decode(a);
						i && e.bindAttribLocation(i, s, c);
						return;
					}
					case 777: {
						const i = n.getUint32(r, !0), s = t.programs.get(i);
						s && e.deleteProgram(s), t.programs.delete(i);
						return;
					}
					case S: {
						const i = t.uniformLocations.get(n.getInt32(r, !0)) ?? null;
						e.uniform1i(i, n.getInt32(r + 4, !0));
						return;
					}
					case b: {
						const i = t.uniformLocations.get(n.getInt32(r, !0)) ?? null;
						e.uniform1f(i, n.getFloat32(r + 4, !0));
						return;
					}
					case k: {
						const i = t.uniformLocations.get(n.getInt32(r, !0)) ?? null;
						e.uniform2f(i, n.getFloat32(r + 4, !0), n.getFloat32(r + 8, !0));
						return;
					}
					case v: {
						const i = t.uniformLocations.get(n.getInt32(r, !0)) ?? null;
						e.uniform3f(i, n.getFloat32(r + 4, !0), n.getFloat32(r + 8, !0), n.getFloat32(r + 12, !0));
						return;
					}
					case A: {
						const i = t.uniformLocations.get(n.getInt32(r, !0)) ?? null;
						e.uniform4f(i, n.getFloat32(r + 4, !0), n.getFloat32(r + 8, !0), n.getFloat32(r + 12, !0), n.getFloat32(r + 16, !0));
						return;
					}
					case I: {
						const i = t.uniformLocations.get(n.getInt32(r, !0)) ?? null, s = n.getUint32(r + 4, !0), o = 0 !== n.getUint32(r + 8, !0), a = new Float32Array(n.buffer, n.byteOffset + r + 12, 16 * s);
						e.uniformMatrix4fv(i, o, a);
						return;
					}
					case C: {
						const i = t.uniformLocations.get(n.getInt32(r, !0)) ?? null, s = n.getUint32(r + 4, !0), o = new Float32Array(n.buffer, n.byteOffset + r + 8, 4 * s);
						e.uniform4fv(i, o);
						return;
					}
					case P:
						e.enableVertexAttribArray(n.getUint32(r, !0));
						return;
					case E:
						e.disableVertexAttribArray(n.getUint32(r, !0));
						return;
					case x: {
						const t = n.getUint32(r, !0), i = n.getInt32(r + 4, !0), s = n.getUint32(r + 8, !0), o = 0 !== n.getUint32(r + 12, !0), a = n.getInt32(r + 16, !0), c = n.getInt32(r + 20, !0);
						e.vertexAttribPointer(t, i, s, o, a, c);
						return;
					}
					case M:
						e.drawArrays(n.getUint32(r, !0), n.getInt32(r + 4, !0), n.getInt32(r + 8, !0));
						return;
					case z:
						e.drawElements(n.getUint32(r, !0), n.getInt32(r + 4, !0), n.getUint32(r + 8, !0), n.getUint32(r + 12, !0));
						return;
					case T: {
						const i = n.getUint32(r, !0);
						for (let s = 0; s < i; s++) {
							const i = n.getUint32(r + 4 + 4 * s, !0), o = e.createVertexArray();
							o && t.vaos.set(i, o);
						}
						return;
					}
					case L: {
						const i = n.getUint32(r, !0);
						for (let s = 0; s < i; s++) {
							const i = n.getUint32(r + 4 + 4 * s, !0), o = t.vaos.get(i);
							o && e.deleteVertexArray(o), t.vaos.delete(i);
						}
						return;
					}
					case B: {
						const i = t.vaos.get(n.getUint32(r, !0)) ?? null;
						e.bindVertexArray(i), t.shadow.vao = i;
						return;
					}
					case U: {
						const i = n.getUint32(r, !0);
						for (let s = 0; s < i; s++) {
							const i = n.getUint32(r + 4 + 4 * s, !0), o = e.createFramebuffer();
							o && t.fbos.set(i, o);
						}
						return;
					}
					case R: {
						const i = n.getUint32(r, !0), s = t.fbos.get(n.getUint32(r + 4, !0)) ?? null;
						e.bindFramebuffer(i, s), 36008 !== i && (t.shadow.fbo = s);
						return;
					}
					case H: {
						const i = n.getUint32(r, !0), s = n.getUint32(r + 4, !0), o = n.getUint32(r + 8, !0), a = t.textures.get(n.getUint32(r + 12, !0)) ?? null, c = n.getInt32(r + 16, !0);
						e.framebufferTexture2D(i, s, o, a, c);
						return;
					}
					case F: {
						const i = n.getUint32(r, !0);
						for (let s = 0; s < i; s++) {
							const i = n.getUint32(r + 4 + 4 * s, !0), o = e.createRenderbuffer();
							o && t.rbos.set(i, o);
						}
						return;
					}
					case W:
						e.bindRenderbuffer(n.getUint32(r, !0), t.rbos.get(n.getUint32(r + 4, !0)) ?? null);
						return;
					case D:
						e.renderbufferStorage(n.getUint32(r, !0), n.getUint32(r + 4, !0), n.getInt32(r + 8, !0), n.getInt32(r + 12, !0));
						return;
					case $: {
						const i = n.getUint32(r, !0), s = n.getUint32(r + 4, !0), o = n.getUint32(r + 8, !0), a = t.rbos.get(n.getUint32(r + 12, !0)) ?? null;
						e.framebufferRenderbuffer(i, s, o, a);
						return;
					}
					default: throw new Error(`gl bridge: unknown op 0x${i.toString(16).padStart(4, "0")} at offset ${r - 4}`);
				}
			}(e.gl, e, t, 0, n), 0;
		} catch {
			return -5;
		}
	}) : 0;
}
function N(e, t, n, r) {
	if (!function(e, t, n) {
		return Number.isSafeInteger(e) && Number.isSafeInteger(t) && e >= 0 && t >= 0 && e <= n && t <= n - e;
	}(t, n, e.byteLength)) return -22;
	const i = new DataView(e.buffer, e.byteOffset + t, n);
	let s = 0;
	for (; s < n;) {
		if (n - s < 4) return -22;
		const e = i.getUint16(s, !0), t = i.getUint16(s + 2, !0), o = s + 4, a = o + t;
		if (a > n) return -22;
		const c = new DataView(i.buffer, i.byteOffset + o, t);
		if (!G(e, c)) return -22;
		const l = r(c, e);
		if (0 !== l) return l;
		s = a;
	}
	return 0;
}
function K(e, t) {
	return e.byteLength === t;
}
function V(e, t, n) {
	if (e.byteLength < n + 4) return !1;
	const r = e.getUint32(n, !0);
	return e.byteLength === t + r;
}
function q(e, t, n, r) {
	if (e.byteLength < n + 4 || e.byteOffset % 4 != 0) return !1;
	const i = e.getUint32(n, !0);
	return e.byteLength === t + i * r * 4;
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
		case P:
		case E:
		case B: return K(t, 4);
		case 7:
		case 12:
		case 258:
		case 514:
		case 768:
		case 773:
		case S:
		case b:
		case R:
		case W: return K(t, 8);
		case 517:
		case k:
		case M: return K(t, 12);
		case 2:
		case 3:
		case 4:
		case v:
		case z:
		case D:
		case $: return K(t, 16);
		case A:
		case H: return K(t, 20);
		case x: return K(t, 24);
		case 256:
		case 257:
		case 512:
		case 513:
		case T:
		case L:
		case U:
		case F: return function(e) {
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
		case C: return q(t, 8, 4, 4);
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
		const n = `${e.pid}:${e.contextId ?? "_"}`;
		let r = this.byKey.get(n);
		r || (r = {
			key: n,
			binding: e,
			frames: []
		}, this.byKey.set(n, r), (this.isCompositor(e.pid) ? this.compositor : this.clients).push(r)), r.frames.push(t);
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
}, X = class {
	gl;
	current = null;
	constructor(e) {
		this.gl = e;
	}
	switchTo(e) {
		if (this.current === e) return;
		const t = e.shadow, n = this.gl;
		n.bindVertexArray(t.vao), n.bindFramebuffer(36160, t.fbo), n.viewport(...t.viewport), t.scissor.enabled ? n.enable(g) : n.disable(g), n.scissor(...t.scissor.rect), n.clearColor(...t.clearColor), t.depthTestEnabled ? n.enable(d) : n.disable(d), n.depthFunc(t.depthFunc), t.stencilTestEnabled ? n.enable(f) : n.disable(f), t.blendEnabled ? n.enable(u) : n.disable(u), n.blendFuncSeparate(t.blendFunc.srcRGB, t.blendFunc.dstRGB, t.blendFunc.srcA, t.blendFunc.dstA), t.cullFaceEnabled ? n.enable(p) : n.disable(p), n.cullFace(t.cullFace), n.frontFace(t.frontFace), t.polygonOffsetFillEnabled ? n.enable(m) : n.disable(m), n.useProgram(t.currentProgram);
		for (let r = 0; r < t.textureUnits.length; r++) {
			const e = t.textureUnits[r];
			e && (n.activeTexture(y + r), n.bindTexture(3553, e));
		}
		n.activeTexture(y + t.activeTexture), n.pixelStorei(3317, t.unpackAlignment), n.pixelStorei(3333, t.packAlignment), this.current = e;
	}
	invalidateCurrent() {
		this.current = null;
	}
};
const Y = "__abi_version", Z = {
	atomics_wait: 2,
	atomics_wait_async: 4,
	shared_array_buffer: 1
}, J = [
	"__abi_version",
	"kernel_alloc_scratch",
	"kernel_create_process",
	"kernel_create_process_with_stdio",
	"kernel_get_parent_pid",
	"kernel_get_process_exit_signal",
	"kernel_get_process_state",
	"kernel_handle_channel",
	"kernel_has_sa_nocldstop",
	"kernel_host_adapter_manifest_len",
	"kernel_host_adapter_manifest_ptr",
	"kernel_mark_process_signaled",
	"kernel_pipe_has_readers",
	"kernel_posix_timer_fire",
	"kernel_prepare_write_operation",
	"kernel_reap_exited_child",
	"kernel_remove_process",
	"kernel_wait_child_poll"
], Q = {
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
}, ee = 65536, te = 65608, ne = 65560, re = 65560, ie = 16777216, se = 211, oe = 212, ae = 213, ce = 500, le = 386, he = 1, de = 2, fe = 3, ue = 4, pe = 6, ge = 7, me = 8, ye = 10, we = 11, _e = 12, Se = 19, be = 22, ke = 24, ve = 25, Ae = 34, Ie = 35, Ce = 41, Pe = 46, Ee = 47, xe = 48, Me = 49, ze = 53, Te = 54, Le = 55, Be = 56, Ue = 60, Re = 62, He = 63, Fe = 64, We = 65, De = 68, $e = 69, Oe = 72, Ne = 77, Ke = 79, Ve = 80, qe = 81, Ge = 82, je = 85, Xe = 86, Ye = 90, Ze = 92, Je = 93, Qe = 97, et = 102, tt = 103, nt = 109, rt = 121, it = 124, st = 126, ot = 137, at = 138, ct = 139, lt = 200, ht = 201, dt = 205, ft = 207, ut = 238, pt = 239, gt = 240, mt = 241, yt = 251, wt = 252, _t = 278, St = 288, bt = 294, kt = 295, vt = 296, At = 308, It = 333, Ct = 334, Pt = 343, Et = 345, xt = 346, Mt = 378, zt = 379, Tt = 384, Lt = 387, Bt = 415, Ut = 0, Rt = 1, Ht = 2, Ft = 3, Wt = 4, Dt = 5, $t = 6, Ot = 7, Nt = 8, Kt = 9, Vt = 10, qt = 11, Gt = 12, jt = 13, Xt = 14, Yt = 15, Zt = 16, Jt = 17, Qt = 18, en = 19, tn = 20, nn = 21, rn = 22, sn = 23, on = {
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
}, an = 65536;
function cn(e) {
	const t = new Uint8Array(e);
	return t.length >= 8 && 0 === t[0] && 97 === t[1] && 115 === t[2] && 109 === t[3] && 1 === t[4] && 0 === t[5] && 0 === t[6] && 0 === t[7];
}
function ln(e, t) {
	let n = 0, r = 0, i = t;
	for (;;) {
		const t = e[i++];
		if (n |= (127 & t) << r, !(128 & t)) break;
		r += 7;
	}
	return [n, i - t];
}
function hn(e, t) {
	let n = 0, r = 0, i = t, s = 0;
	for (; s = e[i++], n |= (127 & s) << r, r += 7, 128 & s;);
	return r < 32 && 64 & s && (n |= -1 << r), [n, i - t];
}
function dn(e, t) {
	let n = 0n, r = 0n, i = t, s = 0;
	for (; s = e[i++], n |= BigInt(127 & s) << r, r += 7n, 128 & s;);
	return r < 64n && 64 & s && (n |= -1n << r), [n, i - t];
}
function fn(e, t) {
	const n = e[t];
	if (64 === n || 127 === n || 126 === n || 125 === n || 124 === n || 123 === n || 112 === n || 111 === n) return t + 1;
	const [, r] = hn(e, t);
	return t + r;
}
function un(e, t) {
	const [, n] = ln(e, t);
	t += n;
	const [, r] = ln(e, t);
	return t + r;
}
function pn(e, t, n) {
	const [r, i] = ln(t, n);
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
			const [, e] = ln(t, n);
			n += e;
			const [, r] = ln(t, n);
			return n + r;
		}
		case 9: {
			const [, e] = ln(t, n);
			return n + e;
		}
		case 10: {
			const [, e] = ln(t, n);
			n += e;
			const [, r] = ln(t, n);
			return n + r;
		}
		case 11: {
			const [, e] = ln(t, n);
			return n + e;
		}
		case 12: {
			const [, e] = ln(t, n);
			n += e;
			const [, r] = ln(t, n);
			return n + r;
		}
		case 13: {
			const [, e] = ln(t, n);
			return n + e;
		}
		case 14: {
			const [, e] = ln(t, n);
			n += e;
			const [, r] = ln(t, n);
			return n + r;
		}
		case 15:
		case 16:
		case 17: {
			const [, e] = ln(t, n);
			return n + e;
		}
		default: return null;
	}
	return 253 === e ? 12 === r || 13 === r ? n + 16 : r >= 21 && r <= 34 ? un(t, n) : 84 === r || r >= 92 && r <= 99 || r >= 112 && r <= 123 || r >= 124 && r <= 131 || r >= 156 && r <= 159 ? n + 1 : n : 254 === e ? 0 === r || 1 === r || 2 === r ? un(t, n) : 3 === r ? n : r >= 16 && r <= 79 ? un(t, n) : null : null;
}
function gn(e, t, n) {
	const [r, i] = ln(e, t);
	t += i + r;
	const [s, o] = ln(e, t);
	t += o + s;
	const a = e[t++];
	if (0 === a) {
		n.funcImports++;
		const [, r] = ln(e, t);
		t += r;
	} else if (1 === a) {
		t++;
		const n = e[t++], [, r] = ln(e, t);
		if (t += r, 1 & n) {
			const [, n] = ln(e, t);
			t += n;
		}
	} else if (2 === a) {
		const n = e[t++], [, r] = ln(e, t);
		if (t += r, 1 & n) {
			const [, n] = ln(e, t);
			t += n;
		}
	} else 3 === a && (n.globalImports++, t += 2);
	return t;
}
function mn(e, t) {
	for (t += 2; 11 !== e[t];) t++;
	return t + 1;
}
function yn(e) {
	const t = new Uint8Array(e);
	if (t.length < 8) return null;
	let n = 0, r = 0, i = null, s = null, o = 8;
	for (; o < t.length;) {
		const e = t[o], [a, c] = ln(t, o + 1), l = o + 1 + c;
		if (2 === e) {
			const e = {
				funcImports: r,
				globalImports: n
			};
			let i = l;
			const [s, o] = ln(t, i);
			i += o;
			for (let n = 0; n < s; n++) i = gn(t, i, e);
			r = e.funcImports, n = e.globalImports;
		} else if (6 === e) s = {
			offset: l,
			size: a
		};
		else if (7 === e) {
			let e = l;
			const [n, r] = ln(t, e);
			e += r;
			for (let s = 0; s < n; s++) {
				const [n, r] = ln(t, e);
				e += r;
				const s = new TextDecoder().decode(t.subarray(e, e + n));
				e += n;
				const o = t[e++], [a, c] = ln(t, e);
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
	const [l, h] = ln(t, c);
	if (c += h, a >= l) return null;
	for (let d = 0; d < a; d++) c = mn(t, c);
	return function(e, t) {
		t++, t++;
		const n = e[t++];
		if (65 === n) {
			const [n] = hn(e, t);
			return BigInt.asUintN(32, BigInt(n));
		}
		if (66 === n) {
			const [n] = dn(e, t);
			return BigInt.asUintN(64, n);
		}
		return null;
	}(t, c);
}
function wn(e, t) {
	const n = new Uint8Array(e);
	if (n.length < 8) return null;
	let r = 0, i = null, s = null, o = 8;
	for (; o < n.length;) {
		const e = n[o], [a, c] = ln(n, o + 1), l = o + 1 + c;
		if (2 === e) {
			const e = {
				funcImports: r,
				globalImports: 0
			};
			let t = l;
			const [i, s] = ln(n, t);
			t += s;
			for (let r = 0; r < i; r++) t = gn(n, t, e);
			r = e.funcImports;
		} else if (7 === e) {
			let e = l;
			const [r, s] = ln(n, e);
			e += s;
			for (let o = 0; o < r; o++) {
				const [r, s] = ln(n, e);
				e += s;
				const o = new TextDecoder().decode(n.subarray(e, e + r));
				e += r;
				const a = n[e++], [c, l] = ln(n, e);
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
	const [c, l] = ln(n, a);
	return a += l, function e(t, i = 0) {
		if (i > 4) return null;
		const s = function(e) {
			const t = e - r;
			if (t < 0 || t >= c) return null;
			let i = a;
			for (let r = 0; r < t; r++) {
				const [e, t] = ln(n, i);
				i += t + e;
			}
			const [s, o] = ln(n, i);
			return i += o, {
				start: i,
				end: i + s
			};
		}(t);
		if (!s) return null;
		const o = function(e, t) {
			if (e >= t) return null;
			const [r, i] = ln(n, e);
			e += i;
			for (let s = 0; s < r; s++) {
				const [, r] = ln(n, e);
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
					const [e] = hn(n, l), [, t] = hn(n, l), r = l + t;
					if (15 === n[r] || 11 === n[r] && r + 1 === h) return e;
					l = r;
				} else if (16 === t) {
					const [t, r] = ln(n, l), s = l + r;
					if (15 === n[s] || 11 === n[s] && s + 1 === h) {
						const n = e(t, i + 1);
						if (null !== n) return n;
					}
					l = s;
				} else if (12 === t || 13 === t || 18 === t || 210 === t) {
					const [, e] = ln(n, l);
					l += e;
				} else if (2 === t || 3 === t || 4 === t) l = fn(n, l);
				else if (14 === t) {
					const [e, t] = ln(n, l);
					l += t;
					for (let r = 0; r <= e; r++) {
						const [, e] = ln(n, l);
						l += e;
					}
				} else if (17 === t) {
					const [, e] = ln(n, l);
					l += e;
					const [, t] = ln(n, l);
					l += t;
				} else if (28 === t) {
					const [e, t] = ln(n, l);
					l += t;
					for (let r = 0; r < e; r++) {
						const [, e] = ln(n, l);
						l += e;
					}
				} else if (t >= 32 && t <= 38 || 208 === t) {
					const [, e] = ln(n, l);
					l += e;
				} else if (t >= 40 && t <= 62) l = un(n, l);
				else if (63 === t || 64 === t) l++;
				else if (66 === t) {
					const [, e] = dn(n, l);
					l += e;
				} else if (67 === t) l += 4;
				else if (68 === t) l += 8;
				else if (252 === t || 253 === t || 254 === t) {
					const e = pn(t, n, l);
					if (null === e) return null;
					l = e;
				}
			} else if (l === h) return null;
		}
		return null;
	}(i);
}
function _n(e) {
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
const Sn = (1n << 64n) - 1n;
function bn(e, t) {
	if ("bigint" == typeof e) {
		if (e >= 0n && e <= Sn) return e;
	} else if (Number.isSafeInteger(e) && e >= 0) return BigInt(e);
	const n = /* @__PURE__ */ new Error(`EOVERFLOW: ${t} is not exactly representable as an unsigned 64-bit value`);
	throw n.code = "EOVERFLOW", n;
}
function kn(e) {
	const t = e instanceof ArrayBuffer ? new Uint8Array(e) : new Uint8Array(e.buffer, e.byteOffset, e.byteLength), n = new Uint8Array(t.byteLength);
	return n.set(t), n.buffer;
}
function vn(e, t) {
	return void 0 === e || !Number.isFinite(e) || e < 1 ? t : An(Math.trunc(e));
}
function An(e) {
	return Math.max(1, Math.min(65535, Math.trunc(e)));
}
const In = {
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
function Cn(e) {
	if (e && "object" == typeof e && "code" in e) {
		const t = e.code;
		if ("number" == typeof t && 0 !== t) return t < 0 ? t : -t;
		if ("string" == typeof t) {
			const e = In[t];
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
			const e = In[t];
			if (void 0 !== e) return e;
		}
	}
	return -5;
}
var Pn = class e {
	config;
	io;
	callbacks;
	instance = null;
	memory = null;
	kernelPtrWidth = 4;
	sharedPipes = /* @__PURE__ */ new Map();
	signalWakeSab = null;
	programFuncTable = null;
	forkSab = null;
	waitpidSab = null;
	pendingDirectoryEntries = /* @__PURE__ */ new Map();
	retainedHostFileHandles = /* @__PURE__ */ new Map();
	fstatHandleCapture = null;
	isThreadWorker = !1;
	pid = 0;
	framebuffers = new c();
	bos = new l();
	kms = new h(this.bos);
	gl = new _();
	gl_submit_queue = new j((e) => this.kms.isMasterPid(e));
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
		} catch (n) {
			return Cn(n);
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
			pipe: a.fromSharedBuffer(t),
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
	registerForkSab(e) {
		this.forkSab = e;
	}
	registerWaitpidSab(e) {
		this.waitpidSab = e;
	}
	async init(e) {
		this.kernelPtrWidth = _n(kn(e));
		const t = this.createKernelMemory();
		this.memory = t;
		const n = this.buildImportObject(t), r = await WebAssembly.compile(e);
		this.instance = await WebAssembly.instantiate(r, n);
	}
	async initWithMemory(e, t) {
		this.kernelPtrWidth = _n(kn(e)), this.memory = t;
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
			host_pathconf: (e, t, n, r) => this.hostPathconf(Number(e), t, n, Number(r)),
			host_fpathconf: (e, t, n) => this.hostFpathconf(e, t, Number(n)),
			host_mkdir: (e, t, n) => this.hostMkdir(Number(e), t, n),
			host_rmdir: (e, t) => this.hostRmdir(Number(e), t),
			host_unlink: (e, t) => this.hostUnlink(Number(e), t),
			host_rename: (e, t, n, r) => this.hostRename(Number(e), t, Number(n), r),
			host_link: (e, t, n, r) => this.hostLink(Number(e), t, Number(n), r),
			host_symlink: (e, t, n, r) => this.hostSymlink(Number(e), t, Number(n), r),
			host_readlink: (e, t, n, r) => this.hostReadlink(Number(e), t, Number(n), r),
			host_chmod: (e, t, n) => this.hostChmod(Number(e), t, n),
			host_chown: (e, t, n, r) => this.hostChown(Number(e), t, n, r),
			host_lchown: (e, t, n, r) => this.hostLchown(Number(e), t, n, r),
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
			},
			host_gbm_bo_create: (e, t, n, r, i, s) => (this.bos.create({
				pid: e,
				bo_id: t,
				size: Number(n),
				w: r,
				h: i,
				stride: s
			}), 0),
			host_gbm_bo_destroy: (e, t) => {
				this.bos.destroy(e, t);
			},
			host_gbm_bo_bind: (e, t, n, r) => this.bos.bind(e, t, Number(n), Number(r)),
			host_gbm_bo_unbind: (e, t, n, r) => {
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
			host_gl_create_context: (e, t, n, r) => {
				const i = this.gl.get(e);
				if (!i) return;
				if (i.contextId = t, i.forward) return void i.forward.onCreateContext();
				if (!i.canvas) {
					const t = this.kms.masterCrtcForPid(e);
					if (null != t) {
						const n = this.callbacks.getKmsCanvas?.(t);
						if (n) {
							const r = this.kms.currentFb(t);
							!r || n.width === r.width && n.height === r.height || (n.width = r.width, n.height = r.height), this.gl.attachCanvas(e, n), i.canvas = n, this.callbacks.markKmsCanvasGlOwned?.(t);
						}
					}
					if (!i.canvas) return;
				}
				const s = i.canvas.getContext("webgl2", {
					antialias: !1,
					premultipliedAlpha: !1,
					preserveDrawingBuffer: !0
				});
				s && (s.getExtension("EXT_color_buffer_float"), s.getExtension("OES_texture_float_linear"), s.getExtension("EXT_float_blend")), i.gl = s;
			},
			host_gl_destroy_context: (e, t) => {
				const n = this.gl.get(e);
				n && (n.gl = null, n.contextId = null, n.currentProgram = null, n.forward && n.forward.onDestroyContext());
			},
			host_gl_create_surface: (e, t, n, r) => {
				const i = this.gl.get(e);
				i && (i.surfaceId = t);
			},
			host_gl_destroy_surface: (e, t) => {
				const n = this.gl.get(e);
				n && (n.surfaceId = null);
			},
			host_gl_make_current: (e, t, n) => {},
			host_gl_submit: (e, t, n) => {
				const r = this.gl.get(e);
				if (!r) return -5;
				if (!r.forward && !r.gl) return 0;
				if (!r.cmdbufView) {
					const t = this.callbacks.getProcessMemory?.(e);
					if (!t) return -5;
					try {
						r.cmdbufView = new Uint8Array(t.buffer, r.cmdbufAddr, r.cmdbufLen);
					} catch {
						return -5;
					}
				}
				if (r.forward) {
					const e = Number(t), i = Number(n), s = function(e, t, n) {
						return N(e, t, n, () => 0);
					}(r.cmdbufView, e, i);
					return s < 0 ? s : (r.forward.onSubmit(r.cmdbufView.slice(e, e + i)), 0);
				}
				return this.gl_submit_queue.enqueue(r, {
					memorySab: r.cmdbufView.buffer,
					off: Number(t),
					len: Number(n)
				}), function(e, t, n) {
					for (;;) {
						const r = e.pickNext();
						if (!r) return 0;
						const i = r.frames.shift(), s = t(r.binding);
						s && s.switchTo(r.binding);
						const o = n(r.binding, i.off, i.len);
						if (e.releaseIfEmpty(r), "number" == typeof o && o < 0) return o;
					}
				}(this.gl_submit_queue, (e) => {
					if (!e.gl) return null;
					let t = this.gl_muxers.get(e.gl);
					return t || (t = new X(e.gl), this.gl_muxers.set(e.gl, t)), t;
				}, (e, t, n) => O(e, t, n));
			},
			host_gl_present: (e) => {},
			host_gl_query: (e, t, n, r, i, s) => {
				const o = this.gl.get(e);
				if (!o || !o.gl) return -1;
				const a = r > 0n ? this.readKernelBytes(Number(n), Number(r)) : new Uint8Array(0), c = new Uint8Array(Number(s)), l = function(e, t, n, r) {
					if (!e.gl) return -1;
					const i = e.gl, s = new DataView(n.buffer, n.byteOffset, n.byteLength), o = new DataView(r.buffer, r.byteOffset, r.byteLength);
					switch (t) {
						case 1: return r.byteLength < 4 ? -22 : (o.setUint32(0, i.getError(), !0), 4);
						case 2: {
							if (n.byteLength < 4) return -22;
							const e = s.getUint32(0, !0), t = i.getParameter(e) ?? "", a = new TextEncoder().encode(t), c = 4 + a.byteLength;
							return r.byteLength < c ? -22 : (o.setUint32(0, a.byteLength, !0), r.set(a, 4), c);
						}
						case 3: {
							if (n.byteLength < 4 || r.byteLength < 4) return -22;
							const e = s.getUint32(0, !0), t = i.getParameter(e);
							return o.setInt32(0, Number(t ?? 0), !0), 4;
						}
						case 4: {
							if (n.byteLength < 4 || r.byteLength < 4) return -22;
							const e = s.getUint32(0, !0), t = i.getParameter(e);
							return o.setFloat32(0, Number(t ?? 0), !0), 4;
						}
						case 5: {
							if (n.byteLength < 8 || r.byteLength < 4) return -22;
							const t = s.getUint32(0, !0), a = s.getUint32(4, !0);
							if (n.byteLength < 8 + a) return -22;
							const c = e.programs.get(t), l = new TextDecoder().decode(n.subarray(8, 8 + a)), h = c ? i.getUniformLocation(c, l) : null;
							if (h) {
								const t = ++e.nextUniformLoc;
								e.uniformLocations.set(t, h), o.setInt32(0, t, !0);
							} else o.setInt32(0, -1, !0);
							return 4;
						}
						case 6: {
							if (n.byteLength < 8 || r.byteLength < 4) return -22;
							const t = s.getUint32(0, !0), a = s.getUint32(4, !0);
							if (n.byteLength < 8 + a) return -22;
							const c = e.programs.get(t), l = new TextDecoder().decode(n.subarray(8, 8 + a)), h = c ? i.getAttribLocation(c, l) : -1;
							return o.setInt32(0, h, !0), 4;
						}
						case 7: {
							if (n.byteLength < 8 || r.byteLength < 4) return -22;
							const t = e.shaders.get(s.getUint32(0, !0));
							if (!t) return o.setInt32(0, 0, !0), 4;
							const a = i.getShaderParameter(t, s.getUint32(4, !0));
							return o.setInt32(0, "boolean" == typeof a ? a ? 1 : 0 : Number(a ?? 0), !0), 4;
						}
						case 8: {
							if (n.byteLength < 4) return -22;
							const t = e.shaders.get(s.getUint32(0, !0)), a = (t && i.getShaderInfoLog(t)) ?? "", c = new TextEncoder().encode(a), l = 4 + c.byteLength;
							return r.byteLength < l ? (o.setUint32(0, 0, !0), 4) : (o.setUint32(0, c.byteLength, !0), r.set(c, 4), l);
						}
						case 9: {
							if (n.byteLength < 8 || r.byteLength < 4) return -22;
							const t = e.programs.get(s.getUint32(0, !0));
							if (!t) return o.setInt32(0, 0, !0), 4;
							const a = i.getProgramParameter(t, s.getUint32(4, !0));
							return o.setInt32(0, "boolean" == typeof a ? a ? 1 : 0 : Number(a ?? 0), !0), 4;
						}
						case 10: {
							if (n.byteLength < 4) return -22;
							const t = e.programs.get(s.getUint32(0, !0)), a = (t && i.getProgramInfoLog(t)) ?? "", c = new TextEncoder().encode(a), l = 4 + c.byteLength;
							return r.byteLength < l ? (o.setUint32(0, 0, !0), 4) : (o.setUint32(0, c.byteLength, !0), r.set(c, 4), l);
						}
						case 11: {
							if (n.byteLength < 24) return -22;
							const e = s.getInt32(0, !0), t = s.getInt32(4, !0), o = s.getInt32(8, !0), a = s.getInt32(12, !0), c = s.getUint32(16, !0), l = s.getUint32(20, !0);
							let h = r;
							return 5126 === l ? h = new Float32Array(r.buffer, r.byteOffset, r.byteLength / 4 | 0) : 5131 === l && (h = new Uint16Array(r.buffer, r.byteOffset, r.byteLength / 2 | 0)), i.readPixels(e, t, o, a, c, l, h), r.byteLength;
						}
						case 12: {
							if (n.byteLength < 4 || r.byteLength < 4) return -22;
							const e = i.checkFramebufferStatus(s.getUint32(0, !0));
							return o.setUint32(0, e, !0), 4;
						}
						default: return -22;
					}
				}(o, t, a, c);
				return l > 0 && 0 !== Number(i) && this.writeKernelBytes(Number(i), c.subarray(0, l)), l;
			},
			host_kms_set_master: (e) => {
				this.kms.setMasterPid(e);
			},
			host_kms_drop_master: (e) => {
				this.kms.dropMaster();
			},
			host_proc_write_bytes: (e, t, n, r) => {
				const i = this.callbacks.getProcessMemory?.(e);
				if (!i) return -14;
				try {
					const e = this.readKernelBytes(Number(n), r);
					return new Uint8Array(i.buffer, Number(t), r).set(e), 0;
				} catch {
					return -14;
				}
			},
			host_proc_read_bytes: (e, t, n, r) => {
				const i = this.callbacks.getProcessMemory?.(e);
				if (!i) return -14;
				try {
					const e = new Uint8Array(i.buffer, Number(t), r), s = new Uint8Array(r);
					return s.set(e), this.writeKernelBytes(Number(n), s), 0;
				} catch {
					return -14;
				}
			},
			host_kms_mode_info: (e, t) => {
				const n = this.callbacks.getKmsCanvas?.(e);
				this.writeKernelBytes(Number(t), function(e, t, n = 60) {
					const r = vn(e, 1920), i = vn(t, 1080), s = An(r + 16), o = An(r + 48), a = An(r + 160), c = An(i + 3), l = An(i + 8), h = An(i + 45), d = Math.max(1, Math.min(4294967295, Math.round(a * h * n / 1e3))), f = new Uint8Array(68), u = new DataView(f.buffer);
					u.setUint32(0, d, !0), u.setUint16(4, r, !0), u.setUint16(6, s, !0), u.setUint16(8, o, !0), u.setUint16(10, a, !0), u.setUint16(12, 0, !0), u.setUint16(14, i, !0), u.setUint16(16, c, !0), u.setUint16(18, l, !0), u.setUint16(20, h, !0), u.setUint16(22, 0, !0), u.setUint32(24, n, !0), u.setUint32(28, 0, !0), u.setUint32(32, 9, !0);
					const p = `${r}x${i}`;
					for (let g = 0; g < Math.min(p.length, 31); g++) f[36 + g] = 255 & p.charCodeAt(g);
					return f;
				}(n?.width, n?.height));
			},
			host_kms_addfb: (e, t, n, r, i, s, o) => (this.kms.addFb({
				fb_id: t,
				bo_id: n,
				width: r,
				height: i,
				pixel_format: s,
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
	hostOpen(e, t, n, r) {
		try {
			const i = this.getMemoryBuffer().slice(e, e + t), s = new TextDecoder().decode(i);
			return BigInt(this.io.open(s, n, r));
		} catch (i) {
			return BigInt(Cn(i));
		}
	}
	hostClose(e) {
		const t = Number(e), n = this.sharedPipes.get(t);
		if (n) return "read" === n.end ? n.pipe.closeRead() : n.pipe.closeWrite(), this.sharedPipes.delete(t), 0;
		if (t >= 0 && t <= 2) return 0;
		const r = this.retainedHostFileHandles.get(t);
		if (r) return r.descriptorClosePending = !0, 0;
		try {
			return this.io.close(t);
		} catch (i) {
			return Cn(i);
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
			return Cn(s);
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
			return Cn(o);
		}
	}
	hostSeek(e, t, n, r) {
		const i = Number(e), s = 4294967296 * n + (t >>> 0);
		try {
			return BigInt(this.io.seek(i, s, r));
		} catch (o) {
			return BigInt(Cn(o));
		}
	}
	hostFstat(e, t) {
		const n = Number(e);
		try {
			const e = this.io.fstat(n);
			return this.writeStatToMemory(t, e), this.fstatHandleCapture && (this.fstatHandleCapture.handle = n), 0;
		} catch (r) {
			return Cn(r);
		}
	}
	writeStatToMemory(e, t) {
		const n = this.getMemoryDataView();
		this.getMemoryBuffer().fill(0, e, e + 88), n.setBigUint64(e + 0, bn(t.dev, "st_dev"), !0), n.setBigUint64(e + 8, bn(t.ino, "st_ino"), !0), n.setUint32(e + 16, t.mode, !0), n.setUint32(e + 20, t.nlink, !0), n.setUint32(e + 24, t.uid, !0), n.setUint32(e + 28, t.gid, !0), n.setBigUint64(e + 32, BigInt(t.size), !0);
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
			return Cn(r);
		}
	}
	hostLstat(e, t, n) {
		try {
			const r = this.readPathFromMemory(e, t), i = this.io.lstat(r);
			return this.writeStatToMemory(n, i), 0;
		} catch (r) {
			return Cn(r);
		}
	}
	hostStatfs(e, t, n) {
		try {
			const r = this.readPathFromMemory(e, t), i = this.io.statfs(r);
			return this.writeStatfsToMemory(n, i), 0;
		} catch (r) {
			return Cn(r);
		}
	}
	hostPathconf(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.io.pathconf(i, n);
			return this.getMemoryDataView().setBigInt64(r, BigInt(s ?? -1), !0), 0;
		} catch (i) {
			return Cn(i);
		}
	}
	hostFpathconf(e, t, n) {
		try {
			const r = this.io.fpathconf(Number(e), t);
			return this.getMemoryDataView().setBigInt64(n, BigInt(r ?? -1), !0), 0;
		} catch (r) {
			return Cn(r);
		}
	}
	hostMkdir(e, t, n) {
		try {
			const r = this.readPathFromMemory(e, t);
			return this.io.mkdir(r, n), 0;
		} catch (r) {
			return Cn(r);
		}
	}
	hostRmdir(e, t) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.rmdir(n), 0;
		} catch (n) {
			return Cn(n);
		}
	}
	hostUnlink(e, t) {
		try {
			const n = this.readPathFromMemory(e, t);
			return this.io.unlink(n), 0;
		} catch (n) {
			return Cn(n);
		}
	}
	hostRename(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.readPathFromMemory(n, r);
			return this.io.rename(i, s), 0;
		} catch (i) {
			return Cn(i);
		}
	}
	hostLink(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.readPathFromMemory(n, r);
			return this.io.link(i, s), 0;
		} catch (i) {
			return Cn(i);
		}
	}
	hostSymlink(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.readPathFromMemory(n, r);
			return this.io.symlink(i, s), 0;
		} catch (i) {
			return Cn(i);
		}
	}
	hostReadlink(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t), s = this.io.readlink(i), o = new TextEncoder().encode(s), a = Math.min(o.length, r);
			return this.getMemoryBuffer().set(o.subarray(0, a), n), a;
		} catch (i) {
			return Cn(i);
		}
	}
	hostChmod(e, t, n) {
		try {
			const r = this.readPathFromMemory(e, t);
			return this.io.chmod(r, n), 0;
		} catch (r) {
			return Cn(r);
		}
	}
	hostChown(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.chown(i, n, r), 0;
		} catch (i) {
			return Cn(i);
		}
	}
	hostLchown(e, t, n, r) {
		try {
			const i = this.readPathFromMemory(e, t);
			return this.io.lchown(i, n, r), 0;
		} catch (i) {
			return Cn(i);
		}
	}
	hostAccess(e, t, n) {
		try {
			const r = this.readPathFromMemory(e, t);
			return this.io.access(r, n), 0;
		} catch (r) {
			return Cn(r);
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
			const n = this.readPathFromMemory(e, t), r = this.io.opendir(n);
			return this.pendingDirectoryEntries.delete(r), BigInt(r);
		} catch (n) {
			return BigInt(Cn(n));
		}
	}
	hostReaddir(e, t, n, r) {
		try {
			const i = Number(e);
			let s = this.pendingDirectoryEntries.get(i);
			if (void 0 === s) {
				const e = this.io.readdir(i);
				if (null === e) return 0;
				this.pendingDirectoryEntries.set(i, e), s = e;
			}
			const o = this.getMemoryDataView(), a = this.getMemoryBuffer(), c = new TextEncoder().encode(s.name), l = Math.min(c.length, r);
			return o.setBigUint64(t, BigInt(s.ino), !0), o.setUint32(t + 8, s.type, !0), o.setUint32(t + 12, l, !0), a.set(c.subarray(0, l), n), this.pendingDirectoryEntries.delete(i), 1;
		} catch (i) {
			return Cn(i);
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
const En = new TextEncoder(), xn = new TextDecoder();
function Mn(e) {
	const t = function(e) {
		for (let t = 0; t + 3 < e.length; t++) if (13 === e[t] && 10 === e[t + 1] && 13 === e[t + 2] && 10 === e[t + 3]) return t;
		return -1;
	}(e);
	if (t < 0) return {
		status: 200,
		headers: {},
		body: e
	};
	const n = xn.decode(e.subarray(0, t)).split("\r\n"), r = n[0]?.match(/^HTTP\/[\d.]+ (\d+)/), i = r ? parseInt(r[1], 10) : 200, s = {};
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
			const i = xn.decode(e.subarray(n, r)).trim(), s = parseInt(i, 16);
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
function zn(e, t, n = function() {
	let e = 0;
	return "function" == typeof SharedArrayBuffer && (e |= Z.shared_array_buffer), "function" == typeof Atomics.wait && (e |= Z.atomics_wait), "function" == typeof Atomics.waitAsync && (e |= Z.atomics_wait_async), e;
}()) {
	const r = function(e, t) {
		const n = Tn(e, "kernel_host_adapter_manifest_ptr"), r = Tn(e, "kernel_host_adapter_manifest_len"), i = Ln(n(), "kernel_host_adapter_manifest_ptr"), s = Ln(r(), "kernel_host_adapter_manifest_len");
		if (s < 40) throw new Error(`kernel host adapter manifest is too small: ${s} bytes (expected at least 40)`);
		if (i + 40 > t.buffer.byteLength) throw new Error(`kernel host adapter manifest is out of bounds: ptr=${i} size=40 memory=${t.buffer.byteLength}`);
		const o = new DataView(t.buffer, i, 40);
		return {
			magic: Un(o, "magic"),
			manifestVersion: Bn(o, "manifestVersion"),
			manifestSize: Bn(o, "manifestSize"),
			abiVersion: Un(o, "abiVersion"),
			requiredHostAdapterVersion: Un(o, "requiredHostAdapterVersion"),
			requiredWorkerFeatures: Un(o, "requiredWorkerFeatures"),
			optionalKernelFeatures: Un(o, "optionalKernelFeatures"),
			channelHeaderSize: Un(o, "channelHeaderSize"),
			channelDataOffset: Un(o, "channelDataOffset"),
			channelDataSize: Un(o, "channelDataSize"),
			channelMinSize: Un(o, "channelMinSize")
		};
	}(e, t);
	if (1296781399 !== r.magic) throw new Error(`kernel host adapter manifest has invalid magic: ${r.magic}`);
	if (1 !== r.manifestVersion) throw new Error(`kernel host adapter manifest version ${r.manifestVersion} is not supported by host manifest reader 1`);
	if (40 !== r.manifestSize) throw new Error(`kernel host adapter manifest size ${r.manifestSize} does not match host reader size 40`);
	if (41 !== r.abiVersion) throw new Error(`kernel host adapter manifest ABI version ${r.abiVersion} does not match host ABI version 41`);
	if (r.requiredHostAdapterVersion > 1) throw new Error(`kernel requires host adapter version ${r.requiredHostAdapterVersion}, but this host supports 1`);
	const i = r.requiredWorkerFeatures & ~n;
	if (0 !== i) throw new Error("kernel requires unsupported worker features: " + function(e) {
		const t = [];
		let n = 0;
		for (const [i, s] of Object.entries(Z)) n |= s, 0 !== (e & s) && t.push(i);
		const r = e & ~n;
		0 !== r && t.push(`unknown(0x${r.toString(16)})`);
		return 0 === t.length ? "none" : t.join(", ");
	}(i));
	Rn("channel header size", r.channelHeaderSize, 72), Rn("channel data offset", r.channelDataOffset, 72), Rn("channel data size", r.channelDataSize, ee), Rn("channel minimum size", r.channelMinSize, te);
	for (const s of J) if ("function" != typeof e.exports[s]) throw new Error(`kernel wasm is missing required host adapter export ${s}`);
	return r;
}
function Tn(e, t) {
	const n = e.exports[t];
	if ("function" != typeof n) throw new Error(`kernel wasm is missing required host adapter export ${t}`);
	return n;
}
function Ln(e, t) {
	const n = "bigint" == typeof e ? Number(e) : e;
	if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${t} returned invalid manifest pointer/length ${String(e)}`);
	return n;
}
function Bn(e, t) {
	return e.getUint16(Q[t].offset, !0);
}
function Un(e, t) {
	return e.getUint32(Q[t].offset, !0);
}
function Rn(e, t, n) {
	if (t !== n) throw new Error(`kernel host adapter manifest ${e} ${t} does not match generated host ABI value ${n}`);
}
const Hn = 67108864, Fn = 1024, Wn = 61440, Dn = Math.ceil(1.0010986328125);
function $n(e, t) {
	let n = 0n, r = 0n, i = t;
	for (;;) {
		if (i >= e.length) throw new Error("truncated wasm LEB128");
		const t = e[i++];
		if (n |= BigInt(127 & t) << r, !(128 & t)) break;
		r += 7n;
	}
	return [n, i - t];
}
function On(e, t) {
	const [n, r] = $n(e, t);
	if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`wasm LEB128 value exceeds JS safe integer: ${n}`);
	return [Number(n), r];
}
function Nn(e, t) {
	const [n, r] = On(e, t);
	let i = t + r;
	const [, s] = $n(e, i);
	if (i += s, 1 & n) {
		const [, t] = $n(e, i);
		i += t;
	}
	return i;
}
function Kn(e, t) {
	if (!Number.isInteger(e) || e < 0) throw new Error(`invalid ${t}: ${e}`);
	return e;
}
function Vn(e, t = 1024) {
	Kn(t, "host default thread slot count");
	const n = e ? function(e) {
		return wn(e, "__wasm_posix_thread_slots");
	}(e) : null;
	if (null === n || -1 === n) return t;
	if (!Number.isInteger(n) || n < -1) throw new Error(`invalid process thread slot declaration: ${n}`);
	return Kn(n, "process thread slot declaration");
}
function qn(e) {
	const t = e.maxPages ?? 16384;
	if (!Number.isInteger(t) || t <= Dn) throw new Error(`invalid process maximum pages: ${t}`);
	const n = e.programBytes ? function(e) {
		const t = new Uint8Array(e);
		if (t.length < 8 || 0 !== t[0] || 97 !== t[1] || 115 !== t[2] || 109 !== t[3]) return null;
		let n = 8;
		for (; n < t.length;) {
			const e = t[n++], [r, i] = On(t, n);
			if (n += i, 2 !== e) {
				n += r;
				continue;
			}
			const [s, o] = On(t, n);
			n += o;
			for (let a = 0; a < s; a++) {
				const [e, r] = On(t, n);
				n += r + e;
				const [i, s] = On(t, n);
				n += s + i;
				const o = t[n++];
				if (0 === o) {
					const [, e] = On(t, n);
					n += e;
				} else if (1 === o) n += 1, n = Nn(t, n);
				else {
					if (2 === o) {
						const [, e] = On(t, n);
						n += e;
						const [r] = On(t, n);
						return r;
					}
					if (3 === o) n += 2;
					else {
						if (4 !== o) return null;
						{
							n += 1;
							const [, e] = On(t, n);
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
	}(e.heapBase), s = (o = Math.max(i ?? 16777216, r * an), Math.ceil(o / an) * an);
	var o;
	const a = s / an, c = void 0 !== e.threadSlots ? Kn(e.threadSlots, "process thread slot count") : Vn(e.programBytes, e.defaultThreadSlots), l = a + 1, h = l * an, d = l + Dn, f = d + 2, u = d + (e.preallocateThreadSlots ? 4 * c : 0), p = Math.max(r, u);
	if (p > t) throw new Error(`initial pages ${p} exceed process maximum ${t}`);
	const g = u * an, m = t * an;
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
function Gn(e, t, n = 4) {
	const r = Math.ceil(t / an) - Math.ceil(e.buffer.byteLength / an);
	r <= 0 || (8 === n ? e.grow(BigInt(r)) : e.grow(r));
}
function jn(e, t, n, r, i = !1) {
	return !i && e.get(t) === n && n.memory === r;
}
const Xn = 11, Yn = 14, Zn = 22;
function Jn(e, t, n) {
	if (!Number.isSafeInteger(t) || t <= 0 || t >= e.length) return { errno: Yn };
	if (n <= 0) return { errno: 36 };
	const r = e.length - t, i = Math.min(r, n), s = e.subarray(t, t + i).indexOf(0);
	return s >= 0 ? { size: s + 1 } : { errno: r < n ? Yn : 36 };
}
function Qn(e, t, n) {
	return Number.isSafeInteger(t) && t > 0 && Number.isSafeInteger(n) && n >= 0 && t <= e.length - n;
}
const er = 4194304, tr = Ce, nr = De, rr = it, ir = lt, sr = Ue, or = yt, ar = wt, cr = tt, lr = mt, hr = pt, dr = Mt, fr = gt, ur = zt, pr = ft, gr = ut, mr = Ie, yr = dt, wr = se, _r = le, Sr = oe, br = ae, kr = ce, vr = ht, Ar = Ae, Ir = Lt, Cr = Ye, Pr = Ze, Er = ct, xr = St, Mr = Bt, zr = 16, Tr = [{
	name: "lo",
	index: 1,
	loopback: !0
}, {
	name: "eth0",
	index: 2,
	loopback: !1
}], Lr = Oe, Br = Pe, Ur = Ee, Rr = Me, Hr = xe, Fr = st, Wr = _t, Dr = ue, $r = fe, Or = Fe, Nr = We, Kr = Ve, Vr = Xe, qr = Ke, Gr = je, jr = At, Xr = bt, Yr = ge, Zr = me, Jr = Ne, Qr = Le, ei = Be, ti = Re, ni = He, ri = ot, ii = at, si = ze, oi = Tt, ai = Te, ci = 4096, li = -100;
function hi(e) {
	return Math.ceil(e / an) * an;
}
const di = qe, fi = Ge, ui = kt, pi = vt, gi = ye, mi = Pt, yi = Et, wi = xt, _i = It, Si = Ct, bi = he, ki = $e, vi = de, Ai = rt, Ii = "undefined" != typeof process && !!{}.WASM_POSIX_PROFILE, Ci = new Set([
	fe,
	Be,
	He,
	Fe,
	Ge,
	at
]), Pi = new Set([
	ue,
	Le,
	Re,
	We,
	qe,
	ot,
	bt
]);
const Ei = te;
const xi = {
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
}, Mi = {
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
}, zi = {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe"
}, Ti = {
	stdin: "terminal",
	stdout: "terminal",
	stderr: "terminal"
};
function Li(e) {
	switch (e) {
		case "pipe": return 0;
		case "terminal": return 1;
	}
}
var Bi = class {
	config;
	io;
	callbacks;
	kernel;
	kernelInstance = null;
	kernelMemory = null;
	kernelAbiVersion = 0;
	processes = /* @__PURE__ */ new Map();
	activeChannels = [];
	execHandoffPids = /* @__PURE__ */ new Set();
	scratchOffset = 0;
	initialized = !1;
	nextChildPid = 100;
	allocateTopLevelSpawnPid() {
		for (; this.processes.has(this.nextChildPid);) this.nextChildPid++;
		return this.nextChildPid++;
	}
	allocatePid() {
		return this.allocateTopLevelSpawnPid();
	}
	channelTids = /* @__PURE__ */ new Map();
	threadForkContexts = /* @__PURE__ */ new Map();
	currentHandlePid = 0;
	bindKernelTidForChannel(e) {
		const t = this.channelTids.get(`${e.pid}:${e.channelOffset}`) ?? 0, n = this.kernelInstance?.exports.kernel_set_current_tid;
		n && n(t);
	}
	guestTidForChannel(e) {
		return this.channelTids.get(`${e.pid}:${e.channelOffset}`) ?? e.pid;
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
	profileData = Ii ? /* @__PURE__ */ new Map() : null;
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
	constructor(e, t, n = {}) {
		if (this.config = e, this.io = t, this.callbacks = n, this.kernel = new Pn(e, t, {
			getProcessMemory: (e) => this.processes.get(e)?.memory,
			getKmsCanvas: (e) => this.kmsCanvases.get(e),
			markKmsCanvasGlOwned: (e) => {
				this.kmsContextMode.set(e, "webgl2");
			},
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
						this.alarmTimers.delete(t), this.sendSignalToProcess(t, 14);
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
						const n = this.posixTimers.get(s);
						if (n && n.timeout === o) if (this.processes.has(i)) if (this.firePosixTimer(i, e, t), r > 0) {
							const n = setInterval(() => {
								const r = this.posixTimers.get(s);
								if (r && r.interval === n) return this.processes.has(i) ? void this.firePosixTimer(i, e, t) : (clearInterval(n), void this.posixTimers.delete(s));
								clearInterval(n);
							}, r), a = this.posixTimers.get(s);
							a?.timeout === o ? a.interval = n : clearInterval(n);
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
		const t = this.kernelInstance.exports[Y];
		if ("function" != typeof t) throw new Error(`kernel wasm is missing the ${Y} export — refusing to run. Rebuild the kernel (bash build.sh) against the current ABI.`);
		this.kernelAbiVersion = t(), zn(this.kernelInstance, this.kernelMemory);
		const n = this.kernelInstance.exports.kernel_alloc_scratch;
		if (this.scratchOffset = Number(n(Ei)), 0 === this.scratchOffset) throw new Error("Failed to allocate kernel scratch buffer");
		try {
			const e = await import("./__vite-browser-external-BQmvazNg.js").then((e) => o(e.default, 1));
			"function" == typeof e.createServer && (this.netModule = e);
		} catch {}
		if (this.tcpScratchOffset = Number(n(65536)), 0 === this.tcpScratchOffset) throw new Error("Failed to allocate TCP scratch buffer");
		this.initialized = !0;
	}
	registerProcess(e, t, n, r) {
		if (!this.initialized) throw new Error("Kernel not initialized");
		if (this.discardStoppedChannelStateForProcess(e, !r?.skipKernelCreate), void 0 !== r?.argv || void 0 !== r?.env) {
			const e = this.validateExecMetadata(r.argv ?? [], r.env ?? [], r.metadataPtrWidth ?? r.ptrWidth ?? 4);
			if (e < 0) throw new Error("Process argv/environment exceeds exec metadata limits: errno " + -e);
		}
		if (this.hostReaped.delete(e), !r?.skipKernelCreate) {
			const t = r?.stdio;
			if (!t) throw new Error("registerProcess requires explicit stdio when creating a kernel process");
			const n = this.kernelInstance.exports.kernel_create_process_with_stdio;
			if (!n) throw new Error("Kernel missing kernel_create_process_with_stdio export");
			const i = n(e, Li(t.stdin), Li(t.stdout), Li(t.stderr));
			if (i < 0) throw new Error(`Failed to create process ${e}: errno ${-i}`);
		}
		if (void 0 !== r?.brkBase && !this.setBrkBase(e, r.brkBase)) throw new Error("Kernel export kernel_set_brk_base is required for compact process memory layout");
		void 0 !== r?.argv && this.replaceProcessMetadata(e, 0, r.argv), void 0 !== r?.env && this.replaceProcessMetadata(e, 1, r.env);
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
	validateExecMetadata(e, t, n = 4) {
		const r = new TextEncoder();
		let i = 2 * n;
		for (const s of [...e, ...t]) {
			const e = r.encode(s).byteLength;
			if (e > 65536) return -7;
			if (i += n + e + 1, !Number.isSafeInteger(i) || i > er) return -7;
		}
		return 0;
	}
	supportsExecMetadataReplacement() {
		const e = this.kernelInstance?.exports;
		return "function" == typeof e?.kernel_clear_process_metadata && "function" == typeof e?.kernel_push_process_metadata_entry;
	}
	replaceProcessMetadata(e, t, n) {
		const r = this.kernelInstance.exports.kernel_clear_process_metadata, i = this.kernelInstance.exports.kernel_push_process_metadata_entry;
		if (!r || !i) {
			const r = this.kernelInstance.exports.kernel_set_process_argv;
			if (0 !== t || !r) throw new Error("Kernel missing bounded process metadata exports");
			const i = new TextEncoder().encode(n.join("\0"));
			if (i.byteLength > 65536) throw new Error("Legacy process argv exceeds bounded scratch transport: errno 7");
			new Uint8Array(this.kernelMemory.buffer).set(i, this.scratchOffset);
			const s = r(e, this.toKernelPtr(this.scratchOffset), i.byteLength);
			if (s < 0) throw new Error(`Failed to replace process argv for pid ${e}: errno ${-s}`);
			return;
		}
		const s = r(e, t);
		if (s < 0) throw new Error(`Failed to clear process metadata for pid ${e}: errno ${-s}`);
		const o = new TextEncoder();
		for (const a of n) {
			const n = o.encode(a);
			if (n.byteLength > 65536) throw new Error("Process metadata entry exceeds bounded scratch transport: errno 7");
			new Uint8Array(this.kernelMemory.buffer).set(n, this.scratchOffset);
			const r = i(e, t, this.toKernelPtr(this.scratchOffset), n.byteLength);
			if (r < 0) throw new Error(`Failed to append process metadata for pid ${e}: errno ${-r}`);
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
		for (const [i, s] of Array.from(this.pendingSleeps.entries())) this.isRegisteredChannel(s.channel) && (this.dequeueSignalForDelivery(s.channel, !0), this.finishSignalTermination(s.channel) || new DataView(s.channel.memory.buffer, s.channel.channelOffset).getUint32(65560, !0) > 0 && (clearTimeout(s.timer), this.pendingSleeps.delete(i), this.completeChannel(s.channel, s.syscallNr, s.origArgs, on[s.syscallNr], -1, 4)));
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
		const r = new TextEncoder().encode(t);
		new Uint8Array(this.kernelMemory.buffer).set(r, this.scratchOffset);
		const i = n(e, this.toKernelPtr(this.scratchOffset), r.length);
		if (i < 0) throw new Error(`setCwd failed for pid ${e}: errno ${-i}`);
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
		const t = e(this.toKernelPtr(this.scratchOffset), Ei);
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
		const n = t(e, this.toKernelPtr(this.scratchOffset), Ei);
		if (n < 0) return null;
		if (0 === n) return "";
		const r = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, n), i = new Uint8Array(n);
		return i.set(r), new TextDecoder("utf-8", { fatal: !1 }).decode(i);
	}
	unregisterProcess(e) {
		if (!this.processes.get(e)) return;
		this.retireAsyncChannelsForProcess(e), this.discardStoppedChannelStateForProcess(e), this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.parentPid !== e && t.channel.pid !== e), this.releaseAllSharedMemoryForProcess(e), this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.cleanupUdpBindings(e), this.cleanupTcpListeners(e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingSignalWaits(e), this.cleanupPendingPipeReaders(e), this.cleanupPendingPipeWriters(e), this.cancelPendingSleepsForProcess(e);
		for (const [n, r] of this.socketTimeoutTimers) n.pid === e && (clearTimeout(r), this.socketTimeoutTimers.delete(n));
		for (const n of this.epollInterests.keys()) n.startsWith(`${e}:`) && this.epollInterests.delete(n);
		this.removeFromKernelProcessTable(e), this.processes.delete(e), this.execHandoffPids?.delete(e), this.stdinFinite.delete(e), this.stdinBuffers.delete(e), this.usePolling && 0 === this.processes.size && this.stopPolling();
		const t = this.ptyIndexByPid.get(e);
		void 0 !== t && (this.ptyIndexByPid.delete(e), this.activePtyIndices.delete(t), this.ptyOutputCallbacks.delete(t));
	}
	removeProcessFromKernelTable(e) {
		if (!this.initialized) return;
		const t = this.kernelInstance?.exports.kernel_remove_process;
		t && (t(e), this.drainAndProcessWakeupEvents());
	}
	cancelPendingSleepsForProcess(e) {
		for (const [t, n] of this.pendingSleeps) t.pid === e && (clearTimeout(n.timer), this.pendingSleeps.delete(t));
	}
	deactivateProcess(e) {
		this.retireAsyncChannelsForProcess(e), this.discardStoppedChannelStateForProcess(e), this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.parentPid !== e && t.channel.pid !== e), this.releaseAllSharedMemoryForProcess(e), this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.processes.delete(e), this.execHandoffPids?.delete(e), this.stdinFinite.delete(e), this.stdinBuffers.delete(e);
		const t = this.alarmTimers.get(e);
		t && (clearTimeout(t), this.alarmTimers.delete(e));
		for (const [n, r] of this.posixTimers) n.startsWith(`${e}:`) && (clearTimeout(r.timeout), r.interval && clearInterval(r.interval), this.posixTimers.delete(n));
		this.cancelPendingSleepsForProcess(e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingSignalWaits(e), this.cleanupUdpBindings(e), this.cleanupTcpListeners(e), this.hostReaped.delete(e);
	}
	kernelExecPrepare(e, t = e) {
		const n = this.kernelInstance.exports.kernel_exec_prepare;
		if (!n) return 0;
		const r = this.currentHandlePid;
		this.currentHandlePid = e;
		try {
			return n(e, t);
		} finally {
			this.currentHandlePid = r, this.drainAndProcessWakeupEvents();
		}
	}
	kernelExecSetup(e, t = e) {
		const n = this.kernelInstance.exports.kernel_exec_setup_for_thread, r = this.kernelInstance.exports.kernel_exec_setup, i = this.currentHandlePid;
		this.currentHandlePid = e;
		try {
			const i = this.snapshotExecTcpListenerWakeIds(e), s = n ? n(e, t) : r(e);
			return 0 === s && this.pruneExecFdMirrors(e, i), s;
		} finally {
			this.currentHandlePid = i, this.drainAndProcessWakeupEvents();
		}
	}
	snapshotExecTcpListenerWakeIds(e) {
		const t = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx, n = /* @__PURE__ */ new Map();
		if (!t) return n;
		const r = (r, i, s) => {
			const o = s ?? t(e, i);
			o >= 0 && n.set(`${r}:${i}`, o);
		};
		for (const [s, o] of this.tcpListenerTargets) for (const t of o) t.pid === e && r(s, t.fd, t.acceptWakeIdx);
		const i = `${e}:`;
		for (const [s, o] of this.tcpListeners) {
			if (!s.startsWith(i)) continue;
			const t = Number(s.slice(i.length)), n = this.tcpListenerTargets.get(o.port)?.find((n) => n.pid === e && n.fd === t);
			r(o.port, t, n?.acceptWakeIdx);
		}
		return n;
	}
	resolveInheritedListenerFd(e, t, n) {
		const r = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		if (!r) return {
			fd: t,
			...void 0 !== n ? { acceptWakeIdx: n } : {}
		};
		const i = r(e, t);
		if (void 0 === n) return i >= 0 ? {
			fd: t,
			acceptWakeIdx: i
		} : null;
		if (i === n) return {
			fd: t,
			acceptWakeIdx: n
		};
		const s = this.kernelInstance.exports.kernel_find_listener_fd_by_accept_wake;
		let o = s?.(e, n) ?? -1;
		if (!s) {
			for (let a = 0; a < 1024; a++) if (r(e, a) === n) {
				o = a;
				break;
			}
		}
		return o >= 0 ? {
			fd: o,
			acceptWakeIdx: n
		} : null;
	}
	inheritHostFdMirrors(e, t, n = !0) {
		const r = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
		for (const [, s] of this.tcpListenerTargets) for (const n of s.filter((t) => t.pid === e)) {
			const i = n.acceptWakeIdx ?? (() => {
				const t = r?.(e, n.fd) ?? -1;
				return t >= 0 ? t : void 0;
			})(), o = this.resolveInheritedListenerFd(t, n.fd, i);
			o && !s.some((e) => e.pid === t && e.fd === o.fd) && s.push({
				pid: t,
				...o
			});
		}
		if (!n) return;
		const i = this.kernelInstance.exports.kernel_fd_is_open;
		for (const [s, o] of Array.from(this.epollInterests.entries())) {
			if (!s.startsWith(`${e}:`)) continue;
			const n = Number(s.slice(s.indexOf(":") + 1));
			i && 1 !== i(t, n) || this.epollInterests.set(`${t}:${n}`, o.filter((e) => !i || 1 === i(t, e.fd)).map((e) => ({ ...e })));
		}
	}
	rollbackChildHostRegistration(e) {
		this.deactivateProcess(e);
		for (const t of Array.from(this.epollInterests.keys())) t.startsWith(`${e}:`) && this.epollInterests.delete(t);
	}
	pruneExecFdMirrors(e, t) {
		const n = this.kernelInstance.exports.kernel_fd_is_open;
		if (!n) return;
		const r = (t) => 1 === n(e, t), i = `${e}:`, s = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx, o = this.kernelInstance.exports.kernel_find_listener_fd_by_accept_wake, a = /* @__PURE__ */ new Map(), c = (n, i) => {
			const c = t.get(`${n}:${i}`);
			if (void 0 === c || !s) return r(i) ? i : null;
			if (s(e, i) === c) return i;
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
		for (const [h, d] of Array.from(this.epollInterests.entries())) h.startsWith(i) && (r(Number(h.slice(i.length))) ? this.epollInterests.set(h, d.filter((e) => r(e.fd))) : this.epollInterests.delete(h));
		for (const [h, d] of Array.from(this.tcpListenerTargets.entries())) {
			const t = [];
			for (const n of d) {
				if (n.pid !== e) {
					t.push(n);
					continue;
				}
				const r = c(h, n.fd);
				null === r || t.some((t) => t.pid === e && t.fd === r) || t.push({
					...n,
					pid: e,
					fd: r
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
			if (!h.startsWith(i)) continue;
			const t = Number(h.slice(i.length)), n = c(d.port, t);
			if (n !== t) if (this.tcpListeners.delete(h), null === n) l.set(d.port, d);
			else {
				const t = `${e}:${n}`;
				this.tcpListeners.has(t) || this.tcpListeners.set(t, {
					...d,
					pid: e
				});
			}
		}
		for (const [h, d] of l) {
			const e = this.tcpListenerTargets.get(h);
			if (e && 0 !== e.length) {
				const t = e[0], n = `${t.pid}:${t.fd}`;
				this.tcpListeners.has(n) || this.tcpListeners.set(n, {
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
		const n = this.kernelInstance.exports.kernel_fd_supports_mmap_writeback;
		return !n || 1 === n(e, t);
	}
	prepareAddressSpaceForExec(e) {
		const t = this.processes.get(e)?.channels[0];
		if (!t) {
			const t = (this.sharedMappings.get(e)?.size ?? 0) > 0, n = (this.shmMappings.get(e)?.size ?? 0) > 0;
			return t || n ? -5 : 0;
		}
		try {
			this.syncAnonymousSharedMappingsFromProcess(t, { force: !0 }), this.syncFileSharedMappingsFromProcess(t, { force: !0 });
			const n = this.sharedMappings.get(e);
			if (n) {
				for (const [e, r] of n) if (r.writable) {
					if ("file" === r.backingKind && r.backingKey) {
						const e = this.sharedMmapBackings.get(r.backingKey);
						if (e && !this.flushSharedMmapBackingRange(e, r.fileOffset, r.len)) return -5;
						continue;
					}
					if (!r.backingKey && !this.pwriteFromProcessMemory(t, r.fd, e, r.len, r.fileOffset)) return -5;
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
		const n = this.shmMappings.get(e);
		if (!n) return 0;
		const r = this.kernelInstance.exports.kernel_ipc_shmdt;
		let i = 0;
		try {
			if (!r) return -5;
			this.withKernelCurrentPid(e, () => {
				for (const e of n.values()) r(e.segId) < 0 && (i = -5);
			});
		} catch {
			i = -5;
		} finally {
			this.shmMappings.delete(e);
		}
		return i;
	}
	prepareProcessForExec(e) {
		const t = this.processes.get(e);
		(this.execHandoffPids ??= /* @__PURE__ */ new Set()).add(e), t && (t.channels = []), this.discardStoppedChannelStateForProcess(e, !1), this.activeChannels = this.activeChannels.filter((t) => t.pid !== e), this.cleanupPendingPollRetries(e), this.cleanupPendingSelectRetries(e), this.cleanupPendingSignalWaits(e), this.cleanupPendingPipeReaders(e), this.cleanupPendingPipeWriters(e);
		for (const [r, i] of this.pendingAdvisoryLockRetries ?? []) r.pid === e && (clearTimeout(i.timer), this.pendingAdvisoryLockRetries.delete(r));
		this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.parentPid !== e), this.cancelPendingSleepsForProcess(e);
		for (const [r, i] of this.pendingFutexWaits) if (r.pid === e) {
			this.pendingFutexWaits.delete(r);
			try {
				i.retire ? i.retire() : Atomics.notify(new Int32Array(r.memory.buffer), i.futexIndex, 1);
			} catch {}
		}
		for (const r of this.pendingCancels) r.pid === e && this.pendingCancels.delete(r);
		const n = `${e}:`;
		for (const r of this.channelTids.keys()) r.startsWith(n) && this.channelTids.delete(r);
		for (const r of this.threadForkContexts.keys()) r.startsWith(n) && this.threadForkContexts.delete(r);
		for (const r of this.threadCtidPtrs.keys()) r.startsWith(n) && this.threadCtidPtrs.delete(r);
		for (const [r, i] of this.posixTimers) r.startsWith(`${e}:`) && (clearTimeout(i.timeout), i.interval && clearInterval(i.interval), this.posixTimers.delete(r));
		for (const [r, i] of this.socketTimeoutTimers) r.pid === e && (clearTimeout(i), this.socketTimeoutTimers.delete(r));
	}
	isExecHandoffActive(e) {
		return this.execHandoffPids?.has(e) ?? !1;
	}
	finishProcessExecHandoff(e) {
		this.execHandoffPids?.delete(e);
	}
	removeFromKernelProcessTable(e) {
		(0, this.kernelInstance.exports.kernel_remove_process)(e), this.drainAndProcessWakeupEvents();
	}
	addChannel(e, t, n, r, i, s) {
		if (this.execHandoffPids?.has(e)) throw new Error(`Process ${e} is replacing its image`);
		if (!this.isProcessExecutionActive(e)) throw new Error(`Process ${e} is not running`);
		const o = this.processes.get(e);
		if (!o) throw new Error(`Process ${e} not registered`);
		if (s && o.memory !== s) throw new Error(`Process ${e} changed memory generation`);
		const a = {
			pid: e,
			memory: o.memory,
			channelOffset: t,
			i32View: new Int32Array(o.memory.buffer, t),
			consecutiveSyscalls: 0
		};
		o.channels.push(a), this.activeChannels.push(a), void 0 !== n && this.channelTids.set(`${e}:${t}`, n), void 0 !== r && void 0 !== i && this.threadForkContexts.set(`${e}:${t}`, {
			fnPtr: r,
			argPtr: i
		});
		const c = this.kernelInstance.exports.kernel_set_max_addr;
		if (c && !o.explicitMaxAddr) {
			const n = t - 131072;
			n >= Hn && c(e, this.toKernelPtr(n));
		}
		this.usePolling || this.listenOnChannel(a);
	}
	removeChannel(e, t) {
		const n = this.processes.get(e);
		if (n) {
			for (const e of n.channels) e.channelOffset === t && this.retireExactChannelAsyncState(e);
			n.channels = n.channels.filter((e) => e.channelOffset !== t), this.activeChannels = this.activeChannels.filter((n) => !(n.pid === e && n.channelOffset === t)), this.channelTids.delete(`${e}:${t}`), this.threadForkContexts.delete(`${e}:${t}`);
		}
	}
	retireExactChannelAsyncState(e) {
		this.cancelParkedFifoOpen(e), this.discardStoppedChannelState(e), this.resumePreparedSignals?.delete(e), this.pendingCancels?.delete(e), this.waitingForChild = (this.waitingForChild ?? []).filter((t) => t.channel !== e);
		const t = `${e.pid}:${e.channelOffset}`, n = this.pendingSignalWaits?.get(t);
		n && clearTimeout(n.timer), this.pendingSignalWaits?.delete(t), this.signalWaitDeadlines?.delete(t);
		const r = this.pendingSleeps?.get(e);
		r && clearTimeout(r.timer), this.pendingSleeps?.delete(e);
		const i = this.pendingFutexWaits?.get(e);
		if (i) if (this.pendingFutexWaits.delete(e), i.retire) i.retire();
		else try {
			Atomics.notify(new Int32Array(e.memory.buffer), i.futexIndex);
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
		for (const n of this.processes.get(e)?.channels ?? []) t.add(n);
		for (const n of this.activeChannels ?? []) n.pid === e && t.add(n);
		for (const n of this.waitingForChild ?? []) n.channel.pid === e && t.add(n.channel);
		for (const n of this.pendingSleeps?.keys() ?? []) n.pid === e && t.add(n);
		for (const n of this.pendingFutexWaits?.keys() ?? []) n.pid === e && t.add(n);
		for (const n of this.pendingPollRetries?.keys() ?? []) n.pid === e && t.add(n);
		for (const n of this.pendingAdvisoryLockRetries?.keys() ?? []) n.pid === e && t.add(n);
		for (const n of this.pendingSelectRetries?.keys() ?? []) n.pid === e && t.add(n);
		for (const n of this.pendingCancels ?? []) n.pid === e && t.add(n);
		for (const n of this.pendingPipeReaders?.values() ?? []) for (const r of n) r.channel.pid === e && t.add(r.channel);
		for (const n of this.pendingPipeWriters?.values() ?? []) for (const r of n) r.channel.pid === e && t.add(r.channel);
		for (const n of t) this.retireExactChannelAsyncState(n);
	}
	isRegisteredChannel(e) {
		const t = this.processes.get(e.pid);
		return void 0 !== t && t.channels.includes(e);
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
	startProcessWorkerWhenRunnable(e, t, n, r, i) {
		const s = this.processes.get(e);
		if (!s || s.memory !== t) return r(), "stale";
		const o = this.kernelInstance.exports.kernel_get_process_state, a = o(e);
		if (2 === a) return r(), "dead";
		if (a < 0) return r(), "stale";
		const c = () => {
			this.stoppedPids.add(e);
			const s = {
				expectedMemory: t,
				start: n,
				cancel: r,
				onStartError: i
			};
			let o = this.deferredProcessWorkerStarts.get(e);
			return o || (o = /* @__PURE__ */ new Set(), this.deferredProcessWorkerStarts.set(e, o)), o.add(s), "deferred";
		};
		if (1 === a) return c();
		if (0 !== a) return r(), "stale";
		if (this.pendingResumePids?.has(e) || this.stoppedPids?.has(e)) {
			if (c(), this.resumeStoppedProcess(e)) return "started";
			this.drainAndProcessWakeupEvents();
			const t = o(e);
			return 2 === t ? "dead" : t < 0 ? "stale" : "deferred";
		}
		return this.stoppedPids.delete(e), n(), "started";
	}
	listenOnChannel(e) {
		if (!this.isRegisteredChannel(e)) return;
		if (this.deferChannelWhileStopped(e)) return;
		const t = new Int32Array(e.memory.buffer, e.channelOffset);
		e.i32View = t;
		const n = Atomics.load(t, 0);
		if (1 === n) return void (this.relistenBatchSize <= 1 ? setImmediate(() => {
			this.isRegisteredChannel(e) && this.handleSyscall(e);
		}) : this.handleSyscall(e));
		const r = Atomics.waitAsync(t, 0, n);
		r.async ? r.value.then(() => {
			this.isRegisteredChannel(e) && this.listenOnChannel(e);
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
	readBytesPreview(e, t, n, r = 160) {
		if (0 === t || n <= 0) return "";
		const i = new Uint8Array(e.buffer), s = Math.max(0, Math.min(n, r, i.length - t));
		if (s <= 0) return "";
		const o = new Uint8Array(s);
		return o.set(i.subarray(t, t + s)), new TextDecoder("utf-8", { fatal: !1 }).decode(o);
	}
	formatPollFds(e, t, n) {
		if (0 === t || n <= 0) return "";
		const r = new DataView(e.buffer), i = [], s = Math.min(n, 8);
		for (let o = 0; o < s; o++) {
			const e = t + 8 * o;
			if (e + 8 > r.byteLength) break;
			const n = r.getInt32(e, !0), s = r.getInt16(e + 4, !0), a = r.getInt16(e + 6, !0);
			i.push(`{fd:${n},events:0x${(65535 & s).toString(16)},revents:0x${(65535 & a).toString(16)}}`);
		}
		return n > s && i.push("..."), i.join(",");
	}
	formatSyscallEntry(e, t, n) {
		const r = xi[t] ?? `syscall_${t}`, i = e.pid, s = this.channelTids.get(`${i}:${e.channelOffset}`), o = void 0 !== s ? `:t${s}` : "";
		switch (t) {
			case he: return `[${i}${o}] open("${this.readCString(e.memory, n[0])}", 0x${(n[1] >>> 0).toString(16)}, 0o${(n[2] >>> 0).toString(8)})`;
			case $e: return `[${i}${o}] openat(${n[0]}, "${this.readCString(e.memory, n[1])}", 0x${(n[2] >>> 0).toString(16)}, 0o${(n[3] >>> 0).toString(8)})`;
			case we: return `[${i}${o}] stat("${this.readCString(e.memory, n[0])}")`;
			case _e: return `[${i}${o}] lstat("${this.readCString(e.memory, n[0])}")`;
			case Je: return `[${i}${o}] fstatat(${n[0]}, "${this.readCString(e.memory, n[1])}", 0x${(n[3] >>> 0).toString(16)})`;
			case be: return `[${i}${o}] access("${this.readCString(e.memory, n[0])}", ${n[1]})`;
			case Qe: return `[${i}${o}] faccessat(${n[0]}, "${this.readCString(e.memory, n[1])}", ${n[2]})`;
			case ke: return `[${i}${o}] chdir("${this.readCString(e.memory, n[0])}")`;
			case ve: return `[${i}${o}] opendir("${this.readCString(e.memory, n[0])}")`;
			case Se: return `[${i}${o}] readlink("${this.readCString(e.memory, n[0])}", ${n[2]})`;
			case et: return `[${i}${o}] readlinkat(${n[0]}, "${this.readCString(e.memory, n[1])}", ${n[3]})`;
			case nt: return `[${i}${o}] realpath("${this.readCString(e.memory, n[0])}")`;
			case fe: return `[${i}${o}] read(${n[0]}, ${n[2]})`;
			case ue: return `[${i}${o}] write(${n[0]}, ${n[2]}, ${JSON.stringify(this.readBytesPreview(e.memory, n[1], n[2]))})`;
			case de: return `[${i}${o}] close(${n[0]})`;
			case pe: return `[${i}${o}] fstat(${n[0]})`;
			case ye: return `[${i}${o}] fcntl(${n[0]}, ${n[1]}, ${n[2]})`;
			case Pe: return `[${i}${o}] mmap(0x${(n[0] >>> 0).toString(16)}, ${n[1] >>> 0}, ${n[2]}, 0x${(n[3] >>> 0).toString(16)}, ${n[4]}, ${n[5] >>> 0})`;
			case Ee: return `[${i}${o}] munmap(0x${(n[0] >>> 0).toString(16)}, ${n[1] >>> 0})`;
			case xe: return `[${i}${o}] brk(0x${(n[0] >>> 0).toString(16)})`;
			case se: return `[${i}${o}] execve("${this.readCString(e.memory, n[0])}")`;
			case oe: return `[${i}${o}] fork()`;
			case ae: return `[${i}${o}] vfork()`;
			case ht: return `[${i}${o}] clone(0x${(n[0] >>> 0).toString(16)})`;
			case Ae: return `[${i}${o}] exit(${n[0]})`;
			case Ue: return `[${i}${o}] poll(${n[1]}, ${n[2]}, [${this.formatPollFds(e.memory, n[0], n[1])}])`;
			case Oe: return `[${i}${o}] ioctl(${n[0]}, 0x${(n[1] >>> 0).toString(16)})`;
			default: return `[${i}${o}] ${r}(${n.filter((e, t) => t < 3).join(", ")})`;
		}
	}
	formatSyscallReturn(e, t, n) {
		if (t < 0 || 0 !== n) return ` = ${t} (${Mi[n] ?? `errno=${n}`})`;
		switch (e) {
			case Pe:
			case xe: return ` = 0x${(t >>> 0).toString(16)}`;
			default: return ` = ${t}`;
		}
	}
	handleSyscall(e) {
		if (this.isRegisteredChannel(e) && !this.deferChannelWhileStopped(e)) try {
			if (Ii) {
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
		} catch (Zi) {
			console.error(`[handleSyscall] UNCAUGHT ERROR pid=${e.pid}:`, Zi), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
		}
	}
	_handleSyscallInner(e) {
		const t = new DataView(e.memory.buffer, e.channelOffset), n = t.getUint32(4, !0), r = [];
		for (let w = 0; w < 6; w++) {
			const e = t.getBigInt64(8 + 8 * w, !0);
			n === gr && 1 === w ? r.push(Number(BigInt.asUintN(32, e))) : r.push(Number(e));
		}
		const i = e.pid;
		let s = this.syscallRing.get(i);
		s || (s = [], this.syscallRing.set(i, s)), s.push(`  ${this.formatSyscallEntry(e, n, r)}`), s.length > 30 && s.shift(), this.syscallTraceEnabled && (this.syscallTraceRing.length >= this.syscallTraceCap && this.syscallTraceRing.shift(), this.syscallTraceRing.push({
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
			],
			decoded: this.formatSyscallEntry(e, n, r)
		}));
		const o = this.config.syscallLogPtrWidth, a = void 0 !== o && this.processes.get(e.pid)?.ptrWidth === o, c = !!this.config.enableSyscallLog || a;
		let l = "";
		c && (l = this.formatSyscallEntry(e, n, r)), this.synchronizeSharedMemoryForBoundary(e);
		const h = (this.sharedMmapBackings?.size ?? 0) > 0, d = !h || this.flushSharedMappingsBeforeFileSyscall(e, n, r);
		if (h && this.hostReaped?.has(e.pid)) return;
		if (!d) return void this.completeChannel(e, n, r, void 0, -1, 5);
		if (n === Rr && 2 & r[2]) {
			const t = this.prepareFileSharedMappingsForWrite(e.pid, r[0] >>> 0, hi(r[1] >>> 0));
			if (0 !== t) return void this.completeChannel(e, n, r, void 0, -1, t);
		}
		if (n === Sr || n === br) return c && console.error(l), void this.handleFork(e, r);
		if (n === kr) return c && console.error(l), void this.handleSpawn(e, r);
		if (n === wr) return c && console.error(l), void this.handleExec(e, r);
		if (n === _r) return c && console.error(l), void this.handleExecveat(e, r);
		if (n === vr) return c && console.error(l), void this.handleClone(e, r);
		if (n === Ar || n === Ir) return c && console.error(l), void this.handleExit(e, n, r);
		if (n === Er) return c && console.error(l), void this.handleWaitpid(e, r);
		if (n === xr) return c && console.error(l), void this.handleWaitid(e, r);
		if (n === ir) {
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
		if (n === Mr) return c && console.error(l), void this.handleThreadCancel(e, r);
		if (n === di || n === pi) return c && console.error(l), void this.handleWritev(e, n, r);
		if (n === fi || n === ui) return c && console.error(l), void this.handleReadv(e, n, r);
		if ((n === Dr || n === Nr) && r[2] > 65536) return void this.handleLargeWrite(e, n, r);
		if ((n === $r || n === Or) && r[2] > 65536) return void this.handleLargeRead(e, n, r);
		if (n === ri) return void this.handleSendmsg(e, r);
		if (n === ii) return void this.handleRecvmsg(e, r);
		if (n === Lr) {
			const t = r[1] >>> 0;
			if (35090 === t) return void this.handleIoctlIfconf(e, r);
			if (35088 === t) return void this.handleIoctlIfname(e, r);
			if (35111 === t) return void this.handleIoctlIfhwaddr(e, r);
			if (35093 === t) return void this.handleIoctlIfaddr(e, r);
			if (35123 === t) return void this.handleIoctlIfindex(e, r);
		}
		if (n === gi) {
			const t = r[1];
			if (5 === t || 6 === t || 7 === t || 12 === t || 13 === t || 14 === t || 36 === t || 37 === t || 38 === t) return void this.handleFcntlLock(e, r);
		}
		if (n === hr || n === dr) return void this.handleEpollCreate(e, n, r);
		if (n === fr) return void this.handleEpollCtl(e, r);
		if (n === lr || n === ur) return void this.handleEpollPwait(e, n, r);
		if (n === yi) return void this.handleIpcShmat(e, r);
		if (n === wi) return void this.handleIpcShmdt(e, r);
		if (n === mi) return void this.handleSemctl(e, r);
		if (n === ar) return void this.handlePselect6(e, r);
		if (n === cr) return void this.handleSelect(e, r);
		if (n === gr && (r[1] < 4 || r[1] % 4 != 0)) return void this.completeChannel(e, n, r, void 0, -1, Zn);
		const f = new DataView(this.kernelMemory.buffer, this.scratchOffset), u = [...r], p = on[n];
		let g = 0, m = !1;
		if (p) {
			const t = new Uint8Array(e.memory.buffer), i = this.getKernelMem(), s = this.scratchOffset + 72;
			for (const o of p) {
				const a = r[o.argIndex];
				if (n === Lr && r[1] >>> 0 == 21515 && 2 === o.argIndex) {
					const e = s + g;
					new DataView(this.kernelMemory.buffer).setInt32(e, r[2], !0), u[2] = e, g = g + 4 + 7 & -8;
					continue;
				}
				const c = n === gr && 2 === o.argIndex && "out" === o.direction;
				if (0 === a && !c) {
					if (!0 === o.required || "cstring" === o.size.type && !0 !== o.nullable) return void this.completeChannel(e, n, r, void 0, -1, Yn);
					continue;
				}
				let l;
				if ("cstring" === o.size.type) {
					const i = Jn(t, a, ee - g);
					if ("errno" in i) return void this.completeChannel(e, n, r, void 0, -1, i.errno);
					l = i.size;
				} else if ("arg" === o.size.type) l = r[o.size.argIndex] * (o.size.multiplier ?? 1) + (o.size.add ?? 0);
				else if ("deref" === o.size.type) {
					const i = r[o.size.argIndex];
					if (0 === i) continue;
					if (!Qn(t, i, 4)) return void this.completeChannel(e, n, r, void 0, -1, Yn);
					l = t[i] | t[i + 1] << 8 | t[i + 2] << 16 | t[i + 3] << 24;
				} else l = o.size.size;
				if (l <= 0) continue;
				if (g + l > 65536) {
					if (l = ee - g, l <= 0) continue;
					"arg" === o.size.type && (u[o.size.argIndex] = l);
				}
				if (!Qn(t, a, l)) {
					if (!c) return void this.completeChannel(e, n, r, void 0, -1, Yn);
					m = !0;
				}
				const h = s + g;
				"in" === o.direction || "inout" === o.direction ? i.set(t.subarray(a, a + l), h) : i.fill(0, h, h + l), u[o.argIndex] = h, g += l, g = g + 7 & -8;
			}
		}
		if (n === or) {
			const t = r[2];
			if (0 !== t) {
				const n = new DataView(e.memory.buffer, t), r = Number(n.getBigInt64(0, !0)), i = Number(n.getBigInt64(8, !0));
				u[2] = 1e3 * r + Math.floor(i / 1e6);
			} else u[2] = -1;
			const n = r[3];
			if (0 !== n) {
				const t = new DataView(e.memory.buffer, n);
				u[3] = 1, u[4] = t.getUint32(0, !0), u[5] = t.getUint32(4, !0);
			} else u[3] = 0, u[4] = 0, u[5] = 0;
		}
		!0 !== e.readinessFinalCheck || n !== sr && n !== or || (u[2] = 0, e.readinessFinalCheck = !1);
		let y = null;
		if (n === Br && r[1] >>> 0 > 0 && 1 & r[3] && !(32 & r[3]) && r[4] >= 0) {
			const t = this.prepareSharedMmapFromFile(e, r);
			if (this.hostReaped?.has(e.pid)) return;
			if ("error" === t.kind) return void this.completeChannel(e, n, r, void 0, -1, t.errno);
			y = t;
		}
		try {
			if (n === Fr) {
				const t = this.preflightFileSharedMremap(e.pid, r);
				if (0 !== t) return void this.completeChannel(e, n, r, void 0, -1, t);
			}
			try {
				if (n === Br && 16 & r[3]) {
					if (!this.ensureFixedMmapProcessMemoryCapacity(e, r)) return "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), void this.completeChannel(e, n, r, void 0, -1, 12);
					const t = this.flushSharedMappings(e, [r[0] >>> 0, hi(r[1] >>> 0)]);
					if (this.hostReaped?.has(e.pid)) return void ("prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null));
					if (!t) return "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), void this.completeChannel(e, n, r, void 0, -1, 5);
				}
				f.setUint32(4, n, !0);
				for (let e = 0; e < 6; e++) f.setBigInt64(8 + 8 * e, BigInt(u[e]), !0);
			} catch (Zi) {
				throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), Zi;
			}
			const t = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid;
			try {
				this.bindKernelTidForChannel(e);
			} catch (Zi) {
				throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), Zi;
			}
			const i = globalThis.__sysprof, s = i ? performance.now() : 0;
			if (i) {
				const t = globalThis;
				t.__sysprofGap || (t.__sysprofGap = /* @__PURE__ */ new Map()), t.__sysprofLastSeen || (t.__sysprofLastSeen = /* @__PURE__ */ new Map());
				const n = t.__sysprofLastSeen.get(e.pid);
				if (void 0 !== n) {
					const r = s - n;
					let i = t.__sysprofGap.get(e.pid);
					i || (i = {
						count: 0,
						gapTotalMs: 0,
						gapMaxMs: 0
					}, t.__sysprofGap.set(e.pid, i)), i.count++, i.gapTotalMs += r, r > i.gapMaxMs && (i.gapMaxMs = r);
				}
				t.__sysprofLastSeen.set(e.pid, s);
			}
			try {
				t(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (Zi) {
				"prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), c && console.error(l + " = KERNEL THROW"), console.error(`[handleSyscall] kernel threw for pid=${e.pid} syscall=${n} args=[${r}]:`, Zi), n === pr && this.signalWaitDeadlines.delete(`${e.pid}:${e.channelOffset}`), this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				if (this.currentHandlePid = 0, i) {
					const t = performance.now() - s, i = globalThis;
					i.__sysprofTable || (i.__sysprofTable = /* @__PURE__ */ new Map());
					const o = `${e.pid}:${n}`;
					let a = i.__sysprofTable.get(o);
					a || (a = {
						count: 0,
						totalMs: 0,
						maxMs: 0
					}, i.__sysprofTable.set(o, a)), a.count++, a.totalMs += t, t > a.maxMs && (a.maxMs = t), t > 50 && console.warn(`[sysprof] slow pid=${e.pid} nr=${n} ${t.toFixed(1)}ms args=[${r.join(",")}]`);
				}
			}
			if (this.getProcessExitSignal(e.pid) > 0) return "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), void this.handleProcessTerminated(e);
			let o = Number(f.getBigInt64(56, !0)), a = f.getUint32(64, !0);
			if (n !== pr || -1 === o && a === Xn || this.signalWaitDeadlines.delete(`${e.pid}:${e.channelOffset}`), n === gr && m && o >= 0 && (o = -1, a = Yn), n !== Br || "prepared" !== y?.kind || o > 0 && o >>> 0 != 4294967295 || (this.releasePreparedSharedMmap(y.context), y = null), n === Br && o > 0 && 16 & r[3]) {
				const t = [o >>> 0, hi(r[1] >>> 0)];
				this.cleanupSharedMappings(e.pid, t[0], t[1]);
			}
			if (n === Fr && o > 0 && (this.flushSharedMappings(e, [r[0] >>> 0, hi(r[1] >>> 0)]), this.hostReaped?.has(e.pid))) return;
			if (o > 0) try {
				this.ensureProcessMemoryCovers(e.pid, e.memory, n, o, r);
			} catch (Zi) {
				throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), Zi;
			}
			const h = this.highControlFloorForProcess(e.pid);
			if (n === Br && o > 0 && o >>> 0 != 4294967295) {
				const t = o >>> 0, n = r[1] >>> 0;
				null !== h && t + n > h && console.error(`[MMAP ALERT] pid=${e.pid} mmap returned 0x${t.toString(16)} len=${n} — OVERLAPS THREAD REGION! args=[${r.map((e) => "0x" + (e >>> 0).toString(16)).join(",")}]`);
			}
			if (n === Fr && o > 0 && o >>> 0 != 4294967295) {
				const t = o >>> 0, n = r[2] >>> 0;
				null !== h && t + n > h && console.error(`[MREMAP ALERT] pid=${e.pid} mremap returned 0x${t.toString(16)} len=${n} — OVERLAPS THREAD REGION!`);
			}
			if (null !== h && n === Hr && o > h && console.error(`[BRK ALERT] pid=${e.pid} brk returned 0x${(o >>> 0).toString(16)} — IN THREAD REGION!`), n === Br && o > 0 && o >>> 0 != 4294967295) {
				const t = r[4], n = r[3] >>> 0;
				if (1 & n && 32 & n) this.trackAnonymousSharedMapping(e, o >>> 0, r);
				else if (t >= 0 && !(32 & n)) {
					if (1 & n) {
						const t = "prepared" === y?.kind ? this.registerPreparedSharedMmap(e, o >>> 0, y.context) : "unsupported" === y?.kind ? y : this.mapSharedMmapFromFile(e, o >>> 0, r);
						if (y = null, this.hostReaped?.has(e.pid)) return;
						if ("unsupported" === t.kind) {
							if (this.populateMmapFromFile(e, o >>> 0, r), this.hostReaped?.has(e.pid)) return;
						} else if ("error" === t.kind) {
							try {
								if (this.runSyntheticMemorySyscall(e, Ur, [o >>> 0, hi(r[1] >>> 0)]), this.hostReaped?.has(e.pid)) return;
							} catch {}
							o = -1, a = t.errno;
						}
					} else if (this.populateMmapFromFile(e, o >>> 0, r), this.hostReaped?.has(e.pid)) return;
				}
				if (o > 0) {
					const t = o >>> 0, n = this.kernel.bos.findBindingByAddr(e.pid, t);
					void 0 !== n && this.kernel.bos.primeBindFromSab(e.pid, n, e.memory);
				}
			}
			if (n === Wr && 0 === o && (this.flushSharedMappings(e, r) || (o = -1, a = 5), this.hostReaped?.has(e.pid))) return;
			if (n === Ur && 0 === o) {
				const t = [r[0] >>> 0, hi(r[1] >>> 0)];
				if (this.flushSharedMappings(e, t), this.hostReaped?.has(e.pid)) return;
				this.cleanupSharedMappings(e.pid, t[0], t[1]);
			}
			if (n === Fr && o > 0 && this.remapSharedMapping(e.pid, r[0] >>> 0, o >>> 0, r[2] >>> 0), n === Rr && 0 === o && this.updateSharedMappingProtection(e.pid, r[0] >>> 0, hi(r[1] >>> 0), !!(2 & r[2])), (this.sharedMmapBackings?.size ?? 0) > 0 && (this.handleSharedMappingsAfterFileSyscall(e, n, r, o, a), this.hostReaped?.has(e.pid))) return;
			const d = n === _i && 0 === o;
			if (d && (this.drainMqueueNotification(), this.finishSignalTermination(e))) return;
			const g = this.dequeueSignalForDelivery(e, d);
			if (d && this.finishSignalTermination(e)) return;
			if (this.handlePendingInetConnect(e, n, r, o, a)) return;
			if (this.handleFlockConflict(e, n, r, o, a, g)) return;
			if (-1 === o && a === Xn) return c && console.error(l + " = -1 (EAGAIN, will retry)"), void this.handleBlockingRetry(e, n, r);
			if (this.handleSleepDelay(e, n, r, o, a)) return;
			0 !== a || n !== Cr && n !== Pr || this.recheckDeferredWaitpids(), 0 !== a || n !== mr && 204 !== n && n !== yr || (this.drainAndProcessWakeupEvents(), this.scheduleWakeBlockedRetries(), this.reapKilledProcessesAfterSyscall(), 204 === n ? (this.wakePendingSignalWaits(e.pid, r[1] >>> 0, r[0] >>> 0), this.interruptWaitingChildForDirectedSignal(e.pid, r[0]) || this.interruptWaitingChildrenForGeneratedSignal(r[1])) : this.interruptWaitingChildrenForGeneratedSignal(r[1])), c && console.error(l + this.formatSyscallReturn(n, o, a)), this.completeChannel(e, n, r, p, o, a);
		} catch (Zi) {
			throw "prepared" === y?.kind && (this.releasePreparedSharedMmap(y.context), y = null), Zi;
		}
	}
	dequeueSignalForDelivery(e, t = !1) {
		const n = this.resumePreparedSignals;
		if (n?.has(e)) {
			const t = new DataView(e.memory.buffer, e.channelOffset).getUint32(re, !0);
			if (t > 0) return t;
			n.delete(e);
		}
		const r = this.kernelInstance.exports.kernel_dequeue_signal;
		if (!r) return 0;
		t && this.bindKernelTidForChannel(e);
		const i = this.scratchOffset + ne, s = r(e.pid, this.toKernelPtr(i));
		if (s > 0) {
			const t = this.getKernelMem();
			return new Uint8Array(e.memory.buffer).set(t.subarray(i, i + 44), e.channelOffset + ne), s;
		}
		{
			const t = e.channelOffset + ne;
			return new Uint8Array(e.memory.buffer, t, 48).fill(0), 0;
		}
	}
	completeChannel(e, t, n, r, i, s) {
		const o = {
			kind: "marshalled",
			outputWrites: this.snapshotChannelOutput(e, t, n, r, i),
			retVal: i,
			errVal: s,
			materialized: !1,
			relistenRequested: !0
		};
		this.materializePreparedChannelCompletion(e, o), this.clearSocketTimeout(e), this.clearReadinessWait(e), this.drainAllPtyOutputs(), this.flushTcpSendPipes(e.pid), this.drainAndProcessWakeupEvents(), this.publishOrParkChannelCompletion(e, o);
	}
	snapshotChannelOutput(e, t, n, r, i) {
		if (!r) return [];
		const s = [], o = new Uint8Array(e.memory.buffer), a = this.getKernelMem(), c = this.scratchOffset + 72;
		let l = 0;
		for (const h of r) {
			const r = n[h.argIndex];
			if (t === Lr && n[1] >>> 0 == 21515 && 2 === h.argIndex) continue;
			if (0 === r) continue;
			let d;
			if ("cstring" === h.size.type) {
				let e = 0;
				for (; e < 65536 - l - 1 && 0 !== o[r + e];) e++;
				d = e + 1;
			} else if ("arg" === h.size.type) d = n[h.size.argIndex] * (h.size.multiplier ?? 1) + (h.size.add ?? 0);
			else if ("deref" === h.size.type) {
				const e = n[h.size.argIndex];
				if (0 === e) continue;
				d = o[e] | o[e + 1] << 8 | o[e + 2] << 16 | o[e + 3] << 24;
			} else d = h.size.size;
			if (d <= 0) continue;
			if (l + d > 65536 && (d = ee - l, d <= 0)) continue;
			const f = c + l;
			if (!("out" !== h.direction && "inout" !== h.direction || "out" === h.direction && i < 0)) {
				let n = d;
				if ("out" === h.direction && "arg" === h.size.type) {
					const e = h.copyRetvalAdd ?? 0;
					0 === i ? n = Math.min(e, d) : i + e < d && (n = i + e);
				}
				let o = new Uint8Array(n);
				o.set(a.subarray(f, f + n)), t === pr && 1 === h.argIndex && 8 === this.getPtrWidth(e.pid) && n >= 32 && (o.copyWithin(16, 12, 24), o.fill(0, 12, 16)), s.push({
					ptr: r,
					bytes: o
				});
			}
			l += d, l = l + 7 & -8;
		}
		return s;
	}
	publishOrParkChannelCompletion(e, t) {
		if (this.stoppedPids?.has(e.pid) && this.isRegisteredChannel(e)) {
			const n = this.parkedChannelCompletions ??= /* @__PURE__ */ new Map(), r = n.get(e);
			r ? r.relistenRequested ||= t.relistenRequested : (this.materializePreparedChannelCompletion(e, t), e.handling = !0, this.deferredStoppedChannels?.delete(e), n.set(e, {
				prepared: t,
				relistenRequested: t.relistenRequested
			}));
			return;
		}
		this.publishPreparedChannelCompletion(e, t);
	}
	publishPreparedChannelCompletion(e, t) {
		this.materializePreparedChannelCompletion(e, t), e.handling = !1;
		const n = new DataView(e.memory.buffer, e.channelOffset);
		n.setBigInt64(56, BigInt(t.retVal), !0), n.setUint32(64, t.errVal, !0), this.resumePreparedSignals?.delete(e), this.pendingCancels?.delete(e);
		const r = new Int32Array(e.memory.buffer, e.channelOffset);
		Atomics.store(r, 0, 2), Atomics.notify(r, 0, 1), t.relistenRequested && this.isRegisteredChannel(e) && this.relistenChannel(e);
	}
	materializePreparedChannelCompletion(e, t) {
		if (t.materialized) return;
		const n = new Uint8Array(e.memory.buffer);
		for (const r of t.outputWrites) n.set(r.bytes, r.ptr);
		t.outputWrites = [];
		try {
			this.synchronizeSharedMemoryForBoundary(e);
		} catch (Zi) {
			console.error(`[completeChannel] shared-memory synchronization failed for pid=${e.pid}:`, Zi), t.retVal = -5, t.errVal = 5;
		}
		t.materialized = !0;
	}
	deferChannelWhileStopped(e) {
		return !!this.stoppedPids?.has(e.pid) && (!this.isRegisteredChannel(e) || (this.parkedChannelCompletions?.has(e) || (this.deferredStoppedChannels ??= /* @__PURE__ */ new Map()).set(e, !0), e.handling = !0, !0));
	}
	resumeStoppedProcess(e) {
		const t = this.kernelInstance.exports.kernel_get_process_state, n = t(e);
		if (0 !== n) return 1 !== n && this.discardStoppedChannelStateForProcess(e), !1;
		const r = this.processes.get(e);
		if (!r || 0 === r.channels.length) return (this.pendingResumePids ??= /* @__PURE__ */ new Set()).add(e), (this.stoppedPids ??= /* @__PURE__ */ new Set()).add(e), !0;
		this.pendingResumePids?.delete(e);
		const i = this.parkedChannelCompletions ??= /* @__PURE__ */ new Map(), s = this.deferredStoppedChannels ??= /* @__PURE__ */ new Map(), o = this.resumePreparedSignals ??= /* @__PURE__ */ new WeakSet(), a = [];
		(this.stoppedPids ??= /* @__PURE__ */ new Set()).add(e);
		for (const u of Array.from(r.channels)) {
			if (!this.isRegisteredChannel(u)) continue;
			let n = new DataView(u.memory.buffer, u.channelOffset).getUint32(re, !0);
			if (n > 0 ? o.add(u) : (o.delete(u), n = this.dequeueSignalForDelivery(u, !0), n > 0 && o.add(u)), this.finishSignalTermination(u)) return !1;
			const r = t(e);
			if (1 === r) return this.stoppedPids.add(e), !1;
			if (0 !== r) return this.discardStoppedChannelStateForProcess(e), !1;
			n > 0 && a.push(u);
		}
		for (const u of a) {
			if (i.has(u)) continue;
			if (this.interruptStoppedChannelWithPreparedSignal(u), this.finishSignalTermination(u)) return !1;
			const n = t(e);
			if (1 === n) return !1;
			if (0 !== n) return this.discardStoppedChannelStateForProcess(e), !1;
		}
		if (0 !== t(e)) return !1;
		this.stoppedPids.delete(e);
		const c = this.deferredProcessWorkerStarts.get(e);
		if (c) {
			this.deferredProcessWorkerStarts.delete(e);
			const t = Array.from(c);
			for (let n = 0; n < t.length; n++) {
				const r = t[n], i = this.processes.get(e);
				if (i && i.memory === r.expectedMemory) try {
					r.start();
				} catch (f) {
					if (r.cancel(), console.error(`[kernel-worker] deferred Worker launch failed for pid=${e}:`, f), !0 === r.onStartError?.(f)) continue;
					for (const e of t.slice(n + 1)) try {
						e.cancel();
					} catch {}
					return this.notifyHostProcessCrashed(e), this.callbacks.onExit && this.callbacks.onExit(e, 139), !1;
				}
				else r.cancel();
			}
		}
		const l = Array.from(i.entries()).filter(([t]) => t.pid === e);
		for (const [u, p] of l) {
			if (i.get(u) !== p) continue;
			if (!this.isRegisteredChannel(u)) {
				i.delete(u), s.delete(u);
				continue;
			}
			const n = t(e);
			if (1 === n) return this.stoppedPids.add(e), !1;
			if (0 !== n) return this.discardStoppedChannelStateForProcess(e), !1;
			i.delete(u), s.delete(u), p.prepared.relistenRequested ||= p.relistenRequested, this.publishPreparedChannelCompletion(u, p.prepared);
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
		const n = this.pendingSleeps.get(e);
		if (n) return clearTimeout(n.timer), this.pendingSleeps.delete(e), this.completeSleepWithSignalCheck(n.channel, n.syscallNr, n.origArgs, n.retVal, n.errVal), !0;
		const r = this.pendingFutexWaits.get(e);
		if (r) return r.interrupt ? r.interrupt(-4, 4) : Atomics.notify(new Int32Array(e.memory.buffer), r.futexIndex, 1), !0;
		let i = this.pendingPollRetries.has(e) || (this.pendingAdvisoryLockRetries?.has(e) ?? !1) || this.pendingSelectRetries.has(e);
		for (const s of this.pendingPipeReaders.values()) if (s.some((t) => t.channel === e)) {
			i = !0;
			break;
		}
		if (!i) {
			for (const s of this.pendingPipeWriters.values()) if (s.some((t) => t.channel === e)) {
				i = !0;
				break;
			}
		}
		return !!i && (this.cancelParkedFifoOpen(e), this.removePendingPipeReader(e), this.removePendingPipeWriter(e), this.completeChannelRaw(e, -4, 4), this.relistenChannel(e), !0);
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
		if (t !== bi && t !== ki) return !1;
		try {
			return 0 === this.runSyntheticMemorySyscall(e, Mr, [this.guestTidForChannel(e)]).errVal;
		} catch {
			return !1;
		}
	}
	interruptPendingFifoOpenCancellation(e, t) {
		return (t === bi || t === ki) && !!this.pendingCancels.has(e) && !!this.cancelParkedFifoOpen(e) && (this.pendingCancels.delete(e), this.completeChannelRaw(e, -4, 4), this.relistenChannel(e), !0);
	}
	failDeferredCloneLaunch(e, t, n) {
		for (const [r, i] of this.parkedChannelCompletions ?? []) {
			if (r.pid !== e || i.prepared.retVal !== t) continue;
			const s = new DataView(r.memory.buffer, r.channelOffset);
			if (s.getUint32(4, !0) !== vr) continue;
			const o = Number(s.getBigInt64(8, !0)), a = Number(s.getBigInt64(24, !0));
			return 1048576 & o && Qn(new Uint8Array(r.memory.buffer), a, 4) && new DataView(r.memory.buffer).setInt32(a, 0, !0), i.prepared.outputWrites = [], i.prepared.retVal = -1, i.prepared.errVal = n, !0;
		}
		return !1;
	}
	discardStoppedChannelStateForProcess(e, t = !0) {
		const n = this.deferredProcessWorkerStarts?.get(e);
		if (n) {
			this.deferredProcessWorkerStarts.delete(e);
			for (const e of n) try {
				e.cancel();
			} catch {}
		}
		for (const r of Array.from(this.parkedChannelCompletions?.keys() ?? [])) r.pid === e && this.parkedChannelCompletions.delete(r);
		for (const r of Array.from(this.deferredStoppedChannels?.keys() ?? [])) r.pid === e && this.deferredStoppedChannels.delete(r);
		t && this.stoppedPids?.delete(e), t && this.pendingResumePids?.delete(e);
	}
	discardStoppedChannelState(e) {
		this.parkedChannelCompletions?.delete(e), this.deferredStoppedChannels?.delete(e);
	}
	killAllBlockedForTeardown() {
		for (const n of this.pendingPollRetries.values()) n.timer && clearTimeout(n.timer);
		for (const n of this.pendingAdvisoryLockRetries?.values() ?? []) clearTimeout(n.timer);
		for (const n of this.pendingSelectRetries.values()) n.timer && clearTimeout(n.timer);
		for (const n of this.pendingSleeps.values()) clearTimeout(n.timer);
		for (const n of this.pendingSignalWaits.values()) clearTimeout(n.timer);
		this.pendingPipeReaders.clear(), this.pendingPipeWriters.clear(), this.pendingPollRetries.clear(), this.pendingAdvisoryLockRetries?.clear(), this.pendingSelectRetries.clear(), this.pendingSleeps.clear(), this.pendingSignalWaits.clear(), this.signalWaitDeadlines.clear(), this.pendingFutexWaits.clear();
		const e = /* @__PURE__ */ new Set(), t = this.kernelInstance?.exports.kernel_get_process_exit_status;
		for (const n of this.processes.values()) if (!t || -1 === t(n.pid)) for (const t of n.channels) {
			let n;
			try {
				const e = new Int32Array(t.memory.buffer, t.channelOffset);
				n = Atomics.load(e, 0);
			} catch {
				continue;
			}
			if (1 === n) try {
				this.wakeChannelForTeardownExit(t), e.add(t.pid);
			} catch (Zi) {
				console.error(`[killAllBlockedForTeardown] wake failed for pid=${t.pid} off=${t.channelOffset}: ${Zi}`);
			}
		}
		return e;
	}
	wakeChannelForTeardownExit(e) {
		const t = new DataView(e.memory.buffer, e.channelOffset);
		t.setUint32(re, 9, !0), t.setUint32(65564, 0, !0);
		const n = t.getUint32(4, !0), r = [];
		for (let i = 0; i < 6; i++) r.push(Number(t.getBigInt64(8 + 8 * i, !0)));
		this.completeChannel(e, n, r, on[n], -1, 4);
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
	completeChannelRaw(e, t, n) {
		this.clearSocketTimeout(e), this.clearReadinessWait(e), this.pendingCancels.delete(e);
		const r = {
			kind: "raw",
			outputWrites: [],
			retVal: t,
			errVal: n,
			materialized: !1,
			relistenRequested: !1
		};
		this.materializePreparedChannelCompletion(e, r), this.drainAndProcessWakeupEvents(), this.publishOrParkChannelCompletion(e, r);
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
		for (const [n, r] of t) this.pendingPollRetries.get(n) === r && (null !== r.timer && clearTimeout(r.timer), this.pendingPollRetries.delete(n), this.isRegisteredChannel(r.channel) && this.retrySyscall(r.channel));
	}
	wakeBlockedPoll(e, t) {
		const n = Array.from(this.pendingPollRetries.entries()).filter(([, n]) => n.channel.pid === e && n.pipeIndices.includes(t));
		for (const [r, i] of n) this.pendingPollRetries.get(r) === i && (null !== i.timer && clearTimeout(i.timer), this.pendingPollRetries.delete(r), this.isRegisteredChannel(i.channel) && this.retrySyscall(i.channel));
	}
	notifyPipeReadable(e, t) {
		const n = this.pendingPipeReaders.get(e);
		if (n && n.length > 0) {
			this.pendingPipeReaders.delete(e);
			for (const e of n) this.isRegisteredChannel(e.channel) && this.retrySyscall(e.channel);
		}
		const r = Array.from(this.pendingPollRetries.entries()).filter(([, n]) => (void 0 === t || n.channel.pid === t) && n.pipeIndices.includes(e));
		for (const [i, s] of r) this.pendingPollRetries.get(i) === s && (null !== s.timer && clearTimeout(s.timer), this.pendingPollRetries.delete(i), this.isRegisteredChannel(s.channel) && this.retrySyscall(s.channel));
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
		for (const [t, n] of this.pendingPollRetries) n.channel.pid === e && (n.timer && clearTimeout(n.timer), this.pendingPollRetries.delete(t));
	}
	cleanupPendingSelectRetries(e) {
		for (const [t, n] of this.pendingSelectRetries) n.channel.pid === e && (null !== n.timer && (clearTimeout(n.timer), clearImmediate(n.timer)), this.pendingSelectRetries.delete(t));
	}
	drainAndProcessWakeupEvents() {
		const e = this.kernelInstance.exports.kernel_drain_wakeup_events;
		if (!e) return;
		const t = [];
		for (;;) {
			const n = e(this.toKernelPtr(this.scratchOffset), 1280, 256);
			if (n <= 0) break;
			const r = new Uint8Array(this.kernelMemory.buffer);
			for (let e = 0; e < n; e++) {
				const n = this.scratchOffset + 5 * e;
				t.push({
					wakeIdx: (r[n] | r[n + 1] << 8 | r[n + 2] << 16 | r[n + 3] << 24) >>> 0,
					wakeType: r[n + 4]
				});
			}
			if (n < 256) break;
		}
		if (0 === t.length) return;
		let n = !1, r = !1, i = !1;
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
			4 & o && this.wakeBlockedAccept(s), 8 & o && (r = !0), 64 & o && (i = !0), 15 & o && (n = !0);
		}
		r && this.wakeBlockedFallbackWriters(), i && this.wakeBlockedAdvisoryLockRetries(), n && (this.anyPendingRetryNeedsSignalSafeWake() ? this.scheduleWakeBlockedRetriesDeferred() : this.scheduleWakeBlockedRetries());
	}
	wakeBlockedAdvisoryLockRetries() {
		const e = this.pendingAdvisoryLockRetries;
		if (!e || 0 === e.size) return;
		const t = Array.from(e.entries());
		for (const [n, r] of t) e.get(n) === r && (clearTimeout(r.timer), e.delete(n), this.isRegisteredChannel(r.channel) && this.retrySyscall(r.channel));
	}
	notifyParentOfChildStateTransition(e) {
		const t = this.getParentPid(e);
		if (void 0 === t) return;
		1 !== (0, this.kernelInstance.exports.kernel_has_sa_nocldstop)(t) ? this.sendSignalToProcess(t, 17) : this.wakeWaitingParent(t);
	}
	wakeBlockedFallbackWriters() {
		const e = Array.from(this.pendingPollRetries.entries()).filter(([, e]) => e.isWriteRetry);
		for (const [t, n] of e) this.pendingPollRetries.get(t) === n && (this.pendingPollRetries.delete(t), null !== n.timer && clearTimeout(n.timer), this.isRegisteredChannel(n.channel) && this.retrySyscall(n.channel));
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
		for (const [n, r] of this.pendingPollRetries) {
			if (!r.needsSignalSafeWake) continue;
			null !== r.timer && clearTimeout(r.timer);
			const i = r.deadline && r.deadline > 0 ? Math.max(1, r.deadline - t) : e;
			r.timer = setTimeout(() => {
				this.pendingPollRetries.get(n) === r && (this.pendingPollRetries.delete(n), this.isRegisteredChannel(r.channel) && this.retrySyscall(r.channel));
			}, Math.max(1, Math.min(e, i)));
		}
	}
	postponeSignalSafeSelectRetries(e) {
		const t = Date.now();
		for (const [n, r] of this.pendingSelectRetries) {
			if (!r.needsSignalSafeWake) continue;
			null !== r.timer && (clearTimeout(r.timer), clearImmediate(r.timer));
			const i = r.deadline > 0 ? Math.max(1, r.deadline - t) : e;
			r.timer = setTimeout(() => {
				this.pendingSelectRetries.get(n) === r && (this.pendingSelectRetries.delete(n), this.isRegisteredChannel(r.channel) && (r.syscallNr === cr ? this.handleSelect(r.channel, r.origArgs) : this.handlePselect6(r.channel, r.origArgs)));
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
		for (const [n, r] of e) this.isRegisteredChannel(r.channel) && (null !== r.timer && clearTimeout(r.timer), this.retrySyscall(r.channel));
		for (const [, n] of t) this.isRegisteredChannel(n.channel) && (clearTimeout(n.timer), clearImmediate(n.timer), n.syscallNr === cr ? this.handleSelect(n.channel, n.origArgs) : this.handlePselect6(n.channel, n.origArgs));
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
	getReadinessDeadline(e, t) {
		return t <= 0 ? -1 : (void 0 === e.readinessDeadline && (e.readinessDeadline = Date.now() + t), e.readinessDeadline);
	}
	clearReadinessWait(e) {
		e.readinessDeadline = void 0, e.readinessFinalCheck = void 0;
		const t = this.pendingPollRetries.get(e);
		t && (null !== t.timer && clearTimeout(t.timer), this.pendingPollRetries.delete(e));
		const n = this.pendingAdvisoryLockRetries?.get(e);
		n && (clearTimeout(n.timer), this.pendingAdvisoryLockRetries.delete(e));
		const r = this.pendingSelectRetries.get(e);
		r && (null !== r.timer && (clearTimeout(r.timer), clearImmediate(r.timer)), this.pendingSelectRetries.delete(e));
	}
	removePendingPipeReader(e) {
		if (this.pendingPipeReaders) for (const [t, n] of this.pendingPipeReaders) {
			const r = n.filter((t) => t.channel !== e);
			0 === r.length ? this.pendingPipeReaders.delete(t) : r.length !== n.length && this.pendingPipeReaders.set(t, r);
		}
	}
	removePendingPipeWriter(e) {
		if (this.pendingPipeWriters) for (const [t, n] of this.pendingPipeWriters) {
			const r = n.filter((t) => t.channel !== e);
			0 === r.length ? this.pendingPipeWriters.delete(t) : r.length !== n.length && this.pendingPipeWriters.set(t, r);
		}
	}
	handleThreadCancel(e, t) {
		const n = t[0], r = this.processes.get(e.pid);
		if (this.runSyntheticMemorySyscall(e, Mr, [n]), this.completeChannelRaw(e, 0, 0), this.relistenChannel(e), !r) return;
		let i;
		for (const d of r.channels) {
			const t = this.channelTids.get(`${e.pid}:${d.channelOffset}`);
			if ((void 0 !== t ? t : e.pid) === n) {
				i = d;
				break;
			}
		}
		if (!i) return;
		this.pendingCancels.add(i);
		const s = this.pendingFutexWaits.get(i);
		if (s) {
			if (s.interrupt) s.interrupt(-4, 4);
			else {
				const e = new Int32Array(i.memory.buffer);
				Atomics.notify(e, s.futexIndex, 1);
			}
			return;
		}
		const o = this.pendingPollRetries.get(i);
		if (o) return null !== o.timer && clearTimeout(o.timer), this.pendingPollRetries.delete(i), this.completeChannelRaw(i, -4, 4), void this.relistenChannel(i);
		const a = this.pendingAdvisoryLockRetries?.get(i);
		if (a) return clearTimeout(a.timer), this.pendingAdvisoryLockRetries.delete(i), this.completeChannelRaw(i, -4, 4), void this.relistenChannel(i);
		const c = this.pendingSelectRetries.get(i);
		if (c) return clearTimeout(c.timer), clearImmediate(c.timer), this.pendingSelectRetries.delete(i), this.completeChannelRaw(i, -4, 4), void this.relistenChannel(i);
		let l = !1;
		for (const [d, f] of this.pendingPipeReaders) {
			const e = f.filter((e) => e.channel !== i);
			e.length !== f.length && (0 === e.length ? this.pendingPipeReaders.delete(d) : this.pendingPipeReaders.set(d, e), l = !0);
		}
		for (const [d, f] of this.pendingPipeWriters) {
			const e = f.filter((e) => e.channel !== i);
			e.length !== f.length && (0 === e.length ? this.pendingPipeWriters.delete(d) : this.pendingPipeWriters.set(d, e), l = !0);
		}
		if (l) return this.clearSocketTimeout(i), this.completeChannelRaw(i, -4, 4), void this.relistenChannel(i);
		const h = this.waitingForChild.findIndex((e) => e.channel === i);
		h >= 0 && (this.waitingForChild.splice(h, 1), this.completeChannelRaw(i, -4, 4), this.relistenChannel(i));
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
	handlePendingInetConnect(e, t, n, r, i) {
		if (t !== ai || -1 !== r || 115 !== i && 114 !== i) return !1;
		const s = n[1], o = n[2];
		if (!Number.isSafeInteger(s) || s <= 0 || o < 2 || s + 2 > e.memory.buffer.byteLength) return !1;
		if (2 !== new DataView(e.memory.buffer).getUint16(s, !0)) return !1;
		const a = this.kernelInstance.exports.kernel_is_fd_nonblock;
		return 1 === a?.(e.pid, n[0]) ? this.completeChannel(e, t, n, on[t], -1, i) : this.handleBlockingRetry(e, t, n), !0;
	}
	parkAdvisoryLockRetry(e, t = gi) {
		if (!this.isRegisteredChannel(e)) return;
		const n = this.pendingAdvisoryLockRetries ??= /* @__PURE__ */ new Map(), r = n.get(e);
		r && clearTimeout(r.timer);
		const i = setTimeout(() => {
			const t = n.get(e);
			t && t.timer === i && (n.delete(e), this.isAsyncChannelProcessActive(e) && this.retrySyscall(e));
		}, 10);
		if (n.set(e, {
			timer: i,
			channel: e
		}), Ii) {
			const e = this.profileData.get(t);
			e && e.retries++;
		}
	}
	handleFlockConflict(e, t, n, r, i, s) {
		return t === Ai && -1 === r && i === Xn && (4 & n[1] ? this.completeChannel(e, t, n, void 0, r, i) : s > 0 ? this.completeChannel(e, t, n, void 0, -1, 4) : this.parkAdvisoryLockRetry(e, t), !0);
	}
	handleBlockingRetry(e, t, n) {
		if (!this.isRegisteredChannel(e)) return;
		if (this.interruptPendingFifoOpenCancellation(e, t)) return;
		if (t === ir && !(127 & n[1])) {
			const t = n[0], r = n[2], i = new Int32Array(e.memory.buffer), s = t >>> 2;
			if (Atomics.load(i, s) !== r) return void this.retrySyscall(e);
			const o = Atomics.waitAsync(i, s, r);
			o.async ? o.value.then(() => {
				this.isRegisteredChannel(e) && this.retrySyscall(e);
			}) : setImmediate(() => this.retrySyscall(e));
			return;
		}
		if (t === sr || t === or) {
			let r = -1;
			const i = t === or && 0 !== n[3];
			if (t === sr) r = n[2];
			else {
				const t = n[2];
				if (0 !== t) {
					const n = new DataView(e.memory.buffer, t), i = Number(n.getBigInt64(0, !0)), s = Number(n.getBigInt64(8, !0));
					r = 1e3 * i + Math.floor(s / 1e6);
				}
			}
			if (0 === r) return void this.completeChannel(e, t, n, on[t], 0, 0);
			const s = this.getReadinessDeadline(e, r);
			if (s > 0 && Date.now() >= s) return e.readinessFinalCheck = !0, void this.retrySyscall(e);
			const { pipeIndices: o, acceptIndices: a } = this.resolvePollReadinessIndices(e.pid, n), c = n[1];
			if (r > 0 && 0 === c) {
				const t = Math.max(s - Date.now(), 1), n = setTimeout(() => {
					this.pendingPollRetries.get(e)?.timer === n && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && (e.readinessFinalCheck = !0, this.retrySyscall(e)));
				}, t);
				this.pendingPollRetries.set(e, {
					timer: n,
					channel: e,
					pipeIndices: o,
					acceptIndices: a,
					needsSignalSafeWake: i,
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
				needsSignalSafeWake: i,
				deadline: s
			});
			return;
		}
		if (t === pr) {
			const r = n[2];
			if (0 === r) {
				const t = `${e.pid}:${e.channelOffset}`, r = this.pendingSignalWaits.get(t);
				r && clearTimeout(r.timer);
				const i = setTimeout(() => {
					this.pendingSignalWaits.delete(t), this.isRegisteredChannel(e) && this.retrySyscall(e);
				}, 500);
				this.pendingSignalWaits.set(t, {
					timer: i,
					channel: e,
					origArgs: n
				});
				return;
			}
			const i = new DataView(e.memory.buffer, r), s = Number(i.getBigInt64(0, !0)), o = Number(i.getBigInt64(8, !0)), a = 1e3 * s + Math.floor(o / 1e6), c = 11, l = `${e.pid}:${e.channelOffset}`;
			if (a <= 0) this.signalWaitDeadlines.delete(l), this.completeChannel(e, t, n, on[t], -1, c);
			else {
				const r = this.signalWaitDeadlines.get(l), i = r?.deadline ?? performance.now() + a;
				r || this.signalWaitDeadlines.set(l, {
					pid: e.pid,
					deadline: i
				});
				const s = i - performance.now();
				if (s <= 0) return this.signalWaitDeadlines.delete(l), void this.completeChannel(e, t, n, on[t], -1, c);
				const o = this.pendingSignalWaits.get(l);
				o && clearTimeout(o.timer);
				const h = setTimeout(() => {
					this.pendingSignalWaits.delete(l), this.signalWaitDeadlines.delete(l), this.isRegisteredChannel(e) && this.completeChannel(e, t, n, on[t], -1, c);
				}, s);
				this.pendingSignalWaits.set(l, {
					timer: h,
					channel: e,
					origArgs: n
				});
			}
			return;
		}
		if (function(e, t) {
			let n;
			switch (e) {
				case Qr:
				case ei:
				case ti:
				case ni:
					n = t[3];
					break;
				case ri:
				case ii:
					n = t[2];
					break;
				default: return !1;
			}
			return void 0 !== n && !!(64 & n);
		}(t, n)) return void this.completeChannel(e, t, n, on[t], -1, Xn);
		if (Ci.has(t) || Pi.has(t) || t === si || t === oi || t === ai) {
			const r = n[0], i = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (i && 1 === i(e.pid, r)) return void this.completeChannel(e, t, n, on[t], -1, Xn);
		}
		if (t === _i || t === Si) {
			const r = n[0], i = this.kernelInstance.exports.kernel_is_fd_nonblock;
			if (i && 1 === i(e.pid, r)) return void this.completeChannel(e, t, n, on[t], -1, Xn);
		}
		if (Ci.has(t) || Pi.has(t)) {
			const r = n[0], i = this.kernelInstance.exports.kernel_get_socket_timeout_ms;
			if (i && !this.socketTimeoutTimers.has(e)) {
				const s = Ci.has(t) ? 1 : 0, o = Number(i(e.pid, r, s));
				if (o > 0) {
					const r = setTimeout(() => {
						this.socketTimeoutTimers.get(e) === r && (this.socketTimeoutTimers.delete(e), this.removePendingPipeReader(e), this.isRegisteredChannel(e) && this.completeChannel(e, t, n, on[t], -1, 110));
					}, o);
					this.socketTimeoutTimers.set(e, r);
				}
			}
		}
		if (Ci.has(t)) {
			const r = n[0], i = this.kernelInstance.exports.kernel_get_fd_pipe_idx;
			if (i) {
				const n = i(e.pid, r);
				if (n >= 0) {
					let r = this.pendingPipeReaders.get(n);
					if (r || (r = [], this.pendingPipeReaders.set(n, r)), r.some((t) => t.channel === e) || r.push({
						channel: e,
						pid: e.pid
					}), Ii) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (Pi.has(t)) {
			const r = n[0], i = this.kernelInstance.exports.kernel_get_fd_send_pipe_idx;
			if (i) {
				const n = i(e.pid, r);
				if (n >= 0) {
					let r = this.pendingPipeWriters.get(n);
					if (r || (r = [], this.pendingPipeWriters.set(n, r)), r.some((t) => t.channel === e) || r.push({
						channel: e,
						pid: e.pid
					}), Ii) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (t === si || t === oi) {
			const r = n[0], i = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx;
			if (i) {
				const n = i(e.pid, r);
				if (n >= 0) {
					const r = setTimeout(() => {
						const t = this.pendingPollRetries.get(e);
						t && t.timer === r && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && this.retrySyscall(e));
					}, 10);
					if (this.pendingPollRetries.set(e, {
						timer: r,
						channel: e,
						pipeIndices: [],
						acceptIndices: [n]
					}), Ii) {
						const e = this.profileData.get(t);
						e && e.retries++;
					}
					return;
				}
			}
		}
		if (Ii) {
			const e = this.profileData.get(t);
			e && e.retries++;
		}
		const r = setTimeout(() => {
			const t = this.pendingPollRetries.get(e);
			t && t.timer === r && (this.pendingPollRetries.delete(e), this.isAsyncChannelProcessActive(e) && this.retrySyscall(e));
		}, 10);
		this.pendingPollRetries.set(e, {
			timer: r,
			channel: e,
			pipeIndices: [],
			isWriteRetry: Pi.has(t)
		});
	}
	retrySyscall(e) {
		if (this.isRegisteredChannel(e) && !this.deferChannelWhileStopped(e)) return this.getProcessExitSignal(e.pid) > 0 ? (this.signalWaitDeadlines.delete(`${e.pid}:${e.channelOffset}`), void this.handleProcessTerminated(e)) : void this.handleSyscall(e);
	}
	handleSleepDelay(e, t, n, r, i) {
		let s = 0;
		if (t === tr && r >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), n = e.getUint32(80, !0);
			s = 1e3 * t + Math.floor(n / 1e6);
		} else if (t === nr && r >= 0) {
			const e = n[0] >>> 0;
			s = Math.max(1, Math.floor(e / 1e3));
		} else if (t === rr && r >= 0) {
			const e = new DataView(this.kernelMemory.buffer, this.scratchOffset), t = e.getUint32(72, !0), n = e.getUint32(80, !0);
			s = 1e3 * t + Math.floor(n / 1e6);
		}
		if (s > 0) {
			const o = setTimeout(() => {
				const s = this.pendingSleeps.get(e);
				s?.timer === o && s.channel === e && (this.pendingSleeps.delete(e), this.isRegisteredChannel(e) && this.completeSleepWithSignalCheck(e, t, n, r, i));
			}, s);
			return this.pendingSleeps.set(e, {
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
		this.dequeueSignalForDelivery(e, !0), this.finishSignalTermination(e) || (new DataView(e.memory.buffer, e.channelOffset).getUint32(65560, !0) > 0 ? this.completeChannel(e, t, n, on[t], -1, 4) : this.completeChannel(e, t, n, on[t], r, i));
	}
	handleFcntlLock(e, t) {
		const n = t[2], r = new Uint8Array(e.memory.buffer);
		if (!Number.isSafeInteger(n) || n <= 0 || n > r.byteLength - 32) return void this.completeChannel(e, gi, t, void 0, -1, Yn);
		const i = this.getKernelMem(), s = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72;
		i.set(r.subarray(n, n + 32), o), s.setUint32(4, gi, !0), s.setBigInt64(8, BigInt(t[0]), !0), s.setBigInt64(16, BigInt(t[1]), !0), s.setBigInt64(24, BigInt(o), !0);
		for (let f = 3; f < 6; f++) s.setBigInt64(8 + 8 * f, BigInt(t[f]), !0);
		const a = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			a(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const c = Number(s.getBigInt64(56, !0)), l = s.getUint32(64, !0), h = this.dequeueSignalForDelivery(e);
		if (this.finishSignalTermination(e)) return;
		c >= 0 && new Uint8Array(e.memory.buffer).set(i.subarray(o, o + 32), n);
		const d = t[1];
		if (-1 === c && l === Xn && (7 === d || 14 === d || 38 === d)) return h > 0 ? void this.completeChannel(e, gi, t, void 0, -1, 4) : void this.parkAdvisoryLockRetry(e);
		this.completeChannel(e, gi, t, void 0, c, l);
	}
	completeSelectSignalOutcome(e, t, n, r) {
		const i = this.dequeueSignalForDelivery(e, !0);
		return !!this.finishSignalTermination(e) || !!(r && i > 0) && (this.completeChannel(e, t, n, void 0, -1, 4), !0);
	}
	handleSelect(e, t) {
		if (this.deferChannelWhileStopped(e)) return;
		const n = 128, r = t[0], i = t[1], s = t[2], o = t[3], a = t[4];
		let c = -1;
		if (0 !== a) {
			const t = this.getPtrWidth(e.pid), n = new DataView(e.memory.buffer, a);
			let r, i;
			8 === t ? (r = Number(n.getBigInt64(0, !0)), i = Number(n.getBigInt64(8, !0))) : (r = n.getInt32(0, !0), i = n.getInt32(4, !0)), c = 1e3 * r + Math.floor(i / 1e3), c < 0 && (c = 0);
		}
		const l = !0 === e.readinessFinalCheck;
		e.readinessFinalCheck = !1;
		const h = l ? 0 : c, d = this.getReadinessDeadline(e, c);
		if (0 === r && 0 === i && 0 === s && 0 === o) {
			if (this.completeSelectSignalOutcome(e, cr, t, !0)) return;
			if (0 === h) return void this.completeChannel(e, cr, t, void 0, 0, 0);
			const n = c > 0, r = n ? Math.max(d - Date.now(), 1) : -1, i = n ? setTimeout(() => {
				this.pendingSelectRetries.get(e)?.timer === i && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && this.completeChannel(e, cr, t, void 0, 0, 0));
			}, r) : null;
			this.pendingSelectRetries.set(e, {
				timer: i,
				channel: e,
				origArgs: t,
				deadline: d,
				needsSignalSafeWake: !1,
				syscallNr: cr
			});
			return;
		}
		const f = new Uint8Array(e.memory.buffer), u = this.getKernelMem(), p = new DataView(this.kernelMemory.buffer, this.scratchOffset), g = this.scratchOffset + 72;
		0 !== i ? u.set(f.subarray(i, i + n), g) : u.fill(0, g, g + n), 0 !== s ? u.set(f.subarray(s, s + n), g + n) : u.fill(0, g + n, g + 256), 0 !== o ? u.set(f.subarray(o, o + n), g + 256) : u.fill(0, g + 256, g + 384), p.setUint32(4, cr, !0), p.setBigInt64(8, BigInt(r), !0), p.setBigInt64(16, BigInt(0 !== i ? g : 0), !0), p.setBigInt64(24, BigInt(0 !== s ? g + n : 0), !0), p.setBigInt64(32, BigInt(0 !== o ? g + 256 : 0), !0), p.setBigInt64(40, BigInt(h), !0);
		const m = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			m(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const y = Number(p.getBigInt64(56, !0)), w = p.getUint32(64, !0);
		if (y >= 0) {
			const t = new Uint8Array(e.memory.buffer);
			0 !== i && t.set(u.subarray(g, g + n), i), 0 !== s && t.set(u.subarray(g + n, g + 256), s), 0 !== o && t.set(u.subarray(g + 256, g + 384), o);
		}
		if (!this.completeSelectSignalOutcome(e, cr, t, -1 === y && w === Xn)) {
			if (-1 === y && w === Xn) {
				if (0 === c) return void this.completeChannel(e, cr, t, void 0, 0, 0);
				if (d > 0 && Date.now() >= d) return e.readinessFinalCheck = !0, void this.handleSelect(e, t);
				const n = () => {
					const n = this.pendingSelectRetries.get(e);
					n && n.timer === i && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && this.handleSelect(e, t));
				}, r = c > 0 ? Math.max(d - Date.now(), 1) : 50, i = setTimeout(n, Math.min(r, 50));
				this.pendingSelectRetries.set(e, {
					timer: i,
					channel: e,
					origArgs: t,
					deadline: d,
					needsSignalSafeWake: !1,
					syscallNr: cr
				});
				return;
			}
			this.completeChannel(e, cr, t, void 0, y, w);
		}
	}
	handlePselect6(e, t) {
		if (this.deferChannelWhileStopped(e)) return;
		const n = 128, r = new Uint8Array(e.memory.buffer), i = this.getKernelMem(), s = new DataView(this.kernelMemory.buffer, this.scratchOffset), o = this.scratchOffset + 72, a = t[0], c = t[1], l = t[2], h = t[3], d = t[4], f = t[5];
		0 !== c ? i.set(r.subarray(c, c + n), o) : i.fill(0, o, o + n), 0 !== l ? i.set(r.subarray(l, l + n), o + n) : i.fill(0, o + n, o + 256), 0 !== h ? i.set(r.subarray(h, h + n), o + 256) : i.fill(0, o + 256, o + 384);
		let u = -1;
		if (0 !== d) {
			const t = new DataView(e.memory.buffer, d), n = Number(t.getBigInt64(0, !0)), r = Number(t.getBigInt64(8, !0));
			u = 1e3 * n + Math.floor(r / 1e6);
		}
		const p = !0 === e.readinessFinalCheck;
		e.readinessFinalCheck = !1;
		const g = p ? 0 : u, m = this.getReadinessDeadline(e, u), y = o + 384;
		let w = 0;
		if (0 !== f) {
			const t = this.getPtrWidth(e.pid), n = new DataView(e.memory.buffer, f), s = 8 === t ? Number(n.getBigUint64(0, !0)) : n.getUint32(0, !0);
			0 !== s && (i.set(r.subarray(s, s + 8), y), w = y);
		}
		s.setUint32(4, ar, !0), s.setBigInt64(8, BigInt(a), !0), s.setBigInt64(16, BigInt(0 !== c ? o : 0), !0), s.setBigInt64(24, BigInt(0 !== l ? o + n : 0), !0), s.setBigInt64(32, BigInt(0 !== h ? o + 256 : 0), !0), s.setBigInt64(40, BigInt(g), !0), s.setBigInt64(48, BigInt(w), !0);
		const _ = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			_(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const S = Number(s.getBigInt64(56, !0)), b = s.getUint32(64, !0);
		if (S >= 0) {
			const t = new Uint8Array(e.memory.buffer);
			0 !== c && t.set(i.subarray(o, o + n), c), 0 !== l && t.set(i.subarray(o + n, o + 256), l), 0 !== h && t.set(i.subarray(o + 256, o + 384), h);
		}
		if (!this.completeSelectSignalOutcome(e, ar, t, -1 === S && b === Xn)) {
			if (-1 === S && b === Xn) {
				if (0 === u) return void this.completeChannel(e, ar, t, void 0, 0, 0);
				if (m > 0 && Date.now() >= m) return e.readinessFinalCheck = !0, void this.handlePselect6(e, t);
				const n = 0 !== w;
				if (0 === a) {
					if (u > 0) {
						const r = Math.max(m - Date.now(), 1), i = setTimeout(() => {
							this.pendingSelectRetries.get(e)?.timer === i && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && (e.readinessFinalCheck = !0, this.handlePselect6(e, t)));
						}, r);
						this.pendingSelectRetries.set(e, {
							timer: i,
							channel: e,
							origArgs: t,
							deadline: m,
							needsSignalSafeWake: n,
							syscallNr: ar
						});
					} else this.pendingSelectRetries.set(e, {
						timer: null,
						channel: e,
						origArgs: t,
						deadline: -1,
						needsSignalSafeWake: n,
						syscallNr: ar
					});
					return;
				}
				const r = () => {
					const n = this.pendingSelectRetries.get(e);
					n && n.timer === s && (this.pendingSelectRetries.delete(e), this.isRegisteredChannel(e) && this.handlePselect6(e, t));
				}, i = m > 0 ? Math.max(m - Date.now(), 1) : 50, s = setTimeout(r, Math.min(i, 50));
				this.pendingSelectRetries.set(e, {
					timer: s,
					channel: e,
					origArgs: t,
					deadline: m,
					needsSignalSafeWake: n,
					syscallNr: ar
				});
				return;
			}
			this.completeChannel(e, ar, t, void 0, S, b);
		}
	}
	handleEpollCreate(e, t, n) {
		const r = new DataView(this.kernelMemory.buffer, this.scratchOffset), i = n[0], s = t === dr ? 0 : i;
		r.setUint32(4, t, !0), r.setBigInt64(8, BigInt(s), !0);
		for (let l = 1; l < 6; l++) r.setBigInt64(8 + 8 * l, 0n, !0);
		const o = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			o(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
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
		c.setUint32(4, fr, !0), c.setBigInt64(8, BigInt(n), !0), c.setBigInt64(16, BigInt(r), !0), c.setBigInt64(24, BigInt(i), !0), c.setBigInt64(32, BigInt(0 !== s ? h : 0), !0), c.setBigInt64(40, BigInt(0), !0), c.setBigInt64(48, BigInt(0), !0);
		const d = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			d(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
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
		this.completeChannel(e, fr, t, void 0, f, u);
	}
	completeEpollSignalOutcome(e) {
		const t = this.dequeueSignalForDelivery(e, !0);
		return !!this.finishSignalTermination(e) || t > 0 && (this.completeChannelRaw(e, -4, 4), this.relistenChannel(e), !0);
	}
	handleEpollPwait(e, t, n) {
		if (this.deferChannelWhileStopped(e)) return;
		const r = n[0], i = n[1], s = n[2], o = n[3], a = this.getReadinessDeadline(e, o);
		if (s <= 0) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const c = `${e.pid}:${r}`, l = this.epollInterests.get(c);
		if (!l) return this.completeChannelRaw(e, -9, 9), void this.relistenChannel(e);
		if (0 === l.length) {
			if (this.completeEpollSignalOutcome(e)) return;
			if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
			if (a > 0 && Date.now() >= a) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
			const r = () => {
				const r = this.pendingPollRetries.get(e);
				r && r.timer === s && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && this.handleEpollPwait(e, t, n));
			}, i = a > 0 ? Math.min(Math.max(a - Date.now(), 1), 10) : 10, s = setTimeout(r, i);
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
		for (let b = 0; b < h; b++) {
			const e = l[b], t = f + 8 * b;
			let n = 0;
			1 & e.events && (n |= 1), 4 & e.events && (n |= 4), new DataView(this.kernelMemory.buffer).setInt32(t, e.fd, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 4, n, !0), new DataView(this.kernelMemory.buffer).setInt16(t + 6, 0, !0);
		}
		d.setUint32(4, sr, !0), d.setBigInt64(8, BigInt(f), !0), d.setBigInt64(16, BigInt(h), !0), d.setBigInt64(24, BigInt(0), !0);
		for (let b = 3; b < 6; b++) d.setBigInt64(8 + 8 * b, 0n, !0);
		const u = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			u(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const p = Number(d.getBigInt64(56, !0)), g = d.getUint32(64, !0);
		if (this.completeEpollSignalOutcome(e)) return;
		if (p < 0 && g !== Xn) return this.completeChannelRaw(e, p, g), void this.relistenChannel(e);
		let m = 0;
		if (p > 0) {
			const t = new DataView(e.memory.buffer);
			for (let e = 0; e < h && m < s; e++) {
				const n = f + 8 * e, r = new DataView(this.kernelMemory.buffer).getInt16(n + 6, !0);
				if (0 !== r) {
					let n = 0;
					1 & r && (n |= 1), 4 & r && (n |= 4), 8 & r && (n |= 8), 16 & r && (n |= 16);
					const s = i + 12 * m;
					t.setUint32(s, n, !0), t.setBigUint64(s + 4, l[e].data, !0), m++;
				}
			}
		}
		if (m > 0) return this.completeChannelRaw(e, m, 0), void this.relistenChannel(e);
		if (0 === o) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
		if (a > 0 && Date.now() >= a) return this.completeChannelRaw(e, 0, 0), void this.relistenChannel(e);
		const { pipeIndices: y, acceptIndices: w } = this.resolveEpollReadinessIndices(e.pid), _ = a > 0 ? Math.min(Math.max(a - Date.now(), 1), 10) : 10, S = setTimeout(() => {
			const r = this.pendingPollRetries.get(e);
			r && r.timer === S && (this.pendingPollRetries.delete(e), this.isRegisteredChannel(e) && this.handleEpollPwait(e, t, n));
		}, _);
		this.pendingPollRetries.set(e, {
			timer: S,
			channel: e,
			pipeIndices: y,
			acceptIndices: w,
			deadline: a
		});
	}
	finishNetworkIoctl(e, t = 0, n = 0) {
		this.completeChannelRaw(e, t, n), this.relistenChannel(e);
	}
	guestRangeIsValid(e, t, n) {
		return Number.isSafeInteger(t) && Number.isSafeInteger(n) && t >= 0 && n >= 0 && t <= e.memory.buffer.byteLength - n;
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
		const n = new Uint8Array(e.memory.buffer, t, zr);
		let r = 0;
		for (; r < n.length && 0 !== n[r];) r++;
		return new TextDecoder().decode(new Uint8Array(n.subarray(0, r)));
	}
	writeIfreqName(e, t, n) {
		const r = new TextEncoder().encode(n);
		e.fill(0, t, t + zr), e.set(r.subarray(0, 15), t);
	}
	handleIoctlIfconf(e, t) {
		const n = this.getPtrWidth(e.pid), r = t[2], i = 8 === n ? 16 : 8;
		if (!this.guestRangeIsValid(e, r, i)) return void this.finishNetworkIoctl(e, -14, Yn);
		const s = new DataView(e.memory.buffer), o = new Uint8Array(e.memory.buffer), a = this.ifreqSize(e), c = s.getInt32(r, !0);
		if (c < 0) return void this.finishNetworkIoctl(e, -22, Zn);
		let l;
		if (l = 8 === n ? Number(s.getBigUint64(r + 8, !0)) : s.getUint32(r + 4, !0), 0 === l) return s.setInt32(r, Tr.length * a, !0), void this.finishNetworkIoctl(e);
		if (c < a) return s.setInt32(r, 0, !0), void this.finishNetworkIoctl(e);
		const h = Math.floor(c / a), d = Math.min(h, Tr.length), f = d * a;
		if (this.guestRangeIsValid(e, l, f)) {
			for (let e = 0; e < d; e++) {
				const t = Tr[e], n = l + e * a;
				this.writeIfreqName(o, n, t.name), o.fill(0, n + zr, n + a), s.setUint16(n + zr, 2, !0);
				const r = this.interfaceAddress(t);
				r && o.set(r, n + zr + 4);
			}
			s.setInt32(r, f, !0), this.finishNetworkIoctl(e);
		} else this.finishNetworkIoctl(e, -14, Yn);
	}
	handleIoctlIfname(e, t) {
		const n = t[2];
		if (!this.guestRangeIsValid(e, n, this.ifreqSize(e))) return void this.finishNetworkIoctl(e, -14, Yn);
		const r = new DataView(e.memory.buffer), i = new Uint8Array(e.memory.buffer), s = r.getInt32(n + 16, !0), o = Tr.find((e) => e.index === s);
		o ? (this.writeIfreqName(i, n, o.name), this.finishNetworkIoctl(e)) : this.finishNetworkIoctl(e, -19, 19);
	}
	handleIoctlIfhwaddr(e, t) {
		const n = t[2], r = this.readIfreqName(e, n);
		if (null === r) return void this.finishNetworkIoctl(e, -14, Yn);
		const i = Tr.find((e) => e.name === r);
		if (!i) return void this.finishNetworkIoctl(e, -19, 19);
		const s = new DataView(e.memory.buffer), o = new Uint8Array(e.memory.buffer);
		o.fill(0, n + zr, n + this.ifreqSize(e)), s.setUint16(n + zr, i.loopback ? 772 : 1, !0), i.loopback || o.set(this.virtualMacAddress, n + zr + 2), this.finishNetworkIoctl(e);
	}
	handleIoctlIfaddr(e, t) {
		const n = t[2], r = this.readIfreqName(e, n);
		if (null === r) return void this.finishNetworkIoctl(e, -14, Yn);
		const i = Tr.find((e) => e.name === r);
		if (!i) return void this.finishNetworkIoctl(e, -19, 19);
		const s = this.interfaceAddress(i);
		if (!s) return void this.finishNetworkIoctl(e, -99, 99);
		const o = new DataView(e.memory.buffer), a = new Uint8Array(e.memory.buffer);
		a.fill(0, n + zr, n + this.ifreqSize(e)), o.setUint16(n + zr, 2, !0), a.set(s, n + zr + 4), this.finishNetworkIoctl(e);
	}
	handleIoctlIfindex(e, t) {
		const n = t[2], r = this.readIfreqName(e, n);
		if (null === r) return void this.finishNetworkIoctl(e, -14, Yn);
		const i = Tr.find((e) => e.name === r);
		i ? (new DataView(e.memory.buffer).setInt32(n + zr, i.index, !0), this.finishNetworkIoctl(e)) : this.finishNetworkIoctl(e, -19, 19);
	}
	prepareWriteOperationBudget(e, t, n, r, i) {
		const s = this.kernelInstance.exports.kernel_prepare_write_operation;
		if (!s) throw new Error("kernel ABI is missing kernel_prepare_write_operation for chunked writes");
		let o;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			o = Number(s(e.pid, t, BigInt(n), r, i ? 1 : 0));
		} catch (Zi) {
			return console.error(`[prepareWriteOperationBudget] kernel threw for pid=${e.pid}:`, Zi), this.completeChannelRaw(e, -1, 5), this.relistenChannel(e), null;
		} finally {
			this.currentHandlePid = 0;
		}
		return this.finishSignalTermination(e) ? null : !Number.isSafeInteger(o) || o > r ? (console.error(`[prepareWriteOperationBudget] invalid kernel budget ${o} for request ${r}`), this.completeChannelRaw(e, -1, 5), this.relistenChannel(e), null) : o < 0 ? (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || (this.completeChannelRaw(e, -1, -o), this.relistenChannel(e)), null) : o;
	}
	handleWritev(e, t, n) {
		const r = n[0], i = n[1], s = n[2], o = new Uint8Array(e.memory.buffer), a = new DataView(e.memory.buffer), c = this.getKernelMem(), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = this.scratchOffset + 72, d = this.getPtrWidth(e.pid), f = 8 === d ? 16 : 8;
		if (s <= 0 || s > 1024) return this.completeChannelRaw(e, -1, Zn), void this.relistenChannel(e);
		const u = [];
		let p = 0;
		for (let m = 0; m < s; m++) {
			let e, t;
			8 === d ? (e = Number(a.getBigUint64(i + m * f, !0)), t = Number(a.getBigUint64(i + m * f + 8, !0))) : (e = a.getUint32(i + m * f, !0), t = a.getUint32(i + m * f + 4, !0)), u.push({
				base: e,
				len: t
			}), p += t;
		}
		if (!Number.isSafeInteger(p) || p > 2147483647) return this.completeChannelRaw(e, -1, Zn), void this.relistenChannel(e);
		const g = 8 * s;
		if (p <= ee - g) {
			let i = g;
			for (let e = 0; e < s; e++) {
				const t = h + i;
				u[e].len > 0 && c.set(o.subarray(u[e].base, u[e].base + u[e].len), t);
				const n = h + 8 * e;
				new DataView(c.buffer).setUint32(n, t, !0), new DataView(c.buffer).setUint32(n + 4, u[e].len, !0), i += u[e].len, i = i + 3 & -4;
			}
			l.setUint32(4, t, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(s), !0), t === pi && (l.setBigInt64(32, BigInt(n[3]), !0), l.setBigInt64(40, BigInt(n[4]), !0));
			const a = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				a(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
			const d = Number(l.getBigInt64(56, !0)), f = l.getUint32(64, !0);
			if (-1 === d && f === Xn) return void this.handleBlockingRetry(e, t, n);
			this.handleSharedMappingsAfterFileSyscall(e, t, n, d, f), this.completeChannel(e, t, n, void 0, d, f);
		} else {
			const i = this.kernelInstance.exports.kernel_handle_channel, s = t === pi;
			let a = s ? (n[3] >>> 0) + 4294967296 * (0 | n[4]) : 0;
			const d = this.prepareWriteOperationBudget(e, r, a, p, s);
			if (null === d) return;
			let f = 0, g = !1, m = null;
			const y = 65528;
			for (const t of u) {
				if (f >= d) break;
				if (0 === t.len) continue;
				let n = 0;
				for (; n < t.len && f < d;) {
					const u = Math.min(t.len - n, y, d - f), p = h + 8;
					c.set(o.subarray(t.base + n, t.base + n + u), p), new DataView(c.buffer).setUint32(h, p, !0), new DataView(c.buffer).setUint32(h + 4, u, !0), s ? (l.setUint32(4, pi, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0), l.setBigInt64(32, BigInt(4294967295 & a), !0), l.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (l.setUint32(4, di, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0)), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
					try {
						i(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					if (this.finishSignalTermination(e)) return;
					const w = Number(l.getBigInt64(56, !0)), _ = l.getUint32(64, !0);
					if (-1 === w) {
						_ === Xn && 0 === f ? g = !0 : 0 === f && (m = {
							retVal: w,
							errVal: _
						});
						break;
					}
					if (n += w, f += w, s && (a += w), w < u) break;
				}
				if (g || n < t.len) break;
			}
			if (g) {
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				this.handleBlockingRetry(e, t, n);
				return;
			}
			if (m) {
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				this.completeChannelRaw(e, m.retVal, m.errVal), this.relistenChannel(e);
				return;
			}
			if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
			this.handleSharedMappingsAfterFileSyscall(e, t, n, f, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, f, 0), this.relistenChannel(e);
		}
	}
	handleLargeWrite(e, t, n) {
		const r = n[0], i = n[1], s = n[2];
		if (!Number.isSafeInteger(s) || s < 0 || s > 2147483647) return this.completeChannelRaw(e, -1, Zn), void this.relistenChannel(e);
		const o = t === Nr;
		let a = o ? n[3] : 0;
		const c = this.prepareWriteOperationBudget(e, r, a, s, o);
		if (null === c) return;
		const l = new Uint8Array(e.memory.buffer), h = this.getKernelMem(), d = new DataView(this.kernelMemory.buffer, this.scratchOffset), f = this.scratchOffset + 72, u = this.kernelInstance.exports.kernel_handle_channel;
		let p = 0;
		for (; p < c;) {
			const s = Math.min(c - p, ee);
			h.set(l.subarray(i + p, i + p + s), f), d.setUint32(4, t, !0), d.setBigInt64(8, BigInt(r), !0), d.setBigInt64(16, BigInt(f), !0), d.setBigInt64(24, BigInt(s), !0), o && d.setBigInt64(32, BigInt(a), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				u(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (Zi) {
				console.error(`[handleLargeWrite] kernel threw for pid=${e.pid}:`, Zi), p > 0 ? (this.handleSharedMappingsAfterFileSyscall(e, t, n, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0)) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.finishSignalTermination(e)) return;
			const g = Number(d.getBigInt64(56, !0)), m = d.getUint32(64, !0);
			if (-1 === g && m === Xn) {
				if (p > 0) {
					if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
					this.handleSharedMappingsAfterFileSyscall(e, t, n, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0), this.relistenChannel(e);
					return;
				}
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				this.handleBlockingRetry(e, t, n);
				return;
			}
			if (0 !== m || g <= 0) {
				if (this.dequeueSignalForDelivery(e), this.finishSignalTermination(e)) return;
				p > 0 ? (this.handleSharedMappingsAfterFileSyscall(e, t, n, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0)) : this.completeChannelRaw(e, g, m), this.relistenChannel(e);
				return;
			}
			if (p += g, o && (a += g), g < s) break;
		}
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || (this.handleSharedMappingsAfterFileSyscall(e, t, n, p, 0), this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, p, 0), this.relistenChannel(e));
	}
	handleLargeRead(e, t, n) {
		const r = n[0], i = n[1], s = n[2], o = t === Or;
		let a = o ? n[3] : 0;
		const c = new Uint8Array(e.memory.buffer), l = this.getKernelMem(), h = new DataView(this.kernelMemory.buffer, this.scratchOffset), d = this.scratchOffset + 72, f = this.kernelInstance.exports.kernel_handle_channel;
		let u = 0;
		for (; u < s;) {
			const p = Math.min(s - u, ee);
			l.fill(0, d, d + p), h.setUint32(4, t, !0), h.setBigInt64(8, BigInt(r), !0), h.setBigInt64(16, BigInt(d), !0), h.setBigInt64(24, BigInt(p), !0), o && h.setBigInt64(32, BigInt(a), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				f(this.toKernelPtr(this.scratchOffset), e.pid);
			} catch (Zi) {
				console.error(`[handleLargeRead] kernel threw for pid=${e.pid}:`, Zi), u > 0 ? (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0)) : this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.finishSignalTermination(e)) return;
			const g = Number(h.getBigInt64(56, !0)), m = h.getUint32(64, !0);
			if (-1 === g && m === Xn) return u > 0 ? (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0), void this.relistenChannel(e)) : void this.handleBlockingRetry(e, t, n);
			if (0 !== m || g <= 0) return u > 0 ? (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0)) : this.completeChannelRaw(e, g, m), void this.relistenChannel(e);
			if (c.set(l.subarray(d, d + g), i + u), u += g, o && (a += g), g < p) break;
		}
		this.dequeueSignalForDelivery(e), this.finishSignalTermination(e) || (this.synchronizeSharedMemoryForBoundary(e), this.completeChannelRaw(e, u, 0), this.relistenChannel(e));
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
			l.setUint32(4, t, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(s), !0), t === ui && (l.setBigInt64(32, BigInt(n[3]), !0), l.setBigInt64(40, BigInt(n[4]), !0));
			const d = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				d(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			if (this.finishSignalTermination(e)) return;
			const f = Number(l.getBigInt64(56, !0)), p = l.getUint32(64, !0);
			if (-1 === f && p === Xn) return void this.handleBlockingRetry(e, t, n);
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
			const i = this.kernelInstance.exports.kernel_handle_channel, s = t === ui;
			let a = s ? (0 | n[3]) + 4294967296 * (0 | n[4]) : 0, d = 0, f = 0, p = !1;
			for (const t of u) {
				if (0 === t.len) continue;
				let n = 0;
				for (; n < t.len;) {
					const u = Math.min(t.len - n, 65528), g = h + 8;
					new DataView(c.buffer).setUint32(h, g, !0), new DataView(c.buffer).setUint32(h + 4, u, !0), c.fill(0, g, g + u), s ? (l.setUint32(4, ui, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0), l.setBigInt64(32, BigInt(4294967295 & a), !0), l.setBigInt64(40, BigInt(Math.floor(a / 4294967296)), !0)) : (l.setUint32(4, fi, !0), l.setBigInt64(8, BigInt(r), !0), l.setBigInt64(16, BigInt(h), !0), l.setBigInt64(24, BigInt(1), !0)), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
					try {
						i(this.toKernelPtr(this.scratchOffset), e.pid);
					} finally {
						this.currentHandlePid = 0;
					}
					if (this.finishSignalTermination(e)) return;
					const m = Number(l.getBigInt64(56, !0)), y = l.getUint32(64, !0);
					if (-1 === m) {
						if (y === Xn && 0 === d) {
							p = !0;
							break;
						}
						f = y;
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
		const y = l, w = new DataView(a.buffer);
		w.setUint32(y, d, !0), w.setUint32(y + 4, f, !0), w.setUint32(y + 8, u, !0), w.setUint32(y + 12, p, !0), w.setUint32(y + 16, g, !0), w.setUint32(y + 20, m, !0), w.setUint32(y + 24, 0, !0);
		let _ = 28;
		if (0 !== d && f > 0 && _ + f <= 65536) {
			const e = l + _;
			a.set(s.subarray(d, d + f), e), w.setUint32(y, e, !0), _ += f, _ = _ + 3 & -4;
		}
		if (0 !== g && m > 0 && _ + m <= 65536) {
			const e = l + _;
			a.set(s.subarray(g, g + m), e), w.setUint32(y + 16, e, !0), _ += m, _ = _ + 3 & -4;
		}
		const S = 8 === h ? 16 : 8;
		if (p > 0 && 0 !== u) {
			const e = l + _;
			_ += 8 * p, _ = _ + 3 & -4, w.setUint32(y + 8, e, !0);
			for (let t = 0; t < p; t++) {
				let n, r;
				if (8 === h ? (n = Number(o.getBigUint64(u + t * S, !0)), r = Number(o.getBigUint64(u + t * S + 8, !0))) : (n = o.getUint32(u + 8 * t, !0), r = o.getUint32(u + 8 * t + 4, !0)), w.setUint32(e + 8 * t, 0, !0), w.setUint32(e + 8 * t + 4, r, !0), r > 0 && _ + r <= 65536) {
					const i = l + _;
					a.set(s.subarray(n, n + r), i), w.setUint32(e + 8 * t, i, !0), _ += r, _ = _ + 3 & -4;
				}
			}
		}
		c.setUint32(4, ri, !0), c.setBigInt64(8, BigInt(n), !0), c.setBigInt64(16, BigInt(y), !0), c.setBigInt64(24, BigInt(i), !0);
		const b = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			b(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const k = Number(c.getBigInt64(56, !0)), v = c.getUint32(64, !0);
		-1 !== k || v !== Xn ? this.completeChannel(e, ri, t, void 0, k, v) : this.handleBlockingRetry(e, ri, t);
	}
	handleRecvmsg(e, t) {
		const n = t[0], r = t[1], i = t[2], s = new Uint8Array(e.memory.buffer), o = new DataView(e.memory.buffer), a = this.getKernelMem(), c = new DataView(this.kernelMemory.buffer, this.scratchOffset), l = this.scratchOffset + 72, h = this.getPtrWidth(e.pid);
		let d, f, u, p, g, m;
		8 === h ? (d = Number(o.getBigUint64(r, !0)), f = o.getUint32(r + 8, !0), u = Number(o.getBigUint64(r + 16, !0)), p = o.getUint32(r + 24, !0), g = Number(o.getBigUint64(r + 32, !0)), m = o.getUint32(r + 40, !0)) : (d = o.getUint32(r, !0), f = o.getUint32(r + 4, !0), u = o.getUint32(r + 8, !0), p = o.getUint32(r + 12, !0), g = o.getUint32(r + 16, !0), m = o.getUint32(r + 20, !0));
		const y = l, w = new DataView(a.buffer);
		w.setUint32(y, d, !0), w.setUint32(y + 4, f, !0), w.setUint32(y + 8, u, !0), w.setUint32(y + 12, p, !0), w.setUint32(y + 16, g, !0), w.setUint32(y + 20, m, !0), w.setUint32(y + 24, 0, !0);
		let _ = 28, S = 0;
		0 !== d && f > 0 && _ + f <= 65536 && (S = l + _, a.fill(0, S, S + f), w.setUint32(y, S, !0), _ += f, _ = _ + 3 & -4);
		let b = 0;
		0 !== g && m > 0 && _ + m <= 65536 && (b = l + _, a.fill(0, b, b + m), w.setUint32(y + 16, b, !0), _ += m, _ = _ + 3 & -4);
		const k = [], v = 8 === h ? 16 : 8;
		if (p > 0 && 0 !== u) {
			const e = l + _;
			_ += 8 * p, _ = _ + 3 & -4, w.setUint32(y + 8, e, !0);
			for (let t = 0; t < p; t++) {
				let n, r;
				if (8 === h ? (n = Number(o.getBigUint64(u + t * v, !0)), r = Number(o.getBigUint64(u + t * v + 8, !0))) : (n = o.getUint32(u + 8 * t, !0), r = o.getUint32(u + 8 * t + 4, !0)), r > 0 && _ + r <= 65536) {
					const i = l + _;
					a.fill(0, i, i + r), w.setUint32(e + 8 * t, i, !0), w.setUint32(e + 8 * t + 4, r, !0), k.push({
						base: n,
						len: r,
						kernelBase: i
					}), _ += r, _ = _ + 3 & -4;
				} else w.setUint32(e + 8 * t, 0, !0), w.setUint32(e + 8 * t + 4, r, !0);
			}
		}
		c.setUint32(4, ii, !0), c.setBigInt64(8, BigInt(n), !0), c.setBigInt64(16, BigInt(y), !0), c.setBigInt64(24, BigInt(i), !0);
		const A = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			A(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		if (this.finishSignalTermination(e)) return;
		const I = Number(c.getBigInt64(56, !0)), C = c.getUint32(64, !0);
		if (-1 === I && C === Xn) return void this.handleBlockingRetry(e, ii, t);
		if (I > 0) {
			let e = I;
			for (const t of k) {
				if (e <= 0) break;
				const n = Math.min(t.len, e);
				s.set(a.subarray(t.kernelBase, t.kernelBase + n), t.base), e -= n;
			}
		}
		if (0 !== S && 0 !== d && f > 0 && s.set(a.subarray(S, S + f), d), 0 !== b && 0 !== g) {
			const e = w.getUint32(y + 20, !0);
			e > 0 && e <= m && s.set(a.subarray(b, b + e), g);
		}
		const P = w.getUint32(y + 4, !0), E = w.getUint32(y + 20, !0), x = w.getUint32(y + 24, !0);
		8 === h ? (o.setUint32(r + 8, P, !0), o.setUint32(r + 40, E, !0), o.setUint32(r + 44, x, !0)) : (o.setUint32(r + 4, P, !0), o.setUint32(r + 20, E, !0), o.setUint32(r + 24, x, !0)), this.completeChannel(e, ii, t, void 0, I, C);
	}
	handleFork(e, t) {
		if (!this.callbacks.onFork) return void this.completeChannel(e, Sr, t, void 0, -1, 38);
		const n = e.pid;
		if (this.syncAnonymousSharedMappingsFromProcess(e, { force: !0 }), this.syncFileSharedMappingsFromProcess(e, { force: !0 }), !this.syncSysvShmMappingsFromProcess(e, { force: !0 })) return void this.completeChannel(e, Sr, t, void 0, -1, 5);
		const r = this.kernelInstance.exports.kernel_fork_process;
		let i = 0, s = -17;
		for (let p = 0; p < 4096; p++) {
			for (; this.processes.has(this.nextChildPid);) this.nextChildPid++;
			if (i = this.nextChildPid++, s = r(n, i), 0 === s || 17 !== -s) break;
		}
		if (s < 0) return void this.completeChannel(e, Sr, t, void 0, -1, -s >>> 0);
		const o = this.kernelInstance.exports.kernel_clear_fork_child;
		o && o(i);
		const a = this.kernelInstance.exports.kernel_reset_signal_mask;
		a && a(i);
		const c = `${n}:${e.channelOffset}`, l = this.threadForkContexts.get(c), h = e.channelOffset - 131072, d = l ? {
			fnPtr: l.fnPtr,
			argPtr: l.argPtr,
			forkBufAddr: e.channelOffset - 61440,
			slotStart: h,
			slotLen: 262144
		} : void 0;
		if (d) try {
			this.reserveHostRegionAt(i, d.slotStart, d.slotLen);
		} catch (Zi) {
			this.removeFromKernelProcessTable(i);
			const r = Zi instanceof Error ? Zi.message : String(Zi);
			console.error(`[kernel-worker] fork child slot reservation failed: ${r}`), this.completeChannel(e, Sr, t, void 0, -1, 12);
			return;
		}
		const f = (n) => {
			void 0 !== n && console.error(`[kernel-worker] fork worker launch failed: ${String(n)}`);
			try {
				this.rollbackChildHostRegistration(i);
			} catch {}
			try {
				this.removeFromKernelProcessTable(i);
			} catch {}
			this.isAsyncChannelProcessActive(e) && this.completeChannel(e, Sr, t, void 0, -1, 12);
		};
		let u;
		try {
			this.inheritHostFdMirrors(n, i), u = Promise.resolve(this.callbacks.onFork(n, i, e.memory, d));
		} catch (Zi) {
			f(Zi);
			return;
		}
		u.then((n) => {
			this.finalizePendingChildTermination(i), this.isAsyncChannelProcessActive(e) && this.completeChannel(e, Sr, t, void 0, i, 0);
		}).catch(f);
	}
	handleSpawn(e, t) {
		const n = e.pid, r = t[0], i = t[1], s = t[2], o = t[3], a = t[4];
		if (!this.callbacks.onSpawn || !this.callbacks.onResolveSpawn) return void this.completeChannel(e, kr, t, void 0, -1, 38);
		const c = new Uint8Array(e.memory.buffer);
		let l = "";
		0 !== r && i > 0 && (l = new TextDecoder().decode(c.slice(r, r + i)), l.endsWith("\0") && (l = l.slice(0, -1)));
		const h = l;
		if (l && !l.startsWith("/") && (l = this.resolveExecPathAgainstCwd(n, l)), o <= 0 || 0 === s && o > 0) return void this.completeChannel(e, kr, t, void 0, -1, 22);
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
			this.completeChannel(e, kr, t, void 0, -1, 22);
			return;
		}
		(async () => {
			const e = await this.callbacks.onResolveSpawn(l, f);
			return e || h === l || !h || h.startsWith("/") ? e : this.callbacks.onResolveSpawn(h, f);
		})().then((r) => {
			var i;
			this.isAsyncChannelProcessActive(e) && (r ? "errno" in (i = r) && "number" == typeof i.errno ? this.completeChannel(e, kr, t, void 0, -1, r.errno >>> 0) : this.handleSpawnAfterResolve(e, t, n, a, d, o, r, u) : this.completeChannel(e, kr, t, void 0, -1, 2));
		}).catch((r) => {
			this.isAsyncChannelProcessActive(e) && (console.error(`[kernel] spawn resolve error for parent ${n}:`, r), this.completeChannel(e, kr, t, void 0, -1, 5));
		});
	}
	handleSpawnAfterResolve(e, t, n, r, i, s, o, a) {
		const c = new Uint8Array(this.kernelMemory.buffer);
		if (s > c.byteLength - this.scratchOffset) return void this.completeChannel(e, kr, t, void 0, -1, 22);
		c.set(i, this.scratchOffset);
		const l = (0, this.kernelInstance.exports.kernel_spawn_process)(n, this.toKernelPtr(this.scratchOffset), this.toKernelPtr(s));
		if (l < 0) return void this.completeChannel(e, kr, t, void 0, -1, -l >>> 0);
		const h = l >>> 0;
		h >= this.nextChildPid && (this.nextChildPid = h + 1);
		const d = (r, i) => {
			void 0 !== i && console.error(`[kernel] spawn error for parent ${n}:`, i);
			try {
				this.rollbackChildHostRegistration(h);
			} catch {}
			try {
				this.removeFromKernelProcessTable(h);
			} catch {}
			this.isAsyncChannelProcessActive(e) && this.completeChannel(e, kr, t, void 0, -1, r);
		};
		let f;
		try {
			this.inheritHostFdMirrors(n, h, !1), f = Promise.resolve(this.callbacks.onSpawn(n, h, o, a));
		} catch (Zi) {
			d(5, Zi);
			return;
		}
		f.then((n) => {
			n < 0 ? d(-n >>> 0) : (this.finalizePendingChildTermination(h), this.isAsyncChannelProcessActive(e) && (0 !== r && new DataView(e.memory.buffer).setInt32(r, h, !0), this.completeChannel(e, kr, t, void 0, 0, 0)));
		}).catch((e) => {
			d(5, e);
		});
	}
	readCStringFromProcess(e, t, n = 4096) {
		if (0 === t) return "";
		let r = 0;
		for (; t + r < e.length && 0 !== e[t + r] && r < n;) r++;
		return new TextDecoder().decode(e.slice(t, t + r));
	}
	readExecPathFromProcess(e, t) {
		if (!Number.isSafeInteger(t) || t <= 0 || t >= e.byteLength) return { errno: Yn };
		const n = e.byteLength - t, r = Math.min(n, 4096);
		let i = 0;
		for (; i < r && 0 !== e[t + i];) i++;
		return i === r ? { errno: n >= 4096 ? 36 : Yn } : { value: new TextDecoder().decode(e.slice(t, t + i)) };
	}
	readStringArrayFromProcess(e, t, n = 4) {
		if (0 === t) return { values: [] };
		const r = [], i = new DataView(e.buffer, e.byteOffset, e.byteLength);
		let s = n;
		for (let o = 0; s <= er; o++) {
			const a = t + o * n;
			if (!Number.isSafeInteger(a) || a < 0 || a + n > i.byteLength) return { errno: Yn };
			let c;
			if (8 === n) {
				const e = i.getBigUint64(a, !0);
				if (e > BigInt(Number.MAX_SAFE_INTEGER)) return { errno: Yn };
				c = Number(e);
			} else c = i.getUint32(a, !0);
			if (0 === c) return { values: r };
			if (c < 0 || c >= e.byteLength) return { errno: Yn };
			const l = Math.min(e.byteLength - c, 65537);
			let h = 0;
			for (; h < l && 0 !== e[c + h];) h++;
			if (h === l) return { errno: l > 65536 ? 7 : Yn };
			if (h > 65536) return { errno: 7 };
			if (s += n + h + 1, !Number.isSafeInteger(s) || s > er) return { errno: 7 };
			r.push(new TextDecoder().decode(e.slice(c, c + h)));
		}
		return { errno: 7 };
	}
	finishFailedExec(e, t, n, r) {
		this.isAsyncChannelProcessActive(e) && this.completeChannel(e, t, n, void 0, -1, r);
	}
	handleExec(e, t) {
		const n = new Uint8Array(e.memory.buffer), r = this.getPtrWidth(e.pid), i = this.readExecPathFromProcess(n, t[0]);
		if ("errno" in i) return void this.completeChannel(e, wr, t, void 0, -1, i.errno);
		let s = i.value;
		const o = this.readStringArrayFromProcess(n, t[1], r), a = this.readStringArrayFromProcess(n, t[2], r);
		if ("errno" in o) return void this.completeChannel(e, wr, t, void 0, -1, o.errno);
		if ("errno" in a) return void this.completeChannel(e, wr, t, void 0, -1, a.errno);
		const c = o.values, l = a.values;
		if (s && !s.startsWith("/") && (s = this.resolveExecPathAgainstCwd(e.pid, s)), !this.callbacks.onExec) return void this.completeChannel(e, wr, t, void 0, -1, 38);
		const h = this.channelTids.get(`${e.pid}:${e.channelOffset}`) ?? e.pid;
		this.callbacks.onExec(e.pid, s, c, l, h).then((n) => {
			n < 0 && this.finishFailedExec(e, wr, t, -n >>> 0);
		}).catch((n) => {
			console.error(`[kernel] exec error for pid ${e.pid}:`, n), this.finishFailedExec(e, wr, t, 5);
		});
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
		const n = t[0], r = t[4], i = new Uint8Array(e.memory.buffer), s = this.getPtrWidth(e.pid), o = this.readExecPathFromProcess(i, t[1]);
		if ("errno" in o) return void this.completeChannel(e, _r, t, void 0, -1, o.errno);
		const a = o.value, c = this.readStringArrayFromProcess(i, t[2], s), l = this.readStringArrayFromProcess(i, t[3], s);
		if ("errno" in c) return void this.completeChannel(e, _r, t, void 0, -1, c.errno);
		if ("errno" in l) return void this.completeChannel(e, _r, t, void 0, -1, l.errno);
		const h = c.values, d = l.values;
		let f;
		if (4096 & r && "" === a) {
			const r = this.kernelInstance.exports.kernel_get_fd_path;
			if (!r) return void this.completeChannel(e, _r, t, void 0, -1, 38);
			const i = r(e.pid, n, this.toKernelPtr(this.scratchOffset), 4096);
			if (i <= 0) {
				const n = i < 0 ? -i >>> 0 : 2;
				this.completeChannel(e, _r, t, void 0, -1, n);
				return;
			}
			const s = new Uint8Array(this.kernelMemory.buffer);
			f = new TextDecoder().decode(s.slice(this.scratchOffset, this.scratchOffset + i));
		} else if (a.startsWith("/")) f = a;
		else {
			const t = this.kernelInstance.exports.kernel_get_cwd;
			if (t) {
				const n = t(e.pid, this.scratchOffset, 4096);
				if (n > 0) {
					const e = new Uint8Array(this.kernelMemory.buffer), t = new TextDecoder().decode(e.slice(this.scratchOffset, this.scratchOffset + n));
					f = t.endsWith("/") ? t + a : t + "/" + a;
				} else f = a;
			} else f = a;
		}
		if (!this.callbacks.onExec) return void this.completeChannel(e, _r, t, void 0, -1, 38);
		const u = this.channelTids.get(`${e.pid}:${e.channelOffset}`) ?? e.pid;
		this.callbacks.onExec(e.pid, f, h, d, u).then((n) => {
			n < 0 && this.finishFailedExec(e, _r, t, -n >>> 0);
		}).catch((n) => {
			console.error(`[kernel] execveat error for pid ${e.pid}:`, n), this.finishFailedExec(e, _r, t, 5);
		});
	}
	handleClone(e, t) {
		if (!this.callbacks.onClone) return void this.completeChannel(e, vr, t, void 0, -1, 38);
		const n = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		n.setUint32(4, vr, !0);
		for (let g = 0; g < 6; g++) n.setBigInt64(8 + 8 * g, BigInt(t[g]), !0);
		const r = this.kernelInstance.exports.kernel_handle_channel;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			r(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const i = Number(n.getBigInt64(56, !0)), s = n.getUint32(64, !0);
		if (i < 0) return void this.completeChannel(e, vr, t, void 0, i, s);
		const o = i, a = t[0], c = t[2];
		1048576 & a && 0 !== c && new DataView(e.memory.buffer).setInt32(c, o, !0);
		const l = new DataView(e.memory.buffer, e.channelOffset), h = l.getUint32(72, !0), d = l.getUint32(76, !0), f = t[1], u = t[3], p = t[4];
		0 !== p && this.threadCtidPtrs.set(`${e.pid}:${o}`, p), this.callbacks.onClone(e.pid, o, h, d, f, u, p, e.memory).then((n) => {
			this.isAsyncChannelProcessActive(e) && (n !== o && 0 !== p && (this.threadCtidPtrs.delete(`${e.pid}:${o}`), this.threadCtidPtrs.set(`${e.pid}:${n}`, p)), this.completeChannel(e, vr, t, void 0, n, 0));
		}).catch((n) => {
			this.isAsyncChannelProcessActive(e) && (0 !== p && this.threadCtidPtrs.delete(`${e.pid}:${o}`), console.error(`[kernel-worker] onClone failed: ${n}`), this.completeChannel(e, vr, t, void 0, -1, 12));
		});
	}
	handleExit(e, t, n) {
		const r = n[0], i = this.processes.get(e.pid), s = i && i.channels.length > 0 && i.channels[0].channelOffset === e.channelOffset;
		if (t === Ar && !s) {
			const t = `${e.pid}:${e.channelOffset}`, n = this.channelTids.get(t) ?? 0;
			n > 0 && this.finalizeThreadExit(e.pid, n, e.channelOffset), this.completeChannelRaw(e, 0, 0), n > 0 && this.callbacks.onThreadExit?.(e.pid, n, e.channelOffset);
			return;
		}
		if (this.releaseAllSharedMemoryForProcess(e.pid), this.getProcessExitSignal(e.pid) > 0) return void (this.hostReaped.has(e.pid) || this.handleProcessTerminated(e));
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
		this.drainAndProcessWakeupEvents();
		const o = e.pid;
		if (this.discardStoppedChannelStateForProcess(o), this.hostReaped.has(o)) return this.completeChannelRaw(e, 0, 0), this.scheduleWakeBlockedRetries(), void (this.callbacks.onExit && this.callbacks.onExit(o, r));
		this.hostReaped.add(o), this.notifyParentOfExitedProcess(o), this.completeChannelRaw(e, 0, 0), this.scheduleWakeBlockedRetries(), this.callbacks.onExit && this.callbacks.onExit(o, r);
	}
	handleProcessTerminated(e) {
		const t = e.pid;
		if (this.discardStoppedChannelStateForProcess(t), this.hostReaped.has(t)) return;
		const n = this.getProcessExitSignal(t);
		this.hostReaped.add(t), this.releaseAllSharedMemoryForProcess(t), this.drainAndProcessWakeupEvents(), this.notifyParentOfExitedProcess(t), this.callbacks.onExit && this.callbacks.onExit(t, n > 0 ? 128 + n : -1);
	}
	finalizeExitedProcessBeforeLifecycleNotification(e) {
		const t = this.kernelInstance.exports.kernel_get_process_state;
		if (!t || 2 !== t(e)) return !1;
		if (this.discardStoppedChannelStateForProcess(e), this.hostReaped.has(e)) return !0;
		this.cancelPendingSleepsForProcess(e);
		const n = this.processes.get(e)?.channels[0];
		return n ? this.handleProcessTerminated(n) : this.finalizeExecHandoffTermination(e), !0;
	}
	notifyHostProcessCrashed(e, t = 11) {
		if (this.discardStoppedChannelStateForProcess(e), this.hostReaped.has(e)) return;
		const n = this.kernelInstance.exports.kernel_mark_process_signaled;
		n && n(e, t) < 0 || (this.hostReaped.add(e), this.releaseAllSharedMemoryForProcess(e), this.drainAndProcessWakeupEvents(), this.notifyParentOfExitedProcess(e));
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
		const n = t[0], r = t[1], i = t[2] >>> 0, s = t[3], o = e.pid;
		if (this.pendingCancels.delete(e)) return this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
		if (-12 & i) return void this.completeWaitpid(e, t, -1, Zn);
		if (!this.isOptionalGuestOutputRangeValid(e, r, 4) || !this.isOptionalGuestOutputRangeValid(e, s, 144)) return void this.completeWaitpid(e, t, -1, Yn);
		const a = this.wait4EventMask(i), c = this.pollWaitableChild(o, n, a, 0);
		if ("error" === c.kind) return void this.completeWaitpid(e, t, -1, c.errno);
		if ("event" === c.kind) return this.writeWait4Result(e, r, s, c), void this.completeWaitpid(e, t, c.childPid, 0);
		if (1 & i) return void this.completeWaitpid(e, t, 0, 0);
		const l = {
			parentPid: o,
			channel: e,
			origArgs: t,
			pid: n,
			options: i,
			syscallNr: Er
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
	pollWaitableChild(e, t, n, r) {
		const i = (0, this.kernelInstance.exports.kernel_wait_child_poll)(e, t, n, r, this.toKernelPtr(this.scratchOffset));
		if (i > 0) {
			const e = new Uint8Array(this.kernelMemory.buffer, this.scratchOffset, 160), t = new Uint8Array(160);
			t.set(e);
			const n = new DataView(t.buffer), r = t.subarray(16, 160);
			return {
				kind: "event",
				childPid: i,
				waitStatus: n.getInt32(0, !0),
				siCode: n.getInt32(4, !0),
				siStatus: n.getInt32(8, !0),
				childUid: n.getUint32(12, !0),
				rusage: r
			};
		}
		return 0 === i ? { kind: "running" } : {
			kind: "error",
			errno: -i >>> 0
		};
	}
	isOptionalGuestOutputRangeValid(e, t, n) {
		return 0 === t || Qn(new Uint8Array(e.memory.buffer), t, n);
	}
	isRequiredGuestOutputRangeValid(e, t, n) {
		return Qn(new Uint8Array(e.memory.buffer), t, n);
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
		if (n && 1 === n(t)) return this.consumeExitedChild(t, e), void this.wakeWaitingParent(t);
		this.sendSignalToProcess(t, 17);
	}
	writeWait4Result(e, t, n, r) {
		const i = new Uint8Array(e.memory.buffer);
		0 !== t && new DataView(e.memory.buffer).setInt32(t, r.waitStatus, !0), 0 !== n && i.set(r.rusage, n);
	}
	completeWaitpid(e, t, n, r) {
		this.dequeueSignalForDelivery(e, !0), this.finishSignalTermination(e) || this.completeChannel(e, Er, t, void 0, n, r);
	}
	completeWaitid(e, t, n, r) {
		this.dequeueSignalForDelivery(e, !0), this.finishSignalTermination(e) || this.completeChannel(e, xr, t, void 0, n, r);
	}
	interruptWaiterWithPendingSignal(e) {
		const t = this.dequeueSignalForDelivery(e.channel, !0);
		return !!this.finishSignalTermination(e.channel) || !(t <= 0) && (this.completeChannel(e.channel, e.syscallNr, e.origArgs, void 0, -1, 4), !0);
	}
	interruptWaitingChildForSignal(e, t) {
		this.wakeWaitingParent(e);
		const n = (0, this.kernelInstance.exports.kernel_pick_signal_target_tid)(e, t);
		if (n <= 0) return !1;
		const r = this.waitingForChild.findIndex((t) => t.parentPid === e && this.isRegisteredChannel(t.channel) && this.guestTidForChannel(t.channel) === n);
		if (r < 0) return !1;
		const [i] = this.waitingForChild.splice(r, 1);
		return !!this.interruptWaiterWithPendingSignal(i) || (this.waitingForChild.splice(r, 0, i), !1);
	}
	interruptWaitingChildForDirectedSignal(e, t) {
		this.wakeWaitingParent(e);
		if ((0, this.kernelInstance.exports.kernel_thread_has_deliverable)(e, t) <= 0) return !1;
		const n = this.waitingForChild.findIndex((n) => n.parentPid === e && this.isRegisteredChannel(n.channel) && this.guestTidForChannel(n.channel) === t);
		if (n < 0) return !1;
		const [r] = this.waitingForChild.splice(n, 1);
		return !!this.interruptWaiterWithPendingSignal(r) || (this.waitingForChild.splice(n, 0, r), !1);
	}
	interruptWaitingChildrenForGeneratedSignal(e) {
		if (e <= 0) return;
		const t = this.waitingForChild ?? [], n = new Set(t.map((e) => e.parentPid));
		for (const r of n) this.interruptWaitingChildForSignal(r, e);
	}
	wakeWaitingParent(e) {
		this.waitingForChild ??= [];
		const t = [];
		for (let n = 0; n < this.waitingForChild.length;) {
			const r = this.waitingForChild[n];
			if (r.parentPid !== e) {
				n++;
				continue;
			}
			if (!this.isRegisteredChannel(r.channel)) {
				this.waitingForChild.splice(n, 1);
				continue;
			}
			const i = r.syscallNr === xr ? this.waitidEventMask(r.options) : this.wait4EventMask(r.options), s = r.syscallNr === xr ? r.options & ie : 0, o = this.pollWaitableChild(r.parentPid, r.pid, i, s);
			"running" !== o.kind ? (this.waitingForChild.splice(n, 1), t.push({
				waiter: r,
				poll: o
			})) : n++;
		}
		for (const { waiter: n, poll: r } of t) "error" !== r.kind ? n.syscallNr === xr ? (this.writeWaitidResult(n.channel, n.origArgs[2], n.origArgs[4], r), this.completeWaitid(n.channel, n.origArgs, 0, 0)) : (this.writeWait4Result(n.channel, n.origArgs[1], n.origArgs[3], r), this.completeWaitpid(n.channel, n.origArgs, r.childPid, 0)) : n.syscallNr === xr ? this.completeWaitid(n.channel, n.origArgs, -1, r.errno) : this.completeWaitpid(n.channel, n.origArgs, -1, r.errno);
	}
	recheckDeferredWaitpids() {
		const e = /* @__PURE__ */ new Set();
		for (let t = this.waitingForChild.length - 1; t >= 0; t--) {
			const n = this.waitingForChild[t];
			if (n.pid > 0 || -1 === n.pid) continue;
			const r = n.syscallNr === xr ? this.waitidEventMask(n.options) : this.wait4EventMask(n.options), i = ie, s = this.pollWaitableChild(n.parentPid, n.pid, r, i);
			"error" === s.kind ? (this.waitingForChild.splice(t, 1), n.syscallNr === xr ? this.completeWaitid(n.channel, n.origArgs, -1, s.errno) : this.completeWaitpid(n.channel, n.origArgs, -1, s.errno)) : "event" === s.kind && e.add(n.parentPid);
		}
		for (const t of e) this.wakeWaitingParent(t);
	}
	handleWaitid(e, t) {
		const n = t[0], r = t[1], i = t[2], s = t[3] >>> 0, o = t[4], a = e.pid, c = this.waitidToWaitPid(n, r);
		if (this.pendingCancels.delete(e)) return this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
		const l = this.waitidEventMask(s);
		if (void 0 === c || -16777232 & s || 0 === l) return void this.completeWaitid(e, t, -1, Zn);
		if (!this.isRequiredGuestOutputRangeValid(e, i, 128) || !this.isOptionalGuestOutputRangeValid(e, o, 144)) return void this.completeWaitid(e, t, -1, Yn);
		const h = this.pollWaitableChild(a, c, l, s & ie);
		if ("error" === h.kind) return void this.completeWaitid(e, t, -1, h.errno);
		if ("event" === h.kind) return this.writeWaitidResult(e, i, o, h), void this.completeWaitid(e, t, 0, 0);
		if (1 & s) return new Uint8Array(e.memory.buffer, i, 128).fill(0), void this.completeWaitid(e, t, 0, 0);
		const d = {
			parentPid: a,
			channel: e,
			origArgs: t,
			pid: c,
			options: s,
			syscallNr: xr
		};
		this.interruptWaiterWithPendingSignal(d) || this.waitingForChild.push(d);
	}
	waitidToWaitPid(e, t) {
		if (Number.isSafeInteger(t)) return 1 === e ? t > 0 && t <= 2147483647 ? t : void 0 : 2 === e ? t >= 0 && t <= 2147483647 ? 0 === t ? 0 : -t : void 0 : 0 === e ? -1 : void 0;
	}
	writeWaitidResult(e, t, n, r) {
		const i = new Uint8Array(e.memory.buffer), s = new DataView(e.memory.buffer);
		i.fill(0, t, t + 128), s.setInt32(t + 0, 17, !0), s.setInt32(t + 8, r.siCode, !0);
		const o = 8 === this.getPtrWidth(e.pid) ? 16 : 12;
		s.setInt32(t + o, r.childPid, !0), s.setUint32(t + o + 4, r.childUid, !0), s.setInt32(t + o + 8, r.siStatus, !0), 0 !== n && i.set(r.rusage, n);
	}
	handleFutex(e, t) {
		const n = t[0], r = t[1], i = t[2], s = -385 & r, o = new Int32Array(e.memory.buffer), a = n >>> 2;
		if (0 === s || 9 === s) {
			if (this.pendingCancels.has(e)) return this.pendingCancels.delete(e), this.completeChannelRaw(e, -4, 4), void this.relistenChannel(e);
			if (Atomics.load(o, a) !== i) return this.completeChannelRaw(e, -11, Xn), void this.relistenChannel(e);
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
				const i = () => !r && (r = !0, void 0 !== t && clearTimeout(t), this.pendingFutexWaits.delete(e), !0), c = (t, n) => {
					i() && this.isRegisteredChannel(e) && (this.completeChannelRaw(e, t, n), e.consecutiveSyscalls = 0, this.relistenChannel(e));
				}, l = () => {
					Atomics.notify(o, a);
				}, h = (e, t) => {
					l(), c(e, t);
				}, d = () => {
					l(), i();
				};
				this.pendingFutexWaits.set(e, {
					futexIndex: a,
					interrupt: h,
					retire: d
				}), s.value.then(() => {
					c(0, 0);
				}), void 0 !== n && (t = setTimeout(() => {
					h(-110, 110);
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
	finalizeThreadExit(e, t, n) {
		const r = `${e}:${n}`;
		this.channelTids.delete(r), this.threadForkContexts.delete(r);
		const i = `${e}:${t}`, s = this.threadCtidPtrs.get(i);
		if (s && 0 !== s) {
			this.threadCtidPtrs.delete(i);
			const t = this.activeChannels.find((t) => t.pid === e && t.channelOffset === n)?.memory ?? this.processes.get(e)?.memory;
			if (t) {
				new DataView(t.buffer).setInt32(s, 0, !0);
				const e = new Int32Array(t.buffer);
				Atomics.notify(e, s >>> 2, 1);
			}
		}
		this.notifyThreadExit(e, t), this.removeChannel(e, n);
	}
	firePosixTimer(e, t, n) {
		const r = (0, this.kernelInstance.exports.kernel_posix_timer_fire)(e, t);
		r < 0 || (r > 0 ? this.wakePendingSignalWaits(e, n, r) : (this.wakePendingSignalWaits(e, n), this.sendSignalToProcess(e, n, !1)));
	}
	wakePendingSignalWaits(e, t, n) {
		const r = Array.from(this.pendingSignalWaits.entries()).filter(([, r]) => {
			if (r.channel.pid !== e) return !1;
			if (void 0 !== n && this.guestTidForChannel(r.channel) !== n) return !1;
			const i = r.origArgs[0] >>> 0;
			return !(0 === i || t <= 0 || t > 64) && 0n != (new DataView(r.channel.memory.buffer).getBigUint64(i, !0) & 1n << BigInt(t - 1));
		});
		for (const [i, s] of r) this.pendingSignalWaits.get(i) === s && (clearTimeout(s.timer), this.pendingSignalWaits.delete(i), this.isRegisteredChannel(s.channel) && this.retrySyscall(s.channel));
	}
	cleanupPendingSignalWaits(e) {
		for (const [t, n] of this.pendingSignalWaits ?? []) n.channel.pid === e && (clearTimeout(n.timer), this.pendingSignalWaits.delete(t), this.signalWaitDeadlines?.delete(t));
		for (const [t, n] of this.signalWaitDeadlines ?? []) n.pid === e && this.signalWaitDeadlines.delete(t);
	}
	sendSignalToProcess(e, t, n = !0) {
		if (!this.kernelInstance || !this.kernelMemory) return;
		if (n) {
			const n = new DataView(this.kernelMemory.buffer, this.scratchOffset);
			n.setUint32(4, mr, !0), n.setBigInt64(8, BigInt(e), !0), n.setBigInt64(16, BigInt(t), !0);
			for (let e = 2; e < 6; e++) n.setBigInt64(8 + 8 * e, 0n, !0);
			const r = this.kernelInstance.exports.kernel_handle_channel;
			this.currentHandlePid = e;
			const i = this.kernelInstance.exports.kernel_set_current_tid;
			i && i(0);
			try {
				r(this.toKernelPtr(this.scratchOffset), e);
			} catch (Zi) {
				console.error(`[sendSignalToProcess] kernel threw for pid=${e} sig=${t}: ${Zi}`);
				return;
			} finally {
				this.currentHandlePid = 0;
			}
		}
		if (n && this.wakePendingSignalWaits(e, t), this.drainAndProcessWakeupEvents(), this.reapKilledProcessesAfterSyscall(), this.getProcessExitSignal(e) > 0) return;
		if (this.interruptWaitingChildForSignal(e, t)) return;
		const r = (0, this.kernelInstance.exports.kernel_pick_signal_target_tid)(e, t);
		if (r <= 0) return;
		if ((0, this.kernelInstance.exports.kernel_thread_has_deliverable)(e, r) <= 0) return;
		const i = Array.from(this.pendingSleeps.entries()).find(([t]) => t.pid === e && this.guestTidForChannel(t) === r);
		if (i) {
			const [e, t] = i;
			clearTimeout(t.timer), this.pendingSleeps.delete(e), this.completeSleepWithSignalCheck(t.channel, t.syscallNr, t.origArgs, t.retVal, t.errVal);
		}
		const s = Array.from(this.pendingPollRetries.entries()).filter(([, t]) => t.channel.pid === e);
		for (const [l, h] of s) this.pendingPollRetries.get(l) === h && (h.timer && clearTimeout(h.timer), this.pendingPollRetries.delete(l), this.processes.has(e) && this.retrySyscall(h.channel));
		const o = this.pendingAdvisoryLockRetries, a = o ? Array.from(o.entries()).filter(([, t]) => t.channel.pid === e) : [];
		for (const [l, h] of a) o.get(l) === h && (clearTimeout(h.timer), o.delete(l), this.isRegisteredChannel(h.channel) && this.retrySyscall(h.channel));
		const c = Array.from(this.pendingSelectRetries.entries()).filter(([, t]) => t.channel.pid === e);
		for (const [l, h] of c) this.pendingSelectRetries.get(l) === h && (clearTimeout(h.timer), clearImmediate(h.timer), this.pendingSelectRetries.delete(l), this.processes.has(e) && (h.syscallNr === cr ? this.handleSelect(h.channel, h.origArgs) : this.handlePselect6(h.channel, h.origArgs)));
	}
	ensureFixedMmapProcessMemoryCapacity(e, t) {
		const n = t[0] >>> 0, r = n + (t[1] >>> 0);
		if (!Number.isSafeInteger(r) || r < n) return !1;
		if (r <= e.memory.buffer.byteLength) return !0;
		try {
			const t = this.processes.get(e.pid)?.ptrWidth ?? 4;
			return Gn(e.memory, r, t), e.memory.buffer.byteLength < r ? !1 : (this.kernel.framebuffers.rebindMemory(e.pid), !0);
		} catch {
			return !1;
		}
	}
	ensureProcessMemoryCovers(e, t, n, r, i) {
		let s = 0, o = 0, a = 0;
		n === Hr ? r >= 0 && (s = r) : n === Br ? r >= 0 && (o = r, a = i[1], s = o + a) : n === Fr && r >= 0 && (o = r, a = i[2], s = o + a);
		const c = t.buffer.byteLength;
		if (s > 0 && s > c) Gn(t, s, this.processes.get(e)?.ptrWidth ?? 4), this.kernel.framebuffers.rebindMemory(e);
		if (a > 0) {
			const e = 65536, r = Math.ceil(a / e) * e, s = t.buffer.byteLength;
			let c = o;
			const l = Math.min(o + r, s);
			if (n === Fr) {
				const t = i[0] >>> 0, n = i[1] >>> 0;
				if (o === t && n > 0) {
					const r = Math.ceil((t + n) / e) * e;
					c = Math.max(c, r);
				}
			}
			c < l && new Uint8Array(t.buffer, c, l - c).fill(0);
		}
		if (n === Fr && r >= 0 && r !== i[0] && 0 !== i[0] && i[1] > 0) {
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
	trackAnonymousSharedMapping(e, t, n) {
		const r = n[1] >>> 0;
		if (0 === r) return;
		const i = new Uint8Array(e.memory.buffer);
		if (t + r > i.length) return;
		const s = `anon:${e.pid}:${t}:${this.nextAnonymousSharedBackingId++}`, o = i.slice(t, t + r);
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
			len: r,
			writable: !!(2 & n[2]),
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
		const n = this.sharedMappings?.get(e.pid);
		if (!n) return;
		const r = new Uint8Array(e.memory.buffer);
		for (const [i, s] of n) {
			if (!s.backingKey || !s.snapshot) continue;
			const e = this.anonymousSharedBackings?.get(s.backingKey);
			if (!e || i + s.len > r.length) continue;
			const n = (s.seenVersion ?? 0) !== e.version;
			if (!t.force && e.refCount <= 1 && !n) continue;
			let o = !1;
			if (s.writable) for (let t = 0; t < s.len; t += 4096) {
				const n = Math.min(4096, s.len - t);
				this.rangeDiffersFromSnapshot(r, i + t, s.snapshot, t, n) && this.mergeChangedByteRuns(r, i + t, s.snapshot, t, e.bytes, s.fileOffset + t, n) && (o = !0);
			}
			if (o && e.version++, o || n) {
				const t = e.bytes.slice(s.fileOffset, s.fileOffset + s.len);
				r.set(t, i), s.snapshot = t;
			}
			s.seenVersion = e.version;
		}
	}
	mapSharedMmapFromFile(e, t, n) {
		if (n[1] >>> 0 == 0) return { kind: "mapped" };
		const r = this.prepareSharedMmapFromFile(e, n);
		return "prepared" !== r.kind ? r : this.registerPreparedSharedMmap(e, t, r.context);
	}
	prepareSharedMmapFromFile(e, t) {
		const n = t[4], r = t[1] >>> 0, i = t[5], s = i * ci;
		if (!Number.isSafeInteger(i) || i < 0 || !Number.isSafeInteger(s)) return {
			kind: "error",
			errno: Zn
		};
		const o = !!(2 & t[2]), a = this.getFdStatForSharedMapping(e, n);
		if ("error" === a.kind) return a;
		const c = a.value;
		if (32768 != (61440 & c.mode)) return { kind: "unsupported" };
		if (null === c.hostHandle) return {
			kind: "error",
			errno: 95
		};
		const l = this.getFdAccessModeForSharedMapping(e, n);
		if ("error" === l.kind) return l;
		const h = l.value;
		if (1 === h) return {
			kind: "error",
			errno: 13
		};
		const d = 2 === h && this.fdSupportsMmapWriteback(e.pid, n);
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
			this.publishSharedMmapBackingObservers(g), this.ensureSharedMmapBackingRangeLoaded(g, s, r);
		} catch (Zi) {
			return this.discardUnreferencedSharedMmapBacking(g), {
				kind: "error",
				errno: this.sharedMmapErrno(Zi)
			};
		}
		return g.refCount++, {
			kind: "prepared",
			context: {
				fd: n,
				fileOffset: s,
				len: r,
				writable: o,
				writeAllowed: d,
				backing: g
			}
		};
	}
	registerPreparedSharedMmap(e, t, n) {
		const { fd: r, fileOffset: i, len: s, writable: o, writeAllowed: a, backing: c } = n;
		try {
			const l = new Uint8Array(e.memory.buffer);
			if (t + s > l.length) return this.releasePreparedSharedMmap(n), {
				kind: "error",
				errno: 5
			};
			const h = this.readSharedMmapBackingRange(c, i, s);
			l.set(h, t);
			let d = this.sharedMappings.get(e.pid);
			return d || (d = /* @__PURE__ */ new Map(), this.sharedMappings.set(e.pid, d)), this.sharedMmapFdCache.set(this.sharedMmapFdCacheKey(e.pid, r), { backingKey: c.key }), d.set(t, {
				fd: r,
				fileOffset: i,
				len: s,
				writable: o,
				writeAllowed: a,
				backingKind: "file",
				backingKey: c.key,
				snapshot: h,
				seenVersion: c.version
			}), { kind: "mapped" };
		} catch (Zi) {
			return this.releasePreparedSharedMmap(n), {
				kind: "error",
				errno: this.sharedMmapErrno(Zi)
			};
		}
	}
	resolveSharedMmapBackingKey(e, t) {
		try {
			const n = this.io.fileHandleIdentity?.(t, e.dev, e.ino) ?? null;
			return n ? {
				kind: "ok",
				value: n
			} : {
				kind: "error",
				errno: 95
			};
		} catch (Zi) {
			return {
				kind: "error",
				errno: this.sharedMmapErrno(Zi)
			};
		}
	}
	getFdStatForSharedMapping(e, t) {
		const n = this.kernelInstance.exports.kernel_handle_channel, r = this.scratchOffset + 72, i = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		i.setUint32(4, pe, !0), i.setBigInt64(8, BigInt(t), !0), i.setBigInt64(16, BigInt(r), !0);
		for (let g = 2; g < 6; g++) i.setBigInt64(8 + 8 * g, 0n, !0);
		const s = this.currentHandlePid;
		let o = null;
		this.currentHandlePid = e.pid;
		try {
			this.bindKernelTidForChannel(e), o = this.kernel.withFstatHandleCapture(() => n(this.toKernelPtr(this.scratchOffset), e.pid)).handle;
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
		const h = new DataView(this.kernelMemory.buffer, r), d = h.getBigUint64(0, !0), f = h.getBigUint64(8, !0), u = h.getUint32(16, !0), p = h.getBigUint64(32, !0);
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
		const n = this.kernelInstance.exports.kernel_get_fd_path;
		if (!n) return {
			kind: "error",
			errno: 38
		};
		const r = this.scratchOffset + 72;
		let i;
		try {
			i = n(e.pid, t, this.toKernelPtr(r), Math.min(4096, ee));
		} catch {
			return {
				kind: "error",
				errno: 5
			};
		}
		return i < 0 ? {
			kind: "error",
			errno: -i
		} : 0 === i ? {
			kind: "error",
			errno: 2
		} : {
			kind: "ok",
			value: new TextDecoder().decode(new Uint8Array(this.kernelMemory.buffer).slice(r, r + i))
		};
	}
	getFdAccessModeForSharedMapping(e, t) {
		const n = this.kernelInstance.exports.kernel_handle_channel, r = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		r.setUint32(4, gi, !0), r.setBigInt64(8, BigInt(t), !0), r.setBigInt64(16, BigInt(3), !0);
		for (let c = 2; c < 6; c++) r.setBigInt64(8 + 8 * c, 0n, !0);
		const i = this.currentHandlePid;
		this.currentHandlePid = e.pid;
		try {
			this.bindKernelTidForChannel(e), n(this.toKernelPtr(this.scratchOffset), e.pid);
		} catch {
			return {
				kind: "error",
				errno: 5
			};
		} finally {
			this.currentHandlePid = i;
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
	getOrCreateSharedMmapBacking(e, t, n) {
		const r = t.hostHandle;
		if (null === r) return {
			kind: "error",
			errno: 95
		};
		const i = this.sharedMmapBackings.get(e);
		if (i) {
			if (n && !i.writable) {
				if (r === i.handle) return {
					kind: "error",
					errno: 5
				};
				try {
					this.kernel.retainHostFileHandle(r);
				} catch (Zi) {
					return {
						kind: "error",
						errno: this.sharedMmapErrno(Zi)
					};
				}
				const e = i.handle;
				i.handle = r, i.writable = !0, i.size = t.size, i.sizeValid = !0, this.kernel.releaseHostFileHandle(e);
			} else {
				const e = this.revalidateSharedMmapBacking(i);
				if (0 !== e) return {
					kind: "error",
					errno: e
				};
			}
			return {
				kind: "ok",
				value: i
			};
		}
		try {
			this.kernel.retainHostFileHandle(r);
		} catch (Zi) {
			return {
				kind: "error",
				errno: this.sharedMmapErrno(Zi)
			};
		}
		const s = {
			key: e,
			handle: r,
			writable: n,
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
			const n = this.resolveSharedMmapBackingKey({
				dev: BigInt(t.dev),
				ino: BigInt(t.ino),
				mode: t.mode,
				size: t.size,
				hostHandle: e.handle
			}, e.handle);
			return "error" === n.kind || n.value !== e.key ? (e.sizeValid = !1, "error" === n.kind ? n.errno : 5) : (e.size = t.size, e.sizeValid = !0, 0);
		} catch (Zi) {
			return e.sizeValid = !1, this.sharedMmapErrno(Zi);
		}
	}
	sharedMmapErrno(e) {
		const t = Cn(e);
		return t < 0 ? -t : t || 5;
	}
	discardUnreferencedSharedMmapBacking(e) {
		0 === e.refCount && this.sharedMmapBackings.get(e.key) === e && (e.dirtyPages.size > 0 || (this.kernel.releaseHostFileHandle(e.handle), this.sharedMmapBackings.delete(e.key), this.invalidateSharedMmapFdCache()));
	}
	ensureSharedMmapBackingRangeLoaded(e, t, n) {
		if (n <= 0) return;
		const r = Math.floor(t / ci), i = Math.floor((t + n - 1) / ci);
		for (let s = r; s <= i; s++) this.ensureSharedMmapBackingPageLoaded(e, s);
	}
	ensureSharedMmapBackingPageLoaded(e, t) {
		const n = e.pages.get(t);
		if (n) return n;
		if (!e.sizeValid) {
			const t = this.revalidateSharedMmapBacking(e);
			if (0 !== t) {
				const e = /* @__PURE__ */ new Error("Cannot determine MAP_SHARED backing size");
				throw e.code = t, e;
			}
		}
		const r = this.readSharedMmapBackingPage(e, t);
		return e.pages.set(t, r), r;
	}
	readSharedMmapBackingPage(e, t) {
		const n = new Uint8Array(ci);
		if (!e.sizeValid) throw new Error("Unknown MAP_SHARED backing size");
		const r = t * ci, i = Math.max(0, Math.min(ci, e.size - r));
		if (0 === i) return n;
		let s = 0;
		for (; s < i;) {
			const t = i - s, o = this.io.read(e.handle, n.subarray(s), r + s, t);
			if (o <= 0 || o > t) throw new Error(`Invalid MAP_SHARED backing read length: ${o}`);
			s += o;
		}
		return n;
	}
	readSharedMmapBackingRange(e, t, n) {
		const r = new Uint8Array(n);
		let i = 0;
		for (; i < n;) {
			const s = t + i, o = Math.floor(s / ci), a = s % ci, c = Math.min(ci - a, n - i);
			r.set(this.ensureSharedMmapBackingPageLoaded(e, o).subarray(a, a + c), i), i += c;
		}
		return r;
	}
	copyRangeToSharedMmapBacking(e, t, n, r) {
		let i = 0;
		for (; i < n.length;) {
			const s = t + i, o = Math.floor(s / ci), a = s % ci, c = Math.min(ci - a, n.length - i), l = e.dirtyPages.has(o);
			this.ensureSharedMmapBackingPageLoaded(e, o).set(n.subarray(i, i + c), a), r ? e.dirtyPages.add(o) : l || e.dirtyPages.delete(o), i += c;
		}
	}
	syncFileSharedMappingsFromProcess(e, t = {}) {
		const n = this.sharedMappings?.get(e.pid);
		if (!n) return;
		const r = new Uint8Array(e.memory.buffer), i = [];
		for (const [o, a] of n) {
			if ("file" !== a.backingKind || !a.backingKey || !a.snapshot) continue;
			const e = this.sharedMmapBackings.get(a.backingKey);
			if (!e || o + a.len > r.length) continue;
			const n = (a.seenVersion ?? 0) !== e.version;
			!t.force && e.refCount <= 1 && !n || i.push({
				mapAddr: o,
				mapping: a,
				backing: e,
				snapshot: a.snapshot
			});
		}
		for (const { mapAddr: o, mapping: a, backing: c, snapshot: l } of i) {
			let e = !1;
			if (a.writable) for (let t = 0; t < a.len; t += ci) {
				const n = Math.min(ci, a.len - t);
				this.rangeDiffersFromSnapshot(r, o + t, l, t, n) && this.mergeChangedFileMappingRuns(c, r, o + t, l, t, a.fileOffset + t, n) && (e = !0);
			}
			e && c.version++;
		}
		const s = i.filter(({ mapping: e, backing: t }) => (e.seenVersion ?? 0) !== t.version).map(({ mapAddr: e, mapping: t, backing: n }) => ({
			mapAddr: e,
			mapping: t,
			backing: n,
			latest: this.readSharedMmapBackingRange(n, t.fileOffset, t.len)
		}));
		for (const { mapAddr: o, mapping: a, backing: c, latest: l } of s) r.set(l, o), a.snapshot = l, a.seenVersion = c.version;
	}
	publishSharedMmapBackingObservers(e) {
		if (e.refCount <= 0) return;
		const t = /* @__PURE__ */ new Set();
		for (const [n, r] of this.sharedMappings) for (const i of r.values()) if ("file" === i.backingKind && i.backingKey === e.key) {
			t.add(n);
			break;
		}
		for (const n of t) {
			const e = this.processes.get(n);
			if (!e) throw new Error(`Missing process memory for MAP_SHARED observer ${n}`);
			this.syncFileSharedMappingsFromProcess(e, { force: !0 });
		}
	}
	mergeChangedFileMappingRuns(e, t, n, r, i, s, o) {
		let a = !1, c = 0;
		for (; c < o;) {
			for (; c < o && t[n + c] === r[i + c];) c++;
			if (c >= o) break;
			const l = c;
			do
				c++;
			while (c < o && t[n + c] !== r[i + c]);
			this.copyRangeToSharedMmapBacking(e, s + l, t.subarray(n + l, n + c), !0), a = !0;
		}
		return a;
	}
	flushSharedMmapBackingRange(e, t, n) {
		if (n <= 0 || 0 === e.dirtyPages.size) return !0;
		if (!e.sizeValid) return !1;
		const r = t + n, i = Math.min(r, e.size);
		let s = !0;
		for (const o of Array.from(e.dirtyPages).sort((e, t) => e - t)) {
			const n = o * ci, a = n + ci;
			if (n >= e.size) {
				n < r && a > t && e.dirtyPages.delete(o);
				continue;
			}
			if (n >= i || a <= t) continue;
			const c = Math.max(t, n), l = Math.min(a, e.size), h = Math.min(i, l), d = this.ensureSharedMmapBackingPageLoaded(e, o).subarray(c - n, h - n);
			this.writeAllToSharedMmapBacking(e, d, c) ? c === n && h === l && e.dirtyPages.delete(o) : s = !1;
		}
		return s;
	}
	writeAllToSharedMmapBacking(e, t, n) {
		let r = 0;
		for (; r < t.length;) try {
			const i = this.io.write(e.handle, t.subarray(r), n + r, t.length - r);
			if (i <= 0) return !1;
			r += i;
		} catch {
			return !1;
		}
		return !0;
	}
	flushSharedMappingsBeforeFileSyscall(e, t, n) {
		if (0 === (this.sharedMmapBackings?.size ?? 0)) return !0;
		try {
			if (t === Gr) {
				const t = this.resolveSharedMmapPath(e, n[0]);
				return "error" === t.kind || this.flushSharedBackingForPath(t.value);
			}
			if ((t === bi || t === ki) && 512 & (t === bi ? n[1] : n[2])) {
				const r = this.resolveSharedMmapPath(e, t === bi ? n[0] : n[1], t === ki ? n[0] : li);
				return "error" === r.kind || this.flushSharedBackingForPath(r.value);
			}
			return t !== Br || 1 & n[3] || 32 & n[3] || !(n[4] >= 0) ? t === Xr ? (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, n[0]) && this.flushSharedBackingForFd(e, n[1])) : 290 === t || 291 === t ? (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, n[0]) && this.flushSharedBackingForFd(e, n[2])) : !this.syscallTouchesFdStorageBeforeKernel(t) || (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, n[0])) : (this.syncFileSharedMappingsFromProcess(e, { force: !0 }), this.flushSharedBackingForFd(e, n[4]));
		} catch {
			return !1;
		}
	}
	syscallTouchesFdStorageBeforeKernel(e) {
		return e === $r || e === Or || e === fi || e === ui || e === Dr || e === Nr || e === di || e === pi || e === Kr || e === Vr || e === qr || e === jr;
	}
	flushSharedBackingForFd(e, t) {
		if (t < 0) return !0;
		const n = this.findSharedMmapBackingForFd(e, t);
		if (!n) return !0;
		this.publishSharedMmapBackingObservers(n);
		const r = this.flushSharedMmapBackingRange(n, 0, Number.MAX_SAFE_INTEGER);
		return r && 0 === n.refCount && this.discardUnreferencedSharedMmapBacking(n), r;
	}
	resolveSharedMmapPath(e, t, n = -100) {
		try {
			const r = new Uint8Array(e.memory.buffer);
			if (t <= 0 || t >= r.length) return {
				kind: "error",
				errno: Yn
			};
			const i = Math.min(r.length, t + 4096);
			let s = t;
			for (; s < i && 0 !== r[s];) s++;
			if (s === i) return {
				kind: "error",
				errno: 36
			};
			const o = new Uint8Array(s - t);
			o.set(r.subarray(t, s));
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
			if (n !== li) {
				const t = this.getFdPathForSharedMapping(e, n);
				if ("error" === t.kind) return t;
				c = t.value;
			} else {
				const t = this.kernelInstance.exports.kernel_get_cwd;
				if (!t) return {
					kind: "error",
					errno: 38
				};
				const n = t(e.pid, this.toKernelPtr(this.scratchOffset), Math.min(4096, ee));
				if (n < 0) return {
					kind: "error",
					errno: -n
				};
				if (0 === n) return {
					kind: "error",
					errno: 2
				};
				c = new TextDecoder().decode(new Uint8Array(this.kernelMemory.buffer).slice(this.scratchOffset, this.scratchOffset + n));
			}
			return {
				kind: "ok",
				value: this.normalizeSharedMmapPath(`${c}/${a}`)
			};
		} catch (Zi) {
			return {
				kind: "error",
				errno: this.sharedMmapErrno(Zi)
			};
		}
	}
	normalizeSharedMmapPath(e) {
		const t = [];
		for (const n of e.split("/")) n && "." !== n && (".." === n ? t.pop() : t.push(n));
		return `/${t.join("/")}`;
	}
	findSharedMmapBackingForPath(e) {
		if (0 === this.sharedMmapBackings.size) return null;
		try {
			const t = this.io.stat(e);
			if (32768 != (61440 & t.mode)) return null;
			const n = this.io.fileIdentity?.(e, BigInt(t.dev), BigInt(t.ino)) ?? null;
			return n ? this.sharedMmapBackings.get(n) ?? null : null;
		} catch {
			return null;
		}
	}
	flushSharedBackingForPath(e) {
		const t = this.findSharedMmapBackingForPath(e);
		if (!t) return !0;
		this.publishSharedMmapBackingObservers(t);
		const n = this.flushSharedMmapBackingRange(t, 0, Number.MAX_SAFE_INTEGER);
		return n && 0 === t.refCount && this.discardUnreferencedSharedMmapBacking(t), n;
	}
	handleSharedMappingsAfterFileSyscall(e, t, n, r, i) {
		if (0 !== (this.sharedMmapBackings?.size ?? 0) && 0 === i) {
			if ((t === bi || t === ki) && r >= 0) return this.invalidateSharedMmapFdCache(e.pid, r), void (512 & (t === bi ? n[1] : n[2]) && this.reloadSharedMmapBackingForFd(e, r, 0));
			if (t !== vi || 0 !== r) if (t === Yr && r >= 0) this.invalidateSharedMmapFdCache(e.pid, r);
			else if ((t === Zr || t === Jr) && r >= 0) this.invalidateSharedMmapFdCache(e.pid, n[1]);
			else {
				if (t === gi && r >= 0) {
					const t = n[1] >>> 0;
					if (0 === t || 1030 === t || 1028 === t) return void this.invalidateSharedMmapFdCache(e.pid, r);
				}
				if (t === Nr && r > 0) this.updateSharedMmapBackingFromProcessBuffer(e, n[0], n[1] >>> 0, r, n[3]);
				else if (t === Dr && r > 0) this.reloadSharedMmapBackingForFd(e, n[0]);
				else if ((t === di || t === pi) && r > 0) this.reloadSharedMmapBackingForFd(e, n[0]);
				else if (t === Xr && r > 0) this.reloadSharedMmapBackingForFd(e, n[0]);
				else if ((290 === t || 291 === t) && r > 0) this.reloadSharedMmapBackingForFd(e, n[2]);
				else if (t !== qr || 0 !== r) if (t !== jr || 0 !== r) {
					if (t === Gr && 0 === r) {
						const t = this.resolveSharedMmapPath(e, n[0]);
						"ok" === t.kind && this.reloadSharedMmapBackingForPath(t.value, n[1]);
					}
				} else this.reloadSharedMmapBackingForFd(e, n[0]);
				else this.reloadSharedMmapBackingForFd(e, n[0], n[1]);
			}
			else this.invalidateSharedMmapFdCache(e.pid, n[0]);
		}
	}
	updateSharedMmapBackingFromProcessBuffer(e, t, n, r, i) {
		if (r <= 0) return;
		const s = this.findSharedMmapBackingForFd(e, t);
		if (!s) return;
		if (!Number.isSafeInteger(i) || i < 0 || !Number.isSafeInteger(i + r)) return s.sizeValid = !1, void this.invalidateSharedMmapBackingPages(s);
		if (0 !== this.revalidateSharedMmapBacking(s)) return void this.invalidateSharedMmapBackingPages(s);
		const o = new Uint8Array(e.memory.buffer);
		if (n + r > o.length) this.reloadSharedMmapBackingRange(s, i, r);
		else try {
			this.copyRangeToSharedMmapBacking(s, i, o.subarray(n, n + r), !1), s.version++;
		} catch {
			this.invalidateSharedMmapBackingRange(s, i, r);
		}
	}
	reloadSharedMmapBackingForFd(e, t, n) {
		const r = this.findSharedMmapBackingForFd(e, t);
		return !r || this.reloadSharedMmapBacking(r, n);
	}
	reloadSharedMmapBackingForPath(e, t) {
		const n = this.findSharedMmapBackingForPath(e);
		return !n || this.reloadSharedMmapBacking(n, t);
	}
	reloadSharedMmapBacking(e, t) {
		if (void 0 !== t && Number.isSafeInteger(t) && t >= 0) e.size = t, e.sizeValid = !0;
		else if (0 !== this.revalidateSharedMmapBacking(e)) return this.invalidateSharedMmapBackingPages(e), !1;
		if (0 === e.pages.size) return e.version++, !0;
		const n = Array.from(e.pages.keys()), r = /* @__PURE__ */ new Map();
		try {
			for (const t of n) r.set(t, this.readSharedMmapBackingPage(e, t));
		} catch {
			return this.invalidateSharedMmapBackingPages(e, n), !1;
		}
		for (const [i, s] of r) e.pages.set(i, s), e.dirtyPages.delete(i);
		return e.version++, !0;
	}
	reloadSharedMmapBackingRange(e, t, n) {
		if (n <= 0) return !0;
		const r = Math.floor(t / ci), i = Math.floor((t + n - 1) / ci), s = /* @__PURE__ */ new Map();
		try {
			for (let t = r; t <= i; t++) e.pages.has(t) && s.set(t, this.readSharedMmapBackingPage(e, t));
		} catch {
			return this.invalidateSharedMmapBackingPages(e, Array.from({ length: i - r + 1 }, (e, t) => r + t)), !1;
		}
		for (const [o, a] of s) e.pages.set(o, a), e.dirtyPages.delete(o);
		return s.size > 0 && e.version++, !0;
	}
	invalidateSharedMmapBackingRange(e, t, n) {
		if (n <= 0) return;
		const r = Math.floor(t / ci), i = Math.floor((t + n - 1) / ci);
		this.invalidateSharedMmapBackingPages(e, Array.from({ length: i - r + 1 }, (e, t) => r + t));
	}
	invalidateSharedMmapBackingPages(e, t = Array.from(e.pages.keys())) {
		for (const n of t) e.dirtyPages.has(n) || e.pages.delete(n);
		e.version++;
	}
	findSharedMmapBackingForFd(e, t) {
		if (0 === this.sharedMmapBackings.size || t < 0) return null;
		const n = this.sharedMmapFdCacheKey(e.pid, t), r = this.sharedMmapFdCache.get(n);
		if (void 0 !== r) return r.backingKey ? this.sharedMmapBackings.get(r.backingKey) ?? null : null;
		const i = this.getFdStatForSharedMapping(e, t);
		if ("error" === i.kind) return 9 === i.errno && this.sharedMmapFdCache.set(n, { backingKey: null }), null;
		if (32768 != (61440 & i.value.mode)) return this.sharedMmapFdCache.set(n, { backingKey: null }), null;
		const s = i.value.hostHandle, o = null === s ? {
			kind: "error",
			errno: 95
		} : this.resolveSharedMmapBackingKey(i.value, s);
		if ("error" === o.kind) return 9 !== o.errno && 95 !== o.errno || this.sharedMmapFdCache.set(n, { backingKey: null }), null;
		const a = this.sharedMmapBackings.get(o.value);
		return a ? (this.sharedMmapFdCache.set(n, { backingKey: a.key }), a) : (this.sharedMmapFdCache.set(n, { backingKey: null }), null);
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
		for (const n of this.sharedMmapFdCache.keys()) n.startsWith(t) && this.sharedMmapFdCache.delete(n);
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
	mergeChangedByteRuns(e, t, n, r, i, s, o) {
		let a = !1, c = 0;
		for (; c < o;) {
			for (; c < o && e[t + c] === n[r + c];) c++;
			if (c >= o) break;
			const l = c;
			do
				c++;
			while (c < o && e[t + c] !== n[r + c]);
			i.set(e.subarray(t + l, t + c), s + l), a = !0;
		}
		return a;
	}
	rangeDiffersFromSnapshot(e, t, n, r, i) {
		const s = e.byteOffset + t, o = n.byteOffset + r;
		if (!(3 & (s | o | i))) {
			const t = new Uint32Array(e.buffer, s, i / 4), r = new Uint32Array(n.buffer, o, i / 4);
			for (let e = 0; e < t.length; e++) if (t[e] !== r[e]) return !0;
			return !1;
		}
		for (let a = 0; a < i; a++) if (e[t + a] !== n[r + a]) return !0;
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
		const n = this.processes.get(t);
		if (!n) throw new Error(`Process ${t} is not registered`);
		try {
			const r = this.sharedMappings.get(e);
			if (r) {
				const e = new Uint8Array(n.memory.buffer), i = /* @__PURE__ */ new Map();
				this.sharedMappings.set(t, i);
				for (const [t, n] of r) {
					if (!n.backingKey) continue;
					const r = "file" !== n.backingKind ? this.anonymousSharedBackings.get(n.backingKey) : void 0, s = "file" === n.backingKind ? this.sharedMmapBackings.get(n.backingKey) : void 0;
					if (!r && !s || t + n.len > e.length) throw new Error(`Cannot inherit shared mapping at 0x${t.toString(16)}`);
					const o = r ? r.bytes.slice(n.fileOffset, n.fileOffset + n.len) : this.readSharedMmapBackingRange(s, n.fileOffset, n.len);
					e.set(o, t);
					const a = r?.version ?? s.version;
					r ? r.refCount++ : s.refCount++, i.set(t, {
						...n,
						snapshot: o,
						seenVersion: a
					});
				}
				0 === i.size && this.sharedMappings.delete(t);
			}
			this.inheritSysvShmMappings(e, t);
		} catch (Zi) {
			throw this.releaseAllSharedMemoryForProcess(t, !1), Zi;
		}
	}
	populateMmapFromFile(e, t, n) {
		const r = n[4], i = n[1];
		let s = 4096 * n[5];
		const o = this.kernelInstance.exports.kernel_handle_channel, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = new Uint8Array(this.kernelMemory.buffer), l = this.scratchOffset + 72;
		let h = 0;
		for (; h < i;) {
			const n = Math.min(ee, i - h);
			a.setUint32(4, Or, !0), a.setBigInt64(8, BigInt(r), !0), a.setBigInt64(16, BigInt(l), !0), a.setBigInt64(24, BigInt(n), !0), a.setBigInt64(32, BigInt(s), !0), a.setBigInt64(40, 0n, !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
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
			if (new Uint8Array(e.memory.buffer).set(c.subarray(l, l + d), t + h), h += d, s += d, d < n) break;
		}
	}
	flushSharedMappings(e, t) {
		try {
			this.syncAnonymousSharedMappingsFromProcess(e, { force: !0 }), this.syncFileSharedMappingsFromProcess(e, { force: !0 });
		} catch {
			return !1;
		}
		const n = t[0] >>> 0, r = t[1] >>> 0, i = this.sharedMappings.get(e.pid);
		if (!i || 0 === i.size) return !0;
		const s = n + r;
		let o = !0;
		for (const [a, c] of i) {
			const t = a + c.len;
			if (a >= s || t <= n) continue;
			const r = Math.max(n, a), i = Math.min(s, t) - r;
			if (i <= 0) continue;
			const l = c.fileOffset + (r - a);
			if ("file" === c.backingKind && c.backingKey) {
				const e = this.sharedMmapBackings.get(c.backingKey);
				e && this.flushSharedMmapBackingRange(e, l, i) || (o = !1);
				continue;
			}
			c.writable && (c.backingKey || this.pwriteFromProcessMemory(e, c.fd, r, i, l) || (o = !1));
		}
		return o;
	}
	pwriteFromProcessMemory(e, t, n, r, i) {
		const s = this.kernelInstance.exports.kernel_handle_channel, o = this.scratchOffset + 72;
		if (n + r > e.memory.buffer.byteLength) return !1;
		const a = this.currentHandlePid;
		try {
			let a = 0;
			for (; a < r;) {
				const c = Math.min(ee, r - a), l = new DataView(this.kernelMemory.buffer, this.scratchOffset), h = new Uint8Array(this.kernelMemory.buffer), d = new Uint8Array(e.memory.buffer);
				h.set(d.subarray(n + a, n + a + c), o);
				const f = i + a;
				if (l.setUint32(4, Nr, !0), l.setBigInt64(8, BigInt(t), !0), l.setBigInt64(16, BigInt(o), !0), l.setBigInt64(24, BigInt(c), !0), l.setBigInt64(32, BigInt(f), !0), l.setBigInt64(40, 0n, !0), l.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e), s(this.toKernelPtr(this.scratchOffset), e.pid), this.finishSignalTermination(e)) return !1;
				const u = new DataView(this.kernelMemory.buffer, this.scratchOffset), p = Number(u.getBigInt64(56, !0));
				if (p <= 0 || p > c) return !1;
				if (a += p, p < c) return !1;
			}
			return a === r;
		} catch {
			return !1;
		} finally {
			this.currentHandlePid = a;
		}
	}
	cleanupSharedMappings(e, t, n) {
		const r = this.sharedMappings.get(e);
		if (!r) return;
		const i = t + n;
		for (const [s, o] of Array.from(r.entries())) {
			const e = s + o.len, n = Math.max(t, s), a = Math.min(i, e);
			if (n >= a) continue;
			if (n <= s && a >= e) {
				this.releaseSharedMapping(o), r.delete(s);
				continue;
			}
			if (n <= s) {
				const t = a - s;
				r.delete(s), o.fileOffset += t, o.len = e - a, o.snapshot && (o.snapshot = o.snapshot.slice(t)), o.len > 0 ? r.set(a, o) : this.releaseSharedMapping(o);
				continue;
			}
			if (a >= e) {
				o.len = n - s, o.snapshot && (o.snapshot = o.snapshot.slice(0, o.len));
				continue;
			}
			const c = n - s, l = a - s, h = {
				...o,
				fileOffset: o.fileOffset + l,
				len: e - a,
				...o.snapshot ? { snapshot: o.snapshot.slice(l) } : {}
			};
			if (o.len = c, o.snapshot && (o.snapshot = o.snapshot.slice(0, c)), o.backingKey) {
				const e = "file" === o.backingKind ? this.sharedMmapBackings.get(o.backingKey) : this.anonymousSharedBackings.get(o.backingKey);
				e && e.refCount++;
			}
			r.set(a, h);
		}
		0 === r.size && this.sharedMappings.delete(e);
	}
	preflightFileSharedMremap(e, t) {
		const n = t[0] >>> 0, r = t[2] >>> 0, i = this.sharedMappings.get(e)?.get(n);
		if (!i || "file" !== i.backingKind || r <= i.len) return 0;
		if (!i.backingKey) return 5;
		const s = this.sharedMmapBackings.get(i.backingKey);
		if (!s) return 5;
		try {
			return this.ensureSharedMmapBackingRangeLoaded(s, i.fileOffset + i.len, r - i.len), 0;
		} catch {
			return 5;
		}
	}
	remapSharedMapping(e, t, n, r) {
		const i = this.sharedMappings.get(e), s = i?.get(t);
		if (i && s) {
			if (i.delete(t), s.backingKey && s.snapshot) {
				const t = this.processes.get(e), i = "file" === s.backingKind ? this.sharedMmapBackings.get(s.backingKey) : void 0, o = "file" !== s.backingKind ? this.anonymousSharedBackings.get(s.backingKey) : void 0;
				if (i && t) {
					this.ensureSharedMmapBackingRangeLoaded(i, s.fileOffset, r);
					const e = this.readSharedMmapBackingRange(i, s.fileOffset, r);
					new Uint8Array(t.memory.buffer).set(e, n), s.snapshot = e, s.seenVersion = i.version;
				} else if (o && t) {
					const e = s.fileOffset + r;
					if (e > o.bytes.length) {
						const i = new Uint8Array(e);
						i.set(o.bytes);
						const a = new Uint8Array(t.memory.buffer);
						n + r <= a.length && r > s.len && i.set(a.subarray(n + s.len, n + r), s.fileOffset + s.len), o.bytes = i, o.version++;
					}
					const i = o.bytes.slice(s.fileOffset, s.fileOffset + r);
					new Uint8Array(t.memory.buffer).set(i, n), s.snapshot = i, s.seenVersion = o.version;
				} else s.snapshot = s.snapshot.slice(0, r);
			}
			s.len = r, i.set(n, s);
		}
	}
	prepareFileSharedMappingsForWrite(e, t, n) {
		const r = this.sharedMappings.get(e);
		if (!r || 0 === n) return 0;
		const i = t + n;
		for (const [s, o] of r) {
			if ("file" !== o.backingKind) continue;
			if (s + o.len <= t || s >= i) continue;
			if (!0 !== o.writeAllowed) return 13;
			if (!o.backingKey) return 5;
			const e = this.sharedMmapBackings.get(o.backingKey);
			if (!e) return 5;
			if (!e.writable) return 5;
		}
		return 0;
	}
	updateSharedMappingProtection(e, t, n, r) {
		const i = this.sharedMappings.get(e);
		if (!i || 0 === n || !r) return;
		const s = t + n;
		for (const [o, a] of i) o + a.len <= t || o >= s || (a.writable = !0);
	}
	withKernelCurrentPid(e, t) {
		const n = this.kernelInstance.exports.kernel_set_current_pid, r = this.currentHandlePid;
		this.currentHandlePid = e, n && n(e);
		try {
			return t();
		} finally {
			this.currentHandlePid = r, n && n(r);
		}
	}
	hasPeerSysvShmMapping(e, t, n) {
		for (const [r, i] of this.shmMappings) for (const [s, o] of i) if (o.segId === n && (r !== e || s !== t)) return !0;
		return !1;
	}
	syncSysvShmMappingsFromProcess(e, t = {}) {
		const n = this.shmMappings?.get(e.pid);
		if (!n) return !0;
		const r = new Uint8Array(e.memory.buffer);
		let i = !0;
		return this.withKernelCurrentPid(e.pid, () => {
			for (const [s, o] of n) (t.force || this.hasPeerSysvShmMapping(e.pid, s, o.segId)) && (this.mergeAndRefreshSysvShmMapping(r, s, o) || (i = !1));
		}), i;
	}
	syncSysvShmSegmentFromMappedProcesses(e) {
		for (const [t, n] of this.shmMappings) {
			const r = this.processes.get(t);
			if (!r) continue;
			const i = new Uint8Array(r.memory.buffer);
			this.withKernelCurrentPid(t, () => {
				for (const [t, r] of n) r.segId === e && this.mergeAndRefreshSysvShmMapping(i, t, r);
			});
		}
	}
	mappingDiffersFromSnapshot(e, t, n, r) {
		for (let i = 0; i < r; i += 4096) {
			const s = Math.min(4096, r - i);
			if (this.rangeDiffersFromSnapshot(e, t + i, n, i, s)) return !0;
		}
		return !1;
	}
	mergeAndRefreshSysvShmMapping(e, t, n) {
		if (t + n.size > e.length) return !1;
		const r = this.shmSegmentVersions.get(n.segId) ?? 0, i = !n.readOnly && this.mappingDiffersFromSnapshot(e, t, n.snapshot, n.size);
		if (!i && n.seenVersion === r) return !0;
		const s = this.readSysvShmRange(n.segId, 0, n.size);
		if (!s) return !1;
		let o = !1, a = !0;
		if (i) for (let c = 0; c < n.size; c += 4096) {
			const r = Math.min(4096, n.size - c);
			if (!this.rangeDiffersFromSnapshot(e, t + c, n.snapshot, c, r)) continue;
			let i = 0;
			for (; i < r;) {
				for (; i < r && e[t + c + i] === n.snapshot[c + i];) i++;
				if (i >= r) break;
				const l = i;
				do
					i++;
				while (i < r && e[t + c + i] !== n.snapshot[c + i]);
				const h = e.subarray(t + c + l, t + c + i);
				if (!this.writeSysvShmRange(n.segId, c + l, h)) {
					a = !1;
					break;
				}
				s.set(h, c + l), o = !0;
			}
			if (!a) break;
		}
		return o && this.shmSegmentVersions.set(n.segId, r + 1), e.set(s, t), n.snapshot = s, n.seenVersion = this.shmSegmentVersions.get(n.segId) ?? r, a;
	}
	readSysvShmRange(e, t, n) {
		const r = this.kernelInstance.exports.kernel_ipc_shm_read_chunk;
		if (!r) return null;
		const i = new Uint8Array(n);
		let s = 0;
		for (; s < n;) {
			const o = Math.min(ee, n - s), a = this.scratchOffset + 72, c = r(e, t + s, this.toKernelPtr(a), o);
			if (c < 0 || c > o) return null;
			if (0 === c) break;
			i.set(new Uint8Array(this.kernelMemory.buffer, a, c), s), s += c;
		}
		return i;
	}
	writeSysvShmRange(e, t, n) {
		const r = this.kernelInstance.exports.kernel_ipc_shm_write_chunk;
		if (!r) return !1;
		let i = 0;
		for (; i < n.length;) {
			const s = Math.min(ee, n.length - i), o = this.scratchOffset + 72;
			new Uint8Array(this.kernelMemory.buffer).set(n.subarray(i, i + s), o);
			const a = r(e, t + i, this.toKernelPtr(o), s);
			if (a <= 0 || a > s) return !1;
			i += a;
		}
		return !0;
	}
	inheritSysvShmMappings(e, t) {
		const n = this.shmMappings.get(e);
		if (!n || 0 === n.size) return;
		const r = this.processes.get(t);
		if (!r) throw new Error(`Process ${t} is not registered`);
		const i = this.kernelInstance.exports.kernel_ipc_shmat, s = this.kernelInstance.exports.kernel_ipc_shmdt;
		if (!i || !s) throw new Error("Kernel lacks SysV SHM inheritance exports");
		const o = new Uint8Array(r.memory.buffer), a = /* @__PURE__ */ new Map();
		this.withKernelCurrentPid(t, () => {
			try {
				for (const [e, t] of n) {
					if (e + t.size > o.length) throw new Error(`Cannot inherit SysV mapping at 0x${e.toString(16)}`);
					const n = i(t.segId, e, t.readOnly ? 4096 : 0);
					if (n < 0 || n !== t.size) throw new Error(`SysV shmat inheritance failed for segment ${t.segId}`);
					const r = this.readSysvShmRange(t.segId, 0, t.size);
					if (!r) throw s(t.segId), /* @__PURE__ */ new Error(`Cannot read inherited SysV segment ${t.segId}`);
					o.set(r, e), a.set(e, {
						...t,
						snapshot: r,
						seenVersion: this.shmSegmentVersions.get(t.segId) ?? t.seenVersion
					});
				}
			} catch (Zi) {
				for (const t of a.values()) s(t.segId);
				throw a.clear(), Zi;
			}
		}), a.size > 0 && this.shmMappings.set(t, a);
	}
	releaseAllSysvShmMappingsForProcess(e, t = !0) {
		const n = this.shmMappings?.get(e);
		if (!n) return;
		const r = this.processes.get(e);
		t && r && this.syncSysvShmMappingsFromProcess(r, { force: !0 });
		const i = this.kernelInstance.exports.kernel_ipc_shmdt;
		i && this.withKernelCurrentPid(e, () => {
			for (const e of n.values()) i(e.segId);
		}), this.shmMappings.delete(e);
	}
	releaseAllSharedMemoryForProcess(e, t = !0) {
		const n = this.sharedMemoryReleasePids ??= /* @__PURE__ */ new Set();
		if (!n.has(e)) {
			n.add(e);
			try {
				const n = this.processes?.get(e), r = n?.channels?.[0];
				if (t && n) {
					try {
						this.syncAnonymousSharedMappingsFromProcess(n, { force: !0 });
					} catch {}
					try {
						this.syncFileSharedMappingsFromProcess(n, { force: !0 });
					} catch {}
					try {
						this.syncSysvShmMappingsFromProcess(n, { force: !0 });
					} catch {}
					if (r) {
						const t = this.sharedMappings.get(e);
						if (t) {
							for (const [e, n] of t) if (n.writable) {
								if ("file" === n.backingKind && n.backingKey) {
									const e = this.sharedMmapBackings.get(n.backingKey);
									e && this.flushSharedMmapBackingRange(e, n.fileOffset, n.len);
									continue;
								}
								n.backingKey || this.pwriteFromProcessMemory(r, n.fd, e, n.len, n.fileOffset);
							}
						}
					}
				}
				const i = this.sharedMappings?.get(e);
				if (i) {
					for (const e of i.values()) this.releaseSharedMapping(e);
					this.sharedMappings?.delete(e);
				}
				this.invalidateSharedMmapFdCacheForPid(e), this.shmMappings && this.releaseAllSysvShmMappingsForProcess(e, !1);
			} finally {
				n.delete(e);
			}
		}
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
			e >= Hn && (n = null === n ? e : Math.min(n, e));
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
	getKernelMemoryPages() {
		const e = this.kernelInstance?.exports.kernel_get_memory_pages;
		if ("function" != typeof e) throw new Error("kernel_get_memory_pages export is unavailable");
		return e() >>> 0;
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
	reconcileReusedTcpListenerKey(e, t, n, r, i) {
		const s = i.port, o = (this.tcpListenerTargets.get(s) ?? []).filter((n) => !(n.pid === e && n.fd === t)), a = void 0 !== r?.acceptWakeIdx ? this.resolveInheritedListenerFd(e, t, r.acceptWakeIdx) : null;
		if (a && a.fd !== t && !o.some((t) => t.pid === e && t.fd === a.fd) && o.push({
			pid: e,
			...a
		}), 0 === o.length) {
			if (this.tcpListenerTargets.delete(s), s !== n) {
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
			this.tcpListeners.has(t) || this.tcpListeners.set(t, i);
		} else if (o.length > 0) {
			const e = o[0], t = `${e.pid}:${e.fd}`;
			this.tcpListeners.has(t) || this.tcpListeners.set(t, {
				...i,
				pid: e.pid
			});
		} else s !== n && i.server.close();
		return s === n ? i : void 0;
	}
	startTcpListener(e, t, n, r = [
		0,
		0,
		0,
		0
	]) {
		const i = `${e}:${t}`, s = this.kernelInstance.exports.kernel_get_fd_accept_wake_idx, o = s?.(e, t) ?? -1;
		let a;
		const c = this.tcpListeners.get(i);
		if (c) {
			const r = this.tcpListenerTargets.get(c.port)?.find((n) => n.pid === e && n.fd === t), i = r?.acceptWakeIdx;
			if (void 0 === i && c.port === n || void 0 !== i && i === o) return void (r && void 0 === i && o >= 0 && (r.acceptWakeIdx = o));
			a = this.reconcileReusedTcpListenerKey(e, t, n, r, c);
		}
		this.tcpListenerTargets.has(n) || (this.tcpListenerTargets.set(n, []), this.tcpListenerRRIndex.set(n, 0));
		const l = this.tcpListenerTargets.get(n);
		if (l.some((n) => n.pid === e && n.fd === t) || l.push({
			pid: e,
			fd: t,
			...o >= 0 ? { acceptWakeIdx: o } : {}
		}), this.io.network?.listenTcp && !this.tcpVirtualListenerKeys.has(n)) {
			const e = this.io.network.listenTcp(i, new Uint8Array(r), n, { accept: (e, t, r) => {
				const i = this.pickListenerTarget(n);
				return i ? this.handleIncomingVirtualTcpConnection(i.pid, i.fd, e, r) : 113;
			} });
			0 !== e ? console.warn(`virtual TCP listener registration failed on port ${n}: errno ${e}`) : this.tcpVirtualListenerKeys.set(n, i);
		}
		if (!this.netModule) return;
		if (a) return void this.tcpListeners.set(i, {
			...a,
			pid: e,
			port: n
		});
		for (const [, u] of this.tcpListeners) if (u.port === n) return void this.tcpListeners.set(i, u);
		const h = this.netModule, d = /* @__PURE__ */ new Set(), f = h.createServer({ allowHalfOpen: !0 }, (e) => {
			const t = this.pickListenerTarget(n);
			t ? this.handleIncomingTcpConnection(t.pid, t.fd, e, d) : e.destroy();
		});
		f.listen(n, "0.0.0.0", () => {}), f.on("error", (e) => {
			console.error(`TCP listener error on port ${n}:`, e);
		}), this.tcpListeners.set(i, {
			server: f,
			pid: e,
			port: n,
			connections: d
		});
	}
	pickListenerTarget(e) {
		const t = this.tcpListenerTargets.get(e);
		if (!t || 0 === t.length) return null;
		const n = t.filter((e) => this.processes.has(e.pid));
		if (0 === n.length) return null;
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
			const r = En.encode(t);
			if (!e.body || 0 === e.body.length) return r;
			const i = new Uint8Array(r.length + e.body.length);
			return i.set(r, 0), i.set(e.body, r.length), i;
		}(t), y = this.writePipeChunked(c, 0, p, m);
		if (y < m.length) throw d(0, p), f(0, g), /* @__PURE__ */ new Error(`[in-kernel-http ${i}] partial write ${y}/${m.length}`);
		this.notifyPipeReadable(p);
		const w = await this.pumpHttpResponse(0, g, p, l, h, f, d, r, i), _ = n.emptyResponseRetries ?? 1;
		return _ > 0 && ("GET" === t.method || "HEAD" === t.method) && 200 === w.status && 0 === Object.keys(w.headers).length && 0 === w.body.length ? await this.sendHttpRequest(e, t, {
			...n,
			emptyResponseRetries: _ - 1
		}) : w;
	}
	wakeTargetPollNow(e) {
		for (const [t, n] of this.pendingPollRetries) if (n.channel.pid === e) {
			null !== n.timer && clearTimeout(n.timer), this.pendingPollRetries.delete(t), this.isRegisteredChannel(n.channel) && this.retrySyscall(n.channel);
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
				s && !d && (d = !0), !d || s || n ? setTimeout(p, n ? 0 : 2) : u(Mn(function(e) {
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
		const f = d + 1, u = this.kernelInstance.exports.kernel_pipe_write, p = this.kernelInstance.exports.kernel_pipe_read, g = this.kernelInstance.exports.kernel_pipe_close_write, m = this.kernelInstance.exports.kernel_pipe_close_read, y = this.kernelInstance.exports.kernel_pipe_is_read_open, w = this.kernelInstance.exports.kernel_pipe_has_readers, _ = [];
		let S = !1, b = !1, k = !1, v = !1, A = !1, I = !1;
		const C = this.tcpScratchOffset, P = this.kernelInstance.exports.kernel_pipe_is_write_open, E = () => {
			v || (v = !0, g(0, d), this.notifyPipeReadable(d));
		}, x = () => {
			if (0 === y(0, d)) return _.length = 0, void (S && E());
			const e = this.getKernelMem();
			let t = !1;
			for (; _.length > 0;) {
				const n = _[0], r = Math.min(n.length, 65536);
				e.set(n.subarray(0, r), C);
				const i = u(0, d, this.toKernelPtr(C), r);
				if (i <= 0) break;
				t = !0, i >= n.length ? _.shift() : _[0] = n.subarray(i);
			}
			S && 0 === _.length && E(), t && this.notifyPipeReadable(d);
		}, M = () => {
			const e = this.getKernelMem();
			let t = 0;
			for (;;) {
				const r = p(0, f, this.toKernelPtr(C), 65536);
				if (r <= 0) break;
				t += r;
				const i = Buffer.from(e.slice(C, C + r));
				n.destroyed || n.write(i);
			}
			return t > 0 && this.notifyPipeWritable(f), t;
		}, z = (e = 0) => {
			A || I || (A = !0, e > 0 ? setTimeout(T, e) : setImmediate(T));
		}, T = () => {
			if (A = !1, I) return;
			x();
			const e = M(), t = P(0, f), r = w(0, d);
			0 !== t || 0 !== e || k || (k = !0, n.destroyed || n.writableEnded || n.end()), 0 === t && r <= 0 || k && S && 0 === _.length || b && 0 === _.length ? U() : z();
		};
		n.on("data", (e) => {
			I || (_.push(e), x(), z());
		}), n.on("end", () => {
			S = !0, z();
		}), n.on("error", () => {
			S = !0, n.destroy(), U();
		}), n.on("close", () => {
			r.delete(n), b = !0, S = !0, z();
		});
		let L = this.tcpConnections.get(e);
		L || (L = [], this.tcpConnections.set(e, L));
		const B = {
			sendPipeIdx: f,
			scratchOffset: C,
			clientSocket: n,
			recvPipeIdx: d,
			schedulePump: z
		};
		L.push(B);
		const U = () => {
			if (I) return;
			I = !0, _.length = 0, E(), m(0, f), this.notifyPipeWritable(f);
			const t = this.tcpConnections?.get(e);
			if (t) {
				const n = t.indexOf(B);
				n >= 0 && t.splice(n, 1), 0 === t.length && this.tcpConnections?.delete(e);
			}
			n.destroyed || n.destroySoon();
		};
	}
	handleIncomingVirtualTcpConnection(e, t, n, r) {
		if (!this.kernelInstance) return 107;
		const i = (0, this.kernelInstance.exports.kernel_inject_connection)(e, t, r.addr[0] ?? 0, r.addr[1] ?? 0, r.addr[2] ?? 0, r.addr[3] ?? 0, r.port);
		if (i < 0) return -i;
		const s = i + 1, o = this.kernelInstance.exports.kernel_pipe_write, a = this.kernelInstance.exports.kernel_pipe_read, c = this.kernelInstance.exports.kernel_pipe_close_write, l = this.kernelInstance.exports.kernel_pipe_close_read, h = this.kernelInstance.exports.kernel_pipe_is_write_open, d = this.kernelInstance.exports.kernel_pipe_is_read_open, f = this.kernelInstance.exports.kernel_pipe_has_readers;
		let u = !1, p = !1, g = !1, m = !1, y = null, w = !1;
		const _ = this.tcpScratchOffset, S = () => {
			p || (p = !0, c(0, i));
		}, b = () => {
			u || (u = !0, S(), l(0, s), n.close(), this.notifyPipeReadable(i), this.notifyPipeWritable(s), this.scheduleWakeBlockedRetries());
		}, k = () => {
			if (0 === d(0, i)) return y = null, void (g || (g = !0, n.shutdown(0)));
			for (;;) {
				let t;
				if (y) t = y;
				else try {
					t = n.recv(65536, 0);
				} catch (e) {
					if (11 === e?.errno) return;
					b();
					return;
				}
				if (0 === t.length) return y = null, S(), void this.notifyPipeReadable(i);
				const r = this.writePipeChunked(o, 0, i, t);
				if (r < t.length) return void (y = t.subarray(r));
				y = null, this.notifyPipeReadable(i);
			}
		}, v = () => {
			const e = this.getKernelMem();
			for (;;) {
				const t = a(0, s, this.toKernelPtr(_), 65536);
				if (t <= 0) break;
				try {
					n.send(e.slice(_, _ + t), 0);
				} catch {
					b();
					return;
				}
				this.notifyPipeWritable(s);
			}
		}, A = () => {
			if (w = !1, u) return;
			k(), v();
			const e = h(0, s), t = f(0, i);
			0 !== e || m || (m = !0, n.shutdown(1)), 0 === e && t <= 0 || m && p ? b() : I(2);
		}, I = (e = 0) => {
			w || u || (w = !0, setTimeout(A, e));
		};
		return this.scheduleWakeBlockedRetries(), I(), 0;
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
		for (const [n, r] of this.tcpListenerTargets) {
			const t = r.filter((t) => t.pid !== e);
			if (0 === t.length) {
				this.tcpListenerTargets.delete(n), this.tcpListenerRRIndex.delete(n);
				const e = this.tcpVirtualListenerKeys.get(n);
				e && (this.io.network?.closeTcpListener?.(e), this.tcpVirtualListenerKeys.delete(n));
			} else this.tcpListenerTargets.set(n, t);
		}
		const t = `${e}:`;
		for (const [n, r] of Array.from(this.tcpListeners)) {
			if (!n.startsWith(t)) continue;
			this.tcpListeners.delete(n);
			const e = this.tcpListenerTargets.get(r.port);
			if (e && 0 !== e.length) {
				const t = e[0], n = `${t.pid}:${t.fd}`;
				this.tcpListeners.has(n) || this.tcpListeners.set(n, {
					...r,
					pid: t.pid
				});
			} else r.server.close();
		}
		this.tcpConnections.delete(e);
	}
	handleSemctl(e, t) {
		const [n, r, i, s] = t, o = -257 & i, a = new DataView(this.kernelMemory.buffer, this.scratchOffset), c = this.kernelInstance.exports.kernel_handle_channel, l = this.getKernelMem(), h = this.scratchOffset + 72;
		if (2 === o && 0 !== s) {
			a.setUint32(4, mi, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(r), !0), a.setBigInt64(24, BigInt(i), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), l.fill(0, h, h + 72), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
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
			a.setUint32(4, mi, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(r), !0), a.setBigInt64(24, BigInt(i), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), l.fill(0, h, h + t), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
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
			l.set(o.subarray(s, s + t), h), a.setUint32(4, mi, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(r), !0), a.setBigInt64(24, BigInt(i), !0), a.setBigInt64(32, BigInt(h), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
			try {
				c(this.toKernelPtr(this.scratchOffset), e.pid);
			} finally {
				this.currentHandlePid = 0;
			}
			const d = Number(a.getBigInt64(56, !0)), f = a.getUint32(64, !0);
			this.completeChannelRaw(e, d, f), this.relistenChannel(e);
			return;
		}
		a.setUint32(4, mi, !0), a.setBigInt64(8, BigInt(n), !0), a.setBigInt64(16, BigInt(r), !0), a.setBigInt64(24, BigInt(i), !0), a.setBigInt64(32, BigInt(s), !0), a.setBigInt64(40, BigInt(0), !0), a.setBigInt64(48, BigInt(0), !0), this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			c(this.toKernelPtr(this.scratchOffset), e.pid);
		} finally {
			this.currentHandlePid = 0;
		}
		const d = Number(a.getBigInt64(56, !0)), f = a.getUint32(64, !0);
		this.completeChannelRaw(e, d, f), this.relistenChannel(e);
	}
	runSyntheticMemorySyscall(e, t, n) {
		const r = new DataView(this.kernelMemory.buffer, this.scratchOffset);
		r.setUint32(4, t, !0);
		for (let a = 0; a < 6; a++) r.setBigInt64(8 + 8 * a, BigInt(n[a] ?? 0), !0);
		const i = this.kernelInstance.exports.kernel_handle_channel, s = this.currentHandlePid;
		this.currentHandlePid = e.pid, this.bindKernelTidForChannel(e);
		try {
			i(this.toKernelPtr(this.scratchOffset), e.pid);
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
		const [n, r, i] = t;
		this.syncSysvShmSegmentFromMappedProcesses(n);
		const s = this.kernelInstance.exports.kernel_ipc_shmat, o = this.kernelInstance.exports.kernel_ipc_shmdt, a = this.withKernelCurrentPid(e.pid, () => s(n, r, i));
		if (a < 0) return this.completeChannelRaw(e, a, -a), void this.relistenChannel(e);
		const c = a, l = !!(4096 & i), h = l ? 1 : 3;
		let d = null;
		const f = () => {
			if (null !== d) {
				try {
					this.runSyntheticMemorySyscall(e, Ur, [d, c]);
				} catch {}
				if (this.hostReaped?.has(e.pid)) return;
			}
			try {
				this.withKernelCurrentPid(e.pid, () => o(n));
			} catch {}
		};
		try {
			const t = this.runSyntheticMemorySyscall(e, Br, [
				r >>> 0,
				c,
				h,
				34,
				-1,
				0
			]);
			if (this.hostReaped?.has(e.pid)) return;
			if (t.retVal < 0) {
				if (f(), this.hostReaped?.has(e.pid)) return;
				const n = t.errVal || 12;
				this.completeChannelRaw(e, -n, n), this.relistenChannel(e);
				return;
			}
			if (d = t.retVal >>> 0, 0 !== r && d !== r >>> 0) {
				if (f(), this.hostReaped?.has(e.pid)) return;
				this.completeChannelRaw(e, -22, Zn), this.relistenChannel(e);
				return;
			}
			this.ensureProcessMemoryCovers(e.pid, e.memory, Br, d, [
				r,
				c,
				h,
				34,
				-1,
				0
			]);
			const i = this.withKernelCurrentPid(e.pid, () => this.readSysvShmRange(n, 0, c)), s = new Uint8Array(e.memory.buffer);
			if (!i || d + c > s.length) {
				if (f(), this.hostReaped?.has(e.pid)) return;
				this.completeChannelRaw(e, -5, 5), this.relistenChannel(e);
				return;
			}
			s.set(i, d);
			let o = this.shmMappings.get(e.pid);
			o || (o = /* @__PURE__ */ new Map(), this.shmMappings.set(e.pid, o)), o.set(d, {
				segId: n,
				size: c,
				readOnly: l,
				snapshot: i,
				seenVersion: this.shmSegmentVersions.get(n) ?? 0
			});
		} catch (Zi) {
			if (console.error(`[handleIpcShmat] mmap failed for pid=${e.pid}:`, Zi), f(), this.hostReaped?.has(e.pid)) return;
			this.completeChannelRaw(e, -12, 12), this.relistenChannel(e);
			return;
		}
		this.completeChannelRaw(e, d, 0), this.relistenChannel(e);
	}
	handleIpcShmdt(e, t) {
		const n = t[0] >>> 0, r = this.shmMappings.get(e.pid);
		if (!r) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const i = r.get(n);
		if (!i) return this.completeChannelRaw(e, -22, 22), void this.relistenChannel(e);
		const s = new Uint8Array(e.memory.buffer);
		if (!this.withKernelCurrentPid(e.pid, () => this.mergeAndRefreshSysvShmMapping(s, n, i))) return this.completeChannelRaw(e, -5, 5), void this.relistenChannel(e);
		const o = this.kernelInstance.exports.kernel_ipc_shmdt, a = this.withKernelCurrentPid(e.pid, () => o(i.segId));
		if (a < 0) this.completeChannelRaw(e, a, -a);
		else {
			r.delete(n), 0 === r.size && this.shmMappings.delete(e.pid);
			let t = !1;
			try {
				const r = this.runSyntheticMemorySyscall(e, Ur, [n, i.size]);
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
			const e = new DataView(this.kernelMemory.buffer, t), n = e.getUint32(0, !0), r = e.getUint32(4, !0);
			r > 0 && this.sendSignalToProcess(n, r);
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
	attachKmsCanvas(e, t, n, r) {
		this.kmsCanvases.set(e, t), n && this.kmsStatsViews.set(e, new Int32Array(n));
		const i = r?.mode ?? "auto";
		if ("2d" === i) {
			const n = t.getContext("2d");
			n && (this.kmsContexts.set(e, n), this.kmsContextMode.set(e, "2d"));
		} else "webgl2" === i && this.kmsContextMode.set(e, "webgl2");
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
			const r = this.kernel.kms.scanoutBytes(t);
			if (!r) continue;
			const i = this.kmsContexts.get(t);
			if (!i) continue;
			n.width === e.width && n.height === e.height || (n.width = e.width, n.height = e.height);
			const s = performance.now(), o = e.width * e.height * 4;
			let a = this.kmsScratchBytes.get(t);
			a && a.byteLength === o || (a = new Uint8ClampedArray(new ArrayBuffer(o)), this.kmsScratchBytes.set(t, a)), a.set(r), i.putImageData(new ImageData(a, e.width, e.height), 0, 0);
			const c = 1e3 * (performance.now() - s) | 0, l = this.kmsStatsViews.get(t);
			l && (Atomics.add(l, 0, 1), Atomics.store(l, 1, 0 | performance.now()), Atomics.store(l, 4, c));
		}
		if (this.kmsStatsViews.size > 0) {
			const e = this.kernelInstance?.exports;
			for (const [t, n] of this.kmsStatsViews) {
				const r = this.kernel.kms.currentFb(t);
				if (r && (Atomics.store(n, 2, r.width), Atomics.store(n, 3, r.height)), n.length < 7) continue;
				const i = e?.kernel_kms_commit_count?.(t) ?? 0n, s = e?.kernel_kms_last_frame_us?.(t) ?? 0n;
				Atomics.store(n, 5, Number(2147483647n & i)), Atomics.store(n, 6, Number(2147483647n & s));
			}
		}
	}
}, Ui = class {
	entryUrl;
	constructor(e) {
		this.entryUrl = e;
	}
	createWorker(e) {
		const t = new Worker(this.entryUrl, { type: "module" }), n = new Ri(t);
		return t.postMessage(e), n;
	}
}, Ri = class {
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
		if (this.worker.terminate(), !this.terminated) {
			this.terminated = !0;
			for (const e of this.handlers.get("exit") ?? []) e(0);
		}
		return 0;
	}
}, Hi = class {
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
		let e;
		try {
			e = this.create();
		} catch (t) {
			throw this.terminated = !0, this.pendingMessages.splice(0), t;
		}
		this.worker = e;
		for (const [n, r] of this.handlers) for (const t of r) e.on(n, t);
		for (const { message: n, transfer: r } of this.pendingMessages.splice(0)) e.postMessage(n, r);
		return !0;
	}
	postMessage(e, t) {
		this.terminated || (this.worker ? this.worker.postMessage(e, t) : this.pendingMessages.push({
			message: e,
			transfer: t
		}));
	}
	on(e, t) {
		let n = this.handlers.get(e);
		n || (n = /* @__PURE__ */ new Set(), this.handlers.set(e, n)), n.add(t), this.worker && this.worker.on(e, t);
	}
	off(e, t) {
		this.handlers.get(e)?.delete(t), this.worker && this.worker.off(e, t);
	}
	terminate() {
		return this.terminationPromise ? this.terminationPromise : this.terminated ? Promise.resolve(0) : (this.terminated = !0, this.pendingMessages.splice(0), this.terminationPromise = this.worker?.terminate() ?? Promise.resolve(0), this.terminationPromise);
	}
};
const Fi = (1n << 64n) - 1n;
function Wi(e, t) {
	if ("bigint" == typeof e) {
		if (e >= 0n && e <= Fi) return e;
	} else if (Number.isSafeInteger(e) && e >= 0) return BigInt(e);
	const n = /* @__PURE__ */ new Error(`EOVERFLOW: ${t} is not exactly representable as an unsigned 64-bit value`);
	throw n.code = "EOVERFLOW", n;
}
var Di = class {
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
		const n = /* @__PURE__ */ new Map();
		let r = 1;
		if (this.mounts = e.map((e) => {
			let t = n.get(e.backend);
			return void 0 === t && (t = r++, n.set(e.backend, t)), {
				prefix: (i = e.mountPoint, "/" !== i && i.endsWith("/") ? i.slice(0, -1) : i),
				backend: e.backend,
				backendId: t
			};
			var i;
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
				let n = e.slice(t.prefix.length);
				return n.startsWith("/") || (n = "/" + n), {
					backend: t.backend,
					backendId: t.backendId,
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
	qualifyStat(e, t) {
		const n = Wi(t.dev, "st_dev"), r = Wi(t.ino, "st_ino");
		let i = this.qualifiedDeviceIds.get(e);
		void 0 === i && (i = /* @__PURE__ */ new Map(), this.qualifiedDeviceIds.set(e, i));
		let s = i.get(n);
		if (void 0 === s) {
			if (this.nextQualifiedDeviceId > Fi) {
				const e = /* @__PURE__ */ new Error("EOVERFLOW: exhausted virtual filesystem device identities");
				throw e.code = "EOVERFLOW", e;
			}
			s = this.nextQualifiedDeviceId++, i.set(n, s);
		}
		return {
			...t,
			dev: s,
			ino: r
		};
	}
	fileIdentity(e, t, n) {
		if (n <= 0n || t < 0n) return null;
		const { backendId: r } = this.resolve(e);
		return `vfs:${r}:${t}:${n}`;
	}
	fileHandleIdentity(e, t, n) {
		if (n <= 0n || t < 0n) return null;
		const { backendId: r } = this.getFileHandle(e);
		return `vfs:${r}:${t}:${n}`;
	}
	async preparePath(e) {
		const { backend: t, relativePath: n } = this.resolve(e);
		return t.preparePath?.(n) ?? !1;
	}
	open(e, t, n) {
		const { backend: r, backendId: i, relativePath: s } = this.resolve(e), o = r.open(s, t, n), a = this.nextFileHandle++;
		return this.fileHandles.set(a, {
			backend: r,
			backendId: i,
			localHandle: o
		}), a;
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
		return this.qualifyStat(t.backend, t.backend.fstat(t.localHandle));
	}
	fpathconf(e, t) {
		const n = this.getFileHandle(e);
		return n.backend.fpathconf(n.localHandle, t);
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
		return this.qualifyStat(t, t.stat(n));
	}
	lstat(e) {
		const { backend: t, relativePath: n } = this.resolve(e);
		return this.qualifyStat(t, t.lstat(n));
	}
	statfs(e) {
		const { backend: t, relativePath: n } = this.resolve(e);
		return t.statfs(n);
	}
	pathconf(e, t) {
		const { backend: n, relativePath: r } = this.resolve(e);
		return n.pathconf(r, t);
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
	lchown(e, t, n) {
		const { backend: r, relativePath: i } = this.resolve(e);
		r.lchown(i, t, n);
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
		const { backend: t, backendId: n, relativePath: r } = this.resolve(e), i = t.opendir(r), s = this.nextDirHandle++;
		return this.dirHandles.set(s, {
			backend: t,
			backendId: n,
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
async function $i(e, t) {
	await e.preparePath?.(t);
	const n = e.stat(t);
	if (!Number.isSafeInteger(n.size) || n.size < 0) {
		const e = /* @__PURE__ */ new Error(`EOVERFLOW: invalid file size for ${t}`);
		throw e.code = "EOVERFLOW", e;
	}
	const r = e.open(t, 0, 0);
	try {
		const t = new Uint8Array(n.size);
		let i = 0;
		for (; i < t.byteLength;) {
			const n = e.read(r, t.subarray(i), null, t.byteLength - i);
			if (n <= 0) break;
			i += n;
		}
		return {
			data: i === t.byteLength ? t : t.slice(0, i),
			stat: n
		};
	} finally {
		e.close(r);
	}
}
var Oi = ArrayBuffer, Ni = Uint8Array, Ki = Uint16Array, Vi = Int16Array, qi = Int32Array, Gi = function(e, t, n) {
	if (Ni.prototype.slice) return Ni.prototype.slice.call(e, t, n);
	(null == t || t < 0) && (t = 0), (null == n || n > e.length) && (n = e.length);
	var r = new Ni(n - t);
	return r.set(e.subarray(t, n)), r;
}, ji = function(e, t, n, r) {
	if (Ni.prototype.fill) return Ni.prototype.fill.call(e, t, n, r);
	for ((null == n || n < 0) && (n = 0), (null == r || r > e.length) && (r = e.length); n < r; ++n) e[n] = t;
	return e;
}, Xi = function(e, t, n, r) {
	if (Ni.prototype.copyWithin) return Ni.prototype.copyWithin.call(e, t, n, r);
	for ((null == n || n < 0) && (n = 0), (null == r || r > e.length) && (r = e.length); n < r;) e[t++] = e[n++];
}, Yi = [
	"invalid zstd data",
	"window size too large (>2046MB)",
	"invalid block type",
	"FSE accuracy too high",
	"match distance too far back",
	"unexpected EOF"
], Zi = function(e, t, n) {
	var r = new Error(t || Yi[e]);
	if (r.code = e, Error.captureStackTrace && Error.captureStackTrace(r, Zi), !n) throw r;
	return r;
}, Ji = function(e, t, n) {
	for (var r = 0, i = 0; r < n; ++r) i |= e[t++] << (r << 3);
	return i;
}, Qi = function(e, t) {
	var n, r, i = e[0] | e[1] << 8 | e[2] << 16;
	if (3126568 == i && 253 == e[3]) {
		var s = e[4], o = s >> 5 & 1, a = s >> 2 & 1, c = 3 & s, l = s >> 6;
		8 & s && Zi(0);
		var h = 6 - o, d = 3 == c ? 4 : c, f = Ji(e, h, d), u = l ? 1 << l : o, p = Ji(e, h += d, u) + (1 == l && 256), g = p;
		if (!o) {
			var m = 1 << 10 + (e[5] >> 3);
			g = m + (m >> 3) * (7 & e[5]);
		}
		g > 2145386496 && Zi(1);
		var y = new Ni((1 == t ? p || g : t ? 0 : g) + 12);
		return y[0] = 1, y[4] = 4, y[8] = 8, {
			b: h + u,
			y: 0,
			l: 0,
			d: f,
			w: t && 1 != t ? t : y.subarray(12),
			e: g,
			o: new qi(y.buffer, 0, 3),
			u: p,
			c: a,
			m: Math.min(131072, g)
		};
	}
	if (25481893 == (i >> 4 | e[3] << 20)) return (((n = e)[r = 4] | n[r + 1] << 8 | n[r + 2] << 16 | n[r + 3] << 24) >>> 0) + 8;
	Zi(0);
}, es = function(e) {
	for (var t = 0; 1 << t <= e; ++t);
	return t - 1;
}, ts = function(e, t, n) {
	var r = 4 + (t << 3), i = 5 + (15 & e[t]);
	i > n && Zi(3);
	for (var s = 1 << i, o = s, a = -1, c = -1, l = -1, h = s, d = new Oi(512 + (s << 2)), f = new Vi(d, 0, 256), u = new Ki(d, 0, 256), p = new Ki(d, 512, s), g = 512 + (s << 1), m = new Ni(d, g, s), y = new Ni(d, g + s); a < 255 && o > 0;) {
		var w = es(o + 1), _ = r >> 3, S = (1 << w + 1) - 1, b = (e[_] | e[_ + 1] << 8 | e[_ + 2] << 16) >> (7 & r) & S, k = (1 << w) - 1, v = S - o - 1, A = b & k;
		if (A < v ? (r += w, b = A) : (r += w + 1, b > k && (b -= v)), f[++a] = --b, -1 == b ? (o += b, m[--h] = a) : o -= b, !b) do {
			var I = r >> 3;
			c = (e[I] | e[I + 1] << 8) >> (7 & r) & 3, r += 2, a += c;
		} while (3 == c);
	}
	(a > 255 || o) && Zi(0);
	for (var C = 0, P = (s >> 1) + (s >> 3) + 3, E = s - 1, x = 0; x <= a; ++x) {
		var M = f[x];
		if (M < 1) u[x] = -M;
		else for (l = 0; l < M; ++l) {
			m[C] = x;
			do
				C = C + P & E;
			while (C >= h);
		}
	}
	for (C && Zi(0), l = 0; l < s; ++l) {
		var z = u[m[l]]++;
		p[l] = (z << (y[l] = i - es(z))) - s;
	}
	return [r + 7 >> 3, {
		b: i,
		s: m,
		n: y,
		t: p
	}];
}, ns = ts(new Ni([
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
]), 0, 6)[1], rs = ts(new Ni([
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
]), 0, 6)[1], is = ts(new Ni([
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
]), 0, 5)[1], ss = function(e, t) {
	for (var n = e.length, r = new qi(n), i = 0; i < n; ++i) r[i] = t, t += 1 << e[i];
	return r;
}, os = new Ni(new qi([
	0,
	0,
	0,
	0,
	16843009,
	50528770,
	134678020,
	202050057,
	269422093
]).buffer, 0, 36), as = ss(os, 0), cs = new Ni(new qi([
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
]).buffer, 0, 53), ls = ss(cs, 3), hs = function(e, t, n) {
	var r = e.length, i = t.length, s = e[r - 1], o = (1 << n.b) - 1, a = -n.b;
	s || Zi(0);
	for (var c = 0, l = n.b, h = (r << 3) - 8 + es(s) - l, d = -1; h > a && d < i;) {
		var f = h >> 3;
		c = (c << l | (e[f] | e[f + 1] << 8 | e[f + 2] << 16) >> (7 & h)) & o, t[++d] = n.s[c], h -= l = n.n[c];
	}
	h == a && d + 1 == i || Zi(0);
}, ds = function(e, t, n) {
	var r = 6, i = t.length + 3 >> 2, s = i << 1, o = i + s;
	hs(e.subarray(r, r += e[0] | e[1] << 8), t.subarray(0, i), n), hs(e.subarray(r, r += e[2] | e[3] << 8), t.subarray(i, s), n), hs(e.subarray(r, r += e[4] | e[5] << 8), t.subarray(s, o), n), hs(e.subarray(r), t.subarray(o), n);
}, fs = function(e, t, n) {
	var r, i = t.b, s = e[i], o = s >> 1 & 3;
	t.l = 1 & s;
	var a = s >> 3 | e[i + 1] << 5 | e[i + 2] << 13, c = (i += 3) + a;
	if (1 == o) {
		if (i >= e.length) return;
		return t.b = i + 1, n ? (ji(n, e[i], t.y, t.y += a), n) : ji(new Ni(a), e[i]);
	}
	if (!(c > e.length)) {
		if (0 == o) return t.b = c, n ? (n.set(e.subarray(i, c), t.y), t.y += a, n) : Gi(e, i, c);
		if (2 == o) {
			var l = e[i], h = 3 & l, d = l >> 2 & 3, f = l >> 4, u = 0, p = 0;
			h < 2 ? 1 & d ? f |= e[++i] << 4 | (2 & d && e[++i] << 12) : f = l >> 3 : (p = d, d < 2 ? (f |= (63 & e[++i]) << 4, u = e[i] >> 6 | e[++i] << 2) : 2 == d ? (f |= e[++i] << 4 | (3 & e[++i]) << 12, u = e[i] >> 2 | e[++i] << 6) : (f |= e[++i] << 4 | (63 & e[++i]) << 12, u = e[i] >> 6 | e[++i] << 2 | e[++i] << 10)), ++i;
			var g = n ? n.subarray(t.y, t.y + t.m) : new Ni(t.m), m = g.length - f;
			if (0 == h) g.set(e.subarray(i, i += f), m);
			else if (1 == h) ji(g, e[i++], m);
			else {
				var y = t.h;
				if (2 == h) {
					var w = function(e, t) {
						var n = 0, r = -1, i = new Ni(292), s = e[t], o = i.subarray(0, 256), a = i.subarray(256, 268), c = new Ki(i.buffer, 268);
						if (s < 128) {
							var l = ts(e, t + 1, 6), h = l[0], d = l[1], f = h << 3, u = e[t += s];
							u || Zi(0);
							for (var p = 0, g = 0, m = d.b, y = m, w = (++t << 3) - 8 + es(u); !((w -= m) < f);) {
								var _ = w >> 3;
								if (p += (e[_] | e[_ + 1] << 8) >> (7 & w) & (1 << m) - 1, o[++r] = d.s[p], (w -= y) < f) break;
								g += (e[_ = w >> 3] | e[_ + 1] << 8) >> (7 & w) & (1 << y) - 1, o[++r] = d.s[g], m = d.n[p], p = d.t[p], y = d.n[g], g = d.t[g];
							}
							++r > 255 && Zi(0);
						} else {
							for (r = s - 127; n < r; n += 2) {
								var S = e[++t];
								o[n] = S >> 4, o[n + 1] = 15 & S;
							}
							++t;
						}
						var b = 0;
						for (n = 0; n < r; ++n) (I = o[n]) > 11 && Zi(0), b += I && 1 << I - 1;
						var k = es(b) + 1, v = 1 << k, A = v - b;
						for (A & A - 1 && Zi(0), o[r++] = es(A) + 1, n = 0; n < r; ++n) {
							var I = o[n];
							++a[o[n] = I && k + 1 - I];
						}
						var C = new Ni(v << 1), P = C.subarray(0, v), E = C.subarray(v);
						for (c[k] = 0, n = k; n > 0; --n) {
							var x = c[n];
							ji(E, n, x, c[n - 1] = x + a[n] * (1 << k - n));
						}
						for (c[0] != v && Zi(0), n = 0; n < r; ++n) {
							var M = o[n];
							if (M) {
								var z = c[M];
								ji(P, n, z, c[M] = z + (1 << k - M));
							}
						}
						return [t, {
							n: E,
							b: k,
							s: P
						}];
					}(e, i);
					u += i - (i = w[0]), t.h = y = w[1];
				} else y || Zi(0);
				(p ? ds : hs)(e.subarray(i, i += u), g.subarray(m), y);
			}
			var _ = e[i++];
			if (_) {
				255 == _ ? _ = 32512 + (e[i++] | e[i++] << 8) : _ > 127 && (_ = _ - 128 << 8 | e[i++]);
				var S = e[i++];
				3 & S && Zi(0);
				for (var b = [
					rs,
					is,
					ns
				], k = 2; k > -1; --k) {
					var v = S >> 2 + (k << 1) & 3;
					if (1 == v) {
						var A = new Ni([
							0,
							0,
							e[i++]
						]);
						b[k] = {
							s: A.subarray(2, 3),
							n: A.subarray(0, 1),
							t: new Ki(A.buffer, 0, 1),
							b: 0
						};
					} else 2 == v ? (i = (r = ts(e, i, 9 - (1 & k)))[0], b[k] = r[1]) : 3 == v && (t.t || Zi(0), b[k] = t.t[k]);
				}
				var I = t.t = b, C = I[0], P = I[1], E = I[2], x = e[c - 1];
				x || Zi(0);
				var M = (c << 3) - 8 + es(x) - E.b, z = M >> 3, T = 0, L = (e[z] | e[z + 1] << 8) >> (7 & M) & (1 << E.b) - 1, B = (e[z = (M -= P.b) >> 3] | e[z + 1] << 8) >> (7 & M) & (1 << P.b) - 1, U = (e[z = (M -= C.b) >> 3] | e[z + 1] << 8) >> (7 & M) & (1 << C.b) - 1;
				for (++_; --_;) {
					var R = E.s[L], H = E.n[L], F = C.s[U], W = C.n[U], D = P.s[B], $ = P.n[B], O = 1 << D, N = O + ((e[z = (M -= D) >> 3] | e[z + 1] << 8 | e[z + 2] << 16 | e[z + 3] << 24) >>> (7 & M) & O - 1);
					z = (M -= cs[F]) >> 3;
					var K = ls[F] + ((e[z] | e[z + 1] << 8 | e[z + 2] << 16) >> (7 & M) & (1 << cs[F]) - 1);
					z = (M -= os[R]) >> 3;
					var V = as[R] + ((e[z] | e[z + 1] << 8 | e[z + 2] << 16) >> (7 & M) & (1 << os[R]) - 1);
					if (z = (M -= H) >> 3, L = E.t[L] + ((e[z] | e[z + 1] << 8) >> (7 & M) & (1 << H) - 1), z = (M -= W) >> 3, U = C.t[U] + ((e[z] | e[z + 1] << 8) >> (7 & M) & (1 << W) - 1), z = (M -= $) >> 3, B = P.t[B] + ((e[z] | e[z + 1] << 8) >> (7 & M) & (1 << $) - 1), N > 3) t.o[2] = t.o[1], t.o[1] = t.o[0], t.o[0] = N -= 3;
					else {
						var q = N - (0 != V);
						q ? (N = 3 == q ? t.o[0] - 1 : t.o[q], q > 1 && (t.o[2] = t.o[1]), t.o[1] = t.o[0], t.o[0] = N) : N = t.o[0];
					}
					for (k = 0; k < V; ++k) g[T + k] = g[m + k];
					m += V;
					var G = (T += V) - N;
					if (G < 0) {
						var j = -G, X = t.e + G;
						j > K && (j = K);
						for (k = 0; k < j; ++k) g[T + k] = t.w[X + k];
						T += j, K -= j, G = 0;
					}
					for (k = 0; k < K; ++k) g[T + k] = g[G + k];
					T += K;
				}
				if (T != m) for (; m < g.length;) g[T++] = g[m++];
				else T = g.length;
				n ? t.y += T : g = Gi(g, 0, T);
			} else if (n) {
				if (t.y += f, m) for (k = 0; k < f; ++k) g[k] = g[m + k];
			} else m && (g = Gi(g, m));
			return t.b = c, g;
		}
		Zi(2);
	}
};
function us(e, t) {
	for (var n = [], r = +!t, i = 0, s = 0; e.length;) {
		var o = Qi(e, r || t);
		if ("object" == typeof o) {
			for (r ? (t = null, o.w.length == o.u && (n.push(t = o.w), s += o.u)) : (n.push(t), o.e = 0); !o.l;) {
				var a = fs(e, o, t);
				a || Zi(5), t ? o.e = o.y : (n.push(a), s += a.length, Xi(o.w, 0, a.length), o.w.set(a, o.w.length - a.length));
			}
			i = o.b + 4 * o.c;
		} else i = o;
		e = e.subarray(i);
	}
	return function(e, t) {
		if (1 == e.length) return e[0];
		for (var n = new Ni(t), r = 0, i = 0; r < e.length; ++r) {
			var s = e[r];
			n.set(s, i), i += s.length;
		}
		return n;
	}(n, s);
}
function ps(e) {
	const t = /* @__PURE__ */ new Error(`EINVAL: pathconf name ${e} is not associated with this object`);
	throw t.code = "EINVAL", t;
}
function gs(e, t, n) {
	switch (t) {
		case Ut: return null;
		case Ft: return 255;
		case Wt: return 4096;
		case $t:
		case Ot: return 1;
		case Vt: return 32768 == (61440 & e.mode) ? 1 : ps(t);
		case Kt:
		case qt:
		case jt:
		case Xt:
		case Yt:
		case Zt:
		case Jt:
		case Qt:
		case en:
		case nn: return null;
		case tn: return n.supportsSymlinks ? 1 : null;
		case rn: return 255;
		case sn: return n.timestampResolutionNs;
		case Dt: {
			const n = 61440 & e.mode;
			return 4096 === n || 16384 === n ? null : ps(t);
		}
		case Rt:
		case Ht:
		case Nt:
		case Gt: return ps(t);
		default: {
			const e = /* @__PURE__ */ new Error(`EINVAL: invalid pathconf name ${t}`);
			throw e.code = "EINVAL", e;
		}
	}
}
const ms = 4096, ys = 1024, ws = Math.floor(160), _s = 61440, Ss = 4294967295, bs = 12, ks = 16, vs = 28, As = 12, Is = 16, Cs = 24, Ps = 32, Es = 48, xs = 92, Ms = 104, zs = 112, Ts = 120, Ls = -2147483648, Bs = 4299202560, Us = {
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
var Rs = class extends Error {
	code;
	constructor(e, t) {
		super(t || Us[e] || `Error ${e}`), this.code = e, this.name = "SFSError";
	}
};
const Hs = new TextEncoder(), Fs = new TextDecoder(), Ws = Hs.encode("..");
function Ds(e) {
	return "." === e || ".." === e;
}
function $s(e) {
	return e.buffer instanceof SharedArrayBuffer ? Fs.decode(new Uint8Array(e)) : Fs.decode(e);
}
function Os(e) {
	return e + 3 & -4;
}
var Ns = class e {
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
	static mkfs(t, n) {
		const r = t.byteLength;
		if (r < 65536) throw new Rs(-22);
		let i = Math.floor(r / ms);
		const s = n ? Math.floor(n / ms) : 4 * i;
		let o = Math.floor(s / 4);
		o < 32 && (o = 32), o = 32 * Math.ceil(o / 32);
		const a = Math.ceil(o / 32768), c = Math.ceil(s / 32768), l = Math.ceil(128 * o / ms), h = 1 + a, d = h + c, f = d + l;
		if (f >= i) {
			const e = (f + 1) * ms;
			try {
				t.grow(e);
			} catch {
				throw new Rs(-28);
			}
			if (i = Math.floor(t.byteLength / ms), f >= i) throw new Rs(-28);
		}
		new Uint8Array(t).fill(0);
		const u = new e(t);
		u.w32(0, 1397114451), u.w32(4, 1), u.w32(8, ms), u.w32(bs, i), u.w32(ks, o), u.w32(vs, 1), u.w32(32, h), u.w32(36, d), u.w32(40, f), u.w32(44, a), u.w32(48, c), u.w32(52, l), u.w32(68, s), u.w32(72, 256);
		const p = h * ms;
		for (let e = 0; e < f; e++) {
			const t = (p >> 2) + (e >> 5);
			u.i32[t] |= 1 << (31 & e);
		}
		const g = i - f;
		Atomics.store(u.i32, 5, g), u.blockAllocHint = f, u.i32[1024] |= 3, Atomics.store(u.i32, 6, o - 2), u.inodeAllocHint = 2;
		const m = u.inodeOffset(1);
		u.w32(m + 8, 16877), u.w32(m + As, 2), u.w64(m + Ms, 1);
		const y = u.blockAlloc();
		if (y < 0) throw new Rs(-28);
		u.w32(m + Es, y);
		const w = y * ms, _ = Os(9), S = Os(10);
		u.w32(w, 1), u.view.setUint16(w + 4, _, !0), u.view.setUint16(w + 6, 1, !0), u.u8[w + 8] = 46;
		const b = w + _;
		return u.w32(b, 1), u.view.setUint16(b + 4, S, !0), u.view.setUint16(b + 6, 2, !0), u.u8[b + 8] = 46, u.u8[b + 8 + 1] = 46, u.w64(m + Is, _ + S), Atomics.store(u.i32, 14, 1), u;
	}
	static inspectImageCapacity(e) {
		if (e.byteLength < 72) throw new Rs(-22, "SharedFS image is too small");
		const t = new DataView(e.buffer, e.byteOffset, e.byteLength);
		if (1397114451 !== t.getUint32(0, !0)) throw new Rs(-22, "Bad magic");
		if (1 !== t.getUint32(4, !0)) throw new Rs(-22, "Bad version");
		const n = t.getUint32(8, !0);
		if (4096 !== n) throw new Rs(-22, "Bad block size");
		const r = t.getUint32(68, !0) * n;
		return {
			byteLength: e.byteLength,
			maxByteLength: Math.max(e.byteLength, r)
		};
	}
	static mount(t, n) {
		const r = new e(t);
		if (1397114451 !== r.r32(0)) throw new Rs(-22, "Bad magic");
		if (1 !== r.r32(4)) throw new Rs(-22, "Bad version");
		if (4096 !== r.r32(8)) throw new Rs(-22, "Bad block size");
		return n?.restoreImage && r.resetRestoredRuntimeState(), r.resetAllocationHints(), r;
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
		if (void 0 !== t && (!Number.isSafeInteger(t) || t < 0)) throw new Rs(-22, "Snapshot timestamp must be a non-negative safe integer in milliseconds");
		const n = void 0 === t ? void 0 : BigInt(t);
		for (let o = 0; o < ws; o++) {
			const e = 256 + 24 * o;
			if (0 !== Atomics.load(this.i32, e >> 2)) throw new Rs(-16, "Cannot save a VFS image with open descriptors");
		}
		const r = this.r32(ks);
		for (let o = 0; o < r; o++) {
			const e = this.inodeOffset(o);
			if (0 !== this.r32(e + zs)) throw new Rs(-16, "Cannot save a VFS image with open inode references");
		}
		const i = new Uint8Array(this.buffer.byteLength);
		i.set(this.u8);
		const s = new DataView(i.buffer);
		s.setUint32(60, 0, !0), s.setUint32(64, 0, !0), i.fill(0, 256, ms);
		for (let o = 0; o < r; o++) {
			const e = this.inodeOffset(o);
			if (s.setUint32(e + 0, 0, !0), s.setUint32(e + zs, 0, !0), void 0 !== n) {
				const t = o >= 1 && this.inodeIsAllocated(o) ? n : 0n;
				s.setBigUint64(e + 40, t, !0), s.setBigUint64(e + Cs, t, !0), s.setBigUint64(e + Ps, t, !0);
			}
		}
		return i;
	}
	collectIdentityStateUnlocked() {
		const e = /* @__PURE__ */ new Map(), t = [{
			ino: 1,
			path: "/"
		}], n = /* @__PURE__ */ new Set();
		for (; t.length > 0;) {
			const r = t.pop();
			if (n.has(r.ino)) throw new Rs(-5);
			n.add(r.ino);
			const i = this.inodeOffset(r.ino);
			if (16384 != (61440 & this.r32(i + 8))) throw new Rs(-5);
			const s = this.r64(i + Is);
			let o = 0;
			for (; o < s;) {
				const n = Math.floor(o / ms), i = o % ms, a = this.inodeBlockMap(r.ino, n, !1);
				if (a <= 0) throw new Rs(-5);
				const c = a * ms, l = Math.min(s - o, ms - i);
				let h = i;
				for (; h < i + l;) {
					const n = c + h, s = this.r32(n), o = this.view.getUint16(n + 4, !0), a = this.view.getUint16(n + 6, !0);
					if (!this.isValidDirEntry(h, i + l, o, a)) throw new Rs(-5);
					if (0 !== s) {
						if (!this.inodeIsAllocated(s)) throw new Rs(-5);
						const i = $s(this.u8.subarray(n + 8, n + 8 + a));
						if ("." !== i && ".." !== i) {
							const n = "/" === r.path ? `/${i}` : `${r.path}/${i}`, o = this.inodeOffset(s), a = this.r64(o + Ms), c = `${s}:${a}`;
							let l = e.get(c);
							l || (l = {
								ino: s,
								generation: a,
								dataSequence: Atomics.load(this.i32, o + Ts >> 2) >>> 0,
								paths: []
							}, e.set(c, l)), l.paths.push(n), 16384 == (61440 & this.r32(o + 8)) && t.push({
								ino: s,
								path: n
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
		const e = this.r32(8), t = this.r32(bs), n = this.r32(68), r = "number" == typeof this.buffer.maxByteLength ? this.buffer.maxByteLength : this.buffer.byteLength, i = Math.floor(r / e), s = Math.max(t, Math.min(n, i));
		return {
			blockSize: e,
			totalBlocks: s,
			freeBlocks: Atomics.load(this.i32, 5) + Math.max(0, s - t),
			totalInodes: this.r32(ks),
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
		} catch (n) {
			if (!(n instanceof TypeError)) throw n;
			this.atomicsWaitAllowed = !1;
		}
		for (; Atomics.load(this.i32, e) === t;);
	}
	resetAllocationHints() {
		this.blockAllocHint = this.findNextFreeBlockHint(), this.inodeAllocHint = this.findNextFreeInodeHint();
	}
	findNextFreeBlockHint() {
		const e = this.r32(bs), t = this.r32(40), n = this.r32(32) * ms;
		for (let r = t; r < e; r++) {
			const e = (n >> 2) + (r >> 5), t = 31 & r;
			if (!(Atomics.load(this.i32, e) & 1 << t)) return r;
		}
		return t;
	}
	findNextFreeInodeHint() {
		const e = this.r32(ks), t = this.r32(vs) * ms;
		for (let n = 2; n < e; n++) {
			const e = (t >> 2) + (n >> 5), r = 31 & n;
			if (!(Atomics.load(this.i32, e) & 1 << r)) return n;
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
		Atomics.store(this.i32, 15, 0), Atomics.store(this.i32, 16, 0), this.u8.fill(0, 256, ms);
		const e = this.r32(ks), t = this.r32(vs) * ms;
		for (let n = 0; n < e; n++) {
			const e = this.inodeOffset(n);
			if (this.w32(e + 0, 0), this.w32(e + zs, 0), n < 2) continue;
			if (!(this.r32(t + 4 * (n >> 5)) & 1 << (31 & n))) continue;
			if (0 !== this.r32(e + As)) continue;
			const r = this.r32(e + 8), i = this.r64(e + Is);
			40960 == (61440 & r) && i <= 40 ? (this.u8.fill(0, e + Es, e + Es + 40), this.w64(e + Is, 0)) : this.inodeTruncate(n, 0), this.inodeFree(n);
		}
	}
	blockAlloc() {
		const e = this.r32(bs), t = this.r32(32) * ms, n = this.r32(40), r = this.blockAllocHint >= n && this.blockAllocHint < e ? this.blockAllocHint : n, i = e - n;
		for (let s = 0; s < i; s++) {
			const o = n + (r - n + s) % i, a = (t >> 2) + (o >> 5), c = 31 & o, l = Atomics.load(this.i32, a);
			if (l & 1 << c) continue;
			const h = l | 1 << c;
			if (Atomics.compareExchange(this.i32, a, l, h) === l) {
				Atomics.sub(this.i32, 5, 1), this.blockAllocHint = o + 1 < e ? o + 1 : n;
				const t = o * ms;
				return this.u8.fill(0, t, t + ms), o;
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
		const t = (this.r32(32) * ms >> 2) + (e >> 5), n = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t), r = e & ~(1 << n);
			if (Atomics.compareExchange(this.i32, t, e, r) === e) break;
		}
		Atomics.add(this.i32, 5, 1), e >= this.r32(40) && e < this.blockAllocHint && (this.blockAllocHint = e);
	}
	grow() {
		this.sbLock();
		try {
			if (Atomics.load(this.i32, 5) > 0) return 0;
			const e = this.r32(bs), t = this.r32(68);
			let n = this.r32(72), r = e + n;
			if (r > t && (r = t, n = r - e, 0 === n)) return -28;
			const i = r * ms;
			if (this.buffer.byteLength < i) try {
				this.buffer.grow(i), this.view = new DataView(this.buffer), this.i32 = new Int32Array(this.buffer), this.u8 = new Uint8Array(this.buffer);
			} catch {
				return -28;
			}
			return this.w32(bs, r), Atomics.add(this.i32, 5, n), Atomics.add(this.i32, 14, 1), this.blockAllocHint = e, 0;
		} finally {
			this.sbUnlock();
		}
	}
	inodeOffset(e) {
		return (this.r32(36) + Math.floor(e / 32)) * ms + e % 32 * 128;
	}
	inodeAlloc() {
		const e = this.r32(ks), t = this.r32(vs) * ms, n = this.inodeAllocHint >= 2 && this.inodeAllocHint < e ? this.inodeAllocHint : 2, r = e - 2;
		for (let i = 0; i < r; i++) {
			const s = 2 + (n - 2 + i) % r, o = (t >> 2) + (s >> 5), a = 31 & s, c = Atomics.load(this.i32, o);
			if (c & 1 << a) continue;
			const l = c | 1 << a;
			if (Atomics.compareExchange(this.i32, o, c, l) === c) {
				Atomics.sub(this.i32, 6, 1), this.inodeAllocHint = s + 1 < e ? s + 1 : 2;
				const t = this.inodeOffset(s);
				return this.u8.fill(0, t, t + 128), this.w64(t + Ms, this.nextInodeGeneration()), s;
			}
			i--;
		}
		return -28;
	}
	nextInodeGeneration() {
		return Atomics.add(this.i32, 14, 1) + 1;
	}
	inodeFree(e) {
		const t = (this.r32(vs) * ms >> 2) + (e >> 5), n = 31 & e;
		for (;;) {
			const e = Atomics.load(this.i32, t);
			if (!(e & 1 << n)) throw new Rs(-5);
			const r = e & ~(1 << n);
			if (Atomics.compareExchange(this.i32, t, e, r) === e) break;
		}
		Atomics.add(this.i32, 6, 1), e >= 2 && e < this.inodeAllocHint && (this.inodeAllocHint = e);
	}
	inodeAddOpenRef(e) {
		this.inodeWriteLock(e);
		try {
			const t = this.inodeOffset(e);
			return 0 !== this.r32(t + As) && (this.w32(t + zs, this.r32(t + zs) + 1), !0);
		} finally {
			this.inodeWriteUnlock(e);
		}
	}
	inodeDropOpenRef(e) {
		let t = !1;
		this.inodeWriteLock(e);
		try {
			const n = this.inodeOffset(e), r = this.r32(n + zs);
			r > 0 && this.w32(n + zs, r - 1), r <= 1 && 0 === this.r32(n + As) && (this.inodeTruncate(e, 0), t = !0);
		} finally {
			this.inodeWriteUnlock(e);
		}
		t && this.inodeFree(e);
	}
	inodeDropLinkRefLocked(e) {
		const t = this.inodeOffset(e), n = this.r32(t + As);
		return n > 1 ? (this.w32(t + As, n - 1), this.w64(t + Ps, Date.now()), !1) : this.inodeOrphanLocked(e);
	}
	inodeOrphanLocked(e) {
		const t = this.inodeOffset(e);
		if (this.w32(t + As, 0), this.w64(t + Ps, Date.now()), this.r32(t + zs) > 0) return !1;
		const n = this.r32(t + 8), r = this.r64(t + Is);
		return 40960 == (61440 & n) && r <= 40 ? (this.u8.fill(0, t + Es, t + Es + 40), this.w64(t + Is, 0)) : this.inodeTruncate(e, 0), !0;
	}
	inodeReadLock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		for (;;) {
			const e = Atomics.load(this.i32, t);
			if (e & Ls) this.waitForAtomicChange(t, e);
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
				if (0 === Atomics.compareExchange(this.i32, t, 0, Ls)) return;
			} else this.waitForAtomicChange(t, e);
		}
	}
	inodeWriteUnlock(e) {
		const t = this.inodeOffset(e) + 0 >> 2;
		Atomics.store(this.i32, t, 0), Atomics.notify(this.i32, t, Infinity);
	}
	inodeBlockMap(e, t, n) {
		const r = this.inodeOffset(e);
		if (t < 10) {
			const e = this.r32(r + Es + 4 * t);
			if (0 !== e) return e;
			if (!n) return 0;
			const i = this.blockAllocWithGrow();
			return i < 0 || this.w32(r + Es + 4 * t, i), i;
		}
		if ((t -= 10) < 1024) {
			let e = this.r32(r + 88), i = !1;
			if (0 === e) {
				if (!n) return 0;
				if (e = this.blockAllocWithGrow(), e < 0) return e;
				this.w32(r + 88, e), i = !0;
			}
			const s = e * ms + 4 * t, o = this.r32(s);
			if (0 !== o) return o;
			if (!n) return 0;
			const a = this.blockAllocWithGrow();
			return a < 0 ? (i && (this.w32(r + 88, 0), this.blockFree(e)), a) : (this.w32(s, a), a);
		}
		if ((t -= ys) < 1048576) {
			const e = Math.floor(t / ys), i = t % ys;
			let s = this.r32(r + xs), o = !1;
			if (0 === s) {
				if (!n) return 0;
				if (s = this.blockAllocWithGrow(), s < 0) return s;
				this.w32(r + xs, s), o = !0;
			}
			const a = s * ms + 4 * e;
			let c = this.r32(a), l = !1;
			if (0 === c) {
				if (!n) return 0;
				if (c = this.blockAllocWithGrow(), c < 0) return o && (this.w32(r + xs, 0), this.blockFree(s)), c;
				this.w32(a, c), l = !0;
			}
			const h = c * ms + 4 * i, d = this.r32(h);
			if (0 !== d) return d;
			if (!n) return 0;
			const f = this.blockAllocWithGrow();
			return f < 0 ? (l && (this.w32(a, 0), this.blockFree(c)), o && (this.w32(r + xs, 0), this.blockFree(s)), f) : (this.w32(h, f), f);
		}
		return -22;
	}
	inodeReadData(e, t, n, r) {
		const i = this.inodeOffset(e), s = this.r64(i + Is);
		if (t >= s) return 0;
		t + r > s && (r = s - t);
		let o = 0, a = 0;
		for (; r > 0;) {
			const i = Math.floor(t / ms), s = t % ms;
			let c = ms - s;
			c > r && (c = r);
			const l = this.inodeBlockMap(e, i, !1);
			if (l <= 0) n.fill(0, a, a + c);
			else {
				const e = l * ms + s;
				n.set(this.u8.subarray(e, e + c), a);
			}
			a += c, t += c, r -= c, o += c;
		}
		return o;
	}
	inodeWriteData(e, t, n, r) {
		const i = this.inodeOffset(e), s = this.r64(i + Is);
		t > s && this.zeroOldEofTail(e, s);
		let o = 0, a = 0;
		for (; r > 0;) {
			const i = Math.floor(t / ms), s = t % ms;
			let c = ms - s;
			c > r && (c = r);
			const l = this.inodeBlockMap(e, i, !0);
			if (l < 0) {
				if (0 === o) return l;
				break;
			}
			const h = l * ms + s;
			this.u8.set(n.subarray(a, a + c), h), a += c, t += c, r -= c, o += c;
		}
		if (o > 0 && t > this.r64(i + Is) && this.w64(i + Is, t), o > 0) {
			const e = Date.now();
			this.w64(i + Cs, e), this.w64(i + Ps, e), Atomics.add(this.i32, i + Ts >> 2, 1);
		}
		return o;
	}
	zeroInodeRange(e, t, n) {
		for (; t < n;) {
			const r = Math.floor(t / ms), i = t % ms, s = Math.min(ms - i, n - t), o = this.inodeBlockMap(e, r, !1);
			if (o > 0) {
				const e = o * ms + i;
				this.u8.fill(0, e, e + s);
			}
			t += s;
		}
	}
	zeroOldEofTail(e, t) {
		const n = t % ms;
		if (0 === n) return;
		const r = Math.floor(t / ms), i = this.inodeBlockMap(e, r, !1);
		if (i <= 0) return;
		const s = i * ms + n;
		this.u8.fill(0, s, i * ms + ms);
	}
	freeBlocksFrom(e, t) {
		const n = this.inodeOffset(e);
		for (let s = t; s < 10; s++) {
			const e = this.r32(n + Es + 4 * s);
			e && (this.blockFree(e), this.w32(n + Es + 4 * s, 0));
		}
		const r = this.r32(n + 88);
		if (r) {
			const e = t > 10 ? t - 10 : 0;
			for (let t = e; t < ys; t++) {
				const e = r * ms + 4 * t, n = this.r32(e);
				n && (this.blockFree(n), this.w32(e, 0));
			}
			0 === e && (this.blockFree(r), this.w32(n + 88, 0));
		}
		const i = this.r32(n + xs);
		if (i) {
			const e = t > 1034 ? t - 10 - ys : 0, r = Math.floor(e / ys);
			for (let t = r; t < ys; t++) {
				const n = i * ms + 4 * t, s = this.r32(n);
				if (!s) continue;
				const o = t === r ? e % ys : 0;
				for (let e = o; e < ys; e++) {
					const t = s * ms + 4 * e, n = this.r32(t);
					n && (this.blockFree(n), this.w32(t, 0));
				}
				0 === o && (this.blockFree(s), this.w32(n, 0));
			}
			0 === r && (this.blockFree(i), this.w32(n + xs, 0));
		}
	}
	inodeTruncate(e, t, n = !1) {
		const r = this.inodeOffset(e), i = this.r64(r + Is), s = t !== i;
		if (t >= i) {
			if (t > i && this.zeroOldEofTail(e, i), this.w64(r + Is, t), s || n) {
				const e = Date.now();
				this.w64(r + Cs, e), this.w64(r + Ps, e), Atomics.add(this.i32, r + Ts >> 2, 1);
			}
			return;
		}
		t % 4096 != 0 && this.zeroInodeRange(e, t, Math.ceil(t / ms) * ms);
		const o = Math.ceil(t / ms);
		if (this.freeBlocksFrom(e, o), this.w64(r + Is, t), s || n) {
			const e = Date.now();
			this.w64(r + Cs, e), this.w64(r + Ps, e), Atomics.add(this.i32, r + Ts >> 2, 1);
		}
	}
	validateFileSize(e) {
		if (!Number.isSafeInteger(e) || e < 0) throw new Rs(-22);
		if (e > Bs) throw new Rs(-27);
	}
	validateSeekPosition(e) {
		if (!Number.isSafeInteger(e)) throw new Rs(-75);
		if (e < 0) throw new Rs(-22);
		if (e > Bs) throw new Rs(-27);
	}
	touchDirectoryMutation(e) {
		const t = this.inodeOffset(e), n = Date.now();
		this.w64(t + Cs, n), this.w64(t + Ps, n);
		const r = Atomics.add(this.i32, t + 116 >> 2, 1) + 1 >>> 0, i = this.dirIndexes.get(e);
		i && (i.mutationSequence = r, i.size = this.r64(t + Is));
	}
	dirNameKey(e) {
		return $s(e);
	}
	dirEntryNameMatches(e, t) {
		if (this.view.getUint16(e + 6, !0) !== t.length) return !1;
		for (let n = 0; n < t.length; n++) if (this.u8[e + 8 + n] !== t[n]) return !1;
		return !0;
	}
	isValidDirEntry(e, t, n, r) {
		return n >= 8 && n % 4 == 0 && e + n <= t && r <= n - 8;
	}
	inodeIsAllocated(e) {
		const t = this.r32(ks);
		if (e <= 0 || e >= t) return !1;
		const n = this.r32(vs) * ms;
		return !!(Atomics.load(this.i32, (n >> 2) + (e >> 5)) & 1 << (31 & e));
	}
	rebuildDirIndex(e, t, n, r) {
		const i = /* @__PURE__ */ new Map(), s = [];
		let o = 0;
		for (; o < r;) {
			const t = Math.floor(o / ms), n = o % ms, a = this.inodeBlockMap(e, t, !1);
			if (a <= 0) return -5;
			const c = a * ms;
			let l = r - o;
			l > 4096 - n && (l = ms - n);
			let h = n;
			for (; h < n + l;) {
				const e = c + h, t = this.r32(e), r = this.view.getUint16(e + 4, !0), o = this.view.getUint16(e + 6, !0);
				if (!this.isValidDirEntry(h, n + l, r, o)) return -5;
				if (0 !== t) {
					if (!this.inodeIsAllocated(t)) return -5;
					const n = $s(this.u8.subarray(e + 8, e + 8 + o));
					i.set(n, {
						ino: t,
						abs: e,
						recLen: r,
						nameLen: o
					});
				} else r >= 8 && s.push({
					abs: e,
					recLen: r
				});
				h += r;
			}
			o += l;
		}
		const a = {
			generation: t,
			mutationSequence: n,
			size: r,
			entries: i,
			free: s
		};
		return this.dirIndexes.set(e, a), a;
	}
	getDirIndex(t) {
		const n = this.inodeOffset(t), r = this.r64(n + Is), i = this.r64(n + Ms), s = Atomics.load(this.i32, n + 116 >> 2) >>> 0, o = this.dirIndexes.get(t);
		return o && o.generation === i && o.mutationSequence === s && o.size === r ? o : (o && this.dirIndexes.delete(t), r < e.DIR_INDEX_MIN_SIZE ? null : this.rebuildDirIndex(t, i, s, r));
	}
	updateDirIndexAdd(e, t, n, r, i) {
		const s = this.inodeOffset(e), o = this.r64(s + Is), a = this.r64(s + Ms), c = this.dirIndexes.get(e);
		c && (c.generation === a ? (c.size = o, c.entries.set(this.dirNameKey(t), {
			ino: n,
			abs: r,
			recLen: i,
			nameLen: t.length
		})) : this.dirIndexes.delete(e));
	}
	useDirIndexFreeSlot(e, t, n, r) {
		const i = Os(8 + n.length);
		for (let s = e.free.length - 1; s >= 0; s--) {
			const o = e.free[s];
			if (!(o.recLen < i) && (e.free.splice(s, 1), 0 === this.r32(o.abs) && this.view.getUint16(o.abs + 4, !0) === o.recLen)) return this.w32(o.abs, r), this.view.setUint16(o.abs + 6, n.length, !0), this.u8.set(n, o.abs + 8), this.touchDirectoryMutation(t), this.updateDirIndexAdd(t, n, r, o.abs, o.recLen), !0;
		}
		return !1;
	}
	updateDirIndexRemove(e, t) {
		const n = this.inodeOffset(e), r = this.r64(n + Is), i = this.r64(n + Ms), s = this.dirIndexes.get(e);
		s && (s.generation === i && s.size === r ? s.entries.delete(this.dirNameKey(t)) : this.dirIndexes.delete(e));
	}
	updateDirIndexRecLen(e, t, n) {
		const r = this.dirIndexes.get(e);
		if (r) {
			for (const i of r.entries.values()) if (i.abs === t) return void (i.recLen = n);
		}
	}
	dirLookup(e, t) {
		const n = this.getDirIndex(e);
		if ("number" == typeof n) return n;
		if (n) {
			const e = n.entries.get(this.dirNameKey(t));
			return e ? this.r32(e.abs) === e.ino && this.inodeIsAllocated(e.ino) && this.view.getUint16(e.abs + 4, !0) === e.recLen && this.view.getUint16(e.abs + 6, !0) === e.nameLen && this.dirEntryNameMatches(e.abs, t) ? e.ino : (n.entries.delete(this.dirNameKey(t)), -2) : -2;
		}
		const r = this.inodeOffset(e), i = this.r64(r + Is);
		let s = 0;
		for (; s < i;) {
			const n = Math.floor(s / ms), r = s % ms, o = this.inodeBlockMap(e, n, !1);
			if (o <= 0) return -5;
			const a = o * ms;
			let c = i - s;
			c > 4096 - r && (c = ms - r);
			let l = r;
			for (; l < r + c;) {
				const e = a + l, n = this.r32(e), i = this.view.getUint16(e + 4, !0), s = this.view.getUint16(e + 6, !0);
				if (!this.isValidDirEntry(l, r + c, i, s)) return -5;
				if (0 !== n && s === t.length) {
					let r = !0;
					for (let n = 0; n < t.length; n++) if (this.u8[e + 8 + n] !== t[n]) {
						r = !1;
						break;
					}
					if (r) return this.inodeIsAllocated(n) ? n : -5;
				}
				l += i;
			}
			s += c;
		}
		return -2;
	}
	findLastDirEntryInBlock(e, t, n) {
		const r = this.inodeBlockMap(e, t, !1);
		if (r <= 0) return -1;
		const i = r * ms;
		let s = 0, o = -1;
		for (; s < n;) {
			const e = i + s, t = this.view.getUint16(e + 4, !0);
			if (t < 8 || t % 4 != 0 || s + t > n) return -1;
			o = e, s += t;
		}
		return s === n ? o : -1;
	}
	dirAppendEntry(e, t, n, r = -1) {
		const i = this.inodeOffset(e), s = this.r64(i + Is), o = Os(8 + t.length);
		let a, c = s, l = Math.floor(c / ms), h = c % ms, d = 0;
		if (0 !== h && h + o > 4096) {
			const t = ms - h;
			let n = 0;
			if (t >= 8) {
				if (n = this.inodeBlockMap(e, l, !1), n <= 0) return -5;
			} else if (r < 0 && (r = this.findLastDirEntryInBlock(e, l, h)), r < 0) return -5;
			if (d = this.inodeBlockMap(e, l + 1, !0), d < 0) return d;
			if (t >= 8) {
				const e = n * ms + h;
				this.w32(e, 0), this.view.setUint16(e + 4, t, !0), this.view.setUint16(e + 6, 0, !0);
			} else {
				const n = this.view.getUint16(r + 4, !0) + t;
				this.view.setUint16(r + 4, n, !0), this.updateDirIndexRecLen(e, r, n);
			}
			c = (l + 1) * ms, l++, h = 0;
		}
		if (0 === h) {
			if (a = d || this.inodeBlockMap(e, l, !0), a < 0) return a;
		} else if (a = this.inodeBlockMap(e, l, !1), a <= 0) return -5;
		const f = a * ms + h;
		return this.w32(f, n), this.view.setUint16(f + 4, o, !0), this.view.setUint16(f + 6, t.length, !0), this.u8.set(t, f + 8), this.w64(i + Is, c + o), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, n, f, o), 0;
	}
	dirAddEntry(e, t, n) {
		const r = this.getDirIndex(e);
		if ("number" == typeof r) return r;
		if (r) return this.useDirIndexFreeSlot(r, e, t, n) ? 0 : this.dirAppendEntry(e, t, n);
		const i = this.inodeOffset(e), s = this.r64(i + Is), o = Os(8 + t.length);
		let a = -1, c = 0;
		for (; c < s;) {
			const r = Math.floor(c / ms), i = c % ms, l = this.inodeBlockMap(e, r, !1);
			if (l <= 0) return -5;
			const h = l * ms;
			let d = s - c;
			d > 4096 - i && (d = ms - i);
			let f = i;
			for (; f < i + d;) {
				const r = h + f, s = this.r32(r), c = this.view.getUint16(r + 4, !0), l = this.view.getUint16(r + 6, !0);
				if (c < 8 || c % 4 != 0 || f + c > i + d || l > c - 8) return -5;
				if (0 === s && c >= o) return this.w32(r, n), this.view.setUint16(r + 6, t.length, !0), this.u8.set(t, r + 8), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, n, r, c), 0;
				const u = Os(8 + l), p = c - u;
				if (0 !== s && p >= o) {
					this.view.setUint16(r + 4, u, !0);
					const i = r + u;
					return this.w32(i, n), this.view.setUint16(i + 4, p, !0), this.view.setUint16(i + 6, t.length, !0), this.u8.set(t, i + 8), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, n, i, p), 0;
				}
				a = r, f += c;
			}
			c += d;
		}
		return this.dirAppendEntry(e, t, n, a);
	}
	dirRemoveEntry(e, t) {
		const n = this.getDirIndex(e);
		if ("number" == typeof n) return n;
		if (n) {
			const r = this.dirNameKey(t), i = n.entries.get(r);
			if (!i) return -2;
			if (this.r32(i.abs) === i.ino && this.view.getUint16(i.abs + 4, !0) === i.recLen && this.view.getUint16(i.abs + 6, !0) === i.nameLen && this.dirEntryNameMatches(i.abs, t)) return this.w32(i.abs, 0), n.entries.delete(r), n.free.push({
				abs: i.abs,
				recLen: i.recLen
			}), this.touchDirectoryMutation(e), 0;
			n.entries.delete(r);
		}
		const r = this.inodeOffset(e), i = this.r64(r + Is);
		let s = 0;
		for (; s < i;) {
			const n = Math.floor(s / ms), r = s % ms, o = this.inodeBlockMap(e, n, !1);
			if (o <= 0) return -5;
			const a = o * ms;
			let c = i - s;
			c > 4096 - r && (c = ms - r);
			let l = r;
			for (; l < r + c;) {
				const n = a + l, i = this.r32(n), s = this.view.getUint16(n + 4, !0), o = this.view.getUint16(n + 6, !0);
				if (!this.isValidDirEntry(l, r + c, s, o)) return -5;
				if (0 !== i && o === t.length) {
					let r = !0;
					for (let e = 0; e < t.length; e++) if (this.u8[n + 8 + e] !== t[e]) {
						r = !1;
						break;
					}
					if (r) return this.w32(n, 0), this.touchDirectoryMutation(e), this.updateDirIndexRemove(e, t), 0;
				}
				l += s;
			}
			s += c;
		}
		return -2;
	}
	dirReplaceEntryIno(e, t, n) {
		const r = this.getDirIndex(e);
		if ("number" == typeof r) return r;
		if (r) {
			const i = this.dirNameKey(t), s = r.entries.get(i);
			if (s && this.r32(s.abs) === s.ino && this.view.getUint16(s.abs + 4, !0) === s.recLen && this.view.getUint16(s.abs + 6, !0) === s.nameLen && this.dirEntryNameMatches(s.abs, t)) return this.w32(s.abs, n), s.ino = n, this.touchDirectoryMutation(e), 0;
			s && r.entries.delete(i);
		}
		const i = this.inodeOffset(e), s = this.r64(i + Is);
		let o = 0;
		for (; o < s;) {
			const r = Math.floor(o / ms), i = o % ms, a = this.inodeBlockMap(e, r, !1);
			if (a <= 0) return -5;
			const c = a * ms;
			let l = s - o;
			l > 4096 - i && (l = ms - i);
			let h = i;
			for (; h < i + l;) {
				const r = c + h, s = this.r32(r), o = this.view.getUint16(r + 4, !0), a = this.view.getUint16(r + 6, !0);
				if (!this.isValidDirEntry(h, i + l, o, a)) return -5;
				if (0 !== s && a === t.length) {
					let i = !0;
					for (let e = 0; e < t.length; e++) if (this.u8[r + 8 + e] !== t[e]) {
						i = !1;
						break;
					}
					if (i) return this.w32(r, n), this.touchDirectoryMutation(e), this.updateDirIndexAdd(e, t, n, r, o), 0;
				}
				h += o;
			}
			o += l;
		}
		return -2;
	}
	dirIsEmpty(e) {
		const t = this.inodeOffset(e), n = this.r64(t + Is);
		let r = 0;
		for (; r < n;) {
			const t = Math.floor(r / ms), i = r % ms, s = this.inodeBlockMap(e, t, !1);
			if (s <= 0) throw new Rs(-5);
			const o = s * ms;
			let a = n - r;
			a > 4096 - i && (a = ms - i);
			let c = i;
			for (; c < i + a;) {
				const e = o + c, t = this.r32(e), n = this.view.getUint16(e + 4, !0), r = this.view.getUint16(e + 6, !0);
				if (n < 8 || n % 4 != 0 || c + n > i + a || r > n - 8) throw new Rs(-5);
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
	dirIsAncestor(e, t) {
		let n = t;
		for (let r = 0; r < 8192; r++) {
			if (n === e) return !0;
			if (1 === n) return !1;
			const t = this.dirLookup(n, Ws);
			if (t < 0 || t === n) throw new Rs(-5);
			n = t;
		}
		throw new Rs(-5);
	}
	pathResolve(e, t) {
		if (!e.startsWith("/")) return -2;
		let n = 1;
		const r = e.split("/").filter((e) => e.length > 0);
		let i = 0;
		for (let s = 0; s < r.length; s++) {
			const e = r[s];
			if (e.length > 255) return -36;
			const o = Hs.encode(e);
			let a;
			this.inodeReadLock(n);
			try {
				const e = this.inodeOffset(n);
				if (16384 != (61440 & this.r32(e + 8))) return -20;
				a = this.dirLookup(n, o);
			} finally {
				this.inodeReadUnlock(n);
			}
			if (a < 0) return a;
			const c = this.inodeOffset(a);
			if (40960 == (61440 & this.r32(c + 8)) && (s !== r.length - 1 || t)) {
				if (++i > 8) return -40;
				const e = this.r64(c + Is);
				let t;
				if (e <= 40) t = $s(this.u8.subarray(c + Es, c + Es + e));
				else {
					const n = new Uint8Array(e);
					this.inodeReadData(a, 0, n, e), t = Fs.decode(n);
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
			n = a;
		}
		return n;
	}
	pathResolveParent(e) {
		if (!e.startsWith("/")) throw new Rs(-22, "Path must be absolute");
		const t = e.split("/").filter((e) => e.length > 0);
		if (0 === t.length) throw new Rs(-22, "Cannot operate on /");
		const n = t.pop();
		if (n.length > 255) throw new Rs(-36);
		const r = "/" + t.join("/"), i = this.pathResolve(r, !0);
		if (i < 0) throw new Rs(i);
		const s = this.inodeOffset(i);
		if (16384 != (61440 & this.r32(s + 8))) throw new Rs(-20);
		return {
			parentIno: i,
			name: n
		};
	}
	fdAlloc(e, t, n) {
		for (let r = 0; r < ws; r++) {
			const i = 256 + 24 * r, s = i >> 2;
			if (0 === Atomics.compareExchange(this.i32, s, 0, 1)) return this.w32(i + 4, e), this.w64(i + 8, 0), this.w32(i + 16, t), this.w32(i + 20, n ? 1 : 0), this.inodeAddOpenRef(e) ? r : (Atomics.store(this.i32, s, 0), -2);
		}
		return -24;
	}
	fdGet(e) {
		if (e < 0 || e >= ws) return null;
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
		if (e >= 0 && e < ws) {
			const t = 256 + 24 * e;
			Atomics.store(this.i32, t >> 2, 0);
		}
	}
	buildStat(e) {
		const t = this.inodeOffset(e);
		return {
			ino: e,
			generation: this.r64(t + Ms),
			dataSequence: this.r32(t + Ts),
			mode: this.r32(t + 8),
			linkCount: this.r32(t + As),
			size: this.r64(t + Is),
			mtime: this.r64(t + Cs),
			ctime: this.r64(t + Ps),
			atime: this.r64(t + 40),
			uid: this.r32(t + 96),
			gid: this.r32(t + 100)
		};
	}
	namespaceEntryIdentity(e) {
		const t = this.inodeOffset(e);
		return {
			ino: e,
			generation: this.r64(t + Ms),
			linkCount: this.r32(t + As),
			mode: this.r32(t + 8)
		};
	}
	open(e, t, n = 420) {
		return this.withNamespaceLock(() => this.openUnlocked(e, t, n));
	}
	createLazyStub(e, t) {
		return this.withNamespaceLock(() => {
			const n = this.openUnlocked(e, 65, t);
			try {
				const e = this.fdGet(n);
				if (!e) throw new Rs(-9);
				this.inodeWriteLock(e.ino);
				try {
					return this.inodeTruncate(e.ino, 0, !0), this.buildStat(e.ino);
				} finally {
					this.inodeWriteUnlock(e.ino);
				}
			} finally {
				this.closeUnlocked(n);
			}
		});
	}
	replaceIfIdentity(e, t, n, r, i) {
		return this.withNamespaceLock(() => {
			const s = this.pathResolve(e, !0);
			if (s < 0 || s !== t) return !1;
			const o = this.inodeOffset(s);
			if (this.r64(o + Ms) !== n || this.r32(o + Ts) !== r) return !1;
			if (32768 != (61440 & this.r32(o + 8))) return !1;
			this.validateFileSize(i.byteLength), this.inodeWriteLock(s);
			try {
				if (this.r64(o + Ms) !== n || this.r32(o + Ts) !== r) return !1;
				if (0 !== this.r64(o + Is)) return !1;
				const e = this.r64(o + Cs), t = this.r64(o + Ps);
				this.inodeTruncate(s, 0, !0);
				const a = i.byteLength > 0 ? this.inodeWriteData(s, 0, i, i.byteLength) : 0;
				if (a !== i.byteLength) throw this.inodeTruncate(s, 0, !0), Atomics.store(this.i32, o + Ts >> 2, r), this.w64(o + Cs, e), this.w64(o + Ps, t), new Rs(a < 0 ? a : -28);
				return !0;
			} finally {
				this.inodeWriteUnlock(s);
			}
		});
	}
	replaceManyIfIdentities(e) {
		return 0 === e.length || this.withNamespaceLock(() => {
			const t = [], n = /* @__PURE__ */ new Set();
			for (const s of e) {
				this.validateFileSize(s.data.byteLength);
				let e = -1;
				for (const t of s.paths) {
					const n = this.pathResolve(t, !0);
					if (n !== s.expectedIno) continue;
					const r = this.inodeOffset(n);
					if (this.r64(r + Ms) === s.expectedGeneration && this.r32(r + Ts) === s.expectedDataSequence && 32768 == (61440 & this.r32(r + 8)) && 0 === this.r64(r + Is)) {
						e = n;
						break;
					}
				}
				if (e < 0) return !1;
				if (n.has(e)) throw new Rs(-22, "duplicate conditional replacement inode");
				n.add(e), t.push({
					...s,
					ino: e
				});
			}
			const r = [...n].sort((e, t) => e - t);
			for (const e of r) this.inodeWriteLock(e);
			try {
				for (const r of t) {
					const e = this.inodeOffset(r.ino);
					if (this.r64(e + Ms) !== r.expectedGeneration || this.r32(e + Ts) !== r.expectedDataSequence || 32768 != (61440 & this.r32(e + 8)) || 0 !== this.r64(e + Is)) return !1;
				}
				const e = t.map((e) => {
					const t = this.inodeOffset(e.ino);
					return {
						ino: e.ino,
						dataSequence: this.r32(t + Ts),
						mtime: this.r64(t + Cs),
						ctime: this.r64(t + Ps)
					};
				});
				let n = 0;
				try {
					for (const e of t) {
						n++, this.inodeTruncate(e.ino, 0, !0);
						const t = e.data.byteLength > 0 ? this.inodeWriteData(e.ino, 0, e.data, e.data.byteLength) : 0;
						if (t !== e.data.byteLength) throw new Rs(t < 0 ? t : -28);
					}
				} catch (i) {
					for (let t = n - 1; t >= 0; t--) {
						const n = e[t], r = this.inodeOffset(n.ino);
						this.inodeTruncate(n.ino, 0, !0), Atomics.store(this.i32, r + Ts >> 2, n.dataSequence), this.w64(r + Cs, n.mtime), this.w64(r + Ps, n.ctime);
					}
					throw i;
				}
				return !0;
			} finally {
				for (let e = r.length - 1; e >= 0; e--) this.inodeWriteUnlock(r[e]);
			}
		});
	}
	openUnlocked(e, t, n = 420) {
		const r = 3 & t, i = !!(64 & t), s = !!(128 & t);
		if (i && s) {
			const t = this.pathResolve(e, !1);
			if (t >= 0) throw new Rs(-17);
			if (-2 !== t) throw new Rs(t);
		}
		let o = this.pathResolve(e, !0);
		if (o < 0 && -2 === o && i) {
			const { parentIno: t, name: r } = this.pathResolveParent(e);
			this.inodeWriteLock(t);
			try {
				const e = Hs.encode(r), i = this.dirLookup(t, e);
				if (i >= 0) {
					if (s) throw new Rs(-17);
					o = i;
				} else {
					const r = this.inodeAlloc();
					if (r < 0) throw new Rs(-28);
					const i = this.inodeOffset(r);
					this.w32(i + 8, 32768 | 4095 & n), this.w32(i + As, 1), this.w64(i + Is, 0);
					const s = Date.now();
					this.w64(i + 40, s), this.w64(i + Cs, s), this.w64(i + Ps, s);
					const a = this.dirAddEntry(t, e, r);
					if (a < 0) throw this.inodeFree(r), new Rs(a);
					o = r;
				}
			} finally {
				this.inodeWriteUnlock(t);
			}
		}
		if (o < 0) throw new Rs(o);
		const a = this.inodeOffset(o), c = this.r32(a + 8);
		if (16384 == (61440 & c) && 0 !== r) throw new Rs(-21);
		if (65536 & t && 16384 != (61440 & c)) throw new Rs(-20);
		if (512 & t) {
			if (16384 == (61440 & c)) throw new Rs(-21);
			this.inodeWriteLock(o), this.inodeTruncate(o, 0, !0), this.inodeWriteUnlock(o);
		}
		const l = this.fdAlloc(o, t, !1);
		if (l < 0) throw new Rs(l);
		return l;
	}
	close(e) {
		this.withNamespaceLock(() => this.closeUnlocked(e));
	}
	closeUnlocked(e) {
		const t = this.fdGet(e);
		if (!t) throw new Rs(-9);
		this.fdFree(e), this.inodeDropOpenRef(t.ino);
	}
	read(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new Rs(-9);
		const r = this.inodeOffset(n.ino);
		if (16384 == (61440 & this.r32(r + 8))) throw new Rs(-21);
		this.inodeReadLock(n.ino);
		try {
			const r = this.inodeReadData(n.ino, n.offset, t, t.length), i = 256 + 24 * e;
			return this.w64(i + 8, n.offset + r), r;
		} finally {
			this.inodeReadUnlock(n.ino);
		}
	}
	readAt(e, t, n) {
		const r = this.fdGet(e);
		if (!r) throw new Rs(-9);
		const i = this.inodeOffset(r.ino);
		if (16384 == (61440 & this.r32(i + 8))) throw new Rs(-21);
		this.validateSeekPosition(n), this.inodeReadLock(r.ino);
		try {
			return this.inodeReadData(r.ino, n, t, t.length);
		} finally {
			this.inodeReadUnlock(r.ino);
		}
	}
	write(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new Rs(-9);
		if (!(3 & n.flags)) throw new Rs(-9);
		this.inodeWriteLock(n.ino);
		try {
			let r = n.offset;
			if (1024 & n.flags) {
				const e = this.inodeOffset(n.ino);
				r = this.r64(e + Is);
			}
			if (!Number.isSafeInteger(r) || r < 0) throw new Rs(-22);
			if (r > Bs || t.length > Bs - r) throw new Rs(-27);
			const i = this.inodeWriteData(n.ino, r, t, t.length);
			if (i < 0) return i;
			const s = 256 + 24 * e;
			return this.w64(s + 8, r + i), i;
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	writeAt(e, t, n) {
		const r = this.fdGet(e);
		if (!r) throw new Rs(-9);
		if (!(3 & r.flags)) throw new Rs(-9);
		this.validateSeekPosition(n), this.inodeWriteLock(r.ino);
		try {
			if (n > Bs || t.length > Bs - n) throw new Rs(-27);
			return this.inodeWriteData(r.ino, n, t, t.length);
		} finally {
			this.inodeWriteUnlock(r.ino);
		}
	}
	lseek(e, t, n) {
		const r = this.fdGet(e);
		if (!r) throw new Rs(-9);
		let i;
		if (0 === n) i = t;
		else if (1 === n) i = r.offset + t;
		else {
			if (2 !== n) throw new Rs(-22);
			{
				const e = this.inodeOffset(r.ino);
				i = this.r64(e + Is) + t;
			}
		}
		this.validateSeekPosition(i);
		const s = 256 + 24 * e;
		return this.w64(s + 8, i), i;
	}
	ftruncate(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new Rs(-9);
		if (!(3 & n.flags)) throw new Rs(-9);
		this.validateFileSize(t), this.inodeWriteLock(n.ino);
		try {
			this.inodeTruncate(n.ino, t, !0);
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	fstat(e) {
		const t = this.fdGet(e);
		if (!t) throw new Rs(-9);
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
		if (t < 0) throw new Rs(t);
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
		if (t < 0) throw new Rs(t);
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
		const { parentIno: t, name: n } = this.pathResolveParent(e), r = Hs.encode(n), i = e.length > 1 && e.endsWith("/");
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, r);
			if (e < 0) throw new Rs(e);
			const n = this.inodeOffset(e), s = this.r32(n + 8);
			if (i && 16384 != (61440 & s)) throw new Rs(-20);
			if (16384 == (61440 & s)) throw new Rs(-21);
			const o = this.namespaceEntryIdentity(e), a = this.dirRemoveEntry(t, r);
			if (a < 0) throw new Rs(a);
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
		const { parentIno: n, name: r } = this.pathResolveParent(e), { parentIno: i, name: s } = this.pathResolveParent(t);
		if (Ds(r) || Ds(s)) throw new Rs(-22);
		const o = Hs.encode(r), a = Hs.encode(s), c = e.length > 1 && e.endsWith("/"), l = t.length > 1 && t.endsWith("/"), h = Math.min(n, i), d = Math.max(n, i);
		this.inodeWriteLock(h), h !== d && this.inodeWriteLock(d);
		try {
			const e = this.dirLookup(n, o);
			if (e < 0) throw new Rs(e);
			const t = this.inodeOffset(e), r = this.r32(t + 8) & _s, s = this.namespaceEntryIdentity(e);
			if ((c || l) && 16384 !== r) throw new Rs(-20);
			if (16384 === r && this.dirIsAncestor(e, i)) throw new Rs(-22);
			const h = this.dirLookup(i, a);
			let d, f = !1;
			if (h >= 0) {
				if (h === e) return {
					source: s,
					replaced: s
				};
				d = this.namespaceEntryIdentity(h);
				const t = this.inodeOffset(h), o = this.r32(t + 8) & _s;
				if (16384 === r && 16384 !== o) throw new Rs(-20);
				if (16384 !== r && 16384 === o) throw new Rs(-21);
				let c = !1;
				const l = h === n || h === i;
				l || this.inodeWriteLock(h);
				try {
					if (16384 === o && !this.dirIsEmpty(h)) throw new Rs(-39);
					const t = this.dirReplaceEntryIno(i, a, e);
					if (t < 0) throw new Rs(t);
					c = 16384 === o ? this.inodeOrphanLocked(h) : this.inodeDropLinkRefLocked(h);
				} finally {
					l || this.inodeWriteUnlock(h);
				}
				c && this.inodeFree(h), f = 16384 === o;
			} else {
				const t = this.dirAddEntry(i, a, e);
				if (t < 0) throw new Rs(t);
			}
			const u = this.dirRemoveEntry(n, o);
			if (u < 0) throw new Rs(u);
			if (16384 === r) {
				if (n !== i) {
					const r = this.inodeOffset(n);
					this.w32(r + As, this.r32(r + As) - 1);
					const s = this.inodeOffset(i);
					this.w32(s + As, this.r32(s + As) + 1), this.inodeWriteLock(e);
					try {
						const n = this.dirReplaceEntryIno(e, Ws, i);
						if (n < 0) throw new Rs(n);
						this.w64(t + Ps, Date.now());
					} finally {
						this.inodeWriteUnlock(e);
					}
				}
				if (f) {
					const e = this.inodeOffset(i);
					this.w32(e + As, this.r32(e + As) - 1);
				}
			} else if (f) {
				const e = this.inodeOffset(i);
				this.w32(e + As, this.r32(e + As) - 1);
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
		const { parentIno: n, name: r } = this.pathResolveParent(e), i = Hs.encode(r);
		this.inodeWriteLock(n);
		try {
			if (this.dirLookup(n, i) >= 0) throw new Rs(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new Rs(-28);
			const r = this.inodeOffset(e);
			this.w32(r + 8, 16384 | t), this.w32(r + As, 2), this.w64(r + Is, 0);
			const s = Date.now();
			this.w64(r + 40, s), this.w64(r + Cs, s), this.w64(r + Ps, s);
			const o = this.blockAllocWithGrow();
			if (o < 0) throw this.inodeFree(e), new Rs(-28);
			this.w32(r + Es, o);
			const a = o * ms, c = Os(9), l = Os(10);
			this.w32(a, e), this.view.setUint16(a + 4, c, !0), this.view.setUint16(a + 6, 1, !0), this.u8[a + 8] = 46;
			const h = a + c;
			this.w32(h, n), this.view.setUint16(h + 4, l, !0), this.view.setUint16(h + 6, 2, !0), this.u8[h + 8] = 46, this.u8[h + 8 + 1] = 46, this.w64(r + Is, c + l);
			const d = this.dirAddEntry(n, i, e);
			if (d < 0) throw this.blockFree(o), this.inodeFree(e), new Rs(d);
			const f = this.inodeOffset(n);
			this.w32(f + As, this.r32(f + As) + 1);
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	rmdir(e) {
		this.withNamespaceLock(() => this.rmdirUnlocked(e));
	}
	rmdirUnlocked(e) {
		const { parentIno: t, name: n } = this.pathResolveParent(e);
		if (Ds(n)) throw new Rs(-22);
		const r = Hs.encode(n);
		this.inodeWriteLock(t);
		try {
			const e = this.dirLookup(t, r);
			if (e < 0) throw new Rs(e);
			const n = this.inodeOffset(e);
			if (16384 != (61440 & this.r32(n + 8))) throw new Rs(-20);
			let i = !1;
			this.inodeWriteLock(e);
			try {
				if (!this.dirIsEmpty(e)) throw new Rs(-39);
				const n = this.dirRemoveEntry(t, r);
				if (n < 0) throw new Rs(n);
				i = this.inodeOrphanLocked(e);
			} finally {
				this.inodeWriteUnlock(e);
			}
			i && this.inodeFree(e);
			const s = this.inodeOffset(t);
			this.w32(s + As, this.r32(s + As) - 1);
		} finally {
			this.inodeWriteUnlock(t);
		}
	}
	symlink(e, t) {
		this.withNamespaceLock(() => this.symlinkUnlocked(e, t));
	}
	symlinkUnlocked(e, t) {
		const { parentIno: n, name: r } = this.pathResolveParent(t), i = Hs.encode(r), s = Hs.encode(e);
		this.inodeWriteLock(n);
		try {
			if (this.dirLookup(n, i) >= 0) throw new Rs(-17);
			const e = this.inodeAlloc();
			if (e < 0) throw new Rs(-28);
			const t = this.inodeOffset(e);
			if (this.w32(t + 8, 41471), this.w32(t + As, 1), s.length <= 40) this.u8.set(s, t + Es), this.w64(t + Is, s.length);
			else {
				this.w64(t + Is, 0);
				const n = this.inodeWriteData(e, 0, s, s.length);
				if (n !== s.length) throw n > 0 && this.inodeTruncate(e, 0), this.inodeFree(e), new Rs(n < 0 ? n : -28);
			}
			const r = this.dirAddEntry(n, i, e);
			if (r < 0) throw s.length <= 40 ? (this.u8.fill(0, t + Es, t + Es + 40), this.w64(t + Is, 0)) : this.inodeTruncate(e, 0), this.inodeFree(e), new Rs(r);
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	chmod(e, t) {
		this.withNamespaceLock(() => this.chmodUnlocked(e, t));
	}
	chmodUnlocked(e, t) {
		const n = this.pathResolve(e, !0);
		if (n < 0) throw new Rs(n);
		this.inodeWriteLock(n);
		try {
			const e = this.inodeOffset(n), r = this.r32(e + 8);
			this.w32(e + 8, r & _s | 4095 & t), this.w64(e + Ps, Date.now());
		} finally {
			this.inodeWriteUnlock(n);
		}
	}
	fchmod(e, t) {
		const n = this.fdGet(e);
		if (!n) throw new Rs(-9);
		this.inodeWriteLock(n.ino);
		try {
			const e = this.inodeOffset(n.ino), r = this.r32(e + 8);
			this.w32(e + 8, r & _s | 4095 & t), this.w64(e + Ps, Date.now());
		} finally {
			this.inodeWriteUnlock(n.ino);
		}
	}
	chown(e, t, n) {
		this.withNamespaceLock(() => this.chownUnlocked(e, t, n));
	}
	chownUnlocked(e, t, n) {
		const r = this.pathResolve(e, !0);
		if (r < 0) throw new Rs(r);
		this.inodeWriteLock(r);
		try {
			this.chownInodeUnlocked(r, t, n);
		} finally {
			this.inodeWriteUnlock(r);
		}
	}
	fchown(e, t, n) {
		const r = this.fdGet(e);
		if (!r) throw new Rs(-9);
		this.inodeWriteLock(r.ino);
		try {
			this.chownInodeUnlocked(r.ino, t, n);
		} finally {
			this.inodeWriteUnlock(r.ino);
		}
	}
	lchown(e, t, n) {
		this.withNamespaceLock(() => this.lchownUnlocked(e, t, n));
	}
	lchownUnlocked(e, t, n) {
		const r = this.pathResolve(e, !1);
		if (r < 0) throw new Rs(r);
		this.inodeWriteLock(r);
		try {
			this.chownInodeUnlocked(r, t, n);
		} finally {
			this.inodeWriteUnlock(r);
		}
	}
	chownInodeUnlocked(e, t, n) {
		const r = this.inodeOffset(e);
		t !== Ss && this.w32(r + 96, t), n !== Ss && this.w32(r + 100, n);
		const i = this.r32(r + 8);
		32768 == (61440 & i) && 73 & i && this.w32(r + 8, -3073 & i), this.w64(r + Ps, Date.now());
	}
	utimens(e, t, n, r, i) {
		this.withNamespaceLock(() => this.utimensUnlocked(e, t, n, r, i));
	}
	utimensUnlocked(e, t, n, r, i) {
		const s = this.pathResolve(e, !0);
		if (s < 0) throw new Rs(s);
		this.inodeWriteLock(s);
		try {
			const e = this.inodeOffset(s), o = 1073741823, a = 1073741822, c = Date.now();
			if (n !== a) {
				const r = n === o ? c : 1e3 * t + Math.floor(n / 1e6);
				this.w64(e + 40, r);
			}
			if (i !== a) {
				const t = i === o ? c : 1e3 * r + Math.floor(i / 1e6);
				this.w64(e + Cs, t);
			}
			this.w64(e + Ps, c);
		} finally {
			this.inodeWriteUnlock(s);
		}
	}
	link(e, t) {
		return this.withNamespaceLock(() => this.linkUnlocked(e, t));
	}
	linkUnlocked(e, t) {
		const n = this.pathResolve(e, !1);
		if (n < 0) throw new Rs(n);
		const r = this.inodeOffset(n);
		if (16384 == (61440 & this.r32(r + 8))) throw new Rs(-1);
		const { parentIno: i, name: s } = this.pathResolveParent(t), o = Hs.encode(s);
		this.inodeWriteLock(i);
		try {
			if (this.dirLookup(i, o) >= 0) throw new Rs(-17);
			const e = this.dirAddEntry(i, o, n);
			if (e < 0) throw new Rs(e);
			this.inodeWriteLock(n);
			try {
				const e = this.r32(r + As);
				this.w32(r + As, e + 1), this.w64(r + Ps, Date.now());
			} finally {
				this.inodeWriteUnlock(n);
			}
			return {
				...this.namespaceEntryIdentity(n),
				linkCount: this.r32(r + As)
			};
		} finally {
			this.inodeWriteUnlock(i);
		}
	}
	readlink(e) {
		return this.withNamespaceLock(() => this.readlinkUnlocked(e));
	}
	readlinkUnlocked(e) {
		const t = this.pathResolve(e, !1);
		if (t < 0) throw new Rs(t);
		const n = this.inodeOffset(t);
		if (40960 != (61440 & this.r32(n + 8))) throw new Rs(-22);
		const r = this.r64(n + Is);
		if (r <= 40) return $s(this.u8.subarray(n + Es, n + Es + r));
		this.inodeReadLock(t);
		try {
			const e = new Uint8Array(r);
			return this.inodeReadData(t, 0, e, r), Fs.decode(e);
		} finally {
			this.inodeReadUnlock(t);
		}
	}
	opendir(e) {
		return this.withNamespaceLock(() => this.opendirUnlocked(e));
	}
	opendirUnlocked(e) {
		const t = this.pathResolve(e, !0);
		if (t < 0) throw new Rs(t);
		const n = this.inodeOffset(t);
		if (16384 != (61440 & this.r32(n + 8))) throw new Rs(-20);
		const r = this.fdAlloc(t, 0, !0);
		if (r < 0) throw new Rs(r);
		return r;
	}
	readdirEntry(e) {
		return this.withNamespaceLock(() => this.readdirEntryUnlocked(e));
	}
	readdirEntryUnlocked(e) {
		const t = this.fdGet(e);
		if (!t || !t.isDir) throw new Rs(-9);
		const n = this.inodeOffset(t.ino), r = this.r64(n + Is);
		for (; t.offset < r;) {
			const n = t.offset, i = Math.floor(n / ms), s = n % ms, o = this.inodeBlockMap(t.ino, i, !1);
			if (o <= 0) throw new Rs(-5);
			const a = o * ms + s, c = this.r32(a), l = this.view.getUint16(a + 4, !0), h = this.view.getUint16(a + 6, !0);
			if (!this.isValidDirEntry(s, Math.min(4096, s + r - n), l, h)) throw new Rs(-5);
			const d = n + l, f = 256 + 24 * e;
			if (0 === c) {
				this.w64(f + 8, d), t.offset = d;
				continue;
			}
			if (c >= this.r32(ks)) throw new Rs(-5);
			const u = this.r32(vs) * ms;
			if (!(this.r32(u + 4 * (c >> 5)) & 1 << (31 & c))) throw new Rs(-5);
			const p = $s(this.u8.subarray(a + 8, a + 8 + h)), g = this.buildStat(c);
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
		const n = "string" == typeof t ? Hs.encode(t) : t, r = this.open(e, 577);
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
		return Fs.decode(this.readFile(e));
	}
};
const Ks = 268435456, Vs = 268435456, qs = 268435456, Gs = 1e5, js = 4096, Xs = 65536, Ys = 8192, Zs = 8, Js = 32, Qs = 64, eo = 255, to = 536870912, no = 536870912, ro = 536870912, io = 1e5, so = 512;
const oo = 1e5, ao = "/home/linuxbrew/.linuxbrew", co = [
	["@@HOMEBREW_PREFIX@@", ao],
	["@@HOMEBREW_CELLAR@@", `${ao}/Cellar`],
	["@@HOMEBREW_REPOSITORY@@", ao],
	["@@HOMEBREW_LIBRARY@@", `${ao}/Library`],
	["@@HOMEBREW_PERL@@", `${ao}/opt/perl/bin/perl`]
], lo = "@@HOMEBREW_JAVA@@", ho = /^openjdk(?:@\d+(?:\.\d+)*)?/, fo = new TextEncoder(), uo = [...co.map(([e]) => e), lo].map((e) => ({
	placeholder: e,
	bytes: fo.encode(e)
}));
function po(e) {
	let t;
	try {
		t = JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(e));
	} catch (a) {
		throw new Error("INSTALL_RECEIPT.json is not valid UTF-8 JSON: " + function(e) {
			return e instanceof Error ? e.message : String(e);
		}(a));
	}
	if ("object" != typeof t || null === t || Array.isArray(t)) throw new Error("INSTALL_RECEIPT.json must contain an object");
	const n = t, r = n.changed_files;
	if (null != r && !Array.isArray(r)) throw new Error("INSTALL_RECEIPT.json changed_files must be an array or null when present");
	const i = Array.isArray(r) ? r : [];
	if (i.length > oo) throw new Error(`INSTALL_RECEIPT.json declares ${i.length} changed files, limit 100000`);
	const s = [], o = /* @__PURE__ */ new Set();
	for (const [c, l] of i.entries()) {
		if ("string" != typeof l) throw new Error(`INSTALL_RECEIPT.json changed_files[${c}] is not a string`);
		if (mo(l, "Homebrew changed file"), o.has(l)) throw new Error(`INSTALL_RECEIPT.json repeats changed file ${l}`);
		o.add(l), s.push(l);
	}
	return {
		changedFiles: s,
		runtimeDependencies: n.runtime_dependencies
	};
}
function go(e, t, n) {
	let r = e;
	for (const [o, a] of co) r = wo(r, fo.encode(o), fo.encode(a));
	const i = fo.encode(lo);
	if (yo(r, i)) {
		const e = function(e) {
			if (!Array.isArray(e)) return;
			const t = [];
			for (const r of e) {
				if ("object" != typeof r || null === r || Array.isArray(r)) continue;
				const e = r, n = "string" == typeof e.full_name ? e.full_name.split("/").at(-1) : "string" == typeof e.name ? e.name.split("/").at(-1) : void 0, i = void 0 === n ? null : ho.exec(n);
				void 0 !== n && i?.[0] === n && t.push(n);
			}
			const n = [...new Set(t)];
			return 1 === n.length ? `${ao}/opt/${n[0]}/libexec` : void 0;
		}(t.runtimeDependencies);
		if (void 0 === e) throw new Error(`Homebrew changed file ${n} uses ${lo} without exactly one OpenJDK runtime dependency`);
		r = wo(r, i, fo.encode(e));
	}
	const s = uo.find(({ bytes: e }) => yo(r, e));
	if (void 0 !== s) throw new Error(`Homebrew changed file ${n} retains ${s.placeholder}`);
	return r;
}
function mo(e, t) {
	if (0 === e.length || e.startsWith("/") || e.includes("\\") || e.includes("\0") || function(e) {
		for (let t = 0; t < e.length; t += 1) {
			const n = e.charCodeAt(t);
			if (!(n < 55296 || n > 57343)) {
				if (!(n <= 56319 && t + 1 < e.length && e.charCodeAt(t + 1) >= 56320 && e.charCodeAt(t + 1) <= 57343)) return !0;
				t += 1;
			}
		}
		return !1;
	}(e) || fo.encode(e).byteLength > 4096 || e.split("/").some((e) => "" === e || "." === e || ".." === e)) throw new Error(`${t} has an unsafe path segment: ${e}`);
}
function yo(e, t) {
	if (0 === t.byteLength || t.byteLength > e.byteLength) return !1;
	e: for (let n = 0; n <= e.byteLength - t.byteLength; n += 1) {
		for (let r = 0; r < t.byteLength; r += 1) if (e[n + r] !== t[r]) continue e;
		return !0;
	}
	return !1;
}
function wo(e, t, n) {
	const r = [];
	for (let a = 0; a <= e.byteLength - t.byteLength;) {
		let n = !0;
		for (let r = 0; r < t.byteLength; r += 1) if (e[a + r] !== t[r]) {
			n = !1;
			break;
		}
		n ? (r.push(a), a += t.byteLength) : a += 1;
	}
	if (0 === r.length) return e;
	const i = new Uint8Array(e.byteLength + r.length * (n.byteLength - t.byteLength));
	let s = 0, o = 0;
	for (const a of r) {
		const r = e.subarray(s, a);
		i.set(r, o), o += r.byteLength, i.set(n, o), o += n.byteLength, s = a + t.byteLength;
	}
	return i.set(e.subarray(s), o), i;
}
const _o = Symbol("DeferredTreeMaterializationHandle"), So = [
	40,
	181,
	47,
	253
], bo = 1447449417, ko = 16, vo = 61440, Ao = 32768, Io = 16384, Co = 65536, Po = 16777216, Eo = 16777216, xo = Ks, Mo = Vs, zo = qs, To = Gs, Lo = so, Bo = js, Uo = Xs, Ro = Ys, Ho = Js, Fo = Qs, Wo = /^[0-9a-f]{64}$/, Do = "kandelo-legacy-zip-v1", $o = "kandelo-deferred-tree-v1", Oo = "kandelo-deferred-tree-v2";
function No(e) {
	if ("string" != typeof e || !e.startsWith("/") || new TextEncoder().encode(e).byteLength > Bo || e.includes("\0") || e.includes("\\")) throw new Error(`Lazy archive mount prefix must be an absolute POSIX path: ${JSON.stringify(e)}`);
	const t = e.replace(/\/+$/, "");
	if ("" === t) return "/";
	if (t.slice(1).split("/").some((e) => "" === e || "." === e || ".." === e)) throw new Error(`Lazy archive mount prefix is not canonical: ${JSON.stringify(e)}`);
	return t;
}
function Ko(e) {
	if (!e || "object" != typeof e) throw new Error("VFS image metadata must be an object");
	if (1 !== e.version) throw new Error(`Unsupported VFS image metadata version: ${String(e.version)}`);
	if (void 0 !== e.kernelAbi && (!Number.isInteger(e.kernelAbi) || e.kernelAbi < 0)) throw new Error("VFS image metadata kernelAbi must be a non-negative integer");
	if (void 0 !== e.createdBy && "string" != typeof e.createdBy) throw new Error("VFS image metadata createdBy must be a string");
	return { ...e };
}
function Vo(e) {
	return e.byteLength >= So.length && e[0] === So[0] && e[1] === So[1] && e[2] === So[2] && e[3] === So[3] ? function(e) {
		return us(e);
	}(e) : e;
}
function qo(e) {
	const t = Vo(e);
	if (t.byteLength < ko) throw new Error("VFS image too small");
	const n = new DataView(t.buffer, t.byteOffset, t.byteLength), r = n.getUint32(0, !0);
	if (r !== bo) throw new Error(`Bad VFS image magic: 0x${r.toString(16)} (expected 0x${bo.toString(16)})`);
	const i = n.getUint32(4, !0);
	if (1 !== i) throw new Error(`Unsupported VFS image version: ${i} (expected 1)`);
	const s = n.getUint32(8, !0), o = n.getUint32(12, !0);
	if (t.byteLength < ko + o + 4) throw new Error("VFS image truncated");
	return {
		image: t,
		view: n,
		flags: s,
		sabLen: o
	};
}
function Go(e, t, n, r) {
	const i = ko + r, s = t.getUint32(i, !0);
	if (s > Po) throw new Error("VFS image lazy metadata exceeds 16777216 bytes");
	if (e.byteLength < i + 4 + s) throw new Error("VFS image truncated (lazy metadata section)");
	const o = i + 4 + s;
	let a = o;
	if (2 & n) {
		if (e.byteLength < o + 4) throw new Error("VFS image truncated (lazy archive section)");
		const n = t.getUint32(o, !0);
		if (n > Eo) throw new Error("VFS image lazy archive metadata exceeds 16777216 bytes");
		if (e.byteLength < o + 4 + n) throw new Error("VFS image truncated (lazy archive payload)");
		a = o + 4 + n;
	}
	return {
		lazyLen: s,
		archiveOffset: o,
		metadataOffset: a
	};
}
function jo(e, t) {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(e));
	} catch (n) {
		const e = n instanceof Error ? n.message : String(n);
		throw new Error(`${t} is not valid UTF-8 JSON: ${e}`);
	}
}
function Xo(e) {
	if (void 0 === e) return;
	if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error("Lazy archive integrity must be an object");
	const t = e;
	if (2 !== Object.keys(t).length || !("sha256" in t) || !("bytes" in t)) throw new Error("Lazy archive integrity has unexpected fields");
	if ("string" != typeof t.sha256 || !Wo.test(t.sha256)) throw new Error("Lazy archive integrity has an invalid SHA-256 digest");
	if (!Number.isSafeInteger(t.bytes) || Number(t.bytes) <= 0 || Number(t.bytes) > xo) throw new Error(`Lazy archive integrity byte count must be between 1 and ${xo}`);
	return {
		sha256: t.sha256,
		bytes: Number(t.bytes)
	};
}
function Yo(e, t, n) {
	if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error(`${n} must be an object`);
	const r = e;
	if (Object.keys(r).length !== t.length || t.some((e) => !Object.prototype.hasOwnProperty.call(r, e))) throw new Error(`${n} has unexpected or missing fields`);
	return r;
}
function Zo(e, t, n, r) {
	if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error(`${r} must be an object`);
	const i = e, s = new Set(t);
	if (Object.keys(i).some((e) => !s.has(e)) || n.some((e) => !Object.prototype.hasOwnProperty.call(i, e))) throw new Error(`${r} has unexpected or missing fields`);
	return i;
}
function Jo(e, t, n, r) {
	if (!Array.isArray(e) || e.length < n || e.length > r) throw new Error(`${t} must contain ${n} to ${r} items`);
	return e;
}
function Qo(e, t, n) {
	if ("string" != typeof e || 0 === e.length || e.includes("\0") || new TextEncoder().encode(e).byteLength > n) throw new Error(`${t} is invalid or exceeds ${n} bytes`);
	return e;
}
function ea(e, t, n, r) {
	if (!Number.isSafeInteger(e) || Number(e) < n || Number(e) > r) throw new Error(`${t} must be an integer between ${n} and ${r}`);
	return Number(e);
}
function ta(e, t = 1) {
	const n = e, r = "object" == typeof n && null !== n && !Array.isArray(n) && void 0 !== n.source, i = Yo(e, [
		"decoder",
		"mediaType",
		"sha256",
		"bytes",
		"expandedBytes",
		"sourceEntryCount",
		"transports",
		...r ? ["source"] : []
	], "Lazy tree content"), s = "zip-v1" === i.decoder ? "application/zip" : "homebrew-bottle-tar-gzip-v1" === i.decoder ? "application/vnd.oci.image.layer.v1.tar+gzip" : null;
	if (null === s || i.mediaType !== s) throw new Error("Lazy tree decoder and media type are inconsistent");
	const o = Xo({
		sha256: i.sha256,
		bytes: i.bytes
	});
	if (!o) throw new Error("Lazy tree integrity is required");
	const a = Jo(i.transports, "Lazy tree transports", t, Zs).map((e, t) => Qo(e, `Lazy tree transport ${t}`, Ro));
	if (new Set(a).size !== a.length) throw new Error("Lazy tree transports contain duplicates");
	const c = ea(i.expandedBytes, "Lazy tree expanded byte count", 0, Mo), l = ea(i.sourceEntryCount, "Lazy tree source entry count", 1, To), h = r ? function(e, t) {
		if ("homebrew-bottle-tar-gzip-v1" !== t) throw new Error("Lazy tree source inventory is valid only for original bottles");
		const n = Yo(e, [
			"schema",
			"kind",
			"entries"
		], "Lazy tree source inventory");
		if (1 !== n.schema || "homebrew-bottle-tar-gzip-v1" !== n.kind) throw new Error("Lazy tree source inventory has an unsupported identity");
		const r = /* @__PURE__ */ new Map(), i = Jo(n.entries, "Lazy tree source entries", 1, To).map((e, t) => {
			const n = e, i = "object" != typeof n || null === n || Array.isArray(n) ? void 0 : n.type, s = "directory" === i || "file" === i ? [
				"sourcePath",
				"type",
				"mode",
				"size"
			] : "symlink" === i || "hardlink" === i ? [
				"sourcePath",
				"type",
				"mode",
				"size",
				"target"
			] : null;
			if (null === s) throw new Error(`Lazy tree source entry ${t} has invalid type`);
			const o = Yo(e, s, `Lazy tree source entry ${t}`), a = oa(o.sourcePath, !1, `Lazy tree source entry ${t} path`);
			if (r.has(a)) throw new Error(`Lazy tree source inventory duplicates ${a}`);
			const c = ea(o.mode, `Lazy tree source entry ${a} mode`, 0, 4095), l = ea(o.size, `Lazy tree source entry ${a} size`, 0, zo);
			let h;
			if (("directory" === i || "symlink" === i || "hardlink" === i) && 0 !== l) throw new Error(`Lazy tree source ${a} has payload for ${String(i)}`);
			"symlink" === i ? h = Qo(o.target, `Lazy tree source symlink ${a} target`, Uo) : "hardlink" === i && (h = oa(o.target, !1, `Lazy tree source hardlink ${a} target`));
			const d = {
				sourcePath: a,
				type: i,
				mode: c,
				size: l,
				...void 0 === h ? {} : { target: h }
			};
			return r.set(a, d), d;
		}), s = i.map((e) => e.sourcePath);
		if (s.some((e, t) => t > 0 && s[t - 1] >= e)) throw new Error("Lazy tree source inventory is not in canonical path order");
		return {
			schema: 1,
			kind: "homebrew-bottle-tar-gzip-v1",
			entries: i
		};
	}(i.source, i.decoder) : void 0;
	if (void 0 !== h && h.entries.length !== l) throw new Error("Lazy tree source inventory count differs from its content");
	return {
		decoder: i.decoder,
		mediaType: s,
		sha256: o.sha256,
		bytes: o.bytes,
		expandedBytes: c,
		sourceEntryCount: l,
		transports: a,
		...void 0 === h ? {} : { source: h }
	};
}
function na(e) {
	const t = {
		groups: e.length,
		archiveBytes: 0,
		expandedBytes: 0,
		payloadBytes: 0,
		entries: 0
	};
	for (const n of e) void 0 !== n.content && void 0 !== n.inventory && (t.archiveBytes += n.content.bytes, t.expandedBytes += n.content.expandedBytes, t.payloadBytes += n.inventory.filter((e) => "file" === e.type).reduce((e, t) => e + t.size, 0), t.entries += n.inventory.length + (n.content.source?.entries.length ?? 0));
	return t;
}
function ra(e) {
	(function(e, t = "Deferred tree collection") {
		for (const [n, r] of Object.entries(e)) if (!Number.isSafeInteger(r) || r < 0) throw new Error(`${t} ${n} usage is invalid`);
		if (e.groups > so) throw new Error(`${t} exceeds the ${so}-group cap`);
		if (e.archiveBytes > to) throw new Error(`${t} exceeds the archive-byte cap`);
		if (e.expandedBytes > no) throw new Error(`${t} exceeds the expansion cap`);
		if (e.payloadBytes > ro) throw new Error(`${t} exceeds the payload-byte cap`);
		if (e.entries > io) throw new Error(`${t} exceeds the entry-count cap`);
	})(e, "Serialized lazy tree collection");
}
function ia(e) {
	ra(na(e));
}
function sa(e) {
	const t = new Map(e.map((e) => [e.sourcePath, e])), n = /* @__PURE__ */ new Map();
	for (const r of e) {
		if ("hardlink" !== r.type || n.has(r.sourcePath)) continue;
		const e = [], i = /* @__PURE__ */ new Set();
		let s, o = r;
		for (; "hardlink" === o.type && (s = n.get(o.sourcePath), void 0 === s);) {
			if (i.has(o.sourcePath)) throw new Error(`Lazy tree source hardlink cycle includes ${o.sourcePath}`);
			i.add(o.sourcePath), e.push(o);
			const n = t.get(o.target);
			if (void 0 === n) throw new Error(`Lazy tree source hardlink ${o.sourcePath} target is absent`);
			if ("file" !== n.type && "hardlink" !== n.type) throw new Error(`Lazy tree source hardlink ${o.sourcePath} target is not regular`);
			o = n;
		}
		void 0 === s && (s = o);
		for (const t of e) n.set(t.sourcePath, s);
	}
	return n;
}
function oa(e, t, n, r = !1) {
	if ("string" != typeof e || 0 === e.length || new TextEncoder().encode(e).byteLength > Bo || e.includes("\0") || e.includes("\\") || e.startsWith("/") !== t) throw new Error(`${n} is not a canonical ${t ? "absolute" : "relative"} path`);
	if (r && t && "/" === e) return e;
	if (e.slice(t ? 1 : 0).split("/").some((e) => "" === e || "." === e || ".." === e)) throw new Error(`${n} has an unsafe path segment`);
	return e;
}
function aa(e, t, n, r, i = 1) {
	const s = ta(e, i), o = No(n), a = Yo(r, [
		"mode",
		"capabilities",
		"roots"
	], "Lazy tree activation");
	if ("boot-prefetch" !== a.mode && "first-use" !== a.mode) throw new Error("Lazy tree activation mode is invalid");
	const c = Jo(a.capabilities, "Lazy tree activation capabilities", 1, Ho).map((e, t) => {
		const n = Qo(e, `Lazy tree activation capability ${t}`, eo);
		if (!/^[a-z0-9][a-z0-9:._-]*$/.test(n)) throw new Error(`Lazy tree activation capability ${t} is invalid`);
		return n;
	}), l = Jo(a.roots, "Lazy tree activation roots", 1, Fo).map((e, t) => oa(e, !0, `Lazy tree activation root ${t}`, !0));
	if (new Set(c).size !== c.length || new Set(l).size !== l.length) throw new Error("Lazy tree activation contains duplicates");
	const h = {
		mode: a.mode,
		capabilities: c,
		roots: l
	}, d = Jo(t, "Lazy tree inventory", 1, To), f = [], u = /* @__PURE__ */ new Map(), p = /* @__PURE__ */ new Map(), g = void 0 === s.source ? void 0 : new Map(s.source.entries.map((e) => [e.sourcePath, e])), m = void 0 === s.source ? void 0 : sa(s.source.entries);
	let y = 0;
	for (const [S, b] of d.entries()) {
		if ("object" != typeof b || null === b || Array.isArray(b)) throw new Error(`Lazy tree entry ${S} must be an object`);
		const e = b.type, t = "directory" === e ? [
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
		if (!t) throw new Error(`Lazy tree entry ${S} has an invalid type`);
		const n = Yo(b, [...t, ...void 0 === g ? [] : ["materialization"]], `Lazy tree entry ${S}`), r = oa(n.vfsPath, !0, `Lazy tree entry ${S} VFS path`), i = oa(n.sourcePath, !1, `Lazy tree entry ${S} source path`), a = void 0 === g ? void 0 : n.materialization;
		if (void 0 !== g && "archive" !== a && "archive-homebrew-relocate" !== a && "archive-copy" !== a && "archive-copy-mode" !== a && "descriptor" !== a) throw new Error(`Lazy tree entry ${r} has invalid materialization provenance`);
		if ("/" !== o && r !== o && !r.startsWith(`${o}/`)) throw new Error(`Lazy tree entry ${r} escapes its mount prefix`);
		if (u.has(r)) throw new Error(`Lazy tree duplicates VFS path ${r}`);
		const c = ea(n.mode, `Lazy tree entry ${r} mode`, 0, 4095), l = ea(n.size, `Lazy tree entry ${r} size`, 0, zo);
		let h, d;
		if ("directory" === e) {
			if (0 !== l) throw new Error(`Lazy tree directory ${r} has nonzero size`);
		} else if ("symlink" === e) {
			if (h = Qo(n.target, `Lazy tree symlink ${r} target`, Uo), new TextEncoder().encode(h).byteLength !== l) throw new Error(`Lazy tree symlink ${r} size differs from its target`);
		} else d = Qo(n.inodeGroup, `Lazy tree entry ${r} inode group`, Bo), "hardlink" === e && (h = oa(n.target, !0, `Lazy tree hardlink ${r} target`));
		if ("hardlink" !== e && (y += l, y > zo)) throw new Error("Lazy tree inventory exceeds the expansion limit");
		const m = {
			vfsPath: r,
			sourcePath: i,
			...void 0 === a ? {} : { materialization: a },
			type: e,
			mode: c,
			size: l,
			...void 0 === h ? {} : { target: h },
			...void 0 === d ? {} : { inodeGroup: d }
		};
		if (void 0 === g) {
			const e = p.get(i);
			if (e) {
				if ("zip-v1" !== s.decoder || "hardlink" !== m.type || e.inodeGroup !== m.inodeGroup) throw new Error(`Lazy tree duplicates source path ${i}`);
			} else {
				if ("zip-v1" === s.decoder && "hardlink" === m.type) throw new Error(`Lazy ZIP hardlink ${r} does not reuse a canonical source path`);
				p.set(i, m);
			}
		} else if ("descriptor" === m.materialization) {
			if ("directory" !== m.type && "symlink" !== m.type) throw new Error(`Lazy tree descriptor entry ${r} is not structural`);
			if (g.has(i)) throw new Error(`Lazy tree descriptor entry ${r} impersonates a source member`);
		} else {
			const e = g.get(i);
			if (void 0 === e) throw new Error(`Lazy tree entry ${r} names absent source ${i}`);
			if ("archive-copy" === m.materialization || "archive-copy-mode" === m.materialization) {
				if ("file" !== m.type || "file" !== e.type || "archive-copy" === m.materialization && m.mode !== e.mode) throw new Error(`Lazy tree archive copy ${r} differs from its source`);
			} else if ("archive-homebrew-relocate" === m.materialization) {
				if ("file" !== m.type && "hardlink" !== m.type || e.type !== m.type || "file" === m.type && e.mode !== m.mode) throw new Error(`Lazy tree receipt-relocated entry ${r} differs from its source`);
			} else if (e.type !== m.type || "symlink" === m.type && e.target !== m.target || "hardlink" !== m.type && e.mode !== m.mode) throw new Error(`Lazy tree archive entry ${r} differs from its source`);
		}
		f.push(m), u.set(r, m);
	}
	for (const S of f) {
		const e = S.vfsPath.split("/").filter(Boolean);
		for (let t = 1; t < e.length; t += 1) {
			const n = `/${e.slice(0, t).join("/")}`, r = u.get(n);
			if (r && "directory" !== r.type) throw new Error(`Lazy tree entry ${S.vfsPath} descends through non-directory ${n}`);
		}
	}
	const w = function(e, t) {
		const n = /* @__PURE__ */ new Map(), r = /* @__PURE__ */ new Map();
		for (const o of e) {
			if (n.has(o.path)) throw new Error(`${t} duplicates path ${o.path}`);
			if (n.set(o.path, o), "file" === o.type) {
				if (!o.inodeGroup) throw new Error(`${t} file ${o.path} has no inode group`);
				if (r.has(o.inodeGroup)) throw new Error(`${t} inode group ${o.inodeGroup} has multiple files`);
				r.set(o.inodeGroup, o);
			}
		}
		const i = /* @__PURE__ */ new Set(), s = /* @__PURE__ */ new Map();
		for (const o of e) {
			if ("hardlink" !== o.type || s.has(o.path)) continue;
			const e = [];
			let a, c = o;
			for (; "hardlink" === c.type;) {
				const r = s.get(c.path);
				if (r) {
					a = r;
					break;
				}
				if (i.has(c.path)) throw new Error(`${t} hardlink cycle reaches ${c.path}`);
				if (i.add(c.path), e.push(c), !c.target) throw new Error(`${t} hardlink ${c.path} has no target`);
				const o = n.get(c.target);
				if (!o) throw new Error(`${t} hardlink ${c.path} target ${c.target} is missing`);
				if ("file" !== o.type && "hardlink" !== o.type || !c.inodeGroup || o.inodeGroup !== c.inodeGroup || o.size !== c.size || o.mode !== c.mode) throw new Error(`${t} hardlink ${c.path} has an invalid target`);
				c = o;
			}
			a ??= "file" === c.type ? c : void 0;
			const l = r.get(o.inodeGroup ?? "");
			if (!a || a !== l) throw new Error(`${t} hardlink ${o.path} does not resolve to its inode`);
			for (let n = e.length - 1; n >= 0; n -= 1) {
				const o = e[n];
				if (r.get(o.inodeGroup ?? "") !== a) throw new Error(`${t} hardlink ${o.path} does not resolve to its inode`);
				i.delete(o.path), s.set(o.path, a);
			}
		}
		return {
			canonicalByGroup: r,
			canonicalTargetByPath: s
		};
	}(f.map((e) => ({
		path: e.vfsPath,
		type: e.type,
		mode: e.mode,
		size: e.size,
		target: e.target,
		inodeGroup: e.inodeGroup
	})), "Lazy tree");
	if (void 0 !== g) {
		const e = /* @__PURE__ */ new Set();
		for (const t of f) {
			if ("archive-homebrew-relocate" !== t.materialization) continue;
			const n = g.get(t.sourcePath), r = "file" === n.type ? n : m.get(n.sourcePath);
			if ("file" !== r?.type) throw new Error(`Lazy tree receipt-relocated entry ${t.vfsPath} is not regular`);
			e.add(r.sourcePath);
		}
		for (const t of f) {
			if ("descriptor" === t.materialization || "file" !== t.type && "hardlink" !== t.type) continue;
			const n = g.get(t.sourcePath), r = "file" === n.type ? n : m.get(n.sourcePath);
			if ("file" !== r?.type || !e.has(r.sourcePath) && t.size !== r.size) throw new Error(`Lazy tree archive entry ${t.vfsPath} differs from its source`);
		}
		for (const t of f) {
			if ("hardlink" !== t.type || "archive" !== t.materialization && "archive-homebrew-relocate" !== t.materialization) continue;
			const e = g.get(t.sourcePath), n = u.get(t.target), r = m.get(e.sourcePath);
			if (e.target !== n?.sourcePath || "file" !== r?.type || r.mode !== t.mode || n?.mode !== t.mode) throw new Error(`Lazy tree hardlink ${t.vfsPath} differs from its source`);
		}
	}
	if (s.sourceEntryCount !== (void 0 === g ? p.size : g.size)) throw new Error("Lazy tree source entry count differs from its inventory");
	if (void 0 === s.source && s.expandedBytes < y || "zip-v1" === s.decoder && s.expandedBytes !== y) throw new Error("Lazy tree expanded byte count differs from its inventory");
	for (const S of h.roots) if ("/" !== S && !f.some((e) => e.vfsPath === S || e.vfsPath.startsWith(`${S}/`))) throw new Error(`Lazy tree activation root ${S} is not owned by its inventory`);
	const _ = /* @__PURE__ */ new Map();
	for (const S of f) "file" === S.type && _.set(S.inodeGroup, S);
	if (_.size !== w.canonicalByGroup.size) throw new Error("Lazy tree regular inode inventory is inconsistent");
	return {
		content: s,
		entries: f,
		mountPrefix: o,
		activation: h,
		canonicalByGroup: _
	};
}
function ca(e) {
	return JSON.stringify([
		e.sourcePath,
		e.type,
		e.inodeGroup,
		e.target
	]);
}
function la(e, t) {
	const n = Zo(e, [
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
	if (void 0 === n.kind) {
		if (!t) throw new Error("Serialized lazy archive is missing its kind discriminator");
	} else if (n.kind !== Do) throw new Error("Serialized legacy lazy archive has an unsupported kind");
	const r = Qo(n.url, "Serialized legacy lazy archive URL", Ro), i = No(n.mountPrefix), s = Xo(n.integrity);
	if (void 0 !== n.content) {
		if (!t || void 0 !== n.kind) throw new Error("Typed legacy lazy archives cannot carry generic content");
		const e = ta(n.content);
		if ("zip-v1" !== e.decoder || 1 !== e.transports.length || e.transports[0] !== r || !s || e.sha256 !== s.sha256 || e.bytes !== s.bytes) throw new Error("Untagged legacy ZIP content identity is inconsistent");
	}
	if (!1 !== n.materialized) throw new Error("Serialized legacy lazy archive must describe pending content");
	const o = /* @__PURE__ */ new Set(), a = Jo(n.entries, "Serialized legacy lazy archive entries", 1, To).map((e, t) => {
		const n = Zo(e, [
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
		], `Serialized legacy lazy archive entry ${t}`), r = oa(n.vfsPath, !0, `Serialized legacy lazy archive entry ${t} VFS path`);
		if (o.has(r)) throw new Error(`Serialized legacy lazy archive duplicates path ${r}`);
		o.add(r);
		const i = ea(n.ino, `Serialized legacy lazy archive entry ${r} inode`, 1, Number.MAX_SAFE_INTEGER), s = void 0 === n.generation ? void 0 : ea(n.generation, `Serialized legacy lazy archive entry ${r} generation`, 0, Number.MAX_SAFE_INTEGER), a = void 0 === n.dataSequence ? void 0 : ea(n.dataSequence, `Serialized legacy lazy archive entry ${r} data sequence`, 0, Number.MAX_SAFE_INTEGER), c = ea(n.size, `Serialized legacy lazy archive entry ${r} size`, 0, zo);
		if (!1 !== n.isSymlink || !1 !== n.deleted || void 0 !== n.materialized && !1 !== n.materialized) throw new Error(`Serialized legacy lazy archive entry ${r} is not pending`);
		if (void 0 !== n.type && "file" !== n.type) throw new Error(`Serialized legacy lazy archive entry ${r} has an invalid type`);
		const l = void 0 === n.archivePath ? void 0 : oa(n.archivePath, !1, `Serialized legacy lazy archive entry ${r} archive path`), h = void 0 === n.sourcePath ? void 0 : oa(n.sourcePath, !1, `Serialized legacy lazy archive entry ${r} source path`), d = void 0 === n.inodeGroup ? void 0 : Qo(n.inodeGroup, `Serialized legacy lazy archive entry ${r} inode group`, Bo);
		if (void 0 !== n.target) throw new Error(`Serialized legacy lazy archive entry ${r} has a link target`);
		return {
			vfsPath: r,
			ino: i,
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
		kind: Do,
		url: r,
		mountPrefix: i,
		...void 0 === s ? {} : { integrity: s },
		materialized: !1,
		entries: a
	};
}
async function ha(e, t, n) {
	if (void 0 === n) return;
	if (e.byteLength !== n.bytes) throw new Error(`Lazy ${t} byte count ${e.byteLength} does not match expected ${n.bytes}`);
	const r = globalThis.crypto?.subtle;
	if (!r) throw new Error(`Lazy ${t} integrity verification is unavailable`);
	const i = new Uint8Array(e.byteLength);
	i.set(e);
	const s = new Uint8Array(await r.digest("SHA-256", i)), o = Array.from(s, (e) => e.toString(16).padStart(2, "0")).join("");
	if (o !== n.sha256) throw new Error(`Lazy ${t} SHA-256 ${o} does not match expected ${n.sha256}`);
}
var da = class e {
	fs;
	imageMetadata;
	lazyFiles = /* @__PURE__ */ new Map();
	lazyArchiveGroups = [];
	deferredTreeMaterializationHandles = /* @__PURE__ */ new WeakMap();
	lazyArchiveInodes = /* @__PURE__ */ new Map();
	lazyDownloadListeners = /* @__PURE__ */ new Set();
	lazyPreparations = /* @__PURE__ */ new Map();
	lazyFetch = (e) => globalThis.fetch(e);
	constructor(e, t = null) {
		this.fs = e, this.imageMetadata = t;
	}
	static inodeKey(e, t) {
		return `${e}:${t}`;
	}
	static canAdoptLegacyLazyStub(e) {
		return (e.mode & vo) === Ao && 0 === e.size && e.dataSequence <= 1;
	}
	reconcileLazyIdentityState(t) {
		for (const [e, n] of this.lazyFiles) {
			const r = t.get(e);
			r && r.dataSequence === n.dataSequence && 0 !== r.paths.length ? (n.paths = new Set(r.paths), n.paths.has(n.path) || (n.path = r.paths[0])) : this.lazyFiles.delete(e);
		}
		this.lazyArchiveInodes.clear();
		for (const n of this.lazyArchiveGroups) {
			const r = void 0 !== n.content && void 0 !== n.inventory && !n.materialized, i = /* @__PURE__ */ new Map();
			for (const t of n.entries.values()) {
				if (t.deleted || t.materialized || void 0 === t.generation) continue;
				const n = e.inodeKey(t.ino, t.generation);
				i.has(n) || i.set(n, t);
			}
			const s = /* @__PURE__ */ new Map();
			for (const [e, o] of i) {
				const r = t.get(e);
				if (r && r.dataSequence === (o.dataSequence ?? 0)) {
					for (const e of r.paths) s.set(e, {
						...o,
						ino: r.ino,
						generation: r.generation,
						dataSequence: r.dataSequence,
						deleted: !1,
						materialized: !1
					});
					r.paths.length > 0 && this.lazyArchiveInodes.set(e, n);
				}
			}
			n.entries = s, n.materialized = 0 === s.size && !r;
		}
	}
	lazyFileForStat(t) {
		const n = e.inodeKey(t.ino, t.generation), r = this.lazyFiles.get(n);
		if (!r || r.dataSequence === t.dataSequence) return r;
		this.lazyFiles.delete(n);
	}
	lazyArchiveForStat(t) {
		const n = e.inodeKey(t.ino, t.generation), r = this.lazyArchiveInodes.get(n);
		if (!r) return;
		const i = Array.from(r.entries.values()).filter((e) => e.ino === t.ino && e.generation === t.generation && !e.deleted && !e.materialized);
		if (i.some((e) => e.dataSequence === t.dataSequence)) return r;
		this.lazyArchiveInodes.delete(n);
		for (const e of i) e.materialized = !0;
	}
	lazyBackingForStat(t) {
		const n = e.inodeKey(t.ino, t.generation), r = this.lazyFiles.get(n);
		if (r) return {
			token: r,
			path: r.path
		};
		const i = this.lazyArchiveInodes.get(n);
		if (!i) return null;
		const s = Array.from(i.entries.entries()).find(([, e]) => e.ino === t.ino && e.generation === t.generation && !e.deleted && !e.materialized)?.[0];
		return void 0 === s ? null : {
			token: i,
			path: s
		};
	}
	lazyBackingForPath(e) {
		const t = this.lazyArchiveGroups.find((t) => !t.materialized && void 0 !== t.content && void 0 !== t.inventory && void 0 !== t.activation && Array.from(t.entries.values()).every((e) => e.deleted || e.materialized || e.isSymlink) && t.activation.roots.some((t) => "/" === t || e === t || e.startsWith(`${t}/`)));
		if (t) return {
			token: t,
			path: e,
			directGroup: t
		};
		try {
			const t = this.fs.stat(e), n = this.lazyBackingForStat(t);
			return n ? {
				token: n.token,
				path: e
			} : null;
		} catch {
			return null;
		}
	}
	startLazyPreparation(e) {
		const { path: t, token: n } = e, r = {
			status: "pending",
			promise: Promise.resolve(!1)
		};
		return r.promise = (e.directGroup ? this.ensureArchiveMaterialized(e.directGroup).then(() => !0) : this.materializePath(t)).then((e) => (r.status = "fulfilled", this.lazyPreparations.get(n) === r && this.lazyPreparations.delete(n), e), (e) => {
			throw r.status = "rejected", r.error = e, e;
		}), r.promise.catch(() => {}), this.lazyPreparations.set(n, r), r;
	}
	guardSynchronousLazyAccess(e) {
		const t = this.lazyBackingForPath(e);
		if (!t) return;
		let n = this.lazyPreparations.get(t.token);
		if ("fulfilled" === n?.status) {
			this.lazyPreparations.delete(t.token);
			const r = this.lazyBackingForPath(e);
			if (!r) return;
			n = this.lazyPreparations.get(r.token) ?? this.startLazyPreparation(r);
		} else {
			if ("rejected" === n?.status) {
				this.lazyPreparations.delete(t.token);
				const r = n.error instanceof Error ? n.error.message : String(n.error), i = /* @__PURE__ */ new Error(`EIO: lazy backing for ${e} failed: ${r}`);
				throw i.code = "EIO", i.cause = n.error, i;
			}
			n || (n = this.startLazyPreparation(t));
		}
		const r = /* @__PURE__ */ new Error(`EAGAIN: lazy backing for ${e} is being prepared`);
		throw r.code = "EAGAIN", r;
	}
	invalidateLazyData(t) {
		const n = e.inodeKey(t.ino, t.generation);
		this.lazyFiles.delete(n);
		const r = this.lazyArchiveInodes.get(n);
		if (r) {
			this.lazyArchiveInodes.delete(n);
			for (const e of r.entries.values()) e.ino === t.ino && e.generation === t.generation && (e.materialized = !0);
		}
	}
	rewriteLazyNamespacePaths(t, n, r) {
		const i = n.length > 1 ? n.replace(/\/+$/, "") : n, s = r.length > 1 ? r.replace(/\/+$/, "") : r, o = `${i}/`, a = `${s}/`, c = e.inodeKey(t.ino, t.generation), l = (t.mode & vo) === Io, h = (e) => e === i ? s : l && e.startsWith(o) ? a + e.slice(o.length) : e;
		for (const [e, d] of this.lazyFiles) (l || e === c) && (d.paths = new Set(Array.from(d.paths, h)), d.path = h(d.path));
		for (const d of this.lazyArchiveGroups) {
			const t = /* @__PURE__ */ new Map();
			for (const [n, r] of d.entries) {
				const i = void 0 === r.generation ? null : e.inodeKey(r.ino, r.generation);
				t.set(l || i === c ? h(n) : n, r);
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
	static create(t, n) {
		return new e(Ns.mkfs(t, n));
	}
	static fromExisting(t) {
		return new e(Ns.mount(t));
	}
	rebaseToNewFileSystem(t) {
		if (!Number.isSafeInteger(t) || t <= 0) throw new Error(`Invalid MemoryFileSystem maxByteLength: ${t}`);
		const n = SharedArrayBuffer, { bytes: r, identities: i } = this.fs.snapshotState();
		this.reconcileLazyIdentityState(i);
		const s = this.serializeLazyEntries(), o = this.serializeLazyArchiveEntries(), a = new n(r.byteLength);
		new Uint8Array(a).set(r);
		const c = new e(Ns.mount(a, { restoreImage: !0 }), this.imageMetadata);
		c.importLazyEntries(s), c.importLazyArchiveEntries(o);
		const l = new n(Math.min(t, Math.max(r.byteLength, 16777216)), { maxByteLength: t }), h = e.create(l, t);
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
		})), h.importLazyArchiveEntries(o.map((e) => ({
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
		}))), h;
	}
	getImageMetadata() {
		return null === (e = this.imageMetadata) ? null : { ...e };
		var e;
	}
	setImageMetadata(e) {
		this.imageMetadata = null === e ? null : Ko(e);
	}
	subscribeLazyDownloads(e) {
		return this.lazyDownloadListeners.add(e), () => this.lazyDownloadListeners.delete(e);
	}
	setLazyFetcher(e) {
		this.lazyFetch = e;
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
		let t = 0, n = e.integrity?.bytes ?? e.fallbackTotalBytes;
		const r = {
			id: e.id,
			kind: e.kind,
			url: e.url,
			path: e.path,
			mountPrefix: e.mountPrefix
		};
		this.emitLazyDownload({
			...r,
			status: "started",
			loadedBytes: t,
			totalBytes: n
		});
		try {
			const i = await this.lazyFetch(e.url);
			if (!i.ok) throw new Error(`HTTP ${i.status}`);
			if (n = function(e) {
				const t = e?.get("content-encoding")?.trim().toLowerCase();
				if (t && "identity" !== t) return;
				const n = e?.get("content-length");
				if (!n) return;
				const r = Number(n);
				return Number.isFinite(r) && r >= 0 ? r : void 0;
			}(i.headers) ?? n, e.integrity && void 0 !== n && n !== e.integrity.bytes) throw new Error(`Lazy ${e.kind} byte count ${n} does not match expected ${e.integrity.bytes}`);
			if (!i.body) {
				const s = new Uint8Array(await i.arrayBuffer());
				return t = s.byteLength, await ha(s, e.kind, e.integrity), this.emitLazyDownload({
					...r,
					status: "progress",
					loadedBytes: t,
					totalBytes: n ?? t
				}), this.emitLazyDownload({
					...r,
					status: "complete",
					loadedBytes: t,
					totalBytes: n ?? t
				}), s;
			}
			const s = i.body.getReader(), o = [];
			try {
				for (;;) {
					const { done: i, value: a } = await s.read();
					if (i) break;
					if (a) {
						if (o.push(a), t += a.byteLength, e.integrity && t > e.integrity.bytes) throw await s.cancel(), /* @__PURE__ */ new Error(`Lazy ${e.kind} exceeded expected byte count ${e.integrity.bytes}`);
						this.emitLazyDownload({
							...r,
							status: "progress",
							loadedBytes: t,
							totalBytes: n
						});
					}
				}
			} finally {
				s.releaseLock();
			}
			const a = function(e, t) {
				if (1 === e.length) return e[0];
				const n = new Uint8Array(t);
				let r = 0;
				for (const i of e) n.set(i, r), r += i.byteLength;
				return n;
			}(o, t);
			return await ha(a, e.kind, e.integrity), this.emitLazyDownload({
				...r,
				status: "complete",
				loadedBytes: t,
				totalBytes: n ?? t
			}), a;
		} catch (Zi) {
			const i = Zi instanceof Error ? Zi.message : String(Zi);
			throw this.emitLazyDownload({
				...r,
				status: "error",
				loadedBytes: t,
				totalBytes: n,
				error: i
			}), Zi;
		}
	}
	registerLazyFile(t, n, r, i = 493) {
		const s = t.split("/").filter(Boolean);
		let o = "";
		for (let e = 0; e < s.length - 1; e++) {
			o += "/" + s[e];
			try {
				this.fs.mkdir(o, 493);
			} catch {}
		}
		const a = this.fs.createLazyStub(t, i);
		return this.invalidateLazyData(a), this.lazyFiles.set(e.inodeKey(a.ino, a.generation), {
			ino: a.ino,
			generation: a.generation,
			dataSequence: a.dataSequence,
			path: t,
			paths: new Set([t]),
			url: n,
			size: r
		}), a.ino;
	}
	importLazyEntries(e) {
		this.importLazyEntriesInternal(e, !1);
	}
	importLazyEntriesInternal(t, n) {
		for (const r of t) {
			if ((void 0 === r.generation || void 0 === r.dataSequence) && !n) throw new Error("Live lazy-file metadata requires inode generation and data sequence");
			const t = /* @__PURE__ */ new Set();
			let i = null;
			for (const n of new Set([r.path, ...r.paths ?? []])) {
				let s;
				try {
					s = this.fs.stat(n);
				} catch {
					continue;
				}
				if (s.ino === r.ino && (void 0 === r.generation || s.generation === r.generation)) {
					if (void 0 === r.dataSequence) {
						if (!e.canAdoptLegacyLazyStub(s)) continue;
					} else if (s.dataSequence !== r.dataSequence) continue;
					i ??= s, t.add(n);
				}
			}
			if (!i || 0 === t.size) continue;
			const s = t.has(r.path) ? r.path : t.values().next().value;
			this.lazyFiles.set(e.inodeKey(i.ino, i.generation), {
				ino: i.ino,
				generation: i.generation,
				dataSequence: i.dataSequence,
				path: s,
				paths: t,
				url: r.url,
				size: r.size
			});
		}
	}
	serializeLazyEntries() {
		const e = [];
		for (const { ino: t, generation: n, dataSequence: r, path: i, paths: s, url: o, size: a } of this.lazyFiles.values()) e.push({
			ino: t,
			generation: n,
			dataSequence: r,
			path: i,
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
			const t = this.fs.stat(e), n = this.lazyFileForStat(t);
			return n ? {
				ino: t.ino,
				generation: t.generation,
				dataSequence: t.dataSequence,
				path: n.path,
				paths: Array.from(n.paths),
				url: n.url,
				size: n.size
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
	registerLazyTree(e, t, n = "/", r) {
		return this.registerLazyTreeInternal(e, t, n, r, !1);
	}
	registerLazyTreeInternal(t, n, r, i, s) {
		this.assertCanRegisterPendingLazyArchiveGroup();
		const o = No(r), { content: a, entries: c, mountPrefix: l, activation: h, canonicalByGroup: d } = aa(t, n, o, i ?? {
			mode: "first-use",
			capabilities: ["deferred-tree"],
			roots: [o]
		}, s ? 0 : 1), f = {
			content: a,
			url: a.transports[0] ?? "",
			mountPrefix: l,
			integrity: {
				sha256: a.sha256,
				bytes: a.bytes
			},
			materialized: !1,
			inventory: c.map((e) => ({ ...e })),
			activation: h,
			entries: /* @__PURE__ */ new Map()
		}, u = (e) => {
			const t = e.split("/").filter(Boolean);
			let n = "";
			for (let r = 0; r < t.length - 1; r++) {
				n += `/${t[r]}`;
				try {
					this.fs.mkdir(n, 493);
				} catch {
					if ((this.fs.lstat(n).mode & vo) !== Io) throw new Error(`Lazy tree ancestor ${n} is not a directory`);
				}
			}
		};
		for (const e of [...c].sort((e, t) => e.vfsPath.split("/").length - t.vfsPath.split("/").length)) if ("directory" === e.type) {
			u(e.vfsPath);
			try {
				this.fs.mkdir(e.vfsPath, e.mode), this.fs.chmod(e.vfsPath, e.mode);
			} catch {
				if ((this.fs.lstat(e.vfsPath).mode & vo) !== Io) throw new Error(`Lazy tree directory collides at ${e.vfsPath}`);
			}
		}
		for (const e of c) {
			if ("symlink" !== e.type) continue;
			u(e.vfsPath), this.fs.symlink(e.target, e.vfsPath);
			const t = this.fs.lstat(e.vfsPath);
			f.entries.set(e.vfsPath, {
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
		const p = /* @__PURE__ */ new Map();
		for (const g of c) {
			if ("file" !== g.type) continue;
			u(g.vfsPath);
			const t = this.fs.createLazyStub(g.vfsPath, g.mode);
			this.invalidateLazyData(t), p.set(g.inodeGroup, t);
			const n = {
				ino: t.ino,
				generation: t.generation,
				dataSequence: t.dataSequence,
				size: g.size,
				isSymlink: !1,
				deleted: !1,
				materialized: !1,
				archivePath: g.sourcePath,
				sourcePath: g.sourcePath,
				type: "file",
				inodeGroup: g.inodeGroup
			};
			f.entries.set(g.vfsPath, n), this.lazyArchiveInodes.set(e.inodeKey(t.ino, t.generation), f);
		}
		for (const e of c) {
			if ("hardlink" !== e.type) continue;
			const t = d.get(e.inodeGroup);
			u(e.vfsPath), this.fs.link(t.vfsPath, e.vfsPath);
			const n = this.fs.lstat(e.vfsPath), r = p.get(e.inodeGroup);
			if (n.ino !== r.ino || n.generation !== r.generation) throw new Error(`Lazy tree hardlink ${e.vfsPath} did not share its inode`);
			f.entries.set(e.vfsPath, {
				ino: n.ino,
				generation: n.generation,
				dataSequence: n.dataSequence,
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
		return this.lazyArchiveGroups.push(f), f;
	}
	registerLazyTreeWithMaterializationHandle(e, t, n = "/", r) {
		const i = this.registerLazyTreeInternal(e, t, n, r, !0), s = Object.freeze({ [_o]: !0 });
		return this.deferredTreeMaterializationHandles.set(s, i), s;
	}
	registerLazyArchiveFromEntries(t, n, r, i, s) {
		const o = function(e, t, n, r) {
			const i = No(n), s = /* @__PURE__ */ new Map(), o = t.map((t) => {
				const n = t.fileName, o = `Lazy archive ${JSON.stringify(e)} member ${JSON.stringify(n)}`;
				if (0 === n.length) throw new Error(`${o} has an empty path`);
				if (n.includes("\0")) throw new Error(`${o} contains a NUL byte`);
				if (n.includes("\\")) throw new Error(`${o} contains a backslash`);
				if (n.startsWith("/") || /^[A-Za-z]:\//.test(n)) throw new Error(`${o} must be relative, not absolute`);
				if (t.isDirectory && t.isSymlink) throw new Error(`${o} has conflicting directory and symlink types`);
				if (t.isDirectory !== n.endsWith("/")) throw new Error(`${o} has inconsistent directory metadata`);
				const a = t.isDirectory ? n.slice(0, -1) : n, c = a.split("/");
				if (0 === a.length || c.some((e) => "" === e || "." === e || ".." === e)) throw new Error(`${o} is not a canonical relative POSIX path`);
				if (s.has(a)) throw new Error(`${o} collides with another member at ${JSON.stringify(a)}`);
				if (t.isSymlink && !r?.has(n)) throw new Error(`Lazy archive symlink target was not provided: ${n}`);
				return s.set(a, t), {
					entry: t,
					archivePath: a,
					vfsPath: "/" === i ? `/${a}` : `${i}/${a}`
				};
			});
			for (const { archivePath: a } of o) {
				const e = a.split("/");
				for (let t = 1; t < e.length; t++) {
					const n = e.slice(0, t).join("/"), r = s.get(n);
					if (r && !r.isDirectory) throw new Error(`Lazy archive member ${JSON.stringify(a)} descends through non-directory ${JSON.stringify(n)}`);
				}
			}
			return o;
		}(t, n, r, i);
		o.some(({ entry: e }) => !e.isDirectory && !e.isSymlink) && this.assertCanRegisterPendingLazyArchiveGroup();
		const a = {
			...s ? { content: ta({
				decoder: "zip-v1",
				mediaType: "application/zip",
				sha256: s.sha256,
				bytes: s.bytes,
				expandedBytes: o.reduce((e, t) => e + t.entry.uncompressedSize, 0),
				sourceEntryCount: o.length,
				transports: [t]
			}) } : {},
			url: t,
			mountPrefix: r,
			integrity: Xo(s),
			materialized: !1,
			entries: /* @__PURE__ */ new Map()
		};
		for (const { entry: c, vfsPath: l } of o) {
			if (c.isDirectory) continue;
			const t = l.split("/").filter(Boolean);
			let n = "";
			for (let e = 0; e < t.length - 1; e++) {
				n += "/" + t[e];
				try {
					this.fs.mkdir(n, 493);
				} catch {}
			}
			if (c.isSymlink) {
				const e = i.get(c.fileName);
				this.fs.symlink(e, l);
				const t = this.fs.lstat(l), n = {
					ino: t.ino,
					generation: t.generation,
					dataSequence: t.dataSequence,
					size: c.uncompressedSize,
					isSymlink: !0,
					deleted: !1,
					materialized: !0,
					archivePath: c.fileName,
					sourcePath: c.fileName,
					type: "symlink"
				};
				a.entries.set(l, n);
			} else {
				const t = this.fs.createLazyStub(l, c.mode);
				this.invalidateLazyData(t);
				const n = {
					ino: t.ino,
					generation: t.generation,
					dataSequence: t.dataSequence,
					size: c.uncompressedSize,
					isSymlink: !1,
					deleted: !1,
					materialized: !1,
					archivePath: c.fileName,
					sourcePath: c.fileName,
					type: "file",
					inodeGroup: c.fileName
				};
				a.entries.set(l, n), this.lazyArchiveInodes.set(e.inodeKey(t.ino, t.generation), a);
			}
		}
		return a.materialized = Array.from(a.entries.values()).every((e) => e.deleted || e.materialized), this.lazyArchiveGroups.push(a), a;
	}
	importLazyArchiveEntries(e) {
		this.importLazyArchiveEntriesInternal(e, !1, !0);
	}
	importLazyArchiveEntriesInternal(t, n, r) {
		const i = Jo(t, "Serialized lazy archive groups", 0, Lo).map((e, t) => {
			if ("object" != typeof e || null === e || Array.isArray(e)) throw new Error(`Serialized lazy archive group ${t} must be an object`);
			const n = e.kind;
			if (n === $o || n === Oo) return function(e, t) {
				const n = Yo(e, [
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
				if (n.kind !== t) throw new Error("Serialized lazy tree has an unsupported kind");
				const r = aa(n.content, n.inventory, n.mountPrefix, n.activation);
				if (t === $o != (void 0 === r.content.source)) throw new Error(t === $o ? "Serialized deferred-tree-v1 cannot contain original-bottle source metadata" : "Serialized deferred-tree-v2 requires original-bottle source metadata");
				const i = Qo(n.url, "Serialized lazy tree URL", Ro);
				if (i !== r.content.transports[0]) throw new Error("Serialized lazy tree URL differs from its primary transport");
				const s = Xo(n.integrity);
				if (!s || s.sha256 !== r.content.sha256 || s.bytes !== r.content.bytes) throw new Error("Serialized lazy tree integrity differs from its content");
				if (!1 !== n.materialized) throw new Error("Serialized lazy tree must describe pending content");
				const o = new Map(r.entries.map((e) => [e.vfsPath, e])), a = new Map(r.entries.map((e) => [ca(e), e])), c = Jo(n.entries, "Serialized lazy tree entries", 0, To), l = /* @__PURE__ */ new Set(), h = c.map((e, t) => {
					const n = Zo(e, [
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
					], `Serialized lazy tree entry ${t}`), i = oa(n.vfsPath, !0, `Serialized lazy tree entry ${t} VFS path`);
					if (l.has(i)) throw new Error(`Serialized lazy tree duplicates pending path ${i}`);
					l.add(i);
					const s = oa(n.sourcePath, !1, `Serialized lazy tree entry ${t} source path`), c = oa(n.archivePath, !1, `Serialized lazy tree entry ${t} archive path`), h = o.get(i), d = a.get(ca({
						sourcePath: s,
						type: "string" == typeof n.type ? n.type : void 0,
						inodeGroup: "string" == typeof n.inodeGroup ? n.inodeGroup : void 0,
						target: "string" == typeof n.target ? n.target : void 0
					})) ?? h;
					if (!d || "file" !== d.type && "hardlink" !== d.type || void 0 !== h?.inodeGroup && h.inodeGroup !== d.inodeGroup) throw new Error(`Serialized lazy tree entry ${i} is absent from its inventory`);
					const f = r.canonicalByGroup.get(d.inodeGroup);
					if (n.type !== d.type || n.inodeGroup !== d.inodeGroup || n.size !== d.size || c !== f?.sourcePath || n.target !== d.target || !1 !== n.isSymlink || !1 !== n.deleted || !1 !== n.materialized) throw new Error(`Serialized lazy tree entry ${i} disagrees with its inventory`);
					return {
						vfsPath: i,
						ino: ea(n.ino, `Serialized lazy tree entry ${i} inode`, 1, Number.MAX_SAFE_INTEGER),
						generation: ea(n.generation, `Serialized lazy tree entry ${i} generation`, 0, Number.MAX_SAFE_INTEGER),
						dataSequence: ea(n.dataSequence, `Serialized lazy tree entry ${i} data sequence`, 0, Number.MAX_SAFE_INTEGER),
						size: d.size,
						isSymlink: !1,
						deleted: !1,
						materialized: !1,
						archivePath: c,
						sourcePath: s,
						type: d.type,
						inodeGroup: d.inodeGroup,
						...void 0 === d.target ? {} : { target: d.target }
					};
				});
				return {
					kind: t,
					content: r.content,
					inventory: r.entries,
					activation: r.activation,
					url: i,
					mountPrefix: r.mountPrefix,
					integrity: s,
					materialized: !1,
					entries: h
				};
			}(e, n);
			if (n === Do) return la(e, !1);
			if (void 0 !== n) throw new Error(`Serialized lazy archive group ${t} has an unsupported kind`);
			if (r) throw new Error(`Serialized lazy archive group ${t} is missing its kind discriminator`);
			return la(e, !0);
		});
		ia([...this.serializeLazyArchiveEntries(), ...i]);
		const s = [], o = /* @__PURE__ */ new Map();
		for (const a of i) {
			const t = /* @__PURE__ */ new Map(), r = a.mountPrefix.replace(/\/+$/, ""), i = void 0 !== a.content && void 0 !== a.inventory && void 0 !== a.activation, c = i ? new Map(a.inventory.map((e) => [e.vfsPath, e])) : null, l = i ? new Map(a.inventory.map((e) => [ca(e), e])) : null, h = /* @__PURE__ */ new Map(), d = /* @__PURE__ */ new Map();
			for (const s of a.entries) {
				let o = null;
				const f = a.materialized || !0 === s.materialized || s.isSymlink;
				if (!s.deleted && !f) {
					if ((void 0 === s.generation || void 0 === s.dataSequence) && !n) throw new Error("Live lazy-archive metadata requires inode generation and data sequence");
					try {
						o = this.fs.lstat(s.vfsPath);
					} catch {
						if (i) throw new Error(`Serialized lazy tree stub ${s.vfsPath} is missing from the filesystem`);
						continue;
					}
					if (o.ino !== s.ino) {
						if (i) throw new Error(`Serialized lazy tree stub ${s.vfsPath} has a different inode`);
						continue;
					}
					if (void 0 !== s.generation && o.generation !== s.generation) {
						if (i) throw new Error(`Serialized lazy tree stub ${s.vfsPath} has a different generation`);
						continue;
					}
					if (void 0 === s.dataSequence) {
						if (!e.canAdoptLegacyLazyStub(o)) {
							if (i) throw new Error(`Serialized lazy tree stub ${s.vfsPath} is not pristine`);
							continue;
						}
					} else if (o.dataSequence !== s.dataSequence) {
						if (i) throw new Error(`Serialized lazy tree stub ${s.vfsPath} has a different data sequence`);
						continue;
					}
					if (i) {
						const t = c.get(s.vfsPath), n = l.get(ca(s)) ?? t;
						if (!n || (o.mode & vo) !== Ao || 0 !== o.size || (4095 & o.mode) !== n.mode || void 0 !== t?.inodeGroup && t.inodeGroup !== n.inodeGroup) throw new Error(`Serialized lazy tree stub ${s.vfsPath} disagrees with its inventory`);
						const r = e.inodeKey(o.ino, o.generation), i = s.inodeGroup, a = h.get(i), f = d.get(r);
						if (void 0 !== a && a !== r || void 0 !== f && f !== i) throw new Error(`Serialized lazy tree inode group ${i} disagrees with the filesystem`);
						h.set(i, r), d.set(r, i);
					}
				}
				t.set(s.vfsPath, {
					ino: s.ino,
					generation: o?.generation ?? s.generation,
					dataSequence: o?.dataSequence ?? s.dataSequence,
					size: s.size,
					isSymlink: s.isSymlink,
					deleted: s.deleted,
					materialized: f,
					archivePath: s.archivePath ?? s.vfsPath.slice(r.length + 1),
					sourcePath: s.sourcePath ?? s.archivePath ?? s.vfsPath.slice(r.length + 1),
					type: s.type ?? (s.isSymlink ? "symlink" : "file"),
					inodeGroup: s.inodeGroup,
					target: s.target
				});
			}
			const f = void 0 === a.content ? void 0 : ta(a.content), u = {
				content: f,
				url: f?.transports[0] ?? a.url,
				mountPrefix: a.mountPrefix,
				integrity: f ? {
					sha256: f.sha256,
					bytes: f.bytes
				} : Xo(a.integrity),
				materialized: a.materialized || !(f && a.inventory) && Array.from(t.values()).every((e) => e.deleted || e.materialized),
				inventory: a.inventory?.map((e) => ({ ...e })),
				activation: a.activation ? {
					mode: a.activation.mode,
					capabilities: [...a.activation.capabilities],
					roots: [...a.activation.roots]
				} : void 0,
				entries: t
			};
			if (s.push(u), !u.materialized) {
				for (const [, n] of t) if (!n.deleted && !n.materialized && void 0 !== n.generation) {
					const t = e.inodeKey(n.ino, n.generation), r = o.get(t);
					if (void 0 !== r && r !== u) throw new Error(`Serialized lazy archive groups share pending inode ${t}`);
					if (this.lazyArchiveInodes.has(t)) throw new Error(`Serialized lazy archive group collides with pending inode ${t}`);
					o.set(t, u);
				}
			}
		}
		this.lazyArchiveGroups.push(...s);
		for (const [e, a] of o) this.lazyArchiveInodes.set(e, a);
	}
	rewriteLazyArchiveUrls(e) {
		for (const t of this.lazyArchiveGroups) t.content ? (t.content = {
			...t.content,
			transports: t.content.transports.map(e)
		}, t.url = t.content.transports[0]) : t.url = e(t.url);
	}
	serializeLazyArchiveEntries() {
		const e = [];
		for (const t of this.lazyArchiveGroups) {
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
			const r = void 0 !== t.content && void 0 !== t.inventory && void 0 !== t.activation;
			if (r && 0 === t.content.transports.length) throw new Error("Direct-materialization tree must be materialized before serialization");
			e.push(r ? {
				kind: void 0 === t.content.source ? $o : Oo,
				content: t.content,
				inventory: t.inventory,
				activation: t.activation,
				url: t.url,
				mountPrefix: t.mountPrefix,
				integrity: t.integrity,
				materialized: !1,
				entries: n
			} : {
				kind: Do,
				url: t.url,
				mountPrefix: t.mountPrefix,
				integrity: t.integrity,
				materialized: !1,
				entries: n
			});
		}
		return e;
	}
	exportLazyArchiveEntries() {
		return this.reconcileLazyIdentityState(this.fs.identityState()), this.serializeLazyArchiveEntries();
	}
	pendingDeferredTreeUsage() {
		return this.reconcileLazyIdentityState(this.fs.identityState()), na(this.serializeLazyArchiveEntries());
	}
	assertCanAppendDeferredTreeUsage(e) {
		ra(e);
		const t = this.pendingDeferredTreeUsage();
		ra({
			groups: t.groups + e.groups,
			archiveBytes: t.archiveBytes + e.archiveBytes,
			expandedBytes: t.expandedBytes + e.expandedBytes,
			payloadBytes: t.payloadBytes + e.payloadBytes,
			entries: t.entries + e.entries
		});
	}
	assertCanRegisterPendingLazyArchiveGroup() {
		if (this.reconcileLazyIdentityState(this.fs.identityState()), this.lazyArchiveGroups.filter((e) => !e.materialized && (void 0 !== e.content && void 0 !== e.inventory || Array.from(e.entries.values()).some((e) => !e.deleted && !e.materialized))).length >= so) throw new Error(`Cannot register another lazy archive group: ${so} pending groups already exist`);
	}
	async preparePath(e) {
		let t = !1;
		const n = Math.max(3, this.lazyArchiveGroups.length + 1);
		for (let r = 0; r < n; r++) {
			const n = this.lazyBackingForPath(e);
			if (!n) return t;
			const r = this.lazyPreparations.get(n.token) ?? this.startLazyPreparation(n);
			try {
				t = await r.promise || t;
			} finally {
				this.lazyPreparations.get(n.token) === r && this.lazyPreparations.delete(n.token);
			}
		}
		if (this.lazyBackingForPath(e)) throw new Error(`Lazy backing kept changing identity while preparing: ${e}`);
		return t;
	}
	async prepareBootDeferredTrees() {
		const e = this.lazyArchiveGroups.filter((e) => !e.materialized && "boot-prefetch" === e.activation?.mode);
		let t, n = 0;
		const r = Array.from({ length: Math.min(e.length, 2) }, async () => {
			for (; void 0 === t;) {
				const i = n;
				if (n += 1, i >= e.length) return;
				try {
					await this.prepareLazyTreeGroup(e[i]);
				} catch (r) {
					t ??= r;
				}
			}
		});
		if (await Promise.all(r), void 0 !== t) throw t;
		return e.length;
	}
	async materializeRegisteredDeferredTree(e, t) {
		const n = this.deferredTreeMaterializationHandles.get(e);
		if (void 0 === n) throw new Error("Deferred-tree handle was not issued by this filesystem");
		if (n.materialized) return !1;
		const r = this.lazyPreparations.get(n);
		if (void 0 !== r) return r.promise;
		const i = new Uint8Array(t.byteLength);
		i.set(t);
		const s = {
			status: "pending",
			promise: Promise.resolve(!1)
		};
		s.promise = Promise.resolve().then(async () => (await ha(i, "tree", n.integrity), await this.materializeArchiveBytes(n, i), !0)).then((e) => (s.status = "fulfilled", e), (e) => {
			throw s.status = "rejected", s.error = e, e;
		}), s.promise.catch(() => {}), this.lazyPreparations.set(n, s);
		try {
			return await s.promise;
		} finally {
			this.lazyPreparations.get(n) === s && this.lazyPreparations.delete(n);
		}
	}
	async prepareLazyTreeGroup(e) {
		if (e.materialized) return !1;
		const t = {
			token: e,
			path: e.activation?.roots[0] ?? e.mountPrefix,
			directGroup: e
		}, n = this.lazyPreparations.get(e) ?? this.startLazyPreparation(t);
		try {
			return await n.promise;
		} finally {
			this.lazyPreparations.get(e) === n && this.lazyPreparations.delete(e);
		}
	}
	async ensureMaterialized(e) {
		return this.preparePath(e);
	}
	async materializePath(t) {
		if (0 === this.lazyFiles.size && 0 === this.lazyArchiveInodes.size) return !1;
		let n;
		try {
			n = this.fs.stat(t);
		} catch {
			return !1;
		}
		const r = e.inodeKey(n.ino, n.generation), i = this.lazyFiles.get(r);
		if (i) {
			const e = await this.fetchLazyBytes({
				id: `file:${n.ino}`,
				kind: "file",
				url: i.url,
				path: i.path,
				fallbackTotalBytes: i.size
			});
			for (let n = 0; n < 3; n++) {
				if (this.lazyFiles.get(r) !== i) return !1;
				for (const n of new Set([t, ...i.paths])) if (this.fs.replaceIfIdentity(n, i.ino, i.generation, i.dataSequence, e)) return i.path = n, this.lazyFiles.delete(r), !0;
				this.reconcileLazyIdentityState(this.fs.identityState());
			}
			throw new Error(`Lazy file kept changing names while materializing: ${t}`);
		}
		const s = this.lazyArchiveInodes.get(r);
		return !!s && (await this.ensureArchiveMaterialized(s, {
			path: t,
			ino: n.ino,
			generation: n.generation
		}), !this.lazyArchiveInodes.has(r));
	}
	async decodeAndValidateLazyTree(e, t) {
		const n = e.content, r = e.inventory;
		if (!n || !r) throw new Error("Lazy tree is missing its decoder or complete inventory");
		const i = /* @__PURE__ */ new Map(), s = new Map(r.map((e) => [e.vfsPath, e]));
		if (void 0 !== n.source) for (const h of n.source.entries) i.set(h.sourcePath, h);
		else for (const h of r) {
			if ("hardlink" === h.type) {
				const e = s.get(h.target);
				if (!e) throw new Error(`Lazy tree hardlink target disappeared: ${h.target}`);
				if (h.sourcePath === e.sourcePath) continue;
			}
			if (i.get(h.sourcePath)) throw new Error(`Lazy tree inventory duplicates source member ${h.sourcePath}`);
			i.set(h.sourcePath, {
				sourcePath: h.sourcePath,
				type: h.type,
				mode: h.mode,
				size: h.size,
				..."symlink" === h.type ? { target: h.target } : {},
				..."hardlink" === h.type ? { target: s.get(h.target)?.sourcePath } : {}
			});
		}
		const o = /* @__PURE__ */ new Map();
		let a = 0;
		if ("zip-v1" === n.decoder) {
			const { parseZipCentralDirectory: e, extractZipEntryBounded: r } = await import("./zip-DJ-is7oS.js"), s = e(t);
			if (s.length !== n.sourceEntryCount || s.length !== i.size) throw new Error("Lazy ZIP tree decoded inventory counts differ from its descriptor");
			for (const c of s) {
				const e = c.isDirectory ? c.fileName.replace(/\/$/, "") : c.fileName;
				if (o.has(e)) throw new Error(`Lazy ZIP tree duplicates source member ${e}`);
				const s = i.get(e);
				if (!s) throw new Error(`Lazy ZIP tree has undeclared source member ${e}`);
				if (a += c.uncompressedSize, a > n.expandedBytes || c.uncompressedSize !== s.size) throw new Error(`Lazy ZIP tree member ${e} exceeds its inventory`);
				if ((c.isDirectory ? "directory" : c.isSymlink ? "symlink" : "file") !== s.type || (4095 & c.mode) !== s.mode) throw new Error(`Lazy ZIP tree member ${e} differs from inventory`);
				if (c.isDirectory) o.set(e, {
					type: "directory",
					mode: c.mode
				});
				else {
					const n = r(t, c, s.size);
					if (c.isSymlink) {
						let t;
						try {
							t = new TextDecoder("utf-8", { fatal: !0 }).decode(n);
						} catch {
							throw new Error(`Lazy ZIP tree symlink ${e} is not UTF-8`);
						}
						o.set(e, {
							type: "symlink",
							mode: c.mode,
							target: t
						});
					} else o.set(e, {
						type: "file",
						mode: c.mode,
						data: n
					});
				}
			}
		} else {
			const { parseTarGzip: e } = await import("./tar-DZRSonKk.js"), r = e(t, {
				label: `Lazy tree ${n.sha256}`,
				limits: {
					maxCompressedBytes: n.bytes,
					maxUncompressedBytes: n.expandedBytes,
					maxEntries: n.sourceEntryCount
				}
			});
			a = new DataView(t.buffer, t.byteOffset, t.byteLength).getUint32(t.byteLength - 4, !0);
			for (const t of r) {
				if (o.has(t.path)) throw new Error(`Lazy TAR tree duplicates source member ${t.path}`);
				"file" === t.type ? o.set(t.path, {
					type: "file",
					mode: t.mode,
					data: t.data
				}) : "directory" === t.type ? o.set(t.path, {
					type: "directory",
					mode: t.mode
				}) : o.set(t.path, {
					type: t.type,
					mode: t.mode,
					target: t.linkName
				});
			}
		}
		if (o.size !== n.sourceEntryCount || o.size !== i.size || a !== n.expandedBytes) throw new Error("Lazy tree decoded inventory counts differ from its descriptor");
		for (const [h, d] of i) {
			const e = o.get(h);
			if (!e) throw new Error(`Lazy tree is missing source member ${h}`);
			const t = d.type;
			if (e.type !== t) throw new Error(`Lazy tree member ${h} is ${e.type}, expected ${t}`);
			if ((4095 & e.mode) !== d.mode) throw new Error(`Lazy tree member ${h} mode differs from inventory`);
			if ("file" === t && e.data?.byteLength !== d.size) throw new Error(`Lazy tree member ${h} size differs from inventory`);
			if ("symlink" === t && e.target !== d.target) throw new Error(`Lazy tree symlink ${h} target differs from inventory`);
			if ("hardlink" === t && e.target !== d.target) throw new Error(`Lazy tree hardlink ${h} target differs from inventory`);
		}
		const c = new Set(r.flatMap((e) => "archive-homebrew-relocate" === e.materialization ? [e.sourcePath] : []));
		if (void 0 !== n.source) {
			const e = new Map(n.source.entries.map((e) => [e.sourcePath, e])), t = sa(n.source.entries), r = n.source.entries.filter((e) => "INSTALL_RECEIPT.json" === e.sourcePath || e.sourcePath.endsWith("/INSTALL_RECEIPT.json"));
			if (r.length > 1) throw new Error(`Lazy Homebrew bottle has ${r.length} INSTALL_RECEIPT.json source members, expected at most one`);
			if (0 === r.length) {
				if (c.size > 0) throw new Error("Lazy Homebrew bottle marks receipt relocation without INSTALL_RECEIPT.json");
			} else {
				const n = r[0], i = "file" === n.type ? n : t.get(n.sourcePath), s = void 0 === i ? void 0 : o.get(i.sourcePath);
				if ("file" !== i?.type || "file" !== s?.type || void 0 === s.data) throw new Error("Lazy Homebrew bottle INSTALL_RECEIPT.json is not regular");
				const a = po(s.data), l = n.sourcePath.lastIndexOf("/"), h = l < 0 ? "" : n.sourcePath.slice(0, l), d = new Set(a.changedFiles.map((e) => 0 === h.length ? e : `${h}/${e}`));
				if (c.size !== d.size || [...c].some((e) => !d.has(e))) throw new Error("Lazy Homebrew bottle relocation markers differ from INSTALL_RECEIPT.json");
				const f = /* @__PURE__ */ new Set();
				for (const r of d) {
					const n = e.get(r), i = "file" === n?.type ? n : void 0 === n ? void 0 : t.get(n.sourcePath), s = void 0 === i ? void 0 : o.get(i.sourcePath);
					if ("file" !== i?.type || "file" !== s?.type || void 0 === s.data) throw new Error(`Lazy Homebrew bottle changed source ${r} is not regular`);
					f.has(i.sourcePath) || (s.data = go(s.data, a, r), f.add(i.sourcePath));
				}
			}
		} else if (c.size > 0) throw new Error("Lazy tree receipt relocation requires original-bottle source truth");
		const l = /* @__PURE__ */ new Map();
		for (const h of r) {
			if ("file" !== h.type) continue;
			if ("descriptor" === h.materialization) continue;
			const e = o.get(h.sourcePath);
			if ("file" !== e?.type || !e.data) throw new Error(`Lazy tree has no file content for ${h.sourcePath}`);
			l.set(h.sourcePath, e.data);
		}
		return l;
	}
	async ensureArchiveMaterialized(e, t) {
		if (e.materialized) return;
		const n = void 0 !== e.content && void 0 !== e.inventory, r = n ? e.content.transports : [e.url], i = [];
		let s = null;
		for (const [a, c] of r.entries()) try {
			s = await this.fetchLazyBytes({
				id: `archive:${e.mountPrefix}:${e.content?.sha256 ?? c}:${a}`,
				kind: n ? "tree" : "archive",
				url: c,
				mountPrefix: e.mountPrefix,
				integrity: e.integrity
			});
			break;
		} catch (o) {
			i.push(o instanceof Error ? o.message : String(o));
		}
		if (null === s) throw new Error(`All ${r.length} lazy ${n ? "tree" : "archive"} transports failed: ${i.join("; ")}`);
		await this.materializeArchiveBytes(e, s, t);
	}
	async materializeArchiveBytes(t, n, r) {
		if (t.materialized) return;
		const i = void 0 !== t.content && void 0 !== t.inventory ? await this.decodeAndValidateLazyTree(t, n) : null, { parseZipCentralDirectory: s, extractZipEntry: o } = await import("./zip-DJ-is7oS.js"), a = i ? [] : s(n), c = /* @__PURE__ */ new Map();
		for (const e of a) {
			if (c.has(e.fileName)) throw new Error(`Lazy archive contains duplicate member: ${e.fileName}`);
			c.set(e.fileName, e);
		}
		const l = t.mountPrefix.replace(/\/+$/, ""), h = /* @__PURE__ */ new Map();
		for (const [f, u] of t.entries) {
			if (u.deleted || u.materialized) continue;
			const t = u.archivePath ?? f.slice(l.length + 1), r = i ? void 0 : c.get(t), s = i?.get(t);
			if (i) {
				if (void 0 === s || s.byteLength !== u.size) throw new Error(`Lazy tree member ${t} does not match its registered metadata`);
			} else if (void 0 === r || r.isDirectory || r.isSymlink || r.uncompressedSize !== u.size) throw new Error(`Lazy archive member ${t} does not match its registered metadata`);
			if (void 0 === u.generation) continue;
			const a = e.inodeKey(u.ino, u.generation), d = h.get(a);
			if (d && d.archivePath !== t) throw new Error(`Lazy archive aliases for inode ${a} name different members`);
			if (!d) {
				const e = s ?? o(n, r);
				if (e.byteLength !== u.size) throw new Error(`Lazy archive member ${t} extracted ${e.byteLength} bytes, expected ${u.size}`);
				h.set(a, {
					archivePath: t,
					content: e
				});
			}
		}
		const d = r ? e.inodeKey(r.ino, r.generation) : null;
		for (let f = 0; f < 3; f++) {
			const n = /* @__PURE__ */ new Map();
			for (const [i, s] of t.entries) {
				if (s.deleted || s.materialized || void 0 === s.generation) continue;
				const o = e.inodeKey(s.ino, s.generation);
				if (this.lazyArchiveInodes.get(o) !== t) continue;
				const a = h.get(o);
				if (!a) throw new Error(`Lazy archive has no extracted content for inode ${o}`);
				let c = n.get(o);
				c || (c = {
					ino: s.ino,
					generation: s.generation,
					dataSequence: s.dataSequence ?? 0,
					paths: /* @__PURE__ */ new Set(),
					content: a.content
				}, n.set(o, c)), c.paths.add(i), r && r.ino === s.ino && r.generation === s.generation && c.paths.add(r.path);
			}
			if (n.size > 0 && !this.fs.replaceManyIfIdentities(Array.from(n.values(), (e) => ({
				paths: Array.from(e.paths),
				expectedIno: e.ino,
				expectedGeneration: e.generation,
				expectedDataSequence: e.dataSequence,
				data: e.content
			})))) {
				if (this.reconcileLazyIdentityState(this.fs.identityState()), d && !this.lazyArchiveInodes.has(d)) return;
			} else {
				for (const [e, r] of n) {
					this.lazyArchiveInodes.delete(e);
					for (const e of t.entries.values()) e.ino === r.ino && e.generation === r.generation && (e.materialized = !0);
				}
				if (t.materialized = Array.from(t.entries.values()).every((e) => e.deleted || e.materialized), t.materialized) return;
				if (this.reconcileLazyIdentityState(this.fs.identityState()), d && !this.lazyArchiveInodes.has(d)) return;
			}
		}
		if (d && this.lazyArchiveInodes.has(d)) throw new Error(`Lazy archive member kept changing names while materializing: ${r?.path}`);
	}
	async materializeAllLazyEntries() {
		for (let t = 0; t < 3; t++) {
			this.reconcileLazyIdentityState(this.fs.identityState());
			const e = this.lazyArchiveGroups.filter((e) => !e.materialized && void 0 !== e.content && void 0 !== e.inventory);
			if (0 === this.lazyFiles.size && 0 === this.lazyArchiveInodes.size && 0 === e.length) return;
			const t = Array.from(this.lazyFiles.values(), (e) => e.path);
			for (const r of t) await this.ensureMaterialized(r);
			const n = new Set(this.lazyArchiveInodes.values());
			for (const r of e) n.add(r);
			for (const r of n) await this.prepareLazyTreeGroup(r);
		}
		this.reconcileLazyIdentityState(this.fs.identityState());
		const e = this.lazyArchiveGroups.some((e) => !e.materialized && void 0 !== e.content && void 0 !== e.inventory);
		if (0 !== this.lazyFiles.size || 0 !== this.lazyArchiveInodes.size || e) throw new Error("Cannot create a self-contained VFS image while lazy entries remain pending");
	}
	async saveImage(e) {
		e?.materializeAll && await this.materializeAllLazyEntries();
		const { bytes: t, identities: n } = this.fs.snapshotState({ normalizeTimestampsMs: e?.normalizeTimestampsMs });
		this.reconcileLazyIdentityState(n);
		const r = this.serializeLazyEntries(), i = r.length > 0, s = i ? new TextEncoder().encode(JSON.stringify(r)) : new Uint8Array(0);
		if (s.byteLength > Po) throw new Error("VFS image lazy metadata exceeds 16777216 bytes");
		const o = this.serializeLazyArchiveEntries();
		ia(o);
		const a = o.length > 0, c = a ? new TextEncoder().encode(JSON.stringify(o)) : new Uint8Array(0);
		if (c.byteLength > Eo) throw new Error("VFS image lazy archive metadata exceeds 16777216 bytes");
		const l = function(e) {
			if (null === e) return new Uint8Array(0);
			const t = Ko(e), n = new TextEncoder().encode(JSON.stringify(t));
			if (n.byteLength > Co) throw new Error("VFS image metadata exceeds 65536 bytes");
			return n;
		}(void 0 === e?.metadata ? this.imageMetadata : e.metadata), h = l.byteLength > 0, d = a ? 4 + c.byteLength : 0, f = h ? 4 + l.byteLength : 0, u = ko + t.byteLength + 4 + s.byteLength + d + f, p = new Uint8Array(u), g = new DataView(p.buffer);
		g.setUint32(0, bo, !0), g.setUint32(4, 1, !0), g.setUint32(8, (i ? 1 : 0) | (a ? 2 : 0) | (a ? 8 : 0) | (h ? 4 : 0), !0), g.setUint32(12, t.byteLength, !0), p.set(t, ko);
		const m = ko + t.byteLength;
		if (g.setUint32(m, s.byteLength, !0), s.byteLength > 0 && p.set(s, m + 4), a) {
			const e = m + 4 + s.byteLength;
			g.setUint32(e, c.byteLength, !0), p.set(c, e + 4);
		}
		if (h) {
			const e = m + 4 + s.byteLength + d;
			g.setUint32(e, l.byteLength, !0), p.set(l, e + 4);
		}
		return p;
	}
	static readImageMetadata(e) {
		const t = qo(e);
		if (!(4 & t.flags)) return null;
		const { metadataOffset: n } = Go(t.image, t.view, t.flags, t.sabLen);
		if (t.image.byteLength < n + 4) throw new Error("VFS image truncated (metadata section)");
		const r = t.view.getUint32(n, !0);
		if (r > Co) throw new Error("VFS image metadata exceeds 65536 bytes");
		if (t.image.byteLength < n + 4 + r) throw new Error("VFS image truncated (metadata payload)");
		return 0 === r ? null : function(e) {
			if (e.byteLength > Co) throw new Error("VFS image metadata exceeds 65536 bytes");
			let t;
			try {
				t = JSON.parse(new TextDecoder().decode(e));
			} catch (n) {
				const e = n instanceof Error ? n.message : String(n);
				throw new Error(`Invalid VFS image metadata JSON: ${e}`);
			}
			return Ko(t);
		}(t.image.subarray(n + 4, n + 4 + r));
	}
	static assertImageKernelAbi(t, n, r = "VFS image") {
		const i = e.readImageMetadata(t)?.kernelAbi;
		if (void 0 !== i && i !== n) throw new Error(`${r} requires kernel ABI ${i}, but the running kernel is ABI ${n}`);
	}
	static readImageCapacity(e) {
		const t = qo(e);
		return Ns.inspectImageCapacity(t.image.subarray(ko, ko + t.sabLen));
	}
	static fromImagePreservingCapacity(t) {
		const n = qo(t), r = Ns.inspectImageCapacity(n.image.subarray(ko, ko + n.sabLen));
		return e.restoreParsedImage(n, { maxByteLength: r.maxByteLength });
	}
	static fromImage(t, n) {
		const r = qo(t);
		return e.restoreParsedImage(r, n);
	}
	static restoreParsedImage(t, n) {
		const r = t.image, i = t.view, s = t.flags, o = t.sabLen, a = Go(r, i, s, o);
		if (!(1 & s) && 0 !== a.lazyLen) throw new Error("VFS image has lazy metadata without its format flag");
		if (8 & s && !(2 & s)) throw new Error("VFS image has typed lazy-archive metadata without its archive flag");
		const c = n?.maxByteLength ? { maxByteLength: n.maxByteLength } : void 0, l = new SharedArrayBuffer(o, c);
		new Uint8Array(l).set(r.subarray(ko, ko + o));
		let h = null;
		4 & s && (h = e.readImageMetadata(r));
		const d = new e(Ns.mount(l, { restoreImage: !0 }), h), f = ko + o, u = a.lazyLen;
		if (1 & s && u > 0) {
			const e = Jo(jo(r.subarray(f + 4, f + 4 + u), "VFS image lazy metadata"), "VFS image lazy entries", 0, To);
			d.importLazyEntriesInternal(e, !0);
		}
		if (2 & s) {
			const e = a.archiveOffset, t = i.getUint32(e, !0);
			if (t > 0) {
				const n = jo(r.subarray(e + 4, e + 4 + t), "VFS image lazy archive metadata");
				d.importLazyArchiveEntriesInternal(n, !0, Boolean(8 & s));
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
		const t = this.adaptStat(e), n = this.lazyFileForStat(e);
		if (n) return t.size = n.size, t;
		const r = this.lazyArchiveForStat(e);
		if (r) {
			for (const i of r.entries.values()) if (i.ino === e.ino && i.generation === e.generation && !i.deleted) {
				t.size = i.size;
				break;
			}
		}
		return t;
	}
	open(e, t, n) {
		512 & t || 64 & t && 128 & t || this.guardSynchronousLazyAccess(e);
		const r = this.fs.open(e, t, n);
		return 512 & t && this.invalidateLazyData(this.fs.fstat(r)), r;
	}
	close(e) {
		return this.fs.close(e), 0;
	}
	read(e, t, n, r) {
		if (r > 0) {
			let t = this.lazyBackingForStat(this.fs.fstat(e));
			t && (this.reconcileLazyIdentityState(this.fs.identityState()), t = this.lazyBackingForStat(this.fs.fstat(e)), t && this.guardSynchronousLazyAccess(t.path));
		}
		return null !== n ? this.fs.readAt(e, t.subarray(0, r), n) : this.fs.read(e, t.subarray(0, r));
	}
	write(e, t, n, r) {
		if (null !== n) {
			const i = this.fs.writeAt(e, t.subarray(0, r), n);
			return i > 0 && this.invalidateLazyData(this.fs.fstat(e)), i;
		}
		const i = this.fs.write(e, t.subarray(0, r));
		return i > 0 && this.invalidateLazyData(this.fs.fstat(e)), i;
	}
	seek(e, t, n) {
		return this.fs.lseek(e, t, n);
	}
	fstat(e) {
		return this.adaptStatWithLazySize(this.fs.fstat(e));
	}
	fpathconf(e, t) {
		return gs(this.fstat(e), t, {
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
	fchown(e, t, n) {
		this.fs.fchown(e, t, n);
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
		return gs(this.stat(e), t, {
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
		const n = this.fs.unlink(t), r = e.inodeKey(n.ino, n.generation);
		if (n.linkCount > 1 && (this.lazyFiles.has(r) || this.lazyArchiveInodes.has(r))) return void this.reconcileLazyIdentityState(this.fs.identityState());
		const i = this.lazyFiles.get(r);
		i && (i.paths.delete(t), n.linkCount <= 1 ? this.lazyFiles.delete(r) : i.path === t && (i.path = i.paths.values().next().value));
		const s = this.lazyArchiveInodes.get(r);
		if (s) {
			const e = s.entries.get(t);
			if (n.linkCount <= 1) {
				for (const e of s.entries.values()) e.ino === n.ino && e.generation === n.generation && (e.deleted = !0);
				this.lazyArchiveInodes.delete(r);
			} else e && s.entries.delete(t);
		}
	}
	rename(t, n) {
		const { source: r, replaced: i } = this.fs.rename(t, n);
		if (i && i.ino === r.ino && i.generation === r.generation) return;
		let s = !1;
		if (i) {
			const t = e.inodeKey(i.ino, i.generation);
			i.linkCount > 1 && (this.lazyFiles.has(t) || this.lazyArchiveInodes.has(t)) && (this.reconcileLazyIdentityState(this.fs.identityState()), s = !0);
			const r = this.lazyFiles.get(t);
			!s && r && (r.paths.delete(n), i.linkCount <= 1 ? this.lazyFiles.delete(t) : r.path === n && (r.path = r.paths.values().next().value));
			const o = this.lazyArchiveInodes.get(t);
			if (!s && o) {
				const e = o.entries.get(n);
				i.linkCount <= 1 ? (e && (e.deleted = !0), this.lazyArchiveInodes.delete(t)) : e && o.entries.delete(n);
			}
		}
		s || this.rewriteLazyNamespacePaths(r, t, n);
	}
	link(t, n) {
		const r = this.fs.link(t, n), i = e.inodeKey(r.ino, r.generation), s = this.lazyFiles.get(i);
		s && s.paths.add(n);
		const o = this.lazyArchiveInodes.get(i);
		if (o) {
			const e = Array.from(o.entries.values()).find((e) => e.ino === r.ino && e.generation === r.generation);
			e && o.entries.set(n, { ...e });
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
	copyPathToFreshFileSystem(t, n, r, i, s) {
		const o = this.lstat(t), a = o.mode & vo, c = 4095 & o.mode;
		if (a === Io) {
			"/" === t ? (n.chown(t, o.uid, o.gid), n.chmod(t, c)) : n.mkdirWithOwner(t, c, o.uid, o.gid);
			const a = this.opendir(t);
			try {
				for (;;) {
					const e = this.readdir(a);
					if (!e) break;
					"." !== e.name && ".." !== e.name && this.copyPathToFreshFileSystem("/" === t ? `/${e.name}` : `${t}/${e.name}`, n, r, i, s);
				}
			} finally {
				this.closedir(a);
			}
			e.applyTimes(n, t, o);
			return;
		}
		const l = o.nlink > 1 ? `${o.dev}:${o.ino}` : null, h = l ? s.get(l) : void 0;
		if (h) n.link(h, t);
		else {
			if (40960 === a) return n.symlinkWithOwner(this.readlink(t), t, o.uid, o.gid), void (l && s.set(l, t));
			if (a !== Ao) throw new Error(`Unsupported file type while rebasing VFS: ${t}`);
			if (r.has(t) || i.has(t)) return n.createFileWithOwner(t, c, o.uid, o.gid, new Uint8Array(0)), e.applyTimes(n, t, o), void (l && s.set(l, t));
			this.copyRegularFileToFreshFileSystem(t, n, o, c), l && s.set(l, t);
		}
	}
	copyRegularFileToFreshFileSystem(t, n, r, i) {
		const s = this.open(t, 0, 0);
		let o = null;
		try {
			o = n.open(t, 577, i);
			const e = new Uint8Array(Math.min(1048576, Math.max(1, r.size)));
			let a = r.size;
			for (; a > 0;) {
				const r = Math.min(e.byteLength, a), i = this.read(s, e, null, r);
				if (i <= 0) throw new Error(`Unexpected EOF while rebasing VFS file: ${t}`);
				let c = 0;
				for (; c < i;) {
					const r = n.write(o, e.subarray(c, i), null, i - c);
					if (r <= 0) throw new Error(`Short write while rebasing VFS file: ${t}`);
					c += r;
				}
				a -= i;
			}
		} finally {
			null !== o && n.close(o), this.close(s);
		}
		n.chown(t, r.uid, r.gid), n.chmod(t, i), e.applyTimes(n, t, r);
	}
	static applyTimes(e, t, n) {
		const r = Math.floor(n.atimeMs / 1e3), i = Math.floor(1e6 * (n.atimeMs - 1e3 * r)), s = Math.floor(n.mtimeMs / 1e3), o = Math.floor(1e6 * (n.mtimeMs - 1e3 * s));
		e.utimensat(t, r, i, s, o);
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
const fa = /^[0-9a-f]{64}$/;
function ua(e) {
	return function(e) {
		const t = new Map(e.map((e) => [e.url, e]));
		return async (e) => {
			const n = t.get(e);
			if (void 0 === n) throw new Error(`closed lazy assets do not bind URL ${e}`);
			if (n.bytes.byteLength !== n.size) throw new Error(`closed lazy asset ${e} changed size before response`);
			const r = new ArrayBuffer(n.bytes.byteLength);
			if (new Uint8Array(r).set(n.bytes), i = new Uint8Array(await crypto.subtle.digest("SHA-256", r)), Array.from(i, (e) => e.toString(16).padStart(2, "0")).join("") !== n.sha256) throw new Error(`closed lazy asset ${e} changed SHA-256 before response`);
			var i;
			const s = pa(n.bytes);
			return new Response(s.buffer, {
				status: 200,
				headers: { "content-length": String(s.byteLength) }
			});
		};
	}(function(e, t) {
		if (!Array.isArray(e) || 0 === e.length) throw new Error("closed lazy assets must contain at least one binding");
		if (e.length > 128) throw new Error("closed lazy assets exceed 128 bindings");
		const n = /* @__PURE__ */ new Set();
		let r = 0;
		return e.map((e, i) => {
			if ("object" != typeof e || null === e) throw new Error(`closed lazy asset ${i} is not an object`);
			const { url: s, sha256: o, size: a, bytes: c } = e;
			if ("string" != typeof s || !fa.test(o) || !Number.isSafeInteger(a) || a <= 0 || !(c instanceof Uint8Array)) throw new Error(`closed lazy asset ${i} has invalid fields`);
			let l;
			try {
				l = new URL(s);
			} catch (h) {
				throw new Error(`closed lazy asset ${i} URL is invalid`, { cause: h });
			}
			if ("https:" !== l.protocol || "" !== l.username || "" !== l.password || "" !== l.hash || l.href !== s) throw new Error(`closed lazy asset ${i} must use one canonical credential-free HTTPS URL`);
			if (n.has(s)) throw new Error(`closed lazy assets duplicate URL ${s}`);
			if (c.byteLength !== a) throw new Error(`closed lazy asset ${i} has ${c.byteLength} bytes, expected ${a}`);
			if (r += a, !Number.isSafeInteger(r) || r > 536870912) throw new Error("closed lazy assets exceed 536870912 bytes");
			if (n.add(s), !(t || c.buffer instanceof ArrayBuffer && 0 === c.byteOffset && c.buffer.byteLength === c.byteLength)) throw new Error(`closed lazy asset ${i} ownership requires one whole ordinary ArrayBuffer`);
			return {
				url: s,
				sha256: o,
				size: a,
				bytes: t ? pa(c) : c
			};
		});
	}(e, !1));
}
function pa(e) {
	const t = new Uint8Array(e.byteLength);
	return t.set(e), t;
}
const ga = {
	reader: () => 0,
	writer: (e, t) => t,
	mode: 8630
}, ma = {
	reader: (e, t) => (e.fill(0, 0, t), t),
	writer: (e, t) => t,
	mode: 8630
}, ya = {
	reader: () => {
		throw new Error("ENXIO");
	},
	writer: () => {
		throw new Error("ENXIO");
	},
	mode: 8630
};
const wa = [
	"pts",
	"shm",
	"mqueue"
], _a = [
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
function Sa(e) {
	return "/" === e || "" === e || "." === e;
}
var ba = class {
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
		this.devices.set("null", ga), this.devices.set("zero", ma), this.devices.set("urandom", e), this.devices.set("random", e), this.devices.set("console", ya), this.devices.set("tty", ya), this.deviceNames = [...this.devices.keys()];
	}
	getDevice(e) {
		const t = e.startsWith("/") ? e.slice(1) : e, n = this.devices.get(t);
		if (!n) throw new Error("ENOENT");
		return n;
	}
	open(e, t, n) {
		const r = e.startsWith("/") ? e.slice(1) : e;
		if (Sa(e) || wa.includes(r)) {
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
	fpathconf(e, t) {
		return gs(this.fstat(e), t, {
			supportsSymlinks: !1,
			timestampResolutionNs: null
		});
	}
	ftruncate(e, t) {}
	fsync(e) {}
	fchmod(e, t) {}
	fchown(e, t, n) {}
	stat(e) {
		const t = Date.now();
		if (Sa(e)) return {
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
		return wa.includes(n) ? {
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
		return t.files = this.devices.size + wa.length + _a.length, t;
	}
	pathconf(e, t) {
		return gs(this.stat(e), t, {
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
	chown(e, t, n) {}
	lchown(e, t, n) {}
	access(e, t) {
		this.stat(e);
	}
	utimensat(e, t, n, r, i) {}
	dirHandles = /* @__PURE__ */ new Map();
	nextDirHandle = 1;
	opendir(e) {
		const t = e.startsWith("/") ? e.slice(1) : e;
		let n;
		if (Sa(e)) n = [...this.deviceNames.map((e, t) => ({
			name: e,
			type: 2,
			ino: t + 1
		})), ..._a.filter((e) => !this.devices.has(e.name))];
		else {
			if (!wa.includes(t)) throw new Error("ENOTDIR");
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
}, ka = class {
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
		const n = 1e3 * e + Math.floor(t / 1e6);
		if (n > 0) {
			const e = new SharedArrayBuffer(4);
			Atomics.wait(new Int32Array(e), 0, 0, n);
		}
	}
};
const va = [
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
function Aa(e) {
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
function Ia(e, t, n = {}) {
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
		const e = da.fromImage(t, { maxByteLength: 1073741824 });
		Aa(e), r.push({
			mountPoint: i.path,
			backend: e,
			readonly: i.readonly
		});
	} else {
		const e = n.scratchSabBytes?.[i.path] ?? 16777216, t = new SharedArrayBuffer(e), s = da.create(t);
		void 0 !== i.mode && s.chmod("/", i.mode), void 0 === i.uid && void 0 === i.gid || s.chown("/", i.uid ?? 0, i.gid ?? 0), r.push({
			mountPoint: i.path,
			backend: s,
			readonly: i.readonly
		});
	}
	return r;
}
function Ca(e) {
	return Object.assign(/* @__PURE__ */ new Error(`ENOENT: ${e}`), { errno: 2 });
}
function Pa(e, t) {
	(function(e) {
		const t = e.endsWith(".") ? e.slice(0, -1) : e;
		if (0 === t.length || !/^[\x00-\x7f]+$/.test(t)) throw Ca(e);
		let n = 1;
		for (const r of t.split(".")) {
			if (0 === r.length || r.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(r)) throw Ca(e);
			n += 1 + r.length;
		}
		if (n > 255) throw Ca(e);
	})(e);
	const n = e.endsWith(".") ? e.slice(0, -1) : e, r = n.toLowerCase();
	if ((!t || !Object.prototype.hasOwnProperty.call(t, n) && !Object.prototype.hasOwnProperty.call(t, r)) && ("invalid" === r || r.endsWith(".invalid"))) throw Ca(e);
}
var Ea = class extends Error {
	errno = 11;
	constructor() {
		super("EAGAIN");
	}
};
function xa(e) {
	let t = 0;
	e.forEach((e) => t += e.length);
	const n = new Uint8Array(t);
	let r = 0;
	return e.forEach((e) => {
		n.set(e, r), r += e.length;
	}), n;
}
function Ma(e) {
	return xa(e.map((e) => ArrayBuffer.isView(e) ? new Uint8Array(e.buffer, e.byteOffset, e.byteLength) : new Uint8Array(e))).buffer;
}
const za = (...e) => console.warn(...e);
function Ta(e) {
	return Object.fromEntries(Object.entries(e).map(([e, t]) => [t, e]));
}
function La(e) {
	return new Uint8Array([e >> 8 & 255, 255 & e]);
}
function Ba(e) {
	return new Uint8Array([
		e >> 16 & 255,
		e >> 8 & 255,
		255 & e
	]);
}
function Ua(e) {
	const t = /* @__PURE__ */ new ArrayBuffer(8);
	return new DataView(t).setBigUint64(0, BigInt(e), !1), new Uint8Array(t);
}
var Ra = class {
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
}, Ha = class {
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
const Fa = {
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
}, Wa = Ta(Fa), Da = { host_name: 0 }, $a = Ta(Da);
var Oa = class {
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
			if (n += s, r !== Da.host_name) throw new Error(`Unsupported name type ${r}`);
			i.push({
				name_type: $a[r],
				name: { host_name: new TextDecoder().decode(o) }
			});
		}
		return { server_name_list: i };
	}
	static encodeForClient(e) {
		if (e?.server_name_list.length) throw new Error("Encoding non-empty lists for ClientHello is not supported yet. Only empty lists meant for ServerHello are supported today.");
		const t = new Ha(4);
		return t.writeUint16(Fa.server_name), t.writeUint16(0), t.uint8Array;
	}
};
const Na = {
	uncompressed: 0,
	ansiX962_compressed_prime: 1,
	ansiX962_compressed_char2: 2
}, Ka = Ta(Na);
var Va = class {
	static decodeFromClient(e) {
		const t = new Ra(e.buffer), n = t.readUint8(), r = [];
		for (let i = 0; i < n; i++) {
			const e = t.readUint8();
			e in Ka && r.push(Ka[e]);
		}
		return r;
	}
	static encodeForClient(e) {
		const t = new Ha(6);
		return t.writeUint16(Fa.ec_point_formats), t.writeUint16(2), t.writeUint8(1), t.writeUint8(Na[e]), t.uint8Array;
	}
};
const qa = {
	decodeFromClient: (e) => ({}),
	encodeForClient() {
		const e = Fa.extended_master_secret;
		return new Uint8Array([
			e >> 8 & 255,
			255 & e,
			0,
			0
		]);
	}
}, Ga = {
	decodeFromClient(e) {
		const t = e[0] ?? 0;
		return { renegotiatedConnection: e.slice(1, 1 + t) };
	},
	encodeForClient() {
		const e = Fa.renegotiation_info, t = new Uint8Array([0]);
		return new Uint8Array([
			e >> 8 & 255,
			255 & e,
			0,
			t.length,
			...t
		]);
	}
}, ja = {
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
}, Xa = Ta(ja), Ya = {
	secp256r1: 23,
	secp384r1: 24,
	secp521r1: 25,
	x25519: 29,
	x448: 30
}, Za = Ta(Ya);
const Ja = {
	anonymous: 0,
	rsa: 1,
	dsa: 2,
	ecdsa: 3
}, Qa = Ta(Ja), ec = {
	none: 0,
	md5: 1,
	sha1: 2,
	sha224: 3,
	sha256: 4,
	sha384: 5,
	sha512: 6
}, tc = Ta(ec);
const nc = {
	server_name: Oa,
	signature_algorithms: class {
		static decodeFromClient(e) {
			const t = new Ra(e.buffer);
			t.readUint16();
			const n = [];
			for (; !t.isFinished();) {
				const e = t.readUint8(), r = t.readUint8();
				Qa[r] && (tc[e] ? n.push({
					algorithm: Qa[r],
					hash: tc[e]
				}) : za(`Unknown hash algorithm: ${e}`));
			}
			return n;
		}
		static encodeforClient(e, t) {
			const n = new Ha(6);
			return n.writeUint16(Fa.signature_algorithms), n.writeUint16(2), n.writeUint8(ec[e]), n.writeUint8(Ja[t]), n.uint8Array;
		}
	},
	supported_groups: class {
		static decodeFromClient(e) {
			const t = new Ra(e.buffer);
			t.readUint16();
			const n = [];
			for (; !t.isFinished();) {
				const e = t.readUint16();
				e in Za && n.push(Za[e]);
			}
			return n;
		}
		static encodeForClient(e) {
			const t = new Ha(6);
			return t.writeUint16(Fa.supported_groups), t.writeUint16(2), t.writeUint16(Ya[e]), t.uint8Array;
		}
	},
	ec_point_formats: Va,
	renegotiation_info: Ga,
	extended_master_secret: qa
};
async function rc(e, t, n, r) {
	const i = Ma([t, n]), s = await crypto.subtle.importKey("raw", e, {
		name: "HMAC",
		hash: { name: "SHA-256" }
	}, !1, ["sign"]);
	let o = i;
	const a = [];
	for (; Ma(a).byteLength < r;) {
		o = await ic(s, o);
		const e = await ic(s, Ma([o, i]));
		a.push(e);
	}
	return Ma(a).slice(0, r);
}
async function ic(e, t) {
	return await crypto.subtle.sign({
		name: "HMAC",
		hash: "SHA-256"
	}, e, t);
}
const sc = 0, oc = {
	Warning: 1,
	Fatal: 2
}, ac = Ta(oc), cc = {
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
}, lc = Ta(cc), hc = 20, dc = 21, fc = 22, uc = 23, pc = 0, gc = 1, mc = 2, yc = 11, wc = 12, _c = 14, Sc = 16, bc = 20, kc = 3, vc = 23;
var Ac = class extends Error {};
const Ic = new Uint8Array([3, 3]), Cc = crypto.subtle.generateKey({
	name: "ECDH",
	namedCurve: "P-256"
}, !0, ["deriveKey", "deriveBits"]);
var Pc = class {
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
		downstream: xc(this.MAX_CHUNK_SIZE)
	};
	serverUpstreamWriter = this.serverEnd.upstream.writable.getWriter();
	constructor() {
		const e = this;
		this.serverEnd.downstream.readable.pipeTo(new WritableStream({
			async write(t) {
				await e.writeTLSRecord(uc, t);
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
		const n = await this.readNextHandshakeMessage(gc);
		if (!n.body.cipher_suites.length) throw new Error("Client did not propose any supported cipher suites.");
		const r = crypto.getRandomValues(new Uint8Array(32));
		await this.writeTLSRecord(fc, Mc.serverHello(n.body, r, sc)), await this.writeTLSRecord(fc, Mc.certificate(t));
		const i = await Cc, s = n.body.random, o = await Mc.ECDHEServerKeyExchange(s, r, i, e);
		await this.writeTLSRecord(fc, o), await this.writeTLSRecord(fc, Mc.serverHelloDone());
		const a = n.body.extensions.some((e) => "extended_master_secret" === e.type), c = await this.readNextHandshakeMessage(Sc);
		await this.readNextMessage(hc), this.sessionKeys = await this.deriveSessionKeys({
			clientRandom: s,
			serverRandom: r,
			serverPrivateKey: i.privateKey,
			clientPublicKey: await crypto.subtle.importKey("raw", c.body.exchange_keys, {
				name: "ECDH",
				namedCurve: "P-256"
			}, !1, []),
			useEMS: a
		}), await this.readNextHandshakeMessage(bc), await this.writeTLSRecord(hc, Mc.changeCipherSpec()), await this.writeTLSRecord(fc, await Mc.createFinishedMessage(this.handshakeMessages, this.sessionKeys.masterSecret)), this.handshakeMessages = [], this.pollForClientMessages();
	}
	async deriveSessionKeys({ clientRandom: e, serverRandom: t, serverPrivateKey: n, clientPublicKey: r, useEMS: i = !1 }) {
		const s = await crypto.subtle.deriveBits({
			name: "ECDH",
			public: r
		}, n, 256);
		let o;
		if (i) {
			const e = new Uint8Array(await crypto.subtle.digest("SHA-256", xa(this.handshakeMessages)));
			o = new Uint8Array(await rc(s, new TextEncoder().encode("extended master secret"), e, 48));
		} else o = new Uint8Array(await rc(s, new TextEncoder().encode("master secret"), xa([e, t]), 48));
		const a = new Ra(await rc(o, new TextEncoder().encode("key expansion"), xa([t, e]), 40)), c = a.readUint8Array(16), l = a.readUint8Array(16), h = a.readUint8Array(4), d = a.readUint8Array(4);
		return {
			masterSecret: o,
			clientWriteKey: await crypto.subtle.importKey("raw", c, { name: "AES-GCM" }, !1, ["encrypt", "decrypt"]),
			serverWriteKey: await crypto.subtle.importKey("raw", l, { name: "AES-GCM" }, !1, ["encrypt", "decrypt"]),
			clientIV: h,
			serverIV: d
		};
	}
	async readNextHandshakeMessage(e) {
		const t = await this.readNextMessage(fc);
		if (t.msg_type !== e) throw new Error(`Expected ${e} message`);
		return t;
	}
	async readNextMessage(e) {
		let t, n = !1;
		do
			t = await this.readNextTLSRecord(e), n = await this.accumulateUntilMessageIsComplete(t);
		while (!1 === n);
		const r = Ec.TLSMessage(t.type, n);
		return t.type === fc && this.handshakeMessages.push(t.fragment), r;
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
				fragment: this.sessionKeys && r !== hc ? await this.decryptData(r, i) : i
			};
			if (s.type === dc) {
				const e = s.fragment[0], t = s.fragment[1], n = ac[e], r = lc[t];
				if (e === oc.Warning && t === cc.CloseNotify) throw new Ac("TLS connection closed by peer (CloseNotify)");
				throw new Error(`TLS alert received: ${n} ${r}`);
			}
			this.receivedTLSRecords.push(s);
		}
	}
	async pollBytes(e) {
		for (; this.receivedBytesBuffer.length < e;) {
			const { value: t, done: n } = await this.clientUpstreamReader.read();
			if (n) throw await this.close(), new Ac("TLS connection closed");
			if (this.receivedBytesBuffer = xa([this.receivedBytesBuffer, t]), this.receivedBytesBuffer.length >= e) break;
			await new Promise((e) => setTimeout(e, 100));
		}
		const t = this.receivedBytesBuffer.slice(0, e);
		return this.receivedBytesBuffer = this.receivedBytesBuffer.slice(e), t;
	}
	async pollForClientMessages() {
		try {
			for (;;) {
				const e = await this.readNextMessage(uc);
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
				...Ua(this.receivedRecordSequenceNumber),
				e,
				...Ic,
				...La(t.length - 8 - 16)
			]),
			tagLength: 128
		}, this.sessionKeys.clientWriteKey, t.slice(8));
		return ++this.receivedRecordSequenceNumber, new Uint8Array(s);
	}
	async accumulateUntilMessageIsComplete(e) {
		this.partialTLSMessages[e.type] = xa([this.partialTLSMessages[e.type] || new Uint8Array(), e.fragment]);
		const t = this.partialTLSMessages[e.type];
		switch (e.type) {
			case fc: {
				if (t.length < 4) return !1;
				const e = t[1] << 8 | t[2];
				if (t.length < 3 + e) return !1;
				break;
			}
			case dc:
				if (t.length < 2) return !1;
				break;
			case hc:
			case uc: break;
			default: throw new Error(`TLS: Unsupported record type ${e.type}`);
		}
		return delete this.partialTLSMessages[e.type], t;
	}
	async writeTLSRecord(e, t) {
		e === fc && this.handshakeMessages.push(t), this.sessionKeys && e !== hc && (t = await this.encryptData(e, t));
		const n = Ic, r = t.length, i = new Uint8Array(5);
		i[0] = e, i[1] = n[0], i[2] = n[1], i[3] = r >> 8 & 255, i[4] = 255 & r;
		const s = xa([i, t]);
		this.clientDownstreamWriter.write(s);
	}
	async encryptData(e, t) {
		const n = this.sessionKeys.serverIV, r = crypto.getRandomValues(new Uint8Array(8)), i = new Uint8Array([...n, ...r]), s = new Uint8Array([
			...Ua(this.sentRecordSequenceNumber),
			e,
			...Ic,
			...La(t.length)
		]), o = await crypto.subtle.encrypt({
			name: "AES-GCM",
			iv: i,
			additionalData: s,
			tagLength: 128
		}, this.sessionKeys.serverWriteKey, t);
		return ++this.sentRecordSequenceNumber, xa([r, new Uint8Array(o)]);
	}
}, Ec = class e {
	static TLSMessage(t, n) {
		switch (t) {
			case fc: return e.clientHandshake(n);
			case dc: return e.alert(n);
			case hc: return e.changeCipherSpec();
			case uc: return e.applicationData(n);
			default: throw new Error(`TLS: Unsupported TLS record type ${t}`);
		}
	}
	static parseCipherSuites(e) {
		const t = new Ra(e), n = [], r = [t.readUint16()];
		for (; !t.isFinished();) {
			const e = t.readUint16();
			r.push(e), e in Xa && n.push(Xa[e]);
		}
		return n;
	}
	static applicationData(e) {
		return {
			type: uc,
			body: e
		};
	}
	static changeCipherSpec() {
		return {
			type: hc,
			body: new Uint8Array()
		};
	}
	static alert(e) {
		return {
			type: dc,
			level: ac[e[0]],
			description: lc[e[1]]
		};
	}
	static clientHandshake(t) {
		const n = t[0], r = t[1] << 16 | t[2] << 8 | t[3], i = t.slice(4);
		let s;
		switch (n) {
			case pc:
				s = e.clientHelloRequestPayload();
				break;
			case gc:
				s = e.clientHelloPayload(i);
				break;
			case Sc:
				s = e.clientKeyExchangePayload(i);
				break;
			case bc:
				s = e.clientFinishedPayload(i);
				break;
			default: throw new Error(`Invalid handshake type ${n}`);
		}
		return {
			type: fc,
			msg_type: n,
			length: r,
			body: s
		};
	}
	static clientHelloRequestPayload() {
		return {};
	}
	static clientHelloPayload(t) {
		const n = new Ra(t.buffer), r = {
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
			const t = new Ra(e.buffer), n = [];
			for (; !t.isFinished();) {
				const r = t.offset, i = Wa[t.readUint16()], s = t.readUint16(), o = t.readUint8Array(s);
				if (!(i in nc)) continue;
				const a = nc[i];
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
function xc(e) {
	return new TransformStream({ transform(t, n) {
		for (; t.length > 0;) n.enqueue(t.slice(0, e)), t = t.slice(e);
	} });
}
var Mc = class {
	static certificate(e) {
		const t = [];
		for (const i of e) t.push(Ba(i.byteLength)), t.push(new Uint8Array(ArrayBuffer.isView(i) ? i.buffer : i));
		const n = xa(t), r = new Uint8Array([...Ba(n.byteLength), ...n]);
		return new Uint8Array([
			yc,
			...Ba(r.length),
			...r
		]);
	}
	static async ECDHEServerKeyExchange(e, t, n, r) {
		const i = new Uint8Array(await crypto.subtle.exportKey("raw", n.publicKey)), s = new Uint8Array([
			kc,
			...La(vc),
			i.byteLength,
			...i
		]), o = await crypto.subtle.sign({
			name: "RSASSA-PKCS1-v1_5",
			hash: "SHA-256"
		}, r, new Uint8Array([
			...e,
			...t,
			...s
		])), a = new Uint8Array(o), c = new Uint8Array([ec.sha256, Ja.rsa]), l = new Uint8Array([
			...s,
			...c,
			...La(a.length),
			...a
		]);
		return new Uint8Array([
			wc,
			...Ba(l.length),
			...l
		]);
	}
	static serverHello(e, t, n) {
		const r = e.extensions.map((e) => {
			switch (e.type) {
				case "server_name": return Oa.encodeForClient();
				case "ec_point_formats": return Va.encodeForClient("uncompressed");
				case "renegotiation_info": return Ga.encodeForClient();
				case "extended_master_secret": return qa.encodeForClient();
			}
		}).filter((e) => void 0 !== e);
		r.length > 0 && e.extensions.some((e) => "renegotiation_info" === e.type) || r.push(Ga.encodeForClient());
		const i = xa(r), s = new Uint8Array([
			...Ic,
			...t,
			e.session_id.length,
			...e.session_id,
			...La(ja.TLS1_CK_ECDHE_RSA_WITH_AES_128_GCM_SHA256),
			n,
			...La(i.length),
			...i
		]);
		return new Uint8Array([
			mc,
			...Ba(s.length),
			...s
		]);
	}
	static serverHelloDone() {
		return new Uint8Array([_c, ...Ba(0)]);
	}
	static async createFinishedMessage(e, t) {
		const n = await crypto.subtle.digest("SHA-256", xa(e)), r = new Uint8Array(await rc(t, new TextEncoder().encode("server finished"), n, 12));
		return new Uint8Array([
			bc,
			...Ba(r.length),
			...r
		]);
	}
	static changeCipherSpec() {
		return new Uint8Array([1]);
	}
};
function zc(e, t) {
	return Lc.generateCertificate(e, t);
}
function Tc(e) {
	return `-----BEGIN CERTIFICATE-----\n${n = e.buffer, t = btoa(String.fromCodePoint(...new Uint8Array(n))), t.match(/.{1,64}/g)?.join("\n") || t}\n-----END CERTIFICATE-----`;
	var t, n;
}
var Lc = class {
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
		return Hc.sequence([
			new Uint8Array(e.buffer),
			this.signatureAlgorithm("sha256WithRSAEncryption"),
			Hc.bitString(new Uint8Array(n))
		]);
	}
	static async signingRequest(e, t) {
		const n = [];
		return e.keyUsage && n.push(this.keyUsage(e.keyUsage)), e.extKeyUsage && n.push(this.extKeyUsage(e.extKeyUsage)), e.subjectAltNames && n.push(this.subjectAltName(e.subjectAltNames)), e.nsCertType && n.push(this.nsCertType(e.nsCertType)), e.basicConstraints && n.push(this.basicConstraints(e.basicConstraints)), Hc.sequence([
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
		return Hc.ASN1(160, Hc.integer(new Uint8Array([e])));
	}
	static serialNumber(e = crypto.getRandomValues(new Uint8Array(4))) {
		return Hc.integer(e);
	}
	static signatureAlgorithm(e = "sha256WithRSAEncryption") {
		return Hc.sequence([Hc.objectIdentifier(Uc(e)), Hc.null()]);
	}
	static async subjectPublicKeyInfo(e) {
		return new Uint8Array(await crypto.subtle.exportKey("spki", e));
	}
	static extensions(e) {
		return Hc.ASN1(163, Hc.sequence(e));
	}
	static distinguishedName(e) {
		const t = [];
		for (const [n, r] of Object.entries(e)) {
			const e = [Hc.objectIdentifier(Uc(n))];
			if ("countryName" === n) e.push(Hc.printableString(r));
			else e.push(Hc.utf8String(r));
			t.push(Hc.set([Hc.sequence(e)]));
		}
		return Hc.sequence(t);
	}
	static validity(e) {
		return Hc.sequence([Hc.ASN1(Rc.UTCTime, new TextEncoder().encode(Fc(e?.notBefore ?? /* @__PURE__ */ new Date()))), Hc.ASN1(Rc.UTCTime, new TextEncoder().encode(Fc(e?.notAfter ?? Dc(/* @__PURE__ */ new Date(), 10))))]);
	}
	static basicConstraints({ ca: e = !0, pathLenConstraint: t }) {
		const n = [Hc.boolean(e)];
		return void 0 !== t && n.push(Hc.integer(new Uint8Array([t]))), Hc.sequence([Hc.objectIdentifier(Uc("basicConstraints")), Hc.octetString(Hc.sequence(n))]);
	}
	static keyUsage(e) {
		const t = new Uint8Array([0]);
		return e?.digitalSignature && (t[0] |= 128), e?.nonRepudiation && (t[0] |= 64), e?.keyEncipherment && (t[0] |= 32), e?.dataEncipherment && (t[0] |= 16), e?.keyAgreement && (t[0] |= 8), e?.keyCertSign && (t[0] |= 4), e?.cRLSign && (t[0] |= 2), e?.encipherOnly && (t[0] |= 1), Hc.sequence([
			Hc.objectIdentifier(Uc("keyUsage")),
			Hc.boolean(!0),
			Hc.octetString(Hc.bitString(t))
		]);
	}
	static extKeyUsage(e = {}) {
		return Hc.sequence([
			Hc.objectIdentifier(Uc("extKeyUsage")),
			Hc.boolean(!0),
			Hc.octetString(Hc.sequence(Object.entries(e).map(([e, t]) => t ? Hc.objectIdentifier(Uc(e)) : Hc.null())))
		]);
	}
	static nsCertType(e) {
		const t = new Uint8Array([0]);
		return e.client && (t[0] |= 1), e.server && (t[0] |= 2), e.email && (t[0] |= 4), e.objsign && (t[0] |= 8), e.sslCA && (t[0] |= 16), e.emailCA && (t[0] |= 32), e.objCA && (t[0] |= 64), Hc.sequence([Hc.objectIdentifier(Uc("nsCertType")), Hc.octetString(t)]);
	}
	static subjectAltName(e) {
		const t = e.dnsNames?.map((e) => {
			const t = new TextEncoder().encode(e);
			return Hc.contextSpecific(2, t);
		}) || [], n = e.ipAddresses?.map((e) => {
			const t = new TextEncoder().encode(e);
			return Hc.contextSpecific(7, t);
		}) || [], r = Hc.octetString(Hc.sequence([...t, ...n]));
		return Hc.sequence([
			Hc.objectIdentifier(Uc("subjectAltName")),
			Hc.boolean(!0),
			r
		]);
	}
};
const Bc = {
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
function Uc(e) {
	for (const [t, n] of Object.entries(Bc)) if (n === e) return t;
	throw new Error(`OID not found for name: ${e}`);
}
const Rc = {
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
var Hc = class e {
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
		return e.ASN1(Rc.Integer, t);
	}
	static bitString(t) {
		const n = new Uint8Array([0]), r = new Uint8Array(n.length + t.length);
		return r.set(n), r.set(t, n.length), e.ASN1(Rc.BitString, r);
	}
	static octetString(t) {
		return e.ASN1(Rc.OctetString, t);
	}
	static null() {
		return e.ASN1(Rc.Null, new Uint8Array(0));
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
		return e.ASN1(Rc.OID, new Uint8Array(r));
	}
	static utf8String(t) {
		const n = new TextEncoder().encode(t);
		return e.ASN1(Rc.Utf8String, n);
	}
	static printableString(t) {
		const n = new TextEncoder().encode(t);
		return e.ASN1(Rc.PrintableString, n);
	}
	static sequence(t) {
		return e.ASN1(Rc.Sequence, xa(t));
	}
	static set(t) {
		return e.ASN1(Rc.Set, xa(t));
	}
	static ia5String(t) {
		const n = new TextEncoder().encode(t);
		return e.ASN1(Rc.IA5String, n);
	}
	static contextSpecific(t, n, r = !1) {
		const i = (r ? 160 : 128) | t;
		return e.ASN1(i, n);
	}
	static boolean(t) {
		return e.ASN1(Rc.Boolean, new Uint8Array([t ? 255 : 0]));
	}
};
function Fc(e) {
	return `${e.getUTCFullYear().toString().substr(2)}${Wc(e.getUTCMonth() + 1)}${Wc(e.getUTCDate())}${Wc(e.getUTCHours())}${Wc(e.getUTCMinutes())}${Wc(e.getUTCSeconds())}Z`;
}
function Wc(e) {
	return e.toString().padStart(2, "0");
}
function Dc(e, t) {
	const n = new Date(e);
	return n.setUTCFullYear(n.getUTCFullYear() + t), n;
}
function $c(e, t) {
	const n = new Uint8Array(e.length + t.length);
	return n.set(e), n.set(t, e.length), n;
}
function Oc(e) {
	for (let t = 0; t <= e.length - 4; t++) if (13 === e[t] && 10 === e[t + 1] && 13 === e[t + 2] && 10 === e[t + 3]) return t;
	return -1;
}
function Nc(e) {
	const t = e.match(/content-length:\s*(\d+)/i);
	return t ? parseInt(t[1], 10) : 0;
}
function Kc(e, t) {
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
const Vc = new Set([
	"transfer-encoding",
	"content-encoding",
	"connection",
	"keep-alive"
]);
function qc(e, t, n, r) {
	const i = new Uint8Array(r);
	let s = `HTTP/1.1 ${e} ${t}\r\n`;
	n.forEach((e, t) => {
		Vc.has(t.toLowerCase()) || "content-length" === t.toLowerCase() || (s += `${t}: ${e}\r\n`);
	}), s += `Content-Length: ${i.length}\r\n`, s += "\r\n";
	const o = new TextEncoder().encode(s), a = new Uint8Array(o.length + i.length);
	return a.set(o), a.set(i, o.length), a;
}
function Gc(e, t) {
	return t.startsWith(e) ? t : `${e}${e.endsWith("?") ? t : encodeURIComponent(t)}`;
}
var jc = class {
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
		this.corsProxyUrl = e?.corsProxyUrl?.trim() ?? "", this.dnsAliases = e?.dnsAliases ?? { "proxy.local": "https://registry.npmjs.org" }, this.createTlsConnection = e?.createTlsConnection ?? (() => new Pc());
	}
	async init() {
		this.initialized || (this.caCert = await zc({
			subject: {
				commonName: "WASM POSIX MITM CA",
				organizationName: "WASM POSIX Kernel"
			},
			basicConstraints: { ca: !0 },
			keyUsage: {
				keyCertSign: !0,
				cRLSign: !0
			}
		}), this.caKeyPair = this.caCert.keyPair, this.caCertPEM = Tc(this.caCert.certificate), this.initialized = !0);
	}
	getCACertPEM() {
		return this.caCertPEM;
	}
	getaddrinfo(e) {
		const t = function(e) {
			if (!/^[0-9.]+$/.test(e)) return null;
			if (!/^\d+(?:\.\d+){0,3}$/.test(e)) throw Ca(e);
			const t = e.split("."), n = 1 === t.length ? [32n] : 2 === t.length ? [8n, 24n] : 3 === t.length ? [
				8n,
				8n,
				16n
			] : [
				8n,
				8n,
				8n,
				8n
			];
			let r = 0n;
			for (let i = 0; i < t.length; i++) {
				const s = BigInt(t[i]), o = n[i];
				if (s > (1n << o) - 1n) throw Ca(e);
				r = r << o | s;
			}
			return new Uint8Array([
				Number(r >> 24n & 255n),
				Number(r >> 16n & 255n),
				Number(r >> 8n & 255n),
				Number(255n & r)
			]);
		}(e);
		if (t) return t;
		Pa(e, this.dnsAliases);
		const n = this.syntheticIp(e), r = this.ipKey(n);
		return this.hostnameMap.set(r, e), n;
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
		return "tls" === r.kind ? this.tlsRecv(r, t, n) : this.httpRecv(r, t, n);
	}
	close(e) {
		const t = this.connections.get(e);
		t && ("tls" === t.kind && (t.closed = !0, t.tls.close().catch(() => {})), this.connections.delete(e));
	}
	connectTls(e, t, n, r) {
		const i = this.createTlsConnection(), s = i.clientEnd.upstream.writable.getWriter(), o = i.serverEnd.downstream.writable.getWriter(), a = {
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
					e && e.length > 0 && (a.clientDownstreamBuf = $c(a.clientDownstreamBuf, e));
				}
			} catch {} finally {
				a.closed = !0;
			}
		})();
		const l = i.serverEnd.upstream.readable.getReader();
		(async () => {
			try {
				for (;;) {
					const { value: e, done: t } = await l.read();
					if (t) break;
					e && e.length > 0 && (a.plaintextBuf = $c(a.plaintextBuf, e), this.tryProcessHttpRequest(a));
				}
			} catch {}
		})(), this.startHandshake(e, a).catch((e) => {
			a.error = e, a.closed = !0;
		});
	}
	async startHandshake(e, t) {
		if (!this.caKeyPair || !this.caCert) throw new Error("CA not initialized — call init() first");
		const n = await zc({
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
	tlsRecv(e, t, n) {
		if (e.error) throw e.error;
		if (e.clientDownstreamBuf.length > 0) {
			const r = Math.min(t, e.clientDownstreamBuf.length), i = e.clientDownstreamBuf.slice(0, r);
			return 2 & n || (e.clientDownstreamBuf = e.clientDownstreamBuf.subarray(r)), i;
		}
		if (e.closed) return new Uint8Array(0);
		throw new Ea();
	}
	tryProcessHttpRequest(e) {
		if (e.httpResponsePending || e.closed) return;
		const t = Oc(e.plaintextBuf);
		if (-1 === t) return;
		const n = Nc(new TextDecoder().decode(e.plaintextBuf.subarray(0, t))), r = t + 4, i = e.plaintextBuf.length - r;
		if (n > 0 && i < n) return;
		e.httpResponsePending = !0;
		const { method: s, path: o, headers: a, body: c } = Kc(e.plaintextBuf, t), l = t + 4 + Math.max(n, 0);
		e.plaintextBuf = e.plaintextBuf.subarray(l);
		const h = `https://${a.get("host") || e.hostname}${o}`, d = this.corsProxyUrl ? Gc(this.corsProxyUrl, h) : h, f = new Headers();
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
				}), n = qc(t.status, t.statusText, t.headers, await t.arrayBuffer());
				await e.serverDownstreamWriter.write(n), await e.serverDownstreamWriter.close();
			} catch (Zi) {
				const n = `Error fetching ${d}: ${Zi}`, r = qc(502, "Bad Gateway", new Headers({ "Content-Type": "text/plain" }), new TextEncoder().encode(n).buffer);
				try {
					await e.serverDownstreamWriter.write(r), await e.serverDownstreamWriter.close();
				} catch {}
			}
			e.httpResponsePending = !1;
		})();
	}
	httpSend(e, t) {
		const n = new Uint8Array(e.sendBuf.length + t.length);
		n.set(e.sendBuf), n.set(t, e.sendBuf.length), e.sendBuf = n;
		const r = Oc(e.sendBuf);
		if (-1 === r) return t.length;
		const i = Nc(new TextDecoder().decode(e.sendBuf.subarray(0, r))), s = r + 4, o = e.sendBuf.length - s;
		if (i > 0 && o < i) return t.length;
		const { method: a, path: c, headers: l, body: h } = Kc(e.sendBuf, r), d = l.get("host"), f = 443 === e.port ? "https" : "http", u = 80 === e.port || 443 === e.port ? "" : `:${e.port}`, p = d || `${e.hostname}${u}`, g = this.dnsAliases[e.hostname], m = void 0 !== g ? `${g}${c}` : `${f}://${p}${c}`, y = this.corsProxyUrl ? Gc(this.corsProxyUrl, m) : m, w = "https://registry.npmjs.org" === g, _ = new Headers();
		for (const [b, k] of l) {
			const e = b.toLowerCase();
			"host" !== e && "connection" !== e && _.set(b, k);
		}
		const S = h && h.length > 0 ? new Uint8Array(h) : void 0;
		return e.fetchDone = !1, e.responseBuf = null, e.responseOffset = 0, e.fetchError = null, (async () => {
			try {
				const t = await fetch(y, {
					method: a,
					headers: _,
					body: S
				});
				let n = await t.arrayBuffer();
				if (w && (t.headers.get("content-type") || "").includes("json")) {
					const t = new TextDecoder().decode(n), r = t.replace(/"tarball"\s*:\s*"https:\/\/registry\.npmjs\.org/g, `"tarball":"http://${e.hostname}`);
					r !== t && (n = new TextEncoder().encode(r).buffer);
				}
				e.responseBuf = qc(t.status, t.statusText, t.headers, n), e.fetchDone = !0;
			} catch (t) {
				e.fetchError = t, e.fetchDone = !0;
			}
		})(), e.sendBuf = new Uint8Array(0), t.length;
	}
	httpRecv(e, t, n) {
		if (!e.fetchDone) throw new Ea();
		if (e.fetchError) throw e.fetchError;
		if (!e.responseBuf) return new Uint8Array(0);
		const r = e.responseBuf.length - e.responseOffset, i = Math.min(t, r);
		if (0 === i) return new Uint8Array(0);
		const s = e.responseBuf.slice(e.responseOffset, e.responseOffset + i);
		return 2 & n || (e.responseOffset += i), s;
	}
	poll(e, t) {
		const n = this.connections.get(e);
		if (!n) throw Object.assign(/* @__PURE__ */ new Error("ENOTCONN"), { errno: 107 });
		let r = 0;
		return 4 & t && ("http" === n.kind || !n.closed) && (r |= 4), "http" === n.kind ? n.fetchError ? 8 | r : (1 & t && n.responseBuf && n.responseOffset < n.responseBuf.length && (r |= 1), n.fetchDone && n.responseBuf && n.responseOffset >= n.responseBuf.length && (r |= 16), r) : n.error ? 8 | r : (1 & t && n.clientDownstreamBuf.length > 0 && (r |= 1), n.closed && 0 === n.clientDownstreamBuf.length && (r |= 16), r);
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
BigInt(Number.MAX_SAFE_INTEGER);
if (Math.max(12, 24, 16, 32, 20, 40) > 4096) throw new Error("invalid fork-save scratch-page geometry");
const Xc = [
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
function Yc(e) {
	const t = function(e) {
		return e instanceof Error ? e.stack ? `${e.message}\n${e.stack}` : e.message : String(e ?? "");
	}(e);
	if (!t) return null;
	for (const n of Xc) for (const e of n.patterns) {
		const r = e.exec(t);
		if (r) return {
			category: n.category,
			signum: n.signum,
			signalName: n.signalName,
			matched: r[0]
		};
	}
	return null;
}
function Zc(e) {
	return 128 + e;
}
function Jc(e, t = 11) {
	return Yc(e)?.signum ?? t;
}
function Qc(e) {
	const t = Yc(e);
	return t ? Zc(t.signum) : null;
}
function el(e) {
	return e >= 128 ? e - 128 & 127 : null;
}
function tl(e, t, n) {
	const r = e.memory.buffer;
	return "undefined" != typeof SharedArrayBuffer && r instanceof SharedArrayBuffer ? !Number.isSafeInteger(t) || t < 0 || t >= r.byteLength || !Number.isSafeInteger(n) || n < 0 || n >= r.byteLength ? null : new Uint8Array(r) : null;
}
var nl = class {
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
		const n = (t + 0) * an, r = (t + 1) * an, i = (t + 2) * an;
		return Gn(e, (t + 4) * an, this.ptrWidth), new Uint8Array(e.buffer, i, te).fill(0), new Uint8Array(e.buffer, n, an).fill(0), new Uint8Array(e.buffer, r, an).fill(0), new Uint8Array(e.buffer, r, Wn).fill(0), this.activeCount++, {
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
(function(e = globalThis) {
	if (void 0 !== e.setImmediate) return null;
	const t = [], n = /* @__PURE__ */ new Map();
	let r = 0, i = !1, s = !1;
	const o = new e.MessageChannel();
	function a() {
		i || s || (i = !0, o.port2.postMessage(null));
	}
	o.port1.onmessage = function() {
		i = !1, s = !0;
		const e = t.length;
		for (let i = 0; i < e && t.length > 0; i++) {
			const e = t.shift();
			if (n.delete(e.handle), !e.cancelled) try {
				e.fn(...e.args);
			} catch (r) {
				console.error("[setImmediate] callback threw:", r);
			}
		}
		s = !1, t.length > 0 && a();
	}, e.setImmediate = (e, ...i) => {
		const s = { id: ++r }, o = {
			handle: s,
			fn: e,
			args: i,
			cancelled: !1
		};
		return t.push(o), n.set(s, o), a(), s;
	}, e.clearImmediate = (e) => {
		if ("object" != typeof e || null === e) return;
		const t = n.get(e);
		void 0 !== t && (t.cancelled = !0, n.delete(t.handle));
	};
})();
const rl = 65536, il = Wn;
let sl, ol, al, cl, ll = 16384, hl = Fn, dl = [];
let fl = !1, ul = null;
const pl = [], gl = /* @__PURE__ */ new Map(), ml = /* @__PURE__ */ new Map(), yl = new class {
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
	handleRequest(e, t, n) {
		return n.seconds > 0 ? this.arm(e, t, n) : this.cancel(e, t);
	}
	arm(e, t, n) {
		if (this.currentGeneration(e) !== t) return !1;
		if (this.clear(e), !(Number.isFinite(n.seconds) && n.seconds > 0)) return !1;
		if (!tl(t, n.timedOutPtr, n.vmInterruptPtr)) return !1;
		const r = this.scheduler.now(), i = 1e3 * n.seconds, s = r + i;
		if (!Number.isFinite(r) || !Number.isFinite(i) || !Number.isFinite(s)) return !1;
		const o = {
			generation: t,
			deadlineMs: s,
			timedOutPtr: n.timedOutPtr,
			vmInterruptPtr: n.vmInterruptPtr
		};
		return this.entries.set(e, o), this.schedule(e, o), !0;
	}
	cancel(e, t) {
		return this.currentGeneration(e) === t && (this.clear(e, t), !0);
	}
	clear(e, t) {
		const n = this.entries.get(e);
		return !(!n || void 0 !== t && n.generation !== t) && (void 0 !== n.handle && (this.scheduler.clear(n.handle), n.handle = void 0), this.entries.delete(e), !0);
	}
	clearAll() {
		for (const [e] of this.entries) this.clear(e);
	}
	get activeCount() {
		return this.entries.size;
	}
	schedule(e, t) {
		if (this.entries.get(e) !== t || this.currentGeneration(e) !== t.generation) return void this.discardIfCurrent(e, t);
		const n = t.deadlineMs - this.scheduler.now();
		if (n <= 0) return void this.fire(e, t);
		const r = Math.min(2147483647, Math.max(1, Math.ceil(n))), i = this.scheduler.set(() => {
			this.entries.get(e) === t && t.handle === i && (t.handle = void 0, this.schedule(e, t));
		}, r);
		t.handle = i;
	}
	fire(e, t) {
		if (this.entries.get(e) !== t || this.currentGeneration(e) !== t.generation) return void this.discardIfCurrent(e, t);
		const n = tl(t.generation, t.timedOutPtr, t.vmInterruptPtr);
		this.entries.delete(e), t.handle = void 0, n && (Atomics.store(n, t.timedOutPtr, 1), Atomics.store(n, t.vmInterruptPtr, 1));
	}
	discardIfCurrent(e, t) {
		this.entries.get(e) === t && (void 0 !== t.handle && (this.scheduler.clear(t.handle), t.handle = void 0), this.entries.delete(e));
	}
}((e) => gl.get(e)), wl = /* @__PURE__ */ new Set(), _l = /* @__PURE__ */ new Set(), Sl = 250, bl = /* @__PURE__ */ new WeakSet();
async function kl(e, t, n = 0) {
	if (n > 4) return null;
	const r = await lh(e);
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
	if (!i) {
		if (!cn(r)) return { errno: 8 };
		let e;
		try {
			e = await WebAssembly.compile(r);
		} catch (o) {
			if (o instanceof WebAssembly.CompileError) return { errno: 8 };
			throw o;
		}
		const n = wn(r, "__abi_version");
		return null !== n && n !== sl.getKernelAbiVersion() ? { errno: 8 } : {
			programBytes: r,
			programModule: e,
			argv: t
		};
	}
	const s = [
		i.interpreter,
		...i.arg ? [i.arg] : [],
		e,
		...t.slice(1)
	];
	return kl(i.interpreter, s, n + 1);
}
const vl = /* @__PURE__ */ new Map(), Al = /* @__PURE__ */ new Map(), Il = new class {
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
function Cl(e, t, n) {
	e.pid === t && yl.handleRequest(t, n, e);
}
function Pl(e) {
	return new Promise((t) => setTimeout(t, e));
}
function El(e) {
	const t = e.lastIndexOf("/");
	return t >= 0 ? e.slice(t + 1) : e;
}
function xl(e) {
	const t = "nginx" === El(e?.[0] ?? "") ? "/var/log/nginx.log" : null;
	if (!t) return null;
	const n = function(e) {
		try {
			const t = al.open(e, 0, 0);
			try {
				const e = al.fstat(t).size;
				if (e <= 0) return al.close(t), null;
				const n = new Uint8Array(e), r = al.read(t, n, null, e);
				return al.close(t), r <= 0 ? null : n.buffer.slice(n.byteOffset, n.byteOffset + r);
			} catch {
				return al.close(t), null;
			}
		} catch {
			return null;
		}
	}(t);
	return n && 0 !== n.byteLength ? `${t}:\n${new TextDecoder("utf-8", { fatal: !1 }).decode(n).trimEnd() || "<empty>"}` : `${t}: <empty>`;
}
function Ml(e) {
	const t = gl.get(e), n = xl(t?.argv), r = sl.dumpLastSyscalls(e) || "<none>";
	return [
		`argv=${JSON.stringify(t?.argv ?? [])}`,
		n,
		`last syscalls:\n${r}`
	].filter((e) => null !== e).join("\n");
}
async function zl() {
	for (; ml.size > 0 || wl.size > 0;) await Promise.allSettled([...ml.values(), ...wl]);
}
async function Tl(e, t = 0) {
	bl.add(e);
	const n = (async () => {
		await e.terminate().catch(() => {}), t > 0 && await Pl(t);
	})();
	wl.add(n), n.finally(() => wl.delete(n)), await n;
}
async function Ll(e) {
	const t = Al.get(e);
	if (t) {
		Al.delete(e);
		for (const e of t) bl.add(e.worker);
		for (const n of t) await (n.termination ?? Tl(n.worker, Sl)), Il.release(e, n.channelOffset);
	}
}
const Bl = /* @__PURE__ */ new Map();
let Ul = null, Rl = null, Hl = null, Fl = null, Wl = 1;
const Dl = /* @__PURE__ */ new Set();
function $l(e, t) {
	globalThis.postMessage(e, t ?? []);
}
function Ol(e, t = "error") {
	"warn" === t ? console.warn(e.message) : console.error(e.message), $l({
		type: "host_diagnostic",
		...e
	});
}
function Nl() {
	$l({
		type: "http_bridge_pending",
		count: Dl.size
	});
}
function Kl() {
	0 !== Dl.size && (Dl.clear(), Nl());
}
function Vl(e) {
	return e instanceof Error ? e.stack ? `${e.message}\n${e.stack}` : e.message : String(e);
}
function ql(e) {
	if (!e || "object" != typeof e) return !1;
	const t = e.code;
	return -2 === t || "ENOENT" === t;
}
function Gl(e, t) {
	$l({
		type: "response",
		requestId: e,
		result: t
	});
}
function jl(e, t) {
	$l({
		type: "response",
		requestId: e,
		result: null,
		error: t
	});
}
function Xl(e, t) {
	"number" == typeof e.requestId && jl(e.requestId, t);
}
function Yl(e) {
	Ol({
		pid: 0,
		source: "worker protocol",
		message: `[kernel-worker] ${e}`
	});
}
function Zl(e) {
	"register_lazy_files" === e.type ? al.importLazyEntries(e.entries) : al.importLazyArchiveEntries(e.entries), function(e, t) {
		"number" == typeof e.requestId && Gl(e.requestId, t);
	}(e, !0);
}
function Jl(e) {
	const t = pl.splice(0);
	for (const n of t) Xl(n, e);
}
function Ql(e) {
	if (ul) return Xl(e, ul), void Yl(`${e.type} rejected because kernel worker init failed: ${ul}`);
	if (fl) try {
		Zl(e);
	} catch (Zi) {
		const n = Vl(Zi);
		Xl(e, n), Yl(`${e.type} failed: ${n}`);
	}
	else pl.push(e);
}
function eh(e, t, n) {
	return new nl({
		firstSlotStartPage: e.firstThreadSlotPage,
		maxPageExclusive: e.threadArenaEndPage,
		ptrWidth: t,
		reservedSlots: e.threadSlotCount,
		reserveSlotStartPage: () => sl.reserveHostRegion(n, 262144) / rl
	});
}
function th(e, t, n, r = ll, i) {
	const s = yn(t), o = qn({
		maxPages: r,
		defaultThreadSlots: hl,
		ptrWidth: n,
		programBytes: t,
		heapBase: s
	});
	let a;
	try {
		a = function(e, t) {
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
		}(n, o);
	} catch (c) {
		throw console.error("[kernel-worker] process memory allocation failed", JSON.stringify(function(e, t, n, r, i) {
			let s = 0;
			const o = Array.from(gl.entries()).sort(([e], [t]) => e - t).map(([e, t]) => {
				const n = t.memory.buffer.byteLength;
				return s += n, {
					pid: e,
					argv: t.argv.slice(0, 8),
					ptrWidth: t.ptrWidth,
					currentPages: Math.ceil(n / rl),
					maximumPages: t.layout.maximumPages,
					bufferBytes: n
				};
			});
			return {
				operation: i?.operation,
				pid: e,
				path: i?.path,
				argv: i?.argv,
				ptrWidth: t,
				heapBase: null == r ? null : r.toString(),
				requestedLayout: {
					initialPages: n.initialPages,
					maximumPages: n.maximumPages,
					controlBase: n.controlBase,
					brkBase: n.brkBase,
					mmapBase: n.mmapBase,
					maxAddr: n.maxAddr,
					threadSlotCount: n.threadSlotCount,
					threadArenaEndPage: n.threadArenaEndPage
				},
				liveProcessCount: gl.size,
				pendingProcessTeardowns: ml.size,
				pendingWorkerTeardowns: wl.size,
				totalLiveBufferBytes: s,
				liveProcesses: o
			};
		}(e, n, o, s, i))), c;
	}
	return new Uint8Array(a.buffer, o.channelOffset, te).fill(0), {
		memory: a,
		layout: o,
		threadAllocator: eh(o, n, e)
	};
}
function nh(e, t) {
	return /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("/") ? t : e.replace(/\/?$/, "/") + t;
}
async function rh(e) {
	fl = !1, ul = null, ll = e.config.maxMemoryPages, hl = e.config.defaultThreadSlots ?? Fn, dl = e.config.env;
	const t = da.fromExisting(e.shmSab), n = new ba(), r = Ia(va, e.vfsImage), i = r.find((e) => "/" === e.mountPoint);
	if (!i) throw new Error("DEFAULT_MOUNT_SPEC missing / mount");
	al = i.backend, e.lazyUrlBase && (al.rewriteLazyFileUrls((t) => nh(e.lazyUrlBase, t)), al.rewriteLazyArchiveUrls((t) => nh(e.lazyUrlBase, t))), void 0 !== e.closedLazyAssets && al.setLazyFetcher(ua(e.closedLazyAssets));
	const s = [
		{
			mountPoint: "/dev/shm",
			backend: t
		},
		{
			mountPoint: "/dev",
			backend: n
		},
		...r
	];
	al.subscribeLazyDownloads((e) => {
		$l({
			type: "lazy_download",
			event: e
		});
	}), cl = new Di(s, new ka());
	const o = new jc({
		dnsAliases: e.config.dnsAliases,
		corsProxyUrl: e.config.corsProxyUrl
	});
	await o.init(), cl.network = o;
	const a = o.getCACertPEM();
	try {
		for (const n of [
			"/etc",
			"/etc/ssl",
			"/etc/ssl/certs"
		]) try {
			al.mkdir(n, 493);
		} catch {}
		const e = new TextEncoder().encode(a), t = al.open("/etc/ssl/certs/ca-certificates.crt", 577, 420);
		al.write(t, e, 0, e.length), al.close(t);
	} catch (d) {
		console.error("[kernel-worker] Failed to write CA cert to VFS:", d);
	}
	ol = new Ui(e.workerEntryUrl), sl = new Bi({
		maxWorkers: e.config.maxWorkers,
		dataBufferSize: rl,
		useSharedMemory: !0,
		defaultThreadSlots: hl,
		enableSyscallLog: e.config.enableSyscallLog,
		syscallLogPtrWidth: e.config.syscallLogPtrWidth
	}, cl, {
		onFork: (e, t, n, r) => ($l({
			type: "proc_event",
			kind: "spawn",
			pid: t,
			ppid: e
		}), async function(e, t, n, r) {
			const i = gl.get(e);
			if (!i || i.memory !== n) throw new Error(`Unknown parent generation for pid ${e}`);
			await zl(), i.programModule || (i.programModule = await WebAssembly.compile(i.programBytes));
			if (!sl.shouldLaunchPendingChild(t)) return [];
			const s = new Uint8Array(n.buffer), o = Math.ceil(s.byteLength / rl), a = i.ptrWidth, c = i.layout, l = function(e, t, n) {
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
			new Uint8Array(l.buffer, h, te).fill(0), sl.registerProcess(t, l, [h], {
				skipKernelCreate: !0,
				ptrWidth: a,
				maxAddr: c.maxAddr,
				mmapBase: c.mmapBase
			}), sl.inheritProcessSharedMappings(e, t);
			const d = r ? {
				fnPtr: r.fnPtr,
				argPtr: r.argPtr,
				forkBufAddr: r.forkBufAddr
			} : i.forkReplayContext, f = d?.forkBufAddr ?? h - il, u = {
				type: "centralized_init",
				pid: t,
				ppid: e,
				programBytes: i.programBytes,
				programModule: i.programModule,
				memory: l,
				channelOffset: h,
				isForkChild: !0,
				forkBufAddr: f,
				forkChildThreadFnPtr: d?.fnPtr,
				forkChildThreadArgPtr: d?.argPtr,
				ptrWidth: a,
				kernelAbiVersion: sl.getKernelAbiVersion()
			}, p = new Hi(() => ol.createWorker(u));
			gl.set(t, {
				memory: l,
				programBytes: i.programBytes,
				programModule: i.programModule,
				worker: p,
				argv: i.argv,
				channelOffset: h,
				ptrWidth: a,
				layout: c,
				threadAllocator: eh(c, a, t),
				forkReplayContext: d
			}), ih(p, t);
			try {
				if ("stale" === sl.startProcessWorkerWhenRunnable(t, l, () => {
					p.start();
				}, () => {
					p.terminate();
				})) throw new Error(`Fork child ${t} changed generation before Worker launch`);
			} catch (g) {
				throw gl.get(t)?.worker === p && (gl.delete(t), vl.delete(t), Bl.delete(t), yl.clear(t)), p.terminate(), g;
			}
			return [h];
		}(e, t, n, r)),
		onExec: async (e, t, n, r, i) => {
			const s = gl.get(e)?.worker, o = await async function(e, t, n, r, i) {
				const s = gl.get(e);
				if (!s) return -3;
				if (!sl.supportsExecMetadataReplacement()) return -38;
				const o = await kl(t, n);
				if (!o) return -2;
				if ("errno" in o) return -o.errno;
				const { programBytes: a, programModule: c, argv: l } = o, h = _n(a), d = sl.validateExecMetadata(l, r, s.ptrWidth);
				if (d < 0) return d;
				let f;
				try {
					f = th(e, a, h, ll, {
						operation: "exec",
						path: t,
						argv: l
					});
				} catch {
					return -12;
				}
				if (gl.get(e) !== s || sl.isExecHandoffActive(e) || !sl.isProcessExecutionActive(e)) return -3;
				const u = sl.kernelExecPrepare(e, i);
				if (u < 0) return u;
				const p = sl.prepareAddressSpaceForExec(e);
				if (p < 0) return p;
				let g;
				try {
					const n = sl.kernelExecSetup(e, i);
					if (n < 0) return n;
					if (yl.clear(e), s.worker && bl.add(s.worker), _l.delete(e), sl.prepareProcessForExec(e), sl.finalizeAddressSpaceForExec(e) < 0) throw new Error("failed to detach the discarded address space");
					if (await Ll(e), s.worker && await s.worker.terminate().catch(() => {}), sl.finalizeExecHandoffTermination(e) > 0) return 0;
					{
						const n = globalThis;
						n.__pidMap || (n.__pidMap = /* @__PURE__ */ new Map()), n.__pidMap.set(e, t);
					}
					const { memory: o, layout: d, threadAllocator: u } = f, p = d.channelOffset, m = {
						type: "centralized_init",
						pid: e,
						ppid: 0,
						programBytes: a,
						programModule: c,
						memory: o,
						channelOffset: p,
						argv: l,
						env: r,
						ptrWidth: h,
						kernelAbiVersion: sl.getKernelAbiVersion()
					};
					sl.registerProcess(e, o, [p], {
						skipKernelCreate: !0,
						ptrWidth: h,
						metadataPtrWidth: s.ptrWidth,
						brkBase: d.brkBase,
						mmapBase: d.mmapBase,
						maxAddr: d.maxAddr,
						argv: l,
						env: r
					}), g = new Hi(() => ol.createWorker(m)), vl.delete(e), gl.set(e, {
						memory: o,
						programBytes: a,
						programModule: c,
						worker: g,
						argv: l,
						channelOffset: p,
						ptrWidth: h,
						layout: d,
						threadAllocator: u
					}), ih(g, e);
					const y = sl.startProcessWorkerWhenRunnable(e, o, () => {
						g.start();
					}, () => {
						g?.terminate();
					});
					if ("stale" === y) throw new Error(`Exec pid ${e} changed generation before Worker launch`);
					return "dead" === y ? (sl.finishProcessExecHandoff(e), sl.finalizeExecHandoffTermination(e), 0) : (sl.finishProcessExecHandoff(e), 0);
				} catch (Zi) {
					s.worker && bl.add(s.worker), _l.delete(e);
					try {
						sl.prepareProcessForExec(e);
					} catch {}
					g && gl.get(e)?.worker !== g && await Tl(g);
					const n = Zi instanceof Error ? Zi.message : String(Zi);
					try {
						Ol({
							pid: e,
							status: Zc(11),
							source: "exec post-commit transition",
							message: `[exec] post-commit transition failed: ${n}`
						});
					} catch {}
					try {
						sl.notifyHostProcessCrashed(e, 11);
					} catch {}
					try {
						ah(e, Zc(11), 11);
					} catch {
						try {
							sl.deactivateProcess(e);
						} catch {}
					}
					return 0;
				}
			}(e, t, n, r, i), a = gl.get(e)?.worker;
			return 0 === o && a && a !== s && sl.isProcessExecutionActive(e) && $l({
				type: "proc_event",
				kind: "exec",
				pid: e
			}), o;
		},
		onResolveSpawn: sh,
		onSpawn: oh,
		onClone: (e, t, n, r, i, s, o, a) => async function(e, t, n, r, i, s, o, a) {
			const c = gl.get(e);
			if (!c) throw new Error(`Unknown pid ${e} for clone`);
			_l.add(e);
			let l, h = vl.get(e), f = !1;
			if (!h) {
				const e = function(e) {
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
					const y = m.reduce((e, t) => e + t.length, 0), w = new Uint8Array(y);
					let _ = 0;
					for (const S of m) w.set(S, _), _ += S.length;
					return w.buffer;
				}(c.programBytes);
				h = await WebAssembly.compile(e), f = !0;
			}
			if (!jn(gl, e, c, a, sl.isExecHandoffActive(e)) || !sl.isProcessExecutionActive(e)) throw new Error(`Process ${e} changed generation during clone`);
			f && vl.set(e, h);
			try {
				l = c.threadAllocator.allocate(a);
			} catch (d) {
				throw Ol({
					pid: e,
					source: "clone allocation",
					message: `[kernel-worker] pid=${e}: ${d instanceof Error ? d.message : String(d)}`
				}), d;
			}
			try {
				sl.addChannel(e, l.channelOffset, t, n, r, a);
			} catch (Zi) {
				throw c.threadAllocator.free(l.basePage), Zi;
			}
			const u = {
				type: "centralized_thread_init",
				pid: e,
				tid: t,
				programBytes: c.programBytes,
				programModule: h,
				memory: a,
				processChannelOffset: c.channelOffset,
				channelOffset: l.channelOffset,
				fnPtr: n,
				argPtr: r,
				stackPtr: i,
				tlsPtr: s,
				ctidPtr: o,
				tlsOffset: l.tlsOffset,
				tlsAllocAddr: l.tlsAllocAddr,
				ptrWidth: c.ptrWidth,
				kernelAbiVersion: sl.getKernelAbiVersion()
			}, p = new Hi(() => ol.createWorker(u));
			Al.has(e) || Al.set(e, []);
			const g = {
				worker: p,
				channelOffset: l.channelOffset,
				tid: t,
				basePage: l.slotStartPage
			};
			Al.get(e).push(g);
			const m = () => jn(gl, e, c, a, sl.isExecHandoffActive(e));
			let y = !1;
			const w = () => {
				y || (y = !0, c.threadAllocator.free(l.basePage), m() && Il.release(e, l.channelOffset), function(e, t, n) {
					const r = e.get(t);
					if (!r) return !1;
					const i = r.indexOf(n);
					i < 0 || (r.splice(i, 1), 0 === r.length && e.delete(t));
				}(Al, e, g));
			}, _ = () => (g.termination || (g.termination = Tl(p, Sl).finally(w)), g.termination);
			Il.register(e, l.channelOffset, _);
			const S = () => !bl.has(p) && m(), b = (n) => {
				if (!S()) return void _();
				const r = function(e) {
					const t = Qc(e);
					return null === t ? { kind: "host-thread-failure" } : {
						kind: "guest-fatal-trap",
						exitStatus: t,
						signum: el(t) ?? 11
					};
				}(n);
				Ol({
					pid: e,
					status: "guest-fatal-trap" === r.kind ? r.exitStatus : void 0,
					source: "thread worker failure",
					message: `[kernel-worker] pid=${e} tid=${t}: ${n}`
				}), sl.finalizeThreadExit(e, t, l.channelOffset), _(), "guest-fatal-trap" === r.kind && ah(e, r.exitStatus, r.signum);
			};
			let k;
			p.on("message", (t) => {
				const n = t;
				if ("thread_exit" === n.type) {
					if (!S()) return void _();
					_();
				} else if ("error" === n.type) b(n.message ?? "thread error");
				else if ("vm_interrupt_timer" === n.type) {
					if (!S() || n.pid !== e) return;
					Cl(n, e, c);
				}
			}), p.on("error", (e) => {
				b(`worker error: ${e.message ?? e}`);
			});
			try {
				k = sl.startProcessWorkerWhenRunnable(e, a, () => {
					p.start();
				}, () => {
					p.terminate();
				}, () => {
					sl.finalizeThreadExit(e, t, l.channelOffset);
					const n = sl.failDeferredCloneLaunch(e, t, 12);
					return _(), n;
				});
			} catch (v) {
				throw sl.finalizeThreadExit(e, t, l.channelOffset), _(), v;
			}
			if ("stale" === k) throw _(), /* @__PURE__ */ new Error(`Process ${e} changed generation before thread Worker launch`);
			return t;
		}(e, t, n, r, i, s, o, a),
		onThreadExit: (e, t, n) => function(e, t) {
			return Il.requestExit(e, t);
		}(e, n),
		onExit: (e, t) => ah(e, t)
	}), sl.usePolling = !1, sl.relistenBatchSize = 1;
	const c = sl, l = c.kernel.callbacks || {};
	c.kernel.callbacks = {
		...l,
		onStdout: (e) => $l({
			type: "stdout",
			pid: c.currentHandlePid || 0,
			data: e
		}),
		onStderr: (e) => $l({
			type: "stderr",
			pid: c.currentHandlePid || 0,
			data: e
		}),
		onNetListen: (e, t, n) => {
			const r = c.currentHandlePid;
			return 0 !== r && c.startTcpListener(r, e, t, n), $l({
				type: "listen_tcp",
				pid: r,
				fd: e,
				port: t
			}), 0;
		}
	}, await sl.init(e.kernelWasmBytes), Ul = c.kernelInstance, Rl = c.kernelMemory, sl.framebuffers.onChange((e, t) => {
		if ("bind" === t) {
			const t = sl.framebuffers.get(e), n = sl.getProcessMemory(e);
			if (!t || !n) return;
			$l({
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
		} else $l({
			type: "fb_unbind",
			pid: e
		});
	});
	const h = sl.framebuffers.rebindMemory.bind(sl.framebuffers);
	sl.framebuffers.rebindMemory = (e) => {
		if (h(e), !sl.framebuffers.get(e)) return;
		const t = sl.getProcessMemory(e);
		t && $l({
			type: "fb_rebind_memory",
			pid: e,
			memory: t
		});
	}, sl.framebuffers.onWrite((e, t, n) => {
		const r = n.buffer.slice(n.byteOffset, n.byteOffset + n.byteLength);
		$l({
			type: "fb_write",
			pid: e,
			offset: t,
			bytes: new Uint8Array(r)
		}, [r]);
	}), e.bridgePort && (Hl = e.bridgePort, Kl()), fl = !0, function() {
		const e = pl.splice(0);
		for (const t of e) Zl(t);
	}(), $l({ type: "ready" });
}
function ih(e, t) {
	let n = !1;
	const r = (r, i, s) => {
		if (!n && !bl.has(e) && gl.get(t)?.worker === e) {
			n = !0;
			try {
				void 0 !== s && Ol({
					pid: t,
					status: r,
					source: s.source,
					message: `${s.message}\n${Ml(t)}`
				});
			} finally {
				ah(t, r, i, e);
			}
		}
	};
	e.on("error", (n) => {
		if (bl.has(e)) return;
		const i = Jc(n);
		r(Zc(i), i, {
			source: "worker.onerror",
			message: `[kernel-worker] worker error pid=${t}: ${n.message}`
		});
	}), e.on("exit", (i) => {
		bl.has(e) || n || r(Zc(11), 11, {
			source: "worker exit event",
			message: `[process-worker] pid=${t} crashed (worker exit code=${i}, no exit message from wasm)`
		});
	}), e.on("message", (n) => {
		if (bl.has(e)) return;
		const i = gl.get(t);
		if (!i || i.worker !== e) return;
		const s = n;
		if ("error" === s.type) {
			const e = Jc(s.message);
			r(Qc(s.message) ?? -1, e, {
				source: "worker-main error message",
				message: `[process-worker] ${s.message ?? "unknown error"}`
			});
		} else "exit" === s.type ? r(s.status ?? 0) : "vm_interrupt_timer" === s.type && Cl(s, t, i);
	});
}
async function sh(e, t) {
	return kl(e, t);
}
async function oh(e, t, n, r) {
	if (await zl(), !sl.shouldLaunchPendingChild(t)) return 0;
	$l({
		type: "proc_event",
		kind: "spawn",
		pid: t,
		ppid: e
	});
	const { programBytes: i, programModule: s, argv: o } = n, a = _n(i), { memory: c, layout: l, threadAllocator: h } = th(t, i, a, ll, {
		operation: "posix_spawn",
		path: o[0],
		argv: o
	}), d = l.channelOffset;
	sl.registerProcess(t, c, [d], {
		skipKernelCreate: !0,
		ptrWidth: a,
		brkBase: l.brkBase,
		mmapBase: l.mmapBase,
		maxAddr: l.maxAddr
	});
	const f = {
		type: "centralized_init",
		pid: t,
		ppid: e,
		programBytes: i,
		programModule: s,
		memory: c,
		channelOffset: d,
		argv: o,
		env: r,
		ptrWidth: a,
		kernelAbiVersion: sl.getKernelAbiVersion()
	}, u = new Hi(() => ol.createWorker(f));
	gl.set(t, {
		memory: c,
		programBytes: i,
		programModule: s,
		worker: u,
		argv: o,
		channelOffset: d,
		ptrWidth: a,
		layout: l,
		threadAllocator: h
	}), ih(u, t);
	try {
		if ("stale" === sl.startProcessWorkerWhenRunnable(t, c, () => {
			u.start();
		}, () => {
			u.terminate();
		})) throw new Error(`Spawn child ${t} changed generation before Worker launch`);
	} catch (p) {
		throw gl.get(t)?.worker === u && (gl.delete(t), vl.delete(t), Bl.delete(t), yl.clear(t)), u.terminate(), p;
	}
	return 0;
}
function ah(e, t, n, r = gl.get(e)?.worker) {
	(async function(e, t, n = function(e) {
		return e >= 128 ? e - 128 & 127 : null;
	}(t) ?? 11, r = gl.get(e)?.worker) {
		if (!r) return;
		const i = gl.get(e);
		if (!i || i.worker !== r) return;
		if (ml.has(r)) return;
		yl.clear(e);
		const s = _l.has(e) ? Sl : 0, o = Math.max(s, function(e) {
			const t = El(e?.[0] ?? "");
			return "node" === t || "spidermonkey-node" === t || "spidermonkey-node.wasm" === t ? 2e3 : 0;
		}(i?.argv));
		_l.delete(e);
		const a = (async () => {
			try {
				sl.notifyHostProcessCrashed(e, n);
			} catch {}
			await Ll(e), await Tl(r, o), gl.get(e)?.worker === r && (sl.deactivateProcess(e), gl.delete(e), vl.delete(e), Bl.delete(e));
		})();
		ml.set(r, a), $l({
			type: "exit",
			pid: e,
			status: t
		});
		try {
			await a;
		} finally {
			ml.delete(r);
		}
	})(e, t, n, r);
}
async function ch(e, t) {
	if (!Ul || !Hl) return;
	const n = Hl, r = function() {
		const e = Wl++;
		return Dl.add(e), Nl(), e;
	}(), i = t.url || "?";
	try {
		let r = Fl;
		if (null == r && (r = Array.from(sl.tcpListenerTargets?.keys() ?? [])[0] ?? null), null == r) return console.warn(`[bridge] no listener target for req#${e} ${i}`), void n.postMessage({
			type: "http-error",
			requestId: e,
			error: "No listener target available"
		});
		console.debug(`[bridge] req#${e} ${t.method} ${i} -> port=${r}`);
		const s = await sl.sendHttpRequest(r, {
			method: t.method,
			url: i,
			headers: t.headers ?? {},
			body: t.body ?? null
		}, { debugLabel: `req#${e}` });
		n.postMessage({
			type: "http-response",
			requestId: e,
			status: s.status,
			headers: s.headers,
			body: s.body
		});
	} catch (s) {
		console.warn(`[bridge] req#${e} ${i} failed:`, s), n.postMessage({
			type: "http-error",
			requestId: e,
			error: s instanceof Error ? s.message : String(s)
		});
	} finally {
		(function(e) {
			Dl.delete(e) && Nl();
		})(r);
	}
}
async function lh(e) {
	try {
		const { data: t } = await $i(cl, e);
		return t.buffer.slice(t.byteOffset, t.byteOffset + t.byteLength);
	} catch (t) {
		if (ql(t)) return null;
		throw t;
	}
}
globalThis.onmessage = (e) => {
	const t = e.data;
	switch (t.type) {
		case "init":
			rh(t).catch((e) => {
				const t = Vl(e);
				fl = !1, ul = t, Jl(t), console.error("[kernel-worker] init failed:", e), $l({
					type: "init_error",
					error: t
				});
			});
			break;
		case "spawn":
			(async function(t) {
				let n;
				try {
					let e;
					if (await zl(), t.programBytes) e = t.programBytes;
					else {
						if (!t.programPath) return void jl(t.requestId, "No programBytes or programPath");
						{
							const n = await lh(t.programPath);
							if (!n) return void jl(t.requestId, `ENOENT: ${t.programPath}`);
							e = n;
						}
					}
					if (!cn(e)) return void jl(t.requestId, "ENOEXEC: program is not a WebAssembly module");
					const r = sl.allocateTopLevelSpawnPid(), i = t.programPath ?? t.argv[0], s = t.maxPages ?? ll, o = _n(e), { memory: a, layout: c, threadAllocator: l } = th(r, e, o, s, {
						operation: "spawn",
						path: i,
						argv: t.argv
					}), h = c.channelOffset, d = t.env ?? dl;
					if (sl.registerProcess(r, a, [h], {
						ptrWidth: o,
						argv: t.argv,
						env: d,
						brkBase: c.brkBase,
						mmapBase: c.mmapBase,
						maxAddr: c.maxAddr,
						stdio: t.pty ? Ti : zi
					}), n = r, sl.setCredentials(r, {
						uid: t.uid,
						gid: t.gid
					}), t.cwd && sl.setCwd(r, t.cwd), t.pty) {
						const e = sl.setupPty(r);
						Bl.set(r, e), null != t.ptyCols && null != t.ptyRows && sl.ptySetWinsize(e, t.ptyRows, t.ptyCols);
					} else if (t.stdin) {
						const e = t.stdin instanceof Uint8Array ? t.stdin : new Uint8Array(t.stdin);
						sl.setStdinData(r, e);
					}
					const f = {
						type: "centralized_init",
						pid: r,
						ppid: 0,
						programBytes: e,
						memory: a,
						channelOffset: h,
						env: d,
						argv: t.argv,
						cwd: t.cwd,
						ptrWidth: o,
						kernelAbiVersion: sl.getKernelAbiVersion()
					}, u = ol.createWorker(f);
					gl.set(r, {
						memory: a,
						programBytes: e,
						worker: u,
						argv: t.argv,
						channelOffset: h,
						ptrWidth: o,
						layout: c,
						threadAllocator: l
					}), ih(u, r), n = void 0, Gl(t.requestId, r);
				} catch (e) {
					void 0 !== n && sl.unregisterProcess(n), jl(t.requestId, String(e));
				}
			})(t);
			break;
		case "terminate_process":
			(async function(e) {
				const t = e.pid;
				yl.clear(t);
				const n = Al.get(t);
				if (n) {
					for (const e of n) {
						await (e.termination ?? Tl(e.worker, Sl));
						try {
							sl.notifyThreadExit(t, e.tid), sl.removeChannel(t, e.channelOffset);
						} catch {}
					}
					Al.delete(t);
				}
				const r = gl.get(t);
				r?.worker && await Tl(r.worker);
				try {
					sl.unregisterProcess(t);
				} catch {}
				gl.delete(t), vl.delete(t), _l.delete(t), Bl.delete(t), Gl(e.requestId, !0);
			})(t);
			break;
		case "read_vfs_file":
			(async function(e) {
				if (cl) try {
					const { data: t, stat: n } = await $i(cl, e.path), r = t.slice();
					Gl(e.requestId, e.includeMode ? {
						data: r,
						mode: 4095 & n.mode
					} : r);
				} catch (t) {
					ql(t) ? Gl(e.requestId, null) : jl(e.requestId, Vl(t));
				}
				else Gl(e.requestId, null);
			})(t);
			break;
		case "write_vfs_file":
			(function(e) {
				if (!cl) return void jl(e.requestId, "VFS is not initialized");
				let t = null;
				try {
					t = cl.open(e.path, 577, 4095 & e.mode);
					let n = 0;
					for (; n < e.data.byteLength;) {
						const r = cl.write(t, e.data.subarray(n), null, e.data.byteLength - n);
						if (r <= 0) throw new Error(`Short write while staging ${e.path}`);
						n += r;
					}
					cl.close(t), t = null, cl.chmod(e.path, 4095 & e.mode), Gl(e.requestId, !0);
				} catch (Zi) {
					if (null !== t) try {
						cl.close(t);
					} catch {}
					jl(e.requestId, Vl(Zi));
				}
			})(t);
			break;
		case "unlink_vfs_file":
			(function(e) {
				if (cl) try {
					try {
						cl.lstat(e.path);
					} catch {
						Gl(e.requestId, !1);
						return;
					}
					cl.unlink(e.path), Gl(e.requestId, !0);
				} catch (Zi) {
					jl(e.requestId, Vl(Zi));
				}
				else jl(e.requestId, "VFS is not initialized");
			})(t);
			break;
		case "append_stdin_data":
			sl.appendStdinData(t.pid, t.data);
			break;
		case "set_stdin_data":
			sl.setStdinData(t.pid, t.data);
			break;
		case "pty_write":
			(function(e) {
				const t = Bl.get(e.pid);
				void 0 !== t && sl.ptyMasterWrite(t, e.data);
			})(t);
			break;
		case "pty_resize":
			(function(e) {
				const t = Bl.get(e.pid);
				void 0 !== t && sl.ptySetWinsize(t, e.rows, e.cols);
			})(t);
			break;
		case "register_pty_output":
			(function(e) {
				const t = Bl.get(e.pid);
				void 0 !== t && sl.onPtyOutput(t, (t) => {
					$l({
						type: "pty_output",
						pid: e.pid,
						data: t
					});
				});
			})(t);
			break;
		case "inject_connection":
			(function(e) {
				if (!Ul) return void Gl(e.requestId, -1);
				const t = (0, Ul.exports.kernel_inject_connection)(e.pid, e.fd, e.peerAddr[0], e.peerAddr[1], e.peerAddr[2], e.peerAddr[3], e.peerPort);
				t >= 0 && sl.scheduleWakeBlockedRetries(), Gl(e.requestId, t);
			})(t);
			break;
		case "pipe_read":
			(function(e) {
				if (!Ul) return void Gl(e.requestId, null);
				const t = Ul.exports.kernel_pipe_read, n = sl.tcpScratchOffset || sl.scratchOffset, r = [];
				for (;;) {
					const i = t(e.pid, e.pipeIdx, sl.toKernelPtr(n), rl);
					if (i <= 0) break;
					const s = new Uint8Array(Rl.buffer);
					r.push(s.slice(n, n + i));
				}
				if (0 === r.length) return void Gl(e.requestId, null);
				const i = r.reduce((e, t) => e + t.length, 0), s = new Uint8Array(i);
				let o = 0;
				for (const a of r) s.set(a, o), o += a.length;
				Gl(e.requestId, s);
			})(t);
			break;
		case "pipe_write":
			(function(e) {
				if (!Ul) return void Gl(e.requestId, -1);
				const t = Ul.exports.kernel_pipe_write, n = sl.tcpScratchOffset || sl.scratchOffset;
				let r = 0;
				const i = e.data;
				for (; r < i.length;) {
					const s = Math.min(i.length - r, rl);
					new Uint8Array(Rl.buffer).set(i.subarray(r, r + s), n);
					const o = t(e.pid, e.pipeIdx, sl.toKernelPtr(n), s);
					if (o <= 0) break;
					r += o;
				}
				sl.notifyPipeReadable(e.pipeIdx), Gl(e.requestId, r);
			})(t);
			break;
		case "pipe_close_read":
			(function(e) {
				if (!Ul) return;
				(0, Ul.exports.kernel_pipe_close_read)(e.pid, e.pipeIdx);
			})(t);
			break;
		case "pipe_close_write":
			(function(e) {
				if (!Ul) return;
				(0, Ul.exports.kernel_pipe_close_write)(e.pid, e.pipeIdx);
			})(t);
			break;
		case "pipe_is_write_open":
			(function(e) {
				if (!Ul) return void Gl(e.requestId, !1);
				const t = Ul.exports.kernel_pipe_is_write_open;
				Gl(e.requestId, 1 === t(e.pid, e.pipeIdx));
			})(t);
			break;
		case "wake_blocked_readers":
			(function(e) {
				const t = sl, n = t.pendingPipeReaders?.get(e.pipeIdx);
				if (n && n.length > 0) {
					t.pendingPipeReaders.delete(e.pipeIdx);
					for (const e of n) t.processes.has(e.pid) && t.retrySyscall(e.channel);
				}
				t.scheduleWakeBlockedRetries();
			})(t);
			break;
		case "wake_blocked_writers":
			(function(e) {
				const t = sl, n = t.pendingPipeWriters?.get(e.pipeIdx);
				if (n && n.length > 0) {
					t.pendingPipeWriters.delete(e.pipeIdx);
					for (const e of n) t.processes.has(e.pid) && t.retrySyscall(e.channel);
				}
				t.scheduleWakeBlockedRetries();
			})(t);
			break;
		case "is_stdin_consumed":
			(function(e) {
				const t = sl;
				Gl(e.requestId, t.stdinFinite.has(e.pid) && !t.stdinBuffers.has(e.pid));
			})(t);
			break;
		case "pick_listener_target":
			(function(e) {
				const t = sl.pickListenerTarget(e.port);
				Gl(e.requestId, t);
			})(t);
			break;
		case "http_request":
			(async function(t) {
				if (Ul) try {
					const e = await sl.sendHttpRequest(t.port, t.request, { timeoutMs: t.timeoutMs });
					Gl(t.requestId, e);
				} catch (e) {
					jl(t.requestId, e instanceof Error ? e.message : String(e));
				}
				else jl(t.requestId, "Kernel not initialized");
			})(t);
			break;
		case "destroy":
			(async function(t) {
				let n = /* @__PURE__ */ new Set();
				try {
					n = sl.killAllBlockedForTeardown();
				} catch (e) {
					console.error(`[kernel-worker] killAllBlockedForTeardown failed: ${e}`);
				}
				const r = Date.now() + 1500, i = () => {
					for (const e of n) if (gl.has(e)) return !0;
					return !1;
				};
				for (; i() && Date.now() < r;) await Pl(15);
				i() && console.warn("[kernel-worker] destroy drain timed out with woken process(es) still live; force-terminating");
				for (const [e, s] of gl) {
					s.worker && (await Ll(e), await Tl(s.worker));
					try {
						sl.unregisterProcess(e);
					} catch {}
				}
				for (const e of Al.values()) for (const t of e) await (t.termination ?? Tl(t.worker, Sl));
				yl.clearAll(), gl.clear(), vl.clear(), Al.clear(), _l.clear(), Bl.clear(), await zl(), fl = !1, ul = "kernel worker destroyed", Jl(ul), Gl(t.requestId, !0);
			})(t);
			break;
		case "register_lazy_files":
		case "register_lazy_archives":
			Ql(t);
			break;
		case "get_fork_count":
			try {
				const e = sl.getForkCount(t.pid);
				Gl(t.requestId, e);
			} catch (Zi) {
				jl(t.requestId, Zi?.message ?? String(Zi));
			}
			break;
		case "get_kernel_memory_pages":
			try {
				Gl(t.requestId, sl.getKernelMemoryPages());
			} catch (Zi) {
				jl(t.requestId, Zi?.message ?? String(Zi));
			}
			break;
		case "mouse_inject":
			(function(e) {
				sl.injectMouseEvent(e.dx, e.dy, e.buttons);
			})(t);
			break;
		case "audio_drain":
			(function(e) {
				const t = Math.min(e.maxBytes, 65536), n = new Uint8Array(t), r = sl.drainAudio(n), i = sl.audioSampleRate(), s = sl.audioChannels(), o = r > 0 ? n.slice(0, r) : new Uint8Array(0);
				$l({
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
				Gl(t.requestId, sl.enumProcs());
			} catch (Zi) {
				jl(t.requestId, Zi?.message ?? String(Zi));
			}
			break;
		case "read_proc_maps":
			try {
				Gl(t.requestId, sl.readProcMaps(t.pid));
			} catch (Zi) {
				jl(t.requestId, Zi?.message ?? String(Zi));
			}
			break;
		case "set_syscall_trace":
			t.enabled ? sl.enableSyscallTrace() : sl.disableSyscallTrace();
			break;
		case "drain_syscall_trace":
			try {
				Gl(t.requestId, sl.drainSyscallTrace());
			} catch (Zi) {
				jl(t.requestId, Zi?.message ?? String(Zi));
			}
			break;
		case "kms_attach_canvas":
			sl.attachKmsCanvas(t.crtcId, t.canvas, t.stats, t.opts);
			break;
		case "kms_attach_stats":
			sl.attachKmsStats(t.crtcId, t.stats);
			break;
		default: {
			const t = e.data;
			if ("sysprof_start" === t?.type) globalThis.__sysprof = !0, globalThis.__sysprofTable = /* @__PURE__ */ new Map(), globalThis.__sysprofStartedAt = performance.now(), $l({
				type: "stdout",
				pid: 0,
				data: new TextEncoder().encode("[sysprof] started\n")
			});
			else if ("pid_map_dump" === t?.type) {
				const e = globalThis.__pidMap, t = ["[pid-map] (pid → exec'd path)\n"];
				if (e) for (const [n, r] of [...e.entries()].sort((e, t) => e[0] - t[0])) t.push(`  pid=${n} ${r}\n`);
				$l({
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
				$l({
					type: "stdout",
					pid: 0,
					data: new TextEncoder().encode(s)
				}), globalThis.__sysprof = !1;
			} else "set_bridge_port" === t?.type && t.bridgePort ? (Hl = t.bridgePort, Kl(), "number" == typeof t.httpPort && (Fl = t.httpPort), Hl && (Hl.onmessage = (e) => {
				const t = e.data;
				"http-request" === t?.type && ch(t.requestId, t);
			})) : Ol({
				pid: 0,
				source: "worker protocol",
				message: `[kernel-worker] unknown main-thread message type: ${String(t?.type)}`
			}, "warn");
		}
	}
};
