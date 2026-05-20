import mysql from 'mysql2/promise';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn('⚠️ [DB] DATABASE_URL 未設定，中央註冊 API 將無法連線資料庫');
}

const pool = DATABASE_URL
  ? mysql.createPool({
      uri: DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    })
  : null;

export default pool;
