// /api/reddit.js
// Fetches Reddit posts via RSS (bypasses IP blocks on direct Reddit API)
// Uses rss2json.com proxy — same as news feed, works reliably on Vercel

import { createClient } from 'redis';

async function getRedisClient() {
  const client = createClient({ url: process.env.REDIS_URL });
  client.on('error', () => {});
  await client.connect();
  return client;
}

const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';

// Reddit RSS feeds — these work through rss2json proxy
const REDDIT_RSS = [
  { name: 'r/de',           url: 'https://www.reddit.com/r/de/search.rss?q=russland+OR+ukraine+OR+putin&sort=hot&t=week', weight: 1.4 },
  { name: 'r/europe',       url: 'https://www.reddit.com/r/europe/search.rss?q=russia+OR+ukraine+OR+putin+OR+germany&sort=hot&t=week', weight: 1.0 },
  { name: 'r/germany',      url: 'https://www.reddit.com/r/germany/search.rss?q=russia+OR+ukraine+OR+krieg&sort=hot&t=week', weight: 1.1 },
  { name: 'r/ukraine',      url: 'https://www.reddit.com/r/ukraine/hot.rss', weight: 1.2 },
  { name: 'r/geopolitics',  url: 'https://www.reddit.com/r/geopolitics/search.rss?q=russia+OR+germany+OR+ukraine&sort=hot&t=week', weight: 1.2 },
  { name: 'r/worldnews',    url: 'https://www.reddit.com/r/worldnews/search.rss?q=russia+germany+OR+ukraine+germany&sort=hot&t=week', weight: 0.9 },
];

const RUSSIA_KW = [
  'russia','russian','ukraine','ukrainian','putin','moscow','kremlin',
  'zelensky','lavrov','crimea','donbas','sanctions','ceasefire',
  'russland','ukraine','putin','moskau','kreml','selenskyj','waffenstillstand',
  'kriegsmüdigkeit','ostpolitik','nordstream','wagner','bucha','mariupol',
];

const EXCLUDE_KW = [
  'iran','israel','gaza','hamas','china','taiwan','north korea','afghanistan',
];

function isRelevant(text) {
  const t = (text || '').toLowerCase();
  if (!RUSSIA_KW.some(k => t.includes(k))) return false;
  const excl = EXCLUDE_KW.filter(k => t.includes(k)).length;
  const russ = RUSSIA_KW.filter(k => t.includes(k)).length;
  return excl < russ;
}

function detectSentiment(title) {
  const t = (title || '').toLowerCase();
  const negateNext = ['no ','not ','kein','ohne','scheitern','failed','rejected'];
  const hasNeg = negateNext.some(n => t.includes(n));
  const negKW = ['attack','angriff','missile','drone','drohne','casualt','killed',
    'bombing','escalat','eskalation','annexat','war crime','repression'];
  const posKW = ['ceasefire','waffenstillstand','negotiat','verhandl','peace',
    'frieden','dialog','agreement','de-escalat','war fatigue','kriegsmüdigkeit'];
  const negC = negKW.filter(k => t.includes(k)).length;
  const posC = posKW.filter(k => t.includes(k)).length;
  if (posC > 0 && hasNeg && negC === 0) return 'neg';
  if (negC > posC) return 'neg';
  if (posC > negC) return 'pos';
  return 'neu';
}

function ovFromPost(title, sent) {
  const t = (title || '').toLowerCase();
  if (t.includes('ceasefire') || t.includes('waffenstillstand') || t.includes('negotiat'))
    return '→ Dialogue position discussed in public discourse';
  if (t.includes('war fatigue') || t.includes('kriegsmüdigkeit'))
    return '→ War fatigue signal — window drift visible';
  if (t.includes('sanction') || t.includes('weapon') || t.includes('arms'))
    return '→ Hawkish framing dominant';
  if (t.includes('attack') || t.includes('missile') || t.includes('drone'))
    return '→ Security framing narrows window';
  if (sent === 'pos') return '→ Dialogue-oriented framing in public discourse';
  if (sent === 'neg') return '→ Conflict framing reinforces hawkish window';
  return '→ Russia discourse active in public sphere';
}

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  const diff = Math.floor((Date.now() - d) / 60000);
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

async function fetchRedditRSS(source) {
  try {
    const r = await fetch(RSS2JSON + encodeURIComponent(source.url), {
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    if (d.status !== 'ok' || !d.items?.length) return [];

    return d.items
      .filter(item => isRelevant(item.title + ' ' + (item.description || '')))
      .slice(0, 6)
      .map(item => {
        const sent = detectSentiment(item.title);
        // Extract score from description if available
        const scoreMatch = (item.description || '').match(/(\d+)\s*point/i);
        const score = scoreMatch ? parseInt(scoreMatch[1]) : 10;
        return {
          handle: source.name,
          author: item.author || 'reddit',
          text: item.title,
          time: item.pubDate || '',
          timeAgo: timeAgo(item.pubDate),
          link: item.link || '',
          likes: score,
          comments: 0,
          sent,
          score: sent === 'neg' ? 70 : sent === 'pos' ? 30 : 45,
          ov: ovFromPost(item.title, sent),
          weight: source.weight,
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
  let redisClient;

  // Check cache (30 min)
  try {
    redisClient = await getRedisClient();
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const data = JSON.parse(cached);
      if (Date.now() - data.ts < 30 * 60 * 1000 && data.posts?.length > 0) {
        await redisClient.quit();
        return res.status(200).json({ ok: true, source: 'cache', count: data.posts.length, data: data.posts, sentiment: data.sentiment });
      }
    }
  } catch (e) {}

  // Fetch all RSS feeds in parallel
  const results = await Promise.allSettled(REDDIT_RSS.map(fetchRedditRSS));
  let allPosts = results
    .flatMap((r, i) => r.status === 'fulfilled'
      ? r.value.map(p => ({ ...p, weight: REDDIT_RSS[i].weight }))
      : []
    )
    .sort((a, b) => (b.likes * b.weight) - (a.likes * a.weight))
    .filter((post, idx, arr) =>
      arr.findIndex(p => p.text.slice(0, 40) === post.text.slice(0, 40)) === idx
    )
    .slice(0, 15);

  const sentiment = {
    neg: allPosts.filter(p => p.sent === 'neg').length,
    neu: allPosts.filter(p => p.sent === 'neu').length,
    pos: allPosts.filter(p => p.sent === 'pos').length,
    total: allPosts.length,
    avgScore: 45,
  };

  // Store in Redis
  if (redisClient) {
    try {
      const payload = { posts: allPosts, sentiment, ts: Date.now() };
      await redisClient.set(cacheKey, JSON.stringify(payload), { EX: 3600 });
      await redisClient.set('reddit:sentiment', JSON.stringify({
        ...sentiment,
        date: new Date().toISOString().slice(0, 10),
      }), { EX: 86400 });
      await redisClient.quit();
    } catch (e) { await redisClient.quit().catch(() => {}); }
  }

  return res.status(200).json({
    ok: true,
    source: 'live',
    count: allPosts.length,
    sentiment,
    data: allPosts,
  });
}
