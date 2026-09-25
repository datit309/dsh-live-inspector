# dsh-live-inspector

DSH Web client plugin that automatically monitors file operations and changes, opening them in the right sidebar (`sidebar.right` tab) in real time:

- **Live File Tracking**: Automatically reveals files being read, written, or edited (`read`, `write`, `edit`, `str_replace_editor`) during agent execution.
- **Auto Changes Review**: Automatically opens the git diff review tab (`changes-review`) at the end of a turn when changes are recorded.
- **Debounced & Safe**: Only reacts to live appended session events, avoiding interference with session history replay.
- **Opt-out switch**: Set `localStorage.setItem('dsh.live-inspector.disabled', 'true')` in browser console to temporarily disable.
