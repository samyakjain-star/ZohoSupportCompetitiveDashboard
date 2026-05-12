const path = require('path');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getAccessToken, refreshAccessToken } = require('./tokenManager');

const DATA_DIR = path.join(__dirname, '../data');
const LEADERBOARD_PATH = path.join(DATA_DIR, 'leaderboard.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const BASE_URL = process.env.BASE_URL?.trim().replace(/^"|"$/g, '');
const ORG_ID = process.env.ORG_ID?.trim().replace(/^"|"$/g, '');

// Launch date for day counter
const LAUNCH_DATE = new Date('2026-05-12T00:00:00.000Z');

// IST offset: UTC+5:30
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getTodayISTRange() {
  const nowUTC = Date.now();
  const nowIST = nowUTC + IST_OFFSET_MS;
  const nowISTDate = new Date(nowIST);

  // Midnight IST today
  const startIST = new Date(nowISTDate);
  startIST.setUTCHours(0, 0, 0, 0);

  // 23:59:59.999 IST today
  const endIST = new Date(nowISTDate);
  endIST.setUTCHours(23, 59, 59, 999);

  // Convert back to UTC timestamps for comparison
  const startUTC = startIST.getTime() - IST_OFFSET_MS;
  const endUTC = endIST.getTime() - IST_OFFSET_MS;

  // The IST date string YYYY-MM-DD
  const year = startIST.getUTCFullYear();
  const month = String(startIST.getUTCMonth() + 1).padStart(2, '0');
  const day = String(startIST.getUTCDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  return { startUTC, endUTC, dateStr };
}

function getDayNumber() {
  const nowUTC = Date.now();
  const diffMs = nowUTC - LAUNCH_DATE.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1;
  return Math.max(1, diffDays);
}


function assignTier(count) {
  if (count >= 20) return { tier: 'Squad Leader', tierColor: '#00FFB2' };
  if (count >= 15) return { tier: 'Veteran', tierColor: '#FFB800' };
  if (count >= 10) return { tier: 'Field Agent', tierColor: '#00C9FF' };
  if (count >= 5)  return { tier: 'Recruit', tierColor: '#D1D5DB' };
  if (count >= 1)  return { tier: 'Trainee', tierColor: '#A78BFA' };
  return { tier: 'Inactive', tierColor: '#FF4C6A' };
}

async function makeRequest(url, params, token) {
  return axios.get(url, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      orgId: ORG_ID,
    },
    params,
  });
}

async function fetchClosedTicketsToday(token, todayStart, todayEnd) {
  const tickets = [];
  let from = 0;
  const limit = 100;

  while (true) {
    let resp;
    try {
      resp = await makeRequest(`${BASE_URL}/tickets`, { from, limit, status: 'Closed', include: 'assignee' }, token);
    } catch (err) {
      if (err.response && err.response.status === 401) {
        token = await refreshAccessToken();
        resp = await makeRequest(`${BASE_URL}/tickets`, { from, limit, status: 'Closed', include: 'assignee' }, token);
      } else {
        throw err;
      }
    }

    const page = resp.data.data || [];
    if (page.length === 0) break;

    let foundAnyToday = false;
    for (const ticket of page) {
      const ct = ticket.closedTime ? new Date(ticket.closedTime).getTime() : null;
      if (ct && ct >= todayStart && ct <= todayEnd) {
        tickets.push(ticket);
        foundAnyToday = true;
      }
    }

    if (page.length < limit) break;
    if (!foundAnyToday) break;
    from += limit;
  }

  return tickets;
}

function loadHistory() {
  if (fs.existsSync(HISTORY_PATH)) {
    try {
      const h = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      // Migrate: drop legacy agents block if present
      delete h.agents;
      return h;
    } catch {}
  }
  return { tickets: {}, runs: [] };
}

function saveHistory(history) {
  history.lastUpdated = new Date().toISOString();
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function updateHistory(history, tickets, operatives, dateStr, fetchedAt) {
  let newTickets = 0;

  for (const ticket of tickets) {
    const assigneeId   = String(ticket.assigneeId || (ticket.assignee && ticket.assignee.id) || '');
    const assigneeName = ticket.assignee
      ? ((ticket.assignee.firstName || '') + ' ' + (ticket.assignee.lastName || '')).trim().toUpperCase()
      : null;
    const resMs = (() => {
      const c  = ticket.createdTime ? new Date(ticket.createdTime).getTime() : null;
      const cl = ticket.closedTime  ? new Date(ticket.closedTime).getTime()  : null;
      return (c && cl && cl > c) ? cl - c : null;
    })();

    if (!history.tickets[ticket.id]) {
      // New ticket — create full record
      newTickets++;
      history.tickets[ticket.id] = {
        id:              ticket.id,
        ticketNumber:    ticket.ticketNumber || ticket.id,
        subject:         ticket.subject || 'Untitled',
        createdTime:     ticket.createdTime || null,
        closedTime:      ticket.closedTime  || null,
        resolutionTimeMs: resMs,
        dateClosed:      dateStr,
        firstFetchedAt:  fetchedAt,
        // All assignees ever seen on this ticket, with timestamps
        assignees: assigneeId ? [{
          id:        assigneeId,
          name:      assigneeName,
          seenAt:    fetchedAt,
          role:      'closer',
        }] : [],
      };
    } else {
      // Ticket seen before — append assignee if new
      const stored = history.tickets[ticket.id];
      if (!Array.isArray(stored.assignees)) stored.assignees = []; // migrate old schema
      if (assigneeId) {
        const alreadySeen = stored.assignees.some(a => a.id === assigneeId);
        if (!alreadySeen) {
          stored.assignees.push({
            id:     assigneeId,
            name:   assigneeName,
            seenAt: fetchedAt,
            role:   'closer',
          });
        }
      }
      // Update closedTime/resMs if ticket was reopened and re-closed
      if (ticket.closedTime && ticket.closedTime !== stored.closedTime) {
        stored.closedTime      = ticket.closedTime;
        stored.resolutionTimeMs = resMs;
        stored.dateClosed      = dateStr;
      }
    }
  }

  // Append run log (one entry per fetch, not per day — useful for debugging)
  history.runs.push({
    date:            dateStr,
    fetchedAt:       fetchedAt,
    totalTickets:    tickets.length,
    newTicketsAdded: newTickets,
    squadSize:       operatives.filter(o => o.missionsCompleted > 0).length,
  });

  return newTickets;
}

async function fetchLeaderboardData() {
  console.log('[fetchData] Starting leaderboard data fetch...');

  // Ensure data directory exists
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const { startUTC, endUTC, dateStr } = getTodayISTRange();
  console.log(`[fetchData] Fetching data for IST date: ${dateStr}`);

  let token = await getAccessToken();

  // Fetch today's closed tickets (with assignee embedded via include=assignee)
  console.log('[fetchData] Fetching closed tickets for today...');
  const tickets = await fetchClosedTicketsToday(token, startUTC, endUTC);
  console.log(`[fetchData] Found ${tickets.length} closed tickets today`);

  // Aggregate per agent - build agent map from ticket assignee data
  const agentStats = {};
  const agentNames = {};

  for (const ticket of tickets) {
    const assignee = ticket.assignee;
    if (!assignee) continue;

    const agentId = String(assignee.id || '');
    if (!agentId) continue;

    // Capture name from assignee object
    if (!agentNames[agentId]) {
      const firstName = assignee.firstName || '';
      const lastName = assignee.lastName || '';
      const name = (firstName + ' ' + lastName).trim() || assignee.email || `AGENT ${agentId}`;
      agentNames[agentId] = name.toUpperCase();
    }

    if (!agentStats[agentId]) {
      agentStats[agentId] = {
        count: 0,
        totalResolutionMs: 0,
        resolutionCount: 0,
        minResolutionMs: null,
        maxResolutionMs: null,
        ticketList: [],
      };
    }

    const stats = agentStats[agentId];
    stats.count++;

    // Resolution time: closedTime - createdTime
    const createdTime = ticket.createdTime ? new Date(ticket.createdTime).getTime() : null;
    const closedTime = ticket.closedTime ? new Date(ticket.closedTime).getTime() : null;
    if (createdTime && closedTime && closedTime > createdTime) {
      const resMs = closedTime - createdTime;
      stats.totalResolutionMs += resMs;
      stats.resolutionCount++;
      if (stats.minResolutionMs === null || resMs < stats.minResolutionMs) stats.minResolutionMs = resMs;
      if (stats.maxResolutionMs === null || resMs > stats.maxResolutionMs) stats.maxResolutionMs = resMs;
      stats.ticketList.push({
        id: ticket.id,
        ticketNumber: ticket.ticketNumber || ticket.id,
        subject: ticket.subject || 'Untitled',
        resolutionTimeMs: resMs,
        closedTime: ticket.closedTime,
      });
    }
  }

  // Build operative list from agents seen in today's closed tickets
  const operatives = [];

  for (const [agentId, stats] of Object.entries(agentStats)) {
    const missionsCompleted = stats.count;
    const avgResolutionTimeMs = stats.resolutionCount > 0
      ? Math.round(stats.totalResolutionMs / stats.resolutionCount)
      : null;

    const { tier, tierColor } = assignTier(missionsCompleted);

    // Sort ticket list by resolution time ascending (fastest first)
    stats.ticketList.sort((a, b) => a.resolutionTimeMs - b.resolutionTimeMs);

    operatives.push({
      id: agentId,
      name: agentNames[agentId] || `AGENT ${agentId}`,
      missionsCompleted,
      avgResolutionTimeMs,
      avgFirstResponseTimeMs: null,
      minResolutionTimeMs: stats.minResolutionMs,
      maxResolutionTimeMs: stats.maxResolutionMs,
      tickets: stats.ticketList,
      tier,
      tierColor,
    });
  }

  // Sort: missionsCompleted desc, then avgResolutionTimeMs asc (faster wins ties), nulls last
  operatives.sort((a, b) => {
    if (b.missionsCompleted !== a.missionsCompleted) {
      return b.missionsCompleted - a.missionsCompleted;
    }
    // Tie-break: faster resolution time wins
    if (a.avgResolutionTimeMs === null && b.avgResolutionTimeMs === null) return 0;
    if (a.avgResolutionTimeMs === null) return 1;
    if (b.avgResolutionTimeMs === null) return -1;
    return a.avgResolutionTimeMs - b.avgResolutionTimeMs;
  });

  const totalMissions = operatives.reduce((sum, op) => sum + op.missionsCompleted, 0);
  const squadSize = operatives.filter(op => op.missionsCompleted > 0).length;
  const dayNumber = getDayNumber();

  const result = {
    lastUpdated: new Date().toISOString(),
    date: dateStr,
    dayNumber,
    totalMissions,
    squadSize,
    operatives,
  };

  fs.writeFileSync(LEADERBOARD_PATH, JSON.stringify(result, null, 2));
  console.log(`[fetchData] Leaderboard saved to ${LEADERBOARD_PATH}`);
  console.log(`[fetchData] Total missions: ${totalMissions}, Squad size: ${squadSize}, Operatives: ${operatives.length}`);

  // Persist history log
  const history = loadHistory();
  const fetchedAt = new Date().toISOString();
  const newTickets = updateHistory(history, tickets, operatives, dateStr, fetchedAt);
  saveHistory(history);
  const totalHistoricTickets = Object.keys(history.tickets).length;
  console.log(`[fetchData] History updated — ${newTickets} new tickets added (${totalHistoricTickets} total stored)`);
  console.log(`[fetchData] History saved to ${HISTORY_PATH}`);

  return result;
}

// Allow standalone execution
if (require.main === module) {
  fetchLeaderboardData()
    .then(() => {
      console.log('[fetchData] Done.');
      process.exit(0);
    })
    .catch(err => {
      console.error('[fetchData] Error:', err.message);
      if (err.response) {
        console.error('[fetchData] Response status:', err.response.status);
        console.error('[fetchData] Response data:', JSON.stringify(err.response.data, null, 2));
      }
      process.exit(1);
    });
}

module.exports = { fetchLeaderboardData };
