// My Office integration for Oh My Pi (omp.sh).
// Reports session lifecycle, prompts, and tool calls to My Office (http://127.0.0.1:4310/event).

const PORT = Number(process.env.OFFICE_PORT || 4310);

interface OmpContext {
  cwd?: string;
  model?: string | { provider?: string; id?: string; name?: string; modelId?: string };
  currentModel?: string | { provider?: string; id?: string; name?: string; modelId?: string };
  sessionManager?: { getSessionFile?: () => string };
}

interface OmpExtra {
  model?: string | { provider?: string; id?: string; name?: string; modelId?: string };
  title?: string;
  prompt?: string;
  message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  source?: string;
  reason?: string;
  [key: string]: unknown;
}

interface OmpToolEvent {
  toolName?: string;
  tool?: string | { name?: string };
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  prompt?: string;
  willContinue?: boolean;
  planContent?: string;
}

interface OmpPi {
  getSessionName?: () => string;
  on: (event: string, handler: (event: OmpToolEvent, ctx: OmpContext) => void | Promise<void>) => void;
}

function extractModel(ctx?: OmpContext, extra?: OmpExtra): string | null {
  const raw = (ctx && (ctx.model || ctx.currentModel)) || (extra && extra.model);
  if (!raw) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s && s !== '[object Object]' ? s : null;
  }
  if (typeof raw === 'object') {
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
    const id = typeof raw.id === 'string' ? raw.id.trim()
      : (typeof raw.name === 'string' ? raw.name.trim()
      : (typeof raw.modelId === 'string' ? raw.modelId.trim() : ''));
    if (provider && id) return `${provider}/${id}`;
    if (id) return id;
  }
  return null;
}

function extractTitle(pi: OmpPi, extra?: OmpExtra): string | null {
  if (extra && typeof extra.title === 'string' && extra.title.trim()) {
    const t = extra.title.trim();
    return t !== '[object Object]' ? t : null;
  }
  if (typeof pi?.getSessionName === 'function') {
    try {
      const name = pi.getSessionName();
      if (typeof name === 'string' && name.trim()) {
        const s = name.trim();
        return s !== '[object Object]' ? s : null;
      }
    } catch { /* ignored */ }
  }
  return null;
}

export default function ompOfficeExtension(pi: OmpPi): void {
  const send = (ev: string, ctx?: OmpContext, extra: OmpExtra = {}) => {
    try {
      const cwd = (ctx && typeof ctx.cwd === 'string' && ctx.cwd) || process.cwd();
      const sessionFile = ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionFile === 'function'
        ? ctx.sessionManager.getSessionFile() : null;
      const file = typeof sessionFile === 'string' && sessionFile.trim() ? sessionFile.trim() : null;
      const sid = 'omp:' + (file || cwd);
      const model = extractModel(ctx, extra);
      const title = extractTitle(pi, extra);

      const payload = {
        hook_event_name: ev,
        session_id: sid,
        cwd,
        agent: 'omp',
        entrypoint: 'omp',
        ...(model ? { model } : {}),
        ...(title ? { name: title } : {}),
        ...(file ? { transcript_path: file } : {}),
        ...extra,
      };

      fetch(`http://127.0.0.1:${PORT}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(500),
      }).catch(() => {});
    } catch { /* ignored */ }
  };

  let lastPrompt = '';
  pi.on('session_start', async (_e, ctx) => send('SessionStart', ctx, { source: 'omp' }));
  pi.on('before_agent_start', (e, ctx) => {
    lastPrompt = e?.prompt || '';
    send('UserPromptSubmit', ctx, { prompt: lastPrompt || '...' });
  });
  pi.on('agent_start', (_e, ctx) => {
    if (!lastPrompt) send('UserPromptSubmit', ctx, { prompt: '...' });
    lastPrompt = '';
  });

  const onToolStart = (e: OmpToolEvent, ctx: OmpContext) => {
    const tool = typeof e?.toolName === 'string' ? e.toolName : (typeof e?.tool === 'string' ? e.tool : (e?.tool?.name || 'tool'));
    send('PreToolUse', ctx, { tool_name: tool, tool_input: e?.args || e?.input || {} });
  };
  pi.on('tool_execution_start', onToolStart);
  pi.on('tool_call', onToolStart);

  pi.on('tool_execution_end', (e, ctx) => {
    const tool = typeof e?.toolName === 'string' ? e.toolName : (typeof e?.tool === 'string' ? e.tool : (e?.tool?.name || 'tool'));
    send('PostToolUse', ctx, { tool_name: tool });
  });

  pi.on('tool_approval_requested', (e, ctx) => {
    const tool = typeof e?.toolName === 'string' ? e.toolName : (typeof e?.tool === 'string' ? e.tool : (e?.tool?.name || 'tool'));
    send('PermissionRequest', ctx, { tool_name: tool, tool_input: e?.args || e?.input || {} });
  });

  pi.on('tool_approval_resolved', (e, ctx) => {
    const tool = typeof e?.toolName === 'string' ? e.toolName : (typeof e?.tool === 'string' ? e.tool : (e?.tool?.name || 'tool'));
    send('PostToolUse', ctx, { tool_name: tool });
  });

  pi.on('plan_review_requested', (e, ctx) => {
    send('PermissionRequest', ctx, { tool_name: 'Plan', tool_input: { plan: e?.planContent } });
  });

  pi.on('plan_review_resolved', (_e, ctx) => {
    send('PostToolUse', ctx, { tool_name: 'Plan' });
  });

  pi.on('agent_settled', (_e, ctx) => {
    send('Stop', ctx);
  });

  pi.on('agent_end', (e, ctx) => {
    if (e?.willContinue === true) return;
    send('Stop', ctx);
  });

  pi.on('session_shutdown', (_e, ctx) => send('SessionEnd', ctx, { reason: 'exit' }));
}
