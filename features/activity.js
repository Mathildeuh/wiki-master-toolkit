(() => {
  const registry = window.__wmAverageFeatures ||= {};
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const WATCH_KEY = 'wm_auction_watchlist_v1';
  const SB_ORIGIN = 'https://cyrxjeppjqsxxjayfrur.supabase.co';
  registry.activity = {
    create(runtime) {
      const core = runtime.core;
      let marketDialog, achievementsDialog, checking = null, claiming = false;
      const money = n => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(n);
      const element = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
      };
      function button(text, action, className = '') {
        const node = element('button', 'wm-tool-button ' + className, text);
        node.type = 'button'; node.addEventListener('click', action); return node;
      }
      async function request(url, options = {}) {
        const pause = core.readLocalValue('wm_atlas_price_pause_v1');
        if (pause?.until > Date.now()) throw new Error(`${pause.label || 'Pause serveur'} · réessaie après ${new Date(pause.until).toLocaleTimeString('fr-FR')}.`);
        let response;
        try {
          response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(45000), ...options });
        } catch (error) {
          throw new Error(error.name === 'TimeoutError' ? 'Le serveur tarde à répondre. Réessaie avec Actualiser.' : 'Erreur réseau. Réessaie avec Actualiser.');
        }
        const json = await response.json().catch(() => null);
        if (!response.ok) {
          if ([401, 403, 429].includes(response.status)) {
            const raw = response.headers.get('Retry-After');
            const retry = raw && Number.isFinite(Number(raw)) ? Number(raw) * 1000 : Date.parse(raw || '') - Date.now();
            core.writeLocalValue('wm_atlas_price_pause_v1', { until: Date.now() + Math.max(120000, retry || 0), label: `Erreur API ${response.status}` });
          }
          throw new Error(`Erreur API ${response.status}${typeof json?.error === 'string' ? ' · ' + json.error.slice(0, 200) : ''}`);
        }
        if (!json || json.ok === false) throw new Error('Réponse du serveur invalide.');
        return json;
      }
      function auctionId(input) {
        const value = String(input || '').trim();
        if (UUID.test(value)) return value.toLowerCase();
        let url;
        try { url = new URL(value); } catch { throw new Error('Colle le lien WikiMasters de cette enchère.'); }
        const id = url.pathname.match(/^\/marketplace\/([0-9a-f-]{36})\/?$/i)?.[1];
        if (url.origin !== location.origin || !UUID.test(id || '')) throw new Error('Lien attendu : https://www.wiki-masters.com/marketplace/…');
        return id.toLowerCase();
      }
      function normalizeAuction(raw) {
        if (!UUID.test(raw?.id || '') || !UUID.test(raw?.card_id || raw?.card?.id || '')) throw new Error('Données d’enchère incomplètes.');
        const finite = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
        return {
          id: raw.id, cardId: raw.card_id || raw.card.id, title: raw.card?.wikipedia_title || raw.snapshot_title || 'Carte',
          rarity: raw.snapshot_rarity || raw.card?.rarity || '', imageUrl: raw.card?.image_url || null,
          amount: finite(raw.final_price) ?? finite(raw.effective_bid) ?? finite(raw.current_bid) ?? finite(raw.base_amount),
          hasBid: raw.current_bid != null, bidder: raw.current_bidder?.username || raw.current_bidder?.display_name || null,
          endAt: raw.end_at, status: raw.status || 'unknown', shiny: raw.is_shiny === true
        };
      }
      function readWatchlist() {
        const stored = core.readLocalValue(WATCH_KEY);
        return Array.isArray(stored) ? stored.filter(row => UUID.test(row?.id || '')).slice(0, 50) : [];
      }
      function saveWatchlist(rows) { core.writeLocalValue(WATCH_KEY, rows); }
      async function follow(input) {
        const id = auctionId(input), watched = readWatchlist();
        if (watched.some(row => row.id === id)) return id;
        if (watched.length >= 50) throw new Error('50 enchères suivies. Retire une ancienne enchère avant d’en ajouter une.');
        const data = await request('/api/marketplace/' + id);
        const row = normalizeAuction(data.auction);
        if (row.id.toLowerCase() !== id) throw new Error('Le serveur a renvoyé une autre enchère.');
        // Read again after the GET so another tab's additions are retained.
        const latest = readWatchlist();
        if (!latest.some(item => item.id === id)) saveWatchlist([...latest, { ...row, addedAt: Date.now() }]);
        renderDetailFollow(); return id;
      }
      function unfollow(id) { saveWatchlist(readWatchlist().filter(row => row.id !== id)); renderDetailFollow(); }
      async function mapLimited(rows, job) {
        const results = new Array(rows.length); let index = 0;
        await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
          while (index < rows.length) { const at = index++; results[at] = await job(rows[at]); }
        })); return results;
      }
      async function loadMarket() {
        const mine = await request('/api/marketplace?page=1&limit=50&sort=recent&mine=1');
        if (!['selling', 'bidding', 'won'].every(key => Array.isArray(mine[key]))) throw new Error('Activité du marché incomplète.');
        const selling = mine.selling.map(normalizeAuction), bidding = mine.bidding.map(normalizeAuction), won = mine.won.slice(0, 15).map(normalizeAuction);
        const byId = new Map([...selling, ...bidding, ...won].map(row => [row.id, row]));
        const watched = await mapLimited(readWatchlist(), async saved => {
          if (byId.has(saved.id)) return { ...saved, ...byId.get(saved.id), error: null };
          try { return { ...saved, ...normalizeAuction((await request('/api/marketplace/' + saved.id)).auction), error: null }; }
          catch (error) { return { ...saved, error: error.message }; }
        });
        // Preserve watchlist changes made while requests were in flight.
        const updates = new Map(watched.map(row => [row.id, row]));
        saveWatchlist(readWatchlist().map(row => updates.get(row.id) || row));
        return { selling, bidding, won, watched, max: mine.maxConcurrentAuctions, fetchedAt: Date.now() };
      }
      function price(row) {
        const key = core.cacheKey(row.cardId), stored = core.readLocalValue(key), memory = core.cacheMemory.get(row.cardId);
        const hit = stored?.ok === true && (!memory || stored.fetchedAt >= memory.fetchedAt) ? stored : memory;
        const status = runtime.priceLoader.getStatus(row.cardId);
        const raw = hit?.ok === true ? hit.averages?.[row.rarity] : undefined;
        const value = raw != null && raw !== '' && typeof raw !== 'boolean' && Number.isFinite(Number(raw)) ? Number(raw) : null;
        return { text: hit?.ok === true ? value == null ? 'Moy. —' : `Moy. ${money(value)} W` : 'Moyenne indisponible',
          status: status || (hit?.ok !== true ? 'Non chargée' : value == null ? 'Aucune vente pour cette rareté' : ''), fetchedAt: hit?.fetchedAt };
      }
      function timeLeft(row) {
        if (!row.endAt || !Number.isFinite(Date.parse(row.endAt))) return 'Durée inconnue';
        const seconds = Math.ceil((Date.parse(row.endAt) - Date.now()) / 1000);
        if (seconds <= 0 || row.status !== 'active') return row.status === 'settled_sold' ? 'Vendue' : 'Terminée';
        const minutes = Math.ceil(seconds / 60);
        return minutes < 60 ? `Fin dans ${minutes} min` : `Fin dans ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
      }
      function thumbnail(row) {
        const thumb = element('span', 'wm-activity-thumb', row.rarity || 'WM');
        if (row.imageUrl) {
          try {
            const url = new URL(row.imageUrl, location.href);
            if (!['https:', 'data:'].includes(url.protocol)) return thumb;
            const image = element('img'); image.src = url.href; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
            image.addEventListener('error', () => image.remove(), { once: true }); thumb.append(image);
          } catch { /* The rarity remains as an image fallback. */ }
        } return thumb;
      }
      function auctionRow(row, kind) {
        const card = element('article', 'wm-activity-row');
        const link = element('a', 'wm-activity-name', row.title); link.href = '/marketplace/' + row.id; link.target = '_blank'; link.rel = 'noopener';
        const info = element('div', 'wm-activity-info');
        const meta = element('div', 'wm-activity-meta'); meta.append(element('span', 'wm-rarity-chip', row.rarity + (row.shiny ? ' ✦' : '')), element('span', '', timeLeft(row)));
        info.append(link, meta, element('small', row.error ? 'wm-activity-error' : 'wm-muted', row.error || (kind === 'won' ? 'Remportée' : row.hasBid ? row.bidder ? `Enchère de ${row.bidder}` : 'Une enchère a été placée' : 'Aucune enchère')));
        const values = element('div', 'wm-activity-values');
        values.append(element('strong', '', row.amount == null ? '— W' : money(row.amount) + ' W'));
        const average = element('span', 'wm-activity-average'); average.dataset.cardId = row.cardId; average.dataset.rarity = row.rarity;
        const amount = element('span'), status = element('small'); average.append(amount, status);
        const update = () => { const p = price(row); amount.textContent = p.text; status.textContent = p.status; average.title = p.fetchedAt ? 'Prix enregistré le ' + new Date(p.fetchedAt).toLocaleString('fr-FR') : 'La moyenne n’est pas encore chargée'; };
        update(); average.updatePrice = update;
        values.append(average); card.append(thumbnail(row), info, values);
        if (kind === 'watched') {
          const remove = button('Retirer', () => { unfollow(row.id); card.remove(); marketDialog?.refreshWatchCount(); }, 'wm-quiet-button');
          remove.setAttribute('aria-label', 'Ne plus suivre ' + row.title); card.append(remove);
        } return card;
      }
      function section(title, rows, kind, empty) {
        const box = element('section', 'wm-activity-section');
        const heading = element('div', 'wm-section-heading'); heading.append(element('h3', '', title), element('span', 'wm-count', String(rows.length))); box.append(heading);
        if (!rows.length) box.append(element('p', 'wm-empty-state', empty));
        for (const row of rows) box.append(auctionRow(row, kind)); return box;
      }
      function createDialog(id, title, subtitle) {
        const existing = document.getElementById(id);
        if (existing) { existing.querySelector('.wm-modal')?.focus(); return null; }
        const overlay = element('div', 'wm-modal-overlay'); overlay.id = id;
        const modal = element('div', 'wm-modal wm-activity-modal');
        const header = element('header', 'wm-dialog-header'), copy = element('div');
        copy.append(element('span', 'wm-eyebrow', 'ACTIVITÉ DU MARCHÉ'), element('h2', '', title), element('p', 'wm-muted', subtitle));
        const close = button('×', () => overlay.remove(), 'wm-dialog-close'); close.setAttribute('aria-label', 'Fermer');
        header.append(copy, close); const body = element('div', 'wm-dialog-body'); modal.append(header, body); overlay.append(modal); document.body.append(overlay);
        return { overlay, modal, header, body };
      }
      function openMarket() {
        const dialog = createDialog('wm-market-activity', 'Mes enchères', 'Ventes, enchères placées et liens suivis au même endroit.');
        if (!dialog) return;
        marketDialog = dialog;
        const actions = element('div', 'wm-activity-actions'), updated = element('p', 'wm-activity-status'); updated.setAttribute('role', 'status');
        const refresh = button('Actualiser', run, 'wm-primary-button'); refresh.id = 'wm-market-refresh';
        const marketLink = element('a', 'wm-text-link', 'Ouvrir le marché ↗'); marketLink.href = '/marketplace'; marketLink.target = '_blank'; marketLink.rel = 'noopener';
        actions.append(refresh, marketLink); const form = element('form', 'wm-watch-form');
        const label = element('label', '', 'Suivre une enchère sans miser'); label.htmlFor = 'wm-watch-url';
        const input = element('input'); input.id = 'wm-watch-url'; input.type = 'url'; input.placeholder = 'https://www.wiki-masters.com/marketplace/…'; input.required = true;
        const add = element('button', 'wm-tool-button', 'Suivre'); add.type = 'submit'; const error = element('p', 'wm-activity-error'); error.setAttribute('role', 'alert');
        const field = element('div', 'wm-watch-field'); field.append(input, add); form.append(label, field, error);
        const content = element('div', 'wm-market-content'); dialog.body.append(actions, updated, form, content);
        dialog.refreshWatchCount = () => { const node = content.querySelector('[data-watch-count]'); if (node) node.textContent = String(readWatchlist().length); };
        let busy = false;
        form.addEventListener('submit', async event => {
          event.preventDefault(); if (busy) return; add.disabled = true; error.textContent = 'Ajout…';
          try { await follow(input.value); input.value = ''; error.textContent = ''; await run(); } catch (e) { error.textContent = e.message; }
          finally { add.disabled = false; }
        });
        async function run() {
          if (busy || !dialog.overlay.isConnected) return;
          const refreshStartedAt = Date.now();
          busy = true; refresh.disabled = true; add.disabled = true; updated.textContent = 'Chargement des enchères…';
          try {
            const data = await loadMarket(); if (!dialog.overlay.isConnected) return;
            const grid = element('div', 'wm-market-grid');
            grid.append(section(`Ventes en cours${data.max ? ' · ' + data.selling.length + '/' + data.max : ''}`, data.selling, 'selling', 'Aucune vente en cours.'), section('Mes enchères placées', data.bidding, 'bidding', 'Aucune enchère placée. Ajoute un lien pour suivre sans miser.'));
            const watched = section('Enchères suivies', data.watched, 'watched', 'Colle le lien d’une enchère pour la retrouver ici.'); watched.querySelector('.wm-count').dataset.watchCount = '1';
            content.replaceChildren(grid, watched, section('Gagnées récemment', data.won, 'won', 'Aucune enchère gagnée récemment.'));
            dialog.refreshedAt = Date.now();
            dialog.priceIds = new Set([...data.selling, ...data.bidding, ...data.watched, ...data.won].filter(row => row.cardId).map(row => row.cardId));
            const cards = [...new Map([...data.selling, ...data.bidding, ...data.watched, ...data.won].filter(row => row.cardId).map(row => [row.cardId, { ...core.cardMetaById.get(row.cardId), id: row.cardId, title: row.title, rarity: row.rarity, imageUrl: row.imageUrl }])).values()];
            // A native detail response can already start/load a fresh price while
            // the watch link is added. Reuse that work rather than issue it twice.
            const forceCardIds = new Set(cards.filter(row => !runtime.priceLoader.isPending(row.id) &&
              (runtime.priceLoader.getStatus(row.id) || (price({ cardId: row.id, rarity: row.rarity }).fetchedAt || 0) < refreshStartedAt - 1500)).map(row => row.id));
            runtime.priceLoader.loadCacheForCards(cards, { forceCardIds });
            dialog.updated = updated; updateMarketPrices();
          } catch (error) { if (dialog.overlay.isConnected) updated.textContent = error.message; }
          finally { busy = false; refresh.disabled = false; add.disabled = false; }
        }
        run();
      }
      function updateMarketPrices() {
        const dialog = marketDialog; if (!dialog?.overlay.isConnected) return;
        dialog.body.querySelectorAll('.wm-activity-average').forEach(node => node.updatePrice?.());
        if (!dialog.updated) return;
        const ids = [...dialog.priceIds], pending = ids.filter(id => runtime.priceLoader.isPending(id)).length;
        const errors = ids.filter(id => !runtime.priceLoader.isPending(id) && runtime.priceLoader.getStatus(id)).length;
        dialog.updated.textContent = `Enchères actualisées à ${new Date(dialog.refreshedAt).toLocaleTimeString('fr-FR')} · ${pending ? `${pending} moyenne${pending > 1 ? 's' : ''} en cours d’actualisation` : errors ? `${errors} erreur${errors > 1 ? 's' : ''} de prix · anciennes moyennes conservées` : 'moyennes actualisées'}.`;
      }
      function auth() {
        const template = window.__wmAverageBridgeRuntime?.core.getSupabaseRequestTemplate();
        const headers = new Headers(template?.headers || {}), token = headers.get('authorization'), key = headers.get('apikey');
        let uid;
        try { uid = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { /* Missing/expired site session is reported below. */ }
        if (!key || !UUID.test(uid || '') || new URL(template.url).origin !== SB_ORIGIN) throw new Error('Session WikiMasters indisponible. Ouvre la page Succès une fois, puis réessaie.');
        return { uid, headers: { apikey: key, authorization: token } };
      }
      async function readAchievements() {
        const session = auth();
        const [catalogue, unlocked] = await Promise.all([
          request(SB_ORIGIN + '/rest/v1/achievements?select=*&limit=1000', { credentials: 'omit', headers: session.headers }),
          request(SB_ORIGIN + '/rest/v1/user_achievements?select=*&user_id=eq.' + session.uid + '&limit=1000', { credentials: 'omit', headers: session.headers })
        ]);
        if (!Array.isArray(catalogue) || !Array.isArray(unlocked) || catalogue.length >= 1000 || unlocked.length >= 1000) throw new Error('Liste des succès incomplète.');
        const byId = new Map(catalogue.map(row => [row.id, row]));
        const claimable = [...new Map(unlocked.filter(row => row.claimed_at == null).map(row => [row.achievement_id, row])).values()].map(row => {
          const definition = byId.get(row.achievement_id);
          if (!definition || !UUID.test(row.achievement_id)) throw new Error('Succès inconnu dans la réponse du serveur.');
          return { id: row.achievement_id, title: definition.title, description: definition.description, icon: definition.icon || '★', reward: Number(definition.wikibidous_reward) || 0 };
        }).sort((a, b) => b.reward - a.reward);
        return { claimable, unlocked: unlocked.length, total: catalogue.length, reward: claimable.reduce((sum, row) => sum + row.reward, 0), fetchedAt: Date.now() };
      }
      async function checkAchievements(progress = () => {}) {
        if (checking) { progress('Vérification déjà en cours sur le serveur…'); return checking; }
        checking = (async () => {
          auth(); progress('Recherche de nouveaux succès sur le serveur…');
          await request('/api/achievements/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'achievements_sync' }) });
          progress('Lecture des récompenses après vérification…');
          return readAchievements();
        })();
        try { return await checking; } finally { checking = null; }
      }
      async function claimAll(progress = () => {}) {
        if (claiming) throw new Error('Une réclamation est déjà en cours.');
        const execute = async () => {
          claiming = true; const result = { claimed: 0, gained: 0, already: 0, error: null };
          try {
            const data = await checkAchievements(progress);
            for (const [index, row] of data.claimable.entries()) {
              progress(`Réclamation ${index + 1}/${data.claimable.length} · ${row.title}`);
              const response = await request('/api/achievements/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ achievement_id: row.id }) });
              if (response.already_claimed) result.already++;
              else if (response.claimed_at) {
                result.claimed++; result.gained += Number(response.amount) || 0;
                window.dispatchEvent(new CustomEvent('wikimasters:wikibidous-balance-refresh'));
              }
              else throw new Error('Réponse de réclamation ambiguë. Actualise avant de réessayer.');
              if (index + 1 < data.claimable.length) await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch (error) { result.error = error.message; }
          finally { claiming = false; }
          return result;
        };
        if (navigator.locks?.request) return navigator.locks.request('wm-achievements-claim', { ifAvailable: true }, lock => {
          if (!lock) throw new Error('Une autre page réclame déjà les succès.'); return execute();
        });
        return execute();
      }
      function openAchievements() {
        const dialog = createDialog('wm-achievements-panel', 'Succès', 'Vérifie les nouveaux succès, puis réclame tes récompenses en un clic.'); if (!dialog) return;
        achievementsDialog = dialog;
        const actions = element('div', 'wm-activity-actions'), status = element('p', 'wm-activity-status'); status.setAttribute('role', 'status');
        const refresh = button('Vérifier les nouveaux succès', verify, 'wm-primary-button'); refresh.id = 'wm-achievements-refresh';
        const claim = button('Tout réclamer', claimRewards); claim.id = 'wm-achievements-claim'; claim.disabled = true;
        const nativeLink = element('a', 'wm-text-link', 'Tous les succès ↗'); nativeLink.href = '/achievements'; nativeLink.target = '_blank'; nativeLink.rel = 'noopener';
        actions.append(refresh, claim, nativeLink);
        const summary = element('div', 'wm-achievement-summary'), list = element('div', 'wm-achievement-list'); dialog.body.append(actions, status, summary, list);
        let busy = false;
        const progress = text => { if (dialog.overlay.isConnected) status.textContent = text; };
        const setBusy = value => { busy = value; refresh.disabled = value; claim.disabled = true; dialog.modal.setAttribute('aria-busy', String(value)); };
        function render(data) {
          summary.textContent = `${data.unlocked}/${data.total} débloqués · ${data.claimable.length} à réclamer · +${money(data.reward)} W`;
          list.replaceChildren();
          if (!data.claimable.length) list.append(element('p', 'wm-empty-state', 'Tout est à jour. Aucun succès à réclamer.'));
          for (const row of data.claimable) {
            const item = element('article', 'wm-achievement-row'), info = element('div');
            info.append(element('strong', '', row.title), element('p', 'wm-muted', row.description));
            item.append(element('span', 'wm-achievement-icon', row.icon), info, element('strong', 'wm-achievement-reward', `+${money(row.reward)} W`)); list.append(item);
          }
          claim.textContent = data.claimable.length ? `Tout réclamer · +${money(data.reward)} W` : 'Tout réclamer'; claim.disabled = busy || !data.claimable.length;
        }
        async function verify() {
          if (busy) return; setBusy(true);
          try { const data = await checkAchievements(progress); if (!dialog.overlay.isConnected) return; setBusy(false); render(data); progress('Vérifié à ' + new Date(data.fetchedAt).toLocaleTimeString('fr-FR')); }
          catch (error) { setBusy(false); progress(error.message); }
        }
        async function claimRewards() {
          if (busy || claim.disabled) return; setBusy(true);
          const close = dialog.header.querySelector('.wm-dialog-close'); close.disabled = true;
          try {
            const result = await claimAll(progress);
            if (!dialog.overlay.isConnected) return;
            const message = `${result.claimed} succès réclamé${result.claimed > 1 ? 's' : ''} · +${money(result.gained)} W${result.already ? ` · ${result.already} déjà réclamé(s)` : ''}${result.error ? ' · ' + result.error : ''}`;
            // Reload the authoritative claim state even after a partial/ambiguous result.
            try { const data = await readAchievements(); setBusy(false); render(data); }
            catch { setBusy(false); list.replaceChildren(element('p', 'wm-empty-state', 'Actualise pour vérifier les récompenses restantes.')); }
            progress(message);
          } catch (error) { setBusy(false); progress(error.message); }
          finally { close.disabled = false; }
        }
        verify();
      }
      function renderDetailFollow() {
        const match = location.pathname.match(/^\/marketplace\/([0-9a-f-]{36})\/?$/i);
        const existing = document.getElementById('wm-follow-auction');
        if (!match) { existing?.remove(); return; }
        if (existing) { const text = readWatchlist().some(row => row.id === match[1]) ? 'Ne plus suivre' : 'Suivre sans miser'; if (existing.textContent !== text) existing.textContent = text; return; }
        const host = document.querySelector('main h1')?.parentElement || document.querySelector('main h2')?.parentElement;
        if (!host) return;
        const control = button('Suivre sans miser', async () => {
          if (control.disabled) return; control.disabled = true;
          try { const id = auctionId(location.href); if (readWatchlist().some(row => row.id === id)) unfollow(id); else await follow(id); renderDetailFollow(); }
          catch (error) { runtime.modalUi.showInfoModal('Suivi impossible', error.message); }
          finally { control.disabled = false; }
        }, 'wm-quiet-button'); control.id = 'wm-follow-auction'; host.append(control); renderDetailFollow();
      }
      for (const event of ['wm-average-response', 'wm-average-observed-price', 'wm-file-sync-local-change']) window.addEventListener(event, updateMarketPrices);
      window.addEventListener('storage', event => { if (event.key === WATCH_KEY) { renderDetailFollow(); marketDialog?.refreshWatchCount(); } });
      return { openMarket, openAchievements, renderDetailFollow, loadMarket, follow, unfollow, readWatchlist, auctionId, normalizeAuction, checkAchievements, claimAll, readAchievements };
    }
  };
})();
