# SKUdesk

An agent for retail buyers and sellers. It finds the cheapest landed cost for a product, helps price a listing, and looks for price gaps between marketplaces, **only for identical products**. A Gemini Identity Engine is the single gate: if two listings are not provably the same item, or no gap survives all costs, the agent says so. A person approves every spend.

Built for the Google Cloud AI Builder Cup 2026 (Retail & Commerce). The concept builds on the team's earlier work; all code and assets in this repository were written new for this competition.

## Status

| Part | State |
|---|---|
| Identity Engine (`src/identity.ts`, `src/gemini.ts`) | Done. Calls the real Gemini API. |
| Cost and arbitrage maths (`src/economics.ts`) | Done. Integer cents, basis points, unit-tested. |
| Identity eval (`eval/`) | 36 hand-labelled LEGO pairs, run against real Gemini |
| Source adapters (SerpApi, eBay) | Not built yet |
| Cloud Run service, Scheduler, Firestore | Not built yet |
| One-page UI | Not built yet |

## Identity eval

`npm run eval` sends every pair in `eval/pairs.json` to Gemini and reports the number that must be zero: a pair that should not match but passed the gate.

Limits, stated plainly: listing texts are hand-written to look like marketplace titles, not scraped; labels come from LEGO set numbers; there are no GTIN pairs and no image inputs yet; 36 pairs is a small sample. The gate fails closed, so an error or an unclear reply is "uncertain" and never passes.

## Run

Needs Node 22.18 or newer.

```
cp .env.example .env     # fill in GEMINI_API_KEY and GEMINI_MODEL
npm install
npm test                 # unit tests, no network
npm run eval             # real Gemini calls
```
