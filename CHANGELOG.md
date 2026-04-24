# CHANGELOG — smartplug_pack 修改紀錄

---

## Session：2026-04-24

### 背景說明
將專案 MQTT 連線由公網 broker.emqx.io 改為私有 EMQX 伺服器，
並精簡登錄頁面與 ESP32 註冊頁面的 UI，固定 MQTT 連線參數，
新增 Announce 狀態機以確認 ESP32 授權後才允許密碼輸入。

---

### 修改一：Next.js 預設 MQTT 連線設定更新

**檔案：** `data/setting.json`、`public/data/setting.json`

- **舊值：** broker = `broker.emqx.io`, port = `8083`, username = `""`, password = `""`
- **新值：** broker = `s4eb1262.ala.cn-hangzhou.emqxsl.cn`, port = `8084` (WSS),
  username = `chuwm`, password = `chuwengming`
- clientId 格式改為 `smartplug_XXXXXX`（6位數隨機整數）

---

### 修改二：lib/mqtt.ts — 新增 Announce 回應狀態追蹤

**檔案：** `lib/mqtt.ts`

- `ClientStateCache` 介面新增 `espRegistered: boolean | null` 欄位
  - `null` = 尚未收到 ESP32 Announce 回應
  - `true` = ESP32 確認此 ClientID 已註冊
  - `false` = ESP32 回應此 ClientID 未註冊
- 新增解析 announce 回應中的 `registered` 欄位邏輯
- 新增 `getEspRegistered(clientId?)` 匯出函式
- `connectMqtt()` 開始前重置 `espRegistered = null`
- MQTT 固定連線參數改為私有伺服器設定

---

### 修改三：新增 API 路由 /api/announce-status

**檔案：** `app/api/announce-status/route.ts`（新建）

- `GET /api/announce-status?clientId=XXX`
- 回傳 `{ responded: boolean, registered: boolean | null }`
- 供登錄頁面輪詢 ESP32 Announce 回應狀態

---

### 修改四：Next.js 登錄頁面重構

**檔案：** `app/page.tsx`

- **刪除** MQTT 輸入欄位：伺服器位址、連線埠號、使用者名稱、連線密碼
- **保留** PlugID 輸入欄、Client ID 顯示（唯讀，系統自動產生）
- MQTT 連線使用固定私有伺服器參數（hardcoded）
- ClientID 格式改為 `smartplug_XXXXXX`（6位數隨機整數）
- **新增 Announce 狀態機：**
  - MQTT 連線成功 → 啟動 announce 輪詢（每 2 秒，最長 30 秒）
  - ESP32 回應 registered: true → 允許輸入密碼
  - ESP32 回應 registered: false → 顯示「未授權」錯誤，禁止輸入
  - 逾時 → 顯示「ESP32 未回應」警告，禁止輸入
- 所有 input 均加入清晰的 placeholder value
- 所有說明文字改為黑色

---

### 修改五：ESP32 MqttManager::loadConfig() 預設連線更新

**檔案：** `smartPlug_ETH_Next_C3/src/mqtt_manager.cpp`

- **舊預設：** broker = `broker.emqx.io`, port = `1883`, username = `""`, password = `""`
- **新預設：** broker = `s4eb1262.ala.cn-hangzhou.emqxsl.cn`, port = `8883` (MQTTS),
  username = `chuwm`, password = `chuwengming`
- `generateDefaultClientId()` 格式改為 `smartplug_XXXXXX`（6位隨機數）

---

### 修改六：ESP32 註冊頁面精簡

**檔案：** `smartPlug_ETH_Next_C3/data/login.html`

- **刪除** 輸入欄位：MQTT Broker、MQTT Port、MQTT 用戶名、MQTT 密碼
- 保留：PlugID、ClientID 輸入欄位
- `registerClient()` 函式改為使用 hardcoded 固定伺服器參數
- 新增 ClientID placeholder：`smartplug_XXXXXX（6位數）`
- 說明文字與 label 均統一為黑色 (`color: #333`)
- 所有 input 均加入有意義的 placeholder

---

## Session：2026-04-24（修正補充）

### 修正一：Port 與協定錯誤

**檔案：** `lib/mqtt-shared.js`

- 原始邏輯只區分 `ws://` 和 `mqtt://`，無法處理 TLS 連線
- **修正後邏輯（四種情境）：**
  - Port 1883 → `mqtt://broker:1883` (TCP 明文)
  - Port **8883** → `mqtts://broker:8883` (TCP + TLS) **← 本專案採用**
  - Port 8083 → `ws://broker:8083/mqtt` (WebSocket 明文)
  - Port 8084 → `wss://broker:8084/mqtt` (WebSocket + TLS)
- 注意：TCP 協定 URL 不附加 `/mqtt` 路徑，該路徑為 WebSocket 專用

**檔案：** `data/setting.json`、`public/data/setting.json`、`app/page.tsx`

- Port 由錯誤的 `8084` (WSS) 更正為 `8883` (MQTTS/TCP+TLS)

---

### 修正三：ESP32 MQTT TLS 連線失敗修復

**檔案：** `smartPlug_ETH_Next_C3/include/mqtt_manager.h`

- `WiFiClient` 改為 `WiFiClientSecure`（Port 8883 需要 TLS）
- 說明：ESP32-C3 的 TLS 由 ESP-IDF mbedTLS 透過 LwIP socket 提供，W5500 Ethernet 同樣適用

**檔案：** `smartPlug_ETH_Next_C3/src/mqtt_manager.cpp`

- `init()` 中新增 `wifiClient.setInsecure()` → 跳過 CA 憑證驗證（適合開發階段）
- 若需生產環境安全性，可改為 `wifiClient.setCACert(emqx_ca_cert)`

---

### 修正二：Announce 通道機制澄清

- 原有 `lib/mqtt.ts` 已正確訂閱 `smartplug/{plugId}/{clientId}/announce` ✅
- ESP32 `sendAnnounceResponse()` 的 payload 早已包含 `registered` 欄位 ✅
- **實際缺失：** 原始 handler 只解析 `voltage`/`plugName`，漏解析 `registered` 欄位
- **本次補充：** 利用現有通道，新增解析 `registered` 寫入 `clientCache.espRegistered`
- 新 `/api/announce-status` 是必要橋樑（瀏覽器無法直接讀取 Node.js 伺服器端記憶體變數）

---
