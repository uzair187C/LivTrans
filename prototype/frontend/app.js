/**
 * Duet — Real-Time Voice Translation Client Engine (v4)
 * Architecture:
 * - Native hardware rate AudioContext (eliminates Chrome MediaStream silent zero bug)
 * - Anti-pruning audio graph with sub-audible gain anchor
 * - Continuous fractional resampler (native rate -> 16,000 Hz 16-bit linear PCM)
 * - Real-time peak telemetry & 60 FPS audio visualizer
 * - Auto-finalization on speech pause + instant test simulation
 */

// Application State
const state = {
  isListening: false,
  isConnected: false,
  isAudioPlaying: false,
  echoProtectionEnabled: true,
  outputMode: 'spoken', // 'spoken' | 'captions' | 'layered'
  region: 'Mexican',
  audioContext: null,
  mediaStream: null,
  dummyAudio: null,
  analyser: null,
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

const SAMPLE_PHRASES = [
  "Hey bro, where are you going tonight? Let's grab some tacos!",
  "Honestly that concert last night was totally lit, I had so much fun!",
  "No way dude, what a crazy mess happened over there!",
  "Can you help me out with this real quick my friend?"
];
let samplePhraseIdx = 0;

// Cached DOM References
let dom = {};

function initDOM() {
  dom = {
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    connectionPill: document.getElementById('connectionPill'),
    regionSelect: document.getElementById('regionSelect'),
    targetFlag: document.getElementById('targetFlag'),
    segmentButtons: document.querySelectorAll('.segment-btn'),
    conversationFeed: document.getElementById('conversationFeed'),
    emptyState: document.getElementById('emptyState'),
    quickSampleBtn: document.getElementById('quickSampleBtn'),
    liveBubble: document.getElementById('liveBubble'),
    liveStatusLabel: document.getElementById('liveStatusLabel'),
    livePartialText: document.getElementById('livePartialText'),
    pitchWaveCanvas: document.getElementById('pitchWaveCanvas'),
    micStatusText: document.getElementById('micStatusText'),
    micLiveDot: document.getElementById('micLiveDot'),
    micButton: document.getElementById('micButton'),
    micIcon: document.getElementById('micIcon'),
    stopIcon: document.getElementById('stopIcon'),
    latencyPill: document.getElementById('latencyPill'),
    testPhraseBtn: document.getElementById('testPhraseBtn'),
    toggleDiagBtn: document.getElementById('toggleDiagBtn'),
    closeDiagBtn: document.getElementById('closeDiagBtn'),
    diagModal: document.getElementById('diagModal'),
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

    while (dom.debugPanel.children.length > 90) {
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
  log(`Connecting to server: ${wsUrl}`, 'info');
  updateConnectionUI('disconnected', 'Connecting…');

  try {
    state.websocket = new WebSocket(wsUrl);
    state.websocket.binaryType = 'arraybuffer';

    state.websocket.onopen = () => {
      state.isConnected = true;
      log('WebSocket connected successfully ✓', 'ok');
      updateConnectionUI('connected', 'Connected');
      syncConfig();
    };

    state.websocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleServerPayload(data);
      } catch (err) {
        log(`Parse error: ${err.message}`, 'err');
      }
    };

    state.websocket.onclose = () => {
      state.isConnected = false;
      log('WebSocket disconnected. Auto-reconnecting in 3s…', 'warn');
      updateConnectionUI('disconnected', 'Offline');
      if (state.isListening) {
        stopRecording();
      }
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(initWebSocket, 3000);
    };

    state.websocket.onerror = () => {
      updateConnectionUI('error', 'Error');
    };
  } catch (err) {
    log(`WS error: ${err.message}`, 'err');
  }
}

function syncConfig() {
  if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
    state.websocket.send(JSON.stringify({
      type: 'config',
      region: state.region,
      outputMode: state.outputMode,
      enableVoiceOutput: state.outputMode !== 'captions',
      muteOriginal: state.outputMode === 'spoken'
    }));
  }
}

// -------------------------------------------------------------
// Server Event Routing
// -------------------------------------------------------------
function handleServerPayload(data) {
  switch (data.type) {
    case 'status':
      updateConnectionUI('connected', 'Ready');
      break;

    case 'speech_started':
      log('Speech detected by AssemblyAI 🗣️', 'ok');
      renderLivePartial('Hearing speech…', false);
      break;

    case 'partial_transcript':
      if (data.text) {
        renderLivePartial(data.text, false);
      }
      break;

    case 'final_transcript':
      if (data.text) {
        renderLivePartial(data.text, true);
        log(`Final: "${data.text}"`, 'ok');
      }
      break;

    case 'translating':
      if (dom.liveBubble) dom.liveBubble.style.display = 'block';
      if (dom.liveStatusLabel) dom.liveStatusLabel.textContent = 'Translating with Gemini…';
      if (dom.livePartialText && data.original) dom.livePartialText.textContent = data.original;
      break;

    case 'translation':
      hideLivePartial();
      log(`Translated: "${data.translated}" (${data.llmLatencyMs}ms)`, 'ok');
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
      }

      if (state.outputMode === 'captions') return;

      if (data.audioBase64) {
        log(`Playing ElevenLabs voice audio (${data.ttsLatencyMs}ms)…`, 'info');
        playAudioResponse(data.audioBase64);
      } else if (data.error && state.outputMode !== 'captions') {
        speakBrowserTTS(data.targetText || '', data.targetLanguage);
      }
      break;

    case 'error':
      log(`Server error: ${data.message}`, 'err');
      break;
  }
}

// -------------------------------------------------------------
// Audio Capture Engine (Native Rate + Resampling)
// -------------------------------------------------------------
async function startRecording() {
  if (state.isListening) return;

  log('Starting microphone capture…', 'info');

  try {
    if (!state.websocket || state.websocket.readyState !== WebSocket.OPEN) {
      initWebSocket();
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio API not supported');

    // CRITICAL FIX: Use native hardware sample rate.
    // Forcing 16000Hz on AudioContext with MediaStreamSource causes Chrome to output all zeroes!
    state.audioContext = new AudioCtx();
    if (state.audioContext.state === 'suspended') {
      await state.audioContext.resume();
    }

    const nativeRate = state.audioContext.sampleRate;
    log(`AudioContext active: ${nativeRate}Hz (State: ${state.audioContext.state})`, 'ok');

    // Request Microphone Stream
    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: state.echoProtectionEnabled,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (e) {
      log('Falling back to generic audio constraints', 'warn');
      state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    log('Microphone access granted ✓', 'ok');

    // Chromium Dummy Audio Trick: Forces the browser to keep microphone stream alive
    try {
      state.dummyAudio = document.createElement('audio');
      state.dummyAudio.srcObject = state.mediaStream;
      state.dummyAudio.muted = true;
      state.dummyAudio.play().catch(() => {});
    } catch (e) {}

    const source = state.audioContext.createMediaStreamSource(state.mediaStream);

    // Setup AnalyserNode for Visualizer
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 128;
    state.analyser.smoothingTimeConstant = 0.7;
    source.connect(state.analyser);

    startVisualizerLoop();

    // Inaudible Gain Node (-80dB) keeps audio rendering graph actively pulling frames
    state.gainNode = state.audioContext.createGain();
    state.gainNode.gain.value = 0.0001;
    state.gainNode.connect(state.audioContext.destination);

    // Universal rock-solid ScriptProcessorNode
    const bufferSize = 4096;
    state.scriptProcessor = state.audioContext.createScriptProcessor(bufferSize, 1, 1);

    state.scriptProcessor.onaudioprocess = (e) => {
      if (!state.isListening) return;

      const inputFloat32 = e.inputBuffer.getChannelData(0);

      // Measure Peak Volume to verify real voice vs digital silence
      let peak = 0;
      for (let i = 0; i < inputFloat32.length; i++) {
        const val = Math.abs(inputFloat32[i]);
        if (val > peak) peak = val;
      }

      // Convert float samples to 16,000Hz 16-bit linear PCM
      const pcm16 = resampleFloatTo16kPCM(inputFloat32, nativeRate);

      if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
        state.websocket.send(pcm16.buffer);
        state.packetsSent++;
        state.bytesSent += pcm16.buffer.byteLength;

        if (state.packetsSent === 1 || state.packetsSent % 40 === 0) {
          log(`Streaming: ${state.packetsSent} pkts (Peak: ${Math.round(peak * 100)}%)`, 'info');
          if (dom.latencyPill) {
            dom.latencyPill.textContent = `${state.packetsSent} pkts`;
          }
        }
      }
    };

    source.connect(state.scriptProcessor);
    state.scriptProcessor.connect(state.gainNode);

    state.isListening = true;
    state.packetsSent = 0;
    state.bytesSent = 0;

    updateMicUI(true);
    if (dom.micStatusText) dom.micStatusText.textContent = 'Listening (Speak now…)';

  } catch (err) {
    log(`Capture error: ${err.message}`, 'err');
    alert(`Microphone error: ${err.message}\nPlease check browser microphone permissions.`);
    stopRecording();
  }
}

function stopRecording() {
  state.isListening = false;
  updateMicUI(false);

  // Send turn finalization signal to server so any spoken words are translated immediately
  if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
    state.websocket.send(JSON.stringify({ type: 'finalize_turn' }));
    log('Sent turn finalization signal', 'info');
  }

  if (state.animFrameId) {
    cancelAnimationFrame(state.animFrameId);
    state.animFrameId = null;
  }
  drawIdleBaseline();

  if (dom.micStatusText) dom.micStatusText.textContent = 'Tap mic to speak';

  // Disconnect audio graph cleanly
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
  if (state.dummyAudio) {
    try { state.dummyAudio.pause(); state.dummyAudio.srcObject = null; } catch (e) {}
    state.dummyAudio = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(track => track.stop());
    state.mediaStream = null;
  }
  if (state.audioContext && state.audioContext.state !== 'closed') {
    state.audioContext.close().catch(() => {});
    state.audioContext = null;
  }

  log(`Capture stopped. Total frames: ${state.packetsSent}`, 'info');
}

// -------------------------------------------------------------
// Fractional Resampler (Native Hardware Rate -> 16,000 Hz PCM16)
// -------------------------------------------------------------
function resampleFloatTo16kPCM(inputFloat32, inRate) {
  if (inRate === 16000) {
    const pcm = new Int16Array(inputFloat32.length);
    for (let i = 0; i < inputFloat32.length; i++) {
      const s = Math.max(-1, Math.min(1, inputFloat32[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm;
  }

  const ratio = inRate / 16000;
  const outLength = Math.floor(inputFloat32.length / ratio);
  const pcm16 = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const i1 = Math.floor(srcIndex);
    const i2 = Math.min(i1 + 1, inputFloat32.length - 1);
    const frac = srcIndex - i1;
    const sample = inputFloat32[i1] * (1 - frac) + inputFloat32[i2] * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }
  return pcm16;
}

// -------------------------------------------------------------
// 60 FPS Sound Wave Visualizer
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
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function startVisualizerLoop() {
  if (!state.analyser || !dom.pitchWaveCanvas) return;

  const canvas = dom.pitchWaveCanvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const rect = canvas.getBoundingClientRect();
  canvas.width = (rect.width || 340) * dpr;
  canvas.height = (rect.height || 36) * dpr;
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

    // RMS Volume
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / bufferLength);

    if (dom.micStatusText && dom.micLiveDot) {
      const parent = dom.micStatusText.parentElement;
      if (rms > 0.015) {
        if (parent) parent.className = 'mic-telemetry hearing';
        dom.micStatusText.textContent = `Hearing voice (${Math.round(rms * 100)}%) 🗣️`;
      } else {
        if (parent) parent.className = 'mic-telemetry active';
        dom.micStatusText.textContent = 'Listening (Speak now…) 🎙️';
      }
    }

    ctx.clearRect(0, 0, w, h);

    const numBars = 26;
    const barWidth = Math.max(3, (w - (numBars - 1) * 3) / numBars);

    for (let i = 0; i < numBars; i++) {
      const freqIdx = Math.min(bufferLength - 1, Math.floor(i * (bufferLength / numBars)));
      const rawVal = freqData[freqIdx] || 0;
      const percent = rawVal / 255;
      const barHeight = Math.max(3, percent * (h - 6));

      const x = i * (barWidth + 3);
      const y = (h - barHeight) / 2;

      const hue = 220 + (i / numBars) * 45;
      if (percent > 0.12) {
        ctx.fillStyle = `hsla(${hue}, 90%, 65%, ${0.5 + percent * 0.5})`;
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
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
    log(`Playback error: ${err.message}`, 'err');
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
  const accentClass = isSpanish ? '' : 'es-accent';

  const card = document.createElement('div');
  card.className = 'turn-bubble';
  card.innerHTML = `
    <div class="turn-meta">
      <span class="turn-direction ${detectedLang}">
        ${flagSrc} ${detectedLang.toUpperCase()} → ${flagDst} ${targetLang.toUpperCase()}
      </span>
      <span class="turn-latency">${latencyMs ? `${latencyMs}ms` : ''}</span>
    </div>

    <div class="turn-source">${sanitize(original)}</div>

    <div class="turn-translated-box ${accentClass}">
      <div class="turn-translated-text">${sanitize(translated)}</div>
    </div>

    <div class="turn-actions">
      <button class="replay-audio-btn" data-text="${sanitize(translated)}" data-lang="${targetLang}">
        🔊 Replay
      </button>
    </div>
  `;

  card.querySelector('.replay-audio-btn').addEventListener('click', () => {
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
function updateConnectionUI(dotClass, text) {
  if (dom.statusDot) dom.statusDot.className = `conn-dot ${dotClass}`;
  if (dom.statusText) dom.statusText.textContent = text;
}

function updateMicUI(active) {
  if (!dom.micButton) return;
  if (active) {
    dom.micButton.className = 'main-record-btn active';
    if (dom.micIcon) dom.micIcon.style.display = 'none';
    if (dom.stopIcon) dom.stopIcon.style.display = 'block';
  } else {
    dom.micButton.className = 'main-record-btn idle';
    if (dom.micIcon) dom.micIcon.style.display = 'block';
    if (dom.stopIcon) dom.stopIcon.style.display = 'none';
  }
}

function triggerSamplePhrase() {
  getPlaybackContext();
  const phrase = SAMPLE_PHRASES[samplePhraseIdx % SAMPLE_PHRASES.length];
  samplePhraseIdx++;
  log(`Simulating phrase: "${phrase}"`, 'ok');

  if (dom.emptyState) dom.emptyState.style.display = 'none';
  renderLivePartial(phrase, true);

  if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
    state.websocket.send(JSON.stringify({
      type: 'simulate_turn',
      text: phrase
    }));
  } else {
    alert('Connecting to server… please try again in a moment.');
  }
}

// -------------------------------------------------------------
// Initialization & Listeners
// -------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  initDOM();
  drawIdleBaseline();

  log('Duet Audio Engine Initialized (v4)', 'ok');
  log(`Platform: Secure=${window.isSecureContext}, AudioCtx=${!!(window.AudioContext || window.webkitAudioContext)}`, 'info');

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

  // Mode Segment Buttons
  if (dom.segmentButtons) {
    dom.segmentButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        dom.segmentButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.outputMode = btn.dataset.mode;
        log(`Mode: ${state.outputMode}`, 'info');
        syncConfig();
      });
    });
  }

  // Quick Sample Buttons
  if (dom.quickSampleBtn) {
    dom.quickSampleBtn.addEventListener('click', triggerSamplePhrase);
  }
  if (dom.testPhraseBtn) {
    dom.testPhraseBtn.addEventListener('click', triggerSamplePhrase);
  }

  // Diagnostics Modal Toggle
  if (dom.toggleDiagBtn) {
    dom.toggleDiagBtn.addEventListener('click', () => {
      if (dom.diagModal) dom.diagModal.style.display = 'flex';
    });
  }
  if (dom.closeDiagBtn) {
    dom.closeDiagBtn.addEventListener('click', () => {
      if (dom.diagModal) dom.diagModal.style.display = 'none';
    });
  }

  // Canvas Resize
  window.addEventListener('resize', () => {
    if (!state.isListening) {
      drawIdleBaseline();
    }
  });

  initWebSocket();
});
