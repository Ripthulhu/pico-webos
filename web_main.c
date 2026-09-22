/* Web host for the webOS port. JS owns timing, input and audio output; this file
 * wraps the shared desktop host so the page only calls a handful of exports. */
#include "host_common.h"
#include "pico_audio.h"
#include <emscripten/emscripten.h>
#include <stdlib.h>
#include <string.h>

static HostApp app;
static PicoAudio mixer;
static int have_audio;
static uint8_t *rgba;
static int16_t *audio_out;
static size_t audio_capacity;

static void sound_event(void *user, const PicoSoundEvent *event) {
    (void)user;
    if (have_audio)
        pico_audio_event(&mixer, event);
}
static void sound_stop(void *user) {
    (void)user;
    if (have_audio)
        pico_audio_stop_all(&mixer);
}

/* Both packs are malloc'd by JS and stay alive for the whole session. */
EMSCRIPTEN_KEEPALIVE int web_open(const void *art, size_t art_size, const void *sound,
                                  size_t sound_size, unsigned width, unsigned height,
                                  unsigned rate) {
    HostSoundSink sink = {NULL, sound_event, sound_stop};
    have_audio = sound && pico_audio_init(&mixer, sound, sound_size, rate, 2);
    if (!host_open_memory(&app, art, art_size, width, height, 0, 0, &sink))
        return 0;
    rgba = (uint8_t *)malloc((size_t)width * height * 4);
    if (!rgba)
        return 0;
    host_select(&app, 0);
    return have_audio ? 2 : 1;
}

EMSCRIPTEN_KEEPALIVE void web_tick(void) { host_tick(&app); host_select(&app, 0); }

/* Renders and returns RGBA bytes for ImageData. The host writes 0x00RRGGBB. */
EMSCRIPTEN_KEEPALIVE uint8_t *web_render(void) {
    size_t i, n = (size_t)app.width * app.height;
    const uint32_t *src = (const uint32_t *)app.pixels;
    if (!host_render(&app))
        return NULL;
    for (i = 0; i < n; i++) {
        uint32_t p = src[i];
        rgba[i * 4] = (uint8_t)(p >> 16);
        rgba[i * 4 + 1] = (uint8_t)(p >> 8);
        rgba[i * 4 + 2] = (uint8_t)p;
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}

EMSCRIPTEN_KEEPALIVE unsigned web_width(void) { return app.width; }
EMSCRIPTEN_KEEPALIVE unsigned web_height(void) { return app.height; }

/* Stage pixels, already mapped by JS; a negative x means off the picture. */
EMSCRIPTEN_KEEPALIVE void web_pointer(double x, double y, int down) {
    if (x < 0)
        pico_pointer(&app.game, -65536, -65536, down);
    else
        pico_pointer(&app.game, (int32_t)(x * 65536.0), (int32_t)(y * 65536.0), down);
}

/* Remote control: step through buttons with a caption, OK presses the current one. */
EMSCRIPTEN_KEEPALIVE void web_select(int direction) {
    app.assist = 1;
    host_select(&app, direction);
}
EMSCRIPTEN_KEEPALIVE void web_activate(void) {
    app.assist = 1;
    host_activate(&app);
}
EMSCRIPTEN_KEEPALIVE void web_assist(int on) { app.assist = on != 0; }

/* Interleaved stereo PCM16 for the page's audio callback. */
EMSCRIPTEN_KEEPALIVE int16_t *web_audio(unsigned frames) {
    if (frames * 2 > audio_capacity) {
        free(audio_out);
        audio_out = (int16_t *)malloc(frames * 2 * sizeof(int16_t));
        audio_capacity = audio_out ? frames * 2 : 0;
    }
    if (!audio_out)
        return NULL;
    if (have_audio)
        pico_audio_render(&mixer, audio_out, frames);
    else
        memset(audio_out, 0, frames * 2 * sizeof(int16_t));
    return audio_out;
}
