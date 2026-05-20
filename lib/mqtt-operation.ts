// @ts-ignore
const mqttShared = require('./mqtt-shared');

// 儲存感測器數據 (由 Shared 廣播驅動)
interface RelayData {
  id: number;
  name: string;
  state: boolean;
}

interface SensorData {
  temperature: number;
  relays: RelayData[];
}

// 數據存儲
const clientDataMap = new Map<string, SensorData>();
const wsClientMap = new Map<string, Set<CustomWebSocket>>();
let currentPlugId: string = '';
let currentClientId: string = '';

/**
 * 獲取或初始化數據
 */
function getOrCreateClientData(clientId: string): SensorData {
  if (!clientDataMap.has(clientId)) {
    clientDataMap.set(clientId, {
      temperature: 0,
      relays: Array.from({ length: 6 }, (_, i) => ({
        id: i,
        name: `Relay ${i + 1}`,
        state: false
      }))
    });
  }
  return clientDataMap.get(clientId)!;
}

// 獲取 MQTT 客戶端
export function getMqttClient(clientId?: string): any {
  if (!clientId) return null;
  return mqttShared.getClient(clientId);
}

// 設置 PlugID
export function setPlugId(plugId: string) {
  currentPlugId = plugId;
  console.log(`✅ [Operation] PlugID 已設置為: ${currentPlugId}`);
}

// 設置 MQTT 客戶端（僅更新操作上下文；MQTT 廣播由 server.js 統一處理，不在此註冊監聽）
export function setMqttClient(_client: any, clientId: string) {
  currentClientId = clientId;
}

// MQTT 主題定義
const MQTT_TOPICS = {
  RELAY_STATE: (plugId: string) => `smartplug/${plugId}/relay/state`,
  RELAY_NAME: (plugId: string) => `smartplug/${plugId}/relay/name`,
  TEMPERATURE: (plugId: string) => `smartplug/${plugId}/temperature`,
  VOLTAGE: (plugId: string) => `smartplug/${plugId}/voltage`,
  PLUG_NAME: (plugId: string) => `smartplug/${plugId}/plugName`,
};

// 處理 MQTT 訊息
function handleMqttMessage(topic: string, message: Buffer, clientId: string) {
  if (!currentPlugId) return;

  const data = message.toString();
  let parsedData: any;
  try {
    parsedData = JSON.parse(data);
  } catch (e) {
    parsedData = data;
  }

  // 根據 Topic 類型分發處理
  if (topic === MQTT_TOPICS.RELAY_STATE(currentPlugId)) {
    handleBroadcastRelayState(parsedData);
  } else if (topic === MQTT_TOPICS.RELAY_NAME(currentPlugId)) {
    handleBroadcastRelayName(parsedData);
  } else if (topic === MQTT_TOPICS.TEMPERATURE(currentPlugId)) {
    handleBroadcastTemperature(parsedData);
  }
}

// 處理廣播繼電器狀態
function handleBroadcastRelayState(data: any) {
  let relayData = data;
  if (typeof relayData === 'string') {
    try {
      relayData = JSON.parse(relayData);
    } catch (e) {
      console.error('RELAY_STATE 訊息格式錯誤');
      return;
    }
  }

  if (relayData.id !== undefined && relayData.state !== undefined) {
    // 兼容字符串 "1"/"0" 或布林值
    let stateBool: boolean;
    if (typeof relayData.state === 'string') {
      stateBool = relayData.state === '1';
    } else {
      stateBool = Boolean(relayData.state);
    }

    // 更新所有客戶端的數據
    clientDataMap.forEach((sensorData, clientId) => {
      if (sensorData.relays[relayData.id]) {
        sensorData.relays[relayData.id].state = stateBool;
        // 廣播給該客戶端的所有 WebSocket 連接
        broadcastToClient(clientId, {
          type: 'relay_response',
          relay_id: relayData.id,
          state: stateBool,
          success: true
        });
      }
    });
  }
}

// 處理廣播繼電器名稱
function handleBroadcastRelayName(data: any) {
  let nameData = data;
  if (typeof nameData === 'string') {
    try {
      nameData = JSON.parse(nameData);
    } catch (e) {
      console.error('RELAY_NAME 訊息格式錯誤');
      return;
    }
  }

  if (nameData.id !== undefined && nameData.name !== undefined) {
    // 更新所有客戶端的數據
    clientDataMap.forEach((sensorData, clientId) => {
      if (sensorData.relays[nameData.id]) {
        sensorData.relays[nameData.id].name = nameData.name;
        // 廣播給該客戶端的所有 WebSocket 連接
        broadcastToClient(clientId, {
          type: 'relay_name_updated',
          relay_id: nameData.id,
          name: nameData.name
        });
      }
    });
  }
}

// 處理廣播溫度
function handleBroadcastTemperature(data: any) {
  let temperatureValue = 0;

  if (typeof data === 'number') {
    temperatureValue = data;
  } else if (typeof data === 'string' && !isNaN(parseFloat(data))) {
    temperatureValue = parseFloat(data);
  } else if (data && typeof data === 'object' && data.temperature !== undefined) {
    temperatureValue = data.temperature;
  }

  // 更新所有客戶端的溫度數據
  clientDataMap.forEach((sensorData, clientId) => {
    sensorData.temperature = temperatureValue;

    // 廣播給該客戶端的所有 WebSocket 連接
    broadcastToClient(clientId, {
      type: 'sensor_data',
      temperature: sensorData.temperature,
      relays: sensorData.relays
    });
  });

  console.log(`📢 廣播溫度更新: ${temperatureValue}°C`);
}

// 處理廣播電壓
function handleBroadcastVoltage(data: any) {
  let voltageValue = 0;

  if (typeof data === 'number') {
    voltageValue = data;
  } else if (typeof data === 'string' && !isNaN(parseFloat(data))) {
    voltageValue = parseFloat(data);
  } else if (data && typeof data === 'object' && data.voltage !== undefined) {
    voltageValue = data.voltage;
  }

  // 更新所有客戶端的電壓數據
  clientDataMap.forEach((sensorData, clientId) => {
    // 更新電壓數據（如果需要可以儲存）
    // 目前僅記錄，未來可擴展
    console.log(`📢 廣播電壓更新: ${voltageValue}V (客戶端 ${clientId})`);
  });

  console.log(`📢 廣播電壓更新: ${voltageValue}V`);
}

// 處理廣播設備名稱
function handleBroadcastPlugName(data: any) {
  let plugName = '';

  if (typeof data === 'string') {
    plugName = data;
  } else if (data && typeof data === 'object' && data.plugName !== undefined) {
    plugName = data.plugName;
  }

  // 更新所有客戶端的設備名稱數據
  clientDataMap.forEach((sensorData, clientId) => {
    // 更新設備名稱數據（如果需要可以儲存）
    // 目前僅記錄，未來可擴展
    console.log(`📢 廣播設備名稱更新: ${plugName} (客戶端 ${clientId})`);
  });

  console.log(`📢 廣播設備名稱更新: ${plugName}`);
}

// 處理個別客戶端插座名稱
function handleClientPlugName(clientId: string, data: any) {
  let plugName = '';

  if (typeof data === 'string') {
    plugName = data;
  } else if (data && typeof data === 'object' && data.plugName !== undefined) {
    plugName = data.plugName;
  }

  if (plugName) {
    console.log(`更新客戶端 ${clientId} 插座名稱: ${plugName}`);
    // 這裡可以存儲到客戶端特定的數據中，如果需要
    // 目前僅記錄，未來可擴展儲存
  }
}

// 處理個別客戶端電壓
function handleClientVoltage(clientId: string, data: any) {
  let voltageValue = 0;

  if (typeof data === 'number') {
    voltageValue = data;
  } else if (typeof data === 'string' && !isNaN(parseFloat(data))) {
    voltageValue = parseFloat(data);
  } else if (data && typeof data === 'object' && data.voltage !== undefined) {
    voltageValue = data.voltage;
  }

  if (voltageValue > 0) {
    console.log(`更新客戶端 ${clientId} 電壓: ${voltageValue}V`);
    // 這裡可以存儲到客戶端特定的數據中，如果需要
    // 目前僅記錄，未來可擴展儲存
  }
}

// 發布 MQTT 訊息
export function publishMqtt(topic: string, message: string, options?: any, clientId?: string): boolean {
  const client = clientId ? mqttShared.getClient(clientId) : null;
  if (!client || !client.connected) return false;
  client.publish(topic, message, { qos: options?.qos ?? 1, retain: options?.retain ?? false });
  return true;
}

// 控制繼電器
export function controlRelay(relayId: number, state: boolean, plugId: string = currentPlugId, clientId?: string): boolean {
  if (!clientId) return false;
  const message = JSON.stringify({
    id: relayId,
    state: state ? "1" : "0"
  });
  const topic = `smartplug/${plugId}/${clientId}/control`;
  return publishMqtt(topic, message, { qos: 1 }, clientId);
}

// 更新繼電器名稱
export function updateRelayName(relayId: number, name: string, plugId: string = currentPlugId, clientId?: string): boolean {
  if (!clientId) return false;
  const message = JSON.stringify({
    id: relayId,
    name: name
  });
  const topic = `smartplug/${plugId}/${clientId}/name`;
  return publishMqtt(topic, message, { qos: 1 }, clientId);
}

// 獲取當前感測器數據
export function getSensorData(): SensorData {
  return getOrCreateClientData(currentClientId);
}

// WebSocket 客戶端管理
export function addWsClient(client: CustomWebSocket, clientId: string) {
  if (!wsClientMap.has(clientId)) {
    wsClientMap.set(clientId, new Set());
  }
  wsClientMap.get(clientId)!.add(client);
}

export function removeWsClient(client: CustomWebSocket, clientId: string) {
  if (wsClientMap.has(clientId)) {
    const clientSet = wsClientMap.get(clientId)!;
    clientSet.delete(client);
  }
}

// 廣播給特定客戶端
function broadcastToClient(clientId: string, data: any) {
  if (!wsClientMap.has(clientId)) return;
  const message = JSON.stringify(data);
  wsClientMap.get(clientId)!.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// 處理 WebSocket 訊息
export function handleWsMessage(message: string, client: CustomWebSocket, clientId: string) {
  try {
    const data = JSON.parse(message);
    const mqttClient = mqttShared.getClient();

    switch (data.command) {
      case 'get_sensors':
        const sensorData = getOrCreateClientData(clientId);
        client.send(JSON.stringify({
          type: 'sensor_data',
          temperature: sensorData.temperature,
          relays: sensorData.relays
        }));
        break;

      case 'relay_control':
        controlRelay(data.relay_id, data.state);
        break;

      case 'ping':
        client.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
    }
  } catch (e) { }
}

/** @deprecated MQTT 訊息由 server.js 處理，請勿再註冊監聽 */
export function onMqttMessage(_callback: (topic: string, message: string) => void) {
  // 刻意不註冊，避免與 server.js 重複監聽造成記憶體累積
}

// WebSocket 類型預定義 (由於檔案內已有引用，需在此補全或移到頂部)
interface CustomWebSocket {
  readyState: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}
