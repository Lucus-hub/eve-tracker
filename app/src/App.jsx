import historyData from "./data.json";
import React, { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from "recharts";

// ------------------------------------------------------------------
// Données de référence : MSRP indicatifs EVE Audio (€ TTC)
// ------------------------------------------------------------------
const PRODUCTS = [
  { id: "EXO24", family: "EXO", msrp: 479 },
  { id: "EXO25", family: "EXO", msrp: 589 },
  { id: "EXO27", family: "EXO", msrp: 699 },
  { id: "EXO28", family: "EXO", msrp: 899 },
  { id: "SC203SET", family: "SC", msrp: 499 },
  { id: "SC305", family: "SC", msrp: 899 },
  { id: "SC307", family: "SC", msrp: 1049 },
  { id: "SC2070", family: "SC", msrp: 949 },
  { id: "SC3070L", family: "SC", msrp: 1699 },
  { id: "SC3070R", family: "SC", msrp: 1699 },
  { id: "SC4070", family: "SC", msrp: 2399 },
  { id: "SC3010", family: "SC", msrp: 3999 },
  { id: "SC3012", family: "SC", msrp: 5199 },
  { id: "TS107", family: "TS", msrp: 629 },
  { id: "TS108", family: "TS", msrp: 849 },
  { id: "TS110", family: "TS", msrp: 1099 },
  { id: "TS112", family: "TS", msrp: 1399 },
];

// catalogUrl : page EVE Audio de l'enseigne (vérification humaine rapide)
const RETAILERS = [
  { id: "stars", name: "STAR's Music", country: "FR", site: "stars-music.fr", catalogUrl: "https://www.stars-music.fr/enceinte-de-monitoring/eve-audio/" },
  { id: "michenaud", name: "Michenaud", country: "FR", site: "michenaud.com", catalogUrl: "https://www.michenaud.com/m501-eve-audio/" },
  { id: "sonovente", name: "Sonovente", country: "FR", site: "sonovente.com", catalogUrl: "https://www.sonovente.com/eve-audio-m586/enceinte-monitoring-c315/" },
  { id: "universsons", name: "Univers Sons", country: "FR", site: "univers-sons.com", catalogUrl: "https://www.univers-sons.com/eve-audio-m586/audio-pro-c1235/" },
  { id: "thomann", name: "Thomann FR", country: "FR", site: "thomann.fr", catalogUrl: "https://www.thomann.fr/cat_BF_eve_audio.html" },
  { id: "musikstore", name: "Music Store", country: "DE", site: "musicstore.com", catalogUrl: "https://www.musicstore.com/fr_FR/EUR/brands/eve-audio" },
  { id: "musikproductive", name: "Musik Produktiv", country: "DE", site: "musik-produktiv.fr", catalogUrl: "https://www.musik-produktiv.fr/marques/eve-audio/" },
  { id: "kmr", name: "KMR Audio", country: "DE", site: "kmraudio.com", catalogUrl: "https://kmraudio.com/collections/eve-audio" },
  { id: "musiker", name: "Muziker", country: "DE", site: "muziker.fr", catalogUrl: "https://www.muziker.fr/eve-audio" },
  { id: "vonbroenner", name: "von Brönner", country: "DE", site: "vonbroenner.de", catalogUrl: "https://www.vonbroenner.de/collections/all-eve-audio-products" },
  { id: "gear4music", name: "Gear4Music", country: "UK", site: "gear4music.com" },
];

const COUNTRY_FLAG = { FR: "🇫🇷", DE: "🇩🇪", UK: "🇬🇧" };

// ------------------------------------------------------------------
// CONNECTEUR BACKEND — alimentation par le scraper (data/history.json)
// ------------------------------------------------------------------
// ➤ PASSAGE EN DONNÉES RÉELLES (seul le champ "history" est obligatoire) :
//   1. lancez le scraper (canvas "Backend de scraping EVE Audio")
//   2. collez ci-dessous le contenu du champ "history" de data/history.json
//      (l'objet "EXO28|thomann": [{month, price}, ...] ...),
//      précédé de la date du run.
//   Exemple :
//   const EXTERNAL_DATA = {
//     updatedAt: "2026-10-09",
//     history: {
//       "EXO28|thomann":  [{ month: "2026-09", price: 848.5 }, { month: "2026-10", price: 839.0 }],
//       "EXO28|sonovente": [{ month: "2026-09", price: 871.2 }, { month: "2026-10", price: 871.2 }],
//       ...
//     },
//   };
//   Tant que EXTERNAL_DATA vaut null, l'app affiche des données simulées
//   déterministes (mode démo).
// Contrat data/history.json du scraper (v2) :
//   history: { "REF|retailer": [{ month, price, stock?, ts?, confidence? }] }
//   - ts : horodatage ISO du run → sert à calculer la fraîcheur de la cellule
//   - confidence : "structured" (JSON-LD) > "selector" (CSS fiche produit)
//     > "manual" (saisie humaine datée) ; absent = saisie de veille manuelle
// Données réelles issues du scraper (data/history.json → app/src/data.json, copié par le workflow)
const EXTERNAL_DATA =
  historyData && historyData.history
    ? { updatedAt: historyData.updatedAt, history: historyData.history }
    : null;

// ------------------------------------------------------------------
// Générateur pseudo-aléatoire déterministe (données simulées stables)
// ------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MONTHS = ["Janv", "Févr", "Mars", "Avril", "Mai", "Juin", "Juil", "Août", "Sept", "Oct"];
const N_MONTHS = 10;

// Construit l'historique par produit × revendeur :
// - depuis EXTERNAL_DATA (scraper) si fourni, sinon en mode démo simulé.
function buildHistory() {
  if (EXTERNAL_DATA) {
    const hist = {};
    Object.entries(EXTERNAL_DATA.history).forEach(([k, points]) => {
      const [productId, retailerId] = k.split("|");
      const n = points.length;
      hist[k] = {
        product: productId,
        retailer: retailerId,
        stock: points[n - 1].stock ?? "in",
        current: points[n - 1].price,
        ts: points[n - 1].ts ?? null,
        confidence: points[n - 1].confidence ?? "manual",
        delta1m: n >= 2 ? Math.round((points[n - 1].price - points[n - 2].price) * 100) / 100 : 0,
        points: points.map((pt, i) => ({
          month: pt.month.slice(5) + "/" + pt.month.slice(2, 4), // "2026-04" → "04/26"
          price: pt.price,
          promo: n >= 2 && i > 0 && pt.price < points[i - 1].price - 1,
        })),
      };
    });
    return hist;
  }
  // ---- mode démo (données simulées) ----
  const hist = {};
  PRODUCTS.forEach((p, pi) => {
    RETAILERS.forEach((r, ri) => {
      const rand = mulberry32(pi * 97 + ri * 131 + 7);
      const baseDiscount = 0.02 + rand() * 0.10;
      const carries = rand() > 0.12;
      const stock = carries ? (rand() > 0.1 ? "in" : "low") : "out";
      const points = [];
      let price = p.msrp * (1 - baseDiscount);
      for (let m = 0; m < N_MONTHS; m++) {
        const drift = (rand() - 0.5) * 0.02;
        const promo = rand() > 0.88 ? -(0.05 + rand() * 0.06) : 0;
        price = Math.min(p.msrp, Math.max(p.msrp * 0.82, price * (1 + drift + promo)));
        points.push({
          month: MONTHS[m],
          price: Math.round(price) - 0.01 < 0 ? Math.round(price) : Math.round(price * 100) / 100,
          promo: promo !== 0,
        });
      }
      const last = points[N_MONTHS - 1].price;
      const prev = points[N_MONTHS - 2].price;
      hist[`${p.id}|${r.id}`] = {
        product: p.id, retailer: r.id, stock,
        current: Math.round(last * 100) / 100,
        delta1m: Math.round((last - prev) * 100) / 100,
        points,
      };
    });
  });
  return hist;
}

const HISTORY = buildHistory();
const FIRST_KEY = Object.keys(HISTORY)[0];

// ------------------------------------------------------------------
// Fraîcheur & fiabilité des prix
// ------------------------------------------------------------------
// Référence temporelle : l'horodatage du dataset (updatedAt) si présent,
// sinon la date du jour. L'âge d'une cellule = updatedAt - ts du point.
const REF_DATE = EXTERNAL_DATA ? new Date(EXTERNAL_DATA.updatedAt) : new Date();

/** âge en jours d'un prix ; null = prix non horodaté (veille manuelle) */
function priceAgeDays(ts) {
  if (!ts) return null;
  const d = (REF_DATE - new Date(ts)) / 86400000;
  return isNaN(d) ? null : Math.max(0, Math.round(d));
}
/** point de fraîcheur : ● vert < 2 j, orange < 7 j, rouge ≥ 7 j, gris = non daté */
function freshnessDot(ts) {
  const age = priceAgeDays(ts);
  if (age === null) return { char: "●", color: "#94a3b8", label: "prix non horodaté (veille manuelle)" };
  if (age < 2) return { char: "●", color: "#16a34a", label: `prix collecté il y a ${age} j` };
  if (age < 7) return { char: "●", color: "#f59e0b", label: `prix collecté il y a ${age} j` };
  return { char: "●", color: "#dc2626", label: `prix périmé (${age} j)` };
}
const CONFIDENCE_LABEL = {
  structured: "prix lu en JSON-LD structuré (fiable)",
  selector: "prix lu par sélecteur sur la fiche produit",
  manual: "prix saisi manuellement (veille)",
};

/** un prix est suspect s'il s'écarte de plus de 30 % de la médiane du marché
 *  (hors ruptures) de sa référence → affiché avec un ⚠ mais conservé */
function isSuspicious(productId, price) {
  const others = Object.values(HISTORY)
    .filter((h) => h.product === productId && h.stock !== "out" && h.current !== price)
    .map((h) => h.current);
  if (others.length < 2) return false;
  others.sort((a, b) => a - b);
  const median = others[Math.floor(others.length / 2)];
  return Math.abs(price - median) / median > 0.3;
}

const TODAY = EXTERNAL_DATA
  ? HISTORY[FIRST_KEY]?.points[HISTORY[FIRST_KEY].points.length - 1]?.month ?? "—"
  : MONTHS[N_MONTHS - 1];
const DATA_SOURCE = EXTERNAL_DATA
  ? `🟢 Données réelles — dernier run : ${EXTERNAL_DATA.updatedAt.slice(0, 10)}`
  : "🟡 Mode démo — données simulées (collez data/history.json dans EXTERNAL_DATA)";

const key = (pid, rid) => `${pid}|${rid}`;
const eur = (v) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(v);
const eurShort = (v) => `${Math.round(v)} €`;

// ------------------------------------------------------------------
// Helpers d'analyse de marché
// ------------------------------------------------------------------

/** couleur d'une cellule selon l'écart au MSRP :
 *  - prix au MSRP → bleu
 *  - au-dessus du MSRP → vert, dégradé par paliers (plus c'est haut, plus c'est foncé)
 *  - en dessous du MSRP → rouge, dégradé par paliers (plus c'est bas, plus c'est foncé) */
function heatColor(gapPct) {
  const a = Math.abs(gapPct);
  if (a <= 0.005) return "#bfdbfe";        // au MSRP : bleu
  if (gapPct > 0) {
    // au-dessus : vert clair → vert foncé
    if (gapPct <= 0.02) return "#d1fae5";
    if (gapPct <= 0.05) return "#a7f3d0";
    if (gapPct <= 0.10) return "#6ee7b7";
    if (gapPct <= 0.20) return "#34d399";
    return "#10b981";
  }
  // en dessous : rouge clair → rouge foncé
  if (gapPct >= -0.02) return "#fee2e2";
  if (gapPct >= -0.05) return "#fecaca";
  if (gapPct >= -0.10) return "#fca5a5";
  if (gapPct >= -0.20) return "#f87171";
  return "#ef4444";
}

/** stats de marché d'une référence (sur les offres actives) */
function marketStats(pid) {
  const p = PRODUCTS.find((x) => x.id === pid);
  const entries = Object.values(HISTORY).filter(
    (h) => h.product === pid && h.stock !== "out"
  );
  if (!entries.length) return null;
  const prices = entries.map((e) => e.current);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
  const atMsrp = entries.filter((e) => Math.abs(e.current - p.msrp) < 0.5).length;
  const below = entries.filter((e) => e.current < p.msrp - 0.5).length;
  const above = entries.filter((e) => e.current > p.msrp + 0.5).length;
  const dispersion = ((max - min) / p.msrp) * 100;
  const delta1mAgg = entries.map((e) => e.delta1m);
  const avgDelta1m = delta1mAgg.reduce((s, v) => s + v, 0) / entries.length;
  return {
    product: p, n: entries.length, min, max, avg,
    atMsrp, below, above,
    avgGapPct: ((avg - p.msrp) / p.msrp) * 100,
    dispersion,
    avgDelta1m,
    minRetailer: entries.find((e) => e.current === min)?.retailer,
    maxRetailer: entries.find((e) => e.current === max)?.retailer,
  };
}

/** stats d'un revendeur sur l'ensemble du catalogue */
function retailerStats(rid) {
  const entries = Object.values(HISTORY).filter(
    (h) => h.retailer === rid && h.stock !== "out"
  );
  if (!entries.length) return null;
  const gaps = entries.map((h) => {
    const msrp = PRODUCTS.find((p) => p.id === h.product).msrp;
    return ((h.current - msrp) / msrp) * 100;
  });
  const avgGapPct = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const deltas = entries.map((h) => h.delta1m);
  const avgDelta1m = deltas.reduce((s, v) => s + v, 0) / deltas.length;
  const changes = entries.filter((h) => h.delta1m !== 0).length;
  return { n: entries.length, avgGapPct, avgDelta1m, changes };
}

// ------------------------------------------------------------------
// Matrice complète : toutes les références × tous les revendeurs
// ------------------------------------------------------------------
function PriceMatrix({ onSelect }) {
  const [family, setFamily] = useState("ALL");
  const [sortBy, setSortBy] = useState("id");

  const families = ["ALL", "EXO", "SC", "TS"];
  const familyOrder = { EXO: 0, SC: 1, TS: 2 };
  const visibleProducts = useMemo(
    () =>
      PRODUCTS
        .filter((p) => family === "ALL" || p.family === family)
        .sort((a, b) => {
          // Toujours regrouper par série : EXO → SC → TS
          if (a.family !== b.family) return familyOrder[a.family] - familyOrder[b.family];
          if (sortBy === "id") return a.msrp - b.msrp;
          const sa = marketStats(a.id), sb = marketStats(b.id);
          if (!sa || !sb) return 0;
          if (sortBy === "gap") return sa.avgGapPct - sb.avgGapPct;
          if (sortBy === "dispersion") return sb.dispersion - sa.dispersion;
          return 0;
        }),
    [family, sortBy]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-600">Série :</span>
        {families.map((f) => (
          <button
            key={f}
            onClick={() => setFamily(f)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              family === f ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-200"
            }`}
          >
            {f === "ALL" ? "Toutes" : f}
          </button>
        ))}
        <span className="ml-4 text-sm font-medium text-slate-600">Trier par :</span>
        {[
          { id: "id", label: "Prix MSRP" },
          { id: "gap", label: "Écart moyen au MSRP" },
          { id: "dispersion", label: "Dispersion du marché" },
        ].map((s) => (
          <button
            key={s.id}
            onClick={() => setSortBy(s.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              sortBy === s.id ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-200"
            }`}
          >
            {s.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 text-[11px] text-slate-500">
          <span>Légende écart MSRP :</span>
          {[
            { l: "≥ MSRP", c: heatColor(0.03) },
            { l: "Au MSRP", c: heatColor(0) },
            { l: "0 à -4%", c: heatColor(-0.03) },
            { l: "-4 à -8%", c: heatColor(-0.06) },
            { l: "< -8%", c: heatColor(-0.1) },
          ].map((x) => (
            <span key={x.l} className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: x.c }} />
              {x.l}
            </span>
          ))}
          <span className="ml-3">Fraîcheur :</span>
          <span className="flex items-center gap-1"><span style={{ color: "#16a34a" }}>●</span> &lt; 2 j</span>
          <span className="flex items-center gap-1"><span style={{ color: "#f59e0b" }}>●</span> &lt; 7 j</span>
          <span className="flex items-center gap-1"><span style={{ color: "#dc2626" }}>●</span> périmé</span>
          <span className="flex items-center gap-1"><span style={{ color: "#94a3b8" }}>●</span> non daté</span>
          <span className="flex items-center gap-1">⚠ prix atypique vs marché</span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[1100px] text-sm">
          <thead>
            <tr className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <th className="sticky left-0 z-10 bg-slate-50 px-4 py-3 text-left">Référence</th>
              <th className="px-3 py-3 text-right">MSRP</th>
              {RETAILERS.map((r) => (
                <th key={r.id} className="px-3 py-3 text-center">
                  <div className="font-semibold text-slate-700">{r.name}</div>
                  <div className="text-[10px] normal-case text-slate-400">{COUNTRY_FLAG[r.country]} {r.country}</div>
                </th>
              ))}
              <th className="px-3 py-3 text-center">Prix min</th>
              <th className="px-3 py-3 text-center">Prix max</th>
              <th className="px-3 py-3 text-center">Moy. marché</th>
              <th className="px-3 py-3 text-center">Écart moy.</th>
              <th className="px-3 py-3 text-center">Dispersion</th>
            </tr>
          </thead>
          <tbody>
            {visibleProducts.map((p, i) => {
              const s = marketStats(p.id);
              const prevFamily = i > 0 ? visibleProducts[i - 1].family : null;
              const showFamilyHeader = p.family !== prevFamily;
              const FAMILY_LABEL = { EXO: "Enceintes EXO", SC: "Moniteurs SC", TS: "Caissons de basses TS" };
              return (
                <React.Fragment key={p.id}>
                  {showFamilyHeader && (
                    <tr className="bg-slate-100/70">
                      <td colSpan={RETAILERS.length + 6} className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">
                        {FAMILY_LABEL[p.family]}
                      </td>
                    </tr>
                  )}
                <tr className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="sticky left-0 z-10 bg-white px-4 py-2.5">
                    <button onClick={() => onSelect(p.id)} className="text-left">
                      <div className="font-semibold text-slate-900 hover:underline">{p.id}</div>
                      <div className="text-[10px] text-slate-400">Série {p.family}</div>
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium text-slate-600">{eurShort(p.msrp)}</td>
                  {RETAILERS.map((r) => {
                    const h = HISTORY[key(p.id, r.id)];
                    if (!h) {
                      return (
                        <td key={r.id} className="px-3 py-2.5 text-center text-slate-300">
                          <span className="text-[11px]">— n/r</span>
                        </td>
                      );
                    }
                    if (h.stock === "out") {
                      // Rupture : le prix reste une info de marché → affiché, grisé, marqué ⛔
                      const gapPct = (h.current - p.msrp) / p.msrp;
                      const fr = freshnessDot(h.ts);
                      return (
                        <td
                          key={r.id}
                          className="px-2 py-2.5 text-center"
                          style={{ background: heatColor(gapPct), opacity: 0.55 }}
                          title={`${r.name} · ${eur(h.current)} · RUPTURE chez le revendeur · écart ${gapPct > 0 ? "+" : ""}${(gapPct * 100).toFixed(1)}% · ${fr.label} · ${CONFIDENCE_LABEL[h.confidence] ?? CONFIDENCE_LABEL.manual}`}
                        >
                          <div className="font-semibold text-slate-500 line-through">{eurShort(h.current)}</div>
                          <div className="flex items-center justify-center gap-1 text-[10px] text-slate-500">
                            <span>⛔</span>
                            <span style={{ color: fr.color }}>{fr.char}</span>
                          </div>
                        </td>
                      );
                    }
                    const gapPct = (h.current - p.msrp) / p.msrp;
                    const trend = h.delta1m;
                    const fr = freshnessDot(h.ts);
                    const suspicious = isSuspicious(p.id, h.current);
                    return (
                      <td
                        key={r.id}
                        className="px-2 py-2.5 text-center"
                        style={{ background: heatColor(gapPct) }}
                        title={`${r.name} · ${eur(h.current)} · écart ${gapPct > 0 ? "+" : ""}${(gapPct * 100).toFixed(1)}% · var. 1 mois ${trend > 0 ? "+" : ""}${trend} €${h.stock === "low" ? " · stock faible" : ""} · ${fr.label} · ${CONFIDENCE_LABEL[h.confidence] ?? CONFIDENCE_LABEL.manual}${suspicious ? " · ⚠ prix atypique vs marché (à vérifier)" : ""}`}
                      >
                        <div className="font-semibold text-slate-800">
                          {eurShort(h.current)}
                          {suspicious && <span className="ml-1 text-amber-600">⚠</span>}
                        </div>
                        <div className="flex items-center justify-center gap-1 text-[10px]">
                          <span style={{ color: fr.color }}>{fr.char}</span>
                          <span className="font-medium text-slate-500">
                            {gapPct > 0 ? "+" : ""}{(gapPct * 100).toFixed(0)}%
                          </span>
                          {trend !== 0 && (
                            <span className={trend < 0 ? "text-emerald-700" : "text-red-700"}>
                              {trend < 0 ? "▼" : "▲"}
                            </span>
                          )}
                          {h.stock === "low" && <span className="text-amber-700">⚑</span>}
                        </div>
                      </td>
                    );
                  })}
                  {s ? (
                    <>
                      <td
                        className="px-2 py-2.5 text-center"
                        style={{ background: heatColor((s.min - p.msrp) / p.msrp) }}
                        title={`Prix min · ${eur(s.min)} · ${RETAILERS.find((r) => r.id === s.minRetailer)?.name} · écart ${(((s.min - p.msrp) / p.msrp) * 100).toFixed(1)}%`}
                      >
                        <div className="font-semibold text-slate-800">{eurShort(s.min)}</div>
                        <div className="text-[10px] text-slate-500">{RETAILERS.find((r) => r.id === s.minRetailer)?.name}</div>
                      </td>
                      <td
                        className="px-2 py-2.5 text-center"
                        style={{ background: heatColor((s.max - p.msrp) / p.msrp) }}
                        title={`Prix max · ${eur(s.max)} · ${RETAILERS.find((r) => r.id === s.maxRetailer)?.name} · écart ${(((s.max - p.msrp) / p.msrp) * 100).toFixed(1)}%`}
                      >
                        <div className="font-semibold text-slate-800">{eurShort(s.max)}</div>
                        <div className="text-[10px] text-slate-500">{RETAILERS.find((r) => r.id === s.maxRetailer)?.name}</div>
                      </td>
                      <td className="px-3 py-2.5 text-center font-semibold text-slate-700">{eurShort(s.avg)}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span
                          className="font-semibold"
                          style={{ color: s.avgGapPct <= -3 ? "#16a34a" : s.avgGapPct <= 0 ? "#65a30d" : "#dc2626" }}
                        >
                          {s.avgGapPct > 0 ? "+" : ""}{s.avgGapPct.toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className="font-medium text-slate-600">{s.dispersion.toFixed(1)}%</span>
                      </td>
                    </>
                  ) : (
                    <td colSpan={5} className="px-3 py-2.5 text-center text-[11px] text-slate-400">
                      Aucune offre trackée — {p.msrp ? "référence non disponible chez les revendeurs suivis" : ""}
                    </td>
                  )}
                </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400">
        n/r = non référencé · ▼/▲ = variation vs mois précédent · ⚑ = stock faible · survolez une cellule pour le détail.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------
// Détail produit : historique prix + tableau complet par revendeur
// ------------------------------------------------------------------
function ProductDetail({ pid, onBack }) {
  const p = PRODUCTS.find((x) => x.id === pid);
  const offers = RETAILERS.map((r) => ({ r, h: HISTORY[key(pid, r.id)] }))
    .filter((o) => o.h && o.h.stock !== "out")
    .sort((a, b) => a.h.current - b.h.current);
  const s = marketStats(pid);

  const colors = ["#0ea5e9", "#f97316", "#10b981", "#8b5cf6", "#ef4444", "#eab308", "#14b8a6", "#d946ef", "#64748b", "#f43f5e"];
  const monthLabels = offers.length ? offers[0].h.points.map((pt) => pt.month) : [];
  const chartData = monthLabels.map((m, i) => {
    const row = { month: m };
    offers.forEach((o) => { row[o.r.name] = o.h.points[i]?.price; });
    return row;
  });

  return (
    <div className="space-y-5">
      <div>
        <button onClick={onBack} className="text-sm font-medium text-slate-500 hover:text-slate-800">← Retour à la matrice</button>
        <h2 className="text-2xl font-bold text-slate-900">{p.id}</h2>
        <div className="text-sm text-slate-500">
          MSRP {eur(p.msrp)} · {s.n} revendeurs actifs · prix moyen {eur(s.avg)} ({s.avgGapPct > 0 ? "+" : ""}{s.avgGapPct.toFixed(1)}% vs MSRP)
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 font-semibold text-slate-800">📈 Historique des prix — tous revendeurs ({monthLabels.length} mois)</div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" fontSize={11} />
              <YAxis fontSize={11} domain={["auto", "auto"]} tickFormatter={(v) => `${Math.round(v)}€`} />
              <Tooltip formatter={(v) => eur(v)} />
              <ReferenceLine y={p.msrp} stroke="#dc2626" strokeDasharray="6 3"
                label={{ value: `MSRP ${eur(p.msrp)}`, fontSize: 10, fill: "#dc2626", position: "insideTopRight" }} />
              {offers.map((o, i) => (
                <Line key={o.r.id} type="monotone" dataKey={o.r.name} stroke={colors[i % colors.length]} dot={monthLabels.length < 3 ? { r: 4 } : false} strokeWidth={2} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 font-semibold text-slate-800">📋 État du marché — {pid}</div>
          <div className="space-y-2 text-sm">
            {[
              { l: "Revendeurs au MSRP exact", v: s.atMsrp, color: "text-slate-700" },
              { l: "Revendeurs sous le MSRP", v: s.below, color: "text-emerald-700" },
              { l: "Revendeurs au-dessus du MSRP", v: s.above, color: "text-red-700" },
            ].map((x) => (
              <div key={x.l} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-slate-600">{x.l}</span>
                <span className={`font-bold ${x.color}`}>{x.v} / {s.n}</span>
              </div>
            ))}
            <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
              <span className="text-slate-600">Amplitude min→max (dispersion)</span>
              <span className="font-bold text-slate-700">{eur(s.min)} → {eur(s.max)} ({s.dispersion.toFixed(1)}%)</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
              <span className="text-slate-600">Variation moyenne 1 mois (tous revendeurs)</span>
              <span className={`font-bold ${s.avgDelta1m <= 0 ? "text-emerald-700" : "text-red-700"}`}>
                {s.avgDelta1m > 0 ? "+" : ""}{s.avgDelta1m.toFixed(2)} €
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Revendeur</th>
              <th className="px-4 py-3">Prix actuel</th>
              <th className="px-4 py-3">Écart MSRP</th>
              <th className="px-4 py-3">Var. 1 mois</th>
              <th className="px-4 py-3">Stock</th>
              <th className="px-4 py-3">Site</th>
            </tr>
          </thead>
          <tbody>
            {offers.map((o) => {
              const gap = o.h.current - p.msrp;
              const gapPct = (gap / p.msrp) * 100;
              return (
                <tr key={o.r.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">{COUNTRY_FLAG[o.r.country]} {o.r.name}</td>
                  <td className="px-4 py-3 font-semibold">{eur(o.h.current)}</td>
                  <td className="px-4 py-3">
                    <span className={`font-medium ${gap <= -3 ? "text-emerald-700" : gap <= 0 ? "text-lime-700" : "text-red-700"}`}>
                      {gap > 0 ? "+" : ""}{eur(gap)} ({gapPct > 0 ? "+" : ""}{gapPct.toFixed(1)}%)
                    </span>
                  </td>
                  <td className={`px-4 py-3 font-medium ${o.h.delta1m <= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {o.h.delta1m === 0 ? "→ stable" : o.h.delta1m < 0 ? `▼ ${eur(-o.h.delta1m)}` : `▲ ${eur(o.h.delta1m)}`}
                  </td>
                  <td className="px-4 py-3">
                    {o.h.stock === "low" ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Stock faible</span>
                    ) : (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">En stock</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {o.r.catalogUrl ? (
                      <a href={o.r.catalogUrl} target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                        {o.r.site} ↗
                      </a>
                    ) : (
                      <span className="text-sky-600">{o.r.site}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Vue revendeurs : positionnement de chaque enseigne sur tout le catalogue
// ------------------------------------------------------------------
function RetailerView() {
  const cards = RETAILERS.map((r) => ({ r, s: retailerStats(r.id) }))
    .filter((x) => x.s)
    .sort((a, b) => a.s.avgGapPct - b.s.avgGapPct);

  // v9 : un revendeur est en "collecte auto" si au moins un de ses prix
  // est horodaté par le scraper (sinon veille manuelle)
  const isAuto = (rid) =>
    Object.values(HISTORY).some((h) => h.retailer === rid && h.ts);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-900">🏬 Positionnement marché par revendeur (catalogue complet)</h2>
        <p className="text-sm text-slate-500">
          Trié du moins cher au plus cher (écart moyen au MSRP). Le lien de chaque enseigne ouvre sa page EVE Audio pour vérifier les prix en direct.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((x, i) => (
          <div
            key={x.r.id}
            className={`rounded-xl border bg-white p-4 shadow-sm transition hover:shadow-md ${
              i === 0 ? "border-emerald-300 ring-1 ring-emerald-200" : "border-slate-200"
            }`}
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg">{COUNTRY_FLAG[x.r.country]}</span>
                  <span className="font-bold text-slate-900">{x.r.name}</span>
                  {i === 0 && (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                      Meilleur prix moyen
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">{x.r.site}</div>
              </div>
              <span
                className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  isAuto(x.r.id) ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                }`}
                title={isAuto(x.r.id)
                  ? "Prix collectés automatiquement chaque matin par le scraper"
                  : "Prix alimentés par veille manuelle (site anti-bot)"}
              >
                {isAuto(x.r.id) ? "✅ Collecte auto" : "✍️ Veille manuelle"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-400">Réf. trackées</div>
                <div className="font-bold text-slate-800">{x.s.n} / {PRODUCTS.length}</div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-400">Écart moyen MSRP</div>
                <div className={`font-bold ${x.s.avgGapPct <= -4 ? "text-emerald-700" : x.s.avgGapPct <= 0 ? "text-lime-700" : "text-red-700"}`}>
                  {x.s.avgGapPct > 0 ? "+" : ""}{x.s.avgGapPct.toFixed(1)}%
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-400">Var. moyenne 1 mois</div>
                <div className={`font-bold ${x.s.avgDelta1m <= 0 ? "text-emerald-700" : "text-red-700"}`}>
                  {x.s.avgDelta1m > 0 ? "+" : ""}{x.s.avgDelta1m.toFixed(2)} €
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-400">Prix en mouvement</div>
                <div className="font-bold text-slate-800">{x.s.changes} réf.</div>
              </div>
            </div>

            {x.r.catalogUrl && (
              <a
                href={x.r.catalogUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 transition hover:bg-sky-100"
              >
                🔗 Page EVE Audio de l'enseigne ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// App
// ------------------------------------------------------------------
export default function App() {
  const [tab, setTab] = useState("matrix");
  const [selected, setSelected] = useState(null);

  const tabs = [
    { id: "matrix", label: "📊 Matrice prix" },
    { id: "retailers", label: "🏬 Revendeurs" },
  ];

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">🔊 Veille tarifaire EVE Audio — état du marché</h1>
            <p className="text-sm text-slate-500">
              {DATA_SOURCE} · {PRODUCTS.length} références × {RETAILERS.length} revendeurs (FR · DE · UK)
            </p>
          </div>
          {!selected && (
            <div className="flex gap-2">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                    tab === t.id ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </header>

        {selected ? (
          <ProductDetail pid={selected} onBack={() => setSelected(null)} />
        ) : tab === "matrix" ? (
          <PriceMatrix onSelect={setSelected} />
        ) : (
          <RetailerView />
        )}

        <footer className="text-xs text-slate-400">
          MSRP = prix indicatif constructeur TTC.{" "}
          {EXTERNAL_DATA
            ? "Données collectées par le backend de scraping EVE Audio (mis à jour quotidiennement)."
            : "Données simulées à des fins de démonstration — le backend de scraping EVE Audio génère data/history.json : collez son contenu dans EXTERNAL_DATA pour passer en données réelles."}
        </footer>
      </div>
    </div>
  );
}
