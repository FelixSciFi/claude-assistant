const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(__dirname, 'gmail_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'gmail_token.json');

function isGmailConfigured() {
  return fs.existsSync(CREDS_PATH) && fs.existsSync(TOKEN_PATH);
}

function getClient() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'http://localhost:8765');
  auth.setCredentials(token);
  auth.on('tokens', (tokens) => {
    const current = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }, null, 2));
  });
  return google.gmail({ version: 'v1', auth });
}

async function searchEmails(query, maxResults = 10, daysBack = 30) {
  const gmail = getClient();
  const q = daysBack ? `${query} newer_than:${daysBack}d` : query;
  const { data } = await gmail.users.messages.list({ userId: 'me', q, maxResults: Math.min(maxResults, 20) });
  if (!data.messages || data.messages.length === 0) return [];
  return Promise.all(data.messages.map(async (msg) => {
    const { data: d } = await gmail.users.messages.get({
      userId: 'me', id: msg.id, format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date', 'To']
    });
    const get = (n) => d.payload.headers.find(h => h.name === n)?.value || '';
    return { id: msg.id, threadId: d.threadId, from: get('From'), to: get('To'), subject: get('Subject'), date: get('Date'), snippet: (d.snippet || '').slice(0, 200) };
  }));
}

async function sendEmail(to, subject, body) {
  const gmail = getClient();
  const subjectEncoded = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const raw = [`To: ${to}`, `Subject: ${subjectEncoded}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(body).toString('base64')].join('\n');
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}

async function getEmailContent(messageId) {
  const gmail = getClient();
  const { data } = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const headers = data.payload.headers;
  const get = (n) => headers.find(h => h.name === n)?.value || '';
  let body = '';
  const attachments = [];

  function parseParts(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        body += Buffer.from(part.body.data, 'base64url').toString('utf8');
      } else if (part.mimeType === 'text/html' && !body && part.body?.data) {
        body += Buffer.from(part.body.data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      } else if (part.filename) {
        attachments.push({ id: part.body?.attachmentId, filename: part.filename, mimeType: part.mimeType, size: part.body?.size || 0 });
      }
      if (part.parts) parseParts(part.parts);
    }
  }

  if (data.payload.body?.data) body = Buffer.from(data.payload.body.data, 'base64url').toString('utf8');
  parseParts(data.payload.parts);

  const TEXT_TYPES = ['text/plain', 'text/csv', 'application/json', 'text/html'];
  for (const att of attachments) {
    if (TEXT_TYPES.includes(att.mimeType) && att.size < 50000 && att.id) {
      try {
        const { data: attData } = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: att.id });
        att.content = Buffer.from(attData.data, 'base64url').toString('utf8').slice(0, 3000);
      } catch(e) {}
    }
  }

  return {
    from: get('From'), to: get('To'), subject: get('Subject'), date: get('Date'),
    body: body.slice(0, 3000),
    attachments
  };
}

module.exports = { isGmailConfigured, searchEmails, sendEmail, getEmailContent };
