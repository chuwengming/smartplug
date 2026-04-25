# CHANGELOG — smartplug_pack 修改紀錄

---

## Session：2026-04-25（實驗結果修復 Round 2）

### 修改十二：ESP32 重啟後繼電器狀態全數顯示 OFF（根本原因修復）

**根本原因：** 繼電器狀態從未持久化至 NVS  
`setRelayState()` 只更新 `sensorData.relayStates[]`（揮發性記憶體），未寫 NVS。  
`initSystemData()` 從 NVS 讀繼電器「名稱」，但從未讀「狀態」。  
→ ESP32 重啟後 `publishAllRelayStates()` 廣播的全是 `false`（OFF），UI 全滅。

**修改 `smartPlug_ETH_Next_C3/src/sp_function.cpp`：**

1. **`setRelayState()`** — 每次設定繼電器後，立即持久化至 NVS：
   ```cpp
   preferences.begin("relay-states", false);
   preferences.putBool(("relay" + String(relayId)).c_str(), state);
   preferences.end();
   ```

2. **`initSystemData()`** — 從 NVS 的 `relay-states` 命名空間讀回各繼電器狀態，同步還原 GPIO 輸出：
   ```cpp
   preferences.begin("relay-states", false);
   for (int i = 0; i < RELAY_COUNT; i++) {
     bool saved = preferences.getBool(("relay" + String(i)).c_str(), false);
     sensorData.relayStates[i] = saved;
     digitalWrite(relayPins[i], saved ? HIGH : LOW);
   }
   preferences.end();
   ```
   首次啟動（無 NVS 資料）預設值為 false（全 OFF），行為不變。

**修改 `smartPlug_ETH_Next_C3/src/main.cpp`：**

3. 出廠重置流程新增清除 `relay-states` 命名空間，避免遺留舊狀態。

**資料流（修復後）：**
```
用戶操作繼電器 → setRelayState() → GPIO + sensorData + NVS(relay-states)
ESP32 重啟 → initSystemData() 讀 NVS → sensorData + GPIO 恢復
announce 觸發 → publishAllRelayStates() 廣播正確狀態 → UI 同步
```

---

## Session：2026-04-25（實驗結果修復）

### 修改十一：根據實驗結果修復三個問題（server.js）

#### 問題一：離線偵測延遲 7~8 秒
- **原因**：broker 觸發 LWT（約 2~3s）+ 備援計時器 5s = 約 7~8s
- **修復**：`server.js` 備援 fallback timer 從 **5000ms → 3000ms**
- **預期**：離線確認延遲縮短至 **約 5~6 秒**，不影響正常運作

#### 問題二：ESP32 重啟後兩位使用者繼電器狀態全部顯示關閉
- **原因**：`device_online` 廣播後，server.js 沒有主動請求 ESP32 推送 NVS 繼電器狀態；ESP32 收到 re-announce 只回覆註冊確認，不會自動廣播繼電器狀態
- **修復**：`server.js` section 6 announce response handler 中，收到 ESP32 announce response 確認在線後，立即發布 `smartplug/{plugId}/get_status` → `'all'`，觸發 ESP32 推送所有繼電器狀態
- **Log**：`📥 [Live] [sp123456] 發送 get_status，請求 ESP32 推送繼電器狀態`

#### 問題三：重新登錄後 POST /api/login 回傳 503
- **根因**：用戶登出 → WebSocket 關閉 → 啟動 30s cleanup timer；重新登錄時，MQTT 透過 lib 重連（`statusChange: connected`），但 cleanup timer **只在 WebSocket 重連時取消**；30 秒後 timer 到期，斷掉新建 MQTT 連線，導致 login API 回傳 503
- **修復**：在 `mqttShared.on('statusChange')` handler 中新增：當 `status === 'connected'` 時，若 `clientCleanupTimers` 仍有該 clientId 的計時器，立即 `clearTimeout` 並移除
- **Log**：`✅ [Cleanup] [smartplug_445566] MQTT 重新連線，清理計時器已取消`

---

## Session：2026-04-25（實驗保護調整）

### 修改十：`unknown` 狀態移除全版覆蓋層（實驗安全保護）

**背景：** 實驗前 ESP32 新韌體尚未上傳，`unknown` 狀態（未收到 `live` 訊號）若顯示全版覆蓋層會完全封鎖操作，導致無法進行實驗。

**調整 `app/operation/page.tsx`：**
- `isDeviceReady` 從 `=== 'online'` 改為 `!== 'offline' && !== 'reconnecting'`，`unknown` 狀態允許操作
- 全版覆蓋層條件從 `offline || reconnecting || unknown` 改為僅 `offline || reconnecting`
- `unknown` 狀態下不顯示覆蓋層、不阻擋操作（LWT 未觸發時的安全回退）

**實驗行為說明：**
| 狀態 | 覆蓋層 | 繼電器操作 | 何時出現 |
|------|--------|-----------|---------|
| `unknown` | 無 | 允許 | 尚未收到 `live` 訊號（含 LWT 未啟用） |
| `reconnecting` | 有（藍）| 禁止 | 收到 `live` 後驗證中 |
| `offline` | 有（橘）| 禁止 | 5s 無回應，確認離線 |
| `online` | 無 | 允許 | Announce 回應確認在線 |

**server.js 所有修改保留，無需還原。**

---

## Session：2026-04-25

### 修改九：ESP32C3 無預警斷電自癒機制（LWT + Auto-Healing）

**目標：** 偵測 ESP32 無預警斷電，通知前端凍結 UI；ESP32 重啟後自動同步狀態並解凍，使用者無需重新整理頁面。

**核心設計：**
- 設備層 LWT：`smartplug/{plugId}/live` — `{"state":"0"}` 斷電、`{"state":"1"}` 在線（retained）
- 重啟後同步：server.js 為每個在線 Client 重新發送 Announce → ESP32 訂閱主題並推送 NVS 狀態
- UI 三態：`offline`（凍結）/ `reconnecting`（同步中鎖定）/ `online`（正常操作）

**修改：** `smartPlug_ETH_Next_C3/src/mqtt_manager.cpp`
- `init()`：新增 `mqttClient.setKeepAlive(10)`，將預設 60s 調降至 10s（LWT 觸發時間約 15s）
- `connect()`：
  - 改用帶 LWT 參數的 `mqttClient.connect()` 多載版本
  - LWT Topic：`smartplug/{plugId}/live`，Payload：`{"state":"0"}`，QoS=1，retain=true
  - 連線成功後立即發布 `{"state":"1"}`（retained=true），確保新訂閱者立即得知設備在線

**修改：** `server.js`
- 新增 `plugDeviceStates` Map：追蹤每個 plugId 的設備狀態，防止多個 MQTT 客端重複處理
- 新增 `plugReconnectTimers` Map：管理 2 秒同步等待計時器，防止重複觸發
- `global_message` 新增 `smartplug/{plugId}/live` 主題處理：
  - `state:0`（離線）：清除 `plugStates` 快取 → 廣播 `{type:'device_offline'}`
  - `state:1`（重啟上線）：
    1. 廣播 `{type:'device_reconnecting'}` → UI 鎖定顯示「同步中」
    2. 查詢 `plugClients` 取得在線 ClientID 列表
    3. 為每個在線 Client 發布 Announce（只需 clientId + plugId，觸發 ESP32 現有 announce 處理流程）
    4. 偵測 ESP32 的 announce response（`smartplug/{plugId}/{clientId}/announce`，4 段主題）→ 確認 ESP32 已推送完狀態 → 廣播 `{type:'device_online'}` → UI 解凍（方案 A：精確觸發）
    5. 備援計時器（5 秒）：若 5 秒內未收到 announce response，強制廣播 device_online，防止 UI 卡住
- **Announce Response 識別**：發出的 announce 為 3 段主題（`smartplug/{plugId}/announce`），ESP32 回應為 4 段（`smartplug/{plugId}/{clientId}/announce`），可精確區分
- **設計說明**：server.js 重新 announce 而非 ESP32 自行訂閱 NVS 全部 Client，確保只訂閱當前在線 Client

**修正二：ESP32 重啟後繼電器狀態無法同步（`server.js`）**
- **問題根源**：`live` 處理器有邏輯錯誤 — ESP32 重啟後發布 `state:1`，但若 `plugDeviceStates === 'online'`，handler 提前 `return` 忽略此訊號，導致 re-announce 不發送，繼電器狀態無法同步
- **修正**：移除 `if (isOnline && currentState === 'online') return;` 的提前返回。`state:1` 即使當前認為 online 也繼續執行驗證流程。只有「計時器已存在（處理中）」或「`state:0` 且已是 offline」時才跳過
- **新增診斷日誌**：`live` 訊息收到時輸出 state 值與當前狀態，協助確認 LWT 是否運作
- **新增訂閱確認日誌**：WebSocket 連線後訂閱 `smartplug/${plugId}/#` 時輸出訂閱成功/失敗訊息

**修正：`mqtt_manager.cpp`：`state:1` 發布診斷**
- `connect()` 成功後加入 `delay(100)` + `mqttClient.loop()` 確保連線穩定後再 publish
- 加入 `state:1` 發布結果日誌（成功/失敗），協助識別 LWT retained 訊息是否正確寫入 Broker

**修正：stale retained `live state:0` 導致 UI 永久凍結（`server.js`）**
- **問題根源**：前次 ESP32 斷電後 Broker 留下 retained `state:0`；Next.js 重新訂閱 `smartplug/{plugId}/#` 時收到此訊息，即使 ESP32 目前在線仍宣告離線，導致 UI 無法解凍
- **修正**：統一 `state:0` 與 `state:1` 的處理邏輯，兩者皆進入「驗證/重連」流程：
  - 收到任何 live 訊號 → 發送 re-announce → 等待 ESP32 announce response
  - response 到達 → `device_online`（不論訊號是 state:0 或 state:1）
  - 5 秒無 response（state:0 觸發）→ `device_offline`（確認真正離線）
  - 5 秒無 response（state:1 觸發）→ 備援強制 `device_online`

**修改：** `app/operation/page.tsx`
- 新增 `deviceStatus` state（型別：`'unknown'|'online'|'offline'|'reconnecting'`）
- `handleMessage` 新增三個 case：`device_offline` / `device_reconnecting` / `device_online`
- 新增 `isDeviceReady = deviceStatus === 'online'`，用於控制所有繼電器操作的可用性
- 繼電器開關、點動、修改按鈕：加入 `disabled={!isDeviceReady}`，設備不在線時無法操作
- 新增全頁覆蓋層（z-index: 40）：
  - `unknown`：「連線確認中」（灰色，啟動時短暫出現）
  - `offline`：「設備離線」（橘色 + 跳動點）
  - `reconnecting`：「設備重新連線中，同步狀態」（藍色 + 跳動點）
- WS `onopen`：將 `deviceStatus` 重設為 `unknown`，等待 retained `live` 訊息

**保留：** 個別 ClientID 的 LWT（`{clientId}/offline`）仍維持，功能不同無法互相取代

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

### 修正四：未登出關閉瀏覽器的殭屍連線清理

**檔案：** `server.js`

- 新增 `clientCleanupTimers` Map 追蹤各 clientId 的清理計時器
- `ws.on('close')` 新增 30 秒寬限計時器：
  - 30 秒內同 clientId 重新連線 → 取消計時器，不做任何清理
  - 30 秒到期仍無重連 → 發送 `smartplug/{plugId}/{clientId}/offline` (reason: browser_closed) → `mqttShared.disconnect(clientId)`
- `wss.on('connection')` 新增：若有待執行計時器，立即取消（重連偵測）
- 設計考量：30 秒寬限期避免頁面重新整理被誤判為離線

---

### 修改八：相同 ClientID 多介面衝突防護

**目標：** 登錄頁面在 MQTT 連線前先檢查 ClientID 是否已被其他使用者佔用，若是則顯示警告並阻止連線。

**新增檔案：** `app/api/client-status/route.ts`
- `GET /api/client-status?clientId=XXX`
- 透過 `global[Symbol.for('smartplug.mqtt.manager')]` 讀取 MQTT 連線狀態
- 透過 `global[Symbol.for('smartplug.wsClients')]` 讀取 WebSocket 在線狀態
- 判斷邏輯：`hasMqtt && hasWs` → `inUse: true`（真正衝突）
- 若 MQTT 存在但 WebSocket 已關閉（30 秒寬限期中）→ `inUse: false`（允許重連）

**修改：** `server.js`
- 在 `wsClients` 宣告後，加入 `global[Symbol.for('smartplug.wsClients')] = wsClients;`
- 使 Next.js API Route 能在同一 Node.js 進程中讀取 WebSocket 連線表

**修改：** `app/page.tsx`
- 新增 `clientIdConflict` React state
- `connectMqtt()` 開頭呼叫 `GET /api/client-status`，若 `inUse === true` 立即中止並設置衝突狀態
- ClientID 輸入框改變時清除衝突提示
- 衝突時輸入框顯示紅色外框；輸入框下方出現警告提示卡片，說明 ClientID 已被佔用

---

### 修正二：Announce 通道機制澄清

- 原有 `lib/mqtt.ts` 已正確訂閱 `smartplug/{plugId}/{clientId}/announce` ✅
- ESP32 `sendAnnounceResponse()` 的 payload 早已包含 `registered` 欄位 ✅
- **實際缺失：** 原始 handler 只解析 `voltage`/`plugName`，漏解析 `registered` 欄位
- **本次補充：** 利用現有通道，新增解析 `registered` 寫入 `clientCache.espRegistered`
- 新 `/api/announce-status` 是必要橋樑（瀏覽器無法直接讀取 Node.js 伺服器端記憶體變數）

---
