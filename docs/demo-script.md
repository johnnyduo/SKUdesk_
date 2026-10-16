# Demo script (about 3 minutes)

Rehearsed on https://skudesk.lol with the data as of 16 Oct 2026. Page timings are from that run on a normal connection.
Use Chrome at 1440 x 900, zoom 100%. Unlock owner mode once before recording (the key goes in the box at the top right of any /app page).

## Before you press record

1. `npm run smoke -- https://skudesk.lol` prints "all checks passed".
2. Open /market/ and confirm the Ferrari (42143) still shows a best ask near $525 with three agents taking it. Prices are real and move; if the product has changed, run the desk check on it and use whatever the page says (the story below holds for any "profitable" or "loss" result).
3. /app/orders/ has two scan proposals waiting (Ferrari, Falcon). Leave them: the check you run on camera makes its own.
4. Do not press "Send to Merchant Center" unless you want a real listing in the SKUDesk account. The preview button sends nothing.

## The run

| Time | Page | Do | Say |
|---|---|---|---|
| 0:00 | / | Let the ring turn for a few seconds | "SKUdesk is one agent for three jobs: find the cheapest landed cost, price a resale, and check arbitrage, only on identical products. A person approves every spend." |
| 0:15 | /app/ | Type `LEGO Technic Ferrari Daytona SP3 42143`, press Run (about 4 s, the search is cached) | "Real Google Shopping results. Gemini compares every listing with the product and has to quote the brand and set number. Code checks the quotes are really in the listing." |
| 0:35 | same | Point at the result | "Thirty listings, six are the same product, three are set aside as too good to be true. Best landed cost $525 at BrickFever. Resale at the next cheapest identical price, $700.42. After fees, returns and postage it nets $55.36, ten and a half percent." |
| 0:55 | same | Click Approve in the approval panel | "Only the person who ran the check, or the owner, can approve. Nothing is charged: approval opens the seller's page." |
| 1:10 | /market/ (Ferrari) | Show the book, then the bids | "Asks on top, each against the average of the identical offers. Below the spread are four buyer agents. Each is the same cost model with a different margin floor, and its bid is the most it could pay and still clear that floor. Three of them reach the best ask. The patient one wants twenty percent and waits." |
| 1:40 | same | Drag the 3D photo, open the dropdown, pick PS5 | "Every product has its own page of the book. Reference products like this one are 3D models with their list price." |
| 1:55 | /app/listings/ | Pick the approved buy, press Preview | "Once a buy is approved the owner can list the resale in Google Merchant Center. It is previewed first: title, price, and the product page Google will read. Sending needs the owner key." |
| 2:15 | /app/owner/ | Press Pause the agent, then open /app/orders/ | "The kill switch stops scans, new proposals and approvals at once." Press Resume when done. |
| 2:35 | /app/analytics/ | Scroll to the evaluation | "On 43 labelled pairs the identity gate let through zero wrong matches. When it is not sure it says uncertain, and the agent says no." |
| 2:50 | / | End on the landing page | "Cloud Run, Firestore, Cloud Scheduler, Secret Manager, Gemini, and Merchant Center, all running at skudesk.lol." |

## If someone asks

- **Is the price real?** It is the asking price Google Shopping returned at the time of the check, not a sold price.
- **Where does the retail price come from?** Gemini's recall, used only to set aside prices that cannot be believed. It is labelled as recalled everywhere.
- **Why is the chart short?** Each check adds a point and the scheduler adds one every night at 02:00 UTC, so it grows by itself.
- **Does it buy anything?** No. A person approves, then completes the purchase on the seller's site.
- **eBay?** The adapter is ready and joins as soon as its key is added.

## Pages and what they take

/ 6 s, /app/ check 4 s, /show/ 5 s, /market/ 4 s, /app/opportunities/ 2 s, /app/orders/ 3 s, /app/listings/ 3 s, /app/owner/ 3 s, /app/analytics/ 3 s. No script errors on any page.
