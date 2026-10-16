# Demo script (about 3 minutes)

Rehearsed on https://skudesk.lol with the data as of 16 Oct 2026. Use Chrome at 1440 x 900, zoom 100%. Unlock owner mode once before recording (the key goes in the box at the top right of any /app page).

## Before you press record

1. `npm run smoke -- https://skudesk.lol` prints "all checks passed".
2. Open /market/ and check the three phones and the Ferrari still show what the script says. Prices are real and move; if one changed, say what the page says. The story holds for any result.
3. /app/orders/ should hold four waiting proposals (two phones, Ferrari, Falcon). Leave them: the check you run on camera makes its own.
4. Do not press "Send to Merchant Center" unless you want a real listing in the SKUDesk account. Preview sends nothing.

## The run

| Time | Page | Do | Say |
|---|---|---|---|
| 0:00 | / | Let the ring turn | "SKUdesk is one agent for three jobs: find the cheapest landed cost, price a resale, and check arbitrage, only on identical products. A person approves every spend." |
| 0:15 | /app/ | Type `Apple iPhone 16 128GB`, press Check (about 5 s, search and verdicts are cached) | "Real Google Shopping results. Gemini compares every listing with the phone and has to quote the brand and model; code checks the quotes are in the listing and reads the storage size and the Pro or Pro Max tier itself." |
| 0:40 | same | Scroll to the identity gate | "Listings Google already labels refurbished never reach the gate. Of ten, five are the same phone, five are other models or accessories." |
| 0:55 | same | Point at the photo pills | "Then Gemini looks at each photo next to the product you asked for. Text alone could pass a case or a box; the photo can only take a match away." |
| 1:10 | same | Point at the verdict | "Cheapest identical is $850 at Mercari. Resold at the next cheapest price, after fees, returns and postage, it loses a hundred dollars. The agent says no, and shows why." |
| 1:25 | /app/ | Run `Google Pixel 9 Pro 256GB` | "Twenty-eight listings, none provably the same, so nothing to buy. The honest answer is no." |
| 1:40 | /market/ (iPhone 16 Pro) | Show the book, then the bids; drag the photo | "Asks on top, each against the average. Below the spread are four buyer agents with different margin floors. Nobody's bid reaches the best ask, because costs take about fifteen percent of a resale." |
| 2:05 | /market/?key=… Ferrari (dropdown) | Pick the LEGO Ferrari | "Same agent, another product. Here the gap is real: three bids reach the best ask." |
| 2:20 | /app/orders/ then /app/listings/ | Approve the Ferrari proposal, open Resale listings, press Preview | "A person approves. Then the owner can list the resale in Google Merchant Center; it is previewed first and sending needs the owner key." |
| 2:40 | /app/analytics/ | Scroll to the evaluation | "Sixty labelled pairs: phones, LEGO, accessories, clones, injected instructions. Zero wrong matches." |
| 2:55 | / | End on the landing page | "Cloud Run, Firestore, Cloud Scheduler, Secret Manager, Gemini and Merchant Center, running at skudesk.lol." |

## If someone asks

- **Is the price real?** It is the asking price Google Shopping returned at the time of the check, not a sold price.
- **Where does the retail price come from?** Gemini's recall, used only to set aside prices that cannot be believed.
- **What does Gemini do besides read titles?** It reads each matching listing's photo, recalls a retail price, and writes the note, which is checked against the computed numbers.
- **Why is the chart short?** Each check adds a point, and the scheduler checks the watchlist on a timer (the Market page shows the time of the next scan).
- **Does it buy anything?** No. A person approves, then completes the purchase on the seller's site.
- **eBay?** The adapter is ready and joins as soon as its key is added.
