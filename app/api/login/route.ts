import { NextRequest, NextResponse } from 'next/server';
import { getMqttStatus } from '@/lib/mqtt';
import { getLoginPasswordByPlugId, getUiTypeByPlugId } from '@/lib/registry-db';
import { DEFAULT_DEVICE_LOGIN_PASSWORD } from '@/lib/mqtt-defaults';
import { getOperationRoute } from '@/lib/ui-type';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { password, clientId, plugId } = body;

    if (!getMqttStatus(clientId)) {
      return NextResponse.json(
        { message: 'MQTT 未連線，無法登入 (Client: ' + (clientId || 'Unknown') + ')' },
        { status: 503 }
      );
    }

    if (!password) {
      return NextResponse.json({ message: '請輸入密碼' }, { status: 400 });
    }

    if (!plugId) {
      return NextResponse.json({ message: '缺少 PlugID，請重新連線 MQTT' }, { status: 400 });
    }

    console.log(`收到登入請求 (Client: ${clientId}, Plug: ${plugId})`);

    const storedPassword =
      (await getLoginPasswordByPlugId(plugId)) ?? DEFAULT_DEVICE_LOGIN_PASSWORD;

    if (password === storedPassword) {
      const uiType = await getUiTypeByPlugId(plugId);
      console.log(`✅ 密碼驗證成功（中央註冊資料庫），uiType=${uiType}`);
      return NextResponse.json({
        success: true,
        message: '登入成功',
        uiType,
        operationRoute: getOperationRoute(uiType),
      });
    }

    console.log('❌ 密碼驗證失敗');
    return NextResponse.json(
      { message: '密碼錯誤，請重新輸入。' },
      { status: 401 }
    );
  } catch (error: any) {
    console.error('登入錯誤:', error);
    return NextResponse.json(
      { message: '登入失敗，請稍後再試。' },
      { status: 500 }
    );
  }
}
