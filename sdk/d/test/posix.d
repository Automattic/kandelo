module acceptance;

import core.memory : GC;
import core.stdc.errno : EBADF, errno;
import core.stdc.stdlib : exit;
import core.sys.posix.fcntl : F_DUPFD, F_GETFD, O_RDONLY, fcntl, open;
import core.sys.posix.unistd : close;
import core.thread : Thread;
import std.conv : text, to;
import std.exception : enforce;
import std.file : mkdir, readText, remove, rename, rmdirRecurse, tempDir, write;
import std.path : buildPath;
import std.process : Config, pipeProcess, Redirect, spawnProcess, thisProcessID, wait;
import std.socket : InternetAddress, socketPair, TcpSocket;
import std.stdio : writeln;

int[] threadData;

void main(string[] args)
{
    enforce(args.length >= 2, "expected one check");
    const takesOperand = args[1] == "external" || args[1] == "descriptor-child";
    enforce(args.length == (takesOperand ? 3 : 2), "wrong number of arguments");
    switch (args[1])
    {
        case "runtime":
            auto values = new int[3];
            values[2] = 42;
            GC.collect();
            enforce(values[2] == 42, "lost live allocation");
            bool caught;
            try
                throw new Exception("expected");
            catch (Exception error)
                caught = error.msg == "expected";
            enforce(caught, "D exception was not caught");
            break;
        case "file":
            auto directory = buildPath(tempDir(), text("kandelo-d-", thisProcessID));
            mkdir(directory);
            scope(exit) rmdirRecurse(directory);
            auto original = buildPath(directory, "original");
            auto renamed = buildPath(directory, "renamed");
            write(original, "guest file\n");
            rename(original, renamed);
            enforce(readText(renamed) == "guest file\n", "bad file contents");
            remove(renamed);
            break;
        case "process":
            auto child = pipeProcess([args[0], "child"], Redirect.stdout);
            auto output = child.stdout.readln();
            enforce(wait(child.pid) == 23, "bad child exit status");
            enforce(output == "process output\n", "bad child output");
            break;
        case "descriptors":
            const stream = open("/dev/null", O_RDONLY);
            enforce(stream >= 0, "could not open /dev/null");
            scope(exit) close(stream);
            const high = fcntl(stream, F_DUPFD, 64);
            enforce(high >= 64, "could not duplicate the descriptor");
            scope(exit) close(high);
            auto command = [args[0], "descriptor-child", text(high)];
            enforce(wait(spawnProcess(command)) == 19, "default spawn leaked a descriptor");
            enforce(wait(spawnProcess(command, null, Config.inheritFDs)) == 0,
                    "spawn did not inherit the descriptor");
            break;
        case "descriptor-child":
            const flags = fcntl(args[2].to!int, F_GETFD);
            enforce(flags >= 0 || errno == EBADF, "could not inspect the descriptor");
            exit(flags >= 0 ? 0 : 19);
        case "external":
            enforce(args.length == 3, "expected path to guest echo");
            auto command = pipeProcess([args[2], "echo output"], Redirect.stdout);
            auto line = command.stdout.readln();
            enforce(wait(command.pid) == 0, "echo failed");
            enforce(line == "echo output\n", "bad echo output");
            break;
        case "child":
            writeln("process output");
            exit(23);
        case "thread":
            threadData = [42];
            auto thread = new Thread({
                enforce(threadData is null, "TLS was shared");
                threadData = [7];
                GC.collect();
                enforce(threadData == [7], "lost thread-local root");
            });
            thread.start();
            thread.join();
            enforce(threadData == [42], "changed main thread's TLS");
            break;
        case "socket":
            auto server = new TcpSocket();
            scope(exit) server.close();
            server.bind(new InternetAddress("127.0.0.1", 0));
            server.listen(1);
            auto client = new TcpSocket();
            scope(exit) client.close();
            client.connect(server.localAddress());
            auto peer = server.accept();
            scope(exit) peer.close();
            enforce(client.send("ping") == 4, "send failed");
            char[4] result;
            enforce(peer.receive(result) == 4 && result[] == "ping", "bad socket response");
            break;
        case "unix":
            auto pair = socketPair();
            scope(exit) foreach (endpoint; pair) endpoint.close();
            enforce(pair[0].send("ping") == 4, "send failed");
            char[4] localResult;
            enforce(pair[1].receive(localResult) == 4 && localResult[] == "ping",
                "bad socket pair response");
            break;
        default:
            throw new Exception("unknown check");
    }
    writeln(args[1], " ok");
}
