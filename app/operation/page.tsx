'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import TemperatureRecordPanel from './temperature-record-panel';

interface Relay {
  id: number;
  name: string;
  state: boolean;
}

export default function OperationPanel() {
  const router = useRouter();

  // 狀態管理
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
  const [currentPage, setCurrentPage] = useState<'home' | 'temp-record' | 'system-settings'>('home');

  // ESP32 設備在線狀態
  // 'unknown'      = 剛進入頁面，尚未收到 live 訊息（等待 retained 訊息）
  // 'online'       = 設備在線，可正常操作
  // 'offline'      = 設備離線（LWT 觸發），UI 凍結
  // 'reconnecting' = 設備重啟中，正在同步狀態，UI 暫時鎖定
  type DeviceStatus = 'unknown' | 'online' | 'offline' | 'reconnecting';
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>('unknown');

  // 系統設定狀態
  const [systemSettings, setSystemSettings] = useState({
    plugName: '',
    loginPassword: '',
    mqttBroker: '',
    mqttPort: '',
    mqttClientId: '',
    mqttUser: '',
    mqttPwd: ''
  });

  // 載入設定
  useEffect(() => {
    if (currentPage === 'system-settings') {
      loadSettings();
    }
  }, [currentPage]);

  // 載入設定函數
  const loadSettings = async () => {
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) {
        throw new Error('無法載入設定');
      }
      const data = await response.json();

      setSystemSettings({
        plugName: data.plugName || '',
        loginPassword: '', // 密碼不顯示，留空
        mqttBroker: data.mqtt.broker || '',
        mqttPort: data.mqtt.port || '',
        mqttClientId: data.mqtt.clientId || '',
        mqttUser: data.mqtt.username || '',
        mqttPwd: '' // 密碼不顯示，留空
      });
    } catch (error) {
      console.error('載入設定失敗:', error);
      alert('載入設定失敗，請稍後再試');
    }
  };

  // 儲存設定
  const handleSaveSettings = async () => {
    try {
      // 收集表單數據
      const formData = {
        plugName: systemSettings.plugName.trim(),
        loginPassword: systemSettings.loginPassword.trim(),
        mqtt: {
          broker: systemSettings.mqttBroker.trim(),
          port: systemSettings.mqttPort.trim(),
          clientId: systemSettings.mqttClientId.trim(),
          username: systemSettings.mqttUser.trim(),
          password: systemSettings.mqttPwd.trim()
        }
      };

      // 驗證必要欄位
      if (!formData.mqtt.broker || !formData.mqtt.port || !formData.mqtt.clientId) {
        alert('請填寫 MQTT Broker、Port 和 ClientID');
        return;
      }

      // 如果密碼為空，表示不修改
      if (!formData.loginPassword) {
        // 從現有設定中取得密碼
        const currentSettings = await fetch('/api/settings').then(res => res.json());
        formData.loginPassword = currentSettings.loginPassword;
      }

      if (!formData.mqtt.password) {
        // 從現有設定中取得密碼
        const currentSettings = await fetch('/api/settings').then(res => res.json());
        formData.mqtt.password = currentSettings.mqtt.password;
      }

      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      const result = await response.json();

      if (response.ok && result.success) {
        alert('設定已儲存成功！');
        // 重新載入設定以確保同步
        loadSettings();
      } else {
        throw new Error(result.error || '儲存失敗');
      }
    } catch (error: any) {
      console.error('儲存設定失敗:', error);
      alert('儲存設定失敗: ' + error.message);
    }
  };

  // 回復原廠設定
  const handleResetSettings = async () => {
    if (!confirm('確定要回復原廠設定嗎？這將會重置所有設定為預設值，包括設備名稱和繼電器名稱。')) {
      return;
    }

    try {
      console.log('🔄 開始回復原廠設定...');

      // 直接呼叫新的 POST /api/settings/factory API
      const clientId = sessionStorage.getItem('mqttClientId');
      const response = await fetch('/api/settings/factory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId })
      });

      const result = await response.json();

      if (response.ok && result.success) {
        console.log('✅ 原廠設定回復成功:', result);

        // 顯示成功訊息
        alert('原廠設定已成功回復！\n設備名稱和繼電器名稱已更新。');

        // 重新載入設定頁面
        loadSettings();

        // 更新繼電器名稱為原廠預設值 (Relay 1 ~ Relay 6)
        // 這些更新會透過 WebSocket 自動接收，但為了確保即時性，我們也手動更新
        const defaultRelays = [
          { id: 0, name: 'Relay 1', state: false },
          { id: 1, name: 'Relay 2', state: false },
          { id: 2, name: 'Relay 3', state: false },
          { id: 3, name: 'Relay 4', state: false },
          { id: 4, name: 'Relay 5', state: false },
          { id: 5, name: 'Relay 6', state: false }
        ];

        setRelays(defaultRelays);
        console.log('✅ 繼電器名稱已更新為原廠預設值');

        // 如果當前在主頁面，重新整理頁面狀態
        if (currentPage === 'home') {
          // 發送請求獲取最新感測器數據
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ command: 'get_sensors' }));
          }
        }

      } else {
        throw new Error(result.error || result.details || '回復失敗');
      }
    } catch (error: any) {
      console.error('❌ 回復原廠設定失敗:', error);
      alert('回復原廠設定失敗: ' + error.message);
    }
  };

  // 處理輸入變化
  const handleInputChange = (field: string, value: string) => {
    setSystemSettings(prev => ({
      ...prev,
      [field]: value
    }));
  };

  // WebSocket 連線
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 初始化 WebSocket
  useEffect(() => {
    const timer = setTimeout(() => {
      console.log('🔄 开始初始化 WebSocket 连接...');
      connectWebSocket();
    }, 500);

    return () => {
      clearTimeout(timer);
      if (wsRef.current) {
        console.log('🧹 清理 WebSocket 连接');
        wsRef.current.close();
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, []);

  const connectWebSocket = () => {
    // 清除現有的重連計時器
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

    // 獲取 clientId
    let clientId = '';
    try {
      clientId = sessionStorage.getItem('mqttClientId') || '';
      console.log('從 sessionStorage 獲取 clientId:', clientId);
    } catch (e) {
      console.error('讀取 sessionStorage (clientId) 失敗:', e);
    }
    if (!clientId) {
      clientId = 'default_client_' + Math.floor(Math.random() * 1000);
      console.warn('⚠️ 未找到 clientId，使用臨時值:', clientId);
    }

    // 獲取 plugId (這對於 MQTT 路由至關重要)
    let plugId = '';
    try {
      plugId = sessionStorage.getItem('plugId') || '';
      console.log('從 sessionStorage 獲取 plugId:', plugId);
    } catch (e) {
      console.error('讀取 sessionStorage (plugId) 失敗:', e);
    }

    // 如果沒有 plugId，連線會被 Server 拒絕或無法訂閱正確 Topic
    if (!plugId) {
      console.error('❌ 嚴重錯誤：找不到 Plug ID，無法建立連線');
      // 這裡可以使用一個預設值方便測試，但正式環境建議阻擋
      plugId = 'default_plug';
    }

    // 構建 WebSocket URL，包含 plugId 參數
    const wsUrl = `${protocol}//${window.location.host}/api/ws/operation?clientId=${encodeURIComponent(clientId)}&plugId=${encodeURIComponent(plugId)}`;

    console.log('🔧 開始連接 WebSocket:', wsUrl);

    // 如果已經有 WebSocket 連接，先關閉它
    if (wsRef.current) {
      console.log('關閉現有的 WebSocket 連接');
      wsRef.current.close();
      wsRef.current = null;
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('✅ WebSocket 連接已成功建立');
      setMqttConnected(true);
      // 重設設備狀態為 unknown，等待 server.js 轉發 retained live 訊息
      setDeviceStatus('unknown');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('📨 收到 WebSocket 訊息:', data);
        handleMessage(data);
      } catch (e) {
        console.error('解析 WebSocket 訊息失敗:', e);
      }
    };

    ws.onerror = (error: Event) => {
      console.error('❌ WebSocket 發生錯誤:', error);
      // 嘗試獲取錯誤訊息
      const errorMessage = (error as ErrorEvent).message || '未知錯誤';
      console.error('錯誤詳情:', {
        type: error.type,
        message: errorMessage,
        timeStamp: error.timeStamp
      });
      setMqttConnected(false);
    };

    ws.onclose = (event: CloseEvent) => {
      const reason = event.reason || '未知原因';
      console.log('❌ WebSocket 連接已關閉，代碼:', event.code, '原因:', reason, 'wasClean:', event.wasClean);
      setMqttConnected(false);
      // 如果不是正常關閉，5秒後重連
      if (event.code !== 1000) {
        console.log('⏳ 5秒後嘗試重新連接...');
        reconnectTimerRef.current = setTimeout(connectWebSocket, 5000);
      }
    };
  };

  const sendCommand = (command: string, params?: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const message = { command, ...params };
      wsRef.current.send(JSON.stringify(message));
      console.log('📤 發送命令:', message);
    } else {
      console.error('WebSocket 未連線');
    }
  };

  const handleMessage = (data: any) => {
    switch (data.type) {
      case 'mqtt_status':
        console.log('📡 MQTT 狀態更新:', data.status);
        setMqttConnected(data.connected);
        break;

      case 'sensor_data':
        if (data.temperature !== undefined && data.temperature !== null) {
          setTemperature(data.temperature);
        }
        break;

      case 'relay_response':
        setRelays(prev => prev.map(relay =>
          relay.id === data.relay_id ? { ...relay, state: data.state } : relay
        ));
        break;

      case 'relay_name_updated':
        setRelays(prev => prev.map(relay =>
          relay.id === data.relay_id ? { ...relay, name: data.name } : relay
        ));
        break;

      case 'plug_name_updated':
        setSystemSettings(prev => ({ ...prev, plugName: data.plugName }));
        break;

      // ── ESP32 設備在線狀態（LWT 機制） ──
      case 'device_offline':
        console.warn(`📴 [Device] ESP32 離線 (plugId: ${data.plugId})`);
        setDeviceStatus('offline');
        break;

      case 'device_reconnecting':
        console.log(`🔆 [Device] ESP32 重新啟動，同步狀態中... (plugId: ${data.plugId})`);
        setDeviceStatus('reconnecting');
        break;

      case 'device_online':
        console.log(`✅ [Device] ESP32 同步完成，恢復操作 (plugId: ${data.plugId})`);
        setDeviceStatus('online');
        break;

      case 'error':
        console.error('伺服器錯誤:', data.message);
        break;
    }
  };

  // 設備是否可操作
  // 'online'  → 確認在線，可操作
  // 'unknown' → 尚未收到 live 訊號（LWT 機制啟動中），允許操作（避免實驗期間卡住）
  // 'offline' / 'reconnecting' → 凍結操作
  const isDeviceReady = deviceStatus === 'online' || deviceStatus === 'unknown';

  // 切換繼電器
  const toggleRelay = (id: number, state: boolean) => {
    if (!isDeviceReady) return;
    setRelays(prev => prev.map(relay =>
      relay.id === id ? { ...relay, state } : relay
    ));
    sendCommand('relay_control', { relay_id: id, state });
  };

  // 點動功能
  const handlePulse = async (id: number) => {
    if (!isDeviceReady) return;
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

  // 修改繼電器名稱
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
          setRelays(prev => prev.map(relay =>
            relay.id === id ? { ...relay, name: trimmedName } : relay
          ));
          console.log(`✅ 繼電器 ${id + 1} 名稱已更新為: ${trimmedName}`);
        } else {
          throw new Error(result.error || '儲存失敗');
        }
      } catch (error: any) {
        console.error('儲存名稱時發生錯誤:', error);
        alert('儲存名稱失敗：' + error.message);
      }
    } else if (newName !== null) {
      alert('開關名稱不能為空!');
    }
  };

  // 登出
  const handleLogout = async () => {
    if (confirm('確定要登出系統嗎?')) {
      try {
        const clientId = sessionStorage.getItem('mqttClientId');
        await fetch('/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId })
        });
        if (wsRef.current) {
          wsRef.current.close();
        }
        router.push('/');
      } catch (error) {
        console.error('登出錯誤:', error);
        router.push('/');
      }
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* 右上角狀態徽章群組 */}
      <div className="fixed top-3 right-3 z-50 flex flex-col items-end gap-1.5">
        {/* WebSocket 狀態指示 */}
        <div className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-2 ${mqttConnected ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}>
          <div className={`w-2 h-2 rounded-full bg-white ${mqttConnected ? 'animate-pulse' : ''}`}></div>
          {mqttConnected ? '已連線' : '已斷線'}
        </div>

        {/* ESP32 設備連線狀態徽章 */}
        <div className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 transition-colors duration-300 ${
          deviceStatus === 'online' || deviceStatus === 'unknown'
            ? 'bg-blue-500 text-white'
            : 'bg-red-600 text-white'
        }`}>
          <div className={`w-2 h-2 rounded-full bg-white ${deviceStatus === 'online' ? 'animate-pulse' : ''}`}></div>
          {deviceStatus === 'online' || deviceStatus === 'unknown' ? 'smartplug 連線中' : 'smartplug 離線'}
        </div>
      </div>

      {/* ── ESP32 設備離線/重連 覆蓋層（僅 offline / reconnecting 才全版凍結） ── */}
      {(deviceStatus === 'offline' || deviceStatus === 'reconnecting') && (
        <div className="fixed inset-0 z-40 bg-black/65 flex items-center justify-center px-6">
          <div className="bg-white rounded-2xl p-8 text-center shadow-2xl max-w-sm w-full">
            {deviceStatus === 'offline' && (
              <>
                <div className="text-5xl mb-4">⚡</div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">設備離線</h2>
                <p className="text-gray-500 text-sm">
                  ESP32 已失去連線，等待設備重新啟動...
                </p>
                <div className="mt-5 flex items-center justify-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-orange-400 animate-bounce [animation-delay:0ms]" />
                  <div className="w-2.5 h-2.5 rounded-full bg-orange-400 animate-bounce [animation-delay:150ms]" />
                  <div className="w-2.5 h-2.5 rounded-full bg-orange-400 animate-bounce [animation-delay:300ms]" />
                </div>
              </>
            )}
            {deviceStatus === 'reconnecting' && (
              <>
                <div className="text-5xl mb-4">🔄</div>
                <h2 className="text-xl font-bold text-gray-800 mb-2">設備重新連線中</h2>
                <p className="text-gray-500 text-sm">
                  正在同步繼電器狀態，請稍候...
                </p>
                <div className="mt-5 flex items-center justify-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-bounce [animation-delay:0ms]" />
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-bounce [animation-delay:150ms]" />
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-bounce [animation-delay:300ms]" />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 主內容區 */}
      <div className="flex-1 p-4 pb-24 overflow-y-auto overflow-x-hidden">
        {currentPage === 'home' && (
          <div className="max-w-4xl mx-auto">
            <h2 className="text-2xl font-bold text-center text-gray-800 mb-4">
              智能家居遠控面板
            </h2>

            {/* 溫度顯示 */}
            <div className="bg-white rounded-lg shadow-md p-4 text-center mb-6 max-w-sm mx-auto">
              <div className="text-xl font-bold text-gray-700">
                現在溫度:
                <span className="text-3xl text-red-500 ml-2">
                  {temperature !== null ? temperature.toFixed(1) : '--.-'}
                </span>
                °C
              </div>
            </div>

            {/* 繼電器控制網格 */}
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
                    {/* 使用 CSS 樣式的開關 */}
                    <div className={`checkbox-wrapper-25 ${!isDeviceReady ? 'pointer-events-none' : ''}`}>
                      <input
                        type="checkbox"
                        checked={relay.state}
                        onChange={(e) => {
                          console.log('開關點擊', relay.id, e.target.checked);
                          toggleRelay(relay.id, e.target.checked);
                        }}
                        id={`switch-${relay.id}`}
                        disabled={!isDeviceReady}
                      />
                      <label htmlFor={`switch-${relay.id}`} className={isDeviceReady ? 'cursor-pointer' : 'cursor-not-allowed'}>
                      </label>
                    </div>

                    {/* 點動按鈕 */}
                    <button
                      onClick={() => {
                        console.log('點動按鈕點擊', relay.id);
                        handlePulse(relay.id);
                      }}
                      disabled={!isDeviceReady}
                      className="bg-green-500 hover:bg-green-600 active:bg-green-700 text-white px-3 py-1.5 rounded-md text-xs font-bold shadow-md transition-all hover:shadow-lg active:translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-green-500 disabled:active:translate-y-0"
                    >
                      點動
                    </button>

                    {/* 修改按鈕 */}
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

        {currentPage === 'system-settings' && (
          <div className="w-full max-w-6xl mx-auto px-2 sm:px-4 lg:px-6">
            <h2 className="text-2xl sm:text-3xl font-bold text-center text-gray-800 mb-4 sm:mb-6">
              智能家居遙控面板設定
            </h2>
            <div className="bg-white rounded-lg sm:rounded-xl shadow-lg p-4 sm:p-6 lg:p-8">
              <form id="settings-form" className="space-y-6">
                {/* 插座名稱和登錄密碼 - 在較大屏幕上並排 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                  <div>
                    <label className="block text-gray-700 font-medium mb-2 text-sm sm:text-base">
                      插座名稱：
                    </label>
                    <input
                      type="text"
                      id="plugName"
                      maxLength={10}
                      value={systemSettings.plugName}
                      onChange={(e) => handleInputChange('plugName', e.target.value)}
                      className="w-full px-3 py-2 sm:px-4 sm:py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm sm:text-base"
                      placeholder="最多10字"
                    />
                  </div>

                  <div>
                    <label className="block text-gray-700 font-medium mb-2 text-sm sm:text-base">
                      登錄密碼：
                    </label>
                    <input
                      type="password"
                      id="loginPassword"
                      value={systemSettings.loginPassword}
                      onChange={(e) => handleInputChange('loginPassword', e.target.value)}
                      className="w-full px-3 py-2 sm:px-4 sm:py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm sm:text-base"
                      placeholder="空白表示不修改"
                    />
                  </div>
                </div>

                {/* MQTT 設定 */}
                <div className="space-y-4 sm:space-y-6">
                  <h3 className="text-lg sm:text-xl font-semibold text-gray-800">MQTT 連線設定</h3>

                  {/* MQTT Broker - 單獨一行 */}
                  <div>
                    <label className="block text-gray-700 font-medium mb-2 text-sm sm:text-base">
                      MQTT Broker：
                    </label>
                    <input
                      type="text"
                      id="mqttBroker"
                      value={systemSettings.mqttBroker}
                      onChange={(e) => handleInputChange('mqttBroker', e.target.value)}
                      className="w-full px-3 py-2 sm:px-4 sm:py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm sm:text-base"
                      placeholder="Broker.emqx.io"
                    />
                  </div>

                  {/* MQTT Port 和 ClientID - 在較大屏幕上並排 */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                    <div>
                      <label className="block text-gray-700 font-medium mb-2 text-sm sm:text-base">
                        MQTT Port：
                      </label>
                      <input
                        type="text"
                        id="mqttPort"
                        value={systemSettings.mqttPort}
                        onChange={(e) => handleInputChange('mqttPort', e.target.value)}
                        className="w-full px-3 py-2 sm:px-4 sm:py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm sm:text-base"
                        placeholder="8083"
                      />
                    </div>

                    <div>
                      <label className="block text-gray-700 font-medium mb-2 text-sm sm:text-base">
                        MQTT ClientID：
                      </label>
                      <input
                        type="text"
                        id="mqttClientId"
                        value={systemSettings.mqttClientId}
                        onChange={(e) => handleInputChange('mqttClientId', e.target.value)}
                        className="w-full px-3 py-2 sm:px-4 sm:py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm sm:text-base"
                        placeholder="smartplug_random"
                      />
                    </div>
                  </div>

                  {/* MQTT User 和 Pwd - 在較大屏幕上並排 */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                    <div>
                      <label className="block text-gray-700 font-medium mb-2 text-sm sm:text-base">
                        MQTT User：
                      </label>
                      <input
                        type="text"
                        id="mqttUser"
                        value={systemSettings.mqttUser}
                        onChange={(e) => handleInputChange('mqttUser', e.target.value)}
                        className="w-full px-3 py-2 sm:px-4 sm:py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm sm:text-base"
                        placeholder="選填"
                      />
                    </div>

                    <div>
                      <label className="block text-gray-700 font-medium mb-2 text-sm sm:text-base">
                        MQTT Pwd：
                      </label>
                      <input
                        type="password"
                        id="mqttPwd"
                        value={systemSettings.mqttPwd}
                        onChange={(e) => handleInputChange('mqttPwd', e.target.value)}
                        className="w-full px-3 py-2 sm:px-4 sm:py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm sm:text-base"
                        placeholder="選填"
                      />
                    </div>
                  </div>
                </div>

                {/* 按鈕區域 - 響應式調整 */}
                <div className="flex flex-col sm:flex-row flex-wrap gap-3 sm:gap-4 pt-4 sm:pt-6">
                  <button
                    type="button"
                    onClick={() => setCurrentPage('home')}
                    className="flex-1 min-w-[140px] px-4 py-3 sm:px-6 sm:py-3 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-medium transition-colors text-sm sm:text-base"
                  >
                    回上一頁
                  </button>
                  <button
                    type="button"
                    onClick={handleResetSettings}
                    className="flex-1 min-w-[140px] px-4 py-3 sm:px-6 sm:py-3 bg-yellow-500 hover:bg-yellow-600 text-white rounded-lg font-medium transition-colors text-sm sm:text-base"
                  >
                    回復原廠設定
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveSettings}
                    className="flex-1 min-w-[140px] px-4 py-3 sm:px-6 sm:py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors text-sm sm:text-base"
                  >
                    儲存設定
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>

      {/* 底部導航欄 */}
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
            onClick={() => setCurrentPage('system-settings')}
            className={`px-3 py-3 rounded-xl font-bold text-xs md:text-sm uppercase tracking-wider transition-all ${currentPage === 'system-settings'
              ? 'bg-white text-indigo-600 shadow-lg'
              : 'bg-transparent text-white border-2 border-white hover:bg-white/10'
              }`}
          >
            系統設定
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
