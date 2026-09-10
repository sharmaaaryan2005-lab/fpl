# The Armband — FPL captaincy call (v1)

Your real squad + this week's fixtures and form → one reasoned captain pick, a braver differential, and a line for the group chat.

## How it works

- **Frontend** (`public/index.html`): single page. Manager enters their FPL team ID.
- **Backend** (`api/captain.js`): a serverless function that
  1. pulls the manager's starting XI + fixtures + form from the **official public FPL API**,
  2. **computes an expected-return score for each player in code** (form + fixture difficulty + minutes security), and ranks them,
  3. hands that pre-ranked, structured picture to Claude, which does the **judgment and writing** — not the maths.

This split is deliberate: the LLM never does arithmetic (where it's unreliable), so the pick is grounded in real numbers but explained in language a manager trusts.

## Deploy (Vercel — easiest)

1. Push this folder to a GitHub repo.
2. Import it at vercel.com → New Project.
3. Add an environment variable: `ANTHROPIC_API_KEY` = your key from console.anthropic.com.
4. Deploy. That's it — `api/captain.js` becomes `/api/captain` automatically.

Without the key the app still runs and shows the raw ranking; it just skips the written reasoning. So you can deploy and see the data spine working before you add the key.

## Deploy (Netlify)

Move `api/captain.js` to `netlify/functions/captain.js` and change the frontend fetch URL from `/api/captain` to `/.netlify/functions/captain`. Set `ANTHROPIC_API_KEY` in Site settings → Environment. Everything else is identical.

## Finding a team ID (for testing)

Any public team works. Log in, open your team, and the URL is `.../entry/<ID>/event/...`. That number is the ID. Picks are only visible after a gameweek's first deadline.

## Tuning (this is where v1 becomes pitch-perfect)

The weights live in `scorePlayer()` in `api/captain.js`. The blend of form / points-per-game / fixture / minutes is intentionally simple and readable — run it against your own team a few gameweeks and adjust until the top of the ranking matches your gut. That tuning IS the product edge.

## Growing into v2 — transfers

The captaincy engine already scores players on expected return. Transfers reuses it:
- score players the manager **doesn't** own (loop over `bootstrap.elements`, same `scorePlayer`),
- compare the best available upgrade per position against their weakest starter,
- have Claude judge whether the expected point gain clears the −4 hit.

Same input (team ID), same data pull, same reasoning style, same shell. No rebuild — just point the scorer wider.

## Not in v1 (on purpose)

- No scraping of tip sites / Reddit (copyright risk; the official API gives the facts that actually drive the call).
- No betting/odds integration (legal risk, especially in India; little accuracy gain).

Both can come later as a *clean* consolidation layer, if the core proves people come back.
