import { GoogleGenAI } from '@google/genai';
import type { Generate } from './identity.ts';
import type { See } from './vision.ts';

const RETRIES = 3;
const transient = (e: unknown): boolean => /"code":\s*(429|500|503|504)|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(String(e instanceof Error ? e.message : e));

// Real Gemini call. Temperature 0 and JSON output so the identity gate is repeatable.
// Transient overload errors are retried with backoff; after that the error propagates and the engine fails closed.
export function geminiGenerate(apiKey: string, model: string): Generate {
  const ai = new GoogleGenAI({ apiKey });
  return async (prompt) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { temperature: 0, responseMimeType: 'application/json' },
        });
        if (!res.text) throw new Error('empty Gemini response');
        return res.text;
      } catch (e) {
        if (attempt >= RETRIES || !transient(e)) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  };
}

// The same call with one picture beside the prompt: Gemini reads the image and the text together.
export function geminiSee(apiKey: string, model: string): See {
  const ai = new GoogleGenAI({ apiKey });
  return async (prompt, picture) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: picture.mime, data: picture.data } }] }],
          config: { temperature: 0, responseMimeType: 'application/json' },
        });
        if (!res.text) throw new Error('empty Gemini response');
        return res.text;
      } catch (e) {
        if (attempt >= RETRIES || !transient(e)) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  };
}
