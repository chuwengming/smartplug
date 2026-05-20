import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getMqttClient, getClientId, MqttTopics } from '@/lib/mqtt';
import { updateRelayName, getMqttClient as getOperationMqttClient } from '@/lib/mqtt-operation';
import { updateLoginPasswordByPlugId } from '@/lib/registry-db';
import { DEFAULT_DEVICE_LOGIN_PASSWORD } from '@/lib/mqtt-defaults';

const FACTORY_SETTINGS_PATH = path.join(process.cwd(), 'data', 'setting.factory.json');
const SETTINGS_PATH = path.join(process.cwd(), 'data', 'setting.json');
const PUBLIC_SETTINGS_PATH = path.join(process.cwd(), 'public', 'data', 'setting.json');

export async function GET() {
    try {
        const data = await fs.readFile(FACTORY_SETTINGS_PATH, 'utf-8');
        const factorySettings = JSON.parse(data);
        return NextResponse.json(factorySettings);
    } catch (error) {
        console.error('讀取原廠設定檔案失敗:', error);
        return NextResponse.json(
            { error: '無法讀取原廠設定檔案' },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { clientId, plugId } = body;

        if (!clientId || !plugId) {
            return NextResponse.json(
                { success: false, error: '缺少 clientId 或 plugId（請由當前連線 session 提供）' },
                { status: 400 }
            );
        }

        console.log(`🔄 [${clientId}] 回復原廠設定 (Plug: ${plugId})...`);

        const factoryData = await fs.readFile(FACTORY_SETTINGS_PATH, 'utf-8');
        const factorySettings = JSON.parse(factoryData);

        await fs.writeFile(SETTINGS_PATH, JSON.stringify(factorySettings, null, 4), 'utf-8');
        await fs.writeFile(PUBLIC_SETTINGS_PATH, JSON.stringify(factorySettings, null, 4), 'utf-8');

        console.log('💾 本機 UI 範本設定已回復（plugId／登入密碼由 session／中央資料庫管理）');

        // ── 同步重設登入密碼至中央資料庫（依 plugId） ──
        let dbPasswordUpdated = false;
        try {
            dbPasswordUpdated = await updateLoginPasswordByPlugId(
                plugId,
                DEFAULT_DEVICE_LOGIN_PASSWORD
            );
            if (dbPasswordUpdated) {
                console.log(`🔑 [Registry] 已將 plugId=${plugId} 的登入密碼重設為預設值`);
            } else {
                console.warn(`⚠️ [Registry] 未找到 plugId=${plugId}，登入密碼未更新`);
            }
        } catch (err: any) {
            console.error('❌ 中央資料庫密碼更新失敗:', err.message);
        }

        // 6. 檢查 MQTT 連線狀態
        const mqttClient = getMqttClient(clientId);
        const operationMqttClient = getOperationMqttClient(clientId);

        if (!mqttClient || !mqttClient.connected) {
            console.warn('⚠️ MQTT 未連線，無法發送廣播訊息');
            return NextResponse.json({
                success: true,
                message: '原廠設定已回復，但 MQTT 未連線，無法發送廣播訊息',
                settings: factorySettings
            });
        }

        // 7. 獲取 Plug ID
        console.log(`📤 準備發送 MQTT 廣播: PlugID=${plugId}, ClientID=${clientId}`);

        const plugName = factorySettings.plugName || 'SmartPlug';
        const plugNameTopic = `smartplug/${plugId}/plugName`;
        const plugNamePayload = JSON.stringify({ plugName });

        mqttClient.publish(plugNameTopic, plugNamePayload, { qos: 1 });
        console.log(`📤 已發送設備名稱廣播: ${plugNameTopic} -> ${plugNamePayload}`);

        // 9. 發送繼電器名稱廣播 (Relay 1 ~ Relay 6)
        const relayNames = factorySettings.relayNames || {
            relay1: "Relay 1",
            relay2: "Relay 2",
            relay3: "Relay 3",
            relay4: "Relay 4",
            relay5: "Relay 5",
            relay6: "Relay 6"
        };

        console.log('📤 開始發送繼電器名稱廣播...');

        // 使用 mqtt-operation 的 updateRelayName 函數發送每個繼電器名稱
        // 這個函數會發送到正確的 MQTT 主題
        for (let i = 0; i < 6; i++) {
            const relayKey = `relay${i + 1}`;
            const relayName = relayNames[relayKey] || `Relay ${i + 1}`;

            // 使用 mqtt-operation 的 updateRelayName 函數
            // 這個函數會發送到 smartplug/{plugId}/{clientId}/name 主題
            // ESP32C3 會處理並廣播到 smartplug/{plugId}/relay/name
            if (operationMqttClient && operationMqttClient.connected) {
                const success = updateRelayName(i, relayName, plugId, clientId);
                if (success) {
                    console.log(`✅ 已發送繼電器 ${i} 名稱: ${relayName}`);
                } else {
                    console.error(`❌ 發送繼電器 ${i} 名稱失敗`);
                }
            } else {
                // 如果 operation MQTT 未連線，直接使用基礎 MQTT 客戶端發送到廣播主題
                const relayNameTopic = `smartplug/${plugId}/relay/name`;
                const relayNamePayload = JSON.stringify({ id: i, name: relayName });
                mqttClient.publish(relayNameTopic, relayNamePayload, { qos: 1 });
                console.log(`📤 直接發送繼電器名稱廣播: ${relayNameTopic} -> ${relayNamePayload}`);
            }
        }

        // 10. 安全機制：將所有繼電器全數關閉
        console.log('🔌 正在執行安全重置：關閉所有繼電器...');
        for (let i = 0; i < 6; i++) {
            const controlTopic = `smartplug/${plugId}/${clientId}/control`;
            const controlPayload = JSON.stringify({
                id: i,
                state: "0"
            });
            mqttClient.publish(controlTopic, controlPayload, { qos: 1 });
            console.log(`✅ 已發送繼電器 ${i} 關閉指令: ${controlTopic}`);
        }

        // 11. 透過 MQTT 通知 ESP32 同步 NVS 登入密碼為預設值
        const passwordResetTopic = MqttTopics.request(plugId, clientId);
        const passwordResetPayload = JSON.stringify({
            type: 'setLoginPassword',
            password: DEFAULT_DEVICE_LOGIN_PASSWORD,
        });
        mqttClient.publish(passwordResetTopic, passwordResetPayload, { qos: 1 });
        console.log(`🔑 已透過 MQTT 通知 ESP32 重設 NVS 登入密碼為預設值`);

        console.log('✅ 所有廣播與關閉指令已發送完成');

        return NextResponse.json({
            success: true,
            message: '原廠設定已成功回復並廣播',
            settings: factorySettings,
            broadcast: {
                plugName: plugName,
                relayNames: relayNames,
                loginPasswordReset: dbPasswordUpdated,
            }
        });

    } catch (error: any) {
        console.error('❌ 回復原廠設定失敗:', error);
        return NextResponse.json(
            {
                success: false,
                error: '回復原廠設定失敗',
                details: error.message || '未知錯誤'
            },
            { status: 500 }
        );
    }
}
