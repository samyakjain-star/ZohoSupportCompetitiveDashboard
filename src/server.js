const path = require('path');
const fs = require('fs');
const express = require('express');
const cron = require('node-cron');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { fetchLeaderboardData, fetchDataForDate } = require('./fetchData');

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

function assignTierFromCount(c) {
  if (c >= 20) return { tier: 'Champion',  tierColor: '#00FFB2' };
  if (c >= 15) return { tier: 'Expert',    tierColor: '#FFB800' };
  if (c >= 10) return { tier: 'Senior',    tierColor: '#00C9FF' };
  if (c >= 5)  return { tier: 'Associate', tierColor: '#D1D5DB' };
  if (c >= 1)  return { tier: 'Junior',    tierColor: '#A78BFA' };
  return           { tier: 'Inactive',  tierColor: '#FF4C6A' };
}

function computeCumulativeStats() {
  if (!fs.existsSync(HISTORY_PATH)) return {};
  try {
    const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    const stats = {};
    for (const ticket of Object.values(history.tickets)) {
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
    for (const s of Object.values(stats)) {
      s.cumulativeMissions = s.count;
      s.cumulativeAvgResolutionMs = s.resCount > 0 ? Math.round(s.totalResMs / s.resCount) : null;
    }
    return stats;
  } catch { return {}; }
}

// GET /api/leaderboard
app.get('/api/leaderboard', (req, res) => {
  const data = readLeaderboard();
  if (!data) {
    return res.status(404).json({ error: 'No data yet', noData: true });
  }

  const cumStats = computeCumulativeStats();

  // Enrich with cumulative data + recompute tier from cumulative count
  const operatives = (data.operatives || []).map(op => {
    const cum = cumStats[op.id];
    const cumulativeMissions = cum?.cumulativeMissions ?? op.missionsCompleted;
    return {
      ...op,
      cumulativeMissions,
      cumulativeAvgResolutionMs: cum?.cumulativeAvgResolutionMs ?? null,
      ...assignTierFromCount(cumulativeMissions),
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
        tickets: [], ...assignTierFromCount(cum.cumulativeMissions),
      });
    }
  }

  // Compute performance score for each agent (scored against others, self excluded)
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

  res.json({ ...data, operatives: scored });
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
