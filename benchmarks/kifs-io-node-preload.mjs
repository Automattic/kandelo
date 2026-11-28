// Use --import for the measured Node process and its worker_threads.
import fs from "node:fs";
import { basename, dirname } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";
import { observeComputer } from "./kifs-io-observer.mjs";

if (!isMainThread) {
  const files = new Map();
  const computers = new Map();
  const { openSync, closeSync, fsyncSync, ftruncateSync, readSync, writeSync } = fs;
  fs.openSync = function (path, ...args) {
    const fd = openSync(path, ...args);
    const match = typeof path === "string" && /^computer(?:\.g[01]\.(volume|volume-seal|journal))?$/.exec(basename(path));
    if (match) {
      const name = basename(dirname(path));
      if (name.startsWith("kifs-saved-shell-")) {
        if (!computers.has(name)) computers.set(name, observeComputer(name));
        files.set(fd, { observer: computers.get(name), kind: match[1] });
      }
    }
    return fd;
  };
  fs.closeSync = function (fd) {
    const file = files.get(fd);
    if (file?.kind === "volume-seal") file.observer.endPreparation();
    files.delete(fd);
    return closeSync(fd);
  };
  fs.ftruncateSync = function (fd, length) {
    ftruncateSync(fd, length);
    const file = files.get(fd);
    if (file?.kind === "volume-seal" && length === 0) file.observer.beginPreparation();
  };
  fs.fsyncSync = function (fd) {
    const file = files.get(fd);
    return file && file.kind !== "volume-seal" ? file.observer.flush(() => fsyncSync(fd)) : fsyncSync(fd);
  };
  fs.readSync = function (fd, ...args) {
    const bytes = readSync(fd, ...args);
    const file = files.get(fd);
    if (file && file.kind !== "volume-seal") file.observer.read(bytes);
    return bytes;
  };
  fs.writeSync = function (fd, ...args) {
    const file = files.get(fd);
    if (file?.kind === "volume-seal") file.observer.endPreparation();
    const bytes = writeSync(fd, ...args);
    if (file && file.kind !== "volume-seal") {
      const position = args[3];
      file.observer.written(bytes, file.kind === "volume" && bytes === 168 && (position === 0 || position === 4096));
    }
    return bytes;
  };
  syncBuiltinESMExports();
}
