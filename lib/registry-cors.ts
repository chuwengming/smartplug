import { NextRequest, NextResponse } from 'next/server';

export function applyRegistryCors(request: NextRequest, response: NextResponse) {
    const allowedOrigins = process.env.REGISTRY_ALLOWED_ORIGINS || '*';

    if (allowedOrigins.trim() === '*') {
        response.headers.set('Access-Control-Allow-Origin', '*');
    } else {
        const origin = request.headers.get('origin');
        const list = allowedOrigins.split(',').map((o) => o.trim()).filter(Boolean);
        if (origin && list.includes(origin)) {
            response.headers.set('Access-Control-Allow-Origin', origin);
        }
    }

    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    return response;
}

export function registryJsonResponse(
    request: NextRequest,
    data: object,
    status: number
) {
    const response = NextResponse.json(data, { status });
    return applyRegistryCors(request, response);
}

export function registryOptionsResponse(request: NextRequest) {
    return applyRegistryCors(request, new NextResponse(null, { status: 204 }));
}
