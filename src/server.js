const path = require('path');
const fs = require('fs');
const express = require('express');
const cron = require('node-cron');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { fetchLeaderboardData } = require('./fetchData');

const app = express();
const PORT = 3000;
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

// GET /api/leaderboard
app.get('/api/leaderboard', (req, res) => {
  const data = readLeaderboard();
  if (!data) {
    return res.status(404).json({ error: 'No data yet', noData: true });
  }
  res.json(data);
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
  app.listen(PORT, () => {
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
