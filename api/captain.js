// Serverless function (works on Vercel out of the box; see netlify note in README).
// Holds the Anthropic API key server-side. The browser never sees it.
//
// Flow:
//   1. Pull the manager's squad for the current gameweek from the public FPL API.
//   2. Pull bootstrap (players, teams) + fixtures.
//   3. Compute an expected-return score for each of the manager's players IN CODE
//      (so the LLM is never asked to do arithmetic).
//   4. Hand the pre-ranked, structured picture to Claude and ask for the reasoned
//      call + a differential + a shareable line. Claude reasons, it does not calculate.

const FPL = "https://fantasy.premierleague.com/api";

// ---- small helpers -------------------------------------------------------

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`FPL request failed (${r.status}) for ${url}`);
  return r.json();
}

// Difficulty 1 (easy) .. 5 (hard) -> a 0..1 multiplier where easy fixtures help.
function fixtureFactor(difficulty) {
  const map = { 1: 1.0, 2: 0.85, 3: 0.65, 4: 0.45, 5: 0.3 };
  return map[difficulty] ?? 0.6;
}

// Turn each owned player into a comparable expected-return score.
// This is deliberately simple and transparent; it is the thing you will tune.
function scorePlayer(pl, team, fixtures) {
  const form = parseFloat(pl.form || "0");            // avg pts last games
  const ppg = parseFloat(pl.points_per_game || "0");  // season pts/game
  const minutes = pl.minutes || 0;

  // Minutes security: has this player actually been starting?
  // Rough proxy: share of a full season's minutes so far.
  const minutesSecurity = Math.min(1, minutes / 900); // ~10 full games

  // This gameweek's fixtures for the player's team (can be 0, 1, or 2 in a DGW).
  const teamFixtures = fixtures.filter(
    (f) => f.team_h === team.id || f.team_a === team.id
  );

  let fixtureScore = 0;
  const fixtureLabels = [];
  for (const f of teamFixtures) {
    const isHome = f.team_h === team.id;
    const diff = isHome ? f.team_h_difficulty : f.team_a_difficulty;
    fixtureScore += fixtureFactor(diff);
    fixtureLabels.push({
      home: isHome,
      difficulty: diff,
      opponentTeamId: isHome ? f.team_a : f.team_h,
    });
  }
  // If FPL hasn't attached fixtures yet, don't zero the player out.
  if (teamFixtures.length === 0) fixtureScore = 0.5;

  // Final blended score. Weights are yours to tune once you see real output.
  const score =
    (0.45 * form + 0.35 * ppg) * (0.6 + 0.4 * fixtureScore) * (0.5 + 0.5 * minutesSecurity);

  return {
    id: pl.id,
    name: pl.web_name,
    teamName: team.name,
    price: (pl.now_cost / 10).toFixed(1),
    form,
    pointsPerGame: ppg,
    minutes,
    minutesSecurity: +minutesSecurity.toFixed(2),
    onPenalties: pl.penalties_order === 1,
    status: pl.status, // 'a' available, 'i' injured, 'd' doubt, 's' suspended
    news: pl.news || "",
    fixtures: fixtureLabels,
    isDoubleGameweek: teamFixtures.length > 1,
    score: +score.toFixed(3),
  };
}

// ---- main handler --------------------------------------------------------

export default async function handler(req, res) {
  try {
    const teamId = (req.query?.teamId || req.body?.teamId || "").toString().trim();
    if (!/^\d+$/.test(teamId)) {
      return res
        .status(400)
        .json({ error: "Enter your numeric FPL team ID (the number in your team's URL)." });
    }

    // 1. Bootstrap: all players, all teams, and which gameweek is current.
    const bootstrap = await getJSON(`${FPL}/bootstrap-static/`);
    const events = bootstrap.events || [];
    const currentEvent =
      events.find((e) => e.is_current) ||
      events.find((e) => e.is_next) ||
      events[0];
    if (!currentEvent) throw new Error("Could not determine the current gameweek.");
    const gw = currentEvent.id;

    const teamsById = Object.fromEntries(bootstrap.teams.map((t) => [t.id, t]));
    const playersById = Object.fromEntries(bootstrap.elements.map((p) => [p.id, p]));

    // 2. The manager's picks for this gameweek.
    let picks;
    try {
      picks = await getJSON(`${FPL}/entry/${teamId}/event/${gw}/picks/`);
    } catch (e) {
      return res.status(404).json({
        error:
          "Couldn't find picks for that team ID this gameweek. Check the ID, and note picks are hidden until the gameweek's first deadline has passed.",
      });
    }

    // 3. Fixtures for this gameweek.
    const fixtures = await getJSON(`${FPL}/fixtures/?event=${gw}`);

    // 4. Score each STARTING player (positions 1-11 in FPL picks).
    const starters = picks.picks
      .filter((pk) => pk.position <= 11)
      .map((pk) => {
        const pl = playersById[pk.element];
        const team = teamsById[pl.team];
        return scorePlayer(pl, team, fixtures);
      });

    // Attach readable opponent names now that we have the map.
    for (const s of starters) {
      s.fixtures = s.fixtures.map((f) => ({
        opponent: teamsById[f.opponentTeamId]?.short_name || "?",
        home: f.home,
        difficulty: f.difficulty,
      }));
    }

    // Rank in code. The LLM receives this already sorted.
    starters.sort((a, b) => b.score - a.score);

    // 5. Ask Claude to reason over the pre-ranked picture.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Still return the ranking so the app is useful even without the key.
      return res.status(200).json({
        gameweek: gw,
        ranked: starters,
        reasoning: null,
        note: "ANTHROPIC_API_KEY not set — showing the raw ranking only.",
      });
    }

    const prompt = buildPrompt(gw, starters);
    const claude = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claude.ok) {
      const text = await claude.text();
      return res.status(200).json({
        gameweek: gw,
        ranked: starters,
        reasoning: null,
        note: `Ranking computed, but the reasoning step failed (${claude.status}). ${text.slice(0, 200)}`,
      });
    }

    const data = await claude.json();
    const raw = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
      .trim();

    let reasoning = null;
    try {
      reasoning = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch {
      reasoning = { pick: null, differential: null, shareable: null, raw };
    }

    return res.status(200).json({ gameweek: gw, ranked: starters, reasoning });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Something went wrong." });
  }
}

function buildPrompt(gw, ranked) {
  return `You are an expert Fantasy Premier League analyst helping a manager choose their captain for gameweek ${gw}.

Below is their starting XI, ALREADY RANKED by a computed expected-return score (highest first). The numbers are correct — do not recompute them. Your job is judgment and explanation, not arithmetic.

For each player you have: name, team, price, recent form, season points-per-game, minutes security (0-1, how nailed-on they are to start), penalty duty, injury/availability status and news, this gameweek's fixture(s) with opponent and difficulty (1 easy - 5 hard), and whether it's a double gameweek.

Squad (ranked):
${JSON.stringify(ranked, null, 2)}

Rules for your call:
- The computed ranking is a strong prior, but you may override the top score if judgment demands it (e.g. an injury doubt, a much safer floor, a double gameweek lower down). If you override, say so explicitly.
- "pick" = your recommended captain. "differential" = a lower-owned / braver alternative for someone chasing rank.
- Never recommend a player whose status is 'i' (injured) or 's' (suspended) as the captain.
- Keep each reason to ONE sharp sentence a manager would actually trust. No hedging, no filler.
- "shareable" = one confident, slightly cocky line (max 25 words) the manager can paste into their FPL group chat announcing their captain. Fun, not cringe.

Respond with ONLY valid JSON, no markdown, in exactly this shape:
{
  "pick": { "name": "", "reason": "" },
  "differential": { "name": "", "reason": "" },
  "shareable": ""
}`;
}
