// Fixture: a script repro that judges itself.
console.log('some unrelated output first');
console.log('REPRO-VERDICT ' + JSON.stringify({ verdict: 'reproduced', details: 'fixture script says the defect is present' }));
