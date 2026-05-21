import mqtt, { MqttClient } from 'mqtt';
import { setMqttClient as setOperationMqttClient, setPlugId as setOperationPlugId } from './mqtt-operation';
import fs from 'fs/promises';
import path from 'path';

// 設定檔案路徑
const SETTINGS_PATH = path.join(process.cwd(), 'data', 'setting.json');
const PUBLIC_SETTINGS_PATH = path.join(process.cwd(), 'public', 'data', 'setting.json');

// 定義標準Topic
export const MqttTopics = {
  // 電壓數據: smartplug/{plugId}/voltage
  voltage: (plugId: string) => `smartplug/${plugId}/voltage`,
  // 設備名稱: smartplug/{plugId}/plugName
  plugName: (plugId: string) => `smartplug/${plugId}/plugName`,

  // 其他 Topic 定義
  temperature: (plugId: string) => `smartplug/${plugId}/temperature`,
  relayState: (plugId: string) => `smartplug/${plugId}/relay/state`,

  // announce 相關主題
  announce: (plugId: string) => `smartplug/${plugId}/announce`,
  announceResponse: (plugId: string, clientId: string) => `smartplug/${plugId}/${clientId}/announce`,

  // Client 控制主題
  control: (plugId: string, clientId: string) => `smartplug/${plugId}/${clientId}/control`,
  name: (plugId: string, clientId: string) => `smartplug/${plugId}/${clientId}/name`,
  plugNameTopic: (plugId: string, clientId: string) => `smartplug/${plugId}/${clientId}/plugName`,
  request: (plugId: string, clientId: string) => `smartplug/${plugId}/${clientId}/request`,

  // 離線通知主題
  offline: (plugId: string, clientId: string) => `smartplug/${plugId}/${clientId}/offline`,
};

// 更新設定檔案中的 clientId
export async function updateSettingsClientId(clientId: string): Promise<void> {
  try {
    const data = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(data);

    // 如果 clientId 沒變，不執行寫入，避免 Next.js HMR 重啟
    if (settings.mqtt.clientId === clientId) {
      return;
    }

    settings.mqtt.clientId = clientId;
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 4), 'utf-8');
    await fs.writeFile(PUBLIC_SETTINGS_PATH, JSON.stringify(settings, null, 4), 'utf-8');
    console.log(`✅ 設定檔案已更新 clientId: ${clientId}`);
  } catch (error) {
    console.error('更新設定檔案時發生錯誤:', error);
  }
}

// 讀取設定檔案獲取 plugId
async function getPlugIdFromSettings(): Promise<string> {
  try {
    const data = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(data);
    return settings.plugId || 'defaultPlug';
  } catch (error) {
    console.error('讀取設定檔案時發生錯誤:', error);
    return 'defaultPlug';
  }
}

// @ts-ignore
const mqttShared = require('./mqtt-shared');

// MQTT 用戶端實例 (狀態由 shared 管理)
let currentClientId: string = '';
let currentPlugId: string = 'defaultPlug';

// 內存快取數據 (供 API 讀取，區分 ClientID)
// 使用 global 確保在 Next.js HMR 重啟時資料不遺失且跨模組共享
interface ClientStateCache {
  plugName: string;
  voltage: number;
  // null = 尚未收到 ESP32 announce 回應; true = 已授權; false = 未授權
  espRegistered: boolean | null;
}
const CACHE_KEY = Symbol.for('smartplug.mqtt.clientCache');
if (!(global as any)[CACHE_KEY]) {
  (global as any)[CACHE_KEY] = new Map<string, ClientStateCache>();
}
const clientCache: Map<string, ClientStateCache> = (global as any)[CACHE_KEY];

function getOrCreateCache(clientId: string): ClientStateCache {
  if (!clientCache.has(clientId)) {
    console.log(`🆕 [Lib] 為 ${clientId} 建立新的資料快取`);
    clientCache.set(clientId, { plugName: 'SmartPlug', voltage: 0, espRegistered: null });
  }
  return clientCache.get(clientId)!;
}

// MQTT 連線配置介面
interface MqttConfig {
  broker: string;
  port: string;
  clientId: string;
  username?: string;
  password?: string;
}

/** HMR 重載時模組變數會重置，須用 global 避免重複註冊監聽導致 OOM */
const HANDLER_INIT_KEY = Symbol.for('smartplug.mqtt.handlerInited');
const HANDLER_FN_KEY = Symbol.for('smartplug.mqtt.handlerFn');

/**
 * 初始化共享 MQTT 訊息處理器
 * 在多使用者架構中，主要由 server.js 的 global_message 做廣播
 * 此處僅保留基礎的主題監聽，且使用 clientId 作為上下文
 */
function initSharedHandlers() {
  if ((global as any)[HANDLER_INIT_KEY]) return;

  const previous = (global as any)[HANDLER_FN_KEY] as
    | ((topic: string, message: Buffer, clientId: string) => void)
    | undefined;
  if (previous) {
    mqttShared.removeListener('message', previous);
  }

  const handler = (topic: string, message: Buffer, clientId: string) => {
    try {
      const msgString = message.toString();
      const cache = getOrCreateCache(clientId);

      // 電壓解析
      if (topic.endsWith('/voltage')) {
        let parsedVoltage = 0;
        try {
          const payload = JSON.parse(msgString);
          parsedVoltage = (payload && payload.voltage !== undefined) ? payload.voltage : payload;
        } catch (e) {
          // 非 JSON，嘗試直接提取數字
          const match = msgString.match(/(\d+(\.\d+)?)/);
          if (match) parsedVoltage = parseFloat(match[1]);
        }

        // 如果 parsedVoltage 是字串（如 "220V"），再次嘗試提取數字
        if (typeof parsedVoltage === 'string') {
          const vMatch = (parsedVoltage as string).match(/(\d+(\.\d+)?)/);
          if (vMatch) parsedVoltage = parseFloat(vMatch[1]);
          else parsedVoltage = 0;
        }

        cache.voltage = Number(parsedVoltage) || 0;
        if (process.env.MQTT_VERBOSE === '1') {
          console.log(`📊 [Lib] [${clientId}] 電壓更新: ${cache.voltage}V (Raw: ${msgString})`);
        }
      }
      // 插座名稱解析
      else if (topic.endsWith('/plugName')) {
        try {
          const payload = JSON.parse(msgString);
          cache.plugName = (payload && payload.plugName !== undefined) ? payload.plugName : payload;
        } catch (e) {
          cache.plugName = msgString;
        }
        if (process.env.MQTT_VERBOSE === '1') {
          console.log(`🏷️ [Lib] [${clientId}] 插座名稱更新: ${cache.plugName}`);
        }
      }
      // 處理 announce 回應
      else if (topic.includes('/announce')) {
        // 確保是給這個 client 的 (smartplug/id/clientId/announce)
        if (topic.includes(`/${clientId}/announce`)) {
          try {
            const payload = JSON.parse(msgString);
            if (payload.voltage !== undefined) {
              if (typeof payload.voltage === 'string') {
                const vMatch = payload.voltage.match(/(\d+(\.\d+)?)/);
                if (vMatch) cache.voltage = parseFloat(vMatch[1]);
              } else {
                cache.voltage = Number(payload.voltage) || 0;
              }
            }
            if (payload.plugName !== undefined) cache.plugName = payload.plugName;
            // 記錄 ESP32 回應的授權狀態 (registered = true/false)
            if (payload.registered !== undefined) {
              cache.espRegistered = Boolean(payload.registered);
              console.log(`🔑 [Lib] [${clientId}] ESP32 Announce 回應: registered=${cache.espRegistered}`);
            }
            if (process.env.MQTT_VERBOSE === '1') {
              console.log(`✅ [Lib] [${clientId}] 自 announce 更新數據: ${cache.voltage}V, ${cache.plugName} (Raw: ${msgString})`);
            }
          } catch (e) { }
        }
      }
    } catch (e) {
      console.error('❌ [Lib] 訊息處理錯誤:', e);
    }
  };

  (global as any)[HANDLER_FN_KEY] = handler;
  (global as any)[HANDLER_INIT_KEY] = true;
  mqttShared.on('message', handler);
}

// 預先啟動監聽器
initSharedHandlers();

// 連接到 MQTT Broker
export async function connectMqtt(config: MqttConfig): Promise<{ success: boolean; message: string }> {

  try {
    console.log('🔌 透過 SharedManager 請求連接 MQTT:', config.broker);

    // 連線前重置 announce 狀態，避免殘留舊回應
    const cacheEntry = getOrCreateCache(config.clientId);
    cacheEntry.espRegistered = null;

    // 獲取當前 PlugID 正確設置 will 與初始化
    currentPlugId = await getPlugIdFromSettings();
    currentClientId = config.clientId;

    // 將 config 傳給 sharedManager 執行連線
    const client = mqttShared.connect(config, 'Lib', currentPlugId);

    return new Promise((resolve) => {
      const onConnect = (connectedClientId: string) => {
        if (connectedClientId !== config.clientId) return;

        cleanup();
        console.log(`✅ MQTT 連線成功 (Lib: ${config.clientId})`);

        // 更新狀態
        setOperationPlugId(currentPlugId);
        setOperationMqttClient(client, config.clientId);

        // 每位使用者只訂閱一次 smartplug/{plugId}/#（含 announce / voltage / live，避免與單一主題重疊造成雙送）
        mqttShared.ensurePlugWildcardSubscription(currentClientId, currentPlugId, (err: Error | null) => {
          if (err) {
            console.warn(`📡 [Lib] [${currentClientId}] plug # 訂閱失敗，操作頁 WS 將重試:`, err.message);
          } else {
            console.log(`📡 [Lib] [${currentClientId}] 已訂閱 smartplug/${currentPlugId}/#`);
          }
        });

        // 延遲發送初始化命令
        setTimeout(() => {
          if (client.connected) {
            const announceTopic = MqttTopics.announce(currentPlugId);
            const announcePayload = JSON.stringify({
              clientId: currentClientId,
              plugId: currentPlugId,
              broker: config.broker,
              port: config.port,
              username: config.username || "",
              password: config.password || ""
            });
            client.publish(announceTopic, announcePayload, { qos: 1 });
            console.log(`📤 已發送 announce`);
          }
        }, 500);

        setTimeout(() => {
          if (client.connected) {
            const requestTopic = MqttTopics.request(currentPlugId, currentClientId);
            const requestPayload = JSON.stringify({ type: "getVoltage" });
            client.publish(requestTopic, requestPayload, { qos: 1 });
            console.log(`📤 已發送電壓請求 (getVoltage)`);
          }
        }, 1000);

        resolve({ success: true, message: 'MQTT 連線成功' });
      };

      const onError = (clientId: string, err: Error) => {
        if (clientId !== config.clientId) return;
        cleanup();
        resolve({ success: false, message: `連線失敗: ${err.message}` });
      };

      const cleanup = () => {
        mqttShared.removeListener('connect', onConnect);
        mqttShared.removeListener('error', onError);
      };

      mqttShared.on('connect', onConnect);
      mqttShared.on('error', onError);

      // 超時處理
      setTimeout(() => {
        cleanup();
        resolve({ success: false, message: '連線超時' });
      }, 12000);
    });

  } catch (error: any) {
    console.error('MQTT 連線異常:', error);
    return { success: false, message: error.message || '未知錯誤' };
  }
}

// 獲取 MQTT 連線狀態
export function getMqttStatus(clientId?: string): boolean {
  if (!clientId) return false;
  return mqttShared.getStatus(clientId) === 'connected';
}

// 獲取 MQTT 客戶端
export function getMqttClient(clientId?: string): any {
  if (!clientId) return null;
  return mqttShared.getClient(clientId);
}

// 獲取插座名稱
export function getPlugName(clientId?: string): string {
  if (!clientId) return 'SmartPlug';
  const cache = getOrCreateCache(clientId);
  return cache.plugName;
}

// 獲取 ESP32 Announce 授權狀態 (null=尚未回應, true=已授權, false=未授權)
export function getEspRegistered(clientId?: string): boolean | null {
  if (!clientId) return null;
  const cache = getOrCreateCache(clientId);
  return cache.espRegistered;
}

// 獲取電壓
export function getVoltage(clientId?: string): number {
  if (!clientId) return 0;
  const cache = getOrCreateCache(clientId);
  console.log(`🔍 [Lib] [${clientId}] getVoltage 請求: ${cache.voltage}V`);
  return cache.voltage;
}

// 發布訊息
export function publishMqtt(topic: string, message: string, options?: any, clientId?: string): boolean {
  const client = clientId ? mqttShared.getClient(clientId) : null;
  if (!client || !client.connected) return false;
  client.publish(topic, message, { qos: options?.qos ?? 1, retain: options?.retain ?? false });
  return true;
}

// 獲取當前 Client ID
export function getClientId(): string {
  return currentClientId;
}

// 斷開 MQTT 連線並清理快取（登出 / 逾時清理共用）
export function disconnectMqtt(clientId?: string, plugId?: string): void {
  if (!clientId) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { purgeClientSession } = require('./client-session');
  const resolvedPlugId = plugId || mqttShared.getPlugId(clientId) || currentPlugId;
  purgeClientSession(clientId, {
    publishOffline: true,
    plugId: resolvedPlugId,
    reason: 'manual_logout',
  });
}

// PlugID 驗證函數 (供其他模組使用)
export const validatePlugId = (id: string): string => {
  if (!id) return 'PlugID 不能為空';
  if (id.length < 8) return '至少需要8個字元';
  if (!/^[a-zA-Z0-9]+$/.test(id)) return '只能包含英文和數字';
  if (!/[a-zA-Z]/.test(id) || !/[0-9]/.test(id)) return '必須同時包含英文和數字';
  return '';
};
