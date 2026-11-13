#!/usr/bin/env python3
"""Focused generator integrity checks; never execute or compile Node sources."""

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'node_registry_generator', Path(__file__).resolve().parents[3] / 'scripts/generate-nodejs-source-registry.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class RegistryInputChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.imported = self.root / 'import'
        (self.imported / 'upstream/lib').mkdir(parents=True)
        self.manifest = self.imported / 'sources.json'
        self.output = self.root / 'build/registry.inc'
        self.output.parent.mkdir()
        self.output.write_bytes(b'previous valid output')
        self.records = []
        self.add('lib/z.js', 'z', b'\x00\xff\xe2\x80\x99\r\n')
        self.add('lib/a.js', 'a', b'"\\?\n')
        self.add('src/builtin_info.cc', None, b'original cc fixture')
        self.add('src/builtin_info.h', None, b'original h fixture')
        self.metadata_tool = self.root / 'metadata-tool'
        self.make_tool("import sys\nfor row in sys.stdin.read().splitlines():\n    print(row + '\\tkFunction\\texports,require,module,process,internalBinding,primordials')\n")

    def make_tool(self, body):
        self.metadata_tool.write_text('#!' + sys.executable + '\n' + body)
        self.metadata_tool.chmod(0o755)

    def add(self, path, identifier, data):
        source = self.imported / 'upstream' / path
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(data)
        self.records.append({'path': path, 'builtinId': identifier,
                             'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})

    def write_manifest(self):
        self.manifest.write_text(json.dumps({'schema': 1, 'files': self.records}))

    def generate(self):
        self.write_manifest()
        return generator.generate(self.manifest, self.output, self.metadata_tool)

    def assert_rejected_unchanged(self):
        with self.assertRaises((ValueError, OSError)):
            self.generate()
        self.assertEqual(self.output.read_bytes(), b'previous valid output')
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])

    def test_exact_bytes_descriptors_and_determinism(self):
        result = self.generate()
        first = self.output.read_bytes()
        text = first.decode('ascii')
        literal_section = text.split('kNodeBuiltinBytes[] = {\n', 1)[1].split('};', 1)[0]
        data = bytes(int(value, 16) for value in re.findall(r'0x([0-9a-f]{2})', literal_section))
        self.assertEqual(data, b'"\\?\n\x00\xff\xe2\x80\x99\r\n')
        self.assertIn('{"a", "lib/a.js", 0, 4, "node:a", "kFunction", kNodeBuiltinParameters0, 6}', text)
        self.assertIn('{"z", "lib/z.js", 4, 7, "node:z", "kFunction", kNodeBuiltinParameters0, 6}', text)
        self.assertEqual(result['builtinSources'], 2)
        self.assertEqual(text.count('static constexpr const char* const kNodeBuiltinParameters'), 1)
        self.assertEqual(result['metadataToolSha256'], hashlib.sha256(self.metadata_tool.read_bytes()).hexdigest())
        self.assertEqual(set(result['builtinInfoSha256']), {'src/builtin_info.cc', 'src/builtin_info.h'})
        self.assertEqual(result['sourceBytes'], len(data))
        self.generate()
        self.assertEqual(self.output.read_bytes(), first)

    def test_hash_or_length_drift_preserves_output(self):
        for field, value in [('sha256', '0' * 64), ('bytes', 100)]:
            with self.subTest(field=field):
                old = self.records[0][field]
                self.records[0][field] = value
                self.assert_rejected_unchanged()
                self.records[0][field] = old

    def test_unsafe_paths_and_ids_preserve_output(self):
        for field in ('path', 'builtinId'):
            for value in ('../outside.js', '/outside.js', 'lib//z.js', 'lib/./z.js',
                          'lib/z.js/', 'lib\\z.js', 'x\ncomment', '', 'C:/x.js'):
                with self.subTest(field=field, value=value):
                    old = self.records[0][field]
                    self.records[0][field] = value
                    self.assert_rejected_unchanged()
                    self.records[0][field] = old

    def test_duplicate_ids_and_paths_preserve_output(self):
        for field in ('path', 'builtinId'):
            with self.subTest(field=field):
                old = self.records[1][field]
                self.records[1][field] = self.records[0][field]
                self.assert_rejected_unchanged()
                self.records[1][field] = old

    def test_symlink_source_or_parent_preserves_output(self):
        source = self.imported / 'upstream/lib/z.js'
        target = self.root / 'outside.js'
        target.write_bytes(source.read_bytes())
        source.unlink()
        source.symlink_to(target)
        self.assert_rejected_unchanged()
        source.unlink()
        source.write_bytes(target.read_bytes())
        library = self.imported / 'upstream/lib'
        renamed = self.root / 'library'
        library.rename(renamed)
        library.symlink_to(renamed, target_is_directory=True)
        self.assert_rejected_unchanged()

    def test_atomic_publication_failure_cleans_temporary(self):
        self.write_manifest()
        with patch.object(generator.os, 'replace', side_effect=OSError('publication denied')):
            with self.assertRaises(OSError):
                generator.generate(self.manifest, self.output, self.metadata_tool)
        self.assertEqual(self.output.read_bytes(), b'previous valid output')
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])

    def test_output_cannot_replace_import_or_symlink(self):
        self.write_manifest()
        source = self.imported / 'upstream/lib/z.js'
        before = source.read_bytes()
        with self.assertRaises(ValueError):
            generator.generate(self.manifest, source, self.metadata_tool)
        self.assertEqual(source.read_bytes(), before)
        self.output.unlink()
        self.output.symlink_to(source)
        with self.assertRaises(ValueError):
            generator.generate(self.manifest, self.output, self.metadata_tool)
        self.assertEqual(source.read_bytes(), before)
        tool_before = self.metadata_tool.read_bytes()
        with self.assertRaises(ValueError):
            generator.generate(self.manifest, self.metadata_tool, self.metadata_tool)
        self.assertEqual(self.metadata_tool.read_bytes(), tool_before)

    def test_malformed_record_metadata_preserves_output(self):
        for field, value in [('sha256', 'not-a-digest'), ('bytes', True),
                             ('bytes', -1), ('bytes', 1.5), ('builtinId', True)]:
            with self.subTest(field=field, value=value):
                old = self.records[0][field]
                self.records[0][field] = value
                self.assert_rejected_unchanged()
                self.records[0][field] = old
        identifier = self.records[0].pop('builtinId')
        self.assert_rejected_unchanged()
        self.records[0]['builtinId'] = identifier

    def test_metadata_admission_preserves_existing_output(self):
        prefix = "import sys\nrows = sys.stdin.read().splitlines()\n"
        cases = [
            "sys.exit(2)",
            "print('')",
            "print('\\n'.join(row + '\\tkFunction\\t' for row in rows + rows))",
            "print('\\n'.join(row + '\\tkFunction\\t' for row in reversed(rows)))",
            "print('\\n'.join('other\\t' + row.split('\\t')[1] + '\\tkFunction\\t' for row in rows))",
            "print('\\n'.join(row + '\\tkUnknown\\t' for row in rows))",
            "print('\\n'.join(row + '\\tkFunction\\tx); injected' for row in rows))",
            "print('\\n'.join(row + '\\tkFunction\\tprocess,process' for row in rows))",
            "print('\\n'.join(row + '\\tkSourceTextModule\\tprocess' for row in rows))",
            "print('\\n'.join(row + '\\tkFunction\\t\\textra' for row in rows))",
            "sys.stdout.buffer.write(b'\\xff')",
            "sys.stdout.write('\\n'.join(row + '\\tkFunction\\t' for row in rows))",
        ]
        for body in cases:
            with self.subTest(body=body):
                self.make_tool(prefix + body + '\n')
                self.assert_rejected_unchanged()

    def test_metadata_module_empty_arguments_and_no_python_classification(self):
        # A protocol fixture, not a claim about upstream classification. This
        # confirms the generator consumes the tool rather than deriving kinds.
        self.make_tool("import sys\nfor row in sys.stdin.read().splitlines():\n    print(row + '\\tkSourceTextModule\\t')\n")
        self.generate()
        text = self.output.read_text()
        self.assertIn('"node:a", "kSourceTextModule", nullptr, 0}', text)
        self.assertNotIn('static constexpr const char* const', text)

    def test_original_metadata_hash_checked_before_tool_execution(self):
        (self.imported / 'upstream/src/builtin_info.cc').write_bytes(b'changed')
        with patch.object(generator.subprocess, 'run') as run:
            self.assert_rejected_unchanged()
        run.assert_not_called()

    def test_invalid_schema_and_empty_input(self):
        for document in ({'schema': True, 'files': self.records},
                         {'schema': 2, 'files': self.records},
                         {'schema': 1, 'files': {}},
                         {'schema': 1, 'files': []}):
            with self.subTest(document=document):
                self.manifest.write_text(json.dumps(document))
                with self.assertRaises(ValueError):
                    generator.generate(self.manifest, self.output, self.metadata_tool)
                self.assertEqual(self.output.read_bytes(), b'previous valid output')


if __name__ == '__main__':
    unittest.main()
