// Runs on UserPromptSubmit. If .claude/pending-doc-updates.log has content
// (written by .claude/githooks/post-commit after a manual `git commit`),
// surface it as additional context so Claude reviews whether the
// Smart-Connect-SAP Obsidian vault docs and/or memory need updating.
// Claude is responsible for clearing the log after acting on it.
const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, '..', 'pending-doc-updates.log');

try {
  if (!fs.existsSync(logPath)) process.exit(0);
  const content = fs.readFileSync(logPath, 'utf8').trim();
  if (!content) process.exit(0);

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        'Hay commits de git desde la última revisión de documentación de Smart-Connect-SAP. ' +
        'Evalúa si el vault de Obsidian (Smart-Connect-SAP) y/o la memoria persistente necesitan ' +
        'actualizarse por estos cambios. Si actualizas, trunca .claude/pending-doc-updates.log al terminar ' +
        '(ej. con Bash: > .claude/pending-doc-updates.log). Commits pendientes:\n\n' + content,
    },
  }));
} catch {
  // Never block the user's prompt on a hook failure.
  process.exit(0);
}
