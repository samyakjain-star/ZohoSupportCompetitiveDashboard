const path = require('path');
const fs = require('fs');
const express = require('express');
const cron = require('node-cron');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { fetchLeaderboardData } = require('./fetchData');

const app = express();
const PORT = process.env.PORT || 3000;
const LEADERBOARD_PATH = path.join(__dirname, '../data/leaderboard.json');
const HISTORY_PATH     = path.join(__dirname, '../data/history.json');

// IST offset: UTC+5:30
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getTodayISTDateString() {
  const nowIST = Date.now() + IST_OFFSET_MS;
  const d = new Date(nowIST);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readLeaderboard() {
  if (!fs.existsSync(LEADERBOARD_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(LEADERBOARD_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// Serve static files from public/
app.use(express.static(path.join(__dirname, '../public')));

function computeCumulative() {
  if (!fs.existsSync(HISTORY_PATH)) return {};
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    const totals = {};
    for (const ticket of Object.values(history.tickets)) {
      if (!Array.isArray(ticket.assignees) || !ticket.assignees.length) continue;
      const assignee = ticket.assignees[0];
      const id = assignee.id;
      if (!totals[id]) totals[id] = { cumulativeMissions: 0, name: assignee.name };
      totals[id].cumulativeMissions++;
    }
    return totals;
  } catch { return {}; }
}

// GET /api/leaderboard
app.get('/api/leaderboard', (req, res) => {
  const data = readLeaderboard();
  if (!data) {
    return res.status(404).json({ error: 'No data yet', noData: true });
  }

  // Enrich each operative with cumulative all-time missions from history
  const cumulative = computeCumulative();
  const operatives = (data.operatives || []).map(op => ({
    ...op,
    cumulativeMissions: cumulative[op.id]?.cumulativeMissions ?? op.missionsCompleted,
  }));

  // Add agents present in history but not in today's data (0 tickets today)
  for (const [id, cum] of Object.entries(cumulative)) {
    if (!operatives.find(o => o.id === id)) {
      const { tier, tierColor } = (() => {
        const c = cum.cumulativeMissions;
        if (c >= 20) return { tier: 'Squad Leader', tierColor: '#00FFB2' };
        if (c >= 15) return { tier: 'Veteran',      tierColor: '#FFB800' };
        if (c >= 10) return { tier: 'Field Agent',  tierColor: '#00C9FF' };
        if (c >= 5)  return { tier: 'Recruit',      tierColor: '#D1D5DB' };
        if (c >= 1)  return { tier: 'Trainee',      tierColor: '#A78BFA' };
        return           { tier: 'Inactive',     tierColor: '#FF4C6A' };
      })();
      operatives.push({
        id, name: cum.name, missionsCompleted: 0,
        cumulativeMissions: cum.cumulativeMissions,
        avgResolutionTimeMs: null, avgFirstResponseTimeMs: null,
        minResolutionTimeMs: null, maxResolutionTimeMs: null,
        tickets: [], tier, tierColor,
      });
    }
  }

  // Re-sort by cumulativeMissions desc, tie-break: today's missions desc, then avg res asc
  operatives.sort((a, b) => {
    if (b.cumulativeMissions !== a.cumulativeMissions) return b.cumulativeMissions - a.cumulativeMissions;
    if (b.missionsCompleted !== a.missionsCompleted) return b.missionsCompleted - a.missionsCompleted;
    if (a.avgResolutionTimeMs === null) return 1;
    if (b.avgResolutionTimeMs === null) return -1;
    return a.avgResolutionTimeMs - b.avgResolutionTimeMs;
  });

  res.json({ ...data, operatives });
});

// GET /api/history
app.get('/api/history', (req, res) => {
  if (!fs.existsSync(HISTORY_PATH)) {
    return res.status(404).json({ error: 'No history yet', noData: true });
  }
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Failed to read history' });
  }
});

// GET /api/history/agent/:id — derive all-time stats from ticket logs
app.get('/api/history/agent/:id', (req, res) => {
  if (!fs.existsSync(HISTORY_PATH)) {
    return res.status(404).json({ error: 'No history yet' });
  }
  try {
    const agentId = req.params.id;
    const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));

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
app.get('/api/trends', (req, res) => {
  if (!fs.existsSync(HISTORY_PATH)) {
    return res.status(404).json({ error: 'No history yet', noData: true });
  }
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    const tickets = Object.values(history.tickets);

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

// Schedule daily fetch at 3:30 AM UTC (9:00 AM IST)
cron.schedule('30 3 * * *', async () => {
  console.log('[cron] Scheduled fetch triggered at 3:30 AM UTC (9:00 AM IST)');
  try {
    await fetchLeaderboardData();
    console.log('[cron] Scheduled fetch completed successfully');
  } catch (err) {
    console.error('[cron] Scheduled fetch failed:', err.message);
  }
});

async function startServer() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] Op Board running at http://localhost:${PORT}`);
    console.log(`[server] Static files served from: ${path.join(__dirname, '../public')}`);
  });

  // Check if we need to fetch fresh data on startup
  const existingData = readLeaderboard();
  const todayIST = getTodayISTDateString();

  if (!existingData) {
    console.log('[server] No leaderboard data found. Fetching fresh data...');
    try {
      await fetchLeaderboardData();
      console.log('[server] Initial fetch completed successfully');
    } catch (err) {
      console.error('[server] Initial fetch failed:', err.message);
    }
  } else if (existingData.date !== todayIST) {
    console.log(`[server] Cached data is from ${existingData.date}, but today is ${todayIST}. Fetching fresh data...`);
    try {
      await fetchLeaderboardData();
      console.log('[server] Startup refresh completed successfully');
    } catch (err) {
      console.error('[server] Startup refresh failed:', err.message);
    }
  } else {
    console.log(`[server] Using cached leaderboard data from ${existingData.date} (last updated: ${existingData.lastUpdated})`);
  }
}

startServer().catch(err => {
  console.error('[server] Fatal startup error:', err.message);
  process.exit(1);
});
