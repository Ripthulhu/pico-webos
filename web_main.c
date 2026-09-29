/* Web host for the webOS port. The game, hit testing and sound stay in C; the
 * picture is drawn by the GPU. Each frame this hands the page the display list
 * (which artwork, where, with what tint) and decodes any artwork the page
 * hasn't turned into a texture yet. Rasterising on the CPU cost the TV 71 ms a
 * picture at 2x, almost all of it decoding and compositing pixels. */
#include "host_common.h"
#include "pico_audio.h"
#include "touch_input.h"
#include <emscripten/emscripten.h>
#include <stdlib.h>
#include <string.h>

/* pico_render.c keeps its row decoder and asset lookup static. Including it
 * here, instead of compiling it on its own, lets the leaf decoder below reuse
 * them rather than copy the pack format. */
#include "pico_render.c"

static HostApp app;
static PicoAudio mixer;
static int have_audio;
enum { AUDIO_FRAMES = 2048 };
static int16_t audio_out[AUDIO_FRAMES * 2];

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

/* Both packs are malloc'd by JS and stay alive for the whole session. The
 * host's own framebuffer is never drawn to, so it's opened at the stage size. */
EMSCRIPTEN_KEEPALIVE int web_open(const void *art, size_t art_size, const void *sound,
                                  size_t sound_size, unsigned rate) {
    HostSoundSink sink = {NULL, sound_event, sound_stop};
    have_audio = sound && pico_audio_init(&mixer, sound, sound_size, rate, 2);
    if (!host_open_memory(&app, art, art_size, 550, 350, 0, 0, &sink))
        return 0;
    if (app.assets.version != 3) {
        host_close(&app);
        return 0;
    }
    return have_audio ? 2 : 1;
}

EMSCRIPTEN_KEEPALIVE void web_tick(void) { host_tick(&app); }

/* The display list, back to front, as 19 floats a leaf: record index, leaf
 * rectangle in local stage pixels (x0, y0, x1, y1), matrix a b c d tx ty in
 * stage pixels, RGBA colour multiply as a fraction, RGBA colour add out of 255. */
#define FIELDS 19
static float list[PICO_HOST_MAX_DRAWS * FIELDS];

EMSCRIPTEN_KEEPALIVE unsigned web_frame(void) {
    const uint8_t *base = app.assets.data + app.assets.records_offset;
    double k = (double)app.assets.scale_den / app.assets.scale_num;
    unsigned i, n = 0;
    app.draw_count = 0;
    pico_render(&app.game);
    for (i = 0; i < app.draw_count; i++) {
        const PicoDraw *d = &app.draws[i];
        const uint8_t *r = find_asset(&app.assets, d->symbol, d->ratio);
        float *f = list + n * FIELDS;
        int j;
        if (!r)
            continue;
        f[0] = (float)((r - base) / 24);
        f[1] = (float)(s16(r + 4) * k);
        f[2] = (float)(s16(r + 6) * k);
        f[3] = (float)((s16(r + 4) + u16(r + 8)) * k);
        f[4] = (float)((s16(r + 6) + u16(r + 10)) * k);
        f[5] = d->a / 65536.0f;
        f[6] = d->b / 65536.0f;
        f[7] = d->c / 65536.0f;
        f[8] = d->d / 65536.0f;
        f[9] = d->tx / 65536.0f;
        f[10] = d->ty / 65536.0f;
        for (j = 0; j < 4; j++) {
            f[11 + j] = d->multiply[j] / 256.0f;
            f[15 + j] = d->add[j] / 255.0f;
        }
        n++;
    }
    return n;
}
EMSCRIPTEN_KEEPALIVE float *web_list(void) { return list; }

/* Decodes record index into premultiplied RGBA for a texture upload. Returns
 * the pixels, with the size at web_leaf_size. Straight alpha from the pack is
 * premultiplied so linear filtering doesn't fringe transparent edges. */
static uint8_t *leaf;
static size_t leaf_capacity;
static unsigned leaf_size[2];
EMSCRIPTEN_KEEPALIVE uint8_t *web_leaf(unsigned index) {
    const uint8_t *r, *p = app.assets.data;
    static uint8_t scratch[PICO_RGBA_MAX_SOURCE_WIDTH * 4];
    unsigned w, h, x, y;
    uint32_t rows;
    size_t bytes;
    if (index >= app.assets.count)
        return NULL;
    r = record(&app.assets, index);
    w = u16(r + 8);
    h = u16(r + 10);
    rows = u32(r + 12);
    bytes = (size_t)w * h * 4;
    if (bytes > leaf_capacity) {
        free(leaf);
        leaf = (uint8_t *)malloc(bytes);
        leaf_capacity = leaf ? bytes : 0;
        if (!leaf)
            return NULL;
    }
    for (y = 0; y < h; y++) {
        uint32_t start = u32(p + rows + 4 * y);
        uint8_t *out = leaf + (size_t)y * w * 4;
        int mode = decode_row(p + start, u32(p + rows + 4 * (y + 1)) - start, w, scratch);
        if (!mode)
            return NULL;
        for (x = 0; x < w; x++) {
            unsigned a = mode == 1 ? scratch[x * 4 + 3] : scratch[w * 3 + x];
            unsigned rr = mode == 1 ? scratch[x * 4] : scratch[x];
            unsigned g = mode == 1 ? scratch[x * 4 + 1] : scratch[w + x];
            unsigned b = mode == 1 ? scratch[x * 4 + 2] : scratch[w * 2 + x];
            out[x * 4] = (uint8_t)((rr * a + 127) / 255);
            out[x * 4 + 1] = (uint8_t)((g * a + 127) / 255);
            out[x * 4 + 2] = (uint8_t)((b * a + 127) / 255);
            out[x * 4 + 3] = (uint8_t)a;
        }
    }
    leaf_size[0] = w;
    leaf_size[1] = h;
    return leaf;
}
EMSCRIPTEN_KEEPALIVE unsigned *web_leaf_size(void) { return leaf_size; }

/* Stage pixels, already mapped by JS. The remote gets a 14-pixel click margin. */
EMSCRIPTEN_KEEPALIVE void web_pointer(double x, double y, int down) {
    if (!(x >= 0 && x < 550 && y >= 0 && y < 350))
        x = y = -1;
    host_touch_pointer(&app.game, (int32_t)(x * 65536.0), (int32_t)(y * 65536.0), down,
                       14 * 65536);
}

/* Interleaved stereo PCM16, matching the page's 2048-frame audio callback. */
EMSCRIPTEN_KEEPALIVE int16_t *web_audio(void) {
    if (have_audio)
        pico_audio_render(&mixer, audio_out, AUDIO_FRAMES);
    else
        memset(audio_out, 0, sizeof(audio_out));
    return audio_out;
}
