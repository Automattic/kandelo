/**
 * sendmsg() must gather every iovec into one byte stream and recvmsg() must
 * scatter what it read back across them, the way Linux does. Both used to
 * read iov[0] alone.
 *
 * sd-bus (basu, which mako links) fronts its auth lines with an empty
 * iovec: the send returned 0 forever and mako's bus connection livelocked,
 * and a receive fronted the same way returned 0 — a fake end of stream.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const binary = tryResolveBinary("programs/sendmsg-iovec-gather.wasm");

describe("sendmsg / recvmsg iovec arrays", () => {
  it.skipIf(!binary)(
    "gathers on send and scatters on receive, ignoring empty iovecs",
    async () => {
      const result = await runCentralizedProgram({
        programPath: binary!,
        argv: ["sendmsg-iovec-gather"],
        timeout: 20_000,
      });

      const dump = `stdout=${result.stdout}\nstderr=${result.stderr}`;
      expect(result.stdout, dump).toContain("AUTH: n=15");
      expect(result.stdout, dump).toContain("GATHER: foobarbaz");
      expect(result.stdout, dump).toContain("SCATTER: quux|corge");
      expect(result.stdout, dump).toContain("LEADING_EMPTY: waldo");
      expect(result.stdout, dump).toContain("PASS");
      expect(result.exitCode, dump).toBe(0);
    },
    30_000,
  );
});
