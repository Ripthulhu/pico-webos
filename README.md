# pico-webos

Pico's School for LG webOS TVs. It's [pico-c](https://github.com/Ripthulhu/pico-c)
compiled to WebAssembly and run as a webOS web app, and it targets Chromium 79.

## Install

Add this repository to the Homebrew Channel, under Settings, then install
Pico's School from it:

    https://raw.githubusercontent.com/Ripthulhu/pico-webos/main/repo.json


## Controls

Point and click with the Magic Remote

## Build

Needs [Emscripten](https://emscripten.org) and `ares-package` from the webOS CLI.

```sh
git clone --recursive https://github.com/Ripthulhu/pico-webos
cd pico-webos
source /path/to/emsdk/emsdk_env.sh
./build.sh
```

The IPK lands in `build/`, and `repo.json` is rewritten with its hash and size.
`node serve.cjs` serves the app on port 8790 for a look in a browser.

Pico's School was created by Tom Fulp and Newgrounds. This is an unofficial port,
and the original game, artwork and audio belong to their creators.
