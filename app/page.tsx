'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

// ==========================================
// 固定 MQTT 連線參數（不對使用者開放修改）
// ==========================================
const FIXED_MQTT = {
  broker: 's4eb1262.ala.cn-hangzhou.emqxsl.cn',
  port: '8883',   // MQTTS (MQTT over TLS，伺服器端 TCP 連線)
  username: 'chuwm',
  password: 'chuwengming'
};

// 產生 userXXXXXX 格式的 ClientID（6位隨機整數）
function generateClientId(): string {
  const num = Math.floor(Math.random() * 1000000);
  return `user${num.toString().padStart(6, '0')}`;
}

type MqttStatus = 'disconnected' | 'connecting' | 'connected';
type AnnounceStatus = 'waiting' | 'registered' | 'unregistered' | 'timeout';

export default function LoginPage() {
  const router = useRouter();

  // PlugID
  const [plugId, setPlugId] = useState('');
  const [plugIdError, setPlugIdError] = useState('');

  // ClientID（預設系統自動產生，使用者可自行修改）
  const [clientId, setClientId] = useState<string>(() => generateClientId());

  // MQTT 連線狀態
  const [mqttStatus, setMqttStatus] = useState<MqttStatus>('disconnected');

  // ClientID 衝突提示
  const [clientIdConflict, setClientIdConflict] = useState(false);

  // Announce 狀態機
  const [announceStatus, setAnnounceStatus] = useState<AnnounceStatus>('waiting');
  const announceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 插座資訊
  const [plugName, setPlugName] = useState('SmartPlug');
  const [voltage, setVoltage] = useState<string>('-- V');
  const [voltageLoading, setVoltageLoading] = useState(false);

  // 登入
  const [loginPassword, setLoginPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // PlugID 驗證函數
  const validatePlugId = (id: string): string => {
    if (!id) return 'PlugID 不能為空';
    if (id.length < 8) return '至少需要 8 個字元';
    if (!/^[a-zA-Z0-9]+$/.test(id)) return '只能包含英文和數字，不允許中文或符號';
    if (!/[a-zA-Z]/.test(id) || !/[0-9]/.test(id)) return '必須同時包含英文字母和數字';
    return '';
  };

  const handlePlugIdChange = (value: string) => {
    setPlugId(value);
    setPlugIdError(validatePlugId(value));
  };

  // 初始化：讀取設定中的 plugId
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const response = await fetch('/data/setting.json');
        if (!response.ok) return;
        const data = await response.json();
        if (data.plugId) {
          setPlugId(data.plugId);
          setPlugIdError(validatePlugId(data.plugId));
        }
      } catch (e) {
        console.error('讀取設定檔案失敗:', e);
      }
    };
    loadSettings();

    return () => {
      if (announceTimerRef.current) clearInterval(announceTimerRef.current);
    };
  }, []);

  // ==========================================
  // Announce 狀態輪詢（MQTT 連線成功後啟動）
  // ==========================================
  const startAnnouncePolling = (cid: string) => {
    if (announceTimerRef.current) clearInterval(announceTimerRef.current);
    setAnnounceStatus('waiting');
    let pollCount = 0;
    const MAX_POLLS = 15; // 15 × 2s = 30 秒逾時

    announceTimerRef.current = setInterval(async () => {
      pollCount++;
      try {
        const res = await fetch(`/api/announce-status?clientId=${encodeURIComponent(cid)}`);
        const data = await res.json();
        if (data.responded) {
          clearInterval(announceTimerRef.current!);
          announceTimerRef.current = null;
          setAnnounceStatus(data.registered ? 'registered' : 'unregistered');
          if (data.registered) {
            fetchPlugName(cid);
            fetchVoltage(cid);
          }
        } else if (pollCount >= MAX_POLLS) {
          clearInterval(announceTimerRef.current!);
          announceTimerRef.current = null;
          setAnnounceStatus('timeout');
        }
      } catch (e) {
        console.error('輪詢 announce 狀態失敗:', e);
      }
    }, 2000);
  };

  // ==========================================
  // 獲取插座資訊
  // ==========================================
  const fetchPlugName = async (cid: string) => {
    try {
      const response = await fetch(`/api/plugName?clientId=${encodeURIComponent(cid)}`);
      const data = await response.json();
      if (data.plugName && data.plugName.trim() !== '') {
        setPlugName(data.plugName);
      }
    } catch (e) {
      console.error('獲取插座名稱失敗:', e);
    }
  };

  const fetchVoltage = async (cid: string) => {
    setVoltageLoading(true);
    try {
      const response = await fetch(`/api/voltage?clientId=${encodeURIComponent(cid)}`);
      const data = await response.json();
      if (data.voltage !== undefined && data.voltage !== 0) {
        setVoltage(`AC-${data.voltage}V`);
      } else {
        setVoltage('AC-0V (無數據)');
      }
    } catch (e) {
      console.error('獲取電壓失敗:', e);
      setVoltage('無法載入電壓');
    } finally {
      setVoltageLoading(false);
    }
  };

  // ==========================================
  // 儲存 PlugID 與固定 MQTT 設定到伺服器
  // ==========================================
  const saveSettings = async (pid: string, cid: string): Promise<boolean> => {
    try {
      const currentRes = await fetch('/api/settings');
      if (!currentRes.ok) throw new Error('無法讀取設定');
      const current = await currentRes.json();

      const newSettings = {
        ...current,
        plugId: pid,
        mqtt: {
          ...current.mqtt,
          broker: FIXED_MQTT.broker,
          port: FIXED_MQTT.port,
          clientId: cid,
          username: FIXED_MQTT.username,
          password: FIXED_MQTT.password
        }
      };

      const saveRes = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      });
      const result = await saveRes.json();
      return saveRes.ok && result.success;
    } catch (e) {
      console.error('儲存設定失敗:', e);
      return false;
    }
  };

  // ==========================================
  // 連接 MQTT
  // ==========================================
  const connectMqtt = async () => {
    const pidError = validatePlugId(plugId);
    if (pidError) {
      setPlugIdError(pidError);
      return;
    }

    // 連線前先檢查 ClientID 是否已被其他使用者佔用
    setClientIdConflict(false);
    try {
      const checkRes = await fetch(`/api/client-status?clientId=${encodeURIComponent(clientId)}`);
      const checkData = await checkRes.json();
      if (checkData.inUse) {
        setClientIdConflict(true);
        return;   // 阻止連線
      }
    } catch (e) {
      console.warn('無法檢查 ClientID 狀態，繼續連線:', e);
    }

    // 儲存設定
    const saved = await saveSettings(plugId, clientId);
    if (!saved) {
      alert('儲存設定失敗，請稍後再試');
      return;
    }

    setMqttStatus('connecting');
    setVoltage('偵測中...');
    setAnnounceStatus('waiting');

    try {
      const response = await fetch('/api/mqtt/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broker: FIXED_MQTT.broker,
          port: FIXED_MQTT.port,
          clientId: clientId,
          username: FIXED_MQTT.username,
          password: FIXED_MQTT.password
        })
      });

      const data = await response.json();

      if (data.success) {
        setMqttStatus('connected');

        // 儲存連線資訊供操作頁面使用
        try {
          sessionStorage.setItem('mqttClientId', clientId);
          sessionStorage.setItem('plugId', plugId);
        } catch (e) {
          console.error('寫入 sessionStorage 失敗:', e);
        }

        // 啟動 Announce 輪詢
        startAnnouncePolling(clientId);

      } else {
        setMqttStatus('disconnected');
        setVoltage('-- V');
        alert('MQTT 連線失敗：' + data.message);
      }
    } catch (e) {
      setMqttStatus('disconnected');
      setVoltage('-- V');
      console.error('MQTT 連線錯誤:', e);
      alert('MQTT 連線失敗，請確認網路設定');
    }
  };

  // 重置連線
  const resetConnection = () => {
    if (announceTimerRef.current) {
      clearInterval(announceTimerRef.current);
      announceTimerRef.current = null;
    }
    setMqttStatus('disconnected');
    setAnnounceStatus('waiting');
    setVoltage('-- V');
    setLoginPassword('');
    setErrorMessage('');
  };

  // ==========================================
  // 登入
  // ==========================================
  const handleLogin = async () => {
    if (announceStatus !== 'registered') return;
    if (!loginPassword) {
      setErrorMessage('請輸入密碼');
      return;
    }

    // 確保 session 正確
    try {
      sessionStorage.setItem('plugId', plugId);
      sessionStorage.setItem('mqttClientId', clientId);
    } catch (e) { }

    setErrorMessage('');
    setLoginLoading(true);

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword, clientId })
      });

      if (response.ok) {
        console.log('✅ 登入成功，載入操作面板...');
        router.push('/operation');
      } else {
        const data = await response.json();
        setErrorMessage(data.message || '密碼錯誤，請重新輸入。');
      }
    } catch (e) {
      setErrorMessage('登入失敗，請稍後再試。');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && announceStatus === 'registered' && !loginLoading) {
      handleLogin();
    }
  };

  // Announce 狀態 UI 設定
  const announceUI = {
    waiting:      { color: 'text-yellow-700 bg-yellow-50 border-yellow-200', icon: '⏳', text: '等待 ESP32 回應中...' },
    registered:   { color: 'text-green-700 bg-green-50 border-green-200',   icon: '✓',  text: 'ESP32 設備已授權，請輸入密碼' },
    unregistered: { color: 'text-red-700 bg-red-50 border-red-200',         icon: '✗',  text: '此 ClientID 尚未在 ESP32 設備中註冊' },
    timeout:      { color: 'text-orange-700 bg-orange-50 border-orange-200', icon: '⚠', text: 'ESP32 未回應（連線逾時），請確認設備電源' },
  };

  const passwordEnabled = mqttStatus === 'connected' && announceStatus === 'registered';

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-5">
      <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-black text-center mb-6">
          智能家居遠控系統
        </h1>

        {/* PlugID 輸入區 */}
        <div className="mb-5">
          <label className="block text-black font-semibold mb-2">
            PlugID <span className="text-gray-500 font-normal text-sm">（用於識別 ESP32 設備）</span>
          </label>
          <input
            type="text"
            value={plugId}
            onChange={(e) => handlePlugIdChange(e.target.value)}
            placeholder="例：sp123456（至少8碼，英文+數字）"
            className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-black placeholder-gray-400 disabled:bg-gray-100 disabled:cursor-not-allowed"
            disabled={mqttStatus !== 'disconnected'}
          />
          {plugIdError && (
            <div className="text-red-600 text-sm mt-1">{plugIdError}</div>
          )}
          {!plugIdError && plugId && mqttStatus === 'disconnected' && (
            <div className="text-green-600 text-sm mt-1">✓ PlugID 格式正確</div>
          )}
        </div>

        {/* ClientID 輸入（預設自動產生，可手動修改） */}
        <div className="mb-5">
          <label className="block text-black font-semibold mb-2">
            Client ID <span className="text-gray-500 font-normal text-sm">（可修改，預設系統自動產生）</span>
          </label>
          <input
            type="text"
            value={clientId}
            onChange={(e) => { setClientId(e.target.value); setClientIdConflict(false); }}
            placeholder="user123456"
            disabled={mqttStatus !== 'disconnected'}
            className={`w-full px-3 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-black font-mono text-sm placeholder-gray-400 disabled:bg-gray-100 disabled:cursor-not-allowed ${clientIdConflict ? 'border-red-500 bg-red-50' : 'border-gray-300'}`}
          />
          {clientIdConflict && (
            <div className="mt-2 flex items-start gap-2 bg-red-50 border border-red-300 rounded-lg px-3 py-2">
              <span className="text-red-500 text-sm font-bold mt-0.5">⚠</span>
              <div>
                <p className="text-red-700 text-sm font-semibold">Client ID 已被佔用</p>
                <p className="text-red-600 text-xs mt-0.5">
                  「{clientId}」目前已有其他使用者連線中，請修改 Client ID 後再試。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* MQTT 連線控制區 */}
        {mqttStatus === 'disconnected' && (
          <div className="mb-5">
            <button
              onClick={connectMqtt}
              disabled={!!plugIdError || !plugId}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              連線 MQTT
            </button>
            <p className="text-gray-500 text-xs mt-2 text-center">
              伺服器：{FIXED_MQTT.broker}:{FIXED_MQTT.port}
            </p>
          </div>
        )}

        {mqttStatus === 'connecting' && (
          <div className="mb-5">
            <button disabled className="w-full py-3 bg-yellow-500 text-white rounded-lg font-medium cursor-wait">
              連線中...
            </button>
          </div>
        )}

        {mqttStatus === 'connected' && (
          <div className="mb-5">
            <div className="flex items-center justify-between p-3 bg-green-50 rounded-lg border border-green-200 mb-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                <span className="text-sm text-black font-medium">MQTT 已連線</span>
              </div>
              <button
                onClick={resetConnection}
                className="text-xs text-gray-600 hover:text-gray-900 underline"
              >
                重新設定
              </button>
            </div>

            {/* Announce 狀態 */}
            <div className={`p-3 rounded-lg border ${announceUI[announceStatus].color}`}>
              <div className="flex items-center gap-2">
                <span className="text-base">{announceUI[announceStatus].icon}</span>
                <span className="text-sm font-medium text-black">
                  {announceUI[announceStatus].text}
                </span>
                {announceStatus === 'waiting' && (
                  <span className="ml-auto text-xs text-gray-500 animate-pulse">輪詢中...</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 插座名稱（已授權後顯示） */}
        {passwordEnabled && (
          <div className="mb-4">
            <label className="block text-black font-semibold mb-2">插座名稱</label>
            <input
              type="text"
              value={plugName}
              readOnly
              className="w-full px-3 py-3 bg-gray-50 border border-gray-300 rounded-lg text-black"
            />
          </div>
        )}

        {/* 登入密碼 */}
        <div className="mb-5">
          <label className="block text-black font-semibold mb-2">登入密碼</label>
          <input
            type="password"
            value={loginPassword}
            onChange={(e) => { setLoginPassword(e.target.value); setErrorMessage(''); }}
            onKeyPress={handleKeyPress}
            placeholder={passwordEnabled ? '請輸入登入密碼' : '請先完成 MQTT 連線與設備授權'}
            disabled={!passwordEnabled || loginLoading}
            className="w-full px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none text-black placeholder-gray-400 disabled:bg-gray-100 disabled:cursor-not-allowed"
          />
          {errorMessage && (
            <div className="text-red-600 text-sm mt-1">{errorMessage}</div>
          )}
          {!passwordEnabled && mqttStatus !== 'disconnected' && announceStatus !== 'registered' && (
            <div className="text-gray-500 text-sm mt-1">
              {announceStatus === 'waiting' && '等待 ESP32 設備確認授權...'}
              {announceStatus === 'unregistered' && '此 ClientID 尚未在設備中授權，請先至 ESP32 設備進行註冊'}
              {announceStatus === 'timeout' && '請確認 ESP32 設備電源並重新連線'}
            </div>
          )}
        </div>

        {/* 登入按鈕 */}
        <button
          onClick={handleLogin}
          disabled={!passwordEnabled || loginLoading}
          className="w-full py-3 bg-gradient-to-r from-green-600 to-green-500 text-white rounded-lg text-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loginLoading ? '登入中...' : '登入'}
        </button>

        {/* 系統電壓規格 */}
        <div className="mt-6 bg-blue-600 text-white p-5 rounded-xl text-center">
          <p className="text-base font-bold mb-1">系統電壓規格</p>
          <span className={`text-3xl font-bold ${voltageLoading ? 'opacity-70 animate-pulse' : ''}`}>
            {voltage}
          </span>
        </div>
      </div>
    </div>
  );
}
