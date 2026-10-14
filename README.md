# EVE Tracker — veille tarifaire EVE Audio (Europe)

Application autonome de suivi des prix EVE Audio (16 références, 11 revendeurs FR/DE/UK).

- **`scraper/`** : scraper TypeScript (Playwright + SQLite) — collecte les prix sur les
  fiches produits (extraction JSON-LD puis sélecteurs CSS), stocke un snapshot par run
  dans `data/tracker.db` et exporte `data/history.json`.
- **`app/`** : dashboard React (Vite + Recharts) — matrice prix × revendeurs avec
  code couleur vs MSRP, fraîcheur, confiance, ruptures et historique par produit.
- **`.github/workflows/scrape-deploy.yml`** : chaque jour à 06h00 UTC, relance la collecte,
  copie `data/history.json` dans `app/src/data.json`, committe, build et déploie le
  dashboard sur GitHub Pages.

Site publié : https://lucus-hub.github.io/eve-tracker/

## Lancement manuel
Onglet **Actions** → *Scrape & Deploy* → **Run workflow**.

## Règles de fiabilité des prix
- Sources : uniquement les sites des revendeurs trackés (liste blanche dans le scraper).
- Prix lus sur fiche produit (JSON-LD prioritaire) ; cellule vide si aucun prix fiable.
- Music Store : storefront France uniquement (prix géo-dépendants).
- Prix en rupture conservés (état du marché), affichés grisés avec marqueur ⛔.
- Rejet : B-stock/Retoure/paires, prix hors bornes MSRP ±35 %.
