window.__ModuleLoader__.load({
  id: 'dsh-live-inspector',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const TAB_ID = 'dsh-live-inspector';
    const TAB_KIND = 'git-tree';

    // Global in-memory state for live files
    const state = {
      sessionId: null,
      files: {}, // path -> { path, name, dir, status, active, timestamp, line, count }
      activePath: null,
      filter: 'all', // 'all' | 'changes' | 'reads'
      searchQuery: '',
      autoOpenOpenedThisTurn: false
    };

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

    function encodeSegment(s) {
      return encodeURIComponent(s).replace(/%3A/gi, ':');
    }
    function encodePath(p) {
      return p.split('/').map(encodeSegment).join('/');
    }

    function extractFilePath(name, argsRaw) {
      if (!argsRaw || typeof argsRaw !== 'string') return null;
      let args;
      try {
        args = JSON.parse(argsRaw);
      } catch {
        return null;
      }
      if (!args || typeof args !== 'object') return null;

      if (name === 'write' || name === 'edit' || name === 'write_file') {
        const fp = args.file_path || args.path;
        if (typeof fp === 'string' && fp.length > 0) {
          return {
            path: fp,
            status: name === 'edit' ? 'M' : 'A',
            line: typeof args.offset === 'number' ? args.offset : undefined
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
      if (name === 'str_replace_editor') {
        const fp = args.path;
        if (typeof fp === 'string' && fp.length > 0) {
          return { path: fp, status: 'M' };
        }
      }
      return null;
    }

    function recordFile(filePath, status, line) {
      const cleanPath = filePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      const parts = cleanPath.split('/');
      const name = parts.pop() || cleanPath;
      const dir = parts.join('/') || '.';

      // Retain stronger status: M > A > R
      let nextStatus = status;
      const existing = state.files[cleanPath];
      if (existing) {
        if (existing.status === 'M' || status === 'M') {
          nextStatus = 'M';
        } else if (existing.status === 'A' && status === 'R') {
          nextStatus = 'A';
        }
      }

      // Mark other files as inactive
      for (const k in state.files) {
        state.files[k].active = false;
      }

      state.files[cleanPath] = {
        path: cleanPath,
        name: name,
        dir: dir,
        status: nextStatus,
        active: true,
        line: line,
        timestamp: Date.now(),
        count: (existing ? existing.count : 0) + 1
      };
      state.activePath = cleanPath;
      notify();
    }

    function clearActive() {
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

    // GitTree Tab Title Chip (shows count of modified/changed files)
    function GitTreeTitle() {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const cb = () => setTick(t => t + 1);
        listeners.add(cb);
        return () => listeners.delete(cb);
      }, []);

      const fileList = Object.values(state.files);
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

    // GitTree Tab Body
    function GitTreeBody(props) {
      const [, setTick] = React.useState(0);
      const [filter, setFilter] = React.useState(state.filter);
      const [search, setSearch] = React.useState(state.searchQuery);

      React.useEffect(() => {
        const cb = () => setTick(t => t + 1);
        listeners.add(cb);
        return () => listeners.delete(cb);
      }, []);

      const fileList = Object.values(state.files);
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

      function openSingleFile(path, line) {
        if (!state.sessionId) return;
        const url = 'dsh-resource://file/session/' + encodeSegment(state.sessionId) + '/' + encodePath(path);
        const options = line ? { params: { line: line } } : undefined;
        try {
          if (props?.useTabInfo) {
            const info = props.useTabInfo();
            if (info?.tab?.actions?.openResource) {
              info.tab.actions.openResource(url, options);
              return;
            }
          }
        } catch {
          // fallback
        }
      }

      function handleClear() {
        state.files = {};
        state.activePath = null;
        notify();
      }

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
            h('button', {
              onClick: handleClear,
              title: 'Clear list',
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
          ),

          // Active indicator banner if running
          state.activePath ? h('div', {
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
            }, state.activePath)
          ) : null,

          // Stats chips & Filter buttons
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
            h('button', {
              onClick: () => { setFilter('all'); state.filter = 'all'; },
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
              onClick: () => { setFilter('changes'); state.filter = 'changes'; },
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
              onClick: () => { setFilter('reads'); state.filter = 'reads'; },
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
            placeholder: 'Filter files...',
            value: search,
            onChange: e => {
              setSearch(e.target.value);
              state.searchQuery = e.target.value;
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
          }, 'No files touched yet in this session.') :
          visible.map(f => {
            const badgeStyle = f.status === 'M'
              ? { bg: 'rgba(245, 158, 11, 0.16)', text: '#f59e0b', border: 'rgba(245, 158, 11, 0.35)', label: 'M' }
              : f.status === 'A'
              ? { bg: 'rgba(16, 185, 129, 0.16)', text: '#10b981', border: 'rgba(16, 185, 129, 0.35)', label: 'A' }
              : { bg: 'rgba(59, 130, 246, 0.12)', text: '#60a5fa', border: 'rgba(59, 130, 246, 0.25)', label: 'R' };

            return h('div', {
              key: f.path,
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 8px',
                margin: '2px 0',
                borderRadius: '5px',
                border: f.active ? '1px solid #10b981' : '1px solid transparent',
                background: f.active ? 'rgba(16, 185, 129, 0.08)' : 'transparent',
                transition: 'background 0.15s ease'
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
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 } },
                f.active ? h('span', {
                  style: {
                    fontSize: '10px',
                    fontWeight: 600,
                    color: '#10b981',
                    textTransform: 'uppercase'
                  }
                }, 'Active') : null,

                h('button', {
                  onClick: () => openSingleFile(f.path, f.line),
                  title: 'View file in right tab',
                  style: {
                    padding: '2px 7px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
                    background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06))',
                    color: 'inherit',
                    cursor: 'pointer'
                  }
                }, 'View')
              )
            );
          })
        )
      );
    }

    return {
      inject: ['sidebarRight', 'sidebarRightTabs', 'slots', 'sessions'],
      apply(ctx) {
        let activeUnsubscribe = null;
        let currentSessionId = null;

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
                description: () => 'Real-time modified files and live execution tracker'
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

        function ensureTabOpen() {
          if (state.autoOpenOpenedThisTurn) return;
          state.autoOpenOpenedThisTurn = true;
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

          for (const entry of change.entries) {
            if (!entry || entry.type !== 'event' || !entry.event) continue;
            const ev = entry.event;

            if (ev.type === 'turn/start') {
              state.autoOpenOpenedThisTurn = false;
              clearActive();
            }

            if (ev.type === 'tool/call' && ev.data) {
              const toolName = ev.data.name;
              const extracted = extractFilePath(toolName, ev.data.arguments);
              if (extracted && extracted.path) {
                recordFile(extracted.path, extracted.status, extracted.line);
                // Open the single Git Tree tab ONCE per turn when editing starts
                ensureTabOpen();
              }
            }

            if (ev.type === 'step/end' || ev.type === 'turn/end') {
              clearActive();
            }

            if (ev.type === 'workspace/changes') {
              clearActive();
            }
          }
        }

        function bindSession(sessionId) {
          if (activeUnsubscribe) {
            activeUnsubscribe();
            activeUnsubscribe = null;
          }
          currentSessionId = sessionId;
          state.sessionId = sessionId;
          if (!sessionId) return;

          try {
            const binding = ctx.sessions?.binding(sessionId);
            if (binding && binding.eventSource && typeof binding.eventSource.subscribe === 'function') {
              activeUnsubscribe = binding.eventSource.subscribe(() => {
                handleSessionEvents(sessionId, binding.eventSource);
              });
            }
          } catch (e) {
            console.warn('[dsh-live-inspector] Failed to bind session:', e);
          }
        }

        if (ctx.sidebarRight && ctx.sidebarRight.mounted) {
          ctx.effect(() => {
            const unsub = ctx.sidebarRight.mounted.subscribe(() => {
              const sid = ctx.sidebarRight.mounted.getSnapshot();
              if (sid !== currentSessionId) {
                bindSession(sid);
              }
            });
            const initialSid = ctx.sidebarRight.mounted.getSnapshot();
            if (initialSid) bindSession(initialSid);

            return () => {
              unsub();
              if (activeUnsubscribe) activeUnsubscribe();
            };
          }, 'dsh-live-inspector: session watcher');
        }

        console.info('[dsh-live-inspector] Git Tree tab registered. Single-tab memory-efficient tracking active.');
      }
    };
  }
});
