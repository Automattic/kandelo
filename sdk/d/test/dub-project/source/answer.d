module answer;

import taggedalgebraic : TaggedAlgebraic, get;

version (Kandelo) {} else
    static assert(false, "This fixture requires Kandelo's D target");

private union Payload
{
    int number;
    string text;
}

int numberFromDependency(int number)
{
    auto payload = TaggedAlgebraic!Payload(number);
    return payload.get!int;
}

unittest
{
    import std.stdio : writeln;

    assert(numberFromDependency(42) == 42);
    writeln("DUB dependency unittest passed");
}
