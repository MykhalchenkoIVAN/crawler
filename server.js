import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { chromium } from "playwright";

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";

const store = new Map(); // namespace -> [{text,url,title,section}]

function auth(req, res, next) {
  if (!API_KEY) return next();
  const h = req.headers.authorization || "";
  if (h === `Bearer ${API_KEY}`) return next();
  res.status(401).json({ ok: false, error: "Unauthorized" });
}

function chunk(text, size = 1000, overlap = 150) {
  const out = [];
  for (let i = 0; i < text.length; i += (size - overlap)) out.push(text.slice(i, i + size));
  return out;
}

async function getUrlsFromSitemap(root) {
  const url = root.replace(/\/+$/,"") + "/sitemap-pages.xml";
  try {
    const r = await fetch(url, { timeout: 20000 });
    if (!r.ok) throw new Error("no sitemap");
    const xml = await r.text();
    return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
  } catch {
    return [root]; // fallback
  }
}

async function render(url) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  const html = await page.content();
  await browser.close();
  return html;
}

function extractMain(html, url) {
  const title = (html.match(/<title>(.*?)<\/title>/i)||[])[1] || url;
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/g,"")
    .replace(/<style[\s\S]*?<\/style>/g,"")
    .replace(/<nav[\s\S]*?<\/nav>/g,"")
    .replace(/<header[\s\S]*?<\/header>/g,"")
    .replace(/<footer[\s\S]*?<\/footer>/g,"")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ")
    .trim();
  return { text: cleaned, title, section: "" };
}

app.get("/health", (_,res)=>res.send("ok"));

app.post("/ingest", auth, async (req, res) => {
  const { url, allowlist = [url], maxDepth = 2, namespace = "default" } = req.body || {};
  if (!url) return res.status(400).json({ ok:false, error:"url required" });
  try {
    const urls = await getUrlsFromSitemap(url);
    const docs = [];
    for (const u of urls) {
      if (!allowlist.some(a => u.startsWith(a))) continue;
      const html = await render(u);
      const { text, title, section } = extractMain(html, u);
      for (const c of chunk(text)) docs.push({ text:c, url:u, title, section });
    }
    store.set(namespace, (store.get(namespace)||[]).concat(docs));
    res.json({ ok:true, namespace, pages: urls.length, chunks: docs.length });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.post("/search", auth, async (req, res) => {
  const { query, top_k = 5, namespace = "default" } = req.body || {};
  if (!query) return res.status(400).json({ ok:false, error:"query required" });
  const corpus = store.get(namespace) || [];
  const q = query.toLowerCase();
  const hits = corpus
    .map(r => ({ r, score: r.text.toLowerCase().includes(q) ? 1 : 0 }))
    .filter(x => x.score > 0)
    .slice(0, top_k)
    .map(x => ({ text:x.r.text.slice(0, 900), url:x.r.url, title:x.r.title, section:x.r.section }));
  res.json({ hits });
});

app.listen(PORT, ()=>console.log(`DocRAG on :${PORT}`));
