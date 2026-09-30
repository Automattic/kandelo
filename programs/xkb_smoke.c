/*
 * xkb_smoke — PR4 proof that the wasm32 libxkbcommon port
 * (packages/registry/libxkbcommon) compiles a keymap and translates
 * keyboard input against the kernel's libc, with nothing mocked.
 *
 * The Wayland compositor (PR6) hands each client a keymap *string* over
 * the wl_keyboard keymap fd; the client compiles it with
 * xkb_keymap_new_from_string and drives an xkb_state to turn keycodes +
 * modifiers into keysyms and UTF-8. This exercises exactly that path on a
 * self-contained two-level keymap (no xkeyboard-config data on disk):
 *
 *   [COMPILE] xkb_keymap_new_from_string parses a full TEXT_V1 keymap
 *             (keycodes + types + compat + symbols) — the xkbcomp scanner,
 *             bison parser, and AST builder all run.
 *   [BASE]    AC01 with no modifiers -> XKB_KEY_a -> "a".
 *   [SHIFT]   after pressing Left Shift, AC01 -> XKB_KEY_A -> "A", proving
 *             modifier interpretation + level selection work.
 *   [KEYSYM]  xkb_keysym_to_utf8 / from_name round-trip a non-ASCII sym.
 *
 * Prints one line per checkpoint and "XKB_SMOKE_OK" on success; exits
 * non-zero on any failure. host/test/libxkbcommon-smoke.test.ts asserts
 * the markers.
 */
#include <stdio.h>
#include <string.h>
#include <xkbcommon/xkbcommon.h>

/* Self-contained keymap: one letter key (AC01) with a Shift level, plus
 * the Left Shift key wired as the Shift modifier. Keycodes are evdev+8
 * (AC01 = 30+8 = 38, LFSH = 42+8 = 50). */
static const char KEYMAP[] =
    "xkb_keymap {\n"
    "  xkb_keycodes \"smoke\" {\n"
    "    minimum = 8;\n"
    "    maximum = 255;\n"
    "    <LFSH> = 50;\n"
    "    <AC01> = 38;\n"
    "  };\n"
    "  xkb_types \"smoke\" {\n"
    "    virtual_modifiers NumLock;\n"
    "    type \"ONE_LEVEL\" {\n"
    "      modifiers = none;\n"
    "      level_name[Level1] = \"Any\";\n"
    "    };\n"
    "    type \"TWO_LEVEL\" {\n"
    "      modifiers = Shift;\n"
    "      map[Shift] = Level2;\n"
    "      level_name[Level1] = \"Base\";\n"
    "      level_name[Level2] = \"Shift\";\n"
    "    };\n"
    "  };\n"
    "  xkb_compat \"smoke\" {\n"
    "    interpret Shift_L+AnyOfOrNone(all) {\n"
    "      action = SetMods(modifiers=Shift);\n"
    "    };\n"
    "  };\n"
    "  xkb_symbols \"smoke\" {\n"
    "    key <LFSH> { [ Shift_L ] };\n"
    "    key <AC01> { type=\"TWO_LEVEL\", [ a, A ] };\n"
    "    modifier_map Shift { <LFSH> };\n"
    "  };\n"
    "};\n";

enum { KC_LFSH = 50, KC_AC01 = 38 };

/* Resolve the one keysym bound to a key at the state's current level, then
 * render it to UTF-8. Returns the keysym; writes UTF-8 into buf. */
static xkb_keysym_t key_utf8(struct xkb_state *state, xkb_keycode_t kc,
                             char *buf, size_t len) {
    const xkb_keysym_t *syms;
    int n = xkb_state_key_get_syms(state, kc, &syms);
    buf[0] = '\0';
    if (n != 1)
        return XKB_KEY_NoSymbol;
    xkb_keysym_to_utf8(syms[0], buf, len);
    return syms[0];
}

int main(void) {
    struct xkb_context *ctx = xkb_context_new(XKB_CONTEXT_NO_DEFAULT_INCLUDES);
    if (!ctx) {
        fprintf(stderr, "xkb_context_new failed\n");
        return 1;
    }

    struct xkb_keymap *keymap = xkb_keymap_new_from_string(
        ctx, KEYMAP, XKB_KEYMAP_FORMAT_TEXT_V1, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!keymap) {
        fprintf(stderr, "xkb_keymap_new_from_string failed\n");
        return 1;
    }
    printf("COMPILE ok\n");

    struct xkb_state *state = xkb_state_new(keymap);
    if (!state) {
        fprintf(stderr, "xkb_state_new failed\n");
        return 1;
    }

    char buf[16];
    xkb_keysym_t sym = key_utf8(state, KC_AC01, buf, sizeof(buf));
    if (sym != XKB_KEY_a || strcmp(buf, "a") != 0) {
        fprintf(stderr, "base: got sym=%#x utf8=\"%s\", want a/\"a\"\n", sym, buf);
        return 1;
    }
    printf("BASE ok sym=%#x utf8=%s\n", sym, buf);

    /* Press Left Shift, then re-read AC01: it must select level 2. */
    xkb_state_update_key(state, KC_LFSH, XKB_KEY_DOWN);
    sym = key_utf8(state, KC_AC01, buf, sizeof(buf));
    if (sym != XKB_KEY_A || strcmp(buf, "A") != 0) {
        fprintf(stderr, "shift: got sym=%#x utf8=\"%s\", want A/\"A\"\n", sym, buf);
        return 1;
    }
    printf("SHIFT ok sym=%#x utf8=%s\n", sym, buf);
    xkb_state_update_key(state, KC_LFSH, XKB_KEY_UP);

    /* Keysym API round-trip on a non-ASCII symbol (independent of any
     * keymap): name -> keysym -> UTF-8. */
    xkb_keysym_t euro = xkb_keysym_from_name("EuroSign", XKB_KEYSYM_NO_FLAGS);
    xkb_keysym_to_utf8(euro, buf, sizeof(buf));
    if (euro == XKB_KEY_NoSymbol || strcmp(buf, "\xe2\x82\xac") != 0) {
        fprintf(stderr, "keysym: EuroSign -> %#x utf8=\"%s\"\n", euro, buf);
        return 1;
    }
    printf("KEYSYM ok EuroSign=%#x utf8=%s\n", euro, buf);

    xkb_state_unref(state);
    xkb_keymap_unref(keymap);
    xkb_context_unref(ctx);
    printf("XKB_SMOKE_OK\n");
    return 0;
}
