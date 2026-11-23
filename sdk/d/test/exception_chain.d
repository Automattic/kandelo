module exception_chain;

import core.memory : GC;
import core.thread : Fiber;
import std.stdio : writeln;

private class Primary : Exception
{
    this(string message) { super(message); }
}

private class Secondary : Exception
{
    this(string message) { super(message); }
}

private int collectedAbandonedExceptions;

private class Abandoned : Exception
{
    this() { super("abandoned during reset"); }
    ~this() { ++collectedAbandonedExceptions; }
}

private void failPrimary()
{
    pragma(inline, false);
    throw new Primary("original".idup);
}

private void failSecondary(string message)
{
    pragma(inline, false);
    throw new Secondary(message.idup);
}

private void throwFromFinally()
{
    try
        failPrimary();
    finally
        failSecondary("replacement");
}

private void catchSecondary()
{
    bool caught;
    try
        failSecondary("handled locally");
    catch (Secondary error)
        caught = error.msg == "handled locally" && error.next is null;
    assert(caught);
}

private void exceptionCaughtInsideFinally()
{
    try
        failPrimary();
    finally
        catchSecondary();
}

private void nestedFinally()
{
    try
        failPrimary();
    finally
    {
        try
            failSecondary("second");
        finally
            failSecondary("third");
    }
}

private void suspendWithReplacement()
{
    try
        failSecondary("paused replacement");
    finally
        Fiber.yield();
}

private size_t closedEntries;

private class CleanupEntry
{
    void close()
    {
        pragma(inline, false);
        ++closedEntries;
    }
}

private void throwAcrossCleanupLoop()
{
    pragma(inline, false);
    CleanupEntry[2][32] entries;
    foreach (ref pair; entries)
        pair = [new CleanupEntry, new CleanupEntry];
    scope (exit)
        foreach (pair; entries)
            foreach (entry; pair)
                entry.close();
    throw new Primary("scope cleanup loop");
}

void main()
{
    bool chained;
    try
        throwFromFinally();
    catch (Primary error)
    {
        auto next = cast(Secondary) error.next;
        chained = error.msg == "original" && next && next.msg == "replacement" && next.next is null;
    }
    assert(chained);

    bool nested;
    try
        nestedFinally();
    catch (Primary error)
    {
        auto second = cast(Secondary) error.next;
        auto third = second ? cast(Secondary) second.next : null;
        nested = second && second.msg == "second" &&
                 third && third.msg == "third" && third.next is null;
    }
    assert(nested);

    bool isolated;
    try
        exceptionCaughtInsideFinally();
    catch (Primary error)
        isolated = error.msg == "original" && error.next is null;
    assert(isolated);

    bool loopCaught;
    try
        throwAcrossCleanupLoop();
    catch (Primary error)
        loopCaught = error.msg == "scope cleanup loop" && error.next is null;
    assert(loopCaught && closedEntries == 64);

    bool errorTookPriority;
    try
    {
        try
            failPrimary();
        finally
            throw new Error("fatal");
    }
    catch (Error error)
        errorTookPriority = error.msg == "fatal" && error.bypassedException.msg == "original";
    assert(errorTookPriority);

    bool resumed;
    auto fiber = new Fiber({
        try
        {
            try
                failPrimary();
            finally
                suspendWithReplacement();
        }
        catch (Primary error)
        {
            auto next = cast(Secondary) error.next;
            resumed = GC.addrOf(cast(void*) error) !is null &&
                      GC.addrOf(cast(void*) next) !is null &&
                      error.msg == "original" && next &&
                      next.msg == "paused replacement" && next.next is null;
        }
    });
    fiber.call();
    assert(fiber.state == Fiber.State.HOLD);
    GC.collect();
    fiber.call();
    assert(resumed && fiber.state == Fiber.State.TERM);

    fiber.reset({
        try
            throw new Abandoned();
        finally
            Fiber.yield();
    });
    fiber.call();
    assert(fiber.state == Fiber.State.HOLD);
    GC.collect();
    assert(collectedAbandonedExceptions == 0);
    fiber.reset({});
    GC.collect();
    assert(collectedAbandonedExceptions == 1);
    fiber.call();
    assert(fiber.state == Fiber.State.TERM);

    writeln("exception chains ok");
}
