/**
 * Duet — Real-Time Voice Translation Client Engine
 * Complete bulletproof implementation:
 * - Dual Web Audio pipeline (AudioWorklet + ScriptProcessor fallback)
 * - Anti-pruning destination graph (prevents browser from muting/pausing capture)
 * - 16kHz PCM16 hardware downsampler
 * - 60 FPS pitch-responsive frequency canvas visualizer
 * - Real-time on-screen telemetry & diagnostics
 */

// Application State
const state = {
  isListening: false,
  isConnected: false,
  isAudioPlaying: false,
  echoProtectionEnabled: true,
  outputMode: 'spoken', // 'captions' | 'spoken' | 'layered'
  region: 'Mexican',
  audioContext: null,
  mediaStream: null,
  analyser: null,
  workletNode: null,
  scriptProcessor: null,
  gainNode: null,
  animFrameId: null,
  websocket: null,
  packetsSent: 0,
  bytesSent: 0,
  reconnectTimer: null
};

const REGION_FLAGS = {
  Mexican: '🇲🇽',
  Argentinian: '🇦🇷',
  Colombian: '🇨🇴',
  Caribbean: '🇵🇷',
  Spain: '🇪🇸',
  Peruvian: '🇵🇪',
  Neutral: '🌐'
};

// DOM References Cache
let dom = {};

function initDOM() {
  dom = {
    micButton: document.getElementById('micButton'),
    micButtonLabel: document.getElementById('micButtonLabel'),
    micIcon: document.getElementById('micIcon'),
    stopIcon: document.getElementById('stopIcon'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    latencyPill: document.getElementById('latencyPill'),
    regionSelect: document.getElementById('regionSelect'),
    targetFlag: document.getElementById('targetFlag'),
    modePills: document.querySelectorAll('.mode-pill'),
    echoCancelToggle: document.getElementById('echoCancelToggle'),
    conversationFeed: document.getElementById('conversationFeed'),
    emptyState: document.getElementById('emptyState'),
    liveBubble: document.getElementById('liveBubble'),
    liveStatusLabel: document.getElementById('liveStatusLabel'),
    livePartialText: document.getElementById('livePartialText'),
    pitchWaveCanvas: document.getElementById('pitchWaveCanvas'),
    micStatusRow: document.getElementById('micStatusRow'),
    micLiveDot: document.getElementById('micLiveDot'),
    micStatusText: document.getElementById('micStatusText'),
    debugPanel: document.getElementById('debugPanel')
  };
}

// -------------------------------------------------------------
// Diagnostics & Logging
// -------------------------------------------------------------
function log(msg, type = 'info') {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [${type.toUpperCase()}] ${msg}`);

  if (dom.debugPanel) {
    const el = document.createElement('div');
    el.className = `d-${type}`;
    el.textContent = `[${ts}] ${msg}`;
    dom.debugPanel.appendChild(el);
    dom.debugPanel.scrollTop = dom.debugPanel.scrollHeight;

    // Cap at 80 entries
    while (dom.debugPanel.children.length > 80) {
      dom.debugPanel.removeChild(dom.debugPanel.firstChild);
    }
  }
}

// -------------------------------------------------------------
// WebSocket Engine
// -------------------------------------------------------------
function initWebSocket() {
  if (state.websocket && (state.websocket.readyState === WebSocket.OPEN || state.websocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/live`;
  log(`Connecting to WebSocket: ${wsUrl}...`, 'info');
  updateStatus('disconnected', 'Connecting…');

  try {
    state.websocket = new WebSocket(wsUrl);
    state.websocket.binaryType = 'arraybuffer';

    state.websocket.onopen = () => {
      state.isConnected = true;
      log('WebSocket connected successfully ✓', 'ok');
      updateStatus('connected', 'Ready');
      syncConfig();
    };

    state.websocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleServerPayload(data);
      } catch (err) {
        log(`WebSocket JSON parse error: ${err.message}`, 'err');
      }
    };

    state.websocket.onclose = (event) => {
      state.isConnected = false;
      log(`WebSocket disconnected (code: ${event.code})`, 'warn');
      updateStatus('disconnected', 'Disconnected');
      if (state.isListening) {
        stopRecording();
      }
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(initWebSocket, 3000);
    };

    state.websocket.onerror = (err) => {
      log('WebSocket network error occurred', 'err');
      updateStatus('error', 'Network Error');
    };
  } catch (err) {
    log(`WebSocket creation failed: ${err.message}`, 'err');
  }
}

function syncConfig() {
  if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
    const payload = {
      type: 'config',
      region: state.region,
      outputMode: state.outputMode,
      enableVoiceOutput: state.outputMode !== 'captions',
      muteOriginal: state.outputMode === 'spoken'
    };
    state.websocket.send(JSON.stringify(payload));
    log(`Config synced: Region=${state.region}, Mode=${state.outputMode}`, 'info');
  }
}

// -------------------------------------------------------------
// Server Event Router
// -------------------------------------------------------------
function handleServerPayload(data) {
  switch (data.type) {
    case 'status':
      log(`Server status: ${data.message || data.status}`, 'ok');
      updateStatus('connected', 'Ready');
      break;

    case 'config_ack':
      log('Config acknowledged by server', 'ok');
      break;

    case 'partial_transcript':
      if (data.text) {
        renderLivePartial(data.text, false);
      }
      break;

    case 'final_transcript':
      if (data.text) {
        renderLivePartial(data.text, true);
        log(`Final transcript: "${data.text}"`, 'ok');
      }
      break;

    case 'translation':
      hideLivePartial();
      log(`Translation received: "${data.translated}" (${data.llmLatencyMs}ms)`, 'ok');
      appendTurnCard({
        original: data.original,
        translated: data.translated,
        detectedLang: data.detectedLanguage,
        targetLang: data.targetLanguage,
        latencyMs: data.llmLatencyMs
      });
      break;

    case 'audio':
      if (data.totalLatencyMs && dom.latencyPill) {
        dom.latencyPill.textContent = `${data.totalLatencyMs}ms`;
        dom.latencyPill.style.color = '#388bfd';
      }

      if (state.outputMode === 'captions') return;

      if (data.audioBase64) {
        log(`Playing ElevenLabs voice response (${data.ttsLatencyMs}ms TTS)...`, 'info');
        playAudioResponse(data.audioBase64);
      } else if (data.error && state.outputMode !== 'captions') {
        log(`TTS fallback to browser speech synthesis: ${data.error}`, 'warn');
        speakBrowserTTS(data.targetText || '', data.targetLanguage);
      }
      break;

    case 'error':
      log(`Server error [${data.source || 'unknown'}]: ${data.message}`, 'err');
      break;

    default:
      log(`Unhandled server message: ${JSON.stringify(data).substring(0, 80)}`, 'info');
  }
}

// -------------------------------------------------------------
// Audio Capture Engine
// -------------------------------------------------------------
async function startRecording() {
  if (state.isListening) return;

  log('Starting audio recording...', 'info');

  try {
    // 1. Ensure WebSocket is connected
    if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) {
      log('WebSocket not connected. Re-initiating connection...', 'warn');
      initWebSocket();
    }

    // 2. Initialize AudioContext on user interaction
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('Web Audio API is not supported in this browser.');
    }

    state.audioContext = new AudioCtx();
    if (state.audioContext.state === 'suspended') {
      await state.audioContext.resume();
    }

    log(`AudioContext created (SampleRate: ${state.audioContext.sampleRate}Hz, State: ${state.audioContext.state})`, 'ok');

    // 3. Request Microphone Access
    const constraints = {
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: state.echoProtectionEnabled,
        noiseSuppression: true,
        autoGainControl: true
      }
    };

    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (constraintErr) {
      log(`Strict audio constraints failed (${constraintErr.message}), falling back to {audio: true}`, 'warn');
      state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    log('Microphone access granted ✓', 'ok');

    const source = state.audioContext.createMediaStreamSource(state.mediaStream);
    const inRate = state.audioContext.sampleRate;
    const outRate = 16000;

    // 4. Setup AnalyserNode for Pitch & Volume Visualizer
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 128; // 64 frequency bins
    state.analyser.smoothingTimeConstant = 0.7;
    source.connect(state.analyser);

    // Start 60fps Visualizer animation
    startVisualizerLoop();

    // 5. Silent Gain Node (0 gain prevents audio feedback while keeping audio graph active)
    state.gainNode = state.audioContext.createGain();
    state.gainNode.gain.value = 0.0;
    state.gainNode.connect(state.audioContext.destination);

    // 6. Audio Processing Node: Try AudioWorklet first, then ScriptProcessor
    let workletReady = false;

    if (state.audioContext.audioWorklet) {
      try {
        const workletCode = `
          class LiveCaptureProcessor extends AudioWorkletProcessor {
            constructor() {
              super();
              this.buffer = new Float32Array(2048);
              this.offset = 0;
            }

            process(inputs) {
              const input = inputs[0];
              if (input && input[0]) {
                const samples = input[0];
                for (let i = 0; i < samples.length; i++) {
                  this.buffer[this.offset++] = samples[i];
                  if (this.offset >= 2048) {
                    this.port.postMessage(this.buffer.slice());
                    this.offset = 0;
                  }
                }
              }
              return true;
            }
          }
          registerProcessor('live-capture-processor', LiveCaptureProcessor);
        `;

        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        await state.audioContext.audioWorklet.addModule(blobUrl);
        URL.revokeObjectURL(blobUrl);

        state.workletNode = new AudioWorkletNode(state.audioContext, 'live-capture-processor');
        state.workletNode.port.onmessage = (e) => {
          handleIncomingSamples(e.data, inRate, outRate);
        };

        // Wire into graph: source -> workletNode -> gainNode -> destination
        source.connect(state.workletNode);
        state.workletNode.connect(state.gainNode);
        workletReady = true;
        log('AudioWorklet processor pipeline activated ✓', 'ok');
      } catch (workletErr) {
        log(`AudioWorklet unavailable (${workletErr.message}), falling back to ScriptProcessor`, 'warn');
      }
    }

    if (!workletReady) {
      // Fallback: ScriptProcessorNode (universal across all browsers)
      const bufferSize = 4096;
      state.scriptProcessor = state.audioContext.createScriptProcessor(bufferSize, 1, 1);
      state.scriptProcessor.onaudioprocess = (e) => {
        const channel = e.inputBuffer.getChannelData(0);
        handleIncomingSamples(channel, inRate, outRate);
      };

      source.connect(state.scriptProcessor);
      state.scriptProcessor.connect(state.gainNode);
      log('ScriptProcessor fallback pipeline activated ✓', 'ok');
    }

    state.isListening = true;
    state.packetsSent = 0;
    state.bytesSent = 0;

    updateMicUI(true);
    updateStatus('listening', 'Listening…');
    if (dom.micStatusRow) dom.micStatusRow.className = 'mic-status active';
    if (dom.micStatusText) dom.micStatusText.textContent = 'Listening (Speak now…)';

  } catch (err) {
    log(`Failed to start recording: ${err.message}`, 'err');
    alert(`Microphone error: ${err.message}\nPlease ensure microphone permission is granted.`);
    stopRecording();
  }
}

function handleIncomingSamples(floatSamples, inRate, outRate) {
  if (!state.isListening) return;

  // Echo Shield: Pause mic streaming during spoken audio playback
  if (state.isAudioPlaying && state.echoProtectionEnabled && state.outputMode === 'spoken') {
    return;
  }

  // Downsample to 16,000 Hz 16-bit PCM
  const pcm16 = downsampleToPCM16(floatSamples, inRate, outRate);

  if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
    state.websocket.send(pcm16.buffer);
    state.packetsSent++;
    state.bytesSent += pcm16.buffer.byteLength;

    if (state.packetsSent === 1 || state.packetsSent % 30 === 0) {
      log(`Audio streaming: ${state.packetsSent} packets (${Math.round(state.bytesSent / 1024)} KB sent)`, 'info');
      if (dom.latencyPill && state.packetsSent % 60 === 0) {
        dom.latencyPill.textContent = `${state.packetsSent} pkts`;
      }
    }
  }
}

function stopRecording() {
  state.isListening = false;
  updateMicUI(false);
  updateStatus(state.isConnected ? 'connected' : 'disconnected', state.isConnected ? 'Ready' : 'Offline');

  if (state.animFrameId) {
    cancelAnimationFrame(state.animFrameId);
    state.animFrameId = null;
  }
  drawIdleBaseline();

  if (dom.micStatusRow) dom.micStatusRow.className = 'mic-status';
  if (dom.micStatusText) dom.micStatusText.textContent = 'Tap Start to begin';

  // Disconnect audio nodes
  if (state.workletNode) {
    try { state.workletNode.disconnect(); } catch (e) {}
    state.workletNode = null;
  }
  if (state.scriptProcessor) {
    try { state.scriptProcessor.disconnect(); } catch (e) {}
    state.scriptProcessor = null;
  }
  if (state.gainNode) {
    try { state.gainNode.disconnect(); } catch (e) {}
    state.gainNode = null;
  }
  if (state.analyser) {
    try { state.analyser.disconnect(); } catch (e) {}
    state.analyser = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(track => track.stop());
    state.mediaStream = null;
  }
  if (state.audioContext && state.audioContext.state !== 'closed') {
    state.audioContext.close().catch(() => {});
    state.audioContext = null;
  }

  hideLivePartial();
  log(`Recording stopped. Total packets transmitted: ${state.packetsSent}`, 'info');
}

// -------------------------------------------------------------
// Linear Interpolation Downsampler (Any input rate -> 16kHz PCM16)
// -------------------------------------------------------------
function downsampleToPCM16(buffer, inRate, outRate = 16000) {
  if (inRate === outRate) {
    const pcm = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      const s = Math.max(-1, Math.min(1, buffer[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm;
  }

  const ratio = inRate / outRate;
  const outLength = Math.round(buffer.length / ratio);
  const pcm16 = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const i1 = Math.floor(srcIndex);
    const i2 = Math.min(i1 + 1, buffer.length - 1);
    const frac = srcIndex - i1;
    const sample = buffer[i1] * (1 - frac) + buffer[i2] * frac;
    const s = Math.max(-1, Math.min(1, sample));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcm16;
}

// -------------------------------------------------------------
// 60 FPS Pitch-Responsive Wave Visualizer
// -------------------------------------------------------------
function drawIdleBaseline() {
  if (!dom.pitchWaveCanvas) return;
  const canvas = dom.pitchWaveCanvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.strokeStyle = 'rgba(240, 246, 252, 0.12)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function startVisualizerLoop() {
  if (!state.analyser || !dom.pitchWaveCanvas) return;

  const canvas = dom.pitchWaveCanvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Responsive DPI sizing
  const rect = canvas.getBoundingClientRect();
  canvas.width = (rect.width || 360) * dpr;
  canvas.height = (rect.height || 48) * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  const bufferLength = state.analyser.frequencyBinCount;
  const freqData = new Uint8Array(bufferLength);
  const timeData = new Uint8Array(bufferLength);

  function draw() {
    if (!state.isListening) {
      drawIdleBaseline();
      return;
    }

    state.animFrameId = requestAnimationFrame(draw);

    state.analyser.getByteFrequencyData(freqData);
    state.analyser.getByteTimeDomainData(timeData);

    // Calculate RMS volume
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / bufferLength);

    // Update real-time mic indicator
    if (dom.micStatusRow && dom.micStatusText) {
      if (rms > 0.02) {
        dom.micStatusRow.className = 'mic-status hearing';
        dom.micStatusText.textContent = `Hearing voice (${Math.round(rms * 100)}%) 🗣️`;
      } else {
        dom.micStatusRow.className = 'mic-status active';
        dom.micStatusText.textContent = 'Listening (Speak now…) 🎙️';
      }
    }

    // Clear Canvas
    ctx.clearRect(0, 0, w, h);

    // Render 28 pitch-distributed frequency bars
    const numBars = 28;
    const barWidth = Math.max(3, (w - (numBars - 1) * 3) / numBars);

    for (let i = 0; i < numBars; i++) {
      const freqIdx = Math.min(bufferLength - 1, Math.floor(i * (bufferLength / numBars)));
      const rawVal = freqData[freqIdx] || 0;
      const percent = rawVal / 255;
      const barHeight = Math.max(3, percent * (h - 6));

      const x = i * (barWidth + 3);
      const y = (h - barHeight) / 2;

      // Color shifts with pitch: Cyan (bass) -> Electric Blue (voice) -> Purple (treble)
      const hue = 195 + (i / numBars) * 60; // 195 (cyan) to 255 (indigo)
      if (percent > 0.12) {
        ctx.fillStyle = `hsla(${hue}, 90%, 65%, ${0.5 + percent * 0.5})`;
      } else {
        ctx.fillStyle = 'rgba(240, 246, 252, 0.12)';
      }

      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, barWidth, barHeight, 2);
      } else {
        ctx.rect(x, y, barWidth, barHeight);
      }
      ctx.fill();
    }
  }

  draw();
}

// -------------------------------------------------------------
// Audio Playback Engine (TTS)
// -------------------------------------------------------------
let playbackAudioCtx = null;
function getPlaybackContext() {
  if (!playbackAudioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    playbackAudioCtx = new AudioCtx();
  }
  if (playbackAudioCtx.state === 'suspended') {
    playbackAudioCtx.resume();
  }
  return playbackAudioCtx;
}

async function playAudioResponse(base64Data) {
  if (state.outputMode === 'captions') return;

  try {
    const ctx = getPlaybackContext();
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    if (state.echoProtectionEnabled && state.outputMode === 'spoken') {
      state.isAudioPlaying = true;
    }

    source.onended = () => {
      setTimeout(() => {
        state.isAudioPlaying = false;
      }, 120);
    };

    source.start(0);
  } catch (err) {
    log(`Audio playback error: ${err.message}`, 'err');
    state.isAudioPlaying = false;
  }
}

function speakBrowserTTS(text, lang) {
  if (state.outputMode === 'captions' || !('speechSynthesis' in window) || !text) return;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang === 'es' ? 'es-MX' : 'en-US';
  utterance.rate = 1.0;

  if (state.echoProtectionEnabled && state.outputMode === 'spoken') {
    state.isAudioPlaying = true;
  }

  utterance.onend = () => {
    setTimeout(() => {
      state.isAudioPlaying = false;
    }, 100);
  };

  utterance.onerror = () => {
    state.isAudioPlaying = false;
  };

  window.speechSynthesis.speak(utterance);
}

// -------------------------------------------------------------
// Feed Rendering
// -------------------------------------------------------------
function renderLivePartial(text, isFinal = false) {
  if (!text) return;
  if (dom.emptyState) dom.emptyState.style.display = 'none';
  if (dom.liveBubble) {
    dom.liveBubble.style.display = 'block';
    if (dom.liveStatusLabel) dom.liveStatusLabel.textContent = isFinal ? 'Translating…' : 'Listening…';
    if (dom.livePartialText) dom.livePartialText.textContent = text;
  }
  if (dom.conversationFeed) {
    dom.conversationFeed.scrollTop = dom.conversationFeed.scrollHeight;
  }
}

function hideLivePartial() {
  if (dom.liveBubble) dom.liveBubble.style.display = 'none';
  if (dom.livePartialText) dom.livePartialText.textContent = '…';
}

function appendTurnCard({ original, translated, detectedLang, targetLang, latencyMs }) {
  if (dom.emptyState) dom.emptyState.style.display = 'none';
  if (!dom.conversationFeed) return;

  const isSpanish = detectedLang === 'es';
  const flagSrc = isSpanish ? (REGION_FLAGS[state.region] || '🇲🇽') : '🇺🇸';
  const flagDst = isSpanish ? '🇺🇸' : (REGION_FLAGS[state.region] || '🇲🇽');
  const accentClass = isSpanish ? '' : 'es-target';

  const card = document.createElement('div');
  card.className = 'turn-card';
  card.innerHTML = `
    <div class="turn-meta">
      <span class="turn-badge ${detectedLang}">
        ${flagSrc} ${detectedLang.toUpperCase()} → ${flagDst} ${targetLang.toUpperCase()}
      </span>
      <span class="turn-time">${latencyMs ? `${latencyMs}ms` : ''}</span>
    </div>

    <div class="turn-original">${sanitize(original)}</div>

    <div class="turn-translated ${accentClass}">
      <div class="turn-translated-text">${sanitize(translated)}</div>
    </div>

    <div class="turn-actions">
      <button class="replay-btn" data-text="${sanitize(translated)}" data-lang="${targetLang}">
        🔊 Replay
      </button>
    </div>
  `;

  card.querySelector('.replay-btn').addEventListener('click', () => {
    speakBrowserTTS(translated, targetLang);
  });

  dom.conversationFeed.appendChild(card);
  dom.conversationFeed.scrollTop = dom.conversationFeed.scrollHeight;
}

function sanitize(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// -------------------------------------------------------------
// UI State Updates
// -------------------------------------------------------------
function updateStatus(dotClass, text) {
  if (dom.statusDot) dom.statusDot.className = `status-dot ${dotClass}`;
  if (dom.statusText) dom.statusText.textContent = text;
}

function updateMicUI(active) {
  if (!dom.micButton) return;
  if (active) {
    dom.micButton.className = 'mic-btn active';
    if (dom.micButtonLabel) dom.micButtonLabel.textContent = 'Pause Conversation';
    if (dom.micIcon) dom.micIcon.style.display = 'none';
    if (dom.stopIcon) dom.stopIcon.style.display = 'block';
  } else {
    dom.micButton.className = 'mic-btn idle';
    if (dom.micButtonLabel) dom.micButtonLabel.textContent = 'Start Conversation';
    if (dom.micIcon) dom.micIcon.style.display = 'block';
    if (dom.stopIcon) dom.stopIcon.style.display = 'none';
  }
}

// -------------------------------------------------------------
// Event Listeners & Initialization
// -------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  initDOM();
  drawIdleBaseline();

  log('Duet Translation Client initialized', 'ok');
  log(`Context: Secure=${window.isSecureContext}, AudioWorklet=${!!window.AudioWorklet}`, 'info');

  // Mic Button Click
  if (dom.micButton) {
    dom.micButton.addEventListener('click', () => {
      getPlaybackContext();
      if (state.isListening) {
        stopRecording();
      } else {
        startRecording();
      }
    });
  }

  // Dialect Selector Change
  if (dom.regionSelect) {
    dom.regionSelect.addEventListener('change', (e) => {
      state.region = e.target.value;
      if (dom.targetFlag) {
        dom.targetFlag.textContent = REGION_FLAGS[state.region] || '🇲🇽';
      }
      syncConfig();
    });
  }

  // Mode Pill Buttons
  if (dom.modePills) {
    dom.modePills.forEach(btn => {
      btn.addEventListener('click', () => {
        dom.modePills.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.outputMode = btn.dataset.mode;
        log(`Output mode set to: ${state.outputMode}`, 'info');
        syncConfig();
      });
    });
  }

  // Echo Protection Toggle
  if (dom.echoCancelToggle) {
    dom.echoCancelToggle.addEventListener('change', (e) => {
      state.echoProtectionEnabled = e.target.checked;
      log(`Echo Shield: ${state.echoProtectionEnabled ? 'ENABLED' : 'DISABLED'}`, 'info');
    });
  }

  // Handle window resize for canvas DPR
  window.addEventListener('resize', () => {
    if (!state.isListening) {
      drawIdleBaseline();
    }
  });

  // Start WebSocket connection
  initWebSocket();
});
