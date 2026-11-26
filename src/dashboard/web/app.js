// Tableau de bord BordelBot : page unique, sans framework ni dépendance.
// Tout le contenu est construit avec le DOM (textContent) : un pseudo ne peut pas injecter de HTML.
'use strict';

(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const REFRESH_MS = 60_000;
  const nf = new Intl.NumberFormat('fr-FR');
  const pf = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 });
  const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  const MEDALS = ['🥇', '🥈', '🥉'];
  const PERIODS = [
    ['1h', '1 h'],
    ['24h', '24 h'],
    ['7j', '7 j'],
    ['30j', '30 j'],
  ];
  const BOARDS = [
    ['fortune', 'Fortune'],
    ['seasonEarnings', 'Gains du mois'],
    ['seasonWins', 'Victoires du mois'],
    ['levels', 'Niveaux'],
  ];
  const ERRORS = {
    etat: 'La connexion a expiré ou a été interrompue : réessaie.',
    connexion: 'Discord n’a pas validé la connexion : réessaie dans un instant.',
  };

  /** me : undefined = pas encore chargé, null = non connecté. */
  const state = { me: undefined, symbol: 'CRS', period: '24h', board: 'fortune', timer: null, renderId: 0 };

  // ---------- Petits outils ----------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  function svg(tag, attrs) {
    const el = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, String(value));
    return el;
  }

  const money = (n, cur) => `${nf.format(n)} ${cur}`;
  const signed = (n, cur) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n), cur)}`;
  const pct = (x) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : ''}${pf.format(x)}`);
  const trend = (x) => (x === null || x === undefined || x === 0 ? '' : x > 0 ? 'up' : 'down');
  const price = (p) => p.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function relTime(at) {
    const diff = at - Date.now();
    const abs = Math.abs(diff);
    const units = [
      ['day', 86_400_000],
      ['hour', 3_600_000],
      ['minute', 60_000],
    ];
    for (const [unit, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
    return 'à l’instant';
  }

  function img(src, cls, alt) {
    return h('img', { src, class: cls, alt: alt || '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  }

  function guildIcon(guild) {
    return guild.iconUrl ? img(guild.iconUrl, 'avatar lg', '') : h('div', { class: 'icon-fallback' }, guild.name.slice(0, 1).toUpperCase());
  }

  async function api(path) {
    try {
      const res = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) return { status: res.status, data: null };
      return { status: res.status, data: await res.json() };
    } catch {
      return { status: 0, data: null };
    }
  }

  function render(...nodes) {
    const app = document.getElementById('app');
    app.replaceChildren(...nodes.flat().filter(Boolean));
  }

  function loginButton(label) {
    return h('a', { class: 'btn primary', href: '/auth/login' }, label || 'Se connecter avec Discord');
  }

  // ---------- Compte ----------

  async function loadMe() {
    const res = await api('/api/me');
    state.me = res.status === 200 ? res.data : null;
    const account = document.getElementById('account');
    if (!state.me) {
      account.replaceChildren(loginButton('Connexion'));
      return;
    }
    const { user } = state.me;
    account.replaceChildren(
      img(user.avatarUrl, 'avatar', ''),
      h('span', { class: 'name' }, user.name),
      h('form', { method: 'post', action: '/auth/logout' }, h('button', { class: 'btn small', type: 'submit' }, 'Déconnexion')),
    );
  }

  function showError() {
    const params = new URLSearchParams(location.search);
    const code = params.get('erreur');
    if (!code) return;
    const banner = document.getElementById('banner');
    banner.textContent = ERRORS[code] || 'Une erreur est survenue.';
    banner.hidden = false;
    history.replaceState(null, '', location.pathname + location.hash);
  }

  // ---------- Graphiques ----------

  function sparkline(values, direction) {
    const el = svg('svg', { class: 'spark', viewBox: '0 0 100 30', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    if (!values || values.length < 2) return el;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(28 - ((v - min) / span) * 26).toFixed(2)}`);
    el.append(svg('polyline', { class: `line ${direction || 'up'}`, points: pts.join(' '), 'vector-effect': 'non-scaling-stroke' }));
    return el;
  }

  function timeLabel(at, period) {
    const d = new Date(at);
    return period === '1h' || period === '24h'
      ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  }

  /** Grand graphique avec axes, aire et curseur au survol. */
  function priceChart(points, period) {
    // Largeur réelle du contenu (moins les marges de la carte) : le graphique remplit la carte sans être déformé.
    const W = Math.max(320, Math.round(document.getElementById('app').clientWidth - 76));
    const H = 260;
    const L = 56;
    const R = 12;
    const T = 12;
    const B = 26;
    const el = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Évolution du cours' });
    if (points.length < 2) return el;
    const values = points.map((p) => p.price);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = (max - min) * 0.08 || max * 0.01 || 1;
    const lo = min - pad;
    const hi = max + pad;
    const x = (i) => L + (i / (points.length - 1)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const dir = values[values.length - 1] >= values[0] ? 'up' : 'down';

    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4;
      const yy = y(v);
      el.append(svg('line', { class: 'grid-line', x1: L, x2: W - R, y1: yy, y2: yy }));
      const label = svg('text', { class: 'axis', x: L - 6, y: yy + 4, 'text-anchor': 'end' });
      label.textContent = price(v);
      el.append(label);
    }
    for (const [i, anchor] of [
      [0, 'start'],
      [points.length - 1, 'end'],
    ]) {
      const label = svg('text', { class: 'axis', x: x(i), y: H - 6, 'text-anchor': anchor });
      label.textContent = timeLabel(points[i].at, period);
      el.append(label);
    }

    const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.price).toFixed(1)}`);
    el.append(svg('polygon', { class: `area ${dir}`, points: `${L},${H - B} ${line.join(' ')} ${W - R},${H - B}` }));
    el.append(svg('polyline', { class: `line ${dir}`, points: line.join(' ') }));

    const cursor = svg('line', { class: 'cursor', y1: T, y2: H - B, visibility: 'hidden' });
    const dot = svg('circle', { class: 'dot', r: 4, visibility: 'hidden' });
    const tip = svg('text', { class: 'tip', y: T + 12, visibility: 'hidden' });
    el.append(cursor, dot, tip);
    el.addEventListener('pointermove', (ev) => {
      const box = el.getBoundingClientRect();
      const px = ((ev.clientX - box.left) / box.width) * W;
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - R)) * (points.length - 1))));
      const p = points[i];
      const cx = x(i);
      for (const node of [cursor, dot, tip]) node.setAttribute('visibility', 'visible');
      cursor.setAttribute('x1', cx);
      cursor.setAttribute('x2', cx);
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', y(p.price));
      tip.textContent = `${price(p.price)} · ${new Date(p.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`;
      tip.setAttribute('x', cx > W / 2 ? cx - 8 : cx + 8);
      tip.setAttribute('text-anchor', cx > W / 2 ? 'end' : 'start');
    });
    el.addEventListener('pointerleave', () => {
      for (const node of [cursor, dot, tip]) node.setAttribute('visibility', 'hidden');
    });
    return el;
  }

  // ---------- Bourse ----------

  function quotesTable(market, opts) {
    const rows = market.quotes.map((q) =>
      h(
        'tr',
        {
          class: `pick${opts.selected === q.symbol ? ' selected' : ''}`,
          onclick: () => opts.onPick(q.symbol),
        },
        h('td', {}, `${q.emoji} `, h('b', {}, q.symbol), h('span', { class: 'muted hide-sm' }, ` ${q.name}`)),
        h('td', { class: 'r num' }, price(q.price)),
        h('td', { class: `r num ${trend(q.change24h)}` }, pct(q.change24h)),
        h('td', { class: 'r hide-sm' }, sparkline(q.spark, trend(q.change24h) || 'up')),
        opts.compact ? null : h('td', { class: 'r hide-sm' }, q.dividendRate ? h('span', { class: 'badge' }, `💵 ${pf.format(q.dividendRate)}/jour`) : ''),
      ),
    );
    return h(
      'table',
      { class: 'quotes' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', {}, 'Actif'),
          h('th', { class: 'r' }, 'Cours'),
          h('th', { class: 'r' }, '24 h'),
          h('th', { class: 'r hide-sm' }, 'Tendance'),
          opts.compact ? null : h('th', { class: 'r hide-sm' }, ''),
        ),
      ),
      h('tbody', {}, rows),
    );
  }

  async function viewMarket(id) {
    const [market, history] = await Promise.all([
      api('/api/market'),
      api(`/api/market/${state.symbol}?periode=${state.period}`),
    ]);
    if (id !== state.renderId) return;
    if (!market.data) return render(h('p', { class: 'muted' }, 'La bourse est indisponible pour le moment.'));
    const q = market.data.quotes.find((x) => x.symbol === state.symbol) || market.data.quotes[0];
    const points = history.data ? history.data.points : [];
    const first = points.length ? points[0].price : q.price;
    const change = first ? q.price / first - 1 : null;

    const periodButtons = PERIODS.map(([value, label]) =>
      h(
        'button',
        {
          class: `tab${state.period === value ? ' active' : ''}`,
          type: 'button',
          onclick: () => {
            state.period = value;
            route(true);
          },
        },
        label,
      ),
    );

    render(
      h('div', { class: 'page-head' }, h('div', { class: 'meta' }, h('h1', {}, '📊 Bourse du Bordel'), h('div', { class: 'muted' }, `Cours communs à tous les serveurs, mis à jour toutes les 5 minutes · frais ${pf.format(market.data.fee)} par ordre`))),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'chart-head' },
          h('h2', {}, `${q.emoji} ${q.name} (${q.symbol})`),
          h('span', { class: 'price num' }, price(q.price)),
          h('span', { class: `num ${trend(change)}` }, `${pct(change)} sur ${PERIODS.find((p) => p[0] === state.period)[1]}`),
        ),
        h('div', { class: 'tabs' }, periodButtons),
        points.length >= 2 ? priceChart(points, state.period) : h('p', { class: 'muted' }, 'Pas encore assez d’historique.'),
      ),
      h(
        'div',
        { class: 'grid two section' },
        h(
          'div',
          { class: 'card' },
          h('h2', {}, 'Actifs'),
          quotesTable(market.data, {
            selected: q.symbol,
            onPick: (symbol) => {
              state.symbol = symbol;
              route(true);
            },
          }),
        ),
        h(
          'div',
          { class: 'card' },
          h('h2', {}, '📰 Actualités'),
          market.data.news.length
            ? h(
                'ul',
                { class: 'news' },
                market.data.news.map((n) =>
                  h('li', {}, `${n.emoji} ${n.headline} `, h('span', { class: `num ${trend(n.change)}` }, pct(n.change)), h('div', { class: 'muted small' }, relTime(n.at))),
                ),
              )
            : h('p', { class: 'muted' }, 'Aucune actualité récente.'),
        ),
      ),
    );
  }

  // ---------- Accueil ----------

  async function viewHome(id) {
    const market = await api('/api/market');
    if (id !== state.renderId) return;
    const marketCard = market.data
      ? h(
          'div',
          { class: 'card section' },
          h('h2', {}, '📊 Bourse'),
          quotesTable(market.data, {
            compact: true,
            onPick: (symbol) => {
              state.symbol = symbol;
              location.hash = '#/bourse';
            },
          }),
        )
      : null;

    if (!state.me) {
      return render(
        h(
          'section',
          { class: 'hero' },
          h('h1', {}, '🎲 BordelBot'),
          h('p', { class: 'muted' }, 'Classements, statistiques et économie de tes serveurs. Connecte-toi avec Discord : tu ne verras que les serveurs dont tu es membre.'),
          loginButton(),
        ),
        marketCard,
      );
    }

    const { user, guilds } = state.me;
    render(
      h('div', { class: 'page-head' }, h('div', { class: 'meta' }, h('h1', {}, `Bonjour, ${user.name} 👋`), h('div', { class: 'muted' }, 'Choisis un serveur.'))),
      guilds.length
        ? h(
            'div',
            { class: 'guilds' },
            guilds.map((g) =>
              h('a', { class: 'guild', href: `#/serveur/${g.id}` }, guildIcon(g), h('div', {}, h('div', { class: 'name' }, g.name), h('div', { class: 'muted small' }, `${nf.format(g.memberCount)} membres`))),
            ),
          )
        : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Le bot n’est sur aucun de tes serveurs.')),
      marketCard,
    );
  }

  // ---------- Serveur ----------

  function stat(label, value, hint, cls) {
    return h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: `value num ${cls || ''}` }, value), hint ? h('div', { class: 'hint' }, hint) : null);
  }

  function person(o, userId) {
    const u = o.users[userId] || { name: 'Membre inconnu', avatarUrl: '' };
    return [u.avatarUrl ? img(u.avatarUrl, 'avatar', '') : null, h('span', { class: 'who' }, u.name)];
  }

  function boardRows(o) {
    const cur = o.currency;
    const rows = o.leaderboards[state.board] || [];
    const format = {
      fortune: (r) => money(r.value, cur),
      seasonEarnings: (r) => `+${money(r.value, cur)}`,
      seasonWins: (r) => `${nf.format(r.value)} victoire${r.value > 1 ? 's' : ''}`,
      levels: (r) => `niv. ${r.level} · ${nf.format(r.value)} XP`,
    }[state.board];
    if (!rows.length) return h('p', { class: 'empty' }, 'Personne n’est encore classé.');
    const me = state.me && state.me.user.id;
    return h(
      'ol',
      { class: 'rows' },
      rows.map((r, i) => h('li', { class: `row${r.userId === me ? ' self' : ''}` }, h('span', { class: 'rank' }, MEDALS[i] || i + 1), person(o, r.userId), h('span', { class: 'val' }, format(r)))),
    );
  }

  async function viewGuild(id, guildId) {
    if (!state.me) {
      return render(h('section', { class: 'hero' }, h('h1', {}, 'Connexion requise'), h('p', { class: 'muted' }, 'Les données d’un serveur ne sont visibles que par ses membres.'), loginButton()));
    }
    const res = await api(`/api/guilds/${encodeURIComponent(guildId)}`);
    if (id !== state.renderId) return;
    if (!res.data) {
      return render(h('div', { class: 'card' }, h('p', {}, res.status === 404 ? 'Serveur introuvable, ou tu n’en es pas membre.' : 'Données indisponibles pour le moment.'), h('a', { href: '#/' }, '← Mes serveurs')));
    }
    const o = res.data;
    const cur = o.currency;
    const s = o.stats;

    const boardTabs = BOARDS.map(([value, label]) =>
      h(
        'button',
        {
          class: `tab${state.board === value ? ' active' : ''}`,
          type: 'button',
          onclick: () => {
            state.board = value;
            route(true);
          },
        },
        label,
      ),
    );

    const lottery = o.lottery;
    const lotteryCard = h(
      'div',
      { class: 'card' },
      h('h2', {}, '🎟️ Loterie'),
      lottery.ticketPrice <= 0
        ? h('p', { class: 'muted' }, 'Loterie désactivée sur ce serveur.')
        : lottery.current
          ? h(
              'dl',
              { class: 'kv' },
              h('dt', {}, 'Cagnotte'),
              h('dd', {}, money(lottery.current.pot, cur)),
              h('dt', {}, 'Tickets vendus'),
              h('dd', {}, `${nf.format(lottery.current.tickets)} (${lottery.current.players} joueur${lottery.current.players > 1 ? 's' : ''})`),
              h('dt', {}, 'Tirage'),
              h('dd', {}, relTime(lottery.current.drawsAt)),
              h('dt', {}, 'Prix du ticket'),
              h('dd', {}, money(lottery.ticketPrice, cur)),
            )
          : h('p', { class: 'muted' }, `Aucun ticket vendu cette semaine. Ticket : ${money(lottery.ticketPrice, cur)} (/eco loterie acheter).`),
      lottery.recent.length
        ? h(
            'div',
            { class: 'podium' },
            h('h3', {}, 'Derniers gagnants'),
            h('ul', { class: 'rows' }, lottery.recent.map((d) => h('li', { class: 'row' }, d.winnerId ? person(o, d.winnerId) : h('span', { class: 'who muted' }, 'Personne'), h('span', { class: 'val' }, money(d.pot, cur)), h('span', { class: 'muted small' }, relTime(d.drawnAt))))),
          )
        : null,
    );

    const seasonCard = h(
      'div',
      { class: 'card' },
      h('h2', {}, `🏁 Saison ${o.season.label}`),
      h('p', { class: 'muted' }, `Fin ${relTime(o.season.endsAt)}. Le podium des gains du mois est récompensé le 1er.`),
      o.season.podiums.length
        ? o.season.podiums.map((p) =>
            h(
              'div',
              { class: 'podium' },
              h('h3', {}, p.label),
              h('ol', { class: 'rows' }, p.podium.map((x) => h('li', { class: 'row' }, h('span', { class: 'rank' }, MEDALS[x.rank - 1]), person(o, x.userId), h('span', { class: 'val' }, `+${money(x.score, cur)}`)))),
            ),
          )
        : h('p', { class: 'muted small' }, 'Pas encore de saison terminée.'),
    );

    const a = o.activity;
    const activityCard = h(
      'div',
      { class: 'card' },
      h('h2', {}, '📈 Activité'),
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'Parties (7 j)'),
        h('dd', {}, nf.format(a.games7d)),
        h('dt', {}, 'Parties avec mise (7 j)'),
        h('dd', {}, nf.format(a.wagers7d)),
        h('dt', {}, 'Braquages réussis / ratés (7 j)'),
        h('dd', {}, `${nf.format(a.heists7d.success)} / ${nf.format(a.heists7d.failed)}`),
        h('dt', {}, 'Joueurs du mot du jour'),
        h('dd', {}, nf.format(a.wordleToday)),
        h('dt', {}, 'Tickets ouverts'),
        h('dd', {}, nf.format(a.openTickets)),
      ),
    );

    render(
      h('div', { class: 'page-head' }, guildIcon(o.guild), h('div', { class: 'meta' }, h('h1', {}, o.guild.name), h('div', { class: 'muted' }, `${nf.format(o.guild.memberCount)} membres · monnaie : ${cur}`))),
      h(
        'div',
        { class: 'card me' },
        h('span', {}, '👤 Toi : ', h('b', {}, money(o.me.balance, cur))),
        h('span', {}, '🏅 Rang ', h('b', {}, o.me.rank ? (o.me.rank === 1 ? '1er' : `${o.me.rank}ᵉ`) : '—')),
        h('span', {}, '⭐ Niveau ', h('b', {}, String(o.me.level)), h('span', { class: 'muted' }, ` (${nf.format(o.me.xp)} XP)`)),
      ),
      h(
        'div',
        { class: 'stats section' },
        stat('En circulation', money(s.total, cur), 'soldes, hors bourse'),
        stat('Comptes actifs', nf.format(s.holders), 'solde positif'),
        stat('Solde moyen', money(s.average, cur)),
        stat('Solde médian', money(s.median, cur), 'la moitié a moins'),
        stat('Part des 10 % plus riches', pf.format(s.top10Share)),
        stat('Investi en bourse', money(s.invested, cur), 'au cours actuel'),
        stat('Création monétaire (7 j)', signed(s.supplyChange7d, cur), 'gains moins pertes et dépenses', trend(s.supplyChange7d)),
        stat('Opérations (7 j)', nf.format(s.transactions7d), 'hors virements'),
      ),
      h('div', { class: 'card section' }, h('h2', {}, '🏆 Classements'), h('div', { class: 'tabs' }, boardTabs), boardRows(o)),
      h('div', { class: 'grid three section' }, seasonCard, lotteryCard, activityCard),
    );
  }

  // ---------- Navigation ----------

  function route(quiet) {
    const id = ++state.renderId;
    const hash = location.hash || '#/';
    for (const link of document.querySelectorAll('.nav a')) {
      const target = link.getAttribute('href');
      link.classList.toggle('active', target === '#/bourse' ? hash.startsWith('#/bourse') : !hash.startsWith('#/bourse'));
    }
    if (!quiet) window.scrollTo({ top: 0 });
    const guild = /^#\/serveur\/(\d+)$/.exec(hash);
    if (hash.startsWith('#/bourse')) return viewMarket(id);
    if (guild) return viewGuild(id, guild[1]);
    return viewHome(id);
  }

  async function start() {
    showError();
    await loadMe();
    route();
    window.addEventListener('hashchange', () => route());
    state.timer = setInterval(() => {
      if (!document.hidden) route(true);
    }, REFRESH_MS);
  }

  start();
})();
