const path = require('path');
const express = require('express');
const cron = require('node-cron');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { fetchLeaderboardData, fetchDataForDate } = require('./fetchData');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const IST_OFFSET_MS  = 5.5 * 60 * 60 * 1000;
const LAUNCH_DATE_MS = new Date('2026-05-12T00:00:00.000Z').getTime();

function getTodayISTDateString() {
  const nowIST = Date.now() + IST_OFFSET_MS;
  const d = new Date(nowIST);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDayNumber() {
  return Math.max(1, Math.floor((Date.now() - LAUNCH_DATE_MS) / 86_400_000) + 1);
}

// Build today's leaderboard snapshot from all tickets in the DB.
// Replaces the leaderboard.json that fetchData.js used to write.
async function buildLeaderboardFromDb() {
  const tickets = await db.loadAllTickets();
  const todayStr = getTodayISTDateString();

  const todayStats = {};
  const todayNames = {};
  for (const t of tickets) {
    if (t.dateClosed !== todayStr) continue;
    if (!Array.isArray(t.assignees) || !t.assignees.length) continue;
    const a = t.assignees[0];
    todayNames[a.id] = a.name;
    if (!todayStats[a.id]) {
      todayStats[a.id] = { count: 0, totalRes: 0, resCount: 0, min: null, max: null, list: [] };
    }
    const s = todayStats[a.id];
    s.count++;
    if (t.resolutionTimeMs) {
      s.totalRes += t.resolutionTimeMs;
      s.resCount++;
      if (s.min === null || t.resolutionTimeMs < s.min) s.min = t.resolutionTimeMs;
      if (s.max === null || t.resolutionTimeMs > s.max) s.max = t.resolutionTimeMs;
      s.list.push({
        id: t.id,
        ticketNumber: t.ticketNumber,
        subject: t.subject,
        resolutionTimeMs: t.resolutionTimeMs,
        closedTime: t.closedTime,
      });
    }
  }

  const operatives = Object.entries(todayStats).map(([id, s]) => ({
    id,
    name: todayNames[id],
    missionsCompleted: s.count,
    avgResolutionTimeMs: s.resCount > 0 ? Math.round(s.totalRes / s.resCount) : null,
    avgFirstResponseTimeMs: null,
    minResolutionTimeMs: s.min,
    maxResolutionTimeMs: s.max,
    tickets: s.list.sort((a, b) => a.resolutionTimeMs - b.resolutionTimeMs),
  }));

  return {
    lastUpdated:   new Date().toISOString(),
    date:          todayStr,
    dayNumber:     getDayNumber(),
    totalMissions: operatives.reduce((sum, o) => sum + o.missionsCompleted, 0),
    squadSize:     operatives.filter(o => o.missionsCompleted > 0).length,
    operatives,
  };
}

// Serve static files from public/
app.use(express.static(path.join(__dirname, '../public')));

// Assign tier by percentile rank (1-indexed) among active agents.
// Top 15% = Elite, next 20% = High Performer, next 30% = Proficient,
// next 20% = Developing, bottom 15% = Beginner. Score-0 agents = Inactive.
function assignTierByRank(rank, totalActive) {
  const pct = rank / totalActive;
  if (pct <= 0.15) return { tier: 'Elite',          tierColor: '#E8B84B' };
  if (pct <= 0.35) return { tier: 'High Performer', tierColor: '#4ADE80' };
  if (pct <= 0.65) return { tier: 'Proficient',     tierColor: '#00C9FF' };
  if (pct <= 0.85) return { tier: 'Developing',     tierColor: '#9CA8B5' };
  return                { tier: 'Beginner',        tierColor: '#A78BFA' };
}

const INACTIVE_TIER = { tier: 'Inactive', tierColor: '#FF4C6A' };

async function computeCumulativeStats() {
  // Live tickets currently in the DB (within the 30-day retention window)
  const tickets = await db.loadAllTickets();
  const stats = {};
  for (const ticket of tickets) {
    if (!Array.isArray(ticket.assignees) || !ticket.assignees.length) continue;
    const assignee = ticket.assignees[0];
    const id = assignee.id;
    if (!stats[id]) stats[id] = { count: 0, name: assignee.name, totalResMs: 0, resCount: 0 };
    stats[id].count++;
    if (ticket.resolutionTimeMs) {
      stats[id].totalResMs += ticket.resolutionTimeMs;
      stats[id].resCount++;
    }
  }

  // Merge in archived stats from agent_stats (tickets older than retention window)
  const archived = await db.getAgentStats();
  for (const [id, a] of Object.entries(archived)) {
    if (!stats[id]) stats[id] = { count: 0, name: a.name, totalResMs: 0, resCount: 0 };
    stats[id].count       += a.archivedMissions;
    stats[id].totalResMs  += a.archivedTotalResolutionMs;
    stats[id].resCount    += a.archivedResolutionCount;
    if (!stats[id].name) stats[id].name = a.name;
  }

  for (const s of Object.values(stats)) {
    s.cumulativeMissions = s.count;
    s.cumulativeAvgResolutionMs = s.resCount > 0 ? Math.round(s.totalResMs / s.resCount) : null;
  }
  return stats;
}

// Team-wide resolution metrics: today's avg, yesterday's avg, % delta,
// and the all-time cumulative avg (live tickets + agent_stats archive).
async function computeTeamResolutionStats(todayStr) {
  const tickets = await db.loadAllTickets();

  const ymd = new Date(todayStr + 'T00:00:00Z').getTime();
  const yest = new Date(ymd - 86400000);
  const yesterdayStr = `${yest.getUTCFullYear()}-${String(yest.getUTCMonth() + 1).padStart(2, '0')}-${String(yest.getUTCDate()).padStart(2, '0')}`;

  let todaySum = 0, todayCount = 0;
  let yestSum  = 0, yestCount  = 0;
  let liveSum  = 0, liveCount  = 0;

  for (const t of tickets) {
    if (!t.resolutionTimeMs) continue;
    liveSum  += t.resolutionTimeMs;
    liveCount++;
    if (t.dateClosed === todayStr) {
      todaySum  += t.resolutionTimeMs;
      todayCount++;
    } else if (t.dateClosed === yesterdayStr) {
      yestSum  += t.resolutionTimeMs;
      yestCount++;
    }
  }

  // Roll in archived stats (tickets that have already been purged from `tickets`)
  const archived = await db.getAgentStats();
  let archSum = 0, archCount = 0;
  for (const a of Object.values(archived)) {
    archSum   += a.archivedTotalResolutionMs;
    archCount += a.archivedResolutionCount;
  }

  const todayAvg = todayCount > 0 ? Math.round(todaySum / todayCount) : null;
  const yestAvg  = yestCount  > 0 ? Math.round(yestSum  / yestCount)  : null;
  const cumAvg   = (liveCount + archCount) > 0
    ? Math.round((liveSum + archSum) / (liveCount + archCount))
    : null;

  let deltaPct = null;
  if (todayAvg !== null && yestAvg !== null && yestAvg > 0) {
    deltaPct = Math.round(((todayAvg - yestAvg) / yestAvg) * 1000) / 10;
  }

  return {
    teamAvgResolutionTodayMs:     todayAvg,
    teamAvgResolutionPrevDayMs:   yestAvg,
    teamAvgResolutionDeltaPct:    deltaPct,
    teamCumulativeAvgResolutionMs: cumAvg,
  };
}

// GET /api/leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const data = await buildLeaderboardFromDb();
    const cumStats = await computeCumulativeStats();
    if (data.operatives.length === 0 && Object.keys(cumStats).length === 0) {
      return res.status(404).json({ error: 'No data yet', noData: true });
    }

  // Enrich with cumulative data (no tier yet — assigned after score computation)
  const operatives = (data.operatives || []).map(op => {
    const cum = cumStats[op.id];
    const cumulativeMissions = cum?.cumulativeMissions ?? op.missionsCompleted;
    return {
      ...op,
      cumulativeMissions,
      cumulativeAvgResolutionMs: cum?.cumulativeAvgResolutionMs ?? null,
    };
  });

  // Add agents in history who had 0 tickets today
  for (const [id, cum] of Object.entries(cumStats)) {
    if (!operatives.find(o => o.id === id)) {
      operatives.push({
        id, name: cum.name, missionsCompleted: 0,
        cumulativeMissions: cum.cumulativeMissions,
        cumulativeAvgResolutionMs: cum.cumulativeAvgResolutionMs,
        avgResolutionTimeMs: null, avgFirstResponseTimeMs: null,
        minResolutionTimeMs: null, maxResolutionTimeMs: null,
        tickets: [],
      });
    }
  }

  // Compute performance score (tier assigned later by rank)
  const scored = operatives.map(op => {
    const others = operatives.filter(o => o.id !== op.id && o.cumulativeMissions > 0);

    if (op.cumulativeMissions === 0) {
      return { ...op, ticketScore: 0, resolutionScore: null, performanceScore: 0 };
    }
    if (others.length === 0) {
      return { ...op, ticketScore: 100, resolutionScore: null, performanceScore: 100 };
    }

    const avgOthersTickets = others.reduce((s, o) => s + o.cumulativeMissions, 0) / others.length;
    const ticketScore = avgOthersTickets > 0
      ? Math.round((op.cumulativeMissions / avgOthersTickets) * 1000) / 10
      : 100;

    const othersWithRes = others.filter(o => o.cumulativeAvgResolutionMs);
    let resolutionScore = null;
    if (op.cumulativeAvgResolutionMs && othersWithRes.length > 0) {
      const avgOthersRes = othersWithRes.reduce((s, o) => s + o.cumulativeAvgResolutionMs, 0) / othersWithRes.length;
      resolutionScore = Math.round((avgOthersRes / op.cumulativeAvgResolutionMs) * 1000) / 10;
    }

    const performanceScore = resolutionScore !== null
      ? Math.round((0.6 * ticketScore + 0.4 * resolutionScore) * 10) / 10
      : Math.round(ticketScore * 10) / 10;

    return { ...op, ticketScore, resolutionScore, performanceScore };
  });

  // Sort by performanceScore desc, tie-break: cumulativeMissions desc
  scored.sort((a, b) => {
    if (b.performanceScore !== a.performanceScore) return b.performanceScore - a.performanceScore;
    return b.cumulativeMissions - a.cumulativeMissions;
  });

  // Assign tier by rank among active agents (Inactive for score <= 0)
  const activeCount = scored.filter(o => o.performanceScore > 0).length;
  let activeRank = 0;
  const final = scored.map(op => {
    if (op.performanceScore <= 0) return { ...op, ...INACTIVE_TIER };
    activeRank++;
    return { ...op, ...assignTierByRank(activeRank, activeCount) };
  });

    const teamStats = await computeTeamResolutionStats(data.date);
    res.json({ ...data, ...teamStats, operatives: final });
  } catch (err) {
    console.error('[server] /api/leaderboard error:', err.message);
    res.status(500).json({ error: 'Failed to build leaderboard: ' + err.message });
  }
});

// GET /api/history
app.get('/api/history', async (req, res) => {
  try {
    const data = await db.loadHistoryShape();
    res.json(data);
  } catch (err) {
    console.error('[server] /api/history error:', err.message);
    res.status(500).json({ error: 'Failed to read history' });
  }
});

// GET /api/history/agent/:id — derive all-time stats from ticket logs
app.get('/api/history/agent/:id', async (req, res) => {
  try {
    const agentId = req.params.id;
    const history = await db.loadHistoryShape();

    // Find all tickets where this agent appears as an assignee
    const agentTickets = Object.values(history.tickets).filter(t =>
      Array.isArray(t.assignees) && t.assignees.some(a => a.id === agentId)
    );

    if (agentTickets.length === 0) {
      return res.status(404).json({ error: 'Agent not found in ticket history' });
    }

    // Derive agent name from most recent appearance
    const latestAssignment = agentTickets
      .flatMap(t => t.assignees.filter(a => a.id === agentId))
      .sort((a, b) => new Date(b.seenAt) - new Date(a.seenAt))[0];
    const agentName = latestAssignment?.name || agentId;

    // Compute per-day stats from tickets
    const dailyStats = {};
    for (const ticket of agentTickets) {
      const day = ticket.dateClosed;
      if (!day) continue;
      if (!dailyStats[day]) {
        dailyStats[day] = { missionsCompleted: 0, totalResMs: 0, resCount: 0, ticketIds: [] };
      }
      dailyStats[day].missionsCompleted++;
      dailyStats[day].ticketIds.push(ticket.id);
      if (ticket.resolutionTimeMs) {
        dailyStats[day].totalResMs += ticket.resolutionTimeMs;
        dailyStats[day].resCount++;
      }
    }
    // Finalize daily averages
    for (const day of Object.keys(dailyStats)) {
      const d = dailyStats[day];
      d.avgResolutionTimeMs = d.resCount > 0 ? Math.round(d.totalResMs / d.resCount) : null;
      delete d.totalResMs;
      delete d.resCount;
    }

    res.json({ id: agentId, name: agentName, dailyStats, tickets: agentTickets });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute agent stats' });
  }
});

// GET /api/trends — per-agent daily stats derived from ticket history
app.get('/api/trends', async (req, res) => {
  try {
    const tickets = await db.loadAllTickets();

    // Group tickets by agentId → date
    const agentDayMap = {};
    const agentNames  = {};

    for (const ticket of tickets) {
      if (!ticket.dateClosed || !Array.isArray(ticket.assignees) || !ticket.assignees.length) continue;
      const assignee = ticket.assignees[0];
      const agentId  = assignee.id;
      agentNames[agentId] = assignee.name;
      if (!agentDayMap[agentId]) agentDayMap[agentId] = {};
      if (!agentDayMap[agentId][ticket.dateClosed]) agentDayMap[agentId][ticket.dateClosed] = [];
      agentDayMap[agentId][ticket.dateClosed].push(ticket);
    }

    const agents = Object.entries(agentDayMap).map(([agentId, dayMap]) => {
      const sortedDates = Object.keys(dayMap).sort();

      const daily = sortedDates.map((date, idx) => {
        const dayTickets  = dayMap[date];
        const missions    = dayTickets.length;
        const resTickets  = dayTickets.filter(t => t.resolutionTimeMs);
        const avgRes      = resTickets.length
          ? Math.round(resTickets.reduce((s, t) => s + t.resolutionTimeMs, 0) / resTickets.length)
          : null;
        const minRes = resTickets.length ? Math.min(...resTickets.map(t => t.resolutionTimeMs)) : null;
        const maxRes = resTickets.length ? Math.max(...resTickets.map(t => t.resolutionTimeMs)) : null;

        // Delta vs previous day
        let deltaM = null, deltaR = null;
        if (idx > 0) {
          const prev         = dayMap[sortedDates[idx - 1]];
          const prevMissions = prev.length;
          const prevRes      = prev.filter(t => t.resolutionTimeMs);
          const prevAvgRes   = prevRes.length
            ? Math.round(prevRes.reduce((s, t) => s + t.resolutionTimeMs, 0) / prevRes.length)
            : null;
          deltaM = missions - prevMissions;
          deltaR = (avgRes && prevAvgRes) ? avgRes - prevAvgRes : null;
        }

        return { date, missionsCompleted: missions, avgResolutionTimeMs: avgRes, minResolutionTimeMs: minRes, maxResolutionTimeMs: maxRes, deltaM, deltaR };
      });

      return { id: agentId, name: agentNames[agentId], daysTracked: sortedDates.length, daily: daily.reverse() };
    });

    agents.sort((a, b) => a.name.localeCompare(b.name));
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute trends' });
  }
});

// POST /api/fetch-historical  body: { date: "YYYY-MM-DD" }
app.post('/api/fetch-historical', express.json(), async (req, res) => {
  const { date } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Provide date as YYYY-MM-DD in request body' });
  }
  console.log(`[server] Historical fetch triggered for ${date}`);
  try {
    const result = await fetchDataForDate(date);
    console.log(`[server] Historical fetch done: ${result.newTickets} new tickets for ${date}`);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[server] Historical fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/refresh
app.post('/api/refresh', async (req, res) => {
  console.log('[server] Manual refresh triggered via POST /api/refresh');
  try {
    await fetchLeaderboardData();
    console.log('[server] Manual refresh completed successfully');
    res.json({ success: true });
  } catch (err) {
    console.error('[server] Manual refresh failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Schedule daily fetch at 3:30 PM UTC (9:00 PM IST)
cron.schedule('30 15 * * *', async () => {
  console.log('[cron] Scheduled fetch triggered at 3:30 PM UTC (9:00 PM IST)');
  try {
    await fetchLeaderboardData();
    console.log('[cron] Scheduled fetch completed successfully');
  } catch (err) {
    console.error('[cron] Scheduled fetch failed:', err.message);
  }
});

// Daily archive at 11:00 PM UTC (4:30 AM IST): aggregate tickets older
// than 30 days into agent_stats and delete them from the tickets table.
// Cumulative counts and avg resolution time survive via agent_stats.
cron.schedule('0 23 * * *', async () => {
  console.log('[cron] Archive sweep triggered (retention = 30 days)');
  try {
    const r = await db.archiveOldTickets(30);
    console.log(`[cron] Archive complete: cutoff=${r.cutoff}, ${r.archivedAgents} agents touched, ${r.deletedTickets} tickets deleted`);
  } catch (err) {
    console.error('[cron] Archive sweep failed:', err.message);
  }
});

function istDateFromIso(iso) {
  if (!iso) return null;
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

async function startServer() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] Op Board running at http://localhost:${PORT}`);
    console.log(`[server] Static files served from: ${path.join(__dirname, '../public')}`);
  });

  // First boot: import any committed history.json if the DB is empty
  try {
    await db.migrateFromJsonIfEmpty();
  } catch (err) {
    console.error('[server] Migration check failed:', err.message);
  }

  // Fetch fresh data on startup if we haven't already fetched today
  const todayIST = getTodayISTDateString();
  let lastFetchedAt = null;
  try {
    lastFetchedAt = await db.getLatestFetchedAt();
  } catch (err) {
    console.error('[server] Could not check DB for last fetch:', err.message);
  }
  const lastFetchedDate = istDateFromIso(lastFetchedAt);

  if (!lastFetchedAt) {
    console.log('[server] No tickets in DB. Fetching fresh data...');
    try { await fetchLeaderboardData(); } catch (err) { console.error('[server] Initial fetch failed:', err.message); }
  } else if (lastFetchedDate !== todayIST) {
    console.log(`[server] Last fetch was ${lastFetchedDate}, today is ${todayIST}. Fetching fresh data...`);
    try { await fetchLeaderboardData(); } catch (err) { console.error('[server] Startup refresh failed:', err.message); }
  } else {
    console.log(`[server] DB already has data from ${lastFetchedDate} (last fetched: ${lastFetchedAt})`);
  }
}

startServer().catch(err => {
  console.error('[server] Fatal startup error:', err.message);
  process.exit(1);
});
