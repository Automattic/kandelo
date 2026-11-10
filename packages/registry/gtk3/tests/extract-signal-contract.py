#!/usr/bin/env python3
"""Extract complete pinned GTK drag-destination helpers for a CPU ABI control.

This does not replace GTK internals: the resulting TU includes installed GTK
headers and links the actual normal GTK/GObject closure. Its caller deliberately
passes a non-widget GObject, verifies GTK's precondition diagnostics, and makes
no display/widget-lifecycle claim. See README.md for the separate non-NULL
GObject argument-delivery matrix and normal desktop acceptance obligations.
"""
import argparse
from pathlib import Path
import re


def definition(source, name):
    match = re.search(r"static void\n" + re.escape(name) + r"\s*\([^)]*\)\s*\{", source)
    if match is None:
        raise ValueError(f"missing actual GTK definition: {name}")
    brace = source.index("{", match.start())
    depth = 1
    end = brace + 1
    while depth:
        if source[end] == "{":
            depth += 1
        elif source[end] == "}":
            depth -= 1
        end += 1
    return source[match.start():end] + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="verified/patched GTK source root")
    parser.add_argument("output", type=Path)
    options = parser.parse_args()
    source = (options.source / "gtk/gtkdragdest.c").read_text()
    helpers = ["gtk_drag_dest_realized", "gtk_drag_dest_hierarchy_changed"]
    selected = []
    for signal in ["realize", "hierarchy-changed"]:
        match = re.search(r'g_signal_connect\s*\(widget,\s*"' + signal +
                          r'",\s*G_CALLBACK\s*\((\w+)\),\s*site\)', source)
        if match is None:
            raise ValueError(f"missing actual registration: {signal}")
        selected.append(match[1])
    functions = helpers + [name for name in selected if name not in helpers]
    extracted = "#include <gtk/gtk.h>\n\n" + "\n".join(definition(source, name) for name in functions)
    extracted += f"""
GCallback gtk_contract_handler(gboolean object) {{
 return object ? G_CALLBACK({selected[1]}) : G_CALLBACK({selected[0]});
}}
GCallback gtk_contract_class_handler(gboolean object) {{
 return object ? G_CALLBACK({helpers[1]}) : G_CALLBACK({helpers[0]});
}}
"""
    options.output.write_text(extracted)


if __name__ == "__main__":
    main()
