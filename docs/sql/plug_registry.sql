-- 中央註冊：出廠序號 ↔ PlugID ↔ 設備登入密碼
-- 執行前請先 USE 您的資料庫

CREATE TABLE IF NOT EXISTS plug_registry (
  factory_serial   VARCHAR(32)  NOT NULL,
  plug_id          VARCHAR(16)  NOT NULL,
  login_password   VARCHAR(64)  NOT NULL DEFAULT '123456',
  registered       ENUM('Yes', 'No') NOT NULL DEFAULT 'No',
  manufacture_date DATE         NULL,
  created_at       TIMESTAMP    NULL DEFAULT NULL COMMENT 'ESP32 配號成功時寫入',
  updated_at       TIMESTAMP    NULL DEFAULT NULL COMMENT 'ESP32 修改密碼時寫入',
  PRIMARY KEY (factory_serial),
  UNIQUE KEY uk_plug_id (plug_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 若表已存在，可改欄位為可空並移除自動時間戳：
-- ALTER TABLE plug_registry
--   MODIFY COLUMN created_at TIMESTAMP NULL DEFAULT NULL,
--   MODIFY COLUMN updated_at TIMESTAMP NULL DEFAULT NULL;

-- 範例測試資料（created_at / updated_at 初始為 NULL）
-- INSERT INTO plug_registry (factory_serial, plug_id, login_password, registered)
-- VALUES
--   ('FACTORY001', 'sp482966', '123456', 'No'),
--   ('FACTORY002', 'sp654321', '123456', 'No');
