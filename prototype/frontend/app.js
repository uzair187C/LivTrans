/**
 * Duet — Live Voice Translation Client Engine
 * Robust cross-platform Web Audio capture (iOS Safari / Android Chrome / Desktop),
 * dynamic sample-rate downsampling to 16kHz PCM, real-time volume visualizer,
 * and seamless audio playback.
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
  scriptProcessor: null,
  gainNode: null,
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
const audioVisualizer = document.getElementById('audioVisualizer');
const visualizerBars = document.querySelectorAll('.visualizer-bar');

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

      // If captions mode, skip audio playback
      if (state.outputMode === 'captions') return;

      if (data.audioBase64) {
        streamAudioPlayback(data.audioBase64);
      } else if (data.error && state.outputMode !== 'captions') {
        // Fallback to browser speech synthesis
        speakBrowserTTS(data.targetText || '', data.targetLanguage);
      }
      break;

    case 'error':
      console.error('[Server Pipeline Error]', data);
      break;
  }
}

// -------------------------------------------------------------
// Audio Capture & Resampling (Universal Mobile Support)
// -------------------------------------------------------------
async function startRecording() {
  try {
    getPlaybackContext(); // Unlock audio context on user gesture

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioCtx();
    await state.audioContext.resume();

    // Constraints for clean voice audio
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: state.echoProtectionEnabled,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const source = state.audioContext.createMediaStreamSource(state.mediaStream);
    const inputSampleRate = state.audioContext.sampleRate;
    const targetSampleRate = 16000;

    // Use 4096 buffer size
    const bufferSize = 4096;
    state.scriptProcessor = state.audioContext.createScriptProcessor(bufferSize, 1, 1);

    // Muted GainNode to keep audio chain active on iOS without acoustic echo
    state.gainNode = state.audioContext.createGain();
    state.gainNode.gain.value = 0;

    state.scriptProcessor.onaudioprocess = (e) => {
      if (!state.isListening) return;

      // Echo Protection: Duck mic during spoken translation playback
      if (state.isAudioPlaying && state.echoProtectionEnabled && state.outputMode === 'spoken') {
        updateVisualizer(0);
        return;
      }

      const channelData = e.inputBuffer.getChannelData(0);

      // Compute volume for live visualizer
      let sumSquares = 0;
      for (let i = 0; i < channelData.length; i++) {
        sumSquares += channelData[i] * channelData[i];
      }
      const rms = Math.sqrt(sumSquares / channelData.length);
      updateVisualizer(rms);

      // Downsample input float32 array to 16kHz 16-bit PCM
      const pcm16Data = downsampleToPCM16(channelData, inputSampleRate, targetSampleRate);

      // Stream binary frame to server
      if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
        state.websocket.send(pcm16Data.buffer);
      }
    };

    source.connect(state.scriptProcessor);
    state.scriptProcessor.connect(state.gainNode);
    state.gainNode.connect(state.audioContext.destination);

    state.isListening = true;
    updateMicUI(true);
    updateStatus('listening', 'Listening');
    audioVisualizer.style.opacity = '1';

  } catch (err) {
    console.error('[Mic Error]', err);
    alert(`Microphone error: ${err.message}\nPlease ensure microphone permission is granted in your browser settings.`);
    stopRecording();
  }
}

function stopRecording() {
  state.isListening = false;
  updateMicUI(false);
  updateStatus(state.isConnected ? 'connected' : 'disconnected', state.isConnected ? 'Ready' : 'Offline');
  audioVisualizer.style.opacity = '0';
  updateVisualizer(0);

  if (state.scriptProcessor) {
    state.scriptProcessor.disconnect();
    state.scriptProcessor = null;
  }
  if (state.gainNode) {
    state.gainNode.disconnect();
    state.gainNode = null;
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

// Downsample from device sample rate (e.g. 48kHz or 44.1kHz) to 16kHz 16-bit PCM
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

// Animate visualizer bars in real-time
function updateVisualizer(volume) {
  const norm = Math.min(1, volume * 10);
  visualizerBars.forEach((bar, index) => {
    const variance = Math.sin((index + 1) * 1.5) * 0.35 + 0.65;
    const h = Math.max(4, Math.round(norm * 22 * variance));
    bar.style.height = `${h}px`;
  });
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

// Boot WebSocket on load
window.addEventListener('DOMContentLoaded', () => {
  initWebSocket();
});
