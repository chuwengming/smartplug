import { NextRequest } from 'next/server';
import { getRegistryByFactorySerial } from '@/lib/registry-db';
import { registryJsonResponse, registryOptionsResponse } from '@/lib/registry-cors';

/**
 * GET /api/registry/plug-id?factorySerial=...
 */
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const factorySerial = searchParams.get('factorySerial');

    if (!factorySerial) {
        return registryJsonResponse(request, { success: false, error: 'MISSING_SERIAL' }, 400);
    }

    try {
        const row = await getRegistryByFactorySerial(factorySerial);

        if (!row) {
            console.warn(`⚠️ [Registry] 未知或無效的出廠編號: ${factorySerial}`);
            return registryJsonResponse(request, { success: false, error: 'UNKNOWN_SERIAL' }, 404);
        }

        console.log(`✅ [Registry] ${factorySerial} → plugId=${row.plug_id}`);

        return registryJsonResponse(request, {
            success: true,
            plugId: row.plug_id,
            loginPassword: row.login_password,
        }, 200);
    } catch (error: any) {
        console.error('❌ [Registry] 資料庫查詢失敗:', error);
        return registryJsonResponse(request, {
            success: false,
            error: 'DATABASE_ERROR',
            details: error.message,
        }, 500);
    }
}

export async function OPTIONS(request: NextRequest) {
    return registryOptionsResponse(request);
}
