window.__ModuleLoader__.load({
  id: 'dsh-live-inspector',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const TAB_ID = 'dsh-live-inspector';
    const TAB_KIND = 'git-tree';
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

    // Global registry of per-session states
    const sessionStates = new Map();
    let currentMountedSessionId = null;
    let globalCtx = null;

    const listeners = new Set();
    function notify() {
      for (const listener of listeners) {
        try {
          listener();
        } catch (e) {
          console.warn('[dsh-live-inspector] listener error:', e);
        }
      }
    }

    function getSessionState(sid) {
      if (!sid) return null;
      let s = sessionStates.get(sid);
      if (!s) {
        s = {
          sessionId: sid,
          files: {}, // path -> { path, name, dir, status, active, timestamp, line, count, diffs: [] }
          activePath: null,
          filter: 'all',
          searchQuery: '',
          autoOpenOpenedThisTurn: false,
          reviewUrl: null
        };
        sessionStates.set(sid, s);
      }
      return s;
    }

    function resolveCurrentSessionId() {
      if (globalCtx?.sidebarRight?.mounted && typeof globalCtx.sidebarRight.mounted.getSnapshot === 'function') {
        const sid = globalCtx.sidebarRight.mounted.getSnapshot();
        if (sid) return sid;
      }
      if (globalCtx?.uiSession?.adapter?.current && typeof globalCtx.uiSession.adapter.current.getSnapshot === 'function') {
        const sid = globalCtx.uiSession.adapter.current.getSnapshot()?.key;
        if (sid) return sid;
      }
      return currentMountedSessionId;
    }

    function encodeSegment(s) {
      return encodeURIComponent(s).replace(/%3A/gi, ':');
    }
    function encodePath(p) {
      return p.split('/').map(encodeSegment).join('/');
    }
    function sessionFileAddress(sessionId, path) {
      const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      return FILE_ADDRESS_PREFIX + 'session/' + encodeSegment(sessionId) + '/' + encodePath(normalized);
    }

    function extractFilePathAndDiff(name, argsRaw) {
      if (!argsRaw || typeof argsRaw !== 'string') return null;
      let args;
      try {
        args = JSON.parse(argsRaw);
      } catch {
        return null;
      }
      if (!args || typeof args !== 'object') return null;

      if (name === 'edit') {
        const fp = args.file_path || args.path;
        if (typeof fp === 'string' && fp.length > 0) {
          return {
            path: fp,
            status: 'M',
            line: typeof args.offset === 'number' ? args.offset : undefined,
            diff: {
              oldText: typeof args.old_string === 'string' ? args.old_string : null,
              newText: typeof args.new_string === 'string' ? args.new_string : null
            }
          };
        }
      }

      if (name === 'str_replace_editor') {
        const fp = args.path;
        if (typeof fp === 'string' && fp.length > 0) {
          return {
            path: fp,
            status: 'M',
            diff: {
              oldText: typeof args.old_str === 'string' ? args.old_str : null,
              newText: typeof args.new_str === 'string' ? args.new_str : null
            }
          };
        }
      }

      if (name === 'write' || name === 'write_file') {
        const fp = args.file_path || args.path;
        if (typeof fp === 'string' && fp.length > 0) {
          const content = typeof args.content === 'string' ? args.content : null;
          return {
            path: fp,
            status: 'A',
            line: typeof args.offset === 'number' ? args.offset : undefined,
            diff: {
              oldText: null,
              newText: content ? (content.length > 2000 ? content.slice(0, 2000) + '\n... (truncated)' : content) : null,
              isNewFile: true
            }
          };
        }
      }

      if (name === 'read') {
        const fp = args.file_path || args.path;
        if (typeof fp === 'string' && fp.length > 0) {
          return {
            path: fp,
            status: 'R',
            line: typeof args.offset === 'number' ? args.offset : undefined
          };
        }
      }

      return null;
    }

    function recordFile(sessionId, filePath, status, line, diff) {
      const state = getSessionState(sessionId);
      if (!state) return;

      const cleanPath = filePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      const parts = cleanPath.split('/');
      const name = parts.pop() || cleanPath;
      const dir = parts.join('/') || '.';

      let nextStatus = status;
      const existing = state.files[cleanPath];
      if (existing) {
        if (existing.status === 'M' || status === 'M') {
          nextStatus = 'M';
        } else if (existing.status === 'A' && status === 'R') {
          nextStatus = 'A';
        }
      }

      for (const k in state.files) {
        state.files[k].active = false;
      }

      const diffs = existing?.diffs ? [...existing.diffs] : [];
      if (diff && (diff.oldText || diff.newText)) {
        diffs.push({
          oldText: diff.oldText,
          newText: diff.newText,
          isNewFile: diff.isNewFile || false,
          time: Date.now()
        });
      }

      state.files[cleanPath] = {
        path: cleanPath,
        name: name,
        dir: dir,
        status: nextStatus,
        active: true,
        line: line,
        timestamp: Date.now(),
        count: (existing ? existing.count : 0) + 1,
        diffs: diffs
      };
      state.activePath = cleanPath;
      notify();
    }

    function clearActive(sessionId) {
      const state = getSessionState(sessionId);
      if (!state) return;
      let changed = false;
      if (state.activePath !== null) {
        state.activePath = null;
        changed = true;
      }
      for (const k in state.files) {
        if (state.files[k].active) {
          state.files[k].active = false;
          changed = true;
        }
      }
      if (changed) notify();
    }

    function openSingleFile(sessionId, filePath, line, tabActions) {
      if (!sessionId) {
        console.warn('[dsh-live-inspector] Cannot open file: no active session');
        return;
      }
      const url = sessionFileAddress(sessionId, filePath);
      const options = line ? { params: { line } } : undefined;
      console.info('[dsh-live-inspector] Opening file:', url, options);

      // Strategy 1: Tab-scoped actions
      if (tabActions && typeof tabActions.openResource === 'function') {
        try {
          tabActions.openResource(url, options);
          return;
        } catch (e) {
          console.warn('[dsh-live-inspector] tabActions.openResource error:', e);
        }
      }

      // Strategy 2: Global controller openResourceIn
      if (globalCtx?.sidebarRight && typeof globalCtx.sidebarRight.openResourceIn === 'function') {
        try {
          globalCtx.sidebarRight.openResourceIn(sessionId, url, options);
          return;
        } catch (e) {
          console.warn('[dsh-live-inspector] openResourceIn error:', e);
        }
      }

      // Strategy 3: Global controller openResource
      if (globalCtx?.sidebarRight && typeof globalCtx.sidebarRight.openResource === 'function') {
        try {
          globalCtx.sidebarRight.openResource(url, options);
          return;
        } catch (e) {
          console.warn('[dsh-live-inspector] openResource error:', e);
        }
      }
    }

    function openResourceUrl(sessionId, url, tabActions) {
      if (tabActions && typeof tabActions.openResource === 'function') {
        try {
          tabActions.openResource(url);
          return;
        } catch (e) {
          console.warn('[dsh-live-inspector] tabActions.openResource error:', e);
        }
      }
      if (globalCtx?.sidebarRight && typeof globalCtx.sidebarRight.openResourceIn === 'function') {
        try {
          globalCtx.sidebarRight.openResourceIn(sessionId, url);
          return;
        } catch (e) {
          console.warn('[dsh-live-inspector] openResourceIn error:', e);
        }
      }
      if (globalCtx?.sidebarRight && typeof globalCtx.sidebarRight.openResource === 'function') {
        try {
          globalCtx.sidebarRight.openResource(url);
          return;
        } catch (e) {
          console.warn('[dsh-live-inspector] openResource error:', e);
        }
      }
    }

    // Component to render 2-column side-by-side Diff viewer
    function DiffViewer({ diffs }) {
      if (!diffs || diffs.length === 0) return null;

      return h('div', {
        style: {
          marginTop: '6px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
          background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.25))',
          overflow: 'hidden',
          fontSize: '11px',
          fontFamily: 'var(--ds-font-family-code, monospace)'
        }
      },
        diffs.map((d, dIdx) => {
          const oldLines = d.oldText ? d.oldText.split('\n') : [];
          const newLines = d.newText ? d.newText.split('\n') : [];

          return h('div', {
            key: dIdx,
            style: {
              borderBottom: dIdx < diffs.length - 1 ? '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.1))' : 'none',
              padding: '6px'
            }
          },
            // Diff Header
            h('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '6px',
                padding: '0 2px',
                color: 'var(--dsw-alias-label-secondary, #999)',
                fontSize: '10px'
              }
            },
              h('span', { style: { fontWeight: 600 } }, d.isNewFile ? '✨ Tạo mới (Created)' : 'Thay đổi #' + (dIdx + 1)),
              h('div', { style: { display: 'flex', gap: '8px' } },
                h('span', { style: { color: '#f87171' } }, '-' + oldLines.length + ' dòng cũ'),
                h('span', { style: { color: '#34d399' } }, '+' + newLines.length + ' dòng mới')
              )
            ),

            // 2-Column Side-by-Side Grid
            h('div', {
              style: {
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                gap: '4px',
                background: 'rgba(0,0,0,0.2)',
                borderRadius: '4px',
                overflow: 'hidden',
                border: '1px solid rgba(255,255,255,0.06)'
              }
            },
              // CỘT 1: CŨ (BEFORE / ORIGINAL)
              h('div', {
                style: {
                  background: 'rgba(239, 68, 68, 0.05)',
                  borderRight: '1px solid rgba(255,255,255,0.08)',
                  overflowX: 'auto',
                  minWidth: 0
                }
              },
                // Header Cột Cũ
                h('div', {
                  style: {
                    padding: '3px 6px',
                    background: 'rgba(239, 68, 68, 0.15)',
                    color: '#f87171',
                    fontWeight: 600,
                    fontSize: '10px',
                    borderBottom: '1px solid rgba(239, 68, 68, 0.2)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }
                },
                  h('span', null, '◀ CŨ (TRƯỚC)'),
                  h('span', { style: { fontSize: '9px', opacity: 0.8 } }, oldLines.length + ' L')
                ),
                // Danh sách dòng Cũ
                h('div', { style: { padding: '4px 0' } },
                  oldLines.length === 0
                    ? h('div', { style: { padding: '8px', color: '#888', fontStyle: 'italic', fontSize: '10px' } }, '(không có / rỗng)')
                    : oldLines.slice(0, 60).map((l, lIdx) =>
                        h('div', {
                          key: lIdx,
                          style: {
                            display: 'flex',
                            padding: '1px 4px',
                            lineHeight: '16px',
                            color: '#fca5a5',
                            background: 'rgba(239, 68, 68, 0.08)',
                            borderLeft: '2px solid #ef4444',
                            margin: '1px 0'
                          }
                        },
                          h('span', {
                            style: {
                              width: '20px',
                              flexShrink: 0,
                              color: '#f87171',
                              opacity: 0.6,
                              userSelect: 'none',
                              fontSize: '9px'
                            }
                          }, String(lIdx + 1)),
                          h('span', {
                            style: {
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-all'
                            }
                          }, l)
                        )
                      ),
                  oldLines.length > 60 ? h('div', { style: { padding: '2px 6px', color: '#ef4444', fontStyle: 'italic', fontSize: '10px' } }, '... và ' + (oldLines.length - 60) + ' dòng khác') : null
                )
              ),

              // CỘT 2: MỚI (AFTER / MODIFIED)
              h('div', {
                style: {
                  background: 'rgba(16, 185, 129, 0.05)',
                  overflowX: 'auto',
                  minWidth: 0
                }
              },
                // Header Cột Mới
                h('div', {
                  style: {
                    padding: '3px 6px',
                    background: 'rgba(16, 185, 129, 0.15)',
                    color: '#34d399',
                    fontWeight: 600,
                    fontSize: '10px',
                    borderBottom: '1px solid rgba(16, 185, 129, 0.2)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }
                },
                  h('span', null, '▶ MỚI (SAU KHI SỬA)'),
                  h('span', { style: { fontSize: '9px', opacity: 0.8 } }, newLines.length + ' L')
                ),
                // Danh sách dòng Mới
                h('div', { style: { padding: '4px 0' } },
                  newLines.length === 0
                    ? h('div', { style: { padding: '8px', color: '#888', fontStyle: 'italic', fontSize: '10px' } }, '(bị xóa / rỗng)')
                    : newLines.slice(0, 60).map((l, lIdx) =>
                        h('div', {
                          key: lIdx,
                          style: {
                            display: 'flex',
                            padding: '1px 4px',
                            lineHeight: '16px',
                            color: '#86efac',
                            background: 'rgba(16, 185, 129, 0.08)',
                            borderLeft: '2px solid #10b981',
                            margin: '1px 0'
                          }
                        },
                          h('span', {
                            style: {
                              width: '20px',
                              flexShrink: 0,
                              color: '#34d399',
                              opacity: 0.6,
                              userSelect: 'none',
                              fontSize: '9px'
                            }
                          }, String(lIdx + 1)),
                          h('span', {
                            style: {
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-all'
                            }
                          }, l)
                        )
                      ),
                  newLines.length > 60 ? h('div', { style: { padding: '2px 6px', color: '#10b981', fontStyle: 'italic', fontSize: '10px' } }, '... và ' + (newLines.length - 60) + ' dòng khác') : null
                )
              )
            )
          );
        })
      );
    }

    // Tab Title chip
    function GitTreeTitle() {
      const [activeSid, setActiveSid] = React.useState(resolveCurrentSessionId);
      const [, setTick] = React.useState(0);

      React.useEffect(() => {
        const syncSid = () => {
          const sid = resolveCurrentSessionId();
          setActiveSid(sid);
        };
        const unsub = globalCtx?.sidebarRight?.mounted?.subscribe(syncSid);
        const cb = () => setTick(t => t + 1);
        listeners.add(cb);
        return () => {
          if (unsub) unsub();
          listeners.delete(cb);
        };
      }, []);

      const sessionData = getSessionState(activeSid);
      const fileList = sessionData ? Object.values(sessionData.files) : [];
      const changesCount = fileList.filter(f => f.status === 'M' || f.status === 'A').length;

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        h('span', null, 'Git Tree'),
        changesCount > 0 ? h('span', {
          style: {
            fontSize: '11px',
            lineHeight: '14px',
            padding: '1px 5px',
            borderRadius: '10px',
            background: 'var(--dsw-alias-brand-primary, #2563eb)',
            color: '#fff',
            fontWeight: 600
          }
        }, String(changesCount)) : null
      );
    }

    // Tab Body
    function GitTreeBody(props) {
      let tabInfo = null;
      if (props && typeof props.useTabInfo === 'function') {
        try {
          tabInfo = props.useTabInfo();
        } catch (err) {
          // not within tab scope or fallback
        }
      }

      const [activeSid, setActiveSid] = React.useState(resolveCurrentSessionId);
      const [, setTick] = React.useState(0);
      const [expandedDiffs, setExpandedDiffs] = React.useState({});

      React.useEffect(() => {
        const syncSid = () => {
          const sid = resolveCurrentSessionId();
          setActiveSid(sid);
        };
        const unsub = globalCtx?.sidebarRight?.mounted?.subscribe(syncSid);
        const cb = () => setTick(t => t + 1);
        listeners.add(cb);
        return () => {
          if (unsub) unsub();
          listeners.delete(cb);
        };
      }, []);

      const currentSid = activeSid || resolveCurrentSessionId();
      const sessionData = getSessionState(currentSid);

      const [filter, setFilter] = React.useState(sessionData ? sessionData.filter : 'all');
      const [search, setSearch] = React.useState(sessionData ? sessionData.searchQuery : '');

      const fileList = sessionData ? Object.values(sessionData.files) : [];
      const modifiedCount = fileList.filter(f => f.status === 'M').length;
      const addedCount = fileList.filter(f => f.status === 'A').length;
      const readCount = fileList.filter(f => f.status === 'R').length;

      // Filter files
      let visible = fileList;
      if (filter === 'changes') {
        visible = visible.filter(f => f.status === 'M' || f.status === 'A');
      } else if (filter === 'reads') {
        visible = visible.filter(f => f.status === 'R');
      }

      if (search.trim().length > 0) {
        const q = search.toLowerCase();
        visible = visible.filter(f => f.path.toLowerCase().includes(q));
      }

      // Sort: active first, then modified/added, then by timestamp desc
      visible.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        const rank = s => (s === 'M' ? 3 : s === 'A' ? 2 : 1);
        if (rank(a.status) !== rank(b.status)) return rank(b.status) - rank(a.status);
        return b.timestamp - a.timestamp;
      });

      function handleClear() {
        if (sessionData) {
          sessionData.files = {};
          sessionData.activePath = null;
          sessionData.reviewUrl = null;
          setExpandedDiffs({});
          notify();
        }
      }

      function toggleDiff(path) {
        setExpandedDiffs(prev => ({
          ...prev,
          [path]: !prev[path]
        }));
      }

      const tabActions = tabInfo?.tab?.actions;

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflow: 'hidden',
          fontFamily: 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, sans-serif)',
          color: 'var(--dsw-alias-label-primary, inherit)',
          fontSize: '13px',
          background: 'var(--dsw-alias-bg-base, transparent)'
        }
      },
        // Header
        h('div', {
          style: {
            padding: '12px 14px 10px',
            borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
            background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.02))'
          }
        },
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '8px'
            }
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, fontSize: '14px' } },
              h('span', null, '🌿 Git Tree & Live Changes')
            ),

            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              // Native changes review button if turn completed
              sessionData?.reviewUrl ? h('button', {
                onClick: () => openResourceUrl(currentSid, sessionData.reviewUrl, tabActions),
                title: 'Open full side-by-side diff review',
                style: {
                  background: 'rgba(37, 99, 235, 0.15)',
                  border: '1px solid rgba(37, 99, 235, 0.4)',
                  color: 'var(--dsw-alias-brand-primary, #60a5fa)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '2px 7px',
                  borderRadius: '4px'
                }
              }, '🔍 Review All') : null,

              h('button', {
                onClick: handleClear,
                title: 'Clear list for this session',
                style: {
                  background: 'none',
                  border: 'none',
                  color: 'var(--dsw-alias-label-secondary, #888)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '2px 6px',
                  borderRadius: '4px'
                }
              }, 'Clear')
            )
          ),

          // Active indicator banner if running
          (sessionData && sessionData.activePath) ? h('div', {
            style: {
              padding: '6px 8px',
              borderRadius: '6px',
              background: 'rgba(16, 185, 129, 0.12)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              color: '#10b981',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginBottom: '8px'
            }
          },
            h('span', {
              style: {
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: '#10b981',
                boxShadow: '0 0 6px #10b981',
                display: 'inline-block'
              }
            }),
            h('span', { style: { fontWeight: 500 } }, 'Agent active on:'),
            h('span', {
              style: {
                fontFamily: 'var(--ds-font-family-code, monospace)',
                fontWeight: 600,
                textOverflow: 'ellipsis',
                overflow: 'hidden',
                whiteSpace: 'nowrap'
              }
            }, sessionData.activePath)
          ) : null,

          // Stats chips & Filter buttons
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h('button', {
              onClick: () => {
                setFilter('all');
                if (sessionData) sessionData.filter = 'all';
              },
              style: {
                padding: '3px 8px',
                borderRadius: '12px',
                border: filter === 'all' ? '1px solid var(--dsw-alias-brand-primary, #3b82f6)' : '1px solid transparent',
                background: filter === 'all' ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '11px'
              }
            }, 'All (' + fileList.length + ')'),

            h('button', {
              onClick: () => {
                setFilter('changes');
                if (sessionData) sessionData.filter = 'changes';
              },
              style: {
                padding: '3px 8px',
                borderRadius: '12px',
                border: filter === 'changes' ? '1px solid #f59e0b' : '1px solid transparent',
                background: filter === 'changes' ? 'rgba(245, 158, 11, 0.15)' : 'transparent',
                color: filter === 'changes' ? '#f59e0b' : 'inherit',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: (modifiedCount + addedCount) > 0 ? 600 : 'normal'
              }
            }, 'Changes (' + (modifiedCount + addedCount) + ')'),

            h('button', {
              onClick: () => {
                setFilter('reads');
                if (sessionData) sessionData.filter = 'reads';
              },
              style: {
                padding: '3px 8px',
                borderRadius: '12px',
                border: filter === 'reads' ? '1px solid #3b82f6' : '1px solid transparent',
                background: filter === 'reads' ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                color: filter === 'reads' ? '#3b82f6' : 'inherit',
                cursor: 'pointer',
                fontSize: '11px'
              }
            }, 'Reads (' + readCount + ')')
          ),

          // Search input
          h('input', {
            type: 'text',
            placeholder: 'Filter files in this session...',
            value: search,
            onChange: e => {
              setSearch(e.target.value);
              if (sessionData) sessionData.searchQuery = e.target.value;
            },
            style: {
              width: '100%',
              boxSizing: 'border-box',
              marginTop: '8px',
              padding: '4px 8px',
              borderRadius: '4px',
              fontSize: '12px',
              border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
              background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.15))',
              color: 'inherit',
              outline: 'none'
            }
          })
        ),

        // Files Tree List
        h('div', {
          style: {
            flex: 1,
            overflowY: 'auto',
            padding: '8px 10px'
          }
        },
          visible.length === 0 ? h('div', {
            style: {
              padding: '24px 12px',
              textAlign: 'center',
              color: 'var(--dsw-alias-label-secondary, #777)',
              fontSize: '12px'
            }
          }, 'No files touched in this session yet.') :
          visible.map(f => {
            const badgeStyle = f.status === 'M'
              ? { bg: 'rgba(245, 158, 11, 0.16)', text: '#f59e0b', border: 'rgba(245, 158, 11, 0.35)', label: 'M' }
              : f.status === 'A'
              ? { bg: 'rgba(16, 185, 129, 0.16)', text: '#10b981', border: 'rgba(16, 185, 129, 0.35)', label: 'A' }
              : { bg: 'rgba(59, 130, 246, 0.12)', text: '#60a5fa', border: 'rgba(59, 130, 246, 0.25)', label: 'R' };

            const hasDiffs = f.diffs && f.diffs.length > 0;
            const isDiffExpanded = expandedDiffs[f.path] === true;

            return h('div', {
              key: f.path,
              style: {
                margin: '3px 0',
                borderRadius: '6px',
                border: f.active ? '1px solid #10b981' : '1px solid rgba(255,255,255,0.06)',
                background: f.active ? 'rgba(16, 185, 129, 0.08)' : 'rgba(255,255,255,0.02)',
                transition: 'background 0.15s ease'
              }
            },
              // Row Header
              h('div', {
                onClick: () => openSingleFile(currentSid, f.path, f.line, tabActions),
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 8px',
                  cursor: 'pointer'
                }
              },
                h('div', {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    minWidth: 0,
                    flex: 1
                  }
                },
                  // Status badge (M / A / R)
                  h('span', {
                    title: f.status === 'M' ? 'Modified' : f.status === 'A' ? 'Created/Added' : 'Read',
                    style: {
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '18px',
                      height: '18px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 700,
                      fontFamily: 'monospace',
                      background: badgeStyle.bg,
                      color: badgeStyle.text,
                      border: '1px solid ' + badgeStyle.border,
                      flexShrink: 0
                    }
                  }, badgeStyle.label),

                  // File name & directory
                  h('div', {
                    style: {
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }
                  },
                    h('span', {
                      style: {
                        fontWeight: 600,
                        fontFamily: 'var(--ds-font-family-code, monospace)',
                        color: 'inherit'
                      }
                    }, f.name),
                    f.dir !== '.' ? h('span', {
                      style: {
                        marginLeft: '6px',
                        fontSize: '11px',
                        color: 'var(--dsw-alias-label-secondary, #777)'
                      }
                    }, f.dir) : null
                  )
                ),

                // Right side actions
                h('div', {
                  style: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 },
                  onClick: (e) => e.stopPropagation()
                },
                  f.active ? h('span', {
                    style: {
                      fontSize: '10px',
                      fontWeight: 600,
                      color: '#10b981',
                      textTransform: 'uppercase'
                    }
                  }, 'Active') : null,

                  // Diff button (expand/collapse changes)
                  hasDiffs ? h('button', {
                    onClick: () => toggleDiff(f.path),
                    title: 'Show / hide changes diff',
                    style: {
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 500,
                      border: isDiffExpanded ? '1px solid #f59e0b' : '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
                      background: isDiffExpanded ? 'rgba(245, 158, 11, 0.15)' : 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06))',
                      color: isDiffExpanded ? '#f59e0b' : 'inherit',
                      cursor: 'pointer'
                    }
                  }, isDiffExpanded ? '▲ Hide' : '▼ Diff (' + f.diffs.length + ')') : null,

                  h('button', {
                    onClick: () => openSingleFile(currentSid, f.path, f.line, tabActions),
                    title: 'Open file preview in right tab',
                    style: {
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 500,
                      border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.18))',
                      background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08))',
                      color: 'inherit',
                      cursor: 'pointer'
                    }
                  }, 'View')
                )
              ),

              // Inline Diff Expansion
              isDiffExpanded && hasDiffs ? h('div', {
                style: {
                  padding: '0 8px 8px'
                }
              },
                h(DiffViewer, { diffs: f.diffs })
              ) : null
            );
          })
        )
      );
    }

    return {
      inject: ['sidebarRight', 'sidebarRightTabs', 'slots', 'sessions'],
      apply(ctx) {
        globalCtx = ctx;
        const sessionUnsubscribes = new Map();

        // Register tab type into sidebarRightTabs
        if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
          ctx.effect(() => {
            return ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'builtin',
              title: () => 'Git Tree',
              guide: [{
                id: 'git-tree',
                order: 1,
                title: () => 'Git Tree',
                description: () => 'Real-time modified files, diff comparison and live tracker'
              }]
            });
          }, 'dsh-live-inspector: git-tree tab registration');
        }

        // Register tab body into sidebar.right.pane.tab
        ctx.effect(() => {
          return ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID
          }, GitTreeBody));
        }, 'dsh-live-inspector: git-tree body slot');

        // Register live tab title into sidebar.right.pane.tab.title
        ctx.effect(() => {
          return ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: TAB_ID
          }, GitTreeTitle));
        }, 'dsh-live-inspector: git-tree title slot');

        function ensureTabOpen(sid) {
          const activeSid = resolveCurrentSessionId();
          if (sid !== activeSid) return;

          const sessionData = getSessionState(sid);
          if (sessionData && sessionData.autoOpenOpenedThisTurn) return;
          if (sessionData) sessionData.autoOpenOpenedThisTurn = true;

          try {
            if (ctx.sidebarRight && typeof ctx.sidebarRight.openTab === 'function') {
              ctx.sidebarRight.openTab(TAB_KIND);
            }
          } catch (e) {
            console.warn('[dsh-live-inspector] openTab error:', e);
          }
        }

        function handleSessionEvents(sessionId, eventSource) {
          if (!eventSource || typeof eventSource.getSnapshot !== 'function') return;
          const snapshot = eventSource.getSnapshot();
          if (!snapshot || !snapshot.change) return;

          const change = snapshot.change;
          if (change.kind !== 'append' || !Array.isArray(change.entries)) {
            return;
          }

          const sessionData = getSessionState(sessionId);

          for (const entry of change.entries) {
            if (!entry || entry.type !== 'event' || !entry.event) continue;
            const ev = entry.event;

            if (ev.type === 'turn/start') {
              if (sessionData) sessionData.autoOpenOpenedThisTurn = false;
              clearActive(sessionId);
            }

            if (ev.type === 'tool/call' && ev.data) {
              const toolName = ev.data.name;
              const extracted = extractFilePathAndDiff(toolName, ev.data.arguments);
              if (extracted && extracted.path) {
                recordFile(sessionId, extracted.path, extracted.status, extracted.line, extracted.diff);
                ensureTabOpen(sessionId);
              }
            }

            // Enrich with tool/result meta diffs if available
            if (ev.type === 'tool/result' && ev.data && ev.data.meta && Array.isArray(ev.data.meta.diffs)) {
              for (const df of ev.data.meta.diffs) {
                if (df && df.path) {
                  recordFile(sessionId, df.path, 'M', undefined, { oldText: df.oldText, newText: df.newText });
                }
              }
            }

            if (ev.type === 'step/end' || ev.type === 'turn/end') {
              clearActive(sessionId);
            }

            if (ev.type === 'workspace/changes' && ev.data && typeof ev.data.turn === 'number') {
              clearActive(sessionId);
              if (sessionData) {
                sessionData.reviewUrl = 'dsh-resource://changes-review/session/' + encodeSegment(sessionId) + '/' + ev.seq + '/' + ev.data.turn;
                notify();
              }
            }
          }
        }

        function bindSession(sessionId) {
          if (!sessionId || sessionUnsubscribes.has(sessionId)) return;

          try {
            const binding = ctx.sessions?.binding(sessionId);
            if (binding && binding.eventSource && typeof binding.eventSource.subscribe === 'function') {
              const unsub = binding.eventSource.subscribe(() => {
                handleSessionEvents(sessionId, binding.eventSource);
              });
              sessionUnsubscribes.set(sessionId, unsub);
            }
          } catch (e) {
            console.warn('[dsh-live-inspector] Failed to bind session:', sessionId, e);
          }
        }

        // Watch active session on screen
        if (ctx.sidebarRight && ctx.sidebarRight.mounted) {
          ctx.effect(() => {
            const unsub = ctx.sidebarRight.mounted.subscribe(() => {
              const sid = ctx.sidebarRight.mounted.getSnapshot();
              currentMountedSessionId = sid;
              if (sid) {
                bindSession(sid);
                notify();
              }
            });

            const initialSid = ctx.sidebarRight.mounted.getSnapshot();
            currentMountedSessionId = initialSid;
            if (initialSid) {
              bindSession(initialSid);
              notify();
            }

            return () => {
              unsub();
              for (const [, release] of sessionUnsubscribes) {
                try {
                  release();
                } catch {
                  // ignore
                }
              }
              sessionUnsubscribes.clear();
            };
          }, 'dsh-live-inspector: session watcher');
        }

        console.info('[dsh-live-inspector] Git Tree tab active with inline diff & per-session isolation.');
      }
    };
  }
});
