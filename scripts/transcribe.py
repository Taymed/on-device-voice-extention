#!/usr/bin/env python3
"""
Transcription audio via faster-whisper.
Usage: python transcribe.py <audio_file>
Sortie : texte transcrit sur stdout
Code retour : 0 = succès, 1 = erreur
"""

import sys
import os


def main():
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]

    if not os.path.exists(audio_path):
        print(f"Erreur : fichier introuvable : {audio_path}", file=sys.stderr)
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel

        # Modèle small : ~244Mo, bon compromis vitesse/qualité
        # device="cpu" + compute_type="int8" pour compatibilité maximale
        model = WhisperModel("small", device="cpu", compute_type="int8")

        segments, _info = model.transcribe(audio_path, beam_size=5)

        text_parts = []
        for segment in segments:
            text_parts.append(segment.text.strip())

        result = " ".join(text_parts).strip()
        print(result)
        sys.exit(0)

    except ImportError:
        print(
            "Erreur : faster-whisper non installé. "
            "Lancez : .venv/bin/pip install faster-whisper",
            file=sys.stderr,
        )
        sys.exit(1)
    except Exception as e:
        print(f"Erreur de transcription : {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
