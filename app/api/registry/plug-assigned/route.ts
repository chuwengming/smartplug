import { NextRequest } from 'next/server';
import { markPlugIdAssignedByFactorySerial } from '@/lib/registry-db';
import { registryJsonResponse, registryOptionsResponse } from '@/lib/registry-cors';

/**
 * POST /api/registry/plug-assigned
 * Body: { factorySerial }
 * ESP32 已成功將中央配發的 PlugID 寫入 NVS 後由註冊頁呼叫
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const factorySerial = body?.factorySerial as string | undefined;

        if (!factorySerial) {
            return registryJsonResponse(
                request,
                { success: false, error: 'MISSING_SERIAL' },
                400
            );
        }

        const updated = await markPlugIdAssignedByFactorySerial(factorySerial);

        if (!updated) {
            return registryJsonResponse(
                request,
                { success: false, error: 'UNKNOWN_SERIAL' },
                404
            );
        }

        console.log(`✅ [Registry] registered=Yes, created_at 已紀錄 (${factorySerial})`);

        return registryJsonResponse(request, { success: true }, 200);
    } catch (error: any) {
        console.error('❌ [Registry] plug-assigned 失敗:', error);
        return registryJsonResponse(
            request,
            {
                success: false,
                error: 'DATABASE_ERROR',
                details: error.message,
            },
            500
        );
    }
}

export async function OPTIONS(request: NextRequest) {
    return registryOptionsResponse(request);
}
