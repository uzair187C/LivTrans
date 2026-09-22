/**
 * Duet — Live Voice Translation Frontend Engine
 * Handles getUserMedia PCM capture (16kHz), WebSocket streaming,
 * Acoustic Echo Cancellation (AEC) gating, and AudioContext playback.
 */

// Application State
const state = {
  isListening: false,
  isConnected: false,
  isAudioPlaying: false,
  echoShieldEnabled: true,
  voiceOutputEnabled: true,
  region: 'Mexican',
  audioContext: null,
  mediaStream: null,
  scriptProcessor: null,
  websocket: null,
  lastTurnId: null,
  audioQueue: []
};

// DOM Elements
const micButton = document.getElementById('micButton');
const micButtonLabel = document.getElementById('micButtonLabel');
const micIcon = document.getElementById('micIcon');
const stopIcon = document.getElementById('stopIcon');
const connectionStatus = document.getElementById('connectionStatus');
const statusLabel = document.getElementById('statusLabel');
const latencyBadge = document.getElementById('latencyBadge');
const latencyText = document.getElementById('latencyText');
const regionSelect = document.getElementById('regionSelect');
const voiceOutputToggle = document.getElementById('voiceOutputToggle');
const echoCancelToggle = document.getElementById('echoCancelToggle');
const conversationFeed = document.getElementById('conversationFeed');
const emptyState = document.getElementById('emptyState');
const liveBubble = document.getElementById('liveBubble');
const livePartialText = document.getElementById('livePartialText');

// Initialize Web Audio Context for playback
let playbackContext = null;
function getPlaybackContext() {
  if (!playbackContext) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    playbackContext = new AudioCtx();
  }
  if (playbackContext.state === 'suspended') {
    playbackContext.resume();
  }
  return playbackContext;
}

// Connect to Backend WebSocket
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/live`;

  updateStatus('connecting', 'Connecting...');
  state.websocket = new WebSocket(wsUrl);
  state.websocket.binaryType = 'arraybuffer';

  state.websocket.onopen = () => {
    state.isConnected = true;
    updateStatus('connected', 'Ready');
    sendConfig();
  };

  state.websocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleServerMessage(data);
    } catch (err) {
      console.error('[WS] Error parsing message:', err);
    }
  };

  state.websocket.onclose = () => {
    state.isConnected = false;
    updateStatus('disconnected', 'Disconnected');
    if (state.isListening) {
      stopListening();
    }
    // Attempt reconnect after 3 seconds
    setTimeout(() => {
      if (!state.isConnected) connectWebSocket();
    }, 3000);
  };

  state.websocket.onerror = (err) => {
    console.error('[WS] Error:', err);
    updateStatus('disconnected', 'Connection error');
  };
}

// Send current UI configuration to backend
function sendConfig() {
  if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
    state.websocket.send(JSON.stringify({
      type: 'config',
      region: state.region,
      enableVoiceOutput: state.voiceOutputEnabled
    }));
  }
}

// Handle Incoming Messages from Server
function handleServerMessage(data) {
  switch (data.type) {
    case 'status':
      updateStatus('connected', data.message || 'Engine Ready');
      break;

    case 'partial_transcript':
      showLivePartial(data.text);
      break;

    case 'final_transcript':
      showLivePartial(data.text);
      break;

    case 'translation':
      hideLivePartial();
      addTurnCard({
        original: data.original,
        translated: data.translated,
        detectedLang: data.detectedLanguage,
        targetLang: data.targetLanguage,
        llmLatency: data.llmLatencyMs
      });
      break;

    case 'audio':
      if (data.totalLatencyMs) {
        latencyText.textContent = `${data.totalLatencyMs} ms`;
        latencyBadge.style.color = '#38bdf8';
      }

      if (data.audioBase64) {
        playAudioBuffer(data.audioBase64);
      } else if (data.error && state.voiceOutputEnabled) {
        console.warn('[Audio] Cloud TTS unavailable, using browser speech synthesis fallback.');
        speakBrowserFallback(data.targetText || '', data.targetLanguage);
      }
      break;

    case 'error':
      console.error('[Server Error]', data.source, data.message);
      break;
  }
}

// Play Base64 MP3 Audio from Backend
async function playAudioBuffer(base64Data) {
  try {
    const ctx = getPlaybackContext();
    const binaryStr = window.atob(base64Data);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    // Acoustic Echo Protection Gate: Duck/mute mic during playback
    if (state.echoShieldEnabled) {
      state.isAudioPlaying = true;
    }

    source.onended = () => {
      // Release mic ducking after playback completes (+ 120ms safety margin)
      setTimeout(() => {
        state.isAudioPlaying = false;
      }, 120);
    };

    source.start(0);
  } catch (err) {
    console.error('[Audio Playback Error]', err);
    state.isAudioPlaying = false;
  }
}

// Browser Web Speech Synthesis Fallback (zero-cost backup)
function speakBrowserFallback(text, lang) {
  if (!('speechSynthesis' in window) || !text) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang === 'es' ? 'es-MX' : 'en-US';
  utterance.rate = 1.05;

  if (state.echoShieldEnabled) {
    state.isAudioPlaying = true;
  }

  utterance.onend = () => {
    setTimeout(() => { state.isAudioPlaying = false; }, 120);
  };
  utterance.onerror = () => {
    state.isAudioPlaying = false;
  };

  window.speechSynthesis.speak(utterance);
}

// Start Microphone Capture (16kHz 16-bit Mono PCM)
async function startListening() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioCtx({ sampleRate: 16000 });
    await state.audioContext.resume();

    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: state.echoShieldEnabled,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const sourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);
    // Buffer size 4096 gives ~256ms chunking at 16kHz
    const bufferSize = 4096;
    state.scriptProcessor = state.audioContext.createScriptProcessor(bufferSize, 1, 1);

    state.scriptProcessor.onaudioprocess = (e) => {
      if (!state.isListening) return;

      // ECHO SHIELD: Discard mic frames while translated audio is playing to prevent feedback loop
      if (state.isAudioPlaying && state.echoShieldEnabled) {
        return;
      }

      const inputData = e.inputBuffer.getChannelData(0);
      // Convert Float32 [-1.0, 1.0] to 16-bit PCM Int16
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // Stream binary frame to backend
      if (state.websocket && state.websocket.readyState === WebSocket.OPEN) {
        state.websocket.send(pcm16.buffer);
      }
    };

    sourceNode.connect(state.scriptProcessor);
    state.scriptProcessor.connect(state.audioContext.destination);

    state.isListening = true;
    updateMicButton(true);
    updateStatus('listening', 'Listening Live...');

  } catch (err) {
    console.error('[Mic Error]', err);
    alert(`Microphone access error: ${err.message}\nPlease ensure microphone permissions are granted.`);
    stopListening();
  }
}

// Stop Microphone Capture
function stopListening() {
  state.isListening = false;
  updateMicButton(false);
  updateStatus(state.isConnected ? 'connected' : 'disconnected', state.isConnected ? 'Ready' : 'Disconnected');

  if (state.scriptProcessor) {
    state.scriptProcessor.disconnect();
    state.scriptProcessor = null;
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

// UI State Updates
function updateStatus(className, label) {
  connectionStatus.className = `status-pill ${className}`;
  statusLabel.textContent = label;
}

function updateMicButton(isActive) {
  if (isActive) {
    micButton.className = 'mic-button active';
    micButtonLabel.textContent = 'Stop Conversation';
    micIcon.style.display = 'none';
    stopIcon.style.display = 'block';
  } else {
    micButton.className = 'mic-button idle';
    micButtonLabel.textContent = 'Start Listening';
    micIcon.style.display = 'block';
    stopIcon.style.display = 'none';
  }
}

function showLivePartial(text) {
  if (emptyState) emptyState.style.display = 'none';
  liveBubble.style.display = 'flex';
  livePartialText.textContent = text;
  conversationFeed.scrollTop = conversationFeed.scrollHeight;
}

function hideLivePartial() {
  liveBubble.style.display = 'none';
  livePartialText.textContent = '...';
}

function addTurnCard({ original, translated, detectedLang, targetLang, llmLatency }) {
  if (emptyState) emptyState.style.display = 'none';

  const card = document.createElement('div');
  card.className = 'turn-card';

  const isSpanishSource = detectedLang === 'es';
  const flagSource = isSpanishSource ? '🇲🇽' : '🇺🇸';
  const flagTarget = isSpanishSource ? '🇺🇸' : '🇲🇽';
  const targetClass = isSpanishSource ? '' : 'es-target';

  card.innerHTML = `
    <div class="turn-header">
      <span class="lang-badge ${detectedLang}">
        ${flagSource} ${detectedLang.toUpperCase()} → ${flagTarget} ${targetLang.toUpperCase()}
      </span>
      <span class="turn-metrics">${llmLatency ? `${llmLatency}ms` : ''}</span>
    </div>

    <div class="original-box">
      <span class="box-label">Original</span>
      <p class="original-text">${escapeHtml(original)}</p>
    </div>

    <div class="translation-box ${targetClass}">
      <span class="box-label">Translated (${state.region})</span>
      <p class="translated-text">${escapeHtml(translated)}</p>
    </div>

    <div class="turn-actions">
      <button class="play-audio-btn" data-text="${escapeHtml(translated)}" data-lang="${targetLang}">
        🔊 Listen Again
      </button>
    </div>
  `;

  // Hook up replay button
  const replayBtn = card.querySelector('.play-audio-btn');
  replayBtn.addEventListener('click', () => {
    speakBrowserFallback(translated, targetLang);
  });

  conversationFeed.appendChild(card);
  conversationFeed.scrollTop = conversationFeed.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Event Listeners
micButton.addEventListener('click', () => {
  getPlaybackContext(); // Unlock audio context on user gesture
  if (state.isListening) {
    stopListening();
  } else {
    startListening();
  }
});

regionSelect.addEventListener('change', (e) => {
  state.region = e.target.value;
  sendConfig();
});

voiceOutputToggle.addEventListener('change', (e) => {
  state.voiceOutputEnabled = e.target.checked;
  sendConfig();
});

echoCancelToggle.addEventListener('change', (e) => {
  state.echoShieldEnabled = e.target.checked;
});

// Boot WebSocket connection on page load
window.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
});
