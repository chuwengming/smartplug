import { NextRequest, NextResponse } from 'next/server';
import { disconnectMqtt } from '@/lib/mqtt';

export async function POST(request: NextRequest) {
  try {
    const { clientId, plugId } = await request.json();
    console.log(`收到登出請求: ${clientId}`);

    disconnectMqtt(clientId, plugId);

    return NextResponse.json({
      success: true,
      message: '已成功登出'
    });
  } catch (error: any) {
    console.error('登出錯誤:', error);
    return NextResponse.json(
      { success: false, message: error.message || '登出失敗' },
      { status: 500 }
    );
  }
}