const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const { exec } = require('child_process');
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
// 迁移：添加 user 字段
try { db.exec(`ALTER TABLE conversations ADD COLUMN user TEXT NOT NULL DEFAULT 'felix'`); } catch(e) {}
try { db.exec(`ALTER TABLE memory ADD COLUMN user TEXT NOT NULL DEFAULT 'felix'`); } catch(e) {}

const MEMORY_INSTRUCTION = `\n\n如果本次对话中出现值得长期记住的重要信息（如个人偏好、习惯、重要事实），在回复最末尾加上 [M: 简短描述]，否则不加任何标记。`;

const SYSTEM_PROMPTS = {
  felix: `你是Felix的私人AI助手。Felix是一位在塞内加尔达喀尔经营公司的中国企业家，团队约10人，使用WhatsApp和Facebook广告获客。回答风格：简洁直接，中文为主。`,
  nicole: `你是Nicole的私人AI助手，Nicole是Felix的妻子，目前在达喀尔生活。回答风格：温和体贴，中文为主。`
};

app.use(express.json());
app.use(express.static('public'));
app.get('/api/conversations', (req, res) => {
  const user = req.query.user || 'felix';
  const convs = db.prepare('SELECT * FROM conversations WHERE user = ? ORDER BY updated_at DESC').all(user);
  res.json(convs);
});
app.post('/api/conversations', (req, res) => {
  const { title, user } = req.body;
  const result = db.prepare('INSERT INTO conversations (title, user) VALUES (?, ?)').run(title || '新对话', user || 'felix');
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
  const { message, user } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(id, 'user', message);
  db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (conv.title === '新对话') {
    const short = message.slice(0, 20).trim();
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(short, id);
  }
  const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(id);
  const u = user || 'felix';
  const memories = db.prepare('SELECT content FROM memory WHERE user = ? ORDER BY created_at DESC LIMIT 10').all(u);
  const memoryText = memories.length > 0 ? '\n\n记住的信息：\n' + memories.map(m => '- ' + m.content).join('\n') : '';
  const systemPrompt = (SYSTEM_PROMPTS[u] || SYSTEM_PROMPTS.felix) + memoryText + MEMORY_INSTRUCTION;
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
      // 提取并保存自动记忆
      const memMatch = fullResponse.match(/\[M:\s*(.+?)\]\s*$/);
      if (memMatch) {
        db.prepare('INSERT INTO memory (content, user) VALUES (?, ?)').run(memMatch[1].trim(), u);
        fullResponse = fullResponse.replace(/\s*\[M:\s*.+?\]\s*$/, '').trim();
      }
      db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(id, 'assistant', fullResponse);
      const updated = db.prepare('SELECT title FROM conversations WHERE id = ?').get(id);
      res.write(`data: ${JSON.stringify({ done: true, title: updated.title, cleanText: fullResponse })}\n\n`);
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
app.get('/api/memory', (req, res) => {
  const user = req.query.user || 'felix';
  const mems = db.prepare('SELECT * FROM memory WHERE user = ? ORDER BY created_at DESC').all(user);
  res.json(mems);
});
app.delete('/api/memory/:id', (req, res) => {
  db.prepare('DELETE FROM memory WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/memory', (req, res) => {
  const { content, user } = req.body;
  if (!content) return res.status(400).json({ error: 'No content' });
  db.prepare('INSERT INTO memory (content, user) VALUES (?, ?)').run(content, user || 'felix');
  res.json({ ok: true });
});
app.get('/admin/update', (req, res) => {
  if (req.query.key !== 'felix2026dakar') return res.status(403).send('Forbidden');
  exec('git -C /root/claude-assistant pull origin main', (err, stdout, stderr) => {
    const output = stdout + stderr;
    if (err) {
      res.send('失败:\n' + output);
    } else {
      res.send('更新成功！\n' + output + '\n重启中...');
      setTimeout(() => process.exit(0), 500);
    }
  });
});
app.listen(PORT, () => {
  console.log(`Claude running on http://localhost:${PORT}`);
});
