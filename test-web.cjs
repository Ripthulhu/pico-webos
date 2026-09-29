// Run after building: node test-web.cjs. Uses the shipped browser wasm.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, file));
const createModule = vm.runInNewContext(read('build/app/pico.js') + ';PicoModule', {
  console, WebAssembly, TextDecoder, performance, window: {}, document: { currentScript: null }
});
const wasmBinary = read('build/app/pico.wasm');
function copyIn(m, bytes) {
  const ptr = m._malloc(bytes.length);
  m.HEAPU8.set(bytes, ptr);
  return ptr;
}

(async () => {
  // One valid red pixel in the old RGBA run-length format (PCTA2).
  const legacy = Buffer.alloc(69);
  legacy.write('PCTA');
  [2, 1, 1, 1].forEach((n, i) => legacy.writeUInt16LE(n, 4 + i * 2));
  legacy.writeUInt32LE(32, 12);
  legacy.writeUInt16LE(1, 32);
  legacy.writeUInt16LE(1, 40);
  legacy.writeUInt16LE(1, 42);
  [56, 64, 69, 64, 69].forEach((n, i) => legacy.writeUInt32LE(n, 44 + i * 4));
  legacy.set([1, 255, 0, 0, 255], 64);
  for (const bytes of [read('pico-c/assets/pico_art_micro.pcta'), legacy]) {
    const m = await createModule({ wasmBinary });
    assert.equal(m._web_open(copyIn(m, bytes), bytes.length, 0, 0, 44100), 0,
      'webOS must reject legacy packs');
  }
  for (const name of ['pico_art_rgba.pcta', 'pico_art_rgba_2x.pcta']) {
    const m = await createModule({ wasmBinary });
    const art = read('build/app/assets/' + name), ptr = copyIn(m, art);
    assert.equal(m._web_open(ptr, art.length, 0, 0, 44100), 1, name);
    assert(m._web_frame() > 0, 'intro display list');
    assert(m._web_leaf(m.HEAPF32[m._web_list() >> 2]), 'intro texture decode');
    const audio = m._web_audio();
    assert(audio > 0, 'fixed audio buffer needs no frame argument');
    m.HEAP16.fill(123, audio >> 1, (audio >> 1) + 4096);
    assert.equal(m._web_audio(), audio, 'audio buffer address stays fixed');
    assert(m.HEAP16.subarray(audio >> 1, (audio >> 1) + 4096).every(n => n === 0),
      'silent callback clears all 2048 stereo frames');
  }
  const m = await createModule({ wasmBinary });
  const art = read('build/app/assets/pico_art_rgba.pcta');
  const sound = read('build/app/assets/pico_sound_adpcm.pcts');
  assert.equal(m._web_open(copyIn(m, art), art.length, copyIn(m, sound), sound.length, 44100), 2);
  m._web_pointer(275, 259, 1); // Play at the centre of the original menu button.
  m._web_pointer(275, 259, 0);
  let audible = false;
  for (let tick = 0; tick < 96; tick++) {
    m._web_tick();
    const at = m._web_audio() >> 1;
    audible = m.HEAP16.subarray(at, at + 4096).some(n => n !== 0) || audible;
  }
  assert(audible, 'intro produces PCM from the bundled sound bank');
  console.log('web wasm: legacy rejection, both art packs, intro sound and fixed audio buffer passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
