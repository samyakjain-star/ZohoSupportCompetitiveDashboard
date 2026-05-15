const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { getAccessToken, refreshAccessToken } = require('./tokenManager');
const db = require('./db');

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

// Fetch all closed tickets whose closedTime falls within [startUTC, endUTC].
// Unlike fetchClosedTicketsToday, this paginates until we've passed the range
// rather than stopping on the first page with no matches.
async function fetchClosedTicketsForRange(token, startUTC, endUTC) {
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

    let passedRange = false;
    for (const ticket of page) {
      const ct = ticket.closedTime ? new Date(ticket.closedTime).getTime() : null;
      if (ct && ct >= startUTC && ct <= endUTC) {
        tickets.push(ticket);
      } else if (ct && ct < startUTC) {
        // API returns newest-first; once we're before our range we're done
        passedRange = true;
      }
    }

    if (page.length < limit || passedRange) break;
    from += limit;
  }

  return tickets;
}

function getISTRangeForDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const startIST = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const endIST   = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  const startUTC = startIST.getTime() - IST_OFFSET_MS;
  const endUTC   = endIST.getTime()   - IST_OFFSET_MS;
  return { startUTC, endUTC, dateStr };
}

async function fetchDataForDate(dateStr) {
  console.log(`[fetchData] Fetching historical data for ${dateStr}...`);

  const { startUTC, endUTC } = getISTRangeForDate(dateStr);
  const token = await getAccessToken();
  const tickets = await fetchClosedTicketsForRange(token, startUTC, endUTC);
  console.log(`[fetchData] Found ${tickets.length} closed tickets for ${dateStr}`);

  const fetchedAt = new Date().toISOString();
  const newTickets = await persistTickets(tickets, dateStr, fetchedAt);
  console.log(`[fetchData] Historical data for ${dateStr}: ${newTickets} new tickets added`);
  return { dateStr, ticketsFound: tickets.length, newTickets };
}

// Upsert tickets into Supabase. Preserves the existing logic:
//   - new ticket: insert with the current assignee
//   - seen before: append new assignees to the list, update closedTime if it changed
async function persistTickets(tickets, dateStr, fetchedAt) {
  if (!tickets.length) return 0;

  // Load existing tickets once into a map for fast lookup
  const existing = await db.loadAllTickets();
  const existingById = {};
  for (const t of existing) existingById[t.id] = t;

  const toUpsert = [];
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

    const stored = existingById[ticket.id];

    if (!stored) {
      newTickets++;
      toUpsert.push({
        id:              ticket.id,
        ticketNumber:    ticket.ticketNumber || ticket.id,
        subject:         ticket.subject || 'Untitled',
        createdTime:     ticket.createdTime || null,
        closedTime:      ticket.closedTime  || null,
        resolutionTimeMs: resMs,
        dateClosed:      dateStr,
        firstFetchedAt:  fetchedAt,
        assignees: assigneeId ? [{
          id:     assigneeId,
          name:   assigneeName,
          seenAt: fetchedAt,
          role:   'closer',
        }] : [],
      });
      continue;
    }

    // Existing ticket — figure out if anything changed
    let assignees = Array.isArray(stored.assignees) ? [...stored.assignees] : [];
    let needsUpdate = false;

    if (assigneeId && !assignees.some(a => a.id === assigneeId)) {
      assignees.push({ id: assigneeId, name: assigneeName, seenAt: fetchedAt, role: 'closer' });
      needsUpdate = true;
    }

    let closedTime       = stored.closedTime;
    let resolutionTimeMs = stored.resolutionTimeMs;
    let dateClosed       = stored.dateClosed;
    if (ticket.closedTime && ticket.closedTime !== stored.closedTime) {
      closedTime       = ticket.closedTime;
      resolutionTimeMs = resMs;
      dateClosed       = dateStr;
      needsUpdate = true;
    }

    if (needsUpdate) {
      toUpsert.push({ ...stored, assignees, closedTime, resolutionTimeMs, dateClosed });
    }
  }

  await db.upsertTickets(toUpsert);
  return newTickets;
}

async function fetchLeaderboardData() {
  console.log('[fetchData] Starting leaderboard data fetch...');

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

  console.log(`[fetchData] Total missions: ${totalMissions}, Squad size: ${squadSize}, Operatives: ${operatives.length}`);

  // Persist tickets to Supabase
  const fetchedAt  = new Date().toISOString();
  const newTickets = await persistTickets(tickets, dateStr, fetchedAt);
  console.log(`[fetchData] Tickets persisted — ${newTickets} new added`);

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

module.exports = { fetchLeaderboardData, fetchDataForDate };
