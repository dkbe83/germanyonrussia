// /api/x.js
// Fetches X/Twitter list timeline via X API v2 (Free tier)
// Requires: X_BEARER_TOKEN environment variable
// Free tier: 500k reads/month — more than enough

import { createClient } from 'redis';

async function getRedisClient() {
  const client = createClient({ url: process.env.REDIS_URL });
  client.on('error', () => {});
  await client.connect();
  return client;
}

const LIST_IDS = {
  experts:    '2065408650881998940',
  influencers: '2065413177911763352',
};

const RUSSIA_KW = [
  'russland','russia','russian','ukraine','ukrainian','putin','moscow','kremlin',
  'zelensky','zelenskyy','selenskyj','lavrov','crimea','donbas','sanctions',
  'waffenstillstand','ceasefire','kriegsmüdigkeit','war fatigue','ostpolitik',
  'nordstream','wagner','meduza','bucha','mariupol','kherson',
];

function isRelevant(text) {
  const t = (text||'').toLowerCase();
  return RUSSIA_KW.some(k => t.includes(k));
}

function detectSentiment(text) {
  const t = (text||'').toLowerCase();
  const neg = ['angriff','attack','offensive','bombardier','rakete','missile','drohne',
    'drone','eskalation','escalat','sanction','verhaftet','arrested','casualt','opfer'];
  const pos = ['waffenstillstand','ceasefire','verhandl','negotiat','frieden','peace',
    'dialog','einigung','agreement','diplomatie','war fatigue','kriegsmüdigkeit'];
  const negH = neg.filter(k=>t.includes(k)).length;
  const posH = pos.filter(k=>t.includes(k)).length;
  if(negH>posH) return 'neg';
  if(posH>negH) return 'pos';
  return 'neu';
}

async function fetchListTweets(listId, maxResults = 20) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return null;

  const url = `https://api.twitter.com/2/lists/${listId}/tweets?` +
    `max_results=${maxResults}` +
    `&tweet.fields=created_at,author_id,text,public_metrics` +
    `&expansions=author_id` +
    `&user.fields=name,username`;

  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      console.error(`X API error: ${r.status} ${r.statusText}`);
      return null;
    }
    const d = await r.json();
    if (!d.data) return [];

    // Build user lookup map
    const users = {};
    (d.includes?.users || []).forEach(u => { users[u.id] = u; });

    // List is already curated — show all posts, filter only obvious non-Russia content
    const HARD_EXCLUDE = ['bundesliga','formel 1','basketball','fußball','weather','wetter'];
    return d.data
      .filter(tweet => !HARD_EXCLUDE.some(k => tweet.text.toLowerCase().includes(k)))
      .map(tweet => {
        const user = users[tweet.author_id] || {};
        return {
          handle: `@${user.username || 'unknown'}`,
          name: user.name || '',
          text: tweet.text,
          time: tweet.created_at || '',
          likes: tweet.public_metrics?.like_count || 0,
          retweets: tweet.public_metrics?.retweet_count || 0,
          url: `https://x.com/${user.username}/status/${tweet.id}`,
          sent: detectSentiment(tweet.text),
        };
      });
  } catch (e) {
    console.error('X API fetch error:', e.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800'); // 15 min cache

  const { list = 'experts' } = req.query;
  const listId = LIST_IDS[list] || LIST_IDS.experts;
  const cacheKey = `x:list:${list}`;

  // Check Redis cache first
  let redisClient;
  try {
    redisClient = await getRedisClient();
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const data = JSON.parse(cached);
      if (Date.now() - data.ts < 15 * 60 * 1000) { // 15 min
        await redisClient.quit();
        return res.status(200).json({ ok: true, source: 'cache', data: data.tweets });
      }
    }
  } catch (e) { /* continue without cache */ }

  // Check if bearer token is configured
  if (!process.env.X_BEARER_TOKEN) {
    if (redisClient) await redisClient.quit().catch(() => {});
    return res.status(200).json({
      ok: false,
      reason: 'X_BEARER_TOKEN not configured',
      setup: 'Add X_BEARER_TOKEN to Vercel environment variables. Get it free at developer.twitter.com',
    });
  }

  const tweets = await fetchListTweets(listId);

  if (!tweets) {
    if (redisClient) await redisClient.quit().catch(() => {});
    return res.status(200).json({ ok: false, reason: 'X API unavailable' });
  }

  // Cache result
  if (redisClient) {
    try {
      await redisClient.set(cacheKey, JSON.stringify({ tweets, ts: Date.now() }), { EX: 900 });
      await redisClient.quit();
    } catch (e) { await redisClient.quit().catch(() => {}); }
  }

  return res.status(200).json({ ok: true, source: 'live', count: tweets.length, data: tweets });
}
