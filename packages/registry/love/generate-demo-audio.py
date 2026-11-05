#!/usr/bin/env python3
"""Generate original, deterministic mono PCM effects for the core LÖVE demos."""
import math
from pathlib import Path
import struct
import sys
import wave

RATE = 22050
# name: (start frequency, end frequency, duration seconds)
TONES = {
    "bounce": (650, 430, 0.065),
    "score": (380, 850, 0.20),
    "eat": (600, 1200, 0.10),
    "crash": (180, 45, 0.28),
    "brick": (1000, 500, 0.075),
    "shoot": (1500, 250, 0.09),
    "explode": (120, 30, 0.22),
}


def generate(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for name, (start, end, duration) in TONES.items():
        samples = bytearray()
        phase = 0.0
        count = round(duration * RATE)
        for index in range(count):
            progress = index / count
            phase += 2 * math.pi * (start + (end - start) * progress) / RATE
            envelope = min(1.0, index / (RATE * 0.004)) * (1 - progress) ** 2
            value = round(8000 * envelope * math.sin(phase))
            samples.extend(struct.pack("<h", value))
        with wave.open(str(destination / f"{name}.wav"), "wb") as output:
            output.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
            output.writeframes(samples)


if __name__ == "__main__":
    generate(Path(sys.argv[1]))
