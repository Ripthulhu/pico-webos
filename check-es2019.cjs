// Fails the build if a file uses syntax newer than Chromium 79 parses.
// Chromium 79 covers ES2019; optional chaining, ?? and class fields came later.
const fs = require('fs');
const path = require('path');
const acorn = require(process.env.ACORN || path.join(process.env.EMSDK || '', 'upstream/emscripten/node_modules/acorn'));
let failed = false;
for (const file of process.argv.slice(2)) {
  try {
    acorn.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 2019, sourceType: 'script' });
    console.log('ES2019 ok: ' + path.basename(file));
  } catch (err) {
    console.error(path.basename(file) + ': ' + err.message);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
