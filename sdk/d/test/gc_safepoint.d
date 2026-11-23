module gc_safepoint;

import core.atomic : atomicLoad, atomicStore;
import core.memory : GC;
import core.thread : Thread;
import std.exception : enforce;
import std.stdio : writeln;

private shared int workerState;
private int[] threadRoot;

private void work()
{
    threadRoot = new int[16];
    threadRoot[15] = 42;
    auto stackRoot = new int[21];
    stackRoot[20] = 73;
    atomicStore(workerState, 1);
    // Keep the thread alive without issuing a syscall. The bound makes an
    // unsuccessful collection finish with a diagnostic.
    foreach (i; 0 .. (1u << 30))
    {
        if (atomicLoad(workerState) == 2)
        {
            enforce(GC.addrOf(threadRoot.ptr) !is null && threadRoot[15] == 42,
                    "lost a thread-local GC root");
            enforce(GC.addrOf(stackRoot.ptr) !is null && stackRoot[20] == 73,
                    "lost a stack GC root");
            return;
        }
    }

    atomicStore(workerState, 3);
}

void main()
{
    auto worker = new Thread(&work);
    worker.start();
    while (atomicLoad(workerState) == 0)
        Thread.yield();

    GC.collect();
    const completedWithWorkerRunning = atomicLoad(workerState) == 1;
    atomicStore(workerState, 2);
    worker.join();
    enforce(completedWithWorkerRunning, "collection did not finish while the worker was running");
    writeln("concurrent collection ok");
}
