(() => {
  const registry = window.__wmAverageFeatures ||= {};
  registry.workspaceUi = {
    create(runtime) {
      const core = runtime.core;
      const toolbarRoutes = ['/collection', '/pulls', '/global-collection', '/marketplace', '/achievements', '/trades', '/guild'];
      function hasToolbarRoute() { return toolbarRoutes.some(path => location.pathname === path || location.pathname.startsWith(path + '/')); }
      function updateRoute() { document.documentElement.classList.toggle('wm-has-toolbar-route', hasToolbarRoute()); }
      updateRoute();
      function action(id, label, run, className = '') {
        const button = document.createElement('button'); button.id = id; button.type = 'button';
        button.className = 'wm-tool-button ' + className; button.textContent = label; button.addEventListener('click', run); return button;
      }
      function options() {
        const details = document.createElement('details'); details.className = 'wm-tools-options';
        const summary = document.createElement('summary'); summary.textContent = 'Outils'; summary.setAttribute('aria-label', 'Autres outils de l’extension');
        const menu = document.createElement('div'); menu.className = 'wm-tools-menu';
        const sync = document.getElementById('wm-file-sync-launch') || action('wm-file-sync-launch', 'Synchronisation', () => { details.open = false; runtime.fileSync.openDialog(); }, 'wm-quiet-button');
        sync.textContent = 'Synchronisation'; sync.classList.add('wm-quiet-button');
        sync.addEventListener('click', () => { details.open = false; });
        sync.title = 'Synchroniser les prix et statistiques avec un dossier local';
        const settings = action('wm-toolbar-settings', 'Paramètres', () => { details.open = false; runtime.settings.openSettings(); }, 'wm-quiet-button');
        menu.append(sync, settings); details.append(summary, menu); return details;
      }
      function ensureActivityButtons(bar) {
        if (!bar.querySelector('#wm-market-launch')) {
          const auctions = action('wm-market-launch', 'Mes enchères', runtime.activity.openMarket);
          auctions.title = 'Ventes, enchères placées et enchères suivies sans miser';
          const achievements = action('wm-achievements-launch', 'Succès', runtime.activity.openAchievements);
          achievements.title = 'Vérifier les nouveaux succès et réclamer toutes les récompenses';
          bar.append(auctions, achievements);
        }
      }
      function render() {
        updateRoute();
        let bar = document.getElementById('wm-tools-bar') || document.querySelector('.wm-pulls-tools') || document.getElementById('wm-global-compact-tools');
        if (!bar && ['/marketplace', '/achievements', '/trades', '/guild'].some(path => location.pathname === path || location.pathname.startsWith(path + '/'))) {
          const h1 = document.querySelector('main h1');
          if (h1) {
            bar = document.getElementById('wm-activity-toolbar');
            if (!bar) { bar = document.createElement('div'); bar.id = 'wm-activity-toolbar'; bar.className = 'wm-tools-bar'; h1.parentElement.insertAdjacentElement('afterend', bar); }
          }
        }
        const slot = document.getElementById('wm-settings-currency-slot');
        if (!bar) { if (slot) slot.hidden = hasToolbarRoute(); runtime.activity.renderDetailFollow(); return; }
        if (slot) slot.hidden = true;
        bar.classList.add('wm-workspace-toolbar');
        if (!bar.dataset.wmOrganized) {
          bar.dataset.wmOrganized = '1';
          bar.querySelectorAll(':scope > small, .wm-toolbar-version').forEach(node => node.remove());
          let brand = bar.querySelector('.wm-toolbar-brand');
          if (!brand) {
            brand = document.createElement('div');
            brand.className = 'wm-toolbar-brand';
            brand.innerHTML = '<span class="wm-brand-icon">✦</span><span class="wm-brand-title">WM Tools</span>';
            brand.title = 'WikiMaster Tools · Prix et outils de collection';
            bar.prepend(brand);
          }
          bar.querySelectorAll('.wm-sponsor-note').forEach(node => node.remove());
          ensureActivityButtons(bar); bar.append(options());
        }
        // Keep these existing controls rather than introducing duplicate settings.
        const menu = bar.querySelector('.wm-tools-menu');
        const openAll = document.querySelector('#wm-pulls-info .wm-open-all-button');
        if (openAll) { openAll.classList.add('wm-primary-button'); bar.insertBefore(openAll, bar.querySelector('#wm-market-launch')); }
        const recapToggle = bar.querySelector('.wm-pulls-toggle:not(.wm-auto-open-toggle)');
        if (recapToggle && recapToggle.parentElement !== menu) menu.prepend(recapToggle);
        const compact = bar.querySelector('[data-wm-compact-button]');
        if (compact && compact.parentElement !== menu) menu.prepend(compact);
        const legend = document.getElementById('wm-price-legend');
        if (legend && legend.parentElement !== menu) {
          const help = document.createElement('details'); help.className = 'wm-price-help';
          const title = document.createElement('summary'); title.textContent = 'Comprendre les prix'; help.append(title, legend); menu.append(help);
        }
        const sync = bar.querySelector('#wm-file-sync-launch');
        if (sync) sync.title = 'Synchronisation : ' + runtime.fileSync.getStatus();
        runtime.activity.renderDetailFollow();
      }
      // Explicit close controls preserve input/selection when clicking or dragging outside.
      document.addEventListener('click', event => {
        if (event.target.closest?.('.wm-modal-overlay')) return;
        document.querySelectorAll('.wm-tools-options[open]').forEach(details => { if (!details.contains(event.target)) details.open = false; });
      });
      return { render };
    }
  };
})();
