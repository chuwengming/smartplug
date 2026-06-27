'use client';

import { useState, useEffect } from 'react';

interface TemperatureRecord {
  raw: string;
  timestamp: string;
  temperature: string;
  time: string;
  value: number;
  formatted: string;
}

interface LogFile {
  name: string;
  displayName: string;
  dayOfWeek: string;
  url: string;
}

interface TodayRecordsResponse {
  success: boolean;
  currentTime: string;
  records: TemperatureRecord[];
  rawRecords: string[];
  stats: {
    count: number;
    average: string;
    min: string;
    max: string;
    latest: string;
  };
  summary: {
    totalRecords: number;
    dateRange: string;
    timeRange: string;
  };
  message: string;
}

interface FileListResponse {
  success: boolean;
  files: LogFile[];
  count: number;
  message: string;
}

interface LoggerStatusResponse {
  success: boolean;
  active: boolean;
  recordingPaused: boolean;
  pauseReason: string | null;
  pauseReasonText: string | null;
  recordingStatusText: string;
  lastRecordTime: string | null;
  lastRecordTimeFormatted: string | null;
  lastTemperature: number | null;
  intervalMinutes: number;
  mqttConnectedCount: number;
  lastMqttTemperatureAt: string | null;
  lastMqttTemperatureAtFormatted: string | null;
}

export default function TemperatureRecordPanel() {
  // 狀態管理
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [availableFiles, setAvailableFiles] = useState<LogFile[]>([]);
  const [todayRecords, setTodayRecords] = useState<TemperatureRecord[]>([]);
  const [isLoading, setIsLoading] = useState({
    files: false,
    records: false,
    download: false
  });
  const [error, setError] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');
  const [loggerStatus, setLoggerStatus] = useState<LoggerStatusResponse | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);

  const loadLoggerStatus = async () => {
    setIsLoadingStatus(true);
    try {
      const response = await fetch('/api/temperature-log/status');
      const data: LoggerStatusResponse = await response.json();
      if (data.success) {
        setLoggerStatus(data);
      }
    } catch (e) {
      console.error('載入記錄狀態失敗:', e);
    } finally {
      setIsLoadingStatus(false);
    }
  };

  // 加載可用檔案列表與記錄器狀態
  useEffect(() => {
    loadAvailableFiles();
    loadLoggerStatus();

    const timer = setInterval(loadLoggerStatus, 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  // 載入可用檔案列表
  const loadAvailableFiles = async () => {
    setIsLoading(prev => ({ ...prev, files: true }));
    setError('');
    
    try {
      const response = await fetch('/api/temperature-log/list');
      const data: FileListResponse = await response.json();
      
      if (data.success) {
        setAvailableFiles(data.files);
        if (data.files.length > 0 && !selectedFile) {
          setSelectedFile(data.files[0].name);
        }
      } else {
        setError(`無法載入檔案列表: ${data.message}`);
      }
    } catch (error) {
      console.error('載入檔案列表失敗:', error);
      setError('載入檔案列表失敗，請檢查網路連線');
    } finally {
      setIsLoading(prev => ({ ...prev, files: false }));
    }
  };

  // 載入今日溫度記錄
  const loadTodayRecords = async () => {
    setIsLoading(prev => ({ ...prev, records: true }));
    setError('');
    setSuccessMessage('');
    
    try {
      const response = await fetch('/api/temperature-log/today');
      const data: TodayRecordsResponse = await response.json();
      
      if (data.success) {
        setTodayRecords(data.records);
        setSuccessMessage(`已載入 ${data.records.length} 筆今日溫度記錄`);
        loadLoggerStatus();
      } else {
        setError(`無法載入今日記錄: ${data.message}`);
        setTodayRecords([]);
      }
    } catch (error) {
      console.error('載入今日記錄失敗:', error);
      setError('載入今日記錄失敗，請檢查伺服器連線');
      setTodayRecords([]);
    } finally {
      setIsLoading(prev => ({ ...prev, records: false }));
    }
  };

  // 下載選取的檔案
  const downloadSelectedFile = async () => {
    if (!selectedFile) {
      setError('請先選擇要下載的檔案');
      return;
    }
    
    setIsLoading(prev => ({ ...prev, download: true }));
    setError('');
    
    try {
      // 創建下載連結
      const downloadUrl = `/api/temperature-log/download?file=${encodeURIComponent(selectedFile)}`;
      
      // 使用隱藏的連結元素觸發下載
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = selectedFile;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setSuccessMessage(`已開始下載: ${selectedFile}`);
      
    } catch (error) {
      console.error('下載檔案失敗:', error);
      setError('下載檔案失敗，請稍後再試');
    } finally {
      setIsLoading(prev => ({ ...prev, download: false }));
    }
  };

  // 格式化溫度記錄顯示
  const formatTemperatureDisplay = (records: TemperatureRecord[]) => {
    if (records.length === 0) {
      return <div className="text-gray-500 text-center py-8">暫無溫度記錄</div>;
    }
    
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-12 gap-2 text-sm font-medium text-gray-700 bg-gray-100 p-2 rounded-lg">
          <div className="col-span-4">時間</div>
          <div className="col-span-4">日期</div>
          <div className="col-span-4 text-right">溫度</div>
        </div>
        
        {records.map((record, index) => (
          <div 
            key={index} 
            className="grid grid-cols-12 gap-2 p-2 border-b border-gray-200 hover:bg-gray-50"
          >
            <div className="col-span-4 font-mono">{record.time}</div>
            <div className="col-span-4 text-gray-600">{record.timestamp.split(' ')[0]}</div>
            <div className="col-span-4 text-right font-bold">
              <span className="text-blue-600">{record.value.toFixed(1)}</span>
              <span className="text-gray-500">°C</span>
            </div>
          </div>
        ))}
      </div>
    );
  };

  // 顯示統計資訊
  const renderStats = () => {
    if (todayRecords.length === 0) return null;
    
    const temps = todayRecords.map(r => r.value).filter(v => !isNaN(v));
    const avg = temps.length > 0 ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : '0.0';
    const min = temps.length > 0 ? Math.min(...temps).toFixed(1) : '0.0';
    const max = temps.length > 0 ? Math.max(...temps).toFixed(1) : '0.0';
    
    return (
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-4 mb-4">
        <h3 className="text-lg font-semibold text-gray-800 mb-2">今日統計</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-600">{todayRecords.length}</div>
            <div className="text-sm text-gray-600">記錄筆數</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600">{avg}°C</div>
            <div className="text-sm text-gray-600">平均溫度</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-red-600">{max}°C</div>
            <div className="text-sm text-gray-600">最高溫度</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-600">{min}°C</div>
            <div className="text-sm text-gray-600">最低溫度</div>
          </div>
        </div>
      </div>
    );
  };

  const renderLoggerStatusBanner = () => {
    if (!loggerStatus && isLoadingStatus) {
      return (
        <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 mb-4 text-sm text-gray-600">
          載入記錄狀態中…
        </div>
      );
    }

    if (!loggerStatus) return null;

    const isPaused = loggerStatus.recordingPaused;
    const boxClass = isPaused
      ? 'bg-amber-50 border-amber-200 text-amber-900'
      : 'bg-green-50 border-green-200 text-green-900';

    return (
      <div className={`border rounded-lg px-4 py-3 mb-4 ${boxClass}`}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="font-semibold">
            {isPaused ? '⏸️ 記錄狀態：暫停寫入' : '✅ 記錄狀態：正常記錄中'}
          </div>
          <button
            type="button"
            onClick={loadLoggerStatus}
            disabled={isLoadingStatus}
            className="text-sm underline hover:no-underline disabled:opacity-50 self-start sm:self-auto"
          >
            {isLoadingStatus ? '更新中…' : '重新整理狀態'}
          </button>
        </div>
        <div className="mt-2 text-sm space-y-1">
          {isPaused && loggerStatus.pauseReasonText && (
            <p>原因：{loggerStatus.pauseReasonText}</p>
          )}
          <p>
            最後寫入：
            {loggerStatus.lastRecordTimeFormatted
              ? ` ${loggerStatus.lastRecordTimeFormatted}`
              : ' 尚無紀錄'}
            {loggerStatus.lastTemperature != null && (
              <span>（{loggerStatus.lastTemperature.toFixed(1)}°C）</span>
            )}
          </p>
          <p>
            MQTT 連線數：{loggerStatus.mqttConnectedCount}
            {loggerStatus.lastMqttTemperatureAtFormatted && (
              <span> · 最近 MQTT 溫度：{loggerStatus.lastMqttTemperatureAtFormatted}</span>
            )}
          </p>
          <p>記錄間隔：每 {loggerStatus.intervalMinutes || 30} 分鐘</p>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold text-center text-gray-800 mb-6">
        溫度記錄管理
      </h2>

      {renderLoggerStatusBanner()}
      {/* 錯誤和成功訊息 */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
          <div className="flex items-center">
            <span className="text-red-500 mr-2">⚠️</span>
            <span>{error}</span>
          </div>
        </div>
      )}
      
      {successMessage && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg mb-4">
          <div className="flex items-center">
            <span className="text-green-500 mr-2">✅</span>
            <span>{successMessage}</span>
          </div>
        </div>
      )}
      
      {/* 檔案選擇和下載區域 */}
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <h3 className="text-xl font-semibold text-gray-800 mb-4">溫度記錄檔案管理</h3>
        
        <div className="space-y-4">
          {/* 檔案選擇 */}
          <div>
            <label className="block text-gray-700 font-medium mb-2">
              選擇溫度記錄檔案：
            </label>
            <div className="flex flex-col sm:flex-row gap-3">
              <select
                value={selectedFile}
                onChange={(e) => setSelectedFile(e.target.value)}
                disabled={isLoading.files || availableFiles.length === 0}
                className="flex-1 px-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none disabled:bg-gray-100"
              >
                {isLoading.files ? (
                  <option>載入中...</option>
                ) : availableFiles.length === 0 ? (
                  <option>無可用檔案</option>
                ) : (
                  availableFiles.map((file) => (
                    <option key={file.name} value={file.name}>
                      {file.displayName}
                    </option>
                  ))
                )}
              </select>
              
              <button
                onClick={downloadSelectedFile}
                disabled={!selectedFile || isLoading.download}
                className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading.download ? '下載中...' : '下載檔案'}
              </button>
            </div>
            <div className="text-sm text-gray-500 mt-2">
              共 {availableFiles.length} 個檔案可用，每週循環記錄
            </div>
          </div>
          
          {/* 重新整理按鈕 */}
          <div className="flex justify-end">
            <button
              onClick={loadAvailableFiles}
              disabled={isLoading.files}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 transition-colors disabled:opacity-50"
            >
              {isLoading.files ? '重新整理中...' : '重新整理檔案列表'}
            </button>
          </div>
        </div>
      </div>
      
      {/* 今日記錄顯示區域 */}
      <div className="bg-white rounded-lg shadow-lg p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-semibold text-gray-800">今日溫度記錄</h3>
          <button
            onClick={loadTodayRecords}
            disabled={isLoading.records}
            className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            {isLoading.records ? '載入中...' : '顯示紀錄'}
          </button>
        </div>
        
        {renderStats()}
        
        {/* 記錄列表 */}
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          {isLoading.records ? (
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <div className="text-gray-500 mt-2">載入溫度記錄中...</div>
            </div>
          ) : (
            formatTemperatureDisplay(todayRecords)
          )}
        </div>
        
        {/* 記錄說明 */}
        <div className="mt-4 text-sm text-gray-600">
          <div className="flex items-start">
            <span className="text-blue-500 mr-2">ℹ️</span>
            <div>
              <p>• 溫度記錄每30分鐘自動記錄一次（需有 MQTT 連線且收到有效溫度）</p>
              <p>• 無 MQTT 連線或溫度資料時，暫停寫入檔案</p>
              <p>• 記錄格式：日期 時間 溫度（°C）</p>
              <p>• 每週循環記錄，每天對應一個檔案</p>
              <p>• 新的一天開始時會自動清空舊記錄</p>
            </div>
          </div>
        </div>
      </div>
      
      {/* 操作提示 */}
      <div className="mt-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <h4 className="font-medium text-yellow-800 mb-2">操作提示：</h4>
        <ol className="list-decimal list-inside space-y-1 text-yellow-700">
          <li>從下拉選單選擇要下載的星期檔案</li>
          <li>點擊「下載檔案」將記錄儲存到手機或電腦</li>
          <li>上方狀態列顯示最後記錄時間與是否暫停寫入</li>
          <li>點擊「顯示紀錄」查看今日的溫度記錄</li>
          <li>有 MQTT 連線時，溫度記錄每30分鐘更新一次</li>
        </ol>
      </div>
    </div>
  );
}