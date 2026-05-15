// One-time migration: import data/history.json into Supabase.
// Run locally after creating the Supabase tickets table and adding credentials to .env:
//   npm run migrate

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const db = require('./db');

async function main() {
  const historyPath = path.join(__dirname, '../data/history.json');
  if (!fs.existsSync(historyPath)) {
    console.error('No history.json found at', historyPath);
    process.exit(1);
  }

  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  const tickets = Object.values(history.tickets || {});
  console.log(`Found ${tickets.length} tickets in history.json`);

  if (!tickets.length) {
    console.log('Nothing to migrate.');
    return;
  }

  // Batch upsert in chunks of 100 so we don't hit any payload limit
  const chunkSize = 100;
  let done = 0;
  for (let i = 0; i < tickets.length; i += chunkSize) {
    const chunk = tickets.slice(i, i + chunkSize);
    await db.upsertTickets(chunk);
    done += chunk.length;
    console.log(`  Upserted ${done}/${tickets.length}`);
  }

  console.log(`\nDone. ${done} tickets uploaded to Supabase.`);
}

main().catch(err => {
  console.error('Migration failed:', err.message || err);
  process.exit(1);
});
