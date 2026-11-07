import contextlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('game_import', Path(__file__).resolve().parents[2] / 'images/vfs/runtime/game-import.py')
game = importlib.util.module_from_spec(spec)
spec.loader.exec_module(game)


def mz(signature=None, extender=b''):
    data = bytearray(256)
    data[:2] = b'MZ'
    struct.pack_into('<4H', data, 2, 256, 1, 0, 4)
    if signature:
        struct.pack_into('<I', data, 60, 64)
        data[64:64+len(signature)] = signature
        data[80:80+len(extender)] = extender
    return bytes(data)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def archive(self, members):
        path = self.root / 'games.zip'
        with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as output:
            for name, data in members:
                output.writestr(name, data)
        return path

    def test_unpack_preserves_game_files_and_notices(self):
        source = self.archive([('game/PLAY.EXE', mz()), ('game/LICENSE.txt', b'license'),
                               ('game/DOS4GW.EXE', mz()), ('game/saves/', b'')])
        stage, zipped = game.stage_import(source, self.root / 'imports')
        self.assertTrue(zipped)
        self.assertEqual((stage / 'files/games.zip').read_bytes(), source.read_bytes())
        root = stage / 'files/games.zip.unpacked/game'
        self.assertEqual((root / 'PLAY.EXE').read_bytes(), mz())
        self.assertEqual((root / 'LICENSE.txt').read_bytes(), b'license')
        self.assertEqual((root / 'DOS4GW.EXE').read_bytes(), mz())
        self.assertTrue((root / 'saves').is_dir())
        self.assertEqual((root / 'PLAY.EXE').stat().st_mode & 0o777, 0o600)

    def test_zip_signature_works_without_extension(self):
        source = self.archive([('renamed', b'NES\x1a' + bytes(32))])
        renamed = self.root / 'bundle'
        source.rename(renamed)
        stage, zipped = game.stage_import(renamed, self.root / 'imports')
        self.assertTrue(zipped)
        self.assertTrue((stage / 'files/bundle.unpacked/renamed').is_file())

    def test_rejects_unsafe_paths_before_writing(self):
        for name in ('../escape', '/absolute', 'C:/drive', 'a/../escape', 'a\\escape', 'a\nname'):
            with self.subTest(name=name):
                source = self.archive([(name, b'bad')])
                with self.assertRaises(game.ImportRejected):
                    game.stage_import(source, self.root / 'imports')
                self.assertEqual(list((self.root / 'imports').iterdir()), [])
        self.assertFalse((self.root / 'escape').exists())

    def test_rejects_symlinks_and_duplicate_paths(self):
        link = zipfile.ZipInfo('link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entries in ([(link, b'outside')], [('PLAY.EXE', mz()), ('play.exe', mz())],
                        [('folder', b'x'), ('folder/game', b'x')]):
            with self.subTest(entries=entries):
                with self.assertRaises(game.ImportRejected):
                    game.stage_import(self.archive(entries), self.root / 'imports')
                self.assertEqual(list((self.root / 'imports').iterdir()), [])

    def test_central_directory_limits_apply_before_zipfile_allocation(self):
        source = self.archive([('a', b'a')])
        data = bytearray(source.read_bytes())
        end = data.rfind(b'PK\x05\x06')
        struct.pack_into('<HH', data, end + 8, 2, 2)
        source.write_bytes(data)
        with self.assertRaisesRegex(game.ImportRejected, 'entry count'):
            game.preflight_zip(source)

    def test_expansion_and_implicit_directory_limits(self):
        source = self.archive([('big', b'x' * 1001)])
        with patch.object(game, 'MAX_BYTES', 1000):
            with self.assertRaises(game.ImportRejected):
                game.stage_import(source, self.root / 'imports')
        source = self.archive([('a/b/c/d/game', b'x')])
        with patch.object(game, 'MAX_ENTRIES', 4):
            with self.assertRaises(game.ImportRejected):
                game.stage_import(source, self.root / 'imports')
        self.assertEqual(list((self.root / 'imports').iterdir()), [])

    def test_raw_folders_keep_empty_directories_and_companions(self):
        source = self.root / 'folder'
        (source / 'saves').mkdir(parents=True)
        (source / 'play.exe').write_bytes(mz())
        stage, zipped = game.stage_import(source, self.root / 'imports')
        self.assertFalse(zipped)
        self.assertTrue((stage / 'files/saves').is_dir())
        self.assertEqual((stage / 'files/play.exe').read_bytes(), mz())

    def test_dos_windows_and_extender_content(self):
        path = self.root / 'unknown.data'
        cases = [(mz(), 'DOS'), (mz(b'PE\0\0'), None), (mz(b'NE'), None),
                 (mz(b'LE', b'DOS/4GW'), 'DOS'), (mz(b'LX'), 'DOS?')]
        for data, expected in cases:
            path.write_bytes(data)
            self.assertEqual(game.dos_kind(path, data, len(data)), expected)
        short_dos_header = bytearray(mz(b'PE\0\0'))
        struct.pack_into('<H', short_dos_header, 8, 2)
        path.write_bytes(short_dos_header)
        self.assertIsNone(game.dos_kind(path, short_dos_header, len(short_dos_header)))
        path = self.root / 'game.com'
        self.assertEqual(game.dos_kind(path, b'\xb4\x4c\xcd\x21', 4), 'DOS?')
        self.assertIsNone(game.dos_kind(path, b'MZ', 2))
        self.assertIsNone(game.dos_kind(self.root / 'DOS4GW.EXE', mz(), 256))

    def test_shared_detector_defers_rom_and_scummvm_identity_to_the_engines(self):
        root, metadata = self.root / 'files', self.root / 'metadata'
        root.mkdir(); metadata.mkdir()
        (root / 'renamed.dat').write_bytes(b'NES\x1a' + bytes(32))
        (root / 'game.bin').write_bytes(mz())
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            if argv[0] == '/usr/bin/retro-run':
                return game.subprocess.CompletedProcess(argv, 0, 'nes\n', '')
            (metadata / 'scummvm.ini').write_text('[known-game]\ngameid=known\npath=' + str(root) + '\ndescription=Known title\n')
            return game.subprocess.CompletedProcess(argv, 0, '', '')
        choices = game.detect(root, metadata, run, available=lambda _path: True)
        self.assertEqual([c['argv'][0] for c in choices],
                         ['/usr/bin/dos-play', '/usr/bin/retro-run', '/usr/bin/scummvm'])
        self.assertIn('--identify', calls[0])
        self.assertIn('--recursive', calls[1])
        self.assertEqual(choices[-1]['argv'][-1], 'known-game')

    def test_detection_offers_only_installed_runtimes(self):
        root, metadata = self.root / 'files', self.root / 'metadata'
        root.mkdir(); metadata.mkdir()
        (root / 'game.exe').write_bytes(mz())
        (root / 'game.nes').write_bytes(b'NES\x1a' + bytes(32))
        def unexpected_run(*args, **kwargs):
            self.fail('an uninstalled detector must not be executed')
        choices = game.detect(root, metadata, unexpected_run,
                              available=lambda path: path == '/usr/bin/dos-play')
        self.assertEqual([c['argv'][0] for c in choices], ['/usr/bin/dos-play'])
        self.assertEqual(game.detect(root, metadata, unexpected_run,
                                     available=lambda _path: False), [])

    def test_ambiguous_and_mixed_content_needs_a_terminal_choice(self):
        choices = [{'label':'DOS?', 'argv':['dos'], 'choice':True},
                   {'label':'ROM', 'argv':['rom'], 'choice':False}]
        class Tty(io.StringIO):
            def isatty(self): return True
        with patch.object(game.sys, 'stdin', Tty('2\n')), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(game.choose(choices), choices[1])
        with patch.object(game.sys, 'stdin', io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(game.ImportRejected): game.choose(choices[:1])
        self.assertEqual(game.choose([choices[1]]), choices[1])

    def test_terminal_commands_quote_filenames_and_keep_picker_visible(self):
        argv = ['/usr/bin/dos-play', "/home/player/game's $(touch bad)/play.exe"]
        self.assertEqual(game.shlex.split(game.command_for({'argv': argv})), ['dos-play', argv[1]])
        source = self.archive([('PLAY.EXE', mz())])
        choices = [{'label': 'DOS', 'argv': argv, 'choice': False},
                   {'label': 'ROM', 'argv': ['retro-run', '/a'], 'choice': False}]
        with patch.dict(os.environ, {'XDG_DATA_HOME': str(self.root / 'data')}), patch.object(game, 'status'):
            with patch.object(game, 'detect', return_value=choices), patch.object(game, 'request_terminal', return_value=True) as request:
                self.assertEqual(game.main(['exchange', str(source)]), 0)
                self.assertFalse(request.call_args.args[1])
                self.assertTrue(request.call_args.args[0].startswith('game-play '))
            with patch.object(game, 'detect', return_value=choices[:1]), patch.object(game, 'request_terminal', return_value=True) as request:
                self.assertEqual(game.main(['exchange', str(source)]), 0)
                self.assertTrue(request.call_args.args[1])
                self.assertEqual(game.shlex.split(request.call_args.args[0]), ['dos-play', argv[1]])

    def test_streams_are_not_opened_as_game_files(self):
        source = self.root / 'stream'
        os.mkfifo(source)
        with self.assertRaises(game.NonFileInput):
            game.stage_import(source, self.root / 'imports')


if __name__ == '__main__':
    unittest.main(verbosity=2)
