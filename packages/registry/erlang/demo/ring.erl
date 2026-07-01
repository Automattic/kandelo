%% ring.erl — Classic Erlang ring benchmark (reference source)
%%
%% Spawns N processes in a ring and sends a token around M times,
%% demonstrating Erlang's lightweight process model running on a single
%% wasm32 thread via the BEAM scheduler.
%%
%% NOTE: this module is reference source; it is NOT loaded by the runtime
%% smoke. Erlang cannot compile modules on Kandelo yet — beam_asm hashes
%% each module with erlang:md5/1 over an iolist, and erlang:md5/1 returns
%% badarg on iolist input in the current wasm build (works only on a
%% binary), so `erlc ring.erl` / compile:file/1 crash on-platform. Tracked
%% as kd-qe2c. The runtime smoke (test/erlang.test.ts) exercises the same
%% spawn/message-passing behaviour via a self-contained -eval program that
%% needs no compilation.
%%
%% Usage (requires a host-precompiled ring.beam on the -pa code path):
%%   erlc ring.erl   %% on a host with matching OTP 28
%%   npx tsx packages/registry/erlang/demo/serve.ts -eval "ring:start()."

-module(ring).
-export([run/2, start/0]).

%% Entry point for -eval "ring:start()"
start() ->
    N = 1000,
    M = 100,
    io:format("Ring benchmark: ~p processes, ~p rounds~n", [N, M]),
    T1 = erlang:monotonic_time(microsecond),
    run(N, M),
    T2 = erlang:monotonic_time(microsecond),
    Elapsed = T2 - T1,
    Secs = erlang:float_to_list(Elapsed / 1.0e6, [{decimals, 3}]),
    io:format("Completed in ~s seconds (~p us)~n", [Secs, Elapsed]),
    io:format("Total messages: ~p~n", [N * M]),
    erlang:halt(0, [{flush, false}]).

%% Spawn N processes in a ring, send a token around M times.
%% Ring topology: self -> Last -> ... -> proc2 -> self
%% Self acts as the counter, sending tokens and waiting for them
%% to come back around the ring.
run(N, M) ->
    First = self(),
    Last = lists:foldl(
        fun(_, Next) ->
            spawn(fun() -> forwarder(Next) end)
        end,
        First,
        lists:seq(2, N)
    ),
    %% Send M tokens around the ring, each traverses N processes
    counter_loop(Last, M).

counter_loop(_, 0) -> ok;
counter_loop(Next, M) ->
    Next ! token,
    receive token -> ok end,
    counter_loop(Next, M - 1).

forwarder(Next) ->
    receive
        token ->
            Next ! token,
            forwarder(Next);
        stop ->
            ok
    end.
