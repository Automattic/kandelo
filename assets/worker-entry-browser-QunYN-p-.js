const e = [
	75,
	76,
	67,
	70
], t = [{
	bytes: 4,
	chunkHeaderSize: 32,
	nodeHeaderSize: 24
}, {
	bytes: 8,
	chunkHeaderSize: 56,
	nodeHeaderSize: 32
}], r = [
	{
		module: "env",
		name: "__wpk_fork_frame_commit",
		params: ["ptr"],
		results: []
	},
	{
		module: "env",
		name: "__wpk_fork_frame_next",
		params: ["ptr"],
		results: ["ptr"]
	},
	{
		module: "env",
		name: "__wpk_fork_frame_reserve",
		params: ["ptr"],
		results: ["ptr"]
	}
], n = [
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
], o = 212, i = 34, s = 46, a = 47, l = 201, c = 65536;
function f(e, t) {
	let r = 0, n = 0, o = t;
	for (;;) {
		const t = e[o++];
		if (r |= (127 & t) << n, !(128 & t)) break;
		n += 7;
	}
	return [r, o - t];
}
function d(e, t) {
	let r = 0, n = 0, o = t, i = 0;
	for (; i = e[o++], r |= (127 & i) << n, n += 7, 128 & i;);
	return n < 32 && 64 & i && (r |= -1 << n), [r, o - t];
}
function u(e, t) {
	let r = 0n, n = 0n, o = t, i = 0;
	for (; i = e[o++], r |= BigInt(127 & i) << n, n += 7n, 128 & i;);
	return n < 64n && 64 & i && (r |= -1n << n), [r, o - t];
}
function h(e, t) {
	const r = e[t];
	if (64 === r || 127 === r || 126 === r || 125 === r || 124 === r || 123 === r || 112 === r || 111 === r) return t + 1;
	const [, n] = d(e, t);
	return t + n;
}
function m(e, t) {
	const [, r] = f(e, t);
	t += r;
	const [, n] = f(e, t);
	return t + n;
}
function p(e, t, r) {
	const [n, o] = f(t, r);
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
			const [, e] = f(t, r);
			r += e;
			const [, n] = f(t, r);
			return r + n;
		}
		case 9: {
			const [, e] = f(t, r);
			return r + e;
		}
		case 10: {
			const [, e] = f(t, r);
			r += e;
			const [, n] = f(t, r);
			return r + n;
		}
		case 11: {
			const [, e] = f(t, r);
			return r + e;
		}
		case 12: {
			const [, e] = f(t, r);
			r += e;
			const [, n] = f(t, r);
			return r + n;
		}
		case 13: {
			const [, e] = f(t, r);
			return r + e;
		}
		case 14: {
			const [, e] = f(t, r);
			r += e;
			const [, n] = f(t, r);
			return r + n;
		}
		case 15:
		case 16:
		case 17: {
			const [, e] = f(t, r);
			return r + e;
		}
		default: return null;
	}
	return 253 === e ? 12 === n || 13 === n ? r + 16 : n >= 21 && n <= 34 ? m(t, r) : 84 === n || n >= 92 && n <= 99 || n >= 112 && n <= 123 || n >= 124 && n <= 131 || n >= 156 && n <= 159 ? r + 1 : r : 254 === e ? 0 === n || 1 === n || 2 === n ? m(t, r) : 3 === n ? r : n >= 16 && n <= 79 ? m(t, r) : null : null;
}
function w(e, t, r) {
	const [n, o] = f(e, t);
	t += o + n;
	const [i, s] = f(e, t);
	t += s + i;
	const a = e[t++];
	if (0 === a) {
		r.funcImports++;
		const [, n] = f(e, t);
		t += n;
	} else if (1 === a) {
		t++;
		const r = e[t++], [, n] = f(e, t);
		if (t += n, 1 & r) {
			const [, r] = f(e, t);
			t += r;
		}
	} else if (2 === a) {
		const r = e[t++], [, n] = f(e, t);
		if (t += n, 1 & r) {
			const [, r] = f(e, t);
			t += r;
		}
	} else 3 === a && (r.globalImports++, t += 2);
	return t;
}
n.map(({ name: e }) => e);
function b(e, t) {
	const r = new Uint8Array(e);
	if (r.length < 8) return null;
	let n = 0, o = null, i = null, s = 8;
	for (; s < r.length;) {
		const e = r[s], [a, l] = f(r, s + 1), c = s + 1 + l;
		if (2 === e) {
			const e = {
				funcImports: n,
				globalImports: 0
			};
			let t = c;
			const [o, i] = f(r, t);
			t += i;
			for (let n = 0; n < o; n++) t = w(r, t, e);
			n = e.funcImports;
		} else if (7 === e) {
			let e = c;
			const [n, i] = f(r, e);
			e += i;
			for (let s = 0; s < n; s++) {
				const [n, i] = f(r, e);
				e += i;
				const s = new TextDecoder().decode(r.subarray(e, e + n));
				e += n;
				const a = r[e++], [l, c] = f(r, e);
				if (e += c, 0 === a && s === t) {
					o = l;
					break;
				}
			}
		} else 10 === e && (i = {
			offset: c,
			size: a
		});
		s = c + a;
	}
	if (null === o || null === i) return null;
	let a = i.offset;
	const [l, c] = f(r, a);
	return a += c, function e(t, o = 0) {
		if (o > 4) return null;
		const i = function(e) {
			const t = e - n;
			if (t < 0 || t >= l) return null;
			let o = a;
			for (let n = 0; n < t; n++) {
				const [e, t] = f(r, o);
				o += t + e;
			}
			const [i, s] = f(r, o);
			return o += s, {
				start: o,
				end: o + i
			};
		}(t);
		if (!i) return null;
		const s = function(e, t) {
			if (e >= t) return null;
			const [n, o] = f(r, e);
			e += o;
			for (let i = 0; i < n; i++) {
				const [, n] = f(r, e);
				if (e += n, ++e > t) return null;
			}
			return e;
		}(i.start, i.end);
		if (null === s) return null;
		let c = s;
		const w = i.end;
		for (; c < w;) {
			const t = r[c++];
			if (11 !== t) {
				if (65 === t) {
					const [e] = d(r, c), [, t] = d(r, c), n = c + t;
					if (15 === r[n] || 11 === r[n] && n + 1 === w) return e;
					c = n;
				} else if (16 === t) {
					const [t, n] = f(r, c), i = c + n;
					if (15 === r[i] || 11 === r[i] && i + 1 === w) {
						const r = e(t, o + 1);
						if (null !== r) return r;
					}
					c = i;
				} else if (12 === t || 13 === t || 18 === t || 210 === t) {
					const [, e] = f(r, c);
					c += e;
				} else if (2 === t || 3 === t || 4 === t) c = h(r, c);
				else if (14 === t) {
					const [e, t] = f(r, c);
					c += t;
					for (let n = 0; n <= e; n++) {
						const [, e] = f(r, c);
						c += e;
					}
				} else if (17 === t) {
					const [, e] = f(r, c);
					c += e;
					const [, t] = f(r, c);
					c += t;
				} else if (28 === t) {
					const [e, t] = f(r, c);
					c += t;
					for (let n = 0; n < e; n++) {
						const [, e] = f(r, c);
						c += e;
					}
				} else if (t >= 32 && t <= 38 || 208 === t) {
					const [, e] = f(r, c);
					c += e;
				} else if (t >= 40 && t <= 62) c = m(r, c);
				else if (63 === t || 64 === t) c++;
				else if (66 === t) {
					const [, e] = u(r, c);
					c += e;
				} else if (67 === t) c += 4;
				else if (68 === t) c += 8;
				else if (252 === t || 253 === t || 254 === t) {
					const e = p(t, r, c);
					if (null === e) return null;
					c = e;
				}
			} else if (c === w) return null;
		}
		return null;
	}(o);
}
const g = BigInt(Number.MAX_SAFE_INTEGER), _ = -(1n << 63n), k = (1n << 64n) - 1n;
function y(e, t, r) {
	let n;
	if (4 === t) {
		if ("number" != typeof e || !Number.isSafeInteger(e) || e < -2147483648 || e > 4294967295) throw new TypeError(`${r}: expected an exact memory32 pointer`);
		n = BigInt(e >>> 0);
	} else {
		if ("bigint" != typeof e || e < _ || e > k) throw new TypeError(`${r}: expected an exact memory64 pointer`);
		n = BigInt.asUintN(64, e);
	}
	if (n > g) throw new RangeError(`${r}: pointer exceeds JavaScript's exact address range`);
	return Number(n);
}
const v = "kandelo.wpk_fork.linked_frames", $ = 1212368459, E = 1313031755;
function A(e, t, r, n) {
	if ("function" != typeof e) throw new TypeError(`${n}: continuation begin export is not callable`);
	if (!Number.isSafeInteger(t) || t <= 0) throw new RangeError(`${n}: invalid continuation address ${t}`);
	e(8 === r ? BigInt(t) : t);
}
var x = class extends Error {
	errno;
	requestedSize;
	constructor(e, t, r) {
		super(r), this.errno = e, this.requestedSize = t, this.name = "ContinuationAllocationError";
	}
};
function S(e, t, r, n) {
	const o = new DataView(e.buffer);
	8 === r ? o.setBigUint64(t, BigInt(n), !0) : o.setUint32(t, n, !0);
}
function I(e, t) {
	const r = Math.ceil(e / t) * t;
	if (!Number.isSafeInteger(r)) throw new Error(`linked continuation alignment overflow: ${e}`);
	return r;
}
function B(e, t) {
	const r = e + t;
	if (!Number.isSafeInteger(e) || !Number.isSafeInteger(t) || e < 0 || t < 0 || !Number.isSafeInteger(r)) throw new Error(`invalid linked continuation range addr=${e} size=${t}`);
	return r;
}
function U(r) {
	const n = WebAssembly.Module.customSections(r, v);
	if (1 !== n.length) throw new Error(`expected one ${v} section, found ${n.length}`);
	const o = new Uint8Array(n[0]);
	if (24 !== o.byteLength) throw new Error(`linked continuation metadata has ${o.byteLength} bytes, expected 24`);
	const i = new DataView(o.buffer, o.byteOffset, o.byteLength);
	if (!e.every((e, t) => o[t] === e)) throw new Error("linked continuation metadata has invalid magic");
	const s = i.getUint16(4, !0);
	if (1 !== s) throw new Error(`unsupported linked continuation metadata version ${s}`);
	if (24 !== i.getUint16(6, !0)) throw new Error("linked continuation metadata has an invalid declared size");
	const a = i.getUint8(8), l = function(e) {
		return t.find(({ bytes: t }) => t === e);
	}(a);
	if (!l) throw new Error(`unsupported linked continuation pointer width ${a}`);
	const c = i.getUint8(9);
	if (8 !== c) throw new Error(`unsupported linked continuation alignment ${c}`);
	const f = i.getUint16(10, !0);
	if (3 !== f) throw new Error(`unsupported linked continuation flags 0x${f.toString(16)}`);
	const d = i.getUint32(12, !0), u = i.getUint32(16, !0), h = i.getUint32(20, !0);
	if (d !== l.chunkHeaderSize || u !== l.nodeHeaderSize) throw new Error("linked continuation metadata header sizes do not match pointer width");
	return {
		version: s,
		ptrWidth: l.bytes,
		alignment: c,
		flags: f,
		chunkHeaderSize: d,
		nodeHeaderSize: u,
		fixedPrefixSize: h
	};
}
var M = class {
	memory;
	format;
	allocate;
	deallocate;
	label;
	root = 0;
	activeChunk = 0;
	replayNode = 0;
	replayChunkIndex = -1;
	replayExpectedEnd = 0;
	pending = null;
	chunks = [];
	committedFrames = 0;
	committedBytes = 0;
	abortFailure = null;
	constructor(e, t, r, n, o) {
		this.memory = e, this.format = t, this.allocate = r, this.deallocate = n, this.label = o;
	}
	beginUnwind() {
		if (0 !== this.root) throw new Error(`${this.label}: linked continuation already active`);
		const e = I(this.format.chunkHeaderSize + this.format.fixedPrefixSize, this.format.alignment), t = I(Math.max(e, c), c);
		let r;
		this.committedFrames = 0, this.committedBytes = 0, this.abortFailure = null;
		try {
			r = this.allocateChunk(t, 0, 0);
		} catch (n) {
			n instanceof x && this.releaseAfterFailure(n), this.abortAndRelease(void 0, n);
		}
		return this.root = r, this.activeChunk = r, this.writePtr(r + 8 + 4 * this.format.ptrWidth, e), this.chunks[0].nodeStart = e, this.chunks[0].used = e, this.asGuestPtr(r + this.format.chunkHeaderSize);
	}
	attachForReplay(e) {
		if (0 !== this.root) throw new Error(`${this.label}: linked continuation already active`);
		const t = this.fromGuestPtr(e) - this.format.chunkHeaderSize, r = [], n = /* @__PURE__ */ new Set(), o = Math.max(0, Math.floor(this.memory.buffer.byteLength / c) - 1);
		let i = t, s = 0;
		for (;;) {
			if (n.has(i)) throw new Error(`${this.label}: linked continuation chunk cycle`);
			if (n.size >= o) throw new Error(`${this.label}: linked continuation chunk chain exceeds memory`);
			n.add(i);
			const { capacity: e, used: a } = this.validateChunk(i, t, s), l = 0 === r.length ? I(this.format.chunkHeaderSize + this.format.fixedPrefixSize, this.format.alignment) : this.format.chunkHeaderSize;
			if (a < l || r.length > 0 && a === l) throw new Error(`${this.label}: invalid linked continuation chunk contents`);
			r.push({
				addr: i,
				size: e,
				nodeStart: l,
				used: a
			});
			const c = this.readPtr(i + 8 + 2 * this.format.ptrWidth);
			if (0 === c) break;
			s = i, i = c;
		}
		const a = this.readPtr(t + 8 + 5 * this.format.ptrWidth), l = [...r].sort((e, t) => e.addr - t.addr);
		for (let c = 1; c < l.length; c++) {
			const e = l[c - 1], t = l[c];
			if (B(e.addr, e.size) > t.addr) throw new Error(`${this.label}: linked continuation chunk ranges overlap`);
		}
		this.validateReplayTail(r, a), this.root = t, this.chunks = r, this.activeChunk = r[r.length - 1].addr, this.setReplayCursor(a);
	}
	beginReplay() {
		if (0 === this.root || this.pending || this.abortFailure) throw new Error(`${this.label}: cannot begin replay from incomplete continuation`);
		this.resetReplay(this.readPtr(this.root + 8 + 5 * this.format.ptrWidth));
	}
	reserveFrame(e) {
		const t = this.fromGuestPtr(e);
		if (0 === this.root || 0 === this.activeChunk) throw new Error(`${this.label}: frame reservation outside unwind`);
		if (this.pending) throw new Error(`${this.label}: a frame reservation is already pending`);
		if (this.abortFailure) throw new Error(`${this.label}: frame reservation after abort began`);
		const r = I(this.format.nodeHeaderSize + t, this.format.alignment);
		let n = this.activeChunk, o = this.readPtr(n + 8 + 4 * this.format.ptrWidth), i = this.readPtr(n + 8 + 3 * this.format.ptrWidth);
		if (r > i - o) {
			const e = I(Math.max(c, this.format.chunkHeaderSize + r), c);
			let s;
			try {
				s = this.allocateChunk(e, this.root, n);
			} catch (d) {
				if (d instanceof x) return this.beginAbortReplay(d.errno, t, d.message), this.asGuestPtr(0);
				this.abortAndRelease(t, d);
			}
			this.writePtr(n + 8 + 2 * this.format.ptrWidth, s), this.activeChunk = s, n = s, o = this.format.chunkHeaderSize, i = e;
		}
		if (r > i - o) throw new Error(`${this.label}: allocator returned an undersized continuation chunk`);
		const s = n + o, a = s + this.format.nodeHeaderSize, l = this.readPtr(this.root + 8 + 5 * this.format.ptrWidth), f = this.view();
		return f.setUint32(s, E, !0), f.setUint16(s + 4, 1, !0), f.setUint16(s + 6, 1, !0), this.writePtr(s + 8, l), this.writePtr(s + 8 + this.format.ptrWidth, t), this.writePtr(s + 8 + 2 * this.format.ptrWidth, r), this.pending = {
			chunk: n,
			node: s,
			payload: a,
			nextUsed: o + r
		}, this.asGuestPtr(a);
	}
	commitFrame(e) {
		if (this.abortFailure) throw new Error(`${this.label}: frame commit after abort began`);
		const t = this.fromGuestPtr(e), r = this.pending;
		if (!r || r.payload !== t) throw new Error(`${this.label}: frame commit does not match the pending reservation`);
		const n = this.chunks[this.chunks.length - 1];
		if (n?.addr !== r.chunk) throw new Error(`${this.label}: pending frame belongs to an inactive chunk`);
		this.writePtr(r.chunk + 8 + 4 * this.format.ptrWidth, r.nextUsed), n.used = r.nextUsed, this.view().setUint16(r.node + 6, 2, !0), this.writePtr(this.root + 8 + 5 * this.format.ptrWidth, r.node);
		const o = this.readPtr(r.node + 8 + this.format.ptrWidth);
		this.committedFrames++, this.committedBytes += o, this.pending = null;
	}
	nextFrame(e) {
		const t = this.fromGuestPtr(e), r = this.replayNode;
		if (0 === this.root || 0 === r) throw new Error(`${this.label}: linked continuation replay exhausted early`);
		this.replayChunk(r);
		const n = this.view();
		if (n.getUint32(r, !0) !== E || 1 !== n.getUint16(r + 4, !0) || 2 !== n.getUint16(r + 6, !0)) throw new Error(`${this.label}: invalid or uncommitted linked continuation node`);
		const o = this.readPtr(r + 8 + this.format.ptrWidth), i = this.readPtr(r + 8 + 2 * this.format.ptrWidth);
		if (o !== t) throw new Error(`${this.label}: linked continuation frame size ${o} does not match ${t}`);
		const s = B(r, i);
		if (i !== I(this.format.nodeHeaderSize + o, this.format.alignment) || s !== this.replayExpectedEnd) throw new Error(`${this.label}: invalid linked continuation node bounds`);
		const a = this.readPtr(r + 8), l = this.previousReplayPosition(a, r);
		return this.replayNode = a, this.replayChunkIndex = l.chunkIndex, this.replayExpectedEnd = l.expectedEnd, n.setUint16(r + 6, 3, !0), this.asGuestPtr(r + this.format.nodeHeaderSize);
	}
	finishUnwind() {
		if (this.pending) throw new Error(`${this.label}: unwind ended with an uncommitted frame`);
		if (0 === this.root) throw new Error(`${this.label}: unwind ended without a continuation`);
	}
	finishReplayAndRelease() {
		if (this.abortFailure) throw new Error(`${this.label}: normal replay ended during abort recovery`);
		if (0 !== this.replayNode) throw new Error(`${this.label}: rewind ended before all linked frames were consumed`);
		this.release();
	}
	beginAbortReplay(e, t, r = `fork continuation allocation failed with errno=${e}`) {
		if (!Number.isInteger(e) || e <= 0) throw new Error(`${this.label}: invalid abort errno ${e}`);
		if (0 === this.root || this.pending) throw new Error(`${this.label}: cannot abort-replay an incomplete continuation`);
		if (this.abortFailure && this.abortFailure.errno !== e) throw new Error(`${this.label}: conflicting continuation abort failures`);
		this.resetReplay(this.readPtr(this.root + 8 + 5 * this.format.ptrWidth)), this.abortFailure ??= {
			errno: e,
			requestedFrame: t,
			diagnostic: r
		};
	}
	abortErrno() {
		if (!this.abortFailure) throw new Error(`${this.label}: no continuation abort is active`);
		return this.abortFailure.errno;
	}
	finishAbortReplayAndRelease() {
		if (!this.abortFailure) throw new Error(`${this.label}: abort replay ended without an allocation failure`);
		if (0 !== this.replayNode) throw new Error(`${this.label}: abort replay ended before all linked frames were consumed`);
		this.release();
	}
	cancelUnwindAndRelease() {
		if (this.pending) throw new Error(`${this.label}: cannot cancel an unwind with a pending frame`);
		if (0 === this.root) throw new Error(`${this.label}: cannot cancel an inactive unwind`);
		this.release();
	}
	abortAndRelease(e, t) {
		const r = `committed_frames=${this.committedFrames} committed_bytes=${this.committedBytes}` + (void 0 === e ? "" : ` requested_next_frame=${e}`) + (void 0 === t ? "" : ` allocator_error=${t instanceof Error ? t.message : String(t)}`);
		try {
			this.release();
		} finally {
			throw new Error(`${this.label}: continuation allocation failed (${r})`);
		}
	}
	moduleBufferAddress() {
		if (0 === this.root) throw new Error(`${this.label}: no active linked continuation`);
		return this.root + this.format.chunkHeaderSize;
	}
	hasActiveContinuation() {
		return 0 !== this.root;
	}
	allocateChunk(e, t, r) {
		let n;
		try {
			n = this.allocate(e);
		} catch (i) {
			if (i instanceof x) throw i;
			const t = i instanceof Error ? i.message : String(i);
			throw new Error(`${this.label}: continuation allocation of ${e} bytes failed: ${t}`);
		}
		if (!Number.isSafeInteger(n) || n <= 0 || n % c !== 0 || B(n, e) > this.memory.buffer.byteLength) {
			if (Number.isSafeInteger(n) && n > 0) try {
				this.deallocate(n, e);
			} catch {}
			throw new Error(`${this.label}: allocator returned invalid continuation chunk 0x${n.toString(16)}`);
		}
		const o = this.view();
		return o.setUint32(n, $, !0), o.setUint16(n + 4, 1, !0), o.setUint16(n + 6, 0, !0), this.writePtr(n + 8, t || n), this.writePtr(n + 8 + this.format.ptrWidth, r), this.writePtr(n + 8 + 2 * this.format.ptrWidth, 0), this.writePtr(n + 8 + 3 * this.format.ptrWidth, e), this.writePtr(n + 8 + 4 * this.format.ptrWidth, this.format.chunkHeaderSize), this.writePtr(n + 8 + 5 * this.format.ptrWidth, 0), this.chunks.push({
			addr: n,
			size: e,
			nodeStart: this.format.chunkHeaderSize,
			used: this.format.chunkHeaderSize
		}), n;
	}
	validateChunk(e, t, r) {
		const n = this.view();
		if (!Number.isSafeInteger(e) || e <= 0 || e % c !== 0 || B(e, this.format.chunkHeaderSize) > this.memory.buffer.byteLength || n.getUint32(e, !0) !== $ || 1 !== n.getUint16(e + 4, !0) || 0 !== n.getUint16(e + 6, !0) || this.readPtr(e + 8) !== t || this.readPtr(e + 8 + this.format.ptrWidth) !== r) throw new Error(`${this.label}: invalid linked continuation chunk at 0x${e.toString(16)}`);
		const o = this.readPtr(e + 8 + 3 * this.format.ptrWidth), i = this.readPtr(e + 8 + 4 * this.format.ptrWidth);
		if (o < c || o % c !== 0 || B(e, o) > this.memory.buffer.byteLength || i < this.format.chunkHeaderSize || i > o) throw new Error(`${this.label}: invalid linked continuation chunk bounds`);
		return {
			capacity: o,
			used: i
		};
	}
	validateReplayTail(e, t) {
		const r = e.some(({ nodeStart: e, used: t }) => t > e);
		if (0 === t) {
			if (r) throw new Error(`${this.label}: nonempty linked continuation has no replay tail`);
			return;
		}
		if (!r) throw new Error(`${this.label}: empty linked continuation has a replay tail`);
		const n = e[e.length - 1], o = this.view();
		if (t % this.format.alignment !== 0 || t < n.addr + n.nodeStart || B(t, this.format.nodeHeaderSize) > n.addr + n.used || o.getUint32(t, !0) !== E || 1 !== o.getUint16(t + 4, !0) || 2 !== o.getUint16(t + 6, !0)) throw new Error(`${this.label}: invalid linked continuation replay tail`);
		const i = this.readPtr(t + 8 + this.format.ptrWidth), s = this.readPtr(t + 8 + 2 * this.format.ptrWidth);
		if (s !== I(this.format.nodeHeaderSize + i, this.format.alignment) || B(t, s) !== n.addr + n.used) throw new Error(`${this.label}: invalid linked continuation replay tail bounds`);
	}
	resetReplay(e) {
		this.validateReplayTail(this.chunks, e), this.setReplayCursor(e);
	}
	setReplayCursor(e) {
		if (this.replayNode = e, 0 === e) return this.replayChunkIndex = -1, void (this.replayExpectedEnd = 0);
		this.replayChunkIndex = this.chunks.length - 1;
		const t = this.chunks[this.replayChunkIndex];
		this.replayExpectedEnd = t.addr + t.used;
	}
	replayChunk(e) {
		const t = this.chunks[this.replayChunkIndex];
		if (!t || e % this.format.alignment !== 0 || e < t.addr + t.nodeStart || B(e, this.format.nodeHeaderSize) > t.addr + t.used) throw new Error(`${this.label}: frame pointer is outside the expected continuation chunk`);
		return t;
	}
	previousReplayPosition(e, t) {
		const r = this.replayChunkIndex, n = this.chunks[r];
		if (0 === e) {
			const e = r > 1 || 1 === r && this.chunks[0].used > this.chunks[0].nodeStart;
			if (t !== n.addr + n.nodeStart || e) throw new Error(`${this.label}: linked continuation replay ended before its first frame`);
			return {
				chunkIndex: -1,
				expectedEnd: 0
			};
		}
		if (e >= n.addr + n.nodeStart && B(e, this.format.nodeHeaderSize) <= n.addr + n.used) {
			if (e >= t) throw new Error(`${this.label}: linked continuation nodes are not reverse ordered`);
			return this.validateReplayPredecessor(e, n, t), {
				chunkIndex: r,
				expectedEnd: t
			};
		}
		const o = this.chunks[r - 1];
		if (o && e >= o.addr + o.nodeStart && B(e, this.format.nodeHeaderSize) <= o.addr + o.used) {
			if (t !== n.addr + n.nodeStart) throw new Error(`${this.label}: linked continuation replay skipped a frame`);
			return this.validateReplayPredecessor(e, o, o.addr + o.used), {
				chunkIndex: r - 1,
				expectedEnd: o.addr + o.used
			};
		}
		throw new Error(`${this.label}: frame pointer is outside the expected continuation chunk`);
	}
	validateReplayPredecessor(e, t, r) {
		const n = this.view();
		if (e % this.format.alignment !== 0 || e < t.addr + t.nodeStart || B(e, this.format.nodeHeaderSize) > t.addr + t.used || n.getUint32(e, !0) !== E || 1 !== n.getUint16(e + 4, !0) || 2 !== n.getUint16(e + 6, !0)) throw new Error(`${this.label}: invalid linked continuation replay predecessor`);
		const o = this.readPtr(e + 8 + this.format.ptrWidth), i = this.readPtr(e + 8 + 2 * this.format.ptrWidth);
		if (i !== I(this.format.nodeHeaderSize + o, this.format.alignment) || B(e, i) !== r) throw new Error(`${this.label}: linked continuation replay skipped a frame`);
	}
	release() {
		const e = this.chunks.splice(0).reverse();
		let t;
		this.pending = null, this.root = 0, this.activeChunk = 0, this.replayNode = 0, this.replayChunkIndex = -1, this.replayExpectedEnd = 0, this.abortFailure = null;
		for (const n of e) try {
			this.deallocate(n.addr, n.size);
		} catch (r) {
			t ??= r;
		}
		if (void 0 !== t) throw t;
	}
	releaseAfterFailure(e) {
		try {
			this.release();
		} catch (t) {
			throw new Error(`${this.label}: continuation cleanup after allocation failure failed: ${t instanceof Error ? t.message : String(t)}`);
		}
		throw e;
	}
	view() {
		return new DataView(this.memory.buffer);
	}
	readPtr(e) {
		const t = 8 === this.format.ptrWidth ? Number(this.view().getBigUint64(e, !0)) : this.view().getUint32(e, !0);
		if (!Number.isSafeInteger(t)) throw new Error(`${this.label}: continuation pointer exceeds JavaScript addressability`);
		return t;
	}
	writePtr(e, t) {
		if (!Number.isSafeInteger(t) || t < 0) throw new Error(`${this.label}: invalid continuation pointer value ${t}`);
		8 === this.format.ptrWidth ? this.view().setBigUint64(e, BigInt(t), !0) : this.view().setUint32(e, t, !0);
	}
	fromGuestPtr(e) {
		return y(e, this.format.ptrWidth, `${this.label}: linked continuation`);
	}
	asGuestPtr(e) {
		return 8 === this.format.ptrWidth ? BigInt(e) : e;
	}
};
const N = n.map(({ name: e }) => e), W = "kandelo.wpk_fork.capabilities";
function P(e) {
	const t = WebAssembly.Module.customSections(e, W);
	if (0 === t.length) return {
		present: !1,
		flags: 0
	};
	if (1 !== t.length) throw new Error(`duplicate ${W} custom sections`);
	const r = new Uint8Array(t[0]);
	if (2 !== r.length) throw new Error(`malformed ${W} custom section`);
	if (1 !== r[0]) throw new Error(`unsupported fork-instrument capability version ${r[0]}; expected 1`);
	if (-4 & r[1]) throw new Error(`unknown fork-instrument capability flags 0x${r[1].toString(16)}`);
	return {
		present: !0,
		flags: r[1]
	};
}
function R(e, t, r = 42) {
	return e.present ? 0 !== (e.flags & t) : r < 17;
}
function F(e, t) {
	let r, n = 0, o = 0;
	do
		r = e[t.value++], n |= (127 & r) << o, o += 7;
	while (128 & r);
	return n >>> 0;
}
function z(e, t) {
	const r = F(e, t), n = e.subarray(t.value, t.value + r);
	return t.value += r, new TextDecoder().decode(n);
}
function T(e, t, r) {
	if (!Number.isSafeInteger(e) || e < 0) throw new RangeError(`${r}: address is not an exact non-negative integer`);
	return 8 === t ? BigInt(e) : e;
}
function L(e, t, r) {
	if (typeof e != (8 === t ? "bigint" : "number")) throw new TypeError(`${r}: expected a ${8 * t}-bit WebAssembly address`);
	if ("number" == typeof e && (!Number.isSafeInteger(e) || e < 0) || "bigint" == typeof e && e < 0n) throw new RangeError(`${r}: address is not an exact non-negative integer`);
	return e;
}
function C(e, t, r) {
	return T(t, "bigint" == typeof e.length ? 8 : 4, r);
}
function D(e) {
	const t = e.length;
	L(t, "bigint" == typeof t ? 8 : 4, "dynamic-linker table length");
	const r = Number(t);
	if (!Number.isSafeInteger(r)) throw new RangeError("dynamic-linker table length exceeds JavaScript's exact integer range");
	return r;
}
function O(e, t) {
	e.grow(C(e, t, "dynamic-linker table growth"));
}
function G(e, t) {
	return e.get(C(e, t, "dynamic-linker table index"));
}
function H(e, t, r) {
	e.set(C(e, t, "dynamic-linker table index"), r);
}
function V() {
	return WebAssembly.Tag;
}
function j(e) {
	if (4 !== e && 8 !== e) throw new TypeError(`invalid process pointer width ${String(e)}`);
	const t = V();
	return t ? new t({ parameters: [8 === e ? "i64" : "i32"] }) : void 0;
}
function q(e) {
	if (4 !== e && 8 !== e) throw new TypeError(`invalid process pointer width ${String(e)}`);
	const t = V();
	return t ? new t({ parameters: [8 === e ? "i64" : "i32"] }) : void 0;
}
function Z(e, t) {
	const r = V();
	if (!r) throw new Error(`${t}: this WebAssembly runtime does not support exception tags`);
	if (!(e instanceof r)) throw new TypeError(`${t}: __c_longjmp must be an actual WebAssembly.Tag`);
	return e;
}
function J(e, t) {
	const r = V();
	if (!r) throw new Error(`${t}: this WebAssembly runtime does not support exception tags`);
	if (!(e instanceof r)) throw new TypeError(`${t}: __cpp_exception must be an actual WebAssembly.Tag`);
	return e;
}
function K(e) {
	const t = e.ptrWidth ?? 4;
	if (4 !== t && 8 !== t) throw new TypeError(`invalid process pointer width ${String(t)}`);
	void 0 !== e.longjmpTag && Z(e.longjmpTag, "dynamic linker");
}
const X = new Set([
	"__wasm_dlopen",
	"__wasm_dlsym",
	"dlopen",
	"dlsym"
]);
function Q(e, t, r) {
	return Array.from(e).filter((e) => !r.has(e) && t.has(e)).sort();
}
function Y(e, t, n, o, i) {
	K(o);
	const s = o.ptrWidth ?? 4, a = 8 === s ? "i64" : "i32", l = new WebAssembly.Module(t), c = WebAssembly.Module.imports(l), f = WebAssembly.Module.exports(l), d = c.some((e) => "env" === e.module && "fork" === e.name && "function" === e.kind), u = r.filter(({ module: e }) => "env" === e).map(({ name: e }) => e), h = u.filter((e) => c.some((t) => "env" === t.module && t.name === e && "function" === t.kind)).length, m = N.filter((e) => f.some((t) => "function" === t.kind && t.name === e)), p = m.length === N.length, w = P(l), b = w.present && !!(1 & w.flags), g = R(w, 1), _ = new Set(c.filter((e) => "env" === e.module && "function" === e.kind || "GOT.func" === e.module).map((e) => e.name)), k = new Set(f.filter((e) => "function" === e.kind).map((e) => e.name)), y = function(e, t) {
		const r = /* @__PURE__ */ new Set(), n = { value: 8 };
		for (; n.value < e.length;) {
			const o = e[n.value++], i = F(e, n), s = n.value + i;
			if (7 !== o) {
				n.value = s;
				continue;
			}
			const a = F(e, n);
			for (let l = 0; l < a; l++) {
				const o = z(e, n), i = e[n.value++], s = F(e, n);
				0 === i && s >= t && r.add(o);
			}
			break;
		}
		return r;
	}(t, c.filter((e) => "function" === e.kind).length), v = new Set(c.filter((e) => "env" === e.module && "function" === e.kind && y.has(e.name)).map((e) => e.name)), $ = c.some((e) => "env" === e.module && "function" === e.kind && X.has(e.name)), E = c.some((e) => "env" === e.module && "__c_longjmp" === e.name && "tag" === e.kind) ? function(e) {
		return K(e), void 0 !== e.longjmpTag || (e.longjmpTag = Z(j(e.ptrWidth ?? 4), "dynamic linker")), e.longjmpTag;
	}(o) : void 0, S = c.some((e) => "env" === e.module && "__cpp_exception" === e.name && "tag" === e.kind) ? function(e) {
		return K(e), void 0 !== e.cppExceptionTag ? J(e.cppExceptionTag, "dynamic linker") : (e.cppExceptionTag = J(q(e.ptrWidth ?? 4), "dynamic linker"), e.cppExceptionTag);
	}(o) : void 0;
	if (m.length > 0 && !p) {
		const t = N.filter((e) => !f.some((t) => "function" === t.kind && t.name === e));
		throw new Error(`${e}: incomplete wasm-fork-instrument exports; missing ${t.join(", ")}`);
	}
	if (d && !p) throw new Error(`${e}: env.fork requires complete side-module instrumentation; rebuild with wasm-fork-instrument --entry env.fork`);
	if (d && !g) throw new Error(`${e}: env.fork requires the versioned side-entry capability; rebuild with the current wasm-fork-instrument --entry env.fork`);
	if (0 !== h && h !== u.length) throw new Error(`${e}: incomplete linked fork instrumentation imports; rebuild the module`);
	if (d && h !== u.length) throw new Error(`${e}: env.fork requires ABI 42 linked continuation imports`);
	if (b && !d) throw new Error(`${e}: side-entry capability is present without an env.fork import`);
	if (d && !o.sideModuleFork) throw new Error(`${e}: env.fork cannot be coordinated: ` + (o.sideModuleForkUnavailableReason ?? "side-module fork requires a process-worker unwind coordinator"));
	(function(e, t, r, n, o, i) {
		const s = i.mainModuleSymbols ?? /* @__PURE__ */ new Set();
		for (const a of i.loadedLibraries.values()) {
			if (!t && !a.forkCapable) continue;
			if (o || a.importsDynamicLookup) throw new Error(`${e}: fork-capable side modules cannot coexist with side-originated dlopen/dlsym; only a direct main-module-to-side fork path is supported`);
			const i = [...Q(r, a.functionExports, s), ...Q(a.functionImports, n, s)];
			if (i.length > 0) throw new Error(`${e}: fork-capable side-module nesting through ${a.name} is unsupported (cross-side symbols: ${Array.from(new Set(i)).join(", ")})`);
		}
	})(e, d, _, k, $, o);
	const I = D(o.table), B = o.heapPointer?.value, W = new Map(o.globalSymbols), V = new Map(Array.from(o.got, ([e, t]) => [e, {
		global: t,
		value: t.value
	}])), Y = [];
	try {
		const t = 1 << n.memoryAlign;
		let r = 0;
		if (n.memorySize > 0) {
			if (i) r = i.memoryBase;
			else if (o.allocateMemory) {
				if (r = ((t, r) => {
					if (!o.allocateMemory) throw new Error(`${e}: no side-module memory allocator configured`);
					const n = o.allocateMemory(t, r);
					return Y.push({
						addr: n,
						size: t
					}), n;
				})(n.memorySize, t), r + n.memorySize > o.memory.buffer.byteLength) throw new Error(`${e}: allocator returned 0x${r.toString(16)} but memory only covers 0x${o.memory.buffer.byteLength.toString(16)}`);
			} else {
				if (!o.heapPointer) throw new Error(`${e}: no side-module memory allocator configured`);
				r = o.heapPointer.value + (ee = t) - 1 & ~(ee - 1), o.heapPointer.value = r + n.memorySize;
				const i = Math.ceil(o.heapPointer.value / 65536), a = o.memory.buffer.byteLength / 65536;
				i > a && function(e, t, r) {
					e.grow(T(t, r, "dynamic-linker memory growth"));
				}(o.memory, i - a, s);
			}
			i || new Uint8Array(o.memory.buffer, r, n.memorySize).fill(0);
		}
		let c = D(o.table);
		if (i) {
			if (!Number.isSafeInteger(i.tableBase) || i.tableBase < 0) throw new Error(`${e}: invalid replay table base ${i.tableBase}`);
			if (c > i.tableBase) throw new Error(`${e}: replay table already at ${c}, past parent base ${i.tableBase}`);
			c < i.tableBase && O(o.table, i.tableBase - c), c = i.tableBase;
		}
		n.tableSize > 0 && O(o.table, n.tableSize);
		let f, h = 0;
		if (d) {
			if (!o.allocateContinuation || !o.deallocateContinuation) throw new Error(`${e}: linked continuations require process-mapping allocation and cleanup`);
			f = new M(o.memory, U(l), o.allocateContinuation, o.deallocateContinuation, e), i && (h = i.forkBufAddr ?? 0);
		}
		const m = new WebAssembly.Global({
			value: a,
			mutable: !1
		}, T(r, s, `${e}: memory base`)), p = new WebAssembly.Global({
			value: "bigint" == typeof o.table.length ? "i64" : "i32",
			mutable: !1
		}, C(o.table, c, `${e}: table base`)), w = (e) => {
			const t = o.table, r = D(t);
			for (let o = 0; o < r; o++) if (G(t, o) === e) return o;
			const n = r;
			return O(t, 1), H(t, n, e), n;
		}, b = (t, r) => {
			let n = o.got.get(t);
			if (n) L(n.value, s, `${e}: existing GOT.${r}.${t}`);
			else {
				let i = T(0, s, `${e}: GOT.${r}.${t}`);
				const l = o.globalSymbols.get(t);
				"mem" === r && l instanceof WebAssembly.Global ? i = L(l.value, s, `${e}: GOT.mem.${t}`) : "func" === r && "function" == typeof l && (i = T(w(l), s, `${e}: GOT.func.${t}`)), n = new WebAssembly.Global({
					value: a,
					mutable: !0
				}, i), o.got.set(t, n);
			}
			return n;
		};
		let g = null, y = null;
		const I = () => {
			if (!g) throw new Error(`${e}: side-module fork before instantiation`);
			return Number(g.exports.wpk_fork_state());
		}, B = () => {
			if (!g || !o.sideModuleFork || !f) throw new Error(`${e}: side-module fork coordinator is unavailable`);
			const t = I();
			if (0 === t) {
				try {
					h = Number(f.beginUnwind());
				} catch (r) {
					if (r instanceof x) return -r.errno;
					throw r;
				}
				const t = o.loadedLibraries.get(e);
				if (t && (t.forkBufAddr = h), A(g.exports.wpk_fork_unwind_begin, h, s, `${e}: side-module linked fork unwind`), 1 !== I()) throw new Error(`${e}: side-module fork failed to enter UNWINDING`);
				const n = {
					name: e,
					instance: g,
					forkBufAddr: h,
					continuation: f
				};
				y = n, o.sideModuleFork.setActiveFork(n);
				const i = o.sideModuleFork.invokeMainFork([0, 1]);
				if (i < 0) {
					g.exports.wpk_fork_unwind_end(), f.cancelUnwindAndRelease(), o.sideModuleFork.clearActiveFork(n);
					const t = o.loadedLibraries.get(e);
					t && (t.forkBufAddr = void 0), y = null;
				}
				return i;
			}
			if (2 === t) {
				if (g.exports.wpk_fork_rewind_end(), f.finishReplayAndRelease(), 0 !== I()) throw new Error(`${e}: side-module fork failed to finish REWINDING`);
				const t = y ?? {
					name: e,
					instance: g,
					forkBufAddr: h,
					continuation: f
				}, r = o.sideModuleFork.invokeMainFork(0);
				o.sideModuleFork.clearActiveFork(t);
				const n = o.loadedLibraries.get(e);
				return n && (n.forkBufAddr = void 0), y = null, r;
			}
			if (3 === t) {
				const t = f.abortErrno();
				g.exports.wpk_fork_abort_end(), f.finishAbortReplayAndRelease();
				const r = y;
				if (!r) throw new Error(`${e}: side-module abort lost its active fork identity`);
				const n = o.sideModuleFork.invokeMainFork(0);
				o.sideModuleFork.clearActiveFork(r);
				const i = o.loadedLibraries.get(e);
				if (i && (i.forkBufAddr = void 0), y = null, n !== -t) throw new Error(`${e}: main/side continuation abort errno mismatch`);
				return n;
			}
			throw new Error(`${e}: env.fork reached in unexpected state ${t}`);
		}, N = {
			env: new Proxy({}, {
				get(t, r) {
					switch (r) {
						case "memory": return o.memory;
						case "__indirect_function_table": return o.table;
						case "__memory_base": return m;
						case "__table_base": return p;
						case "__stack_pointer": return o.stackPointer;
						case "__c_longjmp": return E;
						case "__cpp_exception": return S;
						case "fork":
							if (d) return B;
							break;
						case "__wpk_fork_frame_reserve":
							if (d) return (t) => {
								const r = f.reserveFrame(t);
								if (0 === r || 0n === r) {
									const t = f.abortErrno();
									o.sideModuleFork.beginMainAbort(t), A(g.exports.wpk_fork_abort_begin, h, s, `${e}: side-module linked fork abort`);
								}
								return r;
							};
							break;
						case "__wpk_fork_frame_commit":
							if (d) return (e) => f.commitFrame(e);
							break;
						case "__wpk_fork_frame_next": if (d) return (e) => f.nextFrame(e);
					}
					const n = o.globalSymbols.get(r);
					return void 0 !== n ? n : v.has(r) ? (...t) => {
						const n = g?.exports[r];
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
				].includes(t) || !("fork" !== t || !d) || !(!u.some((e) => e === t) || !d) || o.globalSymbols.has(t) || v.has(t)
			}),
			"GOT.mem": new Proxy({}, { get: (e, t) => b(t, "mem") }),
			"GOT.func": new Proxy({}, { get: (e, t) => b(t, "func") })
		};
		g = new WebAssembly.Instance(l, N);
		const W = g.exports.__tls_size, P = W instanceof WebAssembly.Global ? Number(W.value) : 0;
		let R;
		if (n.tlsExports.size > 0 && !(W instanceof WebAssembly.Global)) throw new Error(`${e}: TLS exports require an exported __tls_size global`);
		if (!Number.isSafeInteger(P) || P < 0) throw new Error(`${e}: invalid side-module TLS size ${String(P)}`);
		if (P > 0) {
			const t = g.exports.__tls_base, s = g.exports.__tls_align;
			if (!(t instanceof WebAssembly.Global)) throw new Error(`${e}: TLS-bearing side modules must export mutable __tls_base for fork replay`);
			if (!(s instanceof WebAssembly.Global)) throw new Error(`${e}: TLS-bearing side modules must export __tls_align`);
			const a = Number(s.value);
			if (!Number.isSafeInteger(a) || a <= 0 || a & a - 1) throw new Error(`${e}: invalid side-module TLS alignment ${String(a)}`);
			const l = t.value;
			if (typeof l !== (8 === (o.ptrWidth ?? 4) ? "bigint" : "number")) throw new Error(`${e}: __tls_base type does not match the ${8 * (o.ptrWidth ?? 4)}-bit process pointer width`);
			try {
				t.value = l;
			} catch {
				throw new Error(`${e}: exported __tls_base must be mutable for fork replay`);
			}
			if (i) {
				if (!Number.isSafeInteger(i.tlsBase) || i.tlsBase <= 0) throw new Error(`${e}: fork replay is missing a valid side-module TLS base`);
				try {
					t.value = "bigint" == typeof l ? BigInt(i.tlsBase) : i.tlsBase;
				} catch {
					throw new Error(`${e}: exported __tls_base must be mutable for fork replay`);
				}
			}
			if (R = Number(t.value), !Number.isSafeInteger(R) || R <= 0) throw new Error(`${e}: invalid side-module TLS base ${String(R)}`);
			if (R % a !== 0) throw new Error(`${e}: side-module TLS base 0x${R.toString(16)} is not aligned to ${a}`);
			const c = R + P, f = r + n.memorySize;
			if (!Number.isSafeInteger(c) || R < r || c > f) throw new Error(`${e}: TLS range 0x${R.toString(16)}..0x${c.toString(16)} escapes module reservation 0x${r.toString(16)}..0x${f.toString(16)}`);
			if (c > o.memory.buffer.byteLength) throw new Error(`${e}: TLS range 0x${R.toString(16)}..0x${c.toString(16)} exceeds memory`);
		} else if (void 0 !== i?.tlsBase) throw new Error(`${e}: fork replay supplied TLS state for a module without TLS`);
		const F = {};
		for (const [o, i] of Object.entries(g.exports)) if (i instanceof WebAssembly.Global) try {
			i.value = i.value, F[o] = i;
		} catch {
			if ("__tls_size" === o || "__tls_align" === o) {
				F[o] = i;
				continue;
			}
			const t = i.value, s = n.tlsExports.has(o) ? R : r;
			if (void 0 === s) throw new Error(`${e}: TLS export ${o} has no live TLS base`);
			F[o] = new WebAssembly.Global({
				value: "bigint" == typeof t ? "i64" : "i32",
				mutable: !1
			}, "bigint" == typeof t ? t + BigInt(s) : t + s);
		}
		else F[o] = i;
		for (const [n, i] of Object.entries(F)) {
			if (n.startsWith("__")) continue;
			const t = o.globalSymbols.has(n);
			if ("function" == typeof i) {
				const r = D(o.table);
				O(o.table, 1), H(o.table, r, i);
				const a = o.got.get(n);
				a && !t && (a.value = T(r, s, `${e}: GOT.func.${n}`)), t || o.globalSymbols.set(n, i);
			} else if (i instanceof WebAssembly.Global) {
				const r = i.value, a = o.got.get(n);
				a && !t && (a.value = L(r, s, `${e}: GOT.mem.${n}`)), t || o.globalSymbols.set(n, i);
			}
		}
		const z = g.exports.__wasm_apply_data_relocs;
		if (z && z(), !i) {
			const e = g.exports.__wasm_call_ctors;
			e && e();
		}
		const V = {
			instance: g,
			memoryBase: r,
			tableBase: c,
			exports: F,
			metadata: n,
			name: e,
			forkBufAddr: h || void 0,
			forkContinuation: f,
			tlsBase: R,
			forkCapable: d,
			functionImports: _,
			functionExports: k,
			importsDynamicLookup: $
		};
		return o.loadedLibraries.set(e, V), V;
	} catch (te) {
		const e = D(o.table);
		for (let t = I; t < e; t++) try {
			H(o.table, t, null);
		} catch {}
		o.globalSymbols.clear();
		for (const [t, r] of W) o.globalSymbols.set(t, r);
		o.got.clear();
		for (const [t, r] of V) {
			try {
				r.global.value = r.value;
			} catch {}
			o.got.set(t, r.global);
		}
		if (o.heapPointer && void 0 !== B && (o.heapPointer.value = B), o.deallocateMemory) for (const t of Y.reverse()) try {
			o.deallocateMemory(t.addr, t.size);
		} catch {}
		throw te;
	}
	var ee;
}
function ee(e, t, r, n) {
	K(r);
	const o = r.loadedLibraries.get(e);
	if (o) return o;
	const i = function(e) {
		if (e.length < 8) return null;
		if (0 !== e[0] || 97 !== e[1] || 115 !== e[2] || 109 !== e[3]) return null;
		const t = { value: 8 };
		if (t.value >= e.length) return null;
		if (0 !== e[t.value++]) return null;
		const r = F(e, t), n = t.value + r;
		if ("dylink.0" !== z(e, t)) return null;
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
			const r = F(e, t), n = F(e, t), i = t.value + n;
			switch (r) {
				case 1:
					o.memorySize = F(e, t), o.memoryAlign = F(e, t), o.tableSize = F(e, t), o.tableAlign = F(e, t);
					break;
				case 2: {
					const r = F(e, t);
					for (let n = 0; n < r; n++) o.neededDynlibs.push(z(e, t));
					break;
				}
				case 3: {
					const r = F(e, t);
					for (let n = 0; n < r; n++) {
						const r = z(e, t);
						1 & F(e, t) && o.tlsExports.add(r);
					}
					break;
				}
				case 4: {
					const r = F(e, t);
					for (let n = 0; n < r; n++) {
						z(e, t);
						const r = z(e, t);
						2 & F(e, t) && o.weakImports.add(r);
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
		ee(s, t, r);
	}
	return Y(e, t, i, r, n);
}
var te = class e {
	static MAIN_PROGRAM_HANDLE = 1;
	options;
	handleCounter = e.MAIN_PROGRAM_HANDLE + 1;
	handleMap = /* @__PURE__ */ new Map();
	lastError = null;
	constructor(e) {
		K(e), this.options = e;
	}
	dlopenMain() {
		return this.lastError = null, e.MAIN_PROGRAM_HANDLE;
	}
	dlopenSync(e, t, r) {
		try {
			const n = ee(e, t, this.options, r);
			for (const [e, t] of this.handleMap) if (t === n) return e;
			const o = this.handleCounter++;
			return this.handleMap.set(o, n), this.lastError = null, o;
		} catch (n) {
			return this.lastError = n instanceof Error ? n.message : String(n), 0;
		}
	}
	symbolAddress(e, t) {
		if ("function" == typeof t) {
			const e = this.options.table, r = D(e);
			for (let o = 0; o < r; o++) if (G(e, o) === t) return this.lastError = null, o;
			const n = r;
			return O(e, 1), H(e, n, t), this.lastError = null, n;
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
const re = s;
var ne = class extends Error {};
function oe(e, t, r, n) {
	const o = t;
	let i = new DataView(e.buffer);
	i.setInt32(o + 4, re, !0), i.setBigInt64(o + 8 + 0, 0n, !0), i.setBigInt64(o + 8 + 8, BigInt(r), !0), i.setBigInt64(o + 8 + 16, BigInt(3), !0), i.setBigInt64(o + 8 + 24, BigInt(34), !0), i.setBigInt64(o + 8 + 32, -1n, !0), i.setBigInt64(o + 8 + 40, 0n, !0);
	let s = new Int32Array(e.buffer);
	for (Atomics.store(s, (o + 0) / 4, 1), Atomics.notify(s, (o + 0) / 4, 1); "ok" === Atomics.wait(s, (o + 0) / 4, 1););
	i = new DataView(e.buffer), s = new Int32Array(e.buffer);
	const a = Number(i.getBigInt64(o + 56, !0)), l = i.getUint32(o + 64, !0);
	if (Atomics.store(s, (o + 0) / 4, 0), l || a < 0) {
		const e = l || -a;
		throw new x(e, r, `${n}: mmap(${r}) failed errno=${e}`);
	}
	return a;
}
function ie(e, t, r, n, o) {
	const i = t, s = new DataView(e.buffer);
	s.setInt32(i + 4, a, !0), s.setBigInt64(i + 8 + 0, BigInt(r), !0), s.setBigInt64(i + 8 + 8, BigInt(n), !0);
	for (let a = 2; a < 6; a++) s.setBigInt64(i + 8 + 8 * a, 0n, !0);
	const l = new Int32Array(e.buffer);
	for (Atomics.store(l, (i + 0) / 4, 1), Atomics.notify(l, (i + 0) / 4, 1); "ok" === Atomics.wait(l, (i + 0) / 4, 1););
	const c = new DataView(e.buffer), f = new Int32Array(e.buffer), d = Number(c.getBigInt64(i + 56, !0)), u = c.getUint32(i + 64, !0);
	if (Atomics.store(f, (i + 0) / 4, 0), u || d < 0) throw new Error(`${o}: munmap(0x${r.toString(16)}, ${n}) failed errno=${u || -d}`);
}
function se(e, t, r, n, s) {
	const a = r || [], c = n || [], f = new TextEncoder(), d = (e) => "bigint" == typeof e ? Number(e) : e;
	return {
		kernel_get_argc: () => a.length,
		kernel_argv_read: (t, r, n) => {
			if (t >= a.length) return 0;
			const o = f.encode(a[t]), i = Math.min(o.length, n);
			return new Uint8Array(e.buffer, d(r), i).set(o.subarray(0, i)), i;
		},
		kernel_environ_count: () => c.length,
		kernel_environ_get: (t, r, n) => {
			if (t >= c.length) return -1;
			const o = f.encode(c[t]), i = Math.min(o.length, n);
			return new Uint8Array(e.buffer, d(r), i).set(o.subarray(0, i)), i;
		},
		kernel_is_fork_child: () => 0,
		kernel_apply_fork_fd_actions: () => 0,
		kernel_get_fork_exec_path: (e, t) => 0,
		kernel_get_fork_exec_argc: () => 0,
		kernel_get_fork_exec_argv: (e, t, r) => 0,
		kernel_push_argv: (e, t) => {},
		kernel_clear_fork_exec: () => 0,
		kernel_execve: (e) => -38,
		kernel_exit: (r) => {
			const n = new DataView(e.buffer), o = t;
			if (9 === n.getUint32(o + 65560, !0) && 1262835794 === n.getUint32(o + 65584, !0)) throw n.setUint32(o + 65560, 0, !0), n.setUint32(o + 65584, 0, !0), new ne();
			n.setInt32(o + 4, i, !0), n.setBigInt64(o + 8, BigInt(r), !0);
			const a = new Int32Array(e.buffer);
			for (Atomics.store(a, (o + 0) / 4, 1), Atomics.notify(a, (o + 0) / 4, 1); "ok" === Atomics.wait(a, (o + 0) / 4, 1););
			throw s?.(r), new WebAssembly.RuntimeError("unreachable");
		},
		kernel_clone: (r, n, o, i, s, a, c) => {
			const f = l, u = new DataView(e.buffer), h = t;
			u.setInt32(h + 4, f, !0), u.setBigInt64(h + 8 + 0, BigInt(o), !0), u.setBigInt64(h + 8 + 8, BigInt(n), !0), u.setBigInt64(h + 8 + 16, BigInt(s), !0), u.setBigInt64(h + 8 + 24, BigInt(a), !0), u.setBigInt64(h + 8 + 32, BigInt(c), !0), u.setBigInt64(h + 8 + 40, 0n, !0), u.setUint32(h + 72, d(r), !0), u.setUint32(h + 72 + 4, d(i), !0);
			const m = new Int32Array(e.buffer);
			for (Atomics.store(m, (h + 0) / 4, 1), Atomics.notify(m, (h + 0) / 4, 1); "ok" === Atomics.wait(m, (h + 0) / 4, 1););
			const p = Number(u.getBigInt64(h + 56, !0)), w = u.getUint32(h + 64, !0);
			return Atomics.store(m, (h + 0) / 4, 0), w ? -w : p;
		},
		kernel_fork: () => {
			const r = new DataView(e.buffer), n = t;
			r.setInt32(n + 4, o, !0);
			for (let e = 0; e < 6; e++) r.setBigInt64(n + 8 + 8 * e, 0n, !0);
			const i = new Int32Array(e.buffer);
			for (Atomics.store(i, (n + 0) / 4, 1), Atomics.notify(i, (n + 0) / 4, 1); "ok" === Atomics.wait(i, (n + 0) / 4, 1););
			const s = Number(r.getBigInt64(n + 56, !0)), a = r.getUint32(n + 64, !0);
			return Atomics.store(i, (n + 0) / 4, 0), a ? -a : s;
		}
	};
}
const ae = BigInt(Number.MAX_SAFE_INTEGER);
function le(e, t) {
	if ("number" == typeof e && !Number.isSafeInteger(e)) throw new RangeError(`${t}: length is not an exact non-negative JavaScript integer`);
	const r = "bigint" == typeof e ? e : BigInt(e);
	if (r < 0n || r > ae) throw new RangeError(`${t}: length is not an exact non-negative JavaScript integer`);
	return Number(r);
}
function ce(e, t, r, n, o) {
	const i = y(t, n, o), s = le(r, o), a = e.buffer.byteLength;
	if (i > a || s > a - i) throw new RangeError(`${o}: memory range [${i}, ${i + s}) exceeds ${a} bytes`);
	return {
		offset: i,
		length: s
	};
}
function fe(e, t, r, n, o, i, s, l, c, f, d) {
	let u = null;
	const h = /* @__PURE__ */ new Map();
	let m = null;
	const p = new TextDecoder(), w = new TextEncoder(), b = (e) => "bigint" == typeof e ? Number(e) : e, g = 8 === s ? ge : be, _ = r - (8 === s ? me : he), k = r - (8 === s ? we : pe), y = new Int32Array(e.buffer, r - g, 1), v = 8 === s ? ve : ye, $ = (e, t) => 8 === s ? Number(e.getBigUint64(t, !0)) : e.getUint32(t, !0), E = (e, t, r) => {
		8 === s ? e.setBigUint64(t, BigInt(r), !0) : e.setUint32(t, r, !0);
	}, x = () => 8 === s ? Number(Atomics.load(new BigUint64Array(e.buffer, _, 1), 0)) : Atomics.load(new Uint32Array(e.buffer, _, 1), 0), S = /* @__PURE__ */ new Map(), I = /* @__PURE__ */ new Map();
	let B = null, U = 0;
	const M = (r, n) => {
		const o = r + Math.max(n, 1) - 1, i = new DataView(e.buffer), s = t;
		i.setInt32(s + 4, re, !0), i.setBigInt64(s + 8 + 0, 0n, !0), i.setBigInt64(s + 8 + 8, BigInt(o), !0), i.setBigInt64(s + 8 + 16, BigInt(3), !0), i.setBigInt64(s + 8 + 24, BigInt(34), !0), i.setBigInt64(s + 8 + 32, -1n, !0), i.setBigInt64(s + 8 + 40, 0n, !0);
		const a = new Int32Array(e.buffer);
		for (Atomics.store(a, (s + 0) / 4, 1), Atomics.notify(a, (s + 0) / 4, 1); "ok" === Atomics.wait(a, (s + 0) / 4, 1););
		const l = Number(i.getBigInt64(s + 56, !0)), c = i.getUint32(s + 64, !0);
		if (Atomics.store(a, (s + 0) / 4, 0), c || l < 0) throw new Error(`dlopen: mmap(${o}) failed errno=${c || -l}`);
		const f = function(e, t) {
			return Math.ceil(e / t) * t;
		}(b(l), Math.max(n, 1));
		return S.set(f, {
			rawAddr: b(l),
			length: o
		}), f;
	}, N = (r, n) => {
		const o = S.get(r);
		if (!o) throw new Error(`dlopen rollback: unknown allocation 0x${r.toString(16)}`);
		const i = new DataView(e.buffer), s = t;
		i.setInt32(s + 4, a, !0), i.setBigInt64(s + 8 + 0, BigInt(o.rawAddr), !0), i.setBigInt64(s + 8 + 8, BigInt(o.length), !0);
		for (let e = 2; e < 6; e++) i.setBigInt64(s + 8 + 8 * e, 0n, !0);
		const l = new Int32Array(e.buffer);
		for (Atomics.store(l, (s + 0) / 4, 1), Atomics.notify(l, (s + 0) / 4, 1); "ok" === Atomics.wait(l, (s + 0) / 4, 1););
		const c = Number(i.getBigInt64(s + 56, !0)), f = i.getUint32(s + 64, !0);
		if (Atomics.store(l, (s + 0) / 4, 0), f || c < 0) throw new Error(`dlopen rollback: munmap failed errno=${f || -c}`);
		S.delete(r);
	}, W = () => {
		if (u) return u;
		const r = n(), a = o();
		if (!r || !a) throw new Error("dlopen: program has no table or stack pointer");
		const p = new Set([
			"memory",
			"__indirect_function_table",
			"__memory_base",
			"__table_base",
			"__stack_pointer",
			"__c_longjmp",
			"__cpp_exception"
		]), w = /* @__PURE__ */ new Map(), b = i();
		if (b) for (const [e, t] of Object.entries(b.exports)) p.has(e) || ("function" == typeof t || t instanceof WebAssembly.Global) && w.set(e, t);
		const g = new Set(w.keys()), _ = b?.exports.__c_longjmp, y = void 0 === _ ? l : Z(_, "main module export"), v = b?.exports.__cpp_exception, A = void 0 === v ? c : J(v, "main module export"), x = b?.exports.fork, S = b?.exports.wpk_fork_state, I = f && "function" == typeof x && "function" == typeof S ? {
			setActiveFork: (t) => {
				const r = $(new DataView(e.buffer), k);
				if (m || 0 !== r) throw new Error(`${t.name}: nested or concurrent side-module fork is unsupported`);
				m = t;
				const n = h.get(t.name);
				if (!n || n.forkContinuation !== t.continuation) throw new Error(`${t.name}: linked continuation owner mismatch`);
				n.forkBufAddr = t.forkBufAddr, R(t.name, t.forkBufAddr), E(new DataView(e.buffer), k, t.forkBufAddr);
			},
			clearActiveFork: (t) => {
				const r = new DataView(e.buffer), n = $(r, k);
				if (!m || m.name !== t.name || m.instance !== t.instance || m.forkBufAddr !== t.forkBufAddr || n !== t.forkBufAddr) throw new Error(`${t.name}: stale side-module fork identity during rewind`);
				m = null;
				const o = h.get(t.name);
				o && (o.forkBufAddr = void 0), R(t.name, 0), E(r, k, 0);
			},
			invokeMainFork: (e) => {
				const t = Number(x()), r = Number(S()), n = Array.isArray(e) ? e : [e];
				if (!n.includes(r)) throw new Error(`main-module fork transition ended in state ${r}; expected ${n.join(" or ")}`);
				return t;
			},
			beginMainAbort: (e) => {
				if (!d) throw new Error("main-module continuation abort coordinator is unavailable");
				d(e);
			}
		} : void 0;
		return u = new te({
			memory: e,
			table: r,
			stackPointer: a,
			allocateMemory: M,
			deallocateMemory: N,
			allocateContinuation: (r) => oe(e, t, r, "side-module continuation"),
			deallocateContinuation: (r, n) => ie(e, t, r, n, "side-module continuation"),
			globalSymbols: w,
			got: /* @__PURE__ */ new Map(),
			loadedLibraries: h,
			longjmpTag: y,
			cppExceptionTag: A,
			ptrWidth: s,
			mainModuleSymbols: g,
			sideModuleFork: I,
			sideModuleForkUnavailableReason: f ? I ? void 0 : "main module does not export the fork trampoline and wpk_fork_state required for side-module fork" : "main module lacks the versioned dlopen-main fork capability; rebuild it with the current wasm-fork-instrument"
		}), u;
	}, P = (t, r, n, o, i, a) => {
		const l = w.encode(t), c = l.length, f = c + 7 & -8, d = M(v + f + r.length, 8);
		I.set(t, d);
		const u = d + v, h = u + f, m = new DataView(e.buffer);
		8 === s ? (m.setBigUint64(d + 0, 0n, !0), m.setBigUint64(d + 8, BigInt(u), !0), m.setBigUint64(d + 16, BigInt(c), !0), m.setBigUint64(d + 24, BigInt(h), !0), m.setBigUint64(d + 32, BigInt(r.length), !0), m.setBigUint64(d + 40, BigInt(n), !0), m.setBigUint64(d + 48, BigInt(o), !0), m.setBigUint64(d + 56, BigInt(i), !0), m.setBigUint64(d + 64, BigInt(a), !0)) : (m.setUint32(d + 0, 0, !0), m.setUint32(d + 4, u, !0), m.setUint32(d + 8, c, !0), m.setUint32(d + 12, h, !0), m.setUint32(d + 16, r.length, !0), m.setUint32(d + 20, n, !0), m.setUint32(d + 24, o, !0), m.setUint32(d + 28, i, !0), m.setUint32(d + 32, a, !0)), new Uint8Array(e.buffer, u, c).set(l), new Uint8Array(e.buffer, h, r.length).set(r);
		const p = x();
		if (0 === p) return b = d, void (8 === s ? Atomics.store(new BigUint64Array(e.buffer, _, 1), 0, BigInt(b)) : Atomics.store(new Uint32Array(e.buffer, _, 1), 0, b));
		var b;
		let g = p;
		for (;;) {
			const e = $(m, g);
			if (0 === e) return void E(m, g, d);
			g = e;
		}
	}, R = (t, r) => {
		const n = I.get(t);
		if (void 0 === n) throw new Error(`${t}: missing dlopen archive entry for fork continuation`);
		const o = new DataView(e.buffer);
		8 === s ? o.setBigUint64(n + 56, BigInt(r), !0) : o.setUint32(n + 28, r, !0);
	}, F = () => {
		const t = $(new DataView(e.buffer), k);
		if (0 === t) {
			if (m) throw new Error(`${m.name}: active side fork lost its persisted identity`);
			return null;
		}
		if (m) {
			if (m.forkBufAddr !== t) throw new Error(`${m.name}: active side fork buffer identity changed`);
			return m;
		}
		const r = Array.from(h.values()).filter((e) => e.forkBufAddr === t);
		if (1 !== r.length) throw new Error(`fork replay could not resolve active side-module buffer 0x${t.toString(16)}`);
		const n = r[0];
		return m = {
			name: n.name,
			instance: n.instance,
			forkBufAddr: t,
			continuation: n.forkContinuation
		}, m;
	}, z = (e) => Number(e.instance.exports.wpk_fork_state());
	return {
		imports: {
			__wasm_dlopen: (t, r, n, o) => {
				if (!(() => {
					if (U > 0) return U++, !0;
					const e = Atomics.compareExchange(y, 0, _e, ke);
					return 0 !== e ? (B = e > 0 ? "dlopen is temporarily unavailable while pthreads are forking" : "dlopen is temporarily unavailable while another dlopen operation owns the process lock", !1) : (U = 1, !0);
				})()) return 0;
				B = null;
				try {
					const i = ce(e, t, r, s, "__wasm_dlopen bytes"), a = ce(e, n, o, s, "__wasm_dlopen name");
					if (0 === i.length && 0 === a.length) return W().dlopenMain();
					const l = new Uint8Array(e.buffer, i.offset, i.length), c = new Uint8Array(l), f = new Uint8Array(e.buffer, a.offset, a.length), d = new Uint8Array(f), u = p.decode(d), m = W().dlopenSync(u, c);
					if (m > 0) {
						const e = h.get(u);
						if (!e) throw new Error(`__wasm_dlopen(${u}): handle=${m} but loadedLibraries lookup failed`);
						P(u, c, e.memoryBase, e.tableBase, e.forkBufAddr ?? 0, e.tlsBase ?? 0);
					}
					return m;
				} finally {
					(() => {
						if (U <= 0) throw new Error("dlopen process lock released without ownership");
						if (U--, 0 === U) {
							const e = Atomics.compareExchange(y, 0, ke, _e);
							if (e !== ke) throw new Error(`dlopen process lock lost writer ownership (state=${e})`);
							Atomics.notify(y, 0);
						}
					})();
				}
			},
			__wasm_dlsym: (t, r, n) => {
				const o = ce(e, r, n, s, "__wasm_dlsym name"), i = new Uint8Array(e.buffer, o.offset, o.length), a = new Uint8Array(i), l = p.decode(a), c = W().dlsym(t, l);
				return null === c ? 0 : c;
			},
			__wasm_dlclose: (e) => W().dlclose(e),
			__wasm_dlerror: (t, r) => {
				const n = B ?? W().dlerror();
				if (B = null, !n) return 0;
				const o = w.encode(n), i = le(r, "__wasm_dlerror buffer"), a = ce(e, t, Math.min(o.length, i), s, "__wasm_dlerror buffer");
				return new Uint8Array(e.buffer, a.offset, a.length).set(o.subarray(0, a.length)), a.length;
			}
		},
		replayDlopens: () => {
			const t = new DataView(e.buffer);
			let r = x();
			if (0 === r) return;
			const n = W();
			for (; 0 !== r;) {
				let o, i, a, l, c, f, d, u, m;
				8 === s ? (o = Number(t.getBigUint64(r + 0, !0)), i = Number(t.getBigUint64(r + 8, !0)), a = Number(t.getBigUint64(r + 16, !0)), l = Number(t.getBigUint64(r + 24, !0)), c = Number(t.getBigUint64(r + 32, !0)), f = Number(t.getBigUint64(r + 40, !0)), d = Number(t.getBigUint64(r + 48, !0)), u = Number(t.getBigUint64(r + 56, !0)), m = Number(t.getBigUint64(r + 64, !0))) : (o = t.getUint32(r + 0, !0), i = t.getUint32(r + 4, !0), a = t.getUint32(r + 8, !0), l = t.getUint32(r + 12, !0), c = t.getUint32(r + 16, !0), f = t.getUint32(r + 20, !0), d = t.getUint32(r + 24, !0), u = t.getUint32(r + 28, !0), m = t.getUint32(r + 32, !0));
				const w = p.decode(new Uint8Array(new Uint8Array(e.buffer, i, a)));
				I.set(w, r);
				const b = new Uint8Array(new Uint8Array(e.buffer, l, c));
				if (0 === n.dlopenSync(w, b, {
					memoryBase: f,
					tableBase: d,
					forkBufAddr: u || void 0,
					tlsBase: 0 === m ? void 0 : m
				})) throw new Error(`dlopen(${w}): ${n.dlerror() || "unknown"}`);
				if (0 !== u) {
					const e = h.get(w);
					if (!e || e.forkBufAddr !== u) throw new Error(`${w}: fork replay restored a mismatched save buffer`);
				}
				if (0 !== m) {
					const e = h.get(w);
					if (!e || e.tlsBase !== m) throw new Error(`${w}: fork replay restored a mismatched TLS base`);
				}
				r = o;
			}
		},
		completeSideModuleForkUnwind: () => {
			const e = F();
			e && function(e, t) {
				const r = () => Number(t.instance.exports.wpk_fork_state());
				if (1 !== r()) throw new Error(`${t.name}: expected UNWINDING before side-module unwind completion`);
				if (t.instance.exports.wpk_fork_unwind_end(), 0 !== r()) throw new Error(`${t.name}: side-module unwind did not return to NORMAL`);
				t.continuation.finishUnwind();
			}(0, e);
		},
		beginSideModuleForkRewind: () => {
			const e = F();
			if (e) {
				if (0 !== z(e)) throw new Error(`${e.name}: expected NORMAL before side-module rewind`);
				if (e.continuation.hasActiveContinuation() ? e.continuation.beginReplay() : e.continuation.attachForReplay(8 === s ? BigInt(e.forkBufAddr) : e.forkBufAddr), A(e.instance.exports.wpk_fork_rewind_begin, e.forkBufAddr, s, `${e.name}: side-module linked fork rewind`), 2 !== z(e)) throw new Error(`${e.name}: side-module rewind did not enter REWINDING`);
			}
		},
		beginSideModuleForkAbort: (e) => {
			const t = F();
			if (t) {
				if (1 !== z(t)) throw new Error(`${t.name}: expected UNWINDING before side-module abort replay`);
				if (t.continuation.beginAbortReplay(e), A(t.instance.exports.wpk_fork_abort_begin, t.forkBufAddr, s, `${t.name}: side-module linked fork abort`), 3 !== z(t)) throw new Error(`${t.name}: side-module abort did not enter ABORT_UNWINDING`);
			}
		},
		assertNoActiveSideModuleFork: () => {
			const t = $(new DataView(e.buffer), k);
			if (m || 0 !== t) throw new Error(`${m?.name ?? "unknown side module"}: main image returned with an active side-module fork`);
		},
		resetForkChildLock: () => {
			Atomics.store(y, 0, 0), Atomics.notify(y, 0);
		}
	};
}
function de(e, t, n, o, i, s, a = 4, l, c, f, d, u) {
	const h = { memory: t }, m = (e) => "bigint" == typeof e ? Number(e) : e, p = (e) => 8 === a ? BigInt(e) : e, w = WebAssembly.Module.imports(e), b = r.filter(({ module: e }) => "env" === e), g = b.filter(({ name: e }) => ((e) => w.some((t) => "env" === t.module && t.name === e && "function" === t.kind))(e)).length;
	if (0 !== g && g !== b.length) throw new Error("incomplete linked fork instrumentation imports; rebuild the program");
	if (0 !== g) {
		if (!d) throw new Error("linked fork instrumentation requested without continuation storage");
		h.__wpk_fork_frame_reserve = (e) => {
			const t = d.reserveFrame(e);
			return 0 !== t && 0n !== t || u?.(), t;
		}, h.__wpk_fork_frame_commit = (e) => d.commitFrame(e), h.__wpk_fork_frame_next = (e) => d.nextFrame(e);
	}
	if (w.some((e) => "env" === e.module && "__channel_base" === e.name && "global" === e.kind) && (h.__channel_base = 8 === a ? new WebAssembly.Global({
		value: "i64",
		mutable: !0
	}, BigInt(o)) : new WebAssembly.Global({
		value: "i32",
		mutable: !0
	}, o)), w.some((e) => "env" === e.module && "__c_longjmp" === e.name && "tag" === e.kind) && (h.__c_longjmp = Z(l, "process module")), w.some((e) => "env" === e.module && "__cpp_exception" === e.name && "tag" === e.kind) && (h.__cpp_exception = J(c, "process module")), i && Object.assign(h, i), w.some((e) => "env" === e.module && "__wasm_posix_vm_interrupt_after" === e.name && "function" === e.kind)) {
		if (!f) throw new Error("VM interrupt timer import requested without a host timer route");
		h.__wasm_posix_vm_interrupt_after = (e, t, r) => {
			f(m(e), m(t), m(r));
		};
	}
	if (s) {
		const e = (e) => {
			const t = s()?.exports.malloc;
			return t ? t(e || (8 === a ? 1n : 1)) : 8 === a ? 0n : 0;
		}, t = (e) => {
			const t = s()?.exports.free;
			t && t(e);
		};
		h._Znwm = e, h._Znam = e, h._ZdlPv = t, h._ZdlPvm = t, h._ZdaPv = t, h._ZdaPvm = t, h._ZnwmRKSt9nothrow_t = e, h._ZnamRKSt9nothrow_t = e;
	}
	h.__cxa_guard_acquire = (e) => new Uint8Array(t.buffer)[m(e)] ? 0 : 1, h.__cxa_guard_release = (e) => {
		new Uint8Array(t.buffer)[m(e)] = 1;
	}, h.__cxa_guard_abort = (e) => {}, h.__cxa_pure_virtual = () => {
		throw new Error("pure virtual method called");
	}, h.__cxa_atexit = () => 0, h.__cxa_thread_atexit = () => 0, h._ZNSt3__122__libcpp_verbose_abortEPKcz = (e, t) => {
		throw new Error("libc++ verbose abort");
	}, h._ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_ = (e, t, r) => {
		throw new Error("libc++ sort called unexpectedly");
	};
	const _ = /* @__PURE__ */ new Map();
	h.__dynamic_cast = (e, r, n, o) => {
		const i = m(e), s = m(n);
		if (0 === i) return p(0);
		const l = new DataView(t.buffer), c = t.buffer.byteLength, f = a, d = (e) => 8 === f ? Number(l.getBigUint64(e, !0)) : l.getUint32(e, !0), u = d(i);
		if (0 === u || u >= c) return p(0);
		if (u < 2 * f) return p(0);
		const h = d(u - f);
		if (0 === h || h >= c) return p(0);
		const w = (b = u - 2 * f, 8 === f ? Number(l.getBigInt64(b, !0)) : l.getInt32(b, !0));
		var b;
		if (h === s) return p(i + w);
		const g = 2 * f, k = f + f, y = _, v = (e, t, r) => {
			if (e === t) return !0;
			if (0 === e || e >= c || r.has(e)) return !1;
			if (r.add(e), e + g + f > c) return !1;
			const n = y.get(e);
			if (0 === n) return !1;
			if (1 === n) return v(d(e + g), t, r);
			if (2 === n) {
				const n = l.getUint32(e + g + 4, !0);
				for (let o = 0; o < n; o++) {
					const n = d(e + g + 8 + o * k);
					if (n > 0 && v(n, t, r)) return !0;
				}
				return !1;
			}
			const o = d(e + g);
			if (o > 256 && o + f <= c) {
				const n = d(o + f);
				if (n > 0 && n < c) {
					if (y.set(e, 1), v(o, t, r)) return !0;
					y.delete(e);
				}
			}
			if (l.getUint32(e + g, !0) <= 3 && e + g + 8 <= c) {
				const n = l.getUint32(e + g + 4, !0);
				if (n > 0 && n < 100 && e + g + 8 + n * k <= c) {
					y.set(e, 2);
					for (let o = 0; o < n; o++) {
						const n = d(e + g + 8 + o * k);
						if (n > 0 && v(n, t, r)) return !0;
					}
					return !1;
				}
			}
			return y.set(e, 0), !1;
		};
		return v(h, s, /* @__PURE__ */ new Set()) ? p(i + w) : p(0);
	}, h._ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_ = (e, r) => {
		const n = m(e), o = m(r), i = new DataView(t.buffer), s = (o - n) / 8, a = [];
		for (let t = 0; t < s; t++) a.push(i.getBigUint64(n + 8 * t, !0));
		a.sort((e, t) => e < t ? -1 : e > t ? 1 : 0);
		for (let t = 0; t < s; t++) i.setBigUint64(n + 8 * t, a[t], !0);
	};
	for (const r of WebAssembly.Module.imports(e)) "function" === r.kind && ("env" === r.module ? h[r.name] || (h[r.name] = (...e) => {
		throw new Error(`Unimplemented import: env.${r.name}`);
	}) : "kernel" === r.module && (n[r.name] || (n[r.name] = (...e) => 0)));
	const k = { env: h };
	return Object.keys(n).length > 0 && (k.kernel = n), k;
}
const ue = 61440;
const he = 12, me = 24, pe = 16, we = 32, be = 20, ge = 40;
if (Math.max(he, me, pe, we, be, ge) > 4096) throw new Error("invalid fork-save scratch-page geometry");
const _e = 0, ke = -1, ye = 40, ve = 72, $e = n.map(({ name: e }) => e);
function Ee(e, t) {
	const r = new Set(e.map((e) => e.name)), n = [...r].filter((e) => e.startsWith("asyncify_"));
	if (n.length > 0) throw new Error(`pid=${t}: user program exports legacy Asyncify instrumentation (${n.join(", ")}). This host requires wasm-fork-instrument artifacts exporting wpk_fork_*; rebuild the package for the current ABI.`);
	const o = $e.filter((e) => r.has(e));
	if (o.length > 0 && o.length !== $e.length) {
		const e = $e.filter((e) => !r.has(e));
		throw new Error(`pid=${t}: incomplete wasm-fork-instrument exports; missing ${e.join(", ")}. Rebuild the package for the current ABI.`);
	}
	return o.length === $e.length;
}
function Ae(e, t, r) {
	if (void 0 === t) return;
	const n = function(e) {
		return b(e, "__abi_version");
	}(e);
	if (null !== n) {
		if (n !== t) throw new Error(`pid=${r}: ABI version mismatch — kernel advertises ${t}, user program built against ${n}. Rebuild the program against the current kernel, or roll back the kernel to the matching version. See docs/abi-versioning.md.`);
	} else xe || (xe = !0, console.warn(`[worker] pid=${r}: user program lacks __abi_version export — legacy binary predates ABI marker rollout. Rebuild against the current glue (channel_syscall.c) to pick up the check. See docs/abi-versioning.md.`));
}
let xe = !1;
async function Se(e, t) {
	try {
		const { memory: n, programBytes: o, channelOffset: i, pid: s } = t, a = t.ptrWidth ?? 4, l = t.programModule ? t.programModule : await WebAssembly.compile(o);
		if (function(e) {
			return WebAssembly.Module.imports(e).some((e) => "wasi_snapshot_preview1" === e.module);
		}(l)) {
			if (function(e) {
				return WebAssembly.Module.exports(e).some((e) => "memory" === e.name && "memory" === e.kind);
			}(l)) throw new Error("WASI module defines its own memory. Only modules that import memory (compiled with --import-memory) are supported.");
			const { WasiShim: o, WasiExit: a } = await import("./wasi-shim-CBb9kywE.js"), c = new o(n, i, t.argv || [], t.env || []), f = {
				wasi_snapshot_preview1: c.getImports(),
				env: { memory: n }
			}, d = WebAssembly.Module.imports(l);
			for (const e of d) "env" === e.module && "memory" !== e.name && (f.env[e.name] || (f.env[e.name] = "function" === e.kind ? (...t) => {
				throw new Error(`Unimplemented WASI env import: ${e.name}`);
			} : void 0));
			const u = await WebAssembly.instantiate(l, f);
			c.init(), e.postMessage({
				type: "ready",
				pid: s
			});
			let h = 0;
			try {
				const e = u.exports._start;
				e && e();
			} catch (r) {
				if (!(r instanceof a)) throw r;
				h = r.code;
			}
			e.postMessage({
				type: "exit",
				pid: s,
				status: h
			});
			return;
		}
		const c = j(a), f = q(a);
		let d = null;
		const u = se(n, i, t.argv || [], t.env || [], (e) => {
			d = e;
		}), h = Ee(WebAssembly.Module.exports(l), s), m = R(P(l), 2);
		let p = 0, w = t.forkBufAddr ?? 0;
		const b = i - ue;
		if (h) {
			const h = new M(n, U(l), (e) => oe(n, i, e, `pid=${s}`), (e, t) => ie(n, i, e, t, `pid=${s}`), `pid=${s}`);
			let g = null;
			u.kernel_fork = () => {
				if (!g) return -38;
				const e = (0, g.exports.wpk_fork_state)();
				if (2 === e) return g.exports.wpk_fork_rewind_end(), h.finishReplayAndRelease(), S(n, b, a, 0), w = 0, p;
				if (3 === e) {
					const e = h.abortErrno();
					return g.exports.wpk_fork_abort_end(), h.finishAbortReplayAndRelease(), S(n, b, a, 0), w = 0, -e;
				}
				try {
					w = Number(h.beginUnwind());
				} catch (t) {
					if (t instanceof x) return -t.errno;
					throw t;
				}
				return S(n, b, a, w), A(g.exports.wpk_fork_unwind_begin, w, a, `pid=${s}: linked fork unwind`), 0;
			};
			const _ = fe(n, i, b, () => g?.exports.__indirect_function_table, () => g?.exports.__stack_pointer, () => g ?? void 0, a, c, f, m, (e) => {
				if (!g) throw new Error(`pid=${s}: side abort before main instantiation`);
				h.beginAbortReplay(e), A(g.exports.wpk_fork_abort_begin, w, a, `pid=${s}: linked fork abort`);
			}), k = de(l, n, u, i, _.imports, () => g ?? void 0, a, c, f, (t, r, n) => {
				e.postMessage({
					type: "vm_interrupt_timer",
					pid: s,
					timedOutPtr: t,
					vmInterruptPtr: r,
					seconds: n
				});
			}, h, () => {
				if (!g) throw new Error(`pid=${s}: continuation abort before instantiation`);
				const e = h.abortErrno();
				_.beginSideModuleForkAbort(e), A(g.exports.wpk_fork_abort_begin, w, a, `pid=${s}: linked fork abort`);
			}), y = await WebAssembly.instantiate(l, k);
			g = y, t.isForkChild && _.resetForkChildLock(), Ae(o, t.kernelAbiVersion, s), t.isForkChild || Ie(y, l, n, i, o, a), e.postMessage({
				type: "ready",
				pid: s
			});
			let v = 0;
			try {
				const e = y.exports._start, c = y.exports.wpk_fork_state, f = y.exports.wpk_fork_unwind_end;
				let m = !!t.isForkChild;
				m && (p = 0);
				let b, g = !1, k = !1;
				if (t.isForkChild && null != t.forkChildThreadFnPtr) {
					const e = y.exports.__indirect_function_table;
					if (!e) throw new Error("Fork-from-thread child: no __indirect_function_table export");
					const r = t.forkChildThreadFnPtr, n = 8 === a ? BigInt(r) : r, o = e.get(n);
					if (!o) throw new Error(`Fork-from-thread child: thread function at index ${r} is null`);
					const i = t.forkChildThreadArgPtr ?? 0, s = 8 === a ? BigInt(i) : i;
					b = () => {
						o(s);
					};
				} else b = e;
				for (;;) {
					if (m) {
						const e = t.isForkChild && !k && null != t.forkBufAddr ? t.forkBufAddr : w;
						if (t.isForkChild && !k ? (h.attachForReplay(8 === a ? BigInt(e) : e), k = !0) : h.beginReplay(), A(y.exports.wpk_fork_rewind_begin, e, a, `pid=${s}: linked fork rewind`), Ie(y, l, n, i, o, a), t.isForkChild && !g) {
							try {
								_.replayDlopens();
							} catch (r) {
								throw new Error(`fork-replay-dlopen failed: ${r instanceof Error ? r.message : String(r)}`);
							}
							g = !0;
						}
						_.beginSideModuleForkRewind(), m = !1;
					}
					try {
						b();
					} catch (r) {
						if (r instanceof Error && r.message.includes("unreachable") && null !== d) {
							v = d;
							break;
						}
						throw r;
					}
					if (1 === c()) {
						f(), h.finishUnwind(), _.completeSideModuleForkUnwind();
						const e = Be(n, i);
						if (e < 0) {
							p = e, m = !0;
							continue;
						}
						p = e, m = !0;
						continue;
					}
					_.assertNoActiveSideModuleFork(), null === d && (u.kernel_exit(0), v = d ?? 0);
					break;
				}
			} catch (r) {
				if (!(r instanceof Error && r.message.includes("unreachable") && null !== d)) throw r;
				v = d;
			}
			e.postMessage({
				type: "exit",
				pid: s,
				status: v
			});
		} else {
			u.kernel_fork = () => {
				throw new Error(`pid=${s}: kernel_fork reached without complete wasm-fork-instrument exports. Rebuild the program with scripts/run-wasm-fork-instrument.sh.`);
			};
			let h = null;
			const m = de(l, n, u, i, fe(n, i, b, () => h?.exports.__indirect_function_table, () => h?.exports.__stack_pointer, () => h ?? void 0, a, c, f, !1).imports, () => h ?? void 0, a, c, f, (t, r, n) => {
				e.postMessage({
					type: "vm_interrupt_timer",
					pid: s,
					timedOutPtr: t,
					vmInterruptPtr: r,
					seconds: n
				});
			}), p = await WebAssembly.instantiate(l, m);
			h = p, Ae(o, t.kernelAbiVersion, s), Ie(p, l, n, i, o, a), e.postMessage({
				type: "ready",
				pid: s
			});
			let w = 0;
			try {
				const e = p.exports._start;
				e && e(), null !== d && (w = d);
			} catch (r) {
				if (!(r instanceof Error && r.message.includes("unreachable"))) throw r;
				if (null === d) throw r;
				w = d;
			}
			null === d && (u.kernel_exit(w), w = d ?? w), e.postMessage({
				type: "exit",
				pid: s,
				status: w
			});
		}
	} catch (n) {
		if (n instanceof ne) return void e.postMessage({
			type: "exec_retired",
			pid: t.pid
		});
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
function Ie(e, t, r, n, o, i = 4) {
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
					const a = t[e++], [l, c] = r(t, e);
					if (e += c, 0 === a && "__get_channel_base_addr" === i) {
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
				const [s, c] = r(t, e);
				e += c;
				for (let o = 0; o < s; o++) {
					const [, n] = r(t, e);
					e += n, e++;
				}
				const f = 65, d = 66;
				if (t[e] === f || t[e] === d) {
					e++;
					const [n] = r(t, e);
					return n;
				}
				if (35 === t[e]) {
					let n = e + 1;
					const [, o] = r(t, n);
					if (n += o, t[n] === f || t[n] === d) {
						n++;
						const [e] = r(t, n);
						return e;
					}
				}
				if (16 !== t[e]) return -1;
				e++;
				const [, u] = r(t, e);
				if (e += u, 16 !== t[e]) return -1;
				e++;
				const [h] = r(t, e), m = h - o;
				if (m < 0) return -1;
				let p = l.contentOffset;
				const [, w] = r(t, p);
				p += w;
				for (let o = 0; o < m; o++) {
					const [e, n] = r(t, p);
					p += n + e;
				}
				const [, b] = r(t, p);
				p += b;
				const [g, _] = r(t, p);
				p += _;
				for (let o = 0; o < g; o++) {
					const [, e] = r(t, p);
					p += e, p++;
				}
				if (t[p] !== f && t[p] !== d) return -1;
				p++;
				const [k] = r(t, p);
				return k;
			}
			return -1;
		}(o));
		const t = l + (e >= 0 ? e : 0);
		8 === i ? a.setBigUint64(t, BigInt(n), !0) : a.setUint32(t, n, !0);
	}
}
function Be(e, t) {
	const r = new DataView(e.buffer);
	r.setInt32(t + 4, o, !0);
	for (let o = 0; o < 6; o++) r.setBigInt64(t + 8 + 8 * o, 0n, !0);
	const n = new Int32Array(e.buffer);
	for (Atomics.store(n, (t + 0) / 4, 1), Atomics.notify(n, (t + 0) / 4, 1); "ok" === Atomics.wait(n, (t + 0) / 4, 1););
	const i = Number(r.getBigInt64(t + 56, !0)), s = r.getUint32(t + 64, !0);
	return Atomics.store(n, (t + 0) / 4, 0), s ? -s : i;
}
async function Ue(e, t) {
	const { memory: r, processChannelOffset: n, channelOffset: o, pid: s, tid: a, fnPtr: l, argPtr: c, stackPtr: f, tlsPtr: d, ctidPtr: u } = t, h = t.tlsOffset ?? t.tlsAllocAddr, m = t.ptrWidth ?? 4;
	let p, w, b = !1;
	const g = () => {
		if (b && w) for (;;) {
			const e = Atomics.load(w, 0);
			if (e <= _e) throw b = !1, /* @__PURE__ */ new Error(`pid=${s} tid=${a}: pthread fork lost reader ownership (state=${e})`);
			if (Atomics.compareExchange(w, 0, e, e - 1) === e) return b = !1, void (1 === e && Atomics.notify(w, 0));
		}
	};
	try {
		let u = null;
		t.programModule || (u = function(e) {
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
				const e = t[a], [n, i] = r(t, a + 1), l = a + 1 + i, c = 1 + i + n;
				o.push({
					id: e,
					offset: a,
					totalSize: c,
					contentOffset: l,
					contentSize: n
				}), 8 === e && (s = !0), a += c;
			}
			if (!s) return e;
			for (const k of o) if (2 === k.id) {
				let e = k.contentOffset;
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
			let l = -1, c = [];
			const f = /* @__PURE__ */ new Map();
			for (const k of o) if (7 === k.id) {
				let e = k.contentOffset;
				const [n, o] = r(t, e);
				e += o;
				for (let i = 0; i < n; i++) {
					const [n, o] = r(t, e);
					e += o;
					const i = new TextDecoder().decode(t.subarray(e, e + n));
					e += n;
					const s = t[e++], [a, l] = r(t, e);
					e += l, 0 === s && (c.push(a), f.set(i, a));
				}
				break;
			}
			function d(e) {
				const [, n] = r(t, e);
				return e + n;
			}
			function u(e) {
				return e = d(e), d(e);
			}
			function h(e, n) {
				const o = n - i;
				if (o < 0) return null;
				let s = e.contentOffset;
				const [a, l] = r(t, s);
				if (s += l, o >= a) return null;
				for (let i = 0; i < o; i++) {
					const [e, n] = r(t, s);
					s += n + e;
				}
				const [c, f] = r(t, s);
				s += f;
				const u = s + c, [h, m] = r(t, s);
				s += m;
				for (let t = 0; t < h; t++) s = d(s), s++;
				return {
					start: s,
					end: u
				};
			}
			function m(e, n) {
				const o = h(e, n);
				if (!o) return [];
				const i = [];
				let s = o.start;
				for (; s < o.end;) {
					const e = t[s++];
					if (16 === e) {
						const [e, n] = r(t, s);
						s += n, i.push(e);
					} else if (17 === e || 19 === e) s = d(s), s = d(s);
					else if (18 === e || 20 === e || 21 === e) s = d(s);
					else if (2 === e || 3 === e || 4 === e) s = 64 === t[s] || t[s] >= 112 ? s + 1 : d(s);
					else if (12 === e || 13 === e || e >= 32 && e <= 38 || 208 === e || 210 === e) s = d(s);
					else if (14 === e) {
						const [e, n] = r(t, s);
						s += n;
						for (let t = 0; t <= e; t++) s = d(s);
					} else if (e >= 40 && e <= 62) s = u(s);
					else if (63 === e || 64 === e) s++;
					else if (65 === e || 66 === e) s = d(s);
					else if (67 === e) s += 4;
					else if (68 === e) s += 8;
					else if (252 === e) {
						const [e, n] = r(t, s);
						s += n, 8 === e || 10 === e || 12 === e || 14 === e ? s = d(d(s)) : e >= 9 && e <= 17 && (s = d(s));
					} else if (254 === e) s = d(s), s = u(s);
					else if (253 === e) break;
				}
				return i;
			}
			for (const k of o) if (10 === k.id && c.length > 0) {
				const e = [
					"__wasm_init_tls",
					"__abi_version",
					"__get_channel_base_addr",
					"_start",
					"__wasm_thread_init"
				], n = /* @__PURE__ */ new Map();
				let o = 0;
				for (const t of e) {
					const e = f.get(t);
					if (void 0 === e) continue;
					const r = new Set(m(k, e).filter((e) => e >= i));
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
				else for (const a of c) {
					const e = h(k, a);
					if (!e || 16 !== t[e.start]) continue;
					const [n] = r(t, e.start + 1);
					if (n >= i) {
						l = n;
						break;
					}
				}
				break;
			}
			const p = l >= 0 ? l - i : -1, w = [];
			w.push(t.subarray(0, 8));
			for (const k of o) if (8 !== k.id) if (10 === k.id && p >= 0) {
				let e = k.contentOffset;
				const [o, i] = r(t, e);
				e += i;
				let s = e;
				for (let n = 0; n < p; n++) {
					const [e, n] = r(t, s);
					s += n + e;
				}
				const [a, l] = r(t, s), c = s + l + a, f = new Uint8Array([
					2,
					0,
					11
				]), d = s - k.contentOffset, u = k.contentOffset + k.contentSize - c, h = n(d + f.length + u);
				w.push(new Uint8Array([10])), w.push(new Uint8Array(h)), w.push(t.subarray(k.contentOffset, s)), w.push(f), w.push(t.subarray(c, k.contentOffset + k.contentSize));
			} else w.push(t.subarray(k.offset, k.offset + k.totalSize));
			const b = w.reduce((e, t) => e + t.length, 0), g = new Uint8Array(b);
			let _ = 0;
			for (const k of w) g.set(k, _), _ += k.length;
			return g.buffer;
		}(t.programBytes));
		const k = t.programModule ? t.programModule : new WebAssembly.Module(u), y = Ee(WebAssembly.Module.exports(k), s);
		let v = 0;
		const $ = o - ue, E = y ? new M(r, U(k), (e) => oe(r, o, e, `pid=${s} tid=${a}`), (e, t) => ie(r, o, e, t, `pid=${s} tid=${a}`), `pid=${s} tid=${a}`) : null, I = n - ue - (8 === m ? me : he), B = n - ue - (8 === m ? ge : be);
		if (!Number.isSafeInteger(I) || I <= 0 || I + m > r.buffer.byteLength || !Number.isSafeInteger(B) || B <= 0 || B + 4 > r.buffer.byteLength) throw new Error(`pid=${s} tid=${a}: invalid process dlopen archive anchor ${String(I)}`);
		w = new Int32Array(r.buffer, B, 1);
		const N = () => 8 === m ? 0n !== Atomics.load(new BigUint64Array(r.buffer, I, 1), 0) : 0 !== Atomics.load(new Uint32Array(r.buffer, I, 1), 0);
		let W = 0, P = null;
		const R = se(r, o, void 0, void 0, (e) => {
			P = e;
		});
		R.kernel_fork = y ? () => {
			if (!p) return -38;
			const e = (0, p.exports.wpk_fork_state)();
			if (2 === e) {
				try {
					p.exports.wpk_fork_rewind_end(), E.finishReplayAndRelease(), S(r, $, m, 0), v = 0;
				} finally {
					g();
				}
				return W;
			}
			if (3 === e) {
				const e = E.abortErrno();
				try {
					p.exports.wpk_fork_abort_end(), E.finishAbortReplayAndRelease(), S(r, $, m, 0), v = 0;
				} finally {
					g();
				}
				return -e;
			}
			if (!(() => {
				if (!w) throw new Error(`pid=${s} tid=${a}: missing process dlopen lock`);
				if (b) throw new Error(`pid=${s} tid=${a}: pthread fork lock already held`);
				for (;;) {
					const e = Atomics.load(w, 0);
					if (e < _e) return !1;
					if (e >= 2147483647) throw new Error(`pid=${s} tid=${a}: process dlopen lock reader overflow`);
					if (Atomics.compareExchange(w, 0, e, e + 1) === e) return b = !0, !0;
				}
			})()) return -95;
			if (N()) return g(), -95;
			try {
				v = Number(E.beginUnwind()), S(r, $, m, v), A(p.exports.wpk_fork_unwind_begin, v, m, `pid=${s} tid=${a}: linked fork unwind`);
			} catch (t) {
				if (g(), t instanceof x) return -t.errno;
				throw t;
			}
			return 0;
		} : () => {
			if (N()) return -95;
			throw new Error(`pid=${s} tid=${a}: kernel_fork reached without complete wasm-fork-instrument exports. Rebuild the program with scripts/run-wasm-fork-instrument.sh.`);
		};
		const F = j(m), z = q(m), T = de(k, r, R, o, function(e) {
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
		}(r), () => p, m, F, z, (t, r, n) => {
			e.postMessage({
				type: "vm_interrupt_timer",
				pid: s,
				timedOutPtr: t,
				vmInterruptPtr: r,
				seconds: n
			});
		}, E ?? void 0, () => {
			if (!p) throw new Error(`pid=${s} tid=${a}: continuation abort before instantiation`);
			A(p.exports.wpk_fork_abort_begin, v, m, `pid=${s} tid=${a}: linked fork abort`);
		}), L = new WebAssembly.Instance(k, T);
		p = L;
		const C = L.exports.__wasm_init_tls, D = h;
		C && D > 0 && C(8 === m ? BigInt(D) : D);
		const O = L.exports.__stack_pointer;
		O && (O.value = 8 === m ? BigInt(f) : f);
		const G = L.exports.__wasm_thread_init;
		G && d > 0 && G(8 === m ? BigInt(d) : d), Ie(L, k, r, o, t.programBytes, m);
		const H = L.exports.__indirect_function_table;
		if (!H) throw new Error("No __indirect_function_table export — cannot call thread function");
		const V = 8 === m ? BigInt(l) : l, Z = H.get(V);
		if (!Z) throw new Error(`Thread function at table index ${l} is null`);
		const J = 8 === m ? BigInt(c) : c;
		let K = 0;
		if (y) {
			const e = L.exports.wpk_fork_state, t = L.exports.wpk_fork_unwind_end;
			let n = !1;
			for (;;) {
				n && (E.beginReplay(), A(L.exports.wpk_fork_rewind_begin, v, m, `pid=${s} tid=${a}: linked fork rewind`), n = !1);
				try {
					const e = Z(J);
					K = Number(e);
				} catch (_) {
					if (_ instanceof Error && _.message.includes("unreachable") && null !== P) {
						K = P;
						break;
					}
					throw _;
				}
				if (1 === e()) {
					if (t(), E.finishUnwind(), N()) {
						W = -95, n = !0;
						continue;
					}
					const e = Be(r, o);
					if (e < 0) {
						W = e, n = !0;
						continue;
					}
					W = e, n = !0;
					continue;
				}
				break;
			}
		} else try {
			const e = Z(J);
			K = Number(e);
		} catch (_) {
			if (!(_ instanceof Error && _.message.includes("unreachable") && null !== P)) throw _;
			K = P;
		}
		if (g(), null === P) {
			const e = new DataView(r.buffer), t = o;
			e.setInt32(t + 4, i, !0), e.setInt32(t + 8, K ?? 0, !0);
			const n = new Int32Array(r.buffer);
			for (Atomics.store(n, (t + 0) / 4, 1), Atomics.notify(n, (t + 0) / 4, 1); "ok" === Atomics.wait(n, (t + 0) / 4, 1););
		}
		e.postMessage({
			type: "thread_exit",
			pid: s,
			tid: a
		});
	} catch (k) {
		if (g(), k instanceof ne) return void e.postMessage({
			type: "exec_retired",
			pid: s,
			tid: a
		});
		const t = k instanceof Error ? `${k.message}\n${k.stack ?? ""}` : String(k);
		e.postMessage({
			type: "error",
			pid: s,
			message: `Thread worker failed: ${t}`
		});
	}
}
async function Me(e, t, r, n) {
	try {
		await r();
	} catch (o) {
		try {
			n(o);
		} catch {}
	} finally {
		try {
			e.postMessage({
				type: "memory_quiescent",
				pid: t.pid,
				...void 0 === t.tid ? {} : { tid: t.tid }
			});
		} finally {
			e.close();
		}
	}
}
const Ne = globalThis;
Ne.onmessage = (e) => {
	const t = e.data, r = {
		postMessage: (e, t) => Ne.postMessage(e, t),
		on: (e, t) => {
			"message" === e && (Ne.onmessage = (e) => t(e.data));
		},
		close: () => Ne.close()
	};
	if ("centralized_init" === t.type) {
		const t = e.data;
		Me(r, { pid: t.pid }, () => Se(r, t), (e) => console.error(`[worker-entry-browser] worker main error pid=${t.pid}`, e));
	} else {
		if ("centralized_thread_init" !== t.type) throw new Error(`Unknown worker init type: ${t.type}`);
		{
			const t = e.data;
			Me(r, {
				pid: t.pid,
				tid: t.tid
			}, () => Ue(r, t), (e) => console.error(`[worker-entry-browser] thread worker main error pid=${t.pid} tid=${t.tid}`, e));
		}
	}
};
