(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.imageResolver = {
    create(deps) {
      const {
        normalizeTitle,
        readLocalValue,
        writeLocalValue,
        MISSING_IMAGE_CACHE_PREFIX,
        MISSING_IMAGE_FOUND_TTL,
        MISSING_IMAGE_MISS_TTL
      } = deps;

      const pending = new Map();

      function cacheKey(title) {
        return MISSING_IMAGE_CACHE_PREFIX + encodeURIComponent(normalizeTitle(title));
      }

      function readCache(title) {
        const entry = readLocalValue(cacheKey(title));
        if (!entry || !Number.isFinite(Number(entry.fetchedAt))) return null;

        const ttl = entry.found ? MISSING_IMAGE_FOUND_TTL : MISSING_IMAGE_MISS_TTL;
        if (Date.now() - Number(entry.fetchedAt) >= ttl) return null;
        return entry;
      }

      function save(title, entry) {
        const value = {
          fetchedAt: Date.now(),
          found: Boolean(entry?.found),
          url: entry?.url || null,
          source: entry?.source || null,
          sourceUrl: entry?.sourceUrl || null,
          creditLabel: entry?.creditLabel || null,
          fileName: entry?.fileName || null
        };
        writeLocalValue(cacheKey(title), value);
        return value;
      }

      function slugifyPokemon(title) {
        return normalizeTitle(title)
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[’']/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
      }

      async function fetchJson(url, source) {
        try {
          const response = await fetch(url, {
            method: 'GET',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            headers: { accept: 'application/json' }
          });

          if (response.status === 404) return null;
          if (!response.ok) throw new Error(`${source} HTTP ${response.status}`);
          return await response.json();
        } catch (error) {
          console.debug(`[WM Image] ${source} error`, url, error);
          return null;
        }
      }

      async function resolveCommonsUrl(fileName) {
        if (!fileName) return null;
        const cleanName = fileName.replace(/^File:/i, '').replace(/^Fichier:/i, '').replace(/ /g, '_');
        const params = new URLSearchParams({
          action: 'query',
          titles: `File:${cleanName}`,
          prop: 'imageinfo',
          iiprop: 'url',
          iiurlwidth: '900',
          format: 'json',
          origin: '*'
        });

        const json = await fetchJson(
          `https://commons.wikimedia.org/w/api.php?${params}`,
          'Wikimedia Commons'
        );

        const page = Object.values(json?.query?.pages || {})[0] || null;
        const info = page?.imageinfo?.[0];
        return info?.thumburl || info?.url || null;
      }

      async function resolveWikipediaSummary(title) {
        const titlesToTry = [title];
        const stripped = title.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
        if (stripped && stripped !== title) titlesToTry.push(stripped);

        for (const t of titlesToTry) {
          for (const language of ['fr', 'en']) {
            const summaryUrl = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}`;
            const json = await fetchJson(summaryUrl, `Wikipedia-${language}-summary`);
            const imageUrl = json?.thumbnail?.source || json?.originalimage?.source || null;

            if (imageUrl && !imageUrl.includes('Disambig') && !imageUrl.includes('disambig')) {
              return {
                found: true,
                url: imageUrl,
                source: 'wikipedia-summary',
                sourceUrl: json?.content_urls?.desktop?.page || `https://${language}.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`,
                creditLabel: 'Wikipédia',
                fileName: json?.thumbnail?.original || null
              };
            }
          }
        }

        return null;
      }

      async function searchWikidata(title) {
        const ids = [];
        const seen = new Set();

        for (const language of ['fr', 'en']) {
          const params = new URLSearchParams({
            action: 'wbsearchentities',
            search: title,
            language,
            uselang: language,
            type: 'item',
            limit: '5',
            format: 'json',
            origin: '*'
          });

          const json = await fetchJson(
            `https://www.wikidata.org/w/api.php?${params}`,
            'Wikidata'
          );

          for (const item of json?.search || []) {
            if (!item?.id || seen.has(item.id)) continue;
            seen.add(item.id);
            ids.push({
              id: item.id,
              label: item.label || '',
              description: item.description || '',
              aliases: Array.isArray(item.aliases) ? item.aliases : []
            });
          }
        }

        if (!ids.length) return [];

        const params = new URLSearchParams({
          action: 'wbgetentities',
          ids: ids.map((item) => item.id).join('|'),
          props: 'claims|labels|descriptions|sitelinks',
          languages: 'fr|en',
          languagefallback: '1',
          format: 'json',
          origin: '*'
        });

        const json = await fetchJson(
          `https://www.wikidata.org/w/api.php?${params}`,
          'Wikidata'
        );

        return ids.map((result, index) => ({
          ...result,
          index,
          entity: json?.entities?.[result.id] || null
        }));
      }

      function normalizedCompare(value) {
        return normalizeTitle(value)
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLocaleLowerCase('fr')
          .replace(/[’']/g, "'")
          .replace(/\s+/g, ' ')
          .trim();
      }

      function candidateScore(candidate, title) {
        const wanted = normalizedCompare(title);
        const labels = [
          candidate.label,
          candidate.entity?.labels?.fr?.value,
          candidate.entity?.labels?.en?.value,
          ...(candidate.aliases || [])
        ].filter(Boolean).map(normalizedCompare);

        let score = Math.max(0, 40 - candidate.index * 3);
        if (labels.some((label) => label === wanted)) score += 80;
        else if (labels.some((label) => label.includes(wanted) || wanted.includes(label))) score += 30;

        if (candidate.entity?.claims?.P18?.length) score += 25;
        if (candidate.entity?.claims?.P154?.length) score += 10;
        return score;
      }

      function claimFileName(entity, property) {
        for (const statement of entity?.claims?.[property] || []) {
          const value = statement?.mainsnak?.datavalue?.value;
          if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return null;
      }

      function looksLikePokemon(candidate) {
        const description = [
          candidate.description,
          candidate.entity?.descriptions?.fr?.value,
          candidate.entity?.descriptions?.en?.value
        ].filter(Boolean).join(' ').toLocaleLowerCase('fr');

        return /pok[eé]mon/.test(description) ||
          Boolean(candidate.entity?.claims?.P1685?.length);
      }

      async function resolvePokemon(title, candidate = null) {
        if (candidate && !looksLikePokemon(candidate)) return null;

        const slug = slugifyPokemon(title);
        if (!slug || slug.length > 80) return null;

        const json = await fetchJson(
          `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(slug)}`,
          'PokéAPI'
        );
        if (!json) return null;

        const image =
          json?.sprites?.other?.['official-artwork']?.front_default ||
          json?.sprites?.other?.home?.front_default ||
          json?.sprites?.front_default ||
          null;

        if (!image) return null;

        return {
          found: true,
          url: image,
          source: 'pokeapi',
          sourceUrl: `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(slug)}`,
          creditLabel: 'PokéAPI'
        };
      }

      async function resolveWikidataCandidate(candidate) {
        const entity = candidate?.entity;
        if (!entity) return null;

        const fileName =
          claimFileName(entity, 'P18') ||
          claimFileName(entity, 'P154') ||
          null;

        if (!fileName) return null;

        const directUrl = await resolveCommonsUrl(fileName);
        if (!directUrl) return null;

        return {
          found: true,
          url: directUrl,
          source: 'wikidata',
          sourceUrl: `https://www.wikidata.org/wiki/${candidate.id}`,
          creditLabel: 'Wikidata',
          fileName
        };
      }

      async function resolveWikipedia(title) {
        for (const language of ['fr', 'en']) {
          const params = new URLSearchParams({
            action: 'query',
            format: 'json',
            origin: '*',
            redirects: '1',
            prop: 'pageimages',
            piprop: 'thumbnail|name',
            pithumbsize: '900',
            titles: title
          });

          const json = await fetchJson(
            `https://${language}.wikipedia.org/w/api.php?${params}`,
            'Wikipedia'
          );

          const page = Object.values(json?.query?.pages || {})[0] || null;
          const imageUrl = page?.thumbnail?.source || null;
          const fileName = page?.pageimage || null;

          if (imageUrl) {
            return {
              found: true,
              url: imageUrl,
              source: 'wikimedia',
              sourceUrl: fileName
                ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName.replace(/ /g, '_'))}`
                : `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
              creditLabel: 'Wikimedia',
              fileName
            };
          }
        }

        return null;
      }

      async function resolveFresh(title) {
        // 1. Wikipedia Summary REST API (fastest, official lead images, redirect support)
        try {
          const summary = await resolveWikipediaSummary(title);
          if (summary) return summary;
        } catch (error) {
          console.debug('[WM Image] résumé Wikipédia indisponible', title, error);
        }

        // 2. Wikidata search & claims
        let candidates = [];
        try {
          candidates = await searchWikidata(title);
        } catch (error) {
          console.debug('[WM Image] recherche Wikidata indisponible', title, error);
        }

        const ranked = candidates
          .map((candidate) => ({
            candidate,
            score: candidateScore(candidate, title)
          }))
          .sort((a, b) => b.score - a.score);

        const best = ranked[0]?.candidate || null;

        // Branche Pokémon
        if (best && looksLikePokemon(best)) {
          try {
            const pokemon = await resolvePokemon(title, best);
            if (pokemon) return pokemon;
          } catch (error) {
            console.debug('[WM Image] PokéAPI indisponible', title, error);
          }
        }

        // Wikidata claims (P18 image, P154 logo)
        for (const { candidate } of ranked) {
          const entry = await resolveWikidataCandidate(candidate);
          if (entry) return entry;
        }

        // 3. Wikipedia Action API
        try {
          const wikipedia = await resolveWikipedia(title);
          if (wikipedia) return wikipedia;
        } catch (error) {
          console.debug('[WM Image] Wikipedia indisponible', title, error);
        }

        return { found: false };
      }

      async function resolveMissingImage(title) {
        const normalized = normalizeTitle(title);
        if (!normalized) return null;

        const cached = readCache(normalized);
        if (cached) return cached;

        const existing = pending.get(normalized);
        if (existing) return existing;

        const task = (async () => {
          const result = await resolveFresh(normalized);
          return save(normalized, result || { found: false });
        })();

        pending.set(normalized, task);

        try {
          return await task;
        } finally {
          pending.delete(normalized);
        }
      }

      return { resolveMissingImage };
    }
  };
})();
