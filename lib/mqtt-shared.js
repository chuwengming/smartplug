const mqtt = require('mqtt');
const EventEmitter = require('events');

class MqttManager extends EventEmitter {
    constructor() {
        super();
        this.clients = new Map(); // clientId -> { client, config, status, plugId }
        /** 已訂閱 smartplug/{plugId}/# 的 sessionClientId，避免與 lib/mqtt 單一主題重疊訂閱 */
        this.plugWildcardSubscribed = new Set();
        this._recentMessageKeys = new Map();
    }

    _shouldEmitMessage(clientId, topic, message) {
        const key = `${clientId}\x00${topic}\x00${message.toString()}`;
        const now = Date.now();
        const last = this._recentMessageKeys.get(key);
        if (last != null && now - last < 400) {
            return false;
        }
        this._recentMessageKeys.set(key, now);
        if (this._recentMessageKeys.size > 8000) {
            const cutoff = now - 2000;
            for (const [k, t] of this._recentMessageKeys) {
                if (t < cutoff) this._recentMessageKeys.delete(k);
            }
        }
        return true;
    }

    /**
     * 每位使用者僅訂閱一次 smartplug/{plugId}/#（含 live、voltage、plugName 等）
     */
    ensurePlugWildcardSubscription(clientId, plugId, callback) {
        if (!clientId || !plugId) {
            callback?.(new Error('missing clientId or plugId'));
            return;
        }
        if (this.plugWildcardSubscribed.has(clientId)) {
            callback?.(null);
            return;
        }
        const data = this.clients.get(clientId);
        if (!data?.client?.connected) {
            callback?.(new Error('mqtt not connected'));
            return;
        }
        const topic = `smartplug/${plugId}/#`;
        data.client.subscribe(topic, (err) => {
            if (!err) {
                this.plugWildcardSubscribed.add(clientId);
            }
            callback?.(err || null);
        });
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
            this._destroyClient(existing.client);
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
            if (!this._shouldEmitMessage(clientId, topic, message)) {
                return;
            }
            this.emit('message', topic, message, clientId);
            this.emit('global_message', topic, message, clientId);
        });

        return client;
    }

    _destroyClient(client) {
        if (!client) return;
        try {
            client.removeAllListeners();
            client.options.reconnectPeriod = 0;
            if (client.connected) {
                client.end(true);
            } else {
                client.end(true);
            }
        } catch (e) {
            console.warn('⚠️ [SharedMqtt] 銷毀連線時發生例外:', e.message);
        }
    }

    disconnect(clientId) {
        if (!this.clients.has(clientId)) return;
        const data = this.clients.get(clientId);
        this._destroyClient(data.client);
        data.status = 'disconnected';
        this.emit('statusChange', clientId, 'disconnected');
        this.clients.delete(clientId);
        this.plugWildcardSubscribed.delete(clientId);
        console.log(`👋 [SharedMqtt] [${clientId}] 已中斷連線並移除實例`);
    }

    getPlugId(clientId) {
        const data = this.clients.get(clientId);
        return data ? data.plugId : '';
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
