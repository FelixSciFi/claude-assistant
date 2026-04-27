const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: 'database-1.c9mw00ksuj4h.eu-west-3.rds.amazonaws.com',
  port: 3306,
  user: 'readonly',
  password: 'Amitie.666',
  waitForConnections: true,
  connectionLimit: 3,
  connectTimeout: 15000
});

async function queryERP(sql, database = 'africa-items') {
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
    throw new Error('只允许 SELECT / WITH 查询');
  }
  const conn = await pool.getConnection();
  try {
    await conn.query(`USE \`${database}\``);
    const [rows] = await conn.query({ sql, timeout: 30000 });
    return rows;
  } finally {
    conn.release();
  }
}

module.exports = { queryERP };
