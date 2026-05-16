import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getMqttClient, getClientId } from '@/lib/mqtt';
import { updateRelayName, getMqttClient as getOperationMqttClient } from '@/lib/mqtt-operation';

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
        const { clientId } = body;
        console.log(`🔄 [${clientId}] 開始執行回復原廠設定...`);

        // 1. 讀取原廠設定檔案
        const factoryData = await fs.readFile(FACTORY_SETTINGS_PATH, 'utf-8');
        const factorySettings = JSON.parse(factoryData);

        // 2. 讀取當前設定檔案以保留 plugId
        let currentSettings: any = {};
        try {
            const currentData = await fs.readFile(SETTINGS_PATH, 'utf-8');
            currentSettings = JSON.parse(currentData);
        } catch (error) {
            console.warn('無法讀取當前設定檔案，將使用原廠設定:', error);
        }

        // 3. 合併設定：使用原廠設定，但保留現有的 plugId
        const mergedSettings = {
            ...factorySettings,
            plugId: currentSettings.plugId || 'sp123456' // 保留現有 plugId，如無則使用預設
        };

        console.log('📋 合併後的設定:', JSON.stringify(mergedSettings, null, 2));

        // 4. 寫入 setting.json
        await fs.writeFile(SETTINGS_PATH, JSON.stringify(mergedSettings, null, 4), 'utf-8');

        // 5. 同時寫入 public/data/setting.json (供前端讀取)
        await fs.writeFile(PUBLIC_SETTINGS_PATH, JSON.stringify(mergedSettings, null, 4), 'utf-8');

        console.log('💾 設定檔案已更新');

        // 6. 檢查 MQTT 連線狀態
        const mqttClient = getMqttClient(clientId);
        const operationMqttClient = getOperationMqttClient(clientId);

        if (!mqttClient || !mqttClient.connected) {
            console.warn('⚠️ MQTT 未連線，無法發送廣播訊息');
            return NextResponse.json({
                success: true,
                message: '原廠設定已回復，但 MQTT 未連線，無法發送廣播訊息',
                settings: mergedSettings
            });
        }

        // 7. 獲取 Plug ID
        const plugId = mergedSettings.plugId || 'defaultPlug';

        console.log(`📤 準備發送 MQTT 廣播: PlugID=${plugId}, ClientID=${clientId}`);

        // 8. 發送 plugName 廣播
        const plugName = mergedSettings.plugName || 'SmartPlug';
        const plugNameTopic = `smartplug/${plugId}/plugName`;
        const plugNamePayload = JSON.stringify({ plugName });

        mqttClient.publish(plugNameTopic, plugNamePayload, { qos: 1 });
        console.log(`📤 已發送設備名稱廣播: ${plugNameTopic} -> ${plugNamePayload}`);

        // 9. 發送繼電器名稱廣播 (Relay 1 ~ Relay 6)
        const relayNames = mergedSettings.relayNames || {
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

        console.log('✅ 所有廣播與關閉指令已發送完成');

        return NextResponse.json({
            success: true,
            message: '原廠設定已成功回復並廣播',
            settings: mergedSettings,
            broadcast: {
                plugName: plugName,
                relayNames: relayNames
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
