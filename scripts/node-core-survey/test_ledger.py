import json
from pathlib import Path
import tempfile
import unittest

from ledger import summarize


class InterruptedRunnerTest(unittest.TestCase):
    def test_only_identified_case_gets_runner_timeout(self):
        files = ["test/parallel/test-first.js", "test/parallel/test-second.js"]
        keys = [(Path(source).with_suffix("").as_posix().removeprefix("test/"), source)
                for source in files]
        selection = {"cases": [{"selector": selector, "file": source} for selector, source in keys]}
        native = {key: {"argv": ["/native/bin/node", "--expose-gc", "/native/tree/" + key[1]]}
                  for key in keys}
        discovered = [{"kind": "discovered", "selector": selector, "sourceFile": source,
                       "outcomes": ["pass"]} for selector, source in keys]
        argv = ["/usr/bin/node", "--expose-gc", "/tmp/node-core-survey/" + files[0]]
        launch = {"kind": "launch", "argv": argv, "environment": {"TEST_SERIAL_ID": "0"}}
        timeout = {"outcome": "timeout", "phase": "upstream-runner"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "observations.jsonl"

            def classify(*events, transport=timeout, reference=native):
                path.write_text("".join(json.dumps(r) + "\n" for r in [*discovered, *events]))
                return summarize(selection, path, transport, reference)

            results = classify(launch)
            self.assertEqual(results[keys[0]]["disposition"], "runner-timeout")
            self.assertIsNone(results[keys[0]]["result"])
            self.assertEqual(results[keys[0]]["caseAttempt"]["lastChildRecord"], "launch")
            self.assertEqual(results[keys[1]]["disposition"], "blocked-unrun")
            exited = {"kind": "exited", "argv": argv, "pid": 11, "exitStatus": 0, "timeout": False}
            case = classify(launch, exited)[keys[0]]
            self.assertEqual(case["disposition"], "runner-timeout")
            self.assertEqual(case["caseAttempt"]["exitStatus"], 0)
            self.assertEqual(case["caseAttempt"]["lastChildLine"], 4)
            self.assertEqual(classify(launch, transport={"outcome": "setup-error",
                             "phase": "upstream-runner"})[keys[0]]["disposition"], "runner-interrupted")
            for observation in [dict(launch, environment={}), dict(launch, argv=argv[:1] + argv[2:])]:
                self.assertEqual(classify(observation)[keys[0]]["disposition"], "blocked-unrun")
            other = ("parallel/test-unidentified-group", files[0])
            self.assertEqual(classify(launch, reference={**native, other: None})[keys[0]]["disposition"],
                             "blocked-unrun")
            self.assertEqual(classify(launch, transport={"outcome": "timeout",
                             "phase": "fixture-setup"})[keys[0]]["disposition"], "blocked-unrun")


if __name__ == "__main__":
    unittest.main()
