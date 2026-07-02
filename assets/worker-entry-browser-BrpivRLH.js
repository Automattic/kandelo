function e(e, t) {
	let n, r = 0, o = 0;
	do
		n = e[t.value++], r |= (127 & n) << o, o += 7;
	while (128 & n);
	return r >>> 0;
}
function t(t, n) {
	const r = e(t, n), o = t.subarray(n.value, n.value + r);
	return n.value += r, new TextDecoder().decode(o);
}
function n(e, t, n, r, o) {
	const s = 1 << n.memoryAlign;
	let i = 0;
	if (n.memorySize > 0) {
		if (o) i = o.memoryBase;
		else if (r.allocateMemory) {
			if (i = r.allocateMemory(n.memorySize, s), i + n.memorySize > r.memory.buffer.byteLength) throw new Error(`${e}: allocator returned 0x${i.toString(16)} but memory only covers 0x${r.memory.buffer.byteLength.toString(16)}`);
		} else {
			if (!r.heapPointer) throw new Error(`${e}: no side-module memory allocator configured`);
			i = r.heapPointer.value + (l = s) - 1 & ~(l - 1), r.heapPointer.value = i + n.memorySize;
			const t = Math.ceil(r.heapPointer.value / 65536), o = r.memory.buffer.byteLength / 65536;
			t > o && r.memory.grow(t - o);
		}
		o || new Uint8Array(r.memory.buffer, i, n.memorySize).fill(0);
	}
	var l;
	let a = 0;
	n.tableSize > 0 && (a = r.table.length, r.table.grow(n.tableSize));
	const c = new WebAssembly.Global({
		value: "i32",
		mutable: !1
	}, i), f = new WebAssembly.Global({
		value: "i32",
		mutable: !1
	}, a), u = (e, t) => {
		let n = r.got.get(e);
		if (!n) {
			let o = 0;
			const s = r.globalSymbols.get(e);
			"mem" === t && s instanceof WebAssembly.Global ? o = s.value : "func" === t && "function" == typeof s && (o = ((e) => {
				const t = r.table;
				for (let r = 0; r < t.length; r++) if (t.get(r) === e) return r;
				const n = t.length;
				return t.grow(1), t.set(n, e), n;
			})(s)), n = new WebAssembly.Global({
				value: "i32",
				mutable: !0
			}, o), r.got.set(e, n);
		}
		return n;
	}, d = "function" == typeof WebAssembly.Tag ? new WebAssembly.Tag({ parameters: ["i32"] }) : void 0, m = {
		env: new Proxy({}, {
			get(e, t) {
				switch (t) {
					case "memory": return r.memory;
					case "__indirect_function_table": return r.table;
					case "__memory_base": return c;
					case "__table_base": return f;
					case "__stack_pointer": return r.stackPointer;
					case "__c_longjmp": return d;
				}
				const n = r.globalSymbols.get(t);
				if (void 0 !== n) return n;
			},
			has: (e, t) => !![
				"memory",
				"__indirect_function_table",
				"__memory_base",
				"__table_base",
				"__stack_pointer",
				"__c_longjmp"
			].includes(t) || r.globalSymbols.has(t)
		}),
		"GOT.mem": new Proxy({}, { get: (e, t) => u(t, "mem") }),
		"GOT.func": new Proxy({}, { get: (e, t) => u(t, "func") })
	}, _ = new WebAssembly.Module(t), g = new WebAssembly.Instance(_, m), p = {};
	for (const [w, y] of Object.entries(g.exports)) if (y instanceof WebAssembly.Global) try {
		y.value = y.value, p[w] = y;
	} catch {
		p[w] = new WebAssembly.Global({
			value: "i32",
			mutable: !1
		}, y.value + i);
	}
	else p[w] = y;
	for (const [w, y] of Object.entries(p)) if (!w.startsWith("__")) {
		if ("function" == typeof y) {
			const e = r.table.length;
			r.table.grow(1), r.table.set(e, y);
			const t = r.got.get(w);
			t && (t.value = e), r.globalSymbols.set(w, y);
		} else if (y instanceof WebAssembly.Global) {
			const e = y.value, t = r.got.get(w);
			t && (t.value = e), r.globalSymbols.set(w, y);
		}
	}
	const b = g.exports.__wasm_apply_data_relocs;
	if (b && b(), !o) {
		const e = g.exports.__wasm_call_ctors;
		e && e();
	}
	const h = {
		instance: g,
		memoryBase: i,
		tableBase: a,
		exports: p,
		metadata: n,
		name: e
	};
	return r.loadedLibraries.set(e, h), h;
}
function r(o, s, i, l) {
	const a = i.loadedLibraries.get(o);
	if (a) return a;
	const c = function(n) {
		if (n.length < 8) return null;
		if (0 !== n[0] || 97 !== n[1] || 115 !== n[2] || 109 !== n[3]) return null;
		const r = { value: 8 };
		if (r.value >= n.length) return null;
		if (0 !== n[r.value++]) return null;
		const o = e(n, r), s = r.value + o;
		if ("dylink.0" !== t(n, r)) return null;
		const i = {
			memorySize: 0,
			memoryAlign: 0,
			tableSize: 0,
			tableAlign: 0,
			neededDynlibs: [],
			tlsExports: /* @__PURE__ */ new Set(),
			weakImports: /* @__PURE__ */ new Set()
		};
		for (; r.value < s;) {
			const o = e(n, r), s = e(n, r), l = r.value + s;
			switch (o) {
				case 1:
					i.memorySize = e(n, r), i.memoryAlign = e(n, r), i.tableSize = e(n, r), i.tableAlign = e(n, r);
					break;
				case 2: {
					const o = e(n, r);
					for (let e = 0; e < o; e++) i.neededDynlibs.push(t(n, r));
					break;
				}
				case 3: {
					const o = e(n, r);
					for (let s = 0; s < o; s++) {
						const o = t(n, r);
						1 & e(n, r) && i.tlsExports.add(o);
					}
					break;
				}
				case 4: {
					const o = e(n, r);
					for (let s = 0; s < o; s++) {
						t(n, r);
						const o = t(n, r);
						2 & e(n, r) && i.weakImports.add(o);
					}
					break;
				}
			}
			r.value = l;
		}
		return i;
	}(s);
	if (!c) throw new Error(`${o}: not a shared library (no dylink.0 section)`);
	if (l && c.neededDynlibs.length > 0) throw new Error(`${o}: replay does not yet support NEEDED deps; each dep would need its own DylinkReplayOptions in a future API extension`);
	for (const e of c.neededDynlibs) {
		if (i.loadedLibraries.has(e)) continue;
		if (!i.resolveLibrarySync) throw new Error(`${o}: depends on ${e} but no resolveLibrarySync callback provided`);
		const t = i.resolveLibrarySync(e);
		if (!t) throw new Error(`${o}: dependency ${e} not found`);
		r(e, t, i);
	}
	return n(o, s, c, i, l);
}
var o = class {
	options;
	handleCounter = 1;
	handleMap = /* @__PURE__ */ new Map();
	lastError = null;
	constructor(e) {
		this.options = e;
	}
	dlopenSync(e, t, n) {
		try {
			const o = r(e, t, this.options, n);
			for (const [e, t] of this.handleMap) if (t === o) return e;
			const s = this.handleCounter++;
			return this.handleMap.set(s, o), this.lastError = null, s;
		} catch (o) {
			return this.lastError = o instanceof Error ? o.message : String(o), 0;
		}
	}
	dlsym(e, t) {
		const n = this.handleMap.get(e);
		if (!n) return this.lastError = "invalid handle", null;
		const r = n.exports[t];
		if (void 0 === r) {
			const e = this.options.globalSymbols.get(t);
			if (void 0 === e) return this.lastError = `symbol not found: ${t}`, null;
			if ("function" == typeof e) return this.lastError = null, e;
			if (e instanceof WebAssembly.Global) return this.lastError = null, e.value;
		}
		if ("function" == typeof r) {
			const e = this.options.table;
			for (let n = 0; n < e.length; n++) if (e.get(n) === r) return this.lastError = null, n;
			const t = e.length;
			return e.grow(1), e.set(t, r), this.lastError = null, t;
		}
		return r instanceof WebAssembly.Global ? (this.lastError = null, r.value) : (this.lastError = `symbol not found: ${t}`, null);
	}
	dlclose(e) {
		return this.handleMap.has(e) ? (this.handleMap.delete(e), this.lastError = null, 0) : (this.lastError = "invalid handle", -1);
	}
	dlerror() {
		const e = this.lastError;
		return this.lastError = null, e;
	}
};
const s = 65536, i = 212, l = {
	Open: 1,
	Close: 2,
	Read: 3,
	Write: 4,
	Seek: 5,
	Fstat: 6,
	Dup: 7,
	Dup2: 8,
	Pipe: 9,
	Fcntl: 10,
	Stat: 11,
	Lstat: 12,
	Mkdir: 13,
	Rmdir: 14,
	Unlink: 15,
	Rename: 16,
	Link: 17,
	Symlink: 18,
	Readlink: 19,
	Chmod: 20,
	Chown: 21,
	Access: 22,
	Getcwd: 23,
	Chdir: 24,
	Opendir: 25,
	Readdir: 26,
	Closedir: 27,
	Getpid: 28,
	Getppid: 29,
	Getuid: 30,
	Geteuid: 31,
	Getgid: 32,
	Getegid: 33,
	Exit: 34,
	Kill: 35,
	Sigaction: 36,
	Sigprocmask: 37,
	Raise: 38,
	Alarm: 39,
	ClockGettime: 40,
	Nanosleep: 41,
	Isatty: 42,
	GetEnv: 43,
	SetEnv: 44,
	UnsetEnv: 45,
	Mmap: 46,
	Munmap: 47,
	Brk: 48,
	Mprotect: 49,
	Socket: 50,
	Bind: 51,
	Listen: 52,
	Accept: 53,
	Connect: 54,
	Send: 55,
	Recv: 56,
	Shutdown: 57,
	Getsockopt: 58,
	Setsockopt: 59,
	Poll: 60,
	Socketpair: 61,
	Sendto: 62,
	Recvfrom: 63,
	Pread: 64,
	Pwrite: 65,
	Time: 66,
	Gettimeofday: 67,
	Usleep: 68,
	Openat: 69,
	Tcgetattr: 70,
	Tcsetattr: 71,
	Ioctl: 72,
	Signal: 73,
	Umask: 74,
	Uname: 75,
	Sysconf: 76,
	Dup3: 77,
	Pipe2: 78,
	Ftruncate: 79,
	Fsync: 80,
	Writev: 81,
	Readv: 82,
	Getrlimit: 83,
	Setrlimit: 84,
	Truncate: 85,
	Fdatasync: 86,
	Fchmod: 87,
	Fchown: 88,
	Getpgrp: 89,
	Setpgid: 90,
	Getsid: 91,
	Setsid: 92,
	Fstatat: 93,
	Unlinkat: 94,
	Mkdirat: 95,
	Renameat: 96,
	Faccessat: 97,
	Fchmodat: 98,
	Fchownat: 99,
	Linkat: 100,
	Symlinkat: 101,
	Readlinkat: 102,
	Select: 103,
	Setuid: 104,
	Setgid: 105,
	Seteuid: 106,
	Setegid: 107,
	Getrusage: 108,
	Realpath: 109,
	Sigsuspend: 110,
	Pause: 111,
	Pathconf: 112,
	Fpathconf: 113,
	Getsockname: 114,
	Getpeername: 115,
	Rewinddir: 116,
	Telldir: 117,
	Seekdir: 118,
	Llseek: 119,
	Getrandom: 120,
	Flock: 121,
	Getdents64: 122,
	ClockGetres: 123,
	ClockNanosleep: 124,
	Utimensat: 125,
	Mremap: 126,
	Fchdir: 127,
	Madvise: 128,
	Statfs: 129,
	Fstatfs: 130,
	Setresuid: 131,
	Getresuid: 132,
	Setresgid: 133,
	Getresgid: 134,
	Getgroups: 135,
	Setgroups: 136,
	Sendmsg: 137,
	Recvmsg: 138,
	Wait4: 139,
	Getaddrinfo: 140,
	Futex: 200,
	Clone: 201,
	Gettid: 202,
	SetTidAddress: 203,
	RtSigqueueinfo: 205,
	RtSigpending: 206,
	RtSigtimedwait: 207,
	RtSigreturn: 208,
	Sigaltstack: 209,
	Getpgid: 214,
	Setreuid: 215,
	Setregid: 216,
	Prctl: 223,
	Getitimer: 224,
	Setitimer: 225,
	ClockSettime: 226,
	SchedYield: 229,
	SchedGetparam: 230,
	SchedRrGetInterval: 236,
	EpollCreate1: 239,
	EpollCtl: 240,
	EpollPwait: 241,
	Prlimit64: 250,
	Ppoll: 251,
	Pselect6: 252,
	Statx: 260,
	SetRobustList: 261,
	GetRobustList: 262,
	Mknod: 271,
	Mknodat: 272,
	Msync: 278,
	Waitid: 288,
	Sendfile: 294,
	Preadv: 295,
	Pwritev: 296,
	Fallocate: 308,
	TimerCreate: 326,
	TimerSettime: 327,
	TimerGettime: 328,
	TimerGetoverrun: 329,
	TimerDelete: 330,
	MqOpen: 331,
	MqUnlink: 332,
	MqTimedsend: 333,
	MqTimedreceive: 334,
	MqNotify: 335,
	MqGetsetattr: 336,
	Msgget: 337,
	Msgrcv: 338,
	Msgsnd: 339,
	Msgctl: 340,
	Semget: 341,
	Semop: 342,
	Semctl: 343,
	Shmget: 344,
	Shmat: 345,
	Shmdt: 346,
	Shmctl: 347,
	EpollCreate: 378,
	EpollWait: 379,
	Faccessat2: 382,
	Fchmodat2: 383,
	Accept4: 384,
	ExitGroup: 387,
	ThreadCancel: 415
};
function a(e, t) {
	let n = 0, r = 0, o = t;
	for (;;) {
		const t = e[o++];
		if (n |= (127 & t) << r, !(128 & t)) break;
		r += 7;
	}
	return [n, o - t];
}
function c(e, t) {
	let n = 0, r = 0, o = t, s = 0;
	for (; s = e[o++], n |= (127 & s) << r, r += 7, 128 & s;);
	return r < 32 && 64 & s && (n |= -1 << r), [n, o - t];
}
function f(e, t) {
	let n = 0n, r = 0n, o = t, s = 0;
	for (; s = e[o++], n |= BigInt(127 & s) << r, r += 7n, 128 & s;);
	return r < 64n && 64 & s && (n |= -1n << r), [n, o - t];
}
function u(e, t) {
	const n = e[t];
	if (64 === n || 127 === n || 126 === n || 125 === n || 124 === n || 123 === n || 112 === n || 111 === n) return t + 1;
	const [, r] = c(e, t);
	return t + r;
}
function d(e, t) {
	const [, n] = a(e, t);
	t += n;
	const [, r] = a(e, t);
	return t + r;
}
function m(e, t, n) {
	const [r, o] = a(t, n);
	if (n += o, 252 === e) switch (r) {
		case 0:
		case 1:
		case 2:
		case 3:
		case 4:
		case 5:
		case 6:
		case 7: return n;
		case 8: {
			const [, e] = a(t, n);
			n += e;
			const [, r] = a(t, n);
			return n + r;
		}
		case 9: {
			const [, e] = a(t, n);
			return n + e;
		}
		case 10: {
			const [, e] = a(t, n);
			n += e;
			const [, r] = a(t, n);
			return n + r;
		}
		case 11: {
			const [, e] = a(t, n);
			return n + e;
		}
		case 12: {
			const [, e] = a(t, n);
			n += e;
			const [, r] = a(t, n);
			return n + r;
		}
		case 13: {
			const [, e] = a(t, n);
			return n + e;
		}
		case 14: {
			const [, e] = a(t, n);
			n += e;
			const [, r] = a(t, n);
			return n + r;
		}
		case 15:
		case 16:
		case 17: {
			const [, e] = a(t, n);
			return n + e;
		}
		default: return null;
	}
	return 253 === e ? 12 === r || 13 === r ? n + 16 : r >= 21 && r <= 34 ? d(t, n) : 84 === r || r >= 92 && r <= 99 || r >= 112 && r <= 123 || r >= 124 && r <= 131 || r >= 156 && r <= 159 ? n + 1 : n : 254 === e ? 0 === r || 1 === r || 2 === r ? d(t, n) : 3 === r ? n : r >= 16 && r <= 79 ? d(t, n) : null : null;
}
function _(e, t, n) {
	const [r, o] = a(e, t);
	t += o + r;
	const [s, i] = a(e, t);
	t += i + s;
	const l = e[t++];
	if (0 === l) {
		n.funcImports++;
		const [, r] = a(e, t);
		t += r;
	} else if (1 === l) {
		t++;
		const n = e[t++], [, r] = a(e, t);
		if (t += r, 1 & n) {
			const [, n] = a(e, t);
			t += n;
		}
	} else if (2 === l) {
		const n = e[t++], [, r] = a(e, t);
		if (t += r, 1 & n) {
			const [, n] = a(e, t);
			t += n;
		}
	} else 3 === l && (n.globalImports++, t += 2);
	return t;
}
function g(e, t) {
	const n = new Uint8Array(e);
	if (n.length < 8) return null;
	let r = 0, o = null, s = null, i = 8;
	for (; i < n.length;) {
		const e = n[i], [l, c] = a(n, i + 1), f = i + 1 + c;
		if (2 === e) {
			const e = {
				funcImports: r,
				globalImports: 0
			};
			let t = f;
			const [o, s] = a(n, t);
			t += s;
			for (let r = 0; r < o; r++) t = _(n, t, e);
			r = e.funcImports;
		} else if (7 === e) {
			let e = f;
			const [r, s] = a(n, e);
			e += s;
			for (let i = 0; i < r; i++) {
				const [r, s] = a(n, e);
				e += s;
				const i = new TextDecoder().decode(n.subarray(e, e + r));
				e += r;
				const l = n[e++], [c, f] = a(n, e);
				if (e += f, 0 === l && i === t) {
					o = c;
					break;
				}
			}
		} else 10 === e && (s = {
			offset: f,
			size: l
		});
		i = f + l;
	}
	if (null === o || null === s) return null;
	let l = s.offset;
	const [g, p] = a(n, l);
	return l += p, function e(t, o = 0) {
		if (o > 4) return null;
		const s = function(e) {
			const t = e - r;
			if (t < 0 || t >= g) return null;
			let o = l;
			for (let r = 0; r < t; r++) {
				const [e, t] = a(n, o);
				o += t + e;
			}
			const [s, i] = a(n, o);
			return o += i, {
				start: o,
				end: o + s
			};
		}(t);
		if (!s) return null;
		const i = function(e, t) {
			if (e >= t) return null;
			const [r, o] = a(n, e);
			e += o;
			for (let s = 0; s < r; s++) {
				const [, r] = a(n, e);
				if (e += r, ++e > t) return null;
			}
			return e;
		}(s.start, s.end);
		if (null === i) return null;
		let _ = i;
		const p = s.end;
		for (; _ < p;) {
			const t = n[_++];
			if (11 !== t) {
				if (65 === t) {
					const [e] = c(n, _), [, t] = c(n, _), r = _ + t;
					if (15 === n[r] || 11 === n[r] && r + 1 === p) return e;
					_ = r;
				} else if (16 === t) {
					const [t, r] = a(n, _), s = _ + r;
					if (15 === n[s] || 11 === n[s] && s + 1 === p) {
						const n = e(t, o + 1);
						if (null !== n) return n;
					}
					_ = s;
				} else if (12 === t || 13 === t || 18 === t || 210 === t) {
					const [, e] = a(n, _);
					_ += e;
				} else if (2 === t || 3 === t || 4 === t) _ = u(n, _);
				else if (14 === t) {
					const [e, t] = a(n, _);
					_ += t;
					for (let r = 0; r <= e; r++) {
						const [, e] = a(n, _);
						_ += e;
					}
				} else if (17 === t) {
					const [, e] = a(n, _);
					_ += e;
					const [, t] = a(n, _);
					_ += t;
				} else if (28 === t) {
					const [e, t] = a(n, _);
					_ += t;
					for (let r = 0; r < e; r++) {
						const [, e] = a(n, _);
						_ += e;
					}
				} else if (t >= 32 && t <= 38 || 208 === t) {
					const [, e] = a(n, _);
					_ += e;
				} else if (t >= 40 && t <= 62) _ = d(n, _);
				else if (63 === t || 64 === t) _++;
				else if (66 === t) {
					const [, e] = f(n, _);
					_ += e;
				} else if (67 === t) _ += 4;
				else if (68 === t) _ += 8;
				else if (252 === t || 253 === t || 254 === t) {
					const e = m(t, n, _);
					if (null === e) return null;
					_ = e;
				}
			} else if (_ === p) return null;
		}
		return null;
	}(o);
}
function p(e) {
	return WebAssembly.Module.imports(e).some((e) => "wasi_snapshot_preview1" === e.module);
}
function b(e) {
	return WebAssembly.Module.exports(e).some((e) => "memory" === e.name && "memory" === e.kind);
}
const h = l.Mmap;
function w(e, t, n, r, o) {
	const s = n || [], a = r || [], c = new TextEncoder(), f = (e) => "bigint" == typeof e ? Number(e) : e;
	return {
		kernel_get_argc: () => s.length,
		kernel_argv_read: (t, n, r) => {
			if (t >= s.length) return 0;
			const o = c.encode(s[t]), i = Math.min(o.length, r);
			return new Uint8Array(e.buffer, f(n), i).set(o.subarray(0, i)), i;
		},
		kernel_environ_count: () => a.length,
		kernel_environ_get: (t, n, r) => {
			if (t >= a.length) return -1;
			const o = c.encode(a[t]), s = Math.min(o.length, r);
			return new Uint8Array(e.buffer, f(n), s).set(o.subarray(0, s)), s;
		},
		kernel_is_fork_child: () => 0,
		kernel_apply_fork_fd_actions: () => 0,
		kernel_get_fork_exec_path: (e, t) => 0,
		kernel_get_fork_exec_argc: () => 0,
		kernel_get_fork_exec_argv: (e, t, n) => 0,
		kernel_push_argv: (e, t) => {},
		kernel_clear_fork_exec: () => 0,
		kernel_execve: (e) => -38,
		kernel_exit: (n) => {
			const r = new DataView(e.buffer), s = t;
			r.setInt32(s + 4, l.Exit, !0), r.setBigInt64(s + 8, BigInt(n), !0);
			const i = new Int32Array(e.buffer);
			for (Atomics.store(i, (s + 0) / 4, 1), Atomics.notify(i, (s + 0) / 4, 1); "ok" === Atomics.wait(i, (s + 0) / 4, 1););
			Atomics.store(i, (s + 0) / 4, 0), o?.(n);
		},
		kernel_clone: (n, r, o, s, i, a, c) => {
			const u = l.Clone, d = new DataView(e.buffer), m = t;
			d.setInt32(m + 4, u, !0), d.setBigInt64(m + 8 + 0, BigInt(o), !0), d.setBigInt64(m + 8 + 8, BigInt(r), !0), d.setBigInt64(m + 8 + 16, BigInt(i), !0), d.setBigInt64(m + 8 + 24, BigInt(a), !0), d.setBigInt64(m + 8 + 32, BigInt(c), !0), d.setBigInt64(m + 8 + 40, 0n, !0), d.setUint32(m + 72, f(n), !0), d.setUint32(m + 72 + 4, f(s), !0);
			const _ = new Int32Array(e.buffer);
			for (Atomics.store(_, (m + 0) / 4, 1), Atomics.notify(_, (m + 0) / 4, 1); "ok" === Atomics.wait(_, (m + 0) / 4, 1););
			const g = Number(d.getBigInt64(m + 56, !0)), p = d.getUint32(m + 64, !0);
			return Atomics.store(_, (m + 0) / 4, 0), p ? -p : g;
		},
		kernel_fork: () => {
			const n = new DataView(e.buffer), r = t;
			n.setInt32(r + 4, i, !0);
			for (let e = 0; e < 6; e++) n.setBigInt64(r + 8 + 8 * e, 0n, !0);
			const o = new Int32Array(e.buffer);
			for (Atomics.store(o, (r + 0) / 4, 1), Atomics.notify(o, (r + 0) / 4, 1); "ok" === Atomics.wait(o, (r + 0) / 4, 1););
			const s = Number(n.getBigInt64(r + 56, !0)), l = n.getUint32(r + 64, !0);
			return Atomics.store(o, (r + 0) / 4, 0), l ? -l : s;
		}
	};
}
function y(e, t, n, r, s, i) {
	let l = null;
	const a = /* @__PURE__ */ new Map(), c = new TextDecoder(), f = new TextEncoder(), u = t - v - (8 === i ? S : A), d = 8 === i ? E : x, m = (e, t) => 8 === i ? Number(e.getBigUint64(t, !0)) : e.getUint32(t, !0), _ = (e, t, n) => {
		8 === i ? e.setBigUint64(t, BigInt(n), !0) : e.setUint32(t, n, !0);
	}, g = (n, r) => {
		const o = n + Math.max(r, 1) - 1, s = new DataView(e.buffer), i = t;
		s.setInt32(i + 4, h, !0), s.setBigInt64(i + 8 + 0, 0n, !0), s.setBigInt64(i + 8 + 8, BigInt(o), !0), s.setBigInt64(i + 8 + 16, BigInt(3), !0), s.setBigInt64(i + 8 + 24, BigInt(34), !0), s.setBigInt64(i + 8 + 32, -1n, !0), s.setBigInt64(i + 8 + 40, 0n, !0);
		const l = new Int32Array(e.buffer);
		for (Atomics.store(l, (i + 0) / 4, 1), Atomics.notify(l, (i + 0) / 4, 1); "ok" === Atomics.wait(l, (i + 0) / 4, 1););
		const a = Number(s.getBigInt64(i + 56, !0)), c = s.getUint32(i + 64, !0);
		if (Atomics.store(l, (i + 0) / 4, 0), c || a < 0) throw new Error(`dlopen: mmap(${o}) failed errno=${c || -a}`);
		return function(e, t) {
			return Math.ceil(e / t) * t;
		}("bigint" == typeof (f = a) ? Number(f) : f, Math.max(r, 1));
		var f;
	}, p = () => {
		if (l) return l;
		const t = n(), i = r();
		if (!t || !i) throw new Error("dlopen: program has no table or stack pointer");
		const c = new Set([
			"memory",
			"__indirect_function_table",
			"__memory_base",
			"__table_base",
			"__stack_pointer"
		]), f = /* @__PURE__ */ new Map(), u = s();
		if (u) for (const [e, n] of Object.entries(u.exports)) c.has(e) || ("function" == typeof n || n instanceof WebAssembly.Global) && f.set(e, n);
		return l = new o({
			memory: e,
			table: t,
			stackPointer: i,
			allocateMemory: g,
			globalSymbols: f,
			got: /* @__PURE__ */ new Map(),
			loadedLibraries: a
		}), l;
	};
	return {
		imports: {
			__wasm_dlopen: (t, n, r, o) => {
				const s = new Uint8Array(e.buffer, t, n), l = new Uint8Array(s), b = new Uint8Array(e.buffer, r, o), h = new Uint8Array(b), w = c.decode(h), y = p().dlopenSync(w, l);
				if (y > 0) {
					const t = a.get(w);
					if (!t) throw new Error(`__wasm_dlopen(${w}): handle=${y} but loadedLibraries lookup failed`);
					((t, n, r) => {
						const o = f.encode(t), s = o.length, l = s + 7 & -8, a = g(d + l + n.length, 8), c = a + d, p = c + l, b = new DataView(e.buffer);
						8 === i ? (b.setBigUint64(a + 0, 0n, !0), b.setBigUint64(a + 8, BigInt(c), !0), b.setBigUint64(a + 16, BigInt(s), !0), b.setBigUint64(a + 24, BigInt(p), !0), b.setBigUint64(a + 32, BigInt(n.length), !0), b.setBigUint64(a + 40, BigInt(r), !0)) : (b.setUint32(a + 0, 0, !0), b.setUint32(a + 4, c, !0), b.setUint32(a + 8, s, !0), b.setUint32(a + 12, p, !0), b.setUint32(a + 16, n.length, !0), b.setUint32(a + 20, r, !0)), new Uint8Array(e.buffer, c, s).set(o), new Uint8Array(e.buffer, p, n.length).set(n);
						const h = m(b, u);
						if (0 === h) return void _(b, u, a);
						let w = h;
						for (;;) {
							const e = m(b, w);
							if (0 === e) return void _(b, w, a);
							w = e;
						}
					})(w, l, t.memoryBase);
				}
				return y;
			},
			__wasm_dlsym: (t, n, r) => {
				const o = new Uint8Array(e.buffer, n, r), s = new Uint8Array(o), i = c.decode(s), l = p().dlsym(t, i);
				return null === l ? 0 : l;
			},
			__wasm_dlclose: (e) => p().dlclose(e),
			__wasm_dlerror: (t, n) => {
				const r = p().dlerror();
				if (!r) return 0;
				const o = f.encode(r), s = Math.min(o.length, n);
				return new Uint8Array(e.buffer, t, s).set(o.subarray(0, s)), s;
			}
		},
		replayDlopens: () => {
			const t = new DataView(e.buffer);
			let n = m(t, u);
			if (0 === n) return;
			const r = p();
			for (; 0 !== n;) {
				let o, s, l, a, f, u;
				8 === i ? (o = Number(t.getBigUint64(n + 0, !0)), s = Number(t.getBigUint64(n + 8, !0)), l = Number(t.getBigUint64(n + 16, !0)), a = Number(t.getBigUint64(n + 24, !0)), f = Number(t.getBigUint64(n + 32, !0)), u = Number(t.getBigUint64(n + 40, !0))) : (o = t.getUint32(n + 0, !0), s = t.getUint32(n + 4, !0), l = t.getUint32(n + 8, !0), a = t.getUint32(n + 12, !0), f = t.getUint32(n + 16, !0), u = t.getUint32(n + 20, !0));
				const d = c.decode(new Uint8Array(new Uint8Array(e.buffer, s, l))), m = new Uint8Array(new Uint8Array(e.buffer, a, f));
				if (0 === r.dlopenSync(d, m, { memoryBase: u })) throw new Error(`dlopen(${d}): ${r.dlerror() || "unknown"}`);
				n = o;
			}
		}
	};
}
function k(e, t, n, r, o, s, i = 4) {
	const l = { memory: t }, a = (e) => "bigint" == typeof e ? Number(e) : e, c = (e) => 8 === i ? BigInt(e) : e, f = WebAssembly.Module.imports(e);
	if (f.some((e) => "env" === e.module && "__channel_base" === e.name && "global" === e.kind) && (l.__channel_base = 8 === i ? new WebAssembly.Global({
		value: "i64",
		mutable: !0
	}, BigInt(r)) : new WebAssembly.Global({
		value: "i32",
		mutable: !0
	}, r)), f.some((e) => "env" === e.module && "__c_longjmp" === e.name && "tag" === e.kind)) {
		const e = WebAssembly.Tag;
		e && (l.__c_longjmp = new e({ parameters: ["i32"] }));
	}
	if (o && Object.assign(l, o), s) {
		const e = (e) => {
			const t = s()?.exports.malloc;
			return t ? t(e || (8 === i ? 1n : 1)) : 8 === i ? 0n : 0;
		}, t = (e) => {
			const t = s()?.exports.free;
			t && t(e);
		};
		l._Znwm = e, l._Znam = e, l._ZdlPv = t, l._ZdlPvm = t, l._ZdaPv = t, l._ZdaPvm = t, l._ZnwmRKSt9nothrow_t = e, l._ZnamRKSt9nothrow_t = e;
	}
	l.__cxa_guard_acquire = (e) => new Uint8Array(t.buffer)[a(e)] ? 0 : 1, l.__cxa_guard_release = (e) => {
		new Uint8Array(t.buffer)[a(e)] = 1;
	}, l.__cxa_guard_abort = (e) => {}, l.__cxa_pure_virtual = () => {
		throw new Error("pure virtual method called");
	}, l.__cxa_atexit = () => 0, l.__cxa_thread_atexit = () => 0, l._ZNSt3__122__libcpp_verbose_abortEPKcz = (e, t) => {
		throw new Error("libc++ verbose abort");
	}, l._ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_ = (e, t, n) => {
		throw new Error("libc++ sort called unexpectedly");
	};
	const u = /* @__PURE__ */ new Map();
	l.__dynamic_cast = (e, n, r, o) => {
		const s = a(e), l = a(r);
		if (0 === s) return c(0);
		const f = new DataView(t.buffer), d = t.buffer.byteLength, m = i, _ = (e) => 8 === m ? Number(f.getBigUint64(e, !0)) : f.getUint32(e, !0), g = _(s);
		if (0 === g || g >= d) return c(0);
		if (g < 2 * m) return c(0);
		const p = _(g - m);
		if (0 === p || p >= d) return c(0);
		const b = (h = g - 2 * m, 8 === m ? Number(f.getBigInt64(h, !0)) : f.getInt32(h, !0));
		var h;
		if (p === l) return c(s + b);
		const w = 2 * m, y = m + m, k = u, v = (e, t, n) => {
			if (e === t) return !0;
			if (0 === e || e >= d || n.has(e)) return !1;
			if (n.add(e), e + w + m > d) return !1;
			const r = k.get(e);
			if (0 === r) return !1;
			if (1 === r) return v(_(e + w), t, n);
			if (2 === r) {
				const r = f.getUint32(e + w + 4, !0);
				for (let o = 0; o < r; o++) {
					const r = _(e + w + 8 + o * y);
					if (r > 0 && v(r, t, n)) return !0;
				}
				return !1;
			}
			const o = _(e + w);
			if (o > 256 && o + m <= d) {
				const r = _(o + m);
				if (r > 0 && r < d) {
					if (k.set(e, 1), v(o, t, n)) return !0;
					k.delete(e);
				}
			}
			if (f.getUint32(e + w, !0) <= 3 && e + w + 8 <= d) {
				const r = f.getUint32(e + w + 4, !0);
				if (r > 0 && r < 100 && e + w + 8 + r * y <= d) {
					k.set(e, 2);
					for (let o = 0; o < r; o++) {
						const r = _(e + w + 8 + o * y);
						if (r > 0 && v(r, t, n)) return !0;
					}
					return !1;
				}
			}
			return k.set(e, 0), !1;
		};
		return v(p, l, /* @__PURE__ */ new Set()) ? c(s + b) : c(0);
	}, l._ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_ = (e, n) => {
		const r = a(e), o = a(n), s = new DataView(t.buffer), i = (o - r) / 8, l = [];
		for (let t = 0; t < i; t++) l.push(s.getBigUint64(r + 8 * t, !0));
		l.sort((e, t) => e < t ? -1 : e > t ? 1 : 0);
		for (let t = 0; t < i; t++) s.setBigUint64(r + 8 * t, l[t], !0);
	};
	for (const m of WebAssembly.Module.imports(e)) "function" === m.kind && ("env" === m.module ? l[m.name] || (l[m.name] = (...e) => {
		throw new Error(`Unimplemented import: env.${m.name}`);
	}) : "kernel" === m.module && (n[m.name] || (n[m.name] = (...e) => 0)));
	const d = { env: l };
	return Object.keys(n).length > 0 && (d.kernel = n), d;
}
const v = 16384, A = 12, S = 24, x = 24, E = 48, I = [
	"wpk_fork_unwind_begin",
	"wpk_fork_unwind_end",
	"wpk_fork_rewind_begin",
	"wpk_fork_rewind_end",
	"wpk_fork_state"
];
function B(e, t) {
	const n = new Set(e.map((e) => e.name)), r = [...n].filter((e) => e.startsWith("asyncify_"));
	if (r.length > 0) throw new Error(`pid=${t}: user program exports legacy Asyncify instrumentation (${r.join(", ")}). This host requires wasm-fork-instrument artifacts exporting wpk_fork_*; rebuild the package for the current ABI.`);
	const o = I.filter((e) => n.has(e));
	if (o.length > 0 && o.length !== I.length) {
		const e = I.filter((e) => !n.has(e));
		throw new Error(`pid=${t}: incomplete wasm-fork-instrument exports; missing ${e.join(", ")}. Rebuild the package for the current ABI.`);
	}
	return o.length === I.length;
}
function U(e, t, n) {
	if (void 0 === t) return;
	const r = function(e) {
		return g(e, "__abi_version");
	}(e);
	if (null !== r) {
		if (r !== t) throw new Error(`pid=${n}: ABI version mismatch — kernel advertises ${t}, user program built against ${r}. Rebuild the program against the current kernel, or roll back the kernel to the matching version. See docs/abi-versioning.md.`);
	} else M || (M = !0, console.warn(`[worker] pid=${n}: user program lacks __abi_version export — legacy binary predates ABI marker rollout. Rebuild against the current glue (channel_syscall.c) to pick up the check. See docs/abi-versioning.md.`));
}
let M = !1;
function W(e, t, n, r, o, s = 4) {
	if (WebAssembly.Module.imports(t).some((e) => "env" === e.module && "__channel_base" === e.name && "global" === e.kind)) return;
	const i = e.exports.__tls_base, l = new DataView(n.buffer), a = i ? Number(i.value) : 0;
	if (a > 0) {
		let e = -1;
		o && (e = function(e) {
			const t = new Uint8Array(e);
			if (t.length < 8) return -1;
			function n(e, t) {
				let n = 0, r = 0, o = t;
				for (;;) {
					const t = e[o++];
					if (n |= (127 & t) << r, !(128 & t)) break;
					r += 7;
				}
				return [n, o - t];
			}
			const r = [];
			let o = 0, s = 8;
			for (; s < t.length;) {
				const e = t[s], [o, i] = n(t, s + 1);
				r.push({
					id: e,
					contentOffset: s + 1 + i,
					contentSize: o
				}), s += 1 + i + o;
			}
			for (const a of r) if (2 === a.id) {
				let e = a.contentOffset;
				const [r, s] = n(t, e);
				e += s;
				for (let i = 0; i < r; i++) {
					const [r, s] = n(t, e);
					e += s + r;
					const [i, l] = n(t, e);
					e += l + i;
					const a = t[e++];
					if (0 === a) {
						o++;
						const [, r] = n(t, e);
						e += r;
					} else if (1 === a) {
						e++;
						const r = t[e++], [, o] = n(t, e);
						if (e += o, 1 & r) {
							const [, r] = n(t, e);
							e += r;
						}
					} else if (2 === a) {
						const r = t[e++], [, o] = n(t, e);
						if (e += o, 1 & r) {
							const [, r] = n(t, e);
							e += r;
						}
					} else 3 === a && (e += 2);
				}
				break;
			}
			let i = -1;
			for (const a of r) if (7 === a.id) {
				let e = a.contentOffset;
				const [r, o] = n(t, e);
				e += o;
				for (let s = 0; s < r; s++) {
					const [r, o] = n(t, e);
					e += o;
					const s = new TextDecoder().decode(t.subarray(e, e + r));
					e += r;
					const l = t[e++], [a, c] = n(t, e);
					if (e += c, 0 === l && "__get_channel_base_addr" === s) {
						i = a;
						break;
					}
				}
				break;
			}
			if (i < 0) return -1;
			const l = i - o;
			if (l < 0) return -1;
			for (const a of r) {
				if (10 !== a.id) continue;
				let e = a.contentOffset;
				const [, r] = n(t, e);
				e += r;
				for (let o = 0; o < l; o++) {
					const [r, o] = n(t, e);
					e += o + r;
				}
				const [, s] = n(t, e);
				e += s;
				const [i, c] = n(t, e);
				e += c;
				for (let o = 0; o < i; o++) {
					const [, r] = n(t, e);
					e += r, e++;
				}
				const f = 65, u = 66;
				if (t[e] === f || t[e] === u) {
					e++;
					const [r] = n(t, e);
					return r;
				}
				if (35 === t[e]) {
					let r = e + 1;
					const [, o] = n(t, r);
					if (r += o, t[r] === f || t[r] === u) {
						r++;
						const [e] = n(t, r);
						return e;
					}
				}
				if (16 !== t[e]) return -1;
				e++;
				const [, d] = n(t, e);
				if (e += d, 16 !== t[e]) return -1;
				e++;
				const [m] = n(t, e), _ = m - o;
				if (_ < 0) return -1;
				let g = a.contentOffset;
				const [, p] = n(t, g);
				g += p;
				for (let o = 0; o < _; o++) {
					const [e, r] = n(t, g);
					g += r + e;
				}
				const [, b] = n(t, g);
				g += b;
				const [h, w] = n(t, g);
				g += w;
				for (let o = 0; o < h; o++) {
					const [, e] = n(t, g);
					g += e, g++;
				}
				if (t[g] !== f && t[g] !== u) return -1;
				g++;
				const [y] = n(t, g);
				return y;
			}
			return -1;
		}(o));
		const t = a + (e >= 0 ? e : 0);
		8 === s ? l.setBigUint64(t, BigInt(r), !0) : l.setUint32(t, r, !0);
	}
}
function G(e, t) {
	const n = new DataView(e.buffer);
	n.setInt32(t + 4, i, !0);
	for (let i = 0; i < 6; i++) n.setBigInt64(t + 8 + 8 * i, 0n, !0);
	const r = new Int32Array(e.buffer);
	for (Atomics.store(r, (t + 0) / 4, 1), Atomics.notify(r, (t + 0) / 4, 1); "ok" === Atomics.wait(r, (t + 0) / 4, 1););
	const o = Number(n.getBigInt64(t + 56, !0)), s = n.getUint32(t + 64, !0);
	return Atomics.store(r, (t + 0) / 4, 0), s ? -s : o;
}
async function $(e, t) {
	const { memory: n, channelOffset: r, pid: o, tid: s, fnPtr: i, argPtr: a, stackPtr: c, tlsPtr: f, ctidPtr: u } = t, d = t.tlsOffset ?? t.tlsAllocAddr, m = t.ptrWidth ?? 4;
	let _;
	try {
		let u = null;
		t.programModule || (u = function(e) {
			const t = new Uint8Array(e);
			if (t.length < 8) return e;
			function n(e, t) {
				let n = 0, r = 0, o = t;
				for (;;) {
					const t = e[o++];
					if (n |= (127 & t) << r, !(128 & t)) break;
					r += 7;
				}
				return [n, o - t];
			}
			function r(e) {
				const t = [];
				do {
					let n = 127 & e;
					0 != (e >>>= 7) && (n |= 128), t.push(n);
				} while (0 !== e);
				return t;
			}
			const o = [];
			let s = 0, i = !1, l = 8;
			for (; l < t.length;) {
				const e = t[l], [r, s] = n(t, l + 1), a = l + 1 + s, c = 1 + s + r;
				o.push({
					id: e,
					offset: l,
					totalSize: c,
					contentOffset: a,
					contentSize: r
				}), 8 === e && (i = !0), l += c;
			}
			if (!i) return e;
			for (const y of o) if (2 === y.id) {
				let e = y.contentOffset;
				const [r, o] = n(t, e);
				e += o;
				for (let i = 0; i < r; i++) {
					const [r, o] = n(t, e);
					e += o + r;
					const [i, l] = n(t, e);
					e += l + i;
					const a = t[e++];
					if (0 === a) {
						s++;
						const [, r] = n(t, e);
						e += r;
					} else if (1 === a) {
						e++;
						const r = t[e++], [, o] = n(t, e);
						if (e += o, 1 & r) {
							const [, r] = n(t, e);
							e += r;
						}
					} else if (2 === a) {
						const r = t[e++], [, o] = n(t, e);
						if (e += o, 1 & r) {
							const [, r] = n(t, e);
							e += r;
						}
					} else 3 === a && (e++, e++);
				}
				break;
			}
			let a = -1, c = [];
			const f = /* @__PURE__ */ new Map();
			for (const y of o) if (7 === y.id) {
				let e = y.contentOffset;
				const [r, o] = n(t, e);
				e += o;
				for (let s = 0; s < r; s++) {
					const [r, o] = n(t, e);
					e += o;
					const s = new TextDecoder().decode(t.subarray(e, e + r));
					e += r;
					const i = t[e++], [l, a] = n(t, e);
					e += a, 0 === i && (c.push(l), f.set(s, l));
				}
				break;
			}
			function u(e) {
				const [, r] = n(t, e);
				return e + r;
			}
			function d(e) {
				return e = u(e), u(e);
			}
			function m(e, r) {
				const o = r - s;
				if (o < 0) return null;
				let i = e.contentOffset;
				const [l, a] = n(t, i);
				if (i += a, o >= l) return null;
				for (let s = 0; s < o; s++) {
					const [e, r] = n(t, i);
					i += r + e;
				}
				const [c, f] = n(t, i);
				i += f;
				const d = i + c, [m, _] = n(t, i);
				i += _;
				for (let t = 0; t < m; t++) i = u(i), i++;
				return {
					start: i,
					end: d
				};
			}
			function _(e, r) {
				const o = m(e, r);
				if (!o) return [];
				const s = [];
				let i = o.start;
				for (; i < o.end;) {
					const e = t[i++];
					if (16 === e) {
						const [e, r] = n(t, i);
						i += r, s.push(e);
					} else if (17 === e || 19 === e) i = u(i), i = u(i);
					else if (18 === e || 20 === e || 21 === e) i = u(i);
					else if (2 === e || 3 === e || 4 === e) i = 64 === t[i] || t[i] >= 112 ? i + 1 : u(i);
					else if (12 === e || 13 === e || e >= 32 && e <= 38 || 208 === e || 210 === e) i = u(i);
					else if (14 === e) {
						const [e, r] = n(t, i);
						i += r;
						for (let t = 0; t <= e; t++) i = u(i);
					} else if (e >= 40 && e <= 62) i = d(i);
					else if (63 === e || 64 === e) i++;
					else if (65 === e || 66 === e) i = u(i);
					else if (67 === e) i += 4;
					else if (68 === e) i += 8;
					else if (252 === e) {
						const [e, r] = n(t, i);
						i += r, 8 === e || 10 === e || 12 === e || 14 === e ? i = u(u(i)) : e >= 9 && e <= 17 && (i = u(i));
					} else if (254 === e) i = u(i), i = d(i);
					else if (253 === e) break;
				}
				return s;
			}
			for (const y of o) if (10 === y.id && c.length > 0) {
				const e = [
					"__wasm_init_tls",
					"__abi_version",
					"__get_channel_base_addr",
					"_start",
					"__wasm_thread_init"
				], r = /* @__PURE__ */ new Map();
				let o = 0;
				for (const t of e) {
					const e = f.get(t);
					if (void 0 === e) continue;
					const n = new Set(_(y, e).filter((e) => e >= s));
					for (const t of n) {
						const e = r.get(t);
						e ? e.count++ : r.set(t, {
							count: 1,
							firstOrder: o++
						});
					}
				}
				let i = null;
				for (const [t, n] of r) n.count >= 2 && (!i || n.count > i.count || n.count === i.count && n.firstOrder < i.firstOrder) && (i = {
					target: t,
					count: n.count,
					firstOrder: n.firstOrder
				});
				if (i) a = i.target;
				else for (const l of c) {
					const e = m(y, l);
					if (!e || 16 !== t[e.start]) continue;
					const [r] = n(t, e.start + 1);
					if (r >= s) {
						a = r;
						break;
					}
				}
				break;
			}
			const g = a >= 0 ? a - s : -1, p = [];
			p.push(t.subarray(0, 8));
			for (const y of o) if (8 !== y.id) if (10 === y.id && g >= 0) {
				let e = y.contentOffset;
				const [o, s] = n(t, e);
				e += s;
				let i = e;
				for (let r = 0; r < g; r++) {
					const [e, r] = n(t, i);
					i += r + e;
				}
				const [l, a] = n(t, i), c = i + a + l, f = new Uint8Array([
					2,
					0,
					11
				]), u = i - y.contentOffset, d = y.contentOffset + y.contentSize - c, m = r(u + f.length + d);
				p.push(new Uint8Array([10])), p.push(new Uint8Array(m)), p.push(t.subarray(y.contentOffset, i)), p.push(f), p.push(t.subarray(c, y.contentOffset + y.contentSize));
			} else p.push(t.subarray(y.offset, y.offset + y.totalSize));
			const b = p.reduce((e, t) => e + t.length, 0), h = new Uint8Array(b);
			let w = 0;
			for (const y of p) h.set(y, w), w += y.length;
			return h.buffer;
		}(t.programBytes));
		const p = t.programModule ? t.programModule : new WebAssembly.Module(u), b = B(WebAssembly.Module.exports(p), o), h = r - v;
		let y = 0, A = null;
		const S = w(n, r, void 0, void 0, (e) => {
			A = e;
		});
		S.kernel_fork = b ? () => {
			if (!_) return -38;
			return 2 === (0, _.exports.wpk_fork_state)() ? (_.exports.wpk_fork_rewind_end(), y) : (_.exports.wpk_fork_unwind_begin(h), 0);
		} : () => {
			throw new Error(`pid=${o} tid=${s}: kernel_fork reached without complete wasm-fork-instrument exports. Rebuild the program with scripts/run-wasm-fork-instrument.sh.`);
		};
		const x = k(p, n, S, r, void 0, () => _, m), E = new WebAssembly.Instance(p, x);
		_ = E;
		const I = E.exports.__wasm_init_tls, U = d;
		I && U > 0 && I(8 === m ? BigInt(U) : U);
		const M = E.exports.__stack_pointer;
		M && (M.value = 8 === m ? BigInt(c) : c);
		const $ = E.exports.__wasm_thread_init;
		$ && f > 0 && $(8 === m ? BigInt(f) : f), W(E, p, n, r, t.programBytes, m);
		const P = E.exports.__indirect_function_table;
		if (!P) throw new Error("No __indirect_function_table export — cannot call thread function");
		const T = 8 === m ? BigInt(i) : i, O = P.get(T);
		if (!O) throw new Error(`Thread function at table index ${i} is null`);
		const R = 8 === m ? BigInt(a) : a;
		let F = 0;
		if (b) {
			const e = E.exports.wpk_fork_state, t = E.exports.wpk_fork_unwind_end, o = E.exports.wpk_fork_rewind_begin;
			let s = !1;
			for (;;) {
				s && (o(h), s = !1);
				try {
					const e = O(R);
					F = Number(e);
				} catch (g) {
					if (g instanceof Error && g.message.includes("unreachable") && null !== A) {
						F = A;
						break;
					}
					throw g;
				}
				if (1 === e()) {
					t();
					const e = G(n, r);
					if (e < 0) throw new Error("Fork failed: errno=" + -e);
					y = e, s = !0;
					continue;
				}
				break;
			}
		} else try {
			const e = O(R);
			F = Number(e);
		} catch (g) {
			if (!(g instanceof Error && g.message.includes("unreachable") && null !== A)) throw g;
			F = A;
		}
		{
			const e = new DataView(n.buffer), t = r;
			e.setInt32(t + 4, l.Exit, !0), e.setInt32(t + 8, F ?? 0, !0);
			const o = new Int32Array(n.buffer);
			for (Atomics.store(o, (t + 0) / 4, 1), Atomics.notify(o, (t + 0) / 4, 1); "ok" === Atomics.wait(o, (t + 0) / 4, 1););
			Atomics.store(o, (t + 0) / 4, 0);
		}
		e.postMessage({
			type: "thread_exit",
			pid: o,
			tid: s
		});
	} catch (p) {
		const t = p instanceof Error ? `${p.message}\n${p.stack ?? ""}` : String(p);
		e.postMessage({
			type: "error",
			pid: o,
			message: `Thread worker failed: ${t}`
		});
	}
}
const P = globalThis;
P.onmessage = (e) => {
	const t = e.data, n = {
		postMessage: (e, t) => P.postMessage(e, t),
		on: (e, t) => {
			"message" === e && (P.onmessage = (e) => t(e.data));
		}
	};
	if ("centralized_init" === t.type) (async function(t, n) {
		try {
			const { memory: r, programBytes: o, channelOffset: s, pid: i } = n, l = n.ptrWidth ?? 4, a = n.programModule ? n.programModule : await WebAssembly.compile(o);
			if (p(a)) {
				if (b(a)) throw new Error("WASI module defines its own memory. Only modules that import memory (compiled with --import-memory) are supported.");
				const { WasiShim: o, WasiExit: l } = await import("./wasi-shim-CFYuAD4O.js"), c = new o(r, s, n.argv || [], n.env || []), f = {
					wasi_snapshot_preview1: c.getImports(),
					env: { memory: r }
				}, u = WebAssembly.Module.imports(a);
				for (const e of u) "env" === e.module && "memory" !== e.name && (f.env[e.name] || (f.env[e.name] = "function" === e.kind ? (...t) => {
					throw new Error(`Unimplemented WASI env import: ${e.name}`);
				} : void 0));
				const d = await WebAssembly.instantiate(a, f);
				c.init(), t.postMessage({
					type: "ready",
					pid: i
				});
				let m = 0;
				try {
					const e = d.exports._start;
					e && e();
				} catch (e) {
					if (!(e instanceof l)) throw e;
					m = e.code;
				}
				t.postMessage({
					type: "exit",
					pid: i,
					status: m
				});
				return;
			}
			let c = null;
			const f = w(r, s, n.argv || [], n.env || [], (e) => {
				c = e;
			}), u = B(WebAssembly.Module.exports(a), i);
			let d = 0;
			const m = s - v;
			if (u) {
				let u = null;
				f.kernel_fork = () => u ? 2 === (0, u.exports.wpk_fork_state)() ? (u.exports.wpk_fork_rewind_end(), d) : (u.exports.wpk_fork_unwind_begin(m), 0) : -38;
				const _ = y(r, s, () => u?.exports.__indirect_function_table, () => u?.exports.__stack_pointer, () => u ?? void 0, l), g = k(a, r, f, s, _.imports, () => u ?? void 0, l), p = await WebAssembly.instantiate(a, g);
				u = p, U(o, n.kernelAbiVersion, i), n.isForkChild || W(p, a, r, s, o, l), t.postMessage({
					type: "ready",
					pid: i
				});
				let b = 0;
				try {
					const t = p.exports._start, i = p.exports.wpk_fork_state, u = p.exports.wpk_fork_unwind_end, g = p.exports.wpk_fork_rewind_begin;
					let h = !!n.isForkChild;
					h && (d = 0);
					const w = n.isForkChild && null != n.forkBufAddr ? n.forkBufAddr : m;
					let y, k = !1;
					if (n.isForkChild && null != n.forkChildThreadFnPtr) {
						const e = p.exports.__indirect_function_table;
						if (!e) throw new Error("Fork-from-thread child: no __indirect_function_table export");
						const t = n.forkChildThreadFnPtr, r = 8 === l ? BigInt(t) : t, o = e.get(r);
						if (!o) throw new Error(`Fork-from-thread child: thread function at index ${t} is null`);
						const s = n.forkChildThreadArgPtr ?? 0, i = 8 === l ? BigInt(s) : s;
						y = () => {
							o(i);
						};
					} else y = t;
					for (;;) {
						if (h) {
							if (g(w), W(p, a, r, s, o, l), n.isForkChild && !k) {
								try {
									_.replayDlopens();
								} catch (e) {
									throw new Error(`fork-replay-dlopen failed: ${e instanceof Error ? e.message : String(e)}`);
								}
								k = !0;
							}
							h = !1;
						}
						try {
							y();
						} catch (e) {
							if (e instanceof Error && e.message.includes("unreachable") && null !== c) {
								b = c;
								break;
							}
							throw e;
						}
						if (1 === i()) {
							u();
							const e = G(r, s);
							if (e < 0) throw new Error("Fork failed: errno=" + -e);
							d = e, h = !0;
							continue;
						}
						null === c && (f.kernel_exit(0), b = c ?? 0);
						break;
					}
				} catch (e) {
					if (!(e instanceof Error && e.message.includes("unreachable") && null !== c)) throw e;
					b = c;
				}
				t.postMessage({
					type: "exit",
					pid: i,
					status: b
				});
			} else {
				f.kernel_fork = () => {
					throw new Error(`pid=${i}: kernel_fork reached without complete wasm-fork-instrument exports. Rebuild the program with scripts/run-wasm-fork-instrument.sh.`);
				};
				let u = null;
				const d = k(a, r, f, s, y(r, s, () => u?.exports.__indirect_function_table, () => u?.exports.__stack_pointer, () => u ?? void 0, l).imports, () => u ?? void 0, l), m = await WebAssembly.instantiate(a, d);
				u = m, U(o, n.kernelAbiVersion, i), W(m, a, r, s, o, l), t.postMessage({
					type: "ready",
					pid: i
				});
				let _ = 0;
				try {
					const e = m.exports._start;
					e && e(), null !== c && (_ = c);
				} catch (e) {
					if (!(e instanceof Error && e.message.includes("unreachable"))) throw e;
					if (null === c) throw e;
					_ = c;
				}
				null === c && (f.kernel_exit(_), _ = c ?? _), 0 === _ ? console.debug(`[worker] pid=${i} _start() returned, exitCode=0`) : console.error(`[worker] pid=${i} _start() returned, exitCode=${_}`), t.postMessage({
					type: "exit",
					pid: i,
					status: _
				});
			}
		} catch (r) {
			let e;
			if (r instanceof Error) e = `${r.message}\n${r.stack}`;
			else if (WebAssembly.Exception && r instanceof WebAssembly.Exception) {
				const t = r;
				e = `WebAssembly.Exception: ${t.message ?? "<no message>"}\n${t.stack ?? "<no stack>"}`;
			} else e = String(r);
			t.postMessage({
				type: "error",
				pid: n.pid,
				message: `Kernel worker failed: ${e}`
			});
		}
	})(n, e.data).catch((e) => {
		console.error(`[worker-entry-browser] centralizedWorkerMain error pid=${t.pid}:`, e);
	});
	else {
		if ("centralized_thread_init" !== t.type) throw new Error(`Unknown worker init type: ${t.type}`);
		$(n, e.data).catch((e) => {
			console.error("[worker-entry-browser] centralizedThreadWorkerMain error:", e);
		});
	}
};
export { s as i, b as n, l as r, p as t };
