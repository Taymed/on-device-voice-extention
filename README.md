# On device voice extention

Dictate text with your voice and send it directly to your active terminal (Claude Code, shell, etc.).
Transcription runs entirely on your machine using faster-whisper — no data leaves your computer.

## Features

- **One-click voice recording** — Open the recorder panel, click the mic, and speak
- **Local transcription** — Uses the Whisper `small` model running on your CPU, no cloud API needed
- **Direct terminal injection** — Transcribed text is sent to the active terminal via `sendText()`, no paste needed
- **Clipboard fallback** — Text is also copied to clipboard in case no terminal is active
- **Status bar indicator** — See the current state at a glance (idle, recording, transcribing)
- **Timer display** — Track your recording duration in real time

## Requirements

- **Python 3** — `brew install python3`
- **SoX** — `brew install sox`

## Quick Start

**1. Install SoX** (audio recording):

    brew install sox

**2. Set up the Python environment** (one-time):

    mkdir -p ~/.voice-claude-code
    python3 -m venv ~/.voice-claude-code/.venv
    ~/.voice-claude-code/.venv/bin/pip install faster-whisper

**3. Open VS Code**, press ⌘⌥R and start dictating!

> The first transcription downloads the Whisper model (~244 MB). After that, everything is instant.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Voice: Start Recording | ⌘⌥R | Open the voice recorder panel |

## Extension Settings

This extension has no configurable settings.
The keyboard shortcut can be changed in ⌘K ⌘S (Keyboard Shortcuts).

## Known Issues

- First transcription is slow due to model download (~244 MB)

## Release Notes

### 0.1.1

- Send transcription directly to the active terminal instead of clipboard-only
- Clipboard copy kept as fallback when no terminal is active

### 0.1.0

Initial release with voice recording, local transcription, and clipboard integration.


