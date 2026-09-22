import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const DEFAULT_VOICE_EN = process.env.ELEVENLABS_VOICE_ID_EN || 'JBFqnCBsd6RMkjVDRZzb'; // George
const DEFAULT_VOICE_ES = process.env.ELEVENLABS_VOICE_ID_ES || 'EXAVITQu4vr4xnSDxMaL'; // Bella (Multilingual)

/**
 * Synthesizes speech using ElevenLabs Flash v2.5
 * Falls back gracefully if subscription credits/permissions are unavailable.
 * @param {string} text - Text to speak
 * @param {'en' | 'es'} language - Target language
 * @returns {Promise<{audioBase64: string | null, format: string, latencyMs: number, error?: string}>}
 */
export async function synthesizeSpeech(text, language = 'es') {
  const startTime = Date.now();
  if (!text || text.trim().length === 0) {
    return { audioBase64: null, format: 'audio/mp3', latencyMs: 0 };
  }

  if (!ELEVEN_API_KEY) {
    return {
      audioBase64: null,
      format: 'audio/mp3',
      latencyMs: 0,
      error: 'ELEVENLABS_API_KEY is not configured.'
    };
  }

  const voiceId = language === 'es' ? DEFAULT_VOICE_ES : DEFAULT_VOICE_EN;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?optimize_streaming_latency=4&output_format=mp3_44100_128`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[TTS] ElevenLabs responded with HTTP ${response.status}: ${errText}`);
      return {
        audioBase64: null,
        format: 'audio/mp3',
        latencyMs: Date.now() - startTime,
        error: `ElevenLabs HTTP ${response.status}: ${errText}`
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString('base64');
    const latencyMs = Date.now() - startTime;

    return {
      audioBase64,
      format: 'audio/mp3',
      latencyMs
    };
  } catch (err) {
    console.error('[TTS] Error during synthesis:', err.message);
    return {
      audioBase64: null,
      format: 'audio/mp3',
      latencyMs: Date.now() - startTime,
      error: err.message
    };
  }
}
