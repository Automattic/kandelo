import { i as t, r as s } from "./worker-entry-browser-DWVGG2Nd.js";
const n = s.Close;
s.Read, s.Write;
const r = s.Seek, a = s.Fstat, o = s.Fcntl, h = s.Getpid, d = s.Exit, c = s.Kill, l = s.ClockGettime, f = s.Poll, g = s.Sendto, _ = s.Recvfrom, u = s.Pread, m = s.Pwrite, y = s.Openat, b = s.Ftruncate, U = s.Fsync, p = s.Writev, w = s.Readv, B = s.Fdatasync, I = s.Fstatat, A = s.Unlinkat, k = s.Mkdirat, S = s.Renameat, v = s.Linkat, D = s.Symlinkat, V = s.Readlinkat, P = s.Getrandom, F = s.Getdents64, M = s.ClockGetres, N = s.Utimensat, W = s.SchedYield, x = s.Fallocate, z = s.Dup2, O = s.Shutdown, G = 1024, R = 2048, C = new Map([
	[0, 0],
	[1, 63],
	[2, 44],
	[3, 71],
	[4, 27],
	[5, 29],
	[6, 60],
	[7, 1],
	[8, 45],
	[9, 8],
	[10, 12],
	[11, 6],
	[12, 48],
	[13, 2],
	[14, 21],
	[16, 10],
	[17, 20],
	[18, 75],
	[19, 43],
	[20, 54],
	[21, 31],
	[22, 28],
	[23, 41],
	[24, 33],
	[25, 59],
	[26, 74],
	[27, 22],
	[28, 51],
	[29, 70],
	[30, 69],
	[31, 34],
	[32, 64],
	[33, 18],
	[34, 68],
	[35, 16],
	[36, 37],
	[37, 46],
	[38, 52],
	[39, 55],
	[40, 32],
	[42, 49],
	[43, 24],
	[60, 58],
	[61, 58],
	[62, 73],
	[67, 47],
	[71, 65],
	[72, 36],
	[74, 9],
	[75, 61],
	[84, 25],
	[88, 57],
	[89, 17],
	[90, 35],
	[91, 67],
	[92, 50],
	[93, 66],
	[95, 58],
	[97, 5],
	[98, 3],
	[99, 4],
	[100, 38],
	[101, 40],
	[102, 39],
	[103, 13],
	[104, 15],
	[105, 42],
	[106, 30],
	[107, 53],
	[110, 73],
	[111, 14],
	[113, 23],
	[114, 7],
	[115, 26],
	[116, 72],
	[122, 19],
	[125, 11],
	[130, 62],
	[131, 56]
]), E = BigInt("0x1FFFFFFF");
function T(t) {
	return C.get(t) ?? 29;
}
function j(t) {
	switch (61440 & t) {
		case 24576: return 1;
		case 8192:
		case 4096: return 2;
		case 16384: return 3;
		case 32768: return 4;
		case 40960: return 7;
		case 49152: return 6;
		default: return 0;
	}
}
function K(t) {
	switch (t) {
		case 0:
		default: return 0;
		case 1: return 1;
		case 2: return 2;
		case 3: return 3;
	}
}
var L = class extends Error {
	code;
	constructor(t) {
		super(`WASI exit: ${t}`), this.code = t;
	}
}, Y = class {
	memory;
	channelOffset;
	argv;
	env;
	preopens = /* @__PURE__ */ new Map();
	encoder = new TextEncoder();
	decoder = new TextDecoder();
	constructor(t, e, s, i) {
		this.memory = t, this.channelOffset = e, this.argv = s, this.env = i;
	}
	init() {
		const t = this.encoder.encode("/"), e = this.channelOffset + 72, s = new DataView(this.memory.buffer);
		new Uint8Array(this.memory.buffer, e, t.length).set(t), s.setUint8(e + t.length, 0);
		const { result: i, errno: n } = this.doSyscall(y, -100, e, 65536, 0, 0, 0);
		0 === n && i >= 0 && this.preopens.set(i, "/");
	}
	doSyscall(t, e = 0, s = 0, i = 0, n = 0, r = 0, a = 0) {
		const o = this.channelOffset, h = new DataView(this.memory.buffer);
		h.setInt32(o + 4, t, !0), h.setBigInt64(o + 8 + 0, BigInt(e), !0), h.setBigInt64(o + 8 + 8, BigInt(s), !0), h.setBigInt64(o + 8 + 16, BigInt(i), !0), h.setBigInt64(o + 8 + 24, BigInt(n), !0), h.setBigInt64(o + 8 + 32, BigInt(r), !0), h.setBigInt64(o + 8 + 40, BigInt(a), !0);
		const d = new Int32Array(this.memory.buffer), c = o / 4;
		for (Atomics.store(d, c, 1), Atomics.notify(d, c, 1); "ok" === Atomics.wait(d, c, 1););
		const l = Number(h.getBigInt64(o + 56, !0)), f = h.getUint32(o + 64, !0);
		return Atomics.store(d, c, 0), {
			result: l,
			errno: f
		};
	}
	get dataArea() {
		return this.channelOffset + 72;
	}
	writeStringToData(t, e = 0) {
		const s = this.encoder.encode(t), i = this.dataArea + e;
		return new Uint8Array(this.memory.buffer, i, s.length + 1).set(s), new DataView(this.memory.buffer).setUint8(i + s.length, 0), s.length;
	}
	resolvePath(t, e, s, i = 0) {
		const n = new Uint8Array(this.memory.buffer, e, s), r = this.decoder.decode(n), a = this.preopens.get(t);
		let o;
		o = void 0 !== a ? "/" === a ? r.startsWith("/") ? r : "/" + r : a + (r.startsWith("/") ? r : "/" + r) : r;
		const h = this.dataArea + i, d = this.encoder.encode(o);
		return new Uint8Array(this.memory.buffer, h, d.length + 1).set(d), new DataView(this.memory.buffer).setUint8(h + d.length, 0), {
			kernelDirfd: -100,
			pathAddr: h
		};
	}
	translateStat(t, e) {
		const s = new DataView(this.memory.buffer), i = this.dataArea + t, n = s.getBigUint64(i + 0, !0), r = s.getBigUint64(i + 8, !0), a = s.getUint32(i + 16, !0), o = s.getUint32(i + 20, !0), h = s.getBigInt64(i + 32, !0), d = s.getBigInt64(i + 40, !0), c = s.getBigInt64(i + 48, !0), l = s.getBigInt64(i + 56, !0), f = s.getBigInt64(i + 64, !0), g = s.getBigInt64(i + 72, !0), _ = s.getBigInt64(i + 80, !0), u = e;
		s.setBigUint64(u + 0, n, !0), s.setBigUint64(u + 8, r, !0), s.setUint8(u + 16, j(a));
		for (let m = 17; m < 24; m++) s.setUint8(u + m, 0);
		s.setBigUint64(u + 24, BigInt(o), !0), s.setBigUint64(u + 32, h < 0n ? 0n : BigInt(h), !0), s.setBigUint64(u + 40, 1000000000n * d + c, !0), s.setBigUint64(u + 48, 1000000000n * l + f, !0), s.setBigUint64(u + 56, 1000000000n * g + _, !0);
	}
	getImports() {
		return {
			args_get: this.args_get.bind(this),
			args_sizes_get: this.args_sizes_get.bind(this),
			environ_get: this.environ_get.bind(this),
			environ_sizes_get: this.environ_sizes_get.bind(this),
			fd_prestat_get: this.fd_prestat_get.bind(this),
			fd_prestat_dir_name: this.fd_prestat_dir_name.bind(this),
			fd_close: this.fd_close.bind(this),
			fd_read: this.fd_read.bind(this),
			fd_write: this.fd_write.bind(this),
			fd_pread: this.fd_pread.bind(this),
			fd_pwrite: this.fd_pwrite.bind(this),
			fd_seek: this.fd_seek.bind(this),
			fd_tell: this.fd_tell.bind(this),
			fd_sync: this.fd_sync.bind(this),
			fd_datasync: this.fd_datasync.bind(this),
			fd_fdstat_get: this.fd_fdstat_get.bind(this),
			fd_fdstat_set_flags: this.fd_fdstat_set_flags.bind(this),
			fd_fdstat_set_rights: this.fd_fdstat_set_rights.bind(this),
			fd_filestat_get: this.fd_filestat_get.bind(this),
			fd_filestat_set_size: this.fd_filestat_set_size.bind(this),
			fd_filestat_set_times: this.fd_filestat_set_times.bind(this),
			fd_allocate: this.fd_allocate.bind(this),
			fd_advise: this.fd_advise.bind(this),
			fd_readdir: this.fd_readdir.bind(this),
			fd_renumber: this.fd_renumber.bind(this),
			path_create_directory: this.path_create_directory.bind(this),
			path_unlink_file: this.path_unlink_file.bind(this),
			path_remove_directory: this.path_remove_directory.bind(this),
			path_rename: this.path_rename.bind(this),
			path_symlink: this.path_symlink.bind(this),
			path_readlink: this.path_readlink.bind(this),
			path_link: this.path_link.bind(this),
			path_open: this.path_open.bind(this),
			path_filestat_get: this.path_filestat_get.bind(this),
			path_filestat_set_times: this.path_filestat_set_times.bind(this),
			random_get: this.random_get.bind(this),
			clock_time_get: this.clock_time_get.bind(this),
			clock_res_get: this.clock_res_get.bind(this),
			proc_exit: this.proc_exit.bind(this),
			proc_raise: this.proc_raise.bind(this),
			sched_yield: this.sched_yield.bind(this),
			poll_oneoff: this.poll_oneoff.bind(this),
			sock_recv: this.sock_recv.bind(this),
			sock_send: this.sock_send.bind(this),
			sock_shutdown: this.sock_shutdown.bind(this),
			sock_accept: this.sock_accept.bind(this)
		};
	}
	args_get(t, e) {
		const s = new DataView(this.memory.buffer), i = new Uint8Array(this.memory.buffer);
		let n = e;
		for (let r = 0; r < this.argv.length; r++) {
			s.setUint32(t + 4 * r, n, !0);
			const e = this.encoder.encode(this.argv[r]);
			i.set(e, n), i[n + e.length] = 0, n += e.length + 1;
		}
		return 0;
	}
	args_sizes_get(t, e) {
		const s = new DataView(this.memory.buffer);
		s.setUint32(t, this.argv.length, !0);
		let i = 0;
		for (const n of this.argv) i += this.encoder.encode(n).length + 1;
		return s.setUint32(e, i, !0), 0;
	}
	environ_get(t, e) {
		const s = new DataView(this.memory.buffer), i = new Uint8Array(this.memory.buffer);
		let n = e;
		for (let r = 0; r < this.env.length; r++) {
			s.setUint32(t + 4 * r, n, !0);
			const e = this.encoder.encode(this.env[r]);
			i.set(e, n), i[n + e.length] = 0, n += e.length + 1;
		}
		return 0;
	}
	environ_sizes_get(t, e) {
		const s = new DataView(this.memory.buffer);
		s.setUint32(t, this.env.length, !0);
		let i = 0;
		for (const n of this.env) i += this.encoder.encode(n).length + 1;
		return s.setUint32(e, i, !0), 0;
	}
	fd_prestat_get(t, e) {
		const s = this.preopens.get(t);
		if (void 0 === s) return 8;
		const i = new DataView(this.memory.buffer);
		return i.setUint8(e, 0), i.setUint32(e + 4, this.encoder.encode(s).length, !0), 0;
	}
	fd_prestat_dir_name(t, e, s) {
		const i = this.preopens.get(t);
		if (void 0 === i) return 8;
		const n = this.encoder.encode(i), r = Math.min(n.length, s);
		return new Uint8Array(this.memory.buffer, e, r).set(n.subarray(0, r)), 0;
	}
	fd_close(t) {
		const { errno: e } = this.doSyscall(n, t);
		return e ? T(e) : (this.preopens.delete(t), 0);
	}
	fd_read(t, e, s, i) {
		const { result: n, errno: r } = this.doSyscall(w, t, e, s);
		return r ? T(r) : (new DataView(this.memory.buffer).setUint32(i, n, !0), 0);
	}
	fd_write(t, e, s, i) {
		const { result: n, errno: r } = this.doSyscall(p, t, e, s);
		return r ? T(r) : (new DataView(this.memory.buffer).setUint32(i, n, !0), 0);
	}
	fd_pread(e, s, i, n, r) {
		const a = new DataView(this.memory.buffer), o = new Uint8Array(this.memory.buffer);
		let h = 0;
		for (let t = 0; t < i; t++) h += a.getUint32(s + 8 * t + 4, !0);
		h = Math.min(h, t - 256);
		const { result: d, errno: c } = this.doSyscall(u, e, this.dataArea, h, Number(4294967295n & n), Number(n >> 32n & 4294967295n));
		if (c) return T(c);
		let l = d, f = 0;
		for (let t = 0; t < i && l > 0; t++) {
			const e = a.getUint32(s + 8 * t, !0), i = a.getUint32(s + 8 * t + 4, !0), n = Math.min(i, l);
			o.copyWithin(e, this.dataArea + f, this.dataArea + f + n), f += n, l -= n;
		}
		return a.setUint32(r, d, !0), 0;
	}
	fd_pwrite(e, s, i, n, r) {
		const a = new DataView(this.memory.buffer), o = new Uint8Array(this.memory.buffer);
		let h = 0;
		for (let l = 0; l < i; l++) {
			const e = a.getUint32(s + 8 * l, !0), i = a.getUint32(s + 8 * l + 4, !0), n = Math.min(i, t - 256 - h);
			o.copyWithin(this.dataArea + h, e, e + n), h += n;
		}
		const { result: d, errno: c } = this.doSyscall(m, e, this.dataArea, h, Number(4294967295n & n), Number(n >> 32n & 4294967295n));
		return c ? T(c) : (a.setUint32(r, d, !0), 0);
	}
	fd_seek(t, e, s, i) {
		const n = function(t) {
			switch (t) {
				case 0:
				default: return 0;
				case 1: return 1;
				case 2: return 2;
			}
		}(s), a = Number(e), { result: o, errno: h } = this.doSyscall(r, t, a, n);
		return h ? T(h) : (new DataView(this.memory.buffer).setBigUint64(i, BigInt(o), !0), 0);
	}
	fd_tell(t, e) {
		const { result: s, errno: i } = this.doSyscall(r, t, 0, 1);
		return i ? T(i) : (new DataView(this.memory.buffer).setBigUint64(e, BigInt(s), !0), 0);
	}
	fd_sync(t) {
		const { errno: e } = this.doSyscall(U, t);
		return e ? T(e) : 0;
	}
	fd_datasync(t) {
		const { errno: e } = this.doSyscall(B, t);
		return e ? T(e) : 0;
	}
	fd_fdstat_get(t, e) {
		const s = new DataView(this.memory.buffer), { errno: i } = this.doSyscall(a, t, this.dataArea);
		if (i) return T(i);
		const n = j(s.getUint32(this.dataArea + 16, !0)), { result: r, errno: h } = this.doSyscall(o, t, 3), d = h ? 0 : function(t) {
			let e = 0;
			return t & G && (e |= 1), t & R && (e |= 4), e;
		}(r);
		return s.setUint8(e, n), s.setUint8(e + 1, 0), s.setUint16(e + 2, d, !0), s.setUint32(e + 4, 0, !0), s.setBigUint64(e + 8, E, !0), s.setBigUint64(e + 16, E, !0), 0;
	}
	fd_fdstat_set_flags(t, e) {
		let s = 0;
		1 & e && (s |= G), 4 & e && (s |= R);
		const { errno: i } = this.doSyscall(o, t, 4, s);
		return i ? T(i) : 0;
	}
	fd_fdstat_set_rights() {
		return 0;
	}
	fd_filestat_get(t, e) {
		const { errno: s } = this.doSyscall(a, t, this.dataArea);
		return s ? T(s) : (this.translateStat(0, e), 0);
	}
	fd_filestat_set_size(t, e) {
		const { errno: s } = this.doSyscall(b, t, Number(e));
		return s ? T(s) : 0;
	}
	fd_filestat_set_times(t, e, s, i) {
		const n = 1073741823, r = 1073741822, a = new DataView(this.memory.buffer), o = this.dataArea;
		2 & i ? (a.setBigInt64(o + 0, 0n, !0), a.setBigInt64(o + 8, BigInt(n), !0)) : 1 & i ? (a.setBigInt64(o + 0, e / 1000000000n, !0), a.setBigInt64(o + 8, e % 1000000000n, !0)) : (a.setBigInt64(o + 0, 0n, !0), a.setBigInt64(o + 8, BigInt(r), !0)), 8 & i ? (a.setBigInt64(o + 16, 0n, !0), a.setBigInt64(o + 24, BigInt(n), !0)) : 4 & i ? (a.setBigInt64(o + 16, s / 1000000000n, !0), a.setBigInt64(o + 24, s % 1000000000n, !0)) : (a.setBigInt64(o + 16, 0n, !0), a.setBigInt64(o + 24, BigInt(r), !0));
		const h = o + 32;
		a.setUint8(h, 0);
		const { errno: d } = this.doSyscall(N, t, h, o, 0);
		return d ? T(d) : 0;
	}
	fd_allocate(t, e, s) {
		const { errno: i } = this.doSyscall(x, t, Number(e), Number(s));
		return i ? T(i) : 0;
	}
	fd_advise() {
		return 0;
	}
	fd_readdir(e, s, i, n, r) {
		const a = new DataView(this.memory.buffer), o = new Uint8Array(this.memory.buffer), h = Math.min(t - 256, 32768), { result: d, errno: c } = this.doSyscall(F, e, this.dataArea, h);
		if (c) return T(c);
		let l = 0, f = 0, g = BigInt(0);
		for (; l < d && f < i;) {
			const t = this.dataArea + l, e = a.getBigUint64(t, !0), r = a.getUint16(t + 16, !0), h = a.getUint8(t + 18);
			let d = t + 19;
			for (; d < t + r && 0 !== a.getUint8(d);) d++;
			const c = d - (t + 19);
			if (g++, g <= n) {
				l += r;
				continue;
			}
			const _ = 24;
			if (f + _ > i) break;
			let u = 0;
			switch (h) {
				case 1:
				case 2:
					u = 2;
					break;
				case 4:
					u = 3;
					break;
				case 6:
					u = 1;
					break;
				case 8:
					u = 4;
					break;
				case 10:
					u = 7;
					break;
				case 12: u = 6;
			}
			a.setBigUint64(s + f, g, !0), a.setBigUint64(s + f + 8, e, !0), a.setUint32(s + f + 16, c, !0), a.setUint8(s + f + 20, u), a.setUint8(s + f + 21, 0), a.setUint8(s + f + 22, 0), a.setUint8(s + f + 23, 0), f += _;
			const m = Math.min(c, i - f);
			m > 0 && (o.copyWithin(s + f, t + 19, t + 19 + m), f += m), l += r;
		}
		return a.setUint32(r, f, !0), 0;
	}
	fd_renumber(t, e) {
		const { errno: s } = this.doSyscall(z, t, e);
		if (s) return T(s);
		if (t !== e) {
			const { errno: e } = this.doSyscall(n, t);
			if (e) return T(e);
		}
		const i = this.preopens.get(t);
		return void 0 !== i && (this.preopens.delete(t), this.preopens.set(e, i)), 0;
	}
	path_create_directory(t, e, s) {
		const { kernelDirfd: i, pathAddr: n } = this.resolvePath(t, e, s), { errno: r } = this.doSyscall(k, i, n, 511);
		return r ? T(r) : 0;
	}
	path_unlink_file(t, e, s) {
		const { kernelDirfd: i, pathAddr: n } = this.resolvePath(t, e, s), { errno: r } = this.doSyscall(A, i, n, 0);
		return r ? T(r) : 0;
	}
	path_remove_directory(t, e, s) {
		const { kernelDirfd: i, pathAddr: n } = this.resolvePath(t, e, s), { errno: r } = this.doSyscall(A, i, n, 512);
		return r ? T(r) : 0;
	}
	path_rename(t, e, s, i, n, r) {
		const { kernelDirfd: a, pathAddr: o } = this.resolvePath(t, e, s, 0), { kernelDirfd: h, pathAddr: d } = this.resolvePath(i, n, r, 4096), { errno: c } = this.doSyscall(S, a, o, h, d);
		return c ? T(c) : 0;
	}
	path_symlink(t, e, s, i, n) {
		const r = new Uint8Array(this.memory.buffer, t, e), a = this.dataArea;
		new Uint8Array(this.memory.buffer, a, e + 1).set(r), new DataView(this.memory.buffer).setUint8(a + e, 0);
		const { kernelDirfd: o, pathAddr: h } = this.resolvePath(s, i, n, 4096), { errno: d } = this.doSyscall(D, a, o, h);
		return d ? T(d) : 0;
	}
	path_readlink(e, s, i, n, r, a) {
		const { kernelDirfd: o, pathAddr: h } = this.resolvePath(e, s, i), d = this.dataArea + 4096, c = Math.min(r, t - 4096 - 256), { result: l, errno: f } = this.doSyscall(V, o, h, d, c);
		return f ? T(f) : (new Uint8Array(this.memory.buffer).copyWithin(n, d, d + l), new DataView(this.memory.buffer).setUint32(a, l, !0), 0);
	}
	path_link(t, e, s, i, n, r, a) {
		const { kernelDirfd: o, pathAddr: h } = this.resolvePath(t, s, i, 0), { kernelDirfd: d, pathAddr: c } = this.resolvePath(n, r, a, 4096), { errno: l } = this.doSyscall(v, o, h, d, c, 0);
		return l ? T(l) : 0;
	}
	path_open(t, e, s, i, n, r, a, o, h) {
		const { kernelDirfd: d, pathAddr: c } = this.resolvePath(t, s, i);
		let l = function(t, e) {
			let s = 0;
			return 1 & t && (s |= 64), 2 & t && (s |= 65536), 4 & t && (s |= 128), 8 & t && (s |= 512), 1 & e && (s |= G), 4 & e && (s |= R), s;
		}(n, o);
		l |= 2 & n ? 0 : 2;
		const { result: f, errno: g } = this.doSyscall(y, d, c, l, 438);
		if (g) {
			if (!(21 !== g && 13 !== g || 64 & l)) {
				l &= -4;
				const t = this.doSyscall(y, d, c, l, 438);
				return t.errno ? T(t.errno) : (new DataView(this.memory.buffer).setUint32(h, t.result, !0), 0);
			}
			return T(g);
		}
		return new DataView(this.memory.buffer).setUint32(h, f, !0), 0;
	}
	path_filestat_get(t, e, s, i, n) {
		const { kernelDirfd: r, pathAddr: a } = this.resolvePath(t, s, i), { errno: o } = this.doSyscall(I, r, a, this.dataArea + 4096, 0);
		return o ? T(o) : (this.translateStat(4096, n), 0);
	}
	path_filestat_set_times(t, e, s, i, n, r, a) {
		const { kernelDirfd: o, pathAddr: h } = this.resolvePath(t, s, i, 4096), d = 1073741823, c = 1073741822, l = new DataView(this.memory.buffer), f = this.dataArea;
		2 & a ? (l.setBigInt64(f + 0, 0n, !0), l.setBigInt64(f + 8, BigInt(d), !0)) : 1 & a ? (l.setBigInt64(f + 0, n / 1000000000n, !0), l.setBigInt64(f + 8, n % 1000000000n, !0)) : (l.setBigInt64(f + 0, 0n, !0), l.setBigInt64(f + 8, BigInt(c), !0)), 8 & a ? (l.setBigInt64(f + 16, 0n, !0), l.setBigInt64(f + 24, BigInt(d), !0)) : 4 & a ? (l.setBigInt64(f + 16, r / 1000000000n, !0), l.setBigInt64(f + 24, r % 1000000000n, !0)) : (l.setBigInt64(f + 16, 0n, !0), l.setBigInt64(f + 24, BigInt(c), !0));
		const { errno: g } = this.doSyscall(N, o, h, f, 0);
		return g ? T(g) : 0;
	}
	random_get(e, s) {
		let i = 0;
		for (; i < s;) {
			const n = Math.min(s - i, t - 256), { result: r, errno: a } = this.doSyscall(P, this.dataArea, n, 0);
			if (a) return T(a);
			new Uint8Array(this.memory.buffer).copyWithin(e + i, this.dataArea, this.dataArea + r), i += r;
		}
		return 0;
	}
	clock_time_get(t, e, s) {
		const i = K(t), { errno: n } = this.doSyscall(l, i, this.dataArea);
		if (n) return T(n);
		const r = new DataView(this.memory.buffer), a = r.getBigInt64(this.dataArea, !0), o = r.getBigInt64(this.dataArea + 8, !0);
		return r.setBigUint64(s, 1000000000n * BigInt(a) + BigInt(o), !0), 0;
	}
	clock_res_get(t, e) {
		const s = K(t), { errno: i } = this.doSyscall(M, s, this.dataArea);
		if (i) return T(i);
		const n = new DataView(this.memory.buffer), r = n.getBigInt64(this.dataArea, !0), a = n.getBigInt64(this.dataArea + 8, !0);
		return n.setBigUint64(e, 1000000000n * BigInt(r) + BigInt(a), !0), 0;
	}
	proc_exit(t) {
		throw this.doSyscall(d, t), new L(t);
	}
	proc_raise(t) {
		const { result: e } = this.doSyscall(h), { errno: s } = this.doSyscall(c, e, t);
		return s ? T(s) : 0;
	}
	sched_yield() {
		return this.doSyscall(W), 0;
	}
	poll_oneoff(t, e, s, i) {
		const n = new DataView(this.memory.buffer);
		if (0 === s) return n.setUint32(i, 0, !0), 0;
		let r = !1, a = !1;
		for (let l = 0; l < s; l++) 0 === n.getUint8(t + 48 * l + 8) ? r = !0 : a = !0;
		if (r && !a && 1 === s) {
			const s = t, r = n.getBigUint64(s, !0), a = n.getBigUint64(s + 16 + 8, !0);
			let o;
			if (1 & n.getUint16(s + 16 + 24, !0)) {
				const { errno: t } = this.doSyscall(l, 0, this.dataArea);
				if (t) return T(t);
				const e = 1000000000n * n.getBigInt64(this.dataArea, !0) + n.getBigInt64(this.dataArea + 8, !0), s = BigInt(a) - e;
				o = s > 0n ? Number(s / 1000000n) : 0;
			} else o = Number(a / 1000000n);
			o > 0 && this.doSyscall(f, 0, 0, o), n.setBigUint64(e, r, !0), n.setUint16(e + 8, 0, !0), n.setUint8(e + 10, 0);
			for (let t = 11; t < 32; t++) n.setUint8(e + t, 0);
			return n.setUint32(i, 1, !0), 0;
		}
		const o = [];
		let h = -1, d = 0n;
		for (let l = 0; l < s; l++) {
			const e = t + 48 * l, s = n.getBigUint64(e, !0), i = n.getUint8(e + 8);
			if (0 === i) {
				const t = n.getBigUint64(e + 16 + 8, !0), i = Number(t / 1000000n);
				(h < 0 || i < h) && (h = i, d = s);
			} else {
				const t = n.getUint32(e + 16, !0), r = 1 === i ? 1 : 4;
				o.push({
					fd: t,
					events: r,
					idx: l,
					userdata: s,
					type: i
				});
			}
		}
		const c = this.dataArea;
		for (let l = 0; l < o.length; l++) n.setInt32(c + 8 * l, o[l].fd, !0), n.setInt16(c + 8 * l + 4, o[l].events, !0), n.setInt16(c + 8 * l + 6, 0, !0);
		const { errno: g } = this.doSyscall(f, c, o.length, h >= 0 ? h : -1);
		if (g && 4 !== g) return T(g);
		let _ = 0;
		for (let l = 0; l < o.length; l++) {
			const t = n.getInt16(c + 8 * l + 6, !0);
			if (t) {
				const s = e + 32 * _;
				n.setBigUint64(s, o[l].userdata, !0);
				const i = 8 & t ? 29 : 0;
				n.setUint16(s + 8, i, !0), n.setUint8(s + 10, o[l].type);
				for (let t = 11; t < 32; t++) n.setUint8(s + t, 0);
				n.setBigUint64(s + 16, 1n, !0), _++;
			}
		}
		if (0 === _ && h >= 0) {
			const t = e;
			n.setBigUint64(t, d, !0), n.setUint16(t + 8, 0, !0), n.setUint8(t + 10, 0);
			for (let e = 11; e < 32; e++) n.setUint8(t + e, 0);
			_ = 1;
		}
		return n.setUint32(i, _, !0), 0;
	}
	sock_recv(e, s, i, n, r, a) {
		const o = new DataView(this.memory.buffer), h = new Uint8Array(this.memory.buffer);
		let d = 0;
		for (let t = 0; t < i; t++) d += o.getUint32(s + 8 * t + 4, !0);
		d = Math.min(d, t - 256);
		const { result: c, errno: l } = this.doSyscall(_, e, this.dataArea, d, 0, 0, 0);
		if (l) return T(l);
		let f = c, g = 0;
		for (let t = 0; t < i && f > 0; t++) {
			const e = o.getUint32(s + 8 * t, !0), i = o.getUint32(s + 8 * t + 4, !0), n = Math.min(i, f);
			h.copyWithin(e, this.dataArea + g, this.dataArea + g + n), g += n, f -= n;
		}
		return o.setUint32(r, c, !0), o.setUint16(a, 0, !0), 0;
	}
	sock_send(e, s, i, n, r) {
		const a = new DataView(this.memory.buffer), o = new Uint8Array(this.memory.buffer);
		let h = 0;
		for (let l = 0; l < i; l++) {
			const e = a.getUint32(s + 8 * l, !0), i = a.getUint32(s + 8 * l + 4, !0), n = Math.min(i, t - 256 - h);
			o.copyWithin(this.dataArea + h, e, e + n), h += n;
		}
		const { result: d, errno: c } = this.doSyscall(g, e, this.dataArea, h, 0, 0, 0);
		return c ? T(c) : (a.setUint32(r, d, !0), 0);
	}
	sock_shutdown(t, e) {
		const { errno: s } = this.doSyscall(O, t, e);
		return s ? T(s) : 0;
	}
	sock_accept(t, e, s) {
		return 52;
	}
};
export { L as WasiExit, Y as WasiShim };
