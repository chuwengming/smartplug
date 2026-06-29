-- 本地實驗用測試資料（SP-H 無點動版）
-- 若已存在相同 factory_serial 或 plug_id，請先 DELETE 或改用 ON DUPLICATE KEY UPDATE

INSERT INTO plug_registry (
  factory_serial,
  plug_id,
  login_password,
  registered,
  ui_type
) VALUES (
  'SP-H-20260501-0001',
  'sp654321',
  '123456',
  'No',
  'B'
);
