const { results } = require('./e2e.cjs');
require('./e2e-align.cjs')().then(() => console.log(results.filter(r => r.ok).length + '/' + results.length));
