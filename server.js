const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer } = require('ws');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

// 溫度記錄服務
const { initTemperatureLogger, startTemperatureLogging, getLoggerStatus } = require('./lib/temperature-logger');
const { initTimeSync, startPeriodicTimeSync } = require('./lib/ntp-client');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = process.env.PORT || 3000;

const app = next({ dev, port });
const handle = app.getRequestHandler();

// ==========================================
// MQTT 配置 (由 lib/mqtt-shared 管理)
// ==========================================
const mqttShared = require('./lib/mqtt-shared');
const { purgeClientSession } = require('./lib/client-session');

// 用來追蹤已訂閱的 plugID，避免重複訂閱
const subscribedPlugs = new Set();

// 用來追蹤 WebSocket 客戶端
const wsClients = new Map(); // clientId -> { ws, plugId }
const plugClients = new Map(); // plugId -> Set(clientId)
const plugStates = new Map(); // plugId -> { relays: Map(id -> {state, name}) }

// 將 wsClients 暴露至 global，供 Next.js API Route 讀取（同一 Node.js 進程共享）
global[Symbol.for('smartplug.wsClients')] = wsClients;

// 未登出清理計時器：WS 斷開後 30 秒內若未重連，清理 MQTT 連線並通知 ESP32
const clientCleanupTimers = new Map(); // clientId -> { timer, plugId }
const CLEANUP_DELAY_MS = 30 * 1000;

global[Symbol.for('smartplug.onSessionPurged')] = (clientId) => {
    if (clientCleanupTimers.has(clientId)) {
        clearTimeout(clientCleanupTimers.get(clientId).timer);
        clientCleanupTimers.delete(clientId);
    }
};

// ESP32 設備在線狀態追蹤
// 'unknown' = 尚未收到 live 訊息；'online' = 在線；'offline' = 離線；'reconnecting' = 重啟同步中
const plugDeviceStates = new Map(); // plugId -> 'unknown'|'online'|'offline'|'reconnecting'

// 防止重複觸發 device_online 廣播的計時器
const plugReconnectTimers = new Map(); // plugId -> timeout handle

function getOrCreatePlugState(plugId) {
    if (!plugStates.has(plugId)) {
        plugStates.set(plugId, {
            relays: new Map()
        });
    }
    return plugStates.get(plugId);
}

// 監聽 MQTT 狀態變化並廣播給對應的 WS 客戶端
mqttShared.on('statusChange', (clientId, status) => {
    console.log(`📢 [Server] [${clientId}] MQTT 狀態變更: ${status}`);

    // MQTT 重新連線時，立刻取消 30s 清理計時器
    // 原因：用戶登出後 WS 關閉啟動 30s 計時器，重新登錄時 MQTT 先於 WS 重連
    //       若不在此取消，計時器到期會斷掉剛重建的 MQTT 連線，導致 /api/login 503
    if (status === 'connected' && clientCleanupTimers.has(clientId)) {
        const { timer } = clientCleanupTimers.get(clientId);
        clearTimeout(timer);
        clientCleanupTimers.delete(clientId);
        console.log(`✅ [Cleanup] [${clientId}] MQTT 重新連線，清理計時器已取消`);
    }

    const client = wsClients.get(clientId);
    if (client && client.ws.readyState === 1) {
        client.ws.send(JSON.stringify({
            type: 'mqtt_status',
            connected: status === 'connected',
            status: status
        }));
    }
});

// MQTT 重連且 WS 仍在：補訂閱 plug wildcard（內部會去重，不重複 subscribe）
mqttShared.on('connect', (clientId) => {
    const wsInfo = wsClients.get(clientId);
    if (!wsInfo?.plugId) return;
    mqttShared.ensurePlugWildcardSubscription(clientId, wsInfo.plugId, (err) => {
        if (!err) {
            console.log(`📡 [Shared-Sub] [${clientId}] 訂閱: smartplug/${wsInfo.plugId}/#`);
        }
    });
});

// 全域訊息同步：當任何一個 MQTT 連線收到 plugId 的狀態更新，同步給所有關注該 plugId 的 WS
const SERVER_GLOBAL_MSG_KEY = Symbol.for('smartplug.server.globalMessage');
if (global[SERVER_GLOBAL_MSG_KEY]) {
    mqttShared.removeListener('global_message', global[SERVER_GLOBAL_MSG_KEY]);
}
const onGlobalMessage = (topic, message, sourceClientId) => {
    // 解析主題獲取 plugId
    const parts = topic.split('/');
    if (parts.length < 2) return;
    const plugId = parts[1];

    let wsMsg = null;
    const msgStr = message.toString();

    try {
        // 1. 繼電器狀態同步 (smartplug/{plugId}/status)
        if (topic.endsWith('/status')) {
            const data = JSON.parse(msgStr);
            const relayId = data.relay_id !== undefined ? data.relay_id : data.id;
            const relayState = data.state;

            if (relayId !== undefined) {
                const state = getOrCreatePlugState(plugId);
                state.relays.set(relayId, {
                    ...(state.relays.get(relayId) || { name: `Relay ${relayId + 1}` }),
                    state: relayState
                });

                wsMsg = {
                    type: 'relay_response',
                    relay_id: relayId,
                    state: relayState
                };
            }
        }
        // 2. 繼電器名稱同步 (smartplug/{plugId}/relay/{id}/name)
        else if (topic.includes('/relay/') && topic.endsWith('/name')) {
            const relayId = parseInt(parts[3]);
            const state = getOrCreatePlugState(plugId);

            // 更新快取
            state.relays.set(relayId, {
                ...(state.relays.get(relayId) || { state: false }),
                name: msgStr
            });

            wsMsg = {
                type: 'relay_name_updated',
                relay_id: relayId,
                name: msgStr
            };
        }
        // 3. 電壓數據同步 (smartplug/{plugId}/voltage)
        else if (topic.endsWith('/voltage')) {
            let voltage = 0;
            try {
                const data = JSON.parse(msgStr);
                voltage = (data && data.voltage !== undefined) ? data.voltage : data;
            } catch (e) {
                // 非 JSON，嘗試從字串提取數字 (如 "220V")
                const match = msgStr.match(/(\d+(\.\d+)?)/);
                if (match) voltage = parseFloat(match[1]);
            }

            // 如果 voltage 是字串，再次嘗試提取數字
            if (typeof voltage === 'string') {
                const vMatch = voltage.match(/(\d+(\.\d+)?)/);
                if (vMatch) voltage = parseFloat(vMatch[1]);
                else voltage = 0;
            }

            wsMsg = {
                type: 'sensor_data',
                voltage: Number(voltage) || 0,
                temperature: (typeof currentTemperature !== 'undefined') ? currentTemperature : 0
            };
        }
        // 4. 插座名稱同步 (smartplug/{plugId}/plugName)
        else if (topic.endsWith('/plugName')) {
            const plugNameValue = (typeof msgStr === 'string' && msgStr.startsWith('{'))
                ? JSON.parse(msgStr).plugName
                : msgStr;

            wsMsg = {
                type: 'plug_name_updated',
                plugName: plugNameValue
            };
        }
        // 5. ESP32 設備在線/離線 (smartplug/{plugId}/live) — LWT 機制
        else if (parts.length === 3 && parts[2] === 'live') {
            const liveData = JSON.parse(msgStr);
            const isOnline = (liveData.state === '1' || liveData.state === 1);
            const currentState = plugDeviceStates.get(plugId) || 'unknown';

            // ── 診斷日誌：確認 live 訊息有被收到 ──
            console.log(`📩 [Live] [${plugId}] 收到 state:${liveData.state}，currentState=${currentState}，timer=${plugReconnectTimers.has(plugId)}`);

            // ── 統一「驗證/重連」流程（state:0 與 state:1 均走相同路徑）──
            //
            // 設計說明：
            //   state:0 可能是 LWT（真正離線）或 stale retained（舊殘留），需驗證
            //   state:1 可能是初始訂閱推送（retained）或 ESP32 重啟後發布的新訊號
            //     → 即使 currentState === 'online' 也必須觸發驗證，因為這表示 ESP32 重啟了，
            //       需要重新 announce 以同步繼電器狀態
            //   因此：僅在「計時器已在執行中」或「state:0 且已確認離線」時才跳過

            // 去重防護
            if (plugReconnectTimers.has(plugId)) {
                console.log(`ℹ️ [Live] [${plugId}] 計時器已存在，忽略重複訊息`);
                return;
            }
            // state:0 且已是 offline → 無需重複處理
            if (!isOnline && currentState === 'offline') {
                console.log(`ℹ️ [Live] [${plugId}] 已是 offline，忽略重複 state:0`);
                return;
            }
            // ⚠️ 注意：state:1 即使 currentState === 'online' 也繼續往下執行
            // 原因：ESP32 重啟後會重新發布 state:1，這是重啟訊號，必須觸發 re-announce 同步狀態

            // 記錄觸發來源，供 fallback 決策使用
            const triggeredByOffline = !isOnline;

            plugDeviceStates.set(plugId, 'reconnecting');
            plugStates.delete(plugId); // 清除可能過時的繼電器快取

            broadcastToPlug(plugId, { type: 'device_reconnecting', plugId });
            console.log(`🔍 [Live] [${plugId}] 收到 state:${isOnline ? '1（重啟）' : '0（可能 stale）'}，發送 re-announce 驗證...`);

            // 為所有在線 Client 送出 re-announce → 觸發 ESP32 現有 announce 處理流程
            const onlineClients = plugClients.get(plugId);
            if (onlineClients && onlineClients.size > 0) {
                let publisher = null;
                for (const cid of onlineClients) {
                    const mc = mqttShared.getClient(cid);
                    if (mc && mc.connected) { publisher = mc; break; }
                }
                if (publisher) {
                    const announceTopic = `smartplug/${plugId}/announce`;
                    for (const cid of onlineClients) {
                        const payload = JSON.stringify({ clientId: cid, plugId });
                        // 調降 QoS 至 0，減少 TLS 往返負擔
                        publisher.publish(announceTopic, payload, { qos: 0 });
                        console.log(`📢 [Live] [${plugId}] re-announce → ${cid} (QoS 0)`);
                    }
                } else {
                    console.warn(`⚠️ [Live] [${plugId}] 無可用 MQTT 客端，無法發送 re-announce`);
                }
            } else {
                console.log(`ℹ️ [Live] [${plugId}] 目前無在線 Client，跳過 re-announce`);
            }

            // 備援計時器：3 秒內未收到 announce response 時的最終決策
            const fallbackTimer = setTimeout(() => {
                if (plugDeviceStates.get(plugId) !== 'reconnecting') return;
                plugReconnectTimers.delete(plugId);

                if (triggeredByOffline) {
                    // state:0 觸發 + 無回應 → 確認真正離線
                    plugDeviceStates.set(plugId, 'offline');
                    broadcastToPlug(plugId, { type: 'device_offline', plugId });
                    console.log(`📴 [Live] [${plugId}] 3s 無 announce response，確認 ESP32 真正離線`);
                } else {
                    // state:1 觸發 + 無回應 → 備援強制解凍（ESP32 可能仍在啟動中）
                    plugDeviceStates.set(plugId, 'online');
                    broadcastToPlug(plugId, { type: 'device_online', plugId });
                    console.warn(`⚠️ [Live] [${plugId}] 備援計時器：3s 未收到 announce response，強制解凍 UI`);
                }
            }, 3000);

            plugReconnectTimers.set(plugId, fallbackTimer);

            // live 主題已獨立處理，不設置 wsMsg
            return;
        }
        // 6. ESP32 Announce Response (smartplug/{plugId}/{clientId}/announce)
        //    主題格式：4 段，第 4 段為 'announce'
        //    區分：發出給 ESP32 的 announce 是 3 段（smartplug/{plugId}/announce）
        else if (parts.length === 4 && parts[3] === 'announce') {
            // 僅在重連同步期間處理：收到第一個 announce response 即代表 ESP32 已訂閱並推送狀態完畢
            if (plugDeviceStates.get(plugId) === 'reconnecting' && plugReconnectTimers.has(plugId)) {
                clearTimeout(plugReconnectTimers.get(plugId)); // 取消備援計時器
                plugReconnectTimers.delete(plugId);
                plugDeviceStates.set(plugId, 'online');
                broadcastToPlug(plugId, { type: 'device_online', plugId });
                console.log(`✅ [Live] [${plugId}] 收到 ESP32 announce response，狀態同步完成，UI 解凍`);

                // ESP32 收到 announce 會自動觸發 pushAllStatus 推送所有繼電器狀態，
                // 這裡無需再次發送 get_status 請求。
            }
            // announce response 由 lib/mqtt.ts 的登錄頁面流程另行處理（espRegistered 判斷）
            // 此處不重複廣播，直接返回
            return;
        }
    } catch (e) {
        console.warn(`⚠️ [Sync] 解析訊息失敗 (${topic}):`, e.message);
    }

    // 如果有生成結構化訊息，廣播給所有關注此 plugId 的客戶端
    if (wsMsg) {
        const targetClients = plugClients.get(plugId);
        if (targetClients) {
            const finalMsg = JSON.stringify(wsMsg);
            targetClients.forEach(cid => {
                const client = wsClients.get(cid);
                if (client && client.ws.readyState === 1) {
                    client.ws.send(finalMsg);
                }
            });
        }
    }

    // 溫度記錄處理
    if (topic.endsWith('/temperature')) {
        try {
            const payload = JSON.parse(msgStr);
            if (payload.temperature !== undefined) {
                currentTemperature = payload.temperature;
            }
        } catch (e) { }
    }
};
global[SERVER_GLOBAL_MSG_KEY] = onGlobalMessage;
mqttShared.on('global_message', onGlobalMessage);

// ==========================================
// 處理 MQTT 收到的訊息 (ESP32 -> Server -> UI)
// ==========================================
const SERVER_MESSAGE_KEY = Symbol.for('smartplug.server.message');
if (global[SERVER_MESSAGE_KEY]) {
    mqttShared.removeListener('message', global[SERVER_MESSAGE_KEY]);
}
const onMqttMessage = (topic, message) => {
    try {
        const msgString = message.toString();
        const parts = topic.split('/');

        if (parts.length < 3 || parts[0] !== 'smartplug') return;

        const plugId = parts[1];
        const category = parts[2];
        const subCategory = parts[3];

        const payload = JSON.parse(msgString);
        let frontendData = null;

        if (category === 'temperature') {
            frontendData = {
                type: 'sensor_data',
                temperature: payload.temperature
            };
        }
        else if (category === 'voltage') {
            let voltageValue = 0;
            if (typeof payload === 'object' && payload !== null && payload.voltage !== undefined) {
                voltageValue = payload.voltage;
            } else {
                voltageValue = payload;
            }

            // 處理字串格式如 "220V"
            if (typeof voltageValue === 'string') {
                const match = voltageValue.match(/(\d+(\.\d+)?)/);
                if (match) voltageValue = parseFloat(match[1]);
                else voltageValue = 0;
            }

            frontendData = {
                type: 'sensor_data',
                voltage: Number(voltageValue) || 0
            };
        }
        else if (category === 'relay') {
            const state = getOrCreatePlugState(plugId);
            if (subCategory === 'state') {
                state.relays.set(payload.id, {
                    ...(state.relays.get(payload.id) || { name: `Relay ${payload.id + 1}` }),
                    state: payload.state === "1"
                });

                frontendData = {
                    type: 'relay_response',
                    relay_id: payload.id,
                    state: payload.state === "1"
                };
            } else if (subCategory === 'name') {
                state.relays.set(payload.id, {
                    ...(state.relays.get(payload.id) || { state: false }),
                    name: payload.name
                });

                frontendData = {
                    type: 'relay_name_updated',
                    relay_id: payload.id,
                    name: payload.name
                };
            }
        }
        else if (category === 'plugName') {
            frontendData = {
                type: 'plug_name_updated',
                plugName: payload.plugName
            };
        }

        if (frontendData) {
            broadcastToPlug(plugId, frontendData);
        }

    } catch (e) {
        // console.error(`解析 MQTT 訊息失敗 [${topic}]:`, e.message);
    }
};
global[SERVER_MESSAGE_KEY] = onMqttMessage;
mqttShared.on('message', onMqttMessage);

// 廣播給特定 PlugID 的所有連線者
function broadcastToPlug(plugId, data) {
    const clients = plugClients.get(plugId);
    if (!clients) return;

    const message = JSON.stringify(data);
    clients.forEach(clientId => {
        const client = wsClients.get(clientId);
        if (client && client.ws.readyState === 1) {
            client.ws.send(message);
        }
    });
}

// ==========================================
// 處理 WebSocket 訊息 (UI -> Server -> MQTT)
// ==========================================
function handleWsMessage(message, ws, clientId, plugId) {
    try {
        const data = JSON.parse(message);
        const mqttClient = mqttShared.getClient(clientId);

        if (!mqttClient || !mqttClient.connected) {
            console.warn(`⚠️ [WS] [${clientId}] 跳過指令 ${data.command}，因為 MQTT 未連線`);
            ws.send(JSON.stringify({
                type: 'mqtt_status',
                connected: false,
                status: mqttShared.getStatus(clientId)
            }));
            return;
        }

        console.log(`📨 WS收到指令 [${plugId}][${clientId}]:`, data.command);

        switch (data.command) {
            case 'relay_control':
                // 優先使用 relay_id 或 relayIndex
                const rId = data.relay_id !== undefined ? data.relay_id : data.relayIndex;
                if (rId !== undefined) {
                    // 還原原始主題規範: smartplug/{plugId}/{clientId}/control
                    const topic = `smartplug/${plugId}/${clientId}/control`;
                    const payload = JSON.stringify({
                        id: rId,
                        state: data.state ? "1" : "0"
                    });
                    mqttClient.publish(topic, payload);
                    console.log(`📤 [WS] [${clientId}] Command: ${data.command} -> ${topic}`);
                }
                break;

            case 'rename_relay':
            case 'set_relay_name':
                const renId = data.relay_id !== undefined ? data.relay_id : data.relayIndex;
                if (renId !== undefined) {
                    // 還原原始主題規範: smartplug/{plugId}/{clientId}/name
                    const nameTopic = `smartplug/${plugId}/${clientId}/name`;
                    const namePayload = JSON.stringify({
                        id: renId,
                        name: data.name || data.newName
                    });
                    mqttClient.publish(nameTopic, namePayload);
                    console.log(`📤 [WS] [${clientId}] Command: ${data.command} -> ${nameTopic}`);
                }
                break;

            case 'get_sensors':
            case 'get_all_status':
                const reqTopic = `smartplug/${plugId}/get_status`;
                mqttClient.publish(reqTopic, 'all');

                // 相容舊版 sensor 數據請求
                const legacyReqTopic = `smartplug/${plugId}/${clientId}/request`;
                mqttClient.publish(legacyReqTopic, JSON.stringify({ type: "getPlugName" }));
                mqttClient.publish(legacyReqTopic, JSON.stringify({ type: "getVoltage" }));
                break;

            case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
        }
    } catch (e) {
        console.error('❌ 處理 WS 訊息失敗:', e);
    }
}

// 初始化服務與 MQTT 自動重連
async function initializeServices() {
    try {
        console.log('🕒 正在初始化時間同步服務...');
        await initTimeSync();
        startPeriodicTimeSync(60);

        console.log('📝 正在初始化溫度記錄服務...');
        await initTemperatureLogger();

        // 啟動溫度記錄
        startTemperatureLogging(() => {
            return currentTemperature;
        }, 30);

        // ==========================================
        // MQTT 自動重連邏輯 (已移除，改由使用者手動觸發各別連線)
        // ==========================================
        console.log('ℹ️ [AutoReconnect] 已禁用全域自動重連，等待使用者手動連線');

        console.log('✅ 所有服務初始化完成');
    } catch (error) {
        console.error('❌ 服務初始化失敗:', error);
    }
}

let currentTemperature = 25.0;

// 在應用準備完成後初始化服務
app.prepare().then(async () => {
    // 監聽訊息改由 global_message 統一在上面處理

    await initializeServices();

    const server = createServer(async (req, res) => {
        try {
            // Next.js 15+ custom server: 不傳 parsedUrl，避免 host:port 疊加進路徑造成循環
            await handle(req, res);
        } catch (err) {
            console.error('處理 HTTP 錯誤:', err);
            res.statusCode = 500;
            res.end('Internal Server Error');
        }
    });

    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (ws, request) => {
        try {
            const url = new URL(request.url, `http://${request.headers.host}`);
            const clientId = url.searchParams.get('clientId') || `user_${Date.now()}`;
            const plugId = url.searchParams.get('plugId');

            if (!plugId) {
                ws.close(1008, 'PlugID Required');
                return;
            }

            console.log(`🔌 新連線: User=[${clientId}] -> Plug=[${plugId}]`);

            // 處理舊 Session 與計時器清理
            if (clientCleanupTimers.has(clientId)) {
                clearTimeout(clientCleanupTimers.get(clientId).timer);
                clientCleanupTimers.delete(clientId);
                console.log(`✅ [Cleanup] [${clientId}] 重新連線，取消清理計時器`);
            }

            // 若該 clientId 已經存在（可能來自之前的 stale session），先從舊的 plugId 清單中移除
            if (wsClients.has(clientId)) {
                const oldInfo = wsClients.get(clientId);
                const oldPlugId = oldInfo.plugId;
                if (plugClients.has(oldPlugId)) {
                    plugClients.get(oldPlugId).delete(clientId);
                    if (plugClients.get(oldPlugId).size === 0) {
                        plugClients.delete(oldPlugId);
                    }
                }
                console.log(`🔄 [WS] [${clientId}] 變更 PlugID: ${oldPlugId} -> ${plugId}`);
            }

            wsClients.set(clientId, { ws, plugId });
            if (!plugClients.has(plugId)) {
                plugClients.set(plugId, new Set());
            }
            plugClients.get(plugId).add(clientId);

            // 檢查該 Client 是否已有對應的 MQTT 連線
            const status = mqttShared.getStatus(clientId);
            const mqttClient = mqttShared.getClient(clientId);

            if (mqttClient && mqttClient.connected) {
                mqttShared.ensurePlugWildcardSubscription(clientId, plugId, (err) => {
                    const topic = `smartplug/${plugId}/#`;
                    if (err) {
                        console.error(`❌ [WS] [${clientId}] 訂閱失敗: ${topic}`, err.message);
                    } else {
                        console.log(`📡 [WS] [${clientId}] 訂閱成功: ${topic}（含 live LWT 主題）`);
                    }
                });

                ws.send(JSON.stringify({
                    type: 'mqtt_status',
                    connected: true,
                    status: 'connected'
                }));
            } else {
                ws.send(JSON.stringify({
                    type: 'mqtt_status',
                    connected: false,
                    status: status
                }));
            }

            // --- 新增：同步當前 Plug 狀態給新連線 ---
            const state = plugStates.get(plugId);
            if (state) {
                console.log(`📤 [Sync] 向新連線 [${clientId}] 推送 [${plugId}] 的現有狀態 (${state.relays.size} 個繼電器)`);
                state.relays.forEach((val, id) => {
                    ws.send(JSON.stringify({
                        type: 'relay_response',
                        relay_id: id,
                        state: val.state
                    }));
                    ws.send(JSON.stringify({
                        type: 'relay_name_updated',
                        relay_id: id,
                        name: val.name
                    }));
                });
            }

            // 如果是該 Plug 的首位關注者，或者為了保險起見，主動請求一次狀態
            if (mqttClient && mqttClient.connected) {
                const reqTopic = `smartplug/${plugId}/get_status`;
                mqttClient.publish(reqTopic, 'all');
            }

            ws.on('message', (message) => {
                handleWsMessage(message.toString(), ws, clientId, plugId);
            });

            ws.on('close', (code, reason) => {
                console.log(`👋 斷開連線: ${clientId} (code=${code})`);
                wsClients.delete(clientId);
                if (plugClients.has(plugId)) {
                    plugClients.get(plugId).delete(clientId);
                }

                // 啟動 30 秒寬限期計時器
                // 若使用者重新整理頁面，會在此期間重新連線，計時器將被取消
                // 若計時器到期仍無重連，視為真正離線，清理 MQTT 並通知 ESP32
                if (clientCleanupTimers.has(clientId)) {
                    clearTimeout(clientCleanupTimers.get(clientId).timer);
                }
                const cleanupTimer = setTimeout(() => {
                    clientCleanupTimers.delete(clientId);
                    purgeClientSession(clientId, {
                        publishOffline: true,
                        plugId,
                        reason: 'browser_closed',
                    });
                    console.log(`🧹 [Cleanup] [${clientId}] 30 秒未重連，MQTT 與快取已清理`);
                }, CLEANUP_DELAY_MS);

                clientCleanupTimers.set(clientId, { timer: cleanupTimer, plugId });
                console.log(`⏳ [Cleanup] [${clientId}] 已啟動 30 秒清理計時器`);
            });

            ws.on('error', (error) => {
                console.error(`❌ WebSocket 錯誤 [${clientId}]:`, error);
            });

        } catch (error) {
            console.error('❌ WebSocket 連接處理異常:', error);
            ws.close(1011, 'Internal Server Error');
        }
    });

    // 處理 Upgrade 請求
    server.on('upgrade', (request, socket, head) => {
        const { pathname } = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

        if (pathname === '/api/ws/operation') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else if (pathname.startsWith('/_next/')) {
            return;
        } else {
            socket.destroy();
        }
    });

    server.listen(port, hostname, (err) => {
        if (err) throw err;
        console.log(`> Ready on http://${hostname}:${port}`);
    });
});