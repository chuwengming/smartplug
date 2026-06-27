/**
 * 溫度記錄服務
 * 每半小時記錄一筆溫度數據到對應的星期檔案中
 */

import fs from 'fs/promises';
import path from 'path';
import { getNTPTime, formatTemperatureTimestamp, getDayOfWeekFileName, isSameDay } from './ntp-client';

// 檔案儲存目錄
const DATA_DIR = path.join(process.cwd(), 'data');

// 星期檔案列表
const WEEKDAY_FILES = [
  'Sunday.txt',
  'Monday.txt', 
  'Tuesday.txt',
  'Wednesday.txt',
  'Thursday.txt',
  'Friday.txt',
  'Saturday.txt'
];

// 最後記錄的時間和溫度
let lastRecordTime: Date | null = null;
let lastTemperature: number | null = null;

// 記錄器狀態
let loggerActive = false;
let intervalId: NodeJS.Timeout | null = null;
let configuredIntervalMinutes = 30;
let recordingPaused = false;
let pauseReason: string | null = null;

export type MqttRecordingState = {
  valid: boolean;
  reason: string | null;
  connectedCount: number;
  lastMqttTemperatureAt: number | null;
};

export type TemperatureRecordingContext = {
  getRecordingState?: () => MqttRecordingState;
};

let recordingContext: TemperatureRecordingContext = {};

let lastMqttDiagnostics = {
  connectedCount: 0,
  lastMqttTemperatureAt: null as number | null,
};

const PAUSE_REASON_TEXT: Record<string, string> = {
  no_mqtt_connection: '無 MQTT 連線，暫停寫入',
  no_temperature_data: '尚未收到 MQTT 溫度資料，暫停寫入',
  stale_temperature: 'MQTT 溫度資料逾時，暫停寫入',
};

export function setTemperatureRecordingContext(context: TemperatureRecordingContext): void {
  recordingContext = context;
}

function getPauseReasonText(reason: string | null): string | null {
  if (!reason) return null;
  return PAUSE_REASON_TEXT[reason] ?? reason;
}

/**
 * 初始化溫度記錄服務
 */
export async function initTemperatureLogger(): Promise<void> {
  try {
    // 確保 data 目錄存在
    await ensureDataDirectory();
    
    // 初始化星期檔案
    await initWeekdayFiles();
    
    console.log('📝 溫度記錄服務初始化完成');
    
  } catch (error) {
    console.error('❌ 溫度記錄服務初始化失敗:', error);
    throw error;
  }
}

/**
 * 確保 data 目錄存在
 */
async function ensureDataDirectory(): Promise<void> {
  try {
    await fs.access(DATA_DIR);
  } catch {
    // 目錄不存在，創建它
    await fs.mkdir(DATA_DIR, { recursive: true });
    console.log(`📁 已創建數據目錄: ${DATA_DIR}`);
  }
}

/**
 * 初始化星期檔案（如果不存在）
 */
async function initWeekdayFiles(): Promise<void> {
  for (const filename of WEEKDAY_FILES) {
    const filePath = path.join(DATA_DIR, filename);
    
    try {
      await fs.access(filePath);
      // 檔案存在，檢查是否需要添加標題
      const content = await fs.readFile(filePath, 'utf-8');
      if (!content.startsWith('溫度記錄 - ')) {
        const header = createFileHeader(filename);
        await fs.writeFile(filePath, header + content);
      }
    } catch {
      // 檔案不存在，創建帶有標題的檔案
      const header = createFileHeader(filename);
      await fs.writeFile(filePath, header);
      console.log(`📄 已創建溫度記錄檔案: ${filename}`);
    }
  }
}

/**
 * 創建檔案標題
 */
function createFileHeader(filename: string): string {
  const dayName = filename.replace('.txt', '');
  return `溫度記錄 - ${dayName}\n${'='.repeat(50)}\n`;
}

/**
 * 開始溫度記錄
 * @param getTemperatureCallback 獲取當前溫度的回調函數
 * @param intervalMinutes 記錄間隔（分鐘）
 */
export function startTemperatureLogging(
  getTemperatureCallback: () => Promise<number> | number,
  intervalMinutes: number = 30
): void {
  if (loggerActive) {
    console.warn('⚠️  溫度記錄服務已在運行中');
    return;
  }
  
  loggerActive = true;
  configuredIntervalMinutes = intervalMinutes;

  // 立即記錄一次
  recordTemperature(getTemperatureCallback).catch(error => {
    console.error('❌ 初始溫度記錄失敗:', error);
  });
  
  // 設定定期記錄
  intervalId = setInterval(async () => {
    await recordTemperature(getTemperatureCallback);
  }, intervalMinutes * 60 * 1000);
  
  console.log(`📝 溫度記錄服務已啟動（每 ${intervalMinutes} 分鐘記錄一次）`);
}

/**
 * 停止溫度記錄
 */
export function stopTemperatureLogging(): void {
  if (!loggerActive) return;
  
  loggerActive = false;
  
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  
  console.log('📝 溫度記錄服務已停止');
}

/**
 * 記錄溫度數據
 */
async function recordTemperature(getTemperatureCallback: () => Promise<number> | number): Promise<void> {
  try {
    const mqttState = recordingContext.getRecordingState?.();
    if (mqttState) {
      lastMqttDiagnostics = {
        connectedCount: mqttState.connectedCount,
        lastMqttTemperatureAt: mqttState.lastMqttTemperatureAt,
      };
    }

    if (!mqttState?.valid) {
      recordingPaused = true;
      pauseReason = mqttState?.reason ?? 'no_mqtt_connection';
      console.log(`⏸️ 溫度記錄暫停：${getPauseReasonText(pauseReason)}`);
      return;
    }

    // 獲取當前時間（使用 NTP）
    const currentTime = await getNTPTime();
    
    // 檢查是否需要記錄（避免短時間內重複記錄）
    if (lastRecordTime && (currentTime.getTime() - lastRecordTime.getTime()) < 25 * 60 * 1000) {
      console.log('⏳ 距離上次記錄不足25分鐘，跳過本次記錄');
      return;
    }
    
    // 獲取當前溫度
    const temperature = await Promise.resolve(getTemperatureCallback());
    
    // 驗證溫度數據
    if (typeof temperature !== 'number' || isNaN(temperature)) {
      throw new Error(`無效的溫度數據: ${temperature}`);
    }
    
    // 格式化記錄行
    const timestamp = formatTemperatureTimestamp(currentTime);
    const recordLine = `${timestamp}${temperature.toFixed(1)}°C`;
    
    // 獲取對應的星期檔案
    const filename = getDayOfWeekFileName(currentTime);
    const filePath = path.join(DATA_DIR, filename);
    
    // 檢查是否是同一天，如果不是則清空檔案並添加新標題
    await manageFileRotation(filePath, filename, currentTime);
    
    // 寫入記錄
    await fs.appendFile(filePath, recordLine + '\n', 'utf-8');
    
    // 更新最後記錄狀態
    lastRecordTime = currentTime;
    lastTemperature = temperature;
    recordingPaused = false;
    pauseReason = null;
    
    console.log(`📝 溫度記錄成功: ${recordLine} → ${filename}`);
    
  } catch (error) {
    console.error('❌ 溫度記錄失敗:', error);
  }
}

/**
 * 管理檔案循環（新的一天時清空舊內容）
 */
async function manageFileRotation(filePath: string, filename: string, currentTime: Date): Promise<void> {
  try {
    const fileStats = await fs.stat(filePath);
    const fileModifiedTime = new Date(fileStats.mtime);
    
    // 如果不是同一天，清空檔案並重新添加標題
    if (!isSameDay(fileModifiedTime, currentTime)) {
      const dayName = filename.replace('.txt', '');
      const header = createFileHeader(filename);
      await fs.writeFile(filePath, header, 'utf-8');
      console.log(`🔄 新的一天開始，已清空檔案: ${filename}`);
    }
  } catch (error) {
    // 檔案可能不存在，創建它
    const dayName = filename.replace('.txt', '');
    const header = createFileHeader(filename);
    await fs.writeFile(filePath, header, 'utf-8');
  }
}

/**
 * 獲取指定檔案的溫度記錄
 */
export async function getTemperatureRecords(filename: string): Promise<string[]> {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const content = await fs.readFile(filePath, 'utf-8');
    
    // 過濾掉標題行和空行
    const lines = content.split('\n').filter(line => {
      return line.trim() !== '' && 
             !line.startsWith('溫度記錄 - ') && 
             !line.startsWith('=');
    });
    
    return lines;
  } catch (error) {
    console.error(`❌ 讀取溫度記錄檔案失敗 (${filename}):`, error);
    return [];
  }
}

/**
 * 獲取所有可用的溫度記錄檔案列表
 */
export async function getAvailableLogFiles(): Promise<string[]> {
  try {
    const files = await fs.readdir(DATA_DIR);
    
    // 只返回星期檔案
    return files.filter(file => 
      WEEKDAY_FILES.includes(file) && 
      file.endsWith('.txt')
    ).sort((a, b) => {
      // 按星期順序排序
      return WEEKDAY_FILES.indexOf(a) - WEEKDAY_FILES.indexOf(b);
    });
  } catch (error) {
    console.error('❌ 讀取溫度記錄檔案列表失敗:', error);
    return WEEKDAY_FILES; // 返回預設列表
  }
}

/**
 * 獲取今日的溫度記錄
 */
export async function getTodayTemperatureRecords(): Promise<string[]> {
  try {
    const currentTime = await getNTPTime();
    const filename = getDayOfWeekFileName(currentTime);
    return await getTemperatureRecords(filename);
  } catch (error) {
    console.error('❌ 獲取今日溫度記錄失敗:', error);
    return [];
  }
}

/**
 * 刪除所有溫度記錄檔案（用於測試）
 */
export async function clearAllTemperatureLogs(): Promise<void> {
  try {
    for (const filename of WEEKDAY_FILES) {
      const filePath = path.join(DATA_DIR, filename);
      try {
        await fs.unlink(filePath);
        console.log(`🗑️  已刪除溫度記錄檔案: ${filename}`);
      } catch (error) {
        // 檔案可能不存在，忽略錯誤
      }
    }
    
    // 重新初始化檔案
    await initWeekdayFiles();
    
  } catch (error) {
    console.error('❌ 清除溫度記錄失敗:', error);
  }
}

/**
 * 獲取記錄器狀態
 */
export function getLoggerStatus(): {
  active: boolean;
  recordingPaused: boolean;
  pauseReason: string | null;
  pauseReasonText: string | null;
  lastRecordTime: string | null;
  lastTemperature: number | null;
  intervalMinutes: number;
  mqttConnectedCount: number;
  lastMqttTemperatureAt: string | null;
} {
  const mqttState = recordingContext.getRecordingState?.();
  if (mqttState) {
    lastMqttDiagnostics = {
      connectedCount: mqttState.connectedCount,
      lastMqttTemperatureAt: mqttState.lastMqttTemperatureAt,
    };
    if (!mqttState.valid) {
      recordingPaused = true;
      pauseReason = mqttState.reason;
    } else if (loggerActive) {
      recordingPaused = false;
      pauseReason = null;
    }
  }

  return {
    active: loggerActive,
    recordingPaused,
    pauseReason,
    pauseReasonText: getPauseReasonText(pauseReason),
    lastRecordTime: lastRecordTime ? lastRecordTime.toISOString() : null,
    lastTemperature,
    intervalMinutes: loggerActive ? configuredIntervalMinutes : 0,
    mqttConnectedCount: lastMqttDiagnostics.connectedCount,
    lastMqttTemperatureAt: lastMqttDiagnostics.lastMqttTemperatureAt
      ? new Date(lastMqttDiagnostics.lastMqttTemperatureAt).toISOString()
      : null,
  };
}