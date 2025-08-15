import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import OpenAI from "openai";

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // ДОДАЙ у Railway
const EMB_MODEL = process.env.EMB_MODEL || "text-embedding-3-small";

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

/** Пам'ять: namespace -> [{text,url,title,section,embedding:number[]}] */
const store = new Map();

function auth(req, res, next) {
  if (!API_KEY) return next();
  const h = req.headers.authorization || "";
  if (h === `Bearer ${API_KEY}`) return next();
  res.status(401).json({ ok:false, error:"Unauthorized" });
}

function chunk(text, size = 1000, overlap = 150) {
  const out = [];
  for (let i = 0; i < text.length; i += (size - overlap))
    out.push(text.slice(i, i + size));
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
  await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
  const html = await page.content();
  await browser.close();
  return html;
}

/** Видобуваємо МАКСИМУМ корисного тексту зі SPA */
function extractMain(html, url) {
  const $ = cheerio.load(html);

  // Прибираємо лише очевидне сміття
  $("script,style,iframe,svg").remove();

  // Беремо увесь видимий текст сторінки
  const title = ($("title").first().text() || url).trim();
  const text = $.root().text().replace(/\s+/g, " ").trim();

  return { text, title, section: "" };
}


/** Косинусна схожість */
function cosine(a, b) {
  let dot=0, na=0, nb=0;
  for (let i=0;i<a.length;i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-9);
}

/** Отримати ембеддинги */
async function embedBatch(texts) {
  if (!openai) throw new Error("OPENAI_API_KEY is not set");
  const resp = await openai.embeddings.create({
    model: EMB_MODEL,
    input: texts
  });
  return resp.data.map(d => d.embedding);
}

app.get("/health", (_,res)=>res.send("ok"));

/** Скільки чанків у namespace */
app.get("/debug/count", (req,res)=>{
  const ns = req.query.namespace || "default";
  res.json({ namespace: ns, chunks: (store.get(ns)||[]).length });
});

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
      const chunks = chunk(text);
      // Ембеддинги пакетами (по 64)
      for (let i=0;i<chunks.length;i+=64){
        const slice = chunks.slice(i, i+64);
        const embs = await embedBatch(slice);
        for (let j=0;j<slice.length;j++){
          docs.push({ text: slice[j], url: u, title, section, embedding: embs[j] });
        }
      }
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
  if (corpus.length === 0) return res.json({ hits: [] });

  // Embed запит
  let qEmb;
  try {
    qEmb = (await embedBatch([query]))[0];
  } catch (e) {
    return res.status(500).json({ ok:false, error:"embedding_failed: "+String(e) });
  }

  // Рейтинг
  const scored = corpus
    .map(r => ({ r, score: cosine(qEmb, r.embedding) }))
    .sort((a,b)=>b.score-a.score)
    .slice(0, top_k)
    .map(x => ({
      text: x.r.text.slice(0, 900),
      url: x.r.url,
      title: x.r.title,
      section: x.r.section,
      score: x.score
    }));

  res.json({ hits: scored });
});

app.listen(PORT, ()=>console.l
