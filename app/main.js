// Pico's School on webOS. Plain ES2017 on purpose: the TV's engine is Chromium 79.
(function () {
  'use strict';
  var TICK = 1 / 24, RATE = 44100;
  // webOS gives a 720p, 1080p or (on 8K sets) 4K surface. Render close to the
  // real pixel count, in stage multiples: 1x is 550x350, 2x is 1100x700, 3x
  // 1650x1050. The cap keeps a 4K panel from asking the TV's CPU for 3x.
  // ?scale=N overrides it for testing.
  var forced = /[?&]scale=([0-9.]+)/.exec(location.search);
  var device = Math.min(innerWidth / 550, innerHeight / 350) * (window.devicePixelRatio || 1);
  var scale = forced ? +forced[1] : Math.max(1, Math.min(2, Math.floor(device * 2) / 2));
  var W = Math.round(550 * scale), H = Math.round(350 * scale);
  // The 2x pack is drawn from higher-resolution sources, so use it above 1x.
  var ART = scale > 1 ? 'assets/pico_art_rgba_2x.pcta' : 'assets/pico_art_rgba.pcta';
  var SOUND = 'assets/pico_sound_adpcm.pcts';

  var canvas = document.getElementById('screen'), status = document.getElementById('status');
  var ctx = canvas.getContext('2d', { alpha: false });
  var M, image, audio = null, running = false, paused = false;
  var next = 0, dirty = true, down = 0;

  function load(url) {
    return new Promise(function (resolve, reject) {
      // XHR rather than fetch: fetch() refuses file:// URLs in the TV's runtime.
      var x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = 'arraybuffer';
      x.onload = function () { x.response && (x.status === 200 || x.status === 0) ? resolve(x.response) : reject(new Error(url)); };
      x.onerror = function () { reject(new Error(url)); };
      x.send();
    });
  }
  function copyIn(buffer) {
    var ptr = M._malloc(buffer.byteLength);
    M.HEAPU8.set(new Uint8Array(buffer), ptr);
    return ptr;
  }

  function fit() {
    var scale = Math.min(innerWidth / W, innerHeight / H);
    canvas.style.width = Math.round(W * scale) + 'px';
    canvas.style.height = Math.round(H * scale) + 'px';
  }

  function stagePoint(e) {
    var r = canvas.getBoundingClientRect();
    var x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (x < 0 || y < 0 || x >= 1 || y >= 1) return null;
    return [x * 550, y * 350];
  }
  function pointer(e, state) {
    var p = stagePoint(e);
    if (state !== undefined) down = state;
    if (p) M._web_pointer(p[0], p[1], down); else M._web_pointer(-1, -1, down);
    M._web_assist(0);
    dirty = true;
  }

  function startAudio() {
    if (audio || !window.AudioContext) return;
    try {
      audio = new AudioContext({ sampleRate: RATE });
    } catch (err) {
      audio = new AudioContext();
    }
    // ScriptProcessor, not AudioWorklet: the worklet needs a secure context.
    var node = audio.createScriptProcessor(2048, 0, 2);
    node.onaudioprocess = function (e) {
      var left = e.outputBuffer.getChannelData(0), right = e.outputBuffer.getChannelData(1);
      var n = left.length, i;
      if (paused) { left.fill(0); right.fill(0); return; }
      var ptr = M._web_audio(n) >> 1, pcm = M.HEAP16;
      for (i = 0; i < n; i++) {
        left[i] = pcm[ptr + i * 2] / 32768;
        right[i] = pcm[ptr + i * 2 + 1] / 32768;
      }
    };
    node.connect(audio.destination);
  }
  function resumeAudio() {
    startAudio();
    if (audio && audio.state === 'suspended') audio.resume();
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (paused) return;
    var t = now / 1000, ticks = 0;
    if (!next) next = t;
    // Never drop game time, but cap catch-up so a stall can't freeze drawing.
    while (t >= next && ticks < 8) {
      M._web_tick();
      next += TICK;
      ticks++;
      dirty = true;
    }
    if (t - next > 1) next = t;
    if (!dirty) return;
    dirty = false;
    var ptr = M._web_render();
    if (!ptr) return;
    image.data.set(M.HEAPU8.subarray(ptr, ptr + W * H * 4));
    ctx.putImageData(image, 0, 0);
  }

  function key(e) {
    resumeAudio();
    switch (e.keyCode) {
      case 37: case 38: M._web_select(-1); break;
      case 39: case 40: case 9: M._web_select(1); break;
      case 13: M._web_activate(); break;
      case 461: case 27: window.close(); break; // Back leaves the game
      default: return;
    }
    e.preventDefault();
    dirty = true;
  }

  document.addEventListener('keydown', key);
  canvas.addEventListener('mousemove', function (e) { pointer(e); });
  canvas.addEventListener('mousedown', function (e) { resumeAudio(); pointer(e, 1); });
  window.addEventListener('mouseup', function (e) { pointer(e, 0); });
  canvas.addEventListener('mouseleave', function () { M._web_pointer(-1, -1, 0); down = 0; dirty = true; });
  document.addEventListener('visibilitychange', function () {
    paused = document.hidden;
    next = 0;
    if (audio) paused ? audio.suspend() : audio.resume();
  });
  addEventListener('resize', fit);

  Promise.all([PicoModule(), load(ART), load(SOUND).catch(function () { return null; })])
    .then(function (r) {
      M = r[0];
      var art = copyIn(r[1]), snd = r[2] ? copyIn(r[2]) : 0;
      var ok = M._web_open(art, r[1].byteLength, snd, r[2] ? r[2].byteLength : 0, W, H, RATE);
      if (!ok) throw new Error('The game data did not load.');
      canvas.width = W;
      canvas.height = H;
      image = ctx.createImageData(W, H);
      fit();
      status.style.display = 'none';
      running = true;
      startAudio();
      requestAnimationFrame(frame);
    })
    .catch(function (err) { status.textContent = String(err && err.message || err); });
})();
