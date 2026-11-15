#!/usr/bin/env python3
"""
L'identité sonore d'Oathrion (11 novembre 2026) : deux sons courts, synthétisés ici, sans
échantillon venu d'ailleurs (pas de licence à suivre).

  · « oathrion » : une demande qui attend. Deux notes de verre qui montent d'une quinte (mi, si),
    puis un sceau grave et doux : le serment est posé.
  · « oathrion-danger » : un leurre lu, un agent mis en pause. Trois notes qui descendent par
    demi-tons, et deux battements graves : plus pressant, jamais agressif.

    python3 script/make-sounds.py client/public/sounds

écrit les .wav (l'ordinateur) ; les .mp3 (Telegram) en sont tirés avec GStreamer :

    gst-launch-1.0 filesrc location=oathrion.wav ! wavparse ! audioconvert \\
      ! lamemp3enc target=quality quality=2 ! id3v2mux ! filesink location=oathrion.mp3
"""
import math
import struct
import sys
import wave
from pathlib import Path

RATE = 44100


def bell(freq: float, start: float, length: float, gain: float, decay: float) -> list[tuple[float, float, float, float, float]]:
    """Une note de verre : la fondamentale et deux partiels un peu inharmoniques."""
    return [
        (freq, start, length, gain, decay),
        (freq * 2.004, start, length, gain * 0.32, decay * 1.6),
        (freq * 3.011, start, length, gain * 0.12, decay * 2.4),
    ]


def thump(freq: float, start: float, length: float, gain: float) -> list[tuple[float, float, float, float, float]]:
    """Le sceau : une note grave, une attaque douce, une queue courte."""
    return [(freq, start, length, gain, 7.0), (freq * 2, start, length, gain * 0.25, 10.0)]


def render(voices: list[tuple[float, float, float, float, float]], seconds: float) -> list[float]:
    out = [0.0] * int(RATE * seconds)
    for freq, start, length, gain, decay in voices:
        first = int(start * RATE)
        for i in range(int(length * RATE)):
            at = first + i
            if at >= len(out):
                break
            t = i / RATE
            attack = min(1.0, t / 0.006)
            out[at] += gain * attack * math.exp(-decay * t) * math.sin(2 * math.pi * freq * t)
    # une réverbération légère : trois échos atténués, pour l'air autour du verre
    wet = out[:]
    for delay, level in ((0.031, 0.22), (0.057, 0.14), (0.089, 0.08)):
        shift = int(delay * RATE)
        for i in range(shift, len(out)):
            wet[i] += out[i - shift] * level
    peak = max(abs(x) for x in wet) or 1.0
    fade = int(0.04 * RATE)
    return [x / peak * 0.7 * (min(1.0, (len(wet) - i) / fade)) for i, x in enumerate(wet)]


def write(path: Path, samples: list[float]) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1.0, min(1.0, x)) * 32767)) for x in samples))


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "client/public/sounds")
    out.mkdir(parents=True, exist_ok=True)
    E5, B5, E3 = 659.25, 987.77, 164.81
    ask = bell(E5, 0.0, 1.1, 0.55, 4.2) + bell(B5, 0.13, 1.0, 0.5, 4.6) + thump(E3, 0.30, 0.6, 0.45)
    write(out / "oathrion.wav", render(ask, 1.25))
    C6, B5n, AS5, F3 = 1046.5, 987.77, 932.33, 174.61
    danger = bell(C6, 0.0, 0.5, 0.5, 6.0) + bell(B5n, 0.11, 0.5, 0.5, 6.0) + bell(AS5, 0.22, 0.8, 0.55, 4.5) + thump(F3, 0.36, 0.4, 0.5) + thump(F3, 0.58, 0.5, 0.45)
    write(out / "oathrion-danger.wav", render(danger, 1.2))
    print(f"written: {out}/oathrion.wav, {out}/oathrion-danger.wav")


if __name__ == "__main__":
    main()
