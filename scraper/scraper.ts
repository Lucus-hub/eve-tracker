// ============================================================================
// EVE Audio Price Tracker â Backend de scraping (Node.js / TypeScript)
// ----------------------------------------------------------------------------
// ARCHITECTURE v2 â fiabilisation de la collecte :
//   1. URL DE FICHE PRODUIT directe par revendeur (jamais de bloc "articles
//      similaires" â cause des erreurs Thomann/Michenaud).
//   2. EXTRACTION EN 3 ÃTAGES, du plus fiable au moins fiable :
//        a. JSON-LD structurÃ© (schema.org/Product+Offer) â confiance "structured"
//        b. SÃ©lecteur CSS dÃ©diÃ© sur la fiche produit â confiance "selector"
//        c. Aucun prix exploitable â cellule vide (JAMAIS de prix de dÃ©duction)
//   3. LOCALE FORCÃE par revendeur (fr_FR pour Music Store, .fr pour Thomann
//      et Musik Produktivâ¦) â les prix sont gÃ©o-dÃ©pendants.
//   4. VALIDATION : rejet de tout prix hors bornes MSRP Â±35 %, des variantes
//      B-Stock/Retoure/Demo, et des paires quand on attend une unitÃ©.
//   5. SORTIE JSON unique (data/history.json) consommÃ©e par l'app React,
//      avec horodatage et niveau de confiance PAR PRIX.
//
// v8 â VARIANTES GAUCHE/DROITE (SC3070L / SC3070R) :
//   La SC3070 se vend par moniteur sÃ©parÃ© (Left / Right), au mÃªme prix.
//   Deux rÃ©fÃ©rences distinctes sont trackÃ©es ; une fiche indiffÃ©renciÃ©e
//   (revendeur ne distinguant pas les cÃ´tÃ©s) alimente les deux lignes.
//   Jamais de prix de paire : les packs "la paire" restent exclus.
//
// Installation :
//   npm init -y
//   npm i playwright better-sqlite3
//   npx playwright install chromium
//
// ExÃ©cution (cron quotidien recommandÃ©, ex. 06:00) :
//   npx ts-node scraper.ts
//   â Ã©crit data/history.json + SQLite tracker.db
// ============================================================================

import { chromium, type Browser, type Page } from "playwright";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import path from "path";

// ----------------------------------------------------------------------------
// 0. POLITIQUE SOURCES â LISTE BLANCHE STRICTE
// ----------------------------------------------------------------------------
// Seuls les sites des revendeurs trackÃ©s peuvent Ãªtre scraped. Tout autre
// domaine est interdit â en particulier Audiofanzine et les comparateurs
// (Equipboard, Reverb, Geizhals, Idealo, leDÃ©nicheurâ¦).
const ALLOWED_DOMAINS = [
  "stars-music.com", "stars-music.fr", "michenaud.com", "sonovente.com", "univers-sons.com",
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
// 1. RÃFÃRENTIEL PRODUITS (MSRP constructeur, â¬ TTC)
// ----------------------------------------------------------------------------
// v8 : SC3070 est remplacÃ©e par ses deux moniteurs vendus Ã  l'unitÃ©,
// SC3070L (gauche) et SC3070R (droite), au mÃªme MSRP. Les packs "la paire"
// de certains revendeurs ne sont JAMAIS collectÃ©s.
const MSRP: Record<string, number> = {
  "EXO24": 479, "EXO25": 589, "EXO27": 699, "EXO28": 899,
  "SC203SET": 499, "SC305": 899, "SC307": 1049, "SC2070": 949,
  "SC3070L": 1699, "SC3070R": 1699, "SC4070": 2399,
  "SC3010": 3999, "SC3012": 5199,
  "TS107": 629, "TS108": 849, "TS110": 1099, "TS112": 1399,
};
/** v8 â cÃ´tÃ© d'un moniteur vendu sÃ©parÃ©ment (Left/Right, mÃªme prix) */
const SIDES: Record<string, "left" | "right"> = {
  SC3070L: "left", SC3070R: "right",
};
/** rÃ©fÃ©rence de base sans le suffixe de cÃ´tÃ© ("SC3070L" â "SC3070") */
const baseRef = (ref: string) => (SIDES[ref] ? ref.slice(0, -1) : ref);
/** nom de recherche : cible le cÃ´tÃ© quand il existe ("EVE Audio SC3070 Left") */
const searchName = (ref: string) =>
  SIDES[ref] ? `${baseRef(ref)} ${SIDES[ref] === "left" ? "Left" : "Right"}` : ref;
/** produits lÃ©gitimement vendus en paire (le contrÃ´le anti-paire ne s'applique pas) */
const PAIR_PRODUCTS = new Set(["SC203SET"]);
/** bornes de rejet : un prix hors [0.65 ; 1.35] Ã MSRP est considÃ©rÃ© bruitÃ© */
const MSRP_TOLERANCE = 0.35;
/** variantes interdites : jamais de B-stock, retours, dÃ©mos, paires dÃ©guisÃ©es */
const FORBIDDEN_VARIANTS = /b[- ]?stock|b[- ]?ware|retoure|retour|demo|occasion|refurb|secondhand|reconditionn|open box|pair|paar|la paire|set de 2|2 pcs/i;

// ----------------------------------------------------------------------------
// 2. CONFIGURATION REVENDEURS â locale forcÃ©e + fiches produits directes
// ----------------------------------------------------------------------------
type PricePoint = { month: string; price: number; ts?: string; stock?: "in" | "low" | "out"; confidence: "structured" | "selector" | "manual" };
type Offer = {
  productId: string; retailerId: string; price: number; stock: "in" | "low" | "out";
  confidence: PricePoint["confidence"]; url: string; fetchedAt: string;
};

type Retailer = {
  id: string; name: string; country: string; currency: "EUR" | "GBP";
  /** locale du contexte navigateur â CRITIQUE : Music Store sert des prix diffÃ©rents par pays */
  locale: string;
  /** URL directe de la fiche produit pour une rÃ©fÃ©rence, ou null â searchUrl */
  productUrl?: (ref: string) => string | null;
  /** URL de recherche interne en secours, {q} remplacÃ© par le nom de recherche */
  searchUrl: (q: string) => string;
  /** sÃ©lecteurs du prix sur la FICHE PRODUIT (dans l'ordre de prÃ©fÃ©rence) */
  priceSelectors: string[];
  /** sÃ©lecteur du prix barrÃ© / prix conseillÃ© Ã  ignorer */
  strikethroughSelector?: string;
  resultItem: string; // carte produit sur la page de recherche (mode secours)
};

const slug = (ref: string) => ref.toLowerCase().replace(/\s+/g, "-");

const retailers: Retailer[] = [
  {
    id: "stars", name: "STAR's Music", country: "FR", currency: "EUR", locale: "fr-FR",
    productUrl: (ref) => `https://www.stars-music.com/eve-audio-${slug(baseRef(ref))}_c10309.html`,
    searchUrl: (q) => `https://www.stars-music.com/fr/recherche?search_query=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".current-price"],
    strikethroughSelector: ".regular-price, .old-price",
    resultItem: ".product-miniature, article.product-miniature",
  },
  {
    id: "michenaud", name: "Michenaud", country: "FR", currency: "EUR", locale: "fr-FR",
    // fiches connues : /p61017/eve-audio-exo-24.php â¦ /p61021/eve-audio-sc203-set.php
    productUrl: (ref) => `https://www.michenaud.com/p${michenaudIds[baseRef(ref)] ?? 0}/eve-audio-${slug(baseRef(ref))}.php`,
    searchUrl: (q) => `https://www.michenaud.com/fr/recherche?controller=search&s=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".price"],
    strikethroughSelector: ".old-price, .regular-price",
    resultItem: ".product-miniature, .ajax_block_product",
  },
  {
    id: "sonovente", name: "Sonovente", country: "FR", currency: "EUR", locale: "fr-FR",
    // v8 â fiches directes (mÃªmes IDs produits que Univers Sons, plateforme commune)
    productUrl: (ref) => (sonoventePages[ref] ? `https://www.sonovente.com/${sonoventePages[ref]}.html` : null),
    searchUrl: (q) => `https://www.sonovente.com/recherche?q=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".price"],
    resultItem: ".product-item, .productCard, li.product",
  },
  {
    id: "universsons", name: "Univers Sons", country: "FR", currency: "EUR", locale: "fr-FR",
    // v8 â fiches directes (mÃªmes IDs produits que Sonovente, plateforme commune)
    productUrl: (ref) => (universsonsPages[ref] ? `https://www.univers-sons.com/${universsonsPages[ref]}.html` : null),
    searchUrl: (q) => `https://www.univers-sons.com/fr/recherche?q=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".price"],
    resultItem: ".product-card, .product-item",
  },
  {
    id: "thomann", name: "Thomann FR", country: "DE", currency: "EUR", locale: "fr-FR",
    // pattern stable observÃ© : thomann.fr/eve_audio_exo_24.htm
    productUrl: (ref) => `https://www.thomann.fr/eve_audio_${slug(baseRef(ref))}.htm`,
    searchUrl: (q) => `https://www.thomann.fr/search.html?sw=${encodeURIComponent(q)}`,
    priceSelectors: [".price--price", "[itemprop=price]", ".fx-price"],
    strikethroughSelector: ".price--original",
    resultItem: ".product, .grid-item",
  },
  {
    id: "musikstore", name: "Music Store", country: "DE", currency: "EUR", locale: "fr-FR",
    // â  STOREFRONT FR UNIQUEMENT (fr_FR) : prix gÃ©o-dÃ©pendants â jamais en_OT/en_US !
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
    productUrl: (ref) => `https://www.musik-produktiv.fr/eve-audio-${slug(baseRef(ref))}.html`,
    searchUrl: (q) => `https://www.musik-produktiv.fr/search?search=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".price"],
    resultItem: ".product-item, .productGrid-item",
  },
  {
    id: "kmr", name: "KMR Audio", country: "DE", currency: "EUR", locale: "de-DE",
    productUrl: (ref) => `https://kmraudio.de/products/eve-audio-${slug(baseRef(ref))}`,
    searchUrl: (q) => `https://kmraudio.de/search.php?search_query=${encodeURIComponent(q)}`,
    priceSelectors: [".price", "[itemprop=price]"],
    resultItem: ".product-item, .product-card",
  },
  {
    id: "musiker", name: "Muziker", country: "DE", currency: "EUR", locale: "fr-FR",
    productUrl: (ref) => `https://www.muziker.fr/eve-audio-${slug(baseRef(ref))}`,
    searchUrl: (q) => `https://www.muziker.fr/search?q=${encodeURIComponent(q)}`,
    priceSelectors: [".price", "[itemprop=price]"],
    resultItem: ".product-card, .product-item",
  },
  {
    id: "vonbroenner", name: "von BrÃ¶nner", country: "DE", currency: "EUR", locale: "de-DE",
    productUrl: (ref) => `https://www.vonbroenner.de/products/eve-audio-${slug(baseRef(ref))}`,
    searchUrl: (q) => `https://www.vonbroenner.de/?s=${encodeURIComponent(q)}&post_type=product`,
    priceSelectors: [".price", "[itemprop=price]"],
    resultItem: ".product, .type-product",
  },
  {
    id: "gear4music", name: "Gear4Music", country: "UK", currency: "GBP", locale: "fr-FR",
    // fiches gear4music.fr observÃ©es : /77WE (EXO24), /77WG (EXO27), /77WI (EXO28)
    productUrl: (ref) => (g4mIds[ref] ? `https://www.gear4music.fr/Recording-and-Computers/EVE-Audio-EXO-${ref.slice(3)}-Active-Studio-Monitor/${g4mIds[ref]}` : null),
    searchUrl: (q) => `https://www.gear4music.fr/search?q=${encodeURIComponent(q)}`,
    priceSelectors: [".product-price", "[itemprop=price]", ".price"],
    strikethroughSelector: ".was-price, .rrp",
    resultItem: ".product-grid-item, .product-card",
  },
];

// ----------------------------------------------------------------------------
// 2 bis. TABLES DE CORRESPONDANCE (URL de fiches vÃ©rifiÃ©es pendant la veille)
// ----------------------------------------------------------------------------
const michenaudIds: Record<string, number> = {
  "EXO24": 61017, "EXO25": 61018, "EXO27": 61019, "EXO28": 61028,
  "SC305": 61027, "SC307": 61026, "SC203SET": 61021,
  "SC4070": 38209, "SC3012": 38212, "SC3070R": 61343,
  // v12 : 3 fiches verifiees le 19/10/2026 (catalogue michenaud.com) ;
  // Ã  complÃ©ter au fil des dÃ©couvertes ; absent â productUrl retourne une URL
  // avec id 0 â 404 gÃ©rÃ©e proprement, fallback searchUrl
};
// v8 â Sonovente et Univers Sons partagent la mÃªme plateforme et les mÃªmes
// IDs produits (p58993â¦). Fiches directes vÃ©rifiÃ©es le 15/10/2026 ; les packs
// "la paire" ne sont PAS rÃ©fÃ©rencÃ©s ici (jamais de prix de paire).
const sonoventePages: Record<string, string> = {
  "SC203SET": "eve-audio-sc203-la-paire-p58993",
  "SC305": "eve-audio-sc305-la-piece-p58996",
  "SC307": "eve-audio-sc307-la-piece-p58999",
  "SC4070": "eve-audio-sc4070-p79779",
  "SC3070L": "eve-audio-sc3070-gauche-p79775",
  "SC3070R": "eve-audio-sc3070-right-p79776",
  "TS107": "eve-audio-ts107-p59011",
  "TS108": "eve-audio-ts108-p59009",
  "TS110": "eve-audio-ts110-p59013",
};
const universsonsPages: Record<string, string> = {
  "SC203SET": "eve-audio-sc203-la-paire-p58993",
  "SC305": "eve-audio-sc305-la-piece-p58996",
  "SC307": "eve-audio-sc307-la-piece-p58999",
  "SC4070": "eve-audio-sc4070-p79779",
  "SC3070L": "eve-audio-sc3070-gauche-p79775",
  "SC3070R": "eve-audio-sc3070-right-p79776",
  "TS107": "eve-audio-ts107-p59011",
  "TS108": "eve-audio-ts108-p59009",
  "TS110": "eve-audio-ts110-p59013",
};
const musicStoreArt: Record<string, string> = {
  "EXO24": "REC0016963-000", "EXO25": "REC0016964-000", "EXO27": "REC0016965-000",
  "EXO28": "REC0016966-000", "SC203SET": "REC0012052-000", "SC305": "REC0010257-000",
  "SC307": "REC0010258-000", "SC2070": "REC0016310-000",
  // v8 : Music Store rÃ©fÃ©rence le moniteur gauche ("SC3070-Left") ; la fiche
  // droite n'est pas connue â SC3070R passera par la recherche interne.
  "SC3070L": "REC0014729-000",
  "SC4070": "REC0015442-000", "SC3010": "REC0012749-000", "SC3012": "REC0012750-000",
  "TS107": "REC0010944-000", "TS108": "REC0010945-000", "TS110": "REC0010946-000",
  "TS112": "REC0010947-000",
};
const musicStoreSlug: Record<string, string> = {
  "EXO24": "EVE-audio-EXO-24", "EXO25": "EVE-audio-EXO-25", "EXO27": "EVE-audio-EXO-27",
  "EXO28": "EVE-audio-EXO-28", "SC203SET": "EVE-audio-SC203-Paar", "SC305": "EVE-audio-SC305",
  "SC307": "EVE-audio-SC307", "SC2070": "EVE-audio-SC2070",
  "SC3070L": "EVE-audio-SC3070-Left",
  "SC4070": "EVE-audio-SC4070", "SC3010": "EVE-audio-SC3010", "SC3012": "EVE-audio-SC3012",
  "TS107": "EVE-audio-TS-107-Subwoofer-", "TS108": "EVE-audio-TS-108-Subwoofer-",
  "TS110": "EVE-audio-TS-110-Subwoofer-", "TS112": "EVE-audio-TS-112-Subwoofer-",
};
const g4mIds: Record<string, string> = { "EXO24": "77WE", "EXO27": "77WG", "EXO28": "77WI" };

// v7 â EXCLUSIONS PAR REVENDEUR : couples produitÃrevendeur Ã  NE JAMAIS
// collecter automatiquement (prix ambigu dÃ©tectÃ© en production, ex. KMR ne
// vend SC4070/TS107 qu'en paire ou via des pages de recherche trompeuses).
// La cellule reste vide dans le dashboard â jamais de prix douteux.
const RETAILER_EXCLUSIONS: Record<string, string[]> = {
  kmr: ["SC4070", "TS107"],
};

// ----------------------------------------------------------------------------
// 3. PARSERS DE PRIX (formats FR / DE / UK)
// ----------------------------------------------------------------------------
/**
 * Parseur de prix UNIFIÃ et robuste (v3).
 * RÃ¨gle : si virgule ET point prÃ©sents, le DERNIER sÃ©parateur est le dÃ©cimal.
 * Rejets : prix concatÃ©nÃ©s (deux prix collÃ©s par un sÃ©lecteur trop large,
 * ex. "1.489,001.489,00") et valeurs ambiguÃ«s â cellule vide, jamais de prix devinÃ©.
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
  // garde-fou anti-concatÃ©nation : "1489.001489" (deux prix collÃ©s) â rejet
  if (/\.\d{3,}/.test(normalized)) return null;
  const n = parseFloat(normalized);
  if (isNaN(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}
/** compat : l'EUR et la GBP partagent le mÃªme parseur, la conversion est aval */
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
// 4. EXTRACTION 3 ÃTAGES â JSON-LD â sÃ©lecteur CSS â abandon propre
// ----------------------------------------------------------------------------

/** Ãtage A : JSON-LD schema.org (Product / Offer) â source la plus fiable.
 *  La plupart des boutiques ci-dessus l'embarquent ; il contient prix, devise
 *  et disponibilitÃ© SANS risque de prix adjacent dÃ©calÃ©. */
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
      } catch { /* json-ld invalide â ignorÃ© */ }
    });
    return JSON.stringify(out);
  }).catch(() => "[]");
  const nodes = JSON.parse(data) as { price?: string; availability?: string; name?: string }[];
  // v6 : si un produit est demandÃ©, le nom JSON-LD DOIT le mentionner â
  // sinon c'est le prix d'un autre produit (page de recherche, voisin) â rejet
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

/** Ãtage B : sÃ©lecteurs CSS sur la fiche produit. Le prix retenu doit Ãªtre
 *  â  du prix barrÃ© (strikethrough) pour Ã©viter de capter le prix conseillÃ©. */
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
      if (strike && Math.abs(strike - price) < 0.01) continue; // prix barrÃ© â suivant
    }
    const txt = (await page.content()).toLowerCase();
    const stock: Offer["stock"] =
      /rupture|out of stock|nicht verfÃ¼gbar|ausverkauft|sur commande uniquement|surveiller la disponibilitÃ©/.test(txt)
        ? "out"
        : /stock faible|last pieces|wenige|en stock [1-3] piÃ¨ces?|1 piÃ¨ces? en stock/.test(txt)
          ? "low"
          : "in";
    return { price, stock };
  }
  return null;
}

/** Garde-fous anti-bruit : bornes MSRP (APRÃS conversion â¬), variantes interdites. */
function validate(productId: string, _r: Retailer, price: number, pageUrl: string): string | null {
  const msrp = MSRP[productId];
  if (!msrp) return "rÃ©fÃ©rence inconnue";
  // v3 : la vÃ©rification s'applique AUSSI aux prix convertis GBPâEUR
  if (price < msrp * (1 - MSRP_TOLERANCE)) return `prix ${price}â¬ < MSRPâ35% (${msrp}â¬)`;
  if (price > msrp * (1 + MSRP_TOLERANCE)) return `prix ${price}â¬ > MSRP+35% (${msrp}â¬)`;
  // v8 : le contrÃ´le anti-paire ne s'applique pas aux produits vendus en paire
  if (!PAIR_PRODUCTS.has(productId) && FORBIDDEN_VARIANTS.test(pageUrl)) return "variante B-stock/paire/set";
  return null;
}

/** v3/v8 : le titre/h1/URL de la page DOIT mentionner la rÃ©fÃ©rence cherchÃ©e.
 *  Ãlimine les faux couples produit-prix. Pour un moniteur Ã  cÃ´tÃ©s (SC3070L/R),
 *  une fiche diffÃ©renciÃ©e doit afficher le cÃ´tÃ© demandÃ© ; une fiche
 *  indiffÃ©renciÃ©e est acceptÃ©e (le prix est identique des deux cÃ´tÃ©s). */
async function pageMentionsProduct(page: Page, productId: string): Promise<boolean> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const base = norm(baseRef(productId)); // "SC3070L" â "sc3070"
  const title = await page.title().catch(() => "");
  const h1 = await page.$("h1").catch(() => null);
  const h1Text = h1 ? ((await h1.textContent()) ?? "") : "";
  const url = page.url();
  const headNorm = norm(title) + " " + norm(h1Text) + " " + norm(url);
  if (!headNorm.includes(base)) return false;
  const side = SIDES[productId];
  if (!side) return true;
  // cÃ´tÃ©s testÃ©s sur le texte BRUT (frontiÃ¨res de mots) pour Ã©viter les
  // faux positifs du type "copyright" contenant "right"
  const raw = `${title} ${h1Text} ${decodeURIComponent(url)}`.toLowerCase();
  const hasLeft = /(^|[^a-z])(left|gauche|links)([^a-z]|$)/.test(raw);
  const hasRight = /(^|[^a-z])(right|droite|droit|rechts)([^a-z]|$)/.test(raw);
  if (hasLeft === hasRight) return true; // fiche indiffÃ©renciÃ©e (ou mixte) â acceptÃ©e
  return side === "left" ? hasLeft : hasRight;
}

/** v6/v8 : le NOM du produit dans le JSON-LD doit contenir la rÃ©fÃ©rence.
 *  C'est le contrÃ´le le plus strict : sur une fiche produit, le JSON-LD
 *  porte le nom exact ("EVE Audio SC3070 Leftâ¦"), sur une page de recherche
 *  ou une fiche voisine, il porte un autre nom â rejet.
 *  Exclut aussi les paires dÃ©guisÃ©es ("...Paar", "...Pair", "2 pcs").
 *  Pour SC3070L/R : un nom diffÃ©renciÃ© doit correspondre au cÃ´tÃ© demandÃ© ;
 *  un nom indiffÃ©renciÃ© ("EVE Audio SC3070") est acceptÃ©. */
function jsonLdNameMatches(name: string | undefined, productId: string): boolean {
  if (!name) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = norm(name);
  const base = norm(baseRef(productId));
  if (!n.includes(base)) return false;
  const side = SIDES[productId];
  if (!side) return true;
  const raw = name.toLowerCase();
  const hasLeft = /(^|[^a-z])(left|gauche|links)([^a-z]|$)/.test(raw);
  const hasRight = /(^|[^a-z])(right|droite|droit|rechts)([^a-z]|$)/.test(raw);
  if (hasLeft === hasRight) return true;
  return side === "left" ? hasLeft : hasRight;
}

async function scrapeProductAtRetailer(
  page: Page, productId: string, r: Retailer, fxRate: number
): Promise<Offer | null> {
  const candidates: string[] = [];
  const direct = r.productUrl?.(productId);
  if (direct) candidates.push(direct);
  // v8 : la recherche cible le cÃ´tÃ© quand il existe ("EVE Audio SC3070 Left")
  candidates.push(r.searchUrl(`EVE Audio ${searchName(productId)}`));

  for (const url of candidates) {
    if (!isAllowedUrl(url)) { console.warn(`ð« Domaine non autorisÃ© : ${url}`); continue; }
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);
      if (/404|page introuvable|not found/i.test(await page.title())) continue;

      // v3 : la page doit bien parler du produit cherchÃ© (anti faux-couples)
      if (!(await pageMentionsProduct(page, productId))) {
        console.warn(`â ${r.name} Ã ${productId} rejetÃ© : la page ne mentionne pas la rÃ©fÃ©rence`);
        continue;
      }

      // Ãtage A â JSON-LD (v6 : le nom du produit doit correspondre)
      let extracted = await extractJsonLd(page, productId);
      let confidence: Offer["confidence"] = "structured";
      // Ãtage B â CSS
      if (!extracted) {
        extracted = await extractWithSelectors(page, r);
        confidence = "selector";
      }
      if (!extracted) continue; // Ãtage C â pas de prix fiable â on n'invente rien

      let { price, stock } = extracted;
      if (r.currency === "GBP") price = Math.round(price * fxRate * 100) / 100;
      const reason = validate(productId, r, price, url);
      if (reason) { console.warn(`â ${r.name} Ã ${productId} rejetÃ© : ${reason}`); continue; }

      return {
        productId, retailerId: r.id, price, stock, confidence,
        url: page.url(), fetchedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.warn(`â ï¸  ${r.name} Ã ${productId} : ${(e as Error).message}`);
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// 5. BOUCLE PRINCIPALE (locale forcÃ©e par revendeur, dÃ©lais polis)
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
      locale: r.locale, // â  fr-FR pour Music Store sinon prix gÃ©o-dÃ©pendants
    });
    const page = await context.newPage();

    for (const productId of Object.keys(MSRP)) {
      // v7 : exclusions par revendeur (couples sources d'erreurs connues)
      if (RETAILER_EXCLUSIONS[r.id]?.includes(productId)) {
        console.log(`â ${productId} @ ${r.name} : exclu (couple Ã  prix ambigu)`);
        continue;
      }
      const offer = await scrapeProductAtRetailer(page, productId, r, fxRate);
      if (offer) {
        offers.push(offer);
        console.log(`â ${productId} @ ${r.name} : ${offer.price.toFixed(2)} â¬ (${offer.confidence}, ${offer.stock})`);
      } else {
        console.log(`â ${productId} @ ${r.name} : non trouvÃ©`);
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
// 6. PERSISTANCE â SQLite (historique complet, un snapshot par run)
// ----------------------------------------------------------------------------
async function saveToSqlite(offers: Offer[]) {
  // v6 : purge de la base Ã  chaque run â les snapshots d'un run donnÃ© ne
  // doivent jamais fuiter dans un export ultÃ©rieur (cause des prix
  // aberrants rÃ©injectÃ©s depuis tracker.db).
  const dbPath = path.join(__dirname, "..", "data", "tracker.db");
  try { unlinkSync(dbPath); } catch { /* base absente â premier run */ }
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
// 7. EXPORT JSON â CONTRAT PARTAGÃ AVEC L'APP (canvas React)
// ----------------------------------------------------------------------------
// {
//   updatedAt: "2026-10-14T06:00:00Z",
//   msrp: { EXO24: 479, SC3070L: 1699, SC3070R: 1699, ... },
//   retailers: [{id, name, country, currency}],
//   history: {
//     "EXO24|thomann": [
//       { month: "2026-10", price: 429, ts: "2026-10-14T06:00:00Z", confidence: "structured" }
//     ]
//   }
// }
// - ts : horodatage rÃ©el du run â l'app calcule la fraÃ®cheur de chaque cellule
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
      // un prix en stock Ã©crase un prix en rupture au sein du mÃªme mois
      last.price = r.price_eur; last.ts = r.fetched_at;
      last.confidence = r.confidence ?? "selector";
    }
  }

  // ----------------------------------------------------------------------------
  // v3 â FUSION avec l'historique existant (data/history.json) :
  // ne JAMAIS Ã©craser les points prÃ©cÃ©dents. Les clÃ©s non re-collectÃ©es ce run
  // (revendeur bloquÃ©, rupture de collecte) conservent leurs points, et les
  // mois antÃ©rieurs sont prÃ©servÃ©s pour les clÃ©s re-collectÃ©es.
  // ----------------------------------------------------------------------------
  const historyPath = path.join(__dirname, "..", "data", "history.json");
  try {
    const existing = (JSON.parse(readFileSync(historyPath, "utf8")) as {
      history?: Record<string, PricePoint[]>;
    }).history ?? {};
    // v8 â MIGRATION : l'ancienne clÃ© unique "SC3070|<revendeur>" est
    // dupliquÃ©e vers "SC3070L|â¦" et "SC3070R|â¦" (mÃªme prix des deux cÃ´tÃ©s),
    // puis supprimÃ©e. Idempotent.
    for (const k of Object.keys(existing)) {
      if (k.startsWith("SC3070|")) {
        const rest = k.slice("SC3070|".length);
        for (const side of ["SC3070L", "SC3070R"]) {
          const nk = `${side}|${rest}`;
          if (!existing[nk]) existing[nk] = existing[k].map((p) => ({ ...p }));
        }
        delete existing[k];
      }
    }
    for (const [k, points] of Object.entries(existing)) {
      if (!points?.length) continue;
      if (!history[k] || !history[k].length) {
        history[k] = points; // clÃ© non re-collectÃ©e â on garde l'existant
      } else {
        const firstNewMonth = history[k][0].month;
        const older = points.filter((p) => p.month < firstNewMonth);
        if (older.length) history[k] = [...older, ...history[k]];
      }
    }
  } catch { /* pas d'historique existant â premier run */ }

  mkdirSync(path.join(__dirname, "..", "data"), { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    msrp: MSRP,
    retailers: retailers.map(({ id, name, country, currency }) => ({ id, name, country, currency })),
    history,
  };
  writeFileSync(path.join(__dirname, "..", "data", "history.json"), JSON.stringify(payload, null, 2));
  console.log("ð¦ data/history.json gÃ©nÃ©rÃ© â prÃªt pour l'app de veille.");
}

// ----------------------------------------------------------------------------
// 8. DÃPLOIEMENT & NOTES
// ----------------------------------------------------------------------------
// â¢ Cron : 0 6 * * * cd /path/to/eve-tracker && npx ts-node scraper.ts >> logs/scraper.log 2>&1
// â¢ Les URLs de fiches (Â§2bis) sont celles vÃ©rifiÃ©es pendant la veille manuelle ;
//   si un 404 apparaÃ®t, le scraper retombe sur la recherche interne du site.
// â¢ Re-vÃ©rifier les sÃ©lecteurs CSS mensuellement (le HTML Ã©volue).
// â¢ Music Store / Gear4Music / KMR / Sonovente / Univers Sons bloquent les
//   bots : saisie manuelle datÃ©e dans data/history.json (confiance "manual")
//   â jamais de prix devinÃ©. Les fiches directes Â§2bis facilitent cette veille.
// â¢ Conditions gÃ©nÃ©rales : une API officielle ou flux partenaire reste
//   prÃ©fÃ©rable au scraping quand il en existe une.

run().catch((e) => {
  console.error("Erreur fatale :", e);
  process.exit(1);
});
