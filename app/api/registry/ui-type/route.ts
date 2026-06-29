import { NextRequest, NextResponse } from 'next/server';
import { getUiTypeByPlugId } from '@/lib/registry-db';

/**
 * GET /api/registry/ui-type?plugId=...
 * Next 登入頁 MQTT 連線後查詢操作頁類型（A/B）
 */
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const plugId = searchParams.get('plugId');

    if (!plugId?.trim()) {
        return NextResponse.json({ success: false, error: 'MISSING_PLUG_ID' }, { status: 400 });
    }

    try {
        const uiType = await getUiTypeByPlugId(plugId);
        return NextResponse.json({ success: true, uiType, plugId: plugId.trim() }, { status: 200 });
    } catch (error: any) {
        console.error('❌ [Registry] ui-type 查詢失敗:', error);
        return NextResponse.json(
            {
                success: false,
                error: 'DATABASE_ERROR',
                details: error.message,
            },
            { status: 500 }
        );
    }
}
