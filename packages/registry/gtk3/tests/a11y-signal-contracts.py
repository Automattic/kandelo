#!/usr/bin/env python3
"""Audit GTK accessibility signal handlers and emit a Wasm call-type control.

GLib's C marshallers call a connected handler as
`handler (instance, signal params..., user_data)` and use the signal's return
type. WebAssembly's `call_indirect` checks that exact machine signature, so a
handler that omits `user_data` (or returns `gint` for a void signal) traps with
"function signature mismatch" instead of ignoring the extra argument as native
C ABIs do.

This script reads the pinned GTK source after and before
`wasm-a11y-signal-contracts.patch`. It:

1. requires every literal `gtk/a11y` registration to appear in the reviewed
   INVENTORY below (new or changed registrations fail loudly);
2. derives each signal's parameter count and return kind from the actual
   `g_signal_new`/`g_signal_newv` in the named declaring file (GObject
   `notify` and ATK `children-changed` are outside the GTK tree and listed
   explicitly);
3. requires every repaired handler definition to match that machine signature,
   and the original tree to mismatch for exactly the REPAIRED set; and
4. writes separate Wasm translation units containing the actual extracted
   handler definition headers (parameter lists and return types unchanged,
   bodies replaced by an argument recorder), plus a caller that invokes each
   handler through the signal's connected-handler machine type, as GLib's
   marshallers do.

The recorder bodies are explicit test doubles: this proves the call-type
contract only. It does not run GTK, ATK or GObject, and is not a substitute
for rebuilt GTK consumers in a real compositor session.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

# (a11y source, signal as registered, handler, declaring source or external)
INVENTORY = [
    ("gtkaccessibility.c", "map", "gail_map_cb", "gtk/gtkwidget.c"),
    ("gtkaccessibility.c", "map", "gail_map_submenu_cb", "gtk/gtkwidget.c"),
    ("gtkaccessibility.c", "focus-in-event", "window_focus", "gtk/gtkwidget.c"),
    ("gtkaccessibility.c", "focus-out-event", "window_focus", "gtk/gtkwidget.c"),
    ("gtkaccessibility.c", "children-changed::add", "window_added", "atk"),
    ("gtkaccessibility.c", "children-changed::remove", "window_removed", "atk"),
    ("gtkcheckmenuitemaccessible.c", "toggled", "toggled_cb", "gtk/gtkcheckmenuitem.c"),
    ("gtkcolorswatchaccessible.c", "state-flags-changed", "state_changed_cb_signal_cb", "gtk/gtkwidget.c"),
    ("gtkcomboboxaccessible.c", "changed", "changed_cb", "gtk/gtkcombobox.c"),
    ("gtkentryaccessible.c", "insert-text", "insert_text_cb", "gtk/gtkeditable.c"),
    ("gtkentryaccessible.c", "delete-text", "delete_text_cb", "gtk/gtkeditable.c"),
    ("gtkiconviewaccessible.c", "row-changed", "gtk_icon_view_accessible_model_row_changed", "gtk/gtktreemodel.c"),
    ("gtkiconviewaccessible.c", "row-inserted", "gtk_icon_view_accessible_model_row_inserted", "gtk/gtktreemodel.c"),
    ("gtkiconviewaccessible.c", "row-deleted", "gtk_icon_view_accessible_model_row_deleted", "gtk/gtktreemodel.c"),
    ("gtkiconviewaccessible.c", "rows-reordered", "gtk_icon_view_accessible_model_rows_reordered", "gtk/gtktreemodel.c"),
    ("gtkiconviewaccessible.c", "notify", "gtk_icon_view_accessible_notify_gtk_notify_cb", "gobject"),
    ("gtklinkbuttonaccessible.c", "activate-link", "activate_link", "gtk/gtklinkbutton.c"),
    ("gtkmenuitemaccessible.c", "select", "menu_item_select", "gtk/gtkmenuitem.c"),
    ("gtkmenuitemaccessible.c", "deselect", "menu_item_deselect", "gtk/gtkmenuitem.c"),
    ("gtkmenuitemaccessible.c", "insert", "menu_item_insert_gtk", "gtk/gtkmenushell.c"),
    ("gtkmenuitemaccessible.c", "remove", "menu_item_remove_gtk", "gtk/gtkcontainer.c"),
    ("gtknotebookaccessible.c", "page-added", "page_added_cb", "gtk/gtknotebook.c"),
    ("gtknotebookaccessible.c", "page-removed", "page_removed_cb", "gtk/gtknotebook.c"),
    ("gtknotebookpageaccessible.c", "child-notify::tab-label", "notify_tab_label", "gtk/gtkwidget.c"),
    ("gtkpanedaccessible.c", "size-allocate", "gtk_paned_accessible_size_allocate_gtk_signal_cb", "gtk/gtkwidget.c"),
    ("gtkpopoveraccessible.c", "notify", "popover_notify_cb", "gobject"),
    ("gtkrangeaccessible.c", "value-changed", "gtk_range_accessible_value_changed", "gtk/gtkadjustment.c"),
    ("gtkscalebuttonaccessible.c", "value-changed", "gtk_scale_button_accessible_value_changed", "gtk/gtkadjustment.c"),
    ("gtkscalebuttonaccessible.c", "value-changed", "gtk_scale_button_accessible_value_changed", "gtk/gtkadjustment.c"),
    ("gtkscrolledwindowaccessible.c", "notify::visible", "visibility_changed", "gobject"),
    ("gtkscrolledwindowaccessible.c", "notify::visible", "visibility_changed", "gobject"),
    ("gtkspinbuttonaccessible.c", "value-changed", "gtk_spin_button_accessible_value_changed", "gtk/gtkadjustment.c"),
    ("gtkstatusbaraccessible.c", "text-pushed", "text_changed", "gtk/gtkstatusbar.c"),
    ("gtkstatusbaraccessible.c", "text-popped", "text_changed", "gtk/gtkstatusbar.c"),
    ("gtktextviewaccessible.c", "insert-text", "insert_text_cb", "gtk/gtktextbuffer.c"),
    ("gtktextviewaccessible.c", "delete-range", "delete_range_cb", "gtk/gtktextbuffer.c"),
    ("gtktextviewaccessible.c", "delete-range", "delete_range_after_cb", "gtk/gtktextbuffer.c"),
    ("gtktextviewaccessible.c", "mark-set", "mark_set_cb", "gtk/gtktextbuffer.c"),
    ("gtktogglebuttonaccessible.c", "toggled", "gtk_toggle_button_accessible_toggled", "gtk/gtktogglebutton.c"),
    ("gtktoplevelaccessible.c", "destroy", "remove_child", "gtk/gtkwidget.c"),
    ("gtktoplevelaccessible.c", "destroy", "remove_child", "gtk/gtkwidget.c"),
    ("gtkwidgetaccessible.c", "focus-in-event", "focus_cb", "gtk/gtkwidget.c"),
    ("gtkwidgetaccessible.c", "focus-out-event", "focus_cb", "gtk/gtkwidget.c"),
    ("gtkwidgetaccessible.c", "notify", "notify_cb", "gobject"),
    ("gtkwidgetaccessible.c", "size-allocate", "size_allocate_cb", "gtk/gtkwidget.c"),
    ("gtkwidgetaccessible.c", "map", "map_cb", "gtk/gtkwidget.c"),
    ("gtkwidgetaccessible.c", "unmap", "map_cb", "gtk/gtkwidget.c"),
    ("gtkwindowaccessible.c", "window-state-event", "window_state_event_cb", "gtk/gtkwidget.c"),
]

# Handlers whose original pinned definitions omit closure data and/or return
# a value from a void signal. Everything else already matches.
REPAIRED = [
    ("gtkcheckmenuitemaccessible.c", "toggled_cb"),
    ("gtkcomboboxaccessible.c", "changed_cb"),
    ("gtkentryaccessible.c", "insert_text_cb"),
    ("gtkentryaccessible.c", "delete_text_cb"),
    ("gtkmenuitemaccessible.c", "menu_item_select"),
    ("gtkmenuitemaccessible.c", "menu_item_deselect"),
    ("gtkmenuitemaccessible.c", "menu_item_insert_gtk"),
    ("gtkmenuitemaccessible.c", "menu_item_remove_gtk"),
    ("gtktogglebuttonaccessible.c", "gtk_toggle_button_accessible_toggled"),
]

# Signals defined outside the GTK tree: (returns a value, parameter count).
EXTERNAL = {
    ("gobject", "notify"): (False, 1),          # GObject::notify (GParamSpec *)
    ("atk", "children-changed"): (False, 2),    # AtkObject::children-changed (guint, gpointer)
}

REGISTRATION = re.compile(
    r'g_signal_connect(?:_after|_swapped|_object)?\s*\(([^;]*?)"([^"]+)"\s*,\s*'
    r'(?:G_CALLBACK\s*\(\s*(\w+)\s*\)|\(GCallback\)\s*(\w+))', re.S)


def split_args(text):
    args, depth, current = [], 0, []
    for char in text:
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        if char == "," and depth == 0:
            args.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    args.append("".join(current).strip())
    return args


def call_body(text, start):
    """Return the argument text of the call whose '(' is at or after start."""
    open_paren = text.index("(", start)
    depth, index = 0, open_paren
    while True:
        if text[index] == "(":
            depth += 1
        elif text[index] == ")":
            depth -= 1
            if depth == 0:
                return text[open_paren + 1:index]
        index += 1


def signal_signature(root, declaring, signal):
    name = signal.split("::")[0]
    if declaring in ("gobject", "atk"):
        return EXTERNAL[(declaring, name)]
    text = (root / declaring).read_text()
    found = set()
    for match in re.finditer(r'\bg_signal_newv?\s*\(\s*(?:I_\s*\(\s*)?"' + re.escape(name) + r'"', text):
        args = split_args(call_body(text, match.start()))
        return_type = args[7].split("|")[0].strip()
        found.add((return_type != "G_TYPE_NONE", int(args[8])))
    if len(found) != 1:
        raise SystemExit(f"{declaring}: expected one definition of {name!r}, found {sorted(found)}")
    return found.pop()


def definition(text, name):
    """The actual static definition header of NAME: (return type, params, header text)."""
    matches = list(re.finditer(
        r'^static\s+([A-Za-z_][\w \t\*]*?)\s*\n' + re.escape(name) + r'\s*\(([^)]*)\)\s*\n\{', text, re.M))
    if len(matches) != 1:
        raise SystemExit(f"expected one static definition of {name}, found {len(matches)}")
    match = matches[0]
    params = [p.strip() for p in match.group(2).split(",") if p.strip() and p.strip() != "void"]
    return match.group(1).strip(), params, text[match.start():match.end() - 1].rstrip()


def registrations(root):
    found = []
    for path in sorted((root / "gtk/a11y").glob("*.c")):
        for match in REGISTRATION.finditer(path.read_text()):
            found.append((path.name, match.group(2), match.group(3) or match.group(4)))
    return found


def audit(root):
    """Return (handler -> (machine ok, definition), list of mismatches)."""
    actual = registrations(root)
    expected = [(f, s, h) for f, s, h, _ in INVENTORY]
    if sorted(actual) != sorted(expected):
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        raise SystemExit(f"{root}: a11y registrations changed; review INVENTORY\n missing={missing}\n extra={extra}")
    mismatches = []
    for source, signal, handler, declaring in INVENTORY:
        returns_value, n_params = signal_signature(root, declaring, signal)
        ret, params, _ = definition((root / "gtk/a11y" / source).read_text(), handler)
        got = (ret not in ("void",), len(params))
        want = (returns_value, n_params + 2)
        if got != want and (source, handler) not in mismatches:
            mismatches.append((source, handler))
    return sorted(mismatches)


SCALARS = """typedef int gint;
typedef unsigned int guint;
typedef int gboolean;
typedef char gchar;
typedef void *gpointer;
"""


def control_tu(root, state):
    """Actual extracted definition headers with recording bodies."""
    out = ["/* Extracted GTK a11y handler definitions (" + state + "); bodies are recorders. */",
           SCALARS, "unsigned long recorded[8];", "int recorded_count;"]
    types = set()
    headers = []
    for index, (source, handler) in enumerate(REPAIRED):
        ret, params, header = definition((root / "gtk/a11y" / source).read_text(), handler)
        types.update(re.findall(r'\b((?:Gtk|Gdk|Atk)\w+)\b', " ".join(params)))
        names = [re.search(r'(\w+)\s*$', p).group(1) for p in params]
        body = ["{"]
        body += [f"  recorded[{i}] = (unsigned long) {n};" for i, n in enumerate(names)]
        body.append(f"  recorded_count = {len(names)};")
        if ret != "void":
            body.append("  return 1;")
        body.append("}")
        headers.append(header + "\n" + "\n".join(body))
        headers.append(f"void *control_handler_{index} (void) {{ return (void *) {handler}; }}")
    out += [f"typedef struct {t} {t};" for t in sorted(types)]
    out += headers
    return "\n".join(out) + "\n"


def caller_tu(root):
    lines = [SCALARS, "extern unsigned long recorded[8];", "extern int recorded_count;"]
    lines += [f"void *control_handler_{i} (void);" for i in range(len(REPAIRED))]
    lines.append("int run_case (int which) {")
    lines.append("  recorded_count = -1;")
    lines.append("  switch (which) {")
    cases = []
    for index, (source, handler) in enumerate(REPAIRED):
        signal, declaring = next((s, d) for f, s, h, d in INVENTORY if (f, h) == (source, handler))
        returns_value, n_params = signal_signature(root, declaring, signal)
        assert not returns_value, "repaired handlers here are all void signals"
        arity = n_params + 2
        # Connected-handler machine type: instance, params..., user_data.
        params = ", ".join(["gpointer"] * arity)
        args = ", ".join(f"(gpointer) 0x{0x1000 + index * 16 + i:x}" for i in range(arity))
        lines.append(f"    case {index}: ((void (*) ({params})) control_handler_{index} ()) ({args}); break;")
        cases.append({"source": source, "handler": handler, "signal": signal,
                      "declaring": declaring, "arity": arity})
    lines.append("    default: return -1;")
    lines.append("  }")
    lines.append("  return recorded_count;")
    lines.append("}")
    lines.append("unsigned long recorded_arg (int i) { return recorded[i]; }")
    return "\n".join(lines) + "\n", cases


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("patched", type=Path, help="pinned GTK source after all recipe patches")
    parser.add_argument("before", type=Path, help="pinned GTK source before wasm-a11y-signal-contracts.patch")
    parser.add_argument("work", type=Path)
    options = parser.parse_args()
    options.work.mkdir(parents=True, exist_ok=True)

    after_mismatches = audit(options.patched)
    if after_mismatches:
        raise SystemExit(f"repaired tree still mismatches: {after_mismatches}")
    before_mismatches = audit(options.before)
    if before_mismatches != sorted(REPAIRED):
        raise SystemExit(f"original mismatches differ from REPAIRED: {before_mismatches}")
    print(f"a11y audit: {len(INVENTORY)} registrations; original mismatches "
          f"{len(before_mismatches)}; repaired mismatches 0")

    for state, root in (("before", options.before), ("after", options.patched)):
        (options.work / f"{state}.c").write_text(control_tu(root, state))
    caller, cases = caller_tu(options.patched)
    (options.work / "invoke.c").write_text(caller)
    sources = sorted({source for source, _ in REPAIRED})
    (options.work / "inventory.json").write_text(json.dumps({
        "cases": cases,
        "sourceSha256": {
            state: {s: hashlib.sha256((root / "gtk/a11y" / s).read_bytes()).hexdigest() for s in sources}
            for state, root in (("before", options.before), ("after", options.patched))
        },
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
