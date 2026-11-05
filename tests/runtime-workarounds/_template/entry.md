# ENGINE-SHORT-DESCRIPTION

Status: suspected. (Keep this line in step with `entry.toml`; say
"suspected" anywhere the defect is not yet confirmed.)

## Defect

What the runtime does wrong, in plain words, and which specification or
documented behavior it contradicts (or, for a gap, which feature is
missing).

## Why Kandelo is affected

Which Kandelo behavior meets the defect, and what a user sees when it does.

## Workaround and its cost

What the code does instead, where (the tagged sites), and what it costs:
time, memory, complexity, or behavior given up.

## Evidence

Measurements, stack samples, crash reports, and every reproduction attempt
with its result, including the attempts that failed. Name the runtime
builds (for example Playwright `webkit-2359`, reported as `26.6`).

## Why this is not a Kandelo defect

How the standalone reproduction excludes Kandelo. For a suspected entry:
what is still unknown, and what result would show the fault is Kandelo's.

## Draft upstream report

Not filed. Title, product and component, summary, steps to reproduce (the
`repro/` directory is the attachment), expected and actual results, the
versions it reproduces on.

## Removal criteria

What has to be true before the workaround goes (which released runtime
versions must no longer reproduce), and what to delete or revert.
