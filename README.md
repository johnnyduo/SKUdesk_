# SKUdesk

An agent that finds the cheapest landed cost for a product, works out what a resale would keep, and checks for arbitrage, only on identical products. Gemini decides whether two listings are the same item. Code checks the evidence it relied on. If nothing matches, or no gap survives the costs, the answer is no. The agent never spends money: every buy is a proposal that a person approves.

Live at https://skudesk.lol

## How a check works

1. Search Google Shopping (the eBay adapter is written but has not been run against the live API).
2. Gemini compares each listing with the product you asked for and quotes the brand and set number it used. Code confirms the quotes are in the listing text. A claim it cannot back up is "uncertain" and never passes.
3. Offers priced far below the median, or below half the retail price Gemini recalls, are set aside as bad data.
4. Landed cost, fees, shipping and the margin floor are worked out in integer cents.
5. If there is a buy, the agent files a proposal. Only the person who ran the check, or the owner, can approve it.

## Layout

| Path | What it is |
|---|---|
| `src/` | The Node service: API, agent, identity gate, source adapters, storage |
| `web/` | The Astro site (landing, desk, opportunities, lots, decisions, radar, approvals, replay, market, limits, owner console, metrics) |
| `eval/` | 43 hand-labelled product pairs and the script that runs them against Gemini |
| `edge/` | The Cloudflare Worker in front of skudesk.lol |
| `deploy/` | Scripts for Cloud Run, Firestore, Scheduler and Secret Manager |
| `test/` | Unit tests, UI tests and a smoke test for a deployed URL |

## Run it

Node 22.18 or newer.

```
cp .env.example .env      # GEMINI_API_KEY, GEMINI_MODEL, SERPAPI_KEY
npm install
npm run web:build         # builds the site into web/dist
npm start                 # http://localhost:8080, data in .cache
npm test                  # unit tests
npm run e2e               # browser tests against a local server with stubbed sources
npm run eval              # runs the labelled pairs against the real Gemini API
npm run smoke -- <url>    # checks a deployed service end to end
./deploy/deploy.sh        # Cloud Run, Firestore, Scheduler, Secret Manager
```

## Owner mode

Anyone can run a check and read every page. Changing the agent needs the owner key: the per-buy limit, the margin floor, the kill switch, the watchlist and manual scans. The key lives in Secret Manager and is entered once per browser tab. Every change and decision goes to an audit log.

The kill switch stops scans, new proposals and approvals. A proposal above the per-buy limit cannot be approved.

## Evaluation

`npm run eval` sends the 43 pairs to Gemini and reports the one number that has to be zero: a pair that should not match but passed the gate. The last run had none, with 41 exact answers and 2 where the model said "uncertain" for a pair labelled different. Most listing texts are written to look like marketplace titles; five are real titles that once slipped through. There are no barcode pairs and no image inputs yet, and 43 pairs is a small sample.

## Not built

Payments. Approving a buy records a decision and unlocks the seller's link. Nothing is charged.
