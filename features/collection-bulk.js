(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.collectionBulk = {
    create(runtime) {
      const {
        BULK_RARITY_LAST_LOAD_KEY, ALL_COLLECTION_KEY, RARITIES,
        DEFAULT_RARE_RARITIES, isCollectionPage, normalizeTitle, cacheKey,
        storageGet, storageSet, reportError, createSponsorNote, isContextInvalidatedError
      } = runtime.core;

      let bulkActive = false;
      let bulkRequestId = null;
      let bulkSelectedRarities = new Set(DEFAULT_RARE_RARITIES);
      let bulkForceRarities = new Set();
      let bulkOnlyUnloaded = false;
      let bulkButton = null;
      let rankingButton = null;

      function ensurePriceLegend(toolbar = document.getElementById('wm-tools-bar')) {
        if (!runtime.settings.isEnabled('collectionPrices')) {
          document.getElementById('wm-price-legend')?.remove();
          return;
        }
        if (!isCollectionPage() || !toolbar || document.getElementById('wm-price-legend')) return;

        const legend = document.createElement('div');
        legend.id = 'wm-price-legend';
        legend.className = 'wm-price-legend';

        const heading = document.createElement('strong');
        heading.className = 'wm-price-legend-title';
        heading.textContent = 'Légende des prix';

        const items = document.createElement('div');
        items.className = 'wm-price-legend-items';

        const definitions = [
          {
            badge: 'Moy. 12 W',
            className: 'wm-price-legend-badge',
            text: 'prix moyen des ventes'
          },
          {
            badge: 'Moy. —',
            className: 'wm-price-legend-badge is-empty',
            text: 'aucune moyenne disponible'
          },
          {
            badge: 'Prix indispo.',
            className: 'wm-price-legend-badge is-error',
            text: 'erreur temporaire, nouvel essai automatique'
          },
          {
            badge: 'Prix…',
            className: 'wm-price-legend-badge is-loading',
            text: 'prix en cours de chargement'
          }
        ];

        for (const definition of definitions) {
          const item = document.createElement('span');
          item.className = 'wm-price-legend-item';

          const badge = document.createElement('span');
          badge.className = definition.className;
          badge.textContent = definition.badge;

          const text = document.createElement('span');
          text.className = 'wm-price-legend-text';
          text.textContent = definition.text;

          item.append(badge, text);
          items.append(item);
        }

        legend.append(heading, items);
        toolbar.insertAdjacentElement('afterend', legend);
      }

      function ensureToolbar() {
        if (!isCollectionPage() || document.getElementById('wm-tools-bar')) return;

        const bulkEnabled = runtime.settings.isEnabled('bulkPriceLoader');
        const rankingEnabled = runtime.settings.isEnabled('ranking');
        const compactEnabled = runtime.settings.isEnabled('compactMode');

        // File sync and discard remain accessible when optional price tools are off.

        const h1 = [...document.querySelectorAll('h1')].find((el) => normalizeTitle(el.textContent) === 'Collection');
        if (!h1) return;

        const header = h1.parentElement;
        if (!header?.parentElement) return;

        const bar = document.createElement('div');
        bar.id = 'wm-tools-bar';
        bar.className = 'wm-tools-bar';

        const brand = document.createElement('div');
        brand.className = 'wm-toolbar-brand';
        brand.innerHTML = '<span class="wm-brand-icon">✦</span><span class="wm-brand-title">WM Tools</span>';
        brand.title = 'Prix conservés sans expiration ; nouvelles cartes chargées automatiquement';
        bar.append(brand);

        if (bulkEnabled) {
          bulkButton = document.createElement('button');
          bulkButton.type = 'button';
          bulkButton.className = 'wm-tool-button';
          bulkButton.id = 'wm-bulk-launch';
          bulkButton.textContent = 'Actualiser les prix';
          bulkButton.title = 'Actualiser les prix moyens du marché pour votre collection';
          bulkButton.addEventListener('click', () => {
            handleBulkClick().catch((error) => reportError('chargement', error));
          });
          bar.append(bulkButton);
        }

        if (rankingEnabled) {
          rankingButton = document.createElement('button');
          rankingButton.type = 'button';
          rankingButton.className = 'wm-tool-button';
          rankingButton.id = 'wm-ranking-launch';
          rankingButton.textContent = 'Classement';
          rankingButton.title = 'Afficher les cartes de la collection classées par prix moyen décroissant';
          rankingButton.addEventListener('click', () => {
            runtime.ranking.openRankingModal().catch((error) => {
              reportError('classement', error);
              runtime.modalUi.showInfoModal(
                'Classement impossible',
                String(error?.message || error || 'Impossible de charger la collection.')
              );
            });
          });
          bar.append(rankingButton);
        }

        bar.append(createSponsorNote());
        header.insertAdjacentElement('afterend', bar);
        ensurePriceLegend(bar);
      }

      async function handleBulkClick() {
        if (bulkActive) return;

        const lastLoadsData = storageGet(BULK_RARITY_LAST_LOAD_KEY);
        const lastLoads = lastLoadsData[BULK_RARITY_LAST_LOAD_KEY] || {};

        const selection = await showRaritySelectionModal(lastLoads);
        if (!selection?.rarities?.length) return;

        const selected = selection.rarities;
        const onlyUnloaded = Boolean(selection.onlyUnloaded);
        const now = Date.now();

        const forceRarities = new Set(onlyUnloaded ? [] : selected);

        bulkActive = true;
        bulkSelectedRarities = new Set(selected);
        bulkForceRarities = forceRarities;
        bulkOnlyUnloaded = onlyUnloaded;
        bulkRequestId = `bulk:${now}:${Math.random().toString(36).slice(2)}`;

        setBulkButtonState('Collection…', true);

        window.dispatchEvent(new CustomEvent('wm-average-load-all-collection', {
          detail: {
            requestId: bulkRequestId,
            selectedRarities: [...bulkSelectedRarities]
          }
        }));
      }

      function showRaritySelectionModal(lastLoads = {}) {
        return new Promise((resolve) => {
          const overlay = document.createElement('div');
          overlay.className = 'wm-modal-overlay';

          const modal = document.createElement('div');
          modal.className = 'wm-modal wm-confirm-modal wm-rarity-modal';

          const title = document.createElement('h2');
          title.textContent = 'Actualisation des prix moyens';

          const text = document.createElement('p');
          text.className = 'wm-rarity-explanation';
          text.textContent = 'Sélectionnez les raretés à actualiser depuis le marché. Les nouvelles cartes ouvertes se mettent déjà à jour automatiquement.';

          const tip = document.createElement('p');
          tip.className = 'wm-rarity-tip';
          tip.textContent = 'Les prix sont conservés sans expiration. Charge toutes les raretés une fois ; les nouvelles cartes seront chargées automatiquement.';

          const presets = document.createElement('div');
          presets.className = 'wm-rarity-presets';

          const grid = document.createElement('div');
          grid.className = 'wm-rarity-grid';

          const selected = new Set(DEFAULT_RARE_RARITIES);
          const checkboxByRarity = new Map();

          const updateChecks = () => {
            for (const [rarity, input] of checkboxByRarity) {
              input.checked = selected.has(rarity);
              input.closest('.wm-rarity-option')?.classList.toggle('is-selected', input.checked);
            }
          };

          let onlyUnloaded = true;

          const makePreset = (label, rarities) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'wm-tool-button wm-rarity-preset';
            button.textContent = label;
            button.addEventListener('click', () => {
              selected.clear();
              rarities.forEach((rarity) => selected.add(rarity));
              updateChecks();
            });
            return button;
          };

          const missingOption = document.createElement('label');
          missingOption.className = 'wm-missing-option';

          const missingInput = document.createElement('input');
          missingInput.type = 'checkbox';
          missingInput.checked = true;

          const missingText = document.createElement('span');
          missingText.className = 'wm-missing-text';

          const missingTitle = document.createElement('strong');
          missingTitle.textContent = 'Uniquement les cartes sans prix';

          const missingDescription = document.createElement('span');
          missingDescription.textContent = 'Gain de temps : seules les cartes qui n’ont pas encore de cote estimée seront analysées.';

          missingText.append(missingTitle, missingDescription);
          missingOption.append(missingInput, missingText);

          const updateMissingState = () => {
            onlyUnloaded = missingInput.checked;
            const submit = modal.querySelector('[data-wm-price-submit]');
            if (submit) submit.textContent = onlyUnloaded ? 'Estimer les cartes manquantes' : 'Actualiser les prix sélectionnés';
            missingOption.classList.toggle('is-selected', onlyUnloaded);
          };

          missingInput.addEventListener('change', updateMissingState);

          updateMissingState();

          presets.append(
            makePreset('Rares', ['L', 'UR', 'SR', 'R']),
            makePreset('Courantes', ['PC', 'C']),
            makePreset('Toutes', RARITIES)
          );

          for (const rarity of RARITIES) {
            const label = document.createElement('label');
            label.className = 'wm-rarity-option';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = rarity;
            input.checked = selected.has(rarity);
            checkboxByRarity.set(rarity, input);

            const main = document.createElement('span');
            main.className = 'wm-rarity-option-main';
            main.textContent = rarity;

            const last = document.createElement('span');
            last.className = 'wm-rarity-last';
            const timestamp = Number(lastLoads[rarity]) || 0;
            last.textContent = timestamp ? `dernier chargement : il y a ${humanElapsed(timestamp)}` : 'jamais chargé en masse';

            input.addEventListener('change', () => {
              if (input.checked) selected.add(rarity);
              else selected.delete(rarity);
              label.classList.toggle('is-selected', input.checked);
            });

            label.classList.toggle('is-selected', input.checked);
            label.append(input, main, last);
            grid.append(label);
          }

          const actions = document.createElement('div');
          actions.className = 'wm-modal-actions';

          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.className = 'wm-tool-button wm-secondary-button';
          cancel.textContent = 'Annuler';

          const confirm = document.createElement('button');
          confirm.type = 'button';
          confirm.dataset.wmPriceSubmit = '1';
          confirm.className = 'wm-tool-button wm-primary-button';
          confirm.textContent = 'Charger les prix manquants';

          const close = (value) => {
            overlay.remove();
            resolve(value);
          };

          cancel.addEventListener('click', () => close(null));
          confirm.addEventListener('click', () => {
            const values = RARITIES.filter((rarity) => selected.has(rarity));
            if (!values.length) {
              confirm.textContent = 'Choisis au moins une rareté';
              return;
            }
            close({ rarities: values, onlyUnloaded });
          });
          overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close(null);
          });

          actions.append(cancel, confirm);
          modal.append(title, text, tip, presets, missingOption, grid, actions);
          overlay.append(modal);
          document.body.append(overlay);
        });
      }

      function setBulkButtonState(label, disabled) {
        ensureToolbar();
        if (!bulkButton) return;
        bulkButton.textContent = label;
        bulkButton.disabled = Boolean(disabled);
      }

      function updateBulkProgress(total, pendingCount) {
        if (!bulkActive || !total) return;
        const completed = Math.max(0, total - pendingCount);
        const label = bulkOnlyUnloaded ? 'Nouvelles' : 'Prix';
        setBulkButtonState(`${label} ${completed}/${total}`, true);
      }

      function finishBulkLoad(doneLabel = 'Chargé ✓') {
        if (!bulkActive) return;

        if (!bulkOnlyUnloaded) {
          const selectedRarities = [...bulkSelectedRarities];
          const data = storageGet(BULK_RARITY_LAST_LOAD_KEY);
          const lastLoads = { ...(data[BULK_RARITY_LAST_LOAD_KEY] || {}) };
          const now = Date.now();
          selectedRarities.forEach((rarity) => {
            lastLoads[rarity] = now;
          });
          storageSet({ [BULK_RARITY_LAST_LOAD_KEY]: lastLoads });
        }

        bulkActive = false;
        bulkRequestId = null;
        bulkForceRarities.clear();
        bulkOnlyUnloaded = false;
        setBulkButtonState(doneLabel, false);
        setTimeout(() => {
          if (!bulkActive) setBulkButtonState('Actualiser les prix', false);
        }, 2200);
      }

      function failBulkLoad(message) {
        bulkActive = false;
        bulkRequestId = null;
        bulkOnlyUnloaded = false;
        setBulkButtonState('Erreur', false);
        runtime.modalUi.showInfoModal('Chargement impossible', message || 'Impossible de charger toute la collection pour le moment.');
        setTimeout(() => {
          if (!bulkActive) setBulkButtonState('Actualiser les prix', false);
        }, 2200);
      }

      function humanElapsed(timestamp) {
        const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000));
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        const remaining = minutes % 60;
        return remaining ? `${hours} h ${remaining} min` : `${hours} h`;
      }

      window.addEventListener('wm-average-all-collection-progress', (event) => {
        if (!bulkActive || event.detail?.requestId !== bulkRequestId) return;
        const loadedPages = Number(event.detail.loadedPages) || 0;
        const totalPages = Number(event.detail.totalPages) || 0;
        if (totalPages > 0) {
          setBulkButtonState(`Collection ${loadedPages}/${totalPages}`, true);
        }
      });

      window.addEventListener('wm-average-all-collection', (event) => {
        const detail = event.detail || {};
        if (!bulkActive || detail.requestId !== bulkRequestId) return;

        if (!detail.ok) {
          failBulkLoad(detail.error || 'Erreur réseau');
          return;
        }

        const cards = Array.isArray(detail.cards) ? detail.cards : [];
        const fetchedAt = Date.now();

        if (detail.complete) {
          storageSet({
            [ALL_COLLECTION_KEY]: { fetchedAt, cards, complete: true, total: detail.total }
          });
        } else {
          // Keep every piece of collection metadata we have already seen.
          // A partial load is enough for « Plus chères » to rank the cached prices.
          const existingEntry = storageGet(ALL_COLLECTION_KEY)[ALL_COLLECTION_KEY];
          const existingCards = Array.isArray(existingEntry?.cards) ? existingEntry.cards : [];
          const merged = new Map(existingCards.map((card) => [card.id, { ...card }]));

          for (const card of cards) {
            const previous = merged.get(card.id);
            merged.set(card.id, previous ? { ...previous, ...card } : { ...card });
          }

          storageSet({
            [ALL_COLLECTION_KEY]: {
              fetchedAt,
              cards: [...merged.values()],
              complete: existingEntry?.complete === true
            }
          });
        }

        if (!cards.length) {
          finishBulkLoad();
          return;
        }

        let selectedCards = cards.filter((card) => bulkSelectedRarities.has(card.rarity));

        if (bulkOnlyUnloaded && selectedCards.length) {
          const cached = storageGet(selectedCards.map((card) => cacheKey(card.id)));
          selectedCards = selectedCards.filter((card) => !runtime.core.isCacheEntryValid(cached[cacheKey(card.id)]) || cached[cacheKey(card.id)]?.ok !== true);
        }

        if (!selectedCards.length) {
          finishBulkLoad(bulkOnlyUnloaded ? 'Aucune nouvelle ✓' : 'Chargé ✓');
          return;
        }

        setBulkButtonState(
          bulkOnlyUnloaded
            ? `Nouvelles (${selectedCards.length})…`
            : `Préparation (${selectedCards.length})…`,
          true
        );

        try {
          runtime.priceLoader.loadCacheForCards(selectedCards, {
            forceRarities: bulkOnlyUnloaded ? null : bulkForceRarities,
            markBulk: true
          });
        } catch (error) {
          if (!isContextInvalidatedError(error)) {
            failBulkLoad(String(error?.message || error));
          }
        }
      });


      return {
        ensurePriceLegend, ensureToolbar, updateBulkProgress,
        finishBulkLoad, failBulkLoad
      };
    }
  };
})();
