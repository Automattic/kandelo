"""A deliberately small validator for the checked-in version 1 JSON Schema."""
import hashlib
import json
from pathlib import Path
import re


class Invalid(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise Invalid(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def loads(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, f"duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def load(path):
    return loads(Path(path).read_bytes())


def validate(value, rule, field="manifest"):
    """Only the vocabulary used in our schema; unknown schema keywords fail."""
    supported = {"$schema", "$id", "title", "description", "type", "enum", "pattern",
                 "properties", "required", "additionalProperties", "items", "minItems",
                 "uniqueItems", "minProperties", "minimum", "maximum", "minLength"}
    require(not rule.keys() - supported, "unsupported schema vocabulary")
    types = {"object": dict, "array": list, "string": str, "integer": int,
             "boolean": bool, "null": type(None)}
    kinds = rule.get("type", list(types))
    kinds = kinds if isinstance(kinds, list) else [kinds]
    require(any(type(value) is types[k] for k in kinds), f"{field}: invalid type")
    if "enum" in rule:
        require(value in rule["enum"], f"{field}: unknown value {value!r}")
    if isinstance(value, dict):
        require(not set(rule.get("required", [])) - value.keys(), f"{field}: missing required fields")
        require(len(value) >= rule.get("minProperties", 0), f"{field}: empty object")
        for key, item in value.items():
            child = rule.get("properties", {}).get(key, rule.get("additionalProperties", {}))
            require(child is not False, f"{field}: unknown field {key}")
            validate(item, child, f"{field}.{key}")
    elif isinstance(value, list):
        require(len(value) >= rule.get("minItems", 0), f"{field}: empty array")
        if rule.get("uniqueItems"):
            require(len({json.dumps(x, sort_keys=True) for x in value}) == len(value),
                    f"{field}: duplicates")
        for index, item in enumerate(value):
            validate(item, rule.get("items", {}), f"{field}[{index}]")
    elif isinstance(value, str):
        require(len(value) >= rule.get("minLength", 0), f"{field}: empty string")
        if "pattern" in rule:
            require(re.fullmatch(rule["pattern"], value) is not None, f"{field}: noncanonical identifier")
    elif type(value) is int:
        require(rule.get("minimum", value) <= value <= rule.get("maximum", value),
                f"{field}: out of range")


def path(root, name, dot=False):
    require(isinstance(name, str) and (name == "." and dot or
            re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", name)),
            f"unsafe relative path: {name!r}")
    require(name == "." and dot or all(p not in (".", "..", ".git") and not p.startswith("-")
                                     for p in name.split("/")), f"unsafe path: {name}")
    result = root / name
    for candidate in (result, *result.parents):
        if candidate == root:
            break
        require(not candidate.is_symlink(), f"symlink path: {name}")
    require(result.resolve().is_relative_to(root), f"path escape: {name}")
    return result


def identity(root, name):
    p = path(root, name)
    require(not p.exists() or p.is_file(), f"regular file required: {name}")
    return digest(p.read_bytes()) if p.exists() else None


def pinned(root, record):
    require(identity(root, record["path"]) == record["sha256"],
            f"missing or changed evidence/input: {record['path']}")


def read_manifest(filename):
    manifest = load(filename)
    validate(manifest, load(Path(__file__).with_name("manifest-v1.schema.json")))
    return manifest
