const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[db] Missing DATABASE_URL env var — the app will fail when it tries to use the database.');
}

// Neon and most managed Postgres require SSL. rejectUnauthorized:false works
// across both Neon and Supabase pooled connection strings.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 5,
});

pool.on('error', err => console.error('[db] pool error:', err.message));

function rowToTicket(row) {
  const iso = v => (v instanceof Date ? v.toISOString() : v);
  return {
    id:               String(row.id),
    ticketNumber:     row.ticket_number,
    subject:          row.subject,
    createdTime:      iso(row.created_time),
    closedTime:       iso(row.closed_time),
    resolutionTimeMs: row.resolution_time_ms != null ? Number(row.resolution_time_ms) : null,
    dateClosed:       row.date_closed,
    firstFetchedAt:   iso(row.first_fetched_at),
    assignees:        Array.isArray(row.assignees) ? row.assignees : [],
  };
}

async function loadAllTickets() {
  const { rows } = await pool.query(
    'SELECT * FROM tickets ORDER BY closed_time DESC NULLS LAST'
  );
  return rows.map(rowToTicket);
}

async function loadHistoryShape() {
  const tickets = await loadAllTickets();
  const byId = {};
  for (const t of tickets) byId[t.id] = t;
  return { tickets: byId, runs: [], lastUpdated: new Date().toISOString() };
}

async function getTicketById(id) {
  const { rows } = await pool.query('SELECT * FROM tickets WHERE id = $1', [String(id)]);
  return rows.length ? rowToTicket(rows[0]) : null;
}

async function getTicketCount() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM tickets');
  return rows[0]?.c || 0;
}

async function upsertTickets(tickets) {
  if (!tickets || tickets.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sql = `
      INSERT INTO tickets
        (id, ticket_number, subject, created_time, closed_time,
         resolution_time_ms, date_closed, first_fetched_at, assignees)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        ticket_number       = EXCLUDED.ticket_number,
        subject             = EXCLUDED.subject,
        created_time        = EXCLUDED.created_time,
        closed_time         = EXCLUDED.closed_time,
        resolution_time_ms  = EXCLUDED.resolution_time_ms,
        date_closed         = EXCLUDED.date_closed,
        first_fetched_at    = EXCLUDED.first_fetched_at,
        assignees           = EXCLUDED.assignees
    `;
    for (const t of tickets) {
      await client.query(sql, [
        String(t.id),
        t.ticketNumber != null ? String(t.ticketNumber) : null,
        t.subject ?? null,
        t.createdTime ?? null,
        t.closedTime ?? null,
        t.resolutionTimeMs ?? null,
        t.dateClosed ?? null,
        t.firstFetchedAt ?? null,
        JSON.stringify(t.assignees ?? []),
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getLatestFetchedAt() {
  const { rows } = await pool.query(
    'SELECT first_fetched_at FROM tickets ORDER BY first_fetched_at DESC NULLS LAST LIMIT 1'
  );
  if (!rows.length || !rows[0].first_fetched_at) return null;
  const v = rows[0].first_fetched_at;
  return v instanceof Date ? v.toISOString() : v;
}

// One-shot: if tickets table is empty and data/history.json exists,
// import it so we don't lose our backfilled data on first deploy.
async function migrateFromJsonIfEmpty() {
  try {
    const count = await getTicketCount();
    if (count > 0) return false;
    const p = path.join(__dirname, '../data/history.json');
    if (!fs.existsSync(p)) return false;
    const h = JSON.parse(fs.readFileSync(p, 'utf8'));
    const tickets = Object.values(h.tickets || {});
    if (tickets.length === 0) return false;
    console.log(`[db] Tickets table empty — importing ${tickets.length} tickets from data/history.json`);
    await upsertTickets(tickets);
    console.log('[db] Initial migration complete');
    return true;
  } catch (err) {
    console.error('[db] Migration error:', err.message);
    return false;
  }
}

// ── agent_stats (archive of expired tickets) ────────────────────────────────
// When raw tickets are deleted after N days, their contribution to cumulative
// counts and average resolution time is preserved here.

async function getAgentStats() {
  const { rows } = await pool.query('SELECT * FROM agent_stats');
  const map = {};
  for (const r of rows) {
    map[r.agent_id] = {
      name:                      r.name,
      archivedMissions:          Number(r.archived_missions) || 0,
      archivedTotalResolutionMs: Number(r.archived_total_resolution_ms) || 0,
      archivedResolutionCount:   Number(r.archived_resolution_count) || 0,
    };
  }
  return map;
}

// Aggregate tickets older than (today - daysToKeep) into agent_stats and
// delete them from the tickets table. Returns { archivedAgents, deletedTickets }.
async function archiveOldTickets(daysToKeep = 30) {
  const cutoff = new Date(Date.now() - daysToKeep * 86400000);
  const cutoffStr =
    `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}-${String(cutoff.getUTCDate()).padStart(2, '0')}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT
         assignees->0->>'id'                                          AS agent_id,
         assignees->0->>'name'                                        AS name,
         COUNT(*)::int                                                AS missions,
         COALESCE(SUM(resolution_time_ms), 0)::bigint                 AS total_res_ms,
         COUNT(resolution_time_ms)::int                               AS res_count
       FROM tickets
       WHERE date_closed < $1
         AND jsonb_array_length(assignees) > 0
       GROUP BY assignees->0->>'id', assignees->0->>'name'`,
      [cutoffStr]
    );

    for (const r of rows) {
      if (!r.agent_id) continue;
      await client.query(
        `INSERT INTO agent_stats
           (agent_id, name, archived_missions, archived_total_resolution_ms, archived_resolution_count, last_updated)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (agent_id) DO UPDATE SET
           name                         = COALESCE(EXCLUDED.name, agent_stats.name),
           archived_missions            = agent_stats.archived_missions            + EXCLUDED.archived_missions,
           archived_total_resolution_ms = agent_stats.archived_total_resolution_ms + EXCLUDED.archived_total_resolution_ms,
           archived_resolution_count    = agent_stats.archived_resolution_count    + EXCLUDED.archived_resolution_count,
           last_updated                 = NOW()`,
        [r.agent_id, r.name, r.missions, r.total_res_ms, r.res_count]
      );
    }

    const del = await client.query('DELETE FROM tickets WHERE date_closed < $1', [cutoffStr]);

    await client.query('COMMIT');
    return { archivedAgents: rows.length, deletedTickets: del.rowCount || 0, cutoff: cutoffStr };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  loadAllTickets,
  loadHistoryShape,
  getTicketById,
  getTicketCount,
  upsertTickets,
  getLatestFetchedAt,
  migrateFromJsonIfEmpty,
  getAgentStats,
  archiveOldTickets,
};
