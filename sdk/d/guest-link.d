module guest_link;

import core.sys.posix.stdlib : mkdtemp;
import std.algorithm.searching : countUntil;
import std.exception : enforce;
import std.file : rename, rmdirRecurse;
import std.path : buildPath, dirName;
import std.process : spawnProcess, wait;
import std.stdio : stderr;
import std.string : fromStringz;

int main(string[] args)
{
    try
    {
        // LDC passes the output as two arguments to its external linker.
        const index = args.countUntil("-o");
        enforce(index >= 1 && index + 1 < args.length, "expected LDC's -o <output> linker argument");
        const output = args[index + 1];
        auto pattern = (buildPath(dirName(output), ".kandelo-d-link.XXXXXX") ~ '\0').dup;
        auto directory = mkdtemp(pattern.ptr);
        enforce(directory !is null, "could not create a staging directory beside " ~ output);
        const stage = fromStringz(directory).idup;
        scope (exit) rmdirRecurse(stage);

        const artifact = buildPath(stage, "program.wasm");
        args[0] = "wasm32posix-cc";
        args[index + 1] = artifact;
        args ~= "/usr/lib/d/kandelo-abi.o";
        auto status = wait(spawnProcess(args));
        if (status != 0)
            return status;

        status = wait(spawnProcess(["wasm-fork-instrument", artifact, "-o", artifact]));
        if (status != 0)
            return status;
        rename(artifact, output);
        return 0;
    }
    catch (Exception error)
    {
        stderr.writeln("kandelo-d-link: ", error.msg);
        return 1;
    }
}
