const mqtt = require('mqtt');
const EventEmitter = require('events');

class MqttManager extends EventEmitter {
    constructor() {
        super();
        this.clients = new Map(); // clientId -> { client, config, status }
    }

    connect(config, source = 'unknown', plugId = 'defaultPlug') {
        const clientId = config.clientId;

        // 如果該 clientId 已經連線且配置與 PlugID 均相同，則重用
        if (this.clients.has(clientId)) {
            const existing = this.clients.get(clientId);
            if (existing.client && existing.client.connected &&
                existing.config.broker === config.broker &&
                existing.config.port === config.port &&
                existing.plugId === plugId) {

                console.log(`✅ [SharedMqtt] [${clientId}] 已經連線，跳過重複連線 (來源: ${source})`);

                setTimeout(() => {
                    this.emit('connect', clientId);
                    this.emit('statusChange', clientId, 'connected');
                }, 100);

                return existing.client;
            }

            console.log(`🔄 [SharedMqtt] [${clientId}] 偵測到新配置，斷開舊連線 (來源: ${source})`);
            existing.client.end(true);
            this.clients.delete(clientId);
        }

        const clientIdWithSuffix = `${plugId}_${clientId}`;

        console.log(`🔌 [SharedMqtt] [${clientId}] Connecting to ${config.broker} as ${clientIdWithSuffix} (來源: ${source}, Plug: ${plugId})`);

        // 根據 port 選擇正確的協定與 URL：
        //   1883        → mqtt://   (TCP 明文)
        //   8883        → mqtts://  (TCP + TLS，伺服器端推薦)
        //   8083        → ws://     (WebSocket 明文)
        //   8084        → wss://    (WebSocket + TLS)
        const portNum = parseInt(config.port);
        let protocol, connectUrl;
        if (portNum === 8083) {
            protocol = 'ws';
            connectUrl = `${protocol}://${config.broker}:${config.port}/mqtt`;
        } else if (portNum === 8084) {
            protocol = 'wss';
            connectUrl = `${protocol}://${config.broker}:${config.port}/mqtt`;
        } else if (portNum === 8883) {
            protocol = 'mqtts';
            connectUrl = `${protocol}://${config.broker}:${config.port}`;
        } else {
            protocol = 'mqtt';
            connectUrl = `${protocol}://${config.broker}:${config.port}`;
        }

        const client = mqtt.connect(connectUrl, {
            clientId: clientIdWithSuffix,
            username: config.username || undefined,
            password: config.password || undefined,
            clean: true,
            reconnectPeriod: 5000,
            connectTimeout: 10000,
            will: {
                topic: `smartplug/${plugId}/${clientId}/offline`,
                payload: JSON.stringify({ clientId: clientId, reason: 'unexpected_close' }),
                qos: 1,
                retain: false
            }
        });

        const clientData = {
            client: client,
            config: config,
            plugId: plugId,
            status: 'connecting'
        };
        this.clients.set(clientId, clientData);

        this.emit('statusChange', clientId, 'connecting');

        client.on('connect', () => {
            console.log(`✅ [SharedMqtt] [${clientId}] Connected`);
            clientData.status = 'connected';
            this.emit('statusChange', clientId, 'connected');
            this.emit('connect', clientId);
        });

        client.on('error', (err) => {
            console.error(`❌ [SharedMqtt] [${clientId}] Error:`, err.message);
            this.emit('error', clientId, err);
        });

        client.on('close', () => {
            if (clientData.status !== 'disconnected') {
                console.warn(`⚠️ [SharedMqtt] [${clientId}] Connection closed`);
                clientData.status = 'disconnected';
                this.emit('statusChange', clientId, 'disconnected');
            }
        });

        client.on('message', (topic, message) => {
            // 發出帶有 clientId 的事件，同時發出全域訊息供同步使用
            this.emit('message', topic, message, clientId);
            this.emit('global_message', topic, message, clientId);
        });

        return client;
    }

    disconnect(clientId) {
        if (this.clients.has(clientId)) {
            const data = this.clients.get(clientId);
            data.client.end();
            data.status = 'disconnected';
            this.emit('statusChange', clientId, 'disconnected');
            this.clients.delete(clientId);
            console.log(`👋 [SharedMqtt] [${clientId}] 已中斷連線並移除實例`);
        }
    }

    getStatus(clientId) {
        const data = this.clients.get(clientId);
        return data ? data.status : 'disconnected';
    }

    getClient(clientId) {
        const data = this.clients.get(clientId);
        return data ? data.client : null;
    }

    getAllClients() {
        return Array.from(this.clients.entries()).map(([id, data]) => ({
            clientId: id,
            status: data.status
        }));
    }
}

// Singleton 實例 (使用 global 確保跨模組與重啟時的唯一性)
const GLOBAL_KEY = Symbol.for('smartplug.mqtt.manager');

if (!global[GLOBAL_KEY]) {
    console.log('🚀 [SharedMqtt] 初始化全域 MQTT 管理器實例');
    global[GLOBAL_KEY] = new MqttManager();
}

const instance = global[GLOBAL_KEY];
module.exports = instance;
