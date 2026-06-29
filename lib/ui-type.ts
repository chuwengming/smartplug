export type UiType = 'A' | 'B';

/** 正規化 DB / API 回傳的 ui_type（未知值預設 A＝完整操作頁） */
export function normalizeUiType(value: unknown): UiType {
    const raw = String(value ?? 'A').trim().toUpperCase();
    return raw === 'B' ? 'B' : 'A';
}

export function getOperationRoute(uiType: UiType): '/operation' | '/operation-basic' {
    return uiType === 'B' ? '/operation-basic' : '/operation';
}

export function uiTypeFromPath(pathname: string): UiType | null {
    if (pathname === '/operation') return 'A';
    if (pathname === '/operation-basic') return 'B';
    return null;
}
