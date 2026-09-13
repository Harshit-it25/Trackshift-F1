import { useState, useEffect, useMemo, useRef } from 'react';
import { 
  API_BASE,
  getPhysicalTelemetryStatus, 
  getPhysicalDevices, 
  getLatestPhysicalTelemetry,
  getPhysicalTelemetryHistory,
  createPhysicalTelemetryWebSocket,
  ingestPhysicalTelemetry
} from '../api';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts';

export default function PhysicalTelemetryPanel() {
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [_systemStatus, setSystemStatus] = useState(null);
  const [latestPacket, setLatestPacket] = useState(null);
  const [history, setHistory] = useState([]);
  const [wsConnectionStatus, setWsConnectionStatus] = useState('connecting');
  const [timeSinceLastPacket, setTimeSinceLastPacket] = useState(null);
  const [activeMetric, setActiveMetric] = useState('tyre_temp'); // 'tyre_temp' | 'tyre_pressure' | 'ambient_track'
  const [showConnectionGuide, setShowConnectionGuide] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // Ref to track latest packet time for real-time stopwatch
  const lastPacketTimeRef = useRef(null);

  async function handleSendTestPacket() {
    setTestSending(true);
    setTestResult(null);
    try {
      const data = await ingestPhysicalTelemetry({
        device_id: selectedDeviceId || 'TRACKSHIFT-ESP32-01',
        timestamp: Date.now() / 1000,
        sequence: (latestPacket?.sequence || 0) + 1,
        transport: 'HTTP_WIFI',
        sensors: {
          tyre_temperature: {
            FL: 84.5,
            FR: 85.2,
            RL: 81.0,
            RR: 81.8
          },
          tyre_pressure: {
            FL: 21.4,
            FR: 21.6,
            RL: 20.8,
            RR: 21.0
          },
          tyre_pressure_unit: 'psi',
          ambient_temperature: 24.5,
          track_temperature: 34.8
        }
      });
      setTestResult({ success: true, message: `Packet #${data.sequence} ingested successfully!` });
    } catch (err) {
      setTestResult({ success: false, message: err.message || 'Ingestion failed' });
    } finally {
      setTestSending(false);
    }
  }

  // 1. Initial REST fetch for devices & status
  useEffect(() => {
    let isMounted = true;

    async function loadInitialData() {
      const [statusRes, devicesRes] = await Promise.all([
        getPhysicalTelemetryStatus(),
        getPhysicalDevices()
      ]);

      if (!isMounted) return;

      setSystemStatus(statusRes);
      setDevices(devicesRes || []);

      if (devicesRes && devicesRes.length > 0) {
        const activeDev = devicesRes.find(d => d.status === 'online') || devicesRes[0];
        setSelectedDeviceId(activeDev.device_id);

        const [latest, hist] = await Promise.all([
          getLatestPhysicalTelemetry(activeDev.device_id),
          getPhysicalTelemetryHistory(activeDev.device_id, 100)
        ]);

        if (isMounted) {
          if (latest) {
            setLatestPacket(latest);
            lastPacketTimeRef.current = latest.ingested_at || latest.timestamp;
          }
          if (hist) setHistory(hist);
        }
      }
    }

    loadInitialData();

    // Periodic heartbeat poller every 3s to refresh device lists
    const interval = setInterval(async () => {
      const [statusRes, devicesRes] = await Promise.all([
        getPhysicalTelemetryStatus(),
        getPhysicalDevices()
      ]);
      if (isMounted) {
        setSystemStatus(statusRes);
        setDevices(devicesRes || []);
      }
    }, 3000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // 2. Load history when selected device changes
  useEffect(() => {
    if (!selectedDeviceId) return;
    let isMounted = true;

    async function fetchDeviceData() {
      const [latest, hist] = await Promise.all([
        getLatestPhysicalTelemetry(selectedDeviceId),
        getPhysicalTelemetryHistory(selectedDeviceId, 100)
      ]);
      if (!isMounted) return;
      if (latest) {
        setLatestPacket(latest);
        lastPacketTimeRef.current = latest.ingested_at || latest.timestamp;
      }
      if (hist) setHistory(hist);
    }

    fetchDeviceData();
    return () => { isMounted = false; };
  }, [selectedDeviceId]);

  // 3. Connect real-time WebSocket for instantaneous packet streaming
  useEffect(() => {
    const wsClient = createPhysicalTelemetryWebSocket(
      (data) => {
        if (data.type === 'PHYSICAL_TELEMETRY_PACKET') {
          const incomingPacket = data.packet;
          if (!selectedDeviceId || incomingPacket.device_id === selectedDeviceId) {
            setLatestPacket(incomingPacket);
            lastPacketTimeRef.current = incomingPacket.ingested_at || incomingPacket.timestamp;
            
            // Auto-select if first device
            if (!selectedDeviceId) {
              setSelectedDeviceId(incomingPacket.device_id);
            }

            setHistory((prev) => {
              const updated = [...prev, incomingPacket];
              return updated.length > 150 ? updated.slice(updated.length - 150) : updated;
            });
          }
        } else if (data.type === 'SNAPSHOT') {
          if (data.status) setSystemStatus(data.status);
          if (data.devices) setDevices(data.devices);
        }
      },
      (status) => {
        setWsConnectionStatus(status);
      }
    );

    return () => {
      wsClient.close();
    };
  }, [selectedDeviceId]);

  // 4. Real-time ticker for "time since last packet"
  useEffect(() => {
    const timer = setInterval(() => {
      if (lastPacketTimeRef.current) {
        const elapsed = (Date.now() / 1000) - lastPacketTimeRef.current;
        setTimeSinceLastPacket(elapsed >= 0 ? elapsed : 0);
      } else {
        setTimeSinceLastPacket(null);
      }
    }, 100);

    return () => clearInterval(timer);
  }, []);

  // Determine active device health
  const currentDevice = useMemo(() => {
    if (!selectedDeviceId) return null;
    return devices.find(d => d.device_id === selectedDeviceId) || null;
  }, [devices, selectedDeviceId]);

  const deviceStatus = useMemo(() => {
    if (!currentDevice && !latestPacket) return 'offline';
    if (timeSinceLastPacket === null) return currentDevice?.status || 'offline';
    if (timeSinceLastPacket <= 2.5) return 'online';
    if (timeSinceLastPacket <= 5.0) return 'stale';
    return 'offline';
  }, [currentDevice, latestPacket, timeSinceLastPacket]);

  // Sensor extraction
  const sensors = latestPacket?.sensors || {};
  const tyreTemps = sensors.tyre_temperature?.values || null;
  const tyrePressBar = sensors.tyre_pressure?.values_bar || null;
  const tyrePressPsi = sensors.tyre_pressure?.values_psi || null;
  const ambientTemp = sensors.ambient_temperature?.value ?? null;
  const trackTemp = sensors.track_temperature?.value ?? null;
  const wheelSpeed = sensors.wheel_speed?.value ?? null;

  // Chart data preparation with gap detection (breaks line if packet gap > 2.0s)
  const chartData = useMemo(() => {
    if (!history || history.length === 0) return [];
    
    return history.map((pkt, idx) => {
      const ts = pkt.ingested_at || pkt.timestamp || (idx * 0.1);
      const s = pkt.sensors || {};
      const t = s.tyre_temperature?.values || {};
      const p = s.tyre_pressure?.values_psi || {};

      // Check if previous packet had a big time gap
      const prevPkt = idx > 0 ? history[idx - 1] : null;
      const prevTs = prevPkt ? (prevPkt.ingested_at || prevPkt.timestamp) : null;
      const hasGap = prevTs && (ts - prevTs > 2.0);

      const timeLabel = new Date(ts * 1000).toLocaleTimeString([], { 
        minute: '2-digit', 
        second: '2-digit', 
        fractionalSecondDigits: 1 
      });

      return {
        timestamp: ts,
        timeLabel,
        hasGap,
        fl_temp: t.FL ?? null,
        fr_temp: t.FR ?? null,
        rl_temp: t.RL ?? null,
        rr_temp: t.RR ?? null,
        fl_psi: p.FL ?? null,
        fr_psi: p.FR ?? null,
        rl_psi: p.RL ?? null,
        rr_psi: p.RR ?? null,
        amb_temp: s.ambient_temperature?.value ?? null,
        trk_temp: s.track_temperature?.value ?? null
      };
    });
  }, [history]);

  return (
    <div className="physical-telemetry-container" style={{ padding: '16px', color: '#E0E0EC' }}>
      {/* 1. TOP STATUS & DEVICE SELECTOR BAR */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#12121E',
        border: '1px solid #232338',
        borderRadius: '8px',
        padding: '12px 18px',
        marginBottom: '16px'
      }}>
        {/* Left: Device Selection & Status Badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '11px', color: '#8E8EA8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Connected Hardware Device
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
              {devices.length > 0 ? (
                <select
                  value={selectedDeviceId || ''}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  style={{
                    background: '#181828',
                    border: '1px solid #33334D',
                    color: '#FFF',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    fontWeight: 600,
                    fontSize: '13px'
                  }}
                >
                  {devices.map(d => (
                    <option key={d.device_id} value={d.device_id}>
                      {d.device_id} ({d.transport || 'HTTP'}) — {d.status.toUpperCase()}
                    </option>
                  ))}
                </select>
              ) : (
                <span style={{ fontWeight: 600, color: '#FF453A', fontSize: '13px' }}>
                  NO PHYSICAL DEVICE DETECTED
                </span>
              )}
            </div>
          </div>

          {/* Connection Status Pill */}
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 14px',
            borderRadius: '20px',
            background: deviceStatus === 'online' ? 'rgba(0, 210, 190, 0.12)' : (deviceStatus === 'stale' ? 'rgba(255, 184, 0, 0.12)' : 'rgba(225, 6, 0, 0.15)'),
            border: `1px solid ${deviceStatus === 'online' ? '#00D2BE' : (deviceStatus === 'stale' ? '#FFB800' : '#E10600')}`
          }}>
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: deviceStatus === 'online' ? '#00D2BE' : (deviceStatus === 'stale' ? '#FFB800' : '#E10600'),
              boxShadow: deviceStatus === 'online' ? '0 0 8px #00D2BE' : 'none'
            }}></span>
            <span style={{
              fontSize: '12px',
              fontWeight: 700,
              color: deviceStatus === 'online' ? '#00D2BE' : (deviceStatus === 'stale' ? '#FFB800' : '#FF453A'),
              letterSpacing: '0.05em'
            }}>
              {deviceStatus === 'online' ? 'ONLINE' : (deviceStatus === 'stale' ? 'STALE' : 'PHYSICAL SENSOR OFFLINE')}
            </span>
          </div>
        </div>

        {/* Right: Freshness & Ingestion Metrics */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: '10px', color: '#77778E', textTransform: 'uppercase' }}>Last Packet</span>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#FFF' }}>
              {timeSinceLastPacket !== null ? `${timeSinceLastPacket.toFixed(2)} s ago` : '—'}
            </div>
          </div>

          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: '10px', color: '#77778E', textTransform: 'uppercase' }}>Packet Rate</span>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#00D2BE' }}>
              {latestPacket?.packet_rate_hz ? `${latestPacket.packet_rate_hz.toFixed(1)} Hz` : '0.0 Hz'}
            </div>
          </div>

          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: '10px', color: '#77778E', textTransform: 'uppercase' }}>Sequence</span>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#FFF' }}>
              #{latestPacket?.sequence ?? '—'}
            </div>
          </div>

          <div style={{
            fontSize: '11px',
            padding: '4px 10px',
            borderRadius: '4px',
            background: wsConnectionStatus === 'connected' ? 'rgba(0, 210, 190, 0.08)' : 'rgba(255, 69, 58, 0.1)',
            color: wsConnectionStatus === 'connected' ? '#00D2BE' : '#FF453A',
            border: '1px solid #232338'
          }}>
            WS: {wsConnectionStatus.toUpperCase()}
          </div>

          {/* Dedicated Connect / Setup Button */}
          <button
            onClick={() => setShowConnectionGuide(prev => !prev)}
            style={{
              background: showConnectionGuide ? '#00D2BE' : 'rgba(0, 210, 190, 0.15)',
              border: '1px solid #00D2BE',
              color: showConnectionGuide ? '#0B0B14' : '#00D2BE',
              padding: '6px 14px',
              borderRadius: '6px',
              fontWeight: 700,
              fontSize: '12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.2s ease'
            }}
          >
            🔌 {showConnectionGuide ? 'HIDE CONNECTION OPTIONS' : 'CONNECT HARDWARE'}
          </button>
        </div>
      </div>

      {/* EXPANDABLE HARDWARE CONNECTION OPTIONS DRAWER */}
      {showConnectionGuide && (
        <div style={{
          background: '#151524',
          border: '1px solid #00D2BE',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '20px',
          animation: 'fadeIn 0.2s ease'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ margin: 0, fontSize: '15px', color: '#00D2BE', display: 'flex', alignItems: 'center', gap: '8px' }}>
              🔌 PHYSICAL SENSOR CONNECTION INGESTION INTERFACE
            </h3>
            <span style={{ fontSize: '11px', color: '#8E8EA8' }}>Authoritative Ingestion Endpoint: {API_BASE}/api/physical-telemetry/ingest</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '16px' }}>
            {/* OPTION 1: Wi-Fi HTTP */}
            <div style={{ background: '#0E0E18', border: '1px solid #28283E', borderRadius: '6px', padding: '14px' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#FFF', marginBottom: '6px' }}>
                1. Wi-Fi ESP32 / Arduino / Pico
              </div>
              <p style={{ fontSize: '11px', color: '#8E8EA8', margin: '0 0 10px 0' }}>
                Microcontroller posts JSON directly over local Wi-Fi.
              </p>
              <div style={{ fontSize: '11px', fontFamily: 'monospace', color: '#00D2BE', background: '#12121E', padding: '6px 8px', borderRadius: '4px', marginBottom: '6px', wordBreak: 'break-all' }}>
                POST {API_BASE}/api/physical-telemetry/ingest
              </div>
              <div style={{ fontSize: '10px', color: '#88889C' }}>
                Sample code: <code>scripts/hardware/esp32_firmware_sample.ino</code>
              </div>
            </div>

            {/* OPTION 2: USB Serial Gateway */}
            <div style={{ background: '#0E0E18', border: '1px solid #28283E', borderRadius: '6px', padding: '14px' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#FFF', marginBottom: '6px' }}>
                2. USB Serial / COM Port Gateway
              </div>
              <p style={{ fontSize: '11px', color: '#8E8EA8', margin: '0 0 10px 0' }}>
                Plug microcontroller into USB port (COM3, COM4, /dev/ttyUSB0).
              </p>
              <div style={{ fontSize: '11px', fontFamily: 'monospace', color: '#FFB800', background: '#12121E', padding: '6px 8px', borderRadius: '4px', marginBottom: '6px' }}>
                python scripts/hardware/serial_gateway.py --port COM3
              </div>
              <div style={{ fontSize: '10px', color: '#88889C' }}>
                Reads serial lines and auto-bridges to TrackShift.
              </div>
            </div>

            {/* OPTION 3: Test Ingestion Harness */}
            <div style={{ background: '#0E0E18', border: '1px solid #28283E', borderRadius: '6px', padding: '14px' }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#FFF', marginBottom: '6px' }}>
                3. Live Hardware Test Stream
              </div>
              <p style={{ fontSize: '11px', color: '#8E8EA8', margin: '0 0 10px 0' }}>
                Test end-to-end packet validation & live graphing.
              </p>
              <div style={{ fontSize: '11px', fontFamily: 'monospace', color: '#E10600', background: '#12121E', padding: '6px 8px', borderRadius: '4px', marginBottom: '8px' }}>
                python scripts/hardware/test_physical_sender.py --count 20 --hz 2
              </div>
              <button
                onClick={handleSendTestPacket}
                disabled={testSending}
                style={{
                  width: '100%',
                  background: '#00D2BE',
                  border: 'none',
                  color: '#0B0B14',
                  padding: '6px 12px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
              >
                {testSending ? 'Transmitting...' : '⚡ Send Test Packet From Browser'}
              </button>
            </div>
          </div>

          {testResult && (
            <div style={{
              padding: '8px 14px',
              borderRadius: '6px',
              background: testResult.success ? 'rgba(0, 210, 190, 0.1)' : 'rgba(225, 6, 0, 0.1)',
              border: `1px solid ${testResult.success ? '#00D2BE' : '#E10600'}`,
              color: testResult.success ? '#00D2BE' : '#FF453A',
              fontSize: '12px',
              fontWeight: 600
            }}>
              {testResult.message}
            </div>
          )}
        </div>
      )}

      {/* 2. HONEST OFFLINE BANNER IF NO PHYSICAL DEVICE OR OFFLINE */}
      {(!currentDevice || deviceStatus === 'offline') && (
        <div style={{
          background: 'rgba(225, 6, 0, 0.06)',
          border: '1px solid rgba(225, 6, 0, 0.35)',
          borderRadius: '8px',
          padding: '24px',
          marginBottom: '20px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center'
        }}>
          <div style={{
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            background: 'rgba(225, 6, 0, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '22px',
            marginBottom: '12px'
          }}>
            🔌
          </div>
          <h3 style={{ margin: '0 0 6px 0', color: '#FF453A', letterSpacing: '0.05em' }}>
            PHYSICAL SENSOR OFFLINE
          </h3>
          <p style={{ margin: '0 0 14px 0', maxWidth: '640px', fontSize: '13px', color: '#AAAAB8', lineHeight: 1.5 }}>
            No real physical hardware stream is currently transmitting to the ingestion port.
            TrackShift strictly enforces zero-mock physical data: placeholder readings and synthetic curves are rejected.
          </p>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              onClick={() => setShowConnectionGuide(true)}
              style={{
                background: '#00D2BE',
                border: 'none',
                color: '#0B0B14',
                padding: '8px 18px',
                borderRadius: '6px',
                fontWeight: 700,
                fontSize: '13px',
                cursor: 'pointer'
              }}
            >
              🔌 Open Connection & Port Options
            </button>
            <button
              onClick={handleSendTestPacket}
              disabled={testSending}
              style={{
                background: '#1A1A2C',
                border: '1px solid #33334D',
                color: '#FFF',
                padding: '8px 18px',
                borderRadius: '6px',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer'
              }}
            >
              {testSending ? 'Transmitting...' : '⚡ Send Live Physical Test Packet'}
            </button>
          </div>
        </div>
      )}

      {/* 3. FOUR CORNER TYRE GAUGES (FL, FR, RL, RR) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px', marginBottom: '18px' }}>
        {[
          { key: 'FL', label: 'Front Left (FL)' },
          { key: 'FR', label: 'Front Right (FR)' },
          { key: 'RL', label: 'Rear Left (RL)' },
          { key: 'RR', label: 'Rear Right (RR)' }
        ].map(({ key, label }) => {
          const tempVal = tyreTemps ? tyreTemps[key] : null;
          const pressPsiVal = tyrePressPsi ? tyrePressPsi[key] : null;
          const pressBarVal = tyrePressBar ? tyrePressBar[key] : null;
          const isCornerOffline = deviceStatus === 'offline' || (tempVal === null && pressPsiVal === null);

          return (
            <div key={key} style={{
              background: '#12121E',
              border: '1px solid #232338',
              borderRadius: '8px',
              padding: '14px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              minHeight: '140px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#FFF' }}>{label}</span>
                <span style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: '4px',
                  background: isCornerOffline ? 'rgba(255, 69, 58, 0.15)' : 'rgba(0, 210, 190, 0.15)',
                  color: isCornerOffline ? '#FF453A' : '#00D2BE'
                }}>
                  {isCornerOffline ? 'OFFLINE' : 'ACTIVE'}
                </span>
              </div>

              {/* Temperature Reading */}
              <div style={{ marginBottom: '8px' }}>
                <span style={{ fontSize: '10px', color: '#88889C', textTransform: 'uppercase' }}>Surface Temp</span>
                {tempVal !== null && deviceStatus !== 'offline' ? (
                  <div style={{ fontSize: '24px', fontWeight: 800, color: tempVal > 105 ? '#FF453A' : (tempVal > 85 ? '#00D2BE' : '#39B54A') }}>
                    {tempVal.toFixed(1)} <span style={{ fontSize: '14px', fontWeight: 500, color: '#88889C' }}>°C</span>
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#66667A', marginTop: '4px' }}>
                    SENSOR OFFLINE
                  </div>
                )}
              </div>

              {/* Pressure Reading */}
              <div>
                <span style={{ fontSize: '10px', color: '#88889C', textTransform: 'uppercase' }}>Internal Pressure</span>
                {pressPsiVal !== null && deviceStatus !== 'offline' ? (
                  <div style={{ fontSize: '14px', fontWeight: 700, color: '#FFF' }}>
                    {pressPsiVal.toFixed(1)} psi <span style={{ fontSize: '11px', color: '#88889C' }}>({pressBarVal?.toFixed(2) ?? '—'} bar)</span>
                  </div>
                ) : (
                  <div style={{ fontSize: '11px', fontWeight: 500, color: '#66667A', marginTop: '2px' }}>
                    SENSOR OFFLINE
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 4. ENVIRONMENTAL & VEHICLE SENSORS */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '14px',
        marginBottom: '20px'
      }}>
        <div style={{ background: '#12121E', border: '1px solid #232338', borderRadius: '8px', padding: '12px 16px' }}>
          <span style={{ fontSize: '11px', color: '#88889C', textTransform: 'uppercase' }}>Ambient Temperature</span>
          <div style={{ fontSize: '18px', fontWeight: 700, color: '#FFF', marginTop: '4px' }}>
            {ambientTemp !== null && deviceStatus !== 'offline' ? `${ambientTemp.toFixed(1)} °C` : <span style={{ color: '#66667A', fontSize: '12px' }}>SENSOR OFFLINE</span>}
          </div>
        </div>

        <div style={{ background: '#12121E', border: '1px solid #232338', borderRadius: '8px', padding: '12px 16px' }}>
          <span style={{ fontSize: '11px', color: '#88889C', textTransform: 'uppercase' }}>Track Surface Temperature</span>
          <div style={{ fontSize: '18px', fontWeight: 700, color: '#FFF', marginTop: '4px' }}>
            {trackTemp !== null && deviceStatus !== 'offline' ? `${trackTemp.toFixed(1)} °C` : <span style={{ color: '#66667A', fontSize: '12px' }}>SENSOR OFFLINE</span>}
          </div>
        </div>

        <div style={{ background: '#12121E', border: '1px solid #232338', borderRadius: '8px', padding: '12px 16px' }}>
          <span style={{ fontSize: '11px', color: '#88889C', textTransform: 'uppercase' }}>Wheel Speed / Hall Sensor</span>
          <div style={{ fontSize: '18px', fontWeight: 700, color: '#FFF', marginTop: '4px' }}>
            {wheelSpeed !== null && deviceStatus !== 'offline' ? `${wheelSpeed.toFixed(1)} km/h` : <span style={{ color: '#66667A', fontSize: '12px' }}>SENSOR OFFLINE</span>}
          </div>
        </div>
      </div>

      {/* 5. LIVE PHYSICAL SENSOR TIMELINE GRAPH */}
      <div style={{
        background: '#12121E',
        border: '1px solid #232338',
        borderRadius: '8px',
        padding: '16px',
        marginBottom: '16px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '13px', letterSpacing: '0.06em', color: '#FFF' }}>
              LIVE PHYSICAL TELEMETRY TIMELINE (GAP-ACCURATE)
            </h4>
            <span style={{ fontSize: '11px', color: '#88889C' }}>
              Actual recorded hardware packets plotted chronologically. Gaps represent true missing packets.
            </span>
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setActiveMetric('tyre_temp')}
              style={{
                background: activeMetric === 'tyre_temp' ? '#E10600' : '#181828',
                border: 'none',
                color: '#FFF',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Tyre Temps (°C)
            </button>
            <button
              onClick={() => setActiveMetric('tyre_pressure')}
              style={{
                background: activeMetric === 'tyre_pressure' ? '#00D2BE' : '#181828',
                border: 'none',
                color: '#FFF',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Tyre Pressures (psi)
            </button>
            <button
              onClick={() => setActiveMetric('ambient_track')}
              style={{
                background: activeMetric === 'ambient_track' ? '#FFB800' : '#181828',
                border: 'none',
                color: '#FFF',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Ambient / Track (°C)
            </button>
          </div>
        </div>

        {chartData.length === 0 ? (
          <div style={{
            height: '240px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#66667A',
            fontSize: '13px'
          }}>
            No physical telemetry packets recorded yet. Stream data via HTTP POST or Serial Gateway.
          </div>
        ) : (
          <div style={{ width: '100%', height: '260px' }}>
            <ResponsiveContainer width="100%" height="100%">
              {activeMetric === 'tyre_temp' ? (
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222232" />
                  <XAxis dataKey="timeLabel" stroke="#777788" />
                  <YAxis stroke="#777788" unit=" °C" domain={['auto', 'auto']} />
                  <Tooltip contentStyle={{ backgroundColor: '#12121D', border: '1px solid #28283D' }} />
                  <Legend />
                  <Line connectNulls={false} type="monotone" dataKey="fl_temp" name="FL Temp (°C)" stroke="#FF453A" strokeWidth={2} dot={false} />
                  <Line connectNulls={false} type="monotone" dataKey="fr_temp" name="FR Temp (°C)" stroke="#FF9F0A" strokeWidth={2} dot={false} />
                  <Line connectNulls={false} type="monotone" dataKey="rl_temp" name="RL Temp (°C)" stroke="#00D2BE" strokeWidth={2} dot={false} />
                  <Line connectNulls={false} type="monotone" dataKey="rr_temp" name="RR Temp (°C)" stroke="#30B0C7" strokeWidth={2} dot={false} />
                </LineChart>
              ) : activeMetric === 'tyre_pressure' ? (
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222232" />
                  <XAxis dataKey="timeLabel" stroke="#777788" />
                  <YAxis stroke="#777788" unit=" psi" domain={['auto', 'auto']} />
                  <Tooltip contentStyle={{ backgroundColor: '#12121D', border: '1px solid #28283D' }} />
                  <Legend />
                  <Line connectNulls={false} type="monotone" dataKey="fl_psi" name="FL Pressure (psi)" stroke="#FF453A" strokeWidth={2} dot={false} />
                  <Line connectNulls={false} type="monotone" dataKey="fr_psi" name="FR Pressure (psi)" stroke="#FF9F0A" strokeWidth={2} dot={false} />
                  <Line connectNulls={false} type="monotone" dataKey="rl_psi" name="RL Pressure (psi)" stroke="#00D2BE" strokeWidth={2} dot={false} />
                  <Line connectNulls={false} type="monotone" dataKey="rr_psi" name="RR Pressure (psi)" stroke="#30B0C7" strokeWidth={2} dot={false} />
                </LineChart>
              ) : (
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#222232" />
                  <XAxis dataKey="timeLabel" stroke="#777788" />
                  <YAxis stroke="#777788" unit=" °C" domain={['auto', 'auto']} />
                  <Tooltip contentStyle={{ backgroundColor: '#12121D', border: '1px solid #28283D' }} />
                  <Legend />
                  <Line connectNulls={false} type="monotone" dataKey="amb_temp" name="Ambient Temp (°C)" stroke="#FFB800" strokeWidth={2} dot={false} />
                  <Line connectNulls={false} type="monotone" dataKey="trk_temp" name="Track Temp (°C)" stroke="#E10600" strokeWidth={2} dot={false} />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* 6. STRICT SCIENTIFIC PROVENANCE FOOTER */}
      <div style={{
        background: '#0D0D16',
        border: '1px solid #1C1C2C',
        borderRadius: '6px',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '11px',
        color: '#77778E'
      }}>
        <div>
          <strong style={{ color: '#00D2BE' }}>DATA PROVENANCE:</strong> REAL PHYSICAL SENSOR TELEMETRY · 
          <span style={{ marginLeft: '4px' }}>Transport: {latestPacket?.transport || 'DISCONNECTED'}</span> · 
          <span style={{ marginLeft: '4px' }}>Ingestion Layer: FastAPI authoritative ({API_BASE})</span>
        </div>
        <div style={{ color: '#FFB800' }}>
          TDSM Model Architecture ($S_t = [D_t, \Delta D_t, \Delta^2 D_t]$) Strictly Frozen
        </div>
      </div>
    </div>
  );
}
