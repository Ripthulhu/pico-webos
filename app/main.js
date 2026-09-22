// Pico's School on webOS. Plain ES2017 on purpose: the TV's engine is Chromium 79.
(function () {
  'use strict';
  var TICK = 1 / 24, RATE = 44100, FIELDS = 19;
  // The GPU draws the picture at the screen's own resolution, so the only
  // choice is which artwork to decode. The 2x pack is drawn from sharper
  // sources; {"scale": 1} as a launch parameter, or ?scale=1, picks the 1x
  // pack to save texture memory.
  var forced = /[?&]scale=([0-9.]+)/.exec(location.search), launch = {};
  try { launch = JSON.parse(window.PalmSystem && PalmSystem.launchParams || '{}') || {}; } catch (err) {}
  if (!forced && launch.scale) forced = [0, launch.scale];
  var ART = forced && +forced[1] <= 1 ? 'assets/pico_art_rgba.pcta' : 'assets/pico_art_rgba_2x.pcta';
  var SOUND = 'assets/pico_sound_adpcm.pcts';
  // Decoded artwork stays on the GPU. Past this, the least recently drawn
  // leaves are freed and decoded again if they come back.
  var TEXTURE_BUDGET = 96 * 1024 * 1024;

  var canvas = document.getElementById('screen'), status = document.getElementById('status');
  var stats = document.getElementById('stats');
  var M, gl, draw, audio = null, running = false, paused = false;
  var next = 0, dirty = true, down = 0, frameNo = 0;
  var textures = {}, textureBytes = 0;
  var perf = { frames: 0, ticks: 0, tick: 0, list: 0, draw: 0, leaves: 0, decodes: 0, since: 0 };

  function load(url) {
    return new Promise(function (resolve, reject) {
      // XHR rather than fetch: older webOS engines refuse fetch() on file:// URLs.
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

  // Every leaf is one quad: its rectangle in local stage pixels, through its
  // matrix, into the 550x350 stage. The fragment shader applies the SWF colour
  // transform to straight colour and hands back premultiplied colour.
  var VERTEX =
    'attribute vec2 corner;uniform vec4 rect;uniform vec4 m;uniform vec2 t;varying vec2 uv;' +
    'void main(){vec2 l=mix(rect.xy,rect.zw,corner);' +
    'vec2 s=vec2(m.x*l.x+m.z*l.y+t.x,m.y*l.x+m.w*l.y+t.y);' +
    'uv=corner;gl_Position=vec4(s.x/275.-1.,1.-s.y/175.,0.,1.);}';
  var FRAGMENT =
    'precision mediump float;uniform sampler2D tex;uniform vec4 mul;uniform vec4 add;varying vec2 uv;' +
    'void main(){vec4 c=texture2D(tex,uv);vec3 rgb=c.a>0.?c.rgb/c.a:vec3(0.);' +
    'float a=clamp(c.a*mul.a+add.a,0.,1.);rgb=clamp(rgb*mul.rgb+add.rgb,0.,1.);' +
    'gl_FragColor=vec4(rgb*a,a);}';

  function setup() {
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, premultipliedAlpha: true });
    if (!gl) return false;
    function shader(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(prog, 0, 'corner');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    draw = {
      rect: gl.getUniformLocation(prog, 'rect'), m: gl.getUniformLocation(prog, 'm'),
      t: gl.getUniformLocation(prog, 't'), mul: gl.getUniformLocation(prog, 'mul'),
      add: gl.getUniformLocation(prog, 'add')
    };
    return true;
  }

  // The texture for a pack record, decoding it on first use.
  function texture(index) {
    var entry = textures[index];
    if (entry) { entry.used = frameNo; return entry.tex; }
    var ptr = M._web_leaf(index);
    if (!ptr) return null;
    var size = M._web_leaf_size() >> 2, w = M.HEAPU32[size], h = M.HEAPU32[size + 1];
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(M.HEAPU8.buffer, ptr, w * h * 4));
    textures[index] = { tex: tex, bytes: w * h * 4, used: frameNo };
    textureBytes += w * h * 4;
    perf.decodes++;
    return tex;
  }
  // Frees the least recently drawn textures, never ones drawn this frame.
  function trim() {
    if (textureBytes <= TEXTURE_BUDGET) return;
    var keys = Object.keys(textures).sort(function (a, b) { return textures[a].used - textures[b].used; });
    for (var i = 0; i < keys.length && textureBytes > TEXTURE_BUDGET; i++) {
      var e = textures[keys[i]];
      if (e.used === frameNo) break;
      gl.deleteTexture(e.tex);
      textureBytes -= e.bytes;
      delete textures[keys[i]];
    }
  }

  function render() {
    var a = performance.now(), n = M._web_frame(), base = M._web_list() >> 2, f = M.HEAPF32, i, o, tex;
    var b = performance.now();
    frameNo++;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (i = 0; i < n; i++) {
      o = base + i * FIELDS;
      tex = texture(f[o]);
      if (!tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform4f(draw.rect, f[o + 1], f[o + 2], f[o + 3], f[o + 4]);
      gl.uniform4f(draw.m, f[o + 5], f[o + 6], f[o + 7], f[o + 8]);
      gl.uniform2f(draw.t, f[o + 9], f[o + 10]);
      gl.uniform4f(draw.mul, f[o + 11], f[o + 12], f[o + 13], f[o + 14]);
      gl.uniform4f(draw.add, f[o + 15], f[o + 16], f[o + 17], f[o + 18]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    trim();
    perf.list += b - a;
    perf.draw += performance.now() - b;
    perf.leaves += n;
  }

  // The canvas is sized in real screen pixels, letterboxed to the stage, but
  // never past 1080 lines. A 4K C5 reports a pixel ratio of 2, which asked for
  // 3394x2160: four times the fill for 1100x700 artwork that has no more
  // detail to give. The TV scales the last step itself.
  function fit() {
    var k = Math.min(innerWidth / 550, innerHeight / 350);
    var w = Math.round(550 * k), h = Math.round(350 * k);
    var dpr = Math.min(window.devicePixelRatio || 1, 1080 / h);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    dirty = true;
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
    var t = now / 1000, ticks = 0, a = performance.now();
    if (!next) next = t;
    // Never drop game time, but cap catch-up so a stall can't freeze drawing.
    while (t >= next && ticks < 8) {
      M._web_tick();
      next += TICK;
      ticks++;
      dirty = true;
    }
    if (t - next > 1) next = t;
    perf.tick += performance.now() - a;
    // The picture only changes on a tick or a pointer move. Skipping a frame
    // leaves the last one on screen.
    if (dirty) {
      dirty = false;
      render();
      perf.frames++;
    }
    perf.ticks += ticks;
    if (now - perf.since >= 1000) showStats(now);
  }

  // Press 0 on the remote for timings, averaged over a second.
  function showStats(now) {
    var n = perf.frames || 1, secs = (now - perf.since) / 1000;
    if (stats.style.display === 'block')
      stats.textContent = Math.round(perf.frames / secs) + ' pictures/s  ' + Math.round(perf.ticks / secs) + ' ticks/s\n' +
        'list ' + (perf.list / n).toFixed(1) + ' ms  draw ' + (perf.draw / n).toFixed(1) + ' ms  ' +
        Math.round(perf.leaves / n) + ' leaves\n' +
        'textures ' + (textureBytes / 1048576).toFixed(0) + ' MB  decoded ' + perf.decodes + '  ' +
        canvas.width + 'x' + canvas.height;
    perf.frames = perf.ticks = perf.tick = perf.list = perf.draw = perf.leaves = perf.decodes = 0;
    perf.since = now;
  }

  // Point and click only. The Magic Remote's OK button arrives as a mouse
  // click, so arrows and OK are left alone here.
  function key(e) {
    resumeAudio();
    switch (e.keyCode) {
      case 48: case 96: stats.style.display = stats.style.display === 'block' ? 'none' : 'block'; break;
      case 461: case 27: window.close(); break; // Back leaves the game
      default: return;
    }
    e.preventDefault();
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

  // The module is handed its wasm bytes, cause Emscripten would otherwise
  // fetch() pico.wasm, and fetch() fails on the file:// URLs webOS apps load from.
  Promise.all([load('pico.wasm').then(function (wasm) { return PicoModule({ wasmBinary: wasm }); }),
    load(ART), load(SOUND).catch(function () { return null; })])
    .then(function (r) {
      M = r[0];
      var art = copyIn(r[1]), snd = r[2] ? copyIn(r[2]) : 0;
      var ok = M._web_open(art, r[1].byteLength, snd, r[2] ? r[2].byteLength : 0, RATE);
      if (!ok) throw new Error('The game data did not load.');
      if (!setup()) throw new Error('This TV has no WebGL.');
      fit();
      status.style.display = 'none';
      running = true;
      startAudio();
      requestAnimationFrame(frame);
    })
    .catch(function (err) { status.textContent = String(err && err.message || err); });
})();
