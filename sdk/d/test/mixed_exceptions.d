module mixed_exceptions;

import std.stdio : writeln;

extern (C) int catch_cpp_exception(int value);

void main()
{
    assert(catch_cpp_exception(42) == 42);
    try
        throw new Exception("D exception");
    catch (Exception error)
        assert(error.msg == "D exception");
    writeln("D and C++ exception handlers passed");
}
