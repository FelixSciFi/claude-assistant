const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const { exec } = require('child_process');
const { isGmailConfigured, searchEmails, sendEmail } = require('./gmail');

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
  CREATE TABLE IF NOT EXISTS tracked_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL DEFAULT 'felix',
    description TEXT NOT NULL,
    gmail_query TEXT NOT NULL,
    remind_days INTEGER DEFAULT 3,
    status TEXT DEFAULT 'active',
    last_activity DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

try { db.exec(`ALTER TABLE conversations ADD COLUMN user TEXT NOT NULL DEFAULT 'felix'`); } catch(e) {}
try { db.exec(`ALTER TABLE memory ADD COLUMN user TEXT NOT NULL DEFAULT 'felix'`); } catch(e) {}

const MEMORY_INSTRUCTION = `\n\n如果本次对话中出现值得长期记住的重要信息（如个人偏好、习惯、重要事实），在回复最末尾加上 [M: 简短描述]，否则不加任何标记。`;

const SYSTEM_PROMPTS = {
  felix: `你是Felix的私人AI助手。Felix是一位在塞内加尔达喀尔经营公司的中国企业家，团队约10人，使用WhatsApp和Facebook广告获客。回答风格：简洁直接，中文为主。你有权访问Felix的Gmail，可搜索邮件、发邮件、管理跟踪事项。发邮件前必须先展示草稿让Felix确认再调用发送工具。`,
  nicole: `你是Nicole的私人AI助手，Nicole是Felix的妻子，目前在达喀尔生活。回答风格：温和体贴，中文为主。`
};

const GMAIL_TOOLS = [
  {
    name: 'search_gmail',
    description: '搜索Gmail邮件。只在用户明确要查邮件时调用。默认最近30天，最多10封。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail搜索词，如 "from:abc@example.com" 或关键词' },
        days_back: { type: 'number', description: '查最近几天，默认30' },
        max_results: { type: 'number', description: '最多几封，默认10' }
      },
      required: ['query']
    }
  },
  {
    name: 'send_email',
    description: '发送邮件。只在用户明确确认草稿后调用。',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '收件人邮箱' },
        subject: { type: 'string', description: '主题' },
        body: { type: 'string', description: '正文' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'manage_tracked',
    description: '管理邮件跟踪事项：查看(list)、添加(add)、移除(remove)',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove'] },
        description: { type: 'string', description: '事项描述（add时填）' },
        gmail_query: { type: 'string', description: 'Gmail搜索条件（add时填）' },
        remind_days: { type: 'number', description: '几天无回复提醒，默认3（add时填）' },
        id: { type: 'number', description: '事项ID（remove时填）' }
      },
      required: ['action']
    }
  }
];

async function executeTool(name, input, user) {
  try {
    if (name === 'search_gmail') {
      const results = await searchEmails(input.query, input.max_results || 10, input.days_back ?? 30);
      return results.length === 0 ? '没有找到相关邮件。' : JSON.stringify(results);
    }
    if (name === 'send_email') {
      await sendEmail(input.to, input.subject, input.body);
      return `邮件已发送给 ${input.to}，主题：${input.subject}`;
    }
    if (name === 'manage_tracked') {
      if (input.action === 'list') {
        const items = db.prepare('SELECT * FROM tracked_items WHERE user = ? AND status = "active" ORDER BY created_at DESC').all(user);
        return items.length === 0 ? '当前没有跟踪事项。' : JSON.stringify(items);
      }
      if (input.action === 'add') {
        const r = db.prepare('INSERT INTO tracked_items (user, description, gmail_query, remind_days) VALUES (?, ?, ?, ?)').run(user, input.description, input.gmail_query, input.remind_days || 3);
        return `已添加跟踪事项 #${r.lastInsertRowid}：${input.description}`;
      }
      if (input.action === 'remove') {
        db.prepare('UPDATE tracked_items SET status = "done" WHERE id = ? AND user = ?').run(input.id, user);
        return `已停止跟踪 #${input.id}`;
      }
    }
  } catch (err) {
    return `执行失败: ${err.message}`;
  }
}

const TOOL_LABELS = { search_gmail: '📧 搜索邮件', send_email: '📤 发送邮件', manage_tracked: '📋 管理跟踪事项' };

async function runChat(apiMessages, systemPrompt, user, res, depth = 0) {
  if (depth > 3) return '';
  const useTools = user === 'felix' && isGmailConfigured();
  let fullText = '';
  const params = { model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: systemPrompt, messages: apiMessages };
  if (useTools) params.tools = GMAIL_TOOLS;
  const stream = anthropic.messages.stream(params);
  stream.on('text', (text) => { fullText += text; res.write(`data: ${JSON.stringify({ text })}\n\n`); });
  const finalMsg = await stream.finalMessage();
  if (finalMsg.stop_reason === 'tool_use') {
    const toolUseBlocks = finalMsg.content.filter(b => b.type === 'tool_use');
    const toolResults = [];
    for (const tu of toolUseBlocks) {
      const label = TOOL_LABELS[tu.name] || tu.name;
      res.write(`data: ${JSON.stringify({ text: `\n*${label}中...*\n` })}\n\n`);
      const result = await executeTool(tu.name, tu.input, user);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    const continued = await runChat(
      [...apiMessages, { role: 'assistant', content: finalMsg.content }, { role: 'user', content: toolResults }],
      systemPrompt, user, res, depth + 1
    );
    return fullText + continued;
  }
  return fullText;
}

app.use(express.json());
app.use(express.static('public'));

app.get('/api/conversations', (req, res) => {
  const user = req.query.user || 'felix';
  res.json(db.prepare('SELECT * FROM conversations WHERE user = ? ORDER BY updated_at DESC').all(user));
});
app.post('/api/conversations', (req, res) => {
  const { title, user } = req.body;
  const result = db.prepare('INSERT INTO conversations (title, user) VALUES (?, ?)').run(title || '新对话', user || 'felix');
  res.json(db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid));
});
app.delete('/api/conversations/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  res.json({ ok: true });
});
app.patch('/api/conversations/:id', (req, res) => {
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(req.body.title, req.params.id);
  res.json({ ok: true });
});
app.get('/api/conversations/:id/messages', (req, res) => {
  res.json(db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(req.params.id));
});

app.post('/api/conversations/:id/chat', async (req, res) => {
  const { id } = req.params;
  const { message, user } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(id, 'user', message);
  db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (conv.title === '新对话') db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(message.slice(0, 20).trim(), id);
  const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(id);
  const u = user || 'felix';
  const memories = db.prepare('SELECT content FROM memory WHERE user = ? ORDER BY created_at DESC LIMIT 10').all(u);
  const memoryText = memories.length > 0 ? '\n\n记住的信息：\n' + memories.map(m => '- ' + m.content).join('\n') : '';
  const systemPrompt = (SYSTEM_PROMPTS[u] || SYSTEM_PROMPTS.felix) + memoryText + MEMORY_INSTRUCTION;
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const apiMessages = history.slice(-20).map(m => ({ role: m.role, content: m.content }));
    let fullResponse = await runChat(apiMessages, systemPrompt, u, res);
    const memMatch = fullResponse.match(/\[M:\s*(.+?)\]\s*$/);
    if (memMatch) {
      db.prepare('INSERT INTO memory (content, user) VALUES (?, ?)').run(memMatch[1].trim(), u);
      fullResponse = fullResponse.replace(/\s*\[M:\s*.+?\]\s*$/, '').trim();
    }
    const cleanResponse = fullResponse.replace(/\n\*[📧📤📋].*?\*\n/g, '').trim();
    db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(id, 'assistant', cleanResponse);
    const updated = db.prepare('SELECT title FROM conversations WHERE id = ?').get(id);
    res.write(`data: ${JSON.stringify({ done: true, title: updated.title, cleanText: cleanResponse })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.get('/api/memory', (req, res) => {
  const user = req.query.user || 'felix';
  res.json(db.prepare('SELECT * FROM memory WHERE user = ? ORDER BY created_at DESC').all(user));
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
    if (err) { res.send('失败:\n' + output); }
    else { res.send('更新成功！\n' + output + '\n重启中...'); setTimeout(() => process.exit(0), 500); }
  });
});

app.listen(PORT, () => console.log(`Claude running on http://localhost:${PORT}`));
