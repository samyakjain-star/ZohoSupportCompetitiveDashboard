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

function formatDurationShort(ms) {
  if (!ms || ms <= 0) return '0';
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const mins  = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes}m`;
  if (mins  === 0) return `${hours}h`;
  return `${hours}h${mins}m`;
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

function buildStatPill(label, value, type) {
  if (!value || value <= 0) return '';
  const cls = getStatPillClass(value, type);
  return `<span class="stat-pill ${cls}"><span class="pill-label">${label}</span> ${formatDuration(value)}</span>`;
}

function getRankColor(rank) {
  if (rank === 1) return 'var(--gold)';
  if (rank === 2) return 'var(--silver)';
  if (rank === 3) return 'var(--bronze)';
  return 'var(--text-3)';
}

function fmtScore(score) {
  if (score === null || score === undefined) return '—';
  return Number(score).toFixed(1);
}

function scoreColor(score) {
  if (score === null || score === undefined) return 'var(--text-3)';
  if (score >= 110) return 'var(--green)';
  if (score >= 90)  return 'var(--text)';
  return 'var(--red)';
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
    const rankColor = getRankColor(rankNum);
    const score     = fmtScore(op.performanceScore);
    const sc        = scoreColor(op.performanceScore);
    const todayBadge = op.missionsCompleted > 0
      ? `<span class="today-badge">+${op.missionsCompleted} today</span>` : '';
    const displayRes = op.cumulativeAvgResolutionMs ?? op.avgResolutionTimeMs;
    const resPill    = buildStatPill('Avg Res', displayRes, 'resolution');

    const card = document.createElement('div');
    card.className = `podium-card ${cardClass}`;
    card.innerHTML = `
      <div class="podium-card-inner">
        <div class="podium-rank">${rankNum}</div>
        <div class="podium-name">${escapeHtml(op.name)}</div>
        <div class="podium-score-wrap">
          <div class="podium-score" style="color:${sc}">${score}</div>
          <div class="podium-score-label">Score</div>
        </div>
        <div class="podium-count-wrap">
          <div class="podium-count" style="color:${rankColor}">${op.cumulativeMissions ?? op.missionsCompleted}</div>
          <div class="podium-count-label">Total Tickets ${todayBadge}</div>
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

  // Header row
  const header = document.createElement('div');
  header.className = 'leaderboard-header';
  header.innerHTML = `
    <div class="leaderboard-header-cell">Rank</div>
    <div class="leaderboard-header-cell">Agent</div>
    <div class="leaderboard-header-cell right">Tickets</div>
    <div class="leaderboard-header-cell right">Avg Resolution</div>
    <div class="leaderboard-header-cell right">Score</div>
  `;
  elTable.appendChild(header);

  rest.forEach((op, idx) => {
    const rank       = idx + offset;
    const isInactive = op.cumulativeMissions === 0;

    const rankHtml = isInactive
      ? `<div class="row-rank inactive-rank">—</div>`
      : `<div class="row-rank">${rank}</div>`;

    const displayRes = op.cumulativeAvgResolutionMs ?? op.avgResolutionTimeMs;
    const resPill    = buildStatPill('Avg Res', displayRes, 'resolution');
    const sc         = scoreColor(op.performanceScore);

    const row = document.createElement('div');
    row.className = `leaderboard-row${isInactive ? ' inactive' : ''}`;
    row.style.animationDelay = `${Math.min(idx * 0.03, 0.6)}s`;

    const cumTotal   = op.cumulativeMissions ?? op.missionsCompleted;
    const todayLabel = op.missionsCompleted > 0
      ? `<span class="today-badge">+${op.missionsCompleted} today</span>` : '';

    row.innerHTML = `
      ${rankHtml}
      <div class="row-info">
        <div class="row-name">${escapeHtml(op.name)}</div>
        <div class="row-tier-wrap">${getTierBadge(op.tier, op.tierColor)}</div>
      </div>
      <div class="row-missions-wrap">
        <div class="row-missions">${cumTotal}</div>
        <div class="row-missions-label">${todayLabel}</div>
      </div>
      <div class="row-stats">
        ${resPill || '<span class="stat-pill">—</span>'}
      </div>
      <div class="row-score-wrap">
        <div class="row-score" style="color:${sc}">${fmtScore(op.performanceScore)}</div>
        <div class="row-score-label">Score</div>
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

  const cumTotal = operatives.reduce((s, op) => s + (op.cumulativeMissions ?? op.missionsCompleted), 0);
  elTotalMissions.textContent = cumTotal || data.totalMissions || '0';
  elSquadSize.textContent     = operatives.filter(op => op.missionsCompleted > 0).length || data.squadSize || '0';

  const leader = operatives[0];
  elSquadLeader.textContent = leader ? leader.name : '—';

  elDayCounter.textContent  = data.dayNumber ? `Day ${data.dayNumber} · ${data.date || ''}` : 'Support Leaderboard';
  elLastUpdated.textContent = `Updated ${formatLastUpdated(data.lastUpdated)}`;

  const top3 = operatives.slice(0, Math.min(3, operatives.length));
  const rest  = operatives.slice(top3.length);

  renderPodium(top3, operatives);
  renderTable(rest, top3.length + 1, operatives);

  document.getElementById('leaderboard-section').classList.toggle('hidden', rest.length === 0);
}

// ── Drawer ───────────────────────────────────────────────────

function openDrawer(op, rank, allOperatives) {
  const rankColor = getRankColor(rank);

  elDrawerRank.textContent = `#${rank}`;
  elDrawerRank.style.color = rankColor;
  elDrawerName.textContent = op.name;
  elDrawerMeta.innerHTML   = getTierBadge(op.tier, op.tierColor);

  const activeOps = allOperatives.filter(o => o.cumulativeMissions > 0);
  const teamAvgTickets = activeOps.length
    ? activeOps.reduce((s,o) => s + o.cumulativeMissions, 0) / activeOps.length : 0;
  const teamAvgRes = (() => {
    const withRes = activeOps.filter(o => o.cumulativeAvgResolutionMs);
    return withRes.length
      ? withRes.reduce((s,o) => s + o.cumulativeAvgResolutionMs, 0) / withRes.length : 0;
  })();

  const cumTotal = op.cumulativeMissions ?? op.missionsCompleted;
  const avgRes   = op.cumulativeAvgResolutionMs ?? op.avgResolutionTimeMs;
  const minRes   = op.minResolutionTimeMs;
  const maxRes   = op.maxResolutionTimeMs;
  const resClass = avgRes ? (avgRes < teamAvgRes ? 'good' : avgRes > teamAvgRes * 1.5 ? 'bad' : '') : '';

  const sc = scoreColor(op.performanceScore);

  elDrawerMetrics.innerHTML = `
    <div class="metric-card full-width" style="text-align:center;">
      <div class="metric-value" style="color:${sc};font-size:2.4rem;">${fmtScore(op.performanceScore)}</div>
      <div class="metric-label">Performance Score</div>
      <div class="metric-sublabel" style="margin-top:6px;">
        Ticket Score <strong>${fmtScore(op.ticketScore)}</strong> × 60%
        &nbsp;+&nbsp;
        Resolution Score <strong>${op.resolutionScore != null ? fmtScore(op.resolutionScore) : 'N/A'}</strong> × 40%
      </div>
    </div>
    <div class="metric-card">
      <div class="metric-value" style="font-size:1.9rem;">${cumTotal}</div>
      <div class="metric-label">Total Tickets</div>
      <div class="metric-sublabel">All-time${op.missionsCompleted > 0 ? ` (+${op.missionsCompleted} today)` : ''}</div>
    </div>
    <div class="metric-card">
      <div class="metric-value ${resClass}">${formatDuration(avgRes)}</div>
      <div class="metric-label">Avg Resolution</div>
      <div class="metric-sublabel">All-time average</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${formatDuration(minRes)}</div>
      <div class="metric-label">Fastest Close</div>
      <div class="metric-sublabel">Best today</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${formatDuration(maxRes)}</div>
      <div class="metric-label">Slowest Close</div>
      <div class="metric-sublabel">Longest today</div>
    </div>
  `;

  const maxTickets    = Math.max(...activeOps.map(o => o.cumulativeMissions), 1);
  const ticketsPct    = Math.min((cumTotal / maxTickets) * 100, 100);
  const teamTickPct   = Math.min((teamAvgTickets / maxTickets) * 100, 100);
  let resBarPct = 0, resBarClass = 'neutral';
  if (avgRes && teamAvgRes) {
    resBarPct   = Math.min((teamAvgRes / avgRes) * 60, 100);
    resBarClass = avgRes < teamAvgRes ? 'good' : 'bad';
  }

  elDrawerVsTeam.innerHTML = `
    <div class="vs-team-label">vs. Team Average (All-time)</div>
    <div class="vs-bar-row">
      <div class="vs-bar-name">Tickets</div>
      <div class="vs-bar-track"><div class="vs-bar-fill ${ticketsPct >= teamTickPct ? 'good' : 'neutral'}" style="width:${ticketsPct}%"></div></div>
      <div class="vs-bar-val">${cumTotal} <span style="color:var(--text);font-size:10px;">/ avg ${teamAvgTickets.toFixed(1)}</span></div>
    </div>
    ${avgRes && teamAvgRes ? `
    <div class="vs-bar-row">
      <div class="vs-bar-name">Resolution</div>
      <div class="vs-bar-track"><div class="vs-bar-fill ${resBarClass}" style="width:${resBarPct}%"></div></div>
      <div class="vs-bar-val">${formatDuration(avgRes)} <span style="color:var(--text);font-size:10px;">/ avg ${formatDuration(teamAvgRes)}</span></div>
    </div>` : ''}
  `;

  const tickets = op.tickets || [];
  if (tickets.length > 0) {
    const rows = tickets.map(t => {
      const resMs    = t.resolutionTimeMs || 0;
      const resCls   = resMs > 0 ? (resMs < 2*3600000 ? 'good' : resMs > 8*3600000 ? 'bad' : '') : '';
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
    showBoard();
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

const elTrendsTab     = document.getElementById('trends-tab');
const elTrendsList    = document.getElementById('trends-list');
const elTrendsSearch  = document.getElementById('trends-search');
const elTrendsCount   = document.getElementById('trends-count');
const elTrendsLoading = document.getElementById('trends-loading');
const elTrendsEmpty   = document.getElementById('trends-empty');
const elSummaryBar    = document.querySelector('.summary-bar');
const elTabBtns       = document.querySelectorAll('.tab-btn');

let trendsData = null;

function formatDelta(delta, type) {
  if (delta === null || delta === undefined) return '';
  if (delta === 0) return '<span class="delta neutral">—</span>';
  if (type === 'missions') {
    const cls = delta > 0 ? 'up-good' : 'down-bad';
    return `<span class="delta ${cls}">${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}</span>`;
  }
  if (type === 'resolution') {
    const cls = delta < 0 ? 'down-good' : 'up-bad';
    return `<span class="delta ${cls}">${delta > 0 ? '↑' : '↓'}${formatDuration(Math.abs(delta))}</span>`;
  }
  return '';
}

// ── Charts ───────────────────────────────────────────────────

function buildMissionsChart(daily) {
  const days = [...daily].reverse();
  if (days.length === 0) return '';

  const W = 560, H = 190;
  const ml = 36, mr = 14, mt = 18, mb = 36;
  const cW = W - ml - mr;
  const cH = H - mt - mb;

  const maxM = Math.max(...days.map(d => d.missionsCompleted), 1);
  const yMax = Math.max(Math.ceil(maxM * 1.2), 2);

  const yTickCount = 4;
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => {
    const val = Math.round((yMax / yTickCount) * i);
    const y   = mt + cH - Math.round((val / yMax) * cH);
    return { val, y };
  });

  const gridLines = yTicks.map(t =>
    `<line x1="${ml}" y1="${t.y}" x2="${W - mr}" y2="${t.y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
     <text x="${ml - 6}" y="${t.y + 4}" text-anchor="end" font-size="10" fill="var(--text-3)">${t.val}</text>`
  ).join('');

  const barW = Math.max(12, Math.floor(cW / days.length) - 5);
  const gap  = days.length > 1 ? (cW - barW * days.length) / (days.length - 1) : 0;

  const bars = days.map((d, i) => {
    const bh  = Math.max(2, Math.round((d.missionsCompleted / yMax) * cH));
    const x   = ml + i * (barW + gap);
    const y   = mt + cH - bh;
    const col = i === days.length - 1 ? 'var(--gold)' : 'rgba(255,255,255,0.18)';
    const tip = `${d.date}: ${d.missionsCompleted} ticket${d.missionsCompleted !== 1 ? 's' : ''}`;
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="3" fill="${col}" opacity="0.9"
            data-tip="${escapeHtml(tip)}" class="chart-item"/>
      <text x="${x + barW / 2}" y="${H - 8}" text-anchor="middle" font-size="9" fill="var(--text-3)">${d.date.slice(5)}</text>
    `;
  }).join('');

  const xAxis  = `<line x1="${ml}" y1="${mt + cH}" x2="${W - mr}" y2="${mt + cH}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;
  const yAxis  = `<line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + cH}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;
  const yLabel = `<text x="11" y="${mt + cH / 2 + 4}" text-anchor="middle" font-size="9" fill="var(--text-3)" transform="rotate(-90,11,${mt + cH / 2})">Tickets</text>`;
  const xLabel = `<text x="${ml + cW / 2}" y="${H}" text-anchor="middle" font-size="9" fill="var(--text-3)">Date</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible;">${gridLines}${xAxis}${yAxis}${yLabel}${xLabel}${bars}</svg>`;
}

function buildResChart(daily, uid) {
  const days = [...daily].reverse().filter(d => d.avgResolutionTimeMs);
  if (days.length < 2) return '';

  const W = 560, H = 180;
  const ml = 54, mr = 14, mt = 18, mb = 36;
  const cW = W - ml - mr;
  const cH = H - mt - mb;

  const vals = days.map(d => d.avgResolutionTimeMs);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const pad  = (maxV - minV) * 0.2 || maxV * 0.15 || 300000;
  const yMin = Math.max(0, minV - pad);
  const yMax = maxV + pad;
  const yRange = yMax - yMin || 1;

  const yTickCount = 4;
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => {
    const val = yMin + (yRange / yTickCount) * i;
    const y   = mt + cH - Math.round(((val - yMin) / yRange) * cH);
    return { val: Math.round(val), y };
  });

  const gridLines = yTicks.map(t =>
    `<line x1="${ml}" y1="${t.y}" x2="${W - mr}" y2="${t.y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
     <text x="${ml - 6}" y="${t.y + 4}" text-anchor="end" font-size="10" fill="var(--text-3)">${formatDurationShort(t.val)}</text>`
  ).join('');

  const stepX = cW / Math.max(days.length - 1, 1);
  const pts   = days.map((d, i) => {
    const x = ml + i * stepX;
    const y = mt + cH - Math.round(((d.avgResolutionTimeMs - yMin) / yRange) * cH);
    return { x, y, d };
  });

  const polyline = pts.map(p => `${p.x},${p.y}`).join(' ');
  const area     = `${pts[0].x},${mt + cH} ` + pts.map(p => `${p.x},${p.y}`).join(' ') + ` ${pts[pts.length-1].x},${mt + cH}`;

  const dots = pts.map((p, i) => {
    const isLast = i === pts.length - 1;
    const tip    = `${p.d.date}: ${formatDuration(p.d.avgResolutionTimeMs)}`;
    const fill   = isLast ? 'var(--gold)' : 'var(--surface-3)';
    const stroke = isLast ? 'var(--gold)' : 'rgba(255,255,255,0.3)';
    return `<circle cx="${p.x}" cy="${p.y}" r="${isLast ? 5 : 4}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"
              data-tip="${escapeHtml(tip)}" class="chart-item"/>`;
  }).join('');

  const labels = days.map((d, i) => {
    const p = pts[i];
    return `<text x="${p.x}" y="${H - 8}" text-anchor="middle" font-size="9" fill="var(--text-3)">${d.date.slice(5)}</text>`;
  }).join('');

  const xAxis  = `<line x1="${ml}" y1="${mt + cH}" x2="${W - mr}" y2="${mt + cH}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;
  const yAxis  = `<line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + cH}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;
  const yLabel = `<text x="11" y="${mt + cH / 2 + 4}" text-anchor="middle" font-size="9" fill="var(--text-3)" transform="rotate(-90,11,${mt + cH / 2})">Avg Res</text>`;
  const xLabel = `<text x="${ml + cW / 2}" y="${H}" text-anchor="middle" font-size="9" fill="var(--text-3)">Date</text>`;

  const gradId = `rg_${uid}`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible;">
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--gold)" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="var(--gold)" stop-opacity="0"/>
    </linearGradient></defs>
    ${gridLines}${xAxis}${yAxis}${yLabel}${xLabel}
    <polygon points="${area}" fill="url(#${gradId})"/>
    <polyline points="${polyline}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>
    ${dots}${labels}
  </svg>`;
}

// ── Chart Tooltip ────────────────────────────────────────────

function initChartTooltips() {
  const tooltip = document.getElementById('chart-tooltip');
  if (!tooltip) return;
  document.addEventListener('mousemove', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tooltip.classList.add('hidden'); return; }
    tooltip.textContent = el.dataset.tip;
    tooltip.classList.remove('hidden');
    tooltip.style.left = (e.pageX + 14) + 'px';
    tooltip.style.top  = (e.pageY - 38) + 'px';
  });
  document.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
}

// ── Render: Trends ───────────────────────────────────────────

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

  elTrendsList.innerHTML = filtered.map((agent, agentIdx) => {
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

    const totalTickets = agent.daily.reduce((s, d) => s + d.missionsCompleted, 0);
    const avgTickets   = agent.daysTracked > 0 ? (totalTickets / agent.daysTracked).toFixed(1) : '—';
    const resEntries   = agent.daily.filter(d => d.avgResolutionTimeMs);
    const avgRes       = resEntries.length
      ? Math.round(resEntries.reduce((s, d) => s + d.avgResolutionTimeMs, 0) / resEntries.length)
      : null;

    const missionsChart = buildMissionsChart(agent.daily);
    const resChart      = buildResChart(agent.daily, agentIdx);

    return `
      <div class="trend-card">
        <div class="trend-card-header">
          <div>
            <div class="trend-agent-name">${escapeHtml(agent.name)}</div>
            <div class="trend-summary">
              <span class="trend-summary-item">${agent.daysTracked} day${agent.daysTracked !== 1 ? 's' : ''}</span>
              <span class="trend-summary-item">avg <strong>${avgTickets}</strong> tickets/day</span>
              ${avgRes ? `<span class="trend-summary-item">avg resolution <strong>${formatDuration(avgRes)}</strong></span>` : ''}
            </div>
          </div>
        </div>
        <div class="trend-charts">
          <div class="trend-chart-wrap">
            <div class="trend-chart-label">Tickets Closed per Day</div>
            ${missionsChart}
          </div>
          ${resChart ? `<div class="trend-chart-wrap">
            <div class="trend-chart-label">Avg Resolution Time per Day</div>
            ${resChart}
          </div>` : ''}
        </div>
        <div class="trend-table">
          <div class="trend-row trend-header-row">
            <div class="trend-cell trend-date">Date</div>
            <div class="trend-cell trend-missions">Tickets</div>
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

elTrendsSearch.addEventListener('input', () => {
  if (trendsData) renderTrends(trendsData, elTrendsSearch.value.trim());
});

initChartTooltips();
