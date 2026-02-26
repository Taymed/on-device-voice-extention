import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn, ChildProcess } from "child_process";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let recProcess: ChildProcess | undefined;
let currentTempFile: string | undefined;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = createStatusBar();
  context.subscriptions.push(statusBar);

  let panel: RecorderPanel | undefined;

  const command = vscode.commands.registerCommand(
    "voiceClaude.startRecording",
    () => {
      if (panel) {
        panel.reveal();
        return;
      }
      panel = new RecorderPanel(context, statusBar, () => {
        panel = undefined;
      });
    }
  );

  context.subscriptions.push(command);
}

export function deactivate(): void {
  killRec();
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

type StatusState = "idle" | "recording" | "transcribing";

function createStatusBar(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  item.command = "voiceClaude.startRecording";
  setStatus(item, "idle");
  item.show();
  return item;
}

function setStatus(item: vscode.StatusBarItem, state: StatusState): void {
  const labels: Record<StatusState, string> = {
    idle: "$(mic) Voice",
    recording: "$(circle-filled) Recording…",
    transcribing: "$(sync~spin) Transcribing…",
  };
  item.text = labels[state];
}

// ---------------------------------------------------------------------------
// Recorder Panel (Webview) — UI only, no mic access
// ---------------------------------------------------------------------------

class RecorderPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly onDispose: () => void;
  private readonly ctx: vscode.ExtensionContext;

  constructor(
    ctx: vscode.ExtensionContext,
    statusBar: vscode.StatusBarItem,
    onDispose: () => void
  ) {
    this.ctx = ctx;
    this.statusBar = statusBar;
    this.onDispose = onDispose;

    this.panel = vscode.window.createWebviewPanel(
      "voiceClaude",
      "Voice Recorder",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.webview.html = getWebviewHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      undefined,
      ctx.subscriptions
    );

    this.panel.onDidDispose(async () => {
      await killRec();
      setStatus(statusBar, "idle");
      this.onDispose();
    });
  }

  reveal(): void {
    this.panel.reveal();
  }

  private async handleMessage(msg: { type: string }): Promise<void> {
    switch (msg.type) {
      case "start-recording":
        this.startRecording();
        break;
      case "stop-recording":
        this.stopRecording();
        break;
    }
  }

  private startRecording(): void {
    // Check rec (SoX) is available
    const recBin = findRec();
    if (!recBin) {
      vscode.window.showErrorMessage(
        "SoX (rec) introuvable. Installez-le : brew install sox"
      );
      return;
    }

    currentTempFile = path.join(os.tmpdir(), `voice-claude-${Date.now()}.wav`);

    // rec: -r sample rate, -c channels, -b bits
    recProcess = spawn(recBin, [
      "-r", "16000",
      "-c", "1",
      "-b", "16",
      currentTempFile,
    ]);

    recProcess.on("error", (err) => {
      vscode.window.showErrorMessage(`Erreur rec : ${err.message}`);
      this.postToWebview("state", "idle");
    });

    setStatus(this.statusBar, "recording");
    this.postToWebview("state", "recording");
  }

  private async stopRecording(): Promise<void> {
    await killRec();

    if (!currentTempFile || !fs.existsSync(currentTempFile)) {
      vscode.window.showWarningMessage("Aucun audio enregistré.");
      this.postToWebview("state", "idle");
      setStatus(this.statusBar, "idle");
      return;
    }

    setStatus(this.statusBar, "transcribing");
    this.postToWebview("state", "transcribing");

    try {
      const text = await transcribeAudio(currentTempFile, this.ctx.extensionPath);
      await handleTranscription(text);
    } catch (err) {
      vscode.window.showErrorMessage(`Transcription échouée : ${err}`);
    } finally {
      cleanup(currentTempFile);
      currentTempFile = undefined;
      setStatus(this.statusBar, "idle");
      this.postToWebview("state", "idle");
    }
  }

  private postToWebview(type: string, value: string): void {
    this.panel.webview.postMessage({ type, value });
  }
}

// ---------------------------------------------------------------------------
// SoX helpers
// ---------------------------------------------------------------------------

function findRec(): string | undefined {
  const candidates = [
    "/opt/homebrew/bin/rec",
    "/usr/local/bin/rec",
    "/usr/bin/rec",
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function killRec(): Promise<void> {
  return new Promise((resolve) => {
    if (!recProcess || recProcess.killed) {
      resolve();
      return;
    }
    recProcess.on("close", () => {
      recProcess = undefined;
      resolve();
    });
    recProcess.kill("SIGINT"); // SIGINT lets rec flush & close the WAV properly
    // Safety timeout in case the process doesn't exit
    setTimeout(() => {
      if (recProcess && !recProcess.killed) {
        recProcess.kill("SIGKILL");
      }
      recProcess = undefined;
      resolve();
    }, 2000);
  });
}

function cleanup(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

const VENV_DIR = path.join(os.homedir(), ".voice-claude-code");

async function transcribeAudio(
  audioPath: string,
  extensionPath: string
): Promise<string> {
  const venvPython = path.join(VENV_DIR, ".venv", "bin", "python");
  if (!fs.existsSync(venvPython)) {
    const setup = [
      `mkdir -p ${VENV_DIR}`,
      `python3 -m venv ${path.join(VENV_DIR, ".venv")}`,
      `${venvPython.replace("python", "pip")} install faster-whisper`,
    ].join(" && ");
    throw new Error(
      `Le venv Python est manquant.\nCréez-le avec :\n  ${setup}`
    );
  }

  const scriptPath = path.join(extensionPath, "scripts", "transcribe.py");
  return runPython(venvPython, scriptPath, audioPath);
}

function runPython(
  pythonBin: string,
  scriptPath: string,
  audioPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, [scriptPath, audioPath]);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(stderr.trim() || `Script Python code retour ${code}`)
        );
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Impossible de lancer Python : ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Clipboard + notification
// ---------------------------------------------------------------------------

async function handleTranscription(text: string): Promise<void> {
  if (!text) {
    vscode.window.showWarningMessage("Aucune transcription détectée.");
    return;
  }
  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage(
    `Transcription copiée ! Faites Cmd+V dans Claude Code.`
  );
}

// ---------------------------------------------------------------------------
// Webview HTML — UI only, recording is done via SoX on the host
// ---------------------------------------------------------------------------

function getWebviewHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Voice Recorder</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 20px;
      padding: 24px;
    }

    h2 {
      font-size: 15px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    #btn-record {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      border: 3px solid var(--vscode-button-background, #0e639c);
      background: transparent;
      color: var(--vscode-button-background, #0e639c);
      font-size: 28px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    #btn-record:hover {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, white);
    }

    #btn-record.recording {
      background: #c0392b;
      border-color: #c0392b;
      color: white;
      animation: pulse 1.2s infinite;
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(192, 57, 43, 0.4); }
      50% { transform: scale(1.05); box-shadow: 0 0 0 10px rgba(192, 57, 43, 0); }
    }

    #btn-record:disabled {
      opacity: 0.5;
      cursor: wait;
      animation: none;
    }

    #status {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      min-height: 16px;
    }

    .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
      text-align: center;
    }

    .timer {
      font-size: 22px;
      font-variant-numeric: tabular-nums;
      color: var(--vscode-foreground);
      min-height: 28px;
    }
  </style>
</head>
<body>
  <h2>Voice to Claude Code</h2>

  <div class="timer" id="timer"></div>

  <button id="btn-record" title="Cliquez pour enregistrer">🎙</button>

  <div id="status">Prêt — cliquez pour enregistrer</div>

  <p class="hint">La transcription sera copiée dans le presse-papiers</p>

  <script>
    const vscode = acquireVsCodeApi();
    const btn = document.getElementById('btn-record');
    const statusEl = document.getElementById('status');
    const timerEl = document.getElementById('timer');

    let isRecording = false;
    let timerInterval = null;
    let startTime = 0;

    // Listen for state updates from extension host
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'state') {
        updateUI(msg.value);
      }
    });

    btn.addEventListener('click', () => {
      if (isRecording) {
        vscode.postMessage({ type: 'stop-recording' });
      } else {
        vscode.postMessage({ type: 'start-recording' });
      }
    });

    function updateUI(state) {
      switch (state) {
        case 'recording':
          isRecording = true;
          btn.classList.add('recording');
          btn.disabled = false;
          btn.textContent = '⏹';
          statusEl.textContent = 'Enregistrement…';
          startTimer();
          break;

        case 'transcribing':
          isRecording = false;
          btn.classList.remove('recording');
          btn.disabled = true;
          btn.textContent = '⏳';
          statusEl.textContent = 'Transcription en cours…';
          stopTimer();
          break;

        case 'idle':
        default:
          isRecording = false;
          btn.classList.remove('recording');
          btn.disabled = false;
          btn.textContent = '🎙';
          statusEl.textContent = 'Prêt — cliquez pour enregistrer';
          stopTimer();
          break;
      }
    }

    function startTimer() {
      startTime = Date.now();
      timerEl.textContent = '0:00';
      timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const min = Math.floor(elapsed / 60);
        const sec = String(elapsed % 60).padStart(2, '0');
        timerEl.textContent = min + ':' + sec;
      }, 200);
    }

    function stopTimer() {
      clearInterval(timerInterval);
      timerInterval = null;
      timerEl.textContent = '';
    }
  </script>
</body>
</html>`;
}
