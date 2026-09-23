import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { AssemblyAIStreamingClient } from './assemblyai_client.js';
import { translateWithSlang } from './translate.js';
import { synthesizeSpeech } from './tts_client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = process.env.PORT || 8080;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

const app = express();
const server = http.createServer(app);

// Serve static frontend assets
const frontendDir = path.resolve(__dirname, '../frontend');
app.use(express.static(frontendDir));

// Health check endpoint for Google Cloud Run
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'live-translator-pipeline'
  });
});

// WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server, path: '/ws/live' });

console.log(`[Server] Initializing Live Translation Service on port ${PORT}...`);

wss.on('connection', (clientWs, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WebSocket] New client connected from ${clientIp}`);

  let sessionConfig = {
    region: 'Mexican',
    enableVoiceOutput: true,
    muteOriginal: false
  };

  let aaiClient = null;

  async function processTranslationPipeline(rawText) {
    const tStartPipeline = Date.now();
    console.log(`\n[Pipeline] Final Speech Turn: "${rawText}"`);

    // 1. Immediately send final transcript to client
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'final_transcript',
        text: rawText
      }));
      clientWs.send(JSON.stringify({
        type: 'translating',
        original: rawText
      }));
    }

    // 2. Slang-aware translation via LLM
    let translationResult;
    try {
      translationResult = await translateWithSlang(rawText, sessionConfig.region);
      console.log(`[Pipeline] Translated (${translationResult.detectedLanguage} -> ${translationResult.targetLanguage}): "${translationResult.translatedText}" [LLM Latency: ${translationResult.latencyMs}ms]`);

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'translation',
          original: rawText,
          translated: translationResult.translatedText,
          detectedLanguage: translationResult.detectedLanguage,
          targetLanguage: translationResult.targetLanguage,
          llmLatencyMs: translationResult.latencyMs
        }));
      }
    } catch (transErr) {
      console.error('[Pipeline] Translation failed:', transErr.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'error',
          source: 'translation',
          message: transErr.message
        }));
      }
      return;
    }

    // 3. Spoken Voice Output via ElevenLabs (if enabled)
    if (sessionConfig.enableVoiceOutput && translationResult.translatedText) {
      try {
        const ttsResult = await synthesizeSpeech(translationResult.translatedText, translationResult.targetLanguage);
        const totalPipelineMs = Date.now() - tStartPipeline;

        console.log(`[Pipeline] TTS Audio Ready: ${ttsResult.audioBase64 ? 'OK' : 'Fallback required'} [TTS Latency: ${ttsResult.latencyMs}ms | Total Pipeline: ${totalPipelineMs}ms]`);

        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'audio',
            audioBase64: ttsResult.audioBase64,
            format: ttsResult.format,
            targetLanguage: translationResult.targetLanguage,
            ttsLatencyMs: ttsResult.latencyMs,
            totalLatencyMs: totalPipelineMs,
            error: ttsResult.error
          }));
        }
      } catch (ttsErr) {
        console.error('[Pipeline] TTS error:', ttsErr.message);
      }
    }
  }

  try {
    aaiClient = new AssemblyAIStreamingClient(ASSEMBLYAI_API_KEY, 16000);
    aaiClient.connect();

    aaiClient.on('connected', () => {
      clientWs.send(JSON.stringify({
        type: 'status',
        status: 'ready',
        message: 'Speech recognition engine ready'
      }));
    });

    aaiClient.on('speech_started', () => {
      console.log('[Pipeline] Speech activity detected');
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'speech_started' }));
      }
    });

    aaiClient.on('partial', (data) => {
      console.log(`[Speech Live] Partial: "${data.text}"`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'partial_transcript',
          text: data.text
        }));
      }
    });

    aaiClient.on('final', async (data) => {
      if (data.text && data.text.trim().length > 0) {
        await processTranslationPipeline(data.text);
      }
    });

    aaiClient.on('error', (err) => {
      console.error('[Pipeline] AssemblyAI error:', err.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'error',
          source: 'speech_recognition',
          message: err.message
        }));
      }
    });

  } catch (err) {
    console.error('[Server] Error initializing AssemblyAI client:', err.message);
  }

  let audioPacketsReceived = 0;

  // Handle incoming messages from browser client
  clientWs.on('message', (message, isBinary) => {
    // If binary data, it's raw 16kHz PCM audio from microphone
    if (isBinary) {
      audioPacketsReceived++;

      if (audioPacketsReceived === 1 || audioPacketsReceived % 50 === 0) {
        // Compute peak amplitude to verify whether audio contains real speech vs silence
        let peakSample = 0;
        const buf = Buffer.isBuffer(message) ? message : Buffer.from(message);
        for (let i = 0; i < buf.length - 1; i += 2) {
          const s = Math.abs(buf.readInt16LE(i));
          if (s > peakSample) peakSample = s;
        }
        console.log(`[Audio Streaming] Packet #${audioPacketsReceived} (${buf.length}B, PeakAmp: ${peakSample})`);
      }

      if (aaiClient) {
        aaiClient.sendAudio(message);
      }
      return;
    }

    // Text JSON messages for control commands
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'config') {
        if (data.region) sessionConfig.region = data.region;
        if (data.enableVoiceOutput !== undefined) sessionConfig.enableVoiceOutput = data.enableVoiceOutput;
        if (data.muteOriginal !== undefined) sessionConfig.muteOriginal = data.muteOriginal;
        console.log(`[Session Config Updated]`, sessionConfig);
        clientWs.send(JSON.stringify({ type: 'config_ack', config: sessionConfig }));
      } else if (data.type === 'finalize_turn') {
        console.log('[Server] Client requested turn finalization');
        if (aaiClient) {
          aaiClient.forceFinalize();
        }
      } else if (data.type === 'simulate_turn') {
        console.log(`[Server] Client requested simulation: "${data.text}"`);
        processTranslationPipeline(data.text || 'Hey bro, where are you going tonight?');
      }
    } catch (e) {
      console.error('[Server] Malformed client message:', e.message);
    }
  });

  clientWs.on('close', () => {
    console.log(`[WebSocket] Client disconnected. Total packets: ${audioPacketsReceived}`);
    if (aaiClient) {
      aaiClient.close();
      aaiClient = null;
    }
  });

  clientWs.on('error', (err) => {
    console.error('[WebSocket] Client error:', err.message);
    if (aaiClient) {
      aaiClient.close();
      aaiClient = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` Live Translation Server running on http://localhost:${PORT}`);
  console.log(` WebSocket endpoint ready at ws://localhost:${PORT}/ws/live`);
  console.log(` Serving frontend from: ${frontendDir}`);
  console.log(`======================================================\n`);
});
