import React, { useState, useRef, useEffect } from 'react';
import { Minus, Square, Maximize2, X } from 'lucide-react';

export interface WindowGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WindowFrameProps {
  id: string;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  isOpen: boolean;
  isMinimized: boolean;
  isFocused: boolean;
  zIndex: number;
  initialGeometry: WindowGeometry;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onMinimize: (id: string) => void;
  children: React.ReactNode;
}

export const WindowFrame: React.FC<WindowFrameProps> = ({
  id,
  title,
  subtitle,
  icon,
  isOpen,
  isMinimized,
  isFocused,
  zIndex,
  initialGeometry,
  onFocus,
  onClose,
  onMinimize,
  children
}) => {
  const [geom, setGeom] = useState<WindowGeometry>(initialGeometry);
  const [maximized, setMaximized] = useState(false);
  const dragRef = useRef<{
    mode: 'move' | 'resize' | null;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    origX: initialGeometry.x,
    origY: initialGeometry.y,
    origW: initialGeometry.w,
    origH: initialGeometry.h
  });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current.mode) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;

      if (dragRef.current.mode === 'move') {
        setGeom((prev) => ({
          ...prev,
          x: Math.max(0, Math.min(window.innerWidth - 120, dragRef.current.origX + dx)),
          y: Math.max(0, Math.min(window.innerHeight - 80, dragRef.current.origY + dy))
        }));
      } else if (dragRef.current.mode === 'resize') {
        setGeom((prev) => ({
          ...prev,
          w: Math.max(380, Math.min(window.innerWidth - prev.x, dragRef.current.origW + dx)),
          h: Math.max(260, Math.min(window.innerHeight - 40 - prev.y, dragRef.current.origH + dy))
        }));
      }
    };

    const handleMouseUp = () => {
      dragRef.current.mode = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  if (!isOpen || isMinimized) {
    return null;
  }

  const style: React.CSSProperties = maximized
    ? {
        left: 0,
        top: 0,
        width: '100%',
        height: 'calc(100% - 44px)',
        zIndex,
        borderRadius: 0
      }
    : {
        left: `${geom.x}px`,
        top: `${geom.y}px`,
        width: `${geom.w}px`,
        height: `${geom.h}px`,
        zIndex
      };

  return (
    <div
      className={`rw-window ${isFocused ? 'rw-window-focused' : ''}`}
      style={style}
      onMouseDown={() => onFocus(id)}
      data-testid={`window-${id}`}
    >
      <div
        className="rw-window-titlebar"
        onMouseDown={(e) => {
          if (maximized) return;
          if ((e.target as HTMLElement).closest('button')) return;
          onFocus(id);
          dragRef.current = {
            mode: 'move',
            startX: e.clientX,
            startY: e.clientY,
            origX: geom.x,
            origY: geom.y,
            origW: geom.w,
            origH: geom.h
          };
        }}
        onDoubleClick={() => setMaximized((m) => !m)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
          <span style={{ color: '#38bdf8', display: 'flex', alignItems: 'center' }}>{icon}</span>
          <span
            style={{
              fontWeight: 600,
              fontSize: '12.5px',
              color: '#f1f5f9',
              letterSpacing: '0.02em',
              whiteSpace: 'nowrap'
            }}
          >
            {title}
          </span>
          {subtitle && (
            <span
              style={{
                fontSize: '11px',
                color: '#64748b',
                fontFamily: 'var(--rw-font-mono)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              // {subtitle}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button
            type="button"
            onClick={() => onMinimize(id)}
            title="Minimize"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
              display: 'flex'
            }}
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            onClick={() => setMaximized((m) => !m)}
            title={maximized ? 'Restore' : 'Maximize'}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
              display: 'flex'
            }}
          >
            {maximized ? <Square size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            type="button"
            onClick={() => onClose(id)}
            title="Close Window"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#f43f5e',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
              display: 'flex'
            }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="rw-window-body">{children}</div>

      {!maximized && (
        <div
          className="rw-resize-handle"
          onMouseDown={(e) => {
            e.stopPropagation();
            onFocus(id);
            dragRef.current = {
              mode: 'resize',
              startX: e.clientX,
              startY: e.clientY,
              origX: geom.x,
              origY: geom.y,
              origW: geom.w,
              origH: geom.h
            };
          }}
        />
      )}
    </div>
  );
};
