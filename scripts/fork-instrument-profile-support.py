"""Shared serial measurement and artifact-validation helpers."""
import hashlib
import json
import resource

def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_guarded(guard, command, prefix, ceiling, timeout, env):
    # This coordinator launches one child at a time. Reaped-child CPU deltas
    # include the CLI's waited-for optimizer, but exclude later validators.
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    status = guard.guarded(command, prefix, ceiling, timeout, env)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    status.update(cpu_user_s=after.ru_utime - before.ru_utime,
                  cpu_system_s=after.ru_stime - before.ru_stime)
    prefix.with_suffix(".status.json").write_text(json.dumps(status, indent=2) + "\n")
    return status


def validate(guard, scripts, artifact, prefix, ceiling, timeout, env):
    return run_guarded(guard,
        ["node", "--experimental-wasm-exnref", "--import", "tsx",
         str(scripts / "check-fork-memory-artifact.ts"), str(artifact), "--contract-only"],
        prefix, ceiling, timeout, env)
