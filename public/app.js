// ── DOM references ───────────────────────────────────────────
const elLoading       = document.getElementById('loading');
const elError         = document.getElementById('error-state');
const elErrorMsg      = document.getElementById('error-message');
const elBoard         = document.getElementById('board');
const elPodium        = document.getElementById('podium');
const elTable         = document.getElementById('leaderboard-table');
const elDayCounter    = document.getElementById('day-counter');
const elLastUpdated   = document.getElementById('last-updated');
const elTotalMissions = document.getElementById('total-missions');
const elSquadSize     = document.getElementById('squad-size');
const elSquadLeader   = document.getElementById('squad-leader-name');
const elRefreshBtn    = document.getElementById('refresh-btn');
const elRetryBtn      = document.getElementById('retry-btn');
const elDrawerOverlay = document.getElementById('drawer-overlay');
const elDrawer        = document.getElementById('detail-drawer');
const elDrawerClose   = document.getElementById('drawer-close');
const elDrawerRank    = document.getElementById('drawer-rank-badge');
const elDrawerName    = document.getElementById('drawer-agent-name');
const elDrawerMeta    = document.getElementById('drawer-meta');
const elDrawerMetrics = document.getElementById('drawer-metrics');
const elDrawerVsTeam  = document.getElementById('drawer-vs-team');
const elDrawerTickets = document.getElementById('drawer-tickets');

let isRefreshing = false;
let currentData  = null;

// ── Utilities ────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 1) return '<1m';
  const hours   = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0)   return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatLastUpdated(isoString) {
  if (!isoString) return '—';
  try {
    const IST_MS = 5.5 * 60 * 60 * 1000;
    const d = new Date(new Date(isoString).getTime() + IST_MS);
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} IST`;
  } catch { return isoString; }
}

function getStatPillClass(ms, type) {
  if (!ms || ms <= 0) return '';
  if (type === 'resolution') {
    if (ms < 2 * 3600000) return 'fast';
    if (ms > 8 * 3600000) return 'slow';
  }
  if (type === 'firstResponse') {
    if (ms < 30 * 60000)   return 'fast';
    if (ms > 2 * 3600000)  return 'slow';
  }
  return '';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function getTierBadge(tier, tierColor) {
  const bg  = tierColor + '18';
  const bdr = tierColor + '45';
  return `<span class="tier-badge" style="color:${tierColor};background:${bg};border:1px solid ${bdr};">${escapeHtml(tier)}</span>`;
}

function buildStatPill(icon, label, origLabel, value, type) {
  if (!value || value <= 0) return '';
  const cls = getStatPillClass(value, type);
  return `<span class="stat-pill ${cls}"><span class="pill-icon">${icon}</span><span class="pill-label">${label}</span> <span style="color:var(--text);font-size:10px;">(${origLabel})</span> ${formatDuration(value)}</span>`;
}

function getRankColor(rank) {
  if (rank === 1) return 'var(--gold)';
  if (rank === 2) return 'var(--silver)';
  if (rank === 3) return 'var(--bronze)';
  return 'var(--text-3)';
}

// ── Render: Podium ───────────────────────────────────────────

function renderPodium(top3, allOperatives) {
  elPodium.innerHTML = '';
  if (!top3 || top3.length === 0) {
    elPodium.innerHTML = '<div class="empty-row">No data available yet.</div>';
    return;
  }

  const classes = ['rank-1-card','rank-2-card','rank-3-card'];

  top3.forEach((op, idx) => {
    const rankNum   = idx + 1;
    const cardClass = classes[idx];
    const resPill   = buildStatPill('', 'Resolution', 'Avg', op.avgResolutionTimeMs, 'resolution');

    const card = document.createElement('div');
    card.className = `podium-card ${cardClass}`;
    card.innerHTML = `
      <div class="podium-card-inner">
        <div class="podium-rank">${rankNum}</div>
        <div class="podium-name">${escapeHtml(op.name)}</div>
        <div class="podium-count-wrap">
          <div class="podium-count">${op.missionsCompleted}</div>
          <div class="podium-count-label">
            Missions
            <span class="orig">(Tickets Closed)</span>
          </div>
        </div>
        <div class="podium-tier">${getTierBadge(op.tier, op.tierColor)}</div>
        <div class="podium-res-pill">
          ${resPill || '<span class="stat-pill">No resolution data</span>'}
        </div>
      </div>
    `;

    card.addEventListener('click', () => openDrawer(op, rankNum, allOperatives));
    elPodium.appendChild(card);
  });
}

// ── Render: Table ────────────────────────────────────────────

function renderTable(rest, offset, allOperatives) {
  elTable.innerHTML = '';
  if (!rest || rest.length === 0) {
    elTable.innerHTML = '<div class="empty-row">No additional agents to display.</div>';
    return;
  }

  rest.forEach((op, idx) => {
    const rank       = idx + offset;
    const isInactive = op.missionsCompleted === 0;

    const rankHtml = isInactive
      ? `<div class="row-rank inactive-rank">INACTIVE</div>`
      : `<div class="row-rank">${rank}</div>`;

    const resPill = buildStatPill('', 'Resolution', 'Avg', op.avgResolutionTimeMs, 'resolution');

    const row = document.createElement('div');
    row.className = `leaderboard-row${isInactive ? ' inactive' : ''}`;
    row.style.animationDelay = `${Math.min(idx * 0.03, 0.6)}s`;
    row.innerHTML = `
      ${rankHtml}
      <div class="row-info">
        <div class="row-name">${escapeHtml(op.name)}</div>
        <div class="row-tier-wrap">${getTierBadge(op.tier, op.tierColor)}</div>
      </div>
      <div class="row-missions-wrap">
        <div class="row-missions">${op.missionsCompleted}</div>
        <div class="row-missions-label">Missions <span class="orig">(Closed)</span></div>
      </div>
      <div class="row-stats">
        ${resPill || '<span class="stat-pill">—</span>'}
      </div>
    `;

    row.addEventListener('click', () => openDrawer(op, rank, allOperatives));
    elTable.appendChild(row);
  });
}

// ── Render: Board ────────────────────────────────────────────

function renderBoard(data) {
  currentData = data;
  const operatives = data.operatives || [];

  elTotalMissions.textContent = data.totalMissions ?? '0';
  elSquadSize.textContent     = data.squadSize ?? '0';

  const leader = operatives.find(op => op.missionsCompleted > 0);
  elSquadLeader.textContent   = leader ? leader.name : '—';

  elDayCounter.textContent    = data.dayNumber ? `Day ${data.dayNumber} · ${data.date || ''}` : 'Support Leaderboard';
  elLastUpdated.textContent   = `Updated ${formatLastUpdated(data.lastUpdated)}`;

  const withMissions = operatives.filter(op => op.missionsCompleted > 0);
  const top3 = withMissions.slice(0, 3);
  const rest = operatives.slice(top3.length);

  renderPodium(top3, operatives);
  renderTable(rest, top3.length + 1, operatives);

  document.getElementById('leaderboard-section').classList.toggle('hidden', rest.length === 0);
}

// ── Drawer ───────────────────────────────────────────────────

function openDrawer(op, rank, allOperatives) {
  const rankColor = getRankColor(rank);

  // Header rank badge
  elDrawerRank.textContent  = `#${rank}`;
  elDrawerRank.style.color  = rankColor;

  // Name
  elDrawerName.textContent = op.name;

  // Meta: tier + clearance
  elDrawerMeta.innerHTML = `
    ${getTierBadge(op.tier, op.tierColor)}
    <span style="font-size:11px;color:var(--text);">(Clearance Level ${rank})</span>
  `;

  // Team averages for comparison
  const activeOps = allOperatives.filter(o => o.missionsCompleted > 0);
  const teamAvgMissions = activeOps.length
    ? activeOps.reduce((s,o) => s + o.missionsCompleted, 0) / activeOps.length
    : 0;
  const teamAvgRes = (() => {
    const withRes = activeOps.filter(o => o.avgResolutionTimeMs);
    return withRes.length ? withRes.reduce((s,o) => s + o.avgResolutionTimeMs, 0) / withRes.length : 0;
  })();

  // Metrics grid
  const minRes = op.minResolutionTimeMs;
  const maxRes = op.maxResolutionTimeMs;
  const avgRes = op.avgResolutionTimeMs;
  const avgFR  = op.avgFirstResponseTimeMs;

  const resClass = avgRes
    ? (avgRes < teamAvgRes ? 'good' : avgRes > teamAvgRes * 1.5 ? 'bad' : '')
    : '';

  elDrawerMetrics.innerHTML = `
    <div class="metric-card">
      <div class="metric-value" style="color:${rankColor}">${op.missionsCompleted}</div>
      <div class="metric-label">Missions</div>
      <div class="metric-sublabel">Tickets Closed Today</div>
    </div>
    <div class="metric-card">
      <div class="metric-value ${resClass}">${formatDuration(avgRes)}</div>
      <div class="metric-label">Avg Resolution</div>
      <div class="metric-sublabel">Time to Close</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${formatDuration(minRes)}</div>
      <div class="metric-label">Fastest Close</div>
      <div class="metric-sublabel">Best resolution today</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${formatDuration(maxRes)}</div>
      <div class="metric-label">Slowest Close</div>
      <div class="metric-sublabel">Longest resolution today</div>
    </div>
    ${avgFR ? `
    <div class="metric-card full-width">
      <div class="metric-value">${formatDuration(avgFR)}</div>
      <div class="metric-label">Avg First Response</div>
      <div class="metric-sublabel">Reaction Speed</div>
    </div>` : ''}
  `;

  // vs team average bars
  const maxMissions = Math.max(...activeOps.map(o => o.missionsCompleted), 1);

  const missionsPct   = Math.min((op.missionsCompleted / maxMissions) * 100, 100);
  const teamMissionsPct = Math.min((teamAvgMissions / maxMissions) * 100, 100);

  let resBarPct = 0, resBarClass = 'neutral';
  if (avgRes && teamAvgRes) {
    resBarPct  = Math.min((teamAvgRes / avgRes) * 60, 100);
    resBarClass = avgRes < teamAvgRes ? 'good' : 'bad';
  }

  elDrawerVsTeam.innerHTML = `
    <div class="vs-team-label">vs. Team Average</div>
    <div class="vs-bar-row">
      <div class="vs-bar-name">Missions</div>
      <div class="vs-bar-track"><div class="vs-bar-fill ${missionsPct >= teamMissionsPct ? 'good' : 'neutral'}" style="width:${missionsPct}%"></div></div>
      <div class="vs-bar-val">${op.missionsCompleted} <span style="color:var(--text);font-size:10px;">/ avg ${teamAvgMissions.toFixed(1)}</span></div>
    </div>
    ${avgRes && teamAvgRes ? `
    <div class="vs-bar-row">
      <div class="vs-bar-name">Resolution</div>
      <div class="vs-bar-track"><div class="vs-bar-fill ${resBarClass}" style="width:${resBarPct}%"></div></div>
      <div class="vs-bar-val">${formatDuration(avgRes)} <span style="color:var(--text);font-size:10px;">/ avg ${formatDuration(teamAvgRes)}</span></div>
    </div>` : ''}
  `;

  // Ticket list
  const tickets = op.tickets || [];
  if (tickets.length > 0) {
    const rows = tickets.map(t => {
      const resMs   = t.resolutionTimeMs || 0;
      const resCls  = resMs > 0 ? (resMs < 2*3600000 ? 'good' : resMs > 8*3600000 ? 'bad' : '') : '';
      const resColor = resCls === 'good' ? 'var(--green)' : resCls === 'bad' ? 'var(--red)' : 'var(--text-2)';
      return `
        <div class="ticket-item">
          <div class="ticket-left">
            <div class="ticket-subject">${escapeHtml(t.subject || 'Untitled ticket')}</div>
            <div class="ticket-num">#${escapeHtml(String(t.ticketNumber || t.id || ''))}</div>
          </div>
          <div class="ticket-res" style="color:${resColor}">${formatDuration(resMs)}</div>
        </div>
      `;
    }).join('');
    elDrawerTickets.innerHTML = `<div class="drawer-tickets-title">Tickets Closed Today (${tickets.length})</div>${rows}`;
  } else {
    elDrawerTickets.innerHTML = `<div class="drawer-tickets-title">Tickets Closed Today</div><div class="empty-row" style="padding:16px 0;">No ticket details available.</div>`;
  }

  // Show
  elDrawerOverlay.classList.remove('hidden');
  elDrawer.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  elDrawer.classList.add('hidden');
  elDrawerOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

// ── Data fetching ────────────────────────────────────────────

async function fetchLeaderboard() {
  showLoading();
  try {
    const resp = await fetch('/api/leaderboard');
    const data = await resp.json();
    if (!resp.ok || data.noData) { showError(data.error || 'No data available yet.'); return; }
    showBoard(data);
    renderBoard(data);
  } catch (err) {
    showError('Failed to load data. Check server connection.');
    console.error('[app] fetchLeaderboard error:', err);
  }
}

async function triggerRefresh() {
  if (isRefreshing) return;
  isRefreshing = true;
  elRefreshBtn.disabled = true;
  elRefreshBtn.textContent = 'Refreshing...';
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await fetchLeaderboard();
  } catch (err) {
    showError('Refresh failed. Please try again.');
  } finally {
    isRefreshing = false;
    elRefreshBtn.disabled = false;
    elRefreshBtn.textContent = '↺ Refresh';
  }
}

function showLoading() {
  elLoading.classList.remove('hidden');
  elError.classList.add('hidden');
  elBoard.classList.add('hidden');
}

function showError(msg) {
  elLoading.classList.add('hidden');
  elBoard.classList.add('hidden');
  elError.classList.remove('hidden');
  elErrorMsg.textContent = msg || 'No data available.';
}

function showBoard() {
  elLoading.classList.add('hidden');
  elError.classList.add('hidden');
  elBoard.classList.remove('hidden');
}

// ── Events ───────────────────────────────────────────────────
elRefreshBtn.addEventListener('click', triggerRefresh);
elRetryBtn.addEventListener('click', fetchLeaderboard);
elDrawerClose.addEventListener('click', closeDrawer);
elDrawerOverlay.addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

setInterval(fetchLeaderboard, 5 * 60 * 1000);
fetchLeaderboard();

// ── Trends Tab ───────────────────────────────────────────────

const elTrendsTab      = document.getElementById('trends-tab');
const elTrendsList     = document.getElementById('trends-list');
const elTrendsSearch   = document.getElementById('trends-search');
const elTrendsCount    = document.getElementById('trends-count');
const elTrendsLoading  = document.getElementById('trends-loading');
const elTrendsEmpty    = document.getElementById('trends-empty');
const elSummaryBar     = document.querySelector('.summary-bar');
const elTabBtns        = document.querySelectorAll('.tab-btn');

let trendsData = null;

function formatDelta(delta, type) {
  if (delta === null || delta === undefined) return '';
  if (delta === 0) return '<span class="delta neutral">—</span>';
  if (type === 'missions') {
    const cls = delta > 0 ? 'up-good' : 'down-bad';
    return `<span class="delta ${cls}">${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}</span>`;
  }
  if (type === 'resolution') {
    // Lower res time = better (down-good), higher = worse (up-bad)
    const cls = delta < 0 ? 'down-good' : 'up-bad';
    return `<span class="delta ${cls}">${delta > 0 ? '↑' : '↓'}${formatDuration(Math.abs(delta))}</span>`;
  }
  return '';
}

function buildMissionsChart(daily) {
  // daily is most-recent-first; reverse for left→right chronological
  const days = [...daily].reverse();
  const W = 400, H = 64, pad = 4;
  const maxM = Math.max(...days.map(d => d.missionsCompleted), 1);
  const barW = Math.max(6, Math.floor((W - pad * 2) / days.length) - 2);
  const gap  = Math.floor((W - pad * 2 - barW * days.length) / Math.max(days.length - 1, 1));

  const bars = days.map((d, i) => {
    const bh  = Math.max(3, Math.round(((d.missionsCompleted / maxM) * (H - 18))));
    const x   = pad + i * (barW + gap);
    const y   = H - bh - 14;
    const col = i === days.length - 1 ? 'var(--gold)' : 'var(--border-2)';
    const lbl = d.missionsCompleted;
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="2" fill="${col}" opacity="0.85"/>
      <text x="${x + barW / 2}" y="${H - 2}" text-anchor="middle" font-size="9" fill="var(--text-3)">${d.date.slice(5)}</text>
      ${i === days.length - 1 ? `<text x="${x + barW / 2}" y="${y - 3}" text-anchor="middle" font-size="10" fill="var(--gold)" font-weight="600">${lbl}</text>` : ''}
    `;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible;">${bars}</svg>`;
}

function buildResChart(daily) {
  const days = [...daily].reverse().filter(d => d.avgResolutionTimeMs);
  if (days.length < 2) return '';
  const W = 400, H = 56, pad = 8;
  const vals = days.map(d => d.avgResolutionTimeMs);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const range = maxV - minV || 1;
  const stepX = (W - pad * 2) / Math.max(days.length - 1, 1);

  const pts = days.map((d, i) => {
    const x = pad + i * stepX;
    const y = H - 14 - Math.round(((d.avgResolutionTimeMs - minV) / range) * (H - 22));
    return { x, y, d };
  });

  const polyline = pts.map(p => `${p.x},${p.y}`).join(' ');
  const area = `${pts[0].x},${H - 14} ` + pts.map(p => `${p.x},${p.y}`).join(' ') + ` ${pts[pts.length-1].x},${H - 14}`;

  const dots = pts.map((p, i) => {
    const isLast = i === pts.length - 1;
    return `<circle cx="${p.x}" cy="${p.y}" r="${isLast ? 3.5 : 2}" fill="${isLast ? 'var(--gold)' : 'var(--text-3)'}"/>`;
  }).join('');

  const labels = days.map((d, i) => {
    const p = pts[i];
    return `<text x="${p.x}" y="${H - 2}" text-anchor="middle" font-size="9" fill="var(--text-3)">${d.date.slice(5)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible;">
    <defs><linearGradient id="rg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--gold)" stop-opacity="0.18"/><stop offset="100%" stop-color="var(--gold)" stop-opacity="0"/></linearGradient></defs>
    <polygon points="${area}" fill="url(#rg)"/>
    <polyline points="${polyline}" fill="none" stroke="var(--gold)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.7"/>
    ${dots}${labels}
  </svg>`;
}

function renderTrends(agents, query) {
  const filtered = query
    ? agents.filter(a => a.name.toLowerCase().includes(query.toLowerCase()))
    : agents;

  elTrendsCount.textContent = `${filtered.length} agent${filtered.length !== 1 ? 's' : ''}`;

  if (filtered.length === 0) {
    elTrendsEmpty.classList.remove('hidden');
    elTrendsList.innerHTML = '';
    return;
  }
  elTrendsEmpty.classList.add('hidden');

  elTrendsList.innerHTML = filtered.map(agent => {
    const rows = agent.daily.map((d, i) => `
      <div class="trend-row${i === 0 ? ' trend-row-today' : ''}">
        <div class="trend-cell trend-date">${d.date}</div>
        <div class="trend-cell trend-missions">
          <span>${d.missionsCompleted}</span>
          ${formatDelta(d.deltaM, 'missions')}
        </div>
        <div class="trend-cell trend-res">
          <span>${formatDuration(d.avgResolutionTimeMs)}</span>
          ${formatDelta(d.deltaR, 'resolution')}
        </div>
      </div>
    `).join('');

    const totalMissions = agent.daily.reduce((s, d) => s + d.missionsCompleted, 0);
    const avgMissions   = agent.daysTracked > 0 ? (totalMissions / agent.daysTracked).toFixed(1) : '—';
    const resEntries    = agent.daily.filter(d => d.avgResolutionTimeMs);
    const avgRes        = resEntries.length
      ? Math.round(resEntries.reduce((s, d) => s + d.avgResolutionTimeMs, 0) / resEntries.length)
      : null;

    const missionsChart = buildMissionsChart(agent.daily);
    const resChart      = buildResChart(agent.daily);

    return `
      <div class="trend-card">
        <div class="trend-card-header">
          <div>
            <div class="trend-agent-name">${escapeHtml(agent.name)}</div>
            <div class="trend-summary">
              <span class="trend-summary-item">${agent.daysTracked} day${agent.daysTracked !== 1 ? 's' : ''}</span>
              <span class="trend-summary-item">avg <strong>${avgMissions}</strong> missions/day</span>
              ${avgRes ? `<span class="trend-summary-item">avg res <strong>${formatDuration(avgRes)}</strong></span>` : ''}
            </div>
          </div>
        </div>
        <div class="trend-charts">
          <div class="trend-chart-wrap">
            <div class="trend-chart-label">Missions per Day <span class="orig">(Tickets Closed)</span></div>
            ${missionsChart}
          </div>
          ${resChart ? `<div class="trend-chart-wrap">
            <div class="trend-chart-label">Avg Resolution Time</div>
            ${resChart}
          </div>` : ''}
        </div>
        <div class="trend-table">
          <div class="trend-row trend-header-row">
            <div class="trend-cell trend-date">Date</div>
            <div class="trend-cell trend-missions">Missions</div>
            <div class="trend-cell trend-res">Avg Resolution</div>
          </div>
          ${rows}
        </div>
      </div>
    `;
  }).join('');
}

async function fetchTrends() {
  elTrendsLoading.classList.remove('hidden');
  elTrendsList.innerHTML = '';
  elTrendsEmpty.classList.add('hidden');
  try {
    const resp = await fetch('/api/trends');
    const data = await resp.json();
    if (!resp.ok) { elTrendsLoading.classList.add('hidden'); return; }
    trendsData = data;
    elTrendsLoading.classList.add('hidden');
    renderTrends(trendsData, elTrendsSearch.value.trim());
  } catch (err) {
    elTrendsLoading.classList.add('hidden');
    console.error('[app] fetchTrends error:', err);
  }
}

// Tab switching
elTabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    elTabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (tab === 'today') {
      elBoard.classList.toggle('hidden', !currentData);
      elTrendsTab.classList.add('hidden');
      elSummaryBar.classList.remove('hidden');
      if (!currentData) fetchLeaderboard();
    } else if (tab === 'trends') {
      elBoard.classList.add('hidden');
      elLoading.classList.add('hidden');
      elError.classList.add('hidden');
      elSummaryBar.classList.add('hidden');
      elTrendsTab.classList.remove('hidden');
      if (!trendsData) fetchTrends();
    }
  });
});

// Search filter
elTrendsSearch.addEventListener('input', () => {
  if (trendsData) renderTrends(trendsData, elTrendsSearch.value.trim());
});
