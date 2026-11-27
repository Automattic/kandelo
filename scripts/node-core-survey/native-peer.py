#!/usr/bin/env python3
"""Run the supplemental HTTPS pair with an authenticated native Node binary."""

import argparse
import hashlib
import json
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def run(node, expected_digest, certificate_directory, output):
    if digest(node) != expected_digest:
        raise ValueError("Native Node binary digest does not match the authenticated reference")
    program = Path(__file__).resolve().parent / "supplemental/peer-fetch.mjs"
    files = {
        "program": program,
        "certificate": certificate_directory / "peer-cert.pem",
        "key": certificate_directory / "peer-key.pem",
    }
    result = {
        "nativeBinarySha256": expected_digest,
        "peerFixturesSha256": {name: digest(path) for name, path in files.items()},
        "address": "127.0.0.1",
    }
    with output.open("x") as report, tempfile.TemporaryDirectory(prefix="kandelo-native-peer-") as home:
        root = Path(home)
        for path in files.values():
            shutil.copy2(path, root / path.name)
        env = {"PATH": "/usr/bin:/bin", "HOME": home, "TZ": "UTC"}
        command = [node, "--no-use-system-ca", root / program.name]
        address = result["address"]
        deadline = time.monotonic() + 120
        first_line = ""
        server = subprocess.Popen(
            [*command, "server", address, "0", address], cwd=root, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            ready, _, _ = select.select([server.stdout], [], [], deadline - time.monotonic())
            if not ready:
                raise TimeoutError("Native TLS listener readiness exceeded the deadline")
            first_line = server.stdout.readline()
            result["listener"] = json.loads(first_line)["listening"]
            client = subprocess.run(
                [*command, "client", address, str(result["listener"]["port"])], cwd=root, env=env,
                capture_output=True, text=True, timeout=max(0, deadline - time.monotonic()),
            )
            result.update(clientExit=client.returncode, clientStdout=client.stdout, clientStderr=client.stderr)
            if client.returncode != 0:
                raise RuntimeError("Native TLS client failed")
            stdout, stderr = server.communicate(timeout=max(0, deadline - time.monotonic()))
            result.update(serverExit=server.returncode, serverStdout=first_line + stdout, serverStderr=stderr)
            if server.returncode != 0:
                raise RuntimeError("Native TLS server failed")
        except Exception as error:
            result["error"] = str(error)
            raise
        finally:
            if "serverExit" not in result:
                if server.poll() is None:
                    server.kill()
                stdout, stderr = server.communicate(timeout=10)
                result.update(serverExit=server.returncode, serverStdout=first_line + stdout, serverStderr=stderr)
            json.dump(result, report, indent=2)
            report.write("\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("node", type=Path)
    parser.add_argument("native_sha256")
    parser.add_argument("certificate_directory", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    run(args.node.resolve(strict=True), args.native_sha256, args.certificate_directory, args.output)
