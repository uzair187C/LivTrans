import WebSocket from 'ws';
import { EventEmitter } from 'events';

/**
 * AssemblyAI Streaming Client
 * Connects to AssemblyAI Streaming v3 endpoint, streams binary PCM chunks,
 * and emits 'transcript' (partial) and 'final' (finalized turn) events.
 */
export class AssemblyAIStreamingClient extends EventEmitter {
  constructor(apiKey, sampleRate = 16000) {
    super();
    this.apiKey = apiKey;
    this.sampleRate = sampleRate;
    this.ws = null;
    this.isConnected = false;
    this.audioQueue = [];
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

    // Handle v3 messages
    if (msg.type === 'Begin') {
      console.log(`[AssemblyAI] Session started (ID: ${msg.id})`);
    } else if (msg.type === 'Turn') {
      const text = msg.transcript?.trim() || '';
      if (!text) return;

      if (msg.end_of_turn) {
        this.emit('final', {
          text,
          words: msg.words,
          turn_id: msg.turn_id
        });
      } else {
        this.emit('partial', {
          text,
          turn_id: msg.turn_id
        });
      }
    } 
    // Handle v2 legacy / fallback formats if returned
    else if (msg.message_type === 'FinalTranscript' && msg.text) {
      this.emit('final', {
        text: msg.text.trim(),
        words: msg.words
      });
    } else if (msg.message_type === 'PartialTranscript' && msg.text) {
      this.emit('partial', {
        text: msg.text.trim()
      });
    }
  }

  sendAudio(pcmChunk) {
    const buf = Buffer.isBuffer(pcmChunk) ? pcmChunk : Buffer.from(pcmChunk);
    if (!this.chunkBuffer) this.chunkBuffer = Buffer.alloc(0);
    this.chunkBuffer = Buffer.concat([this.chunkBuffer, buf]);

    // AssemblyAI v3 enforces chunks between 50ms (1600 bytes) and 1000ms (32000 bytes).
    // We send consistent 100ms frames (1600 samples * 2 = 3200 bytes) for optimal latency & stability.
    const CHUNK_SIZE = 3200;
    while (this.chunkBuffer.length >= CHUNK_SIZE) {
      const frame = this.chunkBuffer.subarray(0, CHUNK_SIZE);
      this.chunkBuffer = this.chunkBuffer.subarray(CHUNK_SIZE);

      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(frame);
      } else {
        if (this.audioQueue.length < 50) {
          this.audioQueue.push(Buffer.from(frame));
        }
      }
    }
  }

  close() {
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
