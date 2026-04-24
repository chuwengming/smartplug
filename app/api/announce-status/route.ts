import { NextResponse } from 'next/server';
import { getMqttStatus, getEspRegistered } from '@/lib/mqtt';

export const dynamic = 'force-dynamic';

/**
 * GET /api/announce-status?clientId=XXX
 *
 * 回傳 ESP32 對此 clientId 的 announce 授權回應狀態：
 *   responded: false → ESP32 尚未回應（或 MQTT 未連線）
 *   responded: true, registered: true  → ESP32 確認已授權
 *   responded: true, registered: false → ESP32 回應此 clientId 尚未在設備中註冊
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('clientId');

  if (!clientId || !getMqttStatus(clientId)) {
    return NextResponse.json({ responded: false, registered: null });
  }

  const registered = getEspRegistered(clientId);

  return NextResponse.json({
    responded: registered !== null,
    registered
  });
}
