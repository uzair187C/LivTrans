/**
 * Duet — Live Voice Translation Client Engine (v2)
 * Features:
 * - Dual audio capture: High-performance AudioWorklet with ScriptProcessor fallback
 * - Hardware AnalyserNode with 60 FPS Pitch & Frequency Wave Visualizer
 * - Real-time device sample rate downsampler (e.g. 48kHz -> 16kHz PCM16)
 * - Acoustic Echo Cancellation protection & 3-Way Mode control
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
  websocket: null
};

// Dialect to Flag mapping
const REGION_FLAGS = {
  Mexican: '🇲🇽',
  Peruvian: '🇵🇪',
  Argentinian: '🇦🇷',
  Colombian: '🇨🇴',
  Caribbean: '🇵🇷',
  Spain: '🇪🇸',
  Neutral: '🌐'
};

// DOM References
const micButton = document.getElementById('micButton');
const micButtonLabel = document.getElementById('micButtonLabel');
const micIcon = document.getElementById('micIcon');
const stopIcon = document.getElementById('stopIcon');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const latencyPill = document.getElementById('latencyPill');
const regionSelect = document.getElementById('regionSelect');
const targetFlag = document.getElementById('targetFlag');
const modeButtons = document.querySelectorAll('.mode-pill-btn');
const echoCancelToggle = document.getElementById('echoCancelToggle');
const conversationFeed = document.getElementById('conversationFeed');
const emptyState = document.getElementById('emptyState');
const liveBubble = document.getElementById('liveBubble');
const liveStatusLabel = document.getElementById('liveStatusLabel');
const livePartialText = document.getElementById('livePartialText');
const pitchWaveCanvas = document.getElementById('pitchWaveCanvas');
const micStatusRow = document.getElementById('micStatusRow');
const micLiveDot = document.getElementById('micLiveDot');
const micStatusText = document.getElementById('micStatusText');

// Canvas Context for Pitch Waves
let canvasCtx = null;
if (pitchWaveCanvas) {
  canvasCtx = pitchWaveCanvas.getContext('2d');
  // High-DPI scaling
  const dpr = window.devicePixelRatio || 1;
  const rect = pitchWaveCanvas.getBoundingClientRect();
  pitchWaveCanvas.width = (rect.width || 360) * dpr;
  pitchWaveCanvas.height = (rect.height || 48) * dpr;
  if (canvasCtx) canvasCtx.scale(dpr, dpr);
}

// Draw idle baseline on canvas
function drawIdleCanvas() {
  if (!canvasCtx || !pitchWaveCanvas) return;
  const w = pitchWaveCanvas.width / (window.devicePixelRatio || 1);
  const h = pitchWaveCanvas.height / (window.devicePixelRatio || 1);
  canvasCtx.clearRect(0, 0, w, h);
  
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, h / 2);
  canvasCtx.lineTo(w, h / 2);
  canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  canvasCtx.lineWidth = 1.5;
  canvasCtx.stroke();
}
drawIdleCanvas();

// Playback Web Audio Context
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

// -------------------------------------------------------------
// WebSocket Connection
// -------------------------------------------------------------
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/live`;

  updateStatus('disconnected', 'Connecting...');
  
  try {
    state.websocket = new WebSocket(wsUrl);
    state.websocket.binaryType = 'arraybuffer';

    state.websocket.onopen = () => {
      state.isConnected = true;
      updateStatus('connected', 'Ready');
      syncConfig();
    };

    state.websocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleServerPayload(data);
      } catch (e) {
        console.error('[WS Parse Error]', e);
      }
    };

    state.websocket.onclose = () => {
      state.isConnected = false;
      updateStatus('disconnected', 'Offline');
      if (state.isListening) {
        stopRecording();
      }
      setTimeout(initWebSocket, 3000);
    };

    state.websocket.onerror = (err) => {
      console.warn('[WS Error]', err);
      updateStatus('disconnected', 'Error');
    };
  } catch (err) {
    console.error('[WS Init Error]', err);
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
// Handle Incoming Server Events
// -------------------------------------------------------------
function handleServerPayload(data) {
  switch (data.type) {
    case 'status':
      updateStatus('connected', 'Ready');
      break;

    case 'partial_transcript':
      renderLivePartial(data.text, false);
      break;

    case 'final_transcript':
      renderLivePartial(data.text, true);
      break;

    case 'translation':
      hideLivePartial();
      appendTurnCard({
        original: data.original,
        translated: data.translated,
        detectedLang: data.detectedLanguage,
        targetLang: data.targetLanguage,
        latencyMs: data.llmLatencyMs
      });
      break;

    case 'audio':
      if (data.totalLatencyMs) {
        latencyPill.textContent = `${data.totalLatencyMs} ms`;
        latencyPill.style.color = '#388bfd';
      }

      if (state.outputMode === 'captions') return;

      if (data.audioBase64) {
        streamAudioPlayback(data.audioBase64);
      } else if (data.error && state.outputMode !== 'captions') {
        speakBrowserTTS(data.targetText || '', data.targetLanguage);
      }
      break;

    case 'error':
      console.error('[Server Error]', data);
      break;
  }
}

// -------------------------------------------------------------
// Audio Capture & Pitch-Responsive Sound Wave Visualizer
// -------------------------------------------------------------
async function startRecording() {
  try {
    getPlaybackContext();

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioCtx();
    await state.audioContext.resume();

    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: state.echoProtectionEnabled,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const source = state.audioContext.createMediaStreamSource(state.mediaStream);
    const inRate = state.audioContext.sampleRate;
    const outRate = 16000;

    // 1. Setup AnalyserNode for Pitch & Frequency Waves
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 64; // 32 frequency bins
    state.analyser.smoothingTimeConstant = 0.75;
    source.connect(state.analyser);

    // 2. Start Visualizer Animation Loop
    startVisualizerLoop();

    // 3. Audio Extraction: Try AudioWorklet first, then ScriptProcessor fallback
    let workletSuccess = false;
    if (state.audioContext.audioWorklet) {
      try {
        const workletCode = `
          class LiveRecorderProcessor extends AudioWorkletProcessor {
            process(inputs) {
              const input = inputs[0];
              if (input && input[0]) {
                this.port.postMessage(input[0]);
              }
              return true;
            }
          }
          registerProcessor('live-recorder-processor', LiveRecorderProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await state.audioContext.audioWorklet.addModule(url);
        
        state.workletNode = new AudioWorkletNode(state.audioContext, 'live-recorder-processor');
        state.workletNode.port.onmessage = (e) => {
          handleAudioData(e.data, inRate, outRate);
        };
        source.connect(state.workletNode);
        workletSuccess = true;
        console.log('[Audio] AudioWorklet recording pipeline active.');
      } catch (workletErr) {
        console.warn('[Audio] AudioWorklet init failed, falling back to ScriptProcessor:', workletErr);
      }
    }

    if (!workletSuccess) {
      const bufferSize = 4096;
      state.scriptProcessor = state.audioContext.createScriptProcessor(bufferSize, 1, 1);
      
      // Inaudible non-zero gain node (0.00001) prevents WebKit from pruning dead audio graph branches
      state.gainNode = state.audioContext.createGain();
      state.gainNode.gain.value = 0.00001;

      state.scriptProcessor.onaudioprocess = (e) => {
        const floatData = e.inputBuffer.getChannelData(0);
        handleAudioData(floatData, inRate, outRate);
      };

      source.connect(state.scriptProcessor);
      state.scriptProcessor.connect(state.gainNode);
      state.gainNode.connect(state.audioContext.destination);
      console.log('[Audio] ScriptProcessor recording pipeline active.');
    }

    state.isListening = true;
    updateMicUI(true);
    updateStatus('listening', 'Listening');
    if (micStatusRow) micStatusRow.className = 'mic-status-row active';
    if (micStatusText) micStatusText.textContent = 'Mic active (Listening for speech...)';

  } catch (err) {
    console.error('[Recording Error]', err);
    alert(`Microphone error: ${err.message}\nPlease ensure microphone permission is granted in browser settings.`);
    stopRecording();
  }
}

function handleAudioData(channelData, inRate, outRate) {
  if (!state.isListening) return;

  // Echo Shield: Pause mic frames during spoken translation playback
  if (state.isAudioPlaying && state.echoProtectionEnabled && state.outputMode === 'spoken') {
    return;
  }

  // Downsample to 16,000 Hz 16-bit PCM
  const pcm16 = downsampleToPCM16(channelData, inRate, outRate);

  // Send binary audio frame over WebSocket
  if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
    state.websocket.send(pcm16.buffer);
  }
}

// Real-time Pitch & Frequency Wave Visualizer Loop (60 FPS)
function startVisualizerLoop() {
  if (!state.analyser || !canvasCtx || !pitchWaveCanvas) return;

  const bufferLength = state.analyser.frequencyBinCount;
  const freqData = new Uint8Array(bufferLength);
  const timeData = new Uint8Array(bufferLength);

  const w = pitchWaveCanvas.width / (window.devicePixelRatio || 1);
  const h = pitchWaveCanvas.height / (window.devicePixelRatio || 1);

  function draw() {
    if (!state.isListening) {
      drawIdleCanvas();
      return;
    }

    state.animFrameId = requestAnimationFrame(draw);

    state.analyser.getByteFrequencyData(freqData);
    state.analyser.getByteTimeDomainData(timeData);

    // Compute average amplitude for status badge
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) {
      sum += freqData[i];
    }
    const avgVolume = sum / bufferLength;

    if (micStatusRow && micStatusText) {
      if (avgVolume > 12) {
        micStatusRow.className = 'mic-status-row hearing';
        micStatusText.textContent = `Hearing speech (Vol: ${Math.round(avgVolume)}%) 🗣️`;
      } else {
        micStatusRow.className = 'mic-status-row active';
        micStatusText.textContent = 'Listening (Speak in EN or ES...)';
      }
    }

    // Clear Canvas
    canvasCtx.clearRect(0, 0, w, h);

    // Draw Frequency Bars (Responsive to pitch: low pitch = left, high pitch = right)
    const numBars = 24;
    const barWidth = Math.max(3, (w - (numBars - 1) * 3) / numBars);
    
    for (let i = 0; i < numBars; i++) {
      const freqIndex = Math.min(bufferLength - 1, Math.floor(i * (bufferLength / numBars)));
      const value = freqData[freqIndex] || 0;
      const percent = value / 255;
      const barHeight = Math.max(3, percent * (h - 6));

      const x = i * (barWidth + 3);
      const y = (h - barHeight) / 2;

      // Color shifts with pitch: warm amber for bass to vibrant blue/cyan for treble
      const hue = 210 + (i / numBars) * 35; // 210 (blue) -> 245 (indigo/violet)
      canvasCtx.fillStyle = percent > 0.15 
        ? `hsla(${hue}, 95%, 62%, ${0.5 + percent * 0.5})` 
        : 'rgba(255, 255, 255, 0.12)';

      canvasCtx.beginPath();
      canvasCtx.roundRect(x, y, barWidth, barHeight, 2);
      canvasCtx.fill();
    }
  }

  draw();
}

function stopRecording() {
  state.isListening = false;
  updateMicUI(false);
  updateStatus(state.isConnected ? 'connected' : 'disconnected', state.isConnected ? 'Ready' : 'Offline');

  if (state.animFrameId) {
    cancelAnimationFrame(state.animFrameId);
    state.animFrameId = null;
  }
  drawIdleCanvas();

  if (micStatusRow && micStatusText) {
    micStatusRow.className = 'mic-status-row';
    micStatusText.textContent = 'Tap Start to begin';
  }

  if (state.workletNode) {
    state.workletNode.disconnect();
    state.workletNode = null;
  }
  if (state.scriptProcessor) {
    state.scriptProcessor.disconnect();
    state.scriptProcessor = null;
  }
  if (state.gainNode) {
    state.gainNode.disconnect();
    state.gainNode = null;
  }
  if (state.analyser) {
    state.analyser.disconnect();
    state.analyser = null;
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(track => track.stop());
    state.mediaStream = null;
  }
  if (state.audioContext && state.audioContext.state !== 'closed') {
    state.audioContext.close();
    state.audioContext = null;
  }

  hideLivePartial();
}

// Linear Interpolation Downsampler (Any input rate -> 16,000 Hz 16-bit PCM)
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
// Audio Playback Engine
// -------------------------------------------------------------
async function streamAudioPlayback(base64Data) {
  if (state.outputMode === 'captions') return;

  try {
    const ctx = getPlaybackContext();
    const binary = window.atob(base64Data);
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
      setTimeout(() => { state.isAudioPlaying = false; }, 100);
    };

    source.start(0);
  } catch (err) {
    console.error('[Playback Decode Error]', err);
    state.isAudioPlaying = false;
  }
}

function speakBrowserTTS(text, lang) {
  if (state.outputMode === 'captions' || !('speechSynthesis' in window) || !text) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang === 'es' ? 'es-MX' : 'en-US';
  utterance.rate = 1.05;

  if (state.echoProtectionEnabled && state.outputMode === 'spoken') {
    state.isAudioPlaying = true;
  }

  utterance.onend = () => {
    setTimeout(() => { state.isAudioPlaying = false; }, 100);
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
  if (emptyState) emptyState.style.display = 'none';
  liveBubble.style.display = 'flex';
  liveStatusLabel.textContent = isFinal ? 'Translating...' : 'Listening...';
  livePartialText.textContent = text;
  conversationFeed.scrollTop = conversationFeed.scrollHeight;
}

function hideLivePartial() {
  liveBubble.style.display = 'none';
  livePartialText.textContent = '...';
}

function appendTurnCard({ original, translated, detectedLang, targetLang, latencyMs }) {
  if (emptyState) emptyState.style.display = 'none';

  const isSpanish = detectedLang === 'es';
  const flagSrc = isSpanish ? (REGION_FLAGS[state.region] || '🇲🇽') : '🇺🇸';
  const flagDst = isSpanish ? '🇺🇸' : (REGION_FLAGS[state.region] || '🇲🇽');
  const accentClass = isSpanish ? '' : 'es-accent';

  const card = document.createElement('div');
  card.className = 'turn-bubble';
  card.innerHTML = `
    <div class="turn-meta-row">
      <span class="turn-lang-badge ${detectedLang}">
        ${flagSrc} ${detectedLang.toUpperCase()} → ${flagDst} ${targetLang.toUpperCase()}
      </span>
      <span class="turn-timing">${latencyMs ? `${latencyMs}ms` : ''}</span>
    </div>

    <div class="speech-original">${sanitize(original)}</div>

    <div class="speech-translated-box ${accentClass}">
      <div class="speech-translated-text">${sanitize(translated)}</div>
    </div>

    <div class="bubble-actions-row">
      <button class="replay-audio-btn" data-text="${sanitize(translated)}" data-lang="${targetLang}">
        🔊 Replay
      </button>
    </div>
  `;

  card.querySelector('.replay-audio-btn').addEventListener('click', () => {
    speakBrowserTTS(translated, targetLang);
  });

  conversationFeed.appendChild(card);
  conversationFeed.scrollTop = conversationFeed.scrollHeight;
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
  statusDot.className = `status-indicator-dot ${dotClass}`;
  statusText.textContent = text;
}

function updateMicUI(active) {
  if (active) {
    micButton.className = 'main-mic-btn active';
    micButtonLabel.textContent = 'Pause Conversation';
    micIcon.style.display = 'none';
    stopIcon.style.display = 'block';
  } else {
    micButton.className = 'main-mic-btn idle';
    micButtonLabel.textContent = 'Start Conversation';
    micIcon.style.display = 'block';
    stopIcon.style.display = 'none';
  }
}

// -------------------------------------------------------------
// Event Listeners
// -------------------------------------------------------------
micButton.addEventListener('click', () => {
  if (state.isListening) {
    stopRecording();
  } else {
    startRecording();
  }
});

regionSelect.addEventListener('change', (e) => {
  state.region = e.target.value;
  targetFlag.textContent = REGION_FLAGS[state.region] || '🇲🇽';
  syncConfig();
});

modeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    modeButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.outputMode = btn.dataset.mode;
    syncConfig();
  });
});

echoCancelToggle.addEventListener('change', (e) => {
  state.echoProtectionEnabled = e.target.checked;
});

// Boot WebSocket on page load
window.addEventListener('DOMContentLoaded', () => {
  initWebSocket();
});
