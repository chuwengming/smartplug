import { NextRequest } from 'next/server';
import {
    updateLoginPasswordByFactorySerial,
    updateLoginPasswordByPlugId,
} from '@/lib/registry-db';
import { registryJsonResponse, registryOptionsResponse } from '@/lib/registry-cors';

/**
 * POST /api/registry/device-password
 * Body: { loginPassword, factorySerial? | plugId? }（至少其一）
 * 由 ESP32 註冊頁（瀏覽器橋接）更新中央資料庫的設備登入密碼
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { factorySerial, plugId, loginPassword } = body;

        if ((!factorySerial && !plugId) || !loginPassword) {
            return registryJsonResponse(
                request,
                { success: false, error: 'MISSING_FIELDS' },
                400
            );
        }

        if (typeof loginPassword !== 'string' || loginPassword.length < 4) {
            return registryJsonResponse(
                request,
                { success: false, error: 'INVALID_PASSWORD' },
                400
            );
        }

        const result = factorySerial
            ? ((await updateLoginPasswordByFactorySerial(factorySerial, loginPassword))
                ? 'updated'
                : 'not_found')
            : await updateLoginPasswordByPlugId(plugId, loginPassword);

        if (result === 'no_database') {
            return registryJsonResponse(
                request,
                { success: false, error: 'DATABASE_ERROR' },
                503
            );
        }

        if (result === 'not_found') {
            return registryJsonResponse(
                request,
                {
                    success: false,
                    error: factorySerial ? 'UNKNOWN_SERIAL' : 'UNKNOWN_PLUG_ID',
                },
                404
            );
        }

        console.log(
            `✅ [Registry] 已更新設備密碼: ${
                factorySerial ? `factorySerial=${factorySerial}` : `plugId=${plugId}`
            }`
        );

        return registryJsonResponse(request, { success: true }, 200);
    } catch (error: any) {
        console.error('❌ [Registry] 更新密碼失敗:', error);
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
