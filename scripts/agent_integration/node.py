"""Read canonical Node family identifiers without changing compatibility state."""
import json


def validate(adapter, root, require):
    state = json.loads((root / adapter["state"]["path"]).read_text())
    families = state.get("families")
    require(isinstance(families, dict) and families, "canonical Node families missing")
    for family in adapter["families"]:
        require(family in families, f"unknown Node family: {family}")
