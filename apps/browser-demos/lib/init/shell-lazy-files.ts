import {
  SHELL_LAZY_BINARY_SPECS,
  shellLazyPlaceholderUrl,
} from "../../../../images/vfs/lib/init/shell-binaries";

import coreutilsWasmUrl from "@binaries/programs/wasm32/coreutils.wasm?url";
import grepWasmUrl from "@binaries/programs/wasm32/grep.wasm?url";
import sedWasmUrl from "@binaries/programs/wasm32/sed.wasm?url";
import bcWasmUrl from "@binaries/programs/wasm32/bc.wasm?url";
import fileWasmUrl from "@binaries/programs/wasm32/file/file.wasm?url";
import lessWasmUrl from "@binaries/programs/wasm32/less.wasm?url";
import m4WasmUrl from "@binaries/programs/wasm32/m4.wasm?url";
import makeWasmUrl from "@binaries/programs/wasm32/make.wasm?url";
import tarWasmUrl from "@binaries/programs/wasm32/tar.wasm?url";
import curlWasmUrl from "@binaries/programs/wasm32/curl.wasm?url";
import ncWasmUrl from "@binaries/programs/wasm32/nc.wasm?url";
import wgetWasmUrl from "@binaries/programs/wasm32/wget.wasm?url";
import gitWasmUrl from "@binaries/programs/wasm32/git/git.wasm?url";
import gitRemoteHttpWasmUrl from "@binaries/programs/wasm32/git/git-remote-http.wasm?url";
import ffmpegWasmUrl from "@binaries/programs/wasm32/ffmpeg/ffmpeg.wasm?url";
import ffprobeWasmUrl from "@binaries/programs/wasm32/ffmpeg/ffprobe.wasm?url";
import ffplayWasmUrl from "@binaries/programs/wasm32/ffmpeg/ffplay.wasm?url";
import gzipWasmUrl from "@binaries/programs/wasm32/gzip.wasm?url";
import bzip2WasmUrl from "@binaries/programs/wasm32/bzip2.wasm?url";
import xzWasmUrl from "@binaries/programs/wasm32/xz.wasm?url";
import zstdWasmUrl from "@binaries/programs/wasm32/zstd.wasm?url";
import zipWasmUrl from "@binaries/programs/wasm32/zip.wasm?url";
import unzipWasmUrl from "@binaries/programs/wasm32/unzip.wasm?url";
import lsofWasmUrl from "@binaries/programs/wasm32/lsof.wasm?url";
import nanoWasmUrl from "@binaries/programs/wasm32/nano.wasm?url";
import sqlite3WasmUrl from "@binaries/programs/wasm32/sqlite3.wasm?url";
import lhaWasmUrl from "@binaries/programs/wasm32/lha.wasm?url";
import quakeWasmUrl from "@binaries/programs/wasm32/quake.wasm?url";
import footWasmUrl from "@binaries/programs/wasm32/foot.wasm?url";
import waybarWasmUrl from "@binaries/programs/wasm32/waybar.wasm?url";
import makoWasmUrl from "@binaries/programs/wasm32/mako/mako.wasm?url";
import dbusDaemonWasmUrl from "@binaries/programs/wasm32/dbus/dbus-daemon.wasm?url";
import qtgalleryWasmUrl from "@binaries/programs/wasm32/qtgallery.wasm?url";
import quickshellWasmUrl from "@binaries/programs/wasm32/quickshell.wasm?url";
import scummvmWasmUrl from "@binaries/programs/wasm32/scummvm/scummvm.wasm?url";
import scummvmRemasteredUrl from "@binaries/programs/wasm32/scummvm/share/scummvm/scummremastered.zip?url";
import scummvmModernUrl from "@binaries/programs/wasm32/scummvm/share/scummvm/scummmodern.zip?url";
import scummvmClassicUrl from "@binaries/programs/wasm32/scummvm/share/scummvm/scummclassic.zip?url";
import scummvmGuiIconsUrl from "@binaries/programs/wasm32/scummvm/share/scummvm/gui-icons.dat?url";
import scummvmFontsUrl from "@binaries/programs/wasm32/scummvm/share/scummvm/fonts.dat?url";
import scummvmEngineScummUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libscumm.so?url";
import scummvmEngineSkyUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libsky.so?url";
import scummvmEngineDrasculaUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libdrascula.so?url";
import scummvmEngineDreamwebUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libdreamweb.so?url";
import scummvmEngineQueenUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libqueen.so?url";
import scummvmEngineGotUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libgot.so?url";
import scummvmEngineGriffonUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libgriffon.so?url";
import scummvmEngineLureUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/liblure.so?url";
import scummvmEngineAdlUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libadl.so?url";
import scummvmEngineParallactionUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libparallaction.so?url";
import scummvmEngineCgeUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libcge.so?url";
import scummvmEngineCge2Url from "@binaries/programs/wasm32/scummvm/lib/scummvm/libcge2.so?url";
import scummvmEngineSludgeUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libsludge.so?url";
import scummvmEngineWageUrl from "@binaries/programs/wasm32/scummvm/lib/scummvm/libwage.so?url";
import wlcompositorWasmUrl from "@binaries/programs/wasm32/wayland-demo/wlcompositor.wasm?url";
import wltermWasmUrl from "@binaries/programs/wasm32/wayland-demo/wlterm.wasm?url";
import wlclockWasmUrl from "@binaries/programs/wasm32/wayland-demo/wlclock.wasm?url";
import wlpaintWasmUrl from "@binaries/programs/wasm32/wayland-demo/wlpaint.wasm?url";
import klauncherWasmUrl from "@binaries/programs/wasm32/wayland-demo/klauncher.wasm?url";
import notifySendWasmUrl from "@binaries/programs/wasm32/wayland-demo/notify-send.wasm?url";
import kclipdWasmUrl from "@binaries/programs/wasm32/wayland-demo/kclipd.wasm?url";
import sdl2WasmUrl from "@binaries/programs/wasm32/sdl2.wasm?url";
import fbdoomWasmUrl from "@binaries/programs/wasm32/fbdoom.wasm?url";
import modesetWasmUrl from "@binaries/programs/wasm32/modeset.wasm?url";
import espeakNgWasmUrl from "@binaries/programs/wasm32/espeak-ng/espeak-ng.wasm?url";
import elinksWasmUrl from "@binaries/programs/wasm32/elinks.wasm?url";

// Keyed by each spec's resolverPath -- the artifact the URL serves -- not by
// its id, so this artifact table cannot read as a table of machine profiles
// (scripts/check-pages-vfs-product-registry.mjs rejects those).
const SHELL_LAZY_ASSET_URLS: Record<
  (typeof SHELL_LAZY_BINARY_SPECS)[number]["resolverPath"],
  string
> = {
  "programs/coreutils.wasm": coreutilsWasmUrl,
  "programs/grep.wasm": grepWasmUrl,
  "programs/sed.wasm": sedWasmUrl,
  "programs/bc.wasm": bcWasmUrl,
  "programs/file/file.wasm": fileWasmUrl,
  "programs/less.wasm": lessWasmUrl,
  "programs/m4.wasm": m4WasmUrl,
  "programs/make.wasm": makeWasmUrl,
  "programs/tar.wasm": tarWasmUrl,
  "programs/curl.wasm": curlWasmUrl,
  "programs/nc.wasm": ncWasmUrl,
  "programs/wget.wasm": wgetWasmUrl,
  "programs/git/git.wasm": gitWasmUrl,
  "programs/git/git-remote-http.wasm": gitRemoteHttpWasmUrl,
  "programs/ffmpeg/ffmpeg.wasm": ffmpegWasmUrl,
  "programs/ffmpeg/ffprobe.wasm": ffprobeWasmUrl,
  "programs/ffmpeg/ffplay.wasm": ffplayWasmUrl,
  "programs/gzip.wasm": gzipWasmUrl,
  "programs/bzip2.wasm": bzip2WasmUrl,
  "programs/xz.wasm": xzWasmUrl,
  "programs/zstd.wasm": zstdWasmUrl,
  "programs/zip.wasm": zipWasmUrl,
  "programs/unzip.wasm": unzipWasmUrl,
  "programs/lsof.wasm": lsofWasmUrl,
  "programs/nano.wasm": nanoWasmUrl,
  "programs/sqlite3.wasm": sqlite3WasmUrl,
  "programs/lha.wasm": lhaWasmUrl,
  "programs/quake.wasm": quakeWasmUrl,
  "programs/foot.wasm": footWasmUrl,
  "programs/waybar.wasm": waybarWasmUrl,
  "programs/mako/mako.wasm": makoWasmUrl,
  "programs/dbus/dbus-daemon.wasm": dbusDaemonWasmUrl,
  "programs/qtgallery.wasm": qtgalleryWasmUrl,
  "programs/quickshell.wasm": quickshellWasmUrl,
  "programs/scummvm/scummvm.wasm": scummvmWasmUrl,
  "programs/scummvm/share/scummvm/scummremastered.zip": scummvmRemasteredUrl,
  "programs/scummvm/share/scummvm/scummmodern.zip": scummvmModernUrl,
  "programs/scummvm/share/scummvm/scummclassic.zip": scummvmClassicUrl,
  "programs/scummvm/share/scummvm/gui-icons.dat": scummvmGuiIconsUrl,
  "programs/scummvm/share/scummvm/fonts.dat": scummvmFontsUrl,
  "programs/scummvm/lib/scummvm/libscumm.so": scummvmEngineScummUrl,
  "programs/scummvm/lib/scummvm/libsky.so": scummvmEngineSkyUrl,
  "programs/scummvm/lib/scummvm/libdrascula.so": scummvmEngineDrasculaUrl,
  "programs/scummvm/lib/scummvm/libdreamweb.so": scummvmEngineDreamwebUrl,
  "programs/scummvm/lib/scummvm/libqueen.so": scummvmEngineQueenUrl,
  "programs/scummvm/lib/scummvm/libgot.so": scummvmEngineGotUrl,
  "programs/scummvm/lib/scummvm/libgriffon.so": scummvmEngineGriffonUrl,
  "programs/scummvm/lib/scummvm/liblure.so": scummvmEngineLureUrl,
  "programs/scummvm/lib/scummvm/libadl.so": scummvmEngineAdlUrl,
  "programs/scummvm/lib/scummvm/libparallaction.so": scummvmEngineParallactionUrl,
  "programs/scummvm/lib/scummvm/libcge.so": scummvmEngineCgeUrl,
  "programs/scummvm/lib/scummvm/libcge2.so": scummvmEngineCge2Url,
  "programs/scummvm/lib/scummvm/libsludge.so": scummvmEngineSludgeUrl,
  "programs/scummvm/lib/scummvm/libwage.so": scummvmEngineWageUrl,
  "programs/wayland-demo/wlcompositor.wasm": wlcompositorWasmUrl,
  "programs/wayland-demo/wlterm.wasm": wltermWasmUrl,
  "programs/wayland-demo/wlclock.wasm": wlclockWasmUrl,
  "programs/wayland-demo/wlpaint.wasm": wlpaintWasmUrl,
  "programs/wayland-demo/klauncher.wasm": klauncherWasmUrl,
  "programs/wayland-demo/notify-send.wasm": notifySendWasmUrl,
  "programs/wayland-demo/kclipd.wasm": kclipdWasmUrl,
  "programs/sdl2.wasm": sdl2WasmUrl,
  "programs/fbdoom.wasm": fbdoomWasmUrl,
  "programs/modeset.wasm": modesetWasmUrl,
  "programs/espeak-ng/espeak-ng.wasm": espeakNgWasmUrl,
  "programs/elinks.wasm": elinksWasmUrl,
};

export const SHELL_LAZY_PLACEHOLDER_URLS = new Map(
  SHELL_LAZY_BINARY_SPECS.map((spec) => [
    shellLazyPlaceholderUrl(spec),
    SHELL_LAZY_ASSET_URLS[spec.resolverPath],
  ]),
);

// `SHELL_LAZY_PLACEHOLDER_URLS` is the whole of what this module contributes:
// a table from the placeholder URL an image records to the asset URL this
// build serves. The image is never rewritten with it; the deployment applies
// it when the kernel worker fetches deferred bytes
// (`imageOwnedRuntimeUrlTable`).
