'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getOperationRoute, type UiType } from '@/lib/ui-type';
import TemperatureRecordPanel from './temperature-record-panel';

interface Relay {
  id: number;
  name: string;
  state: boolean;
}

interface OperationPanelProps {
  uiVariant: UiType;
}

export default function OperationPanel({ uiVariant }: OperationPanelProps) {
  const router = useRouter();
  const showPulseButton = uiVariant === 'A';

  const [pageReady, setPageReady] = useState(false);
  const [temperature, setTemperature] = useState<number | null>(null);
  const [relays, setRelays] = useState<Relay[]>([
    { id: 0, name: 'Relay 1', state: false },
    { id: 1, name: 'Relay 2', state: false },
    { id: 2, name: 'Relay 3', state: false },
    { id: 3, name: 'Relay 4', state: false },
    { id: 4, name: 'Relay 5', state: false },
    { id: 5, name: 'Relay 6', state: false },
  ]);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [currentPage, setCurrentPage] = useState<'home' | 'temp-record'>('home');
  const [deviceName, setDeviceName] = useState<string>('載入中…');

  type DeviceStatus = 'unknown' | 'online' | 'offline' | 'reconnecting';
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>('unknown');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchDeviceNameFromMqtt = async () => {
    try {
      const clientId = sessionStorage.getItem('mqttClientId');
      if (!clientId) {
        setDeviceName('—');
        return;
      }
      const response = await fetch(`/api/plugName?clientId=${encodeURIComponent(clientId)}`);
      if (!response.ok) {
        setDeviceName('—');
        return;
      }
      const data = await response.json();
      if (data.plugName && String(data.plugName).trim() !== '') {
        setDeviceName(String(data.plugName).trim());
      }
    } catch (e) {
      console.error('載入設備名稱失敗:', e);
    }
  };

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const clientId = sessionStorage.getItem('mqttClientId');
      const plugId = sessionStorage.getItem('plugId');
      if (!clientId || !plugId) {
        router.replace('/');
        return;
      }

      try {
        const res = await fetch(`/api/registry/ui-type?plugId=${encodeURIComponent(plugId)}`);
        const data = await res.json();
        if (cancelled) return;

        if (data.success && data.uiType) {
          const actual: UiType = data.uiType === 'B' ? 'B' : 'A';
          sessionStorage.setItem('uiType', actual);
          const targetRoute = getOperationRoute(actual);
          const expectedRoute = getOperationRoute(uiVariant);
          if (targetRoute !== expectedRoute) {
            router.replace(targetRoute);
            return;
          }
        }
      } catch (e) {
        console.warn('無法驗證 uiType，使用目前頁面:', e);
      }

      if (!cancelled) {
        setPageReady(true);
        fetchDeviceNameFromMqtt();
      }
    };

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [uiVariant, router]);

  const handleResetSettings = async () => {
    if (!confirm('確定要重置設備設定嗎？密碼將回復為 123456，繼電器全部關閉，名稱回歸預設；PlugID 與 ClientID 將保留。')) {
      return;
    }

    try {
      const clientId = sessionStorage.getItem('mqttClientId');
      const plugId = sessionStorage.getItem('plugId') || '';
      if (!clientId || !plugId) {
        alert('缺少連線資訊，請重新登入');
        return;
      }

      const response = await fetch('/api/settings/factory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, plugId })
      });

      const result = await response.json();

      if (response.ok && result.success) {
        alert('設備設定已重置！\n密碼已回復為 123456，繼電器已關閉，名稱已回歸預設。');

        if (result.broadcast?.plugName) {
          setDeviceName(result.broadcast.plugName);
        } else {
          fetchDeviceNameFromMqtt();
        }

        setRelays([
          { id: 0, name: 'Relay 1', state: false },
          { id: 1, name: 'Relay 2', state: false },
          { id: 2, name: 'Relay 3', state: false },
          { id: 3, name: 'Relay 4', state: false },
          { id: 4, name: 'Relay 5', state: false },
          { id: 5, name: 'Relay 6', state: false }
        ]);

        if (currentPage === 'home' && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ command: 'get_sensors' }));
        }
      } else {
        throw new Error(result.error || result.details || '回復失敗');
      }
    } catch (error: any) {
      console.error('❌ 重置設備設定失敗:', error);
      alert('重置設備設定失敗: ' + error.message);
    }
  };

  const connectWebSocket = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let clientId = sessionStorage.getItem('mqttClientId') || '';
    let plugId = sessionStorage.getItem('plugId') || '';

    if (!clientId || !plugId) {
      console.error('❌ 缺少 clientId 或 plugId，無法建立 WebSocket');
      router.replace('/');
      return;
    }

    const wsUrl = `${protocol}//${window.location.host}/api/ws/operation?clientId=${encodeURIComponent(clientId)}&plugId=${encodeURIComponent(plugId)}`;

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setMqttConnected(true);
      setDeviceStatus('unknown');
      sendCommand('get_sensors');
      fetchDeviceNameFromMqtt();
    };

    ws.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data));
      } catch (e) {
        console.error('解析 WebSocket 訊息失敗:', e);
      }
    };

    ws.onerror = () => {
      setMqttConnected(false);
    };

    ws.onclose = (event: CloseEvent) => {
      setMqttConnected(false);
      if (event.code !== 1000) {
        reconnectTimerRef.current = setTimeout(connectWebSocket, 5000);
      }
    };
  };

  useEffect(() => {
    if (!pageReady) return;

    const timer = setTimeout(connectWebSocket, 500);
    return () => {
      clearTimeout(timer);
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [pageReady]);

  const sendCommand = (command: string, params?: Record<string, unknown>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ command, ...params }));
    }
  };

  const handleMessage = (data: Record<string, unknown>) => {
    switch (data.type) {
      case 'mqtt_status':
        setMqttConnected(Boolean(data.connected));
        break;
      case 'sensor_data':
        if (data.temperature !== undefined && data.temperature !== null) {
          setTemperature(Number(data.temperature));
        }
        break;
      case 'relay_response':
        setRelays(prev => prev.map(relay =>
          relay.id === data.relay_id ? { ...relay, state: Boolean(data.state) } : relay
        ));
        break;
      case 'relay_name_updated':
        setRelays(prev => prev.map(relay =>
          relay.id === data.relay_id ? { ...relay, name: String(data.name) } : relay
        ));
        break;
      case 'plug_name_updated':
        if (data.plugName && String(data.plugName).trim() !== '') {
          setDeviceName(String(data.plugName).trim());
        }
        break;
      case 'device_offline':
        setDeviceStatus('offline');
        break;
      case 'device_reconnecting':
        setDeviceStatus('reconnecting');
        break;
      case 'device_online':
        setDeviceStatus('online');
        break;
    }
  };

  const isDeviceReady = deviceStatus === 'online' || deviceStatus === 'unknown';

  const toggleRelay = (id: number, state: boolean) => {
    if (!isDeviceReady) return;
    setRelays(prev => prev.map(relay =>
      relay.id === id ? { ...relay, state } : relay
    ));
    sendCommand('relay_control', { relay_id: id, state });
  };

  const handlePulse = (id: number) => {
    if (!isDeviceReady || !showPulseButton) return;
    setRelays(prev => prev.map(relay =>
      relay.id === id ? { ...relay, state: true } : relay
    ));
    sendCommand('relay_control', { relay_id: id, state: true });
    setTimeout(() => {
      setRelays(prev => prev.map(relay =>
        relay.id === id ? { ...relay, state: false } : relay
      ));
      sendCommand('relay_control', { relay_id: id, state: false });
    }, 1000);
  };

  const handleEditName = async (id: number) => {
    const relay = relays.find(r => r.id === id);
    if (!relay) return;

    const newName = prompt('更改開關名稱:', relay.name);
    if (newName !== null && newName.trim() !== '') {
      const trimmedName = newName.trim();
      if (trimmedName.length > 20) {
        alert('名稱過長！請限制在20個字元以內。');
        return;
      }

      try {
        const clientId = sessionStorage.getItem('mqttClientId');
        const response = await fetch('/api/relay/name', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name: trimmedName, clientId })
        });
        const result = await response.json();
        if (result.success) {
          setRelays(prev => prev.map(r =>
            r.id === id ? { ...r, name: trimmedName } : r
          ));
        } else {
          throw new Error(result.error || '儲存失敗');
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '未知錯誤';
        alert('儲存名稱失敗：' + message);
      }
    } else if (newName !== null) {
      alert('開關名稱不能為空!');
    }
  };

  const handleLogout = async () => {
    if (!confirm('確定要登出系統嗎?')) return;

    try {
      const clientId = sessionStorage.getItem('mqttClientId');
      const plugId = sessionStorage.getItem('plugId') || '';
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, plugId })
      });
      wsRef.current?.close();
    } catch (error) {
      console.error('登出錯誤:', error);
    } finally {
      sessionStorage.removeItem('uiType');
      router.push('/');
    }
  };

  if (!pageReady) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <p className="text-gray-600 font-medium">載入操作面板…</p>
      </div>
    );
  }

  const switchIdPrefix = uiVariant === 'B' ? 'switch-b' : 'switch';

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <div className="fixed top-3 right-3 z-50 flex flex-col items-end gap-1.5">
        <div className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-2 ${mqttConnected ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}>
          <div className={`w-2 h-2 rounded-full bg-white ${mqttConnected ? 'animate-pulse' : ''}`}></div>
          {mqttConnected ? 'MQTT已連線' : 'MQTT已斷線'}
        </div>
        <div className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 transition-colors duration-300 ${
          deviceStatus === 'online' || deviceStatus === 'unknown'
            ? 'bg-blue-500 text-white'
            : 'bg-red-600 text-white'
        }`}>
          <div className={`w-2 h-2 rounded-full bg-white ${deviceStatus === 'online' ? 'animate-pulse' : ''}`}></div>
          {deviceStatus === 'online' || deviceStatus === 'unknown' ? '設備已連線' : '設備已離線'}
        </div>
      </div>

      {(deviceStatus === 'offline' || deviceStatus === 'reconnecting') && (
        <div className="fixed inset-0 z-40 bg-black/65 flex items-center justify-center px-6">
          <div className="bg-white rounded-2xl p-8 text-center shadow-2xl max-w-sm w-full">
            {deviceStatus === 'offline' && (
              <>
                <div className="text-5xl mb-4">⚡</div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">設備離線</h2>
                <p className="text-gray-500 text-sm">ESP32 已失去連線，等待設備重新啟動...</p>
              </>
            )}
            {deviceStatus === 'reconnecting' && (
              <>
                <div className="text-5xl mb-4">🔄</div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">設備重新連線中</h2>
                <p className="text-gray-500 text-sm">正在同步繼電器狀態，請稍候...</p>
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 p-4 pb-24 overflow-y-auto overflow-x-hidden">
        <div className="max-w-4xl mx-auto mb-4 text-center">
          {currentPage === 'home' ? (
            <h2 className="text-2xl font-bold text-gray-800 mb-2">智能家居遠控面板</h2>
          ) : (
            <h2 className="text-2xl font-bold text-gray-800 mb-2">溫度記錄</h2>
          )}
          <div className="inline-block bg-white rounded-lg shadow-sm border border-gray-200 px-5 py-2 min-w-[200px]">
            <p className="text-xs text-gray-500 mb-0.5">設備名稱</p>
            <p className="text-lg font-semibold text-gray-800">{deviceName}</p>
          </div>
        </div>

        {currentPage === 'home' && (
          <div className="max-w-4xl mx-auto">
            <div className="bg-white rounded-lg shadow-md p-4 text-center mb-6 max-w-sm mx-auto">
              <div className="text-xl font-bold text-gray-700">
                現在溫度:
                <span className="text-3xl text-red-500 ml-2">
                  {temperature !== null ? temperature.toFixed(1) : '--.-'}
                </span>
                °C
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 md:gap-4 max-w-3xl mx-auto">
              {relays.map((relay) => (
                <div
                  key={relay.id}
                  className={`bg-white rounded-xl shadow-lg p-4 flex flex-col items-center gap-3 transition-shadow ${isDeviceReady ? 'hover:shadow-xl' : 'opacity-50'}`}
                >
                  <div className="font-bold text-gray-800 text-center text-sm md:text-base">
                    {relay.name}
                  </div>

                  <div className="flex items-center gap-2 flex-wrap justify-center w-full">
                    <div className={`checkbox-wrapper-25 ${!isDeviceReady ? 'pointer-events-none' : ''}`}>
                      <input
                        type="checkbox"
                        checked={relay.state}
                        onChange={(e) => toggleRelay(relay.id, e.target.checked)}
                        id={`${switchIdPrefix}-${relay.id}`}
                        disabled={!isDeviceReady}
                      />
                      <label htmlFor={`${switchIdPrefix}-${relay.id}`} className={isDeviceReady ? 'cursor-pointer' : 'cursor-not-allowed'}>
                      </label>
                    </div>

                    {showPulseButton && (
                      <button
                        onClick={() => handlePulse(relay.id)}
                        disabled={!isDeviceReady}
                        className="bg-green-500 hover:bg-green-600 active:bg-green-700 text-white px-3 py-1.5 rounded-md text-xs font-bold shadow-md transition-all hover:shadow-lg active:translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-green-500 disabled:active:translate-y-0"
                      >
                        點動
                      </button>
                    )}

                    <button
                      onClick={() => handleEditName(relay.id)}
                      disabled={!isDeviceReady}
                      className="bg-sky-400 hover:bg-sky-500 active:bg-sky-600 text-white px-3 py-1.5 rounded-md text-xs font-bold shadow-md transition-all hover:shadow-lg active:translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-sky-400 disabled:active:translate-y-0"
                    >
                      修改
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {currentPage === 'temp-record' && (
          <TemperatureRecordPanel />
        )}
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-gradient-to-r from-indigo-600 to-purple-600 shadow-lg p-4">
        <div className="max-w-4xl mx-auto grid grid-cols-4 gap-2 md:gap-4">
          <button
            onClick={() => setCurrentPage('home')}
            className={`px-3 py-3 rounded-xl font-bold text-xs md:text-sm uppercase tracking-wider transition-all ${currentPage === 'home'
              ? 'bg-white text-indigo-600 shadow-lg'
              : 'bg-transparent text-white border-2 border-white hover:bg-white/10'
              }`}
          >
            主頁面
          </button>
          <button
            onClick={() => setCurrentPage('temp-record')}
            className={`px-3 py-3 rounded-xl font-bold text-xs md:text-sm uppercase tracking-wider transition-all ${currentPage === 'temp-record'
              ? 'bg-white text-indigo-600 shadow-lg'
              : 'bg-transparent text-white border-2 border-white hover:bg-white/10'
              }`}
          >
            溫度記錄
          </button>
          <button
            onClick={handleResetSettings}
            className="px-3 py-3 rounded-xl font-bold text-xs md:text-sm uppercase tracking-wider bg-transparent text-white border-2 border-yellow-300 hover:bg-yellow-500/20 transition-all"
          >
            重置設備設定
          </button>
          <button
            onClick={handleLogout}
            className="px-3 py-3 rounded-xl font-bold text-xs md:text-sm uppercase tracking-wider bg-transparent text-white border-2 border-white hover:bg-white/10 transition-all"
          >
            登出
          </button>
        </div>
      </div>
    </div>
  );
}
