/**
 * 全專案共用的 MQTT Broker 參數。
 * 連線身分：ESP Broker ClientID = plugId；Next = plugId_sessionClientId（見 mqtt-shared.js）
 * - ESP32 Broker ClientID = plugId
 * - Next.js Broker ClientID = plugId_sessionClientId（sessionClientId = 登入頁 Client ID）
 */
export const MQTT_DEFAULTS = {    broker: 's4eb1262.ala.cn-hangzhou.emqxsl.cn',
    port: '8883',
    username: 'chuwm',
    password: 'chuwengming',
} as const;

export const DEFAULT_DEVICE_LOGIN_PASSWORD = '123456';
