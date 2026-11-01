(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.core = {
    create() {
      const VERSION = '1.0.2';
      const CACHE_TTL = Infinity;
      const ERROR_CACHE_TTL = 60 * 1000;
      const CACHE_PREFIX = 'wm_avg_v3_';
      const MAX_CONCURRENT = 3;
      const BULK_RARITY_LAST_LOAD_KEY = 'wm_bulk_rarity_last_load_v1';
      const ALL_COLLECTION_KEY = 'wm_all_collection_v1';
      const PULL_RECAP_ENABLED_KEY = 'wm_pull_recap_enabled_v1';
      const PULL_STATS_KEY = 'wm_pull_stats_v1';
      const AUTO_OPEN_ENABLED_KEY = 'wm_auto_open_enabled_v1';
      const AUTO_OPEN_NEXT_AT_KEY = 'wm_auto_open_next_at_v1';
      const AUTO_OPEN_SESSION_KEY = 'wm_auto_open_session_v1';
      const AUTO_OPEN_MIN_MINUTES_KEY = 'wm_auto_open_min_minutes_v1';
      const AUTO_OPEN_MAX_MINUTES_KEY = 'wm_auto_open_max_minutes_v1';
      const AUTO_OPEN_DEFAULT_MIN_MINUTES = 20;
      const AUTO_OPEN_DEFAULT_MAX_MINUTES = 100;
      const AUTO_OPEN_MIN_DELAY = AUTO_OPEN_DEFAULT_MIN_MINUTES * 60 * 1000;
      const AUTO_OPEN_MAX_DELAY = AUTO_OPEN_DEFAULT_MAX_MINUTES * 60 * 1000;
      const COMPACT_MODE_KEY = 'wm_compact_mode_v1';
      const MISSING_IMAGE_CACHE_PREFIX = 'wm_missing_img_v3_';
      const MISSING_IMAGE_FOUND_TTL = 30 * 24 * 60 * 60 * 1000;
      const MISSING_IMAGE_MISS_TTL = 12 * 60 * 60 * 1000;
      const RARITIES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
      const DEFAULT_RARE_RARITIES = ['L', 'UR', 'SR', 'R'];

      const cardMetaById = new Map();
      const idByTitle = new Map();
      const cacheMemory = new Map();

      function isCollectionPage() {
        return location.pathname === '/collection' || location.pathname.startsWith('/collection/');
      }

      function isMarketplaceDetailPage() {
        return /^\/marketplace\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(location.pathname);
      }

      function isMarketplacePage() {
        return location.pathname === '/marketplace' || location.pathname.startsWith('/marketplace/');
      }

      function isPullsPage() {
        return location.pathname === '/pulls' || location.pathname.startsWith('/pulls/');
      }

      function isTradesPage() {
        return location.pathname === '/trades' || location.pathname.startsWith('/trades/');
      }

      function isGlobalCollectionPage() {
        return location.pathname === '/global-collection' || location.pathname.startsWith('/global-collection/');
      }

      function isGuildPage() {
        return location.pathname === '/guild' || location.pathname.startsWith('/guild/');
      }

      function isLastPullCardVisible() {
        if (!isPullsPage()) return false;

        for (const el of document.querySelectorAll('main div')) {
          const text = String(el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();

          const match = text.match(/^Carte\s*(\d+)\s*\/\s*(\d+)$/i);
          if (!match) continue;

          const current = Number(match[1]);
          const total = Number(match[2]);
          return total > 0 && current === total;
        }

        return false;
      }

      function normalizeTitle(value) {
        return String(value || '')
          .normalize('NFC')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function cacheKey(id) {
        return CACHE_PREFIX + id;
      }

      function readLocalValue(key) {
        try {
          const raw = localStorage.getItem(key);
          return raw == null ? undefined : JSON.parse(raw);
        } catch (_) {
          return undefined;
        }
      }

      function writeLocalValue(key, value) {
        try {
          localStorage.setItem(key, JSON.stringify(value));
          return true;
        } catch (error) {
          console.warn('[WM Average] localStorage indisponible', error);
          return false;
        } finally {
          if (key.startsWith(CACHE_PREFIX)) window.dispatchEvent?.(new CustomEvent('wm-file-sync-local-change', { detail: { key } }));
        }
      }

      function storageGet(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const result = {};

        for (const key of list) {
          const value = readLocalValue(key);
          if (value !== undefined) {
            result[key] = value;
          }
        }

        return result;
      }

      function storageSet(values) {
        for (const [key, value] of Object.entries(values || {})) {
          writeLocalValue(key, value);
        }
      }

      function isCacheEntryValid(entry, now = Date.now()) {
        if (!entry || !Number.isFinite(Number(entry.fetchedAt)) || Number(entry.fetchedAt) <= 0) return false;
        if (entry.ok === false) return now - Number(entry.fetchedAt) < ERROR_CACHE_TTL;
        return entry.ok === true && entry.averages && typeof entry.averages === 'object'
          && !Array.isArray(entry.averages);
      }

      function cleanupPriceCacheOnceDaily() {
        // Successful prices have no expiry or automatic eviction in the Atlas fork.
      }

      // Preserve prices previously fetched by our extension in this panel.
      const legacy = readLocalValue('wikimasters-prices:cache:v1');
      for (const [id, hit] of Object.entries(legacy || {})) {
        if (!/^[0-9a-f-]{36}$/i.test(id) || !hit?.summary || !Number.isFinite(hit.time)) continue;
        const existing = readLocalValue(cacheKey(id));
        if (existing?.ok === true && Number(existing.fetchedAt) >= hit.time) continue;
        const averages = {};
        for (const [rarity, value] of Object.entries(hit.summary)) {
          const average = value?.average;
          if (average != null && average !== '' && typeof average !== 'boolean' && Number.isFinite(Number(average))) {
            averages[rarity] = Number(average);
          }
        }
        writeLocalValue(cacheKey(id), { fetchedAt: hit.time, ok: true, averages });
      }

      function isContextInvalidatedError(error) {
        return String(error?.message || error).includes('Extension context invalidated');
      }

      function reportError(scope, error) {
        if (isContextInvalidatedError(error)) return;
        console.error(`[WM Average] ${scope}`, error);
      }

      // Étiquettes { id, name, color } fusionnées sans doublon (par id, ou par nom à défaut).
      function mergeTags(...lists) {
        const byKey = new Map();

        for (const list of lists) {
          if (!Array.isArray(list)) continue;

          for (const raw of list) {
            const tag = typeof raw === 'string' ? { name: raw } : raw;
            const name = String(tag?.name || '').trim();
            if (!name) continue;

            const id = tag.id ? String(tag.id) : null;
            const merged = { id, name, color: tag.color || null };
            if (Number.isFinite(tag.cardCount)) merged.cardCount = tag.cardCount;
            byKey.set(id || name, merged);
          }
        }

        return [...byKey.values()];
      }

      function registerCards(cards) {
        const seenIds = new Set();

        for (const meta of cards) {
          if (!meta?.id || !meta?.title) continue;

          // Plusieurs exemplaires d'une même carte dans un lot : on cumule nombre, favori et étiquettes.
          const sameBatch = seenIds.has(meta.id) ? cardMetaById.get(meta.id) : null;
          seenIds.add(meta.id);

          const normalized = {
            ...cardMetaById.get(meta.id),
            id: meta.id,
            title: meta.title,
            rarity: meta.rarity || null,
            imageUrl: meta.imageUrl || null,
            wikipediaUrl: meta.wikipediaUrl || cardMetaById.get(meta.id)?.wikipediaUrl || null,
            count: Number(meta.count) || 1,
            ownedCardId: meta.ownedCardId || cardMetaById.get(meta.id)?.ownedCardId || null,
            ownedCardIds: Array.isArray(meta.ownedCardIds)
              ? [...meta.ownedCardIds]
              : (cardMetaById.get(meta.id)?.ownedCardIds || [])
          };

          if (sameBatch) {
            normalized.ownedCardIds = [...new Set([
              ...(sameBatch.ownedCardIds || []),
              ...normalized.ownedCardIds
            ])];
            normalized.ownedCardId = sameBatch.ownedCardId || normalized.ownedCardId;
            normalized.count = Math.max(
              sameBatch.count || 1,
              normalized.count,
              normalized.ownedCardIds.length
            );
          }

          if (Array.isArray(meta.ownedCopies)) {
            normalized.ownedCopies = [...new Map([
              ...(sameBatch?.ownedCopies || []), ...meta.ownedCopies
            ].map(copy => [copy.id, copy])).values()];
          }

          // Seule la collection fournit ces champs : les autres sources ne doivent pas les effacer.
          if (typeof meta.starred === 'boolean') {
            normalized.starred = meta.starred || Boolean(sameBatch?.starred);
          }
          if (Array.isArray(meta.tags)) {
            normalized.tags = mergeTags(sameBatch?.tags, meta.tags);
          }

          cardMetaById.set(normalized.id, normalized);
          idByTitle.set(normalizeTitle(normalized.title), normalized.id);
        }
      }

      function createSponsorNote() {
        const note = document.createElement('div');
        note.className = 'wm-sponsor-note';
        note.append(document.createTextNode('Projet d’origine : kzfamily · '));

        const link = document.createElement('a');
        link.href = 'https://www.twitch.tv/botkz';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'botkz';

        note.append(link);
        return note;
      }


      return {
        VERSION, CACHE_TTL, ERROR_CACHE_TTL, MAX_CONCURRENT, BULK_RARITY_LAST_LOAD_KEY,
        ALL_COLLECTION_KEY, PULL_RECAP_ENABLED_KEY, PULL_STATS_KEY,
        AUTO_OPEN_ENABLED_KEY, AUTO_OPEN_NEXT_AT_KEY, AUTO_OPEN_SESSION_KEY,
        AUTO_OPEN_MIN_MINUTES_KEY, AUTO_OPEN_MAX_MINUTES_KEY,
        AUTO_OPEN_DEFAULT_MIN_MINUTES, AUTO_OPEN_DEFAULT_MAX_MINUTES,
        AUTO_OPEN_MIN_DELAY, AUTO_OPEN_MAX_DELAY, COMPACT_MODE_KEY,
        MISSING_IMAGE_CACHE_PREFIX, MISSING_IMAGE_FOUND_TTL, MISSING_IMAGE_MISS_TTL,
        RARITIES, DEFAULT_RARE_RARITIES, cardMetaById, idByTitle, cacheMemory,
        isCollectionPage, isMarketplaceDetailPage, isMarketplacePage, isPullsPage,
        isTradesPage, isGlobalCollectionPage, isGuildPage, isLastPullCardVisible, normalizeTitle,
        cacheKey, readLocalValue, writeLocalValue, storageGet, storageSet,
        isCacheEntryValid, cleanupPriceCacheOnceDaily, isContextInvalidatedError,
        reportError, mergeTags, registerCards, createSponsorNote
      };
    }
  };
})();
