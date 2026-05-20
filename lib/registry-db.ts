import pool from '@/lib/db';

export type RegistryRow = {
    factory_serial: string;
    plug_id: string;
    login_password: string;
};

const DEFAULT_LOGIN_PASSWORD = '123456';

export async function getRegistryByFactorySerial(
    factorySerial: string
): Promise<RegistryRow | null> {
    if (!pool) return null;

    const [rows]: any = await pool.execute(
        'SELECT factory_serial, plug_id, login_password FROM plug_registry WHERE factory_serial = ?',
        [factorySerial]
    );

    if (!rows.length) return null;

    return {
        factory_serial: rows[0].factory_serial,
        plug_id: rows[0].plug_id,
        login_password: rows[0].login_password || DEFAULT_LOGIN_PASSWORD,
    };
}

export async function getLoginPasswordByPlugId(plugId: string): Promise<string | null> {
    if (!pool) return null;

    const [rows]: any = await pool.execute(
        'SELECT login_password FROM plug_registry WHERE plug_id = ?',
        [plugId]
    );

    if (!rows.length) return null;
    return rows[0].login_password || DEFAULT_LOGIN_PASSWORD;
}

export async function updateLoginPasswordByFactorySerial(
    factorySerial: string,
    loginPassword: string
): Promise<boolean> {
    if (!pool) return false;

    const [result]: any = await pool.execute(
        'UPDATE plug_registry SET login_password = ?, updated_at = CURRENT_TIMESTAMP WHERE factory_serial = ?',
        [loginPassword, factorySerial]
    );

    return result.affectedRows > 0;
}

/**
 * ESP32 成功寫入 PlugID 至 NVS 後：
 * - registered = Yes
 * - created_at 僅在尚未紀錄時寫入當下時間（保留首次配號時間）
 */
export async function markPlugIdAssignedByFactorySerial(
    factorySerial: string
): Promise<boolean> {
    if (!pool) return false;

    const [result]: any = await pool.execute(
        `UPDATE plug_registry
         SET registered = 'Yes',
             created_at = COALESCE(created_at, CURRENT_TIMESTAMP)
         WHERE factory_serial = ?`,
        [factorySerial]
    );

    return result.affectedRows > 0;
}

export async function updateLoginPasswordByPlugId(
    plugId: string,
    loginPassword: string
): Promise<boolean> {
    if (!pool) return false;

    const [result]: any = await pool.execute(
        'UPDATE plug_registry SET login_password = ?, updated_at = CURRENT_TIMESTAMP WHERE plug_id = ?',
        [loginPassword, plugId]
    );

    return result.affectedRows > 0;
}
