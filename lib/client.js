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
          files: {}, // path -> { path, name, dir, ext, status, active, timestamp, line, count, diffs: [] }
          activePath: null,
          filter: 'all',
          searchQuery: '',
          selectedPath: null,
          viewLayout: 'tree', // 'tree' | 'flat'
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

    // High-precision token/word-level diff for intra-line changes (VS Code / GitHub style)
    function wordDiff(oldStr, newStr) {
      if (!oldStr && !newStr) return { oldParts: [], newParts: [] };
      if (!oldStr) return { oldParts: [], newParts: [{ text: newStr, changed: true }] };
      if (!newStr) return { oldParts: [{ text: oldStr, changed: true }], newParts: [] };
      if (oldStr === newStr) {
        return {
          oldParts: [{ text: oldStr, changed: false }],
          newParts: [{ text: newStr, changed: false }]
        };
      }

      const tokenRegex = /(\s+|[a-zA-Z0-9_$]+|[^\s\w])/g;
      const oldTokens = oldStr.match(tokenRegex) || [oldStr];
      const newTokens = newStr.match(tokenRegex) || [newStr];

      let prefix = 0;
      while (prefix < oldTokens.length && prefix < newTokens.length && oldTokens[prefix] === newTokens[prefix]) {
        prefix++;
      }

      let suffix = 0;
      while (
        suffix < (oldTokens.length - prefix) &&
        suffix < (newTokens.length - prefix) &&
        oldTokens[oldTokens.length - 1 - suffix] === newTokens[newTokens.length - 1 - suffix]
      ) {
        suffix++;
      }

      const oldPrefix = oldTokens.slice(0, prefix).join('');
      const oldMid = oldTokens.slice(prefix, oldTokens.length - suffix).join('');
      const oldSuffix = oldTokens.slice(oldTokens.length - suffix).join('');

      const newPrefix = newTokens.slice(0, prefix).join('');
      const newMid = newTokens.slice(prefix, newTokens.length - suffix).join('');
      const newSuffix = newTokens.slice(newTokens.length - suffix).join('');

      return {
        oldParts: [
          { text: oldPrefix, changed: false },
          { text: oldMid, changed: true },
          { text: oldSuffix, changed: false }
        ].filter(p => p.text.length > 0),
        newParts: [
          { text: newPrefix, changed: false },
          { text: newMid, changed: true },
          { text: newSuffix, changed: false }
        ].filter(p => p.text.length > 0)
      };
    }

    // Professional line-aligned split diff calculation with word-level highlights
    function computeSplitDiff(oldText, newText, startLine = 1) {
      const oldLines = typeof oldText === 'string' ? oldText.split('\n') : [];
      const newLines = typeof newText === 'string' ? newText.split('\n') : [];

      let prefixCount = 0;
      while (prefixCount < oldLines.length && prefixCount < newLines.length && oldLines[prefixCount] === newLines[prefixCount]) {
        prefixCount++;
      }

      let suffixCount = 0;
      while (
        suffixCount < (oldLines.length - prefixCount) &&
        suffixCount < (newLines.length - prefixCount) &&
        oldLines[oldLines.length - 1 - suffixCount] === newLines[newLines.length - 1 - suffixCount]
      ) {
        suffixCount++;
      }

      const oldDiff = oldLines.slice(prefixCount, oldLines.length - suffixCount);
      const newDiff = newLines.slice(prefixCount, newLines.length - suffixCount);

      const rows = [];
      let curOldNo = startLine;
      let curNewNo = startLine;

      // Prefix context lines (up to 3 lines)
      const contextPrefixStart = Math.max(0, prefixCount - 3);
      for (let i = contextPrefixStart; i < prefixCount; i++) {
        rows.push({
          left: { no: curOldNo + i, text: oldLines[i], kind: 'context', parts: [{ text: oldLines[i], changed: false }] },
          right: { no: curNewNo + i, text: newLines[i], kind: 'context', parts: [{ text: newLines[i], changed: false }] }
        });
      }
      curOldNo += prefixCount;
      curNewNo += prefixCount;

      // Changed lines (aligned side-by-side with word-level diffing)
      const maxDiff = Math.max(oldDiff.length, newDiff.length);
      for (let i = 0; i < maxDiff; i++) {
        const oldL = i < oldDiff.length ? oldDiff[i] : null;
        const newL = i < newDiff.length ? newDiff[i] : null;

        let parts = { oldParts: [], newParts: [] };
        if (oldL !== null && newL !== null) {
          parts = wordDiff(oldL, newL);
        } else if (oldL !== null) {
          parts.oldParts = [{ text: oldL, changed: true }];
        } else if (newL !== null) {
          parts.newParts = [{ text: newL, changed: true }];
        }

        const leftCell = oldL !== null ? {
          no: curOldNo + i,
          text: oldL,
          kind: 'del',
          parts: parts.oldParts
        } : null;

        const rightCell = newL !== null ? {
          no: curNewNo + i,
          text: newL,
          kind: 'add',
          parts: parts.newParts
        } : null;

        rows.push({ left: leftCell, right: rightCell });
      }
      curOldNo += oldDiff.length;
      curNewNo += newDiff.length;

      // Suffix context lines (up to 3 lines)
      const suffixLines = Math.min(3, suffixCount);
      for (let i = 0; i < suffixLines; i++) {
        const oldIdx = oldLines.length - suffixCount + i;
        const newIdx = newLines.length - suffixCount + i;
        rows.push({
          left: { no: curOldNo + i, text: oldLines[oldIdx], kind: 'context', parts: [{ text: oldLines[oldIdx], changed: false }] },
          right: { no: curNewNo + i, text: newLines[newIdx], kind: 'context', parts: [{ text: newLines[newIdx], changed: false }] }
        });
      }

      return {
        rows,
        oldLinesCount: oldLines.length,
        newLinesCount: newLines.length,
        delCount: oldDiff.length,
        addCount: newDiff.length
      };
    }

    // GitHub-style 5-square diffstat mini bar
    function DiffStatBar({ addCount, delCount }) {
      const total = addCount + delCount;
      if (total === 0) return null;
      const greenBoxes = Math.min(5, Math.max(addCount > 0 ? 1 : 0, Math.round((addCount / total) * 5)));
      const redBoxes = Math.min(5 - greenBoxes, Math.max(delCount > 0 ? 1 : 0, 5 - greenBoxes));
      const grayBoxes = Math.max(0, 5 - greenBoxes - redBoxes);

      return h('span', {
        title: '+' + addCount + ' / -' + delCount,
        style: { display: 'inline-flex', gap: '2px', alignItems: 'center' }
      },
        Array.from({ length: greenBoxes }).map((_, i) =>
          h('span', { key: 'g' + i, style: { width: '5px', height: '5px', borderRadius: '1px', background: '#10b981' } })
        ),
        Array.from({ length: redBoxes }).map((_, i) =>
          h('span', { key: 'r' + i, style: { width: '5px', height: '5px', borderRadius: '1px', background: '#ef4444' } })
        ),
        Array.from({ length: grayBoxes }).map((_, i) =>
          h('span', { key: 'gr' + i, style: { width: '5px', height: '5px', borderRadius: '1px', background: 'rgba(255,255,255,0.15)' } })
        )
      );
    }

    // Extension Badge / Icon
    function FileExtBadge({ ext }) {
      let bg = 'rgba(255,255,255,0.06)';
      let color = 'inherit';
      let label = ext.toUpperCase().slice(0, 4);

      if (ext === 'ts' || ext === 'tsx') {
        bg = 'rgba(49, 120, 198, 0.2)';
        color = '#60a5fa';
      } else if (ext === 'js' || ext === 'jsx') {
        bg = 'rgba(247, 223, 30, 0.2)';
        color = '#facc15';
      } else if (ext === 'json') {
        bg = 'rgba(16, 185, 129, 0.2)';
        color = '#34d399';
      } else if (ext === 'css' || ext === 'scss') {
        bg = 'rgba(236, 72, 153, 0.2)';
        color = '#f472b6';
      } else if (ext === 'md') {
        bg = 'rgba(168, 85, 247, 0.2)';
        color = '#c084fc';
      }

      return h('span', {
        style: {
          padding: '1px 4px',
          borderRadius: '3px',
          fontSize: '9px',
          fontWeight: 700,
          fontFamily: 'monospace',
          background: bg,
          color: color,
          flexShrink: 0
        }
      }, label || 'FILE');
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
              newText: content,
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
      const ext = name.includes('.') ? name.split('.').pop() : '';

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
          line: line || 1,
          time: Date.now()
        });
      }

      state.files[cleanPath] = {
        path: cleanPath,
        name: name,
        dir: dir,
        ext: ext,
        status: nextStatus,
        active: true,
        line: line,
        timestamp: Date.now(),
        count: (existing ? existing.count : 0) + 1,
        diffs: diffs
      };
      state.activePath = cleanPath;

      if (!state.selectedPath || nextStatus === 'M' || nextStatus === 'A') {
        state.selectedPath = cleanPath;
      }

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

      if (tabActions && typeof tabActions.openResource === 'function') {
        try {
          tabActions.openResource(url, options);
          return;
        } catch (e) {
          console.warn('[dsh-live-inspector] tabActions.openResource error:', e);
        }
      }
      if (globalCtx?.sidebarRight && typeof globalCtx.sidebarRight.openResourceIn === 'function') {
        try {
          globalCtx.sidebarRight.openResourceIn(sessionId, url, options);
          return;
        } catch (e) {
          console.warn('[dsh-live-inspector] openResourceIn error:', e);
        }
      }
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

    // Render word-diff parts
    function renderParts(parts, kind) {
      if (!parts || parts.length === 0) return null;
      return parts.map((p, i) => {
        if (!p.changed) return h('span', { key: i }, p.text);
        if (kind === 'del') {
          return h('span', {
            key: i,
            style: {
              background: 'rgba(239, 68, 68, 0.4)',
              color: '#fff',
              borderRadius: '2px',
              padding: '0 2px',
              fontWeight: 600
            }
          }, p.text);
        }
        return h('span', {
          key: i,
          style: {
            background: 'rgba(16, 185, 129, 0.4)',
            color: '#fff',
            borderRadius: '2px',
            padding: '0 2px',
            fontWeight: 600
          }
        }, p.text);
      });
    }

    // Professional Side-by-Side Split Diff View with word-level highlight & synced rows
    function SplitDiffView({ computed, wrapLines }) {
      const { rows } = computed;
      const emptyHatch = 'repeating-linear-gradient(45deg, rgba(255,255,255,0.015), rgba(255,255,255,0.015) 6px, rgba(0,0,0,0.1) 6px, rgba(0,0,0,0.1) 12px)';

      return h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))',
          borderRadius: '6px',
          overflow: 'hidden',
          fontFamily: 'var(--ds-font-family-code, "JetBrains Mono", monospace)',
          fontSize: '11px',
          background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.28))'
        }
      },
        // Column Left Header (Original / Before)
        h('div', {
          style: {
            gridColumn: '1 / 2',
            padding: '5px 10px',
            background: 'rgba(239, 68, 68, 0.12)',
            borderBottom: '1px solid rgba(239, 68, 68, 0.22)',
            borderRight: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))',
            color: '#f87171',
            fontWeight: 600,
            fontSize: '10px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }
        },
          h('span', null, '◀ ORIGINAL (BEFORE)'),
          h('span', { style: { opacity: 0.8, fontSize: '9px' } }, '-' + computed.delCount + ' lines')
        ),

        // Column Right Header (Modified / After)
        h('div', {
          style: {
            gridColumn: '2 / 3',
            padding: '5px 10px',
            background: 'rgba(16, 185, 129, 0.12)',
            borderBottom: '1px solid rgba(16, 185, 129, 0.22)',
            color: '#34d399',
            fontWeight: 600,
            fontSize: '10px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }
        },
          h('span', null, '▶ MODIFIED (AFTER)'),
          h('span', { style: { opacity: 0.8, fontSize: '9px' } }, '+' + computed.addCount + ' lines')
        ),

        // Synchronized Aligned Rows
        h('div', {
          style: {
            gridColumn: '1 / -1',
            maxHeight: '480px',
            overflowY: 'auto',
            overflowX: wrapLines ? 'hidden' : 'auto'
          }
        },
          rows.map((row, idx) => {
            const left = row.left;
            const right = row.right;

            return h('div', {
              key: idx,
              style: {
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                minHeight: '22px',
                lineHeight: '22px',
                borderBottom: '0.5px solid rgba(255,255,255,0.02)'
              }
            },
              // LEFT CELL
              h('div', {
                style: {
                  display: 'flex',
                  minWidth: 0,
                  borderRight: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))',
                  background: left ? (left.kind === 'del' ? 'rgba(239, 68, 68, 0.08)' : 'transparent') : emptyHatch
                }
              },
                // Gutter number
                h('div', {
                  style: {
                    width: '36px',
                    flexShrink: 0,
                    textAlign: 'right',
                    paddingRight: '6px',
                    userSelect: 'none',
                    fontSize: '10px',
                    color: left?.kind === 'del' ? '#f87171' : 'var(--dsw-alias-label-tertiary, #666)',
                    background: left?.kind === 'del' ? 'rgba(239, 68, 68, 0.16)' : 'transparent',
                    borderRight: '1px solid rgba(255,255,255,0.05)'
                  }
                }, left ? String(left.no) : ''),
                // Content text with word-level highlight
                h('div', {
                  style: {
                    flex: 1,
                    minWidth: 0,
                    padding: '0 8px',
                    whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
                    wordBreak: wrapLines ? 'break-all' : 'normal',
                    color: left?.kind === 'del' ? '#fca5a5' : 'var(--dsw-alias-label-secondary, #bbb)'
                  }
                }, left ? renderParts(left.parts, left.kind) : '')
              ),

              // RIGHT CELL
              h('div', {
                style: {
                  display: 'flex',
                  minWidth: 0,
                  background: right ? (right.kind === 'add' ? 'rgba(16, 185, 129, 0.08)' : 'transparent') : emptyHatch
                }
              },
                // Gutter number
                h('div', {
                  style: {
                    width: '36px',
                    flexShrink: 0,
                    textAlign: 'right',
                    paddingRight: '6px',
                    userSelect: 'none',
                    fontSize: '10px',
                    color: right?.kind === 'add' ? '#34d399' : 'var(--dsw-alias-label-tertiary, #666)',
                    background: right?.kind === 'add' ? 'rgba(16, 185, 129, 0.16)' : 'transparent',
                    borderRight: '1px solid rgba(255,255,255,0.05)'
                  }
                }, right ? String(right.no) : ''),
                // Content text with word-level highlight
                h('div', {
                  style: {
                    flex: 1,
                    minWidth: 0,
                    padding: '0 8px',
                    whiteSpace: wrapLines ? 'pre-wrap' : 'pre',
                    wordBreak: wrapLines ? 'break-all' : 'normal',
                    color: right?.kind === 'add' ? '#86efac' : 'var(--dsw-alias-label-secondary, #bbb)'
                  }
                }, right ? renderParts(right.parts, right.kind) : '')
              )
            );
          })
        )
      );
    }

    // Professional Unified Diff View with word-level highlight
    function UnifiedDiffView({ computed, wrapLines }) {
      const { rows } = computed;

      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))',
          borderRadius: '6px',
          overflow: 'hidden',
          fontFamily: 'var(--ds-font-family-code, "JetBrains Mono", monospace)',
          fontSize: '11px',
          background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.28))',
          maxHeight: '480px',
          overflowY: 'auto',
          overflowX: wrapLines ? 'hidden' : 'auto'
        }
      },
        rows.map((row, idx) => {
          if (row.left?.kind === 'context') {
            return h('div', {
              key: idx,
              style: {
                display: 'flex',
                lineHeight: '22px',
                minHeight: '22px',
                color: 'var(--dsw-alias-label-secondary, #bbb)',
                borderBottom: '0.5px solid rgba(255,255,255,0.02)'
              }
            },
              h('span', { style: { width: '36px', textAlign: 'right', paddingRight: '6px', opacity: 0.5, userSelect: 'none' } }, String(row.left.no)),
              h('span', { style: { width: '36px', textAlign: 'right', paddingRight: '6px', opacity: 0.5, userSelect: 'none' } }, String(row.right.no)),
              h('span', { style: { width: '18px', textAlign: 'center', opacity: 0.3 } }, ' '),
              h('span', { style: { flex: 1, paddingRight: '8px', whiteSpace: wrapLines ? 'pre-wrap' : 'pre', wordBreak: wrapLines ? 'break-all' : 'normal' } }, row.left.text)
            );
          }

          const elements = [];
          if (row.left && row.left.kind === 'del') {
            elements.push(h('div', {
              key: 'del-' + idx,
              style: {
                display: 'flex',
                lineHeight: '22px',
                minHeight: '22px',
                background: 'rgba(239, 68, 68, 0.09)',
                color: '#fca5a5',
                borderBottom: '0.5px solid rgba(255,255,255,0.02)'
              }
            },
              h('span', { style: { width: '36px', textAlign: 'right', paddingRight: '6px', color: '#f87171', background: 'rgba(239, 68, 68, 0.16)', userSelect: 'none' } }, String(row.left.no)),
              h('span', { style: { width: '36px', textAlign: 'right', paddingRight: '6px', background: 'rgba(239, 68, 68, 0.16)', userSelect: 'none' } }, ''),
              h('span', { style: { width: '18px', textAlign: 'center', color: '#ef4444', fontWeight: 700 } }, '-'),
              h('span', { style: { flex: 1, paddingRight: '8px', whiteSpace: wrapLines ? 'pre-wrap' : 'pre', wordBreak: wrapLines ? 'break-all' : 'normal' } }, renderParts(row.left.parts, 'del'))
            ));
          }
          if (row.right && row.right.kind === 'add') {
            elements.push(h('div', {
              key: 'add-' + idx,
              style: {
                display: 'flex',
                lineHeight: '22px',
                minHeight: '22px',
                background: 'rgba(16, 185, 129, 0.09)',
                color: '#86efac',
                borderBottom: '0.5px solid rgba(255,255,255,0.02)'
              }
            },
              h('span', { style: { width: '36px', textAlign: 'right', paddingRight: '6px', background: 'rgba(16, 185, 129, 0.16)', userSelect: 'none' } }, ''),
              h('span', { style: { width: '36px', textAlign: 'right', paddingRight: '6px', color: '#34d399', background: 'rgba(16, 185, 129, 0.16)', userSelect: 'none' } }, String(row.right.no)),
              h('span', { style: { width: '18px', textAlign: 'center', color: '#10b981', fontWeight: 700 } }, '+'),
              h('span', { style: { flex: 1, paddingRight: '8px', whiteSpace: wrapLines ? 'pre-wrap' : 'pre', wordBreak: wrapLines ? 'break-all' : 'normal' } }, renderParts(row.right.parts, 'add'))
            ));
          }
          return elements;
        })
      );
    }

    // Detail Inspector for the Selected File
    function SelectedFileDiffInspector({ file, currentSid, tabActions }) {
      const [viewMode, setViewMode] = React.useState('split'); // 'split' | 'unified'
      const [wrapLines, setWrapLines] = React.useState(true);
      const [activeDiffIdx, setActiveDiffIdx] = React.useState(0);

      if (!file) {
        return h('div', {
          style: {
            padding: '48px 16px',
            textAlign: 'center',
            color: 'var(--dsw-alias-label-tertiary, #666)',
            fontSize: '12px'
          }
        },
          h('div', { style: { fontSize: '24px', marginBottom: '8px' } }, '🌿'),
          h('div', { style: { fontWeight: 500 } }, 'No file selected'),
          h('div', { style: { fontSize: '11px', marginTop: '4px', opacity: 0.8 } }, 'Select a file above to inspect its diff side-by-side.')
        );
      }

      const diffs = file.diffs || [];
      const hasDiffs = diffs.length > 0;
      const currentDiff = diffs[activeDiffIdx] || diffs[0];

      const computed = React.useMemo(() => {
        if (!currentDiff) return null;
        return computeSplitDiff(currentDiff.oldText, currentDiff.newText, currentDiff.line || 1);
      }, [currentDiff]);

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          background: 'var(--dsw-alias-bg-base, transparent)'
        }
      },
        // Detail Header
        h('div', {
          style: {
            padding: '8px 14px',
            borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
            background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.03))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '8px'
          }
        },
          // Left: File Identity & Breadcrumbs
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
            h(FileExtBadge, { ext: file.ext }),
            h('span', {
              style: {
                padding: '1px 6px',
                borderRadius: '3px',
                fontSize: '10px',
                fontWeight: 700,
                fontFamily: 'monospace',
                background: file.status === 'M' ? 'rgba(245, 158, 11, 0.2)' : file.status === 'A' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(59, 130, 246, 0.2)',
                color: file.status === 'M' ? '#f59e0b' : file.status === 'A' ? '#10b981' : '#60a5fa',
                border: '1px solid ' + (file.status === 'M' ? 'rgba(245, 158, 11, 0.4)' : file.status === 'A' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(59, 130, 246, 0.4)')
              }
            }, file.status === 'M' ? 'MODIFIED' : file.status === 'A' ? 'CREATED' : 'READ'),

            h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              h('span', { style: { fontWeight: 600, fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' } }, file.name),
              file.dir !== '.' ? h('span', { style: { marginLeft: '6px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #888)' } }, file.dir) : null
            ),

            computed ? h(DiffStatBar, { addCount: computed.addCount, delCount: computed.delCount }) : null
          ),

          // Right: Action buttons & Layout toggles
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            // Wrap toggle
            hasDiffs ? h('button', {
              onClick: () => setWrapLines(v => !v),
              title: wrapLines ? 'Disable line wrapping' : 'Enable line wrapping',
              style: {
                padding: '2px 6px',
                borderRadius: '4px',
                fontSize: '10px',
                cursor: 'pointer',
                border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.1))',
                background: wrapLines ? 'rgba(255,255,255,0.08)' : 'transparent',
                color: 'var(--dsw-alias-label-secondary, #999)'
              }
            }, 'Wrap') : null,

            // View Mode Toggle (Split 2-cột vs Unified 1-cột)
            hasDiffs ? h('div', {
              style: {
                display: 'flex',
                background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06))',
                borderRadius: '4px',
                padding: '2px',
                border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.1))'
              }
            },
              h('button', {
                onClick: () => setViewMode('split'),
                title: 'Side-by-Side 2 columns',
                style: {
                  padding: '2px 7px',
                  borderRadius: '3px',
                  fontSize: '10px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: 'none',
                  background: viewMode === 'split' ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'transparent',
                  color: viewMode === 'split' ? '#fff' : 'var(--dsw-alias-label-secondary, #999)'
                }
              }, '◫ Split'),
              h('button', {
                onClick: () => setViewMode('unified'),
                title: 'Unified 1 column',
                style: {
                  padding: '2px 7px',
                  borderRadius: '3px',
                  fontSize: '10px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: 'none',
                  background: viewMode === 'unified' ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'transparent',
                  color: viewMode === 'unified' ? '#fff' : 'var(--dsw-alias-label-secondary, #999)'
                }
              }, '☰ Unified')
            ) : null,

            // Open full file in editor
            h('button', {
              onClick: () => openSingleFile(currentSid, file.path, file.line, tabActions),
              title: 'Open full file in Editor',
              style: {
                padding: '3px 8px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 500,
                border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.18))',
                background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08))',
                color: 'inherit',
                cursor: 'pointer'
              }
            }, '↗ Open Editor')
          )
        ),

        // Multiple Edits Step Tabs (if file edited multiple times)
        diffs.length > 1 ? h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 14px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(0,0,0,0.12)'
          }
        },
          h('span', { style: { fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #777)' } }, 'Revisions:'),
          diffs.map((d, idx) =>
            h('button', {
              key: idx,
              onClick: () => setActiveDiffIdx(idx),
              style: {
                padding: '2px 8px',
                borderRadius: '10px',
                fontSize: '10px',
                fontWeight: 500,
                cursor: 'pointer',
                border: activeDiffIdx === idx ? '1px solid var(--dsw-alias-brand-primary, #3b82f6)' : '1px solid transparent',
                background: activeDiffIdx === idx ? 'rgba(59, 130, 246, 0.18)' : 'transparent',
                color: activeDiffIdx === idx ? '#60a5fa' : 'var(--dsw-alias-label-secondary, #888)'
              }
            }, 'Hunk #' + (idx + 1))
          )
        ) : null,

        // Diff Viewer Body
        h('div', {
          style: {
            padding: '10px 14px',
            flex: 1,
            overflowY: 'auto'
          }
        },
          computed ? (
            viewMode === 'split' ? h(SplitDiffView, { computed, wrapLines }) : h(UnifiedDiffView, { computed, wrapLines })
          ) : (
            h('div', {
              style: {
                padding: '32px 16px',
                textAlign: 'center',
                color: 'var(--dsw-alias-label-tertiary, #666)',
                fontSize: '12px'
              }
            }, file.status === 'R' ? 'File was accessed for read only in this session.' : 'No line diff recorded.')
          )
        )
      );
    }

    // GitTree Tab Title Chip
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

    // Main Tab Body Component
    function GitTreeBody(props) {
      let tabInfo = null;
      if (props && typeof props.useTabInfo === 'function') {
        try {
          tabInfo = props.useTabInfo();
        } catch {
          // outside tab scope
        }
      }

      const [activeSid, setActiveSid] = React.useState(resolveCurrentSessionId);
      const [, setTick] = React.useState(0);
      const [listCollapsed, setListCollapsed] = React.useState(false);

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
      const modifiedFiles = fileList.filter(f => f.status === 'M');
      const addedFiles = fileList.filter(f => f.status === 'A');
      const readFiles = fileList.filter(f => f.status === 'R');

      // Auto select first modified file if none selected
      if (sessionData && !sessionData.selectedPath && fileList.length > 0) {
        sessionData.selectedPath = (modifiedFiles[0] || addedFiles[0] || fileList[0]).path;
      }

      const selectedFile = sessionData && sessionData.selectedPath ? sessionData.files[sessionData.selectedPath] : null;

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
          sessionData.selectedPath = null;
          sessionData.reviewUrl = null;
          notify();
        }
      }

      function selectFile(path) {
        if (sessionData) {
          sessionData.selectedPath = path;
          notify();
        }
      }

      const tabActions = tabInfo?.tab?.actions;

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflow: 'hidden',
          fontFamily: 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
          color: 'var(--dsw-alias-label-primary, inherit)',
          fontSize: '13px',
          background: 'var(--dsw-alias-bg-base, transparent)'
        }
      },
        // Top Toolbar
        h('div', {
          style: {
            padding: '10px 14px',
            borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
            background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.025))'
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
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '13px' } },
              h('span', null, '🌿 Source Control & Diff Inspector'),
              h('span', {
                style: {
                  fontSize: '11px',
                  color: 'var(--dsw-alias-label-tertiary, #888)',
                  fontWeight: 'normal'
                }
              }, '(' + fileList.length + ' files)')
            ),

            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              // Full side-by-side review button
              sessionData?.reviewUrl ? h('button', {
                onClick: () => openResourceUrl(currentSid, sessionData.reviewUrl, tabActions),
                title: 'Open full turn review in comparison tab',
                style: {
                  background: 'rgba(37, 99, 235, 0.16)',
                  border: '1px solid rgba(37, 99, 235, 0.4)',
                  color: 'var(--dsw-alias-brand-primary, #60a5fa)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: '4px'
                }
              }, '🔍 Review All') : null,

              h('button', {
                onClick: () => setListCollapsed(v => !v),
                title: listCollapsed ? 'Expand file list' : 'Collapse file list',
                style: {
                  background: 'none',
                  border: 'none',
                  color: 'var(--dsw-alias-label-secondary, #888)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '2px 6px'
                }
              }, listCollapsed ? '▼ Files' : '▲ Collapse'),

              h('button', {
                onClick: handleClear,
                title: 'Clear changes for this session',
                style: {
                  background: 'none',
                  border: 'none',
                  color: 'var(--dsw-alias-label-secondary, #888)',
                  cursor: 'pointer',
                  fontSize: '11px',
                  padding: '2px 6px'
                }
              }, 'Clear')
            )
          ),

          // Active indicator banner if running
          (sessionData && sessionData.activePath) ? h('div', {
            style: {
              padding: '6px 10px',
              borderRadius: '6px',
              background: 'rgba(16, 185, 129, 0.12)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              color: '#10b981',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginBottom: '6px'
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
            h('span', { style: { fontWeight: 500 } }, 'Agent active:'),
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

          // Filter chips & Search (only if list not collapsed)
          !listCollapsed ? h('div', null,
            h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
              h('button', {
                onClick: () => {
                  setFilter('all');
                  if (sessionData) sessionData.filter = 'all';
                },
                style: {
                  padding: '2px 8px',
                  borderRadius: '10px',
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
                  padding: '2px 8px',
                  borderRadius: '10px',
                  border: filter === 'changes' ? '1px solid #f59e0b' : '1px solid transparent',
                  background: filter === 'changes' ? 'rgba(245, 158, 11, 0.15)' : 'transparent',
                  color: filter === 'changes' ? '#f59e0b' : 'inherit',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: (modifiedFiles.length + addedFiles.length) > 0 ? 600 : 'normal'
                }
              }, 'Changes (' + (modifiedFiles.length + addedFiles.length) + ')'),

              h('button', {
                onClick: () => {
                  setFilter('reads');
                  if (sessionData) sessionData.filter = 'reads';
                },
                style: {
                  padding: '2px 8px',
                  borderRadius: '10px',
                  border: filter === 'reads' ? '1px solid #3b82f6' : '1px solid transparent',
                  background: filter === 'reads' ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                  color: filter === 'reads' ? '#3b82f6' : 'inherit',
                  cursor: 'pointer',
                  fontSize: '11px'
                }
              }, 'Reads (' + readFiles.length + ')')
            ),

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
                marginTop: '6px',
                padding: '4px 8px',
                borderRadius: '4px',
                fontSize: '11px',
                border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
                background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.15))',
                color: 'inherit',
                outline: 'none'
              }
            })
          ) : null
        ),

        // Files Tree List Pane (Top / Master)
        !listCollapsed ? h('div', {
          style: {
            maxHeight: '190px',
            overflowY: 'auto',
            padding: '6px 8px',
            borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))',
            background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.1))'
          }
        },
          visible.length === 0 ? h('div', {
            style: {
              padding: '16px 8px',
              textAlign: 'center',
              color: 'var(--dsw-alias-label-tertiary, #666)',
              fontSize: '11px'
            }
          }, 'No files touched in this session yet.') :
          visible.map(f => {
            const isSelected = selectedFile?.path === f.path;
            const badgeStyle = f.status === 'M'
              ? { bg: 'rgba(245, 158, 11, 0.16)', text: '#f59e0b', border: 'rgba(245, 158, 11, 0.35)', label: 'M' }
              : f.status === 'A'
              ? { bg: 'rgba(16, 185, 129, 0.16)', text: '#10b981', border: 'rgba(16, 185, 129, 0.35)', label: 'A' }
              : { bg: 'rgba(59, 130, 246, 0.12)', text: '#60a5fa', border: 'rgba(59, 130, 246, 0.25)', label: 'R' };

            const diffCount = f.diffs ? f.diffs.length : 0;

            return h('div', {
              key: f.path,
              onClick: () => selectFile(f.path),
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 8px',
                margin: '1px 0',
                borderRadius: '4px',
                cursor: 'pointer',
                borderLeft: isSelected ? '3px solid var(--dsw-alias-brand-primary, #3b82f6)' : (f.active ? '3px solid #10b981' : '3px solid transparent'),
                background: isSelected ? 'rgba(59, 130, 246, 0.14)' : (f.active ? 'rgba(16, 185, 129, 0.08)' : 'transparent'),
                transition: 'background 0.1s ease'
              }
            },
              h('div', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  minWidth: 0,
                  flex: 1
                }
              },
                // Status badge
                h('span', {
                  title: f.status === 'M' ? 'Modified' : f.status === 'A' ? 'Created' : 'Read',
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '16px',
                    height: '16px',
                    borderRadius: '3px',
                    fontSize: '10px',
                    fontWeight: 700,
                    fontFamily: 'monospace',
                    background: badgeStyle.bg,
                    color: badgeStyle.text,
                    border: '1px solid ' + badgeStyle.border,
                    flexShrink: 0
                  }
                }, badgeStyle.label),

                // Name and folder
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
                      fontWeight: isSelected ? 600 : 500,
                      fontFamily: 'var(--ds-font-family-code, monospace)',
                      color: isSelected ? 'var(--dsw-alias-brand-primary, #60a5fa)' : 'inherit',
                      fontSize: '12px'
                    }
                  }, f.name),
                  f.dir !== '.' ? h('span', {
                    style: {
                      marginLeft: '6px',
                      fontSize: '10px',
                      color: 'var(--dsw-alias-label-tertiary, #777)'
                    }
                  }, f.dir) : null
                )
              ),

              // Badges & Actions
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 } },
                diffCount > 0 ? h('span', {
                  style: {
                    fontSize: '10px',
                    color: '#f59e0b',
                    background: 'rgba(245, 158, 11, 0.12)',
                    padding: '1px 5px',
                    borderRadius: '8px'
                  }
                }, diffCount + ' diff') : null,

                h('button', {
                  onClick: (e) => {
                    e.stopPropagation();
                    openSingleFile(currentSid, f.path, f.line, tabActions);
                  },
                  title: 'Open in Editor',
                  style: {
                    padding: '1px 6px',
                    borderRadius: '3px',
                    fontSize: '10px',
                    border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary, #888)',
                    cursor: 'pointer'
                  }
                }, 'View')
              )
            );
          })
        ) : null,

        // Selected File Diff Inspector (Bottom / Detail Pane)
        h(SelectedFileDiffInspector, {
          file: selectedFile,
          currentSid,
          tabActions
        })
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
                description: () => 'Source control changes and professional side-by-side diff'
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

        console.info('[dsh-live-inspector] Professional Master-Detail Source Control & Split Diff active.');
      }
    };
  }
});
