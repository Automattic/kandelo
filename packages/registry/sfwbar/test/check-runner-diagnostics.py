#!/usr/bin/env python3
"""Classify real pinned-source diagnostics; unrelated crashes remain failures."""
import hashlib
import importlib.util
import pathlib
import re
import sys
import tarfile
import tempfile
import tomllib
import unittest

here = pathlib.Path(__file__).resolve().parent
archive = pathlib.Path(sys.argv[1])
observed = {variant: pathlib.Path(argument).read_bytes()
            for variant, argument in zip((("data-only", "collapse-unmap"),
                                         ("before", "collapse-unmap"),
                                         ("data-only", "collapse-reentrant"),
                                         ("before", "collapse-reentrant")), sys.argv[2:])}
spec = importlib.util.spec_from_file_location("runner", here / "run-window-lifecycle.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class Diagnostics(unittest.TestCase):
    variant = "data-only"
    case = "collapse-unmap"

    def setUp(self):
        manifest = tomllib.loads((here.parent / "package.toml").read_text())
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), manifest["source"]["sha256"])
        with tarfile.open(archive) as payload:
            member = f'{manifest["name"]}-{manifest["version"]}/src/window.c'
            source = payload.extractfile(member).read().decode()
        if self.variant == "data-only":
            a, b = source.index("void window_ref_free"), source.index("\nvoid window_ref (")
            source = source[:a] + '''static void window_ref_free(gpointer data) {
  GList **refs=data;
  g_list_free(*refs);
  g_free(refs);
}
''' + source[b:]
            source = source.replace("(GDestroyNotify)window_ref_free", "window_ref_free")
        self.temporary = tempfile.TemporaryDirectory(prefix="sfwbar-diagnostic-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.source = self.root / self.variant / "src/window.c"
        self.source.parent.mkdir(parents=True)
        self.source.write_text(source)
        self.line = next(i for i, text in enumerate(source.splitlines(), 1)
                         if text.strip() == "if(GTK_IS_MENU(iter->data))")
        if (self.variant, self.case) in observed:
            actual = observed[self.variant, self.case]
            old_path = re.search(rb" in window_collapse_popups (.+/" + self.variant.encode()
                                 + rb"/src/window.c):", actual)[1]
            self.output = actual.replace(old_path, str(self.source).encode())
        else:
            location = f"{self.source}:{self.line}:8"
            self.output = (f"ENTER {self.case}\nUndefinedBehaviorSanitizer:DEADLYSIGNAL\n"
                "==1==ERROR: UndefinedBehaviorSanitizer: SEGV on unknown address 0x10\n"
                "==1==The signal is caused by a READ memory access.\n"
                f"    #0 0x10 in window_collapse_popups {location}\n"
                f"SUMMARY: UndefinedBehaviorSanitizer: SEGV {location} in window_collapse_popups\n"
                "==1==ABORTING\n").encode()

    def classify(self, output=None, variant=None, case=None, code=-6):
        return runner.expected_case(self.root, self.variant if variant is None else variant,
                                    self.case if case is None else case, code,
                                    self.output if output is None else output)

    def test_observed_fault_is_source_bound(self):
        self.assertFalse(any(m in self.output for m in (
            b"lifecycle_checked_get_data", b"assertion failed", b"should be FALSE", b"runtime error:")))
        self.assertTrue(self.classify())
        self.assertTrue(self.classify(code=1))

    def test_arbitrary_signal_and_timeout_rejected(self):
        for code in (-15, -9, -11, 0, "timeout"):
            with self.subTest(code=code): self.assertFalse(self.classify(code=code))
        self.assertFalse(self.classify(f"ENTER {self.case}\nSegmentation fault\n".encode()))
        self.assertFalse(self.classify(f"ENTER {self.case}\nUndefinedBehaviorSanitizer:DEADLYSIGNAL\n".encode()))

    def test_wrong_case_variant_and_patched_failure_rejected(self):
        other_variant = "data-only" if self.variant == "before" else "before"
        other_case = "collapse-reentrant" if self.case == "collapse-unmap" else "collapse-unmap"
        for variant, case in [(other_variant, self.case), ("unknown", self.case),
                              ("after", self.case), (self.variant, other_case),
                              (self.variant, "owner-finalize")]:
            with self.subTest(variant=variant, case=case):
                self.assertFalse(self.classify(variant=variant, case=case))

    def test_wrong_function_source_statement_and_frame_rejected(self):
        for old, new in [(b"window_collapse_popups", b"unrelated"),
                         (str(self.source).encode(), b"/other/data-only/src/window.c"),
                         (b"#0 ", b"#1 "), (b"READ memory access", b"WRITE memory access")]:
            with self.subTest(change=old): self.assertFalse(self.classify(self.output.replace(old, new)))
        self.source.write_text(self.source.read_text().replace("if(GTK_IS_MENU(iter->data))", "if(TRUE)"))
        self.assertFalse(self.classify())

    def test_truncated_or_inconsistent_diagnostic_rejected(self):
        self.assertFalse(self.classify(self.output.split(b"SUMMARY:")[0]))
        self.assertFalse(self.classify(self.output.split(b"==")[0]))
        self.assertFalse(self.classify(re.sub(rb"SUMMARY:.*", b"SUMMARY: unrelated", self.output)))
        self.assertFalse(self.classify(self.output.replace(f"ENTER {self.case}\n".encode(), b"")))

    def test_patched_success_rules_unchanged(self):
        self.assertTrue(self.classify(f"ENTER {self.case}\nPASS {self.case}\n".encode(), variant="after", code=0))
        self.assertFalse(self.classify(f"ENTER {self.case}\n".encode(), variant="after", code=0))
        self.assertFalse(self.classify(f"PASS {self.case}\n".encode(), variant="after", code=-6))


class BeforeDiagnostics(Diagnostics):
    variant = "before"


class DataOnlyReentrantDiagnostics(Diagnostics):
    case = "collapse-reentrant"


class BeforeReentrantDiagnostics(BeforeDiagnostics):
    case = "collapse-reentrant"


unittest.main(argv=[sys.argv[0]])
