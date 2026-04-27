const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(__dirname, 'gmail_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'gmail_token.json');

function getAuth() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'http://localhost:8765');
  auth.setCredentials(token);
  auth.on('tokens', (tokens) => {
    const current = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }, null, 2));
  });
  return auth;
}

function getClient() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

async function createSpreadsheet(title, sheetTitles = ['Sheet1']) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: sheetTitles.map(t => ({ properties: { title: t } }))
    }
  });
  const id = res.data.spreadsheetId;
  return { id, url: `https://docs.google.com/spreadsheets/d/${id}` };
}

async function writeSheet(spreadsheetId, range, values) {
  const sheets = getClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId, range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });
  return { spreadsheetId, range, rows: values.length };
}

async function appendSheet(spreadsheetId, range, values) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId, range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
  return { spreadsheetId, updatedRange: res.data.updates?.updatedRange, rows: values.length };
}

async function readSheet(spreadsheetId, range) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function clearSheet(spreadsheetId, range) {
  const sheets = getClient();
  await sheets.spreadsheets.values.clear({ spreadsheetId, range });
}

module.exports = { createSpreadsheet, writeSheet, appendSheet, readSheet, clearSheet };
