#!/bin/sh
# Builds the webOS app into build/app and packs an IPK into build/.
# Needs Emscripten on PATH (emsdk_env) and ares-package, plus the pico-c
# submodule (git submodule update --init).
set -e
here=$(cd "$(dirname "$0")" && pwd)
root="$here/pico-c"
out="$here/build/app"
rm -rf "$here/build"
mkdir -p "$out/assets"

# web_main.c includes src/pico_render.c itself, so it isn't listed here.
# MIN_CHROME_VERSION=79 keeps the wasm features and JS syntax the TV's engine
# understands. WASM_BIGINT=0 has to be said outright though: Emscripten 4
# leaves BigInt integration on, and Chromium only gained it in version 85.
emcc -O3 -std=c99 -DPICO_RENDER_MAX_WIDTH=3840 \
  -I"$root/include" -I"$root/generated" -I"$root/platform" -I"$root/src" \
  "$root"/src/pico.c "$root"/src/pico_audio.c "$root"/src/pico_ui.c \
  "$root/generated/game_data.c" "$root/platform/host_common.c" "$here/web_main.c" \
  -sMIN_CHROME_VERSION=79 -sWASM_BIGINT=0 -sENVIRONMENT=web -sMODULARIZE=1 -sEXPORT_NAME=PicoModule \
  -sINITIAL_MEMORY=64MB -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1MB \
  -sEXPORTED_FUNCTIONS=_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16,HEAPU32,HEAPF32 \
  -sFILESYSTEM=0 -o "$out/pico.js"
# Emscripten's module template still emits optional chaining, which Chromium
# only parses from version 80. Rewrite it, then make sure nothing newer is left.
sed -i 's/document\.currentScript?\.src/(document.currentScript \&\& document.currentScript.src)/g' "$out/pico.js"
node "$here/check-es2019.cjs" "$out/pico.js" "$here/app/main.js"

cp "$here/app/index.html" "$here/app/main.js" "$here/app/appinfo.json" "$out/"
cp "$here/app/icon.png" "$here/app/largeIcon.png" "$out/" 2>/dev/null || true
for f in pico_art_rgba.pcta pico_art_rgba_2x.pcta pico_sound_adpcm.pcts; do
  cp "$root/assets/$f" "$out/assets/"
done
if command -v ares-package >/dev/null 2>&1; then
  ares-package --no-minify "$out" -o "$here/build"
  node "$here/make-repo.cjs"
fi
ls -l "$out" "$here/build"
