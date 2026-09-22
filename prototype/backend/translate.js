import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('[Translate] WARNING: GEMINI_API_KEY is not defined in environment.');
}

const genAI = new GoogleGenerativeAI(apiKey || 'missing_key');

// Use gemini-2.5-flash or gemini-3.6-flash for ultra-low latency conversational translation
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const REGION_GUIDELINES = {
  Mexican: 'Mexican Spanish (use natural Mexican colloquialisms when translating to Spanish: e.g., güey, chido, no manches, la neta, qué onda, órale, paro).',
  Peruvian: 'Peruvian Spanish (use natural Peruvian colloquialisms when translating to Spanish: e.g., pata, causa, asumare, bacán, qué palta, chela).',
  Argentinian: 'Argentinian Spanish (use natural Rioplatense colloquialisms and voseo when translating to Spanish: e.g., che, boludo, chabón, posta, quilombo, re-).',
  Colombian: 'Colombian Spanish (use natural Colombian colloquialisms when translating to Spanish: e.g., parce, parcero, chimba, bacano, qué hubo, berraquera).',
  Caribbean: 'Puerto Rican / Caribbean Spanish (use natural Caribbean colloquialisms: e.g., brutal, corillo, jangueo, al garete, nítido).',
  Spain: 'Peninsular Spanish (use natural Spain colloquialisms: e.g., tío, chaval, mola, guay, pasta, flipar).',
  Neutral: 'Standard / Neutral conversational Latin American Spanish (accessible, informal but region-neutral).'
};

/**
 * Single-shot language detection + regional slang-aware translation
 * @param {string} text - Utterance transcript
 * @param {string} region - Regional nuance (Mexican, Peruvian, Argentinian, Colombian, Neutral, etc.)
 * @returns {Promise<{detectedLanguage: string, targetLanguage: string, translatedText: string, latencyMs: number}>}
 */
export async function translateWithSlang(text, region = 'Mexican') {
  const startTime = Date.now();
  if (!text || text.trim().length === 0) {
    return {
      detectedLanguage: 'en',
      targetLanguage: 'es',
      translatedText: '',
      latencyMs: 0
    };
  }

  const regionGuide = REGION_GUIDELINES[region] || REGION_GUIDELINES.Mexican;

  const systemInstruction = `You are an ultra-fast live conversational translator for a personal voice call between family/friends speaking English and Spanish.
Your job is to translate natural speech while preserving casual emotion, idioms, and regional slang.

Rules:
1. Detect whether the input is primarily English or Spanish.
2. If English, translate to ${regionGuide}.
3. If Spanish, translate to natural, casual conversational American English, matching the exact informal intensity and meaning of the Spanish slang (never translate literal nonsense).
4. Never formalize conversational speech. Keep it sounding like a real human speaking to a friend or relative.
5. Return ONLY a valid JSON object in this format:
{"detected": "en" | "es", "translation": "translated text here"}`;

  try {
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: systemInstruction,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 250,
        responseMimeType: 'application/json'
      }
    });

    const result = await model.generateContent(`Input utterance to translate: "${text}"`);
    const responseText = result.response.text();
    const parsed = JSON.parse(responseText);

    const latencyMs = Date.now() - startTime;
    const detectedLanguage = parsed.detected === 'es' ? 'es' : 'en';
    const targetLanguage = detectedLanguage === 'es' ? 'en' : 'es';

    return {
      detectedLanguage,
      targetLanguage,
      translatedText: parsed.translation.trim(),
      latencyMs
    };
  } catch (err) {
    // If primary model errors, fallback gracefully to gemini-3.6-flash
    if (MODEL_NAME !== 'gemini-3.6-flash') {
      try {
        const fallbackModel = genAI.getGenerativeModel({
          model: 'gemini-3.6-flash',
          systemInstruction: systemInstruction,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 250,
            responseMimeType: 'application/json'
          }
        });
        const fallbackResult = await fallbackModel.generateContent(`Input utterance to translate: "${text}"`);
        const parsed = JSON.parse(fallbackResult.response.text());
        return {
          detectedLanguage: parsed.detected === 'es' ? 'es' : 'en',
          targetLanguage: parsed.detected === 'es' ? 'en' : 'es',
          translatedText: parsed.translation.trim(),
          latencyMs: Date.now() - startTime
        };
      } catch (fallbackErr) {
        console.error('[Translate] Fallback error:', fallbackErr.message);
      }
    }
    console.error('[Translate] Error during translation:', err.message);
    throw err;
  }
}
