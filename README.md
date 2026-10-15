# SKUdesk

One agent for retail buyers and sellers. Given a product, it finds the cheapest landed cost, prices a resale, and checks for arbitrage, **only for identical products**. A Gemini Identity Engine is the single gate: if no listing is provably the same item, or no gap survives all costs, the agent says so. A person approves every spend.

Built for the Google Cloud AI Builder Cup 2026, Retail & Commerce. The concept and the visual design (stylesheets, fonts, the page's look) build on the team's earlier work. The application code, data layer, Identity Engine and evaluation were written for this competition.

**Live:** https://skudesk.lol (Cloud Run service, direct URL https://skudesk-ij5vrivnta-as.a.run.app) · **Deck:** [deck/SKUdesk-deck.pdf](deck/SKUdesk-deck.pdf) · **Video script:** [video/script.md](video/script.md)

## What it does

1. **Search.** Google Shopping through SerpApi (eBay Browse API is supported and turns on when its keys are set). Every paid call is cached.
2. **Identity gate.** Gemini compares each listing with the product you asked for. It must copy the brand and set/model number out of both listings; code then checks those quotes really appear in the text. A claim it cannot back up becomes "uncertain" and never passes.
3. **Price sanity.** Same product does not mean a believable price. Offers far below the median, or below half of the retail price Gemini recalls, are set aside as probable data errors or bait.
4. **Economics.** Integer-cent landed cost, resale fees and shipping, margin floor. Verdicts: profitable, thin, loss, or "too good to be true".
5. **Human approval.** The agent only files a pending proposal. SKUdesk never holds payment details; approving unlocks the seller link and logs the decision.

## Real results, 2026-10-15 (live data, US market)

| Query | Outcome |
|---|---|
| LEGO 10294 Titanic | 30 listings checked, 7 identical. Two "identical" offers at $11 and $19 set aside as bad prices. Cheapest real offer $645 landed; resale would lose $82. **No arbitrage.** |
| LEGO Star Wars Millennium Falcon 75192 | 3 identical, 2 of them set aside ($102 and $364.50 against an $849.99 retail). One credible offer, so no gap to trade. |
| LEGO Icons Orchid 10311 | 30 checked, 0 identical (generic "building blocks" reusing the set number). **Nothing to buy.** |

An honest "no" is the expected common answer; the unit tests cover the profitable path.

## Also in the page

Live progress while a check runs (each listing lights up green, red or amber as Gemini judges it), a price ladder against the recalled retail price, the quoted evidence shown on every identical offer, a short Gemini note whose every number is verified against the computed facts, running totals of what the gate has caught, and a downloadable evidence file per check.

## Identity eval

`npm run eval` sends 43 hand-labelled pairs to the real Gemini API (the model is set by `GEMINI_MODEL` in `.env`) and reports the number that must be zero: a pair that should not match but passed the gate. Current result: **0 false-identical**, 41 exact, 2 safe disagreements (labelled different, answered uncertain).

The set includes real marketplace titles captured the day the gate wrongly passed them. That is how the evidence check was found: the model credited listings with a "LEGO" brand they never wrote. Limits, stated plainly: most listing texts are hand-written to look like marketplace titles; labels come from LEGO set numbers; no GTIN pairs and no image inputs yet; 43 pairs is a small sample.

## Owner mode and security

Anyone can run a check and read every page. Anything that changes the agent needs the **owner key** (kept in Secret Manager, entered once per tab, compared in constant time): the per-buy limit, the margin floor, the kill switch, the watchlist and manual scans.

- Approvals need the requester's one-time token (shown only to whoever ran the check, stored as a hash) or the owner key. A proposal above the per-buy limit is blocked; while the agent is paused nothing can be approved.
- Strict policy: scripts only from the site's own origin, no inline script, listing text only ever set as text. Product images go through an allow-listed proxy.
- Rate limits per caller (the caller address is trusted only when it comes from our own edge with a shared secret), a cap on concurrent checks, a monthly search budget, a request size limit, and an audit log of every change and decision.
- The model name is never sent to the browser.

## Architecture

A static Astro site ([web/](web/)) served by a small Node service on Cloud Run (TypeScript run directly, no framework, deployed from source), behind a Cloudflare Worker front door for skudesk.lol ([edge/](edge/), forwards requests only) · Firestore (database `skudesk`: cache, analyses, proposals, scans) · Cloud Scheduler (daily watchlist scan) · Secret Manager · Gemini API · SerpApi. One service account with Firestore access limited to the `skudesk` database.

## Status

| Part | State |
|---|---|
| Identity Engine with evidence check | Done, real Gemini |
| Cost and arbitrage maths | Done, unit-tested |
| SerpApi adapter, cache, monthly cap | Done, real data |
| eBay adapter | Written and parser-tested on a documented-shape sample; **not run against the live API** (no keys yet) |
| Cloud Run, Firestore, Scheduler | Deployed, smoke-tested end to end |
| Site ([web/](web/)) | Done: landing with a 3D ring of real checked products, Desk, Opportunities, Lots, Decisions, Radar, Approvals, Agent decision replay, Offer market, Deploy agent, Limits with simulator, Owner console, Run metrics, Deployment, Dependencies. Visual design carried over from the team's earlier project |
| Payments | Not built, on purpose. Approval is a decision log, not a purchase. |

## Run

Needs Node 22.18 or newer.

```
cp .env.example .env     # GEMINI_API_KEY, GEMINI_MODEL, SERPAPI_KEY
npm install
npm test                 # unit tests, no network
npm run eval             # real Gemini calls
npm run web:build        # build the site (Astro) into web/dist
npm start                # local server on :8080, file-backed store
npm run smoke -- <url>   # end-to-end check of a deployed service
./deploy/deploy.sh       # Cloud Run + Firestore + Scheduler (see the script header)
```
