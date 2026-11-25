const builtin = @import("builtin");

extern "c" fn puts(text: [*:0]const u8) c_int;

pub fn main() void {
    comptime {
        if (builtin.os.tag != .kandelo or builtin.abi != .musl)
            @compileError("expected the native Kandelo Zig target");
    }
    _ = puts("zig build inside Kandelo passed");
}
