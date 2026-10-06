#!/usr/bin/env -S node --experimental-strip-types
import { compilerMain } from './cc.ts';
import { isMain } from '../lib/is-main.ts';

if (isMain(import.meta.url)) compilerMain((toolchain) => toolchain.cxx);
