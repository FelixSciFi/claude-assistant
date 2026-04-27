// 运行此脚本完成 Google OAuth 授权（Gmail + Sheets）
// 用法：node gmail_auth.js
const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(__dirname, 'gmail_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'gmail_token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets'
];

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'http://localhost:8765');

const authUrl = auth.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
console.log('\n请在浏览器打开以下链接完成授权：\n');
console.log(authUrl);
console.log('\n等待授权回调...');

const server = http.createServer(async (req, res) => {
  const qs = url.parse(req.url, true).query;
  if (!qs.code) { res.end('No code'); return; }
  res.end('<h2>授权成功，可以关闭此页面</h2>');
  server.close();
  const { tokens } = await auth.getToken(qs.code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('\n✅ 授权成功，token 已保存至', TOKEN_PATH);
  process.exit(0);
}).listen(8765);
