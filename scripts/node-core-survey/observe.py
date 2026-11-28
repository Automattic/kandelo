#!/usr/bin/env python3
"""Record the original Node runner's decisions and child process observations."""

import hashlib
import json
import os
from pathlib import Path
import sys


def main(receipt, node, native_sha256, selectors):
    runner = Path.cwd() / "tools/test.py"
    sys.path.insert(0, str(runner.parent))
    import test

    with open(receipt, "x", encoding="utf-8", buffering=1) as stream:
        def record(kind, **fields):
            stream.write(json.dumps({"kind": kind, **fields}) + "\n")

        def identity(case):
            source = getattr(case, "file", None)
            return {"selector": "/".join(case.path),
                    "sourceFile": os.path.relpath(source) if source else None,
                    "wptGroup": getattr(case, "group", None)}

        classify = test.Configuration.ClassifyTests

        def classify_and_record(configuration, cases, env):
            classified, unused = classify(configuration, cases, env)
            for case in classified:
                record("discovered", **identity(case), outcomes=sorted(case.outcomes), profile=env)
            return classified, unused

        run_process = test.RunProcess

        def run_and_record(context, timeout, args, **options):
            if native_sha256 and node in args:
                with open(node, "rb") as executable:
                    actual = hashlib.file_digest(executable, "sha256").hexdigest()
                if actual != native_sha256:
                    raise ValueError("Native reference executable digest changed")
            # The guest's enclosing owned command already bounds discovery
            # probes. Preserve the upstream choice to run them without a
            # Python timer thread. Native discovery needs its own outer bound.
            bounded_timeout = timeout
            if timeout is not None:
                bounded_timeout = min(timeout, 120)
            elif native_sha256:
                bounded_timeout = 120
            record("launch", argv=args, timeoutSeconds=bounded_timeout, environment=options.get("env"))
            try:
                process, status, timed_out = run_process(context, bounded_timeout, args, **options)
            except OSError as error:
                record("launch-error", argv=args, error=str(error))
                raise
            record("exited", argv=args, pid=process.pid, exitStatus=status, timeout=timed_out)
            return process, status, timed_out

        class ObserveTap(test.TapProgressIndicator):
            def HasRun(self, output):
                super().HasRun(output)
                skip = test.skip_regex.search(output.output.stdout)
                record(
                    "result", **identity(output.test), argv=output.command,
                    expected=sorted(output.test.outcomes), unexpected=output.UnexpectedOutput(),
                    exitStatus=output.output.exit_code, timeout=output.HasTimedOut(),
                    durationMs=output.test.duration.total_seconds() * 1000,
                    crash=output.HasCrashed(), failed=output.HasFailed(),
                    skipReason=skip.group(1) if skip else None,
                    stdout=output.output.stdout, stderr=output.output.stderr,
                )

        test.Configuration.ClassifyTests = classify_and_record
        test.RunProcess = run_and_record
        test.PROGRESS_INDICATORS["tap"] = ObserveTap
        # The original runner scales this option by host architecture. Keep
        # the actual child ceiling at 120 seconds on the current release-mode shard.
        scale = test.TIMEOUT_SCALEFACTOR[test.ARCH_GUESS or "ia32"]["release"]
        sys.argv = [str(runner), "--shell", node, "-j", "1", "--progress=tap", "--report",
                    f"--timeout={120 // scale}", "--repeat=1", "--measure-flakiness=0",
                    "--no-store-unexpected-output", *selectors]
        record("runner", argv=sys.argv, platform=sys.platform,
               nativeReferenceSha256=native_sha256 or None, environment=dict(os.environ))
        return test.Main()


if __name__ == "__main__":
    receipt_path, node_path, reference_sha256, *test_selectors = sys.argv[1:]
    sys.exit(main(receipt_path, node_path, reference_sha256, test_selectors))
