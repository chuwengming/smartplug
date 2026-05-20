/**
 * 單一使用者連線的完整清理（MQTT、快取、ingest 角色）
 * 供 server.js（WS 30 秒清理）與 API 登出共用
 */
const mqttShared = require('./mqtt-shared');

const CACHE_KEY = Symbol.for('smartplug.mqtt.clientCache');
const SERVER_PURGE_HOOK = Symbol.for('smartplug.onSessionPurged');

/**
 * @param {string} clientId
 * @param {{ publishOffline?: boolean, plugId?: string, reason?: string }} [options]
 */
function purgeClientSession(clientId, options = {}) {
    if (!clientId) return;

    const cache = global[CACHE_KEY];
    if (cache && typeof cache.delete === 'function') {
        cache.delete(clientId);
    }

    const plugId = options.plugId || mqttShared.getPlugId(clientId);
    const client = mqttShared.getClient(clientId);

    const finish = () => {
        mqttShared.disconnect(clientId);
        const hook = global[SERVER_PURGE_HOOK];
        if (typeof hook === 'function') {
            try {
                hook(clientId, plugId);
            } catch (e) {
                console.error(`❌ [Session] server purge hook 失敗 [${clientId}]:`, e);
            }
        }
    };

    if (options.publishOffline && client && client.connected && plugId) {
        const offlineTopic = `smartplug/${plugId}/${clientId}/offline`;
        const offlinePayload = JSON.stringify({
            clientId,
            plugId,
            reason: options.reason || 'session_ended',
            timestamp: Date.now(),
        });
        client.publish(offlineTopic, offlinePayload, { qos: 1 }, () => {
            finish();
        });
        return;
    }

    finish();
}

module.exports = { purgeClientSession };
