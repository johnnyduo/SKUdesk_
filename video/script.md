# SKUdesk demo video script (about 2 minutes)

Recorded against the live deployment (skudesk.lol) with a text-to-speech voice. Every number on screen comes from the running service.

1. **Title.** SKUdesk. One agent that buys cheapest, helps you sell, and finds arbitrage, only for the identical product.
2. **Problem.** Search results for a LEGO set are full of light kits, imitation blocks and prices that cannot be real. Price comparison breaks when two listings are not the same item.
3. **Live run.** Here is a live run on Google Cloud. SKUdesk searches Google Shopping, and Gemini judges every listing. Green is the identical product, red is something else, amber is not provable.
4. **Answer.** It answers in plain terms, shows the price ladder, and keeps the evidence: the brand and set number Gemini quoted from the listing.
5. **Approval.** Nothing is bought without a person. The agent files a proposal, and I approve or reject it. SKUdesk never holds payment details.
6. **Honest no.** On a cached run for a LEGO Titanic: thirty listings, seven pass as identical. Two matched the set but were listed at eleven and nineteen dollars, against a six seventy-nine retail price, so they are set aside. The cheapest real offer is six forty-five landed, and reselling loses eighty-two. The answer is no arbitrage.
7. **Evidence check.** Gemini is not simply trusted. It must quote the brand and set number from both listings, and code checks the quotes are really there. Across forty-three labelled pairs against real Gemini, zero wrong matches passed.
8. **Nothing identical.** When nothing is provably the same, it says so. Here, an orchid set: nothing cleared the gate, and no proposal is filed.
9. **Google Cloud.** Cloud Scheduler re-checks a watchlist every day, Firestore keeps the cache, proposals and history, and Gemini does the identity work on Cloud Run.
10. **Close.** SKUdesk. If nothing is provably the same, it says no. The live link and code are in the submission.
