import { NextResponse } from 'next/server';

const LOGGER_STATUS_KEY = Symbol.for('smartplug.temperatureLogger.getStatus');

type LoggerStatus = {
  active: boolean;
  recordingPaused: boolean;
  pauseReason: string | null;
  pauseReasonText: string | null;
  lastRecordTime: string | null;
  lastTemperature: number | null;
  intervalMinutes: number;
  mqttConnectedCount: number;
  lastMqttTemperatureAt: string | null;
};

function getSharedLoggerStatus(): LoggerStatus {
  const getStatus = (global as Record<symbol, unknown>)[LOGGER_STATUS_KEY];
  if (typeof getStatus === 'function') {
    return getStatus() as LoggerStatus;
  }

  return {
    active: false,
    recordingPaused: true,
    pauseReason: 'logger_unavailable',
    pauseReasonText: '溫度記錄服務未啟動（請確認以 node server.js 執行）',
    lastRecordTime: null,
    lastTemperature: null,
    intervalMinutes: 0,
    mqttConnectedCount: 0,
    lastMqttTemperatureAt: null,
  };
}

function formatLocalTime(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
  } catch {
    return iso;
  }
}

export async function GET() {
  const status = getSharedLoggerStatus();

  const recordingStatusText = status.recordingPaused
    ? (status.pauseReasonText ?? '暫停寫入')
    : '正常記錄中';

  return NextResponse.json({
    success: true,
    ...status,
    lastRecordTimeFormatted: formatLocalTime(status.lastRecordTime),
    lastMqttTemperatureAtFormatted: formatLocalTime(status.lastMqttTemperatureAt),
    recordingStatusText,
  });
}
