%% ring.erl — Classic Erlang ring benchmark
%%
%% Spawns N processes in a ring, sends a message around M times.
%% Demonstrates Erlang's lightweight process model running on
%% a single wasm32 thread via the BEAM scheduler.
%%
%% Usage from erl:
%%   ring:run(1000, 100).   % 1000 processes, 100 rounds

-module(ring).
-export([run/2, start/0]).

%% Entry point for -eval "ring:start()"
start() ->
    N = 1000,
    M = 100,
    io:format("Ring benchmark: ~p processes, ~p rounds~n", [N, M]),
    {Time, _} = timer:tc(fun() -> run(N, M) end),
    io:format("Completed in ~.3f seconds~n", [Time / 1_000_000]),
    io:format("Total messages: ~p~n", [N * M]),
    halt(0).

%% Spawn N processes in a ring, send a message around M times
run(N, M) ->
    %% Create the ring: each process knows its successor
    First = self(),
    Last = lists:foldl(
        fun(_, Prev) ->
            spawn(fun() -> ring_node(Prev) end)
        end,
        First,
        lists:seq(2, N)
    ),
    %% Close the ring: last node sends to first
    Last ! {set_next, First},
    %% Send M tokens around the ring
    Last ! {token, M},
    %% Wait for completion
    receive
        done -> ok
    end.

ring_node(Next) ->
    receive
        {set_next, NewNext} ->
            ring_node_loop(NewNext);
        {token, _} = Msg ->
            %% Haven't received set_next yet, forward with self as next
            Next ! Msg,
            ring_node(Next)
    end.

ring_node_loop(Next) ->
    receive
        {token, 1} ->
            Next ! done;
        {token, N} ->
            Next ! {token, N - 1},
            ring_node_loop(Next);
        done ->
            Next ! done
    end.
