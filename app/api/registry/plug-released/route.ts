import { NextRequest } from 'next/server';
import { releasePlugByFactorySerial } from '@/lib/registry-db';
import { registryJsonResponse, registryOptionsResponse } from '@/lib/registry-cors';

/**
 * POST /api/registry/plug-released
 * Body: { factorySerial }
 * ESP32 原廠重置時釋放出廠編號（registered = No）
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const factorySerial = body?.factorySerial as string | undefined;

        if (!factorySerial?.trim()) {
            return registryJsonResponse(
                request,
                { success: false, error: 'MISSING_SERIAL' },
                400
            );
        }

        const released = await releasePlugByFactorySerial(factorySerial.trim());

        if (!released) {
            return registryJsonResponse(
                request,
                { success: false, error: 'UNKNOWN_SERIAL' },
                404
            );
        }

        console.log(`✅ [Registry] registered=No（已釋放 ${factorySerial.trim()}）`);

        return registryJsonResponse(request, { success: true }, 200);
    } catch (error: any) {
        console.error('❌ [Registry] plug-released 失敗:', error);
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
