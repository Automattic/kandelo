module fiber_acceptance;

import core.atomic : atomicLoad, atomicStore;
import core.memory : GC;
import core.thread : Fiber, Thread;
import std.concurrency : Generator, yield;
import std.exception : enforce;
import std.stdio : writeln;

private int threadValue;

private void suspendInsideCall()
{
    pragma(inline, false);
    Fiber.yield();
}

void main()
{
    const pthread = Thread.getThis();
    threadValue = 7;
    auto first = new Fiber({
        auto stackRoot = new int[23];
        stackRoot[22] = 42;
        enforce(Thread.getThis() is pthread, "fiber changed pthread");
        enforce(threadValue == 7, "fiber started with different TLS");
        suspendInsideCall();
        enforce(threadValue == 13, "fiber resumed with different TLS");
        enforce(GC.addrOf(stackRoot.ptr) !is null && stackRoot[22] == 42,
                "lost the suspended fiber's stack root");
        suspendInsideCall();
        throw new Exception("fiber exception");
    });
    auto second = new Fiber({
        enforce(Thread.getThis() is pthread, "second fiber changed pthread");
        threadValue = 13;
        suspendInsideCall();
    });

    first.call();
    second.call();
    GC.collect();
    first.call();
    second.call();
    enforce(second.state == Fiber.State.TERM, "second fiber failed to terminate");
    bool caught;
    try
        first.call();
    catch (Exception error)
        caught = error.msg == "fiber exception";
    enforce(caught && first.state == Fiber.State.TERM, "first fiber lost its exception");

    bool resumedException;
    first.reset({
        try
        {
            try
                throw new Exception("exception in flight".idup);
            finally
                suspendInsideCall();
        }
        catch (Exception error)
        {
            enforce(error.msg == "exception in flight", "lost exception during unwinding");
            resumedException = true;
        }
    });
    first.call();
    enforce(first.state == Fiber.State.HOLD, "the unwinding fiber did not suspend");
    GC.collect();
    first.call();
    enforce(resumedException && first.state == Fiber.State.TERM,
            "the unwinding fiber did not finish handling its exception");

    shared int phase;
    auto worker = new Thread({
        auto owner = Thread.getThis();
        auto fiber = new Fiber({
            auto root = new int[31];
            root[30] = 23;
            threadValue = 81;
            suspendInsideCall();
            enforce(Thread.getThis() is owner && threadValue == 93,
                    "the worker fiber lost its pthread or TLS");
            enforce(GC.addrOf(root.ptr) !is null && root[30] == 23,
                    "lost a root held by the worker's suspended fiber");
        });
        fiber.call();
        enforce(threadValue == 81 && fiber.state == Fiber.State.HOLD,
                "the worker fiber did not yield to its caller");
        atomicStore(phase, 1);
        while (atomicLoad(phase) != 2)
            Thread.yield();
        threadValue = 93;
        fiber.call();
        enforce(fiber.state == Fiber.State.TERM, "the worker fiber failed to terminate");
    });
    worker.start();
    while (atomicLoad(phase) != 1)
        Thread.yield();
    GC.collect();
    atomicStore(phase, 2);
    worker.join();
    enforce(threadValue == 13, "worker fiber TLS leaked to the main thread");

    auto sequence = new Generator!int({
        foreach (value; 1 .. 5)
            yield(value);
    });
    int expected = 1;
    foreach (value; sequence)
        enforce(value == expected++, "Phobos Generator returned an unexpected value");
    enforce(expected == 5, "Phobos Generator terminated early");
    writeln("fiber continuations ok");
}
