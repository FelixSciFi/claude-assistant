// 运行此脚本完成 Google OAuth 授权（Gmail + Sheets）
// 用法：node gmail_auth.js
const { google } = require('googleapis');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(__dirname, 'gmail_credentials.json');
const TOKEN_PATH = path.join(__dirname, 'gmail_token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets'
];

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'http://localhost');

const authUrl = auth.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
console.log('\n请在浏览器打开此链接授权：\n');
console.log(authUrl);
console.log('\n授权后把浏览器地址栏完整URL粘贴到这里: ');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('', async (input) => {
  rl.close();
  const code = new URL(input).searchParams.get('code');
  const { tokens } = await auth.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('Token 已保存！');
  process.exit(0);
});
