"""Exercise the real Rust renderers in isolated repositories; fake only GitHub."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ChangelogTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kandelo-changelog-test-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        for directory in ("scripts", "changelog.d", "changelog/updates", "abi"):
            (self.repo / directory).mkdir(parents=True)
        for name in ("scripts/changelog", "towncrier.toml", "cliff.toml"):
            shutil.copy(ROOT / name, self.repo / name)
        tool = self.repo / "scripts/changelog-tool"
        tool.write_text("#!/usr/bin/env bash\nexec " + shlex.quote(str(ROOT / "scripts/changelog-tool")) + ' "$@"\n')
        tool.chmod(0o755)
        (self.repo / "abi/snapshot.json").write_text(json.dumps({
            "abi_version": 17,
            "host_adapter": {"manifest": {"required_host_adapter_version": 9}},
        }))
        (self.repo / ".gitignore").write_text(".context/\n")
        self.git("init", "-q", "--initial-branch=main")
        self.git("config", "user.name", "Test Contributor")
        self.git("config", "user.email", "test@example.invalid")
        self.run_cli("assemble")
        self.commit("Kernel: Initial test platform")
        self.env = os.environ.copy()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True).strip()

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def run_cli(self, *args, ok=True):
        result = subprocess.run([str(self.repo / "scripts/changelog"), *args],
                                cwd=self.repo, text=True, capture_output=True,
                                env=getattr(self, "env", None))
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def fragment(self, name="+sample.ui", text="A readable change."):
        path = self.repo / "changelog.d" / name
        path.write_text(text + "\n")
        return path

    def prepare(self):
        self.fragment()
        self.source = self.commit("Browser: Add a sample change")
        self.run_cli("prepare", "--date", "2026-11-09")
        return self.repo / "changelog/updates/2026.11.09.md"

    def test_real_renderer_categories_preview_and_versions(self):
        for category in ("ui", "agentic", "ports", "correctness", "completeness", "features", "breaking"):
            self.fragment(f"+sample-{category}.{category}", f"Outcome for {category}.")
        self.fragment("123.ui", "Preserve **Markdown** and PR links.")
        source = self.commit("Browser: Describe several independent outcomes")
        before = self.git("status", "--porcelain")
        preview = self.run_cli("prepare", "--date", "2026-11-09", "--preview").stdout
        self.assertEqual(self.git("status", "--porcelain"), before)
        self.assertEqual(len(list((self.repo / "changelog.d").iterdir())), 8)
        self.assertIn("Program ABI **17** · Kernel/host **9**", preview)
        self.assertLess(preview.index("Breaking Changes & Migration"), preview.index("User Interface"))
        self.assertIn("https://github.com/Automattic/kandelo/pull/123", preview)
        self.assertIn("**Markdown**", preview)
        self.assertNotIn("#sample", preview)
        (self.repo / "unrelated-untracked.txt").write_text("keep me")
        self.run_cli("prepare", "--date", "2026-11-09")
        self.assertTrue((self.repo / "unrelated-untracked.txt").exists())
        self.assertEqual(list((self.repo / "changelog.d").iterdir()), [])
        update = (self.repo / "changelog/updates/2026.11.09.md").read_text()
        self.assertIn(source, update)
        self.run_cli("check")
        self.assertEqual(self.run_cli("notes", "2026.11.09").stdout.strip(), preview.strip())

    def test_rejects_invalid_fragments_and_stale_index(self):
        for name, content in (("sample.ui", "entry"), ("+sample.unknown", "entry"), ("+sample.ui", "")):
            with self.subTest(name=name, content=content):
                path = self.repo / "changelog.d" / name
                path.write_text(content)
                self.run_cli("check", ok=False)
                path.unlink()
        path = self.repo / "changelog.d/+link.ui"
        path.symlink_to(self.repo / "cliff.toml")
        self.assertIn("not a regular", self.run_cli("check", ok=False).stderr)
        path.unlink()
        (self.repo / "CHANGELOG.md").write_text("stale")
        self.assertIn("stale", self.run_cli("check", ok=False).stderr)

    def test_nominated_highlights_are_collected_with_real_categorized_news(self):
        self.fragment("+agent-development.agentic", '''+++
headline = "Give an agent a development computer in your browser"
highlight = """Edit source and run installed compilers together.
[Explore the tools](https://example.invalid/tools)."""
+++
Image-declared tools run as owned jobs with cancellation.
''')
        self.fragment("+migration.breaking", "Export files before updating.")
        self.fragment("+ordinary.ui", "Pasting preserves line breaks.")
        self.commit("Browser: Add tools with an author-written highlight")
        before = (self.repo / "changelog.d/+agent-development.agentic").read_text()
        preview = self.run_cli("prepare", "--date", "2026-11-09", "--preview").stdout
        self.assertEqual((self.repo / "changelog.d/+agent-development.agentic").read_text(), before)
        self.assertLess(preview.index("### Highlights"), preview.index("### Breaking Changes"))
        self.assertIn("**Give an agent a development computer in your browser.**", preview)
        self.assertIn("[Explore the tools](https://example.invalid/tools)", preview)
        self.assertIn("### Agentic Workflows", preview)
        self.assertIn("Image-declared tools run as owned jobs", preview)
        self.assertIn("Pasting preserves line breaks.", preview)
        self.assertNotIn('headline =', preview)
        self.assertNotIn('+++', preview)
        self.run_cli("prepare", "--date", "2026-11-09")
        self.run_cli("check")
        self.assertEqual(self.run_cli("notes", "2026.11.09").stdout.strip(), preview.strip())

    def test_invalid_highlight_metadata_is_rejected_before_consuming_news(self):
        cases = [
            '+++\nheadline = "Unclosed"',
            '+++\nheadline = "Missing summary"\n+++\nNews.',
            '+++\nheadline = ""\nhighlight = "Summary"\n+++\nNews.',
            '+++\nheadline = "Good"\nhighlight = ""\n+++\nNews.',
            '+++\nheadline = true\nhighlight = "Summary"\n+++\nNews.',
            '+++\nheadline = "Good"\nhighlight = "Summary"\nrank = 1\n+++\nNews.',
            '+++\nheadline = "Good"\nhighlight = "Summary"\n+++\n',
            '+++\nheadline = "Bad TOML\nhighlight = "Summary"\n+++\nNews.',
        ]
        for content in cases:
            with self.subTest(content=content):
                path = self.fragment(text=content)
                self.commit("Browser: Add an invalid nomination fixture")
                self.run_cli("check", ok=False)
                self.run_cli("prepare", "--date", "2026-11-09", ok=False)
                self.assertEqual(path.read_text(), content + "\n")
                self.assertEqual(list((self.repo / "changelog/updates").glob("*.md")), [])

    def test_all_nominations_survive_assembly_without_arbitrary_ranking(self):
        for index in range(7):
            self.fragment(f"+outcome-{index}.features", f'''+++
headline = "Outcome {index}"
highlight = "A reader-facing summary of outcome {index}."
+++
Detailed news for outcome {index}.
''')
        self.fragment("+same-outcome.ports", '''+++
headline = "Outcome 0"
highlight = "A reader-facing summary of outcome 0."
+++
Additional package details for the same outcome.
''')
        self.commit("Kernel: Describe several major outcomes")
        preview = self.run_cli("prepare", "--date", "2026-11-09", "--preview").stdout
        highlights = preview.split("### Highlights\n\n")[1].split("\n### ", 1)[0]
        for index in range(7):
            self.assertIn(f"**Outcome {index}.**", highlights)
        self.assertEqual(highlights.count("- **"), 7)
        self.assertIn("Additional package details for the same outcome.", preview)

    def test_requires_fragment_or_explicit_reason(self):
        base = self.git("rev-parse", "HEAD")
        (self.repo / "internal.txt").write_text("maintenance")
        self.commit("Tests: Maintain an internal fixture")
        self.run_cli("check", "--base", base, ok=False)
        event = self.repo / "event.json"
        event.write_text(json.dumps({"pull_request": {"body": "Changelog: none Internal maintenance."}}))
        self.run_cli("check", "--base", base, "--event", str(event))
        self.fragment()
        self.commit("Browser: Add a change with an entry")
        self.run_cli("check", "--base", base)

    def test_dirty_untracked_and_duplicate_prepare_preserve_fragments(self):
        path = self.fragment()
        self.assertIn("error", self.run_cli("prepare", "--date", "2026-11-09", ok=False).stderr)
        self.assertTrue(path.exists())
        self.commit("Browser: Add a tracked entry")
        (self.repo / "abi/snapshot.json").write_text("dirty")
        self.assertIn("clean checkout", self.run_cli("prepare", "--date", "2026-11-09", ok=False).stderr)
        self.assertTrue(path.exists())
        self.git("restore", "abi/snapshot.json")
        self.run_cli("prepare", "--date", "2026-11-09")
        self.commit("Docs: Collect the first update")
        self.fragment("+next.ui")
        self.commit("Browser: Add another change")
        self.assertIn("later", self.run_cli("prepare", "--date", "2026-11-09", ok=False).stderr)
        self.assertTrue((self.repo / "changelog.d/+next.ui").exists())
        self.run_cli("prepare", "--date", "2026-11-16")
        self.run_cli("check")
        index = (self.repo / "CHANGELOG.md").read_text()
        self.assertLess(index.index("## 2026.11.16"), index.index("## 2026.11.09"))
        self.assertIn("Full diff", index)

    def test_metadata_is_checked_against_source(self):
        update = self.prepare()
        update.write_text(update.read_text().replace('"program_abi": 17', '"program_abi": 999'))
        self.assertIn("versions differ", self.run_cli("assemble", ok=False).stderr)

    def test_history_includes_unprefixed_changes_and_ignores_artifact_tags(self):
        self.git("tag", "binaries-abi-v17")
        self.git("tag", "archive/test")
        self.fragment()
        self.commit("Browser: Show the example")
        self.fragment("+other.features")
        self.commit("unprefixed historical milestone")
        inventory = self.run_cli("history", "HEAD").stdout
        for message in ("Kernel: Initial test platform", "Browser: Show the example", "unprefixed historical milestone"):
            self.assertIn(message, inventory)
        self.assertNotIn("## binaries-abi", inventory)

    def fake_github(self):
        bin_dir = self.repo / "fake-bin"
        bin_dir.mkdir()
        state_file = self.repo / "github-state.json"
        state_file.write_text(json.dumps({"source": self.source, "calls": []}))
        gh = bin_dir / "gh"
        gh.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
path = pathlib.Path(os.environ["GH_TEST_STATE"])
state = json.loads(path.read_text())
args = sys.argv[1:]
state["calls"].append(args)
def finish(value=None, error=None):
    path.write_text(json.dumps(state))
    if error:
        print(error, file=sys.stderr)
        sys.exit(1)
    print(json.dumps(value))
if state.get("fail"):
    finish(error="HTTP 503 service unavailable")
if args[:3] == ["api", "--method", "POST"]:
    state["tag"] = state["source"]
    finish({})
elif args[0] == "api" and "/git/ref/tags/" in args[1]:
    if "tag" not in state:
        finish(error="HTTP 404 not found")
    finish({"object": {"type": "commit", "sha": state["tag"]}})
elif args[0] == "api" and "/releases/tags/" in args[1]:
    if "release" not in state:
        finish(error="HTTP 404 not found")
    finish({"body": state["release"], "draft": False, "html_url": "https://example.invalid/update"})
elif args[:2] == ["release", "create"]:
    state["release"] = pathlib.Path(args[args.index("--notes-file") + 1]).read_text()
    finish({})
else:
    finish(error="unexpected command")
''')
        gh.chmod(0o755)
        self.env.update(PATH=str(bin_dir) + os.pathsep + self.env["PATH"], GH_TEST_STATE=str(state_file))
        return state_file

    def test_publication_retries_without_overwriting(self):
        self.prepare()
        state_file = self.fake_github()
        self.run_cli("publish", "2026.11.09", "--repo", "example/project")
        state = json.loads(state_file.read_text())
        creates = [c for c in state["calls"] if c[:2] == ["release", "create"]]
        self.assertEqual(len(creates), 1)
        self.assertIn("--verify-tag", creates[0])
        self.assertIn("--latest=false", creates[0])
        self.assertEqual(state["tag"], self.source)
        self.run_cli("publish", "2026.11.09", "--repo", "example/project")
        state = json.loads(state_file.read_text())
        self.assertEqual(sum(c[:2] == ["release", "create"] for c in state["calls"]), 1)
        state["release"] = "Different published text"
        state_file.write_text(json.dumps(state))
        self.assertIn("refusing to overwrite", self.run_cli("publish", "2026.11.09", "--repo", "example/project", ok=False).stderr)

    def test_publication_refuses_wrong_tag_and_uncertain_lookup(self):
        self.prepare()
        state_file = self.fake_github()
        for extra in ({"tag": "0" * 40}, {"fail": True}):
            state_file.write_text(json.dumps({"source": self.source, "calls": [], **extra}))
            self.run_cli("publish", "2026.11.09", "--repo", "example/project", ok=False)
            calls = json.loads(state_file.read_text())["calls"]
            self.assertFalse(any(c[:2] == ["release", "create"] or "POST" in c for c in calls))


if __name__ == "__main__":
    unittest.main()
