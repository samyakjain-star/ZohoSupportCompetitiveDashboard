const path = require('path');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const TOKENS_PATH = path.join(__dirname, '../data/tokens.json');

function loadTokens() {
  // Try data/tokens.json first (has most recent refreshed token)
  if (fs.existsSync(TOKENS_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    } catch (e) {
      console.warn('[tokenManager] Could not parse tokens.json, falling back to .env');
    }
  }
  // Fall back to .env
  return {
    access_token: process.env.ACCESS_TOKEN?.trim().replace(/^"|"$/g, ''),
    refresh_token: process.env.REFRESH_TOKEN?.trim().replace(/^"|"$/g, ''),
  };
}

function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

async function refreshAccessToken() {
  const { refresh_token } = loadTokens();
  const client_id = process.env.CLIENT_ID?.trim().replace(/^"|"$/g, '');
  const client_secret = process.env.CLIENT_SECRET?.trim().replace(/^"|"$/g, '');
  const tokenUrl = process.env.TOKEN_URL?.trim().replace(/^"|"$/g, '');

  console.log('[tokenManager] Refreshing access token...');

  const resp = await axios.post(`${tokenUrl}`, null, {
    params: {
      grant_type: 'refresh_token',
      client_id,
      client_secret,
      refresh_token,
    },
  });

  if (!resp.data.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(resp.data));
  }

  const tokens = { access_token: resp.data.access_token, refresh_token };
  saveTokens(tokens);
  console.log('[tokenManager] Access token refreshed and saved');
  return tokens.access_token;
}

async function getAccessToken() {
  // Return the stored token; fetchData will handle 401 by calling refreshAccessToken()
  return loadTokens().access_token;
}

module.exports = { getAccessToken, refreshAccessToken, loadTokens };
