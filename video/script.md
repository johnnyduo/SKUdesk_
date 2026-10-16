# SKUdesk demo video script (2:23)

Built with the pipeline in video/pipeline: stills captured from the live site (capture.mjs), a male text-to-speech voice (tts.mjs), a timeline with burned-in subtitles, chapter titles and a quiet synthesized bed (build-data.mjs, render.mjs, mix.mjs). The owner key is never shown.


## The hook

Shopping agents are great at finding a cheap price. But a cheap price is useless if it is for the wrong product.

SKUdesk puts one gate in front of every number: is this listing provably the same item? If nothing is, the answer is no.


## Step 1 · A live check

Here is a live check on Google Cloud. SKUdesk searches Google Shopping, and Gemini judges every listing. Green is the identical product, red is something else, amber is not provable.

It answers in plain terms: what to buy, what a resale would keep, and whether any gap survives every cost.

The price ladder shows every offer that matched, and each one carries the brand and set number Gemini quoted from the listing, which code verifies.


## Step 2 · A person decides

Nothing is bought without a person. The agent files a proposal, and only the person who ran the check, or the owner, can approve it.

For a LEGO Titanic, seven of thirty listings pass. Two more match the set but are priced at eleven and nineteen dollars, so they are set aside as bad data. The cheapest real offer loses money on resale. The answer is no arbitrage.


## Step 3 · Replay

Every check can be replayed line by line: the search, each verdict, the evidence code verified, and the proposal it filed. A decision is never a black box.


## Step 4 · The offer market

The offer market tracks each product's ladder of identical offers. A daily Cloud Scheduler scan keeps the price history growing.


## Step 5 · Evidence

Gemini is not simply trusted. It must quote the brand and set number from both listings, and code checks that the quotes are really there. A claim it cannot back up never passes.

Across forty-three hand-labelled pairs against the real model, zero wrong matches passed. The limits of that test are written on the page.


## Step 6 · Limits and control

The owner holds the controls: a per-buy limit, a margin floor, and a kill switch that stops scans, new proposals and approvals. They need a key, and every change goes in the audit log.

A what-if simulator runs the same economics as a real check, so you can test any price against the current limits.


## Built on Google Cloud

It runs on Cloud Run with Firestore, Cloud Scheduler and Secret Manager, under a strict content policy, with rate limits and a monthly search budget.


## Try it

SKUdesk. If nothing is provably the same, it says no.

