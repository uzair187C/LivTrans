import WebSocket from 'ws';
import { EventEmitter } from 'events';

/**
 * AssemblyAI Streaming Client (v3 API)
 * Features:
 * - 100ms chunk accumulator (enforces 3200-byte frames)
 * - Auto-finalization watchdog (finalizes transcript after 900ms pause)
 * - Explicit forceFinalize() method on user pause / turn completion
 * - Full telemetry event forwarding ('speech_started', 'partial', 'final')
 */
export class AssemblyAIStreamingClient extends EventEmitter {
  constructor(apiKey, sampleRate = 16000) {
    super();
    this.apiKey = apiKey;
    this.sampleRate = sampleRate;
    this.ws = null;
    this.isConnected = false;
    this.audioQueue = [];
    this.chunkBuffer = Buffer.alloc(0);

    this.lastPartialText = '';
    this.lastPartialTime = 0;
    this.turnFinalized = false;
    this.silenceWatchdog = null;
  }

  connect() {
    if (this.isConnected && this.ws) return;

    const url = `wss://streaming.assemblyai.com/v3/ws?sample_rate=${this.sampleRate}&encoding=pcm_s16le`;

    this.ws = new WebSocket(url, {
      headers: {
        'authorization': this.apiKey
      }
    });

    this.ws.on('open', () => {
      this.isConnected = true;
      console.log('[AssemblyAI] Connected to streaming endpoint.');
      this.emit('connected');

      // Flush any queued audio
      while (this.audioQueue.length > 0 && this.isConnected) {
        const chunk = this.audioQueue.shift();
        this.sendAudio(chunk);
      }
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        console.error('[AssemblyAI] JSON parse error:', err);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[AssemblyAI] WebSocket error:', err.message);
      this.emit('error', err);
    });

    this.ws.on('close', (code, reason) => {
      this.isConnected = false;
      this.clearWatchdog();
      console.log(`[AssemblyAI] Connection closed (${code}): ${reason}`);
      this.emit('close', { code, reason });
    });
  }

  handleMessage(msg) {
    if (msg.type === 'Error') {
      console.error(`[AssemblyAI Error ${msg.error_code}]:`, msg.error);
      this.emit('error', new Error(msg.error || `AssemblyAI Error ${msg.error_code}`));
      return;
    }

    if (msg.type === 'Begin') {
      console.log(`[AssemblyAI] Session started (ID: ${msg.id})`);
    } else if (msg.type === 'SpeechStarted') {
      console.log('[AssemblyAI] User speech detected');
      this.turnFinalized = false;
      this.emit('speech_started');
    } else if (msg.type === 'Turn') {
      const text = msg.transcript?.trim() || '';
      console.log(`[AssemblyAI Turn] end_of_turn=${msg.end_of_turn}: "${text}"`);

      if (!text) return;

      this.lastPartialText = text;
      this.lastPartialTime = Date.now();

      if (msg.end_of_turn) {
        this.clearWatchdog();
        this.turnFinalized = true;
        this.lastPartialText = '';
        this.emit('final', {
          text,
          words: msg.words,
          turn_id: msg.turn_id
        });
      } else {
        this.turnFinalized = false;
        this.emit('partial', {
          text,
          turn_id: msg.turn_id
        });

        // Reset silence watchdog: if no new speech arrives in 900ms, auto-finalize
        this.resetWatchdog();
      }
    } else if (msg.message_type === 'FinalTranscript' && msg.text) {
      const text = msg.text.trim();
      this.clearWatchdog();
      this.turnFinalized = true;
      this.lastPartialText = '';
      this.emit('final', { text, words: msg.words });
    } else if (msg.message_type === 'PartialTranscript' && msg.text) {
      const text = msg.text.trim();
      this.lastPartialText = text;
      this.lastPartialTime = Date.now();
      this.emit('partial', { text });
      this.resetWatchdog();
    }
  }

  resetWatchdog() {
    this.clearWatchdog();
    this.silenceWatchdog = setTimeout(() => {
      if (this.lastPartialText && !this.turnFinalized) {
        console.log(`[AssemblyAI] Silence watchdog triggered. Auto-finalizing turn: "${this.lastPartialText}"`);
        this.forceFinalize();
      }
    }, 900);
  }

  clearWatchdog() {
    if (this.silenceWatchdog) {
      clearTimeout(this.silenceWatchdog);
      this.silenceWatchdog = null;
    }
  }

  forceFinalize() {
    this.clearWatchdog();
    if (this.lastPartialText && !this.turnFinalized) {
      this.turnFinalized = true;
      const finalText = this.lastPartialText;
      this.lastPartialText = '';
      console.log(`[AssemblyAI] Force finalized: "${finalText}"`);
      this.emit('final', { text: finalText });
    }
  }

  sendAudio(pcmChunk) {
    const buf = Buffer.isBuffer(pcmChunk) ? pcmChunk : Buffer.from(pcmChunk);
    if (!this.chunkBuffer) this.chunkBuffer = Buffer.alloc(0);
    this.chunkBuffer = Buffer.concat([this.chunkBuffer, buf]);

    // AssemblyAI v3 enforces chunks between 50ms (1600 bytes) and 1000ms (32000 bytes).
    // Send consistent 100ms frames (1600 samples * 2 = 3200 bytes)
    const CHUNK_SIZE = 3200;
    while (this.chunkBuffer.length >= CHUNK_SIZE) {
      const frame = Buffer.from(this.chunkBuffer.subarray(0, CHUNK_SIZE));
      this.chunkBuffer = this.chunkBuffer.subarray(CHUNK_SIZE);

      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(frame);
      } else {
        if (this.audioQueue.length < 50) {
          this.audioQueue.push(frame);
        }
      }
    }
  }

  close() {
    this.clearWatchdog();
    this.forceFinalize();

    if (this.ws) {
      try {
        if (this.chunkBuffer && this.chunkBuffer.length >= 1600 && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(this.chunkBuffer);
          this.chunkBuffer = Buffer.alloc(0);
        }
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'Terminate' }));
        }
        this.ws.close();
      } catch (e) {
        // ignore
      }
      this.isConnected = false;
      this.ws = null;
    }
  }
}
