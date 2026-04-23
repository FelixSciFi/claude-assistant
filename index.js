const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const { exec } = require('child_process');
const multer = require('multer');
const { isGmailConfigured, searchEmails, sendEmail, getEmailContent } = require('./gmail');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const PORT = 3000;
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'web-search-2025-03-05' }
});
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
  CREATE TABLE IF NOT EXISTS memory_doc (
    user TEXT PRIMARY KEY,
    personal TEXT DEFAULT '',
    work TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS briefings (
    user TEXT NOT NULL,
    date TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user, date)
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
try { db.exec(`ALTER TABLE conversations ADD COLUMN is_work INTEGER DEFAULT 0`); } catch(e) {}

function getMemoryDoc(user) {
  let doc = db.prepare('SELECT personal, work FROM memory_doc WHERE user = ?').get(user);
  if (!doc) {
    let personal = '';
    try {
      const old = db.prepare('SELECT content FROM memory WHERE user = ? ORDER BY created_at ASC').all(user);
      if (old.length > 0) personal = old.map(m => m.content).join('\n');
    } catch(e) {}
    db.prepare('INSERT OR IGNORE INTO memory_doc (user, personal, work) VALUES (?, ?, ?)').run(user, personal, '');
    doc = { personal, work: '' };
  }
  return doc;
}

function upsertMemoryDoc(user, type, content) {
  if (type === 'personal') {
    db.prepare('INSERT INTO memory_doc (user, personal) VALUES (?, ?) ON CONFLICT(user) DO UPDATE SET personal = excluded.personal, updated_at = CURRENT_TIMESTAMP').run(user, content);
  } else if (type === 'work') {
    db.prepare('INSERT INTO memory_doc (user, work) VALUES (?, ?) ON CONFLICT(user) DO UPDATE SET work = excluded.work, updated_at = CURRENT_TIMESTAMP').run(user, content);
  }
}

const SYSTEM_PROMPTS = {
  felix: `你是Felix的私人AI助手。Felix是一位在塞内加尔达喀尔经营公司的中国企业家，团队约10人，使用WhatsApp和Facebook广告获客。回答风格：简洁直接，中文为主。你有权访问Felix的Gmail，可搜索邮件、发邮件、管理跟踪事项。发邮件前必须先展示草稿让Felix确认再调用发送工具。当对话中出现值得长期记住的重要信息时，使用update_memory工具更新对应记忆（传入该类型完整的最新文本，会覆盖原有内容）。`,
  nicole: `你是Nicole的私人AI助手，Nicole是Felix的妻子，目前在达喀尔生活。回答风格：温和体贴，中文为主。当对话中出现值得长期记住的重要信息时，使用update_memory工具更新对应记忆（传入该类型完整的最新文本，会覆盖原有内容）。`
};

function buildSystemPrompt(user, isWork = false) {
  const base = SYSTEM_PROMPTS[user] || SYSTEM_PROMPTS.felix;
  const doc = getMemoryDoc(user);
  const workCtx = isWork ? '\n当前是工作对话模式，请专注处理工作相关事务。' : '';
  let memText = '';
  if (doc.personal) memText += `\n\n个人记忆：\n${doc.personal}`;
  if (doc.work) memText += `\n\n工作记忆：\n${doc.work}`;
  return base + workCtx + memText;
}

const MEMORY_TOOL = {
  name: 'update_memory',
  description: '更新记忆文档（会覆盖该类型原有内容）。在对话中发现值得长期记住的重要信息时调用，传入完整的最新文本。',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['personal', 'work'], description: 'personal=个人记忆，work=工作记忆' },
      content: { type: 'string', description: '完整的记忆内容（自由文本）' }
    },
    required: ['type', 'content']
  }
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
    name: 'get_email_content',
    description: '读取某封邮件的完整正文和附件。先用search_gmail找到邮件ID再调用。Excel附件会解析成表格文本。',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: '邮件ID，来自search_gmail结果' }
      },
      required: ['message_id']
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
    if (name === 'update_memory') {
      upsertMemoryDoc(user, input.type, input.content);
      return `${input.type === 'personal' ? '个人' : '工作'}记忆已更新。`;
    }
    if (name === 'search_gmail') {
      const results = await searchEmails(input.query, input.max_results || 10, input.days_back ?? 30);
      return results.length === 0 ? '没有找到相关邮件。' : JSON.stringify(results);
    }
    if (name === 'send_email') {
      await sendEmail(input.to, input.subject, input.body);
      return `邮件已发送给 ${input.to}，主题：${input.subject}`;
    }
    if (name === 'get_email_content') {
      const content = await getEmailContent(input.message_id);
      return JSON.stringify(content);
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

const TOOL_LABELS = {
  update_memory: '💾 更新记忆',
  search_gmail: '📧 搜索邮件',
  get_email_content: '📄 读取邮件内容',
  send_email: '📤 发送邮件',
  manage_tracked: '📋 管理跟踪事项',
  web_search: '🔍 搜索网络'
};

async function runBriefingChat(apiMessages, systemPrompt, user, res) {
  let fullText = '';
  const params = { model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: systemPrompt, messages: apiMessages, tools: [MEMORY_TOOL] };
  const stream = anthropic.messages.stream(params);
  stream.on('text', (text) => { fullText += text; res.write(`data: ${JSON.stringify({ text })}\n\n`); });
  const finalMsg = await stream.finalMessage();
  if (finalMsg.stop_reason === 'tool_use') {
    const toolResults = [];
    for (const tu of finalMsg.content.filter(b => b.type === 'tool_use')) {
      const result = await executeTool(tu.name, tu.input, user);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    const continued = await runBriefingChat(
      [...apiMessages, { role: 'assistant', content: finalMsg.content }, { role: 'user', content: toolResults }],
      systemPrompt, user, res
    );
    return fullText + continued;
  }
  return fullText;
}

async function runChat(apiMessages, systemPrompt, user, res, depth = 0) {
  if (depth > 3) return '';
  const useGmail = user === 'felix' && isGmailConfigured();
  const tools = useGmail ? [MEMORY_TOOL, ...GMAIL_TOOLS] : [MEMORY_TOOL];
  tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
  let fullText = '';
  const params = { model: 'claude-sonnet-4-20250514', max_tokens: 2048, system: systemPrompt, messages: apiMessages, tools };
  const stream = anthropic.messages.stream(params);
  stream.on('streamEvent', (event) => {
    if (event.type === 'content_block_start' && event.content_block?.type === 'server_tool_use' && event.content_block?.name === 'web_search') {
      res.write(`data: ${JSON.stringify({ text: '\n*🔍 搜索中...*\n' })}\n\n`);
    }
  });
  stream.on('text', (text) => { fullText += text; res.write(`data: ${JSON.stringify({ text })}\n\n`); });
  const finalMsg = await stream.finalMessage();
  if (finalMsg.stop_reason === 'tool_use') {
    const toolUseBlocks = finalMsg.content.filter(b => b.type === 'tool_use');
    // 只有 server tool（web_search）触发时，无需客户端处理，直接返回
    if (toolUseBlocks.length === 0) return fullText;
    const toolResults = [];
    for (const tu of toolUseBlocks) {
      const label = TOOL_LABELS[tu.name] || tu.name;
      res.write(`data: ${JSON.stringify({ text: `\n*${label}中...*\n` })}\n\n`);
      const result = await executeTool(tu.name, tu.input, user);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    // 过滤掉 server_tool_use 块，避免传回 API 时报错
    const assistantContent = finalMsg.content.filter(b => b.type !== 'server_tool_use');
    const continued = await runChat(
      [...apiMessages, { role: 'assistant', content: assistantContent }, { role: 'user', content: toolResults }],
      systemPrompt, user, res, depth + 1
    );
    return fullText + continued;
  }
  return fullText;
}

app.use(express.json());
app.use(express.static('public'));

// Conversations (casual only, is_work=0)
app.get('/api/conversations', (req, res) => {
  const user = req.query.user || 'felix';
  res.json(db.prepare('SELECT * FROM conversations WHERE user = ? AND is_work = 0 ORDER BY updated_at DESC').all(user));
});
app.post('/api/conversations', (req, res) => {
  const { title, user } = req.body;
  const result = db.prepare('INSERT INTO conversations (title, user, is_work) VALUES (?, ?, 0)').run(title || '新对话', user || 'felix');
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

// Work conversation (auto-create if missing)
app.get('/api/work-conversation/:user', (req, res) => {
  const { user } = req.params;
  let conv = db.prepare('SELECT * FROM conversations WHERE user = ? AND is_work = 1').get(user);
  if (!conv) {
    const result = db.prepare('INSERT INTO conversations (title, user, is_work) VALUES (?, ?, 1)').run('工作对话', user);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid);
  }
  res.json(conv);
});

// Chat
app.post('/api/conversations/:id/chat', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const { message, user } = req.body;
  const file = req.file;
  if (!message && !file) return res.status(400).json({ error: 'No message or file' });

  let userMessageContent = message || '';
  if (file) {
    const isImage = /^image\//i.test(file.mimetype);
    if (isImage) {
      const base64 = file.buffer.toString('base64');
      userMessageContent += (userMessageContent ? '\n' : '') + `[图片: ${file.originalname}]<image_data type="${file.mimetype}" base64="${base64}"/>`;
    } else {
      let content = file.buffer.toString('utf8');
      if (content.length > 10000) content = content.substring(0, 10000) + '\n...(已截断)';
      userMessageContent += (userMessageContent ? '\n\n' : '') + `[文件: ${file.originalname}]\n\`\`\`\n${content}\n\`\`\``;
    }
  }

  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(id, 'user', userMessageContent);
  db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (conv.is_work === 0 && conv.title === '新对话') {
    const titleText = message || file.originalname;
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(titleText.slice(0, 20).trim(), id);
  }
  const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(id);
  const u = user || 'felix';
  const systemPrompt = buildSystemPrompt(u, conv.is_work === 1);
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const MAX_MSG_CHARS = 8000;
    const CHAR_BUDGET = 100000; // 约 30K tokens，给 system prompt 和工具留足余量

    function buildApiMessages(histSlice) {
      const lastIdx = histSlice.length - 1;
      return histSlice.map((m, i) => {
        const imgMatch = m.content.match(/\[图片:[^\]]+\]<image_data type="([^"]+)" base64="([^"]+)"\/>/);
        if (imgMatch) {
          const textPart = m.content.replace(/\[图片:[^\]]+\]<image_data[^/]*\/>/, '').trim();
          if (i === lastIdx && m.role === 'user') {
            const [, mediaType, base64] = imgMatch;
            const parts = [];
            if (textPart) parts.push({ type: 'text', text: textPart });
            parts.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
            return { role: m.role, content: parts };
          } else {
            return { role: m.role, content: textPart ? `${textPart}\n[图片]` : '[图片]' };
          }
        }
        const text = m.content.length > MAX_MSG_CHARS
          ? m.content.slice(0, MAX_MSG_CHARS) + '\n...(内容已截断)'
          : m.content;
        return { role: m.role, content: text };
      });
    }

    function totalChars(msgs) {
      return msgs.reduce((sum, m) => {
        if (Array.isArray(m.content)) {
          return sum + m.content.reduce((s, p) => {
            if (p.type === 'text') return s + p.text.length;
            if (p.type === 'image') return s + (p.source?.data?.length || 0); // 计入图片 base64 大小
            return s;
          }, 0);
        }
        return sum + m.content.length;
      }, 0);
    }

    // 逐步缩减历史，直到总字符量在预算内
    // 即使缩减到只剩当前消息仍超出，也直接发送（图片本身太大时无法进一步压缩）
    let apiMessages;
    for (const size of [8, 4, 2, 1]) {
      apiMessages = buildApiMessages(history.slice(-size));
      if (totalChars(apiMessages) <= CHAR_BUDGET || size === 1) break;
    }
    const fullResponse = await runChat(apiMessages, systemPrompt, u, res);
    const cleanResponse = fullResponse.replace(/\n\*[💾📧📤📋🔍].*?\*\n/g, '').trim();
    db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(id, 'assistant', cleanResponse);
    const updated = db.prepare('SELECT title FROM conversations WHERE id = ?').get(id);
    res.write(`data: ${JSON.stringify({ done: true, title: updated.title, cleanText: cleanResponse })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// Memory doc
app.get('/api/memory-doc/:user', (req, res) => {
  res.json(getMemoryDoc(req.params.user));
});
app.put('/api/memory-doc/:user', (req, res) => {
  const { user } = req.params;
  const { personal, work } = req.body;
  if (personal !== undefined) upsertMemoryDoc(user, 'personal', personal);
  if (work !== undefined) upsertMemoryDoc(user, 'work', work);
  res.json({ ok: true });
});

// Briefing
app.get('/api/briefing/:user', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json(db.prepare('SELECT * FROM briefings WHERE user = ? AND date = ?').get(req.params.user, today) || null);
});

app.post('/api/briefing/generate', async (req, res) => {
  const { user } = req.body;
  if (!user) return res.status(400).json({ error: 'No user' });
  const today = new Date().toISOString().split('T')[0];
  const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  try {
    const systemPrompt = buildSystemPrompt(user, true);
    const prompt = `今天是${dateStr}。请根据工作记忆的内容生成今天的工作简报，简洁列出今日重点和待办提醒。`;
    const fullText = await runBriefingChat([{ role: 'user', content: prompt }], systemPrompt, user, res);
    const clean = fullText.replace(/\n\*[💾📧📤📋].*?\*\n/g, '').trim();
    db.prepare('INSERT OR REPLACE INTO briefings (user, date, content) VALUES (?, ?, ?)').run(user, today, clean);
    res.write(`data: ${JSON.stringify({ done: true, content: clean })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// Legacy memory endpoints
app.get('/api/memory', (req, res) => {
  const user = req.query.user || 'felix';
  res.json(getMemoryDoc(user));
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
  exec('git -C /root/claude-assistant pull origin main && npm --prefix /root/claude-assistant install --omit=dev', (err, stdout, stderr) => {
    const output = stdout + stderr;
    if (err) { res.send('失败:\n' + output); }
    else { res.send('更新成功！\n' + output + '\n重启中...'); setTimeout(() => process.exit(0), 500); }
  });
});

app.listen(PORT, () => console.log(`Claude running on http://localhost:${PORT}`));
