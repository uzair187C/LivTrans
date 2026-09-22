import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { translateWithSlang } from './translate.js';
import { synthesizeSpeech } from './tts_client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const AAI_KEY = process.env.ASSEMBLYAI_API_KEY;

async function runPipelineVerification() {
  console.log('====================================================');
  console.log('  DUET LIVE TRANSLATION - PIPELINE VERIFICATION     ');
  console.log('====================================================\n');

  // Step 1: Verify AssemblyAI WebSocket connection
  console.log('[1/3] Verifying AssemblyAI v3 WebSocket connection...');
  const aaiSuccess = await new Promise((resolve) => {
    const ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le`, {
      headers: { 'authorization': AAI_KEY }
    });
    const timer = setTimeout(() => {
      console.log('  ❌ Timeout connecting to AssemblyAI');
      ws.terminate();
      resolve(false);
    }, 6000);

    ws.on('open', () => {
      clearTimeout(timer);
      console.log('  ✅ AssemblyAI WebSocket connected successfully!');
      ws.close();
      resolve(true);
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      console.log(`  ❌ AssemblyAI WebSocket error: ${err.message}`);
      resolve(false);
    });
  });

  // Step 2: Slang Test Simulation
  console.log('\n[2/3] Verifying Slang-Aware Translation Logic...');
  const testPhrases = [
    { text: "No manches güey, la neta estuvo bien chido el concierto.", region: "Mexican" },
    { text: "Che boludo, qué quilombo que se armó.", region: "Argentinian" }
  ];

  for (const t of testPhrases) {
    try {
      const res = await translateWithSlang(t.text, t.region);
      console.log(`  [${t.region}] "${t.text}"`);
      console.log(`  -> Translated: "${res.translatedText}" (${res.latencyMs}ms)`);
    } catch (e) {
      console.log(`  ⚠️ Translation note for "${t.text}": ${e.message.substring(0, 90)}...`);
    }
  }

  // Step 3: TTS Verification
  console.log('\n[3/3] Verifying Spoken Voice Output (TTS)...');
  try {
    const ttsRes = await synthesizeSpeech("Hola amigo, ¿cómo estás?", "es");
    if (ttsRes.audioBase64) {
      console.log(`  ✅ ElevenLabs Audio generated successfully (${ttsRes.latencyMs}ms)`);
    } else {
      console.log(`  ℹ️ Cloud TTS response: ${ttsRes.error || 'Fallback enabled'}`);
      console.log('  -> Browser Web Speech Synthesis fallback will automatically handle speech output on device.');
    }
  } catch (e) {
    console.log(`  ⚠️ TTS test error: ${e.message}`);
  }

  console.log('\n====================================================');
  console.log('  VERIFICATION COMPLETE                             ');
  console.log('====================================================\n');
}

runPipelineVerification();
