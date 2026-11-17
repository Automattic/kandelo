# Under policy CMP0164 (NEW from 3.30) Kandelo refuses SHARED libraries:
# a program cannot be linked against one.
cmake_minimum_required(VERSION 3.30)
project(shared_refused C)
add_library(counter SHARED counter.c)
