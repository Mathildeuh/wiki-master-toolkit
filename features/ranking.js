(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.ranking = {
    create(runtime) {
      const {
        ALL_COLLECTION_KEY, cardMetaById, cacheMemory, cacheKey,
        storageGet, storageSet, mergeTags
      } = runtime.core;
      const { formatAverage, chooseAverage } = runtime.priceUi;
      const pendingMarketplaceListings = new Map();
      const pendingBridgeRequests = new Map();

      function rarityMeta(r) {
        switch ((r || '').toUpperCase()) {
          case 'L': return { name: 'Légendaire', color: '#ffe144', bg: 'rgba(255, 225, 68, 0.12)', border: 'rgba(255, 225, 68, 0.3)' };
          case 'UR': return { name: 'Ultra Rare', color: '#fa9931', bg: 'rgba(250, 153, 49, 0.12)', border: 'rgba(250, 153, 49, 0.3)' };
          case 'SR': return { name: 'Super Rare', color: '#ed6fa3', bg: 'rgba(237, 111, 163, 0.12)', border: 'rgba(237, 111, 163, 0.3)' };
          case 'R': return { name: 'Rare', color: '#c6a7f2', bg: 'rgba(198, 167, 242, 0.12)', border: 'rgba(198, 167, 242, 0.3)' };
          case 'PC': return { name: 'Peu commune', color: '#b1cff2', bg: 'rgba(177, 207, 242, 0.12)', border: 'rgba(177, 207, 242, 0.3)' };
          case 'C': return { name: 'Commune', color: '#b8f2d5', bg: 'rgba(184, 242, 213, 0.12)', border: 'rgba(184, 242, 213, 0.3)' };
          default: return { name: r || '—', color: '#9ca3af', bg: 'rgba(255, 255, 255, 0.05)', border: 'rgba(255, 255, 255, 0.1)' };
        }
      }

      // Requête au bridge résolue par l'événement de réponse portant le même requestId.
      function requestBridge(eventName, detail = {}, timeoutMs = 12000) {
        return new Promise((resolve) => {
          const requestId = `${eventName}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

          const timeout = setTimeout(() => {
            const pending = pendingBridgeRequests.get(requestId);
            if (!pending) return;

            pendingBridgeRequests.delete(requestId);
            resolve({
              requestId,
              ok: false,
              timeout: true,
              error: 'La requête a expiré.'
            });
          }, timeoutMs);

          pendingBridgeRequests.set(requestId, { resolve, timeout });
          window.dispatchEvent(new CustomEvent(eventName, {
            detail: { ...detail, requestId }
          }));
        });
      }

      function resolveBridgeRequest(event) {
        const detail = event.detail || {};
        const pending = pendingBridgeRequests.get(detail.requestId);
        if (!pending) return;

        clearTimeout(pending.timeout);
        pendingBridgeRequests.delete(detail.requestId);
        pending.resolve(detail);
      }

      window.addEventListener('wm-average-tag-cards', resolveBridgeRequest);
      window.addEventListener('wm-average-starred-cards', resolveBridgeRequest);
      window.addEventListener('wm-average-tag-options', resolveBridgeRequest);

      function humanElapsed(timestamp) {
        const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000));
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        const remaining = minutes % 60;
        return remaining ? `${hours} h ${remaining} min` : `${hours} h`;
      }

      function requestListing({ button, row, amount, duration, ownedCardId, allowStarred = false }) {
        const requestId = `listing:${row.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

        button.disabled = true;
        button.dataset.state = 'pending';
        button.textContent = ownedCardId ? 'Mise en vente…' : 'Recherche ID…';

        pendingMarketplaceListings.set(requestId, { button, row, amount, duration });

        window.dispatchEvent(new CustomEvent('wm-average-create-listing', {
          detail: {
            requestId,
            ownedCardId,
            catalogueCardId: row.id,
            title: row.title,
            baseAmount: amount,
            durationMinutes: duration,
            allowStarred
          }
        }));
      }

      function mergeKnownCard(stored, seen) {
        const merged = { ...stored, ...seen };
        const storedCopies = Array.isArray(stored.ownedCardIds) ? stored.ownedCardIds : [];
        if (storedCopies.length <= 1) return merged;

        merged.ownedCardIds = [...new Set([
          ...storedCopies,
          ...(Array.isArray(seen.ownedCardIds) ? seen.ownedCardIds : [])
        ])];
        merged.count = Math.max(stored.count || 1, seen.count || 1, merged.ownedCardIds.length);
        merged.starred = Boolean(stored.starred || seen.starred);
        merged.tags = mergeTags(stored.tags, seen.tags);

        return merged;
      }

      async function openRankingModal() {
        const storedCollection = storageGet(ALL_COLLECTION_KEY);
        const collectionEntry = storedCollection[ALL_COLLECTION_KEY];
        const storedCards = Array.isArray(collectionEntry?.cards) ? collectionEntry.cards : [];

        const knownCards = new Map();

        for (const card of storedCards) {
          if (card?.id && card?.title) knownCards.set(card.id, { ...card });
        }

        for (const card of cardMetaById.values()) {
          if (!card?.id || !card?.title) continue;
          if (!knownCards.has(card.id) && !card.ownedCardId && !card.ownedCardIds?.length) continue;
          const previous = knownCards.get(card.id);
          knownCards.set(card.id, previous ? mergeKnownCard(previous, card) : { ...card });
        }

        const candidates = [...knownCards.values()];

        if (!candidates.length) {
          runtime.modalUi.showInfoModal(
            'Aucun prix chargé',
            'Aucune carte avec métadonnées n’est encore disponible. Parcourez votre collection ou utilisez « Actualiser les prix », puis réessayez.'
          );
          return;
        }

        const priceKeys = candidates.map((card) => cacheKey(card.id));
        const prices = storageGet(priceKeys);

        const rows = candidates
          .map((card) => {
            const entry = prices[cacheKey(card.id)];
            if (!entry || entry.ok === false) return null;

            const average = chooseAverage(entry, null, card.rarity || null);

            return {
              ...card,
              average,
              fetchedAt: Number(entry?.fetchedAt) || 0
            };
          })
          .filter(Boolean)
          .sort((a, b) => {
            const aPrice = Number.isFinite(a.average) ? a.average : -Infinity;
            const bPrice = Number.isFinite(b.average) ? b.average : -Infinity;
            if (bPrice !== aPrice) return bPrice - aPrice;
            return a.title.localeCompare(b.title, 'fr');
          });

        if (!rows.length) {
          runtime.modalUi.showInfoModal(
            'Aucun prix chargé',
            'Aucun prix n’est encore présent dans le cache. Parcourez votre collection ou utilisez « Actualiser les prix », puis réessayez.'
          );
          return;
        }

        const rankedIds = new Set(rows.map((row) => row.id));
        const unpricedRows = candidates
          .filter((card) => (
            !rankedIds.has(card.id) &&
            (card.starred || (Array.isArray(card.tags) && card.tags.length > 0))
          ))
          .map((card) => ({ ...card, average: Number.NaN, fetchedAt: 0 }))
          .sort((a, b) => a.title.localeCompare(b.title, 'fr'));

        const isComplete =
          collectionEntry?.complete === true &&
          rows.length >= candidates.length;

        renderRankingModal(
          rows,
          collectionEntry?.fetchedAt || 0,
          {
            incomplete: !isComplete,
            unpricedRows,
            knownCards: candidates.length,
            cachedCards: rows.length
          }
        );
      }

      function renderRankingModal(rows, collectionFetchedAt, status = {}) {
        const salesEnabled = runtime.settings.isEnabled('rankingSales');
        const overlay = document.createElement('div');
        overlay.className = 'wm-modal-overlay wm-ranking-overlay';

        const modal = document.createElement('div');
        modal.className = `wm-modal wm-ranking-modal ${salesEnabled ? 'wm-ranking-sales-enabled' : 'wm-ranking-sales-disabled'}`;

        // 1. Calcul des statistiques globales
        const pricedCount = rows.filter((row) => Number.isFinite(row.average) && row.average > 0).length;
        const totalEstimatedValue = rows.reduce((sum, row) => {
          return sum + (Number.isFinite(row.average) && row.average > 0 ? row.average * (row.count || 1) : 0);
        }, 0);

        // 2. En-tête raffiné
        const header = document.createElement('div');
        header.className = 'wm-ranking-header';

        const headingWrap = document.createElement('div');
        headingWrap.className = 'wm-ranking-heading-wrap';

        const title = document.createElement('h2');
        title.textContent = 'Classement par valeur';

        const statsRow = document.createElement('div');
        statsRow.className = 'wm-ranking-header-stats';

        const statTotal = document.createElement('div');
        statTotal.className = 'wm-stat-pill wm-stat-highlight';
        statTotal.innerHTML = `<span class="wm-stat-label">Valeur totale estimée</span> <span class="wm-stat-val">${formatAverage(Math.round(totalEstimatedValue))} W</span>`;

        const statCount = document.createElement('div');
        statCount.className = 'wm-stat-pill';
        statCount.innerHTML = `<span class="wm-stat-label">Cartes</span> <span class="wm-stat-val">${rows.length}</span>`;

        const statPriced = document.createElement('div');
        statPriced.className = 'wm-stat-pill';
        statPriced.innerHTML = `<span class="wm-stat-label">Cotées</span> <span class="wm-stat-val">${pricedCount}</span>`;

        statsRow.append(statTotal, statCount, statPriced);
        headingWrap.append(title, statsRow);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'wm-ranking-close';
        closeButton.setAttribute('aria-label', 'Fermer');
        closeButton.textContent = '×';

        header.append(headingWrap, closeButton);

        // 3. Bannière d'information sobre si cache partiel
        let cacheNotice = null;
        if (status.incomplete) {
          cacheNotice = document.createElement('div');
          cacheNotice.className = 'wm-ranking-cache-notice';
          cacheNotice.innerHTML = '<span class="wm-notice-icon">ℹ️</span> <span>Seules les cartes ayant un prix enregistré en cache sont affichées dans ce classement.</span>';
        }

        // 4. Panneau de vente rapide intelligent
        let saleMode = 'average'; // 'average' | 'fixed'
        const saleControls = document.createElement('div');
        saleControls.className = 'wm-ranking-sale-controls';

        const saleHeader = document.createElement('div');
        saleHeader.className = 'wm-sale-panel-title';
        saleHeader.innerHTML = '<span class="wm-sale-icon">⚡</span> <span>Vente rapide aux enchères</span>';

        const saleOptionsWrap = document.createElement('div');
        saleOptionsWrap.className = 'wm-sale-panel-options';

        // Choix du mode de prix
        const modeGroup = document.createElement('div');
        modeGroup.className = 'wm-sale-mode-group';

        const modeAvgLabel = document.createElement('label');
        modeAvgLabel.className = 'wm-sale-mode-choice is-active';
        const modeAvgRadio = document.createElement('input');
        modeAvgRadio.type = 'radio';
        modeAvgRadio.name = 'wm_sale_mode';
        modeAvgRadio.value = 'average';
        modeAvgRadio.checked = true;
        modeAvgLabel.append(modeAvgRadio, document.createTextNode(' Au prix moyen estimé'));

        const modeFixedLabel = document.createElement('label');
        modeFixedLabel.className = 'wm-sale-mode-choice';
        const modeFixedRadio = document.createElement('input');
        modeFixedRadio.type = 'radio';
        modeFixedRadio.name = 'wm_sale_mode';
        modeFixedRadio.value = 'fixed';

        const priceInput = document.createElement('input');
        priceInput.type = 'number';
        priceInput.min = '1';
        priceInput.step = '1';
        priceInput.value = '10';
        priceInput.className = 'wm-sale-fixed-input';
        priceInput.setAttribute('aria-label', 'Mise fixe');

        modeFixedLabel.append(modeFixedRadio, document.createTextNode(' Prix fixe : '), priceInput, document.createTextNode(' W'));
        modeGroup.append(modeAvgLabel, modeFixedLabel);

        // Durée de l'enchère
        const durationField = document.createElement('div');
        durationField.className = 'wm-sale-duration-wrap';

        const durationLabel = document.createElement('span');
        durationLabel.textContent = 'Durée : ';

        const durationInput = document.createElement('select');
        durationInput.className = 'wm-sale-duration-select';

        const durationOptions = [
          [10, '10 min'],
          [30, '30 min'],
          [60, '1 heure'],
          [180, '3 heures'],
          [360, '6 heures'],
          [720, '12 heures'],
          [1440, '24 heures (conseillé)']
        ];

        for (const [value, label] of durationOptions) {
          const option = document.createElement('option');
          option.value = String(value);
          option.textContent = label;
          durationInput.append(option);
        }
        durationInput.value = '1440'; // 24h par défaut

        durationField.append(durationLabel, durationInput);
        saleOptionsWrap.append(modeGroup, durationField);

        const hint = document.createElement('div');
        hint.className = 'wm-ranking-sale-hint';
        hint.textContent = 'Chaque bouton ci-dessous appliquera directement le montant indiqué.';

        const saleBanner = document.createElement('div');
        saleBanner.className = 'wm-ranking-sale-banner';
        saleBanner.hidden = true;

        saleControls.append(saleHeader, saleOptionsWrap, hint, saleBanner);

        // 5. Barre de filtres épurée
        const tagKey = (tag) => tag.id || tag.name;
        const rowTags = (row) => mergeTags(row.tags);

        const rankedRows = rows.map((row, index) => ({ row, index }));
        const rankedById = new Map(rankedRows.map((entry) => [entry.row.id, entry]));
        const unrankedRows = (Array.isArray(status.unpricedRows) ? status.unpricedRows : [])
          .map((row) => ({ row, index: null }));
        const filterableRows = [...rankedRows, ...unrankedRows];
        let visibleRows = rankedRows;
        let closed = false;

        const knownTags = new Map();
        const addKnownTags = (tags) => {
          for (const tag of mergeTags(tags)) {
            const sameName = [...knownTags.values()].find((known) => known.name === tag.name);
            if (sameName && sameName.id && !tag.id) continue;
            if (sameName) knownTags.delete(tagKey(sameName));
            knownTags.set(tagKey(tag), {
              ...tag,
              cardCount: tag.cardCount ?? sameName?.cardCount
            });
          }
        };
        filterableRows.forEach(({ row }) => addKnownTags(row.tags));

        const fetchedResults = new Map();
        const STARRED_KEY = '__starred__';

        const filters = document.createElement('div');
        filters.className = 'wm-ranking-filters';

        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'wm-ranking-search-input';
        searchInput.placeholder = 'Rechercher par titre…';
        searchInput.setAttribute('aria-label', 'Rechercher par titre');

        const raritySelect = document.createElement('select');
        raritySelect.className = 'wm-ranking-filter-rarity';
        raritySelect.setAttribute('aria-label', 'Filtrer par rareté');
        const rarities = [
          ['', 'Toutes les raretés'],
          ['L', 'Légendaires (L)'],
          ['UR', 'Ultra Rares (UR)'],
          ['SR', 'Super Rares (SR)'],
          ['R', 'Rares (R)'],
          ['PC', 'Peu Communes (PC)'],
          ['C', 'Communes (C)']
        ];
        for (const [rVal, rLabel] of rarities) {
          const opt = document.createElement('option');
          opt.value = rVal;
          opt.textContent = rLabel;
          raritySelect.append(opt);
        }

        let starredActive = false;
        const starredBtn = document.createElement('button');
        starredBtn.type = 'button';
        starredBtn.className = 'wm-filter-pill-btn';
        starredBtn.innerHTML = '<span style="color:#facc15;">★</span> <span>Favoris</span>';
        starredBtn.title = 'Afficher uniquement les cartes favorites';

        starredBtn.addEventListener('click', () => {
          starredActive = !starredActive;
          starredBtn.classList.toggle('is-active', starredActive);
          applyFilters();
        });

        const tagSelect = document.createElement('select');
        tagSelect.className = 'wm-ranking-filter-tag';
        tagSelect.setAttribute('aria-label', 'Filtrer par étiquette');

        const allTagsOption = document.createElement('option');
        allTagsOption.value = '';
        allTagsOption.textContent = 'Toutes les étiquettes';

        const fillTagOptions = () => {
          const selected = tagSelect.value;
          const options = [...knownTags.values()]
            .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
            .map((tag) => {
              const option = document.createElement('option');
              option.value = tagKey(tag);
              option.textContent = Number.isFinite(tag.cardCount)
                ? `${tag.name} (${tag.cardCount})`
                : tag.name;
              return option;
            });

          tagSelect.replaceChildren(allTagsOption, ...options);
          tagSelect.value = knownTags.has(selected) ? selected : '';
          tagSelect.hidden = knownTags.size === 0;
        };

        fillTagOptions();

        const filterCount = document.createElement('span');
        filterCount.className = 'wm-ranking-filter-count';

        filters.append(searchInput, raritySelect, starredBtn, tagSelect, filterCount);

        const list = document.createElement('div');
        list.className = 'wm-ranking-list';

        const PAGE_SIZE = 50;
        let renderedCount = 0;

        function getTargetAmount(row) {
          if (saleMode === 'average' && Number.isFinite(row.average) && row.average > 0) {
            return Math.max(1, Math.round(row.average));
          }
          return Math.max(1, Number(priceInput.value) || 10);
        }

        const saleInputsAreValid = () => {
          const duration = Number(durationInput.value);
          if (!Number.isFinite(duration) || duration <= 0) return false;
          if (saleMode === 'fixed') {
            const amount = Number(priceInput.value);
            return Number.isFinite(amount) && amount > 0;
          }
          return true;
        };

        const refreshSaleButtons = () => {
          const valid = saleInputsAreValid();

          for (const item of list.querySelectorAll('.wm-ranking-row')) {
            const button = item.querySelector('.wm-ranking-sell-button');
            if (!button || button.dataset.state === 'pending' || button.dataset.state === 'success') continue;

            const cardId = button.dataset.cardId;
            const targetRow = visibleRows.find((r) => r.row.id === cardId)?.row;
            if (!targetRow) continue;

            button.disabled = !valid;
            const targetAmount = getTargetAmount(targetRow);
            button.textContent = `Vendre à ${formatAverage(targetAmount)} W`;
          }
        };

        modeAvgRadio.addEventListener('change', () => {
          saleMode = 'average';
          modeAvgLabel.classList.add('is-active');
          modeFixedLabel.classList.remove('is-active');
          refreshSaleButtons();
        });

        modeFixedRadio.addEventListener('change', () => {
          saleMode = 'fixed';
          modeFixedLabel.classList.add('is-active');
          modeAvgLabel.classList.remove('is-active');
          refreshSaleButtons();
        });

        priceInput.addEventListener('input', () => {
          if (saleMode === 'fixed') refreshSaleButtons();
        });

        durationInput.addEventListener('change', refreshSaleButtons);

        const createRankingRow = (row, index) => {
          const item = document.createElement('div');
          item.className = 'wm-ranking-row';

          // 1. Badge de Rang (podium or classique)
          const rank = document.createElement('div');
          rank.className = 'wm-ranking-rank';
          if (index === 0) {
            rank.className += ' wm-rank-1';
            rank.textContent = '#1';
          } else if (index === 1) {
            rank.className += ' wm-rank-2';
            rank.textContent = '#2';
          } else if (index === 2) {
            rank.className += ' wm-rank-3';
            rank.textContent = '#3';
          } else {
            rank.textContent = index == null ? '—' : `#${index + 1}`;
          }

          // 2. Miniature avec gestion propre des images manquantes
          const thumb = document.createElement('div');
          thumb.className = 'wm-ranking-thumb';
          const rMeta = rarityMeta(row.rarity);

          if (row.imageUrl) {
            const img = document.createElement('img');
            img.src = row.imageUrl;
            img.alt = row.title || '';
            img.loading = 'lazy';
            img.decoding = 'async';
            thumb.append(img);
          } else {
            const fallback = document.createElement('div');
            fallback.className = 'wm-ranking-thumb-fallback';
            fallback.style.background = `linear-gradient(180deg, ${rMeta.bg} 0%, rgba(12, 16, 14, 0.95) 100%)`;
            fallback.style.color = rMeta.color;
            fallback.textContent = (row.rarity || 'W').toUpperCase();
            thumb.append(fallback);

            if (runtime.imageResolver?.resolveMissingImage) {
              runtime.imageResolver.resolveMissingImage(row.title).then((entry) => {
                if (entry?.found && entry.url && thumb.isConnected) {
                  const resolvedImg = document.createElement('img');
                  resolvedImg.src = entry.url;
                  resolvedImg.alt = row.title || '';
                  resolvedImg.loading = 'lazy';
                  resolvedImg.onload = () => {
                    fallback.remove();
                    thumb.append(resolvedImg);
                  };
                }
              }).catch(() => {});
            }
          }

          // 3. Titre et badges (Rareté, Exemplaires, Favori)
          const info = document.createElement('div');
          info.className = 'wm-ranking-info';

          const name = document.createElement('div');
          name.className = 'wm-ranking-title';
          name.textContent = row.title;

          const meta = document.createElement('div');
          meta.className = 'wm-ranking-meta';

          const rarityPill = document.createElement('span');
          rarityPill.className = 'wm-ranking-rarity-pill';
          rarityPill.style.color = rMeta.color;
          rarityPill.style.backgroundColor = rMeta.bg;
          rarityPill.style.borderColor = rMeta.border;
          rarityPill.textContent = rMeta.name;
          meta.append(rarityPill);

          if (row.count > 1) {
            const count = document.createElement('span');
            count.className = 'wm-ranking-count';
            count.textContent = `×${row.count}`;
            count.title = `${row.count} exemplaires possédés`;
            meta.append(count);
          }

          if (row.starred) {
            const star = document.createElement('span');
            star.className = 'wm-ranking-star-badge';
            star.textContent = '★ Favori';
            meta.append(star);
          }

          for (const tag of rowTags(row)) {
            const chip = document.createElement('span');
            chip.className = 'wm-ranking-tag';
            if (/^#[0-9a-f]{3,8}$/i.test(tag.color || '')) {
              const dot = document.createElement('span');
              dot.className = 'wm-ranking-tag-dot';
              dot.style.background = tag.color;
              chip.append(dot);
            }
            chip.append(document.createTextNode(tag.name));
            meta.append(chip);
          }

          info.append(name, meta);

          // 4. Prix moyen lisible
          const priceWrap = document.createElement('div');
          priceWrap.className = 'wm-ranking-price-wrap';

          const priceVal = document.createElement('div');
          priceVal.className = 'wm-ranking-price';

          const priceCaption = document.createElement('div');
          priceCaption.className = 'wm-ranking-price-caption';

          if (Number.isFinite(row.average) && row.average > 0) {
            priceVal.textContent = `${formatAverage(row.average)} W`;
            priceCaption.textContent = 'Moyenne marché';
          } else {
            priceVal.textContent = '—';
            priceVal.classList.add('wm-ranking-price-empty');
            priceCaption.textContent = 'Pas de cote';
          }

          priceWrap.append(priceVal, priceCaption);

          // 5. Bouton de mise en vente explicite
          const sellButton = document.createElement('button');
          sellButton.type = 'button';
          sellButton.className = 'wm-tool-button wm-ranking-sell-button';
          sellButton.dataset.cardId = row.id;

          const targetAmount = getTargetAmount(row);
          sellButton.textContent = `Vendre à ${formatAverage(targetAmount)} W`;
          sellButton.disabled = !saleInputsAreValid();

          sellButton.addEventListener('click', () => {
            const finalAmount = getTargetAmount(row);
            const duration = Number(durationInput.value);

            if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
              priceInput.focus();
              return;
            }

            if (!Number.isFinite(duration) || duration <= 0) {
              durationInput.focus();
              return;
            }

            const ownedCardId = row.starred
              ? null
              : (row.ownedCardId || row.ownedCardIds?.[0] || null);

            requestListing({ button: sellButton, row, amount: finalAmount, duration, ownedCardId });
          });

          item.append(rank, thumb, info, priceWrap);
          if (salesEnabled) item.append(sellButton);
          return item;
        };

        const sentinel = document.createElement('div');
        sentinel.className = 'wm-ranking-sentinel';

        const renderNextChunk = () => {
          if (renderedCount >= visibleRows.length) {
            sentinel.remove();
            return;
          }

          const fragment = document.createDocumentFragment();
          const end = Math.min(renderedCount + PAGE_SIZE, visibleRows.length);

          for (let position = renderedCount; position < end; position += 1) {
            const { row, index } = visibleRows[position];
            fragment.append(createRankingRow(row, index));
          }

          renderedCount = end;
          sentinel.remove();
          list.append(fragment);

          if (renderedCount < visibleRows.length) {
            list.append(sentinel);
          }

          refreshSaleButtons();
        };

        const byPriceThenTitle = (a, b) => {
          const aPrice = Number.isFinite(a.row.average) ? a.row.average : -Infinity;
          const bPrice = Number.isFinite(b.row.average) ? b.row.average : -Infinity;
          if (bPrice !== aPrice) return bPrice - aPrice;
          return a.row.title.localeCompare(b.row.title, 'fr');
        };

        const buildFetchedRows = (cards) => {
          const outside = cards.filter((card) => !rankedById.has(card.id));
          const prices = storageGet(outside.map((card) => cacheKey(card.id)));

          return cards.map((card) => {
            const ranked = rankedById.get(card.id);

            if (ranked) {
              const ownedCardIds = [...new Set([
                ...(Array.isArray(ranked.row.ownedCardIds) ? ranked.row.ownedCardIds : []),
                ...(Array.isArray(card.ownedCardIds) ? card.ownedCardIds : [])
              ])];

              Object.assign(ranked.row, {
                starred: Boolean(ranked.row.starred || card.starred),
                tags: mergeTags(ranked.row.tags, card.tags),
                count: Math.max(ranked.row.count || 1, card.count || 1, ownedCardIds.length),
                ownedCardId: ranked.row.ownedCardId || card.ownedCardId,
                ownedCardIds
              });
              return ranked;
            }

            const entry = prices[cacheKey(card.id)];
            const average = entry && entry.ok !== false
              ? chooseAverage(entry, null, card.rarity || null)
              : Number.NaN;

            return { row: { ...card, average }, index: null };
          }).sort(byPriceThenTitle);
        };

        const loadFetchedRows = (key, eventName, detail = {}) => {
          if (fetchedResults.has(key)) return;
          fetchedResults.set(key, { state: 'loading' });

          requestBridge(eventName, detail).then((response) => {
            if (closed) return;

            fetchedResults.set(key, response.ok
              ? {
                  state: 'ready',
                  rows: buildFetchedRows(Array.isArray(response.cards) ? response.cards : [])
                }
              : { state: 'error' });

            const currentKey = tagSelect.value || (starredActive ? STARRED_KEY : '');
            if (currentKey === key) applyFilters();
          });
        };

        const applyFilters = () => {
          const starredOnly = starredActive;
          const key = tagSelect.value;
          const tag = key ? knownTags.get(key) : null;
          const filterActive = starredOnly || Boolean(tag);

          let pool = filterActive ? filterableRows : rankedRows;
          let result = null;

          if (tag) {
            if (tag.id) loadFetchedRows(key, 'wm-average-load-tag-cards', { tagId: tag.id });
            result = fetchedResults.get(key) || null;

            pool = result?.state === 'ready'
              ? result.rows
              : filterableRows.filter(({ row }) => (
                  rowTags(row).some((rowTag) => tagKey(rowTag) === key)
                ));
          } else if (starredOnly) {
            loadFetchedRows(STARRED_KEY, 'wm-average-load-starred-cards');
            result = fetchedResults.get(STARRED_KEY) || null;

            if (result?.state === 'ready') {
              const fetchedIds = new Set(result.rows.map(({ row }) => row.id));
              pool = [
                ...result.rows,
                ...filterableRows.filter(({ row }) => row.starred && !fetchedIds.has(row.id))
              ].sort(byPriceThenTitle);
            }
          }

          const searchQ = (searchInput.value || '').trim().toLowerCase();
          const selectedRarity = raritySelect.value || '';
          const isFiltering = filterActive || Boolean(searchQ) || Boolean(selectedRarity);

          let note = '';
          if (result?.state === 'loading') note = ' • chargement…';
          if (result?.state === 'error') note = ' • liste peut-être incomplète';

          visibleRows = pool.filter(({ row }) => {
            if (starredOnly && !row.starred) return false;
            if (selectedRarity && (row.rarity || '') !== selectedRarity) return false;
            if (searchQ && !(row.title || '').toLowerCase().includes(searchQ)) return false;
            return true;
          });

          const unpricedCount = visibleRows
            .filter(({ row }) => !Number.isFinite(row.average) || row.average <= 0).length;
          const plural = visibleRows.length > 1 ? 's' : '';

          const totalPricedSum = visibleRows.reduce((sum, { row }) => {
            return sum + (Number.isFinite(row.average) && row.average > 0 ? row.average * (row.count || 1) : 0);
          }, 0);
          const totalText = totalPricedSum > 0 ? ` • ${formatAverage(Math.round(totalPricedSum))} W` : '';

          filterCount.textContent = isFiltering
            ? `${visibleRows.length} résultat${plural}${totalText}${note}`
            : `${visibleRows.length} cartes`;

          renderedCount = 0;
          list.replaceChildren();
          list.scrollTop = 0;

          if (!visibleRows.length) {
            const empty = document.createElement('div');
            empty.className = 'wm-ranking-empty';
            empty.textContent = result?.state === 'loading'
              ? 'Chargement des cartes…'
              : 'Aucune carte ne correspond à ces filtres.';
            list.append(empty);
            return;
          }

          renderNextChunk();
        };

        tagSelect.addEventListener('change', applyFilters);
        searchInput.addEventListener('input', applyFilters);
        raritySelect.addEventListener('change', applyFilters);

        const observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            renderNextChunk();
          }
        }, {
          root: list,
          rootMargin: '250px 0px',
          threshold: 0
        });

        renderNextChunk();
        observer.observe(sentinel);

        const close = () => {
          closed = true;
          observer.disconnect();
          overlay.remove();
        };

        closeButton.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
          if (event.target === overlay) close();
        });

        modal.append(header);
        if (cacheNotice) modal.append(cacheNotice);
        if (salesEnabled) modal.append(saleControls);
        modal.append(filters, list);
        overlay.append(modal);
        document.body.append(overlay);
        searchInput.focus();
      }

      window.addEventListener('wm-average-marketplace-slot-count', (event) => {
        const detail = event.detail || {};
        if (typeof detail.count === 'number') {
          const banner = document.querySelector('.wm-ranking-sale-banner');
          if (banner && detail.max && detail.count >= detail.max) {
            banner.hidden = false;
            banner.className = 'wm-ranking-sale-banner is-error';
            banner.textContent = `⚠️ Limite atteinte : ${detail.count}/${detail.max} ventes en cours. Attendez la fin d'une enchère pour en relancer une.`;
          }
        }
      });

      window.addEventListener('wm-average-create-listing-result', (event) => {
        const detail = event.detail || {};
        const pending = pendingMarketplaceListings.get(detail.requestId);
        if (!pending) return;

        pendingMarketplaceListings.delete(detail.requestId);

        const { button, row, amount, duration } = pending;
        if (!button?.isConnected) return;

        if (detail.needsStarredConfirmation) {
          button.textContent = 'Confirmation…';

          runtime.modalUi.showConfirmModal(
            'Vendre ton exemplaire favori ?',
            `« ${row.title} » : le seul exemplaire disponible est en favori. Le mettre en vente quand même ?`,
            { confirmLabel: 'Vendre le favori', cancelLabel: 'Garder la carte' }
          ).then((confirmed) => {
            if (!button.isConnected) return;

            if (!confirmed) {
              delete button.dataset.state;
              button.disabled = false;
              button.textContent = `Vendre à ${formatAverage(amount)} W`;
              return;
            }

            requestListing({
              button,
              row,
              amount,
              duration,
              ownedCardId: detail.ownedCardId,
              allowStarred: true
            });
          });
          return;
        }

        if (detail.ok) {
          if (detail.ownedCardId) {
            const staleId = detail.staleOwnedCardId || null;

            row.ownedCardId = detail.ownedCardId;
            row.ownedCardIds = [
              ...new Set([
                ...(Array.isArray(row.ownedCardIds) ? row.ownedCardIds : [])
                  .filter((id) => id && id !== staleId),
                detail.ownedCardId
              ])
            ];

            const stored = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];
            if (Array.isArray(stored?.cards)) {
              const target = stored.cards.find((card) => card?.id === row.id);
              if (target) {
                target.ownedCardId = detail.ownedCardId;
                target.ownedCardIds = [
                  ...new Set([
                    ...(Array.isArray(target.ownedCardIds) ? target.ownedCardIds : [])
                      .filter((id) => id && id !== staleId),
                    detail.ownedCardId
                  ])
                ];
                storageSet({ [ALL_COLLECTION_KEY]: stored });
              }
            }
          }

          button.dataset.state = 'success';
          button.disabled = true;
          button.textContent = 'En vente ✓';
          button.title = `${formatAverage(amount)} W pendant ${formatAverage(duration)} min`;
          const banner = document.querySelector('.wm-ranking-sale-banner');
          if (banner) {
            banner.hidden = false;
            banner.className = 'wm-ranking-sale-banner is-success';
            banner.textContent = `✓ « ${row.title} » mise en vente avec succès pour ${formatAverage(amount)} W !`;
          }
          return;
        }

        if (detail.notOwned) {
          const stored = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];

          if (Array.isArray(stored?.cards)) {
            stored.cards = stored.cards.filter((card) => card?.id !== row.id);
            storageSet({ [ALL_COLLECTION_KEY]: stored });
          }

          row.ownedCardId = null;
          row.ownedCardIds = [];

          const rankingRow = button.closest('.wm-ranking-row');
          rankingRow?.classList.add('wm-ranking-row-unowned');

          button.dataset.state = 'success';
          button.disabled = true;
          button.textContent = 'Plus possédée';
          button.title = 'Cette carte n’est plus dans ta collection.';
          return;
        }

        if (detail.alreadyListed) {
          button.dataset.state = 'success';
          button.disabled = true;
          button.textContent = 'Déjà en vente';
          button.title = detail.error || 'Toutes tes copies disponibles sont déjà en vente.';
          return;
        }

        const staleId = detail.staleOwnedCardId || (detail.ownershipError ? detail.ownedCardId : null);

        if (staleId) {
          if (row.ownedCardId === staleId) {
            row.ownedCardId = null;
          }
          row.ownedCardIds = (Array.isArray(row.ownedCardIds) ? row.ownedCardIds : [])
            .filter((id) => id && id !== staleId);

          const stored = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];
          if (Array.isArray(stored?.cards)) {
            const target = stored.cards.find((card) => card?.id === row.id);
            if (target) {
              if (target.ownedCardId === staleId) {
                target.ownedCardId = null;
              }
              target.ownedCardIds = (Array.isArray(target.ownedCardIds) ? target.ownedCardIds : [])
                .filter((id) => id && id !== staleId);
              storageSet({ [ALL_COLLECTION_KEY]: stored });
            }
          }
        }

        const errText = String(detail.error || '').toLowerCase();
        let shortLabel = 'Vente refusée';
        let clearReason = detail.error || 'Impossible de mettre cette carte en vente.';

        if (detail.notOwned || errText.includes('ne possédez pas') || errText.includes('not owned')) {
          shortLabel = 'Non possédée';
          clearReason = 'Vous ne possédez plus cet exemplaire (déjà vendu ou échangé).';
        } else if (detail.alreadyListed || errText.includes('already listed') || errText.includes('déjà en vente')) {
          shortLabel = 'Déjà en vente';
          clearReason = 'Toutes vos copies disponibles sont déjà mises en vente sur le marché.';
        } else if (errText.includes('max') || errText.includes('limit') || errText.includes('limite') || errText.includes('concurrent')) {
          shortLabel = 'Limite atteinte (max)';
          clearReason = 'Limite maximale atteinte : vous avez déjà atteint le nombre maximal d’enchères simultanées autorisées sur WikiMasters.';
        } else if (errText.includes('401') || errText.includes('403') || errText.includes('auth') || errText.includes('session')) {
          shortLabel = 'Session expirée';
          clearReason = 'Votre session a expiré : veuillez recharger WikiMasters et vous reconnecter.';
        } else if (errText.includes('429') || errText.includes('rate') || errText.includes('patienter')) {
          shortLabel = 'Trop de requêtes';
          clearReason = 'Serveur saturé : veuillez patienter quelques secondes avant de relancer une vente.';
        } else if (detail.ownershipError) {
          shortLabel = 'Exemplaire indisponible';
          clearReason = 'L’identifiant de cet exemplaire n’est plus disponible ou est engagé dans un échange.';
        } else if (errText.includes('montant') || errText.includes('prix') || errText.includes('price')) {
          shortLabel = 'Prix invalide';
          clearReason = 'Le montant proposé ne respecte pas les critères de vente de WikiMasters.';
        }

        button.dataset.state = 'error';
        button.disabled = false;
        button.textContent = shortLabel;
        button.title = `${clearReason} (Cliquer pour réessayer)`;

        const banner = document.querySelector('.wm-ranking-sale-banner');
        if (banner) {
          banner.hidden = false;
          banner.className = 'wm-ranking-sale-banner is-error';
          banner.textContent = `⚠️ Impossible de mettre en vente « ${row.title} » : ${clearReason}`;
        }
      });

      return { openRankingModal };
    }
  };
})();
