import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Terminal,
  Globe,
  Shield,
  Crosshair,
  ShoppingBag,
  Activity,
  Settings,
  Bell,
  LogOut,
  Play,
  Lock,
  Unlock,
  Send,
  Users,
  Award,
  Zap,
  AlertTriangle,
  Cpu,
  RefreshCw,
  ChevronRight,
  Layers
} from 'lucide-react';
import { RootWarsCrest } from './components/RootWarsCrest.js';
import { WindowFrame, WindowGeometry } from './components/WindowFrame.js';
import {
  APPROVED_NMAP_PROFILES,
  COMMAND_HELP_CATALOG,
  getCommandAutocompleteSuggestions
} from '../shared/commandParser.js';

type AppId =
  | 'terminal'
  | 'map'
  | 'missions'
  | 'social'
  | 'market'
  | 'intel'
  | 'settings';

interface TerminalLine {
  id: string;
  ts: string;
  type: 'cmd' | 'out' | 'lab' | 'err' | 'sys';
  text: string;
}

interface NotificationItem {
  id: string;
  ts: string;
  title: string;
  detail: string;
  severity: 'info' | 'success' | 'warn';
}

const DEFAULT_WINDOWS: Record<
  AppId,
  { title: string; subtitle: string; open: boolean; minimized: boolean; z: number; geom: WindowGeometry }
> = {
  terminal: {
    title: 'rw-term // Operator Terminal',
    subtitle: 'Typed Command Shell & Isolated Lab Interface',
    open: true,
    minimized: false,
    z: 30,
    geom: { x: 24, y: 18, w: 720, h: 490 }
  },
  map: {
    title: 'net-atlas // Regional Grid Topology',
    subtitle: 'Neo-Cascadia Autonomous Grid',
    open: true,
    minimized: false,
    z: 20,
    geom: { x: 760, y: 18, w: 620, h: 490 }
  },
  missions: {
    title: 'ops-center // Contracts & Isolated Labs',
    subtitle: 'Real-Nmap 10.240.x.x Sandboxes',
    open: false,
    minimized: false,
    z: 15,
    geom: { x: 110, y: 48, w: 840, h: 540 }
  },
  social: {
    title: 'syndicate-hq // Groups, Alliances & Open PvP',
    subtitle: 'Diplomacy, Defenses, Bounties & Comms',
    open: false,
    minimized: false,
    z: 14,
    geom: { x: 140, y: 56, w: 880, h: 560 }
  },
  market: {
    title: 'nexus-market // Equipment & RWC Ledger',
    subtitle: 'Atomic Double-Entry Economy',
    open: false,
    minimized: false,
    z: 13,
    geom: { x: 180, y: 64, w: 820, h: 530 }
  },
  intel: {
    title: 'intel-watch // Factions, Events & Audit History',
    subtitle: 'NPC Reactions & Incident Forensics',
    open: false,
    minimized: false,
    z: 12,
    geom: { x: 200, y: 70, w: 860, h: 550 }
  },
  settings: {
    title: 'sys-config // Manual & Lab Isolation Architecture',
    subtitle: 'ROOTWARS OS v2.6 Reference',
    open: false,
    minimized: false,
    z: 11,
    geom: { x: 240, y: 80, w: 760, h: 510 }
  }
};

export const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('rw_token'));
  const [operator, setOperator] = useState<any | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [usernameInput, setUsernameInput] = useState('cipher_wolf');
  const [passwordInput, setPasswordInput] = useState('RootWars!2026');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  // Desktop Windows state
  const [windows, setWindows] = useState(DEFAULT_WINDOWS);
  const [focusedApp, setFocusedApp] = useState<AppId>('terminal');
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [clock, setClock] = useState<string>(() => new Date().toISOString().slice(11, 19) + ' UTC');

  // Terminal state
  const [termLines, setTermLines] = useState<TerminalLine[]>([
    {
      id: 'init-1',
      ts: new Date().toISOString().slice(11, 19),
      type: 'sys',
      text: 'ROOTWARS OS v2.6 // Persistent Open-World Hacking MMO Desktop'
    },
    {
      id: 'init-2',
      ts: new Date().toISOString().slice(11, 19),
      type: 'sys',
      text: 'NOTICE: Browser desktop simulation. Real Nmap executes strictly in disposable non-root 10.240.x.x lab sandboxes.'
    },
    {
      id: 'init-3',
      ts: new Date().toISOString().slice(11, 19),
      type: 'sys',
      text: 'Type `help`, `status`, `map`, `jobs`, or `lab list` to begin. Press TAB for autocomplete.'
    }
  ]);
  const [cmdInput, setCmdInput] = useState('');
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const [termBusy, setTermBusy] = useState(false);
  const termBottomRef = useRef<HTMLDivElement | null>(null);

  // World Map state
  const [selectedRegion, setSelectedRegion] = useState('neo-cascadia');
  const [mapData, setMapData] = useState<any | null>(null);
  const [selectedNode, setSelectedNode] = useState<any | null>(null);

  // Missions & Lab state
  const [missionsData, setMissionsData] = useState<any | null>(null);

  // Social / Groups / Alliances / PvP state
  const [socialData, setSocialData] = useState<any | null>(null);
  const [socialTab, setSocialTab] = useState<'pvp' | 'groups' | 'alliances' | 'chat'>('pvp');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupTag, setNewGroupTag] = useState('');
  const [newAllianceName, setNewAllianceName] = useState('');
  const [newAllianceTag, setNewAllianceTag] = useState('');
  const [bountyNodeId, setBountyNodeId] = useState('node-pvp-nyx');
  const [bountyAmount, setBountyAmount] = useState('500');
  const [bountyReason, setBountyReason] = useState('Syndicate retaliation contract');

  // Economy / Market / Ledger state
  const [economyData, setEconomyData] = useState<any | null>(null);
  const [transferTo, setTransferTo] = useState('kestrel_9');
  const [transferAmount, setTransferAmount] = useState('250');
  const [transferMemo, setTransferMemo] = useState('Intel split');

  // Intel / Factions / Events / Audit state
  const [intelData, setIntelData] = useState<any | null>(null);
  const [intelTab, setIntelTab] = useState<'factions' | 'events' | 'incidents' | 'audit'>('factions');

  // Chat state
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatChannel, setChatChannel] = useState<'global' | 'group' | 'alliance'>('global');
  const [chatInput, setChatInput] = useState('');

  const addNotification = useCallback(
    (title: string, detail: string, severity: 'info' | 'success' | 'warn' = 'info') => {
      setNotifications((prev) => [
        {
          id: `${Date.now()}-${Math.random()}`,
          ts: new Date().toISOString().slice(11, 19),
          title,
          detail,
          severity
        },
        ...prev.slice(0, 19)
      ]);
    },
    []
  );

  const apiFetch = useCallback(
    async (url: string, options: RequestInit = {}) => {
      const headers: Record<string, string> = {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...((options.headers as Record<string, string>) ?? {})
      };
      const res = await fetch(url, {
        ...options,
        headers,
        credentials: 'include'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || `HTTP ${res.status}`);
      }
      return data;
    },
    [token]
  );

  const refreshAllData = useCallback(async () => {
    if (!token) return;
    try {
      const [meRes, mapRes, msnRes, socRes, ecoRes, intRes, chatRes] = await Promise.all([
        apiFetch('/api/auth/me'),
        apiFetch(`/api/world/map?region=${selectedRegion}`),
        apiFetch('/api/missions'),
        apiFetch('/api/social/overview'),
        apiFetch('/api/economy/overview'),
        apiFetch('/api/intel/overview'),
        apiFetch('/api/chat')
      ]);
      setOperator(meRes.operator);
      setMapData(mapRes);
      setMissionsData(msnRes);
      setSocialData(socRes);
      setEconomyData(ecoRes);
      setIntelData(intRes);
      setChatMessages(chatRes.messages ?? []);
    } catch (err: any) {
      if (String(err?.message).includes('Valid operator session')) {
        setToken(null);
        localStorage.removeItem('rw_token');
      }
    }
  }, [apiFetch, selectedRegion, token]);

  useEffect(() => {
    const t = setInterval(() => {
      setClock(new Date().toISOString().slice(11, 19) + ' UTC');
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (token) {
      refreshAllData();
    }
  }, [token, selectedRegion, refreshAllData]);

  // WebSocket connection for live chat, alerts, PvP incidents, and world updates
  useEffect(() => {
    if (!token) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'chat_message') {
          setChatMessages((prev) => {
            if (prev.some((m) => m.id === msg.payload.id)) return prev;
            return [...prev.slice(-49), msg.payload];
          });
        } else if (msg.type === 'mission_completed') {
          addNotification(
            `Contract Completed: ${msg.payload.code}`,
            `${msg.payload.username} completed "${msg.payload.title}" (+${msg.payload.rewardRwc} RWC)`,
            'success'
          );
        } else if (msg.type === 'pvp_incident') {
          addNotification(
            `Open PvP Alert: ${msg.payload.targetNodeName}`,
            msg.payload.summary,
            'warn'
          );
          refreshAllData();
        } else if (msg.type === 'world_event') {
          addNotification(
            `World Event: ${msg.payload.title}`,
            msg.payload.description,
            'info'
          );
          refreshAllData();
        }
      } catch {}
    };

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);

    return () => {
      clearInterval(pingInterval);
      ws.close();
    };
  }, [token, addNotification, refreshAllData]);

  useEffect(() => {
    termBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [termLines]);

  const openAndFocusApp = (id: AppId) => {
    setWindows((prev) => {
      const maxZ = Math.max(...Object.values(prev).map((w) => w.z), 20);
      return {
        ...prev,
        [id]: {
          ...prev[id],
          open: true,
          minimized: false,
          z: maxZ + 1
        }
      };
    });
    setFocusedApp(id);
    setLauncherOpen(false);
  };

  const closeApp = (id: string) => {
    setWindows((prev) => ({
      ...prev,
      [id as AppId]: { ...prev[id as AppId], open: false }
    }));
  };

  const minimizeApp = (id: string) => {
    setWindows((prev) => ({
      ...prev,
      [id as AppId]: { ...prev[id as AppId], minimized: true }
    }));
  };

  const runTerminalCommand = async (rawCmd: string) => {
    const trimmed = rawCmd.trim();
    if (!trimmed) return;

    const nowTs = new Date().toISOString().slice(11, 19);
    setTermLines((prev) => [
      ...prev,
      {
        id: `cmd-${Date.now()}-${Math.random()}`,
        ts: nowTs,
        type: 'cmd',
        text: `${operator?.username ?? 'operator'}@rootwars:~$ ${trimmed}`
      }
    ]);
    setCmdHistory((prev) => [trimmed, ...prev.slice(0, 49)]);
    setHistoryIdx(-1);
    setCmdInput('');
    setTermBusy(true);

    try {
      const res = await apiFetch('/api/terminal/exec', {
        method: 'POST',
        body: JSON.stringify({ command: trimmed })
      });

      if (res.clearScreen) {
        setTermLines([]);
      } else {
        const lineType: TerminalLine['type'] = !res.ok
          ? 'err'
          : res.category === 'lab_tool'
            ? 'lab'
            : 'out';

        setTermLines((prev) => [
          ...prev,
          ...(res.lines || []).map((l: string, idx: number) => ({
            id: `out-${Date.now()}-${idx}`,
            ts: nowTs,
            type: lineType,
            text: l
          }))
        ]);
      }

      if (res.operator) {
        setOperator(res.operator);
      }
      await refreshAllData();
    } catch (err: any) {
      setTermLines((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          ts: nowTs,
          type: 'err',
          text: `[EXEC_ERROR] ${err?.message ?? String(err)}`
        }
      ]);
    } finally {
      setTermBusy(false);
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);
    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const data = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          username: usernameInput.trim(),
          password: passwordInput
        })
      });
      setToken(data.token);
      localStorage.setItem('rw_token', data.token);
      setOperator(data.operator);
    } catch (err: any) {
      setAuthError(err?.message ?? 'Authentication failed.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    localStorage.removeItem('rw_token');
    setToken(null);
    setOperator(null);
  };

  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    try {
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          channelType: chatChannel,
          message: chatInput.trim()
        })
      });
      setChatInput('');
      if (res.message) {
        setChatMessages((prev) => {
          if (prev.some((m) => m.id === res.message.id)) return prev;
          return [...prev, res.message];
        });
      }
    } catch (err: any) {
      addNotification('Comms Error', err?.message ?? 'Failed to send chat', 'warn');
    }
  };

  // =========================================================================
  // LOGIN / REGISTRATION SCREEN
  // =========================================================================
  if (!token || !operator) {
    return (
      <div
        className="rw-desktop-wallpaper"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '16px'
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: '460px',
            background: 'rgba(10, 17, 30, 0.96)',
            border: '1px solid #0284c7',
            borderRadius: '8px',
            padding: '28px',
            boxShadow: '0 25px 60px rgba(0, 0, 0, 0.85), 0 0 28px rgba(0, 168, 255, 0.2)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '18px' }}>
            <RootWarsCrest size={52} />
            <div>
              <div
                style={{
                  fontSize: '22px',
                  fontWeight: 800,
                  letterSpacing: '0.08em',
                  color: '#f8fafc'
                }}
              >
                ROOT<span style={{ color: '#38bdf8' }}>WARS</span>
              </div>
              <div
                style={{
                  fontSize: '11.5px',
                  color: '#38bdf8',
                  fontFamily: 'var(--rw-font-mono)'
                }}
              >
                PERSISTENT OPEN-WORLD HACKING MMO // OS v2.6
              </div>
            </div>
          </div>

          <div
            style={{
              background: 'rgba(14, 165, 233, 0.08)',
              border: '1px solid rgba(56, 189, 248, 0.25)',
              borderRadius: '6px',
              padding: '10px 12px',
              fontSize: '11.5px',
              color: '#cbd5e1',
              lineHeight: 1.45,
              marginBottom: '18px'
            }}
          >
            <strong>Original RootWars Browser Desktop:</strong> Inspired by dark security workstation layouts.
            RootWars is an independent fictional MMO, not affiliated with Kali Linux, and never exposes your
            personal device. Real Nmap runs strictly against isolated <code>10.240.x.x</code> lab targets.
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
            <button
              type="button"
              className={`rw-btn ${authMode === 'login' ? 'rw-btn-primary' : ''}`}
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => {
                setAuthMode('login');
                setAuthError(null);
              }}
            >
              Operator Login
            </button>
            <button
              type="button"
              className={`rw-btn ${authMode === 'register' ? 'rw-btn-primary' : ''}`}
              style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => {
                setAuthMode('register');
                setUsernameInput('');
                setPasswordInput('');
                setAuthError(null);
              }}
            >
              Register New Handle
            </button>
          </div>

          <form onSubmit={handleAuthSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '11px',
                  fontFamily: 'var(--rw-font-mono)',
                  color: '#94a3b8',
                  marginBottom: '4px'
                }}
              >
                OPERATOR HANDLE
              </label>
              <input
                type="text"
                className="rw-input"
                style={{ width: '100%' }}
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                placeholder="e.g. cipher_wolf"
                required
              />
            </div>

            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '11px',
                  fontFamily: 'var(--rw-font-mono)',
                  color: '#94a3b8',
                  marginBottom: '4px'
                }}
              >
                PASSPHRASE
              </label>
              <input
                type="password"
                className="rw-input"
                style={{ width: '100%' }}
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Minimum 8 characters"
                required
              />
            </div>

            {authError && (
              <div
                style={{
                  background: 'rgba(244, 63, 94, 0.15)',
                  border: '1px solid #f43f5e',
                  borderRadius: '4px',
                  padding: '8px 10px',
                  color: '#fda4af',
                  fontSize: '12px'
                }}
              >
                {authError}
              </div>
            )}

            <button
              type="submit"
              className="rw-btn rw-btn-primary"
              style={{ justifyContent: 'center', padding: '10px', fontSize: '13px', marginTop: '4px' }}
              disabled={authLoading}
            >
              {authLoading
                ? 'Authenticating Session...'
                : authMode === 'login'
                  ? 'Initialize RootWars Desktop'
                  : 'Provision Operator & Home Bastion (2,500 RWC)'}
            </button>
          </form>

          <div
            style={{
              marginTop: '16px',
              paddingTop: '12px',
              borderTop: '1px solid #1e2f4d',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '11px',
              color: '#94a3b8'
            }}
          >
            <span>Seeded Demo Operator:</span>
            <button
              type="button"
              className="rw-btn"
              style={{ padding: '4px 8px', fontSize: '11px' }}
              onClick={() => {
                setAuthMode('login');
                setUsernameInput('cipher_wolf');
                setPasswordInput('RootWars!2026');
              }}
            >
              Fill cipher_wolf / RootWars!2026
            </button>
          </div>
        </div>
      </div>
    );
  }

  const autocompleteSuggestions = getCommandAutocompleteSuggestions(cmdInput);

  // Category color helper for World Map
  const categoryColor = (cat: string) => {
    switch (cat) {
      case 'government':
        return '#38bdf8';
      case 'banking':
        return '#10b981';
      case 'exchange':
        return '#f59e0b';
      case 'corporate':
        return '#a855f7';
      case 'media':
        return '#ec4899';
      case 'logistics':
        return '#14b8a6';
      case 'infrastructure':
        return '#0ea5e9';
      case 'security':
        return '#f43f5e';
      case 'criminal':
        return '#ef4444';
      case 'player':
        return '#22d3ee';
      default:
        return '#64748b';
    }
  };

  return (
    <div className="rw-desktop-wallpaper" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* ===================================================================
          TOP STATUS PANEL
         =================================================================== */}
      <header className="rw-top-panel">
        {/* Left: Application Launcher & Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            type="button"
            className="rw-btn rw-btn-primary"
            style={{ padding: '4px 10px', height: '28px' }}
            onClick={() => setLauncherOpen((o) => !o)}
            data-testid="app-launcher-btn"
          >
            <RootWarsCrest size={18} />
            <span>Applications</span>
          </button>

          <span
            style={{
              fontFamily: 'var(--rw-font-mono)',
              fontSize: '11.5px',
              color: '#38bdf8',
              fontWeight: 700
            }}
          >
            ROOTWARS//OS
          </span>

          {/* Active Node & Lab Indicators */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginLeft: '8px',
              fontFamily: 'var(--rw-font-mono)',
              fontSize: '11px'
            }}
          >
            <span
              className="rw-badge"
              style={{
                background: 'rgba(14, 165, 233, 0.15)',
                border: '1px solid #0284c7',
                color: '#7dd3fc'
              }}
            >
              NODE: {operator.connectedNode ? operator.connectedNode.hostname : 'DISCONNECTED'}
            </span>

            {operator.activeLabSession && (
              <span
                className="rw-badge"
                style={{
                  background: 'rgba(16, 185, 129, 0.18)',
                  border: '1px solid #10b981',
                  color: '#6ee7b7'
                }}
              >
                LAB TARGET: {operator.activeLabSession.target_ip} [{operator.activeLabSession.mission_code}]
              </span>
            )}
          </div>
        </div>

        {/* Right: Telemetry, Balance, Heat, Notifications, Clock, Logout */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px' }}>
          <span
            className="rw-badge"
            style={{
              background: 'rgba(16, 185, 129, 0.14)',
              border: '1px solid rgba(16, 185, 129, 0.4)',
              color: '#34d399'
            }}
            data-testid="status-rwc-balance"
          >
            {Number(operator.balanceRwc ?? 0).toLocaleString()} RWC
          </span>

          <span
            className="rw-badge"
            style={{
              background:
                operator.heat >= 60 ? 'rgba(244, 63, 94, 0.2)' : 'rgba(245, 158, 11, 0.14)',
              border: `1px solid ${operator.heat >= 60 ? '#f43f5e' : '#f59e0b'}`,
              color: operator.heat >= 60 ? '#fda4af' : '#fcd34d'
            }}
          >
            HEAT: {operator.heat}/100
          </span>

          <span
            className="rw-badge"
            style={{
              background: 'rgba(56, 189, 248, 0.12)',
              border: '1px solid #1e3a5f',
              color: '#e2e8f0'
            }}
          >
            {operator.username} [L{operator.level}] {operator.group ? `[${operator.group.tag}]` : ''}
          </span>

          <span
            style={{
              fontFamily: 'var(--rw-font-mono)',
              fontSize: '11px',
              color: '#94a3b8'
            }}
          >
            ONLINE: {operator.onlineCount ?? 4}
          </span>

          <button
            type="button"
            className="rw-btn"
            style={{ padding: '4px 8px', position: 'relative' }}
            onClick={() => setNotifOpen((n) => !n)}
            title="Alerts & Notifications"
          >
            <Bell size={14} />
            {notifications.length > 0 && (
              <span
                style={{
                  background: '#0ea5e9',
                  color: '#fff',
                  borderRadius: '999px',
                  fontSize: '9px',
                  padding: '0 4px',
                  fontWeight: 700
                }}
              >
                {notifications.length}
              </span>
            )}
          </button>

          <span
            style={{
              fontFamily: 'var(--rw-font-mono)',
              fontSize: '11.5px',
              color: '#cbd5e1'
            }}
          >
            {clock}
          </span>

          <button
            type="button"
            className="rw-btn rw-btn-danger"
            style={{ padding: '4px 8px' }}
            onClick={handleLogout}
            title="Logout Session"
          >
            <LogOut size={13} />
          </button>
        </div>
      </header>

      {/* Application Launcher Dropdown Menu */}
      {launcherOpen && (
        <div
          style={{
            position: 'absolute',
            top: '42px',
            left: '10px',
            width: '310px',
            background: '#0c1526',
            border: '1px solid #0284c7',
            borderRadius: '6px',
            padding: '10px',
            zIndex: 9500,
            boxShadow: '0 20px 45px rgba(0, 0, 0, 0.85)'
          }}
        >
          <div
            style={{
              fontSize: '10.5px',
              fontFamily: 'var(--rw-font-mono)',
              color: '#38bdf8',
              marginBottom: '8px',
              paddingBottom: '6px',
              borderBottom: '1px solid #1e3354'
            }}
          >
            ROOTWARS APPLICATION SUITE
          </div>
          {(
            [
              { id: 'terminal', label: 'Operator Terminal (rw-term)', icon: <Terminal size={15} /> },
              { id: 'map', label: 'World Map & Topology (net-atlas)', icon: <Globe size={15} /> },
              { id: 'missions', label: 'Missions & Isolated Labs (ops-center)', icon: <Crosshair size={15} /> },
              { id: 'social', label: 'Groups, Alliances & Open PvP (syndicate-hq)', icon: <Users size={15} /> },
              { id: 'market', label: 'Market & Transactional Ledger (nexus-market)', icon: <ShoppingBag size={15} /> },
              { id: 'intel', label: 'Intel, Factions & Audit History (intel-watch)', icon: <Activity size={15} /> },
              { id: 'settings', label: 'Settings, Manual & Lab Safety (sys-config)', icon: <Settings size={15} /> }
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => openAndFocusApp(item.id)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '8px 10px',
                background: focusedApp === item.id ? 'rgba(14, 165, 233, 0.16)' : 'transparent',
                border: 'none',
                borderRadius: '4px',
                color: '#e2e8f0',
                fontSize: '12.5px',
                cursor: 'pointer',
                textAlign: 'left'
              }}
            >
              <span style={{ color: '#38bdf8' }}>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Notifications Drawer */}
      {notifOpen && (
        <div
          style={{
            position: 'absolute',
            top: '42px',
            right: '14px',
            width: '340px',
            maxHeight: '420px',
            overflowY: 'auto',
            background: '#0c1526',
            border: '1px solid #0284c7',
            borderRadius: '6px',
            padding: '12px',
            zIndex: 9500,
            boxShadow: '0 20px 45px rgba(0, 0, 0, 0.85)'
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '8px',
              paddingBottom: '6px',
              borderBottom: '1px solid #1e3354',
              fontSize: '11px',
              fontFamily: 'var(--rw-font-mono)',
              color: '#38bdf8'
            }}
          >
            <span>SYSTEM & GRID NOTIFICATIONS</span>
            <button
              type="button"
              className="rw-btn"
              style={{ padding: '2px 6px', fontSize: '10px' }}
              onClick={() => setNotifications([])}
            >
              Clear
            </button>
          </div>
          {notifications.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#64748b', padding: '12px 0' }}>
              No recent alerts.
            </div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                style={{
                  padding: '8px',
                  borderBottom: '1px solid #16243d',
                  fontSize: '11.5px'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                  <span style={{ color: '#38bdf8' }}>{n.title}</span>
                  <span style={{ color: '#64748b', fontSize: '10px' }}>{n.ts}</span>
                </div>
                <div style={{ color: '#cbd5e1', marginTop: '3px' }}>{n.detail}</div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ===================================================================
          DESKTOP WORKSPACE CANVAS
         =================================================================== */}
      <main style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* -----------------------------------------------------------------
            WINDOW 1: TERMINAL (OPEN BY DEFAULT)
           ----------------------------------------------------------------- */}
        <WindowFrame
          id="terminal"
          title={windows.terminal.title}
          subtitle={windows.terminal.subtitle}
          icon={<Terminal size={15} />}
          isOpen={windows.terminal.open}
          isMinimized={windows.terminal.minimized}
          isFocused={focusedApp === 'terminal'}
          zIndex={windows.terminal.z}
          initialGeometry={windows.terminal.geom}
          onFocus={(id) => openAndFocusApp(id as AppId)}
          onClose={closeApp}
          onMinimize={minimizeApp}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              background: '#050911'
            }}
          >
            {/* Mobile-friendly Quick Command Bar */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '5px',
                padding: '6px 10px',
                background: '#0a1220',
                borderBottom: '1px solid #172742'
              }}
            >
              {[
                { label: 'status', cmd: 'status' },
                { label: 'map', cmd: 'map --region neo-cascadia' },
                { label: 'jobs', cmd: 'jobs' },
                { label: 'lab list', cmd: 'lab list' },
                { label: 'open LAB-01', cmd: 'lab open --mission msn-lab-01' },
                { label: 'nmap service', cmd: 'nmap --profile service' },
                { label: 'factions', cmd: 'factions' },
                { label: 'events', cmd: 'events' },
                { label: 'help', cmd: 'help' }
              ].map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  className="rw-btn"
                  style={{ padding: '2px 7px', fontSize: '11px', fontFamily: 'var(--rw-font-mono)' }}
                  onClick={() => runTerminalCommand(chip.cmd)}
                >
                  $ {chip.label}
                </button>
              ))}
            </div>

            {/* Terminal Output Viewport */}
            <div
              className="rw-terminal-output"
              style={{
                flex: 1,
                padding: '12px',
                overflowY: 'auto'
              }}
              data-testid="terminal-output"
            >
              {termLines.map((line) => {
                let color = '#cbd5e1';
                if (line.type === 'cmd') color = '#38bdf8';
                else if (line.type === 'lab') color = '#34d399';
                else if (line.type === 'err') color = '#fb7185';
                else if (line.type === 'sys') color = '#93c5fd';

                return (
                  <div key={line.id} style={{ color, marginBottom: '2px' }}>
                    {line.text}
                  </div>
                );
              })}
              <div ref={termBottomRef} />
            </div>

            {/* Autocomplete Suggestion Bar */}
            {cmdInput.trim().length > 0 && autocompleteSuggestions.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 10px',
                  background: '#091324',
                  borderTop: '1px solid #162947',
                  overflowX: 'auto',
                  fontSize: '11px',
                  fontFamily: 'var(--rw-font-mono)'
                }}
              >
                <span style={{ color: '#64748b' }}>TAB:</span>
                {autocompleteSuggestions.map((sug) => (
                  <button
                    key={sug}
                    type="button"
                    onClick={() => setCmdInput(sug)}
                    style={{
                      background: 'rgba(14, 165, 233, 0.14)',
                      border: '1px solid #0284c7',
                      color: '#7dd3fc',
                      borderRadius: '3px',
                      padding: '1px 6px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontFamily: 'var(--rw-font-mono)',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {sug}
                  </button>
                ))}
              </div>
            )}

            {/* Command Input Prompt */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                runTerminalCommand(cmdInput);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 10px',
                background: '#0b1424',
                borderTop: '1px solid #1e3354'
              }}
            >
              <span
                style={{
                  color: '#38bdf8',
                  fontFamily: 'var(--rw-font-mono)',
                  fontSize: '12.5px',
                  fontWeight: 700,
                  whiteSpace: 'nowrap'
                }}
              >
                {operator.username}@rootwars:~$
              </span>
              <input
                type="text"
                value={cmdInput}
                onChange={(e) => setCmdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    if (autocompleteSuggestions.length > 0) {
                      setCmdInput(autocompleteSuggestions[0]);
                    }
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (cmdHistory.length > 0) {
                      const nextIdx = Math.min(cmdHistory.length - 1, historyIdx + 1);
                      setHistoryIdx(nextIdx);
                      setCmdInput(cmdHistory[nextIdx]);
                    }
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (historyIdx > 0) {
                      const nextIdx = historyIdx - 1;
                      setHistoryIdx(nextIdx);
                      setCmdInput(cmdHistory[nextIdx]);
                    } else {
                      setHistoryIdx(-1);
                      setCmdInput('');
                    }
                  }
                }}
                placeholder={
                  termBusy
                    ? 'Executing command in isolated worker...'
                    : 'Enter command (e.g., help, status, lab open --mission msn-lab-01, nmap --profile service)...'
                }
                disabled={termBusy}
                data-testid="terminal-input"
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: '#f8fafc',
                  fontFamily: 'var(--rw-font-mono)',
                  fontSize: '13px'
                }}
              />
              <button type="submit" className="rw-btn rw-btn-primary" disabled={termBusy}>
                Run
              </button>
            </form>
          </div>
        </WindowFrame>

        {/* -----------------------------------------------------------------
            WINDOW 2: WORLD MAP (net-atlas)
           ----------------------------------------------------------------- */}
        <WindowFrame
          id="map"
          title={windows.map.title}
          subtitle={`${mapData?.discoveredCount ?? 0}/${mapData?.totalCount ?? 24} Nodes Discovered`}
          icon={<Globe size={15} />}
          isOpen={windows.map.open}
          isMinimized={windows.map.minimized}
          isFocused={focusedApp === 'map'}
          zIndex={windows.map.z}
          initialGeometry={windows.map.geom}
          onFocus={(id) => openAndFocusApp(id as AppId)}
          onClose={closeApp}
          onMinimize={minimizeApp}
        >
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Map Toolbar */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 12px',
                background: '#0a1220',
                borderBottom: '1px solid #172742',
                fontSize: '12px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: '#94a3b8' }}>Region:</span>
                <select
                  className="rw-input"
                  style={{ padding: '4px 8px', fontSize: '12px' }}
                  value={selectedRegion}
                  onChange={(e) => {
                    setSelectedRegion(e.target.value);
                    setSelectedNode(null);
                  }}
                >
                  <option value="neo-cascadia">Neo-Cascadia Autonomous Grid (24 Nodes)</option>
                  <option value="helvetia-haven">Helvetia Quantum Clearing Zone (3 Nodes)</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                <span style={{ color: '#38bdf8' }}>
                  Threat: {mapData?.currentRegion?.threat_index ?? 42}/100
                </span>
                <span style={{ color: '#10b981' }}>
                  Tariff: {mapData?.currentRegion?.market_multiplier ?? 1.0}x
                </span>
              </div>
            </div>

            {/* Interactive SVG Topology & Node Inspector */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              <div style={{ flex: 1, position: 'relative', background: '#060b14' }}>
                <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
                  {/* Edges between nodes */}
                  {(mapData?.nodes ?? []).map((node: any) =>
                    (node.adjacent_nodes ?? []).map((adjId: string) => {
                      const target = (mapData?.nodes ?? []).find((n: any) => n.id === adjId);
                      if (!target) return null;
                      return (
                        <line
                          key={`${node.id}-${adjId}`}
                          x1={node.pos_x}
                          y1={node.pos_y}
                          x2={target.pos_x}
                          y2={target.pos_y}
                          stroke={node.discovered && target.discovered ? '#1e3a5f' : '#0f172a'}
                          strokeWidth="0.4"
                        />
                      );
                    })
                  )}

                  {/* Nodes */}
                  {(mapData?.nodes ?? []).map((node: any) => {
                    const isConn = operator.connectedNode?.id === node.id;
                    const isSelected = selectedNode?.id === node.id;
                    const col = node.discovered ? categoryColor(node.category) : '#334155';

                    return (
                      <g
                        key={node.id}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setSelectedNode(node)}
                      >
                        {isConn && (
                          <circle
                            cx={node.pos_x}
                            cy={node.pos_y}
                            r="3.8"
                            fill="none"
                            stroke="#38bdf8"
                            strokeWidth="0.4"
                            strokeDasharray="1 0.8"
                          />
                        )}
                        <circle
                          cx={node.pos_x}
                          cy={node.pos_y}
                          r={isSelected ? '2.6' : '2.0'}
                          fill={col}
                          stroke={isSelected ? '#ffffff' : '#090d16'}
                          strokeWidth="0.45"
                        />
                        <text
                          x={node.pos_x}
                          y={node.pos_y + 4.2}
                          textAnchor="middle"
                          fill={node.discovered ? '#cbd5e1' : '#475569'}
                          fontSize="2.2"
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {node.discovered ? node.hostname.split('.')[0] : '???'}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Right Sidebar: Selected Node Details */}
              <div
                style={{
                  width: '245px',
                  borderLeft: '1px solid #172742',
                  background: '#0a1220',
                  padding: '10px',
                  overflowY: 'auto',
                  fontSize: '12px'
                }}
              >
                {selectedNode ? (
                  <div>
                    <div
                      style={{
                        fontSize: '10.5px',
                        fontFamily: 'var(--rw-font-mono)',
                        color: categoryColor(selectedNode.category),
                        textTransform: 'uppercase',
                        fontWeight: 700
                      }}
                    >
                      {selectedNode.category} // TIER {selectedNode.tier}
                    </div>
                    <div style={{ fontWeight: 700, fontSize: '13.5px', marginTop: '2px' }}>
                      {selectedNode.name}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--rw-font-mono)',
                        fontSize: '11px',
                        color: '#38bdf8',
                        marginTop: '2px'
                      }}
                    >
                      {selectedNode.hostname} ({selectedNode.ip_address})
                    </div>

                    <div
                      style={{
                        marginTop: '8px',
                        fontSize: '11.5px',
                        color: '#94a3b8',
                        lineHeight: 1.4
                      }}
                    >
                      {selectedNode.description}
                    </div>

                    <div
                      style={{
                        marginTop: '10px',
                        padding: '8px',
                        background: '#060c17',
                        borderRadius: '4px',
                        border: '1px solid #162642',
                        fontFamily: 'var(--rw-font-mono)',
                        fontSize: '11px'
                      }}
                    >
                      <div>Status: {String(selectedNode.status).toUpperCase()}</div>
                      <div>Security: {selectedNode.security_level}/100</div>
                      <div>Patch Lvl: {selectedNode.patch_level}%</div>
                      {selectedNode.faction_name && <div>Faction: {selectedNode.faction_code}</div>}
                      {selectedNode.owner_handle && <div>Owner: {selectedNode.owner_handle}</div>}
                    </div>

                    {selectedNode.discovered && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px' }}>
                        <button
                          type="button"
                          className="rw-btn rw-btn-primary"
                          style={{ width: '100%', justifyContent: 'center' }}
                          onClick={() => runTerminalCommand(`connect --target ${selectedNode.id}`)}
                        >
                          Connect Terminal
                        </button>
                        <button
                          type="button"
                          className="rw-btn"
                          style={{ width: '100%', justifyContent: 'center' }}
                          onClick={() => runTerminalCommand(`inspect --target ${selectedNode.id}`)}
                        >
                          Inspect & Discover Neighbors
                        </button>
                        {selectedNode.category === 'player' &&
                          selectedNode.owner_user_id !== operator.id && (
                            <button
                              type="button"
                              className="rw-btn rw-btn-danger"
                              style={{ width: '100%', justifyContent: 'center' }}
                              onClick={() =>
                                runTerminalCommand(
                                  `pvp attack --target ${selectedNode.id} --method heist`
                                )
                              }
                            >
                              Launch PvP Heist
                            </button>
                          )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ color: '#64748b', fontSize: '11.5px' }}>
                    Click any node on the regional topology map to inspect its security posture,
                    services, and routing links.
                  </div>
                )}
              </div>
            </div>
          </div>
        </WindowFrame>

        {/* -----------------------------------------------------------------
            WINDOW 3: MISSIONS & ISOLATED LABS (ops-center)
           ----------------------------------------------------------------- */}
        <WindowFrame
          id="missions"
          title={windows.missions.title}
          subtitle={windows.missions.subtitle}
          icon={<Crosshair size={15} />}
          isOpen={windows.missions.open}
          isMinimized={windows.missions.minimized}
          isFocused={focusedApp === 'missions'}
          zIndex={windows.missions.z}
          initialGeometry={windows.missions.geom}
          onFocus={(id) => openAndFocusApp(id as AppId)}
          onClose={closeApp}
          onMinimize={minimizeApp}
        >
          <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Active Isolated Lab Session Control Panel */}
            <div
              style={{
                background: operator.activeLabSession
                  ? 'rgba(16, 185, 129, 0.1)'
                  : 'rgba(14, 165, 233, 0.08)',
                border: `1px solid ${operator.activeLabSession ? '#10b981' : '#1e3a5f'}`,
                borderRadius: '6px',
                padding: '12px'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div
                    style={{
                      fontSize: '11px',
                      fontFamily: 'var(--rw-font-mono)',
                      color: operator.activeLabSession ? '#34d399' : '#38bdf8',
                      fontWeight: 700
                    }}
                  >
                    {operator.activeLabSession
                      ? `ACTIVE ISOLATED LAB SANDBOX // [${operator.activeLabSession.mission_code}]`
                      : 'ISOLATED LAB WORKER STATUS // STANDBY'}
                  </div>
                  <div style={{ fontSize: '12.5px', marginTop: '3px', color: '#e2e8f0' }}>
                    {operator.activeLabSession ? (
                      <>
                        Assigned Lab Target: <code>{operator.activeLabSession.target_ip}</code> (
                        <code>{operator.activeLabSession.target_hostname}</code>) — Non-root Linux network
                        namespace, public internet egress blocked.
                      </>
                    ) : (
                      'Select any REAL-LAB mission below and click "Open Lab Target" to provision a disposable 10.240.x.x target container/namespace.'
                    )}
                  </div>
                </div>
                {operator.activeLabSession && (
                  <button
                    type="button"
                    className="rw-btn rw-btn-danger"
                    onClick={() => runTerminalCommand('lab close')}
                  >
                    Close Lab
                  </button>
                )}
              </div>

              {operator.activeLabSession && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' }}>
                  {(Object.keys(APPROVED_NMAP_PROFILES) as Array<keyof typeof APPROVED_NMAP_PROFILES>).map(
                    (prof) => (
                      <button
                        key={prof}
                        type="button"
                        className="rw-btn rw-btn-primary"
                        onClick={() => {
                          runTerminalCommand(
                            `nmap --profile ${prof} --target ${operator.activeLabSession.target_ip}`
                          );
                          openAndFocusApp('terminal');
                        }}
                      >
                        <Play size={12} /> Run Nmap ({prof})
                      </button>
                    )
                  )}
                </div>
              )}
            </div>

            {/* Missions List */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '10px' }}>
              {(missionsData?.missions ?? []).map((m: any) => {
                const isDone = m.player_status === 'completed';
                return (
                  <div
                    key={m.id}
                    style={{
                      background: '#0a1220',
                      border: `1px solid ${m.is_lab_mission ? '#0284c7' : '#1e3354'}`,
                      borderRadius: '6px',
                      padding: '12px',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '8px'
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span
                          className="rw-badge"
                          style={{
                            background: m.is_lab_mission
                              ? 'rgba(14, 165, 233, 0.2)'
                              : 'rgba(168, 85, 247, 0.2)',
                            color: m.is_lab_mission ? '#38bdf8' : '#c084fc'
                          }}
                        >
                          {m.code} // {m.is_lab_mission ? `REAL NMAP LAB (${m.lab_target_ip})` : 'WORLD OP'}
                        </span>
                        <span
                          style={{
                            fontFamily: 'var(--rw-font-mono)',
                            fontSize: '11.5px',
                            color: '#34d399',
                            fontWeight: 700
                          }}
                        >
                          +{m.reward_rwc} RWC / +{m.reward_xp} XP
                        </span>
                      </div>

                      <div style={{ fontWeight: 700, fontSize: '13.5px', marginTop: '6px' }}>
                        {m.title}
                      </div>
                      <div style={{ fontSize: '11.5px', color: '#94a3b8', marginTop: '4px', lineHeight: 1.4 }}>
                        {m.briefing}
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                      <span
                        style={{
                          fontSize: '11px',
                          fontFamily: 'var(--rw-font-mono)',
                          color: isDone ? '#34d399' : '#94a3b8'
                        }}
                      >
                        Status: {(m.player_status ?? 'available').toUpperCase()}
                      </span>

                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          className="rw-btn"
                          onClick={() => runTerminalCommand(`accept --job ${m.id}`)}
                        >
                          Accept
                        </button>
                        {m.is_lab_mission ? (
                          <button
                            type="button"
                            className="rw-btn rw-btn-primary"
                            onClick={() => runTerminalCommand(`lab open --mission ${m.id}`)}
                          >
                            Open Lab Target
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="rw-btn rw-btn-primary"
                            onClick={() => {
                              runTerminalCommand(`inspect --target ${m.target_node_id}`);
                              openAndFocusApp('terminal');
                            }}
                          >
                            Execute Recon
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </WindowFrame>

        {/* -----------------------------------------------------------------
            WINDOW 4: GROUPS, ALLIANCES & OPEN PvP (syndicate-hq)
           ----------------------------------------------------------------- */}
        <WindowFrame
          id="social"
          title={windows.social.title}
          subtitle={windows.social.subtitle}
          icon={<Users size={15} />}
          isOpen={windows.social.open}
          isMinimized={windows.social.minimized}
          isFocused={focusedApp === 'social'}
          zIndex={windows.social.z}
          initialGeometry={windows.social.geom}
          onFocus={(id) => openAndFocusApp(id as AppId)}
          onClose={closeApp}
          onMinimize={minimizeApp}
        >
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Sub-navigation tabs */}
            <div
              style={{
                display: 'flex',
                gap: '6px',
                padding: '8px 12px',
                background: '#0a1220',
                borderBottom: '1px solid #172742'
              }}
            >
              {(
                [
                  { id: 'pvp', label: 'Open PvP & Node Defenses' },
                  { id: 'groups', label: 'Hacking Groups' },
                  { id: 'alliances', label: 'Alliances & Diplomacy' },
                  { id: 'chat', label: 'Real-Time Grid Comms' }
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`rw-btn ${socialTab === t.id ? 'rw-btn-primary' : ''}`}
                  onClick={() => setSocialTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div style={{ flex: 1, padding: '14px', overflowY: 'auto' }}>
              {socialTab === 'pvp' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {/* Home Node Defense Configuration */}
                  <div
                    style={{
                      background: '#0a1220',
                      border: '1px solid #0284c7',
                      borderRadius: '6px',
                      padding: '12px'
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: '13px', color: '#38bdf8' }}>
                      YOUR HOME BASTION DEFENSE POSTURE // {operator.homeNode?.hostname ?? 'bastion.player.rw'}
                    </div>
                    <div style={{ fontSize: '11.5px', color: '#94a3b8', marginTop: '3px' }}>
                      PvP Safeguards: Max 10% RWC loss per heist | Max 20% 24h cap | 500 RWC protected balance
                      floor | New-Player Shield: {operator.shieldActive ? 'ACTIVE' : 'INACTIVE'}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' }}>
                      {(
                        [
                          { act: 'monitor', label: 'Upgrade IDS Monitoring (200 RWC)' },
                          { act: 'patch', label: 'Apply Kernel Patch (250 RWC)' },
                          { act: 'segment', label: 'Micro-Segmentation (300 RWC)' },
                          { act: 'decoy', label: 'Deploy Mirage Decoys (350 RWC)' },
                          { act: 'ir', label: 'Incident Response (-Heat) (150 RWC)' },
                          { act: 'recover', label: 'Restore Node Snapshot (100 RWC)' }
                        ] as const
                      ).map((d) => (
                        <button
                          key={d.act}
                          type="button"
                          className="rw-btn"
                          onClick={async () => {
                            await runTerminalCommand(`defend --action ${d.act}`);
                          }}
                        >
                          <Shield size={12} /> {d.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Player-Owned Networks (Open PvP Targets) */}
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>
                      IN-GAME PLAYER & SYNDICATE NETWORK NODES (OPEN PvP)
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                        gap: '10px'
                      }}
                    >
                      {(socialData?.pvpNodes ?? []).map((n: any) => {
                        const isSelf = n.owner_user_id === operator.id;
                        return (
                          <div
                            key={n.id}
                            style={{
                              background: '#0a1220',
                              border: '1px solid #1e3354',
                              borderRadius: '6px',
                              padding: '10px'
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ fontWeight: 700, fontSize: '13px' }}>{n.name}</span>
                              <span
                                className="rw-badge"
                                style={{
                                  background: 'rgba(34, 211, 238, 0.14)',
                                  color: '#22d3ee'
                                }}
                              >
                                {n.status.toUpperCase()}
                              </span>
                            </div>
                            <div
                              style={{
                                fontFamily: 'var(--rw-font-mono)',
                                fontSize: '11px',
                                color: '#38bdf8',
                                marginTop: '2px'
                              }}
                            >
                              {n.hostname} ({n.ip_address}) // Owner: {n.owner_handle ?? 'Operator'}
                            </div>
                            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                              Security: {n.security_level}/100 | Patch: {n.patch_level}%{' '}
                              {n.group_tag ? `| Group: [${n.group_tag}]` : ''}
                            </div>
                            {!isSelf && (
                              <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                                {(['probe', 'heist', 'disrupt', 'contest'] as const).map((method) => (
                                  <button
                                    key={method}
                                    type="button"
                                    className={`rw-btn ${method === 'heist' ? 'rw-btn-danger' : ''}`}
                                    style={{ padding: '4px 8px', fontSize: '11px' }}
                                    onClick={() =>
                                      runTerminalCommand(
                                        `pvp attack --target ${n.id} --method ${method}`
                                      )
                                    }
                                  >
                                    {method.toUpperCase()}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Active Bounties */}
                  <div
                    style={{
                      background: '#0a1220',
                      border: '1px solid #1e3354',
                      borderRadius: '6px',
                      padding: '12px'
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>
                      SYNDICATE BOUNTY BOARD
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                      <input
                        className="rw-input"
                        value={bountyNodeId}
                        onChange={(e) => setBountyNodeId(e.target.value)}
                        placeholder="Target Node ID"
                      />
                      <input
                        className="rw-input"
                        type="number"
                        style={{ width: '110px' }}
                        value={bountyAmount}
                        onChange={(e) => setBountyAmount(e.target.value)}
                        placeholder="RWC"
                      />
                      <input
                        className="rw-input"
                        style={{ flex: 1 }}
                        value={bountyReason}
                        onChange={(e) => setBountyReason(e.target.value)}
                        placeholder="Bounty reason"
                      />
                      <button
                        type="button"
                        className="rw-btn rw-btn-primary"
                        onClick={async () => {
                          try {
                            await apiFetch('/api/pvp/bounties', {
                              method: 'POST',
                              body: JSON.stringify({
                                targetNodeId: bountyNodeId,
                                rewardRwc: Number(bountyAmount),
                                reason: bountyReason
                              })
                            });
                            await refreshAllData();
                          } catch (err: any) {
                            addNotification('Bounty Error', err?.message, 'warn');
                          }
                        }}
                      >
                        Post Bounty
                      </button>
                    </div>
                    {(socialData?.bounties ?? []).map((b: any) => (
                      <div
                        key={b.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '6px 0',
                          borderTop: '1px solid #16243d',
                          fontSize: '12px'
                        }}
                      >
                        <span>
                          <strong>[{b.status.toUpperCase()}]</strong> Target:{' '}
                          <code>{b.target_node_hostname}</code> — {b.reason} (by {b.issuer_handle})
                        </span>
                        <span style={{ color: '#34d399', fontFamily: 'var(--rw-font-mono)', fontWeight: 700 }}>
                          {b.reward_rwc} RWC
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {socialTab === 'groups' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div
                    style={{
                      background: '#0a1220',
                      border: '1px solid #1e3354',
                      borderRadius: '6px',
                      padding: '12px',
                      display: 'flex',
                      gap: '8px',
                      flexWrap: 'wrap',
                      alignItems: 'center'
                    }}
                  >
                    <input
                      className="rw-input"
                      placeholder="New Group Name"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                    />
                    <input
                      className="rw-input"
                      style={{ width: '90px' }}
                      placeholder="TAG"
                      value={newGroupTag}
                      onChange={(e) => setNewGroupTag(e.target.value)}
                    />
                    <button
                      type="button"
                      className="rw-btn rw-btn-primary"
                      onClick={async () => {
                        try {
                          await apiFetch('/api/social/groups', {
                            method: 'POST',
                            body: JSON.stringify({
                              name: newGroupName,
                              tag: newGroupTag,
                              description: 'Operator tactical group'
                            })
                          });
                          setNewGroupName('');
                          setNewGroupTag('');
                          await refreshAllData();
                        } catch (err: any) {
                          addNotification('Group Error', err?.message, 'warn');
                        }
                      }}
                    >
                      Create Hacking Group
                    </button>
                  </div>

                  {(socialData?.groups ?? []).map((g: any) => (
                    <div
                      key={g.id}
                      style={{
                        background: '#0a1220',
                        border: '1px solid #1e3354',
                        borderRadius: '6px',
                        padding: '12px'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <span style={{ fontWeight: 700, fontSize: '14px', color: '#38bdf8' }}>
                            [{g.tag}] {g.name}
                          </span>
                          {g.alliance_name && (
                            <span style={{ marginLeft: '8px', fontSize: '11.5px', color: '#34d399' }}>
                              // Alliance: [{g.alliance_tag}] {g.alliance_name}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="rw-btn"
                          onClick={async () => {
                            await apiFetch(`/api/social/groups/${g.id}/join`, { method: 'POST' });
                            await refreshAllData();
                          }}
                        >
                          {operator.group?.id === g.id ? 'Member' : 'Join Group'}
                        </button>
                      </div>
                      <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>
                        {g.description}
                      </div>
                      <div
                        style={{
                          fontSize: '11.5px',
                          fontFamily: 'var(--rw-font-mono)',
                          color: '#cbd5e1',
                          marginTop: '6px'
                        }}
                      >
                        Shared Goal: {g.shared_goal} ({g.goal_progress}/{g.goal_target}) | Treasury:{' '}
                        {g.treasury_rwc.toLocaleString()} RWC | Members:{' '}
                        {(g.members ?? []).map((m: any) => `${m.username} (${m.role})`).join(', ')}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {socialTab === 'alliances' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div
                    style={{
                      background: '#0a1220',
                      border: '1px solid #1e3354',
                      borderRadius: '6px',
                      padding: '12px',
                      display: 'flex',
                      gap: '8px',
                      flexWrap: 'wrap'
                    }}
                  >
                    <input
                      className="rw-input"
                      placeholder="Alliance Name"
                      value={newAllianceName}
                      onChange={(e) => setNewAllianceName(e.target.value)}
                    />
                    <input
                      className="rw-input"
                      style={{ width: '90px' }}
                      placeholder="TAG"
                      value={newAllianceTag}
                      onChange={(e) => setNewAllianceTag(e.target.value)}
                    />
                    <button
                      type="button"
                      className="rw-btn rw-btn-primary"
                      onClick={async () => {
                        try {
                          await apiFetch('/api/social/alliances', {
                            method: 'POST',
                            body: JSON.stringify({
                              name: newAllianceName,
                              tag: newAllianceTag,
                              description: 'Regional mutual defense & shared intel coalition'
                            })
                          });
                          setNewAllianceName('');
                          setNewAllianceTag('');
                          await refreshAllData();
                        } catch (err: any) {
                          addNotification('Alliance Error', err?.message, 'warn');
                        }
                      }}
                    >
                      Form Alliance
                    </button>
                  </div>

                  {(socialData?.alliances ?? []).map((a: any) => (
                    <div
                      key={a.id}
                      style={{
                        background: '#0a1220',
                        border: '1px solid #0284c7',
                        borderRadius: '6px',
                        padding: '12px'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontWeight: 700, fontSize: '14px', color: '#38bdf8' }}>
                          [{a.tag}] {a.name}
                        </span>
                        <button
                          type="button"
                          className="rw-btn"
                          onClick={async () => {
                            await apiFetch(`/api/social/alliances/${a.id}/join`, { method: 'POST' });
                            await refreshAllData();
                          }}
                        >
                          Join Pact
                        </button>
                      </div>
                      <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>
                        {a.description}
                      </div>
                      <div
                        style={{
                          fontSize: '11px',
                          fontFamily: 'var(--rw-font-mono)',
                          color: '#34d399',
                          marginTop: '6px'
                        }}
                      >
                        Permissions: Shared Intel ✓ | Mutual Defense (+8 Defense Score) ✓ | Coordinated Ops ✓
                      </div>
                    </div>
                  ))}

                  <div
                    style={{
                      background: '#0a1220',
                      border: '1px solid #1e3354',
                      borderRadius: '6px',
                      padding: '12px'
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '6px' }}>
                      ACTIVE DIPLOMACY, RIVALRIES & WARS
                    </div>
                    {(socialData?.diplomacy ?? []).map((d: any) => (
                      <div key={d.id} style={{ fontSize: '12px', padding: '4px 0', color: '#fda4af' }}>
                        <strong>
                          [{d.source_tag}] vs [{d.target_tag}] — {d.relation_type.toUpperCase()}
                        </strong>
                        : {d.strategic_objective}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {socialTab === 'chat' && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '420px', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {(['global', 'group', 'alliance'] as const).map((ch) => (
                      <button
                        key={ch}
                        type="button"
                        className={`rw-btn ${chatChannel === ch ? 'rw-btn-primary' : ''}`}
                        onClick={() => setChatChannel(ch)}
                      >
                        #{ch.toUpperCase()}
                      </button>
                    ))}
                  </div>

                  <div
                    style={{
                      flex: 1,
                      background: '#060b14',
                      border: '1px solid #172742',
                      borderRadius: '4px',
                      padding: '10px',
                      overflowY: 'auto',
                      fontFamily: 'var(--rw-font-mono)',
                      fontSize: '12px'
                    }}
                  >
                    {chatMessages
                      .filter((m) => m.channel_type === chatChannel)
                      .map((m) => (
                        <div key={m.id} style={{ marginBottom: '6px' }}>
                          <span style={{ color: '#38bdf8', fontWeight: 700 }}>{m.sender_handle}: </span>
                          <span style={{ color: '#e2e8f0' }}>{m.message}</span>
                        </div>
                      ))}
                  </div>

                  <form onSubmit={handleSendChat} style={{ display: 'flex', gap: '8px' }}>
                    <input
                      className="rw-input"
                      style={{ flex: 1 }}
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder={`Broadcast message to #${chatChannel}...`}
                    />
                    <button type="submit" className="rw-btn rw-btn-primary">
                      <Send size={13} /> Send
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>
        </WindowFrame>

        {/* -----------------------------------------------------------------
            WINDOW 5: MARKET & TRANSACTIONAL LEDGER (nexus-market)
           ----------------------------------------------------------------- */}
        <WindowFrame
          id="market"
          title={windows.market.title}
          subtitle={`Balance: ${Number(operator.balanceRwc ?? 0).toLocaleString()} RWC`}
          icon={<ShoppingBag size={15} />}
          isOpen={windows.market.open}
          isMinimized={windows.market.minimized}
          isFocused={focusedApp === 'market'}
          zIndex={windows.market.z}
          initialGeometry={windows.market.geom}
          onFocus={(id) => openAndFocusApp(id as AppId)}
          onClose={closeApp}
          onMinimize={minimizeApp}
        >
          <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Atomic Player RWC Transfer */}
            <div
              style={{
                background: '#0a1220',
                border: '1px solid #0284c7',
                borderRadius: '6px',
                padding: '12px'
              }}
            >
              <div style={{ fontWeight: 700, fontSize: '13px', color: '#38bdf8', marginBottom: '8px' }}>
                ATOMIC RWC LEDGER TRANSFER (IDEMPOTENT DOUBLE-ENTRY)
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <input
                  className="rw-input"
                  placeholder="Recipient Handle"
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value)}
                />
                <input
                  className="rw-input"
                  type="number"
                  style={{ width: '120px' }}
                  placeholder="Amount RWC"
                  value={transferAmount}
                  onChange={(e) => setTransferAmount(e.target.value)}
                />
                <input
                  className="rw-input"
                  style={{ flex: 1 }}
                  placeholder="Memo"
                  value={transferMemo}
                  onChange={(e) => setTransferMemo(e.target.value)}
                />
                <button
                  type="button"
                  className="rw-btn rw-btn-primary"
                  onClick={async () => {
                    await runTerminalCommand(
                      `transfer --to ${transferTo} --amount ${transferAmount} --memo "${transferMemo}"`
                    );
                  }}
                >
                  Send RWC
                </button>
              </div>
            </div>

            {/* Market Items */}
            <div>
              <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>
                HARDWARE & SOFTWARE MODULES (REGIONAL TARIFF: {economyData?.marketMultiplier ?? 1}x)
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                  gap: '10px'
                }}
              >
                {(economyData?.marketItems ?? []).map((item: any) => {
                  const owned = (economyData?.inventory ?? []).find(
                    (inv: any) => inv.item_id === item.id
                  );
                  return (
                    <div
                      key={item.id}
                      style={{
                        background: '#0a1220',
                        border: '1px solid #1e3354',
                        borderRadius: '6px',
                        padding: '10px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between'
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ fontWeight: 700, fontSize: '13px' }}>{item.name}</span>
                          <span
                            style={{
                              color: '#34d399',
                              fontFamily: 'var(--rw-font-mono)',
                              fontWeight: 700,
                              fontSize: '12px'
                            }}
                          >
                            {item.effective_price_rwc} RWC
                          </span>
                        </div>
                        <div style={{ fontSize: '11.5px', color: '#94a3b8', marginTop: '4px' }}>
                          {item.description}
                        </div>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginTop: '8px'
                        }}
                      >
                        <span style={{ fontSize: '11px', color: '#38bdf8', fontFamily: 'var(--rw-font-mono)' }}>
                          {owned ? `OWNED (x${owned.quantity}) [EQUIPPED]` : `TIER ${item.tier} // ${item.category.toUpperCase()}`}
                        </span>
                        <button
                          type="button"
                          className="rw-btn rw-btn-primary"
                          onClick={async () => {
                            try {
                              await apiFetch('/api/economy/buy', {
                                method: 'POST',
                                body: JSON.stringify({
                                  itemId: item.id,
                                  idempotencyKey: `buy-${operator.id}-${item.id}-${Date.now()}`
                                })
                              });
                              await refreshAllData();
                            } catch (err: any) {
                              addNotification('Market Error', err?.message, 'warn');
                            }
                          }}
                        >
                          Buy Module
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Ledger Transaction Log */}
            <div
              style={{
                background: '#0a1220',
                border: '1px solid #1e3354',
                borderRadius: '6px',
                padding: '12px'
              }}
            >
              <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>
                TRANSACTIONAL LEDGER HISTORY
              </div>
              {(economyData?.transactions ?? []).map((tx: any) => {
                const isCredit = tx.to_account_id === economyData?.accountId;
                return (
                  <div
                    key={tx.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '5px 0',
                      borderTop: '1px solid #16243d',
                      fontFamily: 'var(--rw-font-mono)',
                      fontSize: '11.5px'
                    }}
                  >
                    <span>
                      [{tx.tx_type.toUpperCase()}] {tx.memo}
                    </span>
                    <span style={{ color: isCredit ? '#34d399' : '#fb7185', fontWeight: 700 }}>
                      {isCredit ? '+' : '-'}
                      {tx.amount} RWC
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </WindowFrame>

        {/* -----------------------------------------------------------------
            WINDOW 6: INTEL, WORLD EVENTS, FACTIONS & AUDIT LOGS (intel-watch)
           ----------------------------------------------------------------- */}
        <WindowFrame
          id="intel"
          title={windows.intel.title}
          subtitle={windows.intel.subtitle}
          icon={<Activity size={15} />}
          isOpen={windows.intel.open}
          isMinimized={windows.intel.minimized}
          isFocused={focusedApp === 'intel'}
          zIndex={windows.intel.z}
          initialGeometry={windows.intel.geom}
          onFocus={(id) => openAndFocusApp(id as AppId)}
          onClose={closeApp}
          onMinimize={minimizeApp}
        >
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '8px 12px',
                background: '#0a1220',
                borderBottom: '1px solid #172742'
              }}
            >
              <div style={{ display: 'flex', gap: '6px' }}>
                {(
                  [
                    { id: 'factions', label: 'NPC Factions (9)' },
                    { id: 'events', label: 'Dynamic World Events' },
                    { id: 'incidents', label: 'PvP Incident History' },
                    { id: 'audit', label: 'Tool & Security Audit Log' }
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`rw-btn ${intelTab === t.id ? 'rw-btn-primary' : ''}`}
                    onClick={() => setIntelTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="rw-btn"
                onClick={async () => {
                  await apiFetch('/api/intel/world-event', { method: 'POST' });
                  await refreshAllData();
                }}
              >
                <Zap size={12} /> Trigger Dynamic World Event
              </button>
            </div>

            <div style={{ flex: 1, padding: '14px', overflowY: 'auto' }}>
              {intelTab === 'factions' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {(intelData?.factions ?? []).map((f: any) => (
                    <div
                      key={f.id}
                      style={{
                        background: '#0a1220',
                        border: '1px solid #1e3354',
                        borderRadius: '6px',
                        padding: '12px'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontWeight: 700, fontSize: '13.5px', color: '#38bdf8' }}>
                          [{f.code}] {f.name} ({f.category.toUpperCase()})
                        </span>
                        <span
                          className="rw-badge"
                          style={{
                            background: 'rgba(245, 158, 11, 0.16)',
                            color: '#fcd34d'
                          }}
                        >
                          ALERT: {f.alert_level}% // POLICY: {f.policy_stance.toUpperCase()} // TARIFF:{' '}
                          {f.price_modifier}x
                        </span>
                      </div>
                      <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>
                        {f.description}
                      </div>
                      {f.active_advisory && (
                        <div
                          style={{
                            fontSize: '11.5px',
                            fontFamily: 'var(--rw-font-mono)',
                            color: '#34d399',
                            marginTop: '6px'
                          }}
                        >
                          {f.active_advisory}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                        {(
                          [
                            { act: 'negotiating', label: 'Negotiate Heat Amnesty' },
                            { act: 'offering_contracts', label: 'Request Bonus Contract' },
                            { act: 'patching', label: 'Report Vulnerability (Patch)' }
                          ] as const
                        ).map((btn) => (
                          <button
                            key={btn.act}
                            type="button"
                            className="rw-btn"
                            style={{ padding: '4px 8px', fontSize: '11px' }}
                            onClick={async () => {
                              await apiFetch('/api/intel/faction-interact', {
                                method: 'POST',
                                body: JSON.stringify({ factionId: f.id, action: btn.act })
                              });
                              await refreshAllData();
                            }}
                          >
                            {btn.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {intelTab === 'events' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {(intelData?.events ?? []).map((ev: any) => (
                    <div
                      key={ev.id}
                      style={{
                        background: '#0a1220',
                        border: '1px solid #1e3354',
                        borderRadius: '6px',
                        padding: '10px'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontWeight: 700, color: '#38bdf8', fontSize: '13px' }}>
                          [{ev.event_type.toUpperCase()}] {ev.title}
                        </span>
                        <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                          {ev.severity.toUpperCase()}
                        </span>
                      </div>
                      <div style={{ fontSize: '12px', color: '#cbd5e1', marginTop: '4px' }}>
                        {ev.description}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {intelTab === 'incidents' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {(intelData?.incidents ?? []).map((inc: any) => (
                    <div
                      key={inc.id}
                      style={{
                        background: '#0a1220',
                        border: '1px solid #1e3354',
                        borderRadius: '6px',
                        padding: '10px',
                        fontSize: '12px'
                      }}
                    >
                      <div style={{ fontWeight: 700, color: '#fda4af' }}>{inc.summary}</div>
                      <div
                        style={{
                          fontFamily: 'var(--rw-font-mono)',
                          fontSize: '11px',
                          color: '#94a3b8',
                          marginTop: '4px'
                        }}
                      >
                        Mitigation: {inc.mitigation_applied} | Node Status After:{' '}
                        {inc.node_status_after.toUpperCase()} | Recovered: {inc.recovered ? 'YES' : 'NO'}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {intelTab === 'audit' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ fontWeight: 700, fontSize: '13px', color: '#38bdf8' }}>
                    ISOLATED LAB TOOL EXECUTION AUDIT LOG
                  </div>
                  {(intelData?.toolAuditLogs ?? []).map((tl: any) => (
                    <div
                      key={tl.id}
                      style={{
                        background: '#0a1220',
                        border: '1px solid #1e3354',
                        borderRadius: '6px',
                        padding: '8px',
                        fontFamily: 'var(--rw-font-mono)',
                        fontSize: '11px'
                      }}
                    >
                      <div>
                        [{tl.allowed ? 'ALLOWED' : 'DENIED'}] Tool: {tl.tool_name} | Profile: {tl.profile} |
                        Target: {tl.target_ip} | Mode: {tl.isolation_mode} ({tl.duration_ms}ms)
                      </div>
                      {tl.rejection_reason && (
                        <div style={{ color: '#fb7185' }}>Reason: {tl.rejection_reason}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </WindowFrame>

        {/* -----------------------------------------------------------------
            WINDOW 7: SETTINGS, MANUAL & LAB SAFETY (sys-config)
           ----------------------------------------------------------------- */}
        <WindowFrame
          id="settings"
          title={windows.settings.title}
          subtitle={windows.settings.subtitle}
          icon={<Settings size={15} />}
          isOpen={windows.settings.open}
          isMinimized={windows.settings.minimized}
          isFocused={focusedApp === 'settings'}
          zIndex={windows.settings.z}
          initialGeometry={windows.settings.geom}
          onFocus={(id) => openAndFocusApp(id as AppId)}
          onClose={closeApp}
          onMinimize={minimizeApp}
        >
          <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '12.5px' }}>
            <div
              style={{
                background: '#0a1220',
                border: '1px solid #0284c7',
                borderRadius: '6px',
                padding: '12px'
              }}
            >
              <div style={{ fontWeight: 700, color: '#38bdf8', marginBottom: '4px' }}>
                LAB ISOLATION & SAFETY ARCHITECTURE
              </div>
              <p style={{ margin: 0, color: '#cbd5e1', lineHeight: 1.5 }}>
                RootWars executes real <code>nmap</code> strictly inside short-lived, disposable Linux network
                namespaces (<code>ip netns</code>) as unprivileged <code>uid=65534(nobody)</code> with{' '}
                <code>--no-new-privs</code> and <code>prlimit</code> memory/CPU caps. The isolated namespace has
                zero default route and zero access to the public internet or host loopback services. Only the
                assigned <code>10.240.x.x</code> mission replica IP is reachable.
              </p>
            </div>

            <div
              style={{
                background: '#0a1220',
                border: '1px solid #1e3354',
                borderRadius: '6px',
                padding: '12px'
              }}
            >
              <div style={{ fontWeight: 700, color: '#38bdf8', marginBottom: '8px' }}>
                TERMINAL COMMAND MANUAL
              </div>
              {COMMAND_HELP_CATALOG.map((entry) => (
                <div
                  key={entry.command}
                  style={{
                    padding: '6px 0',
                    borderTop: '1px solid #16243d',
                    fontFamily: 'var(--rw-font-mono)',
                    fontSize: '11.5px'
                  }}
                >
                  <div style={{ color: '#38bdf8', fontWeight: 700 }}>{entry.syntax}</div>
                  <div style={{ color: '#94a3b8' }}>{entry.description}</div>
                </div>
              ))}
            </div>
          </div>
        </WindowFrame>
      </main>

      {/* ===================================================================
          BOTTOM APPLICATION DOCK / TASKBAR
         =================================================================== */}
      <footer
        style={{
          height: '44px',
          background: 'rgba(10, 17, 30, 0.96)',
          borderTop: '1px solid #1e3a5f',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          padding: '0 12px',
          zIndex: 9000
        }}
      >
        {(
          [
            { id: 'terminal', label: 'Terminal', icon: <Terminal size={15} /> },
            { id: 'map', label: 'World Map', icon: <Globe size={15} /> },
            { id: 'missions', label: 'Missions & Labs', icon: <Crosshair size={15} /> },
            { id: 'social', label: 'Groups & PvP', icon: <Users size={15} /> },
            { id: 'market', label: 'Market & Ledger', icon: <ShoppingBag size={15} /> },
            { id: 'intel', label: 'Intel & Audit', icon: <Activity size={15} /> },
            { id: 'settings', label: 'Settings & Help', icon: <Settings size={15} /> }
          ] as const
        ).map((item) => {
          const isOpen = windows[item.id].open && !windows[item.id].minimized;
          const isActive = focusedApp === item.id && isOpen;
          return (
            <button
              key={item.id}
              type="button"
              className={`rw-btn ${isActive ? 'rw-btn-primary' : ''}`}
              onClick={() => openAndFocusApp(item.id)}
              data-testid={`dock-${item.id}`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          );
        })}
      </footer>
    </div>
  );
};
