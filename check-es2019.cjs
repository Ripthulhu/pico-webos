// Fails the build if a file uses syntax newer than Chromium 79 parses, or
// BigInt. Chromium 79 covers ES2019; optional chaining, ?? and class fields
// came later, and wasm-to-JS BigInt arrived in 85.
const fs = require('fs');
const path = require('path');
const acorn = require(process.env.ACORN || path.join(process.env.EMSDK || '', 'upstream/emscripten/node_modules/acorn'));
let failed = false;
for (const file of process.argv.slice(2)) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    acorn.parse(source, { ecmaVersion: 2019, sourceType: 'script' });
    // BigInt means wasm passes 64-bit values to JS, which needs Chromium 85.
    if (/\bBigInt\b/.test(source)) throw new Error('uses BigInt; build with -sWASM_BIGINT=0');
    console.log('ES2019 ok: ' + path.basename(file));
  } catch (err) {
    console.error(path.basename(file) + ': ' + err.message);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
