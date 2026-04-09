const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const app = express();
const PORT = 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db = new Database('./memory.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '新对话',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );
  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
app.use(express.json());
app.use(express.static('public'));
app.get('/api/conversations', (req, res) => {
  const convs = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
  res.json(convs);
});
app.post('/api/conversations', (req, res) => {
  const { title } = req.body;
  const result = db.prepare('INSERT INTO conversations (title) VALUES (?)').run(title || '新对话');
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid);
  res.json(conv);
});
app.delete('/api/conversations/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  res.json({ ok: true });
});
app.patch('/api/conversations/:id', (req, res) => {
  const { id } = req.params;
  const { title } = req.body;
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
  res.json({ ok: true });
});
app.get('/api/conversations/:id/messages', (req, res) => {
  const { id } = req.params;
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(id);
  res.json(messages);
});
app.post('/api/conversations/:id/chat', async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(id, 'user', message);
  db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (conv.title === '新对话') {
    const short = message.slice(0, 20).trim();
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(short, id);
  }
  const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(id);
  const memories = db.prepare('SELECT content FROM memory ORDER BY created_at DESC LIMIT 10').all();
  const memoryText = memories.length > 0 ? '\n\n记住的信息：\n' + memories.map(m => '- ' + m.content).join('\n') : '';
  const systemPrompt = `你是Felix的私人AI助手。Felix是一位在塞内加尔达喀尔经营公司的中国企业家，团队约10人，使用WhatsApp和Facebook广告获客。回答风格：简洁直接，中文为主。${memoryText}`;
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const messages = history.slice(-20).map(m => ({ role: m.role, content: m.content }));
    let fullResponse = '';
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });
    stream.on('text', (text) => {
      fullResponse += text;
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });
    stream.on('finalMessage', () => {
      db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(id, 'assistant', fullResponse);
      const updated = db.prepare('SELECT title FROM conversations WHERE id = ?').get(id);
      res.write(`data: ${JSON.stringify({ done: true, title: updated.title })}\n\n`);
      res.end();
    });
    stream.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});
app.post('/api/memory', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'No content' });
  db.prepare('INSERT INTO memory (content) VALUES (?)').run(content);
  res.json({ ok: true });
});
app.listen(PORT, () => {
  console.log(`Claude running on http://localhost:${PORT}`);
});
