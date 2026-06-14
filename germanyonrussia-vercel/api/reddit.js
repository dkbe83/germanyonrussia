// /api/reddit.js
// Fetches Reddit posts about Russia/Germany from relevant subreddits
// Uses Reddit public JSON API — completely free, no auth needed for read access
// Rate limit: 60 requests/minute unauthenticated

import { createClient } from 'redis';

async function getRedisClient() {
  const client = createClient({ url: process.env.REDIS_URL });
  client.on('error', () => {});
  await client.connect();
  return client;
}

// Subreddits with relevant Germany/Russia discourse
const SUBREDDITS = [
  { name: 'de', weight: 1.4 },           // Largest German-language subreddit
  { name: 'ich_iel', weight: 0.6 },       // German culture, lighter
  { name: 'europe', weight: 1.0 },        // European perspective
  { name: 'geopolitics', weight: 1.2 },   // Expert-level analysis
  { name: 'ukraine', weight: 1.3 },       // Ukraine-focused
  { name: 'worldnews', weight: 0.8 },     // Global news with Germany filter
  { name: 'germany', weight: 1.1 },       // English-language Germany subreddit
];

const RUSSIA_KW = [
  'russland','russia','russian','ukraine','ukrainian','putin','moscow','kremlin',
  'zelensky','zelenskyy','selenskyj','lavrov','crimea','donbas','bucha',
  'mariupol','kherson','zaporizhzhia','nordstream','wagner','sanctions',
  'waffenstillstand','ceasefire','kriegsmüdigkeit','war fatigue',
  'ostpolitik','nato','scholz','baerbock','bundeswehr',
];

const EXCLUDE_KW = [
  'iran','israel','gaza','hamas','china','taiwan','north korea',
  'afghanistan','tren de aragua','venezuela',
];

function isRelevant(text) {
  const t = (text || '').toLowerCase();
  if (!RUSSIA_KW.some(k => t.includes(k))) return false;
  const excl = EXCLUDE_KW.filter(k => t.includes(k)).length;
  const russ = RUSSIA_KW.filter(k => t.includes(k)).length;
  return excl < russ;
}

function detectSentiment(title, text = '') {
  const t = (title + ' ' + text).toLowerCase();
  const negateNext = ['no ','not ','kein','ohne','scheitern','failed','rejected','impossible'];
  const hasNegation = negateNext.some(n => t.includes(n));

  const negKW = ['attack','angriff','offensive','missile','drone','drohne','rakete',
    'casualt','killed','dead','bombing','bombardier','escalat','eskalation',
    'sanctions tighten','annexat','war crime','repression','arrested'];
  const posKW = ['ceasefire','waffenstillstand','negotiat','verhandl','peace','frieden',
    'dialog','agreement','einigung','diplomacy','de-escalat','deeskalation',
    'war fatigue','kriegsmüdigkeit','talks','gespräch'];

  const negC = negKW.filter(k => t.includes(k)).length;
  const posC = posKW.filter(k => t.includes(k)).length;

  if (posC > 0 && hasNegation && negC === 0) return { sent: 'neg', score: 30 };
  if (negC > posC) return { sent: 'neg', score: Math.min(85, 50 + negC * 8) };
  if (posC > negC) return { sent: 'pos', score: Math.min(80, 45 + posC * 8) };
  return { sent: 'neu', score: 45 };
}

function ovFromPost(title, sent) {
  const t = (title || '').toLowerCase();
  if (t.includes('ceasefire') || t.includes('waffenstillstand') || t.includes('negotiat'))
    return '→ Dialogue position discussed in public discourse';
  if (t.includes('war fatigue') || t.includes('kriegsmüdigkeit') || t.includes('tired'))
    return '→ War fatigue signal — window drift visible in public';
  if (t.includes('sanction') || t.includes('weapon') || t.includes('arms'))
    return '→ Hawkish framing dominant in public discourse';
  if (t.includes('attack') || t.includes('missile') || t.includes('drone'))
    return '→ Security framing narrows window';
  if (sent === 'pos') return '→ Dialogue-oriented framing in public discourse';
  if (sent === 'neg') return '→ Conflict framing reinforces hawkish window';
  return '→ Russia discourse active in public sphere';
}

async function fetchSubreddit(subreddit, limit = 10) {
  try {
    const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=25&raw_json=1`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'GermanyOnRussia/1.0 Overton Window Monitor' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    const posts = d?.data?.children || [];

    return posts
      .map(p => p.data)
      .filter(p => p && !p.stickied && p.score > 5)
      .filter(p => isRelevant(p.title + ' ' + (p.selftext || '')))
      .slice(0, limit)
      .map(p => {
        const { sent, score } = detectSentiment(p.title, p.selftext || '');
        return {
          handle: `r/${p.subreddit}`,
          author: `u/${p.author}`,
          text: p.title,
          excerpt: (p.selftext || '').slice(0, 200) || null,
          time: new Date(p.created_utc * 1000).toISOString(),
          link: `https://reddit.com${p.permalink}`,
          likes: p.score,
          comments: p.num_comments,
          sent,
          score,
          ov: ovFromPost(p.title, sent),
          subreddit: p.subreddit,
        };
      });
  } catch (e) {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  const cacheKey = 'reddit:latest';

  // Check Redis cache (30 min)
  let redisClient;
  try {
    redisClient = await getRedisClient();
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const data = JSON.parse(cached);
      if (Date.now() - data.ts < 30 * 60 * 1000) {
        await redisClient.quit();
        return res.status(200).json({ ok: true, source: 'cache', data: data.posts });
      }
    }
  } catch (e) {}

  // Fetch all subreddits in parallel
  const results = await Promise.allSettled(
    SUBREDDITS.map(s => fetchSubreddit(s.name, 8))
  );

  let allPosts = results
    .flatMap((r, i) => r.status === 'fulfilled'
      ? r.value.map(p => ({ ...p, weight: SUBREDDITS[i].weight }))
      : []
    )
    // Sort by weighted score (upvotes × subreddit weight)
    .sort((a, b) => (b.likes * b.weight) - (a.likes * a.weight))
    // Deduplicate by title similarity
    .filter((post, idx, arr) =>
      arr.findIndex(p => p.text.slice(0, 40) === post.text.slice(0, 40)) === idx
    )
    .slice(0, 15);

  // Compute Reddit sentiment for Overton contribution
  const sentimentSummary = {
    neg: allPosts.filter(p => p.sent === 'neg').length,
    neu: allPosts.filter(p => p.sent === 'neu').length,
    pos: allPosts.filter(p => p.sent === 'pos').length,
    total: allPosts.length,
    avgScore: allPosts.length
      ? Math.round(allPosts.reduce((s, p) => s + p.score, 0) / allPosts.length)
      : 45,
  };

  // Store Reddit sentiment contribution in Redis for cron to use
  if (redisClient) {
    try {
      const payload = { posts: allPosts, sentiment: sentimentSummary, ts: Date.now() };
      await redisClient.set(cacheKey, JSON.stringify(payload), { EX: 3600 });
      // Also store sentiment separately for cron.js to read
      await redisClient.set('reddit:sentiment', JSON.stringify({
        ...sentimentSummary,
        date: new Date().toISOString().slice(0, 10),
      }), { EX: 86400 });
      await redisClient.quit();
    } catch (e) { await redisClient.quit().catch(() => {}); }
  }

  return res.status(200).json({
    ok: true,
    source: 'live',
    count: allPosts.length,
    sentiment: sentimentSummary,
    data: allPosts,
  });
}
