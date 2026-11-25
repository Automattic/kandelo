const std = @import("std");
const builtin = @import("builtin");

extern "c" fn printf(format: [*:0]const u8, ...) c_int;
extern "c" fn openpty(master: *c_int, slave: *c_int, name: ?[*]u8, termp: ?*const std.c.termios, winp: ?*const std.c.winsize) c_int;

comptime {
    if (builtin.os.tag != .kandelo or builtin.abi != .musl or builtin.single_threaded)
        @compileError("expected threaded Kandelo musl");
    if (@sizeOf(std.c.Stat) != 112 or @offsetOf(std.c.Stat, "blocks") != 104 or
        @sizeOf(std.c.sigset_t) != 128 or @sizeOf(std.c.Sigaction) != 140 or
        @sizeOf(std.c.termios) != 60 or @offsetOf(std.c.termios, "cc") != 17 or
        @offsetOf(std.c.termios, "ispeed") != 52 or
        @backingInt(std.posix.V.MIN) != 6 or @backingInt(std.posix.V.TIME) != 5)
        @compileError("unexpected Kandelo libc ABI");
}

var wide: u128 = (1 << 113) + 17;
var quad: f128 = 7.0;
threadlocal var tls: u32 = 7;

fn runThread(output: *u32) void {
    tls += 5;
    output.* = tls;
}

fn checkTermios() !void {
    var master: c_int = undefined;
    var slave: c_int = undefined;
    if (openpty(&master, &slave, null, null, null) != 0) return error.OpenPty;
    defer _ = std.c.close(master);
    defer _ = std.c.close(slave);

    const min = @backingInt(std.posix.V.MIN);
    var attributes = try std.posix.tcgetattr(slave);
    attributes.cc[min] = 2;
    try std.posix.tcsetattr(slave, .NOW, attributes);
    if ((try std.posix.tcgetattr(slave)).cc[min] != 2) return error.Termios;
}

pub fn main() !void {
    const lhs = @as(*volatile u128, &wide).*;
    const f = @as(*volatile f128, &quad).*;
    if (lhs / 7 != ((1 << 113) + 17) / 7 or f / 2.0 != 3.5) return error.Builtins;
    const mem = try std.heap.c_allocator.alloc(u8, 64);
    defer std.heap.c_allocator.free(mem);
    try checkTermios();

    var outputs: [3]u32 = @splat(0);
    var threads: [3]std.Thread = undefined;
    for (&threads, &outputs) |*thread, *output| thread.* = try std.Thread.spawn(.{}, runThread, .{output});
    for (threads) |thread| thread.join();
    if (tls != 7 or !std.mem.eql(u32, &outputs, &.{ 12, 12, 12 })) return error.ThreadLocal;

    const pid = std.c.fork();
    if (pid == 0) std.c._exit(42);
    if (pid < 0) return error.Fork;
    var status: c_int = 0;
    if (std.c.waitpid(pid, &status, 0) != pid or status != 42 << 8) return error.Wait;
    _ = printf("Zig SDK smoke passed: compiler_rt, malloc, termios, three pthreads with TLS, fork and waitpid\n");
}
