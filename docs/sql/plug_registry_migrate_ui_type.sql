-- 既有本地 plug_registry 表：新增 ui_type 欄位
-- 若欄位已存在會報錯，可忽略；建議改用 scripts/init-local-plug-registry.mjs

ALTER TABLE plug_registry
  ADD COLUMN ui_type VARCHAR(5) NOT NULL DEFAULT 'A'
  COMMENT 'A=含點動, B=無點動'
  AFTER registered;
