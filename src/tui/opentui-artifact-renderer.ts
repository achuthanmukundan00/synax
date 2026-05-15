import type { ArtifactPayload, RiskLevel, SemanticEvent, SemanticEventClass } from './semantic-events';

type OpenTuiCore = typeof import('@opentui/core');
type OpenTuiNode =
  | ReturnType<OpenTuiCore['Box']>
  | ReturnType<OpenTuiCore['Text']>
  | ReturnType<OpenTuiCore['ScrollBox']>;

export interface ArtifactRailState {
  model?: string;
  branch?: string;
  cwd?: string;
  filesTouched: string[];
  approvals: Array<{ action: string; riskLevel: RiskLevel }>;
  costLabel?: string;
  contextLabel?: string;
  uptimeLabel: string;
  provider?: string;
  endpoint?: string;
}

export interface FooterState {
  status: string;
  prompt: string;
  placeholder: string;
  hints: string;
}

const COLORS: Record<SemanticEventClass, string> = {
  plan: '#bd93f9',
  edit: '#00ff87',
  diff: '#bd93f9',
  command: '#8be9fd',
  tool_result: '#00ff87',
  review: '#ffb86c',
  commit: '#bd93f9',
  checkpoint: '#00ff87',
  approval: '#ffb86c',
  status: '#6272a4',
  error: '#ff5555',
  note: '#6272a4',
  assistant_text: '#6272a4',
};

const GLYPHS: Record<SemanticEventClass, string> = {
  plan: '...',
  edit: 'Δ',
  diff: '≠',
  command: '$',
  tool_result: '✓',
  review: '!',
  commit: 'git',
  checkpoint: '✓',
  approval: '!',
  status: '...',
  error: 'x',
  note: '>',
  assistant_text: '>',
};

export function renderArtifactRoot(
  core: OpenTuiCore,
  events: SemanticEvent[],
  rail: ArtifactRailState,
  footer: FooterState,
  terminalWidth: number,
  onSubmit: (value: string) => void,
): OpenTuiNode {
  const rightRailWidth = railWidthFor(terminalWidth);
  const mainChildren =
    events.length > 0 ? events.map((event) => renderArtifactCard(core, event)) : [renderEmptyState(core)];
  const input = core.Input({
    id: 'synax-input',
    value: footer.prompt,
    placeholder: footer.placeholder,
    width: '100%',
    maxLength: 4096,
    focusedBackgroundColor: '#111111',
    onKeyDown: (key) => {
      if (key.name === 'return' || key.name === 'enter') {
        onSubmit(String(input.value ?? ''));
      }
    },
  });

  return core.Box(
    {
      id: 'synax-root',
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      backgroundColor: '#050505',
    },
    core.Box(
      { flexGrow: 1, flexDirection: 'row', minHeight: 1 },
      core.ScrollBox(
        {
          id: 'synax-artifacts',
          flexGrow: 1,
          viewportCulling: true,
          stickyScroll: true,
          stickyStart: 'bottom',
          padding: 1,
          scrollY: true,
        },
        ...mainChildren,
      ),
      ...(rightRailWidth > 0 ? [renderRightRail(core, rail, rightRailWidth)] : []),
    ),
    core.Box(
      {
        id: 'synax-footer',
        height: 4,
        width: '100%',
        flexDirection: 'column',
        border: ['top'],
        borderColor: '#333333',
        paddingX: 1,
      },
      core.Text({ id: 'synax-status', content: footer.status, fg: footerColor(footer.status) }),
      input,
      core.Text({ id: 'synax-hints', content: footer.hints, fg: '#6272a4' }),
    ),
  );
}

export function renderArtifactCard(core: OpenTuiCore, event: SemanticEvent): OpenTuiNode {
  const color = COLORS[event.class];
  const children = renderPayloadRows(core, event.artifact, event.class);
  return core.Box(
    {
      id: event.id,
      width: '100%',
      flexDirection: 'row',
      marginBottom: 1,
    },
    core.Box({ width: 2, backgroundColor: color, marginRight: 1 }),
    core.Box(
      {
        flexGrow: 1,
        flexDirection: 'column',
        border: true,
        borderStyle: 'single',
        borderColor: color,
        title: `${GLYPHS[event.class]} ${labelFor(event.class)}`,
        paddingX: 1,
        paddingY: 0,
      },
      ...children,
    ),
  );
}

function renderPayloadRows(core: OpenTuiCore, payload: ArtifactPayload, eventClass: SemanticEventClass): OpenTuiNode[] {
  if (payload.type === 'plan') {
    return [
      core.Text({ content: payload.title }),
      ...payload.steps.slice(0, 5).map((step, index) => core.Text({ content: `${index + 1}. ${step}`, fg: '#cccccc' })),
      core.Text({ content: '[Execute plan] [Revise]', fg: '#6272a4' }),
    ];
  }
  if (payload.type === 'edit') {
    return [
      core.Text({
        content: `${payload.file}   +${payload.linesAdded} ~${payload.linesModified} -${payload.linesRemoved}`,
        fg: '#cccccc',
      }),
      core.Text({ content: payload.summary, fg: '#ffffff' }),
      core.Text({ content: '[View diff] [Open file]', fg: '#6272a4' }),
    ];
  }
  if (payload.type === 'diff') {
    return [
      core.Text({ content: payload.file, fg: '#cccccc' }),
      ...payload.hunks.slice(0, 12).map((line) => core.Text({ content: line, fg: diffLineColor(line) })),
      core.Text({
        content: payload.hunks.length > 12 ? '[Expand hunk] [Accept] [Discard]' : '[Accept] [Discard]',
        fg: '#6272a4',
      }),
    ];
  }
  if (payload.type === 'command') {
    const status =
      payload.exitCode === undefined
        ? 'Running or queued'
        : payload.exitCode === 0
          ? 'exit 0'
          : `failed exit ${payload.exitCode}`;
    return [
      core.Text({ content: payload.command || 'command', fg: '#ffffff' }),
      core.Text({ content: status, fg: payload.exitCode && payload.exitCode !== 0 ? '#ff5555' : '#6272a4' }),
      ...outputRows(core, payload.stdout, payload.stderr),
      core.Text({ content: '[Show full output] [Retry]', fg: '#6272a4' }),
    ];
  }
  if (payload.type === 'tool_result') {
    return [
      core.Text({ content: payload.title, fg: payload.status === 'error' ? '#ff5555' : '#ffffff' }),
      core.Text({ content: payload.summary || 'completed', fg: '#cccccc' }),
      ...(payload.output ? [core.Text({ content: clipSingleLine(payload.output), fg: '#6272a4' })] : []),
    ];
  }
  if (payload.type === 'approval') {
    return [
      core.Text({ content: payload.action, fg: '#ffffff' }),
      core.Text({
        content: `Risk: ${payload.details}   [${payload.riskLevel.toUpperCase()}]`,
        fg: riskColor(payload.riskLevel),
      }),
      core.Text({ content: payload.choices.join('   '), fg: '#6272a4' }),
    ];
  }
  if (payload.type === 'commit') {
    return [
      core.Text({ content: payload.message, fg: '#ffffff' }),
      core.Text({ content: `Files: ${payload.files.join(', ') || 'unknown'}`, fg: '#cccccc' }),
      core.Text({ content: '[Amend] [Create PR]', fg: '#6272a4' }),
    ];
  }
  if (payload.type === 'checkpoint') {
    return [
      core.Text({ content: payload.title, fg: '#ffffff' }),
      core.Text({ content: `Files: ${payload.files.length}   Git hash: ${payload.hash ?? 'n/a'}`, fg: '#cccccc' }),
      core.Text({ content: '[Restore] [Diff against current]', fg: '#6272a4' }),
    ];
  }
  if (payload.type === 'status') {
    return [
      core.Text({ content: payload.label, fg: COLORS[eventClass] }),
      core.Text({ content: payload.detail ?? '', fg: '#6272a4' }),
    ];
  }
  return [
    core.Text({ content: payload.title, fg: COLORS[eventClass] }),
    ...payload.body
      .split('\n')
      .slice(0, 6)
      .map((line) => core.Text({ content: line, fg: '#cccccc' })),
  ];
}

function outputRows(core: OpenTuiCore, stdout?: string, stderr?: string): OpenTuiNode[] {
  const rows: OpenTuiNode[] = [];
  if (stdout?.trim()) rows.push(core.Text({ content: `stdout: ${clipSingleLine(stdout)}`, fg: '#6272a4' }));
  if (stderr?.trim()) rows.push(core.Text({ content: `stderr: ${clipSingleLine(stderr)}`, fg: '#ff5555' }));
  return rows;
}

function renderRightRail(core: OpenTuiCore, rail: ArtifactRailState, width: number): OpenTuiNode {
  const fileRows = rail.filesTouched
    .slice(-5)
    .map((file) => core.Text({ content: `> ${compactPath(file, width - 2)}`, fg: '#6272a4' }));
  const approvalRows = rail.approvals.map((approval) =>
    core.Text({
      content: `! ${clip(approval.action, width - 6)} [${approval.riskLevel[0].toUpperCase()}]`,
      fg: riskColor(approval.riskLevel),
    }),
  );
  return core.Box(
    {
      id: 'synax-right-rail',
      width,
      flexDirection: 'column',
      border: ['left'],
      borderColor: '#333333',
      paddingX: 1,
    },
    core.Text({ id: 'synax-rail-model', content: `* ${clip(rail.model ?? 'model n/a', width - 2)}`, fg: '#bd93f9' }),
    core.Text({ id: 'synax-rail-branch', content: `git ${clip(rail.branch ?? 'no branch', width - 4)}`, fg: '#6272a4' }),
    core.Text({ content: '' }),
    core.Text({ id: 'synax-rail-files', content: `Files (${rail.filesTouched.length})`, fg: '#ffffff' }),
    ...(fileRows.length > 0 ? fileRows : [core.Text({ content: 'none', fg: '#6272a4' })]),
    core.Text({ content: '' }),
    core.Text({ id: 'synax-rail-approvals', content: `Approvals (${rail.approvals.length})`, fg: '#ffffff' }),
    ...(approvalRows.length > 0 ? approvalRows : [core.Text({ content: 'none', fg: '#6272a4' })]),
    core.Text({ content: '' }),
    core.Text({ content: 'Session', fg: '#ffffff' }),
    core.Text({ id: 'synax-rail-cost', content: `Cost: ${rail.costLabel ?? 'local'}`, fg: '#6272a4' }),
    core.Text({ id: 'synax-rail-context', content: `Context: ${rail.contextLabel ?? 'n/a'}`, fg: '#6272a4' }),
    core.Text({ id: 'synax-rail-uptime', content: `Uptime: ${rail.uptimeLabel}`, fg: '#6272a4' }),
    ...(rail.provider ? [core.Text({ content: clip(rail.provider, width - 2), fg: '#6272a4' })] : []),
  );
}

function renderEmptyState(core: OpenTuiCore): OpenTuiNode {
  return core.Box(
    { width: '100%', flexDirection: 'column', border: true, borderStyle: 'single', borderColor: '#333333', padding: 1 },
    core.Text({ content: 'Synax', fg: '#bd93f9' }),
    core.Text({ content: 'Ready for a local-first coding task.', fg: '#cccccc' }),
  );
}

function railWidthFor(width: number): number {
  return width < 100 ? 0 : 24;
}

function labelFor(eventClass: SemanticEventClass): string {
  if (eventClass === 'assistant_text') return 'Note';
  if (eventClass === 'tool_result') return 'Result';
  return eventClass.replace(/_/g, ' ').replace(/^\w/, (char) => char.toUpperCase());
}

function diffLineColor(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return '#00ff87';
  if (line.startsWith('-') && !line.startsWith('---')) return '#ff5555';
  if (line.startsWith('@@')) return '#8be9fd';
  return '#cccccc';
}

function riskColor(risk: RiskLevel): string {
  if (risk === 'high') return '#ff5555';
  if (risk === 'medium') return '#ffb86c';
  return '#00ff87';
}

function footerColor(status: string): string {
  if (status.startsWith('!')) return '#ffb86c';
  if (status.startsWith('x')) return '#ff5555';
  if (status.startsWith('✓')) return '#00ff87';
  if (status.startsWith('$')) return '#8be9fd';
  return '#cccccc';
}

function clipSingleLine(text: string): string {
  return clip(
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' / '),
    160,
  );
}

function compactPath(path: string, width: number): string {
  if (path.length <= width) return path;
  const parts = path.split('/');
  return clip(parts[parts.length - 1] ?? path, width);
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}
