window.__ModuleLoader__.load({
  id: 'dsh-live-inspector',
  factory(require) {
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
      } catch (e) {
        return null;
      }
      if (!args || typeof args !== 'object') return null;

      if (name === 'write' || name === 'edit' || name === 'write_file') {
        const fp = args.file_path || args.path;
        if (typeof fp === 'string' && fp.length > 0) {
          return { path: fp, line: typeof args.offset === 'number' ? args.offset : undefined };
        }
      }
      if (name === 'read') {
        const fp = args.file_path || args.path;
        if (typeof fp === 'string' && fp.length > 0) {
          return { path: fp, line: typeof args.offset === 'number' ? args.offset : undefined };
        }
      }
      if (name === 'str_replace_editor') {
        const fp = args.path;
        if (typeof fp === 'string' && fp.length > 0) {
          return { path: fp };
        }
      }
      return null;
    }

    return {
      inject: ['sidebarRight', 'sessions'],
      apply(ctx) {
        let activeUnsubscribe = null;
        let currentSessionId = null;
        let lastOpened = null;
        let debounceTimer = null;

        function triggerOpen(url, options) {
          if (typeof window !== 'undefined' && window.localStorage?.getItem('dsh.live-inspector.disabled') === 'true') {
            return;
          }
          if (lastOpened === url) return;
          lastOpened = url;

          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            try {
              if (ctx.sidebarRight && typeof ctx.sidebarRight.openResource === 'function') {
                ctx.sidebarRight.openResource(url, options);
              }
            } catch (err) {
              console.warn('[dsh-live-inspector] openResource error:', err);
            }
          }, 100);
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
              lastOpened = null;
            }

            // 1. Tool Call: file edit, write, read
            if (ev.type === 'tool/call' && ev.data) {
              const toolName = ev.data.name;
              const extracted = extractFilePath(toolName, ev.data.arguments);
              if (extracted && extracted.path) {
                const cleanPath = extracted.path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
                const url = `dsh-resource://file/session/${encodeSegment(sessionId)}/${encodePath(cleanPath)}`;
                const options = extracted.line ? { params: { line: extracted.line } } : undefined;
                triggerOpen(url, options);
              }
            }

            // 2. Turn changes: git diff summary at turn end
            if (ev.type === 'workspace/changes' && ev.data && typeof ev.data.turn === 'number') {
              const reviewUrl = `dsh-resource://changes-review/session/${encodeSegment(sessionId)}/${ev.seq}/${ev.data.turn}`;
              triggerOpen(reviewUrl, { params: { index: 0 } });
            }
          }
        }

        function bindSession(sessionId) {
          if (activeUnsubscribe) {
            activeUnsubscribe();
            activeUnsubscribe = null;
          }
          currentSessionId = sessionId;
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

        console.info('[dsh-live-inspector] Plugin loaded. Live file & diff auto-reveal ready.');
      }
    };
  }
});
