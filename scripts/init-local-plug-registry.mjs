/**
 * 初始化本地 plug_registry（建表、補 ui_type、寫入測試列）
 * 用法：node scripts/init-local-plug-registry.mjs
 * 需設定環境變數 DATABASE_URL，或於 .env.local 內設定本地 MySQL 連線字串
 */
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.startsWith('DATABASE_URL=')) continue;
      const value = trimmed.slice('DATABASE_URL='.length).trim();
      if (value) return value;
    }
  }
  return null;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS plug_registry (
  factory_serial   VARCHAR(32)  NOT NULL,
  plug_id          VARCHAR(16)  NOT NULL,
  login_password   VARCHAR(64)  NOT NULL DEFAULT '123456',
  registered       ENUM('Yes', 'No') NOT NULL DEFAULT 'No',
  ui_type          VARCHAR(5)   NOT NULL DEFAULT 'A' COMMENT 'A=含點動, B=無點動',
  manufacture_date DATE         NULL,
  created_at       TIMESTAMP    NULL DEFAULT NULL COMMENT 'ESP32 配號成功時寫入',
  updated_at       TIMESTAMP    NULL DEFAULT NULL COMMENT 'ESP32 修改密碼時寫入',
  PRIMARY KEY (factory_serial),
  UNIQUE KEY uk_plug_id (plug_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const SEED_ROW = {
  factory_serial: 'SP-H-20260501-0001',
  plug_id: 'sp654321',
  login_password: '123456',
  registered: 'No',
  ui_type: 'B',
};

async function columnExists(conn, table, column) {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].cnt > 0;
}

async function main() {
  const databaseUrl = loadDatabaseUrl();
  if (!databaseUrl) {
    console.error('❌ 未設定 DATABASE_URL（請在 .env.local 設定本地 MySQL 連線）');
    process.exit(1);
  }

  console.log('🔗 連線:', databaseUrl.replace(/:([^:@/]+)@/, ':***@'));
  const conn = await mysql.createConnection(databaseUrl);

  await conn.execute(CREATE_TABLE);
  console.log('✅ plug_registry 表已就緒');

  if (!(await columnExists(conn, 'plug_registry', 'ui_type'))) {
    await conn.execute(
      `ALTER TABLE plug_registry
       ADD COLUMN ui_type VARCHAR(5) NOT NULL DEFAULT 'A'
       COMMENT 'A=含點動, B=無點動'
       AFTER registered`
    );
    console.log('✅ 已新增 ui_type 欄位');
  } else {
    console.log('ℹ️ ui_type 欄位已存在');
  }

  const [cols] = await conn.execute('SHOW COLUMNS FROM plug_registry');
  console.log('📋 欄位:', cols.map((c) => c.Field).join(', '));

  await conn.execute(
    `INSERT INTO plug_registry (factory_serial, plug_id, login_password, registered, ui_type)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       plug_id = VALUES(plug_id),
       login_password = VALUES(login_password),
       registered = VALUES(registered),
       ui_type = VALUES(ui_type)`,
    [
      SEED_ROW.factory_serial,
      SEED_ROW.plug_id,
      SEED_ROW.login_password,
      SEED_ROW.registered,
      SEED_ROW.ui_type,
    ]
  );
  console.log('✅ 測試資料已寫入:', SEED_ROW.factory_serial, '→', SEED_ROW.plug_id);

  const [rows] = await conn.execute(
    'SELECT factory_serial, plug_id, registered, ui_type FROM plug_registry WHERE factory_serial = ?',
    [SEED_ROW.factory_serial]
  );
  console.log('📄 查詢結果:', rows[0]);

  await conn.end();
}

main().catch((err) => {
  console.error('❌ 失敗:', err.message);
  process.exit(1);
});
