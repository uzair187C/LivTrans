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

// Default to gemini-3.5-flash-lite: ultra-low cost & lowest latency
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const REGION_GUIDELINES = {
  Mexican: 'Mexican Spanish (use natural Mexican colloquialisms: e.g., güey, chido, no manches, la neta, qué onda, órale, carnal, echar taco).',
  Peruvian: 'Peruvian Spanish (use natural Peruvian colloquialisms: e.g., pata, causa, asumare, bacán, qué palta, chela).',
  Argentinian: 'Argentinian Spanish (use natural Rioplatense colloquialisms and voseo: e.g., che, boludo, chabón, posta, quilombo, re-).',
  Colombian: 'Colombian Spanish (use natural Colombian colloquialisms: e.g., parce, parcero, chimba, bacano, qué hubo, berraquera).',
  Caribbean: 'Puerto Rican / Caribbean Spanish (use natural Caribbean colloquialisms: e.g., brutal, corillo, jangueo, al garete, nítido).',
  Spain: 'Peninsular Spanish (use natural Spain colloquialisms: e.g., tío, chaval, mola, guay, pasta, flipar).',
  Neutral: 'Standard / Neutral conversational Latin American Spanish (accessible, informal, friendly).'
};

function extractJSON(text) {
  if (!text) return null;
  const clean = text.trim();

  // Try direct parse
  try {
    return JSON.parse(clean);
  } catch (e) {}

  // Strip markdown code fences if present
  const stripped = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(stripped);
  } catch (e) {}

  // Find first { ... } block
  const jsonMatch = clean.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {}
  }

  return null;
}

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

  const systemInstruction = `You are a real-time speech translator for spoken dialogue between English and Spanish speakers.
Your job is to translate conversational speech accurately while preserving casual emotion, natural idioms, and regional slang.

Rules:
1. Detect whether the utterance is English or Spanish.
2. If English: translate to ${regionGuide}.
3. If Spanish: translate to natural, casual American English slang.
4. Output MUST BE strictly valid JSON without explanations, markdown backticks, or preamble.
Example format:
{"detected": "en", "translation": "¿Qué onda carnal, te jalas por unos tacos?"}`;

  const candidates = [MODEL_NAME, 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];
  const modelsToTry = [...new Set(candidates)];

  let lastError = null;

  for (const modelToUse of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelToUse,
        systemInstruction: systemInstruction,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 300,
          responseMimeType: 'application/json'
        }
      });

      const result = await model.generateContent(`Translate: "${text}"`);
      const responseText = result.response.text();
      const parsed = extractJSON(responseText);

      if (!parsed || !parsed.translation) {
        throw new Error(`Invalid JSON received from ${modelToUse}: ${responseText.substring(0, 100)}`);
      }

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
      lastError = err;
      console.warn(`[Translate] Candidate ${modelToUse} failed: ${err.message}. Trying next candidate...`);
    }
  }

  console.error('[Translate] All model candidates failed:', lastError?.message);
  throw lastError || new Error('Translation failed on all candidate models');
}
