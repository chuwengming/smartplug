import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const MQTT_KEY = Symbol.for('smartplug.mqtt.manager');
const WS_KEY   = Symbol.for('smartplug.wsClients');

/**
 * GET /api/client-status?clientId=XXX
 *
 * 檢查指定 clientId 是否已被其他瀏覽器佔用。
 *
 * 判斷邏輯：
 *   hasMqtt && hasWs → inUse: true  → 有人正在使用，拒絕連線
 *   hasMqtt && !hasWs → inUse: false → WebSocket 已關（重整/清理中），允許重連
 *   !hasMqtt           → inUse: false → 無任何連線，允許
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('clientId');

  if (!clientId) {
    return NextResponse.json({ inUse: false, hasMqtt: false, hasWs: false });
  }

  const mqttManager = (global as any)[MQTT_KEY];
  const wsClients   = (global as any)[WS_KEY] as Map<string, unknown> | undefined;

  const hasMqtt = mqttManager
    ? mqttManager.getStatus(clientId) === 'connected'
    : false;

  const hasWs = wsClients ? wsClients.has(clientId) : false;

  return NextResponse.json({
    inUse: hasMqtt && hasWs,
    hasMqtt,
    hasWs
  });
}
