import { createApp } from './app.ts';
import { createIdentityEngine } from './identity.ts';
import { geminiGenerate } from './gemini.ts';
import { MARKETS, searchShopping } from './serpapi.ts';
import { searchEbay } from './ebay.ts';
import { estimateRetail } from './retail.ts';
import { briefingFor } from './briefing.ts';
import { readFileSync } from 'node:fs';
import { FileStore, firestoreStore, Quota, type Store } from './store.ts';
import type { Offer } from './types.ts';

const env = (k: string): string | undefined => process.env[k] || undefined;
const need = (k: string): string => {
  const v = env(k);
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

const model = need('GEMINI_MODEL');
const project = env('GCP_PROJECT');
const database = env('FIRESTORE_DATABASE');
const useFirestore = Boolean(database && project);
const store: Store = useFirestore ? await firestoreStore(project!, database!) : new FileStore('.cache');
const quota = new Quota(store, Number(env('MONTHLY_SEARCH_CAP') ?? 100));
const serpKey = need('SERPAPI_KEY');
const ebay = env('EBAY_CLIENT_ID') && env('EBAY_CLIENT_SECRET') ? { clientId: env('EBAY_CLIENT_ID')!, clientSecret: env('EBAY_CLIENT_SECRET')!, store } : null;

const generate = geminiGenerate(need('GEMINI_API_KEY'), model);
const engine = createIdentityEngine(generate);

// WATCHLIST="LEGO 10294 Titanic|us;LEGO 21330 Home Alone|us"
const watchlist = (env('WATCHLIST') ?? '').split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
  const [query, market = 'us'] = s.split('|');
  return { query: query.trim(), market: market.trim() };
});

let evalSummary: unknown = null;
try {
  evalSummary = JSON.parse(readFileSync(new URL('../eval/summary.json', import.meta.url), 'utf8'));
} catch {
  // no summary shipped; the page hides the evidence band
}

const app = createApp({
  evalSummary,
  store, quota, watchlist,
  storeKind: useFirestore ? `firestore:${database}` : 'local file',
  scanSecret: env('SCAN_SECRET') ?? '',
  sources: { serpapi: true, ebay: Boolean(ebay) },
  agent: {
    engine, store, model,
    retail: async (query, currency) => (await estimateRetail(generate, store, query, currency)).cents,
    briefing: (facts) => briefingFor(generate, facts),
    search: async (query, marketCode, opts) => {
      const market = MARKETS[marketCode];
      const serp = await searchShopping(query, market, { apiKey: serpKey, store, quota }, opts);
      let extra: Offer[] = [];
      if (ebay && marketCode === 'us') {
        try {
          extra = await searchEbay(query, market, ebay, opts);
        } catch (e) {
          console.error('ebay search failed, continuing without it', e);
        }
      }
      return { offers: [...serp.offers, ...extra], fromCache: serp.fromCache };
    },
  },
});

const port = Number(env('PORT') ?? 8080);
app.listen(port, () => console.log(`SKUdesk listening on :${port} (${useFirestore ? 'firestore' : 'file'} store, model ${model}, ebay ${ebay ? 'on' : 'off'})`));
