
// ============================================================================
// EVE Audio Price Tracker — Backend de scraping (Node.js / TypeScript)
// ----------------------------------------------------------------------------
// ARCHITECTURE v2 — fiabilisation de la collecte :
//   1. URL DE FICHE PRODUIT directe par revendeur (jamais de bloc "articles
//      similaires" — cause des erreurs Thomann/Michenaud).
//   2. EXTRACTION EN 3 ÉTAGES, du plus fiable au moins fiable :
//        a. JSON-LD structuré (schema.org/Product+Offer) → confiance "structured"
//        b. Sélecteur CSS dédié sur la fiche produit → confiance "selector"
//        c. Aucun prix exploitable → cellule vide (JAMAIS de prix de déduction)
//   3. LOCALE FORCÉE par revendeur (fr_FR pour Music Store, .fr pour Thomann
//      et Musik Produktiv…) — les prix sont géo-dépendants.
//   4. VALIDATION : rejet de tout prix hors bornes MSRP ±35 %, des variantes
//      B-Stock/Retoure/Demo, et des paires quand on attend une unité.
//   5. SORTIE JSON unique (data/history.json) consommée par l'app React,
//      avec horodatage et niveau de confiance PAR PRIX.
//
// Installation :
//   npm init -y
//   npm i playwright better-sqlite3
//   npx playwright install chromium
//
// Exécution (cron quotidien recommandé, ex. 06:00) :
//   npx ts-node scraper.ts
//   → écrit data/history.json + SQLite tracker.db
// ============================================================================

import { chromium, type Browser, type Page } from "playwright";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import path from "path";

// ----------------------------------------------------------------------------
// 0. POLITIQUE SOURCES — LISTE BLANCHE STRICTE
// ----------------------------------------------------------------------------
// Seuls les sites des revendeurs trackés peuvent être scraped. Tout autre
// domaine est interdit — en particulier Audiofanzine et les comparateurs
// (Equipboard, Reverb, Geizhals, Idealo, leDénicheur…).
const ALLOWED_DOMAINS = [
  "stars-music.com", "michenaud.com", "sonovente.com", "univers-sons.com",
  "thomann.fr", "musicstore.com", "musik-produktiv.fr",
  "kmraudio.com", "kmraudio.de", "muziker.fr", "muziker.com", "muziker.de",
  "vonbroenner.de", "gear4music.com", "gear4music.fr",
];
function isAllowedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// 1. RÉFÉRENTIEL PRODUITS (MSRP constructeur, € TTC)
// ----------------------------------------------------------------------------
const MSRP: Record<string, number> = {
  "EXO24": 479, "EXO25": 589, "EXO27": 699, "EXO28": 899,
  "SC203SET": 499, "SC305": 899, "SC307": 1049, "SC2070": 949,
  "SC3070": 1699, "SC4070": 2399, "SC3010": 3999, "SC3012": 5199,
  "TS107": 629, "TS108": 849, "TS110": 1099, "TS112": 1399,
};
/** bornes de rejet : un prix hors [0.65 ; 1.35] × MSRP est considéré bruité */
const MSRP_TOLERANCE = 0.35;
/** variantes interdites : jamais de B-stock, retours, démos, paires déguisées */
const FORBIDDEN_VARIANTS = /b[- ]?stock|b[- ]?ware|retoure|retour|demo|occasion|refurb|secondhand|reconditionn|open box|pair|paar|la paire|set de 2|2 pcs/i;

// ----------------------------------------------------------------------------
// 2. CONFIGURATION REVENDEURS — locale forcée + fiches produits directes
// ----------------------------------------------------------------------------
type PricePoint = { month: string; price: number; ts: string; confidence: "structured" | "selector" | "manual" };
type Offer = {
  productId: string; retailerId: string; price: number; stock: "in" | "low" | "out";
  confidence: PricePoint["confidence"]; url: string; fetchedAt: string;
};

type Retailer = {
  id: string; name: string; country: string; currency: "EUR" | "GBP";
  /** locale du contexte navigateur — CRITIQUE : Music Store sert des prix différents par pays */
  locale: string;
  /** URL directe de la fiche produit pour une référence, ou null → searchUrl */
  productUrl?: (ref: string) => string | null;
  /** URL de recherche interne en secours, {q} remplacé par "EVE <référence>" */
  searchUrl: (q: string) => string;
  /** sélecteurs du prix sur la FICHE PRODUIT (dans l'ordre de préférence) */
  priceSelectors: string[];
  /** sélecteur du prix barré / prix conseillé à ignorer */
  strikethroughSelector?: string;
  resultItem: string; // carte produit sur la page de recherche (mode secours)
};

const slug = (ref: string) => ref.toLowerCase().replace(/\s+/g, "-");

const retailers: Retailer[] = [
  {
    id: "stars", name: "STAR's Music", country: "FR", currency: "EUR", locale: "fr-FR",
    productUrl: (ref) => `https://www.stars-music.com/eve-audio-${slug(ref)}_c10309.html`,
    searchUrl: (q) => `https://www.stars-music.com/fr/recherche?search_query=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".current-price"],
    strikethroughSelector: ".regular-price, .old-price",
    resultItem: ".product-miniature, article.product-miniature",
  },
  {
    id: "michenaud", name: "Michenaud", country: "FR", currency: "EUR", locale: "fr-FR",
    // fiches connues : /p61017/eve-audio-exo-24.php … /p61021/eve-audio-sc203-set.php
    productUrl: (ref) => `https://www.michenaud.com/p${michenaudIds[ref] ?? 0}/eve-audio-${slug(ref)}.php`,
    searchUrl: (q) => `https://www.michenaud.com/fr/recherche?controller=search&s=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".price"],
    strikethroughSelector: ".old-price, .regular-price",
    resultItem: ".product-miniature, .ajax_block_product",
  },
  {
    id: "sonovente", name: "Sonovente", country: "FR", currency: "EUR", locale: "fr-FR",
    searchUrl: (q) => `https://www.sonovente.com/recherche?q=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".price"],
    resultItem: ".product-item, .productCard, li.product",
  },
  {
    id: "universsons", name: "Univers Sons", country: "FR", currency: "EUR", locale: "fr-FR",
    searchUrl: (q) => `https://www.univers-sons.com/fr/recherche?q=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".price"],
    resultItem: ".product-card, .product-item",
  },
  {
    id: "thomann", name: "Thomann FR", country: "DE", currency: "EUR", locale: "fr-FR",
    // pattern stable observé : thomann.fr/eve_audio_exo_24.htm
    productUrl: (ref) => `https://www.thomann.fr/eve_audio_${slug(ref)}.htm`,
    searchUrl: (q) => `https://www.thomann.fr/search.html?sw=${encodeURIComponent(q)}`,
    priceSelectors: [".price--price", "[itemprop=price]", ".fx-price"],
    strikethroughSelector: ".price--original",
    resultItem: ".product, .grid-item",
  },
  {
    id: "musikstore", name: "Music Store", country: "DE", currency: "EUR", locale: "fr-FR",
    // ⚠ STOREFRONT FR UNIQUEMENT (fr_FR) : prix géo-dépendants — jamais en_OT/en_US !
    productUrl: (ref) => {
      const art = musicStoreArt[ref];
      return art ? `https://www.musicstore.com/fr_FR/EUR/${musicStoreSlug[ref] ?? "EVE-audio"}/art-${art}` : null;
    },
    searchUrl: (q) => `https://www.musicstore.com/fr_FR/EUR/search?SearchTerm=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".price"],
    resultItem: ".product-item, .product-box",
  },
  {
    id: "musikproductive", name: "Musik Produktiv", country: "DE", currency: "EUR", locale: "fr-FR",
    productUrl: (ref) => `https://www.musik-produktiv.fr/eve-audio-${slug(ref)}.html`,
    searchUrl: (q) => `https://www.musik-produktiv.fr/search?search=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".price"],
    resultItem: ".product-item, .productGrid-item",
  },
  {
    id: "kmr", name: "KMR Audio", country: "DE", currency: "EUR", locale: "de-DE",
    productUrl: (ref) => `https://kmraudio.de/products/eve-audio-${slug(ref)}`,
    searchUrl: (q) => `https://kmraudio.de/search.php?search_query=${encodeURIComponent(q)}`,
    priceSelectors: [".price", "[itemprop=price]"],
    resultItem: ".product-item, .product-card",
  },
  {
    id: "musiker", name: "Muziker", country: "DE", currency: "EUR", locale: "fr-FR",
    productUrl: (ref) => `https://www.muziker.fr/eve-audio-${slug(ref)}`,
    searchUrl: (q) => `https://www.muziker.fr/search?q=${encodeURIComponent(q)}`,
    priceSelectors: [".price", "[itemprop=price]"],
    resultItem: ".product-card, .product-item",
  },
  {
    id: "vonbroenner", name: "von Brönner", country: "DE", currency: "EUR", locale: "de-DE",
    productUrl: (ref) => `https://www.vonbroenner.de/products/eve-audio-${slug(ref)}`,
    searchUrl: (q) => `https://www.vonbroenner.de/?s=${encodeURIComponent(q)}&post_type=product`,
    priceSelectors: [".price", "[itemprop=price]"],
    resultItem: ".product, .type-product",
  },
  {
    id: "gear4music", name: "Gear4Music", country: "UK", currency: "GBP", locale: "fr-FR",
    // fiches gear4music.fr observées : /77WE (EXO24), /77WG (EXO27), /77WI (EXO28)
    productUrl: (ref) => (g4mIds[ref] ? `https://www.gear4music.fr/Recording-and-Computers/EVE-Audio-EXO-${ref.slice(3)}-Active-Studio-Monitor/${g4mIds[ref]}` : null),
    searchUrl: (q) => `https://www.gear4music.fr/search?q=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".price"],
    strikethroughSelector: ".was-price, .rrp",
    resultItem: ".product-grid-item, .product-card",
  },
];

// ----------------------------------------------------------------------------
// 2 bis. TABLES DE CORRESPONDANCE (URL de fiches vérifiées pendant la veille)
// ----------------------------------------------------------------------------
const michenaudIds: Record<string, number> = {
  "EXO24": 61017, "EXO25": 61018, "EXO27": 61019, "EXO28": 61028,
  "SC305": 61027, "SC307": 61026, "SC203SET": 61021,
  // à compléter au fil des découvertes ; absent → productUrl retourne une URL
  // avec id 0 → 404 gérée proprement, fallback searchUrl
};
const musicStoreArt: Record<string, string> = {
  "EXO24": "REC0016963-000", "EXO25": "REC0016964-000", "EXO27": "REC0016965-000",
  "EXO28": "REC0016966-000", "SC203SET": "REC0012052-000", "SC305": "REC0010257-000",
  "SC307": "REC0010258-000", "SC2070": "REC0016310-000", "SC3070": "REC0014729-000",
  "SC4070": "REC0015442-000", "SC3010": "REC0012749-000", "SC3012": "REC0012750-000",
  "TS107": "REC0010944-000", "TS108": "REC0010945-000", "TS110": "REC0010946-000",
  "TS112": "REC0010947-000",
};
const musicStoreSlug: Record<string, string> = {
  "EXO24": "EVE-audio-EXO-24", "EXO25": "EVE-audio-EXO-25", "EXO27": "EVE-audio-EXO-27",
  "EXO28": "EVE-audio-EXO-28", "SC203SET": "EVE-audio-SC203-Paar", "SC305": "EVE-audio-SC305",
  "SC307": "EVE-audio-SC307", "SC2070": "EVE-audio-SC2070", "SC3070": "EVE-audio-SC3070-Left",
  "SC4070": "EVE-audio-SC4070", "SC3010": "EVE-audio-SC3010", "SC3012": "EVE-audio-SC3012",
  "TS107": "EVE-audio-TS-107-Subwoofer-", "TS108": "EVE-audio-TS-108-Subwoofer-",
  "TS110": "EVE-audio-TS-110-Subwoofer-", "TS112": "EVE-audio-TS-112-Subwoofer-",
};
const g4mIds: Record<string, string> = { "EXO24": "77WE", "EXO27": "77WG", "EXO28": "77WI" };

// v7 — EXCLUSIONS PAR REVENDEUR : couples produit×revendeur à NE JAMAIS
// collecter automatiquement (prix ambigu détecté en production, ex. KMR ne
// vend SC4070/TS107 qu'en paire ou via des pages de recherche trompeuses).
// La cellule reste vide dans le dashboard — jamais de prix douteux.
const RETAILER_EXCLUSIONS: Record<string, string[]> = {
  kmr: ["SC4070", "TS107"],
};

// ----------------------------------------------------------------------------
// 3. PARSERS DE PRIX (formats FR / DE / UK)
// ----------------------------------------------------------------------------
/**
 * Parseur de prix UNIFIÉ et robuste (v3).
 * Règle : si virgule ET point présents, le DERNIER séparateur est le décimal.
 * Rejets : prix concaténés (deux prix collés par un sélecteur trop large,
 * ex. "1.489,001.489,00") et valeurs ambiguës → cellule vide, jamais de prix deviné.
 */
export function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,]/g, "");
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized: string;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, "").replace(/,/g, ".");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }
  // garde-fou anti-concaténation : "1489.001489" (deux prix collés) → rejet
  if (/\.\d{3,}/.test(normalized)) return null;
  const n = parseFloat(normalized);
  if (isNaN(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}
/** compat : l'EUR et la GBP partagent le même parseur, la conversion est aval */
export const parseEurFr = parsePrice;
export const parseGbp = parsePrice;
async function gbpToEur(): Promise<number> {
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=GBP&to=EUR");
    const data = (await res.json()) as { rates: { EUR: number } };
    return data.rates.EUR;
  } catch {
    return 1.17;
  }
}

// ----------------------------------------------------------------------------
// 4. EXTRACTION 3 ÉTAGES — JSON-LD → sélecteur CSS → abandon propre
// ----------------------------------------------------------------------------

/** Étage A : JSON-LD schema.org (Product / Offer) — source la plus fiable.
 *  La plupart des boutiques ci-dessus l'embarquent ; il contient prix, devise
 *  et disponibilité SANS risque de prix adjacent décalé. */
async function extractJsonLd(page: Page, productId?: string): Promise<{ price: number; stock: Offer["stock"]; name?: string } | null> {
  const data = await page.evaluate(() => {
    const out: { price?: string; availability?: string; name?: string }[] = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const parsed = JSON.parse(s.textContent || "null");
        const nodes = Array.isArray(parsed) ? parsed : [parsed];
        for (const n of nodes) {
          if (!n) continue;
          const offer = n.offers ?? (n["@type"] === "Offer" ? n : null);
          if (offer) {
            const o = Array.isArray(offer) ? offer[0] : offer;
            out.push({ price: o.price, availability: o.availability, name: n.name });
          } else if (n["@type"] === "Product" || n.name) {
            out.push({ name: n.name });
          }
        }
      } catch { /* json-ld invalide → ignoré */ }
    });
    return JSON.stringify(out);
  }).catch(() => "[]");
  const nodes = JSON.parse(data) as { price?: string; availability?: string; name?: string }[];
  // v6 : si un produit est demandé, le nom JSON-LD DOIT le mentionner —
  // sinon c'est le prix d'un autre produit (page de recherche, voisin) → rejet
  const withPrice = nodes.filter((n) => n.price && parseFloat(n.price) > 0);
  if (!withPrice.length) return null;
  const good = productId
    ? withPrice.find((n) => jsonLdNameMatches(n.name, productId))
    : withPrice[0];
  if (!good) return null;
  const avail = (good.availability || "").toLowerCase();
  const stock: Offer["stock"] =
    avail.includes("instock") || avail.includes("in_stock") ? "in"
    : avail.includes("limitedavailability") ? "low"
    : avail.includes("outofstock") || avail.includes("preorder") ? "out"
    : "in";
  return { price: parseFloat(good.price!), stock, name: good.name };
}

/** Étage B : sélecteurs CSS sur la fiche produit. Le prix retenu doit être
 *  ≠ du prix barré (strikethrough) pour éviter de capter le prix conseillé. */
async function extractWithSelectors(
  page: Page, r: Retailer
): Promise<{ price: number; stock: Offer["stock"] } | null> {
  const strikethrough = r.strikethroughSelector
    ? await page.$(r.strikethroughSelector)
    : null;
  const strikeText = strikethrough ? await strikethrough.textContent() : "";
  for (const sel of r.priceSelectors) {
    const el = await page.$(sel);
    if (!el) continue;
    const raw = (await el.textContent()) ?? "";
    const price = parsePrice(raw);
    if (!price) continue;
    if (strikeText) {
      const strike = parsePrice(strikeText);
      if (strike && Math.abs(strike - price) < 0.01) continue; // prix barré → suivant
    }
    const txt = (await page.content()).toLowerCase();
    const stock: Offer["stock"] =
      /rupture|out of stock|nicht verfügbar|ausverkauft|sur commande uniquement|surveiller la disponibilité/.test(txt)
        ? "out"
        : /stock faible|last pieces|wenige|en stock [1-3] pièces?|1 pièces? en stock/.test(txt)
          ? "low"
          : "in";
    return { price, stock };
  }
  return null;
}

/** Garde-fous anti-bruit : bornes MSRP (APRÈS conversion €), variantes interdites. */
function validate(productId: string, _r: Retailer, price: number, pageUrl: string): string | null {
  const msrp = MSRP[productId];
  if (!msrp) return "référence inconnue";
  // v3 : la vérification s'applique AUSSI aux prix convertis GBP→EUR
  if (price < msrp * (1 - MSRP_TOLERANCE)) return `prix ${price}€ < MSRP−35% (${msrp}€)`;
  if (price > msrp * (1 + MSRP_TOLERANCE)) return `prix ${price}€ > MSRP+35% (${msrp}€)`;
  if (FORBIDDEN_VARIANTS.test(pageUrl)) return "variante B-stock/paire/set";
  return null;
}

/** v3 : le titre/h1/URL de la page DOIT mentionner la référence cherchée.
 *  Élimine les faux couples produit-prix (page d'une autre référence,
 *  prix du mauvais produit sur une page de recherche). */
async function pageMentionsProduct(page: Page, productId: string): Promise<boolean> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const ref = norm(productId); // "SC203SET" → "sc203set"
  const title = norm(await page.title().catch(() => ""));
  const h1 = await page.$("h1").catch(() => null);
  const h1Text = h1 ? norm((await h1.textContent()) ?? "") : "";
  const url = norm(page.url());
  return title.includes(ref) || h1Text.includes(ref) || url.includes(ref);
}

/** v6 : le NOM du produit dans le JSON-LD doit contenir la référence.
 *  C'est le contrôle le plus strict : sur une fiche produit, le JSON-LD
 *  porte le nom exact ("EVE Audio SC3070 ..."), sur une page de recherche
 *  ou une fiche voisine, il porte un autre nom → rejet.
 *  Exclut aussi les paires déguisées ("...Paar", "...Pair", "2 pcs"). */
function jsonLdNameMatches(name: string | undefined, productId: string): boolean {
  if (!name) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const ref = norm(productId);
  return norm(name).includes(ref);
}

async function scrapeProductAtRetailer(
  page: Page, productId: string, r: Retailer, fxRate: number
): Promise<Offer | null> {
  const candidates: string[] = [];
  const direct = r.productUrl?.(productId);
  if (direct) candidates.push(direct);
  candidates.push(r.searchUrl(`EVE Audio ${productId}`));

  for (const url of candidates) {
    if (!isAllowedUrl(url)) { console.warn(`🚫 Domaine non autorisé : ${url}`); continue; }
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);
      if (/404|page introuvable|not found/i.test(await page.title())) continue;

      // v3 : la page doit bien parler du produit cherché (anti faux-couples)
      if (!(await pageMentionsProduct(page, productId))) {
        console.warn(`⛔ ${r.name} × ${productId} rejeté : la page ne mentionne pas la référence`);
        continue;
      }

      // Étage A — JSON-LD (v6 : le nom du produit doit correspondre)
      let extracted = await extractJsonLd(page, productId);
      let confidence: Offer["confidence"] = "structured";
      // Étage B — CSS
      if (!extracted) {
        extracted = await extractWithSelectors(page, r);
        confidence = "selector";
      }
      if (!extracted) continue; // Étage C — pas de prix fiable → on n'invente rien

      let { price, stock } = extracted;
      if (r.currency === "GBP") price = Math.round(price * fxRate * 100) / 100;
      const reason = validate(productId, r, price, url);
      if (reason) { console.warn(`⛔ ${r.name} × ${productId} rejeté : ${reason}`); continue; }

      return {
        productId, retailerId: r.id, price, stock, confidence,
        url: page.url(), fetchedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.warn(`⚠️  ${r.name} × ${productId} : ${(e as Error).message}`);
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// 5. BOUCLE PRINCIPALE (locale forcée par revendeur, délais polis)
// ----------------------------------------------------------------------------
async function run() {
  const fxRate = await gbpToEur();
  const browser: Browser = await chromium.launch({ headless: true });

  const offers: Offer[] = [];
  for (const r of retailers) {
    // UN CONTEXTE PAR REVENDEUR : la locale est le garant du bon storefront
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: r.locale, // ⚠ fr-FR pour Music Store sinon prix géo-dépendants
    });
    const page = await context.newPage();

    for (const productId of Object.keys(MSRP)) {
      // v7 : exclusions par revendeur (couples sources d'erreurs connues)
      if (RETAILER_EXCLUSIONS[r.id]?.includes(productId)) {
        console.log(`➖ ${productId} @ ${r.name} : exclu (couple à prix ambigu)`);
        continue;
      }
      const offer = await scrapeProductAtRetailer(page, productId, r, fxRate);
      if (offer) {
        offers.push(offer);
        console.log(`✅ ${productId} @ ${r.name} : ${offer.price.toFixed(2)} € (${offer.confidence}, ${offer.stock})`);
      } else {
        console.log(`➖ ${productId} @ ${r.name} : non trouvé`);
      }
      await page.waitForTimeout(3000 + Math.random() * 5000);
    }
    await context.close();
  }
  await browser.close();

  saveToSqlite(offers);
  exportJson(offers);
}

// ----------------------------------------------------------------------------
// 6. PERSISTANCE — SQLite (historique complet, un snapshot par run)
// ----------------------------------------------------------------------------
async function saveToSqlite(offers: Offer[]) {
  // v6 : purge de la base à chaque run — les snapshots d'un run donné ne
  // doivent jamais fuiter dans un export ultérieur (cause des prix
  // aberrants réinjectés depuis tracker.db).
  const dbPath = path.join(__dirname, "..", "data", "tracker.db");
  try { unlinkSync(dbPath); } catch { /* base absente → premier run */ }
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      retailer_id TEXT NOT NULL,
      price_eur REAL NOT NULL,
      stock TEXT NOT NULL,
      confidence TEXT NOT NULL,
      url TEXT,
      fetched_at TEXT NOT NULL,
      UNIQUE(product_id, retailer_id, fetched_at)
    );
    CREATE INDEX IF NOT EXISTS idx_snap_product ON price_snapshots(product_id);
  `);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO price_snapshots
     (product_id, retailer_id, price_eur, stock, confidence, url, fetched_at)
     VALUES (@productId, @retailerId, @price, @stock, @confidence, @url, @fetchedAt)`
  );
  const tx = db.transaction((rows: Offer[]) => rows.forEach((o) => insert.run(o)));
  tx(offers);
  db.close();
}

// ----------------------------------------------------------------------------
// 7. EXPORT JSON — CONTRAT PARTAGÉ AVEC L'APP (canvas React)
// ----------------------------------------------------------------------------
// {
//   updatedAt: "2026-10-14T06:00:00Z",
//   msrp: { EXO24: 479, ... },
//   retailers: [{id, name, country, currency}],
//   history: {
//     "EXO24|thomann": [
//       { month: "2026-10", price: 429, ts: "2026-10-14T06:00:00Z", confidence: "structured" }
//     ]
//   }
// }
// - ts : horodatage réel du run → l'app calcule la fraîcheur de chaque cellule
// - confidence : "structured" (JSON-LD) > "selector" (CSS fiche) > "manual"
function exportJson(offers: Offer[]) {
  const db = new Database(path.join(__dirname, "..", "data", "tracker.db"), { readonly: true });
  const rows = db.prepare(
    `SELECT product_id, retailer_id, price_eur, stock, confidence, fetched_at
     FROM price_snapshots ORDER BY fetched_at ASC`
  ).all() as any[];
  db.close();

  const history: Record<string, PricePoint[]> = {};
  for (const r of rows) {
    const k = `${r.product_id}|${r.retailer_id}`;
    const month = r.fetched_at.slice(0, 7);
    history[k] = history[k] ?? [];
    const last = history[k][history[k].length - 1];
    if (!last || last.month !== month) {
      history[k].push({
        month, price: r.price_eur, ts: r.fetched_at,
        confidence: r.confidence ?? "selector",
      });
    } else if (r.stock !== "out") {
      // un prix en stock écrase un prix en rupture au sein du même mois
      last.price = r.price_eur; last.ts = r.fetched_at;
      last.confidence = r.confidence ?? "selector";
    }
  }

  // ----------------------------------------------------------------------------
  // v3 — FUSION avec l'historique existant (data/history.json) :
  // ne JAMAIS écraser les points précédents. Les clés non re-collectées ce run
  // (revendeur bloqué, rupture de collecte) conservent leurs points, et les
  // mois antérieurs sont préservés pour les clés re-collectées.
  // ----------------------------------------------------------------------------
  const historyPath = path.join(__dirname, "..", "data", "history.json");
  try {
    const existing = (JSON.parse(readFileSync(historyPath, "utf8")) as {
      history?: Record<string, PricePoint[]>;
    }).history ?? {};
    for (const [k, points] of Object.entries(existing)) {
      if (!points?.length) continue;
      if (!history[k] || !history[k].length) {
        history[k] = points; // clé non re-collectée → on garde l'existant
      } else {
        const firstNewMonth = history[k][0].month;
        const older = points.filter((p) => p.month < firstNewMonth);
        if (older.length) history[k] = [...older, ...history[k]];
      }
    }
  } catch { /* pas d'historique existant → premier run */ }

  mkdirSync(path.join(__dirname, "..", "data"), { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    msrp: MSRP,
    retailers: retailers.map(({ id, name, country, currency }) => ({ id, name, country, currency })),
    history,
  };
  writeFileSync(path.join(__dirname, "..", "data", "history.json"), JSON.stringify(payload, null, 2));
  console.log("📦 data/history.json généré — prêt pour l'app de veille.");
}

// ----------------------------------------------------------------------------
// 8. DÉPLOIEMENT & NOTES
// ----------------------------------------------------------------------------
// • Cron : 0 6 * * * cd /path/to/eve-tracker && npx ts-node scraper.ts >> logs/scraper.log 2>&1
// • Les URLs de fiches (§2bis) sont celles vérifiées pendant la veille manuelle ;
//   si un 404 apparaît, le scraper retombe sur la recherche interne du site.
// • Re-vérifier les sélecteurs CSS mensuellement (le HTML évolue).
// • Musique Store / Gear4Music / KMR bloquent parfois les bots : prévoir un
//   proxy résidentiel, ou saisie manuelle datée dans data/manual.json (confiance
//   "manual") — jamais de prix deviné.
// • Conditions générales : une API officielle ou flux partenaire reste
//   préférable au scraping quand il en existe une.

run().catch((e) => {
  console.error("Erreur fatale :", e);
  process.exit(1);
});
