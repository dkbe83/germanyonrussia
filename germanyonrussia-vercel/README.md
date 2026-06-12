# GermanyOnRussia.com — Full Deployment Guide

## What this does
- Daily cron job (05:00 UTC) fetches RSS from 28 sources
- Computes Overton index from sentiment analysis
- Stores result in Vercel KV (Redis)
- Frontend loads historical time series on every page visit
- Grafik grows automatically by one real data point every day

## Step 1 — GitHub Repository
1. Go to github.com → New repository → name: "germanyonrussia"
2. Upload all files from this folder
3. Or use GitHub Desktop / VS Code to push

## Step 2 — Vercel Account
1. Go to vercel.com → Sign up with GitHub
2. Click "Add New Project" → Import your GitHub repo
3. Framework: "Other" → Deploy

## Step 3 — Vercel KV (Database)
1. Vercel Dashboard → Storage (left menu) → Create Database
2. Choose "KV" → Region: Frankfurt (eu-central-1)
3. Name: "germanyonrussia-kv" → Create
4. Click "Connect to Project" → select your project → Connect
5. Environment variables are added automatically ✓

## Step 4 — Environment Variables
In Vercel Dashboard → Project → Settings → Environment Variables, add:
- CRON_SECRET = (any random string, e.g. generate at randomkeygen.com)

## Step 5 — Custom Domain
1. Vercel Project → Settings → Domains
2. Add "germanyonrussia.com"
3. Point DNS to Vercel (same process as Netlify)

## Step 6 — Test the cron manually
Visit: https://germanyonrussia.com/api/cron
(with Authorization: Bearer YOUR_CRON_SECRET header, or remove secret for first test)

## Automatic from here
- Every day at 05:00 UTC: cron fires → RSS fetched → value stored
- Every page visit: frontend loads /api/data → chart updates with real data
- After 30 days: 30 real data points → after 1 year: 365

## Cost
- Vercel: Free (Hobby plan)
- Vercel KV: Free up to 256MB, 30k requests/month
- rss2json.com: Free up to 10k requests/day
- Domain: ~12€/year (already purchased)
Total: ~12€/year
