(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.packs = {
    create(runtime) {
      const {
        PULL_RECAP_ENABLED_KEY, AUTO_OPEN_ENABLED_KEY, AUTO_OPEN_NEXT_AT_KEY,
        AUTO_OPEN_SESSION_KEY, AUTO_OPEN_MIN_MINUTES_KEY, AUTO_OPEN_MAX_MINUTES_KEY,
        AUTO_OPEN_DEFAULT_MIN_MINUTES, AUTO_OPEN_DEFAULT_MAX_MINUTES,
        ALL_COLLECTION_KEY, cacheMemory, isPullsPage, isLastPullCardVisible,
        normalizeTitle, readLocalValue, writeLocalValue, storageGet, storageSet,
        reportError, createSponsorNote
      } = runtime.core;
      const { formatAverage, chooseAverage } = runtime.priceUi;

      function rarityMeta(r) {
        switch ((r || '').toUpperCase()) {
          case 'L': return { name: 'Légendaire', short: 'L', rank: 6, color: '#ffe144', bg: 'rgba(255, 225, 68, 0.12)', border: 'rgba(255, 225, 68, 0.35)' };
          case 'UR': return { name: 'Ultra Rare', short: 'UR', rank: 5, color: '#fa9931', bg: 'rgba(250, 153, 49, 0.12)', border: 'rgba(250, 153, 49, 0.35)' };
          case 'SR': return { name: 'Super Rare', short: 'SR', rank: 4, color: '#ed6fa3', bg: 'rgba(237, 111, 163, 0.12)', border: 'rgba(237, 111, 163, 0.35)' };
          case 'R': return { name: 'Rare', short: 'R', rank: 3, color: '#c6a7f2', bg: 'rgba(198, 167, 242, 0.12)', border: 'rgba(198, 167, 242, 0.35)' };
          case 'PC': return { name: 'Peu commune', short: 'PC', rank: 2, color: '#b1cff2', bg: 'rgba(177, 207, 242, 0.12)', border: 'rgba(177, 207, 242, 0.35)' };
          case 'C': return { name: 'Commune', short: 'C', rank: 1, color: '#b8f2d5', bg: 'rgba(184, 242, 213, 0.12)', border: 'rgba(184, 242, 213, 0.35)' };
          default: return { name: r || '—', short: r || '—', rank: 0, color: '#9ca3af', bg: 'rgba(255, 255, 255, 0.05)', border: 'rgba(255, 255, 255, 0.1)' };
        }
      }

      let pullRecapEnabled = runtime.settings.isEnabled('packRecap') && readLocalValue(PULL_RECAP_ENABLED_KEY) !== false;
      let activePackRecap = null;
      let packRecapDismissed = false;
      let openAllActive = false;
      let openAllIsManual = false;
      let openAllRequestId = null;
      let openAllButton = null;
      let openAllProgress = null;
      let openAllLiveOverlay = null;
      let openAllSummaryCards = [];
      let openAllOpenedPacks = 0;
      let openAllTotalPacks = null;
      let openAllError = null;
      let openAllRenderTimer = null;
      let openAllSummaryTitle = 'Cartes obtenues';
      let openAllSummaryOnClose = null;
      let openAllSummaryReloadOnClose = true;
      let autoOpenEnabled = runtime.settings.isEnabled('autoOpen') && readLocalValue(AUTO_OPEN_ENABLED_KEY) === true;
      let autoOpenTimer = null;
      let autoOpenRequestId = null;
      let autoOpenShowSummaryAfterCurrent = false;
      let autoOpenToggleInput = null;
      let autoOpenToggleLabel = null;

      const acknowledgedChecks = new WeakSet();

      const uiResponseProfile = {
        responsePace: 1 + Math.random() * 1.4,
        deliberation: 0.55 + Math.random() * 1.15,
        settleDelay: 300 + Math.random() * 1500
      };

      if (!runtime.settings.isEnabled('autoOpen')) {
        writeLocalValue(AUTO_OPEN_ENABLED_KEY, false);
        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
      }

      function lognormalSample(mu, sigma) {
        let u = 0;
        let v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        return Math.exp(mu + sigma * z);
      }

      function humanDelay(muMs, sigma, minMs, maxMs, multiplier = 1) {
        const raw = lognormalSample(Math.log(muMs), sigma) * multiplier;
        return Math.min(maxMs, Math.max(minMs, raw));
      }

      function humanActivateCheckbox(checkbox) {
        const label = checkbox.closest('label');
        const target = (label && Math.random() < 0.25) ? label : checkbox;

        if (Math.random() < 0.96) {
          try { checkbox.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        }

        target.click();
      }

      function humanConfirmButton(button) {
        if (!button.isConnected || button.disabled) return;

        if (Math.random() < 0.85) {
          try { button.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        }

        const deliberationMs = humanDelay(650, 0.65, 180, 4200, uiResponseProfile.deliberation);
        setTimeout(() => {
          if (button.isConnected && !button.disabled) button.click();
        }, deliberationMs);
      }

      function isElementEffectivelyVisible(element) {
        if (!element?.isConnected) return false;
        if (document.visibilityState !== 'visible') return false;

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;

        const style = window.getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none') return false;

        return rect.bottom > 0 && rect.right > 0 &&
          rect.top < window.innerHeight && rect.left < window.innerWidth;
      }

      function waitFor(condition, { timeoutMs = 15000, onDone } = {}) {
        const startedAt = Date.now();

        const probe = () => {
          if (condition()) {
            onDone(true);
            return;
          }

          if (Date.now() - startedAt > timeoutMs) {
            onDone(false);
            return;
          }

          setTimeout(probe, 90 + Math.random() * 160);
        };

        setTimeout(probe, 90 + Math.random() * 160);
      }

      function locatePendingConsent() {
        if (!isPullsPage()) return null;

        for (const honeypot of document.querySelectorAll('input[name="website"]')) {
          const hiddenLabel = honeypot.closest('label');
          const block = hiddenLabel?.parentElement;
          if (!block) continue;

          const checkbox = [...block.querySelectorAll('input[type="checkbox"]')]
            .find((input) => !input.closest('.wm-pulls-tools'));
          if (!checkbox) continue;

          const button = [...block.querySelectorAll('button')]
            .find((candidate) =>
              normalizeTitle(candidate.textContent).toLocaleLowerCase('fr') === 'continuer'
            ) || block.querySelector('button');
          if (!button) continue;

          return { block, checkbox, button };
        }

        return null;
      }

      function restoreAcknowledgedConsent() {
        if (runtime.packVerification?.isWaiting()) return;
        const verification = locatePendingConsent();
        if (!verification || acknowledgedChecks.has(verification.block)) return;

        acknowledgedChecks.add(verification.block);
        const { block, checkbox, button } = verification;

        const settleMs = uiResponseProfile.settleDelay;
        const readingDelay = humanDelay(2400, 0.55, 1200, 9000, uiResponseProfile.responsePace);

        setTimeout(() => {
          waitFor(() => isElementEffectivelyVisible(block), {
            onDone: (visible) => {
              if (!visible || !checkbox.isConnected) return;

              setTimeout(() => {
                if (!checkbox.isConnected) return;

                const commit = () => {
                  if (!checkbox.isConnected || !button.isConnected) return;

                  if (!checkbox.checked) {
                    humanActivateCheckbox(checkbox);
                  }

                  waitFor(() => (
                    checkbox.isConnected &&
                    button.isConnected &&
                    checkbox.checked &&
                    !button.disabled
                  ), {
                    timeoutMs: 5000,
                    onDone: (ready) => {
                      if (!ready) return;
                      humanConfirmButton(button);
                    }
                  });
                };

                if (Math.random() < 0.05) {
                  setTimeout(commit, humanDelay(6000, 0.6, 3000, 30000));
                } else {
                  commit();
                }
              }, readingDelay);
            }
          });
        }, settleMs);
      }

      function readAutoOpenSession() {
        const raw = readLocalValue(AUTO_OPEN_SESSION_KEY);

        return {
          startedAt: Number(raw?.startedAt) || Date.now(),
          openedPacks: Math.max(0, Number(raw?.openedPacks) || 0),
          runs: Math.max(0, Number(raw?.runs) || 0),
          cards: Array.isArray(raw?.cards) ? raw.cards.filter((card) => card?.id && card?.title) : [],
          errors: Array.isArray(raw?.errors) ? raw.errors.map(String).slice(-10) : []
        };
      }

      function writeAutoOpenSession(session) {
        writeLocalValue(AUTO_OPEN_SESSION_KEY, {
          startedAt: Number(session?.startedAt) || Date.now(),
          openedPacks: Math.max(0, Number(session?.openedPacks) || 0),
          runs: Math.max(0, Number(session?.runs) || 0),
          cards: Array.isArray(session?.cards) ? session.cards : [],
          errors: Array.isArray(session?.errors) ? session.errors.slice(-10) : []
        });
      }

      function resetAutoOpenSession() {
        const session = {
          startedAt: Date.now(),
          openedPacks: 0,
          runs: 0,
          cards: [],
          errors: []
        };
        writeAutoOpenSession(session);
        return session;
      }

      function getAutoOpenDelayBounds() {
        const normalizeMinutes = (value, fallback) => {
          const numeric = Math.round(Number(value));
          if (!Number.isFinite(numeric)) return fallback;
          return Math.max(1, Math.min(10080, numeric));
        };

        const first = normalizeMinutes(
          readLocalValue(AUTO_OPEN_MIN_MINUTES_KEY),
          AUTO_OPEN_DEFAULT_MIN_MINUTES
        );
        const second = normalizeMinutes(
          readLocalValue(AUTO_OPEN_MAX_MINUTES_KEY),
          AUTO_OPEN_DEFAULT_MAX_MINUTES
        );

        return {
          minDelay: Math.min(first, second) * 60 * 1000,
          maxDelay: Math.max(first, second) * 60 * 1000
        };
      }

      function randomAutoOpenDelay() {
        const { minDelay, maxDelay } = getAutoOpenDelayBounds();
        return Math.round(
          minDelay +
          Math.random() * (maxDelay - minDelay)
        );
      }

      function clearAutoOpenTimer() {
        if (autoOpenTimer) {
          clearTimeout(autoOpenTimer);
          autoOpenTimer = null;
        }
      }

      function updateAutoOpenToggleUi() {
        if (autoOpenToggleInput) {
          autoOpenToggleInput.checked = autoOpenEnabled;
        }
        if (autoOpenToggleLabel) {
          autoOpenToggleLabel.classList.toggle('is-enabled', autoOpenEnabled);
        }
      }

      function scheduleNextAutoOpen({ keepExisting = true } = {}) {
        clearAutoOpenTimer();

        if (!runtime.settings.isEnabled('autoOpen')) {
          autoOpenEnabled = false;
          writeLocalValue(AUTO_OPEN_ENABLED_KEY, false);
          localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
          return;
        }

        if (!autoOpenEnabled) {
          localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
          return;
        }

        let nextAt = keepExisting ? Number(readLocalValue(AUTO_OPEN_NEXT_AT_KEY)) || 0 : 0;
        const now = Date.now();

        if (nextAt <= now) {
          nextAt = now + randomAutoOpenDelay();
          writeLocalValue(AUTO_OPEN_NEXT_AT_KEY, nextAt);
        }

        const delay = Math.max(1000, nextAt - now);

        autoOpenTimer = setTimeout(() => {
          autoOpenTimer = null;
          runAutomaticOpen().catch((error) => {
            reportError('ouverture automatique', error);
            if (autoOpenEnabled) scheduleNextAutoOpen({ keepExisting: false });
          });
        }, delay);
      }

      function appendAutomaticOpenResult(detail) {
        const session = readAutoOpenSession();
        const cards = Array.isArray(detail?.cards) ? detail.cards : [];
        const openedPacks = Math.max(0, Number(detail?.openedPacks) || 0);

        if (cards.length || openedPacks > 0) {
          session.cards.push(...cards);
          session.openedPacks += openedPacks;
          session.runs += 1;
        }

        if (!detail?.ok && detail?.error) {
          session.errors.push(String(detail.error));
        }

        writeAutoOpenSession(session);
        return session;
      }

      function showAutomaticOpenSummary() {
        const session = readAutoOpenSession();

        if (!session.cards.length) {
          localStorage.removeItem(AUTO_OPEN_SESSION_KEY);
          runtime.modalUi.showInfoModal(
            'Ouverture automatique',
            'Aucune carte n’a été ouverte automatiquement pendant cette session.'
          );
          return;
        }

        const error =
          session.errors.length > 0
            ? `${session.errors.length} cycle${session.errors.length > 1 ? 's' : ''} interrompu${session.errors.length > 1 ? 's' : ''} pendant la session.`
            : null;

        openOpenAllSummary(
          session.cards,
          session.openedPacks,
          error,
          {
            title: 'Récap ouverture automatique',
            reloadOnClose: false,
            onClose: () => {
              localStorage.removeItem(AUTO_OPEN_SESSION_KEY);
            }
          }
        );
      }

      function disableAutomaticOpening({ showSummary = true } = {}) {
        autoOpenEnabled = false;
        writeLocalValue(AUTO_OPEN_ENABLED_KEY, false);
        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
        clearAutoOpenTimer();
        updateAutoOpenToggleUi();

        if (autoOpenRequestId && openAllActive && openAllRequestId === autoOpenRequestId) {
          autoOpenShowSummaryAfterCurrent = showSummary;
          return;
        }

        if (showSummary) {
          showAutomaticOpenSummary();
        }
      }

      function enableAutomaticOpening() {
        if (!runtime.settings.isEnabled('autoOpen')) return;
        autoOpenEnabled = true;
        writeLocalValue(AUTO_OPEN_ENABLED_KEY, true);
        resetAutoOpenSession();
        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
        autoOpenShowSummaryAfterCurrent = false;
        updateAutoOpenToggleUi();
        scheduleNextAutoOpen({ keepExisting: false });
      }

      // ----------------------------------------------------------------------
      // LIVE OPENING HUD (Pour l'ouverture manuelle fluide et animée)
      // ----------------------------------------------------------------------
      function showLiveOpeningHud() {
        document.getElementById('wm-open-all-live')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'wm-open-all-live';
        overlay.className = 'wm-modal-overlay wm-live-overlay';

        const modal = document.createElement('div');
        modal.className = 'wm-modal wm-live-modal';

        const header = document.createElement('div');
        header.className = 'wm-live-header';

        const headerLeft = document.createElement('div');
        headerLeft.className = 'wm-live-header-info';

        const titleRow = document.createElement('div');
        titleRow.className = 'wm-live-title-row';

        const pulseDot = document.createElement('span');
        pulseDot.className = 'wm-live-pulse-dot';

        const title = document.createElement('h2');
        title.className = 'wm-live-title';
        title.textContent = 'Ouverture de tous les paquets';

        titleRow.append(pulseDot, title);

        const statusPill = document.createElement('div');
        statusPill.className = 'wm-live-status-pill';
        statusPill.dataset.role = 'status-pill';
        statusPill.innerHTML = '<span class="wm-live-status-icon">📦</span> <span class="wm-live-status-text">Préparation de l’ouverture…</span>';

        headerLeft.append(titleRow, statusPill);

        const minBtn = document.createElement('button');
        minBtn.type = 'button';
        minBtn.className = 'wm-filter-pill-btn wm-live-minimize-btn';
        minBtn.textContent = '⤓ Réduire';
        minBtn.title = 'Réduire dans le coin de l’écran pour naviguer';
        minBtn.addEventListener('click', () => {
          overlay.classList.toggle('is-minimized');
          minBtn.textContent = overlay.classList.contains('is-minimized') ? '⤢ Agrandir' : '⤓ Réduire';
        });

        header.append(headerLeft, minBtn);

        // Section progression
        const progressSection = document.createElement('div');
        progressSection.className = 'wm-live-progress-section';

        const progressLabels = document.createElement('div');
        progressLabels.className = 'wm-live-progress-labels';

        const packCounter = document.createElement('span');
        packCounter.className = 'wm-live-pack-counter';
        packCounter.dataset.role = 'pack-counter';
        packCounter.textContent = 'En attente du premier paquet…';

        const percentage = document.createElement('span');
        percentage.className = 'wm-live-percentage';
        percentage.dataset.role = 'percentage';
        percentage.textContent = '0%';

        progressLabels.append(packCounter, percentage);

        const progressTrack = document.createElement('div');
        progressTrack.className = 'wm-live-progress-track';

        const progressBar = document.createElement('div');
        progressBar.className = 'wm-live-progress-bar';
        progressBar.dataset.role = 'progress-bar';
        progressBar.style.width = '0%';

        progressTrack.append(progressBar);
        progressSection.append(progressLabels, progressTrack);

        // Zone de scène (affichage des cartes en direct)
        const stageWrap = document.createElement('div');
        stageWrap.className = 'wm-live-stage-wrap';

        const stageHeader = document.createElement('div');
        stageHeader.className = 'wm-live-stage-header';

        const stageLabel = document.createElement('span');
        stageLabel.className = 'wm-live-stage-label';
        stageLabel.textContent = 'Cartes tirées en direct';

        const cardTally = document.createElement('span');
        cardTally.className = 'wm-live-card-tally';
        cardTally.dataset.role = 'card-tally';
        cardTally.textContent = '0 carte';

        stageHeader.append(stageLabel, cardTally);

        const cardsDeck = document.createElement('div');
        cardsDeck.className = 'wm-live-cards-deck';
        cardsDeck.dataset.role = 'cards-deck';

        const placeholder = document.createElement('div');
        placeholder.className = 'wm-live-deck-placeholder';
        placeholder.innerHTML = '<span class="wm-pack-icon-animated">✨</span><span>Les cartes s’afficheront ici au fur et à mesure…</span>';
        cardsDeck.append(placeholder);

        stageWrap.append(stageHeader, cardsDeck);

        // Barre basse de stats
        const footer = document.createElement('div');
        footer.className = 'wm-live-footer';

        const statsBar = document.createElement('div');
        statsBar.className = 'wm-live-stats-bar';

        const statPacks = document.createElement('span');
        statPacks.className = 'wm-stat-pill';
        statPacks.innerHTML = '<span class="wm-stat-label">Paquets</span> <span class="wm-stat-val" data-role="stat-packs">0</span>';

        const statCards = document.createElement('span');
        statCards.className = 'wm-stat-pill';
        statCards.innerHTML = '<span class="wm-stat-label">Cartes</span> <span class="wm-stat-val" data-role="stat-cards">0</span>';

        const statValue = document.createElement('span');
        statValue.className = 'wm-stat-pill wm-stat-highlight';
        statValue.dataset.role = 'stat-value-pill';
        statValue.innerHTML = '<span class="wm-stat-label">Valeur</span> <span class="wm-stat-val" data-role="stat-value">0 W</span>';

        statsBar.append(statPacks, statCards, statValue);
        footer.append(statsBar);

        modal.append(header, progressSection, stageWrap, footer);
        overlay.append(modal);
        document.body.append(overlay);
        openAllLiveOverlay = overlay;
      }

      function updateLiveOpeningCards(packCards) {
        if (!openAllLiveOverlay) return;

        const deck = openAllLiveOverlay.querySelector('[data-role="cards-deck"]');
        if (!deck) return;

        deck.replaceChildren();

        packCards.forEach((card, index) => {
          const rMeta = rarityMeta(card.rarity);
          const cardEl = document.createElement('div');
          cardEl.className = 'wm-live-card-item wm-card-reveal';
          cardEl.style.animationDelay = `${index * 70}ms`;
          cardEl.style.borderColor = rMeta.border;

          const thumbWrap = document.createElement('div');
          thumbWrap.className = 'wm-live-card-thumb';

          if (card.imageUrl) {
            const img = document.createElement('img');
            img.src = card.imageUrl;
            img.alt = card.title || '';
            img.loading = 'lazy';
            thumbWrap.append(img);
          } else {
            const fallback = document.createElement('div');
            fallback.className = 'wm-ranking-thumb-fallback';
            fallback.style.background = `linear-gradient(180deg, ${rMeta.bg} 0%, rgba(12, 16, 14, 0.95) 100%)`;
            fallback.style.color = rMeta.color;
            fallback.textContent = (card.rarity || 'W').toUpperCase();
            thumbWrap.append(fallback);

            if (runtime.imageResolver?.resolveMissingImage) {
              runtime.imageResolver.resolveMissingImage(card.title).then((entry) => {
                if (entry?.found && entry.url && thumbWrap.isConnected) {
                  const resolvedImg = document.createElement('img');
                  resolvedImg.src = entry.url;
                  resolvedImg.alt = card.title || '';
                  resolvedImg.loading = 'lazy';
                  resolvedImg.onload = () => {
                    fallback.remove();
                    thumbWrap.append(resolvedImg);
                  };
                }
              }).catch(() => {});
            }
          }

          const rarityTag = document.createElement('span');
          rarityTag.className = 'wm-live-card-rarity';
          rarityTag.style.color = rMeta.color;
          rarityTag.style.backgroundColor = rMeta.bg;
          rarityTag.style.borderColor = rMeta.border;
          rarityTag.textContent = rMeta.name;

          const titleEl = document.createElement('div');
          titleEl.className = 'wm-live-card-title';
          titleEl.textContent = card.title;
          titleEl.title = card.title;

          const priceEl = document.createElement('div');
          priceEl.className = 'wm-live-card-price';

          const entry = cacheMemory.get(card.id);
          const average = entry ? chooseAverage(entry, null, card.rarity || null) : null;
          if (Number.isFinite(average)) {
            priceEl.textContent = `${formatAverage(average)} W`;
          } else {
            priceEl.innerHTML = '<span class="wm-average-spinner"></span>';
          }

          cardEl.append(thumbWrap, rarityTag, titleEl, priceEl);
          deck.append(cardEl);
        });
      }

      function updateLiveOpeningProgress({ openedPacks, packsRemaining, waiting, waitMs }) {
        if (!openAllLiveOverlay) return;

        const total = Number.isFinite(packsRemaining) ? (openedPacks + packsRemaining) : (openAllTotalPacks || openedPacks);
        if (Number.isFinite(total) && total > 0) openAllTotalPacks = total;

        const statusPill = openAllLiveOverlay.querySelector('[data-role="status-pill"]');
        const packCounter = openAllLiveOverlay.querySelector('[data-role="pack-counter"]');
        const percentage = openAllLiveOverlay.querySelector('[data-role="percentage"]');
        const progressBar = openAllLiveOverlay.querySelector('[data-role="progress-bar"]');
        const cardTally = openAllLiveOverlay.querySelector('[data-role="card-tally"]');
        const statPacks = openAllLiveOverlay.querySelector('[data-role="stat-packs"]');
        const statCards = openAllLiveOverlay.querySelector('[data-role="stat-cards"]');
        const statValue = openAllLiveOverlay.querySelector('[data-role="stat-value"]');
        const statValuePill = openAllLiveOverlay.querySelector('[data-role="stat-value-pill"]');

        const pct = openAllTotalPacks && openAllTotalPacks > 0
          ? Math.min(100, Math.round((openedPacks / openAllTotalPacks) * 100))
          : 0;

        if (progressBar) progressBar.style.width = `${pct}%`;
        if (percentage) percentage.textContent = `${pct}%`;

        if (packCounter) {
          packCounter.textContent = openAllTotalPacks
            ? `Paquet ${openedPacks} sur ${openAllTotalPacks}`
            : `${openedPacks} paquet${openedPacks > 1 ? 's' : ''} ouvert${openedPacks > 1 ? 's' : ''}`;
        }

        if (cardTally) {
          cardTally.textContent = `${openAllSummaryCards.length} carte${openAllSummaryCards.length > 1 ? 's' : ''}`;
        }

        if (statPacks) statPacks.textContent = String(openedPacks);
        if (statCards) statCards.textContent = String(openAllSummaryCards.length);

        if (waiting) {
          const s = Math.max(1, Math.ceil(Number(waitMs || 0) / 1000));
          if (statusPill) {
            statusPill.innerHTML = `<span class="wm-live-status-icon">⏳</span> <span class="wm-live-status-text">Pause anti-flood (${s}s)…</span>`;
          }
        } else if (openedPacks > 0) {
          if (statusPill) {
            statusPill.innerHTML = `<span class="wm-live-status-icon">⚡</span> <span class="wm-live-status-text">Paquet ${openedPacks} ouvert !</span>`;
          }
        }

        // Calcul valeur cumulée
        const knownSum = openAllSummaryCards.reduce((sum, card) => {
          const entry = cacheMemory.get(card.id);
          const avg = entry ? chooseAverage(entry, null, card.rarity || null) : null;
          return sum + (Number.isFinite(avg) ? avg : 0);
        }, 0);

        if (knownSum > 0 && statValue && statValuePill) {
          statValue.textContent = `${formatAverage(Math.round(knownSum))} W`;
          statValuePill.style.display = 'inline-flex';
        }
      }

      function startOpenAllPacks({ automatic = false } = {}) {
        if (openAllActive) return false;

        openAllActive = true;
        openAllIsManual = !automatic;
        openAllSummaryCards = [];
        openAllOpenedPacks = 0;
        openAllTotalPacks = null;
        openAllError = null;
        openAllRequestId = `${automatic ? 'auto-packs' : 'packs'}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

        if (automatic) {
          autoOpenRequestId = openAllRequestId;
        }

        if (openAllButton?.isConnected) {
          openAllButton.disabled = true;
          openAllButton.textContent = automatic ? 'Auto ouverture…' : 'Ouverture…';
        }

        if (openAllProgress) {
          openAllProgress.hidden = true;
        }

        document.getElementById('wm-pack-recap')?.remove();
        document.getElementById('wm-open-all-overlay')?.remove();

        if (openAllIsManual) {
          showLiveOpeningHud();
        }

        window.dispatchEvent(new CustomEvent('wm-average-open-all-packs', {
          detail: { requestId: openAllRequestId }
        }));

        return true;
      }

      async function runAutomaticOpen() {
        if (!autoOpenEnabled) return;

        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);

        if (openAllActive) {
          scheduleNextAutoOpen({ keepExisting: false });
          return;
        }

        const started = startOpenAllPacks({ automatic: true });
        if (!started && autoOpenEnabled) {
          scheduleNextAutoOpen({ keepExisting: false });
        }
      }

      function showAutoOpenHelp() {
        runtime.modalUi.showInfoModal(
          'Ouverture automatique',
          'Quand cette option est activée, l’extension attend aléatoirement entre 20 et 100 minutes puis utilise « Tout ouvrir » pour ouvrir tous les paquets disponibles. Les récaps intermédiaires restent masqués et le cycle recommence automatiquement. Quand vous désactivez l’option, un récapitulatif cumulé de toutes les cartes ouvertes automatiquement s’affiche. Les ouvertures sont espacées et aléatoires, il n\'y a aucune différence entre avoir cela activé et mettre un réveil toutes les x minutes, les requetes au serveur sont les mêmes. WikiMasters doit rester ouvert dans au moins un onglet pour que l’automatisation puisse s’exécuter.'
        );
      }

      function ensurePullsToolbar() {
        if (!isPullsPage() || document.getElementById('wm-pulls-info')) return;

        const h1 = [...document.querySelectorAll('h1')]
          .find((el) => normalizeTitle(el.textContent) === 'Ouvrir un paquet');
        if (!h1) return;

        const header = h1.parentElement;
        if (!header) return;
        header.classList.add('wm-pulls-header');

        const tools = document.createElement('div');
        tools.id = 'wm-pulls-tools';
        tools.className = 'wm-pulls-tools';

        if (runtime.settings.isEnabled('packRecap')) {
          const label = document.createElement('label');
          label.className = 'wm-pulls-toggle';
          label.title = 'Afficher le récapitulatif des prix après chaque paquet';

          const textWrap = document.createElement('span');
          textWrap.className = 'wm-pulls-toggle-text';
          const title = document.createElement('strong');
          title.textContent = 'Récap prix';
          textWrap.append(title);

          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = pullRecapEnabled;

          const track = document.createElement('span');
          track.className = 'wm-toggle-track';
          const knob = document.createElement('span');
          knob.className = 'wm-toggle-knob';
          track.append(knob);

          input.addEventListener('change', () => {
            pullRecapEnabled = input.checked;
            writeLocalValue(PULL_RECAP_ENABLED_KEY, pullRecapEnabled);
            label.classList.toggle('is-enabled', pullRecapEnabled);

            if (pullRecapEnabled) {
              packRecapDismissed = false;
              renderPackRecap();
            } else {
              document.getElementById('wm-pack-recap')?.remove();
            }
          });

          label.classList.toggle('is-enabled', pullRecapEnabled);
          label.append(textWrap, input, track);
          tools.append(label);
        }

        if (runtime.settings.isEnabled('autoOpen')) {
          const autoControl = document.createElement('span');
          autoControl.className = 'wm-auto-open-control';

          autoOpenToggleLabel = document.createElement('label');
          autoOpenToggleLabel.className = 'wm-pulls-toggle wm-auto-open-toggle';
          autoOpenToggleLabel.title = 'Ouvrir automatiquement tous les paquets à intervalles aléatoires';

          const autoTextWrap = document.createElement('span');
          autoTextWrap.className = 'wm-pulls-toggle-text';
          const autoTitle = document.createElement('strong');
          autoTitle.textContent = 'Ouvrir automatiquement';
          autoTextWrap.append(autoTitle);

          autoOpenToggleInput = document.createElement('input');
          autoOpenToggleInput.type = 'checkbox';
          autoOpenToggleInput.checked = autoOpenEnabled;

          const autoTrack = document.createElement('span');
          autoTrack.className = 'wm-toggle-track';
          const autoKnob = document.createElement('span');
          autoKnob.className = 'wm-toggle-knob';
          autoTrack.append(autoKnob);

          autoOpenToggleInput.addEventListener('change', () => {
            if (autoOpenToggleInput.checked) enableAutomaticOpening();
            else disableAutomaticOpening({ showSummary: true });
          });

          autoOpenToggleLabel.classList.toggle('is-enabled', autoOpenEnabled);
          autoOpenToggleLabel.append(autoTextWrap, autoOpenToggleInput, autoTrack);

          const helpButton = document.createElement('button');
          helpButton.type = 'button';
          helpButton.className = 'wm-auto-open-help';
          helpButton.textContent = '?';
          helpButton.title = 'Comment fonctionne l’ouverture automatique ?';
          helpButton.setAttribute('aria-label', 'Aide ouverture automatique');
          helpButton.addEventListener('click', showAutoOpenHelp);

          autoControl.append(autoOpenToggleLabel, helpButton);
          tools.append(autoControl);
        }

        if (tools.childElementCount > 0) {
          h1.insertAdjacentElement('afterend', tools);
        }

        const info = document.createElement('div');
        info.id = 'wm-pulls-info';
        info.className = 'wm-pulls-info';

        if (runtime.settings.isEnabled('openAll')) {
          openAllButton = document.createElement('button');
          openAllButton.type = 'button';
          openAllButton.className = 'wm-tool-button wm-open-all-button';
          openAllButton.textContent = openAllActive ? 'Ouverture…' : 'Tout ouvrir';
          openAllButton.disabled = openAllActive;
          openAllButton.title = 'Ouvrir tous les paquets disponibles avec suivi en direct';
          openAllButton.addEventListener('click', () => {
            handleOpenAllPacksClick().catch((error) => reportError('tout ouvrir', error));
          });

          openAllProgress = document.createElement('span');
          openAllProgress.className = 'wm-open-all-progress';
          openAllProgress.hidden = true;

          info.append(openAllButton, openAllProgress);
        }

        if (
          runtime.settings.isEnabled('packRecap') ||
          runtime.settings.isEnabled('openAll') ||
          runtime.settings.isEnabled('autoOpen')
        ) {
          const cacheNote = document.createElement('div');
          cacheNote.className = 'wm-pulls-cache-note';
          cacheNote.textContent = 'Les prix moyens utilisés par les outils sont conservés dans le cache local.';
          info.append(cacheNote, createSponsorNote());
        }

        const pageSubtitle = [...header.children].find((el) => el.tagName === 'P');
        if (pageSubtitle) pageSubtitle.insertAdjacentElement('afterend', info);
        else header.append(info);
      }

      function showOpenAllConfirmation() {
        return new Promise((resolve) => {
          const overlay = document.createElement('div');
          overlay.className = 'wm-modal-overlay';

          const modal = document.createElement('div');
          modal.className = 'wm-modal wm-confirm-modal';

          const title = document.createElement('h2');
          title.textContent = 'Ouvrir tous les paquets ?';

          const text = document.createElement('p');
          text.textContent = 'Tous les paquets disponibles vont être ouverts automatiquement. Les cartes obtenues s’afficheront en direct avec leurs cotes.';

          const actions = document.createElement('div');
          actions.className = 'wm-modal-actions';

          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.className = 'wm-tool-button wm-secondary-button';
          cancel.textContent = 'Annuler';

          const confirm = document.createElement('button');
          confirm.type = 'button';
          confirm.className = 'wm-tool-button';
          confirm.textContent = 'Tout ouvrir';

          const close = (value) => {
            overlay.remove();
            resolve(value);
          };

          cancel.addEventListener('click', () => close(false));
          confirm.addEventListener('click', () => close(true));
          overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close(false);
          });

          actions.append(cancel, confirm);
          modal.append(title, text, actions);
          overlay.append(modal);
          document.body.append(overlay);
        });
      }

      async function handleOpenAllPacksClick() {
        if (openAllActive) return;

        const confirmed = await showOpenAllConfirmation();
        if (!confirmed) return;

        startOpenAllPacks({ automatic: false });
      }

      function setOpenAllButtonProgress(openedPacks, packsRemaining = null) {
        if (openAllProgress) {
          if (Number.isFinite(Number(packsRemaining))) {
            const total = openedPacks + Number(packsRemaining);
            openAllProgress.textContent = `${openedPacks}/${total} ouverts`;
          } else {
            openAllProgress.textContent = `${openedPacks} ouverts`;
          }
          openAllProgress.hidden = false;
        }

        if (!openAllButton) return;

        if (Number.isFinite(Number(packsRemaining))) {
          openAllButton.textContent = `Ouverts ${openedPacks} • reste ${Number(packsRemaining)}`;
        } else {
          openAllButton.textContent = `Ouverts ${openedPacks}`;
        }
      }

      function setOpenAllButtonWaiting(waitMs) {
        if (!openAllButton) return;
        const seconds = Math.max(1, Math.ceil(Number(waitMs || 0) / 1000));
        openAllButton.textContent = `Attente ${seconds}s…`;
      }

      function scheduleOpenAllSummaryRender() {
        if (openAllRenderTimer) return;

        openAllRenderTimer = setTimeout(() => {
          openAllRenderTimer = null;
          renderOpenAllSummary();
        }, 100);
      }

      // ----------------------------------------------------------------------
      // MENU "CARTES OBTENUES" REDESIGN COMPLET
      // ----------------------------------------------------------------------
      let summaryViewMode = 'grid'; // 'grid' | 'list'
      let summarySearchQuery = '';
      let summaryRarityFilter = '';
      let summarySortOrder = 'price_desc'; // 'price_desc' | 'price_asc' | 'rarity' | 'chronological'

      function renderOpenAllSummary() {
        const overlay = document.getElementById('wm-open-all-overlay');
        if (!overlay || !openAllSummaryCards.length) return;

        const subtitle = overlay.querySelector('[data-role="subtitle"]');
        const footer = overlay.querySelector('[data-role="footer"]');
        const container = overlay.querySelector('[data-role="cards-container"]');
        if (!subtitle || !footer || !container) return;

        // Regroupement des doublons tirés
        const groupedMap = new Map();
        openAllSummaryCards.forEach((card, originalIndex) => {
          const existing = groupedMap.get(card.id);
          if (existing) {
            existing.count += 1;
          } else {
            groupedMap.set(card.id, {
              ...card,
              count: 1,
              _firstIndex: originalIndex
            });
          }
        });

        const rows = [...groupedMap.values()].map((card) => {
          const entry = cacheMemory.get(card.id);
          const loaded = Boolean(entry);
          const average = entry ? chooseAverage(entry, null, card.rarity || null) : null;
          return { ...card, loaded, average };
        });

        // Filtrage
        const filtered = rows.filter((row) => {
          if (summarySearchQuery && !row.title.toLowerCase().includes(summarySearchQuery.toLowerCase())) {
            return false;
          }
          if (summaryRarityFilter && (row.rarity || '').toUpperCase() !== summaryRarityFilter.toUpperCase()) {
            return false;
          }
          return true;
        });

        // Tri
        filtered.sort((a, b) => {
          if (summarySortOrder === 'price_desc') {
            const aPrice = Number.isFinite(a.average) ? a.average : -Infinity;
            const bPrice = Number.isFinite(b.average) ? b.average : -Infinity;
            if (bPrice !== aPrice) return bPrice - aPrice;
            return a.title.localeCompare(b.title, 'fr');
          }
          if (summarySortOrder === 'price_asc') {
            const aPrice = Number.isFinite(a.average) ? a.average : Infinity;
            const bPrice = Number.isFinite(b.average) ? b.average : Infinity;
            if (aPrice !== bPrice) return aPrice - bPrice;
            return a.title.localeCompare(b.title, 'fr');
          }
          if (summarySortOrder === 'rarity') {
            const aRank = rarityMeta(a.rarity).rank;
            const bRank = rarityMeta(b.rarity).rank;
            if (bRank !== aRank) return bRank - aRank;
            const aPrice = Number.isFinite(a.average) ? a.average : -Infinity;
            const bPrice = Number.isFinite(b.average) ? b.average : -Infinity;
            return bPrice - aPrice;
          }
          // chronologique
          return a._firstIndex - b._firstIndex;
        });

        // Stats globales
        const totalCardsCount = openAllSummaryCards.length;
        const loadedCount = rows.filter((r) => r.loaded).length;
        const pricedRows = rows.filter((r) => Number.isFinite(r.average));
        const totalEstimatedValue = pricedRows.reduce((sum, r) => sum + (r.average * r.count), 0);
        const rarePlusCount = openAllSummaryCards.filter((c) => {
          const r = (c.rarity || '').toUpperCase();
          return ['R', 'SR', 'UR', 'L'].includes(r);
        }).length;

        // Mise à jour de l'en-tête de stats
        subtitle.innerHTML = `
          <span class="wm-stat-pill wm-stat-highlight">
            <span class="wm-stat-label">Valeur totale estimée</span>
            <span class="wm-stat-val">${formatAverage(Math.round(totalEstimatedValue))} W</span>
          </span>
          <span class="wm-stat-pill">
            <span class="wm-stat-label">Paquets ouverts</span>
            <span class="wm-stat-val">${openAllOpenedPacks}</span>
          </span>
          <span class="wm-stat-pill">
            <span class="wm-stat-label">Cartes obtenues</span>
            <span class="wm-stat-val">${totalCardsCount}</span>
          </span>
          ${rarePlusCount > 0 ? `
            <span class="wm-stat-pill">
              <span class="wm-stat-label">Rares & +</span>
              <span class="wm-stat-val" style="color:#fde047;">★ ${rarePlusCount}</span>
            </span>
          ` : ''}
          <span class="wm-stat-pill">
            <span class="wm-stat-label">Cotées</span>
            <span class="wm-stat-val">${loadedCount}/${rows.length}</span>
          </span>
        `;

        // Rendu du conteneur de cartes (Grille ou Liste)
        container.replaceChildren();

        if (summaryViewMode === 'grid') {
          container.className = 'wm-open-all-grid';

          filtered.forEach((row, index) => {
            const rMeta = rarityMeta(row.rarity);
            const cardEl = document.createElement('div');
            cardEl.className = 'wm-summary-card';
            cardEl.style.borderColor = rMeta.border;

            // Podium pour les 3 cartes les plus chères
            if (summarySortOrder === 'price_desc' && Number.isFinite(row.average) && index < 3) {
              const medal = document.createElement('div');
              medal.className = `wm-summary-podium-badge wm-rank-${index + 1}`;
              medal.textContent = `#${index + 1}`;
              cardEl.append(medal);
            }

            // Badge d'exemplaires multiples
            if (row.count > 1) {
              const countBadge = document.createElement('div');
              countBadge.className = 'wm-summary-count-badge';
              countBadge.textContent = `×${row.count}`;
              cardEl.append(countBadge);
            }

            // Image de la carte
            const thumb = document.createElement('div');
            thumb.className = 'wm-summary-thumb';

            if (row.imageUrl) {
              const img = document.createElement('img');
              img.src = row.imageUrl;
              img.alt = row.title || '';
              img.loading = 'lazy';
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

            // Badge rareté
            const rarityPill = document.createElement('div');
            rarityPill.className = 'wm-summary-rarity-pill';
            rarityPill.style.color = rMeta.color;
            rarityPill.style.backgroundColor = rMeta.bg;
            rarityPill.style.borderColor = rMeta.border;
            rarityPill.textContent = rMeta.name;

            // Titre
            const titleEl = document.createElement('div');
            titleEl.className = 'wm-summary-card-title';
            titleEl.textContent = row.title;
            titleEl.title = row.title;

            // Prix
            const priceEl = document.createElement('div');
            priceEl.className = 'wm-summary-card-price';

            if (!row.loaded) {
              priceEl.innerHTML = '<span class="wm-average-spinner"></span> <span style="font-size:11px;color:var(--wm-muted);">Estimation…</span>';
            } else if (Number.isFinite(row.average)) {
              priceEl.innerHTML = `<span class="wm-price-val">${formatAverage(row.average)} W</span> <span class="wm-price-sub">cote</span>`;
            } else {
              priceEl.innerHTML = '<span style="color:var(--wm-faint);">Sans cote</span>';
            }

            cardEl.append(thumb, rarityPill, titleEl, priceEl);
            container.append(cardEl);
          });
        } else {
          // Mode Liste tabulaire
          container.className = 'wm-open-all-list';

          filtered.forEach((row, index) => {
            const rMeta = rarityMeta(row.rarity);
            const item = document.createElement('div');
            item.className = 'wm-open-all-row';

            const rank = document.createElement('span');
            rank.className = 'wm-open-all-rank';
            if (index < 3 && summarySortOrder === 'price_desc' && Number.isFinite(row.average)) {
              rank.className += ` wm-rank-${index + 1}`;
              rank.textContent = `#${index + 1}`;
            } else {
              rank.textContent = String(index + 1);
            }

            const thumb = document.createElement('span');
            thumb.className = 'wm-open-all-thumb';
            if (row.imageUrl) {
              const img = document.createElement('img');
              img.src = row.imageUrl;
              img.alt = '';
              img.loading = 'lazy';
              thumb.append(img);
            } else {
              const fallback = document.createElement('div');
              fallback.className = 'wm-ranking-thumb-fallback';
              fallback.style.background = rMeta.bg;
              fallback.style.color = rMeta.color;
              fallback.textContent = (row.rarity || 'W').toUpperCase();
              thumb.append(fallback);
            }

            const info = document.createElement('span');
            info.className = 'wm-open-all-info';

            const name = document.createElement('strong');
            name.textContent = row.title;

            const metaWrap = document.createElement('span');
            metaWrap.className = 'wm-open-all-meta-wrap';

            const rPill = document.createElement('span');
            rPill.className = 'wm-ranking-rarity-pill';
            rPill.style.color = rMeta.color;
            rPill.style.backgroundColor = rMeta.bg;
            rPill.style.borderColor = rMeta.border;
            rPill.textContent = rMeta.name;
            metaWrap.append(rPill);

            if (row.count > 1) {
              const countPill = document.createElement('span');
              countPill.className = 'wm-ranking-count';
              countPill.textContent = `×${row.count}`;
              metaWrap.append(countPill);
            }

            info.append(name, metaWrap);

            const value = document.createElement('span');
            value.className = 'wm-open-all-price';

            if (!row.loaded) {
              value.classList.add('is-loading');
              const spinner = document.createElement('span');
              spinner.className = 'wm-average-spinner';
              value.append(spinner, document.createTextNode('…'));
            } else if (Number.isFinite(row.average)) {
              value.textContent = `${formatAverage(row.average)} W`;
            } else {
              value.textContent = '—';
              value.classList.add('is-empty');
            }

            item.append(rank, thumb, info, value);
            container.append(item);
          });
        }

        // Pied de page
        footer.replaceChildren();

        const footerLeft = document.createElement('div');
        footerLeft.className = 'wm-summary-footer-left';

        if (loadedCount < rows.length) {
          footerLeft.textContent = 'Actualisation des cotes en arrière-plan…';
        } else if (!pricedRows.length) {
          footerLeft.textContent = 'Aucune des cartes obtenues n’a de cote enregistrée.';
        } else {
          footerLeft.textContent = `Total estimé du tirage : ${formatAverage(Math.round(totalEstimatedValue))} W`;
        }

        if (openAllError) {
          const errDiv = document.createElement('div');
          errDiv.className = 'wm-open-all-error';
          errDiv.textContent = openAllError;
          footerLeft.append(document.createElement('br'), errDiv);
        }

        const footerRight = document.createElement('div');
        footerRight.className = 'wm-summary-footer-right';

        const reloadBtn = document.createElement('button');
        reloadBtn.type = 'button';
        reloadBtn.className = 'wm-tool-button';
        reloadBtn.textContent = 'Fermer et actualiser la page';
        reloadBtn.addEventListener('click', () => {
          overlay.remove();
          location.reload();
        });

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'wm-tool-button wm-secondary-button';
        closeBtn.textContent = 'Fermer';
        closeBtn.addEventListener('click', () => {
          overlay.remove();
        });

        footerRight.append(closeBtn, reloadBtn);
        footer.append(footerLeft, footerRight);
      }

      function openOpenAllSummary(cards, openedPacks, error = null, options = {}) {
        document.getElementById('wm-open-all-live')?.remove();
        document.getElementById('wm-open-all-overlay')?.remove();

        openAllSummaryCards = cards;
        openAllOpenedPacks = openedPacks;
        openAllError = error;
        openAllSummaryTitle = options.title || 'Cartes obtenues';
        openAllSummaryOnClose = typeof options.onClose === 'function' ? options.onClose : null;
        openAllSummaryReloadOnClose = options.reloadOnClose !== false;

        const overlay = document.createElement('div');
        overlay.id = 'wm-open-all-overlay';
        overlay.className = 'wm-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'wm-modal wm-open-all-modal';

        // En-tête
        const header = document.createElement('div');
        header.className = 'wm-open-all-header';

        const headingWrap = document.createElement('div');
        headingWrap.className = 'wm-ranking-heading-wrap';

        const title = document.createElement('h2');
        title.textContent = openAllSummaryTitle;

        const subtitle = document.createElement('div');
        subtitle.className = 'wm-ranking-header-stats';
        subtitle.dataset.role = 'subtitle';

        headingWrap.append(title, subtitle);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'wm-ranking-close';
        closeButton.textContent = '×';
        closeButton.setAttribute('aria-label', 'Fermer');

        const close = () => {
          overlay.remove();
          const onClose = openAllSummaryOnClose;
          const reloadOnClose = openAllSummaryReloadOnClose;

          openAllSummaryCards = [];
          openAllError = null;
          openAllSummaryTitle = 'Cartes obtenues';
          openAllSummaryOnClose = null;
          openAllSummaryReloadOnClose = true;

          try {
            onClose?.();
          } catch (err) {
            reportError('fermeture récap', err);
          }

          if (reloadOnClose) {
            location.reload();
          }
        };

        closeButton.addEventListener('click', close);
        header.append(headingWrap, closeButton);

        // Barre d'outils et de filtres
        const toolbar = document.createElement('div');
        toolbar.className = 'wm-open-all-toolbar';

        // Vue switch Grille / Liste
        const viewGroup = document.createElement('div');
        viewGroup.className = 'wm-sale-mode-group';

        const gridBtn = document.createElement('button');
        gridBtn.type = 'button';
        gridBtn.className = `wm-sale-mode-choice ${summaryViewMode === 'grid' ? 'is-active' : ''}`;
        gridBtn.textContent = '⊞ Grille';

        const listBtn = document.createElement('button');
        listBtn.type = 'button';
        listBtn.className = `wm-sale-mode-choice ${summaryViewMode === 'list' ? 'is-active' : ''}`;
        listBtn.textContent = '☰ Liste';

        gridBtn.addEventListener('click', () => {
          summaryViewMode = 'grid';
          gridBtn.classList.add('is-active');
          listBtn.classList.remove('is-active');
          renderOpenAllSummary();
        });

        listBtn.addEventListener('click', () => {
          summaryViewMode = 'list';
          listBtn.classList.add('is-active');
          gridBtn.classList.remove('is-active');
          renderOpenAllSummary();
        });

        viewGroup.append(gridBtn, listBtn);

        // Recherche
        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.className = 'wm-ranking-search-input';
        searchInput.placeholder = 'Rechercher parmi les cartes obtenues…';
        searchInput.setAttribute('aria-label', 'Rechercher par titre');
        searchInput.addEventListener('input', () => {
          summarySearchQuery = searchInput.value.trim();
          renderOpenAllSummary();
        });

        // Filtre Rareté
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
        raritySelect.addEventListener('change', () => {
          summaryRarityFilter = raritySelect.value;
          renderOpenAllSummary();
        });

        // Tri
        const sortSelect = document.createElement('select');
        sortSelect.className = 'wm-sale-duration-select';
        sortSelect.setAttribute('aria-label', 'Trier les cartes');
        const sorts = [
          ['price_desc', 'Prix décroissant'],
          ['price_asc', 'Prix croissant'],
          ['rarity', 'Rareté (L en premier)'],
          ['chronological', 'Ordre de tirage']
        ];
        for (const [sVal, sLabel] of sorts) {
          const opt = document.createElement('option');
          opt.value = sVal;
          opt.textContent = sLabel;
          sortSelect.append(opt);
        }
        sortSelect.value = summarySortOrder;
        sortSelect.addEventListener('change', () => {
          summarySortOrder = sortSelect.value;
          renderOpenAllSummary();
        });

        toolbar.append(viewGroup, searchInput, raritySelect, sortSelect);

        // Conteneur dynamique (Grille ou Liste)
        const container = document.createElement('div');
        container.dataset.role = 'cards-container';
        container.className = summaryViewMode === 'grid' ? 'wm-open-all-grid' : 'wm-open-all-list';

        // Pied de page
        const footer = document.createElement('div');
        footer.className = 'wm-open-all-footer';
        footer.dataset.role = 'footer';

        modal.append(header, toolbar, container, footer);
        overlay.append(modal);
        document.body.append(overlay);

        renderOpenAllSummary();
      }

      function mergePulledCardsIntoCollectionCache(cards) {
        const stored = storageGet(ALL_COLLECTION_KEY);
        const entry = stored[ALL_COLLECTION_KEY];
        if (!Array.isArray(entry?.cards) || !entry.cards.length) return;

        const byId = new Map(entry.cards.map((card) => [card.id, { ...card }]));
        const addedCounts = new Map();

        for (const card of cards) {
          addedCounts.set(card.id, (addedCounts.get(card.id) || 0) + 1);
          const existing = byId.get(card.id);
          if (!existing) {
            byId.set(card.id, { ...card, count: 0 });
          }
        }

        for (const [id, amount] of addedCounts) {
          const current = byId.get(id);
          current.count = (Number(current.count) || 0) + amount;
        }

        storageSet({
          [ALL_COLLECTION_KEY]: {
            ...entry,
            fetchedAt: Date.now(),
            cards: [...byId.values()]
          }
        });
      }

      function renderPackRecap() {
        const existing = document.getElementById('wm-pack-recap');

        if (
          !runtime.settings.isEnabled('packRecap') ||
          !isPullsPage() ||
          !pullRecapEnabled ||
          packRecapDismissed ||
          !activePackRecap?.cards?.length ||
          !isLastPullCardVisible()
        ) {
          existing?.remove();
          return;
        }

        const panel = existing || document.createElement('aside');
        panel.id = 'wm-pack-recap';
        panel.className = 'wm-pack-recap';
        panel.replaceChildren();

        const header = document.createElement('div');
        header.className = 'wm-pack-recap-header';

        const headingWrap = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = 'Prix moyens du paquet';

        const subtitle = document.createElement('span');
        const loaded = activePackRecap.cards.filter((card) => cacheMemory.has(card.id)).length;
        subtitle.textContent = `${loaded}/${activePackRecap.cards.length} chargées`;

        headingWrap.append(title, subtitle);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'wm-pack-recap-close';
        close.textContent = '×';
        close.setAttribute('aria-label', 'Fermer le récap');
        close.addEventListener('click', () => {
          packRecapDismissed = true;
          panel.remove();
        });

        header.append(headingWrap, close);

        const list = document.createElement('div');
        list.className = 'wm-pack-recap-list';

        let total = 0;
        let priced = 0;

        for (const card of activePackRecap.cards) {
          const rMeta = rarityMeta(card.rarity);
          const row = document.createElement('div');
          row.className = 'wm-pack-recap-row';

          const rarity = document.createElement('span');
          rarity.className = 'wm-pack-recap-rarity';
          rarity.style.color = rMeta.color;
          rarity.style.backgroundColor = rMeta.bg;
          rarity.style.borderColor = rMeta.border;
          rarity.textContent = rMeta.short;

          const name = document.createElement('span');
          name.className = 'wm-pack-recap-name';
          name.textContent = card.title;

          const value = document.createElement('span');
          value.className = 'wm-pack-recap-price';

          const cacheEntry = cacheMemory.get(card.id);
          if (!cacheEntry) {
            value.classList.add('is-loading');
            const spinner = document.createElement('span');
            spinner.className = 'wm-average-spinner';
            value.append(spinner, document.createTextNode('…'));
          } else {
            const average = chooseAverage(cacheEntry, null, card.rarity || null);
            if (Number.isFinite(average)) {
              total += average;
              priced += 1;
              value.textContent = `${formatAverage(average)} W`;
            } else {
              value.textContent = '—';
              value.classList.add('is-empty');
            }
          }

          row.append(rarity, name, value);
          list.append(row);
        }

        const footer = document.createElement('div');
        footer.className = 'wm-pack-recap-footer';

        if (loaded < activePackRecap.cards.length) {
          footer.textContent = 'Chargement des prix moyens…';
        } else if (priced === 0) {
          footer.textContent = 'Aucune carte n’a de prix moyen';
        } else {
          footer.textContent = `Total des prix moyens connus : ${formatAverage(total)} W`;
        }

        panel.append(header, list, footer);

        if (!existing) {
          document.body.append(panel);
        }
      }

      function handlePackOpened(cards) {
        if (!Array.isArray(cards) || !cards.length) return;

        runtime.pullStats.recordPullStats(cards);
        mergePulledCardsIntoCollectionCache(cards);

        runtime.priceLoader.loadCacheForCards(cards);

        if (!runtime.settings.isEnabled('packRecap')) return;

        activePackRecap = {
          openedAt: Date.now(),
          cards
        };
        packRecapDismissed = false;

        try {
          renderPackRecap();
        } catch (error) {
          reportError('paquet', error);
        }
      }

      document.addEventListener('click', (event) => {
        if (!isPullsPage() || !activePackRecap) return;

        const button = event.target?.closest?.('button');
        if (!button) return;

        if (button.parentElement?.querySelector('input[name="website"]')) {
          packRecapDismissed = true;
          document.getElementById('wm-pack-recap')?.remove();
        }
      }, true);

      window.addEventListener('wm-average-open-all-packs-progress', (event) => {
        const detail = event.detail || {};
        if (!openAllActive || detail.requestId !== openAllRequestId) return;

        openAllOpenedPacks = Number(detail.openedPacks) || 0;

        if (detail.waiting) {
          setOpenAllButtonWaiting(detail.waitMs);
          if (openAllIsManual) {
            updateLiveOpeningProgress({
              openedPacks: openAllOpenedPacks,
              packsRemaining: detail.packsRemaining,
              waiting: true,
              waitMs: detail.waitMs
            });
          }
          return;
        }

        setOpenAllButtonProgress(openAllOpenedPacks, detail.packsRemaining);

        const packCards = Array.isArray(detail.cards) ? detail.cards : [];
        if (!packCards.length) return;

        runtime.pullStats.recordPullStats(packCards);
        openAllSummaryCards.push(...packCards);
        mergePulledCardsIntoCollectionCache(packCards);

        if (openAllIsManual) {
          updateLiveOpeningProgress({
            openedPacks: openAllOpenedPacks,
            packsRemaining: detail.packsRemaining,
            waiting: false
          });
          updateLiveOpeningCards(packCards);
        }

        const uniquePackCards = [...new Map(packCards.map((card) => [card.id, card])).values()];
        try {
          runtime.priceLoader.loadCacheForCards(uniquePackCards);
        } catch (error) {
          reportError('prix pendant tout ouvrir', error);
        }
      });

      window.addEventListener('wm-average-pack-verification-needed', (event) => {
        if (event.detail?.requestId === openAllRequestId && openAllButton?.isConnected) {
          openAllButton.textContent = 'Vérification en attente…';
          if (openAllLiveOverlay) {
            const statusPill = openAllLiveOverlay.querySelector('[data-role="status-pill"]');
            if (statusPill) {
              statusPill.innerHTML = '<span class="wm-live-status-icon">🛡️</span> <span class="wm-live-status-text">Vérification demandée par WikiMasters…</span>';
            }
          }
        }
      });

      window.addEventListener('wm-average-open-all-packs-result', (event) => {
        const detail = event.detail || {};
        if (!openAllActive || detail.requestId !== openAllRequestId) return;

        const wasAutomatic = Boolean(autoOpenRequestId && detail.requestId === autoOpenRequestId);

        openAllActive = false;
        openAllRequestId = null;
        document.getElementById('wm-open-all-live')?.remove();
        openAllLiveOverlay = null;

        if (openAllProgress) {
          openAllProgress.hidden = true;
        }

        if (openAllButton?.isConnected) {
          openAllButton.disabled = false;
          openAllButton.textContent = 'Tout ouvrir';
        }

        const cards = Array.isArray(detail.cards) ? detail.cards : [];
        const openedPacks = Number(detail.openedPacks) || 0;

        if (wasAutomatic) {
          autoOpenRequestId = null;

          appendAutomaticOpenResult(detail);
          document.getElementById('wm-open-all-overlay')?.remove();
          document.getElementById('wm-pack-recap')?.remove();
          openAllSummaryCards = [];
          openAllError = null;

          if (autoOpenShowSummaryAfterCurrent || !autoOpenEnabled) {
            autoOpenShowSummaryAfterCurrent = false;
            showAutomaticOpenSummary();
          } else {
            scheduleNextAutoOpen({ keepExisting: false });
          }
          return;
        }

        if (!cards.length) {
          runtime.modalUi.showInfoModal(
            detail.ok ? 'Aucun paquet ouvert' : 'Ouverture impossible',
            detail.error || 'Aucun paquet disponible.'
          );
          return;
        }

        openOpenAllSummary(
          cards,
          openedPacks,
          detail.ok ? null : `Ouverture interrompue : ${detail.error || 'erreur inconnue'}`
        );
      });

      window.addEventListener('wm-average-pack-opened', (event) => {
        const cards = event.detail?.cards;
        if (!Array.isArray(cards) || !cards.length) return;
        handlePackOpened(cards);
      });

      function onPriceUpdated(id) {
        if (activePackRecap?.cards?.some((card) => card.id === id)) renderPackRecap();
        if (openAllSummaryCards.some((card) => card.id === id)) {
          scheduleOpenAllSummaryRender();
          if (openAllLiveOverlay) {
            const cardEl = openAllLiveOverlay.querySelector(`[data-role="cards-deck"]`);
            if (cardEl) {
              const entry = cacheMemory.get(id);
              if (entry) {
                const knownSum = openAllSummaryCards.reduce((sum, card) => {
                  const e = cacheMemory.get(card.id);
                  const avg = e ? chooseAverage(e, null, card.rarity || null) : null;
                  return sum + (Number.isFinite(avg) ? avg : 0);
                }, 0);
                const statValue = openAllLiveOverlay.querySelector('[data-role="stat-value"]');
                const statValuePill = openAllLiveOverlay.querySelector('[data-role="stat-value-pill"]');
                if (knownSum > 0 && statValue && statValuePill) {
                  statValue.textContent = `${formatAverage(Math.round(knownSum))} W`;
                  statValuePill.style.display = 'inline-flex';
                }
              }
            }
          }
        }
      }

      function isAutoOpenEnabled() {
        return runtime.settings.isEnabled('autoOpen') && autoOpenEnabled;
      }

      return {
        ensurePullsToolbar, updateAutoOpenToggleUi, renderPackRecap,
        restoreAcknowledgedConsent, scheduleNextAutoOpen, onPriceUpdated,
        isAutoOpenEnabled
      };
    }
  };
})();
