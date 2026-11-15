#!/usr/bin/env node
// The narado command: see src/narado/cli.js.
require('../src/narado/cli')
  .main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`narado: ${err.message}\n`);
    process.exit(1);
  });
