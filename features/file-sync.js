(() => {
  const registry = window.__wmAverageFeatures ||= {};
  registry.fileSync = {
    create(runtime) {
      const model = globalThis.WMFileSyncModel;
      const core = runtime.core;
      const STATE_KEY = 'wm_file_sync_state_v1';
      const BACKUP_KEY = 'wm_file_sync_original_stats_v1';
      const PREFIX = 'wm_avg_v3_';
      let state = core.readLocalValue(STATE_KEY);
      let folder = null, timer, debounce, applying = false, tail = Promise.resolve();
      let status = 'Non configurée', ignored = 0, remembered = true;
      let enabled = state?.enabled === true;
      try {
        if (!model.UUID.test(state?.writer)) throw new Error('Nouvelle session');
        state.pulls = model.mergePulls(state.pulls);
      } catch {
        const legacy = core.readLocalValue(core.PULL_STATS_KEY);
        const writer = crypto.randomUUID();
        state = { version: 1, writer, pulls: model.emptyPulls(), projection: model.counts(legacy?.counts), enabled: false };
        state.pulls.sources[writer] = model.counts(legacy?.counts);
        if (legacy && core.readLocalValue(BACKUP_KEY) === undefined) core.writeLocalValue(BACKUP_KEY, legacy);
        enabled = false;
      }
      // An older installed version may have recorded pulls since this metadata
      // was last written. Absorb only that local delta, never an imported total.
      const current = model.counts(core.readLocalValue(core.PULL_STATS_KEY)?.counts);
      const previous = model.counts(state.projection);
      if (model.RARITIES.some(rarity => current[rarity] < previous[rarity])) {
        state.pulls = { epoch: { time: Math.max(Date.now(), state.pulls.epoch.time + 1), id: crypto.randomUUID() }, sources: {} };
        state.pulls.sources[state.writer] = current;
      } else {
        const own = state.pulls.sources[state.writer] ||= model.counts();
        for (const rarity of model.RARITIES) own[rarity] += current[rarity] - previous[rarity];
      }
      state.projection = model.totals(state.pulls);
      persist();

      function persist() {
        state.enabled = enabled;
        state.projection = model.totals(state.pulls);
        core.writeLocalValue(STATE_KEY, state);
        core.writeLocalValue(core.PULL_STATS_KEY, { counts: state.projection, updatedAt: Date.now() });
      }
      function reloadState() {
        const latest = core.readLocalValue(STATE_KEY);
        if (latest?.writer === state.writer) {
          try { state.pulls = model.mergePulls(state.pulls, latest.pulls); } catch { /* Keep valid in-memory state. */ }
        }
      }
      function serial(action) {
        const run = () => navigator.locks?.request
          ? navigator.locks.request(`wm-file-sync-${state.writer}`, async () => { reloadState(); return action(); })
          : action();
        const work = tail.then(run, run);
        tail = work.catch(() => {});
        return work;
      }
      function setStatus(value) {
        status = value;
        const label = document.getElementById('wm-file-sync-status');
        if (label) label.textContent = status;
        updateDialogControls();
        const button = document.getElementById('wm-file-sync-launch');
        if (button) button.title = `Synchronisation des prix et statistiques : ${status}`;
      }
      async function handleStorage(mode, handle) {
        if (typeof indexedDB === 'undefined') throw new Error('Stockage du dossier indisponible');
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('wm-file-sync-handles-v1', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('handles');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise((resolve, reject) => {
            const transaction = db.transaction('handles', mode === 'get' ? 'readonly' : 'readwrite');
            const store = transaction.objectStore('handles');
            const request = mode === 'get' ? store.get('folder') : store.put(handle, 'folder');
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
          });
        } finally { db.close(); }
      }
      function snapshotPrices() {
        const prices = {};
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (key?.startsWith(PREFIX)) prices[key.slice(PREFIX.length)] = core.readLocalValue(key);
        }
        return model.mergePrices(prices, Object.fromEntries(core.cacheMemory));
      }
      function applyData(data) {
        state.pulls = model.mergePulls(state.pulls, data.pulls);
        applying = true;
        try {
          for (const [id, entry] of Object.entries(model.mergePrices(snapshotPrices(), data.prices))) {
            const old = model.price(core.cacheMemory.get(id) || core.readLocalValue(PREFIX + id));
            if (JSON.stringify(old) === JSON.stringify(entry)) continue;
            core.cacheMemory.set(id, entry);
            core.writeLocalValue(PREFIX + id, entry);
            window.dispatchEvent(new CustomEvent('wm-average-observed-price', { detail: { id, ...entry } }));
          }
          persist();
        } finally { applying = false; }
        runtime.pullStats?.renderPullStats();
      }
      function exportDocument() { return model.document(state.writer, snapshotPrices(), state.pulls); }
      async function importDocuments(raws) {
        return serial(async () => {
          // Validate every selection first; a failed import leaves current data intact.
          const documents = raws.map(model.readDocument);
          const data = { prices: model.mergePrices(...documents.map(doc => doc.prices)), pulls: model.mergePulls(...documents.map(doc => doc.pulls)) };
          model.totals(model.mergePulls(state.pulls, data.pulls));
          applyData(data); schedule();
          return exportDocument();
        });
      }
      async function syncNow() {
        return serial(async () => {
          if (!folder || !enabled) return;
          const activeFolder = folder;
          if (await activeFolder.queryPermission({ mode: 'readwrite' }) !== 'granted') {
            setStatus('Autorisation du dossier requise — cliquer sur Réautoriser'); return;
          }
          setStatus('Synchronisation…'); ignored = 0;
          const ownName = `wm-sync-${state.writer}.json`;
          let ownContents = null;
          let data = { prices: snapshotPrices(), pulls: model.mergePulls(state.pulls) };
          for await (const handle of activeFolder.values()) {
            if (handle.kind !== 'file' || !handle.name.startsWith('wm-sync-') || !handle.name.endsWith('.json')) continue;
            try {
              const file = await handle.getFile();
              if (file.size > 50 * 1024 * 1024) throw new Error('Fichier trop volumineux');
              const contents = await file.text();
              const document = model.readDocument(JSON.parse(contents));
              if (handle.name === ownName) ownContents = contents;
              const mergedPulls = model.mergePulls(data.pulls, document.pulls);
              model.totals(mergedPulls);
              data = { prices: model.mergePrices(data.prices, document.prices), pulls: mergedPulls };
            } catch (error) {
              if (handle.name === ownName) throw new Error('Votre fichier est illisible : il a été conservé sans modification');
              ignored++;
            }
          }
          if (!enabled || folder !== activeFolder) return;
          applyData(data);
          const text = JSON.stringify(exportDocument(), null, 2) + '\n';
          // Compare with disk, including after reload or external deletion/rollback.
          if (text !== ownContents) {
            const file = await activeFolder.getFileHandle(ownName, { create: true });
            const writable = await file.createWritable();
            try { await writable.write(text); await writable.close(); }
            catch (error) { await writable.abort().catch(() => {}); throw error; }
          }
          setStatus(`Synchronisée à ${new Date().toLocaleTimeString('fr-FR')}${ignored ? ` · ${ignored} fichier(s) ignoré(s)` : ''}${remembered ? '' : ' · dossier à choisir après rechargement'}`);
        }).catch(error => { setStatus(`Sync interrompue : ${error.message}`); throw error; });
      }
      function schedule() {
        if (!folder || !enabled || applying) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => syncNow().catch(() => {}), 1500);
      }
      function startTimer() {
        clearInterval(timer);
        timer = setInterval(() => { if (enabled && folder && !document.hidden) syncNow().catch(() => {}); }, 30000);
      }
      async function connect() {
        if (typeof window.showDirectoryPicker !== 'function') throw new Error('Le choix de dossier nécessite Chrome ou Edge sur ordinateur. Export/import reste disponible.');
        // Call before any await: the native picker requires this click's activation.
        const picked = await window.showDirectoryPicker({ id: 'wikimasters-sync', mode: 'readwrite' });
        folder = picked; enabled = true; remembered = true; persist();
        try { await handleStorage('put', picked); }
        catch { remembered = false; }
        startTimer(); await syncNow();
      }
      async function reauthorize() {
        if (!folder) return connect();
        const permission = await folder.requestPermission({ mode: 'readwrite' });
        if (permission !== 'granted') throw new Error('Autorisation refusée ; données du navigateur conservées');
        enabled = true; persist(); startTimer(); await syncNow();
      }
      function disconnect() {
        enabled = false; clearInterval(timer); clearTimeout(debounce); persist(); setStatus('Désactivée — données conservées');
      }
      async function recordPulls(cards) {
        return serial(async () => {
          const own = state.pulls.sources[state.writer] ||= model.counts();
          for (const card of cards) if (model.RARITIES.includes(card?.rarity)) own[card.rarity]++;
          persist(); schedule(); runtime.pullStats?.renderPullStats();
        });
      }
      async function resetPullStats() {
        return serial(async () => {
          state.pulls = { epoch: { time: Math.max(Date.now(), state.pulls.epoch.time + 1), id: crypto.randomUUID() }, sources: {} };
          persist(); schedule(); runtime.pullStats?.renderPullStats();
        });
      }
      function openDialog() {
        if (document.getElementById('wm-file-sync-dialog')) return;
        const overlay = document.createElement('div'); overlay.className = 'wm-modal-overlay'; overlay.id = 'wm-file-sync-dialog';
        const modal = document.createElement('div'); modal.className = 'wm-modal wm-file-sync-modal';
        const heading = document.createElement('h2'); heading.textContent = 'Synchronisation locale';
        const text = document.createElement('p');
        text.textContent = 'Choisis un dossier dédié dans Google Drive sur chaque ordinateur. Utilise le même dossier pour le même compte WikiMasters, et un dossier différent pour chaque compte. Tes prix et statistiques actuels sont conservés et ajoutés automatiquement. Google Drive doit être installé et synchroniser ce dossier local.';
        const note = document.createElement('p'); note.textContent = 'La synchronisation fonctionne pendant que WikiMasters est ouvert. Seuls les prix et statistiques de tirage sont partagés.';
        const label = document.createElement('p'); label.id = 'wm-file-sync-status'; label.textContent = status;
        const actions = document.createElement('div'); actions.className = 'wm-modal-actions wm-file-sync-actions';
        const button = (name, action, host = actions) => {
          const element = document.createElement('button'); element.type = 'button'; element.className = 'wm-tool-button'; element.textContent = name;
          element.addEventListener('click', () => {
            try { Promise.resolve(action()).catch(error => { if (error.name !== 'AbortError') setStatus(error.message); }); }
            catch (error) { setStatus(error.message); }
          }); host.append(element); return element;
        };
        button('Choisir un dossier', connect).dataset.syncAction = 'folder';
        button('Réautoriser', reauthorize).dataset.syncAction = 'permission';
        button('Synchroniser maintenant', syncNow).dataset.syncAction = 'sync';
        button('Désactiver', disconnect).dataset.syncAction = 'disconnect';
        const backups = document.createElement('details'); backups.className = 'wm-sync-backups';
        const backupsTitle = document.createElement('summary'); backupsTitle.textContent = 'Sauvegardes manuelles';
        const backupActions = document.createElement('div'); backupActions.className = 'wm-file-sync-actions';
        backups.append(backupsTitle, backupActions);
        button('Exporter une sauvegarde', () => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(exportDocument(), null, 2)], { type: 'application/json' }));
          const link = document.createElement('a'); link.href = url; link.download = `wm-sync-${state.writer}.json`; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        }, backupActions);
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.multiple = true; input.hidden = true;
        input.addEventListener('change', async () => {
          try {
            const raw = await Promise.all([...input.files].map(async file => {
              if (file.size > 50 * 1024 * 1024) throw new Error('Fichier trop volumineux');
              return JSON.parse(await file.text());
            }));
            await importDocuments(raw); setStatus('Sauvegarde importée — données fusionnées');
          } catch (error) { setStatus(`Import refusé : ${error.message}`); }
          input.value = '';
        });
        button('Importer une sauvegarde', () => input.click(), backupActions);
        const footer = document.createElement('div'); footer.className = 'wm-modal-actions'; button('Fermer', () => overlay.remove(), footer);
        modal.append(heading, text, note, label, actions, backups, input, footer); overlay.append(modal); document.body.append(overlay); updateDialogControls();
      }
      function updateDialogControls() {
        const panel = document.getElementById('wm-file-sync-dialog'); if (!panel) return;
        const choose = panel.querySelector('[data-sync-action="folder"]');
        if (choose) choose.textContent = folder ? 'Changer le dossier' : 'Choisir un dossier';
        const permission = panel.querySelector('[data-sync-action="permission"]');
        if (permission) permission.hidden = !folder || (enabled && !/autorisation|autoriser|permission/i.test(status));
        const sync = panel.querySelector('[data-sync-action="sync"]'); if (sync) sync.hidden = !enabled || !folder;
        const disable = panel.querySelector('[data-sync-action="disconnect"]'); if (disable) disable.hidden = !enabled;
      }
      function ensureButton() {
        const host = document.querySelector('.wm-workspace-toolbar .wm-tools-menu') || document.getElementById('wm-tools-bar') || document.getElementById('wm-pulls-info') || document.getElementById('wm-settings-currency-slot');
        if (!host) return;
        let button = document.getElementById('wm-file-sync-launch');
        if (!button) {
          button = document.createElement('button'); button.type = 'button'; button.id = 'wm-file-sync-launch'; button.className = 'wm-tool-button';
          button.textContent = 'Synchronisation'; button.addEventListener('click', openDialog);
        }
        if (button.parentElement !== host) host.append(button);
        button.title = `Synchronisation des prix et statistiques : ${status}`;
      }
      window.addEventListener('wm-file-sync-local-change', schedule);
      window.addEventListener('wm-average-response', event => { if (event.detail?.ok) schedule(); });
      window.addEventListener('storage', event => {
        if (event.key?.startsWith(PREFIX) || event.key === STATE_KEY) {
          reloadState(); runtime.pullStats?.renderPullStats(); schedule();
        }
      });
      document.addEventListener('visibilitychange', () => { if (!document.hidden && enabled && folder) syncNow().catch(() => {}); });
      if (enabled) handleStorage('get').then(async stored => {
        folder = stored || null;
        if (folder) { startTimer(); await syncNow(); }
        else setStatus('Choisir à nouveau le dossier de synchronisation');
      }).catch(() => setStatus('Choisir à nouveau le dossier de synchronisation'));
      return { recordPulls, resetPullStats, ensureButton, openDialog, connect, reauthorize, disconnect, syncNow,
        exportDocument, importDocuments, getStatus: () => status };
    }
  };
})();
