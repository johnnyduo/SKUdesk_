# SKUdesk demo video script (under 3 minutes)

Recorded against the live deployment with a text-to-speech voice. Every number on screen comes from the running service.

1. **Title.** SKUdesk. One agent that buys cheapest, helps you sell, and finds arbitrage, only for the identical product.
2. **Problem.** Price comparison breaks when two listings are not the same item. Search a LEGO Titanic and you get light kits, imitation blocks, and sets listed at eleven dollars.
3. **Live run.** This is SKUdesk, live on Google Cloud Run. I enter a set number. It searches Google Shopping, then Gemini decides, for every listing, whether it is the identical product.
4. **Result.** Thirty listings checked. Seven pass as identical. The cheapest real offer is six hundred forty-five dollars landed, and reselling at the next price loses eighty-two. So the answer is: no arbitrage.
5. **Bad prices.** Two offers matched the product but were listed at eleven and nineteen dollars, against a retail price of six hundred seventy-nine that Gemini recalls. SKUdesk sets them aside as bad data instead of trading on them.
6. **Reasons.** Every rejected listing comes with a reason, like light kits, imitation blocks, or used items.
7. **Evidence check.** Gemini is not simply trusted. It must quote the brand and set number from both listings, and code checks the quotes are really there. On real listings this caught imitation sets that reuse a set number. Across forty-three labelled pairs against real Gemini, zero wrong matches passed.
8. **Approval.** Nothing is bought without a person. The agent files a proposal, and I approve or reject it. SKUdesk never holds payment details.
9. **Honest no.** When nothing is provably the same, it says so. Here, an orchid set: thirty listings, zero identical, no proposal.
10. **Google Cloud.** Cloud Scheduler re-checks a watchlist every day, Firestore keeps the cache, proposals and history, and Gemini does the identity work on Cloud Run.
11. **Close.** SKUdesk. If nothing is provably the same, it says no. The live link and code are in the submission.
