(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.priceUi = {
    create(runtime) {
      const {
        isCollectionPage, isMarketplaceDetailPage, isGlobalCollectionPage,
        normalizeTitle, cacheKey, storageGet, isCacheEntryValid, reportError,
        registerCards, createSponsorNote, cardMetaById, idByTitle, cacheMemory
      } = runtime.core;

      let collectionPriceObserver = null;
      let marketplaceCardId = null;
      let marketplaceRequestedPath = null;
      let marketplaceRequestedAt = 0;
      let globalCollectionCardId = null;
      let globalCollectionInitializedId = null;

      function getRarityFromCard(cardEl) {
        if (!cardEl) return null;
        const candidates = cardEl.querySelectorAll('div, span');
        for (const el of candidates) {
          const text = (el.textContent || '').trim();
          if (/^(L|UR|SR|R|PC|C)$/.test(text)) return text;
        }
        return null;
      }

      function formatAverage(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '—';
        return new Intl.NumberFormat('fr-FR', {
          maximumFractionDigits: Number.isInteger(n) ? 0 : 2
        }).format(n);
      }

      function findCardByTitle(title) {
        if (!isCollectionPage()) return null;

        const target = normalizeTitle(title);
        for (const h3 of document.querySelectorAll('h3')) {
          if (normalizeTitle(h3.textContent) !== target) continue;
          const card = h3.closest('div[class*="rounded-2xl"][class*="overflow-hidden"][class*="cursor-pointer"]');
          if (card) return card;
        }
        return null;
      }

      function getOrCreateBadge(card) {
        let badge = card.querySelector('.wm-average-badge');
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'wm-average-badge';
        }

        const title = card.querySelector('h3');
        const textArea = title?.parentElement;

        if (title && textArea) {
          if (badge.parentElement !== textArea || title.nextElementSibling !== badge) {
            title.insertAdjacentElement('afterend', badge);
          }
        } else if (!badge.parentElement) {
          card.appendChild(badge);
        }

        return badge;
      }

      function renderLoadingBadge(badge) {
        if (
          badge.classList.contains('wm-average-loading') &&
          normalizeTitle(badge.textContent) === 'Prix…'
        ) {
          return;
        }

        badge.className = 'wm-average-badge wm-average-loading';
        badge.title = 'Chargement du prix moyen…';
        badge.replaceChildren();

        const spinner = document.createElement('span');
        spinner.className = 'wm-average-spinner';
        spinner.setAttribute('aria-hidden', 'true');

        const label = document.createElement('span');
        label.textContent = 'Prix…';

        badge.append(spinner, label);
      }

      function chooseAverage(cacheEntry, cardEl, explicitRarity = null) {
        const rarity = explicitRarity || getRarityFromCard(cardEl);
        const averages = cacheEntry?.averages || {};
        if (rarity) return Number.isFinite(averages[rarity]) ? averages[rarity] : null;

        const values = Object.values(averages)
          .map(Number)
          .filter(Number.isFinite);
        return values.length === 1 ? values[0] : null;
      }

      function renderCollectionCard(id, card, { force = false } = {}) {
        if (!force && !runtime.settings.isEnabled('collectionPrices')) {
          card?.querySelector('.wm-average-badge')?.remove();
          return;
        }
        const badge = getOrCreateBadge(card);
        delete badge.dataset.wmStatus;
        const cacheEntry = cacheMemory.get(id);

        if (!cacheEntry) {
          const status = runtime.priceLoader?.getStatus(id);
          if (status === 'Chargement…') renderLoadingBadge(badge);
          else {
            badge.className = 'wm-average-badge wm-average-empty';
            badge.textContent = status || 'Au défilement';
            badge.title = status || 'Le prix sera chargé automatiquement lorsque la carte sera visible';
          }
          return;
        }

        if (cacheEntry.ok === false) {
          if (runtime.priceLoader?.getStatus(id) === 'Chargement…') {
            renderLoadingBadge(badge);
            return;
          }
          if (badge.className !== 'wm-average-badge wm-average-empty') {
            badge.className = 'wm-average-badge wm-average-empty';
          }
          const label = runtime.priceLoader?.getStatus(id) || cacheEntry.error || 'Prix indispo.';
          badge.title = label;
          if (badge.textContent !== label) badge.textContent = label;
          return;
        }

        const refreshStatus = runtime.priceLoader?.getStatus(id);
        if (refreshStatus) badge.dataset.wmStatus = refreshStatus;
        badge.title = `Prix moyen des ventes, conservé sans expiration · ${new Date(cacheEntry.fetchedAt).toLocaleString('fr-FR')}${refreshStatus ? ` · ${refreshStatus} ; dernier prix conservé` : ''}`;
        const average = chooseAverage(cacheEntry, card, getRarityFromCard(card) || cardMetaById.get(id)?.rarity || null);

        if (average == null) {
          if (badge.className !== 'wm-average-badge wm-average-empty') {
            badge.className = 'wm-average-badge wm-average-empty';
          }
          if (badge.textContent !== 'Moy. —') badge.textContent = 'Moy. —';
        } else {
          if (badge.className !== 'wm-average-badge') {
            badge.className = 'wm-average-badge';
          }
          const text = `Moy. ${formatAverage(average)} W`;
          if (badge.textContent !== text) badge.textContent = text;
        }
      }

      function ensureCollectionPriceObserver() {
        if (collectionPriceObserver) return collectionPriceObserver;

        collectionPriceObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;

            const cardEl = entry.target;
            const id = cardEl.dataset.wmCardId;
            if (!id) {
              collectionPriceObserver.unobserve(cardEl);
              continue;
            }

            const meta = cardMetaById.get(id);
            if (meta) {
              try {
                runtime.priceLoader.loadCacheForCards([meta]);
              } catch (error) {
                reportError('prix visible', error);
              }
            }

            collectionPriceObserver.unobserve(cardEl);
          }
        }, {
          root: null,
          rootMargin: '320px 0px',
          threshold: 0
        });

        return collectionPriceObserver;
      }

      function hydrateCacheForCards(cards) {
        const now = Date.now();
        const stored = storageGet(cards.map((card) => cacheKey(card.id)));

        for (const card of cards) {
          const entry = stored[cacheKey(card.id)];

          if (isCacheEntryValid(entry, now)) {
            cacheMemory.set(card.id, entry);
          } else {
            cacheMemory.delete(card.id);
          }
        }
      }

      function bindCollectionCardElement(id, h3, card) {
        if (!id || !card) return;

        card.dataset.wmCardId = id;
        if (h3) h3.dataset.wmCardBound = '1';

        renderCollectionCard(id, card);

        if (!isCacheEntryValid(cacheMemory.get(id))) {
          ensureCollectionPriceObserver().observe(card);
        }
      }

      function renderOne(id) {
        if (!isCollectionPage()) return;

        const direct = document.querySelector(`[data-wm-card-id="${CSS.escape(id)}"]`);
        if (direct) {
          renderCollectionCard(id, direct);
          return;
        }

        const meta = cardMetaById.get(id);
        if (!meta?.title) return;

        const card = findCardByTitle(meta.title);
        if (card) {
          const h3 = card.querySelector('h3');
          bindCollectionCardElement(id, h3, card);
        }
      }

      let activeCollectionResaleSort = null;
      let isCollectionSortingActive = false;
      let isSortingGrid = false;
      let lastSortedSignature = '';

      function getCardResalePrice(cardEl) {
        if (!cardEl) return -1;
        const id = cardEl.dataset.wmCardId || idByTitle.get(normalizeTitle(cardEl.querySelector('h3')?.textContent || ''));
        if (id && cacheMemory.has(id)) {
          const entry = cacheMemory.get(id);
          if (entry && entry.ok !== false) {
            const avg = chooseAverage(entry, cardEl, getRarityFromCard(cardEl) || cardMetaById.get(id)?.rarity || null);
            if (Number.isFinite(avg)) return avg;
          }
        }
        const badge = cardEl.querySelector('.wm-average-badge');
        if (badge) {
          const m = (badge.textContent || '').match(/([\d\s,]+)\s*W/);
          if (m) {
            const val = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
            if (Number.isFinite(val)) return val;
          }
        }
        return -1;
      }

      function findCardGridItem(card) {
        let node = card;
        while (node && node.parentElement && node.parentElement.tagName !== 'MAIN') {
          const parent = node.parentElement;
          let count = 0;
          for (let i = 0; i < parent.children.length; i++) {
            if (parent.children[i].querySelector('h3')) count++;
          }
          if (count > 1) {
            return node;
          }
          node = parent;
        }
        return card;
      }

      function sortCollectionGridByPrice(direction = 'desc') {
        if (!isCollectionPage() || isSortingGrid) return;
        isSortingGrid = true;
        try {
          const cards = [...document.querySelectorAll('div[class*="rounded-2xl"]:has(h3)')];
          if (!cards.length) return;

          const sig = direction + '|' + cards.map(c => (c.dataset.wmCardId || '') + ':' + getCardResalePrice(c)).join(',');
          if (sig === lastSortedSignature) return;
          lastSortedSignature = sig;

          const items = cards.map((card) => ({
            card,
            gridItem: findCardGridItem(card),
            price: getCardResalePrice(card),
            title: (card.querySelector('h3')?.textContent || '').trim()
          }));

          items.sort((a, b) => {
            if (direction === 'desc') {
              if (b.price !== a.price) return b.price - a.price;
              return a.title.localeCompare(b.title, 'fr');
            } else {
              if (a.price === -1 && b.price !== -1) return 1;
              if (b.price === -1 && a.price !== -1) return -1;
              if (a.price !== b.price) return a.price - b.price;
              return a.title.localeCompare(b.title, 'fr');
            }
          });

          // ONLY set style.order on the gridItem - NEVER move DOM nodes!
          items.forEach((item, idx) => {
            if (item.gridItem && item.gridItem.style.order !== String(idx)) {
              item.gridItem.style.order = String(idx);
            }
          });
        } finally {
          isSortingGrid = false;
        }
      }

      function resetCollectionGridSort() {
        lastSortedSignature = '';
        const cards = document.querySelectorAll('div[class*="rounded-2xl"]:has(h3)');
        cards.forEach((card) => {
          const item = findCardGridItem(card);
          if (item) item.style.order = '';
          card.style.order = '';
        });
      }

      function findCollectionSortButton() {
        return (
          document.querySelector('button[aria-label="Trier la collection"]') ||
          document.getElementById('_r_3_') ||
          [...document.querySelectorAll('button[aria-haspopup="listbox"]')].find((btn) => {
            const txt = (btn.textContent || '').toLowerCase();
            return txt.includes('rareté') || txt.includes('nom') || txt.includes('favoris') || txt.includes('date');
          })
        );
      }

      function injectCollectionResaleSortOptions(listbox) {
        if (!listbox || listbox.dataset.wmSortInjected) return;

        const sample = listbox.querySelector('[role="option"]') || listbox.firstElementChild;
        const baseClass = sample ? sample.className : 'flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm cursor-pointer';

        listbox.dataset.wmSortInjected = '1';

        const optDesc = document.createElement('div');
        optDesc.role = 'option';
        optDesc.className = baseClass + ' wm-resale-sort-option';
        optDesc.setAttribute('data-wm-sort', 'price-desc');
        optDesc.setAttribute('tabindex', '0');
        optDesc.innerHTML = '<span class="flex items-center gap-1.5 font-medium"><span style="color:#34d399;font-weight:700;">✦</span> <span>Prix de revente ↓</span></span><span class="text-xs text-[var(--color-foreground)]/50">Moy. max</span>';

        const optAsc = document.createElement('div');
        optAsc.role = 'option';
        optAsc.className = baseClass + ' wm-resale-sort-option';
        optAsc.setAttribute('data-wm-sort', 'price-asc');
        optAsc.setAttribute('tabindex', '0');
        optAsc.innerHTML = '<span class="flex items-center gap-1.5 font-medium"><span style="color:#34d399;font-weight:700;">✦</span> <span>Prix de revente ↑</span></span><span class="text-xs text-[var(--color-foreground)]/50">Moy. min</span>';

        function applyResaleSort(dir) {
          activeCollectionResaleSort = dir;
          isCollectionSortingActive = true;
          lastSortedSignature = '';

          const sortBtn = findCollectionSortButton();
          if (sortBtn) {
            const labelEl = sortBtn.querySelector('span span') || sortBtn.querySelector('span');
            if (labelEl) {
              labelEl.textContent = dir === 'desc' ? 'Prix de revente ↓' : 'Prix de revente ↑';
            }
            sortBtn.click();
          }

          sortCollectionGridByPrice(dir);
        }

        optDesc.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          applyResaleSort('desc');
        });

        optAsc.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          applyResaleSort('asc');
        });

        listbox.append(optDesc, optAsc);
      }

      function ensureCollectionSortInjector() {
        if (!isCollectionPage()) return;

        const sortBtn = findCollectionSortButton();
        if (sortBtn) {
          const controlsId = sortBtn.getAttribute('aria-controls');
          if (controlsId) {
            const listbox = document.getElementById(controlsId);
            if (listbox) injectCollectionResaleSortOptions(listbox);
          }
        }

        const anyListbox = document.querySelector('[role="listbox"]:not([data-wm-sort-injected])');
        if (anyListbox) {
          const txt = (anyListbox.textContent || '').toLowerCase();
          if (txt.includes('rareté') || txt.includes('nom') || txt.includes('favoris') || txt.includes('date')) {
            injectCollectionResaleSortOptions(anyListbox);
          }
        }

        if (sortBtn && isCollectionSortingActive) {
          const txt = (sortBtn.textContent || '').trim();
          if (!txt.includes('Prix de revente')) {
            isCollectionSortingActive = false;
            activeCollectionResaleSort = null;
            resetCollectionGridSort();
          }
        }
      }

      function renderVisibleCollectionCards() {
        if (!runtime.settings.isEnabled('collectionPrices')) {
          document.querySelectorAll('.wm-average-badge').forEach((badge) => badge.remove());
          return;
        }
        if (!isCollectionPage()) return;

        for (const card of document.querySelectorAll('[data-wm-card-id]')) {
          const id = card.dataset.wmCardId;
          if (!id) continue;

          renderCollectionCard(id, card);

          if (
            !isCacheEntryValid(cacheMemory.get(id)) &&
            !runtime.priceLoader.isPending(id)
          ) {
            ensureCollectionPriceObserver().observe(card);
          }
        }

        for (const h3 of document.querySelectorAll('h3:not([data-wm-card-bound])')) {
          const id = idByTitle.get(normalizeTitle(h3.textContent));
          if (!id) continue;

          const card = h3.closest('div[class*="rounded-2xl"][class*="overflow-hidden"][class*="cursor-pointer"]');
          if (card) bindCollectionCardElement(id, h3, card);
        }

        ensureCollectionSortInjector();

        if (isCollectionSortingActive && activeCollectionResaleSort) {
          sortCollectionGridByPrice(activeCollectionResaleSort);
        }
      }

      function renderMarketplaceAverage(id) {
        if (!runtime.settings.isEnabled('marketplacePrice')) {
          document.getElementById('wm-marketplace-average')?.remove();
          return;
        }
        if (!isMarketplaceDetailPage() || marketplaceCardId !== id) return;

        const meta = cardMetaById.get(id);
        if (!meta?.title) return;

        const h1 = [...document.querySelectorAll('h1')]
          .find((el) => normalizeTitle(el.textContent) === normalizeTitle(meta.title));
        if (!h1) return;

        const headingRow = h1.parentElement;
        const titleBlock = headingRow?.parentElement;
        if (!titleBlock) return;

        let wrap = document.getElementById('wm-marketplace-average');
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.id = 'wm-marketplace-average';
          wrap.className = 'wm-marketplace-average-wrap';

          const priceCard = document.createElement('div');
          priceCard.className = 'wm-marketplace-average-card';

          const labelWrap = document.createElement('div');
          labelWrap.className = 'wm-marketplace-average-label-wrap';

          const label = document.createElement('span');
          label.className = 'wm-marketplace-average-label';
          label.textContent = 'Prix moyen';

          const rarity = document.createElement('span');
          rarity.className = 'wm-marketplace-average-rarity';
          rarity.dataset.role = 'rarity';

          labelWrap.append(label, rarity);

          const value = document.createElement('span');
          value.className = 'wm-marketplace-average-value';
          value.dataset.role = 'value';

          priceCard.append(labelWrap, value);
          wrap.append(priceCard, createSponsorNote());
          titleBlock.insertAdjacentElement('afterend', wrap);
        }

        const rarityEl = wrap.querySelector('[data-role="rarity"]');
        if (rarityEl) {
          rarityEl.textContent = meta.rarity ? `Rareté ${meta.rarity}` : '';
        }

        const valueEl = wrap.querySelector('[data-role="value"]');
        if (!valueEl) return;

        const cacheEntry = cacheMemory.get(id);
        if (!cacheEntry) {
          valueEl.className = 'wm-marketplace-average-value wm-marketplace-average-loading';
          valueEl.replaceChildren();

          const spinner = document.createElement('span');
          spinner.className = 'wm-average-spinner';
          spinner.setAttribute('aria-hidden', 'true');

          const loadingText = document.createElement('span');
          loadingText.textContent = 'Chargement…';

          valueEl.append(spinner, loadingText);
          return;
        }

        const average = chooseAverage(cacheEntry, null, meta.rarity || null);
        valueEl.className = 'wm-marketplace-average-value';
        valueEl.textContent = average == null ? '—' : `${formatAverage(average)} W`;
      }

      function renderKnownCard(id) {
        renderOne(id);
        renderMarketplaceAverage(id);

        runtime.packs?.onPriceUpdated(id);
        runtime.trades?.renderTradeDetailCard(id);

        if (id === globalCollectionCardId) {
          renderGlobalCollectionInspectedCard();
        }

        runtime.trades?.renderTradeValuesForCard(id);
      }

      function getGlobalCollectionInspection() {
        if (!isGlobalCollectionPage()) return null;

        for (const closeButton of document.querySelectorAll('button[aria-label="Fermer"]')) {
          const modal = closeButton.closest('.card-frame');
          if (!modal) continue;

          const h3 = modal.querySelector('h3');
          if (!h3) continue;

          const card = h3.closest('div[class*="rounded-2xl"][class*="overflow-hidden"][class*="cursor-pointer"]');
          if (card) {
            return { modal, card, h3 };
          }
        }

        return null;
      }

      function renderGlobalCollectionInspectedCard() {
        if (!runtime.settings.isEnabled('globalCollectionPrice')) return;
        if (!isGlobalCollectionPage() || !globalCollectionCardId) return;

        const inspection = getGlobalCollectionInspection();
        if (!inspection) return;

        const meta = cardMetaById.get(globalCollectionCardId);
        if (!meta?.title) return;

        if (normalizeTitle(inspection.h3.textContent) !== normalizeTitle(meta.title)) {
          return;
        }

        renderCollectionCard(meta.id, inspection.card, { force: true });
      }

      function ensureGlobalCollectionInspectedCard() {
        if (!runtime.settings.isEnabled('globalCollectionPrice')) return;
        if (!isGlobalCollectionPage() || !globalCollectionCardId) return;

        const inspection = getGlobalCollectionInspection();
        if (!inspection) return;

        const title = normalizeTitle(inspection.h3.textContent);
        if (!title) return;

        const existingMeta = cardMetaById.get(globalCollectionCardId);
        if (
          existingMeta?.title &&
          normalizeTitle(existingMeta.title) !== title
        ) {
          return;
        }

        const meta = {
          id: globalCollectionCardId,
          title,
          rarity: getRarityFromCard(inspection.card),
          imageUrl: inspection.card.querySelector('img[alt]')?.src || null,
          count: 1
        };

        registerCards([meta]);
        renderCollectionCard(meta.id, inspection.card, { force: true });

        if (globalCollectionInitializedId === meta.id) return;

        // Important: mark as initialized BEFORE runtime.priceLoader.loadCacheForCards().
        // runtime.priceLoader.loadCacheForCards() calls renderKnownCard(), which can render this card again.
        globalCollectionInitializedId = meta.id;

        try {
          runtime.priceLoader.loadCacheForCards([meta]);
        } catch (error) {
          globalCollectionInitializedId = null;
          reportError('collection globale', error);
        }
      }


      window.addEventListener('wm-average-global-card-inspected', (event) => {
        if (!runtime.settings.isEnabled('globalCollectionPrice')) return;
        const id = event.detail?.id;
        if (!isGlobalCollectionPage() || !id) return;

        if (globalCollectionCardId !== id) {
          globalCollectionInitializedId = null;
        }

        globalCollectionCardId = id;
        ensureGlobalCollectionInspectedCard();
        renderGlobalCollectionInspectedCard();
      });

      window.addEventListener('wm-average-marketplace-detail', (event) => {
        if (!runtime.settings.isEnabled('marketplacePrice')) return;
        const card = event.detail?.card;
        if (!card?.id || !card?.title) return;

        marketplaceCardId = card.id;
        marketplaceRequestedPath = location.pathname;
        marketplaceRequestedAt = Date.now();
        registerCards([card]);
        renderMarketplaceAverage(card.id);

        try {
          runtime.priceLoader.loadCacheForCards([card]);
        } catch (error) {
          reportError('marketplace', error);
        }
      });

      window.addEventListener('wm-average-collection', (event) => {
        const cards = event.detail?.cards;
        if (!Array.isArray(cards) || !cards.length) return;

        console.debug(`[WM Average] ${cards.length} cartes détectées`, cards);

        try {
          registerCards(cards);
          hydrateCacheForCards(cards);
          renderVisibleCollectionCards();
        } catch (error) {
          reportError('cache', error);
        }
      });


      function renderMarketplaceCurrent() {
        if (!runtime.settings.isEnabled('marketplacePrice')) {
          document.getElementById('wm-marketplace-average')?.remove();
          return;
        }

        if (!isMarketplaceDetailPage()) return;

        if (marketplaceCardId) {
          renderMarketplaceAverage(marketplaceCardId);
          return;
        }

        const match = location.pathname.match(
          /^\/marketplace\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i
        );
        const auctionId = match?.[1];
        if (!auctionId) return;

        const now = Date.now();
        if (
          marketplaceRequestedPath === location.pathname &&
          now - marketplaceRequestedAt < 2500
        ) {
          return;
        }

        marketplaceRequestedPath = location.pathname;
        marketplaceRequestedAt = now;

        window.dispatchEvent(new CustomEvent('wm-average-load-marketplace-detail', {
          detail: { auctionId }
        }));
      }

      return {
        getRarityFromCard, formatAverage, chooseAverage, renderCollectionCard,
        hydrateCacheForCards, renderVisibleCollectionCards, renderMarketplaceAverage,
        renderMarketplaceCurrent, renderKnownCard, renderGlobalCollectionInspectedCard,
        ensureGlobalCollectionInspectedCard, sortCollectionGridByPrice, ensureCollectionSortInjector
      };
    }
  };
})();
