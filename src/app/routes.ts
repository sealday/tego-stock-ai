export interface NavigationItem {
  readonly id: 'market-analysis' | 'saved-reports' | 'ai-settings' | 'local-privacy';
  readonly label: string;
  readonly href: string;
}

export interface WorkspaceTabDefinition {
  readonly id: 'overview' | 'technical' | 'fundamentals' | 'financial-trends' | 'ai-report';
  readonly label: string;
}

export const PRIMARY_NAVIGATION: readonly NavigationItem[] = [
  { id: 'market-analysis', label: '市场分析', href: '#market-analysis' },
  { id: 'saved-reports', label: '已保存 AI 报告', href: '#saved-reports' },
  { id: 'ai-settings', label: 'AI 设置', href: '#ai-settings' },
  { id: 'local-privacy', label: '本地隐私', href: '#local-privacy' },
] as const;

export const WORKSPACE_TABS: readonly WorkspaceTabDefinition[] = [
  { id: 'overview', label: '概览' },
  { id: 'technical', label: '技术分析' },
  { id: 'fundamentals', label: '基本面' },
  { id: 'financial-trends', label: '财务趋势' },
  { id: 'ai-report', label: 'AI 报告' },
] as const;

export type WorkspaceTabId = (typeof WORKSPACE_TABS)[number]['id'];
