// Fixture: a script repro that outlives its timeout without a verdict.
setTimeout(() => {}, 60_000);
