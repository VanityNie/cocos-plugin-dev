'use strict';

const processes = require('../../../lib/processes.cjs');

processes.startUnlocked(process.argv[2], process.execPath, { args: [process.argv[3], process.argv[4]] })
    .then(result => process.stdout.write(JSON.stringify(result)))
    .catch(error => { console.error(error); process.exitCode = 1; });
